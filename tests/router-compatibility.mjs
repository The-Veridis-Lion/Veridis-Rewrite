import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { test, beforeEach } from 'node:test';
import { initAppContext } from '../src/host/appContext.js';
import { buildAiRewriteGenerateRawConfig, callTavernHelperGenerateRaw, requestAiRewrite, getAiRewriteTransport } from '../src/aiRewrite/generation.js';
import { buildAiRewriteProxyBody, hasRuleRouter } from '../src/aiRewrite/isolatedRequest.js';
import { getAiConfigIssue } from '../src/aiRewrite/task.js';
import { clearAiCommunicationRecords, getAiCommunicationRecords, formatAiCommunicationRecords, snapshotAiCommunicationRequest } from '../src/aiRewrite/communicationMonitor.js';
import { executeDeepCleanAiRequests } from '../src/deepClean/aiProcessing.js';

// Run the downloaded router's real generation handler, without its UI or network.
const routerSource = readFileSync(process.env.RULE_ROUTER_SOURCE
    || new URL('../../cultivation-rule-router/index.js', import.meta.url), 'utf8');
const routerSettings = { enabled: true, extraApiMode: 'off', manualMode: false,
    api: { url: 'https://router.invalid', key: 'fixture-router-key', model: 'router-model' }, filters: {} };
const counters = { helper: 0, flash: 0, hostButtons: 0, hostStops: 0, proxy: 0 };
const host = {
    extensionSettings: { cultivation_rule_router: routerSettings },
    chat: [{ is_user: false, mes: 'Existing assistant message.' }],
    eventSource: new EventEmitter(), eventTypes: { GENERATION_STOPPED: 'stop' },
    deactivateSendButtons() { counters.hostButtons++; },
    stopGeneration() { counters.hostStops++; },
    getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture-csrf' }),
};
const router = vm.createContext({
    window: {}, console: { log() {}, warn() {}, error() {} },
    setInterval() {}, setTimeout() {}, clearTimeout() {}, AbortController,
    document: { querySelector: () => ({ value: 'Unsent draft must survive.' }) },
    fixtureHost: host,
    fixtureFlash() { counters.flash++; return []; },
});
vm.runInContext(`${routerSource}\nctx = fixtureHost;
gatherCandidates = async () => ({ candidates: [{ comment: 'fixture' }], byBook: {} });
callFlashRouter = async () => fixtureFlash();
applyRouting = () => ({ statLine: 'fixture' });
setRouteVars = () => {}; clearToast = () => {};
toast = () => ({ info() {}, success() {}, error() {}, warning() {} });
globalThis.beforeGeneration = onBeforeGeneration;`, router);
const helper = {
    async generateRaw() {
        counters.helper++;
        await router.beforeGeneration('normal', {}, false);
        return '{"hit-1":"Rewritten."}';
    },
};
const defaultFetch = async (_url, _options) => {
    counters.proxy++;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"hit-1":"Rewritten."}' } }] }) };
};
const aiSettings = { enabled: true, baseUrl: 'https://rewrite.invalid/v1/', apiKey: 'fixture-key', model: 'rewrite-model' };
const requestConfig = () => buildAiRewriteGenerateRawConfig('Rewrite only this sentence.', aiSettings, 'fixture-rewrite');

beforeEach(() => {
    for (const key of Object.keys(counters)) counters[key] = 0;
    routerSettings.extraApiMode = 'off';
    globalThis.CultivationRuleRouter = router.window.CultivationRuleRouter;
    globalThis.TavernHelper = helper;
    delete globalThis.parent;
    delete globalThis.__TAURITAVERN__;
    delete globalThis.__TAURITAVERN_MAIN_READY__;
    delete globalThis.__TAURI_RUNNING__;
    globalThis.fetch = defaultFetch;
    globalThis.document = { getElementById() {} };
    initAppContext({ getSillyTavernContext: () => host });
    clearAiCommunicationRecords();
});

test('rewrite with default router settings never enters normal generation', async () => {
    const originalChat = structuredClone(host.chat);
    const config = buildAiRewriteGenerateRawConfig('Rewrite only this sentence.', {
        baseUrl: 'https://rewrite.invalid/v1/', apiKey: 'fixture-key', model: 'rewrite-model',
    }, 'fixture-rewrite');
    assert.equal(await callTavernHelperGenerateRaw(config), '{"hit-1":"Rewritten."}');
    assert.equal(counters.helper, 0, 'helper emits a normal generation event even for silent calls');
    assert.equal(counters.flash, 0, 'no routing call for background rewrite');
    assert.equal(counters.hostButtons, 0, 'no takeover of normal generation buttons');
    assert.equal(counters.hostStops, 0);
    assert.equal(counters.proxy, 1);
    assert.deepEqual(host.chat, originalChat);
});

test('a genuine chat generation still routes while a rewrite is in flight', async () => {
    let resolveResponse;
    globalThis.fetch = () => new Promise(resolve => { resolveResponse = resolve; });
    const rewrite = callTavernHelperGenerateRaw(requestConfig());
    await router.beforeGeneration('normal', {}, false);
    assert.equal(counters.flash, 1);
    assert.equal(counters.hostButtons, 1);
    resolveResponse(await defaultFetch());
    await rewrite;
    assert.equal(counters.flash, 1);
    assert.equal(counters.helper, 0);
});

