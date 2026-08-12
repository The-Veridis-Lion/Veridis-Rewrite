const branchMetaKey = '__blai_diff_branch_meta';
const legacySwipeKey = '__blai_diff_swipe_key';
const legacyFinalSourceKey = '__blai_diff_final_source';
const legacyHasAiTraceKey = '__blai_diff_has_ai_trace';

function isObject(value) {
    return !!(value && typeof value === 'object');
}

function setValue(target, key, value) {
    if (target[key] === value) return false;
    target[key] = value;
    return true;
}

function deleteValue(target, key) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) return false;
    delete target[key];
    return true;
}

export function getMessageSwipeIndex(msg) {
    if (!isObject(msg) || !Array.isArray(msg.swipes)) return -1;
    const raw = msg.swipe_id ?? msg.swipeId;
    const index = Number(raw);
    if (Number.isInteger(index)) {
        if (index < 0 || index >= msg.swipes.length) return -1;
        const swipe = msg.swipes[index];
        return typeof swipe === 'string' || (isObject(swipe) && typeof swipe.mes === 'string')
            ? index
            : -1;
    }

    const currentMes = typeof msg.mes === 'string' ? msg.mes : '';
    if (!currentMes) return -1;
    return msg.swipes.findIndex((swipe) => {
        if (typeof swipe === 'string') return swipe === currentMes;
        return isObject(swipe) && swipe.mes === currentMes;
    });
}

export function getMessageDiffBranchKey(msg) {
    const swipeIndex = getMessageSwipeIndex(msg);
    return swipeIndex >= 0 ? `swipe:${swipeIndex}` : 'main';
}

export function setCurrentSwipeText(msg, text) {
    const swipeIndex = getMessageSwipeIndex(msg);
    if (swipeIndex < 0) return false;

    const nextText = String(text ?? '');
    const currentSwipe = msg.swipes[swipeIndex];
    if (typeof currentSwipe === 'string') {
        if (currentSwipe === nextText) return false;
        msg.swipes[swipeIndex] = nextText;
        return true;
    }

    if (isObject(currentSwipe) && typeof currentSwipe.mes === 'string') {
        if (currentSwipe.mes === nextText) return false;
        currentSwipe.mes = nextText;
        return true;
    }

    return false;
}

export function syncCurrentSwipeExtra(msg) {
    const swipeIndex = getMessageSwipeIndex(msg);
    if (swipeIndex < 0 || !Array.isArray(msg?.swipe_info)) return false;

    const swipeInfo = msg.swipe_info[swipeIndex];
    if (!isObject(swipeInfo)) return false;

    swipeInfo.extra = structuredClone(isObject(msg.extra) ? msg.extra : {});
    return true;
}

/**
 * 原子写入当前消息正文和当前已落槽的 swipe。
 * 只要消息声明了 swipes，当前槽就必须真实存在；否则不修改任何数据。
 */
export function commitCurrentMessageText(msg, text, expectedBranchKey = '') {
    if (!isObject(msg) || typeof msg.mes !== 'string') {
        return { ok: false, changed: false, reason: 'message-text-missing', branchKey: 'main' };
    }

    const branchKey = getMessageDiffBranchKey(msg);
    if (expectedBranchKey && branchKey !== expectedBranchKey) {
        return { ok: false, changed: false, reason: 'message-branch-changed', branchKey };
    }

    const nextText = String(text ?? '');
    if (Array.isArray(msg.swipes)) {
        const swipeIndex = getMessageSwipeIndex(msg);
        if (swipeIndex < 0) {
            return { ok: false, changed: false, reason: 'swipe-slot-not-materialized', branchKey };
        }

        const swipe = msg.swipes[swipeIndex];
        const currentSwipeText = typeof swipe === 'string' ? swipe : swipe.mes;
        const changed = msg.mes !== nextText || currentSwipeText !== nextText;
        msg.mes = nextText;
        if (typeof swipe === 'string') msg.swipes[swipeIndex] = nextText;
        else swipe.mes = nextText;
        return { ok: true, changed, reason: '', branchKey: `swipe:${swipeIndex}`, swipeIndex };
    }

    const changed = msg.mes !== nextText;
    msg.mes = nextText;
    return { ok: true, changed, reason: '', branchKey: 'main', swipeIndex: -1 };
}

