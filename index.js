import * as extensionsModule from "../../../extensions.js";
import * as scriptModule from "../../../../script.js";
import { saveSettingsDebounced, eventSource, event_types, chat_metadata, chat } from "../../../../script.js";

import { aiRewritePromptProtocolVersion, defaultAiRewriteSettings, defaultSettings, extensionName, modifiedExtensionName, legacyExtensionName, initAppContext, runtimeState, markRulesDataDirty, normalizeAiSamplingSettings, normalizeDiffTrackedMessageLimit } from './src/state.js';
import { logger } from './src/log.js';
import { bindEvents, initRealtimeInterceptor } from './src/events.js';
import { setupUI, updateToolbarUI, applyCharacterPresetBinding, cleanupInvalidPresetBindings, showToast } from './src/ui.js';
import { restoreDiffStateFromChatMetadata, injectDiffButtons } from './src/diff.js';
import { performGlobalCleanse } from './src/core.js';
import { buildPresetEntry, getCurrentPresetAiRewriteSettings, getPresetAiRewriteSettings, getPresetRules, mergeScopeTagsWithBuiltins, normalizeOptionalXmlTagNameInput, normalizeRuleActivationSafety, normalizeScopeTagBuiltinDismissedList, normalizeScopeTagCollapsedGroupList, normalizeScopeTagGroupList } from './src/utils.js';
import { isBaiBaiToolkitInstalled, isLoreFrameInstalled, isTauriTavernHost, waitForTauriTavernReady } from './src/platform.js';
import { normalizeZhVariantSettings, restoreZhDictionaryPackageFromCache } from './src/zhConversion.js';
import { createDefaultSettings, ensureSettingsShape, maybeCopyLegacySettings, maybeImportModifiedSettingsIntoSharedNamespace, migrateOldData } from './src/settingsMigration.js';
import { syncComposerButtonScript } from './src/composerButton.js';

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

jQuery(() => {
    if (runtimeState.isBooted) return;
    extension_settings[extensionName] = extension_settings[extensionName] || createDefaultSettings();

    maybeImportModifiedSettingsIntoSharedNamespace();
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
        await setupUI(extensionsModule.renderExtensionTemplateAsync);
        if (runtimeState.modifiedSettingsImportedThisBoot === true) {
            setTimeout(() => showToast('已导入旧改版的规则、预设与 AI 配置'), 250);
        } else if (runtimeState.legacySettingsCopiedThisBoot === true) {
            setTimeout(() => showToast('已复制旧版规则与预设到 AI 改写版'), 250);
        }
        bindEvents();
        syncComposerButtonScript(extension_settings[extensionName].showComposerAiRewriteButton);
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
        eventSource.on(event_types.APP_READY, () => {
            return boot();
        });
        if (document.getElementById('send_textarea')) boot();
    }
});
