import { trimAnchoredCompletion, projectExternalReason } from './boundaryCompletion.js';
const directQuote = String.raw`(?:“[^“”]*”|‘[^‘’]*’|「[^「」]*」|『[^『』]*』|«[^«»]*»|‹[^‹›]*›|〝[^〝〞]*〞|＂[^＂]*＂|＇[^＇]*＇|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')`;
const leadingQuote = new RegExp('^\\s*(' + directQuote + ')', 'u');
const trailingQuote = new RegExp('(' + directQuote + ')\\s*$', 'u');
const trailingQuoteWithStop = new RegExp('(' + directQuote + ')([\\p{L}]{0,13}[，,。！？!?]+)\\s*$', 'u');
const quoteKey = value => value.replace(/\s|…|\.{3,}/gu, '');

function trimCopiedLeadingContext(source, replacement, replacements, rewritten) {
    const prefix = rewritten.match(new RegExp('^([\\p{L}]{0,24})(' + directQuote + '(?:[和与、]' + directQuote + ')*)', 'u'));
    if (!prefix || !/[\p{L}]/u.test(rewritten.slice(prefix[0].length))) return rewritten;
    const quotes = [...prefix[2].matchAll(new RegExp(directQuote, 'gu'))];
    if (quotes.some(q => !/^[\p{L}\p{N}]{1,12}$/u.test(q[0].slice(1,-1)))) return rewritten;
    // A bare single quote is handled separately, including its noun-link protection.
    if (!prefix[1] && quotes.length < 2) return rewritten;
    const before = source.slice(0, replacement.start);
    const anchor = before.match(new RegExp('(' + (prefix[1] ? '[\\p{L}，,]{1,26}' : '') + directQuote + '(?:[和与、]' + directQuote + ')*)\\s*$', 'u'));
    if (!anchor || anchor[1].replace(/[，,]/gu,'') !== prefix[0]) return rewritten;
    const start = anchor.index;
    if (replacements.some(other => other !== replacement && other.start < replacement.start && other.end > start
        && String(other.rewritten ?? '') !== source.slice(other.start,other.end))) return rewritten;
    return rewritten.slice(prefix[0].length);
}

function trimSubjectAcrossSound(source, replacement, replacements, ranges, rewritten) {
    const original = source.slice(replacement.start, replacement.end);
    const action = original.match(/^一声([^，,。！？!?；;\r\n]{4,40})(?=[，,。！？!?；;])/u)?.[1];
    if (!action) return rewritten;
    const position = rewritten.indexOf(action);
    const subject = rewritten.slice(0, position);
    if (position < 2 || !/^[\p{L}]{2,12}$/u.test(subject)) return rewritten;
    const before = source.slice(0, replacement.start), quote = before.match(trailingQuote);
    if (!quote || !/^[\p{L}]{1,8}$/u.test(quote[1].slice(1, -1))) return rewritten;
    const quoteStart = quote.index + quote[0].indexOf(quote[1]);
    const left = before.slice(0, quoteStart).trimEnd();
    if (!left.endsWith(subject) || !ranges.some(range => range.start === quoteStart && range.end === quoteStart + quote[1].length)) return rewritten;
    const anchorStart = left.length - subject.length;
    if (ranges.some(range => range.start < left.length && range.end > anchorStart)
        || replacements.some(other => other !== replacement && other.start < replacement.start && other.end > anchorStart
            && String(other.rewritten ?? '') !== source.slice(other.start, other.end))) return rewritten;
    // Only the added subject is removed; the original action prefix must still be exact.
    return rewritten.slice(position);
}

