import { diffMetadataKey, extensionName, getAppContext, getDiffTrackedMessageLimit, runtimeState } from './state.js';
import { logger } from './log.js';
import { applyScopedReplacements, queueIncrementalChatSave } from './core.js';
import { getMessageDomNode, resolveMessageIndexFromDomNode, isTrackableMessageDomNode } from './dom.js';
import { getMessageDiffBranchKey, getMessageDiffMeta } from './messageMeta.js';

/**
 * 将原始文本进行 HTML 转义，避免差异片段注入标签。
 * @param {string} [value=''] 需要转义的文本。
 * @returns {string} 已转义的安全 HTML 文本。
 */
export function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function hashString(value = '') {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return `h${(hash >>> 0).toString(16)}`;
}

const inlineDiffCellLimit = 1600000;
const lineDiffCellLimit = 200000;
const snippetWindowCharLimit = 900;
const snippetJoinEqualChars = 96;
const maxDiffSnippetCount = 16;
const diffRenderVersion = 5;

function getDiffRulesSignature() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings?.[extensionName] || {};
    try {
        return hashString(JSON.stringify({
            rules: settings.rules || [],
            scopeTags: settings.scopeTags || [],
            scopeTagBuiltinDismissed: settings.scopeTagBuiltinDismissed || [],
            scopeTagMode: settings.scopeTagMode || 'protect',
            diffRenderVersion,
        }));
    } catch (err) {
        logger.warn('规则签名计算失败，使用固定兜底', err);
        return 'rules-unavailable';
    }
}

export function isTrackableDiffMessage(msg) {
    return !!(msg && typeof msg === 'object' && msg.is_user !== true);
}

export function isAssistantMessage(msg) {
    return isTrackableDiffMessage(msg);
}

export function computeMessageSignature(msg) {
    if (!msg || typeof msg !== 'object') return '';
    const base = typeof msg.mes === 'string' ? msg.mes : '';
    const name = typeof msg.name === 'string' ? msg.name : '';
    const branchKey = getMessageDiffBranchKey(msg);
    const diffMeta = getMessageDiffMeta(msg, branchKey);
    const sourceMes = (diffMeta?.lastCleanedMes && base === diffMeta.lastCleanedMes)
        ? diffMeta.originalMes
        : base;

    return hashString(`${name}
${branchKey}
${sourceMes}
${getDiffRulesSignature()}`);
}

export function getLatestAssistantMessageIndices(chat, limit = getDiffTrackedMessageLimit()) {
    if (!Array.isArray(chat) || limit <= 0) return [];
    const picked = [];
    for (let i = chat.length - 1; i >= 0 && picked.length < limit; i--) {
        if (isTrackableDiffMessage(chat[i])) picked.push(i);
    }
    return picked.reverse();
}

export function getLatestTrackableDiffIndices(limit = getDiffTrackedMessageLimit()) {
    const { chat } = getAppContext();
    return getLatestAssistantMessageIndices(chat, limit);
}

export function captureDiffRawSource(index) {
    const { chat } = getAppContext();
    if (!Number.isInteger(index) || index < 0 || !Array.isArray(chat)) return false;

    const msg = chat[index];
    if (!isAssistantMessage(msg)) return false;

    const rawMes = typeof msg.mes === 'string' ? msg.mes : '';
    if (!rawMes) return false;

    const branchKey = getMessageDiffBranchKey(msg);
    const existing = runtimeState.diffRawSourceCache.get(index);
    if (existing?.branchKey === branchKey) return true;

    runtimeState.diffRawSourceCache.set(index, {
        branchKey,
        mes: rawMes,
        signature: computeMessageSignature(msg),
    });
    return true;
}

function sanitizeCacheEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    return {
        snippets: Array.isArray(entry.snippets) ? entry.snippets.filter(v => typeof v === 'string') : [],
        fullDiff: typeof entry.fullDiff === 'string' ? entry.fullDiff : '',
        signature: typeof entry.signature === 'string' ? entry.signature : '',
    };
}

function sanitizeStateEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const status = entry.status === 'pending' ? 'pending' : 'ready';
    return {
        status,
        signature: typeof entry.signature === 'string' ? entry.signature : '',
        updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : Date.now(),
    };
}

function notifyDiffStateChanged(reason = 'state', index = runtimeState.currentDiffIndex) {
    if (typeof runtimeState.diffModalRefresh === 'function') {
        try {
            runtimeState.diffModalRefresh(index, { reason, changedIndex: index });
        } catch (err) {
            logger.warn(`刷新对比弹窗失败`, err);
        }
    }
}

export function persistTrackedDiffState() {
    const { chat_metadata } = getAppContext();
    if (!chat_metadata || typeof chat_metadata !== 'object') return;

    const order = runtimeState.trackedDiffMessageOrder
        .filter(index => Number.isInteger(index) && index >= 0)
        .slice(-getDiffTrackedMessageLimit());

    if (order.length === 0) {
        delete chat_metadata[diffMetadataKey];
        queueIncrementalChatSave();
        return;
    }

    const entries = {};
    for (const index of order) {
        const state = sanitizeStateEntry(runtimeState.diffMessageStates.get(index));
        if (!state) continue;
        entries[String(index)] = {
            status: state.status,
            signature: state.signature || '',
            updatedAt: state.updatedAt,
        };
    }

    chat_metadata[diffMetadataKey] = { version: 2, order, entries };
    queueIncrementalChatSave();
}