test('router off/skip/reuse policies all use the isolated rewrite transport without changing settings', async () => {
    for (const mode of ['off', 'skip', 'reuse']) {
        routerSettings.extraApiMode = mode;
        await callTavernHelperGenerateRaw(requestConfig());
        assert.equal(routerSettings.extraApiMode, mode);
    }
    assert.equal(counters.proxy, 3);
    assert.equal(counters.flash, 0);
    assert.equal(counters.helper, 0);
});

test('without the router the original TavernHelper path remains available', async () => {
    delete globalThis.CultivationRuleRouter;
    assert.equal(getAiRewriteTransport(), 'tavern-helper-custom-api');
    await callTavernHelperGenerateRaw(requestConfig());
    assert.equal(counters.helper, 1);
    assert.equal(counters.proxy, 0);
    assert.equal(counters.flash, 1);
});

test('same-origin parent detection works and inaccessible parent access is harmless', () => {
    delete globalThis.CultivationRuleRouter;
    globalThis.parent = { CultivationRuleRouter: {} };
    assert.equal(hasRuleRouter(), true);
    Object.defineProperty(globalThis, 'parent', { configurable: true, get() { throw Error('Cross-origin'); } });
    assert.equal(hasRuleRouter(), false);
});

test('only rewrite settings, messages, JSON mode and non-neutral sampling reach the proxy', async () => {
    const config = buildAiRewriteGenerateRawConfig('An exact prompt with\nline breaks.', {
        ...aiSettings, temperature: 0.8, topP: 0.9, topK: 32, maxTokens: 1234,
        frequencyPenalty: 0.1, presencePenalty: 0.2, repetitionPenalty: 1.1,
    });
    globalThis.fetch = async (url, options) => {
        assert.equal(url, '/api/backends/chat-completions/generate');
        assert.equal(options.method, 'POST');
        assert.equal(options.headers['X-CSRF-Token'], 'fixture-csrf');
        const body = JSON.parse(options.body);
        assert.equal(body.custom_url, 'https://rewrite.invalid/v1');
        assert.equal(body.model, 'rewrite-model');
        assert.equal(body.stream, false);
        assert.equal(body.n, 1);
        assert.equal(body.max_tokens, 1234);
        assert.equal(body.temperature, 0.8);
        assert.equal(body.top_p, 0.9);
        assert.equal(body.top_k, 32);
        assert.equal(body.frequency_penalty, 0.1);
        assert.equal(body.presence_penalty, 0.2);
        assert.deepEqual(body.messages, config.ordered_prompts);
        assert.deepEqual(JSON.parse(body.custom_include_headers), { Authorization: 'Bearer fixture-key' });
        assert.deepEqual(JSON.parse(body.custom_include_body), { response_format: { type: 'json_object' }, repetition_penalty: 1.1 });
        return defaultFetch();
    };
    await callTavernHelperGenerateRaw(config);
    const neutral = buildAiRewriteProxyBody(buildAiRewriteGenerateRawConfig('', { ...aiSettings,
        temperature: 1, topP: 1, topK: 0, frequencyPenalty: 0, presencePenalty: 0, maxTokens: 0 }));
    for (const key of ['max_tokens', 'temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty']) {
        assert.equal(Object.hasOwn(neutral, key), false, `${key} matches the helper's unset semantics`);
    }
});

test('missing proxy capability fails without falling back to normal generation', async () => {
    initAppContext({ getSillyTavernContext: () => ({}) });
    await assert.rejects(callTavernHelperGenerateRaw(requestConfig()), /getRequestHeaders/);
    assert.equal(counters.helper, 0);
    assert.equal(counters.proxy, 0);
});

test('HTTP errors preserve status, do not leak credentials, and never fall back', async () => {
    for (const status of [400, 401, 429, 503]) {
        globalThis.fetch = async () => ({ ok: false, status, text: async () => 'fixture-key' });
        await assert.rejects(callTavernHelperGenerateRaw(requestConfig()), error =>
            error.status === status && !error.message.includes('fixture-key'));
    }
    assert.equal(counters.helper, 0);
});

test('empty, provider-error, invalid JSON and network failures never start normal generation', async () => {
    for (const data of [{ error: true }, {}, { choices: [{ message: { content: '' } }] }]) {
        globalThis.fetch = async () => ({ ok: true, json: async () => data });
        await assert.rejects(callTavernHelperGenerateRaw(requestConfig()));
    }
    globalThis.fetch = async () => ({ ok: true, json: async () => { throw SyntaxError('fixture invalid JSON'); } });
    await assert.rejects(callTavernHelperGenerateRaw(requestConfig()), SyntaxError);
    globalThis.fetch = async () => { throw TypeError('fixture network error'); };
    await assert.rejects(callTavernHelperGenerateRaw(requestConfig()), /fixture network error/);
    assert.equal(counters.helper, 0);
    assert.equal(counters.flash, 0);
});

