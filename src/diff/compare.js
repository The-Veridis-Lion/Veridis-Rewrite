/** On-demand Difference document presentation and shared Deep Clean text primitives; no message state. */

export function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const inlineDiffCellLimit = 1600000;
const lineDiffCellLimit = 200000;

function isDiffMatrixSafe(leftLength, rightLength, limit) {
    if (leftLength === 0 || rightLength === 0) return true;
    return leftLength <= Math.floor(limit / rightLength);
}

function pushDiffOperation(operations, type, text = '') {
    if (!text) return;
    const last = operations[operations.length - 1];
    if (last && last.type === type) last.text += text;
    else operations.push({ type, text });
}

function buildCharDiffOperations(oldChars, newChars) {
    const m = oldChars.length;
    const n = newChars.length;
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldChars[i - 1] === newChars[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    let i = m;
    let j = n;
    const reversed = [];
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldChars[i - 1] === newChars[j - 1]) {
            reversed.push({ type: 'equal', text: oldChars[i - 1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            reversed.push({ type: 'insert', text: newChars[j - 1] });
            j--;
        } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
            reversed.push({ type: 'delete', text: oldChars[i - 1] });
            i--;
        }
    }

    const operations = [];
    for (const operation of reversed.reverse()) {
        pushDiffOperation(operations, operation.type, operation.text);
    }
    return operations;
}

function splitLineTokens(value = '') {
    return String(value).match(/[^\n]*\n|[^\n]+/g) || [];
}

function buildTokenDiffOperations(oldTokens, newTokens) {
    const m = oldTokens.length;
    const n = newTokens.length;
    const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));

    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (oldTokens[i - 1] === newTokens[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }

    let i = m;
    let j = n;
    const reversed = [];
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldTokens[i - 1] === newTokens[j - 1]) {
            reversed.push({ type: 'equal', text: oldTokens[i - 1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            reversed.push({ type: 'insert', text: newTokens[j - 1] });
            j--;
        } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
            reversed.push({ type: 'delete', text: oldTokens[i - 1] });
            i--;
        }
    }

    const operations = [];
    for (const operation of reversed.reverse()) {
        pushDiffOperation(operations, operation.type, operation.text);
    }
    return operations;
}

function appendReplacementOperations(operations, deletedText, insertedText) {
    if (!deletedText && !insertedText) return;
    const deletedLength = Array.from(deletedText).length;
    const insertedLength = Array.from(insertedText).length;

    if (deletedText && insertedText && isDiffMatrixSafe(deletedLength, insertedLength, inlineDiffCellLimit)) {
        getTextDiffOperations(deletedText, insertedText, { allowLineFallback: false })
            .forEach(operation => pushDiffOperation(operations, operation.type, operation.text));
        return;
    }

    pushDiffOperation(operations, 'delete', deletedText);
    pushDiffOperation(operations, 'insert', insertedText);
}

function buildLineBlockDiffOperations(oldStr, newStr) {
    const oldTokens = splitLineTokens(oldStr);
    const newTokens = splitLineTokens(newStr);

    if (oldTokens.length === 0) return newStr ? [{ type: 'insert', text: newStr }] : [];
    if (newTokens.length === 0) return oldStr ? [{ type: 'delete', text: oldStr }] : [];
    if (!isDiffMatrixSafe(oldTokens.length, newTokens.length, lineDiffCellLimit)) {
        return [
            { type: 'delete', text: oldStr },
            { type: 'insert', text: newStr },
        ];
    }

    const lineOperations = buildTokenDiffOperations(oldTokens, newTokens);
    const operations = [];
    let deletedText = '';
    let insertedText = '';

    const flushReplacement = () => {
        appendReplacementOperations(operations, deletedText, insertedText);
        deletedText = '';
        insertedText = '';
    };

    for (const operation of lineOperations) {
        if (operation.type === 'equal') {
            flushReplacement();
            pushDiffOperation(operations, 'equal', operation.text);
        } else if (operation.type === 'delete') {
            deletedText += operation.text;
        } else {
            insertedText += operation.text;
        }
    }

    flushReplacement();
    return operations;
}

/**
 * Computes the shared ordered text Diff operations without rendering or touching message state.
 * Deep Clean uses this same pure owner to derive its interactive review blocks.
 */
