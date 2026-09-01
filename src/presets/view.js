/**
 * Owns Preset toolbar, binding, and preset-owned AI-generation DOM projection.
 * Invalid binding cleanup is delegated to presets/bindings.js before rendering;
 * this module does not own Preset selection or settings persistence.
 */
import { defaultAiRewriteSettings, extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { presetsRuntimeState, markPresetsUiDirty } from './state.js';
import { getCurrentCharacterContext, getCurrentChatCompletionPresetName } from '../host/context.js';
import { cleanupInvalidPresetBindings, getPresetBindingInspection, getPresetBindingResolution, getPresetBindingUsage } from './bindings.js';
import { safeHtml } from '../ui/html.js';

function getAiTimeoutSeconds(timeoutMs) {
    const parsed = Number(timeoutMs);
    const fallback = Number(defaultAiRewriteSettings.timeoutMs) || 120000;
    const normalizedMs = Number.isFinite(parsed) ? parsed : fallback;
    return Math.min(Math.max(Math.round(normalizedMs / 1000), 1), 120);
}

export function syncPresetAiRewriteGenerationSettingsUI(settings) {
    const aiSettings = {
        ...defaultAiRewriteSettings,
        ...(settings?.aiRewrite && typeof settings.aiRewrite === 'object' ? settings.aiRewrite : {}),
    };
    const setValueIfNotFocused = (selector, value) => {
        const $field = $(selector);
        if (!$field.is(':focus')) $field.val(value);
    };
    $('#blai-ai-protect-comments').prop('checked', aiSettings.protectXmlComments === true);
    setValueIfNotFocused('#blai-ai-temperature', aiSettings.temperature);
    setValueIfNotFocused('#blai-ai-top-p', aiSettings.topP);
    setValueIfNotFocused('#blai-ai-top-k', aiSettings.topK);
    setValueIfNotFocused('#blai-ai-frequency-penalty', aiSettings.frequencyPenalty);
    setValueIfNotFocused('#blai-ai-presence-penalty', aiSettings.presencePenalty);
    setValueIfNotFocused('#blai-ai-repetition-penalty', aiSettings.repetitionPenalty);
    setValueIfNotFocused('#blai-ai-max-tokens', aiSettings.maxTokens);
    setValueIfNotFocused('#blai-ai-timeout', getAiTimeoutSeconds(aiSettings.timeoutMs));
    setValueIfNotFocused('#blai-ai-max-retries', aiSettings.maxRetries);
    setValueIfNotFocused('#blai-ai-max-items', aiSettings.maxItemsPerRequest);
    setValueIfNotFocused('#blai-ai-max-context', aiSettings.maxContextChars);
    setValueIfNotFocused('#blai-ai-prompt', aiSettings.promptTemplate || defaultAiRewriteSettings.promptTemplate);
    setValueIfNotFocused('#blai-ai-prompt-expanded', aiSettings.promptTemplate || defaultAiRewriteSettings.promptTemplate);
}

function formatBindingList(names = []) {
    if (!names.length) return '';
    const shown = names.slice(0, 2).join('、');
    return names.length > 2 ? `${shown} 等 ${names.length} 个` : shown;
}

export function refreshCharacterBindingUI() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const context = getCurrentCharacterContext();
    const activePreset = String(settings.activePreset || '');
    const chatCompletionPresetName = getCurrentChatCompletionPresetName();
    const bindingResolution = getPresetBindingResolution(context.key, { chatCompletionPresetName });
    const $defaultBtn = $('#blai-default-toggle');
    const $bindBtn = $('#blai-character-bind-toggle');
    const $bindCurrentItem = $('#blai-bind-current-character');
    const $bindChatPresetItem = $('#blai-bind-current-chat-preset');
    const $unbindItem = $('#blai-unbind-current-character');
    const currentBound = bindingResolution.characterPreset;
    const currentChatBound = bindingResolution.chatCompletionPreset;
    const bindingInspection = getPresetBindingInspection();
    const activeUsage = getPresetBindingUsage(activePreset);

    if ($defaultBtn.length && $bindBtn.length) {
        const isDefaultActive = !!(activePreset && settings.defaultPreset === activePreset);
        $defaultBtn.toggleClass('blai-bind-active', isDefaultActive);
        $defaultBtn.prop('disabled', !activePreset);
        $defaultBtn.attr('aria-pressed', String(isDefaultActive));
        $defaultBtn.attr('title', activePreset ? (isDefaultActive ? `已设为全局默认：${activePreset}（点击取消）` : `将当前净化预设设为全局默认：${activePreset}`) : '请先选择一个净化预设');

        const isCharacterBound = !!(context.key && activePreset && currentBound === activePreset);
        const isChatPresetBound = !!(chatCompletionPresetName && activePreset && currentChatBound === activePreset);
        const hasCurrentBinding = !!((context.key && currentBound) || (chatCompletionPresetName && currentChatBound));
        const roleBindingWillSwitchFromChatPreset = !!(activePreset && activeUsage.hasChatCompletionPresetBindings && !isCharacterBound);
        const chatPresetBindingWillSwitchFromRole = !!(activePreset && activeUsage.hasCharacterBindings && !isChatPresetBound);
        $('#blai-tools-global-preset').text(settings.defaultPreset || '无');
        $('#blai-tools-character-context').text(context.key ? context.name : '无');
        $('#blai-tools-character-binding').text(currentBound || '未绑定');
        $('#blai-tools-chat-context').text(chatCompletionPresetName || '无');
        $('#blai-tools-chat-binding').text(currentChatBound || '未绑定');
        $('#blai-tools-global-preset').closest('.blai-tools-binding-item').toggleClass('is-bound', !!settings.defaultPreset);
        $('#blai-tools-character-binding').closest('.blai-tools-binding-item').toggleClass('is-bound', !!currentBound);
        $('#blai-tools-chat-binding').closest('.blai-tools-binding-item').toggleClass('is-bound', !!currentChatBound);
        const renderInspectionRows = (selector, entries, emptyText) => {
            const $list = $(selector).empty();
            if (!entries.length) {
                $('<span>', { class: 'blai-tools-binding-detail-empty', text: emptyText }).appendTo($list);
                return;
            }
            entries.forEach(({ name, presetName }) => {
                const $row = $('<div>', { class: 'blai-tools-binding-detail-row' });
                $('<span>', { text: name }).appendTo($row);
                $('<strong>', { text: presetName }).appendTo($row);
                $row.appendTo($list);
            });
        };
        renderInspectionRows('#blai-tools-character-detail-list', bindingInspection.characterBindings, '暂无角色绑定');
        renderInspectionRows('#blai-tools-chat-detail-list', bindingInspection.chatCompletionPresetBindings, '暂无补全预设绑定');
        $bindBtn.toggleClass('blai-bind-active', hasCurrentBinding);
        $bindBtn.prop('disabled', false);
        $bindBtn.attr('aria-pressed', String(hasCurrentBinding));
        $bindBtn.find('i').removeClass('fa-link-slash').addClass('fa-link');
        $bindBtn.attr('title', !context.key
            ? (currentChatBound ? `绑定管理：当前对话预设已绑定 ${currentChatBound}` : '绑定管理：未检测到当前角色')
            : currentBound
                ? `绑定管理：${context.name} 已绑定 ${currentBound}`
                : currentChatBound
                    ? `绑定管理：对话预设 ${chatCompletionPresetName} 已绑定 ${currentChatBound}`
                    : `绑定管理：当前跟随${bindingResolution.source === 'default' ? '全局默认' : '未绑定状态'}`);

        $bindCurrentItem
            .prop('disabled', !activePreset || !context.key || isCharacterBound)
            .toggleClass('is-active', isCharacterBound);
        $bindCurrentItem.find('.blai-bind-menu-label').text(isCharacterBound ? '已绑定当前角色' : '绑定当前角色');
        $bindCurrentItem.find('.blai-bind-menu-note').text(!activePreset
            ? '请先选择净化预设'
            : !context.key
                ? '未检测到角色'
                : roleBindingWillSwitchFromChatPreset
                    ? `切换为角色绑定，会移除：${formatBindingList(activeUsage.chatCompletionPresetNames)}`
                    : currentBound && currentBound !== activePreset
                        ? `当前角色已绑定 ${currentBound}，点击改绑`
                        : `使用净化预设：${activePreset}`);

        $bindChatPresetItem
            .prop('disabled', !activePreset || !chatCompletionPresetName || isChatPresetBound)
            .toggleClass('is-active', isChatPresetBound);
        $bindChatPresetItem.find('.blai-bind-menu-label').text(isChatPresetBound ? '已绑定当前对话补全预设' : '绑定当前对话补全预设');
        $bindChatPresetItem.find('.blai-bind-menu-note').text(!activePreset
            ? '请先选择净化预设'
            : !chatCompletionPresetName
                ? '未检测到 ST 对话补全预设'
                : chatPresetBindingWillSwitchFromRole
                    ? `切换为对话补全预设绑定，会移除角色绑定：${activeUsage.characterKeys.length} 个`
                    : currentChatBound && currentChatBound !== activePreset
                        ? `当前对话预设已绑定 ${currentChatBound}，点击改绑`
                        : `跟随对话预设：${chatCompletionPresetName}`);

        $unbindItem
            .prop('disabled', !currentBound && !currentChatBound)
            .toggleClass('is-active', !!(currentBound || currentChatBound));
        $unbindItem.find('.blai-bind-menu-label').text(currentBound ? '取消角色绑定' : currentChatBound ? '取消对话预设绑定' : '取消当前绑定');
        $unbindItem.find('.blai-bind-menu-note').text(currentBound
            ? `当前角色：${currentBound}`
            : currentChatBound
                ? `当前对话预设：${currentChatBound}`
                : '当前没有绑定');

        const syncProxyFieldState = (selector, $target) => {
            const $proxy = $(`#blai-purifier-popup [data-blai-click-proxy="${selector}"]`);
            if (!$proxy.length || !$target.length) return;
            const active = $target.hasClass('is-active')
                || $target.hasClass('blai-bind-active')
                || $target.attr('aria-pressed') === 'true';
            const canToggleActiveBinding = active && $proxy.attr('data-blai-toggle-binding') === 'true';
            const disabled = $target.prop('disabled') === true && !canToggleActiveBinding;
            const note = String($target.find('.blai-bind-menu-note').text() || $target.attr('title') || '').trim();
            $proxy
                .attr('aria-disabled', String(disabled))
                .attr('aria-pressed', String(active))
                .toggleClass('is-disabled', disabled)
                .toggleClass('is-active', active)
                .attr('title', note || (disabled ? '当前操作不可用' : '点击执行'));
        };

        syncProxyFieldState('#blai-default-toggle', $defaultBtn);
        syncProxyFieldState('#blai-bind-current-character', $bindCurrentItem);
        syncProxyFieldState('#blai-bind-current-chat-preset', $bindChatPresetItem);

    }
}

