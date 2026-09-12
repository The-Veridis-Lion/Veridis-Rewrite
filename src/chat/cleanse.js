/**
 * Owns finalized Program cleansing of current chat messages, including message/Swipe
 * mutation and Diff metadata coordination; host DOM rendering is delegated to display.js.
 */
import { extensionName } from '../settings/defaults.js';
import { getAppContext, getCurrentChatMetadata } from '../host/appContext.js';
import { logger } from '../log.js';
import { isAssistantMessage } from '../diff/tracking.js';
import { refreshDiffViewer } from '../diff/state.js';
import { ensureMessageDiffButton, injectDiffButtons } from '../diff/view.js';
import { getMessageDomNode } from '../dom/message.js';
import { commitCurrentMessageText, getMessageDiffBranchKey } from './messageBranch.js';
import { getMessageDiffMeta, migrateChatDiffMetadata, writeMessageDiffProgram } from '../diff/messageMeta.js';
import { markHostChatDirtyFromIndex } from '../integrations/tauriTavern.js';
import { applyScopedReplacements, buildProcessors } from '../rules/engine.js';
import { queueIncrementalChatSave } from './persistence.js';
import { markLatestMessageShujukuRewritePending } from '../shujuku/realtime.js';
import { recordAiRewriteDebug } from '../aiRewrite/debug.js';
import { refreshMessageDisplay } from './display.js';

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

export function syncMessageDiffMetadata(msg, sourceMes, cleanedMes) {
    const normalizedCleanedMes = typeof cleanedMes === 'string' ? cleanedMes : '';
    const branchKey = getMessageDiffBranchKey(msg);
    const metadataChanged = writeMessageDiffProgram(msg, branchKey, sourceMes, normalizedCleanedMes);
    return { metadataChanged };
}

/**
 * 清理指定索引消息，记录阶段并刷新已打开的差异视图。
 * @param {number} index 消息索引。
 * @returns {boolean} 是否发生数据变更。
 */
export function cleanseMessageDataAtIndex(index, options = {}) {
    const { chat } = getAppContext();
    if (!Array.isArray(chat) || index < 0 || index >= chat.length) return false;
    const msg = chat[index];
    if (!msg || typeof msg.mes !== 'string') return false;
    if (!isAssistantMessage(msg)) return false;
    if (options.explicitRecleanse !== true && getMessageDiffMeta(msg)) {
        refreshDiffViewer(index);
        return false;
    }

    const currentMes = typeof msg.mes === 'string' ? msg.mes : '';
    const sourceMes = typeof options.diffSourceMes === 'string' ? options.diffSourceMes : currentMes;

    let changed = false;
    let changedTargets = 0;
    let changedSwipeCount = 0;
    let activeTextChanged = false;

    const streamingFrame = options.explicitRecleanse !== true
        && options.streamingFrame?.originalText === sourceMes
        ? options.streamingFrame
        : null;
    // The final streamed Program is already a completed stage, including an unchanged result.
    const cleanedText = streamingFrame
        ? streamingFrame.programText
        : applyScopedReplacements(sourceMes);

    if (typeof msg.mes === 'string') {
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

    const { metadataChanged } = syncMessageDiffMetadata(msg, sourceMes, msg.mes);
    if (metadataChanged) changed = true;
    refreshDiffViewer(index);

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
 * @param {{visualOnly?: boolean, skipPurifyDom?: boolean, diffSourceMes?: string, streamingFrame?: {originalText:string, programText:string}}} [options={}] 控制选项。
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
    const beforeText = typeof msg.mes === 'string' ? msg.mes : '';
    const beforeDisplayText = msg?.extra?.display_text ?? msg?.mes;
    if (getMessageDiffMeta(msg)) {
        refreshDiffViewer(index);
        injectDiffButtons([index]);
        return {
            index, messageRef: msg, beforeText, afterText: beforeText,
            dataChanged: false, messageTextChanged: false, displayedContentChanged: false,
        };
    }

    const dataChanged = options.visualOnly ? false : cleanseMessageDataAtIndex(index, {
        diffSourceMes: options.diffSourceMes,
        streamingFrame: options.streamingFrame,
    });
    const afterCleanseText = typeof msg.mes === 'string' ? msg.mes : '';
    const displayedContentChanged = beforeDisplayText !== (msg?.extra?.display_text ?? msg?.mes);
    const messageNode = getMessageDomNode(index);
    if (messageNode) {
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
 * 迁移当前聊天的旧差异元数据，并投影最近消息的差异控件。
 * 此路径不执行 Program Rules，也不重新处理历史消息。
 * @returns {void}
 */
export function performGlobalChatMaintenance() {
    logger.info(`[performGlobalChatMaintenance] 当前聊天维护开始`);
    const { chat } = getAppContext();
    if (migrateChatDiffMetadata(chat, getCurrentChatMetadata())) {
        markHostChatDirtyFromIndex(0);
        queueIncrementalChatSave();
    }
    injectDiffButtons();
}
