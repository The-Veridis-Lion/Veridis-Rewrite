import { extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { programRuntimeState } from './state.js';
import { logger } from '../log.js';
import { buildSimpleWildcardPattern, compileRegexTarget } from './regex.js';
import { mergeScopeTagsWithBuiltins } from '../scope/model.js';
import { buildChineseVariantPattern, getChineseTextVariantLengths } from '../zh/conversion.js';
import { getZhVariantCompatOptions, isZhDictionaryReady } from '../zh/dictionary.js';

// Program replacement transformation owner; callers own mutation and persistence.

function escapeRegExpLiteral(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTargetLiteralPattern(value = '', useZhVariantCompat = false, zhVariantOptions = {}) {
    return useZhVariantCompat ? buildChineseVariantPattern(value, zhVariantOptions) : escapeRegExpLiteral(value);
}

function buildLegacySimpleTargetPattern(target = '') {
    return String(target ?? '')
        .replace(/[.+^$()[\]\\]/g, '\\$&')
        .replace(/\{([^}]+)\}/g, (match, group) => {
            const alternatives = group.split(',').map((item) => item.trim()).filter(Boolean);
            return alternatives.length > 0 ? `(?:${alternatives.join('|')})` : match;
        })
        .replace(/\*/g, buildSimpleWildcardPattern());
}

export function buildSimpleTargetPattern(target = '', useZhVariantCompat = false, zhVariantOptions = {}) {
    if (!useZhVariantCompat) return buildLegacySimpleTargetPattern(target);

    const source = String(target ?? '');
    let pattern = '';

    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        if (char === '*') {
            pattern += buildSimpleWildcardPattern();
            continue;
        }

        if (char === '?') {
            pattern += '?';
            continue;
        }

        if (char === '{') {
            const closeIndex = source.indexOf('}', index + 1);
            if (closeIndex > index) {
                const alternatives = source
                    .slice(index + 1, closeIndex)
                    .split(/[,，]/)
                    .map((item) => item.trim())
                    .filter(Boolean)
                    .map((item) => buildTargetLiteralPattern(item, useZhVariantCompat, zhVariantOptions));
                if (alternatives.length > 0) {
                    pattern += `(?:${alternatives.join('|')})`;
                    index = closeIndex;
                    continue;
                }
            }
        }

        pattern += buildTargetLiteralPattern(char, useZhVariantCompat, zhVariantOptions);
    }

    return pattern;
}

function buildTextTargetEntries(targets, replacementsMap, useZhVariantCompat = false, zhVariantOptions = {}) {
    return [...new Set(targets)]
        .sort((a, b) => b.length - a.length)
        .map((target) => {
            const pattern = buildTargetLiteralPattern(target, useZhVariantCompat, zhVariantOptions);
            const entry = {
                target,
                replacements: replacementsMap[target] || [],
                pattern,
            };
            if (useZhVariantCompat) {
                entry.matchRegex = new RegExp(`^(?:${pattern})$`, 'mu');
                entry.matchLengths = getChineseTextVariantLengths(target, zhVariantOptions);
            }
            return entry;
        });
}

function groupTextTargetEntriesByLength(entries = []) {
    const grouped = new Map();
    entries.forEach((entry) => {
        const lengths = Array.isArray(entry.matchLengths) && entry.matchLengths.length > 0
            ? entry.matchLengths
            : [entry.target.length];
        lengths.forEach((length) => {
            const key = Number(length);
            if (!Number.isFinite(key) || key < 0) return;
            if (!grouped.has(key)) grouped.set(key, []);
            grouped.get(key).push(entry);
        });
    });
    return grouped;
}

function findTextTargetEntryForMatch(processor, match = '') {
    const candidates = processor?.targetEntriesByLength?.get(String(match).length)
        || processor?.targetEntries
        || [];
    return candidates.find((entry) => entry.matchRegex?.test(match));
}

