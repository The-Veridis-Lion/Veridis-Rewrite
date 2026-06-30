import { defaultAiRewriteSettings, extensionName, getAppContext, runtimeState, markRulesDataDirty, markRulesUiDirty, markPresetsUiDirty } from './state.js';
import { logger } from './log.js';
import { COT_SCOPE_TAG_DISPLAY_TEXT, DEFAULT_SCOPE_TAG_GROUP_ID, DEFAULT_SCOPE_TAG_GROUP_NAME, buildPresetEntry, deepClone, getCurrentCharacterContext, getCurrentChatCompletionPresetName, getCurrentPresetAiRewriteSettings, getPresetAiRewriteSettings, getPresetBindingResolution, getPresetBindingUsage, getPresetForCharacter, getPresetRules, isCotScopeTagEntry, mergeScopeTagsWithBuiltins, normalizeScopeTagCollapsedGroupList, normalizeScopeTagGroupList, parseInputToWords } from './utils.js';
import { performGlobalCleanse } from './core.js';
import { performDeepCleanse } from './cleanse.js';

function safeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatReplacementCandidatePreview(value) {
    const normalized = String(value ?? '').replace(/\r/g, '');
    return normalized ? safeHtml(normalized).replace(/\n/g, ' ↵ ') : '【直接删除】';
}

function formatReplacementPreview(replacements, mode = 'text') {
    if (!Array.isArray(replacements) || replacements.length === 0) return '【直接删除】';
    if (mode === 'regex') {
        return replacements.map((value) => `〔${formatReplacementCandidatePreview(value)}〕`).join(' / ');
    }
    return replacements.map(formatReplacementCandidatePreview).join(', ');
}

function getRewriteMode(sub) {
    return sub?.rewriteMode === 'ai' ? 'ai' : 'program';
}

function getRewriteModeBadgeHtml(sub) {
    return getRewriteMode(sub) === 'ai'
        ? '<span class="blai-tag blai-ai-rewrite-badge">AI 改写</span>'
        : '';
}

function normalizeReplacementList(replacements) {
    return Array.isArray(replacements) ? replacements.map((value) => String(value ?? '')) : [];
}

function getRulePreviewTagText(mode = 'text') {
    if (mode === 'regex') return '正则';
    if (mode === 'simple') return '简易';
    return '普通';
}

function getRuleSourcePreviewText(sub = {}) {
    const mode = sub.mode || 'text';
    return safeHtml((sub.targets || []).join(mode === 'text' ? ', ' : ' | ')) || '（空）';
}

function getRuleSearchMenuKey(ruleIndex, subRuleIndex) {
    return `${ruleIndex}:${subRuleIndex}`;
}

function applyTauriMobileSurface(selector, surface) {
    $(selector).attr('data-tt-mobile-surface', surface);
}