export function resetDiffRuntimeState() {
    logger.debug('重置差异运行时状态');
    runtimeState.diffSnippetsCache.clear();
    runtimeState.diffRawSourceCache.clear();
    runtimeState.nonStreamingRawMessageCache.clear();
    runtimeState.diffMessageStates.clear();
    runtimeState.trackedDiffMessageOrder = [];
    runtimeState.currentDiffIndex = undefined;
}

export function restoreDiffStateFromChatMetadata() {
    const { chat, chat_metadata } = getAppContext();
    resetDiffRuntimeState();

    const saved = chat_metadata?.[diffMetadataKey];
    if (!saved || typeof saved !== 'object') return;
    let needsMetadataRewrite = saved.version !== 2;

    const validLatest = new Set(getLatestAssistantMessageIndices(chat));
    const rawOrder = Array.isArray(saved.order) ? saved.order : [];
    const restoredOrder = rawOrder
        .map(v => Number(v))
        .filter(index => Number.isInteger(index) && index >= 0 && validLatest.has(index))
        .slice(-getDiffTrackedMessageLimit());

    for (const index of restoredOrder) {
        const rawEntry = saved.entries?.[String(index)] || saved.entries?.[index];
        if (rawEntry && (Array.isArray(rawEntry.snippets) || typeof rawEntry.fullDiff === 'string')) {
            needsMetadataRewrite = true;
        }
        const entry = sanitizeStateEntry(rawEntry);
        if (!entry) continue;
        runtimeState.diffMessageStates.set(index, entry);
        runtimeState.diffSnippetsCache.set(index, { snippets: [], fullDiff: '', signature: entry.signature || '' });
    }

    runtimeState.trackedDiffMessageOrder = restoredOrder;
    if (needsMetadataRewrite) persistTrackedDiffState();
    logger.debug(`从 chat_metadata 恢复差异状态: 还原了 ${restoredOrder.length} 条记录`);
}

function removeTrackedIndex(index) {
    runtimeState.trackedDiffMessageOrder = runtimeState.trackedDiffMessageOrder.filter(v => v !== index);
}

function pushTrackedIndex(index) {
    removeTrackedIndex(index);
    runtimeState.trackedDiffMessageOrder.push(index);
    while (runtimeState.trackedDiffMessageOrder.length > getDiffTrackedMessageLimit()) {
        const evicted = runtimeState.trackedDiffMessageOrder.shift();
        runtimeState.diffMessageStates.delete(evicted);
        runtimeState.diffSnippetsCache.delete(evicted);
        const oldNode = getMessageDomNode(evicted);
        if (oldNode) ensureMessageDiffButton(evicted, oldNode);
    }
}

export function syncTrackedIndicesToLatestAssistantMessages() {
    const latestIndices = getLatestTrackableDiffIndices();
    const latestSet = new Set(latestIndices);

    for (const index of [...runtimeState.diffMessageStates.keys()]) {
        if (!latestSet.has(index)) runtimeState.diffMessageStates.delete(index);
    }

    for (const index of [...runtimeState.diffSnippetsCache.keys()]) {
        if (!latestSet.has(index)) runtimeState.diffSnippetsCache.delete(index);
    }

    runtimeState.trackedDiffMessageOrder = latestIndices;
}

export function isTrackedDiffMessage(index) {
    return runtimeState.trackedDiffMessageOrder.includes(index);
}

export function hasRealDiffCache(index) {
    const cached = runtimeState.diffSnippetsCache.get(index);
    if (!cached || typeof cached !== 'object') return false;

    const hasSnippets = hasRenderedSnippetDiff(cached.snippets);
    const hasFullModified = typeof cached.fullDiff === 'string'
        && cached.fullDiff.includes('blai-diff-full-modified');

    return hasSnippets || hasFullModified;
}

export function getCachedDiffEntry(index) {
    return runtimeState.diffSnippetsCache.get(index) || null;
}

export function markDiffComparisonPending(index, signature = '', options = {}) {
    const { chat } = getAppContext();
    if (!Number.isInteger(index) || index < 0 || !Array.isArray(chat) || !isAssistantMessage(chat[index])) return false;

    const existingState = runtimeState.diffMessageStates.get(index);
    const existingCache = runtimeState.diffSnippetsCache.get(index);
    const normalizedSignature = signature || computeMessageSignature(chat[index]);
    const shouldReplace = !existingState || existingState.signature !== normalizedSignature || !isTrackedDiffMessage(index);

    if (!shouldReplace) return false;

    pushTrackedIndex(index);
    runtimeState.diffSnippetsCache.delete(index);
    runtimeState.diffMessageStates.set(index, {
        status: 'pending',
        signature: normalizedSignature,
        updatedAt: Date.now(),
    });

    if (options.skipPersist !== true) {
        if (existingCache || !existingState || existingState.status !== 'pending') {
            persistTrackedDiffState();
            injectDiffButtons([index]);
            notifyDiffStateChanged('pending', index);
            logger.debug(`标记差异待比较: index=${index}, signature=${normalizedSignature}`);
        }
    }
    return true;
}

