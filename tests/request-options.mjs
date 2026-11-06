import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseAiRequestOptions } from '../src/aiRewrite/requestOptions.js';
import { buildAiRewriteGenerateRawConfig, callTavernHelperGenerateRaw } from '../src/aiRewrite/generation.js';
import { buildAiRewriteProxyBody } from '../src/aiRewrite/isolatedRequest.js';
import { getAiConfigIssue, snapshotAiRewriteTaskSettings } from '../src/aiRewrite/task.js';
import { initAppContext } from '../src/host/appContext.js';
import { executeDeepCleanAiRequests } from '../src/deepClean/aiProcessing.js';
import { defaultAiRewriteSettings } from '../src/settings/defaults.js';

const connection = { enabled: true, baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key', model: 'fixture-model' };
test('blank request options preserve the existing helper request', () => {
    assert.deepEqual(parseAiRequestOptions(), { additional: {}, excluded: [] });
    const config = buildAiRewriteGenerateRawConfig('Prompt', connection);
    assert.deepEqual(config.custom_api.custom_include_body, { response_format: { type: 'json_object' } });
    assert.equal(Object.hasOwn(config.custom_api, 'custom_exclude_body'), false);
    assert.equal(Object.hasOwn(buildAiRewriteProxyBody(config), 'custom_exclude_body'), false);
});
test('additional provider objects, false and zero survive, exclusion wins and deduplicates', () => {
    const settings = { ...connection, temperature: 0.4, repetitionPenalty: 1.2,
        additionalParameters: '{"reasoning_effort":"none","thinking":{"enabled":false,"budget_tokens":0},"temperature":0,"repetition_penalty":1.1,"frequency_penalty":0.8}',
        excludedParameters: 'frequency_penalty, presence_penalty\nfrequency_penalty，top_k repetition_penalty' };
    const config = buildAiRewriteGenerateRawConfig('Prompt', settings, 'test');
    assert.deepEqual(config.custom_api.custom_exclude_body, ['frequency_penalty', 'presence_penalty', 'top_k', 'repetition_penalty']);
    assert.deepEqual(config.custom_api.custom_include_body, { response_format: { type: 'json_object' },
        reasoning_effort: 'none', thinking: { enabled: false, budget_tokens: 0 }, temperature: 0 });
    const proxy = buildAiRewriteProxyBody(config);
    assert.deepEqual(JSON.parse(proxy.custom_exclude_body), config.custom_api.custom_exclude_body);
    assert.deepEqual(JSON.parse(proxy.custom_include_body), config.custom_api.custom_include_body);
    assert.equal(Object.hasOwn(proxy, 'frequency_penalty'), false);
    assert.equal(Object.hasOwn(proxy, 'presence_penalty'), false);
    assert.equal(proxy.stream, false);
    assert.deepEqual(proxy.messages, [{ role: 'user', content: 'Prompt' }]);
});
for (const raw of ['{', '{"x":1,}', '[]', 'null', '"text"', '1', '{"stream":true}', '{"nested":{"__proto__":{"polluted":true}}}']) {
    test('invalid request options stop before transport: ' + raw, () => {
        const settings = { ...connection, additionalParameters: raw };
        assert.throws(() => buildAiRewriteGenerateRawConfig('Prompt', settings));
        assert.equal(getAiConfigIssue(settings).code, 'invalid-request-options');
        assert.equal({}.polluted, undefined);
    });
}
test('valid stream false and overridden response format are supported', () => {
    const api = buildAiRewriteGenerateRawConfig('P', { ...connection, additionalParameters: '{"stream":false,"response_format":{"type":"text"}}' }).custom_api;
    assert.deepEqual(api.custom_include_body.response_format, { type: 'text' });
});
test('explicit exclusion removes an otherwise unsupported additional stream override', () => {
    assert.deepEqual(parseAiRequestOptions({ additionalParameters: '{"stream":true}', excludedParameters: 'stream' }),
        { additional: {}, excluded: ['stream'] });
});
test('manual and automatic task snapshots freeze connection options without changing rules', () => {
    const ai = { ...connection, excludedParameters: 'top_k', additionalParameters: '{"reasoning_effort":"none"}' };
    const frozen = snapshotAiRewriteTaskSettings({ rules: [] }, ai);
    ai.additionalParameters = '{}'; ai.excludedParameters = '';
    assert.equal(frozen.aiSettings.excludedParameters, 'top_k');
    assert.equal(frozen.aiSettings.additionalParameters, '{"reasoning_effort":"none"}');
});
test('API preset migration preserves both fields and gives old presets blank defaults', () => {
    const source = readFileSync(new URL('../src/settings/migration.js', import.meta.url), 'utf8');
    const block = source.slice(source.indexOf('function normalizeAiApiPresetEntry'), source.indexOf('function normalizeAiApiPresets'));
    const context = vm.createContext({ normalizeAiSamplingSettings: () => ({}), normalizeOptionalXmlTagNameInput: x => x,
        defaultAiRewriteSettings, fixture: { additionalParameters: '{"reasoning_effort":"none"}', excludedParameters: 'top_k', streamingEnabled: true } });
    vm.runInContext(block + '\nresult = normalizeAiApiPresetEntry(fixture); old = normalizeAiApiPresetEntry({});', context);
    assert.equal(context.result.additionalParameters, context.fixture.additionalParameters);
    assert.equal(context.result.excludedParameters, 'top_k');
    assert.equal(context.old.additionalParameters, ''); assert.equal(context.old.excludedParameters, '');
    assert.equal(context.result.streamingEnabled, true); assert.equal(context.old.streamingEnabled, false);
});
test('helper transport receives native include/exclude fields', async () => {
    let received;
    const previous = globalThis.TavernHelper;
    globalThis.TavernHelper = { generateRaw: async config => { received = config; return '{}'; } };
    try {
        const config = buildAiRewriteGenerateRawConfig('P', { ...connection, excludedParameters: 'top_k', additionalParameters: '{"reasoning_effort":"none"}' });
        await callTavernHelperGenerateRaw(config, undefined, 'tavern-helper-custom-api');
        assert.deepEqual(received.custom_api.custom_exclude_body, ['top_k']);
        assert.equal(received.custom_api.custom_include_body.reasoning_effort, 'none');
    } finally { globalThis.TavernHelper = previous; }
});
test('Deep Clean forwards its frozen connection options to the isolated transport', async () => {
    const previous = { fetch: globalThis.fetch, router: globalThis.CultivationRuleRouter };
    globalThis.CultivationRuleRouter = {};
    initAppContext({ getSillyTavernContext: () => ({ getRequestHeaders: () => ({}) }) });
    let body;
    globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) }; };
    try {
        const run = { input: { preset: { aiRewrite: {} }, aiConnection: { ...connection,
            excludedParameters: 'top_k', additionalParameters: '{"reasoning_effort":"none"}' }, processingSemantics: {} },
            contentItems: [], programProposedResults: [], aiRequestPlan: { requests: [{ requestItems: [] }] } };
        await executeDeepCleanAiRequests(run);
        assert.deepEqual(JSON.parse(body.custom_exclude_body), ['top_k']);
        assert.equal(JSON.parse(body.custom_include_body).reasoning_effort, 'none');
    } finally { globalThis.fetch = previous.fetch; globalThis.CultivationRuleRouter = previous.router; }
});
