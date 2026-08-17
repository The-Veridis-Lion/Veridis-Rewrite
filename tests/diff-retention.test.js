import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getLatestAssistantMessageIndices,
    getLatestTrackableDiffIndices,
    injectDiffButtons,
    restoreDiffStateFromChatMetadata,
    syncTrackedIndicesToLatestAssistantMessages,
} from '../src/diff.js';
import { cleanseMessageDataAtIndex, performGlobalCleanse } from '../src/core.js';
import { recleanseDiffMessageAtIndex } from '../src/events/diff.js';
import { getMessageDiffMeta, writeMessageDiffAiTrace, writeMessageDiffMeta } from '../src/messageMeta.js';
import { buildProcessors } from '../src/replacementEngine.js';
import { diffMetadataKey, extensionName, getAppContext, initAppContext, runtimeState } from '../src/state.js';

function assistant(text, swipeCount = 0) {
    if (swipeCount <= 0) return { is_user: false, mes: text };
    const swipes = Array.from({ length: swipeCount }, (_, index) => `${text} swipe ${index}`);
    return {
        is_user: false,
        mes: swipes[swipes.length - 1],
        swipe_id: swipes.length - 1,
        swipes,
        swipe_info: swipes.map((_, index) => ({ extra: { native: index } })),
    };
}

function user(text) {
    return { is_user: true, mes: text };
}

function installContext(chat, diffTrackedMessageLimit, chatMetadata = { chatId: 'diff-retention' }, rules = []) {
    initAppContext({
        chat,
        chat_metadata: chatMetadata,
        extension_settings: {
            [extensionName]: {
                diffTrackedMessageLimit,
                rules,
                scopeTags: [],
                scopeTagBuiltinDismissed: [],
                scopeTagMode: 'protect',
            },
        },
        saveChat: async () => {},
        getSillyTavernContext: () => ({
            chat,
            getCurrentChatId: () => 'diff-retention',
            saveChat: async () => {},
        }),
    });
}

function resetRetentionRuntime() {
    runtimeState.diffSnippetsCache.clear();
    runtimeState.diffRawSourceCache.clear();
    runtimeState.nonStreamingRawMessageCache.clear();
    runtimeState.diffMessageStates.clear();
    runtimeState.trackedDiffMessageOrder = [];
    if (runtimeState.chatSaveTimer) clearTimeout(runtimeState.chatSaveTimer);
    runtimeState.chatSaveTimer = null;
    runtimeState.pendingChatSave = false;
    runtimeState.chatSaveInFlight = false;
    runtimeState.chatSaveDelayCount = 0;
    runtimeState.activeProcessors = [];
    runtimeState.activeVisualProcessors = [];
    runtimeState.isRegexDirty = true;
}

function programRule() {
    return {
        enabled: true,
        name: 'Diff retention cleanse',
        subRules: [{
            enabled: true,
            rewriteMode: 'program',
            mode: 'text',
            targets: ['SECRET'],
            replacements: ['CLEAN'],
        }],
    };
}

function aiRule(overrides = {}) {
    return {
        enabled: true,
        name: 'Diff AI recleanse',
        subRules: [{
            enabled: true,
            rewriteMode: 'ai',
            mode: 'text',
            targets: ['AI'],
            replacements: ['CURRENT'],
            ...overrides,
        }],
    };
}

function seedRevertedAiFinal(message, branchKey, originalMes) {
    writeMessageDiffMeta(message, branchKey, originalMes, 'OLD PROGRAM', 'old-signature');
    writeMessageDiffAiTrace(message, branchKey, 'OLD PROGRAM', 'OLD AI FINAL');
    message.mes = originalMes;
    if (Array.isArray(message.swipes)) message.swipes[message.swipe_id] = originalMes;
    message.__blai_is_reverted = true;
}

function assertNoVeridisDiffMetadata(message) {
    for (const key of [
        '__blai_diff_branch_meta',
        '__blai_original_mes',
        '__blai_diff_source_signature',
        '__blai_diff_last_cleaned_mes',
        '__blai_diff_ai_program_mes',
        '__blai_diff_ai_final_mes',
        '__blai_diff_has_ai_trace',
        '__blai_diff_final_source',
        '__blai_diff_swipe_key',
    ]) {
        assert.equal(key in message, false, `${key} must be absent`);
    }
}

