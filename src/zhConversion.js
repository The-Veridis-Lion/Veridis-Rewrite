import { extensionName, getAppContext, runtimeState } from './state.js';
import { logger } from './log.js';

const OPENCC_DICTIONARY_COMMIT = '2736adb0f27d8c2e2747ea58dfaa016c41503cc4';
export const ZH_DICTIONARY_PACKAGE_VERSION = `opencc-${OPENCC_DICTIONARY_COMMIT.slice(0, 12)}-zh-variant-v1`;
const OPENCC_DICTIONARY_BASE_URL = `https://cdn.jsdelivr.net/gh/BYVoid/OpenCC@${OPENCC_DICTIONARY_COMMIT}/data/dictionary`;
const CACHE_KEY = `${extensionName}:zh-variant-dictionary:${ZH_DICTIONARY_PACKAGE_VERSION}`;
const MAX_VARIANTS_PER_TARGET = 96;

const DICTIONARY_FILES = [
    { name: 'STCharacters.txt', bucket: 'base', group: 's2t', bytes: 35832, entries: 4011, sha256: '5f1ed494af5a5fc793be3693cc9f151c980e3d78c6b12626a084a91f79eee1b3' },
    { name: 'STPhrases.txt', bucket: 'base', group: 's2t', bytes: 1012478, entries: 49385, sha256: 'dc04ae06cb7d53152494e83bcf4ee7ceb623c9a766a705060b0bae23986dddcd' },
    { name: 'TSCharacters.txt', bucket: 'base', group: 't2s', bytes: 104369, entries: 4143, sha256: '795f53d3f3a29284f9325e2efe64215e199a53339a22b666342aad3ab1e6e722' },
    { name: 'TSPhrases.txt', bucket: 'base', group: 't2s', bytes: 8620, entries: 469, sha256: 'ed408a9addd621a0523dde359dfa392e378d65b44fc50293fdc7c1456b83c5c9' },
    { name: 'TWPhrases.txt', bucket: 'tw', group: 'tw', bytes: 17769, entries: 776, sha256: '4798f5c6297c29595b28a1272c3be633282fffedd2c24c049c6fcdb3155cd8b6' },
    { name: 'TWVariants.txt', bucket: 'tw', group: 'tw', bytes: 554, entries: 38, sha256: '75d5c5b83220dfd0c22ff500081b553da4e447ff6b1822fec44f40e4b33c0a56' },
    { name: 'TWVariantsRevPhrases.txt', bucket: 'tw', group: 'tw', bytes: 20983, entries: 1004, sha256: '4cc2de3f6b3bc8034f217bf98023264ad1e3deecccd7ed0a3ff7c4176ca0a8e2' },
    { name: 'HKVariants.txt', bucket: 'hk', group: 'hk', bytes: 774, entries: 63, sha256: '3a06c3619d17d739203be6452045786b2298b0eec81b8a2a4b9a372b6346ecb2' },
    { name: 'HKVariantsRevPhrases.txt', bucket: 'hk', group: 'hk', bytes: 22520, entries: 1073, sha256: 'f2d3046e3fd8f8b8abfca8668df3e13f9dfe218b320d078a99701bec08b37d15' },
];

const EXPECTED_TOTAL_BYTES = DICTIONARY_FILES.reduce((sum, file) => sum + file.bytes, 0);
const EXPECTED_TOTAL_ENTRIES = DICTIONARY_FILES.reduce((sum, file) => sum + file.entries, 0);
const EXPECTED_PACKAGE_DIGEST_SOURCE = DICTIONARY_FILES.map((file) => `${file.name}:${file.sha256}`).join('|');

function getSettings() {
    return getAppContext().extension_settings?.[extensionName] || {};
}

function normalizeBoolean(value, fallback = true) {
    return typeof value === 'boolean' ? value : fallback;
}

export function normalizeZhVariantOptions(options = {}) {
    return {
        tw: normalizeBoolean(options?.tw, true),
        hk: normalizeBoolean(options?.hk, true),
    };
}

