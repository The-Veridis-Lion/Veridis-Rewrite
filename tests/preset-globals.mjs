import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { initAppContext } from '../src/host/appContext.js';
import { defaultSettings, defaultAiRewriteSettings, extensionName } from '../src/settings/defaults.js';
import { applyPresetByName, applyCharacterPresetBinding, hasActivePresetUnsavedChanges } from '../src/presets/application.js';
import { bindPresetEvents } from '../src/presets/events.js';
import { buildPresetEntry } from '../src/presets/model.js';
import { presetsRuntimeState } from '../src/presets/state.js';

// Native event handlers, persistence and model functions; absent host UI is a chainable stub.
const handlers = new Map(), values = new Map();
function $(selector) {
    let proxy;
    proxy = new Proxy({ length: 0 }, { get(target, name) {
        if (name === 'length') return 0;
        if (name === 'on') return (event, delegated, fn) => {
            if (typeof delegated === 'string') handlers.set(event + ':' + delegated, fn);
            return proxy;
        };
        if (name === 'val') return (...args) => args.length ? (values.set(selector, args[0]), proxy) : values.get(selector);
        if (name === 'attr') return (...args) => args.length === 1 ? undefined : proxy;
        if (name === 'hasClass' || name === 'is') return () => false;
        if (name === 'get') return () => [];
        return () => proxy;
    } });
    return proxy;
}
globalThis.$ = $;
globalThis.document = { querySelector: () => null };
globalThis.confirm = () => true;
globalThis.alert = message => { throw Error(message); };

const rules = name => [{ name, enabled: true, subRules: [
    { enabled: true, mode: 'text', rewriteMode: 'ai', targets: ['示例'], replacements: [], aiPromptTemplate: '本条规则的要求保持原样。' },
    { enabled: false, mode: 'text', rewriteMode: 'program', targets: ['选开'], replacements: [''] },
] }];
let settings, initialAi, saves;
beforeEach(() => {
    handlers.clear(); values.clear(); saves = 0;
    settings = structuredClone(defaultSettings);
    settings.logLevel = 0;
    settings.aiRewrite = { ...defaultAiRewriteSettings, promptTemplate: '用户自己的全局提示词 {{annotatedSource}}',
        temperature: 0.65, topP: 0.81, topK: 31, maxTokens: 54321, timeoutMs: 87000,
        maxRetries: 4, maxContextChars: 43210, maxItemsPerRequest: 123, frequencyPenalty: 0.3,
        presencePenalty: 0.4, repetitionPenalty: 1.2, enabled: true, autoTriggerEnabled: false,
        baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-secret', model: 'fixture-model', xmlScopeTag: 'content',
        excludedParameters: 'frequency_penalty\npresence_penalty', additionalParameters: '{"reasoning_effort":"none"}',
        streamingEnabled: true,
        apiPresets: { mine: { model: 'fixture-model', additionalParameters: '{"reasoning_effort":"none"}' } }, activeApiPreset: 'mine' };
    initialAi = structuredClone(settings.aiRewrite);
    settings.rules = rules('旧规则'); settings.activePreset = '旧';
    settings.presets = { 旧: buildPresetEntry(settings.rules, { ...defaultAiRewriteSettings, temperature: 1.9 }),
        新: buildPresetEntry(rules('新规则'), { ...defaultAiRewriteSettings, temperature: 0.1, promptTemplate: '不得覆盖用户的全局提示词' }) };
    initAppContext({ extension_settings: { [extensionName]: settings }, saveSettingsDebounced: () => { saves++; },
        getSillyTavernContext: () => ({ characterId: 0, characters: [{ name: 'Fixture' }] }) });
    presetsRuntimeState.lastPresetBindingSignature = '';
    presetsRuntimeState.importPresetDraft = { rules: rules('导入规则'), aiRewrite: { ...defaultAiRewriteSettings, temperature: 1.7, promptTemplate: '导入文件中的旧全局提示词' } };
    values.set('#blai-import-preset-name', '导入');
    bindPresetEvents();
});

test('switching a saved preset preserves every live AI field and imports per-rule prompts and switches', () => {
    const ref = settings.aiRewrite;
    applyPresetByName('新', { skipRender: true });
    assert.equal(settings.aiRewrite, ref); assert.deepEqual(settings.aiRewrite, initialAi);
    assert.deepEqual(settings.rules, rules('新规则'));
    settings.rules[0].name = '临时编辑'; assert.equal(settings.presets.新.rules[0].name, '新规则');
});
test('switching legacy array preset or temporary empty selection preserves AI globals', () => {
    settings.presets.旧数组 = rules('数组规则');
    applyPresetByName('旧数组', { skipRender: true }); assert.deepEqual(settings.aiRewrite, initialAi);
    applyPresetByName('', { skipRender: true }); assert.deepEqual(settings.aiRewrite, initialAi); assert.deepEqual(settings.rules, []);
});
test('AI-only edits do not falsely mark rule preset dirty; rule edits still do', () => {
    assert.equal(hasActivePresetUnsavedChanges(), false);
    settings.aiRewrite.promptTemplate = '另一段全局提示词'; settings.aiRewrite.maxTokens = 123;
    assert.equal(hasActivePresetUnsavedChanges(), false);
    settings.rules[0].subRules[0].aiPromptTemplate += '规则内的修改';
    assert.equal(hasActivePresetUnsavedChanges(), true);
});
for (const choice of ['only', 'switch', 'preview']) test(`native import-${choice} click handler preserves global AI configuration`, () => {
    const oldRules = structuredClone(settings.rules);
    const imported = structuredClone(presetsRuntimeState.importPresetDraft.rules);
    const callback = handlers.get('click:#blai-import-' + choice); assert.equal(typeof callback, 'function'); callback();
    assert.deepEqual(settings.aiRewrite, initialAi);
    assert.ok(saves > 0);
    if (choice === 'only') { assert.deepEqual(settings.rules, oldRules); assert.equal(settings.activePreset, '旧'); }
    else { assert.deepEqual(settings.rules, imported); assert.equal(settings.activePreset, choice === 'switch' ? '导入' : ''); }
    if (choice !== 'preview') {
        assert.deepEqual(settings.presets.导入.rules, imported);
        assert.equal(settings.presets.导入.aiRewrite.temperature, 1.7, 'file snapshot retained for export compatibility');
        applyPresetByName('导入', { skipRender: true }); assert.deepEqual(settings.aiRewrite, initialAi);
    }
});
test('cancelled import leaves live rules, preset and globals untouched', () => {
    globalThis.confirm = () => false;
    const before = structuredClone(settings);
    handlers.get('click:#blai-import-preview')(); assert.deepEqual(settings, before);
    globalThis.confirm = () => true;
});
test('character binding and reload-style reapplication keep saved globals', () => {
    settings.characterBindings = { 'chid:0': '新' };
    applyCharacterPresetBinding(true);
    assert.equal(settings.activePreset, '新'); assert.deepEqual(settings.aiRewrite, initialAi);
    const reloaded = JSON.parse(JSON.stringify(settings));
    Object.assign(settings, reloaded);
    applyCharacterPresetBinding(true); assert.deepEqual(settings.aiRewrite, initialAi);
});