function annotateTauriMobileSurfaces() {
    applyTauriMobileSurface('#blai-purifier-popup', 'fullscreen-window');
    applyTauriMobileSurface('.blai-modal-shell, #blai-rule-transfer-modal, #blai-diff-modal, #blai-loading-overlay', 'backdrop');
    applyTauriMobileSurface('.blai-modal-card, .blai-transfer-content, .blai-diff-modal-card, .blai-loading-panel, .blai-scope-tag-editor-card, .blai-scope-group-manager-card', 'fullscreen-window');
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

const responsivePageTitles = {
    overview: '首页',
    ai: 'AI',
    clean: '净化',
    bind: '绑定',
    tools: '工具',
};

export function showResponsivePage(pageId = 'overview') {
    const normalizedPage = responsivePageTitles[pageId] ? pageId : 'overview';
    const title = responsivePageTitles[normalizedPage];
    const $popup = $('#blai-purifier-popup');
    if (!$popup.length) return;

    $popup.find('.page-panel').each(function() {
        $(this).toggleClass('active', String($(this).attr('data-page') || '') === normalizedPage);
    });
    $popup.find('.rail-btn, .nav-item').each(function() {
        $(this).toggleClass('active', String($(this).attr('data-page-target') || '') === normalizedPage);
    });
    $popup.find('[data-title], #blai-responsive-title').text(title);
    $popup.find('#blai-character-bind-toggle').attr('aria-expanded', 'false');
}

function buildRuleSearchHaystack(sub = {}) {
    const mode = sub.mode || 'text';
    const targets = Array.isArray(sub.targets) ? sub.targets.join(mode === 'text' ? ' ' : '\n') : '';
    const replacements = Array.isArray(sub.replacements) ? sub.replacements.join('\n') : '';
    return `${targets}\n${replacements}`.toLowerCase();
}

function buildRuleSearchResults(keyword) {
    const normalizedKeyword = String(keyword || '').trim().toLowerCase();
    if (!normalizedKeyword) return [];

    const { extension_settings } = getAppContext();
    const rules = extension_settings?.[extensionName]?.rules || [];
    const results = [];

    rules.forEach((rule, ruleIndex) => {
        (rule.subRules || []).forEach((sub, subRuleIndex) => {
            if (!buildRuleSearchHaystack(sub).includes(normalizedKeyword)) return;
            const mode = sub.mode || 'text';
            results.push({
                key: getRuleSearchMenuKey(ruleIndex, subRuleIndex),
                ruleIndex,
                subRuleIndex,
                groupName: safeHtml(rule.name || `合集 ${ruleIndex + 1}`),
                tagText: getRulePreviewTagText(mode),
                sourcePreview: getRuleSourcePreviewText(sub),
                replacementPreview: formatReplacementPreview(sub.replacements || [], mode),
                isEnabled: rule.enabled !== false && sub.enabled !== false,
            });
        });
    });

    return results;
}

function getRegexReplacementEditIndex() {
    const rawIndex = Number($('#blai-modal-sub-rep').data('regex-edit-index'));
    return Number.isInteger(rawIndex) ? rawIndex : -1;
}

function getRegexReplacementChipValues() {
    return $('#blai-modal-sub-regex-list').children('.blai-regex-replacement-chip').map(function() {
        return String($(this).data('value') ?? '');
    }).get();
}

function buildRegexReplacementChip(value = '') {
    const normalizedValue = String(value ?? '');
    const preview = formatReplacementCandidatePreview(normalizedValue);
    const $chip = $(`
        <div class="blai-regex-replacement-chip" data-index="0">
            <button type="button" class="blai-regex-replacement-chip-main" data-index="0" title="点击编辑替换项"></button>
            <button type="button" class="blai-regex-replacement-chip-remove" data-index="0" title="删除替换项">
                <i class="fas fa-times"></i>
            </button>
        </div>
    `);
    $chip.data('value', normalizedValue);
    $chip.find('.blai-regex-replacement-chip-main').html(preview).attr('title', normalizedValue || '点击编辑替换项');
    return $chip;
}

function appendRegexReplacementInputs(values = [], options = {}) {
    const normalizedValues = normalizeReplacementList(values);
    const { sync = true } = options;
    if (normalizedValues.length === 0) return $();

    const $container = $('#blai-modal-sub-regex-list');
    const fragment = document.createDocumentFragment();
    const nodes = [];
    normalizedValues.forEach((value) => {
        const node = buildRegexReplacementChip(value)[0];
        nodes.push(node);
        fragment.appendChild(node);
    });
    $container.append(fragment);
    if (sync) syncRegexReplacementInputState();
    return $(nodes);
}

function syncRegexReplacementInputState() {
    const $container = $('#blai-modal-sub-regex-list');
    const $textarea = $('#blai-modal-sub-rep');
    $container.children('.blai-regex-replacement-empty').remove();
    const $items = $container.children('.blai-regex-replacement-chip');
    let editIndex = getRegexReplacementEditIndex();
    if (editIndex >= $items.length) {
        editIndex = -1;
        $textarea.data('regex-edit-index', -1);
    }
    $items.each((index, element) => {
        const $element = $(element);
        $element.attr('data-index', index);
        $element.toggleClass('is-active', index === editIndex);
        $element.find('.blai-regex-replacement-chip-main').attr('data-index', index);
        $element.find('.blai-regex-replacement-chip-remove').attr('data-index', index);
    });
    const isEditing = editIndex >= 0;
    const defaultPlaceholder = String($textarea.data('regex-default-placeholder') || '');
    const editPlaceholder = String($textarea.data('regex-edit-placeholder') || defaultPlaceholder);
    const isRegexEditorVisible = !$('#blai-modal-sub-regex-actions').prop('hidden');
    if ($items.length === 0 && isRegexEditorVisible) {
        $container.append(`
            <div class="blai-regex-replacement-empty" aria-live="polite">
                <i class="fas fa-eraser"></i>
                <span>未添加替换项，命中后将直接删除。</span>
            </div>
        `);
    }
    $container.prop('hidden', $items.length === 0 && !isRegexEditorVisible);
    $('#blai-modal-sub-regex-recognize').text(isEditing ? '更新替换项' : '按行识别');
    $textarea.attr('placeholder', isEditing ? editPlaceholder : defaultPlaceholder);
}

export function showToast(message) {
    $('.blai-toast').remove();
    const themeMode = String($('#blai-purifier-popup').attr('data-blai-theme') || 'auto');
    // 替换为 100% 兼容的 fas fa-exclamation-circle 图标
    const $toast = $(`<div class="blai-toast" data-blai-theme="${themeMode}" data-tt-mobile-surface="free-window" role="status" aria-live="polite"><i class="fas fa-exclamation-circle" style="margin-right: 6px; font-size: 15px;"></i><span class="blai-toast-text"></span></div>`);
    $toast.find('.blai-toast-text').text(String(message || ''));
    $('body').append($toast);
    setTimeout(() => $toast.addClass('blai-show'), 10);
    setTimeout(() => {
        $toast.removeClass('blai-show');
        setTimeout(() => $toast.remove(), 300);
    }, 2000);
}

export function setupUI() {
    logger.debug('[setupUI] 开始初始化 UI');
    $('#blai-purifier-popup, #blai-rule-edit-modal, #blai-confirm-modal, #blai-rule-transfer-modal, #blai-preset-import-choice-modal, #blai-rule-search-modal, #blai-scope-tags-modal, #blai-diff-modal, #blai-subrule-edit-modal, #blai-ai-prompt-modal, #blai-loading-overlay, .blai-toast').remove();

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

    const responsiveIcons = {
        overview: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="6" rx="2"/><rect x="4" y="14" width="16" height="6" rx="2"/></svg>',
        ai: '<svg viewBox="0 0 24 24"><path d="M12 2v20"/><path d="M5 8h14"/></svg>',
        clean: '<svg viewBox="0 0 24 24"><path d="M4 14c4-9 12-9 16 0"/><path d="M8 14c2 4 6 4 8 0"/><path d="M12 4v3M5 7l2 2M19 7l-2 2"/></svg>',
        tools: '<svg viewBox="0 0 24 24"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3 5.3-5.3a4 4 0 0 0 5.4-5.4z"/></svg>',
        save: '<svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/></svg>',
        close: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    };
    const railPages = [
        ['overview', '首页', responsiveIcons.overview],
        ['ai', 'AI', responsiveIcons.ai],
        ['clean', '净化', responsiveIcons.clean],
        ['tools', '工具', responsiveIcons.tools],
    ];
    const mobilePages = railPages;
    const navButtonHtml = (page, className) => `<button type="button" class="${className} ${page[0] === 'overview' ? 'active' : ''}" data-page-target="${page[0]}">${page[2]}<span>${page[1]}</span></button>`;
    const bindMenuHtml = `
        <div id="blai-bind-menu" class="blai-bind-menu" role="menu" hidden>
            <button type="button" id="blai-bind-current-character" class="blai-bind-menu-item" data-bind-action="character" role="menuitem">
                <i class="fas fa-user-tag"></i>
                <span class="blai-bind-menu-copy">
                    <span class="blai-bind-menu-label">绑定当前角色</span>
                    <span class="blai-bind-menu-note">使用当前净化预设</span>
                </span>
            </button>
            <button type="button" id="blai-bind-current-chat-preset" class="blai-bind-menu-item" data-bind-action="chat-preset" role="menuitem">
                <i class="fas fa-comments"></i>
                <span class="blai-bind-menu-copy">
                    <span class="blai-bind-menu-label">绑定当前对话补全预设</span>
                    <span class="blai-bind-menu-note">跟随 ST 当前对话补全预设</span>
                </span>
            </button>
            <button type="button" id="blai-unbind-current-character" class="blai-bind-menu-item" data-bind-action="unbind-character" role="menuitem">
                <i class="fas fa-rotate-left"></i>
                <span class="blai-bind-menu-copy">
                    <span class="blai-bind-menu-label">取消当前绑定</span>
                    <span class="blai-bind-menu-note">改为跟随全局默认</span>
                </span>
            </button>
        </div>
    `;

    $('body').append(`
        <div id="blai-purifier-popup" class="blai-app-shell scheme-a" data-blai-theme="auto" style="display:none;">
            <div class="statusbar"><span>9:41</span><span class="traffic"><span class="dot"></span><span class="dot"></span><span class="battery"></span></span></div>
            <div class="windowbar">
                <button id="blai-close-btn" type="button" class="blai-window-close" title="关闭" aria-label="关闭">×</button>
                <button id="blai-theme-toggle" type="button" class="text-btn blai-toolbar-icon-btn blai-theme-action" title="切换主题" aria-label="切换主题"><i class="fas fa-circle-half-stroke" aria-hidden="true"></i></button>
                <div class="desktop-title"><strong id="blai-responsive-title" data-title>首页</strong><span id="blai-responsive-preset-title">临时规则</span></div>
                <div class="desktop-actions">
                    <span id="blai-responsive-model-pill" class="pill">AI 改写</span>
                    <button id="blai-preset-save" type="button" class="text-btn accent blai-toolbar-icon-btn" title="保存" aria-label="保存"><i class="fas fa-save" aria-hidden="true"></i></button>
                </div>
            </div>
            <div class="phone-top">
                <button type="button" class="round-btn" data-blai-click-proxy="#blai-close-btn" aria-label="关闭">${responsiveIcons.close}</button>
                <button type="button" class="round-btn" data-blai-click-proxy="#blai-theme-toggle" aria-label="切换主题"><i class="fas fa-circle-half-stroke" aria-hidden="true"></i></button>
                <div class="phone-title"><strong data-title>首页</strong><span id="blai-responsive-mobile-preset-title">临时规则</span></div>
                <button type="button" class="round-btn" data-blai-click-proxy="#blai-preset-save" aria-label="保存">${responsiveIcons.save}</button>
            </div>
            <div class="app-main">
                <nav class="rail">
                    <div class="brand"><strong>Veridis Rewrite</strong><span>AI 净化工作台</span></div>
                    ${railPages.map((page) => navButtonHtml(page, 'rail-btn')).join('')}
                </nav>
                <div class="pages">
                    <section class="page-panel active" data-page="overview">
                        <div class="panel">
                            <div class="panel-head"><strong>当前预设</strong></div>
                            <div id="blai-legacy-purifier-warning" class="blai-legacy-warning" role="status" aria-live="polite" hidden>
                                <div class="blai-legacy-warning-icon" aria-hidden="true"><i class="fas fa-triangle-exclamation"></i></div>
                                <div class="blai-legacy-warning-main">
                                    <div class="blai-legacy-warning-title">检测到旧版 purifier</div>
                                    <div class="blai-legacy-warning-text">旧版与 AI 版只能保留一个，请在 SillyTavern 扩展管理中关闭旧插件。</div>
                                </div>
                                <button id="blai-close-legacy-plugin" type="button" class="blai-legacy-warning-action">关闭旧插件</button>
                            </div>
                            <div class="field-grid">
                                <label class="field blai-preset-field">
                                    <span>净化预设</span>
                                    <select id="blai-preset-select" class="blai-select-box"></select>
                                </label>
                                <div class="metric-grid">
                                    <div class="metric"><b id="blai-rule-group-count">0</b><span>规则组</span></div>
                                    <div class="metric"><b id="blai-ai-rule-count">0</b><span>AI 项</span></div>
                                    <button id="blai-ai-api-check" class="metric api-metric" data-state="idle" type="button"><b id="blai-ai-api-status">未测</b><span>API 检测</span></button>
                                </div>
                            </div>
                        </div>
                        <div class="panel rules-panel">
                            <div class="panel-head">
                                <strong>规则合集</strong>
                                <div class="panel-actions">
                                    <button id="blai-open-new-rule-btn" type="button" class="text-btn accent"><i class="fas fa-folder-plus"></i><span>添加</span></button>
                                    <button id="blai-preset-search" type="button" class="text-btn"><i class="fas fa-magnifying-glass"></i><span>搜索</span></button>
                                    <button id="blai-batch-toggle" type="button" class="text-btn"><i class="fas fa-list-check"></i><span>编辑</span></button>
                                </div>
                            </div>
                            <div class="rule-manager" id="blai-batch-operations">
                                <div class="rule-manager-row">
                                    <div class="selection-status"><strong>批量编辑模式</strong></div>
                                    <span class="selection-hint">规则合集</span>
                                </div>
                                <div class="batch-actions">
                                    <button class="text-btn" id="blai-btn-select-all"><i class="far fa-check-square"></i> 全选</button>
                                    <button class="text-btn" id="blai-btn-select-invert"><i class="fas fa-minus-square"></i> 反选</button>
                                    <button class="text-btn" id="blai-btn-batch-transfer"><i class="fas fa-copy"></i> 复制 / 转移</button>
                                    <button class="text-btn blai-danger" id="blai-btn-batch-delete"><i class="fas fa-trash"></i> 删除</button>
                                </div>
                            </div>
                            <div id="blai-tags-container" class="list blai-card-list"></div>
                        </div>
                    </section>
                    <section class="page-panel" data-page="ai">
                        <div id="blai-ai-settings" class="content-grid blai-ai-settings">
                            <div class="panel">
                                <div class="panel-head"><strong>API 与模型</strong><em id="blai-ai-settings-status">未启用</em></div>
                                <div class="blai-ai-toggle-row">
                                    <label class="blai-checkbox-label">
                                        <input type="checkbox" id="blai-ai-enabled">
                                        <span class="blai-custom-checkbox blai-square"></span>
                                        <span>启用 AI 改写</span>
                                    </label>
                                </div>
                                <div class="field-grid">
                                    <label class="field blai-ai-field"><span>Base URL</span><input type="text" id="blai-ai-base-url" class="blai-input" placeholder="https://api.openai.com/v1"></label>
                                    <label class="field blai-ai-field"><span>XML 标签</span><input type="text" id="blai-ai-xml-scope" class="blai-input" placeholder="<content>"></label>
                                    <label class="field blai-ai-field blai-ai-model-field">
                                        <span>模型</span>
                                        <span class="blai-ai-model-row">
                                            <select id="blai-ai-model" class="blai-select-box blai-ai-model-select"></select>
                                            <button type="button" id="blai-ai-model-fetch" class="text-btn" title="拉取 /models，不发送聊天消息">拉取模型</button>
                                        </span>
                                    </label>
                                    <label class="field blai-ai-field blai-api-key-field">
                                        <span>API Key</span>
                                        <span class="blai-ai-key-row">
                                            <input type="password" id="blai-ai-api-key" class="blai-input" autocomplete="off">
                                            <button type="button" id="blai-ai-api-key-reveal" class="mini-btn" title="显示 / 隐藏 API Key"><i class="fas fa-eye"></i></button>
                                            <button type="button" id="blai-ai-api-key-clear" class="mini-btn" title="清空 API Key"><i class="fas fa-eraser"></i></button>
                                        </span>
                                    </label>
                                </div>
                                <div class="clean-row"><p>命中的助手回复片段会发送到你配置的 OpenAI 兼容接口。</p></div>
                                <div id="blai-ai-http-warning" class="clean-row blai-ai-warning" hidden><p>非本地 HTTP 地址不安全，建议使用 HTTPS 或本地代理。</p></div>
                            </div>
                            <div class="panel">
                                <div class="panel-head"><strong>生成限制</strong><em>安全</em></div>
                                <div class="field"><span>提示词组合</span><small>全局 + 单条改写要求</small></div>
                                <div class="field-grid blai-ai-limit-grid">
                                    <label class="field"><span>温度</span><span class="setting-value"><input type="number" id="blai-ai-temperature" class="setting-input blai-input" min="0" max="2" step="0.1"></span></label>
                                    <label class="field"><span>超时</span><span class="setting-value"><input type="number" id="blai-ai-timeout" class="setting-input blai-input" min="1" max="120" step="1"><em class="setting-unit">s</em></span></label>
                                    <label class="field"><span>失败重试</span><span class="setting-value"><input type="number" id="blai-ai-max-retries" class="setting-input blai-input" min="0" max="5" step="1"><em class="setting-unit">次</em></span></label>
                                    <label class="field"><span>单次上限</span><span class="setting-value"><input type="number" id="blai-ai-max-items" class="setting-input blai-input" min="1" max="32" step="1"><em class="setting-unit">条</em></span></label>
                                    <label class="field"><span>上下文</span><span class="setting-value"><input type="number" id="blai-ai-max-context" class="setting-input blai-input" min="1000" max="60000" step="500"><em class="setting-unit">字</em></span></label>
                                    <label class="field"><span>输出上限</span><span class="setting-value"><input type="number" id="blai-ai-max-rewrite" class="setting-input blai-input" min="50" max="10000" step="50"><em class="setting-unit">字</em></span></label>
                                </div>
                                <div class="edit-field blai-ai-field blai-ai-prompt-card">
                                    <div class="blai-ai-prompt-card-head">
                                        <div class="blai-ai-prompt-copy">
                                            <span>全局 Prompt template</span>
                                            <small>用于所有 AI 改写项；单条规则可在编辑弹窗里追加专用要求。</small>
                                        </div>
                                        <button id="blai-ai-prompt-expand" type="button" class="text-btn blai-ai-prompt-expand" title="展开编辑全局 Prompt template" aria-label="展开编辑全局 Prompt template">
                                            <i class="fas fa-expand"></i>
                                        </button>
                                    </div>
                                    <textarea id="blai-ai-prompt" class="blai-textarea text-box" rows="7" aria-label="全局 Prompt template"></textarea>
                                </div>
                                <div class="field blai-ai-debug-field">
                                    <span>Debug 日志</span>
                                    <button type="button" id="blai-ai-copy-log" class="text-btn" title="排查 AI 改写请求、重试和写回问题时使用；复制最近诊断日志">复制 Debug 日志</button>
                                </div>
                            </div>
                        </div>
                    </section>
                    <section class="page-panel" data-page="clean">
                        <div class="content-grid clean-page-shell">
                            <div class="panel tight scope-manager blai-scope-tags-card clean-scope-panel">
                                <div class="panel-head"><strong>范围标签</strong><em>净化模式</em></div>
                                <div class="segmented blai-scope-mode-segment" role="group" aria-label="范围标签净化模式">
                                    <button id="blai-scope-mode-protect" type="button" class="blai-scope-mode-option" data-mode="protect">保护特定标签</button>
                                    <button id="blai-scope-mode-cleanse" type="button" class="blai-scope-mode-option" data-mode="cleanse-inside">净化特定标签</button>
                                </div>
                                <div class="scope-input-row">
                                    <input id="blai-scope-quick-input" class="scope-input" value="" placeholder="输入标签或 <horae>//备注">
                                    <button id="blai-scope-tag-add-quick" type="button" class="text-btn accent">添加</button>
                                </div>
                                <div id="blai-scope-tags-list" class="managed-tag-list scope-group-list blai-scope-tags-list"></div>
                                <div class="row-actions three">
                                    <button id="blai-scope-tags-expand-all" type="button" class="text-btn">展开</button>
                                    <button id="blai-scope-tags-collapse-all" type="button" class="text-btn">折叠</button>
                                    <button id="blai-scope-group-manage-open" type="button" class="text-btn">分组</button>
                                </div>
                                <div id="blai-scope-tags-hint" class="blai-scope-tags-hint"></div>
                            </div>
                            <div class="panel tight clean-control-panel">
                                <div class="cleanse-target-card">
                                    <div class="cleanse-target-head"><strong>净化对象</strong><small>保护范围</small></div>
                                    <div class="cleanse-target-item">
                                        <div class="row-main"><strong>跳过用户消息</strong><button id="blai-skip-user-toggle" type="button" class="text-btn" aria-pressed="false">关闭</button></div>
                                        <p>用户消息、发送输入框和编辑输入区不进入净化。</p>
                                    </div>
                                    <div class="cleanse-target-item">
                                        <div class="row-main"><strong>人设描述保护</strong><button type="button" class="blai-persona-description-protect-toggle text-btn" aria-pressed="false" title="点击保护用户设定描述"><span class="blai-persona-protect-text">关闭</span></button></div>
                                        <p>保护 persona_description，深度清理时也避让。</p>
                                    </div>
                                    <div class="cleanse-target-item blai-realtime-mask-item">
                                        <div class="row-main"><strong>实时屏蔽模式</strong><span id="blai-realtime-mask-label">简单视觉</span></div>
                                        <div class="segmented blai-realtime-mask-segment" role="group" aria-label="实时屏蔽模式">
                                            <button type="button" class="blai-realtime-mask-option" data-mode="simple-visual">简单视觉屏蔽</button>
                                            <button type="button" class="blai-realtime-mask-option" data-mode="tavern-helper">酒馆助手实时渲染</button>
                                        </div>
                                        <p id="blai-realtime-mask-note">生成中只扫当前输出消息 DOM，尽量保留酒馆美化。</p>
                                    </div>
                                </div>
                                <div class="clean-deep-section">
                                    <div class="panel-head"><strong>深度净化</strong></div>
                                    <div class="clean-row"><p>永久处理隐藏历史聊天记录、角色卡、世界书、人设等。清理与否不影响日常使用。</p></div>
                                </div>
                                <div class="row-actions deep-action-row">
                                    <button id="blai-deep-clean-btn" class="text-btn accent"><i class="fas fa-broom"></i> 深度清理</button>
                                </div>
                            </div>
                        </div>
                    </section>
                    <section class="page-panel" data-page="tools">
                        <div class="content-grid">
                            <div class="panel preset-management-panel">
                                <div class="panel-head"><strong>预设管理</strong><em>本地 JSON</em></div>
                                <div class="row-actions three preset-actions">
                                    <button id="blai-preset-rename" type="button" class="text-btn"><i class="fas fa-pen"></i> 重命名</button>
                                    <button id="blai-preset-new" type="button" class="text-btn"><i class="fas fa-plus"></i> 新建</button>
                                    <button id="blai-preset-delete" type="button" class="text-btn"><i class="fas fa-trash"></i> 删除</button>
                                    <button id="blai-preset-import" type="button" class="text-btn"><i class="fas fa-file-import"></i> 导入</button>
                                    <button id="blai-preset-export" type="button" class="text-btn"><i class="fas fa-file-export"></i> 导出</button>
                                </div>
                                <div class="field-grid preset-import-notes">
                                    <div class="field"><span>只导入为新预设</span><small>不修改当前规则</small></div>
                                    <div class="field"><span>导入并切换使用</span><small>先处理未保存改动</small></div>
                                    <div class="field"><span>仅临时预览</span><small>不保存为预设</small></div>
                                    <div class="field"><span>旧格式识别</span><small>导入时自动转换</small></div>
                                </div>
                            </div>
                            <div class="panel binding-tools-panel">
                                <div class="panel-head"><strong>预设与绑定</strong><em id="blai-bind-active-preset">临时规则</em></div>
                                <div class="field-grid binding-actions-grid">
                                    <button type="button" class="field blai-proxy-field" data-blai-click-proxy="#blai-default-toggle"><span>设为默认</span><small>全局默认</small></button>
                                    <button type="button" class="field blai-proxy-field" data-blai-click-proxy="#blai-bind-current-character"><span>绑定角色</span><small>使用当前净化预设</small></button>
                                    <button type="button" class="field blai-proxy-field" data-blai-click-proxy="#blai-bind-current-chat-preset"><span>绑定对话</span><small>跟随 ST 对话补全预设</small></button>
                                    <button type="button" class="field blai-proxy-field" data-blai-click-proxy="#blai-unbind-current-character"><span>取消绑定</span><small>回到默认预设</small></button>
                                </div>
                                <button id="blai-default-toggle" type="button" class="blai-hidden-real-button" title="设为全局默认净化预设" aria-hidden="true" tabindex="-1"><i class="fas fa-star"></i></button>
                            </div>
                            <div class="panel">
                                <div class="panel-head"><strong>透视楼层</strong><em>对比范围</em></div>
                                <div class="list">
                                    <div class="tool-row blai-diff-limit-row">
                                        <div class="row-main">
                                            <strong>透视楼层</strong>
                                            <div id="blai-diff-limit-control" class="blai-diff-limit-control">
                                                <button id="blai-diff-limit-edit" type="button" class="blai-icon-btn blai-diff-header-btn blai-diff-limit-display" title="设置透视楼层数量">
                                                    <i class="fa-solid fa-layer-group"></i> <span id="blai-diff-limit-text">最近 3 层</span>
                                                </button>
                                                <div id="blai-diff-limit-editor" class="blai-diff-limit-editor" hidden>
                                                    <input type="number" id="blai-diff-limit-input" class="blai-diff-limit-input" inputmode="numeric" min="1" max="20" step="1" aria-label="透视楼层数量">
                                                    <button id="blai-diff-limit-confirm" type="button" class="blai-icon-btn blai-diff-limit-action" title="确认楼层数量"><i class="fas fa-check"></i></button>
                                                    <button id="blai-diff-limit-cancel" type="button" class="blai-icon-btn blai-diff-limit-action" title="取消修改"><i class="fas fa-times"></i></button>
                                                </div>
                                            </div>
                                        </div>
                                        <p>设置对比弹窗读取最近 N 层消息，确认后同步刷新消息旁按钮。</p>
                                    </div>
                                </div>
                            </div>
                            <div class="panel tight">
                                <div class="panel-head"><strong>简繁兼容</strong><em>校验：本地缓存</em></div>
                                <div class="zh-compact-grid">
                                    <span class="zh-chip"><strong>增强词典</strong><span id="blai-zh-dict-status-chip">未安装</span></span>
                                    <span class="zh-chip"><strong>台湾</strong>可选</span>
                                    <span class="zh-chip"><strong>香港</strong>可选</span>
                                </div>
                                <div class="row-actions zh-actions">
                                    <button id="blai-zh-dict-install-open" class="text-btn accent" type="button">下载并启用</button>
                                    <button id="blai-zh-compat-toggle" class="text-btn blai-zh-compat-toggle" type="button" title="简繁兼容已关闭：按当前规则精确匹配" aria-label="简繁兼容模式" aria-pressed="false">开启</button>
                                </div>
                            </div>
                        </div>
                    </section>
                </div>
            </div>
            <nav class="bottom-nav">
                ${mobilePages.map((page) => navButtonHtml(page, 'nav-item')).join('')}
            </nav>
            <div class="blai-hidden-real-bind-menu">
                <button id="blai-character-bind-toggle" type="button" class="blai-hidden-real-button" title="绑定管理" aria-hidden="true" tabindex="-1"></button>
                ${bindMenuHtml}
            </div>
        </div>`);
    updateLegacyPurifierWarning();
    window.setTimeout(updateLegacyPurifierWarning, 800);

    $('body').append(`
        <div id="blai-rule-edit-modal" class="blai-modal-shell">
            <div class="blai-modal-card blai-edit-modal-card">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px; flex-shrink: 0;">
                    <h3 id="blai-edit-modal-title" class="blai-edit-modal-title" style="margin: 0; display: flex; align-items: center; gap: 8px;">
                        <i class="fas fa-pen"></i> 编辑规则合集
                    </h3>
                    <button id="blai-edit-cancel-x" class="blai-icon-btn" style="background: transparent !important; border: none !important; box-shadow: none !important; font-size: 20px !important; color: var(--blai-text-mute); padding: 0 !important; min-width: auto !important; height: auto !important; cursor: pointer;">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="blai-edit-field">
                    <label class="blai-field-label">规则组合集名称</label>
                    <input type="text" id="blai-edit-name" class="blai-input" placeholder="例如：程度副词与认知失能净化" style="background: var(--blai-bg-button) !important; border: 1px solid var(--blai-border-color-base) !important; color: var(--blai-text-main) !important;">
                </div>
                <label class="blai-field-label" style="margin-bottom:6px; flex-shrink:0;">映射规则列表</label>
                <div id="blai-edit-subrules-container"></div>
                
                <div class="blai-modal-actions">
                    <button id="blai-add-subrule-btn" class="blai-secondary-btn"><i class="fas fa-plus"></i> 新增规则</button>
                    <button id="blai-edit-save" class="blai-primary-btn"><i class="fas fa-check"></i> 保存合集</button>
                </div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="blai-confirm-modal" class="blai-modal-shell">
            <div class="blai-modal-card blai-confirm-card">
                <h3 class="blai-confirm-title">⚠️ 深度清理警告</h3>
                <p class="blai-confirm-text">
                    深度清理会永久洗刷角色卡、世界书、人设、全部历史记录及<strong>当前选中的预设</strong>。
                    为了防止深度清理修改或误伤您的以上内容，请在此刻：
                    <br><br>
                    👉 <strong class="blai-warning-callout">将SillyTavern当前的预设切换至「Default」或废弃预设！<br>将插件预设切换至不含名词句式规则(已在贴内提供)。</strong>
                    <br>
                    <span class="blai-field-label">清理完成后页面会刷新，届时可切回原预设即可保证预设安全。</span>
                </p>
                <div class="blai-modal-actions blai-confirm-actions">
                    <button id="blai-modal-cancel" class="blai-secondary-btn blai-confirm-btn">取消返回</button>
                    <button id="blai-modal-confirm" disabled class="blai-primary-btn blai-confirm-btn">我已阅读警告，已完成切换 (3s)</button>
                </div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="blai-ai-prompt-modal" class="blai-modal-shell">
            <div class="blai-modal-card blai-ai-prompt-modal-card">
                <div class="blai-ai-prompt-modal-head">
                    <div class="blai-ai-prompt-modal-title">
                        <h3><i class="fas fa-pen-to-square"></i> 全局 Prompt template</h3>
                        <p>用于所有 AI 改写项；单条规则可在编辑弹窗里追加专用要求。</p>
                    </div>
                    <button id="blai-ai-prompt-modal-close" type="button" class="blai-icon-btn" title="关闭" aria-label="关闭全局 Prompt template 编辑器">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <textarea id="blai-ai-prompt-expanded" class="blai-textarea blai-ai-prompt-expanded" aria-label="全屏编辑全局 Prompt template"></textarea>
                <div class="blai-modal-actions blai-ai-prompt-modal-actions">
                    <button id="blai-ai-prompt-modal-cancel" type="button" class="blai-secondary-btn">关闭</button>
                    <button id="blai-ai-prompt-modal-apply" type="button" class="blai-primary-btn"><i class="fas fa-check"></i> 应用</button>
                </div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="blai-zh-dictionary-modal" class="blai-modal-shell">
            <div class="blai-modal-card blai-zh-dict-card">
                <div class="blai-zh-dict-header">
                    <h3 class="blai-zh-dict-title"><i class="fas fa-language"></i> 增强简繁词典</h3>
                    <button id="blai-zh-dict-close" type="button" class="blai-icon-btn" title="关闭"><i class="fas fa-times"></i></button>
                </div>
                <p class="blai-zh-dict-text">
                    简繁兼容需要先从 GitHub 下载 OpenCC 词典包。若无法连接 GitHub，请开启代理或 VPN 后重试；下载完成并通过完整性校验后，之后会直接使用本地缓存。
                </p>
                <div id="blai-zh-dict-stats" class="blai-zh-dict-stats"></div>
                <div class="blai-zh-dict-options">
                    <label class="blai-checkbox-label" title="匹配台湾常用异体词，例如 仿佛 / 彷彿、软件 / 軟體">
                        <input type="checkbox" id="blai-zh-dict-tw" checked>
                        <span class="blai-custom-checkbox blai-square"></span>
                        <span>台湾异体</span>
                    </label>
                    <label class="blai-checkbox-label" title="匹配香港常用异体词，例如 软件 / 軟件、网络 / 網絡">
                        <input type="checkbox" id="blai-zh-dict-hk" checked>
                        <span class="blai-custom-checkbox blai-square"></span>
                        <span>香港异体</span>
                    </label>
                </div>
                <div class="blai-modal-actions blai-zh-dict-actions">
                    <button id="blai-zh-dict-cancel" type="button" class="blai-secondary-btn">取消</button>
                    <button id="blai-zh-dict-download" type="button" class="blai-primary-btn"><i class="fas fa-download"></i> 下载并启用</button>
                </div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="blai-rule-transfer-modal" style="display:none;">
            <div class="blai-transfer-content">
                <h3 class="blai-edit-modal-title blai-transfer-title"><i class="fas fa-copy"></i> 复制 / 转移规则合集</h3>
                <select id="blai-transfer-target" class="blai-input blai-transfer-target"></select>
                <div class="blai-transfer-actions">
                    <button id="blai-transfer-copy" class="blai-transfer-btn blai-transfer-copy">复制到该存档</button>
                    <button id="blai-transfer-move" class="blai-transfer-btn blai-transfer-move">转移到该存档</button>
                    <button id="blai-transfer-cancel" class="blai-transfer-btn">取消</button>
                </div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="blai-preset-import-choice-modal" class="blai-modal-shell">
            <div class="blai-modal-card blai-import-choice-card">
                <div class="blai-import-choice-header">
                    <h3 class="blai-edit-modal-title"><i class="fas fa-file-import"></i> 导入预设</h3>
                    <button id="blai-import-choice-close" type="button" class="blai-icon-btn" title="关闭"><i class="fas fa-times"></i></button>
                </div>
                <div class="blai-edit-field">
                    <label class="blai-field-label" for="blai-import-preset-name">预设名称</label>
                    <input type="text" id="blai-import-preset-name" class="blai-input" placeholder="导入预设名称">
                </div>
                <div id="blai-import-choice-summary" class="blai-import-choice-summary"></div>
                <div class="blai-import-choice-actions">
                    <button id="blai-import-only" type="button" class="blai-secondary-btn blai-import-choice-btn">
                        <i class="fas fa-box-archive"></i>
                        <span>只导入为新预设</span>
                    </button>
                    <button id="blai-import-switch" type="button" class="blai-primary-btn blai-import-choice-btn">
                        <i class="fas fa-right-left"></i>
                        <span>导入并切换使用</span>
                    </button>
                    <button id="blai-import-preview" type="button" class="blai-secondary-btn blai-import-choice-btn">
                        <i class="fas fa-eye"></i>
                        <span>仅临时预览</span>
                    </button>
                </div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="blai-rule-search-modal" class="blai-modal-shell">
            <div class="blai-modal-card blai-rule-search-card">
                <div class="blai-rule-search-header">
                    <button id="blai-rule-search-back" type="button" class="blai-icon-btn blai-rule-search-back" title="返回搜索页上一级">
                        <i class="fas fa-chevron-left"></i>
                    </button>
                    <div class="blai-rule-search-field">
                        <i class="fas fa-magnifying-glass blai-rule-search-field-icon"></i>
                        <input type="text" id="blai-rule-search-input" class="blai-input blai-rule-search-input" placeholder="搜索内容">
                        <button id="blai-rule-search-clear" type="button" class="blai-icon-btn blai-rule-search-clear" title="清空关键词" hidden>
                            <i class="fas fa-circle-xmark"></i>
                        </button>
                    </div>
                    <button id="blai-rule-search-submit" type="button" class="blai-rule-search-submit">搜索</button>
                </div>
                <div id="blai-rule-search-body" class="blai-rule-search-body"></div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="blai-scope-tag-editor-modal" class="blai-scope-tag-editor-modal" hidden>
            <div class="blai-scope-tag-editor-card" role="dialog" aria-modal="true" aria-labelledby="blai-scope-tag-editor-title">
                <h3 id="blai-scope-tag-editor-title" class="blai-scope-tag-editor-title">新增标签</h3>
                <div class="blai-scope-tag-editor-field">
                    <label class="blai-field-label" for="blai-scope-tag-group-select">所属分组</label>
                    <select id="blai-scope-tag-group-select" class="blai-input blai-scope-tag-input"></select>
                </div>
                <div class="blai-scope-tag-editor-field">
                    <label class="blai-field-label" for="blai-scope-tag-input">输入标签</label>
                    <input type="text" id="blai-scope-tag-input" class="blai-input blai-scope-tag-input" placeholder="如：状态 或 <UpdateVariable>" autocomplete="off">
                    <div class="blai-scope-tag-field-help">填写标签名或完整起始标签，会自动补齐；支持中文标签名，不支持带属性的起始标签。</div>
                </div>
                <div class="blai-scope-tag-editor-field">
                    <label class="blai-field-label" for="blai-scope-tag-label-input">输入备注</label>
                    <input type="text" id="blai-scope-tag-label-input" class="blai-input blai-scope-tag-input" placeholder="如：选项（选填）" autocomplete="off">
                </div>
                <div id="blai-scope-tag-error" class="blai-field-error" aria-live="polite"></div>
                <div class="blai-scope-tag-editor-actions">
                    <button id="blai-scope-tag-reset" type="button" class="blai-scope-tag-cancel">取消</button>
                    <button id="blai-scope-tag-save" type="button" class="blai-scope-tag-confirm">确认</button>
                </div>
            </div>
        </div>

        <div id="blai-scope-group-manager-modal" class="blai-scope-group-manager-modal" hidden>
            <div class="blai-scope-group-manager-card" role="dialog" aria-modal="true" aria-labelledby="blai-scope-group-manager-title">
                <h3 id="blai-scope-group-manager-title" class="blai-scope-tag-editor-title">管理分组</h3>
                <div id="blai-scope-group-manager-list" class="blai-scope-group-manager-list"></div>
                <div class="blai-scope-group-manager-actions">
                    <button id="blai-scope-group-add" type="button" class="blai-scope-tag-cancel">新增分组</button>
                    <button id="blai-scope-group-done" type="button" class="blai-scope-tag-confirm">完成</button>
                </div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="blai-diff-modal" style="display:none;">
            <div class="blai-diff-modal-card">
                <div class="blai-diff-modal-header">
                    <h3 class="blai-diff-modal-title"><i class="fa-solid fa-eye"></i><span class="blai-diff-title-text">净化前文透视</span></h3>
                    <div class="blai-diff-header-actions">
                        <button id="blai-diff-revert-toggle" type="button" class="blai-icon-btn blai-diff-header-btn" title="撤回净化并保护原文">
                            <i id="blai-diff-revert-icon" class="fas fa-rotate-left"></i> <span id="blai-diff-revert-text">撤回</span>
                        </button>
                        <button id="blai-diff-ai-rewrite" type="button" class="blai-icon-btn blai-diff-header-btn" title="对当前消息手动执行 AI 改写">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> <span>AI 改写</span>
                        </button>
                        <button id="blai-diff-mode-toggle" type="button" class="blai-icon-btn blai-diff-header-btn" title="切换到全文模式" aria-label="切换到全文模式">
                            <i id="blai-diff-mode-icon" class="fa-solid fa-file-lines"></i> <span id="blai-diff-mode-text">全文模式</span>
                        </button>
                        <div class="blai-diff-menu-wrap">
                            <button id="blai-diff-menu-toggle" type="button" class="blai-icon-btn blai-diff-header-btn blai-diff-menu-toggle" title="更多操作" aria-label="更多操作" aria-haspopup="true" aria-expanded="false">
                                <i class="fa-solid fa-ellipsis"></i>
                            </button>
                            <div id="blai-diff-actions-menu" class="blai-diff-actions-menu" hidden>
                                <button id="blai-diff-related-mode-toggle" type="button" class="blai-diff-actions-item" title="点击差异文本后推测相关规则">
                                    <i id="blai-diff-related-mode-icon" class="fa-solid fa-crosshairs"></i>
                                    <span id="blai-diff-related-mode-text">相关规则：关闭</span>
                                </button>
                                <button id="blai-diff-menu-pos-toggle" type="button" class="blai-diff-actions-item" title="将顶部按钮收纳进菜单">
                                    <i id="blai-diff-menu-pos-icon" class="fa-solid fa-ellipsis"></i>
                                    <span id="blai-diff-menu-pos-text">顶部按钮：收纳</span>
                                </button>
                                <button id="blai-diff-menu-bottom-toggle" type="button" class="blai-diff-actions-item" title="隐藏消息尾部按钮">
                                    <i id="blai-diff-menu-bottom-icon" class="fa-solid fa-eye-slash"></i>
                                    <span id="blai-diff-menu-bottom-text">尾部按钮：隐藏</span>
                                </button>
                            </div>
                        </div>
                        <button id="blai-diff-modal-close" type="button" class="blai-diff-modal-close" aria-label="关闭">&times;</button>
                    </div>
                </div>
                <div id="blai-diff-modal-content" class="blai-diff-modal-content"></div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="blai-diff-related-modal" class="blai-modal-shell">
            <div class="blai-modal-card blai-diff-related-card">
                <div class="blai-diff-related-modal-header">
                    <h3 class="blai-edit-modal-title blai-diff-related-title"><i class="fa-solid fa-crosshairs"></i> 可能相关规则</h3>
                    <button id="blai-diff-related-close" type="button" class="blai-icon-btn" title="关闭"><i class="fas fa-times"></i></button>
                </div>
                <div id="blai-diff-related-body" class="blai-diff-related-body"></div>
            </div>
        </div>
    `);

    $('body').append(`
        <div id="blai-subrule-edit-modal" class="blai-modal-shell" style="z-index: 10000005;">
            <div class="blai-modal-card blai-edit-modal-card blai-subrule-modal-card" style="padding: 20px !important;">
                <div class="blai-subrule-modal-header">
                    <div class="blai-subrule-mode-block">
                        <div class="blai-subrule-mode-select-wrap">
                            <select id="blai-modal-sub-mode" class="blai-input blai-subrule-mode-select">
                                <option value="simple">🧩 简易组合</option>
                                <option value="text">📝 普通文本</option>
                                <option value="regex">⚙️ 正则表达式</option>
                            </select>
                            <i class="fas fa-chevron-down blai-subrule-mode-arrow"></i>
                        </div>
                        <div id="blai-modal-sub-mode-hint" class="blai-subrule-mode-hint" aria-live="polite"></div>
                    </div>
                    <button id="blai-modal-sub-cancel" type="button" class="blai-icon-btn blai-subrule-close-btn" title="关闭"><i class="fas fa-times"></i></button>
                </div>
                
                <div class="blai-subrule-modal-body">
                    <div class="blai-subrule-field" style="margin-bottom: 12px;">
                        <label class="blai-field-label" style="margin-bottom: 6px; font-weight: 600;">备注说明 (可选)</label>
                        <input type="text" id="blai-modal-sub-remark" class="blai-input" placeholder="例如：处理特定角色的口头禅" style="background: var(--blai-bg-button) !important; border: none !important; border-radius: 8px !important; font-size: 14px !important; padding: 10px 14px !important;">
                    </div>

                    <div class="blai-subrule-field" style="margin-bottom: 12px;">
                        <label class="blai-field-label" style="margin-bottom: 6px; font-weight: 600;">处理方式</label>
                        <select id="blai-modal-sub-rewrite-mode" class="blai-input">
                            <option value="program">程序替换</option>
                            <option value="ai">AI 改写</option>
                        </select>
                        <div id="blai-modal-sub-rewrite-hint" class="blai-subrule-mode-hint" aria-live="polite"></div>
                    </div>

                    <div id="blai-modal-sub-ai-prompt-field" class="blai-subrule-field" style="margin-bottom: 12px;" hidden>
                        <label class="blai-field-label" style="margin-bottom: 6px; font-weight: 600;">单条改写要求 (可选)</label>
                        <textarea id="blai-modal-sub-ai-prompt" class="blai-textarea" rows="4" placeholder="只写这条规则命中时的特殊处理。可分情况说明：命中 A 组时只弱化不删除；命中 B 组时保留语气词；留空则只使用 AI 设置里的全局提示词。" style="background: var(--blai-bg-button) !important; border: none !important; border-radius: 8px !important; font-size: 14px !important; padding: 10px 14px !important;"></textarea>
                        <div id="blai-modal-sub-ai-prompt-hint" class="blai-subrule-mode-hint" aria-live="polite"></div>
                    </div>
                    
                    <div class="blai-subrule-field" style="margin-bottom: 12px;">
                        <label class="blai-field-label" style="margin-bottom: 6px; font-weight: 600;">查找内容</label>
                        <div id="blai-modal-sub-target-error" class="blai-field-error" aria-live="polite"></div>
                        <textarea id="blai-modal-sub-target" class="blai-textarea" rows="4" style="background: var(--blai-bg-button) !important; border: none !important; border-radius: 8px !important; font-size: 14px !important; padding: 10px 14px !important;"></textarea>
                    </div>
                    
                    <div class="blai-subrule-field" style="margin-bottom: 15px;">
                        <div class="blai-subrule-replacement-head">
                            <label id="blai-modal-sub-rep-label" class="blai-field-label" style="margin-bottom: 0; font-weight: 600;">替换为</label>
                            <div id="blai-modal-sub-regex-actions" class="blai-regex-replacement-actions" hidden>
                                <button id="blai-modal-sub-regex-recognize" type="button" class="blai-subrule-mini-btn">按行识别</button>
                            </div>
                        </div>
                        <textarea id="blai-modal-sub-rep" class="blai-textarea" rows="4" style="background: var(--blai-bg-button) !important; border: none !important; border-radius: 8px !important; font-size: 14px !important; padding: 10px 14px !important;"></textarea>
                        <div id="blai-modal-sub-regex-list" class="blai-regex-replacement-list" hidden></div>
                    </div>
                </div>
                
                <div class="blai-subrule-footer">
                    <button id="blai-modal-sub-save" type="button" class="blai-primary-btn blai-subrule-footer-save">保存条目</button>
                </div>
            </div>
        </div>
    `);

    markRulesUiDirty(true);
    markPresetsUiDirty(true);
    annotateTauriMobileSurfaces();
} 

export function clearRuleSearchEditFlow() {
    runtimeState.searchEditFlow.active = false;
    runtimeState.searchEditFlow.returnMode = '';
    runtimeState.searchEditFlow.ruleIndex = -1;
    runtimeState.searchEditFlow.subRuleIndex = -1;
}

export function resetRuleSearchState() {
    runtimeState.ruleSearchKeyword = '';
    runtimeState.ruleSearchDraftKeyword = '';
    runtimeState.ruleSearchHasSearched = false;
    runtimeState.ruleSearchExpandedMenuKey = '';
    clearRuleSearchEditFlow();
}

export function syncRuleSearchInputUi(options = {}) {
    const { syncValue = false } = options;
    const draftKeyword = String(runtimeState.ruleSearchDraftKeyword || '');
    const $input = $('#blai-rule-search-input');
    const $clear = $('#blai-rule-search-clear');
    if (syncValue && $input.length) $input.val(draftKeyword);
    const hasValue = draftKeyword.length > 0;
    $clear.prop('hidden', !hasValue).toggleClass('is-visible', hasValue);
}

export function renderRuleSearchModal() {
    const $body = $('#blai-rule-search-body');
    if (!$body.length) return;

    const keyword = String(runtimeState.ruleSearchKeyword || '').trim();
    syncRuleSearchInputUi();

    if (!runtimeState.ruleSearchHasSearched || !keyword) {
        $body.html(`
            <div class="blai-rule-search-empty">
                <div class="blai-rule-search-empty-icon"><i class="fas fa-magnifying-glass"></i></div>
                <div class="blai-rule-search-empty-title">请输入关键词</div>
                <div class="blai-rule-search-empty-text">点击“搜索”查找对应规则</div>
            </div>
        `);
        return;
    }

    const results = buildRuleSearchResults(keyword);
    if (results.length === 0) {
        $body.html(`
            <div class="blai-rule-search-empty">
                <div class="blai-rule-search-empty-icon"><i class="fas fa-circle-info"></i></div>
                <div class="blai-rule-search-empty-title">未找到匹配规则</div>
                <div class="blai-rule-search-empty-text">当前只搜索每条映射的查找词与替换词</div>
            </div>
        `);
        return;
    }

    const html = results.map((item) => {
        const menuHtml = runtimeState.ruleSearchExpandedMenuKey === item.key
            ? `
                <div class="blai-rule-search-menu">
                    <button type="button" class="blai-rule-search-menu-item" data-action="group" data-rule-index="${item.ruleIndex}" data-subrule-index="${item.subRuleIndex}">
                        分组详情
                    </button>
                    <button type="button" class="blai-rule-search-menu-item" data-action="subrule" data-rule-index="${item.ruleIndex}" data-subrule-index="${item.subRuleIndex}">
                        编辑条目
                    </button>
                </div>
            `
            : '';

        return `
            <div class="blai-rule-search-result-card ${item.isEnabled ? '' : 'blai-is-disabled'}" data-rule-index="${item.ruleIndex}" data-subrule-index="${item.subRuleIndex}">
                <div class="blai-rule-search-result-head">
                    <div class="blai-rule-search-result-group">
                        <i class="fas fa-folder-open"></i>
                        所属分组：${item.groupName}
                    </div>
                    <div class="blai-rule-search-menu-wrap">
                        <button type="button" class="blai-icon-btn blai-rule-search-menu-toggle" data-key="${item.key}" title="更多操作">
                            <i class="fas fa-ellipsis"></i>
                        </button>
                        ${menuHtml}
                    </div>
                </div>
                <div class="blai-rule-search-result-preview">
                    <span class="blai-tag">${item.tagText}</span>
                    <span class="blai-source">${item.sourcePreview}</span>
                    <i class="fas fa-arrow-right blai-arrow"></i>
                    <span class="blai-target">${item.replacementPreview}</span>
                </div>
            </div>
        `;
    }).join('');

    $body.html(`<div class="blai-rule-search-results">${html}</div>`);
}

export function openRuleSearchModal() {
    syncRuleSearchInputUi({ syncValue: true });
    renderRuleSearchModal();
    $('#blai-rule-search-modal').css('display', 'flex').hide().fadeIn(150);
    window.setTimeout(() => {
        $('#blai-rule-search-input').trigger('focus');
    }, 20);
}

export function closeRuleSearchModal(options = {}) {
    const { reset = false } = options;
    if (reset) {
        resetRuleSearchState();
        syncRuleSearchInputUi({ syncValue: true });
        renderRuleSearchModal();
    }
    $('#blai-rule-search-modal').fadeOut(150);
}

function getScopeTagGroupsForSettings(settings = {}) {
    return normalizeScopeTagGroupList(settings?.scopeTagGroups);
}

function getScopeTagCollapsedGroupSet(settings = {}, groups = []) {
    return new Set(normalizeScopeTagCollapsedGroupList(settings?.scopeTagCollapsedGroups, groups));
}

function getScopeTagDisplayGroupId(scopeTag, groupIds) {
    const groupId = String(scopeTag?.groupId || DEFAULT_SCOPE_TAG_GROUP_ID).trim() || DEFAULT_SCOPE_TAG_GROUP_ID;
    return groupIds.has(groupId) ? groupId : DEFAULT_SCOPE_TAG_GROUP_ID;
}

function buildScopeTagChipHtml(scopeTag, editId) {
    const isEnabled = scopeTag.enabled !== false;
    const checkedAttr = isEnabled ? 'checked' : '';
    const activeClass = scopeTag.id === editId ? 'is-active' : '';
    const disabledClass = isEnabled ? '' : 'blai-is-disabled';
    const labelText = String(scopeTag.label || '').trim();
    const rangeText = isCotScopeTagEntry(scopeTag)
        ? COT_SCOPE_TAG_DISPLAY_TEXT
        : `${scopeTag.startTag} ... ${scopeTag.endTag}`;
    const primaryText = labelText || '标签范围';
    const chipTitle = `${primaryText} · ${rangeText}`;
    return `
        <div class="blai-scope-tag-chip ${activeClass} ${disabledClass}" data-id="${safeHtml(scopeTag.id)}">
            <label class="blai-checkbox-label blai-scope-tag-toggle-wrap" title="启用或停用该标签">
                <input type="checkbox" class="blai-scope-tag-toggle" data-id="${safeHtml(scopeTag.id)}" ${checkedAttr}>
                <span class="blai-custom-checkbox blai-square"></span>
            </label>
            <button type="button" class="blai-scope-tag-chip-main" data-id="${safeHtml(scopeTag.id)}" title="${safeHtml(chipTitle)}">
                <span class="blai-scope-tag-chip-title">${safeHtml(primaryText)}</span>
                <span class="blai-scope-tag-chip-text">${safeHtml(rangeText)}</span>
            </button>
            <span class="blai-scope-tag-row-divider" aria-hidden="true"></span>
            <div class="blai-scope-tag-actions">
                <button type="button" class="blai-icon-btn blai-scope-tag-move" title="保持当前顺序" aria-label="保持当前顺序" disabled><i class="fas fa-arrow-up"></i></button>
                <button type="button" class="blai-icon-btn blai-scope-tag-move" title="保持当前顺序" aria-label="保持当前顺序" disabled><i class="fas fa-arrow-down"></i></button>
                <button type="button" class="blai-icon-btn blai-scope-tag-edit" data-id="${safeHtml(scopeTag.id)}" title="编辑标签" aria-label="编辑标签"><i class="fas fa-pen"></i></button>
                <button type="button" class="blai-icon-btn blai-scope-tag-del blai-danger-btn" data-id="${safeHtml(scopeTag.id)}" title="删除标签" aria-label="删除标签"><i class="fas fa-trash"></i></button>
            </div>
        </div>
    `;
}

export function renderScopeTagsModal() {
    const $list = $('#blai-scope-tags-list');
    if (!$list.length) return;

    const { extension_settings } = getAppContext();
    const settings = extension_settings?.[extensionName] || {};
    const groups = getScopeTagGroupsForSettings(settings);
    const groupIds = new Set(groups.map((group) => group.id));
    const collapsedGroups = getScopeTagCollapsedGroupSet(settings, groups);
    const scopeTags = mergeScopeTagsWithBuiltins(
        settings.scopeTags,
        settings.scopeTagBuiltinDismissed
    );
    const editId = String($('#blai-scope-tag-input').data('scope-edit-id') || '');
    const isEditing = editId !== '';
    const scopeTagMode = settings.scopeTagMode === 'cleanse-inside' ? 'cleanse-inside' : 'protect';
    const isCleanseInsideMode = scopeTagMode === 'cleanse-inside';
    const displayScopeTags = [];
    let cotDisplayTag = null;

    scopeTags.forEach((scopeTag) => {
        if (!isCotScopeTagEntry(scopeTag)) {
            displayScopeTags.push(scopeTag);
            return;
        }
        if (!cotDisplayTag) {
            cotDisplayTag = {
                ...scopeTag,
                label: scopeTag.label || 'COT思维链',
                enabled: false,
                groupId: getScopeTagDisplayGroupId(scopeTag, groupIds),
            };
            displayScopeTags.push(cotDisplayTag);
        }
        if (scopeTag.enabled !== false) cotDisplayTag.enabled = true;
        if (scopeTag.id === editId) cotDisplayTag.id = scopeTag.id;
    });

    $('#blai-scope-tag-editor-title').text(isEditing ? '编辑标签' : '新增标签');
    $('#blai-scope-tag-save').text('确认');
    $('#blai-scope-tag-reset').text('取消');
    $('#blai-scope-mode-protect')
        .toggleClass('is-active', !isCleanseInsideMode)
        .attr('aria-pressed', String(!isCleanseInsideMode));
    $('#blai-scope-mode-cleanse')
        .toggleClass('is-active', isCleanseInsideMode)
        .attr('aria-pressed', String(isCleanseInsideMode));
    $('#blai-scope-tags-hint').text(isCleanseInsideMode
        ? '当前模式下，只会删除或替换列表内标签的内容，标签外内容会被保留。'
        : '当前模式下，会保护列表内标签的内容，标签外内容将被删除或替换。');

    const grouped = groups.map((group) => ({ ...group, tags: [] }));
    const groupedMap = new Map(grouped.map((group) => [group.id, group]));
    displayScopeTags.forEach((scopeTag) => {
        const groupId = getScopeTagDisplayGroupId(scopeTag, groupIds);
        const targetGroup = groupedMap.get(groupId) || groupedMap.get(DEFAULT_SCOPE_TAG_GROUP_ID) || grouped[0];
        if (targetGroup) targetGroup.tags.push(scopeTag);
    });

    const html = grouped.map((group) => {
        const isCollapsed = collapsedGroups.has(group.id);
        const groupTitle = safeHtml(group.name || DEFAULT_SCOPE_TAG_GROUP_NAME);
        const activeCount = group.tags.filter((scopeTag) => scopeTag.enabled !== false).length;
        const hasTags = group.tags.length > 0;
        const isGroupEnabled = activeCount > 0;
        const isGroupPartial = activeCount > 0 && activeCount < group.tags.length;
        const groupToggleClass = [
            'blai-scope-tag-group-toggle',
            isGroupEnabled ? 'is-on' : '',
            isGroupPartial ? 'is-partial' : '',
        ].filter(Boolean).join(' ');
        const groupToggleTitle = hasTags
            ? (isGroupEnabled ? '关闭该分组内全部标签' : '启用该分组内全部标签')
            : '此分组暂无标签';
        const groupToggleDisabled = hasTags ? '' : 'disabled';
        const tagsHtml = group.tags.length > 0
            ? group.tags.map((scopeTag) => buildScopeTagChipHtml(scopeTag, editId)).join('')
            : `<div class="blai-scope-tag-group-empty">${isCleanseInsideMode ? '此分组暂无标签。' : '此分组暂无标签。'}</div>`;
        return `
            <div class="blai-scope-tag-group ${isCollapsed ? 'is-collapsed' : ''}" data-group-id="${safeHtml(group.id)}">
                <div class="blai-scope-tag-group-head">
                    <button type="button" class="blai-scope-tag-group-collapse" data-group-id="${safeHtml(group.id)}" aria-expanded="${String(!isCollapsed)}">
                        <svg class="blai-scope-tag-group-caret" viewBox="0 0 24 24" aria-hidden="true">
                            <polyline points="6 9 12 15 18 9"></polyline>
                        </svg>
                        <span class="blai-scope-tag-group-title">${groupTitle}</span>
                    </button>
                    <span class="blai-scope-tag-group-count">${group.tags.length}</span>
                    <button type="button" class="${groupToggleClass}" data-group-id="${safeHtml(group.id)}" aria-pressed="${String(isGroupEnabled)}" title="${safeHtml(groupToggleTitle)}" ${groupToggleDisabled}>
                        <span class="blai-scope-tag-group-toggle-track" aria-hidden="true">
                            <span class="blai-scope-tag-group-toggle-knob"></span>
                        </span>
                    </button>
                </div>
                <div class="blai-scope-tag-group-body">
                    <div class="blai-scope-tag-group-inner">
                        ${tagsHtml}
                    </div>
                </div>
            </div>
        `;
    }).join('');

    $list.html(html || `<div class="blai-empty-state">${isCleanseInsideMode ? '当前没有标签，新增并启用后才会净化标签内内容。' : '当前没有标签，新增后即可保护对应标签内容。'}</div>`);
}

export function openScopeTagsModal() {
    renderScopeTagsModal();
    showResponsivePage('clean');
}

export function closeScopeTagsModal(options = {}) {
    const { reset = false } = options;
    if (reset) {
        $('#blai-scope-tag-input').val('').data('scope-edit-id', '');
        $('#blai-scope-tag-label-input').val('');
        $('#blai-scope-tag-error').removeClass('is-visible').text('');
        $('#blai-scope-tag-input').removeClass('blai-invalid').removeAttr('aria-invalid');
        $('#blai-scope-tag-editor-modal').prop('hidden', true);
        $('#blai-scope-group-manager-modal').prop('hidden', true);
        $('#blai-scope-tag-action-menu').prop('hidden', true);
        $('#blai-scope-tag-menu-open').attr('aria-expanded', 'false');
        renderScopeTagsModal();
    }
    showResponsivePage('overview');
}

export function focusLatestRuleCard() {
    const container = document.getElementById('blai-tags-container');
    if (!container) return;

    const cards = container.querySelectorAll('.blai-card');
    const latestCard = cards[cards.length - 1];
    if (!latestCard) return;

    const containerRect = container.getBoundingClientRect();
    const cardRect = latestCard.getBoundingClientRect();
    const isVisible = cardRect.top >= containerRect.top && cardRect.bottom <= containerRect.bottom;

    if (!isVisible) {
        latestCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    latestCard.classList.remove('blai-highlight-flash');
    void latestCard.offsetWidth;
    latestCard.classList.add('blai-highlight-flash');

    window.setTimeout(() => {
        latestCard.classList.remove('blai-highlight-flash');
    }, 1600);
}

function showProgressOverlay({ title, statusText, cancelText = '停止', onCancel = null }) {
    const themeMode = String($('#blai-purifier-popup').attr('data-blai-theme') || 'auto');
    $('#blai-loading-overlay').remove();
    $('body').append(`
        <div id="blai-loading-overlay" class="blai-loading-overlay" data-blai-theme="${themeMode}" data-tt-mobile-surface="backdrop">
            <div class="blai-loading-panel" data-tt-mobile-surface="fullscreen-window" role="dialog" aria-modal="true" aria-labelledby="blai-loading-title">
                <div class="blai-loading-head">
                    <h2 id="blai-loading-title" class="blai-loading-title"><i class="fas fa-spinner fa-spin"></i> ${title}</h2>
                    <button id="blai-loading-cancel" type="button" class="blai-loading-cancel" title="${cancelText}">${cancelText}</button>
                </div>
                <p id="blai-loading-status">${statusText}</p>
                <div class="blai-progress-track"><div id="blai-progress-fill" class="blai-progress-fill"></div></div>
                <p id="blai-progress-percent" class="blai-progress-percent">0%</p>
            </div>
        </div>
    `);
    annotateTauriMobileSurfaces();
    if (typeof onCancel === 'function') {
        $('#blai-loading-cancel').off('click').on('click', onCancel);
    }
}

export function showDeepCleanOverlay() {
    runtimeState.deepCleanCancelRequested = false;
    showProgressOverlay({
        title: '正在执行全方位深度清理',
        statusText: '正在初始化清理任务，请稍候。',
        cancelText: '停止',
        onCancel: () => {
            runtimeState.deepCleanCancelRequested = true;
            $('#blai-loading-cancel')
                .prop('disabled', true)
                .addClass('is-disabled')
                .text('停止中');
            $('#blai-loading-status').text('正在停止深度清理，请等待当前批次收尾。');
        },
    });
}

export function showZhDictionaryInstallOverlay(onCancel) {
    runtimeState.zhDictionaryInstallCancelRequested = false;
    showProgressOverlay({
        title: '正在安装增强简繁词典',
        statusText: '正在初始化下载任务。',
        cancelText: '取消',
        onCancel: () => {
            runtimeState.zhDictionaryInstallCancelRequested = true;
            $('#blai-loading-cancel')
                .prop('disabled', true)
                .addClass('is-disabled')
                .text('取消中');
            $('#blai-loading-status').text('正在取消下载，请等待当前请求结束。');
            if (typeof onCancel === 'function') onCancel();
        },
    });
}

export function closeLoadingOverlay() {
    $('#blai-loading-overlay').remove();
}

export function updateZhDictionaryInstallOverlay(progressRatio, statusText) {
    updateDeepCleanOverlay(progressRatio, statusText);
}

export function openZhDictionaryModal(stats = {}, options = {}) {
    const themeMode = String($('#blai-purifier-popup').attr('data-blai-theme') || 'auto');
    const bytes = Number(stats.bytes) || 0;
    const mb = bytes > 0 ? (bytes / 1024 / 1024).toFixed(2) : '1.20';
    const entries = Number(stats.entries) || 0;
    $('#blai-zh-dictionary-modal')
        .attr('data-blai-theme', themeMode)
        .css('display', 'flex');
    $('#blai-zh-dict-stats').text(`词典包约 ${mb} MB，包含 ${entries.toLocaleString('zh-CN')} 条字词与异体映射。`);
    $('#blai-zh-dict-tw').prop('checked', options.tw !== false);
    $('#blai-zh-dict-hk').prop('checked', options.hk !== false);
}

export function closeZhDictionaryModal() {
    $('#blai-zh-dictionary-modal').fadeOut(120);
}

export function updateDeepCleanOverlay(progressRatio, statusText) {
    const ratio = Math.max(0, Math.min(1, Number(progressRatio) || 0));
    $('#blai-progress-fill').css('width', `${Math.round(ratio * 100)}%`);
    $('#blai-progress-percent').text(`${Math.round(ratio * 100)}%`);
    if (statusText) $('#blai-loading-status').text(statusText);
}

export function showConfirmModal(onConfirm = () => performDeepCleanse()) {
    const $modal = $('#blai-confirm-modal');
    const $confirmBtn = $('#blai-modal-confirm');
    const $cancelBtn = $('#blai-modal-cancel');

    $modal.css('display', 'flex');
    $confirmBtn.prop('disabled', true).addClass('blai-is-disabled');

    let timeLeft = 3;
    $confirmBtn.text(`确认清理 (${timeLeft}s)`);

    const timer = setInterval(() => {
        timeLeft--;
        if (timeLeft > 0) {
            $confirmBtn.text(`确认清理 (${timeLeft}s)`);
        } else {
            clearInterval(timer);
            $confirmBtn.prop('disabled', false)
                .removeClass('blai-is-disabled')
                .text('我已切换，确认清理！');
        }
    }, 1000);

    $cancelBtn.off('click').on('click', () => {
        clearInterval(timer);
        $modal.hide();
    });

    $confirmBtn.off('click').on('click', () => {
        if (!timeLeft) {
            clearInterval(timer);
            $modal.hide();
            onConfirm();
        }
    });
}

function getAiTimeoutSeconds(timeoutMs) {
    const parsed = Number(timeoutMs);
    const fallback = Number(defaultAiRewriteSettings.timeoutMs) || 120000;
    const normalizedMs = Number.isFinite(parsed) ? parsed : fallback;
    return Math.min(Math.max(Math.round(normalizedMs / 1000), 1), 120);
}

function syncPresetAiRewriteGenerationSettingsUI(settings) {
    const aiSettings = {
        ...defaultAiRewriteSettings,
        ...(settings?.aiRewrite && typeof settings.aiRewrite === 'object' ? settings.aiRewrite : {}),
    };
    const setValueIfNotFocused = (selector, value) => {
        const $field = $(selector);
        if (!$field.is(':focus')) $field.val(value);
    };
    setValueIfNotFocused('#blai-ai-temperature', aiSettings.temperature);
    setValueIfNotFocused('#blai-ai-timeout', getAiTimeoutSeconds(aiSettings.timeoutMs));
    setValueIfNotFocused('#blai-ai-max-retries', aiSettings.maxRetries);
    setValueIfNotFocused('#blai-ai-max-items', aiSettings.maxItemsPerRequest);
    setValueIfNotFocused('#blai-ai-max-context', aiSettings.maxContextChars);
    setValueIfNotFocused('#blai-ai-max-rewrite', aiSettings.maxRewriteCharsPerItem);
    setValueIfNotFocused('#blai-ai-prompt', aiSettings.promptTemplate || defaultAiRewriteSettings.promptTemplate);
    setValueIfNotFocused('#blai-ai-prompt-expanded', aiSettings.promptTemplate || defaultAiRewriteSettings.promptTemplate);
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
    settings.activePreset = presetExists ? presetName : "";
    settings.rules = presetExists ? deepClone(getPresetRules(presetEntry)) : [];
    if (presetExists) applyPresetAiRewriteSettings(settings, presetEntry);
    markRulesDataDirty();
    saveSettingsDebounced();
    logger.info(`切换预设: ${presetName || '(临时规则)'}, 存在=${presetExists}`);
    if (!options.skipRender) {
        updateToolbarUI();
        renderTags();
    }
    if (!options.skipCleanse) performGlobalCleanse();
}

export function cleanupInvalidPresetBindings() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const presets = settings.presets || {};
    if (settings.defaultPreset && !presets[settings.defaultPreset]) settings.defaultPreset = "";
    if (!settings.characterBindings || typeof settings.characterBindings !== 'object') {
        settings.characterBindings = {};
    }
    if (!settings.chatCompletionPresetBindings || typeof settings.chatCompletionPresetBindings !== 'object') settings.chatCompletionPresetBindings = {};

    Object.keys(settings.characterBindings).forEach((key) => {
        const preset = settings.characterBindings[key];
        if (!preset || !presets[preset]) delete settings.characterBindings[key];
    });
    Object.keys(settings.chatCompletionPresetBindings).forEach((name) => {
        const preset = settings.chatCompletionPresetBindings[name];
        if (!preset || !presets[preset]) delete settings.chatCompletionPresetBindings[name];
    });
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
    const currentBound = context.key ? (settings.characterBindings?.[context.key] || '') : '';
    const currentChatBound = chatCompletionPresetName ? (settings.chatCompletionPresetBindings?.[chatCompletionPresetName] || '') : '';
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
            const disabled = $target.prop('disabled') === true;
            const active = $target.hasClass('is-active')
                || $target.hasClass('blai-bind-active')
                || $target.attr('aria-pressed') === 'true';
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
        syncProxyFieldState('#blai-unbind-current-character', $unbindItem);
    }
}

