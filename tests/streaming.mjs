import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { initAppContext } from '../src/host/appContext.js';
import { buildAiRewriteGenerateRawConfig, requestAiRewrite } from '../src/aiRewrite/generation.js';
import { buildAiRewriteProxyBody, requestAiRewriteViaProxy } from '../src/aiRewrite/isolatedRequest.js';
import { snapshotAiRewriteTaskSettings } from '../src/aiRewrite/task.js';
import { executeDeepCleanAiRequests } from '../src/deepClean/aiProcessing.js';

// Use the host's actual parser, with its unrelated imports/smooth-output code excluded.
const source = readFileSync(process.env.VERIDIS_SSE_SOURCE || new URL('../../luker-2452d56/public/scripts/sse-stream.js', import.meta.url), 'utf8');
const EventSourceStream = new Function(source.slice(source.indexOf('class EventSourceStream'), source.indexOf('function getDelay')) + '; return EventSourceStream;')();
const settings = { enabled: true, streamingEnabled: true, baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-secret', model: 'fixture-model' };
const chunk = (content, extra = {}) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content }, ...extra }] }) + '\n\n';
const finish = chunk('', { finish_reason: 'stop' });
let previous, body, requests, parserLoads, cancelled;
beforeEach(() => {
    previous = { fetch: globalThis.fetch, router: globalThis.CultivationRuleRouter, helper: globalThis.TavernHelper };
    globalThis.CultivationRuleRouter = {};
    requests = 0; parserLoads = 0; cancelled = false;
    initAppContext({ createEventSourceStream: async () => { parserLoads++; return new EventSourceStream(); },
        getSillyTavernContext: () => ({ getRequestHeaders: () => ({ 'X-Test': 'fixture' }) }) });
});
afterEach(() => {
    globalThis.fetch = previous.fetch; globalThis.CultivationRuleRouter = previous.router; globalThis.TavernHelper = previous.helper;
});
function respond(text, { splitBytes = 7, keepOpen = false, contentType = 'text/event-stream' } = {}) {
    globalThis.fetch = async (_url, options) => {
        requests++; body = JSON.parse(options.body);
        const bytes = new TextEncoder().encode(text); let offset = 0;
        return new Response(new ReadableStream({
            pull(controller) {
                if (offset < bytes.length) { controller.enqueue(bytes.slice(offset, offset + splitBytes)); offset += splitBytes; }
                else if (!keepOpen) controller.close();
            }, cancel() { cancelled = true; },
        }), { headers: { 'Content-Type': contentType } });
    };
}
const request = signal => requestAiRewriteViaProxy(buildAiRewriteGenerateRawConfig('Neutral fixture', settings), signal);

