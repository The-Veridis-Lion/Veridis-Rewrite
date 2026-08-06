import { defaultAiRewriteSettings, extensionName, getAppContext } from './state.js';
import { logger } from './log.js';

const SIMPLE_WILDCARD_STOP_CHARS = ",，。.!?！？；;\n";
const REGEX_LITERAL_ALLOWED_FLAGS = new Set(['d', 'g', 'i', 'm', 's', 'u', 'v', 'y']);
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

export function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

function clampNumberSetting(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, min), max);
}

function clampIntegerSetting(value, min, max, fallback) {
    return Math.round(clampNumberSetting(value, min, max, fallback));
}

export function normalizePresetAiRewriteSettings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return {
        temperature: clampNumberSetting(value.temperature, 0, 2, defaultAiRewriteSettings.temperature),
        timeoutMs: clampIntegerSetting(value.timeoutMs, 1000, 120000, defaultAiRewriteSettings.timeoutMs),
        maxRetries: clampIntegerSetting(value.maxRetries, 0, 5, defaultAiRewriteSettings.maxRetries),
        maxItemsPerRequest: clampIntegerSetting(value.maxItemsPerRequest, 1, 32, defaultAiRewriteSettings.maxItemsPerRequest),
        maxContextChars: clampIntegerSetting(value.maxContextChars, 1000, 60000, defaultAiRewriteSettings.maxContextChars),
        maxRewriteCharsPerItem: clampIntegerSetting(value.maxRewriteCharsPerItem, 50, 10000, defaultAiRewriteSettings.maxRewriteCharsPerItem),
        promptTemplate: String(value.promptTemplate || defaultAiRewriteSettings.promptTemplate),
    };
}

export function getCurrentPresetAiRewriteSettings(aiRewriteSettings = null) {
    return normalizePresetAiRewriteSettings(aiRewriteSettings || defaultAiRewriteSettings)
        || normalizePresetAiRewriteSettings(defaultAiRewriteSettings);
}

export function getPresetRules(presetEntry) {
    if (Array.isArray(presetEntry)) return presetEntry;
    if (presetEntry && typeof presetEntry === 'object' && Array.isArray(presetEntry.rules)) return presetEntry.rules;
    return [];
}

export function getPresetAiRewriteSettings(presetEntry) {
    if (!presetEntry || Array.isArray(presetEntry) || typeof presetEntry !== 'object') return null;
    return normalizePresetAiRewriteSettings(presetEntry.aiRewrite);
}

export function buildPresetEntry(rules = [], aiRewriteSettings = null) {
    const entry = {
        rules: deepClone(Array.isArray(rules) ? rules : []),
    };
    const normalizedAiRewrite = normalizePresetAiRewriteSettings(aiRewriteSettings);
    if (normalizedAiRewrite) entry.aiRewrite = normalizedAiRewrite;
    return entry;
}

export function getCurrentCharacterContext() {
    const { chat_metadata } = getAppContext();
    const normalizeText = (v) => String(v || '').trim();
    const byName = (name, source = 'name') => {
        const clean = normalizeText(name);
        if (!clean) return null;
        return { key: `${source}:${clean}`, name: clean };
    };
    const byId = (id, name = '') => {
        const cleanId = normalizeText(id);
        if (!cleanId) return null;
        return { key: `chid:${cleanId}`, name: normalizeText(name) || `角色#${cleanId}` };
    };

    try {
        const chidRaw = window.this_chid;
        const chid = Number(chidRaw);
        if (Number.isInteger(chid) && chid >= 0 && Array.isArray(window.characters) && window.characters[chid]) {
            const ch = window.characters[chid];
            const name = String(ch.name || ch.ch_name || '').trim();
            return byId(chid, name);
        }
    } catch (e) { logger.warn(`getCurrentCharacterContext: window.this_chid 读取失败`, e); }

    const selectedCard = document.querySelector('.character_select.selected, .group_select.selected, .character_select[chid].active');
    if (selectedCard) {
        const selectedChid = selectedCard.getAttribute('chid') || selectedCard.dataset?.chid || selectedCard.dataset?.id;
        const selectedName = selectedCard.getAttribute('title') || selectedCard.dataset?.name || selectedCard.querySelector('.ch_name, .name_text, .character_name')?.textContent;
        const bySelectedId = byId(selectedChid, selectedName);
        if (bySelectedId) return bySelectedId;
        const bySelectedName = byName(selectedName, 'card');
        if (bySelectedName) return bySelectedName;
    }

    const metadataName = normalizeText(chat_metadata?.character_name || chat_metadata?.name2 || chat_metadata?.ch_name || chat_metadata?.name);
    const fromMetaName = byName(metadataName);
    if (fromMetaName) return fromMetaName;

    const chatMetaId = normalizeText(chat_metadata?.character_id || chat_metadata?.avatar || chat_metadata?.main_chat || chat_metadata?.chat_id);
    const fromMetaId = byId(chatMetaId, metadataName);
    if (fromMetaId) return fromMetaId;

    const headerName = normalizeText(
        document.querySelector('#chat_header .name_text, #rm_info_name, #chat .name_text, #selected_chat_pole .name_text')?.textContent
    );
    const fromHeader = byName(headerName, 'header');
    if (fromHeader) return fromHeader;

    const hashKey = normalizeText(window.location?.hash || '');
    if (hashKey) {
        return { key: `hash:${hashKey}`, name: `当前聊天(${hashKey.slice(0, 24)})` };
    }

    logger.info('未检测到角色上下文（getCurrentCharacterContext 返回空 key）');
    return { key: "", name: "未检测到角色（可先发送一条消息后再试）" };
}