export function getTextDiffOperations(oldStr, newStr, options = {}) {
    const oldText = String(oldStr ?? '');
    const newText = String(newStr ?? '');
    if (oldText === newText) return oldText ? [{ type: 'equal', text: oldText }] : [];
    if (!oldText) return newText ? [{ type: 'insert', text: newText }] : [];
    if (!newText) return oldText ? [{ type: 'delete', text: oldText }] : [];

    const oldChars = Array.from(oldText);
    const newChars = Array.from(newText);
    let start = 0;
    while (start < oldChars.length && start < newChars.length && oldChars[start] === newChars[start]) {
        start++;
    }

    let endOld = oldChars.length - 1;
    let endNew = newChars.length - 1;
    while (endOld >= start && endNew >= start && oldChars[endOld] === newChars[endNew]) {
        endOld--;
        endNew--;
    }

    const operations = [];
    pushDiffOperation(operations, 'equal', oldChars.slice(0, start).join(''));

    const midOld = oldChars.slice(start, endOld + 1);
    const midNew = newChars.slice(start, endNew + 1);
    const allowLineFallback = options.allowLineFallback !== false;
    const middleOperations = isDiffMatrixSafe(midOld.length, midNew.length, inlineDiffCellLimit)
        ? buildCharDiffOperations(midOld, midNew)
        : allowLineFallback
            ? buildLineBlockDiffOperations(midOld.join(''), midNew.join(''))
            : [
                { type: 'delete', text: midOld.join('') },
                { type: 'insert', text: midNew.join('') },
            ];

    middleOperations.forEach(operation => pushDiffOperation(operations, operation.type, operation.text));
    pushDiffOperation(operations, 'equal', oldChars.slice(endOld + 1).join(''));
    return operations;
}

function renderDiffOperation(operation, section) {
    if (!operation || !operation.text) return '';
    if (operation.type === 'delete' || operation.type === 'insert') {
        const attrs = [
            `class="blai-diff-change"`,
            `data-blai-diff-type="${operation.type === 'delete' ? 'delete' : 'insert'}"`,
        ];
        if (['ai', 'program', 'manual'].includes(section)) attrs.push(`data-blai-diff-section="${section}"`);
        ['oldStart', 'oldEnd', 'newStart', 'newEnd'].forEach((key) => {
            if (Number.isFinite(Number(operation[key]))) attrs.push(`data-blai-${key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}="${Number(operation[key])}"`);
        });
        const tag = operation.type === 'delete' ? 'del' : 'ins';
        return `<${tag} ${attrs.join(' ')}>${escapeHtml(operation.text)}</${tag}>`;
    }
    return escapeHtml(operation.text);
}

function renderDiffOperations(operations = []) {
    return operations.map(operation => renderDiffOperation(operation, operation.section)).join('');
}

function annotateDiffOperations(operations = [], oldOffset = 0, newOffset = 0) {
    return operations.map((operation) => {
        const text = String(operation?.text || '');
        const annotated = {
            ...operation,
            text,
            oldStart: oldOffset,
            oldEnd: oldOffset,
            newStart: newOffset,
            newEnd: newOffset,
        };
        if (operation?.type !== 'insert') oldOffset += text.length;
        if (operation?.type !== 'delete') newOffset += text.length;
        annotated.oldEnd = oldOffset;
        annotated.newEnd = newOffset;
        return annotated;
    });
}

// The pre-rewrite viewer displayed the first content body. Keep canonical offsets
// for related-rule inspection; this projection never changes stored text or scope.
function projectDiffDisplayText(text) {
    const match = /<content>([\s\S]*?)<\/content>/i.exec(text);
    return match ? { text: match[1], offset: match.index + '<content>'.length } : { text, offset: 0 };
}

function sliceDisplayRun(run, start, end) {
    const sliced = { ...run, text: run.text.slice(start, end) };
    if (run.type !== 'insert' && Number.isFinite(run.oldStart)) {
        sliced.oldStart = run.oldStart + start;
        sliced.oldEnd = run.oldStart + end;
    }
    if (run.type !== 'delete' && Number.isFinite(run.newStart)) {
        sliced.newStart = run.newStart + start;
        sliced.newEnd = run.newStart + end;
    }
    return sliced;
}