export function applyCharacterPresetBinding(force = false, options = {}) {
    const { extension_settings } = getAppContext();
    const context = getCurrentCharacterContext();
    const chatCompletionPresetName = getCurrentChatCompletionPresetName();
    const bindingSignature = `${context.key || ''}\n${chatCompletionPresetName || ''}`;
    const bindingContextChanged = bindingSignature !== runtimeState.lastPresetBindingSignature;
    if (!force && !bindingContextChanged) return;
    runtimeState.lastCharacterContextKey = context.key;
    runtimeState.lastPresetBindingSignature = bindingSignature;

    const presetName = getPresetForCharacter(context.key, { chatCompletionPresetName });
    if (presetName && presetName !== extension_settings[extensionName].activePreset) {
        applyPresetByName(presetName, { skipRender: true, skipCleanse: options.skipCleanse === true });
    }
    refreshCharacterBindingUI();
}

export function syncRealtimeMaskModeUI() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings?.[extensionName] || {};
    const mode = settings.realtimeMaskMode === 'simple-visual' ? 'simple-visual' : 'tavern-helper';
    const label = mode === 'simple-visual' ? '简单视觉' : '实时渲染';
    const note = mode === 'simple-visual'
        ? '生成中只扫当前输出消息 DOM，尽量保留酒馆美化。'
        : '生成中在进入实时渲染前替换文本，可能覆盖酒馆美化。';

    $('#blai-realtime-mask-label').text(label);
    $('#blai-realtime-mask-note').text(note);
    $('#blai-responsive-model-pill').text(mode === 'simple-visual' ? '简单视觉' : '实时渲染');
    $('#blai-realtime-mask-label, #blai-responsive-model-pill').attr('title', note);
    $('.blai-realtime-mask-option').each(function() {
        const active = String($(this).attr('data-mode') || '') === mode;
        $(this)
            .toggleClass('active', active)
            .toggleClass('is-active', active)
            .attr('aria-pressed', String(active));
    });
}

