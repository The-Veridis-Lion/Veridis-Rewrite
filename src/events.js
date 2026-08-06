import { defaultAiRewriteSettings, extensionName, getAppContext, runtimeState, markRulesDataDirty, markPresetsUiDirty, minTrackedDiffMessages, maxTrackedDiffMessages, normalizeDiffTrackedMessageLimit } from './state.js';
import { logger } from './log.js';
import { DEFAULT_SCOPE_TAG_GROUP_ID, buildPresetEntry, createScopeTagGroupId, createScopeTagId, deepClone, formatScopeTagInput, getBuiltinScopeTagKeyForStartTag, getCotScopeTagBuiltinKeys, getCurrentChatCompletionPresetName, getCurrentCharacterContext, getCurrentPresetAiRewriteSettings, getPresetAiRewriteSettings, getPresetBindingUsage, getPresetRules, isCotScopeTagEntry, mergeScopeTagsWithBuiltins, normalizeImportedRulesPayload, normalizePresetAiRewriteSettings, normalizeScopeTagBuiltinDismissedList, normalizeScopeTagCollapsedGroupList, normalizeScopeTagGroupList, normalizeScopeTagList, normalizeXmlTagNameInput, parseInputToWords, parseScopeTagInput, validateRegexTargetInput } from './utils.js';
import {
    applyPresetByName,
    closeScopeTagsModal,
    openScopeTagsModal,
    renderTags,
    renderScopeTagsModal,
    showResponsivePage,
    updateToolbarUI,
    updateLegacyPurifierWarning,
    renderSubrulesToModal,
    showConfirmModal,
    syncRealtimeMaskModeUI,
    refreshCharacterBindingUI,
    applyCharacterPresetBinding,
    focusLatestRuleCard,
    openSingleRuleModal,
    openTransferModal,
    closeTransferModal,
    runRuleTransfer,
    openEditModal,
    openRuleSearchModal,
    closeRuleSearchModal,
    renderRuleSearchModal,
    syncRuleSearchInputUi,
    clearRuleSearchEditFlow,
    showToast,
    openZhDictionaryModal,
    closeZhDictionaryModal,
    showZhDictionaryInstallOverlay,
    updateZhDictionaryInstallOverlay,
    closeLoadingOverlay,
    removeRegexReplacementInput,
    startEditingRegexReplacementInput,
    recognizeRegexReplacementInput,
    hasPendingRegexReplacementInput,
    setSingleRuleReplacementEditor,
    getSingleRuleReplacementValues,
} from './ui.js';
import {
    buildProcessors,
    performGlobalCleanse,
    applyScopedReplacements,
    performIncrementalCleanse,
    getMessageIndexFromEvent,
    getLatestMessageIndex,
    cleanseMessageDataAtIndex,
    queueIncrementalChatSave,
    refreshMessageDisplay,
} from './core.js';
import { performDeepCleanse } from './cleanse.js';
import { getMessageDomNode, purifyDOM, purifyStreamingMessageDom, isProtectedNode, isUserMessageDomNode, isRevertedMessageDomNode, isTrackableMessageDomNode, syncPersonaDescriptionProtectionControl } from './dom.js';
import { clearTrackedDiffEntry, computeMessageSignature, escapeHtml, getDiffComparisonForMessage, getDiffSnippetsForMessage, getDiffStateForMessage, injectDiffButtons, isAssistantMessage, markDiffComparisonPending, refreshDiffCacheIfStale, resetDiffRuntimeState, restoreDiffStateFromChatMetadata, syncTrackedIndicesToLatestAssistantMessages } from './diff.js';
import { getCurrentMessageOriginalMes, setCurrentSwipeText } from './messageMeta.js';
import { findRelatedRulesForDiffChange } from './relatedRules.js';
import { isBaiBaiToolkitInstalled, isTauriTavernHost } from './platform.js';
import { getAiRewriteDebugLogText, handleAiRewriteGenerationStarted, markAiRewriteFinalCleanseReady, maybeNotifyAiRewriteReadyFromStreamingText, recordAiRewriteRuntimeDebug, requestManualAiRewriteForMessage, resetAiRewriteRuntimeState } from './aiRewrite.js';
import { StreamingSourceCleanser } from './streamingSourceCleanser.js';
import {
    downloadZhDictionaryPackage,
    getZhDictionaryPackageStats,
    getZhDictionaryPackageStatus,
    getZhVariantCompatOptions,
    isZhDictionaryReady,
    markZhDictionaryInstallFailed,
    normalizeZhVariantSettings,
    restoreZhDictionaryPackageFromCache,
} from './zhConversion.js';

let streamingDiffInjectTimer = null;
let streamingPendingDiffIndices = [];
const ruleObjectIdMap = new WeakMap();
let nextRuleObjectId = 1;
let zhDictionaryInstallAbortController = null;
let aiApiCheckAbortController = null;
let aiApiCheckSequence = 0;
let installStreamingProcessorCleanserFromEvents = null;
let streamProcessorInstallFailureLogged = false;
const streamEventTextByMessageId = new Map();
const streamEventProbeByMessageId = new Map();
let streamEventNoTextProbeCount = 0;

function clearStreamEventBuffers() {
    streamEventTextByMessageId.clear();
    streamEventProbeByMessageId.clear();
    streamEventNoTextProbeCount = 0;
    streamProcessorInstallFailureLogged = false;
}

function describeStreamPayload(payload) {
    if (typeof payload === 'string') return { type: 'string', length: payload.length };
    if (!payload || typeof payload !== 'object') return { type: typeof payload };
    const keys = Object.keys(payload).slice(0, 12);
    const stringKeys = keys
        .filter((key) => typeof payload[key] === 'string')
        .map((key) => ({ key, length: payload[key].length }));
    return {
        type: Array.isArray(payload) ? 'array' : 'object',
        keys,
        stringKeys,
    };
}

function mergeStreamEventText(previous, incoming) {
    const existing = String(previous || '');
    const next = String(incoming || '');
    if (!existing) return { text: next, mode: 'first' };
    if (!next) return { text: existing, mode: 'empty' };
    if (next === existing) return { text: existing, mode: 'same' };
    if (next.startsWith(existing)) return { text: next, mode: 'full' };
    if (existing.endsWith(next)) return { text: existing, mode: 'duplicate-tail' };

    const overlapLimit = Math.min(existing.length, next.length, 512);
    for (let size = overlapLimit; size > 0; size -= 1) {
        if (existing.endsWith(next.slice(0, size))) {
            return { text: `${existing}${next.slice(size)}`, mode: 'overlap' };
        }
    }
    return { text: `${existing}${next}`, mode: 'delta' };
}

function hasXmlLikeClose(text) {
    const tail = String(text || '').slice(-512);
    return /<\s*\/\s*[A-Za-z][\w:.-]*\s*>/u.test(tail);
}

function getStreamEventProbe(index, combinedText) {
    const probe = streamEventProbeByMessageId.get(index) || { count: 0, closeLogged: false };
    probe.count += 1;
    const hasXmlClose = hasXmlLikeClose(combinedText);
    const shouldLog = probe.count <= 3 || probe.count % 25 === 0 || (hasXmlClose && probe.closeLogged !== true);
    if (hasXmlClose) probe.closeLogged = true;
    streamEventProbeByMessageId.set(index, probe);
    return { count: probe.count, hasXmlClose, shouldLog };
}

function removeBindingEntriesForPreset(bindingMap, presetName) {
    if (!bindingMap || typeof bindingMap !== 'object' || !presetName) return 0;
    let count = 0;
    Object.keys(bindingMap).forEach((key) => {
        if (bindingMap[key] === presetName) {
            delete bindingMap[key];
            count += 1;
        }
    });
    return count;
}

function ensureRuleObjectId(rule) {
    if (!rule || typeof rule !== 'object') return '';
    let id = ruleObjectIdMap.get(rule);
    if (!id) {
        id = `rule-${nextRuleObjectId++}`;
        ruleObjectIdMap.set(rule, id);
    }
    return id;
}

function getRuleIdsByIndexes(rules, indexes) {
    return indexes.map((idx) => rules[idx]).filter(Boolean).map((rule) => ensureRuleObjectId(rule));
}

function getSelectedIndexesFromState(rules) {
    const selectedSet = new Set(runtimeState.batchSelectedRuleIds || []);
    return rules.map((rule, idx) => (selectedSet.has(ensureRuleObjectId(rule)) ? idx : -1)).filter((idx) => idx >= 0);
}

function syncBatchSelectionStateFromDom(rules) {
    const indexes = $('.batch-item-checkbox:checked').map(function() { return Number($(this).data('index')); }).get().filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < rules.length);
    runtimeState.batchSelectedRuleIds = getRuleIdsByIndexes(rules, indexes);
}

function applyBatchSelectionStateToDom(rules) {
    const selectedSet = new Set(runtimeState.batchSelectedRuleIds || []);
    $('.batch-item-checkbox').each(function() {
        const idx = Number($(this).data('index'));
        const rule = rules[idx];
        const checked = Boolean(rule) && selectedSet.has(ensureRuleObjectId(rule));
        $(this).prop('checked', checked);
    });
}

function getBatchOperationContext(clickedIndex, rules) {
    const isBatchMode = $('#blai-purifier-popup').hasClass('blai-is-batch-mode');
    const selectedIndexes = getSelectedIndexesFromState(rules);
    const selectedSet = new Set(selectedIndexes);
    const shouldBatch = isBatchMode && selectedIndexes.length > 1 && selectedSet.has(clickedIndex);
    return { isBatchMode, selectedIndexes, selectedSet, shouldBatch };
}

function shouldBatchTransferRule(clickedIndex, rules) {
    if (!Number.isInteger(clickedIndex) || clickedIndex < 0 || clickedIndex >= rules.length) return false;
    return getBatchOperationContext(clickedIndex, rules).shouldBatch;
}

function deleteSingleRule(rules, index) {
    const deletingRule = rules[index];
    if (!deletingRule) return false;
    const deletingId = ensureRuleObjectId(deletingRule);
    rules.splice(index, 1);
    runtimeState.batchSelectedRuleIds = (runtimeState.batchSelectedRuleIds || []).filter((id) => id !== deletingId);
    return true;
}

function deleteSelectedRules(rules, selectedIndexes) {
    if (!Array.isArray(selectedIndexes) || selectedIndexes.length <= 1) return false;
    const deletingSet = new Set(selectedIndexes);
    const deletingIds = new Set(getRuleIdsByIndexes(rules, selectedIndexes));
    const nextRules = rules.filter((_, idx) => !deletingSet.has(idx));
    rules.splice(0, rules.length, ...nextRules);
    runtimeState.batchSelectedRuleIds = (runtimeState.batchSelectedRuleIds || []).filter((id) => !deletingIds.has(id));
    return true;
}

function handleDeleteRule(index, rules) {
    if (shouldBatchTransferRule(index, rules)) {
        return deleteSelectedRules(rules, getSelectedIndexesFromState(rules));
    }
    return deleteSingleRule(rules, index);
}

function normalizeRulesForPresetComparison(rules) {
    return (Array.isArray(rules) ? rules : []).map((rule) => {
        const normalized = deepClone(rule || {});
        delete normalized.enabled;
        return normalized;
    });
}

function hasPresetContentChanges(currentRules, savedPresetEntry, currentAiRewrite) {
    const rulesChanged = JSON.stringify(normalizeRulesForPresetComparison(currentRules))
        !== JSON.stringify(normalizeRulesForPresetComparison(getPresetRules(savedPresetEntry)));
    if (rulesChanged) return true;

    const savedAiRewrite = getPresetAiRewriteSettings(savedPresetEntry);
    if (!savedAiRewrite) return false;
    return JSON.stringify(getCurrentPresetAiRewriteSettings(currentAiRewrite)) !== JSON.stringify(savedAiRewrite);
}

function renderTagsPreserveBatchSelection() {
    renderTags();
    const { extension_settings } = getAppContext();
    applyBatchSelectionStateToDom(extension_settings[extensionName]?.rules || []);
}

function batchMoveRules(rules, selectedIndexes, direction) {
    if (selectedIndexes.length <= 1) return false;
    const selectedSet = new Set(selectedIndexes);
    const sorted = [...selectedIndexes].sort((a, b) => a - b);

    if (direction === 'up') {
        if (sorted[0] === 0) return false;
        for (let i = 0; i < sorted.length; i++) {
            const idx = sorted[i];
            const prev = idx - 1;
            if (prev >= 0 && !selectedSet.has(prev)) {
                [rules[prev], rules[idx]] = [rules[idx], rules[prev]];
                selectedSet.delete(idx);
                selectedSet.add(prev);
            }
        }
        return true;
    }

    if (direction === 'down') {
        if (sorted[sorted.length - 1] === rules.length - 1) return false;
        for (let i = sorted.length - 1; i >= 0; i--) {
            const idx = sorted[i];
            const next = idx + 1;
            if (next < rules.length && !selectedSet.has(next)) {
                [rules[idx], rules[next]] = [rules[next], rules[idx]];
                selectedSet.delete(idx);
                selectedSet.add(next);
            }
        }
        return true;
    }
    return false;
}

export function injectDiffButtonsStreamingSafe(indices = []) {
    if (runtimeState.isStreamingGeneration) {
        indices.forEach(i => { if (!streamingPendingDiffIndices.includes(i)) streamingPendingDiffIndices.push(i); });
        if (streamingDiffInjectTimer) return;
        streamingDiffInjectTimer = setTimeout(() => {
            streamingDiffInjectTimer = null;
            const pending = [...streamingPendingDiffIndices];
            streamingPendingDiffIndices = [];
            if (pending.length > 0) injectDiffButtons(pending);
        }, 100);
    } else {
        if (indices.length > 0) injectDiffButtons(indices);
    }
}

