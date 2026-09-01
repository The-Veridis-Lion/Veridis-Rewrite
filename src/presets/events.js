/**
 * Owns Preset user actions, import/export workflow, binding actions, and their
 * settings-save boundaries.
 */
import { defaultAiRewriteSettings, extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { markRulesDataDirty } from '../rules/state.js';
import { presetsRuntimeState, markPresetsUiDirty } from './state.js';
import { getCurrentChatCompletionPresetName, getCurrentCharacterContext } from '../host/context.js';
import { deepClone } from './model.js';
import { normalizeRuleActivationSafety } from '../rules/model.js';
import { buildPresetEntry, getCurrentPresetAiRewriteSettings, normalizeImportedRulesPayload, normalizePresetAiRewriteSettings } from './model.js';
import { getPresetBindingUsage } from './bindings.js';
import { applyCharacterPresetBinding, applyPresetByName, hasActivePresetUnsavedChanges } from './application.js';
import { refreshCharacterBindingUI, syncPresetAiRewriteGenerationSettingsUI, updateToolbarUI } from './view.js';
import { renderTags } from '../rules/view.js';
import { showRiskConfirmModal, showToast } from '../ui/notifications.js';

function removeBindingEntriesForPreset(bindingMap, presetName) {
    if (!bindingMap || typeof bindingMap !== 'object' || !presetName) return 0;
    let count = 0;
    Object.keys(bindingMap).forEach((key) => {
        if (bindingMap[key] === presetName) {
            delete bindingMap[key];
            count += 1;
        }
    });
    return count;
}

function buildCurrentPresetEntry(rules) {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    return buildPresetEntry(rules, getCurrentPresetAiRewriteSettings(settings.aiRewrite));
}

function extractPresetImportAiRewriteSettings(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const direct = normalizePresetAiRewriteSettings(payload.aiRewrite);
    if (direct) return direct;
    if ('__content__' in payload) return extractPresetImportAiRewriteSettings(payload.__content__);
    if ('content' in payload) return extractPresetImportAiRewriteSettings(payload.content);
    return null;
}

function normalizeImportedRuleList(rules) {
    return (Array.isArray(rules) ? rules : []).map((rule, idx) => {
        const next = normalizeRuleActivationSafety(deepClone(rule || {}), { resetRiskyEnabled: true });
        stripAiConnectionFields(next);
        if (!next.name) next.name = next.targets?.[0] || `未命名合集 ${idx + 1}`;
        if (next.targets) {
            next.subRules = [{
                targets: next.targets,
                replacements: next.replacements || [],
                mode: 'text',
                enabled: true,
            }];
            delete next.targets;
            delete next.replacements;
        }
        if (!Array.isArray(next.subRules)) next.subRules = [];
        next.subRules = next.subRules.map((sub) => {
            const normalizedSub = deepClone(sub || {});
            if (!normalizedSub.mode) normalizedSub.mode = 'text';
            if (!['program', 'ai'].includes(normalizedSub.rewriteMode)) normalizedSub.rewriteMode = 'program';
            if (normalizedSub.enabled === undefined) normalizedSub.enabled = true;
            if (!Array.isArray(normalizedSub.targets)) normalizedSub.targets = [];
            if (!Array.isArray(normalizedSub.replacements)) normalizedSub.replacements = [];
            normalizedSub.aiPromptTemplate = String(normalizedSub.aiPromptTemplate || '');
            return normalizedSub;
        });
        return next;
    });
}

function stripAiConnectionFields(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
        value.forEach(stripAiConnectionFields);
        return value;
    }
    delete value.baseUrl;
    delete value.apiKey;
    delete value.model;
    delete value.modelOptions;
    delete value.xmlScopeTag;
    Object.values(value).forEach(stripAiConnectionFields);
    return value;
}

function buildPresetExportRules(rules) {
    return stripAiConnectionFields(deepClone(Array.isArray(rules) ? rules : []));
}

function buildPresetExportPayload(settings) {
    return {
        type: 'veridis-rewrite-preset',
        version: 2,
        ...buildPresetEntry(buildPresetExportRules(settings.rules), getCurrentPresetAiRewriteSettings(settings.aiRewrite)),
    };
}

function makeUniquePresetName(baseName) {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const base = String(baseName || '').trim() || '导入预设';
    if (!settings.presets?.[base]) return base;
    let counter = 2;
    while (settings.presets?.[`${base} (${counter})`]) counter++;
    return `${base} (${counter})`;
}

