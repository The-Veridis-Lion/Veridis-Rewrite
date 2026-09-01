import { getAppContext } from '../host/appContext.js';
import { preserveMvuStatusPlaceholderWithTrackedRanges } from '../chat/cleanse.js';
import { refreshMessageDisplay } from '../chat/display.js';
import { queueIncrementalChatSave } from '../chat/persistence.js';
import { clearMessageDisplayText, commitCurrentMessageText, getMessageDiffBranchKey, syncCurrentSwipeExtra } from '../chat/messageBranch.js';
import { applyScopedCompiledReplacementsWithTrackedRanges } from '../rules/engine.js';
import { computeMessageSignature, writeReadyDiffCache } from '../diff/state.js';
import { buildDiffResultFromStages } from '../diff/compare.js';
import { getMessageDiffMeta, writeMessageDiffAiStage, writeMessageDiffProgram } from '../diff/messageMeta.js';
import { beginAtomicMessageDisplaySwap } from '../dom/message.js';
import { markHostChatDirtyFromIndex } from '../integrations/tauriTavern.js';
import { applyWithXmlCommentsProtectedTrackedRanges } from './commentProtection.js';
import { materializeProjectedRewriteItems, resolveRewriteTrackedRanges } from './matching.js';
import { getTaskFreshnessIssue } from './task.js';
import { recordAiRewriteDebug } from './debug.js';

// Owns exact Program-stage construction, immutable AI-plan application, and
// the atomic message/Swipe + branch-provenance commit boundary.

export function buildProgramStageForRewrite(text, msg, aiSettings, items, scopeSettings, programProcessors) {
    const sourceText = String(text ?? '');
    const initial = resolveRewriteTrackedRanges(sourceText, items, aiSettings);
    if (!initial.valid) return initial;

    const transformed = applyWithXmlCommentsProtectedTrackedRanges(
        sourceText,
        (segment, ranges) => applyScopedCompiledReplacementsWithTrackedRanges(
            segment,
            programProcessors,
            scopeSettings,
            true,
            ranges,
        ),
        initial.ranges,
        aiSettings?.protectXmlComments === true,
    );
    const preservedProgram = preserveMvuStatusPlaceholderWithTrackedRanges(
        transformed.text,
        msg,
        [sourceText],
        transformed.ranges,
    );
    const programText = preservedProgram.text;
    if (!transformed.valid || !preservedProgram.valid) {
        return { valid: false, failedItemId: '' };
    }
    const projected = materializeProjectedRewriteItems(programText, items, preservedProgram.ranges);
    if (!projected.valid) return projected;
    return {
        valid: true,
        text: programText,
        items: projected.items,
        projection: [...transformed.projection, ...preservedProgram.projection],
        projectionOutputLength: programText.length,
        failedItemId: '',
    };
}

function rangesOverlap(left, right) {
    return left.start < right.end && right.start < left.end;
}

function applyResolvedReplacements(text, replacements, captureProjection = false) {
    let output = String(text ?? '');
    const appliedRanges = [];
    const projection = [];
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
        if (captureProjection) projection.push([replacement.start, replacement.end, rewritten.length]);
        output = output.slice(0, replacement.start) + replacement.rewritten + output.slice(replacement.end);
        appliedRanges.push({ start: replacement.start, end: replacement.end });
    }
    return { text: output, projection, appliedCount: appliedRanges.length };
}

function projectionsEqual(left, right) {
    if (left === undefined || right === undefined) return left === right;
    return Array.isArray(left)
        && Array.isArray(right)
        && left.length === right.length
        && left.every((tuple, index) => tuple.length === right[index]?.length
            && tuple.every((value, tupleIndex) => value === right[index][tupleIndex]));
}

