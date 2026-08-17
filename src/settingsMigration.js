/**
 * Owns settings import, normalization, and release-to-release data migration.
 */
import * as extensionsModule from "../../../../extensions.js";
import { saveSettingsDebounced } from "../../../../../script.js";

import { aiRewritePromptProtocolVersion, defaultAiRewriteSettings, defaultSettings, extensionName, modifiedExtensionName, legacyExtensionName, runtimeState, markRulesDataDirty, normalizeAiSamplingSettings, normalizeDiffTrackedMessageLimit, normalizeShujukuAutoProgramRewriteEnabled } from './state.js';
import { logger } from './log.js';
import { cleanupInvalidPresetBindings } from './ui.js';
import { buildPresetEntry, getCurrentPresetAiRewriteSettings, getPresetAiRewriteSettings, getPresetRules, mergeScopeTagsWithBuiltins, normalizeOptionalXmlTagNameInput, normalizeRuleActivationSafety, normalizeScopeTagBuiltinDismissedList, normalizeScopeTagCollapsedGroupList, normalizeScopeTagGroupList } from './utils.js';
import { normalizeZhVariantSettings, restoreZhDictionaryPackageFromCache } from './zhConversion.js';

const { extension_settings } = extensionsModule;

function clonePlain(value) {
    return JSON.parse(JSON.stringify(value));
}

export function createDefaultSettings() {
    return clonePlain(defaultSettings);
}

function normalizeAiApiPresetEntry(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return {
        baseUrl: String(value.baseUrl || '').trim(),
        apiKey: String(value.apiKey || ''),
        model: String(value.model || '').trim(),
        modelOptions: Array.isArray(value.modelOptions)
            ? [...new Set(value.modelOptions.map((model) => String(model || '').trim()).filter(Boolean))]
            : [],
        ...normalizeAiSamplingSettings(value),
        xmlScopeTag: normalizeOptionalXmlTagNameInput(value.xmlScopeTag, defaultAiRewriteSettings.xmlScopeTag),
    };
}

function normalizeAiApiPresets(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([rawName, rawPreset]) => {
        const name = String(rawName || '').trim();
        const preset = normalizeAiApiPresetEntry(rawPreset);
        return name && preset ? [[name, preset]] : [];
    }));
}

function normalizeAiRewriteSettings(settings) {
    const current = settings.aiRewrite && typeof settings.aiRewrite === 'object' ? settings.aiRewrite : {};
    const shouldApplyEnabledDefault = current.enabledDefaultApplied !== true;
    const shouldUpgradePromptProtocol = Number(current.promptProtocolVersion) !== aiRewritePromptProtocolVersion;
    const next = { ...defaultAiRewriteSettings, ...current };
    if (shouldApplyEnabledDefault) {
        next.enabled = true;
        next.enabledDefaultApplied = true;
    }
    next.enabled = next.enabled === true;
    next.enabledDefaultApplied = next.enabledDefaultApplied === true;
    next.streamingRoughPreview = next.streamingRoughPreview !== false;
    next.baseUrl = String(next.baseUrl || '').trim();
    next.apiKey = String(next.apiKey || '');
    next.model = String(next.model || '').trim();
    next.modelOptions = Array.isArray(next.modelOptions)
        ? [...new Set(next.modelOptions.map((value) => String(value || '').trim()).filter(Boolean))]
        : [];
    next.apiPresets = normalizeAiApiPresets(next.apiPresets);
    next.activeApiPreset = String(next.activeApiPreset || '').trim();
    if (!Object.prototype.hasOwnProperty.call(next.apiPresets, next.activeApiPreset)) next.activeApiPreset = '';
    delete next.promptScope;
    next.promptTemplate = shouldUpgradePromptProtocol
        ? defaultAiRewriteSettings.promptTemplate
        : String(next.promptTemplate || defaultAiRewriteSettings.promptTemplate);
    next.promptProtocolVersion = aiRewritePromptProtocolVersion;
    Object.assign(next, normalizeAiSamplingSettings(next));
    const normalizedTimeoutMs = Number.isFinite(Number(next.timeoutMs)) ? Math.min(Math.max(Math.round(Number(next.timeoutMs)), 1000), 120000) : defaultAiRewriteSettings.timeoutMs;
    next.timeoutMs = current.timeoutDefault120sApplied !== true && normalizedTimeoutMs === 20000
        ? defaultAiRewriteSettings.timeoutMs
        : normalizedTimeoutMs;
    next.timeoutDefault120sApplied = true;
    next.maxRetries = Number.isFinite(Number(next.maxRetries)) ? Math.min(Math.max(Math.round(Number(next.maxRetries)), 0), 5) : defaultAiRewriteSettings.maxRetries;
    const normalizedMaxItems = Number.isFinite(Number(next.maxItemsPerRequest)) ? Math.max(Math.round(Number(next.maxItemsPerRequest)), 1) : defaultAiRewriteSettings.maxItemsPerRequest;
    next.maxItemsPerRequest = current.maxItemsDefault20Applied !== true && normalizedMaxItems === 8
        ? defaultAiRewriteSettings.maxItemsPerRequest
        : normalizedMaxItems;
    next.maxItemsDefault20Applied = true;
    next.maxContextChars = Number.isFinite(Number(next.maxContextChars)) ? Math.min(Math.max(Math.round(Number(next.maxContextChars)), 1000), 60000) : defaultAiRewriteSettings.maxContextChars;
    next.maxRewriteCharsPerItem = Number.isFinite(Number(next.maxRewriteCharsPerItem)) ? Math.min(Math.max(Math.round(Number(next.maxRewriteCharsPerItem)), 50), 10000) : defaultAiRewriteSettings.maxRewriteCharsPerItem;
    next.xmlScopeTag = normalizeOptionalXmlTagNameInput(next.xmlScopeTag, defaultAiRewriteSettings.xmlScopeTag);
    next.protectXmlComments = next.protectXmlComments === true;
    settings.aiRewrite = next;
}

