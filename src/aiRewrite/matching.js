/*
 * Owns AI Rule matcher compilation, source-scope matching, Program fallback
 * transformation for matched ranges, and rewrite-item construction. It does
 * not issue AI requests, own generation/task state, mutate messages, or
 * persist chat data.
 */

import { logger } from '../log.js';
import { buildSimpleTargetPattern, buildTargetLiteralPattern, pickReplacement, resolveProcessorReplacement } from '../rules/engine.js';
import { compileRegexTarget } from '../rules/regex.js';
import { normalizeOptionalXmlTagNameInput } from '../scope/model.js';
import { getZhVariantCompatOptions, isZhDictionaryReady } from '../zh/dictionary.js';
import { collectXmlCommentRanges, maskXmlCommentRanges } from './commentProtection.js';
import { collectScopeRanges } from './planning.js';

export function getAiXmlScopeTag(aiSettings) {
    const tagName = normalizeOptionalXmlTagNameInput(aiSettings?.xmlScopeTag, 'content');
    return {
        wholeMessage: tagName === '',
        tagName,
        startTag: tagName ? `<${tagName}>` : '',
        endTag: tagName ? `</${tagName}>` : '',
    };
}

export function escapeRegExp(value = '') {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function collectAiXmlScopeSegments(text, aiSettings) {
    const source = String(text || '');
    const commentRanges = aiSettings?.protectXmlComments === true ? collectXmlCommentRanges(source) : [];
    const searchSource = commentRanges.length > 0 ? maskXmlCommentRanges(source, commentRanges) : source;
    const { wholeMessage, tagName } = getAiXmlScopeTag(aiSettings);
    if (wholeMessage) {
        return source.length > 0 ? [{
            index: 0,
            start: 0,
            end: source.length,
            outerStart: 0,
            outerEnd: source.length,
        }] : [];
    }
    const escapedTagName = escapeRegExp(tagName);
    const startRegex = new RegExp(`<\\s*${escapedTagName}(?:\\s+[^<>]*)?\\s*>`, 'giu');
    const endRegex = new RegExp(`<\\s*/\\s*${escapedTagName}\\s*>`, 'giu');
    const segments = [];
    let startMatch;

    while ((startMatch = startRegex.exec(searchSource)) !== null) {
        const bodyStart = startRegex.lastIndex;
        endRegex.lastIndex = bodyStart;

        const endMatch = endRegex.exec(searchSource);
        const endIndex = endMatch?.index ?? -1;
        if (endIndex < 0) break;

        if (endIndex > bodyStart) {
            segments.push({
                index: segments.length,
                start: bodyStart,
                end: endIndex,
                outerStart: startMatch.index,
                outerEnd: endRegex.lastIndex,
            });
        }
        startRegex.lastIndex = endRegex.lastIndex;
    }

    return segments;
}

export function getAiXmlScopedRequestText(text, aiSettings) {
    const source = String(text || '');
    const segments = collectAiXmlScopeSegments(source, aiSettings);
    if (segments.length === 0) return source;
    return segments
        .map((segment) => source.slice(segment.outerStart, segment.outerEnd))
        .join('\n');
}

function rangeOverlaps(aStart, aEnd, bStart, bEnd) {
    return aStart < bEnd && bStart < aEnd;
}

function rangeOverlapsAny(start, end, ranges) {
    return ranges.some((range) => rangeOverlaps(start, end, range.start, range.end));
}

function intersectRanges(leftRanges, rightRanges) {
    const intersections = [];
    for (const left of leftRanges) {
        for (const right of rightRanges) {
            const start = Math.max(left.start, right.start);
            const end = Math.min(left.end, right.end);
            if (start < end) intersections.push({ start, end });
        }
    }
    return intersections.sort((left, right) => left.start - right.start || left.end - right.end);
}

function subtractRanges(sourceRanges, excludedRanges) {
    const excluded = [...excludedRanges]
        .filter((range) => Number.isInteger(range?.start) && Number.isInteger(range?.end) && range.start < range.end)
        .sort((left, right) => left.start - right.start || left.end - right.end);
    const remaining = [];

    for (const sourceRange of sourceRanges) {
        let cursor = sourceRange.start;
        for (const excludedRange of excluded) {
            if (excludedRange.end <= cursor) continue;
            if (excludedRange.start >= sourceRange.end) break;
            if (excludedRange.start > cursor) {
                remaining.push({ start: cursor, end: Math.min(excludedRange.start, sourceRange.end) });
            }
            cursor = Math.max(cursor, excludedRange.end);
            if (cursor >= sourceRange.end) break;
        }
        if (cursor < sourceRange.end) remaining.push({ start: cursor, end: sourceRange.end });
    }

    return remaining;
}

const sentenceTerminators = new Set(['。', '！', '？', '!', '?']);
const sentenceContinuationPunctuation = new Set(['。', '！', '？', '!', '?', '…']);

function splitEditableRangeIntoSentences(text, range) {
    const sentences = [];
    let sentenceStart = range.start;
    let cursor = range.start;
    const pushSentence = (end) => {
        if (sentenceStart < end) sentences.push({ start: sentenceStart, end });
        sentenceStart = end;
    };

    while (cursor < range.end) {
        const char = text[cursor];
        if (char === '\r' || char === '\n') {
            pushSentence(cursor);
            cursor += char === '\r' && text[cursor + 1] === '\n' ? 2 : 1;
            sentenceStart = cursor;
            continue;
        }
        // A single sentence-final period is distinct from an ellipsis or a decimal.
        const isPeriodTerminator = char === '.'
            && text[cursor - 1] !== '.'
            && text[cursor + 1] !== '.'
            && (cursor + 1 === range.end || /[\s”’」』）)*]/u.test(text[cursor + 1]));
        if (sentenceTerminators.has(char) || isPeriodTerminator) {
            let end = cursor + 1;
            while (end < range.end && sentenceContinuationPunctuation.has(text[end])) end += 1;
            pushSentence(end);
            cursor = end;
            continue;
        }
        cursor += 1;
    }
    pushSentence(range.end);
    return sentences;
}

