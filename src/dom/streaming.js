import { getAppContext } from '../host/appContext.js';
import { streamingRuntimeState } from '../host/streamingState.js';
import { rulesRuntimeState } from '../rules/state.js';
import { applyVisualMask, buildProcessors, collectScopedReplacementRanges, hasEnabledScopeTags, isStreamingVisualProcessorSafe, resolveProcessorReplacement } from '../rules/engine.js';
import { getMessageDomNode } from './message.js';
import { excludedMessageContentSelector, isProtectedNode, isRevertedMessageDomNode, isManualFinalMessageDomNode } from './protection.js';

/** Owns streaming-time visual projection onto existing rendered DOM. It never owns finalized message mutation or persistence. */

const trailingDashBetweenChineseSource = '(?<=[\\u4e00-\\u9fff])—+(?=[\\u4e00-\\u9fff])';
const crossParagraphDashBetweenChineseSource = '(?<=[\\u4e00-\\u9fff])—+\\n+(?:—+)?(?=[\\u4e00-\\u9fff])';
function findTavernHelperStreamingSurface(messageNode) {
    const local = messageNode?.querySelectorAll?.('.TH-streaming');
    return local?.length ? local[local.length - 1] : null;
}

function shouldSkipStreamingPresentationTextNode(node, surface) {
    const parent = node?.parentElement || node?.parentNode;
    if (!parent || node.nodeType !== Node.TEXT_NODE) return true;
    if (!surface?.contains?.(parent)) return true;
    if (parent.closest?.(excludedMessageContentSelector)) return true;
    if (isProtectedNode(parent) || isRevertedMessageDomNode(parent) || isManualFinalMessageDomNode(parent)) return true;
    if (document.activeElement && (document.activeElement === parent || parent.contains?.(document.activeElement))) return true;
    return false;
}

/**
 * 在宿主或酒馆助手已经渲染完成的显示面上只替换普通文本节点。
 * 不重建 innerHTML，从而保留代码块折叠、iframe 和其他扩展绑定的 DOM 与事件。
 * @param {Element} surface 当前帧的显示面。
 * @returns {boolean} 是否修改了至少一个文本节点。
 */
function stripStreamingWrapperTags(text) {
    return String(text || '').replace(/<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*?)?>/g, '');
}

export function resolveSingleNodeStreamingProjection(rawSource, cleanSource, currentText) {
    const rawText = String(rawSource || '');
    const cleanText = String(cleanSource || '');
    if (!rawText || rawText === cleanText) return null;
    if (currentText === rawText) return cleanText;

    const visibleRawText = stripStreamingWrapperTags(rawText);
    if (currentText !== visibleRawText) return null;
    return stripStreamingWrapperTags(cleanText);
}

function isStreamingRunBoundaryElement(element) {
    return element?.matches?.('p, div, li, blockquote, h1, h2, h3, h4, h5, h6, table, thead, tbody, tfoot, tr, td, th, ul, ol');
}

export function collectStreamingTextRuns(surface) {
    const runs = [];
    let currentRun = [];
    const flush = () => {
        if (currentRun.length > 0) runs.push(currentRun);
        currentRun = [];
    };

    const walk = (node) => {
        if (node?.nodeType === Node.TEXT_NODE) {
            if (shouldSkipStreamingPresentationTextNode(node, surface)) {
                flush();
                return;
            }
            currentRun.push(node);
            return;
        }
        if (node?.nodeType !== Node.ELEMENT_NODE) return;

        if (node !== surface && (
            node.matches?.('br, hr')
            || node.matches?.(excludedMessageContentSelector)
            || isProtectedNode(node)
            || isRevertedMessageDomNode(node)
            || isManualFinalMessageDomNode(node)
            || (document.activeElement && (document.activeElement === node || node.contains?.(document.activeElement)))
        )) {
            flush();
            return;
        }

        const isBoundary = node !== surface && isStreamingRunBoundaryElement(node);
        if (isBoundary) flush();
        Array.from(node.childNodes || []).forEach(walk);
        if (isBoundary) flush();
    };

    walk(surface);
    flush();
    return runs;
}

