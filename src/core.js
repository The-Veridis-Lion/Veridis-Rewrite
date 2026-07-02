import { extensionName, getAppContext, runtimeState } from './state.js';
import { logger } from './log.js';
import { buildSimpleWildcardPattern, compileRegexTarget, mergeScopeTagsWithBuiltins } from './utils.js';
import { buildChineseVariantPattern, getChineseTextVariantLengths, getZhVariantCompatOptions, isZhDictionaryReady } from './zhConversion.js';
import { deepCleanObjectSync } from './cleanse.js';
import { buildDiffSnippetsFromText, computeMessageSignature, ensureMessageDiffButton, getLatestTrackableDiffIndices, hasRealDiffCache, injectDiffButtons, isAssistantMessage, markDiffComparisonPending, syncTrackedIndicesToLatestAssistantMessages, writeReadyDiffCache, clearTrackedDiffEntry } from './diff.js';
import { getMessageDomNode, purifyDOM } from './dom.js';
import { clearMessageDiffMeta, getMessageDiffBranchKey, getMessageDiffMeta, isMessageFinalizedForCurrentBranch, setCurrentSwipeText, writeMessageDiffMeta } from './messageMeta.js';
import { getMaxHostChatSaveDefers, getRecommendedChatSaveDelay, getSillyTavernContextSnapshot, isBaiBaiToolkitInstalled, isLoreFrameInstalled, isTauriTavernHost, markHostChatDirtyFromIndex, runPreferredSaveChat, shouldDelayChatSaveForHost } from './platform.js';

const chatChangedSyncMessageLimit = 80;
const chatChangedBackgroundChunkSize = 25;
const chatChangedBackgroundDelayMs = 35;
const mvuStatusPlaceholder = '<StatusPlaceHolderImpl/>';

/**
 * 按当前规则构建净化处理器。
 * @returns {Array} 处理器数组。
 */
