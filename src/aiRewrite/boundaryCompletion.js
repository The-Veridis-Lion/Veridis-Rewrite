const letters = text => String(text).replace(/[^\p{L}\p{N}]/gu, '');

function isSubsequence(candidate, context) {
    let position = 0;
    for (const char of context) {
        if (char === candidate[position]) position++;
        if (position === candidate.length) return true;
    }
    return false;
}

// Project a completed fragment back onto its original, still-present terminal anchor.
// Do not infer a seam from similarity alone, or cut facts moved from inside the target.
export function trimAnchoredCompletion(source, replacement, replacements) {
    const original = source.slice(replacement.start, replacement.end);
    const value = String(replacement.rewritten ?? '');
    if (!/[\p{L}\p{N}]$/u.test(original)) return value;
    const context = source.slice(replacement.end).split(/\r?\n/)[0].slice(0, 800);
    if (!/^[“「『"]/u.test(context)) return value;
    if (replacements.some(other => other !== replacement && other.start < replacement.end + context.length
        && other.end > replacement.end && String(other.rewritten ?? '') !== source.slice(other.start, other.end))) return value;
    const contextKey = letters(context);
    // The model can move the original predicate behind a copied quoted object:
    // “这些话冲破了他名为” + “顾虑”的围墙 -> “这些话让他名为‘顾虑’的围墙冲破”.
    // Reuse only a predicate proven verbatim in the original target, never infer one.
    const quote = context.match(/^(“[^”]+”|「[^」]+」|『[^』]+』|"[^"]+")([^。！？!?\r\n]*)[。！？!?]/u);
    if (quote) {
        const copiedObject = quote[1] + quote[2];
        const at = value.indexOf(copiedObject);
        const before = value.slice(0, at);
        const after = value.slice(at + copiedObject.length).replace(/[。！？!?]$/u, '');
        const causative = before.lastIndexOf('让');
        const objectPrefix = before.slice(causative + 1);
        if (at > 0 && at === value.lastIndexOf(copiedObject) && causative > 0
            && after.length >= 2 && objectPrefix.length >= 4
            && original.endsWith(after + '了' + objectPrefix)) {
            return before.slice(0, causative) + after + '了' + objectPrefix;
        }
    }
    const terminal = original.match(/[\p{L}\p{N}]+$/u)?.[0] || '';
    for (let length = Math.min(24, terminal.length); length >= 2; length--) {
        const anchor = terminal.slice(-length);
        const position = value.indexOf(anchor);
        if (position < 2 || position !== value.lastIndexOf(anchor)) continue;
        const added = letters(value.slice(position + anchor.length));
        const quotedTail = quote && value.slice(position + anchor.length).startsWith(quote[1]);
        // Only normalize a sentence-leading 这是/那是 in a proven quoted continuation.
        const addedComparable = letters(value.slice(position + anchor.length).replace(/([。！？!?，,])这是/gu, '$1那是'));
        const contextComparable = letters(context.replace(/([。！？!?，,])这是/gu, '$1那是'));
        if (added.length < 6 || !(isSubsequence(added, contextKey)
            || (quotedTail && isSubsequence(addedComparable, contextComparable)))) continue;
        // A repeated fragment of the target after the seam can carry moved original
        // information. Leave that case to the existing explicit rejection path.
        const originalKey = letters(original.slice(0, -length));
        let movedFact = false;
        for (let i = 0; i + 4 <= added.length; i++) {
            const part = added.slice(i, i + 4);
            if (originalKey.includes(part) && !contextKey.includes(part)) { movedFact = true; break; }
        }
        if (!movedFact) return value.slice(0, position + anchor.length);
    }
    return value;
}

// A cause moved from the immediately following fragment must not replace a
// target's explicit negative fact. This narrow grammar preserves both predicates.
export function projectExternalReason(source, replacement, replacements) {
    const original = source.slice(replacement.start, replacement.end);
    const contrast = original.match(/^([他她它])不是在([\p{L}]{2,6})[，,]而是在([\p{L}]{2,6})。$/u);
    if (!contrast) return String(replacement.rewritten ?? '');
    const value = String(replacement.rewritten ?? '');
    const following = source.slice(replacement.end).match(/^为([^。\r\n]{8,160})。/u);
    const response = value.match(/^([他她它])因([^。\r\n]{8,160})而([\p{L}]{2,6})。$/u);
    if (!following || !response || response[1] !== contrast[1] || response[3] !== contrast[3]) return value;
    if (!isSubsequence(letters(response[2]), letters(following[1]))) return value;
    if (replacements.some(other => other !== replacement && other.start < replacement.end + following[0].length
        && other.end > replacement.end && String(other.rewritten ?? '') !== source.slice(other.start, other.end))) return value;
    return `${contrast[1]}在${contrast[3]}，没有${contrast[2]}。`;
}
