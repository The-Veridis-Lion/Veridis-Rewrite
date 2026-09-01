/**
 * Owns Rules user actions, rule-setting mutations, and their settings-save boundary.
 * Rule parsing/regex semantics remain in model.js / regex.js.
 */
import { extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { diffRuntimeState } from '../diff/state.js';
import { markRulesDataDirty, rulesRuntimeState } from './state.js';
import { buildRuleActivationConfirmMessage, getRuleActivationWarning, isRuleActivationWarningEnabled, normalizeRuleActivationSafety, parseInputToWords } from './model.js';
import { validateRegexTargetInput } from './regex.js';
import { buildPresetEntry, deepClone, getCurrentPresetAiRewriteSettings, getPresetAiRewriteSettings, getPresetRules } from '../presets/model.js';
import { showRiskConfirmModal, showRiskInfoModal, showToast } from '../ui/notifications.js';
import {
    clearRuleSearchEditFlow,
    closeRuleSearchModal,
    closeTransferModal,
    focusLatestRuleCard,
    getSingleRuleReplacementValues,
    hasPendingRegexReplacementInput,
    openEditModal,
    openRuleSearchModal,
    openSingleRuleModal,
    openTransferModal,
    recognizeRegexReplacementInput,
    removeRegexReplacementInput,
    renderRuleSearchModal,
    renderSubrulesToModal,
    renderTags,
    setSingleRuleReplacementEditor,
    startEditingRegexReplacementInput,
    syncRuleSearchInputUi,
} from './view.js';

const ruleObjectIdMap = new WeakMap();
let nextRuleObjectId = 1;

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
    const selectedSet = new Set(rulesRuntimeState.batchSelectedRuleIds || []);
    return rules.map((rule, idx) => (selectedSet.has(ensureRuleObjectId(rule)) ? idx : -1)).filter((idx) => idx >= 0);
}

function syncBatchSelectionStateFromDom(rules) {
    const indexes = $('.batch-item-checkbox:checked').map(function() { return Number($(this).data('index')); }).get().filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < rules.length);
    rulesRuntimeState.batchSelectedRuleIds = getRuleIdsByIndexes(rules, indexes);
}

function applyBatchSelectionStateToDom(rules) {
    const selectedSet = new Set(rulesRuntimeState.batchSelectedRuleIds || []);
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
    rulesRuntimeState.batchSelectedRuleIds = (rulesRuntimeState.batchSelectedRuleIds || []).filter((id) => id !== deletingId);
    return true;
}

function deleteSelectedRules(rules, selectedIndexes) {
    if (!Array.isArray(selectedIndexes) || selectedIndexes.length <= 1) return false;
    const deletingSet = new Set(selectedIndexes);
    const deletingIds = new Set(getRuleIdsByIndexes(rules, selectedIndexes));
    const nextRules = rules.filter((_, idx) => !deletingSet.has(idx));
    rules.splice(0, rules.length, ...nextRules);
    rulesRuntimeState.batchSelectedRuleIds = (rulesRuntimeState.batchSelectedRuleIds || []).filter((id) => !deletingIds.has(id));
    return true;
}

function handleDeleteRule(index, rules) {
    if (shouldBatchTransferRule(index, rules)) {
        return deleteSelectedRules(rules, getSelectedIndexesFromState(rules));
    }
    return deleteSingleRule(rules, index);
}