function isRegexDomSafe(pattern = '') {
    return !/\(\?<?[=!]/.test(String(pattern || ''));
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
            const includeInVisual = includeInData;
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

export function resolveRegexProcessorReplacement(proc, procIndex, match, args = [], deterministic = false) {
    const reps = proc?.replacements;
    if (!reps || reps.length === 0) return '';
    const repKey = deterministic ? `${procIndex}|${match}` : '';
    const rep = pickReplacement(reps, repKey);
    return renderRegexReplacementTemplate(rep, extractRegexCaptures(args));
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
        if (options.unsafeRegexOnly === true && proc.domSafe !== false) return;
        if (options.domSafeOnly === true && proc.domSafe === false) return;
        text = text.replace(proc.regex, (match, ...args) => {
            if (proc.kind === 'regex') {
                return resolveRegexProcessorReplacement(proc, procIndex, match, args, deterministic);
            }

            if (proc.kind === 'simple') {
                const reps = proc.replacements;
                if (!reps || reps.length === 0) return '';
                const repKey = deterministic ? `${procIndex}|${match}` : '';
                return String(pickReplacement(reps, repKey) ?? '');
            }

            const exactReps = proc.replacerMap[match];
            const targetEntry = exactReps ? null : findTextTargetEntryForMatch(proc, match);
            const reps = exactReps || targetEntry?.replacements;
            if (!reps || reps.length === 0) return '';
            const repKey = deterministic ? `${procIndex}|${match}` : '';
            return pickReplacement(reps, repKey);
        });
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

function getScopeTagMode() {
    const { extension_settings } = getAppContext();
    return extension_settings?.[extensionName]?.scopeTagMode === 'cleanse-inside'
        ? 'cleanse-inside'
        : 'protect';
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

function mergeProtectedScopeUpdatesIntoSource(sourceMes, previousCleanedMes, currentMes) {
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

/**
 * 排队执行增量聊天保存。
 * @returns {void}
 */
let chatSaveFailureNotified = false;

function notifyChatSaveFailure(error) {
    if (chatSaveFailureNotified) return;
    chatSaveFailureNotified = true;
    logger.error(`增量存盘失败`, error);
    try {
        setTimeout(() => {
            alert('屏蔽词净化助手：聊天保存失败。请先不要继续大量编辑，建议检查 SillyTavern 控制台与聊天文件权限后再重试。');
        }, 0);
    } catch (notifyError) {
        logger.warn('聊天保存失败提示弹出失败', notifyError);
    }
}

function scheduleQueuedChatSave(delay = getRecommendedChatSaveDelay()) {
    runtimeState.chatSaveTimer = setTimeout(runQueuedChatSave, Math.max(0, Number(delay) || 0));
}

async function runQueuedChatSave() {
    runtimeState.chatSaveTimer = null;
    if (!runtimeState.pendingChatSave) return;

    if (shouldDelayChatSaveForHost() && runtimeState.chatSaveDelayCount < getMaxHostChatSaveDefers()) {
        runtimeState.chatSaveDelayCount += 1;
        scheduleQueuedChatSave(getRecommendedChatSaveDelay());
        return;
    }

    runtimeState.chatSaveDelayCount = 0;
    if (runtimeState.chatSaveInFlight) {
        scheduleQueuedChatSave(getRecommendedChatSaveDelay());
        return;
    }

    runtimeState.pendingChatSave = false;
    runtimeState.chatSaveInFlight = true;
    try {
        await runPreferredSaveChat();
        chatSaveFailureNotified = false;
    } catch (e) {
        notifyChatSaveFailure(e);
    } finally {
        runtimeState.chatSaveInFlight = false;
        if (runtimeState.pendingChatSave) scheduleQueuedChatSave(getRecommendedChatSaveDelay());
    }
}

export function queueIncrementalChatSave() {
    runtimeState.pendingChatSave = true;
    if (runtimeState.chatSaveTimer) return;
    scheduleQueuedChatSave(getRecommendedChatSaveDelay());
}

let messageRefreshMissingWarned = false;
let messageRefreshReloadInFlight = false;
const postRefreshDomSettleTimers = new Map();
const hostRenderedEventSuppressMs = 500;

function warnMissingMessageRefresh(index) {
    if (messageRefreshMissingWarned) return;
    messageRefreshMissingWarned = true;
    logger.warn(`宿主 updateMessageBlock 不可用，无法即时刷新消息显示 index=${index}`);
}

function reloadChatAsDisplayFallback(context, index) {
    if (messageRefreshReloadInFlight || typeof context.reloadCurrentChat !== 'function') return false;
    messageRefreshReloadInFlight = true;
    Promise.resolve(context.reloadCurrentChat())
        .catch((e) => logger.warn(`reloadCurrentChat 兜底刷新失败 index=${index}`, e))
        .finally(() => {
            messageRefreshReloadInFlight = false;
        });
    return true;
}

function looksLikeTemplateRenderedContent(index, message) {
    const text = String(message?.extra?.display_text ?? message?.mes ?? '');
    const templateLikePattern = /```(?:html|xml|svg)?[\s\S]*?<\/(?:html|body|script|div)>|<\/(?:html|body|script)>|<html[\s>]|<body[\s>]|<script[\s>]|<novel_header[\s>]|<\/novel_header>|<content[\s>]|<\/content>|novel-tags-container/i;
    if (templateLikePattern.test(text)) return true;

    const messageNode = getMessageDomNode(index);
    const codeText = messageNode?.querySelector?.('.mes_text pre code')?.textContent || '';
    return templateLikePattern.test(codeText);
}

function scheduleRenderedEvent(index, message, context) {
    const appContext = getAppContext();
    const eventSource = context.eventSource || appContext.eventSource;
    const eventTypes = context.eventTypes || context.event_types || appContext.event_types;
    if (!eventSource || typeof eventSource.emit !== 'function' || !eventTypes) return;

    const eventType = message?.is_user === true
        ? eventTypes.USER_MESSAGE_RENDERED
        : eventTypes.CHARACTER_MESSAGE_RENDERED;
    if (!eventType) return;

    const emitEvent = () => {
        Promise.resolve(eventSource.emit(eventType, index))
            .catch((e) => logger.warn(`补发消息渲染事件失败 index=${index}`, e));
    };

    if (typeof globalThis.requestAnimationFrame === 'function') {
        globalThis.requestAnimationFrame(emitEvent);
    } else if (typeof globalThis.setTimeout === 'function') {
        globalThis.setTimeout(emitEvent, 0);
    } else {
        emitEvent();
    }
}

function suppressOwnRenderedEventCleanse(index) {
    if (!Number.isInteger(index) || index < 0) return;
    const until = Date.now() + hostRenderedEventSuppressMs;
    runtimeState.hostRenderedEventSuppressUntil.set(index, until);
    setTimeout(() => {
        if (runtimeState.hostRenderedEventSuppressUntil.get(index) === until) {
            runtimeState.hostRenderedEventSuppressUntil.delete(index);
        }
    }, hostRenderedEventSuppressMs + 50);
}

function scheduleMessageUpdatedEvent(index, context) {
    const appContext = getAppContext();
    const eventSource = context.eventSource || appContext.eventSource;
    const eventTypes = context.eventTypes || context.event_types || appContext.event_types;
    const eventType = eventTypes?.MESSAGE_UPDATED;
    if (!eventSource || typeof eventSource.emit !== 'function' || !eventType) return;

    const emitEvent = () => {
        Promise.resolve(eventSource.emit(eventType, index))
            .catch((e) => logger.warn(`补发消息更新事件失败 index=${index}`, e));
    };

    if (typeof globalThis.requestAnimationFrame === 'function') {
        globalThis.requestAnimationFrame(emitEvent);
    } else if (typeof globalThis.setTimeout === 'function') {
        globalThis.setTimeout(emitEvent, 0);
    } else {
        emitEvent();
    }
}

function schedulePostRefreshDomSettle(index) {
    if (!getMessageDomNode(index)) return;
    const existingTimers = postRefreshDomSettleTimers.get(index);
    if (Array.isArray(existingTimers)) existingTimers.forEach((timer) => clearTimeout(timer));

    const delays = isBaiBaiToolkitInstalled() ? [120, 450, 1000] : [120, 450];
    const timers = delays.map((delay) => {
        return setTimeout(() => {
            const messageNode = getMessageDomNode(index);
            if (!messageNode) return;
            try {
                purifyDOM(messageNode);
                ensureMessageDiffButton(index, messageNode);
            } catch (error) {
                logger.warn(`宿主刷新后 DOM 收敛失败 index=${index}`, error);
            }
        }, delay);
    });
    postRefreshDomSettleTimers.set(index, timers);
    setTimeout(() => {
        if (postRefreshDomSettleTimers.get(index) === timers) postRefreshDomSettleTimers.delete(index);
    }, Math.max(...delays) + 50);
}

/**
 * 使用 SillyTavern 宿主渲染器刷新消息块，避免直接写 raw text 破坏排版。
 * @param {number} index 消息索引。
 * @param {{delay?: number, allowReloadFallback?: boolean, emitRenderedEvent?: boolean|'auto'}} [options={}] 刷新选项。
 * @returns {boolean} 已触发刷新则返回 true。
 */
export function refreshMessageDisplay(index, options = {}) {
    const delay = Number(options.delay) || 0;
    if (delay > 0 && typeof globalThis.setTimeout === 'function') {
        globalThis.setTimeout(() => refreshMessageDisplay(index, { ...options, delay: 0 }), delay);
        return true;
    }

    if (!Number.isInteger(index) || index < 0) return false;

    const appContext = getAppContext();
    const stContext = getSillyTavernContextSnapshot();
    const stMessage = Array.isArray(stContext.chat) ? stContext.chat[index] : null;
    const appMessage = Array.isArray(appContext.chat) ? appContext.chat[index] : null;
    const message = stMessage || appMessage;
    if (!message || typeof message !== 'object') return false;

    const hostUpdateMessageBlock = stContext.updateMessageBlock || appContext.updateMessageBlock;
    if (typeof hostUpdateMessageBlock === 'function') {
        try {
            hostUpdateMessageBlock(index, message);
            const shouldEmitRenderedEvent = options.emitRenderedEvent === true
                || (options.emitRenderedEvent === 'auto' && looksLikeTemplateRenderedContent(index, message));
            const needsHostSettle = isTauriTavernHost() || isBaiBaiToolkitInstalled();
            const shouldNotifyHostPlugins = needsHostSettle || isLoreFrameInstalled();
            if (shouldNotifyHostPlugins) suppressOwnRenderedEventCleanse(index);
            if (shouldEmitRenderedEvent || needsHostSettle) scheduleRenderedEvent(index, message, stContext);
            if (shouldNotifyHostPlugins) {
                scheduleMessageUpdatedEvent(index, stContext);
            }
            if (needsHostSettle) {
                schedulePostRefreshDomSettle(index);
            }
            return true;
        } catch (e) {
            logger.warn(`updateMessageBlock 调用失败 index=${index}`, e);
            if (options.allowReloadFallback === true) {
                return reloadChatAsDisplayFallback(stContext, index);
            }
            return false;
        }
    }

    warnMissingMessageRefresh(index);
    if (options.allowReloadFallback === true) {
        return reloadChatAsDisplayFallback(stContext, index);
    }
    return false;
}

/**
 * 从事件负载中解析消息索引。
 * @param {number|object} payload 事件载荷或直接索引。
 * @returns {number} 解析出的索引，失败返回 -1。
 */
export function getMessageIndexFromEvent(payload) {
    if (Number.isInteger(payload)) return payload;
    if (!payload || typeof payload !== 'object') return -1;
    const candidates = [payload.messageId, payload.message_id, payload.mesid, payload.index, payload.id];
    for (const value of candidates) {
        const n = Number(value);
        if (Number.isInteger(n) && n >= 0) return n;
    }
    return -1;
}

/**
 * 获取当前聊天中的最后一条消息索引。
 * @returns {number} 最新消息索引，不存在则为 -1。
 */
export function getLatestMessageIndex() {
    const { chat } = getAppContext();
    return Array.isArray(chat) && chat.length > 0 ? chat.length - 1 : -1;
}

/**
 * 解析“可追踪非 user 消息”的最新索引。
 * @param {number|object} payload 事件载荷或消息索引。
 * @returns {number} 可追踪消息索引，失败返回 -1。
 */
export function resolveLatestTrackableMessageIndex(payload) {
    const { chat } = getAppContext();
    if (!Array.isArray(chat)) return -1;

    const explicit = getMessageIndexFromEvent(payload);

    if (explicit >= 0 && explicit < chat.length) {
        if (isAssistantMessage(chat[explicit])) return explicit;

        for (let i = explicit + 1; i < chat.length; i++) {
            if (isAssistantMessage(chat[i])) return i;
        }
    }

    for (let i = chat.length - 1; i >= 0; i--) {
        if (isAssistantMessage(chat[i])) return i;
    }

    return -1;
}

export function resolveMessageDiffSource(msg, explicitSource) {
    const currentMes = typeof msg?.mes === 'string' ? msg.mes : '';
    if (typeof explicitSource === 'string') return explicitSource;

    const diffMeta = getMessageDiffMeta(msg);
    if (diffMeta?.lastCleanedMes && currentMes === diffMeta.lastCleanedMes) {
        return diffMeta.originalMes;
    }
    if (diffMeta?.originalMes && diffMeta?.lastCleanedMes) {
        const sourceWithScopeUpdates = mergeProtectedScopeUpdatesIntoSource(diffMeta.originalMes, diffMeta.lastCleanedMes, currentMes);
        if (sourceWithScopeUpdates) return sourceWithScopeUpdates;
    }

    return currentMes;
}

function computeDiffSourceSignature(msg, sourceMes) {
    return computeMessageSignature({
        ...msg,
        mes: sourceMes,
        __blai_original_mes: '',
        __blai_diff_source_signature: '',
        __blai_diff_last_cleaned_mes: '',
        __blai_diff_branch_meta: null,
        __blai_diff_swipe_key: '',
    });
}

export function syncMessageDiffMetadata(msg, sourceMes, cleanedMes) {
    const signature = computeDiffSourceSignature(msg, sourceMes);
    const normalizedCleanedMes = typeof cleanedMes === 'string' ? cleanedMes : '';
    const branchKey = getMessageDiffBranchKey(msg);
    const hasDiff = sourceMes !== normalizedCleanedMes;
    const metadataChanged = hasDiff
        ? writeMessageDiffMeta(msg, branchKey, sourceMes, normalizedCleanedMes, signature)
        : clearMessageDiffMeta(msg, branchKey);
    return { signature, metadataChanged, hasDiff };
}

function hasMvuStatusPlaceholder(text) {
    return String(text || '').includes(mvuStatusPlaceholder);
}

function hasMvuUpdatePayload(text) {
    return String(text || '').includes('<UpdateVariable>');
}

function getCurrentSwipeVariables(msg) {
    const swipeId = Number.isInteger(Number(msg?.swipe_id)) ? Number(msg.swipe_id) : 0;
    return msg?.variables?.[swipeId];
}

function hasCurrentSwipeMvuState(msg) {
    const variables = getCurrentSwipeVariables(msg);
    return !!(variables && typeof variables === 'object' && (variables.stat_data || variables.schema || variables.display_data));
}

export function preserveMvuStatusPlaceholder(text, msg, sources = []) {
    const nextText = typeof text === 'string' ? text : String(text ?? '');
    if (!nextText || hasMvuStatusPlaceholder(nextText)) return nextText;
    if (!isAssistantMessage(msg)) return nextText;

    const sourceTexts = [nextText, msg?.mes, ...sources].map(value => String(value || ''));
    const hadPlaceholder = sourceTexts.some(hasMvuStatusPlaceholder);
    const hasMvuPayload = sourceTexts.some(hasMvuUpdatePayload);
    if (!hadPlaceholder && !(hasMvuPayload && hasCurrentSwipeMvuState(msg))) return nextText;

    return `${nextText.trimEnd()}\n\n${mvuStatusPlaceholder}`;
}

function getPostSourceAddition(sourceMes, cleanedSourceMes, currentMes, hasExplicitSource) {
    if (hasExplicitSource !== true) return '';

    const sourceText = String(sourceMes ?? '');
    const cleanedText = String(cleanedSourceMes ?? '');
    const currentText = String(currentMes ?? '');
    if (!sourceText || !currentText || currentText === sourceText) return '';

    if (currentText.startsWith(sourceText)) {
        return currentText.slice(sourceText.length);
    }
    if (currentText.startsWith(cleanedText)) {
        return currentText.slice(cleanedText.length);
    }
    return '';
}

/**
 * 清理指定索引消息的数据并更新差异缓存。
 * @param {number} index 消息索引。
 * @returns {boolean} 是否发生数据变更。
 */
export function cleanseMessageDataAtIndex(index, options = {}) {
    const { chat } = getAppContext();
    if (!Array.isArray(chat) || index < 0 || index >= chat.length) return false;
    const msg = chat[index];
    if (!msg || typeof msg !== 'object') return false;
    if (msg.__blai_is_reverted) return false;

    const isAssistant = isAssistantMessage(msg);
    if (!isAssistant) {
        clearTrackedDiffEntry(index);
        return false;
    }

    const currentMes = typeof msg.mes === 'string' ? msg.mes : '';
    const hasExplicitSource = typeof options.diffSourceMes === 'string';
    const sourceMes = resolveMessageDiffSource(msg, options.diffSourceMes);

    let changed = false;

    const diffResult = buildDiffSnippetsFromText(sourceMes);
    const postSourceAddition = getPostSourceAddition(sourceMes, diffResult.cleanedText, currentMes, hasExplicitSource);
    const cleanedText = preserveMvuStatusPlaceholder(`${diffResult.cleanedText}${postSourceAddition}`, msg, [currentMes, sourceMes]);
    const metadataSourceMes = preserveMvuStatusPlaceholder(`${sourceMes}${postSourceAddition}`, msg, [currentMes, cleanedText]);
    const mainCache = {
        snippets: Array.from(new Set(diffResult.snippets || [])),
        fullDiff: diffResult.fullDiff || '',
    };
    const hasMainDiff = mainCache.snippets.length > 0 || mainCache.fullDiff.includes('blai-diff-full-modified');

    if (typeof msg.mes === 'string' && cleanedText !== currentMes) {
        msg.mes = cleanedText;
        changed = true;
        if (setCurrentSwipeText(msg, cleanedText)) changed = true;
    }

    if (options.cleanAllSwipes === true && Array.isArray(msg.swipes)) {
        for (let i = 0; i < msg.swipes.length; i++) {
            if (typeof msg.swipes[i] === 'string') {
                const { cleanedText } = buildDiffSnippetsFromText(msg.swipes[i]);
                if (cleanedText !== msg.swipes[i]) {
                    msg.swipes[i] = cleanedText;
                    changed = true;
                }
            } else if (msg.swipes[i] && typeof msg.swipes[i] === 'object' && typeof msg.swipes[i].mes === 'string') {
                const { cleanedText } = buildDiffSnippetsFromText(msg.swipes[i].mes);
                if (cleanedText !== msg.swipes[i].mes) {
                    msg.swipes[i].mes = cleanedText;
                    changed = true;
                }
            }
        }
    }

    const { signature: sourceSignature, metadataChanged } = syncMessageDiffMetadata(msg, metadataSourceMes, typeof msg.mes === 'string' ? msg.mes : '');
    if (metadataChanged) changed = true;
    writeReadyDiffCache(index, sourceSignature, {
        snippets: mainCache.snippets,
        fullDiff: mainCache.fullDiff,
        signature: sourceSignature,
    }, {
        preserveExistingRealDiff: options.preserveExistingRealDiff === true,
        persist: hasMainDiff || changed,
    });
    runtimeState.diffRawSourceCache.delete(index);

    if (changed) markHostChatDirtyFromIndex(index);
    return changed;
}

/**
 * 非流式生成结束后的专用收敛流程。
 * @param {number|object} payload 事件载荷或消息索引。
 * @returns {void}
 */
export function performNonStreamingFinalCleanse(payload) {
    const { chat } = getAppContext();

    buildProcessors();
    if (runtimeState.activeProcessors.length === 0) return;

    const index = resolveLatestTrackableMessageIndex(payload);
    if (index < 0 || !Array.isArray(chat)) return;

    const msg = chat[index];
    if (!isAssistantMessage(msg)) return;
    if (msg?.__blai_is_reverted) {
        clearTrackedDiffEntry(index);
        injectDiffButtons([index]);
        return;
    }

    const previousState = runtimeState.diffMessageStates.get(index);
    const currentSignature = computeMessageSignature(msg);
    const alreadyFinalizedSameSource = previousState?.status === 'ready'
        && previousState.signature === currentSignature
        && isMessageFinalizedForCurrentBranch(msg);

    if (alreadyFinalizedSameSource && hasRealDiffCache(index)) {
        const messageNode = getMessageDomNode(index);
        if (messageNode) {
            purifyDOM(messageNode);
            ensureMessageDiffButton(index, messageNode);
        }
        return;
    }

    const dataChanged = cleanseMessageDataAtIndex(index, {
        preserveExistingRealDiff: true,
    });
    runtimeState.nonStreamingRawMessageCache.delete(index);

    const messageNode = getMessageDomNode(index);
    if (messageNode) {
        purifyDOM(messageNode);
        ensureMessageDiffButton(index, messageNode);
    }

    if (dataChanged) {
        refreshMessageDisplay(index, { emitRenderedEvent: 'auto' });
        queueIncrementalChatSave();
    }
}

/**
 * 执行增量净化：处理单条消息并刷新对应 DOM。
 * @param {number|object} payload 事件载荷或消息索引。
 * @param {{visualOnly?: boolean, fallbackLatest?: boolean, skipPurifyDom?: boolean, diffSourceMes?: string}} [options={}] 控制选项。
 * @returns {void}
 */
export function performIncrementalCleanse(payload, options = {}) {
    logger.debug(`[performIncrementalCleanse] payload=${JSON.stringify(payload)}, options=${JSON.stringify(options)}`);
    const { chat } = getAppContext();
    if (!options.skipPurifyDom) buildProcessors();
    if (!options.skipPurifyDom && runtimeState.activeProcessors.length === 0) return;

    const fallbackLatest = options.fallbackLatest === true;
    let index = getMessageIndexFromEvent(payload);
    if (index < 0 && fallbackLatest && Array.isArray(chat)) {
        for (let i = chat.length - 1; i >= 0; i--) {
            if (isAssistantMessage(chat[i])) {
                index = i;
                break;
            }
        }
    }
    if (index < 0) return;

    const msg = Array.isArray(chat) ? chat[index] : null;
    const assistant = isAssistantMessage(msg);
    if (!assistant) return;
    if (msg?.__blai_is_reverted) {
        clearTrackedDiffEntry(index);
        injectDiffButtons([index]);
        return;
    }
    if (assistant) {
        const signature = computeMessageSignature(msg);
        if (options.visualOnly) markDiffComparisonPending(index, signature);
        else {
            const previousState = runtimeState.diffMessageStates.get(index);
            const alreadyFinalizedSameSource = previousState?.status === 'ready'
                && previousState.signature === signature
                && isMessageFinalizedForCurrentBranch(msg);

            if (alreadyFinalizedSameSource && hasRealDiffCache(index)) {
                const messageNode = getMessageDomNode(index);
                if (messageNode) ensureMessageDiffButton(index, messageNode);
                return;
            }

            if (!previousState || previousState.signature !== signature) {
                markDiffComparisonPending(index, signature);
            }
        }
    }

    const dataChanged = options.visualOnly ? false : cleanseMessageDataAtIndex(index, {
        diffSourceMes: options.diffSourceMes,
    });
    const messageNode = getMessageDomNode(index);
    if (messageNode) {
        if (!options.skipPurifyDom) purifyDOM(messageNode);
        ensureMessageDiffButton(index, messageNode);
    }

    if (dataChanged) {
        refreshMessageDisplay(index, { emitRenderedEvent: 'auto' });
        queueIncrementalChatSave();
    }
}

function cancelGlobalCleanseJob() {
    if (!runtimeState.globalCleanseJob) return;
    if (runtimeState.globalCleanseJob.timer) clearTimeout(runtimeState.globalCleanseJob.timer);
    runtimeState.globalCleanseJob.cancelled = true;
    runtimeState.globalCleanseJob = null;
}

function getChatChangedSyncIndices(chat, latestDiffIndices) {
    const indices = new Set(latestDiffIndices);
    const start = Math.max(0, chat.length - chatChangedSyncMessageLimit);
    for (let index = start; index < chat.length; index++) indices.add(index);
    return [...indices].filter(index => index >= 0 && index < chat.length).sort((a, b) => a - b);
}

function processGlobalCleanseMessage(msg, index, latestDiffIndices, skipUser, options = {}) {
    const { refreshDom = true } = options;
    let msgChanged = false;
    let mainCache = { snippets: [], fullDiff: '' };
    const assistant = isAssistantMessage(msg);
    if (skipUser && !assistant) return false;
    let signature = assistant ? computeMessageSignature(msg) : '';
    const isReverted = msg?.__blai_is_reverted === true;

    if (!isReverted && typeof msg?.mes === 'string') {
        const sourceMes = assistant ? resolveMessageDiffSource(msg) : msg.mes;
        const { cleanedText: rawCleanedText, snippets: mesSnippets, fullDiff } = buildDiffSnippetsFromText(sourceMes);
        const cleanedText = assistant
            ? preserveMvuStatusPlaceholder(rawCleanedText, msg, [msg.mes, sourceMes])
            : rawCleanedText;
        const metadataSourceMes = assistant
            ? preserveMvuStatusPlaceholder(sourceMes, msg, [msg.mes, cleanedText])
            : sourceMes;
        mainCache = {
            snippets: Array.from(new Set(mesSnippets)),
            fullDiff,
        };
        if (msg.mes !== cleanedText) {
            msg.mes = cleanedText;
            msgChanged = true;
            if (assistant && setCurrentSwipeText(msg, cleanedText)) msgChanged = true;
        }
        if (assistant) {
            const syncResult = syncMessageDiffMetadata(msg, metadataSourceMes, msg.mes);
            signature = syncResult.signature;
            if (syncResult.metadataChanged) msgChanged = true;
        }
    }

    if (assistant && latestDiffIndices.has(index) && !isReverted) {
        const hasMainDiff = mainCache.snippets.length > 0 || mainCache.fullDiff.includes('blai-diff-full-modified');
        writeReadyDiffCache(index, signature, mainCache, {
            preserveExistingRealDiff: true,
            persist: hasMainDiff || msgChanged,
        });
    } else {
        clearTrackedDiffEntry(index, { persist: false });
    }

    if (msgChanged && refreshDom) {
        refreshMessageDisplay(index, { delay: 50, emitRenderedEvent: 'auto' });
    }

    if (msgChanged) markHostChatDirtyFromIndex(index);
    return msgChanged;
}

function processGlobalCleanseMessageSafely(msg, index, latestDiffIndices, skipUser, options = {}) {
    try {
        return processGlobalCleanseMessage(msg, index, latestDiffIndices, skipUser, options);
    } catch (error) {
        logger.warn(`[performGlobalCleanse] 跳过异常消息 ${index}: ${error?.message || error}`);
        return false;
    }
}

function scheduleGlobalCleanseRemainder(chat, processedIndices, latestDiffIndices, skipUser) {
    const remainingIndices = [];
    for (let index = 0; index < chat.length; index++) {
        if (!processedIndices.has(index)) remainingIndices.push(index);
    }
    if (remainingIndices.length === 0) return;

    const job = {
        cancelled: false,
        chat,
        cursor: 0,
        changed: false,
        timer: null,
    };
    runtimeState.globalCleanseJob = job;

    const runChunk = () => {
        if (job.cancelled || runtimeState.globalCleanseJob !== job || getAppContext().chat !== job.chat) return;
        buildProcessors();
        if (runtimeState.activeProcessors.length === 0) {
            runtimeState.globalCleanseJob = null;
            return;
        }

        const end = Math.min(job.cursor + chatChangedBackgroundChunkSize, remainingIndices.length);
        for (; job.cursor < end; job.cursor++) {
            const index = remainingIndices[job.cursor];
            const msg = job.chat[index];
            if (!msg || typeof msg !== 'object') continue;
            if (processGlobalCleanseMessageSafely(msg, index, latestDiffIndices, skipUser, { refreshDom: false })) {
                job.changed = true;
            }
        }

        if (job.cursor < remainingIndices.length) {
            job.timer = setTimeout(runChunk, chatChangedBackgroundDelayMs);
            return;
        }

        runtimeState.globalCleanseJob = null;
        syncTrackedIndicesToLatestAssistantMessages();
        if (job.changed) queueIncrementalChatSave();
        logger.info(`[performGlobalCleanse] 长聊天后台净化完成: ${remainingIndices.length} 条`);
    };

    job.timer = setTimeout(runChunk, chatChangedBackgroundDelayMs);
    logger.info(`[performGlobalCleanse] 长聊天后台分片启动: ${remainingIndices.length} 条`);
}

function purifyMessageDomByIndices(indices) {
    indices.forEach((index) => {
        const messageNode = getMessageDomNode(index);
        if (!messageNode) return;
        try {
            purifyDOM(messageNode);
        } catch (error) {
            logger.warn(`[performGlobalCleanse] 跳过异常 DOM 消息 ${index}: ${error?.message || error}`);
        }
    });
}

/**
 * 执行全局净化：遍历聊天数据、同步 UI 并刷新差异按钮。
 * @param {{deferLargeChat?: boolean}} [options={}] 控制长聊天是否分片处理。
 * @returns {void}
 */
export function performGlobalCleanse(options = {}) {
    logger.info(`[performGlobalCleanse] 全局净化开始`);
    const { chat } = getAppContext();
    cancelGlobalCleanseJob();
    buildProcessors();
    if (runtimeState.activeProcessors.length === 0) {
        injectDiffButtons();
        return;
    }

    let chatChanged = false;
    const latestDiffIndices = new Set(getLatestTrackableDiffIndices());
    let syncIndices = [];
    let useDeferredLongChat = false;

    if (chat && Array.isArray(chat)) {
        const { extension_settings } = getAppContext();
        const skipUser = extension_settings[extensionName]?.skipUserMessages === true;
        useDeferredLongChat = options.deferLargeChat === true && chat.length > chatChangedSyncMessageLimit;
        syncIndices = useDeferredLongChat
            ? getChatChangedSyncIndices(chat, latestDiffIndices)
            : chat.map((_, index) => index);

        syncIndices.forEach((index) => {
            const msg = chat[index];
            if (!msg || typeof msg !== 'object') return;
            if (processGlobalCleanseMessageSafely(msg, index, latestDiffIndices, skipUser, { refreshDom: true })) chatChanged = true;
        });

        const latestMsg = chat.length > 0 ? chat[chat.length - 1] : null;
        if (latestMsg && typeof latestMsg === 'object') {
            ['TavernDB_ACU_Data', 'TavernDB_ACU_SummaryData'].forEach((dbKey) => {
                const dbVal = latestMsg[dbKey];
                if (dbVal && typeof dbVal === 'object') {
                    try {
                        const dbChanges = deepCleanObjectSync(dbVal);
                        if (dbChanges > 0) {
                            chatChanged = true;
                            markHostChatDirtyFromIndex(chat.length - 1);
                        }
                    } catch (error) {
                        logger.warn(`[performGlobalCleanse] 跳过异常附加数据 ${dbKey}: ${error?.message || error}`);
                    }
                }
            });
        }

        if (useDeferredLongChat) {
            scheduleGlobalCleanseRemainder(chat, new Set(syncIndices), latestDiffIndices, skipUser);
        }
    }

    syncTrackedIndicesToLatestAssistantMessages();

    if (chatChanged) {
        queueIncrementalChatSave(); // 使用排队保存
    }
    if (useDeferredLongChat) {
        purifyMessageDomByIndices(syncIndices);
    } else {
        purifyDOM(document.getElementById('chat'));
    }
    injectDiffButtons();
}
