import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { bindAiSettingsEvents } from '../src/events/aiSettings.js';
import { defaultAiRewriteSettings, extensionName, initAppContext } from '../src/state.js';

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

const presetA = {
    baseUrl: 'https://a.example/v1',
    apiKey: 'key-a',
    model: 'model-a',
    modelOptions: ['model-a'],
    temperature: 0.2,
    topP: 0.8,
    topK: 20,
    frequencyPenalty: 0.1,
    presencePenalty: 0.2,
    repetitionPenalty: 1.1,
    maxTokens: 800,
    xmlScopeTag: 'content',
};

function installHarness({ promptResult, confirmResult = true } = {}) {
    const { elements, handlers, jquery } = createJqueryHarness();
    const calls = { prompt: 0, confirm: 0, save: 0 };
    const settings = {
        themeMode: 'auto',
        zhVariantCompatEnabled: false,
        zhVariantCompatOptions: { tw: true, hk: true },
        zhVariantDictionary: { status: 'missing' },
        aiRewrite: {
            ...defaultAiRewriteSettings,
            enabled: true,
            baseUrl: ' https://current.example/v1 ',
            apiKey: 'key-current',
            model: ' model-current ',
            modelOptions: ['model-current', ' model-current ', 'model-next'],
            temperature: 3,
            topP: -1,
            topK: 2.6,
            frequencyPenalty: -3,
            presencePenalty: 3,
            repetitionPenalty: 0,
            maxTokens: 70000,
            xmlScopeTag: 'reply',
            apiPresets: { A: structuredClone(presetA) },
            activeApiPreset: 'A',
        },
    };
    initAppContext({
        extension_settings: { [extensionName]: settings },
        saveSettingsDebounced: () => { calls.save += 1; },
    });
    globalThis.Option = TestOption;
    globalThis.document = { createDocumentFragment: createFragment, getElementById: () => null };
    globalThis.window = {
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        setTimeout: (callback) => callback(),
    };
    globalThis.$ = jquery;
    globalThis.prompt = () => {
        calls.prompt += 1;
        return promptResult;
    };
    globalThis.confirm = () => {
        calls.confirm += 1;
        return confirmResult;
    };
    bindAiSettingsEvents();
    return { calls, elements, handlers, settings };
}

function clickPresetAction(harness, id) {
    harness.handlers.get(`click::#${id}`).call(harness.elements.get(`#${id}`), { preventDefault() {} });
}

test.afterEach(() => {
    delete globalThis.Option;
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.$;
    delete globalThis.prompt;
    delete globalThis.confirm;
});

test('New creates a normalized preset while preserving the active preset', () => {
    const harness = installHarness({ promptResult: 'B' });
    const originalA = structuredClone(harness.settings.aiRewrite.apiPresets.A);

    clickPresetAction(harness, 'blai-ai-api-preset-new');

    assert.deepEqual(harness.settings.aiRewrite.apiPresets.A, originalA);
    assert.deepEqual(harness.settings.aiRewrite.apiPresets.B, {
        baseUrl: 'https://current.example/v1',
        apiKey: 'key-current',
        model: 'model-current',
        modelOptions: ['model-current', 'model-next'],
        temperature: 2,
        topP: 0,
        topK: 3,
        frequencyPenalty: -2,
        presencePenalty: 2,
        repetitionPenalty: 1,
        maxTokens: 65536,
        xmlScopeTag: 'reply',
    });
    assert.equal(harness.settings.aiRewrite.activeApiPreset, 'B');
    assert.equal(harness.calls.prompt, 1);
    assert.equal(harness.calls.save, 1);
});

test('cancelling New changes no preset, active selection, or current setting', () => {
    const harness = installHarness({ promptResult: null });
    const before = structuredClone(harness.settings.aiRewrite);

    clickPresetAction(harness, 'blai-ai-api-preset-new');

    assert.deepEqual(harness.settings.aiRewrite, before);
    assert.equal(harness.calls.prompt, 1);
    assert.equal(harness.calls.save, 0);
});

test('rejecting duplicate-name overwrite changes no preset', () => {
    const harness = installHarness({ promptResult: 'A', confirmResult: false });
    const before = structuredClone(harness.settings.aiRewrite);

    clickPresetAction(harness, 'blai-ai-api-preset-new');

    assert.deepEqual(harness.settings.aiRewrite, before);
    assert.equal(harness.calls.prompt, 1);
    assert.equal(harness.calls.confirm, 1);
    assert.equal(harness.calls.save, 0);
});

test('Save overwrites the active preset without requesting a name or creating another preset', () => {
    const harness = installHarness({ promptResult: 'unused' });

    clickPresetAction(harness, 'blai-ai-api-preset-save');

    assert.deepEqual(Object.keys(harness.settings.aiRewrite.apiPresets), ['A']);
    assert.equal(harness.settings.aiRewrite.apiPresets.A.baseUrl, 'https://current.example/v1');
    assert.equal(harness.settings.aiRewrite.apiPresets.A.model, 'model-current');
    assert.equal(harness.settings.aiRewrite.activeApiPreset, 'A');
    assert.equal(harness.calls.prompt, 0);
    assert.equal(harness.calls.confirm, 0);
    assert.equal(harness.calls.save, 1);
});

test('API preset action template and owning grids expose exactly four controls', async () => {
    const template = await readFile(new URL('../templates/purifier.html', import.meta.url), 'utf8');
    const css = await readFile(new URL('../styles/07-cascade-seal.css', import.meta.url), 'utf8');
    const ids = [
        'blai-ai-api-preset-new',
        'blai-ai-api-preset-save',
        'blai-ai-api-preset-edit',
        'blai-ai-api-preset-delete',
    ];

    for (const id of ids) assert.equal(template.match(new RegExp(`id="${id}"`, 'g'))?.length, 1);
    assert.ok(ids.map(id => template.indexOf(`id="${id}"`)).every((position, index, positions) => index === 0 || position > positions[index - 1]));
    assert.match(template, /id="blai-ai-api-preset-new"[^>]*title="将当前 API 配置另存为新预设"[^>]*aria-label="将当前 API 配置另存为新预设"[^>]*><i class="fas fa-plus"/);

    const owners = [...css.matchAll(/#blai-purifier-popup\.blai-app-shell \.blai-ai-api-preset-actions \{([\s\S]*?)\n\}/g)];
    assert.equal(owners.length, 2);
    assert.match(owners[0][1], /grid-template-columns: repeat\(4, 36px\) !important;/);
    assert.match(owners[1][1], /grid-template-columns: repeat\(4, 32px\) !important;/);
});
