import { extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';

// Scope Tag parsing, normalization, and protection semantics.

const SCOPE_TAG_NAME_PATTERN = /^[\p{L}\p{N}_:][\p{L}\p{N}\p{M}_.:-]*$/u;
const SCOPE_TAG_START_PATTERN = /^<([\p{L}\p{N}_:][\p{L}\p{N}\p{M}_.:-]*)>$/u;
const SCOPE_TAG_LABEL_SEPARATOR = '//';
const DEFAULT_SCOPE_TAG_LABEL = '范围';
export const DEFAULT_SCOPE_TAG_GROUP_ID = 'default';
export const DEFAULT_SCOPE_TAG_GROUP_NAME = '默认分组';
const BUILTIN_SCOPE_TAG_DEFS = [
    { key: '<UpdateVariable>', startTag: '<UpdateVariable>', label: 'MVU变量' },
    { key: '<horae>', startTag: '<horae>', label: 'horae记忆表格' },
    { key: '<horaeevent>', startTag: '<horaeevent>', label: 'horae记忆表格' },
    { key: '<tableEdit>', startTag: '<tableEdit>', label: '木悠记忆表格' },
    { key: '<think>', startTag: '<think>', label: 'COT思维链' },
    { key: '<thinking>', startTag: '<thinking>', label: 'COT思维链' },
];
const BUILTIN_SCOPE_TAG_DEF_MAP = new Map(BUILTIN_SCOPE_TAG_DEFS.map((scopeTagDef) => [scopeTagDef.key, scopeTagDef]));
const COT_SCOPE_TAG_KEYS = new Set(['<think>', '<thinking>']);
export const COT_SCOPE_TAG_DISPLAY_TEXT = '<thinking>...</thinking> OR <think>...</think>';

export function createScopeTagId() {
    return `scope-tag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createScopeTagGroupId() {
    return `scope-group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeScopeTagGroupName(name) {
    return String(name ?? '').trim().replace(/\s+/g, ' ');
}

export function normalizeScopeTagGroupEntry(entry, fallbackIndex = 0) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const id = String(entry.id || '').trim();
    if (!id) return null;
    const fallbackName = id === DEFAULT_SCOPE_TAG_GROUP_ID
        ? DEFAULT_SCOPE_TAG_GROUP_NAME
        : `分组 ${fallbackIndex + 1}`;
    return {
        id,
        name: normalizeScopeTagGroupName(entry.name) || fallbackName,
    };
}

export function normalizeScopeTagGroupList(entries) {
    const groups = [];
    const seen = new Set();
    const addGroup = (entry, index = groups.length) => {
        const group = normalizeScopeTagGroupEntry(entry, index);
        if (!group || seen.has(group.id)) return;
        seen.add(group.id);
        groups.push(group);
    };

    if (Array.isArray(entries)) {
        entries.forEach((entry, index) => addGroup(entry, index));
    }

    if (!seen.has(DEFAULT_SCOPE_TAG_GROUP_ID)) {
        groups.unshift({ id: DEFAULT_SCOPE_TAG_GROUP_ID, name: DEFAULT_SCOPE_TAG_GROUP_NAME });
    }

    return groups.length > 0 ? groups : [{ id: DEFAULT_SCOPE_TAG_GROUP_ID, name: DEFAULT_SCOPE_TAG_GROUP_NAME }];
}

export function normalizeScopeTagCollapsedGroupList(entries, groups = []) {
    if (!Array.isArray(entries)) return [];
    const validGroupIds = new Set(normalizeScopeTagGroupList(groups).map((group) => group.id));
    const seen = new Set();
    const normalized = [];

    entries.forEach((entry) => {
        const groupId = String(entry || '').trim();
        if (!groupId || seen.has(groupId) || !validGroupIds.has(groupId)) return;
        seen.add(groupId);
        normalized.push(groupId);
    });

    return normalized;
}

export function parseScopeTagInput(input) {
    const source = String(input ?? '').trim();
    if (!source) {
        return { ok: false, error: { message: '请输入标签名或完整起始标签，例如 状态、<horae>，备注可填在下方。' } };
    }

    let label = '';
    let tagSource = source;
    const separatorIndex = source.indexOf(SCOPE_TAG_LABEL_SEPARATOR);
    if (separatorIndex >= 0) {
        tagSource = source.slice(0, separatorIndex).trim();
        label = normalizeScopeTagLabel(source.slice(separatorIndex + SCOPE_TAG_LABEL_SEPARATOR.length));
    }

    const match = tagSource.match(SCOPE_TAG_START_PATTERN);
    const bareTagName = SCOPE_TAG_NAME_PATTERN.test(tagSource) ? tagSource : '';
    if (!match && !bareTagName) {
        const bracketMatch = tagSource.match(/^<([^<>/\s][^<>]*)>$/);
        const rawName = bracketMatch ? bracketMatch[1].trim() : tagSource.replace(/[<>]/g, '').trim();
        if (rawName && !SCOPE_TAG_NAME_PATTERN.test(rawName)) {
            return { ok: false, error: { message: '标签名必须以中文、字母、数字、下划线或冒号开头，可包含中文、字母、数字、冒号、下划线、短横线和点号。' } };
        }
        return { ok: false, error: { message: '请输入标签名或无属性起始标签，例如 状态、UpdateVariable、<horae>。' } };
    }

    const tagName = match ? match[1] : bareTagName;
    return {
        ok: true,
        value: {
            label,
            tagName,
            startTag: `<${tagName}>`,
            endTag: `</${tagName}>`,
        },
    };
}

export function normalizeXmlTagNameInput(input, fallbackTagName = 'content') {
    const parsed = parseScopeTagInput(input);
    if (parsed.ok) return parsed.value.tagName;

    const fallback = parseScopeTagInput(fallbackTagName);
    return fallback.ok ? fallback.value.tagName : 'content';
}

export function normalizeOptionalXmlTagNameInput(input, fallbackTagName = 'content') {
    if (typeof input === 'string' && input.trim() === '') return '';
    return normalizeXmlTagNameInput(input, fallbackTagName);
}

function normalizeScopeTagLabel(label) {
    return String(label ?? '').trim().replace(/\s+/g, ' ');
}

function normalizeScopeTagBuiltinKey(rawBuiltinKey = '', startTag = '') {
    const builtinKey = String(rawBuiltinKey ?? '').trim();
    if (BUILTIN_SCOPE_TAG_DEF_MAP.has(builtinKey)) return builtinKey;
    if (BUILTIN_SCOPE_TAG_DEF_MAP.has(startTag)) return startTag;
    return '';
}

export function normalizeScopeTagBuiltinDismissedList(entries) {
    if (!Array.isArray(entries)) return [];
    const seen = new Set();
    const normalized = [];

    entries.forEach((entry) => {
        const builtinKey = normalizeScopeTagBuiltinKey(entry);
        if (!builtinKey || seen.has(builtinKey)) return;
        seen.add(builtinKey);
        normalized.push(builtinKey);
    });

    return normalized;
}

export function formatScopeTagInput(scopeTag) {
    if (!scopeTag || typeof scopeTag !== 'object') return '';
    const startTag = String(scopeTag.startTag ?? '').trim();
    if (!startTag) return '';
    const label = normalizeScopeTagLabel(scopeTag.label);
    return label ? `${startTag}${SCOPE_TAG_LABEL_SEPARATOR}${label}` : startTag;
}

export function getBuiltinScopeTagKeyForStartTag(startTag = '') {
    return normalizeScopeTagBuiltinKey('', String(startTag ?? '').trim());
}

export function isCotScopeTagKey(builtinKey = '') {
    return COT_SCOPE_TAG_KEYS.has(String(builtinKey ?? '').trim());
}

export function isCotScopeTagEntry(scopeTag) {
    if (!scopeTag || typeof scopeTag !== 'object') return false;
    return isCotScopeTagKey(scopeTag.builtinKey) || COT_SCOPE_TAG_KEYS.has(String(scopeTag.startTag ?? '').trim());
}

export function getCotScopeTagBuiltinKeys() {
    return [...COT_SCOPE_TAG_KEYS];
}

export function normalizeScopeTagEntry(entry, fallbackId = '') {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const rawId = String(entry.id || fallbackId || '');
    const sourceStartTag = String(entry.startTag ?? '').trim();
    const migratedStartTag = sourceStartTag === '<horea>'
        ? '<horaeevent>'
        : sourceStartTag;
    const sourceBuiltinKey = String(entry.builtinKey ?? '').trim();
    const migratedBuiltinKey = sourceBuiltinKey === '<horea>'
        ? '<horaeevent>'
        : sourceBuiltinKey;
    const parsed = parseScopeTagInput(migratedStartTag);
    if (!parsed.ok) return null;
    const groupId = String(entry.groupId || DEFAULT_SCOPE_TAG_GROUP_ID).trim() || DEFAULT_SCOPE_TAG_GROUP_ID;
    const builtinKey = normalizeScopeTagBuiltinKey(
        migratedBuiltinKey || (entry.builtin === true && rawId === 'builtin-scope-tag-3' ? '<horaeevent>' : migratedBuiltinKey),
        parsed.value.startTag
    );
    return {
        id: String(entry.id || fallbackId || createScopeTagId()),
        startTag: parsed.value.startTag,
        endTag: parsed.value.endTag,
        label: normalizeScopeTagLabel(entry.label),
        enabled: entry.enabled !== false,
        groupId,
        builtinKey,
        builtin: builtinKey !== '',
    };
}

export function normalizeScopeTagList(entries) {
    if (!Array.isArray(entries)) return [];
    const seen = new Set();
    const seenBuiltinKeys = new Set();
    const normalized = [];

    entries.forEach((entry, index) => {
        const scopeTag = normalizeScopeTagEntry(entry, `scope-tag-${index + 1}`);
        if (!scopeTag || seen.has(scopeTag.startTag)) return;
        if (scopeTag.builtinKey && seenBuiltinKeys.has(scopeTag.builtinKey)) return;
        seen.add(scopeTag.startTag);
        if (scopeTag.builtinKey) seenBuiltinKeys.add(scopeTag.builtinKey);
        normalized.push(scopeTag);
    });

    return normalized;
}

export function getBuiltinScopeTags() {
    return BUILTIN_SCOPE_TAG_DEFS.map((scopeTagDef, index) => {
        const parsed = parseScopeTagInput(scopeTagDef.startTag);
        return {
            id: `builtin-scope-tag-${index + 1}`,
            startTag: parsed.value.startTag,
            endTag: parsed.value.endTag,
            label: scopeTagDef.label,
            enabled: false,
            groupId: DEFAULT_SCOPE_TAG_GROUP_ID,
            builtinKey: scopeTagDef.key,
            builtin: true,
        };
    });
}

export function mergeScopeTagsWithBuiltins(entries, dismissedBuiltinKeys = []) {
    const normalizedDismissed = new Set(normalizeScopeTagBuiltinDismissedList(dismissedBuiltinKeys));
    const merged = normalizeScopeTagList(entries);
    const seenBuiltinKeys = new Set(merged.map((scopeTag) => scopeTag.builtinKey).filter(Boolean));

    getBuiltinScopeTags().forEach((scopeTag) => {
        if (normalizedDismissed.has(scopeTag.builtinKey)) return;
        if (seenBuiltinKeys.has(scopeTag.builtinKey)) return;
        merged.push(scopeTag);
    });

    return merged;
}

export function isCotScopeSkippingEnabled(settings = null) {
    const resolvedSettings = settings || getAppContext().extension_settings?.[extensionName] || {};
    const scopeTags = mergeScopeTagsWithBuiltins(
        resolvedSettings.scopeTags,
        resolvedSettings.scopeTagBuiltinDismissed
    );
    return scopeTags.some((tag) => tag.enabled !== false && isCotScopeTagEntry(tag));
}
