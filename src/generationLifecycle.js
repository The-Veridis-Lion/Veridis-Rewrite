function isAssistantMessage(message) {
    return Boolean(message && typeof message === 'object'
        && message.is_user !== true
        && message.role !== 'user');
}

export class GenerationLifecycleRegistry {
    constructor(options = {}) {
        this.getCurrentChatId = typeof options.getCurrentChatId === 'function'
            ? options.getCurrentChatId
            : null;
        this.getCurrentChat = typeof options.getCurrentChat === 'function'
            ? options.getCurrentChat
            : null;
        this.onLog = typeof options.onLog === 'function' ? options.onLog : null;
        this.sequence = 0;
        this.active = null;
        this.pendingStreamingHostReceipts = [];
    }

    log(name, session, details = {}) {
        if (!this.onLog) return;
        this.onLog(name, {
            generationId: session?.generationId || '',
            chatId: session?.chatId || '',
            messageId: Number.isInteger(session?.messageId) ? session.messageId : null,
            mode: session?.mode || '',
            phase: session?.phase || '',
            requestState: session?.requestState || '',
            ...details,
        });
    }

    startGeneration({ chatId, chat, mode = 'unknown' } = {}) {
        this.cancelActive('superseded-by-new-generation');
        const normalizedChatId = String(chatId || '');
        const generationId = `generation-${++this.sequence}`;
        const session = {
            generationId,
            chatId: normalizedChatId,
            chatRef: Array.isArray(chat) ? chat : null,
            messageId: null,
            messageRef: null,
            mode: String(mode || 'unknown'),
            phase: 'active',
            requestState: 'idle',
            requestSource: '',
            cancelReason: '',
        };
        this.active = session;
        this.log('generation-created', session);
        return session;
    }

    getActive() {
        return this.active;
    }

    configure(options = {}) {
        if (typeof options.getCurrentChatId === 'function') this.getCurrentChatId = options.getCurrentChatId;
        if (typeof options.getCurrentChat === 'function') this.getCurrentChat = options.getCurrentChat;
        if (typeof options.onLog === 'function') this.onLog = options.onLog;
        return this;
    }

    getSession(generationId) {
        const active = this.active;
        return active?.generationId === generationId ? active : null;
    }

    reconcileMessageDeletion({ chatId, chat } = {}) {
        const session = this.active;
        if (!session || session.phase === 'cancelled') {
            return { cancel: false, reason: 'no-active-generation', messageId: null };
        }
        if (String(chatId || '') !== session.chatId) {
            return { cancel: true, reason: 'chat-changed', messageId: session.messageId };
        }
        if (!Array.isArray(chat) || (session.chatRef && session.chatRef !== chat)) {
            return { cancel: true, reason: 'chat-reference-changed', messageId: session.messageId };
        }
        if (!session.messageRef) {
            this.log('message-deletion-ignored', session, { reason: 'generation-target-not-bound' });
            return { cancel: false, reason: 'generation-target-not-bound', messageId: null };
        }

        if (chat[session.messageId] !== session.messageRef) {
            const reason = chat.includes(session.messageRef)
                ? 'target-message-index-changed'
                : 'target-message-deleted';
            this.log('message-deletion-target-invalidated', session, { reason });
            return { cancel: true, reason, messageId: session.messageId };
        }

        this.log('message-deletion-ignored', session, { reason: 'other-message-deleted' });
        return { cancel: false, reason: 'other-message-deleted', messageId: session.messageId };
    }

