/**
 * Owns Diff text comparison and HTML/cache-result construction only; it does not own tracked-message runtime state, persistence, message mutation, or live DOM projection.
 */
import { applyScopedReplacements, applyScopedReplacementsWithTrackedRanges } from '../rules/engine.js';

/**
 * 将原始文本进行 HTML 转义，避免差异片段注入标签。
 * @param {string} [value=''] 需要转义的文本。
 * @returns {string} 已转义的安全 HTML 文本。
 */
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
const snippetWindowCharLimit = 900;
const snippetJoinEqualChars = 96;
const maxDiffSnippetCount = 16;

/**
 * 生成两段文本的行内差异 HTML。
 * 先整体对齐文本，再对中间片段做 LCS 回溯，避免换行变化导致逐行错位。
 * @param {string} oldStr 原始文本。
 * @param {string} newStr 净化后文本。
 * @returns {string} 包含 <ins>/<del> 标记的差异 HTML。
 */
export function getInlineDiff(oldStr, newStr) {
    return renderTextDiffHtml(oldStr, newStr);
}

/**
 * Renders an arbitrary text pair with the shared diff algorithm, preserving all text and line breaks.
 * This is intentionally independent of message metadata, cache, DOM, and persistence.
 */
export function renderTextDiffHtml(oldStr, newStr) {
    return renderDiffOperations(getTextDiffOperations(oldStr, newStr));
}

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

function renderDiffOperation(operation) {
    if (!operation || !operation.text) return '';
    if (operation.type === 'delete' || operation.type === 'insert') {
        const attrs = [
            `class="blai-diff-change"`,
            `data-blai-diff-type="${operation.type === 'delete' ? 'delete' : 'insert'}"`,
        ];
        if (['program', 'ai', 'manual'].includes(operation.source)) {
            attrs.push(`data-blai-diff-source="${operation.source}"`);
        }
        ['oldStart', 'oldEnd', 'newStart', 'newEnd'].forEach((key) => {
            if (Number.isFinite(Number(operation[key]))) attrs.push(`data-blai-${key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}="${Number(operation[key])}"`);
        });
        const tag = operation.type === 'delete' ? 'del' : 'ins';
        return `<${tag} ${attrs.join(' ')}>${escapeHtml(operation.text)}</${tag}>`;
    }
    return escapeHtml(operation.text);
}

function renderDiffOperations(operations = []) {
    return operations.map(renderDiffOperation).join('');
}

function findPreviousBoundaryEnd(text = '', position = 0, pattern = /\r?\n/g) {
    const source = String(text);
    const cursor = Math.max(0, Math.min(source.length, Number(position) || 0));
    const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let boundaryEnd = -1;
    let match;
    while ((match = regex.exec(source)) !== null) {
        if (match.index >= cursor) break;
        boundaryEnd = match.index + match[0].length;
        if (match[0].length === 0) regex.lastIndex++;
    }
    return boundaryEnd;
}

function findNextBoundaryStart(text = '', position = 0, pattern = /\r?\n/g) {
    const source = String(text);
    const cursor = Math.max(0, Math.min(source.length, Number(position) || 0));
    const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    regex.lastIndex = cursor;
    const match = regex.exec(source);
    return match ? match.index : -1;
}

function hasParagraphBoundary(value = '') {
    return /\r?\n[ \t]*\r?\n/.test(String(value));
}

function hasLineBoundary(value = '') {
    return /\r?\n/.test(String(value));
}

function getLogicalWindowForChange(originalText = '', start = 0, end = start) {
    const text = String(originalText);
    const safeStart = Math.max(0, Math.min(text.length, Number(start) || 0));
    const safeEnd = Math.max(safeStart, Math.min(text.length, Number(end) || safeStart));
    const paragraphPattern = /\r?\n[ \t]*\r?\n/g;

    const previousParagraphEnd = findPreviousBoundaryEnd(text, safeStart, paragraphPattern);
    const nextParagraphStart = findNextBoundaryStart(text, safeEnd, paragraphPattern);
    if (previousParagraphEnd >= 0 || nextParagraphStart >= 0) {
        return {
            start: previousParagraphEnd >= 0 ? previousParagraphEnd : 0,
            end: nextParagraphStart >= 0 ? nextParagraphStart : text.length,
        };
    }

    const previousLineEnd = findPreviousBoundaryEnd(text, safeStart, /\r?\n/g);
    const nextLineStart = findNextBoundaryStart(text, safeEnd, /\r?\n/g);
    return {
        start: previousLineEnd >= 0 ? previousLineEnd : 0,
        end: nextLineStart >= 0 ? nextLineStart : text.length,
    };
}