function collectStreamingSurfaceText(surface) {
    let text = '';
    const walk = (node) => {
        if (node?.nodeType === Node.TEXT_NODE) {
            text += node.nodeValue || '';
            return;
        }
        Array.from(node?.childNodes || []).forEach(walk);
    };
    walk(surface);
    return text;
}

export function collectStreamingRunText(run) {
    return run.reduce((text, node) => text + String(node?.nodeValue || ''), '');
}

function getDashProjectionAuthorization(processors) {
    let trailing = false;
    let crossParagraph = false;

    for (const processor of processors) {
        if (processor?.kind !== 'regex'
            || !Array.isArray(processor.replacements)
            || processor.replacements.length !== 1
            || String(processor.replacements[0]) !== '，') continue;

        if (processor.regex?.source === trailingDashBetweenChineseSource) trailing = true;
        if (processor.regex?.source === crossParagraphDashBetweenChineseSource) {
            trailing = true;
            crossParagraph = true;
        }
    }

    return { trailing, crossParagraph };
}

function splitDashProjectionSourceLines(rawText) {
    const lines = [];
    const newlinePattern = /\n+/g;
    let start = 0;
    let match;

    while (match = newlinePattern.exec(rawText)) {
        lines.push({ text: rawText.slice(start, match.index), start });
        start = match.index + match[0].length;
    }
    lines.push({ text: rawText.slice(start), start });
    return lines;
}

function getStreamingRunBoundaryContainer(run, surface) {
    let element = run[0]?.parentElement || run[0]?.parentNode;
    while (element && element !== surface) {
        if (isStreamingRunBoundaryElement(element)) return element;
        element = element.parentElement || element.parentNode;
    }
    return surface;
}

function canProjectAcrossStreamingRuns(leftRun, rightRun, surface) {
    const leftContainer = getStreamingRunBoundaryContainer(leftRun, surface);
    const rightContainer = getStreamingRunBoundaryContainer(rightRun, surface);
    if (!leftContainer || !rightContainer || leftContainer === rightContainer || leftContainer === surface || rightContainer === surface) {
        return false;
    }
    if (leftContainer.parentNode !== rightContainer.parentNode) return false;

    const siblings = Array.from(leftContainer.parentNode?.childNodes || []);
    const leftIndex = siblings.indexOf(leftContainer);
    const rightIndex = siblings.indexOf(rightContainer);
    if (leftIndex < 0 || rightIndex <= leftIndex) return false;

    return siblings.slice(leftIndex + 1, rightIndex).every((node) => (
        node?.nodeType === Node.TEXT_NODE && String(node.nodeValue || '').trim() === ''
    ));
}

function isDashProjectionRangeAllowed(range, scopedRanges) {
    if (scopedRanges === null) return true;
    return scopedRanges.some((allowed) => allowed.start <= range.start && allowed.end >= range.end);
}

function applyStreamingSymbolEdits(run, edits) {
    if (edits.length === 0) return false;
    const snapshot = buildNodeRangeSnapshot(run);
    const segment = {
        nodes: run,
        startNode: run[0],
        startOffset: 0,
        endNode: run[run.length - 1],
        endOffset: run[run.length - 1]?.nodeValue?.length || 0,
    };
    const nodeValues = run.map((node) => node?.nodeValue || '');
    edits.slice().sort((left, right) => right.start - left.start).forEach((edit) => {
        replaceStreamingRange(segment, snapshot, nodeValues, edit);
    });

    let changed = false;
    run.forEach((node, index) => {
        if (node.nodeValue === nodeValues[index]) return;
        node.nodeValue = nodeValues[index];
        changed = true;
    });
    return changed;
}