function renderTagsPreserveBatchSelection() {
    const shell = document.getElementById('blai-purifier-popup');
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement && activeElement.closest('#blai-home-rule-grid')) {
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

function isSearchGroupEditFlow() {
    return rulesRuntimeState.searchEditFlow.active === true && rulesRuntimeState.searchEditFlow.returnMode === 'group';
}

function isSearchDirectSubruleFlow() {
    return rulesRuntimeState.searchEditFlow.active === true && rulesRuntimeState.searchEditFlow.returnMode === 'subrule';
}

function isRelatedDirectSubruleFlow() {
    return rulesRuntimeState.searchEditFlow.active === true && rulesRuntimeState.searchEditFlow.returnMode === 'related';
}

function resetRuleSearchQueryState() {
    rulesRuntimeState.ruleSearchKeyword = '';
    rulesRuntimeState.ruleSearchDraftKeyword = '';
    rulesRuntimeState.ruleSearchHasSearched = false;
    rulesRuntimeState.ruleSearchExpandedMenuKey = '';
    clearRuleSearchEditFlow();
}

function submitRuleSearch() {
    rulesRuntimeState.ruleSearchDraftKeyword = String($('#blai-rule-search-input').val() || '');
    rulesRuntimeState.ruleSearchKeyword = rulesRuntimeState.ruleSearchDraftKeyword.trim();
    rulesRuntimeState.ruleSearchHasSearched = rulesRuntimeState.ruleSearchKeyword.length > 0;
    rulesRuntimeState.ruleSearchExpandedMenuKey = '';
    renderRuleSearchModal();
}

function saveCurrentEditingRule(options = {}) {
    const {
        toastMessage = '合集保存成功',
        focusLatest = true,
    } = options;
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const rules = extension_settings[extensionName].rules || [];
    const isCreatingNewRule = rulesRuntimeState.currentEditingIndex === -1;
    const nameVal = String($('#blai-edit-name').val() || '').trim();
    const validSubrules = rulesRuntimeState.currentEditingSubrules.filter(sub => sub.targets && sub.targets.length > 0);

    if (validSubrules.length === 0) {
        showToast('合集内至少需要保留一组有效映射！');
        return { ok: false };
    }

    const previousRule = rulesRuntimeState.currentEditingIndex !== -1 ? rules[rulesRuntimeState.currentEditingIndex] : null;
    const isEnabled = previousRule?.enabled !== false;
    const activationWarning = getRuleActivationWarning(previousRule);
    const activationWarningEnabled = isRuleActivationWarningEnabled(previousRule);

    const fallbackName = rulesRuntimeState.currentEditingIndex !== -1
        ? (rules[rulesRuntimeState.currentEditingIndex]?.name || `合集 ${rulesRuntimeState.currentEditingIndex + 1}`)
        : `合集 ${rules.length + 1}`;
    const newRule = normalizeRuleActivationSafety({
        name: nameVal || fallbackName,
        subRules: validSubrules,
        activationWarning,
        activationWarningEnabled,
        enabled: activationWarningEnabled ? false : isEnabled,
    });

    if (rulesRuntimeState.currentEditingIndex === -1) rules.push(newRule);
    else rules[rulesRuntimeState.currentEditingIndex] = newRule;

    markRulesDataDirty();
    saveSettingsDebounced();
    renderTags();
    if (isCreatingNewRule && focusLatest) {
        window.setTimeout(() => {
            focusLatestRuleCard();
        }, 50);
    }
    renderRuleSearchModal();
    if (toastMessage) showToast(toastMessage);
    return { ok: true, isCreatingNewRule, rule: newRule };
}

function formatRegexTargetError(error) {
    return `第 ${error.line} 行：${error.message}`;
}

function clearRegexTargetValidationState() {
    $('#blai-modal-sub-target').removeClass('blai-invalid').removeAttr('aria-invalid');
    $('#blai-modal-sub-target-error').removeClass('is-visible').text('');
}

function applyRegexTargetValidationError(error) {
    const message = formatRegexTargetError(error);
    $('#blai-modal-sub-target').addClass('blai-invalid').attr('aria-invalid', 'true');
    $('#blai-modal-sub-target-error').addClass('is-visible').text(message);
    return message;
}

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

function validateRegexTargetField(options = {}) {
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
}

function applySubruleModeUI(rawMode) {
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
}

function applySubruleRewriteModeUI() {
    const rewriteMode = $('#blai-modal-sub-rewrite-mode').val() === 'ai' ? 'ai' : 'program';
    const isAiMode = rewriteMode === 'ai';
    $('#blai-modal-sub-rep-label').text(isAiMode ? '流式临时替换 / API 参考候选' : '替换为');
    $('#blai-modal-sub-rewrite-hint').text(isAiMode
        ? '生成中只做视觉预览，生成结束后把命中片段发给配置的 AI 接口局部改写。'
        : '沿用当前本地替换逻辑，生成结束后直接写入消息数据。');
    $('#blai-modal-sub-ai-prompt-field').prop('hidden', !isAiMode);
    $('#blai-modal-sub-ai-prompt').prop('disabled', !isAiMode);
    $('#blai-modal-sub-ai-prompt-hint').text('只填写这条规则命中时的特殊处理；通用风格仍由全局提示词控制。');
}

function runRuleTransfer(isMove) {
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const settings = extension_settings[extensionName];
    const targetPreset = String($('#blai-transfer-target').val() || '');
    const sourcePreset = String(settings.activePreset || '');
    const transferIndexes = rulesRuntimeState.currentTransferRuleIndexes;
    const validIndexes = transferIndexes
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v >= 0);
    if (validIndexes.length === 0) return;
    if (!targetPreset) {
        alert('请选择目标存档。');
        return;
    }
    if (targetPreset === sourcePreset) {
        closeTransferModal();
        return;
    }

    const sourceRules = settings.rules || [];
    const uniqueIndexes = [...new Set(validIndexes)].sort((a, b) => a - b).filter((idx) => idx < sourceRules.length);
    if (uniqueIndexes.length === 0) {
        closeTransferModal();
        return;
    }

    const targetEntry = settings.presets[targetPreset];
    const targetRules = deepClone(getPresetRules(targetEntry));
    const movingRules = uniqueIndexes.map((idx) => sourceRules[idx]).filter(Boolean);
    movingRules.forEach((rule) => targetRules.push(deepClone(rule)));
    settings.presets[targetPreset] = buildPresetEntry(
        targetRules,
        getPresetAiRewriteSettings(targetEntry) || getCurrentPresetAiRewriteSettings(settings.aiRewrite)
    );
    if (isMove) {
        for (let i = uniqueIndexes.length - 1; i >= 0; i--) {
            sourceRules.splice(uniqueIndexes[i], 1);
        }
        rulesRuntimeState.batchSelectedRuleIds = [];
        markRulesDataDirty();
    }

    closeTransferModal();
    saveSettingsDebounced();
    if (isMove) renderTags();
}

