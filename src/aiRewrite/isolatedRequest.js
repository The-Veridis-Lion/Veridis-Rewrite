import { getSillyTavernContextSnapshot } from '../host/context.js';
import { getAppContext } from '../host/appContext.js';

export const aiRewriteProxyEndpoint = '/api/backends/chat-completions/generate';

export function hasRuleRouter() {
    if (globalThis.CultivationRuleRouter) return true;
    try {
        return Boolean(globalThis.parent?.CultivationRuleRouter);
    } catch {
        return false;
    }
}

export function buildAiRewriteProxyBody(requestConfig) {
    const api = requestConfig.custom_api;
    const body = {
        type: 'quiet',
        chat_completion_source: 'custom',
        custom_url: String(api.apiurl || '').trim().replace(/\/+$/, ''),
        custom_include_headers: JSON.stringify({ Authorization: `Bearer ${api.key || ''}` }),
        custom_include_body: JSON.stringify(api.custom_include_body || {}),
        stream: requestConfig.should_stream === true,
        n: 1,
        model: api.model,
        messages: requestConfig.ordered_prompts.map(({ role, content }) => ({ role, content })),
    };
    for (const [field, neutral] of Object.entries({
        temperature: 1, top_p: 1, top_k: 0, frequency_penalty: 0, presence_penalty: 0, max_tokens: null,
    })) {
        if (typeof api[field] === 'number' && api[field] !== neutral) body[field] = api[field];
    }
    if (api.custom_exclude_body?.length) {
        body.custom_exclude_body = JSON.stringify(api.custom_exclude_body);
        for (const field of ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty', 'max_tokens']) {
            if (api.custom_exclude_body.includes(field)) delete body[field];
        }
    }
    return body;
}

async function readStreamedRewrite(response, signal) {
    let reader;
    const cancel = () => { reader?.cancel().catch(() => {}); };
    try {
        const createStream = getAppContext().createEventSourceStream;
        if (typeof createStream !== 'function' || !response.body) throw new Error('当前宿主未提供流式解析器，请关闭“流式返回”后重试');
        const stream = await createStream();
        signal?.throwIfAborted();
        reader = response.body.pipeThrough(stream).getReader();
        signal?.addEventListener('abort', cancel, { once: true });
        let content = '', completed = false;
        while (true) {
            signal?.throwIfAborted();
            const { done, value } = await reader.read();
            signal?.throwIfAborted();
            if (done) break;
            const text = value.data.trim();
            if (text === '[DONE]') { completed = true; break; }
            if (!text) continue;
            if (value.type === 'error') throw new Error('AI 改写流式接口返回错误，请检查改写接口配置');
            let data;
            try { data = JSON.parse(text); }
            catch { throw new Error('AI 改写流式返回格式错误，未应用改写'); }
            if (data?.error) throw new Error('AI 改写流式接口返回错误，请检查改写接口配置');
            const choice = data?.choices?.find(item => (item.index ?? 0) === 0);
            if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
            if (choice?.finish_reason != null) completed = true;
        }
        if (!completed) throw new Error('AI 改写流式响应中断，未应用改写');
        if (!content.trim()) throw new Error('AI 改写代理返回空响应或不支持的响应格式');
        return content;
    } finally {
        signal?.removeEventListener('abort', cancel);
        if (reader) {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        } else if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
    }
}

export async function requestAiRewriteViaProxy(requestConfig, signal) {
    const context = getSillyTavernContextSnapshot();
    if (typeof context.getRequestHeaders !== 'function') {
        throw new Error('规则路由兼容改写需要酒馆 getRequestHeaders；已停止请求，避免触发正文生成');
    }
    // generateRaw emits a normal-generation event even when should_silence is true.
    const response = await fetch(aiRewriteProxyEndpoint, {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify(buildAiRewriteProxyBody(requestConfig)),
        signal,
    });
    if (!response.ok) {
        // Do not expose the response body: some proxies echo request credentials.
        const error = new Error(`AI 改写代理请求失败：HTTP ${response.status}`);
        error.status = response.status;
        throw error;
    }
    const contentType = response.headers?.get?.('content-type') || '';
    if (contentType.includes('text/event-stream') || (requestConfig.should_stream === true && !contentType.includes('application/json'))) {
        return readStreamedRewrite(response, signal);
    }
    const data = await response.json();
    if (data?.error) throw new Error('AI 改写代理返回错误，请检查改写接口配置');
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
        throw new Error('AI 改写代理返回空响应或不支持的响应格式');
    }
    return content;
}