export function writeReadyDiffCache(index, signature, cacheData = {}, options = {}) {
    if (!Number.isInteger(index) || index < 0) return false;
    const { chat } = getAppContext();
    if (!Array.isArray(chat) || !isAssistantMessage(chat[index])) return false;

    const nextSnippets = Array.isArray(cacheData?.snippets) ? cacheData.snippets : [];
    const nextFullDiff = typeof cacheData?.fullDiff === 'string' ? cacheData.fullDiff : '';
    const nextHasRealDiff = nextSnippets.length > 0 || nextFullDiff.includes('blai-diff-full-modified');

    const existing = runtimeState.diffSnippetsCache.get(index);
    const existingHasRealDiff = hasRealDiffCache(index);

    if (options.preserveExistingRealDiff === true && existingHasRealDiff && !nextHasRealDiff && existing?.signature === signature) {
        runtimeState.diffMessageStates.set(index, {
            status: 'ready',
            signature: signature || existing?.signature || '',
            updatedAt: Date.now(),
        });
        pushTrackedIndex(index);
        if (options.persist !== false) persistTrackedDiffState();
        notifyDiffStateChanged('cache-preserved', index);
        return true;
    }

    pushTrackedIndex(index);
    runtimeState.diffSnippetsCache.set(index, {
        snippets: nextSnippets,
        fullDiff: nextFullDiff,
        signature: signature || '',
    });
    runtimeState.diffMessageStates.set(index, {
        status: 'ready',
        signature: signature || '',
        updatedAt: Date.now(),
    });

    if (options.persist !== false) persistTrackedDiffState();
    notifyDiffStateChanged('cache-written', index);
    logger.debug(`写入差异缓存: index=${index}, signature=${signature || ''}`);
    return true;
}

export function primeLatestDiffButtons() {
    const { chat } = getAppContext();
    if (!Array.isArray(chat)) return;

    const latestIndices = getLatestTrackableDiffIndices();
    runtimeState.trackedDiffMessageOrder = latestIndices;

    for (const index of latestIndices) {
        const msg = chat[index];
        if (!isAssistantMessage(msg)) continue;

        const signature = computeMessageSignature(msg);

        if (!runtimeState.diffMessageStates.has(index)) {
            runtimeState.diffMessageStates.set(index, {
                status: 'ready',
                signature,
                updatedAt: Date.now(),
            });
        }

        if (!runtimeState.diffSnippetsCache.has(index)) {
            runtimeState.diffSnippetsCache.set(index, {
                snippets: [],
                fullDiff: '',
                signature,
            });
        }
    }

    persistTrackedDiffState();
    injectDiffButtons();
}

export function clearTrackedDiffEntry(index, options = {}) {
    const hadState = runtimeState.diffMessageStates.delete(index);
    const hadCache = runtimeState.diffSnippetsCache.delete(index);
    runtimeState.diffRawSourceCache.delete(index);
    removeTrackedIndex(index);

    if (hadState || hadCache) {
        if (options.persist !== false) persistTrackedDiffState();
        injectDiffButtons([index]);
        notifyDiffStateChanged('cleared', index);
    }
}

export function getDiffStateForMessage(index) {
    const state = runtimeState.diffMessageStates.get(index);
    if (!state || typeof state !== 'object') return { status: 'pending', signature: '' };
    return {
        status: state.status === 'ready' ? 'ready' : 'pending',
        signature: typeof state.signature === 'string' ? state.signature : '',
    };
}

/**
 * 生成两段文本的行内差异 HTML。
 * 先整体对齐文本，再对中间片段做 LCS 回溯，避免换行变化导致逐行错位。
 * @param {string} oldStr 原始文本。
 * @param {string} newStr 净化后文本。
 * @returns {string} 包含 <ins>/<del> 标记的差异 HTML。
 */
export function getInlineDiff(oldStr, newStr) {
    return renderDiffOperations(getTextDiffOperations(oldStr, newStr));
}

function isDiffMatrixSafe(leftLength, rightLength, limit) {
    if (leftLength === 0 || rightLength === 0) return true;
    return leftLength <= Math.floor(limit / rightLength);
}

function pushDiffOperation(operations, type, text = '') {
    if (!text) return;
    const last = operations[operations.length - 1];
    if (last && last.type === type) last.text += text;
    else operations.push({ type, text });
}

