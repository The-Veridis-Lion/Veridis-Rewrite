import test from 'node:test';
import assert from 'node:assert/strict';

import {
    adoptMvuMessageContentForAiRewrite,
    clearAiRewriteDebugLog,
    handleAiRewriteGenerationStarted,
    markAiRewriteFinalCleanseReady,
    maybeNotifyAiRewriteReadyFromStreamingText,
    requestManualAiRewriteForMessage,
    resetAiRewriteRuntimeState,
    validateAiRewriteFinalization,
    validateAiRewriteMessageTarget,
    waitForAutomaticAiRewrite,
} from '../src/aiRewrite.js';
import { cleanseMessageDataAtIndex } from '../src/core.js';
import { generationLifecycle } from '../src/generationLifecycle.js';
import { writeMessageDiffAiTrace, writeMessageDiffManualFinal, writeMessageDiffMeta } from '../src/messageMeta.js';
import { applyVisualMask, buildProcessors } from '../src/replacementEngine.js';
import {
    defaultAiRewriteSettings,
    extensionName,
    initAppContext,
    runtimeState,
} from '../src/state.js';

const chatId = 'host:streaming-test';
const closedContent = '<content>正文</content>';
const tail = '\n状态栏\n小剧场';

function createSettings(overrides = {}) {
    const subRuleOverrides = overrides.subRule || {};
    const aiRewriteOverrides = overrides.aiRewrite || {};
    return {
        activePreset: 'test',
        rules: [{
            enabled: true,
            name: 'AI test',
            subRules: [{
                enabled: true,
                rewriteMode: 'ai',
                mode: 'text',
                targets: ['正文'],
                replacements: ['程序正文'],
                aiPromptTemplate: '',
                ...subRuleOverrides,
            }],
        }],
        aiRewrite: {
            ...defaultAiRewriteSettings,
            enabled: true,
            baseUrl: 'https://rewrite.example/v1',
            apiKey: 'rewrite-test-key',
            model: 'rewrite-pro',
            xmlScopeTag: 'content',
            maxRetries: 0,
            ...aiRewriteOverrides,
        },
    };
}

function createAiResponse(rewritten = '改写正文') {
    return createAiResponseForId('hit-1', rewritten);
}

function createAiResponseForId(id, rewritten) {
    return createAiResponseForEntries([{ id, rewritten }]);
}

function createAiResponseForEntries(rewrites) {
    const content = JSON.stringify(Object.fromEntries(
        rewrites.map(({ id, rewritten }) => [id, rewritten])
    ));
    return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content } }] }),
    };
}

function installRuntime(chat, settings = createSettings(), contextOverrides = {}) {
    initAppContext({
        extension_settings: { [extensionName]: settings },
        chat,
        chat_metadata: { chatId: 'streaming-test' },
        getSillyTavernContext: () => ({
            chat,
            getCurrentChatId: () => 'streaming-test',
            ...contextOverrides,
        }),
        saveChat: async () => {},
        saveSettingsDebounced: () => {},
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'test-csrf' }),
        eventSource: null,
        event_types: null,
        markWindowedChatDirtyFromIndex: () => {},
    });
    runtimeState.isStreamingGeneration = true;
    globalThis.toastr = {
        info: () => ({}),
        success: () => ({}),
        warning: () => ({}),
        error: () => ({}),
        clear: () => {},
        remove: () => {},
    };
    globalThis.TavernHelper = {
        generateRaw: async (options) => {
            const response = await globalThis.fetch('TavernHelper.generateRaw', {
                body: JSON.stringify({
                    ...options,
                    messages: options.ordered_prompts,
                }),
            });
            if (typeof response === 'string') return response;
            const payload = await response.json();
            return payload?.choices?.[0]?.message?.content || '';
        },
        stopGenerationById: () => true,
    };
    globalThis.document = {
        querySelector: () => null,
        getElementById: () => null,
        documentElement: {
            setAttribute: () => {},
            removeAttribute: () => {},
        },
    };
    generationLifecycle.configure({
        getCurrentChatId: () => chatId,
        getCurrentChat: () => chat,
    });
    const session = generationLifecycle.startGeneration({ chatId, chat, mode: 'streaming-test' });
    resetAiRewriteRuntimeState('test-setup');
    clearAiRewriteDebugLog();
    runtimeState.isStreamingGeneration = true;
    return session;
}

function installDismissibleToastHarness() {
    const calls = [];
    const createNode = () => ({
        children: [],
        className: '',
        textContent: '',
        dataset: {},
        disabled: false,
        listeners: new Map(),
        appendChild(child) {
            this.children.push(child);
            return child;
        },
        addEventListener(type, listener) {
            this.listeners.set(type, listener);
        },
    });
    const createToast = (type, message, title, options) => {
        const closeButton = createNode();
        closeButton.attributes = {};
        closeButton.setAttribute = (name, value) => {
            closeButton.attributes[name] = value;
        };
        closeButton.click = () => closeButton.listeners.get('click')?.({
            preventDefault() {},
            stopPropagation() {},
            stopImmediatePropagation() {},
        });
        const toastElement = createNode();
        toastElement.removed = false;
        toastElement.classList = {
            values: new Set(),
            add(...classNames) {
                classNames.forEach(className => this.values.add(className));
            },
            contains(className) {
                return this.values.has(className);
            },
        };
        toastElement.querySelector = (selector) => {
            if (selector === '.toast-close-button') return closeButton;
            if (selector === '.blai-ai-toast-actions') {
                return toastElement.children.find(child => child.className === 'blai-ai-toast-actions') || null;
            }
            return null;
        };
        toastElement.remove = () => {
            toastElement.removed = true;
        };
        const toast = { get: () => toastElement };
        calls.push({ type, message, title, options, toast, toastElement, closeButton });
        return toast;
    };
    globalThis.document = {
        querySelector: () => null,
        getElementById: () => null,
        createElement: () => createNode(),
        documentElement: {
            setAttribute: () => {},
            removeAttribute: () => {},
        },
    };
    globalThis.toastr = {
        info: (message, title, options) => createToast('info', message, title, options),
        success: (message, title, options) => createToast('success', message, title, options),
        warning: (message, title, options) => createToast('warning', message, title, options),
        error: (message, title, options) => createToast('error', message, title, options),
        clear: toast => toast?.get?.(0)?.remove?.(),
        remove: toast => toast?.get?.(0)?.remove?.(),
    };
    return { calls };
}

async function flushScheduledWork() {
    await new Promise(resolve => setTimeout(resolve, 20));
}

async function withMockedNow(initialMs, callback) {
    const originalDateNow = Date.now;
    let nowMs = initialMs;
    Date.now = () => nowMs;
    try {
        await callback((nextMs) => {
            nowMs = nextMs;
        });
    } finally {
        Date.now = originalDateNow;
    }
}

function markHostFinal(session, chat) {
    generationLifecycle.bindMessage(0, {
        generationId: session.generationId,
        chatId,
        chat,
        source: 'message-received',
    });
    generationLifecycle.markFinalSource(session.generationId, 'message-received');
    markAiRewriteFinalCleanseReady({
        automatic: true,
        generationId: session.generationId,
        chatId,
        messageId: 0,
        source: 'message-received',
    });
}

function markHostFinalWithProgramCleanse(session, chat) {
    generationLifecycle.bindMessage(0, {
        generationId: session.generationId,
        chatId,
        chat,
        source: 'message-received',
    });
    generationLifecycle.markFinalSource(session.generationId, 'message-received');
    const aiOwnsFinalCommit = markAiRewriteFinalCleanseReady({
        automatic: true,
        generationId: session.generationId,
        chatId,
        messageId: 0,
        source: 'message-received',
    });
    if (!aiOwnsFinalCommit) {
        runtimeState.isRegexDirty = true;
        buildProcessors();
        cleanseMessageDataAtIndex(0);
    }
    return aiOwnsFinalCommit;
}

function addProgramRule(settings, target = '尾', replacement = '末') {
    settings.rules.push({
        enabled: true,
        name: 'program test',
        subRules: [{
            enabled: true,
            rewriteMode: 'program',
            mode: 'text',
            targets: [target],
            replacements: [replacement],
        }],
    });
    return settings;
}

function notifyCommittedStreamingContent(session, chat, committedText) {
    chat[0].mes = committedText;
    maybeNotifyAiRewriteReadyFromStreamingText(0, committedText, {
        generationId: session.generationId,
        chatId,
        source: 'streaming-committed',
        hostCommitted: true,
    });
}

test.afterEach(() => {
    resetAiRewriteRuntimeState('test-cleanup');
    generationLifecycle.cancelActive('test-cleanup');
    delete globalThis.fetch;
    delete globalThis.TavernHelper;
    delete globalThis.toastr;
    delete globalThis.document;
});

