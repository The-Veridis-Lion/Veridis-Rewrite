import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    clearAiCommunicationRecords,
    closeAiCommunicationMonitor,
    formatAiCommunicationRecords,
    getAiCommunicationRecords,
    openAiCommunicationMonitor,
    recordAiCommunicationSuccess,
    snapshotAiCommunicationRequest,
} from '../src/aiCommunicationMonitor.js';
import { requestAiRewrite, requestManualAiRewriteForMessage, resetAiRewriteRuntimeState } from '../src/aiRewrite/runtime.js';
import { bindAiCommunicationMonitorEvents } from '../src/events/aiSettings.js';
import { defaultAiRewriteSettings, extensionName, initAppContext, runtimeState } from '../src/state.js';

const templateSource = await readFile(new URL('../templates/purifier.html', import.meta.url), 'utf8');
const aiSettingsEventsSource = await readFile(new URL('../src/events/aiSettings.js', import.meta.url), 'utf8');
const cascadeSealCssSource = await readFile(new URL('../styles/07-cascade-seal.css', import.meta.url), 'utf8');

function createClassList() {
    const values = new Set();
    return {
        add(value) {
            values.add(value);
        },
        remove(value) {
            values.delete(value);
        },
        contains(value) {
            return values.has(value);
        },
    };
}

function createElement() {
    return {
        attributes: {},
        classList: createClassList(),
        focusCount: 0,
        setAttribute(name, value) {
            this.attributes[name] = String(value);
        },
        focus() {
            this.focusCount += 1;
        },
    };
}

function createMonitorDocument() {
    const modal = createElement();
    const open = createElement();
    const close = createElement();
    const clear = createElement();
    const output = createElement();
    let renderedText = '';
    let innerHtmlWrites = 0;
    Object.defineProperty(output, 'textContent', {
        get: () => renderedText,
        set: value => {
            renderedText = String(value);
        },
    });
    Object.defineProperty(output, 'innerHTML', {
        get: () => '',
        set: () => {
            innerHtmlWrites += 1;
        },
    });
    const elements = {
        'blai-ai-monitor-modal': modal,
        'blai-ai-monitor-open': open,
        'blai-ai-monitor-close': close,
        'blai-ai-monitor-clear': clear,
        'blai-ai-monitor-output': output,
    };
    return {
        elements,
        getElementById: id => elements[id] || null,
        querySelector: () => null,
        getInnerHtmlWrites: () => innerHtmlWrites,
    };
}

function createBindingHarness() {
    const handlers = new Map();
    const jquery = () => ({
        off(eventName, selector) {
            if (selector === undefined) {
                for (const key of handlers.keys()) {
                    if (key.startsWith(`${eventName}::`)) handlers.delete(key);
                }
            } else {
                handlers.delete(`${eventName}::${selector}`);
            }
            return this;
        },
        on(eventName, selector, handler) {
            if (typeof selector === 'function') {
                handler = selector;
                selector = '';
            }
            handlers.set(`${eventName}::${selector}`, handler);
            return this;
        },
    });
    return { handlers, jquery };
}

function createAiSettings(overrides = {}) {
    return {
        ...defaultAiRewriteSettings,
        enabled: true,
        baseUrl: 'https://rewrite.example/v1',
        apiKey: 'rewrite-test-key',
        model: 'rewrite-pro',
        xmlScopeTag: 'content',
        maxRetries: 0,
        ...overrides,
    };
}

function createRewriteSettings(aiOverrides = {}) {
    return {
        activePreset: 'test',
        rules: [{
            enabled: true,
            name: 'AI monitor test',
            subRules: [{
                enabled: true,
                rewriteMode: 'ai',
                mode: 'text',
                targets: ['正文'],
                replacements: ['程序正文'],
                aiPromptTemplate: '',
            }],
        }],
        aiRewrite: createAiSettings(aiOverrides),
    };
}