    bindMessage(messageId, options = {}) {
        const session = options.generationId
            ? this.getSession(options.generationId)
            : this.active;
        if (!session || session.phase === 'cancelled') {
            return { ok: false, messageIndex: -1, source: '', reason: 'no-active-generation' };
        }

        const chatId = String(options.chatId || '');
        const chat = Array.isArray(options.chat) ? options.chat : null;
        if (!chatId || chatId !== session.chatId) {
            return { ok: false, messageIndex: -1, source: '', reason: 'chat-changed' };
        }
        if (!chat || (session.chatRef && session.chatRef !== chat)) {
            return { ok: false, messageIndex: -1, source: '', reason: 'chat-reference-changed' };
        }

        if (!Number.isInteger(messageId) || messageId < 0) {
            this.log('message-id-rejected', session, { source: options.source || '', reason: 'invalid-message-id' });
            return { ok: false, messageIndex: -1, source: options.source || '', reason: 'invalid-message-id' };
        }

        if (messageId >= chat.length) {
            return { ok: false, messageIndex: -1, source: options.source || '', reason: 'message-index-out-of-range' };
        }
        const message = chat[messageId];
        if (!isAssistantMessage(message)) {
            return { ok: false, messageIndex: -1, source: options.source || '', reason: 'message-not-assistant' };
        }
        if (Number.isInteger(session.messageId) && session.messageId !== messageId) {
            return { ok: false, messageIndex: -1, source: options.source || '', reason: 'generation-message-mismatch' };
        }
        if (session.messageRef && session.messageRef !== message) {
            return { ok: false, messageIndex: -1, source: options.source || '', reason: 'message-reference-changed' };
        }

        const wasAlreadyBound = session.messageId === messageId
            && session.messageRef === message;
        session.messageId = messageId;
        session.messageRef = message;
        if (!wasAlreadyBound) {
            this.log('message-bound', session, { source: options.source || '' });
        }
        return {
            ok: true,
            messageIndex: messageId,
            message,
            generationId: session.generationId,
            chatId: session.chatId,
            source: options.source || '',
            reason: '',
        };
    }

    recordStreamingHostReceipt(generationId, messageId, messageRef) {
        if (typeof generationId !== 'string'
            || !generationId
            || !Number.isInteger(messageId)
            || messageId < 0
            || !isAssistantMessage(messageRef)) {
            return false;
        }
        this.pendingStreamingHostReceipts.push({
            generationId,
            messageId,
            messageRef,
        });
        return true;
    }

    discardStreamingHostReceipt(generationId, messageId) {
        if (typeof generationId !== 'string'
            || !generationId
            || !Number.isInteger(messageId)
            || messageId < 0) {
            return 0;
        }
        let discardedCount = 0;
        for (let index = this.pendingStreamingHostReceipts.length - 1; index >= 0; index -= 1) {
            const receipt = this.pendingStreamingHostReceipts[index];
            if (receipt.generationId === generationId && receipt.messageId === messageId) {
                this.pendingStreamingHostReceipts.splice(index, 1);
                discardedCount += 1;
            }
        }
        return discardedCount;
    }

    consumeStreamingHostReceipt(messageId, messageRef) {
        if (!Number.isInteger(messageId) || messageId < 0 || !messageRef) return null;
        const receiptIndex = this.pendingStreamingHostReceipts.findIndex((receipt) => (
            receipt.messageId === messageId && receipt.messageRef === messageRef
        ));
        if (receiptIndex < 0) return null;
        return this.pendingStreamingHostReceipts.splice(receiptIndex, 1)[0];
    }

    validate(generationId, options = {}) {
        const session = this.getSession(generationId);
        if (!session) return { ok: false, reason: 'generation-missing' };
        if (session.phase === 'cancelled') return { ok: false, reason: session.cancelReason || 'generation-cancelled' };

        const chatId = String(options.chatId || (this.getCurrentChatId ? this.getCurrentChatId() : '') || '');
        if (chatId && chatId !== session.chatId) return { ok: false, reason: 'chat-changed' };

        const currentChat = this.getCurrentChat ? this.getCurrentChat() : null;
        const chat = Array.isArray(options.chat)
            ? options.chat
            : Array.isArray(currentChat)
                ? currentChat
                : session.chatRef;
        if (!Array.isArray(chat) || (session.chatRef && chat !== session.chatRef)) {
            return { ok: false, reason: 'chat-reference-changed' };
        }
        if (!Number.isInteger(session.messageId)) return { ok: false, reason: 'message-not-bound' };
        const message = chat[session.messageId];
        if (message !== session.messageRef) return { ok: false, reason: 'message-reference-changed' };
        if (!isAssistantMessage(message)) return { ok: false, reason: 'message-not-assistant' };
        return { ok: true, reason: '', session, message };
    }