export function updateToolbarUI() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    cleanupInvalidPresetBindings();
    const select = $('#blai-preset-select');
    if (!select.length) return;

    if (runtimeState.presetsUiDirty || select.children().length === 0) {
        const presetNames = settings.presets ? Object.keys(settings.presets) : [];
        const optionsHtml = ['<option value="">-- 临时规则 (未绑定存档) --</option>']
            .concat(presetNames.map((name) => `<option value="${safeHtml(name)}">${safeHtml(name)}</option>`))
            .join('');
        select.html(optionsHtml);
        markPresetsUiDirty(false);
    }
    select.val(settings.activePreset || "");
    const rules = Array.isArray(settings.rules) ? settings.rules : [];
    const activePresetLabel = settings.activePreset || '临时规则';
    const aiRuleCount = rules.reduce((count, rule) => count + (Array.isArray(rule?.subRules)
        ? rule.subRules.filter((sub) => sub?.rewriteMode === 'ai').length
        : 0), 0);
    $('#blai-responsive-preset-title, #blai-responsive-mobile-preset-title, #blai-bind-active-preset').text(activePresetLabel);
    $('#blai-rule-group-count').text(String(rules.length));
    $('#blai-ai-rule-count').text(String(aiRuleCount));
    syncRealtimeMaskModeUI();
    refreshCharacterBindingUI();
}

