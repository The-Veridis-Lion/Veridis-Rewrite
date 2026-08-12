/**
 * Owns AI rewrite diagnostic storage, export, and logging.
 */
import { extensionName, runtimeState } from '../state.js';
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