function buildCharDiffOperations(oldChars, newChars) {
    const m = oldChars.length;
    const n = newChars.length;
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldChars[i - 1] === newChars[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    let i = m;
    let j = n;
    const reversed = [];
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldChars[i - 1] === newChars[j - 1]) {
            reversed.push({ type: 'equal', text: oldChars[i - 1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            reversed.push({ type: 'insert', text: newChars[j - 1] });
            j--;
        } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
            reversed.push({ type: 'delete', text: oldChars[i - 1] });
            i--;
        }
    }

    const operations = [];
    for (const operation of reversed.reverse()) {
        pushDiffOperation(operations, operation.type, operation.text);
    }
    return operations;
}

function splitLineTokens(value = '') {
    return String(value).match(/[^\n]*\n|[^\n]+/g) || [];
}

function buildTokenDiffOperations(oldTokens, newTokens) {
    const m = oldTokens.length;
    const n = newTokens.length;
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldTokens[i - 1] === newTokens[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    let i = m;
    let j = n;
    const reversed = [];
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldTokens[i - 1] === newTokens[j - 1]) {
            reversed.push({ type: 'equal', text: oldTokens[i - 1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            reversed.push({ type: 'insert', text: newTokens[j - 1] });
            j--;
        } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
            reversed.push({ type: 'delete', text: oldTokens[i - 1] });
            i--;
        }
    }

    const operations = [];
    for (const operation of reversed.reverse()) {
        pushDiffOperation(operations, operation.type, operation.text);
    }
    return operations;
}

function appendReplacementOperations(operations, deletedText, insertedText) {
    if (!deletedText && !insertedText) return;
    const deletedLength = Array.from(deletedText).length;
    const insertedLength = Array.from(insertedText).length;

    if (deletedText && insertedText && isDiffMatrixSafe(deletedLength, insertedLength, inlineDiffCellLimit)) {
        getTextDiffOperations(deletedText, insertedText, { allowLineFallback: false })
            .forEach(operation => pushDiffOperation(operations, operation.type, operation.text));
        return;
    }

    pushDiffOperation(operations, 'delete', deletedText);
    pushDiffOperation(operations, 'insert', insertedText);
}

function buildLineBlockDiffOperations(oldStr, newStr) {
    const oldTokens = splitLineTokens(oldStr);
    const newTokens = splitLineTokens(newStr);

    if (oldTokens.length === 0) return newStr ? [{ type: 'insert', text: newStr }] : [];
    if (newTokens.length === 0) return oldStr ? [{ type: 'delete', text: oldStr }] : [];
    if (!isDiffMatrixSafe(oldTokens.length, newTokens.length, lineDiffCellLimit)) {
        return [
            { type: 'delete', text: oldStr },
            { type: 'insert', text: newStr },
        ];
    }

    const lineOperations = buildTokenDiffOperations(oldTokens, newTokens);
    const operations = [];
    let deletedText = '';
    let insertedText = '';

    const flushReplacement = () => {
        appendReplacementOperations(operations, deletedText, insertedText);
        deletedText = '';
        insertedText = '';
    };

    for (const operation of lineOperations) {
        if (operation.type === 'equal') {
            flushReplacement();
            pushDiffOperation(operations, 'equal', operation.text);
        } else if (operation.type === 'delete') {
            deletedText += operation.text;
        } else {
            insertedText += operation.text;
        }
    }

    flushReplacement();
    return operations;
}

function getTextDiffOperations(oldStr, newStr, options = {}) {
    const oldText = String(oldStr ?? '');
    const newText = String(newStr ?? '');
    if (oldText === newText) return oldText ? [{ type: 'equal', text: oldText }] : [];
    if (!oldText) return newText ? [{ type: 'insert', text: newText }] : [];
    if (!newText) return oldText ? [{ type: 'delete', text: oldText }] : [];

    const oldChars = Array.from(oldText);
    const newChars = Array.from(newText);
    let start = 0;
    while (start < oldChars.length && start < newChars.length && oldChars[start] === newChars[start]) {
        start++;
    }

    let endOld = oldChars.length - 1;
    let endNew = newChars.length - 1;
    while (endOld >= start && endNew >= start && oldChars[endOld] === newChars[endNew]) {
        endOld--;
        endNew--;
    }

    const operations = [];
    pushDiffOperation(operations, 'equal', oldChars.slice(0, start).join(''));

    const midOld = oldChars.slice(start, endOld + 1);
    const midNew = newChars.slice(start, endNew + 1);
    const allowLineFallback = options.allowLineFallback !== false;
    const middleOperations = isDiffMatrixSafe(midOld.length, midNew.length, inlineDiffCellLimit)
        ? buildCharDiffOperations(midOld, midNew)
        : allowLineFallback
            ? buildLineBlockDiffOperations(midOld.join(''), midNew.join(''))
            : [
                { type: 'delete', text: midOld.join('') },
                { type: 'insert', text: midNew.join('') },
            ];

    middleOperations.forEach(operation => pushDiffOperation(operations, operation.type, operation.text));
    pushDiffOperation(operations, 'equal', oldChars.slice(endOld + 1).join(''));
    return operations;
}

function renderDiffOperation(operation) {
    if (!operation || !operation.text) return '';
    if (operation.type === 'delete' || operation.type === 'insert') {
        const attrs = [
            `class="blai-diff-change"`,
            `data-blai-diff-type="${operation.type === 'delete' ? 'delete' : 'insert'}"`,
        ];
        if (operation.type === 'insert' && ['program', 'ai'].includes(operation.source)) {
            attrs.push(`data-blai-diff-source="${operation.source}"`);
        }
        ['oldStart', 'oldEnd', 'newStart', 'newEnd'].forEach((key) => {
            if (Number.isFinite(Number(operation[key]))) attrs.push(`data-blai-${key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}="${Number(operation[key])}"`);
        });
        const tag = operation.type === 'delete' ? 'del' : 'ins';
        return `<${tag} ${attrs.join(' ')}>${escapeHtml(operation.text)}</${tag}>`;
    }
    return escapeHtml(operation.text);
}

function renderDiffOperations(operations = []) {
    return operations.map(renderDiffOperation).join('');
}

function findPreviousBoundaryEnd(text = '', position = 0, pattern = /\r?\n/g) {
    const source = String(text);
    const cursor = Math.max(0, Math.min(source.length, Number(position) || 0));
    const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let boundaryEnd = -1;
    let match;
    while ((match = regex.exec(source)) !== null) {
        if (match.index >= cursor) break;
        boundaryEnd = match.index + match[0].length;
        if (match[0].length === 0) regex.lastIndex++;
    }
    return boundaryEnd;
}

function findNextBoundaryStart(text = '', position = 0, pattern = /\r?\n/g) {
    const source = String(text);
    const cursor = Math.max(0, Math.min(source.length, Number(position) || 0));
    const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    regex.lastIndex = cursor;
    const match = regex.exec(source);
    return match ? match.index : -1;
}

function hasParagraphBoundary(value = '') {
    return /\r?\n[ \t]*\r?\n/.test(String(value));
}

function hasLineBoundary(value = '') {
    return /\r?\n/.test(String(value));
}

function getLogicalWindowForChange(originalText = '', start = 0, end = start) {
    const text = String(originalText);
    const safeStart = Math.max(0, Math.min(text.length, Number(start) || 0));
    const safeEnd = Math.max(safeStart, Math.min(text.length, Number(end) || safeStart));
    const paragraphPattern = /\r?\n[ \t]*\r?\n/g;

    const previousParagraphEnd = findPreviousBoundaryEnd(text, safeStart, paragraphPattern);
    const nextParagraphStart = findNextBoundaryStart(text, safeEnd, paragraphPattern);
    if (previousParagraphEnd >= 0 || nextParagraphStart >= 0) {
        return {
            start: previousParagraphEnd >= 0 ? previousParagraphEnd : 0,
            end: nextParagraphStart >= 0 ? nextParagraphStart : text.length,
        };
    }

    const previousLineEnd = findPreviousBoundaryEnd(text, safeStart, /\r?\n/g);
    const nextLineStart = findNextBoundaryStart(text, safeEnd, /\r?\n/g);
    return {
        start: previousLineEnd >= 0 ? previousLineEnd : 0,
        end: nextLineStart >= 0 ? nextLineStart : text.length,
    };
}

function clampWindowToLimit(window, textLength) {
    const start = Math.max(0, Math.min(textLength, Number(window?.start) || 0));
    const end = Math.max(start, Math.min(textLength, Number(window?.end) || start));
    const anchorStart = Math.max(start, Math.min(end, Number(window?.anchorStart) || start));
    const anchorEnd = Math.max(anchorStart, Math.min(end, Number(window?.anchorEnd) || anchorStart));

    if (end - start <= snippetWindowCharLimit) {
        return { start, end, hasPrefixEllipsis: false, hasSuffixEllipsis: false };
    }

    const anchorLength = Math.max(1, anchorEnd - anchorStart);
    if (anchorLength >= snippetWindowCharLimit) {
        const nextEnd = Math.min(end, anchorStart + snippetWindowCharLimit);
        return {
            start: anchorStart,
            end: nextEnd,
            hasPrefixEllipsis: anchorStart > start,
            hasSuffixEllipsis: nextEnd < end,
        };
    }

    const beforeBudget = Math.floor((snippetWindowCharLimit - anchorLength) / 2);
    let nextStart = Math.max(start, anchorStart - beforeBudget);
    let nextEnd = nextStart + snippetWindowCharLimit;
    if (nextEnd > end) {
        nextEnd = end;
        nextStart = Math.max(start, nextEnd - snippetWindowCharLimit);
    }

    return {
        start: nextStart,
        end: nextEnd,
        hasPrefixEllipsis: nextStart > start,
        hasSuffixEllipsis: nextEnd < end,
    };
}

function annotateDiffOperations(operations = []) {
    let oldOffset = 0;
    let newOffset = 0;
    return operations.map((operation) => {
        const text = String(operation?.text || '');
        const annotated = {
            ...operation,
            text,
            oldStart: oldOffset,
            oldEnd: oldOffset,
            newStart: newOffset,
            newEnd: newOffset,
        };
        if (operation?.type !== 'insert') oldOffset += text.length;
        if (operation?.type !== 'delete') newOffset += text.length;
        annotated.oldEnd = oldOffset;
        annotated.newEnd = newOffset;
        return annotated;
    });
}

function rangeOverlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
}

function rangeOverlapsAny(start, end, ranges = []) {
    return ranges.some((range) => rangeOverlaps(start, end, range.start, range.end));
}

function getInsertRanges(annotatedOperations = []) {
    return annotatedOperations
        .filter(operation => operation?.type === 'insert' && operation.newEnd > operation.newStart)
        .map(operation => ({ start: operation.newStart, end: operation.newEnd }));
}

function applyInsertSources(annotatedOperations = [], aiInsertRanges = []) {
    return annotatedOperations.map((operation) => {
        if (operation?.type !== 'insert') return operation;
        const source = rangeOverlapsAny(operation.newStart, operation.newEnd, aiInsertRanges) ? 'ai' : 'program';
        return { ...operation, source };
    });
}

function getChangeWindows(annotatedOperations = [], originalText = '') {
    const text = String(originalText);
    const windows = [];
    for (const operation of annotatedOperations) {
        if (!operation || operation.type === 'equal' || !operation.text) continue;
        const anchorStart = operation.type === 'insert' ? operation.oldStart : operation.oldStart;
        const anchorEnd = operation.type === 'insert' ? operation.oldStart : operation.oldEnd;
        const logicalWindow = getLogicalWindowForChange(text, anchorStart, anchorEnd);
        windows.push({
            ...logicalWindow,
            anchorStart,
            anchorEnd,
        });
    }

    windows.sort((a, b) => a.start - b.start || a.anchorStart - b.anchorStart);
    const merged = [];
    for (const window of windows) {
        const previous = merged[merged.length - 1];
        if (!previous) {
            merged.push({ ...window });
            continue;
        }

        const gap = Math.max(0, window.start - previous.end);
        const gapText = gap > 0 ? text.slice(previous.end, window.start) : '';
        const mergedAnchorSpan = Math.max(previous.anchorEnd, window.anchorEnd) - Math.min(previous.anchorStart, window.anchorStart);
        const shouldMerge = (window.start <= previous.end && mergedAnchorSpan <= snippetWindowCharLimit)
            || (gap <= snippetJoinEqualChars && !hasLineBoundary(gapText) && !hasParagraphBoundary(gapText) && mergedAnchorSpan <= snippetWindowCharLimit);

        if (shouldMerge) {
            previous.start = Math.min(previous.start, window.start);
            previous.end = Math.max(previous.end, window.end);
            previous.anchorStart = Math.min(previous.anchorStart, window.anchorStart);
            previous.anchorEnd = Math.max(previous.anchorEnd, window.anchorEnd);
        } else {
            merged.push({ ...window });
        }
    }

    return merged
        .slice(0, maxDiffSnippetCount)
        .map(window => clampWindowToLimit(window, text.length));
}

function renderOperationSlice(operation, start, end) {
    if (!operation || !operation.text || end <= start) return '';
    const slicedText = operation.text.slice(start - operation.oldStart, end - operation.oldStart);
    if (!slicedText) return '';
    return renderDiffOperation({ ...operation, text: slicedText, oldStart: start, oldEnd: end });
}

function renderDiffWindow(annotatedOperations = [], window) {
    if (!window || window.end < window.start) return '';
    const parts = [];
    if (window.hasPrefixEllipsis) parts.push('...');

    for (const operation of annotatedOperations) {
        if (!operation?.text) continue;

        if (operation.type === 'insert') {
            if (operation.oldStart >= window.start && operation.oldStart <= window.end) {
                parts.push(renderDiffOperation(operation));
            }
            continue;
        }

        const overlapStart = Math.max(window.start, operation.oldStart);
        const overlapEnd = Math.min(window.end, operation.oldEnd);
        if (overlapEnd > overlapStart) {
            parts.push(renderOperationSlice(operation, overlapStart, overlapEnd));
        }
    }

    if (window.hasSuffixEllipsis) parts.push('...');
    const html = parts.join('');
    if (!html.trim() || !/<(?:del|ins)\b/.test(html)) return '';
    return `<div class="blai-diff-snippet">${html}</div>`;
}

function buildDiffSnippetsFromOperations(operations = [], originalText = '') {
    const annotatedOperations = annotateDiffOperations(operations);
    const sourcedOperations = applyInsertSources(annotatedOperations);
    return buildDiffSnippetsFromAnnotatedOperations(sourcedOperations, originalText);
}

function buildDiffSnippetsFromAnnotatedOperations(annotatedOperations = [], originalText = '') {
    return getChangeWindows(annotatedOperations, originalText)
        .map(window => renderDiffWindow(annotatedOperations, window))
        .filter(Boolean)
        .slice(0, maxDiffSnippetCount);
}

function extractDiffDisplayText(rawText = '') {
    const source = String(rawText ?? '');
    const contentMatch = source.match(/<content>([\s\S]*?)<\/content>/i);
    return contentMatch ? contentMatch[1].trim() : source;
}

function hasRenderedFullDiff(value = '') {
    return typeof value === 'string' && value.includes('blai-diff-full-modified');
}

function hasRenderedSnippetDiff(snippets = []) {
    return Array.isArray(snippets) && snippets.some(snippet => /<(?:del|ins)\b/.test(snippet));
}

function hasCompleteRenderedDiff(cache = {}) {
    return hasRenderedSnippetDiff(cache?.snippets) && hasRenderedFullDiff(cache?.fullDiff);
}

export function buildDiffResultFromPair(rawText, cleanedText) {
    if (typeof rawText !== 'string') return { cleanedText: rawText, snippets: [], fullDiff: "" };
    const normalizedCleanedText = typeof cleanedText === 'string' ? cleanedText : applyScopedReplacements(rawText);
    const displayText = extractDiffDisplayText(rawText);
    const cleanedDisplayText = extractDiffDisplayText(normalizedCleanedText);
    const displayOperations = getTextDiffOperations(displayText, cleanedDisplayText);
    const snippets = buildDiffSnippetsFromOperations(displayOperations, displayText);
    const fullDiff = buildFullDiffHtml(displayText, cleanedDisplayText);

    return {
        cleanedText: normalizedCleanedText,
        snippets,
        fullDiff,
    };
}

export function buildDiffResultFromChain(rawText, programText, finalText) {
    if (typeof rawText !== 'string') return { cleanedText: rawText, snippets: [], fullDiff: "" };
    const normalizedProgramText = typeof programText === 'string' ? programText : applyScopedReplacements(rawText);
    const normalizedFinalText = typeof finalText === 'string' ? finalText : normalizedProgramText;
    const displayText = extractDiffDisplayText(rawText);
    const programDisplayText = extractDiffDisplayText(normalizedProgramText);
    const finalDisplayText = extractDiffDisplayText(normalizedFinalText);

    if (displayText === finalDisplayText) {
        return {
            cleanedText: normalizedFinalText,
            snippets: [],
            fullDiff: buildNormalFullDiffBlocks(displayText),
        };
    }

    const programToFinalOperations = annotateDiffOperations(getTextDiffOperations(programDisplayText, finalDisplayText));
    const aiInsertRanges = getInsertRanges(programToFinalOperations);
    const sourceToFinalOperations = applyInsertSources(
        annotateDiffOperations(getTextDiffOperations(displayText, finalDisplayText)),
        aiInsertRanges
    );

    return {
        cleanedText: normalizedFinalText,
        snippets: buildDiffSnippetsFromAnnotatedOperations(sourceToFinalOperations, displayText),
        fullDiff: buildFullDiffBlocksFromOperations(sourceToFinalOperations),
    };
}

function buildDiffResultFromSource(rawText) {
    if (typeof rawText !== 'string') return { cleanedText: rawText, snippets: [], fullDiff: "" };
    return buildDiffResultFromPair(rawText, applyScopedReplacements(rawText));
}

function sourceHasCurrentDiff(sourceText = '') {
    if (typeof sourceText !== 'string') return false;
    const displayText = extractDiffDisplayText(sourceText);
    return applyScopedReplacements(displayText) !== displayText;
}

function buildNormalFullDiffBlocks(value = '') {
    return String(value)
        .split('\n')
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => `<div class="blai-diff-full-normal">${escapeHtml(part)}</div>`)
        .join('');
}

