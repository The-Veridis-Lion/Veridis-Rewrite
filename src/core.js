import { extensionName, getAppContext, runtimeState } from './state.js';
import { logger } from './log.js';
import { buildDiffResultFromPair, buildDiffSnippetsFromText, computeMessageSignature, ensureMessageDiffButton, getLatestTrackableDiffIndices, hasRealDiffCache, injectDiffButtons, isAssistantMessage, markDiffComparisonPending, syncTrackedIndicesToLatestAssistantMessages, writeReadyDiffCache, clearTrackedDiffEntry } from './diff.js';
import { beginAtomicMessageDisplaySwap, getMessageDomNode, purifyDOM } from './dom.js';
import { clearAllMessageDiffMeta, clearMessageDiffMeta, commitCurrentMessageText, getMessageDiffBranchKey, getMessageDiffMeta, isMessageAiFinal, isMessageFinalizedForCurrentBranch, isMessageManualFinal, restoreMessageAiFinal, writeMessageDiffMeta } from './messageMeta.js';
import { getSillyTavernContextSnapshot, isBaiBaiToolkitInstalled, isLoreFrameInstalled, isTauriTavernHost, markHostChatDirtyFromIndex } from './platform.js';
import { buildProcessors, mergeProtectedScopeUpdatesIntoSource } from './replacementEngine.js';
import { queueIncrementalChatSave } from './chatPersistence.js';

const chatChangedSyncMessageLimit = 80;
const chatChangedBackgroundChunkSize = 25;
const chatChangedBackgroundDelayMs = 35;
const mvuStatusPlaceholder = '<StatusPlaceHolderImpl/>';



let messageRefreshMissingWarned = false;
let messageRefreshReloadInFlight = false;
const postRefreshDomSettleTimers = new Map();
const hostRenderedEventSuppressMs = 500;

function warnMissingMessageRefresh(index) {
    if (messageRefreshMissingWarned) return;
    messageRefreshMissingWarned = true;
    logger.warn(`宿主 updateMessageBlock 不可用，无法即时刷新消息显示 index=${index}`);
}

function reloadChatAsDisplayFallback(context, index) {
    if (messageRefreshReloadInFlight || typeof context.reloadCurrentChat !== 'function') return false;
    messageRefreshReloadInFlight = true;
    Promise.resolve(context.reloadCurrentChat())
        .catch((e) => logger.warn(`reloadCurrentChat 兜底刷新失败 index=${index}`, e))
        .finally(() => {
            messageRefreshReloadInFlight = false;
        });
    return true;
}