export function setMessageTextForMvuTransaction(msg, text) {
    if (!isObject(msg) || typeof msg.mes !== 'string') return false;
    const nextText = String(text ?? '');
    if (msg.mes === nextText) return false;
    msg.mes = nextText;
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
    if (!isObject(entry)) return null;
    const originalMes = typeof entry.originalMes === 'string' ? entry.originalMes : '';
    const lastCleanedMes = typeof entry.lastCleanedMes === 'string' ? entry.lastCleanedMes : '';
    const aiProgramMes = typeof entry.aiProgramMes === 'string' ? entry.aiProgramMes : '';
    const aiFinalMes = typeof entry.aiFinalMes === 'string' ? entry.aiFinalMes : '';
    if (!originalMes && !lastCleanedMes) return null;
    return {
        originalMes,
        lastCleanedMes,
        sourceSignature: typeof entry.sourceSignature === 'string' ? entry.sourceSignature : '',
        aiProgramMes,
        aiFinalMes,
        hasAiTrace: entry.hasAiTrace === true || !!(aiProgramMes || aiFinalMes),
        finalSource: entry.finalSource === 'manual'
            ? 'manual'
            : (entry.finalSource === 'ai' ? 'ai' : ''),
        updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : Date.now(),
    };
}

export function getMessageDiffMeta(msg, branchKey = getMessageDiffBranchKey(msg)) {
    const container = getBranchMetaContainer(msg);
    const branchMeta = normalizeBranchMeta(container?.[branchKey]);
    if (branchMeta) return branchMeta;

    const hasSwipes = Array.isArray(msg?.swipes);
    const storedLegacyBranch = typeof msg?.[legacySwipeKey] === 'string' ? msg[legacySwipeKey] : 'main';
    const canUseLegacy = !hasSwipes || storedLegacyBranch === branchKey;
    if (!canUseLegacy) return null;

    if (typeof msg?.__blai_original_mes === 'string' || typeof msg?.__blai_diff_last_cleaned_mes === 'string') {
        return normalizeBranchMeta({
            originalMes: msg.__blai_original_mes,
            lastCleanedMes: msg.__blai_diff_last_cleaned_mes,
            sourceSignature: msg.__blai_diff_source_signature,
            aiProgramMes: msg.__blai_diff_ai_program_mes,
            aiFinalMes: msg.__blai_diff_ai_final_mes,
            hasAiTrace: msg[legacyHasAiTraceKey],
            finalSource: msg[legacyFinalSourceKey],
        });
    }

    return null;
}

export function writeMessageDiffMeta(msg, branchKey, sourceMes, cleanedMes, signature) {
    if (!isObject(msg)) return false;
    const normalizedBranchKey = branchKey || getMessageDiffBranchKey(msg);
    const meta = {
        originalMes: String(sourceMes ?? ''),
        lastCleanedMes: String(cleanedMes ?? ''),
        sourceSignature: String(signature ?? ''),
        updatedAt: Date.now(),
    };

    let changed = false;
    const container = getBranchMetaContainer(msg, true);
    const previous = normalizeBranchMeta(container[normalizedBranchKey]);
    if (!previous
        || previous.originalMes !== meta.originalMes
        || previous.lastCleanedMes !== meta.lastCleanedMes
        || previous.sourceSignature !== meta.sourceSignature
        || previous.aiProgramMes
        || previous.aiFinalMes
        || previous.hasAiTrace
        || previous.finalSource) {
        container[normalizedBranchKey] = meta;
        changed = true;
    }
    changed = setValue(msg, '__blai_original_mes', meta.originalMes) || changed;
    changed = setValue(msg, '__blai_diff_source_signature', meta.sourceSignature) || changed;
    changed = setValue(msg, '__blai_diff_last_cleaned_mes', meta.lastCleanedMes) || changed;
    changed = setValue(msg, legacySwipeKey, normalizedBranchKey) || changed;
    changed = deleteValue(msg, '__blai_diff_ai_program_mes') || changed;
    changed = deleteValue(msg, '__blai_diff_ai_final_mes') || changed;
    changed = deleteValue(msg, legacyHasAiTraceKey) || changed;
    changed = deleteValue(msg, legacyFinalSourceKey) || changed;
    return changed;
}

