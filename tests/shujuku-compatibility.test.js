import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForAutomaticAiRewrite, resetAiRewriteRuntimeState } from '../src/aiRewrite.js';
import { performDeepCleanse } from '../src/cleanse.js';
import { cleanseMessageDataAtIndex, performGlobalCleanse } from '../src/core.js';
import { bindHostLifecycleEvents } from '../src/events/hostLifecycle.js';
import { generationLifecycle } from '../src/generationLifecycle.js';
import {
    collectShujukuCellTargets,
    clearPendingShujukuRewrite,
    markLatestMessageShujukuRewritePending,
    registerShujukuTableUpdateCallback,
    rewriteLatestMessageShujukuCells,
} from '../src/shujukuCompatibility.js';
import { defaultAiRewriteSettings, defaultSettings, extensionName, getAppContext, initAppContext, normalizeShujukuAutoProgramRewriteEnabled, runtimeState } from '../src/state.js';

let shujukuEntrySequence = 0;

function appendShujukuMutation(message, messageIndex, operations, changedSheetKeys = []) {
    const isolationKey = typeof message.TavernDB_ACU_Identity === 'string'
        ? message.TavernDB_ACU_Identity
        : '';
    const wasJson = typeof message.TavernDB_ACU_IsolatedData === 'string';
    const isolatedData = wasJson
        ? JSON.parse(message.TavernDB_ACU_IsolatedData)
        : (message.TavernDB_ACU_IsolatedData || {});
    const tagData = isolatedData[isolationKey] || {};
    const frame = tagData.storageFrame?.version === 2 && Array.isArray(tagData.storageFrame.logEntries)
        ? tagData.storageFrame
        : { version: 2, headRevision: null, logEntries: [] };
    const seq = Math.max(0, ...frame.logEntries.map(entry => Number(entry?.seq) || 0)) + 1;
    const entryId = `test-entry-${++shujukuEntrySequence}`;
    const commitRevision = `${seq}:${entryId}`;
    frame.logEntries.push({
        seq,
        entryId,
        parentRevision: frame.headRevision ?? null,
        commitRevision,
        targetMessageIndex: messageIndex,
        changedSheetKeys,
        operations,
    });
    frame.headRevision = commitRevision;
    isolatedData[isolationKey] = { ...tagData, storageFrame: frame };
    message.TavernDB_ACU_IsolatedData = wasJson ? JSON.stringify(isolatedData) : isolatedData;
    return message;
}

function createMessage(messageIndex, operations, overrides = {}) {
    const isolationKey = overrides.isolationKey ?? '';
    const message = {
        is_user: false,
        mes: 'assistant message',
        ...(isolationKey ? { TavernDB_ACU_Identity: isolationKey } : {}),
    };
    appendShujukuMutation(message, messageIndex, operations);
    if (overrides.asJson) message.TavernDB_ACU_IsolatedData = JSON.stringify(message.TavernDB_ACU_IsolatedData);
    return message;
}

function createTableData(value = 'SECRET', hiddenValue = 'SECRET HIDDEN') {
    return {
        mate: { type: 'acu', version: 2 },
        sheet_character: {
            uid: 'sheet_character',
            name: '角色状态',
            sourceData: { hiddenPhysicalColumns: ['内部列'] },
            content: [
                ['row_id', '描述', '内部列'],
                ['row-1', value, hiddenValue],
            ],
        },
    };
}

function createTwoCellTableData(firstValue = 'SECRET ONE', secondValue = 'SECRET TWO') {
    return {
        mate: { type: 'acu', version: 2 },
        sheet_character: {
            uid: 'sheet_character',
            name: '角色状态',
            sourceData: { hiddenPhysicalColumns: [] },
            content: [
                ['row_id', '描述', '备注'],
                ['row-1', firstValue, secondValue],
            ],
        },
    };
}

function createMultiRowTableData(values) {
    return {
        mate: { type: 'acu', version: 2 },
        sheet_character: {
            uid: 'sheet_character',
            name: '角色状态',
            sourceData: { hiddenPhysicalColumns: [] },
            content: [
                ['row_id', '描述'],
                ...values.map((value, index) => [`row-${index + 1}`, value]),
            ],
        },
    };
}

function createMultiSheetTableData(valuesBySheetKey) {
    const tableData = { mate: { type: 'acu', version: 2 } };
    for (const [sheetKey, value] of Object.entries(valuesBySheetKey)) {
        tableData[sheetKey] = {
            uid: sheetKey,
            name: `Table ${sheetKey}`,
            sourceData: { hiddenPhysicalColumns: [] },
            content: [
                ['row_id', 'description'],
                ['row-1', value],
            ],
        };
    }
    return tableData;
}

function createSheetReplaceOperation(tableData, sheetKey) {
    return {
        kind: 'sheet_replace',
        sheetKey,
        sheet: JSON.parse(JSON.stringify(tableData[sheetKey])),
        reason: 'system',
    };
}

function programRule(target = 'SECRET', replacement = 'CLEAN') {
    return {
        enabled: true,
        subRules: [{
            enabled: true,
            rewriteMode: 'program',
            mode: 'text',
            targets: [target],
            replacements: [replacement],
        }],
    };
}

function installProgramRules(chat, options = {}) {
    const saveChat = options.saveChat || (async () => {});
    initAppContext({
        chat,
        extension_settings: {
            [extensionName]: {
                shujukuAutoProgramRewriteEnabled: options.shujukuAutoProgramRewriteEnabled !== false,
                rules: options.rules || [
                    {
                        ...programRule(),
                        subRules: [
                            ...programRule().subRules,
                        {
                            enabled: true,
                            rewriteMode: 'ai',
                            mode: 'text',
                            targets: ['AI'],
                            replacements: ['AI-CHANGED'],
                        },
                        ],
                    },
                ],
            },
        },
        saveChat,
        saveSettingsDebounced: options.saveSettingsDebounced || (() => {}),
        getSillyTavernContext: () => ({ chat, saveChat }),
    });
    runtimeState.activeProcessors = [];
    runtimeState.activeVisualProcessors = [];
    runtimeState.isRegexDirty = true;
}

