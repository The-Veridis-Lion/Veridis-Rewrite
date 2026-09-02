/**
 * Owns Veridis shell creation, shell-level responsive page projection, and legacy-plugin
 * shell warning state; feature-specific business state belongs to feature modules.
 */
import { markPresetsUiDirty } from '../presets/state.js';
import { markRulesUiDirty } from '../rules/state.js';
import { logger } from '../log.js';

function applyTauriMobileSurface(selector, surface) {
    $(selector).attr('data-tt-mobile-surface', surface);
}

export function annotateTauriMobileSurfaces() {
    applyTauriMobileSurface('#blai-purifier-popup, #blai-deep-clean-workspace, #blai-feedback-workspace', 'fullscreen-window');
    applyTauriMobileSurface('.blai-modal-shell, #blai-rule-transfer-modal, #blai-diff-modal, #blai-loading-overlay', 'backdrop');
    applyTauriMobileSurface('.blai-modal-card:not(.blai-tour-card), .blai-transfer-content, .blai-diff-modal-card, .blai-loading-panel, .blai-scope-tag-editor-card', 'fullscreen-window');
    applyTauriMobileSurface('.blai-toast', 'free-window');
}

export function isLegacyPurifierDetected() {
    const hasLegacyDom = Boolean(
        document.getElementById('bl-purifier-popup')
        || document.getElementById('bl-wand-btn')
        || document.getElementById('bl-extension-settings-entry')
        || document.getElementById('bl-wand-btn-panel')
    );
    const hasLegacyScript = Array.from(document.scripts || [])
        .some((script) => /\/Veridis-Keyword-filtering-main\//i.test(String(script.src || '')));
    return hasLegacyDom || hasLegacyScript;
}

export function updateLegacyPurifierWarning() {
    const $warning = $('#blai-legacy-purifier-warning');
    if (!$warning.length) return false;
    const detected = isLegacyPurifierDetected();
    $warning.prop('hidden', !detected);
    return detected;
}

const responsivePageMetadata = {
    overview: {
        title: '首页',
        description: '管理规则集、查看统计并编辑规则。',
    },
    ai: {
        title: 'AI',
        description: '配置 AI 改写引擎、连接参数和全局提示词。',
    },
    clean: {
        title: '净化',
        description: '管理需要被改写或保护的 XML 标签范围及深度净化设置。',
    },
    bind: {
        title: '绑定',
        description: '',
    },
    tools: {
        title: '工具',
        description: '管理预设绑定、简繁转换及其他扩展功能。',
    },
};

export function showResponsivePage(pageId = 'overview') {
    const normalizedPage = responsivePageMetadata[pageId] ? pageId : 'overview';
    const { title, description } = responsivePageMetadata[normalizedPage];
    const $popup = $('#blai-purifier-popup');
    if (!$popup.length) return;

    $popup.find('.page-panel').each(function() {
        $(this).toggleClass('active', String($(this).attr('data-page') || '') === normalizedPage);
    });
    $popup.find('.rail-btn, .nav-item').each(function() {
        $(this).toggleClass('active', String($(this).attr('data-page-target') || '') === normalizedPage);
    });
    $popup.find('[data-title], #blai-responsive-title').text(title);
    $popup.find('#blai-responsive-description').text(description);
    $popup.find('#blai-character-bind-toggle').attr('aria-expanded', 'false');
}

export async function setupUI(renderTemplate) {
    if (typeof renderTemplate !== 'function') {
        throw new TypeError('setupUI requires a SillyTavern template renderer');
    }
    logger.debug('[setupUI] 开始初始化 UI');
    $('#blai-purifier-popup, #blai-rule-edit-modal, #blai-risk-confirm-modal, #blai-risk-info-modal, #blai-deep-clean-workspace, #blai-feedback-workspace, #blai-rule-transfer-modal, #blai-preset-import-choice-modal, #blai-rule-search-modal, #blai-scope-tags-modal, #blai-scope-tag-editor-modal, #blai-diff-modal, #blai-subrule-edit-modal, #blai-ai-prompt-modal, #blai-loading-overlay, .blai-toast').remove();

    const ensureExtensionPanelEntry = () => {
        if ($('#blai-extension-settings-entry').length || !$('#extensions_settings').length) return;
        $('#extensions_settings').append(`
            <div id="blai-extension-settings-entry" class="inline-drawer blai-extension-settings-entry">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>屏蔽词净化助手 AI版</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down interactable"></div>
                </div>
                <div class="inline-drawer-content">
                    <button id="blai-wand-btn-panel" type="button" class="menu_button blai-extension-open-btn">
                        <i class="fa-solid fa-language fa-fw"></i>
                        <span>打开 AI 词汇映射</span>
                    </button>
                </div>
            </div>
        `);
    };

    if (!$('#blai-wand-btn').length) {
        $('#data_bank_wand_container').append(`
            <div id="blai-wand-btn" title="词汇映射管理">
                <i class="fa-solid fa-language fa-fw"></i><span>词汇映射</span>
            </div>`);
    }
    ensureExtensionPanelEntry();
    window.setTimeout(ensureExtensionPanelEntry, 500);

    const templateHtml = await renderTemplate(
        'third-party/Veridis-Rewrite/templates',
        'purifier',
        {},
        false,
        false,
    );
    $('body').append(templateHtml);
    updateLegacyPurifierWarning();
    window.setTimeout(updateLegacyPurifierWarning, 800);
    markRulesUiDirty(true);
    markPresetsUiDirty(true);
    annotateTauriMobileSurfaces();
}
