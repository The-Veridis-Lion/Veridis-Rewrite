import { defaultAiRewriteSettings, extensionName, getAppContext, runtimeState } from './state.js';
import { logger } from './log.js';
import {
    applyScopedReplacements,
    buildSimpleTargetPattern,
    buildTargetLiteralPattern,
    queueIncrementalChatSave,
    preserveMvuStatusPlaceholder,
    refreshMessageDisplay,
    resolveLatestTrackableMessageIndex,
    resolveMessageDiffSource,
    syncMessageDiffMetadata,
} from './core.js';
import { compileRegexTarget, mergeScopeTagsWithBuiltins, normalizeXmlTagNameInput } from './utils.js';
import { getZhVariantCompatOptions, isZhDictionaryReady } from './zhConversion.js';
import { buildDiffResultFromChain, ensureMessageDiffButton, isAssistantMessage, writeReadyDiffCache } from './diff.js';
import { getMessageDomNode, purifyDOM } from './dom.js';
import { getMessageDiffBranchKey, setCurrentSwipeText, writeMessageDiffAiTrace } from './messageMeta.js';
import { markHostChatDirtyFromIndex } from './platform.js';
import { showToast } from './ui.js';

const responseGuard = `必须只返回一个 JSON 对象，格式为 {"rewrites":[{"id":"hit-1","rewritten":"..."}]}。
不要返回 markdown、解释、多个 JSON 对象、整条消息改写或未列出的片段。
每个 rewritten 只能替换对应 id 的局部片段，不能包含代码块围栏或 JSON 包装。
输出 rewrites[].id 必须来自 rewriteGroups[].items[].id。
每个 rewriteGroups[].instructions 只能作用于同组 items。`;

let readyNoticeTimer = null;
const debugLogStorageKey = `${extensionName}_ai_rewrite_debug_events`;
const debugLogDomAttribute = 'data-veridis-ai-rewrite-debug-events';
const debugLogLimit = 60;
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