function projectSingleNodeTrailingDash(rawSource, currentValue, processors) {
    if (!getDashProjectionAuthorization(processors).trailing) return currentValue;
    const visibleRawText = stripStreamingWrapperTags(rawSource);
    if (visibleRawText.includes('\n')) return currentValue;
    const rawMatch = visibleRawText.match(/(?<=[\u4e00-\u9fff])—+$/u);
    const currentMatch = currentValue.match(/(?<=[\u4e00-\u9fff])—+$/u);
    if (!rawMatch || !currentMatch) return currentValue;

    const scopedRanges = hasEnabledScopeTags() ? projectStreamingScopeRanges(rawSource) : null;
    const rawRange = { start: rawMatch.index, end: rawMatch.index + rawMatch[0].length };
    if (!isDashProjectionRangeAllowed(rawRange, scopedRanges)) return currentValue;
    return currentValue.slice(0, currentMatch.index) + '，';
}

export function applyDashPunctuationProjection(surface, runs, initialRunTexts, rawSource, processors) {
    const authorization = getDashProjectionAuthorization(processors);
    if (!authorization.trailing || runs.length === 0) return false;

    const scopeTagsEnabled = hasEnabledScopeTags();
    let changed = false;
    if (streamingRuntimeState.isStreamingGeneration === true && !scopeTagsEnabled) {
        for (let index = 0; index < runs.length; index++) {
            if (!/(?<=[\u4e00-\u9fff])—+$/u.test(initialRunTexts[index] || '')) continue;
            const currentText = collectStreamingRunText(runs[index]);
            const match = currentText.match(/(?<=[\u4e00-\u9fff])—+$/u);
            if (!match) continue;
            changed = applyStreamingSymbolEdits(runs[index], [{
                start: match.index,
                end: match.index + match[0].length,
                replacement: '，',
            }]) || changed;
        }
    }

    const visibleRawText = stripStreamingWrapperTags(rawSource);
    const sourceLines = splitDashProjectionSourceLines(visibleRawText);
    if (sourceLines.length !== runs.length) return changed;

    const plans = sourceLines.map(() => ({ trailing: null, leading: null }));
    for (let index = 0; index < sourceLines.length; index++) {
        const sourceLine = sourceLines[index];
        const trailingMatch = sourceLine.text.match(/(?<=[\u4e00-\u9fff])—+$/u);
        if (trailingMatch && (index === sourceLines.length - 1
            || canProjectAcrossStreamingRuns(runs[index], runs[index + 1], surface))) {
            plans[index].trailing = {
                start: trailingMatch.index,
                end: trailingMatch.index + trailingMatch[0].length,
                sourceStart: sourceLine.start + trailingMatch.index,
                sourceEnd: sourceLine.start + trailingMatch.index + trailingMatch[0].length,
            };
        }

        if (!authorization.crossParagraph || index === 0) continue;
        const previousLine = sourceLines[index - 1];
        const leadingMatch = sourceLine.text.match(/^—+(?=[\u4e00-\u9fff])/u);
        if (!leadingMatch
            || !/(?<=[\u4e00-\u9fff])—+$/u.test(previousLine.text)
            || !canProjectAcrossStreamingRuns(runs[index - 1], runs[index], surface)) continue;
        plans[index].leading = {
            start: 0,
            end: leadingMatch[0].length,
            sourceStart: sourceLine.start,
            sourceEnd: sourceLine.start + leadingMatch[0].length,
        };
    }

    const projectedSourceLines = sourceLines.map((line, index) => {
        let value = line.text;
        if (plans[index].trailing) value = value.slice(0, plans[index].trailing.start) + '，';
        if (plans[index].leading) value = value.slice(plans[index].leading.end);
        return value;
    });
    const hasExactCorrespondence = initialRunTexts.every((value, index) => (
        value === sourceLines[index].text || value === projectedSourceLines[index]
    ));
    if (!hasExactCorrespondence) return changed;

    const scopedRanges = scopeTagsEnabled ? projectStreamingScopeRanges(rawSource) : null;
    for (let index = 0; index < runs.length; index++) {
        const currentText = collectStreamingRunText(runs[index]);
        const edits = [];
        const trailing = plans[index].trailing;
        if (trailing && isDashProjectionRangeAllowed({ start: trailing.sourceStart, end: trailing.sourceEnd }, scopedRanges)) {
            const match = currentText.match(/(?<=[\u4e00-\u9fff])—+$/u);
            if (match) edits.push({ start: match.index, end: match.index + match[0].length, replacement: '，' });
        }
        const leading = plans[index].leading;
        if (leading && isDashProjectionRangeAllowed({ start: leading.sourceStart, end: leading.sourceEnd }, scopedRanges)) {
            const match = currentText.match(/^—+(?=[\u4e00-\u9fff])/u);
            if (match) edits.push({ start: 0, end: match[0].length, replacement: '' });
        }
        changed = applyStreamingSymbolEdits(runs[index], edits) || changed;
    }
    return changed;
}

