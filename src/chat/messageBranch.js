/**
 * Owns current Message/Swipe branch resolution and atomic message-branch mutation.
 * It does not own Diff metadata or persistence.
 */

function isObject(value) {
    return !!(value && typeof value === 'object');
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

export function clearMessageDisplayText(msg) {
    if (!isObject(msg) || !isObject(msg.extra)) return false;
    return deleteValue(msg.extra, 'display_text');
}