function collectCodeRanges(text) {
    const ranges = [];
    const fenceRegex = /```[\s\S]*?```/g;
    let fenceMatch;
    while ((fenceMatch = fenceRegex.exec(text)) !== null) {
        ranges.push({ start: fenceMatch.index, end: fenceMatch.index + fenceMatch[0].length });
        if (fenceMatch[0].length === 0) fenceRegex.lastIndex += 1;
    }

    for (let index = 0; index < text.length; index++) {
        if (text[index] !== '`' || rangeOverlapsAny(index, index + 1, ranges)) continue;
        const endIndex = text.indexOf('`', index + 1);
        if (endIndex < 0) break;
        if (!text.slice(index + 1, endIndex).includes('\n')) {
            ranges.push({ start: index, end: endIndex + 1 });
        }
        index = endIndex;
    }

    return ranges.sort((a, b) => a.start - b.start);
}

export function compileAiMatchers(settings, options = {}) {
    const hasExplicitZhCompatibility = Object.hasOwn(options, 'useZhVariantCompat');
    const useZhVariantCompat = hasExplicitZhCompatibility
        ? options.useZhVariantCompat === true
        : settings.zhVariantCompatEnabled === true && isZhDictionaryReady(settings);
    const zhVariantOptions = options.zhVariantOptions || getZhVariantCompatOptions(settings);
    const matchers = [];

    (settings.rules || []).forEach((rule, ruleIndex) => {
        if (!rule || rule.enabled === false) return;
        (rule.subRules || []).forEach((subRule, subRuleIndex) => {
            if (!subRule || subRule.enabled === false || subRule.rewriteMode !== 'ai') return;
            const mode = subRule.mode || 'text';
            const targets = Array.isArray(subRule.targets) ? subRule.targets : [];
            const replacements = Array.isArray(subRule.replacements) ? subRule.replacements : [];
            const ruleLabel = subRule.remark || rule.name || `合集 ${ruleIndex + 1}`;
            const base = {
                ruleIndex,
                subRuleIndex,
                ruleName: rule.name || '',
                ruleLabel,
                mode,
                replacements,
                aiPromptTemplate: String(subRule.aiPromptTemplate || ''),
            };

            targets.forEach((target) => {
                const normalizedTarget = String(target || '');
                if (!normalizedTarget) return;
                try {
                    if (mode === 'regex') {
                        const compiled = compileRegexTarget(normalizedTarget);
                        if (!compiled.ok) {
                            logger.warn(`AI 改写忽略非法正则表达式: ${normalizedTarget} (${compiled.error.message})`);
                            return;
                        }
                        const regex = new RegExp(compiled.value.regex.source, compiled.value.regex.flags);
                        if (regex.test('')) {
                            logger.warn(`AI 改写忽略空匹配正则: ${normalizedTarget}`);
                            return;
                        }
                        regex.lastIndex = 0;
                        matchers.push({ ...base, target: normalizedTarget, regex });
                        return;
                    }

                    const pattern = mode === 'simple'
                        ? buildSimpleTargetPattern(normalizedTarget, useZhVariantCompat, zhVariantOptions)
                        : buildTargetLiteralPattern(normalizedTarget, useZhVariantCompat, zhVariantOptions);
                    const regex = new RegExp(pattern, 'gmu');
                    if (regex.test('')) {
                        logger.warn(`AI 改写忽略空匹配规则: ${normalizedTarget}`);
                        return;
                    }
                    regex.lastIndex = 0;
                    matchers.push({ ...base, target: normalizedTarget, regex });
                } catch (err) {
                    logger.warn(`AI 改写规则解析失败: ${normalizedTarget}`, err);
                }
            });
        });
    });

    return matchers;
}

