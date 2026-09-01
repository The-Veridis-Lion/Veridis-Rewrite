import { getAppContext } from '../host/appContext.js';
import { streamingRuntimeState } from '../host/streamingState.js';
import { applyScopedReplacements, buildProcessors } from '../rules/engine.js';
import { resolveMessageIndexFromDomNode } from './message.js';
import { isProtectedNode, isRevertedMessageDomNode, isManualFinalMessageDomNode, isPurifiableMessageTextNode, isMessageOnAllowedSurface, messageBodySelector } from './protection.js';
import { collectStreamingTextRuns, collectStreamingRunText, applyDashPunctuationProjection } from './streaming.js';

/** Owns ordinary non-streaming Program projection onto allowed rendered message text. It performs DOM-only mutation and does not persist chat data. */
function shouldSkipTextNode(node) {
    const parent = node?.parentNode;
    if (!parent) return true;
    if (node.nodeType !== Node.TEXT_NODE) return true;
    if (!isPurifiableMessageTextNode(node)) return true;
    if (isProtectedNode(parent) || isRevertedMessageDomNode(parent) || isManualFinalMessageDomNode(parent)) return true;
    if (document.activeElement && (document.activeElement === parent || parent.contains(document.activeElement))) return true;
    return false;
}

function collectMessageBodyRoots(rootNode) {
    const roots = [];
    if (!rootNode) return roots;
    if (rootNode.nodeType === Node.ELEMENT_NODE && rootNode.matches?.(messageBodySelector)) roots.push(rootNode);
    rootNode.querySelectorAll?.(messageBodySelector).forEach((node) => roots.push(node));
    return [...new Set(roots)].filter((body) => isMessageOnAllowedSurface(body.closest?.('.mes')));
}

/**
 * 对指定 DOM 子树执行净化替换。
 * @param {Node} rootNode 待净化根节点。
 * @returns {void}
 */
export function purifyDOM(rootNode) {
    if (!rootNode || streamingRuntimeState.isStreamingGeneration === true) return;
    if (rootNode.nodeType === 1 && (isRevertedMessageDomNode(rootNode) || isManualFinalMessageDomNode(rootNode))) return;
    const processors = buildProcessors();
    if (processors.length === 0) return;

    const messageBodies = collectMessageBodyRoots(rootNode);
    for (const messageBody of messageBodies) {
        const runs = collectStreamingTextRuns(messageBody);
        const initialRunTexts = runs.map((run) => collectStreamingRunText(run));
        const walker = document.createTreeWalker(messageBody, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while (node = walker.nextNode()) {
            if (shouldSkipTextNode(node)) continue;

            const original = node.nodeValue || '';
            if (original.trim() === '') continue;

            const nextValue = applyScopedReplacements(original, { deterministic: true, domSafeOnly: true });
            if (original !== nextValue) node.nodeValue = nextValue;
        }

        const messageIndex = resolveMessageIndexFromDomNode(messageBody);
        const message = getAppContext().chat?.[messageIndex];
        if (typeof message?.mes === 'string') {
            applyDashPunctuationProjection(messageBody, runs, initialRunTexts, message.mes, processors);
        }
    }
}

