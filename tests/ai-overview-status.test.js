import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { bindAiSettingsEvents } from '../src/events/aiSettings.js';
import { defaultAiRewriteSettings, extensionName, initAppContext } from '../src/state.js';

const templateSource = await readFile(new URL('../templates/purifier.html', import.meta.url), 'utf8');
const eventsSource = await readFile(new URL('../src/events.js', import.meta.url), 'utf8');
const aiSettingsEventsSource = await readFile(new URL('../src/events/aiSettings.js', import.meta.url), 'utf8');
const homeCssSource = await readFile(new URL('../styles/05-home-page.css', import.meta.url), 'utf8');

class TestOption {
    constructor(text, value) {
        this.text = String(text);
        this.value = String(value);
        this.disabled = false;
    }
}

function createFragment() {
    return {
        children: [],
        appendChild(child) {
            this.children.push(child);
            return child;
        },
    };
}

function createElement(id = '') {
    return {
        id,
        attributes: {},
        props: {},
        classes: new Set(),
        children: [],
        textContent: '',
        value: '',
        focused: false,
    };
}

function createJqueryHarness() {
    const elements = new Map();
    const handlers = new Map();
    const getElement = (selector) => {
        if (typeof selector === 'object' && selector) return selector;
        const key = String(selector || '');
        if (!elements.has(key)) elements.set(key, createElement(key.startsWith('#') ? key.slice(1) : key));
        return elements.get(key);
    };
    const makeWrapper = (items) => ({
        length: items.length,
        attr(name, value) {
            if (value === undefined) return items[0]?.attributes?.[name];
            items.forEach(item => { item.attributes[name] = String(value); });
            return this;
        },
        prop(name, value) {
            if (value === undefined) return items[0]?.props?.[name];
            items.forEach(item => { item.props[name] = value; });
            return this;
        },
        val(value) {
            if (value === undefined) return items[0]?.value;
            items.forEach(item => { item.value = String(value); });
            return this;
        },
        text(value) {
            if (value === undefined) return items[0]?.textContent;
            items.forEach(item => { item.textContent = String(value); });
            return this;
        },
        is(selector) {
            return selector === ':focus' ? items.some(item => item.focused) : false;
        },
        empty() {
            items.forEach(item => { item.children = []; });
            return this;
        },
        append(fragment) {
            items.forEach(item => { item.children.push(...(fragment?.children || [fragment])); });
            return this;
        },
        toggleClass(name, enabled) {
            items.forEach(item => enabled ? item.classes.add(name) : item.classes.delete(name));
            return this;
        },
        addClass(name) {
            items.forEach(item => item.classes.add(name));
            return this;
        },
        removeClass(name) {
            items.forEach(item => item.classes.delete(name));
            return this;
        },
        find(selector) {
            return makeWrapper([getElement(`${items[0]?.id || 'anonymous'} ${selector}`)]);
        },
        closest(selector) {
            return makeWrapper([getElement(`${items[0]?.id || 'anonymous'} closest ${selector}`)]);
        },
        insertAfter() { return this; },
        appendTo() { return this; },
        prependTo() { return this; },
        trigger() { return this; },
        remove() { return this; },
        off(eventName, selector) {
            handlers.delete(`${eventName}::${selector || ''}`);
            return this;
        },
        on(eventName, selector, handler) {
            if (typeof selector === 'function') {
                handler = selector;
                selector = '';
            }
            handlers.set(`${eventName}::${selector || ''}`, handler);
            return this;
        },
    });
    const jquery = (selector) => makeWrapper(String(selector || '').includes(',')
        ? String(selector).split(',').map(part => getElement(part.trim()))
        : [getElement(selector)]);
    return { elements, handlers, jquery };
}

function installAiSettingsHarness({ enabled }) {
    const { elements, handlers, jquery } = createJqueryHarness();
    const settings = {
        themeMode: 'auto',
        zhVariantCompatEnabled: false,
        zhVariantCompatOptions: { tw: true, hk: true },
        zhVariantDictionary: { status: 'missing' },
        aiRewrite: {
            ...defaultAiRewriteSettings,
            enabled,
            baseUrl: 'https://rewrite.example/v1',
            apiKey: 'rewrite-key',
            model: '',
            modelOptions: [],
            apiPresets: {},
            activeApiPreset: '',
        },
    };
    initAppContext({
        extension_settings: { [extensionName]: settings },
        saveSettingsDebounced: () => {},
    });
    globalThis.Option = TestOption;
    globalThis.document = { createDocumentFragment: createFragment, getElementById: () => null };
    globalThis.window = {
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        setTimeout: (callback) => callback(),
    };
    globalThis.$ = jquery;
    return { elements, handlers, settings };
}