function writeStoredDebugEvents(events) {
    try {
        localStorage.setItem(debugLogStorageKey, JSON.stringify(events.slice(-debugLogLimit)));
    } catch {
        // Ignore storage failures; console/runtime logs still work.
    }
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
    try {
        globalThis.__veridisAiRewriteLog = runtimeState.aiRewrite.debugEvents;
    } catch {
        // Ignore global exposure failures.
    }
    try {
        document?.documentElement?.setAttribute?.(debugLogDomAttribute, JSON.stringify(runtimeState.aiRewrite.debugEvents));
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
    const combined = [...readStoredDebugEvents(), ...(runtimeState.aiRewrite.debugEvents || [])];
    const seen = new Set();
    const deduped = combined.filter((event) => {
        const key = `${event.time}|${event.stage}|${JSON.stringify(event.details || {})}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(-debugLogLimit);
    runtimeState.aiRewrite.debugEvents = deduped;
    writeStoredDebugEvents(deduped);
    return JSON.stringify(deduped, null, 2);
}

export function clearAiRewriteDebugLog() {
    runtimeState.aiRewrite.debugEvents = [];
    try {
        localStorage.removeItem(debugLogStorageKey);
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

function clearAiRewriteStatusToast(extraToastElement = null) {
    const rewriteState = runtimeState.aiRewrite;
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
        if (options.replaceCurrent !== false) clearAiRewriteStatusToast();
        const sticky = options.sticky === true;
        const toast = toastApi[method](safeMessage, safeTitle, {
            timeOut: sticky ? 0 : (options.timeOut ?? 5000),
            extendedTimeOut: sticky ? 0 : (options.extendedTimeOut ?? 10000),
            tapToDismiss: sticky ? false : (options.tapToDismiss ?? true),
            closeButton: options.closeButton ?? !sticky,
            preventDuplicates: false,
            escapeHtml: true,
        });
        runtimeState.aiRewrite.statusToast = sticky ? toast : null;
        runtimeState.aiRewrite.statusTaskKey = sticky ? String(options.taskKey || '') : '';
        if (sticky && options.cancellable === true) {
            attachAiRewriteTerminateAction(toast, runtimeState.aiRewrite.statusTaskKey);
        }
        return;
    }

    showToast(`${safeTitle}${safeMessage ? `：${stripStatusText(safeMessage)}` : ''}`);
}

function getAiXmlScopeTag(aiSettings) {
    const tagName = normalizeXmlTagNameInput(aiSettings?.xmlScopeTag, 'content');
    return {
        tagName,
        startTag: `<${tagName}>`,
        endTag: `</${tagName}>`,
    };
}

function escapeRegExp(value = '') {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectAiXmlScopeSegments(text, aiSettings) {
    const source = String(text || '');
    const { tagName } = getAiXmlScopeTag(aiSettings);
    const escapedTagName = escapeRegExp(tagName);
    const startRegex = new RegExp(`<\\s*${escapedTagName}(?:\\s+[^<>]*)?\\s*>`, 'giu');
    const endRegex = new RegExp(`<\\s*/\\s*${escapedTagName}\\s*>`, 'giu');
    const segments = [];
    let startMatch;

    while ((startMatch = startRegex.exec(source)) !== null) {
        const bodyStart = startRegex.lastIndex;
        endRegex.lastIndex = bodyStart;

        const endMatch = endRegex.exec(source);
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

    const cutoff = segments.reduce((maxEnd, segment) => Math.max(maxEnd, Number(segment.outerEnd) || segment.end), 0);
    return cutoff > 0 ? source.slice(0, cutoff) : source;
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
            timeoutMs: aiSettings.timeoutMs,
            maxItemsPerRequest: aiSettings.maxItemsPerRequest,
            maxContextChars: aiSettings.maxContextChars,
            maxRewriteCharsPerItem: aiSettings.maxRewriteCharsPerItem,
            streamingRoughPreview: aiSettings.streamingRoughPreview !== false,
            xmlScopeTag: normalizeXmlTagNameInput(aiSettings.xmlScopeTag, 'content'),
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

function redactProtectedScopeBodies(text, settings) {
    if (settings.scopeTagMode === 'cleanse-inside') return text;
    const ranges = collectScopeRanges(text, settings);
    if (ranges.length === 0) return text;

    let output = '';
    let cursor = 0;
    ranges.forEach((range) => {
        output += text.slice(cursor, range.bodyStart);
        output += '[已保护内容]';
        output += text.slice(range.bodyEnd, range.end);
        cursor = range.end;
    });
    output += text.slice(cursor);
    return output;
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
                if (!rangeOverlapsAny(start, end, codeRanges)) {
                    matches.push({
                        ...matcher,
                        matchedText,
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

function formatAiRewriteProgress(task, suffix) {
    return `AI规则命中 ${task.ruleHitCount} 条，待改写 ${task.items.length} 段，${suffix}`;
}

function getAiRewriteMessageKey(index, branchKey = 'main') {
    return `${Number(index)}:${String(branchKey || 'main')}`;
}

function getTaskMessageKey(task) {
    return getAiRewriteMessageKey(task.index, task.branchKey);
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

function expandToParagraph(text, start, end, segment) {
    let paraStart = start;
    while (paraStart > segment.start) {
        const previous = text.slice(Math.max(segment.start, paraStart - 2), paraStart);
        if (/\n\s*\n$/.test(previous)) break;
        paraStart -= 1;
    }

    let paraEnd = end;
    while (paraEnd < segment.end) {
        const next = text.slice(paraEnd, Math.min(segment.end, paraEnd + 2));
        if (/^\n\s*\n/.test(next)) break;
        paraEnd += 1;
    }

    return { start: paraStart, end: paraEnd };
}

function expandToSentence(text, start, end, paragraph) {
    const boundaryRegex = /[。！？!?;；]/g;
    let sentenceStart = paragraph.start;
    let match;
    const before = text.slice(paragraph.start, start);
    while ((match = boundaryRegex.exec(before)) !== null) {
        sentenceStart = paragraph.start + match.index + match[0].length;
    }
    while (sentenceStart < start && /[\s"'“”‘’)\]）】》>]/.test(text[sentenceStart] || '')) sentenceStart += 1;

    let sentenceEnd = paragraph.end;
    const after = text.slice(end, paragraph.end);
    const nextBoundary = after.search(/[。！？!?;；]/);
    if (nextBoundary >= 0) {
        sentenceEnd = end + nextBoundary + 1;
        while (sentenceEnd < paragraph.end && /["'“”‘’)\]）】》>]/.test(text[sentenceEnd] || '')) sentenceEnd += 1;
    }

    const candidate = { start: sentenceStart, end: sentenceEnd };
    const tooShort = candidate.end - candidate.start < Math.max(12, end - start + 4);
    return tooShort ? paragraph : candidate;
}

function buildRewriteItems(text, matches, aiSettings) {
    if (matches.length === 0) return [];
    const segments = collectAiXmlScopeSegments(text, aiSettings);
    const codeRanges = collectCodeRanges(text);
    const maxItems = normalizeLimit(aiSettings.maxItemsPerRequest, 8, 1, 32);
    const fragments = [];

    matches.forEach((match) => {
        const segment = findContainingSegment(match, segments);
        if (!segment || segment.end <= segment.start) return;
        const paragraph = expandToParagraph(text, match.start, match.end, segment);
        const sentence = expandToSentence(text, match.start, match.end, paragraph);
        const range = rangeOverlapsAny(sentence.start, sentence.end, codeRanges) ? paragraph : sentence;
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

    return merged.slice(0, maxItems).map((fragment, index) => {
        const localFallbackCandidates = [...new Set(fragment.matches.flatMap((match) => match.replacements || []).filter((value) => value !== undefined).map(String))];
        const matchedTerms = [...new Set(fragment.matches.map((match) => match.matchedText).filter(Boolean))];
        return {
            id: `hit-${index + 1}`,
            segmentIndex: fragment.segmentIndex,
            start: fragment.start,
            end: fragment.end,
            relativeStart: fragment.start - fragment.segmentStart,
            relativeEnd: fragment.end - fragment.segmentStart,
            text: text.slice(fragment.start, fragment.end),
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

function clipContextAroundItems(text, items, maxContextChars) {
    const limit = normalizeLimit(maxContextChars, 12000, 1000, 60000);
    if (text.length <= limit) return text;
    if (!items.length) return `${text.slice(0, limit)}\n...[后文已省略]`;

    const minStart = Math.min(...items.map((item) => item.start));
    const maxEnd = Math.max(...items.map((item) => item.end));
    const spanLength = maxEnd - minStart;
    const padding = Math.max(0, Math.floor((limit - spanLength) / 2));
    const start = Math.max(0, minStart - padding);
    const end = Math.min(text.length, start + limit);
    return `${start > 0 ? '[前文已省略]\n' : ''}${text.slice(start, end)}${end < text.length ? '\n[后文已省略]' : ''}`;
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

function buildPublicRewriteGroups(items) {
    const groups = [];
    const groupByKey = new Map();

    items.forEach((item) => {
        const instructions = getItemRewriteInstructions(item);
        const localFallbackCandidates = normalizeStringList(item.localFallbackCandidates);
        const key = JSON.stringify({ instructions, localFallbackCandidates });
        let group = groupByKey.get(key);

        if (!group) {
            group = {
                instructions,
                localFallbackCandidates,
                items: [],
            };
            groupByKey.set(key, group);
            groups.push(group);
        }

        group.items.push({
            id: item.id,
            text: item.text,
            matchedTerms: item.matchedTerms,
        });
    });

    return groups;
}

function groupRewriteItemsByPrompt(items, aiSettings) {
    return [{
        key: 'all-items',
        promptTemplate: getGlobalPromptTemplate(aiSettings),
        items,
    }];
}

function renderPrompt(originalText, items, settings, aiSettings, promptTemplate = getGlobalPromptTemplate(aiSettings)) {
    const redactedContext = redactProtectedScopeBodies(originalText, settings);
    const clippedContext = clipContextAroundItems(redactedContext, items, aiSettings.maxContextChars);
    const rewriteItemsJson = JSON.stringify({ rewriteGroups: buildPublicRewriteGroups(items) }, null, 2);
    const template = String(promptTemplate || '')
        .replaceAll('{{originalMessage}}', clippedContext)
        .replaceAll('{{rewriteItemsJson}}', rewriteItemsJson);
    const rendered = template.includes(clippedContext) || template.includes(rewriteItemsJson)
        ? template
        : `${template}\n\n整条回复：\n${clippedContext}\n\n需要改写的分组与片段：\n${rewriteItemsJson}`;
    return `${rendered}\n\n${responseGuard}`;
}

function buildChatCompletionsEndpoint(baseUrl) {
    const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
    return `${trimmed}/chat/completions`;
}

function stripSingleJsonFence(value) {
    const trimmed = String(value || '').trim();
    const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function parseAiResponse(rawText, itemById, aiSettings) {
    const candidate = stripSingleJsonFence(rawText);
    if (!/^\{[\s\S]*\}$/.test(candidate)) {
        recordAiRewriteDebug('parse-failed', {
            reason: 'not-json-object',
            rawLength: String(rawText || '').length,
            preview: String(rawText || '').slice(0, 300),
        }, 'warn');
        throw new Error('API 返回不是单个 JSON 对象');
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
        throw error;
    }
    if (!parsed || !Array.isArray(parsed.rewrites)) {
        recordAiRewriteDebug('parse-failed', {
            reason: 'missing-rewrites',
            keys: parsed && typeof parsed === 'object' ? Object.keys(parsed).slice(0, 20) : [],
        }, 'warn');
        throw new Error('API 返回缺少 rewrites 数组');
    }

    const maxChars = normalizeLimit(aiSettings.maxRewriteCharsPerItem, 2000, 50, 10000);
    const accepted = new Map();
    let rejectedCount = 0;
    parsed.rewrites.forEach((entry) => {
        const id = String(entry?.id || '');
        const rewritten = typeof entry?.rewritten === 'string' ? entry.rewritten : '';
        if (!itemById.has(id)) { rejectedCount++; return; }
        if (!rewritten.trim()) { rejectedCount++; return; }
        if (rewritten.length > maxChars) { rejectedCount++; return; }
        if (/```/.test(rewritten)) { rejectedCount++; return; }
        if (/^\s*[\[{][\s\S]*[\]}]\s*$/.test(rewritten)) { rejectedCount++; return; }
        accepted.set(id, rewritten);
    });
    recordAiRewriteDebug('parse-result', {
        returnedCount: parsed.rewrites.length,
        acceptedCount: accepted.size,
        rejectedCount,
    }, accepted.size > 0 ? 'info' : 'warn');
    return accepted;
}