function createProcessorBucket() {
    return {
        textTargets: [],
        wordToReplacements: Object.create(null),
        processors: [],
    };
}

function addTextTargetToBucket(bucket, target, replacements) {
    bucket.textTargets.push(target);
    bucket.wordToReplacements[target] = replacements;
}

function addProcessorToBucket(bucket, processor) {
    bucket.processors.push(processor);
}

function finalizeProcessorBucket(bucket, useZhVariantCompat, zhVariantOptions) {
    const processors = [...bucket.processors];
    if (bucket.textTargets.length > 0) {
        const targetEntries = buildTextTargetEntries(
            bucket.textTargets,
            bucket.wordToReplacements,
            useZhVariantCompat,
            zhVariantOptions,
        );
        const textRegex = new RegExp(`(${targetEntries.map((entry) => entry.pattern).join('|')})`, 'gmu');
        processors.unshift({
            regex: textRegex,
            replacerMap: bucket.wordToReplacements,
            targetEntries: useZhVariantCompat ? targetEntries : undefined,
            targetEntriesByLength: useZhVariantCompat ? groupTextTargetEntriesByLength(targetEntries) : undefined,
            kind: 'text',
        });
    }
    return processors;
}

export function compileProcessors(rules = [], options = {}) {
    const useZhVariantCompat = options.useZhVariantCompat === true;
    const zhVariantOptions = options.zhVariantOptions || {};
    const warn = typeof options.warn === 'function' ? options.warn : () => {};
    const dataBucket = createProcessorBucket();

    for (const rule of (Array.isArray(rules) ? rules : [])) {
        if (rule.enabled === false) continue;
        const subRulesToProcess = Array.isArray(rule.subRules) ? rule.subRules : [];

        for (const sub of subRulesToProcess) {
            if (!sub || typeof sub !== 'object' || sub.enabled === false) continue;
            const rewriteMode = sub.rewriteMode === 'ai' ? 'ai' : 'program';
            if (rewriteMode !== 'program') continue;

            const mode = sub.mode || 'text';
            const targets = Array.isArray(sub.targets) ? [...sub.targets] : [];
            const replacements = Array.isArray(sub.replacements) ? [...sub.replacements] : [];

            if (mode === 'text') {
                for (const t of targets) {
                    if (t) {
                        addTextTargetToBucket(dataBucket, t, replacements);
                    }
                }
            } else if (mode === 'regex') {
                for (const t of targets) {
                    if (t) {
                        const compiled = compileRegexTarget(t);
                        if (!compiled.ok) {
                            warn(`忽略非法正则表达式: ${t} (${compiled.error.message})`);
                            continue;
                        }
                        const processorBase = {
                            replacements,
                            kind: 'regex',
                        };
                        addProcessorToBucket(dataBucket, {
                            ...processorBase,
                            regex: new RegExp(compiled.value.regex.source, compiled.value.regex.flags),
                        });
                    }
                }
            } else if (mode === 'simple') {
                for (const t of targets) {
                    if (t) {
                        try {
                            const pattern = buildSimpleTargetPattern(t, useZhVariantCompat, zhVariantOptions);
                            let testRegex = new RegExp(pattern, 'gmu');
                            if (testRegex.test("")) {
                                warn(`拦截到危险的简易空匹配规则，已忽略: ${t}`);
                                continue;
                            }

                            addProcessorToBucket(dataBucket, { regex: new RegExp(pattern, 'gmu'), replacements, kind: 'simple' });
                        } catch (e) {
                            warn(`简易规则解析失败: ${t}`);
                        }
                    }
                }
            }
        }
    }

    return {
        dataProcessors: finalizeProcessorBucket(dataBucket, useZhVariantCompat, zhVariantOptions),
        textTargetCount: dataBucket.textTargets.length,
    };
}