export function collectAiMatches(text, settings, aiSettings, options = {}) {
    const source = String(text || '');
    const messageScoped = options.messageScoped !== false;
    const segments = messageScoped
        ? collectAiXmlScopeSegments(source, aiSettings)
        : (source.length > 0 ? [{ index: 0, start: 0, end: source.length, outerStart: 0, outerEnd: source.length }] : []);
    if (segments.length === 0) return [];
    const codeRanges = collectCodeRanges(source);
    const commentRanges = aiSettings.protectXmlComments === true ? collectXmlCommentRanges(source) : [];
    const scopeScanText = commentRanges.length > 0 ? maskXmlCommentRanges(source, commentRanges) : source;
    const scopeRanges = collectScopeRanges(scopeScanText, settings);
    const scopeTagMode = settings.scopeTagMode === 'cleanse-inside' ? 'cleanse-inside' : 'protect';
    const isAllowedByScope = (start, end) => {
        if (scopeTagMode === 'cleanse-inside') {
            return scopeRanges.some((range) => start >= range.bodyStart && end <= range.bodyEnd);
        }
        return !rangeOverlapsAny(start, end, scopeRanges);
    };
    const matches = [];

    const matchers = Array.isArray(options.compiledMatchers)
        ? options.compiledMatchers
        : compileAiMatchers(settings, options);
    for (const matcher of matchers) {
        for (const segment of segments) {
            matcher.regex.lastIndex = segment.start;
            let match;
            while ((match = matcher.regex.exec(source)) !== null) {
                const matchedText = String(match[0] || '');
                const start = match.index;
                const end = start + matchedText.length;
                if (start >= segment.end) break;
                if (end > segment.end) {
                    if (matchedText.length === 0) matcher.regex.lastIndex += 1;
                    continue;
                }
                if (!matchedText || end <= start) {
                    matcher.regex.lastIndex += 1;
                    continue;
                }
                if (isAllowedByScope(start, end)
                    && !rangeOverlapsAny(start, end, codeRanges)
                    && !rangeOverlapsAny(start, end, commentRanges)) {
                    matches.push({
                        ...matcher,
                        matchedText,
                        captures: match.slice(1),
                        groups: match.groups && typeof match.groups === 'object' ? { ...match.groups } : null,
                        start,
                        end,
                    });
                }
            }
        }
    }

    return matches.sort((a, b) => a.start - b.start || a.end - b.end);
}

