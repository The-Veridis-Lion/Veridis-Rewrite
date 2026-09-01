/**
 * Owns Rules/Rule Search/editor DOM projection and transient editor presentation state.
 * It does not persist rule mutations.
 */
import { extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { rulesRuntimeState, markRulesUiDirty } from './state.js';
import { isRuleActivationWarningEnabled, parseInputToWords } from './model.js';
import { safeHtml } from '../ui/html.js';

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

export function clearRuleSearchEditFlow() {
    rulesRuntimeState.searchEditFlow.active = false;
    rulesRuntimeState.searchEditFlow.returnMode = '';
    rulesRuntimeState.searchEditFlow.ruleIndex = -1;
    rulesRuntimeState.searchEditFlow.subRuleIndex = -1;
}

export function resetRuleSearchState() {
    rulesRuntimeState.ruleSearchKeyword = '';
    rulesRuntimeState.ruleSearchDraftKeyword = '';
    rulesRuntimeState.ruleSearchHasSearched = false;
    rulesRuntimeState.ruleSearchExpandedMenuKey = '';
    clearRuleSearchEditFlow();
}

export function syncRuleSearchInputUi(options = {}) {
    const { syncValue = false } = options;
    const draftKeyword = String(rulesRuntimeState.ruleSearchDraftKeyword || '');
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

    const keyword = String(rulesRuntimeState.ruleSearchKeyword || '').trim();
    syncRuleSearchInputUi();

    if (!rulesRuntimeState.ruleSearchHasSearched || !keyword) {
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
        const menuHtml = rulesRuntimeState.ruleSearchExpandedMenuKey === item.key
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
    if (!rulesRuntimeState.rulesUiDirty && container.children().length > 0) return;

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
    if (rulesRuntimeState.currentEditingSubrules.length === 0) {
        container.html('<div class="blai-subrule-empty">当前合集没有映射规则，请点击下方按钮添加。</div>');
        return;
    }

    const html = rulesRuntimeState.currentEditingSubrules.map((sub, i) => {
        const mode = sub.mode || 'text';
        const remark = sub.remark ? sub.remark.trim() : '';
        const subEnabled = sub.enabled !== false;
        const checkedAttr = subEnabled ? 'checked' : '';
        const moveUpDisabled = i === 0 ? 'disabled' : '';
        const moveDownDisabled = i === rulesRuntimeState.currentEditingSubrules.length - 1 ? 'disabled' : '';

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
    rulesRuntimeState.currentSubruleEditIndex = index;
    let mode = 'simple';
    let tStr = '';
    let replacements = [];
    let remark = '';
    let rewriteMode = 'program';
    let aiPromptTemplate = '';

    if (index >= 0 && rulesRuntimeState.currentEditingSubrules[index]) {
        const sub = rulesRuntimeState.currentEditingSubrules[index];
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
    rulesRuntimeState.currentTransferRuleIndexes = indexes
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v >= 0);
    const $select = $('#blai-transfer-target');
    $select.html(targetNames.map((name) => `<option value="${safeHtml(name)}">${safeHtml(name)}</option>`).join(''));
    $('#blai-rule-transfer-modal').css('display', 'flex');
}

export function closeTransferModal() {
    rulesRuntimeState.currentTransferRuleIndexes = [];
    $('#blai-rule-transfer-modal').hide();
}

export function openEditModal(index = -1, options = {}) {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const { source = 'main', returnMode = 'group', subRuleIndex = -1 } = options;
    rulesRuntimeState.currentEditingIndex = index;
    if (source === 'search') {
        rulesRuntimeState.searchEditFlow.active = true;
        rulesRuntimeState.searchEditFlow.returnMode = returnMode;
        rulesRuntimeState.searchEditFlow.ruleIndex = index;
        rulesRuntimeState.searchEditFlow.subRuleIndex = subRuleIndex;
    } else {
        clearRuleSearchEditFlow();
    }
    const modal = $('#blai-rule-edit-modal');

    if (index === -1) {
        $('#blai-edit-modal-title').html('<i class="fas fa-folder-plus"></i> 新增规则合集');
        $('#blai-edit-name').val('');
        rulesRuntimeState.currentEditingSubrules = [{ targets: [], replacements: [], mode: 'simple', enabled: true, isEditing: false }];
    } else {
        const rule = settings.rules[index];
        $('#blai-edit-modal-title').html('<i class="fas fa-pen"></i> 编辑规则合集');
        $('#blai-edit-name').val(rule.name || '');
        rulesRuntimeState.currentEditingSubrules = JSON.parse(JSON.stringify(rule.subRules || []));
        rulesRuntimeState.currentEditingSubrules.forEach(sub => {
            if (sub.enabled === undefined) sub.enabled = true;
            sub.isEditing = false;
        });
    }

    renderSubrulesToModal();
    modal.css('display', 'flex');
}
