/** Reads the selectable Deep Clean resource inventory; selection and session ownership remain elsewhere. */
import { getDeepCleanHostOwnershipSnapshot, getSillyTavernContextSnapshot } from '../host/context.js';

function characterKeyOf(character) {
    return typeof character?.avatar === 'string' ? character.avatar : '';
}

function characterFileKey(characterKey) {
    return characterKey.replace(/\.[^/.]+$/, '');
}

function currentCharacterOf(context) {
    const index = Number(context?.characterId);
    return Number.isInteger(index) ? context.characters?.[index] ?? null : null;
}

function isGroupChatOpen(context) {
    return context?.groupId !== null && context?.groupId !== undefined && String(context.groupId) !== '';
}

function currentChatIdOf(context) {
    if (context?.chatId === null || context?.chatId === undefined) return '';
    return String(context.chatId);
}

function requestHeaders(context, options) {
    return typeof context?.getRequestHeaders === 'function'
        ? context.getRequestHeaders(options)
        : undefined;
}

async function loadPersonaKeys(context, fetchImpl) {
    const response = await fetchImpl('/api/avatars/get', {
        method: 'POST',
        headers: requestHeaders(context, { omitContentType: true }),
    });
    if (!response?.ok) throw new Error('Deep Clean Persona index request failed');
    const identities = await response.json();
    if (!Array.isArray(identities)) throw new Error('Deep Clean Persona index response is invalid');
    return identities.filter((identity) => typeof identity === 'string' && identity);
}

async function loadCharacterChats(context, fetchImpl, characterKey) {
    const response = await fetchImpl('/api/characters/chats', {
        method: 'POST',
        headers: requestHeaders(context),
        body: JSON.stringify({ avatar_url: characterKey, metadata: true }),
    });
    if (!response?.ok) throw new Error(`Deep Clean Character Chat index request failed for ${characterKey}`);
    const chats = await response.json();
    // SillyTavern returns { error: true } when the character has no chat directory.
    return Array.isArray(chats) ? chats : [];
}

function chatIdOf(metadata) {
    if (typeof metadata?.file_id === 'string' && metadata.file_id) return metadata.file_id;
    if (typeof metadata?.file_name !== 'string') return '';
    return metadata.file_name.replace(/\.jsonl$/i, '');
}

function chatKey(characterKey, chatId) {
    return `${characterKey}\u0000${chatId}`;
}

function addUnique(values, value) {
    if (value && !values.includes(value)) values.push(value);
}

function findByKey(items, keyName, key) {
    return items.find((item) => item[keyName] === key) ?? null;
}

function addPersonaRelation(personas, personaKey, relation) {
    const persona = findByKey(personas, 'personaKey', personaKey);
    if (!persona) return;
    if (relation.characterKey) addUnique(persona.characterKeys, relation.characterKey);
    if (relation.chatKey) addUnique(persona.chatKeys, relation.chatKey);
}

function addWorldBookRelation(worldBooks, worldBookKey, relation) {
    const worldBook = findByKey(worldBooks, 'worldBookKey', worldBookKey);
    if (!worldBook) return;
    if (relation.characterKey) addUnique(worldBook.characterKeys, relation.characterKey);
    if (relation.chatKey) addUnique(worldBook.chatKeys, relation.chatKey);
}

function hasEmbeddedCharacterWorldBook(character) {
    return Boolean(character?.data?.character_book && typeof character.data.character_book === 'object');
}

/**
 * Loads the complete selectable Deep Clean index from SillyTavern-owned sources.
 * Selection is deliberately not part of this result; the Initial Selection page owns it.
 */