function getImportPresetName() {
    return String($('#blai-import-preset-name').val() || '').trim();
}

function closeImportChoiceModal() {
    presetsRuntimeState.importPresetDraft = null;
    $('#blai-preset-import-choice-modal')
        .removeClass('blai-is-open')
        .attr('aria-hidden', 'true')
        .hide();
}

function openImportChoiceModal(rules, defaultName, aiRewriteSettings = null) {
    const normalizedRules = normalizeImportedRuleList(rules);
    if (normalizedRules.length === 0) {
        alert('导入失败：未发现有效规则。');
        return;
    }
    const presetName = makeUniquePresetName(defaultName);
    presetsRuntimeState.importPresetDraft = {
        rules: normalizedRules,
        defaultName: presetName,
        aiRewrite: normalizePresetAiRewriteSettings(aiRewriteSettings),
    };
    $('#blai-import-preset-name').val(presetName);
    const aiSummary = presetsRuntimeState.importPresetDraft.aiRewrite ? '，包含 AI 生成限制' : '';
    $('#blai-import-choice-summary').text(`已读取 ${normalizedRules.length} 个规则分组${aiSummary}。只导入不会修改当前规则；切换使用和临时预览会替换当前规则并重新净化。`);
    const $modal = $('#blai-preset-import-choice-modal');
    $modal.detach().appendTo(document.body);
    $modal
        .attr('aria-hidden', 'false')
        .addClass('blai-is-open')
        .css('display', 'flex');
    // iOS browsers sometimes need a layout pass after the file picker returns.
    $modal[0]?.getBoundingClientRect();
    window.setTimeout(() => $('#blai-import-preset-name').trigger('focus').trigger('select'), 50);
}

function confirmBeforeImportChoiceIfUnsaved() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const active = settings.activePreset;
    if (!active || !hasActivePresetUnsavedChanges()) return true;
    return confirm(`当前预设 "${active}" 有未保存的改动。\n\n只导入为新预设不会修改当前规则；导入并切换或临时预览会在执行前再次确认保存。\n\n是否继续选择导入方式？`);
}

function validateImportPresetName() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const name = getImportPresetName();
    if (!name) {
        alert('请填写预设名称。');
        $('#blai-import-preset-name').trigger('focus');
        return '';
    }
    if (settings.presets?.[name]) {
        alert('存档名称已存在，请换一个名称。');
        $('#blai-import-preset-name').trigger('focus').trigger('select');
        return '';
    }
    return name;
}

function confirmUnsavedBeforeReplacingCurrentRules(actionLabel) {
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const settings = extension_settings[extensionName];
    const active = settings.activePreset;
    if (!active || !hasActivePresetUnsavedChanges()) return true;
    const shouldSave = confirm(`当前预设 "${active}" 有未保存的改动。\n\n点击“确定”先保存并继续${actionLabel}。\n点击“取消”将取消本次导入操作。`);
    if (!shouldSave) return false;
    settings.presets[active] = buildCurrentPresetEntry(settings.rules || []);
    saveSettingsDebounced();
    markPresetsUiDirty(true);
    return true;
}

function getImportDraftRules() {
    const draft = presetsRuntimeState.importPresetDraft;
    return Array.isArray(draft?.rules) ? deepClone(draft.rules) : null;
}

function getImportDraftAiRewriteSettings() {
    return normalizePresetAiRewriteSettings(presetsRuntimeState.importPresetDraft?.aiRewrite);
}

function applyImportDraftAiRewriteSettings() {
    const aiRewriteSettings = getImportDraftAiRewriteSettings();
    if (!aiRewriteSettings) return false;
    const { extension_settings } = getAppContext();
    const currentSettings = extension_settings[extensionName];
    currentSettings.aiRewrite = {
        ...defaultAiRewriteSettings,
        ...(currentSettings.aiRewrite && typeof currentSettings.aiRewrite === 'object' ? currentSettings.aiRewrite : {}),
        ...aiRewriteSettings,
    };
    syncPresetAiRewriteGenerationSettingsUI(currentSettings);
    return true;
}

function importPresetOnly() {
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const settings = extension_settings[extensionName];
    const rules = getImportDraftRules();
    if (!rules) return;
    const name = validateImportPresetName();
    if (!name) return;

    settings.presets[name] = buildPresetEntry(rules, getImportDraftAiRewriteSettings());
    markPresetsUiDirty(true);
    saveSettingsDebounced();
    updateToolbarUI();
    closeImportChoiceModal();
    showToast(`已导入预设：${name}`);
}