function getAiProgramFallbackReplacement(match, sourceText = '') {
    const replacements = Array.isArray(match?.replacements) ? match.replacements : [];
    if (replacements.length === 0) return '';

    if (match.mode === 'regex') {
        const args = [
            ...(Array.isArray(match.captures) ? match.captures : []),
            Number(match.start) || 0,
            String(sourceText || ''),
        ];
        if (match.groups && typeof match.groups === 'object') args.push(match.groups);
        return resolveProcessorReplacement({ kind: 'regex', replacements }, String(match.matchedText || ''), args);
    }

    return String(pickReplacement(replacements) ?? '');
}

export function getOccurrenceProgramFallbackText(occurrence, sourceText) {
    // Automatic tasks select only on fallback; retain even deletion for later finalization.
    if (occurrence.programFallbackText === undefined) {
        occurrence.programFallbackText = getAiProgramFallbackReplacement(occurrence, sourceText);
    }
    return occurrence.programFallbackText;
}

export function applyAiProgramFallbackMatches(text, matches = []) {
    const source = String(text || '');
    if (!source || !Array.isArray(matches) || matches.length === 0) return source;

    const sorted = [...matches]
        .filter((match) => Number.isFinite(Number(match?.start)) && Number.isFinite(Number(match?.end)) && Number(match.end) > Number(match.start))
        .sort((a, b) => Number(b.start) - Number(a.start) || Number(b.end) - Number(a.end));
    const appliedRanges = [];
    let output = source;

    for (const match of sorted) {
        const start = Math.max(0, Math.min(output.length, Number(match.start)));
        const end = Math.max(start, Math.min(output.length, Number(match.end)));
        if (appliedRanges.some((range) => start < range.end && range.start < end)) continue;
        if (output.slice(start, end) !== String(match.matchedText || '')) continue;

        const replacement = getAiProgramFallbackReplacement(match, source);
        output = output.slice(0, start) + replacement + output.slice(end);
        appliedRanges.push({ start, end });
    }

    return output;
}

function collectEditableRanges(text, settings, aiSettings) {
    const source = String(text || '');
    const xmlSegments = collectAiXmlScopeSegments(source, aiSettings);
    if (xmlSegments.length === 0) return [];

    const commentRanges = aiSettings?.protectXmlComments === true ? collectXmlCommentRanges(source) : [];
    const scopeScanText = commentRanges.length > 0 ? maskXmlCommentRanges(source, commentRanges) : source;
    const scopeRanges = collectScopeRanges(scopeScanText, settings);
    const scopeTagMode = settings?.scopeTagMode === 'cleanse-inside' ? 'cleanse-inside' : 'protect';
    const xmlBodies = xmlSegments.map((segment) => ({ start: segment.start, end: segment.end }));
    const scopeEditable = scopeTagMode === 'cleanse-inside'
        ? intersectRanges(xmlBodies, scopeRanges.map((range) => ({ start: range.bodyStart, end: range.bodyEnd })))
        : subtractRanges(xmlBodies, scopeRanges.map((range) => ({ start: range.start, end: range.end })));
    const editable = subtractRanges(scopeEditable, [
        ...collectCodeRanges(source),
        ...commentRanges,
    ]);

    return editable;
}