function seedDiffRuntime(index) {
    runtimeState.diffMessageStates.set(index, { status: 'ready', signature: `floor-${index}`, updatedAt: index });
    runtimeState.diffSnippetsCache.set(index, { snippets: [`floor-${index}`], fullDiff: '', signature: `floor-${index}` });
    runtimeState.diffRawSourceCache.set(index, { branchKey: 'main', mes: `floor-${index}`, signature: `floor-${index}` });
    runtimeState.nonStreamingRawMessageCache.set(index, `floor-${index}`);
    runtimeState.trackedDiffMessageOrder.push(index);
}

function writeAllBranchMetadata(message, floor) {
    const branchCount = Array.isArray(message.swipes) ? message.swipes.length : 1;
    for (let branch = 0; branch < branchCount; branch++) {
        const branchKey = Array.isArray(message.swipes) ? `swipe:${branch}` : 'main';
        writeMessageDiffMeta(
            message,
            branchKey,
            `floor ${floor} original ${branch}`,
            `floor ${floor} cleaned ${branch}`,
            `floor ${floor} signature ${branch}`,
        );
    }
}

function countQueuedSaveSchedules(operation) {
    const previousSetTimeout = globalThis.setTimeout;
    let scheduleCount = 0;
    globalThis.setTimeout = () => ++scheduleCount;
    try {
        operation();
    } finally {
        globalThis.setTimeout = previousSetTimeout;
    }
    return scheduleCount;
}

let previousContext;
let previousDocument;
let previousWindow;
let previousSetInterval;
let previousFetch;

test.beforeEach(() => {
    previousContext = { ...getAppContext() };
    previousDocument = globalThis.document;
    previousWindow = globalThis.window;
    previousSetInterval = globalThis.setInterval;
    previousFetch = globalThis.fetch;
    globalThis.document = {
        getElementById() { return null; },
        querySelectorAll() { return []; },
    };
    globalThis.window = { addEventListener() {} };
    globalThis.setInterval = () => 1;
    resetRetentionRuntime();
    runtimeState.aiRewrite.debugEvents = [];
    runtimeState.aiRewrite.criticalDebugEvents = [];
});

test.afterEach(() => {
    resetRetentionRuntime();
    initAppContext(previousContext);
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.setInterval = previousSetInterval;
    globalThis.fetch = previousFetch;
});

test('the existing Diff floor window is the authoritative user-configured history', () => {
    const chat = [
        assistant('floor 0'),
        user('user 1'),
        assistant('floor 2'),
        user('user 3'),
        assistant('floor 4'),
        user('user 5'),
        assistant('floor 6'),
        user('user 7'),
        assistant('floor 8'),
    ];
    installContext(chat, 3);

    assert.deepEqual(getLatestAssistantMessageIndices(chat), [4, 6, 8]);
    assert.deepEqual(getLatestTrackableDiffIndices(), [4, 6, 8]);
});

test('button injection cannot erase the historical order needed for incremental eviction', () => {
    const chat = [
        assistant('floor 0', 4),
        user('user 1'),
        assistant('floor 2', 4),
        user('user 3'),
        assistant('floor 4', 4),
    ];
    installContext(chat, 2);
    writeAllBranchMetadata(chat[0], 0);
    runtimeState.trackedDiffMessageOrder = [0, 2];
    runtimeState.diffRawSourceCache.set(0, { branchKey: 'main', mes: 'floor 0', signature: 'floor-0' });
    runtimeState.nonStreamingRawMessageCache.set(0, 'floor 0');

    injectDiffButtons();

    assert.deepEqual(runtimeState.trackedDiffMessageOrder, [0, 2]);
    assert.equal('__blai_diff_branch_meta' in chat[0], true);

    const queuedSaves = countQueuedSaveSchedules(() => syncTrackedIndicesToLatestAssistantMessages());

    assert.deepEqual(runtimeState.trackedDiffMessageOrder, [2, 4]);
    assert.equal('__blai_diff_branch_meta' in chat[0], false);
    assert.equal(runtimeState.diffRawSourceCache.has(0), false);
    assert.equal(runtimeState.nonStreamingRawMessageCache.has(0), false);
    assert.equal(queuedSaves, 1);
});

