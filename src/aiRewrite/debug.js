/**
 * Owns AI rewrite diagnostic storage, export, and logging.
 */
import { extensionName } from '../settings/defaults.js';
import { aiRewriteState } from './state.js';
import { logger } from '../log.js';

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
const debugDisplayLabels = {
    generationId: '生成 ID',
    messageId: '消息 ID',
    requestState: '请求状态',
    source: '来源',
    chatId: '会话 ID',
    validationMode: '校验模式',
    validationReason: '校验原因',
    mode: '模式',
    phase: '阶段',
    reason: '原因',
    status: '状态',
    attempt: '尝试次数',
    task: '任务',
    itemCount: '项目数',
    matchedAiRuleCount: '匹配 AI 规则',
    rawAiMatchCount: 'AI 原始匹配',
    sentenceTargetCount: '句子目标',
    index: '消息 ID',
    changedTargets: '写回目标',
    changedSwipeCount: 'Swipe 修改',
    targetCount: '候选单元格',
    changedCount: '实际修改',
    persistenceTargetCount: '持久化目标',
    newEntryCount: '新增日志项',
    operationKindCounts: '操作类型计数',
    rowUpsertCount: '行写入操作',
    candidateCellCount: '结构候选单元格',
    beforeLength: '修改前长度',
    afterLength: '修改后长度',
    appliedCount: '应用项目',
    skippedCount: '跳过项目',
    result: '结果',
    hasPending: '有等待目标',
    active: '正在处理',
};
const debugStageDisplayLabels = {
    'program-commit': '程序净化完成',
    'apply-success': 'AI 改写完成',
    'shujuku-program-commit': 'Shujuku 净化完成',
    'shujuku-program-check': 'Shujuku 净化检查',
    'shujuku-pending-armed': 'Shujuku 等待目标已建立',
    'shujuku-callback-received': 'Shujuku 更新回调',
};
const debugSourceDisplayLabels = {
    'message-cleanse': '普通消息',
    'manual-recleanse': '手动重净化',
    'ai-finalization': 'AI 终稿内程序净化',
    'ai-fallback': 'AI 回退程序净化',
    'shujuku-auto': '自动回调',
    'shujuku-direct': '直接改写',
};
const compactDebugStageFields = {
    'program-commit': ['source', 'messageId', 'changedTargets', 'changedSwipeCount', 'beforeLength', 'afterLength'],
    'apply-success': ['index', 'appliedCount', 'skippedCount'],
    'shujuku-program-commit': ['source', 'messageId', 'targetCount', 'changedCount'],
    'shujuku-program-check': [
        'source',
        'messageId',
        'persistenceTargetCount',
        'newEntryCount',
        'operationKindCounts',
        'rowUpsertCount',
        'candidateCellCount',
        'targetCount',
        'changedCount',
        'result',
    ],
    'shujuku-pending-armed': ['source', 'messageId'],
    'shujuku-callback-received': ['hasPending', 'active', 'messageId'],
};
const debugResultDisplayLabels = {
    'no-targets': '未取得候选单元格',
    'no-changes': '候选无需修改',
};
const firstDebugDisplayFields = ['generationId', 'messageId', 'requestState', 'source'];
const validationDebugDisplayFields = ['validationMode', 'validationReason'];

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

