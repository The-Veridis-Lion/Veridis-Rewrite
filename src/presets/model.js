import { aiRewritePromptProtocolVersion, defaultAiRewriteSettings, migrateKnownAiRewritePrompt, normalizeAiSamplingSettings } from '../settings/defaults.js';

// Preset serialization and AI-setting snapshot semantics.

export function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function clampNumberSetting(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
}

function clampIntegerSetting(value, min, max, fallback) {
    return Math.round(clampNumberSetting(value, min, max, fallback));
}

function normalizePositiveIntegerSetting(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(Math.round(parsed), 1) : fallback;
}

export function normalizePresetAiRewriteSettings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return {
        ...normalizeAiSamplingSettings(value),
        timeoutMs: clampIntegerSetting(value.timeoutMs, 1000, 120000, defaultAiRewriteSettings.timeoutMs),
        maxRetries: clampIntegerSetting(value.maxRetries, 0, 5, defaultAiRewriteSettings.maxRetries),
        maxItemsPerRequest: normalizePositiveIntegerSetting(value.maxItemsPerRequest, defaultAiRewriteSettings.maxItemsPerRequest),
        maxContextChars: clampIntegerSetting(value.maxContextChars, 1000, 60000, defaultAiRewriteSettings.maxContextChars),
        promptTemplate: migrateKnownAiRewritePrompt(value.promptTemplate) || defaultAiRewriteSettings.promptTemplate,
        promptProtocolVersion: aiRewritePromptProtocolVersion,
    };
}

export function getCurrentPresetAiRewriteSettings(aiRewriteSettings = null) {
    return normalizePresetAiRewriteSettings(aiRewriteSettings || defaultAiRewriteSettings)
        || normalizePresetAiRewriteSettings(defaultAiRewriteSettings);
}

export function getPresetRules(presetEntry) {
    if (Array.isArray(presetEntry)) return presetEntry;
    if (presetEntry && typeof presetEntry === 'object' && Array.isArray(presetEntry.rules)) return presetEntry.rules;
    return [];
}

export function getPresetAiRewriteSettings(presetEntry) {
    if (!presetEntry || Array.isArray(presetEntry) || typeof presetEntry !== 'object') return null;
    return normalizePresetAiRewriteSettings(presetEntry.aiRewrite);
}

export function buildPresetEntry(rules = [], aiRewriteSettings = null) {
    const entry = {
        rules: deepClone(Array.isArray(rules) ? rules : []),
    };
    const normalizedAiRewrite = normalizePresetAiRewriteSettings(aiRewriteSettings);
    if (normalizedAiRewrite) entry.aiRewrite = normalizedAiRewrite;
    return entry;
}

function isRuleLikeObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Array.isArray(value.subRules)
        || Array.isArray(value.targets)
        || (typeof value.name === 'string' && ('enabled' in value || 'subRules' in value));
}

export function normalizeImportedRulesPayload(payload) {
    if (Array.isArray(payload)) return payload;

    if (!payload || typeof payload !== 'object') {
        throw new Error('格式非对象或数组');
    }

    if ('rules' in payload) {
        return normalizeImportedRulesPayload(payload.rules);
    }

    if ('__content__' in payload) {
        return normalizeImportedRulesPayload(payload.__content__);
    }

    if ('content' in payload) {
        return normalizeImportedRulesPayload(payload.content);
    }

    const numericKeys = Object.keys(payload)
        .filter((key) => /^\d+$/.test(key))
        .sort((a, b) => Number(a) - Number(b));
    if (numericKeys.length > 0) {
        const numericRules = numericKeys
            .map((key) => payload[key])
            .filter(isRuleLikeObject);
        if (numericRules.length > 0) return numericRules;
    }

    const candidateRules = Object.entries(payload)
        .filter(([key]) => !String(key).startsWith('_'))
        .map(([, value]) => value)
        .filter(isRuleLikeObject);
    if (candidateRules.length > 0) return candidateRules;

    throw new Error('未识别的预设格式');
}
