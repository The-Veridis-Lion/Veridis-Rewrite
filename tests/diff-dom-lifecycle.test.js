import test from 'node:test';
import assert from 'node:assert/strict';

import { bindHostLifecycleEvents, initRealtimeInterceptor } from '../src/events/hostLifecycle.js';
import { diffMetadataKey, extensionName, getAppContext, initAppContext, runtimeState } from '../src/state.js';

function assistant(text = 'assistant') {
    return { is_user: false, mes: text };
}

function programRule() {
    return {
        enabled: true,
        subRules: [{
            enabled: true,
            rewriteMode: 'program',
            mode: 'text',
            targets: ['NEVER_MATCH_EXISTING_CHAT'],
            replacements: ['replacement'],
        }],
    };
}

function createEventSource() {
    const listeners = Object.create(null);
    return {
        on(type, handler) {
            (listeners[type] ||= []).push(handler);
        },
        makeFirst(type, handler) {
            (listeners[type] ||= []).unshift(handler);
        },
        async emit(type, ...args) {
            for (const handler of [...(listeners[type] || [])]) await handler(...args);
        },
    };
}

function createMessageDom() {
    const buttons = [];
    const buttonArea = {
        querySelector(selector) {
            if (selector === '.blai-diff-btn-top') {
                return buttons.find((button) => button.className.includes('blai-diff-btn-top')) || null;
            }
            return null;
        },
        appendChild(button) {
            button.parentElement = buttonArea;
            buttons.push(button);
        },
    };
    const messageNode = {
        nodeType: 1,
        dataset: {},
        matches: (selector) => selector === '.mes',
        closest: (selector) => selector === '.mes' ? messageNode : null,
        getAttribute(name) {
            if (name === 'mesid') return '0';
            if (name === 'is_user') return 'false';
            return null;
        },
        querySelector(selector) {
            if (selector === '.mes_buttons') return buttonArea;
            return null;
        },
        querySelectorAll(selector) {
            if (selector === '.blai-diff-btn') return buttons;
            return [];
        },
    };
    const chatNode = {
        querySelector(selector) {
            return selector === '.mes[mesid="0"]' ? messageNode : null;
        },
        querySelectorAll(selector) {
            return selector === '.mes' ? [messageNode] : [];
        },
    };
    return { buttons, chatNode, messageNode };
}

function resetRuntime() {
    runtimeState.diffSnippetsCache.clear();
    runtimeState.diffRawSourceCache.clear();
    runtimeState.nonStreamingRawMessageCache.clear();
    runtimeState.streamingCommittedMessageCache.clear();
    runtimeState.diffMessageStates.clear();
    runtimeState.trackedDiffMessageOrder = [];
    runtimeState.activeProcessors = [];
    runtimeState.activeVisualProcessors = [];
    runtimeState.isRegexDirty = true;
    runtimeState.isStreamingGeneration = false;
    runtimeState.chatSaveTimer = null;
    runtimeState.chatSaveInFlight = false;
    runtimeState.pendingChatSave = false;
    runtimeState.chatSaveDelayCount = 0;
}

