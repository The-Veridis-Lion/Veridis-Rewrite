/** Owns SillyTavern generation/message/chat lifecycle routing and composition of host lifecycle side effects. Actual Program, AI, Diff, DOM, and persistence semantics remain in their subsystem owners. */
import { getAppContext } from './appContext.js';
import { streamingRuntimeState } from './streamingState.js';
import { applyCharacterPresetBinding } from '../presets/application.js';
import {
    performGlobalChatMaintenance,
    performIncrementalCleanse,
    getMessageIndexFromEvent,
} from '../chat/cleanse.js';
import { computeMessageSignature, diffRuntimeState, markDiffComparisonPending, refreshDiffCacheIfStale, resetDiffRuntimeState, restoreDiffStateFromChatMetadata } from '../diff/state.js';
import { isAssistantMessage } from '../diff/tracking.js';
import { getMessageSwipeIndex, setCurrentSwipeText } from '../chat/messageBranch.js';
import { clearMessageDiffMeta, writeMessageDiffManualFinal } from '../diff/messageMeta.js';
import { getCurrentCharacterContext, getCurrentChatIdentity } from './context.js';
import { getMvuIntegrationSignal } from '../integrations/mvu.js';
import { getActiveAiRewriteBranchKeyForMessage, handleAiRewriteGenerationStarted, hasInvalidAiRewriteTarget, isLiveAiRewriteTargetMessage, markAiRewriteFinalCleanseReady, recordAiRewriteRuntimeDebug, resetAiRewriteRuntimeState, validateAiRewriteMessageTarget } from '../aiRewrite/index.js';
import { classifyHostGenerationStart, generationLifecycle } from './generationLifecycle.js';
import { handleStreamingToken, injectDiffButtonsStreamingSafe, resetStreamingProcessorInstallFailureState } from './streaming.js';
import { initDomObserver, initPersonaProtectionObserver } from '../dom/observer.js';
import { clearPendingShujukuRewrite, markLatestMessageShujukuRewritePending } from '../shujuku/realtime.js';

export function initRealtimeInterceptor() {
    generationLifecycle.configure({
        getCurrentChatId: getCurrentChatIdentity,
        getCurrentChat: () => getAppContext().chat,
        onLog: (stage, details) => recordAiRewriteRuntimeDebug(stage, details),
    });
    initPersonaProtectionObserver();
    initDomObserver({
        injectDiffButtons: injectDiffButtonsStreamingSafe,
    });
}


