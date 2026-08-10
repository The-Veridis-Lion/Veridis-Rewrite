#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GenerationLifecycleRegistry } from '../src/generationLifecycle.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const aiRewriteSource = fs.readFileSync(path.join(repoRoot, 'src', 'aiRewrite.js'), 'utf8');
const eventsSource = fs.readFileSync(path.join(repoRoot, 'src', 'events.js'), 'utf8');
const lifecycleSource = fs.readFileSync(path.join(repoRoot, 'src', 'generationLifecycle.js'), 'utf8');

for (const forbidden of [
    'content-scope-changed',
    'content-snapshot-changed',
    'expectedScopeHash',
    'expectedScopeText',
    'messageTextHashAtBuild',
    'hashLifecycleText',
]) {
    assert.equal(aiRewriteSource.includes(forbidden), false, `AI 改写仍包含内容失效门禁: ${forbidden}`);
    assert.equal(lifecycleSource.includes(forbidden), false, `生成生命周期仍包含内容失效门禁: ${forbidden}`);
}

assert.doesNotMatch(eventsSource, /MESSAGE_EDITED[\s\S]{0,160}cancelAutomaticGeneration/u);
assert.match(eventsSource, /MESSAGE_SWIPED[\s\S]{0,500}cancelAutomaticGeneration\('target-message-swiped'\)/u);
assert.match(eventsSource, /MESSAGE_DELETED[\s\S]{0,500}reconcileMessageDeletion/u);
assert.match(eventsSource, /MESSAGE_DELETED[\s\S]{0,1200}hasInvalidAiRewriteTarget/u);
assert.doesNotMatch(eventsSource, /MESSAGE_DELETED[\s\S]{0,300}cancelAutomaticGeneration\('message-deleted'\)/u);

const currentChatId = { value: 'chat-a' };
const earlierMessage = { is_user: true, mes: 'earlier floor' };
const originalMessage = { is_user: false, mes: '<content>before</content>' };
const currentChat = { value: [earlierMessage, originalMessage] };
const registry = new GenerationLifecycleRegistry({
    getCurrentChatId: () => currentChatId.value,
    getCurrentChat: () => currentChat.value,
});
const session = registry.startGeneration({ chatId: currentChatId.value, chat: currentChat.value });
assert.equal(registry.resolveMessage(1, {
    generationId: session.generationId,
    chatId: currentChatId.value,
    chat: currentChat.value,
}).ok, true);

originalMessage.mes = '<content>after host or user edit</content>';
assert.equal(registry.validate(session.generationId).ok, true, '同一楼层内容变化不应使任务失效');

currentChat.value.splice(0, 1);
const deletionReconciliation = registry.reconcileMessageDeletion({
    chatId: currentChatId.value,
    chat: currentChat.value,
});
assert.deepEqual(deletionReconciliation, {
    cancel: true,
    reason: 'target-message-index-changed',
    messageId: 1,
});
assert.equal(registry.validate(session.generationId).reason, 'message-reference-changed', '绑定后的楼层移动必须使任务失效');

currentChat.value[0] = { is_user: false, mes: 'replacement' };
assert.equal(registry.validate(session.generationId).reason, 'message-reference-changed');

currentChat.value[0] = originalMessage;
currentChatId.value = 'chat-b';
assert.equal(registry.validate(session.generationId).reason, 'chat-changed');

console.log('AI 改写目标身份策略验证通过');
