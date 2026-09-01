import { getMessageSwipeIndex } from '../chat/messageBranch.js';
import { readCurrentShujukuV2Cells } from '../shujuku/deepClean/replay.js';
import { readLateShujukuV1Cells } from '../shujuku/deepClean/v1.js';

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
    return !!(value && typeof value === 'object' && !Array.isArray(value));
}

function requestHeaders(context) {
    return typeof context?.getRequestHeaders === 'function'
        ? context.getRequestHeaders()
        : undefined;
}

async function fetchJson(fetchImpl, context, url, body, errorMessage) {
    const response = await fetchImpl(url, {
        method: 'POST',
        headers: requestHeaders(context),
        body: JSON.stringify(body),
    });
    if (!response?.ok) throw new Error(errorMessage);
    return response.json();
}

function stringValue(value) {
    return typeof value === 'string' ? value : null;
}

function worldBookEntryDisplayName(entry) {
    return stringValue(entry?.comment)?.trim() || '';
}

function isMvuEntryTitle(title) {
    return title.startsWith('[mvu_update]')
        || title.startsWith('[initvar]')
        || title === '变量列表';
}

function isSuspectedEjsTemplate(text) {
    const source = String(text || '').trim();
    if (!source.includes('<%') || !source.includes('%>')) return false;

    const executableTags = [...source.matchAll(/<%[_-]?[=-]?([\s\S]*?)[_-]?%>/g)];
    if (executableTags.length < 2) return false;

    const executableSource = executableTags.map((match) => match[1]).join('\n');
    const executableLength = executableTags.reduce((total, match) => total + match[0].length, 0);
    const hasConditionalBranch = /\bif\s*\([^)]*(?:===|!==|==|!=|&&|\|\|)[^)]*\)\s*\{/.test(executableSource)
        && /\}\s*else(?:\s+if\s*\([^)]*\))?\s*\{/.test(executableSource);
    const hasTemplateExpression = /<%[_-]?[=-]\s*[A-Za-z_$][\w$]*(?:\s*(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\]))*\s*[_-]?%>/.test(source);
    return executableLength / source.length >= 0.35 && hasConditionalBranch && hasTemplateExpression;
}

function addItem(items, kind, originalText, locator, options = {}) {
    if (typeof originalText !== 'string') return;
    const item = {
        kind,
        originalText: String(originalText),
        locator: cloneJson(locator),
        programEligible: options.programEligible === true,
        aiEligible: options.aiEligible === true,
    };
    if (typeof options.displayName === 'string') item.displayName = options.displayName;
    if (typeof options.ownerDisplayName === 'string') item.ownerDisplayName = options.ownerDisplayName;
    if (options.storageProtocol === 'v1' || options.storageProtocol === 'v2') item.storageProtocol = options.storageProtocol;
    if (options.isMvuEntry === true) item.protectionReason = 'mvu';
    else if (isSuspectedEjsTemplate(item.originalText)) item.protectionReason = 'ejs';
    items.push(item);
}

async function readCharacterItems(items, characterKey, fetchImpl, context, shouldStop) {
    const character = await fetchJson(
        fetchImpl,
        context,
        '/api/characters/get',
        { avatar_url: characterKey },
        `Deep Clean Character read failed for ${characterKey}`,
    );
    if (shouldStop?.()) return false;
    const data = character?.data;
    if (!isRecord(data)) throw new Error(`Deep Clean Character response is invalid for ${characterKey}`);
    addItem(items, 'character-description', stringValue(data.description), {
        characterKey,
        field: 'data.description',
    }, { programEligible: true, aiEligible: true });
    addItem(items, 'character-personality', stringValue(data.personality), {
        characterKey,
        field: 'data.personality',
    }, { programEligible: true, aiEligible: true });
    addItem(items, 'character-first-message', stringValue(data.first_mes), {
        characterKey,
        field: 'data.first_mes',
    }, { programEligible: true, aiEligible: true });

    const greetings = Array.isArray(data.alternate_greetings) ? data.alternate_greetings : [];
    greetings.forEach((greeting, alternateGreetingIndex) => {
        addItem(items, 'character-alternate-greeting', stringValue(greeting), {
            characterKey,
            alternateGreetingIndex,
        }, { programEligible: true, aiEligible: true });
    });

    const entries = Array.isArray(data.character_book?.entries) ? data.character_book.entries : [];
    const entryIdCounts = entries.reduce((counts, entry) => {
        if (Number.isInteger(entry?.id)) counts.set(entry.id, (counts.get(entry.id) || 0) + 1);
        return counts;
    }, new Map());
    entries.forEach((entry, entryIndex) => {
        if (typeof entry?.content !== 'string') return;
        if (!Number.isInteger(entry.id) || entryIdCounts.get(entry.id) !== 1) {
            throw new Error(`Deep Clean embedded World Book entry has no unique stable id: ${characterKey}/${entryIndex}`);
        }
        addItem(items, 'embedded-world-book-entry', stringValue(entry?.content), {
            characterKey,
            entryId: entry.id,
            entryIndex,
        }, {
            programEligible: true,
            aiEligible: true,
            displayName: worldBookEntryDisplayName(entry),
            ownerDisplayName: stringValue(data.name)?.trim() || characterKey,
            isMvuEntry: isMvuEntryTitle(worldBookEntryDisplayName(entry)),
        });
    });
    return true;
}