function getTaskFreshnessIssue(task) {
    rebindStreamingTaskBranchIfStable(task);
    const { chat } = getAppContext();
    const settings = getSettings();
    const msg = Array.isArray(chat) ? chat[task.index] : null;
    if (msg !== task.messageRef) return 'message-ref-changed';
    if (!isAssistantMessage(msg)) return 'not-assistant-message';
    if (msg?.__blai_is_reverted) return 'message-reverted';
    if (getMessageDiffBranchKey(msg) !== task.branchKey) return 'branch-changed';
    if (typeof msg.mes !== 'string') return 'message-text-missing';
    if (buildAiRewriteVersionToken(settings) !== task.versionToken) return 'settings-version-changed';
    return '';
}

function isTaskStillFresh(task) {
    return !getTaskFreshnessIssue(task);
}

function getItemSearchNeedles(item) {
    const values = [String(item?.text || '')];
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

function applyAcceptedRewrites(task, accepted) {
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
        const rewritten = accepted.get(item.id);
        if (!rewritten) continue;
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

    nextText = applyScopedReplacements(nextText, { deterministic: true });
    nextText = preserveMvuStatusPlaceholder(nextText, msg, [currentText, currentSourceText, task.snapshotText]);
    if (nextText === currentText) {
        recordAiRewriteDebug('apply-skip', { reason: 'no-text-change', task: hashString(task.dedupeKey) }, 'warn');
        return { appliedCount: 0, skippedCount: skippedIds.length, reason: 'no-text-change' };
    }

    msg.mes = nextText;
    setCurrentSwipeText(msg, nextText);
    const nextSourceText = preserveMvuStatusPlaceholder(currentSourceText, msg, [currentText, nextText, task.snapshotText]);
    const { signature } = syncMessageDiffMetadata(msg, nextSourceText, nextText);
    writeMessageDiffAiTrace(msg, task.branchKey, currentText, nextText);
    const diffResult = buildDiffResultFromChain(nextSourceText, currentText, nextText);
    writeReadyDiffCache(task.index, signature, {
        snippets: diffResult.snippets,
        fullDiff: diffResult.fullDiff,
        signature,
    }, {
        preserveExistingRealDiff: true,
        persist: true,
    });

    markHostChatDirtyFromIndex(task.index);
    const messageNode = getMessageDomNode(task.index);
    if (messageNode) {
        purifyDOM(messageNode);
        ensureMessageDiffButton(task.index, messageNode);
    }
    refreshMessageDisplay(task.index, { emitRenderedEvent: 'auto' });
    queueIncrementalChatSave();
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
        notifyAiRewriteStatus('success', 'AI 改写成功', 'AI返回 0 段可应用改写', { timeOut: 5000 });
        return { status: 'empty', applyResult };
    }
    if (applyResult.reason === 'item-locate-failed') {
        recordAiRewriteDebug('run-apply-failed', {
            task: hashString(task.dedupeKey),
            reason: applyResult.reason,
            skippedCount: applyResult.skippedCount || 0,
        }, 'warn');
        notifyAiRewriteStatus('error', 'AI 改写失败', '未能在当前 XML 内容中定位命中片段，未写回', { timeOut: 8000, extendedTimeOut: 16000 });
        return { status: 'apply-failed', applyResult };
    }

    recordAiRewriteDebug('run-no-change', {
        task: hashString(task.dedupeKey),
        acceptedCount: accepted.size,
        reason: applyResult.reason || '',
    }, 'warn');
    notifyAiRewriteStatus('success', 'AI 改写成功', '没有新的文本变更需要写入', { timeOut: 5000 });
    return { status: 'no-change', applyResult };
}

