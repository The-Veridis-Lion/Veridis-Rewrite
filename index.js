import * as extensionsModule from "../../../extensions.js";
import * as scriptModule from "../../../../script.js";
import { saveSettingsDebounced, eventSource, event_types, chat } from "../../../../script.js";
import { user_avatar } from "../../../personas.js";
import { world_info, worldInfoCache } from "../../../world-info.js";

import { aiRewritePromptProtocolVersion, defaultAiRewriteSettings, defaultSettings, extensionName, modifiedExtensionName, legacyExtensionName, normalizeAiSamplingSettings, normalizeDiffTrackedMessageLimit } from './src/settings/defaults.js';
import { initAppContext } from './src/host/appContext.js';
import { markRulesDataDirty } from './src/rules/state.js';
import { logger } from './src/log.js';
import { bindEvents } from './src/events.js';
import { initRealtimeInterceptor } from './src/host/lifecycleEvents.js';
import { setupUI } from './src/ui/shell.js';
import { updateToolbarUI } from './src/presets/view.js';
import { applyCharacterPresetBinding } from './src/presets/application.js';
import { showRiskConfirmModal, showToast } from './src/ui/notifications.js';
import { cleanupInvalidPresetBindings } from './src/presets/bindings.js';
import { restoreDiffStateFromChatMetadata } from './src/diff/state.js';
import { performGlobalChatMaintenance } from './src/chat/cleanse.js';
import { buildPresetEntry, getCurrentPresetAiRewriteSettings, getPresetAiRewriteSettings, getPresetRules } from './src/presets/model.js';
import { normalizeRuleActivationSafety } from './src/rules/model.js';
import { mergeScopeTagsWithBuiltins, normalizeOptionalXmlTagNameInput, normalizeScopeTagBuiltinDismissedList, normalizeScopeTagCollapsedGroupList, normalizeScopeTagGroupList } from './src/scope/model.js';
import { isTauriTavernHost, waitForTauriTavernReady } from './src/integrations/tauriTavern.js';
import { isBaiBaiToolkitInstalled } from './src/integrations/baiBai.js';
import { isLoreFrameInstalled } from './src/integrations/loreFrame.js';
import { normalizeZhVariantSettings, restoreZhDictionaryPackageFromCache } from './src/zh/dictionary.js';
import { createDefaultSettings, ensureSettingsShape, legacySettingsCopiedThisBoot, maybeCopyLegacySettings, maybeImportModifiedSettingsIntoSharedNamespace, migrateOldData, modifiedSettingsImportedThisBoot, needsCustomGlobalPromptMigrationConfirmation, resolveCustomGlobalPromptMigration } from './src/settings/migration.js';
import { syncComposerButtonScript } from './src/aiRewrite/composerButton.js';
import { collectInstalledEnabledExtensions } from './src/feedback/payload.js';

const { extension_settings, getContext: getSillyTavernContext } = extensionsModule;
const veridisExternalId = 'third-party/Veridis-Rewrite';
let isBooted = false;

function getCoarsePlatform() {
    const platform = String(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || '').toLowerCase();
    if (platform.includes('win')) return 'Windows';
    if (platform.includes('android')) return 'Android';
    if (platform.includes('iphone') || platform.includes('ipad') || platform.includes('ios')) return 'iOS';
    if (platform.includes('mac')) return 'macOS';
    if (platform.includes('linux')) return 'Linux';
    return 'Unknown';
}

initAppContext({
    extension_settings,
    saveSettingsDebounced,
    eventSource,
    event_types,
    getStreamingProcessor: () => scriptModule.streamingProcessor,
    saveChat: scriptModule.saveChat,
    chat,
    getSillyTavernContext,
    markWindowedChatDirtyFromIndex: scriptModule.markWindowedChatDirtyFromIndex,
    getWorldInfoState: () => world_info,
    setWorldInfoCache: (name, data) => worldInfoCache.set(name, data),
    getCurrentPersonaIdentity: () => user_avatar,
    getVeridisVersion: () => extensionsModule.getExtensionManifest(veridisExternalId)?.version || '',
    getSillyTavernVersion: () => scriptModule.CLIENT_VERSION,
    getAiRewriteDiagnosticConfig: () => {
        const aiRewrite = extension_settings[extensionName].aiRewrite;
        return {
            model: aiRewrite.model,
            temperature: aiRewrite.temperature,
            topP: aiRewrite.topP,
            topK: aiRewrite.topK,
            frequencyPenalty: aiRewrite.frequencyPenalty,
            presencePenalty: aiRewrite.presencePenalty,
            repetitionPenalty: aiRewrite.repetitionPenalty,
            maxTokens: aiRewrite.maxTokens,
            timeoutMs: aiRewrite.timeoutMs,
            maxRetries: aiRewrite.maxRetries,
            maxItemsPerRequest: aiRewrite.maxItemsPerRequest,
            maxContextChars: aiRewrite.maxContextChars,
        };
    },
    getCoarsePlatform,
    getInstalledEnabledExtensions: () => collectInstalledEnabledExtensions({
        extensionNames: extensionsModule.extensionNames,
        extensionTypes: extensionsModule.extensionTypes,
        disabledExtensions: extension_settings.disabledExtensions,
        getExtensionManifest: extensionsModule.getExtensionManifest,
        veridisExternalId,
    }),
});

jQuery(() => {
    if (isBooted) return;
    extension_settings[extensionName] = extension_settings[extensionName] || createDefaultSettings();

    maybeImportModifiedSettingsIntoSharedNamespace();
    maybeCopyLegacySettings();
    migrateOldData();
    ensureSettingsShape();

    const boot = async () => {
        if (isBooted) return;
        isBooted = true;
        await waitForTauriTavernReady();
        logger.info('[屏蔽词净化助手] 启动初始化开始...');
        if (isTauriTavernHost()) logger.info('[屏蔽词净化助手] 已启用 TauriTavern 兼容层');
        if (isBaiBaiToolkitInstalled()) logger.info('[屏蔽词净化助手] 已启用柏宝箱兼容层');
        if (isLoreFrameInstalled()) logger.info('[屏蔽词净化助手] 已启用 LoreFrame 兼容层');
        await setupUI(extensionsModule.renderExtensionTemplateAsync);
        const aiRewrite = extension_settings[extensionName].aiRewrite;
        if (needsCustomGlobalPromptMigrationConfirmation(aiRewrite)) {
            const accepted = await showRiskConfirmModal('【屏蔽词净化助手 AI 改写版】的全局提示词写法已经更新。检测到你当前使用的是自定义提示词，是否应用新版默认全局提示词？');
            resolveCustomGlobalPromptMigration(aiRewrite, accepted);
            saveSettingsDebounced();
        }
        if (modifiedSettingsImportedThisBoot === true) {
            setTimeout(() => showToast('已导入旧改版的规则、预设与 AI 配置'), 250);
        } else if (legacySettingsCopiedThisBoot === true) {
            setTimeout(() => showToast('已复制旧版规则与预设到 AI 改写版'), 250);
        }
        bindEvents();
        syncComposerButtonScript(extension_settings[extensionName].showComposerAiRewriteButton);
        initRealtimeInterceptor();
        updateToolbarUI();
        applyCharacterPresetBinding(true);
        restoreDiffStateFromChatMetadata();
        performGlobalChatMaintenance();
        logger.info('[屏蔽词净化助手] 启动初始化完成');
    };

    if (typeof eventSource !== 'undefined' && event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, () => {
            return boot();
        });
        if (document.getElementById('send_textarea')) boot();
    }
});