function importPresetAndSwitch() {
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const settings = extension_settings[extensionName];
    const rules = getImportDraftRules();
    if (!rules) return;
    const name = validateImportPresetName();
    if (!name) return;
    if (!confirmUnsavedBeforeReplacingCurrentRules('并切换使用导入预设')) return;

    settings.presets[name] = buildPresetEntry(rules, getImportDraftAiRewriteSettings());
    settings.activePreset = name;
    settings.rules = deepClone(rules);
    applyImportDraftAiRewriteSettings();
    markRulesDataDirty({ presetsUi: true });
    saveSettingsDebounced();
    updateToolbarUI();
    renderTags();
    closeImportChoiceModal();
    showToast(`已导入并切换：${name}`);
}

function importPresetAsTemporaryPreview() {
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const settings = extension_settings[extensionName];
    const rules = getImportDraftRules();
    if (!rules) return;
    if (!confirm('仅临时预览会立刻替换当前规则，但不会保存为预设。\n确定继续吗？')) return;
    if (!confirmUnsavedBeforeReplacingCurrentRules('并进入临时预览')) return;

    settings.rules = rules;
    settings.activePreset = '';
    applyImportDraftAiRewriteSettings();
    markRulesDataDirty();
    saveSettingsDebounced();
    updateToolbarUI();
    renderTags();
    closeImportChoiceModal();
    showToast('已进入临时规则预览');
}