function looksLikeTemplateRenderedContent(index, message) {
    const text = String(message?.extra?.display_text ?? message?.mes ?? '');
    const templateLikePattern = /```(?:html|xml|svg)?[\s\S]*?<\/(?:html|body|script|div)>|<\/(?:html|body|script)>|<html[\s>]|<body[\s>]|<script[\s>]|<novel_header[\s>]|<\/novel_header>|<content[\s>]|<\/content>|novel-tags-container/i;
    if (templateLikePattern.test(text)) return true;

    const messageNode = getMessageDomNode(index);
    const codeText = messageNode?.querySelector?.('.mes_text pre code')?.textContent || '';
    return templateLikePattern.test(codeText);
}

function scheduleRenderedEvent(index, message, context) {
    const appContext = getAppContext();
    const eventSource = context.eventSource || appContext.eventSource;
    const eventTypes = context.eventTypes || context.event_types || appContext.event_types;
    if (!eventSource || typeof eventSource.emit !== 'function' || !eventTypes) return Promise.resolve();

    const eventType = message?.is_user === true
        ? eventTypes.USER_MESSAGE_RENDERED
        : eventTypes.CHARACTER_MESSAGE_RENDERED;
    if (!eventType) return Promise.resolve();

    return new Promise((resolve) => {
        const emitEvent = () => {
            Promise.resolve()
                .then(() => eventSource.emit(eventType, index))
                .catch((e) => logger.warn(`补发消息渲染事件失败 index=${index}`, e))
                .finally(resolve);
        };

        if (typeof globalThis.requestAnimationFrame === 'function') {
            globalThis.requestAnimationFrame(emitEvent);
        } else if (typeof globalThis.setTimeout === 'function') {
            globalThis.setTimeout(emitEvent, 0);
        } else {
            emitEvent();
        }
    });
}

function suppressOwnRenderedEventCleanse(index) {
    if (!Number.isInteger(index) || index < 0) return;
    const until = Date.now() + hostRenderedEventSuppressMs;
    runtimeState.hostRenderedEventSuppressUntil.set(index, until);
    setTimeout(() => {
        if (runtimeState.hostRenderedEventSuppressUntil.get(index) === until) {
            runtimeState.hostRenderedEventSuppressUntil.delete(index);
        }
    }, hostRenderedEventSuppressMs + 50);
}

function scheduleMessageUpdatedEvent(index, context) {
    const appContext = getAppContext();
    const eventSource = context.eventSource || appContext.eventSource;
    const eventTypes = context.eventTypes || context.event_types || appContext.event_types;
    const eventType = eventTypes?.MESSAGE_UPDATED;
    if (!eventSource || typeof eventSource.emit !== 'function' || !eventType) return Promise.resolve();

    return new Promise((resolve) => {
        const emitEvent = () => {
            Promise.resolve()
                .then(() => eventSource.emit(eventType, index))
                .catch((e) => logger.warn(`补发消息更新事件失败 index=${index}`, e))
                .finally(resolve);
        };

        if (typeof globalThis.requestAnimationFrame === 'function') {
            globalThis.requestAnimationFrame(emitEvent);
        } else if (typeof globalThis.setTimeout === 'function') {
            globalThis.setTimeout(emitEvent, 0);
        } else {
            emitEvent();
        }
    });
}

function releaseAtomicMessageDisplayAfterRender(index, atomicSwap, pendingEvents = []) {
    if (!atomicSwap) return;
    Promise.allSettled(pendingEvents).then(() => {
        const release = () => {
            const messageNode = getMessageDomNode(index);
            if (messageNode) ensureMessageDiffButton(index, messageNode);
            atomicSwap.release();
        };
        if (typeof globalThis.requestAnimationFrame === 'function') globalThis.requestAnimationFrame(release);
        else if (typeof globalThis.setTimeout === 'function') globalThis.setTimeout(release, 0);
        else release();
    });
}

function schedulePostRefreshDomSettle(index) {
    if (!getMessageDomNode(index)) return;
    const existingTimers = postRefreshDomSettleTimers.get(index);
    if (Array.isArray(existingTimers)) existingTimers.forEach((timer) => clearTimeout(timer));

    const delays = isBaiBaiToolkitInstalled() ? [120, 450, 1000] : [120, 450];
    const timers = delays.map((delay) => {
        return setTimeout(() => {
            const messageNode = getMessageDomNode(index);
            if (!messageNode) return;
            try {
                purifyDOM(messageNode);
                ensureMessageDiffButton(index, messageNode);
            } catch (error) {
                logger.warn(`宿主刷新后 DOM 收敛失败 index=${index}`, error);
            }
        }, delay);
    });
    postRefreshDomSettleTimers.set(index, timers);
    setTimeout(() => {
        if (postRefreshDomSettleTimers.get(index) === timers) postRefreshDomSettleTimers.delete(index);
    }, Math.max(...delays) + 50);
}

/**
 * 使用 SillyTavern 宿主渲染器刷新消息块，避免直接写 raw text 破坏排版。
 * @param {number} index 消息索引。
 * @param {{delay?: number, allowReloadFallback?: boolean, emitRenderedEvent?: boolean|'auto', atomic?: boolean, atomicSwap?: {release: () => void}|null}} [options={}] 刷新选项。
 * @returns {boolean} 已触发刷新则返回 true。
 */
export function refreshMessageDisplay(index, options = {}) {
    const delay = Number(options.delay) || 0;
    if (delay > 0 && typeof globalThis.setTimeout === 'function') {
        globalThis.setTimeout(() => refreshMessageDisplay(index, { ...options, delay: 0 }), delay);
        return true;
    }

    if (!Number.isInteger(index) || index < 0) return false;

    const appContext = getAppContext();
    const stContext = getSillyTavernContextSnapshot();
    const stMessage = Array.isArray(stContext.chat) ? stContext.chat[index] : null;
    const appMessage = Array.isArray(appContext.chat) ? appContext.chat[index] : null;
    const message = stMessage || appMessage;
    if (!message || typeof message !== 'object') return false;

    const hostUpdateMessageBlock = stContext.updateMessageBlock || appContext.updateMessageBlock;
    if (typeof hostUpdateMessageBlock === 'function') {
        const atomicSwap = options.atomicSwap || (options.atomic === true ? beginAtomicMessageDisplaySwap(index) : null);
        try {
            hostUpdateMessageBlock(index, message);
            const shouldEmitRenderedEvent = options.emitRenderedEvent === true
                || (options.emitRenderedEvent === 'auto' && looksLikeTemplateRenderedContent(index, message));
            const needsHostSettle = isTauriTavernHost() || isBaiBaiToolkitInstalled();
            const shouldNotifyHostPlugins = needsHostSettle || isLoreFrameInstalled();
            const pendingEvents = [];
            if (shouldNotifyHostPlugins) suppressOwnRenderedEventCleanse(index);
            if (shouldEmitRenderedEvent || needsHostSettle) pendingEvents.push(scheduleRenderedEvent(index, message, stContext));
            if (shouldNotifyHostPlugins) {
                pendingEvents.push(scheduleMessageUpdatedEvent(index, stContext));
            }
            if (needsHostSettle && options.atomic !== true) {
                schedulePostRefreshDomSettle(index);
            }
            releaseAtomicMessageDisplayAfterRender(index, atomicSwap, pendingEvents);
            return true;
        } catch (e) {
            atomicSwap?.release();
            logger.warn(`updateMessageBlock 调用失败 index=${index}`, e);
            if (options.allowReloadFallback === true) {
                return reloadChatAsDisplayFallback(stContext, index);
            }
            return false;
        }
    }

    options.atomicSwap?.release?.();
    warnMissingMessageRefresh(index);
    if (options.allowReloadFallback === true) {
        return reloadChatAsDisplayFallback(stContext, index);
    }
    return false;
}

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
    if (diffMeta?.lastCleanedMes && currentMes === diffMeta.lastCleanedMes) {
        return diffMeta.originalMes;
    }
    if (diffMeta?.originalMes && diffMeta?.lastCleanedMes) {
        const sourceWithScopeUpdates = mergeProtectedScopeUpdatesIntoSource(diffMeta.originalMes, diffMeta.lastCleanedMes, currentMes);
        if (sourceWithScopeUpdates) return sourceWithScopeUpdates;
    }

    return currentMes;
}

function computeDiffSourceSignature(msg, sourceMes) {
    return computeMessageSignature({
        ...msg,
        mes: sourceMes,
        __blai_original_mes: '',
        __blai_diff_source_signature: '',
        __blai_diff_last_cleaned_mes: '',
        __blai_diff_branch_meta: null,
        __blai_diff_swipe_key: '',
    });
}

export function syncMessageDiffMetadata(msg, sourceMes, cleanedMes) {
    const sourceSignature = computeDiffSourceSignature(msg, sourceMes);
    const normalizedCleanedMes = typeof cleanedMes === 'string' ? cleanedMes : '';
    const branchKey = getMessageDiffBranchKey(msg);
    const hasDiff = sourceMes !== normalizedCleanedMes;
    const metadataChanged = hasDiff
        ? writeMessageDiffMeta(msg, branchKey, sourceMes, normalizedCleanedMes, sourceSignature)
        : clearMessageDiffMeta(msg, branchKey);
    const signature = computeMessageSignature(msg);
    return { signature, sourceSignature, metadataChanged, hasDiff };
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
    const nextText = typeof text === 'string' ? text : String(text ?? '');
    if (!nextText) return nextText;
    if (!isAssistantMessage(msg)) return nextText;

    const sourceTexts = [nextText, msg?.mes, ...sources].map(value => String(value || ''));
    const hadPlaceholder = sourceTexts.some(hasMvuStatusPlaceholder);
    const hasMvuPayload = sourceTexts.some(hasMvuUpdatePayload);
    if (!hadPlaceholder && !(hasMvuPayload && hasCurrentSwipeMvuState(msg))) return nextText;

    const normalizedText = stripMvuStatusPlaceholders(nextText);
    return normalizedText ? `${normalizedText}\n\n${mvuStatusPlaceholder}` : mvuStatusPlaceholder;
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

    const restoredAiFinal = options.explicitRecleanse === true
        ? false
        : restoreMessageAiFinal(msg);
    if (restoredAiFinal) {
        markHostChatDirtyFromIndex(index);
        return true;
    }
    if (isMessageAiFinal(msg)) return false;
    if (isMessageManualFinal(msg) && options.allowManualFinal !== true) return false;

    const currentMes = typeof msg.mes === 'string' ? msg.mes : '';
    const hasExplicitSource = typeof options.diffSourceMes === 'string';
    const sourceMes = resolveMessageDiffSource(msg, options.diffSourceMes);

    let changed = false;

    const diffResult = options.explicitRecleanse === true && typeof options.recleanseText === 'string'
        ? buildDiffResultFromPair(sourceMes, options.recleanseText)
        : buildDiffSnippetsFromText(sourceMes);
    const postSourceAddition = getPostSourceAddition(sourceMes, diffResult.cleanedText, currentMes, hasExplicitSource);
    const cleanedText = preserveMvuStatusPlaceholder(`${diffResult.cleanedText}${postSourceAddition}`, msg, [currentMes, sourceMes]);
    const metadataSourceMes = preserveMvuStatusPlaceholder(`${sourceMes}${postSourceAddition}`, msg, [currentMes, cleanedText]);
    const mainCache = {
        snippets: Array.from(new Set(diffResult.snippets || [])),
        fullDiff: diffResult.fullDiff || '',
    };
    const hasMainDiff = mainCache.snippets.length > 0 || mainCache.fullDiff.includes('blai-diff-full-modified');

    if (typeof msg.mes === 'string' && cleanedText !== currentMes) {
        const textCommit = commitCurrentMessageText(msg, cleanedText, getMessageDiffBranchKey(msg));
        if (!textCommit.ok) return false;
        changed = textCommit.changed;
    }

    if (options.cleanAllSwipes === true && Array.isArray(msg.swipes)) {
        for (let i = 0; i < msg.swipes.length; i++) {
            if (typeof msg.swipes[i] === 'string') {
                const { cleanedText } = buildDiffSnippetsFromText(msg.swipes[i]);
                if (cleanedText !== msg.swipes[i]) {
                    msg.swipes[i] = cleanedText;
                    changed = true;
                }
            } else if (msg.swipes[i] && typeof msg.swipes[i] === 'object' && typeof msg.swipes[i].mes === 'string') {
                const { cleanedText } = buildDiffSnippetsFromText(msg.swipes[i].mes);
                if (cleanedText !== msg.swipes[i].mes) {
                    msg.swipes[i].mes = cleanedText;
                    changed = true;
                }
            }
        }
    }

    if (trackDiff) {
        const { signature, metadataChanged } = syncMessageDiffMetadata(msg, metadataSourceMes, typeof msg.mes === 'string' ? msg.mes : '');
        if (metadataChanged) changed = true;
        writeReadyDiffCache(index, signature, {
            snippets: mainCache.snippets,
            fullDiff: mainCache.fullDiff,
            signature,
        }, {
            preserveExistingRealDiff: options.preserveExistingRealDiff === true,
            persist: hasMainDiff || changed,
        });
        runtimeState.diffRawSourceCache.delete(index);
    } else {
        if (clearAllMessageDiffMeta(msg)) changed = true;
        clearTrackedDiffEntry(index, { persist: false });
        runtimeState.nonStreamingRawMessageCache.delete(index);
    }

    if (changed) markHostChatDirtyFromIndex(index);
    return changed;
}

export function restoreAiFinalMessagesFromChat() {
    const { chat } = getAppContext();
    if (!Array.isArray(chat)) return false;

    let changed = false;
    chat.forEach((msg, index) => {
        if (!isAssistantMessage(msg)) return;
        if (!restoreMessageAiFinal(msg)) return;
        changed = true;
        markHostChatDirtyFromIndex(index);
    });

    if (changed) queueIncrementalChatSave();
    return changed;
}

/**
 * 非流式生成结束后的专用收敛流程。
 * @param {number|object} payload 事件载荷或消息索引。
 * @returns {void}
 */
export function performNonStreamingFinalCleanse(payload) {
    const { chat } = getAppContext();

    buildProcessors();
    if (runtimeState.activeProcessors.length === 0) return;

    const index = resolveLatestTrackableMessageIndex(payload);
    if (index < 0 || !Array.isArray(chat)) return;

    const msg = chat[index];
    if (!isAssistantMessage(msg)) return;
    if (msg?.__blai_is_reverted) {
        clearTrackedDiffEntry(index);
        injectDiffButtons([index]);
        return;
    }

    const previousState = runtimeState.diffMessageStates.get(index);
    const currentSignature = computeMessageSignature(msg);
    const alreadyFinalizedSameSource = previousState?.status === 'ready'
        && previousState.signature === currentSignature
        && isMessageFinalizedForCurrentBranch(msg);

    if (alreadyFinalizedSameSource && hasRealDiffCache(index)) {
        const messageNode = getMessageDomNode(index);
        if (messageNode) {
            purifyDOM(messageNode);
            ensureMessageDiffButton(index, messageNode);
        }
        return;
    }

    const dataChanged = cleanseMessageDataAtIndex(index, {
        preserveExistingRealDiff: true,
    });
    runtimeState.nonStreamingRawMessageCache.delete(index);

    const messageNode = getMessageDomNode(index);
    if (messageNode) {
        purifyDOM(messageNode);
        ensureMessageDiffButton(index, messageNode);
    }

    if (dataChanged) {
        refreshMessageDisplay(index, { emitRenderedEvent: 'auto' });
        queueIncrementalChatSave();
    }
}

/**
 * 执行增量净化：处理单条消息并刷新对应 DOM。
 * @param {number|object} payload 事件载荷或消息索引。
 * @param {{visualOnly?: boolean, skipPurifyDom?: boolean, diffSourceMes?: string}} [options={}] 控制选项。
 * @returns {{index:number, messageRef:object, beforeText:string, afterText:string, dataChanged:boolean, messageTextChanged:boolean}|undefined}
 */
export function performIncrementalCleanse(payload, options = {}) {
    logger.debug(`[performIncrementalCleanse] payload=${JSON.stringify(payload)}, options=${JSON.stringify(options)}`);
    const { chat } = getAppContext();
    if (!options.skipPurifyDom) buildProcessors();
    if (!options.skipPurifyDom && runtimeState.activeProcessors.length === 0) return;

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
        };
    }
    const beforeText = typeof msg.mes === 'string' ? msg.mes : '';
    if (assistant) {
        const signature = computeMessageSignature(msg);
        if (options.visualOnly) markDiffComparisonPending(index, signature);
        else {
            const previousState = runtimeState.diffMessageStates.get(index);
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
                };
            }

            if (!previousState || previousState.signature !== signature) {
                markDiffComparisonPending(index, signature);
            }
        }
    }

    const dataChanged = options.visualOnly ? false : cleanseMessageDataAtIndex(index, {
        diffSourceMes: options.diffSourceMes,
    });
    const afterCleanseText = typeof msg.mes === 'string' ? msg.mes : '';
    const messageNode = getMessageDomNode(index);
    if (messageNode) {
        if (!options.skipPurifyDom) purifyDOM(messageNode);
        ensureMessageDiffButton(index, messageNode);
    }

    if (dataChanged) {
        refreshMessageDisplay(index, { emitRenderedEvent: 'auto' });
        queueIncrementalChatSave();
    }
    return {
        index,
        messageRef: msg,
        beforeText,
        afterText: afterCleanseText,
        dataChanged,
        messageTextChanged: beforeText !== afterCleanseText,
    };
}

function cancelGlobalCleanseJob() {
    if (!runtimeState.globalCleanseJob) return;
    if (runtimeState.globalCleanseJob.timer) clearTimeout(runtimeState.globalCleanseJob.timer);
    runtimeState.globalCleanseJob.cancelled = true;
    runtimeState.globalCleanseJob = null;
}

function getChatChangedSyncIndices(chat, latestDiffIndices) {
    const indices = new Set(latestDiffIndices);
    const start = Math.max(0, chat.length - chatChangedSyncMessageLimit);
    for (let index = start; index < chat.length; index++) indices.add(index);
    return [...indices].filter(index => index >= 0 && index < chat.length).sort((a, b) => a - b);
}

function processGlobalCleanseMessage(msg, index, latestDiffIndices, skipUser, options = {}) {
    const { refreshDom = true } = options;
    let msgChanged = false;
    let mainCache = { snippets: [], fullDiff: '' };
    const assistant = isAssistantMessage(msg);
    const trackDiff = assistant && latestDiffIndices.has(index);
    if (skipUser && !assistant) return false;
    if (assistant) {
        const restoredAiFinal = restoreMessageAiFinal(msg);
        if (restoredAiFinal) {
            if (refreshDom) refreshMessageDisplay(index, { delay: 50, emitRenderedEvent: 'auto' });
            markHostChatDirtyFromIndex(index);
            return true;
        }
        if (isMessageAiFinal(msg) || isMessageManualFinal(msg)) return false;
    }
    let signature = assistant ? computeMessageSignature(msg) : '';
    const isReverted = msg?.__blai_is_reverted === true;

    if (!isReverted && typeof msg?.mes === 'string') {
        const sourceMes = assistant ? resolveMessageDiffSource(msg) : msg.mes;
        const { cleanedText: rawCleanedText, snippets: mesSnippets, fullDiff } = buildDiffSnippetsFromText(sourceMes);
        const cleanedText = assistant
            ? preserveMvuStatusPlaceholder(rawCleanedText, msg, [msg.mes, sourceMes])
            : rawCleanedText;
        const metadataSourceMes = assistant
            ? preserveMvuStatusPlaceholder(sourceMes, msg, [msg.mes, cleanedText])
            : sourceMes;
        mainCache = {
            snippets: Array.from(new Set(mesSnippets)),
            fullDiff,
        };
        if (msg.mes !== cleanedText) {
            const textCommit = assistant
                ? commitCurrentMessageText(msg, cleanedText, getMessageDiffBranchKey(msg))
                : { ok: true, changed: msg.mes !== cleanedText };
            if (!textCommit.ok) return false;
            if (!assistant) msg.mes = cleanedText;
            msgChanged = textCommit.changed;
        }
        if (trackDiff) {
            const syncResult = syncMessageDiffMetadata(msg, metadataSourceMes, msg.mes);
            signature = syncResult.signature;
            if (syncResult.metadataChanged) msgChanged = true;
        }
    }

    if (trackDiff && !isReverted) {
        const hasMainDiff = mainCache.snippets.length > 0 || mainCache.fullDiff.includes('blai-diff-full-modified');
        writeReadyDiffCache(index, signature, mainCache, {
            preserveExistingRealDiff: true,
            persist: hasMainDiff || msgChanged,
        });
    } else {
        if (assistant && !trackDiff && clearAllMessageDiffMeta(msg)) msgChanged = true;
        clearTrackedDiffEntry(index, { persist: false });
        if (assistant && !trackDiff) runtimeState.nonStreamingRawMessageCache.delete(index);
    }

    if (msgChanged && refreshDom) {
        refreshMessageDisplay(index, { delay: 50, emitRenderedEvent: 'auto' });
    }

    if (msgChanged) markHostChatDirtyFromIndex(index);
    return msgChanged;
}

function processGlobalCleanseMessageSafely(msg, index, latestDiffIndices, skipUser, options = {}) {
    try {
        return processGlobalCleanseMessage(msg, index, latestDiffIndices, skipUser, options);
    } catch (error) {
        logger.warn(`[performGlobalCleanse] 跳过异常消息 ${index}: ${error?.message || error}`);
        return false;
    }
}

function scheduleGlobalCleanseRemainder(chat, processedIndices, latestDiffIndices, skipUser) {
    const remainingIndices = [];
    for (let index = 0; index < chat.length; index++) {
        if (!processedIndices.has(index)) remainingIndices.push(index);
    }
    if (remainingIndices.length === 0) return;

    const job = {
        cancelled: false,
        chat,
        cursor: 0,
        changed: false,
        timer: null,
    };
    runtimeState.globalCleanseJob = job;

    const runChunk = () => {
        if (job.cancelled || runtimeState.globalCleanseJob !== job || getAppContext().chat !== job.chat) return;
        buildProcessors();
        if (runtimeState.activeProcessors.length === 0) {
            runtimeState.globalCleanseJob = null;
            return;
        }

        const end = Math.min(job.cursor + chatChangedBackgroundChunkSize, remainingIndices.length);
        for (; job.cursor < end; job.cursor++) {
            const index = remainingIndices[job.cursor];
            const msg = job.chat[index];
            if (!msg || typeof msg !== 'object') continue;
            if (processGlobalCleanseMessageSafely(msg, index, latestDiffIndices, skipUser, { refreshDom: false })) {
                job.changed = true;
            }
        }

        if (job.cursor < remainingIndices.length) {
            job.timer = setTimeout(runChunk, chatChangedBackgroundDelayMs);
            return;
        }

        runtimeState.globalCleanseJob = null;
        syncTrackedIndicesToLatestAssistantMessages();
        if (job.changed) queueIncrementalChatSave();
        logger.info(`[performGlobalCleanse] 长聊天后台净化完成: ${remainingIndices.length} 条`);
    };

    job.timer = setTimeout(runChunk, chatChangedBackgroundDelayMs);
    logger.info(`[performGlobalCleanse] 长聊天后台分片启动: ${remainingIndices.length} 条`);
}

function purifyMessageDomByIndices(indices) {
    indices.forEach((index) => {
        const messageNode = getMessageDomNode(index);
        if (!messageNode) return;
        try {
            purifyDOM(messageNode);
        } catch (error) {
            logger.warn(`[performGlobalCleanse] 跳过异常 DOM 消息 ${index}: ${error?.message || error}`);
        }
    });
}

/**
 * 执行全局净化：遍历聊天数据、同步 UI 并刷新差异按钮。
 * @param {{deferLargeChat?: boolean}} [options={}] 控制长聊天是否分片处理。
 * @returns {void}
 */
export function performGlobalCleanse(options = {}) {
    logger.info(`[performGlobalCleanse] 全局净化开始`);
    const { chat } = getAppContext();
    const restoredAiFinal = restoreAiFinalMessagesFromChat();
    cancelGlobalCleanseJob();
    buildProcessors();
    if (runtimeState.activeProcessors.length === 0) {
        injectDiffButtons();
        return;
    }

    let chatChanged = restoredAiFinal;
    const latestDiffIndices = new Set(getLatestTrackableDiffIndices());
    let syncIndices = [];
    let useDeferredLongChat = false;

    if (chat && Array.isArray(chat)) {
        const { extension_settings } = getAppContext();
        const skipUser = extension_settings[extensionName]?.skipUserMessages === true;
        useDeferredLongChat = options.deferLargeChat === true && chat.length > chatChangedSyncMessageLimit;
        syncIndices = useDeferredLongChat
            ? getChatChangedSyncIndices(chat, latestDiffIndices)
            : chat.map((_, index) => index);

        syncIndices.forEach((index) => {
            const msg = chat[index];
            if (!msg || typeof msg !== 'object') return;
            if (processGlobalCleanseMessageSafely(msg, index, latestDiffIndices, skipUser, { refreshDom: true })) chatChanged = true;
        });

        if (useDeferredLongChat) {
            scheduleGlobalCleanseRemainder(chat, new Set(syncIndices), latestDiffIndices, skipUser);
        }
    }

    syncTrackedIndicesToLatestAssistantMessages();

    if (chatChanged) {
        queueIncrementalChatSave(); // 使用排队保存
    }
    if (useDeferredLongChat) {
        purifyMessageDomByIndices(syncIndices);
    } else {
        purifyDOM(document.getElementById('chat'));
    }
    injectDiffButtons();
}
