/*
 * Owns runtime Chinese variant generation, regex-pattern construction, and text/Rule conversion
 * using an already-installed dictionary. It does not download, verify, cache, or install dictionary packages.
 */

import { zhRuntimeState } from './state.js';
import {
    MAX_VARIANTS_PER_TARGET,
    normalizeZhVariantOptions,
    uniqueValues,
} from './dictionary.js';

function escapeRegExpLiteral(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeRegExpCharClassValue(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/\]/g, '\\]')
        .replace(/\^/g, '\\^')
        .replace(/-/g, '\\-');
}

function getActiveBuckets(options = {}) {
    const normalized = normalizeZhVariantOptions(options);
    const dictionary = zhRuntimeState.zhVariantDictionary;
    if (!dictionary?.ready) return [];
    const buckets = [dictionary.index.buckets.base];
    if (normalized.tw) buckets.push(dictionary.index.buckets.tw);
    if (normalized.hk) buckets.push(dictionary.index.buckets.hk);
    return buckets;
}

function getActiveGroupEntries(options = {}) {
    const normalized = normalizeZhVariantOptions(options);
    const dictionary = zhRuntimeState.zhVariantDictionary;
    if (!dictionary?.ready) return [];
    const groups = [
        dictionary.index.groups.s2t,
        dictionary.index.groups.t2s,
    ];
    if (normalized.tw) groups.push(dictionary.index.groups.tw);
    if (normalized.hk) groups.push(dictionary.index.groups.hk);
    return groups;
}

function getMapVariants(mapName, value, options = {}) {
    const source = String(value ?? '');
    const variants = [];
    getActiveBuckets(options).forEach((bucket) => {
        const mapped = bucket?.[mapName]?.get(source);
        if (!mapped) return;
        mapped.forEach((item) => variants.push(item));
    });
    return uniqueValues(variants);
}

export function getChineseCharVariants(char, options = {}) {
    const source = String(char ?? '');
    if (!source) return [];
    return uniqueValues([source, ...getMapVariants('charVariants', source, options)]);
}

function getChinesePhraseVariants(value, options = {}) {
    const source = String(value ?? '');
    if (!source) return [];
    return getMapVariants('phraseVariants', source, options);
}

function convertByEntries(value, entries = []) {
    const source = String(value ?? '');
    const entryList = Array.isArray(entries) ? entries : entries?.entries;
    if (!source || !Array.isArray(entryList) || entryList.length === 0) return source;
    let output = '';
    let cursor = 0;

    while (cursor < source.length) {
        let matched = null;
        const candidates = entries?.byFirstChar?.get(source[cursor]) || entryList;
        for (const entry of candidates) {
            if (source.startsWith(entry.source, cursor)) {
                matched = entry;
                break;
            }
        }
        if (matched) {
            output += matched.targets[0] || matched.source;
            cursor += matched.source.length;
            continue;
        }
        output += source[cursor];
        cursor++;
    }

    return output;
}

export function getChineseTextVariants(value, options = {}) {
    const source = String(value ?? '');
    if (!source || !zhRuntimeState.zhVariantDictionary?.ready) return source ? [source] : [];

    const seen = new Set([source]);
    const queue = [{ value: source, depth: 0 }];
    const groupEntries = getActiveGroupEntries(options);

    while (queue.length > 0 && seen.size < MAX_VARIANTS_PER_TARGET) {
        const current = queue.shift();
        const addVariant = (candidate) => {
            const normalized = String(candidate ?? '');
            if (!normalized || seen.has(normalized) || seen.size >= MAX_VARIANTS_PER_TARGET) return;
            seen.add(normalized);
            queue.push({ value: normalized, depth: current.depth + 1 });
        };

        getChinesePhraseVariants(current.value, options).forEach(addVariant);

        if (current.depth >= 2) continue;
        groupEntries.forEach((entries) => addVariant(convertByEntries(current.value, entries)));
    }

    return [...seen].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function buildCharVariantPattern(value, options = {}) {
    return Array.from(String(value ?? '')).map((char) => {
        const variants = getChineseCharVariants(char, options).sort((a, b) => a.localeCompare(b));
        if (variants.length <= 1) return escapeRegExpLiteral(char);
        return `[${variants.map(escapeRegExpCharClassValue).join('')}]`;
    }).join('');
}

export function buildChineseVariantPattern(value, options = {}) {
    const source = String(value ?? '');
    if (!source) return '';
    if (!zhRuntimeState.zhVariantDictionary?.ready) return escapeRegExpLiteral(source);

    const variantPatterns = uniqueValues(
        getChineseTextVariants(source, options).map((variant) => buildCharVariantPattern(variant, options))
    );
    if (variantPatterns.length <= 1) return variantPatterns[0] || escapeRegExpLiteral(source);
    return `(?:${variantPatterns.join('|')})`;
}

export function getChineseTextVariantLengths(value, options = {}) {
    return uniqueValues(getChineseTextVariants(value, options).map((variant) => String(variant).length));
}

export function convertChineseText(value, direction) {
    const source = String(value ?? '');
    if (!source || !zhRuntimeState.zhVariantDictionary?.ready) return value;
    const dictionary = zhRuntimeState.zhVariantDictionary;
    const entries = direction === 't2s'
        ? dictionary.index.groups.t2s
        : dictionary.index.groups.s2t;
    return convertByEntries(source, entries);
}

function convertStringArray(values, direction) {
    return Array.isArray(values) ? values.map((value) => convertChineseText(String(value ?? ''), direction)) : [];
}

function convertOptionalString(value, direction) {
    return typeof value === 'string' ? convertChineseText(value, direction) : value;
}

export function convertRuleListChinese(rules, direction) {
    return (Array.isArray(rules) ? rules : []).map((rule) => {
        const nextRule = { ...(rule || {}) };
        nextRule.name = convertOptionalString(nextRule.name, direction);
        nextRule.subRules = (Array.isArray(nextRule.subRules) ? nextRule.subRules : []).map((subRule) => ({
            ...(subRule || {}),
            targets: convertStringArray(subRule?.targets, direction),
            replacements: convertStringArray(subRule?.replacements, direction),
            remark: convertOptionalString(subRule?.remark, direction),
        }));
        return nextRule;
    });
}


