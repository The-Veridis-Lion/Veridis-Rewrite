import { defaultAiRewriteSettings, extensionName, getAppContext, runtimeState, markRulesDataDirty, markPresetsUiDirty } from './state.js';
import { logger } from './log.js';
import { DEFAULT_SCOPE_TAG_GROUP_ID, buildPresetEntry, buildRuleActivationConfirmMessage, createScopeTagGroupId, createScopeTagId, deepClone, formatScopeTagInput, getBuiltinScopeTagKeyForStartTag, getCotScopeTagBuiltinKeys, getCurrentChatCompletionPresetName, getCurrentCharacterContext, getCurrentPresetAiRewriteSettings, getPresetAiRewriteSettings, getPresetBindingUsage, getPresetRules, getRuleActivationWarning, isCotScopeTagEntry, isRuleActivationWarningEnabled, mergeScopeTagsWithBuiltins, normalizeImportedRulesPayload, normalizePresetAiRewriteSettings, normalizeRuleActivationSafety, normalizeScopeTagBuiltinDismissedList, normalizeScopeTagCollapsedGroupList, normalizeScopeTagGroupList, normalizeScopeTagList, parseInputToWords, parseScopeTagInput, validateRegexTargetInput } from './utils.js';
import {
    applyPresetByName,
    closeScopeTagsModal,
    openScopeTagsModal,
    renderTags,
    renderScopeTagsModal,
    showResponsivePage,
    updateToolbarUI,
    updateLegacyPurifierWarning,
    renderSubrulesToModal,
    showConfirmModal,
    showRiskConfirmModal,
    showRiskInfoModal,
    refreshCharacterBindingUI,
    applyCharacterPresetBinding,
    focusLatestRuleCard,
    openSingleRuleModal,
    openTransferModal,
    closeTransferModal,
    runRuleTransfer,
    openEditModal,
    openRuleSearchModal,
    closeRuleSearchModal,
    renderRuleSearchModal,
    syncRuleSearchInputUi,
    clearRuleSearchEditFlow,
    showToast,
    removeRegexReplacementInput,
    startEditingRegexReplacementInput,
    recognizeRegexReplacementInput,
    hasPendingRegexReplacementInput,
    setSingleRuleReplacementEditor,
    getSingleRuleReplacementValues,
} from './ui.js';
import { performGlobalCleanse } from './core.js';
import { performDeepCleanse } from './cleanse.js';
import { syncPersonaDescriptionProtectionControl } from './dom.js';
import { normalizeZhVariantSettings } from './zhConversion.js';
import { bindHostLifecycleEvents, initRealtimeInterceptor, injectDiffButtonsStreamingSafe } from './events/hostLifecycle.js';
import { bindAiSettingsEvents } from './events/aiSettings.js';
import { bindDiffEvents } from './events/diff.js';
import { bindComposerButtonAiRewriteEvent, updateComposerButtonSetting } from './composerButton.js';
export { initRealtimeInterceptor, injectDiffButtonsStreamingSafe };

const ruleObjectIdMap = new WeakMap();
let nextRuleObjectId = 1;

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

function ensureRuleObjectId(rule) {
    if (!rule || typeof rule !== 'object') return '';
    let id = ruleObjectIdMap.get(rule);
    if (!id) {
        id = `rule-${nextRuleObjectId++}`;
        ruleObjectIdMap.set(rule, id);
    }
    return id;
}

function getRuleIdsByIndexes(rules, indexes) {
    return indexes.map((idx) => rules[idx]).filter(Boolean).map((rule) => ensureRuleObjectId(rule));
}

function getSelectedIndexesFromState(rules) {
    const selectedSet = new Set(runtimeState.batchSelectedRuleIds || []);
    return rules.map((rule, idx) => (selectedSet.has(ensureRuleObjectId(rule)) ? idx : -1)).filter((idx) => idx >= 0);
}

function syncBatchSelectionStateFromDom(rules) {
    const indexes = $('.batch-item-checkbox:checked').map(function() { return Number($(this).data('index')); }).get().filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < rules.length);
    runtimeState.batchSelectedRuleIds = getRuleIdsByIndexes(rules, indexes);
}

function applyBatchSelectionStateToDom(rules) {
    const selectedSet = new Set(runtimeState.batchSelectedRuleIds || []);
    $('.batch-item-checkbox').each(function() {
        const idx = Number($(this).data('index'));
        const rule = rules[idx];
        const checked = Boolean(rule) && selectedSet.has(ensureRuleObjectId(rule));
        $(this).prop('checked', checked);
    });
}

function getBatchOperationContext(clickedIndex, rules) {
    const isBatchMode = $('#blai-purifier-popup').hasClass('blai-is-batch-mode');
    const selectedIndexes = getSelectedIndexesFromState(rules);
    const selectedSet = new Set(selectedIndexes);
    const shouldBatch = isBatchMode && selectedIndexes.length > 1 && selectedSet.has(clickedIndex);
    return { isBatchMode, selectedIndexes, selectedSet, shouldBatch };
}

function shouldBatchTransferRule(clickedIndex, rules) {
    if (!Number.isInteger(clickedIndex) || clickedIndex < 0 || clickedIndex >= rules.length) return false;
    return getBatchOperationContext(clickedIndex, rules).shouldBatch;
}

function deleteSingleRule(rules, index) {
    const deletingRule = rules[index];
    if (!deletingRule) return false;
    const deletingId = ensureRuleObjectId(deletingRule);
    rules.splice(index, 1);
    runtimeState.batchSelectedRuleIds = (runtimeState.batchSelectedRuleIds || []).filter((id) => id !== deletingId);
    return true;
}

function deleteSelectedRules(rules, selectedIndexes) {
    if (!Array.isArray(selectedIndexes) || selectedIndexes.length <= 1) return false;
    const deletingSet = new Set(selectedIndexes);
    const deletingIds = new Set(getRuleIdsByIndexes(rules, selectedIndexes));
    const nextRules = rules.filter((_, idx) => !deletingSet.has(idx));
    rules.splice(0, rules.length, ...nextRules);
    runtimeState.batchSelectedRuleIds = (runtimeState.batchSelectedRuleIds || []).filter((id) => !deletingIds.has(id));
    return true;
}

function handleDeleteRule(index, rules) {
    if (shouldBatchTransferRule(index, rules)) {
        return deleteSelectedRules(rules, getSelectedIndexesFromState(rules));
    }
    return deleteSingleRule(rules, index);
}

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

function renderTagsPreserveBatchSelection() {
    const shell = document.getElementById('blai-purifier-popup');
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeElement.closest('#blai-tags-container')) {
        activeElement.blur();
    }
    if (shell) shell.scrollTop = 0;
    renderTags();
    const { extension_settings } = getAppContext();
    applyBatchSelectionStateToDom(extension_settings[extensionName]?.rules || []);
    if (shell) {
        shell.scrollTop = 0;
        window.requestAnimationFrame(() => {
            if (shell.isConnected) shell.scrollTop = 0;
        });
    }
}

function batchMoveRules(rules, selectedIndexes, direction) {
    if (selectedIndexes.length <= 1) return false;
    const selectedSet = new Set(selectedIndexes);
    const sorted = [...selectedIndexes].sort((a, b) => a - b);

    if (direction === 'up') {
        if (sorted[0] === 0) return false;
        for (let i = 0; i < sorted.length; i++) {
            const idx = sorted[i];
            const prev = idx - 1;
            if (prev >= 0 && !selectedSet.has(prev)) {
                [rules[prev], rules[idx]] = [rules[idx], rules[prev]];
                selectedSet.delete(idx);
                selectedSet.add(prev);
            }
        }
        return true;
    }

    if (direction === 'down') {
        if (sorted[sorted.length - 1] === rules.length - 1) return false;
        for (let i = sorted.length - 1; i >= 0; i--) {
            const idx = sorted[i];
            const next = idx + 1;
            if (next < rules.length && !selectedSet.has(next)) {
                [rules[idx], rules[next]] = [rules[next], rules[idx]];
                selectedSet.delete(idx);
                selectedSet.add(next);
            }
        }
        return true;
    }
    return false;
}