export function buildProcessors() {
    if (!programRuntimeState.isRegexDirty) {
        return programRuntimeState.activeProcessors;
    }
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName] || {};
    const compiled = compileProcessors(settings.rules || [], {
        useZhVariantCompat: settings.zhVariantCompatEnabled === true && isZhDictionaryReady(settings),
        zhVariantOptions: getZhVariantCompatOptions(settings),
        warn: (message) => logger.warn(message),
    });

    programRuntimeState.activeProcessors = compiled.dataProcessors;
    programRuntimeState.isRegexDirty = false;
    const regexProcessorCount = programRuntimeState.activeProcessors.filter((processor) => processor.kind === 'regex').length;
    const simpleProcessorCount = programRuntimeState.activeProcessors.filter((processor) => processor.kind === 'simple').length;
    logger.info(`规则处理器构建完成，共 ${programRuntimeState.activeProcessors.length} 个数据处理器（文本:${compiled.textTargetCount} | 正则:${regexProcessorCount} | 简易:${simpleProcessorCount}）`);
    return programRuntimeState.activeProcessors;
}

/**
 * 从替换词列表中选择一个替换值。
 * @param {string[]} replacements 候选替换词列表。
 * @returns {string} 最终替换词。
 */
export function pickReplacement(replacements) {
    if (!Array.isArray(replacements) || replacements.length === 0) return '';
    const randIndex = Math.floor(Math.random() * replacements.length);
    return replacements[randIndex];
}

function extractRegexCaptures(args) {
    const hasNamedGroups = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null;
    const trailingMetaCount = hasNamedGroups ? 3 : 2;
    const captureCount = Math.max(0, args.length - trailingMetaCount);
    return args.slice(0, captureCount);
}

function renderRegexReplacementTemplate(template, captures) {
    const source = String(template ?? '');
    let output = '';

    for (let index = 0; index < source.length; index++) {
        const char = source[index];

        if (char === '\\') {
            const nextChar = source[index + 1];
            if (nextChar === undefined) {
                output += '\\';
                continue;
            }
            if (nextChar === 'n') output += '\n';
            else if (nextChar === 'r') output += '\r';
            else if (nextChar === 't') output += '\t';
            else if (nextChar === '\\') output += '\\';
            else if (nextChar === '$') output += '$';
            else output += `\\${nextChar}`;
            index++;
            continue;
        }

        if (char === '$') {
            const firstDigit = source[index + 1];
            if (/[1-9]/.test(firstDigit || '')) {
                let captureDigits = firstDigit;
                const secondDigit = source[index + 2];
                if (/\d/.test(secondDigit || '')) captureDigits += secondDigit;
                const captureIndex = Number(captureDigits) - 1;
                output += captures[captureIndex] ?? '';
                index += captureDigits.length;
                continue;
            }
        }

        output += char;
    }

    return output;
}

// Only the current Original -> Program streaming stage supplies choice memory.
// Coordinates belong to this processor's input in this scope segment, never AI/Diff.
function pickProgramCandidate(replacements, processor, match, options = {}) {
    if (replacements.length <= 1) return replacements[0] ?? '';
    const choices = options.streamingChoices;
    if (!choices) return pickReplacement(replacements);
    const start = options.occurrenceStart;
    const scopeStart = options.scopeStart || 0;
    const matchedText = String(match);
    const existing = choices.previous.find((choice) => choice.processor === processor
        && choice.scopeStart === scopeStart && choice.start === start
        && choice.matchedText === matchedText);
    const choice = existing || {
        processor, scopeStart, start, matchedText, candidate: pickReplacement(replacements),
    };
    choices.next.push(choice);
    return choice.candidate;
}

export function applyStreamingProgram(originalText, choices) {
    const frameChoices = { previous: choices, next: [] };
    const programText = applyScopedReplacements(originalText, { streamingChoices: frameChoices });
    // Retain only actual occurrences in the latest frame, not historical choices.
    choices.splice(0, choices.length, ...frameChoices.next);
    return programText;
}

