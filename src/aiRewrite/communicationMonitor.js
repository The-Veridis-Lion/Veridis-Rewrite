const maxAiCommunicationRecords = 10;
const redactedCredentialValue = '[REDACTED]';
const aiCommunicationRecords = [];
const recordSeparator = '='.repeat(80);

export function snapshotAiCommunicationRequest(requestConfig) {
    const credentialOwner = requestConfig.custom_api;
    return JSON.stringify(requestConfig, function(property, value) {
        if (this === credentialOwner && property === 'key') return redactedCredentialValue;
        return value;
    }, 2);
}

function appendAiCommunicationRecord(record) {
    aiCommunicationRecords.unshift(record);
    if (aiCommunicationRecords.length > maxAiCommunicationRecords) {
        aiCommunicationRecords.length = maxAiCommunicationRecords;
    }
    if (isAiCommunicationMonitorMounted()) renderAiCommunicationMonitor();
}

export function recordAiCommunicationSuccess({ startedAt, endedAt, requestJson, response }) {
    appendAiCommunicationRecord({
        timestamp: new Date(startedAt).toISOString(),
        status: 'succeeded',
        durationMs: endedAt - startedAt,
        tokenUsage: 'unavailable',
        requestJson,
        response,
    });
}

export function recordAiCommunicationFailure({ startedAt, endedAt, requestJson, error }) {
    const errorInfo = {
        name: error?.name,
        message: error?.message,
    };
    if (error?.status !== undefined) errorInfo.status = error.status;
    if (error?.code !== undefined) errorInfo.code = error.code;
    appendAiCommunicationRecord({
        timestamp: new Date(startedAt).toISOString(),
        status: 'failed',
        durationMs: endedAt - startedAt,
        tokenUsage: 'unavailable',
        requestJson,
        error: errorInfo,
    });
}

export function getAiCommunicationRecords() {
    return aiCommunicationRecords.slice();
}

export function formatAiCommunicationRecords() {
    if (aiCommunicationRecords.length === 0) return '暂无通信记录。';
    return aiCommunicationRecords.map((record) => {
        const lines = [
            `[${record.timestamp}]`,
            `状态: ${record.status === 'succeeded' ? '成功' : '失败'}`,
            `耗时: ${record.durationMs} ms`,
            '令牌用量: 不可用',
            '',
            '请求 — Veridis → TavernHelper.generateRaw',
            record.requestJson,
            '',
        ];
        if (record.status === 'succeeded') {
            lines.push('返回 — TavernHelper.generateRaw → Veridis', record.response);
        } else {
            lines.push(
                '错误 — TavernHelper.generateRaw → Veridis',
                `名称: ${record.error.name ?? '不可用'}`,
                `消息: ${record.error.message ?? '不可用'}`,
            );
            if (record.error.status !== undefined) lines.push(`状态码: ${record.error.status}`);
            if (record.error.code !== undefined) lines.push(`代码: ${record.error.code}`);
        }
        lines.push('', recordSeparator);
        return lines.join('\n');
    }).join('\n\n');
}

export function renderAiCommunicationMonitor(documentRef = globalThis.document) {
    const output = documentRef?.getElementById?.('blai-ai-monitor-output');
    if (output) output.textContent = formatAiCommunicationRecords();
}

export function clearAiCommunicationRecords() {
    aiCommunicationRecords.length = 0;
    if (isAiCommunicationMonitorMounted()) renderAiCommunicationMonitor();
}

export function isAiCommunicationMonitorMounted(documentRef = globalThis.document) {
    const workspace = documentRef?.getElementById?.('blai-feedback-workspace');
    return workspace?.getAttribute?.('aria-hidden') === 'false'
        && workspace?.dataset?.feedbackView === 'ai-context'
        && Boolean(documentRef.getElementById('blai-ai-monitor-output'));
}
