/**
 * Owns realtime interception and SillyTavern host lifecycle bindings.
 */
import { extensionName, getAppContext, runtimeState } from '../state.js';
import { applyCharacterPresetBinding } from '../ui.js';
import {
    performGlobalCleanse,
    performIncrementalCleanse,
    getMessageIndexFromEvent,
    getLatestMessageIndex,
} from '../core.js';
import { applyScopedReplacements, buildProcessors } from '../replacementEngine.js';
import { purifyDOM, renderStreamingVisualMask, replayStreamingVisualMask, isProtectedNode, isUserMessageDomNode, isRevertedMessageDomNode, isPurifiableMessageTextNode, isAllowedChatInputElement, syncPersonaDescriptionProtectionControl } from '../dom.js';
import { buildDiffSnippetsFromText, computeMessageSignature, injectDiffButtons, isAssistantMessage, markDiffComparisonPending, refreshDiffCacheIfStale, resetDiffRuntimeState, restoreDiffStateFromChatMetadata } from '../diff.js';
import { getMessageSwipeIndex, setCurrentSwipeText, writeMessageDiffManualFinal } from '../messageMeta.js';
import { getCurrentChatIdentity, getMvuExtraModelTransaction, isBaiBaiToolkitInstalled, isTauriTavernHost, shouldWaitForMvuExtraModelTransaction } from '../platform.js';
import { adoptMvuMessageContentForAiRewrite, getActiveAiRewriteBranchKeyForMessage, handleAiRewriteGenerationStarted, hasInvalidAiRewriteTarget, isLiveAiRewriteTargetMessage, markAiRewriteFinalCleanseReady, maybeNotifyAiRewriteReadyFromStreamingText, recordAiRewriteRuntimeDebug, resetAiRewriteRuntimeState, validateAiRewriteMessageTarget, waitForAutomaticAiRewrite } from '../aiRewrite.js';
import { generationLifecycle } from '../generationLifecycle.js';
import { classifyHostGenerationStart } from '../hostGenerationEvent.js';

let streamingDiffInjectTimer = null;
let streamingPendingDiffIndices = [];
let installStreamingProcessorVisualMaskFromEvents = null;
let finalizeCommittedStreamingMessageFromProcessor = null;
let streamProcessorInstallFailureLogged = false;

export function injectDiffButtonsStreamingSafe(indices = []) {
    if (runtimeState.isStreamingGeneration) {
        indices.forEach(i => { if (!streamingPendingDiffIndices.includes(i)) streamingPendingDiffIndices.push(i); });
        if (streamingDiffInjectTimer) return;
        streamingDiffInjectTimer = setTimeout(() => {
            streamingDiffInjectTimer = null;
            const pending = [...streamingPendingDiffIndices];
            streamingPendingDiffIndices = [];
            if (pending.length > 0) injectDiffButtons(pending);
        }, 100);
    } else {
        if (indices.length > 0) injectDiffButtons(indices);
    }
}