export function resolveProcessorReplacement(proc, match, args = [], options = {}) {
    if (proc?.kind === 'regex') {
        const reps = proc.replacements;
        if (!reps || reps.length === 0) return '';
        const rep = pickProgramCandidate(reps, proc, match, options);
        return renderRegexReplacementTemplate(rep, extractRegexCaptures(args));
    }

    if (proc?.kind === 'simple') {
        const reps = proc.replacements;
        if (!reps || reps.length === 0) return '';
        const rep = pickProgramCandidate(reps, proc, match, options);
        return String(rep ?? '');
    }

    const exactReps = proc?.replacerMap?.[match];
    const targetEntry = exactReps ? null : findTextTargetEntryForMatch(proc, match);
    const reps = exactReps || targetEntry?.replacements;
    if (!reps || reps.length === 0) return '';
    const rep = pickProgramCandidate(reps, proc, match, options);
    return rep;
}

function projectTrackedRangesThroughReplacement(ranges, start, end, replacementLength) {
    const delta = replacementLength - (end - start);
    return ranges.map((range) => {
        if (range.end <= start) return range;
        if (range.start >= end) return { ...range, start: range.start + delta, end: range.end + delta };

        return {
            ...range,
            start: range.start < start ? range.start : start,
            end: end < range.end
                ? start + replacementLength + (range.end - end)
                : start + replacementLength,
        };
    });
}

function getReplaceCallbackOffset(args = []) {
    const hasNamedGroups = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null;
    const offset = args[args.length - (hasNamedGroups ? 3 : 2)];
    return Number.isInteger(offset) ? offset : -1;
}

export function applyCompiledReplacementsWithTrackedRanges(originalText, processors = [], ranges = [], options = {}) {
    const source = String(originalText ?? '');
    if (!source) return { text: source, ranges: [...ranges], valid: true };

    let text = source;
    let trackedRanges = (Array.isArray(ranges) ? ranges : []).map((range) => ({ ...range }));
    let protectedRanges = (options.protectedRanges || []).map((range) => ({ ...range }));
    let valid = trackedRanges.every((range) => Number.isInteger(range.start)
        && Number.isInteger(range.end)
        && range.start >= 0
        && range.end >= range.start
        && range.end <= source.length);
    if (!valid) return { text: source, ranges: trackedRanges, valid: false };

    (Array.isArray(processors) ? processors : []).forEach((proc) => {
        if (!proc?.regex) return;
        let priorReplacementDelta = 0;
        text = text.replace(proc.regex, (match, ...args) => {
            const sourceStart = getReplaceCallbackOffset(args);
            if (sourceStart < 0) {
                valid = false;
                return String(resolveProcessorReplacement(proc, match, args) ?? '');
            }
            const start = sourceStart + priorReplacementDelta;
            const end = start + String(match).length;
            if (protectedRanges.some((range) => start < range.end && range.start < end)) return match;
            const replacement = String(resolveProcessorReplacement(proc, match, args, {
                ...options,
                occurrenceStart: sourceStart,
            }) ?? '');
            protectedRanges = projectTrackedRangesThroughReplacement(protectedRanges, start, end, replacement.length);
            trackedRanges = projectTrackedRangesThroughReplacement(trackedRanges, start, end, replacement.length);
            priorReplacementDelta += replacement.length - String(match).length;
            return replacement;
        });
    });
    return { text, ranges: trackedRanges, valid };
}

export function applyCompiledReplacements(originalText, processors = [], options = {}) {
    return applyCompiledReplacementsWithTrackedRanges(originalText, processors, [], options).text;
}

/**
 * 对文本应用规则替换。
 * @param {string} originalText 原始文本。
 * @param {object} [options={}] 替换选项。
 * @returns {string} 替换后的文本。
 */
export function applyReplacements(originalText, options = {}) {
    if (typeof originalText !== 'string' || !originalText) return originalText;
    const processors = buildProcessors();
    return applyCompiledReplacements(originalText, processors, options);
}

