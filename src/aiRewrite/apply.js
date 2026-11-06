import { getAppContext } from '../host/appContext.js';
import { refreshMessageDisplay } from '../chat/display.js';
import { queueIncrementalChatSave } from '../chat/persistence.js';
import { clearMessageDisplayText, commitCurrentMessageText, getMessageDiffBranchKey, syncCurrentSwipeExtra } from '../chat/messageBranch.js';
import { applyScopedCompiledReplacements } from '../rules/engine.js';
import { refreshDiffViewer } from '../diff/state.js';
import { maintainDiffRetention } from '../diff/retention.js';
import { getMessageDiffMeta, writeMessageDiffAiStage, writeMessageDiffProgram } from '../diff/messageMeta.js';
import { beginAtomicMessageDisplaySwap } from '../dom/message.js';
import { markHostChatDirtyFromIndex } from '../integrations/tauriTavern.js';
import { collectXmlCommentRanges } from './commentProtection.js';
import { getOccurrenceProgramFallbackText, resolveRewriteTrackedRanges } from './matching.js';
import { getTaskFreshnessIssue, resolveManualProgramTail } from './task.js';
import { recordAiRewriteDebug } from './debug.js';
import { generationLifecycle } from '../host/generationLifecycle.js';
import { trimCopiedBoundaryDialogue } from './boundaryDialogue.js';
import { trimAddedNarrationCopies } from './narrationCopies.js';

