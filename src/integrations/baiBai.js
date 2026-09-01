/** Owns detection of BaiBai Toolkit and observation of its save/generation state required by existing chat-save deferral behavior. */
import { getGlobalObject } from '../host/context.js';

const baiBaiSaveDelayMs = 900;
const defaultSaveDelayMs = 600;
const maxBaiBaiSaveDefers = 8;

export function isBaiBaiToolkitInstalled() {
    const root = getGlobalObject();
    return Boolean(
        root.__baiBaiToolkitExtensionInstalled
        || root.__baiBaiToolkitSaveGenerateFetchPatched
        || root.__baiBaiToolkitSaveRequestGzipFetchPatched,
    );
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

export function getRecommendedChatSaveDelay() {
    return shouldDelayChatSaveForHost() ? baiBaiSaveDelayMs : defaultSaveDelayMs;
}

export function getMaxHostChatSaveDefers() {
    return maxBaiBaiSaveDefers;
}