export function writeMessageDiffAiTrace(msg, branchKey, programMes, finalMes) {
    if (!isObject(msg)) return false;
    const normalizedBranchKey = branchKey || getMessageDiffBranchKey(msg);
    const container = getBranchMetaContainer(msg, true);
    const previous = normalizeBranchMeta(container[normalizedBranchKey]);
    if (!previous) return false;

    const nextProgramMes = String(programMes ?? '');
    const nextFinalMes = String(finalMes ?? '');
    let changed = false;
    if (previous.aiProgramMes !== nextProgramMes
        || previous.aiFinalMes !== nextFinalMes
        || previous.hasAiTrace !== true
        || previous.finalSource) {
        container[normalizedBranchKey] = {
            ...container[normalizedBranchKey],
            aiProgramMes: nextProgramMes,
            aiFinalMes: nextFinalMes,
            hasAiTrace: true,
            finalSource: 'ai',
            updatedAt: Date.now(),
        };
        changed = true;
    }

    const storedLegacyBranch = typeof msg[legacySwipeKey] === 'string' ? msg[legacySwipeKey] : 'main';
    if (!Array.isArray(msg.swipes) || storedLegacyBranch === normalizedBranchKey) {
        changed = setValue(msg, '__blai_diff_ai_program_mes', nextProgramMes) || changed;
        changed = setValue(msg, '__blai_diff_ai_final_mes', nextFinalMes) || changed;
        changed = setValue(msg, legacyHasAiTraceKey, true) || changed;
        changed = deleteValue(msg, legacyFinalSourceKey) || changed;
    }
    return changed;
}

/**
 * 将当前正文登记为用户手动最终稿，同时保留原文、程序稿与 AI 稿作为只读对比阶段。
 * 手动最终稿直接使用 msg.mes，不额外持久化第四份正文。
 */
export function writeMessageDiffManualFinal(msg, branchKey = getMessageDiffBranchKey(msg)) {
    if (!isObject(msg) || typeof msg.mes !== 'string') return false;
    const normalizedBranchKey = branchKey || getMessageDiffBranchKey(msg);
    const previous = getMessageDiffMeta(msg, normalizedBranchKey);
    if (previous?.finalSource === 'manual' && previous.lastCleanedMes === msg.mes) return false;

    const nextProgramMes = previous
        ? (previous.hasAiTrace ? previous.aiProgramMes : previous.lastCleanedMes)
        : '';
    const nextMeta = {
        originalMes: previous?.originalMes || msg.mes,
        lastCleanedMes: msg.mes,
        sourceSignature: previous?.sourceSignature || '',
        aiProgramMes: nextProgramMes,
        aiFinalMes: previous?.aiFinalMes || '',
        hasAiTrace: previous?.hasAiTrace === true,
        finalSource: 'manual',
        updatedAt: Date.now(),
    };

    let changed = false;
    const container = getBranchMetaContainer(msg, true);
    container[normalizedBranchKey] = nextMeta;
    changed = true;

    const storedLegacyBranch = typeof msg[legacySwipeKey] === 'string' ? msg[legacySwipeKey] : 'main';
    if (!Array.isArray(msg.swipes) || storedLegacyBranch === normalizedBranchKey) {
        changed = setValue(msg, '__blai_original_mes', nextMeta.originalMes) || changed;
        changed = setValue(msg, '__blai_diff_source_signature', nextMeta.sourceSignature) || changed;
        changed = setValue(msg, '__blai_diff_last_cleaned_mes', nextMeta.lastCleanedMes) || changed;
        changed = setValue(msg, '__blai_diff_ai_program_mes', nextMeta.aiProgramMes) || changed;
        if (nextMeta.aiFinalMes) changed = setValue(msg, '__blai_diff_ai_final_mes', nextMeta.aiFinalMes) || changed;
        else changed = deleteValue(msg, '__blai_diff_ai_final_mes') || changed;
        if (nextMeta.hasAiTrace) changed = setValue(msg, legacyHasAiTraceKey, true) || changed;
        else changed = deleteValue(msg, legacyHasAiTraceKey) || changed;
        changed = setValue(msg, legacyFinalSourceKey, 'manual') || changed;
        changed = setValue(msg, legacySwipeKey, normalizedBranchKey) || changed;
    }
    return changed;
}