function addDelimitedSentenceWrappers(text, range, open, close, wrappers) {
    let cursor = range.start;
    while (cursor < range.end) {
        const openStart = text.indexOf(open, cursor);
        if (openStart < 0 || openStart >= range.end) break;
        const closeStart = text.indexOf(close, openStart + open.length);
        if (closeStart < 0 || closeStart >= range.end) break;
        wrappers.push({
            start: openStart,
            end: closeStart + close.length,
            interiorStart: openStart + open.length,
            interiorEnd: closeStart,
        });
        cursor = closeStart + close.length;
    }
}

function addAsteriskSentenceWrappers(text, range, marker, wrappers) {
    const markers = [];
    for (let cursor = range.start; cursor < range.end;) {
        const token = text.startsWith('**', cursor) ? '**' : text[cursor] === '*' ? '*' : '';
        if (!token) {
            cursor += 1;
            continue;
        }
        if (token === marker) markers.push(cursor);
        cursor += token.length;
    }
    for (let index = 0; index + 1 < markers.length; index += 2) {
        const openStart = markers[index];
        const closeStart = markers[index + 1];
        wrappers.push({
            start: openStart,
            end: closeStart + marker.length,
            interiorStart: openStart + marker.length,
            interiorEnd: closeStart,
        });
    }
}

function collectSentenceWrappers(text, range) {
    const wrappers = [];
    addDelimitedSentenceWrappers(text, range, '“', '”', wrappers);
    addDelimitedSentenceWrappers(text, range, '‘', '’', wrappers);
    addDelimitedSentenceWrappers(text, range, '「', '」', wrappers);
    addDelimitedSentenceWrappers(text, range, '『', '』', wrappers);
    addDelimitedSentenceWrappers(text, range, '（', '）', wrappers);
    addDelimitedSentenceWrappers(text, range, '(', ')', wrappers);
    addAsteriskSentenceWrappers(text, range, '*', wrappers);
    addAsteriskSentenceWrappers(text, range, '**', wrappers);
    return wrappers;
}

function getSentenceSpan(text, match, range, wrappers = []) {
    const sentences = splitEditableRangeIntoSentences(text, range);
    const first = sentences.find((sentence) => match.start >= sentence.start && match.start < sentence.end);
    const last = [...sentences].reverse().find((sentence) => match.end > sentence.start && match.end <= sentence.end);
    if (!first || !last) return { start: match.start, end: match.end };

    let start = first.start;
    let advanced = true;
    while (advanced) {
        const precedingClosers = wrappers.filter((wrapper) => wrapper.interiorEnd === start);
        const nextStart = precedingClosers.length > 0 ? Math.max(...precedingClosers.map((wrapper) => wrapper.end)) : start;
        advanced = nextStart > start && nextStart <= match.start;
        if (advanced) start = nextStart;
    }

    let end = last.end;
    let extended = true;
    while (extended) {
        const targetClosers = wrappers.filter((wrapper) => wrapper.start >= start
            && wrapper.start < end
            && wrapper.interiorEnd === end);
        const nextEnd = targetClosers.length > 0 ? Math.max(...targetClosers.map((wrapper) => wrapper.end)) : end;
        extended = nextEnd > end;
        if (extended) end = nextEnd;
    }
    while (start < match.start && /\s/u.test(text[start])) start += 1;
    while (end > match.end && /\s/u.test(text[end - 1])) end -= 1;
    return { start, end };
}

function getTextUnitSentences(text, range) {
    return splitEditableRangeIntoSentences(text, range)
        .filter((sentence) => text.slice(sentence.start, sentence.end)
            .replace(/[“”‘’「」『』（）()*]/gu, '')
            .trim() !== '');
}

