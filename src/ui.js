import { defaultAiRewriteSettings, extensionName, getAppContext, runtimeState, markRulesDataDirty, markRulesUiDirty, markPresetsUiDirty } from './state.js';
import { logger } from './log.js';
import { COT_SCOPE_TAG_DISPLAY_TEXT, DEFAULT_SCOPE_TAG_GROUP_ID, DEFAULT_SCOPE_TAG_GROUP_NAME, buildPresetEntry, deepClone, getCurrentCharacterContext, getCurrentChatCompletionPresetName, getCurrentPresetAiRewriteSettings, getPresetAiRewriteSettings, getPresetBindingResolution, getPresetBindingUsage, getPresetForCharacter, getPresetRules, isCotScopeTagEntry, isRuleActivationWarningEnabled, mergeScopeTagsWithBuiltins, normalizeScopeTagCollapsedGroupList, normalizeScopeTagGroupList, parseInputToWords } from './utils.js';
import { performGlobalCleanse } from './core.js';

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
    applyTauriMobileSurface('.blai-modal-card, .blai-transfer-content, .blai-diff-modal-card, .blai-loading-panel, .blai-scope-tag-editor-card', 'fullscreen-window');
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
    const themeMode = String($('#blai-purifier-popup').attr('data-theme') || 'auto');
    // 替换为 100% 兼容的 fas fa-exclamation-circle 图标
    const $toast = $(`<div class="blai-toast" data-theme="${themeMode}" data-tt-mobile-surface="free-window" role="status" aria-live="polite"><i class="fas fa-exclamation-circle"></i><span class="blai-toast-text"></span></div>`);
    $toast.find('.blai-toast-text').text(String(message || ''));
    $('body').append($toast);
    setTimeout(() => $toast.addClass('blai-show'), 10);
    setTimeout(() => {
        $toast.removeClass('blai-show');
        setTimeout(() => $toast.remove(), 300);
    }, 2000);
}

export async function setupUI(renderTemplate) {
    if (typeof renderTemplate !== 'function') {
        throw new TypeError('setupUI requires a SillyTavern template renderer');
    }
    logger.debug('[setupUI] 开始初始化 UI');
    $('#blai-purifier-popup, #blai-rule-edit-modal, #blai-risk-confirm-modal, #blai-risk-info-modal, #blai-confirm-modal, #blai-rule-transfer-modal, #blai-preset-import-choice-modal, #blai-rule-search-modal, #blai-scope-tags-modal, #blai-scope-tag-editor-modal, #blai-diff-modal, #blai-subrule-edit-modal, #blai-ai-prompt-modal, #blai-loading-overlay, .blai-toast').remove();

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
    const $field = $input.closest('.blai-rule-search-field');
    const $clear = $('#blai-rule-search-clear');
    if (syncValue && $input.length) $input.val(draftKeyword);
    const hasValue = draftKeyword.length > 0;
    $field.toggleClass('has-value', hasValue);
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
    const disabledClass = isEnabled ? '' : 'is-disabled';
    const labelText = String(scopeTag.label || '').trim();
    const rangeText = isCotScopeTagEntry(scopeTag)
        ? COT_SCOPE_TAG_DISPLAY_TEXT
        : `${scopeTag.startTag} ... ${scopeTag.endTag}`;
    const primaryText = labelText || '标签范围';
    const chipTitle = `${primaryText} · ${rangeText}`;
    return `
        <div class="blai-clean-tag-item ${activeClass} ${disabledClass}" data-id="${safeHtml(scopeTag.id)}">
            <label class="blai-clean-tag-switch" title="启用或停用该标签">
                <input type="checkbox" class="blai-clean-tag-toggle-input" data-id="${safeHtml(scopeTag.id)}" ${checkedAttr}>
                <span class="blai-clean-switch-track" aria-hidden="true"><span></span></span>
            </label>
            <button type="button" class="blai-clean-tag-copy" data-id="${safeHtml(scopeTag.id)}" title="${safeHtml(chipTitle)}">
                <span class="blai-clean-tag-title">${safeHtml(primaryText)}</span>
                <code class="blai-clean-tag-code">${safeHtml(rangeText)}</code>
            </button>
            <div class="blai-clean-tag-actions">
                <button type="button" class="blai-clean-tag-action blai-clean-tag-edit" data-id="${safeHtml(scopeTag.id)}" title="编辑标签" aria-label="编辑标签"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16-.8 4.8L8 20l10.5-10.5-4-4L4 16Z"/><path d="m12.8 7.2 4 4"/></svg></button>
                <button type="button" class="blai-clean-tag-action blai-clean-tag-delete" data-id="${safeHtml(scopeTag.id)}" title="删除标签" aria-label="删除标签"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg></button>
            </div>
        </div>
    `;
}

