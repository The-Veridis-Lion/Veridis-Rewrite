import test from 'node:test';
import assert from 'node:assert/strict';
import { clearPendingShujukuRewrite, markLatestMessageShujukuRewritePending } from '../src/shujukuCompatibility.js';
import { extensionName, getAppContext, initAppContext, runtimeState } from '../src/state.js';

const originalContext = { ...getAppContext() };
const originalWindow = globalThis.window;

function installPendingChat(message = { is_user: false, mes: 'assistant' }) {
    const chat = [message];
    initAppContext({
        chat,
        extension_settings: {
            [extensionName]: {
                rules: [],
                shujukuAutoProgramRewriteEnabled: true,
            },
        },
        saveChat: async () => {},
        saveSettingsDebounced: () => {},
        getSillyTavernContext: () => ({ chat }),
        markWindowedChatDirtyFromIndex: () => {},
    });
}

function createShujukuApi(order = []) {
    const callbacks = [];
    const registrationCalls = [];
    let exportCount = 0;
    return {
        callbacks,
        registrationCalls,
        get exportCount() {
            return exportCount;
        },
        registerTableUpdateCallback(callback) {
            order.push('callback-bind');
            registrationCalls.push(callback);
            if (typeof callback === 'function' && !callbacks.includes(callback)) callbacks.push(callback);
        },
        unregisterTableUpdateCallback(callback) {
            const index = callbacks.indexOf(callback);
            if (index >= 0) callbacks.splice(index, 1);
        },
        _notifyTableUpdate() {
            order.push('completion-notify');
            for (const callback of [...callbacks]) callback({});
        },
        exportTableAsJson() {
            exportCount++;
            return {};
        },
        async updateCell() {
            return true;
        },
    };
}

function callbackEvents() {
    return runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'shujuku-callback-received');
}

function settleAsyncCallback() {
    return new Promise(resolve => setImmediate(resolve));
}

test.beforeEach(() => {
    runtimeState.aiRewrite.debugEvents = [];
    runtimeState.aiRewrite.criticalDebugEvents = [];
});

test.afterEach(() => {
    clearPendingShujukuRewrite();
    initAppContext(originalContext);
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    runtimeState.aiRewrite.debugEvents = [];
    runtimeState.aiRewrite.criticalDebugEvents = [];
});

test('late Userscript API after APP_READY binds when real pending work is armed without an extension event', async () => {
    globalThis.window = {};
    installPendingChat();

    // APP_READY has already happened. Shujuku Userscript later publishes on the host window,
    // and no EXTENSION_SETTINGS_LOADED('shujuku') signal exists for this path.
    const api = createShujukuApi();
    globalThis.window.AutoCardUpdaterAPI = api;
    assert.equal(api.callbacks.length, 0);

    assert.equal(markLatestMessageShujukuRewritePending(0, 'ai-finalization'), true);
    assert.equal(api.registrationCalls.length, 1);
    assert.equal(api.callbacks.length, 1);

    api._notifyTableUpdate();
    await settleAsyncCallback();
    assert.equal(callbackEvents().length, 1);
});

test('normal Extension mode binds before the automatic completion opportunity', async () => {
    const order = [];
    const api = createShujukuApi(order);
    globalThis.window = { AutoCardUpdaterAPI: api };
    installPendingChat();

    assert.equal(markLatestMessageShujukuRewritePending(0, 'ai-finalization'), true);
    assert.deepEqual(order, ['callback-bind']);
    assert.equal(api.callbacks.length, 1);

    api._notifyTableUpdate();
    await settleAsyncCallback();
    assert.deepEqual(order, ['callback-bind', 'completion-notify']);
    assert.equal(callbackEvents().length, 1);
    assert.equal(api.exportCount, 1);
});

test('repeated generations on one live API retain one callback reference and one processing flight per notification', async () => {
    const api = createShujukuApi();
    globalThis.window = { AutoCardUpdaterAPI: api };

    installPendingChat({ is_user: false, mes: 'first generation' });
    assert.equal(markLatestMessageShujukuRewritePending(0, 'ai-finalization'), true);

    installPendingChat({ is_user: false, mes: 'second generation' });
    assert.equal(markLatestMessageShujukuRewritePending(0, 'ai-finalization'), true);

    assert.equal(api.registrationCalls.length, 2);
    assert.equal(api.registrationCalls[0], api.registrationCalls[1]);
    assert.equal(api.callbacks.length, 1);

    runtimeState.aiRewrite.debugEvents = [];
    api._notifyTableUpdate();
    await settleAsyncCallback();

    assert.equal(callbackEvents().length, 1);
    assert.equal(api.exportCount, 1);
    assert.equal(runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'shujuku-program-commit').length, 0);
});
