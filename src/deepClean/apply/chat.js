// Owns Character Chat Branch persistence and synchronization of the currently open branch. Shujuku protocol transformation remains delegated to the existing Shujuku modules.

import { getSillyTavernContextSnapshot } from '../../host/context.js';
import { applyCurrentShujukuV2CellChanges } from '../../shujuku/deepClean/replay.js';
import { prepareLateShujukuV1Migration } from '../../shujuku/deepClean/v1.js';
import { cloneJson, isRecord, postJson } from './io.js';

export function currentOpenCharacterBranch(context) {
    const groupId = context?.groupId;
    if (groupId !== null && groupId !== undefined && String(groupId) !== '') return null;
    if (!Array.isArray(context?.characters)) {
        throw new Error('Deep Clean current Character Chat context is unavailable');
    }
    const hasCharacter = context?.characterId !== null
        && context?.characterId !== undefined
        && String(context.characterId) !== '';
    const hasChat = context?.chatId !== null
        && context?.chatId !== undefined
        && String(context.chatId) !== '';
    if (!hasCharacter && !hasChat) return null;
    if (!hasCharacter || !hasChat) {
        throw new Error('Deep Clean current Character Chat identity is incomplete');
    }
    const characterIndex = Number(context.characterId);
    const character = Number.isInteger(characterIndex) ? context.characters[characterIndex] : null;
    if (!isRecord(character) || typeof character.avatar !== 'string' || !character.avatar) {
        throw new Error('Deep Clean current Character Chat avatar is unavailable');
    }
    return { characterKey: character.avatar, chatId: String(context.chatId) };
}

function currentBranchSnapshot(context, characterKey, chatId) {
    const current = currentOpenCharacterBranch(context);
    if (!current || current.characterKey !== characterKey || current.chatId !== chatId) return null;
    if (!Array.isArray(context.chat) || !isRecord(context.chatMetadata)) {
        throw new Error(`Deep Clean current Chat live owner is invalid: ${characterKey}/${chatId}`);
    }
    return [
        {
            chat_metadata: cloneJson(context.chatMetadata),
            user_name: 'unused',
            character_name: 'unused',
        },
        ...cloneJson(context.chat),
    ];
}

function syncCurrentBranchLiveShujukuChanges(characterKey, chatId, branch, shujukuMessageIndexes, options = {}) {
    const context = getSillyTavernContextSnapshot();
    const current = currentOpenCharacterBranch(context);
    if (!current || current.characterKey !== characterKey || current.chatId !== chatId) return;
    if (!Array.isArray(context.chat)) {
        throw new Error(`Deep Clean current Chat live owner is invalid after save: ${characterKey}/${chatId}`);
    }
    for (const persistedIndex of shujukuMessageIndexes) {
        const liveMessage = context.chat[persistedIndex - 1];
        const savedMessage = branch[persistedIndex];
        if (!Number.isInteger(persistedIndex) || !isRecord(liveMessage) || !isRecord(savedMessage)) {
            throw new Error(`Deep Clean current Chat live Shujuku Message is unavailable after save: ${characterKey}/${chatId}/${persistedIndex}`);
        }
        if (Object.prototype.hasOwnProperty.call(savedMessage, 'TavernDB_ACU_IsolatedData')) {
            liveMessage.TavernDB_ACU_IsolatedData = cloneJson(savedMessage.TavernDB_ACU_IsolatedData);
        } else if (options.includeV1Cleanup === true) {
            delete liveMessage.TavernDB_ACU_IsolatedData;
        }
        if (Object.prototype.hasOwnProperty.call(savedMessage, 'TavernDB_ACU_Identity')
            && savedMessage.TavernDB_ACU_Identity !== undefined) {
            liveMessage.TavernDB_ACU_Identity = cloneJson(savedMessage.TavernDB_ACU_Identity);
        } else {
            delete liveMessage.TavernDB_ACU_Identity;
        }
        if (options.includeV1Cleanup !== true) continue;
        for (const field of [
            'TavernDB_ACU_IndependentData',
            'TavernDB_ACU_Data',
            'TavernDB_ACU_SummaryData',
            'TavernDB_ACU_ModifiedKeys',
            'TavernDB_ACU_UpdateGroupKeys',
        ]) {
            if (Object.prototype.hasOwnProperty.call(savedMessage, field) && savedMessage[field] !== undefined) {
                liveMessage[field] = cloneJson(savedMessage[field]);
            }
            else delete liveMessage[field];
        }
    }
}