export function addRegexReplacementInput(value = '') {
    return appendRegexReplacementInputs([value]).eq(0);
}

export function removeRegexReplacementInput(index) {
    const normalizedIndex = Number(index);
    const $items = $('#blai-modal-sub-regex-list').children('.blai-regex-replacement-chip');
    if (!Number.isInteger(normalizedIndex) || normalizedIndex < 0 || normalizedIndex >= $items.length) return;
    const currentEditIndex = getRegexReplacementEditIndex();
    $items.eq(normalizedIndex).remove();
    if (currentEditIndex === normalizedIndex) {
        $('#blai-modal-sub-rep').data('regex-edit-index', -1);
    } else if (currentEditIndex > normalizedIndex) {
        $('#blai-modal-sub-rep').data('regex-edit-index', currentEditIndex - 1);
    }
    syncRegexReplacementInputState();
}

export function startEditingRegexReplacementInput(index) {
    const normalizedIndex = Number(index);
    const values = getRegexReplacementChipValues();
    if (!Number.isInteger(normalizedIndex) || normalizedIndex < 0 || normalizedIndex >= values.length) return false;
    $('#blai-modal-sub-rep').val(values[normalizedIndex]).data('regex-edit-index', normalizedIndex);
    syncRegexReplacementInputState();
    return true;
}

