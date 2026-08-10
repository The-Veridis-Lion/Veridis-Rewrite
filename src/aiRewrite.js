import { defaultAiRewriteSettings, extensionName, getAppContext, normalizeAiSamplingSettings, runtimeState } from './state.js';
import { logger } from './log.js';
import {
    applyScopedReplacements,
    buildSimpleTargetPattern,
    buildTargetLiteralPattern,
    pickReplacement,
    queueIncrementalChatSave,
    preserveMvuStatusPlaceholder,
    refreshMessageDisplay,
    resolveRegexProcessorReplacement,
    resolveMessageDiffSource,
    syncMessageDiffMetadata,
} from './core.js';
import { compileRegexTarget, mergeScopeTagsWithBuiltins, normalizeOptionalXmlTagNameInput } from './utils.js';
import { getZhVariantCompatOptions, isZhDictionaryReady } from './zhConversion.js';
import { buildDiffResultFromChain, computeMessageSignature, isAssistantMessage, writeReadyDiffCache } from './diff.js';
import { beginAtomicMessageDisplaySwap } from './dom.js';
import { clearMessageDisplayText, commitCurrentMessageText, getMessageDiffBranchKey, isMessageManualFinal, setMessageTextForMvuTransaction, syncCurrentSwipeExtra, writeMessageDiffAiTrace } from './messageMeta.js';
import { getCurrentChatIdentity, markHostChatDirtyFromIndex } from './platform.js';
import { generationLifecycle, parseStableMessagePayload } from './generationLifecycle.js';
import { showToast } from './ui.js';
import { applyWithXmlCommentsProtected, collectXmlCommentRanges, maskXmlCommentRanges } from './aiCommentProtection.js';
import { buildAiRewriteGenerateRawConfig } from './aiGeneration.js';

const responseGuard = `输出必须是一个 JSON 对象，键必须恰好为本次全部 rewrite_target 的 id，值必须是可直接替换对应标签内容的字符串；空字符串表示删除。禁止 markdown、解释和额外包装。`;

let readyNoticeTimer = null;
const automaticRunPromiseByGenerationId = new Map();
const debugLogStorageKey = `${extensionName}_ai_rewrite_debug_events`;
const criticalDebugLogStorageKey = `${extensionName}_ai_rewrite_critical_debug_events`;
const debugLogDomAttribute = 'data-veridis-ai-rewrite-debug-events';
const debugLogLimit = 60;
const criticalDebugLogLimit = 160;
const criticalDebugStages = new Set([
    'streaming-xml-end-detected',
    'content-snapshot-frozen',
    'task-built',
    'popup-preparing',
    'request-claimed',
    'pre-run-validation',
    'run-start',
    'fetch-start',
    'fetch-response',
    'apply-deferred',
    'response-deferred',
    'final-cleanse-ready',
    'apply-start',
    'apply-success',
    'atomic-commit',
    'apply-skip',
    'task-cancelled',
    'popup-cleared',
]);
const streamingXmlTailLookbackChars = 64;
const streamingXmlScanByMessageId = new Map();

function hashString(value = '') {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return `h${(hash >>> 0).toString(16)}`;
}

function getSettings() {
    const { extension_settings } = getAppContext();
    return extension_settings?.[extensionName] || {};
}

function getAiSettings() {
    return getSettings().aiRewrite || {};
}

function sanitizeDebugValue(value, depth = 0) {
    if (depth > 3) return '[depth-limit]';
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return value.length > 600 ? `${value.slice(0, 600)}...` : value;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitizeDebugValue(item, depth + 1));
    if (typeof value === 'object') {
        const output = {};
        Object.entries(value).forEach(([key, item]) => {
            if (/^(prompt|promptTemplate|aiPromptTemplate|rewritten|originalMessage|messageText|text)$/i.test(key)
                || /api.?key|authorization/i.test(key)) {
                output[key] = '[redacted]';
                return;
            }
            output[key] = sanitizeDebugValue(item, depth + 1);
        });
        return output;
    }
    return String(value);
}

