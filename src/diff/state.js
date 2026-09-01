import { extensionName } from '../settings/defaults.js';
import { getAppContext, getCurrentChatMetadata } from '../host/appContext.js';
import { logger } from '../log.js';
import { queueIncrementalChatSave } from '../chat/persistence.js';
import { getMessageDiffBranchKey } from '../chat/messageBranch.js';
import { clearAllMessageDiffMeta, getMessageDiffMeta } from './messageMeta.js';
import { extractDiffDisplayText, buildDiffResultFromPair, buildDiffResultFromStages } from './compare.js';

import { isAssistantMessage, getLatestAssistantMessageIndices, getLatestTrackableDiffIndices, isTrackedDiffMessage } from './tracking.js';
import { injectDiffButtons } from './view.js';

// Owns Diff runtime state, rendered cache, freshness, and persistence; it only requests button projection.
export const diffRuntimeState = {
    diffSnippetsCache: new Map(),
    diffMessageStates: new Map(),
    currentDiffIndex: undefined,
    diffModalRefresh: null,
    diffRelatedRuleMode: false,
};

function hashString(value = '') {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return `h${(hash >>> 0).toString(16)}`;
}

const diffRenderVersion = 6;
const diffMetadataKey = `${extensionName}_diff_state_v3`;

function getDiffRulesSignature() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings?.[extensionName] || {};
    return hashString(JSON.stringify({
        rules: settings.rules || [],
        scopeTags: settings.scopeTags || [],
        scopeTagBuiltinDismissed: settings.scopeTagBuiltinDismissed || [],
        scopeTagMode: settings.scopeTagMode || 'protect',
        diffRenderVersion,
    }));
}

export function computeMessageSignature(msg) {
    if (!msg || typeof msg !== 'object') return '';
    const base = typeof msg.mes === 'string' ? msg.mes : '';
    const name = typeof msg.name === 'string' ? msg.name : '';
    const branchKey = getMessageDiffBranchKey(msg);
    const diffMeta = getMessageDiffMeta(msg, branchKey);
    const stageSignature = diffMeta
        ? `${diffMeta.originalMes}\n${diffMeta.programMes}\n${diffMeta.aiMes}\n${diffMeta.hasAiTrace}\n${diffMeta.finalSource}`
        : '';

    return hashString(`${name}
${branchKey}
${base}
${stageSignature}
${getDiffRulesSignature()}`);
}

function clearDiffMetadataOutsideRetainedFloors(chat, retainedSet) {
    if (!Array.isArray(chat)) return false;
    let changed = false;
    for (let index = 0; index < chat.length; index++) {
        if (retainedSet.has(index) || !isAssistantMessage(chat[index])) continue;
        if (clearAllMessageDiffMeta(chat[index])) changed = true;
    }
    return changed;
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
    };
}

function notifyDiffStateChanged(reason = 'state', index = diffRuntimeState.currentDiffIndex) {
    if (typeof diffRuntimeState.diffModalRefresh === 'function') {
        try {
            diffRuntimeState.diffModalRefresh(index, { reason, changedIndex: index });
        } catch (err) {
            logger.warn(`刷新对比弹窗失败`, err);
        }
    }
}

export function persistTrackedDiffState() {
    const chatMetadata = getCurrentChatMetadata();
    if (!chatMetadata) return false;

    const entries = {};
    for (const index of getLatestTrackableDiffIndices()) {
        const state = sanitizeStateEntry(diffRuntimeState.diffMessageStates.get(index));
        if (!state) continue;
        entries[String(index)] = {
            status: state.status,
            signature: state.signature || '',
        };
    }

    const savedState = chatMetadata[diffMetadataKey];
    const savedEntries = savedState && typeof savedState === 'object' ? savedState.entries : undefined;
    const savedComparableEntries = {};
    for (const [index, entry] of Object.entries(savedEntries || {})) {
        const sanitized = sanitizeStateEntry(entry);
        if (sanitized) savedComparableEntries[index] = sanitized;
    }
    if (JSON.stringify(savedComparableEntries) === JSON.stringify(entries)) return false;

    if (Object.keys(entries).length === 0) {
        delete chatMetadata[diffMetadataKey];
        queueIncrementalChatSave();
        return true;
    }

    const nextState = { version: 2, entries };
    chatMetadata[diffMetadataKey] = nextState;
    queueIncrementalChatSave();
    return true;
}

export function resetDiffRuntimeState() {
    logger.debug('重置差异运行时状态');
    diffRuntimeState.diffSnippetsCache.clear();
    diffRuntimeState.diffMessageStates.clear();
    diffRuntimeState.currentDiffIndex = undefined;
}

