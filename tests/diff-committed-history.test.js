import test from 'node:test';
import assert from 'node:assert/strict';

import { cleanseMessageDataAtIndex } from '../src/core.js';
import {
    computeMessageSignature,
    getDiffComparisonForMessage,
    getDiffSnippetsForMessage,
    refreshDiffCacheIfStale,
    resetDiffRuntimeState,
} from '../src/diff.js';
import {
    getMessageDiffMeta,
    writeMessageDiffAiTrace,
    writeMessageDiffManualFinal,
    writeMessageDiffMeta,
} from '../src/messageMeta.js';
import { buildProcessors } from '../src/replacementEngine.js';
import { extensionName, getAppContext, initAppContext, runtimeState } from '../src/state.js';

function programRule(replacement = 'CLEAN') {
    return {
        enabled: true,
        name: 'Committed Diff rule',
        subRules: [{
            enabled: true,
            rewriteMode: 'program',
            mode: 'text',
            targets: ['SECRET'],
            replacements: [replacement],
        }],
    };
}

function installContext(chat, rules = [programRule()]) {
    initAppContext({
        chat,
        chat_metadata: { chatId: 'diff-committed-history' },
        extension_settings: {
            [extensionName]: {
                diffTrackedMessageLimit: 20,
                rules,
                scopeTags: [],
                scopeTagBuiltinDismissed: [],
                scopeTagMode: 'protect',
            },
        },
        saveChat: async () => {},
        getSillyTavernContext: () => ({
            chat,
            getCurrentChatId: () => 'diff-committed-history',
            saveChat: async () => {},
        }),
    });
    runtimeState.isRegexDirty = true;
    buildProcessors();
}

function clearRuntime() {
    resetDiffRuntimeState();
    if (runtimeState.chatSaveTimer) clearTimeout(runtimeState.chatSaveTimer);
    runtimeState.chatSaveTimer = null;
    runtimeState.pendingChatSave = false;
    runtimeState.chatSaveInFlight = false;
    runtimeState.chatSaveDelayCount = 0;
    runtimeState.activeProcessors = [];
    runtimeState.activeVisualProcessors = [];
    runtimeState.isRegexDirty = true;
    runtimeState.aiRewrite.debugEvents = [];
    runtimeState.aiRewrite.criticalDebugEvents = [];
}

function programCommitEvents() {
    return runtimeState.aiRewrite.debugEvents.filter(event => event.stage === 'program-commit');
}