function readChatMessageItems(items, characterKey, chatId, chat) {
    chat.forEach((message, messageIndex) => {
        if (!isRecord(message) || message.is_system === true) return;
        if (message.is_user !== true && message.is_user !== false) return;
        if (message.is_user === true) {
            addItem(items, 'user-message', stringValue(message.mes), {
                characterKey,
                chatId,
                messageIndex,
            }, { programEligible: true, aiEligible: true });
            return;
        }
        if (!Array.isArray(message.swipes)) {
            addItem(items, 'assistant-swipe', stringValue(message.mes), {
                characterKey,
                chatId,
                messageIndex,
                branch: 'main',
            }, { programEligible: true, aiEligible: true });
            return;
        }
        const selectedSwipeIndex = getMessageSwipeIndex(message);
        message.swipes.forEach((swipe, swipeIndex) => {
            const text = typeof swipe === 'string' ? swipe : stringValue(swipe?.mes);
            addItem(items, 'assistant-swipe', text, {
                characterKey,
                chatId,
                messageIndex,
                swipeIndex,
            }, { programEligible: true, aiEligible: swipeIndex === selectedSwipeIndex });
        });
    });
}

async function readChatItems(items, chatSelection, fetchImpl, context, shouldStop) {
    const chat = await fetchJson(
        fetchImpl,
        context,
        '/api/chats/get',
        { avatar_url: chatSelection.characterKey, file_name: chatSelection.chatId },
        `Deep Clean Chat read failed for ${chatSelection.chatId}`,
    );
    if (shouldStop?.()) return false;
    if (!Array.isArray(chat)) throw new Error(`Deep Clean Chat response is invalid for ${chatSelection.chatId}`);
    readChatMessageItems(items, chatSelection.characterKey, chatSelection.chatId, chat);
    if (shouldStop?.()) return false;
    const v2Cells = await readCurrentShujukuV2Cells(chat);
    const v1Cells = await readLateShujukuV1Cells(chat, { chatId: chatSelection.chatId, context });
    if (shouldStop?.()) return false;
    [
        ...v2Cells.map((cell) => ({ ...cell, storageProtocol: 'v2' })),
        ...v1Cells.map((cell) => ({ ...cell, storageProtocol: 'v1' })),
    ].forEach((cell) => {
        addItem(items, 'shujuku-cell', cell.originalText, {
            characterKey: chatSelection.characterKey,
            chatId: chatSelection.chatId,
            isolationKey: cell.isolationKey,
            sheetKey: cell.sheetKey,
            rowId: cell.rowId,
            columnKey: cell.columnKey,
        }, { programEligible: true, aiEligible: true, storageProtocol: cell.storageProtocol });
    });
    return true;
}

function readPersonaItems(items, personaKeys, context) {
    const descriptions = context?.powerUserSettings?.persona_descriptions;
    personaKeys.forEach((personaKey) => {
        addItem(items, 'persona-description', stringValue(descriptions?.[personaKey]?.description), {
            personaKey,
        }, { programEligible: true, aiEligible: true });
    });
}

async function readWorldBookItems(items, worldBookKeys, context, options = {}) {
    if (typeof context?.loadWorldInfo !== 'function') throw new Error('Deep Clean World Book reader is unavailable');
    for (const worldBookKey of worldBookKeys) {
        if (options.shouldStop?.()) return false;
        const worldBook = await context.loadWorldInfo(worldBookKey);
        if (options.shouldStop?.()) return false;
        if (!isRecord(worldBook) || !isRecord(worldBook.entries)) {
            throw new Error(`Deep Clean World Book read failed for ${worldBookKey}`);
        }
        Object.entries(worldBook.entries).forEach(([entryKey, entry]) => {
            addItem(items, 'external-world-book-entry', stringValue(entry?.content), {
                worldBookKey,
                entryKey,
            }, {
                programEligible: true,
                aiEligible: true,
                displayName: worldBookEntryDisplayName(entry),
                isMvuEntry: isMvuEntryTitle(worldBookEntryDisplayName(entry)),
            });
        });
        options.onRead?.();
    }
    return true;
}

export async function readDeepCleanContentItems(frozenInput, options = {}) {
    const context = options.context;
    const fetchImpl = options.fetchImpl;
    if (typeof fetchImpl !== 'function') throw new Error('Deep Clean reader fetch is unavailable');
    const items = [];
    const total = frozenInput.characterKeys.length
        + frozenInput.chats.length
        + frozenInput.personaKeys.length
        + frozenInput.worldBookKeys.length;
    let current = 0;
    const reportProgress = () => options.onProgress?.({ current, total });
    for (const characterKey of frozenInput.characterKeys) {
        if (options.shouldStop?.()) return items;
        if (!await readCharacterItems(items, characterKey, fetchImpl, context, options.shouldStop)) return items;
        current++;
        reportProgress();
    }
    for (const chatSelection of frozenInput.chats) {
        if (options.shouldStop?.()) return items;
        if (!await readChatItems(items, chatSelection, fetchImpl, context, options.shouldStop)) return items;
        current++;
        reportProgress();
    }
    for (const personaKey of frozenInput.personaKeys) {
        if (options.shouldStop?.()) return items;
        readPersonaItems(items, [personaKey], context);
        current++;
        reportProgress();
    }
    if (options.shouldStop?.()) return items;
    await readWorldBookItems(items, frozenInput.worldBookKeys, context, {
        shouldStop: options.shouldStop,
        onRead: () => {
            current++;
            reportProgress();
        },
    });
    return items;
}