function installShujukuApi(tableDataOrGetter, updateCell = async () => true) {
    const callbacks = [];
    const registrationCalls = [];
    let exportCount = 0;
    const calls = [];
    const api = {
        registerTableUpdateCallback(registeredCallback) {
            registrationCalls.push(registeredCallback);
            if (typeof registeredCallback === 'function' && !callbacks.includes(registeredCallback)) {
                callbacks.push(registeredCallback);
            }
        },
        exportTableAsJson() {
            exportCount++;
            return typeof tableDataOrGetter === 'function' ? tableDataOrGetter() : tableDataOrGetter;
        },
        async updateCell(options) {
            calls.push(options);
            return await updateCell(options);
        },
    };
    globalThis.window = { AutoCardUpdaterAPI: api };
    return {
        calls,
        callbacks,
        registrationCalls,
        get exportCount() {
            return exportCount;
        },
        invokeCallback() {
            assert.equal(callbacks.length > 0, true);
            for (const callback of [...callbacks]) callback();
        },
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function settleAsyncCallback() {
    return new Promise(resolve => setImmediate(resolve));
}

function createHostEventHarness() {
    const listeners = Object.create(null);
    return {
        eventSource: {
            on(type, handler) {
                const handlers = listeners[type] || [];
                handlers.push(handler);
                listeners[type] = handlers;
            },
            async emit(type, ...args) {
                for (const handler of [...(listeners[type] || [])]) {
                    await handler(...args);
                }
            },
        },
        eventTypes: {
            GENERATION_STARTED: 'generation-started',
            GENERATION_ENDED: 'generation-ended',
            GENERATION_STOPPED: 'generation-stopped',
            MESSAGE_RECEIVED: 'message-received',
        },
    };
}

function installHostLifecycleHarness(chat, settings, eventSource, eventTypes) {
    initAppContext({
        chat,
        chat_metadata: { chatId: 'shujuku-host-test' },
        extension_settings: { [extensionName]: settings },
        eventSource,
        event_types: eventTypes,
        saveChat: async () => {},
        saveSettingsDebounced: () => {},
        getSillyTavernContext: () => ({
            chat,
            getCurrentChatId: () => 'shujuku-host-test',
        }),
        markWindowedChatDirtyFromIndex: () => {},
    });
    runtimeState.activeProcessors = [];
    runtimeState.activeVisualProcessors = [];
    runtimeState.isRegexDirty = true;
    generationLifecycle.configure({
        getCurrentChatId: () => 'host:shujuku-host-test',
        getCurrentChat: () => chat,
    });
    generationLifecycle.cancelActive('test-setup');
    resetAiRewriteRuntimeState('test-setup');
    bindHostLifecycleEvents();
}

function createAiOwnedSettings() {
    return {
        activePreset: 'test',
        shujukuAutoProgramRewriteEnabled: true,
        rules: [
            programRule(),
            {
                enabled: true,
                subRules: [{
                    enabled: true,
                    rewriteMode: 'ai',
                    mode: 'text',
                    targets: ['AI'],
                    replacements: ['AI'],
                    aiPromptTemplate: '',
                }],
            },
        ],
        aiRewrite: {
            ...defaultAiRewriteSettings,
            enabled: true,
            baseUrl: 'https://rewrite.example/v1',
            apiKey: 'rewrite-test-key',
            model: 'rewrite-pro',
            xmlScopeTag: 'content',
            maxRetries: 0,
        },
    };
}

function installDeepCleanGlobals() {
    const chain = {
        addClass() { return chain; },
        append() { return chain; },
        attr(name, value) { return value === undefined ? 'auto' : chain; },
        css() { return chain; },
        off() { return chain; },
        on() { return chain; },
        prop() { return chain; },
        remove() { return chain; },
        text() { return chain; },
    };
    globalThis.$ = () => chain;
    globalThis.alert = () => {};
    globalThis.confirm = () => false;
    globalThis.document = {
        getElementById: () => null,
        querySelector: () => null,
        scripts: [],
    };
    globalThis.location = { reload() {} };
}

const originalContext = { ...getAppContext() };

function shujukuCommitEvents() {
    return runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'shujuku-program-commit');
}

function shujukuCheckEvents() {
    return runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'shujuku-program-check');
}

function shujukuPendingEvents() {
    return runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'shujuku-pending-armed');
}

function shujukuCallbackEvents() {
    return runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'shujuku-callback-received');
}

test.beforeEach(() => {
    runtimeState.aiRewrite.debugEvents = [];
    runtimeState.aiRewrite.criticalDebugEvents = [];
});

test('automatic Shujuku setting defaults and normalizes as a strict global opt-in', () => {
    assert.equal(defaultSettings.shujukuAutoProgramRewriteEnabled, false);
    assert.equal(normalizeShujukuAutoProgramRewriteEnabled(undefined), false);
    assert.equal(normalizeShujukuAutoProgramRewriteEnabled(false), false);
    assert.equal(normalizeShujukuAutoProgramRewriteEnabled(1), false);
    assert.equal(normalizeShujukuAutoProgramRewriteEnabled('true'), false);
    assert.equal(normalizeShujukuAutoProgramRewriteEnabled(true), true);
});

test.afterEach(async () => {
    resetAiRewriteRuntimeState('test-cleanup');
    generationLifecycle.cancelActive('test-cleanup');
    if (runtimeState.chatSaveTimer) clearTimeout(runtimeState.chatSaveTimer);
    runtimeState.chatSaveTimer = null;
    runtimeState.pendingChatSave = false;
    runtimeState.chatSaveDelayCount = 0;
    const cleanupChat = [{ is_user: false, mes: 'cleanup' }];
    installProgramRules(cleanupChat);
    const cleanupApi = installShujukuApi({});
    markLatestMessageShujukuRewritePending(0);
    cleanupChat[0] = { is_user: true, mes: 'invalidated' };
    cleanupApi.invokeCallback();
    await settleAsyncCallback();

    initAppContext(originalContext);
    delete globalThis.window;
    delete globalThis.$;
    delete globalThis.alert;
    delete globalThis.confirm;
    delete globalThis.document;
    delete globalThis.location;
    delete globalThis.Mvu;
    delete globalThis.TavernHelper;
    delete globalThis.toastr;
});

test('collects only current ordinary cells directly owned by final row_upsert operations', () => {
    const message = createMessage(1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET', 'SECRET HIDDEN'],
    }], { isolationKey: 'plot-a', asJson: true });

    assert.deepEqual(collectShujukuCellTargets(message, 1, createTableData()), [{
        tableName: '角色状态',
        rowIndex: 1,
        columnIndex: 1,
        value: 'SECRET',
    }]);
});

test('skips cells whose current logical value no longer matches the message row_upsert', () => {
    const message = createMessage(1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET', 'SECRET HIDDEN'],
    }]);

    assert.deepEqual(collectShujukuCellTargets(message, 1, createTableData('NEWER VALUE')), []);
});

test('does not treat a row_upsert as final after a later non-row mutation', () => {
    const message = createMessage(1, [
        {
            kind: 'row_upsert',
            sheetKey: 'sheet_character',
            rowId: 'row-1',
            cells: ['row-1', 'SECRET', 'SECRET HIDDEN'],
        },
        {
            kind: 'data_replace',
            data: createTableData(),
        },
    ]);

    assert.deepEqual(collectShujukuCellTargets(message, 1, createTableData()), []);
});

test('rewrites latest-message cells through public updateCell using Program Rewrite rules only', async () => {
    const message = createMessage(1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET AI', 'SECRET HIDDEN'],
    }]);
    const chat = [{ is_user: true, mes: 'user' }, message];
    const tableData = createTableData('SECRET AI');
    installProgramRules(chat);
    const api = installShujukuApi(tableData);

    assert.equal(await rewriteLatestMessageShujukuCells(1), 1);
    assert.deepEqual(api.calls, [{
        tableName: '角色状态',
        rowIndex: 1,
        colIdentifier: 1,
        value: 'CLEAN AI',
        skipNotify: true,
    }]);
    assert.equal(shujukuCommitEvents().length, 1);
    assert.equal(shujukuCheckEvents().length, 0);
    assert.deepEqual(shujukuCommitEvents()[0].details, {
        source: 'shujuku-direct',
        messageId: 1,
        targetCount: 1,
        changedCount: 1,
    });
    assert.doesNotMatch(JSON.stringify(shujukuCommitEvents()[0]), /SECRET AI|CLEAN AI/);
});

test('does not call shujuku for a historical AI message', async () => {
    const historical = createMessage(1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET', 'SECRET HIDDEN'],
    }]);
    const chat = [{ is_user: true, mes: 'user' }, historical, { is_user: false, mes: 'latest' }];
    installProgramRules(chat);
    const api = installShujukuApi(createTableData());

    assert.equal(await rewriteLatestMessageShujukuCells(1), 0);
    assert.deepEqual(api.calls, []);
    assert.equal(shujukuCheckEvents().length, 0);
    assert.equal(shujukuCommitEvents().length, 0);
});