export function countProcessorMatches(originalText, processors = []) {
    if (typeof originalText !== 'string' || !originalText) return 0;
    let hitCount = 0;

    (Array.isArray(processors) ? processors : []).forEach((processor) => {
        if (!processor?.regex) return;
        const regex = new RegExp(processor.regex.source, processor.regex.flags);
        let match;
        while ((match = regex.exec(originalText)) !== null) {
            const matchedText = String(match[0] || '');
            if (matchedText) hitCount++;
            else regex.lastIndex++;
        }
    });

    return hitCount;
}

function getEnabledScopeTagsForSettings(settings = {}) {
    const scopeTags = mergeScopeTagsWithBuiltins(
        settings?.scopeTags,
        settings?.scopeTagBuiltinDismissed
    );
    return scopeTags.filter((tag) => tag.enabled !== false);
}

function getScopeTagModeForSettings(settings = {}) {
    return settings?.scopeTagMode === 'cleanse-inside' ? 'cleanse-inside' : 'protect';
}

export function countScopedProcessorMatches(originalText, processors = [], settings = {}) {
    if (typeof originalText !== 'string' || !originalText) return 0;

    const scopeTags = getEnabledScopeTagsForSettings(settings);
    const shouldCleanseInside = getScopeTagModeForSettings(settings) === 'cleanse-inside';
    if (scopeTags.length === 0) {
        return shouldCleanseInside ? 0 : countProcessorMatches(originalText, processors);
    }

    let hitCount = 0;
    let cursor = 0;
    const countRange = (start, end) => {
        if (end > start) hitCount += countProcessorMatches(originalText.slice(start, end), processors);
    };

    while (cursor < originalText.length) {
        const nextMatch = findNextScopeTagMatch(originalText, cursor, scopeTags);
        if (!nextMatch) {
            if (!shouldCleanseInside) countRange(cursor, originalText.length);
            break;
        }

        const { index, scopeTag } = nextMatch;
        if (!shouldCleanseInside) countRange(cursor, index);

        const tagBodyStart = index + scopeTag.startTag.length;
        const endIndex = originalText.indexOf(scopeTag.endTag, tagBodyStart);
        if (endIndex < 0) {
            if (!shouldCleanseInside) countRange(tagBodyStart, originalText.length);
            break;
        }

        if (shouldCleanseInside) countRange(tagBodyStart, endIndex);
        cursor = endIndex + scopeTag.endTag.length;
    }

    return hitCount;
}

function findNextScopeTagMatch(text, fromIndex, scopeTags) {
    let nextMatch = null;
    for (const scopeTag of scopeTags) {
        const startIndex = text.indexOf(scopeTag.startTag, fromIndex);
        if (startIndex < 0) continue;
        if (!nextMatch || startIndex < nextMatch.index || (startIndex === nextMatch.index && scopeTag.startTag.length > nextMatch.scopeTag.startTag.length)) {
            nextMatch = { index: startIndex, scopeTag };
        }
    }
    return nextMatch;
}

/**
 * 对消息文本应用“范围标签模式 + 规则替换”。
 * protect 模式保留标签内文本，cleanse-inside 模式仅净化标签内文本。
 * @param {string} originalText 原始文本。
 * @param {object} [options={}] 替换选项。
 * @returns {string} 替换后的文本。
 */
export function applyScopedReplacements(originalText, options = {}) {
    return applyScopedReplacementsWithTrackedRanges(originalText, [], options).text;
}

export function applyScopedReplacementsWithTrackedRanges(originalText, ranges = [], options = {}) {
    if (typeof originalText !== 'string' || !originalText) {
        return { text: String(originalText ?? ''), ranges: [...ranges], valid: true };
    }

    const { extension_settings } = getAppContext();
    const scopeSettings = options.scopeSettings ?? (extension_settings?.[extensionName] || {});
    const scopeTags = getEnabledScopeTagsForSettings(scopeSettings);
    if (getScopeTagModeForSettings(scopeSettings) === 'cleanse-inside' && scopeTags.length === 0) {
        return { text: originalText, ranges: [...ranges], valid: true };
    }
    const processors = buildProcessors();
    return applyScopedCompiledReplacementsWithTrackedRanges(
        originalText,
        processors,
        scopeSettings,
        ranges,
        options,
    );
}