export function recognizeRegexReplacementInput() {
    const $textarea = $('#blai-modal-sub-rep');
    const draft = String($textarea.val() ?? '');
    if (draft.trim() === '') return { ok: false, reason: 'empty' };

    const editIndex = getRegexReplacementEditIndex();
    const $items = $('#blai-modal-sub-regex-list').children('.blai-regex-replacement-chip');
    if (editIndex >= 0 && editIndex < $items.length) {
        const $item = $items.eq(editIndex);
        $item.data('value', draft);
        $item.find('.blai-regex-replacement-chip-main')
            .html(formatReplacementCandidatePreview(draft))
            .attr('title', draft || '点击编辑替换项');
        $textarea.val('').data('regex-edit-index', -1);
        syncRegexReplacementInputState();
        return { ok: true, mode: 'update' };
    }

    const lines = draft.replace(/\r/g, '').split('\n').map((line) => (line.trim() === '' ? '' : line));
    if (lines.length === 0) return { ok: false, reason: 'empty' };
    appendRegexReplacementInputs(lines, { sync: false });
    $textarea.val('').data('regex-edit-index', -1);
    syncRegexReplacementInputState();
    return { ok: true, mode: 'append', count: lines.length };
}

export function hasPendingRegexReplacementInput() {
    const draft = String($('#blai-modal-sub-rep').val() ?? '');
    if (draft.trim() === '') return false;
    const editIndex = getRegexReplacementEditIndex();
    const values = getRegexReplacementChipValues();
    return editIndex < 0 || editIndex >= values.length || draft !== values[editIndex];
}