export function restoreDiffStateFromChatMetadata() {
    const { chat } = getAppContext();
    const chatMetadata = getCurrentChatMetadata();
    resetDiffRuntimeState();

    const latestIndices = getLatestAssistantMessageIndices(chat);
    const validLatest = new Set(latestIndices);
    const clearedHistoricalMetadata = clearDiffMetadataOutsideRetainedFloors(chat, validLatest);
    const saved = chatMetadata?.[diffMetadataKey];
    if (!saved || typeof saved !== 'object') {
        if (clearedHistoricalMetadata) queueIncrementalChatSave();
        return;
    }
    let restoredCount = 0;
    for (const index of latestIndices) {
        const rawEntry = saved.entries?.[String(index)] || saved.entries?.[index];
        const entry = sanitizeStateEntry(rawEntry);
        if (!entry) continue;
        diffRuntimeState.diffMessageStates.set(index, entry);
        diffRuntimeState.diffSnippetsCache.set(index, { snippets: [], fullDiff: '', signature: entry.signature || '' });
        restoredCount += 1;
    }

    const removedPersistedState = Object.keys(saved.entries || {}).some((key) => {
        const index = Number(key);
        return Number.isInteger(index) && index >= 0 && !validLatest.has(index);
    });
    const persistedStateChanged = removedPersistedState ? persistTrackedDiffState() : false;
    if (clearedHistoricalMetadata && !persistedStateChanged) queueIncrementalChatSave();
    logger.debug(`从 chat_metadata 恢复差异状态: 还原了 ${restoredCount} 条记录`);
}

export function syncTrackedIndicesToLatestAssistantMessages() {
    const { chat } = getAppContext();
    const chatMetadata = getCurrentChatMetadata();
    const latestIndices = getLatestTrackableDiffIndices();
    const latestSet = new Set(latestIndices);
    let removedPersistedState = false;

    for (const index of [...diffRuntimeState.diffMessageStates.keys()]) {
        if (!latestSet.has(index)) {
            diffRuntimeState.diffMessageStates.delete(index);
            removedPersistedState = true;
        }
    }

    for (const index of [...diffRuntimeState.diffSnippetsCache.keys()]) {
        if (!latestSet.has(index)) diffRuntimeState.diffSnippetsCache.delete(index);
    }

    const historicalMetadataChanged = clearDiffMetadataOutsideRetainedFloors(chat, latestSet);
    const savedEntries = chatMetadata?.[diffMetadataKey]?.entries;
    const hasEvictedPersistedState = Object.keys(savedEntries || {}).some((key) => {
        const index = Number(key);
        return Number.isInteger(index) && index >= 0 && !latestSet.has(index);
    });
    const persistedStateChanged = (removedPersistedState || hasEvictedPersistedState)
        ? persistTrackedDiffState()
        : false;

    if (historicalMetadataChanged && !persistedStateChanged) {
        queueIncrementalChatSave();
    }
    return historicalMetadataChanged || persistedStateChanged;
}

export function hasRealDiffCache(index) {
    const cached = diffRuntimeState.diffSnippetsCache.get(index);
    if (!cached || typeof cached !== 'object') return false;

    const hasSnippets = hasRenderedSnippetDiff(cached.snippets);
    const hasFullModified = typeof cached.fullDiff === 'string'
        && cached.fullDiff.includes('blai-diff-full-modified');

    return hasSnippets || hasFullModified;
}

export function getCachedDiffEntry(index) {
    return diffRuntimeState.diffSnippetsCache.get(index) || null;
}