function hasConfiguredAiRewrite(settings) {
    const aiSettings = settings?.aiRewrite;
    if (!aiSettings || typeof aiSettings !== 'object') return false;
    return Object.entries(defaultAiRewriteSettings).some(([key, defaultValue]) => (
        Object.prototype.hasOwnProperty.call(aiSettings, key)
        && JSON.stringify(aiSettings[key]) !== JSON.stringify(defaultValue)
    ));
}

function isSettingsEffectivelyEmpty(settings) {
    if (!settings || typeof settings !== 'object') return true;
    const hasRules = Array.isArray(settings.rules) && settings.rules.length > 0;
    const hasPresets = settings.presets && typeof settings.presets === 'object' && Object.keys(settings.presets).length > 0;
    return !hasRules && !hasPresets && !settings.activePreset && !hasConfiguredAiRewrite(settings);
}

export function maybeImportModifiedSettingsIntoSharedNamespace() {
    const sharedSettings = extension_settings[extensionName];
    const modifiedSettings = extension_settings[modifiedExtensionName];
    if (!sharedSettings || !modifiedSettings || sharedSettings === modifiedSettings) return false;
    if (!isSettingsEffectivelyEmpty(sharedSettings) || isSettingsEffectivelyEmpty(modifiedSettings)) return false;

    extension_settings[extensionName] = clonePlain(modifiedSettings);
    runtimeState.modifiedSettingsImportedThisBoot = true;
    logger.info('[屏蔽词净化助手 AI 改写版] 已将旧改版设置导入共享设置命名空间');
    return true;
}

export function maybeCopyLegacySettings() {
    const settings = extension_settings[extensionName];
    const legacySettings = extension_settings[legacyExtensionName];
    if (!settings || settings.legacySettingsCopied === true || !isSettingsEffectivelyEmpty(settings)) return;
    if (!legacySettings || typeof legacySettings !== 'object') return;

    [
        'rules',
        'presets',
        'activePreset',
        'defaultPreset',
        'characterBindings',
        'chatCompletionPresetBindings',
        'scopeTags',
        'scopeTagGroups',
        'scopeTagCollapsedGroups',
        'scopeTagBuiltinDismissed',
        'scopeTagMode',
        'enableVisualDiff',
        'diffViewMode',
        'diffButtonInExtraMenu',
        'showBottomDiffButton',
        'diffTrackedMessageLimit',
        'themeMode',
        'logLevel',
        'skipUserMessages',
        'zhVariantCompatEnabled',
        'zhVariantCompatOptions',
        'zhVariantDictionary',
        'protectPersonaDescription',
    ].forEach((key) => {
        if (legacySettings[key] !== undefined) settings[key] = clonePlain(legacySettings[key]);
    });

    settings.aiRewrite = { ...defaultAiRewriteSettings };
    settings.legacySettingsCopied = true;
    runtimeState.legacySettingsCopiedThisBoot = true;
    logger.info('[屏蔽词净化助手 AI 改写版] 已复制旧版设置到独立命名空间');
}

