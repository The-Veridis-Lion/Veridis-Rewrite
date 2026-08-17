import test from 'node:test';
import assert from 'node:assert/strict';

import {
    clearAllMessageDiffMeta,
    commitCurrentMessageText,
    getMessageDiffBranchKey,
    getMessageDiffMeta,
    getMessageSwipeIndex,
    isMessageManualFinal,
    restoreMessageAiFinal,
    setCurrentSwipeText,
    syncCurrentSwipeExtra,
    writeMessageDiffAiTrace,
    writeMessageDiffManualFinal,
    writeMessageDiffMeta,
} from '../src/messageMeta.js';

test('a retained floor keeps every Swipe Diff branch beyond the former fixed cap', () => {
    const message = {
        mes: 'swipe 15',
        swipe_id: 15,
        swipes: Array.from({ length: 16 }, (_, index) => `swipe ${index}`),
    };

    for (let index = 0; index < message.swipes.length; index++) {
        writeMessageDiffMeta(
            message,
            `swipe:${index}`,
            `original ${index}`,
            `cleaned ${index}`,
            `signature ${index}`,
        );
    }

    for (let index = 0; index < message.swipes.length; index++) {
        const meta = getMessageDiffMeta(message, `swipe:${index}`);
        assert.equal(meta.originalMes, `original ${index}`);
        assert.equal(meta.lastCleanedMes, `cleaned ${index}`);
    }
    assert.equal(Object.keys(message.__blai_diff_branch_meta).length, 16);
});

test('clearing an evicted floor removes only Veridis Diff metadata', () => {
    const message = {
        mes: 'current native text',
        swipe_id: 2,
        swipes: ['native 0', 'native 1', 'current native text'],
        swipe_info: [{ extra: { a: 1 } }, { extra: { b: 2 } }, { extra: { c: 3 } }],
    };
    const originalSwipes = structuredClone(message.swipes);
    const originalSwipeInfo = structuredClone(message.swipe_info);

    for (let index = 0; index < message.swipes.length; index++) {
        writeMessageDiffMeta(message, `swipe:${index}`, `original ${index}`, `cleaned ${index}`, `signature ${index}`);
    }
    writeMessageDiffAiTrace(message, 'swipe:2', 'program', 'AI final');

    assert.equal(clearAllMessageDiffMeta(message), true);
    assert.equal('__blai_diff_branch_meta' in message, false);
    assert.equal('__blai_original_mes' in message, false);
    assert.equal('__blai_diff_source_signature' in message, false);
    assert.equal('__blai_diff_last_cleaned_mes' in message, false);
    assert.equal('__blai_diff_ai_program_mes' in message, false);
    assert.equal('__blai_diff_ai_final_mes' in message, false);
    assert.equal('__blai_diff_has_ai_trace' in message, false);
    assert.equal('__blai_diff_final_source' in message, false);
    assert.equal('__blai_diff_swipe_key' in message, false);
    assert.equal(message.mes, 'current native text');
    assert.deepEqual(message.swipes, originalSwipes);
    assert.deepEqual(message.swipe_info, originalSwipeInfo);
});

test('pending swipe slot never resolves to the previous swipe by matching message text', () => {
    const message = {
        mes: 'previous swipe',
        swipe_id: 1,
        swipes: ['previous swipe'],
    };

    assert.equal(getMessageSwipeIndex(message), -1);
    assert.equal(getMessageDiffBranchKey(message), 'main');
    assert.equal(setCurrentSwipeText(message, 'rewritten text'), false);
    assert.deepEqual(message.swipes, ['previous swipe']);
});

test('materialized current swipe remains writable', () => {
    const message = {
        mes: 'current swipe',
        swipe_id: 1,
        swipes: ['previous swipe', 'current swipe'],
    };

    assert.equal(getMessageSwipeIndex(message), 1);
    assert.equal(getMessageDiffBranchKey(message), 'swipe:1');
    assert.equal(setCurrentSwipeText(message, 'rewritten current swipe'), true);
    assert.deepEqual(message.swipes, ['previous swipe', 'rewritten current swipe']);
});

