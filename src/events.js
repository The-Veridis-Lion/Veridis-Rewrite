// Owns top-level Veridis shell/general UI event binding, directly composes feature binders, and retains cross-feature shell toggles/actions; Rules, Scope, Presets, Deep Clean, Feedback, Diff, AI Settings, Theme, Chinese dictionary, and host lifecycle own their feature business implementations.
import { extensionName } from './settings/defaults.js';
import { getAppContext } from './host/appContext.js';
import { clearPendingShujukuRewrite } from './shujuku/realtime.js';
import { showResponsivePage, updateLegacyPurifierWarning } from './ui/shell.js';
import { applyPresetByName, hasActivePresetUnsavedChanges } from './presets/application.js';
import { refreshCharacterBindingUI, updateToolbarUI } from './presets/view.js';
import { bindPresetEvents } from './presets/events.js';
import { bindRuleEvents } from './rules/events.js';
import { closeRuleSearchModal, renderTags } from './rules/view.js';
import { syncPersonaDescriptionProtectionControl } from './ui/personaProtection.js';
import { normalizeZhVariantSettings } from './zh/dictionary.js';
import { bindHostLifecycleEvents } from './host/lifecycleEvents.js';
import { bindAiSettingsEvents } from './aiRewrite/settingsEvents.js';
import { bindThemeEvents } from './ui/theme.js';
import { bindZhEvents } from './zh/events.js';
import { bindScopeEvents } from './scope/events.js';
import { closeScopeTagsModal, renderScopeTagsModal } from './scope/view.js';
import { bindDiffEvents } from './diff/events.js';
import { bindDeepCleanEvents } from './deepClean/events.js';
import { bindComposerButtonAiRewriteEvent, updateComposerButtonSetting } from './aiRewrite/composerButton.js';
import { bindFeedbackEvents } from './feedback/events.js';
import { bindTourEvents, offerMainTourFirstUse } from './ui/tour.js';

