/**
 * Owns application of a selected/effective Preset to authoritative Veridis settings,
 * including Rule/AI-generation snapshot application and persistence. It does not own
 * Preset event registration.
 */
import { defaultAiRewriteSettings, extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { markRulesDataDirty } from '../rules/state.js';
import { presetsRuntimeState } from './state.js';
import { logger } from '../log.js';
import { getCurrentCharacterContext, getCurrentChatCompletionPresetName } from '../host/context.js';
import { deepClone } from './model.js';
import { renderTags } from '../rules/view.js';
import { getCurrentPresetAiRewriteSettings, getPresetAiRewriteSettings, getPresetRules } from './model.js';
import { getPresetForCharacter } from './bindings.js';
import { refreshCharacterBindingUI, syncPresetAiRewriteGenerationSettingsUI, updateToolbarUI } from './view.js';

function normalizeRulesForPresetComparison(rules) {
    return (Array.isArray(rules) ? rules : []).map((rule) => {
        const normalized = deepClone(rule || {});
        delete normalized.enabled;
        return normalized;
    });
}

function hasPresetContentChanges(currentRules, savedPresetEntry, currentAiRewrite) {
    const rulesChanged = JSON.stringify(normalizeRulesForPresetComparison(currentRules))
        !== JSON.stringify(normalizeRulesForPresetComparison(getPresetRules(savedPresetEntry)));
    if (rulesChanged) return true;

    const savedAiRewrite = getPresetAiRewriteSettings(savedPresetEntry);
    if (!savedAiRewrite) return false;
    return JSON.stringify(getCurrentPresetAiRewriteSettings(currentAiRewrite)) !== JSON.stringify(savedAiRewrite);
}

export function hasActivePresetUnsavedChanges() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const active = settings.activePreset;
    if (!active) return false;
    return hasPresetContentChanges(settings.rules || [], settings.presets[active] || [], settings.aiRewrite);
}

function applyPresetAiRewriteSettings(settings, presetEntry) {
    const presetAiRewrite = getPresetAiRewriteSettings(presetEntry);
    if (!presetAiRewrite) return;
    settings.aiRewrite = {
        ...defaultAiRewriteSettings,
        ...(settings.aiRewrite && typeof settings.aiRewrite === 'object' ? settings.aiRewrite : {}),
        ...presetAiRewrite,
    };
    syncPresetAiRewriteGenerationSettingsUI(settings);
}

export function applyPresetByName(name, options = {}) {
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const settings = extension_settings[extensionName];
    const presetName = String(name || '');
    const presetExists = !!(presetName && settings.presets?.[presetName]);
    const presetEntry = presetExists ? settings.presets[presetName] : null;
    settings.activePreset = presetExists ? presetName : '';
    settings.rules = presetExists ? deepClone(getPresetRules(presetEntry)) : [];
    if (presetExists) applyPresetAiRewriteSettings(settings, presetEntry);
    markRulesDataDirty();
    saveSettingsDebounced();
    logger.info(`切换预设: ${presetName || '(临时规则)'}, 存在=${presetExists}`);
    if (!options.skipRender) {
        updateToolbarUI();
        renderTags();
    }
}

export function applyCharacterPresetBinding(force = false) {
    const { extension_settings } = getAppContext();
    const context = getCurrentCharacterContext();
    const chatCompletionPresetName = getCurrentChatCompletionPresetName();
    const bindingSignature = `${context.key || ''}\n${chatCompletionPresetName || ''}`;
    const bindingContextChanged = bindingSignature !== presetsRuntimeState.lastPresetBindingSignature;
    if (!force && !bindingContextChanged) return;
    presetsRuntimeState.lastPresetBindingSignature = bindingSignature;

    const presetName = getPresetForCharacter(context.key, { chatCompletionPresetName });
    if (presetName && presetName !== extension_settings[extensionName].activePreset) {
        applyPresetByName(presetName, { skipRender: true });
    }
    refreshCharacterBindingUI();
}