export function bindPresetEvents() {
    const { extension_settings, saveSettingsDebounced } = getAppContext();

    $(document).off('click.blaiBindMenu').on('click.blaiBindMenu', function(e) {
        if ($(e.target).closest('.blai-bind-menu-wrap').length > 0) return;
        $('#blai-bind-menu').prop('hidden', true);
        $('#blai-character-bind-toggle').attr('aria-expanded', 'false');
    });

    $(document).off('change', '#blai-preset-select, #blai-tools-preset-select').on('change', '#blai-preset-select, #blai-tools-preset-select', function() {
        const settings = extension_settings[extensionName];
        const oldPreset = settings.activePreset;
        const newPreset = $(this).val();

        if (oldPreset && newPreset !== oldPreset && hasActivePresetUnsavedChanges()) {
            if (confirm(`预设 "${oldPreset}" 有未保存的规则或 AI 生成限制改动，是否在切换前保存？\n点击【确定】保存，点击【取消】放弃改动。`)) {
                settings.presets[oldPreset] = buildCurrentPresetEntry(settings.rules);
                saveSettingsDebounced();
            }
        }

        applyPresetByName(newPreset, { skipRender: true });
        $('#blai-preset-select, #blai-tools-preset-select').val(newPreset);
        renderTags();
        refreshCharacterBindingUI();
    });

    $(document).off('click', '#blai-default-toggle').on('click', '#blai-default-toggle', function() {
        const settings = extension_settings[extensionName];
        const activePreset = String(settings.activePreset || '');
        if (!activePreset) { refreshCharacterBindingUI(); return; }
        const isDefaultActive = settings.defaultPreset === activePreset;
        settings.defaultPreset = isDefaultActive ? '' : activePreset;
        saveSettingsDebounced();
        refreshCharacterBindingUI();
    });

    $(document).off('click', '#blai-character-bind-toggle').on('click', '#blai-character-bind-toggle', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const $menu = $('#blai-bind-menu');
        const shouldOpen = $menu.prop('hidden');
        $menu.prop('hidden', !shouldOpen);
        $(this).attr('aria-expanded', String(shouldOpen));
        refreshCharacterBindingUI();
    });

    $(document).off('click', '.blai-bind-menu-item').on('click', '.blai-bind-menu-item', async function(e) {
        e.preventDefault();
        e.stopPropagation();
        if ($(this).prop('disabled')) return;
        const settings = extension_settings[extensionName];
        const action = String($(this).attr('data-bind-action') || '');
        const activePreset = String(settings.activePreset || '');
        const context = getCurrentCharacterContext();
        const chatCompletionPresetName = getCurrentChatCompletionPresetName();
        const activeUsage = getPresetBindingUsage(activePreset);

        if (action === 'character') {
            if (!activePreset || !context.key) { refreshCharacterBindingUI(); return; }
            if (activeUsage.hasChatCompletionPresetBindings && settings.characterBindings?.[context.key] !== activePreset) {
                const shouldSwitch = await showRiskConfirmModal(`净化预设「${activePreset}」当前已绑定到预设，不能同时绑定到角色卡。是否取消原绑定并切换？`);
                if (!shouldSwitch) {
                    refreshCharacterBindingUI();
                    return;
                }
                removeBindingEntriesForPreset(settings.chatCompletionPresetBindings, activePreset);
            }
            if (!settings.characterBindings) settings.characterBindings = {};
            settings.characterBindings[context.key] = activePreset;
            presetsRuntimeState.lastPresetBindingSignature = '';
            applyPresetByName(activePreset, { skipRender: true });
            saveSettingsDebounced();
            refreshCharacterBindingUI();
            $('#blai-bind-menu').prop('hidden', true);
            $('#blai-character-bind-toggle').attr('aria-expanded', 'false');
            return;
        }

        if (action === 'chat-preset') {
            if (!activePreset || !chatCompletionPresetName) { refreshCharacterBindingUI(); return; }
            if (activeUsage.hasCharacterBindings && settings.chatCompletionPresetBindings?.[chatCompletionPresetName] !== activePreset) {
                const shouldSwitch = await showRiskConfirmModal(`净化预设「${activePreset}」当前已绑定到角色卡，不能同时绑定到预设。是否取消原绑定并切换？`);
                if (!shouldSwitch) {
                    refreshCharacterBindingUI();
                    return;
                }
                removeBindingEntriesForPreset(settings.characterBindings, activePreset);
            }
            if (!settings.chatCompletionPresetBindings || typeof settings.chatCompletionPresetBindings !== 'object') settings.chatCompletionPresetBindings = {};
            settings.chatCompletionPresetBindings[chatCompletionPresetName] = activePreset;
            presetsRuntimeState.lastPresetBindingSignature = '';
            applyPresetByName(activePreset, { skipRender: true });
            saveSettingsDebounced();
            refreshCharacterBindingUI();
            $('#blai-bind-menu').prop('hidden', true);
            $('#blai-character-bind-toggle').attr('aria-expanded', 'false');
            return;
        }

        if (action === 'unbind-character') {
            const removedRolePreset = context.key ? settings.characterBindings?.[context.key] : '';
            const removedChatPreset = chatCompletionPresetName ? settings.chatCompletionPresetBindings?.[chatCompletionPresetName] : '';
            if (removedRolePreset) {
                delete settings.characterBindings[context.key];
            } else if (removedChatPreset) {
                delete settings.chatCompletionPresetBindings[chatCompletionPresetName];
            } else {
                refreshCharacterBindingUI();
                return;
            }
            presetsRuntimeState.lastPresetBindingSignature = '';
            applyCharacterPresetBinding(true);
            saveSettingsDebounced();
            refreshCharacterBindingUI();
            $('#blai-bind-menu').prop('hidden', true);
            $('#blai-character-bind-toggle').attr('aria-expanded', 'false');
            return;
        }
    });

    $(document).off('click', '#blai-preset-rename').on('click', '#blai-preset-rename', function() {
        const settings = extension_settings[extensionName];
        const oldName = settings.activePreset;
        if (!oldName) { alert('当前为临时规则，请先新建存档。'); return; }
        const newName = prompt('输入新存档名称：', oldName);
        if (!newName || newName === oldName) return;
        if (settings.presets[newName]) { alert('存档名称已存在。'); return; }
        settings.presets[newName] = settings.presets[oldName];
        delete settings.presets[oldName];
        if (settings.defaultPreset === oldName) settings.defaultPreset = newName;
        Object.keys(settings.characterBindings || {}).forEach((key) => {
            if (settings.characterBindings[key] === oldName) settings.characterBindings[key] = newName;
        });
        Object.keys(settings.chatCompletionPresetBindings || {}).forEach((name) => {
            if (settings.chatCompletionPresetBindings[name] === oldName) settings.chatCompletionPresetBindings[name] = newName;
        });
        settings.activePreset = newName;
        markPresetsUiDirty(true);
        saveSettingsDebounced();
        updateToolbarUI();
        showToast(`已重命名为：${newName}`);
    });

    $(document).off('click', '#blai-preset-delete').on('click', '#blai-preset-delete', function() {
        const settings = extension_settings[extensionName];
        const name = settings.activePreset;
        if (!name) { showToast('当前为临时规则，没有可删除的存档'); return; }
        if (confirm(`确定删除存档 "${name}" 吗？`)) {
            delete settings.presets[name];
            if (settings.defaultPreset === name) settings.defaultPreset = '';
            Object.keys(settings.characterBindings || {}).forEach((key) => {
                if (settings.characterBindings[key] === name) delete settings.characterBindings[key];
            });
            Object.keys(settings.chatCompletionPresetBindings || {}).forEach((presetName) => {
                if (settings.chatCompletionPresetBindings[presetName] === name) delete settings.chatCompletionPresetBindings[presetName];
            });
            settings.activePreset = '';
            settings.rules = [];
            markRulesDataDirty({ presetsUi: true });
            saveSettingsDebounced();
            renderTags();
            updateToolbarUI();
            showToast('删除成功');
        }
    });

    $(document).off('click', '#blai-preset-new').on('click', '#blai-preset-new', function() {
        const settings = extension_settings[extensionName];
        const name = prompt('输入新存档名称：');
        if (!name) return;
        if (settings.presets[name]) { alert('存档名称已存在。'); return; }
        settings.presets[name] = buildCurrentPresetEntry([]);
        settings.activePreset = name;
        settings.rules = [];
        markRulesDataDirty({ presetsUi: true });
        saveSettingsDebounced();
        updateToolbarUI();
        renderTags(); // 必须重新渲染以清空列表
        showToast(`已新建存档：${name}`);
    });

    $(document).off('click', '#blai-preset-save').on('click', '#blai-preset-save', function() {
        const settings = extension_settings[extensionName];
        if (!settings.activePreset) { showToast('当前为临时规则，请点击“新建”保存为新存档。'); return; }
        settings.presets[settings.activePreset] = buildCurrentPresetEntry(settings.rules);
        saveSettingsDebounced();
        showToast('保存成功');
    });

    $(document).off('click', '#blai-preset-export').on('click', '#blai-preset-export', function() {
        const settings = extension_settings[extensionName];
        const data = JSON.stringify(buildPresetExportPayload(settings), null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (settings.activePreset || '临时规则') + '.json';
        a.click();
        URL.revokeObjectURL(url);
        showToast(`已导出：${a.download}`);
    });

    $(document).off('click', '#blai-preset-import').on('click', '#blai-preset-import', function() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.style.position = 'fixed';
        input.style.left = '-1000px';
        input.style.top = '0';
        input.style.width = '1px';
        input.style.height = '1px';
        input.style.opacity = '0';
        input.style.pointerEvents = 'none';
        document.body.appendChild(input);
        const cleanupInput = () => {
            window.setTimeout(() => {
                if (input.parentNode) input.parentNode.removeChild(input);
            }, 0);
        };
        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) {
                cleanupInput();
                return;
            }
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const importedPayload = JSON.parse(event.target.result);
                    const importedRules = normalizeImportedRulesPayload(importedPayload);
                    if (!Array.isArray(importedRules)) throw new Error('格式非数组');
                    const importedAiRewriteSettings = extractPresetImportAiRewriteSettings(importedPayload);

                    const defaultName = file.name.replace(/\.json$/i, '');
                    if (!confirmBeforeImportChoiceIfUnsaved()) return;
                    openImportChoiceModal(importedRules, defaultName, importedAiRewriteSettings);
                } catch (err) {
                    alert('导入失败：检查文件是否为合法规则数组。');
                } finally {
                    cleanupInput();
                }
            };
            reader.onerror = cleanupInput;
            reader.readAsText(file);
        };
        input.click();
        window.setTimeout(cleanupInput, 120000);
    });

    $(document).off('click', '#blai-import-only').on('click', '#blai-import-only', () => importPresetOnly());
    $(document).off('click', '#blai-import-switch').on('click', '#blai-import-switch', () => importPresetAndSwitch());
    $(document).off('click', '#blai-import-preview').on('click', '#blai-import-preview', () => importPresetAsTemporaryPreview());
    $(document).off('click', '#blai-import-choice-close').on('click', '#blai-import-choice-close', () => closeImportChoiceModal());
    $(document).off('click', '#blai-preset-import-choice-modal').on('click', '#blai-preset-import-choice-modal', function(e) {
        if (e.target && e.target.id === 'blai-preset-import-choice-modal') closeImportChoiceModal();
    });
    $(document).off('keydown', '#blai-import-preset-name').on('keydown', '#blai-import-preset-name', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            importPresetOnly();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            closeImportChoiceModal();
        }
    });
}
