import { buildAiRewriteGenerateRawConfig, callTavernHelperGenerateRaw } from '../aiRewrite/generation.js';
import { parseAiRewriteResponseObject, validateAiRewriteEntries } from '../aiRewrite/response.js';
import { getPresetAiRewriteSettings } from '../presets/model.js';
import { renderDeepCleanAiRequest } from './aiPlanning.js';

const deepCleanAiRequestTimeoutMs = 300_000;

async function callDeepCleanGenerateRaw(requestConfig) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Deep Clean AI request timed out')), deepCleanAiRequestTimeoutMs);
    });
    try {
        return await Promise.race([
            callTavernHelperGenerateRaw(requestConfig),
            timeoutPromise,
        ]);
    } finally {
        clearTimeout(timeoutId);
    }
}

function getFrozenAiSettings(run) {
    const presetSettings = getPresetAiRewriteSettings(run.input?.preset);
    if (!presetSettings) throw new Error('Deep Clean frozen preset has no AI Prompt settings');
    return {
        ...presetSettings,
        baseUrl: String(run.input?.aiConnection?.baseUrl || '').trim(),
        apiKey: String(run.input?.aiConnection?.apiKey || ''),
        model: String(run.input?.aiConnection?.model || '').trim(),
    };
}

function hasCompleteConnection(aiSettings) {
    return Boolean(aiSettings.baseUrl && aiSettings.apiKey && aiSettings.model);
}

function partitionResponseEntries(parsed, requestItems) {
    const entriesByItemIndex = new Map(requestItems.map((item) => [item.itemIndex, []]));
    for (const entry of Object.entries(parsed)) {
        const id = String(entry[0] || '');
        const ownerMatch = id.match(/^item-(\d+)(?:-|$)/);
        const itemIndex = ownerMatch ? Number(ownerMatch[1]) : -1;
        const ownedEntries = entriesByItemIndex.get(itemIndex);
        if (!ownedEntries) throw new Error(`Deep Clean AI returned unowned id: ${id || '(empty)'}`);
        ownedEntries.push(entry);
    }
    return entriesByItemIndex;
}

function getRewriteRange(requestItem, rewriteItem) {
    const sourceSegment = requestItem.sourceSegments?.[rewriteItem.segmentIndex];
    if (!sourceSegment) throw new Error(`Deep Clean AI target has no source segment: ${rewriteItem.id}`);
    const start = sourceSegment.start + rewriteItem.relativeStart;
    return { start, end: start + String(rewriteItem.text || '').length };
}

function applyAcceptedItemRewrites(effectiveSource, requestItem, accepted) {
    const replacements = requestItem.rewriteItems.map((rewriteItem) => {
        const range = getRewriteRange(requestItem, rewriteItem);
        if (effectiveSource.slice(range.start, range.end) !== String(rewriteItem.text || '')) {
            throw new Error(`Deep Clean AI target no longer matches source: ${rewriteItem.id}`);
        }
        return { ...range, rewritten: accepted.get(rewriteItem.id) };
    }).sort((left, right) => right.start - left.start);

    let candidate = effectiveSource;
    for (const replacement of replacements) {
        candidate = candidate.slice(0, replacement.start)
            + replacement.rewritten
            + candidate.slice(replacement.end);
    }
    return candidate;
}

export function resolveDeepCleanFinalProposedText(run, itemIndex) {
    const aiResult = run.aiProposedResults?.find((entry) => entry?.itemIndex === itemIndex);
    if (aiResult) return String(aiResult.aiCandidate || '');
    const programResult = run.programProposedResults?.find((entry) => entry?.itemIndex === itemIndex);
    if (programResult) return String(programResult.programCandidate || '');
    return String(run.contentItems?.[itemIndex]?.originalText || '');
}

function replaceProgramCandidate(programProposedResults, itemIndex, programCandidate, originalText) {
    const nextResults = programProposedResults.filter((entry) => entry?.itemIndex !== itemIndex);
    if (programCandidate !== originalText) nextResults.push({ itemIndex, programCandidate });
    return nextResults;
}