function deferAiRewriteApplyUntilFinalCleanse(task, accepted) {
    const rewriteState = runtimeState.aiRewrite;
    rewriteState.pendingApplyByKey.set(task.dedupeKey, {
        task,
        accepted: new Map(accepted),
    });
    recordAiRewriteDebug('apply-deferred', {
        task: hashString(task.dedupeKey),
        index: task.index,
        finalCleanseSequence: task.finalCleanseSequence,
        pendingApplyCount: rewriteState.pendingApplyByKey.size,
    });
    notifyAiRewriteStatus('info', 'AI 改写中', formatAiRewriteProgress(task, 'AI已返回，等待最终净化后写回...'), {
        sticky: true,
        cancellable: true,
        taskKey: task.dedupeKey,
    });
    return { status: 'deferred' };
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

function flushPendingAiRewriteApplyForMessageKey(messageKey) {
    const rewriteState = runtimeState.aiRewrite;
    const entries = [...rewriteState.pendingApplyByKey.entries()]
        .filter(([, entry]) => getTaskMessageKey(entry.task) === messageKey);
    entries.forEach(([dedupeKey, entry]) => {
        rewriteState.pendingApplyByKey.delete(dedupeKey);
        if (rewriteState.cancelledKeys.has(dedupeKey)) return;
        recordAiRewriteDebug('apply-flush', {
            task: hashString(dedupeKey),
            index: entry.task.index,
            finalCleanseSequence: rewriteState.finalCleanseSequence,
        });
        finishAiRewriteApply(entry.task, entry.accepted);
    });
    return entries.length;
}

export function markAiRewriteFinalCleanseReady(payload, options = {}) {
    const { chat } = getAppContext();
    const index = resolveLatestTrackableMessageIndex(payload);
    if (!Array.isArray(chat) || index < 0 || !isAssistantMessage(chat[index])) return;

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
    });
    const flushedCount = flushPendingAiRewriteApplyForMessageKey(messageKey);
    if (options.scheduleRequest !== false && flushedCount === 0) {
        const readyTask = buildReadyAiRewriteTask(payload);
        const runningTask = findRunningAiRewriteForReadyTask(readyTask);
        if (runningTask) {
            recordAiRewriteDebug('final-cleanse-skip-request', {
                index,
                branchKey,
                reason: 'same-streaming-task-running',
                runningTask: hashString(runningTask.dedupeKey),
                runningSource: runningTask.meta?.source || '',
            });
            return;
        }
        scheduleAiRewriteForMessage(payload, { delayMs: 0 });
    }
}

