import { getAppContext } from '../host/appContext.js';
import { preserveMvuStatusPlaceholder } from '../integrations/mvu.js';
import { refreshMessageDisplay } from '../chat/display.js';
import { queueIncrementalChatSave } from '../chat/persistence.js';
import { clearMessageDisplayText, commitCurrentMessageText, getMessageDiffBranchKey, syncCurrentSwipeExtra } from '../chat/messageBranch.js';
import { applyScopedCompiledReplacements } from '../rules/engine.js';
import { refreshDiffCacheIfStale } from '../diff/state.js';
import { getMessageDiffMeta, writeMessageDiffAiStage, writeMessageDiffProgram } from '../diff/messageMeta.js';
import { beginAtomicMessageDisplaySwap } from '../dom/message.js';
import { markHostChatDirtyFromIndex } from '../integrations/tauriTavern.js';
import { collectXmlCommentRanges } from './commentProtection.js';
import { getOccurrenceProgramFallbackText, resolveRewriteTrackedRanges } from './matching.js';
import { getTaskFreshnessIssue } from './task.js';
import { recordAiRewriteDebug } from './debug.js';
import { generationLifecycle } from '../host/generationLifecycle.js';

// Owns Original-based AI/fallback composition, the final normal Program pass,
// and the atomic message/Swipe + branch-provenance commit boundary.

function rangesOverlap(left, right) {
    return left.start < right.end && right.start < left.end;
}

function applyResolvedReplacements(text, replacements) {
    let output = String(text ?? '');
    const appliedRanges = [];
    for (const replacement of [...replacements].sort((a, b) => b.start - a.start || b.end - a.end)) {
        if (!Number.isInteger(replacement?.start)
            || !Number.isInteger(replacement?.end)
            || replacement.start < 0
            || replacement.end < replacement.start
            || replacement.end > output.length
            || appliedRanges.some((range) => rangesOverlap(range, replacement))) {
            continue;
        }
        const rewritten = String(replacement.rewritten ?? '');
        output = output.slice(0, replacement.start) + rewritten + output.slice(replacement.end);
        appliedRanges.push({ start: replacement.start, end: replacement.end });
    }
    return { text: output };
}

function messageStagesEqual(left, right) {
    if (!left || !right) return left === right;
    return left.originalMes === right.originalMes
        && left.programMes === right.programMes
        && left.aiMes === right.aiMes
        && left.hasAiTrace === right.hasAiTrace
        && left.finalSource === right.finalSource;
}

function commitRewriteText(taskLike, prepared, mode) {
    const { chat } = getAppContext();
    const index = Number(taskLike?.index);
    const msg = Array.isArray(chat) ? chat[index] : null;
    if (!msg || msg !== taskLike?.messageRef || typeof msg.mes !== 'string') {
        return { committed: false, reason: 'message-ref-changed' };
    }

    const currentText = String(prepared.currentText ?? '');
    const originalText = String(prepared.originalText ?? '');
    const programText = String(prepared.programText ?? '');
    const aiText = mode === 'ai' ? String(prepared.aiText ?? '') : null;
    const branchKey = String(taskLike.branchKey || getMessageDiffBranchKey(msg));
    if (msg.mes !== currentText) return { committed: false, reason: 'message-text-changed' };
    if (getMessageDiffBranchKey(msg) !== branchKey) return { committed: false, reason: 'message-branch-changed' };

    const previous = getMessageDiffMeta(msg, branchKey);
    if (!messageStagesEqual(previous, prepared.previousMeta || null)) {
        return { committed: false, reason: 'message-stage-changed' };
    }

    const textChanged = programText !== currentText;
    const atomicSwap = textChanged ? beginAtomicMessageDisplaySwap(index) : null;
    try {
        const textCommit = commitCurrentMessageText(msg, programText, branchKey);
        if (!textCommit.ok) {
            atomicSwap?.release();
            return { committed: false, reason: textCommit.reason };
        }
        clearMessageDisplayText(msg);
        syncCurrentSwipeExtra(msg);

        const metadataChanged = mode === 'ai'
            ? writeMessageDiffAiStage(msg, branchKey, originalText, aiText, programText)
            : writeMessageDiffProgram(msg, branchKey, originalText, programText);
        refreshDiffCacheIfStale(index, { finalization: 'ai' });

        if (textChanged || metadataChanged) {
            markHostChatDirtyFromIndex(index);
            queueIncrementalChatSave();
        }
        if (textChanged) {
            refreshMessageDisplay(index, { atomic: true, atomicSwap, emitRenderedEvent: 'auto' });
        } else {
            atomicSwap?.release();
        }
        recordAiRewriteDebug('atomic-commit', {
            generationId: taskLike.generationId || '',
            index,
            beforeLength: currentText.length,
            afterLength: programText.length,
            mode,
        });
        return { committed: true, reason: '' };
    } catch (error) {
        atomicSwap?.release();
        throw error;
    }
}