test('direct inspection records no-targets without treating a pre-inspection rejection as an attempt', async () => {
    const message = createMessage(1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET', 'SECRET HIDDEN'],
    }]);
    const chat = [{ is_user: true, mes: 'user' }, message];
    installProgramRules(chat);
    const api = installShujukuApi(createTableData('NEWER PRIVATE VALUE'));

    assert.equal(await rewriteLatestMessageShujukuCells(1), 0);
    assert.deepEqual(api.calls, []);
    assert.equal(shujukuCheckEvents().length, 1);
    assert.deepEqual(shujukuCheckEvents()[0].details, {
        source: 'shujuku-direct',
        messageId: 1,
        targetCount: 0,
        changedCount: 0,
        result: 'no-targets',
    });
    assert.equal(shujukuCommitEvents().length, 0);
    assert.doesNotMatch(JSON.stringify(shujukuCheckEvents()[0]), /SECRET|NEWER PRIVATE VALUE/);
});

test('direct inspection records eligible cells whose program result is unchanged', async () => {
    const message = createMessage(1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'ORDINARY PRIVATE VALUE', 'SECRET HIDDEN'],
    }]);
    const chat = [{ is_user: true, mes: 'user' }, message];
    installProgramRules(chat);
    const api = installShujukuApi(createTableData('ORDINARY PRIVATE VALUE'));

    assert.equal(await rewriteLatestMessageShujukuCells(1), 0);
    assert.deepEqual(api.calls, []);
    assert.equal(shujukuCheckEvents().length, 1);
    assert.deepEqual(shujukuCheckEvents()[0].details, {
        source: 'shujuku-direct',
        messageId: 1,
        targetCount: 1,
        changedCount: 0,
        result: 'no-changes',
    });
    assert.equal(shujukuCommitEvents().length, 0);
    assert.doesNotMatch(JSON.stringify(shujukuCheckEvents()[0]), /ORDINARY PRIVATE VALUE|SECRET HIDDEN/);
});

test('automatic Program Rewrite waits for the registered shujuku table-update callback', async () => {
    const message = createMessage(1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET', 'SECRET HIDDEN'],
    }]);
    const chat = [{ is_user: true, mes: 'user' }, message];
    installProgramRules(chat);
    const api = installShujukuApi(createTableData());

    assert.equal(cleanseMessageDataAtIndex(1), false);
    assert.deepEqual(shujukuPendingEvents().at(-1)?.details, {
        source: 'message-cleanse',
        messageId: 1,
    });
    assert.doesNotMatch(JSON.stringify(shujukuPendingEvents().at(-1)), /SECRET|PRIVATE|snapshot|prompt|response/i);
    assert.deepEqual(api.calls, []);

    appendShujukuMutation(message, 1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET', 'SECRET HIDDEN'],
    }]);
    api.invokeCallback();
    await settleAsyncCallback();
    assert.equal(shujukuCallbackEvents().length, 1);
    assert.equal(api.calls.length, 1);
});

test('automatic ownership follows a post-arm append on the trigger message without replaying its old entry', async () => {
    const trigger = createMessage(4, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET'],
    }]);
    const chat = Array.from({ length: 5 }, () => ({ is_user: true, mes: 'user' }));
    chat[4] = trigger;
    installProgramRules(chat);
    const api = installShujukuApi(createMultiRowTableData(['SECRET']));
    assert.equal(markLatestMessageShujukuRewritePending(4), true);

    appendShujukuMutation(trigger, 4, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET'],
    }]);
    api.invokeCallback();
    await settleAsyncCallback();

    assert.equal(api.calls.length, 1);
    assert.deepEqual(api.calls[0], {
        tableName: '角色状态',
        rowIndex: 1,
        colIdentifier: 1,
        value: 'CLEAN',
        skipNotify: true,
    });
});

test('automatic ownership resolves a skipped-latest-layer append on message 10 from trigger message 12', async () => {
    const chat = Array.from({ length: 13 }, () => ({ is_user: true, mes: 'user' }));
    chat[8] = createMessage(8, []);
    chat[10] = createMessage(10, []);
    chat[12] = { is_user: false, mes: 'current generation trigger' };
    installProgramRules(chat);
    const api = installShujukuApi(createMultiRowTableData(['SECRET']));
    assert.equal(markLatestMessageShujukuRewritePending(12), true);

    appendShujukuMutation(chat[10], 10, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET'],
    }]);
    api.invokeCallback();
    await settleAsyncCallback();

    assert.equal(api.calls.length, 1);
    assert.equal(chat[12].TavernDB_ACU_IsolatedData, undefined);
    assert.deepEqual(api.calls[0], {
        tableName: '角色状态',
        rowIndex: 1,
        colIdentifier: 1,
        value: 'CLEAN',
        skipNotify: true,
    });
});

test('automatic ownership follows an actual post-arm target more than one assistant layer behind', async () => {
    const chat = Array.from({ length: 17 }, () => ({ is_user: true, mes: 'user' }));
    chat[4] = createMessage(4, []);
    chat[8] = createMessage(8, []);
    chat[12] = createMessage(12, []);
    chat[16] = { is_user: false, mes: 'current generation trigger' };
    installProgramRules(chat);
    const api = installShujukuApi(createMultiRowTableData(['SECRET']));
    assert.equal(markLatestMessageShujukuRewritePending(16), true);

    appendShujukuMutation(chat[8], 8, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET'],
    }]);
    api.invokeCallback();
    await settleAsyncCallback();

    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0].value, 'CLEAN');
});

test('one callback considers new V2 ownership on multiple actual target messages only', async () => {
    const chat = Array.from({ length: 13 }, () => ({ is_user: true, mes: 'user' }));
    chat[0] = createMessage(0, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-3',
        cells: ['row-3', 'SECRET THREE'],
    }]);
    chat[4] = createMessage(4, []);
    chat[8] = createMessage(8, []);
    chat[12] = { is_user: false, mes: 'current generation trigger' };
    installProgramRules(chat);
    const api = installShujukuApi(createMultiRowTableData(['SECRET ONE', 'SECRET TWO', 'SECRET THREE']));
    assert.equal(markLatestMessageShujukuRewritePending(12), true);

    appendShujukuMutation(chat[4], 4, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET ONE'],
    }]);
    appendShujukuMutation(chat[8], 8, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-2',
        cells: ['row-2', 'SECRET TWO'],
    }]);
    api.invokeCallback();
    await settleAsyncCallback();

    assert.deepEqual(api.calls, [
        { tableName: '角色状态', rowIndex: 1, colIdentifier: 1, value: 'CLEAN ONE', skipNotify: true },
        { tableName: '角色状态', rowIndex: 2, colIdentifier: 1, value: 'CLEAN TWO', skipNotify: true },
    ]);
});

test('an unchanged historical matching frame is ignored when another frame changes after arm', async () => {
    const chat = Array.from({ length: 13 }, () => ({ is_user: true, mes: 'user' }));
    chat[4] = createMessage(4, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET ONE'],
    }]);
    chat[8] = createMessage(8, []);
    chat[12] = { is_user: false, mes: 'current generation trigger' };
    installProgramRules(chat);
    const api = installShujukuApi(createMultiRowTableData(['SECRET ONE', 'SECRET TWO']));
    assert.equal(markLatestMessageShujukuRewritePending(12), true);

    appendShujukuMutation(chat[8], 8, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-2',
        cells: ['row-2', 'SECRET TWO'],
    }]);
    api.invokeCallback();
    await settleAsyncCallback();

    assert.deepEqual(api.calls, [
        { tableName: '角色状态', rowIndex: 2, colIdentifier: 1, value: 'CLEAN TWO', skipNotify: true },
    ]);
});