export function bindEvents() {

    function checkUnsavedChanges() {
        const settings = extension_settings[extensionName];
        const active = settings.activePreset;
        if (!active) return false;
        return hasPresetContentChanges(settings.rules || [], settings.presets[active] || [], settings.aiRewrite);
    }

    function buildCurrentPresetEntry(rules) {
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
        runtimeState.importPresetDraft = null;
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
        runtimeState.importPresetDraft = {
            rules: normalizedRules,
            defaultName: presetName,
            aiRewrite: normalizePresetAiRewriteSettings(aiRewriteSettings),
        };
        $('#blai-import-preset-name').val(presetName);
        const aiSummary = runtimeState.importPresetDraft.aiRewrite ? '，包含 AI 生成限制' : '';
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
        const settings = extension_settings[extensionName];
        const active = settings.activePreset;
        if (!active || !checkUnsavedChanges()) return true;
        return confirm(`当前预设 "${active}" 有未保存的改动。\n\n只导入为新预设不会修改当前规则；导入并切换或临时预览会在执行前再次确认保存。\n\n是否继续选择导入方式？`);
    }

    function validateImportPresetName() {
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
        const settings = extension_settings[extensionName];
        const active = settings.activePreset;
        if (!active || !checkUnsavedChanges()) return true;
        const shouldSave = confirm(`当前预设 "${active}" 有未保存的改动。\n\n点击“确定”先保存并继续${actionLabel}。\n点击“取消”将取消本次导入操作。`);
        if (!shouldSave) return false;
        settings.presets[active] = buildCurrentPresetEntry(settings.rules || []);
        saveSettingsDebounced();
        markPresetsUiDirty(true);
        return true;
    }

    function getImportDraftRules() {
        const draft = runtimeState.importPresetDraft;
        return Array.isArray(draft?.rules) ? deepClone(draft.rules) : null;
    }

    function getImportDraftAiRewriteSettings() {
        return normalizePresetAiRewriteSettings(runtimeState.importPresetDraft?.aiRewrite);
    }

    function applyImportDraftAiRewriteSettings() {
        const aiRewriteSettings = getImportDraftAiRewriteSettings();
        if (!aiRewriteSettings) return false;
        const currentSettings = extension_settings[extensionName];
        currentSettings.aiRewrite = {
            ...defaultAiRewriteSettings,
            ...(currentSettings.aiRewrite && typeof currentSettings.aiRewrite === 'object' ? currentSettings.aiRewrite : {}),
            ...aiRewriteSettings,
        };
        syncAiRewriteSettingsUI();
        return true;
    }

    function importPresetOnly() {
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
        performGlobalCleanse();
        closeImportChoiceModal();
        showToast(`已导入并切换：${name}`);
    }

    function importPresetAsTemporaryPreview() {
        const settings = extension_settings[extensionName];
        const rules = getImportDraftRules();
        if (!rules) return;
        if (!confirm('仅临时预览会立刻替换当前规则，但不会保存为预设。\n确定继续吗？')) return;
        if (!confirmUnsavedBeforeReplacingCurrentRules('并进入临时预览')) return;

        settings.rules = rules;
        settings.activePreset = "";
        applyImportDraftAiRewriteSettings();
        markRulesDataDirty();
        saveSettingsDebounced();
        updateToolbarUI();
        renderTags();
        performGlobalCleanse();
        closeImportChoiceModal();
        showToast('已进入临时规则预览');
    }

    const { extension_settings, saveSettingsDebounced, eventSource, event_types } = getAppContext();
    const formatRegexTargetError = (error) => `第 ${error.line} 行：${error.message}`;
    const clearRegexTargetValidationState = () => {
        $('#blai-modal-sub-target').removeClass('blai-invalid').removeAttr('aria-invalid');
        $('#blai-modal-sub-target-error').removeClass('is-visible').text('');
    };
    const applyRegexTargetValidationError = (error) => {
        const message = formatRegexTargetError(error);
        $('#blai-modal-sub-target').addClass('blai-invalid').attr('aria-invalid', 'true');
        $('#blai-modal-sub-target-error').addClass('is-visible').text(message);
        return message;
    };
    const subruleModeUIMap = {
        simple: {
            hint: '适合批量覆盖相近表达，支持 {} 组合和 * 通配。',
            targetPlaceholder: "简易语法 (每行一条)\n例如：{宛若,如同}{神明,恶魔}?",
            replacementPlaceholder: "替换后词汇（每行一条，支持随机，可留空）\n留空时，命中后会直接删除",
        },
        text: {
            hint: '按普通词组逐项替换，适合稳定短语，长词会优先处理。',
            targetPlaceholder: "被替换词汇 (逗号/空格分隔)\n例如：嘴角勾起, 并不存在",
            replacementPlaceholder: "替换后词汇（逗号/空格分隔，可留空）\n留空时，命中后会直接删除",
        },
        regex: {
            hint: '适合复杂匹配和捕获组替换；每次命中会从替换项里随机选一个。',
            targetPlaceholder: "正则匹配规则 (每行一条)\n支持裸模式 foo|bar 或 /foo|bar/gmu",
            replacementPlaceholder: "替换模板（每行一条，支持随机；可用 $1、\\n，可留空）\n点“按行识别”后加入下方替换项",
            regexEditPlaceholder: "正在编辑替换项；可用 $1、\\n\n点“更新替换项”保存修改",
        },
    };
    const validateRegexTargetField = (options = {}) => {
        const mode = String($('#blai-modal-sub-mode').val() || '');
        if (mode !== 'regex') {
            clearRegexTargetValidationState();
            return { ok: true, parsed: [] };
        }

        const result = validateRegexTargetInput($('#blai-modal-sub-target').val());
        if (result.ok) {
            clearRegexTargetValidationState();
            return result;
        }

        const uiMessage = applyRegexTargetValidationError(result.error);
        if (options.focus === true) $('#blai-modal-sub-target').trigger('focus');
        if (options.toast === true) showToast(`正则规则有误：${uiMessage}`);
        return { ...result, uiMessage };
    };
    const applySubruleModeUI = (rawMode) => {
        const mode = subruleModeUIMap[rawMode] ? rawMode : 'simple';
        const config = subruleModeUIMap[mode];
        const previousMode = String($('#blai-modal-sub-mode').data('current-mode') || '');
        if (previousMode && previousMode !== mode) {
            const previousReplacements = getSingleRuleReplacementValues(previousMode);
            setSingleRuleReplacementEditor(mode, previousReplacements);
        }
        $('#blai-modal-sub-mode').data('current-mode', mode);
        $('#blai-modal-sub-target').attr('placeholder', config.targetPlaceholder);
        $('#blai-modal-sub-rep').attr('placeholder', config.replacementPlaceholder);
        if (mode === 'regex') {
            $('#blai-modal-sub-rep')
                .data('regex-default-placeholder', config.replacementPlaceholder)
                .data('regex-edit-placeholder', config.regexEditPlaceholder || config.replacementPlaceholder);
            const activeEditIndex = Number($('#blai-modal-sub-rep').data('regex-edit-index'));
            $('#blai-modal-sub-regex-recognize').text(activeEditIndex >= 0 ? '更新替换项' : '按行识别');
            $('#blai-modal-sub-rep').attr('placeholder', activeEditIndex >= 0
                ? (config.regexEditPlaceholder || config.replacementPlaceholder)
                : config.replacementPlaceholder);
        } else {
            $('#blai-modal-sub-rep')
                .removeData('regex-default-placeholder')
                .removeData('regex-edit-placeholder');
        }
        $('#blai-modal-sub-mode-hint').text(config.hint);
        validateRegexTargetField();
    };
    const applySubruleRewriteModeUI = () => {
        const rewriteMode = $('#blai-modal-sub-rewrite-mode').val() === 'ai' ? 'ai' : 'program';
        const isAiMode = rewriteMode === 'ai';
        $('#blai-modal-sub-rep-label').text(isAiMode ? '流式临时替换 / API 参考候选' : '替换为');
        $('#blai-modal-sub-rewrite-hint').text(isAiMode
            ? '生成中只做视觉预览，生成结束后把命中片段发给配置的 AI 接口局部改写。'
            : '沿用当前本地替换逻辑，生成结束后直接写入消息数据。');
        $('#blai-modal-sub-ai-prompt-field').prop('hidden', !isAiMode);
        $('#blai-modal-sub-ai-prompt').prop('disabled', !isAiMode);
        $('#blai-modal-sub-ai-prompt-hint').text('只填写这条规则命中时的特殊处理；通用风格仍由全局提示词控制。');
    };
    const clearScopeTagValidationState = () => {
        $('#blai-scope-tag-input').removeClass('blai-invalid').removeAttr('aria-invalid');
        $('#blai-scope-tag-error').removeClass('is-visible').text('');
    };
    const applyScopeTagValidationError = (message) => {
        $('#blai-scope-tag-input').addClass('blai-invalid').attr('aria-invalid', 'true');
        $('#blai-scope-tag-error').addClass('is-visible').text(message);
    };
    const getScopeTagEditId = () => String($('#blai-scope-tag-input').data('scope-edit-id') || '');
    const resetScopeTagEditor = () => {
        $('#blai-scope-tag-input').val('').data('scope-edit-id', '');
        $('#blai-scope-tag-label-input').val('');
        $('#blai-scope-tag-group-select').val(DEFAULT_SCOPE_TAG_GROUP_ID);
        $('#blai-scope-tag-editor-modal')
            .removeClass('blai-is-open')
            .attr('aria-hidden', 'true');
        $('#blai-scope-tag-action-menu').prop('hidden', true);
        $('#blai-scope-tag-menu-open').attr('aria-expanded', 'false');
        clearScopeTagValidationState();
        renderScopeTagsModal();
    };
    const normalizeScopeTagDraftStart = (tagText) => {
        const trimmed = String(tagText || '').trim();
        if (/^<[^<>/\s]+>$/.test(trimmed)) return trimmed;
        return `<${trimmed.replace(/[<>]/g, '')}>`;
    };
    const buildScopeTagInputFromEditor = () => {
        const rawTagText = String($('#blai-scope-tag-input').val() || '').trim();
        const labelText = String($('#blai-scope-tag-label-input').val() || '').trim();
        if (!rawTagText) return '';
        if (rawTagText.includes('//')) {
            const [tagPart, ...labelParts] = rawTagText.split('//');
            const inlineLabel = labelParts.join('//').trim();
            const normalizedLabel = labelText || inlineLabel;
            const tagSource = normalizeScopeTagDraftStart(tagPart);
            return normalizedLabel ? `${tagSource}//${normalizedLabel}` : tagSource;
        }
        const tagSource = normalizeScopeTagDraftStart(rawTagText);
        return labelText ? `${tagSource}//${labelText}` : tagSource;
    };
    const getScopeTagGroups = () => normalizeScopeTagGroupList(settings.scopeTagGroups);
    const getScopeTagGroupIds = () => new Set(getScopeTagGroups().map((group) => group.id));
    const resolveScopeTagGroupId = (groupId) => {
        const candidate = String(groupId || DEFAULT_SCOPE_TAG_GROUP_ID).trim() || DEFAULT_SCOPE_TAG_GROUP_ID;
        return getScopeTagGroupIds().has(candidate) ? candidate : DEFAULT_SCOPE_TAG_GROUP_ID;
    };
    const renderScopeTagGroupOptions = (selectedGroupId = DEFAULT_SCOPE_TAG_GROUP_ID) => {
        const groups = getScopeTagGroups();
        const resolvedGroupId = resolveScopeTagGroupId(selectedGroupId);
        const $select = $('#blai-scope-tag-group-select');
        $select.empty();
        groups.forEach((group) => {
            $('<option>').val(group.id).text(group.name).appendTo($select);
        });
        $select.val(resolvedGroupId);
    };
    const getSelectedScopeTagGroupId = () => resolveScopeTagGroupId($('#blai-scope-tag-group-select').val());
    const normalizeScopeTagsToKnownGroups = (scopeTags) => {
        const groupIds = getScopeTagGroupIds();
        return normalizeScopeTagList(scopeTags).map((tag) => {
            const groupId = String(tag.groupId || DEFAULT_SCOPE_TAG_GROUP_ID).trim() || DEFAULT_SCOPE_TAG_GROUP_ID;
            return groupIds.has(groupId) ? tag : { ...tag, groupId: DEFAULT_SCOPE_TAG_GROUP_ID };
        });
    };
    const closeScopeTagActionMenu = () => {
        $('#blai-scope-tag-action-menu').prop('hidden', true);
        $('#blai-scope-tag-menu-open').attr('aria-expanded', 'false');
    };
    const openScopeTagEditor = (scopeTag = null) => {
        const formattedInput = scopeTag ? formatScopeTagInput(scopeTag) : '';
        const tagSource = formattedInput.split('//')[0]?.trim() || '';
        const tagName = tagSource.match(/^<([^<>/\s]+)>$/)?.[1] || tagSource;
        renderScopeTagGroupOptions(scopeTag?.groupId || DEFAULT_SCOPE_TAG_GROUP_ID);
        $('#blai-scope-tag-input')
            .val(scopeTag ? tagName : '')
            .data('scope-edit-id', scopeTag?.id || '');
        $('#blai-scope-tag-label-input').val(scopeTag?.label || '');
        clearScopeTagValidationState();
        renderScopeTagsModal();
        $('#blai-scope-tag-editor-modal')
            .addClass('blai-is-open')
            .attr('aria-hidden', 'false');
        window.setTimeout(() => {
            $('#blai-scope-tag-input').trigger('focus');
        }, 20);
    };
    const setScopeTagMode = (mode) => {
        const nextMode = mode === 'cleanse-inside' ? 'cleanse-inside' : 'protect';
        if (settings.scopeTagMode === nextMode) {
            renderScopeTagsModal();
            return;
        }
        settings.scopeTagMode = nextMode;
        saveSettingsDebounced();
        renderScopeTagsModal();
        performGlobalCleanse();
        showToast(settings.scopeTagMode === 'cleanse-inside' ? '已切换为净化特定标签' : '已切换为保护特定标签');
    };
    const persistScopeTagGroups = (groups, options = {}) => {
        const normalizedGroups = normalizeScopeTagGroupList(groups);
        settings.scopeTagGroups = normalizedGroups;
        settings.scopeTagCollapsedGroups = normalizeScopeTagCollapsedGroupList(settings.scopeTagCollapsedGroups, normalizedGroups);
        const knownGroupIds = new Set(normalizedGroups.map((group) => group.id));
        const currentScopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
        settings.scopeTags = normalizeScopeTagList(currentScopeTags).map((tag) => {
            const groupId = String(tag.groupId || DEFAULT_SCOPE_TAG_GROUP_ID).trim() || DEFAULT_SCOPE_TAG_GROUP_ID;
            return knownGroupIds.has(groupId) ? tag : { ...tag, groupId: DEFAULT_SCOPE_TAG_GROUP_ID };
        });
        saveSettingsDebounced();
        renderScopeTagsModal();
        renderScopeTagGroupOptions($('#blai-scope-tag-group-select').val() || DEFAULT_SCOPE_TAG_GROUP_ID);
        if (options.focusGroupId) {
            window.setTimeout(() => {
                const escapedGroupId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
                    ? CSS.escape(options.focusGroupId)
                    : String(options.focusGroupId).replace(/["\\]/g, '\\$&');
                $(`#blai-scope-tags-list .blai-scope-group-name-input[data-group-id="${escapedGroupId}"]`).trigger('focus').trigger('select');
            }, 20);
        }
    };
    const persistScopeTags = (scopeTags, options = {}) => {
        settings.scopeTagGroups = getScopeTagGroups();
        const sourceScopeTags = normalizeScopeTagsToKnownGroups(scopeTags);
        const representedBuiltinKeys = new Set(sourceScopeTags.map((tag) => tag.builtinKey).filter(Boolean));
        const dismissedBuiltinKeys = normalizeScopeTagBuiltinDismissedList(options.dismissedBuiltinKeys ?? settings.scopeTagBuiltinDismissed)
            .filter((builtinKey) => !representedBuiltinKeys.has(builtinKey));
        const normalized = mergeScopeTagsWithBuiltins(sourceScopeTags, dismissedBuiltinKeys);
        settings.scopeTagBuiltinDismissed = dismissedBuiltinKeys;
        settings.scopeTags = normalizeScopeTagsToKnownGroups(normalized);
        saveSettingsDebounced();
        renderScopeTagsModal();
        if (options.skipCleanse !== true) performGlobalCleanse();
        return normalized;
    };
    const saveScopeTag = () => {
        const rawInput = buildScopeTagInputFromEditor();
        const parsed = parseScopeTagInput(rawInput);
        if (!parsed.ok) {
            applyScopeTagValidationError(parsed.error.message);
            $('#blai-scope-tag-input').trigger('focus');
            return false;
        }

        const editId = getScopeTagEditId();
        const scopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
        const currentTag = editId ? scopeTags.find((tag) => tag.id === editId) : null;
        const duplicate = scopeTags.find((tag) => tag.startTag === parsed.value.startTag && tag.id !== editId);
        if (duplicate) {
            applyScopeTagValidationError('该范围标签已存在，无需重复添加。');
            $('#blai-scope-tag-input').trigger('focus');
            return false;
        }

        const currentBuiltinKey = currentTag?.builtinKey || '';
        const inferredBuiltinKey = getBuiltinScopeTagKeyForStartTag(parsed.value.startTag);
        const nextBuiltinKey = currentBuiltinKey
            ? (inferredBuiltinKey || currentBuiltinKey)
            : inferredBuiltinKey;
        const dismissedBuiltinKeys = [...normalizeScopeTagBuiltinDismissedList(settings.scopeTagBuiltinDismissed)];
        if (currentBuiltinKey && inferredBuiltinKey && inferredBuiltinKey !== currentBuiltinKey) {
            dismissedBuiltinKeys.push(currentBuiltinKey);
        }

        const nextScopeTag = {
            id: editId || createScopeTagId(),
            startTag: parsed.value.startTag,
            endTag: parsed.value.endTag,
            label: parsed.value.label,
            groupId: getSelectedScopeTagGroupId(),
            enabled: currentTag ? currentTag.enabled !== false : true,
        };
        if (nextBuiltinKey) nextScopeTag.builtinKey = nextBuiltinKey;
        const updated = editId
            ? scopeTags.map((tag) => (tag.id === editId ? { ...tag, ...nextScopeTag, enabled: tag.enabled !== false } : tag))
            : [...scopeTags, nextScopeTag];

        persistScopeTags(updated, { dismissedBuiltinKeys });
        showToast(editId ? '范围标签已更新' : '范围标签已添加');
        resetScopeTagEditor();
        return true;
    };

    const openPurifier = () => {
        updateToolbarUI();
        updateLegacyPurifierWarning();
        showResponsivePage('overview');
        renderTags();
        renderScopeTagsModal();
        $('#blai-purifier-popup').css('display', 'grid').hide().fadeIn(200);
    };
    bindComposerButtonAiRewriteEvent(eventSource);

    $(document).off('click', '#blai-wand-btn, #blai-wand-btn-panel, #blai-extension-settings-entry').on('click', '#blai-wand-btn, #blai-wand-btn-panel, #blai-extension-settings-entry', openPurifier);

    $(document).off('click', '#blai-purifier-popup [data-page-target]').on('click', '#blai-purifier-popup [data-page-target]', function(e) {
        e.preventDefault();
        const pageId = String($(this).attr('data-page-target') || 'overview');
        showResponsivePage(pageId);
        if (pageId === 'clean') renderScopeTagsModal();
    });

    $(document).off('click', '#blai-purifier-popup [data-clean-tab]').on('click', '#blai-purifier-popup [data-clean-tab]', function(e) {
        e.preventDefault();
        const tabId = String($(this).attr('data-clean-tab') || 'settings');
        const $cleanPage = $('#blai-purifier-popup .page-panel[data-page="clean"]');
        $cleanPage.find('[data-clean-tab]')
            .removeClass('is-active')
            .attr('aria-selected', 'false');
        $(this).addClass('is-active').attr('aria-selected', 'true');
        $cleanPage.find('[data-clean-pane]').removeClass('is-active');
        $cleanPage.find(`[data-clean-pane="${tabId}"]`).addClass('is-active');
        if (tabId === 'tags') renderScopeTagsModal();
    });

    $(document).off('click', '#blai-purifier-popup [data-blai-click-proxy]').on('click', '#blai-purifier-popup [data-blai-click-proxy]', function(e) {
        e.preventDefault();
        const selector = String($(this).attr('data-blai-click-proxy') || '');
        const target = selector ? document.querySelector(selector) : null;
        $('#blai-character-bind-toggle').attr('aria-expanded', 'false');
        if ($(this).attr('data-blai-toggle-binding') === 'true' && $(this).attr('aria-pressed') === 'true') {
            document.querySelector('#blai-unbind-current-character')?.click();
            return;
        }
        if (target && target.disabled) {
            const $target = $(target);
            const message = String($target.find('.blai-bind-menu-note').text() || $target.attr('title') || '当前操作不可用').trim();
            showToast(message);
            refreshCharacterBindingUI();
            return;
        }
        if (target) target.click();
    });

    $(document).off('click', '#blai-rule-sort-toggle').on('click', '#blai-rule-sort-toggle', function(e) {
        e.preventDefault();
        const rules = extension_settings[extensionName].rules || [];
        rules.reverse();
        markRulesDataDirty();
        saveSettingsDebounced();
        renderTagsPreserveBatchSelection();
        showToast('分组顺序已反转');
    });

    $(document).off('click', '#blai-ai-api-check').on('click', '#blai-ai-api-check', function(e) {
        e.preventDefault();
        void runAiModelsHealthCheck({ silent: false });
    });

    $(document).off('click', '#blai-close-legacy-plugin').on('click', '#blai-close-legacy-plugin', function(e) {
        e.preventDefault();
        const detected = updateLegacyPurifierWarning();
        const legacyEntry = document.getElementById('bl-extension-settings-entry') || document.getElementById('bl-wand-btn');
        if (legacyEntry) {
            $('#blai-purifier-popup').fadeOut(120);
            legacyEntry.scrollIntoView({ behavior: 'smooth', block: 'center' });
            legacyEntry.classList.remove('blai-legacy-target-flash');
            void legacyEntry.offsetWidth;
            legacyEntry.classList.add('blai-legacy-target-flash');
            window.setTimeout(() => legacyEntry.classList.remove('blai-legacy-target-flash'), 1800);
        }
        showToast(detected
            ? '请关闭旧插件 Veridis-Keyword-filtering-main 后刷新页面'
            : '未检测到旧版 purifier');
    });

    $(document).off('click', '#blai-close-btn').on('click', '#blai-close-btn', () => {
        if (checkUnsavedChanges()) {
            if (confirm(`预设 "${extension_settings[extensionName].activePreset}" 有未保存的规则或 AI 生成限制改动，是否保存？\n点击【确定】保存，点击【取消】直接关闭放弃改动。`)) {
                $('#blai-preset-save').click();
            } else {
                // 放弃保存时回滚到已保存状态，避免脏数据残留。
                applyPresetByName(extension_settings[extensionName].activePreset, { skipRender: true });
            }
        }
        closeRuleSearchModal({ reset: true });
        closeScopeTagsModal({ reset: true });
        $('#blai-purifier-popup').fadeOut(200);
    });
    const settings = extension_settings[extensionName];
    normalizeZhVariantSettings(settings);
    const isSearchGroupEditFlow = () => runtimeState.searchEditFlow.active === true && runtimeState.searchEditFlow.returnMode === 'group';
    const isSearchDirectSubruleFlow = () => runtimeState.searchEditFlow.active === true && runtimeState.searchEditFlow.returnMode === 'subrule';
    const isRelatedDirectSubruleFlow = () => runtimeState.searchEditFlow.active === true && runtimeState.searchEditFlow.returnMode === 'related';
    const resetRuleSearchQueryState = () => {
        runtimeState.ruleSearchKeyword = '';
        runtimeState.ruleSearchDraftKeyword = '';
        runtimeState.ruleSearchHasSearched = false;
        runtimeState.ruleSearchExpandedMenuKey = '';
        clearRuleSearchEditFlow();
    };
    const submitRuleSearch = () => {
        runtimeState.ruleSearchDraftKeyword = String($('#blai-rule-search-input').val() || '');
        runtimeState.ruleSearchKeyword = runtimeState.ruleSearchDraftKeyword.trim();
        runtimeState.ruleSearchHasSearched = runtimeState.ruleSearchKeyword.length > 0;
        runtimeState.ruleSearchExpandedMenuKey = '';
        renderRuleSearchModal();
    };
    const saveCurrentEditingRule = (options = {}) => {
        const {
            toastMessage = '合集保存成功',
            focusLatest = true,
        } = options;
        const rules = extension_settings[extensionName].rules || [];
        const isCreatingNewRule = runtimeState.currentEditingIndex === -1;
        const nameVal = String($('#blai-edit-name').val() || '').trim();
        const validSubrules = runtimeState.currentEditingSubrules.filter(sub => sub.targets && sub.targets.length > 0);

        if (validSubrules.length === 0) {
            showToast('合集内至少需要保留一组有效映射！');
            return { ok: false };
        }

        const previousRule = runtimeState.currentEditingIndex !== -1 ? rules[runtimeState.currentEditingIndex] : null;
        const isEnabled = previousRule?.enabled !== false;
        const activationWarning = getRuleActivationWarning(previousRule);
        const activationWarningEnabled = isRuleActivationWarningEnabled(previousRule);

        const fallbackName = runtimeState.currentEditingIndex !== -1
            ? (rules[runtimeState.currentEditingIndex]?.name || `合集 ${runtimeState.currentEditingIndex + 1}`)
            : `合集 ${rules.length + 1}`;
        const newRule = normalizeRuleActivationSafety({
            name: nameVal || fallbackName,
            subRules: validSubrules,
            activationWarning,
            activationWarningEnabled,
            enabled: activationWarningEnabled ? false : isEnabled,
        });

        if (runtimeState.currentEditingIndex === -1) rules.push(newRule);
        else rules[runtimeState.currentEditingIndex] = newRule;

        markRulesDataDirty();
        saveSettingsDebounced();
        renderTags();
        if (isCreatingNewRule && focusLatest) {
            window.setTimeout(() => {
                focusLatestRuleCard();
            }, 50);
        }
        performGlobalCleanse();
        renderRuleSearchModal();
        if (toastMessage) showToast(toastMessage);
        return { ok: true, isCreatingNewRule, rule: newRule };
    };

    bindAiSettingsEvents();
    const syncSkipUserToggle = () => {
        const enabled = settings.skipUserMessages === true;
        $('#blai-skip-user-toggle')
            .toggleClass('accent', enabled)
            .attr('aria-pressed', String(enabled))
            .text(enabled ? '开启' : '关闭');
    };
    syncSkipUserToggle();

    const syncComposerButtonToggle = () => {
        const enabled = settings.showComposerAiRewriteButton === true;
        $('#blai-composer-button-toggle')
            .toggleClass('accent', enabled)
            .attr('aria-pressed', String(enabled))
            .text(enabled ? '开启' : '关闭');
    };
    syncComposerButtonToggle();

    $(document).off('click', '#blai-composer-button-toggle').on('click', '#blai-composer-button-toggle', function(e) {
        e.preventDefault();
        const enabled = settings.showComposerAiRewriteButton !== true;
        const synchronized = updateComposerButtonSetting(enabled);
        syncComposerButtonToggle();
        if (synchronized === false) {
            showToast('酒馆助手不可用，未能同步输入框手动 AI 改写按钮');
            return;
        }
        showToast(enabled ? '已显示输入框手动 AI 改写按钮' : '已移除输入框手动 AI 改写按钮');
    });

    $(document).off('click', '#blai-skip-user-toggle').on('click', '#blai-skip-user-toggle', function(e) {
        e.preventDefault();
        settings.skipUserMessages = settings.skipUserMessages !== true;
        saveSettingsDebounced();
        performGlobalCleanse();
        syncSkipUserToggle();
        showToast(settings.skipUserMessages ? '已跳过用户消息' : '已恢复净化用户消息');
    });

    $(document).off('click', '.blai-persona-description-protect-toggle').on('click', '.blai-persona-description-protect-toggle', function(e) {
        e.preventDefault();
        settings.protectPersonaDescription = settings.protectPersonaDescription !== true;
        saveSettingsDebounced();
        syncPersonaDescriptionProtectionControl();
        showToast(settings.protectPersonaDescription ? '用户设定描述已保护' : '用户设定描述已取消保护');
    });

    $(document).off('click', '#blai-preset-search').on('click', '#blai-preset-search', () => {
        openRuleSearchModal();
    });

    $(document).off('click', '#blai-rule-search-back').on('click', '#blai-rule-search-back', () => {
        closeRuleSearchModal({ reset: true });
    });

    $(document).off('input', '#blai-rule-search-input').on('input', '#blai-rule-search-input', function() {
        runtimeState.ruleSearchDraftKeyword = String($(this).val() || '');
        syncRuleSearchInputUi();
        if (runtimeState.ruleSearchDraftKeyword.trim() !== '') return;
        runtimeState.ruleSearchKeyword = '';
        runtimeState.ruleSearchHasSearched = false;
        runtimeState.ruleSearchExpandedMenuKey = '';
        renderRuleSearchModal();
    });

    $(document).off('keydown', '#blai-rule-search-input').on('keydown', '#blai-rule-search-input', function(e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        submitRuleSearch();
    });

    $(document).off('click', '#blai-rule-search-submit').on('click', '#blai-rule-search-submit', () => {
        submitRuleSearch();
    });

    $(document).off('click', '#blai-rule-search-clear').on('click', '#blai-rule-search-clear', () => {
        resetRuleSearchQueryState();
        syncRuleSearchInputUi({ syncValue: true });
        renderRuleSearchModal();
        $('#blai-rule-search-input').trigger('focus');
    });

    $(document).off('click', '#blai-scope-tags-btn').on('click', '#blai-scope-tags-btn', () => {
        openScopeTagsModal();
    });

    $(document).off('click', '#blai-scope-tag-menu-open').on('click', '#blai-scope-tag-menu-open', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const $menu = $('#blai-scope-tag-action-menu');
        const nextHidden = !$menu.prop('hidden');
        $menu.prop('hidden', nextHidden);
        $(this).attr('aria-expanded', String(!nextHidden));
    });

    $(document).off('click', '#blai-scope-tag-add-open').on('click', '#blai-scope-tag-add-open', () => {
        closeScopeTagActionMenu();
        openScopeTagEditor();
    });

    $(document).off('click', '#blai-scope-group-add').on('click', '#blai-scope-group-add', () => {
        closeScopeTagActionMenu();
        const group = { id: createScopeTagGroupId(), name: '未命名分组' };
        $('#blai-scope-tags-list').addClass('blai-is-group-manage-mode');
        persistScopeTagGroups([...getScopeTagGroups(), group], { focusGroupId: group.id });
    });

    const saveQuickScopeTag = () => {
        const rawInput = String($('#blai-scope-quick-input').val() || '').trim();
        if (!rawInput) {
            showToast('先输入范围标签');
            $('#blai-scope-quick-input').trigger('focus');
            return;
        }
        renderScopeTagGroupOptions(DEFAULT_SCOPE_TAG_GROUP_ID);
        $('#blai-scope-tag-input')
            .val(rawInput)
            .data('scope-edit-id', '');
        $('#blai-scope-tag-label-input').val('');
        $('#blai-scope-tag-group-select').val(DEFAULT_SCOPE_TAG_GROUP_ID);
        if (saveScopeTag()) $('#blai-scope-quick-input').val('');
    };

    $(document).off('click', '#blai-scope-tag-add-quick').on('click', '#blai-scope-tag-add-quick', (e) => {
        e.preventDefault();
        saveQuickScopeTag();
    });

    $(document).off('keydown', '#blai-scope-quick-input').on('keydown', '#blai-scope-quick-input', function(e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        saveQuickScopeTag();
    });

    $(document).off('click', '#blai-scope-group-manage-open').on('click', '#blai-scope-group-manage-open', () => {
        closeScopeTagActionMenu();
        $('#blai-scope-tags-list').toggleClass('blai-is-group-manage-mode');
        renderScopeTagsModal();
    });

    $(document).off('click', '#blai-scope-tags-expand-all').on('click', '#blai-scope-tags-expand-all', () => {
        settings.scopeTagCollapsedGroups = [];
        saveSettingsDebounced();
        renderScopeTagsModal();
    });

    $(document).off('click', '#blai-scope-tags-collapse-all').on('click', '#blai-scope-tags-collapse-all', () => {
        settings.scopeTagCollapsedGroups = getScopeTagGroups().map((group) => group.id);
        saveSettingsDebounced();
        renderScopeTagsModal();
    });

    $(document).off('click', '.blai-scope-tag-group-head').on('click', '.blai-scope-tag-group-head', function(e) {
        if ($(this).hasClass('blai-is-managing')) return;
        e.preventDefault();
        if ($(e.target).closest('.blai-scope-tag-group-toggle').length > 0) return;
        const groupId = String($(this).closest('.blai-scope-tag-group').attr('data-group-id') || '');
        if (!groupId) return;
        const groups = getScopeTagGroups();
        const collapsed = new Set(normalizeScopeTagCollapsedGroupList(settings.scopeTagCollapsedGroups, groups));
        if (collapsed.has(groupId)) collapsed.delete(groupId);
        else collapsed.add(groupId);
        settings.scopeTagCollapsedGroups = normalizeScopeTagCollapsedGroupList([...collapsed], groups);
        saveSettingsDebounced();
        renderScopeTagsModal();
    });

    $(document).off('click', '.blai-scope-tag-group-toggle').on('click', '.blai-scope-tag-group-toggle', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const groupId = String($(this).attr('data-group-id') || '');
        if (!groupId || $(this).prop('disabled')) return;
        const nextEnabled = $(this).attr('aria-pressed') !== 'true';
        const currentScopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
        let changed = false;
        const scopeTags = currentScopeTags.map((tag) => {
            if (resolveScopeTagGroupId(tag.groupId) !== groupId) return tag;
            if ((tag.enabled !== false) === nextEnabled) return tag;
            changed = true;
            return { ...tag, enabled: nextEnabled };
        });
        if (!changed) return;
        persistScopeTags(scopeTags);
        showToast(nextEnabled ? '已启用该分组' : '已关闭该分组');
    });

    $(document).off('input', '.blai-scope-group-name-input').on('input', '.blai-scope-group-name-input', function() {
        const groupId = String($(this).attr('data-group-id') || '');
        const nextName = String($(this).val() || '').trim();
        if (!groupId || !nextName) return;
        settings.scopeTagGroups = normalizeScopeTagGroupList(getScopeTagGroups().map((group) => (
            group.id === groupId ? { ...group, name: nextName } : group
        )));
        saveSettingsDebounced();
        renderScopeTagGroupOptions($('#blai-scope-tag-group-select').val() || DEFAULT_SCOPE_TAG_GROUP_ID);
    });

    $(document).off('blur', '.blai-scope-group-name-input').on('blur', '.blai-scope-group-name-input', function() {
        if (String($(this).val() || '').trim()) return;
        const groupId = String($(this).attr('data-group-id') || '');
        const group = getScopeTagGroups().find((item) => item.id === groupId);
        if (group) $(this).val(group.name);
    });

    $(document).off('keydown', '.blai-scope-group-name-input').on('keydown', '.blai-scope-group-name-input', function(e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        $(this).trigger('blur');
    });

    const moveScopeGroup = (groupId, direction) => {
        const groups = getScopeTagGroups();
        const index = groups.findIndex((group) => group.id === groupId);
        const targetIndex = direction === 'up' ? index - 1 : index + 1;
        if (index < 0 || targetIndex < 0 || targetIndex >= groups.length) return;
        [groups[index], groups[targetIndex]] = [groups[targetIndex], groups[index]];
        persistScopeTagGroups(groups);
    };

    $(document).off('click', '.blai-scope-group-move-up').on('click', '.blai-scope-group-move-up', function() {
        moveScopeGroup(String($(this).attr('data-group-id') || ''), 'up');
    });

    $(document).off('click', '.blai-scope-group-move-down').on('click', '.blai-scope-group-move-down', function() {
        moveScopeGroup(String($(this).attr('data-group-id') || ''), 'down');
    });

    $(document).off('click', '.blai-scope-group-delete').on('click', '.blai-scope-group-delete', function() {
        const groupId = String($(this).attr('data-group-id') || '');
        if (!groupId || groupId === DEFAULT_SCOPE_TAG_GROUP_ID) return;
        const group = getScopeTagGroups().find((item) => item.id === groupId);
        if (!group) return;
        if (!confirm(`确定删除分组 "${group.name}" 吗？\n该分组内的标签会移至默认分组。`)) return;
        const currentScopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
        settings.scopeTags = currentScopeTags.map((tag) => (
            tag.groupId === groupId ? { ...tag, groupId: DEFAULT_SCOPE_TAG_GROUP_ID } : tag
        ));
        settings.scopeTagCollapsedGroups = normalizeScopeTagCollapsedGroupList(
            (settings.scopeTagCollapsedGroups || []).filter((id) => id !== groupId),
            getScopeTagGroups().filter((item) => item.id !== groupId)
        );
        persistScopeTagGroups(getScopeTagGroups().filter((item) => item.id !== groupId));
    });

    $(document).off('click', '#blai-scope-tag-mode-toggle').on('click', '#blai-scope-tag-mode-toggle', () => {
        setScopeTagMode(settings.scopeTagMode === 'cleanse-inside' ? 'protect' : 'cleanse-inside');
    });

    $(document).off('click', '#blai-scope-mode-protect, #blai-scope-mode-cleanse').on('click', '#blai-scope-mode-protect, #blai-scope-mode-cleanse', function() {
        setScopeTagMode(String($(this).data('mode') || 'protect'));
    });

    $(document).off('click', '#blai-scope-tags-close').on('click', '#blai-scope-tags-close', () => {
        closeScopeTagsModal({ reset: true });
    });

    $(document).off('click', '#blai-scope-tag-reset').on('click', '#blai-scope-tag-reset', () => {
        resetScopeTagEditor();
    });

    $(document).off('click', '#blai-scope-tag-save').on('click', '#blai-scope-tag-save', () => {
        saveScopeTag();
    });

    $(document).off('keydown', '#blai-scope-tag-label-input').on('keydown', '#blai-scope-tag-label-input', function(e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        saveScopeTag();
    });

    $(document).off('keydown', '#blai-scope-tag-input').on('keydown', '#blai-scope-tag-input', function(e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        saveScopeTag();
    });

    $(document).off('click', '.blai-rule-search-menu-toggle').on('click', '.blai-rule-search-menu-toggle', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const nextKey = String($(this).data('key') || '');
        runtimeState.ruleSearchExpandedMenuKey = runtimeState.ruleSearchExpandedMenuKey === nextKey ? '' : nextKey;
        renderRuleSearchModal();
    });

    $(document).off('click', '.blai-rule-search-menu-item').on('click', '.blai-rule-search-menu-item', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const action = String($(this).data('action') || '');
        const ruleIndex = Number($(this).attr('data-rule-index'));
        const subRuleIndex = Number($(this).attr('data-subrule-index'));
        const rules = extension_settings[extensionName].rules || [];
        if (!Number.isInteger(ruleIndex) || ruleIndex < 0 || ruleIndex >= rules.length) return;
        if (!Number.isInteger(subRuleIndex) || subRuleIndex < 0 || subRuleIndex >= (rules[ruleIndex]?.subRules || []).length) return;

        runtimeState.ruleSearchExpandedMenuKey = '';
        closeRuleSearchModal();

        if (action === 'group') {
            openEditModal(ruleIndex, { source: 'search', returnMode: 'group', subRuleIndex });
            return;
        }

        if (action === 'subrule') {
            openEditModal(ruleIndex, { source: 'search', returnMode: 'subrule', subRuleIndex });
            openSingleRuleModal(subRuleIndex, { hideEditModal: true });
        }
    });

    $(document).off('click', '#blai-rule-search-modal').on('click', '#blai-rule-search-modal', function(e) {
        if ($(e.target).closest('.blai-rule-search-menu-wrap').length > 0) return;
        if (!runtimeState.ruleSearchExpandedMenuKey) return;
        runtimeState.ruleSearchExpandedMenuKey = '';
        renderRuleSearchModal();
    });

    $(document).off('click', '#blai-scope-tags-modal').on('click', '#blai-scope-tags-modal', function(e) {
        if ($(e.target).closest('.blai-scope-tag-menu-wrap').length === 0) closeScopeTagActionMenu();
        if (e.target && e.target.id === 'blai-scope-tags-modal') closeScopeTagsModal({ reset: true });
    });

    $(document).off('click', '#blai-scope-tag-editor-modal').on('click', '#blai-scope-tag-editor-modal', function(e) {
        if (e.target && e.target.id === 'blai-scope-tag-editor-modal') resetScopeTagEditor();
    });

    $(document).off('click', '.blai-scope-tag-chip-main, .blai-scope-tag-edit').on('click', '.blai-scope-tag-chip-main, .blai-scope-tag-edit', function(e) {
        e.preventDefault();
        const tagId = String($(this).attr('data-id') || '');
        const scopeTag = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed).find((tag) => tag.id === tagId);
        if (!scopeTag) return;
        openScopeTagEditor(scopeTag);
    });

    $(document).off('change', '.blai-scope-tag-toggle').on('change', '.blai-scope-tag-toggle', function() {
        const tagId = String($(this).attr('data-id') || '');
        const checked = $(this).prop('checked');
        const currentScopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
        const targetTag = currentScopeTags.find((tag) => tag.id === tagId);
        const togglesCotGroup = isCotScopeTagEntry(targetTag);
        const scopeTags = currentScopeTags.map((tag) => {
            if (togglesCotGroup && isCotScopeTagEntry(tag)) return { ...tag, enabled: checked };
            return tag.id === tagId ? { ...tag, enabled: checked } : tag;
        });
        persistScopeTags(scopeTags);
    });

    $(document).off('click', '.blai-scope-tag-del').on('click', '.blai-scope-tag-del', function(e) {
        e.preventDefault();
        const tagId = String($(this).attr('data-id') || '');
        const scopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
        const scopeTag = scopeTags.find((tag) => tag.id === tagId);
        if (!scopeTag) return;
        const deletesCotGroup = isCotScopeTagEntry(scopeTag);
        const displayName = deletesCotGroup ? '<thinking> OR <think>' : scopeTag.startTag;
        if (!confirm(`确定删除范围标签 ${displayName} 吗？`)) return;
        const dismissedBuiltinKeys = [...normalizeScopeTagBuiltinDismissedList(settings.scopeTagBuiltinDismissed)];
        if (deletesCotGroup) dismissedBuiltinKeys.push(...getCotScopeTagBuiltinKeys());
        else if (scopeTag.builtinKey) dismissedBuiltinKeys.push(scopeTag.builtinKey);
        const nextScopeTags = deletesCotGroup
            ? scopeTags.filter((tag) => !isCotScopeTagEntry(tag))
            : scopeTags.filter((tag) => tag.id !== tagId);
        persistScopeTags(nextScopeTags, { dismissedBuiltinKeys });
        if (getScopeTagEditId() === tagId) resetScopeTagEditor();
        showToast('范围标签已删除');
    });

    $(document).off('click', '#blai-batch-toggle').on('click', '#blai-batch-toggle', function() {
        const $popup = $('#blai-purifier-popup');
        const isBatchMode = !$popup.hasClass('blai-is-batch-mode');
        $popup.toggleClass('blai-is-batch-mode', isBatchMode);
        $('#blai-batch-operations').toggle(isBatchMode);
        $popup.find('.blai-batch-checkbox-label').toggle(isBatchMode);
        $(this).toggleClass('blai-active', isBatchMode);
        if (!isBatchMode) {
            $('.batch-item-checkbox').prop('checked', false);
            runtimeState.batchSelectedRuleIds = [];
        }
    });

    $(document).off('click', '#blai-btn-select-all').on('click', '#blai-btn-select-all', () => {
        $('.batch-item-checkbox').prop('checked', true);
        syncBatchSelectionStateFromDom(extension_settings[extensionName].rules || []);
    });

    $(document).off('click', '#blai-btn-select-invert').on('click', '#blai-btn-select-invert', () => {
        $('.batch-item-checkbox').each(function() { $(this).prop('checked', !$(this).prop('checked')); });
        syncBatchSelectionStateFromDom(extension_settings[extensionName].rules || []);
    });

    $(document).off('click', '#blai-btn-batch-transfer').on('click', '#blai-btn-batch-transfer', () => {
        const selectedIndexes = getSelectedIndexesFromState(extension_settings[extensionName].rules || []);
        if (selectedIndexes.length > 0) openTransferModal(selectedIndexes);
    });

    $(document).off('click', '#blai-btn-batch-delete').on('click', '#blai-btn-batch-delete', () => {
        const rules = extension_settings[extensionName].rules || [];
        const selectedIndexes = getSelectedIndexesFromState(rules);
        if (selectedIndexes.length <= 0 || !confirm(`确定要删除选中的 ${selectedIndexes.length} 个规则分组吗？`)) return;
        if (selectedIndexes.length > 1 ? deleteSelectedRules(rules, selectedIndexes) : deleteSingleRule(rules, selectedIndexes[0])) {
            markRulesDataDirty();
            saveSettingsDebounced();
            renderTagsPreserveBatchSelection();
        }
    });

    $(document).off('change', '.batch-item-checkbox').on('change', '.batch-item-checkbox', () => syncBatchSelectionStateFromDom(extension_settings[extensionName].rules || []));

    bindDiffEvents();
    $(document).off('click', '#blai-open-new-rule-btn').on('click', '#blai-open-new-rule-btn', () => openEditModal(-1));
    $(document).off('click keydown', '.blai-rule-risk-indicator').on('click keydown', '.blai-rule-risk-indicator', function(event) {
        if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();

        const rules = extension_settings[extensionName].rules || [];
        const index = Number($(this).data('index'));
        if (!Number.isInteger(index) || index < 0 || index >= rules.length) return;
        const rule = rules[index];
        const warning = getRuleActivationWarning(rule);
        if (!isRuleActivationWarningEnabled(rule) || !warning) return;
        showRiskInfoModal(warning);
    });
    $(document).off('click', '.blai-rule-edit').on('click', '.blai-rule-edit', function() { openEditModal($(this).data('index')); });
    $(document).off('click', '.blai-rule-transfer').on('click', '.blai-rule-transfer', function() {
        const index = Number($(this).data('index'));
        const rules = extension_settings[extensionName].rules || [];
        if (!Number.isInteger(index) || index < 0 || index >= rules.length) return;
        if (shouldBatchTransferRule(index, rules)) openTransferModal(getSelectedIndexesFromState(rules));
        else openTransferModal(index);
    });

    $(document).off('click', '.blai-rule-move-up').on('click', '.blai-rule-move-up', function() {
        const index = Number($(this).data('index'));
        const rules = extension_settings[extensionName].rules || [];
        if (!Number.isInteger(index) || index < 0 || index >= rules.length) return;
        const ctx = getBatchOperationContext(index, rules);
        if (ctx.shouldBatch) { if (!batchMoveRules(rules, ctx.selectedIndexes, 'up')) return; }
        else { if (index <= 0) return; [rules[index - 1], rules[index]] = [rules[index], rules[index - 1]]; }
        markRulesDataDirty();
        saveSettingsDebounced();
        renderTagsPreserveBatchSelection();
    });

    $(document).off('click', '.blai-rule-move-down').on('click', '.blai-rule-move-down', function() {
        const index = Number($(this).data('index'));
        const rules = extension_settings[extensionName].rules || [];
        if (!Number.isInteger(index) || index < 0 || index >= rules.length) return;
        const ctx = getBatchOperationContext(index, rules);
        if (ctx.shouldBatch) { if (!batchMoveRules(rules, ctx.selectedIndexes, 'down')) return; }
        else { if (index >= rules.length - 1) return; [rules[index], rules[index + 1]] = [rules[index + 1], rules[index]]; }
        markRulesDataDirty();
        saveSettingsDebounced();
        renderTagsPreserveBatchSelection();
    });

    $(document).off('change', '.blai-rule-toggle').on('change', '.blai-rule-toggle', async function() {
        const rules = extension_settings[extensionName].rules || [];
        const index = Number($(this).data('index'));
        if (!Number.isInteger(index) || index < 0 || index >= rules.length) return;
        const targetEnabled = $(this).prop('checked');
        const ctx = getBatchOperationContext(index, rules);
        const targetIndexes = ctx.shouldBatch ? ctx.selectedIndexes : [index];
        if (targetEnabled) {
            const riskyRules = targetIndexes
                .map((ruleIndex) => rules[ruleIndex])
                .filter(isRuleActivationWarningEnabled);
            if (riskyRules.length > 0 && !await showRiskConfirmModal(buildRuleActivationConfirmMessage(riskyRules))) {
                $(this).prop('checked', false);
                renderTagsPreserveBatchSelection();
                return;
            }
        }
        targetIndexes.forEach((ruleIndex) => { rules[ruleIndex].enabled = targetEnabled; });
        markRulesDataDirty();
        saveSettingsDebounced();
        renderTagsPreserveBatchSelection();
        performGlobalCleanse();
    });

    $(document).off('click', '.blai-rule-del').on('click', '.blai-rule-del', function() {
        if (!confirm('确定要删除这个规则分组吗？删除后无法恢复。')) return; 
        const rules = extension_settings[extensionName].rules || [];
        const index = Number($(this).data('index'));
        if (!Number.isInteger(index) || index < 0 || index >= rules.length) return;
        const deletingCount = shouldBatchTransferRule(index, rules) ? getSelectedIndexesFromState(rules).length : 1;
        if (handleDeleteRule(index, rules)) {
            markRulesDataDirty();
            saveSettingsDebounced();
            renderTagsPreserveBatchSelection();
            showToast(deletingCount > 1 ? `已删除 ${deletingCount} 个合集` : '合集删除成功');
        }
    });

    $(document).off('click', '#blai-add-subrule-btn').on('click', '#blai-add-subrule-btn', () => openSingleRuleModal(-1));

    $(document).off('change', '.blai-subrule-toggle').on('change', '.blai-subrule-toggle', function() {
        const index = Number($(this).data('index'));
        if (!Number.isInteger(index) || index < 0 || index >= runtimeState.currentEditingSubrules.length) return;
        runtimeState.currentEditingSubrules[index].enabled = $(this).prop('checked');
        renderSubrulesToModal();
    });

    $(document).off('click', '.blai-move-subrule-up-btn').on('click', '.blai-move-subrule-up-btn', function() {
        const index = Number($(this).data('index'));
        if (index <= 0 || index >= runtimeState.currentEditingSubrules.length) return;
        [runtimeState.currentEditingSubrules[index - 1], runtimeState.currentEditingSubrules[index]] = [runtimeState.currentEditingSubrules[index], runtimeState.currentEditingSubrules[index - 1]];
        renderSubrulesToModal();
    });

    $(document).off('click', '.blai-move-subrule-down-btn').on('click', '.blai-move-subrule-down-btn', function() {
        const index = Number($(this).data('index'));
        if (index < 0 || index >= runtimeState.currentEditingSubrules.length - 1) return;
        [runtimeState.currentEditingSubrules[index], runtimeState.currentEditingSubrules[index + 1]] = [runtimeState.currentEditingSubrules[index + 1], runtimeState.currentEditingSubrules[index]];
        renderSubrulesToModal();
    });

    $(document).off('click', '.blai-del-subrule-btn').on('click', '.blai-del-subrule-btn', function() {
        const index = Number($(this).data('index'));
        if (!Number.isInteger(index) || index < 0 || index >= runtimeState.currentEditingSubrules.length) return;
        if (!confirm('确定要删除该映射规则吗？')) return;
        runtimeState.currentEditingSubrules.splice(index, 1);
        renderSubrulesToModal();
        showToast('词条删除成功');
    });

    $(document).off('click', '.blai-edit-subrule-btn').on('click', '.blai-edit-subrule-btn', function() {
        openSingleRuleModal($(this).data('index'));
    });

    $(document).off('click', '.blai-remark-subrule-btn').on('click', '.blai-remark-subrule-btn', function(e) {
        e.preventDefault();
        const index = $(this).data('index');
        const sub = runtimeState.currentEditingSubrules[index];
        const newRemark = prompt("📝 快捷修改规则备注：\n(若不需要备注，请直接清空并点击确定)", sub.remark || '');
        
        if (newRemark !== null) {
            sub.remark = newRemark.trim();
            renderSubrulesToModal(); 
        }
    });

    $(document).off('change', '#blai-modal-sub-mode').on('change', '#blai-modal-sub-mode', function() {
        applySubruleModeUI(String($(this).val() || 'simple'));
    });

    $(document).off('change', '#blai-modal-sub-rewrite-mode').on('change', '#blai-modal-sub-rewrite-mode', function() {
        applySubruleRewriteModeUI();
    });

    $(document).off('input', '#blai-modal-sub-target').on('input', '#blai-modal-sub-target', () => {
        if ($('#blai-modal-sub-mode').val() === 'regex') validateRegexTargetField();
    });

    $(document).off('click', '#blai-modal-sub-regex-recognize').on('click', '#blai-modal-sub-regex-recognize', () => {
        const result = recognizeRegexReplacementInput();
        if (!result.ok) {
            showToast('留空会直接删除，直接保存条目即可。');
            $('#blai-modal-sub-rep').trigger('focus');
            return;
        }
    });

    $(document).off('click', '.blai-regex-replacement-chip-main').on('click', '.blai-regex-replacement-chip-main', function() {
        if (startEditingRegexReplacementInput($(this).data('index'))) {
            $('#blai-modal-sub-rep').trigger('focus');
        }
    });

    $(document).off('click', '.blai-regex-replacement-chip-remove').on('click', '.blai-regex-replacement-chip-remove', function(e) {
        e.preventDefault();
        e.stopPropagation();
        removeRegexReplacementInput($(this).data('index'));
    });

    $(document).off('click', '#blai-modal-sub-save').on('click', '#blai-modal-sub-save', function() {
        const mode = String($('#blai-modal-sub-mode').val() || 'simple');
        const rewriteMode = $('#blai-modal-sub-rewrite-mode').val() === 'ai' ? 'ai' : 'program';
        const tStr = String($('#blai-modal-sub-target').val() || '');
        const remarkStr = String($('#blai-modal-sub-remark').val() || '').trim();
        const aiPromptTemplate = String($('#blai-modal-sub-ai-prompt').val() || '').trim();
        const isDirectSearchFlow = isSearchDirectSubruleFlow();
        const isRelatedFlow = isRelatedDirectSubruleFlow();

        if (mode === 'regex') {
            const validation = validateRegexTargetField();
            if (!validation.ok) {
                showToast(`正则规则有误：${validation.uiMessage || formatRegexTargetError(validation.error)}`);
                $('#blai-modal-sub-target').trigger('focus');
                return;
            }
        } else {
            clearRegexTargetValidationState();
        }

        if (mode === 'regex' && hasPendingRegexReplacementInput()) {
            showToast('替换框里还有未处理的内容，请先点右侧按钮。');
            $('#blai-modal-sub-rep').trigger('focus');
            return;
        }
        
        const targets = parseInputToWords(tStr, mode, { isTarget: true });
        const replacements = getSingleRuleReplacementValues(mode);

        if (targets.length === 0) {
            showToast("查找内容不能为空！");
            $('#blai-modal-sub-target').trigger('focus');
            return;
        }

        const previousSubRule = runtimeState.currentSubruleEditIndex >= 0
            ? runtimeState.currentEditingSubrules[runtimeState.currentSubruleEditIndex]
            : null;
        const subRule = {
            targets,
            replacements,
            mode,
            rewriteMode,
            remark: remarkStr,
            aiPromptTemplate: rewriteMode === 'ai' ? aiPromptTemplate : '',
            enabled: previousSubRule?.enabled !== false,
        };

        if (runtimeState.currentSubruleEditIndex === -1) {
            runtimeState.currentEditingSubrules.push(subRule);
        } else {
            runtimeState.currentEditingSubrules[runtimeState.currentSubruleEditIndex] = subRule;
        }

        clearRegexTargetValidationState();
        if (isDirectSearchFlow || isRelatedFlow) {
            const saveResult = saveCurrentEditingRule({ toastMessage: '条目保存成功', focusLatest: false });
            if (!saveResult.ok) return;
            $('#blai-subrule-edit-modal').fadeOut(150, () => {
                $('#blai-rule-edit-modal').hide();
                clearRuleSearchEditFlow();
                if (isDirectSearchFlow) openRuleSearchModal();
                else if (runtimeState.currentDiffIndex !== undefined) renderDiffModalContent(runtimeState.currentDiffIndex);
            });
            return;
        }

        $('#blai-subrule-edit-modal').fadeOut(150);
        renderSubrulesToModal();

        if (runtimeState.currentSubruleEditIndex === -1) {
            const container = $('#blai-edit-subrules-container');
            container.scrollTop(container[0].scrollHeight);
        }
    });

    $(document).off('click', '#blai-modal-sub-cancel').on('click', '#blai-modal-sub-cancel', () => {
        clearRegexTargetValidationState();
        if (isSearchDirectSubruleFlow() || isRelatedDirectSubruleFlow()) {
            const shouldReturnSearch = isSearchDirectSubruleFlow();
            $('#blai-subrule-edit-modal').fadeOut(150, () => {
                $('#blai-rule-edit-modal').hide();
                clearRuleSearchEditFlow();
                if (shouldReturnSearch) openRuleSearchModal();
            });
            return;
        }
        $('#blai-subrule-edit-modal').fadeOut(150);
    });

    $(document).off('click', '#blai-edit-cancel-x').on('click', '#blai-edit-cancel-x', () => {
        $('#blai-rule-edit-modal').hide();
        if (isSearchGroupEditFlow()) {
            clearRuleSearchEditFlow();
            openRuleSearchModal();
        }
    });
    $(document).off('click', '#blai-transfer-cancel').on('click', '#blai-transfer-cancel', () => closeTransferModal());
    $(document).off('click', '#blai-transfer-copy').on('click', '#blai-transfer-copy', () => runRuleTransfer(false));
    $(document).off('click', '#blai-transfer-move').on('click', '#blai-transfer-move', () => runRuleTransfer(true));
    $(document).off('click', '#blai-rule-transfer-modal').on('click', '#blai-rule-transfer-modal', function(e) {
        if (e.target && e.target.id === 'blai-rule-transfer-modal') closeTransferModal();
    });

    $(document).off('click', '#blai-edit-save').on('click', '#blai-edit-save', () => {
        const saveResult = saveCurrentEditingRule({ toastMessage: '合集保存成功', focusLatest: true });
        if (!saveResult.ok) return;
        $('#blai-rule-edit-modal').hide();
        if (isSearchGroupEditFlow()) {
            clearRuleSearchEditFlow();
            openRuleSearchModal();
        }
    });

    $(document).off('click', '#blai-deep-clean-btn').on('click', '#blai-deep-clean-btn', () => showConfirmModal(() => performDeepCleanse()));

    $(document).off('change', '#blai-preset-select, #blai-tools-preset-select').on('change', '#blai-preset-select, #blai-tools-preset-select', function() {
        const settings = extension_settings[extensionName];
        const oldPreset = settings.activePreset;
        const newPreset = $(this).val();

        if (oldPreset && newPreset !== oldPreset && checkUnsavedChanges()) {
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

    $(document).off('change.blai-purifier-chat-preset-binding', '#settings_preset_openai').on('change.blai-purifier-chat-preset-binding', '#settings_preset_openai', function() {
        setTimeout(() => {
            applyCharacterPresetBinding(true, { skipCleanse: true });
            refreshCharacterBindingUI();
        }, 0);
    });

    $(document).off('click', '#blai-default-toggle').on('click', '#blai-default-toggle', function() {
        const settings = extension_settings[extensionName];
        const activePreset = String(settings.activePreset || '');
        if (!activePreset) { showRiskInfoModal('请先在下拉框中选择一个净化预设。'); return; }
        const isDefaultActive = settings.defaultPreset === activePreset;
        settings.defaultPreset = isDefaultActive ? "" : activePreset;
        saveSettingsDebounced();
        refreshCharacterBindingUI();
        showToast(isDefaultActive ? '已取消全局默认' : `已设为全局默认：${activePreset}`);
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
            if (!activePreset) { showRiskInfoModal('请先在下拉框中选择一个净化预设。'); return; }
            if (!context.key) { showRiskInfoModal('当前页面未识别到可绑定角色。'); refreshCharacterBindingUI(); return; }
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
            runtimeState.lastCharacterContextKey = context.key;
            runtimeState.lastPresetBindingSignature = "";
            applyPresetByName(activePreset, { skipRender: true });
            saveSettingsDebounced();
            refreshCharacterBindingUI();
            $('#blai-bind-menu').prop('hidden', true);
            $('#blai-character-bind-toggle').attr('aria-expanded', 'false');
            showToast(`已绑定：${context.name} → ${activePreset}`);
            return;
        }

        if (action === 'chat-preset') {
            if (!activePreset) { showRiskInfoModal('请先在下拉框中选择一个净化预设。'); return; }
            if (!chatCompletionPresetName) { showRiskInfoModal('当前没有识别到 ST 对话补全预设。'); refreshCharacterBindingUI(); return; }
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
            runtimeState.lastPresetBindingSignature = "";
            applyPresetByName(activePreset, { skipRender: true });
            saveSettingsDebounced();
            refreshCharacterBindingUI();
            $('#blai-bind-menu').prop('hidden', true);
            $('#blai-character-bind-toggle').attr('aria-expanded', 'false');
            showToast(`已绑定：对话补全预设 ${chatCompletionPresetName} → ${activePreset}`);
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
            runtimeState.lastCharacterContextKey = "";
            runtimeState.lastPresetBindingSignature = "";
            applyCharacterPresetBinding(true);
            saveSettingsDebounced();
            refreshCharacterBindingUI();
            $('#blai-bind-menu').prop('hidden', true);
            $('#blai-character-bind-toggle').attr('aria-expanded', 'false');
            showToast(removedRolePreset ? '已取消当前角色绑定，改为跟随全局默认' : '已取消当前对话补全预设绑定，改为跟随全局默认');
            return;
        }

    });

    $(document).off('click', '#blai-preset-rename').on('click', '#blai-preset-rename', function() {
        const settings = extension_settings[extensionName];
        const oldName = settings.activePreset;
        if (!oldName) { alert("当前为临时规则，请先新建存档。"); return; }
        const newName = prompt("输入新存档名称：", oldName);
        if (!newName || newName === oldName) return;
        if (settings.presets[newName]) { alert("存档名称已存在。"); return; }
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
            if (settings.defaultPreset === name) settings.defaultPreset = "";
            Object.keys(settings.characterBindings || {}).forEach((key) => {
                if (settings.characterBindings[key] === name) delete settings.characterBindings[key];
            });
            Object.keys(settings.chatCompletionPresetBindings || {}).forEach((presetName) => {
                if (settings.chatCompletionPresetBindings[presetName] === name) delete settings.chatCompletionPresetBindings[presetName];
            });
            settings.activePreset = "";
            settings.rules = [];
            markRulesDataDirty({ presetsUi: true });
            saveSettingsDebounced();
            renderTags();
            updateToolbarUI();
            performGlobalCleanse();
            showToast("删除成功");
        }
    });

    $(document).off('click', '#blai-preset-new').on('click', '#blai-preset-new', function() {
        const settings = extension_settings[extensionName];
        const name = prompt("输入新存档名称：");
        if (!name) return;
        if (settings.presets[name]) { alert("存档名称已存在。"); return; }
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
        if (!settings.activePreset) { showToast("当前为临时规则，请点击“新建”保存为新存档。"); return; }
        settings.presets[settings.activePreset] = buildCurrentPresetEntry(settings.rules);
        saveSettingsDebounced();
        showToast("保存成功");
    });

    $(document).off('click', '#blai-preset-export').on('click', '#blai-preset-export', function() {
        const settings = extension_settings[extensionName];
        const data = JSON.stringify(buildPresetExportPayload(settings), null, 2);
        const blob = new Blob([data], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (settings.activePreset || "临时规则") + ".json";
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
        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) {
                cleanupInput();
                return;
            }
            const reader = new FileReader();
            reader.onload = event => {
                try {
                    const importedPayload = JSON.parse(event.target.result);
                    const importedRules = normalizeImportedRulesPayload(importedPayload);
                    if (!Array.isArray(importedRules)) throw new Error("格式非数组");
                    const importedAiRewriteSettings = extractPresetImportAiRewriteSettings(importedPayload);

                    const defaultName = file.name.replace(/\.json$/i, '');
                    if (!confirmBeforeImportChoiceIfUnsaved()) return;
                    openImportChoiceModal(importedRules, defaultName, importedAiRewriteSettings);
                } catch (err) {
                    alert("导入失败：检查文件是否为合法规则数组。");
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

    bindHostLifecycleEvents();
}