function readStoredDebugEvents() {
    try {
        const raw = localStorage.getItem(debugLogStorageKey);
        const parsed = JSON.parse(raw || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function readStoredCriticalDebugEvents() {
    try {
        const raw = localStorage.getItem(criticalDebugLogStorageKey);
        const parsed = JSON.parse(raw || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeStoredDebugEvents(events) {
    try {
        localStorage.setItem(debugLogStorageKey, JSON.stringify(events.slice(-debugLogLimit)));
    } catch {
        // Ignore storage failures; console/runtime logs still work.
    }
}

function writeStoredCriticalDebugEvents(events) {
    try {
        localStorage.setItem(criticalDebugLogStorageKey, JSON.stringify(events.slice(-criticalDebugLogLimit)));
    } catch {
        // Ignore storage failures; runtime logs still work.
    }
}

function mergeDebugEvents(...groups) {
    const seen = new Set();
    return groups.flat().filter((event) => {
        const key = `${event?.time}|${event?.stage}|${JSON.stringify(event?.details || {})}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).sort((a, b) => String(a?.time || '').localeCompare(String(b?.time || '')));
}

function recordAiRewriteDebug(stage, details = {}, level = 'info') {
    const sanitizedDetails = sanitizeDebugValue(details);
    const event = {
        time: new Date().toISOString(),
        stage: String(stage || 'unknown'),
        details: sanitizedDetails,
    };
    const stateEvents = Array.isArray(runtimeState.aiRewrite.debugEvents)
        ? runtimeState.aiRewrite.debugEvents
        : [];
    stateEvents.push(event);
    runtimeState.aiRewrite.debugEvents = stateEvents.slice(-debugLogLimit);
    if (criticalDebugStages.has(event.stage)) {
        const criticalEvents = Array.isArray(runtimeState.aiRewrite.criticalDebugEvents)
            ? runtimeState.aiRewrite.criticalDebugEvents
            : [];
        criticalEvents.push(event);
        runtimeState.aiRewrite.criticalDebugEvents = criticalEvents.slice(-criticalDebugLogLimit);
        const storedCritical = readStoredCriticalDebugEvents();
        storedCritical.push(event);
        writeStoredCriticalDebugEvents(storedCritical);
    }
    const exposedEvents = mergeDebugEvents(
        runtimeState.aiRewrite.criticalDebugEvents || [],
        runtimeState.aiRewrite.debugEvents || [],
    );
    try {
        globalThis.__veridisAiRewriteLog = exposedEvents;
    } catch {
        // Ignore global exposure failures.
    }
    try {
        document?.documentElement?.setAttribute?.(debugLogDomAttribute, JSON.stringify(exposedEvents));
    } catch {
        // Ignore DOM exposure failures; storage/console logs still work.
    }
    const stored = readStoredDebugEvents();
    stored.push(event);
    writeStoredDebugEvents(stored);
    let summary = '';
    try {
        summary = JSON.stringify(sanitizedDetails);
        if (summary.length > 700) summary = `${summary.slice(0, 700)}...`;
    } catch {
        summary = '';
    }
    const message = `[AI诊断] ${event.stage}${summary ? ` | ${summary}` : ''}`;
    if (level === 'warn') logger.warn(message, event.details);
    else if (level === 'error') logger.error(message, event.details);
    else logger.info(message, event.details);
    return event;
}

export function recordAiRewriteRuntimeDebug(stage, details = {}, level = 'info') {
    return recordAiRewriteDebug(stage, details, level);
}

export function getAiRewriteDebugLogText() {
    const combined = mergeDebugEvents(
        readStoredCriticalDebugEvents(),
        runtimeState.aiRewrite.criticalDebugEvents || [],
        readStoredDebugEvents(),
        runtimeState.aiRewrite.debugEvents || [],
    );
    const seen = new Set();
    const deduped = combined.filter((event) => {
        const key = `${event.time}|${event.stage}|${JSON.stringify(event.details || {})}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(-(criticalDebugLogLimit + debugLogLimit));
    runtimeState.aiRewrite.debugEvents = deduped.slice(-debugLogLimit);
    runtimeState.aiRewrite.criticalDebugEvents = deduped
        .filter(event => criticalDebugStages.has(event.stage))
        .slice(-criticalDebugLogLimit);
    writeStoredDebugEvents(runtimeState.aiRewrite.debugEvents);
    writeStoredCriticalDebugEvents(runtimeState.aiRewrite.criticalDebugEvents);
    return JSON.stringify(deduped, null, 2);
}

export function clearAiRewriteDebugLog() {
    runtimeState.aiRewrite.debugEvents = [];
    runtimeState.aiRewrite.criticalDebugEvents = [];
    try {
        localStorage.removeItem(debugLogStorageKey);
        localStorage.removeItem(criticalDebugLogStorageKey);
    } catch {
        // Ignore storage failures.
    }
    try {
        document?.documentElement?.removeAttribute?.(debugLogDomAttribute);
    } catch {
        // Ignore DOM exposure failures.
    }
}

function normalizeLimit(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(Math.round(parsed), min), max);
}

function normalizePositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(Math.round(parsed), 1) : fallback;
}

function getAiRetryCount(aiSettings) {
    return normalizeLimit(aiSettings?.maxRetries, 2, 0, 5);
}

function stripStatusText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function getToastApi() {
    return globalThis?.toastr || (typeof window !== 'undefined' ? window.toastr : null);
}

function getToastElement(toast) {
    if (!toast) return null;
    if (typeof Element !== 'undefined' && toast instanceof Element) return toast;
    if (toast?.jquery) return toast[0] || null;
    if (typeof toast?.get === 'function') return toast.get(0);
    return null;
}

function removeToastElement(toastElement) {
    if (!toastElement) return;
    try {
        if (typeof toastElement.remove === 'function') {
            toastElement.remove();
            return;
        }
    } catch {
        // Fall through to parent removal.
    }
    if (toastElement.parentNode) {
        toastElement.parentNode.removeChild(toastElement);
    }
}

function clearAiRewriteStatusToast(extraToastElement = null, reason = '') {
    const rewriteState = runtimeState.aiRewrite;
    const clearedTaskKey = String(rewriteState?.statusTaskKey || '');
    const hadStatus = Boolean(rewriteState?.statusToast || clearedTaskKey);
    const toastApi = getToastApi();
    const toastElement = getToastElement(rewriteState?.statusToast);
    if (rewriteState?.statusToast && toastApi && typeof toastApi.clear === 'function') {
        try {
            toastApi.clear(rewriteState.statusToast);
        } catch (err) {
            logger.warn('清理 AI 改写状态弹窗失败', err);
        }
    }
    if (rewriteState?.statusToast && toastApi && typeof toastApi.remove === 'function') {
        try {
            toastApi.remove(rewriteState.statusToast);
        } catch {
            // Fall through to DOM removal.
        }
    }
    removeToastElement(toastElement);
    if (extraToastElement && extraToastElement !== toastElement) removeToastElement(extraToastElement);
    if (rewriteState) {
        rewriteState.statusToast = null;
        rewriteState.statusTaskKey = '';
    }
    if (hadStatus && reason) {
        recordAiRewriteDebug('popup-cleared', {
            task: clearedTaskKey ? hashString(clearedTaskKey) : '',
            reason: String(reason),
        });
    }
}

function dismissAiRewriteStatusToast(toastElement, taskKey) {
    const rewriteState = runtimeState.aiRewrite;
    const normalizedTaskKey = String(taskKey || rewriteState.statusTaskKey || '');
    clearAiRewriteStatusToast(toastElement, 'user-dismissed');
    rewriteState.statusDismissedTaskKey = normalizedTaskKey;
    recordAiRewriteDebug('popup-dismissed', {
        task: normalizedTaskKey ? hashString(normalizedTaskKey) : '',
        requestContinues: true,
    });
}

function attachAiRewriteDismissAction(toast, taskKey) {
    const toastElement = getToastElement(toast);
    const closeButton = toastElement?.querySelector?.('.toast-close-button');
    if (!toastElement || !closeButton || closeButton.dataset?.blaiDismissBound === 'true') return;
    if (closeButton.dataset) closeButton.dataset.blaiDismissBound = 'true';
    closeButton.setAttribute('aria-label', '关闭提示');
    closeButton.setAttribute('title', '关闭提示（后台改写会继续）');
    closeButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        dismissAiRewriteStatusToast(toastElement, taskKey);
    }, { capture: true });
}

function terminateAiRewriteTask(taskKey = '', options = {}) {
    const rewriteState = runtimeState.aiRewrite;
    const normalizedTaskKey = String(taskKey || rewriteState.statusTaskKey || rewriteState.activeTaskKey || '');
    if (normalizedTaskKey) rewriteState.cancelledKeys.add(normalizedTaskKey);
    if (normalizedTaskKey) rewriteState.pendingApplyByKey.delete(normalizedTaskKey);
    clearAiRewriteStatusToast(options.toastElement || null);
    recordAiRewriteDebug('terminate-requested', {
        task: normalizedTaskKey ? hashString(normalizedTaskKey) : '',
        hasActiveController: !!rewriteState.activeController,
    }, 'warn');
    if (readyNoticeTimer) {
        clearTimeout(readyNoticeTimer);
        readyNoticeTimer = null;
    }
    if (rewriteState.activeController && (!normalizedTaskKey || rewriteState.activeTaskKey === normalizedTaskKey)) {
        cancelAiRewriteTask('user-terminated');
    }
    if (options.silent !== true) {
        showToast('AI 改写已终止');
    }
}

function attachAiRewriteTerminateAction(toast, taskKey) {
    if (typeof document === 'undefined') return;
    const toastElement = getToastElement(toast);
    const normalizedTaskKey = String(taskKey || '');
    if (!toastElement || !normalizedTaskKey || toastElement.querySelector('.blai-ai-toast-actions')) return;

    const actions = document.createElement('div');
    actions.className = 'blai-ai-toast-actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'blai-ai-toast-stop';
    button.textContent = '终止';
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.disabled = true;
        button.textContent = '终止中';
        terminateAiRewriteTask(normalizedTaskKey, { toastElement, silent: true });
    });
    actions.appendChild(button);
    toastElement.appendChild(actions);
}

function notifyAiRewriteStatus(type, title, message, options = {}) {
    const method = ['success', 'error', 'warning', 'info'].includes(type) ? type : 'info';
    const safeTitle = String(title || 'AI 改写');
    const safeMessage = String(message || '');
    const toastApi = getToastApi();
    if (toastApi && typeof toastApi[method] === 'function') {
        const sticky = options.sticky === true;
        const taskKey = sticky ? String(options.taskKey || '') : '';
        if (sticky && taskKey && runtimeState.aiRewrite.statusDismissedTaskKey === taskKey) return;
        if (options.replaceCurrent !== false) clearAiRewriteStatusToast(null, `status-${method}`);
        const toast = toastApi[method](safeMessage, safeTitle, {
            timeOut: sticky ? 0 : (options.timeOut ?? 5000),
            extendedTimeOut: sticky ? 0 : (options.extendedTimeOut ?? 10000),
            tapToDismiss: sticky ? false : (options.tapToDismiss ?? true),
            closeButton: options.closeButton ?? !sticky,
            preventDuplicates: false,
            escapeHtml: true,
        });
        const toastElement = getToastElement(toast);
        if (sticky) toastElement?.classList?.add('blai-ai-rewrite-toast');
        runtimeState.aiRewrite.statusToast = sticky ? toast : null;
        runtimeState.aiRewrite.statusTaskKey = taskKey;
        if (sticky) attachAiRewriteDismissAction(toast, taskKey);
        if (sticky && options.cancellable === true) {
            attachAiRewriteTerminateAction(toast, runtimeState.aiRewrite.statusTaskKey);
        }
        return;
    }

    showToast(`${safeTitle}${safeMessage ? `：${stripStatusText(safeMessage)}` : ''}`);
}

function getAiXmlScopeTag(aiSettings) {
    const tagName = normalizeOptionalXmlTagNameInput(aiSettings?.xmlScopeTag, 'content');
    return {
        wholeMessage: tagName === '',
        tagName,
        startTag: tagName ? `<${tagName}>` : '',
        endTag: tagName ? `</${tagName}>` : '',
    };
}

function escapeRegExp(value = '') {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectAiXmlScopeSegments(text, aiSettings) {
    const source = String(text || '');
    const commentRanges = aiSettings?.protectXmlComments === true ? collectXmlCommentRanges(source) : [];
    const searchSource = commentRanges.length > 0 ? maskXmlCommentRanges(source, commentRanges) : source;
    const { wholeMessage, tagName } = getAiXmlScopeTag(aiSettings);
    if (wholeMessage) {
        return source.length > 0 ? [{
            index: 0,
            start: 0,
            end: source.length,
            outerStart: 0,
            outerEnd: source.length,
        }] : [];
    }
    const escapedTagName = escapeRegExp(tagName);
    const startRegex = new RegExp(`<\\s*${escapedTagName}(?:\\s+[^<>]*)?\\s*>`, 'giu');
    const endRegex = new RegExp(`<\\s*/\\s*${escapedTagName}\\s*>`, 'giu');
    const segments = [];
    let startMatch;

    while ((startMatch = startRegex.exec(searchSource)) !== null) {
        const bodyStart = startRegex.lastIndex;
        endRegex.lastIndex = bodyStart;

        const endMatch = endRegex.exec(searchSource);
        const endIndex = endMatch?.index ?? -1;
        if (endIndex < 0) break;

        if (endIndex > bodyStart) {
            segments.push({
                index: segments.length,
                start: bodyStart,
                end: endIndex,
                outerStart: startMatch.index,
                outerEnd: endRegex.lastIndex,
            });
        }
        startRegex.lastIndex = endRegex.lastIndex;
    }

    return segments;
}

function getAiXmlScopedRequestText(text, aiSettings) {
    const source = String(text || '');
    const segments = collectAiXmlScopeSegments(source, aiSettings);
    if (segments.length === 0) return source;
    return segments
        .map((segment) => source.slice(segment.outerStart, segment.outerEnd))
        .join('\n');
}

function buildAiRewriteVersionToken(settings) {
    const aiSettings = settings.aiRewrite || {};
    const aiRules = (settings.rules || []).map((rule) => ({
        enabled: rule?.enabled !== false,
        name: rule?.name || '',
        subRules: (rule?.subRules || [])
            .filter((sub) => sub?.rewriteMode === 'ai')
            .map((sub) => ({
                enabled: sub?.enabled !== false,
                mode: sub?.mode || 'text',
                targets: sub?.targets || [],
                replacements: sub?.replacements || [],
                remark: sub?.remark || '',
                aiPromptTemplate: sub?.aiPromptTemplate || '',
            })),
    }));
    return hashString(JSON.stringify({
        aiRewrite: {
            enabled: aiSettings.enabled === true,
            baseUrl: aiSettings.baseUrl || '',
            apiKeyFingerprint: hashString(aiSettings.apiKey || ''),
            model: aiSettings.model || '',
            temperature: aiSettings.temperature,
            topP: aiSettings.topP,
            topK: aiSettings.topK,
            frequencyPenalty: aiSettings.frequencyPenalty,
            presencePenalty: aiSettings.presencePenalty,
            repetitionPenalty: aiSettings.repetitionPenalty,
            maxTokens: aiSettings.maxTokens,
            timeoutMs: aiSettings.timeoutMs,
            maxItemsPerRequest: aiSettings.maxItemsPerRequest,
            maxContextChars: aiSettings.maxContextChars,
            maxRewriteCharsPerItem: aiSettings.maxRewriteCharsPerItem,
            streamingRoughPreview: aiSettings.streamingRoughPreview !== false,
            xmlScopeTag: normalizeOptionalXmlTagNameInput(aiSettings.xmlScopeTag, 'content'),
            protectXmlComments: aiSettings.protectXmlComments === true,
            promptTemplate: aiSettings.promptTemplate || '',
        },
        activePreset: settings.activePreset || '',
        scopeTags: settings.scopeTags || [],
        scopeTagBuiltinDismissed: settings.scopeTagBuiltinDismissed || [],
        scopeTagMode: settings.scopeTagMode || 'protect',
        zhVariantCompatEnabled: settings.zhVariantCompatEnabled === true,
        zhVariantCompatOptions: settings.zhVariantCompatOptions || {},
        aiRules,
    }));
}

function buildScopedDedupeSource(text, aiSettings) {
    let source = String(text || '');
    try {
        source = applyScopedReplacements(source, { deterministic: true });
    } catch {
        // Dedupe can still fall back to the raw scoped text.
    }
    const segments = collectAiXmlScopeSegments(source, aiSettings);
    if (segments.length === 0) return source;
    return segments.map((segment) => source.slice(segment.start, segment.end)).join('\n@@BLAI_AI_XML_SCOPE@@\n');
}

function buildDedupeKey(index, msg, settings, versionToken, aiSettings, sourceText = '') {
    const branchKey = getMessageDiffBranchKey(msg);
    const dedupeSource = buildScopedDedupeSource(sourceText || msg?.mes || resolveMessageDiffSource(msg), aiSettings);
    return [
        index,
        branchKey,
        hashString(dedupeSource),
        settings.activePreset || '',
        versionToken,
    ].join('|');
}

function getEnabledScopeTags(settings) {
    const scopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
    return scopeTags.filter((tag) => tag?.enabled !== false);
}

function findNextScopeTagMatch(text, fromIndex, scopeTags) {
    let nextMatch = null;
    for (const scopeTag of scopeTags) {
        const startIndex = text.indexOf(scopeTag.startTag, fromIndex);
        if (startIndex < 0) continue;
        if (!nextMatch || startIndex < nextMatch.index || (startIndex === nextMatch.index && scopeTag.startTag.length > nextMatch.scopeTag.startTag.length)) {
            nextMatch = { index: startIndex, scopeTag };
        }
    }
    return nextMatch;
}

function collectScopeRanges(text, settings) {
    const scopeTags = getEnabledScopeTags(settings);
    const ranges = [];
    if (!text || scopeTags.length === 0) return ranges;

    let cursor = 0;
    while (cursor < text.length) {
        const nextMatch = findNextScopeTagMatch(text, cursor, scopeTags);
        if (!nextMatch) break;
        const { index, scopeTag } = nextMatch;
        const bodyStart = index + scopeTag.startTag.length;
        const endIndex = text.indexOf(scopeTag.endTag, bodyStart);
        if (endIndex < 0) {
            cursor = bodyStart;
            continue;
        }
        ranges.push({
            start: index,
            bodyStart,
            bodyEnd: endIndex,
            end: endIndex + scopeTag.endTag.length,
            startTag: scopeTag.startTag,
        });
        cursor = endIndex + scopeTag.endTag.length;
    }
    return ranges;
}

function rangeOverlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
}

function rangeOverlapsAny(start, end, ranges) {
    return ranges.some((range) => rangeOverlaps(start, end, range.start, range.end));
}

function collectCodeRanges(text) {
    const ranges = [];
    const fenceRegex = /```[\s\S]*?```/g;
    let fenceMatch;
    while ((fenceMatch = fenceRegex.exec(text)) !== null) {
        ranges.push({ start: fenceMatch.index, end: fenceMatch.index + fenceMatch[0].length });
        if (fenceMatch[0].length === 0) fenceRegex.lastIndex += 1;
    }

    for (let index = 0; index < text.length; index++) {
        if (text[index] !== '`' || rangeOverlapsAny(index, index + 1, ranges)) continue;
        const endIndex = text.indexOf('`', index + 1);
        if (endIndex < 0) break;
        if (!text.slice(index + 1, endIndex).includes('\n')) {
            ranges.push({ start: index, end: endIndex + 1 });
        }
        index = endIndex;
    }

    return ranges.sort((a, b) => a.start - b.start);
}

function buildAiMatchers(settings) {
    const useZhVariantCompat = settings.zhVariantCompatEnabled === true && isZhDictionaryReady(settings);
    const zhVariantOptions = getZhVariantCompatOptions(settings);
    const matchers = [];

    (settings.rules || []).forEach((rule, ruleIndex) => {
        if (!rule || rule.enabled === false) return;
        (rule.subRules || []).forEach((subRule, subRuleIndex) => {
            if (!subRule || subRule.enabled === false || subRule.rewriteMode !== 'ai') return;
            const mode = subRule.mode || 'text';
            const targets = Array.isArray(subRule.targets) ? subRule.targets : [];
            const replacements = Array.isArray(subRule.replacements) ? subRule.replacements : [];
            const ruleLabel = subRule.remark || rule.name || `合集 ${ruleIndex + 1}`;
            const base = {
                ruleIndex,
                subRuleIndex,
                ruleName: rule.name || '',
                ruleLabel,
                mode,
                replacements,
                aiPromptTemplate: String(subRule.aiPromptTemplate || ''),
            };

            targets.forEach((target) => {
                const normalizedTarget = String(target || '');
                if (!normalizedTarget) return;
                try {
                    if (mode === 'regex') {
                        const compiled = compileRegexTarget(normalizedTarget);
                        if (!compiled.ok) {
                            logger.warn(`AI 改写忽略非法正则表达式: ${normalizedTarget} (${compiled.error.message})`);
                            return;
                        }
                        const regex = new RegExp(compiled.value.regex.source, compiled.value.regex.flags);
                        if (regex.test('')) {
                            logger.warn(`AI 改写忽略空匹配正则: ${normalizedTarget}`);
                            return;
                        }
                        regex.lastIndex = 0;
                        matchers.push({ ...base, target: normalizedTarget, regex });
                        return;
                    }

                    const pattern = mode === 'simple'
                        ? buildSimpleTargetPattern(normalizedTarget, useZhVariantCompat, zhVariantOptions)
                        : buildTargetLiteralPattern(normalizedTarget, useZhVariantCompat, zhVariantOptions);
                    const regex = new RegExp(pattern, 'gmu');
                    if (regex.test('')) {
                        logger.warn(`AI 改写忽略空匹配规则: ${normalizedTarget}`);
                        return;
                    }
                    regex.lastIndex = 0;
                    matchers.push({ ...base, target: normalizedTarget, regex });
                } catch (err) {
                    logger.warn(`AI 改写规则解析失败: ${normalizedTarget}`, err);
                }
            });
        });
    });

    return matchers;
}

function collectAiMatches(text, settings, aiSettings) {
    const segments = collectAiXmlScopeSegments(text, aiSettings);
    if (segments.length === 0) return [];
    const codeRanges = collectCodeRanges(text);
    const commentRanges = aiSettings.protectXmlComments === true ? collectXmlCommentRanges(text) : [];
    const scopeScanText = commentRanges.length > 0 ? maskXmlCommentRanges(text, commentRanges) : text;
    const scopeRanges = collectScopeRanges(scopeScanText, settings);
    const scopeTagMode = settings.scopeTagMode === 'cleanse-inside' ? 'cleanse-inside' : 'protect';
    const isAllowedByScope = (start, end) => {
        if (scopeTagMode === 'cleanse-inside') {
            return scopeRanges.some((range) => start >= range.bodyStart && end <= range.bodyEnd);
        }
        return !rangeOverlapsAny(start, end, scopeRanges);
    };
    const matches = [];

    for (const matcher of buildAiMatchers(settings)) {
        for (const segment of segments) {
            matcher.regex.lastIndex = segment.start;
            let match;
            while ((match = matcher.regex.exec(text)) !== null) {
                const matchedText = String(match[0] || '');
                const start = match.index;
                const end = start + matchedText.length;
                if (start >= segment.end) break;
                if (end > segment.end) {
                    if (matchedText.length === 0) matcher.regex.lastIndex += 1;
                    continue;
                }
                if (!matchedText || end <= start) {
                    matcher.regex.lastIndex += 1;
                    continue;
                }
                if (isAllowedByScope(start, end)
                    && !rangeOverlapsAny(start, end, codeRanges)
                    && !rangeOverlapsAny(start, end, commentRanges)) {
                    matches.push({
                        ...matcher,
                        matchedText,
                        captures: match.slice(1),
                        groups: match.groups && typeof match.groups === 'object' ? { ...match.groups } : null,
                        start,
                        end,
                    });
                }
            }
        }
    }

    return matches.sort((a, b) => a.start - b.start || a.end - b.end);
}

function countMatchedAiRules(matches = []) {
    return new Set(matches.map(match => `${match.ruleIndex}:${match.subRuleIndex}`)).size;
}

function isLatestTrackableMessageIndex(index) {
    const { chat } = getAppContext();
    if (!Array.isArray(chat) || !Number.isInteger(index) || index < 0) return false;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!isAssistantMessage(chat[i])) continue;
        return i === index;
    }
    return false;
}

function getAiConfigIssue(aiSettings) {
    if (aiSettings?.enabled !== true) {
        return {
            code: 'disabled',
            reason: 'AI改写未启用',
            warning: '',
        };
    }

    const missingConfig = [];
    if (!String(aiSettings.baseUrl || '').trim()) missingConfig.push('Base URL');
    if (!String(aiSettings.apiKey || '')) missingConfig.push('API Key');
    if (!String(aiSettings.model || '').trim()) missingConfig.push('模型');
    if (missingConfig.length > 0) {
        return {
            code: 'incomplete-config',
            reason: `AI API配置不完整：缺少 ${missingConfig.join('、')}`,
            warning: '已命中 AI 改写规则，但 AI API 配置不完整，本次仅执行程序改写。',
        };
    }

    if (!getTavernHelperApi()) {
        return {
            code: 'tavern-helper-unavailable',
            reason: 'TavernHelper.generateRaw 不可用',
            warning: '已命中 AI 改写规则，但酒馆助手请求链路不可用，本次仅执行程序改写。',
        };
    }

    return null;
}

function getAiProgramFallbackReplacement(match, sourceText = '') {
    const replacements = Array.isArray(match?.replacements) ? match.replacements : [];
    if (replacements.length === 0) return '';

    const key = `${match.ruleIndex}:${match.subRuleIndex}:${match.mode}:${match.target}:${match.matchedText}`;
    if (match.mode === 'regex') {
        const args = [
            ...(Array.isArray(match.captures) ? match.captures : []),
            Number(match.start) || 0,
            String(sourceText || ''),
        ];
        if (match.groups && typeof match.groups === 'object') args.push(match.groups);
        return resolveRegexProcessorReplacement({ replacements }, key, String(match.matchedText || ''), args, true);
    }

    return String(pickReplacement(replacements, key) ?? '');
}

function applyAiProgramFallbackMatches(text, matches = []) {
    const source = String(text || '');
    if (!source || !Array.isArray(matches) || matches.length === 0) return source;

    const sorted = [...matches]
        .filter((match) => Number.isFinite(Number(match?.start)) && Number.isFinite(Number(match?.end)) && Number(match.end) > Number(match.start))
        .sort((a, b) => Number(b.start) - Number(a.start) || Number(b.end) - Number(a.end));
    const appliedRanges = [];
    let output = source;

    for (const match of sorted) {
        const start = Math.max(0, Math.min(output.length, Number(match.start)));
        const end = Math.max(start, Math.min(output.length, Number(match.end)));
        if (appliedRanges.some((range) => start < range.end && range.start < end)) continue;
        if (output.slice(start, end) !== String(match.matchedText || '')) continue;

        const replacement = getAiProgramFallbackReplacement(match, source);
        output = output.slice(0, start) + replacement + output.slice(end);
        appliedRanges.push({ start, end });
    }

    return output;
}

