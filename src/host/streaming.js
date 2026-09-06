/** Runs Program once after each host-committed Original frame and publishes the generation's latest pair. Final mutation belongs to cleanse/AI apply. */
import { getAppContext } from './appContext.js';
import { streamingRuntimeState } from './streamingState.js';
import { renderStreamingProgram } from '../dom/streaming.js';
import { applyStreamingProgram } from '../rules/engine.js';
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

function installStreamingProcessorProgram(finalizeCommittedMessage) {
    const processor = getCurrentStreamingProcessor();
    if (!processor || typeof processor.onProgressStreaming !== 'function') return false;
    if (processor.__blai_streaming_program) return true;

    const originalOnProgress = processor.onProgressStreaming;
    const originalFinalizeIntermediaryMessage = processor.finalizeIntermediaryMessage;
    const originalOnError = processor.onErrorStreaming;
    const originalMarkUIGenStopped = processor.markUIGenStopped;
    const processorSession = generationLifecycle.getActive();
    const processorGenerationId = processorSession?.generationId || '';
    const processorChatId = processorSession?.chatId || '';
    processor.__blai_streaming_program = true;
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

        const result = await originalOnProgress.call(this, messageId, rawText, isFinal);
        if (this.type !== 'impersonate' && numericMessageId >= 0) {
            const { chat } = getAppContext();
            const committedMessage = Array.isArray(chat) ? chat[numericMessageId] : null;
            const committedText = typeof committedMessage?.mes === 'string'
                ? committedMessage.mes
                : '';
            const resolution = generationLifecycle.bindMessage(numericMessageId, {
                generationId: processorGenerationId, chatId: processorChatId, chat, source: 'streaming-committed',
            });
            if (!resolution.ok) return result;
            const programText = applyStreamingProgram(committedText, processorSession.streamingChoices);
            processorSession.streamingFrame = { originalText: committedText, programText };
            if (isFinal === true) processorSession.streamingChoices.length = 0;
            renderStreamingProgram(numericMessageId, programText);
            if (programText !== committedText) markStreamingMessagePending(numericMessageId);
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
        return result;
    };
    return true;
}

export function handleStreamingToken(finalizeCommittedMessage) {
    try {
        installStreamingProcessorProgram(finalizeCommittedMessage);
    } catch (error) {
        if (!streamProcessorInstallFailureLogged) {
            streamProcessorInstallFailureLogged = true;
            recordAiRewriteRuntimeDebug('streaming-processor-install-failed', {
                reason: error?.message || String(error || 'unknown'),
            }, 'warn');
        }
    }
}