test('disabled global AI still finalizes enabled AI rules through program fallback once', () => {
    const original = '<content>正文</content>尾';
    const chat = [{ is_user: false, mes: original, swipe_id: 0, swipes: [original], swipe_info: [{}] }];
    const settings = addProgramRule(createSettings({ aiRewrite: { enabled: false } }));
    const session = installRuntime(chat, settings);
    let fetchCount = 0;
    globalThis.fetch = async () => {
        fetchCount += 1;
        return createAiResponse();
    };
    runtimeState.isRegexDirty = true;
    buildProcessors();

    assert.equal(applyVisualMask(original), '<content>程序正文</content>末');

    assert.equal(markHostFinalWithProgramCleanse(session, chat), true);

    assert.equal(fetchCount, 0);
    assert.equal(chat[0].mes, '<content>程序正文</content>末');
    assert.equal(runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'atomic-commit').length, 1);
    assert.equal(runtimeState.aiRewrite.debugEvents.some(event => event.stage === 'fallback-applied'), true);
    const programCommit = runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'program-commit');
    assert.equal(programCommit.length, 1);
    assert.deepEqual(programCommit[0].details, {
        source: 'ai-fallback',
        messageId: 0,
        beforeLength: original.length,
        afterLength: chat[0].mes.length,
    });
    assert.doesNotMatch(JSON.stringify(programCommit[0]), /<content>|正文|尾|末/);
    assert.equal(runtimeState.aiRewrite.debugEvents.some(event => event.stage === 'shujuku-program-commit'), false);
});

test('disabled global AI treats an empty AI replacement list as deletion', () => {
    const original = '<content>正文</content>';
    const chat = [{ is_user: false, mes: original, swipe_id: 0, swipes: [original], swipe_info: [{}] }];
    const session = installRuntime(chat, createSettings({
        subRule: { replacements: [] },
        aiRewrite: { enabled: false },
    }));
    let fetchCount = 0;
    globalThis.fetch = async () => {
        fetchCount += 1;
        return createAiResponse();
    };

    assert.equal(markHostFinalWithProgramCleanse(session, chat), true);

    assert.equal(fetchCount, 0);
    assert.equal(chat[0].mes, '<content></content>');
    assert.equal(runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'atomic-commit').length, 1);
});

test('a disabled collection is excluded from visual, request, and fallback processing for both global AI states', () => {
    for (const aiEnabled of [true, false]) {
        const settings = createSettings({ aiRewrite: { enabled: aiEnabled } });
        settings.rules[0].enabled = false;
        const chat = [{ is_user: false, mes: '<content>正文</content>' }];
        const session = installRuntime(chat, settings);
        let fetchCount = 0;
        globalThis.fetch = async () => {
            fetchCount += 1;
            return createAiResponse();
        };
        runtimeState.isRegexDirty = true;
        buildProcessors();

        assert.equal(applyVisualMask(chat[0].mes), chat[0].mes);
        assert.equal(markHostFinalWithProgramCleanse(session, chat), false);
        assert.equal(fetchCount, 0);
        assert.equal(chat[0].mes, '<content>正文</content>');
        resetAiRewriteRuntimeState('collection-loop');
        generationLifecycle.cancelActive('collection-loop');
    }
});

test('a disabled AI subrule is excluded from visual, request, and fallback processing for both global AI states', () => {
    for (const aiEnabled of [true, false]) {
        const settings = createSettings({
            subRule: { enabled: false },
            aiRewrite: { enabled: aiEnabled },
        });
        const chat = [{ is_user: false, mes: '<content>正文</content>' }];
        const session = installRuntime(chat, settings);
        let fetchCount = 0;
        globalThis.fetch = async () => {
            fetchCount += 1;
            return createAiResponse();
        };
        runtimeState.isRegexDirty = true;
        buildProcessors();

        assert.equal(applyVisualMask(chat[0].mes), chat[0].mes);
        assert.equal(markHostFinalWithProgramCleanse(session, chat), false);
        assert.equal(fetchCount, 0);
        assert.equal(chat[0].mes, '<content>正文</content>');
        resetAiRewriteRuntimeState('subrule-loop');
        generationLifecycle.cancelActive('subrule-loop');
    }
});

test('non-stream MESSAGE_RECEIVED survives deterministic first-swipe materialization', async () => {
    const original = '<content>正文</content>';
    const message = { is_user: false, mes: original };
    const chat = [message];
    const session = installRuntime(chat);
    runtimeState.isStreamingGeneration = false;
    let fetchCount = 0;
    globalThis.fetch = async () => {
        fetchCount += 1;
        return createAiResponse();
    };
    const payload = {
        automatic: true,
        generationId: session.generationId,
        chatId,
        messageId: 0,
        source: 'message-received',
    };

    markHostFinal(session, chat);
    message.swipe_id = 0;
    message.swipes = [original];
    message.swipe_info = [{}];

    assert.equal(validateAiRewriteFinalization(payload).ok, true);
    await waitForAutomaticAiRewrite(session.generationId);

    assert.equal(fetchCount, 1);
    assert.equal(runtimeState.aiRewrite.debugEvents.some(event => (
        event.stage === 'task-cancelled' && event.details?.reason === 'branch-changed'
    )), false);
    assert.equal(runtimeState.aiRewrite.criticalDebugEvents.some(event => event.stage === 'fetch-start'), true);
});

test('a byte-identical later swipe remains stale after non-stream first-swipe identity freezes', async () => {
    const original = '<content>正文</content>';
    const message = { is_user: false, mes: original };
    const chat = [message];
    const session = installRuntime(chat);
    runtimeState.isStreamingGeneration = false;
    let fetchCount = 0;
    globalThis.fetch = async () => {
        fetchCount += 1;
        return createAiResponse();
    };
    const payload = {
        automatic: true,
        generationId: session.generationId,
        chatId,
        messageId: 0,
        source: 'message-received',
    };

    markHostFinal(session, chat);
    message.swipe_id = 0;
    message.swipes = [original];
    message.swipe_info = [{}];
    assert.equal(validateAiRewriteFinalization(payload).ok, true);

    message.swipe_id = 1;
    message.swipes.push(original);
    message.swipe_info.push({});
    message.mes = message.swipes[1];
    assert.equal(message.mes, original);

    const validation = validateAiRewriteFinalization(payload);
    assert.equal(validation.ok, false);
    assert.equal(validation.reason, 'branch-changed');
    await waitForAutomaticAiRewrite(session.generationId);

    assert.equal(fetchCount, 0);
    assert.equal(runtimeState.aiRewrite.debugEvents.some(event => event.stage === 'apply-success'), false);
    assert.equal(runtimeState.aiRewrite.debugEvents.some(event => (
        event.stage === 'task-cancelled' && event.details?.reason === 'branch-changed'
    )), true);
});

test('raw close waits for the host commit before freezing and fetching content', async () => {
    const chat = [{ is_user: false, mes: '<content>正文' }];
    const session = installRuntime(chat);
    const requests = [];
    globalThis.fetch = async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return createAiResponse();
    };

    maybeNotifyAiRewriteReadyFromStreamingText(0, closedContent, {
        generationId: session.generationId,
        chatId,
        source: 'streaming',
    });
    await flushScheduledWork();

    assert.equal(requests.length, 0);
    assert.equal(runtimeState.aiRewrite.contentIdentityByGenerationId.size, 0);
    assert.equal(runtimeState.aiRewrite.statusToast, null);

    notifyCommittedStreamingContent(session, chat, `${closedContent}${tail}`);
    await flushScheduledWork();

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'TavernHelper.generateRaw');
    assert.match(requests[0].body.generation_id, /^veridis-ai-rewrite-/);
    assert.equal(requests[0].body.should_stream, false);
    assert.deepEqual(requests[0].body.custom_api, {
        apiurl: 'https://rewrite.example/v1',
        key: 'rewrite-test-key',
        model: 'rewrite-pro',
        source: 'custom',
        temperature: 0.3,
        top_p: 1,
        top_k: 0,
        frequency_penalty: 0,
        presence_penalty: 0,
        max_tokens: 'unset',
        custom_include_body: {
            response_format: { type: 'json_object' },
        },
    });
    assert.match(requests[0].body.messages[0].content, /正文/);
    assert.doesNotMatch(requests[0].body.messages[0].content, /状态栏|小剧场/);
    assert.equal(runtimeState.aiRewrite.pendingApplyByKey.size, 1);
    const criticalStages = runtimeState.aiRewrite.criticalDebugEvents.map(event => event.stage);
    assert.equal(criticalStages.includes('content-snapshot-frozen'), true);
    assert.equal(criticalStages.includes('request-claimed'), true);
    assert.equal(criticalStages.includes('fetch-start'), true);
    assert.equal(criticalStages.includes('response-deferred'), true);

    markHostFinal(session, chat);
    await flushScheduledWork();
    assert.equal(chat[0].mes, `<content>改写正文</content>${tail}`);
    assert.equal(requests.length, 1);
});