function buildFullDiffBlocksFromOperations(operations = []) {
    const blocks = [];
    let currentParts = [];
    let currentHasChange = false;

    const flushBlock = () => {
        const html = currentParts.join('').trim();
        if (!html) {
            currentParts = [];
            currentHasChange = false;
            return;
        }

        const className = currentHasChange ? 'blai-diff-full-modified' : 'blai-diff-full-normal';
        blocks.push(`<div class="${className}">${html}</div>`);
        currentParts = [];
        currentHasChange = false;
    };

    for (const operation of operations) {
        if (!operation?.text) continue;
        const pieces = String(operation.text).split(/(\n{2,})/);
        for (const piece of pieces) {
            if (!piece) continue;
            if (/^\n{2,}$/.test(piece)) {
                if (operation.type !== 'equal' && currentParts.length > 0) {
                    currentParts.push(renderDiffOperation({ ...operation, text: piece }));
                    currentHasChange = true;
                }
                flushBlock();
                continue;
            }
            currentParts.push(renderDiffOperation({ ...operation, text: piece }));
            if (operation.type !== 'equal') currentHasChange = true;
        }
    }

    flushBlock();
    return blocks.join('');
}

function buildFullDiffHtml(originalText, cleanedText) {
    if (originalText === cleanedText) return buildNormalFullDiffBlocks(originalText);
    const operations = applyInsertSources(annotateDiffOperations(getTextDiffOperations(originalText, cleanedText)));
    return buildFullDiffBlocksFromOperations(operations);
}
/**
 * 从原始消息文本构建净化结果与差异缓存。
 * @param {string} rawText 原始消息文本。
 * @returns {{cleanedText: string, snippets: string[], fullDiff: string}} 净化文本、片段差异和全文差异。
 */
