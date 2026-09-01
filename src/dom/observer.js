/** Owns observation of host-rendered DOM/input surfaces and routes allowed visual Program projection to existing DOM owners. It does not mutate persisted message data. */
import { getAppContext } from '../host/appContext.js';
import { streamingRuntimeState } from '../host/streamingState.js';
import { rulesRuntimeState } from '../rules/state.js';
import { applyScopedReplacements, buildProcessors } from '../rules/engine.js';
import { purifyDOM } from './purify.js';
import { isAllowedChatInputElement, isProtectedNode, isPurifiableMessageTextNode, isRevertedMessageDomNode } from './protection.js';
import { syncPersonaDescriptionProtectionControl } from '../ui/personaProtection.js';
import { computeMessageSignature, markDiffComparisonPending } from '../diff/state.js';
import { getLatestTrackableDiffIndices, isAssistantMessage } from '../diff/tracking.js';
import { resolveMessageIndexFromDomNode } from './message.js';

let isPurifying = false;

export function initPersonaProtectionObserver() {
    syncPersonaDescriptionProtectionControl();
    const personaProtectionIntervalId = setInterval(syncPersonaDescriptionProtectionControl, 1000);
    window.addEventListener('beforeunload', () => clearInterval(personaProtectionIntervalId), { once: true });
}

function collectMessageNodes(node, bucket) {
    if (!node || node.nodeType !== 1) return;
    if (node.matches?.('.mes')) bucket.push(node);
    node.querySelectorAll?.('.mes').forEach((mes) => bucket.push(mes));
}

function primePendingComparisonForNode(messageNode, retainedDiffIndices, touchedMessageIndices, options = {}) {
    const { chat } = getAppContext();
    const index = resolveMessageIndexFromDomNode(messageNode);
    if (index < 0 || !Array.isArray(chat) || !isAssistantMessage(chat[index])) return -1;
    if (!retainedDiffIndices.has(index) || touchedMessageIndices.has(index)) return -1;
    markDiffComparisonPending(index, computeMessageSignature(chat[index]), options);
    touchedMessageIndices.add(index);
    return index;
}

function applyMutationTextMask(textNode) {
    const original = textNode?.nodeValue || '';
    if (!original) return false;

    const nextValue = applyScopedReplacements(original, { deterministic: true, domSafeOnly: true });
    if (original === nextValue) return false;
    textNode.nodeValue = nextValue;
    return true;
}

export function initDomObserver({ injectDiffButtons }) {
    const chatObserver = new MutationObserver((mutations) => {
        if (isPurifying || streamingRuntimeState.isStreamingGeneration === true) return;

        const processors = buildProcessors();
        if (processors.length === 0) return;

        const retainedDiffIndices = new Set(getLatestTrackableDiffIndices());
        const touchedMessageIndices = new Set();
        isPurifying = true;
        try {
            for (let mi = 0; mi < mutations.length; mi++) {
                const m = mutations[mi];
                for (let ni = 0; ni < m.addedNodes.length; ni++) {
                    const node = m.addedNodes[ni];
                    if (node.nodeType === 3) {
                        if (!isPurifiableMessageTextNode(node)) continue;
                        if (node.parentNode && isProtectedNode(node.parentNode)) continue;
                        if (node.parentNode && isRevertedMessageDomNode(node.parentNode)) continue;
                        applyMutationTextMask(node);
                    } else if (node.nodeType === 1) {
                        const messageNodes = [];
                        collectMessageNodes(node, messageNodes);
                        purifyDOM(node);
                        messageNodes.forEach((mesNode) => {
                            primePendingComparisonForNode(mesNode, retainedDiffIndices, touchedMessageIndices, { skipPersist: true });
                        });
                    }
                }
                if (m.type === 'characterData') {
                    if (!isPurifiableMessageTextNode(m.target)) continue;
                    if (m.target.parentNode && isProtectedNode(m.target.parentNode)) continue;
                    if (m.target.parentNode && isRevertedMessageDomNode(m.target.parentNode)) continue;
                    applyMutationTextMask(m.target);
                }
            }
        } finally {
            chatObserver.takeRecords();
            injectDiffButtons([...touchedMessageIndices]);
            isPurifying = false;
        }
    });

    const chatEl = document.getElementById('chat');
    if (chatEl) chatObserver.observe(chatEl, { childList: true, subtree: true, characterData: true });

    let currentTheaterShadow = null;
    const theaterIntervalId = setInterval(() => {
        const theaterHost = document.querySelector('#t-output-content .t-shadow-host');
        if (theaterHost && theaterHost.shadowRoot) {
            if (currentTheaterShadow !== theaterHost) {
                chatObserver.observe(theaterHost.shadowRoot, { childList: true, subtree: true, characterData: true });
                currentTheaterShadow = theaterHost;
                isPurifying = true;
                try { purifyDOM(theaterHost.shadowRoot); } catch (err) {} finally { isPurifying = false; }
            }
        } else {
            currentTheaterShadow = null;
        }
    }, 800);
    window.addEventListener('beforeunload', () => clearInterval(theaterIntervalId), { once: true });

    document.addEventListener('input', (e) => {
        const el = e.target;
        if (!isAllowedChatInputElement(el) || isProtectedNode(el)) return;
        buildProcessors();
        if (rulesRuntimeState.activeProcessors.length === 0) return;
        const originalVal = el.value || '';
        const cleanedVal = applyScopedReplacements(originalVal, { deterministic: true });
        if (originalVal !== cleanedVal) {
            const start = el.selectionStart;
            isPurifying = true;
            try {
                el.value = cleanedVal;
                try { el.setSelectionRange(start, start); } catch (err) {}
            } finally {
                isPurifying = false;
            }
        }
    }, true);
}