test('a changed post-arm frame with no eligible row_upsert does not fall back to history', async () => {
    const historical = createMessage(4, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET'],
    }]);
    const trigger = { is_user: false, mes: 'current generation trigger' };
    const chat = Array.from({ length: 9 }, () => ({ is_user: true, mes: 'user' }));
    chat[4] = historical;
    chat[8] = trigger;
    installProgramRules(chat);
    const api = installShujukuApi(createMultiRowTableData(['SECRET']));
    assert.equal(markLatestMessageShujukuRewritePending(8), true);

    appendShujukuMutation(historical, 4, [{
        kind: 'sql_sheet_batch',
        sheetKey: 'sheet_character',
        statements: ['UPDATE private_table SET private_column = ?'],
        params: [['PRIVATE SQL PARAMETER']],
    }]);
    api.invokeCallback();
    await settleAsyncCallback();

    assert.deepEqual(api.calls, []);
    assert.equal(api.exportCount, 1);
    assert.deepEqual(shujukuCheckEvents().at(-1)?.details, {
        source: 'shujuku-auto',
        messageId: 8,
        persistenceTargetCount: 1,
        newEntryCount: 1,
        operationKindCounts: { sql_sheet_batch: 1 },
        rowUpsertCount: 0,
        candidateCellCount: 0,
        targetCount: 0,
        changedCount: 0,
        result: 'no-targets',
    });
    assert.doesNotMatch(
        JSON.stringify(shujukuCheckEvents().at(-1)),
        /private_table|private_column|PRIVATE SQL PARAMETER|statements|params|operations/,
    );
});

test('a changed post-arm persistence target with no new entry is diagnosed without synthetic ownership', async () => {
    const target = createMessage(4, []);
    const trigger = { is_user: false, mes: 'current generation trigger' };
    const chat = Array.from({ length: 9 }, () => ({ is_user: true, mes: 'user' }));
    chat[4] = target;
    chat[8] = trigger;
    installProgramRules(chat);
    const api = installShujukuApi(createMultiRowTableData(['PRIVATE CELL VALUE']));
    assert.equal(markLatestMessageShujukuRewritePending(8), true);

    target.TavernDB_ACU_IsolatedData[''].storageFrame.headRevision = 'post-arm-head-only';
    api.invokeCallback();
    await settleAsyncCallback();

    assert.deepEqual(api.calls, []);
    assert.deepEqual(shujukuCheckEvents().at(-1)?.details, {
        source: 'shujuku-auto',
        messageId: 8,
        persistenceTargetCount: 1,
        newEntryCount: 0,
        operationKindCounts: {},
        rowUpsertCount: 0,
        candidateCellCount: 0,
        targetCount: 0,
        changedCount: 0,
        result: 'no-targets',
    });
    assert.doesNotMatch(JSON.stringify(shujukuCheckEvents().at(-1)), /PRIVATE CELL VALUE|storageFrame/);
});

test('a new post-arm row_upsert is skipped when current exported data supersedes its value', async () => {
    const target = createMessage(4, []);
    const trigger = { is_user: false, mes: 'current generation trigger' };
    const chat = Array.from({ length: 9 }, () => ({ is_user: true, mes: 'user' }));
    chat[4] = target;
    chat[8] = trigger;
    installProgramRules(chat);
    const api = installShujukuApi(createMultiRowTableData(['SECRET B']));
    assert.equal(markLatestMessageShujukuRewritePending(8), true);

    appendShujukuMutation(target, 4, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET A'],
    }]);
    api.invokeCallback();
    await settleAsyncCallback();

    assert.deepEqual(api.calls, []);
    assert.deepEqual(shujukuCheckEvents().at(-1)?.details, {
        source: 'shujuku-auto',
        messageId: 8,
        persistenceTargetCount: 1,
        newEntryCount: 1,
        operationKindCounts: { row_upsert: 1 },
        rowUpsertCount: 1,
        candidateCellCount: 1,
        targetCount: 0,
        changedCount: 0,
        result: 'no-targets',
    });
});

test('automatic ownership rewrites changed-sheet cells from a new sheet_replace entry', async () => {
    const target = createMessage(4, []);
    const trigger = { is_user: false, mes: 'current generation trigger' };
    const chat = Array.from({ length: 9 }, () => ({ is_user: true, mes: 'user' }));
    chat[4] = target;
    chat[8] = trigger;
    const tableData = createTableData();
    installProgramRules(chat);
    const api = installShujukuApi(tableData);
    assert.equal(markLatestMessageShujukuRewritePending(8), true);

    appendShujukuMutation(
        target,
        4,
        [createSheetReplaceOperation(tableData, 'sheet_character')],
        ['sheet_character'],
    );
    api.invokeCallback();
    await settleAsyncCallback();

    assert.deepEqual(api.calls, [{
        tableName: '角色状态',
        rowIndex: 1,
        colIdentifier: 1,
        value: 'CLEAN',
        skipNotify: true,
    }]);
    assert.deepEqual(shujukuCommitEvents().at(-1)?.details, {
        source: 'shujuku-auto',
        messageId: 8,
        targetCount: 1,
        changedCount: 1,
    });
    assert.doesNotMatch(JSON.stringify(runtimeState.aiRewrite.debugEvents), /SECRET|CLEAN|description|内部列/);
});

test('first-init sheet_replace operations outside changedSheetKeys do not own cells', async () => {
    const target = createMessage(4, []);
    const trigger = { is_user: false, mes: 'current generation trigger' };
    const chat = Array.from({ length: 9 }, () => ({ is_user: true, mes: 'user' }));
    chat[4] = target;
    chat[8] = trigger;
    const tableData = createMultiSheetTableData({ sheet_a: 'SECRET A', sheet_b: 'SECRET B' });
    installProgramRules(chat);
    const api = installShujukuApi(tableData);
    assert.equal(markLatestMessageShujukuRewritePending(8), true);

    appendShujukuMutation(target, 4, [
        createSheetReplaceOperation(tableData, 'sheet_a'),
        createSheetReplaceOperation(tableData, 'sheet_b'),
    ], ['sheet_a']);
    api.invokeCallback();
    await settleAsyncCallback();

    assert.deepEqual(api.calls, [{
        tableName: 'Table sheet_a',
        rowIndex: 1,
        colIdentifier: 1,
        value: 'CLEAN A',
        skipNotify: true,
    }]);
    assert.equal(api.calls.some(call => call.tableName === 'Table sheet_b'), false);
});

test('later row_upsert supersedes sheet_replace ownership for the same cell', async () => {
    const target = createMessage(4, []);
    const chat = Array.from({ length: 9 }, () => ({ is_user: true, mes: 'user' }));
    chat[4] = target;
    chat[8] = { is_user: false, mes: 'current generation trigger' };
    const replacementData = createMultiSheetTableData({ sheet_a: 'SECRET A' });
    const exportedData = createMultiSheetTableData({ sheet_a: 'SECRET B' });
    installProgramRules(chat);
    const api = installShujukuApi(exportedData);
    assert.equal(markLatestMessageShujukuRewritePending(8), true);

    appendShujukuMutation(target, 4, [
        createSheetReplaceOperation(replacementData, 'sheet_a'),
        { kind: 'row_upsert', sheetKey: 'sheet_a', rowId: 'row-1', cells: ['row-1', 'SECRET B'] },
    ], ['sheet_a']);
    api.invokeCallback();
    await settleAsyncCallback();

    assert.deepEqual(api.calls, [{
        tableName: 'Table sheet_a',
        rowIndex: 1,
        colIdentifier: 1,
        value: 'CLEAN B',
        skipNotify: true,
    }]);
});