export function buildDiffSnippetsFromText(rawText) {
    return buildDiffResultFromSource(rawText);
}

function resolveDiffCacheSource(msg) {
    const currentMes = typeof msg?.mes === 'string' ? msg.mes : '';
    const diffMeta = getMessageDiffMeta(msg);
    if (diffMeta?.lastCleanedMes && currentMes === diffMeta.lastCleanedMes) {
        return diffMeta.originalMes;
    }
    return currentMes;
}

function resolveDiffCachePair(msg) {
    const currentMes = typeof msg?.mes === 'string' ? msg.mes : '';
    const diffMeta = getMessageDiffMeta(msg);

    if (diffMeta?.originalMes && diffMeta?.lastCleanedMes && diffMeta.originalMes !== diffMeta.lastCleanedMes) {
        return {
            sourceMes: diffMeta.originalMes,
            cleanedMes: diffMeta.lastCleanedMes,
            aiProgramMes: diffMeta.aiProgramMes && diffMeta.aiFinalMes === diffMeta.lastCleanedMes ? diffMeta.aiProgramMes : '',
            hasStoredPair: true,
        };
    }

    const sourceMes = resolveDiffCacheSource(msg);
    return {
        sourceMes,
        cleanedMes: currentMes && currentMes !== sourceMes ? currentMes : applyScopedReplacements(sourceMes),
        hasStoredPair: false,
    };
}

