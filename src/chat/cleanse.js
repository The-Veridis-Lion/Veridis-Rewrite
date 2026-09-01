/**
 * Owns finalized Program cleansing of current chat messages, including message/Swipe
 * mutation and Diff metadata coordination; host DOM rendering is delegated to display.js.
 */
import { extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { logger } from '../log.js';
import { getLatestTrackableDiffIndices, isAssistantMessage } from '../diff/tracking.js';
import { computeMessageSignature, diffRuntimeState, hasRealDiffCache, markDiffComparisonPending, syncTrackedIndicesToLatestAssistantMessages, writeReadyDiffCache, clearTrackedDiffEntry } from '../diff/state.js';
import { rulesRuntimeState } from '../rules/state.js';
import { ensureMessageDiffButton, injectDiffButtons } from '../diff/view.js';
import { buildDiffResultFromPair, buildDiffSnippetsFromText } from '../diff/compare.js';
import { getMessageDomNode } from '../dom/message.js';
import { purifyDOM } from '../dom/purify.js';
import { commitCurrentMessageText, getMessageDiffBranchKey } from './messageBranch.js';
import { clearAllMessageDiffMeta, getMessageDiffMeta, isMessageAiFinal, isMessageFinalizedForCurrentBranch, isMessageManualFinal, writeMessageDiffProgram } from '../diff/messageMeta.js';
import { markHostChatDirtyFromIndex } from '../integrations/tauriTavern.js';
import { applyTextReplacementWithTrackedRanges, buildProcessors, mergeProtectedScopeUpdatesIntoSource, replayProgramProjection } from '../rules/engine.js';
import { queueIncrementalChatSave } from './persistence.js';
import { markLatestMessageShujukuRewritePending } from '../shujuku/realtime.js';
import { recordAiRewriteDebug } from '../aiRewrite/debug.js';
import { refreshMessageDisplay } from './display.js';

const mvuStatusPlaceholder = '<StatusPlaceHolderImpl/>';

/**
 * 从事件负载中解析消息索引。
 * @param {number|object} payload 事件载荷或直接索引。
 * @returns {number} 解析出的索引，失败返回 -1。
 */
export function getMessageIndexFromEvent(payload) {
    const direct = typeof payload === 'number'
        ? payload
        : (typeof payload === 'string' && payload.trim() !== '' ? Number(payload) : NaN);
    if (Number.isInteger(direct)) return direct;
    if (!payload || typeof payload !== 'object') return -1;
    const candidates = [payload.messageId, payload.message_id, payload.mesid, payload.index, payload.id];
    for (const value of candidates) {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 0) return n;
    }
    return -1;
}

/**
 * 获取当前聊天中的最后一条消息索引。
 * @returns {number} 最新消息索引，不存在则为 -1。
 */
export function getLatestMessageIndex() {
    const { chat } = getAppContext();
    return Array.isArray(chat) && chat.length > 0 ? chat.length - 1 : -1;
}

/**
 * 解析“可追踪非 user 消息”的最新索引。
 * @param {number|object} payload 事件载荷或消息索引。
 * @returns {number} 可追踪消息索引，失败返回 -1。
 */
export function resolveLatestTrackableMessageIndex(payload) {
    const { chat } = getAppContext();
    if (!Array.isArray(chat)) return -1;

    const explicit = getMessageIndexFromEvent(payload);

    if (explicit >= 0 && explicit < chat.length) {
        if (isAssistantMessage(chat[explicit])) return explicit;

        for (let i = explicit + 1; i < chat.length; i++) {
            if (isAssistantMessage(chat[i])) return i;
        }
    }

    for (let i = chat.length - 1; i >= 0; i--) {
        if (isAssistantMessage(chat[i])) return i;
    }

    return -1;
}

export function resolveMessageDiffSource(msg, explicitSource) {
    const currentMes = typeof msg?.mes === 'string' ? msg.mes : '';
    if (isMessageAiFinal(msg)) return currentMes;
    if (typeof explicitSource === 'string') return explicitSource;

    const diffMeta = getMessageDiffMeta(msg);
    if (diffMeta?.programMes && currentMes === diffMeta.programMes) {
        return diffMeta.originalMes;
    }
    if (diffMeta?.originalMes && diffMeta?.programMes) {
        const sourceWithScopeUpdates = mergeProtectedScopeUpdatesIntoSource(diffMeta.originalMes, diffMeta.programMes, currentMes);
        if (sourceWithScopeUpdates) return sourceWithScopeUpdates;
    }

    return currentMes;
}

