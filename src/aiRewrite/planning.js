import { defaultAiRewriteSettings } from '../settings/defaults.js';
import { mergeScopeTagsWithBuiltins } from '../scope/model.js';
import { collectXmlCommentRanges, maskXmlCommentRanges } from './commentProtection.js';
import { recordAiRewriteDebug } from './debug.js';

const responseGuard = `输出必须是一个 JSON 对象，键必须恰好为本次全部 rewrite_target 的 id。每个值必须是替换对应完整目标句子的完整结果字符串；空字符串表示删除整个目标句子。禁止 markdown、解释和额外包装。`;

export function normalizeLimit(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(Math.round(parsed), min), max);
}

function normalizePositiveInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(Math.round(parsed), 1) : fallback;
}

function getEnabledScopeTags(settings) {
    const scopeTags = mergeScopeTagsWithBuiltins(settings.scopeTags, settings.scopeTagBuiltinDismissed);
    return scopeTags.filter((tag) => tag?.enabled !== false);
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

export function collectScopeRanges(text, settings) {
    const scopeTags = getEnabledScopeTags(settings);
    const ranges = [];
    if (!text || scopeTags.length === 0) return ranges;

    let cursor = 0;
    while (cursor < text.length) {
        const nextMatch = findNextScopeTagMatch(text, cursor, scopeTags);
        if (!nextMatch) break;
        const { index, scopeTag } = nextMatch;
        const bodyStart = index + scopeTag.startTag.length;
        const endIndex = text.indexOf(scopeTag.endTag, bodyStart);
        if (endIndex < 0) {
            cursor = bodyStart;
            continue;
        }
        ranges.push({
            start: index,
            bodyStart,
            bodyEnd: endIndex,
            end: endIndex + scopeTag.endTag.length,
            startTag: scopeTag.startTag,
        });
        cursor = endIndex + scopeTag.endTag.length;
    }
    return ranges;
}

function getContextWindow(text, items, maxContextChars) {
    const limit = normalizeLimit(maxContextChars, 12000, 1000, 60000);
    if (text.length <= limit) return { start: 0, end: text.length };
    if (!items.length) return { start: 0, end: limit };

    const minStart = Math.min(...items.map((item) => item.start));
    const maxEnd = Math.max(...items.map((item) => item.end));
    const spanLength = maxEnd - minStart;
    if (spanLength >= limit) return { start: minStart, end: maxEnd };
    const padding = Math.max(0, Math.floor((limit - spanLength) / 2));
    let start = Math.max(0, minStart - padding);
    let end = Math.min(text.length, maxEnd + padding);
    if (end - start < limit) {
        start = Math.max(0, end - limit);
        end = Math.min(text.length, start + limit);
    }
    return { start, end };
}

function redactSourceRange(text, start, end, protectedRanges) {
    let output = '';
    let cursor = start;
    protectedRanges.forEach((range) => {
        const bodyStart = Math.max(start, range.bodyStart);
        const bodyEnd = Math.min(end, range.bodyEnd);
        if (bodyEnd <= bodyStart || bodyEnd <= cursor) return;
        output += text.slice(cursor, Math.max(cursor, bodyStart));
        output += '[已保护内容]';
        cursor = bodyEnd;
    });
    output += text.slice(cursor, end);
    return output;
}

function getGlobalPromptTemplate(aiSettings) {
    return String(aiSettings.promptTemplate || '');
}

function getItemRewriteInstructions(item) {
    return [...new Set((item.matches || [])
        .map((match) => String(match.aiPromptTemplate || '').trim())
        .filter(Boolean))];
}

function buildCompactPromptPayload(items) {
    const rewriteRules = {};
    const ruleIdByInstruction = new Map();
    const ruleIdsByItem = new Map();

    items.forEach((item) => {
        const ruleIds = getItemRewriteInstructions(item).map((instruction) => {
            let ruleId = ruleIdByInstruction.get(instruction);
            if (!ruleId) {
                ruleId = `r${ruleIdByInstruction.size + 1}`;
                ruleIdByInstruction.set(instruction, ruleId);
                rewriteRules[ruleId] = instruction;
            }
            return ruleId;
        });
        ruleIdsByItem.set(item.id, ruleIds);
    });

    return {
        rewriteRulesJson: JSON.stringify(rewriteRules),
        ruleIdsByItem,
        ruleCount: ruleIdByInstruction.size,
    };
}

function buildAnnotatedSource(originalText, items, settings, maxContextChars, ruleIdsByItem, aiSettings, completeSource = false) {
    const source = String(originalText || '');
    const sortedItems = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
    const window = completeSource
        ? { start: 0, end: source.length }
        : getContextWindow(source, sortedItems, maxContextChars);
    const commentRanges = aiSettings?.protectXmlComments === true ? collectXmlCommentRanges(source) : [];
    const scopeScanText = commentRanges.length > 0 ? maskXmlCommentRanges(source, commentRanges) : source;
    const scopeRanges = settings.scopeTagMode === 'cleanse-inside' ? [] : collectScopeRanges(scopeScanText, settings);
    const protectedRanges = [
        ...scopeRanges,
        ...commentRanges.map((range) => ({
            bodyStart: range.start + 4,
            bodyEnd: Math.max(range.start + 4, range.end - 3),
        })),
    ].sort((a, b) => (a.bodyStart || 0) - (b.bodyStart || 0));
    let rendered = window.start > 0 ? '[前文已省略]\n' : '';
    let cursor = window.start;

    sortedItems.forEach((item) => {
        if (item.start < window.start || item.end > window.end) {
            throw new Error(`改写目标 ${item.id} 超出发送上下文范围`);
        }
        rendered += redactSourceRange(source, cursor, item.start, protectedRanges);
        const ruleIds = ruleIdsByItem.get(item.id) || [];
        const rulesAttribute = ruleIds.length > 0 ? ` rules="${ruleIds.join(',')}"` : '';
        rendered += `<rewrite_target id="${item.id}"${rulesAttribute}>${source.slice(item.start, item.end)}</rewrite_target>`;
        cursor = item.end;
    });

    rendered += redactSourceRange(source, cursor, window.end, protectedRanges);
    if (window.end < source.length) rendered += '\n[后文已省略]';
    return rendered;
}

export function groupRewriteItemsByPrompt(items, aiSettings) {
    const batchSize = normalizePositiveInteger(aiSettings.maxItemsPerRequest, defaultAiRewriteSettings.maxItemsPerRequest);
    const groups = [];
    for (let start = 0; start < items.length; start += batchSize) {
        groups.push({
            key: `batch-${Math.floor(start / batchSize) + 1}`,
            promptTemplate: getGlobalPromptTemplate(aiSettings),
            items: items.slice(start, start + batchSize),
        });
    }
    return groups;
}

function finishPromptRender(items, annotatedSource, promptTemplate, payload) {
    const template = String(promptTemplate || '');
    const hasRulesPlaceholder = template.includes('{{rewriteRulesJson}}');
    const hasSourcePlaceholder = template.includes('{{annotatedSource}}');
    let rendered = template
        .replaceAll('{{rewriteRulesJson}}', payload.rewriteRulesJson)
        .replaceAll('{{annotatedSource}}', annotatedSource);
    if (!hasRulesPlaceholder) rendered += `\n\n<rewrite_rules>${payload.rewriteRulesJson}</rewrite_rules>`;
    if (!hasSourcePlaceholder) rendered += `\n\n<source>${annotatedSource}</source>`;
    const expectedIds = items.map((item) => item.id);
    return {
        prompt: `${rendered}\n\n${responseGuard}\n本次 id：${JSON.stringify(expectedIds)}。`,
        metrics: {
            templateLength: template.length,
            annotatedSourceLength: annotatedSource.length,
            rewriteRulesLength: payload.rewriteRulesJson.length,
            itemCount: items.length,
            ruleCount: payload.ruleCount,
        },
    };
}

function buildSingleSourcePromptRender(originalText, items, settings, aiSettings, promptTemplate) {
    const payload = buildCompactPromptPayload(items);
    const annotatedSource = buildAnnotatedSource(
        originalText,
        items,
        settings,
        aiSettings.maxContextChars,
        payload.ruleIdsByItem,
        aiSettings
    );
    return finishPromptRender(items, annotatedSource, promptTemplate, payload);
}

export function renderPromptPure(originalText, items, settings, aiSettings, promptTemplate = getGlobalPromptTemplate(aiSettings)) {
    return buildSingleSourcePromptRender(originalText, items, settings, aiSettings, promptTemplate).prompt;
}

export function renderMultiItemPromptPure(requestItems, settings, aiSettings, promptTemplate = getGlobalPromptTemplate(aiSettings)) {
    const orderedItems = Array.isArray(requestItems) ? requestItems : [];
    const rewriteItems = orderedItems.flatMap((item) => item.rewriteItems || []);
    const payload = buildCompactPromptPayload(rewriteItems);
    const annotatedSource = orderedItems.map((item) => {
        const itemIndex = Number(item.itemIndex);
        const itemIdentity = `item-${itemIndex}`;
        const annotatedItemSource = buildAnnotatedSource(
            item.requestSource,
            item.rewriteItems,
            settings,
            0,
            payload.ruleIdsByItem,
            aiSettings,
            true,
        );
        return `<content_item id="${itemIdentity}">\n${annotatedItemSource}\n</content_item>`;
    }).join('\n');
    return finishPromptRender(rewriteItems, annotatedSource, promptTemplate, payload).prompt;
}

export function renderPrompt(originalText, items, settings, aiSettings, promptTemplate = getGlobalPromptTemplate(aiSettings)) {
    const result = buildSingleSourcePromptRender(originalText, items, settings, aiSettings, promptTemplate);
    recordAiRewriteDebug('prompt-built', {
        promptLength: result.prompt.length,
        ...result.metrics,
    });
    return result.prompt;
}