export async function loadDeepCleanResourceInventory(options = {}) {
    const context = options.context ?? getSillyTavernContextSnapshot();
    const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
    if (typeof fetchImpl !== 'function') throw new Error('Deep Clean index fetch is unavailable');

    const hostOwnership = getDeepCleanHostOwnershipSnapshot();
    const worldInfoState = Object.hasOwn(options, 'worldInfoState')
        ? options.worldInfoState
        : hostOwnership.worldInfoState;
    const characters = [];
    const sourceCharacters = Array.isArray(context.characters) ? context.characters : [];
    for (const character of sourceCharacters) {
        const characterKey = characterKeyOf(character);
        if (!characterKey || findByKey(characters, 'characterKey', characterKey)) continue;
        characters.push({
            characterKey,
            displayLabel: String(character.name || characterKey),
            hasEmbeddedWorldBook: hasEmbeddedCharacterWorldBook(character),
        });
    }

    if (typeof context.getWorldInfoNames !== 'function') {
        throw new Error('Deep Clean World Book index is unavailable');
    }
    const worldBooks = context.getWorldInfoNames()
        .filter((worldBookKey) => typeof worldBookKey === 'string' && worldBookKey)
        .filter((worldBookKey, index, values) => values.indexOf(worldBookKey) === index)
        .map((worldBookKey) => ({ worldBookKey, displayLabel: worldBookKey, characterKeys: [], chatKeys: [] }));

    const powerUser = context.powerUserSettings ?? {};
    const personaLabels = powerUser.personas ?? {};
    const personaDescriptions = powerUser.persona_descriptions ?? {};
    const personaKeys = await loadPersonaKeys(context, fetchImpl);
    const personas = personaKeys
        .filter((personaKey, index) => personaKeys.indexOf(personaKey) === index)
        .map((personaKey) => ({
            personaKey,
            displayLabel: String(personaLabels[personaKey] || personaKey),
            characterKeys: [],
            chatKeys: [],
        }));

    const chats = [];
    for (const character of characters) {
        const sourceCharacter = sourceCharacters.find((item) => characterKeyOf(item) === character.characterKey);
        const primaryBook = sourceCharacter?.data?.extensions?.world;
        if (typeof primaryBook === 'string' && primaryBook) {
            addWorldBookRelation(worldBooks, primaryBook, { characterKey: character.characterKey });
        }
        const additionalBooks = worldInfoState?.charLore?.find((item) => (
            item?.name === characterFileKey(character.characterKey)
        ))?.extraBooks;
        if (Array.isArray(additionalBooks)) {
            for (const worldBookKey of additionalBooks) {
                if (typeof worldBookKey === 'string' && worldBookKey) {
                    addWorldBookRelation(worldBooks, worldBookKey, { characterKey: character.characterKey });
                }
            }
        }
        for (const [personaKey, descriptor] of Object.entries(personaDescriptions)) {
            const isConnected = Array.isArray(descriptor?.connections)
                && descriptor.connections.some((connection) => (
                    connection?.type === 'character' && connection.id === character.characterKey
                ));
            if (isConnected) addPersonaRelation(personas, personaKey, { characterKey: character.characterKey });
        }

        const chatMetadataList = await loadCharacterChats(context, fetchImpl, character.characterKey);
        for (const metadata of chatMetadataList) {
            const chatId = chatIdOf(metadata);
            if (!chatId) continue;
            const key = chatKey(character.characterKey, chatId);
            if (findByKey(chats, 'key', key)) continue;
            chats.push({ key, characterKey: character.characterKey, chatId, displayLabel: chatId });
            const chatMetadata = metadata.chat_metadata ?? {};
            if (typeof chatMetadata.persona === 'string' && chatMetadata.persona) {
                addPersonaRelation(personas, chatMetadata.persona, { characterKey: character.characterKey, chatKey: key });
            }
            if (typeof chatMetadata.world_info === 'string' && chatMetadata.world_info) {
                addWorldBookRelation(worldBooks, chatMetadata.world_info, { characterKey: character.characterKey, chatKey: key });
            }
        }
    }

    const groupChat = isGroupChatOpen(context);
    const currentCharacterKey = groupChat ? '' : characterKeyOf(currentCharacterOf(context));
    const currentChatId = groupChat ? '' : currentChatIdOf(context);
    const currentChatKey = currentCharacterKey && currentChatId
        ? chatKey(currentCharacterKey, currentChatId)
        : '';
    if (currentChatKey && !findByKey(chats, 'key', currentChatKey)) {
        chats.push({
            key: currentChatKey,
            characterKey: currentCharacterKey,
            chatId: currentChatId,
            displayLabel: currentChatId,
        });
    }
    if (currentChatKey) {
        const chatMetadata = context.chatMetadata ?? {};
        if (typeof chatMetadata.persona === 'string' && chatMetadata.persona) {
            addPersonaRelation(personas, chatMetadata.persona, { characterKey: currentCharacterKey, chatKey: currentChatKey });
        }
        if (typeof chatMetadata.world_info === 'string' && chatMetadata.world_info) {
            addWorldBookRelation(worldBooks, chatMetadata.world_info, { characterKey: currentCharacterKey, chatKey: currentChatKey });
        }
        const currentPersonaIdentity = Object.hasOwn(options, 'currentPersonaIdentity')
            ? String(options.currentPersonaIdentity || '')
            : String(hostOwnership.currentPersonaIdentity || '');
        if (currentPersonaIdentity) {
            addPersonaRelation(personas, currentPersonaIdentity, { characterKey: currentCharacterKey, chatKey: currentChatKey });
        }
    }

    return {
        current: { groupChat, characterKey: currentCharacterKey, chatKey: currentChatKey },
        characters,
        chats,
        personas,
        worldBooks,
    };
}
