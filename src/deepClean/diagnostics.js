// Owns privacy-safe Deep Clean diagnostic projection and its dedicated local retention slots.
export const deepCleanDiagnosticsStorageKey = 'ultimate_purifier_ai_rewrite_deep_clean_diagnostics_v1';
const terminalStages = new Set(['read', 'scan', 'processing', 'lookahead-processing', 'direct-apply', 'review-apply', 'complete']);
const failureCodes = new Set([
    'read_failed',
    'scan_failed',
    'processing_failed',
    'lookahead_processing_failed',
    'direct_apply_failed',
    'review_apply_failed',
    'completed_with_failures',
]);

function emptyStore() {
    return { schemaVersion: 1, lastSuccess: null, recentFailures: [] };
}

function finiteNumber(value) {
    return Number.isFinite(value) ? Number(value) : null;
}

function copyExistingNumbers(source, keys) {
    const output = {};
    keys.forEach((key) => {
        const value = finiteNumber(source?.[key]);
        if (value !== null) output[key] = value;
    });
    return output;
}

export function projectDeepCleanSafeDiagnostic(record) {
    if (!record || record.schemaVersion !== 1) return null;
    const projected = {
        schemaVersion: 1,
        startedAt: String(record.startedAt || ''),
        endedAt: String(record.endedAt || ''),
        durationMs: Math.max(0, finiteNumber(record.durationMs) ?? 0),
        outcome: record.outcome === 'success' ? 'success' : 'failure',
        terminalStage: terminalStages.has(record.terminalStage) ? record.terminalStage : '',
    };
    if (projected.outcome === 'failure' && failureCodes.has(record.failureCode)) {
        projected.failureCode = record.failureCode;
    }
    if (record.mode && typeof record.mode === 'object') {
        projected.mode = {
            processingMode: ['program', 'program-ai'].includes(record.mode.processingMode) ? record.mode.processingMode : '',
            programApplyPolicy: ['direct', 'review'].includes(record.mode.programApplyPolicy) ? record.mode.programApplyPolicy : '',
            messageAiScope: ['body', 'whole-message'].includes(record.mode.messageAiScope) ? record.mode.messageAiScope : '',
            model: String(record.mode.model || ''),
        };
    }
    if (record.resources && typeof record.resources === 'object') {
        projected.resources = copyExistingNumbers(record.resources, [
            'characters',
            'chatBranches',
            'personas',
            'worldBooks',
        ]);
    }
    if (record.summary && typeof record.summary === 'object') {
        projected.summary = copyExistingNumbers(record.summary, [
            'scannedItemCount',
            'affectedItemCount',
            'programHitCount',
            'aiHitCount',
            'appliedItemCount',
            'retainedOriginalItemCount',
            'failedItemCount',
            'totalAiRequestCount',
            'failedAiRequestCount',
            'oversizedAiItemCount',
        ]);
    }
    return projected;
}

export function createDeepCleanSafeDiagnostic({
    startedAt,
    endedAt = Date.now(),
    outcome,
    terminalStage,
    failureCode,
    input,
    scanResult,
    summary,
} = {}) {
    const startMs = finiteNumber(startedAt) ?? endedAt;
    const endMs = finiteNumber(endedAt) ?? Date.now();
    const record = {
        schemaVersion: 1,
        startedAt: new Date(startMs).toISOString(),
        endedAt: new Date(endMs).toISOString(),
        durationMs: Math.max(0, endMs - startMs),
        outcome: outcome === 'success' ? 'success' : 'failure',
        terminalStage: String(terminalStage || ''),
    };
    if (record.outcome === 'failure' && failureCode) record.failureCode = String(failureCode);
    if (input) {
        record.mode = {
            processingMode: String(input.processingMode || ''),
            programApplyPolicy: String(input.programApplyPolicy || ''),
            messageAiScope: String(input.messageAiScope || ''),
            model: String(input.aiConnection?.model || ''),
        };
        record.resources = {
            characters: Array.isArray(input.characterKeys) ? input.characterKeys.length : 0,
            chatBranches: Array.isArray(input.chats) ? input.chats.length : 0,
            personas: Array.isArray(input.personaKeys) ? input.personaKeys.length : 0,
            worldBooks: Array.isArray(input.worldBookKeys) ? input.worldBookKeys.length : 0,
        };
    }
    const diagnosticSummary = {
        ...copyExistingNumbers(scanResult, [
            'scannedItemCount',
            'affectedItemCount',
            'programHitCount',
            'aiHitCount',
        ]),
        ...copyExistingNumbers(summary, [
            'appliedItemCount',
            'retainedOriginalItemCount',
            'failedItemCount',
            'totalAiRequestCount',
            'failedAiRequestCount',
            'oversizedAiItemCount',
        ]),
    };
    if (Object.keys(diagnosticSummary).length > 0) record.summary = diagnosticSummary;
    return projectDeepCleanSafeDiagnostic(record);
}

export function readDeepCleanDiagnostics(storage = globalThis.localStorage) {
    try {
        const parsed = JSON.parse(storage?.getItem(deepCleanDiagnosticsStorageKey) || 'null');
        if (parsed?.schemaVersion !== 1) return emptyStore();
        return {
            schemaVersion: 1,
            lastSuccess: projectDeepCleanSafeDiagnostic(parsed.lastSuccess),
            recentFailures: (Array.isArray(parsed.recentFailures) ? parsed.recentFailures : [])
                .map(projectDeepCleanSafeDiagnostic)
                .filter(Boolean)
                .slice(0, 2),
        };
    } catch {
        return emptyStore();
    }
}

function writeStore(store, storage) {
    storage?.setItem(deepCleanDiagnosticsStorageKey, JSON.stringify(store));
    return store;
}

export function recordDeepCleanSuccess(record, storage = globalThis.localStorage) {
    const safeRecord = projectDeepCleanSafeDiagnostic(record);
    if (!safeRecord || safeRecord.outcome !== 'success') throw new Error('A safe Deep Clean success diagnostic is required.');
    const store = readDeepCleanDiagnostics(storage);
    return writeStore({ ...store, lastSuccess: safeRecord }, storage);
}

export function recordDeepCleanFailure(record, storage = globalThis.localStorage) {
    const safeRecord = projectDeepCleanSafeDiagnostic(record);
    if (!safeRecord || safeRecord.outcome !== 'failure') throw new Error('A safe Deep Clean failure diagnostic is required.');
    const store = readDeepCleanDiagnostics(storage);
    return writeStore({
        ...store,
        recentFailures: [safeRecord, ...store.recentFailures].slice(0, 2),
    }, storage);
}

export function getDeepCleanDiagnosticSlots(storage = globalThis.localStorage) {
    const store = readDeepCleanDiagnostics(storage);
    return {
        latestFailure: store.recentFailures[0] || null,
        previousFailure: store.recentFailures[1] || null,
        lastSuccess: store.lastSuccess,
    };
}

export function clearDeepCleanDiagnostics(storage = globalThis.localStorage) {
    storage?.removeItem(deepCleanDiagnosticsStorageKey);
}