export function initRealtimeInterceptor() {
    let isPurifying = false;
    syncPersonaDescriptionProtectionControl();
    const personaProtectionIntervalId = setInterval(syncPersonaDescriptionProtectionControl, 1000);
    window.addEventListener('beforeunload', () => clearInterval(personaProtectionIntervalId), { once: true });
    const resolveNodeMessageIndex = (node) => {
        if (!node || node.nodeType !== 1) return -1;
        const attrs = [node.getAttribute('mesid'), node.getAttribute('data-mesid'), node.getAttribute('messageid'), node.getAttribute('data-message-id')];
        for (const raw of attrs) {
            const n = Number(raw);
            if (Number.isInteger(n) && n >= 0) return n;
        }
        const chatEl = document.getElementById('chat');
        if (!chatEl) return -1;
        return Array.from(chatEl.querySelectorAll('.mes')).indexOf(node);
    };

    const collectMessageNodes = (node, bucket) => {
        if (!node || node.nodeType !== 1) return;
        if (node.matches?.('.mes')) bucket.push(node);
        node.querySelectorAll?.('.mes').forEach((mes) => bucket.push(mes));
    };

    const getClosestTrackableMessageNode = (node) => {
        if (!node) return null;
        const element = node.nodeType === 1 ? node : node.parentElement;
        const mesNode = element?.matches?.('.mes') ? element : element?.closest?.('.mes');
        return mesNode && isTrackableMessageDomNode(mesNode) ? mesNode : null;
    };

    const primePendingComparisonForNode = (messageNode, options = {}) => {
        const { chat } = getAppContext();
        const index = resolveNodeMessageIndex(messageNode);
        if (index < 0 || !Array.isArray(chat) || !isAssistantMessage(chat[index])) return -1;
        markDiffComparisonPending(index, computeMessageSignature(chat[index]), options);
        return index;
    };

    const getRealtimeMaskMode = () => {
        const mode = getAppContext().extension_settings?.[extensionName]?.realtimeMaskMode;
        return mode === 'simple-visual' ? 'simple-visual' : 'tavern-helper';
    };

    const isSimpleVisualRealtimeMask = () => getRealtimeMaskMode() === 'simple-visual';
    const isTavernHelperRealtimeMask = () => getRealtimeMaskMode() === 'tavern-helper';

    const streamingProcessorPatchKey = '__blai_streaming_source_cleanser';

    const getCurrentStreamingProcessor = () => {
        const getter = getAppContext().getStreamingProcessor;
        return typeof getter === 'function' ? getter() : null;
    };

    const markStreamingMessagePending = (messageId) => {
        const { chat } = getAppContext();
        const index = Number(messageId);
        if (!Number.isInteger(index) || index < 0 || !Array.isArray(chat) || !isAssistantMessage(chat[index])) return;
        markDiffComparisonPending(index, computeMessageSignature(chat[index]), { skipPersist: true });
        injectDiffButtonsStreamingSafe([index]);
    };

    const installStreamingProcessorCleanser = () => {
        const processor = getCurrentStreamingProcessor();
        if (!processor || typeof processor.onProgressStreaming !== 'function') return false;
        if (processor[streamingProcessorPatchKey]) return true;

        const originalOnProgress = processor.onProgressStreaming;
        const cleanser = new StreamingSourceCleanser();
        processor[streamingProcessorPatchKey] = { originalOnProgress, cleanser };
        processor.onProgressStreaming = async function(messageId, text, isFinal) {
            const rawText = typeof text === 'string' ? text : String(text ?? '');
            const numericMessageId = Number(messageId);
            if (Number.isInteger(numericMessageId) && numericMessageId >= 0) {
                runtimeState.streamingRawMessageCache.set(numericMessageId, rawText);
                maybeNotifyAiRewriteReadyFromStreamingText(numericMessageId, rawText);
            }
            let cleanText = text;
            let changed = false;

            if (isTavernHelperRealtimeMask()) {
                try {
                    cleanText = cleanser.clean(rawText);
                    changed = cleanText !== rawText;
                } catch (error) {
                    cleanser.reset();
                    logger.warn(`[streaming] 预渲染实时净化失败，已跳过本帧: ${error?.message || error}`);
                    cleanText = text;
                }
            } else {
                cleanser.reset();
            }

            const result = await originalOnProgress.call(this, messageId, cleanText, isFinal);
            if (changed) markStreamingMessagePending(Number(messageId));
            if (isFinal === true) cleanser.reset();
            return result;
        };
        return true;
    };
    installStreamingProcessorCleanserFromEvents = installStreamingProcessorCleanser;

    const streamingVisualMessageQueue = new Set();
    let streamingVisualFlushQueued = false;

    const hasStreamingUnsafeRegexProcessors = () => buildProcessors({ includeAiRewrite: true })
        .some((proc) => proc.kind === 'regex' && proc.domSafe === false);

    const getLatestStreamingAssistantIndex = () => {
        const { chat } = getAppContext();
        if (!Array.isArray(chat)) return -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (isAssistantMessage(chat[i])) return i;
        }
        return -1;
    };

    const queueStreamingVisualMicrotask = () => {
        if (streamingVisualFlushQueued) return;
        streamingVisualFlushQueued = true;
        if (typeof window.queueMicrotask === 'function') {
            window.queueMicrotask(flushStreamingVisualQueue);
            return;
        }
        Promise.resolve().then(flushStreamingVisualQueue);
    };

    const flushStreamingVisualQueue = () => {
        streamingVisualFlushQueued = false;
        if (!runtimeState.isStreamingGeneration || !isSimpleVisualRealtimeMask() || streamingVisualMessageQueue.size === 0) {
            streamingVisualMessageQueue.clear();
            return;
        }

        const latestIndex = getLatestStreamingAssistantIndex();
        const pendingNodes = [...streamingVisualMessageQueue];
        streamingVisualMessageQueue.clear();
        if (latestIndex < 0) return;

        const touchedMessageIndices = new Set();
        const hasUnsafeRegex = hasStreamingUnsafeRegexProcessors();
        isPurifying = true;
        try {
            pendingNodes.forEach((mesNode) => {
                if (!mesNode?.isConnected || isRevertedMessageDomNode(mesNode)) return;

                const index = resolveNodeMessageIndex(mesNode);
                if (index !== latestIndex) return;

                let changed = purifyStreamingMessageDom(mesNode);
                if (hasUnsafeRegex && purifyStreamingMessageDom(mesNode, { unsafeRegexOnly: true })) {
                    changed = true;
                }
                if (!changed) return;

                const touchedIndex = primePendingComparisonForNode(mesNode, { skipPersist: true });
                if (touchedIndex >= 0) touchedMessageIndices.add(touchedIndex);
            });
        } finally {
            chatObserver.takeRecords();
            injectDiffButtonsStreamingSafe([...touchedMessageIndices]);
            isPurifying = false;
        }
    };

    const queueStreamingVisualPurify = (messageNodes) => {
        if (!runtimeState.isStreamingGeneration || !isSimpleVisualRealtimeMask() || !messageNodes || messageNodes.size === 0) return;
        messageNodes.forEach((mesNode) => {
            if (mesNode?.isConnected && isTrackableMessageDomNode(mesNode)) {
                streamingVisualMessageQueue.add(mesNode);
            }
        });
        if (streamingVisualMessageQueue.size === 0) return;
        queueStreamingVisualMicrotask();
    };

    const applyMutationTextMask = (textNode, isStreaming) => {
        const original = textNode?.nodeValue || '';
        if (!original) return false;
        if (isStreaming) return false;

        const nextValue = applyScopedReplacements(original, { deterministic: true, domSafeOnly: true });
        if (original === nextValue) return false;
        textNode.nodeValue = nextValue;
        return true;
    };

    const chatObserver = new MutationObserver((mutations) => {
        if (isPurifying) return;
        const isStreaming = runtimeState.isStreamingGeneration;

        const processors = buildProcessors({ includeAiRewrite: isStreaming });
        if (processors.length === 0) return;
        
        const touchedMessageIndices = new Set();
        const streamingMessageNodes = new Set();
        isPurifying = true;
        try {
            for (let mi = 0; mi < mutations.length; mi++) {
                const m = mutations[mi];
                for (let ni = 0; ni < m.addedNodes.length; ni++) {
                    const node = m.addedNodes[ni];
                    if (node.nodeType === 3 || node.nodeType === 8) {
                        if (node.parentNode && isProtectedNode(node.parentNode)) continue;
                        if (node.parentNode && isRevertedMessageDomNode(node.parentNode)) continue;
                        if (node.parentNode && getAppContext().extension_settings?.[extensionName]?.skipUserMessages && isUserMessageDomNode(node.parentNode)) continue;
                        const mesNode = isStreaming ? getClosestTrackableMessageNode(node) : null;
                        if (mesNode) {
                            streamingMessageNodes.add(mesNode);
                            continue;
                        }
                        applyMutationTextMask(node, false);
                    } else if (node.nodeType === 1) {
                        const messageNodes = [];
                        collectMessageNodes(node, messageNodes);
                        if (isStreaming) {
                            const closestMesNode = getClosestTrackableMessageNode(node);
                            if (closestMesNode) streamingMessageNodes.add(closestMesNode);
                            messageNodes.forEach((mesNode) => streamingMessageNodes.add(mesNode));
                            if (closestMesNode || messageNodes.length > 0) continue;
                            if (!node.closest?.('.mes')) purifyDOM(node);
                        } else {
                            purifyDOM(node);
                            messageNodes.forEach((mesNode) => {
                                const index = primePendingComparisonForNode(mesNode);
                                if (index >= 0) touchedMessageIndices.add(index);
                            });
                        }
                    }
                }
                if (m.type === 'characterData') {
                    if (m.target.parentNode && isProtectedNode(m.target.parentNode)) continue;
                    if (m.target.parentNode && isRevertedMessageDomNode(m.target.parentNode)) continue;
                    if (m.target.parentNode && getAppContext().extension_settings?.[extensionName]?.skipUserMessages && isUserMessageDomNode(m.target.parentNode)) continue;
                    const mesNode = isStreaming ? getClosestTrackableMessageNode(m.target) : null;
                    if (mesNode) {
                        streamingMessageNodes.add(mesNode);
                        continue;
                    }
                    applyMutationTextMask(m.target, false);
                }
            }

            if (isStreaming) {
                queueStreamingVisualPurify(streamingMessageNodes);
            }
        } finally {
            chatObserver.takeRecords();
            injectDiffButtonsStreamingSafe([...touchedMessageIndices]);
            isPurifying = false;
        }
    });

    const chatEl = document.getElementById('chat');
    if (chatEl) chatObserver.observe(chatEl, { childList: true, subtree: true, characterData: true });

    let currentTheaterShadow = null;
    const theaterIntervalId = setInterval(() => {
        const theaterHost = document.querySelector('#t-output-content .t-shadow-host');
        if (theaterHost && theaterHost.shadowRoot) {
            if (currentTheaterShadow !== theaterHost) {
                chatObserver.observe(theaterHost.shadowRoot, { childList: true, subtree: true, characterData: true });
                currentTheaterShadow = theaterHost;
                isPurifying = true;
                try { purifyDOM(theaterHost.shadowRoot); } catch (err) {} finally { isPurifying = false; }
            }
        } else {
            currentTheaterShadow = null;
        }
    }, 800);
    window.addEventListener('beforeunload', () => clearInterval(theaterIntervalId), { once: true });

    document.addEventListener('input', (e) => {
        const el = e.target;
        if (!['TEXTAREA', 'INPUT'].includes(el.tagName) || isProtectedNode(el)) return;
        buildProcessors();
        if (runtimeState.activeProcessors.length === 0) return;
        const originalVal = el.value || '';
        const cleanedVal = applyScopedReplacements(originalVal, { deterministic: true });
        if (originalVal !== cleanedVal) {
            const start = el.selectionStart;
            isPurifying = true;
            try {
                el.value = cleanedVal;
                try { el.setSelectionRange(start, start); } catch (err) {}
            } finally {
                isPurifying = false;
            }
        }
    }, true);
}

