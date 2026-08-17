import test from 'node:test';
import assert from 'node:assert/strict';

import {
    bindComposerButtonAiRewriteEvent,
    composerButtonAiRewriteEvent,
    composerButtonName,
    composerButtonScriptId,
    syncComposerButtonScript,
    updateComposerButtonSetting,
} from '../src/composerButton.js';
import { defaultSettings, extensionName, initAppContext } from '../src/state.js';

function createTavernHelper(initialTrees = []) {
    let trees = initialTrees;
    const calls = [];
    return {
        calls,
        get trees() {
            return trees;
        },
        updateScriptTreesWith(updater, options) {
            calls.push({ updater, options });
            trees = updater(trees);
            return trees;
        },
    };
}

function findManagedScripts(trees) {
    return trees.flatMap((tree) => {
        if (tree?.id === composerButtonScriptId) return [tree];
        return tree?.type === 'folder'
            ? tree.scripts.filter((script) => script?.id === composerButtonScriptId)
            : [];
    });
}

function createEventSource() {
    const listeners = new Map();
    return {
        listeners,
        on(eventName, listener) {
            listeners.set(eventName, listener);
        },
        emit(eventName) {
            return listeners.get(eventName)?.();
        },
    };
}

test.afterEach(() => {
    delete globalThis.TavernHelper;
});

test('composer AI rewrite button defaults off and disabled synchronization leaves it absent', () => {
    assert.equal(defaultSettings.showComposerAiRewriteButton, false);
    const tavernHelper = createTavernHelper();

    syncComposerButtonScript(false, tavernHelper);

    assert.deepEqual(tavernHelper.trees, []);
    assert.deepEqual(tavernHelper.calls[0].options, { type: 'global' });
});

test('enabling from an empty global tree creates one canonical managed script', () => {
    const tavernHelper = createTavernHelper();

    syncComposerButtonScript(true, tavernHelper);

    assert.equal(tavernHelper.trees.length, 1);
    const [script] = tavernHelper.trees;
    assert.equal(script.type, 'script');
    assert.equal(script.id, composerButtonScriptId);
    assert.equal(script.name, '[Veridis Rewrite] 手动 AI 改写按钮');
    assert.equal(script.enabled, true);
    assert.match(script.info, /Veridis Rewrite 管理/);
    assert.deepEqual(script.button, {
        enabled: true,
        buttons: [{ name: composerButtonName, visible: true }],
    });
    assert.equal(script.content, `eventOn(getButtonEvent('${composerButtonName}'), () => {\n    eventEmit('${composerButtonAiRewriteEvent}');\n});`);
});

test('enabling preserves unrelated scripts and folders while remaining idempotent', () => {
    const unrelatedScript = { type: 'script', id: 'user-script', name: 'User', enabled: false };
    const unrelatedFolder = {
        type: 'folder',
        id: 'user-folder',
        name: 'Folder',
        scripts: [{ type: 'script', id: 'nested-user-script', name: 'Nested' }],
    };
    const tavernHelper = createTavernHelper([unrelatedScript, unrelatedFolder]);

    syncComposerButtonScript(true, tavernHelper);
    const firstTrees = tavernHelper.trees;
    syncComposerButtonScript(true, tavernHelper);

    assert.strictEqual(tavernHelper.trees, firstTrees);
    assert.strictEqual(tavernHelper.trees[0], unrelatedScript);
    assert.strictEqual(tavernHelper.trees[1], unrelatedFolder);
    assert.equal(findManagedScripts(tavernHelper.trees).length, 1);
});

test('enabling replaces a stale managed entry and removes exact-ID duplicates only', () => {
    const unrelatedScript = { type: 'script', id: 'user-script', name: 'User' };
    const folder = {
        type: 'folder',
        id: 'user-folder',
        name: 'Folder',
        scripts: [
            unrelatedScript,
            { type: 'script', id: composerButtonScriptId, name: 'Nested stale copy' },
        ],
    };
    const staleManagedScript = {
        type: 'script',
        id: composerButtonScriptId,
        name: 'Old name',
        enabled: false,
        content: 'old content',
        button: { enabled: false, buttons: [] },
    };
    const tavernHelper = createTavernHelper([staleManagedScript, folder]);

    syncComposerButtonScript(true, tavernHelper);

    assert.equal(findManagedScripts(tavernHelper.trees).length, 1);
    assert.equal(tavernHelper.trees[0].name, '[Veridis Rewrite] 手动 AI 改写按钮');
    assert.equal(tavernHelper.trees[1].name, 'Folder');
    assert.deepEqual(tavernHelper.trees[1].scripts, [unrelatedScript]);
});

