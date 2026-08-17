import test from 'node:test';
import assert from 'node:assert/strict';

import { GenerationLifecycleRegistry, generationLifecycle } from '../src/generationLifecycle.js';
import { getAppContext, initAppContext, runtimeState } from '../src/state.js';
import { bindHostLifecycleEvents, initRealtimeInterceptor } from '../src/events/hostLifecycle.js';

function assistant(text = 'assistant') {
    return { is_user: false, mes: text };
}

function startRegistry(chat = [assistant()], options = {}) {
    const registry = new GenerationLifecycleRegistry(options);
    const session = registry.startGeneration({ chatId: 'chat-a', chat, mode: 'normal' });
    return { registry, session, chat };
}

function finalizeThroughLifecycle(registry, chat, messageId, source, generationId = '') {
    const resolution = registry.bindMessage(messageId, {
        generationId,
        chatId: 'chat-a',
        chat,
        source,
    });
    if (!resolution.ok) return { resolution, claimed: false };
    runtimeState.isStreamingGeneration = false;
    return {
        resolution,
        claimed: registry.markFinalSource(resolution.generationId, source),
    };
}

function receiveHostMessage(registry, chat, messageId) {
    const receipt = registry.consumeStreamingHostReceipt(messageId, chat[messageId]);
    const final = finalizeThroughLifecycle(
        registry,
        chat,
        messageId,
        'message-received',
        receipt?.generationId || '',
    );
    return { receipt, final };
}

test.afterEach(() => {
    runtimeState.isStreamingGeneration = false;
});

test('an explicit non-negative integer binds the exact assistant message', () => {
    const chat = [{ is_user: true, mes: 'user' }, assistant('target')];
    const { registry, session } = startRegistry(chat);

    const result = registry.bindMessage(1, {
        chatId: 'chat-a',
        chat,
        source: 'message-received',
    });

    assert.equal(result.ok, true);
    assert.equal(result.messageIndex, 1);
    assert.equal(result.message, chat[1]);
    assert.equal(session.messageId, 1);
    assert.equal(session.messageRef, chat[1]);
});

test('numeric strings, objects and arrays are not message identities', () => {
    for (const candidate of ['0', { messageId: 0 }, [{ messageId: 0 }], undefined, null]) {
        const { registry, session, chat } = startRegistry();
        const result = registry.bindMessage(candidate, {
            chatId: 'chat-a',
            chat,
            source: 'message-received',
        });
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'invalid-message-id');
        assert.equal(session.messageId, null);
        assert.equal(session.messageRef, null);
    }
});

test('a user message is rejected instead of searching for another target', () => {
    const chat = [{ is_user: true, mes: 'user' }, assistant('target')];
    const { registry, session } = startRegistry(chat);
    const result = registry.bindMessage(0, { chatId: 'chat-a', chat, source: 'message-received' });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'message-not-assistant');
    assert.equal(session.messageId, null);
});