function formatAiRewriteProgress(task, current, total, attempt = 1, maxAttempts = 1) {
    const hitCount = Math.max(0, Array.isArray(task?.items) ? task.items.length : 0);
    const safeTotal = Math.max(1, Number(total) || 1);
    const safeCurrent = Math.min(safeTotal, Math.max(1, Number(current) || 1));
    const safeMaxAttempts = Math.max(1, Number(maxAttempts) || 1);
    const safeAttempt = Math.min(safeMaxAttempts, Math.max(1, Number(attempt) || 1));
    if (safeAttempt > 1) {
        return `命中 ${hitCount} 处 · 正在重试 ${safeAttempt - 1}/${safeMaxAttempts - 1} · 处理 ${safeCurrent}/${safeTotal}…`;
    }
    return `命中 ${hitCount} 处 · 正在处理 ${safeCurrent}/${safeTotal}…`;
}

function notifyAiRewriteProgress(task, current, total, attempt = 1, maxAttempts = 1) {
    const retrying = Number(attempt) > 1;
    notifyAiRewriteStatus('info', retrying ? 'AI 改写重试中' : 'AI 改写中', formatAiRewriteProgress(task, current, total, attempt, maxAttempts), {
        sticky: true,
        closeButton: true,
        cancellable: true,
        taskKey: task.dedupeKey,
    });
}

function getAiRewriteMessageKey(index, branchKey = 'main') {
    return `${Number(index)}:${String(branchKey || 'main')}`;
}

function getAiRewriteMessageIndexKey(index) {
    return String(Number(index));
}

function getTaskMessageKey(task) {
    return getAiRewriteMessageKey(task.index, task.branchKey);
}

function getContentIdentityMap() {
    const rewriteState = runtimeState.aiRewrite;
    if (!(rewriteState.contentIdentityByGenerationId instanceof Map)) {
        rewriteState.contentIdentityByGenerationId = new Map();
    }
    return rewriteState.contentIdentityByGenerationId;
}

function getContentIdentity(generationId) {
    return getContentIdentityMap().get(String(generationId || '')) || null;
}

function extractCurrentAiRewriteScope(text, aiSettings) {
    const source = String(text || '');
    const segments = collectAiXmlScopeSegments(source, aiSettings);
    if (segments.length === 0) {
        return { ok: false, text: '', hash: '', tailLength: source.length, reason: 'content-scope-missing' };
    }
    const scopedText = getAiXmlScopedRequestText(source, aiSettings);
    return {
        ok: true,
        text: scopedText,
        hash: hashString(scopedText),
        tailLength: Math.max(0, source.length - scopedText.length),
        reason: '',
    };
}

function freezeAiRewriteContentIdentity(payload, snapshotText, aiSettings) {
    const generationId = String(payload?.generationId || '');
    if (!generationId) return null;
    const existing = getContentIdentity(generationId);
    if (existing) return existing;

    const { chat } = getAppContext();
    const parsed = parseStableMessagePayload(payload);
    if (!parsed.ok || !Array.isArray(chat)) return null;
    const messageRef = chat[parsed.messageIndex];
    if (!isAssistantMessage(messageRef)) return null;

    const scoped = extractCurrentAiRewriteScope(snapshotText, aiSettings);
    if (!scoped.ok) return null;
    const identity = {
        generationId,
        chatId: String(payload?.chatId || ''),
        messageId: parsed.messageIndex,
        messageRef,
        branchKey: getMessageDiffBranchKey(messageRef),
        xmlTag: getAiXmlScopeTag(aiSettings).tagName,
        requestSnapshotHash: scoped.hash,
        taskKey: '',
    };
    getContentIdentityMap().set(generationId, identity);
    recordAiRewriteDebug('content-snapshot-frozen', {
        generationId,
        chatId: identity.chatId,
        messageId: identity.messageId,
        contentSnapshotHash: identity.requestSnapshotHash,
        scopedLength: scoped.text.length,
        xmlTag: identity.xmlTag,
    });
    return identity;
}

function validateAutomaticAiRewriteContent(taskLike, options = {}) {
    const generationId = String(taskLike?.generationId || '');
    const { chat } = getAppContext();
    const lifecycleValidation = generationLifecycle.validate(generationId, {
        chatId: getCurrentChatIdentity(),
        chat,
    });
    if (!lifecycleValidation.ok) return lifecycleValidation;

    const identity = getContentIdentity(generationId);
    if (!identity) return { ok: false, reason: 'content-identity-missing' };
    if (lifecycleValidation.session.messageId !== identity.messageId
        || lifecycleValidation.session.messageRef !== identity.messageRef) {
        return { ok: false, reason: 'generation-message-mismatch' };
    }
    if (taskLike?.index !== undefined && Number(taskLike.index) !== identity.messageId) {
        return { ok: false, reason: 'generation-message-mismatch' };
    }
    if (String(taskLike?.chatId || identity.chatId) !== identity.chatId) {
        return { ok: false, reason: 'chat-changed' };
    }
    if (getMessageDiffBranchKey(identity.messageRef) !== identity.branchKey) {
        return { ok: false, reason: 'branch-changed' };
    }
    recordAiRewriteDebug('pre-run-validation', {
        generationId,
        chatId: identity.chatId,
        messageId: identity.messageId,
        requestState: lifecycleValidation.session.requestState,
        validationMode: 'target-identity',
        validationReason: '',
        contentSnapshotHash: identity.requestSnapshotHash,
        source: String(options.source || taskLike?.scheduleSource || ''),
    });
    return { ok: true, reason: '', session: lifecycleValidation.session, message: identity.messageRef, identity };
}

function getLiveAiRewriteTargets() {
    const state = runtimeState.aiRewrite;
    const targets = [];
    if (state?.activeTaskMeta?.messageRef) targets.push(state.activeTaskMeta);
    for (const meta of getRunningTaskMetaMap().values()) {
        if (meta?.messageRef) targets.push(meta);
    }
    for (const identity of getContentIdentityMap().values()) {
        if (identity?.messageRef) targets.push({
            index: identity.messageId,
            messageRef: identity.messageRef,
            branchKey: identity.branchKey,
        });
    }
    for (const entry of state?.pendingApplyByKey?.values?.() || []) {
        if (entry?.task?.messageRef) targets.push(entry.task);
    }
    return targets;
}

export function getActiveAiRewriteBranchKeyForMessage(messageRef) {
    const target = getLiveAiRewriteTargets().find(entry => entry.messageRef === messageRef);
    return String(target?.branchKey || '');
}

export function isLiveAiRewriteTargetMessage(messageRef) {
    return getLiveAiRewriteTargets().some(target => target.messageRef === messageRef);
}

export function hasInvalidAiRewriteTarget(chat) {
    if (!Array.isArray(chat)) return false;
    return getLiveAiRewriteTargets().some(target => chat[Number(target.index)] !== target.messageRef);
}

function markStreamingAiRewriteStarted(task) {
    if (task?.waitForFinalCleanse !== true) return;
    runtimeState.aiRewrite.streamingStartedMessageIndices.add(getAiRewriteMessageIndexKey(task.index));
}

function hasStreamingAiRewriteStartedForMessage(index) {
    return runtimeState.aiRewrite.streamingStartedMessageIndices.has(getAiRewriteMessageIndexKey(index));
}

function getRunningTaskMetaMap() {
    const rewriteState = runtimeState.aiRewrite;
    if (!(rewriteState.runningTaskMetaByKey instanceof Map)) {
        rewriteState.runningTaskMetaByKey = new Map();
    }
    return rewriteState.runningTaskMetaByKey;
}

function getAiRewriteTaskSnapshotHash(task) {
    return hashString(String(task?.snapshotText || ''));
}

function findRunningAiRewriteForReadyTask(task, excludeDedupeKey = '') {
    if (!task) return null;
    const targetSnapshotHash = getAiRewriteTaskSnapshotHash(task);
    const targetVersionToken = String(task.versionToken || '');
    for (const [dedupeKey, meta] of getRunningTaskMetaMap().entries()) {
        if (excludeDedupeKey && dedupeKey === excludeDedupeKey) continue;
        if (Number(meta?.index) !== Number(task.index)) continue;
        if (String(meta?.versionToken || '') !== targetVersionToken) continue;
        if (String(meta?.snapshotHash || '') !== targetSnapshotHash) continue;
        return { dedupeKey, meta };
    }
    return null;
}

function hasFinalCleanseAfterTaskStart(task) {
    if (task.waitForFinalCleanse !== true) return true;
    const rewriteState = runtimeState.aiRewrite;
    const readySequence = Number(rewriteState.finalCleanseByMessageKey.get(getTaskMessageKey(task))) || 0;
    return readySequence > (Number(task.finalCleanseSequence) || 0);
}

function rebindStreamingTaskBranchIfStable(task) {
    if (task?.waitForFinalCleanse !== true) return;
    const { chat } = getAppContext();
    const msg = Array.isArray(chat) ? chat[task.index] : null;
    if (msg !== task.messageRef || !isAssistantMessage(msg) || typeof msg.mes !== 'string') return;

    const currentSnapshot = getAiXmlScopedRequestText(msg.mes, task.aiSettings);
    if (currentSnapshot !== task.snapshotText) return;

    const currentBranchKey = getMessageDiffBranchKey(msg);
    if (!currentBranchKey || currentBranchKey === task.branchKey) return;

    const previousBranchKey = task.branchKey;
    task.branchKey = currentBranchKey;
    if (task.branchReboundLogged !== true) {
        task.branchReboundLogged = true;
        recordAiRewriteDebug('task-branch-rebound', {
            task: hashString(task.dedupeKey),
            index: task.index,
            from: previousBranchKey,
            to: currentBranchKey,
        });
    }
}

function findContainingSegment(match, segments) {
    return segments.find((segment) => match.start >= segment.start && match.end <= segment.end) || { start: 0, end: 0 };
}

function buildRewriteItems(text, matches, aiSettings) {
    if (matches.length === 0) return [];
    const segments = collectAiXmlScopeSegments(text, aiSettings);
    const codeRanges = collectCodeRanges(text);
    const fragments = [];

    matches.forEach((match) => {
        const segment = findContainingSegment(match, segments);
        if (!segment || segment.end <= segment.start) return;
        const range = { start: match.start, end: match.end };
        if (rangeOverlapsAny(range.start, range.end, codeRanges)) return;
        fragments.push({
            ...range,
            segmentIndex: segment.index,
            segmentStart: segment.start,
            segmentEnd: segment.end,
            matches: [match],
        });
    });

    fragments.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    fragments.forEach((fragment) => {
        const previous = merged[merged.length - 1];
        if (previous && previous.segmentIndex === fragment.segmentIndex && fragment.start <= previous.end) {
            previous.end = Math.max(previous.end, fragment.end);
            previous.matches.push(...fragment.matches);
            return;
        }
        merged.push({ ...fragment });
    });

    return merged.map((fragment, index) => {
        const localFallbackCandidates = [...new Set(fragment.matches.flatMap((match) => match.replacements || []).filter((value) => value !== undefined).map(String))];
        const matchedTerms = [...new Set(fragment.matches.map((match) => match.matchedText).filter(Boolean))];
        const fragmentText = text.slice(fragment.start, fragment.end);
        const programFallbackText = applyAiProgramFallbackMatches(
            fragmentText,
            fragment.matches.map((match) => ({
                ...match,
                start: match.start - fragment.start,
                end: match.end - fragment.start,
            }))
        );
        return {
            id: `hit-${index + 1}`,
            segmentIndex: fragment.segmentIndex,
            start: fragment.start,
            end: fragment.end,
            relativeStart: fragment.start - fragment.segmentStart,
            relativeEnd: fragment.end - fragment.segmentStart,
            text: fragmentText,
            programFallbackText,
            beforeAnchor: text.slice(Math.max(fragment.segmentStart, fragment.start - 24), fragment.start),
            afterAnchor: text.slice(fragment.end, Math.min(fragment.segmentEnd, fragment.end + 24)),
            matchedTerms,
            localFallbackCandidates,
            matches: fragment.matches.map((match) => ({
                ruleName: match.ruleName,
                ruleLabel: match.ruleLabel,
                mode: match.mode,
                target: match.target,
                matchedText: match.matchedText,
                aiPromptTemplate: match.aiPromptTemplate,
            })),
        };
    });
}

function getContextWindow(text, items, maxContextChars) {
    const limit = normalizeLimit(maxContextChars, 12000, 1000, 60000);
    if (text.length <= limit) return { start: 0, end: text.length };
    if (!items.length) return { start: 0, end: limit };

    const minStart = Math.min(...items.map((item) => item.start));
    const maxEnd = Math.max(...items.map((item) => item.end));
    const spanLength = maxEnd - minStart;
    if (spanLength >= limit) return { start: minStart, end: maxEnd };
    const padding = Math.max(0, Math.floor((limit - spanLength) / 2));
    let start = Math.max(0, minStart - padding);
    let end = Math.min(text.length, maxEnd + padding);
    if (end - start < limit) {
        start = Math.max(0, end - limit);
        end = Math.min(text.length, start + limit);
    }
    return { start, end };
}

function redactSourceRange(text, start, end, protectedRanges) {
    let output = '';
    let cursor = start;
    protectedRanges.forEach((range) => {
        const bodyStart = Math.max(start, range.bodyStart);
        const bodyEnd = Math.min(end, range.bodyEnd);
        if (bodyEnd <= bodyStart || bodyEnd <= cursor) return;
        output += text.slice(cursor, Math.max(cursor, bodyStart));
        output += '[已保护内容]';
        cursor = bodyEnd;
    });
    output += text.slice(cursor, end);
    return output;
}

function getGlobalPromptTemplate(aiSettings) {
    return String(aiSettings.promptTemplate || '');
}

function getItemRewriteInstructions(item) {
    return [...new Set((item.matches || [])
        .map((match) => String(match.aiPromptTemplate || '').trim())
        .filter(Boolean))];
}

function normalizeStringList(values) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean))];
}

function buildCompactPromptPayload(items) {
    const rewriteRules = {};
    const ruleIdByInstruction = new Map();
    const ruleIdsByItem = new Map();
    const localFallbackCandidates = {};
    const candidateIdByValues = new Map();
    const candidateIdByItem = new Map();

    items.forEach((item) => {
        const ruleIds = getItemRewriteInstructions(item).map((instruction) => {
            let ruleId = ruleIdByInstruction.get(instruction);
            if (!ruleId) {
                ruleId = `r${ruleIdByInstruction.size + 1}`;
                ruleIdByInstruction.set(instruction, ruleId);
                rewriteRules[ruleId] = instruction;
            }
            return ruleId;
        });
        ruleIdsByItem.set(item.id, ruleIds);

        const candidates = normalizeStringList(item.localFallbackCandidates);
        if (candidates.length > 0) {
            const candidateKey = JSON.stringify(candidates);
            let candidateId = candidateIdByValues.get(candidateKey);
            if (!candidateId) {
                candidateId = `c${candidateIdByValues.size + 1}`;
                candidateIdByValues.set(candidateKey, candidateId);
                localFallbackCandidates[candidateId] = candidates;
            }
            candidateIdByItem.set(item.id, candidateId);
        }
    });

    return {
        rewriteRulesJson: JSON.stringify(rewriteRules),
        localFallbackCandidatesJson: JSON.stringify(localFallbackCandidates),
        ruleIdsByItem,
        candidateIdByItem,
        ruleCount: ruleIdByInstruction.size,
        candidateSetCount: candidateIdByValues.size,
    };
}