test('chat restore removes historical Diff residue absent from saved and runtime orders', () => {
    const chat = [
        assistant('floor 0', 12),
        user('user 1'),
        assistant('floor 2', 12),
        user('user 3'),
        assistant('floor 4', 16),
    ];
    const chatMetadata = {
        chatId: 'diff-retention',
        [diffMetadataKey]: {
            version: 2,
            order: [2, 4],
            entries: {},
        },
    };
    installContext(chat, 2, chatMetadata);
    for (const floor of [0, 2, 4]) writeAllBranchMetadata(chat[floor], floor);
    const oldFloorNative = {
        mes: chat[0].mes,
        swipes: structuredClone(chat[0].swipes),
        swipe_info: structuredClone(chat[0].swipe_info),
    };

    const queuedSaves = countQueuedSaveSchedules(() => restoreDiffStateFromChatMetadata());

    assert.equal('__blai_diff_branch_meta' in chat[0], false);
    assert.equal(Object.keys(chat[2].__blai_diff_branch_meta).length, 12);
    assert.equal(Object.keys(chat[4].__blai_diff_branch_meta).length, 16);
    assert.equal(getMessageDiffMeta(chat[4], 'swipe:0').originalMes, 'floor 4 original 0');
    assert.deepEqual(runtimeState.trackedDiffMessageOrder, [2, 4]);
    assert.equal(chat[0].mes, oldFloorNative.mes);
    assert.deepEqual(chat[0].swipes, oldFloorNative.swipes);
    assert.deepEqual(chat[0].swipe_info, oldFloorNative.swipe_info);
    assert.equal(queuedSaves, 1);
});

test('changing the Diff limit fully clears old residue while retaining every branch in the new window', () => {
    const chat = [
        assistant('floor 0', 4),
        user('user 1'),
        assistant('floor 2', 4),
        user('user 3'),
        assistant('floor 4', 4),
        user('user 5'),
        assistant('floor 6', 12),
        user('user 7'),
        assistant('floor 8', 16),
    ];
    const chatMetadata = {
        chatId: 'diff-retention',
        [diffMetadataKey]: {
            version: 2,
            order: [6, 8],
            entries: {},
        },
    };
    installContext(chat, 5, chatMetadata);
    const assistantFloors = [0, 2, 4, 6, 8];

    for (const floor of assistantFloors) {
        writeAllBranchMetadata(chat[floor], floor);
        runtimeState.diffMessageStates.set(floor, { status: 'ready', signature: `floor-${floor}`, updatedAt: floor });
        runtimeState.diffSnippetsCache.set(floor, { snippets: [`floor-${floor}`], fullDiff: '', signature: `floor-${floor}` });
        runtimeState.diffRawSourceCache.set(floor, { branchKey: 'main', mes: `floor-${floor}`, signature: `floor-${floor}` });
        runtimeState.nonStreamingRawMessageCache.set(floor, `floor-${floor}`);
    }
    runtimeState.trackedDiffMessageOrder = [6, 8];

    const oldFloorSwipes = structuredClone(chat[0].swipes);
    const oldFloorSwipeInfo = structuredClone(chat[0].swipe_info);
    getAppContext().extension_settings[extensionName].diffTrackedMessageLimit = 2;
    const queuedSaves = countQueuedSaveSchedules(() => {
        syncTrackedIndicesToLatestAssistantMessages({ cleanupHistoricalResidue: true });
    });

    assert.deepEqual(runtimeState.trackedDiffMessageOrder, [6, 8]);
    for (const floor of [0, 2, 4]) {
        assert.equal(runtimeState.diffMessageStates.has(floor), false);
        assert.equal(runtimeState.diffSnippetsCache.has(floor), false);
        assert.equal('__blai_diff_branch_meta' in chat[floor], false);
    }
    for (const floor of [6, 8]) {
        assert.equal(runtimeState.diffMessageStates.has(floor), true);
        assert.equal(Object.keys(chat[floor].__blai_diff_branch_meta).length, chat[floor].swipes.length);
    }
    assert.equal(getMessageDiffMeta(chat[8], 'swipe:0').originalMes, 'floor 8 original 0');
    assert.deepEqual(chat[0].swipes, oldFloorSwipes);
    assert.deepEqual(chat[0].swipe_info, oldFloorSwipeInfo);
    assert.equal(chat[0].mes, oldFloorSwipes[oldFloorSwipes.length - 1]);
    assert.equal(queuedSaves, 1);
});

test('incremental cleanse changes an evicted floor without recreating Diff history', () => {
    const chat = [
        assistant('SECRET old floor'),
        user('user 1'),
        assistant('latest retained floor'),
    ];
    installContext(chat, 1, { chatId: 'diff-retention' }, [programRule()]);
    buildProcessors();
    seedDiffRuntime(0);
    seedDiffRuntime(2);

    const changed = cleanseMessageDataAtIndex(0);

    assert.equal(changed, true);
    assert.equal(chat[0].mes, 'CLEAN old floor');
    assertNoVeridisDiffMetadata(chat[0]);
    assert.equal(runtimeState.diffMessageStates.has(0), false);
    assert.equal(runtimeState.diffSnippetsCache.has(0), false);
    assert.equal(runtimeState.diffRawSourceCache.has(0), false);
    assert.equal(runtimeState.nonStreamingRawMessageCache.has(0), false);
    assert.equal(runtimeState.trackedDiffMessageOrder.includes(0), false);
    assert.equal(runtimeState.diffMessageStates.has(2), true);
    assert.equal(chat[2].mes, 'latest retained floor');
});