export function clearMessageDiffMeta(msg, branchKey = getMessageDiffBranchKey(msg)) {
    if (!isObject(msg)) return false;
    let changed = false;
    const container = getBranchMetaContainer(msg);
    if (container && Object.prototype.hasOwnProperty.call(container, branchKey)) {
        delete container[branchKey];
        changed = true;
        if (Object.keys(container).length === 0) changed = deleteValue(msg, branchMetaKey) || changed;
    }

    const storedLegacyBranch = typeof msg[legacySwipeKey] === 'string' ? msg[legacySwipeKey] : 'main';
    if (!Array.isArray(msg.swipes) || storedLegacyBranch === branchKey) {
        changed = deleteValue(msg, '__blai_original_mes') || changed;
        changed = deleteValue(msg, '__blai_diff_source_signature') || changed;
        changed = deleteValue(msg, '__blai_diff_last_cleaned_mes') || changed;
        changed = deleteValue(msg, '__blai_diff_ai_program_mes') || changed;
        changed = deleteValue(msg, '__blai_diff_ai_final_mes') || changed;
        changed = deleteValue(msg, legacyHasAiTraceKey) || changed;
        changed = deleteValue(msg, legacyFinalSourceKey) || changed;
        changed = deleteValue(msg, legacySwipeKey) || changed;
    }

    return changed;
}

export function clearAllMessageDiffMeta(msg) {
    if (!isObject(msg)) return false;
    let changed = deleteValue(msg, branchMetaKey);
    changed = deleteValue(msg, '__blai_original_mes') || changed;
    changed = deleteValue(msg, '__blai_diff_source_signature') || changed;
    changed = deleteValue(msg, '__blai_diff_last_cleaned_mes') || changed;
    changed = deleteValue(msg, '__blai_diff_ai_program_mes') || changed;
    changed = deleteValue(msg, '__blai_diff_ai_final_mes') || changed;
    changed = deleteValue(msg, legacyHasAiTraceKey) || changed;
    changed = deleteValue(msg, legacyFinalSourceKey) || changed;
    changed = deleteValue(msg, legacySwipeKey) || changed;
    return changed;
}

export function getCurrentMessageOriginalMes(msg) {
    return getMessageDiffMeta(msg)?.originalMes || '';
}

export function isMessageFinalizedForCurrentBranch(msg) {
    const meta = getMessageDiffMeta(msg);
    return !!(meta && typeof msg?.mes === 'string' && meta.lastCleanedMes && msg.mes === meta.lastCleanedMes);
}

export function clearMessageDisplayText(msg) {
    if (!isObject(msg) || !isObject(msg.extra)) return false;
    return deleteValue(msg.extra, 'display_text');
}

export function getMessageAiFinalMes(msg) {
    const meta = getMessageDiffMeta(msg);
    if (!meta?.hasAiTrace || !meta.aiFinalMes) return '';
    return meta.aiFinalMes;
}

export function isMessageAiFinal(msg) {
    return isMessageAiFinalForBranch(msg, getMessageDiffBranchKey(msg), msg?.mes);
}

export function isMessageAiFinalForBranch(msg, branchKey, messageText) {
    const meta = getMessageDiffMeta(msg, branchKey);
    const aiFinalMes = meta?.hasAiTrace && meta.aiFinalMes ? meta.aiFinalMes : '';
    return !!(
        aiFinalMes
        && msg?.__blai_is_reverted !== true
        && typeof messageText === 'string'
        && messageText === aiFinalMes
    );
}

/**
 * Restore an AI final that was persisted in message metadata but replaced in
 * the live message by an older cleanse/render path. Arbitrary user edits are
 * left untouched; only known intermediate versions are recoverable here.
 */
export function restoreMessageAiFinal(msg) {
    if (!isObject(msg) || msg.__blai_is_reverted === true || typeof msg.mes !== 'string') return false;

    const meta = getMessageDiffMeta(msg);
    const aiFinalMes = meta?.hasAiTrace && meta.aiFinalMes ? meta.aiFinalMes : '';
    if (!aiFinalMes) return false;

    const displayTextChanged = clearMessageDisplayText(msg);
    if (meta.finalSource === 'manual') return displayTextChanged;
    if (msg.mes === aiFinalMes) return displayTextChanged;

    const recoverableTexts = new Set([
        meta.originalMes,
        meta.lastCleanedMes,
        meta.aiProgramMes,
    ].filter(Boolean));
    if (!recoverableTexts.has(msg.mes)) return displayTextChanged;

    const commit = commitCurrentMessageText(msg, aiFinalMes, getMessageDiffBranchKey(msg));
    return displayTextChanged || (commit.ok && commit.changed);
}

export function isMessageManualFinal(msg) {
    const meta = getMessageDiffMeta(msg);
    return !!(meta
        && meta.finalSource === 'manual'
        && typeof msg?.mes === 'string'
        && msg.mes === meta.lastCleanedMes);
}
