import { getAppContext } from '../host/appContext.js';
import { extensionName, normalizeDiffTrackedMessageLimit } from '../settings/defaults.js';

function getDiffTrackedMessageLimit() {
    const settings = getAppContext().extension_settings?.[extensionName];
    return normalizeDiffTrackedMessageLimit(settings?.diffTrackedMessageLimit);
}

// Derives only which current-chat messages belong to the configured Diff tracking window.
export function isTrackableDiffMessage(msg) {
    return !!(msg && typeof msg === 'object' && msg.is_user !== true);
}

export function isAssistantMessage(msg) {
    return isTrackableDiffMessage(msg);
}

export function getLatestAssistantMessageIndices(chat, limit = getDiffTrackedMessageLimit()) {
    if (!Array.isArray(chat) || limit <= 0) return [];
    const picked = [];
    for (let i = chat.length - 1; i >= 0 && picked.length < limit; i--) {
        if (isTrackableDiffMessage(chat[i])) picked.push(i);
    }
    return picked.reverse();
}

export function getLatestTrackableDiffIndices(limit = getDiffTrackedMessageLimit()) {
    const { chat } = getAppContext();
    return getLatestAssistantMessageIndices(chat, limit);
}

export function isTrackedDiffMessage(index) {
    const { chat } = getAppContext();
    const message = Array.isArray(chat) ? chat[index] : null;
    return getLatestTrackableDiffIndices().includes(index)
        && isAssistantMessage(message)
        && message.__blai_is_reverted !== true;
}
