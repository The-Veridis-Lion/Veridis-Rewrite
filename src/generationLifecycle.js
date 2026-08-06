const MESSAGE_INDEX_FIELDS = ['messageId', 'message_id', 'mesId', 'mesid', 'index'];

function normalizeMessageIndex(value) {
    if (Number.isInteger(value) && value >= 0) return value;
    if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return -1;
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : -1;
}

export function hashLifecycleText(value = '') {
    const source = String(value ?? '');
    let hash = 2166136261;
    for (let index = 0; index < source.length; index++) {
        hash ^= source.charCodeAt(index);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return `h${(hash >>> 0).toString(16)}`;
}

export function parseStableMessagePayload(payload) {
    const candidates = [];

    const visit = (value, source, depth = 0) => {
        if (depth > 3 || value === null || value === undefined) return;

        const direct = normalizeMessageIndex(value);
        if (direct >= 0) {
            candidates.push({ messageIndex: direct, source });
            return;
        }

        if (Array.isArray(value)) {
            value.forEach((entry, index) => visit(entry, `${source}[${index}]`, depth + 1));
            return;
        }

        if (typeof value !== 'object') return;
        for (const field of MESSAGE_INDEX_FIELDS) {
            if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
            const parsed = normalizeMessageIndex(value[field]);
            if (parsed >= 0) candidates.push({ messageIndex: parsed, source: `${source}.${field}` });
        }
    };

    const rootSource = typeof payload === 'number'
        ? 'number'
        : typeof payload === 'string'
            ? 'numeric-string'
            : 'payload';
    visit(payload, rootSource);

    if (candidates.length === 0) {
        return { ok: false, messageIndex: -1, source: rootSource, reason: 'missing-message-index' };
    }

    const uniqueIndices = [...new Set(candidates.map((candidate) => candidate.messageIndex))];
    if (uniqueIndices.length !== 1) {
        return { ok: false, messageIndex: -1, source: rootSource, reason: 'ambiguous-message-index' };
    }

    return {
        ok: true,
        messageIndex: uniqueIndices[0],
        source: candidates[0].source,
        reason: '',
    };
}

function isAssistantMessage(message) {
    return Boolean(message && typeof message === 'object'
        && message.is_user !== true
        && message.role !== 'user');
}

export class GenerationLifecycleRegistry {
    constructor(options = {}) {
        this.setTimeoutFn = options.setTimeoutFn || globalThis.setTimeout.bind(globalThis);
        this.clearTimeoutFn = options.clearTimeoutFn || globalThis.clearTimeout.bind(globalThis);
        this.getCurrentChatId = typeof options.getCurrentChatId === 'function'
            ? options.getCurrentChatId
            : null;
        this.getCurrentChat = typeof options.getCurrentChat === 'function'
            ? options.getCurrentChat
            : null;
        this.onLog = typeof options.onLog === 'function' ? options.onLog : null;
        this.sequence = 0;
        this.active = null;
        this.sessions = new Map();
    }

    log(name, session, details = {}) {
        if (!this.onLog) return;
        this.onLog(name, {
            generationId: session?.generationId || '',
            chatId: session?.chatId || '',
            messageId: Number.isInteger(session?.messageId) ? session.messageId : null,
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
            messageTextHash: '',
            internalMutationCount: 0,
            mode: String(mode || 'unknown'),
            phase: 'active',
            finalSources: new Set(),
            requestState: 'idle',
            requestSource: '',
            requestStarted: false,
            cancelReason: '',
            timers: new Map(),
            completedTimerPhases: new Set(),
            externalActions: [],
        };
        this.active = session;
        this.sessions.set(generationId, session);
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
        return this.sessions.get(String(generationId || '')) || null;
    }

    resolveMessage(payload, options = {}) {
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

        const parsed = parseStableMessagePayload(payload);
        let messageIndex = parsed.messageIndex;
        let resolutionSource = parsed.source;
        if (!parsed.ok) {
            if (options.allowBoundMessage === true && Number.isInteger(session.messageId)) {
                messageIndex = session.messageId;
                resolutionSource = 'active-generation-binding';
            } else {
                this.log('payload-rejected', session, { source: options.source || '', reason: parsed.reason });
                return parsed;
            }
        }

        if (messageIndex < 0 || messageIndex >= chat.length) {
            return { ok: false, messageIndex: -1, source: resolutionSource, reason: 'message-index-out-of-range' };
        }
        const message = chat[messageIndex];
        if (!isAssistantMessage(message)) {
            return { ok: false, messageIndex: -1, source: resolutionSource, reason: 'message-not-assistant' };
        }
        if (Number.isInteger(session.messageId) && session.messageId !== messageIndex) {
            return { ok: false, messageIndex: -1, source: resolutionSource, reason: 'generation-message-mismatch' };
        }
        if (session.messageRef && session.messageRef !== message) {
            return { ok: false, messageIndex: -1, source: resolutionSource, reason: 'message-reference-changed' };
        }

        session.messageId = messageIndex;
        session.messageRef = message;
        session.messageTextHash = hashLifecycleText(message.mes || '');
        this.log('payload-resolved', session, {
            source: options.source || resolutionSource,
            payloadSource: resolutionSource,
        });
        return {
            ok: true,
            messageIndex,
            message,
            generationId: session.generationId,
            chatId: session.chatId,
            source: resolutionSource,
            reason: '',
        };
    }

    validate(generationId, options = {}) {
        const session = this.getSession(generationId);
        if (!session) return { ok: false, reason: 'generation-missing' };
        if (session.phase === 'cancelled') return { ok: false, reason: session.cancelReason || 'generation-cancelled' };
        if (this.active !== session) return { ok: false, reason: 'generation-not-active' };

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
        const validationMode = String(options.mode || 'full-message');
        if (validationMode !== 'identity' && hashLifecycleText(message.mes || '') !== session.messageTextHash) {
            return { ok: false, reason: 'message-text-changed' };
        }
        return { ok: true, reason: '', session, message };
    }

    acknowledgeInternalMessageMutation(generationId, options = {}) {
        const session = this.getSession(generationId);
        if (!session || session.phase === 'cancelled' || this.active !== session) {
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

        const beforeTextHash = hashLifecycleText(options.beforeText || '');
        const afterTextHash = hashLifecycleText(options.afterText || '');
        if (beforeTextHash !== session.messageTextHash) {
            return { ok: false, reason: 'unexpected-pre-cleanse-text' };
        }
        if (hashLifecycleText(message.mes || '') !== afterTextHash) {
            return { ok: false, reason: 'message-text-not-cleanse-result' };
        }
        if (beforeTextHash === afterTextHash) {
            return { ok: true, changed: false, reason: '', session, message };
        }

        session.messageTextHash = afterTextHash;
        session.internalMutationCount += 1;
        this.log('internal-message-mutation-acknowledged', session, {
            source: String(options.source || 'internal-cleanse'),
            previousTextHash: beforeTextHash,
            textHash: afterTextHash,
            internalMutationCount: session.internalMutationCount,
        });
        return { ok: true, changed: true, reason: '', session, message };
    }

    markFinalSource(generationId, source) {
        const session = this.getSession(generationId);
        if (!session || session.phase === 'cancelled') return false;
        session.finalSources.add(String(source || 'unknown'));
        session.phase = 'finalizing';
        this.log('event-received', session, { source: String(source || 'unknown') });
        return true;
    }

    scheduleTimer(generationId, phase, delay, callback, options = {}) {
        const session = this.getSession(generationId);
        if (!session || session.phase === 'cancelled') return { ok: false, reason: 'generation-inactive' };
        const timerPhase = String(phase || 'timer');
        if (session.timers.has(timerPhase) || session.completedTimerPhases.has(timerPhase)) {
            this.log('timer-deduped', session, { timerPhase });
            return { ok: false, reason: 'timer-already-scheduled' };
        }

        const handle = this.setTimeoutFn(() => {
            session.timers.delete(timerPhase);
            session.completedTimerPhases.add(timerPhase);
            const validation = this.validate(generationId, options.validationOptions || {});
            if (!validation.ok) {
                this.log('timer-skipped', session, { timerPhase, reason: validation.reason });
                if (typeof options.onSkip === 'function') options.onSkip(validation.reason, session);
                return;
            }
            const customValidation = typeof options.validate === 'function'
                ? options.validate(validation.session)
                : { ok: true, reason: '' };
            if (!customValidation?.ok) {
                const reason = String(customValidation?.reason || 'custom-validation-failed');
                this.log('timer-skipped', session, { timerPhase, reason });
                if (typeof options.onSkip === 'function') options.onSkip(reason, session);
                return;
            }
            this.log('timer-fired', session, { timerPhase });
            callback(validation.session);
        }, delay);
        session.timers.set(timerPhase, handle);
        this.log('timer-created', session, { timerPhase, delay: Number(delay) || 0 });
        return { ok: true, handle, reason: '' };
    }

    clearTimers(session, reason = 'cleared') {
        if (!session) return;
        for (const [timerPhase, handle] of session.timers.entries()) {
            this.clearTimeoutFn(handle);
            this.log('timer-cleared', session, { timerPhase, reason });
        }
        session.timers.clear();
    }

    claimRequest(generationId, source) {
        const session = this.getSession(generationId);
        if (!session || session.phase === 'cancelled' || this.active !== session) {
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
        session.requestStarted = true;
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
        session.requestState = session.requestStarted ? 'failed' : 'idle';
        this.log('fetch-failure', session, { source: session.requestSource, reason });
        if (!session.requestStarted) session.requestSource = '';
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
        const session = this.active;
        if (!session) return false;
        this.clearTimers(session, reason);
        session.phase = 'cancelled';
        session.cancelReason = String(reason || 'cancelled');
        session.requestState = session.cancelReason === 'superseded-by-new-generation' ? 'superseded' : 'cancelled';
        this.log('task-cancelled', session, { reason: session.cancelReason });
        this.active = null;
        return true;
    }

    recordExternalAction(name, details = {}) {
        const session = this.active;
        if (!session) return;
        session.externalActions.push({ name: String(name || ''), details });
    }
}

export const generationLifecycle = new GenerationLifecycleRegistry();