function syncCurrentBranchLiveChanges(characterKey, chatId, branch, ordinaryChanges, shujukuMessageIndexes) {
    const context = getSillyTavernContextSnapshot();
    const current = currentOpenCharacterBranch(context);
    if (!current || current.characterKey !== characterKey || current.chatId !== chatId) return;
    if (!Array.isArray(context.chat)) {
        throw new Error(`Deep Clean current Chat live owner is invalid after save: ${characterKey}/${chatId}`);
    }
    for (const change of ordinaryChanges) {
        const persistedIndex = change.locator.messageIndex;
        const liveIndex = persistedIndex - 1;
        const liveMessage = context.chat[liveIndex];
        const savedMessage = branch[persistedIndex];
        if (!Number.isInteger(persistedIndex) || !isRecord(liveMessage) || !isRecord(savedMessage)) {
            throw new Error(`Deep Clean current Chat live Message is unavailable after save: ${characterKey}/${chatId}/${persistedIndex}`);
        }
        if (change.kind === 'user-message') {
            liveMessage.mes = savedMessage.mes;
        } else if (Number.isInteger(change.locator.swipeIndex)) {
            const swipeIndex = change.locator.swipeIndex;
            if (!Array.isArray(liveMessage.swipes) || !Array.isArray(savedMessage.swipes)) {
                throw new Error(`Deep Clean current Chat live Swipe owner is unavailable after save: ${characterKey}/${chatId}/${persistedIndex}/${swipeIndex}`);
            }
            liveMessage.swipes[swipeIndex] = savedMessage.swipes[swipeIndex];
            if (swipeIndex === liveMessage.swipe_id) liveMessage.mes = savedMessage.mes;
        } else {
            liveMessage.mes = savedMessage.mes;
        }
    }
    syncCurrentBranchLiveShujukuChanges(characterKey, chatId, branch, shujukuMessageIndexes);
}

function validateChatHeader(branch, characterKey, chatId) {
    if (!Array.isArray(branch) || !isRecord(branch[0]) || !isRecord(branch[0].chat_metadata)) {
        throw new Error(`Deep Clean Chat Branch header is invalid: ${characterKey}/${chatId}`);
    }
}

function prepareOrdinaryChatChanges(branch, changes) {
    const actions = [];
    for (const change of changes) {
        const locator = change.locator;
        const index = locator.messageIndex;
        const message = Number.isInteger(index) ? branch[index] : null;
        if (!isRecord(message) || message.is_system === true) {
            throw new Error(`Deep Clean Chat message locator is invalid: ${locator.characterKey}/${locator.chatId}/${index}`);
        }
        if (change.kind === 'user-message') {
            if (message.is_user !== true || message.mes !== change.originalText) {
                throw new Error(`Deep Clean User Message changed after Freeze: ${locator.characterKey}/${locator.chatId}/${index}`);
            }
            actions.push(() => { message.mes = change.reviewedText; });
            continue;
        }
        if (change.kind !== 'assistant-swipe' || message.is_user !== false) {
            throw new Error(`Deep Clean Assistant Swipe locator is invalid: ${locator.characterKey}/${locator.chatId}/${index}`);
        }
        if (Number.isInteger(locator.swipeIndex)) {
            if (!Array.isArray(message.swipes)
                || typeof message.swipes[locator.swipeIndex] !== 'string'
                || message.swipes[locator.swipeIndex] !== change.originalText) {
                throw new Error(`Deep Clean Assistant Swipe changed after Freeze: ${locator.characterKey}/${locator.chatId}/${index}/${locator.swipeIndex}`);
            }
            actions.push(() => {
                message.swipes[locator.swipeIndex] = change.reviewedText;
                if (message.swipe_id === locator.swipeIndex) message.mes = change.reviewedText;
            });
            continue;
        }
        if (locator.branch !== 'main' || message.swipes !== undefined || message.mes !== change.originalText) {
            throw new Error(`Deep Clean Assistant main branch changed after Freeze: ${locator.characterKey}/${locator.chatId}/${index}`);
        }
        actions.push(() => { message.mes = change.reviewedText; });
    }
    actions.forEach((apply) => apply());
}