export function normalizeZhVariantSettings(settings = getSettings()) {
    if (!settings || typeof settings !== 'object') return settings;
    settings.zhVariantCompatEnabled = settings.zhVariantCompatEnabled === true;
    settings.zhVariantCompatOptions = normalizeZhVariantOptions(settings.zhVariantCompatOptions);
    if (!settings.zhVariantDictionary || typeof settings.zhVariantDictionary !== 'object') {
        settings.zhVariantDictionary = {};
    }
    settings.zhVariantDictionary = {
        status: ['missing', 'verified', 'failed'].includes(settings.zhVariantDictionary.status)
            ? settings.zhVariantDictionary.status
            : 'missing',
        packageVersion: String(settings.zhVariantDictionary.packageVersion || ''),
        verifiedAt: Number(settings.zhVariantDictionary.verifiedAt) || 0,
        bytes: Number(settings.zhVariantDictionary.bytes) || 0,
        entries: Number(settings.zhVariantDictionary.entries) || 0,
        fileCount: Number(settings.zhVariantDictionary.fileCount) || 0,
        digest: String(settings.zhVariantDictionary.digest || ''),
        lastError: String(settings.zhVariantDictionary.lastError || ''),
    };
    return settings;
}

export function getZhVariantCompatOptions(settings = getSettings()) {
    return normalizeZhVariantOptions(settings?.zhVariantCompatOptions);
}

function getStorage() {
    try {
        return window?.localStorage || null;
    } catch (e) {
        logger.warn('无法访问 localStorage，增强简繁词典不可缓存', e);
        return null;
    }
}

function readCachedPackage() {
    const storage = getStorage();
    if (!storage) return null;
    try {
        const raw = storage.getItem(CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.packageVersion !== ZH_DICTIONARY_PACKAGE_VERSION) return null;
        if (!parsed.files || typeof parsed.files !== 'object') return null;
        return parsed;
    } catch (e) {
        logger.warn('读取增强简繁词典缓存失败', e);
        return null;
    }
}

function writeCachedPackage(packagePayload) {
    const storage = getStorage();
    if (!storage) throw new Error('无法访问浏览器本地缓存，词典包不能持久保存。');
    storage.setItem(CACHE_KEY, JSON.stringify(packagePayload));
}

function updateSettingsDictionaryMeta(meta, status = 'verified', error = '', targetSettings = getSettings()) {
    const settings = targetSettings;
    normalizeZhVariantSettings(settings);
    const currentMeta = settings.zhVariantDictionary || {};
    settings.zhVariantDictionary = {
        status,
        packageVersion: status === 'verified' ? ZH_DICTIONARY_PACKAGE_VERSION : '',
        verifiedAt: status === 'verified'
            ? Number(meta?.verifiedAt || currentMeta.verifiedAt) || Date.now()
            : 0,
        bytes: status === 'verified' ? EXPECTED_TOTAL_BYTES : 0,
        entries: status === 'verified' ? EXPECTED_TOTAL_ENTRIES : 0,
        fileCount: status === 'verified' ? DICTIONARY_FILES.length : 0,
        digest: status === 'verified' ? meta?.digest || '' : '',
        lastError: error,
    };
}

function uniqueValues(values) {
    const seen = new Set();
    const result = [];
    values.forEach((value) => {
        const normalized = String(value ?? '');
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        result.push(normalized);
    });
    return result;
}

function addMapValue(map, key, value) {
    const source = String(key ?? '').trim();
    const target = String(value ?? '').trim();
    if (!source || !target || source === target) return;
    if (!map.has(source)) map.set(source, new Set());
    map.get(source).add(target);
}

function addBidirectionalVariant(bucket, source, target) {
    const isCharVariant = Array.from(source).length === 1 && Array.from(target).length === 1;
    addMapValue(isCharVariant ? bucket.charVariants : bucket.phraseVariants, source, target);
    addMapValue(isCharVariant ? bucket.charVariants : bucket.phraseVariants, target, source);
}

