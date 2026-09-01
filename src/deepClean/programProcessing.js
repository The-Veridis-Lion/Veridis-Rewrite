import {
    applyAiProgramFallbackMatches,
    buildRewriteItems,
    materializeProjectedRewriteItems,
    resolveRewriteTrackedRanges,
} from '../aiRewrite/matching.js';
import { applyScopedCompiledReplacementsWithTrackedRanges } from '../rules/engine.js';
import {
    collectDeepCleanAiMatches,
    createDeepCleanMatcherSettings,
    getDeepCleanItemAiScopeSettings,
} from './scan.js';

function getProgramScopeSettings(input) {
    const semantics = input.processingSemantics || {};
    return {
        scopeTags: semantics.scopeTags || [],
        scopeTagBuiltinDismissed: semantics.scopeTagBuiltinDismissed || [],
        scopeTagMode: semantics.scopeTagMode || 'protect',
    };
}

export function buildDeepCleanProgramExecution(input, item, compiledSemantics, sourceText, ranges = []) {
    return applyScopedCompiledReplacementsWithTrackedRanges(
        String(sourceText || ''),
        compiledSemantics.programProcessors,
        getProgramScopeSettings(input),
        false,
        ranges,
    );
}

export function buildDeepCleanProgramText(input, item, compiledSemantics, sourceText) {
    return buildDeepCleanProgramExecution(input, item, compiledSemantics, sourceText).text;
}

export function processDeepCleanProgramCandidates(input, contentItems, scanResult, itemIndexes = null) {
    const items = Array.isArray(contentItems) ? contentItems : [];
    const compiledSemantics = scanResult.compiledSemantics;
    const proposedResults = [];

    const processingItemIndexes = Array.isArray(itemIndexes) ? itemIndexes : scanResult.affectedItemIndexes;
    for (const itemIndex of processingItemIndexes) {
        const item = items[itemIndex];
        if (!item || item.protectionReason) continue;

        const originalText = String(item.originalText || '');
        if (input.processingMode === 'program') {
            if (item.programEligible !== true) continue;
            const programSource = applyAiProgramFallbackMatches(
                originalText,
                collectDeepCleanAiMatches(input, item, compiledSemantics),
            );
            const programCandidate = buildDeepCleanProgramText(input, item, compiledSemantics, programSource);
            if (programCandidate !== originalText) proposedResults.push({ itemIndex, programCandidate });
            continue;
        }

        const settings = createDeepCleanMatcherSettings(input);
        const aiSettings = getDeepCleanItemAiScopeSettings(input, item);
        const matches = item.aiEligible === true
            ? collectDeepCleanAiMatches(input, item, compiledSemantics, settings)
            : [];
        const originalRewriteItems = buildRewriteItems(
            originalText,
            matches,
            settings,
            aiSettings,
            { createId: (targetIndex) => `item-${itemIndex}-hit-${targetIndex + 1}` },
        );
        const resolved = resolveRewriteTrackedRanges(originalText, originalRewriteItems, aiSettings);
        if (!resolved.valid) {
            throw new Error(`Deep Clean Original AI target identity is invalid: ${resolved.failedItemId}`);
        }
        const execution = item.programEligible === true
            ? buildDeepCleanProgramExecution(input, item, compiledSemantics, originalText, resolved.ranges)
            : { text: originalText, ranges: resolved.ranges, projection: [], valid: true };
        if (!execution.valid) {
            throw new Error(`Deep Clean Program projection failed for item ${itemIndex}`);
        }
        const projected = materializeProjectedRewriteItems(
            execution.text,
            originalRewriteItems,
            execution.ranges,
        );
        if (!projected.valid) {
            throw new Error(`Deep Clean Program AI target projection is invalid: ${projected.failedItemId}`);
        }

        if (execution.text !== originalText || projected.items.length > 0) {
            const proposedResult = {
                itemIndex,
                programCandidate: execution.text,
            };
            if (projected.items.length > 0) {
                proposedResult.rewriteItems = projected.items;
            }
            proposedResults.push(proposedResult);
        }
    }

    return proposedResults;
}
