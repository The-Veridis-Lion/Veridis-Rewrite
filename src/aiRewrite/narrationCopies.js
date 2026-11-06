import { splitTextRangeIntoSentences } from '../text/sentences.js';
import { protectedRanges } from './boundaryDialogue.js';
import { trimAdjacentContinuation } from './adjacentContinuation.js';

const terminator = /[。！？!?]|(?<!\.)\.(?!\.)/u;
const completeSentence = /(?:[。！？!?]+|(?<!\.)\.)$/u;
const repeatCue = /又|再|反复|第二|第三|依次|轮流|分别|各自|接连|一遍遍/u;
const closedTerm = /^(?:“[^“”]*”|‘[^‘’]*’|「[^「」]*」|『[^『』]*』|«[^«»]*»|‹[^‹›]*›|〝[^〝〞]*〞|＂[^＂]*＂|＇[^＇]*＇|"[^"\r\n]*"|'[^'\r\n]*')$/u;

function narrationRange(text, ranges, start, end) {
    return !ranges.some(range => {
        if (range.start >= end || range.end <= start) return false;
        const token = text.slice(range.start, range.end);
        // A whole quoted term may occur in narration; speech, code and markup stay protected.
        return range.start < start || range.end > end || !closedTerm.test(token)
            || terminator.test(token.slice(1, -1));
    });
}

function sentenceSpans(text) {
    return splitTextRangeIntoSentences(text, { start: 0, end: text.length }).map(range => {
        const raw = text.slice(range.start, range.end);
        const start = range.start + raw.length - raw.trimStart().length;
        const value = raw.trim();
        return { start, end: start + value.length, text: value };
    }).filter(range => range.text);
}

function copyView(text, ranges = protectedRanges(text)) {
    let key = '', rangeIndex = 0;
    const positions = [];
    for (let index = 0; index < text.length; index++) {
        while (rangeIndex < ranges.length && ranges[rangeIndex].end <= index) rangeIndex++;
        const protectedHere = ranges[rangeIndex]?.start <= index;
        // Only formatting and the optional 地 of these adverbs are ignored; quoted payloads stay literal.
        if (!protectedHere && (/[\s，,、]/u.test(text[index])
            || text[index] === '地' && /^(?:狠狠|紧紧|轻轻|慢慢|缓缓|悄悄|重重|深深|静静|默默|牢牢|稳稳|细细)$/u.test(text.slice(index - 2, index))
                && /[\u4e00-\u9fff]/u.test(text[index + 1] || ''))) continue;
        key += text[index];
        positions.push(index);
    }
    return { key, positions };
}

function occurrences(text, view, value, ranges) {
    let count = 0;
    for (let index = view.key.indexOf(value); index !== -1; index = view.key.indexOf(value, index + value.length)) {
        if (narrationRange(text, ranges, view.positions[index], view.positions[index + value.length - 1] + 1)) count++;
    }
    return count;
}

export function trimAddedNarrationCopies(sourceText, replacements) {
    const source = String(sourceText ?? '');
    const sourceRanges = protectedRanges(source);
    const sourceView = copyView(source, sourceRanges);
    let removedCount = 0;
    const repaired = replacements.map(replacement => {
        const original = source.slice(replacement.start, replacement.end);
        let rewritten = String(replacement.rewritten ?? '');
        if (!original.trim() || !rewritten.trim()
            || !narrationRange(source, sourceRanges, replacement.start, replacement.end)) return replacement;
        const bounded = trimAdjacentContinuation(source, replacement, replacements);
        let trimmed = bounded !== rewritten;
        if (trimmed) {
            rewritten = bounded;
            removedCount++;
        }
        if (repeatCue.test(original)) return trimmed
            ? { ...replacement, rewritten, strategy: 'added-narration-copy-trimmed' } : replacement;
        while (true) {
            const output = source.slice(0, replacement.start) + rewritten + source.slice(replacement.end);
            const ranges = protectedRanges(output);
            const outputView = copyView(output, ranges);
            const spans = sentenceSpans(output);
            const generatedEnd = replacement.start + rewritten.length;
            const generated = range => range.start >= replacement.start && range.end <= generatedEnd;
            const stableAnchor = range => {
                const before = { start: range.start, end: Math.min(range.end, replacement.start) };
                const delta = rewritten.length - (replacement.end - replacement.start);
                const after = { start: Math.max(range.start, generatedEnd) - delta, end: range.end - delta };
                return [before, after].every(part => part.start >= part.end || !replacements.some(other =>
                    other !== replacement && other.start < part.end && part.start < other.end
                    && String(other.rewritten ?? '') !== source.slice(other.start, other.end)));
            };
            let removal = null;
            for (let index = spans.length - 1; index > 0; index--) {
                const previous = spans[index - 1], current = spans[index];
                const value = current.text;
                const previousView = copyView(previous.text), currentView = copyView(value);
                const exact = previous.text.endsWith(value);
                if (!completeSentence.test(value) || !previousView.key.endsWith(currentView.key)
                    || output.slice(previous.end, current.start).trim()
                    || (value.match(/[\p{L}\p{N}]/gu) || []).length < (exact ? 3 : 16)
                    || !narrationRange(output, ranges, previous.start, previous.end)
                    || !narrationRange(output, ranges, current.start, current.end)) continue;
                const suffixStart = previous.start + previousView.positions[previousView.key.length - currentView.key.length];
                const wholeCopy = previousView.key === currentView.key;
                if (!wholeCopy
                    && (value.length < 12 || !/[，,；;：:“‘「『«‹〝＂＇"'”’」』]/u.test(output[suffixStart - 1] || '')
                        && !/[“‘「『«‹〝＂＇"']/u.test(value[0]))) continue;
                const sourceCount = occurrences(source, sourceView, currentView.key, sourceRanges);
                if (!sourceCount || occurrences(output, outputView, currentView.key, ranges) <= sourceCount) continue;
                if (generated(current) && stableAnchor({ start: suffixStart, end: previous.end })) removal = current;
                else if (wholeCopy && generated(previous) && stableAnchor(current)) removal = previous;
                if (removal) break;
            }
            if (!removal) break;
            const start = removal.start - replacement.start, end = removal.end - replacement.start;
            const remaining = rewritten.slice(0, start) + rewritten.slice(end);
            if (!remaining.trim()) break;
            rewritten = remaining;
            removedCount++;
            trimmed = true;
        }
        return trimmed ? { ...replacement, rewritten, strategy: 'added-narration-copy-trimmed' } : replacement;
    });
    return { replacements: repaired, removedCount };
}