function programStagesEqual(left, right) {
    if (!left || !right) return left === right;
    return left.originalMes === right.originalMes
        && left.programMes === right.programMes
        && projectionsEqual(left.programProjection, right.programProjection)
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
    const programProjection = Array.isArray(prepared.programProjection)
        ? prepared.programProjection
        : undefined;
    const finalText = String(prepared.finalText ?? '');
    const branchKey = String(taskLike.branchKey || getMessageDiffBranchKey(msg));
    if (msg.mes !== currentText) return { committed: false, reason: 'message-text-changed' };
    if (getMessageDiffBranchKey(msg) !== branchKey) return { committed: false, reason: 'message-branch-changed' };

    const previous = getMessageDiffMeta(msg, branchKey);
    if (!programStagesEqual(previous, prepared.previousMeta || null)) {
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

        const programMetaChanged = prepared.replaceProgramStage === true
            ? writeMessageDiffProgram(msg, branchKey, originalText, programText, programProjection)
            : false;
        const aiMetaChanged = mode === 'ai'
            ? writeMessageDiffAiStage(msg, branchKey, finalText)
            : false;
        const signature = computeMessageSignature(msg);
        const diffResult = buildDiffResultFromStages(
            originalText,
            programText,
            mode === 'ai' ? finalText : null,
            null,
        );
        writeReadyDiffCache(index, signature, {
            snippets: Array.from(new Set(diffResult.snippets || [])),
            fullDiff: diffResult.fullDiff || '',
            signature,
        }, {
            persist: true,
        });

        if (textChanged || programMetaChanged || aiMetaChanged) {
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
        return { committed: true, reason: '', signature };
    } catch (error) {
        atomicSwap?.release();
        throw error;
    }
}

function haveMatchingPromptItems(expectedItems, actualItems) {
    if (!Array.isArray(expectedItems) || !Array.isArray(actualItems) || expectedItems.length !== actualItems.length) {
        return false;
    }
    const actualById = new Map(actualItems.map((item) => [item.id, item]));
    return expectedItems.every((item) => actualById.get(item.id)?.text === item.text);
}

function resolveProgramStageForApply(task, msg, currentText, previous) {
    if (task.automatic === true) {
        const originalText = previous?.originalMes || currentText;
        const stage = buildProgramStageForRewrite(
            originalText,
            msg,
            task.aiSettings,
            task.originalItems,
            task.settings,
            task.programProcessors,
        );
        if (!stage.valid
            || stage.projectionOutputLength !== stage.text.length
            || !haveMatchingPromptItems(task.items, stage.items)) {
            return { valid: false, failedItemId: stage.failedItemId || '' };
        }
        return {
            valid: true,
            originalText,
            programText: stage.text,
            programProjection: stage.projection,
            items: stage.items,
            replaceProgramStage: true,
        };
    }

    if (!programStagesEqual(previous, task.claimedProgramMeta || null)) {
        return { valid: false, failedItemId: '', reason: 'message-stage-changed' };
    }
    if (!Array.isArray(task.programProjection)
        || task.programProjectionOutputLength !== task.programText.length) {
        return { valid: false, failedItemId: '' };
    }
    return {
        valid: true,
        originalText: task.originalText,
        programText: task.programText,
        programProjection: task.programProjection,
        items: task.items,
        replaceProgramStage: task.usesPersistedProgramStage !== true,
    };
}

function buildDesiredStage(stage, programText, programProjection, finalText, mode) {
    return {
        originalMes: stage.originalText,
        programMes: programText,
        programProjection,
        aiMes: mode === 'ai' ? finalText : '',
        hasAiTrace: mode === 'ai',
        finalSource: mode,
    };
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
    const stage = resolveProgramStageForApply(task, msg, currentText, previous);
    if (!stage.valid) {
        const reason = stage.reason || 'item-locate-failed';
        recordAiRewriteDebug('apply-skip', {
            reason,
            generationId: task.generationId || '',
            itemId: stage.failedItemId,
        }, 'warn');
        return { appliedCount: 0, reason };
    }

    const selectedItems = mode === 'ai'
        ? stage.items.filter((item) => selectedReplacements.has(item.id))
        : stage.items;
    const replacements = mode === 'ai'
        ? selectedItems.map((item) => ({
            start: item.start,
            end: item.end,
            id: item.id,
            rewritten: String(selectedReplacements.get(item.id) ?? ''),
            strategy: 'sentence',
        }))
        : selectedItems.flatMap((item) => (item.matches || []).map((match) => ({
            start: match.projectedStart,
            end: match.projectedEnd,
            id: item.id,
            rewritten: String(match.programFallbackText ?? ''),
            strategy: 'raw-occurrence-fallback',
        })));
    const composition = applyResolvedReplacements(stage.programText, replacements, mode === 'program');
    const preservedComposition = preserveMvuStatusPlaceholderWithTrackedRanges(
        composition.text,
        msg,
        [currentText, stage.programText, task.originalText],
    );
    if (!preservedComposition.valid) {
        recordAiRewriteDebug('apply-skip', { reason: 'program-projection-incomplete', generationId: task.generationId || '' }, 'warn');
        return { appliedCount: 0, reason: 'program-projection-incomplete' };
    }
    const nextText = preservedComposition.text;
    let programText = stage.programText;
    let programProjection = stage.programProjection;
    let replaceProgramStage = stage.replaceProgramStage;
    if (mode === 'program') {
        programText = nextText;
        programProjection = [
            ...stage.programProjection,
            ...composition.projection,
            ...preservedComposition.projection,
        ];
        replaceProgramStage = true;
    }
    const desiredStage = buildDesiredStage(stage, programText, programProjection, nextText, mode);
    if (nextText === currentText && programStagesEqual(previous, desiredStage)) {
        recordAiRewriteDebug('apply-skip', { reason: 'no-text-change', generationId: task.generationId || '' }, 'warn');
        return { appliedCount: 0, reason: 'no-text-change' };
    }
    const commitResult = commitRewriteText(task, {
        currentText,
        originalText: stage.originalText,
        programText,
        programProjection,
        finalText: nextText,
        previousMeta: previous,
        replaceProgramStage,
    }, mode);
    if (!commitResult.committed) {
        recordAiRewriteDebug('apply-skip', { reason: commitResult.reason, generationId: task.generationId || '' }, 'warn');
        return { appliedCount: 0, reason: commitResult.reason };
    }

    recordAiRewriteDebug('apply-success', {
        generationId: task.generationId || '',
        index: task.index,
        appliedCount: selectedItems.length,
        strategies: replacements.map((replacement) => replacement.strategy),
        beforeLength: currentText.length,
        afterLength: nextText.length,
    });
    if (mode === 'ai' && stage.programText !== currentText) {
        recordAiRewriteDebug('program-commit', {
            source: 'ai-finalization',
            messageId: task.index,
            beforeLength: currentText.length,
            afterLength: stage.programText.length,
        });
    }
    return { appliedCount: selectedItems.length, committed: true, reason: '' };
}

export function applyAcceptedRewrites(task, accepted) {
    return applyRewritePlan(task, accepted, 'ai');
}

export function applyProgramFallbackRewrites(task) {
    return applyRewritePlan(task, new Map(), 'program');
}
