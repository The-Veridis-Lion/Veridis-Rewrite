/** On-demand Difference document presentation and shared Deep Clean text primitives; no message state. */
import { splitTextRangeIntoSentences } from '../text/sentences.js';
import { collectVariableUpdateRanges } from '../text/variableUpdates.js';

export function escapeHtml(value = '') {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function pushDiffOperation(operations, type, text = '') {
    if (!text) return;
    const last = operations[operations.length - 1];
    // Keep replacements in delete/insert order for related-rule selection.
    if (type === 'delete' && last?.type === 'insert') {
        operations.pop();
        pushDiffOperation(operations, 'delete', text);
        pushDiffOperation(operations, 'insert', last.text);
        return;
    }
    if (last && last.type === type) last.text += text;
    else operations.push({ type, text });
}

// Linear-space Myers bisection. Both frontiers follow exact equal code points;
// there is no size/deadline cutoff that can turn an unexamined middle into edits.
function findMiddleSplit(left, right, a, b, c, d) {
    const m = b - a;
    const n = d - c;
    const maxDepth = Math.ceil((m + n) / 2);
    const offset = maxDepth + 1;
    const forward = new Int32Array(2 * maxDepth + 3).fill(-1);
    const reverse = new Int32Array(2 * maxDepth + 3).fill(-1);
    forward[offset + 1] = reverse[offset + 1] = 0;
    const delta = m - n;
    const odd = delta % 2 !== 0;
    let forwardStart = 0;
    let forwardEnd = 0;
    let reverseStart = 0;
    let reverseEnd = 0;
    for (let depth = 0; depth < maxDepth; depth++) {
        for (let k = -depth + forwardStart; k <= depth - forwardEnd; k += 2) {
            const slot = offset + k;
            let x = k === -depth || (k !== depth && forward[slot - 1] < forward[slot + 1])
                ? forward[slot + 1] : forward[slot - 1] + 1;
            let y = x - k;
            while (x < m && y < n && left[a + x] === right[c + y]) { x++; y++; }
            forward[slot] = x;
            if (x > m) forwardEnd += 2;
            else if (y > n) forwardStart += 2;
            else if (odd) {
                const other = offset + delta - k;
                if (other >= 0 && other < reverse.length && reverse[other] !== -1
                    && x >= m - reverse[other]) return [a + x, c + y];
            }
        }
        for (let k = -depth + reverseStart; k <= depth - reverseEnd; k += 2) {
            const slot = offset + k;
            let x = k === -depth || (k !== depth && reverse[slot - 1] < reverse[slot + 1])
                ? reverse[slot + 1] : reverse[slot - 1] + 1;
            let y = x - k;
            while (x < m && y < n && left[b - x - 1] === right[d - y - 1]) { x++; y++; }
            reverse[slot] = x;
            if (x > m) reverseEnd += 2;
            else if (y > n) reverseStart += 2;
            else if (!odd) {
                const other = offset + delta - k;
                if (other >= 0 && other < forward.length && forward[other] !== -1
                    && forward[other] >= m - x) {
                    const forwardX = forward[other];
                    return [a + forwardX, c + forwardX - (delta - k)];
                }
            }
        }
    }
    // Exhausting all depths proves there is no equality in this region.
    return null;
}

/** Exact, deterministic pair diff shared with Deep Clean; no provenance or state. */
export function getTextDiffOperations(oldStr, newStr) {
    const left = Array.from(String(oldStr ?? ''));
    const right = Array.from(String(newStr ?? ''));
    const operations = [];
    // Explicit work stack avoids a call-stack limit on adversarial input.
    const pending = [{ a: 0, b: left.length, c: 0, d: right.length }];
    while (pending.length) {
        const task = pending.pop();
        if (task.type) {
            pushDiffOperation(operations, task.type, task.text);
            continue;
        }
        let { a, b, c, d } = task;
        const start = a;
        while (a < b && c < d && left[a] === right[c]) { a++; c++; }
        pushDiffOperation(operations, 'equal', left.slice(start, a).join(''));
        const end = b;
        while (a < b && c < d && left[b - 1] === right[d - 1]) { b--; d--; }
        if (b < end) pending.push({ type: 'equal', text: left.slice(b, end).join('') });
        if (a === b || c === d) {
            pushDiffOperation(operations, 'delete', left.slice(a, b).join(''));
            pushDiffOperation(operations, 'insert', right.slice(c, d).join(''));
            continue;
        }
        const split = findMiddleSplit(left, right, a, b, c, d);
        if (split) {
            const [x, y] = split;
            pending.push({ a: x, b, c: y, d });
            pending.push({ a, b: x, c, d: y });
        } else {
            pushDiffOperation(operations, 'delete', left.slice(a, b).join(''));
            pushDiffOperation(operations, 'insert', right.slice(c, d).join(''));
        }
    }
    return operations;
}

function renderDiffOperation(operation, section) {
    if (!operation || !operation.text) return '';
    if (operation.type === 'delete' || operation.type === 'insert') {
        const attrs = [
            `class="blai-diff-change"`,
            `data-blai-diff-type="${operation.type === 'delete' ? 'delete' : 'insert'}"`,
        ];
        if (['ai', 'program'].includes(section)) attrs.push(`data-blai-diff-section="${section}"`);
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

function projectDifferenceText(value) {
    const source = String(value ?? '');
    const spans = [];
    const parts = [];
    let sourceStart = 0;
    let offset = 0;
    for (const range of [...collectVariableUpdateRanges(source), { start: source.length, end: source.length }]) {
        if (sourceStart < range.start) {
            const text = source.slice(sourceStart, range.start);
            spans.push({ sourceStart, start: offset, end: offset + text.length });
            parts.push(text);
            offset += text.length;
        }
        sourceStart = range.end;
    }
    return { text: parts.join(''), spans, sourceLength: source.length };
}

function getDifferencePairOperations(pair) {
    const oldProjection = projectDifferenceText(pair.oldText);
    const newProjection = projectDifferenceText(pair.newText);
    const sides = [
        { projection: oldProjection, prefix: 'old', skip: 'insert', index: 0, offset: 0 },
        { projection: newProjection, prefix: 'new', skip: 'delete', index: 0, offset: 0 },
    ];
    const runs = [];
    for (const operation of getTextDiffOperations(oldProjection.text, newProjection.text)) {
        let cursor = 0;
        while (cursor < operation.text.length) {
            let length = operation.text.length - cursor;
            const coordinates = {};
            for (const side of sides) {
                const { spans, sourceLength } = side.projection;
                while (side.index < spans.length && spans[side.index].end <= side.offset) side.index++;
                const span = spans[side.index];
                coordinates[`${side.prefix}Start`] = span
                    ? span.sourceStart + side.offset - span.start : sourceLength;
                if (operation.type !== side.skip) length = Math.min(length, span.end - side.offset);
            }
            for (const side of sides) {
                const consumed = operation.type === side.skip ? 0 : length;
                coordinates[`${side.prefix}End`] = coordinates[`${side.prefix}Start`] + consumed;
                side.offset += consumed;
            }
            // Split at every omitted block on either side, keeping each run's raw offsets contiguous.
            runs.push({ ...operation, text: operation.text.slice(cursor, cursor + length), ...coordinates });
            cursor += length;
        }
    }
    return runs;
}

function sliceDisplayRun(run, start, end) {
    return {
        ...run,
        text: run.text.slice(start, end),
        oldStart: run.oldStart + (run.type === 'insert' ? 0 : start),
        oldEnd: run.oldStart + (run.type === 'insert' ? 0 : end),
        newStart: run.newStart + (run.type === 'delete' ? 0 : start),
        newEnd: run.newStart + (run.type === 'delete' ? 0 : end),
    };
}

function getSnippetPairOperations(pair, operations) {
    // Align complete stages before selecting bodies. A changed scope boundary
    // must not turn prose retained in both stages into an insertion/deletion.
    if (!pair.oldRanges?.length && !pair.newRanges?.length) {
        return operations;
    }
    const sides = [
        { ranges: pair.oldRanges || [], index: 0, start: 'oldStart', end: 'oldEnd', skip: 'insert' },
        { ranges: pair.newRanges || [], index: 0, start: 'newStart', end: 'newEnd', skip: 'delete' },
    ];
    const selected = [];
    for (const operation of operations) {
        const intervals = [];
        for (const side of sides) {
            if (operation.type === side.skip) continue;
            const start = operation[side.start];
            const end = operation[side.end];
            while (side.index < side.ranges.length && side.ranges[side.index].end <= start) side.index++;
            for (let i = side.index; i < side.ranges.length && side.ranges[i].start < end; i++) {
                const range = side.ranges[i];
                const from = Math.max(start, range.start);
                const to = Math.min(end, range.end);
                if (from < to) intervals.push({ start: from - start, end: to - start });
            }
        }
        // Equal context can be selected by either side; emit each interval once.
        // This merges coordinates within one operation, never repeated text.
        intervals.sort((a, b) => a.start - b.start || a.end - b.end);
        let current = null;
        for (const interval of intervals) {
            if (current && interval.start <= current.end) {
                current.end = Math.max(current.end, interval.end);
            } else {
                if (current) selected.push(sliceDisplayRun(operation, current.start, current.end));
                current = interval;
            }
        }
        if (current) selected.push(sliceDisplayRun(operation, current.start, current.end));
    }
    return selected;
}

/** The existing Full/Snippet renderer, now consuming independent recorded pairs. */
export function renderDiffDocument(pairs, mode) {
    const blocks = [];
    for (const pair of pairs) {
        const operations = getDifferencePairOperations(pair);
        const runs = (mode === 'full'
            ? operations
            : getSnippetPairOperations(pair, operations))
            .map(operation => ({ ...operation, section: pair.section }));
        if (mode === 'full') {
            const changed = runs.some(run => run.type !== 'equal');
            blocks.push(`<div class="${changed ? 'blai-diff-full-modified' : 'blai-diff-full-normal'}">${renderDiffOperations(runs)}</div>`);
            continue;
        }
        // Sentence boundaries provide local context only; omitted newline gaps
        // are restored as units so whitespace-only changes are never discarded.
        const displayText = runs.map(run => run.text).join('');
        const units = [];
        let cursor = 0;
        for (const range of splitTextRangeIntoSentences(displayText, { start: 0, end: displayText.length })) {
            if (cursor < range.start) units.push({ start: cursor, end: range.start });
            units.push(range);
            cursor = range.end;
        }
        if (cursor < displayText.length) units.push({ start: cursor, end: displayText.length });
        let runIndex = 0;
        let runStart = 0;
        for (const unit of units) {
            const parts = [];
            while (runIndex < runs.length && runStart < unit.end) {
                const run = runs[runIndex];
                const runEnd = runStart + run.text.length;
                if (runEnd > unit.start) {
                    parts.push(sliceDisplayRun(run, Math.max(0, unit.start - runStart), Math.min(run.text.length, unit.end - runStart)));
                }
                if (runEnd > unit.end) break;
                runStart = runEnd;
                runIndex++;
            }
            if (parts.some(part => part.type !== 'equal')) {
                blocks.push(`<div class="blai-diff-snippet">${renderDiffOperations(parts)}</div>`);
            }
        }
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
