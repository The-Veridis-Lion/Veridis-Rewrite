/** Owns integration with SillyTavern's streaming processor and streaming-specific presentation lifecycle. It does not own final message cleanse or AI finalization. */
import { getAppContext } from './appContext.js';
import { streamingRuntimeState } from './streamingState.js';
import { renderStreamingVisualMask, replayStreamingVisualMask } from '../dom/streaming.js';
import { computeMessageSignature, markDiffComparisonPending } from '../diff/state.js';
import { isAssistantMessage } from '../diff/tracking.js';
import { injectDiffButtons } from '../diff/view.js';
import { generationLifecycle } from './generationLifecycle.js';
import { maybeNotifyAiRewriteReadyFromStreamingText, recordAiRewriteRuntimeDebug } from '../aiRewrite/index.js';

let streamingDiffInjectTimer = null;
let streamingPendingDiffIndices = [];
let streamProcessorInstallFailureLogged = false;

export function injectDiffButtonsStreamingSafe(indices = []) {
    if (streamingRuntimeState.isStreamingGeneration) {
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

export function resetStreamingProcessorInstallFailureState() {
    streamProcessorInstallFailureLogged = false;
}

export function initStreamingVisualReplay() {
    window.addEventListener('blai:realtime-beauty-frame', (event) => {
        if (streamingRuntimeState.isStreamingGeneration !== true) return;
        replayStreamingVisualMask(event?.detail?.messageIndex);
    });
}

function getCurrentStreamingProcessor() {
    const getter = getAppContext().getStreamingProcessor;
    return typeof getter === 'function' ? getter() : null;
}

function markStreamingMessagePending(messageId) {
    const { chat } = getAppContext();
    const index = Number.isInteger(messageId) && messageId >= 0 ? messageId : -1;
    if (!Number.isInteger(index) || index < 0 || !Array.isArray(chat) || !isAssistantMessage(chat[index])) return;
    markDiffComparisonPending(index, computeMessageSignature(chat[index]), { skipPersist: true });
    injectDiffButtonsStreamingSafe([index]);
}

function installStreamingProcessorVisualMask(finalizeCommittedMessage) {
    const processor = getCurrentStreamingProcessor();
    if (!processor || typeof processor.onProgressStreaming !== 'function') return false;
    if (processor.__blai_streaming_visual_mask) return true;

    const originalOnProgress = processor.onProgressStreaming;
    const originalFinalizeIntermediaryMessage = processor.finalizeIntermediaryMessage;
    const originalOnError = processor.onErrorStreaming;
    const originalMarkUIGenStopped = processor.markUIGenStopped;
    const processorSession = generationLifecycle.getActive();
    const processorGenerationId = processorSession?.generationId || '';
    const processorChatId = processorSession?.chatId || '';
    processor.__blai_streaming_visual_mask = true;
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
            streamingRuntimeState.streamingCommittedMessageCache.set(numericMessageId, committedText);
            changed = renderStreamingVisualMask(numericMessageId, committedText);
            if (committedText) {
                maybeNotifyAiRewriteReadyFromStreamingText(numericMessageId, committedText, {
                    generationId: processorGenerationId,
                    chatId: processorChatId,
                    source: 'streaming-committed',
                    hostCommitted: true,
                });
            }
            if (isFinal === true && typeof finalizeCommittedMessage === 'function') {
                await finalizeCommittedMessage(numericMessageId, 'streaming-committed-final', processorGenerationId);
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
}

export function bindStreamingHostEvents({ eventSource, event_types, finalizeCommittedMessage }) {
    if (event_types.STREAM_TOKEN_RECEIVED) {
        const onStreamTokenReceived = () => {
            streamingRuntimeState.isStreamingGeneration = true;
            try {
                installStreamingProcessorVisualMask(finalizeCommittedMessage);
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
}
