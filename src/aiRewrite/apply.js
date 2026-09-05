import { getAppContext } from '../host/appContext.js';
import { preserveMvuStatusPlaceholder } from '../chat/cleanse.js';
import { refreshMessageDisplay } from '../chat/display.js';
import { queueIncrementalChatSave } from '../chat/persistence.js';
import { clearMessageDisplayText, commitCurrentMessageText, getMessageDiffBranchKey, syncCurrentSwipeExtra } from '../chat/messageBranch.js';
import { applyScopedCompiledReplacementsWithTrackedRanges } from '../rules/engine.js';
import { computeMessageSignature, writeReadyDiffCache } from '../diff/state.js';
import { buildDiffResultFromStages } from '../diff/compare.js';
import { getMessageDiffMeta, writeMessageDiffAiStage, writeMessageDiffProgram } from '../diff/messageMeta.js';
import { beginAtomicMessageDisplaySwap } from '../dom/message.js';
import { markHostChatDirtyFromIndex } from '../integrations/tauriTavern.js';
import { collectXmlCommentRanges } from './commentProtection.js';
import { resolveRewriteTrackedRanges } from './matching.js';
import { getTaskFreshnessIssue } from './task.js';
import { recordAiRewriteDebug } from './debug.js';

// Owns Original-based AI/fallback composition, the final normal Program pass,
// and the atomic message/Swipe + branch-provenance commit boundary.

function rangesOverlap(left, right) {
    return left.start < right.end && right.start < left.end;
}

// These are the dialogue quote pairs named by the existing AI rewrite prompt.
const supportedDialogueQuotePairs = [
    { open: '“', close: '”' },
    { open: '「', close: '」' },
];
const quotePairByOpen = new Map(supportedDialogueQuotePairs.map((pair) => [pair.open, pair]));
const quotePairByClose = new Map(supportedDialogueQuotePairs.map((pair) => [pair.close, pair]));

function getParagraphBounds(text, offset) {
    const source = String(text || '');
    const position = Math.max(0, Math.min(source.length, Number(offset) || 0));
    const start = source.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
    const nextBreak = source.indexOf('\n', position);
    return { start, end: nextBreak === -1 ? source.length : nextBreak };
}

function scanDialogueQuoteState(text, start, end, initialStack = []) {
    const stack = [...initialStack];
    for (let index = start; index < end; index += 1) {
        const character = text[index];
        const openingPair = quotePairByOpen.get(character);
        if (openingPair) {
            stack.push(openingPair);
            continue;
        }
        const closingPair = quotePairByClose.get(character);
        if (!closingPair) continue;
        const expectedPair = stack.at(-1);
        if (expectedPair !== closingPair) return null;
        stack.pop();
    }
    return stack;
}

function quoteStatesEqual(left, right) {
    return left.length === right.length && left.every((pair, index) => pair === right[index]);
}

function getExpectedTargetQuoteState(programText, range) {
    const source = String(programText || '');
    const paragraph = getParagraphBounds(source, range.start);
    const paragraphState = scanDialogueQuoteState(source, paragraph.start, paragraph.end);
    if (!paragraphState || paragraphState.length !== 0) return null;

    const initialState = scanDialogueQuoteState(source, paragraph.start, range.start);
    if (!initialState) return null;
    const expectedState = scanDialogueQuoteState(source, range.start, range.end, initialState);
    if (!expectedState) return null;
    return { initialState, expectedState };
}

function removeSurplusBoundaryQuotes(programText, range, replacement) {
    const source = String(programText || '');
    const start = Number(range?.start);
    const end = Number(range?.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > source.length) {
        return String(replacement ?? '');
    }

    const quoteState = getExpectedTargetQuoteState(source, { start, end });
    const rewritten = String(replacement ?? '');
    if (!quoteState) return rewritten;

    const replacementState = scanDialogueQuoteState(rewritten, 0, rewritten.length, quoteState.initialState);
    if (replacementState && quoteStatesEqual(replacementState, quoteState.expectedState)) return rewritten;

    const candidates = [];
    if (quotePairByOpen.has(rewritten[0]) || quotePairByClose.has(rewritten[0])) {
        candidates.push(rewritten.slice(1));
    }
    const lastCharacter = rewritten.at(-1);
    if (quotePairByOpen.has(lastCharacter) || quotePairByClose.has(lastCharacter)) {
        candidates.push(rewritten.slice(0, -1));
    }

    const restored = [...new Set(candidates)].filter((candidate) => {
        const candidateState = scanDialogueQuoteState(candidate, 0, candidate.length, quoteState.initialState);
        return candidateState && quoteStatesEqual(candidateState, quoteState.expectedState);
    });
    return restored.length === 1 ? restored[0] : rewritten;
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
        const signature = computeMessageSignature(msg);
        const diffResult = buildDiffResultFromStages(
            originalText,
            programText,
            aiText,
            null,
        );
        writeReadyDiffCache(index, signature, {
            snippets: Array.from(new Set(diffResult.snippets || [])),
            fullDiff: diffResult.fullDiff || '',
            signature,
        }, {
            persist: true,
        });

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
        return { committed: true, reason: '', signature };
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
    if (task.automatic !== true && !messageStagesEqual(previous, task.claimedMeta || null)) {
        return { appliedCount: 0, reason: 'message-stage-changed' };
    }
    // Host/MVU owns the complete automatic Original; manual runs use the retained Original.
    const originalText = task.automatic === true ? currentText : task.originalText;
    const resolved = resolveRewriteTrackedRanges(originalText, task.items, task.aiSettings);
    if (!resolved.valid) {
        recordAiRewriteDebug('apply-skip', {
            reason: 'item-locate-failed',
            generationId: task.generationId || '',
            itemId: resolved.failedItemId,
        }, 'warn');
        return { appliedCount: 0, reason: 'item-locate-failed' };
    }

    const selectedItems = mode === 'ai'
        ? task.items.filter((item) => selectedReplacements.has(item.id))
        : task.items;
    const replacements = resolved.ranges
        .filter((range) => mode === 'ai'
            ? range.rangeType === 'sentence' && selectedReplacements.has(range.itemId)
            : range.rangeType === 'occurrence')
        .map((range) => ({
            start: range.start,
            end: range.end,
            rewritten: mode === 'ai'
                ? removeSurplusBoundaryQuotes(
                    originalText,
                    range,
                    selectedReplacements.get(range.itemId),
                )
                : String(task.items.find((item) => item.id === range.itemId)
                    .matches[range.occurrenceIndex].programFallbackText ?? ''),
            strategy: mode === 'ai' ? 'sentence' : 'raw-occurrence-fallback',
        }));
    const composition = applyResolvedReplacements(originalText, replacements);
    const programResult = applyScopedCompiledReplacementsWithTrackedRanges(
        composition.text,
        task.programProcessors,
        task.settings,
        [],
        {
            protectedRanges: task.aiSettings?.protectXmlComments === true
                ? collectXmlCommentRanges(composition.text)
                : [],
        },
    );
    if (!programResult.valid) {
        return { appliedCount: 0, reason: 'program-transform-invalid' };
    }
    const programText = preserveMvuStatusPlaceholder(
        programResult.text,
        msg,
        [originalText, composition.text],
    );
    const desiredStage = {
        originalMes: originalText,
        aiMes: mode === 'ai' ? composition.text : '',
        programMes: programText,
        hasAiTrace: mode === 'ai',
        finalSource: 'program',
    };
    if (programText === currentText && messageStagesEqual(previous, desiredStage)) {
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
