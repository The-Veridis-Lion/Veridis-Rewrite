// Owns Scope Tag DOM projection. Reads Scope/settings state but does not mutate or persist it.
import { extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { showResponsivePage } from '../ui/shell.js';
import { safeHtml } from '../ui/html.js';
import { COT_SCOPE_TAG_DISPLAY_TEXT, DEFAULT_SCOPE_TAG_GROUP_ID, DEFAULT_SCOPE_TAG_GROUP_NAME, isCotScopeTagEntry, mergeScopeTagsWithBuiltins, normalizeScopeTagCollapsedGroupList, normalizeScopeTagGroupList } from './model.js';
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