function parseDictionaryEntries(text) {
    const entries = [];
    String(text || '').split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;
        const [sourceColumn, ...targetColumns] = trimmed.split(/\t+/);
        const source = String(sourceColumn || '').trim();
        const targets = targetColumns.join(' ').trim().split(/\s+/).map((target) => target.trim()).filter(Boolean);
        if (!source || targets.length === 0) return;
        entries.push({ source, targets });
    });
    return entries;
}

function createEmptyIndex() {
    return {
        buckets: {
            base: { charVariants: new Map(), phraseVariants: new Map() },
            tw: { charVariants: new Map(), phraseVariants: new Map() },
            hk: { charVariants: new Map(), phraseVariants: new Map() },
        },
        groups: {
            s2t: [],
            t2s: [],
            tw: [],
            hk: [],
        },
    };
}

function sortConversionEntries(entries) {
    return entries.sort((a, b) => b.source.length - a.source.length || a.source.localeCompare(b.source));
}

function bucketConversionEntries(entries) {
    const byFirstChar = new Map();
    entries.forEach((entry) => {
        const firstChar = entry.source[0] || '';
        if (!firstChar) return;
        if (!byFirstChar.has(firstChar)) byFirstChar.set(firstChar, []);
        byFirstChar.get(firstChar).push(entry);
    });
    return { entries, byFirstChar };
}

function buildDictionaryIndex(files) {
    const index = createEmptyIndex();

    DICTIONARY_FILES.forEach((fileDef) => {
        const text = files[fileDef.name];
        const entries = parseDictionaryEntries(text);
        const bucket = index.buckets[fileDef.bucket];
        entries.forEach((entry) => {
            const cleanTargets = uniqueValues(entry.targets);
            cleanTargets.forEach((target) => addBidirectionalVariant(bucket, entry.source, target));
            index.groups[fileDef.group].push({ source: entry.source, targets: cleanTargets });
        });
    });

    Object.keys(index.groups).forEach((groupKey) => {
        index.groups[groupKey] = bucketConversionEntries(sortConversionEntries(index.groups[groupKey]));
    });

    return index;
}

function setRuntimeDictionary(packagePayload) {
    const index = buildDictionaryIndex(packagePayload.files);
    runtimeState.zhVariantDictionary = {
        ready: true,
        packageVersion: ZH_DICTIONARY_PACKAGE_VERSION,
        commit: OPENCC_DICTIONARY_COMMIT,
        verifiedAt: packagePayload.verifiedAt || Date.now(),
        digest: packagePayload.digest || '',
        index,
    };
}

export function restoreZhDictionaryPackageFromCache(settings = getSettings()) {
    normalizeZhVariantSettings(settings);
    if (runtimeState.zhVariantDictionary?.ready === true
        && runtimeState.zhVariantDictionary.packageVersion === ZH_DICTIONARY_PACKAGE_VERSION) {
        updateSettingsDictionaryMeta({
            digest: runtimeState.zhVariantDictionary.digest || '',
            verifiedAt: runtimeState.zhVariantDictionary.verifiedAt,
        }, 'verified', '', settings);
        return true;
    }

    const cached = readCachedPackage();
    if (!cached || cached.status !== 'verified') return false;

    try {
        setRuntimeDictionary(cached);
        updateSettingsDictionaryMeta({
            digest: cached.digest || '',
            verifiedAt: cached.verifiedAt,
        }, 'verified', '', settings);
        return true;
    } catch (e) {
        logger.warn('增强简繁词典缓存无法加载，需要重新下载', e);
        runtimeState.zhVariantDictionary = null;
        settings.zhVariantDictionary = {
            status: 'failed',
            packageVersion: '',
            verifiedAt: 0,
            bytes: 0,
            entries: 0,
            fileCount: 0,
            digest: '',
            lastError: e?.message || '缓存无法加载',
        };
        settings.zhVariantCompatEnabled = false;
        return false;
    }
}