export function syncMessageDiffMetadata(msg, sourceMes, cleanedMes, programProjection) {
    const normalizedCleanedMes = typeof cleanedMes === 'string' ? cleanedMes : '';
    const branchKey = getMessageDiffBranchKey(msg);
    const hasDiff = sourceMes !== normalizedCleanedMes;
    const metadataChanged = writeMessageDiffProgram(msg, branchKey, sourceMes, normalizedCleanedMes, programProjection);
    const signature = computeMessageSignature(msg);
    return { signature, metadataChanged, hasDiff };
}

function hasMvuStatusPlaceholder(text) {
    return String(text || '').includes(mvuStatusPlaceholder);
}

function hasMvuUpdatePayload(text) {
    return String(text || '').includes('<UpdateVariable>');
}

function stripMvuStatusPlaceholders(text) {
    return String(text ?? '')
        .split(mvuStatusPlaceholder)
        .join('')
        .replace(/\n{3,}/g, '\n\n')
        .trimEnd();
}

function getCurrentSwipeVariables(msg) {
    const swipeId = Number.isInteger(Number(msg?.swipe_id)) ? Number(msg.swipe_id) : 0;
    return msg?.variables?.[swipeId];
}

function hasCurrentSwipeMvuState(msg) {
    const variables = getCurrentSwipeVariables(msg);
    return !!(variables && typeof variables === 'object' && (variables.stat_data || variables.schema || variables.display_data));
}

export function preserveMvuStatusPlaceholder(text, msg, sources = []) {
    return preserveMvuStatusPlaceholderWithTrackedRanges(text, msg, sources).text;
}

export function preserveMvuStatusPlaceholderWithTrackedRanges(text, msg, sources = [], ranges = []) {
    const nextText = typeof text === 'string' ? text : String(text ?? '');
    const initial = replayProgramProjection(nextText, [], ranges);
    const unchanged = () => ({
        text: nextText,
        ranges: initial.ranges,
        projection: [],
        valid: initial.valid,
    });
    if (!initial.valid) return unchanged();
    if (!nextText || !isAssistantMessage(msg)) return unchanged();

    const sourceTexts = [nextText, msg?.mes, ...sources].map(value => String(value || ''));
    const hadPlaceholder = sourceTexts.some(hasMvuStatusPlaceholder);
    const hasMvuPayload = sourceTexts.some(hasMvuUpdatePayload);
    if (!hadPlaceholder && !(hasMvuPayload && hasCurrentSwipeMvuState(msg))) return unchanged();

    const normalizedText = stripMvuStatusPlaceholders(nextText);
    const preservedText = normalizedText ? `${normalizedText}\n\n${mvuStatusPlaceholder}` : mvuStatusPlaceholder;
    if (preservedText === nextText) return unchanged();

    let state = unchanged();
    const applyReplacement = (start, end, replacement) => {
        if (!state.valid) return;
        const result = applyTextReplacementWithTrackedRanges(
            state.text,
            start,
            end,
            replacement,
            state.ranges,
        );
        state = {
            text: result.text,
            ranges: result.ranges,
            projection: [...state.projection, ...result.projection],
            valid: result.valid,
        };
    };

    let placeholderIndex = state.text.indexOf(mvuStatusPlaceholder);
    while (placeholderIndex >= 0) {
        applyReplacement(placeholderIndex, placeholderIndex + mvuStatusPlaceholder.length, '');
        placeholderIndex = state.text.indexOf(mvuStatusPlaceholder);
    }

    let excessNewlines = /\n{3,}/u.exec(state.text);
    while (excessNewlines) {
        applyReplacement(excessNewlines.index, excessNewlines.index + excessNewlines[0].length, '\n\n');
        excessNewlines = /\n{3,}/u.exec(state.text);
    }

    const trimmedText = state.text.trimEnd();
    if (trimmedText.length !== state.text.length) {
        applyReplacement(trimmedText.length, state.text.length, '');
    }
    applyReplacement(state.text.length, state.text.length, state.text ? `\n\n${mvuStatusPlaceholder}` : mvuStatusPlaceholder);

    return {
        ...state,
        valid: state.valid && state.text === preservedText,
    };
}

function getPostSourceAddition(sourceMes, cleanedSourceMes, currentMes, hasExplicitSource) {
    if (hasExplicitSource !== true) return '';

    const sourceText = String(sourceMes ?? '');
    const cleanedText = String(cleanedSourceMes ?? '');
    const currentText = String(currentMes ?? '');
    if (!sourceText || !currentText || currentText === sourceText) return '';

    if (currentText.startsWith(sourceText)) {
        return currentText.slice(sourceText.length);
    }
    if (currentText.startsWith(cleanedText)) {
        return currentText.slice(cleanedText.length);
    }
    return '';
}

/**
 * 清理指定索引消息的数据并更新差异缓存。
 * @param {number} index 消息索引。
 * @returns {boolean} 是否发生数据变更。
 */
