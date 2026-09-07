/** Owns TavernHelper config and single-request transport, abort-to-provider stop, and request errors; runtime owns orchestration, timeouts, retries, and task cancellation. */
import { normalizeAiSamplingSettings } from '../settings/defaults.js';
import { logger } from '../log.js';
import { recordAiRewriteDebug } from './debug.js';
import { recordAiCommunicationFailure, recordAiCommunicationSuccess, snapshotAiCommunicationRequest } from './communicationMonitor.js';

export function buildAiRewriteGenerateRawConfig(prompt, aiSettings = {}, generationId = '') {
    const sampling = normalizeAiSamplingSettings(aiSettings);
    const customIncludeBody = {
        response_format: { type: 'json_object' },
    };
    const customApi = {
        apiurl: String(aiSettings.baseUrl || '').trim(),
        key: String(aiSettings.apiKey || ''),
        model: String(aiSettings.model || '').trim(),
        source: 'custom',
        temperature: sampling.temperature,
        top_p: sampling.topP,
        top_k: sampling.topK,
        frequency_penalty: sampling.frequencyPenalty,
        presence_penalty: sampling.presencePenalty,
        max_tokens: sampling.maxTokens > 0 ? sampling.maxTokens : 'unset',
        custom_include_body: customIncludeBody,
    };

    if (sampling.repetitionPenalty !== 1) customIncludeBody.repetition_penalty = sampling.repetitionPenalty;

    return {
        generation_id: String(generationId || ''),
        ordered_prompts: [{ role: 'user', content: String(prompt ?? '') }],
        should_stream: false,
        custom_api: customApi,
    };
}

export function getTavernHelperGenerationApi() {
    const direct = globalThis?.TavernHelper;
    if (direct && typeof direct.generateRaw === 'function') return direct;
    try {
        const parentApi = globalThis?.parent?.TavernHelper;
        if (parentApi && typeof parentApi.generateRaw === 'function') return parentApi;
    } catch {
        // Cross-window access can fail outside the SillyTavern host.
    }
    return null;
}

export async function callTavernHelperGenerateRaw(requestConfig) {
    const tavernHelper = getTavernHelperGenerationApi();
    if (!tavernHelper) throw new Error('TavernHelper.generateRaw 不可用');
    return tavernHelper.generateRaw(requestConfig);
}

export class AiRewriteRequestFormatError extends Error {
    constructor(message, cause = null) {
        super(message);
        this.name = 'AiRewriteRequestFormatError';
        if (cause) this.cause = cause;
    }
}

export function isAiRewriteRequestFormatError(error) {
    return error instanceof AiRewriteRequestFormatError
        || error?.name === 'AiRewriteRequestFormatError';
}

export function isBadRequestError(error) {
    const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
    if (status === 400) return true;
    return /(?:bad request|http\s*400)/i.test(String(error?.message || ''));
}

export async function requestAiRewrite(prompt, aiSettings, signal, task = null) {
    const tavernHelper = getTavernHelperGenerationApi();
    if (!tavernHelper) throw new Error('TavernHelper.generateRaw 不可用');
    const requestStartedAt = Date.now();
    const helperGenerationId = task?.automatic === true
        ? `veridis-ai-rewrite-${task.generationId}-${requestStartedAt}`
        : `veridis-ai-rewrite-manual-${Number.isInteger(task?.index) ? task.index : 'message'}-${requestStartedAt}`;
    const requestConfig = buildAiRewriteGenerateRawConfig(prompt, aiSettings, helperGenerationId);
    const sampling = normalizeAiSamplingSettings(aiSettings);
    const startedAt = requestStartedAt;
    recordAiRewriteDebug('fetch-start', {
        endpoint: 'TavernHelper.generateRaw',
        helperGenerationId,
        model: aiSettings.model,
        apiSource: 'custom',
        responseFormat: 'json_object',
        sampling: {
            temperature: sampling.temperature,
            topP: sampling.topP,
            topK: sampling.topK,
            frequencyPenalty: sampling.frequencyPenalty,
            presencePenalty: sampling.presencePenalty,
            repetitionPenalty: sampling.repetitionPenalty,
            maxTokens: sampling.maxTokens,
        },
        promptLength: String(prompt || '').length,
        timeoutMs: aiSettings.timeoutMs,
        generationId: task?.generationId || '',
        chatId: task?.chatId || '',
        index: Number.isInteger(task?.index) ? task.index : null,
        source: task?.scheduleSource || '',
    });
    const stopGeneration = () => {
        try {
            tavernHelper.stopGenerationById?.(helperGenerationId);
        } catch (error) {
            logger.warn('停止酒馆助手自定义 API 改写请求失败', error);
        }
    };
    signal?.addEventListener?.('abort', stopGeneration, { once: true });
    try {
        const requestJson = snapshotAiCommunicationRequest(requestConfig);
        const communicationStartedAt = Date.now();
        let response;
        try {
            response = await callTavernHelperGenerateRaw(requestConfig);
        } catch (error) {
            recordAiCommunicationFailure({
                startedAt: communicationStartedAt,
                endedAt: Date.now(),
                requestJson,
                error,
            });
            throw error;
        }
        recordAiCommunicationSuccess({
            startedAt: communicationStartedAt,
            endedAt: Date.now(),
            requestJson,
            response,
        });
        if (signal?.aborted) {
            const abortError = new Error('请求已取消');
            abortError.name = 'AbortError';
            throw abortError;
        }
        const content = typeof response === 'string' ? response : String(response ?? '');
        if (!content) throw new Error('酒馆助手自定义 API 返回空响应');
        recordAiRewriteDebug('fetch-response', {
            endpoint: 'TavernHelper.generateRaw',
            ok: true,
            elapsedMs: Date.now() - startedAt,
            responseLength: content.length,
            generationId: task?.generationId || '',
            chatId: task?.chatId || '',
            index: Number.isInteger(task?.index) ? task.index : null,
        });
        recordAiRewriteDebug('response-content', {
            contentLength: content.length,
            transport: 'tavern-helper-custom-api',
        });
        return content;
    } finally {
        signal?.removeEventListener?.('abort', stopGeneration);
    }
}
