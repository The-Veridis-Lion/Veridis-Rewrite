import { renderMultiItemPromptPure } from '../aiRewrite/planning.js';
import { collectAiXmlScopeSegments } from '../aiRewrite/matching.js';
import { buildAiRewriteGenerateRawConfig } from '../aiRewrite/generation.js';
import { getPresetAiRewriteSettings } from '../presets/model.js';
import { getDeepCleanItemAiScopeSettings } from './scan.js';

const normalSourceLimit = 40_000;
const completePromptLimit = 50_000;

function isMessageItem(item) {
    return item?.kind === 'user-message' || item?.kind === 'assistant-swipe';
}

function getFrozenPromptSettings(input) {
    const aiSettings = getPresetAiRewriteSettings(input.preset);
    if (!aiSettings) throw new Error('Deep Clean frozen preset has no AI Prompt settings');
    return {
        ...aiSettings,
        protectXmlComments: input.processingSemantics?.aiProtectXmlComments === true,
    };
}

function getPromptScopeSettings(input) {
    const semantics = input.processingSemantics || {};
    return {
        scopeTags: semantics.scopeTags || [],
        scopeTagBuiltinDismissed: semantics.scopeTagBuiltinDismissed || [],
        scopeTagMode: semantics.scopeTagMode === 'cleanse-inside' ? 'cleanse-inside' : 'protect',
    };
}

function getItemAiSettings(input, item, promptSettings) {
    return {
        ...promptSettings,
        ...getDeepCleanItemAiScopeSettings(input, item),
    };
}

function projectBodyRequestSource(source, rewriteItems, aiSettings) {
    const segments = collectAiXmlScopeSegments(source, aiSettings);
    if (segments.length === 0) return null;

    let requestSource = '';
    const projectedItems = [];
    segments.forEach((segment, segmentIndex) => {
        if (segmentIndex > 0) requestSource += '\n';
        const projectedOuterStart = requestSource.length;
        requestSource += source.slice(segment.outerStart, segment.outerEnd);
        const offset = projectedOuterStart - segment.outerStart;
        rewriteItems.forEach((item) => {
            if (item.start < segment.start || item.end > segment.end) return;
            projectedItems.push({
                ...item,
                segmentIndex,
                relativeStart: item.start - segment.start,
                start: item.start + offset,
                end: item.end + offset,
            });
        });
    });

    if (projectedItems.length !== rewriteItems.length) return null;
    return { requestSource, rewriteItems: projectedItems, sourceSegments: segments };
}

function createPlanningContext(run) {
    return {
        input: run.input,
        contentItems: run.contentItems,
        programProposedResults: Array.isArray(run.programProposedResults) ? run.programProposedResults : [],
        promptSettings: getFrozenPromptSettings(run.input),
        promptScopeSettings: getPromptScopeSettings(run.input),
    };
}

function buildRequestItem(context, itemIndex) {
    const item = context.contentItems[itemIndex];
    if (!item || item.aiEligible !== true || item.protectionReason) return null;

    const programResult = context.programProposedResults.find((entry) => entry?.itemIndex === itemIndex);
    const effectiveSource = String(programResult?.programCandidate ?? item.originalText ?? '');
    const programRewriteItems = Array.isArray(programResult?.rewriteItems) ? programResult.rewriteItems : [];
    if (programRewriteItems.length === 0) return null;

    const itemAiSettings = getItemAiSettings(context.input, item, context.promptSettings);
    const bodyScoped = isMessageItem(item) && context.input.messageAiScope !== 'whole-message';
    const projection = bodyScoped
        ? projectBodyRequestSource(effectiveSource, programRewriteItems, itemAiSettings)
        : {
            requestSource: effectiveSource,
            rewriteItems: programRewriteItems.map((rewriteItem) => ({
                ...rewriteItem,
                segmentIndex: 0,
                relativeStart: rewriteItem.start,
            })),
            sourceSegments: [{ start: 0, end: effectiveSource.length }],
        };
    if (!projection || projection.rewriteItems.length === 0) return null;

    return {
        itemIndex,
        requestSource: projection.requestSource,
        rewriteItems: projection.rewriteItems,
        sourceSegments: projection.sourceSegments,
    };
}

function renderRequestItems(context, requestItems) {
    const prompt = renderMultiItemPromptPure(
        requestItems,
        context.promptScopeSettings,
        context.promptSettings,
        context.promptSettings.promptTemplate,
    );
    return buildAiRewriteGenerateRawConfig(prompt, context.promptSettings)
        .ordered_prompts[0].content;
}

export function renderDeepCleanAiRequest(run, request) {
    const context = createPlanningContext(run);
    const requestItems = Array.isArray(request?.requestItems) ? request.requestItems : [];
    return {
        prompt: renderRequestItems(context, requestItems),
        requestItems,
    };
}

export function planDeepCleanAiRequests(run, itemIndexes = null) {
    if (run.input?.processingMode !== 'program-ai') {
        throw new Error('Deep Clean AI planning requires Program + AI mode');
    }

    const context = createPlanningContext(run);
    const requests = [];
    const oversizedItemIndexes = [];
    const oversizedRequestItems = [];
    const requestItems = [];

    const planningItemIndexes = Array.isArray(itemIndexes)
        ? itemIndexes
        : context.contentItems.map((_, itemIndex) => itemIndex);
    for (const itemIndex of planningItemIndexes) {
        const requestItem = buildRequestItem(context, itemIndex);
        if (!requestItem) continue;

        const singlePrompt = renderRequestItems(context, [requestItem]);
        if (singlePrompt.length > completePromptLimit) {
            oversizedItemIndexes.push(itemIndex);
            oversizedRequestItems.push(requestItem);
            continue;
        }
        requestItems.push(requestItem);
    }

    let cursor = 0;
    while (cursor < requestItems.length) {
        const currentItems = [];
        let currentSourceLength = 0;
        while (cursor < requestItems.length) {
            const requestItem = requestItems[cursor];
            const nextSourceLength = currentSourceLength + requestItem.requestSource.length;
            if (currentItems.length > 0 && nextSourceLength > normalSourceLimit) break;
            currentItems.push(requestItem);
            currentSourceLength = nextSourceLength;
            cursor += 1;
            if (currentItems.length === 1 && currentSourceLength > normalSourceLimit) break;
        }

        let completePrompt = renderRequestItems(context, currentItems);
        while (currentItems.length > 1 && completePrompt.length > completePromptLimit) {
            currentItems.pop();
            cursor -= 1;
            completePrompt = renderRequestItems(context, currentItems);
        }

        if (completePrompt.length > completePromptLimit) {
            oversizedItemIndexes.push(currentItems[0].itemIndex);
            oversizedRequestItems.push(currentItems[0]);
            continue;
        }
        requests.push({
            itemIndexes: currentItems.map((item) => item.itemIndex),
            requestItems: currentItems,
        });
    }

    return { requests, oversizedItemIndexes, oversizedRequestItems };
}