// Fold a pair into the current display runs. Deleted text stays at its document
// position; only non-deleted text consumes the next pair's input. These are local
// rendering spans, not per-character origins, persisted stages, or revision history.
function applyDisplayPair(runs, pair) {
    const before = projectDiffDisplayText(pair.oldText);
    const after = projectDiffDisplayText(pair.newText);
    const operations = annotateDiffOperations(getTextDiffOperations(before.text, after.text), before.offset, after.offset);
    const result = [];
    let runIndex = 0;
    let runOffset = 0;
    const retainDeletions = () => {
        while (runs[runIndex]?.type === 'delete') {
            result.push(runs[runIndex++]);
        }
    };
    for (const operation of operations) {
        retainDeletions();
        if (operation.type === 'insert') {
            result.push({ ...operation, section: pair.section });
            continue;
        }
        let consumed = 0;
        while (consumed < operation.text.length) {
            retainDeletions();
            const run = runs[runIndex];
            const length = Math.min(run.text.length - runOffset, operation.text.length - consumed);
            const part = sliceDisplayRun(run, runOffset, runOffset + length);
            result.push(operation.type === 'equal' ? part : {
                ...operation,
                text: part.text,
                section: pair.section,
                oldStart: operation.oldStart + consumed,
                oldEnd: operation.oldStart + consumed + length,
            });
            consumed += length;
            runOffset += length;
            if (runOffset === run.text.length) {
                runIndex++;
                runOffset = 0;
            }
        }
    }
    retainDeletions();
    return result;
}

/** One document-order presentation for Full and Snippet, independent of stage execution order. */
export function renderDiffDocument(originalText, pairs, mode) {
    const original = projectDiffDisplayText(originalText);
    let runs = original.text ? [{ type: 'equal', text: original.text }] : [];
    for (const pair of pairs) runs = applyDisplayPair(runs, pair);

    const displayText = runs.map(run => run.text).join('');
    const paragraphSeparator = /(?:\r\n|\n|\r(?!\n))(?:[ \t]*(?:\r\n|\n|\r(?!\n)))+/g;
    const separator = displayText.search(paragraphSeparator) >= 0 ? paragraphSeparator : /\r\n|\n|\r/g;
    const paragraphs = [];
    let paragraphStart = 0;
    for (const match of displayText.matchAll(separator)) {
        paragraphs.push({ start: paragraphStart, end: match.index });
        paragraphStart = match.index + match[0].length;
    }
    paragraphs.push({ start: paragraphStart, end: displayText.length });

    const blocks = [];
    let runIndex = 0;
    let runStart = 0;
    for (const paragraph of paragraphs) {
        // Separators and wrapper-adjacent blank lines are not prose blocks. Do not
        // trim nonempty paragraph text: indentation and inline whitespace survive.
        if (!/\S/u.test(displayText.slice(paragraph.start, paragraph.end))) continue;
        const parts = [];
        while (runIndex < runs.length && runStart < paragraph.end) {
            const run = runs[runIndex];
            const runEnd = runStart + run.text.length;
            if (runEnd > paragraph.start) {
                parts.push(sliceDisplayRun(run, Math.max(0, paragraph.start - runStart), Math.min(run.text.length, paragraph.end - runStart)));
            }
            if (runEnd > paragraph.end) break;
            runStart = runEnd;
            runIndex++;
        }
        const changed = parts.some(part => part.type !== 'equal' && part.text.length > 0);
        if (mode !== 'full' && !changed) continue;
        const className = mode === 'full'
            ? (changed ? 'blai-diff-full-modified' : 'blai-diff-full-normal')
            : 'blai-diff-snippet';
        blocks.push(`<div class="${className}">${renderDiffOperations(parts)}</div>`);
    }
    return blocks;
}

export function renderFullTextDiffBlocks(operations = [], renderOperation = renderDiffOperation, classNames = {}) {
    const normalClassName = classNames.normal || 'blai-diff-full-normal';
    const modifiedClassName = classNames.modified || 'blai-diff-full-modified';
    const blocks = [];
    let currentParts = [];
    let currentHasChange = false;

    const flushBlock = () => {
        const html = currentParts.join('').trim();
        if (!html) {
            currentParts = [];
            currentHasChange = false;
            return;
        }

        const className = currentHasChange ? modifiedClassName : normalClassName;
        blocks.push(`<div class="${className}">${html}</div>`);
        currentParts = [];
        currentHasChange = false;
    };

    for (const operation of operations) {
        if (!operation || (!operation.text && operation.forceRender !== true)) continue;
        if (operation.atomic === true) {
            currentParts.push(renderOperation(operation));
            if (operation.type !== 'equal') currentHasChange = true;
            continue;
        }
        const pieces = String(operation.text).split(/(\r?\n)/);
        for (const piece of pieces) {
            if (!piece) continue;
            if (/^\r?\n$/.test(piece)) {
                if (operation.type !== 'equal' && currentParts.length > 0) {
                    currentParts.push(renderOperation({ ...operation, text: piece }));
                    currentHasChange = true;
                }
                flushBlock();
                continue;
            }
            currentParts.push(renderOperation({ ...operation, text: piece }));
            if (operation.type !== 'equal') currentHasChange = true;
        }
    }

    flushBlock();
    return blocks.join('');
}