function getRewriteTargetRange(text, match, editableRange) {
    const wrappers = collectSentenceWrappers(text, editableRange);
    const containing = wrappers
        .filter((wrapper) => match.start >= wrapper.interiorStart && match.end <= wrapper.interiorEnd)
        .map((wrapper) => ({
            wrapper,
            interiorRange: { start: wrapper.interiorStart, end: wrapper.interiorEnd },
        }));
    const multiSentenceWrapper = containing
        .map((entry) => ({
            ...entry,
            sentenceCount: getTextUnitSentences(text, entry.interiorRange).length,
        }))
        .filter((entry) => entry.sentenceCount > 1)
        .sort((left, right) => (left.wrapper.end - left.wrapper.start) - (right.wrapper.end - right.wrapper.start))[0];
    const targetRange = { ...(multiSentenceWrapper?.interiorRange || editableRange) };
    // Neighboring wrapped prose is a separate unit, even without a sentence terminator.
    for (const wrapper of wrappers) {
        if (wrapper.end <= match.start) targetRange.start = Math.max(targetRange.start, wrapper.end);
        if (wrapper.start >= match.end) targetRange.end = Math.min(targetRange.end, wrapper.start);
    }

    return getSentenceSpan(text, match, targetRange, wrappers);
}

function coalesceOverlappingRewriteTargets(targets) {
    const coalesced = [];
    for (const target of [...targets].sort((left, right) => left.start - right.start || left.end - right.end)) {
        const previous = coalesced.at(-1);
        if (previous && target.start < previous.end) {
            previous.end = Math.max(previous.end, target.end);
            previous.matches.push(target.match);
            continue;
        }
        coalesced.push({ start: target.start, end: target.end, matches: [target.match] });
    }
    return coalesced;
}

function copyRawOccurrence(match, sentenceStart, sourceText, options) {
    return {
        ruleIndex: Number(match.ruleIndex),
        subRuleIndex: Number(match.subRuleIndex),
        aiPromptTemplate: String(match.aiPromptTemplate || ''),
        matchedText: String(match.matchedText || ''),
        relativeStart: match.start - sentenceStart,
        // Keep automatic fallback inputs without selecting a candidate on the AI path.
        ...(options.includeProgramFallback !== false
            ? { programFallbackText: getAiProgramFallbackReplacement(match, sourceText) }
            : {
                mode: match.mode,
                replacements: [...match.replacements],
                captures: match.captures,
                groups: match.groups,
                start: match.start,
            }),
    };
}

export function buildRewriteItems(text, matches, settings, aiSettings, options = {}) {
    const source = String(text || '');
    if (!Array.isArray(matches) || matches.length === 0) return [];
    const segments = collectAiXmlScopeSegments(source, aiSettings);
    const editableRanges = collectEditableRanges(source, settings, aiSettings);
    const targets = [];

    for (const match of matches) {
        const editableRange = editableRanges.find((range) => match.start >= range.start && match.end <= range.end);
        if (!editableRange) continue;
        const target = getRewriteTargetRange(source, match, editableRange);
        if (target.start > match.start || target.end < match.end || target.start >= target.end) continue;
        targets.push({ ...target, match });
    }

    return coalesceOverlappingRewriteTargets(targets)
        .map((target, index) => {
            const segment = segments.find((entry) => target.start >= entry.start && target.end <= entry.end);
            if (!segment) return null;
            return {
                id: typeof options.createId === 'function'
                    ? String(options.createId(index, target))
                    : `hit-${index + 1}`,
                segmentIndex: segment.index,
                start: target.start,
                end: target.end,
                relativeStart: target.start - segment.start,
                text: source.slice(target.start, target.end),
                matches: target.matches
                    .sort((left, right) => left.start - right.start || left.end - right.end)
                    .map((match) => copyRawOccurrence(match, target.start, source, options)),
            };
        })
        .filter(Boolean);
}

function isValidTrackedRange(range, sourceLength) {
    return Number.isInteger(range?.start)
        && Number.isInteger(range?.end)
        && range.start >= 0
        && range.end >= range.start
        && range.end <= sourceLength;
}