export function isZhDictionaryReady(settings = getSettings()) {
    if (runtimeState.zhVariantDictionary?.ready === true
        && runtimeState.zhVariantDictionary.packageVersion === ZH_DICTIONARY_PACKAGE_VERSION) {
        normalizeZhVariantSettings(settings);
        updateSettingsDictionaryMeta({
            digest: runtimeState.zhVariantDictionary.digest || '',
            verifiedAt: runtimeState.zhVariantDictionary.verifiedAt,
        }, 'verified', '', settings);
        return true;
    }
    return restoreZhDictionaryPackageFromCache(settings);
}

export function hasVerifiedZhDictionaryPackageMeta(settings = getSettings()) {
    normalizeZhVariantSettings(settings);
    if (runtimeState.zhVariantDictionary?.ready === true
        && runtimeState.zhVariantDictionary.packageVersion === ZH_DICTIONARY_PACKAGE_VERSION) {
        return true;
    }
    const meta = settings?.zhVariantDictionary || {};
    return meta.status === 'verified'
        && meta.packageVersion === ZH_DICTIONARY_PACKAGE_VERSION
        && Number(meta.bytes) === EXPECTED_TOTAL_BYTES
        && Number(meta.entries) === EXPECTED_TOTAL_ENTRIES
        && Number(meta.fileCount) === DICTIONARY_FILES.length
        && Boolean(meta.digest);
}

export function getZhDictionaryPackageStatus(settings = getSettings(), options = {}) {
    normalizeZhVariantSettings(settings);
    const shouldHydrate = options?.hydrate === true;
    const ready = shouldHydrate
        ? isZhDictionaryReady(settings)
        : hasVerifiedZhDictionaryPackageMeta(settings);
    const meta = settings?.zhVariantDictionary || {};
    return {
        ready,
        status: ready ? 'verified' : meta.status || 'missing',
        packageVersion: ready ? ZH_DICTIONARY_PACKAGE_VERSION : meta.packageVersion || '',
        bytes: EXPECTED_TOTAL_BYTES,
        entries: EXPECTED_TOTAL_ENTRIES,
        fileCount: DICTIONARY_FILES.length,
        commit: OPENCC_DICTIONARY_COMMIT,
        lastError: meta.lastError || '',
        options: getZhVariantCompatOptions(settings),
    };
}

export function getZhDictionaryPackageStats() {
    return {
        packageVersion: ZH_DICTIONARY_PACKAGE_VERSION,
        commit: OPENCC_DICTIONARY_COMMIT,
        bytes: EXPECTED_TOTAL_BYTES,
        entries: EXPECTED_TOTAL_ENTRIES,
        fileCount: DICTIONARY_FILES.length,
    };
}

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
    const dictionary = runtimeState.zhVariantDictionary;
    if (!dictionary?.ready) return [];
    const buckets = [dictionary.index.buckets.base];
    if (normalized.tw) buckets.push(dictionary.index.buckets.tw);
    if (normalized.hk) buckets.push(dictionary.index.buckets.hk);
    return buckets;
}

function getActiveGroupEntries(options = {}) {
    const normalized = normalizeZhVariantOptions(options);
    const dictionary = runtimeState.zhVariantDictionary;
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
    if (!source || !runtimeState.zhVariantDictionary?.ready) return source ? [source] : [];

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
    if (!runtimeState.zhVariantDictionary?.ready) return escapeRegExpLiteral(source);

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
    if (!source || !runtimeState.zhVariantDictionary?.ready) return value;
    const dictionary = runtimeState.zhVariantDictionary;
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

function getUtf8Bytes(value) {
    const source = String(value ?? '');
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(source);

    const bytes = [];
    for (let index = 0; index < source.length; index++) {
        let codePoint = source.charCodeAt(index);
        if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < source.length) {
            const next = source.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
                index++;
            }
        }

        if (codePoint <= 0x7f) {
            bytes.push(codePoint);
        } else if (codePoint <= 0x7ff) {
            bytes.push(
                0xc0 | (codePoint >> 6),
                0x80 | (codePoint & 0x3f)
            );
        } else if (codePoint <= 0xffff) {
            bytes.push(
                0xe0 | (codePoint >> 12),
                0x80 | ((codePoint >> 6) & 0x3f),
                0x80 | (codePoint & 0x3f)
            );
        } else {
            bytes.push(
                0xf0 | (codePoint >> 18),
                0x80 | ((codePoint >> 12) & 0x3f),
                0x80 | ((codePoint >> 6) & 0x3f),
                0x80 | (codePoint & 0x3f)
            );
        }
    }
    return new Uint8Array(bytes);
}