export function setSingleRuleReplacementEditor(mode, replacements = []) {
    const normalized = normalizeReplacementList(replacements);
    const isRegexMode = mode === 'regex';
    const $textarea = $('#blai-modal-sub-rep');
    const $actions = $('#blai-modal-sub-regex-actions');
    const $list = $('#blai-modal-sub-regex-list');
    $textarea.data('regex-edit-index', -1);

    if (isRegexMode) {
        $textarea.val('');
        $list.empty();
        appendRegexReplacementInputs(normalized, { sync: false });
        $actions.prop('hidden', false);
        syncRegexReplacementInputState();
        return;
    }

    $list.empty().prop('hidden', true);
    $actions.prop('hidden', true);
    $textarea
        .val(normalized.join(mode === 'text' ? ', ' : '\n'))
        .removeData('regex-default-placeholder')
        .removeData('regex-edit-placeholder');
}

export function getSingleRuleReplacementValues(mode) {
    if (mode === 'regex') {
        return getRegexReplacementChipValues();
    }

    const rawValue = String($('#blai-modal-sub-rep').val() ?? '');
    return parseInputToWords(rawValue, mode === 'text' ? 'text' : 'regex', { isTarget: false });
}

export function renderTags() {
    const container = $('#blai-tags-container');
    if (!container.length) return;
    if (!runtimeState.rulesUiDirty && container.children().length > 0) return;

    const { extension_settings } = getAppContext();
    const rules = extension_settings[extensionName]?.rules || [];
    const html = rules.map((r, i) => {
        const name = safeHtml(r.name) || `未命名合集 ${i + 1}`;
        const subRules = r.subRules || [];
        const maxPreview = 3;

        const subRulesHtml = subRules.slice(0, maxPreview).map((sub) => {
            const mode = sub.mode || 'text';
            const tagText = getRulePreviewTagText(mode);
            const tPreview = getRuleSourcePreviewText(sub);
            const rPreview = formatReplacementPreview(sub.replacements || [], mode);
            const subEnabled = sub.enabled !== false;
            const rewriteBadge = getRewriteModeBadgeHtml(sub);
            return `
                <div class="blai-rule-item ${subEnabled ? '' : 'blai-is-disabled'}">
                    <span class="blai-tag">${tagText}</span>
                    ${rewriteBadge}
                    <span class="blai-source">${tPreview}</span>
                    <i class="fas fa-arrow-right blai-arrow"></i>
                    <span class="blai-target">${rPreview}</span>
                </div>`;
        }).join('');

        const moreHtml = subRules.length > maxPreview
            ? `<div class="blai-more-text">... 以及其他 ${subRules.length - maxPreview} 组映射</div>`
            : '';
        const bodyHtml = subRules.length > 0
            ? `<div class="blai-card-body">${subRulesHtml}${moreHtml}</div>`
            : '';

        const isEnabled = r.enabled !== false;
        const checkedAttr = isEnabled ? 'checked' : '';
        const moveUpDisabled = i === 0 ? 'disabled' : '';
        const moveDownDisabled = i === rules.length - 1 ? 'disabled' : '';
        const headerClass = subRules.length > 0 ? 'blai-card-header blai-has-border' : 'blai-card-header';

        return `
            <div class="blai-card ${!isEnabled ? 'blai-is-disabled' : ''}" data-index="${i}">
                <div class="${headerClass}">
                    <div class="blai-header-left">
                        <label class="blai-batch-checkbox-label">
                            <input type="checkbox" class="batch-item-checkbox" data-index="${i}">
                            <span class="blai-custom-checkbox blai-square-2px"></span>
                        </label>
                        <label class="blai-checkbox-label">
                            <input type="checkbox" class="blai-rule-toggle" data-index="${i}" ${checkedAttr}>
                            <span class="blai-custom-checkbox"></span>
                            <span class="blai-group-title">${name}</span>
                            <span class="blai-rule-count">${subRules.length} 条</span>
                        </label>
                    </div>
                    <div class="blai-icon-group blai-compact">
                        <button class="blai-rule-move-up" data-index="${i}" title="上移合集" ${moveUpDisabled}><i class="fas fa-arrow-up"></i></button>
                        <button class="blai-rule-move-down" data-index="${i}" title="下移合集" ${moveDownDisabled}><i class="fas fa-arrow-down"></i></button>
                        <button class="blai-rule-transfer" data-index="${i}" title="复制/转移到其他存档"><i class="fas fa-copy"></i></button>
                        <button class="blai-rule-edit" data-index="${i}" title="打开合集"><i class="fas fa-pen"></i><span>打开</span></button>
                        <button class="blai-rule-del" data-index="${i}" title="删除合集"><i class="fas fa-trash"></i></button>
                    </div>
                </div>
                ${bodyHtml}
            </div>`;
    }).join('');

    container.html(html || '<div class="blai-empty-state">当前无规则，请点击上方按钮新增</div>');
    const aiRuleCount = rules.reduce((count, rule) => count + (Array.isArray(rule?.subRules)
        ? rule.subRules.filter((sub) => sub?.rewriteMode === 'ai').length
        : 0), 0);
    $('#blai-rule-group-count').text(String(rules.length));
    $('#blai-ai-rule-count').text(String(aiRuleCount));
    markRulesUiDirty(false);
}

