/**
 * Owns applying the persisted Veridis theme to current UI surfaces and the theme-toggle action.
 */
import { extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { showToast } from './notifications.js';

export function bindThemeEvents() {
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const settings = extension_settings[extensionName];
    const applyThemeMode = (mode) => {
        const normalized = ['auto', 'light', 'dark'].includes(mode) ? mode : 'auto';
        const labels = {
            auto: '跟随酒馆',
            light: '白色主题',
            dark: '暗色主题',
        };
        const icons = {
            auto: 'fa-circle-half-stroke',
            light: 'fa-sun',
            dark: 'fa-moon',
        };
        settings.themeMode = normalized;
        $('#blai-purifier-popup, .blai-modal-shell, #blai-rule-transfer-modal, #blai-diff-modal, #blai-rule-search-modal, #blai-preset-import-choice-modal, .blai-toast, #blai-loading-overlay, #blai-scope-tag-editor-modal, #blai-tour-layer').attr('data-theme', normalized);
        $('#blai-theme-toggle, #blai-purifier-popup [data-blai-click-proxy="#blai-theme-toggle"]')
            .attr('title', `当前主题：${labels[normalized]}，点击切换`)
            .attr('aria-label', `当前主题：${labels[normalized]}，点击切换`);
        $('#blai-theme-toggle i, #blai-purifier-popup [data-blai-click-proxy="#blai-theme-toggle"] i').attr('class', `fas ${icons[normalized]}`);
    };

    applyThemeMode(settings.themeMode || 'auto');

    $(document).off('click', '#blai-theme-toggle').on('click', '#blai-theme-toggle', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const modes = ['auto', 'light', 'dark'];
        const current = String(settings.themeMode || 'auto');
        const nextMode = modes[(Math.max(0, modes.indexOf(current)) + 1) % modes.length];
        applyThemeMode(nextMode);
        saveSettingsDebounced();
        showToast(`已切换主题：${nextMode === 'auto' ? '跟随酒馆' : nextMode === 'light' ? '白色主题' : '暗色主题'}`);
    });
}