function rightRotate(value, bits) {
    return (value >>> bits) | (value << (32 - bits));
}

function sha256HexFallback(text) {
    const bytes = getUtf8Bytes(text);
    const bitLength = bytes.length * 8;
    const paddedLength = (((bytes.length + 9 + 63) >> 6) << 6);
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;

    const view = new DataView(padded.buffer);
    const high = Math.floor(bitLength / 0x100000000);
    const low = bitLength >>> 0;
    view.setUint32(paddedLength - 8, high, false);
    view.setUint32(paddedLength - 4, low, false);

    const k = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const hash = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    const words = new Uint32Array(64);

    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let i = 0; i < 16; i++) {
            words[i] = view.getUint32(offset + i * 4, false);
        }
        for (let i = 16; i < 64; i++) {
            const s0 = rightRotate(words[i - 15], 7) ^ rightRotate(words[i - 15], 18) ^ (words[i - 15] >>> 3);
            const s1 = rightRotate(words[i - 2], 17) ^ rightRotate(words[i - 2], 19) ^ (words[i - 2] >>> 10);
            words[i] = (words[i - 16] + s0 + words[i - 7] + s1) >>> 0;
        }

        let [a, b, c, d, e, f, g, h] = hash;

        for (let i = 0; i < 64; i++) {
            const s1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (h + s1 + ch + k[i] + words[i]) >>> 0;
            const s0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (s0 + maj) >>> 0;

            h = g;
            g = f;
            f = e;
            e = (d + temp1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temp1 + temp2) >>> 0;
        }

        hash[0] = (hash[0] + a) >>> 0;
        hash[1] = (hash[1] + b) >>> 0;
        hash[2] = (hash[2] + c) >>> 0;
        hash[3] = (hash[3] + d) >>> 0;
        hash[4] = (hash[4] + e) >>> 0;
        hash[5] = (hash[5] + f) >>> 0;
        hash[6] = (hash[6] + g) >>> 0;
        hash[7] = (hash[7] + h) >>> 0;
    }

    return hash.map((value) => value.toString(16).padStart(8, '0')).join('');
}

