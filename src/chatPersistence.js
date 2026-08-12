import { runtimeState } from './state.js';
import { logger } from './log.js';
import { getMaxHostChatSaveDefers, getRecommendedChatSaveDelay, runPreferredSaveChat, shouldDelayChatSaveForHost } from './platform.js';

/**
 * 排队执行增量聊天保存。
 * @returns {void}
 */
let chatSaveFailureNotified = false;

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

function scheduleQueuedChatSave(delay = getRecommendedChatSaveDelay()) {
    runtimeState.chatSaveTimer = setTimeout(runQueuedChatSave, Math.max(0, Number(delay) || 0));
}

async function runQueuedChatSave() {
    runtimeState.chatSaveTimer = null;
    if (!runtimeState.pendingChatSave) return;

    if (shouldDelayChatSaveForHost() && runtimeState.chatSaveDelayCount < getMaxHostChatSaveDefers()) {
        runtimeState.chatSaveDelayCount += 1;
        scheduleQueuedChatSave(getRecommendedChatSaveDelay());
        return;
    }

    runtimeState.chatSaveDelayCount = 0;
    if (runtimeState.chatSaveInFlight) {
        scheduleQueuedChatSave(getRecommendedChatSaveDelay());
        return;
    }

    runtimeState.pendingChatSave = false;
    runtimeState.chatSaveInFlight = true;
    try {
        await runPreferredSaveChat();
        chatSaveFailureNotified = false;
    } catch (e) {
        notifyChatSaveFailure(e);
    } finally {
        runtimeState.chatSaveInFlight = false;
        if (runtimeState.pendingChatSave) scheduleQueuedChatSave(getRecommendedChatSaveDelay());
    }
}

export function queueIncrementalChatSave() {
    runtimeState.pendingChatSave = true;
    if (runtimeState.chatSaveTimer) return;
    scheduleQueuedChatSave(getRecommendedChatSaveDelay());
}