export function updateToolbarUI() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    cleanupInvalidPresetBindings();
    const selects = $('#blai-preset-select, #blai-tools-preset-select');
    if (!selects.length) return;

    if (presetsRuntimeState.presetsUiDirty || selects.filter((_, element) => element.children.length === 0).length > 0) {
        const presetNames = settings.presets ? Object.keys(settings.presets) : [];
        const optionsHtml = ['<option value="">-- 临时规则 (未绑定存档) --</option>']
            .concat(presetNames.map((name) => `<option value="${safeHtml(name)}">${safeHtml(name)}</option>`))
            .join('');
        selects.html(optionsHtml);
        markPresetsUiDirty(false);
    }
    selects.val(settings.activePreset || '');
    const rules = Array.isArray(settings.rules) ? settings.rules : [];
    const activePresetLabel = settings.activePreset || '临时规则';
    const aiRuleCount = rules.reduce((count, rule) => count + (Array.isArray(rule?.subRules)
        ? rule.subRules.filter((sub) => sub?.rewriteMode === 'ai').length
        : 0), 0);
    $('#blai-responsive-preset-title, #blai-responsive-mobile-preset-title, #blai-bind-active-preset').text(activePresetLabel);
    $('#blai-rule-group-count').text(String(rules.length));
    $('#blai-ai-rule-count').text(String(aiRuleCount));
    refreshCharacterBindingUI();
}
