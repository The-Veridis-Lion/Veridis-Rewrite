(() => {
    const hostWin = window.parent && window.parent !== window ? window.parent : window;
    const hostDoc = hostWin.document;
    if (!hostDoc) {
        console.warn('[BLAI realtime beauty replay] host document not available');
        return;
    }

    const globalKey = '__blaiRealtimeBeautyReplay';
    const bridgeStyleId = 'blai-realtime-beauty-replay-style';
    const existing = hostWin[globalKey];
    if (existing && typeof existing.dispose === 'function') existing.dispose();

    const config = {
        hostRenderedEventMinIntervalMs: 120,
        emitCharacterRenderedEvent: true,
        emitMessageUpdatedEvent: false,
        mirrorMesTextStylesToHelperStreaming: true,
    };

    const state = {
        observer: null,
        headObserver: null,
        rafId: 0,
        styleRafId: 0,
        queuedMessages: new Set(),
        applying: false,
        lastHostEventAt: 0,
        lastBridgeCss: '',
        hooks: new Set(),
    };

    function getContext() {
        try {
            return hostWin.SillyTavern?.getContext?.() || window.SillyTavern?.getContext?.() || null;
        } catch (_) {
            return null;
        }
    }

    function getMessageIndex(messageNode) {
        const attrs = ['mesid', 'data-mesid', 'messageid', 'data-message-id'];
        for (const attr of attrs) {
            const value = Number(messageNode?.getAttribute?.(attr));
            if (Number.isInteger(value) && value >= 0) return value;
        }
        const messages = Array.from(hostDoc.querySelectorAll('#chat .mes'));
        return messages.indexOf(messageNode);
    }

    function isAssistantMessage(messageNode) {
        if (!messageNode || messageNode.nodeType !== 1 || !messageNode.matches?.('.mes')) return false;
        return messageNode.getAttribute('is_user') !== 'true' && messageNode.dataset?.isUser !== 'true';
    }

    function getClosestMessageNode(node) {
        const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
        const messageNode = element?.matches?.('.mes') ? element : element?.closest?.('.mes');
        return isAssistantMessage(messageNode) ? messageNode : null;
    }

    function getLatestAssistantMessage() {
        const messages = Array.from(hostDoc.querySelectorAll('#chat .mes'));
        for (let i = messages.length - 1; i >= 0; i--) {
            if (isAssistantMessage(messages[i])) return messages[i];
        }
        return null;
    }

    function bridgeSelectorText(selectorText) {
        if (!selectorText || !selectorText.includes('.mes_text')) return '';
        return selectorText
            .split(',')
            .map((selector) => selector.trim())
            .filter((selector) => selector.includes('.mes_text'))
            .map((selector) => selector.replaceAll('.mes_text', '.TH-streaming'))
            .join(', ');
    }

    function collectMesTextBridgeRules(cssRules, output) {
        if (!cssRules) return;
        for (const rule of Array.from(cssRules)) {
            if (rule.selectorText && rule.style) {
                const bridgedSelector = bridgeSelectorText(rule.selectorText);
                if (bridgedSelector) output.push(`${bridgedSelector} { ${rule.style.cssText} }`);
                continue;
            }

            if (rule.cssRules) {
                const nested = [];
                collectMesTextBridgeRules(rule.cssRules, nested);
                if (!nested.length) continue;

                if (rule.conditionText) {
                    output.push(`@media ${rule.conditionText} {\n${nested.join('\n')}\n}`);
                } else {
                    const atRule = String(rule.cssText || '').match(/^@[^{]+/)?.[0]?.trim();
                    output.push(atRule ? `${atRule} {\n${nested.join('\n')}\n}` : nested.join('\n'));
                }
            }
        }
    }

    function getAccessibleCssRules(sheet) {
        try {
            return sheet.cssRules;
        } catch (_) {
            return null;
        }
    }

    function buildStyleBridgeCss() {
        const rules = [];
        for (const sheet of Array.from(hostDoc.styleSheets || [])) {
            if (sheet.ownerNode?.id === bridgeStyleId) continue;
            collectMesTextBridgeRules(getAccessibleCssRules(sheet), rules);
        }

        const fallback = `
#chat .TH-streaming i,
#chat .TH-streaming em {
    color: var(--SmartThemeEmColor);
}

#chat .TH-streaming q i,
#chat .TH-streaming q em {
    color: inherit;
}

#chat .TH-streaming u {
    color: var(--SmartThemeUnderlineColor);
}

#chat .TH-streaming q {
    color: var(--SmartThemeQuoteColor);
}

#chat .TH-streaming font[color] em,
#chat .TH-streaming font[color] i,
#chat .TH-streaming font[color] u,
#chat .TH-streaming font[color] q {
    color: inherit;
}

#chat .TH-streaming blockquote {
    border-left: 3px solid var(--SmartThemeQuoteColor);
    padding-left: 10px;
    background-color: var(--black30a);
    margin: 0;
}
`;

        return `/* Generated by BLAI realtime beauty replay. Mirrors .mes_text styles to Tavern Helper .TH-streaming. */\n${fallback}\n${rules.join('\n')}`;
    }

    function refreshStyleBridge() {
        state.styleRafId = 0;
        if (!config.mirrorMesTextStylesToHelperStreaming) return;
        if (!hostDoc.head) return;

        let style = hostDoc.getElementById(bridgeStyleId);
        if (!style) {
            style = hostDoc.createElement('style');
            style.id = bridgeStyleId;
            hostDoc.head.appendChild(style);
        }

        const css = buildStyleBridgeCss();
        if (css !== state.lastBridgeCss) {
            state.lastBridgeCss = css;
            style.textContent = css;
        }
    }

    function scheduleStyleBridgeRefresh() {
        if (!config.mirrorMesTextStylesToHelperStreaming || state.styleRafId) return;
        state.styleRafId = hostWin.requestAnimationFrame(refreshStyleBridge);
    }

    function emitHostRenderedEvents(messageNode, messageIndex) {
        if (!config.emitCharacterRenderedEvent && !config.emitMessageUpdatedEvent) return;
        const now = Date.now();
        if (now - state.lastHostEventAt < config.hostRenderedEventMinIntervalMs) return;

        const context = getContext();
        const eventSource = context?.eventSource;
        const eventTypes = context?.eventTypes || context?.event_types;
        if (!eventSource || typeof eventSource.emit !== 'function' || !eventTypes) return;

        state.lastHostEventAt = now;
        if (config.emitCharacterRenderedEvent && eventTypes.CHARACTER_MESSAGE_RENDERED) {
            Promise.resolve(eventSource.emit(eventTypes.CHARACTER_MESSAGE_RENDERED, messageIndex)).catch(() => {});
        }
        if (config.emitMessageUpdatedEvent && eventTypes.MESSAGE_UPDATED) {
            Promise.resolve(eventSource.emit(eventTypes.MESSAGE_UPDATED, messageIndex)).catch(() => {});
        }
    }

    function runHooks(messageNode, messageIndex) {
        state.hooks.forEach((hook) => {
            try {
                hook(messageNode, messageIndex);
            } catch (error) {
                console.warn('[BLAI realtime beauty replay] hook failed:', error);
            }
        });
        hostWin.dispatchEvent(new hostWin.CustomEvent('blai:realtime-beauty-frame', {
            detail: { messageNode, messageIndex },
        }));
    }

    function flush() {
        state.rafId = 0;
        scheduleStyleBridgeRefresh();

        const latest = getLatestAssistantMessage();
        if (!latest) {
            state.queuedMessages.clear();
            return;
        }

        const messages = state.queuedMessages.has(latest) ? [latest] : [];
        state.queuedMessages.clear();
        if (messages.length === 0) return;

        state.applying = true;
        try {
            messages.forEach((messageNode) => {
                const messageIndex = getMessageIndex(messageNode);
                if (messageIndex < 0) return;
                emitHostRenderedEvents(messageNode, messageIndex);
                runHooks(messageNode, messageIndex);
            });
        } finally {
            state.applying = false;
        }
    }

    function queue(messageNode) {
        if (!messageNode || !messageNode.isConnected || !isAssistantMessage(messageNode)) return;
        state.queuedMessages.add(messageNode);
        if (state.rafId) return;
        state.rafId = hostWin.requestAnimationFrame(flush);
    }

    function handleMutations(mutations) {
        if (state.applying) return;
        for (const mutation of mutations) {
            const directMessage = getClosestMessageNode(mutation.target);
            if (directMessage) queue(directMessage);
            mutation.addedNodes?.forEach?.((node) => {
                const messageNode = getClosestMessageNode(node);
                if (messageNode) queue(messageNode);
            });
        }
    }

    function observeHead() {
        if (!hostDoc.head || state.headObserver) return;
        state.headObserver = new hostWin.MutationObserver(scheduleStyleBridgeRefresh);
        state.headObserver.observe(hostDoc.head, {
            childList: true,
            subtree: true,
            characterData: true,
        });
    }

    function start() {
        const chat = hostDoc.getElementById('chat');
        if (!chat) {
            hostWin.setTimeout(start, 500);
            return;
        }
        refreshStyleBridge();
        observeHead();
        state.observer = new hostWin.MutationObserver(handleMutations);
        state.observer.observe(chat, { childList: true, subtree: true, characterData: true });
        queue(getLatestAssistantMessage());
        console.info('[BLAI realtime beauty replay] started');
    }

    hostWin[globalKey] = {
        config,
        register(hook) {
            if (typeof hook !== 'function') return () => {};
            state.hooks.add(hook);
            queue(getLatestAssistantMessage());
            return () => state.hooks.delete(hook);
        },
        flush() {
            scheduleStyleBridgeRefresh();
            queue(getLatestAssistantMessage());
        },
        dispose() {
            if (state.observer) state.observer.disconnect();
            if (state.headObserver) state.headObserver.disconnect();
            if (state.rafId) hostWin.cancelAnimationFrame(state.rafId);
            if (state.styleRafId) hostWin.cancelAnimationFrame(state.styleRafId);
            state.queuedMessages.clear();
            state.hooks.clear();
            hostDoc.getElementById(bridgeStyleId)?.remove();
            delete hostWin[globalKey];
            if (window !== hostWin) delete window[globalKey];
            console.info('[BLAI realtime beauty replay] stopped');
        },
    };
    if (window !== hostWin) window[globalKey] = hostWin[globalKey];

    start();
})();
