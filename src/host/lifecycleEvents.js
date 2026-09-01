/** Owns SillyTavern generation/message/chat lifecycle routing, MVU finalization routing, and composition of host lifecycle side effects. Actual Program, AI, Diff, DOM, and persistence semantics remain in their subsystem owners. */
import { getAppContext } from './appContext.js';
import { streamingRuntimeState } from './streamingState.js';
import { applyCharacterPresetBinding } from '../presets/application.js';
import {
    performGlobalChatMaintenance,
    performIncrementalCleanse,
    getMessageIndexFromEvent,
    getLatestMessageIndex,
} from '../chat/cleanse.js';
import { computeMessageSignature, diffRuntimeState, markDiffComparisonPending, refreshDiffCacheIfStale, resetDiffRuntimeState, restoreDiffStateFromChatMetadata } from '../diff/state.js';
import { isAssistantMessage } from '../diff/tracking.js';
import { buildDiffSnippetsFromText } from '../diff/compare.js';
import { getMessageSwipeIndex, setCurrentSwipeText } from '../chat/messageBranch.js';
import { writeMessageDiffManualFinal } from '../diff/messageMeta.js';
import { getCurrentChatIdentity } from './context.js';
import { getMvuExtraModelTransaction, shouldWaitForMvuExtraModelTransaction } from '../integrations/mvu.js';
import { adoptMvuMessageContentForAiRewrite, getActiveAiRewriteBranchKeyForMessage, handleAiRewriteGenerationStarted, hasInvalidAiRewriteTarget, isLiveAiRewriteTargetMessage, markAiRewriteFinalCleanseReady, recordAiRewriteRuntimeDebug, resetAiRewriteRuntimeState, validateAiRewriteMessageTarget, waitForAutomaticAiRewrite } from '../aiRewrite/index.js';
import { classifyHostGenerationStart, generationLifecycle } from './generationLifecycle.js';
import { bindStreamingHostEvents, injectDiffButtonsStreamingSafe, initStreamingVisualReplay, resetStreamingProcessorInstallFailureState } from './streaming.js';
import { initDomObserver, initPersonaProtectionObserver } from '../dom/observer.js';
import { clearPendingShujukuRewrite, markLatestMessageShujukuRewritePending } from '../shujuku/realtime.js';

export function initRealtimeInterceptor() {
    generationLifecycle.configure({
        getCurrentChatId: getCurrentChatIdentity,
        getCurrentChat: () => getAppContext().chat,
        onLog: (stage, details) => recordAiRewriteRuntimeDebug(stage, details),
    });
    initPersonaProtectionObserver();
    initStreamingVisualReplay();
    initDomObserver({
        injectDiffButtons: injectDiffButtonsStreamingSafe,
    });
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

    const buildCurrentRuleDifference = (sourceMes) => {
        if (typeof sourceMes !== 'string' || !sourceMes) return null;
        const result = buildDiffSnippetsFromText(sourceMes);
        if (typeof result.cleanedText !== 'string' || result.cleanedText === sourceMes) return null;
        return { sourceMes, result };
    };

    const resolveMessageIndexForCleansePayload = (payload) => {
        return getMessageIndexFromEvent(payload);
    };

    const resolveFinalCleanseSourceForPayload = (payload) => {
        const { chat } = getAppContext();
        const index = resolveMessageIndexForCleansePayload(payload);
        if (index < 0 || !Array.isArray(chat) || !isAssistantMessage(chat[index])) return { index: -1, sourceMes: undefined };

        const finalMes = typeof chat[index]?.mes === 'string' ? chat[index].mes : '';
        const finalDiff = buildCurrentRuleDifference(finalMes);
        if (finalDiff) return { index, sourceMes: finalMes, precomputedDiff: finalDiff };

        const streamingCommittedMes = streamingRuntimeState.streamingCommittedMessageCache.get(index);
        if (typeof streamingCommittedMes === 'string' && streamingCommittedMes !== finalMes) {
            const streamingCommittedDiff = buildCurrentRuleDifference(streamingCommittedMes);
            if (streamingCommittedDiff) {
                return { index, sourceMes: streamingCommittedMes, precomputedDiff: streamingCommittedDiff };
            }
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
        const { index, sourceMes, precomputedDiff } = resolveFinalCleanseSourceForPayload(payload);
        const cleanseResult = performIncrementalCleanse(payload, {
            visualOnly: false,
            diffSourceMes: sourceMes,
            precomputedDiff,
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
            streamingRuntimeState.streamingCommittedMessageCache.delete(index);
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
            streamingRuntimeState.isStreamingGeneration = false;
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

            streamingRuntimeState.streamingCommittedMessageCache.delete(stablePayload.messageId);
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
        streamingRuntimeState.isStreamingGeneration = false;

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

        markLatestMessageShujukuRewritePending(resolution.messageIndex, 'ai-finalization');
        streamingRuntimeState.streamingCommittedMessageCache.delete(resolution.messageIndex);
        recordAiRewriteRuntimeDebug('final-cleanse-deferred-to-ai', {
            generationId: resolution.generationId,
            index: resolution.messageIndex,
            phase: 'direct',
        });
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

            streamingRuntimeState.streamingCommittedMessageCache.delete(index);

            if (manualTraceChanged) {
                const signature = computeMessageSignature(msg);
                markDiffComparisonPending(index, signature, { skipPersist: true });
                refreshDiffCacheIfStale(index);
                injectDiffButtonsStreamingSafe([index]);
            }
        });
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
        streamingRuntimeState.isStreamingGeneration = true;
        streamingRuntimeState.streamingCommittedMessageCache.clear();
        resetStreamingProcessorInstallFailureState();
        pendingMvuFinalPayload = null;
        activeMvuFinalPromise = null;
        activeMvuFinalGenerationId = '';
        completedMvuFinalGenerationId = '';
        handleAiRewriteGenerationStarted(session);
    });
    bindStreamingHostEvents({
        eventSource,
        event_types,
        finalizeCommittedMessage: finalizeGenerationMessage,
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
        streamingRuntimeState.streamingCommittedMessageCache.delete(index);

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
            applyCharacterPresetBinding(true);
        });
    }
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            generationLifecycle.cancelActive('chat-changed');
            resetAiRewriteRuntimeState('chat-changed');
            clearPendingShujukuRewrite();
            pendingMvuFinalPayload = null;
            activeMvuFinalPromise = null;
            activeMvuFinalGenerationId = '';
            completedMvuFinalGenerationId = '';
            resetDiffRuntimeState();
            streamingRuntimeState.streamingCommittedMessageCache.clear();
            resetStreamingProcessorInstallFailureState();
            diffRuntimeState.currentDiffIndex = undefined;
            $('#blai-diff-modal').hide();
            applyCharacterPresetBinding(true);
            restoreDiffStateFromChatMetadata();
            performGlobalChatMaintenance();
        });
    }

    window.addEventListener('beforeunload', () => {
        generationLifecycle.cancelActive('page-unload');
        resetAiRewriteRuntimeState('page-unload');
    }, { once: true });

}