function buildNodeRangeSnapshot(nodes, startNode = null, startOffset = 0, endNode = null, endOffset = 0) {
    const firstIndex = startNode ? nodes.indexOf(startNode) : 0;
    const lastIndex = endNode ? nodes.indexOf(endNode) : nodes.length - 1;
    const ranges = [];
    let text = '';

    for (let index = firstIndex; index <= lastIndex; index++) {
        const node = nodes[index];
        const value = node?.nodeValue || '';
        const localStart = node === startNode ? startOffset : 0;
        const localEnd = node === endNode ? endOffset : value.length;
        const slice = value.slice(localStart, localEnd);
        ranges.push({
            node,
            nodeIndex: index,
            localStart,
            localEnd,
            globalStart: text.length,
            globalEnd: text.length + slice.length,
        });
        text += slice;
    }

    return { text, ranges };
}

function locateRangeStart(ranges, offset) {
    for (const range of ranges) {
        if (offset === range.globalStart) {
            return { node: range.node, nodeIndex: range.nodeIndex, offset: range.localStart };
        }
        if (offset < range.globalEnd) {
            return { node: range.node, nodeIndex: range.nodeIndex, offset: range.localStart + offset - range.globalStart };
        }
    }
    const last = ranges[ranges.length - 1];
    return last ? { node: last.node, nodeIndex: last.nodeIndex, offset: last.localEnd } : null;
}

function locateRangeEnd(ranges, offset) {
    for (const range of ranges) {
        if (offset > range.globalStart && offset <= range.globalEnd) {
            return { node: range.node, nodeIndex: range.nodeIndex, offset: range.localStart + offset - range.globalStart };
        }
    }
    return locateRangeStart(ranges, offset);
}

function createStreamingSegment(nodes, runSnapshot, range) {
    const start = locateRangeStart(runSnapshot.ranges, range.start);
    const end = locateRangeEnd(runSnapshot.ranges, range.end);
    if (!start || !end) return null;
    return {
        nodes: nodes.slice(start.nodeIndex, end.nodeIndex + 1),
        startNode: start.node,
        startOffset: start.offset,
        endNode: end.node,
        endOffset: end.offset,
    };
}

function collectProcessorMatches(text, processor, processorIndex) {
    const matches = [];
    text.replace(processor.regex, (match, ...args) => {
        const hasNamedGroups = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null;
        const offset = Number(args[args.length - (hasNamedGroups ? 3 : 2)]);
        const replacement = String(resolveProcessorReplacement(processor, processorIndex, match, args, true) ?? '');
        if (replacement === match) return match;
        matches.push({
            start: offset,
            end: offset + match.length,
            replacement,
        });
        return match;
    });
    return matches;
}

function insertAtStreamingOffset(segment, snapshot, nodeValues, offset, replacement) {
    const location = locateRangeStart(snapshot.ranges, offset);
    if (!location) return;
    const value = nodeValues[location.nodeIndex];
    nodeValues[location.nodeIndex] = value.slice(0, location.offset) + replacement + value.slice(location.offset);
    if (location.node === segment.endNode && location.offset <= segment.endOffset) {
        segment.endOffset += replacement.length;
    }
}