export function renderSubrulesToModal() {
    const container = $('#blai-edit-subrules-container');
    if (!container.length) return;
    if (runtimeState.currentEditingSubrules.length === 0) {
        container.html('<div style="text-align:center; color:var(--blai-text-secondary); font-size:12px; padding:20px;">当前合集没有映射规则，请点击下方按钮添加。</div>');
        return;
    }

    const html = runtimeState.currentEditingSubrules.map((sub, i) => {
        const mode = sub.mode || 'text';
        const remark = sub.remark ? sub.remark.trim() : '';
        const subEnabled = sub.enabled !== false;
        const checkedAttr = subEnabled ? 'checked' : '';
        const moveUpDisabled = i === 0 ? 'disabled' : '';
        const moveDownDisabled = i === runtimeState.currentEditingSubrules.length - 1 ? 'disabled' : '';

        const badgeBaseStyle = "display:inline-flex; align-items:center; justify-content:center; padding:4px 10px; border-radius:6px; font-size:13px; font-weight:800; color:#fff; min-width:45px; margin:0; line-height:1; flex-shrink:0;";
        let badgeHTML = '';
        if (mode === 'regex') badgeHTML = `<span style="${badgeBaseStyle} background:var(--blai-accent-color);">正则</span>`;
        else if (mode === 'simple') badgeHTML = `<span style="${badgeBaseStyle} background:color-mix(in srgb, var(--blai-accent-color) 72%, #3b82f6 28%);">简易</span>`;
        else badgeHTML = `<span style="${badgeBaseStyle} background:var(--blai-text-secondary); color:var(--blai-background-popup);">普通</span>`;

        const tPreview = getRuleSourcePreviewText(sub);
        const rPreview = formatReplacementPreview(sub.replacements || [], mode);
        const rewriteBadge = getRewriteModeBadgeHtml(sub);

        let remarkHTML = '';
        if (remark) {
            remarkHTML = `
                <div style="margin-top: 8px; padding-top: 10px; border-top: 1px dotted color-mix(in srgb, var(--blai-text-primary) 35%, rgba(128,128,128,0.5)); font-size: 11px; color: var(--blai-text-mute); font-style: italic;">
                    <i class="fas fa-info-circle" style="margin-right: 4px;"></i>${safeHtml(remark)}
                </div>
            `;
        }

        return `
            <div class="blai-subrule-card ${subEnabled ? '' : 'blai-is-disabled'}" style="flex-shrink: 0 !important; background: var(--blai-background-secondary); border: 1px solid var(--blai-border-color); border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; display: flex; flex-direction: column; box-shadow: 0 4px 10px rgba(0,0,0,0.04);">
                <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 10px; margin-bottom: 10px; border-bottom: 1px dotted color-mix(in srgb, var(--blai-text-primary) 35%, rgba(128,128,128,0.5));">
                    <div style="display: flex; align-items: center; gap: 8px; margin: 0; padding: 0; min-width: 0;">
                        <label class="blai-checkbox-label blai-subrule-enable-label" title="${subEnabled ? '停用此条规则' : '启用此条规则'}">
                            <input type="checkbox" class="blai-subrule-toggle" data-index="${i}" ${checkedAttr}>
                            <span class="blai-custom-checkbox"></span>
                        </label>
                        ${badgeHTML}
                        ${rewriteBadge}
                    </div>
                    <div class="blai-subrule-btn-group" style="display: flex; justify-content: space-between; align-items: center; flex: 0 0 35%; margin: 0; padding: 0;">
                        <button class="blai-move-subrule-up-btn blai-icon-btn" data-index="${i}" title="上移" ${moveUpDisabled} style="margin:0;"><i class="fas fa-arrow-up"></i></button>
                        <button class="blai-move-subrule-down-btn blai-icon-btn" data-index="${i}" title="下移" ${moveDownDisabled} style="margin:0;"><i class="fas fa-arrow-down"></i></button>
                        <button class="blai-edit-subrule-btn blai-icon-btn" data-index="${i}" title="独立编辑" style="margin:0;"><i class="fas fa-pen"></i></button>
                        <button class="blai-del-subrule-btn blai-icon-btn blai-danger-btn" data-index="${i}" title="删除" style="margin:0;"><i class="fas fa-trash"></i></button>
                        <button class="blai-remark-subrule-btn blai-icon-btn" data-index="${i}" title="快捷修改备注" style="margin:0;"><i class="fas fa-comment-dots"></i></button>
                    </div>
                </div>
                <div style="font-size: 13px !important; color: var(--blai-text-primary); line-height: 1.5; word-break: break-all;">
                    <b style="font-size: 13px !important;">${tPreview}</b> 
                    <i class="fas fa-arrow-right" style="color: var(--blai-text-mute); font-size: 11px; margin: 0 6px;"></i> 
                    <span style="font-size: 13px !important;">${rPreview}</span>
                </div>
                ${remarkHTML}
            </div>
        `;
    }).join('');

    container.html(html);
}

export function openSingleRuleModal(index, options = {}) {
    runtimeState.currentSubruleEditIndex = index;
    let mode = 'simple';
    let tStr = '';
    let replacements = [];
    let remark = '';
    let rewriteMode = 'program';
    let aiPromptTemplate = '';

    if (index >= 0 && runtimeState.currentEditingSubrules[index]) {
        const sub = runtimeState.currentEditingSubrules[index];
        mode = sub.mode || 'simple';
        tStr = (sub.targets || []).join(mode === 'text' ? ', ' : '\n');
        replacements = Array.isArray(sub.replacements) ? sub.replacements : [];
        remark = sub.remark || '';
        rewriteMode = getRewriteMode(sub);
        aiPromptTemplate = String(sub.aiPromptTemplate || '');
    }

    $('#blai-modal-sub-mode').val(mode).data('current-mode', mode);
    $('#blai-modal-sub-rewrite-mode').val(rewriteMode);
    $('#blai-modal-sub-target').val(tStr);
    setSingleRuleReplacementEditor(mode, replacements);
    $('#blai-modal-sub-remark').val(remark);
    $('#blai-modal-sub-ai-prompt').val(aiPromptTemplate);

    $('#blai-modal-sub-mode').trigger('change');
    $('#blai-modal-sub-rewrite-mode').trigger('change');
    if (options.hideEditModal === true) $('#blai-rule-edit-modal').hide();
    $('#blai-subrule-edit-modal').css('display', 'flex').hide().fadeIn(150);
}

export function openTransferModal(ruleIndexOrIndexes) {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const presets = settings?.presets || {};
    const currentPreset = settings?.activePreset || "";
    const targetNames = Object.keys(presets).filter(name => name !== currentPreset);
    if (targetNames.length === 0) {
        alert('没有可用的目标存档。请先创建至少一个其他存档。');
        return;
    }

    const indexes = Array.isArray(ruleIndexOrIndexes) ? ruleIndexOrIndexes : [ruleIndexOrIndexes];
    runtimeState.currentTransferRuleIndexes = indexes
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v >= 0);
    runtimeState.currentTransferRuleIndex = runtimeState.currentTransferRuleIndexes[0] ?? -1;
    const $select = $('#blai-transfer-target');
    $select.html(targetNames.map((name) => `<option value="${safeHtml(name)}">${safeHtml(name)}</option>`).join(''));
    $('#blai-rule-transfer-modal').css('display', 'flex');
}

export function closeTransferModal() {
    runtimeState.currentTransferRuleIndex = -1;
    runtimeState.currentTransferRuleIndexes = [];
    $('#blai-rule-transfer-modal').hide();
}

export function runRuleTransfer(isMove) {
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const settings = extension_settings[extensionName];
    const targetPreset = String($('#blai-transfer-target').val() || '');
    const sourcePreset = String(settings.activePreset || '');
    const transferIndexes = Array.isArray(runtimeState.currentTransferRuleIndexes) && runtimeState.currentTransferRuleIndexes.length > 0
        ? runtimeState.currentTransferRuleIndexes
        : [runtimeState.currentTransferRuleIndex];
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
        runtimeState.batchSelectedRuleIds = [];
        markRulesDataDirty();
    }

    closeTransferModal();
    saveSettingsDebounced();
    if (isMove) renderTags();
}

export function openEditModal(index = -1, options = {}) {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const { source = 'main', returnMode = 'group', subRuleIndex = -1 } = options;
    runtimeState.currentEditingIndex = index;
    if (source === 'search') {
        runtimeState.searchEditFlow.active = true;
        runtimeState.searchEditFlow.returnMode = returnMode;
        runtimeState.searchEditFlow.ruleIndex = index;
        runtimeState.searchEditFlow.subRuleIndex = subRuleIndex;
    } else {
        clearRuleSearchEditFlow();
    }
    const modal = $('#blai-rule-edit-modal');

    if (index === -1) {
        $('#blai-edit-modal-title').html('<i class="fas fa-folder-plus"></i> 新增规则合集');
        $('#blai-edit-name').val('');
        runtimeState.currentEditingSubrules = [{ targets: [], replacements: [], mode: 'simple', enabled: true, isEditing: false }];
    } else {
        const rule = settings.rules[index];
        $('#blai-edit-modal-title').html('<i class="fas fa-pen"></i> 编辑规则合集');
        $('#blai-edit-name').val(rule.name || '');
        runtimeState.currentEditingSubrules = JSON.parse(JSON.stringify(rule.subRules || []));
        runtimeState.currentEditingSubrules.forEach(sub => {
            if (sub.enabled === undefined) sub.enabled = true;
            sub.isEditing = false;
        });
    }

    renderSubrulesToModal();
    modal.css('display', 'flex');
}
