import { extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { rulesRuntimeState } from './state.js';
import { logger } from '../log.js';
import { buildSimpleWildcardPattern, compileRegexTarget } from './regex.js';
import { mergeScopeTagsWithBuiltins } from '../scope/model.js';
import { buildChineseVariantPattern, getChineseTextVariantLengths } from '../zh/conversion.js';
import { getZhVariantCompatOptions, isZhDictionaryReady } from '../zh/dictionary.js';

// Program replacement transformation owner; callers own mutation and persistence.

/**
 * 按当前规则构建净化处理器。
 * @returns {Array} 处理器数组。
 */
function isRegexDomSafe(pattern = '') {
    return !/\(\?<?[=!]/.test(String(pattern || ''));
}

function regexHasPerRunStructuralSemantics(regex, anchorsChangeSemantics) {
    const source = String(regex?.source || '');
    const dotConsumesLineBreaks = String(regex?.flags || '').includes('s');
    let inCharacterClass = false;
    let negatedCharacterClass = false;

    for (let index = 0; index < source.length; index++) {
        const char = source[index];

        if (char === '\\') {
            const escaped = source[index + 1];
            if ((!inCharacterClass || !negatedCharacterClass) && (escaped === 'n' || escaped === 'r' || escaped === 's')) {
                return true;
            }
            index++;
            continue;
        }

        if (inCharacterClass) {
            if (char === ']') {
                inCharacterClass = false;
                negatedCharacterClass = false;
            }
            continue;
        }

        if (char === '[') {
            inCharacterClass = true;
            negatedCharacterClass = source[index + 1] === '^';
            continue;
        }
        if (anchorsChangeSemantics && (char === '^' || char === '$')) return true;
        if (char === '.' && dotConsumesLineBreaks) return true;
    }

    return false;
}

function replacementIntroducesLineBreak(value, interpretRegexTemplateEscapes) {
    const source = String(value ?? '');
    if (source.includes('\n') || source.includes('\r')) return true;
    if (!interpretRegexTemplateEscapes) return false;

    for (let index = 0; index < source.length; index++) {
        if (source[index] !== '\\') continue;
        const escaped = source[index + 1];
        if (escaped === 'n' || escaped === 'r') return true;
        if (escaped !== undefined) index++;
    }
    return false;
}

function getProcessorReplacementCandidates(processor) {
    if (Array.isArray(processor?.replacements)) return processor.replacements;
    if (!processor?.replacerMap || typeof processor.replacerMap !== 'object') return [];
    return Object.values(processor.replacerMap).flatMap((replacements) => (
        Array.isArray(replacements) ? replacements : []
    ));
}

export function isStreamingVisualProcessorSafe(processor, options = {}) {
    if (!processor?.regex) return true;
    if (regexHasPerRunStructuralSemantics(processor.regex, options.anchorsChangeSemantics === true)) return false;
    return !getProcessorReplacementCandidates(processor).some((replacement) => (
        replacementIntroducesLineBreak(replacement, processor.kind === 'regex')
    ));
}

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
        const targetEntries = buildTextTargetEntries(bucket.textTargets, bucket.wordToReplacements, useZhVariantCompat, zhVariantOptions);
        const textRegex = new RegExp(`(${targetEntries.map((entry) => entry.pattern).join('|')})`, 'gmu');
        processors.unshift({
            regex: textRegex,
            replacerMap: bucket.wordToReplacements,
            targetEntries: useZhVariantCompat ? targetEntries : undefined,
            targetEntriesByLength: useZhVariantCompat ? groupTextTargetEntriesByLength(targetEntries) : undefined,
            kind: 'text',
            domSafe: true,
        });
    }
    return processors;
}