function clampWindowToLimit(window, textLength) {
    const start = Math.max(0, Math.min(textLength, Number(window?.start) || 0));
    const end = Math.max(start, Math.min(textLength, Number(window?.end) || start));
    const anchorStart = Math.max(start, Math.min(end, Number(window?.anchorStart) || start));
    const anchorEnd = Math.max(anchorStart, Math.min(end, Number(window?.anchorEnd) || anchorStart));

    if (end - start <= snippetWindowCharLimit) {
        return { start, end, hasPrefixEllipsis: false, hasSuffixEllipsis: false };
    }

    const anchorLength = Math.max(1, anchorEnd - anchorStart);
    if (anchorLength >= snippetWindowCharLimit) {
        const nextEnd = Math.min(end, anchorStart + snippetWindowCharLimit);
        return {
            start: anchorStart,
            end: nextEnd,
            hasPrefixEllipsis: anchorStart > start,
            hasSuffixEllipsis: nextEnd < end,
        };
    }

    const beforeBudget = Math.floor((snippetWindowCharLimit - anchorLength) / 2);
    let nextStart = Math.max(start, anchorStart - beforeBudget);
    let nextEnd = nextStart + snippetWindowCharLimit;
    if (nextEnd > end) {
        nextEnd = end;
        nextStart = Math.max(start, nextEnd - snippetWindowCharLimit);
    }

    return {
        start: nextStart,
        end: nextEnd,
        hasPrefixEllipsis: nextStart > start,
        hasSuffixEllipsis: nextEnd < end,
    };
}