test('messages without an explicit swipe id may still resolve their displayed swipe', () => {
    const message = {
        mes: 'current swipe',
        swipes: ['previous swipe', 'current swipe'],
    };

    assert.equal(getMessageSwipeIndex(message), 1);
});

test('undefined current swipe slots are not materialized by an atomic text commit', () => {
    const message = {
        mes: 'host text',
        swipe_id: 1,
        swipes: ['previous swipe', undefined],
    };

    const result = commitCurrentMessageText(message, 'AI text', 'main');

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'swipe-slot-not-materialized');
    assert.equal(message.mes, 'host text');
    assert.deepEqual(message.swipes, ['previous swipe', undefined]);
});

test('atomic text commit updates the message and exactly the current swipe', () => {
    const message = {
        mes: 'second swipe',
        swipe_id: 1,
        swipes: ['first swipe', 'second swipe'],
    };

    const result = commitCurrentMessageText(message, 'AI second swipe', 'swipe:1');

    assert.equal(result.ok, true);
    assert.equal(message.mes, 'AI second swipe');
    assert.deepEqual(message.swipes, ['first swipe', 'AI second swipe']);
});

test('current swipe extra mirrors the committed message display state', () => {
    const message = {
        mes: 'AI second swipe',
        extra: { nested: { value: 1 } },
        swipe_id: 1,
        swipes: ['first swipe', 'AI second swipe'],
        swipe_info: [
            { extra: { display_text: 'first swipe' } },
            { extra: { display_text: 'stale program text' } },
        ],
    };

    assert.equal(syncCurrentSwipeExtra(message), true);
    assert.deepEqual(message.swipe_info[1].extra, { nested: { value: 1 } });
    assert.notEqual(message.swipe_info[1].extra, message.extra);
});

test('manual final preserves original, program, AI, and manual stages across swipe round trips', () => {
    const message = {
        mes: '程序稿',
        swipe_id: 1,
        swipes: ['上一页', '程序稿'],
    };

    writeMessageDiffMeta(message, 'swipe:1', '原文本', '程序稿', 'source-signature');
    writeMessageDiffAiTrace(message, 'swipe:1', '程序稿', 'AI 稿');
    message.mes = '手动稿';
    message.swipes[1] = '手动稿';
    writeMessageDiffManualFinal(message, 'swipe:1');

    let meta = getMessageDiffMeta(message, 'swipe:1');
    assert.equal(meta.originalMes, '原文本');
    assert.equal(meta.aiProgramMes, '程序稿');
    assert.equal(meta.aiFinalMes, 'AI 稿');
    assert.equal(meta.lastCleanedMes, '手动稿');
    assert.equal(meta.finalSource, 'manual');
    assert.equal(isMessageManualFinal(message), true);

    message.swipe_id = 0;
    message.mes = message.swipes[0];
    message.swipe_id = 1;
    message.mes = message.swipes[1];

    meta = getMessageDiffMeta(message, 'swipe:1');
    assert.equal(message.mes, '手动稿');
    assert.equal(meta.originalMes, '原文本');
    assert.equal(meta.aiProgramMes, '程序稿');
    assert.equal(meta.aiFinalMes, 'AI 稿');
    assert.equal(meta.lastCleanedMes, '手动稿');
    assert.equal(isMessageManualFinal(message), true);
});

test('ordinary host recovery still restores a persisted AI final from a known intermediate', () => {
    const message = {
        mes: '原文本',
        swipe_id: 1,
        swipes: ['上一页', '原文本'],
    };
    writeMessageDiffMeta(message, 'swipe:1', '原文本', '程序稿', 'source-signature');
    writeMessageDiffAiTrace(message, 'swipe:1', '程序稿', 'AI 最终稿');

    assert.equal(restoreMessageAiFinal(message), true);
    assert.equal(message.mes, 'AI 最终稿');
    assert.equal(message.swipes[1], 'AI 最终稿');
    assert.equal(message.swipes[0], '上一页');
});