test('streaming completion keeps the accepted run timestamp through the final-cleanse wait', async () => {
    await withMockedNow(1000, async (setNow) => {
        const chat = [{ is_user: false, mes: '<content>正文' }];
        const session = installRuntime(chat);
        const toastHarness = installDismissibleToastHarness();
        globalThis.fetch = async () => {
            setNow(2500);
            return createAiResponse();
        };

        notifyCommittedStreamingContent(session, chat, `${closedContent}${tail}`);
        await waitForAutomaticAiRewrite(session.generationId);

        assert.equal(runtimeState.aiRewrite.pendingApplyByKey.size, 1);
        assert.equal(toastHarness.calls.some(call => call.type === 'success'), false);

        setNow(6000);
        markHostFinal(session, chat);

        assert.equal(chat[0].mes, `<content>改写正文</content>${tail}`);
        assert.equal(runtimeState.aiRewrite.pendingApplyByKey.size, 0);
        assert.equal(toastHarness.calls.find(call => call.type === 'success')?.message, '已应用 1 段改写 · 用时 5.0 秒');
    });
});

test('raw stream differences are excluded from committed request identity and prompt', async () => {
    const chat = [{ is_user: false, mes: '<content>旧正文</content>' }];
    const session = installRuntime(chat);
    const requests = [];
    globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return createAiResponse();
    };
    const rawStreamingText = '<think>仅存在于流式事件中的内部思考</think>\n<content>原始正文</content>';

    maybeNotifyAiRewriteReadyFromStreamingText(0, rawStreamingText, {
        generationId: session.generationId,
        chatId,
        source: 'streaming',
    });
    await flushScheduledWork();
    assert.equal(requests.length, 0);
    assert.equal(runtimeState.aiRewrite.contentIdentityByGenerationId.size, 0);

    notifyCommittedStreamingContent(session, chat, `${closedContent}${tail}`);
    await flushScheduledWork();

    assert.equal(requests.length, 1);
    assert.doesNotMatch(requests[0].messages[0].content, /内部思考|原始正文|旧正文|<think>/);
    assert.doesNotMatch(requests[0].messages[0].content, /状态栏|小剧场/);
});

test('empty XML scope waits for final and rewrites matching text across the whole message', async () => {
    const original = '前文正文后文';
    const chat = [{ is_user: false, mes: original }];
    const session = installRuntime(chat, createSettings({
        aiRewrite: { xmlScopeTag: '' },
    }));
    const requests = [];
    globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return createAiResponse();
    };

    notifyCommittedStreamingContent(session, chat, original);
    await flushScheduledWork();

    assert.equal(requests.length, 0);
    assert.equal(runtimeState.aiRewrite.contentIdentityByGenerationId.size, 0);

    runtimeState.isStreamingGeneration = false;
    chat[0].swipe_id = 0;
    chat[0].swipes = [original];
    chat[0].swipe_info = [{}];
    markHostFinal(session, chat);
    await flushScheduledWork();

    assert.equal(requests.length, 1);
    assert.match(requests[0].messages[0].content, /前文<rewrite_target id="hit-1" candidates="c1">正文<\/rewrite_target>后文/);
    assert.equal(chat[0].mes, '前文改写正文后文');
});

test('host final before the scheduler callback satisfies the streaming apply barrier', async () => {
    const chat = [{ is_user: false, mes: '<content>正文' }];
    const session = installRuntime(chat);
    let fetchCount = 0;
    globalThis.fetch = async () => {
        fetchCount += 1;
        return createAiResponse();
    };

    notifyCommittedStreamingContent(session, chat, `${closedContent}${tail}`);
    assert.equal(session.requestState, 'scheduled');

    runtimeState.isStreamingGeneration = false;
    markHostFinal(session, chat);
    await flushScheduledWork();

    assert.equal(fetchCount, 1);
    assert.equal(chat[0].mes, `<content>改写正文</content>${tail}`);
    assert.equal(runtimeState.aiRewrite.pendingApplyByKey.size, 0);
});

test('host final can precede AI response and latest tail is preserved', async () => {
    const chat = [{ is_user: false, mes: '<content>正文' }];
    const session = installRuntime(chat);
    let resolveFetch;
    let fetchCount = 0;
    globalThis.fetch = () => {
        fetchCount += 1;
        return new Promise(resolve => { resolveFetch = resolve; });
    };

    notifyCommittedStreamingContent(session, chat, `${closedContent}${tail}`);
    await flushScheduledWork();
    assert.equal(fetchCount, 1);

    markHostFinal(session, chat);
    resolveFetch(createAiResponse());
    await flushScheduledWork();

    assert.equal(chat[0].mes, `<content>改写正文</content>${tail}`);
    assert.equal(fetchCount, 1);
});

test('MVU tail generation and AI rewrite run in parallel and commit once', async () => {
    const original = `${closedContent}${tail}`;
    const chat = [{ is_user: false, mes: original }];
    const session = installRuntime(chat);
    let resolveFetch;
    let fetchCount = 0;
    globalThis.fetch = () => {
        fetchCount += 1;
        return new Promise(resolve => { resolveFetch = resolve; });
    };

    notifyCommittedStreamingContent(session, chat, original);
    await flushScheduledWork();
    assert.equal(fetchCount, 1);

    const mvuText = `${original}\n<UpdateVariable>{"stat":{"value":1}}</UpdateVariable>`;
    const payload = {
        automatic: true,
        generationId: session.generationId,
        chatId,
        messageId: 0,
        source: 'mvu-before-message-update',
    };
    const adoption = adoptMvuMessageContentForAiRewrite(payload, mvuText);
    assert.equal(adoption.ok, true);
    markAiRewriteFinalCleanseReady(payload, { scheduleRequest: false });

    resolveFetch(createAiResponse());
    await waitForAutomaticAiRewrite(session.generationId);

    assert.equal(chat[0].mes, `<content>改写正文</content>${tail}\n<UpdateVariable>{"stat":{"value":1}}</UpdateVariable>`);
    assert.equal(fetchCount, 1);
    assert.equal(runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'atomic-commit').length, 1);
});

test('streaming request failure defers program fallback until the final commit', async () => {
    const original = `${closedContent}${tail}`;
    const chat = [{ is_user: false, mes: original }];
    const session = installRuntime(chat);
    globalThis.fetch = async () => {
        throw new Error('临时失败');
    };

    notifyCommittedStreamingContent(session, chat, original);
    await flushScheduledWork();

    assert.equal(chat[0].mes, original);
    assert.equal(runtimeState.aiRewrite.pendingApplyByKey.size, 1);

    markHostFinal(session, chat);
    await flushScheduledWork();

    assert.equal(chat[0].mes, `<content>程序正文</content>${tail}`);
    assert.equal(runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'atomic-commit').length, 1);
});

test('content mutation before run keeps the claimed task and applies against current text', async () => {
    const chat = [{ is_user: false, mes: '<content>正文' }];
    const session = installRuntime(chat);
    let fetchCount = 0;
    globalThis.fetch = async () => {
        fetchCount += 1;
        return createAiResponse();
    };

    notifyCommittedStreamingContent(session, chat, `${closedContent}${tail}`);
    chat[0].mes = `<content>正文已编辑</content>${tail}`;
    await flushScheduledWork();

    assert.equal(fetchCount, 1);
    assert.equal(session.requestState, 'succeeded');
    assert.equal(runtimeState.aiRewrite.pendingApplyByKey.size, 1);

    markHostFinal(session, chat);
    await flushScheduledWork();

    assert.equal(chat[0].mes, `<content>改写正文已编辑</content>${tail}`);
    assert.equal(runtimeState.aiRewrite.pendingApplyByKey.size, 0);
});

test('changed offsets use exact anchors to relocate only the intended occurrence', async () => {
    const original = '<content>左锚正文右锚</content>';
    const chat = [{ is_user: false, mes: original }];
    installRuntime(chat, createSettings({
        subRule: { replacements: ['正文'] },
    }));
    let resolveFetch;
    globalThis.fetch = () => new Promise(resolve => { resolveFetch = resolve; });

    assert.equal(requestManualAiRewriteForMessage(0), true);
    await flushScheduledWork();
    chat[0].mes = '<content>新增的正文；左锚正文右锚</content>';
    resolveFetch(createAiResponse());
    await flushScheduledWork();

    assert.equal(chat[0].mes, '<content>新增的正文；左锚改写正文右锚</content>');
    const applySuccess = runtimeState.aiRewrite.debugEvents.find(event => event.stage === 'apply-success');
    assert.ok(applySuccess);
    assert.deepEqual(applySuccess.details?.strategies, ['anchor']);
    assert.equal(runtimeState.aiRewrite.debugEvents.some(event => (
        event.stage === 'program-commit' && event.details?.source === 'ai-finalization'
    )), false);
});