test('manual and automatic request orchestration use the proxy and redact communication logs', async () => {
    delete globalThis.TavernHelper;
    assert.equal(getAiConfigIssue(aiSettings), null);
    for (const automatic of [false, true]) {
        const controller = new AbortController();
        assert.equal(await requestAiRewrite('Prompt.', aiSettings, controller.signal, {
            automatic, generationId: 'fixture-main-generation', index: 3,
        }), '{"hit-1":"Rewritten."}');
    }
    assert.equal(counters.proxy, 2);
    assert.equal(counters.flash, 0);
    const records = getAiCommunicationRecords();
    assert.equal(records.length, 2);
    assert.equal(records[0].endpoint, '/api/backends/chat-completions/generate');
    assert.equal(formatAiCommunicationRecords().includes('fixture-key'), false);
    assert.equal(formatAiCommunicationRecords().includes('TavernHelper.generateRaw'), false);
    assert.equal(snapshotAiCommunicationRequest(requestConfig()).includes('fixture-key'), false);
});

test('cancellation aborts only the rewrite request and leaves main generation running', async () => {
    const controller = new AbortController();
    let receivedSignal;
    globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
        receivedSignal = signal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const rewrite = requestAiRewrite('Prompt.', aiSettings, controller.signal);
    const rejection = assert.rejects(rewrite, { name: 'AbortError' });
    controller.abort();
    await rejection;
    assert.equal(receivedSignal.aborted, true);
    assert.equal(counters.hostStops, 0);
    assert.equal(counters.flash, 0);
    const preCancelled = new AbortController();
    preCancelled.abort();
    globalThis.fetch = defaultFetch;
    await assert.rejects(callTavernHelperGenerateRaw(requestConfig(), preCancelled.signal), { name: 'AbortError' });
    assert.equal(counters.proxy, 0);
});

test('Deep Clean uses the same isolated transport and produces a proposal without writing chat', async () => {
    const text = 'Original.';
    const rewriteItem = { id: 'item-0-hit-1', text, start: 0, end: text.length,
        segmentIndex: 0, relativeStart: 0, matches: [] };
    const requestItem = { itemIndex: 0, requestSource: text, rewriteItems: [rewriteItem],
        sourceSegments: [{ start: 0, end: text.length }] };
    const run = {
        input: { preset: { aiRewrite: {} }, aiConnection: aiSettings, processingSemantics: {}, messageAiScope: 'whole-message' },
        contentItems: [{ originalText: text }], programProposedResults: [],
        aiRequestPlan: { requests: [{ requestItems: [requestItem] }] },
    };
    const originalChat = structuredClone(host.chat);
    let proxySignal;
    globalThis.fetch = async (_url, { signal }) => {
        counters.proxy++;
        proxySignal = signal;
        return { ok: true, json: async () => ({ choices: [{ message: { content: '{"item-0-hit-1":[{"before":"Original.","occurrence":0,"after":"Rewritten."}]}' } }] }) };
    };
    const result = await executeDeepCleanAiRequests(run);
    assert.deepEqual(result.aiProposedResults, [{ itemIndex: 0, aiCandidate: 'Rewritten.' }]);
    assert.deepEqual(result.aiFailedItemIndexes, []);
    assert.equal(counters.proxy, 1);
    assert.equal(counters.helper, 0);
    assert.equal(counters.flash, 0);
    assert.equal(proxySignal.aborted, true, 'Deep Clean releases its request controller');
    assert.deepEqual(host.chat, originalChat);
});

test('Deep Clean timeout aborts the proxy without leaving a background generation', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const run = {
        input: { preset: { aiRewrite: {} }, aiConnection: aiSettings, processingSemantics: {} },
        contentItems: [], programProposedResults: [],
        aiRequestPlan: { requests: [{ requestItems: [] }] },
    };
    let proxySignal;
    globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
        proxySignal = signal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const pending = executeDeepCleanAiRequests(run);
    t.mock.timers.tick(300_000);
    const result = await pending;
    assert.equal(proxySignal.aborted, true);
    assert.deepEqual(result.aiFailedRequestIndexes, [0]);
    assert.equal(counters.helper, 0);
    assert.equal(counters.flash, 0);
    assert.equal(counters.hostStops, 0);
});

for (const marker of ['__TAURITAVERN__', '__TAURITAVERN_MAIN_READY__', '__TAURI_RUNNING__']) test(`Tauri ${marker}: hidden router marker cannot start helper generation`, async () => {
    delete globalThis.CultivationRuleRouter;
    globalThis[marker] = marker === '__TAURI_RUNNING__' ? true : {};
    assert.equal(getAiRewriteTransport(), 'sillytavern-chat-completions-proxy');
    globalThis.fetch = async (url, options) => {
        assert.equal(url, '/api/backends/chat-completions/generate');
        assert.equal(JSON.parse(options.body).type, 'quiet');
        return defaultFetch();
    };
    await callTavernHelperGenerateRaw(requestConfig());
    assert.equal(counters.helper, 0);
    assert.equal(counters.flash, 0);
    assert.equal(counters.proxy, 1);
    delete globalThis[marker];
});
