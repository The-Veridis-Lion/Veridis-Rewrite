#!/usr/bin/env node

import assert from 'node:assert/strict';

import { GenerationLifecycleRegistry } from '../src/generationLifecycle.js';

function createRegistry() {
    return new GenerationLifecycleRegistry({ logger: () => {} });
}

function assistant(text) {
    return { is_user: false, mes: text };
}

{
    const registry = createRegistry();
    const oldReply = assistant('old reply');
    const chat = [{ is_user: true, mes: 'prompt' }, oldReply];
    const session = registry.startGeneration({ chatId: 'chat-a', chat, mode: 'regenerate' });

    chat.pop();
    assert.deepEqual(
        registry.reconcileMessageDeletion({ chatId: 'chat-a', chat }),
        {
            cancel: false,
            reason: 'generation-target-not-bound',
            messageId: null,
        },
        'GENERATION_STARTED 后的宿主 replacement 删除不得误杀尚未绑定 target 的 generation',
    );

    const replacement = assistant('replacement');
    chat.push(replacement);
    const resolved = registry.resolveMessage(1, { generationId: session.generationId, chatId: 'chat-a', chat, source: 'message-received' });
    assert.equal(resolved.ok, true);
    assert.equal(registry.getActive().messageRef, replacement);
}

{
    const registry = createRegistry();
    const otherReply = assistant('other');
    const target = assistant('target');
    const chat = [{ is_user: true, mes: 'prompt' }, otherReply, target];
    const session = registry.startGeneration({ chatId: 'chat-b', chat, mode: 'normal' });
    assert.equal(registry.resolveMessage(2, { chatId: 'chat-b', chat }).ok, true);

    chat.splice(1, 1);
    assert.deepEqual(
        registry.reconcileMessageDeletion({ chatId: 'chat-b', chat }),
        {
            cancel: true,
            reason: 'target-message-index-changed',
            messageId: 2,
        },
        '绑定后删除前序楼层导致 index 改变时应结束任务',
    );
    assert.equal(registry.getActive().messageId, 2);
    assert.equal(registry.validate(session.generationId, { chatId: 'chat-b', chat }).reason, 'message-reference-changed');
}

{
    const registry = createRegistry();
    const target = assistant('target');
    const chat = [{ is_user: true, mes: 'prompt' }, target];
    registry.startGeneration({ chatId: 'chat-c', chat, mode: 'normal' });
    assert.equal(registry.resolveMessage(1, { chatId: 'chat-c', chat }).ok, true);

    chat[1] = assistant('different object at the same index');
    assert.deepEqual(
        registry.reconcileMessageDeletion({ chatId: 'chat-c', chat }),
        {
            cancel: true,
            reason: 'target-message-deleted',
            messageId: 1,
        },
        '同 index 的对象替换仍必须使旧 generation 失效',
    );
}

console.log('Generation lifecycle 身份与删除归属验证通过');
