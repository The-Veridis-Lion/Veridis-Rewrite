/**
 * Owns host-rendered message refresh and post-render visual settling.
 * It does not mutate authoritative message text or own chat persistence.
 */
import { getAppContext } from '../host/appContext.js';
import { logger } from '../log.js';
import { ensureMessageDiffButton } from '../diff/view.js';
import { beginAtomicMessageDisplaySwap, getMessageDomNode } from '../dom/message.js';
import { getSillyTavernContextSnapshot } from '../host/context.js';
import { isBaiBaiToolkitInstalled } from '../integrations/baiBai.js';
import { isLoreFrameInstalled } from '../integrations/loreFrame.js';
import { isTauriTavernHost } from '../integrations/tauriTavern.js';

let messageRefreshMissingWarned = false;
let messageRefreshReloadInFlight = false;
const postRefreshDomSettleTimers = new Map();

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

function usesManagedTauriTavernChatSurface() {
    if (!isTauriTavernHost()) return false;
    try {
        const chatSurface = globalThis.__TAURITAVERN__?.api?.chatSurface;
        return typeof chatSurface?.isManagedOwnershipRequired === 'function'
            && chatSurface.isManagedOwnershipRequired() === true;
    } catch (error) {
        logger.warn('读取 TauriTavern ChatSurface 所有权失败', error);
        return false;
    }
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

    const delays = [120, 450];
    const timers = delays.map((delay) => {
        return setTimeout(() => {
            const messageNode = getMessageDomNode(index);
            if (!messageNode) return;
            try {
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
            const isBaiBaiInstalled = isBaiBaiToolkitInstalled();
            const shouldEmitRenderedEvent = options.emitRenderedEvent === true
                || (options.emitRenderedEvent === 'auto'
                    && !usesManagedTauriTavernChatSurface()
                    && looksLikeTemplateRenderedContent(index, message));
            const shouldNotifyRenderedEvent = shouldEmitRenderedEvent || isBaiBaiInstalled;
            const needsHostSettle = isTauriTavernHost() || isBaiBaiInstalled;
            const shouldEmitMessageUpdatedEvent = isLoreFrameInstalled()
                && !shouldNotifyRenderedEvent;
            const pendingEvents = [];
            if (shouldNotifyRenderedEvent) pendingEvents.push(scheduleRenderedEvent(index, message, stContext));
            else if (shouldEmitMessageUpdatedEvent) {
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
