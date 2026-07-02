const branchMetaKey = '__blai_diff_branch_meta';
const legacySwipeKey = '__blai_diff_swipe_key';
const branchMetaLimit = 8;

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
    if (Number.isInteger(index) && index >= 0 && index < msg.swipes.length) return index;

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
    if (!originalMes && !lastCleanedMes) return null;
    return {
        originalMes,
        lastCleanedMes,
        sourceSignature: typeof entry.sourceSignature === 'string' ? entry.sourceSignature : '',
        aiProgramMes: typeof entry.aiProgramMes === 'string' ? entry.aiProgramMes : '',
        aiFinalMes: typeof entry.aiFinalMes === 'string' ? entry.aiFinalMes : '',
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
        });
    }

    return null;
}

function pruneBranchMeta(container, keepBranchKey) {
    const keys = Object.keys(container);
    if (keys.length <= branchMetaLimit) return;
    const removable = keys.filter(key => key !== keepBranchKey);
    while (Object.keys(container).length > branchMetaLimit && removable.length > 0) {
        delete container[removable.shift()];
    }
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
        || previous.sourceSignature !== meta.sourceSignature) {
        container[normalizedBranchKey] = meta;
        changed = true;
    }
    pruneBranchMeta(container, normalizedBranchKey);

    changed = setValue(msg, '__blai_original_mes', meta.originalMes) || changed;
    changed = setValue(msg, '__blai_diff_source_signature', meta.sourceSignature) || changed;
    changed = setValue(msg, '__blai_diff_last_cleaned_mes', meta.lastCleanedMes) || changed;
    changed = setValue(msg, legacySwipeKey, normalizedBranchKey) || changed;
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
    if (previous.aiProgramMes !== nextProgramMes || previous.aiFinalMes !== nextFinalMes) {
        container[normalizedBranchKey] = {
            ...container[normalizedBranchKey],
            aiProgramMes: nextProgramMes,
            aiFinalMes: nextFinalMes,
            updatedAt: Date.now(),
        };
        changed = true;
    }

    const storedLegacyBranch = typeof msg[legacySwipeKey] === 'string' ? msg[legacySwipeKey] : 'main';
    if (!Array.isArray(msg.swipes) || storedLegacyBranch === normalizedBranchKey) {
        changed = setValue(msg, '__blai_diff_ai_program_mes', nextProgramMes) || changed;
        changed = setValue(msg, '__blai_diff_ai_final_mes', nextFinalMes) || changed;
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
        changed = deleteValue(msg, legacySwipeKey) || changed;
    }

    return changed;
}

export function getCurrentMessageOriginalMes(msg) {
    return getMessageDiffMeta(msg)?.originalMes || '';
}

export function isMessageFinalizedForCurrentBranch(msg) {
    const meta = getMessageDiffMeta(msg);
    return !!(meta && typeof msg?.mes === 'string' && meta.lastCleanedMes && msg.mes === meta.lastCleanedMes);
}
