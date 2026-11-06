import { splitTextRangeIntoSentences } from '../text/sentences.js';
import { protectedRanges } from './boundaryDialogue.js';

// This is a bounded textual copy check, not semantic deduplication. Only an
// appended clause/tail of a one-sentence target can be removed; source text never is.
const view = text => text.replace(/[\p{P}\p{Z}\s的]/gu, '');
const repeated = /又|再|反复|第二|第三|依次|轮流|分别|各自|接连|一遍遍/u;
const sentences = text => splitTextRangeIntoSentences(text, { start: 0, end: text.length })
    .filter(span => text.slice(span.start, span.end).trim());
const sharesRun = (a, b, length) => {
    for (let i = 0; i <= a.length - length; i++) if (b.includes(a.slice(i, i + length))) return true;
    return false;
};

function trimAppendedContrast(source, replacement, replacements, original, rewritten) {
    const copied = rewritten.match(/[，,]而是([^。！？!?\r\n]+)([。！？!?])$/u);
    if (!copied || protectedRanges(rewritten).length) return rewritten;
    const kept = rewritten.slice(0, copied.index);
    const originalBody = original.slice(0, -1);
    // Accept an unchanged negative clause or the explicit A/also-not-B -> A-or-B
    // contraction. Do not infer equivalence from shared words or drop negation.
    const negative = originalBody.match(/^(.*?(?:不再是|不是))([^，,；;。！？!?或]+)[，,]也不是([^，,；;。！？!?或]+)$/u);
    if (kept !== originalBody && (!negative || kept !== negative[1] + negative[2] + '或' + negative[3])) return rewritten;
    if (!/(?:不再是|不是)/u.test(kept)) return rewritten;
    const following = source.slice(replacement.end, replacement.end + 1000);
    const anchor = following.match(/^\s*(?:那|这|它)是([^。！？!?\r\n]+)([。！？!?])/u);
    if (!anchor || protectedRanges(anchor[0]).length) return rewritten;
    const key = text => text.replace(/[ \t，,]/gu, '');
    if (key(copied[1]).length < 6 || key(copied[1]) !== key(anchor[1]) || copied[2] !== anchor[2]) return rewritten;
    const end = replacement.end + anchor[0].length;
    if (replacements.some(other => other !== replacement && other.start < end && other.end > replacement.end
        && String(other.rewritten ?? '') !== source.slice(other.start, other.end))) return rewritten;
    return kept + original.slice(-1);
}

function trimAppendedFollowingClauses(source, replacement, replacements, original, rewritten) {
    if (sentences(rewritten).length !== 1 || protectedRanges(rewritten).length) return rewritten;
    const following = source.slice(replacement.end, replacement.end + 1000);
    const match = following.match(/^\s*([^。！？!?<>`\r\n]+)[。！？!?]/u);
    if (!match || protectedRanges(match[0]).length) return rewritten;
    if (replacements.some(other => other !== replacement && other.start < replacement.end + match[0].length
        && other.end > replacement.end && String(other.rewritten ?? '') !== source.slice(other.start, other.end))) return rewritten;
    // Match whole leading clauses, not arbitrary substrings or semantic similarity.
    // The adjacent subject may be omitted when the model joins it with a comma.
    const clauses = match[1].split(/[，,]/u);
    for (let count = 2; count <= clauses.length; count++) {
        const anchor = clauses.slice(0, count).join('，');
        for (const copied of [anchor, anchor.replace(/^[他她它]/u, '')]) {
            const key = view(copied);
            if (key.length < 16 || sharesRun(key, view(original), 6)) continue;
            for (const comma of rewritten.matchAll(/[，,]/gu)) {
                const kept = rewritten.slice(0, comma.index);
                const tail = rewritten.slice(comma.index + 1);
                if (view(tail) !== key || !sharesRun(view(kept), view(original), 8)) continue;
                // No source ranges are removed: the original neighboring sentence stays intact.
                return kept + original.slice(-1);
            }
        }
    }
    return rewritten;
}

export function trimAdjacentContinuation(source, replacement, replacements) {
    const original = source.slice(replacement.start, replacement.end).trim();
    const rewritten = String(replacement.rewritten ?? '');
    if (!/[。！？!?]$/u.test(original) || original.length > 800 || rewritten.length > 1600
        || sentences(original).length !== 1 || protectedRanges(original).length || repeated.test(original.replace(/不再/gu, ''))) return rewritten;
    const contrast = trimAppendedContrast(source, replacement, replacements, original, rewritten);
    if (contrast !== rewritten) return contrast;
    const clauses = trimAppendedFollowingClauses(source, replacement, replacements, original, rewritten);
    if (clauses !== rewritten) return clauses;
    const spans = sentences(rewritten);
    if (spans.length < 2) return rewritten;
    const split = spans[0].end;
    const kept = rewritten.slice(0, split);
    const tail = rewritten.slice(split).trim();
    if (!/[。！？!?]$/u.test(kept) || protectedRanges(kept).length || !tail) return rewritten;

    // Do not cross a paragraph, a tag/code boundary, or another changing target.
    const following = source.slice(replacement.end, replacement.end + 1800);
    const paragraph = following.split(/\r?\n\s*\r?\n|[<>`]/u)[0];
    const contextSpans = sentences(paragraph).slice(0, 2);
    for (const span of contextSpans) {
        const context = paragraph.slice(0, span.end).trim();
        const contextEnd = replacement.end + span.end;
        if (replacements.some(other => other !== replacement && other.start < contextEnd
            && other.end > replacement.end && String(other.rewritten ?? '') !== source.slice(other.start, other.end))) break;
        // A partial quote is not a usable anchor. Whole adjacent speech can be
        // copied with its preceding narration, but is never rewritten here.
        const ranges = protectedRanges(paragraph);
        if (ranges.some(range => range.start < span.end && range.end > span.end)) continue;
        const candidate = view(tail), anchor = view(context), target = view(original);
        if (candidate.length < 24 || candidate.length > anchor.length
            || !anchor.startsWith(candidate.slice(0, 6)) || !anchor.endsWith(candidate.slice(-2))
            || candidate.length / anchor.length < 0.6 || !sharesRun(candidate, anchor, 10)
            || sharesRun(candidate, target, 6) || !sharesRun(view(kept), target, 8)) continue;
        // Allow omissions and punctuation/的 changes only. A new noun, number,
        // direction or other inserted character makes the copy unproven.
        let cursor = 0;
        for (const char of anchor) if (char === candidate[cursor]) cursor++;
        if (cursor !== candidate.length) continue;
        // Digit runs must not turn, for example, 12 into 2 by omission.
        if (JSON.stringify(candidate.match(/\d+/gu)) !== JSON.stringify(anchor.match(/\d+/gu))) continue;
        return kept;
    }
    return rewritten;
}