    acknowledgeInternalMessageMutation(generationId, options = {}) {
        const session = this.getSession(generationId);
        if (!session || session.phase === 'cancelled') {
            return { ok: false, reason: 'generation-inactive' };
        }
        const chatId = String(options.chatId || '');
        if (!chatId || chatId !== session.chatId) return { ok: false, reason: 'chat-changed' };
        const currentChatId = this.getCurrentChatId ? String(this.getCurrentChatId() || '') : '';
        if (currentChatId && currentChatId !== session.chatId) return { ok: false, reason: 'chat-changed' };

        const chat = options.chat;
        const currentChat = this.getCurrentChat ? this.getCurrentChat() : null;
        if (!Array.isArray(chat)
            || chat !== session.chatRef
            || (Array.isArray(currentChat) && currentChat !== session.chatRef)
            || !Number.isInteger(session.messageId)) {
            return { ok: false, reason: 'message-not-bound' };
        }
        const messageId = Number(options.messageId);
        if (!Number.isInteger(messageId) || messageId !== session.messageId) {
            return { ok: false, reason: 'generation-message-mismatch' };
        }
        const message = chat[messageId];
        if (message !== session.messageRef
            || message !== options.messageRef
            || !isAssistantMessage(message)) {
            return { ok: false, reason: 'message-reference-changed' };
        }

        const beforeText = String(options.beforeText ?? '');
        const afterText = String(options.afterText ?? '');
        if (String(message.mes ?? '') !== afterText) {
            return { ok: false, reason: 'message-text-not-cleanse-result' };
        }
        if (beforeText === afterText) {
            return { ok: true, changed: false, reason: '', session, message };
        }

        this.log('internal-message-mutation-acknowledged', session, {
            source: String(options.source || 'internal-cleanse'),
            previousLength: beforeText.length,
            messageLength: afterText.length,
        });
        return { ok: true, changed: true, reason: '', session, message };
    }

    markFinalSource(generationId, source) {
        const session = this.getSession(generationId);
        if (!session || session.phase !== 'active') {
            if (session) this.log('finalization-deduped', session, { source: String(source || 'unknown') });
            return false;
        }
        session.phase = 'finalizing';
        this.log('event-received', session, { source: String(source || 'unknown') });
        return true;
    }

    claimRequest(generationId, source) {
        const session = this.getSession(generationId);
        if (!session || session.phase === 'cancelled') {
            return { ok: false, reason: 'generation-inactive' };
        }
        if (session.requestState !== 'idle') {
            this.log('task-deduped', session, {
                source: String(source || ''),
                reason: `request-${session.requestState}`,
            });
            return { ok: false, reason: `request-${session.requestState}` };
        }
        session.requestState = 'scheduled';
        session.requestSource = String(source || 'unknown');
        this.log('task-scheduled', session, { source: session.requestSource });
        return { ok: true, session, reason: '' };
    }

    markRequestRunning(generationId) {
        const session = this.getSession(generationId);
        if (!session || session.requestState !== 'scheduled') return false;
        session.requestState = 'running';
        this.log('run-start', session, { source: session.requestSource });
        return true;
    }

    markRequestSucceeded(generationId) {
        const session = this.getSession(generationId);
        if (!session) return false;
        session.requestState = 'succeeded';
        this.log('fetch-success', session, { source: session.requestSource });
        return true;
    }

    markRequestFailed(generationId, reason = 'failed') {
        const session = this.getSession(generationId);
        if (!session) return false;
        if (session.phase === 'cancelled'
            || ['cancelled', 'superseded', 'stale'].includes(session.requestState)) {
            this.log('fetch-failure-ignored', session, { source: session.requestSource, reason });
            return false;
        }
        const previousRequestState = session.requestState;
        session.requestState = ['running', 'succeeded', 'failed'].includes(previousRequestState)
            ? 'failed'
            : 'idle';
        this.log('fetch-failure', session, { source: session.requestSource, reason });
        if (session.requestState === 'idle') session.requestSource = '';
        return true;
    }

    markRequestTerminated(generationId, state = 'failed', reason = 'failed') {
        const session = this.getSession(generationId);
        if (!session) return false;
        if (session.phase === 'cancelled') return false;
        const normalizedState = ['failed', 'cancelled', 'superseded', 'stale'].includes(state)
            ? state
            : 'failed';
        session.requestState = normalizedState;
        session.requestSource = session.requestSource || 'unknown';
        this.log('task-ended', session, { source: session.requestSource, reason: String(reason || normalizedState) });
        return true;
    }

    cancelActive(reason = 'cancelled') {
        const normalizedReason = String(reason || 'cancelled');
        if (normalizedReason === 'chat-changed' || normalizedReason === 'page-unload') {
            this.pendingStreamingHostReceipts.length = 0;
        }
        const session = this.active;
        if (!session) return false;
        session.phase = 'cancelled';
        session.cancelReason = normalizedReason;
        session.requestState = session.cancelReason === 'superseded-by-new-generation' ? 'superseded' : 'cancelled';
        this.log('task-cancelled', session, { reason: session.cancelReason });
        this.active = null;
        return true;
    }
}

export const generationLifecycle = new GenerationLifecycleRegistry();