test('later sheet_replace supersedes row_upsert ownership for the same cell', async () => {
    const target = createMessage(4, []);
    const chat = Array.from({ length: 9 }, () => ({ is_user: true, mes: 'user' }));
    chat[4] = target;
    chat[8] = { is_user: false, mes: 'current generation trigger' };
    const exportedData = createMultiSheetTableData({ sheet_a: 'SECRET B' });
    installProgramRules(chat);
    const api = installShujukuApi(exportedData);
    assert.equal(markLatestMessageShujukuRewritePending(8), true);

    appendShujukuMutation(target, 4, [
        { kind: 'row_upsert', sheetKey: 'sheet_a', rowId: 'row-1', cells: ['row-1', 'SECRET A'] },
        createSheetReplaceOperation(exportedData, 'sheet_a'),
    ], ['sheet_a']);
    api.invokeCallback();
    await settleAsyncCallback();

    assert.deepEqual(api.calls, [{
        tableName: 'Table sheet_a',
        rowIndex: 1,
        colIdentifier: 1,
        value: 'CLEAN B',
        skipNotify: true,
    }]);
});

test('only the final of multiple sheet_replace operations owns each sheet cell', async () => {
    const target = createMessage(4, []);
    const chat = Array.from({ length: 9 }, () => ({ is_user: true, mes: 'user' }));
    chat[4] = target;
    chat[8] = { is_user: false, mes: 'current generation trigger' };
    const firstData = createMultiSheetTableData({ sheet_a: 'SECRET A' });
    const finalData = createMultiSheetTableData({ sheet_a: 'SECRET B' });
    installProgramRules(chat);
    const api = installShujukuApi(finalData);
    assert.equal(markLatestMessageShujukuRewritePending(8), true);

    appendShujukuMutation(target, 4, [
        createSheetReplaceOperation(firstData, 'sheet_a'),
        createSheetReplaceOperation(finalData, 'sheet_a'),
    ], ['sheet_a']);
    api.invokeCallback();
    await settleAsyncCallback();

    assert.deepEqual(api.calls, [{
        tableName: 'Table sheet_a',
        rowIndex: 1,
        colIdentifier: 1,
        value: 'CLEAN B',
        skipNotify: true,
    }]);
});

test('sheet_replace current-value protection rejects stale operation-owned cells', async () => {
    const target = createMessage(4, []);
    const chat = Array.from({ length: 9 }, () => ({ is_user: true, mes: 'user' }));
    chat[4] = target;
    chat[8] = { is_user: false, mes: 'current generation trigger' };
    const replacementData = createMultiSheetTableData({ sheet_a: 'SECRET A' });
    const exportedData = createMultiSheetTableData({ sheet_a: 'SECRET B' });
    installProgramRules(chat);
    const api = installShujukuApi(exportedData);
    assert.equal(markLatestMessageShujukuRewritePending(8), true);

    appendShujukuMutation(
        target,
        4,
        [createSheetReplaceOperation(replacementData, 'sheet_a')],
        ['sheet_a'],
    );
    api.invokeCallback();
    await settleAsyncCallback();

    assert.deepEqual(api.calls, []);
    assert.deepEqual(shujukuCheckEvents().at(-1)?.details, {
        source: 'shujuku-auto',
        messageId: 8,
        persistenceTargetCount: 1,
        newEntryCount: 1,
        operationKindCounts: { sheet_replace: 1 },
        rowUpsertCount: 0,
        candidateCellCount: 1,
        targetCount: 0,
        changedCount: 0,
        result: 'no-targets',
    });
});

test('sheet_replace keeps row_id and hidden physical columns out of Program Rewrite', async () => {
    const target = createMessage(4, []);
    const chat = Array.from({ length: 9 }, () => ({ is_user: true, mes: 'user' }));
    chat[4] = target;
    chat[8] = { is_user: false, mes: 'current generation trigger' };
    const tableData = createTableData('SECRET VISIBLE', 'SECRET HIDDEN');
    installProgramRules(chat);
    const api = installShujukuApi(tableData);
    assert.equal(markLatestMessageShujukuRewritePending(8), true);

    appendShujukuMutation(
        target,
        4,
        [createSheetReplaceOperation(tableData, 'sheet_character')],
        ['sheet_character'],
    );
    api.invokeCallback();
    await settleAsyncCallback();

    assert.deepEqual(api.calls, [{
        tableName: '角色状态',
        rowIndex: 1,
        colIdentifier: 1,
        value: 'CLEAN VISIBLE',
        skipNotify: true,
    }]);
});

test('sheet_replace without changedSheetKeys ownership yields no structural candidates', async () => {
    const target = createMessage(4, []);
    const chat = Array.from({ length: 9 }, () => ({ is_user: true, mes: 'user' }));
    chat[4] = target;
    chat[8] = { is_user: false, mes: 'current generation trigger' };
    const tableData = createMultiSheetTableData({ sheet_a: 'SECRET A' });
    installProgramRules(chat);
    const api = installShujukuApi(tableData);
    assert.equal(markLatestMessageShujukuRewritePending(8), true);

    appendShujukuMutation(target, 4, [createSheetReplaceOperation(tableData, 'sheet_a')], []);
    api.invokeCallback();
    await settleAsyncCallback();

    assert.deepEqual(api.calls, []);
    assert.deepEqual(shujukuCheckEvents().at(-1)?.details, {
        source: 'shujuku-auto',
        messageId: 8,
        persistenceTargetCount: 1,
        newEntryCount: 1,
        operationKindCounts: { sheet_replace: 1 },
        rowUpsertCount: 0,
        candidateCellCount: 0,
        targetCount: 0,
        changedCount: 0,
        result: 'no-targets',
    });
});

test('skipped-latest-layer ownership accepts changed sheet_replace on the actual persistence target', async () => {
    const chat = Array.from({ length: 13 }, () => ({ is_user: true, mes: 'user' }));
    chat[8] = createMessage(8, []);
    chat[10] = createMessage(10, []);
    chat[12] = { is_user: false, mes: 'current generation trigger' };
    const tableData = createMultiSheetTableData({ sheet_a: 'SECRET A' });
    installProgramRules(chat);
    const api = installShujukuApi(tableData);
    assert.equal(markLatestMessageShujukuRewritePending(12), true);

    appendShujukuMutation(
        chat[10],
        10,
        [createSheetReplaceOperation(tableData, 'sheet_a')],
        ['sheet_a'],
    );
    api.invokeCallback();
    await settleAsyncCallback();

    assert.equal(chat[12].TavernDB_ACU_IsolatedData, undefined);
    assert.deepEqual(api.calls, [{
        tableName: 'Table sheet_a',
        rowIndex: 1,
        colIdentifier: 1,
        value: 'CLEAN A',
        skipNotify: true,
    }]);
});

test('normal sheet_replace double-refresh cannot duplicate Program Rewrite writes', async () => {
    const message = createMessage(1, []);
    const chat = [{ is_user: true, mes: 'user' }, message];
    const tableData = createMultiSheetTableData({ sheet_a: 'SECRET A' });
    const write = deferred();
    installProgramRules(chat);
    const api = installShujukuApi(tableData, () => write.promise);
    assert.equal(markLatestMessageShujukuRewritePending(1), true);

    appendShujukuMutation(
        message,
        1,
        [createSheetReplaceOperation(tableData, 'sheet_a')],
        ['sheet_a'],
    );
    api.invokeCallback();
    api.invokeCallback();
    assert.equal(api.calls.length, 1);

    write.resolve(true);
    await settleAsyncCallback();
    assert.equal(api.calls.length, 1);
    assert.equal(shujukuCommitEvents().length, 1);
});