// Owns Original-based AI/fallback composition, the final normal Program pass,
// manual tail preservation, and the atomic message/Swipe + branch-provenance commit.

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
        && left.reverted === right.reverted
        && JSON.stringify(left.aiUnchanged || []) === JSON.stringify(right.aiUnchanged || []);
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
    const finalText = String(prepared.finalText ?? '');
    const aiText = mode === 'ai' ? String(prepared.aiText ?? '') : null;
    const branchKey = String(taskLike.branchKey || getMessageDiffBranchKey(msg));
    if (msg.mes !== currentText) return { committed: false, reason: 'message-text-changed' };
    if (getMessageDiffBranchKey(msg) !== branchKey) return { committed: false, reason: 'message-branch-changed' };

    const previous = getMessageDiffMeta(msg, branchKey);
    if (!messageStagesEqual(previous, prepared.previousMeta || null)) {
        return { committed: false, reason: 'message-stage-changed' };
    }

    const textChanged = finalText !== currentText;
    const atomicSwap = textChanged ? beginAtomicMessageDisplaySwap(index) : null;
    try {
        const textCommit = commitCurrentMessageText(msg, finalText, branchKey);
        if (!textCommit.ok) {
            atomicSwap?.release();
            return { committed: false, reason: textCommit.reason };
        }
        clearMessageDisplayText(msg);
        syncCurrentSwipeExtra(msg);

        const metadataChanged = mode === 'ai'
            ? writeMessageDiffAiStage(msg, branchKey, originalText, aiText, programText, prepared.aiUnchanged)
            : writeMessageDiffProgram(msg, branchKey, originalText, programText);
        maintainDiffRetention();
        refreshDiffViewer(index);

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
            afterLength: finalText.length,
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
    // Edited manual sources are frozen at request creation; history changes only on commit.
    const originalText = task.automatic === true ? currentText : task.originalText;
    const rebaseFromCurrentText = task.automatic !== true && task.rebaseFromCurrentText === true;
    if (rebaseFromCurrentText && (originalText !== currentText || task.claimedMessageText !== currentText)) {
        return { appliedCount: 0, reason: 'manual-source-changed' };
    }
    const tailState = task.automatic !== true && !rebaseFromCurrentText
        ? resolveManualProgramTail(currentText, previous)
        : { tail: '', trimProgramEnd: false };
    if (!tailState) return { appliedCount: 0, reason: 'message-program-stage-changed' };
    const preservedTail = tailState.tail;
    const trimProgramEnd = tailState.trimProgramEnd;
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
    const dialogueGuard = mode === 'ai' ? trimCopiedBoundaryDialogue(originalText, replacements)
        : { replacements, removedCount: 0 };
    if (dialogueGuard.removedCount) recordAiRewriteDebug('boundary-dialogue-trimmed', {
        generationId: task.generationId || '', index: task.index, removedCount: dialogueGuard.removedCount,
    });
    const rejectedCopies = dialogueGuard.replacements.filter(item => item.strategy === 'boundary-dialogue-rejected');
    if (rejectedCopies.length) recordAiRewriteDebug('boundary-dialogue-rejected', {
        generationId: task.generationId || '', index: task.index, count: rejectedCopies.length,
        reason: 'Interior source-quote copy; original target retained to preserve facts.',
    }, 'warn');
    const guarded = mode === 'ai' ? trimAddedNarrationCopies(originalText, dialogueGuard.replacements)
        : dialogueGuard;
    if (guarded.removedCount && mode === 'ai') recordAiRewriteDebug('added-narration-copy-trimmed', {
        generationId: task.generationId || '', index: task.index, removedCount: guarded.removedCount,
    });
    const aiUnchanged = mode === 'ai' ? guarded.replacements
        .filter(item => item.strategy === 'boundary-dialogue-rejected'
            || item.rewritten === originalText.slice(item.start, item.end))
        .map(item => ({ start: item.start, end: item.end,
            reason: item.strategy === 'boundary-dialogue-rejected' ? 'boundary-risk' : 'unchanged' })) : [];
    const unchangedCount = mode === 'ai' ? guarded.replacements.filter(item =>
        item.strategy !== 'boundary-dialogue-rejected'
        && item.rewritten === originalText.slice(item.start, item.end)).length : 0;
    const composition = applyResolvedReplacements(originalText, guarded.replacements);
    // Run only normal Program rules on the composition, never temporary streaming replacements.
    const programText = applyScopedCompiledReplacements(
        composition.text,
        task.programProcessors,
        task.settings,
        {
            protectedRanges: task.aiSettings?.protectXmlComments === true
                ? collectXmlCommentRanges(composition.text)
                : [],
        },
    );
    const desiredStage = {
        originalMes: originalText,
        aiMes: mode === 'ai' ? composition.text : null,
        programMes: programText,
        reverted: false,
        ...(aiUnchanged.length ? { aiUnchanged } : {}),
    };
    // External tail text belongs only to the live message, never to the stage chain.
    const finalText = (trimProgramEnd ? programText.trimEnd() : programText) + preservedTail;
    if (finalText === currentText && messageStagesEqual(previous, desiredStage)) {
        if (task.automatic === true) generationLifecycle.clearStreamingProgram(task.generationId);
        recordAiRewriteDebug('apply-skip', { reason: 'no-text-change', generationId: task.generationId || '' }, 'warn');
        return { appliedCount: 0, rejectedCount: rejectedCopies.length, unchangedCount, reason: 'no-text-change' };
    }
    const commitResult = commitRewriteText(task, {
        currentText,
        originalText,
        aiText: mode === 'ai' ? composition.text : null,
        programText,
        finalText,
        previousMeta: previous,
        aiUnchanged,
    }, mode);
    if (!commitResult.committed) {
        recordAiRewriteDebug('apply-skip', { reason: commitResult.reason, generationId: task.generationId || '' }, 'warn');
        return { appliedCount: 0, reason: commitResult.reason };
    }

    if (task.automatic === true) generationLifecycle.clearStreamingProgram(task.generationId);

    recordAiRewriteDebug('apply-success', {
        generationId: task.generationId || '',
        index: task.index,
        appliedCount: selectedItems.length - rejectedCopies.length,
        rejectedCount: rejectedCopies.length,
        strategies: guarded.replacements.map((replacement) => replacement.strategy),
        beforeLength: currentText.length,
        afterLength: finalText.length,
    });
    return { appliedCount: selectedItems.length - rejectedCopies.length, rejectedCount: rejectedCopies.length, unchangedCount, committed: true, reason: '' };
}

export function applyAcceptedRewrites(task, accepted) {
    return applyRewritePlan(task, accepted, 'ai');
}

export function applyProgramFallbackRewrites(task) {
    return applyRewritePlan(task, new Map(), 'program');
}
