import { extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { getCurrentChatCompletionPresetName, getSillyTavernContextSnapshot } from '../host/context.js';

// Binding resolution and cleanup semantics; no UI and no persistence scheduling.

export function getPresetBindingUsage(presetName) {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const target = String(presetName || '');
    const usage = {
        characterKeys: [],
        chatCompletionPresetNames: [],
        hasCharacterBindings: false,
        hasChatCompletionPresetBindings: false,
    };
    if (!settings || !target) return usage;

    Object.entries(settings.characterBindings || {}).forEach(([key, preset]) => {
        if (preset === target) usage.characterKeys.push(key);
    });
    Object.entries(settings.chatCompletionPresetBindings || {}).forEach(([name, preset]) => {
        if (preset === target) usage.chatCompletionPresetNames.push(name);
    });

    usage.hasCharacterBindings = usage.characterKeys.length > 0;
    usage.hasChatCompletionPresetBindings = usage.chatCompletionPresetNames.length > 0;
    return usage;
}

export function getPresetBindingInspection() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const presets = settings?.presets || {};
    const characters = getSillyTavernContextSnapshot()?.characters;
    const characterBindings = Object.entries(settings?.characterBindings || {})
        .map(([key, presetName]) => {
            if (!key.startsWith('chid:') || !presets[presetName]) return null;
            const characterId = key.slice('chid:'.length).trim();
            const character = Array.isArray(characters) ? characters[characterId] : null;
            const name = String(character?.name || '').trim();
            return character && name ? { name, presetName } : null;
        })
        .filter(Boolean);
    const chatCompletionPresetBindings = Object.entries(settings?.chatCompletionPresetBindings || {})
        .filter(([, presetName]) => !!presets[presetName])
        .map(([name, presetName]) => ({ name, presetName }));
    return { characterBindings, chatCompletionPresetBindings };
}

export function getPresetBindingResolution(characterKey = '', options = {}) {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const presets = settings?.presets || {};
    if (!settings) {
        return { presetName: '', source: '', chatCompletionPresetName: '', characterPreset: '', chatCompletionPreset: '' };
    }

    const chatCompletionPresetName = options.chatCompletionPresetName !== undefined
        ? String(options.chatCompletionPresetName || '').trim()
        : getCurrentChatCompletionPresetName();
    const characterPreset = characterKey ? String(settings.characterBindings?.[characterKey] || '') : '';
    const chatCompletionPreset = chatCompletionPresetName
        ? String(settings.chatCompletionPresetBindings?.[chatCompletionPresetName] || '')
        : '';
    const defaultPreset = String(settings.defaultPreset || '');

    if (characterPreset && presets[characterPreset]) {
        return { presetName: characterPreset, source: 'character', chatCompletionPresetName, characterPreset, chatCompletionPreset };
    }
    if (chatCompletionPreset && presets[chatCompletionPreset]) {
        return { presetName: chatCompletionPreset, source: 'chatCompletionPreset', chatCompletionPresetName, characterPreset, chatCompletionPreset };
    }
    if (defaultPreset && presets[defaultPreset]) {
        return { presetName: defaultPreset, source: 'default', chatCompletionPresetName, characterPreset, chatCompletionPreset };
    }
    return { presetName: '', source: '', chatCompletionPresetName, characterPreset, chatCompletionPreset };
}

export function getPresetForCharacter(characterKey, options = {}) {
    return getPresetBindingResolution(characterKey, options).presetName;
}

export function cleanupInvalidPresetBindings() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const presets = settings.presets || {};
    if (settings.defaultPreset && !presets[settings.defaultPreset]) settings.defaultPreset = '';
    if (!settings.characterBindings || typeof settings.characterBindings !== 'object') {
        settings.characterBindings = {};
    }
    if (!settings.chatCompletionPresetBindings || typeof settings.chatCompletionPresetBindings !== 'object') {
        settings.chatCompletionPresetBindings = {};
    }

    Object.keys(settings.characterBindings).forEach((key) => {
        const preset = settings.characterBindings[key];
        if (!preset || !presets[preset]) delete settings.characterBindings[key];
    });
    Object.keys(settings.chatCompletionPresetBindings).forEach((name) => {
        const preset = settings.chatCompletionPresetBindings[name];
        if (!preset || !presets[preset]) delete settings.chatCompletionPresetBindings[name];
    });
}