test('AI-owned host finalization arms the exact Shujuku target before AI completion', async () => {
    const previousSetInterval = globalThis.setInterval;
    const previousClearInterval = globalThis.clearInterval;
    const target = createMessage(2, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET ONE', 'SECRET TWO'],
    }]);
    target.mes = '<content>AI</content>';
    target.swipe_id = 0;
    target.swipes = [target.mes];
    target.swipe_info = [{}];
    const chat = [
        createMessage(0, [{
            kind: 'row_upsert',
            sheetKey: 'sheet_character',
            rowId: 'historical-row',
            cells: ['historical-row', 'HISTORICAL SECRET'],
        }]),
        { is_user: true, mes: 'user' },
        target,
    ];
    let tableData = createTwoCellTableData('NOT READY ONE', 'NOT READY TWO');
    const firstWrite = deferred();
    const aiStarted = deferred();
    const aiResponse = deferred();
    const { eventSource, eventTypes } = createHostEventHarness();
    const api = installShujukuApi(() => tableData, () => (
        api.calls.length === 1 ? firstWrite.promise : Promise.resolve(true)
    ));
    globalThis.window.addEventListener = () => {};
    globalThis.document = {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        documentElement: {
            setAttribute: () => {},
            removeAttribute: () => {},
        },
    };
    globalThis.toastr = {
        info: () => ({}),
        success: () => ({}),
        warning: () => ({}),
        error: () => ({}),
        clear: () => {},
        remove: () => {},
    };
    globalThis.TavernHelper = {
        generateRaw: () => {
            aiStarted.resolve();
            return aiResponse.promise;
        },
        stopGenerationById: () => true,
    };
    globalThis.setInterval = () => 1;
    globalThis.clearInterval = () => {};

    try {
        installHostLifecycleHarness(chat, createAiOwnedSettings(), eventSource, eventTypes);

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        const session = generationLifecycle.getActive();
        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 2, 'normal');
        await aiStarted.promise;

        assert.equal(session.messageId, 2);
        assert.equal(session.messageRef, target);
        assert.deepEqual(shujukuPendingEvents().at(-1)?.details, {
            source: 'ai-finalization',
            messageId: 2,
        });
        assert.equal(api.registrationCalls.length, 1);
        assert.equal(api.callbacks.length, 1);
        assert.equal(runtimeState.aiRewrite.debugEvents.some(event => event.stage === 'atomic-commit'), false);

        api.invokeCallback();
        await settleAsyncCallback();
        assert.deepEqual(api.calls, []);
        assert.equal(shujukuCheckEvents().length, 1);
        assert.deepEqual(shujukuCheckEvents()[0].details, {
            source: 'shujuku-auto',
            messageId: 2,
            persistenceTargetCount: 0,
            newEntryCount: 0,
            operationKindCounts: {},
            rowUpsertCount: 0,
            candidateCellCount: 0,
            targetCount: 0,
            changedCount: 0,
            result: 'no-targets',
        });

        tableData = createTwoCellTableData();
        appendShujukuMutation(target, 2, [{
            kind: 'row_upsert',
            sheetKey: 'sheet_character',
            rowId: 'row-1',
            cells: ['row-1', 'SECRET ONE', 'SECRET TWO'],
        }]);
        api.invokeCallback();
        assert.equal(api.calls.length, 1);
        assert.deepEqual(api.calls[0], {
            tableName: '角色状态',
            rowIndex: 1,
            colIdentifier: 1,
            value: 'CLEAN ONE',
            skipNotify: true,
        });

        firstWrite.resolve(true);
        await settleAsyncCallback();
        assert.deepEqual(api.calls[1], {
            tableName: '角色状态',
            rowIndex: 1,
            colIdentifier: 2,
            value: 'CLEAN TWO',
            skipNotify: true,
        });
        assert.equal(shujukuCommitEvents().length, 1);
        assert.deepEqual(shujukuCommitEvents()[0].details, {
            source: 'shujuku-auto',
            messageId: 2,
            targetCount: 2,
            changedCount: 2,
        });

        aiResponse.resolve(JSON.stringify({ 'hit-1': 'AI' }));
        await waitForAutomaticAiRewrite(session.generationId);
        assert.equal(target.mes, '<content>AI</content>');
        assert.equal(runtimeState.aiRewrite.debugEvents.some(event => event.stage === 'atomic-commit'), false);

        const exportCountBeforeRejectedPayload = api.exportCount;
        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 1, 'normal');
        api.invokeCallback();
        await settleAsyncCallback();
        assert.equal(api.exportCount, exportCountBeforeRejectedPayload);
        assert.equal(shujukuCommitEvents().length, 1);
    } finally {
        firstWrite.resolve(true);
        aiResponse.resolve(JSON.stringify({ 'hit-1': 'AI' }));
        globalThis.setInterval = previousSetInterval;
        globalThis.clearInterval = previousClearInterval;
    }
});

test('non-AI host finalization remains single-owned by the core cleanse path', async () => {
    const previousSetInterval = globalThis.setInterval;
    const previousClearInterval = globalThis.clearInterval;
    const target = createMessage(2, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET ONE', 'SECRET TWO'],
    }]);
    target.mes = 'ordinary message';
    const chat = [createMessage(0, []), { is_user: true, mes: 'user' }, target];
    const firstWrite = deferred();
    const { eventSource, eventTypes } = createHostEventHarness();
    const api = installShujukuApi(createTwoCellTableData(), () => (
        api.calls.length === 1 ? firstWrite.promise : Promise.resolve(true)
    ));
    globalThis.window.addEventListener = () => {};
    globalThis.document = {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
    };
    globalThis.setInterval = () => 1;
    globalThis.clearInterval = () => {};

    try {
        installHostLifecycleHarness(chat, {
            shujukuAutoProgramRewriteEnabled: true,
            rules: [programRule()],
        }, eventSource, eventTypes);

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 2, 'normal');
        assert.equal(target.mes, 'ordinary message');

        appendShujukuMutation(target, 2, [{
            kind: 'row_upsert',
            sheetKey: 'sheet_character',
            rowId: 'row-1',
            cells: ['row-1', 'SECRET ONE', 'SECRET TWO'],
        }]);
        api.invokeCallback();
        api.invokeCallback();
        assert.equal(api.calls.length, 1);

        firstWrite.resolve(true);
        await settleAsyncCallback();
        assert.equal(api.calls.length, 2);
        assert.equal(shujukuCommitEvents().length, 1);

        const exportCountAfterCommit = api.exportCount;
        api.invokeCallback();
        await settleAsyncCallback();
        assert.equal(api.exportCount, exportCountAfterCommit);
        assert.equal(api.calls.length, 2);
        assert.equal(shujukuCommitEvents().length, 1);
    } finally {
        firstWrite.resolve(true);
        globalThis.setInterval = previousSetInterval;
        globalThis.clearInterval = previousClearInterval;
    }
});