export function applyScopedCompiledReplacements(originalText, processors = [], scopeSettings = {}, options = {}) {
    return applyScopedCompiledReplacementsWithTrackedRanges(
        originalText,
        processors,
        scopeSettings,
        [],
        options,
    ).text;
}

export function applyScopedCompiledReplacementsWithTrackedRanges(originalText, processors = [], scopeSettings = {}, ranges = [], options = {}) {
    const source = String(originalText ?? '');
    let valid = Array.isArray(ranges) && ranges.every((range) => Number.isInteger(range?.start)
        && Number.isInteger(range?.end)
        && range.start >= 0
        && range.end >= range.start
        && range.end <= source.length);
    if (!source || !valid) return { text: source, ranges: [...ranges], valid };

    const scopeTags = getEnabledScopeTagsForSettings(scopeSettings);
    const shouldCleanseInside = getScopeTagModeForSettings(scopeSettings) === 'cleanse-inside';
    const transformRange = (start, end, shouldTransform) => {
        const localRanges = [];
        for (const range of ranges) {
            if (range.end <= start || range.start >= end) continue;
            if (range.start < start || range.end > end) {
                valid = false;
                continue;
            }
            localRanges.push({ ...range, start: range.start - start, end: range.end - start });
        }
        const segment = source.slice(start, end);
        // Keep normal full-message scope parsing; only replacement matches are protected.
        const localOptions = options.protectedRanges ? {
            ...options,
            scopeStart: start,
            protectedRanges: options.protectedRanges
                .filter((range) => range.start < end && start < range.end)
                .map((range) => ({
                    start: Math.max(range.start, start) - start,
                    end: Math.min(range.end, end) - start,
                })),
        } : {
            ...options,
            scopeStart: start,
        };
        const result = shouldTransform
            ? applyCompiledReplacementsWithTrackedRanges(segment, processors, localRanges, localOptions)
            : { text: segment, ranges: localRanges, valid: true };
        valid = valid && result.valid;
        return result;
    };

    let output = '';
    let cursor = 0;
    let trackedRanges = [];
    const appendRange = (start, end, shouldTransform) => {
        const result = transformRange(start, end, shouldTransform);
        const outputStart = output.length;
        output += result.text;
        trackedRanges.push(...result.ranges.map((range) => ({
            ...range,
            start: range.start + outputStart,
            end: range.end + outputStart,
        })));
    };

    if (scopeTags.length === 0) {
        appendRange(0, source.length, !shouldCleanseInside);
        return { text: output, ranges: trackedRanges, valid };
    }

    while (cursor < source.length) {
        const nextMatch = findNextScopeTagMatch(source, cursor, scopeTags);
        if (!nextMatch) {
            appendRange(cursor, source.length, !shouldCleanseInside);
            break;
        }

        const { index, scopeTag } = nextMatch;
        if (index > cursor) {
            appendRange(cursor, index, !shouldCleanseInside);
        }

        const tagBodyStart = index + scopeTag.startTag.length;
        const endIndex = source.indexOf(scopeTag.endTag, tagBodyStart);
        if (endIndex < 0) {
            if (shouldCleanseInside) {
                appendRange(index, source.length, false);
                break;
            }
            appendRange(index, tagBodyStart, false);
            cursor = tagBodyStart;
            continue;
        }

        appendRange(index, tagBodyStart, false);
        appendRange(tagBodyStart, endIndex, shouldCleanseInside);
        appendRange(endIndex, endIndex + scopeTag.endTag.length, false);
        cursor = endIndex + scopeTag.endTag.length;
    }

    if (trackedRanges.length !== ranges.length) valid = false;
    return { text: output, ranges: trackedRanges, valid };
}