export function compileProcessors(rules = [], options = {}) {
    const useZhVariantCompat = options.useZhVariantCompat === true;
    const zhVariantOptions = options.zhVariantOptions || {};
    const warn = typeof options.warn === 'function' ? options.warn : () => {};
    const dataBucket = createProcessorBucket();
    const visualBucket = createProcessorBucket();

    for (const rule of Array.isArray(rules) ? rules : []) {
        if (rule.enabled === false) continue;
        const subRulesToProcess = Array.isArray(rule.subRules) ? rule.subRules : [];

        for (const sub of subRulesToProcess) {
            if (!sub || typeof sub !== 'object' || sub.enabled === false) continue;
            const rewriteMode = sub.rewriteMode === 'ai' ? 'ai' : 'program';
            const includeInData = rewriteMode === 'program';
            const includeInVisual = true;

            const mode = sub.mode || 'text';
            const targets = Array.isArray(sub.targets) ? [...sub.targets] : [];
            const replacements = Array.isArray(sub.replacements) ? [...sub.replacements] : [];

            if (mode === 'text') {
                for (const t of targets) {
                    if (t) {
                        if (includeInData) addTextTargetToBucket(dataBucket, t, replacements);
                        if (includeInVisual) addTextTargetToBucket(visualBucket, t, replacements);
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
                            domSafe: isRegexDomSafe(compiled.value.pattern),
                        };
                        if (includeInData) {
                            addProcessorToBucket(dataBucket, {
                                ...processorBase,
                                regex: new RegExp(compiled.value.regex.source, compiled.value.regex.flags),
                            });
                        }
                        if (includeInVisual) {
                            addProcessorToBucket(visualBucket, {
                                ...processorBase,
                                regex: new RegExp(compiled.value.regex.source, compiled.value.regex.flags),
                            });
                        }
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

                            if (includeInData) addProcessorToBucket(dataBucket, { regex: new RegExp(pattern, 'gmu'), replacements, kind: 'simple', domSafe: true });
                            if (includeInVisual) addProcessorToBucket(visualBucket, { regex: new RegExp(pattern, 'gmu'), replacements, kind: 'simple', domSafe: true });
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
        visualProcessors: finalizeProcessorBucket(visualBucket, useZhVariantCompat, zhVariantOptions),
        textTargetCount: dataBucket.textTargets.length,
    };
}

export function buildProcessors(options = {}) {
    const includeAiRewrite = options.includeAiRewrite === true;
    if (!rulesRuntimeState.isRegexDirty) {
        return includeAiRewrite ? rulesRuntimeState.activeVisualProcessors : rulesRuntimeState.activeProcessors;
    }
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName] || {};
    const compiled = compileProcessors(settings.rules || [], {
        useZhVariantCompat: settings.zhVariantCompatEnabled === true && isZhDictionaryReady(settings),
        zhVariantOptions: getZhVariantCompatOptions(settings),
        warn: (message) => logger.warn(message),
    });

    rulesRuntimeState.activeProcessors = compiled.dataProcessors;
    rulesRuntimeState.activeVisualProcessors = compiled.visualProcessors;
    rulesRuntimeState.isRegexDirty = false;
    const regexProcessorCount = rulesRuntimeState.activeProcessors.filter((processor) => processor.kind === 'regex').length;
    const simpleProcessorCount = rulesRuntimeState.activeProcessors.filter((processor) => processor.kind === 'simple').length;
    const visualAiCount = Math.max(0, rulesRuntimeState.activeVisualProcessors.length - rulesRuntimeState.activeProcessors.length);
    logger.info(`规则处理器构建完成，共 ${rulesRuntimeState.activeProcessors.length} 个数据处理器（文本:${compiled.textTargetCount} | 正则:${regexProcessorCount} | 简易:${simpleProcessorCount}），视觉额外:${visualAiCount}`);
    return includeAiRewrite ? rulesRuntimeState.activeVisualProcessors : rulesRuntimeState.activeProcessors;
}

/**
 * 从替换词列表中选择一个替换值（可选确定性模式）。
 * @param {string[]} replacements 候选替换词列表。
 * @param {string} [deterministicKey=""] 确定性模式键。
 * @returns {string} 最终替换词。
 */
export function pickReplacement(replacements, deterministicKey = "") {
    if (!Array.isArray(replacements) || replacements.length === 0) return '';
    if (!deterministicKey) {
        const randIndex = Math.floor(Math.random() * replacements.length);
        return replacements[randIndex];
    }

    let hash = 0;
    for (let i = 0; i < deterministicKey.length; i++) {
        hash = ((hash << 5) - hash) + deterministicKey.charCodeAt(i);
        hash |= 0;
    }
    const idx = Math.abs(hash) % replacements.length;
    return replacements[idx];
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

export function resolveProcessorReplacement(proc, procIndex, match, args = [], deterministic = false) {
    if (proc?.kind === 'regex') {
        const reps = proc.replacements;
        if (!reps || reps.length === 0) return '';
        const repKey = deterministic ? `${procIndex}|${match}` : '';
        const rep = pickReplacement(reps, repKey);
        return renderRegexReplacementTemplate(rep, extractRegexCaptures(args));
    }

    if (proc?.kind === 'simple') {
        const reps = proc.replacements;
        if (!reps || reps.length === 0) return '';
        const repKey = deterministic ? `${procIndex}|${match}` : '';
        return String(pickReplacement(reps, repKey) ?? '');
    }

    const exactReps = proc?.replacerMap?.[match];
    const targetEntry = exactReps ? null : findTextTargetEntryForMatch(proc, match);
    const reps = exactReps || targetEntry?.replacements;
    if (!reps || reps.length === 0) return '';
    const repKey = deterministic ? `${procIndex}|${match}` : '';
    return pickReplacement(reps, repKey);
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

export function replayProgramProjection(originalText, projection, ranges = []) {
    const sourceLength = String(originalText ?? '').length;
    let outputLength = sourceLength;
    let trackedRanges = (Array.isArray(ranges) ? ranges : []).map((range) => ({ ...range }));
    let valid = Array.isArray(projection)
        && Array.isArray(ranges)
        && trackedRanges.every((range) => Number.isInteger(range.start)
            && Number.isInteger(range.end)
            && range.start >= 0
            && range.end >= range.start
            && range.end <= sourceLength);

    if (!valid) return { ranges: trackedRanges, valid: false, outputLength };

    for (const step of projection) {
        if (!Array.isArray(step)
            || step.length !== 3
            || !Number.isInteger(step[0])
            || !Number.isInteger(step[1])
            || !Number.isInteger(step[2])
            || step[0] < 0
            || step[1] < step[0]
            || step[1] > outputLength
            || step[2] < 0) {
            valid = false;
            break;
        }

        trackedRanges = projectTrackedRangesThroughReplacement(
            trackedRanges,
            step[0],
            step[1],
            step[2],
        );
        outputLength += step[2] - (step[1] - step[0]);
    }

    return { ranges: trackedRanges, valid, outputLength };
}

export function applyTextReplacementWithTrackedRanges(originalText, start, end, replacement, ranges = []) {
    const source = String(originalText ?? '');
    const replacementText = String(replacement ?? '');
    const projection = [[start, end, replacementText.length]];
    const replayed = replayProgramProjection(source, projection, ranges);
    if (!replayed.valid) {
        return {
            text: source,
            ranges: Array.isArray(ranges) ? ranges.map((range) => ({ ...range })) : [],
            projection: [],
            valid: false,
        };
    }

    return {
        text: source.slice(0, start) + replacementText + source.slice(end),
        ranges: replayed.ranges,
        projection,
        valid: true,
    };
}

function getReplaceCallbackOffset(args = []) {
    const hasNamedGroups = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null;
    const offset = args[args.length - (hasNamedGroups ? 3 : 2)];
    return Number.isInteger(offset) ? offset : -1;
}

export function applyCompiledReplacementsWithTrackedRanges(originalText, processors = [], deterministic = false, ranges = [], options = {}) {
    const source = String(originalText ?? '');
    if (!source) return { text: source, ranges: [...ranges], projection: [], valid: true };

    let text = source;
    let trackedRanges = (Array.isArray(ranges) ? ranges : []).map((range) => ({ ...range }));
    const projection = [];
    let valid = trackedRanges.every((range) => Number.isInteger(range.start)
        && Number.isInteger(range.end)
        && range.start >= 0
        && range.end >= range.start
        && range.end <= source.length);
    if (!valid) return { text: source, ranges: trackedRanges, projection, valid: false };

    (Array.isArray(processors) ? processors : []).forEach((proc, procIndex) => {
        if (!proc?.regex || (options.domSafeOnly === true && proc.domSafe === false)) return;
        let priorReplacementDelta = 0;
        text = text.replace(proc.regex, (match, ...args) => {
            const replacement = String(resolveProcessorReplacement(proc, procIndex, match, args, deterministic) ?? '');
            const sourceStart = getReplaceCallbackOffset(args);
            if (sourceStart < 0) {
                valid = false;
                return replacement;
            }
            const start = sourceStart + priorReplacementDelta;
            const end = start + String(match).length;
            projection.push([start, end, replacement.length]);
            trackedRanges = projectTrackedRangesThroughReplacement(trackedRanges, start, end, replacement.length);
            priorReplacementDelta += replacement.length - String(match).length;
            return replacement;
        });
    });
    return { text, ranges: trackedRanges, projection, valid };
}

export function applyCompiledReplacements(originalText, processors = [], deterministic = false, options = {}) {
    return applyCompiledReplacementsWithTrackedRanges(originalText, processors, deterministic, [], options).text;
}

/**
 * 对文本应用规则替换。
 * @param {string} originalText 原始文本。
 * @param {{deterministic?: boolean}} [options={}] 替换选项。
 * @returns {string} 替换后的文本。
 */
export function applyReplacements(originalText, options = {}) {
    if (typeof originalText !== 'string' || !originalText) return originalText;
    const processors = buildProcessors({ includeAiRewrite: options.includeAiRewrite === true });
    return applyCompiledReplacements(originalText, processors, options.deterministic === true, options);
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

function getEnabledScopeTags() {
    const { extension_settings } = getAppContext();
    return getEnabledScopeTagsForSettings(extension_settings?.[extensionName] || {});
}

export function hasEnabledScopeTags() {
    return getEnabledScopeTags().length > 0;
}

function getScopeTagMode() {
    const { extension_settings } = getAppContext();
    return extension_settings?.[extensionName]?.scopeTagMode === 'cleanse-inside'
        ? 'cleanse-inside'
        : 'protect';
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

export function collectScopedReplacementRanges(originalText) {
    if (typeof originalText !== 'string' || !originalText) return [];

    const scopeTags = getEnabledScopeTags();
    const shouldCleanseInside = getScopeTagMode() === 'cleanse-inside';
    if (scopeTags.length === 0) {
        return shouldCleanseInside ? [] : [{ start: 0, end: originalText.length }];
    }

    const ranges = [];
    const addRange = (start, end) => {
        if (end > start) ranges.push({ start, end });
    };
    let cursor = 0;

    while (cursor < originalText.length) {
        const nextMatch = findNextScopeTagMatch(originalText, cursor, scopeTags);
        if (!nextMatch) {
            if (!shouldCleanseInside) addRange(cursor, originalText.length);
            break;
        }

        const { index, scopeTag } = nextMatch;
        if (!shouldCleanseInside) addRange(cursor, index);

        const tagBodyStart = index + scopeTag.startTag.length;
        const endIndex = originalText.indexOf(scopeTag.endTag, tagBodyStart);
        if (endIndex < 0) {
            if (!shouldCleanseInside) addRange(tagBodyStart, originalText.length);
            break;
        }

        if (shouldCleanseInside) addRange(tagBodyStart, endIndex);
        cursor = endIndex + scopeTag.endTag.length;
    }

    return ranges;
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

function collectCompleteScopeTagRanges(text, scopeTags) {
    const ranges = [];
    if (typeof text !== 'string' || !text || !Array.isArray(scopeTags) || scopeTags.length === 0) return ranges;

    let cursor = 0;
    while (cursor < text.length) {
        const nextMatch = findNextScopeTagMatch(text, cursor, scopeTags);
        if (!nextMatch) break;

        const { index, scopeTag } = nextMatch;
        const tagBodyStart = index + scopeTag.startTag.length;
        const endIndex = text.indexOf(scopeTag.endTag, tagBodyStart);
        if (endIndex < 0) {
            cursor = tagBodyStart;
            continue;
        }

        ranges.push({
            start: index,
            end: endIndex + scopeTag.endTag.length,
            startTag: scopeTag.startTag,
        });
        cursor = endIndex + scopeTag.endTag.length;
    }

    return ranges;
}

function buildScopeTagSkeleton(text, ranges) {
    let output = '';
    let cursor = 0;
    ranges.forEach((range, index) => {
        output += text.slice(cursor, range.start);
        output += `\uE000${index}:${range.startTag}\uE001`;
        cursor = range.end;
    });
    output += text.slice(cursor);
    return output;
}

function haveMatchingScopeTagRanges(leftRanges, rightRanges) {
    if (leftRanges.length !== rightRanges.length) return false;
    return leftRanges.every((range, index) => range.startTag === rightRanges[index]?.startTag);
}

export function mergeProtectedScopeUpdatesIntoSource(sourceMes, previousCleanedMes, currentMes) {
    if (getScopeTagMode() !== 'protect') return '';
    if (!sourceMes || !previousCleanedMes || !currentMes || previousCleanedMes === currentMes) return '';

    const scopeTags = getEnabledScopeTags();
    if (scopeTags.length === 0) return '';

    const previousRanges = collectCompleteScopeTagRanges(previousCleanedMes, scopeTags);
    if (previousRanges.length === 0) return '';

    const currentRanges = collectCompleteScopeTagRanges(currentMes, scopeTags);
    if (!haveMatchingScopeTagRanges(previousRanges, currentRanges)) return '';

    const previousSkeleton = buildScopeTagSkeleton(previousCleanedMes, previousRanges);
    const currentSkeleton = buildScopeTagSkeleton(currentMes, currentRanges);
    if (previousSkeleton !== currentSkeleton) return '';

    const sourceRanges = collectCompleteScopeTagRanges(sourceMes, scopeTags);
    if (!haveMatchingScopeTagRanges(sourceRanges, currentRanges)) return '';

    let merged = '';
    let cursor = 0;
    sourceRanges.forEach((sourceRange, index) => {
        const currentRange = currentRanges[index];
        merged += sourceMes.slice(cursor, sourceRange.start);
        merged += currentMes.slice(currentRange.start, currentRange.end);
        cursor = sourceRange.end;
    });
    merged += sourceMes.slice(cursor);
    return merged;
}

/**
 * 对消息文本应用“范围标签模式 + 规则替换”。
 * protect 模式保留标签内文本，cleanse-inside 模式仅净化标签内文本。
 * @param {string} originalText 原始文本。
 * @param {{deterministic?: boolean}} [options={}] 替换选项。
 * @returns {string} 替换后的文本。
 */
export function applyScopedReplacements(originalText, options = {}) {
    return applyScopedReplacementsWithTrackedRanges(originalText, [], options).text;
}

export function applyScopedReplacementsWithTrackedRanges(originalText, ranges = [], options = {}) {
    if (typeof originalText !== 'string' || !originalText) {
        return { text: String(originalText ?? ''), ranges: [...ranges], projection: [], valid: true };
    }

    const { extension_settings } = getAppContext();
    const scopeSettings = options.scopeSettings ?? (extension_settings?.[extensionName] || {});
    const scopeTags = getEnabledScopeTagsForSettings(scopeSettings);
    if (getScopeTagModeForSettings(scopeSettings) === 'cleanse-inside' && scopeTags.length === 0) {
        return { text: originalText, ranges: [...ranges], projection: [], valid: true };
    }
    const processors = buildProcessors({ includeAiRewrite: options.includeAiRewrite === true });
    return applyScopedCompiledReplacementsWithTrackedRanges(
        originalText,
        processors,
        scopeSettings,
        options.deterministic === true,
        ranges,
        options,
    );
}

export function applyScopedCompiledReplacements(originalText, processors = [], scopeSettings = {}, deterministic = false, options = {}) {
    return applyScopedCompiledReplacementsWithTrackedRanges(
        originalText,
        processors,
        scopeSettings,
        deterministic,
        [],
        options,
    ).text;
}

export function applyScopedCompiledReplacementsWithTrackedRanges(originalText, processors = [], scopeSettings = {}, deterministic = false, ranges = [], options = {}) {
    const source = String(originalText ?? '');
    let valid = Array.isArray(ranges) && ranges.every((range) => Number.isInteger(range?.start)
        && Number.isInteger(range?.end)
        && range.start >= 0
        && range.end >= range.start
        && range.end <= source.length);
    if (!source || !valid) return { text: source, ranges: [...ranges], projection: [], valid };

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
        const result = shouldTransform
            ? applyCompiledReplacementsWithTrackedRanges(segment, processors, deterministic, localRanges, options)
            : { text: segment, ranges: localRanges, projection: [], valid: true };
        valid = valid && result.valid;
        return result;
    };

    let output = '';
    let cursor = 0;
    let trackedRanges = [];
    const projection = [];
    const appendRange = (start, end, shouldTransform) => {
        const result = transformRange(start, end, shouldTransform);
        const outputStart = output.length;
        output += result.text;
        trackedRanges.push(...result.ranges.map((range) => ({
            ...range,
            start: range.start + outputStart,
            end: range.end + outputStart,
        })));
        projection.push(...result.projection.map((step) => [
            step[0] + outputStart,
            step[1] + outputStart,
            step[2],
        ]));
    };

    if (scopeTags.length === 0) {
        appendRange(0, source.length, !shouldCleanseInside);
        return { text: output, ranges: trackedRanges, projection, valid };
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
    return { text: output, ranges: trackedRanges, projection, valid };
}

/**
 * 在流式展示场景下执行确定性视觉替换。
 * @param {string} originalText 原始文本。
 * @returns {string} 视觉掩码后的文本。
 */
export function applyVisualMask(originalText, options = {}) {
    if (typeof originalText !== 'string' || !originalText) return originalText;
    return applyScopedReplacements(originalText, { deterministic: true, includeAiRewrite: true, ...options });
}