export function renderScopeTagsModal() {
    const $list = $('#blai-scope-tags-list');
    if (!$list.length) return;

    const isGroupManageMode = $list.hasClass('blai-is-group-manage-mode');

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

    $('#blai-scope-tag-total-count').text(String(displayScopeTags.length));
    $('#blai-scope-group-manage-open')
        .toggleClass('is-active', isGroupManageMode)
        .attr('aria-pressed', String(isGroupManageMode))
        .attr('title', isGroupManageMode ? '完成分组管理' : '管理分组')
        .attr('aria-label', isGroupManageMode ? '完成分组管理' : '管理分组')
        .find('.blai-clean-toolbar-button-label')
        .text(isGroupManageMode ? '完成管理' : '分组管理');
    $('#blai-scope-group-add').prop('hidden', !isGroupManageMode);

    $('#blai-scope-tag-editor-title').text(isEditing ? '编辑标签' : '新增标签');
    $('#blai-scope-tag-save').text('确认');
    $('#blai-scope-tag-reset').text('取消');
    $('#blai-scope-mode-protect')
        .toggleClass('is-active', !isCleanseInsideMode)
        .attr('aria-pressed', String(!isCleanseInsideMode))
        .attr('aria-checked', String(!isCleanseInsideMode));
    $('#blai-scope-mode-cleanse')
        .toggleClass('is-active', isCleanseInsideMode)
        .attr('aria-pressed', String(isCleanseInsideMode))
        .attr('aria-checked', String(isCleanseInsideMode));
    $('#blai-scope-tags-hint').text(isCleanseInsideMode
        ? '当前模式下，只会删除或替换列表内标签的内容，标签外内容会被保留。'
        : '当前模式下，列表内标签的内容将被跳过，只对标签外的内容进行净化。');

    const grouped = groups.map((group) => ({ ...group, tags: [] }));
    const groupedMap = new Map(grouped.map((group) => [group.id, group]));
    displayScopeTags.forEach((scopeTag) => {
        const groupId = getScopeTagDisplayGroupId(scopeTag, groupIds);
        const targetGroup = groupedMap.get(groupId) || groupedMap.get(DEFAULT_SCOPE_TAG_GROUP_ID) || grouped[0];
        if (targetGroup) targetGroup.tags.push(scopeTag);
    });

    const html = grouped.map((group, groupIndex) => {
        const isCollapsed = collapsedGroups.has(group.id);
        const groupTitle = safeHtml(group.name || DEFAULT_SCOPE_TAG_GROUP_NAME);
        const isDefaultGroup = group.id === DEFAULT_SCOPE_TAG_GROUP_ID;
        const activeCount = group.tags.filter((scopeTag) => scopeTag.enabled !== false).length;
        const hasTags = group.tags.length > 0;
        const isGroupEnabled = activeCount > 0;
        const isGroupPartial = activeCount > 0 && activeCount < group.tags.length;
        const groupToggleClass = [
            'blai-clean-group-switch',
            isGroupEnabled ? 'is-on' : '',
            isGroupPartial ? 'is-partial' : '',
        ].filter(Boolean).join(' ');
        const groupToggleTitle = hasTags
            ? (isGroupEnabled ? '关闭该分组内全部标签' : '启用该分组内全部标签')
            : '此分组暂无标签';
        const groupToggleDisabled = hasTags ? '' : 'disabled';
        const tagsHtml = group.tags.length > 0
            ? group.tags.map((scopeTag) => buildScopeTagChipHtml(scopeTag, editId)).join('')
            : '<div class="blai-clean-group-empty">此分组暂无标签。</div>';
        const groupHeadHtml = isGroupManageMode
            ? `
                <input type="text" class="blai-clean-group-name-input" data-group-id="${safeHtml(group.id)}" value="${groupTitle}" aria-label="分组名称">
                <span class="blai-clean-group-count">${group.tags.length}</span>
                <div class="blai-clean-group-manager-actions" aria-label="${groupTitle}分组操作">
                    <button type="button" class="blai-clean-tag-action blai-clean-group-move-up" data-group-id="${safeHtml(group.id)}" title="上移分组" aria-label="上移分组" ${groupIndex === 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 14 6-6 6 6"/></svg></button>
                    <button type="button" class="blai-clean-tag-action blai-clean-group-move-down" data-group-id="${safeHtml(group.id)}" title="下移分组" aria-label="下移分组" ${groupIndex === grouped.length - 1 ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 10 6 6 6-6"/></svg></button>
                    <button type="button" class="blai-clean-tag-action blai-clean-group-delete" data-group-id="${safeHtml(group.id)}" title="${isDefaultGroup ? '默认分组不可删除' : '删除分组'}" aria-label="${isDefaultGroup ? '默认分组不可删除' : '删除分组'}" ${isDefaultGroup ? 'disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></svg></button>
                </div>
            `
            : `
                <button type="button" class="blai-clean-group-disclosure" data-group-id="${safeHtml(group.id)}" aria-expanded="${String(!isCollapsed)}">
                    <svg class="blai-clean-group-caret" viewBox="0 0 24 24" aria-hidden="true">
                        <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                    <span class="blai-clean-group-title">${groupTitle}</span>
                    <span class="blai-clean-group-count">${group.tags.length}</span>
                </button>
                <button type="button" class="${groupToggleClass}" data-group-id="${safeHtml(group.id)}" aria-pressed="${String(isGroupEnabled)}" title="${safeHtml(groupToggleTitle)}" ${groupToggleDisabled}>
                    <span class="blai-clean-switch-track" aria-hidden="true"><span></span></span>
                </button>
            `;
        return `
            <section class="blai-clean-tag-group ${isCollapsed ? 'is-collapsed' : ''}" data-group-id="${safeHtml(group.id)}">
                <header class="blai-clean-tag-group-header ${isGroupManageMode ? 'is-managing' : ''}">
                    ${groupHeadHtml}
                </header>
                <div class="blai-clean-tag-group-body">
                    <div class="blai-clean-tag-group-items">
                        ${tagsHtml}
                    </div>
                </div>
            </section>
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
        $('#blai-scope-tag-editor-modal')
            .removeClass('blai-is-open')
            .attr('aria-hidden', 'true');
        $('#blai-scope-tags-list').removeClass('blai-is-group-manage-mode');
        $('#blai-scope-tag-action-menu').prop('hidden', true);
        $('#blai-scope-tag-menu-open').attr('aria-expanded', 'false');
        renderScopeTagsModal();
    }
    showResponsivePage('overview');
}

export function focusLatestRuleCard() {
    const container = document.getElementById('blai-home-rule-grid');
    if (!container) return;

    const cards = container.querySelectorAll('.blai-home-card');
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
    const themeMode = String($('#blai-purifier-popup').attr('data-theme') || 'auto');
    $('#blai-loading-overlay').remove();
    $('body').append(`
        <div id="blai-loading-overlay" class="blai-loading-overlay" data-theme="${themeMode}" data-tt-mobile-surface="backdrop">
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
    const themeMode = String($('#blai-purifier-popup').attr('data-theme') || 'auto');
    const bytes = Number(stats.bytes) || 0;
    const mb = bytes > 0 ? (bytes / 1024 / 1024).toFixed(2) : '1.20';
    const entries = Number(stats.entries) || 0;
    $('#blai-zh-dictionary-modal')
        .attr('data-theme', themeMode)
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

export function showConfirmModal(onConfirm) {
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

export function showRiskConfirmModal(message) {
    return new Promise((resolve) => {
        const $modal = $('#blai-risk-confirm-modal');
        const finish = (confirmed) => {
            $modal.hide().attr('aria-hidden', 'true');
            $('#blai-risk-confirm-cancel, #blai-risk-confirm-ok').off('.blaiRiskConfirm');
            $modal.off('.blaiRiskConfirm');
            resolve(confirmed);
        };

        $('#blai-risk-confirm-text').text(String(message || ''));
        $modal.css('display', 'flex').attr('aria-hidden', 'false');
        $('#blai-risk-confirm-cancel').on('click.blaiRiskConfirm', () => finish(false));
        $('#blai-risk-confirm-ok').on('click.blaiRiskConfirm', () => finish(true));
        $modal.on('click.blaiRiskConfirm', (event) => {
            if (event.target === $modal[0]) finish(false);
        });
    });
}

export function showRiskInfoModal(message) {
    const $modal = $('#blai-risk-info-modal');
    const close = () => {
        $modal.hide().attr('aria-hidden', 'true');
        $('#blai-risk-info-close').off('.blaiRiskInfo');
        $modal.off('.blaiRiskInfo');
    };

    $('#blai-risk-info-text').text(String(message || ''));
    $modal.css('display', 'flex').attr('aria-hidden', 'false');
    $('#blai-risk-info-close').on('click.blaiRiskInfo', close).trigger('focus');
    $modal.on('click.blaiRiskInfo', (event) => {
        if (event.target === $modal[0]) close();
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
        $('#blai-tools-global-preset').text(settings.defaultPreset || '无');
        $('#blai-tools-chat-binding').text(currentChatBound || '无');
        $('#blai-tools-chat-context').text(currentChatBound ? chatCompletionPresetName : '无');
        $('#blai-tools-character-binding').text(currentBound || '无');
        $('#blai-tools-character-context').text(currentBound ? context.name : '无');
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
        syncProxyFieldState('#blai-unbind-current-character', $unbindItem);

        $(`#blai-purifier-popup [data-blai-click-proxy="#blai-default-toggle"] .binding-action-label`)
            .text(isDefaultActive ? '全局已设为此项' : '设为全局预设');
        $(`#blai-purifier-popup [data-blai-click-proxy="#blai-bind-current-chat-preset"] .binding-action-label`)
            .text(isChatPresetBound ? '取消预设绑定' : currentChatBound ? '更换预设绑定' : '绑定到预设');
        $(`#blai-purifier-popup [data-blai-click-proxy="#blai-bind-current-character"] .binding-action-label`)
            .text(isCharacterBound ? '角色卡已绑此项' : currentBound ? '更换角色卡绑定' : '绑定到角色卡');
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

export function updateToolbarUI() {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    cleanupInvalidPresetBindings();
    const selects = $('#blai-preset-select, #blai-tools-preset-select');
    if (!selects.length) return;

    if (runtimeState.presetsUiDirty || selects.filter((_, element) => element.children.length === 0).length > 0) {
        const presetNames = settings.presets ? Object.keys(settings.presets) : [];
        const optionsHtml = ['<option value="">-- 临时规则 (未绑定存档) --</option>']
            .concat(presetNames.map((name) => `<option value="${safeHtml(name)}">${safeHtml(name)}</option>`))
            .join('');
        selects.html(optionsHtml);
        markPresetsUiDirty(false);
    }
    selects.val(settings.activePreset || "");
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
    const container = $('#blai-home-rule-grid');
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
            const rPreview = getRewriteMode(sub) === 'ai'
                ? 'AI 运行时生成'
                : formatReplacementPreview(sub.replacements || [], mode);
            const subEnabled = sub.enabled !== false;
            const rewriteBadge = getRewriteMode(sub) === 'ai'
                ? '<span class="blai-home-rule-badge">AI 改写</span>'
                : '';
            return `
                <div class="blai-home-rule-item ${subEnabled ? '' : 'blai-is-disabled'}">
                    <div class="blai-home-rule-source">
                        <div class="blai-home-rule-labels">
                            <span class="blai-home-rule-badge">${tagText}</span>
                            ${rewriteBadge}
                        </div>
                        <span class="blai-home-source-text">${tPreview}</span>
                    </div>
                    <i class="fas fa-arrow-right blai-home-rule-arrow" aria-hidden="true"></i>
                    <div class="blai-home-rule-target">
                        <span class="blai-home-preview-label">改写预览</span>
                        <span class="blai-home-target-text">${rPreview}</span>
                    </div>
                </div>`;
        }).join('');

        const moreHtml = subRules.length > maxPreview
            ? `<div class="blai-home-more-text">... 以及其他 ${subRules.length - maxPreview} 组映射</div>`
            : '';
        const bodyHtml = subRules.length > 0
            ? `<div class="blai-home-card-body">${subRulesHtml}${moreHtml}</div>`
            : '<div class="blai-home-card-empty">此合集暂无规则</div>';

        const isEnabled = r.enabled !== false;
        const riskIndicatorHtml = isRuleActivationWarningEnabled(r)
            ? `<i class="fas fa-circle-exclamation blai-rule-risk-indicator blai-home-card-risk"
                  data-index="${i}"
                  title="查看启用风险提示"
                  aria-label="查看高风险规则组提示"
                  role="button"
                  tabindex="0"></i>`
            : '';
        const checkedAttr = isEnabled ? 'checked' : '';

        return `
            <article class="blai-home-card ${!isEnabled ? 'blai-is-disabled' : ''}" data-index="${i}">
                <header class="blai-home-card-header">
                    <div class="blai-home-card-heading">
                        <label class="blai-batch-checkbox-label blai-home-selection-control" title="选择此规则合集">
                            <input type="checkbox" class="batch-item-checkbox" data-index="${i}">
                            <span class="blai-home-selection-indicator" aria-hidden="true"></span>
                            <span class="blai-visually-hidden">选择 ${name}</span>
                        </label>
                        <label class="blai-home-enabled-control" title="启用或停用此规则组">
                            <input type="checkbox" class="blai-rule-toggle" data-index="${i}" ${checkedAttr}>
                            <span class="blai-home-enabled-indicator" aria-hidden="true"></span>
                            <span class="blai-home-card-title">${name}</span>
                            <span class="blai-home-card-count">${subRules.length} 条</span>
                        </label>
                    </div>
                    <div class="blai-home-card-actions">
                        ${riskIndicatorHtml}
                        <button class="blai-rule-edit blai-home-card-menu" type="button" data-index="${i}" title="打开合集" aria-label="打开合集"><i class="fas fa-ellipsis-vertical" aria-hidden="true"></i></button>
                    </div>
                </header>
                ${bodyHtml}
            </article>`;
    }).join('');

    container.html(html || '<div class="blai-home-empty-state"><i class="fas fa-folder-open" aria-hidden="true"></i><strong>当前没有规则合集</strong><span>点击“添加”创建第一个合集</span></div>');
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
        container.html('<div class="blai-subrule-empty">当前合集没有映射规则，请点击下方按钮添加。</div>');
        return;
    }

    const html = runtimeState.currentEditingSubrules.map((sub, i) => {
        const mode = sub.mode || 'text';
        const remark = sub.remark ? sub.remark.trim() : '';
        const subEnabled = sub.enabled !== false;
        const checkedAttr = subEnabled ? 'checked' : '';
        const moveUpDisabled = i === 0 ? 'disabled' : '';
        const moveDownDisabled = i === runtimeState.currentEditingSubrules.length - 1 ? 'disabled' : '';

        const badgeText = mode === 'regex' ? '正则' : mode === 'simple' ? '简易' : '普通';
        const badgeHTML = `<span class="blai-mapping-badge">${badgeText}</span>`;

        const tPreview = getRuleSourcePreviewText(sub);
        const rPreview = formatReplacementPreview(sub.replacements || [], mode);
        const rewriteBadge = getRewriteMode(sub) === 'ai'
            ? '<span class="blai-mapping-badge">AI 改写</span>'
            : '';

        let remarkHTML = '';
        if (remark) {
            remarkHTML = `
                <div class="blai-subrule-remark" style="margin-top: 8px; padding-top: 10px; border-top: 1px dotted color-mix(in srgb, var(--text-main) 35%, color-mix(in srgb, var(--bg-base) 12%, transparent)); font-size: 11px; color: var(--text-secondary); font-style: italic;">
                    <i class="fas fa-info-circle" style="margin-right: 4px;"></i>${safeHtml(remark)}
                </div>
            `;
        }

        return `
            <div class="blai-subrule-card ${subEnabled ? '' : 'blai-is-disabled'}" style="flex-shrink: 0 !important; background: var(--bg-surface); border: 1px solid var(--border-color); border-radius: 10px; padding: 12px 14px; margin-bottom: 12px; display: flex; flex-direction: column; box-shadow: 0 4px 10px color-mix(in srgb, var(--bg-base) 12%, transparent);">
                <div class="blai-subrule-header">
                    <div class="blai-subrule-badges">
                        <label class="blai-checkbox-label blai-subrule-enable-label" title="${subEnabled ? '停用此条规则' : '启用此条规则'}">
                            <input type="checkbox" class="blai-subrule-toggle" data-index="${i}" ${checkedAttr}>
                            <span class="blai-custom-checkbox"></span>
                        </label>
                        ${badgeHTML}
                        ${rewriteBadge}
                    </div>
                    <div class="blai-subrule-btn-group">
                        <button class="blai-move-subrule-up-btn blai-icon-btn" data-index="${i}" title="上移" ${moveUpDisabled}><i class="fas fa-arrow-up"></i></button>
                        <button class="blai-move-subrule-down-btn blai-icon-btn" data-index="${i}" title="下移" ${moveDownDisabled}><i class="fas fa-arrow-down"></i></button>
                        <button class="blai-edit-subrule-btn blai-icon-btn" data-index="${i}" title="独立编辑"><i class="fas fa-pen"></i></button>
                        <button class="blai-del-subrule-btn blai-icon-btn blai-danger-btn" data-index="${i}" title="删除"><i class="fas fa-trash"></i></button>
                        <button class="blai-remark-subrule-btn blai-icon-btn" data-index="${i}" title="快捷修改备注"><i class="fas fa-comment-dots"></i></button>
                    </div>
                </div>
                <div class="blai-subrule-preview">
                    <span class="blai-subrule-preview-source">${tPreview}</span>
                    <i class="fas fa-arrow-right" style="color: var(--text-secondary); font-size: 11px; margin: 0 6px;"></i>
                    <span class="blai-subrule-preview-replacement">${rPreview}</span>
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
