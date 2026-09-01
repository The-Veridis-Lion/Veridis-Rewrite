import { collectAiMatches, compileAiMatchers } from '../aiRewrite/matching.js';
import { compileProcessors, countScopedProcessorMatches } from '../rules/engine.js';
import { getPresetRules } from '../presets/model.js';

const affectedTypeKeys = ['Character', 'Message', 'Persona', 'World Book', 'Shujuku'];
const scanChunkSize = 32;

function categoryForItem(item) {
    if (item?.kind === 'persona-description') return 'Persona';
    if (item?.kind === 'external-world-book-entry') return 'World Book';
    if (item?.kind === 'shujuku-cell') return 'Shujuku';
    if (item?.kind === 'user-message' || item?.kind === 'assistant-swipe') return 'Message';
    return 'Character';
}

export function createDeepCleanMatcherSettings(input) {
    const semantics = input.processingSemantics || {};
    return {
        rules: getPresetRules(input.preset),
        scopeTags: semantics.scopeTags || [],
        scopeTagBuiltinDismissed: semantics.scopeTagBuiltinDismissed || [],
        scopeTagMode: semantics.scopeTagMode || 'protect',
        zhVariantCompatEnabled: semantics.zhVariantCompatEnabled === true,
        zhVariantCompatOptions: semantics.zhVariantCompatOptions || {},
    };
}

function getMessageAiSettings(input) {
    const semantics = input.processingSemantics || {};
    const configuredTag = String(semantics.aiXmlScopeTag || '').trim();
    const bodyTag = configuredTag || 'content';
    return {
        protectXmlComments: semantics.aiProtectXmlComments === true,
        xmlScopeTag: input.messageAiScope === 'whole-message' ? '' : bodyTag,
    };
}

function getNonMessageAiSettings(input) {
    return {
        protectXmlComments: input.processingSemantics?.aiProtectXmlComments === true,
        xmlScopeTag: '',
    };
}

export function getDeepCleanItemAiScopeSettings(input, item) {
    const isMessage = item?.kind === 'user-message' || item?.kind === 'assistant-swipe';
    return isMessage ? getMessageAiSettings(input) : getNonMessageAiSettings(input);
}

export function collectDeepCleanAiMatches(input, item, compiledSemantics, settings = createDeepCleanMatcherSettings(input)) {
    const semantics = input.processingSemantics || {};
    const matcherOptions = {
        useZhVariantCompat: settings.zhVariantCompatEnabled === true
            && semantics.zhVariantDictionaryReady === true,
        zhVariantOptions: settings.zhVariantCompatOptions,
        compiledMatchers: compiledSemantics.aiMatchers,
    };
    return collectAiMatches(
        String(item?.originalText || ''),
        settings,
        getDeepCleanItemAiScopeSettings(input, item),
        { ...matcherOptions, messageScoped: item?.kind === 'user-message' || item?.kind === 'assistant-swipe' },
    );
}

export async function scanDeepCleanContentItems(input, contentItems, options = {}) {
    const items = Array.isArray(contentItems) ? contentItems : [];
    const settings = createDeepCleanMatcherSettings(input);
    const matcherOptions = {
        useZhVariantCompat: settings.zhVariantCompatEnabled === true
            && input.processingSemantics?.zhVariantDictionaryReady === true,
        zhVariantOptions: settings.zhVariantCompatOptions,
    };
    const compiledSemantics = options.compiledSemantics || {
        programProcessors: compileProcessors(settings.rules, matcherOptions).dataProcessors,
        aiMatchers: compileAiMatchers(settings, matcherOptions),
    };
    const processors = compiledSemantics.programProcessors;
    const affectedByType = Object.fromEntries(affectedTypeKeys.map((key) => [key, 0]));
    const affectedItemIndexes = [];
    let programHitCount = 0;
    let aiHitCount = 0;
    let pendingCharacterCount = 0;

    for (let chunkStart = 0; chunkStart < items.length; chunkStart += scanChunkSize) {
        if (options.shouldStop?.()) return null;
        const chunkEnd = Math.min(chunkStart + scanChunkSize, items.length);
        for (let itemIndex = chunkStart; itemIndex < chunkEnd; itemIndex++) {
            const item = items[itemIndex];
            const source = String(item?.originalText || '');
            const programHits = item?.programEligible === true
                ? countScopedProcessorMatches(source, processors, settings)
                : 0;
            const scanAiRules = (input.processingMode === 'program' && item?.programEligible === true)
                || (input.processingMode === 'program-ai' && item?.aiEligible === true);
            const aiHits = scanAiRules
                ? collectDeepCleanAiMatches(input, item, compiledSemantics, settings).length
                : 0;
            const affected = programHits > 0 || aiHits > 0;

            programHitCount += programHits;
            aiHitCount += aiHits;
            if (affected) {
                affectedItemIndexes.push(itemIndex);
                affectedByType[categoryForItem(item)]++;
                pendingCharacterCount += source.length;
            }
        }
        options.onProgress?.({ current: chunkEnd, total: items.length });
        if (options.shouldStop?.()) return null;
        if (chunkEnd < items.length) {
            await new Promise((resolve) => requestAnimationFrame(resolve));
            if (options.shouldStop?.()) return null;
        }
    }

    return {
        scannedItemCount: items.length,
        affectedItemCount: affectedItemIndexes.length,
        programHitCount,
        aiHitCount,
        pendingCharacterCount,
        affectedByType,
        affectedItemIndexes,
        compiledSemantics,
    };
}
