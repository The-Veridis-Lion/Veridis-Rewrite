import { extensionName } from '../settings/defaults.js';
import { formatLocalLogTime } from './logTime.js';
import { renderLogRecords } from '../feedback/logRecords.js';

const maxAiCommunicationRecords = 10;
const redactedCredentialValue = '[REDACTED]';
const communicationStorageKey = `${extensionName}_ai_communication_records`;
const aiCommunicationRecords = readStoredCommunicationRecords();

function readStoredCommunicationRecords() {
    try {
        const records = JSON.parse(globalThis.localStorage?.getItem(communicationStorageKey) || '[]');
        if (!Array.isArray(records)) return [];
        return records.filter(record => record && typeof record.timestamp === 'string'
            && typeof record.requestJson === 'string'
            && (record.status === 'succeeded' && typeof record.response === 'string'
                || record.status === 'failed' && record.error && typeof record.error === 'object'))
            .slice(0, maxAiCommunicationRecords);
    } catch { return []; }
}

function persistCommunicationRecords() {
    // Keep complete requests; if browser quota is tight, evict oldest records first.
    const retained = aiCommunicationRecords.slice();
    while (retained.length) {
        try {
            globalThis.localStorage?.setItem(communicationStorageKey, JSON.stringify(retained));
            return;
        } catch (error) {
            if (error?.name !== 'QuotaExceededError') return;
            retained.pop();
        }
    }
    try { globalThis.localStorage?.removeItem(communicationStorageKey); } catch { /* Storage may be disabled. */ }
}
const recordSeparator = '━━━━━━━━━━━━━━━━━━━━━━━━';

export function snapshotAiCommunicationRequest(requestConfig) {
    const credentialOwner = requestConfig.custom_api;
    return JSON.stringify(requestConfig, function(property, value) {
        if (this === credentialOwner && property === 'key') return redactedCredentialValue;
        if (property === 'custom_include_headers') return redactedCredentialValue;
        return value;
    }, 2);
}

function appendAiCommunicationRecord(record) {
    aiCommunicationRecords.unshift(record);
    if (aiCommunicationRecords.length > maxAiCommunicationRecords) {
        aiCommunicationRecords.length = maxAiCommunicationRecords;
    }
    persistCommunicationRecords();
    if (isAiCommunicationMonitorMounted()) renderAiCommunicationMonitor();
}

export function recordAiCommunicationSuccess({ startedAt, endedAt, requestJson, response, endpoint = 'TavernHelper.generateRaw', context }) {
    appendAiCommunicationRecord({
        context,
        timestamp: new Date(startedAt).toISOString(),
        status: 'succeeded',
        durationMs: endedAt - startedAt,
        tokenUsage: 'unavailable',
        requestJson,
        endpoint,
        response,
    });
}

export function recordAiCommunicationFailure({ startedAt, endedAt, requestJson, error, endpoint = 'TavernHelper.generateRaw', context }) {
    const errorInfo = {
        name: error?.name,
        message: error?.message,
    };
    if (error?.status !== undefined) errorInfo.status = error.status;
    if (error?.code !== undefined) errorInfo.code = error.code;
    appendAiCommunicationRecord({
        context,
        timestamp: new Date(startedAt).toISOString(),
        status: 'failed',
        durationMs: endedAt - startedAt,
        tokenUsage: 'unavailable',
        requestJson,
        endpoint,
        error: errorInfo,
    });
}

export function getAiCommunicationRecords() {
    return aiCommunicationRecords.slice();
}

export function formatAiCommunicationRecords(records = aiCommunicationRecords) {
    if (records.length === 0) return '暂无通信记录。';
    return records.map((record) => {
        const lines = [
            recordSeparator,
            '【AI 请求记录 · 开始】',
            `[请求开始：${formatLocalLogTime(record.timestamp)}]`,
            `状态: ${record.status === 'succeeded' ? '成功' : '失败'}`,
            `耗时: ${record.durationMs} ms`,
            '令牌用量: 不可用',
            '',
            `请求 — Veridis → ${record.endpoint}`,
            record.requestJson,
            '',
        ];
        if (record.status === 'succeeded') {
            lines.push(`返回 — ${record.endpoint} → Veridis`, record.response);
        } else {
            lines.push(
                `错误 — ${record.endpoint} → Veridis`,
                `名称: ${record.error.name ?? '不可用'}`,
                `消息: ${record.error.message ?? '不可用'}`,
            );
            if (record.error.status !== undefined) lines.push(`状态码: ${record.error.status}`);
            if (record.error.code !== undefined) lines.push(`代码: ${record.error.code}`);
        }
        lines.push('', '【本次请求记录 · 结束】', recordSeparator);
        return lines.join('\n');
    }).join('\n\n');
}

export function getAiCommunicationDisplayGroups() {
    const groups = new Map();
    for (const record of aiCommunicationRecords) {
        const context = record.context;
        // Legacy records have no task identity: keep each request independently copyable.
        const key = context?.startedAtMs ? JSON.stringify(context) : record;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(record);
    }
    return [...groups.values()].map(records => ({
        title: `AI 改写记录 · ${records[0].context?.generationId || '请求'} · ${formatLocalLogTime(records.at(-1).timestamp)}`,
        text: formatAiCommunicationRecords(records),
    }));
}

export function renderAiCommunicationMonitor(documentRef = globalThis.document) {
    const output = documentRef?.getElementById?.('blai-ai-monitor-output');
    if (output) renderLogRecords(output, getAiCommunicationDisplayGroups(), '暂无通信记录。');
}

export function clearAiCommunicationRecords() {
    aiCommunicationRecords.length = 0;
    persistCommunicationRecords();
    if (isAiCommunicationMonitorMounted()) renderAiCommunicationMonitor();
}

export function isAiCommunicationMonitorMounted(documentRef = globalThis.document) {
    const workspace = documentRef?.getElementById?.('blai-feedback-workspace');
    return workspace?.getAttribute?.('aria-hidden') === 'false'
        && workspace?.dataset?.feedbackView === 'ai-context'
        && Boolean(documentRef.getElementById('blai-ai-monitor-output'));
}