test('ambiguous exact relocation skips without modifying either occurrence', async () => {
    const original = '<content>左锚正文右锚</content>';
    const chat = [{ is_user: false, mes: original }];
    installRuntime(chat, createSettings({
        subRule: { replacements: ['正文'] },
    }));
    let resolveFetch;
    globalThis.fetch = () => new Promise(resolve => { resolveFetch = resolve; });

    assert.equal(requestManualAiRewriteForMessage(0), true);
    await flushScheduledWork();
    const ambiguousText = '<content>正文；正文</content>';
    chat[0].mes = ambiguousText;
    resolveFetch(createAiResponse());
    await flushScheduledWork();

    assert.equal(chat[0].mes, ambiguousText);
    assert.equal(runtimeState.aiRewrite.debugEvents.some(event => event.stage === 'apply-success'), false);
    assert.equal(runtimeState.aiRewrite.debugEvents.some(event => (
        event.stage === 'apply-skip' && event.details?.reason === 'item-locate-failed'
    )), true);
});

test('direct finalization validation allows any content change for a frozen streaming task', async () => {
    const chat = [{ is_user: false, mes: '<content>正文' }];
    const session = installRuntime(chat);
    globalThis.fetch = () => new Promise(() => {});

    notifyCommittedStreamingContent(session, chat, `${closedContent}${tail}`);
    chat[0].mes = `<content>正文已编辑</content>${tail}`;

    const validation = validateAiRewriteFinalization({
        automatic: true,
        generationId: session.generationId,
        chatId,
        messageId: 0,
        source: 'message-received',
    });
    assert.equal(validation.ok, true);
    assert.equal(validation.identity.messageRef, chat[0]);
});

test('target validation keeps internal cleanse acknowledgement valid after content changes', () => {
    const chat = [{ is_user: false, mes: '<content>正文' }];
    const session = installRuntime(chat);
    globalThis.fetch = () => new Promise(() => {});
    const payload = {
        automatic: true,
        generationId: session.generationId,
        chatId,
        messageId: 0,
        source: 'message-received',
    };

    notifyCommittedStreamingContent(session, chat, `${closedContent}${tail}`);
    assert.equal(validateAiRewriteMessageTarget(payload).ok, true);

    const beforeText = chat[0].mes;
    chat[0].mes = `<content>程序正文</content>${tail}`;
    assert.equal(generationLifecycle.acknowledgeInternalMessageMutation(session.generationId, {
        chatId,
        chat,
        messageId: 0,
        messageRef: chat[0],
        beforeText,
        afterText: chat[0].mes,
        source: 'direct-final-cleanse',
    }).ok, true);
    assert.equal(validateAiRewriteMessageTarget({ ...payload, source: 'direct-final-cleanse' }).ok, true);
    assert.equal(validateAiRewriteFinalization(payload).ok, true);
});

test('new generation supersedes scheduled task and clears its popup before fetch', async () => {
    const chat = [{ is_user: false, mes: '<content>正文' }];
    const oldSession = installRuntime(chat);
    let fetchCount = 0;
    globalThis.fetch = async () => {
        fetchCount += 1;
        return createAiResponse();
    };

    notifyCommittedStreamingContent(oldSession, chat, closedContent);
    const newSession = generationLifecycle.startGeneration({ chatId, chat, mode: 'regenerate' });
    handleAiRewriteGenerationStarted(newSession);
    await flushScheduledWork();

    assert.equal(fetchCount, 0);
    assert.equal(oldSession.requestState, 'superseded');
    assert.equal(runtimeState.aiRewrite.statusToast, null);
    assert.equal(runtimeState.aiRewrite.activeController, null);
    assert.equal(runtimeState.aiRewrite.pendingApplyByKey.size, 0);
    assert.equal(runtimeState.aiRewrite.contentIdentityByGenerationId.size, 0);
});

test('repeated final cleanse cannot schedule the same automatic request twice', async () => {
    const chat = [{
        is_user: false,
        mes: closedContent,
        swipe_id: 0,
        swipes: [closedContent],
        swipe_info: [{}],
    }];
    const session = installRuntime(chat);
    runtimeState.isStreamingGeneration = false;
    let fetchCount = 0;
    globalThis.fetch = async () => {
        fetchCount += 1;
        return createAiResponse();
    };
    const payload = {
        automatic: true,
        generationId: session.generationId,
        chatId,
        messageId: 0,
        source: 'message-received',
    };
    generationLifecycle.bindMessage(0, {
        generationId: session.generationId,
        chatId,
        chat,
        source: 'message-received',
    });
    generationLifecycle.markFinalSource(session.generationId, 'message-received');

    markAiRewriteFinalCleanseReady(payload);
    markAiRewriteFinalCleanseReady(payload);
    await waitForAutomaticAiRewrite(session.generationId);

    assert.equal(fetchCount, 1);
});

test('a second manual request cannot enter while the same task is running', async () => {
    const chat = [{ is_user: false, mes: closedContent }];
    installRuntime(chat);
    let resolveFetch;
    let fetchCount = 0;
    globalThis.fetch = () => {
        fetchCount += 1;
        return new Promise(resolve => {
            resolveFetch = resolve;
        });
    };

    assert.equal(requestManualAiRewriteForMessage(0), true);
    assert.equal(requestManualAiRewriteForMessage(0), false);
    assert.equal(fetchCount, 1);

    resolveFetch(createAiResponse());
    await flushScheduledWork();
    assert.equal(chat[0].mes, '<content>改写正文</content>');
});

test('manual rewrite still fetches once and preserves content tail', async () => {
    const chat = [{ is_user: false, mes: `${closedContent}${tail}` }];
    installRuntime(chat);
    let fetchCount = 0;
    globalThis.fetch = async () => {
        fetchCount += 1;
        return createAiResponse();
    };

    assert.equal(requestManualAiRewriteForMessage(0), true);
    await flushScheduledWork();

    assert.equal(fetchCount, 1);
    assert.equal(chat[0].mes, `<content>改写正文</content>${tail}`);
});

test('manual rewrite success appends the accepted run duration to one decimal place', async () => {
    await withMockedNow(1000, async (setNow) => {
        const chat = [{ is_user: false, mes: closedContent }];
        installRuntime(chat);
        const toastHarness = installDismissibleToastHarness();
        globalThis.fetch = async () => {
            setNow(4500);
            return createAiResponse();
        };

        assert.equal(requestManualAiRewriteForMessage(0), true);
        await flushScheduledWork();

        const success = toastHarness.calls.find(call => call.type === 'success');
        assert.deepEqual({ title: success?.title, message: success?.message }, {
            title: 'AI 改写成功',
            message: '已应用 1 段改写 · 用时 3.5 秒',
        });
    });
});

test('closing the progress toast hides it while the background rewrite continues', async () => {
    const chat = [{ is_user: false, mes: '<content>甲，乙，丙</content>' }];
    installRuntime(chat, createSettings({
        subRule: { targets: ['甲', '乙', '丙'], replacements: [] },
        aiRewrite: { maxItemsPerRequest: 2 },
    }));
    const toastHarness = installDismissibleToastHarness();
    let releaseFirstRequest;
    const firstRequestGate = new Promise(resolve => {
        releaseFirstRequest = resolve;
    });
    let fetchCount = 0;
    globalThis.fetch = async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
            await firstRequestGate;
            return createAiResponseForEntries([
                { id: 'hit-1', rewritten: '甲甲' },
                { id: 'hit-2', rewritten: '乙乙' },
            ]);
        }
        if (fetchCount === 3) {
            return createAiResponseForEntries([
                { id: 'hit-1', rewritten: '甲甲' },
                { id: 'hit-2', rewritten: '乙乙' },
            ]);
        }
        return createAiResponseForId('hit-3', '丙丙');
    };
    let stopCallCount = 0;
    globalThis.TavernHelper.stopGenerationById = () => {
        stopCallCount += 1;
        return true;
    };

    assert.equal(requestManualAiRewriteForMessage(0), true);
    await flushScheduledWork();
    assert.equal(fetchCount, 1);
    const progressToast = toastHarness.calls.find(call => call.options?.timeOut === 0);
    assert.ok(progressToast);
    const taskKey = runtimeState.aiRewrite.statusTaskKey;
    assert.ok(taskKey);
    assert.ok(runtimeState.aiRewrite.activeController);

    progressToast.closeButton.click();

    assert.equal(progressToast.toastElement.removed, true);
    assert.equal(runtimeState.aiRewrite.statusToast, null);
    assert.equal(runtimeState.aiRewrite.statusTaskKey, '');
    assert.equal(runtimeState.aiRewrite.statusDismissedTaskKey, taskKey);
    assert.ok(runtimeState.aiRewrite.activeController);
    assert.equal(runtimeState.aiRewrite.cancelledKeys.has(taskKey), false);
    assert.equal(stopCallCount, 0);

    releaseFirstRequest();
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.equal(fetchCount, 2);
    assert.equal(chat[0].mes, '<content>甲甲，乙乙，丙丙</content>');
    assert.equal(stopCallCount, 0);
    assert.equal(toastHarness.calls.filter(call => call.options?.timeOut === 0).length, 1);
    assert.equal(runtimeState.aiRewrite.statusDismissedTaskKey, '');

    chat.push({ is_user: false, mes: '<content>甲，乙，丙</content>' });
    assert.equal(requestManualAiRewriteForMessage(1), true);
    await flushScheduledWork();

    assert.equal(fetchCount, 4);
    assert.equal(chat[1].mes, '<content>甲甲，乙乙，丙丙</content>');
    assert.equal(toastHarness.calls.filter(call => call.options?.timeOut === 0).length, 3);
});