function assertNoDiffMetadata(message) {
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

let previousContext;

test.beforeEach(() => {
    previousContext = { ...getAppContext() };
    clearRuntime();
});

test.afterEach(() => {
    clearRuntime();
    initAppContext(previousContext);
});

test('a matching current rule cannot create committed Diff history without metadata', () => {
    const message = {
        is_user: false,
        mes: 'A SECRET B',
        swipe_id: 0,
        swipes: ['A SECRET B'],
    };
    installContext([message]);
    const before = structuredClone(message);
    const signature = computeMessageSignature(message);

    runtimeState.trackedDiffMessageOrder = [0];
    runtimeState.diffMessageStates.set(0, { status: 'ready', signature, updatedAt: 1 });
    runtimeState.diffSnippetsCache.set(0, {
        snippets: ['<div class="blai-diff-snippet"><ins>CLEAN</ins></div>'],
        fullDiff: '<div class="blai-diff-full-modified"><ins>CLEAN</ins></div>',
        signature,
    });

    assert.equal(getDiffComparisonForMessage(0), null);
    assert.equal(refreshDiffCacheIfStale(0), true);
    assert.deepEqual(getDiffSnippetsForMessage(0), { snippets: [], fullDiff: '', signature });
    assert.deepEqual(message, before);
    assertNoDiffMetadata(message);
});

test('a failed text commit cannot be presented as committed Diff history', () => {
    const message = {
        is_user: false,
        mes: 'A SECRET B',
        swipe_id: 4,
        swipes: ['A SECRET B'],
    };
    installContext([message]);
    const before = structuredClone(message);

    assert.equal(cleanseMessageDataAtIndex(0), false);
    assert.equal(getDiffComparisonForMessage(0), null);
    assert.equal(refreshDiffCacheIfStale(0), true);
    assert.deepEqual(getDiffSnippetsForMessage(0).snippets, []);
    assert.equal(getDiffSnippetsForMessage(0).fullDiff, '');
    assert.deepEqual(message, before);
    assertNoDiffMetadata(message);
});

test('a successful program cleanse records and displays the exact committed pair', () => {
    const message = {
        is_user: false,
        mes: 'A SECRET B',
        swipe_id: 0,
        swipes: ['A SECRET B'],
    };
    installContext([message]);

    assert.equal(cleanseMessageDataAtIndex(0), true);
    assert.equal(message.mes, 'A CLEAN B');
    assert.equal(message.swipes[0], 'A CLEAN B');
    assert.equal(getMessageDiffMeta(message).originalMes, 'A SECRET B');
    assert.equal(getMessageDiffMeta(message).lastCleanedMes, 'A CLEAN B');
    assert.deepEqual(getDiffComparisonForMessage(0), {
        sourceMes: 'A SECRET B',
        cleanedMes: 'A CLEAN B',
        aiProgramMes: '',
        aiFinalMes: '',
        hasAiTrace: false,
        finalSource: '',
        sourceDisplayText: 'A SECRET B',
        cleanedDisplayText: 'A CLEAN B',
    });
});

test('a successful ordinary cleanse records one compact text-write summary and a repeated no-op records none', () => {
    const originalText = 'PRIVATE SECRET MESSAGE';
    const message = { is_user: false, mes: originalText };
    installContext([message]);

    assert.equal(cleanseMessageDataAtIndex(0), true);
    assert.equal(message.mes, 'PRIVATE CLEAN MESSAGE');
    assert.equal(programCommitEvents().length, 1);
    assert.deepEqual(programCommitEvents()[0].details, {
        source: 'message-cleanse',
        messageId: 0,
        changedTargets: 1,
        changedSwipeCount: 0,
        beforeLength: originalText.length,
        afterLength: message.mes.length,
    });
    assert.doesNotMatch(JSON.stringify(programCommitEvents()[0]), /PRIVATE SECRET MESSAGE|PRIVATE CLEAN MESSAGE/);

    assert.equal(cleanseMessageDataAtIndex(0), false);
    assert.equal(programCommitEvents().length, 1);
});

test('cleanAllSwipes aggregates all actual message and Swipe writes into one summary', () => {
    const message = {
        is_user: false,
        mes: 'SECRET ONE',
        swipe_id: 0,
        swipes: ['SECRET ONE', { mes: 'SECRET TWO' }],
    };
    installContext([message]);

    assert.equal(cleanseMessageDataAtIndex(0, { cleanAllSwipes: true }), true);
    assert.equal(message.mes, 'CLEAN ONE');
    assert.deepEqual(message.swipes, ['CLEAN ONE', { mes: 'CLEAN TWO' }]);
    assert.equal(programCommitEvents().length, 1);
    assert.deepEqual(programCommitEvents()[0].details, {
        source: 'message-cleanse',
        messageId: 0,
        changedTargets: 3,
        changedSwipeCount: 2,
        beforeLength: 10,
        afterLength: 9,
    });
});

test('AI, manual, current-Swipe, and restored runtime Diff use the stored committed trace', () => {
    const message = {
        is_user: false,
        mes: 'AI FINAL',
        swipe_id: 1,
        swipes: ['untouched branch', 'AI FINAL'],
    };
    installContext([message], []);
    writeMessageDiffMeta(message, 'swipe:1', 'RAW', 'AI FINAL', 'source-signature');
    writeMessageDiffAiTrace(message, 'swipe:1', 'PROGRAM', 'AI FINAL');

    assert.equal(refreshDiffCacheIfStale(0), true);
    assert.equal(getDiffComparisonForMessage(0).sourceMes, 'RAW');
    assert.equal(getDiffComparisonForMessage(0).cleanedMes, 'AI FINAL');
    assert.match(getDiffSnippetsForMessage(0).fullDiff, /data-blai-diff-source="ai"/);

    message.mes = 'MANUAL FINAL';
    message.swipes[1] = 'MANUAL FINAL';
    writeMessageDiffManualFinal(message, 'swipe:1');
    assert.equal(refreshDiffCacheIfStale(0), true);
    assert.equal(getDiffComparisonForMessage(0).cleanedMes, 'MANUAL FINAL');
    assert.match(getDiffSnippetsForMessage(0).fullDiff, /data-blai-diff-source="manual"/);
    assert.equal(message.swipes[0], 'untouched branch');

    resetDiffRuntimeState();
    assert.equal(refreshDiffCacheIfStale(0), true);
    assert.equal(getDiffComparisonForMessage(0).sourceMes, 'RAW');
    assert.equal(getDiffComparisonForMessage(0).cleanedMes, 'MANUAL FINAL');
    assert.match(getDiffSnippetsForMessage(0).fullDiff, /data-blai-diff-source="manual"/);
});

test('changing current rules cannot rewrite an already committed Diff pair', () => {
    const message = { is_user: false, mes: 'A SECRET B' };
    installContext([message]);
    assert.equal(cleanseMessageDataAtIndex(0), true);

    getAppContext().extension_settings[extensionName].rules = [programRule('DIFFERENT')];
    runtimeState.isRegexDirty = true;
    buildProcessors();

    assert.equal(refreshDiffCacheIfStale(0), true);
    const comparison = getDiffComparisonForMessage(0);
    assert.equal(comparison.sourceMes, 'A SECRET B');
    assert.equal(comparison.cleanedMes, 'A CLEAN B');
    assert.doesNotMatch(getDiffSnippetsForMessage(0).fullDiff, /DIFFERENT/);
});

test('reverted messages remain protected from cleanse and Diff refresh', () => {
    const message = { is_user: false, mes: 'A SECRET B', __blai_is_reverted: true };
    installContext([message]);
    writeMessageDiffMeta(message, 'main', 'A SECRET B', 'A CLEAN B', 'source-signature');
    const before = structuredClone(message);

    assert.equal(cleanseMessageDataAtIndex(0), false);
    assert.equal(refreshDiffCacheIfStale(0), false);
    assert.deepEqual(message, before);
    assert.equal(getDiffSnippetsForMessage(0).fullDiff, '');
});