function buildAnnotatedSource(originalText, items, settings, maxContextChars, ruleIdsByItem, candidateIdByItem, aiSettings) {
    const source = String(originalText || '');
    const sortedItems = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
    const window = getContextWindow(source, sortedItems, maxContextChars);
    const commentRanges = aiSettings?.protectXmlComments === true ? collectXmlCommentRanges(source) : [];
    const scopeScanText = commentRanges.length > 0 ? maskXmlCommentRanges(source, commentRanges) : source;
    const scopeRanges = settings.scopeTagMode === 'cleanse-inside' ? [] : collectScopeRanges(scopeScanText, settings);
    const protectedRanges = [
        ...scopeRanges,
        ...commentRanges.map((range) => ({
            bodyStart: range.start + 4,
            bodyEnd: Math.max(range.start + 4, range.end - 3),
        })),
    ].sort((a, b) => (a.bodyStart || 0) - (b.bodyStart || 0));
    let rendered = window.start > 0 ? '[前文已省略]\n' : '';
    let cursor = window.start;

    sortedItems.forEach((item) => {
        if (item.start < window.start || item.end > window.end) {
            throw new Error(`改写目标 ${item.id} 超出发送上下文范围`);
        }
        rendered += redactSourceRange(source, cursor, item.start, protectedRanges);
        const ruleIds = ruleIdsByItem.get(item.id) || [];
        const rulesAttribute = ruleIds.length > 0 ? ` rules="${ruleIds.join(',')}"` : '';
        const candidateId = candidateIdByItem.get(item.id) || '';
        const candidatesAttribute = candidateId ? ` candidates="${candidateId}"` : '';
        rendered += `<rewrite_target id="${item.id}"${rulesAttribute}${candidatesAttribute}>${source.slice(item.start, item.end)}</rewrite_target>`;
        cursor = item.end;
    });

    rendered += redactSourceRange(source, cursor, window.end, protectedRanges);
    if (window.end < source.length) rendered += '\n[后文已省略]';
    return rendered;
}

function groupRewriteItemsByPrompt(items, aiSettings) {
    const batchSize = normalizePositiveInteger(aiSettings.maxItemsPerRequest, defaultAiRewriteSettings.maxItemsPerRequest);
    const groups = [];
    for (let start = 0; start < items.length; start += batchSize) {
        groups.push({
            key: `batch-${Math.floor(start / batchSize) + 1}`,
            promptTemplate: getGlobalPromptTemplate(aiSettings),
            items: items.slice(start, start + batchSize),
        });
    }
    return groups;
}

function renderPrompt(originalText, items, settings, aiSettings, promptTemplate = getGlobalPromptTemplate(aiSettings)) {
    const payload = buildCompactPromptPayload(items);
    const annotatedSource = buildAnnotatedSource(
        originalText,
        items,
        settings,
        aiSettings.maxContextChars,
        payload.ruleIdsByItem,
        payload.candidateIdByItem,
        aiSettings
    );
    const template = String(promptTemplate || '');
    const hasRulesPlaceholder = template.includes('{{rewriteRulesJson}}');
    const hasCandidatesPlaceholder = template.includes('{{localFallbackCandidatesJson}}');
    const hasSourcePlaceholder = template.includes('{{annotatedSource}}');
    let rendered = template
        .replaceAll('{{rewriteRulesJson}}', payload.rewriteRulesJson)
        .replaceAll('{{localFallbackCandidatesJson}}', payload.localFallbackCandidatesJson)
        .replaceAll('{{annotatedSource}}', annotatedSource);
    if (!hasRulesPlaceholder) rendered += `\n\n<rewrite_rules>${payload.rewriteRulesJson}</rewrite_rules>`;
    if (!hasCandidatesPlaceholder) rendered += `\n\n<local_fallback_candidates>${payload.localFallbackCandidatesJson}</local_fallback_candidates>`;
    if (!hasSourcePlaceholder) rendered += `\n\n<source>${annotatedSource}</source>`;
    const expectedIds = items.map((item) => item.id);
    const prompt = `${rendered}\n\n${responseGuard}\n本次 id：${JSON.stringify(expectedIds)}。`;
    recordAiRewriteDebug('prompt-built', {
        promptLength: prompt.length,
        templateLength: template.length,
        annotatedSourceLength: annotatedSource.length,
        rewriteRulesLength: payload.rewriteRulesJson.length,
        localFallbackCandidatesLength: payload.localFallbackCandidatesJson.length,
        itemCount: items.length,
        ruleCount: payload.ruleCount,
        candidateSetCount: payload.candidateSetCount,
    });
    return prompt;
}

function getTavernHelperApi() {
    const direct = globalThis?.TavernHelper;
    if (direct && typeof direct.generateRaw === 'function') return direct;
    try {
        const parentApi = globalThis?.parent?.TavernHelper;
        if (parentApi && typeof parentApi.generateRaw === 'function') return parentApi;
    } catch {
        // Cross-window access can fail outside the SillyTavern host.
    }
    return null;
}