test('terminating from the progress toast does not add elapsed time to termination-path notices', async () => {
    const chat = [{ is_user: false, mes: closedContent }];
    installRuntime(chat);
    const toastHarness = installDismissibleToastHarness();
    let resolveFetch;
    globalThis.fetch = () => new Promise(resolve => {
        resolveFetch = resolve;
    });
    let stopCallCount = 0;
    globalThis.TavernHelper.stopGenerationById = () => {
        stopCallCount += 1;
        return true;
    };

    assert.equal(requestManualAiRewriteForMessage(0), true);
    await flushScheduledWork();

    const progressToast = toastHarness.calls.find(call => call.options?.timeOut === 0);
    const actions = progressToast?.toastElement.children.find(child => child.className === 'blai-ai-toast-actions');
    const stopButton = actions?.children[0];
    assert.ok(stopButton);
    stopButton.listeners.get('click')({
        preventDefault() {},
        stopPropagation() {},
    });

    assert.equal(stopButton.disabled, true);
    assert.equal(stopButton.textContent, '终止中');
    assert.equal(stopCallCount, 1);
    assert.equal(toastHarness.calls.some(call => / · 用时 \d+\.\d 秒$/.test(`${call.title} ${call.message}`)), false);

    resolveFetch(createAiResponse());
    await flushScheduledWork();
    assert.equal(chat[0].mes, closedContent);
    assert.equal(toastHarness.calls.some(call => call.type === 'success'), false);
});

test('explicit AI rewrite after a manual final uses the manual text as its request source', async () => {
    const chat = [{ is_user: false, mes: '<content>正文手动保留</content>' }];
    installRuntime(chat);
    writeMessageDiffMeta(chat[0], 'main', '<content>正文原始</content>', '<content>程序正文</content>', 'source-signature');
    writeMessageDiffAiTrace(chat[0], 'main', '<content>程序正文</content>', '<content>AI 正文</content>');
    writeMessageDiffManualFinal(chat[0], 'main');

    let requestBody;
    globalThis.fetch = async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return createAiResponse();
    };

    assert.equal(requestManualAiRewriteForMessage(0), true);
    await flushScheduledWork();

    const prompt = requestBody.messages[0].content;
    assert.match(prompt, /手动保留/);
    assert.doesNotMatch(prompt, /正文原始/);
    assert.equal(chat[0].mes, '<content>改写正文手动保留</content>');
});

test('request failure shows the API error in the fallback popup', async () => {
    const chat = [{ is_user: false, mes: '<content>正文</content>' }];
    installRuntime(chat);
    const toastHarness = installDismissibleToastHarness();
    globalThis.fetch = async () => {
        throw new Error('Bad Gateway');
    };

    assert.equal(requestManualAiRewriteForMessage(0), true);
    await flushScheduledWork();

    assert.equal(chat[0].mes, '<content>程序正文</content>');
    const warning = toastHarness.calls.find(call => call.type === 'warning');
    assert.deepEqual({ message: warning?.message, title: warning?.title }, {
        message: '',
        title: 'Bad Gateway',
    });
    assert.equal(warning?.toastElement.classList.contains('blai-ai-rewrite-toast'), true);
    assert.equal(warning?.toastElement.classList.contains('blai-ai-rewrite-progress-toast'), false);
    assert.equal(warning?.toastElement.querySelector('.blai-ai-toast-actions'), null);
    assert.equal(toastHarness.calls.some(({ message, title }) => / · 用时 \d+\.\d 秒$/.test(`${title} ${message}`)), false);
});

test('manual rewrite accepts an empty replacement as an intentional local deletion', async () => {
    const chat = [{ is_user: false, mes: '<content>弹幕数量突然翻了一倍。</content>' }];
    installRuntime(chat, createSettings({
        subRule: { targets: ['突然'], replacements: [] },
    }));
    const requests = [];
    globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return createAiResponse('');
    };

    assert.equal(requestManualAiRewriteForMessage(0), true);
    await flushScheduledWork();

    assert.equal(chat[0].mes, '<content>弹幕数量翻了一倍。</content>');
    assert.match(requests[0].messages[0].content, /<rewrite_target id="hit-1">突然<\/rewrite_target>/);
    assert.doesNotMatch(requests[0].messages[0].content, /beforeContext|afterContext|matchedTerms|rewriteGroups/);
    assert.match(requests[0].messages[0].content, /空字符串表示删除|删除目标文本时返回空字符串/);
    assert.equal(runtimeState.aiRewrite.debugEvents.some(event => event.stage === 'fallback-applied'), false);
});

test('prompt deduplicates rules and candidate sets while marking targets inline once', async () => {
    const chat = [{ is_user: false, mes: '<content>甲和乙</content>' }];
    installRuntime(chat, createSettings({
        subRule: {
            targets: ['甲', '乙'],
            replacements: ['本地候选'],
            aiPromptTemplate: '保持克制',
        },
    }));
    const requests = [];
    globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return createAiResponseForEntries([
            { id: 'hit-1', rewritten: '甲改' },
            { id: 'hit-2', rewritten: '乙改' },
        ]);
    };

    assert.equal(requestManualAiRewriteForMessage(0), true);
    await flushScheduledWork();

    const prompt = requests[0].messages[0].content;
    assert.equal((prompt.match(/保持克制/g) || []).length, 1);
    assert.equal((prompt.match(/本地候选/g) || []).length, 1);
    assert.match(prompt, /<rewrite_rules>\s*{"r1":"保持克制"}\s*<\/rewrite_rules>/);
    assert.match(prompt, /<local_fallback_candidates>\s*{"c1":\["本地候选"\]}\s*<\/local_fallback_candidates>/);
    assert.match(prompt, /<rewrite_target id="hit-1" rules="r1" candidates="c1">甲<\/rewrite_target>/);
    assert.match(prompt, /<rewrite_target id="hit-2" rules="r1" candidates="c1">乙<\/rewrite_target>/);
    assert.doesNotMatch(prompt, /beforeContext|afterContext|matchedTerms|rewriteGroups|"rewrites"/);
    assert.equal(chat[0].mes, '<content>甲改和乙改</content>');
});

test('whole-sentence output for a tiny hit is rejected instead of being inserted at the hit', async () => {
    const original = '<content>弹幕仿佛卡壳了两秒，紧接着，数量突然翻了一倍。</content>';
    const chat = [{ is_user: false, mes: original }];
    installRuntime(chat, createSettings({
        subRule: { targets: ['突然'], replacements: [] },
    }));
    globalThis.fetch = async () => createAiResponse('弹幕仿佛卡壳了两秒，紧接着，数量翻了一倍。');

    assert.equal(requestManualAiRewriteForMessage(0), true);
    await flushScheduledWork();

    assert.equal(chat[0].mes, original);
    assert.equal(chat[0].mes.includes('弹幕仿佛卡壳了两秒，紧接着，数量弹幕'), false);
    assert.equal(runtimeState.aiRewrite.debugEvents.some(event => event.stage === 'fallback-applied'), false);
});

test('max items is a per-request batch size and does not discard later hits', async () => {
    const chat = [{ is_user: false, mes: '<content>甲，乙，丙</content>' }];
    installRuntime(chat, createSettings({
        subRule: { targets: ['甲', '乙', '丙'], replacements: [] },
        aiRewrite: { maxItemsPerRequest: 2 },
    }));
    let fetchCount = 0;
    globalThis.fetch = async () => {
        fetchCount += 1;
        return fetchCount === 1
            ? createAiResponseForEntries([
                { id: 'hit-1', rewritten: '甲甲' },
                { id: 'hit-2', rewritten: '乙乙' },
            ])
            : createAiResponseForId('hit-3', '丙丙');
    };

    assert.equal(requestManualAiRewriteForMessage(0), true);
    await flushScheduledWork();

    assert.equal(fetchCount, 2);
    assert.equal(chat[0].mes, '<content>甲甲，乙乙，丙丙</content>');
});