async function sha256Hex(text) {
    const bytes = getUtf8Bytes(text);
    const subtle = window?.crypto?.subtle;
    if (subtle?.digest) {
        const hashBuffer = await subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(hashBuffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    return sha256HexFallback(text);
}

async function packageDigestHex() {
    return sha256Hex(EXPECTED_PACKAGE_DIGEST_SOURCE);
}

async function fetchDictionaryFile(fileDef, signal, onChunkProgress = () => {}) {
    const response = await fetch(`${OPENCC_DICTIONARY_BASE_URL}/${fileDef.name}`, { cache: 'no-store', signal });
    if (!response.ok) throw new Error(`${fileDef.name} 下载失败：HTTP ${response.status}`);

    const total = Number(response.headers.get('content-length')) || fileDef.bytes;
    if (!response.body?.getReader) {
        const text = await response.text();
        onChunkProgress(1, fileDef.name);
        return text;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let received = 0;
    let text = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        text += decoder.decode(value, { stream: true });
        onChunkProgress(total > 0 ? Math.min(received / total, 1) : 0, fileDef.name);
    }
    text += decoder.decode();
    onChunkProgress(1, fileDef.name);
    return text;
}

async function verifyDownloadedFiles(files, onProgress = () => {}) {
    let verifiedEntries = 0;

    for (let index = 0; index < DICTIONARY_FILES.length; index++) {
        const fileDef = DICTIONARY_FILES[index];
        const text = files[fileDef.name];
        if (typeof text !== 'string' || text.length === 0) throw new Error(`${fileDef.name} 内容为空。`);

        const bytes = new TextEncoder().encode(text).length;
        if (bytes !== fileDef.bytes) throw new Error(`${fileDef.name} 大小异常：${bytes}/${fileDef.bytes}`);

        const hash = await sha256Hex(text);
        if (hash !== fileDef.sha256) throw new Error(`${fileDef.name} 校验失败。`);

        const entries = parseDictionaryEntries(text).length;
        if (entries !== fileDef.entries) throw new Error(`${fileDef.name} 条目异常：${entries}/${fileDef.entries}`);

        verifiedEntries += entries;
        onProgress((index + 1) / DICTIONARY_FILES.length, `正在校验词典完整性：${index + 1}/${DICTIONARY_FILES.length}`);
    }

    if (verifiedEntries !== EXPECTED_TOTAL_ENTRIES) {
        throw new Error(`词典条目合计异常：${verifiedEntries}/${EXPECTED_TOTAL_ENTRIES}`);
    }
}

export async function downloadZhDictionaryPackage(options = {}) {
    const {
        signal,
        onProgress = () => {},
    } = options;

    runtimeState.zhDictionaryInstallCancelRequested = false;
    onProgress({ ratio: 0.02, statusText: '正在连接 GitHub 词典源。' });

    const files = {};
    let completedBytes = 0;
    const downloadedFileBytes = new Map();

    for (let index = 0; index < DICTIONARY_FILES.length; index++) {
        const fileDef = DICTIONARY_FILES[index];
        const baseProgress = index / DICTIONARY_FILES.length;
        const text = await fetchDictionaryFile(fileDef, signal, (fileRatio) => {
            const previous = downloadedFileBytes.get(fileDef.name) || 0;
            const current = Math.round(fileDef.bytes * fileRatio);
            completedBytes += Math.max(0, current - previous);
            downloadedFileBytes.set(fileDef.name, current);
            const ratio = 0.05 + (0.62 * (baseProgress + fileRatio / DICTIONARY_FILES.length));
            onProgress({
                ratio,
                statusText: `正在下载增强简繁词典：${fileDef.name} (${Math.round(Math.min(completedBytes / EXPECTED_TOTAL_BYTES, 1) * 100)}%)`,
            });
        });
        files[fileDef.name] = text;
    }

    onProgress({ ratio: 0.72, statusText: '下载完成，正在校验文件完整性。' });
    await verifyDownloadedFiles(files, (ratio, statusText) => {
        onProgress({ ratio: 0.72 + ratio * 0.13, statusText });
    });

    onProgress({ ratio: 0.88, statusText: '完整性通过，正在建立匹配索引。' });
    const digest = await packageDigestHex();
    const packagePayload = {
        status: 'verified',
        packageVersion: ZH_DICTIONARY_PACKAGE_VERSION,
        commit: OPENCC_DICTIONARY_COMMIT,
        verifiedAt: Date.now(),
        bytes: EXPECTED_TOTAL_BYTES,
        entries: EXPECTED_TOTAL_ENTRIES,
        fileCount: DICTIONARY_FILES.length,
        digest,
        files,
    };

    setRuntimeDictionary(packagePayload);
    onProgress({ ratio: 0.94, statusText: '正在写入本地缓存。' });
    writeCachedPackage(packagePayload);
    updateSettingsDictionaryMeta({ digest, verifiedAt: packagePayload.verifiedAt }, 'verified');
    onProgress({ ratio: 1, statusText: '增强简繁词典已验证并启用。' });

    return {
        packageVersion: ZH_DICTIONARY_PACKAGE_VERSION,
        commit: OPENCC_DICTIONARY_COMMIT,
        bytes: EXPECTED_TOTAL_BYTES,
        entries: EXPECTED_TOTAL_ENTRIES,
        fileCount: DICTIONARY_FILES.length,
        digest,
    };
}

export function markZhDictionaryInstallFailed(error) {
    const message = error?.name === 'AbortError'
        ? '用户取消下载'
        : String(error?.message || error || '下载失败');
    updateSettingsDictionaryMeta(null, 'failed', message);
    runtimeState.zhVariantDictionary = null;
    return message;
}