export async function applyBranchUnit(fetchImpl, context, characterKey, chatId, changes) {
    const liveBranch = currentBranchSnapshot(getSillyTavernContextSnapshot(), characterKey, chatId);
    const branch = liveBranch || await postJson(
        fetchImpl,
        context,
        '/api/chats/get',
        { avatar_url: characterKey, file_name: chatId },
        `Deep Clean Chat Branch read failed for ${characterKey}/${chatId}`,
    );
    validateChatHeader(branch, characterKey, chatId);
    const ordinary = changes.filter((change) => change.kind !== 'shujuku-cell');
    const shujuku = changes.filter((change) => change.kind === 'shujuku-cell');
    const v1Shujuku = shujuku.filter((change) => change.storageProtocol === 'v1');
    if (v1Shujuku.length > 0) {
        const validationBranch = cloneJson(branch);
        prepareOrdinaryChatChanges(validationBranch, ordinary);
        await applyCurrentShujukuV2CellChanges(
            validationBranch,
            shujuku.filter((change) => change.storageProtocol !== 'v1'),
        );

        const migrationBranch = cloneJson(branch);
        const migration = await prepareLateShujukuV1Migration(migrationBranch, v1Shujuku, {
            chatId,
            context,
        });
        const migrationResult = await postJson(
            fetchImpl,
            context,
            '/api/chats/save',
            { avatar_url: characterKey, file_name: chatId, chat: migrationBranch, force: false },
            `Deep Clean Shujuku V1 migration save failed for ${characterKey}/${chatId}`,
        );
        if (migrationResult?.ok !== true) {
            throw new Error(`Deep Clean Shujuku V1 migration save was not confirmed: ${characterKey}/${chatId}`);
        }
        if (liveBranch) {
            syncCurrentBranchLiveShujukuChanges(
                characterKey,
                chatId,
                migrationBranch,
                migration.changedMessageIndexes,
                { includeV1Cleanup: true },
            );
        }

        const migratedBranch = await postJson(
            fetchImpl,
            context,
            '/api/chats/get',
            { avatar_url: characterKey, file_name: chatId },
            `Deep Clean migrated Chat Branch reload failed for ${characterKey}/${chatId}`,
        );
        validateChatHeader(migratedBranch, characterKey, chatId);
        prepareOrdinaryChatChanges(migratedBranch, ordinary);
        const shujukuMessageIndexes = await applyCurrentShujukuV2CellChanges(migratedBranch, shujuku);
        const mutationResult = await postJson(
            fetchImpl,
            context,
            '/api/chats/save',
            { avatar_url: characterKey, file_name: chatId, chat: migratedBranch, force: false },
            `Deep Clean Chat Branch save failed for ${characterKey}/${chatId}`,
        );
        if (mutationResult?.ok !== true) {
            throw new Error(`Deep Clean Chat Branch save was not confirmed: ${characterKey}/${chatId}`);
        }
        if (liveBranch) syncCurrentBranchLiveChanges(characterKey, chatId, migratedBranch, ordinary, shujukuMessageIndexes);
        return;
    }
    prepareOrdinaryChatChanges(branch, ordinary);
    const shujukuMessageIndexes = await applyCurrentShujukuV2CellChanges(branch, shujuku);
    const result = await postJson(
        fetchImpl,
        context,
        '/api/chats/save',
        { avatar_url: characterKey, file_name: chatId, chat: branch, force: false },
        `Deep Clean Chat Branch save failed for ${characterKey}/${chatId}`,
    );
    if (result?.ok !== true) throw new Error(`Deep Clean Chat Branch save was not confirmed: ${characterKey}/${chatId}`);
    if (liveBranch) syncCurrentBranchLiveChanges(characterKey, chatId, branch, ordinary, shujukuMessageIndexes);
}