test('user-defined batch size above 32 remains a single request', async () => {
    const targets = Array.from({ length: 33 }, (_, index) => `词${String(index + 1).padStart(2, '0')}`);
    const chat = [{ is_user: false, mes: `<content>${targets.join('，')}</content>` }];
    installRuntime(chat, createSettings({
        subRule: { targets, replacements: [] },
        aiRewrite: { maxItemsPerRequest: 40 },
    }));
    let fetchCount = 0;
    globalThis.fetch = async () => {
        fetchCount += 1;
        return createAiResponseForEntries(targets.map((target, index) => ({
            id: `hit-${index + 1}`,
            rewritten: `${target}改`,
        })));
    };

    assert.equal(requestManualAiRewriteForMessage(0), true);
    await flushScheduledWork();

    assert.equal(fetchCount, 1);
    assert.equal(chat[0].mes, `<content>${targets.map(target => `${target}改`).join('，')}</content>`);
});

test('processing popup changes to an explicit retry state across retries and batches', async () => {
    const chat = [{ is_user: false, mes: '<content>甲，乙，丙</content>' }];
    installRuntime(chat, createSettings({
        subRule: { targets: ['甲', '乙', '丙'], replacements: [] },
        aiRewrite: { maxItemsPerRequest: 2, maxRetries: 1 },
    }));
    const statusCalls = [];
    globalThis.toastr = {
        info: (message, title, options) => {
            statusCalls.push({ type: 'info', title, message, options });
            return {};
        },
        success: (message, title, options) => {
            statusCalls.push({ type: 'success', title, message, options });
            return {};
        },
        warning: (message, title, options) => {
            statusCalls.push({ type: 'warning', title, message, options });
            return {};
        },
        error: (message, title, options) => {
            statusCalls.push({ type: 'error', title, message, options });
            return {};
        },
        clear: () => {},
        remove: () => {},
    };

    let fetchCount = 0;
    globalThis.fetch = async () => {
        fetchCount += 1;
        if (fetchCount === 1) throw new Error('临时失败');
        if (fetchCount === 2) return createAiResponseForEntries([
            { id: 'hit-1', rewritten: '甲甲' },
            { id: 'hit-2', rewritten: '乙乙' },
        ]);
        return createAiResponseForId('hit-3', '丙丙');
    };

    assert.equal(requestManualAiRewriteForMessage(0), true);
    await flushScheduledWork();

    assert.equal(fetchCount, 3);
    assert.equal(chat[0].mes, '<content>甲甲，乙乙，丙丙</content>');
    const progressCalls = statusCalls.filter(call => call.options?.timeOut === 0);
    assert.ok(progressCalls.length >= 3);
    assert.equal(progressCalls[0].title, 'AI 改写中');
    assert.match(progressCalls[0].message, /^命中 3 处 · 正在处理 1\/2…$/);
    const retryCalls = progressCalls.filter(call => call.title === 'AI 改写重试中');
    assert.ok(retryCalls.length >= 2);
    assert.equal(retryCalls.every(call => /^命中 3 处 · 正在重试 1\/1 · 处理 [12]\/2…$/.test(call.message)), true);
    assert.equal(progressCalls.some(call => /AI规则|文本命中|本批|最终净化|写回/.test(call.message)), false);
    assert.equal(progressCalls.some(call => / · 用时 \d+\.\d 秒$/.test(call.message)), false);
});

test('retries and request batches retain one accepted run timestamp', async () => {
    await withMockedNow(1000, async (setNow) => {
        const chat = [{ is_user: false, mes: '<content>甲，乙，丙</content>' }];
        installRuntime(chat, createSettings({
            subRule: { targets: ['甲', '乙', '丙'], replacements: [] },
            aiRewrite: { maxItemsPerRequest: 2, maxRetries: 1 },
        }));
        const toastHarness = installDismissibleToastHarness();
        let fetchCount = 0;
        globalThis.fetch = async () => {
            fetchCount += 1;
            if (fetchCount === 1) {
                setNow(1800);
                throw new Error('临时失败');
            }
            if (fetchCount === 2) {
                setNow(2800);
                return createAiResponseForEntries([
                    { id: 'hit-1', rewritten: '甲甲' },
                    { id: 'hit-2', rewritten: '乙乙' },
                ]);
            }
            setNow(5000);
            return createAiResponseForId('hit-3', '丙丙');
        };

        assert.equal(requestManualAiRewriteForMessage(0), true);
        await flushScheduledWork();

        assert.equal(fetchCount, 3);
        assert.equal(chat[0].mes, '<content>甲甲，乙乙，丙丙</content>');
        const successToast = toastHarness.calls.find(call => call.type === 'success');
        const progressToast = toastHarness.calls.find(call => call.options?.timeOut === 0);
        assert.equal(successToast?.message, '已应用 3 段改写 · 用时 4.0 秒');
        assert.equal(toastHarness.calls.every(call => call.toastElement.classList.contains('blai-ai-rewrite-toast')), true);
        assert.equal(progressToast?.toastElement.classList.contains('blai-ai-rewrite-toast'), true);
        assert.equal(progressToast?.toastElement.classList.contains('blai-ai-rewrite-progress-toast'), true);
        assert.ok(progressToast?.toastElement.querySelector('.blai-ai-toast-actions'));
        assert.equal(toastHarness.calls.filter(call => call.options?.timeOut !== 0).every(call => (
            call.toastElement.classList.contains('blai-ai-rewrite-progress-toast') === false
            && call.toastElement.querySelector('.blai-ai-toast-actions') === null
        )), true);
        assert.equal(toastHarness.calls.filter(call => call.options?.timeOut === 0).some(call => / · 用时 /.test(call.message)), false);
    });
});

test('message data and renderer stay untouched until one final atomic commit', async () => {
    const original = '<content>正文</content>尾';
    const chat = [{ is_user: false, mes: original }];
    const settings = createSettings();
    settings.rules.push({
        enabled: true,
        name: 'normal cleanse',
        subRules: [{
            enabled: true,
            rewriteMode: 'program',
            mode: 'text',
            targets: ['尾'],
            replacements: ['末'],
        }],
    });
    const rendererCalls = [];
    installRuntime(chat, settings, {
        updateMessageBlock: (index, message) => rendererCalls.push({ index, mes: message.mes }),
    });
    runtimeState.isRegexDirty = true;

    let resolveFetch;
    globalThis.fetch = () => new Promise(resolve => { resolveFetch = resolve; });

    assert.equal(requestManualAiRewriteForMessage(0), true);
    await flushScheduledWork();
    assert.equal(chat[0].mes, original);
    assert.equal(rendererCalls.length, 0);

    resolveFetch(createAiResponse());
    await flushScheduledWork();

    assert.equal(chat[0].mes, '<content>改写正文</content>末');
    assert.deepEqual(rendererCalls, [{ index: 0, mes: '<content>改写正文</content>末' }]);
    assert.equal(runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'atomic-commit').length, 1);
    const programCommit = runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'program-commit');
    assert.equal(programCommit.length, 1);
    assert.deepEqual(programCommit[0].details, {
        source: 'ai-finalization',
        messageId: 0,
        beforeLength: original.length,
        afterLength: '<content>正文</content>末'.length,
    });
    assert.doesNotMatch(JSON.stringify(programCommit[0]), /<content>|正文|尾|末|改写/);
    assert.equal(runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'apply-success').length, 1);
    assert.equal(runtimeState.aiRewrite.debugEvents.some(event => event.stage === 'shujuku-program-commit'), false);
});

test('deleting an earlier floor invalidates a rewrite bound to the old message index', async () => {
    const target = { is_user: false, mes: '<content>正文</content>' };
    const chat = [{ is_user: true, mes: 'older user' }, target];
    installRuntime(chat);

    let resolveFetch;
    globalThis.fetch = () => new Promise(resolve => { resolveFetch = resolve; });

    assert.equal(requestManualAiRewriteForMessage(1), true);
    await flushScheduledWork();
    chat.splice(0, 1);
    resolveFetch(createAiResponse());
    await flushScheduledWork();

    assert.equal(chat.length, 1);
    assert.equal(chat[0], target);
    assert.equal(chat[0].mes, '<content>正文</content>');
});

test('a scheduled automatic payload is stale after its bound message index changes', () => {
    const target = { is_user: false, mes: '<content>正文</content>' };
    const chat = [{ is_user: true, mes: 'older user' }, target];
    const session = installRuntime(chat);
    assert.equal(generationLifecycle.bindMessage(1, {
        generationId: session.generationId,
        chatId,
        chat,
        source: 'message-received',
    }).ok, true);
    const payload = {
        automatic: true,
        generationId: session.generationId,
        chatId,
        messageId: 1,
        source: 'message-received',
    };

    chat.splice(0, 1);
    const validation = validateAiRewriteFinalization(payload);

    assert.equal(validation.ok, false);
    assert.equal(validation.reason, 'message-reference-changed');
    assert.equal(payload.messageId, 1);
});