function annotateDiffOperations(operations = []) {
    let oldOffset = 0;
    let newOffset = 0;
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

function applyDefaultSource(annotatedOperations = [], source = 'program') {
    return annotatedOperations.map(operation => operation?.type === 'equal'
        ? operation
        : { ...operation, source });
}

function applyStageTransition(tokens, deletedSources, fromText, toText, source) {
    const nextTokens = [];
    let oldCursor = 0;
    for (const operation of getTextDiffOperations(fromText, toText)) {
        const chars = Array.from(String(operation.text || ''));
        if (operation.type === 'equal') {
            nextTokens.push(...tokens.slice(oldCursor, oldCursor + chars.length));
            oldCursor += chars.length;
            continue;
        }
        if (operation.type === 'delete') {
            tokens.slice(oldCursor, oldCursor + chars.length).forEach((token) => {
                if (Number.isInteger(token.originalIndex)) deletedSources[token.originalIndex] = source;
            });
            oldCursor += chars.length;
            continue;
        }
        chars.forEach(char => nextTokens.push({ char, originalIndex: null, source }));
    }
    return nextTokens;
}

function restoreFinalEqualities(tokens, originalChars, deletedSources) {
    const stageRank = { program: 1, ai: 2, manual: 3 };
    const anchors = [{ tokenPosition: -1, originalIndex: -1 }];
    tokens.forEach((token, tokenPosition) => {
        if (Number.isInteger(token.originalIndex)) {
            anchors.push({ tokenPosition, originalIndex: token.originalIndex });
        }
    });
    anchors.push({ tokenPosition: tokens.length, originalIndex: originalChars.length });

    for (let anchorIndex = 0; anchorIndex < anchors.length - 1; anchorIndex++) {
        const left = anchors[anchorIndex];
        const right = anchors[anchorIndex + 1];
        const oldStart = left.originalIndex + 1;
        const oldChars = originalChars.slice(oldStart, right.originalIndex);
        const newStart = left.tokenPosition + 1;
        const intervalTokens = tokens.slice(newStart, right.tokenPosition);
        if (oldChars.length === 0 || intervalTokens.length === 0) continue;

        let oldCursor = 0;
        let newCursor = 0;
        for (const operation of getTextDiffOperations(
            oldChars.join(''),
            intervalTokens.map(token => token.char).join(''),
        )) {
            const length = Array.from(String(operation.text || '')).length;
            if (operation.type === 'equal') {
                for (let offset = 0; offset < length; offset++) {
                    const originalIndex = oldStart + oldCursor + offset;
                    const token = intervalTokens[newCursor + offset];
                    if ((stageRank[token.source] || 0) <= (stageRank[deletedSources[originalIndex]] || 0)) continue;
                    token.originalIndex = originalIndex;
                    token.source = 'original';
                    deletedSources[originalIndex] = undefined;
                }
                oldCursor += length;
                newCursor += length;
            } else if (operation.type === 'delete') {
                oldCursor += length;
            } else {
                newCursor += length;
            }
        }
    }
}

function buildCharacterOffsets(chars) {
    const offsets = [0];
    chars.forEach(char => offsets.push(offsets[offsets.length - 1] + char.length));
    return offsets;
}

function pushComposedOperation(operations, operation) {
    const previous = operations[operations.length - 1];
    const sameSource = previous?.source === operation.source;
    const contiguous = operation.type === 'equal'
        ? previous?.oldEnd === operation.oldStart && previous?.newEnd === operation.newStart
        : operation.type === 'insert'
            ? previous?.oldStart === operation.oldStart && previous?.newEnd === operation.newStart
            : previous?.newStart === operation.newStart && previous?.oldEnd === operation.oldStart;
    if (previous?.type === operation.type && sameSource && contiguous) {
        previous.text += operation.text;
        previous.oldEnd = operation.oldEnd;
        previous.newEnd = operation.newEnd;
        return;
    }
    operations.push(operation);
}

function composeStageOperations(originalText, stages) {
    const originalChars = Array.from(originalText);
    let tokens = originalChars.map((char, originalIndex) => ({ char, originalIndex, source: 'original' }));
    const deletedSources = new Array(originalChars.length);
    let currentText = originalText;
    stages.forEach((stage) => {
        tokens = applyStageTransition(tokens, deletedSources, currentText, stage.text, stage.source);
        restoreFinalEqualities(tokens, originalChars, deletedSources);
        currentText = stage.text;
    });

    const finalChars = tokens.map(token => token.char);
    const oldOffsets = buildCharacterOffsets(originalChars);
    const newOffsets = buildCharacterOffsets(finalChars);
    const operations = [];
    let oldCursor = 0;
    let newCursor = 0;

    while (oldCursor < originalChars.length || newCursor < tokens.length) {
        const token = tokens[newCursor];
        if (token && token.originalIndex === oldCursor) {
            pushComposedOperation(operations, {
                type: 'equal',
                text: token.char,
                oldStart: oldOffsets[oldCursor],
                oldEnd: oldOffsets[oldCursor + 1],
                newStart: newOffsets[newCursor],
                newEnd: newOffsets[newCursor + 1],
            });
            oldCursor += 1;
            newCursor += 1;
            continue;
        }
        if (token && token.originalIndex === null) {
            pushComposedOperation(operations, {
                type: 'insert',
                text: token.char,
                source: token.source,
                oldStart: oldOffsets[oldCursor],
                oldEnd: oldOffsets[oldCursor],
                newStart: newOffsets[newCursor],
                newEnd: newOffsets[newCursor + 1],
            });
            newCursor += 1;
            continue;
        }
        if (oldCursor < originalChars.length) {
            pushComposedOperation(operations, {
                type: 'delete',
                text: originalChars[oldCursor],
                source: deletedSources[oldCursor] || 'program',
                oldStart: oldOffsets[oldCursor],
                oldEnd: oldOffsets[oldCursor + 1],
                newStart: newOffsets[newCursor],
                newEnd: newOffsets[newCursor],
            });
            oldCursor += 1;
            continue;
        }
        break;
    }
    return operations;
}

function getChangeWindows(annotatedOperations = [], originalText = '') {
    const text = String(originalText);
    const windows = [];
    for (const operation of annotatedOperations) {
        if (!operation || operation.type === 'equal' || !operation.text) continue;
        const anchorStart = operation.type === 'insert' ? operation.oldStart : operation.oldStart;
        const anchorEnd = operation.type === 'insert' ? operation.oldStart : operation.oldEnd;
        const logicalWindow = getLogicalWindowForChange(text, anchorStart, anchorEnd);
        windows.push({
            ...logicalWindow,
            anchorStart,
            anchorEnd,
        });
    }

    windows.sort((a, b) => a.start - b.start || a.anchorStart - b.anchorStart);
    const merged = [];
    for (const window of windows) {
        const previous = merged[merged.length - 1];
        if (!previous) {
            merged.push({ ...window });
            continue;
        }

        const gap = Math.max(0, window.start - previous.end);
        const gapText = gap > 0 ? text.slice(previous.end, window.start) : '';
        const mergedAnchorSpan = Math.max(previous.anchorEnd, window.anchorEnd) - Math.min(previous.anchorStart, window.anchorStart);
        const shouldMerge = (window.start <= previous.end && mergedAnchorSpan <= snippetWindowCharLimit)
            || (gap <= snippetJoinEqualChars && !hasLineBoundary(gapText) && !hasParagraphBoundary(gapText) && mergedAnchorSpan <= snippetWindowCharLimit);

        if (shouldMerge) {
            previous.start = Math.min(previous.start, window.start);
            previous.end = Math.max(previous.end, window.end);
            previous.anchorStart = Math.min(previous.anchorStart, window.anchorStart);
            previous.anchorEnd = Math.max(previous.anchorEnd, window.anchorEnd);
        } else {
            merged.push({ ...window });
        }
    }

    return merged
        .slice(0, maxDiffSnippetCount)
        .map(window => clampWindowToLimit(window, text.length));
}

function renderOperationSlice(operation, start, end) {
    if (!operation || !operation.text || end <= start) return '';
    const slicedText = operation.text.slice(start - operation.oldStart, end - operation.oldStart);
    if (!slicedText) return '';
    return renderDiffOperation({ ...operation, text: slicedText, oldStart: start, oldEnd: end });
}

function renderDiffWindow(annotatedOperations = [], window) {
    if (!window || window.end < window.start) return '';
    const parts = [];
    if (window.hasPrefixEllipsis) parts.push('...');

    for (const operation of annotatedOperations) {
        if (!operation?.text) continue;

        if (operation.type === 'insert') {
            if (operation.oldStart >= window.start && operation.oldStart <= window.end) {
                parts.push(renderDiffOperation(operation));
            }
            continue;
        }

        const overlapStart = Math.max(window.start, operation.oldStart);
        const overlapEnd = Math.min(window.end, operation.oldEnd);
        if (overlapEnd > overlapStart) {
            parts.push(renderOperationSlice(operation, overlapStart, overlapEnd));
        }
    }

    if (window.hasSuffixEllipsis) parts.push('...');
    const html = parts.join('');
    if (!html.trim() || !/<(?:del|ins)\b/.test(html)) return '';
    return `<div class="blai-diff-snippet">${html}</div>`;
}

function buildDiffSnippetsFromOperations(operations = [], originalText = '') {
    const annotatedOperations = annotateDiffOperations(operations);
    const sourcedOperations = applyDefaultSource(annotatedOperations);
    return buildDiffSnippetsFromAnnotatedOperations(sourcedOperations, originalText);
}

function buildDiffSnippetsFromAnnotatedOperations(annotatedOperations = [], originalText = '') {
    return getChangeWindows(annotatedOperations, originalText)
        .map(window => renderDiffWindow(annotatedOperations, window))
        .filter(Boolean)
        .slice(0, maxDiffSnippetCount);
}

export function extractDiffDisplayText(rawText = '') {
    const source = String(rawText ?? '');
    const contentMatch = source.match(/<content>([\s\S]*?)<\/content>/i);
    return contentMatch ? contentMatch[1].trim() : source;
}

export function buildDiffResultFromPair(rawText, cleanedText) {
    if (typeof rawText !== 'string') return { cleanedText: rawText, snippets: [], fullDiff: "" };
    const normalizedCleanedText = typeof cleanedText === 'string' ? cleanedText : applyScopedReplacements(rawText);
    const displayText = extractDiffDisplayText(rawText);
    const cleanedDisplayText = extractDiffDisplayText(normalizedCleanedText);
    const displayOperations = getTextDiffOperations(displayText, cleanedDisplayText);
    const snippets = buildDiffSnippetsFromOperations(displayOperations, displayText);
    const fullDiff = buildFullDiffHtml(displayText, cleanedDisplayText);

    return {
        cleanedText: normalizedCleanedText,
        snippets,
        fullDiff,
    };
}

export function buildDiffResultFromChain(rawText, programText, finalText) {
    return buildDiffResultFromStages(rawText, programText, finalText, null);
}

export function buildDiffResultFromStages(rawText, programText, aiText, manualText) {
    if (typeof rawText !== 'string') return { cleanedText: rawText, snippets: [], fullDiff: "" };
    const normalizedProgramText = typeof programText === 'string' ? programText : applyScopedReplacements(rawText);
    const normalizedAiText = typeof aiText === 'string' ? aiText : normalizedProgramText;
    const normalizedManualText = typeof manualText === 'string' ? manualText : normalizedAiText;
    const displayText = extractDiffDisplayText(rawText);
    const programDisplayText = extractDiffDisplayText(normalizedProgramText);
    const aiDisplayText = extractDiffDisplayText(normalizedAiText);
    const manualDisplayText = extractDiffDisplayText(normalizedManualText);

    if (displayText === manualDisplayText) {
        return {
            cleanedText: normalizedManualText,
            snippets: [],
            fullDiff: buildNormalFullDiffBlocks(displayText),
        };
    }

    const stages = [{ text: programDisplayText, source: 'program' }];
    if (typeof aiText === 'string') stages.push({ text: aiDisplayText, source: 'ai' });
    if (typeof manualText === 'string') stages.push({ text: manualDisplayText, source: 'manual' });
    const sourceToManualOperations = composeStageOperations(displayText, stages);

    return {
        cleanedText: normalizedManualText,
        snippets: buildDiffSnippetsFromAnnotatedOperations(sourceToManualOperations, displayText),
        fullDiff: buildFullDiffBlocksFromOperations(sourceToManualOperations),
    };
}

function buildDiffResultFromSource(rawText) {
    if (typeof rawText !== 'string') return { cleanedText: rawText, snippets: [], fullDiff: "", programProjection: [] };
    const programResult = applyScopedReplacementsWithTrackedRanges(rawText);
    return {
        ...buildDiffResultFromPair(rawText, programResult.text),
        programProjection: programResult.projection,
    };
}

function buildNormalFullDiffBlocks(value = '') {
    return String(value)
        .split('\n')
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => `<div class="blai-diff-full-normal">${escapeHtml(part)}</div>`)
        .join('');
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

function buildFullDiffBlocksFromOperations(operations = []) {
    return renderFullTextDiffBlocks(operations);
}

function buildFullDiffHtml(originalText, cleanedText) {
    if (originalText === cleanedText) return buildNormalFullDiffBlocks(originalText);
    const operations = applyDefaultSource(annotateDiffOperations(getTextDiffOperations(originalText, cleanedText)));
    return buildFullDiffBlocksFromOperations(operations);
}
/**
 * 从原始消息文本构建净化结果与差异缓存。
 * @param {string} rawText 原始消息文本。
 * @returns {{cleanedText: string, snippets: string[], fullDiff: string, programProjection: number[][]}} 净化文本、片段差异、全文差异和同次 Program 执行产生的投影轨迹。
 */
export function buildDiffSnippetsFromText(rawText) {
    return buildDiffResultFromSource(rawText);
}