async function requestAiRewrite(prompt, aiSettings, signal) {
    const endpoint = buildChatCompletionsEndpoint(aiSettings.baseUrl);
    const startedAt = Date.now();
    recordAiRewriteDebug('fetch-start', {
        endpoint,
        model: aiSettings.model,
        promptLength: String(prompt || '').length,
        timeoutMs: aiSettings.timeoutMs,
    });
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${aiSettings.apiKey}`,
        },
        body: JSON.stringify({
            model: aiSettings.model,
            temperature: Number(aiSettings.temperature),
            messages: [{ role: 'user', content: prompt }],
            stream: false,
        }),
        signal,
    });
    const responseText = await response.text();
    recordAiRewriteDebug('fetch-response', {
        endpoint,
        status: response.status,
        ok: response.ok,
        elapsedMs: Date.now() - startedAt,
        responseLength: responseText.length,
        responsePreview: response.ok ? '' : responseText.slice(0, 300),
    }, response.ok ? 'info' : 'warn');
    if (!response.ok) throw new Error(`API 返回 HTTP ${response.status}`);
    let payload;
    try {
        payload = JSON.parse(responseText);
    } catch (error) {
        recordAiRewriteDebug('response-json-failed', {
            error: error?.message || String(error),
            responsePreview: responseText.slice(0, 300),
        }, 'warn');
        throw new Error('API 返回不是 JSON');
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('API 返回缺少 message.content');
    recordAiRewriteDebug('response-content', {
        contentLength: content.length,
        choiceCount: Array.isArray(payload?.choices) ? payload.choices.length : 0,
    });
    return content;
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

export function handleAiRewriteGenerationStarted() {
    streamingXmlScanByMessageId.clear();
    const state = runtimeState.aiRewrite;
    if (state?.activeController) {
        recordAiRewriteDebug('generation-started-ignored', {
            task: hashString(state.activeTaskKey),
            reason: 'active-ai-request',
        });
        return;
    }
    cancelAiRewriteTask('generation-started');
}

export function resetAiRewriteRuntimeState(reason = 'reset') {
    cancelAiRewriteTask(reason);
    clearAiRewriteStatusToast();
    if (readyNoticeTimer) {
        clearTimeout(readyNoticeTimer);
        readyNoticeTimer = null;
    }
    const state = runtimeState.aiRewrite;
    streamingXmlScanByMessageId.clear();
    state.pendingKeys.clear();
    state.startedKeys.clear();
    state.appliedKeys.clear();
    state.cancelledKeys.clear();
    state.readyNoticeKeys.clear();
    getRunningTaskMetaMap().clear();
    state.finalCleanseSequence = 0;
    state.finalCleanseByMessageKey.clear();
    state.pendingApplyByKey.clear();
}

function buildAiRewriteTaskCheck(payload, options = {}) {
    const settings = getSettings();
    const aiSettings = getAiSettings();
    if (aiSettings.enabled !== true) return { task: null, reason: 'AI改写未启用' };
    const missingConfig = [];
    if (!String(aiSettings.baseUrl || '').trim()) missingConfig.push('Base URL');
    if (!String(aiSettings.apiKey || '')) missingConfig.push('API Key');
    if (!String(aiSettings.model || '').trim()) missingConfig.push('模型');
    if (missingConfig.length > 0) {
        return { task: null, reason: `AI API配置不完整：缺少 ${missingConfig.join('、')}` };
    }

    const { chat } = getAppContext();
    const index = resolveLatestTrackableMessageIndex(payload);
    if (!Array.isArray(chat) || index < 0 || index >= chat.length) {
        return { task: null, reason: '未找到可改写的助手消息' };
    }

    const msg = chat[index];
    if (!isAssistantMessage(msg)) return { task: null, reason: '目标消息不是助手消息' };
    if (msg?.__blai_is_reverted) return { task: null, reason: '目标消息已撤回净化' };
    const rawSnapshotText = payload && typeof payload === 'object' && typeof payload.snapshotText === 'string'
        ? payload.snapshotText
        : '';
    const rawSourceText = rawSnapshotText || (typeof msg.mes === 'string' ? msg.mes : '');
    const sourceText = getAiXmlScopedRequestText(rawSourceText, aiSettings);
    if (typeof sourceText !== 'string' || !sourceText.trim()) return { task: null, reason: '目标消息为空' };

    const { tagName } = getAiXmlScopeTag(aiSettings);
    const segments = collectAiXmlScopeSegments(sourceText, aiSettings);
    if (segments.length === 0) {
        return { task: null, reason: `未找到完整 <${tagName}>...</${tagName}>` };
    }

    const matches = collectAiMatches(sourceText, settings, aiSettings);
    if (matches.length === 0) {
        return { task: null, reason: `<${tagName}> 内未命中 AI 改写规则` };
    }

    const items = buildRewriteItems(sourceText, matches, aiSettings);
    if (items.length === 0) {
        return { task: null, reason: '命中内容没有可改写片段' };
    }

    const versionToken = buildAiRewriteVersionToken(settings);
    const dedupeKey = buildDedupeKey(index, msg, settings, versionToken, aiSettings, sourceText);
    if (options.logTask === true) {
        recordAiRewriteDebug('task-ready', {
            task: hashString(dedupeKey),
            index,
            branchKey: getMessageDiffBranchKey(msg),
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
        });
    }
    return {
        task: { settings, aiSettings, index, msg, snapshotText: sourceText, items, ruleHitCount: countMatchedAiRules(matches), versionToken, dedupeKey },
        reason: '',
    };
}

function buildReadyAiRewriteTask(payload) {
    return buildAiRewriteTaskCheck(payload).task;
}

function notifyAiRewriteNotSent(reason) {
    const message = String(reason || '未满足发送条件');
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
    recordAiRewriteDebug('xml-ready-request', {
        task: hashString(task.dedupeKey),
        index: task.index,
        ruleHitCount: task.ruleHitCount,
        itemCount: task.items.length,
        itemLengths: task.items.map(item => item.text.length),
    });
    notifyAiRewriteStatus('info', 'AI 改写中', formatAiRewriteProgress(task, '正在请求AI，返回后等待最终净化写回...'), { sticky: true, cancellable: true, taskKey: task.dedupeKey });
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

export function maybeNotifyAiRewriteReadyFromStreamingText(messageId, text) {
    const index = Number(messageId);
    if (!Number.isInteger(index) || index < 0) return;
    const sourceText = typeof text === 'string' ? text : String(text ?? '');
    if (!sourceText) return;

    const aiSettings = getAiSettings();
    if (aiSettings.enabled !== true) return;
    const { tagName } = getAiXmlScopeTag(aiSettings);
    const scanKey = `${index}:${tagName}`;
    const scanState = streamingXmlScanByMessageId.get(scanKey) || { checkedLength: 0, closedSeen: false };
    if (scanState.closedSeen === true) return;

    const previousLength = Number(scanState.checkedLength) || 0;
    const stablePreviousLength = sourceText.length < previousLength ? 0 : previousLength;
    const scanStart = Math.max(0, stablePreviousLength - streamingXmlTailLookbackChars);
    const scanText = sourceText.slice(scanStart);
    scanState.checkedLength = sourceText.length;

    const endTagRegex = new RegExp(`<\\s*/\\s*${escapeRegExp(tagName)}\\s*>`, 'iu');
    if (!endTagRegex.test(scanText)) {
        streamingXmlScanByMessageId.set(scanKey, scanState);
        return;
    }

    scanState.closedSeen = true;
    streamingXmlScanByMessageId.set(scanKey, scanState);
    recordAiRewriteDebug('streaming-xml-end-detected', {
        index,
        xmlTag: tagName,
        sourceLength: sourceText.length,
        scanStart,
    });
    notifyAiRewriteReadyForMessage({
        messageId: index,
        snapshotText: getAiXmlScopedRequestText(sourceText, aiSettings),
        streamingSnapshot: true,
    });
}

async function requestAcceptedRewritesOnce(task, rewriteState, attempt, maxAttempts, accepted, completedGroupKeys) {
    if (attempt === 1 && !rewriteState.readyNoticeKeys.has(task.dedupeKey)) {
        notifyAiRewriteStatus('info', 'AI 改写中', formatAiRewriteProgress(task, '正在改写...'), { sticky: true, cancellable: true, taskKey: task.dedupeKey });
    }

    const timeoutMs = normalizeLimit(task.aiSettings.timeoutMs, defaultAiRewriteSettings.timeoutMs, 1000, 120000);
    for (const group of groupRewriteItemsByPrompt(task.items, task.aiSettings)) {
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

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort('timeout'), timeoutMs);
        rewriteState.activeController = controller;
        rewriteState.activeTaskKey = task.dedupeKey;
        rewriteState.activeTaskMeta = {
            index: task.index,
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
            const rawResponse = await requestAiRewrite(prompt, task.aiSettings, controller.signal);
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
    const waitForFinalCleanse = typeof options.waitForFinalCleanse === 'boolean'
        ? options.waitForFinalCleanse
        : runtimeState.isStreamingGeneration === true;
    if (waitForFinalCleanse === true) {
        logger.info('AI 改写在 XML 闭合后提前请求，返回后等待最终净化再写回');
    }
    const taskCheck = buildAiRewriteTaskCheck(payload, { logTask: true });
    const readyTask = taskCheck.task;
    if (!readyTask) {
        notifyAiRewriteNotSent(taskCheck.reason);
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

    if (rewriteState.activeController && rewriteState.activeTaskKey !== dedupeKey) cancelAiRewriteTask('superseded');

    const branchKey = getMessageDiffBranchKey(msg);
    rewriteState.startedKeys.add(dedupeKey);
    rewriteState.pendingKeys.add(dedupeKey);
    recordAiRewriteDebug('run-start', {
        task: hashString(dedupeKey),
        index,
        branchKey,
        itemCount: items.length,
        ruleHitCount: readyTask.ruleHitCount,
        model: aiSettings.model,
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
    };
    getRunningTaskMetaMap().set(dedupeKey, {
        index: task.index,
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
                    if (!rewriteState.cancelledKeys.has(dedupeKey)) {
                        recordAiRewriteDebug('run-cancelled', { task: hashString(dedupeKey), reason: 'request-cancelled' }, 'warn');
                        notifyAiRewriteStatus('error', 'AI 改写失败', '请求已取消，未写回', { timeOut: 8000, extendedTimeOut: 16000 });
                    }
                    return;
                }
                if (result?.stale) {
                    recordAiRewriteDebug('run-stale', { task: hashString(dedupeKey), reason: getTaskFreshnessIssue(task) || 'stale' }, 'warn');
                    notifyAiRewriteStatus('error', 'AI 改写失败', '消息已变化，未写回', { timeOut: 8000, extendedTimeOut: 16000 });
                    return;
                }
                break;
            } catch (err) {
                if (rewriteState.cancelledKeys.has(dedupeKey)) return;
                if (attempt >= maxAttempts || !isTaskStillFresh(task)) throw err;
                recordAiRewriteDebug('retry', {
                    task: hashString(dedupeKey),
                    nextAttempt: attempt + 1,
                    maxAttempts,
                    reason: err?.message || '请求未完成',
                }, 'warn');
                notifyAiRewriteStatus('warning', 'AI 改写失败', `自动重试 ${attempt + 1}/${maxAttempts}：${err?.message || '请求未完成'}`, { sticky: true, cancellable: true, taskKey: dedupeKey });
            }
        }

        if (rewriteState.cancelledKeys.has(dedupeKey)) return;
        finishOrDeferAiRewriteApply(task, accepted);
    } catch (err) {
        logger.warn('AI 改写失败', err);
        recordAiRewriteDebug('run-error', { task: hashString(dedupeKey), reason: err?.message || '请求未完成' }, 'warn');
        notifyAiRewriteStatus('error', 'AI 改写失败', err?.message || '请求未完成', { timeOut: 8000, extendedTimeOut: 16000 });
    } finally {
        rewriteState.pendingKeys.delete(dedupeKey);
        getRunningTaskMetaMap().delete(dedupeKey);
        if (rewriteState.activeTaskKey === dedupeKey) {
            rewriteState.activeController = null;
            rewriteState.activeTaskKey = '';
            rewriteState.activeTaskMeta = null;
        }
    }
}

export function scheduleAiRewriteForMessage(payload, options = {}) {
    const delay = normalizeLimit(options.delayMs, 0, 0, 10000);
    setTimeout(() => {
        runAiRewriteForMessage(payload, options);
    }, delay);
}

export function requestManualAiRewriteForMessage(payload) {
    const taskCheck = buildAiRewriteTaskCheck(payload, { logTask: true });
    const task = taskCheck.task;
    if (!task) {
        notifyAiRewriteStatus('error', 'AI 改写未发送', taskCheck.reason || '未满足发送条件', { timeOut: 8000, extendedTimeOut: 16000 });
        return false;
    }

    const rewriteState = runtimeState.aiRewrite;
    if (rewriteState.pendingKeys.has(task.dedupeKey)) {
        notifyAiRewriteStatus('info', 'AI 改写中', '当前消息已有 AI 改写任务在进行中', { sticky: true, cancellable: true, taskKey: task.dedupeKey });
        return false;
    }

    const runningTask = findRunningAiRewriteForReadyTask(task);
    if (runningTask) {
        notifyAiRewriteStatus('info', 'AI 改写中', '当前消息已有 AI 改写任务在进行中', { sticky: true, cancellable: true, taskKey: runningTask.dedupeKey });
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
    runAiRewriteForMessage(payload, { waitForFinalCleanse: false });
    return true;
}
