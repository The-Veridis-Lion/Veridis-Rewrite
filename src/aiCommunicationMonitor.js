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
    if (isAiCommunicationMonitorOpen()) renderAiCommunicationMonitor();
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
            `status: ${record.status}`,
            `durationMs: ${record.durationMs}`,
            `tokenUsage: ${record.tokenUsage}`,
            '',
            'REQUEST — Veridis -> TavernHelper.generateRaw',
            record.requestJson,
            '',
        ];
        if (record.status === 'succeeded') {
            lines.push('RESPONSE — TavernHelper.generateRaw -> Veridis', record.response);
        } else {
            lines.push(
                'ERROR — TavernHelper.generateRaw -> Veridis',
                `name: ${record.error.name ?? 'unavailable'}`,
                `message: ${record.error.message ?? 'unavailable'}`,
            );
            if (record.error.status !== undefined) lines.push(`status: ${record.error.status}`);
            if (record.error.code !== undefined) lines.push(`code: ${record.error.code}`);
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
    if (isAiCommunicationMonitorOpen()) renderAiCommunicationMonitor();
}

export function openAiCommunicationMonitor(documentRef = globalThis.document) {
    const modal = documentRef?.getElementById?.('blai-ai-monitor-modal');
    if (!modal) return false;
    renderAiCommunicationMonitor(documentRef);
    modal.classList.add('blai-is-open');
    modal.setAttribute('aria-hidden', 'false');
    documentRef.getElementById('blai-ai-monitor-open')?.setAttribute('aria-expanded', 'true');
    return true;
}

export function closeAiCommunicationMonitor(documentRef = globalThis.document) {
    const modal = documentRef?.getElementById?.('blai-ai-monitor-modal');
    if (!modal) return false;
    modal.classList.remove('blai-is-open');
    modal.setAttribute('aria-hidden', 'true');
    documentRef.getElementById('blai-ai-monitor-open')?.setAttribute('aria-expanded', 'false');
    return true;
}

export function isAiCommunicationMonitorOpen(documentRef = globalThis.document) {
    return documentRef?.getElementById?.('blai-ai-monitor-modal')?.classList.contains('blai-is-open') === true;
}
