import { normalizeStringList } from './planning.js';

export function stripSingleJsonFence(value) {
    const trimmed = String(value || '').trim();
    const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

const cotThinkingBlockRegex = /<\s*think(?:ing)?\b[^>]*>[\s\S]*?<\s*\/\s*think(?:ing)?\s*>/giu;
const cotThinkingOpenTailRegex = /<\s*think(?:ing)?\b[^>]*>[\s\S]*$/iu;
const cotThinkingTagRegex = /<\s*\/?\s*think(?:ing)?\b[^>]*>/giu;
const cotThinkingMarkerRegex = /<\s*\/?\s*think(?:ing)?\b/i;

export function stripCotThinkingContent(value) {
    return String(value || '')
        .replace(cotThinkingBlockRegex, '')
        .replace(cotThinkingOpenTailRegex, '')
        .replace(cotThinkingTagRegex, '');
}

export function hasCotThinkingMarker(value) {
    return cotThinkingMarkerRegex.test(String(value || ''));
}

function getBoundaryProbe(value = '', edge = 'end') {
    const compact = String(value || '').replace(/\s+/g, ' ').trim();
    if (compact.length < 6) return '';
    return edge === 'start' ? compact.slice(0, 12) : compact.slice(-12);
}

export function getItemRewriteLengthLimit(item, absoluteLimit) {
    const sourceLength = String(item?.text || '').length;
    const fallbackLength = normalizeStringList(item?.localFallbackCandidates)
        .reduce((max, value) => Math.max(max, value.length), 0);
    const localLimit = Math.max(sourceLength + 8, Math.ceil(sourceLength * 3), fallbackLength);
    return Math.min(absoluteLimit, localLimit);
}

export function countSentenceBoundaries(value = '') {
    return (String(value || '').match(/[。！？!?\r\n]/gu) || []).length;
}

export function getRewrittenBoundaryIssue(rewritten, item) {
    if (!rewritten) return '';
    const beforeProbe = getBoundaryProbe(item?.beforeAnchor, 'end');
    if (beforeProbe && rewritten.includes(beforeProbe)) return 'copied-before-context';
    const afterProbe = getBoundaryProbe(item?.afterAnchor, 'start');
    if (afterProbe && rewritten.includes(afterProbe)) return 'copied-after-context';
    return '';
}

export class AiRewriteResponseFormatError extends Error {
    constructor(message, cause = null) {
        super(message);
        this.name = 'AiRewriteResponseFormatError';
        if (cause) this.cause = cause;
    }
}

export function isAiRewriteResponseFormatError(error) {
    return error instanceof AiRewriteResponseFormatError
        || error?.name === 'AiRewriteResponseFormatError';
}