test('MVU final transaction keeps Shujuku pending ownership in the core cleanse path', async () => {
    const previousSetInterval = globalThis.setInterval;
    const previousClearInterval = globalThis.clearInterval;
    const target = createMessage(2, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET', 'SECRET HIDDEN'],
    }]);
    target.mes = 'ordinary message';
    const chat = [createMessage(0, []), { is_user: true, mes: 'user' }, target];
    const { eventSource, eventTypes } = createHostEventHarness();
    const api = installShujukuApi(createTableData());
    globalThis.window.addEventListener = () => {};
    globalThis.document = {
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
    };
    globalThis.Mvu = {
        events: { BEFORE_MESSAGE_UPDATE: 'mvu-before-message-update' },
        isDuringExtraAnalysis: () => false,
    };
    globalThis.TavernHelper = {
        getCurrentCharPrimaryLorebook: async () => 'character-book',
        getLorebookEntries: async () => [{ comment: '[mvu_update] variables' }],
    };
    globalThis.setInterval = () => 1;
    globalThis.clearInterval = () => {};

    const settings = {
        shujukuAutoProgramRewriteEnabled: true,
        rules: [programRule()],
    };
    const mvuSettings = {
        '更新方式': '额外模型解析',
        '额外模型解析配置': { '启用自动请求': true },
    };

    try {
        installHostLifecycleHarness(chat, settings, eventSource, eventTypes);
        initAppContext({
            ...getAppContext(),
            extension_settings: {
                [extensionName]: settings,
                mvu_settings: mvuSettings,
            },
        });

        await eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
        await eventSource.emit(eventTypes.MESSAGE_RECEIVED, 2, 'normal');
        assert.equal(target.mes, 'ordinary message');
        assert.equal(runtimeState.aiRewrite.debugEvents.some(event => (
            event.stage === 'final-cleanse-deferred-to-mvu'
        )), true);

        await eventSource.emit('mvu-before-message-update', { message_content: target.mes });
        assert.equal(target.mes, 'ordinary message');

        appendShujukuMutation(target, 2, [{
            kind: 'row_upsert',
            sheetKey: 'sheet_character',
            rowId: 'row-1',
            cells: ['row-1', 'SECRET', 'SECRET HIDDEN'],
        }]);
        api.invokeCallback();
        await settleAsyncCallback();
        assert.equal(api.calls.length, 1);
        assert.equal(shujukuCommitEvents().length, 1);

        const exportCountAfterCommit = api.exportCount;
        api.invokeCallback();
        await settleAsyncCallback();
        assert.equal(api.exportCount, exportCountAfterCommit);
        assert.equal(shujukuCommitEvents().length, 1);
    } finally {
        globalThis.setInterval = previousSetInterval;
        globalThis.clearInterval = previousClearInterval;
    }
});

test('table-update callback without a pending Program Rewrite target is a no-op', async () => {
    const chat = [{ is_user: false, mes: 'assistant' }];
    installProgramRules(chat);
    const api = installShujukuApi(createTableData());
    registerShujukuTableUpdateCallback();

    api.invokeCallback();
    await settleAsyncCallback();

    assert.equal(api.exportCount, 0);
    assert.deepEqual(api.calls, []);
    assert.deepEqual(shujukuCallbackEvents().map(event => event.details), [{
        hasPending: false,
        active: false,
    }]);
    assert.equal(shujukuCheckEvents().length, 0);
    assert.equal(shujukuCommitEvents().length, 0);
});

test('disabled automatic entry is inert before Shujuku history capture', async () => {
    const latest = createMessage(1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET', 'SECRET HIDDEN'],
    }]);
    const chat = new Proxy([{ is_user: false, mes: 'history' }, latest], {
        get(target, property, receiver) {
            if (property === '0') throw new Error('disabled entry inspected Shujuku history');
            return Reflect.get(target, property, receiver);
        },
    });
    installProgramRules(chat, { shujukuAutoProgramRewriteEnabled: false });
    const api = installShujukuApi(createTableData());

    assert.equal(markLatestMessageShujukuRewritePending(1), false);
    assert.equal(api.registrationCalls.length, 0);
    assert.equal(api.callbacks.length, 0);
    assert.equal(api.exportCount, 0);
    assert.deepEqual(api.calls, []);
    assert.equal(shujukuPendingEvents().length, 0);

    getAppContext().extension_settings[extensionName].shujukuAutoProgramRewriteEnabled = true;
    registerShujukuTableUpdateCallback();
    api.invokeCallback();
    await settleAsyncCallback();
    assert.equal(api.exportCount, 0);
    assert.deepEqual(api.calls, []);
});

test('disabling clears armed pending work and re-enabling cannot resurrect it', async () => {
    const message = { is_user: false, mes: 'assistant' };
    const chat = [{ is_user: true, mes: 'user' }, message];
    installProgramRules(chat);
    const api = installShujukuApi(createTableData());
    assert.equal(markLatestMessageShujukuRewritePending(1), true);
    assert.equal(api.callbacks.length, 1);

    getAppContext().extension_settings[extensionName].shujukuAutoProgramRewriteEnabled = false;
    clearPendingShujukuRewrite();
    appendShujukuMutation(message, 1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET', 'SECRET HIDDEN'],
    }]);
    api.invokeCallback();
    await settleAsyncCallback();
    assert.equal(api.exportCount, 0);
    assert.deepEqual(api.calls, []);

    getAppContext().extension_settings[extensionName].shujukuAutoProgramRewriteEnabled = true;
    api.invokeCallback();
    await settleAsyncCallback();
    assert.equal(api.exportCount, 0);
    assert.deepEqual(api.calls, []);
});

test('global cleanse does not arm automatic Program Rewrite ownership', async () => {
    const message = createMessage(1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET', 'SECRET HIDDEN'],
    }]);
    const chat = [{ is_user: true, mes: 'user' }, message];
    const existingStorage = structuredClone(message.TavernDB_ACU_IsolatedData);
    installProgramRules(chat);
    const api = installShujukuApi(createTableData());
    globalThis.document = {
        getElementById: () => null,
        querySelectorAll: () => [],
    };
    registerShujukuTableUpdateCallback();
    assert.equal(api.callbacks.length, 1);

    performGlobalCleanse();

    assert.deepEqual(message.TavernDB_ACU_IsolatedData, existingStorage);
    assert.equal(shujukuPendingEvents().length, 0);

    api.invokeCallback();
    await settleAsyncCallback();

    assert.equal(api.exportCount, 0);
    assert.deepEqual(api.calls, []);
    assert.equal(shujukuCheckEvents().length, 0);
    assert.equal(shujukuCommitEvents().length, 0);
});

test('pending ownership is tied to the exact message object and never retargeted', async () => {
    const original = createMessage(1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET', 'SECRET HIDDEN'],
    }]);
    const replacement = createMessage(1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET', 'SECRET HIDDEN'],
    }]);
    const chat = [{ is_user: true, mes: 'user' }, original];
    installProgramRules(chat);
    const api = installShujukuApi(createTableData());
    assert.equal(markLatestMessageShujukuRewritePending(1), true);

    chat[1] = replacement;
    api.invokeCallback();
    await settleAsyncCallback();

    assert.equal(api.exportCount, 0);
    assert.deepEqual(api.calls, []);
});

test('callback before row_upsert ownership is ready retains the exact pending target', async () => {
    const message = { is_user: false, mes: 'assistant' };
    const chat = [{ is_user: true, mes: 'user' }, message];
    let tableData = createTableData('NOT READY');
    installProgramRules(chat);
    const api = installShujukuApi(() => tableData);
    assert.equal(markLatestMessageShujukuRewritePending(1), true);

    api.invokeCallback();
    await settleAsyncCallback();
    assert.deepEqual(api.calls, []);
    assert.equal(shujukuCheckEvents().length, 1);
    assert.deepEqual(shujukuCheckEvents()[0].details, {
        source: 'shujuku-auto',
        messageId: 1,
        persistenceTargetCount: 0,
        newEntryCount: 0,
        operationKindCounts: {},
        rowUpsertCount: 0,
        candidateCellCount: 0,
        targetCount: 0,
        changedCount: 0,
        result: 'no-targets',
    });
    assert.equal(shujukuCommitEvents().length, 0);
    assert.doesNotMatch(JSON.stringify(shujukuCheckEvents()[0]), /NOT READY|SECRET/);

    Object.assign(message, createMessage(1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET', 'SECRET HIDDEN'],
    }]));
    tableData = createTableData();
    api.invokeCallback();
    await settleAsyncCallback();

    assert.equal(api.calls.length, 1);
    assert.equal(shujukuCheckEvents().length, 1);
    assert.equal(shujukuCommitEvents().length, 1);
});