export function getDiffComparisonForMessage(index) {
    const { chat } = getAppContext();
    if (!Array.isArray(chat) || !Number.isInteger(index) || index < 0 || index >= chat.length) {
        return null;
    }
    const pair = resolveDiffCachePair(chat[index]);
    if (!pair) return null;
    return {
        ...pair,
        sourceDisplayText: extractDiffDisplayText(pair.sourceMes || ''),
        cleanedDisplayText: extractDiffDisplayText(pair.cleanedMes || ''),
    };
}

export function refreshDiffCacheIfStale(index) {
    const { chat } = getAppContext();
    if (!Number.isInteger(index) || index < 0 || !Array.isArray(chat)) return false;

    const msg = chat[index];
    if (!isAssistantMessage(msg) || msg.__blai_is_reverted === true) return false;

    const signature = computeMessageSignature(msg);
    const state = runtimeState.diffMessageStates.get(index);
    const cache = sanitizeCacheEntry(runtimeState.diffSnippetsCache.get(index));
    const { sourceMes, cleanedMes, aiProgramMes, hasStoredPair } = resolveDiffCachePair(msg);
    const shouldHaveCurrentDiff = hasStoredPair
        ? extractDiffDisplayText(sourceMes) !== extractDiffDisplayText(cleanedMes)
        : sourceHasCurrentDiff(sourceMes);
    if (state?.status === 'ready'
        && state.signature === signature
        && cache?.signature === signature
        && (!shouldHaveCurrentDiff || hasCompleteRenderedDiff(cache))) {
        return false;
    }

    const diffResult = aiProgramMes
        ? buildDiffResultFromChain(sourceMes, aiProgramMes, cleanedMes)
        : buildDiffResultFromPair(sourceMes, cleanedMes);
    writeReadyDiffCache(index, signature, {
        snippets: Array.from(new Set(diffResult.snippets || [])),
        fullDiff: diffResult.fullDiff || '',
        signature,
    }, {
        persist: false,
    });
    return true;
}

/**
 * 更新指定消息的差异缓存。
 * @param {number} index 消息索引。
 * @param {{snippets?: string[], fullDiff?: string, signature?: string}} cacheData 差异缓存数据。
 * @returns {void}
 */
export function updateDiffSnippetCache(index, cacheData) {
    if (!Number.isInteger(index) || index < 0) return;
    runtimeState.diffSnippetsCache.set(index, {
        snippets: Array.isArray(cacheData?.snippets) ? cacheData.snippets : [],
        fullDiff: typeof cacheData?.fullDiff === 'string' ? cacheData.fullDiff : '',
        signature: typeof cacheData?.signature === 'string' ? cacheData.signature : '',
    });
}

