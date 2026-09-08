/** Owns queued host chat persistence, not message transformation. */
import { getAppContext } from '../host/appContext.js';
import { logger } from '../log.js';
import { getSillyTavernContextSnapshot } from '../host/context.js';
import { isTauriTavernHost } from '../integrations/tauriTavern.js';

/**
 * 排队执行增量聊天保存。
 * @returns {void}
 */
let chatSaveTimer = null;
let chatSaveInFlight = false;
let pendingChatSave = false;
let chatSaveFailureNotified = false;

function getPreferredSaveChatFunction() {
    const context = getSillyTavernContextSnapshot();
    if (typeof context.saveChat === 'function') return () => context.saveChat();

    const { saveChat } = getAppContext();
    if (typeof saveChat === 'function' && !isTauriTavernHost()) return saveChat;
    return null;
}

async function runPreferredSaveChat() {
    const saveChat = getPreferredSaveChatFunction();
    if (typeof saveChat !== 'function') return false;

    const result = saveChat();
    if (result && typeof result.then === 'function') await result;
    return true;
}

function notifyChatSaveFailure(error) {
    if (chatSaveFailureNotified) return;
    chatSaveFailureNotified = true;
    logger.error(`增量存盘失败`, error);
    try {
        setTimeout(() => {
            alert('屏蔽词净化助手：聊天保存失败。请先不要继续大量编辑，建议检查 SillyTavern 控制台与聊天文件权限后再重试。');
        }, 0);
    } catch (notifyError) {
        logger.warn('聊天保存失败提示弹出失败', notifyError);
    }
}

function scheduleQueuedChatSave(delay = 600) {
    chatSaveTimer = setTimeout(runQueuedChatSave, Math.max(0, Number(delay) || 0));
}

async function runQueuedChatSave() {
    chatSaveTimer = null;
    if (!pendingChatSave) return;

    if (chatSaveInFlight) {
        scheduleQueuedChatSave();
        return;
    }

    pendingChatSave = false;
    chatSaveInFlight = true;
    try {
        await runPreferredSaveChat();
        chatSaveFailureNotified = false;
    } catch (e) {
        notifyChatSaveFailure(e);
    } finally {
        chatSaveInFlight = false;
        if (pendingChatSave) scheduleQueuedChatSave();
    }
}

export function queueIncrementalChatSave() {
    pendingChatSave = true;
    if (chatSaveTimer) return;
    scheduleQueuedChatSave();
}
