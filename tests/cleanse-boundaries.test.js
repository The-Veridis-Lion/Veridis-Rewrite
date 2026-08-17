import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.Node = {
    ELEMENT_NODE: 1,
    TEXT_NODE: 3,
};

const { deepCleanObjectSync } = await import('../src/cleanse.js');
const { isAllowedChatInputElement, isPurifiableMessageTextNode } = await import('../src/dom.js');

function fakeInput({ send = false } = {}) {
    return {
        matches(selector) {
            if (selector === '#send_textarea') return send;
            return false;
        },
    };
}

test('document input allowlist accepts only the chat composer', () => {
    assert.equal(isAllowedChatInputElement(fakeInput({ send: true })), true);
    assert.equal(isAllowedChatInputElement(fakeInput()), false);
});

function fakeMessageTextNode({ excluded = false, inChat = true } = {}) {
    const message = {
        closest(selector) {
            return selector === '#chat' && inChat ? { id: 'chat' } : null;
        },
        getRootNode() {
            return null;
        },
    };
    const body = {
        closest(selector) {
            return selector === '.mes' ? message : null;
        },
    };
    const parent = {
        closest(selector) {
            if (selector === '.mes .mes_text') return body;
            if (selector.includes('script') && excluded) return { tagName: 'CODE' };
            return null;
        },
    };
    return { nodeType: Node.TEXT_NODE, parentElement: parent, parentNode: parent };
}

test('message DOM allowlist accepts body text and rejects code/control or non-chat text', () => {
    assert.equal(isPurifiableMessageTextNode(fakeMessageTextNode()), true);
    assert.equal(isPurifiableMessageTextNode(fakeMessageTextNode({ excluded: true })), false);
    assert.equal(isPurifiableMessageTextNode(fakeMessageTextNode({ inChat: false })), false);
});

test('deep chat cleanse changes mes and swipe text only', () => {
    const chat = [{
        mes: 'bad message',
        swipes: ['bad swipe', { mes: 'bad object swipe', metadata: 'bad metadata' }],
        metadata: { unknown: 'bad unknown' },
        prompt: 'bad prompt',
        apiKey: 'bad key',
    }];

    const changes = deepCleanObjectSync(chat, {
        scope: 'chat',
        transform: value => value.replaceAll('bad', 'clean'),
    });

    assert.equal(changes, 3);
    assert.equal(chat[0].mes, 'clean message');
    assert.equal(chat[0].swipes[0], 'clean swipe');
    assert.equal(chat[0].swipes[1].mes, 'clean object swipe');
    assert.equal(chat[0].swipes[1].metadata, 'bad metadata');
    assert.equal(chat[0].metadata.unknown, 'bad unknown');
    assert.equal(chat[0].prompt, 'bad prompt');
    assert.equal(chat[0].apiKey, 'bad key');
});

test('unknown scope and metadata remain untouched', () => {
    const value = { metadata: { text: 'bad' }, endpoint: 'bad' };
    const changes = deepCleanObjectSync(value, {
        scope: 'settings',
        transform: text => text.replaceAll('bad', 'clean'),
    });
    assert.equal(changes, 0);
    assert.deepEqual(value, { metadata: { text: 'bad' }, endpoint: 'bad' });
});

test('chat deep cleanse is stable after the first deterministic transform', () => {
    const chat = [{ mes: 'bad', swipes: ['bad'] }];
    const transform = value => value.replaceAll('bad', 'clean');
    deepCleanObjectSync(chat, { scope: 'chat', transform });
    const once = structuredClone(chat);
    deepCleanObjectSync(chat, { scope: 'chat', transform });
    deepCleanObjectSync(chat, { scope: 'chat', transform });
    deepCleanObjectSync(chat, { scope: 'chat', transform });
    deepCleanObjectSync(chat, { scope: 'chat', transform });
    assert.deepEqual(chat, once);
});
