import { getAppContext } from './state.js';
import { logger } from './log.js';

const tauriReadyTimeoutMs = 4000;
const tauriReadyPollIntervalMs = 50;
const baiBaiSaveDelayMs = 900;
const defaultSaveDelayMs = 600;
const maxBaiBaiSaveDefers = 8;
const loreFrameDetectCacheMs = 1500;
const loreFrameScriptIds = ['online-content-floating-window', 'serial-forum-floating-window'];
export const loreFrameDomSelector = loreFrameScriptIds
    .flatMap((scriptId) => [
        `#${scriptId}-iframe`,
        `#${scriptId}-launcher`,
        `[script_id="${scriptId}"]`,
        `[data-script-id="${scriptId}"]`,
        `[data-${scriptId}-source-button]`,
    ])
    .join(', ');
let loreFrameDetected = false;
let loreFrameLastDomCheckAt = 0;
let hostDirtyFunctionMissingWarned = false;

function getGlobalObject() {
    return typeof globalThis !== 'undefined' ? globalThis : window;
}

function timeout(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTauriTavernHost() {
    const root = getGlobalObject();
    return Boolean(root.__TAURITAVERN__ || root.__TAURITAVERN_MAIN_READY__ || root.__TAURI_RUNNING__ === true);
}

export async function waitForTauriTavernReady() {
    if (!isTauriTavernHost()) return false;

    const root = getGlobalObject();
    const startedAt = Date.now();

    while (Date.now() - startedAt < tauriReadyTimeoutMs) {
        const ready = root.__TAURITAVERN__?.ready ?? root.__TAURITAVERN_MAIN_READY__;

        if (ready && typeof ready.then === 'function') {
            const timeoutMarker = {};
            const remainingMs = Math.max(0, tauriReadyTimeoutMs - (Date.now() - startedAt));
            try {
                const result = await Promise.race([ready.then(() => true), timeout(remainingMs).then(() => timeoutMarker)]);
                if (result === timeoutMarker) {
                    logger.warn('等待 TauriTavern 宿主 ready 超时，继续按标准 SillyTavern 初始化');
                    return false;
                }
                return true;
            } catch (error) {
                logger.warn('等待 TauriTavern 宿主 ready 失败，继续按标准 SillyTavern 初始化', error);
                return false;
            }
        }

        if (root.__TAURITAVERN__) return true;
        if (root.__TAURITAVERN_MAIN_READY__ && typeof root.__TAURITAVERN_MAIN_READY__.then !== 'function') return true;
        await timeout(tauriReadyPollIntervalMs);
    }

    logger.warn('等待 TauriTavern 宿主 ABI 超时，继续按标准 SillyTavern 初始化');
    return false;
}

export function getSillyTavernContextSnapshot() {
    const { getSillyTavernContext } = getAppContext();
    if (typeof getSillyTavernContext === 'function') {
        try {
            const context = getSillyTavernContext();
            if (context && typeof context === 'object') return context;
        } catch (error) {
            logger.warn('获取 SillyTavern 上下文失败', error);
        }
    }

    try {
        const context = getGlobalObject().SillyTavern?.getContext?.();
        if (context && typeof context === 'object') return context;
    } catch (error) {
        logger.warn('从 globalThis.SillyTavern 获取上下文失败', error);
    }

    return {};
}

export function isBaiBaiToolkitInstalled() {
    const root = getGlobalObject();
    return Boolean(
        root.__baiBaiToolkitExtensionInstalled
        || root.__baiBaiToolkitSaveGenerateFetchPatched
        || root.__baiBaiToolkitSaveRequestGzipFetchPatched,
    );
}

export function isLoreFrameInstalled() {
    const root = getGlobalObject();
    if (loreFrameDetected) return true;
    if (loreFrameScriptIds.some((scriptId) => root[scriptId])) {
        loreFrameDetected = true;
        return true;
    }

    if (typeof document === 'undefined') return false;
    const now = Date.now();
    if (now - loreFrameLastDomCheckAt < loreFrameDetectCacheMs) return false;
    loreFrameLastDomCheckAt = now;

    try {
        loreFrameDetected = Boolean(document.querySelector(loreFrameDomSelector));
        return loreFrameDetected;
    } catch (error) {
        logger.warn('LoreFrame 兼容检测失败', error);
        return false;
    }
}

export function getRecommendedChatSaveDelay() {
    return shouldDelayChatSaveForHost() ? baiBaiSaveDelayMs : defaultSaveDelayMs;
}

export function getMaxHostChatSaveDefers() {
    return maxBaiBaiSaveDefers;
}

export function getPreferredSaveChatFunction() {
    const context = getSillyTavernContextSnapshot();
    if (typeof context.saveChat === 'function') return () => context.saveChat();

    const { saveChat } = getAppContext();
    if (typeof saveChat === 'function' && !isTauriTavernHost()) return saveChat;
    return null;
}

export async function runPreferredSaveChat() {
    const saveChat = getPreferredSaveChatFunction();
    if (typeof saveChat !== 'function') return false;

    const result = saveChat();
    if (result && typeof result.then === 'function') await result;
    return true;
}

function getBaiBaiSaveGenerateState() {
    const root = getGlobalObject();
    const state = root.__baiBaiToolkitSaveGenerateFetchPatched;
    return state && typeof state === 'object' ? state : null;
}

export function shouldDelayChatSaveForHost() {
    const state = getBaiBaiSaveGenerateState();
    if (!state) return false;

    const hasPendingJob = Array.isArray(state.pendingJobs)
        && state.pendingJobs.some((job) => job && job.consumed !== true);
    const hasActiveGenerate = state.activeGenerateChatIds instanceof Set && state.activeGenerateChatIds.size > 0;
    const hasLocalGuard = state.localRequestGuards instanceof Map && state.localRequestGuards.size > 0;
    const hasResumeCheck = state.resumeCheckPromises instanceof Map && state.resumeCheckPromises.size > 0;
    return Boolean(
        hasPendingJob
        || hasActiveGenerate
        || hasLocalGuard
        || hasResumeCheck
        || state.activeSaveGenerateCancelTarget
        || state.resumeCheckTimer,
    );
}

export function markHostChatDirtyFromIndex(index) {
    if (!isTauriTavernHost()) return false;
    if (!Number.isInteger(index) || index < 0) return false;

    const context = getSillyTavernContextSnapshot();
    const appContext = getAppContext();
    const candidates = [
        { owner: context, fn: context.markWindowedChatDirtyFromIndex },
        { owner: context, fn: context.markChatDirtyFromIndex },
        { owner: context, fn: context.setWindowedChatDirtyFromIndex },
        { owner: appContext, fn: appContext.markWindowedChatDirtyFromIndex },
    ].filter((entry) => typeof entry.fn === 'function');

    if (candidates.length === 0) {
        if (!hostDirtyFunctionMissingWarned) {
            hostDirtyFunctionMissingWarned = true;
            logger.warn('TauriTavern 窗口化 dirty 标记接口不可用，将仅依赖宿主 saveChat');
        }
        return false;
    }

    for (const { owner, fn } of candidates) {
        try {
            fn.call(owner, index);
            return true;
        } catch (error) {
            logger.warn(`宿主 dirty 标记失败 index=${index}`, error);
        }
    }

    return false;
}