test.afterEach(() => {
    delete globalThis.Option;
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.$;
    delete globalThis.TavernHelper;
    delete globalThis.parent;
});

test('overview replaces the interactive model-list control with the AI enabled metric', () => {
    const overviewStart = templateSource.indexOf('data-page="overview"');
    const aiPageStart = templateSource.indexOf('data-page="ai"', overviewStart);
    const overviewSource = templateSource.slice(overviewStart, aiPageStart);
    assert.match(overviewSource, /<span class="blai-home-metric"><b id="blai-ai-enabled-status">AI 启用中<\/b><\/span>/);
    assert.doesNotMatch(overviewSource, /blai-ai-api-check|blai-ai-api-status|blai-home-model-fetch|模型列表/);
    assert.doesNotMatch(eventsSource, /blai-ai-api-check|runAiModelsHealthCheck\(\{ silent: false \}\)/);
    assert.doesNotMatch(homeCssSource, /blai-home-model-fetch|blai-ai-api-check|blai-ai-api-status/);
    assert.match(templateSource, /id="blai-ai-model-fetch"[\s\S]*aria-label="刷新模型列表"/);
});

test('overview AI status follows aiRewrite.enabled during initial sync without fetching models', () => {
    let getModelListCalls = 0;
    globalThis.TavernHelper = { getModelList: async () => { getModelListCalls += 1; return ['model-a']; } };
    globalThis.parent = { TavernHelper: globalThis.TavernHelper };
    const disabledHarness = installAiSettingsHarness({ enabled: false });
    bindAiSettingsEvents();
    assert.equal(disabledHarness.elements.get('#blai-ai-enabled-status').textContent, 'AI 关闭中');
    assert.equal(getModelListCalls, 0);

    const enabledHarness = installAiSettingsHarness({ enabled: true });
    bindAiSettingsEvents();
    assert.equal(enabledHarness.elements.get('#blai-ai-enabled-status').textContent, 'AI 启用中');
    assert.equal(getModelListCalls, 0);
});

test('AI enabled checkbox updates the overview status through the settings sync path', () => {
    let getModelListCalls = 0;
    globalThis.TavernHelper = { getModelList: async () => { getModelListCalls += 1; return ['model-a']; } };
    globalThis.parent = { TavernHelper: globalThis.TavernHelper };
    const { elements, handlers, settings } = installAiSettingsHarness({ enabled: false });
    bindAiSettingsEvents();

    const enabledControl = elements.get('#blai-ai-enabled');
    enabledControl.props.checked = true;
    handlers.get('change::#blai-ai-enabled').call(enabledControl);

    assert.equal(settings.aiRewrite.enabled, true);
    assert.equal(elements.get('#blai-ai-enabled-status').textContent, 'AI 启用中');
    assert.equal(getModelListCalls, 0);
});

test('AI settings model fetch still calls the existing model-list flow and populates options', async () => {
    let getModelListCalls = 0;
    globalThis.TavernHelper = {
        getModelList: async ({ apiurl, key }) => {
            getModelListCalls += 1;
            assert.equal(apiurl, 'https://rewrite.example/v1');
            assert.equal(key, 'rewrite-key');
            return ['model-b', 'model-a'];
        },
    };
    globalThis.parent = { TavernHelper: globalThis.TavernHelper };
    const { elements, handlers, settings } = installAiSettingsHarness({ enabled: true });
    bindAiSettingsEvents();

    handlers.get('click::#blai-ai-model-fetch').call(elements.get('#blai-ai-model-fetch'), { preventDefault() {} });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(getModelListCalls, 1);
    assert.deepEqual(settings.aiRewrite.modelOptions, ['model-b', 'model-a']);
    assert.equal(settings.aiRewrite.model, 'model-b');
    assert.deepEqual(elements.get('#blai-ai-model').children.map(option => option.value), ['', 'model-b', 'model-a']);
    assert.equal(elements.get('#blai-ai-connection-status').textContent, '连接正常');
    assert.doesNotMatch(aiSettingsEventsSource, /blai-ai-api-check|blai-ai-api-status/);
});