test('a different message cannot replace an existing generation binding', () => {
    const chat = [assistant('first'), assistant('second')];
    const { registry, session } = startRegistry(chat);
    assert.equal(registry.bindMessage(0, { chatId: 'chat-a', chat, source: 'streaming' }).ok, true);

    const result = registry.bindMessage(1, { chatId: 'chat-a', chat, source: 'message-received' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'generation-message-mismatch');
    assert.equal(session.messageId, 0);
    assert.equal(session.messageRef, chat[0]);
});

test('the same exact message object can be bound and validated again', () => {
    const lifecycleEvents = [];
    const { registry, session, chat } = startRegistry(undefined, {
        onLog: (name, details) => lifecycleEvents.push({ name, details }),
    });
    const firstBinding = registry.bindMessage(0, {
        chatId: 'chat-a',
        chat,
        source: 'streaming',
    });
    const repeatBinding = registry.bindMessage(0, {
        chatId: 'chat-a',
        chat,
        source: 'message-received',
    });

    assert.equal(firstBinding.ok, true);
    assert.equal(repeatBinding.ok, true);
    assert.equal(session.messageId, 0);
    assert.equal(session.messageRef, chat[0]);
    assert.equal(lifecycleEvents.filter(({ name }) => name === 'message-bound').length, 1);

    const validation = registry.validate(session.generationId, { chatId: 'chat-a', chat });
    assert.equal(validation.ok, true);
    assert.equal(validation.message, chat[0]);
});

test('an exact ID remains required after the target has already been bound', () => {
    const { registry, session, chat } = startRegistry();
    registry.bindMessage(0, { chatId: 'chat-a', chat, source: 'streaming' });

    const stopped = registry.bindMessage(undefined, { chatId: 'chat-a', chat, source: 'generation-stopped' });
    const ended = registry.bindMessage(chat.length, { chatId: 'chat-a', chat, source: 'generation-ended' });

    assert.equal(stopped.ok, false);
    assert.equal(stopped.reason, 'invalid-message-id');
    assert.equal(ended.ok, false);
    assert.equal(ended.reason, 'message-index-out-of-range');
    assert.equal(session.messageId, 0);
    assert.equal(session.messageRef, chat[0]);
});

test('normal generation setup deletion preserves an unbound replacement generation', () => {
    const oldTarget = assistant('old');
    const chat = [{ is_user: true, mes: 'user' }, oldTarget];
    const { registry, session } = startRegistry(chat);

    chat.pop();
    const reconciliation = registry.reconcileMessageDeletion({ chatId: 'chat-a', chat });
    assert.deepEqual(reconciliation, {
        cancel: false,
        reason: 'generation-target-not-bound',
        messageId: null,
    });
    assert.equal(registry.getActive(), session);

    const replacement = assistant('replacement');
    chat.push(replacement);
    assert.equal(registry.bindMessage(1, { chatId: 'chat-a', chat, source: 'message-received' }).ok, true);
    assert.equal(session.messageRef, replacement);
});

test('deleting or moving the bound message invalidates the exact target identity', () => {
    const target = assistant('target');
    const chat = [assistant('earlier'), target];
    const { registry } = startRegistry(chat);
    registry.bindMessage(1, { chatId: 'chat-a', chat, source: 'streaming' });

    chat.shift();
    assert.deepEqual(registry.reconcileMessageDeletion({ chatId: 'chat-a', chat }), {
        cancel: true,
        reason: 'target-message-index-changed',
        messageId: 1,
    });

    chat.splice(0, chat.length);
    assert.deepEqual(registry.reconcileMessageDeletion({ chatId: 'chat-a', chat }), {
        cancel: true,
        reason: 'target-message-deleted',
        messageId: 1,
    });
});

test('only the first exact final signal claims the existing phase', () => {
    const { registry, session, chat } = startRegistry();
    registry.bindMessage(0, { chatId: 'chat-a', chat, source: 'streaming-committed' });

    assert.equal(registry.markFinalSource(session.generationId, 'streaming-committed-final'), true);
    assert.equal(session.phase, 'finalizing');
    assert.equal(registry.markFinalSource(session.generationId, 'message-received'), false);
    assert.equal(registry.markFinalSource(session.generationId, 'generation-ended'), false);
    assert.equal(session.phase, 'finalizing');
});

test('a processor callback bound to a superseded generation cannot claim the new session', () => {
    const chat = [assistant('same message object')];
    const { registry, session: previous } = startRegistry(chat);
    const current = registry.startGeneration({ chatId: 'chat-a', chat, mode: 'swipe' });

    const stale = registry.bindMessage(0, {
        generationId: previous.generationId,
        chatId: 'chat-a',
        chat,
        source: 'streaming-committed-final',
    });

    assert.equal(stale.ok, false);
    assert.equal(stale.reason, 'no-active-generation');
    assert.equal(current.messageId, null);
    assert.equal(current.phase, 'active');
});

test('a stale processor final preserves the replacement generation streaming flag', () => {
    const message = assistant('shared message');
    const chat = [message];
    const registry = new GenerationLifecycleRegistry();
    const previous = registry.startGeneration({ chatId: 'chat-a', chat, mode: 'normal' });
    const current = registry.startGeneration({ chatId: 'chat-a', chat, mode: 'swipe' });
    runtimeState.isStreamingGeneration = true;

    assert.equal(registry.recordStreamingHostReceipt(previous.generationId, 0, message), true);
    const staleFinal = finalizeThroughLifecycle(
        registry,
        chat,
        0,
        'streaming-committed-final',
        previous.generationId,
    );

    assert.equal(staleFinal.resolution.ok, false);
    assert.equal(staleFinal.resolution.reason, 'no-active-generation');
    assert.equal(runtimeState.isStreamingGeneration, true);
    assert.equal(current.phase, 'active');
    assert.equal(current.messageId, null);
    assert.equal(current.messageRef, null);
});

function assertStaleStreamingReceiptCannotClaimReplacement(previousMode) {
    const message = assistant('reused tail object');
    const chat = [message];
    const registry = new GenerationLifecycleRegistry();
    const previous = registry.startGeneration({ chatId: 'chat-a', chat, mode: previousMode });
    const current = registry.startGeneration({ chatId: 'chat-a', chat, mode: 'swipe' });
    runtimeState.isStreamingGeneration = true;
    let finalClaimCount = 0;

    assert.equal(registry.recordStreamingHostReceipt(previous.generationId, 0, message), true);
    const staleProcessorFinal = finalizeThroughLifecycle(
        registry,
        chat,
        0,
        'streaming-committed-final',
        previous.generationId,
    );
    finalClaimCount += Number(staleProcessorFinal.claimed);

    const staleHostReceipt = receiveHostMessage(registry, chat, 0);
    finalClaimCount += Number(staleHostReceipt.final.claimed);

    assert.equal(staleHostReceipt.receipt?.generationId, previous.generationId);
    assert.equal(staleHostReceipt.final.resolution.ok, false);
    assert.equal(current.phase, 'active');
    assert.equal(current.messageId, null);
    assert.equal(current.messageRef, null);
    assert.equal(current.requestState, 'idle');
    assert.equal(runtimeState.isStreamingGeneration, true);
    assert.equal(finalClaimCount, 0);

    assert.equal(registry.recordStreamingHostReceipt(current.generationId, 0, message), true);
    const currentProcessorFinal = finalizeThroughLifecycle(
        registry,
        chat,
        0,
        'streaming-committed-final',
        current.generationId,
    );
    finalClaimCount += Number(currentProcessorFinal.claimed);
    const currentHostReceipt = receiveHostMessage(registry, chat, 0);
    finalClaimCount += Number(currentHostReceipt.final.claimed);

    assert.equal(currentProcessorFinal.resolution.ok, true);
    assert.equal(currentProcessorFinal.claimed, true);
    assert.equal(currentHostReceipt.receipt?.generationId, current.generationId);
    assert.equal(currentHostReceipt.final.claimed, false);
    assert.equal(current.phase, 'finalizing');
    assert.equal(current.messageId, 0);
    assert.equal(current.messageRef, message);
    assert.equal(finalClaimCount, 1);
}

test('an old normal-stream receipt cannot claim a replacement Swipe generation', () => {
    assertStaleStreamingReceiptCannotClaimReplacement('normal');
});

test('an old Swipe receipt cannot claim a replacement Swipe generation with the same message identity', () => {
    assertStaleStreamingReceiptCannotClaimReplacement('swipe');
});

test('same-message Swipe overlap consumes producer receipts in recorded host order', () => {
    const message = assistant('same Swipe message');
    const chat = [message];
    const registry = new GenerationLifecycleRegistry();
    const previous = registry.startGeneration({ chatId: 'chat-a', chat, mode: 'swipe' });
    const current = registry.startGeneration({ chatId: 'chat-a', chat, mode: 'swipe' });

    assert.equal(registry.recordStreamingHostReceipt(previous.generationId, 0, message), true);
    assert.equal(registry.recordStreamingHostReceipt(current.generationId, 0, message), true);
    assert.equal(registry.pendingStreamingHostReceipts.length, 2);

    const previousReceipt = registry.consumeStreamingHostReceipt(0, message);
    const currentReceipt = registry.consumeStreamingHostReceipt(0, message);
    assert.equal(previousReceipt?.generationId, previous.generationId);
    assert.equal(currentReceipt?.generationId, current.generationId);
    assert.equal(registry.pendingStreamingHostReceipts.length, 0);
    assert.equal(registry.getSession(previous.generationId), null);
    assert.equal(registry.getActive(), current);
});

test('an ordinary non-stream MESSAGE_RECEIVED finalizes the current active generation', () => {
    const { registry, session, chat } = startRegistry();
    assert.equal(registry.consumeStreamingHostReceipt(0, chat[0]), null);

    const received = receiveHostMessage(registry, chat, 0);

    assert.equal(received.receipt, null);
    assert.equal(received.final.resolution.ok, true);
    assert.equal(received.final.claimed, true);
    assert.equal(session.phase, 'finalizing');
    assert.equal(session.messageId, 0);
    assert.equal(session.messageRef, chat[0]);
});

test('a normal streaming host receipt uses the tagged generation and remains deduplicated', () => {
    const { registry, session, chat } = startRegistry();
    runtimeState.isStreamingGeneration = true;
    let finalClaimCount = 0;

    assert.equal(registry.recordStreamingHostReceipt(session.generationId, 0, chat[0]), true);
    assert.equal(registry.consumeStreamingHostReceipt(0, assistant('different object')), null);
    const processorFinal = finalizeThroughLifecycle(
        registry,
        chat,
        0,
        'streaming-committed-final',
        session.generationId,
    );
    finalClaimCount += Number(processorFinal.claimed);
    const received = receiveHostMessage(registry, chat, 0);
    finalClaimCount += Number(received.final.claimed);

    assert.equal(received.receipt?.generationId, session.generationId);
    assert.equal(received.final.resolution.generationId, session.generationId);
    assert.equal(received.final.claimed, false);
    assert.equal(finalClaimCount, 1);
    assert.equal(session.phase, 'finalizing');
    assert.equal(registry.consumeStreamingHostReceipt(0, chat[0]), null);
});

test('a consumed streaming host receipt cannot be reused', () => {
    const { registry, session, chat } = startRegistry();
    let finalClaimCount = 0;

    registry.recordStreamingHostReceipt(session.generationId, 0, chat[0]);
    const processorFinal = finalizeThroughLifecycle(
        registry,
        chat,
        0,
        'streaming-committed-final',
        session.generationId,
    );
    finalClaimCount += Number(processorFinal.claimed);
    const firstReceipt = receiveHostMessage(registry, chat, 0);
    finalClaimCount += Number(firstReceipt.final.claimed);
    const duplicateReceipt = receiveHostMessage(registry, chat, 0);
    finalClaimCount += Number(duplicateReceipt.final.claimed);

    assert.equal(firstReceipt.receipt?.generationId, session.generationId);
    assert.equal(duplicateReceipt.receipt, null);
    assert.equal(duplicateReceipt.final.claimed, false);
    assert.equal(finalClaimCount, 1);
});

test('user stop still permits the committed final and following receipt exactly once', () => {
    const { registry, session, chat } = startRegistry();
    runtimeState.isStreamingGeneration = false;
    let finalClaimCount = 0;

    assert.equal(registry.getActive(), session);
    registry.recordStreamingHostReceipt(session.generationId, 0, chat[0]);
    const committedFinal = finalizeThroughLifecycle(
        registry,
        chat,
        0,
        'streaming-committed-final',
        session.generationId,
    );
    finalClaimCount += Number(committedFinal.claimed);
    const received = receiveHostMessage(registry, chat, 0);
    finalClaimCount += Number(received.final.claimed);

    assert.equal(committedFinal.claimed, true);
    assert.equal(received.receipt?.generationId, session.generationId);
    assert.equal(received.final.claimed, false);
    assert.equal(session.phase, 'finalizing');
    assert.equal(finalClaimCount, 1);
});

test('request ownership remains exactly once within the claimed generation', () => {
    const { registry, session } = startRegistry();
    assert.equal(registry.claimRequest(session.generationId, 'streaming').ok, true);
    assert.equal(registry.claimRequest(session.generationId, 'message-received').ok, false);
    assert.equal(session.requestState, 'scheduled');
    assert.equal(registry.markRequestRunning(session.generationId), true);
    assert.equal(registry.markRequestSucceeded(session.generationId), true);
    assert.equal(session.requestState, 'succeeded');
});

test('a failed scheduled request releases ownership but a running request remains failed', () => {
    const first = startRegistry();
    first.registry.claimRequest(first.session.generationId, 'streaming');
    assert.equal(first.registry.markRequestFailed(first.session.generationId, 'not-started'), true);
    assert.equal(first.session.requestState, 'idle');
    assert.equal(first.registry.claimRequest(first.session.generationId, 'final').ok, true);

    const second = startRegistry();
    second.registry.claimRequest(second.session.generationId, 'streaming');
    second.registry.markRequestRunning(second.session.generationId);
    assert.equal(second.registry.markRequestFailed(second.session.generationId, 'request-failed'), true);
    assert.equal(second.session.requestState, 'failed');
    assert.equal(second.registry.claimRequest(second.session.generationId, 'final').ok, false);
});

test('chat identity and chat object identity are both authoritative', () => {
    const chat = [assistant()];
    const { registry, session } = startRegistry(chat);
    registry.bindMessage(0, { chatId: 'chat-a', chat, source: 'message-received' });

    assert.equal(registry.validate(session.generationId, { chatId: 'chat-b', chat }).reason, 'chat-changed');
    assert.equal(registry.validate(session.generationId, { chatId: 'chat-a', chat: [...chat] }).reason, 'chat-reference-changed');
});

test('only an exact plugin-owned mutation can be acknowledged', () => {
    const message = assistant('before');
    const { registry, session, chat } = startRegistry([message]);
    registry.bindMessage(0, { chatId: 'chat-a', chat, source: 'message-received' });

    message.mes = 'after';
    const accepted = registry.acknowledgeInternalMessageMutation(session.generationId, {
        chatId: 'chat-a',
        chat,
        messageId: 0,
        messageRef: message,
        beforeText: 'before',
        afterText: 'after',
        source: 'direct-final-cleanse',
    });
    assert.equal(accepted.ok, true);
    assert.equal(accepted.changed, true);

    message.mes = 'third-party';
    const rejected = registry.acknowledgeInternalMessageMutation(session.generationId, {
        chatId: 'chat-a',
        chat,
        messageId: 0,
        messageRef: message,
        beforeText: 'after',
        afterText: 'expected',
        source: 'direct-final-cleanse',
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, 'message-text-not-cleanse-result');
});

test('cancellation and supersession remain terminal without timer cleanup state', () => {
    const { registry, session, chat } = startRegistry();
    registry.bindMessage(0, { chatId: 'chat-a', chat, source: 'streaming' });
    registry.claimRequest(session.generationId, 'streaming');

    assert.equal(registry.cancelActive('target-message-swiped'), true);
    assert.equal(session.phase, 'cancelled');
    assert.equal(session.requestState, 'cancelled');
    assert.equal(registry.getActive(), null);

    const next = registry.startGeneration({ chatId: 'chat-a', chat, mode: 'normal' });
    const replacement = registry.startGeneration({ chatId: 'chat-a', chat, mode: 'regenerate' });
    assert.equal(next.phase, 'cancelled');
    assert.equal(next.requestState, 'superseded');
    assert.equal(registry.getActive(), replacement);
});

test('the registry exposes no lifecycle timer infrastructure', () => {
    const { registry, session } = startRegistry();
    assert.equal('scheduleTimer' in registry, false);
    assert.equal('clearTimers' in registry, false);
    assert.equal('timers' in session, false);
    assert.equal('completedTimerPhases' in session, false);
});

test('ten thousand generations retain only one active full session', () => {
    const chat = [assistant('shared floor')];
    const registry = new GenerationLifecycleRegistry();
    const first = registry.startGeneration({ chatId: 'chat-a', chat, mode: 'normal' });
    let current = first;
    for (let index = 1; index < 10_000; index += 1) {
        current = registry.startGeneration({ chatId: 'chat-a', chat, mode: 'normal' });
    }

    assert.equal(first.phase, 'cancelled');
    assert.equal(registry.getSession(first.generationId), null);
    assert.equal(registry.getSession(current.generationId), current);
    assert.equal(registry.getActive(), current);
    assert.equal('sessions' in registry, false);
    assert.equal(registry.pendingStreamingHostReceipts.length, 0);
    assert.equal('pendingStreamingHostReceipt' in current, false);
    assert.deepEqual(Object.keys(current).sort(), [
        'cancelReason',
        'chatId',
        'chatRef',
        'generationId',
        'messageId',
        'messageRef',
        'mode',
        'phase',
        'requestSource',
        'requestState',
    ]);
    assert.equal('pruneHistoricalSessions' in registry, false);
});

test('late exact callbacks cannot mutate or recreate a superseded generation', () => {
    const chat = [assistant('shared floor')];
    const registry = new GenerationLifecycleRegistry();
    const previous = registry.startGeneration({ chatId: 'chat-a', chat, mode: 'normal' });
    registry.bindMessage(0, { chatId: 'chat-a', chat, source: 'streaming' });
    registry.claimRequest(previous.generationId, 'streaming');
    registry.markRequestRunning(previous.generationId);
    const current = registry.startGeneration({ chatId: 'chat-a', chat, mode: 'swipe' });

    const currentSnapshot = { ...current };
    assert.equal(registry.validate(previous.generationId, { chatId: 'chat-a', chat }).reason, 'generation-missing');
    assert.equal(registry.bindMessage(0, {
        generationId: previous.generationId,
        chatId: 'chat-a',
        chat,
        source: 'stale-processor',
    }).ok, false);
    assert.equal(registry.claimRequest(previous.generationId, 'stale').ok, false);
    assert.equal(registry.markRequestRunning(previous.generationId), false);
    assert.equal(registry.markRequestSucceeded(previous.generationId), false);
    assert.equal(registry.markRequestFailed(previous.generationId, 'stale'), false);
    assert.equal(registry.markRequestTerminated(previous.generationId, 'stale', 'stale'), false);
    assert.equal(registry.acknowledgeInternalMessageMutation(previous.generationId, {
        chatId: 'chat-a',
        chat,
        messageId: 0,
        messageRef: chat[0],
        beforeText: 'shared floor',
        afterText: 'shared floor',
    }).ok, false);
    assert.equal(registry.markFinalSource(previous.generationId, 'stale'), false);

    assert.deepEqual(current, currentSnapshot);
    assert.equal(registry.getSession(previous.generationId), null);
    assert.equal(registry.getActive(), current);
});

test('pending streaming receipts are minimal, survive supersession, and clear at hard boundaries', () => {
    const chat = [assistant('shared floor')];
    const registry = new GenerationLifecycleRegistry();
    const previous = registry.startGeneration({ chatId: 'chat-a', chat, mode: 'normal' });
    assert.equal(registry.recordStreamingHostReceipt(previous.generationId, 0, chat[0]), true);
    const current = registry.startGeneration({ chatId: 'chat-a', chat, mode: 'swipe' });

    assert.equal(registry.getSession(previous.generationId), null);
    assert.equal(registry.pendingStreamingHostReceipts.length, 1);
    assert.deepEqual(Object.keys(registry.pendingStreamingHostReceipts[0]).sort(), [
        'generationId',
        'messageId',
        'messageRef',
    ]);
    assert.equal(registry.pendingStreamingHostReceipts[0].generationId, previous.generationId);

    assert.equal(registry.cancelActive('chat-changed'), true);
    assert.equal(current.phase, 'cancelled');
    assert.equal(registry.getActive(), null);
    assert.equal(registry.pendingStreamingHostReceipts.length, 0);

    assert.equal(registry.recordStreamingHostReceipt('generation-stale', 0, chat[0]), true);
    assert.equal(registry.cancelActive('page-unload'), false);
    assert.equal(registry.pendingStreamingHostReceipts.length, 0);
});

test('discarding a streaming receipt is exact to generation and message ownership', () => {
    const registry = new GenerationLifecycleRegistry();
    const firstMessage = assistant('first receipt');
    const secondMessage = assistant('second receipt');

    assert.equal(registry.recordStreamingHostReceipt('generation-a', 5, firstMessage), true);
    assert.equal(registry.recordStreamingHostReceipt('generation-b', 7, secondMessage), true);
    assert.equal(registry.pendingStreamingHostReceipts.length, 2);

    assert.equal(registry.discardStreamingHostReceipt('generation-a', 5), 1);
    assert.deepEqual(registry.pendingStreamingHostReceipts, [{
        generationId: 'generation-b',
        messageId: 7,
        messageRef: secondMessage,
    }]);
    assert.equal(registry.discardStreamingHostReceipt('generation-a', 7), 0);
    assert.equal(registry.discardStreamingHostReceipt('generation-b', 5), 0);
    assert.equal(registry.pendingStreamingHostReceipts.length, 1);
});

test('processor patches preserve UI-stop ownership and bound finalization scopes', async () => {
    const previousContext = { ...getAppContext() };
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousMutationObserver = globalThis.MutationObserver;
    const previousSetInterval = globalThis.setInterval;
    const previousClearInterval = globalThis.clearInterval;
    const listeners = Object.create(null);
    const registrations = [];
    let currentProcessor = null;

    const eventSource = {
        on(type, handler) {
            registrations.push(type);
            const handlers = listeners[type] || [];
            handlers.push(handler);
            listeners[type] = handlers;
        },
        makeFirst(type, handler) {
            registrations.push(type);
            const handlers = listeners[type] || [];
            handlers.unshift(handler);
            listeners[type] = handlers;
        },
        async emit(type, ...args) {
            for (const handler of [...(listeners[type] || [])]) {
                await handler(...args);
            }
        },
    };
    const event_types = {
        GENERATION_STARTED: 'generation-started',
        STREAM_TOKEN_RECEIVED: 'stream-token-received',
        GENERATION_ENDED: 'generation-ended',
        GENERATION_STOPPED: 'generation-stopped',
        MESSAGE_RECEIVED: 'message-received',
    };
    const chat = [assistant('shared message')];

    globalThis.window = { addEventListener() {} };
    globalThis.document = {
        addEventListener() {},
        getElementById() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
    };
    globalThis.MutationObserver = class {
        observe() {}
        takeRecords() { return []; }
    };
    globalThis.setInterval = () => 1;
    globalThis.clearInterval = () => {};

    try {
        generationLifecycle.cancelActive('chat-changed');
        let temporaryOwner = '';
        const scalarObservations = [];
        eventSource.on('scalar-proof', () => {
            scalarObservations.push(temporaryOwner);
        });
        eventSource.on('scalar-proof', () => {
            scalarObservations.push(temporaryOwner);
        });
        const emitWithSynchronousOwner = () => {
            temporaryOwner = 'generation-a';
            try {
                return eventSource.emit('scalar-proof');
            } finally {
                temporaryOwner = '';
            }
        };
        await emitWithSynchronousOwner();
        assert.deepEqual(scalarObservations, ['generation-a', '']);

        initAppContext({
            chat,
            chat_metadata: { chatId: 'chat-a' },
            eventSource,
            event_types,
            extension_settings: {},
            getStreamingProcessor: () => currentProcessor,
            getSillyTavernContext: () => ({
                chat,
                getCurrentChatId: () => 'chat-a',
            }),
        });
        let precedingEndedCalls = 0;
        eventSource.on(event_types.GENERATION_ENDED, () => {
            precedingEndedCalls += 1;
        });
        const hostRegistrationStart = registrations.length;
        initRealtimeInterceptor();
        bindHostLifecycleEvents();

        const hostRegistrations = registrations.slice(hostRegistrationStart);
        assert.equal(hostRegistrations.filter((type) => type === event_types.GENERATION_ENDED).length, 1);
        assert.equal(listeners[event_types.GENERATION_ENDED].length, 2);
        assert.ok(hostRegistrations.indexOf(event_types.GENERATION_STARTED) < hostRegistrations.indexOf(event_types.STREAM_TOKEN_RECEIVED));
        assert.ok(hostRegistrations.indexOf(event_types.STREAM_TOKEN_RECEIVED) < hostRegistrations.indexOf(event_types.GENERATION_ENDED));
        assert.ok(hostRegistrations.indexOf(event_types.GENERATION_ENDED) < hostRegistrations.indexOf(event_types.GENERATION_STOPPED));
        assert.ok(hostRegistrations.indexOf(event_types.GENERATION_STOPPED) < hostRegistrations.indexOf(event_types.MESSAGE_RECEIVED));

        await eventSource.emit(event_types.GENERATION_STARTED, 'normal', {}, false);
        const previous = generationLifecycle.getActive();
        let previousOriginalCalls = 0;
        let previousProgressCalls = 0;
        const previousEndedEmissions = [];
        const previousProcessor = {
            onProgressStreaming() {
                previousProgressCalls += 1;
            },
            markUIGenStopped() {
                previousOriginalCalls += 1;
                previousEndedEmissions.push(eventSource.emit(event_types.GENERATION_ENDED, chat.length));
                return 'previous-return';
            },
        };
        currentProcessor = previousProcessor;
        await eventSource.emit(event_types.STREAM_TOKEN_RECEIVED);

        await eventSource.emit(event_types.GENERATION_STARTED, 'swipe', {}, false);
        const current = generationLifecycle.getActive();
        assert.notEqual(current.generationId, previous.generationId);
        runtimeState.isStreamingGeneration = true;

        await previousProcessor.onProgressStreaming(0, 'shared message', true);
        assert.equal(previousProgressCalls, 1);
        assert.equal(generationLifecycle.getSession(previous.generationId), null);

        const endedCallsBeforeStaleStop = precedingEndedCalls;
        assert.equal(previousProcessor.markUIGenStopped(), undefined);
        assert.equal(previousOriginalCalls, 0);
        assert.equal(previousEndedEmissions.length, 0);
        assert.equal(precedingEndedCalls, endedCallsBeforeStaleStop);
        assert.equal(runtimeState.isStreamingGeneration, true);
        assert.equal(generationLifecycle.getActive(), current);
        assert.equal(current.phase, 'active');
        assert.equal(current.messageId, null);
        assert.equal(current.requestState, 'idle');
        assert.equal(previous.pendingStreamingHostReceipt, undefined);
        assert.equal(generationLifecycle.pendingStreamingHostReceipts.length, 1);
        assert.equal(generationLifecycle.pendingStreamingHostReceipts[0].generationId, previous.generationId);

        await eventSource.emit(event_types.MESSAGE_RECEIVED, 0, 'normal');
        assert.equal(generationLifecycle.pendingStreamingHostReceipts.length, 0);
        assert.equal(generationLifecycle.getActive(), current);
        assert.equal(current.phase, 'active');
        assert.equal(current.messageId, null);
        assert.equal(current.requestState, 'idle');
        assert.equal(runtimeState.isStreamingGeneration, true);

        let currentOriginalCalls = 0;
        let currentEndedEmission = null;
        let currentErrorCalls = 0;
        let currentErrorEmission = null;
        let receiptObservedBeforeOriginalError = null;
        currentProcessor = {
            type: 'normal',
            messageId: 0,
            onProgressStreaming() {},
            onErrorStreaming() {
                currentErrorCalls += 1;
                receiptObservedBeforeOriginalError = generationLifecycle.pendingStreamingHostReceipts[0] || null;
                currentErrorEmission = eventSource.emit(event_types.MESSAGE_RECEIVED, this.messageId, this.type);
                return 'current-error-return';
            },
            markUIGenStopped() {
                currentOriginalCalls += 1;
                currentEndedEmission = eventSource.emit(event_types.GENERATION_ENDED, chat.length);
                return 'current-return';
            },
        };
        await eventSource.emit(event_types.STREAM_TOKEN_RECEIVED);
        runtimeState.isStreamingGeneration = true;
        assert.equal(currentProcessor.markUIGenStopped(), 'current-return');
        assert.equal(currentOriginalCalls, 1);
        assert.equal(runtimeState.isStreamingGeneration, true);
        await currentEndedEmission;
        assert.equal(runtimeState.isStreamingGeneration, false);

        assert.equal(currentProcessor.onErrorStreaming(), 'current-error-return');
        assert.equal(currentErrorCalls, 1);
        assert.equal(receiptObservedBeforeOriginalError?.generationId, current.generationId);
        assert.equal(receiptObservedBeforeOriginalError?.messageId, 0);
        assert.equal(receiptObservedBeforeOriginalError?.messageRef, chat[0]);
        await currentErrorEmission;
        assert.equal(generationLifecycle.pendingStreamingHostReceipts.length, 0);
        assert.equal(current.phase, 'finalizing');
        assert.equal(current.messageRef, chat[0]);

        for (const noEmitType of ['swipe', 'impersonate', 'continue']) {
            generationLifecycle.startGeneration({ chatId: 'chat-a', chat, mode: noEmitType });
            let noEmitErrorCalls = 0;
            currentProcessor = {
                type: noEmitType,
                messageId: 0,
                onProgressStreaming() {},
                onErrorStreaming() {
                    noEmitErrorCalls += 1;
                    return `${noEmitType}-error-return`;
                },
                markUIGenStopped() {},
            };
            await eventSource.emit(event_types.STREAM_TOKEN_RECEIVED);
            assert.equal(currentProcessor.onErrorStreaming(), `${noEmitType}-error-return`);
            assert.equal(noEmitErrorCalls, 1);
            assert.equal(generationLifecycle.pendingStreamingHostReceipts.length, 0);
        }

        await eventSource.emit(event_types.GENERATION_STARTED, 'normal', {}, false);
        const staleErrorSession = generationLifecycle.getActive();
        let staleErrorEmission = null;
        let staleErrorReceiptBeforeEmit = null;
        currentProcessor = {
            type: 'normal',
            messageId: 0,
            onProgressStreaming() {},
            onErrorStreaming() {
                staleErrorReceiptBeforeEmit = generationLifecycle.pendingStreamingHostReceipts[0] || null;
                staleErrorEmission = eventSource.emit(event_types.MESSAGE_RECEIVED, this.messageId, this.type);
                return 'stale-error-return';
            },
            markUIGenStopped() {},
        };
        await eventSource.emit(event_types.STREAM_TOKEN_RECEIVED);
        const staleErrorProcessor = currentProcessor;
        await eventSource.emit(event_types.GENERATION_STARTED, 'swipe', {}, false);
        const errorReplacement = generationLifecycle.getActive();

        assert.equal(staleErrorProcessor.onErrorStreaming(), 'stale-error-return');
        assert.equal(staleErrorReceiptBeforeEmit?.generationId, staleErrorSession.generationId);
        await staleErrorEmission;
        assert.equal(generationLifecycle.pendingStreamingHostReceipts.length, 0);
        assert.equal(generationLifecycle.getSession(staleErrorSession.generationId), null);
        assert.equal(generationLifecycle.getActive(), errorReplacement);
        assert.equal(errorReplacement.phase, 'active');
        assert.equal(errorReplacement.messageId, null);
        assert.equal(errorReplacement.requestState, 'idle');

        await eventSource.emit(event_types.GENERATION_STARTED, 'normal', {}, false);
        const orphanGeneration = generationLifecycle.getActive();
        const orphanHostError = new Error('host-finalization-failed');
        let orphanReceiptBeforeThrow = null;
        let orphanFinalizeCalls = 0;
        currentProcessor = {
            type: 'normal',
            messageId: 0,
            onProgressStreaming() {},
            async finalizeIntermediaryMessage(messageId, text) {
                orphanFinalizeCalls += 1;
                await this.onProgressStreaming(messageId, text, true);
                orphanReceiptBeforeThrow = generationLifecycle.pendingStreamingHostReceipts[0] || null;
                throw orphanHostError;
            },
            onErrorStreaming() {},
            markUIGenStopped() {},
        };
        await eventSource.emit(event_types.STREAM_TOKEN_RECEIVED);

        await assert.rejects(
            currentProcessor.finalizeIntermediaryMessage(0, 'shared message', { unlockUI: true }),
            (error) => error === orphanHostError,
        );
        assert.equal(orphanFinalizeCalls, 1);
        assert.equal(orphanReceiptBeforeThrow?.generationId, orphanGeneration.generationId);
        assert.equal(orphanReceiptBeforeThrow?.messageId, 0);
        assert.equal(orphanReceiptBeforeThrow?.messageRef, chat[0]);
        assert.equal(generationLifecycle.pendingStreamingHostReceipts.length, 0);

        await eventSource.emit(event_types.GENERATION_STARTED, 'normal', {}, false);
        const generationAfterOrphan = generationLifecycle.getActive();
        await eventSource.emit(event_types.MESSAGE_RECEIVED, 0, 'normal');
        assert.equal(generationAfterOrphan.phase, 'finalizing');
        assert.equal(generationAfterOrphan.messageId, 0);
        assert.equal(generationAfterOrphan.messageRef, chat[0]);
        assert.equal(generationLifecycle.getActive(), generationAfterOrphan);
        assert.equal(generationLifecycle.pendingStreamingHostReceipts.length, 0);

        await eventSource.emit(event_types.GENERATION_STARTED, 'normal', {}, false);
        const normalStreamingGeneration = generationLifecycle.getActive();
        const finalizeReceiptsBeforeHostEvent = [];
        const finalizeOptions = [];
        let finalizeCallCount = 0;
        currentProcessor = {
            type: 'normal',
            messageId: 0,
            onProgressStreaming() {},
            async finalizeIntermediaryMessage(messageId, text, options) {
                finalizeCallCount += 1;
                finalizeOptions.push(options);
                await this.onProgressStreaming(messageId, text, true);
                finalizeReceiptsBeforeHostEvent.push(
                    generationLifecycle.pendingStreamingHostReceipts[0] || null,
                );
                await eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, this.type);
                return `finalize-return-${finalizeCallCount}`;
            },
            onErrorStreaming() {},
            markUIGenStopped() {},
        };
        await eventSource.emit(event_types.STREAM_TOKEN_RECEIVED);

        assert.equal(
            await currentProcessor.finalizeIntermediaryMessage(0, 'shared message', { unlockUI: true }),
            'finalize-return-1',
        );
        assert.equal(generationLifecycle.pendingStreamingHostReceipts.length, 0);
        assert.equal(
            await currentProcessor.finalizeIntermediaryMessage(0, 'shared message', { unlockUI: false }),
            'finalize-return-2',
        );
        assert.equal(generationLifecycle.pendingStreamingHostReceipts.length, 0);
        assert.equal(finalizeCallCount, 2);
        assert.deepEqual(finalizeOptions, [{ unlockUI: true }, { unlockUI: false }]);
        assert.equal(finalizeReceiptsBeforeHostEvent.length, 2);
        for (const receipt of finalizeReceiptsBeforeHostEvent) {
            assert.equal(receipt?.generationId, normalStreamingGeneration.generationId);
            assert.equal(receipt?.messageId, 0);
            assert.equal(receipt?.messageRef, chat[0]);
        }
        assert.equal(normalStreamingGeneration.phase, 'finalizing');
        assert.equal(normalStreamingGeneration.messageRef, chat[0]);

        assert.equal(generationLifecycle.cancelActive('standalone-cleanup'), true);
        runtimeState.isStreamingGeneration = true;
        assert.equal(previousProcessor.markUIGenStopped(), 'previous-return');
        assert.equal(previousOriginalCalls, 1);
        assert.equal(previousEndedEmissions.length, 1);
        await previousEndedEmissions[0];
        assert.equal(runtimeState.isStreamingGeneration, false);

        await eventSource.emit(event_types.GENERATION_STARTED, 'normal', {}, false);
        const hostUiEndError = new Error('host-ui-end-failed');
        let throwingOriginalCalls = 0;
        currentProcessor = {
            onProgressStreaming() {},
            markUIGenStopped() {
                throwingOriginalCalls += 1;
                throw hostUiEndError;
            },
        };
        await eventSource.emit(event_types.STREAM_TOKEN_RECEIVED);
        runtimeState.isStreamingGeneration = true;
        let thrownError = null;
        try {
            currentProcessor.markUIGenStopped();
        } catch (error) {
            thrownError = error;
        }
        assert.equal(thrownError, hostUiEndError);
        assert.equal(throwingOriginalCalls, 1);
        assert.equal(runtimeState.isStreamingGeneration, true);
        await eventSource.emit(event_types.GENERATION_ENDED, chat.length);
        assert.equal(runtimeState.isStreamingGeneration, false);
    } finally {
        generationLifecycle.cancelActive('chat-changed');
        runtimeState.isStreamingGeneration = false;
        initAppContext(previousContext);
        globalThis.window = previousWindow;
        globalThis.document = previousDocument;
        globalThis.MutationObserver = previousMutationObserver;
        globalThis.setInterval = previousSetInterval;
        globalThis.clearInterval = previousClearInterval;
    }
});