export function initRealtimeInterceptor() {
    let isPurifying = false;
    generationLifecycle.configure({
        getCurrentChatId: getCurrentChatIdentity,
        getCurrentChat: () => getAppContext().chat,
        onLog: (stage, details) => recordAiRewriteRuntimeDebug(stage, details),
    });
    syncPersonaDescriptionProtectionControl();
    const personaProtectionIntervalId = setInterval(syncPersonaDescriptionProtectionControl, 1000);
    window.addEventListener('beforeunload', () => clearInterval(personaProtectionIntervalId), { once: true });
    window.addEventListener('blai:realtime-beauty-frame', (event) => {
        if (runtimeState.isStreamingGeneration !== true) return;
        replayStreamingVisualMask(event?.detail?.messageIndex);
    });
    const resolveNodeMessageIndex = (node) => {
        if (!node || node.nodeType !== 1) return -1;
        const attrs = [node.getAttribute('mesid'), node.getAttribute('data-mesid'), node.getAttribute('messageid'), node.getAttribute('data-message-id')];
        for (const raw of attrs) {
            const n = Number(raw);
            if (Number.isInteger(n) && n >= 0) return n;
        }
        const chatEl = document.getElementById('chat');
        if (!chatEl) return -1;
        return Array.from(chatEl.querySelectorAll('.mes')).indexOf(node);
    };

    const collectMessageNodes = (node, bucket) => {
        if (!node || node.nodeType !== 1) return;
        if (node.matches?.('.mes')) bucket.push(node);
        node.querySelectorAll?.('.mes').forEach((mes) => bucket.push(mes));
    };

    const primePendingComparisonForNode = (messageNode, options = {}) => {
        const { chat } = getAppContext();
        const index = resolveNodeMessageIndex(messageNode);
        if (index < 0 || !Array.isArray(chat) || !isAssistantMessage(chat[index])) return -1;
        markDiffComparisonPending(index, computeMessageSignature(chat[index]), options);
        return index;
    };

    const streamingProcessorPatchKey = '__blai_streaming_visual_mask';

    const getCurrentStreamingProcessor = () => {
        const getter = getAppContext().getStreamingProcessor;
        return typeof getter === 'function' ? getter() : null;
    };

    const markStreamingMessagePending = (messageId) => {
        const { chat } = getAppContext();
        const index = Number.isInteger(messageId) && messageId >= 0 ? messageId : -1;
        if (!Number.isInteger(index) || index < 0 || !Array.isArray(chat) || !isAssistantMessage(chat[index])) return;
        markDiffComparisonPending(index, computeMessageSignature(chat[index]), { skipPersist: true });
        injectDiffButtonsStreamingSafe([index]);
    };

    const installStreamingProcessorVisualMask = () => {
        const processor = getCurrentStreamingProcessor();
        if (!processor || typeof processor.onProgressStreaming !== 'function') return false;
        if (processor[streamingProcessorPatchKey]) return true;

        const originalOnProgress = processor.onProgressStreaming;
        const originalFinalizeIntermediaryMessage = processor.finalizeIntermediaryMessage;
        const originalOnError = processor.onErrorStreaming;
        const originalMarkUIGenStopped = processor.markUIGenStopped;
        const processorSession = generationLifecycle.getActive();
        const processorGenerationId = processorSession?.generationId || '';
        const processorChatId = processorSession?.chatId || '';
        processor[streamingProcessorPatchKey] = true;
        processor.finalizeIntermediaryMessage = async function(...args) {
            const messageId = args[0];
            try {
                return await originalFinalizeIntermediaryMessage.apply(this, args);
            } finally {
                generationLifecycle.discardStreamingHostReceipt(processorGenerationId, messageId);
            }
        };
        processor.onErrorStreaming = function(...args) {
            if (this.type !== 'swipe' && this.type !== 'impersonate' && this.type !== 'continue') {
                const errorMessageId = this.messageId;
                const { chat } = getAppContext();
                const errorMessageRef = Number.isInteger(errorMessageId) && Array.isArray(chat)
                    ? chat[errorMessageId]
                    : null;
                generationLifecycle.recordStreamingHostReceipt(
                    processorGenerationId,
                    errorMessageId,
                    errorMessageRef,
                );
            }
            return originalOnError.apply(this, args);
        };
        processor.markUIGenStopped = function(...args) {
            const activeGenerationId = generationLifecycle.getActive()?.generationId || '';
            if (activeGenerationId && activeGenerationId !== processorGenerationId) {
                recordAiRewriteRuntimeDebug('stale-streaming-ui-end-skipped', {
                    processorGenerationId,
                    activeGenerationId,
                });
                return;
            }
            return originalMarkUIGenStopped.apply(this, args);
        };
        processor.onProgressStreaming = async function(messageId, text, isFinal) {
            const rawText = typeof text === 'string' ? text : String(text ?? '');
            const numericMessageId = Number.isInteger(messageId) && messageId >= 0 ? messageId : -1;
            let changed = false;

            const result = await originalOnProgress.call(this, messageId, rawText, isFinal);
            if (Number.isInteger(numericMessageId) && numericMessageId >= 0) {
                const { chat } = getAppContext();
                const committedMessage = Array.isArray(chat) ? chat[numericMessageId] : null;
                const committedText = typeof committedMessage?.mes === 'string'
                    ? committedMessage.mes
                    : '';
                runtimeState.streamingCommittedMessageCache.set(numericMessageId, committedText);
                changed = renderStreamingVisualMask(numericMessageId, committedText);
                if (committedText) {
                    maybeNotifyAiRewriteReadyFromStreamingText(numericMessageId, committedText, {
                        generationId: processorGenerationId,
                        chatId: processorChatId,
                        source: 'streaming-committed',
                        hostCommitted: true,
                    });
                }
                if (isFinal === true && typeof finalizeCommittedStreamingMessageFromProcessor === 'function') {
                    await finalizeCommittedStreamingMessageFromProcessor(numericMessageId, processorGenerationId);
                    generationLifecycle.recordStreamingHostReceipt(
                        processorGenerationId,
                        numericMessageId,
                        committedMessage,
                    );
                }
            }
            if (changed) markStreamingMessagePending(numericMessageId);
            return result;
        };
        return true;
    };
    installStreamingProcessorVisualMaskFromEvents = installStreamingProcessorVisualMask;

    const applyMutationTextMask = (textNode) => {
        const original = textNode?.nodeValue || '';
        if (!original) return false;

        const nextValue = applyScopedReplacements(original, { deterministic: true, domSafeOnly: true });
        if (original === nextValue) return false;
        textNode.nodeValue = nextValue;
        return true;
    };

    const chatObserver = new MutationObserver((mutations) => {
        if (isPurifying || runtimeState.isStreamingGeneration === true) return;

        const processors = buildProcessors();
        if (processors.length === 0) return;
        
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
                        if (node.parentNode && getAppContext().extension_settings?.[extensionName]?.skipUserMessages && isUserMessageDomNode(node.parentNode)) continue;
                        applyMutationTextMask(node);
                    } else if (node.nodeType === 1) {
                        const messageNodes = [];
                        collectMessageNodes(node, messageNodes);
                        purifyDOM(node);
                        messageNodes.forEach((mesNode) => {
                            const index = primePendingComparisonForNode(mesNode);
                            if (index >= 0) touchedMessageIndices.add(index);
                        });
                    }
                }
                if (m.type === 'characterData') {
                    if (!isPurifiableMessageTextNode(m.target)) continue;
                    if (m.target.parentNode && isProtectedNode(m.target.parentNode)) continue;
                    if (m.target.parentNode && isRevertedMessageDomNode(m.target.parentNode)) continue;
                    if (m.target.parentNode && getAppContext().extension_settings?.[extensionName]?.skipUserMessages && isUserMessageDomNode(m.target.parentNode)) continue;
                    applyMutationTextMask(m.target);
                }
            }
        } finally {
            chatObserver.takeRecords();
            injectDiffButtonsStreamingSafe([...touchedMessageIndices]);
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
        if (runtimeState.activeProcessors.length === 0) return;
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


export function bindHostLifecycleEvents() {
    const { eventSource, event_types } = getAppContext();
    const markPendingFromPayload = (payload) => {
        const { chat } = getAppContext();
        const index = getMessageIndexFromEvent(payload);
        if (index < 0 || !Array.isArray(chat) || !isAssistantMessage(chat[index])) return;
        markDiffComparisonPending(index, computeMessageSignature(chat[index]));
        injectDiffButtonsStreamingSafe([index]);
    };

    const hasCurrentRuleDifference = (sourceMes) => {
        if (typeof sourceMes !== 'string' || !sourceMes) return false;
        const diffResult = buildDiffSnippetsFromText(sourceMes);
        return typeof diffResult.cleanedText === 'string' && diffResult.cleanedText !== sourceMes;
    };

    const resolveMessageIndexForCleansePayload = (payload) => {
        return getMessageIndexFromEvent(payload);
    };

    const resolveFinalCleanseSourceForPayload = (payload) => {
        const { chat } = getAppContext();
        const index = resolveMessageIndexForCleansePayload(payload);
        if (index < 0 || !Array.isArray(chat) || !isAssistantMessage(chat[index])) return { index: -1, sourceMes: undefined };

        const finalMes = typeof chat[index]?.mes === 'string' ? chat[index].mes : '';
        if (hasCurrentRuleDifference(finalMes)) return { index, sourceMes: finalMes };

        const streamingCommittedMes = runtimeState.streamingCommittedMessageCache.get(index);
        if (typeof streamingCommittedMes === 'string' && streamingCommittedMes !== finalMes && hasCurrentRuleDifference(streamingCommittedMes)) {
            return { index, sourceMes: streamingCommittedMes };
        }

        return {
            index,
            sourceMes: undefined,
        };
    };

    const runFinalStreamingCleanse = (payload, options = {}) => {
        if (options.acknowledgeGenerationId) {
            const targetValidation = validateAiRewriteMessageTarget(payload);
            if (!targetValidation.ok) {
                recordAiRewriteRuntimeDebug('message-target-rejected', {
                    generationId: options.acknowledgeGenerationId,
                    chatId: String(payload?.chatId || ''),
                    reason: targetValidation.reason,
                }, 'warn');
                return;
            }
        }
        const { index, sourceMes } = resolveFinalCleanseSourceForPayload(payload);
        const cleanseResult = performIncrementalCleanse(payload, {
            visualOnly: false,
            diffSourceMes: sourceMes,
        });
        if (options.acknowledgeGenerationId
            && cleanseResult?.dataChanged === true
            && cleanseResult?.messageTextChanged === true) {
            const acknowledgement = generationLifecycle.acknowledgeInternalMessageMutation(options.acknowledgeGenerationId, {
                chatId: String(payload?.chatId || ''),
                chat: getAppContext().chat,
                messageId: cleanseResult.index,
                messageRef: cleanseResult.messageRef,
                beforeText: cleanseResult.beforeText,
                afterText: cleanseResult.afterText,
                source: options.acknowledgementSource || 'final-streaming-cleanse',
            });
            if (!acknowledgement.ok) {
                recordAiRewriteRuntimeDebug('internal-message-mutation-rejected', {
                    generationId: options.acknowledgeGenerationId,
                    chatId: String(payload?.chatId || ''),
                    index: cleanseResult.index,
                    reason: acknowledgement.reason,
                }, 'warn');
            }
        }
        if (options.clearRawSource === true && index >= 0) {
            runtimeState.streamingCommittedMessageCache.delete(index);
        }
        return cleanseResult;
    };

    let pendingMvuFinalPayload = null;
    let activeMvuFinalPromise = null;
    let activeMvuFinalGenerationId = '';
    let completedMvuFinalGenerationId = '';

    const buildActiveMvuFinalPayload = async (source) => {
        const transaction = getMvuExtraModelTransaction();
        if (!transaction.enabled) return null;

        const session = generationLifecycle.getActive();
        const { chat } = getAppContext();
        if (!session || !Array.isArray(chat)) return null;

        const candidateIndex = Number.isInteger(session.messageId)
            ? session.messageId
            : getLatestMessageIndex();
        if (candidateIndex < 0) return null;
        if (!await shouldWaitForMvuExtraModelTransaction(candidateIndex)) return null;

        const resolution = generationLifecycle.bindMessage(candidateIndex, {
            generationId: session.generationId,
            chatId: getCurrentChatIdentity(),
            chat,
            source,
        });
        if (!resolution.ok) {
            recordAiRewriteRuntimeDebug('mvu-transaction-rejected', {
                generationId: session.generationId,
                source,
                reason: resolution.reason,
            }, 'warn');
            return null;
        }

        generationLifecycle.markFinalSource(resolution.generationId, source);
        return {
            automatic: true,
            generationId: resolution.generationId,
            chatId: resolution.chatId,
            messageId: resolution.messageIndex,
            source,
        };
    };

    const runMvuFinalTransaction = async (context = null, source = 'mvu-before-message-update') => {
        const stablePayload = pendingMvuFinalPayload || await buildActiveMvuFinalPayload(source);
        if (!stablePayload) return false;

        const { chat } = getAppContext();
        const msg = Array.isArray(chat) ? chat[stablePayload.messageId] : null;
        if (!isAssistantMessage(msg) || typeof msg.mes !== 'string') return false;
        if (context && typeof context.message_content === 'string') {
            const adoption = adoptMvuMessageContentForAiRewrite(stablePayload, context.message_content);
            if (!adoption.ok) {
                recordAiRewriteRuntimeDebug('mvu-transaction-rejected', {
                    generationId: stablePayload.generationId,
                    index: stablePayload.messageId,
                    source,
                    reason: adoption.reason,
                }, 'warn');
                return false;
            }
        }

        if (completedMvuFinalGenerationId === stablePayload.generationId) {
            if (context && typeof msg.mes === 'string') context.message_content = msg.mes;
            return true;
        }
        if (activeMvuFinalPromise && activeMvuFinalGenerationId === stablePayload.generationId) {
            await activeMvuFinalPromise;
            if (context && typeof msg.mes === 'string') context.message_content = msg.mes;
            return true;
        }

        activeMvuFinalGenerationId = stablePayload.generationId;
        activeMvuFinalPromise = (async () => {
            runtimeState.isStreamingGeneration = false;
            recordAiRewriteRuntimeDebug('mvu-transaction-start', {
                generationId: stablePayload.generationId,
                index: stablePayload.messageId,
                source,
            });

            runFinalStreamingCleanse(stablePayload, {
                acknowledgeGenerationId: stablePayload.generationId,
                acknowledgementSource: 'mvu-transaction-cleanse',
            });
            markAiRewriteFinalCleanseReady(stablePayload, { scheduleRequest: false });
            await waitForAutomaticAiRewrite(stablePayload.generationId);

            runtimeState.streamingCommittedMessageCache.delete(stablePayload.messageId);
            completedMvuFinalGenerationId = stablePayload.generationId;
            pendingMvuFinalPayload = null;
            recordAiRewriteRuntimeDebug('mvu-transaction-complete', {
                generationId: stablePayload.generationId,
                index: stablePayload.messageId,
                source,
            });
        })();

        try {
            await activeMvuFinalPromise;
            if (context && typeof msg.mes === 'string') context.message_content = msg.mes;
            return true;
        } catch (error) {
            recordAiRewriteRuntimeDebug('mvu-transaction-failed', {
                generationId: stablePayload.generationId,
                index: stablePayload.messageId,
                source,
                reason: error?.message || String(error || 'unknown'),
            }, 'warn');
            if (context && typeof msg.mes === 'string') context.message_content = msg.mes;
            return false;
        } finally {
            if (activeMvuFinalGenerationId === stablePayload.generationId) {
                activeMvuFinalPromise = null;
                activeMvuFinalGenerationId = '';
            }
        }
    };

    const finalizeGenerationMessage = async (messageId, source, generationId = '') => {
        const { chat } = getAppContext();
        const resolution = generationLifecycle.bindMessage(messageId, {
            generationId,
            chatId: getCurrentChatIdentity(),
            chat,
            source,
        });
        if (!resolution.ok) {
            recordAiRewriteRuntimeDebug('payload-rejected', {
                source,
                reason: resolution.reason,
                generationId: generationLifecycle.getActive()?.generationId || '',
            }, 'warn');
            return;
        }
        runtimeState.isStreamingGeneration = false;

        if (!generationLifecycle.markFinalSource(resolution.generationId, source)) {
            recordAiRewriteRuntimeDebug('finalization-deduped', {
                generationId: resolution.generationId,
                index: resolution.messageIndex,
                source,
                phase: generationLifecycle.getSession(resolution.generationId)?.phase || '',
            });
            return;
        }
        const stablePayload = {
            automatic: true,
            generationId: resolution.generationId,
            chatId: resolution.chatId,
            messageId: resolution.messageIndex,
            source,
        };
        markPendingFromPayload(stablePayload);
        if (completedMvuFinalGenerationId === resolution.generationId) return;

        const waitForMvuExtraModel = await shouldWaitForMvuExtraModelTransaction(resolution.messageIndex);
        const routeValidation = generationLifecycle.validate(resolution.generationId);
        if (!routeValidation.ok) {
            recordAiRewriteRuntimeDebug('mvu-route-rejected', {
                generationId: resolution.generationId,
                index: resolution.messageIndex,
                source,
                reason: routeValidation.reason,
            }, 'warn');
            return;
        }
        if (completedMvuFinalGenerationId === resolution.generationId) return;
        if (waitForMvuExtraModel) {
            pendingMvuFinalPayload = stablePayload;
            recordAiRewriteRuntimeDebug('final-cleanse-deferred-to-mvu', {
                generationId: resolution.generationId,
                index: resolution.messageIndex,
                source,
            });
            return;
        }
        const aiOwnsFinalCommit = markAiRewriteFinalCleanseReady(stablePayload);
        if (!aiOwnsFinalCommit) {
            runFinalStreamingCleanse(stablePayload, {
                clearRawSource: true,
                acknowledgeGenerationId: resolution.generationId,
                acknowledgementSource: 'direct-final-cleanse',
            });
            return;
        }

        runtimeState.streamingCommittedMessageCache.delete(resolution.messageIndex);
        recordAiRewriteRuntimeDebug('final-cleanse-deferred-to-ai', {
            generationId: resolution.generationId,
            index: resolution.messageIndex,
            phase: 'direct',
        });
    };
    finalizeCommittedStreamingMessageFromProcessor = (messageId, generationId) => {
        return finalizeGenerationMessage(messageId, 'streaming-committed-final', generationId);
    };

    const cancelAutomaticGeneration = (reason) => {
        generationLifecycle.cancelActive(reason);
        resetAiRewriteRuntimeState(reason);
        pendingMvuFinalPayload = null;
        activeMvuFinalPromise = null;
        activeMvuFinalGenerationId = '';
        completedMvuFinalGenerationId = '';
    };

    if (event_types.MESSAGE_EDITED) {
        eventSource.on(event_types.MESSAGE_EDITED, (payload) => {
            const { chat } = getAppContext();
            const index = getMessageIndexFromEvent(payload);
            const msg = Number.isInteger(index) && index >= 0 && Array.isArray(chat) ? chat[index] : null;
            if (!isAssistantMessage(msg) || typeof msg.mes !== 'string') return;

            if (msg.extra && typeof msg.extra === 'object' && Object.prototype.hasOwnProperty.call(msg.extra, 'display_text')) {
                delete msg.extra.display_text;
            }
            setCurrentSwipeText(msg, msg.mes);
            const manualTraceChanged = writeMessageDiffManualFinal(msg);

            runtimeState.streamingCommittedMessageCache.delete(index);
            runtimeState.nonStreamingRawMessageCache.delete(index);
            runtimeState.diffRawSourceCache.delete(index);
            runtimeState.hostRenderedEventSuppressUntil.set(index, Date.now() + 1000);

            if (manualTraceChanged) {
                const signature = computeMessageSignature(msg);
                markDiffComparisonPending(index, signature, { skipPersist: true });
                refreshDiffCacheIfStale(index);
                injectDiffButtonsStreamingSafe([index]);
            }
        });
    }

    if (isTauriTavernHost() || isBaiBaiToolkitInstalled()) {
        let updateCleanseTimer = null;
        const pendingRenderedCleanseIndices = new Set();
        const shouldSkipOwnRenderedEvent = (index) => {
            const until = runtimeState.hostRenderedEventSuppressUntil?.get(index);
            if (!Number.isFinite(until)) return false;
            if (Date.now() <= until) return true;
            runtimeState.hostRenderedEventSuppressUntil.delete(index);
            return false;
        };
        const scheduleRenderedMessageCleanse = (payload, delay = 120) => {
            if (runtimeState.isStreamingGeneration === true) return;
            const activeGenerationId = generationLifecycle.getActive()?.generationId;
            if (pendingMvuFinalPayload?.generationId === activeGenerationId) return;
            const explicitIndex = getMessageIndexFromEvent(payload);
            const index = explicitIndex;
            if (index < 0) return;
            if (shouldSkipOwnRenderedEvent(index)) return;
            pendingRenderedCleanseIndices.add(index);
            markPendingFromPayload(index);
            if (updateCleanseTimer) clearTimeout(updateCleanseTimer);
            updateCleanseTimer = setTimeout(() => {
                const indices = [...pendingRenderedCleanseIndices];
                pendingRenderedCleanseIndices.clear();
                indices.forEach((messageIndex) => {
                    const { sourceMes } = resolveFinalCleanseSourceForPayload(messageIndex);
                    performIncrementalCleanse(messageIndex, { visualOnly: false, diffSourceMes: sourceMes });
                });
            }, delay);
        };

        if (event_types.MESSAGE_UPDATED) eventSource.on(event_types.MESSAGE_UPDATED, (payload) => scheduleRenderedMessageCleanse(payload, 120));
        if (event_types.CHARACTER_MESSAGE_RENDERED) eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (payload) => scheduleRenderedMessageCleanse(payload, 180));
    }

    if (event_types.GENERATION_STARTED) eventSource.on(event_types.GENERATION_STARTED, (type, options, dryRun) => {
        const generationStart = classifyHostGenerationStart(type, options, dryRun);
        const { chat } = getAppContext();
        const tail = Array.isArray(chat) && chat.length > 0 ? chat[chat.length - 1] : null;
        const mvuTransaction = getMvuExtraModelTransaction();
        let mvuDuringExtraAnalysis = null;
        try {
            mvuDuringExtraAnalysis = Boolean(mvuTransaction.api?.isDuringExtraAnalysis?.());
        } catch (error) {
            recordAiRewriteRuntimeDebug('mvu-analysis-state-read-failed', {
                reason: error?.message || String(error || 'unknown'),
            }, 'warn');
        }
        const diagnostic = {
            mode: generationStart.mode,
            dryRun: dryRun === true,
            chatId: getCurrentChatIdentity(),
            chatLength: Array.isArray(chat) ? chat.length : null,
            tailRole: tail?.is_user === true ? 'user' : (tail ? 'assistant' : 'empty'),
            tailSwipeId: Number.isInteger(tail?.swipe_id) ? tail.swipe_id : null,
            tailSwipeCount: Array.isArray(tail?.swipes) ? tail.swipes.length : null,
            mvuExtraModelConfiguredFromHostSettings: mvuTransaction.enabled,
            mvuApiAvailable: Boolean(mvuTransaction.api),
            mvuDuringExtraAnalysis,
            automaticTrigger: options?.automatic_trigger === true,
        };
        if (!generationStart.track) {
            recordAiRewriteRuntimeDebug('generation-start-ignored', {
                ...diagnostic,
                reason: generationStart.reason,
            });
            return;
        }
        recordAiRewriteRuntimeDebug('generation-start-observed', diagnostic);
        const session = generationLifecycle.startGeneration({
            chatId: getCurrentChatIdentity(),
            chat,
            mode: generationStart.mode,
        });
        runtimeState.isStreamingGeneration = true;
        runtimeState.streamingCommittedMessageCache.clear();
        streamProcessorInstallFailureLogged = false;
        pendingMvuFinalPayload = null;
        activeMvuFinalPromise = null;
        activeMvuFinalGenerationId = '';
        completedMvuFinalGenerationId = '';
        handleAiRewriteGenerationStarted(session);
    });
    if (event_types.STREAM_TOKEN_RECEIVED) {
        const onStreamTokenReceived = () => {
            runtimeState.isStreamingGeneration = true;
            try {
                if (typeof installStreamingProcessorVisualMaskFromEvents === 'function') {
                    installStreamingProcessorVisualMaskFromEvents();
                }
            } catch (error) {
                if (!streamProcessorInstallFailureLogged) {
                    streamProcessorInstallFailureLogged = true;
                    recordAiRewriteRuntimeDebug('streaming-processor-install-failed', {
                        reason: error?.message || String(error || 'unknown'),
                    }, 'warn');
                }
            }
        };
        if (typeof eventSource.makeFirst === 'function') eventSource.makeFirst(event_types.STREAM_TOKEN_RECEIVED, onStreamTokenReceived);
        else eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamTokenReceived);
    }
    if (event_types.GENERATION_ENDED) eventSource.on(event_types.GENERATION_ENDED, (postOperationChatLength) => {
        runtimeState.isStreamingGeneration = false;
        recordAiRewriteRuntimeDebug('generation-ended-observed', {
            postOperationChatLength: Number.isInteger(postOperationChatLength) ? postOperationChatLength : null,
            generationId: generationLifecycle.getActive()?.generationId || '',
        });
    });
    if (event_types.GENERATION_STOPPED) eventSource.on(event_types.GENERATION_STOPPED, () => {
        runtimeState.isStreamingGeneration = false;
        recordAiRewriteRuntimeDebug('generation-stopped-observed', {
            generationId: generationLifecycle.getActive()?.generationId || '',
        });
    });
    if (event_types.MESSAGE_RECEIVED) eventSource.on(event_types.MESSAGE_RECEIVED, (messageId, hostGenerationType) => {
        const { chat } = getAppContext();
        const messageRef = Number.isInteger(messageId) && Array.isArray(chat) ? chat[messageId] : null;
        const streamingReceipt = generationLifecycle.consumeStreamingHostReceipt(messageId, messageRef);
        const activeSession = generationLifecycle.getActive();
        recordAiRewriteRuntimeDebug('message-received-observed', {
            messageId: Number.isInteger(messageId) ? messageId : null,
            hostGenerationType: String(hostGenerationType || ''),
            generationId: activeSession?.generationId || '',
            mode: activeSession?.mode || '',
            chatLength: Array.isArray(chat) ? chat.length : null,
        });
        return finalizeGenerationMessage(messageId, 'message-received', streamingReceipt?.generationId || '');
    });
    const mvuBeforeMessageUpdateEvent = getMvuExtraModelTransaction().beforeMessageUpdateEvent;
    eventSource.on(mvuBeforeMessageUpdateEvent, async (context) => {
        await runMvuFinalTransaction(context, 'mvu-before-message-update');
    });
    if (event_types.CHARACTER_MESSAGE_RENDERED) {
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
            if (!getMvuExtraModelTransaction().enabled) return;
            const index = Number.isInteger(messageId) && messageId >= 0 ? messageId : -1;
            const { chat } = getAppContext();
            const msg = Number.isInteger(index) && index >= 0 && Array.isArray(chat) ? chat[index] : null;
            if (!isAssistantMessage(msg) || !String(msg.mes || '').includes('<StatusPlaceHolderImpl/>')) return;
            if (activeMvuFinalPromise || completedMvuFinalGenerationId === generationLifecycle.getActive()?.generationId) return;
            await runMvuFinalTransaction(null, 'mvu-character-message-rendered');
        });
    }
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, (messageId) => {
        const index = Number.isInteger(messageId) && messageId >= 0 ? messageId : -1;
        if (index < 0) return;
        const { chat } = getAppContext();
        const msg = Array.isArray(chat) ? chat[index] : null;
        const activeSession = generationLifecycle.getActive();
        const isGenerationTarget = activeSession?.messageRef === msg;
        if (isGenerationTarget || isLiveAiRewriteTargetMessage(msg)) {
            cancelAutomaticGeneration('target-message-swiped');
        } else if (activeSession) {
            recordAiRewriteRuntimeDebug('message-swipe-ignored', {
                generationId: activeSession.generationId,
                index,
                reason: activeSession.messageRef ? 'other-message-swiped' : 'generation-target-not-bound',
            });
        }
        runtimeState.streamingCommittedMessageCache.delete(index);

        const hasMaterializedSwipe = getMessageSwipeIndex(msg) >= 0;
        if (hasMaterializedSwipe) runFinalStreamingCleanse(index, { clearRawSource: true });
    });
    if (event_types.MESSAGE_SWIPE_DELETED) eventSource.on(event_types.MESSAGE_SWIPE_DELETED, (payload) => {
        const messageId = Number.isInteger(payload?.messageId) && payload.messageId >= 0 ? payload.messageId : -1;
        const deletedSwipeIndex = Number.isInteger(payload?.swipeId) && payload.swipeId >= 0 ? payload.swipeId : -1;
        const { chat } = getAppContext();
        const msg = Number.isInteger(messageId) && messageId >= 0 && Array.isArray(chat) ? chat[messageId] : null;
        if (!msg || !Number.isInteger(deletedSwipeIndex) || deletedSwipeIndex < 0) return;

        const activeBranchKey = getActiveAiRewriteBranchKeyForMessage(msg);
        const branchMatch = /^swipe:(\d+)$/.exec(activeBranchKey);
        const activeBranchIndex = branchMatch ? Number(branchMatch[1]) : -1;
        const invalidatesActiveBranch = activeBranchIndex >= 0 && deletedSwipeIndex <= activeBranchIndex;
        if (invalidatesActiveBranch) cancelAutomaticGeneration('target-swipe-structure-changed');
    });
    if (event_types.MESSAGE_DELETED) eventSource.on(event_types.MESSAGE_DELETED, (postDeleteChatLength) => {
        const { chat } = getAppContext();
        const activeSession = generationLifecycle.getActive();
        const boundMessageRef = activeSession?.messageRef || null;
        const reconciliation = generationLifecycle.reconcileMessageDeletion({
            chatId: getCurrentChatIdentity(),
            chat,
        });

        const invalidAiRewriteTarget = hasInvalidAiRewriteTarget(chat);
        recordAiRewriteRuntimeDebug('message-deleted-observed', {
            postDeleteChatLength: Number.isInteger(postDeleteChatLength) ? postDeleteChatLength : null,
            chatId: getCurrentChatIdentity(),
            chatLength: Array.isArray(chat) ? chat.length : null,
            generationId: activeSession?.generationId || '',
            mode: activeSession?.mode || '',
            targetBound: Boolean(boundMessageRef),
            messageId: reconciliation.messageId,
            outcome: reconciliation.cancel || invalidAiRewriteTarget
                ? 'target-invalidated'
                : reconciliation.reason,
        });
        if (reconciliation.cancel || invalidAiRewriteTarget) {
            cancelAutomaticGeneration(reconciliation.cancel ? reconciliation.reason : 'target-message-structure-changed');
        }
    });
    if (event_types.PRESET_CHANGED) {
        eventSource.on(event_types.PRESET_CHANGED, (payload) => {
            if (payload && payload.apiId && payload.apiId !== 'openai') return;
            setTimeout(() => applyCharacterPresetBinding(true, { skipCleanse: true }), 0);
        });
    }
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            generationLifecycle.cancelActive('chat-changed');
            resetAiRewriteRuntimeState('chat-changed');
            pendingMvuFinalPayload = null;
            activeMvuFinalPromise = null;
            activeMvuFinalGenerationId = '';
            completedMvuFinalGenerationId = '';
            resetDiffRuntimeState();
            runtimeState.streamingCommittedMessageCache.clear();
            streamProcessorInstallFailureLogged = false;
            runtimeState.currentDiffIndex = undefined;
            $('#blai-diff-modal').hide();
            applyCharacterPresetBinding(true, { skipCleanse: true });
            restoreDiffStateFromChatMetadata();
            setTimeout(() => { injectDiffButtons(); performGlobalCleanse({ deferLargeChat: true }); }, 120);
        });
    }

    window.addEventListener('beforeunload', () => {
        generationLifecycle.cancelActive('page-unload');
        resetAiRewriteRuntimeState('page-unload');
    }, { once: true });

    setInterval(() => applyCharacterPresetBinding(false, { skipCleanse: true }), 1200);
}