test('deleting an earlier swipe invalidates an in-flight rewrite bound to the old branch', async () => {
    const original = '<content>正文</content>';
    const message = {
        is_user: false,
        mes: original,
        swipe_id: 1,
        swipes: ['<content>上一页</content>', original, '<content>下一页</content>'],
    };
    const chat = [message];
    installRuntime(chat);

    let resolveFetch;
    globalThis.fetch = () => new Promise(resolve => { resolveFetch = resolve; });

    assert.equal(requestManualAiRewriteForMessage(0), true);
    await flushScheduledWork();
    message.swipes.splice(0, 1);
    message.swipe_id = 0;

    resolveFetch(createAiResponse());
    await flushScheduledWork();

    assert.equal(message.mes, original);
    assert.equal(message.swipes[0], original);
    assert.equal(message.swipes[1], '<content>下一页</content>');
});

test('AI final commit survives editing and a multiple-swipe round trip', async () => {
    const original = '<content>正文</content>';
    const chat = [{
        is_user: false,
        mes: original,
        extra: { display_text: original },
        swipe_id: 1,
        swipes: ['<content>上一页</content>', original],
        swipe_info: [
            { extra: { display_text: '<content>上一页</content>' } },
            { extra: { display_text: original } },
        ],
    }];
    installRuntime(chat);
    globalThis.fetch = async () => createAiResponse();

    assert.equal(requestManualAiRewriteForMessage(0), true);
    await flushScheduledWork();

    const aiFinal = '<content>改写正文</content>';
    assert.equal(chat[0].mes, aiFinal);
    assert.equal(chat[0].swipes[1], aiFinal);
    assert.equal(Object.hasOwn(chat[0].extra, 'display_text'), false);
    assert.equal(Object.hasOwn(chat[0].swipe_info[1].extra, 'display_text'), false);

    const editorInitialValue = chat[0].mes;
    assert.equal(editorInitialValue, aiFinal);

    chat[0].swipe_id = 0;
    chat[0].mes = chat[0].swipes[0];
    chat[0].extra = structuredClone(chat[0].swipe_info[0].extra);
    chat[0].swipe_id = 1;
    chat[0].mes = chat[0].swipes[1];
    chat[0].extra = structuredClone(chat[0].swipe_info[1].extra);
    assert.equal(chat[0].mes, aiFinal);
    assert.equal(Object.hasOwn(chat[0].extra, 'display_text'), false);
});

test('AI result is not partially committed while the current swipe slot is pending', async () => {
    const original = '<content>正文</content>尾';
    const swipes = ['<content>上一页</content>'];
    swipes.length = 2;
    const chat = [{
        is_user: false,
        mes: original,
        swipe_id: 1,
        swipes,
    }];
    installRuntime(chat, addProgramRule(createSettings()));
    globalThis.fetch = async () => createAiResponse();

    assert.equal(requestManualAiRewriteForMessage(0), true);
    await flushScheduledWork();

    assert.equal(chat[0].mes, original);
    assert.equal(chat[0].swipes[1], undefined);
    assert.equal(runtimeState.aiRewrite.debugEvents.some(event => (
        event.stage === 'run-apply-failed' && event.details?.reason === 'swipe-slot-not-materialized'
    )), true);
    assert.equal(runtimeState.aiRewrite.debugEvents.some(event => event.stage === 'program-commit'), false);
});

test('missing ids reject the entire response and apply no partial AI rewrite', async () => {
    const chat = [{ is_user: false, mes: '<content>甲，乙</content>' }];
    installRuntime(chat, createSettings({
        subRule: { targets: ['甲', '乙'], replacements: ['本地'] },
    }));
    const toastHarness = installDismissibleToastHarness();
    globalThis.fetch = async () => createAiResponseForId('hit-1', '人工');

    assert.equal(requestManualAiRewriteForMessage(0), true);
    await flushScheduledWork();

    assert.equal(chat[0].mes, '<content>甲，乙</content>');
    assert.equal(chat[0].mes.includes('人工'), false);
    assert.equal(runtimeState.aiRewrite.debugEvents.some(event => event.stage === 'fallback-applied'), false);
    const errorNotice = toastHarness.calls.find(call => call.type === 'error');
    assert.ok(errorNotice);
    assert.equal(errorNotice.toastElement.classList.contains('blai-ai-rewrite-toast'), true);
    assert.equal(errorNotice.toastElement.classList.contains('blai-ai-rewrite-progress-toast'), false);
    assert.equal(errorNotice.toastElement.querySelector('.blai-ai-toast-actions'), null);
    assert.equal(/ · 用时 \d+\.\d 秒$/.test(`${errorNotice.title} ${errorNotice.message}`), false);
});

test('failed streaming AI releases final cleanse ownership after an invalid response', async () => {
    const original = '<content>正文</content>尾';
    const settings = addProgramRule(createSettings());
    const chat = [{ is_user: false, mes: original }];
    const session = installRuntime(chat, settings);
    let fetchCount = 0;
    globalThis.fetch = async () => {
        fetchCount += 1;
        return createAiResponseForId('unknown-hit', '无效改写');
    };

    notifyCommittedStreamingContent(session, chat, original);
    await waitForAutomaticAiRewrite(session.generationId);

    assert.equal(session.requestState, 'failed');
    assert.equal(runtimeState.aiRewrite.runningTaskMetaByKey.size, 0);
    assert.equal(runtimeState.aiRewrite.pendingApplyByKey.size, 0);

    assert.equal(markHostFinalWithProgramCleanse(session, chat), false);

    assert.equal(fetchCount, 1);
    assert.equal(chat[0].mes, '<content>正文</content>末');
});

test('disabling global AI while a request is in flight applies current fallback and rejects the old response', async () => {
    const original = '<content>正文</content>尾';
    const settings = addProgramRule(createSettings());
    const chat = [{ is_user: false, mes: original }];
    const session = installRuntime(chat, settings);
    const errorNotices = [];
    globalThis.toastr.error = (message, title) => {
        errorNotices.push({ message, title });
        return {};
    };
    let resolveFetch;
    let fetchCount = 0;
    globalThis.fetch = () => {
        fetchCount += 1;
        return new Promise(resolve => { resolveFetch = resolve; });
    };

    notifyCommittedStreamingContent(session, chat, original);
    await flushScheduledWork();
    assert.equal(fetchCount, 1);

    settings.aiRewrite.enabled = false;
    assert.equal(chat[0].mes, original);
    assert.equal(markHostFinalWithProgramCleanse(session, chat), true);
    assert.equal(chat[0].mes, '<content>程序正文</content>末');

    resolveFetch(createAiResponse('旧 AI 正文'));
    await waitForAutomaticAiRewrite(session.generationId);

    assert.equal(fetchCount, 1);
    assert.equal(chat[0].mes, '<content>程序正文</content>末');
    assert.equal(runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'atomic-commit').length, 1);
    assert.equal(runtimeState.aiRewrite.debugEvents.some(event => (
        event.stage === 'run-stale' && event.details?.reason === 'settings-version-changed'
    )), true);
    assert.deepEqual(errorNotices, []);
});

for (const disabledTarget of ['collection', 'subrule']) {
    test(`disabling an in-flight AI ${disabledTarget} removes its final ownership and fallback`, async () => {
        const original = '<content>正文</content>尾';
        const settings = addProgramRule(createSettings());
        const chat = [{ is_user: false, mes: original }];
        const session = installRuntime(chat, settings);
        let resolveFetch;
        let fetchCount = 0;
        globalThis.fetch = () => {
            fetchCount += 1;
            return new Promise(resolve => { resolveFetch = resolve; });
        };

        notifyCommittedStreamingContent(session, chat, original);
        await flushScheduledWork();
        assert.equal(fetchCount, 1);

        if (disabledTarget === 'collection') settings.rules[0].enabled = false;
        else settings.rules[0].subRules[0].enabled = false;
        assert.equal(markHostFinalWithProgramCleanse(session, chat), false);
        assert.equal(chat[0].mes, '<content>正文</content>末');

        resolveFetch(createAiResponse('旧 AI 正文'));
        await waitForAutomaticAiRewrite(session.generationId);

        assert.equal(fetchCount, 1);
        assert.equal(chat[0].mes, '<content>正文</content>末');
        assert.equal(runtimeState.aiRewrite.debugEvents.some(event => event.stage === 'apply-success'), false);
        assert.equal(runtimeState.aiRewrite.debugEvents.some(event => event.stage === 'fallback-applied'), false);
    });
}