export function getCurrentChatCompletionPresetName() {
    const select = document.querySelector('#settings_preset_openai');
    if (!select || !(select instanceof HTMLSelectElement)) return "";
    const option = select.options[select.selectedIndex];
    return String(option?.textContent || '').trim();
}

export function getPresetBindingUsage(presetName) {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const target = String(presetName || '');
    const usage = {
        characterKeys: [],
        chatCompletionPresetNames: [],
        hasCharacterBindings: false,
        hasChatCompletionPresetBindings: false,
    };
    if (!settings || !target) return usage;

    Object.entries(settings.characterBindings || {}).forEach(([key, preset]) => {
        if (preset === target) usage.characterKeys.push(key);
    });
    Object.entries(settings.chatCompletionPresetBindings || {}).forEach(([name, preset]) => {
        if (preset === target) usage.chatCompletionPresetNames.push(name);
    });

    usage.hasCharacterBindings = usage.characterKeys.length > 0;
    usage.hasChatCompletionPresetBindings = usage.chatCompletionPresetNames.length > 0;
    return usage;
}

export function getPresetBindingResolution(characterKey = "", options = {}) {
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName];
    const presets = settings?.presets || {};
    if (!settings) {
        return { presetName: "", source: "", chatCompletionPresetName: "", characterPreset: "", chatCompletionPreset: "" };
    }

    const chatCompletionPresetName = options.chatCompletionPresetName !== undefined
        ? String(options.chatCompletionPresetName || '').trim()
        : getCurrentChatCompletionPresetName();
    const characterPreset = characterKey ? String(settings.characterBindings?.[characterKey] || '') : '';
    const chatCompletionPreset = chatCompletionPresetName
        ? String(settings.chatCompletionPresetBindings?.[chatCompletionPresetName] || '')
        : '';
    const defaultPreset = String(settings.defaultPreset || '');

    if (characterPreset && presets[characterPreset]) {
        return { presetName: characterPreset, source: "character", chatCompletionPresetName, characterPreset, chatCompletionPreset };
    }
    if (chatCompletionPreset && presets[chatCompletionPreset]) {
        return { presetName: chatCompletionPreset, source: "chatCompletionPreset", chatCompletionPresetName, characterPreset, chatCompletionPreset };
    }
    if (defaultPreset && presets[defaultPreset]) {
        return { presetName: defaultPreset, source: "default", chatCompletionPresetName, characterPreset, chatCompletionPreset };
    }
    return { presetName: "", source: "", chatCompletionPresetName, characterPreset, chatCompletionPreset };
}

export function getPresetForCharacter(characterKey, options = {}) {
    return getPresetBindingResolution(characterKey, options).presetName;
}

function findLastUnescapedSlash(text) {
    for (let i = text.length - 1; i > 0; i--) {
        if (text[i] !== '/') continue;
        let backslashCount = 0;
        for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) backslashCount++;
        if (backslashCount % 2 === 0) return i;
    }
    return -1;
}