export function bindRuleEvents() {
    const { extension_settings, saveSettingsDebounced } = getAppContext();

    $(document).off('click', '#blai-rule-sort-toggle').on('click', '#blai-rule-sort-toggle', function(e) {
        e.preventDefault();
        const rules = extension_settings[extensionName].rules || [];
        rules.reverse();
        markRulesDataDirty();
        saveSettingsDebounced();
        renderTagsPreserveBatchSelection();
        showToast('分组顺序已反转');
    });

    $(document).off('click', '#blai-preset-search').on('click', '#blai-preset-search', () => {
        openRuleSearchModal();
    });

    $(document).off('click', '#blai-rule-search-back').on('click', '#blai-rule-search-back', () => {
        closeRuleSearchModal({ reset: true });
    });

    $(document).off('input', '#blai-rule-search-input').on('input', '#blai-rule-search-input', function() {
        rulesRuntimeState.ruleSearchDraftKeyword = String($(this).val() || '');
        syncRuleSearchInputUi();
        if (rulesRuntimeState.ruleSearchDraftKeyword.trim() !== '') return;
        rulesRuntimeState.ruleSearchKeyword = '';
        rulesRuntimeState.ruleSearchHasSearched = false;
        rulesRuntimeState.ruleSearchExpandedMenuKey = '';
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

    $(document).off('click', '.blai-rule-search-menu-toggle').on('click', '.blai-rule-search-menu-toggle', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const nextKey = String($(this).data('key') || '');
        rulesRuntimeState.ruleSearchExpandedMenuKey = rulesRuntimeState.ruleSearchExpandedMenuKey === nextKey ? '' : nextKey;
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

        rulesRuntimeState.ruleSearchExpandedMenuKey = '';
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
        if (!rulesRuntimeState.ruleSearchExpandedMenuKey) return;
        rulesRuntimeState.ruleSearchExpandedMenuKey = '';
        renderRuleSearchModal();
    });

    $(document).off('click', '#blai-batch-toggle').on('click', '#blai-batch-toggle', function() {
        const $popup = $('#blai-purifier-popup');
        const isBatchMode = !$popup.hasClass('blai-is-batch-mode');
        $popup.toggleClass('blai-is-batch-mode', isBatchMode);
        $(this)
            .toggleClass('blai-active', isBatchMode)
            .attr('aria-expanded', String(isBatchMode));
        if (!isBatchMode) {
            $('.batch-item-checkbox').prop('checked', false);
            rulesRuntimeState.batchSelectedRuleIds = [];
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
        if (!Number.isInteger(index) || index < 0 || index >= rulesRuntimeState.currentEditingSubrules.length) return;
        rulesRuntimeState.currentEditingSubrules[index].enabled = $(this).prop('checked');
        renderSubrulesToModal();
    });

    $(document).off('click', '.blai-move-subrule-up-btn').on('click', '.blai-move-subrule-up-btn', function() {
        const index = Number($(this).data('index'));
        if (index <= 0 || index >= rulesRuntimeState.currentEditingSubrules.length) return;
        [rulesRuntimeState.currentEditingSubrules[index - 1], rulesRuntimeState.currentEditingSubrules[index]] = [rulesRuntimeState.currentEditingSubrules[index], rulesRuntimeState.currentEditingSubrules[index - 1]];
        renderSubrulesToModal();
    });

    $(document).off('click', '.blai-move-subrule-down-btn').on('click', '.blai-move-subrule-down-btn', function() {
        const index = Number($(this).data('index'));
        if (index < 0 || index >= rulesRuntimeState.currentEditingSubrules.length - 1) return;
        [rulesRuntimeState.currentEditingSubrules[index], rulesRuntimeState.currentEditingSubrules[index + 1]] = [rulesRuntimeState.currentEditingSubrules[index + 1], rulesRuntimeState.currentEditingSubrules[index]];
        renderSubrulesToModal();
    });

    $(document).off('click', '.blai-del-subrule-btn').on('click', '.blai-del-subrule-btn', function() {
        const index = Number($(this).data('index'));
        if (!Number.isInteger(index) || index < 0 || index >= rulesRuntimeState.currentEditingSubrules.length) return;
        if (!confirm('确定要删除该映射规则吗？')) return;
        rulesRuntimeState.currentEditingSubrules.splice(index, 1);
        renderSubrulesToModal();
        showToast('词条删除成功');
    });

    $(document).off('click', '.blai-edit-subrule-btn').on('click', '.blai-edit-subrule-btn', function() {
        openSingleRuleModal($(this).data('index'));
    });

    $(document).off('click', '.blai-remark-subrule-btn').on('click', '.blai-remark-subrule-btn', function(e) {
        e.preventDefault();
        const index = $(this).data('index');
        const sub = rulesRuntimeState.currentEditingSubrules[index];
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

        const previousSubRule = rulesRuntimeState.currentSubruleEditIndex >= 0
            ? rulesRuntimeState.currentEditingSubrules[rulesRuntimeState.currentSubruleEditIndex]
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

        if (rulesRuntimeState.currentSubruleEditIndex === -1) {
            rulesRuntimeState.currentEditingSubrules.push(subRule);
        } else {
            rulesRuntimeState.currentEditingSubrules[rulesRuntimeState.currentSubruleEditIndex] = subRule;
        }

        clearRegexTargetValidationState();
        if (isDirectSearchFlow || isRelatedFlow) {
            const saveResult = saveCurrentEditingRule({ toastMessage: '条目保存成功', focusLatest: false });
            if (!saveResult.ok) return;
            $('#blai-subrule-edit-modal').fadeOut(150, () => {
                $('#blai-rule-edit-modal').hide();
                clearRuleSearchEditFlow();
                if (isDirectSearchFlow) openRuleSearchModal();
                else if (diffRuntimeState.currentDiffIndex !== undefined) renderDiffModalContent(diffRuntimeState.currentDiffIndex);
            });
            return;
        }

        $('#blai-subrule-edit-modal').fadeOut(150);
        renderSubrulesToModal();

        if (rulesRuntimeState.currentSubruleEditIndex === -1) {
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
}