function trimCompletedQuotedTerm(source, replacement, replacements, ranges) {
    const original = source.slice(replacement.start, replacement.end);
    const rewritten = String(replacement.rewritten ?? '');
    // A naming fragment can end before a protected term, not before speech.
    // Only trim a proven copied noun + speech tail; never edit the retained source.
    if (!/(?:称之为|称为|叫作|叫做)$/u.test(original)) return rewritten;
    const following = source.slice(replacement.end, replacement.end + 800);
    const term = following.match(leadingQuote);
    if (!term || term.index !== 0 || !/^[\p{L}\p{N}]{1,12}$/u.test(term[1].slice(1, -1))) return rewritten;
    const bridge = following.slice(term[0].length).match(/^的([\p{L}]{2,12})[，,]/u);
    if (!bridge) return rewritten;
    const speechOffset = term[0].length + bridge[0].length;
    const speech = following.slice(speechOffset).match(leadingQuote);
    if (!speech || !/[。！？!?]/u.test(speech[1])) return rewritten;
    const end = replacement.end + speechOffset + speech[0].length;
    if (replacements.some(other => other !== replacement && other.start < end
        && other.end > replacement.end && String(other.rewritten ?? '') !== source.slice(other.start, other.end))) return rewritten;
    const termStart = replacement.end + term[0].indexOf(term[1]);
    const speechStart = replacement.end + speechOffset + speech[0].indexOf(speech[1]);
    if (![ [termStart, term[1]], [speechStart, speech[1]] ].every(([start, quote]) =>
        ranges.some(range => range.start === start && range.end === start + quote.length))) return rewritten;
    const copy = rewritten.match(trailingQuote);
    if (!copy || quoteKey(copy[1]) !== quoteKey(speech[1])) return rewritten;
    const beforeCopy = rewritten.slice(0, copy.index);
    const noun = bridge[1];
    const suffix = beforeCopy.match(/[，,]\s*$/u);
    if (!suffix || !beforeCopy.slice(0, suffix.index).endsWith(noun)) return rewritten;
    const kept = beforeCopy.slice(0, suffix.index - noun.length);
    // A new clause, quote, or missing narration makes the splice uncertain.
    if (!/[\p{L}\p{N}]$/u.test(kept) || /[。！？!?，,；;：:<>`]/u.test(kept)
        || protectedRanges(kept).length || original.includes(noun)) return rewritten;
    return kept;
}

export function protectedRanges(text) {
    // An enclosing quote, tag, comment or code block must not be mistaken for adjacent speech.
    const pattern = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\r\n]*(?:`|(?=\r?\n|$))|"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|“[^”]*(?:”|$)|‘[^’]*(?:’|$)|「[^」]*(?:」|$)|『[^』]*(?:』|$)|«[^»]*(?:»|$)|‹[^›]*(?:›|$)|〝[^〞]*(?:〞|$)|＂[^＂]*(?:＂|$)|＇[^＇]*(?:＇|$)|<!--[\s\S]*?(?:-->|$)|<[^>]*>/gu;
    return [...text.matchAll(pattern)].map(match => ({ start: match.index, end: match.index + match[0].length }));
}

export function trimCopiedBoundaryDialogue(sourceText, replacements) {
    const source = String(sourceText ?? '');
    const ranges = protectedRanges(source);
    let removedCount = 0;
    const repaired = replacements.map(replacement => {
        const original = source.slice(replacement.start, replacement.end);
        let rewritten = String(replacement.rewritten ?? '');
        // Only generated copies around an originally unquoted narration target can be removed.
        if (!original.trim() || /[“”‘’「」『』"'`<>«»‹›〝〞＂＇]/u.test(original)
            || ranges.some(range => range.start < replacement.end && replacement.start < range.end)) return replacement;
        const reasonProjection = projectExternalReason(source, replacement, replacements);
        const projected = reasonProjection !== rewritten ? reasonProjection
            : trimAnchoredCompletion(source, replacement, replacements);
        if (projected !== rewritten) {
            removedCount++;
            return { ...replacement, rewritten: projected, strategy: 'boundary-dialogue-trimmed' };
        }
        // A quoted response can be the subject of the following predicate fragment.
        // Clearing that fragment leaves only “那一声…的‘…’”, not a complete sentence.
        if (!rewritten.trim() && /^[，,]/u.test(original) && /[。！？!?]\s*$/u.test(original)) {
            const before = source.slice(0, replacement.start), quote = before.match(trailingQuote);
            if (quote) {
                const quoteStart = quote.index + quote[0].indexOf(quote[1]);
                const nominal = before.slice(0, quoteStart).match(/(?:^|[。！？!?\n])\s*((?:那|这)?一声[^。！？!?，,\n]{0,30}的)\s*$/u);
                if (nominal && ranges.some(range => range.start === quoteStart && range.end === quoteStart + quote[1].length)
                    && !replacements.some(other => other !== replacement && other.start < replacement.start && other.end > quoteStart
                        && String(other.rewritten ?? '') !== source.slice(other.start, other.end)))
                    return { ...replacement, rewritten: original, strategy: 'boundary-dialogue-rejected' };
            }
        }
        // A naming fragment must not absorb the retained term by removing its quotes.
        // Reject for bounded correction; cutting a paraphrase cannot preserve syntax reliably.
        if (/(?:名为|称之为|称为|叫作|叫做)\s*$/u.test(original)) {
            const following = source.slice(replacement.end), quote = following.match(leadingQuote);
            const term = quote?.[1].slice(1, -1);
            if (term && /^[\p{L}\p{N}]{2,12}$/u.test(term) && !original.includes(term)
                && rewritten.includes(term) && !protectedRanges(rewritten).some(range => rewritten.slice(range.start, range.end).includes(term))) {
                const start = replacement.end + quote[0].indexOf(quote[1]);
                const end = start + quote[1].length;
                if (ranges.some(range => range.start === start && range.end === end)
                    && !replacements.some(other => other !== replacement && other.start < end && other.end > replacement.end
                        && String(other.rewritten ?? '') !== source.slice(other.start, other.end)))
                    return { ...replacement, rewritten: original, strategy: 'boundary-dialogue-rejected' };
            }
        }
        const leadingTrimmed = trimCopiedLeadingContext(source, replacement, replacements, rewritten);
        const subjectTrimmed = leadingTrimmed !== rewritten ? leadingTrimmed
            : trimSubjectAcrossSound(source, replacement, replacements, ranges, rewritten);
        const completed = subjectTrimmed !== rewritten ? subjectTrimmed
            : trimCompletedQuotedTerm(source, replacement, replacements, ranges);
        let trimmed = completed !== rewritten;
        if (trimmed) { rewritten = completed; removedCount++; }
        const neighbors = [];
        for (const before of [true, false]) {
            const context = before ? source.slice(0, replacement.start) : source.slice(replacement.end);
            const neighbor = context.match(before ? trailingQuote : leadingQuote);
            if (!neighbor || !quoteKey(neighbor[1].slice(1, -1))) continue;
            const start = (before ? 0 : replacement.end) + neighbor.index + neighbor[0].indexOf(neighbor[1]);
            const end = start + neighbor[1].length;
            if (!ranges.some(range => range.start === start && range.end === end)
                || replacements.some(other => other.start < end && start < other.end
                    && String(other.rewritten ?? '') !== source.slice(other.start, other.end))) continue;
            neighbors.push(quoteKey(neighbor[1]));
        }
        // A retained short quote may begin a whole action clause, not just a noun.
        // Compare the complete terminal tail, allowing comma/space changes only.
        if (!/[，,。！？!?；;：:]\s*$/u.test(original)) {
            const following = source.slice(replacement.end);
            const anchor = following.match(leadingQuote);
            if (anchor && /^[\p{L}\p{N}]{1,12}$/u.test(anchor[1].slice(1, -1)) && neighbors.includes(quoteKey(anchor[1]))) {
                const tail = following.slice(anchor[0].length).match(/^[^。！？!?\r\n“”"<>`]{1,200}[。！？!?]/u);
                if (tail) {
                    const end = replacement.end + anchor[0].length + tail[0].length;
                    const normalize = value => value.replace(/[，,\s]/gu, '');
                    const copyStart = rewritten.lastIndexOf(anchor[1]);
                    const kept = rewritten.slice(0, copyStart);
                    if (copyStart > 0 && protectedRanges(rewritten).some(range => range.start === copyStart && range.end === copyStart + anchor[1].length)
                        && /[\p{L}\p{N}]$/u.test(kept)
                        && normalize(rewritten.slice(copyStart)) === normalize(anchor[1] + tail[0])
                        && !replacements.some(other => other !== replacement && other.start < end && other.end > replacement.end
                            && String(other.rewritten ?? '') !== source.slice(other.start, other.end))) {
                        rewritten = kept;
                        removedCount++;
                        trimmed = true;
                    }
                }
            }
        }
        // A nominal subject immediately before the retained quote can be copied
        // together with it. Remove only an exact, unchanged source prefix.
        const preceding = source.slice(0, replacement.start);
        const previousQuote = preceding.match(trailingQuote);
        if (previousQuote && neighbors.includes(quoteKey(previousQuote[1]))) {
            const quoteStart = previousQuote.index + previousQuote[0].indexOf(previousQuote[1]);
            const nominal = preceding.slice(0, quoteStart).match(/(?:^|[。！？!?\n])\s*((?:那|这)句(?:[^。！？!?，,；;：:\n“”「」"]{1,80}的)?)\s*$/u);
            if (nominal) {
                const start = nominal.index + nominal[0].indexOf(nominal[1]);
                const copied = source.slice(start, replacement.start);
                const remainder = rewritten.startsWith(copied) ? rewritten.slice(copied.length) : '';
                if (rewritten.startsWith(copied) && !/[\p{L}\p{N}]/u.test(remainder)) {
                    return { ...replacement, rewritten: original, strategy: 'boundary-dialogue-rejected' };
                }
                if (/[\p{L}\p{N}]/u.test(remainder)
                    && !replacements.some(other => other !== replacement && other.start < replacement.start && other.end > start
                        && String(other.rewritten ?? '') !== source.slice(other.start, other.end))) {
                    rewritten = remainder;
                    removedCount++;
                    trimmed = true;
                }
            }
        }
        // An unfinished final clause can acquire a paraphrased object from the
        // retained quote. Require the same clause anchor and a shared term stem;
        // the preserved clause anchor fixes the splice without another request.
        const openClause = original.match(/[，,]([^，,。！？!?；;\n]{2,8})$/u)?.[1];
        const nextTerm = source.slice(replacement.end).match(leadingQuote)?.[1];
        if (openClause && nextTerm && neighbors.includes(quoteKey(nextTerm))) {
            const term = nextTerm.slice(1, -1);
            const lastComma = Math.max(rewritten.lastIndexOf('，'), rewritten.lastIndexOf(','));
            const lastClause = rewritten.slice(lastComma + 1);
            const added = lastClause.startsWith(openClause) ? lastClause.slice(openClause.length) : '';
            if (/^[\p{L}]{3,12}$/u.test(term) && added.startsWith(term.slice(0, 2))
                && /^[\p{L}]{3,16}[。！？!?]$/u.test(added)) {
                removedCount++;
                return { ...replacement, rewritten: rewritten.slice(0, rewritten.length - added.length), strategy: 'boundary-dialogue-trimmed' };
            }
        }
        // A model may copy either adjacent quote to either end of a narration target.
        for (const isStart of [true, false]) {
            while (true) {
                let copy = rewritten.match(isStart ? leadingQuote : trailingQuote);
                // A copied protected term may include a noun and terminal punctuation.
                // Accept only that exact retained suffix, never a new generated continuation.
                if (!copy && !isStart && !/[，,。.!！?？；;：:]\s*$/u.test(original)) {
                    const punctuated = rewritten.match(trailingQuoteWithStop);
                    if (punctuated) {
                        const following = source.slice(replacement.end);
                        const anchor = following.match(leadingQuote);
                        const stop = punctuated[2];
                        const suffix = following.slice(anchor?.[0].length || 0);
                        // A short quoted modifier may lose its linking 的 in the copy.
                        // Match the whole retained suffix, not an arbitrary similar noun.
                        const omittedLink = anchor && /^[\p{L}\p{N}]{1,12}$/u.test(anchor[1].slice(1, -1))
                            && /^[\p{L}]{1,12}[，,。！？!?]+$/u.test(stop)
                            && !stop.startsWith('的') && suffix.startsWith('的' + stop);
                        const end = replacement.end + (anchor?.[0].length || 0) + stop.length + (omittedLink ? 1 : 0);
                        if (anchor && quoteKey(anchor[1]) === quoteKey(punctuated[1])
                            && (suffix.startsWith(stop) || omittedLink)
                            && !replacements.some(other => other !== replacement && other.start < end
                                && other.end > replacement.end && String(other.rewritten ?? '') !== source.slice(other.start, other.end))) copy = punctuated;
                    }
                }
                if (!copy || !neighbors.includes(quoteKey(copy[1]))) break;
                const quoteStart = copy.index + copy[0].indexOf(copy[1]);
                const quoteEnd = quoteStart + copy[1].length;
                if (!protectedRanges(rewritten).some(range => range.start === quoteStart && range.end === quoteEnd)) break;
                let remaining = isStart ? rewritten.slice(copy[0].length) : rewritten.slice(0, copy.index);
                // Do not detach a quoted modifier from its noun (e.g. “确认”的印记).
                if (isStart && /^\s*的/u.test(remaining)) break;
                if (isStart && /^[\p{L}\p{N}]{1,12}$/u.test(copy[1].slice(1, -1))) {
                    const following = source.slice(replacement.end), anchor = following.match(leadingQuote);
                    if (anchor && quoteKey(anchor[1]) === quoteKey(copy[1])
                        && following.slice(anchor[0].length).startsWith('的' + remaining)) break;
                }
                if (!isStart) {
                    if (!/[:：]\s*$/u.test(original)) remaining = remaining.replace(/[ \t]*(?:[:：]\s*)+$/u, '');
                    const ending = original.match(/[，,。.!！?？；;：:]\s*$/u)?.[0].trim();
                    if (ending && !/[，,。.!！?？；;：:]\s*$/u.test(remaining)) remaining = remaining.trimEnd() + ending;
                }
                if (!/[\p{L}\p{N}]/u.test(remaining)) break;
                rewritten = remaining;
                removedCount++;
                trimmed = true;
            }
        }
        // Interior copies can relocate original facts after the quote. Cutting that
        // tail would lose information; retain this source target instead of guessing syntax.
        const interiorCopy = protectedRanges(rewritten).some(range => {
            const token = rewritten.slice(range.start, range.end);
            return new RegExp('^' + directQuote + '$', 'u').test(token)
                && neighbors.includes(quoteKey(token))
                && quoteKey(source.slice(replacement.end).match(leadingQuote)?.[1] || '') === quoteKey(token)
                && /[，,]\s*$/u.test(rewritten.slice(0, range.start))
                && /^\s*[，,]/u.test(rewritten.slice(range.end))
                && /[\p{L}\p{N}]/u.test(rewritten.slice(0, range.start))
                && /[\p{L}\p{N}]/u.test(rewritten.slice(range.end));
        });
        if (interiorCopy) return { ...replacement, rewritten: original, strategy: 'boundary-dialogue-rejected' };
        return trimmed ? { ...replacement, rewritten, strategy: 'boundary-dialogue-trimmed' } : replacement;
    });
    return { replacements: repaired, removedCount };
}