export function bindEvents() {

    function checkUnsavedChanges() {
        const settings = extension_settings[extensionName];
        const active = settings.activePreset;
        if (!active) return false;
        return hasPresetContentChanges(settings.rules || [], settings.presets[active] || [], settings.aiRewrite);
    }

    function buildCurrentPresetEntry(rules) {
        const settings = extension_settings[extensionName];
        return buildPresetEntry(rules, getCurrentPresetAiRewriteSettings(settings.aiRewrite));
    }

    function extractPresetImportAiRewriteSettings(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
        const direct = normalizePresetAiRewriteSettings(payload.aiRewrite);
        if (direct) return direct;
        if ('__content__' in payload) return extractPresetImportAiRewriteSettings(payload.__content__);
        if ('content' in payload) return extractPresetImportAiRewriteSettings(payload.content);
        return null;
    }

    function normalizeImportedRuleList(rules) {
        return (Array.isArray(rules) ? rules : []).map((rule, idx) => {
            const next = deepClone(rule || {});
            stripAiConnectionFields(next);
            if (!next.name) next.name = next.targets?.[0] || `未命名合集 ${idx + 1}`;
            if (next.enabled === undefined) next.enabled = true;
            if (next.targets) {
                next.subRules = [{
                    targets: next.targets,
                    replacements: next.replacements || [],
                    mode: 'text',
                    enabled: true,
                }];
                delete next.targets;
                delete next.replacements;
            }
            if (!Array.isArray(next.subRules)) next.subRules = [];
            next.subRules = next.subRules.map((sub) => {
                const normalizedSub = deepClone(sub || {});
                if (!normalizedSub.mode) normalizedSub.mode = 'text';
                if (!['program', 'ai'].includes(normalizedSub.rewriteMode)) normalizedSub.rewriteMode = 'program';
                if (normalizedSub.enabled === undefined) normalizedSub.enabled = true;
                if (!Array.isArray(normalizedSub.targets)) normalizedSub.targets = [];
                if (!Array.isArray(normalizedSub.replacements)) normalizedSub.replacements = [];
                normalizedSub.aiPromptTemplate = String(normalizedSub.aiPromptTemplate || '');
                return normalizedSub;
            });
            return next;
        });
    }

    function stripAiConnectionFields(value) {
        if (!value || typeof value !== 'object') return value;
        if (Array.isArray(value)) {
            value.forEach(stripAiConnectionFields);
            return value;
        }
        delete value.baseUrl;
        delete value.apiKey;
        delete value.model;
        delete value.modelOptions;
        delete value.xmlScopeTag;
        Object.values(value).forEach(stripAiConnectionFields);
        return value;
    }

    function buildPresetExportRules(rules) {
        return stripAiConnectionFields(deepClone(Array.isArray(rules) ? rules : []));
    }

    function buildPresetExportPayload(settings) {
        return {
            type: 'veridis-rewrite-preset',
            version: 2,
            ...buildPresetEntry(buildPresetExportRules(settings.rules), getCurrentPresetAiRewriteSettings(settings.aiRewrite)),
        };
    }

    function makeUniquePresetName(baseName) {
        const settings = extension_settings[extensionName];
        const base = String(baseName || '').trim() || '导入预设';
        if (!settings.presets?.[base]) return base;
        let counter = 2;
        while (settings.presets?.[`${base} (${counter})`]) counter++;
        return `${base} (${counter})`;
    }

    function getImportPresetName() {
        return String($('#blai-import-preset-name').val() || '').trim();
    }

    function closeImportChoiceModal() {
        runtimeState.importPresetDraft = null;
        $('#blai-preset-import-choice-modal')
            .removeClass('blai-is-open')
            .attr('aria-hidden', 'true')
            .hide();
    }

    function openImportChoiceModal(rules, defaultName, aiRewriteSettings = null) {
        const normalizedRules = normalizeImportedRuleList(rules);
        if (normalizedRules.length === 0) {
            alert('导入失败：未发现有效规则。');
            return;
        }
        const presetName = makeUniquePresetName(defaultName);
        runtimeState.importPresetDraft = {
            rules: normalizedRules,
            defaultName: presetName,
            aiRewrite: normalizePresetAiRewriteSettings(aiRewriteSettings),
        };
        $('#blai-import-preset-name').val(presetName);
        const aiSummary = runtimeState.importPresetDraft.aiRewrite ? '，包含 AI 生成限制' : '';
        $('#blai-import-choice-summary').text(`已读取 ${normalizedRules.length} 个规则分组${aiSummary}。只导入不会修改当前规则；切换使用和临时预览会替换当前规则并重新净化。`);
        const $modal = $('#blai-preset-import-choice-modal');
        $modal.detach().appendTo(document.body);
        $modal
            .attr('aria-hidden', 'false')
            .addClass('blai-is-open')
            .css('display', 'flex');
        // iOS browsers sometimes need a layout pass after the file picker returns.
        $modal[0]?.getBoundingClientRect();
        window.setTimeout(() => $('#blai-import-preset-name').trigger('focus').trigger('select'), 50);
    }

    function confirmBeforeImportChoiceIfUnsaved() {
        const settings = extension_settings[extensionName];
        const active = settings.activePreset;
        if (!active || !checkUnsavedChanges()) return true;
        return confirm(`当前预设 "${active}" 有未保存的改动。\n\n只导入为新预设不会修改当前规则；导入并切换或临时预览会在执行前再次确认保存。\n\n是否继续选择导入方式？`);
    }

    function validateImportPresetName() {
        const settings = extension_settings[extensionName];
        const name = getImportPresetName();
        if (!name) {
            alert('请填写预设名称。');
            $('#blai-import-preset-name').trigger('focus');
            return '';
        }
        if (settings.presets?.[name]) {
            alert('存档名称已存在，请换一个名称。');
            $('#blai-import-preset-name').trigger('focus').trigger('select');
            return '';
        }
        return name;
    }

    function confirmUnsavedBeforeReplacingCurrentRules(actionLabel) {
        const settings = extension_settings[extensionName];
        const active = settings.activePreset;
        if (!active || !checkUnsavedChanges()) return true;
        const shouldSave = confirm(`当前预设 "${active}" 有未保存的改动。\n\n点击“确定”先保存并继续${actionLabel}。\n点击“取消”将取消本次导入操作。`);
        if (!shouldSave) return false;
        settings.presets[active] = buildCurrentPresetEntry(settings.rules || []);
        saveSettingsDebounced();
        markPresetsUiDirty(true);
        return true;
    }

    function getImportDraftRules() {
        const draft = runtimeState.importPresetDraft;
        return Array.isArray(draft?.rules) ? deepClone(draft.rules) : null;
    }

    function getImportDraftAiRewriteSettings() {
        return normalizePresetAiRewriteSettings(runtimeState.importPresetDraft?.aiRewrite);
    }

    function applyImportDraftAiRewriteSettings() {
        const aiRewriteSettings = getImportDraftAiRewriteSettings();
        if (!aiRewriteSettings) return false;
        const currentSettings = extension_settings[extensionName];
        currentSettings.aiRewrite = {
            ...defaultAiRewriteSettings,
            ...(currentSettings.aiRewrite && typeof currentSettings.aiRewrite === 'object' ? currentSettings.aiRewrite : {}),
            ...aiRewriteSettings,
        };
        syncAiRewriteSettingsUI();
        return true;
    }

    function importPresetOnly() {
        const settings = extension_settings[extensionName];
        const rules = getImportDraftRules();
        if (!rules) return;
        const name = validateImportPresetName();
        if (!name) return;

        settings.presets[name] = buildPresetEntry(rules, getImportDraftAiRewriteSettings());
        markPresetsUiDirty(true);
        saveSettingsDebounced();
        updateToolbarUI();
        closeImportChoiceModal();
        showToast(`已导入预设：${name}`);
    }

    function importPresetAndSwitch() {
        const settings = extension_settings[extensionName];
        const rules = getImportDraftRules();
        if (!rules) return;
        const name = validateImportPresetName();
        if (!name) return;
        if (!confirmUnsavedBeforeReplacingCurrentRules('并切换使用导入预设')) return;

        settings.presets[name] = buildPresetEntry(rules, getImportDraftAiRewriteSettings());
        settings.activePreset = name;
        settings.rules = deepClone(rules);
        applyImportDraftAiRewriteSettings();
        markRulesDataDirty({ presetsUi: true });
        saveSettingsDebounced();
        updateToolbarUI();
        renderTags();
        performGlobalCleanse();
        closeImportChoiceModal();
        showToast(`已导入并切换：${name}`);
    }

    function importPresetAsTemporaryPreview() {
        const settings = extension_settings[extensionName];
        const rules = getImportDraftRules();
        if (!rules) return;
        if (!confirm('仅临时预览会立刻替换当前规则，但不会保存为预设。\n确定继续吗？')) return;
        if (!confirmUnsavedBeforeReplacingCurrentRules('并进入临时预览')) return;

        settings.rules = rules;
        settings.activePreset = "";
        applyImportDraftAiRewriteSettings();
        markRulesDataDirty();
        saveSettingsDebounced();
        updateToolbarUI();
        renderTags();
        performGlobalCleanse();
        closeImportChoiceModal();
        showToast('已进入临时规则预览');
    }

    const { extension_settings, saveSettingsDebounced, eventSource, event_types } = getAppContext();
    const formatRegexTargetError = (error) => `第 ${error.line} 行：${error.message}`;
    const clearRegexTargetValidationState = () => {
        $('#blai-modal-sub-target').removeClass('blai-invalid').removeAttr('aria-invalid');
        $('#blai-modal-sub-target-error').removeClass('is-visible').text('');
    };
    const applyRegexTargetValidationError = (error) => {
        const message = formatRegexTargetError(error);
        $('#blai-modal-sub-target').addClass('blai-invalid').attr('aria-invalid', 'true');
        $('#blai-modal-sub-target-error').addClass('is-visible').text(message);
        return message;
    };
    const subruleModeUIMap = {
        simple: {
            hint: '适合批量覆盖相近表达，支持 {} 组合和 * 通配。',
            targetPlaceholder: "简易语法 (每行一条)\n例如：{宛若,如同}{神明,恶魔}?",
            replacementPlaceholder: "替换后词汇（每行一条，支持随机，可留空）\n留空时，命中后会直接删除",
        },
        text: {
            hint: '按普通词组逐项替换，适合稳定短语，长词会优先处理。',
            targetPlaceholder: "被替换词汇 (逗号/空格分隔)\n例如：嘴角勾起, 并不存在",
            replacementPlaceholder: "替换后词汇（逗号/空格分隔，可留空）\n留空时，命中后会直接删除",
        },
        regex: {
            hint: '适合复杂匹配和捕获组替换；每次命中会从替换项里随机选一个。',
            targetPlaceholder: "正则匹配规则 (每行一条)\n支持裸模式 foo|bar 或 /foo|bar/gmu",
            replacementPlaceholder: "替换模板（每行一条，支持随机；可用 $1、\\n，可留空）\n点“按行识别”后加入下方替换项",
            regexEditPlaceholder: "正在编辑替换项；可用 $1、\\n\n点“更新替换项”保存修改",
        },
    };
    const validateRegexTargetField = (options = {}) => {
        const mode = String($('#blai-modal-sub-mode').val() || '');
        if (mode !== 'regex') {
            clearRegexTargetValidationState();
            return { ok: true, parsed: [] };
        }

        const result = validateRegexTargetInput($('#blai-modal-sub-target').val());
        if (result.ok) {
            clearRegexTargetValidationState();
            return result;
        }

        const uiMessage = applyRegexTargetValidationError(result.error);
        if (options.focus === true) $('#blai-modal-sub-target').trigger('focus');
        if (options.toast === true) showToast(`正则规则有误：${uiMessage}`);
        return { ...result, uiMessage };
    };
    const applySubruleModeUI = (rawMode) => {
        const mode = subruleModeUIMap[rawMode] ? rawMode : 'simple';
        const config = subruleModeUIMap[mode];
        const previousMode = String($('#blai-modal-sub-mode').data('current-mode') || '');
        if (previousMode && previousMode !== mode) {
            const previousReplacements = getSingleRuleReplacementValues(previousMode);
            setSingleRuleReplacementEditor(mode, previousReplacements);
        }
        $('#blai-modal-sub-mode').data('current-mode', mode);
        $('#blai-modal-sub-target').attr('placeholder', config.targetPlaceholder);
        $('#blai-modal-sub-rep').attr('placeholder', config.replacementPlaceholder);
        if (mode === 'regex') {
            $('#blai-modal-sub-rep')
                .data('regex-default-placeholder', config.replacementPlaceholder)
                .data('regex-edit-placeholder', config.regexEditPlaceholder || config.replacementPlaceholder);
            const activeEditIndex = Number($('#blai-modal-sub-rep').data('regex-edit-index'));
            $('#blai-modal-sub-regex-recognize').text(activeEditIndex >= 0 ? '更新替换项' : '按行识别');
            $('#blai-modal-sub-rep').attr('placeholder', activeEditIndex >= 0
                ? (config.regexEditPlaceholder || config.replacementPlaceholder)
                : config.replacementPlaceholder);
        } else {
            $('#blai-modal-sub-rep')
                .removeData('regex-default-placeholder')
                .removeData('regex-edit-placeholder');
        }
        $('#blai-modal-sub-mode-hint').text(config.hint);
        validateRegexTargetField();
    };
    const applySubruleRewriteModeUI = () => {
        const rewriteMode = $('#blai-modal-sub-rewrite-mode').val() === 'ai' ? 'ai' : 'program';
        const isAiMode = rewriteMode === 'ai';
        $('#blai-modal-sub-rep-label').text(isAiMode ? '流式临时替换 / API 参考候选' : '替换为');
        $('#blai-modal-sub-rewrite-hint').text(isAiMode
            ? '生成中只做视觉预览，生成结束后把命中片段发给配置的 AI 接口局部改写。'
            : '沿用当前本地替换逻辑，生成结束后直接写入消息数据。');
        $('#blai-modal-sub-ai-prompt-field').prop('hidden', !isAiMode);
        $('#blai-modal-sub-ai-prompt').prop('disabled', !isAiMode);
        $('#blai-modal-sub-ai-prompt-hint').text('只填写这条规则命中时的特殊处理；通用风格仍由全局提示词控制。');
    };
    const clearScopeTagValidationState = () => {
        $('#blai-scope-tag-input').removeClass('blai-invalid').removeAttr('aria-invalid');
        $('#blai-scope-tag-error').removeClass('is-visible').text('');
    };
    const applyScopeTagValidationError = (message) => {
        $('#blai-scope-tag-input').addClass('blai-invalid').attr('aria-invalid', 'true');
        $('#blai-scope-tag-error').addClass('is-visible').text(message);
    };
    const getScopeTagEditId = () => String($('#blai-scope-tag-input').data('scope-edit-id') || '');
    const resetScopeTagEditor = () => {
        $('#blai-scope-tag-input').val('').data('scope-edit-id', '');
        $('#blai-scope-tag-label-input').val('');
        $('#blai-scope-tag-group-select').val(DEFAULT_SCOPE_TAG_GROUP_ID);
        $('#blai-scope-tag-editor-modal').prop('hidden', true);
        $('#blai-scope-group-manager-modal').prop('hidden', true);
        $('#blai-scope-tag-action-menu').prop('hidden', true);
        $('#blai-scope-tag-menu-open').attr('aria-expanded', 'false');
        clearScopeTagValidationState();
        renderScopeTagsModal();
    };
    const normalizeScopeTagDraftStart = (tagText) => {
        const trimmed = String(tagText || '').trim();
        if (/^<[^<>/\s]+>$/.test(trimmed)) return trimmed;
        return `<${trimmed.replace(/[<>]/g, '')}>`;
    };
    const buildScopeTagInputFromEditor = () => {
        const rawTagText = String($('#blai-scope-tag-input').val() || '').trim();
        const labelText = String($('#blai-scope-tag-label-input').val() || '').trim();
        if (!rawTagText) return '';
        if (rawTagText.includes('//')) {
            const [tagPart, ...labelParts] = rawTagText.split('//');
            const inlineLabel = labelParts.join('//').trim();
            const normalizedLabel = labelText || inlineLabel;
            const tagSource = normalizeScopeTagDraftStart(tagPart);
            return normalizedLabel ? `${tagSource}//${normalizedLabel}` : tagSource;
        }
        const tagSource = normalizeScopeTagDraftStart(rawTagText);
        return labelText ? `${tagSource}//${labelText}` : tagSource;
    };
    const getScopeTagGroups = () => normalizeScopeTagGroupList(settings.scopeTagGroups);
    const getScopeTagGroupIds = () => new Set(getScopeTagGroups().map((group) => group.id));
    const resolveScopeTagGroupId = (groupId) => {
        const candidate = String(groupId || DEFAULT_SCOPE_TAG_GROUP_ID).trim() || DEFAULT_SCOPE_TAG_GROUP_ID;
        return getScopeTagGroupIds().has(candidate) ? candidate : DEFAULT_SCOPE_TAG_GROUP_ID;
    };
    const renderScopeTagGroupOptions = (selectedGroupId = DEFAULT_SCOPE_TAG_GROUP_ID) => {
        const groups = getScopeTagGroups();
        const resolvedGroupId = resolveScopeTagGroupId(selectedGroupId);
        const $select = $('#blai-scope-tag-group-select');
        $select.empty();
        groups.forEach((group) => {
            $('<option>').val(group.id).text(group.name).appendTo($select);
        });
        $select.val(resolvedGroupId);
    };
    const getSelectedScopeTagGroupId = () => resolveScopeTagGroupId($('#blai-scope-tag-group-select').val());
    const normalizeScopeTagsToKnownGroups = (scopeTags) => {
        const groupIds = getScopeTagGroupIds();
        return normalizeScopeTagList(scopeTags).map((tag) => {
            const groupId = String(tag.groupId || DEFAULT_SCOPE_TAG_GROUP_ID).trim() || DEFAULT_SCOPE_TAG_GROUP_ID;
            return groupIds.has(groupId) ? tag : { ...tag, groupId: DEFAULT_SCOPE_TAG_GROUP_ID };
        });
    };
    const closeScopeTagActionMenu = () => {
        $('#blai-scope-tag-action-menu').prop('hidden', true);
        $('#blai-scope-tag-menu-open').attr('aria-expanded', 'false');
    };
    const renderScopeGroupManager = (focusGroupId = '') => {
        const groups = getScopeTagGroups();
        const html = groups.map((group, index) => {
            const isDefault = group.id === DEFAULT_SCOPE_TAG_GROUP_ID;
            const moveUpDisabled = index === 0 ? 'disabled' : '';
            const moveDownDisabled = index === groups.length - 1 ? 'disabled' : '';
            const deleteDisabled = isDefault ? 'disabled' : '';
            return `
                <div class="blai-scope-group-manager-item" data-group-id="${escapeHtml(group.id)}">
                    <input type="text" class="blai-scope-group-name-input" data-group-id="${escapeHtml(group.id)}" value="${escapeHtml(group.name)}" aria-label="分组名称">
                    <div class="blai-scope-group-manager-item-actions">
                        <button type="button" class="blai-icon-btn blai-scope-group-move-up" data-group-id="${escapeHtml(group.id)}" title="上移分组" ${moveUpDisabled}><i class="fas fa-arrow-up"></i></button>
                        <button type="button" class="blai-icon-btn blai-scope-group-move-down" data-group-id="${escapeHtml(group.id)}" title="下移分组" ${moveDownDisabled}><i class="fas fa-arrow-down"></i></button>
                        <button type="button" class="blai-icon-btn blai-scope-group-delete blai-danger-btn" data-group-id="${escapeHtml(group.id)}" title="${isDefault ? '默认分组不可删除' : '删除分组'}" ${deleteDisabled}><i class="fas fa-trash"></i></button>
                    </div>
                </div>
            `;
        }).join('');
        $('#blai-scope-group-manager-list').html(html || '<div class="blai-empty-state">暂无分组</div>');
        if (focusGroupId) {
            window.setTimeout(() => {
                const escapedGroupId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
                    ? CSS.escape(focusGroupId)
                    : String(focusGroupId).replace(/["\\]/g, '\\$&');
                $(`#blai-scope-group-manager-list .blai-scope-group-name-input[data-group-id="${escapedGroupId}"]`).trigger('focus').trigger('select');
            }, 20);
        }
    };
    const openScopeTagEditor = (scopeTag = null) => {
        const formattedInput = scopeTag ? formatScopeTagInput(scopeTag) : '';
        const tagSource = formattedInput.split('//')[0]?.trim() || '';
        const tagName = tagSource.match(/^<([^<>/\s]+)>$/)?.[1] || tagSource;
        renderScopeTagGroupOptions(scopeTag?.groupId || DEFAULT_SCOPE_TAG_GROUP_ID);
        $('#blai-scope-tag-input')
            .val(scopeTag ? tagName : '')
            .data('scope-edit-id', scopeTag?.id || '');
        $('#blai-scope-tag-label-input').val(scopeTag?.label || '');
        clearScopeTagValidationState();
        renderScopeTagsModal();
        $('#blai-scope-tag-editor-modal').prop('hidden', false);
        window.setTimeout(() => {
            $('#blai-scope-tag-input').trigger('focus');
        }, 20);
    };
    const setScopeTagMode = (mode) => {
        const nextMode = mode === 'cleanse-inside' ? 'cleanse-inside' : 'protect';
        if (settings.scopeTagMode === nextMode) {
            renderScopeTagsModal();
            return;
        }
        settings.scopeTagMode = nextMode;
        saveSettingsDebounced();
        renderScopeTagsModal();
        performGlobalCleanse();
        showToast(settings.scopeTagMode === 'cleanse-inside' ? '已切换为净化特定标签' : '已切换为保护特定标签');
    };
    const persistScopeTagGroups = (groups, options = {}) => {
        const normalizedGroups = normalizeScopeTagGroupList(groups);
        settings.scopeTagGroups = normalizedGroups;
        settings.scopeTagCollapsedGroups = normalizeScopeTagCollapsedGroupList(settings.scopeTagCollapsedGroups, normalizedGroups);
        const knownGroupIds = new Set(normalizedGroups.map((group) => group.id));
        const currentScopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
        settings.scopeTags = normalizeScopeTagList(currentScopeTags).map((tag) => {
            const groupId = String(tag.groupId || DEFAULT_SCOPE_TAG_GROUP_ID).trim() || DEFAULT_SCOPE_TAG_GROUP_ID;
            return knownGroupIds.has(groupId) ? tag : { ...tag, groupId: DEFAULT_SCOPE_TAG_GROUP_ID };
        });
        saveSettingsDebounced();
        renderScopeTagsModal();
        renderScopeTagGroupOptions($('#blai-scope-tag-group-select').val() || DEFAULT_SCOPE_TAG_GROUP_ID);
        renderScopeGroupManager(options.focusGroupId || '');
    };
    const persistScopeTags = (scopeTags, options = {}) => {
        settings.scopeTagGroups = getScopeTagGroups();
        const sourceScopeTags = normalizeScopeTagsToKnownGroups(scopeTags);
        const representedBuiltinKeys = new Set(sourceScopeTags.map((tag) => tag.builtinKey).filter(Boolean));
        const dismissedBuiltinKeys = normalizeScopeTagBuiltinDismissedList(options.dismissedBuiltinKeys ?? settings.scopeTagBuiltinDismissed)
            .filter((builtinKey) => !representedBuiltinKeys.has(builtinKey));
        const normalized = mergeScopeTagsWithBuiltins(sourceScopeTags, dismissedBuiltinKeys);
        settings.scopeTagBuiltinDismissed = dismissedBuiltinKeys;
        settings.scopeTags = normalizeScopeTagsToKnownGroups(normalized);
        saveSettingsDebounced();
        renderScopeTagsModal();
        if (options.skipCleanse !== true) performGlobalCleanse();
        return normalized;
    };
    const saveScopeTag = () => {
        const rawInput = buildScopeTagInputFromEditor();
        const parsed = parseScopeTagInput(rawInput);
        if (!parsed.ok) {
            applyScopeTagValidationError(parsed.error.message);
            $('#blai-scope-tag-input').trigger('focus');
            return false;
        }

        const editId = getScopeTagEditId();
        const scopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
        const currentTag = editId ? scopeTags.find((tag) => tag.id === editId) : null;
        const duplicate = scopeTags.find((tag) => tag.startTag === parsed.value.startTag && tag.id !== editId);
        if (duplicate) {
            applyScopeTagValidationError('该范围标签已存在，无需重复添加。');
            $('#blai-scope-tag-input').trigger('focus');
            return false;
        }

        const currentBuiltinKey = currentTag?.builtinKey || '';
        const inferredBuiltinKey = getBuiltinScopeTagKeyForStartTag(parsed.value.startTag);
        const nextBuiltinKey = currentBuiltinKey
            ? (inferredBuiltinKey || currentBuiltinKey)
            : inferredBuiltinKey;
        const dismissedBuiltinKeys = [...normalizeScopeTagBuiltinDismissedList(settings.scopeTagBuiltinDismissed)];
        if (currentBuiltinKey && inferredBuiltinKey && inferredBuiltinKey !== currentBuiltinKey) {
            dismissedBuiltinKeys.push(currentBuiltinKey);
        }

        const nextScopeTag = {
            id: editId || createScopeTagId(),
            startTag: parsed.value.startTag,
            endTag: parsed.value.endTag,
            label: parsed.value.label,
            groupId: getSelectedScopeTagGroupId(),
            enabled: currentTag ? currentTag.enabled !== false : true,
        };
        if (nextBuiltinKey) nextScopeTag.builtinKey = nextBuiltinKey;
        const updated = editId
            ? scopeTags.map((tag) => (tag.id === editId ? { ...tag, ...nextScopeTag, enabled: tag.enabled !== false } : tag))
            : [...scopeTags, nextScopeTag];

        persistScopeTags(updated, { dismissedBuiltinKeys });
        showToast(editId ? '范围标签已更新' : '范围标签已添加');
        resetScopeTagEditor();
        return true;
    };

    $(document).off('click', '#blai-wand-btn, #blai-wand-btn-panel, #blai-extension-settings-entry').on('click', '#blai-wand-btn, #blai-wand-btn-panel, #blai-extension-settings-entry', () => {
        updateToolbarUI();
        updateLegacyPurifierWarning();
        showResponsivePage('overview');
        renderTags();
        renderScopeTagsModal();
        $('#blai-purifier-popup').css('display', 'grid').hide().fadeIn(200);
        void runAiModelsHealthCheck({ silent: true });
    });

    $(document).off('click', '#blai-purifier-popup [data-page-target]').on('click', '#blai-purifier-popup [data-page-target]', function(e) {
        e.preventDefault();
        const pageId = String($(this).attr('data-page-target') || 'overview');
        showResponsivePage(pageId);
        if (pageId === 'clean') renderScopeTagsModal();
    });

    $(document).off('click', '#blai-purifier-popup [data-blai-click-proxy]').on('click', '#blai-purifier-popup [data-blai-click-proxy]', function(e) {
        e.preventDefault();
        const selector = String($(this).attr('data-blai-click-proxy') || '');
        const target = selector ? document.querySelector(selector) : null;
        $('#blai-character-bind-toggle').attr('aria-expanded', 'false');
        if (target && target.disabled) {
            const $target = $(target);
            const message = String($target.find('.blai-bind-menu-note').text() || $target.attr('title') || '当前操作不可用').trim();
            showToast(message);
            refreshCharacterBindingUI();
            return;
        }
        if (target) target.click();
    });

    $(document).off('click', '#blai-ai-api-check').on('click', '#blai-ai-api-check', function(e) {
        e.preventDefault();
        void runAiModelsHealthCheck({ silent: false });
    });

    $(document).off('click', '#blai-ai-copy-log').on('click', '#blai-ai-copy-log', async function(e) {
        e.preventDefault();
        const logText = getAiRewriteDebugLogText();
        if (!logText || logText === '[]') {
            showToast('暂无 AI 改写日志');
            return;
        }
        try {
            await navigator.clipboard.writeText(logText);
            showToast('AI Debug 日志已复制');
        } catch (error) {
            logger.warn('复制 AI 改写日志失败', error);
            showToast('复制 Debug 日志失败，请打开浏览器控制台查看 window.__veridisAiRewriteLog');
        }
    });

    $(document).off('click', '#blai-close-legacy-plugin').on('click', '#blai-close-legacy-plugin', function(e) {
        e.preventDefault();
        const detected = updateLegacyPurifierWarning();
        const legacyEntry = document.getElementById('bl-extension-settings-entry') || document.getElementById('bl-wand-btn');
        if (legacyEntry) {
            $('#blai-purifier-popup').fadeOut(120);
            legacyEntry.scrollIntoView({ behavior: 'smooth', block: 'center' });
            legacyEntry.classList.remove('blai-legacy-target-flash');
            void legacyEntry.offsetWidth;
            legacyEntry.classList.add('blai-legacy-target-flash');
            window.setTimeout(() => legacyEntry.classList.remove('blai-legacy-target-flash'), 1800);
        }
        showToast(detected
            ? '请关闭旧插件 Veridis-Keyword-filtering-main 后刷新页面'
            : '未检测到旧版 purifier');
    });

    $(document).off('click', '#blai-close-btn').on('click', '#blai-close-btn', () => {
        if (checkUnsavedChanges()) {
            if (confirm(`预设 "${extension_settings[extensionName].activePreset}" 有未保存的规则或 AI 生成限制改动，是否保存？\n点击【确定】保存，点击【取消】直接关闭放弃改动。`)) {
                $('#blai-preset-save').click();
            } else {
                // 放弃保存时回滚到已保存状态，避免脏数据残留。
                applyPresetByName(extension_settings[extensionName].activePreset, { skipRender: true });
            }
        }
        closeRuleSearchModal({ reset: true });
        closeScopeTagsModal({ reset: true });
        $('#blai-purifier-popup').fadeOut(200);
    });
    const settings = extension_settings[extensionName];
    normalizeZhVariantSettings(settings);
    const isSearchGroupEditFlow = () => runtimeState.searchEditFlow.active === true && runtimeState.searchEditFlow.returnMode === 'group';
    const isSearchDirectSubruleFlow = () => runtimeState.searchEditFlow.active === true && runtimeState.searchEditFlow.returnMode === 'subrule';
    const isRelatedDirectSubruleFlow = () => runtimeState.searchEditFlow.active === true && runtimeState.searchEditFlow.returnMode === 'related';
    const resetRuleSearchQueryState = () => {
        runtimeState.ruleSearchKeyword = '';
        runtimeState.ruleSearchDraftKeyword = '';
        runtimeState.ruleSearchHasSearched = false;
        runtimeState.ruleSearchExpandedMenuKey = '';
        clearRuleSearchEditFlow();
    };
    const submitRuleSearch = () => {
        runtimeState.ruleSearchDraftKeyword = String($('#blai-rule-search-input').val() || '');
        runtimeState.ruleSearchKeyword = runtimeState.ruleSearchDraftKeyword.trim();
        runtimeState.ruleSearchHasSearched = runtimeState.ruleSearchKeyword.length > 0;
        runtimeState.ruleSearchExpandedMenuKey = '';
        renderRuleSearchModal();
    };
    const saveCurrentEditingRule = (options = {}) => {
        const {
            toastMessage = '合集保存成功',
            focusLatest = true,
        } = options;
        const rules = extension_settings[extensionName].rules || [];
        const isCreatingNewRule = runtimeState.currentEditingIndex === -1;
        const nameVal = String($('#blai-edit-name').val() || '').trim();
        const validSubrules = runtimeState.currentEditingSubrules.filter(sub => sub.targets && sub.targets.length > 0);

        if (validSubrules.length === 0) {
            showToast('合集内至少需要保留一组有效映射！');
            return { ok: false };
        }

        let isEnabled = true;
        if (runtimeState.currentEditingIndex !== -1 && rules[runtimeState.currentEditingIndex]) {
            isEnabled = rules[runtimeState.currentEditingIndex].enabled !== false;
        }

        const fallbackName = runtimeState.currentEditingIndex !== -1
            ? (rules[runtimeState.currentEditingIndex]?.name || `合集 ${runtimeState.currentEditingIndex + 1}`)
            : `合集 ${rules.length + 1}`;
        const newRule = {
            name: nameVal || fallbackName,
            subRules: validSubrules,
            enabled: isEnabled
        };

        if (runtimeState.currentEditingIndex === -1) rules.push(newRule);
        else rules[runtimeState.currentEditingIndex] = newRule;

        markRulesDataDirty();
        saveSettingsDebounced();
        renderTags();
        if (isCreatingNewRule && focusLatest) {
            window.setTimeout(() => {
                focusLatestRuleCard();
            }, 50);
        }
        performGlobalCleanse();
        renderRuleSearchModal();
        if (toastMessage) showToast(toastMessage);
        return { ok: true, isCreatingNewRule, rule: newRule };
    };

    const applyThemeMode = (mode) => {
        const normalized = ['auto', 'light', 'dark'].includes(mode) ? mode : 'auto';
        const labels = {
            auto: '跟随酒馆',
            light: '白色主题',
            dark: '暗色主题',
        };
        const icons = {
            auto: 'fa-circle-half-stroke',
            light: 'fa-sun',
            dark: 'fa-moon',
        };
        settings.themeMode = normalized;
        $('#blai-purifier-popup, .blai-modal-shell, #blai-rule-transfer-modal, #blai-diff-modal, #blai-rule-search-modal, #blai-preset-import-choice-modal, .blai-toast, #blai-loading-overlay, #blai-scope-tag-editor-modal, #blai-scope-group-manager-modal').attr('data-blai-theme', normalized);
        $('#blai-theme-toggle, #blai-purifier-popup [data-blai-click-proxy="#blai-theme-toggle"]')
            .attr('title', `当前主题：${labels[normalized]}，点击切换`)
            .attr('aria-label', `当前主题：${labels[normalized]}，点击切换`);
        $('#blai-theme-toggle i, #blai-purifier-popup [data-blai-click-proxy="#blai-theme-toggle"] i').attr('class', `fas ${icons[normalized]}`);
    };
    const syncZhCompatToggle = () => {
        const packageStatus = getZhDictionaryPackageStatus(settings);
        const ready = settings.zhVariantCompatEnabled === true
            ? isZhDictionaryReady(settings)
            : packageStatus.ready;
        if (settings.zhVariantCompatEnabled === true && !ready) {
            settings.zhVariantCompatEnabled = false;
        }
        const enabled = settings.zhVariantCompatEnabled === true && ready;
        const options = getZhVariantCompatOptions(settings);
        const regionText = [
            options.tw ? '台繁' : '',
            options.hk ? '港繁' : '',
        ].filter(Boolean).join('、') || '标准简繁';
        $('#blai-zh-dict-status-chip').text(enabled ? '已启用' : packageStatus.ready ? '已安装' : '未安装');
        $('#blai-zh-dict-install-open')
            .toggleClass('accent', !enabled)
            .attr('title', enabled ? '增强简繁词典已启用' : packageStatus.ready ? '增强简繁词典已安装，点击启用' : '下载并启用增强简繁词典');
        $('#blai-zh-compat-toggle')
            .toggleClass('blai-bind-active', enabled)
            .toggleClass('accent', enabled)
            .text(enabled ? '关闭' : '开启')
            .attr('aria-pressed', String(enabled))
            .attr('title', enabled
                ? `简繁兼容已开启：${regionText} 变体参与匹配（点击关闭）`
                : packageStatus.ready
                    ? `简繁兼容已关闭：已安装增强词典，点击启用 ${regionText} 匹配`
                    : '简繁兼容未安装：点击下载 OpenCC 增强词典包');
    };
    const ensureAiRewriteSettings = () => {
        settings.aiRewrite = {
            ...defaultAiRewriteSettings,
            ...(settings.aiRewrite && typeof settings.aiRewrite === 'object' ? settings.aiRewrite : {}),
        };
        settings.aiRewrite.xmlScopeTag = normalizeXmlTagNameInput(settings.aiRewrite.xmlScopeTag, defaultAiRewriteSettings.xmlScopeTag);
        return settings.aiRewrite;
    };
    const isLocalHttpUrl = (value) => {
        try {
            const parsed = new URL(String(value || '').trim());
            if (parsed.protocol !== 'http:') return true;
            return ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'].includes(parsed.hostname);
        } catch {
            return true;
        }
    };
    const buildAiModelsEndpoint = (baseUrl) => {
        const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
        if (!trimmed) return '';
        if (/\/models$/i.test(trimmed)) return trimmed;
        if (/\/chat\/completions$/i.test(trimmed)) return trimmed.replace(/\/chat\/completions$/i, '/models');
        return `${trimmed}/models`;
    };
    const getAiApiCheckTimeoutMs = (aiSettings) => {
        const parsed = Number(aiSettings.timeoutMs);
        if (!Number.isFinite(parsed)) return 15000;
        return Math.min(Math.max(Math.round(parsed), 3000), 30000);
    };
    const getAiTimeoutSeconds = (timeoutMs) => {
        const parsed = Number(timeoutMs);
        const fallback = Number(defaultAiRewriteSettings.timeoutMs) || 120000;
        const normalizedMs = Number.isFinite(parsed) ? parsed : fallback;
        return Math.min(Math.max(Math.round(normalizedMs / 1000), 1), 120);
    };
    const setAiApiCheckState = (state, label, title = '') => {
        const $check = $('#blai-ai-api-check');
        const normalizedState = state || 'idle';
        $check
            .attr('data-state', normalizedState)
            .attr('title', title || '拉取 /models 检测 API 连通性，不发送聊天消息。')
            .attr('aria-label', `API 检测：${label}`);
        $('#blai-ai-api-status').text(label);
        $('#blai-ai-model-fetch')
            .toggleClass('accent', normalizedState === 'ok')
            .prop('disabled', normalizedState === 'checking')
            .text(normalizedState === 'checking' ? '拉取中' : '拉取模型')
            .attr('title', title || '拉取 /models，不发送聊天消息');
    };
    const resetAiApiCheckState = () => {
        if (aiApiCheckAbortController) {
            aiApiCheckAbortController.abort();
            aiApiCheckAbortController = null;
        }
        setAiApiCheckState('idle', '未测');
    };
    const extractModelIds = (payload) => {
        if (!payload || !Array.isArray(payload.data)) return [];
        return [...new Set(payload.data
            .map((item) => String(item?.id || item?.name || '').trim())
            .filter(Boolean))];
    };
    const normalizeAiModelOptions = (options) => {
        if (!Array.isArray(options)) return [];
        return [...new Set(options.map((value) => String(value || '').trim()).filter(Boolean))];
    };
    const syncAiModelSelect = (aiSettings) => {
        const $select = $('#blai-ai-model');
        if (!$select.length) return;

        const selectedModel = String(aiSettings.model || '').trim();
        const fetchedModels = normalizeAiModelOptions(aiSettings.modelOptions);
        const hasSelectedFetchedModel = selectedModel && fetchedModels.includes(selectedModel);
        const optionModels = selectedModel && !hasSelectedFetchedModel
            ? [selectedModel, ...fetchedModels]
            : fetchedModels;

        const fragment = document.createDocumentFragment();
        const placeholder = new Option(optionModels.length > 0 ? '请选择模型' : '先拉取模型列表', '');
        placeholder.disabled = optionModels.length > 0;
        fragment.appendChild(placeholder);

        optionModels.forEach((modelId) => {
            const label = modelId === selectedModel && !hasSelectedFetchedModel
                ? `${modelId}（当前配置）`
                : modelId;
            fragment.appendChild(new Option(label, modelId));
        });

        $select.empty().append(fragment);
        $select.prop('disabled', optionModels.length === 0);
        $select.val(optionModels.includes(selectedModel) ? selectedModel : '');
    };
    const runAiModelsHealthCheck = async (options = {}) => {
        const { silent = false } = options;
        const aiSettings = ensureAiRewriteSettings();
        const baseUrl = String(aiSettings.baseUrl || '').trim();
        const apiKey = String(aiSettings.apiKey || '');
        const model = String(aiSettings.model || '').trim();
        const endpoint = buildAiModelsEndpoint(baseUrl);

        if (!endpoint || !apiKey) {
            if (aiApiCheckAbortController) {
                aiApiCheckAbortController.abort();
                aiApiCheckAbortController = null;
            }
            setAiApiCheckState('missing', '未配置', '需要先填写 Base URL 和 API Key，检测只会请求 /models。');
            return false;
        }

        if (aiApiCheckAbortController) aiApiCheckAbortController.abort();
        const requestId = ++aiApiCheckSequence;
        const controller = new AbortController();
        aiApiCheckAbortController = controller;
        const timeoutMs = getAiApiCheckTimeoutMs(aiSettings);
        let timedOut = false;
        const timeoutId = window.setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);

        setAiApiCheckState('checking', '检测中', '正在拉取 /models；不会发送聊天消息。');
        try {
            const response = await fetch(endpoint, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                signal: controller.signal,
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            const modelIds = extractModelIds(payload);
            if (modelIds.length === 0) throw new Error('返回不是模型列表');
            if (requestId !== aiApiCheckSequence) return false;

            aiSettings.modelOptions = modelIds;
            if (!model && modelIds[0]) {
                aiSettings.model = modelIds[0];
            }
            saveSettingsDebounced();
            syncAiRewriteSettingsUI();
            const selectedModel = String(aiSettings.model || '').trim();
            const hasSelectedModel = selectedModel ? modelIds.includes(selectedModel) : true;
            const title = hasSelectedModel
                ? `API 检测正常：已拉取 ${modelIds.length} 个模型。`
                : `API 可访问：已拉取 ${modelIds.length} 个模型，但列表中没有当前模型 ${selectedModel}。`;
            setAiApiCheckState('ok', '正常', title);
            if (!silent) showToast(`API 检测正常：已拉取 ${modelIds.length} 个模型`);
            return true;
        } catch (error) {
            if (requestId !== aiApiCheckSequence) return false;
            const isAbort = error?.name === 'AbortError';
            if (isAbort && !timedOut) return false;
            const reason = timedOut ? '请求超时' : (error?.message || '请求失败');
            setAiApiCheckState('failed', '失败', `API 检测失败：${reason}。检测只请求 /models，不发送聊天消息。`);
            if (!silent) showToast(`API 检测失败：${reason}`);
            logger.warn('AI API 模型列表检测失败', reason);
            return false;
        } finally {
            window.clearTimeout(timeoutId);
            if (requestId === aiApiCheckSequence) aiApiCheckAbortController = null;
        }
    };
    const syncAiRewriteSettingsUI = () => {
        const aiSettings = ensureAiRewriteSettings();
        const setValueIfNotFocused = (selector, value) => {
            const $field = $(selector);
            if (!$field.is(':focus')) $field.val(value);
        };
        $('#blai-ai-enabled').prop('checked', aiSettings.enabled === true);
        const xmlScopeTag = normalizeXmlTagNameInput(aiSettings.xmlScopeTag, defaultAiRewriteSettings.xmlScopeTag);
        setValueIfNotFocused('#blai-ai-base-url', aiSettings.baseUrl || '');
        setValueIfNotFocused('#blai-ai-xml-scope', `<${xmlScopeTag}>`);
        setValueIfNotFocused('#blai-ai-api-key', aiSettings.apiKey || '');
        syncAiModelSelect(aiSettings);
        setValueIfNotFocused('#blai-ai-temperature', aiSettings.temperature);
        setValueIfNotFocused('#blai-ai-timeout', getAiTimeoutSeconds(aiSettings.timeoutMs));
        setValueIfNotFocused('#blai-ai-max-retries', aiSettings.maxRetries);
        setValueIfNotFocused('#blai-ai-max-items', aiSettings.maxItemsPerRequest);
        setValueIfNotFocused('#blai-ai-max-context', aiSettings.maxContextChars);
        setValueIfNotFocused('#blai-ai-max-rewrite', aiSettings.maxRewriteCharsPerItem);
        setValueIfNotFocused('#blai-ai-prompt', aiSettings.promptTemplate || defaultAiRewriteSettings.promptTemplate);
        setValueIfNotFocused('#blai-ai-prompt-expanded', aiSettings.promptTemplate || defaultAiRewriteSettings.promptTemplate);
        const configured = !!(aiSettings.baseUrl && aiSettings.apiKey && aiSettings.model);
        $('#blai-ai-settings-status').text(aiSettings.enabled === true ? (configured ? '已启用' : '待配置') : '未启用');
        $('#blai-ai-http-warning').prop('hidden', isLocalHttpUrl(aiSettings.baseUrl));
    };
    const updateAiRewriteSetting = (key, value, options = {}) => {
        const aiSettings = ensureAiRewriteSettings();
        aiSettings[key] = value;
        if (['baseUrl', 'apiKey'].includes(key)) aiSettings.modelOptions = [];
        if (options.markRulesDirty !== false) markRulesDataDirty({ rulesUi: false });
        saveSettingsDebounced();
        syncAiRewriteSettingsUI();
        if (['baseUrl', 'apiKey', 'model'].includes(key)) resetAiApiCheckState();
    };
    const enableVerifiedZhCompat = (toastMessage = '简繁兼容已开启') => {
        if (!restoreZhDictionaryPackageFromCache(settings)) return false;
        settings.zhVariantCompatEnabled = true;
        markRulesDataDirty({ rulesUi: false });
        saveSettingsDebounced();
        syncZhCompatToggle();
        performGlobalCleanse();
        showToast(toastMessage);
        return true;
    };
    const openZhDictionaryInstallPrompt = () => {
        const stats = getZhDictionaryPackageStats();
        openZhDictionaryModal(stats, getZhVariantCompatOptions(settings));
    };
    const openAiPromptEditor = () => {
        const aiSettings = ensureAiRewriteSettings();
        $('#blai-ai-prompt-expanded').val(aiSettings.promptTemplate || defaultAiRewriteSettings.promptTemplate);
        $('#blai-ai-prompt-modal').addClass('blai-is-open');
        window.setTimeout(() => $('#blai-ai-prompt-expanded').trigger('focus'), 0);
    };
    const closeAiPromptEditor = () => {
        $('#blai-ai-prompt-modal').removeClass('blai-is-open');
    };
    const applyAiPromptEditor = () => {
        const value = String($('#blai-ai-prompt-expanded').val() || defaultAiRewriteSettings.promptTemplate);
        $('#blai-ai-prompt').val(value);
        updateAiRewriteSetting('promptTemplate', value, { markRulesDirty: false });
        closeAiPromptEditor();
    };
    const runZhDictionaryInstall = async () => {
        if (zhDictionaryInstallAbortController) return;
        settings.zhVariantCompatOptions = {
            tw: $('#blai-zh-dict-tw').prop('checked') === true,
            hk: $('#blai-zh-dict-hk').prop('checked') === true,
        };
        settings.zhVariantCompatEnabled = false;
        saveSettingsDebounced();
        closeZhDictionaryModal();

        zhDictionaryInstallAbortController = new AbortController();
        showZhDictionaryInstallOverlay(() => {
            zhDictionaryInstallAbortController?.abort();
        });

        try {
            await downloadZhDictionaryPackage({
                signal: zhDictionaryInstallAbortController.signal,
                onProgress: ({ ratio, statusText }) => updateZhDictionaryInstallOverlay(ratio, statusText),
            });
            settings.zhVariantCompatEnabled = true;
            markRulesDataDirty({ rulesUi: false });
            saveSettingsDebounced();
            syncZhCompatToggle();
            performGlobalCleanse();
            showToast('增强简繁词典已安装并启用');
        } catch (error) {
            const message = markZhDictionaryInstallFailed(error);
            settings.zhVariantCompatEnabled = false;
            markRulesDataDirty({ rulesUi: false });
            saveSettingsDebounced();
            syncZhCompatToggle();
            if (error?.name === 'AbortError') showToast('已取消词典下载');
            else showToast(`词典安装失败：${message}`);
        } finally {
            zhDictionaryInstallAbortController = null;
            window.setTimeout(() => closeLoadingOverlay(), 260);
        }
    };
    applyThemeMode(settings.themeMode || 'auto');
    syncZhCompatToggle();
    syncAiRewriteSettingsUI();
    syncRealtimeMaskModeUI();

    $(document).off('click', '#blai-theme-toggle').on('click', '#blai-theme-toggle', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const modes = ['auto', 'light', 'dark'];
        const current = String(settings.themeMode || 'auto');
        const nextMode = modes[(Math.max(0, modes.indexOf(current)) + 1) % modes.length];
        applyThemeMode(nextMode);
        saveSettingsDebounced();
        showToast(`已切换主题：${nextMode === 'auto' ? '跟随酒馆' : nextMode === 'light' ? '白色主题' : '暗色主题'}`);
    });

    $(document).off('click', '.blai-realtime-mask-option').on('click', '.blai-realtime-mask-option', function(e) {
        e.preventDefault();
        const mode = String($(this).attr('data-mode') || '');
        if (!['simple-visual', 'tavern-helper'].includes(mode)) return;
        if (settings.realtimeMaskMode === mode) {
            syncRealtimeMaskModeUI();
            return;
        }
        settings.realtimeMaskMode = mode;
        saveSettingsDebounced();
        runtimeState.streamingRawMessageCache.clear();
        syncRealtimeMaskModeUI();
        showToast(mode === 'simple-visual' ? '实时屏蔽：简单视觉屏蔽' : '实时屏蔽：酒馆助手实时渲染');
    });

    $(document).off('click', '#blai-zh-dict-install-open').on('click', '#blai-zh-dict-install-open', function(e) {
        e.preventDefault();
        if (settings.zhVariantCompatEnabled === true && isZhDictionaryReady(settings)) {
            showToast('增强简繁词典已启用');
            return;
        }
        if (enableVerifiedZhCompat()) return;
        openZhDictionaryInstallPrompt();
    });

    $(document).off('click.blaiBindMenu').on('click.blaiBindMenu', function(e) {
        if ($(e.target).closest('.blai-bind-menu-wrap').length > 0) return;
        $('#blai-bind-menu').prop('hidden', true);
        $('#blai-character-bind-toggle').attr('aria-expanded', 'false');
    });

    $(document).off('click', '#blai-zh-compat-toggle').on('click', '#blai-zh-compat-toggle', function(e) {
        e.preventDefault();
        if (settings.zhVariantCompatEnabled === true && isZhDictionaryReady(settings)) {
            settings.zhVariantCompatEnabled = false;
            markRulesDataDirty({ rulesUi: false });
            saveSettingsDebounced();
            syncZhCompatToggle();
            performGlobalCleanse();
            showToast('简繁兼容已关闭');
            return;
        }

        if (enableVerifiedZhCompat()) return;
        openZhDictionaryInstallPrompt();
    });

    $(document).off('click', '#blai-zh-dict-close, #blai-zh-dict-cancel').on('click', '#blai-zh-dict-close, #blai-zh-dict-cancel', function(e) {
        e.preventDefault();
        closeZhDictionaryModal();
    });

    $(document).off('click', '#blai-zh-dict-download').on('click', '#blai-zh-dict-download', function(e) {
        e.preventDefault();
        runZhDictionaryInstall();
    });

    $(document).off('change', '#blai-ai-enabled').on('change', '#blai-ai-enabled', function() {
        const enabled = $(this).prop('checked') === true;
        const aiSettings = ensureAiRewriteSettings();
        aiSettings.enabledDefaultApplied = true;
        if (enabled && !isLocalHttpUrl(aiSettings.baseUrl)) showToast('当前 Base URL 使用非本地 HTTP，建议改用 HTTPS 或本地代理。');
        updateAiRewriteSetting('enabled', enabled);
    });

    $(document).off('input change', '#blai-ai-base-url').on('input change', '#blai-ai-base-url', function() {
        updateAiRewriteSetting('baseUrl', String($(this).val() || '').trim());
    });

    $(document).off('change blur', '#blai-ai-xml-scope').on('change blur', '#blai-ai-xml-scope', function() {
        const rawValue = String($(this).val() || '').trim();
        const parsed = parseScopeTagInput(rawValue || defaultAiRewriteSettings.xmlScopeTag);
        if (!parsed.ok) {
            showToast(`AI XML 标签无效：${parsed.error?.message || '请填写标签名'}`);
            syncAiRewriteSettingsUI();
            return;
        }
        updateAiRewriteSetting('xmlScopeTag', parsed.value.tagName);
    });

    $(document).off('input change', '#blai-ai-api-key').on('input change', '#blai-ai-api-key', function() {
        updateAiRewriteSetting('apiKey', String($(this).val() || ''), { markRulesDirty: false });
    });

    $(document).off('input change', '#blai-ai-model').on('input change', '#blai-ai-model', function() {
        updateAiRewriteSetting('model', String($(this).val() || '').trim(), { markRulesDirty: false });
    });

    $(document).off('input change', '#blai-ai-temperature, #blai-ai-timeout, #blai-ai-max-retries, #blai-ai-max-items, #blai-ai-max-context, #blai-ai-max-rewrite').on('input change', '#blai-ai-temperature, #blai-ai-timeout, #blai-ai-max-retries, #blai-ai-max-items, #blai-ai-max-context, #blai-ai-max-rewrite', function() {
        const id = String(this.id || '');
        const value = Number($(this).val());
        const keyMap = {
            'blai-ai-temperature': 'temperature',
            'blai-ai-timeout': 'timeoutMs',
            'blai-ai-max-retries': 'maxRetries',
            'blai-ai-max-items': 'maxItemsPerRequest',
            'blai-ai-max-context': 'maxContextChars',
            'blai-ai-max-rewrite': 'maxRewriteCharsPerItem',
        };
        const normalizedValue = id === 'blai-ai-timeout'
            ? Math.min(Math.max(Math.round(value || 0), 1), 120) * 1000
            : value;
        updateAiRewriteSetting(keyMap[id], normalizedValue, { markRulesDirty: false });
    });

    $(document).off('input change', '#blai-ai-prompt').on('input change', '#blai-ai-prompt', function() {
        updateAiRewriteSetting('promptTemplate', String($(this).val() || defaultAiRewriteSettings.promptTemplate), { markRulesDirty: false });
    });

    $(document).off('click', '#blai-ai-prompt-expand').on('click', '#blai-ai-prompt-expand', function(e) {
        e.preventDefault();
        openAiPromptEditor();
    });

    $(document).off('click', '#blai-ai-prompt-modal-close, #blai-ai-prompt-modal-cancel').on('click', '#blai-ai-prompt-modal-close, #blai-ai-prompt-modal-cancel', function(e) {
        e.preventDefault();
        closeAiPromptEditor();
    });

    $(document).off('click', '#blai-ai-prompt-modal').on('click', '#blai-ai-prompt-modal', function(e) {
        if (e.target === this) closeAiPromptEditor();
    });

    $(document).off('click', '#blai-ai-prompt-modal-apply').on('click', '#blai-ai-prompt-modal-apply', function(e) {
        e.preventDefault();
        applyAiPromptEditor();
    });

    $(document).off('keydown', '#blai-ai-prompt-expanded').on('keydown', '#blai-ai-prompt-expanded', function(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeAiPromptEditor();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 's') {
            e.preventDefault();
            applyAiPromptEditor();
        }
    });

    $(document).off('click', '#blai-ai-api-key-reveal').on('click', '#blai-ai-api-key-reveal', function(e) {
        e.preventDefault();
        const $input = $('#blai-ai-api-key');
        const nextType = $input.attr('type') === 'password' ? 'text' : 'password';
        $input.attr('type', nextType);
        $(this).find('i').attr('class', nextType === 'password' ? 'fas fa-eye' : 'fas fa-eye-slash');
    });

    $(document).off('click', '#blai-ai-api-key-clear').on('click', '#blai-ai-api-key-clear', function(e) {
        e.preventDefault();
        updateAiRewriteSetting('apiKey', '', { markRulesDirty: false });
        showToast('API Key 已清空');
    });

    $(document).off('click', '#blai-ai-model-fetch').on('click', '#blai-ai-model-fetch', function(e) {
        e.preventDefault();
        void runAiModelsHealthCheck({ silent: false });
    });

    if (settings.enableVisualDiff === false) {
        settings.enableVisualDiff = true;
        saveSettingsDebounced();
        injectDiffButtons();
    }

    const syncSkipUserToggle = () => {
        const enabled = settings.skipUserMessages === true;
        $('#blai-skip-user-toggle')
            .toggleClass('accent', enabled)
            .attr('aria-pressed', String(enabled))
            .text(enabled ? '开启' : '关闭');
    };
    syncSkipUserToggle();

    $(document).off('click', '#blai-skip-user-toggle').on('click', '#blai-skip-user-toggle', function(e) {
        e.preventDefault();
        settings.skipUserMessages = settings.skipUserMessages !== true;
        saveSettingsDebounced();
        performGlobalCleanse();
        syncSkipUserToggle();
        showToast(settings.skipUserMessages ? '已跳过用户消息' : '已恢复净化用户消息');
    });

    $(document).off('click', '.blai-persona-description-protect-toggle').on('click', '.blai-persona-description-protect-toggle', function(e) {
        e.preventDefault();
        settings.protectPersonaDescription = settings.protectPersonaDescription !== true;
        saveSettingsDebounced();
        syncPersonaDescriptionProtectionControl();
        showToast(settings.protectPersonaDescription ? '用户设定描述已保护' : '用户设定描述已取消保护');
    });

    $(document).off('click', '#blai-preset-search').on('click', '#blai-preset-search', () => {
        openRuleSearchModal();
    });

    $(document).off('click', '#blai-rule-search-back').on('click', '#blai-rule-search-back', () => {
        closeRuleSearchModal({ reset: true });
    });

    $(document).off('input', '#blai-rule-search-input').on('input', '#blai-rule-search-input', function() {
        runtimeState.ruleSearchDraftKeyword = String($(this).val() || '');
        syncRuleSearchInputUi();
        if (runtimeState.ruleSearchDraftKeyword.trim() !== '') return;
        runtimeState.ruleSearchKeyword = '';
        runtimeState.ruleSearchHasSearched = false;
        runtimeState.ruleSearchExpandedMenuKey = '';
        renderRuleSearchModal();
    });

    $(document).off('keydown', '#blai-rule-search-input').on('keydown', '#blai-rule-search-input', function(e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        submitRuleSearch();
    });

    $(document).off('click', '#blai-rule-search-submit').on('click', '#blai-rule-search-submit', () => {
        submitRuleSearch();
    });

    $(document).off('click', '#blai-rule-search-clear').on('click', '#blai-rule-search-clear', () => {
        resetRuleSearchQueryState();
        syncRuleSearchInputUi({ syncValue: true });
        renderRuleSearchModal();
        $('#blai-rule-search-input').trigger('focus');
    });

    $(document).off('click', '#blai-scope-tags-btn').on('click', '#blai-scope-tags-btn', () => {
        openScopeTagsModal();
    });

    $(document).off('click', '#blai-scope-tag-menu-open').on('click', '#blai-scope-tag-menu-open', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const $menu = $('#blai-scope-tag-action-menu');
        const nextHidden = !$menu.prop('hidden');
        $menu.prop('hidden', nextHidden);
        $(this).attr('aria-expanded', String(!nextHidden));
    });

    $(document).off('click', '#blai-scope-tag-add-open').on('click', '#blai-scope-tag-add-open', () => {
        closeScopeTagActionMenu();
        openScopeTagEditor();
    });

    const saveQuickScopeTag = () => {
        const rawInput = String($('#blai-scope-quick-input').val() || '').trim();
        if (!rawInput) {
            showToast('先输入范围标签');
            $('#blai-scope-quick-input').trigger('focus');
            return;
        }
        renderScopeTagGroupOptions(DEFAULT_SCOPE_TAG_GROUP_ID);
        $('#blai-scope-tag-input')
            .val(rawInput)
            .data('scope-edit-id', '');
        $('#blai-scope-tag-label-input').val('');
        $('#blai-scope-tag-group-select').val(DEFAULT_SCOPE_TAG_GROUP_ID);
        if (saveScopeTag()) $('#blai-scope-quick-input').val('');
    };

    $(document).off('click', '#blai-scope-tag-add-quick').on('click', '#blai-scope-tag-add-quick', (e) => {
        e.preventDefault();
        saveQuickScopeTag();
    });

    $(document).off('keydown', '#blai-scope-quick-input').on('keydown', '#blai-scope-quick-input', function(e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        saveQuickScopeTag();
    });

    $(document).off('click', '#blai-scope-group-manage-open').on('click', '#blai-scope-group-manage-open', () => {
        closeScopeTagActionMenu();
        renderScopeGroupManager();
        $('#blai-scope-group-manager-modal').prop('hidden', false);
    });

    $(document).off('click', '#blai-scope-tags-expand-all').on('click', '#blai-scope-tags-expand-all', () => {
        settings.scopeTagCollapsedGroups = [];
        saveSettingsDebounced();
        renderScopeTagsModal();
    });

    $(document).off('click', '#blai-scope-tags-collapse-all').on('click', '#blai-scope-tags-collapse-all', () => {
        settings.scopeTagCollapsedGroups = getScopeTagGroups().map((group) => group.id);
        saveSettingsDebounced();
        renderScopeTagsModal();
    });

    $(document).off('click', '.blai-scope-tag-group-head').on('click', '.blai-scope-tag-group-head', function(e) {
        e.preventDefault();
        if ($(e.target).closest('.blai-scope-tag-group-toggle').length > 0) return;
        const groupId = String($(this).closest('.blai-scope-tag-group').attr('data-group-id') || '');
        if (!groupId) return;
        const groups = getScopeTagGroups();
        const collapsed = new Set(normalizeScopeTagCollapsedGroupList(settings.scopeTagCollapsedGroups, groups));
        if (collapsed.has(groupId)) collapsed.delete(groupId);
        else collapsed.add(groupId);
        settings.scopeTagCollapsedGroups = normalizeScopeTagCollapsedGroupList([...collapsed], groups);
        saveSettingsDebounced();
        renderScopeTagsModal();
    });

    $(document).off('click', '.blai-scope-tag-group-toggle').on('click', '.blai-scope-tag-group-toggle', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const groupId = String($(this).attr('data-group-id') || '');
        if (!groupId || $(this).prop('disabled')) return;
        const nextEnabled = $(this).attr('aria-pressed') !== 'true';
        const currentScopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
        let changed = false;
        const scopeTags = currentScopeTags.map((tag) => {
            if (resolveScopeTagGroupId(tag.groupId) !== groupId) return tag;
            if ((tag.enabled !== false) === nextEnabled) return tag;
            changed = true;
            return { ...tag, enabled: nextEnabled };
        });
        if (!changed) return;
        persistScopeTags(scopeTags);
        showToast(nextEnabled ? '已启用该分组' : '已关闭该分组');
    });

    $(document).off('click', '#blai-scope-group-add').on('click', '#blai-scope-group-add', () => {
        const group = { id: createScopeTagGroupId(), name: '未命名分组' };
        persistScopeTagGroups([...getScopeTagGroups(), group], { focusGroupId: group.id });
    });

    $(document).off('click', '#blai-scope-group-done').on('click', '#blai-scope-group-done', () => {
        $('#blai-scope-group-manager-modal').prop('hidden', true);
    });

    $(document).off('input', '.blai-scope-group-name-input').on('input', '.blai-scope-group-name-input', function() {
        const groupId = String($(this).attr('data-group-id') || '');
        const nextName = String($(this).val() || '').trim();
        if (!groupId) return;
        settings.scopeTagGroups = normalizeScopeTagGroupList(getScopeTagGroups().map((group) => (
            group.id === groupId ? { ...group, name: nextName || group.name } : group
        )));
        saveSettingsDebounced();
        renderScopeTagsModal();
        renderScopeTagGroupOptions($('#blai-scope-tag-group-select').val() || DEFAULT_SCOPE_TAG_GROUP_ID);
    });

    const moveScopeGroup = (groupId, direction) => {
        const groups = getScopeTagGroups();
        const index = groups.findIndex((group) => group.id === groupId);
        const targetIndex = direction === 'up' ? index - 1 : index + 1;
        if (index < 0 || targetIndex < 0 || targetIndex >= groups.length) return;
        [groups[index], groups[targetIndex]] = [groups[targetIndex], groups[index]];
        persistScopeTagGroups(groups);
    };

    $(document).off('click', '.blai-scope-group-move-up').on('click', '.blai-scope-group-move-up', function() {
        moveScopeGroup(String($(this).attr('data-group-id') || ''), 'up');
    });

    $(document).off('click', '.blai-scope-group-move-down').on('click', '.blai-scope-group-move-down', function() {
        moveScopeGroup(String($(this).attr('data-group-id') || ''), 'down');
    });

    $(document).off('click', '.blai-scope-group-delete').on('click', '.blai-scope-group-delete', function() {
        const groupId = String($(this).attr('data-group-id') || '');
        if (!groupId || groupId === DEFAULT_SCOPE_TAG_GROUP_ID) return;
        const group = getScopeTagGroups().find((item) => item.id === groupId);
        if (!group) return;
        if (!confirm(`确定删除分组 "${group.name}" 吗？\n该分组内的标签会移至默认分组。`)) return;
        const currentScopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
        settings.scopeTags = currentScopeTags.map((tag) => (
            tag.groupId === groupId ? { ...tag, groupId: DEFAULT_SCOPE_TAG_GROUP_ID } : tag
        ));
        settings.scopeTagCollapsedGroups = normalizeScopeTagCollapsedGroupList(
            (settings.scopeTagCollapsedGroups || []).filter((id) => id !== groupId),
            getScopeTagGroups().filter((item) => item.id !== groupId)
        );
        persistScopeTagGroups(getScopeTagGroups().filter((item) => item.id !== groupId));
    });

    $(document).off('click', '#blai-scope-tag-mode-toggle').on('click', '#blai-scope-tag-mode-toggle', () => {
        setScopeTagMode(settings.scopeTagMode === 'cleanse-inside' ? 'protect' : 'cleanse-inside');
    });

    $(document).off('click', '#blai-scope-mode-protect, #blai-scope-mode-cleanse').on('click', '#blai-scope-mode-protect, #blai-scope-mode-cleanse', function() {
        setScopeTagMode(String($(this).data('mode') || 'protect'));
    });

    $(document).off('click', '#blai-scope-tags-close').on('click', '#blai-scope-tags-close', () => {
        closeScopeTagsModal({ reset: true });
    });

    $(document).off('click', '#blai-scope-tag-reset').on('click', '#blai-scope-tag-reset', () => {
        resetScopeTagEditor();
    });

    $(document).off('click', '#blai-scope-tag-save').on('click', '#blai-scope-tag-save', () => {
        saveScopeTag();
    });

    $(document).off('keydown', '#blai-scope-tag-label-input').on('keydown', '#blai-scope-tag-label-input', function(e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        saveScopeTag();
    });

    $(document).off('keydown', '#blai-scope-tag-input').on('keydown', '#blai-scope-tag-input', function(e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        saveScopeTag();
    });

    $(document).off('click', '.blai-rule-search-menu-toggle').on('click', '.blai-rule-search-menu-toggle', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const nextKey = String($(this).data('key') || '');
        runtimeState.ruleSearchExpandedMenuKey = runtimeState.ruleSearchExpandedMenuKey === nextKey ? '' : nextKey;
        renderRuleSearchModal();
    });

    $(document).off('click', '.blai-rule-search-menu-item').on('click', '.blai-rule-search-menu-item', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const action = String($(this).data('action') || '');
        const ruleIndex = Number($(this).attr('data-rule-index'));
        const subRuleIndex = Number($(this).attr('data-subrule-index'));
        const rules = extension_settings[extensionName].rules || [];
        if (!Number.isInteger(ruleIndex) || ruleIndex < 0 || ruleIndex >= rules.length) return;
        if (!Number.isInteger(subRuleIndex) || subRuleIndex < 0 || subRuleIndex >= (rules[ruleIndex]?.subRules || []).length) return;

        runtimeState.ruleSearchExpandedMenuKey = '';
        closeRuleSearchModal();

        if (action === 'group') {
            openEditModal(ruleIndex, { source: 'search', returnMode: 'group', subRuleIndex });
            return;
        }

        if (action === 'subrule') {
            openEditModal(ruleIndex, { source: 'search', returnMode: 'subrule', subRuleIndex });
            openSingleRuleModal(subRuleIndex, { hideEditModal: true });
        }
    });

    $(document).off('click', '#blai-rule-search-modal').on('click', '#blai-rule-search-modal', function(e) {
        if ($(e.target).closest('.blai-rule-search-menu-wrap').length > 0) return;
        if (!runtimeState.ruleSearchExpandedMenuKey) return;
        runtimeState.ruleSearchExpandedMenuKey = '';
        renderRuleSearchModal();
    });

    $(document).off('click', '#blai-scope-tags-modal').on('click', '#blai-scope-tags-modal', function(e) {
        if ($(e.target).closest('.blai-scope-tag-menu-wrap').length === 0) closeScopeTagActionMenu();
        if (e.target && e.target.id === 'blai-scope-tags-modal') closeScopeTagsModal({ reset: true });
    });

    $(document).off('click', '#blai-scope-tag-editor-modal').on('click', '#blai-scope-tag-editor-modal', function(e) {
        if (e.target && e.target.id === 'blai-scope-tag-editor-modal') resetScopeTagEditor();
    });

    $(document).off('click', '#blai-scope-group-manager-modal').on('click', '#blai-scope-group-manager-modal', function(e) {
        if (e.target && e.target.id === 'blai-scope-group-manager-modal') $('#blai-scope-group-manager-modal').prop('hidden', true);
    });

    $(document).off('click', '.blai-scope-tag-chip-main, .blai-scope-tag-edit').on('click', '.blai-scope-tag-chip-main, .blai-scope-tag-edit', function(e) {
        e.preventDefault();
        const tagId = String($(this).attr('data-id') || '');
        const scopeTag = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed).find((tag) => tag.id === tagId);
        if (!scopeTag) return;
        openScopeTagEditor(scopeTag);
    });

    $(document).off('change', '.blai-scope-tag-toggle').on('change', '.blai-scope-tag-toggle', function() {
        const tagId = String($(this).attr('data-id') || '');
        const checked = $(this).prop('checked');
        const currentScopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
        const targetTag = currentScopeTags.find((tag) => tag.id === tagId);
        const togglesCotGroup = isCotScopeTagEntry(targetTag);
        const scopeTags = currentScopeTags.map((tag) => {
            if (togglesCotGroup && isCotScopeTagEntry(tag)) return { ...tag, enabled: checked };
            return tag.id === tagId ? { ...tag, enabled: checked } : tag;
        });
        persistScopeTags(scopeTags);
    });

    $(document).off('click', '.blai-scope-tag-del').on('click', '.blai-scope-tag-del', function(e) {
        e.preventDefault();
        const tagId = String($(this).attr('data-id') || '');
        const scopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
        const scopeTag = scopeTags.find((tag) => tag.id === tagId);
        if (!scopeTag) return;
        const deletesCotGroup = isCotScopeTagEntry(scopeTag);
        const displayName = deletesCotGroup ? '<thinking> OR <think>' : scopeTag.startTag;
        if (!confirm(`确定删除范围标签 ${displayName} 吗？`)) return;
        const dismissedBuiltinKeys = [...normalizeScopeTagBuiltinDismissedList(settings.scopeTagBuiltinDismissed)];
        if (deletesCotGroup) dismissedBuiltinKeys.push(...getCotScopeTagBuiltinKeys());
        else if (scopeTag.builtinKey) dismissedBuiltinKeys.push(scopeTag.builtinKey);
        const nextScopeTags = deletesCotGroup
            ? scopeTags.filter((tag) => !isCotScopeTagEntry(tag))
            : scopeTags.filter((tag) => tag.id !== tagId);
        persistScopeTags(nextScopeTags, { dismissedBuiltinKeys });
        if (getScopeTagEditId() === tagId) resetScopeTagEditor();
        showToast('范围标签已删除');
    });

    $(document).off('click', '#blai-batch-toggle').on('click', '#blai-batch-toggle', function() {
        const $popup = $('#blai-purifier-popup');
        const isBatchMode = !$popup.hasClass('blai-is-batch-mode');
        $popup.toggleClass('blai-is-batch-mode', isBatchMode);
        $('#blai-batch-operations').toggle(isBatchMode);
        $popup.find('.blai-batch-checkbox-label').toggle(isBatchMode);
        $(this).toggleClass('blai-active', isBatchMode);
        if (!isBatchMode) {
            $('.batch-item-checkbox').prop('checked', false);
            runtimeState.batchSelectedRuleIds = [];
        }
    });

    $(document).off('click', '#blai-btn-select-all').on('click', '#blai-btn-select-all', () => {
        $('.batch-item-checkbox').prop('checked', true);
        syncBatchSelectionStateFromDom(extension_settings[extensionName].rules || []);
    });

    $(document).off('click', '#blai-btn-select-invert').on('click', '#blai-btn-select-invert', () => {
        $('.batch-item-checkbox').each(function() { $(this).prop('checked', !$(this).prop('checked')); });
        syncBatchSelectionStateFromDom(extension_settings[extensionName].rules || []);
    });

    $(document).off('click', '#blai-btn-batch-transfer').on('click', '#blai-btn-batch-transfer', () => {
        const selectedIndexes = getSelectedIndexesFromState(extension_settings[extensionName].rules || []);
        if (selectedIndexes.length > 0) openTransferModal(selectedIndexes);
    });

    $(document).off('click', '#blai-btn-batch-delete').on('click', '#blai-btn-batch-delete', () => {
        const rules = extension_settings[extensionName].rules || [];
        const selectedIndexes = getSelectedIndexesFromState(rules);
        if (selectedIndexes.length <= 0 || !confirm(`确定要删除选中的 ${selectedIndexes.length} 个规则分组吗？`)) return;
        if (selectedIndexes.length > 1 ? deleteSelectedRules(rules, selectedIndexes) : deleteSingleRule(rules, selectedIndexes[0])) {
            markRulesDataDirty();
            saveSettingsDebounced();
            renderTagsPreserveBatchSelection();
        }
    });

    $(document).off('change', '.batch-item-checkbox').on('change', '.batch-item-checkbox', () => syncBatchSelectionStateFromDom(extension_settings[extensionName].rules || []));

    const getDiffMessageByIndex = (index) => {
        const { chat } = getAppContext();
        return Array.isArray(chat) && Number.isInteger(index) && index >= 0 && index < chat.length ? chat[index] : null;
    };

    const closeDiffActionsMenu = () => {
        $('#blai-diff-actions-menu').prop('hidden', true);
        $('#blai-diff-menu-toggle').attr('aria-expanded', 'false');
    };

    const openDiffActionsMenu = () => {
        $('#blai-diff-actions-menu').prop('hidden', false);
        $('#blai-diff-menu-toggle').attr('aria-expanded', 'true');
    };

    const syncDiffLimitControlState = (editing = false) => {
        const currentSettings = extension_settings[extensionName];
        const normalized = normalizeDiffTrackedMessageLimit(currentSettings.diffTrackedMessageLimit);
        currentSettings.diffTrackedMessageLimit = normalized;
        $('#blai-diff-limit-text').text(`最近 ${normalized} 层`);
        $('#blai-diff-limit-input')
            .attr('min', minTrackedDiffMessages)
            .attr('max', maxTrackedDiffMessages)
            .val(normalized);
        $('#blai-diff-limit-edit').prop('hidden', editing === true);
        $('#blai-diff-limit-editor').prop('hidden', editing !== true);
    };

    const closeDiffLimitEditor = () => {
        syncDiffLimitControlState(false);
    };

    const applyDiffLimitDraft = () => {
        const currentSettings = extension_settings[extensionName];
        const previous = normalizeDiffTrackedMessageLimit(currentSettings.diffTrackedMessageLimit);
        const next = normalizeDiffTrackedMessageLimit($('#blai-diff-limit-input').val());
        currentSettings.diffTrackedMessageLimit = next;
        closeDiffLimitEditor();
        if (next === previous) return;

        saveSettingsDebounced();
        syncTrackedIndicesToLatestAssistantMessages();
        injectDiffButtons();
        if (runtimeState.currentDiffIndex !== undefined) renderDiffModalContent(runtimeState.currentDiffIndex);
        showToast(`透视楼层已设为最近 ${next} 层`);
    };

    const closeDiffRelatedModal = ({ clearSelection = true } = {}) => {
        $('#blai-diff-related-body').empty();
        $('#blai-diff-related-modal').hide();
        if (clearSelection) $('#blai-diff-modal-content .blai-diff-change-selected').removeClass('blai-diff-change-selected');
    };

    const syncDiffRelatedModeState = () => {
        const enabled = runtimeState.diffRelatedRuleMode === true;
        $('#blai-diff-modal').toggleClass('blai-diff-related-mode', enabled);
        $('#blai-diff-related-mode-icon').attr('class', enabled ? 'fa-solid fa-crosshairs blai-related-active-icon' : 'fa-solid fa-crosshairs');
        $('#blai-diff-related-mode-text').text(enabled ? '相关规则：开启' : '相关规则：关闭');
        $('#blai-diff-related-mode-toggle').attr('title', enabled ? '关闭相关规则模式' : '点击差异文本后推测相关规则');
        if (!enabled) closeDiffRelatedModal();
    };

    const readDiffChangeNumber = (element, name) => {
        const value = Number(element?.getAttribute?.(`data-blai-${name}`));
        return Number.isFinite(value) ? value : null;
    };

    const getAdjacentDiffChangeElement = (element, direction) => {
        let node = element?.[direction] || null;
        while (node) {
            if (node.nodeType === Node.TEXT_NODE && String(node.textContent || '').trim() === '') {
                node = node[direction];
                continue;
            }
            if (node.nodeType === Node.ELEMENT_NODE && node.matches?.('del.blai-diff-change, ins.blai-diff-change')) return node;
            return null;
        }
        return null;
    };

    const getContextWindow = (text = '', start = 0, end = start, radius = 160) => {
        const source = String(text || '');
        const safeStart = Math.max(0, Math.min(source.length, Number(start) || 0));
        const safeEnd = Math.max(safeStart, Math.min(source.length, Number(end) || safeStart));
        return source.slice(Math.max(0, safeStart - radius), Math.min(source.length, safeEnd + radius));
    };

    const buildDiffChangeFromElement = (element) => {
        const index = runtimeState.currentDiffIndex;
        const pair = getDiffComparisonForMessage(index);
        if (!pair || !element) return null;

        const clickedType = element.getAttribute('data-blai-diff-type') || (element.tagName === 'DEL' ? 'delete' : 'insert');
        const clickedText = String(element.textContent || '');
        const previousChange = getAdjacentDiffChangeElement(element, 'previousSibling');
        const nextChange = getAdjacentDiffChangeElement(element, 'nextSibling');
        const pairedDelete = clickedType === 'delete' ? element : (previousChange?.tagName === 'DEL' ? previousChange : null);
        const pairedInsert = clickedType === 'insert' ? element : (nextChange?.tagName === 'INS' ? nextChange : null);
        const oldStart = readDiffChangeNumber(pairedDelete || element, 'old-start') ?? readDiffChangeNumber(element, 'old-start') ?? 0;
        const oldEnd = readDiffChangeNumber(pairedDelete || element, 'old-end') ?? oldStart;
        const newStart = readDiffChangeNumber(pairedInsert || element, 'new-start') ?? readDiffChangeNumber(element, 'new-start') ?? 0;
        const newEnd = readDiffChangeNumber(pairedInsert || element, 'new-end') ?? newStart;
        const deletedText = pairedDelete ? String(pairedDelete.textContent || '') : (clickedType === 'delete' ? clickedText : '');
        const insertedText = pairedInsert ? String(pairedInsert.textContent || '') : (clickedType === 'insert' ? clickedText : '');

        return {
            clickedType,
            clickedText,
            deletedText,
            insertedText,
            beforeText: deletedText,
            afterText: insertedText,
            oldStart,
            oldEnd,
            newStart,
            newEnd,
            oldContext: getContextWindow(pair.sourceDisplayText || '', oldStart, oldEnd),
            newContext: getContextWindow(pair.cleanedDisplayText || '', newStart, newEnd),
        };
    };

    const summarizeCandidateTargets = (candidate) => {
        const targets = Array.isArray(candidate.targets) ? candidate.targets.filter(Boolean) : [];
        const replacements = Array.isArray(candidate.replacements) ? candidate.replacements.filter(Boolean) : [];
        const targetText = targets.length > 0 ? targets.join(' / ') : '（空查找词）';
        const replacementText = replacements.length > 0 ? replacements.join(' / ') : '删除';
        return `${targetText} -> ${replacementText}`;
    };

    const renderRelatedRulesModal = (change, candidates) => {
        const $modal = $('#blai-diff-related-modal');
        const $body = $('#blai-diff-related-body');
        if (!$modal.length || !$body.length) return;
        const clickedText = change?.clickedText ? escapeHtml(change.clickedText).slice(0, 120) : '（空）';
        if (!Array.isArray(candidates) || candidates.length === 0) {
            $body.html(`
                <div class="blai-diff-related-head">
                    <strong><i class="fa-solid fa-crosshairs"></i> 未找到明显相关规则</strong>
                    <span>点击文本：${clickedText}</span>
                </div>
                <div class="blai-diff-related-note">这是相关规则推测，不保证为实际触发规则。</div>
            `);
            $modal.css('display', 'flex');
            return;
        }

        const items = candidates.map((candidate) => {
            const reasons = Array.isArray(candidate.reasons) && candidate.reasons.length > 0
                ? candidate.reasons.slice(0, 2).join('，')
                : '相关文本命中';
            return `
                <button type="button" class="blai-diff-related-candidate" data-rule-index="${candidate.ruleIndex}" data-subrule-index="${candidate.subRuleIndex}">
                    <span class="blai-diff-related-candidate-main">
                        <span class="blai-tag blai-badge-compact">${escapeHtml(candidate.modeLabel || candidate.mode || '规则')}</span>
                        <strong>${escapeHtml(candidate.groupName || `合集 ${candidate.ruleIndex + 1}`)}</strong>
                    </span>
                    <span class="blai-diff-related-candidate-preview">${escapeHtml(summarizeCandidateTargets(candidate))}</span>
                    <span class="blai-diff-related-candidate-reason">${escapeHtml(reasons)} · 分数 ${Math.round(candidate.score)}</span>
                </button>
            `;
        }).join('');

        $body.html(`
            <div class="blai-diff-related-head">
                <strong><i class="fa-solid fa-crosshairs"></i> 可能相关规则</strong>
                <span>点击文本：${clickedText}</span>
            </div>
            <div class="blai-diff-related-note">相关规则推测，不保证为实际触发规则。最多显示 10 条。</div>
            <div class="blai-diff-related-list">${items}</div>
        `);
        $modal.css('display', 'flex');
    };

    const showRelatedRulesForDiffElement = (element) => {
        const change = buildDiffChangeFromElement(element);
        if (!change) return;
        const rules = extension_settings[extensionName]?.rules || [];
        const candidates = findRelatedRulesForDiffChange(change, rules, { maxCount: 10 });
        renderRelatedRulesModal(change, candidates);
    };

    const syncDiffModeToggleState = (mode) => {
        const isFullMode = mode === 'full';
        const nextText = isFullMode ? '切回片段' : '全文模式';
        const nextTitle = isFullMode ? '切回片段模式' : '切换到全文模式';
        $('#blai-diff-mode-text').text(nextText);
        $('#blai-diff-mode-icon').attr('class', isFullMode ? 'fa-solid fa-list-ul' : 'fa-solid fa-file-lines');
        $('#blai-diff-mode-toggle').attr('title', nextTitle).attr('aria-label', nextTitle);
    };

    const syncDiffPositionMenuState = (settings) => {
        const shouldExposeTopButton = settings.diffButtonInExtraMenu === true;
        $('#blai-diff-menu-pos-icon').attr('class', shouldExposeTopButton ? 'fa-solid fa-thumbtack' : 'fa-solid fa-ellipsis');
        $('#blai-diff-menu-pos-text').text(shouldExposeTopButton ? '顶部按钮：外显' : '顶部按钮：收纳');
        $('#blai-diff-menu-pos-toggle').attr('title', shouldExposeTopButton ? '将顶部按钮恢复为外显' : '将顶部按钮收纳进菜单');
    };

    const syncDiffBottomMenuState = (settings) => {
        const isBottomVisible = settings.showBottomDiffButton !== false;
        $('#blai-diff-menu-bottom-icon').attr('class', isBottomVisible ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye');
        $('#blai-diff-menu-bottom-text').text(isBottomVisible ? '尾部按钮：隐藏' : '尾部按钮：显示');
        $('#blai-diff-menu-bottom-toggle').attr('title', isBottomVisible ? '隐藏消息尾部按钮' : '显示消息尾部按钮');
    };

    const syncDiffPreferenceMenuState = () => {
        const settings = extension_settings[extensionName];
        syncDiffLimitControlState(false);
        syncDiffRelatedModeState();
        syncDiffPositionMenuState(settings);
        syncDiffBottomMenuState(settings);
    };
    syncDiffLimitControlState(false);

    const syncDiffRevertToggleState = (msg) => {
        const isReverted = msg?.__blai_is_reverted === true;
        const revertTitle = isReverted ? '重新净化文本' : '撤回净化并保护原文';
        $('#blai-diff-revert-icon').attr('class', isReverted ? 'fas fa-wand-magic-sparkles' : 'fas fa-rotate-left');
        $('#blai-diff-revert-text').text(isReverted ? '重新净化' : '撤回净化');
        $('#blai-diff-revert-toggle').attr('title', revertTitle);
        $('#blai-diff-mode-toggle').toggle(!isReverted);
    };

    const syncDiffAiRewriteButtonState = (msg) => {
        const isReverted = msg?.__blai_is_reverted === true;
        $('#blai-diff-ai-rewrite').attr('title', isReverted ? '请先重新净化文本' : '对当前消息手动执行 AI 改写');
    };

    const refreshMessageAfterRevertToggle = (index, msg) => {
        const { chat } = getAppContext();
        if (!Number.isInteger(index) || index < 0 || !Array.isArray(chat) || !msg) return;
        const finishRefresh = () => {
            const messageNode = getMessageDomNode(index);
            if (messageNode && msg.__blai_is_reverted !== true) purifyDOM(messageNode);
            injectDiffButtons([index]);
            renderDiffModalContent(index);
        };
        const refreshAndFinish = () => {
            refreshMessageDisplay(index, { allowReloadFallback: true });
            finishRefresh();
        };
        refreshAndFinish();
        window.requestAnimationFrame?.(() => finishRefresh());
        window.setTimeout(refreshAndFinish, 50);
        window.setTimeout(() => {
            refreshMessageDisplay(index, { emitRenderedEvent: 'auto' });
            finishRefresh();
        }, 100);
        window.setTimeout(finishRefresh, 150);
        queueIncrementalChatSave();
    };

    const toggleCurrentDiffRevert = () => {
        const index = runtimeState.currentDiffIndex;
        const msg = getDiffMessageByIndex(index);
        if (!Number.isInteger(index) || index < 0 || !msg || typeof msg !== 'object') return;

        if (msg.__blai_is_reverted === true) {
            const sourceMes = typeof msg.mes === 'string' ? msg.mes : '';
            delete msg.__blai_is_reverted;
            cleanseMessageDataAtIndex(index, { diffSourceMes: sourceMes });
        } else {
            const originalMes = getCurrentMessageOriginalMes(msg);
            if (originalMes) {
                msg.mes = originalMes;
                setCurrentSwipeText(msg, originalMes);
            }
            msg.__blai_is_reverted = true;
            clearTrackedDiffEntry(index);
        }

        closeDiffActionsMenu();
        refreshMessageAfterRevertToggle(index, msg);
    };

    const triggerCurrentDiffAiRewrite = () => {
        const index = runtimeState.currentDiffIndex;
        const msg = getDiffMessageByIndex(index);
        if (!Number.isInteger(index) || index < 0 || !msg || typeof msg !== 'object') {
            showToast('未找到可改写的助手消息');
            return;
        }
        if (msg.__blai_is_reverted === true) {
            showToast('请先重新净化文本，再执行 AI 改写');
            return;
        }

        closeDiffActionsMenu();
        requestManualAiRewriteForMessage(index);
    };

    const closeDiffModal = () => {
        closeDiffActionsMenu();
        closeDiffRelatedModal();
        runtimeState.diffRelatedRuleMode = false;
        syncDiffRelatedModeState();
        $('#blai-diff-modal').hide();
    };

    function renderDiffModalContent(index) {
        const settings = extension_settings[extensionName];
        const mode = settings.diffViewMode || 'snippet';
        const msg = getDiffMessageByIndex(index);
        const contentEl = $('#blai-diff-modal-content');
        closeDiffRelatedModal();
        syncDiffPreferenceMenuState();
        syncDiffModeToggleState(mode);
        syncDiffRevertToggleState(msg);
        syncDiffAiRewriteButtonState(msg);

        if (msg?.__blai_is_reverted) {
            contentEl.html('<div class="blai-diff-empty"><i class="fas fa-shield-halved" style="margin-right:6px;"></i>此消息已撤回并处于免净化保护状态，当前显示为原始文本。点击 <i class="fas fa-wand-magic-sparkles blai-diff-inline-icon"></i> 重新净化文本。</div>');
            return;
        }

        refreshDiffCacheIfStale(index);
        const state = getDiffStateForMessage(index);
        const cached = getDiffSnippetsForMessage(index);

        if (state.status !== 'ready') {
            contentEl.html('<div class="blai-diff-loading"><i class="fas fa-spinner fa-spin"></i><span>Loading...</span></div>');
            return;
        }
        if (mode === 'full') {
            contentEl.html(`<div class="blai-diff-full-text">${cached.fullDiff || '<div class="blai-diff-empty">当前消息未触发差异。</div>'}</div>`);
        } else {
            contentEl.html(cached.snippets.length > 0 ? cached.snippets.join('<hr class="blai-diff-divider">') : '<div class="blai-diff-empty">当前消息未触发差异。</div>');
        }
    }

    runtimeState.diffModalRefresh = (index) => {
        if (runtimeState.currentDiffIndex === undefined) return;
        if (index !== undefined && index !== runtimeState.currentDiffIndex) return;
        if ($('#blai-diff-modal').is(':visible')) renderDiffModalContent(runtimeState.currentDiffIndex);
    };

    $(document).off('click', '.blai-diff-btn').on('click', '.blai-diff-btn', function() {
        const index = Number($(this).attr('data-index'));
        if (!Number.isInteger(index) || index < 0) return;
        runtimeState.currentDiffIndex = index;
        closeDiffRelatedModal();
        renderDiffModalContent(index);
        closeDiffActionsMenu();
        $('#blai-diff-modal').css('display', 'flex');
    });

    $(document).off('click', '#blai-diff-menu-toggle').on('click', '#blai-diff-menu-toggle', function(e) {
        e.preventDefault();
        e.stopPropagation();
        if ($('#blai-diff-actions-menu').prop('hidden')) openDiffActionsMenu();
        else closeDiffActionsMenu();
    });

    $(document).off('click', '#blai-diff-actions-menu').on('click', '#blai-diff-actions-menu', function(e) {
        e.stopPropagation();
    });

    $(document).off('click.blai-diff-menu').on('click.blai-diff-menu', function(e) {
        if ($(e.target).closest('#blai-diff-menu-toggle, #blai-diff-actions-menu').length === 0) closeDiffActionsMenu();
    });

    $(document).off('click', '#blai-diff-menu-pos-toggle').on('click', '#blai-diff-menu-pos-toggle', function() {
        const settings = extension_settings[extensionName];
        settings.diffButtonInExtraMenu = !settings.diffButtonInExtraMenu;
        saveSettingsDebounced();
        syncDiffPreferenceMenuState();
        closeDiffActionsMenu();
        injectDiffButtons();
    });

    $(document).off('click', '#blai-diff-menu-bottom-toggle').on('click', '#blai-diff-menu-bottom-toggle', function() {
        const settings = extension_settings[extensionName];
        settings.showBottomDiffButton = settings.showBottomDiffButton === false;
        saveSettingsDebounced();
        syncDiffPreferenceMenuState();
        closeDiffActionsMenu();
        injectDiffButtons();
    });

    $(document).off('click', '#blai-diff-mode-toggle').on('click', '#blai-diff-mode-toggle', function() {
        const settings = extension_settings[extensionName];
        settings.diffViewMode = settings.diffViewMode === 'full' ? 'snippet' : 'full';
        saveSettingsDebounced();
        if (runtimeState.currentDiffIndex !== undefined) renderDiffModalContent(runtimeState.currentDiffIndex);
    });

    $(document).off('click', '#blai-diff-related-mode-toggle').on('click', '#blai-diff-related-mode-toggle', function(e) {
        e.preventDefault();
        e.stopPropagation();
        runtimeState.diffRelatedRuleMode = runtimeState.diffRelatedRuleMode !== true;
        syncDiffRelatedModeState();
        closeDiffActionsMenu();
    });

    $(document).off('click', '#blai-diff-limit-edit').on('click', '#blai-diff-limit-edit', function(e) {
        e.preventDefault();
        e.stopPropagation();
        closeDiffActionsMenu();
        syncDiffLimitControlState(true);
        $('#blai-diff-limit-input').trigger('focus').trigger('select');
    });

    $(document).off('click', '#blai-diff-limit-confirm').on('click', '#blai-diff-limit-confirm', function(e) {
        e.preventDefault();
        e.stopPropagation();
        applyDiffLimitDraft();
    });

    $(document).off('click', '#blai-diff-limit-cancel').on('click', '#blai-diff-limit-cancel', function(e) {
        e.preventDefault();
        e.stopPropagation();
        closeDiffLimitEditor();
    });

    $(document).off('keydown', '#blai-diff-limit-input').on('keydown', '#blai-diff-limit-input', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            applyDiffLimitDraft();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeDiffLimitEditor();
        }
    });

    $(document).off('click', '#blai-diff-revert-toggle').on('click', '#blai-diff-revert-toggle', () => toggleCurrentDiffRevert());
    $(document).off('click', '#blai-diff-ai-rewrite').on('click', '#blai-diff-ai-rewrite', () => triggerCurrentDiffAiRewrite());

    $(document).off('click', '#blai-diff-modal-content del.blai-diff-change, #blai-diff-modal-content ins.blai-diff-change').on('click', '#blai-diff-modal-content del.blai-diff-change, #blai-diff-modal-content ins.blai-diff-change', function(e) {
        if (runtimeState.diffRelatedRuleMode !== true) return;
        e.preventDefault();
        e.stopPropagation();
        $('#blai-diff-modal-content .blai-diff-change').removeClass('blai-diff-change-selected');
        $(this).addClass('blai-diff-change-selected');
        showRelatedRulesForDiffElement(this);
    });

    $(document).off('click', '.blai-diff-related-candidate').on('click', '.blai-diff-related-candidate', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const ruleIndex = Number($(this).attr('data-rule-index'));
        const subRuleIndex = Number($(this).attr('data-subrule-index'));
        const rules = extension_settings[extensionName]?.rules || [];
        if (!Number.isInteger(ruleIndex) || ruleIndex < 0 || ruleIndex >= rules.length) return;
        if (!Number.isInteger(subRuleIndex) || subRuleIndex < 0 || subRuleIndex >= (rules[ruleIndex]?.subRules || []).length) return;
        closeDiffRelatedModal();
        openEditModal(ruleIndex, { source: 'search', returnMode: 'related', subRuleIndex });
        openSingleRuleModal(subRuleIndex, { hideEditModal: true });
    });

    $(document).off('click', '#blai-diff-related-close').on('click', '#blai-diff-related-close', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeDiffRelatedModal();
    });
    $(document).off('click', '#blai-diff-related-modal').on('click', '#blai-diff-related-modal', function(e) {
        if (e.target && e.target.id === 'blai-diff-related-modal') closeDiffRelatedModal();
    });

    $(document).off('click', '#blai-diff-modal-close').on('click', '#blai-diff-modal-close', () => closeDiffModal());
    $(document).off('click', '#blai-diff-modal').on('click', '#blai-diff-modal', function(e) { if (e.target && e.target.id === 'blai-diff-modal') closeDiffModal(); });
    
    $(document).off('click', '#blai-open-new-rule-btn').on('click', '#blai-open-new-rule-btn', () => openEditModal(-1));
    $(document).off('click', '.blai-rule-edit').on('click', '.blai-rule-edit', function() { openEditModal($(this).data('index')); });
    $(document).off('click', '.blai-rule-transfer').on('click', '.blai-rule-transfer', function() {
        const index = Number($(this).data('index'));
        const rules = extension_settings[extensionName].rules || [];
        if (!Number.isInteger(index) || index < 0 || index >= rules.length) return;
        if (shouldBatchTransferRule(index, rules)) openTransferModal(getSelectedIndexesFromState(rules));
        else openTransferModal(index);
    });

    $(document).off('click', '.blai-rule-move-up').on('click', '.blai-rule-move-up', function() {
        const index = Number($(this).data('index'));
        const rules = extension_settings[extensionName].rules || [];
        if (!Number.isInteger(index) || index < 0 || index >= rules.length) return;
        const ctx = getBatchOperationContext(index, rules);
        if (ctx.shouldBatch) { if (!batchMoveRules(rules, ctx.selectedIndexes, 'up')) return; }
        else { if (index <= 0) return; [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]]; }
        markRulesDataDirty();
        saveSettingsDebounced();
        renderTagsPreserveBatchSelection();
    });

    $(document).off('click', '.blai-rule-move-down').on('click', '.blai-rule-move-down', function() {
        const index = Number($(this).data('index'));
        const rules = extension_settings[extensionName].rules || [];
        if (!Number.isInteger(index) || index < 0 || index >= rules.length) return;
        const ctx = getBatchOperationContext(index, rules);
        if (ctx.shouldBatch) { if (!batchMoveRules(rules, ctx.selectedIndexes, 'down')) return; }
        else { if (index >= rules.length - 1) return; [rules[index], rules[index + 1]] = [rules[index + 1], rules[index]]; }
        markRulesDataDirty();
        saveSettingsDebounced();
        renderTagsPreserveBatchSelection();
    });

    $(document).off('change', '.blai-rule-toggle').on('change', '.blai-rule-toggle', function() {
        const rules = extension_settings[extensionName].rules || [];
        const index = Number($(this).data('index'));
        if (!Number.isInteger(index) || index < 0 || index >= rules.length) return;
        const targetEnabled = $(this).prop('checked');
        const ctx = getBatchOperationContext(index, rules);
        if (ctx.shouldBatch) ctx.selectedIndexes.forEach((idx) => { rules[idx].enabled = targetEnabled; });
        else rules[index].enabled = targetEnabled;
        markRulesDataDirty();
        saveSettingsDebounced();
        renderTagsPreserveBatchSelection();
        performGlobalCleanse();
    });

    $(document).off('click', '.blai-rule-del').on('click', '.blai-rule-del', function() {
        if (!confirm('确定要删除这个规则分组吗？删除后无法恢复。')) return; 
        const rules = extension_settings[extensionName].rules || [];
        const index = Number($(this).data('index'));
        if (!Number.isInteger(index) || index < 0 || index >= rules.length) return;
        const deletingCount = shouldBatchTransferRule(index, rules) ? getSelectedIndexesFromState(rules).length : 1;
        if (handleDeleteRule(index, rules)) {
            markRulesDataDirty();
            saveSettingsDebounced();
            renderTagsPreserveBatchSelection();
            showToast(deletingCount > 1 ? `已删除 ${deletingCount} 个合集` : '合集删除成功');
        }
    });

    $(document).off('click', '#blai-add-subrule-btn').on('click', '#blai-add-subrule-btn', () => openSingleRuleModal(-1));

    $(document).off('change', '.blai-subrule-toggle').on('change', '.blai-subrule-toggle', function() {
        const index = Number($(this).data('index'));
        if (!Number.isInteger(index) || index < 0 || index >= runtimeState.currentEditingSubrules.length) return;
        runtimeState.currentEditingSubrules[index].enabled = $(this).prop('checked');
        renderSubrulesToModal();
    });

    $(document).off('click', '.blai-move-subrule-up-btn').on('click', '.blai-move-subrule-up-btn', function() {
        const index = Number($(this).data('index'));
        if (index <= 0 || index >= runtimeState.currentEditingSubrules.length) return;
        [runtimeState.currentEditingSubrules[index - 1], runtimeState.currentEditingSubrules[index]] = [runtimeState.currentEditingSubrules[index], runtimeState.currentEditingSubrules[index - 1]];
        renderSubrulesToModal();
    });

    $(document).off('click', '.blai-move-subrule-down-btn').on('click', '.blai-move-subrule-down-btn', function() {
        const index = Number($(this).data('index'));
        if (index < 0 || index >= runtimeState.currentEditingSubrules.length - 1) return;
        [runtimeState.currentEditingSubrules[index], runtimeState.currentEditingSubrules[index + 1]] = [runtimeState.currentEditingSubrules[index + 1], runtimeState.currentEditingSubrules[index]];
        renderSubrulesToModal();
    });

    $(document).off('click', '.blai-del-subrule-btn').on('click', '.blai-del-subrule-btn', function() {
        const index = Number($(this).data('index'));
        if (!Number.isInteger(index) || index < 0 || index >= runtimeState.currentEditingSubrules.length) return;
        if (!confirm('确定要删除该映射规则吗？')) return;
        runtimeState.currentEditingSubrules.splice(index, 1);
        renderSubrulesToModal();
        showToast('词条删除成功');
    });

    $(document).off('click', '.blai-edit-subrule-btn').on('click', '.blai-edit-subrule-btn', function() {
        openSingleRuleModal($(this).data('index'));
    });

    $(document).off('click', '.blai-remark-subrule-btn').on('click', '.blai-remark-subrule-btn', function(e) {
        e.preventDefault();
        const index = $(this).data('index');
        const sub = runtimeState.currentEditingSubrules[index];
        const newRemark = prompt("📝 快捷修改规则备注：\n(若不需要备注，请直接清空并点击确定)", sub.remark || '');
        
        if (newRemark !== null) {
            sub.remark = newRemark.trim();
            renderSubrulesToModal(); 
        }
    });

    $(document).off('change', '#blai-modal-sub-mode').on('change', '#blai-modal-sub-mode', function() {
        applySubruleModeUI(String($(this).val() || 'simple'));
    });

    $(document).off('change', '#blai-modal-sub-rewrite-mode').on('change', '#blai-modal-sub-rewrite-mode', function() {
        applySubruleRewriteModeUI();
    });

    $(document).off('input', '#blai-modal-sub-target').on('input', '#blai-modal-sub-target', () => {
        if ($('#blai-modal-sub-mode').val() === 'regex') validateRegexTargetField();
    });

    $(document).off('click', '#blai-modal-sub-regex-recognize').on('click', '#blai-modal-sub-regex-recognize', () => {
        const result = recognizeRegexReplacementInput();
        if (!result.ok) {
            showToast('留空会直接删除，直接保存条目即可。');
            $('#blai-modal-sub-rep').trigger('focus');
            return;
        }
    });

    $(document).off('click', '.blai-regex-replacement-chip-main').on('click', '.blai-regex-replacement-chip-main', function() {
        if (startEditingRegexReplacementInput($(this).data('index'))) {
            $('#blai-modal-sub-rep').trigger('focus');
        }
    });

    $(document).off('click', '.blai-regex-replacement-chip-remove').on('click', '.blai-regex-replacement-chip-remove', function(e) {
        e.preventDefault();
        e.stopPropagation();
        removeRegexReplacementInput($(this).data('index'));
    });

    $(document).off('click', '#blai-modal-sub-save').on('click', '#blai-modal-sub-save', function() {
        const mode = String($('#blai-modal-sub-mode').val() || 'simple');
        const rewriteMode = $('#blai-modal-sub-rewrite-mode').val() === 'ai' ? 'ai' : 'program';
        const tStr = String($('#blai-modal-sub-target').val() || '');
        const remarkStr = String($('#blai-modal-sub-remark').val() || '').trim();
        const aiPromptTemplate = String($('#blai-modal-sub-ai-prompt').val() || '').trim();
        const isDirectSearchFlow = isSearchDirectSubruleFlow();
        const isRelatedFlow = isRelatedDirectSubruleFlow();

        if (mode === 'regex') {
            const validation = validateRegexTargetField();
            if (!validation.ok) {
                showToast(`正则规则有误：${validation.uiMessage || formatRegexTargetError(validation.error)}`);
                $('#blai-modal-sub-target').trigger('focus');
                return;
            }
        } else {
            clearRegexTargetValidationState();
        }

        if (mode === 'regex' && hasPendingRegexReplacementInput()) {
            showToast('替换框里还有未处理的内容，请先点右侧按钮。');
            $('#blai-modal-sub-rep').trigger('focus');
            return;
        }
        
        const targets = parseInputToWords(tStr, mode, { isTarget: true });
        const replacements = getSingleRuleReplacementValues(mode);

        if (targets.length === 0) {
            showToast("查找内容不能为空！");
            $('#blai-modal-sub-target').trigger('focus');
            return;
        }

        const previousSubRule = runtimeState.currentSubruleEditIndex >= 0
            ? runtimeState.currentEditingSubrules[runtimeState.currentSubruleEditIndex]
            : null;
        const subRule = {
            targets,
            replacements,
            mode,
            rewriteMode,
            remark: remarkStr,
            aiPromptTemplate: rewriteMode === 'ai' ? aiPromptTemplate : '',
            enabled: previousSubRule?.enabled !== false,
        };

        if (runtimeState.currentSubruleEditIndex === -1) {
            runtimeState.currentEditingSubrules.push(subRule);
        } else {
            runtimeState.currentEditingSubrules[runtimeState.currentSubruleEditIndex] = subRule;
        }

        clearRegexTargetValidationState();
        if (isDirectSearchFlow || isRelatedFlow) {
            const saveResult = saveCurrentEditingRule({ toastMessage: '条目保存成功', focusLatest: false });
            if (!saveResult.ok) return;
            $('#blai-subrule-edit-modal').fadeOut(150, () => {
                $('#blai-rule-edit-modal').hide();
                clearRuleSearchEditFlow();
                if (isDirectSearchFlow) openRuleSearchModal();
                else if (runtimeState.currentDiffIndex !== undefined) renderDiffModalContent(runtimeState.currentDiffIndex);
            });
            return;
        }

        $('#blai-subrule-edit-modal').fadeOut(150);
        renderSubrulesToModal();

        if (runtimeState.currentSubruleEditIndex === -1) {
            const container = $('#blai-edit-subrules-container');
            container.scrollTop(container[0].scrollHeight);
        }
    });

    $(document).off('click', '#blai-modal-sub-cancel').on('click', '#blai-modal-sub-cancel', () => {
        clearRegexTargetValidationState();
        if (isSearchDirectSubruleFlow() || isRelatedDirectSubruleFlow()) {
            const shouldReturnSearch = isSearchDirectSubruleFlow();
            $('#blai-subrule-edit-modal').fadeOut(150, () => {
                $('#blai-rule-edit-modal').hide();
                clearRuleSearchEditFlow();
                if (shouldReturnSearch) openRuleSearchModal();
            });
            return;
        }
        $('#blai-subrule-edit-modal').fadeOut(150);
    });

    $(document).off('click', '#blai-edit-cancel-x').on('click', '#blai-edit-cancel-x', () => {
        $('#blai-rule-edit-modal').hide();
        if (isSearchGroupEditFlow()) {
            clearRuleSearchEditFlow();
            openRuleSearchModal();
        }
    });
    $(document).off('click', '#blai-transfer-cancel').on('click', '#blai-transfer-cancel', () => closeTransferModal());
    $(document).off('click', '#blai-transfer-copy').on('click', '#blai-transfer-copy', () => runRuleTransfer(false));
    $(document).off('click', '#blai-transfer-move').on('click', '#blai-transfer-move', () => runRuleTransfer(true));
    $(document).off('click', '#blai-rule-transfer-modal').on('click', '#blai-rule-transfer-modal', function(e) {
        if (e.target && e.target.id === 'blai-rule-transfer-modal') closeTransferModal();
    });

    $(document).off('click', '#blai-edit-save').on('click', '#blai-edit-save', () => {
        const saveResult = saveCurrentEditingRule({ toastMessage: '合集保存成功', focusLatest: true });
        if (!saveResult.ok) return;
        $('#blai-rule-edit-modal').hide();
        if (isSearchGroupEditFlow()) {
            clearRuleSearchEditFlow();
            openRuleSearchModal();
        }
    });

    $(document).off('click', '#blai-deep-clean-btn').on('click', '#blai-deep-clean-btn', () => showConfirmModal(() => performDeepCleanse()));

    $(document).off('change', '#blai-preset-select').on('change', '#blai-preset-select', function() {
        const settings = extension_settings[extensionName];
        const oldPreset = settings.activePreset;
        const newPreset = $(this).val();

        if (oldPreset && newPreset !== oldPreset && checkUnsavedChanges()) {
            if (confirm(`预设 "${oldPreset}" 有未保存的规则或 AI 生成限制改动，是否在切换前保存？\n点击【确定】保存，点击【取消】放弃改动。`)) {
                settings.presets[oldPreset] = buildCurrentPresetEntry(settings.rules);
                saveSettingsDebounced();
            }
        }

        applyPresetByName(newPreset, { skipRender: true });
        renderTags();
        refreshCharacterBindingUI();
    });

    $(document).off('change.blai-purifier-chat-preset-binding', '#settings_preset_openai').on('change.blai-purifier-chat-preset-binding', '#settings_preset_openai', function() {
        setTimeout(() => {
            applyCharacterPresetBinding(true, { skipCleanse: true });
            refreshCharacterBindingUI();
        }, 0);
    });

    $(document).off('click', '#blai-default-toggle').on('click', '#blai-default-toggle', function() {
        const settings = extension_settings[extensionName];
        const activePreset = String(settings.activePreset || '');
        if (!activePreset) { alert('请先在下拉框中选择一个净化预设。'); return; }
        const isDefaultActive = settings.defaultPreset === activePreset;
        settings.defaultPreset = isDefaultActive ? "" : activePreset;
        saveSettingsDebounced();
        refreshCharacterBindingUI();
        showToast(isDefaultActive ? '已取消全局默认' : `已设为全局默认：${activePreset}`);
    });

    $(document).off('click', '#blai-character-bind-toggle').on('click', '#blai-character-bind-toggle', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const $menu = $('#blai-bind-menu');
        const shouldOpen = $menu.prop('hidden');
        $menu.prop('hidden', !shouldOpen);
        $(this).attr('aria-expanded', String(shouldOpen));
        refreshCharacterBindingUI();
    });

    $(document).off('click', '.blai-bind-menu-item').on('click', '.blai-bind-menu-item', function(e) {
        e.preventDefault();
        e.stopPropagation();
        if ($(this).prop('disabled')) return;
        const settings = extension_settings[extensionName];
        const action = String($(this).attr('data-bind-action') || '');
        const activePreset = String(settings.activePreset || '');
        const context = getCurrentCharacterContext();
        const chatCompletionPresetName = getCurrentChatCompletionPresetName();
        const activeUsage = getPresetBindingUsage(activePreset);

        if (action === 'character') {
            if (!activePreset) { alert('请先在下拉框中选择一个净化预设。'); return; }
            if (!context.key) { alert('当前页面未识别到可绑定角色。'); refreshCharacterBindingUI(); return; }
            if (activeUsage.hasChatCompletionPresetBindings && settings.characterBindings?.[context.key] !== activePreset) {
                const shouldSwitch = confirm(`净化预设「${activePreset}」当前是对话补全预设绑定。是否切换为角色绑定？\n这会移除它已有的 ${activeUsage.chatCompletionPresetNames.length} 个对话补全预设绑定。`);
                if (!shouldSwitch) {
                    refreshCharacterBindingUI();
                    return;
                }
                removeBindingEntriesForPreset(settings.chatCompletionPresetBindings, activePreset);
            }
            if (!settings.characterBindings) settings.characterBindings = {};
            settings.characterBindings[context.key] = activePreset;
            runtimeState.lastCharacterContextKey = context.key;
            runtimeState.lastPresetBindingSignature = "";
            applyPresetByName(activePreset, { skipRender: true });
            saveSettingsDebounced();
            refreshCharacterBindingUI();
            $('#blai-bind-menu').prop('hidden', true);
            $('#blai-character-bind-toggle').attr('aria-expanded', 'false');
            showToast(`已绑定：${context.name} → ${activePreset}`);
            return;
        }

        if (action === 'chat-preset') {
            if (!activePreset) { alert('请先在下拉框中选择一个净化预设。'); return; }
            if (!chatCompletionPresetName) { alert('当前没有识别到 ST 对话补全预设。'); refreshCharacterBindingUI(); return; }
            if (activeUsage.hasCharacterBindings && settings.chatCompletionPresetBindings?.[chatCompletionPresetName] !== activePreset) {
                const shouldSwitch = confirm(`净化预设「${activePreset}」当前是角色绑定。是否切换为对话补全预设绑定？\n这会移除它已有的 ${activeUsage.characterKeys.length} 个角色绑定。`);
                if (!shouldSwitch) {
                    refreshCharacterBindingUI();
                    return;
                }
                removeBindingEntriesForPreset(settings.characterBindings, activePreset);
            }
            if (!settings.chatCompletionPresetBindings || typeof settings.chatCompletionPresetBindings !== 'object') settings.chatCompletionPresetBindings = {};
            settings.chatCompletionPresetBindings[chatCompletionPresetName] = activePreset;
            runtimeState.lastPresetBindingSignature = "";
            applyPresetByName(activePreset, { skipRender: true });
            saveSettingsDebounced();
            refreshCharacterBindingUI();
            $('#blai-bind-menu').prop('hidden', true);
            $('#blai-character-bind-toggle').attr('aria-expanded', 'false');
            showToast(`已绑定：对话补全预设 ${chatCompletionPresetName} → ${activePreset}`);
            return;
        }

        if (action === 'unbind-character') {
            const removedRolePreset = context.key ? settings.characterBindings?.[context.key] : '';
            const removedChatPreset = chatCompletionPresetName ? settings.chatCompletionPresetBindings?.[chatCompletionPresetName] : '';
            if (removedRolePreset) {
                delete settings.characterBindings[context.key];
            } else if (removedChatPreset) {
                delete settings.chatCompletionPresetBindings[chatCompletionPresetName];
            } else {
                refreshCharacterBindingUI();
                return;
            }
            runtimeState.lastCharacterContextKey = "";
            runtimeState.lastPresetBindingSignature = "";
            applyCharacterPresetBinding(true);
            saveSettingsDebounced();
            refreshCharacterBindingUI();
            $('#blai-bind-menu').prop('hidden', true);
            $('#blai-character-bind-toggle').attr('aria-expanded', 'false');
            showToast(removedRolePreset ? '已取消当前角色绑定，改为跟随全局默认' : '已取消当前对话补全预设绑定，改为跟随全局默认');
            return;
        }

    });

    $(document).off('click', '#blai-preset-rename').on('click', '#blai-preset-rename', function() {
        const settings = extension_settings[extensionName];
        const oldName = settings.activePreset;
        if (!oldName) { alert("当前为临时规则，请先新建存档。"); return; }
        const newName = prompt("输入新存档名称：", oldName);
        if (!newName || newName === oldName) return;
        if (settings.presets[newName]) { alert("存档名称已存在。"); return; }
        settings.presets[newName] = settings.presets[oldName];
        delete settings.presets[oldName];
        if (settings.defaultPreset === oldName) settings.defaultPreset = newName;
        Object.keys(settings.characterBindings || {}).forEach((key) => {
            if (settings.characterBindings[key] === oldName) settings.characterBindings[key] = newName;
        });
        Object.keys(settings.chatCompletionPresetBindings || {}).forEach((name) => {
            if (settings.chatCompletionPresetBindings[name] === oldName) settings.chatCompletionPresetBindings[name] = newName;
        });
        settings.activePreset = newName;
        markPresetsUiDirty(true);
        saveSettingsDebounced();
        updateToolbarUI();
        showToast(`已重命名为：${newName}`);
    });

    $(document).off('click', '#blai-preset-delete').on('click', '#blai-preset-delete', function() {
        const settings = extension_settings[extensionName];
        const name = settings.activePreset;
        if (!name) { showToast('当前为临时规则，没有可删除的存档'); return; }
        if (confirm(`确定删除存档 "${name}" 吗？`)) {
            delete settings.presets[name];
            if (settings.defaultPreset === name) settings.defaultPreset = "";
            Object.keys(settings.characterBindings || {}).forEach((key) => {
                if (settings.characterBindings[key] === name) delete settings.characterBindings[key];
            });
            Object.keys(settings.chatCompletionPresetBindings || {}).forEach((presetName) => {
                if (settings.chatCompletionPresetBindings[presetName] === name) delete settings.chatCompletionPresetBindings[presetName];
            });
            settings.activePreset = "";
            settings.rules = [];
            markRulesDataDirty({ presetsUi: true });
            saveSettingsDebounced();
            renderTags();
            updateToolbarUI();
            performGlobalCleanse();
            showToast("删除成功");
        }
    });

    $(document).off('click', '#blai-preset-new').on('click', '#blai-preset-new', function() {
        const settings = extension_settings[extensionName];
        const name = prompt("输入新存档名称：");
        if (!name) return;
        if (settings.presets[name]) { alert("存档名称已存在。"); return; }
        settings.presets[name] = buildCurrentPresetEntry([]);
        settings.activePreset = name;
        settings.rules = [];
        markRulesDataDirty({ presetsUi: true });
        saveSettingsDebounced();
        updateToolbarUI();
        renderTags(); // 必须重新渲染以清空列表
        showToast(`已新建存档：${name}`);
    });

    $(document).off('click', '#blai-preset-save').on('click', '#blai-preset-save', function() {
        const settings = extension_settings[extensionName];
        if (!settings.activePreset) { showToast("当前为临时规则，请点击“新建”保存为新存档。"); return; }
        settings.presets[settings.activePreset] = buildCurrentPresetEntry(settings.rules);
        saveSettingsDebounced();
        showToast("保存成功");
    });

    $(document).off('click', '#blai-preset-export').on('click', '#blai-preset-export', function() {
        const settings = extension_settings[extensionName];
        const data = JSON.stringify(buildPresetExportPayload(settings), null, 2);
        const blob = new Blob([data], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (settings.activePreset || "临时规则") + ".json";
        a.click();
        URL.revokeObjectURL(url);
        showToast(`已导出：${a.download}`);
    });

    $(document).off('click', '#blai-preset-import').on('click', '#blai-preset-import', function() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.style.position = 'fixed';
        input.style.left = '-1000px';
        input.style.top = '0';
        input.style.width = '1px';
        input.style.height = '1px';
        input.style.opacity = '0';
        input.style.pointerEvents = 'none';
        document.body.appendChild(input);
        const cleanupInput = () => {
            window.setTimeout(() => {
                if (input.parentNode) input.parentNode.removeChild(input);
            }, 0);
        };
        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) {
                cleanupInput();
                return;
            }
            const reader = new FileReader();
            reader.onload = event => {
                try {
                    const importedPayload = JSON.parse(event.target.result);
                    const importedRules = normalizeImportedRulesPayload(importedPayload);
                    if (!Array.isArray(importedRules)) throw new Error("格式非数组");
                    const importedAiRewriteSettings = extractPresetImportAiRewriteSettings(importedPayload);

                    const defaultName = file.name.replace(/\.json$/i, '');
                    if (!confirmBeforeImportChoiceIfUnsaved()) return;
                    openImportChoiceModal(importedRules, defaultName, importedAiRewriteSettings);
                } catch (err) {
                    alert("导入失败：检查文件是否为合法规则数组。");
                } finally {
                    cleanupInput();
                }
            };
            reader.onerror = cleanupInput;
            reader.readAsText(file);
        };
        input.click();
        window.setTimeout(cleanupInput, 120000);
    });

    $(document).off('click', '#blai-import-only').on('click', '#blai-import-only', () => importPresetOnly());
    $(document).off('click', '#blai-import-switch').on('click', '#blai-import-switch', () => importPresetAndSwitch());
    $(document).off('click', '#blai-import-preview').on('click', '#blai-import-preview', () => importPresetAsTemporaryPreview());
    $(document).off('click', '#blai-import-choice-close').on('click', '#blai-import-choice-close', () => closeImportChoiceModal());
    $(document).off('click', '#blai-preset-import-choice-modal').on('click', '#blai-preset-import-choice-modal', function(e) {
        if (e.target && e.target.id === 'blai-preset-import-choice-modal') closeImportChoiceModal();
    });
    $(document).off('keydown', '#blai-import-preset-name').on('keydown', '#blai-import-preset-name', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            importPresetOnly();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeImportChoiceModal();
        }
    });

    const markPendingFromPayload = (payload, options = {}) => {
        const { chat } = getAppContext();
        let index = getMessageIndexFromEvent(payload);
        if (index < 0) index = getLatestMessageIndex();
        if (index < 0 || !Array.isArray(chat) || !isAssistantMessage(chat[index])) return;
        markDiffComparisonPending(index, computeMessageSignature(chat[index]), options);
        if (options.skipInject !== true) injectDiffButtonsStreamingSafe([index]);
    };

    let delayedCleanseTimer = null;
    let settleCleanseTimer = null;
    const resolveStreamingRawSourceForPayload = (payload) => {
        let index = getMessageIndexFromEvent(payload);
        if (index < 0) index = getLatestMessageIndex();
        if (index < 0) return { index: -1, sourceMes: undefined };
        const sourceMes = runtimeState.streamingRawMessageCache.get(index);
        return {
            index,
            sourceMes: typeof sourceMes === 'string' ? sourceMes : undefined,
        };
    };

    const getLatestAssistantMessageIndex = () => {
        const { chat } = getAppContext();
        if (!Array.isArray(chat)) return -1;
        for (let index = chat.length - 1; index >= 0; index--) {
            if (isAssistantMessage(chat[index])) return index;
        }
        return -1;
    };

    const getStreamEventText = (payload, extraArgs = []) => {
        if (typeof payload === 'string') return payload;
        for (const arg of extraArgs) {
            if (typeof arg === 'string') return arg;
        }
        if (!payload || typeof payload !== 'object') return '';
        for (const key of ['text', 'message', 'content', 'mes', 'fullText', 'full_text', 'token', 'chunk', 'delta', 'value']) {
            if (typeof payload[key] === 'string') return payload[key];
        }
        return '';
    };

    const getStreamEventIndex = (payload, extraArgs = []) => {
        const direct = getMessageIndexFromEvent(payload);
        if (direct >= 0) return direct;
        for (const arg of extraArgs) {
            const index = getMessageIndexFromEvent(arg);
            if (index >= 0) return index;
        }
        return -1;
    };

    const describeStreamEventArgs = (payload, extraArgs = []) => ({
        payload: describeStreamPayload(payload),
        extra: extraArgs.slice(0, 3).map((arg) => describeStreamPayload(arg)),
    });

    const maybeNotifyAiRewriteReadyFromStreamEvent = (payload, extraArgs = []) => {
        const explicitIndex = getStreamEventIndex(payload, extraArgs);
        const index = explicitIndex >= 0 ? explicitIndex : getLatestAssistantMessageIndex();
        const rawText = getStreamEventText(payload, extraArgs);
        if (!rawText) {
            streamEventNoTextProbeCount += 1;
            if (streamEventNoTextProbeCount <= 3 || streamEventNoTextProbeCount % 25 === 0) {
                recordAiRewriteRuntimeDebug('stream-event-no-text', {
                    count: streamEventNoTextProbeCount,
                    explicitIndex,
                    index,
                    payload: describeStreamEventArgs(payload, extraArgs),
                });
            }
            return;
        }

        const { chat } = getAppContext();
        if (index < 0 || !Array.isArray(chat) || !isAssistantMessage(chat[index])) return;

        const previousText = streamEventTextByMessageId.get(index) || '';
        const merged = mergeStreamEventText(previousText, rawText);
        streamEventTextByMessageId.set(index, merged.text);
        runtimeState.streamingRawMessageCache.set(index, merged.text);

        const probe = getStreamEventProbe(index, merged.text);
        if (probe.shouldLog) {
            recordAiRewriteRuntimeDebug('stream-event-token', {
                index,
                explicitIndex,
                count: probe.count,
                mergeMode: merged.mode,
                rawLength: rawText.length,
                previousLength: previousText.length,
                combinedLength: merged.text.length,
                hasXmlLikeClose: probe.hasXmlClose,
                payload: describeStreamEventArgs(payload, extraArgs),
            });
        }

        maybeNotifyAiRewriteReadyFromStreamingText(index, merged.text);
    };

    const runFinalStreamingCleanse = (payload, options = {}) => {
        const { index, sourceMes } = resolveStreamingRawSourceForPayload(payload);
        performIncrementalCleanse(payload, {
            visualOnly: false,
            fallbackLatest: true,
            diffSourceMes: sourceMes,
        });
        if (options.clearRawSource === true && index >= 0) {
            runtimeState.streamingRawMessageCache.delete(index);
        }
    };

    const delayedIncrementalCleanse = (payload, options = {}) => {
        runtimeState.isStreamingGeneration = false;
        markPendingFromPayload(payload, { skipPersist: false });
        if (delayedCleanseTimer) clearTimeout(delayedCleanseTimer);
        if (settleCleanseTimer) clearTimeout(settleCleanseTimer);
        delayedCleanseTimer = setTimeout(() => { runFinalStreamingCleanse(payload); }, 150);
        settleCleanseTimer = setTimeout(() => {
            runFinalStreamingCleanse(payload, { clearRawSource: true });
            if (options.scheduleAiRewrite !== false) {
                markAiRewriteFinalCleanseReady(payload);
            }
        }, 700);
    };

    let editCleanseTimer = null;
    if (event_types.MESSAGE_EDITED) {
        eventSource.on(event_types.MESSAGE_EDITED, (payload) => {
            markPendingFromPayload(payload);
            if (editCleanseTimer) clearTimeout(editCleanseTimer);
            editCleanseTimer = setTimeout(() => { performIncrementalCleanse(payload, { visualOnly: false, fallbackLatest: true }); }, 100);
        });
    }

    if (isTauriTavernHost() || isBaiBaiToolkitInstalled()) {
        let updateCleanseTimer = null;
        const pendingRenderedCleanseIndices = new Set();
        const shouldSkipOwnRenderedEvent = (index) => {
            const until = runtimeState.hostRenderedEventSuppressUntil?.get(index);
            if (!Number.isFinite(until)) return false;
            if (Date.now() <= until) return true;
            runtimeState.hostRenderedEventSuppressUntil.delete(index);
            return false;
        };
        const scheduleRenderedMessageCleanse = (payload, delay = 120) => {
            const explicitIndex = getMessageIndexFromEvent(payload);
            const index = explicitIndex >= 0 ? explicitIndex : getLatestMessageIndex();
            if (index < 0) return;
            if (shouldSkipOwnRenderedEvent(index)) return;
            pendingRenderedCleanseIndices.add(index);
            markPendingFromPayload(index);
            if (updateCleanseTimer) clearTimeout(updateCleanseTimer);
            updateCleanseTimer = setTimeout(() => {
                const indices = [...pendingRenderedCleanseIndices];
                pendingRenderedCleanseIndices.clear();
                indices.forEach((messageIndex) => {
                    performIncrementalCleanse(messageIndex, { visualOnly: false, fallbackLatest: true });
                });
            }, delay);
        };

        if (event_types.MESSAGE_UPDATED) eventSource.on(event_types.MESSAGE_UPDATED, (payload) => scheduleRenderedMessageCleanse(payload, 120));
        if (event_types.CHARACTER_MESSAGE_RENDERED) eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (payload) => scheduleRenderedMessageCleanse(payload, 180));
    }

    if (event_types.GENERATION_STARTED) eventSource.on(event_types.GENERATION_STARTED, () => {
        runtimeState.isStreamingGeneration = true;
        runtimeState.streamingRawMessageCache.clear();
        clearStreamEventBuffers();
        handleAiRewriteGenerationStarted();
    });
    if (event_types.STREAM_TOKEN_RECEIVED) {
        const onStreamTokenReceived = (payload, ...extraArgs) => {
            runtimeState.isStreamingGeneration = true;
            try {
                if (typeof installStreamingProcessorCleanserFromEvents === 'function') {
                    installStreamingProcessorCleanserFromEvents();
                }
            } catch (error) {
                if (!streamProcessorInstallFailureLogged) {
                    streamProcessorInstallFailureLogged = true;
                    recordAiRewriteRuntimeDebug('streaming-processor-install-failed', {
                        reason: error?.message || String(error || 'unknown'),
                    }, 'warn');
                }
            }
            maybeNotifyAiRewriteReadyFromStreamEvent(payload, extraArgs);
        };
        if (typeof eventSource.makeFirst === 'function') eventSource.makeFirst(event_types.STREAM_TOKEN_RECEIVED, onStreamTokenReceived);
        else eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamTokenReceived);
    }
    if (event_types.GENERATION_ENDED) eventSource.on(event_types.GENERATION_ENDED, (payload) => delayedIncrementalCleanse(payload));
    if (event_types.GENERATION_STOPPED) eventSource.on(event_types.GENERATION_STOPPED, (payload) => delayedIncrementalCleanse(payload));
    if (event_types.MESSAGE_RECEIVED) eventSource.on(event_types.MESSAGE_RECEIVED, (payload) => delayedIncrementalCleanse(payload));
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, (payload) => delayedIncrementalCleanse(payload, { scheduleAiRewrite: false }));
    if (event_types.PRESET_CHANGED) {
        eventSource.on(event_types.PRESET_CHANGED, (payload) => {
            if (payload && payload.apiId && payload.apiId !== 'openai') return;
            setTimeout(() => applyCharacterPresetBinding(true, { skipCleanse: true }), 0);
        });
    }
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            resetAiRewriteRuntimeState('chat-changed');
            resetDiffRuntimeState();
            runtimeState.streamingRawMessageCache.clear();
            clearStreamEventBuffers();
            runtimeState.currentDiffIndex = undefined;
            $('#blai-diff-modal').hide();
            applyCharacterPresetBinding(true, { skipCleanse: true });
            restoreDiffStateFromChatMetadata();
            setTimeout(() => { injectDiffButtons(); performGlobalCleanse({ deferLargeChat: true }); }, 120);
        });
    }

    setInterval(() => applyCharacterPresetBinding(false, { skipCleanse: true }), 1200);
}
