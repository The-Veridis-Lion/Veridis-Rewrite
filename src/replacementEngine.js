import { extensionName, getAppContext, runtimeState } from './state.js';
import { logger } from './log.js';
import { buildSimpleWildcardPattern, compileRegexTarget, mergeScopeTagsWithBuiltins } from './utils.js';
import { buildChineseVariantPattern, getChineseTextVariantLengths, getZhVariantCompatOptions, isZhDictionaryReady } from './zhConversion.js';

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

export function buildProcessors(options = {}) {
    const includeAiRewrite = options.includeAiRewrite === true;
    if (!runtimeState.isRegexDirty) {
        return includeAiRewrite ? runtimeState.activeVisualProcessors : runtimeState.activeProcessors;
    }
    const { extension_settings } = getAppContext();
    const settings = extension_settings[extensionName] || {};
    const rules = settings.rules || [];
    const useZhVariantCompat = settings.zhVariantCompatEnabled === true && isZhDictionaryReady(settings);
    const zhVariantOptions = getZhVariantCompatOptions(settings);
    const dataBucket = createProcessorBucket();
    const visualBucket = createProcessorBucket();

    for (const rule of rules) {
        if (rule.enabled === false) continue;
        const subRulesToProcess = Array.isArray(rule.subRules) ? rule.subRules : [];

        for (const sub of subRulesToProcess) {
            if (!sub || typeof sub !== 'object' || sub.enabled === false) continue;
            const rewriteMode = sub.rewriteMode === 'ai' ? 'ai' : 'program';
            const includeInData = rewriteMode === 'program';
            const includeInVisual = includeInData
                || (rewriteMode === 'ai' && settings.aiRewrite?.streamingRoughPreview !== false);
            if (!includeInData && !includeInVisual) continue;

            const mode = sub.mode || 'text';
            const targets = Array.isArray(sub.targets) ? sub.targets : [];
            const replacements = Array.isArray(sub.replacements) ? sub.replacements : [];

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
                            logger.warn(`忽略非法正则表达式: ${t} (${compiled.error.message})`);
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
                                logger.warn(`拦截到危险的简易空匹配规则，已忽略: ${t}`);
                                continue;
                            }

                            if (includeInData) addProcessorToBucket(dataBucket, { regex: new RegExp(pattern, 'gmu'), replacements, kind: 'simple', domSafe: true });
                            if (includeInVisual) addProcessorToBucket(visualBucket, { regex: new RegExp(pattern, 'gmu'), replacements, kind: 'simple', domSafe: true });
                        } catch (e) {
                            logger.warn(`简易规则解析失败: ${t}`);
                        }
                    }
                }
            }
        }
    }

    runtimeState.activeProcessors = finalizeProcessorBucket(dataBucket, useZhVariantCompat, zhVariantOptions);
    runtimeState.activeVisualProcessors = finalizeProcessorBucket(visualBucket, useZhVariantCompat, zhVariantOptions);
    runtimeState.isRegexDirty = false;
    const regexProcessorCount = runtimeState.activeProcessors.filter((processor) => processor.kind === 'regex').length;
    const simpleProcessorCount = runtimeState.activeProcessors.filter((processor) => processor.kind === 'simple').length;
    const visualAiCount = Math.max(0, runtimeState.activeVisualProcessors.length - runtimeState.activeProcessors.length);
    logger.info(`规则处理器构建完成，共 ${runtimeState.activeProcessors.length} 个数据处理器（文本:${dataBucket.textTargets.length} | 正则:${regexProcessorCount} | 简易:${simpleProcessorCount}），视觉额外:${visualAiCount}`);
    return includeAiRewrite ? runtimeState.activeVisualProcessors : runtimeState.activeProcessors;
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

/**
 * 对文本应用规则替换。
 * @param {string} originalText 原始文本。
 * @param {{deterministic?: boolean}} [options={}] 替换选项。
 * @returns {string} 替换后的文本。
 */
export function applyReplacements(originalText, options = {}) {
    if (typeof originalText !== 'string' || !originalText) return originalText;
    const deterministic = options.deterministic === true;
    let text = originalText;
    const processors = buildProcessors({ includeAiRewrite: options.includeAiRewrite === true });

    processors.forEach((proc, procIndex) => {
        if (options.domSafeOnly === true && proc.domSafe === false) return;
        text = text.replace(proc.regex, (match, ...args) => (
            resolveProcessorReplacement(proc, procIndex, match, args, deterministic)
        ));
    });
    return text;
}

function getEnabledScopeTags() {
    const { extension_settings } = getAppContext();
    const scopeTags = mergeScopeTagsWithBuiltins(
        extension_settings?.[extensionName]?.scopeTags,
        extension_settings?.[extensionName]?.scopeTagBuiltinDismissed
    );
    return scopeTags.filter((tag) => tag.enabled !== false);
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
    if (typeof originalText !== 'string' || !originalText) return originalText;

    const scopeTags = getEnabledScopeTags();
    const scopeTagMode = getScopeTagMode();
    const shouldCleanseInside = scopeTagMode === 'cleanse-inside';
    if (scopeTags.length === 0) return shouldCleanseInside ? originalText : applyReplacements(originalText, options);

    let output = '';
    let cursor = 0;

    while (cursor < originalText.length) {
        const nextMatch = findNextScopeTagMatch(originalText, cursor, scopeTags);
        if (!nextMatch) {
            const tail = originalText.slice(cursor);
            output += shouldCleanseInside ? tail : applyReplacements(tail, options);
            break;
        }

        const { index, scopeTag } = nextMatch;
        if (index > cursor) {
            const outsideText = originalText.slice(cursor, index);
            output += shouldCleanseInside ? outsideText : applyReplacements(outsideText, options);
        }

        const tagBodyStart = index + scopeTag.startTag.length;
        const endIndex = originalText.indexOf(scopeTag.endTag, tagBodyStart);
        if (endIndex < 0) {
            if (shouldCleanseInside) {
                output += originalText.slice(index);
                break;
            }
            output += originalText.slice(index, tagBodyStart);
            cursor = tagBodyStart;
            continue;
        }

        const startTagText = originalText.slice(index, tagBodyStart);
        const bodyText = originalText.slice(tagBodyStart, endIndex);
        const endTagText = originalText.slice(endIndex, endIndex + scopeTag.endTag.length);
        output += startTagText;
        output += shouldCleanseInside ? applyReplacements(bodyText, options) : bodyText;
        output += endTagText;
        cursor = endIndex + scopeTag.endTag.length;
    }

    return output;
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