function replaceStreamingRange(segment, snapshot, nodeValues, match) {
    if (match.start === match.end) {
        insertAtStreamingOffset(segment, snapshot, nodeValues, match.start, match.replacement);
        return;
    }

    const start = locateRangeStart(snapshot.ranges, match.start);
    const end = locateRangeEnd(snapshot.ranges, match.end);
    if (!start || !end) return;

    if (start.node === end.node) {
        const value = nodeValues[start.nodeIndex];
        nodeValues[start.nodeIndex] = value.slice(0, start.offset) + match.replacement + value.slice(end.offset);
        if (start.node === segment.endNode && start.offset < segment.endOffset) {
            segment.endOffset += match.replacement.length - (end.offset - start.offset);
        }
        return;
    }

    const startValue = nodeValues[start.nodeIndex];
    const endValue = nodeValues[end.nodeIndex];
    nodeValues[start.nodeIndex] = startValue.slice(0, start.offset) + match.replacement;
    for (let index = start.nodeIndex + 1; index < end.nodeIndex; index++) {
        nodeValues[index] = '';
    }
    nodeValues[end.nodeIndex] = endValue.slice(end.offset);
    if (end.node === segment.endNode) segment.endOffset -= end.offset;
}

function applyStreamingMaskToRun(nodes, processors, scopedRanges = null) {
    if (scopedRanges === null && nodes.length === 1) {
        const node = nodes[0];
        let changed = false;

        processors.forEach((processor, processorIndex) => {
            const currentValue = node.nodeValue || '';
            let processorChanged = false;
            const nextValue = currentValue.replace(processor.regex, (match, ...args) => {
                const replacement = String(resolveProcessorReplacement(processor, processorIndex, match, args, true) ?? '');
                if (replacement !== match) processorChanged = true;
                return replacement;
            });
            if (nextValue !== currentValue) node.nodeValue = nextValue;
            changed = processorChanged || changed;
        });

        return changed;
    }

    const runSnapshot = buildNodeRangeSnapshot(nodes);
    const ranges = scopedRanges || [{ start: 0, end: runSnapshot.text.length }];
    const segments = ranges
        .map((range) => createStreamingSegment(nodes, runSnapshot, range))
        .filter(Boolean)
        .reverse();
    let changed = false;

    for (const segment of segments) {
        processors.forEach((processor, processorIndex) => {
            const snapshot = buildNodeRangeSnapshot(
                segment.nodes,
                segment.startNode,
                segment.startOffset,
                segment.endNode,
                segment.endOffset,
            );
            const matches = collectProcessorMatches(snapshot.text, processor, processorIndex);
            if (matches.length === 0) return;
            const nodeValues = segment.nodes.map((node) => node?.nodeValue || '');
            for (let index = matches.length - 1; index >= 0; index--) {
                replaceStreamingRange(segment, snapshot, nodeValues, matches[index]);
            }
            segment.nodes.forEach((node, index) => {
                if (node.nodeValue !== nodeValues[index]) node.nodeValue = nodeValues[index];
            });
            changed = true;
        });
    }
    return changed;
}

function projectStreamingScopeRanges(rawText) {
    const rawRanges = collectScopedReplacementRanges(rawText);
    return rawRanges
        .map((range) => ({
            start: stripStreamingWrapperTags(rawText.slice(0, range.start)).length,
            end: stripStreamingWrapperTags(rawText.slice(0, range.end)).length,
        }))
        .filter((range) => range.end > range.start);
}

function applyScopedStreamingRuns(runs, processors, scopedRanges) {
    let globalOffset = 0;
    let changed = false;

    for (const run of runs) {
        const runLength = run.reduce((length, node) => length + String(node?.nodeValue || '').length, 0);
        const runEnd = globalOffset + runLength;
        const localRanges = scopedRanges
            .map((range) => ({
                start: Math.max(range.start, globalOffset) - globalOffset,
                end: Math.min(range.end, runEnd) - globalOffset,
            }))
            .filter((range) => range.end > range.start);
        changed = applyStreamingMaskToRun(run, processors, localRanges) || changed;
        globalOffset = runEnd;
    }

    return changed;
}

