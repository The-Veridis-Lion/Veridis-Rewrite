/** Owns LoreFrame presence detection and its protected DOM selector. */
import { logger } from '../log.js';
import { getGlobalObject } from '../host/context.js';

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
