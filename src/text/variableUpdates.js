// Variable processor payloads are message data, never AI prose or review text.
const variableUpdatePattern = /<UpdateVariable\b[^>]*>[\s\S]*?<\/UpdateVariable\s*>/gi;

export function collectVariableUpdateRanges(text) {
    return [...String(text ?? '').matchAll(variableUpdatePattern)]
        .map(match => ({ start: match.index, end: match.index + match[0].length }));
}

export function omitVariableUpdates(text) {
    return String(text ?? '').replace(variableUpdatePattern, '');
}