function stripSingleJsonFence(value) {
    const trimmed = String(value || '').trim();
    const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

const cotThinkingBlockRegex = /<\s*think(?:ing)?\b[^>]*>[\s\S]*?<\s*\/\s*think(?:ing)?\s*>/giu;
const cotThinkingOpenTailRegex = /<\s*think(?:ing)?\b[^>]*>[\s\S]*$/iu;
const cotThinkingTagRegex = /<\s*\/?\s*think(?:ing)?\b[^>]*>/giu;
const cotThinkingMarkerRegex = /<\s*\/?\s*think(?:ing)?\b/i;

function stripCotThinkingContent(value) {
    return String(value || '')
        .replace(cotThinkingBlockRegex, '')
        .replace(cotThinkingOpenTailRegex, '')
        .replace(cotThinkingTagRegex, '');
}

function hasCotThinkingMarker(value) {
    return cotThinkingMarkerRegex.test(String(value || ''));
}

function getBoundaryProbe(value = '', edge = 'end') {
    const compact = String(value || '').replace(/\s+/g, ' ').trim();
    if (compact.length < 6) return '';
    return edge === 'start' ? compact.slice(0, 12) : compact.slice(-12);
}

function getItemRewriteLengthLimit(item, absoluteLimit) {
    const sourceLength = String(item?.text || '').length;
    const fallbackLength = normalizeStringList(item?.localFallbackCandidates)
        .reduce((max, value) => Math.max(max, value.length), 0);
    const localLimit = Math.max(sourceLength + 8, Math.ceil(sourceLength * 3), fallbackLength);
    return Math.min(absoluteLimit, localLimit);
}

function countSentenceBoundaries(value = '') {
    return (String(value || '').match(/[。！？!?\r\n]/gu) || []).length;
}

function getRewrittenBoundaryIssue(rewritten, item) {
    if (!rewritten) return '';
    const beforeProbe = getBoundaryProbe(item?.beforeAnchor, 'end');
    if (beforeProbe && rewritten.includes(beforeProbe)) return 'copied-before-context';
    const afterProbe = getBoundaryProbe(item?.afterAnchor, 'start');
    if (afterProbe && rewritten.includes(afterProbe)) return 'copied-after-context';
    return '';
}

class AiRewriteResponseFormatError extends Error {
    constructor(message, cause = null) {
        super(message);
        this.name = 'AiRewriteResponseFormatError';
        if (cause) this.cause = cause;
    }
}

class AiRewriteRequestFormatError extends Error {
    constructor(message, cause = null) {
        super(message);
        this.name = 'AiRewriteRequestFormatError';
        if (cause) this.cause = cause;
    }
}

function isAiRewriteResponseFormatError(error) {
    return error instanceof AiRewriteResponseFormatError
        || error?.name === 'AiRewriteResponseFormatError';
}

function isAiRewriteRequestFormatError(error) {
    return error instanceof AiRewriteRequestFormatError
        || error?.name === 'AiRewriteRequestFormatError';
}

function isBadRequestError(error) {
    const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
    if (status === 400) return true;
    return /(?:bad request|http\s*400)/i.test(String(error?.message || ''));
}

function isNonRetryableAiRewriteError(error) {
    return isAiRewriteResponseFormatError(error) || isAiRewriteRequestFormatError(error);
}

function parseAiResponse(rawText, itemById, aiSettings) {
    const sanitizedRawText = stripCotThinkingContent(rawText);
    const candidate = stripSingleJsonFence(sanitizedRawText);
    if (!/^\{[\s\S]*\}$/.test(candidate)) {
        recordAiRewriteDebug('parse-failed', {
            reason: 'not-json-object',
            rawLength: String(rawText || '').length,
            sanitizedLength: sanitizedRawText.length,
            preview: String(sanitizedRawText || rawText || '').slice(0, 300),
        }, 'warn');
        throw new AiRewriteResponseFormatError('API 返回不是单个 JSON 对象');
    }
    let parsed;
    try {
        parsed = JSON.parse(candidate);
    } catch (error) {
        recordAiRewriteDebug('parse-failed', {
            reason: 'json-parse-error',
            error: error?.message || String(error),
            rawLength: String(rawText || '').length,
            preview: String(rawText || '').slice(0, 300),
        }, 'warn');
        throw new AiRewriteResponseFormatError('API 返回的 JSON 无法解析', error);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        recordAiRewriteDebug('parse-failed', {
            reason: 'invalid-rewrite-map',
        }, 'warn');
        throw new AiRewriteResponseFormatError('API 返回不是 id 到改写文本的 JSON 对象');
    }

    const returnedEntries = Object.entries(parsed);
    if (returnedEntries.length !== itemById.size) {
        recordAiRewriteDebug('parse-failed', {
            reason: 'rewrite-count-mismatch',
            expectedCount: itemById.size,
            returnedCount: returnedEntries.length,
        }, 'warn');
        throw new AiRewriteResponseFormatError(`API 返回改写数量不一致：需要 ${itemById.size} 项，实际 ${returnedEntries.length} 项`);
    }

    const maxChars = normalizeLimit(aiSettings.maxRewriteCharsPerItem, 2000, 50, 10000);
    const accepted = new Map();
    for (const [rawId, rawRewritten] of returnedEntries) {
        const id = String(rawId || '');
        if (!itemById.has(id)) throw new AiRewriteResponseFormatError(`API 返回未知改写 id：${id || '(空)'}`);
        if (typeof rawRewritten !== 'string') throw new AiRewriteResponseFormatError(`API 返回 ${id} 的改写结果不是字符串`);

        const item = itemById.get(id);
        const rewritten = stripCotThinkingContent(rawRewritten).trim();
        if (hasCotThinkingMarker(rewritten)) throw new AiRewriteResponseFormatError(`API 返回 ${id} 包含思考标签`);
        const itemLimit = getItemRewriteLengthLimit(item, maxChars);
        if (rewritten.length > itemLimit) {
            throw new AiRewriteResponseFormatError(`API 返回 ${id} 超出局部改写长度：上限 ${itemLimit} 字，实际 ${rewritten.length} 字`);
        }
        if (countSentenceBoundaries(rewritten) > countSentenceBoundaries(item?.text)) {
            throw new AiRewriteResponseFormatError(`API 返回 ${id} 引入了 item.text 之外的句子边界`);
        }
        if (/```/.test(rewritten)) throw new AiRewriteResponseFormatError(`API 返回 ${id} 包含代码块围栏`);
        if (/^\s*[\[{][\s\S]*[\]}]\s*$/.test(rewritten)) throw new AiRewriteResponseFormatError(`API 返回 ${id} 包含 JSON 包装`);
        const boundaryIssue = getRewrittenBoundaryIssue(rewritten, item);
        if (boundaryIssue) throw new AiRewriteResponseFormatError(`API 返回 ${id} 越过局部边界：${boundaryIssue}`);
        accepted.set(id, rewritten);
    }

    const missingIds = [...itemById.keys()].filter((id) => !accepted.has(id));
    if (missingIds.length > 0) throw new AiRewriteResponseFormatError(`API 返回缺少改写 id：${missingIds.join('、')}`);
    recordAiRewriteDebug('parse-result', {
        returnedCount: returnedEntries.length,
        acceptedCount: accepted.size,
        rejectedCount: 0,
    });
    return accepted;
}

function getTaskFreshnessIssue(task) {
    rebindStreamingTaskBranchIfStable(task);
    const { chat } = getAppContext();
    const msg = Array.isArray(chat) ? chat[task.index] : null;
    if (task.automatic === true) {
        const validation = validateAutomaticAiRewriteContent(task, { source: 'task-freshness' });
        if (!validation.ok) return `generation-${validation.reason}`;
        if (validation.session.messageId !== task.index) return 'generation-message-changed';
    }
    if (msg !== task.messageRef) return 'message-ref-changed';
    if (!isAssistantMessage(msg)) return 'not-assistant-message';
    if (msg?.__blai_is_reverted) return 'message-reverted';
    if (getMessageDiffBranchKey(msg) !== task.branchKey) return 'branch-changed';
    if (typeof msg.mes !== 'string') return 'message-text-missing';
    return '';
}

function isTaskStillFresh(task) {
    return !getTaskFreshnessIssue(task);
}

function getItemSearchNeedles(item) {
    const values = [String(item?.text || '')];
    if (item?.programFallbackText && item.programFallbackText !== item.text) {
        values.push(String(item.programFallbackText));
    }
    try {
        const programText = applyScopedReplacements(String(item?.text || ''), { deterministic: true });
        if (programText && programText !== item.text) values.push(programText);
    } catch {
        // Original text remains the primary locator.
    }
    return [...new Set(values.filter(Boolean))];
}

function findOccurrencesInRange(text, needle, start, end) {
    const matches = [];
    if (!needle) return matches;
    let cursor = Math.max(0, start);
    const limit = Math.min(text.length, end);
    while (cursor < limit) {
        const index = text.indexOf(needle, cursor);
        if (index < 0 || index + needle.length > limit) break;
        matches.push(index);
        cursor = index + 1;
    }
    return matches;
}

function filterOccurrencesByAnchors(text, occurrences, needle, segment, item) {
    const beforeAnchor = String(item?.beforeAnchor || '');
    const afterAnchor = String(item?.afterAnchor || '');
    return occurrences.filter((index) => {
        const beforeStart = Math.max(segment.start, index - beforeAnchor.length);
        const afterEnd = Math.min(segment.end, index + needle.length + afterAnchor.length);
        const beforeOk = !beforeAnchor || text.slice(beforeStart, index).endsWith(beforeAnchor);
        const afterOk = !afterAnchor || text.slice(index + needle.length, afterEnd).startsWith(afterAnchor);
        return beforeOk && afterOk;
    });
}

function locateRewriteItem(currentText, item, task) {
    const segments = collectAiXmlScopeSegments(currentText, task.aiSettings);
    const segment = Number.isInteger(item.segmentIndex) ? segments[item.segmentIndex] : null;
    if (!segment) return null;

    const relativeStart = Number.isFinite(Number(item.relativeStart)) ? Math.round(Number(item.relativeStart)) : -1;
    const relativeEnd = Number.isFinite(Number(item.relativeEnd)) ? Math.round(Number(item.relativeEnd)) : -1;
    const needles = getItemSearchNeedles(item);

    for (const needle of needles) {
        const preferredStart = segment.start + relativeStart;
        const preferredEnd = preferredStart + needle.length;
        if (preferredStart >= segment.start
            && preferredEnd <= segment.end
            && currentText.slice(preferredStart, preferredEnd) === needle) {
            return { start: preferredStart, end: preferredEnd, strategy: 'relative', needle };
        }
    }

    for (const needle of needles) {
        const occurrences = findOccurrencesInRange(currentText, needle, segment.start, segment.end);
        if (occurrences.length === 1) {
            return { start: occurrences[0], end: occurrences[0] + needle.length, strategy: 'unique-text', needle };
        }
        const anchored = filterOccurrencesByAnchors(currentText, occurrences, needle, segment, item);
        if (anchored.length === 1) {
            return { start: anchored[0], end: anchored[0] + needle.length, strategy: 'anchor', needle };
        }
    }

    return null;
}

function buildFinalAiRewriteText(text, msg, sources = [], aiSettings = getAiSettings()) {
    const cleansedText = applyWithXmlCommentsProtected(
        String(text || ''),
        (segment) => applyScopedReplacements(segment, { deterministic: true }),
        aiSettings?.protectXmlComments === true,
    );
    return preserveMvuStatusPlaceholder(cleansedText, msg, sources);
}

function commitAiRewriteText(taskLike, prepared) {
    const { chat } = getAppContext();
    const index = Number(taskLike?.index);
    const msg = Array.isArray(chat) ? chat[index] : null;
    if (!msg || msg !== taskLike?.messageRef || typeof msg.mes !== 'string') {
        return { committed: false, reason: 'message-ref-changed' };
    }

    const currentText = String(prepared.currentText || '');
    const finalText = String(prepared.finalText || '');
    if (msg.mes !== currentText) return { committed: false, reason: 'message-text-changed' };
    if (finalText === currentText) return { committed: false, reason: 'no-text-change' };

    const sourceText = String(prepared.sourceText || currentText);
    const programText = String(prepared.programText || finalText);
    const branchKey = String(taskLike.branchKey || getMessageDiffBranchKey(msg));
    const atomicSwap = beginAtomicMessageDisplaySwap(index);
    try {
        const textCommit = commitCurrentMessageText(msg, finalText, branchKey);
        if (!textCommit.ok) {
            atomicSwap?.release();
            return { committed: false, reason: textCommit.reason };
        }
        clearMessageDisplayText(msg);
        syncCurrentSwipeExtra(msg);
        syncMessageDiffMetadata(msg, sourceText, finalText);
        writeMessageDiffAiTrace(msg, branchKey, programText, finalText);
        const signature = computeMessageSignature(msg);
        const diffResult = buildDiffResultFromChain(sourceText, programText, finalText);
        writeReadyDiffCache(index, signature, {
            snippets: Array.from(new Set(diffResult.snippets || [])),
            fullDiff: diffResult.fullDiff || '',
            signature,
        }, {
            preserveExistingRealDiff: true,
            persist: true,
        });

        markHostChatDirtyFromIndex(index);
        refreshMessageDisplay(index, { atomic: true, atomicSwap, emitRenderedEvent: 'auto' });
        queueIncrementalChatSave();
        recordAiRewriteDebug('atomic-commit', {
            task: taskLike.dedupeKey ? hashString(taskLike.dedupeKey) : '',
            index,
            beforeLength: currentText.length,
            afterLength: finalText.length,
        });
        return { committed: true, reason: '', signature };
    } catch (error) {
        atomicSwap?.release();
        throw error;
    }
}

function applyAiProgramFallback(taskLike, options = {}) {
    const { chat } = getAppContext();
    const index = Number(taskLike?.index);
    if (!Array.isArray(chat) || !Number.isInteger(index) || index < 0 || index >= chat.length) {
        return { applied: false, reason: 'invalid-index' };
    }
    if (!isLatestTrackableMessageIndex(index)) {
        recordAiRewriteDebug('fallback-skip', {
            reason: 'not-latest-trackable-message',
            index,
        }, 'warn');
        return { applied: false, reason: 'not-latest-trackable-message' };
    }

    const msg = chat[index];
    if (!isAssistantMessage(msg)) return { applied: false, reason: 'not-assistant-message' };
    if (msg?.__blai_is_reverted) return { applied: false, reason: 'message-reverted' };
    if (taskLike?.messageRef && msg !== taskLike.messageRef) return { applied: false, reason: 'message-ref-changed' };
    if (taskLike?.automatic === true) {
        const validation = validateAutomaticAiRewriteContent(taskLike, { source: 'program-fallback' });
        if (!validation.ok || validation.session.messageId !== index) {
            return { applied: false, reason: validation.reason || 'generation-message-mismatch' };
        }
    }
    const settings = taskLike.settings || getSettings();
    const aiSettings = taskLike.aiSettings || getAiSettings();
    const currentText = typeof msg.mes === 'string' ? msg.mes : '';
    if (!currentText) return { applied: false, reason: 'message-empty' };

    const currentMatches = collectAiMatches(currentText, settings, aiSettings);
    if (currentMatches.length === 0) {
        recordAiRewriteDebug('fallback-skip', {
            reason: 'no-current-ai-match',
            index,
            trigger: options.reason || '',
        }, 'warn');
        return { applied: false, reason: 'no-current-ai-match' };
    }

    const fallbackText = applyAiProgramFallbackMatches(currentText, currentMatches);
    const nextText = buildFinalAiRewriteText(fallbackText, msg, [currentText, fallbackText, taskLike.snapshotText], aiSettings);
    if (nextText === currentText) {
        recordAiRewriteDebug('fallback-skip', {
            reason: 'no-text-change',
            index,
            matchCount: currentMatches.length,
            trigger: options.reason || '',
        }, 'warn');
        return { applied: false, reason: 'no-text-change' };
    }

    const branchKey = getMessageDiffBranchKey(msg);
    const currentSourceText = resolveMessageDiffSource(msg);
    const nextSourceText = preserveMvuStatusPlaceholder(currentSourceText || currentText, msg, [
        currentText,
        nextText,
        taskLike.snapshotText,
    ]);
    const commitResult = commitAiRewriteText({ ...taskLike, branchKey, messageRef: msg }, {
        currentText,
        sourceText: nextSourceText,
        programText: nextText,
        finalText: nextText,
    });
    if (!commitResult.committed) return { applied: false, reason: commitResult.reason };

    recordAiRewriteDebug('fallback-applied', {
        index,
        branchKey,
        trigger: options.reason || '',
        matchCount: currentMatches.length,
        ruleHitCount: countMatchedAiRules(currentMatches),
        beforeLength: currentText.length,
        afterLength: nextText.length,
    }, 'warn');

    if (options.notify !== false && (options.title || options.message)) {
        notifyAiRewriteStatus('warning', options.title || 'AI 改写已改用程序改写', options.message || '', { timeOut: 8000, extendedTimeOut: 16000 });
    }

    return {
        applied: true,
        reason: '',
        matchCount: currentMatches.length,
        ruleHitCount: countMatchedAiRules(currentMatches),
    };
}

function applyAcceptedRewrites(task, accepted) {
    recordAiRewriteDebug('apply-start', {
        task: hashString(task.dedupeKey),
        generationId: task.generationId || '',
        chatId: task.chatId || '',
        messageId: task.index,
        contentSnapshotHash: task.contentSnapshotHash || '',
        acceptedCount: accepted.size,
    });
    if (accepted.size === 0) {
        recordAiRewriteDebug('apply-skip', { reason: 'accepted-empty', task: hashString(task.dedupeKey) }, 'warn');
        return { appliedCount: 0, skippedCount: 0, reason: 'accepted-empty' };
    }
    const freshnessIssue = getTaskFreshnessIssue(task);
    if (freshnessIssue) {
        recordAiRewriteDebug('apply-skip', { reason: freshnessIssue, task: hashString(task.dedupeKey) }, 'warn');
        return { appliedCount: 0, skippedCount: accepted.size, reason: freshnessIssue };
    }

    const { chat } = getAppContext();
    const msg = chat[task.index];
    const currentText = String(msg?.mes || '');
    const currentSourceText = resolveMessageDiffSource(msg);
    let nextText = currentText;
    const replacements = [];
    const skippedIds = [];
    for (const item of task.items || []) {
        if (!accepted.has(item.id)) continue;
        const rewritten = accepted.get(item.id);
        const location = locateRewriteItem(currentText, item, task);
        if (!location) {
            skippedIds.push(item.id);
            continue;
        }
        replacements.push({ ...location, id: item.id, rewritten });
    }

    const sortedReplacements = replacements.sort((a, b) => b.start - a.start || b.end - a.end);
    const acceptedRanges = [];
    const appliedReplacements = [];
    for (const replacement of sortedReplacements) {
        const overlaps = acceptedRanges.some((range) => replacement.start < range.end && range.start < replacement.end);
        if (overlaps) {
            skippedIds.push(replacement.id);
            continue;
        }
        acceptedRanges.push({ start: replacement.start, end: replacement.end });
        appliedReplacements.push(replacement);
        nextText = nextText.slice(0, replacement.start) + replacement.rewritten + nextText.slice(replacement.end);
    }

    if (appliedReplacements.length === 0) {
        recordAiRewriteDebug('apply-skip', {
            reason: 'item-locate-failed',
            task: hashString(task.dedupeKey),
            skippedIds,
        }, 'warn');
        return { appliedCount: 0, skippedCount: skippedIds.length, reason: 'item-locate-failed' };
    }

    const programText = buildFinalAiRewriteText(currentText, msg, [currentText, currentSourceText, task.snapshotText], task.aiSettings);
    nextText = buildFinalAiRewriteText(nextText, msg, [currentText, currentSourceText, task.snapshotText], task.aiSettings);
    if (nextText === currentText) {
        recordAiRewriteDebug('apply-skip', { reason: 'no-text-change', task: hashString(task.dedupeKey) }, 'warn');
        return { appliedCount: 0, skippedCount: skippedIds.length, reason: 'no-text-change' };
    }

    const nextSourceText = preserveMvuStatusPlaceholder(currentSourceText, msg, [currentText, nextText, task.snapshotText]);
    const commitResult = commitAiRewriteText(task, {
        currentText,
        sourceText: nextSourceText,
        programText,
        finalText: nextText,
    });
    if (!commitResult.committed) {
        recordAiRewriteDebug('apply-skip', { reason: commitResult.reason, task: hashString(task.dedupeKey) }, 'warn');
        return { appliedCount: 0, skippedCount: skippedIds.length, reason: commitResult.reason };
    }
    recordAiRewriteDebug('apply-success', {
        task: hashString(task.dedupeKey),
        index: task.index,
        appliedCount: appliedReplacements.length,
        skippedCount: skippedIds.length,
        strategies: appliedReplacements.map((item) => item.strategy),
        beforeLength: currentText.length,
        afterLength: nextText.length,
    });
    return { appliedCount: appliedReplacements.length, skippedCount: skippedIds.length, reason: '' };
}

function finishAiRewriteApply(task, accepted) {
    const rewriteState = runtimeState.aiRewrite;
    rewriteState.pendingApplyByKey.delete(task.dedupeKey);

    if (rewriteState.cancelledKeys.has(task.dedupeKey)) return { status: 'cancelled' };
    if (!isTaskStillFresh(task)) {
        recordAiRewriteDebug('run-stale-before-apply', {
            task: hashString(task.dedupeKey),
            reason: getTaskFreshnessIssue(task) || 'stale',
        }, 'warn');
        notifyAiRewriteStatus('error', 'AI 改写失败', '消息状态已变化，未写回', { timeOut: 8000, extendedTimeOut: 16000 });
        return { status: 'stale' };
    }

    const applyResult = applyAcceptedRewrites(task, accepted);
    const appliedCount = applyResult.appliedCount || 0;
    rewriteState.appliedKeys.add(task.dedupeKey);
    if (appliedCount > 0) {
        recordAiRewriteDebug('run-success', {
            task: hashString(task.dedupeKey),
            appliedCount,
            skippedCount: applyResult.skippedCount || 0,
        });
        const skippedText = applyResult.skippedCount ? `，跳过 ${applyResult.skippedCount} 段` : '';
        notifyAiRewriteStatus('success', 'AI 改写成功', `已应用 ${appliedCount} 段改写${skippedText}`, { timeOut: 5000 });
        return { status: 'applied', applyResult };
    }
    if (accepted.size === 0) {
        logger.warn('AI 改写响应没有可应用条目');
        recordAiRewriteDebug('run-no-accepted', { task: hashString(task.dedupeKey) }, 'warn');
        const fallbackResult = applyAiProgramFallback(task, {
            reason: 'accepted-empty',
            message: 'AI 改写未返回可应用内容，本次已改用程序改写。',
        });
        if (fallbackResult.applied) return { status: 'fallback-applied', applyResult, fallbackResult };
        notifyAiRewriteStatus('success', 'AI 改写成功', 'AI返回 0 段可应用改写', { timeOut: 5000 });
        return { status: 'empty', applyResult };
    }
    if (applyResult.reason === 'item-locate-failed') {
        recordAiRewriteDebug('run-apply-failed', {
            task: hashString(task.dedupeKey),
            reason: applyResult.reason,
            skippedCount: applyResult.skippedCount || 0,
        }, 'warn');
        const fallbackResult = applyAiProgramFallback(task, {
            reason: 'item-locate-failed',
            message: 'AI 改写返回后未能定位片段，本次已改用程序改写。',
        });
        if (fallbackResult.applied) return { status: 'fallback-applied', applyResult, fallbackResult };
        notifyAiRewriteStatus('error', 'AI 改写失败', '未能在当前消息范围内定位命中片段，未写回', { timeOut: 8000, extendedTimeOut: 16000 });
        return { status: 'apply-failed', applyResult };
    }

    if (applyResult.reason === 'swipe-slot-not-materialized'
        || applyResult.reason === 'message-branch-changed') {
        recordAiRewriteDebug('run-apply-failed', {
            task: hashString(task.dedupeKey),
            reason: applyResult.reason,
            skippedCount: applyResult.skippedCount || 0,
        }, 'warn');
        notifyAiRewriteStatus('error', 'AI 改写未写入', '当前消息分支尚未稳定，改写结果未覆盖聊天数据', {
            timeOut: 8000,
            extendedTimeOut: 16000,
        });
        return { status: 'apply-failed', applyResult };
    }

    recordAiRewriteDebug('run-no-change', {
        task: hashString(task.dedupeKey),
        acceptedCount: accepted.size,
        reason: applyResult.reason || '',
    }, 'warn');
    const fallbackResult = applyAiProgramFallback(task, {
        reason: applyResult.reason || 'no-change',
        message: 'AI 改写未返回可应用内容，本次已改用程序改写。',
    });
    if (fallbackResult.applied) return { status: 'fallback-applied', applyResult, fallbackResult };
    notifyAiRewriteStatus('success', 'AI 改写成功', '没有新的文本变更需要写入', { timeOut: 5000 });
    return { status: 'no-change', applyResult };
}

function deferAiRewriteApplyUntilFinalCleanse(task, accepted) {
    const rewriteState = runtimeState.aiRewrite;
    rewriteState.pendingApplyByKey.set(task.dedupeKey, {
        mode: 'accepted',
        task,
        accepted: new Map(accepted),
    });
    recordAiRewriteDebug('apply-deferred', {
        task: hashString(task.dedupeKey),
        index: task.index,
        finalCleanseSequence: task.finalCleanseSequence,
        pendingApplyCount: rewriteState.pendingApplyByKey.size,
    });
    recordAiRewriteDebug('response-deferred', {
        task: hashString(task.dedupeKey),
        generationId: task.generationId || '',
        chatId: task.chatId || '',
        messageId: task.index,
        contentSnapshotHash: task.contentSnapshotHash || '',
        finalCleanseSequence: task.finalCleanseSequence,
    });
    return { status: 'deferred' };
}

function deferAiRewriteFallbackUntilFinalCleanse(task, options = {}) {
    runtimeState.aiRewrite.pendingApplyByKey.set(task.dedupeKey, {
        mode: 'fallback',
        task,
        fallbackOptions: { ...options },
    });
    recordAiRewriteDebug('apply-deferred', {
        task: hashString(task.dedupeKey),
        index: task.index,
        finalCleanseSequence: task.finalCleanseSequence,
        mode: 'fallback',
    });
    return { status: 'deferred-fallback' };
}

function finishOrDeferAiRewriteApply(task, accepted) {
    if (accepted.size > 0 && !hasFinalCleanseAfterTaskStart(task)) {
        return deferAiRewriteApplyUntilFinalCleanse(task, accepted);
    }
    return finishAiRewriteApply(task, accepted);
}

function getPendingApplyCountForMessageKey(messageKey) {
    const rewriteState = runtimeState.aiRewrite;
    let count = 0;
    rewriteState.pendingApplyByKey.forEach(({ task }) => {
        if (getTaskMessageKey(task) === messageKey) count++;
    });
    return count;
}

function hasRunningAiRewriteForMessage(index) {
    for (const meta of getRunningTaskMetaMap().values()) {
        if (Number(meta?.index) === Number(index)) return true;
    }
    return false;
}

function flushPendingAiRewriteApplyForMessageKey(messageKey) {
    const rewriteState = runtimeState.aiRewrite;
    const entries = [...rewriteState.pendingApplyByKey.entries()]
        .filter(([, entry]) => getTaskMessageKey(entry.task) === messageKey);
    let handledCount = 0;
    entries.forEach(([dedupeKey, entry]) => {
        rewriteState.pendingApplyByKey.delete(dedupeKey);
        if (rewriteState.cancelledKeys.has(dedupeKey)) return;
        recordAiRewriteDebug('apply-flush', {
            task: hashString(dedupeKey),
            index: entry.task.index,
            finalCleanseSequence: rewriteState.finalCleanseSequence,
        });
        const result = entry.mode === 'fallback'
            ? applyAiProgramFallback(entry.task, entry.fallbackOptions)
            : finishAiRewriteApply(entry.task, entry.accepted);
        if (entry.mode === 'fallback' ? result?.applied === true : ['applied', 'fallback-applied'].includes(result?.status)) {
            handledCount += 1;
        }
    });
    return handledCount;
}

export function markAiRewriteFinalCleanseReady(payload, options = {}) {
    const { chat } = getAppContext();
    const parsed = parseStableMessagePayload(payload);
    if (!parsed.ok) {
        recordAiRewriteDebug('payload-rejected', { source: 'final', reason: parsed.reason }, 'warn');
        return false;
    }
    const index = parsed.messageIndex;
    if (!Array.isArray(chat) || index < 0 || !isAssistantMessage(chat[index])) return false;
    const validation = validateAiRewriteFinalTimer(payload);
    if (!validation.ok || validation.session.messageId !== index) {
        recordAiRewriteDebug('run-skip', {
            generationId: String(payload?.generationId || ''),
            index,
            reason: validation.reason || 'generation-message-mismatch',
        }, 'warn');
        return false;
    }

    const msg = chat[index];
    const branchKey = getMessageDiffBranchKey(msg);
    const messageKey = getAiRewriteMessageKey(index, branchKey);
    const rewriteState = runtimeState.aiRewrite;
    rewriteState.finalCleanseSequence = (Number(rewriteState.finalCleanseSequence) || 0) + 1;
    rewriteState.finalCleanseByMessageKey.set(messageKey, rewriteState.finalCleanseSequence);

    recordAiRewriteDebug('final-cleanse-ready', {
        index,
        branchKey,
        sequence: rewriteState.finalCleanseSequence,
        pendingApplyCount: getPendingApplyCountForMessageKey(messageKey),
        scheduleRequest: options.scheduleRequest !== false,
        generationId: validation.session.generationId,
        chatId: validation.session.chatId,
    });
    const flushedCount = flushPendingAiRewriteApplyForMessageKey(messageKey);
    if (flushedCount > 0) return true;
    if (options.scheduleRequest === false) return false;

    if (hasStreamingAiRewriteStartedForMessage(index) && hasRunningAiRewriteForMessage(index)) {
        recordAiRewriteDebug('final-cleanse-skip-request', {
            index,
            branchKey,
            reason: 'streaming-task-already-running',
        });
        return true;
    }

    const taskCheck = buildAiRewriteTaskCheck(payload, { automatic: true });
    if (taskCheck.fallbackTask) {
        const fallbackResult = applyAiProgramFallback(taskCheck.fallbackTask, {
            reason: taskCheck.fallbackCode || 'not-sent',
            message: taskCheck.fallbackWarning || '已命中 AI 改写规则，但 AI 不可用，本次仅执行程序改写。',
            notify: taskCheck.fallbackCode !== 'disabled',
        });
        return fallbackResult.applied === true;
    }
    const readyTask = taskCheck.task;
    if (!readyTask) {
        recordAiRewriteDebug('final-cleanse-no-ai-task', {
            index,
            branchKey,
            reason: taskCheck.reason || 'not-ready',
        });
        return false;
    }
    const runningTask = findRunningAiRewriteForReadyTask(readyTask);
    if (runningTask) {
        recordAiRewriteDebug('final-cleanse-skip-request', {
            index,
            branchKey,
            reason: 'same-streaming-task-running',
            runningTask: hashString(runningTask.dedupeKey),
            runningSource: runningTask.meta?.source || '',
        });
        return true;
    }
    return scheduleAiRewriteForMessage(payload, { delayMs: 0 });
}

export function shouldDeferFinalCleanseForAiRewrite(payload) {
    const candidate = buildAiRewriteCandidate(payload, {
        automatic: true,
        freezeIdentity: false,
    });
    return Boolean(candidate.task);
}

async function requestAiRewrite(prompt, aiSettings, signal, task = null) {
    const tavernHelper = getTavernHelperApi();
    if (!tavernHelper) throw new Error('TavernHelper.generateRaw 不可用');
    const generationId = `veridis-ai-rewrite-${hashString(`${Date.now()}:${task?.dedupeKey || prompt.length}`)}`;
    const requestConfig = buildAiRewriteGenerateRawConfig(prompt, aiSettings, generationId);
    const sampling = normalizeAiSamplingSettings(aiSettings);
    const startedAt = Date.now();
    recordAiRewriteDebug('fetch-start', {
        endpoint: 'TavernHelper.generateRaw',
        helperGenerationId: generationId,
        model: aiSettings.model,
        apiSource: 'custom',
        responseFormat: 'json_object',
        sampling: {
            temperature: sampling.temperature,
            topP: sampling.topP,
            topK: sampling.topK,
            frequencyPenalty: sampling.frequencyPenalty,
            presencePenalty: sampling.presencePenalty,
            repetitionPenalty: sampling.repetitionPenalty,
            maxTokens: sampling.maxTokens,
        },
        promptLength: String(prompt || '').length,
        timeoutMs: aiSettings.timeoutMs,
        generationId: task?.generationId || '',
        chatId: task?.chatId || '',
        index: Number.isInteger(task?.index) ? task.index : null,
        source: task?.scheduleSource || '',
        snapshotHash: task?.contentSnapshotHash || '',
    });
    const stopGeneration = () => {
        try {
            tavernHelper.stopGenerationById?.(generationId);
        } catch (error) {
            logger.warn('停止酒馆助手自定义 API 改写请求失败', error);
        }
    };
    signal?.addEventListener?.('abort', stopGeneration, { once: true });
    try {
        const response = await tavernHelper.generateRaw(requestConfig);
        if (signal?.aborted) {
            const abortError = new Error('请求已取消');
            abortError.name = 'AbortError';
            throw abortError;
        }
        const content = typeof response === 'string' ? response : String(response ?? '');
        if (!content) throw new Error('酒馆助手自定义 API 返回空响应');
        recordAiRewriteDebug('fetch-response', {
            endpoint: 'TavernHelper.generateRaw',
            ok: true,
            elapsedMs: Date.now() - startedAt,
            responseLength: content.length,
            generationId: task?.generationId || '',
            chatId: task?.chatId || '',
            index: Number.isInteger(task?.index) ? task.index : null,
        });
        recordAiRewriteDebug('response-content', {
            contentLength: content.length,
            transport: 'tavern-helper-custom-api',
        });
        return content;
    } finally {
        signal?.removeEventListener?.('abort', stopGeneration);
    }
}

export function cancelAiRewriteTask(reason = 'cancelled') {
    const state = runtimeState.aiRewrite;
    if (state?.activeController) {
        try {
            state.activeController.abort(reason);
        } catch (err) {
            logger.warn('取消 AI 改写请求失败', err);
        }
    }
    if (state) {
        state.activeController = null;
        state.activeTaskKey = '';
        state.activeTaskMeta = null;
    }
}

function finishAutomaticTaskBeforeRun(payload, reason, state = 'stale') {
    const generationId = String(payload?.generationId || '');
    const identity = getContentIdentity(generationId);
    const taskKey = String(identity?.taskKey || '');
    if (taskKey) {
        runtimeState.aiRewrite.cancelledKeys.add(taskKey);
        runtimeState.aiRewrite.pendingKeys.delete(taskKey);
        runtimeState.aiRewrite.pendingApplyByKey.delete(taskKey);
        getRunningTaskMetaMap().delete(taskKey);
    }
    if (runtimeState.aiRewrite.activeTaskKey === taskKey) cancelAiRewriteTask(reason);
    generationLifecycle.markRequestTerminated(generationId, state, reason);
    getContentIdentityMap().delete(generationId);
    if (!taskKey || runtimeState.aiRewrite.statusTaskKey === taskKey) {
        clearAiRewriteStatusToast(null, reason);
    }
    recordAiRewriteDebug('task-cancelled', {
        task: taskKey ? hashString(taskKey) : '',
        generationId,
        chatId: String(payload?.chatId || identity?.chatId || ''),
        messageId: Number.isInteger(identity?.messageId) ? identity.messageId : null,
        requestState: generationLifecycle.getSession(generationId)?.requestState || state,
        reason: String(reason || state),
        source: String(payload?.source || ''),
    }, 'warn');
}

export function validateAiRewriteFinalTimer(payload) {
    const generationId = String(payload?.generationId || '');
    if (!getContentIdentity(generationId)) {
        return generationLifecycle.validate(generationId, {
            chatId: getCurrentChatIdentity(),
            chat: getAppContext().chat,
        });
    }
    return validateAutomaticAiRewriteContent({
        generationId,
        chatId: String(payload?.chatId || ''),
        index: Number(payload?.messageId),
        scheduleSource: String(payload?.source || 'final-timer'),
    }, { source: 'final-timer' });
}

export function validateAiRewriteMessageTarget(payload) {
    const generationId = String(payload?.generationId || '');
    const identity = getContentIdentity(generationId);
    if (!identity) return { ok: true, changed: false, reason: '' };
    const validation = validateAutomaticAiRewriteContent({
        generationId,
        chatId: String(payload?.chatId || ''),
        index: Number(payload?.messageId),
        scheduleSource: String(payload?.source || 'final-cleanse'),
    }, { source: 'message-acknowledgement' });
    if (!validation.ok) return validation;

    const resolution = generationLifecycle.resolveMessage(payload, {
        generationId,
        chatId: identity.chatId,
        chat: getAppContext().chat,
        source: 'message-content-accepted',
    });
    if (!resolution.ok) return resolution;
    recordAiRewriteDebug('message-target-confirmed', {
        generationId,
        chatId: identity.chatId,
        messageId: identity.messageId,
        contentSnapshotHash: identity.requestSnapshotHash,
        messageLength: String(resolution.message?.mes || '').length,
    });
    return {
        ok: true,
        changed: false,
        reason: '',
    };
}

export function handleAiRewriteFinalTimerSkipped(payload, reason) {
    if (!getContentIdentity(payload?.generationId)) return;
    finishAutomaticTaskBeforeRun(payload, reason || 'final-timer-skipped', 'stale');
}

export function handleAiRewriteGenerationStarted(session = null) {
    streamingXmlScanByMessageId.clear();
    automaticRunPromiseByGenerationId.clear();
    const state = runtimeState.aiRewrite;
    const cancelledTaskKey = String(state?.activeTaskKey || '');
    if (state?.activeController) {
        recordAiRewriteDebug('generation-started-cancelled-active', {
            task: hashString(state.activeTaskKey),
            reason: 'superseded-by-new-generation',
            generationId: session?.generationId || '',
        });
    }
    state.streamingStartedMessageIndices.clear();
    clearAiRewriteStatusToast(null, 'superseded-by-new-generation');
    state.statusDismissedTaskKey = '';
    cancelAiRewriteTask('generation-started');
    state.pendingKeys.clear();
    state.startedKeys.clear();
    state.appliedKeys.clear();
    state.cancelledKeys.clear();
    if (cancelledTaskKey) state.cancelledKeys.add(cancelledTaskKey);
    state.readyNoticeKeys.clear();
    state.pendingApplyByKey.clear();
    getContentIdentityMap().clear();
    getRunningTaskMetaMap().clear();
}

export function resetAiRewriteRuntimeState(reason = 'reset') {
    cancelAiRewriteTask(reason);
    clearAiRewriteStatusToast();
    if (readyNoticeTimer) {
        clearTimeout(readyNoticeTimer);
        readyNoticeTimer = null;
    }
    const state = runtimeState.aiRewrite;
    state.statusDismissedTaskKey = '';
    streamingXmlScanByMessageId.clear();
    automaticRunPromiseByGenerationId.clear();
    state.pendingKeys.clear();
    state.startedKeys.clear();
    state.appliedKeys.clear();
    state.cancelledKeys.clear();
    state.readyNoticeKeys.clear();
    state.streamingStartedMessageIndices.clear();
    getRunningTaskMetaMap().clear();
    state.finalCleanseSequence = 0;
    state.finalCleanseByMessageKey.clear();
    state.pendingApplyByKey.clear();
    getContentIdentityMap().clear();
}

function buildAiRewriteCandidate(payload, options = {}) {
    const settings = getSettings();
    const aiSettings = getAiSettings();
    const { chat } = getAppContext();
    const parsed = parseStableMessagePayload(payload);
    if (!parsed.ok) return { task: null, reason: `消息参数无效：${parsed.reason}` };
    const index = parsed.messageIndex;
    if (!Array.isArray(chat) || index < 0 || index >= chat.length) {
        return { task: null, reason: '未找到可改写的助手消息' };
    }

    const msg = chat[index];
    if (!isAssistantMessage(msg)) return { task: null, reason: '目标消息不是助手消息' };
    if (msg?.__blai_is_reverted) return { task: null, reason: '目标消息已撤回净化' };
    const isAutomatic = payload?.automatic === true;
    if (isAutomatic) {
        const validation = generationLifecycle.validate(payload.generationId, {
            chatId: getCurrentChatIdentity(),
            chat,
        });
        if (!validation.ok) return { task: null, reason: `生成事务已失效：${validation.reason}` };
        if (validation.session.messageId !== index || validation.session.messageRef !== msg) {
            return { task: null, reason: '生成事务目标消息不一致' };
        }
        if (String(payload.chatId || '') !== validation.session.chatId) {
            return { task: null, reason: '生成事务聊天身份不一致' };
        }
    } else if (options.manual !== true) {
        return { task: null, reason: '自动 AI 改写缺少生成事务身份' };
    }
    const rawSnapshotText = payload && typeof payload === 'object' && typeof payload.snapshotText === 'string'
        ? payload.snapshotText
        : '';
    const diffSourceText = options.preferDiffSource === true && !isMessageManualFinal(msg)
        ? resolveMessageDiffSource(msg)
        : '';
    const rawSourceText = rawSnapshotText || diffSourceText || (typeof msg.mes === 'string' ? msg.mes : '');
    const sourceText = getAiXmlScopedRequestText(rawSourceText, aiSettings);
    if (typeof sourceText !== 'string' || !sourceText.trim()) return { task: null, reason: '目标消息为空' };

    const { wholeMessage, tagName } = getAiXmlScopeTag(aiSettings);
    const segments = collectAiXmlScopeSegments(sourceText, aiSettings);
    if (segments.length === 0) {
        return { task: null, reason: `未找到完整 <${tagName}>...</${tagName}>` };
    }

    const matches = collectAiMatches(sourceText, settings, aiSettings);
    if (matches.length === 0) {
        return { task: null, reason: wholeMessage ? '整条消息内未命中 AI 改写规则' : `<${tagName}> 内未命中 AI 改写规则` };
    }

    const items = buildRewriteItems(sourceText, matches, aiSettings);
    if (items.length === 0) {
        return { task: null, reason: '命中内容没有可改写片段' };
    }

    const versionToken = buildAiRewriteVersionToken(settings);
    const dedupeKey = buildDedupeKey(index, msg, settings, versionToken, aiSettings, sourceText);
    const shouldFreezeIdentity = isAutomatic && options.freezeIdentity !== false;
    const contentIdentity = shouldFreezeIdentity
        ? freezeAiRewriteContentIdentity(payload, sourceText, aiSettings)
        : null;
    if (shouldFreezeIdentity && !contentIdentity) {
        return { task: null, reason: '无法冻结自动 AI 改写 content identity' };
    }
    if (contentIdentity) contentIdentity.taskKey = dedupeKey;
    if (options.logTask === true) {
        recordAiRewriteDebug('task-ready', {
            task: hashString(dedupeKey),
            index,
            branchKey: getMessageDiffBranchKey(msg),
            scopeMode: wholeMessage ? 'whole-message' : 'xml',
            xmlTag: tagName,
            segmentCount: segments.length,
            matchCount: matches.length,
            ruleHitCount: countMatchedAiRules(matches),
            itemCount: items.length,
            itemLengths: items.map(item => item.text.length),
            isStreaming: runtimeState.isStreamingGeneration === true,
            source: rawSnapshotText ? 'streaming-snapshot' : 'message',
            rawSourceLength: rawSourceText.length,
            sourceLength: sourceText.length,
            generationId: isAutomatic ? String(payload.generationId || '') : '',
            chatId: isAutomatic ? String(payload.chatId || '') : '',
            contentSnapshotHash: contentIdentity?.requestSnapshotHash || hashString(sourceText),
        });
    }
    return {
        task: {
            settings,
            aiSettings,
            index,
            msg,
            messageRef: msg,
            branchKey: getMessageDiffBranchKey(msg),
            snapshotText: sourceText,
            items,
            ruleHitCount: countMatchedAiRules(matches),
            versionToken,
            dedupeKey,
            automatic: isAutomatic,
            generationId: isAutomatic ? String(payload.generationId || '') : '',
            chatId: isAutomatic ? String(payload.chatId || '') : '',
            scheduleSource: isAutomatic ? String(payload.source || '') : 'manual',
            contentSnapshotHash: contentIdentity?.requestSnapshotHash || hashString(sourceText),
        },
        reason: '',
    };
}

function buildAiRewriteTaskCheck(payload, options = {}) {
    const candidate = buildAiRewriteCandidate(payload, options);
    if (!candidate.task) return candidate;

    const configIssue = getAiConfigIssue(candidate.task.aiSettings);
    if (configIssue) {
        return {
            task: null,
            reason: configIssue.reason,
            fallbackTask: candidate.task,
            fallbackCode: configIssue.code,
            fallbackWarning: configIssue.warning,
        };
    }

    return candidate;
}

function buildReadyAiRewriteTask(payload) {
    return buildAiRewriteTaskCheck(payload, { automatic: true }).task;
}

function notifyAiRewriteNotSent(taskCheckOrReason, options = {}) {
    const taskCheck = taskCheckOrReason && typeof taskCheckOrReason === 'object'
        ? taskCheckOrReason
        : null;
    if (taskCheck?.fallbackTask && options.allowFallback !== false) {
        const fallbackResult = applyAiProgramFallback(taskCheck.fallbackTask, {
            reason: taskCheck.fallbackCode || 'not-sent',
            message: taskCheck.fallbackWarning || '已命中 AI 改写规则，但 AI 不可用，本次仅执行程序改写。',
            notify: taskCheck.fallbackCode !== 'disabled',
        });
        if (fallbackResult.applied) return;
    }

    const message = String(taskCheck?.reason || taskCheckOrReason || '未满足发送条件');
    recordAiRewriteDebug('not-sent', { reason: message }, runtimeState.aiRewrite.statusToast ? 'warn' : 'info');
    if (!runtimeState.aiRewrite.statusToast) {
        logger.info(`AI 改写未发送：${message}`);
        return;
    }
    logger.warn(`AI 改写未发送：${message}`);
    notifyAiRewriteStatus('error', 'AI 改写未发送', message, { timeOut: 8000, extendedTimeOut: 16000 });
}

function notifyAiRewriteReadyForMessage(payload) {
    if (runtimeState.isStreamingGeneration !== true) return;
    const task = buildReadyAiRewriteTask(payload);
    if (!task) return;

    const rewriteState = runtimeState.aiRewrite;
    if (rewriteState.pendingKeys.has(task.dedupeKey)
        || rewriteState.startedKeys.has(task.dedupeKey)
        || rewriteState.appliedKeys.has(task.dedupeKey)
        || rewriteState.cancelledKeys.has(task.dedupeKey)
        || rewriteState.readyNoticeKeys.has(task.dedupeKey)) return;

    rewriteState.readyNoticeKeys.add(task.dedupeKey);
    recordAiRewriteDebug('task-built', {
        task: hashString(task.dedupeKey),
        generationId: task.generationId,
        chatId: task.chatId,
        messageId: task.index,
        contentSnapshotHash: task.contentSnapshotHash,
        source: task.scheduleSource,
    });
    recordAiRewriteDebug('xml-ready-request', {
        task: hashString(task.dedupeKey),
        index: task.index,
        ruleHitCount: task.ruleHitCount,
        itemCount: task.items.length,
        itemLengths: task.items.map(item => item.text.length),
    });
    recordAiRewriteDebug('popup-preparing', {
        task: hashString(task.dedupeKey),
        generationId: task.generationId,
        messageId: task.index,
    });
    const groupCount = Math.max(1, groupRewriteItemsByPrompt(task.items, task.aiSettings).length);
    notifyAiRewriteProgress(task, 1, groupCount);
    scheduleAiRewriteForMessage(payload, { delayMs: 0 });
}

export function scheduleAiRewriteReadyNotice(payload, options = {}) {
    const delay = normalizeLimit(options.delayMs, 160, 0, 3000);
    if (readyNoticeTimer) return;
    readyNoticeTimer = setTimeout(() => {
        readyNoticeTimer = null;
        notifyAiRewriteReadyForMessage(payload);
    }, delay);
}

export function maybeNotifyAiRewriteReadyFromStreamingText(messageId, text, lifecycle = {}) {
    const index = Number(messageId);
    if (!Number.isInteger(index) || index < 0) return;
    const sourceText = typeof text === 'string' ? text : String(text ?? '');
    if (!sourceText) return;

    const { chat } = getAppContext();
    const resolution = generationLifecycle.resolveMessage(index, {
        generationId: lifecycle.generationId,
        chatId: lifecycle.chatId || getCurrentChatIdentity(),
        chat,
        source: lifecycle.source || 'streaming',
        allowBoundMessage: false,
    });
    if (!resolution.ok) {
        recordAiRewriteDebug('payload-rejected', {
            source: 'streaming',
            index,
            reason: resolution.reason,
        }, 'warn');
        return;
    }

    const aiSettings = getAiSettings();
    if (aiSettings.enabled !== true) return;
    const { wholeMessage, tagName } = getAiXmlScopeTag(aiSettings);
    if (wholeMessage) return;
    const scanKey = `${index}:${tagName}`;
    const scanState = streamingXmlScanByMessageId.get(scanKey) || {
        checkedLength: 0,
        closeObserved: false,
        closedSeen: false,
    };
    if (scanState.closedSeen === true) return;

    const previousLength = Number(scanState.checkedLength) || 0;
    const stablePreviousLength = sourceText.length < previousLength ? 0 : previousLength;
    const scanStart = Math.max(0, stablePreviousLength - streamingXmlTailLookbackChars);
    const scanText = sourceText.slice(scanStart);
    scanState.checkedLength = sourceText.length;

    const endTagRegex = new RegExp(`<\\s*/\\s*${escapeRegExp(tagName)}\\s*>`, 'iu');
    if (endTagRegex.test(scanText)) scanState.closeObserved = true;
    if (scanState.closeObserved !== true) {
        streamingXmlScanByMessageId.set(scanKey, scanState);
        return;
    }
    if (lifecycle.hostCommitted !== true) {
        streamingXmlScanByMessageId.set(scanKey, scanState);
        return;
    }

    const committedText = typeof resolution.message?.mes === 'string'
        ? resolution.message.mes
        : '';
    const committedScope = extractCurrentAiRewriteScope(committedText, aiSettings);
    if (!committedScope.ok) {
        streamingXmlScanByMessageId.set(scanKey, scanState);
        return;
    }

    scanState.closedSeen = true;
    streamingXmlScanByMessageId.set(scanKey, scanState);
    recordAiRewriteDebug('streaming-xml-end-detected', {
        index,
        xmlTag: tagName,
        sourceLength: sourceText.length,
        committedSourceLength: committedText.length,
        scanStart,
    });
    const frozenSnapshot = committedScope.text;
    freezeAiRewriteContentIdentity({
        automatic: true,
        generationId: resolution.generationId,
        chatId: resolution.chatId,
        messageId: index,
    }, frozenSnapshot, aiSettings);
    notifyAiRewriteReadyForMessage({
        automatic: true,
        generationId: resolution.generationId,
        chatId: resolution.chatId,
        messageId: index,
        snapshotText: frozenSnapshot,
        streamingSnapshot: true,
        source: 'streaming',
    });
}

async function requestAcceptedRewritesOnce(task, rewriteState, attempt, maxAttempts, accepted, completedGroupKeys) {
    const timeoutMs = normalizeLimit(task.aiSettings.timeoutMs, defaultAiRewriteSettings.timeoutMs, 1000, 120000);
    const groups = groupRewriteItemsByPrompt(task.items, task.aiSettings);
    for (const [groupOffset, group] of groups.entries()) {
        if (completedGroupKeys.has(group.key)) {
            recordAiRewriteDebug('request-group-skip', {
                task: hashString(task.dedupeKey),
                attempt,
                group: group.key,
                reason: 'already-completed',
            });
            continue;
        }
        if (rewriteState.cancelledKeys.has(task.dedupeKey)) {
            recordAiRewriteDebug('request-cancelled-before-fetch', { task: hashString(task.dedupeKey), attempt }, 'warn');
            return { cancelled: true, accepted };
        }
        const freshnessIssueBeforeFetch = getTaskFreshnessIssue(task);
        if (freshnessIssueBeforeFetch) {
            recordAiRewriteDebug('request-stale-before-fetch', {
                task: hashString(task.dedupeKey),
                generationId: task.generationId || '',
                reason: freshnessIssueBeforeFetch,
            }, 'warn');
            return { stale: true, accepted };
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort('timeout'), timeoutMs);
        rewriteState.activeController = controller;
        rewriteState.activeTaskKey = task.dedupeKey;
        rewriteState.activeTaskMeta = {
            index: task.index,
            messageRef: task.messageRef,
            branchKey: task.branchKey,
            snapshotHash: getAiRewriteTaskSnapshotHash(task),
            versionToken: task.versionToken,
            waitForFinalCleanse: task.waitForFinalCleanse === true,
        };

        try {
            const prompt = renderPrompt(task.snapshotText, group.items, task.settings, task.aiSettings, group.promptTemplate);
            logger.info(`发送 AI 改写请求：第 ${attempt}/${maxAttempts} 次，片段 ${group.items.length} 段`);
            recordAiRewriteDebug('request-group', {
                task: hashString(task.dedupeKey),
                attempt,
                maxAttempts,
                group: group.key,
                groupItemCount: group.items.length,
                groupItemIds: group.items.map(item => item.id),
                timeoutMs,
            });
            notifyAiRewriteProgress(task, groupOffset + 1, groups.length, attempt, maxAttempts);
            const rawResponse = await requestAiRewrite(prompt, task.aiSettings, controller.signal, task);
            const freshnessIssue = getTaskFreshnessIssue(task);
            if (freshnessIssue) {
                recordAiRewriteDebug('request-stale-after-fetch', { task: hashString(task.dedupeKey), reason: freshnessIssue }, 'warn');
                return { stale: true, accepted };
            }
            const groupAccepted = parseAiResponse(rawResponse, new Map(group.items.map((item) => [item.id, item])), task.aiSettings);
            groupAccepted.forEach((value, key) => accepted.set(key, value));
            completedGroupKeys.add(group.key);
        } catch (err) {
            const abortReason = controller.signal.aborted ? String(controller.signal.reason || 'aborted') : '';
            if (abortReason && abortReason !== 'timeout') {
                logger.info(`AI 改写请求已取消: ${abortReason}`);
                recordAiRewriteDebug('request-aborted', {
                    task: hashString(task.dedupeKey),
                    attempt,
                    group: group.key,
                    reason: abortReason,
                }, 'warn');
                return { cancelled: true, accepted };
            }
            const reason = abortReason === 'timeout' ? '请求超时' : (err?.message || '请求未完成');
            recordAiRewriteDebug('request-error', {
                task: hashString(task.dedupeKey),
                attempt,
                group: group.key,
                groupItemCount: group.items.length,
                reason,
            }, 'warn');
            if (isAiRewriteResponseFormatError(err)) throw err;
            if (isBadRequestError(err)) throw new AiRewriteRequestFormatError(reason, err);
            const wrapped = new Error(reason);
            wrapped.cause = err;
            wrapped.attempt = attempt;
            wrapped.maxAttempts = maxAttempts;
            throw wrapped;
        } finally {
            clearTimeout(timeoutId);
            if (rewriteState.activeTaskKey === task.dedupeKey && rewriteState.activeController === controller) {
                rewriteState.activeController = null;
                rewriteState.activeTaskKey = '';
                rewriteState.activeTaskMeta = null;
            }
        }
    }
    return { stale: false, accepted };
}

async function runAiRewriteForMessage(payload, options = {}) {
    if (payload?.automatic === true && options.claimRequest === true) {
        const claim = generationLifecycle.claimRequest(payload.generationId, payload.source || 'mvu-transaction');
        if (!claim.ok) {
            recordAiRewriteDebug('task-deduped', {
                generationId: String(payload.generationId || ''),
                chatId: String(payload.chatId || ''),
                index: parseStableMessagePayload(payload).messageIndex,
                source: String(payload.source || ''),
                reason: claim.reason,
            });
            return { status: 'deduped', reason: claim.reason };
        }
    }
    const waitForFinalCleanse = typeof options.waitForFinalCleanse === 'boolean'
        ? options.waitForFinalCleanse
        : runtimeState.isStreamingGeneration === true || payload?.streamingSnapshot === true;
    if (waitForFinalCleanse === true) {
        logger.info('AI 改写在 XML 闭合后提前请求，返回后等待最终净化再写回');
    }
    const taskCheck = buildAiRewriteTaskCheck(payload, {
        logTask: true,
        preferDiffSource: options.preferDiffSource === true,
        manual: options.manual === true,
    });
    const readyTask = taskCheck.task;
    if (!readyTask) {
        if (payload?.automatic === true) generationLifecycle.markRequestFailed(payload.generationId, taskCheck.reason || 'task-not-ready');
        notifyAiRewriteNotSent(taskCheck);
        return;
    }
    const { settings, aiSettings, index, msg, items, versionToken, dedupeKey } = readyTask;
    const rewriteState = runtimeState.aiRewrite;
    if (rewriteState.cancelledKeys.has(dedupeKey)) {
        logger.info('AI 改写已由用户终止，跳过发送');
        recordAiRewriteDebug('run-skip', { task: hashString(dedupeKey), reason: 'user-terminated' }, 'warn');
        return;
    }
    if (rewriteState.pendingKeys.has(dedupeKey) || rewriteState.startedKeys.has(dedupeKey) || rewriteState.appliedKeys.has(dedupeKey)) {
        recordAiRewriteDebug('run-skip', {
            task: hashString(dedupeKey),
            reason: rewriteState.pendingKeys.has(dedupeKey)
                ? 'already-pending'
                : rewriteState.startedKeys.has(dedupeKey)
                    ? 'already-started'
                    : 'already-applied',
        });
        return;
    }

    const runningSameTask = findRunningAiRewriteForReadyTask(readyTask, dedupeKey);
    if (runningSameTask) {
        recordAiRewriteDebug('run-skip', {
            task: hashString(dedupeKey),
            reason: 'same-snapshot-task-running',
            runningTask: hashString(runningSameTask.dedupeKey),
            runningSource: runningSameTask.meta?.source || '',
        });
        return;
    }

    if (readyTask.automatic === true && !generationLifecycle.markRequestRunning(readyTask.generationId)) {
        recordAiRewriteDebug('run-skip', {
            generationId: readyTask.generationId,
            index: readyTask.index,
            reason: 'generation-request-not-scheduled',
        }, 'warn');
        finishAutomaticTaskBeforeRun(payload, 'generation-request-not-scheduled', 'failed');
        return;
    }

    if (rewriteState.activeController && rewriteState.activeTaskKey !== dedupeKey) cancelAiRewriteTask('superseded');

    const branchKey = getMessageDiffBranchKey(msg);
    rewriteState.statusDismissedTaskKey = '';
    rewriteState.startedKeys.add(dedupeKey);
    rewriteState.pendingKeys.add(dedupeKey);
    recordAiRewriteDebug('run-start', {
        task: hashString(dedupeKey),
        index,
        branchKey,
        itemCount: items.length,
        ruleHitCount: readyTask.ruleHitCount,
        model: aiSettings.model,
        transport: 'tavern-helper-custom-api',
        maxRetries: getAiRetryCount(aiSettings),
        isStreaming: runtimeState.isStreamingGeneration === true,
        waitForFinalCleanse,
    });

    const task = {
        index,
        messageRef: msg,
        branchKey,
        snapshotText: readyTask.snapshotText || msg.mes,
        settings,
        aiSettings,
        versionToken,
        dedupeKey,
        items,
        ruleHitCount: readyTask.ruleHitCount,
        waitForFinalCleanse,
        finalCleanseSequence: Number(rewriteState.finalCleanseSequence) || 0,
        automatic: readyTask.automatic === true,
        generationId: readyTask.generationId || '',
        chatId: readyTask.chatId || '',
        scheduleSource: readyTask.scheduleSource || '',
        contentSnapshotHash: readyTask.contentSnapshotHash || hashString(readyTask.snapshotText || ''),
    };
    markStreamingAiRewriteStarted(task);
    getRunningTaskMetaMap().set(dedupeKey, {
        index: task.index,
        messageRef: task.messageRef,
        branchKey: task.branchKey,
        snapshotHash: getAiRewriteTaskSnapshotHash(task),
        versionToken: task.versionToken,
        source: task.waitForFinalCleanse === true ? 'streaming' : 'final',
        waitForFinalCleanse: task.waitForFinalCleanse === true,
    });

    try {
        const maxAttempts = getAiRetryCount(aiSettings) + 1;
        const accepted = new Map();
        const completedGroupKeys = new Set();
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const result = await requestAcceptedRewritesOnce(task, rewriteState, attempt, maxAttempts, accepted, completedGroupKeys);
                if (result?.cancelled) {
                    if (task.automatic === true) generationLifecycle.markRequestFailed(task.generationId, 'request-cancelled');
                    if (!rewriteState.cancelledKeys.has(dedupeKey)) {
                        recordAiRewriteDebug('run-cancelled', { task: hashString(dedupeKey), reason: 'request-cancelled' }, 'warn');
                        notifyAiRewriteStatus('error', 'AI 改写失败', '请求已取消，未写回', { timeOut: 8000, extendedTimeOut: 16000 });
                    }
                    return;
                }
                if (result?.stale) {
                    if (task.automatic === true) generationLifecycle.markRequestFailed(task.generationId, getTaskFreshnessIssue(task) || 'stale');
                    recordAiRewriteDebug('run-stale', { task: hashString(dedupeKey), reason: getTaskFreshnessIssue(task) || 'stale' }, 'warn');
                    notifyAiRewriteStatus('error', 'AI 改写失败', '消息已变化，未写回', { timeOut: 8000, extendedTimeOut: 16000 });
                    return;
                }
                break;
            } catch (err) {
                if (rewriteState.cancelledKeys.has(dedupeKey)) return;
                if (isNonRetryableAiRewriteError(err)) throw err;
                if (attempt >= maxAttempts || !isTaskStillFresh(task)) throw err;
                recordAiRewriteDebug('retry', {
                    task: hashString(dedupeKey),
                    nextAttempt: attempt + 1,
                    maxAttempts,
                    reason: err?.message || '请求未完成',
                }, 'warn');
            }
        }

        if (rewriteState.cancelledKeys.has(dedupeKey)) return;
        if (task.automatic === true) generationLifecycle.markRequestSucceeded(task.generationId);
        return finishOrDeferAiRewriteApply(task, accepted);
    } catch (err) {
        if (task.automatic === true) generationLifecycle.markRequestFailed(task.generationId, err?.message || 'request-failed');
        logger.warn('AI 改写失败', err);
        recordAiRewriteDebug('run-error', { task: hashString(dedupeKey), reason: err?.message || '请求未完成' }, 'warn');
        if (isAiRewriteResponseFormatError(err)) {
            notifyAiRewriteStatus('error', 'AI 返回格式错误', `${err.message}；已停止重试，本次未写回`, {
                timeOut: 12000,
                extendedTimeOut: 20000,
            });
            return;
        }
        if (isAiRewriteRequestFormatError(err)) {
            notifyAiRewriteStatus('error', 'AI 请求格式错误', `${err.message}；已停止重试，本次未写回`, {
                timeOut: 12000,
                extendedTimeOut: 20000,
            });
            return;
        }
        if (!rewriteState.cancelledKeys.has(dedupeKey) && isTaskStillFresh(task)) {
            const fallbackOptions = {
                reason: 'retry-exhausted',
                title: err?.message || '请求未完成',
                message: '',
            };
            if (!hasFinalCleanseAfterTaskStart(task)) {
                deferAiRewriteFallbackUntilFinalCleanse(task, fallbackOptions);
                return;
            }
            const fallbackResult = applyAiProgramFallback(task, fallbackOptions);
            if (fallbackResult.applied) return;
        }
        notifyAiRewriteStatus('error', 'AI 改写失败', err?.message || '请求未完成', { timeOut: 8000, extendedTimeOut: 16000 });
    } finally {
        rewriteState.pendingKeys.delete(dedupeKey);
        getRunningTaskMetaMap().delete(dedupeKey);
        if (rewriteState.statusDismissedTaskKey === dedupeKey) {
            rewriteState.statusDismissedTaskKey = '';
        }
        if (rewriteState.activeTaskKey === dedupeKey) {
            rewriteState.activeController = null;
            rewriteState.activeTaskKey = '';
            rewriteState.activeTaskMeta = null;
        }
    }
}

export function runAiRewriteForMessageNow(payload, options = {}) {
    return runAiRewriteForMessage(payload, {
        ...options,
        waitForFinalCleanse: false,
        claimRequest: payload?.automatic === true,
    });
}

export function adoptMvuMessageContentForAiRewrite(payload, messageContent) {
    const generationId = String(payload?.generationId || '');
    const parsed = parseStableMessagePayload(payload);
    const { chat } = getAppContext();
    if (!generationId || !parsed.ok || !Array.isArray(chat)) {
        return { ok: false, reason: parsed.reason || 'invalid-mvu-payload' };
    }

    const msg = chat[parsed.messageIndex];
    if (!isAssistantMessage(msg) || typeof msg.mes !== 'string') {
        return { ok: false, reason: 'message-not-assistant' };
    }

    const nextText = String(messageContent ?? '');
    const previousText = msg.mes;
    if (nextText === previousText) return { ok: true, changed: false, reason: '' };

    const identity = getContentIdentity(generationId);
    if (identity) {
        if (identity.messageRef !== msg || identity.messageId !== parsed.messageIndex) {
            return { ok: false, reason: 'generation-message-mismatch' };
        }
    }

    setMessageTextForMvuTransaction(msg, nextText);
    const acknowledgement = generationLifecycle.acknowledgeInternalMessageMutation(generationId, {
        chatId: String(payload?.chatId || ''),
        chat,
        messageId: parsed.messageIndex,
        messageRef: msg,
        beforeText: previousText,
        afterText: nextText,
        source: 'mvu-before-message-update',
    });
    if (!acknowledgement.ok) {
        setMessageTextForMvuTransaction(msg, previousText);
        return acknowledgement;
    }

    recordAiRewriteDebug('mvu-message-content-adopted', {
        generationId,
        chatId: String(payload?.chatId || ''),
        messageId: parsed.messageIndex,
        beforeLength: previousText.length,
        afterLength: nextText.length,
        contentIdentityActive: Boolean(identity),
    });
    return { ok: true, changed: true, reason: '' };
}

export async function waitForAutomaticAiRewrite(generationId) {
    const normalizedGenerationId = String(generationId || '');
    const pending = automaticRunPromiseByGenerationId.get(normalizedGenerationId);
    if (!pending) return null;
    return pending;
}

export function scheduleAiRewriteForMessage(payload, options = {}) {
    const delay = normalizeLimit(options.delayMs, 0, 0, 10000);
    if (payload?.automatic === true) {
        const claim = generationLifecycle.claimRequest(payload.generationId, payload.source || (payload.streamingSnapshot ? 'streaming' : 'final'));
        if (!claim.ok) {
            recordAiRewriteDebug('task-deduped', {
                generationId: String(payload.generationId || ''),
                chatId: String(payload.chatId || ''),
                index: parseStableMessagePayload(payload).messageIndex,
                source: String(payload.source || ''),
                reason: claim.reason,
            });
            if (!String(claim.reason || '').startsWith('request-')) {
                finishAutomaticTaskBeforeRun(payload, `request-claim-${claim.reason}`, 'failed');
            }
            return false;
        }
        const identity = getContentIdentity(payload.generationId);
        recordAiRewriteDebug('request-claimed', {
            task: identity?.taskKey ? hashString(identity.taskKey) : '',
            generationId: String(payload.generationId || ''),
            chatId: String(payload.chatId || ''),
            messageId: parseStableMessagePayload(payload).messageIndex,
            requestState: claim.session.requestState,
            contentSnapshotHash: identity?.requestSnapshotHash || '',
            source: String(payload.source || ''),
        });
    }
    const runScheduledTask = async () => {
        if (payload?.automatic === true) {
            const validation = validateAutomaticAiRewriteContent({
                generationId: String(payload.generationId || ''),
                chatId: String(payload.chatId || ''),
                index: parseStableMessagePayload(payload).messageIndex,
                scheduleSource: String(payload.source || ''),
            }, { source: 'schedule-callback' });
            if (!validation.ok) {
                recordAiRewriteDebug('run-skip', {
                    generationId: String(payload.generationId || ''),
                    reason: validation.reason,
                }, 'warn');
                finishAutomaticTaskBeforeRun(payload, validation.reason, 'stale');
                return;
            }
        }
        return runAiRewriteForMessage(payload, options);
    };
    const generationId = String(payload?.generationId || '');
    const scheduledPromise = new Promise((resolve) => {
        setTimeout(() => resolve(runScheduledTask()), delay);
    });
    if (payload?.automatic === true && generationId) {
        automaticRunPromiseByGenerationId.set(generationId, scheduledPromise);
        const clearScheduledPromise = () => {
            if (automaticRunPromiseByGenerationId.get(generationId) === scheduledPromise) {
                automaticRunPromiseByGenerationId.delete(generationId);
            }
        };
        scheduledPromise.then(clearScheduledPromise, clearScheduledPromise);
    }
    return true;
}

export function requestManualAiRewriteForMessage(payload) {
    const taskCheck = buildAiRewriteTaskCheck(payload, { logTask: true, preferDiffSource: true, manual: true });
    const task = taskCheck.task;
    if (!task) {
        recordAiRewriteDebug('not-sent', { reason: taskCheck.reason || '未满足发送条件', manual: true }, 'warn');
        notifyAiRewriteStatus('error', 'AI 改写未发送', taskCheck.reason || '未满足发送条件', { timeOut: 8000, extendedTimeOut: 16000 });
        return false;
    }

    const rewriteState = runtimeState.aiRewrite;
    if (rewriteState.pendingKeys.has(task.dedupeKey)) {
        if (!rewriteState.statusToast) {
            notifyAiRewriteProgress(task, 1, Math.max(1, groupRewriteItemsByPrompt(task.items, task.aiSettings).length));
        }
        return false;
    }

    const runningTask = findRunningAiRewriteForReadyTask(task);
    if (runningTask) {
        if (!rewriteState.statusToast) {
            notifyAiRewriteProgress(task, 1, Math.max(1, groupRewriteItemsByPrompt(task.items, task.aiSettings).length));
        }
        return false;
    }

    rewriteState.pendingApplyByKey.delete(task.dedupeKey);
    rewriteState.cancelledKeys.delete(task.dedupeKey);
    rewriteState.startedKeys.delete(task.dedupeKey);
    rewriteState.appliedKeys.delete(task.dedupeKey);
    rewriteState.readyNoticeKeys.delete(task.dedupeKey);
    recordAiRewriteDebug('manual-request', {
        task: hashString(task.dedupeKey),
        index: task.index,
        itemCount: task.items.length,
        ruleHitCount: task.ruleHitCount,
    });
    runAiRewriteForMessage(payload, { waitForFinalCleanse: false, preferDiffSource: true, manual: true });
    return true;
}