export function markDiffComparisonPending(index, signature = '', options = {}) {
    const { chat } = getAppContext();
    if (!Number.isInteger(index) || index < 0 || !Array.isArray(chat) || !isAssistantMessage(chat[index])) return false;

    const existingState = diffRuntimeState.diffMessageStates.get(index);
    const existingCache = diffRuntimeState.diffSnippetsCache.get(index);
    const normalizedSignature = signature || computeMessageSignature(chat[index]);
    const shouldReplace = !existingState || existingState.signature !== normalizedSignature || !isTrackedDiffMessage(index);

    if (!shouldReplace) return false;

    syncTrackedIndicesToLatestAssistantMessages();
    if (!isTrackedDiffMessage(index)) return false;
    diffRuntimeState.diffSnippetsCache.delete(index);
    diffRuntimeState.diffMessageStates.set(index, {
        status: 'pending',
        signature: normalizedSignature,
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

    syncTrackedIndicesToLatestAssistantMessages();
    if (!isTrackedDiffMessage(index)) return false;

    diffRuntimeState.diffSnippetsCache.set(index, {
        snippets: nextSnippets,
        fullDiff: nextFullDiff,
        signature: signature || '',
    });
    diffRuntimeState.diffMessageStates.set(index, {
        status: 'ready',
        signature: signature || '',
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
    syncTrackedIndicesToLatestAssistantMessages();

    for (const index of latestIndices) {
        const msg = chat[index];
        if (!isAssistantMessage(msg)) continue;

        const signature = computeMessageSignature(msg);

        if (!diffRuntimeState.diffMessageStates.has(index)) {
            diffRuntimeState.diffMessageStates.set(index, {
                status: 'ready',
                signature,
            });
        }

        if (!diffRuntimeState.diffSnippetsCache.has(index)) {
            diffRuntimeState.diffSnippetsCache.set(index, {
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
    const hadState = diffRuntimeState.diffMessageStates.delete(index);
    const hadCache = diffRuntimeState.diffSnippetsCache.delete(index);

    if (hadState || hadCache) {
        if (options.persist !== false) persistTrackedDiffState();
        injectDiffButtons([index]);
        notifyDiffStateChanged('cleared', index);
    }
}

export function getDiffStateForMessage(index) {
    const state = diffRuntimeState.diffMessageStates.get(index);
    if (!state || typeof state !== 'object') return { status: 'pending', signature: '' };
    return {
        status: state.status === 'ready' ? 'ready' : 'pending',
        signature: typeof state.signature === 'string' ? state.signature : '',
    };
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


function resolveDiffCachePair(msg) {
    const diffMeta = getMessageDiffMeta(msg);
    const finalMes = typeof msg?.mes === 'string' ? msg.mes : '';

    if (diffMeta && diffMeta.originalMes !== finalMes) {
        return {
            sourceMes: diffMeta.originalMes,
            cleanedMes: finalMes,
            programMes: diffMeta.programMes,
            aiMes: diffMeta.aiMes,
            hasAiTrace: diffMeta.hasAiTrace === true,
            finalSource: diffMeta.finalSource,
        };
    }
    return null;
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
    const state = diffRuntimeState.diffMessageStates.get(index);
    const cache = sanitizeCacheEntry(diffRuntimeState.diffSnippetsCache.get(index));
    const pair = resolveDiffCachePair(msg);
    if (!pair) {
        const cacheHasDiff = hasRenderedSnippetDiff(cache?.snippets) || hasRenderedFullDiff(cache?.fullDiff);
        if (state?.status === 'ready'
            && state.signature === signature
            && cache?.signature === signature
            && !cacheHasDiff) {
            return false;
        }
        writeReadyDiffCache(index, signature, {
            snippets: [],
            fullDiff: '',
            signature,
        }, {
            persist: false,
        });
        return true;
    }

    const { sourceMes, cleanedMes, programMes, aiMes, hasAiTrace, finalSource } = pair;
    const shouldHaveCurrentDiff = extractDiffDisplayText(sourceMes) !== extractDiffDisplayText(cleanedMes);
    if (state?.status === 'ready'
        && state.signature === signature
        && cache?.signature === signature
        && (!shouldHaveCurrentDiff || hasCompleteRenderedDiff(cache))) {
        return false;
    }

    const diffResult = buildDiffResultFromStages(
        sourceMes,
        programMes,
        hasAiTrace ? aiMes : null,
        finalSource === 'manual' ? cleanedMes : null,
    );
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
    diffRuntimeState.diffSnippetsCache.set(index, {
        snippets: Array.isArray(cacheData?.snippets) ? cacheData.snippets : [],
        fullDiff: typeof cacheData?.fullDiff === 'string' ? cacheData.fullDiff : '',
        signature: typeof cacheData?.signature === 'string' ? cacheData.signature : '',
    });
}

/**
 * 获取指定消息的差异缓存数据。
 * @param {number} index 消息索引。
 * @returns {{snippets: string[], fullDiff: string, signature: string}} 对应消息的差异片段与全文差异。
 */
export function getDiffSnippetsForMessage(index) {
    const cached = sanitizeCacheEntry(diffRuntimeState.diffSnippetsCache.get(index));
    if (!cached) return { snippets: [], fullDiff: '', signature: '' };
    return cached;
}

/**
 * 清空全部消息差异缓存。
 * @returns {void}
 */
export function clearDiffSnippetsCache() {
    resetDiffRuntimeState();
    const chatMetadata = getCurrentChatMetadata();
    if (chatMetadata) delete chatMetadata[diffMetadataKey];
}