export function bindHostLifecycleEvents() {
    const { eventSource, event_types } = getAppContext();
    let messageReceivedHasMvuPriority = false;
    let currentCharacter = getCurrentCharacterContext();
    const updateMessageReceivedOrder = () => {
        if (!event_types.MESSAGE_RECEIVED) return;
        const needsMvuPriority = getMvuIntegrationSignal() === 'detected';
        if (needsMvuPriority === messageReceivedHasMvuPriority) return;
        if (needsMvuPriority) eventSource.makeFirst(event_types.MESSAGE_RECEIVED, onMessageReceived);
        else eventSource.makeLast(event_types.MESSAGE_RECEIVED, onMessageReceived);
        messageReceivedHasMvuPriority = needsMvuPriority;
    };
    const markPendingFromPayload = (payload) => {
        const { chat } = getAppContext();
        const index = getMessageIndexFromEvent(payload);
        if (index < 0 || !Array.isArray(chat) || !isAssistantMessage(chat[index])) return;
        markDiffComparisonPending(index, computeMessageSignature(chat[index]));
        injectDiffButtonsStreamingSafe([index]);
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
        const index = getMessageIndexFromEvent(payload);
        const session = generationLifecycle.getSession(String(payload?.generationId || ''));
        const frame = session?.messageId === index ? session.streamingFrame : null;
        const currentText = getAppContext().chat?.[index]?.mes;
        const cleanseResult = performIncrementalCleanse(payload, {
            visualOnly: false,
            diffSourceMes: currentText,
            streamingFrame: frame,
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
        if (options.acknowledgeGenerationId) generationLifecycle.clearStreamingProgram(options.acknowledgeGenerationId);
        return cleanseResult;
    };

    const finalizeGenerationMessage = (messageId, source, generationId = '') => {
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
        // Host continuation may reuse a branch; its new Original supersedes prior stages.
        clearMessageDiffMeta(resolution.message);
        const stablePayload = {
            automatic: true,
            generationId: resolution.generationId,
            chatId: resolution.chatId,
            messageId: resolution.messageIndex,
            source,
        };
        markPendingFromPayload(stablePayload);
        const aiOwnsFinalCommit = markAiRewriteFinalCleanseReady(stablePayload);
        if (!aiOwnsFinalCommit) {
            runFinalStreamingCleanse(stablePayload, {
                acknowledgeGenerationId: resolution.generationId,
                acknowledgementSource: 'direct-final-cleanse',
            });
            return;
        }

        markLatestMessageShujukuRewritePending(resolution.messageIndex, 'ai-finalization');
        recordAiRewriteRuntimeDebug('final-cleanse-deferred-to-ai', {
            generationId: resolution.generationId,
            index: resolution.messageIndex,
            phase: 'direct',
        });
    };
    const cancelAutomaticGeneration = (reason) => {
        generationLifecycle.cancelActive(reason);
        resetAiRewriteRuntimeState(reason);
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
            const hasRetainedDiff = writeMessageDiffManualFinal(msg);

            const session = generationLifecycle.getActive();
            if (session?.messageId === index) generationLifecycle.clearStreamingProgram(session.generationId);

            if (hasRetainedDiff) {
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
        const diagnostic = {
            mode: generationStart.mode,
            dryRun: dryRun === true,
            chatId: getCurrentChatIdentity(),
            chatLength: Array.isArray(chat) ? chat.length : null,
            tailRole: tail?.is_user === true ? 'user' : (tail ? 'assistant' : 'empty'),
            tailSwipeId: Number.isInteger(tail?.swipe_id) ? tail.swipe_id : null,
            tailSwipeCount: Array.isArray(tail?.swipes) ? tail.swipes.length : null,
            automaticTrigger: options?.automatic_trigger === true,
        };
        if (!generationStart.track) {
            recordAiRewriteRuntimeDebug('generation-start-ignored', {
                ...diagnostic,
                reason: generationStart.reason,
            });
            return;
        }
        // Character scripts may activate reactively; move the listener only on a priority transition.
        updateMessageReceivedOrder();
        recordAiRewriteRuntimeDebug('generation-start-observed', diagnostic);
        const session = generationLifecycle.startGeneration({
            chatId: getCurrentChatIdentity(),
            chat,
            mode: generationStart.mode,
        });
        streamingRuntimeState.isStreamingGeneration = true;
        resetStreamingProcessorInstallFailureState();
        handleAiRewriteGenerationStarted(session);
    });
    if (event_types.STREAM_TOKEN_RECEIVED) {
        const onStreamTokenReceived = () => {
            // A start excluded from automatic tracking can still produce host stream tokens.
            streamingRuntimeState.isStreamingGeneration = true;
            handleStreamingToken(finalizeGenerationMessage);
        };
        if (typeof eventSource.makeFirst === 'function') eventSource.makeFirst(event_types.STREAM_TOKEN_RECEIVED, onStreamTokenReceived);
        else eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamTokenReceived);
    }
    if (event_types.GENERATION_ENDED) eventSource.on(event_types.GENERATION_ENDED, (postOperationChatLength) => {
        streamingRuntimeState.isStreamingGeneration = false;
        recordAiRewriteRuntimeDebug('generation-ended-observed', {
            postOperationChatLength: Number.isInteger(postOperationChatLength) ? postOperationChatLength : null,
            generationId: generationLifecycle.getActive()?.generationId || '',
        });
    });
    if (event_types.GENERATION_STOPPED) eventSource.on(event_types.GENERATION_STOPPED, () => {
        streamingRuntimeState.isStreamingGeneration = false;
        recordAiRewriteRuntimeDebug('generation-stopped-observed', {
            generationId: generationLifecycle.getActive()?.generationId || '',
        });
    });
    const onMessageReceived = (messageId, hostGenerationType) => {
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
        finalizeGenerationMessage(messageId, 'message-received', streamingReceipt?.generationId || '');
    };
    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
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

        const hasMaterializedSwipe = getMessageSwipeIndex(msg) >= 0;
        if (hasMaterializedSwipe) runFinalStreamingCleanse(index);
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
            const nextCharacter = getCurrentCharacterContext();
            if (nextCharacter.key !== currentCharacter.key || nextCharacter.name !== currentCharacter.name) {
                currentCharacter = nextCharacter;
                updateMessageReceivedOrder();
            }
            generationLifecycle.cancelActive('chat-changed');
            resetAiRewriteRuntimeState('chat-changed');
            clearPendingShujukuRewrite();
            resetDiffRuntimeState();
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