function normalizeRegexLiteralFlags(rawFlags) {
    let normalizedFlags = '';
    const seen = new Set();
    for (const flag of rawFlags) {
        if (!REGEX_LITERAL_ALLOWED_FLAGS.has(flag)) {
            return { ok: false, error: { message: `包含不支持的 flags：${flag}` } };
        }
        if (seen.has(flag)) {
            return { ok: false, error: { message: `包含重复的 flags：${flag}` } };
        }
        seen.add(flag);
        normalizedFlags += flag;
    }
    if (!seen.has('g')) normalizedFlags += 'g';
    return { ok: true, flags: normalizedFlags };
}

export function compileRegexTarget(target) {
    const source = String(target ?? '').trim();
    if (!source) return { ok: false, error: { message: '规则不能为空。' } };

    let pattern = source;
    let flags = 'gmu';

    if (source.startsWith('/')) {
        const lastSlash = findLastUnescapedSlash(source);
        if (lastSlash <= 0) {
            return { ok: false, error: { message: '不是合法的 /pattern/flags 格式。' } };
        }

        pattern = source.slice(1, lastSlash);
        const normalized = normalizeRegexLiteralFlags(source.slice(lastSlash + 1));
        if (!normalized.ok) return normalized;
        flags = normalized.flags;
    }

    try {
        const regex = new RegExp(pattern, flags);
        const matchesEmptyString = regex.test('');
        regex.lastIndex = 0;
        if (matchesEmptyString) {
            return { ok: false, error: { message: '会匹配空字符串，存在风险，请改写规则。' } };
        }
        return { ok: true, value: { source, pattern, flags, regex } };
    } catch (e) {
        return { ok: false, error: { message: e?.message || '正则表达式语法错误。' } };
    }
}

export function validateRegexTargetInput(text) {
    const parsed = [];
    const lines = String(text ?? '').split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const lineText = String(lines[i] ?? '').trim();
        if (!lineText) continue;

        const compiled = compileRegexTarget(lineText);
        if (!compiled.ok) {
            return {
                ok: false,
                error: {
                    line: i + 1,
                    input: lineText,
                    message: compiled.error.message,
                },
            };
        }

        parsed.push({ line: i + 1, ...compiled.value });
    }

    return { ok: true, parsed };
}

export function parseInputToWords(text, mode = 'text', options = {}) {
    if (!text) return [];
    const isTarget = options.isTarget !== false;
    if (mode === 'regex' || mode === 'simple') {
        const words = text.split('\n').map(w => w.trim());
        return isTarget ? words.filter(w => w) : words;
    }
    const noQuotes = text.replace(/['"‘’”“”]/g, ' ');
    const textWords = isTarget
        ? noQuotes.split(/[\s,，、\n]+/)
        : noQuotes.split(/[,\n，、]/);
    const words = textWords.map(w => w.trim());
    return isTarget ? words.filter(w => w) : words;
}

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

function isRuleLikeObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Array.isArray(value.subRules)
        || Array.isArray(value.targets)
        || (typeof value.name === 'string' && ('enabled' in value || 'subRules' in value));
}

/**
 * 兼容多种预设导入格式，统一提取为规则数组。
 * 支持原生数组、{ rules }、{ __content__ }、以及带数字键的对象包装。
 * @param {any} payload 导入的 JSON 对象。
 * @returns {Array<object>} 规则数组。
 */
export function normalizeImportedRulesPayload(payload) {
    if (Array.isArray(payload)) return payload;

    if (!payload || typeof payload !== 'object') {
        throw new Error('格式非对象或数组');
    }

    if ('rules' in payload) {
        return normalizeImportedRulesPayload(payload.rules);
    }

    if ('__content__' in payload) {
        return normalizeImportedRulesPayload(payload.__content__);
    }

    if ('content' in payload) {
        return normalizeImportedRulesPayload(payload.content);
    }

    const numericKeys = Object.keys(payload)
        .filter((key) => /^\d+$/.test(key))
        .sort((a, b) => Number(a) - Number(b));
    if (numericKeys.length > 0) {
        const numericRules = numericKeys
            .map((key) => payload[key])
            .filter(isRuleLikeObject);
        if (numericRules.length > 0) return numericRules;
    }

    const candidateRules = Object.entries(payload)
        .filter(([key]) => !String(key).startsWith('_'))
        .map(([, value]) => value)
        .filter(isRuleLikeObject);
    if (candidateRules.length > 0) return candidateRules;

    throw new Error('未识别的预设格式');
}

export function buildSimpleWildcardPattern() {
    const escapedStops = SIMPLE_WILDCARD_STOP_CHARS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return `[^${escapedStops}]{0,15}?`;
}