export function recordAiRewriteDebug(stage, details = {}, level = 'info') {
    const sanitizedDetails = sanitizeDebugValue(details);
    const event = {
        time: new Date().toISOString(),
        stage: String(stage || 'unknown'),
        details: sanitizedDetails,
    };
    const stateEvents = Array.isArray(aiRewriteState.debugEvents)
        ? aiRewriteState.debugEvents
        : [];
    stateEvents.push(event);
    aiRewriteState.debugEvents = stateEvents.slice(-debugLogLimit);
    if (criticalDebugStages.has(event.stage)) {
        const criticalEvents = Array.isArray(aiRewriteState.criticalDebugEvents)
            ? aiRewriteState.criticalDebugEvents
            : [];
        criticalEvents.push(event);
        aiRewriteState.criticalDebugEvents = criticalEvents.slice(-criticalDebugLogLimit);
        const storedCritical = readStoredCriticalDebugEvents();
        storedCritical.push(event);
        writeStoredCriticalDebugEvents(storedCritical);
    }
    const exposedEvents = mergeDebugEvents(
        aiRewriteState.criticalDebugEvents || [],
        aiRewriteState.debugEvents || [],
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
    refreshMountedDebugDisplay(aiRewriteState.debugEvents);
    let summary = '';
    try {
        summary = JSON.stringify(sanitizedDetails);
        if (summary.length > 700) summary = `${summary.slice(0, 700)}...`;
    } catch {
        summary = '';
    }
    const message = `[改写诊断] ${event.stage}${summary ? ` | ${summary}` : ''}`;
    if (level === 'warn') logger.warn(message, event.details);
    else if (level === 'error') logger.error(message, event.details);
    else logger.info(message, event.details);
    return event;
}

export function recordAiRewriteRuntimeDebug(stage, details = {}, level = 'info') {
    return recordAiRewriteDebug(stage, details, level);
}

function getMergedAiRewriteDebugEvents() {
    const combined = mergeDebugEvents(
        readStoredCriticalDebugEvents(),
        aiRewriteState.criticalDebugEvents || [],
        readStoredDebugEvents(),
        aiRewriteState.debugEvents || [],
    );
    const seen = new Set();
    const deduped = combined.filter((event) => {
        const key = `${event.time}|${event.stage}|${JSON.stringify(event.details || {})}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(-(criticalDebugLogLimit + debugLogLimit));
    aiRewriteState.debugEvents = deduped.slice(-debugLogLimit);
    aiRewriteState.criticalDebugEvents = deduped
        .filter(event => criticalDebugStages.has(event.stage))
        .slice(-criticalDebugLogLimit);
    writeStoredDebugEvents(aiRewriteState.debugEvents);
    writeStoredCriticalDebugEvents(aiRewriteState.criticalDebugEvents);
    return deduped;
}

function formatDebugDisplayValue(value, field = '') {
    if (value === '') return '—';
    if (typeof value === 'string') {
        const displayValue = field === 'source'
            ? debugSourceDisplayLabels[value] || value
            : field === 'result'
                ? debugResultDisplayLabels[value] || value
                : value;
        return displayValue.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
    }
    if (typeof value === 'object' && value !== null) return JSON.stringify(value);
    return String(value);
}

function formatDebugDisplayFields(details, fields) {
    return fields
        .filter(field => Object.hasOwn(details, field))
        .map(field => `${debugDisplayLabels[field]}=${formatDebugDisplayValue(details[field], field)}`)
        .join(' | ');
}

function formatDebugDisplayEvent(event) {
    const details = event?.details && typeof event.details === 'object' ? event.details : {};
    const stage = String(event?.stage || '');
    const lines = [`[${String(event?.time || '').replace('T', ' ')}] ${debugStageDisplayLabels[stage] || stage}`];
    const compactFields = compactDebugStageFields[stage];
    if (compactFields) {
        const compactLine = formatDebugDisplayFields(details, compactFields);
        if (compactLine) lines.push(`  ${compactLine}`);
        return lines.join('\n');
    }
    const renderedFields = [...firstDebugDisplayFields, 'chatId', ...validationDebugDisplayFields];
    const firstLine = formatDebugDisplayFields(details, firstDebugDisplayFields);
    const chatLine = formatDebugDisplayFields(details, ['chatId']);
    const validationLine = formatDebugDisplayFields(details, validationDebugDisplayFields);
    const remainingLine = Object.keys(details)
        .filter(field => !renderedFields.includes(field))
        .map(field => `${debugDisplayLabels[field] || field}=${formatDebugDisplayValue(details[field], field)}`)
        .join(' | ');
    [firstLine, chatLine, validationLine, remainingLine].filter(Boolean).forEach(line => lines.push(`  ${line}`));
    return lines.join('\n');
}

function formatDebugDisplayEvents(events) {
    return (Array.isArray(events) ? events : [])
        .slice(-debugLogLimit)
        .reverse()
        .map(formatDebugDisplayEvent)
        .join('\n\n');
}

function refreshMountedDebugDisplay(events) {
    try {
        const element = document?.getElementById?.('blai-ai-debug-log');
        const workspace = element?.closest?.('#blai-feedback-workspace');
        if (workspace?.getAttribute?.('aria-hidden') === 'false'
            && workspace?.dataset?.feedbackView === 'runtime-log') {
            element.textContent = formatDebugDisplayEvents(events);
        }
    } catch {
        // Ignore absent or unavailable DOM; runtime/storage logging still works.
    }
}

export function getAiRewriteDebugDisplayText() {
    return formatDebugDisplayEvents(getMergedAiRewriteDebugEvents());
}

export function getAiRewriteDebugLogText() {
    return JSON.stringify(getMergedAiRewriteDebugEvents(), null, 2);
}

export function getAiRewriteRuntimeLog() {
    return getMergedAiRewriteDebugEvents();
}

export function clearAiRewriteDebugLog() {
    aiRewriteState.debugEvents = [];
    aiRewriteState.criticalDebugEvents = [];
    refreshMountedDebugDisplay([]);
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