/**
 * 确保消息节点拥有正确的“净化前文溯源”按钮状态。
 * @param {number} index 消息索引。
 * @param {Element} messageNode 消息 DOM 节点。
 * @returns {void}
 */
export function ensureMessageDiffButton(index, messageNode) {
    if (!messageNode || !Number.isInteger(index) || index < 0) return;
    const { chat } = getAppContext();
    const msg = Array.isArray(chat) ? chat[index] : null;

    if (!isAssistantMessage(msg) || !isTrackableMessageDomNode(messageNode)) {
        messageNode.querySelectorAll?.('.blai-diff-btn').forEach(btn => btn.remove());
        return;
    }

    const nodeIndex = resolveMessageIndexFromDomNode(messageNode);
    if (nodeIndex !== index) {
        messageNode.querySelectorAll?.('.blai-diff-btn').forEach(btn => btn.remove());
        return;
    }

    const { extension_settings } = getAppContext();
    const isEnabled = extension_settings[extensionName]?.enableVisualDiff !== false;
    const isTopInExtra = extension_settings[extensionName]?.diffButtonInExtraMenu === true;
    const showBottomButton = extension_settings[extensionName]?.showBottomDiffButton !== false;
    const shouldShow = isEnabled && isTrackedDiffMessage(index);

    const buttonArea = messageNode.querySelector('.mes_buttons');
    if (buttonArea) {
        let existing = buttonArea.querySelector('.blai-diff-btn-top');
        const extraMenu = buttonArea.querySelector('.extraMesButtons');
        const targetContainer = (isTopInExtra && extraMenu) ? extraMenu : buttonArea;

        if (existing && existing.parentElement !== targetContainer) {
            existing.remove();
            existing = null;
        }

        if (!shouldShow) {
            if (existing) existing.remove();
        } else if (!existing) {
            const button = document.createElement('div');
            button.className = 'mes_button blai-diff-btn blai-diff-btn-top fa-solid fa-clock-rotate-left interactable';
            button.title = '溯源净化前文';
            button.setAttribute('data-index', String(index));
            button.setAttribute('tabindex', '0');
            button.setAttribute('role', 'button');

            if (isTopInExtra && extraMenu) {
                extraMenu.appendChild(button);
            } else {
                const editBtn = buttonArea.querySelector('.mes_edit');
                if (editBtn) buttonArea.insertBefore(button, editBtn);
                else buttonArea.appendChild(button);
            }
        } else {
            existing.setAttribute('data-index', String(index));
        }
    }

    const swipeBlock = messageNode.querySelector('.swipeRightBlock');
    if (swipeBlock) {
        const parent = swipeBlock.parentNode;
        const existingBottom = parent?.querySelector('.blai-diff-btn-bottom');

        if (!shouldShow || !showBottomButton) {
            if (existingBottom) existingBottom.remove();
        } else if (!existingBottom && parent) {
            const btnBottom = document.createElement('div');
            btnBottom.className = 'blai-diff-btn blai-diff-btn-bottom fa-solid fa-clock-rotate-left interactable';
            btnBottom.title = '溯源净化前文 (尾部触发)';
            btnBottom.setAttribute('data-index', String(index));
            btnBottom.setAttribute('tabindex', '0');
            btnBottom.setAttribute('role', 'button');
            parent.insertBefore(btnBottom, swipeBlock);
        } else if (existingBottom) {
            existingBottom.setAttribute('data-index', String(index));
        }
    }
}

function cleanupStrayDiffButtons(trackedSet) {
    document.querySelectorAll('.blai-diff-btn[data-index]').forEach((button) => {
        const index = Number(button.getAttribute('data-index'));
        const mesNode = button.closest('.mes');
        const nodeIndex = resolveMessageIndexFromDomNode(mesNode);
        if (!trackedSet.has(index) || nodeIndex !== index || !isTrackableMessageDomNode(mesNode)) button.remove();
    });
}

/**
 * 仅对最新 N 条可追踪消息定向注入差异按钮。
 * @param {number[]} [targetIndices=[]] 可选的定向消息索引。
 * @returns {void}
 */
export function injectDiffButtons(targetIndices = []) {
    const latest = getLatestTrackableDiffIndices();
    const latestSet = new Set(latest);
    runtimeState.trackedDiffMessageOrder = latest;

    const indices = Array.isArray(targetIndices) && targetIndices.length > 0
        ? [...new Set(targetIndices.filter(index => latestSet.has(index)))]
        : latest;

    cleanupStrayDiffButtons(latestSet);
    for (const index of indices) {
        const node = getMessageDomNode(index);
        if (node) ensureMessageDiffButton(index, node);
    }
}

/**
 * 获取指定消息的差异缓存数据。
 * @param {number} index 消息索引。
 * @returns {{snippets: string[], fullDiff: string, signature: string}} 对应消息的差异片段与全文差异。
 */
export function getDiffSnippetsForMessage(index) {
    const cached = sanitizeCacheEntry(runtimeState.diffSnippetsCache.get(index));
    if (!cached) return { snippets: [], fullDiff: '', signature: '' };
    return cached;
}

/**
 * 清空全部消息差异缓存。
 * @returns {void}
 */
export function clearDiffSnippetsCache() {
    resetDiffRuntimeState();
    const { chat_metadata } = getAppContext();
    if (chat_metadata && typeof chat_metadata === 'object') delete chat_metadata[diffMetadataKey];
}
