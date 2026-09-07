/**
 * Owns Original -> optional AI -> Program for newly written message branches.
 * finalSource retains the last automatic stage; msg.mes owns later Manual edits.
 * Existing finalSource='ai'/'manual' entries retain their Program-before-AI order.
 */

import { getMessageDiffBranchKey } from '../chat/messageBranch.js';

const branchMetaKey = '__blai_diff_branch_meta';

function isObject(value) {
    return !!(value && typeof value === 'object');
}

function deleteValue(target, key) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) return false;
    delete target[key];
    return true;
}

function getBranchMetaContainer(msg, create = false) {
    if (!isObject(msg)) return null;
    if (!isObject(msg[branchMetaKey])) {
        if (!create) return null;
        msg[branchMetaKey] = {};
    }
    return msg[branchMetaKey];
}

function normalizeBranchMeta(entry) {
    if (!isObject(entry)
        || typeof entry.originalMes !== 'string'
        || typeof entry.programMes !== 'string') {
        return null;
    }
    const hasAiTrace = entry.hasAiTrace === true;
    const normalized = {
        originalMes: entry.originalMes,
        programMes: entry.programMes,
        aiMes: hasAiTrace && typeof entry.aiMes === 'string' ? entry.aiMes : '',
        hasAiTrace,
        finalSource: entry.finalSource === 'manual'
            ? 'manual'
            : (hasAiTrace && entry.finalSource === 'ai' ? 'ai' : 'program'),
    };
    return normalized;
}

export function getMessageDiffMeta(msg, branchKey = getMessageDiffBranchKey(msg)) {
    return normalizeBranchMeta(getBranchMetaContainer(msg)?.[branchKey]);
}

export function writeMessageDiffProgram(msg, branchKey, originalMes, programMes) {
    if (!isObject(msg)) return false;
    const normalizedBranchKey = branchKey || getMessageDiffBranchKey(msg);
    const nextMeta = {
        originalMes: String(originalMes ?? ''),
        programMes: String(programMes ?? ''),
        aiMes: '',
        hasAiTrace: false,
        finalSource: 'program',
    };
    const container = getBranchMetaContainer(msg, true);
    const previous = normalizeBranchMeta(container[normalizedBranchKey]);
    if (previous
        && previous.originalMes === nextMeta.originalMes
        && previous.programMes === nextMeta.programMes
        && previous.hasAiTrace === false
        && previous.finalSource === 'program') {
        return false;
    }
    container[normalizedBranchKey] = nextMeta;
    return true;
}

export function writeMessageDiffAiStage(msg, branchKey, originalMes, aiMes, programMes) {
    if (!isObject(msg)) return false;
    const normalizedBranchKey = branchKey || getMessageDiffBranchKey(msg);
    const container = getBranchMetaContainer(msg, true);
    const previous = normalizeBranchMeta(container[normalizedBranchKey]);
    const nextMeta = {
        originalMes: String(originalMes ?? ''),
        aiMes: String(aiMes ?? ''),
        programMes: String(programMes ?? ''),
        hasAiTrace: true,
        finalSource: 'program',
    };
    if (previous?.hasAiTrace
        && previous.originalMes === nextMeta.originalMes
        && previous.aiMes === nextMeta.aiMes
        && previous.programMes === nextMeta.programMes
        && previous.finalSource === 'program') return false;
    container[normalizedBranchKey] = nextMeta;
    return true;
}

/**
 * Manual text is already persisted in msg.mes. Leave automatic provenance intact;
 * return whether the edit has retained provenance whose presentation must refresh,
 * including edits that return exactly to the automatic result.
 */
export function writeMessageDiffManualFinal(msg, branchKey = getMessageDiffBranchKey(msg)) {
    return typeof msg?.mes === 'string' && getMessageDiffMeta(msg, branchKey) !== null;
}

export function clearMessageDiffMeta(msg, branchKey = getMessageDiffBranchKey(msg)) {
    if (!isObject(msg)) return false;
    const container = getBranchMetaContainer(msg);
    if (!container || !Object.prototype.hasOwnProperty.call(container, branchKey)) return false;
    delete container[branchKey];
    if (Object.keys(container).length === 0) delete msg[branchMetaKey];
    return true;
}

export function clearAllMessageDiffMeta(msg) {
    if (!isObject(msg)) return false;
    let changed = deleteValue(msg, branchMetaKey);
    for (const key of [
        '__blai_original_mes',
        '__blai_diff_source_signature',
        '__blai_diff_last_cleaned_mes',
        '__blai_diff_ai_program_mes',
        '__blai_diff_ai_final_mes',
        '__blai_diff_has_ai_trace',
        '__blai_diff_final_source',
        '__blai_diff_swipe_key',
    ]) {
        changed = deleteValue(msg, key) || changed;
    }
    return changed;
}

export function getCurrentMessageOriginalMes(msg) {
    return getMessageDiffMeta(msg)?.originalMes || '';
}

export function isMessageFinalizedForCurrentBranch(msg) {
    // A retained branch owns an automatic result; any later different text is Manual.
    return typeof msg?.mes === 'string' && getMessageDiffMeta(msg) !== null;
}

export function isMessageAiFinal(msg) {
    return isMessageAiFinalForBranch(msg, getMessageDiffBranchKey(msg), msg?.mes);
}

export function isMessageAiFinalForBranch(msg, branchKey, messageText) {
    const meta = getMessageDiffMeta(msg, branchKey);
    return !!(
        meta?.hasAiTrace
        && meta.finalSource !== 'manual'
        && msg?.__blai_is_reverted !== true
        && typeof messageText === 'string'
        && messageText === (meta.finalSource === 'ai' ? meta.aiMes : meta.programMes)
    );
}

export function isMessageManualFinal(msg) {
    const meta = getMessageDiffMeta(msg);
    if (!meta || typeof msg?.mes !== 'string') return false;
    if (meta.finalSource === 'manual') return true;
    return msg.mes !== (meta.finalSource === 'ai' ? meta.aiMes : meta.programMes);
}