export function resolveRewriteTrackedRanges(sourceText, items, aiSettings) {
    const source = String(sourceText || '');
    const segments = collectAiXmlScopeSegments(source, aiSettings);
    const ranges = [];

    for (const item of Array.isArray(items) ? items : []) {
        const itemId = String(item?.id || '');
        const segment = Number.isInteger(item?.segmentIndex) ? segments[item.segmentIndex] : null;
        const relativeStart = Number(item?.relativeStart);
        const itemText = String(item?.text || '');
        const start = segment && Number.isInteger(relativeStart) ? segment.start + relativeStart : -1;
        const end = start + itemText.length;
        if (!segment
            || start < segment.start
            || end > segment.end
            || source.slice(start, end) !== itemText) {
            return { valid: false, ranges: [], failedItemId: itemId };
        }

        ranges.push({
            itemId,
            rangeType: 'sentence',
            start,
            end,
        });
        for (const [occurrenceIndex, occurrence] of (item.matches || []).entries()) {
            const occurrenceStart = start + Number(occurrence?.relativeStart);
            const matchedText = String(occurrence?.matchedText || '');
            const occurrenceEnd = occurrenceStart + matchedText.length;
            if (!Number.isInteger(occurrenceStart)
                || !Number.isInteger(occurrenceEnd)
                || occurrenceStart < start
                || occurrenceEnd > end
                || occurrenceEnd <= occurrenceStart
                || source.slice(occurrenceStart, occurrenceEnd) !== matchedText) {
                return { valid: false, ranges: [], failedItemId: itemId };
            }
            ranges.push({
                itemId,
                occurrenceIndex,
                rangeType: 'occurrence',
                start: occurrenceStart,
                end: occurrenceEnd,
            });
        }
    }

    return { valid: true, ranges, failedItemId: '' };
}

export function materializeProjectedRewriteItems(programText, items, projectedRanges) {
    const source = String(programText || '');
    const ranges = Array.isArray(projectedRanges) ? projectedRanges : [];
    const materialized = [];

    for (const item of Array.isArray(items) ? items : []) {
        const itemId = String(item?.id || '');
        const sentenceRange = ranges.find((range) => range?.rangeType === 'sentence' && range.itemId === itemId);
        if (!isValidTrackedRange(sentenceRange, source.length)) {
            return { valid: false, items: [], failedItemId: itemId };
        }
        const projectedMatches = [];
        for (const [occurrenceIndex, occurrence] of (item.matches || []).entries()) {
            const occurrenceRange = ranges.find((range) => range?.rangeType === 'occurrence'
                && range.itemId === itemId
                && range.occurrenceIndex === occurrenceIndex);
            if (!isValidTrackedRange(occurrenceRange, source.length)
                || occurrenceRange.start < sentenceRange.start
                || occurrenceRange.end > sentenceRange.end) {
                return { valid: false, items: [], failedItemId: itemId };
            }
            projectedMatches.push({
                ...occurrence,
                projectedStart: occurrenceRange.start,
                projectedEnd: occurrenceRange.end,
            });
        }
        materialized.push({
            ...item,
            start: sentenceRange.start,
            end: sentenceRange.end,
            text: source.slice(sentenceRange.start, sentenceRange.end),
            matches: projectedMatches,
        });
    }

    return { valid: true, items: materialized, failedItemId: '' };
}

export function countMatchedAiRules(matches = []) {
    return new Set(matches.map(match => `${match.ruleIndex}:${match.subRuleIndex}`)).size;
}

export function extractCurrentAiRewriteScope(text, aiSettings) {
    const source = String(text || '');
    const segments = collectAiXmlScopeSegments(source, aiSettings);
    if (segments.length === 0) {
        return { ok: false, text: '', tailLength: source.length, reason: 'content-scope-missing' };
    }
    const scopedText = getAiXmlScopedRequestText(source, aiSettings);
    return {
        ok: true,
        text: scopedText,
        tailLength: Math.max(0, source.length - scopedText.length),
        reason: '',
    };
}