test('default remains non-streaming and enabled flag reaches both transport configs', () => {
    assert.equal(buildAiRewriteGenerateRawConfig('P', {}).should_stream, false);
    const config = buildAiRewriteGenerateRawConfig('P', settings);
    assert.equal(config.should_stream, true); assert.equal(buildAiRewriteProxyBody(config).stream, true);
    assert.equal(buildAiRewriteProxyBody(config).chat_completion_source, 'custom');
});
test('native SSE buffers split UTF-8 and CRLF, ignores reasoning, usage and other choices', async () => {
    const text = ': heartbeat\n\n' + 'data: {"choices":[{"index":0,"delta":{"reasoning_content":"PRIVATE"}}]}\n\n'
        + chunk('{"hit-1":"中文') + 'data: {"choices":[{"index":1,"delta":{"content":"OTHER"}}]}\n\n'
        + chunk('结果"}') + 'data: {"choices":[],"usage":{"total_tokens":5}}\n\n' + finish + 'data: [DONE]\n\n';
    respond(text.replaceAll('\n', '\r\n'), { splitBytes: 1 });
    assert.equal(await request(), '{"hit-1":"中文结果"}'); assert.equal(body.stream, true); assert.equal(parserLoads, 1);
});
test('native SSE supports multiline data, named message events and DONE without finish_reason', async () => {
    respond('event: message\ndata: {"choices":\ndata: [{"delta":{"content":"{}"}}]}\n\n' + 'data: [DONE]\n\n');
    assert.equal(await request(), '{}');
});
test('finish_reason followed by EOF is accepted without DONE', async () => {
    respond(chunk('{}') + finish); assert.equal(await request(), '{}');
});
test('DONE stops and closes an otherwise open upstream stream', async () => {
    respond(chunk('{}') + 'data: [DONE]\n\n', { keepOpen: true });
    assert.equal(await request(), '{}'); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(cancelled, true);
});
test('an interface that returns regular JSON in streaming mode is supported', async () => {
    respond(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { contentType: 'application/json;charset=utf-8' });
    assert.equal(await request(), '{}'); assert.equal(parserLoads, 0);
});
for (const [name, text, match] of [
    ['interrupted before completion', chunk('{"hit-1":"unfinished'), /中断/],
    ['empty stream', 'data: [DONE]\n\n', /空响应/],
    ['reasoning only', 'data: {"choices":[{"delta":{"reasoning_content":"PRIVATE"}}]}\n\ndata: [DONE]\n\n', /空响应/],
    ['bad JSON', 'data: broken PRIVATE\n\n', /格式错误/],
    ['provider error', 'data: {"error":{"message":"fixture-secret"}}\n\n', /接口返回错误/],
    ['named error', 'event: error\ndata: fixture-secret\n\n', /接口返回错误/],
]) test(name + ' rejects without partial output or sensitive error text', async () => {
    respond(text);
    await assert.rejects(request(), error => { assert.match(error.message, match); assert.doesNotMatch(error.message, /PRIVATE|fixture-secret/); return true; });
});
test('abort during pending read cancels upstream and never returns partial text', async () => {
    respond(chunk('{'), { keepOpen: true });
    const controller = new AbortController();
    const pending = request(controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, { name: 'AbortError' });
    await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(cancelled, true);
});
test('missing host parser fails clearly and cancels unused response body', async () => {
    respond(chunk('{}') + finish); initAppContext({ createEventSourceStream: null });
    await assert.rejects(request(), /关闭“流式返回”/); assert.equal(cancelled, true);
});
test('non-streaming mode does not load the streaming parser', async () => {
    respond(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { contentType: 'application/json' });
    assert.equal(await requestAiRewriteViaProxy(buildAiRewriteGenerateRawConfig('P', { ...settings, streamingEnabled: false })), '{}');
    assert.equal(body.stream, false); assert.equal(parserLoads, 0);
});
test('conflicting stream parameters fail before any request', async () => {
    for (const additionalParameters of ['{"stream":false}', '{"stream":"true"}']) {
        await assert.rejects(requestAiRewrite('P', { ...settings, additionalParameters }), /开关一致/);
    }
    await assert.rejects(requestAiRewrite('P', { ...settings, excludedParameters: 'stream' }), /不能排除/);
    assert.equal(requests, 0);
});
test('matching stream parameter is passed along with the enabled flag', () => {
    const config = buildAiRewriteGenerateRawConfig('P', { ...settings, additionalParameters: '{"stream":true}' });
    assert.equal(config.should_stream, true); assert.equal(config.custom_api.custom_include_body.stream, true);
});
test('helper retains its native streaming API and returns one final string', async () => {
    delete globalThis.CultivationRuleRouter;
    let calls = 0;
    globalThis.TavernHelper = { generateRaw: async config => { calls++; assert.equal(config.should_stream, true); return '{}'; } };
    assert.equal(await requestAiRewrite('P', settings), '{}'); assert.equal(calls, 1); assert.equal(requests, 0);
});
test('automatic/manual snapshot freezes streaming independently of later UI edits', () => {
    const current = { ...settings }, frozen = snapshotAiRewriteTaskSettings({ rules: [] }, current);
    current.streamingEnabled = false;
    assert.equal(frozen.aiSettings.streamingEnabled, true);
});
test('helper streaming abort still stops only this rewrite generation', async () => {
    delete globalThis.CultivationRuleRouter;
    let resolve, startedId, stoppedId;
    globalThis.TavernHelper = {
        generateRaw: config => { startedId = config.generation_id; return new Promise(done => { resolve = done; }); },
        stopGenerationById: id => { stoppedId = id; resolve('{"hit-1":"partial"}'); },
    };
    const controller = new AbortController();
    const pending = requestAiRewrite('P', settings, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.match(stoppedId, /^veridis-ai-rewrite-/); assert.equal(stoppedId, startedId); assert.equal(requests, 0);
});
test('Deep Clean forwards its frozen streaming option to the same proxy path', async () => {
    respond(chunk('{}') + finish);
    const run = { input: { preset: { aiRewrite: {} }, aiConnection: settings, processingSemantics: {} },
        contentItems: [], programProposedResults: [], aiRequestPlan: { requests: [{ requestItems: [] }] } };
    await executeDeepCleanAiRequests(run); assert.equal(body.stream, true); assert.equal(parserLoads, 1);
});