test('changing AI rule replacements in flight finalizes with the current replacements instead of the old task', async () => {
    const original = '<content>正文</content>尾';
    const settings = addProgramRule(createSettings());
    const chat = [{ is_user: false, mes: original }];
    const session = installRuntime(chat, settings);
    let resolveFetch;
    let fetchCount = 0;
    globalThis.fetch = () => {
        fetchCount += 1;
        return new Promise(resolve => { resolveFetch = resolve; });
    };

    notifyCommittedStreamingContent(session, chat, original);
    await flushScheduledWork();
    settings.rules[0].subRules[0].replacements = ['当前程序正文'];

    assert.equal(markHostFinalWithProgramCleanse(session, chat), true);
    assert.equal(chat[0].mes, '<content>当前程序正文</content>末');

    resolveFetch(createAiResponse('旧 AI 正文'));
    await waitForAutomaticAiRewrite(session.generationId);

    assert.equal(fetchCount, 1);
    assert.equal(chat[0].mes, '<content>当前程序正文</content>末');
    assert.equal(runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'atomic-commit').length, 1);
});

test('disabling global AI after host finalization converges the owned commit with current program rules', async () => {
    const original = '<content>正文</content>尾';
    const settings = addProgramRule(createSettings());
    const chat = [{ is_user: false, mes: original }];
    const session = installRuntime(chat, settings);
    let resolveFetch;
    let fetchCount = 0;
    globalThis.fetch = () => {
        fetchCount += 1;
        return new Promise(resolve => { resolveFetch = resolve; });
    };

    notifyCommittedStreamingContent(session, chat, original);
    await flushScheduledWork();
    assert.equal(fetchCount, 1);

    markHostFinal(session, chat);
    assert.equal(chat[0].mes, original);
    settings.aiRewrite.enabled = false;

    resolveFetch(createAiResponse('旧 AI 正文'));
    await waitForAutomaticAiRewrite(session.generationId);

    assert.equal(fetchCount, 1);
    assert.equal(chat[0].mes, '<content>程序正文</content>末');
    assert.equal(runtimeState.aiRewrite.debugEvents.some(event => event.stage === 'apply-success'), false);
    assert.equal(runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'atomic-commit').length, 1);
});

for (const disabledTarget of ['collection', 'subrule']) {
    test(`disabling an AI ${disabledTarget} after host finalization converges without its program fallback`, async () => {
        const original = '<content>正文</content>尾';
        const settings = addProgramRule(createSettings());
        const chat = [{ is_user: false, mes: original }];
        const session = installRuntime(chat, settings);
        let resolveFetch;
        let fetchCount = 0;
        globalThis.fetch = () => {
            fetchCount += 1;
            return new Promise(resolve => { resolveFetch = resolve; });
        };

        notifyCommittedStreamingContent(session, chat, original);
        await flushScheduledWork();
        assert.equal(fetchCount, 1);

        markHostFinal(session, chat);
        assert.equal(chat[0].mes, original);
        if (disabledTarget === 'collection') settings.rules[0].enabled = false;
        else settings.rules[0].subRules[0].enabled = false;

        resolveFetch(createAiResponse('旧 AI 正文'));
        await waitForAutomaticAiRewrite(session.generationId);

        assert.equal(fetchCount, 1);
        assert.equal(chat[0].mes, '<content>正文</content>末');
        assert.equal(runtimeState.aiRewrite.debugEvents.some(event => event.stage === 'apply-success'), false);
        assert.equal(runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'atomic-commit').length, 1);
    });
}

test('editing an AI replacement after host finalization converges with the current replacement', async () => {
    const original = '<content>正文</content>尾';
    const settings = addProgramRule(createSettings());
    const chat = [{ is_user: false, mes: original }];
    const session = installRuntime(chat, settings);
    let resolveFetch;
    let fetchCount = 0;
    globalThis.fetch = () => {
        fetchCount += 1;
        return new Promise(resolve => { resolveFetch = resolve; });
    };

    notifyCommittedStreamingContent(session, chat, original);
    await flushScheduledWork();
    markHostFinal(session, chat);
    settings.rules[0].subRules[0].replacements = ['当前程序正文'];

    resolveFetch(createAiResponse('旧 AI 正文'));
    await waitForAutomaticAiRewrite(session.generationId);

    assert.equal(fetchCount, 1);
    assert.equal(chat[0].mes, '<content>当前程序正文</content>末');
    assert.equal(runtimeState.aiRewrite.debugEvents.some(event => event.stage === 'apply-success'), false);
    assert.equal(runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'atomic-commit').length, 1);
});

test('settings convergence preserves Continue content from the authoritative current source', async () => {
    const original = '<content>旧正文</content>';
    const programCleaned = '<content>旧程序正文</content>';
    const continued = '<content>旧程序正文，续写正文</content>尾';
    const settings = addProgramRule(createSettings());
    const message = { is_user: false, mes: continued };
    const chat = [message];
    const session = installRuntime(chat, settings);
    writeMessageDiffMeta(message, 'main', original, programCleaned, 'historical-source-signature');
    let resolveFetch;
    let fetchCount = 0;
    globalThis.fetch = () => {
        fetchCount += 1;
        return new Promise(resolve => { resolveFetch = resolve; });
    };

    notifyCommittedStreamingContent(session, chat, continued);
    await flushScheduledWork();
    assert.equal(fetchCount, 1);

    markHostFinal(session, chat);
    assert.equal(message.mes, continued);
    settings.rules[0].subRules[0].replacements = ['当前正文'];

    resolveFetch(createAiResponse('旧 AI 正文'));
    await waitForAutomaticAiRewrite(session.generationId);

    assert.equal(fetchCount, 1);
    assert.equal(message.mes, '<content>旧程序当前正文，续写当前正文</content>末');
    assert.equal(message.mes.includes('续写正文'), false);
    assert.equal(message.mes.includes('续写当前正文'), true);
    assert.equal(message.mes.endsWith('末'), true);
    assert.equal(runtimeState.aiRewrite.debugEvents.some(event => event.stage === 'apply-success'), false);
    assert.equal(runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'atomic-commit').length, 1);
});

test('a deferred AI result converges with current settings only when host finalization arrives', async () => {
    const original = '<content>正文</content>尾';
    const settings = addProgramRule(createSettings());
    const chat = [{ is_user: false, mes: original }];
    const session = installRuntime(chat, settings);
    globalThis.fetch = async () => createAiResponse('旧 AI 正文');

    notifyCommittedStreamingContent(session, chat, original);
    await waitForAutomaticAiRewrite(session.generationId);

    assert.equal(chat[0].mes, original);
    assert.equal(runtimeState.aiRewrite.pendingApplyByKey.size, 1);
    settings.rules[0].subRules[0].replacements = ['当前程序正文'];

    markHostFinal(session, chat);

    assert.equal(chat[0].mes, '<content>当前程序正文</content>末');
    assert.equal(runtimeState.aiRewrite.pendingApplyByKey.size, 0);
    assert.equal(runtimeState.aiRewrite.debugEvents.some(event => event.stage === 'apply-success'), false);
    assert.equal(runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'atomic-commit').length, 1);
});

test('a Swipe ownership change after host finalization rejects both old AI and settings convergence writes', async () => {
    const original = '<content>正文</content>尾';
    const otherSwipe = '<content>另一页</content>尾';
    const settings = addProgramRule(createSettings());
    const message = {
        is_user: false,
        mes: original,
        swipe_id: 0,
        swipes: [original, otherSwipe],
        swipe_info: [{}, {}],
    };
    const chat = [message];
    const session = installRuntime(chat, settings);
    let resolveFetch;
    globalThis.fetch = () => new Promise(resolve => { resolveFetch = resolve; });

    notifyCommittedStreamingContent(session, chat, original);
    await flushScheduledWork();
    markHostFinal(session, chat);

    settings.aiRewrite.enabled = false;
    message.swipe_id = 1;
    message.mes = otherSwipe;
    resolveFetch(createAiResponse('旧 AI 正文'));
    await waitForAutomaticAiRewrite(session.generationId);

    assert.equal(message.mes, otherSwipe);
    assert.equal(message.swipes[0], original);
    assert.equal(message.swipes[1], otherSwipe);
    assert.equal(runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'atomic-commit').length, 0);
});

test('a manual final after host finalization blocks settings convergence', async () => {
    const original = '<content>正文</content>尾';
    const settings = addProgramRule(createSettings());
    const message = { is_user: false, mes: original };
    const chat = [message];
    const session = installRuntime(chat, settings);
    let resolveFetch;
    globalThis.fetch = () => new Promise(resolve => { resolveFetch = resolve; });

    notifyCommittedStreamingContent(session, chat, original);
    await flushScheduledWork();
    markHostFinal(session, chat);

    settings.aiRewrite.enabled = false;
    writeMessageDiffManualFinal(message);
    resolveFetch(createAiResponse('旧 AI 正文'));
    await waitForAutomaticAiRewrite(session.generationId);

    assert.equal(message.mes, original);
    assert.equal(runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'atomic-commit').length, 0);
});