export function cleanseMessageDataAtIndex(index, options = {}) {
    const { chat } = getAppContext();
    if (!Array.isArray(chat) || index < 0 || index >= chat.length) return false;
    const msg = chat[index];
    if (!msg || typeof msg !== 'object') return false;
    if (msg.__blai_is_reverted) return false;

    const isAssistant = isAssistantMessage(msg);
    if (!isAssistant) {
        clearTrackedDiffEntry(index);
        return false;
    }
    const trackDiff = getLatestTrackableDiffIndices().includes(index);

    if (isMessageAiFinal(msg)) return false;
    if (isMessageManualFinal(msg) && options.allowManualFinal !== true) return false;

    const currentMes = typeof msg.mes === 'string' ? msg.mes : '';
    const hasExplicitSource = typeof options.diffSourceMes === 'string';
    const sourceMes = resolveMessageDiffSource(msg, options.diffSourceMes);

    let changed = false;
    let changedTargets = 0;
    let changedSwipeCount = 0;
    let activeTextChanged = false;

    const canReusePrecomputedDiff = options.explicitRecleanse !== true
        && options.precomputedDiff?.sourceMes === sourceMes
        && options.precomputedDiff?.result;
    const diffResult = canReusePrecomputedDiff
        ? options.precomputedDiff.result
        : buildDiffSnippetsFromText(sourceMes);
    if (!Array.isArray(diffResult.programProjection)) return false;
    const postSourceAddition = getPostSourceAddition(sourceMes, diffResult.cleanedText, currentMes, hasExplicitSource);
    const metadataSourceMes = `${sourceMes}${postSourceAddition}`;
    const preservedProgram = preserveMvuStatusPlaceholderWithTrackedRanges(
        `${diffResult.cleanedText}${postSourceAddition}`,
        msg,
        [currentMes, sourceMes],
    );
    if (!preservedProgram.valid) return false;
    const cleanedText = preservedProgram.text;
    const programProjection = [...diffResult.programProjection, ...preservedProgram.projection];
    const committedDiff = buildDiffResultFromPair(metadataSourceMes, cleanedText);
    const mainCache = {
        snippets: Array.from(new Set(committedDiff.snippets || [])),
        fullDiff: committedDiff.fullDiff || '',
    };
    const hasMainDiff = mainCache.snippets.length > 0 || mainCache.fullDiff.includes('blai-diff-full-modified');

    if (typeof msg.mes === 'string' && cleanedText !== currentMes) {
        const currentSwipeIndex = Array.isArray(msg.swipes) ? Number(msg.swipe_id) : -1;
        const currentSwipe = Array.isArray(msg.swipes) && Number.isInteger(currentSwipeIndex) && currentSwipeIndex >= 0
            ? msg.swipes[currentSwipeIndex]
            : null;
        const currentSwipeText = typeof currentSwipe === 'string' ? currentSwipe : currentSwipe?.mes;
        const textCommit = commitCurrentMessageText(msg, cleanedText, getMessageDiffBranchKey(msg));
        if (!textCommit.ok) return false;
        changed = textCommit.changed;
        if (textCommit.changed) {
            changedTargets++;
            activeTextChanged = true;
            if (textCommit.swipeIndex >= 0 && currentSwipeText !== cleanedText) {
                changedTargets++;
                changedSwipeCount++;
            }
        }
    }

    if (options.cleanAllSwipes === true && Array.isArray(msg.swipes)) {
        for (let i = 0; i < msg.swipes.length; i++) {
            if (typeof msg.swipes[i] === 'string') {
                const { cleanedText } = buildDiffSnippetsFromText(msg.swipes[i]);
                if (cleanedText !== msg.swipes[i]) {
                    msg.swipes[i] = cleanedText;
                    changed = true;
                    changedTargets++;
                    changedSwipeCount++;
                }
            } else if (msg.swipes[i] && typeof msg.swipes[i] === 'object' && typeof msg.swipes[i].mes === 'string') {
                const { cleanedText } = buildDiffSnippetsFromText(msg.swipes[i].mes);
                if (cleanedText !== msg.swipes[i].mes) {
                    msg.swipes[i].mes = cleanedText;
                    changed = true;
                    changedTargets++;
                    changedSwipeCount++;
                }
            }
        }
    }

    if (trackDiff) {
        const { signature, metadataChanged } = syncMessageDiffMetadata(
            msg,
            metadataSourceMes,
            typeof msg.mes === 'string' ? msg.mes : '',
            programProjection,
        );
        if (metadataChanged) changed = true;
        writeReadyDiffCache(index, signature, {
            snippets: hasMainDiff ? mainCache.snippets : [],
            fullDiff: hasMainDiff ? mainCache.fullDiff : '',
            signature,
        }, {
            persist: hasMainDiff || changed,
        });
    } else {
        if (clearAllMessageDiffMeta(msg)) changed = true;
        clearTrackedDiffEntry(index, { persist: false });
    }

    if (changed) markHostChatDirtyFromIndex(index);
    markLatestMessageShujukuRewritePending(index);
    if (changedTargets > 0) {
        const details = {
            source: options.explicitRecleanse === true ? 'manual-recleanse' : 'message-cleanse',
            messageId: index,
            changedTargets,
            changedSwipeCount,
        };
        if (activeTextChanged) {
            details.beforeLength = currentMes.length;
            details.afterLength = typeof msg.mes === 'string' ? msg.mes.length : 0;
        }
        recordAiRewriteDebug('program-commit', details);
    }
    return changed;
}

