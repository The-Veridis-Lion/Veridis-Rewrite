import { normalizeAiSamplingSettings } from './state.js';

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
