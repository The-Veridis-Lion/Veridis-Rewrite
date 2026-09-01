// Owns explicit anonymous feedback payload construction and attachment projection.
import { getAppContext } from '../host/appContext.js';
import { getAiRewriteRuntimeLog } from '../aiRewrite/debug.js';
import { getDeepCleanDiagnosticSlots, projectDeepCleanSafeDiagnostic } from '../deepClean/diagnostics.js';
import { getMvuIntegrationSignal } from '../integrations/mvu.js';
import { getVeridisRuntimeLabel } from '../integrations/tauriTavern.js';
import { collectTavernHelperFeedbackEnvironment } from '../integrations/tavernHelper.js';

export const feedbackTypes = Object.freeze(['Bug', 'Feature']);
export const feedbackAreas = Object.freeze([
    'Deep Clean',
    'AI Rewrite',
    'Program Rewrite',
    'Streaming Filter',
    'Regex',
    'Diff / Review',
    'Rule Search',
    'Settings / API',
    'UI / Layout',
    'Third-party Integration',
    'Other',
]);

function requiredText(value, fieldName) {
    const text = String(value || '').trim();
    if (!text) throw new Error(`${fieldName} is required.`);
    return text;
}

function requiredReaderValue(reader, fieldName) {
    const value = typeof reader === 'function' ? String(reader() || '').trim() : '';
    if (!value) throw new Error(`${fieldName} is unavailable.`);
    return value;
}

function projectExtension(extension) {
    return {
        externalId: String(extension?.externalId || ''),
        displayName: String(extension?.displayName || ''),
        version: String(extension?.version || ''),
    };
}

export function collectInstalledEnabledExtensions({
    extensionNames = [],
    extensionTypes = {},
    disabledExtensions = [],
    getExtensionManifest,
    veridisExternalId = '',
} = {}) {
    const disabled = new Set(Array.isArray(disabledExtensions) ? disabledExtensions : []);
    return (Array.isArray(extensionNames) ? extensionNames : [])
        .filter((externalId) => (
            (extensionTypes?.[externalId] === 'local' || extensionTypes?.[externalId] === 'global')
            && externalId !== veridisExternalId
            && !disabled.has(externalId)
        ))
        .map((externalId) => {
            const manifest = typeof getExtensionManifest === 'function'
                ? getExtensionManifest(externalId)
                : null;
            return projectExtension({
                externalId,
                displayName: manifest?.display_name || externalId,
                version: manifest?.version || '',
            });
        });
}

function defaultReaders() {
    const appContext = getAppContext();
    return {
        getVeridisVersion: appContext.getVeridisVersion,
        getSillyTavernVersion: appContext.getSillyTavernVersion,
        getAiRewriteDiagnosticConfig: appContext.getAiRewriteDiagnosticConfig,
        getPlatform: appContext.getCoarsePlatform,
        getRuntime: getVeridisRuntimeLabel,
        getMvuSignal: getMvuIntegrationSignal,
        getInstalledEnabledExtensions: appContext.getInstalledEnabledExtensions,
        getTavernHelperFeedbackEnvironment: collectTavernHelperFeedbackEnvironment,
        getRuntimeLog: getAiRewriteRuntimeLog,
        getDeepCleanDiagnosticSlots,
    };
}

export function buildFeedbackPayload(form = {}, selected = {}, readers = defaultReaders()) {
    const type = String(form.type || '');
    if (!feedbackTypes.includes(type)) throw new Error('Type is required.');

    const area = [...new Set(Array.isArray(form.area) ? form.area : [])];
    if (area.length === 0 || area.some((value) => !feedbackAreas.includes(value))) {
        throw new Error('At least one valid Area is required.');
    }

    const mvuSignal = typeof readers.getMvuSignal === 'function' ? readers.getMvuSignal() : '';
    if (mvuSignal !== 'detected' && mvuSignal !== 'not_detected') {
        throw new Error('MVU signal is unavailable.');
    }

    const aiRewriteConfig = readers.getAiRewriteDiagnosticConfig();
    const payload = {
        schemaVersion: 1,
        type,
        area,
        title: requiredText(form.title, 'Title'),
        details: requiredText(form.details, 'Details'),
        environment: {
            veridisVersion: requiredReaderValue(readers.getVeridisVersion, 'Veridis version'),
            sillyTavernVersion: requiredReaderValue(readers.getSillyTavernVersion, 'SillyTavern version'),
            runtime: requiredReaderValue(readers.getRuntime, 'Runtime'),
            platform: requiredReaderValue(readers.getPlatform, 'Platform'),
            mvuSignal,
            aiRewrite: {
                model: aiRewriteConfig.model,
                sampling: {
                    temperature: aiRewriteConfig.temperature,
                    topP: aiRewriteConfig.topP,
                    topK: aiRewriteConfig.topK,
                    frequencyPenalty: aiRewriteConfig.frequencyPenalty,
                    presencePenalty: aiRewriteConfig.presencePenalty,
                    repetitionPenalty: aiRewriteConfig.repetitionPenalty,
                    maxTokens: aiRewriteConfig.maxTokens,
                },
                limits: {
                    timeoutMs: aiRewriteConfig.timeoutMs,
                    maxRetries: aiRewriteConfig.maxRetries,
                    maxItemsPerRequest: aiRewriteConfig.maxItemsPerRequest,
                    maxContextChars: aiRewriteConfig.maxContextChars,
                },
            },
        },
    };

    const diagnostics = {};
    if (selected.installedEnabledExtensions === true) {
        const extensions = readers.getInstalledEnabledExtensions();
        const tavernHelperEnvironment = readers.getTavernHelperFeedbackEnvironment();
        diagnostics.installedEnabledExtensions = [
            ...(Array.isArray(extensions) ? extensions : []),
            ...(Array.isArray(tavernHelperEnvironment) ? tavernHelperEnvironment : []),
        ].map(projectExtension);
    }
    if (selected.runtimeLog === true) {
        diagnostics.aiRewrite = readers.getRuntimeLog();
    }

    const deepCleanSelections = {
        latestFailure: selected.deepCleanLatestFailure === true,
        previousFailure: selected.deepCleanPreviousFailure === true,
        lastSuccess: selected.deepCleanLastSuccess === true,
    };
    if (Object.values(deepCleanSelections).some(Boolean)) {
        const slots = readers.getDeepCleanDiagnosticSlots();
        const deepClean = {};
        Object.entries(deepCleanSelections).forEach(([slot, isSelected]) => {
            const safeRecord = isSelected ? projectDeepCleanSafeDiagnostic(slots?.[slot]) : null;
            if (safeRecord) deepClean[slot] = safeRecord;
        });
        if (Object.keys(deepClean).length > 0) diagnostics.deepClean = deepClean;
    }

    if (Object.keys(diagnostics).length > 0) payload.diagnostics = diagnostics;
    return payload;
}