export function bindEvents() {
    const { extension_settings, saveSettingsDebounced, eventSource } = getAppContext();
    const openPurifier = () => {
        updateToolbarUI();
        updateLegacyPurifierWarning();
        showResponsivePage('overview');
        renderTags();
        renderScopeTagsModal();
        $('#blai-purifier-popup').css('display', 'grid').hide().fadeIn(200);
        offerMainTourFirstUse();
    };
    bindComposerButtonAiRewriteEvent(eventSource);
    bindFeedbackEvents();
    bindTourEvents();

    $(document).off('click', '#blai-wand-btn, #blai-wand-btn-panel').on('click', '#blai-wand-btn, #blai-wand-btn-panel', openPurifier);

    $(document).off('click', '#blai-purifier-popup [data-page-target]').on('click', '#blai-purifier-popup [data-page-target]', function(e) {
        e.preventDefault();
        const pageId = String($(this).attr('data-page-target') || 'overview');
        showResponsivePage(pageId);
        if (pageId === 'clean') renderScopeTagsModal();
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
            refreshCharacterBindingUI();
            return;
        }
        if (target) target.click();
    });

    $(document).off('click', '#blai-purifier-popup [data-blai-binding-disclosure]').on('click', '#blai-purifier-popup [data-blai-binding-disclosure]', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const $disclosure = $(this);
        const detailId = String($disclosure.attr('aria-controls') || '');
        const detail = detailId ? document.getElementById(detailId) : null;
        if (!detail) return;
        const shouldExpand = detail.hidden;
        $('#blai-purifier-popup [data-blai-binding-disclosure]').not(this).attr('aria-expanded', 'false').find('i').removeClass('fa-chevron-up').addClass('fa-chevron-down');
        $('#blai-purifier-popup .blai-tools-binding-detail').not(detail).prop('hidden', true);
        detail.hidden = !shouldExpand;
        $disclosure.attr('aria-expanded', String(shouldExpand));
        $disclosure.find('i').toggleClass('fa-chevron-up', shouldExpand).toggleClass('fa-chevron-down', !shouldExpand);
    });

    $(document).off('click', '#blai-close-legacy-plugin').on('click', '#blai-close-legacy-plugin', function(e) {
        e.preventDefault();
        updateLegacyPurifierWarning();
        const legacyEntry = document.getElementById('bl-extension-settings-entry') || document.getElementById('bl-wand-btn');
        if (legacyEntry) {
            $('#blai-purifier-popup').fadeOut(120);
            legacyEntry.scrollIntoView({ behavior: 'smooth', block: 'center' });
            legacyEntry.classList.remove('blai-legacy-target-flash');
            void legacyEntry.offsetWidth;
            legacyEntry.classList.add('blai-legacy-target-flash');
            window.setTimeout(() => legacyEntry.classList.remove('blai-legacy-target-flash'), 1800);
        }
    });

    $(document).off('click', '#blai-close-btn').on('click', '#blai-close-btn', () => {
        if (hasActivePresetUnsavedChanges()) {
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
    const syncSkipUserToggle = () => {
        const enabled = settings.skipUserMessages === true;
        $('#blai-skip-user-toggle')
            .attr('aria-pressed', String(enabled))
            .attr('title', enabled ? '关闭跳过用户消息' : '开启跳过用户消息')
            .find('.blai-switch-state')
            .text(enabled ? '开启' : '关闭');
    };
    syncSkipUserToggle();

    const syncComposerButtonToggle = () => {
        const enabled = settings.showComposerAiRewriteButton === true;
        $('#blai-composer-button-toggle')
            .attr('aria-pressed', String(enabled))
            .attr('title', enabled ? '关闭输入框 AI 改写快捷键' : '开启输入框 AI 改写快捷键')
            .find('.blai-tools-switch-state')
            .text(enabled ? '开启' : '关闭');
    };
    syncComposerButtonToggle();

    const syncShujukuAutoRewriteToggle = () => {
        const enabled = settings.shujukuAutoProgramRewriteEnabled === true;
        $('#blai-shujuku-auto-rewrite-toggle')
            .attr('aria-pressed', String(enabled))
            .attr('title', enabled ? '关闭 Shujuku 数据库自动净化' : '开启 Shujuku 数据库自动净化')
            .attr('aria-label', enabled ? '关闭 Shujuku 数据库自动净化' : '开启 Shujuku 数据库自动净化')
            .find('.blai-tools-switch-state')
            .text(enabled ? '开启' : '关闭');
    };
    syncShujukuAutoRewriteToggle();

    $(document).off('click', '#blai-shujuku-auto-rewrite-toggle').on('click', '#blai-shujuku-auto-rewrite-toggle', function(e) {
        e.preventDefault();
        settings.shujukuAutoProgramRewriteEnabled = settings.shujukuAutoProgramRewriteEnabled !== true;
        if (!settings.shujukuAutoProgramRewriteEnabled) clearPendingShujukuRewrite();
        saveSettingsDebounced();
        syncShujukuAutoRewriteToggle();
    });

    $(document).off('click', '#blai-composer-button-toggle').on('click', '#blai-composer-button-toggle', function(e) {
        e.preventDefault();
        const enabled = settings.showComposerAiRewriteButton !== true;
        updateComposerButtonSetting(enabled);
        syncComposerButtonToggle();
    });

    $(document).off('click', '#blai-skip-user-toggle').on('click', '#blai-skip-user-toggle', function(e) {
        e.preventDefault();
        settings.skipUserMessages = settings.skipUserMessages !== true;
        saveSettingsDebounced();
        syncSkipUserToggle();
    });

    $(document).off('click', '.blai-persona-description-protect-toggle').on('click', '.blai-persona-description-protect-toggle', function(e) {
        e.preventDefault();
        settings.protectPersonaDescription = settings.protectPersonaDescription !== true;
        saveSettingsDebounced();
        syncPersonaDescriptionProtectionControl();
    });

    bindRuleEvents();
    bindScopeEvents();
    bindDeepCleanEvents();
    bindDiffEvents();
    bindThemeEvents();
    bindZhEvents();
    bindAiSettingsEvents();
    bindPresetEvents();
    bindHostLifecycleEvents();
}