function applyPlannedProgramFallback(run, programProposedResults, requestItem) {
    const itemIndex = requestItem.itemIndex;
    const originalText = String(run.contentItems?.[itemIndex]?.originalText || '');
    const programCandidate = String(run.programProposedResults
        ?.find((entry) => entry?.itemIndex === itemIndex)
        ?.programCandidate ?? originalText);
    const projectedMatches = requestItem.rewriteItems
        .flatMap((rewriteItem) => Array.isArray(rewriteItem.matches) ? rewriteItem.matches : [])
        .filter((match) => Number.isInteger(match?.projectedStart)
            && Number.isInteger(match?.projectedEnd))
        .sort((left, right) => right.projectedStart - left.projectedStart
            || right.projectedEnd - left.projectedEnd);
    const appliedRanges = [];
    let fallbackCandidate = programCandidate;
    for (const match of projectedMatches) {
        const start = match.projectedStart;
        const end = match.projectedEnd;
        if (start < 0
            || end < start
            || end > fallbackCandidate.length
            || appliedRanges.some((range) => start < range.end && range.start < end)) {
            continue;
        }
        fallbackCandidate = fallbackCandidate.slice(0, start)
            + String(match.programFallbackText ?? '')
            + fallbackCandidate.slice(end);
        appliedRanges.push({ start, end });
    }
    return replaceProgramCandidate(programProposedResults, itemIndex, fallbackCandidate, originalText);
}

export async function executeDeepCleanAiRequests(run, { onProgress, shouldStop } = {}) {
    const requests = Array.isArray(run.aiRequestPlan?.requests) ? run.aiRequestPlan.requests : [];
    const aiSettings = getFrozenAiSettings(run);
    const aiProposedResults = [];
    let programProposedResults = Array.isArray(run.programProposedResults) ? [...run.programProposedResults] : [];
    const failedItemIndexes = new Set();
    const failedRequestIndexes = [];
    const stoppedResult = () => ({
        aiProposedResults,
        programProposedResults,
        aiFailedItemIndexes: [...failedItemIndexes].sort((left, right) => left - right),
        aiFailedRequestIndexes: [...failedRequestIndexes],
        stopped: true,
    });
    for (const requestItem of run.aiRequestPlan?.oversizedRequestItems || []) {
        programProposedResults = applyPlannedProgramFallback(run, programProposedResults, requestItem);
    }
    onProgress?.({ completed: 0, planned: requests.length });

    let completed = 0;
    for (let requestIndex = 0; requestIndex < requests.length; requestIndex++) {
        const request = requests[requestIndex];
        if (shouldStop?.()) return stoppedResult();
        const reconstructed = renderDeepCleanAiRequest(run, request);
        if (!hasCompleteConnection(aiSettings)) {
            failedRequestIndexes.push(requestIndex);
            reconstructed.requestItems.forEach((requestItem) => {
                failedItemIndexes.add(requestItem.itemIndex);
                programProposedResults = applyPlannedProgramFallback(run, programProposedResults, requestItem);
            });
            completed += 1;
            onProgress?.({ completed, planned: requests.length });
            continue;
        }

        try {
            const requestConfig = buildAiRewriteGenerateRawConfig(reconstructed.prompt, aiSettings);
            const response = await callDeepCleanGenerateRaw(requestConfig);
            if (shouldStop?.()) return stoppedResult();
            const responseText = typeof response === 'string' ? response : String(response ?? '');
            if (!responseText) throw new Error('Deep Clean AI returned an empty response');
            const parsed = parseAiRewriteResponseObject(responseText);
            const entriesByItemIndex = partitionResponseEntries(parsed, reconstructed.requestItems);

            for (const requestItem of reconstructed.requestItems) {
                try {
                    const itemById = new Map(requestItem.rewriteItems.map((item) => [item.id, item]));
                    const accepted = validateAiRewriteEntries(
                        entriesByItemIndex.get(requestItem.itemIndex) || [],
                        itemById,
                    );
                    const originalSource = String(run.contentItems?.[requestItem.itemIndex]?.originalText || '');
                    const programSource = String(run.programProposedResults
                        ?.find((entry) => entry?.itemIndex === requestItem.itemIndex)
                        ?.programCandidate ?? originalSource);
                    const aiCandidate = applyAcceptedItemRewrites(programSource, requestItem, accepted);
                    if (aiCandidate !== programSource) {
                        aiProposedResults.push({ itemIndex: requestItem.itemIndex, aiCandidate });
                    }
                } catch {
                    failedItemIndexes.add(requestItem.itemIndex);
                    programProposedResults = applyPlannedProgramFallback(run, programProposedResults, requestItem);
                }
            }
        } catch {
            if (shouldStop?.()) return stoppedResult();
            failedRequestIndexes.push(requestIndex);
            reconstructed.requestItems.forEach((requestItem) => {
                failedItemIndexes.add(requestItem.itemIndex);
                programProposedResults = applyPlannedProgramFallback(run, programProposedResults, requestItem);
            });
        }
        if (shouldStop?.()) return stoppedResult();
        completed += 1;
        onProgress?.({ completed, planned: requests.length });
    }

    return {
        aiProposedResults,
        programProposedResults,
        aiFailedItemIndexes: [...failedItemIndexes].sort((left, right) => left - right),
        aiFailedRequestIndexes: failedRequestIndexes,
    };
}
