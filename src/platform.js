import { getAppContext } from './state.js';
import { logger } from './log.js';

const tauriReadyTimeoutMs = 4000;
const tauriReadyPollIntervalMs = 50;
const baiBaiSaveDelayMs = 900;
const defaultSaveDelayMs = 600;
const maxBaiBaiSaveDefers = 8;
const loreFrameDetectCacheMs = 1500;
const minMvuToolCallingTavernHelperVersion = [4, 8, 4];
const mvuExtraModelLorebookEntryPattern = /\[mvu_(?:update|plot)\]/i;
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

function getMvuGlobalApi() {
    const root = getGlobalObject();
    if (root?.Mvu && typeof root.Mvu === 'object') return root.Mvu;
    try {
        const parentApi = root?.parent?.Mvu;
        if (parentApi && typeof parentApi === 'object') return parentApi;
    } catch {
        // Cross-window access can fail outside the SillyTavern host.
    }
    return null;
}

export function getTavernHelperGlobalApi() {
    const root = getGlobalObject();
    if (root?.TavernHelper && typeof root.TavernHelper === 'object') return root.TavernHelper;
    try {
        const parentApi = root?.parent?.TavernHelper;
        if (parentApi && typeof parentApi === 'object') return parentApi;
    } catch {
        // Cross-window access can fail outside the SillyTavern host.
    }
    return null;
}

function isVersionAtLeast(version, minimum) {
    const match = String(version || '').match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return true;
    const current = match.slice(1, 4).map(Number);
    for (let index = 0; index < minimum.length; index++) {
        if (current[index] > minimum[index]) return true;
        if (current[index] < minimum[index]) return false;
    }
    return true;
}

function isMvuToolCallingSupported(settings, tavernHelper) {
    if (settings?.['额外模型解析配置']?.['应答格式'] !== '工具调用') return true;

    try {
        const version = tavernHelper?.getTavernHelperVersion?.();
        if (!isVersionAtLeast(version, minMvuToolCallingTavernHelperVersion)) return false;
    } catch {
        return false;
    }

    const context = getSillyTavernContextSnapshot();
    const supportCheck = context?.isToolCallingSupported
        || context?.ToolManager?.isToolCallingSupported;
    if (typeof supportCheck !== 'function') return false;
    try {
        return Boolean(supportCheck.call(context?.ToolManager || context));
    } catch {
        return false;
    }
}

export function getMvuExtraModelTransaction() {
    const settings = getAppContext()?.extension_settings?.mvu_settings;
    const api = getMvuGlobalApi();
    const enabled = Boolean(
        settings?.['更新方式'] === '额外模型解析'
        && settings?.['额外模型解析配置']?.['启用自动请求'] !== false,
    );
    return {
        enabled,
        api,
        beforeMessageUpdateEvent: String(api?.events?.BEFORE_MESSAGE_UPDATE || 'mag_before_message_update'),
    };
}

export async function shouldWaitForMvuExtraModelTransaction(messageIndex) {
    const transaction = getMvuExtraModelTransaction();
    if (!transaction.enabled) return false;

    const { chat } = getAppContext();
    if (!Array.isArray(chat) || chat.length <= 1) return false;
    const index = Number(messageIndex);
    if (!Number.isInteger(index) || index < 0 || index >= chat.length) return false;

    const settings = getAppContext()?.extension_settings?.mvu_settings;
    const tavernHelper = getTavernHelperGlobalApi();
    if (!isMvuToolCallingSupported(settings, tavernHelper)) return false;
    if (typeof tavernHelper?.getCurrentCharPrimaryLorebook !== 'function'
        || typeof tavernHelper?.getLorebookEntries !== 'function') {
        return false;
    }

    try {
        const lorebookName = await tavernHelper.getCurrentCharPrimaryLorebook();
        if (!lorebookName) return false;
        const entries = await tavernHelper.getLorebookEntries(lorebookName);
        return Array.isArray(entries) && entries.some(entry => (
            mvuExtraModelLorebookEntryPattern.test(String(entry?.comment || ''))
        ));
    } catch (error) {
        logger.warn('读取 MVU 额外模型解析适配状态失败', error);
        return false;
    }
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

const fallbackChatIdentityByReference = new WeakMap();
let fallbackChatIdentitySequence = 0;

export function getCurrentChatIdentity() {
    const appContext = getAppContext();
    const hostContext = getSillyTavernContextSnapshot();
    let currentChatId;
    try {
        currentChatId = typeof hostContext?.getCurrentChatId === 'function'
            ? hostContext.getCurrentChatId()
            : undefined;
    } catch (error) {
        logger.warn('读取 SillyTavern 当前聊天 ID 失败，改用稳定对象身份。', error);
    }
    const hostCandidates = [
        currentChatId,
        hostContext?.chatId,
        hostContext?.chat_id,
        appContext?.chat_metadata?.chatId,
        appContext?.chat_metadata?.chat_id,
    ];
    for (const candidate of hostCandidates) {
        if (candidate !== null && candidate !== undefined && String(candidate).trim()) {
            return `host:${String(candidate).trim()}`;
        }
    }

    const chat = appContext?.chat;
    if (!chat || typeof chat !== 'object') return '';
    if (!fallbackChatIdentityByReference.has(chat)) {
        fallbackChatIdentityByReference.set(chat, `chat-ref:${++fallbackChatIdentitySequence}`);
    }
    return fallbackChatIdentityByReference.get(chat);
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