export function applyStreamingVisualMask(surface, rawSource, cleanSource, options = {}) {
    if (!surface) return false;
    const rawText = String(rawSource || '');
    const cleanText = String(cleanSource || '');
    if (!rulesRuntimeState.isRegexDirty
        && rulesRuntimeState.activeVisualProcessors.length === 0
        && rawText === cleanText) return false;
    const runs = collectStreamingTextRuns(surface);
    const initialRunTexts = runs.map((run) => collectStreamingRunText(run));
    const eligibleTextNodes = runs.flat();
    const currentVisibleText = eligibleTextNodes.map((node) => node.nodeValue || '').join('');
    const currentSurfaceText = collectStreamingSurfaceText(surface);
    const visibleRawText = stripStreamingWrapperTags(rawText);
    const visibleCleanText = stripStreamingWrapperTags(cleanText);
    const ordinaryProjectionComplete = visibleCleanText !== visibleRawText && currentSurfaceText === visibleCleanText;
    const ordinarySourceCorrespondence = options.requireSourceCorrespondence !== true
        || currentSurfaceText === visibleRawText
        || currentSurfaceText === visibleCleanText;

    const processors = buildProcessors({ includeAiRewrite: true });
    const streamingProcessors = processors.filter((processor) => (
        isStreamingVisualProcessorSafe(processor, {
            anchorsChangeSemantics: runs.length !== 1 || currentVisibleText !== visibleRawText,
        })
    ));

    let ordinaryChanged = false;
    let singleNodeProjectionComplete = ordinaryProjectionComplete;
    if (!singleNodeProjectionComplete
        && ordinarySourceCorrespondence
        && eligibleTextNodes.length === 1
        && streamingProcessors.length === processors.length) {
        const textNode = eligibleTextNodes[0];
        const currentText = textNode.nodeValue || '';
        const projectedText = resolveSingleNodeStreamingProjection(rawText, cleanText, currentText);
        if (projectedText !== null && projectedText !== currentText) {
            textNode.nodeValue = projectSingleNodeTrailingDash(rawText, projectedText, processors);
            ordinaryChanged = true;
            singleNodeProjectionComplete = true;
        }
    }

    if (hasEnabledScopeTags()) {
        if (currentVisibleText !== visibleRawText) return false;
        const changed = singleNodeProjectionComplete
            ? ordinaryChanged
            : ordinarySourceCorrespondence
            ? applyScopedStreamingRuns(runs, streamingProcessors, projectStreamingScopeRanges(rawText))
            : false;
        return applyDashPunctuationProjection(surface, runs, initialRunTexts, rawText, processors) || changed;
    }
    const changed = singleNodeProjectionComplete
        ? ordinaryChanged
        : ordinarySourceCorrespondence
        ? runs.reduce((runChanged, run) => applyStreamingMaskToRun(run, streamingProcessors) || runChanged, false)
        : false;
    return applyDashPunctuationProjection(surface, runs, initialRunTexts, rawText, processors) || changed;
}

export function renderStreamingVisualMask(messageId, committedRawText, options = {}) {
    const index = Number(messageId);
    if (!Number.isInteger(index) || index < 0 || streamingRuntimeState.isStreamingGeneration !== true) return false;

    const messageNode = getMessageDomNode(index);
    if (!messageNode || isRevertedMessageDomNode(messageNode) || isManualFinalMessageDomNode(messageNode)) return false;
    const surface = findTavernHelperStreamingSurface(messageNode) || messageNode.querySelector?.('.mes_text');
    const rawText = String(committedRawText || '');
    return applyStreamingVisualMask(surface, rawText, applyVisualMask(rawText), options);
}

export function replayStreamingVisualMask(messageId) {
    const index = Number(messageId);
    if (!streamingRuntimeState.streamingCommittedMessageCache.has(index)) return false;
    return renderStreamingVisualMask(index, streamingRuntimeState.streamingCommittedMessageCache.get(index), {
        requireSourceCorrespondence: true,
    });
}

/**
 * 根据消息索引获取对应 DOM 节点。
 * @param {number} index 消息索引。
 * @returns {Element | null} 对应消息节点，找不到时返回 null。
 */