export function ensureSettingsShape() {
    const settings = extension_settings[extensionName];
    if (!settings) return;
    if (!settings.rules) settings.rules = [];
    if (!settings.presets) settings.presets = {};
    if (settings.activePreset === undefined) settings.activePreset = "";
    if (settings.defaultPreset === undefined) settings.defaultPreset = "";
    if (!settings.characterBindings || typeof settings.characterBindings !== 'object') settings.characterBindings = {};
    if (!settings.chatCompletionPresetBindings || typeof settings.chatCompletionPresetBindings !== 'object') settings.chatCompletionPresetBindings = {};
    settings.scopeTagGroups = normalizeScopeTagGroupList(settings.scopeTagGroups);
    settings.scopeTagCollapsedGroups = normalizeScopeTagCollapsedGroupList(settings.scopeTagCollapsedGroups, settings.scopeTagGroups);
    settings.scopeTagBuiltinDismissed = normalizeScopeTagBuiltinDismissedList(settings.scopeTagBuiltinDismissed);
    settings.scopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
    if (!['protect', 'cleanse-inside'].includes(settings.scopeTagMode)) settings.scopeTagMode = 'protect';
    settings.enableVisualDiff = true;
    if (!settings.diffViewMode) settings.diffViewMode = 'snippet';
    if (settings.diffButtonInExtraMenu === undefined) settings.diffButtonInExtraMenu = false;
    if (settings.showBottomDiffButton === undefined) settings.showBottomDiffButton = true;
    settings.diffTrackedMessageLimit = normalizeDiffTrackedMessageLimit(settings.diffTrackedMessageLimit);
    if (!['auto', 'light', 'dark'].includes(settings.themeMode)) settings.themeMode = 'auto';
    if (settings.logLevel === undefined) settings.logLevel = 2;
    if (settings.skipUserMessages === undefined) settings.skipUserMessages = false;
    settings.showComposerAiRewriteButton = settings.showComposerAiRewriteButton === true;
    settings.shujukuAutoProgramRewriteEnabled = normalizeShujukuAutoProgramRewriteEnabled(settings.shujukuAutoProgramRewriteEnabled);
    normalizeZhVariantSettings(settings);
    if (settings.zhVariantCompatEnabled === true && !restoreZhDictionaryPackageFromCache(settings)) {
        settings.zhVariantCompatEnabled = false;
    }
    if (settings.protectPersonaDescription === undefined) settings.protectPersonaDescription = false;
    normalizeAiRewriteSettings(settings);
    if (settings.legacySettingsCopied === undefined) settings.legacySettingsCopied = false;
    cleanupInvalidPresetBindings();
}

function normalizeRuleShape(rule, index = 0) {
    if (!rule || typeof rule !== 'object') return;
    if (!rule.name) rule.name = `合集 ${index + 1}`;
    const normalizedRule = normalizeRuleActivationSafety(rule);
    if (normalizedRule.activationWarning) rule.activationWarning = normalizedRule.activationWarning;
    else delete rule.activationWarning;
    if (normalizedRule.activationWarningEnabled === true) rule.activationWarningEnabled = true;
    else delete rule.activationWarningEnabled;
    rule.enabled = normalizedRule.enabled;

    if (rule.targets) {
        rule.subRules = [{
            targets: rule.targets,
            replacements: rule.replacements || [],
            mode: 'text',
            rewriteMode: 'program',
            enabled: true,
        }];
        delete rule.targets;
        delete rule.replacements;
    }

    if (!Array.isArray(rule.subRules)) rule.subRules = [];
    rule.subRules.forEach((sub) => {
        if (!sub || typeof sub !== 'object') return;
        if (!sub.mode) sub.mode = 'text';
        if (sub.enabled === undefined) sub.enabled = true;
        if (!['program', 'ai'].includes(sub.rewriteMode)) sub.rewriteMode = 'program';
        sub.aiPromptTemplate = String(sub.aiPromptTemplate || '');
    });
}

function normalizeRulesListShape(rules) {
    if (!Array.isArray(rules)) return;
    rules.forEach((rule, index) => normalizeRuleShape(rule, index));
}

function normalizePresetEntriesShape(settings) {
    if (!settings || !settings.presets || typeof settings.presets !== 'object') {
        if (settings) settings.presets = {};
        return;
    }
    Object.keys(settings.presets).forEach((name) => {
        const presetEntry = settings.presets[name];
        const rules = getPresetRules(presetEntry);
        normalizeRulesListShape(rules);
        settings.presets[name] = buildPresetEntry(
            rules,
            getPresetAiRewriteSettings(presetEntry) || getCurrentPresetAiRewriteSettings(settings.aiRewrite)
        );
    });
}

export function migrateOldData() {
    const settings = extension_settings[extensionName];
    if (settings && settings.bannedWords) {
        if (settings.bannedWords.length > 0) {
            settings.rules = settings.rules || [];
            settings.rules.push({
                name: "旧版本过滤词",
                subRules: [{ targets: [...settings.bannedWords], replacements: [], mode: 'text' }],
                enabled: true
            });
        }
        delete settings.bannedWords;
        markRulesDataDirty();
    }

    if (settings) {
        ensureSettingsShape();
        normalizePresetEntriesShape(settings);

        if (settings.rules && settings.rules.length > 0) {
            normalizeRulesListShape(settings.rules);

            if (Object.keys(settings.presets).length === 0) {
                settings.presets["默认存档"] = buildPresetEntry(settings.rules, getCurrentPresetAiRewriteSettings(settings.aiRewrite));
                settings.activePreset = "默认存档";
            }
        }
        saveSettingsDebounced();
    }
}