test('chat restore followed by global cleanse cannot recreate an evicted floor', () => {
    const chat = [
        assistant('SECRET old floor'),
        user('user 1'),
        assistant('SECRET retained floor'),
    ];
    installContext(chat, 1, { chatId: 'diff-retention' }, [programRule()]);
    writeAllBranchMetadata(chat[0], 0);
    writeAllBranchMetadata(chat[2], 2);

    countQueuedSaveSchedules(() => {
        restoreDiffStateFromChatMetadata();
        assertNoVeridisDiffMetadata(chat[0]);
        performGlobalCleanse();
    });

    assert.equal(chat[0].mes, 'CLEAN old floor');
    assertNoVeridisDiffMetadata(chat[0]);
    assert.equal(runtimeState.diffMessageStates.has(0), false);
    assert.equal(runtimeState.diffSnippetsCache.has(0), false);
    assert.equal(runtimeState.diffRawSourceCache.has(0), false);
    assert.equal(runtimeState.nonStreamingRawMessageCache.has(0), false);
    assert.equal(runtimeState.trackedDiffMessageOrder.includes(0), false);
    assert.equal(chat[2].mes, 'CLEAN retained floor');
    assert.ok(getMessageDiffMeta(chat[2]));
    assert.equal(runtimeState.diffMessageStates.has(2), true);
    assert.equal(runtimeState.diffSnippetsCache.has(2), true);
});

test('incremental cleanse still records Diff metadata and cache for a retained floor', () => {
    const chat = [
        assistant('old floor'),
        user('user 1'),
        assistant('SECRET retained floor'),
    ];
    installContext(chat, 1, { chatId: 'diff-retention' }, [programRule()]);
    buildProcessors();

    const changed = cleanseMessageDataAtIndex(2);

    assert.equal(changed, true);
    assert.equal(chat[2].mes, 'CLEAN retained floor');
    assert.ok(getMessageDiffMeta(chat[2]));
    assert.equal(runtimeState.diffMessageStates.has(2), true);
    assert.equal(runtimeState.diffSnippetsCache.has(2), true);
    assert.equal(runtimeState.trackedDiffMessageOrder.includes(2), true);
});

test('ordinary cleanse clears pre-existing Swipe Diff metadata from an evicted floor only', () => {
    const chat = [
        assistant('old floor', 12),
        user('user 1'),
        assistant('latest retained floor'),
    ];
    chat[0].extra = { native: 'preserved' };
    installContext(chat, 1, { chatId: 'diff-retention' }, [programRule()]);
    buildProcessors();
    writeAllBranchMetadata(chat[0], 0);
    seedDiffRuntime(0);
    const nativeFields = {
        mes: chat[0].mes,
        swipes: structuredClone(chat[0].swipes),
        swipe_info: structuredClone(chat[0].swipe_info),
        extra: structuredClone(chat[0].extra),
    };

    const changed = cleanseMessageDataAtIndex(0);

    assert.equal(changed, true);
    assertNoVeridisDiffMetadata(chat[0]);
    assert.equal(chat[0].mes, nativeFields.mes);
    assert.deepEqual(chat[0].swipes, nativeFields.swipes);
    assert.deepEqual(chat[0].swipe_info, nativeFields.swipe_info);
    assert.deepEqual(chat[0].extra, nativeFields.extra);
    assert.equal(runtimeState.diffMessageStates.has(0), false);
    assert.equal(runtimeState.diffSnippetsCache.has(0), false);
    assert.equal(runtimeState.diffRawSourceCache.has(0), false);
    assert.equal(runtimeState.nonStreamingRawMessageCache.has(0), false);
    assert.equal(runtimeState.trackedDiffMessageOrder.includes(0), false);
    assert.equal(runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'program-commit').length, 0);
});

