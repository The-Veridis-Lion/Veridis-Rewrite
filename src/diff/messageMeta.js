/**
 * Owns the persisted Original -> Program -> optional AI stage chain for each
 * retained message branch. A Manual final uses the branch's current msg.mes.
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

function normalizeProgramProjection(value) {
    if (!Array.isArray(value)) return undefined;
    const projection = [];
    for (const tuple of value) {
        if (!Array.isArray(tuple)
            || tuple.length !== 3
            || !Number.isInteger(tuple[0])
            || !Number.isInteger(tuple[1])
            || !Number.isInteger(tuple[2])
            || tuple[0] < 0
            || tuple[1] < tuple[0]
            || tuple[2] < 0) {
            return undefined;
        }
        projection.push([...tuple]);
    }
    return projection;
}

function projectionsEqual(left, right) {
    if (left === undefined || right === undefined) return left === right;
    return left.length === right.length
        && left.every((tuple, index) => tuple.every((value, tupleIndex) => value === right[index][tupleIndex]));
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
    const programProjection = normalizeProgramProjection(entry.programProjection);
    if (programProjection !== undefined) normalized.programProjection = programProjection;
    return normalized;
}

export function getMessageDiffMeta(msg, branchKey = getMessageDiffBranchKey(msg)) {
    return normalizeBranchMeta(getBranchMetaContainer(msg)?.[branchKey]);
}

export function writeMessageDiffProgram(msg, branchKey, originalMes, programMes, programProjection) {
    if (!isObject(msg)) return false;
    const normalizedBranchKey = branchKey || getMessageDiffBranchKey(msg);
    const nextMeta = {
        originalMes: String(originalMes ?? ''),
        programMes: String(programMes ?? ''),
        aiMes: '',
        hasAiTrace: false,
        finalSource: 'program',
    };
    const normalizedProjection = normalizeProgramProjection(programProjection);
    if (normalizedProjection !== undefined) nextMeta.programProjection = normalizedProjection;
    const container = getBranchMetaContainer(msg, true);
    const previous = normalizeBranchMeta(container[normalizedBranchKey]);
    if (previous
        && previous.originalMes === nextMeta.originalMes
        && previous.programMes === nextMeta.programMes
        && projectionsEqual(previous.programProjection, nextMeta.programProjection)
        && previous.hasAiTrace === false
        && previous.finalSource === 'program') {
        return false;
    }
    container[normalizedBranchKey] = nextMeta;
    return true;
}

export function writeMessageDiffAiStage(msg, branchKey, aiMes) {
    if (!isObject(msg)) return false;
    const normalizedBranchKey = branchKey || getMessageDiffBranchKey(msg);
    const container = getBranchMetaContainer(msg);
    const previous = normalizeBranchMeta(container?.[normalizedBranchKey]);
    if (!previous) return false;

    const nextAiMes = String(aiMes ?? '');
    if (previous.hasAiTrace
        && previous.aiMes === nextAiMes
        && previous.finalSource === 'ai') {
        return false;
    }
    container[normalizedBranchKey] = {
        ...previous,
        aiMes: nextAiMes,
        hasAiTrace: true,
        finalSource: 'ai',
    };
    return true;
}

/**
 * Marks the current branch text as Manual while retaining the already-owned
 * Original, Program, and optional accepted AI stages.
 */
export function writeMessageDiffManualFinal(msg, branchKey = getMessageDiffBranchKey(msg)) {
    if (!isObject(msg) || typeof msg.mes !== 'string') return false;
    const normalizedBranchKey = branchKey || getMessageDiffBranchKey(msg);
    const container = getBranchMetaContainer(msg);
    const previous = normalizeBranchMeta(container?.[normalizedBranchKey]);
    if (!previous) return false;
    if (previous.finalSource === 'program' && msg.mes === previous.programMes) return false;
    if (previous.finalSource === 'ai' && msg.mes === previous.aiMes) return false;
    if (previous.finalSource === 'manual') return true;
    container[normalizedBranchKey] = {
        ...previous,
        finalSource: 'manual',
    };
    return true;
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
    const meta = getMessageDiffMeta(msg);
    if (!meta || typeof msg?.mes !== 'string') return false;
    if (meta.finalSource === 'manual') return true;
    if (meta.finalSource === 'ai') return msg.mes === meta.aiMes;
    return msg.mes === meta.programMes;
}

export function isMessageAiFinal(msg) {
    return isMessageAiFinalForBranch(msg, getMessageDiffBranchKey(msg), msg?.mes);
}

export function isMessageAiFinalForBranch(msg, branchKey, messageText) {
    const meta = getMessageDiffMeta(msg, branchKey);
    return !!(
        meta?.hasAiTrace
        && meta.finalSource === 'ai'
        && msg?.__blai_is_reverted !== true
        && typeof messageText === 'string'
        && messageText === meta.aiMes
    );
}

export function isMessageManualFinal(msg) {
    return getMessageDiffMeta(msg)?.finalSource === 'manual';
}