function applyRewritePlan(task, selectedReplacements, mode) {
    recordAiRewriteDebug('apply-start', {
        generationId: task.generationId || '',
        chatId: task.chatId || '',
        messageId: task.index,
        selectedCount: mode === 'ai' ? selectedReplacements.size : task.items?.length || 0,
    });
    const freshnessIssue = getTaskFreshnessIssue(task);
    if (freshnessIssue) {
        recordAiRewriteDebug('apply-skip', { reason: freshnessIssue, generationId: task.generationId || '' }, 'warn');
        return { appliedCount: 0, reason: freshnessIssue };
    }

    const { chat } = getAppContext();
    const msg = chat[task.index];
    const currentText = String(msg?.mes ?? '');
    const previous = getMessageDiffMeta(msg, task.branchKey);
    // Final provenance already owns this automatic branch. Only an explicit
    // manual request may start another rewrite from its retained Original.
    if (task.automatic === true && previous) {
        return { appliedCount: 0, reason: 'no-text-change' };
    }
    if (task.automatic !== true && !messageStagesEqual(previous, task.claimedMeta || null)) {
        return { appliedCount: 0, reason: 'message-stage-changed' };
    }
    // Host/MVU owns the complete automatic Original; manual runs use the retained Original.
    const originalText = task.automatic === true ? currentText : task.originalText;
    const selectedItems = mode === 'ai'
        ? task.items.filter((item) => selectedReplacements.has(item.id))
        : task.items;
    const resolved = resolveRewriteTrackedRanges(originalText, task.items, task.aiSettings);
    if (!resolved.valid) return { appliedCount: 0, reason: 'item-locate-failed' };
    const replacements = resolved.ranges
        .filter((range) => mode === 'ai'
            ? range.rangeType === 'sentence' && selectedReplacements.has(range.itemId)
            : range.rangeType === 'occurrence')
        .map((range) => ({
            start: range.start,
            end: range.end,
            rewritten: mode === 'ai'
                ? String(selectedReplacements.get(range.itemId) ?? '')
                : getOccurrenceProgramFallbackText(
                    task.items.find((item) => item.id === range.itemId).matches[range.occurrenceIndex],
                    task.originalText,
                ),
            strategy: mode === 'ai' ? 'sentence' : 'raw-occurrence-fallback',
        }));
    const composition = applyResolvedReplacements(originalText, replacements);
    // Streaming Program contains no AI-rule fallbacks; run Program on the composed text.
    const transformedText = applyScopedCompiledReplacements(
        composition.text,
        task.programProcessors,
        task.settings,
        {
            protectedRanges: task.aiSettings?.protectXmlComments === true
                ? collectXmlCommentRanges(composition.text)
                : [],
        },
    );
    const programText = preserveMvuStatusPlaceholder(transformedText, msg, [originalText, composition.text]);
    const desiredStage = {
        originalMes: originalText,
        aiMes: mode === 'ai' ? composition.text : '',
        programMes: programText,
        hasAiTrace: mode === 'ai',
        finalSource: 'program',
    };
    if (programText === currentText && messageStagesEqual(previous, desiredStage)) {
        if (task.automatic === true) generationLifecycle.clearStreamingProgram(task.generationId);
        recordAiRewriteDebug('apply-skip', { reason: 'no-text-change', generationId: task.generationId || '' }, 'warn');
        return { appliedCount: 0, reason: 'no-text-change' };
    }
    const commitResult = commitRewriteText(task, {
        currentText,
        originalText,
        aiText: mode === 'ai' ? composition.text : null,
        programText,
        previousMeta: previous,
    }, mode);
    if (!commitResult.committed) {
        recordAiRewriteDebug('apply-skip', { reason: commitResult.reason, generationId: task.generationId || '' }, 'warn');
        return { appliedCount: 0, reason: commitResult.reason };
    }

    if (task.automatic === true) generationLifecycle.clearStreamingProgram(task.generationId);

    recordAiRewriteDebug('apply-success', {
        generationId: task.generationId || '',
        index: task.index,
        appliedCount: selectedItems.length,
        strategies: replacements.map((replacement) => replacement.strategy),
        beforeLength: currentText.length,
        afterLength: programText.length,
    });
    return { appliedCount: selectedItems.length, committed: true, reason: '' };
}

export function applyAcceptedRewrites(task, accepted) {
    return applyRewritePlan(task, accepted, 'ai');
}

export function applyProgramFallbackRewrites(task) {
    return applyRewritePlan(task, new Map(), 'program');
}
