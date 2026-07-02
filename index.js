import * as extensionsModule from "../../../extensions.js";
import * as scriptModule from "../../../../script.js";
import { saveSettingsDebounced, eventSource, event_types, chat_metadata, chat } from "../../../../script.js";

import { defaultAiRewriteSettings, defaultSettings, extensionName, legacyExtensionName, initAppContext, runtimeState, markRulesDataDirty, normalizeDiffTrackedMessageLimit } from './src/state.js';
import { logger } from './src/log.js';
import { bindEvents, initRealtimeInterceptor } from './src/events.js';
import { setupUI, updateToolbarUI, applyCharacterPresetBinding, cleanupInvalidPresetBindings, showToast } from './src/ui.js';
import { restoreDiffStateFromChatMetadata, injectDiffButtons } from './src/diff.js';
import { performGlobalCleanse } from './src/core.js';
import { buildPresetEntry, getCurrentPresetAiRewriteSettings, getPresetAiRewriteSettings, getPresetRules, mergeScopeTagsWithBuiltins, normalizeScopeTagBuiltinDismissedList, normalizeScopeTagCollapsedGroupList, normalizeScopeTagGroupList, normalizeXmlTagNameInput } from './src/utils.js';
import { isBaiBaiToolkitInstalled, isLoreFrameInstalled, isTauriTavernHost, waitForTauriTavernReady } from './src/platform.js';
import { normalizeZhVariantSettings, restoreZhDictionaryPackageFromCache } from './src/zhConversion.js';

const { extension_settings, getContext: getSillyTavernContext } = extensionsModule;

initAppContext({
    extension_settings,
    saveSettingsDebounced,
    eventSource,
    event_types,
    getStreamingProcessor: () => scriptModule.streamingProcessor,
    saveChat: scriptModule.saveChat,
    chat_metadata,
    chat,
    getSillyTavernContext,
    markWindowedChatDirtyFromIndex: scriptModule.markWindowedChatDirtyFromIndex,
});

function clonePlain(value) {
    return JSON.parse(JSON.stringify(value));
}

function createDefaultSettings() {
    return clonePlain(defaultSettings);
}

function normalizeAiRewriteSettings(settings) {
    const current = settings.aiRewrite && typeof settings.aiRewrite === 'object' ? settings.aiRewrite : {};
    const shouldApplyEnabledDefault = current.enabledDefaultApplied !== true;
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
    delete next.promptScope;
    next.promptTemplate = String(next.promptTemplate || defaultAiRewriteSettings.promptTemplate);
    next.temperature = Number.isFinite(Number(next.temperature)) ? Math.min(Math.max(Number(next.temperature), 0), 2) : defaultAiRewriteSettings.temperature;
    const normalizedTimeoutMs = Number.isFinite(Number(next.timeoutMs)) ? Math.min(Math.max(Math.round(Number(next.timeoutMs)), 1000), 120000) : defaultAiRewriteSettings.timeoutMs;
    next.timeoutMs = current.timeoutDefault120sApplied !== true && normalizedTimeoutMs === 20000
        ? defaultAiRewriteSettings.timeoutMs
        : normalizedTimeoutMs;
    next.timeoutDefault120sApplied = true;
    next.maxRetries = Number.isFinite(Number(next.maxRetries)) ? Math.min(Math.max(Math.round(Number(next.maxRetries)), 0), 5) : defaultAiRewriteSettings.maxRetries;
    const normalizedMaxItems = Number.isFinite(Number(next.maxItemsPerRequest)) ? Math.min(Math.max(Math.round(Number(next.maxItemsPerRequest)), 1), 32) : defaultAiRewriteSettings.maxItemsPerRequest;
    next.maxItemsPerRequest = current.maxItemsDefault20Applied !== true && normalizedMaxItems === 8
        ? defaultAiRewriteSettings.maxItemsPerRequest
        : normalizedMaxItems;
    next.maxItemsDefault20Applied = true;
    next.maxContextChars = Number.isFinite(Number(next.maxContextChars)) ? Math.min(Math.max(Math.round(Number(next.maxContextChars)), 1000), 60000) : defaultAiRewriteSettings.maxContextChars;
    next.maxRewriteCharsPerItem = Number.isFinite(Number(next.maxRewriteCharsPerItem)) ? Math.min(Math.max(Math.round(Number(next.maxRewriteCharsPerItem)), 50), 10000) : defaultAiRewriteSettings.maxRewriteCharsPerItem;
    next.xmlScopeTag = normalizeXmlTagNameInput(next.xmlScopeTag, defaultAiRewriteSettings.xmlScopeTag);
    settings.aiRewrite = next;
}

function isSettingsEffectivelyEmpty(settings) {
    if (!settings || typeof settings !== 'object') return true;
    const hasRules = Array.isArray(settings.rules) && settings.rules.length > 0;
    const hasPresets = settings.presets && typeof settings.presets === 'object' && Object.keys(settings.presets).length > 0;
    return !hasRules && !hasPresets && !settings.activePreset;
}

function maybeCopyLegacySettings() {
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
        'realtimeMaskMode',
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

function ensureSettingsShape() {
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
    if (!['simple-visual', 'tavern-helper'].includes(settings.realtimeMaskMode)) settings.realtimeMaskMode = 'simple-visual';
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
    if (rule.enabled === undefined) rule.enabled = true;

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

function migrateOldData() {
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

jQuery(() => {
    if (runtimeState.isBooted) return;
    extension_settings[extensionName] = extension_settings[extensionName] || createDefaultSettings();

    maybeCopyLegacySettings();
    migrateOldData();
    ensureSettingsShape();

    const boot = async () => {
        if (runtimeState.isBooted) return;
        runtimeState.isBooted = true;
        await waitForTauriTavernReady();
        logger.info('[屏蔽词净化助手] 启动初始化开始...');
        if (isTauriTavernHost()) logger.info('[屏蔽词净化助手] 已启用 TauriTavern 兼容层');
        if (isBaiBaiToolkitInstalled()) logger.info('[屏蔽词净化助手] 已启用柏宝箱兼容层');
        if (isLoreFrameInstalled()) logger.info('[屏蔽词净化助手] 已启用 LoreFrame 兼容层');
        setupUI();
        if (runtimeState.legacySettingsCopiedThisBoot === true) {
            setTimeout(() => showToast('已复制旧版规则与预设到 AI 改写版'), 250);
        }
        bindEvents();
        initRealtimeInterceptor();
        updateToolbarUI();
        applyCharacterPresetBinding(true, { skipCleanse: true });
        restoreDiffStateFromChatMetadata();
        setTimeout(() => {
            injectDiffButtons();
            performGlobalCleanse();
        }, 80);
        logger.info('[屏蔽词净化助手] 启动初始化完成');
    };

    if (typeof eventSource !== 'undefined' && event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, boot);
        if (document.getElementById('send_textarea')) boot();
    }
});
