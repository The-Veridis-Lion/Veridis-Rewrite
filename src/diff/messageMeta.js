/** Owns one replaceable Original -> optional AI -> Program record per message branch. */
import { getMessageDiffBranchKey } from '../chat/messageBranch.js';
import { extensionName } from '../settings/defaults.js';

const branchMetaKey = '__blai_diff_branch_meta';

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCanonical(entry) {
    return isObject(entry)
        && typeof entry.originalMes === 'string'
        && (entry.aiMes === null || typeof entry.aiMes === 'string')
        && typeof entry.programMes === 'string'
        && typeof entry.reverted === 'boolean'
        && !Object.hasOwn(entry, 'hasAiTrace') && !Object.hasOwn(entry, 'finalSource');
}

export function getMessageDiffMeta(msg, branchKey = getMessageDiffBranchKey(msg)) {
    if (!branchKey) return null;
    const entry = msg?.[branchMetaKey]?.[branchKey];
    return isCanonical(entry) ? {
        originalMes: entry.originalMes,
        aiMes: entry.aiMes,
        programMes: entry.programMes,
        reverted: entry.reverted,
    } : null;
}

function writeBranchMeta(msg, branchKey, next) {
    if (!isObject(msg) || !branchKey) return false;
    if (!isCanonical(next)) throw new TypeError('Difference requires canonical stage texts and revert state');
    const previous = getMessageDiffMeta(msg, branchKey);
    if (previous && Object.keys(next).every(key => previous[key] === next[key])) return false;
    if (!isObject(msg[branchMetaKey])) msg[branchMetaKey] = {};
    msg[branchMetaKey][branchKey] = next;
    return true;
}

export function writeMessageDiffProgram(msg, branchKey, originalMes, programMes) {
    return writeBranchMeta(msg, branchKey, { originalMes, aiMes: null, programMes, reverted: false });
}

export function writeMessageDiffAiStage(msg, branchKey, originalMes, aiMes, programMes) {
    return writeBranchMeta(msg, branchKey, { originalMes, aiMes, programMes, reverted: false });
}

export function setMessageDiffReverted(msg, reverted, branchKey = getMessageDiffBranchKey(msg)) {
    const entry = getMessageDiffMeta(msg, branchKey);
    return entry ? writeBranchMeta(msg, branchKey, { ...entry, reverted }) : false;
}

export function isMessageDiffReverted(msg) {
    return getMessageDiffMeta(msg)?.reverted === true;
}

export function clearMessageDiffMeta(msg, branchKey = getMessageDiffBranchKey(msg)) {
    const container = msg?.[branchMetaKey];
    if (!isObject(container) || !Object.hasOwn(container, branchKey)) return false;
    delete container[branchKey];
    if (Object.keys(container).length === 0) delete msg[branchMetaKey];
    return true;
}

// Called by the existing host deletion listener after the host splices its Swipe arrays.
export function deleteMessageDiffSwipe(msg, deletedIndex) {
    const container = msg?.[branchMetaKey];
    if (!isObject(container) || !Number.isInteger(deletedIndex) || deletedIndex < 0) return false;
    const keys = Object.keys(container).filter(key => /^swipe:\d+$/.test(key))
        .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
    let changed = false;
    for (const key of keys) {
        const index = Number(key.slice(6));
        if (index < deletedIndex) continue;
        const entry = container[key];
        delete container[key];
        if (index > deletedIndex) container[`swipe:${index - 1}`] = entry;
        changed = true;
    }
    if (Object.keys(container).length === 0) delete msg[branchMetaKey];
    return changed;
}

/** Destructive one-time conversion at chat load; readers accept only canonical records. */
export function migrateChatDiffMetadata(chat, chatMetadata) {
    let changed = false;
    for (const msg of Array.isArray(chat) ? chat : []) {
        if (!isObject(msg)) continue;
        const container = msg[branchMetaKey];
        if (isObject(container)) {
            for (const [key, entry] of Object.entries(container)) {
                if (isCanonical(entry)) continue;
                const hasAi = entry?.hasAiTrace === true;
                const compatible = isObject(entry)
                    && (Object.hasOwn(entry, 'hasAiTrace') || Object.hasOwn(entry, 'finalSource'))
                    && typeof entry.originalMes === 'string' && typeof entry.programMes === 'string'
                    && (!hasAi || (entry.finalSource === 'program' && typeof entry.aiMes === 'string'));
                if (compatible) {
                    container[key] = {
                        originalMes: entry.originalMes,
                        aiMes: hasAi ? entry.aiMes : null,
                        programMes: entry.programMes,
                        reverted: false,
                    };
                } else delete container[key];
                changed = true;
            }
            // A message-wide marker cannot identify one of several Swipes.
            const soleBranch = msg.swipes === undefined ? 'main'
                : Array.isArray(msg.swipes) && msg.swipes.length === 1 ? 'swipe:0' : null;
            if (msg.__blai_is_reverted === true && soleBranch && isCanonical(container[soleBranch])) {
                container[soleBranch].reverted = true;
            }
            if (Object.keys(container).length === 0) {
                delete msg[branchMetaKey];
                changed = true;
            }
        }
        for (const key of [
            '__blai_is_reverted', '__blai_original_mes', '__blai_diff_source_signature',
            '__blai_diff_last_cleaned_mes', '__blai_diff_ai_program_mes', '__blai_diff_ai_final_mes',
            '__blai_diff_has_ai_trace', '__blai_diff_final_source', '__blai_diff_swipe_key',
        ]) {
            if (!Object.hasOwn(msg, key)) continue;
            delete msg[key];
            changed = true;
        }
    }
    const cacheKey = `${extensionName}_diff_state_v3`;
    if (isObject(chatMetadata) && Object.hasOwn(chatMetadata, cacheKey)) {
        delete chatMetadata[cacheKey];
        changed = true;
    }
    return changed;
}
