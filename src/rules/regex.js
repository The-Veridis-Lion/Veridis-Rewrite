// Regex parsing/validation semantics.

const SIMPLE_WILDCARD_STOP_CHARS = ",，。.!?！？；;\n";
const REGEX_LITERAL_ALLOWED_FLAGS = new Set(['d', 'g', 'i', 'm', 's', 'u', 'v', 'y']);

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
        if (!REGEX_LITERAL_ALLOWED_FLAGS.has(flag)) return { ok: false, error: { message: `包含不支持的 flags：${flag}` } };
        if (seen.has(flag)) return { ok: false, error: { message: `包含重复的 flags：${flag}` } };
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
        if (lastSlash <= 0) return { ok: false, error: { message: '不是合法的 /pattern/flags 格式。' } };
        pattern = source.slice(1, lastSlash);
        const normalized = normalizeRegexLiteralFlags(source.slice(lastSlash + 1));
        if (!normalized.ok) return normalized;
        flags = normalized.flags;
    }
    try {
        const regex = new RegExp(pattern, flags);
        const matchesEmptyString = regex.test('');
        regex.lastIndex = 0;
        if (matchesEmptyString) return { ok: false, error: { message: '会匹配空字符串，存在风险，请改写规则。' } };
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
        if (!compiled.ok) return { ok: false, error: { line: i + 1, input: lineText, message: compiled.error.message } };
        parsed.push({ line: i + 1, ...compiled.value });
    }
    return { ok: true, parsed };
}

export function buildSimpleWildcardPattern() {
    const escapedStops = SIMPLE_WILDCARD_STOP_CHARS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return `[^${escapedStops}]{0,15}?`;
}
