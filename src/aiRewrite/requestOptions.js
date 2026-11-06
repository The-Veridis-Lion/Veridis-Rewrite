// Provider fields are kept separate from the host's routing envelope.
import { getAppContext } from '../host/appContext.js';

function parseStructuredParameters(raw, label) {
    try { return JSON.parse(raw); }
    catch {
        const parseYaml = getAppContext().parseYaml;
        if (typeof parseYaml !== 'function') throw new Error(`${label}不是有效的 JSON；当前宿主未提供 YAML 解析器`);
        try { return parseYaml(raw); }
        catch { throw new Error(`${label}必须是有效的 YAML 或 JSON，请检查缩进、引号和格式`); }
    }
}

export function parseAiRequestOptions(settings = {}) {
    let additional = {};
    const raw = String(settings.additionalParameters || '').trim();
    if (raw) {
        additional = parseStructuredParameters(raw, '包括主体参数');
        if (!additional || typeof additional !== 'object' || Array.isArray(additional)) {
            throw new Error('包括主体参数必须是 YAML 或 JSON 对象，不能是数组、字符串或 null');
        }
        const visiting = new WeakSet();
        const checked = new WeakSet();
        const checkKeys = (value) => {
            if (!value || typeof value !== 'object') return;
            if (visiting.has(value)) throw new Error('包括主体参数不能包含循环引用');
            if (checked.has(value)) return;
            visiting.add(value);
            for (const [key, child] of Object.entries(value)) {
                if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('附加参数含不支持的对象属性名');
                checkKeys(child);
            }
            visiting.delete(value);
            checked.add(value);
        };
        checkKeys(additional);
    }
    const excludedRaw = String(settings.excludedParameters || '').trim();
    let fields = [];
    if (/^[\[\{#]|^---(?:\s|$)|^-\s/u.test(excludedRaw)) {
        fields = parseStructuredParameters(excludedRaw, '排除主体参数');
        if (!Array.isArray(fields) || fields.some(field => typeof field !== 'string' || !field.trim())) {
            throw new Error('排除主体参数必须是参数名组成的 YAML 或 JSON 数组');
        }
        fields = fields.map(field => field.trim());
    } else fields = excludedRaw.split(/[\s,，]+/u).filter(Boolean);
    const excluded = [...new Set(fields)];
    // Exclusion wins when a field is present in both controls.
    for (const field of excluded) delete additional[field];
    const streaming = settings.streamingEnabled === true;
    if (Object.hasOwn(additional, 'stream') && additional.stream !== streaming) {
        throw new Error('附加参数 stream 必须与“流式返回”开关一致；也可以移除此参数，直接使用开关');
    }
    if (streaming && excluded.includes('stream')) throw new Error('启用“流式返回”时不能排除 stream 参数');
    return { additional, excluded };
}
