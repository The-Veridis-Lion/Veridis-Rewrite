#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    commitCurrentMessageText,
    isMessageAiFinal,
    isMessageAiFinalForBranch,
    isMessageManualFinal,
    writeMessageDiffManualFinal,
    restoreMessageAiFinal,
    syncCurrentSwipeExtra,
    writeMessageDiffAiTrace,
    writeMessageDiffMeta,
} from '../src/messageMeta.js';
import { getMessageIndexFromEvent } from '../src/core.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const coreSource = fs.readFileSync(path.join(repoRoot, 'src', 'core.js'), 'utf8');

assert.equal(getMessageIndexFromEvent('3'), 3, 'SillyTavern 编辑事件的字符串楼层号必须可解析');
assert.equal(getMessageIndexFromEvent({ index: '3' }), 3, '对象形式的字符串楼层号必须可解析');

const original = '<content>八股原文</content>';
const program = '<content>程序处理稿</content>';
const final = '<content>AI 改写终稿</content>';

function registerAiFinal(msg, branchKey = 'main') {
    writeMessageDiffMeta(msg, branchKey, original, final, 'source-signature');
    assert.equal(commitCurrentMessageText(msg, final, branchKey).ok, true);
    writeMessageDiffAiTrace(msg, branchKey, program, final);
}

const message = {
    is_user: false,
    mes: final,
    extra: { display_text: original },
};
registerAiFinal(message);
assert.equal(isMessageAiFinal(message), true);
assert.equal(restoreMessageAiFinal(message), true, '应清除旧显示缓存');
assert.equal(message.mes, final);
assert.equal(Object.hasOwn(message.extra, 'display_text'), false);

message.mes = original;
message.extra.display_text = original;
assert.equal(restoreMessageAiFinal(message), true, '应从持久化 AI 终稿恢复被覆盖的正文');
assert.equal(message.mes, final);
assert.equal(isMessageAiFinal(message), true);

message.mes = '<content>用户手动编辑</content>';
writeMessageDiffManualFinal(message);
assert.equal(restoreMessageAiFinal(message), false, '手动最终稿不应被 AI 终稿恢复覆盖');
assert.equal(message.mes, '<content>用户手动编辑</content>');

const exactManualEditMessage = {
    is_user: false,
    mes: '<content>\u4ed6\u6001\u5ea6\u6781\u5176\u5f3a\u786c\u3002</content>',
};
writeMessageDiffMeta(
    exactManualEditMessage,
    'main',
    '<content>\u4ed6\u663e\u5f97\u6781\u5176\u5f3a\u786c\u3002</content>',
    exactManualEditMessage.mes,
    'exact-source-signature',
);
writeMessageDiffAiTrace(
    exactManualEditMessage,
    'main',
    '<content>\u4ed6\u6001\u5ea6\u6781\u5176\u5f3a\u786c\u3002</content>',
    exactManualEditMessage.mes,
);
exactManualEditMessage.mes = '<content>\u4ed6\u6001\u5ea6\u5f3a\u786c\u3002</content>';
writeMessageDiffManualFinal(exactManualEditMessage);
assert.equal(isMessageManualFinal(exactManualEditMessage), true, '手动删除 AI 改写结果中的“极其”后必须标记为手动终稿');
restoreMessageAiFinal(exactManualEditMessage);
assert.equal(exactManualEditMessage.mes, '<content>\u4ed6\u6001\u5ea6\u5f3a\u786c\u3002</content>', '手动删改不得恢复为 AI 终稿');

const swipeMessage = {
    is_user: false,
    swipe_id: 0,
    mes: original,
    swipes: [original],
    extra: { display_text: original },
    swipe_info: [{ extra: { display_text: original } }],
};
registerAiFinal(swipeMessage, 'swipe:0');
delete swipeMessage.extra.display_text;
assert.equal(syncCurrentSwipeExtra(swipeMessage), true, 'AI 提交必须同步当前 swipe 的 extra 槽');
swipeMessage.extra = structuredClone(swipeMessage.swipe_info[0].extra);
assert.equal(Object.hasOwn(swipeMessage.extra, 'display_text'), false, '切回 swipe 时不得恢复旧 display_text');
swipeMessage.mes = original;
swipeMessage.swipes[0] = original;
assert.equal(restoreMessageAiFinal(swipeMessage), true, '应恢复当前 swipe 的 AI 终稿');
assert.equal(swipeMessage.mes, final);
assert.equal(swipeMessage.swipes[0], final);
assert.equal(isMessageAiFinalForBranch(swipeMessage, 'swipe:0', final), true);

assert.match(coreSource, /if \(isMessageAiFinal\(msg\)\) return currentMes;/u);
assert.match(coreSource, /if \(isMessageAiFinal\(msg\)\) return false;/u);
assert.match(coreSource, /restoreMessageAiFinal\(msg\)/u);
assert.match(coreSource, /export function restoreAiFinalMessagesFromChat\(\)/u);

console.log('AI 终稿持久化与恢复验证通过');