test('disabling removes only exact-ID managed entries and repeated disable is a no-op', () => {
    const unrelatedScript = { type: 'script', id: 'user-script', name: '[Veridis Rewrite] 手动 AI 改写按钮' };
    const folder = {
        type: 'folder',
        id: 'user-folder',
        scripts: [
            { type: 'script', id: composerButtonScriptId, name: 'Nested managed copy' },
            { type: 'script', id: 'nested-user-script', name: 'Nested user script' },
        ],
    };
    const tavernHelper = createTavernHelper([
        unrelatedScript,
        { type: 'script', id: composerButtonScriptId, name: 'Managed' },
        folder,
    ]);

    syncComposerButtonScript(false, tavernHelper);
    const firstTrees = tavernHelper.trees;
    syncComposerButtonScript(false, tavernHelper);

    assert.strictEqual(tavernHelper.trees, firstTrees);
    assert.strictEqual(tavernHelper.trees[0], unrelatedScript);
    assert.equal(tavernHelper.trees[1].id, 'user-folder');
    assert.deepEqual(tavernHelper.trees[1].scripts, [folder.scripts[1]]);
    assert.equal(findManagedScripts(tavernHelper.trees).length, 0);
});

test('composer event rewrites the latest assistant even when a later user message exists', () => {
    const eventSource = createEventSource();
    const requestedIndices = [];
    const toasts = [];
    initAppContext({
        chat: [
            { is_user: false, mes: 'assistant 0' },
            { is_user: true, mes: 'user 1' },
            { is_user: false, mes: 'assistant 2' },
            { is_user: true, mes: 'user 3' },
        ],
    });

    bindComposerButtonAiRewriteEvent(
        eventSource,
        (index) => requestedIndices.push(index),
        (message) => toasts.push(message),
    );
    eventSource.emit(composerButtonAiRewriteEvent);

    assert.equal(eventSource.listeners.size, 1);
    assert.deepEqual(requestedIndices, [2]);
    assert.deepEqual(toasts, []);
});

test('composer event rewrites the latest item when it is an assistant message', () => {
    const eventSource = createEventSource();
    const requestedIndices = [];
    initAppContext({
        chat: [
            { is_user: true, mes: 'user 0' },
            { is_user: false, mes: 'assistant 1' },
        ],
    });

    bindComposerButtonAiRewriteEvent(eventSource, (index) => requestedIndices.push(index));
    eventSource.emit(composerButtonAiRewriteEvent);

    assert.deepEqual(requestedIndices, [1]);
});

test('composer event reports no rewritable assistant without requesting AI', () => {
    for (const chat of [[], [{ is_user: true, mes: 'user only' }]]) {
        const eventSource = createEventSource();
        const requestedIndices = [];
        const toasts = [];
        initAppContext({ chat });

        bindComposerButtonAiRewriteEvent(
            eventSource,
            (index) => requestedIndices.push(index),
            (message) => toasts.push(message),
        );
        eventSource.emit(composerButtonAiRewriteEvent);

        assert.deepEqual(requestedIndices, []);
        assert.deepEqual(toasts, ['未找到可改写的助手消息']);
    }
});

test('setting updates save once and synchronize the corresponding global script once', () => {
    const tavernHelper = createTavernHelper();
    globalThis.TavernHelper = tavernHelper;
    let saveCount = 0;
    const settings = { showComposerAiRewriteButton: false };
    initAppContext({
        extension_settings: { [extensionName]: settings },
        saveSettingsDebounced: () => {
            saveCount += 1;
        },
    });

    updateComposerButtonSetting(true);
    assert.equal(settings.showComposerAiRewriteButton, true);
    assert.equal(saveCount, 1);
    assert.equal(tavernHelper.calls.length, 1);
    assert.equal(findManagedScripts(tavernHelper.trees).length, 1);

    updateComposerButtonSetting(false);
    assert.equal(settings.showComposerAiRewriteButton, false);
    assert.equal(saveCount, 2);
    assert.equal(tavernHelper.calls.length, 2);
    assert.equal(findManagedScripts(tavernHelper.trees).length, 0);
});

test('startup synchronization restores an enabled managed script in one TavernHelper update', () => {
    const tavernHelper = createTavernHelper();
    globalThis.TavernHelper = tavernHelper;

    syncComposerButtonScript(true);

    assert.equal(tavernHelper.calls.length, 1);
    assert.equal(findManagedScripts(tavernHelper.trees).length, 1);
});

test('startup synchronization removes a disabled managed script in one TavernHelper update', () => {
    const tavernHelper = createTavernHelper([
        { type: 'script', id: composerButtonScriptId, name: 'Managed' },
    ]);
    globalThis.TavernHelper = tavernHelper;

    syncComposerButtonScript(false);

    assert.equal(tavernHelper.calls.length, 1);
    assert.equal(findManagedScripts(tavernHelper.trees).length, 0);
});
