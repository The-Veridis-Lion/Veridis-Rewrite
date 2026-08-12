import { defaultAiRewriteSettings } from '../state.js';
import { mergeScopeTagsWithBuiltins } from '../utils.js';
import { collectXmlCommentRanges, maskXmlCommentRanges } from '../aiCommentProtection.js';
import { recordAiRewriteDebug } from './debug.js';

const responseGuard = `输出必须是一个 JSON 对象，键必须恰好为本次全部 rewrite_target 的 id，值必须是可直接替换对应标签内容的字符串；空字符串表示删除。禁止 markdown、解释和额外包装。`;

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

export function normalizeStringList(values) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean))];
}

function buildCompactPromptPayload(items) {
    const rewriteRules = {};
    const ruleIdByInstruction = new Map();
    const ruleIdsByItem = new Map();
    const localFallbackCandidates = {};
    const candidateIdByValues = new Map();
    const candidateIdByItem = new Map();

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

        const candidates = normalizeStringList(item.localFallbackCandidates);
        if (candidates.length > 0) {
            const candidateKey = JSON.stringify(candidates);
            let candidateId = candidateIdByValues.get(candidateKey);
            if (!candidateId) {
                candidateId = `c${candidateIdByValues.size + 1}`;
                candidateIdByValues.set(candidateKey, candidateId);
                localFallbackCandidates[candidateId] = candidates;
            }
            candidateIdByItem.set(item.id, candidateId);
        }
    });

    return {
        rewriteRulesJson: JSON.stringify(rewriteRules),
        localFallbackCandidatesJson: JSON.stringify(localFallbackCandidates),
        ruleIdsByItem,
        candidateIdByItem,
        ruleCount: ruleIdByInstruction.size,
        candidateSetCount: candidateIdByValues.size,
    };
}

function buildAnnotatedSource(originalText, items, settings, maxContextChars, ruleIdsByItem, candidateIdByItem, aiSettings) {
    const source = String(originalText || '');
    const sortedItems = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
    const window = getContextWindow(source, sortedItems, maxContextChars);
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
        const candidateId = candidateIdByItem.get(item.id) || '';
        const candidatesAttribute = candidateId ? ` candidates="${candidateId}"` : '';
        rendered += `<rewrite_target id="${item.id}"${rulesAttribute}${candidatesAttribute}>${source.slice(item.start, item.end)}</rewrite_target>`;
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

export function renderPrompt(originalText, items, settings, aiSettings, promptTemplate = getGlobalPromptTemplate(aiSettings)) {
    const payload = buildCompactPromptPayload(items);
    const annotatedSource = buildAnnotatedSource(
        originalText,
        items,
        settings,
        aiSettings.maxContextChars,
        payload.ruleIdsByItem,
        payload.candidateIdByItem,
        aiSettings
    );
    const template = String(promptTemplate || '');
    const hasRulesPlaceholder = template.includes('{{rewriteRulesJson}}');
    const hasCandidatesPlaceholder = template.includes('{{localFallbackCandidatesJson}}');
    const hasSourcePlaceholder = template.includes('{{annotatedSource}}');
    let rendered = template
        .replaceAll('{{rewriteRulesJson}}', payload.rewriteRulesJson)
        .replaceAll('{{localFallbackCandidatesJson}}', payload.localFallbackCandidatesJson)
        .replaceAll('{{annotatedSource}}', annotatedSource);
    if (!hasRulesPlaceholder) rendered += `\n\n<rewrite_rules>${payload.rewriteRulesJson}</rewrite_rules>`;
    if (!hasCandidatesPlaceholder) rendered += `\n\n<local_fallback_candidates>${payload.localFallbackCandidatesJson}</local_fallback_candidates>`;
    if (!hasSourcePlaceholder) rendered += `\n\n<source>${annotatedSource}</source>`;
    const expectedIds = items.map((item) => item.id);
    const prompt = `${rendered}\n\n${responseGuard}\n本次 id：${JSON.stringify(expectedIds)}。`;
    recordAiRewriteDebug('prompt-built', {
        promptLength: prompt.length,
        templateLength: template.length,
        annotatedSourceLength: annotatedSource.length,
        rewriteRulesLength: payload.rewriteRulesJson.length,
        localFallbackCandidatesLength: payload.localFallbackCandidatesJson.length,
        itemCount: items.length,
        ruleCount: payload.ruleCount,
        candidateSetCount: payload.candidateSetCount,
    });
    return prompt;
}