test('duplicate callbacks cannot start concurrent duplicate writes and consumed work stays consumed', async () => {
    const message = createMessage(1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET', 'SECRET HIDDEN'],
    }]);
    const chat = [{ is_user: true, mes: 'user' }, message];
    const write = deferred();
    installProgramRules(chat);
    const api = installShujukuApi(createTableData(), () => write.promise);
    markLatestMessageShujukuRewritePending(1);

    appendShujukuMutation(message, 1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET', 'SECRET HIDDEN'],
    }]);
    api.invokeCallback();
    api.invokeCallback();
    assert.equal(api.calls.length, 1);
    assert.deepEqual(shujukuCallbackEvents().map(event => event.details), [
        { hasPending: true, active: false, messageId: 1 },
        { hasPending: false, active: true },
    ]);

    write.resolve(true);
    await settleAsyncCallback();
    api.invokeCallback();
    await settleAsyncCallback();
    assert.equal(api.calls.length, 1);
});

test('compatibility writes use object-form addressing with skipNotify and remain sequential', async () => {
    const message = createMessage(1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET ONE', 'SECRET TWO'],
    }]);
    const chat = [{ is_user: true, mes: 'user' }, message];
    const firstWrite = deferred();
    installProgramRules(chat);
    const api = installShujukuApi(createTwoCellTableData(), () => (
        api.calls.length === 1 ? firstWrite.promise : Promise.resolve(true)
    ));
    markLatestMessageShujukuRewritePending(1);

    appendShujukuMutation(message, 1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET ONE', 'SECRET TWO'],
    }]);
    api.invokeCallback();
    assert.equal(api.calls.length, 1);
    assert.deepEqual(api.calls[0], {
        tableName: '角色状态',
        rowIndex: 1,
        colIdentifier: 1,
        value: 'CLEAN ONE',
        skipNotify: true,
    });

    firstWrite.resolve(true);
    await settleAsyncCallback();
    assert.deepEqual(api.calls[1], {
        tableName: '角色状态',
        rowIndex: 1,
        colIdentifier: 2,
        value: 'CLEAN TWO',
        skipNotify: true,
    });
    assert.equal(shujukuCommitEvents().length, 1);
    assert.equal(shujukuCheckEvents().length, 0);
    assert.deepEqual(shujukuCommitEvents()[0].details, {
        source: 'shujuku-auto',
        messageId: 1,
        targetCount: 2,
        changedCount: 2,
    });
    assert.doesNotMatch(JSON.stringify(shujukuCommitEvents()[0]), /SECRET ONE|SECRET TWO|CLEAN ONE|CLEAN TWO/);
});

test('an eligible zero-match pass consumes pending work', async () => {
    const message = createMessage(1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'ORDINARY', 'SECRET HIDDEN'],
    }]);
    const chat = [{ is_user: true, mes: 'user' }, message];
    installProgramRules(chat);
    const api = installShujukuApi(createTableData('ORDINARY'));
    markLatestMessageShujukuRewritePending(1);

    appendShujukuMutation(message, 1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'ORDINARY', 'SECRET HIDDEN'],
    }]);
    api.invokeCallback();
    await settleAsyncCallback();
    assert.equal(api.exportCount, 1);
    assert.deepEqual(api.calls, []);
    assert.equal(shujukuCommitEvents().length, 0);
    assert.equal(shujukuCheckEvents().length, 1);
    assert.deepEqual(shujukuCheckEvents()[0].details, {
        source: 'shujuku-auto',
        messageId: 1,
        persistenceTargetCount: 1,
        newEntryCount: 1,
        operationKindCounts: { row_upsert: 1 },
        rowUpsertCount: 1,
        candidateCellCount: 2,
        targetCount: 1,
        changedCount: 0,
        result: 'no-changes',
    });
    assert.doesNotMatch(JSON.stringify(shujukuCheckEvents()[0]), /ORDINARY|SECRET HIDDEN/);

    api.invokeCallback();
    await settleAsyncCallback();
    assert.equal(api.exportCount, 1);
    assert.deepEqual(api.calls, []);
    assert.equal(shujukuCommitEvents().length, 0);
    assert.equal(shujukuCheckEvents().length, 1);
});

test('a failed automatic batch keeps existing warning ownership and emits no success summary', async () => {
    const message = createMessage(1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET ONE', 'SECRET TWO'],
    }]);
    const chat = [{ is_user: true, mes: 'user' }, message];
    installProgramRules(chat);
    const api = installShujukuApi(createTwoCellTableData(), async () => api.calls.length < 2);
    markLatestMessageShujukuRewritePending(1);

    appendShujukuMutation(message, 1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET ONE', 'SECRET TWO'],
    }]);
    api.invokeCallback();
    await settleAsyncCallback();

    assert.equal(api.calls.length, 2);
    assert.equal(shujukuCommitEvents().length, 0);
    assert.equal(shujukuCheckEvents().length, 0);
});

test('a failed direct batch keeps its zero return and emits no success summary', async () => {
    const message = createMessage(1, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET', 'SECRET HIDDEN'],
    }]);
    const chat = [{ is_user: true, mes: 'user' }, message];
    installProgramRules(chat);
    installShujukuApi(createTableData(), async () => false);

    assert.equal(await rewriteLatestMessageShujukuCells(1), 0);
    assert.equal(shujukuCommitEvents().length, 0);
    assert.equal(shujukuCheckEvents().length, 0);
});

test('Deep Clean directly awaits shujuku persistence without adding it to host-save accounting', async () => {
    const message = createMessage(0, [{
        kind: 'row_upsert',
        sheetKey: 'sheet_character',
        rowId: 'row-1',
        cells: ['row-1', 'SECRET', 'SECRET HIDDEN'],
    }]);
    message.mes = 'ordinary assistant text';
    const chat = [message];
    let hostSaveCalls = 0;
    let finished = false;
    const write = deferred();
    const writeStarted = deferred();
    installProgramRules(chat, {
        saveChat: async () => { hostSaveCalls++; },
        shujukuAutoProgramRewriteEnabled: false,
    });
    installDeepCleanGlobals();
    const api = installShujukuApi(createTableData(), () => {
        writeStarted.resolve();
        return write.promise;
    });

    const deepClean = performDeepCleanse().then(() => { finished = true; });
    await writeStarted.promise;
    assert.equal(finished, false);
    assert.equal(api.calls.length, 1);

    write.resolve(true);
    await deepClean;
    assert.equal(hostSaveCalls, 0);
});

test('without shujuku, Program Rewrite and genuine Deep Clean changes keep existing host-save behavior', async () => {
    const automaticMessage = { is_user: false, mes: 'SECRET' };
    installProgramRules([automaticMessage]);
    installDeepCleanGlobals();
    globalThis.window = {};
    assert.equal(cleanseMessageDataAtIndex(0), true);
    assert.equal(automaticMessage.mes, 'CLEAN');

    const deepMessage = { is_user: false, mes: 'SECRET' };
    let hostSaveCalls = 0;
    let settingsSaveCalls = 0;
    let reloadCalls = 0;
    installProgramRules([deepMessage], {
        saveChat: async () => { hostSaveCalls++; },
        saveSettingsDebounced: () => { settingsSaveCalls++; },
    });
    installDeepCleanGlobals();
    globalThis.window = {};
    globalThis.location.reload = () => { reloadCalls++; };

    await performDeepCleanse();

    assert.equal(deepMessage.mes, 'CLEAN');
    assert.equal(hostSaveCalls, 1);
    assert.equal(settingsSaveCalls, 1);
    assert.equal(reloadCalls, 1);
});