test('explicit recleanse ignores an old AI final and uses current AI fallback when global AI is disabled', () => {
    const original = '<content>AI-42 `AI-77` <!-- AI-88 --></content> SECRET';
    const message = assistant(original);
    const chat = [message];
    const regexAiRule = aiRule({
        mode: 'regex',
        targets: ['AI-(\\d+)'],
        replacements: ['CURRENT-$1'],
    });
    installContext(chat, 1, { chatId: 'diff-retention' }, [regexAiRule, programRule()]);
    const settings = getAppContext().extension_settings[extensionName];
    settings.aiRewrite = {
        enabled: false,
        xmlScopeTag: 'content',
        protectXmlComments: true,
    };
    seedRevertedAiFinal(message, 'main', original);
    runtimeState.isRegexDirty = true;
    let fetchCount = 0;
    globalThis.fetch = async () => {
        fetchCount += 1;
        throw new Error('explicit recleanse must stay local');
    };

    assert.equal(recleanseDiffMessageAtIndex(0), true);

    assert.equal(fetchCount, 0);
    assert.equal(message.mes, '<content>CURRENT-42 `AI-77` <!-- AI-88 --></content> CLEAN');
    assert.equal(message.mes.includes('OLD AI FINAL'), false);
    const meta = getMessageDiffMeta(message);
    assert.equal(meta.originalMes, original);
    assert.equal(meta.lastCleanedMes, message.mes);
    assert.equal(meta.aiFinalMes, '');
});

test('explicit recleanse remains local when global AI is enabled', () => {
    const original = '<content>AI</content> SECRET';
    const message = assistant(original);
    const chat = [message];
    installContext(chat, 1, { chatId: 'diff-retention' }, [aiRule(), programRule()]);
    getAppContext().extension_settings[extensionName].aiRewrite = {
        enabled: true,
        baseUrl: 'https://rewrite.example/v1',
        apiKey: 'key',
        model: 'model',
        xmlScopeTag: 'content',
    };
    seedRevertedAiFinal(message, 'main', original);
    runtimeState.isRegexDirty = true;
    let fetchCount = 0;
    globalThis.fetch = async () => {
        fetchCount += 1;
        throw new Error('explicit recleanse must stay local');
    };

    assert.equal(recleanseDiffMessageAtIndex(0), true);

    assert.equal(fetchCount, 0);
    assert.equal(message.mes, '<content>CURRENT</content> CLEAN');
    assert.equal(getMessageDiffMeta(message).aiFinalMes, '');
});

for (const disabledTarget of ['collection', 'subrule']) {
    test(`explicit recleanse excludes a disabled AI ${disabledTarget} while retaining program rules`, () => {
        const original = '<content>AI</content> SECRET';
        const message = assistant(original);
        const chat = [message];
        const rule = aiRule();
        if (disabledTarget === 'collection') rule.enabled = false;
        else rule.subRules[0].enabled = false;
        installContext(chat, 1, { chatId: 'diff-retention' }, [rule, programRule()]);
        getAppContext().extension_settings[extensionName].aiRewrite = {
            enabled: false,
            xmlScopeTag: 'content',
        };
        seedRevertedAiFinal(message, 'main', original);
        runtimeState.isRegexDirty = true;

        assert.equal(recleanseDiffMessageAtIndex(0), true);

        assert.equal(message.mes, '<content>AI</content> CLEAN');
        assert.equal(message.mes.includes('OLD AI FINAL'), false);
        const meta = getMessageDiffMeta(message);
        assert.equal(meta.originalMes, original);
        assert.equal(meta.lastCleanedMes, message.mes);
        assert.equal(meta.aiFinalMes, '');
    });
}

test('explicit recleanse commits only the current Swipe and writes Diff metadata to that branch', () => {
    const original = '<content>AI</content> SECRET';
    const message = {
        is_user: false,
        mes: original,
        swipe_id: 1,
        swipes: ['<content>OTHER AI</content> SECRET', original],
        swipe_info: [{ extra: { native: 0 } }, { extra: { native: 1 } }],
    };
    const untouchedSwipe = message.swipes[0];
    const chat = [message];
    const rule = aiRule({ enabled: false });
    installContext(chat, 1, { chatId: 'diff-retention' }, [rule, programRule()]);
    getAppContext().extension_settings[extensionName].aiRewrite = {
        enabled: false,
        xmlScopeTag: 'content',
    };
    writeMessageDiffMeta(message, 'swipe:0', 'other original', 'other cleaned', 'other signature');
    seedRevertedAiFinal(message, 'swipe:1', original);
    runtimeState.isRegexDirty = true;

    assert.equal(recleanseDiffMessageAtIndex(0), true);

    assert.equal(message.mes, '<content>AI</content> CLEAN');
    assert.equal(message.swipes[1], message.mes);
    assert.equal(message.swipes[0], untouchedSwipe);
    assert.equal(getMessageDiffMeta(message, 'swipe:1').originalMes, original);
    assert.equal(getMessageDiffMeta(message, 'swipe:1').lastCleanedMes, message.mes);
    assert.equal(getMessageDiffMeta(message, 'swipe:0').originalMes, 'other original');
});
