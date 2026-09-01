/** Owns TauriTavern host detection/readiness and its windowed-chat dirty-mark integration. */
import { getAppContext } from '../host/appContext.js';
import { logger } from '../log.js';
import { getGlobalObject, getSillyTavernContextSnapshot } from '../host/context.js';

const tauriReadyTimeoutMs = 4000;
const tauriReadyPollIntervalMs = 50;
let hostDirtyFunctionMissingWarned = false;

function timeout(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTauriTavernHost() {
    const root = getGlobalObject();
    return Boolean(root.__TAURITAVERN__ || root.__TAURITAVERN_MAIN_READY__ || root.__TAURI_RUNNING__ === true);
}

export function getVeridisRuntimeLabel() {
    return isTauriTavernHost() ? 'TauriTavern' : 'SillyTavern Web';
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