/**
 * 执行增量净化：处理单条消息并刷新对应 DOM。
 * @param {number|object} payload 事件载荷或消息索引。
 * @param {{visualOnly?: boolean, skipPurifyDom?: boolean, diffSourceMes?: string, precomputedDiff?: {sourceMes:string, result:object}}} [options={}] 控制选项。
 * @returns {{index:number, messageRef:object, beforeText:string, afterText:string, dataChanged:boolean, messageTextChanged:boolean, displayedContentChanged:boolean}|undefined}
 */
export function performIncrementalCleanse(payload, options = {}) {
    logger.debug(`[performIncrementalCleanse] payload=${JSON.stringify(payload)}, options=${JSON.stringify(options)}`);
    const { chat } = getAppContext();
    if (!options.skipPurifyDom) buildProcessors();
    const index = getMessageIndexFromEvent(payload);
    if (index < 0) return;

    const msg = Array.isArray(chat) ? chat[index] : null;
    const assistant = isAssistantMessage(msg);
    if (!assistant) return;
    if (msg?.__blai_is_reverted) {
        clearTrackedDiffEntry(index);
        injectDiffButtons([index]);
        return;
    }
    if (isMessageManualFinal(msg)) {
        injectDiffButtons([index]);
        return {
            index,
            messageRef: msg,
            beforeText: typeof msg.mes === 'string' ? msg.mes : '',
            afterText: typeof msg.mes === 'string' ? msg.mes : '',
            dataChanged: false,
            messageTextChanged: false,
            displayedContentChanged: false,
        };
    }
    const beforeText = typeof msg.mes === 'string' ? msg.mes : '';
    const beforeDisplayText = msg?.extra?.display_text ?? msg?.mes;
    if (assistant) {
        const signature = computeMessageSignature(msg);
        if (options.visualOnly) markDiffComparisonPending(index, signature);
        else {
            const previousState = diffRuntimeState.diffMessageStates.get(index);
            const alreadyFinalizedSameSource = previousState?.status === 'ready'
                && previousState.signature === signature
                && isMessageFinalizedForCurrentBranch(msg);

            if (alreadyFinalizedSameSource && hasRealDiffCache(index)) {
                const messageNode = getMessageDomNode(index);
                if (messageNode) ensureMessageDiffButton(index, messageNode);
                return {
                    index,
                    messageRef: msg,
                    beforeText,
                    afterText: beforeText,
                    dataChanged: false,
                    messageTextChanged: false,
                    displayedContentChanged: false,
                };
            }

            if (!previousState || previousState.signature !== signature) {
                markDiffComparisonPending(index, signature);
            }
        }
    }

    const dataChanged = options.visualOnly ? false : cleanseMessageDataAtIndex(index, {
        diffSourceMes: options.diffSourceMes,
        precomputedDiff: options.precomputedDiff,
    });
    const afterCleanseText = typeof msg.mes === 'string' ? msg.mes : '';
    const displayedContentChanged = beforeDisplayText !== (msg?.extra?.display_text ?? msg?.mes);
    const messageNode = getMessageDomNode(index);
    if (messageNode) {
        if (!options.skipPurifyDom) purifyDOM(messageNode);
        ensureMessageDiffButton(index, messageNode);
    }

    if (displayedContentChanged) {
        refreshMessageDisplay(index, { emitRenderedEvent: 'auto' });
    }
    if (dataChanged) {
        queueIncrementalChatSave();
    }
    return {
        index,
        messageRef: msg,
        beforeText,
        afterText: afterCleanseText,
        dataChanged,
        messageTextChanged: beforeText !== afterCleanseText,
        displayedContentChanged,
    };
}

/**
 * 维护当前聊天的已持久化最终态、Diff 保留窗口与相关 UI。
 * 此路径不执行 Program Rules，也不重新处理历史消息。
 * @returns {void}
 */
export function performGlobalChatMaintenance() {
    logger.info(`[performGlobalChatMaintenance] 当前聊天维护开始`);
    syncTrackedIndicesToLatestAssistantMessages({ cleanupHistoricalResidue: true });
    injectDiffButtons();
}