test('chat DOM priming remains visual-only while generation finalization still owns Diff persistence', async () => {
    const previousContext = { ...getAppContext() };
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousMutationObserver = globalThis.MutationObserver;
    const previousNode = globalThis.Node;
    const previousSetTimeout = globalThis.setTimeout;
    const previousClearTimeout = globalThis.clearTimeout;
    const previousSetInterval = globalThis.setInterval;
    const previousClearInterval = globalThis.clearInterval;
    const previousDollar = globalThis.$;
    const timers = [];
    const observers = [];
    const { buttons, chatNode, messageNode } = createMessageDom();
    const eventSource = createEventSource();
    const event_types = {
        GENERATION_STARTED: 'generation-started',
        GENERATION_ENDED: 'generation-ended',
        GENERATION_STOPPED: 'generation-stopped',
        MESSAGE_RECEIVED: 'message-received',
        CHAT_CHANGED: 'chat-changed',
    };
    const chat = [assistant('existing assistant message')];
    const chat_metadata = { chatId: 'chat-a' };
    let hostSaveCalls = 0;

    globalThis.window = { addEventListener() {} };
    globalThis.document = {
        addEventListener() {},
        getElementById: (id) => id === 'chat' ? chatNode : null,
        querySelector: () => null,
        querySelectorAll: (selector) => selector === '.blai-diff-btn[data-index]' ? buttons : [],
        createElement() {
            return {
                className: '',
                attrs: {},
                setAttribute(name, value) { this.attrs[name] = value; },
                getAttribute(name) { return this.attrs[name] ?? null; },
                remove() {
                    const index = buttons.indexOf(this);
                    if (index >= 0) buttons.splice(index, 1);
                },
                closest: () => messageNode,
            };
        },
    };
    globalThis.Node = { ELEMENT_NODE: 1 };
    globalThis.MutationObserver = class {
        constructor(callback) {
            this.callback = callback;
            observers.push(this);
        }
        observe() {}
        takeRecords() { return []; }
    };
    globalThis.setTimeout = (callback, delay = 0) => {
        const timer = { callback, delay, cancelled: false };
        timers.push(timer);
        return timer;
    };
    globalThis.clearTimeout = (timer) => { if (timer) timer.cancelled = true; };
    globalThis.setInterval = () => ({ interval: true });
    globalThis.clearInterval = () => {};
    globalThis.$ = () => ({ hide() {} });

    try {
        resetRuntime();
        initAppContext({
            chat,
            chat_metadata,
            extension_settings: {
                [extensionName]: {
                    enableVisualDiff: true,
                    showBottomDiffButton: false,
                    rules: [programRule()],
                    scopeTags: [],
                    scopeTagBuiltinDismissed: [],
                    scopeTagMode: 'protect',
                },
            },
            eventSource,
            event_types,
            saveChat: async () => { hostSaveCalls += 1; },
            getSillyTavernContext: () => ({
                chat,
                getCurrentChatId: () => 'chat-a',
                saveChat: async () => { hostSaveCalls += 1; },
            }),
        });

        initRealtimeInterceptor();
        bindHostLifecycleEvents();
        assert.equal(observers.length, 1);

        runtimeState.isStreamingGeneration = true;
        observers[0].callback([{ type: 'childList', addedNodes: [messageNode] }]);
        assert.equal(runtimeState.diffMessageStates.size, 0);
        assert.equal(buttons.length, 0);

        runtimeState.isStreamingGeneration = false;
        observers[0].callback([{ type: 'childList', addedNodes: [messageNode] }]);
        assert.equal(runtimeState.diffMessageStates.get(0)?.status, 'pending');
        assert.deepEqual(runtimeState.trackedDiffMessageOrder, [0]);
        assert.equal(buttons.length, 1);
        assert.equal(chat_metadata[diffMetadataKey], undefined);
        assert.equal(runtimeState.pendingChatSave, false);
        assert.equal(runtimeState.chatSaveTimer, null);
        assert.equal(hostSaveCalls, 0);

        await eventSource.emit(event_types.CHAT_CHANGED);
        assert.equal(runtimeState.pendingChatSave, false);
        assert.equal(runtimeState.chatSaveTimer, null);
        for (const timer of timers.splice(0)) {
            if (!timer.cancelled) await timer.callback();
        }
        assert.equal(chat_metadata[diffMetadataKey], undefined);
        assert.equal(runtimeState.pendingChatSave, false);
        assert.equal(runtimeState.chatSaveTimer, null);
        assert.equal(hostSaveCalls, 0);

        resetRuntime();
        delete chat_metadata[diffMetadataKey];
        await eventSource.emit(event_types.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(event_types.MESSAGE_RECEIVED, 0, 'normal');
        assert.ok(runtimeState.diffMessageStates.has(0));
        assert.deepEqual(chat_metadata[diffMetadataKey]?.order, [0]);
        assert.equal(runtimeState.pendingChatSave, true);
        assert.ok(runtimeState.chatSaveTimer);

        const saveTimer = runtimeState.chatSaveTimer;
        await saveTimer.callback();
        assert.equal(hostSaveCalls, 1);
        assert.equal(runtimeState.pendingChatSave, false);
        assert.equal(runtimeState.chatSaveTimer, null);
    } finally {
        resetRuntime();
        initAppContext(previousContext);
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        globalThis.MutationObserver = previousMutationObserver;
        globalThis.Node = previousNode;
        globalThis.setTimeout = previousSetTimeout;
        globalThis.clearTimeout = previousClearTimeout;
        globalThis.setInterval = previousSetInterval;
        globalThis.clearInterval = previousClearInterval;
        globalThis.$ = previousDollar;
    }
});