function installManualRewriteRuntime(chat, settings) {
    initAppContext({
        extension_settings: { [extensionName]: settings },
        chat,
        chat_metadata: {},
        getSillyTavernContext: () => ({ chat, getCurrentChatId: () => 'monitor-test' }),
        saveChat: async () => {},
        saveSettingsDebounced: () => {},
        eventSource: null,
        event_types: null,
        markWindowedChatDirtyFromIndex: () => {},
    });
    runtimeState.isStreamingGeneration = false;
    globalThis.toastr = {
        info: () => ({}),
        success: () => ({}),
        warning: () => ({}),
        error: () => ({}),
        clear: () => {},
        remove: () => {},
    };
    resetAiRewriteRuntimeState('monitor-test-setup');
}

async function flushScheduledRewrite() {
    await new Promise(resolve => setTimeout(resolve, 50));
}

test.afterEach(() => {
    clearAiCommunicationRecords();
    resetAiRewriteRuntimeState('monitor-test-cleanup');
    delete globalThis.TavernHelper;
    delete globalThis.toastr;
    delete globalThis.document;
});

test('the existing enabled button and single static viewer are owned by the AI settings binding', () => {
    const button = templateSource.match(/<button id="blai-ai-monitor-open"[^>]*>/)?.[0] || '';
    assert.ok(button);
    assert.doesNotMatch(button, /\bdisabled\b/);
    assert.equal((templateSource.match(/id="blai-ai-monitor-modal"/g) || []).length, 1);
    assert.match(templateSource, /监控 Veridis Rewrite 提交给酒馆助手的请求参数与返回结果。/);
    assert.match(templateSource, /包含经凭据脱敏的插件侧请求 JSON、返回文本与耗时。当前接口不提供 Provider HTTP 状态或 Token 用量。/);
    assert.match(aiSettingsEventsSource, /export function bindAiCommunicationMonitorEvents/);
    assert.match(aiSettingsEventsSource, /bindAiCommunicationMonitorEvents\(\);/);
    assert.match(templateSource, /<div class="blai-ai-monitor-actions">[\s\S]*清空日志[\s\S]*关闭[\s\S]*<\/div>/);
    assert.match(cascadeSealCssSource, /\.blai-ai-monitor-actions \{[\s\S]*?display: flex;[\s\S]*?flex-wrap: nowrap;/);
    assert.match(cascadeSealCssSource, /\.blai-ai-monitor-actions \.blai-secondary-btn \{[\s\S]*?min-width: 72px[\s\S]*?white-space: nowrap/);
});

test('repeated event binding and opening reuse one viewer and one handler per action', () => {
    const documentRef = createMonitorDocument();
    const { handlers, jquery } = createBindingHarness();
    globalThis.document = documentRef;

    bindAiCommunicationMonitorEvents(jquery);
    bindAiCommunicationMonitorEvents(jquery);

    assert.equal(handlers.size, 5);
    const openHandler = handlers.get('click::#blai-ai-monitor-open');
    openHandler.call(documentRef.elements['blai-ai-monitor-open'], { preventDefault() {} });
    openHandler.call(documentRef.elements['blai-ai-monitor-open'], { preventDefault() {} });
    assert.equal(documentRef.elements['blai-ai-monitor-modal'].classList.contains('blai-is-open'), true);
    assert.equal(documentRef.elements['blai-ai-monitor-modal'].attributes['aria-hidden'], 'false');
    assert.equal(documentRef.elements['blai-ai-monitor-open'].attributes['aria-expanded'], 'true');
});

test('closing and reopening retain records, clearing updates the open viewer, and HTML-like text stays literal', () => {
    const documentRef = createMonitorDocument();
    globalThis.document = documentRef;
    const requestJson = snapshotAiCommunicationRequest({
        ordered_prompts: [{ role: 'user', content: '<script>request</script>' }],
        custom_api: { key: 'secret', model: 'model-a' },
    });
    recordAiCommunicationSuccess({
        startedAt: 1000,
        endedAt: 1200,
        requestJson,
        response: '<img src=x onerror=alert(1)>',
    });

    assert.equal(openAiCommunicationMonitor(documentRef), true);
    assert.match(documentRef.elements['blai-ai-monitor-output'].textContent, /<script>request<\/script>/);
    assert.match(documentRef.elements['blai-ai-monitor-output'].textContent, /<img src=x onerror=alert\(1\)>/);
    assert.match(documentRef.elements['blai-ai-monitor-output'].textContent, /tokenUsage: unavailable/);
    assert.equal(documentRef.getInnerHtmlWrites(), 0);

    assert.equal(closeAiCommunicationMonitor(documentRef), true);
    assert.equal(openAiCommunicationMonitor(documentRef), true);
    assert.match(documentRef.elements['blai-ai-monitor-output'].textContent, /<img src=x onerror=alert\(1\)>/);

    clearAiCommunicationRecords();
    assert.equal(documentRef.elements['blai-ai-monitor-output'].textContent, '暂无通信记录。');
    assert.equal(getAiCommunicationRecords().length, 0);
});

test('clear-log click binding keeps the existing clear behavior', () => {
    const documentRef = createMonitorDocument();
    const { handlers, jquery } = createBindingHarness();
    globalThis.document = documentRef;
    bindAiCommunicationMonitorEvents(jquery);
    recordAiCommunicationSuccess({
        startedAt: 1000,
        endedAt: 1200,
        requestJson: snapshotAiCommunicationRequest({ custom_api: { key: 'secret' } }),
        response: 'response before clear',
    });
    openAiCommunicationMonitor(documentRef);

    handlers.get('click::#blai-ai-monitor-clear').call(documentRef.elements['blai-ai-monitor-clear'], { preventDefault() {} });

    assert.equal(getAiCommunicationRecords().length, 0);
    assert.equal(documentRef.elements['blai-ai-monitor-output'].textContent, '暂无通信记录。');
});

test('the call-time request snapshot redacts only custom_api.key and survives later mutation', () => {
    const requestConfig = {
        generation_id: 'generation-a',
        ordered_prompts: [{ role: 'user', content: 'original prompt' }],
        should_stream: false,
        custom_api: {
            apiurl: 'https://rewrite.example/v1',
            key: 'top-secret',
            model: 'original-model',
            custom_include_body: { response_format: { type: 'json_object' } },
        },
    };
    const snapshot = snapshotAiCommunicationRequest(requestConfig);
    requestConfig.ordered_prompts[0].content = 'mutated prompt';
    requestConfig.custom_api.key = 'later-secret';
    requestConfig.custom_api.model = 'mutated-model';
    requestConfig.custom_api.custom_include_body.response_format.type = 'text';

    assert.deepEqual(JSON.parse(snapshot), {
        generation_id: 'generation-a',
        ordered_prompts: [{ role: 'user', content: 'original prompt' }],
        should_stream: false,
        custom_api: {
            apiurl: 'https://rewrite.example/v1',
            key: '[REDACTED]',
            model: 'original-model',
            custom_include_body: { response_format: { type: 'json_object' } },
        },
    });
    assert.equal(snapshot.includes('top-secret'), false);
    assert.equal(snapshot.includes('later-secret'), false);
});

test('one successful generateRaw call records one exact response and preserves the return value', async () => {
    const documentRef = createMonitorDocument();
    globalThis.document = documentRef;
    const originalNow = Date.now;
    let now = 1000;
    const exactResponse = '{"hit-1":"<b>exact</b>\nline"}';
    let calls = 0;
    globalThis.TavernHelper = {
        generateRaw: async (requestConfig) => {
            calls += 1;
            assert.equal(requestConfig.custom_api.key, 'rewrite-test-key');
            requestConfig.custom_api.key = 'mutated-secret';
            requestConfig.custom_api.model = 'mutated-model';
            requestConfig.ordered_prompts[0].content = 'mutated prompt';
            now = 1482;
            return exactResponse;
        },
        stopGenerationById: () => true,
    };
    Date.now = () => now;
    try {
        const result = await requestAiRewrite('original prompt', createAiSettings(), new AbortController().signal);
        assert.equal(result, exactResponse);
    } finally {
        Date.now = originalNow;
    }

    assert.equal(calls, 1);
    const records = getAiCommunicationRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'succeeded');
    assert.equal(records[0].durationMs, 482);
    assert.equal(records[0].response, exactResponse);
    const request = JSON.parse(records[0].requestJson);
    assert.equal(request.ordered_prompts[0].content, 'original prompt');
    assert.equal(request.custom_api.model, 'rewrite-pro');
    assert.equal(request.custom_api.key, '[REDACTED]');
    assert.equal(JSON.stringify(records).includes('rewrite-test-key'), false);
    assert.equal(formatAiCommunicationRecords().includes('mutated-secret'), false);
});

test('a failed generateRaw call records available error fields and rethrows the same error', async () => {
    const originalNow = Date.now;
    let now = 2000;
    const expectedError = new Error('upstream failed');
    expectedError.name = 'UpstreamError';
    expectedError.status = 503;
    expectedError.code = 'EUPSTREAM';
    globalThis.TavernHelper = {
        generateRaw: async () => {
            now = 2125;
            throw expectedError;
        },
        stopGenerationById: () => true,
    };
    Date.now = () => now;
    let caught;
    try {
        await requestAiRewrite('failure prompt', createAiSettings(), new AbortController().signal);
    } catch (error) {
        caught = error;
    } finally {
        Date.now = originalNow;
    }

    assert.strictEqual(caught, expectedError);
    const [record] = getAiCommunicationRecords();
    assert.equal(record.status, 'failed');
    assert.equal(record.durationMs, 125);
    assert.deepEqual(record.error, {
        name: 'UpstreamError',
        message: 'upstream failed',
        status: 503,
        code: 'EUPSTREAM',
    });
    assert.match(formatAiCommunicationRecords(), /status: failed[\s\S]*status: 503[\s\S]*code: EUPSTREAM/);
});

test('existing retry behavior creates separate records only for separate generateRaw calls', async () => {
    const chat = [{ is_user: false, mes: '<content>正文</content>' }];
    installManualRewriteRuntime(chat, createRewriteSettings({ maxRetries: 1 }));
    globalThis.document = createMonitorDocument();
    let calls = 0;
    globalThis.TavernHelper = {
        generateRaw: async () => {
            calls += 1;
            if (calls === 1) throw new Error('retry me');
            return '{"hit-1":"改写正文"}';
        },
        stopGenerationById: () => true,
    };

    assert.equal(requestManualAiRewriteForMessage(0), true);
    await flushScheduledRewrite();

    assert.equal(calls, 2);
    assert.deepEqual(getAiCommunicationRecords().map(record => record.status), ['succeeded', 'failed']);
    assert.equal(chat[0].mes, '<content>改写正文</content>');
});

test('eleven real generateRaw completions retain only the newest ten in newest-first order', async () => {
    let attempt = 0;
    globalThis.TavernHelper = {
        generateRaw: async () => `response-${attempt++}`,
        stopGenerationById: () => true,
    };
    for (let index = 0; index < 11; index++) {
        await requestAiRewrite(`prompt-${index}`, createAiSettings(), new AbortController().signal);
    }

    const records = getAiCommunicationRecords();
    assert.equal(attempt, 11);
    assert.equal(records.length, 10);
    assert.deepEqual(records.map(record => record.response), [
        'response-10',
        'response-9',
        'response-8',
        'response-7',
        'response-6',
        'response-5',
        'response-4',
        'response-3',
        'response-2',
        'response-1',
    ]);
});
