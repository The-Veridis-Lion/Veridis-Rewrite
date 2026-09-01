// Owns the Deep Clean lifecycle: Initial Selection → Freeze/resource read → Scan → Processing → Review or Program Direct Apply → Apply → Complete/Stopped/Error; it coordinates existing stage owners without implementing resource-specific persistence.
import { defaultAiRewriteSettings, extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { deepCleanRuntimeState } from './state.js';
import { logger } from '../log.js';
import { getSillyTavernContextSnapshot } from '../host/context.js';
import { normalizeOptionalXmlTagNameInput } from '../scope/model.js';
import { getZhVariantCompatOptions, isZhDictionaryRuntimeReady } from '../zh/dictionary.js';
import { readDeepCleanContentItems } from './contentItems.js';
import { loadDeepCleanResourceInventory } from './inventory.js';
import { processDeepCleanProgramCandidates } from './programProcessing.js';
import { planDeepCleanAiRequests } from './aiPlanning.js';
import { executeDeepCleanAiRequests } from './aiProcessing.js';
import { scanDeepCleanContentItems } from './scan.js';
import { persistDeepCleanProposedBatch, persistDeepCleanReview } from './apply/index.js';
import { createDeepCleanReviewSession, getDeepCleanReviewItemIndexes } from './review.js';
import {
    createDeepCleanSafeDiagnostic,
    recordDeepCleanFailure,
    recordDeepCleanSuccess,
} from './diagnostics.js';

const reviewBatchCharacterLimit = 90_000;
const programDirectBatchCharacterLimit = 100_000;

function assertLateV1FitsOneApplyBatch(input, contentItems, affectedItemIndexes) {
    const characterLimit = input.processingMode === 'program' && input.programApplyPolicy === 'direct'
        ? programDirectBatchCharacterLimit
        : reviewBatchCharacterLimit;
    const ownerBatch = new Map();
    let batchIndex = 0;
    let batchItemCount = 0;
    let sourceCharacterCount = 0;
    for (const itemIndex of affectedItemIndexes) {
        const item = contentItems[itemIndex];
        const itemLength = item.originalText.length;
        if (batchItemCount > 0 && sourceCharacterCount + itemLength > characterLimit) {
            batchIndex += 1;
            batchItemCount = 0;
            sourceCharacterCount = 0;
        }
        if (item.kind === 'shujuku-cell' && item.storageProtocol === 'v1') {
            const locator = item.locator || {};
            const owner = `${locator.characterKey}\u0000${locator.chatId}\u0000${locator.isolationKey}`;
            const existingBatch = ownerBatch.get(owner);
            if (existingBatch !== undefined && existingBatch !== batchIndex) {
                throw new Error(`Deep Clean Shujuku V1 Cells exceed one Apply batch: ${locator.characterKey}/${locator.chatId}/${locator.isolationKey}`);
            }
            ownerBatch.set(owner, batchIndex);
        }
        batchItemCount += 1;
        sourceCharacterCount += itemLength;
    }
}

function selectedResourceKeys(inventory, quickSelection, specifiedCharacterKeys) {
    const characterKeys = [];
    const chatKeys = [];
    const personaKeys = [];
    const worldBookKeys = [];
    const addUnique = (values, value) => {
        if (value && !values.includes(value)) values.push(value);
    };

    const includeCharacter = (characterKey, includeChats) => {
        const character = inventory.characters.find((item) => item.characterKey === characterKey);
        if (!character) return;
        addUnique(characterKeys, character.characterKey);
        if (includeChats) {
            inventory.chats
                .filter((chat) => chat.characterKey === character.characterKey)
                .forEach((chat) => addUnique(chatKeys, chat.key));
        }
        inventory.personas
            .filter((persona) => persona.characterKeys.includes(character.characterKey))
            .forEach((persona) => addUnique(personaKeys, persona.personaKey));
        inventory.worldBooks
            .filter((worldBook) => worldBook.characterKeys.includes(character.characterKey))
            .forEach((worldBook) => addUnique(worldBookKeys, worldBook.worldBookKey));
    };

    const includeChat = (chatKey) => {
        const chat = inventory.chats.find((item) => item.key === chatKey);
        if (!chat) return;
        addUnique(chatKeys, chat.key);
        includeCharacter(chat.characterKey, false);
        inventory.personas
            .filter((persona) => persona.chatKeys.includes(chat.key))
            .forEach((persona) => addUnique(personaKeys, persona.personaKey));
        inventory.worldBooks
            .filter((worldBook) => worldBook.chatKeys.includes(chat.key))
            .forEach((worldBook) => addUnique(worldBookKeys, worldBook.worldBookKey));
    };

    if (quickSelection === 'current-chat') includeChat(inventory.current.chatKey);
    if (quickSelection === 'current-character') includeCharacter(inventory.current.characterKey, true);
    if (quickSelection === 'specified-characters') {
        specifiedCharacterKeys.forEach((characterKey) => includeCharacter(characterKey, true));
    }
    if (quickSelection === 'all-tavern') {
        inventory.characters.forEach((character) => addUnique(characterKeys, character.characterKey));
        inventory.chats.forEach((chat) => addUnique(chatKeys, chat.key));
        inventory.personas.forEach((persona) => addUnique(personaKeys, persona.personaKey));
        inventory.worldBooks.forEach((worldBook) => addUnique(worldBookKeys, worldBook.worldBookKey));
    }
    return { characterKeys, chatKeys, personaKeys, worldBookKeys };
}

export async function startDeepCleanRun() {
    deepCleanRuntimeState.deepCleanPhase = 'initial-selection';
    deepCleanRuntimeState.deepCleanSelection = null;
    const inventory = await loadDeepCleanResourceInventory();
    const settings = getAppContext().extension_settings?.[extensionName] ?? {};
    const presetNames = Object.keys(settings.presets ?? {});
    const activePreset = String(settings.activePreset || '');
    deepCleanRuntimeState.deepCleanSelection = {
        inventory,
        quickSelection: '',
        specifiedCharacterKeys: [],
        presetName: presetNames.includes(activePreset) ? activePreset : (presetNames[0] || ''),
        processingMode: 'program',
        programApplyPolicy: 'direct',
        messageAiScope: 'body',
        ...selectedResourceKeys(inventory, '', []),
    };
    logger.info('[Deep Clean] initial-selection');
    return deepCleanRuntimeState.deepCleanSelection;
}

export function getDeepCleanInitialSelection() {
    return deepCleanRuntimeState.deepCleanPhase === 'initial-selection'
        ? deepCleanRuntimeState.deepCleanSelection
        : null;
}

export function chooseDeepCleanQuickSelection(quickSelection) {
    const selection = getDeepCleanInitialSelection();
    if (!selection) return null;
    selection.quickSelection = quickSelection;
    Object.assign(selection, selectedResourceKeys(
        selection.inventory,
        selection.quickSelection,
        selection.specifiedCharacterKeys,
    ));
    return selection;
}

export function setDeepCleanSpecifiedCharacters(characterKeys) {
    const selection = getDeepCleanInitialSelection();
    if (!selection) return null;
    selection.specifiedCharacterKeys = (Array.isArray(characterKeys) ? characterKeys : [])
        .filter((characterKey, index, values) => (
            typeof characterKey === 'string'
            && values.indexOf(characterKey) === index
            && selection.inventory.characters.some((character) => character.characterKey === characterKey)
        ));
    if (selection.quickSelection === 'specified-characters') {
        Object.assign(selection, selectedResourceKeys(
            selection.inventory,
            selection.quickSelection,
            selection.specifiedCharacterKeys,
        ));
    }
    return selection;
}

export function setDeepCleanFinalSelection(kind, keys) {
    const selection = getDeepCleanInitialSelection();
    const propertyByKind = {
        character: 'characterKeys',
        chat: 'chatKeys',
        persona: 'personaKeys',
        'world-book': 'worldBookKeys',
    };
    const sourceByKind = {
        character: ['characters', 'characterKey'],
        chat: ['chats', 'key'],
        persona: ['personas', 'personaKey'],
        'world-book': ['worldBooks', 'worldBookKey'],
    };
    const property = propertyByKind[kind];
    const source = sourceByKind[kind];
    if (!selection || !property || !source) return null;
    selection[property] = (Array.isArray(keys) ? keys : [])
        .filter((key, index, values) => (
            typeof key === 'string'
            && values.indexOf(key) === index
            && selection.inventory[source[0]].some((item) => item[source[1]] === key)
        ));
    return selection;
}

export function setDeepCleanLocalOption(option, value) {
    const selection = getDeepCleanInitialSelection();
    if (!selection) return null;
    if (option === 'presetName') {
        const presetName = String(value || '');
        const presets = getAppContext().extension_settings?.[extensionName]?.presets ?? {};
        if (Object.hasOwn(presets, presetName)) selection.presetName = presetName;
    }
    if (option === 'processingMode' && (value === 'program' || value === 'program-ai')) {
        selection.processingMode = value;
    }
    if (option === 'programApplyPolicy' && (value === 'direct' || value === 'review')) {
        selection.programApplyPolicy = value;
    }
    if (option === 'messageAiScope' && (value === 'body' || value === 'whole-message')) {
        selection.messageAiScope = value;
    }
    return selection;
}

function freezeValue(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    if (value instanceof RegExp) return value;
    Object.values(value).forEach((entry) => freezeValue(entry));
    return Object.freeze(value);
}

function frozenRunInput(selection, settings) {
    const preset = settings?.presets?.[selection.presetName];
    if (!preset) throw new Error('Deep Clean selected preset no longer exists');
    const globalAiSettings = { ...defaultAiRewriteSettings, ...(settings.aiRewrite || {}) };
    const chats = selection.chatKeys.map((key) => {
        const chat = selection.inventory.chats.find((item) => item.key === key);
        if (!chat) throw new Error(`Deep Clean selected Chat no longer exists: ${key}`);
        return { characterKey: chat.characterKey, chatId: chat.chatId };
    });
    return freezeValue({
        presetName: selection.presetName,
        preset: structuredClone(preset),
        processingMode: selection.processingMode,
        programApplyPolicy: selection.programApplyPolicy,
        messageAiScope: selection.messageAiScope,
        aiConnection: {
            baseUrl: String(globalAiSettings.baseUrl || '').trim(),
            apiKey: String(globalAiSettings.apiKey || ''),
            model: String(globalAiSettings.model || '').trim(),
        },
        characterKeys: [...selection.characterKeys],
        chatKeys: [...selection.chatKeys],
        chats,
        personaKeys: [...selection.personaKeys],
        worldBookKeys: [...selection.worldBookKeys],
        processingSemantics: {
            scopeTags: structuredClone(settings.scopeTags || []),
            scopeTagBuiltinDismissed: structuredClone(settings.scopeTagBuiltinDismissed || []),
            scopeTagMode: settings.scopeTagMode === 'cleanse-inside' ? 'cleanse-inside' : 'protect',
            zhVariantCompatEnabled: settings.zhVariantCompatEnabled === true,
            zhVariantCompatOptions: structuredClone(getZhVariantCompatOptions(settings)),
            zhVariantDictionaryReady: isZhDictionaryRuntimeReady(),
            aiXmlScopeTag: normalizeOptionalXmlTagNameInput(settings.aiRewrite?.xmlScopeTag, 'content'),
            aiProtectXmlComments: settings.aiRewrite?.protectXmlComments === true,
        },
    });
}

async function freezeDeepCleanRun(options = {}) {
    const selection = getDeepCleanInitialSelection();
    if (!selection) return null;
    const lifecycle = {
        run: null,
        nextAffectedItemCursor: 0,
        currentReviewSession: null,
        lookahead: null,
        stopRequested: false,
        applyResults: [],
        processedRuns: [],
        diagnosticStartedAt: Date.now(),
    };
    deepCleanRuntimeState.deepCleanPhase = 'frozen';
    deepCleanRuntimeState.deepCleanSelection = lifecycle;
    let input = null;
    try {
        const settings = getAppContext().extension_settings?.[extensionName] ?? {};
        input = frozenRunInput(selection, settings);
        options.onProgress?.({ stage: 'read', current: 0, total: input.characterKeys.length + input.chats.length + input.personaKeys.length + input.worldBookKeys.length });
        const context = getSillyTavernContextSnapshot();
        const contentItems = await readDeepCleanContentItems(input, {
            context,
            fetchImpl: globalThis.fetch?.bind(globalThis),
            onProgress: ({ current, total }) => options.onProgress?.({ stage: 'read', current, total }),
            shouldStop: () => lifecycle.stopRequested,
        });
        if (lifecycle.stopRequested) {
            markDeepCleanStopped(lifecycle);
            return null;
        }
        lifecycle.run = freezeValue({ input, contentItems });
        logger.info(`[Deep Clean] frozen content items=${contentItems.length}`);
        return lifecycle;
    } catch (error) {
        if (lifecycle.stopRequested) return null;
        if (deepCleanRuntimeState.deepCleanSelection !== lifecycle) throw error;
        finalizeDeepCleanFailure(lifecycle, 'read', 'read_failed', { input });
        throw error;
    }
}

export async function runDeepCleanScan(options = {}) {
    let lifecycle = null;
    let scanResult = null;
    try {
        options.onProgress?.({ stage: 'prepare' });
        lifecycle = await freezeDeepCleanRun(options);
        if (!lifecycle) return null;
        const frozenRun = lifecycle.run;
        options.onProgress?.({ stage: 'analyze', current: 0, total: frozenRun.contentItems.length });
        scanResult = await scanDeepCleanContentItems(frozenRun.input, frozenRun.contentItems, {
            onProgress: ({ current, total }) => options.onProgress?.({ stage: 'analyze', current, total }),
            shouldStop: () => lifecycle.stopRequested,
        });
        if (!scanResult || lifecycle.stopRequested) {
            lifecycle.run = null;
            markDeepCleanStopped(lifecycle);
            return null;
        }
        assertLateV1FitsOneApplyBatch(frozenRun.input, frozenRun.contentItems, scanResult.affectedItemIndexes);
        options.onProgress?.({ stage: 'summarize' });
        lifecycle.run = freezeValue({
            input: frozenRun.input,
            contentItems: frozenRun.contentItems,
            scanResult,
        });
        deepCleanRuntimeState.deepCleanPhase = 'scan-result';
        logger.info(`[Deep Clean] scan complete items=${scanResult.scannedItemCount} affected=${scanResult.affectedItemCount}`);
        return lifecycle.run;
    } catch (error) {
        lifecycle ||= deepCleanRuntimeState.deepCleanSelection;
        if (lifecycle?.stopRequested) return null;
        if (lifecycle && deepCleanRuntimeState.deepCleanSelection === lifecycle) {
            finalizeDeepCleanFailure(lifecycle, 'scan', 'scan_failed', { scanResult });
        }
        throw error;
    }
}

function takeNextDeepCleanBatch(lifecycle) {
    const affectedItemIndexes = lifecycle.run.scanResult.affectedItemIndexes;
    const characterLimit = lifecycle.run.input.processingMode === 'program'
        && lifecycle.run.input.programApplyPolicy === 'direct'
        ? programDirectBatchCharacterLimit
        : reviewBatchCharacterLimit;
    const itemIndexes = [];
    let sourceCharacterCount = 0;
    while (lifecycle.nextAffectedItemCursor < affectedItemIndexes.length) {
        const itemIndex = affectedItemIndexes[lifecycle.nextAffectedItemCursor];
        const itemLength = lifecycle.run.contentItems[itemIndex].originalText.length;
        if (itemIndexes.length > 0 && sourceCharacterCount + itemLength > characterLimit) break;
        itemIndexes.push(itemIndex);
        sourceCharacterCount += itemLength;
        lifecycle.nextAffectedItemCursor++;
    }
    return itemIndexes.length > 0 ? freezeValue({ itemIndexes, sourceCharacterCount }) : null;
}

function reportBatchProgress(onProgress, batch, stage, progress = {}) {
    onProgress?.({
        stage,
        itemIndexes: batch.itemIndexes,
        itemCount: batch.itemIndexes.length,
        sourceCharacterCount: batch.sourceCharacterCount,
        ...progress,
    });
}

async function processDeepCleanBatch(lifecycle, batch, onProgress) {
    if (lifecycle.stopRequested) return null;
    const run = lifecycle.run;
    reportBatchProgress(onProgress, batch, 'program-processing');
    const programProposedResults = processDeepCleanProgramCandidates(
        run.input,
        run.contentItems,
        run.scanResult,
        batch.itemIndexes,
    );
    if (lifecycle.stopRequested) return null;

    let processedRun = {
        input: run.input,
        contentItems: run.contentItems,
        scanResult: run.scanResult,
        reviewBatch: batch,
        programProposedResults,
    };
    if (run.input.processingMode === 'program-ai') {
        reportBatchProgress(onProgress, batch, 'ai-planning');
        const aiRequestPlan = planDeepCleanAiRequests(processedRun, batch.itemIndexes);
        if (lifecycle.stopRequested) return null;
        processedRun = { ...processedRun, aiRequestPlan };
        const aiResult = await executeDeepCleanAiRequests(processedRun, {
            shouldStop: () => lifecycle.stopRequested,
            onProgress: (progress) => reportBatchProgress(onProgress, batch, 'ai-processing', progress),
        });
        if (aiResult.stopped || lifecycle.stopRequested) return null;
        processedRun = { ...processedRun, ...aiResult };
    }
    if (lifecycle.stopRequested) return null;
    processedRun = freezeValue(processedRun);
    const reviewItemIndexes = getDeepCleanReviewItemIndexes(processedRun, batch.itemIndexes);
    lifecycle.processedRuns.push(processedRun);
    reportBatchProgress(onProgress, batch, 'proposed-ready');
    return {
        batch,
        processedRun,
        reviewItemIndexes,
    };
}

async function processNextDeepCleanBatch(lifecycle, onProgress) {
    while (!lifecycle.stopRequested) {
        const batch = takeNextDeepCleanBatch(lifecycle);
        if (!batch) return null;
        const processed = await processDeepCleanBatch(lifecycle, batch, onProgress);
        if (!processed) return null;
        if (processed.reviewItemIndexes.length > 0) return processed;
        logger.info(`[Deep Clean] skipped unchanged Batch items=${batch.itemIndexes.length}`);
    }
    return null;
}

function markDeepCleanStopped(lifecycle) {
    lifecycle.stopRequested = true;
    lifecycle.currentReviewSession = null;
    lifecycle.lookahead = null;
    lifecycle.diagnosticStartedAt = null;
    if (deepCleanRuntimeState.deepCleanSelection === lifecycle) {
        deepCleanRuntimeState.deepCleanSelection = null;
    }
    deepCleanRuntimeState.deepCleanPhase = 'stopped';
}

function startDeepCleanLookahead(lifecycle, onProgress) {
    if (lifecycle.stopRequested
        || !lifecycle.currentReviewSession
        || lifecycle.lookahead
        || lifecycle.nextAffectedItemCursor >= lifecycle.run.scanResult.affectedItemIndexes.length) {
        return null;
    }
    const lookahead = {
        progress: { stage: 'waiting' },
        batch: null,
        processedRun: null,
        promise: null,
    };
    lifecycle.lookahead = lookahead;
    const updateProgress = (progress) => {
        if (lifecycle.lookahead !== lookahead || lifecycle.stopRequested) return;
        lookahead.progress = progress;
        onProgress?.(progress);
    };
    lookahead.promise = processNextDeepCleanBatch(lifecycle, updateProgress)
        .then((processed) => {
            if (lifecycle.lookahead !== lookahead || lifecycle.stopRequested || !processed) {
                if (lifecycle.lookahead === lookahead) lifecycle.lookahead = null;
                return null;
            }
            lookahead.batch = processed.batch;
            lookahead.processedRun = processed.processedRun;
            lookahead.progress = {
                stage: 'prepared',
                itemIndexes: processed.batch.itemIndexes,
                itemCount: processed.batch.itemIndexes.length,
                sourceCharacterCount: processed.batch.sourceCharacterCount,
                reviewItemCount: processed.reviewItemIndexes.length,
            };
            onProgress?.(lookahead.progress);
            return lookahead;
        })
        .catch((error) => {
            if (lifecycle.lookahead === lookahead && !lifecycle.stopRequested) {
                lookahead.error = error;
                lookahead.progress = {
                    ...lookahead.progress,
                    stage: 'failed',
                    error: error instanceof Error ? error.message : String(error),
                };
                onProgress?.(lookahead.progress);
            }
            return null;
        });
    return lookahead.promise;
}

export async function runDeepCleanProgramProcessing(options = {}) {
    if (deepCleanRuntimeState.deepCleanPhase !== 'scan-result') return null;
    const lifecycle = deepCleanRuntimeState.deepCleanSelection;
    deepCleanRuntimeState.deepCleanPhase = 'batch-processing';
    try {
        if (lifecycle.run.input.processingMode === 'program'
            && lifecycle.run.input.programApplyPolicy === 'direct') {
            while (!lifecycle.stopRequested) {
                const processed = await processNextDeepCleanBatch(lifecycle, options.onProgress);
                if (lifecycle.stopRequested) break;
                if (!processed) {
                    return { complete: true, summary: completeDeepCleanRun(lifecycle) };
                }
                reportBatchProgress(options.onProgress, processed.batch, 'direct-applying', {
                    completedBatchCount: lifecycle.applyResults.length,
                });
                let result;
                try {
                    result = await persistDeepCleanProposedBatch(
                        processed.processedRun,
                        processed.batch.itemIndexes,
                        {
                            shouldStop: () => lifecycle.stopRequested,
                            onProgress: ({ completed, total, ...progress }) => {
                                if (lifecycle.stopRequested) return;
                                reportBatchProgress(options.onProgress, processed.batch, 'direct-applying', {
                                    ...progress,
                                    current: completed,
                                    total,
                                    completedBatchCount: lifecycle.applyResults.length,
                                });
                            },
                        },
                    );
                } catch (error) {
                    if (lifecycle.stopRequested) return null;
                    if (deepCleanRuntimeState.deepCleanSelection !== lifecycle) throw error;
                    finalizeDeepCleanFailure(lifecycle, 'direct-apply', 'direct_apply_failed');
                    throw error;
                }
                lifecycle.applyResults.push(result);
                const applied = result.unitResults.filter((unit) => unit.status === 'applied').length;
                const failed = result.unitResults.length - applied;
                logger.info(`[Deep Clean] direct apply complete applied=${applied} failed=${failed}`);
                if (lifecycle.stopRequested) break;
                reportBatchProgress(options.onProgress, processed.batch, 'batch-applied', {
                    completedBatchCount: lifecycle.applyResults.length,
                });
            }
            markDeepCleanStopped(lifecycle);
            return null;
        }
        const processed = await processNextDeepCleanBatch(lifecycle, options.onProgress);
        if (lifecycle.stopRequested) {
            markDeepCleanStopped(lifecycle);
            return null;
        }
        if (!processed) {
            return { complete: true, summary: completeDeepCleanRun(lifecycle) };
        }
        const session = createDeepCleanReviewSession(processed.processedRun, processed.batch.itemIndexes);
        lifecycle.currentReviewSession = session;
        deepCleanRuntimeState.deepCleanPhase = 'review';
        logger.info(`[Deep Clean] Review Batch sourceChars=${processed.batch.sourceCharacterCount} reviewItems=${session.reviewItemIndexes.length}`);
        startDeepCleanLookahead(lifecycle, options.onLookaheadProgress);
        return session;
    } catch (error) {
        if (lifecycle?.stopRequested) return null;
        if (deepCleanRuntimeState.deepCleanSelection === lifecycle) {
            finalizeDeepCleanFailure(lifecycle, 'processing', 'processing_failed');
        }
        throw error;
    }
}

export function getDeepCleanReviewSession() {
    return deepCleanRuntimeState.deepCleanPhase === 'review'
        ? deepCleanRuntimeState.deepCleanSelection?.currentReviewSession || null
        : null;
}

export function getDeepCleanLookaheadProgress() {
    return deepCleanRuntimeState.deepCleanSelection?.lookahead?.progress || null;
}

function deriveDeepCleanCompletionSummary(lifecycle) {
    const run = lifecycle?.run;
    if (!run?.input || !run.scanResult || !Array.isArray(lifecycle.processedRuns)) {
        throw new Error('Deep Clean completion summary state is unavailable');
    }

    const appliedItemIndexes = new Set();
    const failedItemIndexes = new Set();
    for (const applyResult of lifecycle.applyResults) {
        for (const unitResult of applyResult.unitResults) {
            if (unitResult.status === 'applied') {
                unitResult.itemIndexes.forEach((itemIndex) => appliedItemIndexes.add(itemIndex));
            }
            if (unitResult.status === 'failed') {
                unitResult.itemIndexes.forEach((itemIndex) => failedItemIndexes.add(itemIndex));
            }
        }
    }

    let aiFailedItemIndexes = null;
    let oversizedItemIndexes = null;
    let totalAiRequestCount = null;
    let failedAiRequestCount = null;
    if (run.input.processingMode === 'program-ai') {
        aiFailedItemIndexes = new Set();
        oversizedItemIndexes = new Set();
        totalAiRequestCount = 0;
        failedAiRequestCount = 0;
        for (const processedRun of lifecycle.processedRuns) {
            totalAiRequestCount += processedRun.aiRequestPlan.requests.length;
            failedAiRequestCount += processedRun.aiFailedRequestIndexes.length;
            processedRun.aiFailedItemIndexes.forEach((itemIndex) => aiFailedItemIndexes.add(itemIndex));
            processedRun.aiRequestPlan.oversizedItemIndexes.forEach((itemIndex) => oversizedItemIndexes.add(itemIndex));
        }
        aiFailedItemIndexes.forEach((itemIndex) => failedItemIndexes.add(itemIndex));
    }

    const affectedItemIndexes = new Set(run.scanResult.affectedItemIndexes);
    const retainedOriginalItemCount = [...affectedItemIndexes].filter((itemIndex) => (
        !appliedItemIndexes.has(itemIndex) && !failedItemIndexes.has(itemIndex)
    )).length;
    const summary = {
        characterResourceCount: run.input.characterKeys.length,
        chatBranchResourceCount: run.input.chats.length,
        scannedItemCount: run.scanResult.scannedItemCount,
        affectedItemCount: run.scanResult.affectedItemCount,
        appliedItemCount: appliedItemIndexes.size,
        retainedOriginalItemCount,
        failedItemCount: failedItemIndexes.size,
        unprocessedItemCount: 0,
    };

    if (run.input.processingMode === 'program-ai') {
        Object.assign(summary, {
            totalAiRequestCount,
            successfulAiRequestCount: totalAiRequestCount - failedAiRequestCount,
            failedAiRequestCount,
            aiFailedOriginalItemCount: aiFailedItemIndexes.size,
            oversizedAiItemCount: oversizedItemIndexes.size,
        });
    }

    return summary;
}

function finalizeDeepCleanFailure(lifecycle, terminalStage, failureCode, values = {}) {
    if (!Number.isFinite(lifecycle?.diagnosticStartedAt)) return null;
    const startedAt = lifecycle.diagnosticStartedAt;
    lifecycle.diagnosticStartedAt = null;
    try {
        const input = values.input || lifecycle.run?.input || null;
        const scanResult = values.scanResult || lifecycle.run?.scanResult || null;
        const summary = values.summary || (lifecycle.run?.scanResult ? deriveDeepCleanCompletionSummary(lifecycle) : null);
        const record = createDeepCleanSafeDiagnostic({
            startedAt,
            outcome: 'failure',
            terminalStage,
            failureCode,
            input,
            scanResult,
            summary,
        });
        recordDeepCleanFailure(record);
        return record;
    } finally {
        if (deepCleanRuntimeState.deepCleanSelection === lifecycle) {
            deepCleanRuntimeState.deepCleanSelection = null;
        }
        deepCleanRuntimeState.deepCleanPhase = 'error';
    }
}

function completeDeepCleanRun(lifecycle) {
    const summary = deriveDeepCleanCompletionSummary(lifecycle);
    if (Number.isFinite(lifecycle.diagnosticStartedAt)) {
        const failedAiRequestCount = Number(summary.failedAiRequestCount || 0);
        const successful = summary.failedItemCount === 0 && failedAiRequestCount === 0;
        const record = createDeepCleanSafeDiagnostic({
            startedAt: lifecycle.diagnosticStartedAt,
            outcome: successful ? 'success' : 'failure',
            terminalStage: 'complete',
            failureCode: successful ? undefined : 'completed_with_failures',
            input: lifecycle.run.input,
            scanResult: lifecycle.run.scanResult,
            summary,
        });
        lifecycle.diagnosticStartedAt = null;
        try {
            if (successful) recordDeepCleanSuccess(record);
            else recordDeepCleanFailure(record);
        } finally {
            if (deepCleanRuntimeState.deepCleanSelection === lifecycle) {
                deepCleanRuntimeState.deepCleanSelection = null;
            }
            deepCleanRuntimeState.deepCleanPhase = 'complete';
        }
    } else {
        if (deepCleanRuntimeState.deepCleanSelection === lifecycle) {
            deepCleanRuntimeState.deepCleanSelection = null;
        }
        deepCleanRuntimeState.deepCleanPhase = 'complete';
    }
    return summary;
}

export function requestDeepCleanStop() {
    const lifecycle = deepCleanRuntimeState.deepCleanSelection;
    if (!lifecycle || deepCleanRuntimeState.deepCleanPhase === 'stopped' || deepCleanRuntimeState.deepCleanPhase === 'complete') {
        return deepCleanRuntimeState.deepCleanPhase;
    }
    lifecycle.stopRequested = true;
    markDeepCleanStopped(lifecycle);
    logger.info(`[Deep Clean] Stop requested phase=${deepCleanRuntimeState.deepCleanPhase}`);
    return deepCleanRuntimeState.deepCleanPhase;
}

export async function runDeepCleanApply(options = {}) {
    if (deepCleanRuntimeState.deepCleanPhase !== 'review') return null;
    const lifecycle = deepCleanRuntimeState.deepCleanSelection;
    const reviewSession = getDeepCleanReviewSession();
    if (!reviewSession) return null;
    deepCleanRuntimeState.deepCleanPhase = 'apply';
    const lookaheadPromise = lifecycle.lookahead?.promise;
    try {
        const result = await persistDeepCleanReview(reviewSession, {
            shouldStop: () => lifecycle.stopRequested,
            onProgress: options.onProgress,
        });
        lifecycle.applyResults.push(result);
        lifecycle.currentReviewSession = null;
        const applied = result.unitResults.filter((unit) => unit.status === 'applied').length;
        const failed = result.unitResults.length - applied;
        logger.info(`[Deep Clean] apply complete applied=${applied} failed=${failed}`);
        if (lifecycle.stopRequested) {
            if (lookaheadPromise) await lookaheadPromise;
            markDeepCleanStopped(lifecycle);
            return { ...result, stopped: true, nextSession: null };
        }

        const lookahead = lifecycle.lookahead;
        if (lookahead?.promise) await lookahead.promise;
        if (lifecycle.stopRequested) {
            markDeepCleanStopped(lifecycle);
            return { ...result, stopped: true, nextSession: null };
        }
        if (lifecycle.lookahead?.error) {
            const error = lifecycle.lookahead.error;
            finalizeDeepCleanFailure(lifecycle, 'lookahead-processing', 'lookahead_processing_failed');
            throw error;
        }
        if (lifecycle.lookahead?.processedRun) {
            const prepared = lifecycle.lookahead;
            const nextSession = createDeepCleanReviewSession(prepared.processedRun, prepared.batch.itemIndexes);
            lifecycle.lookahead = null;
            lifecycle.currentReviewSession = nextSession;
            deepCleanRuntimeState.deepCleanPhase = 'review';
            startDeepCleanLookahead(lifecycle, options.onLookaheadProgress);
            return { ...result, nextSession, complete: false };
        }
        return { ...result, nextSession: null, complete: true, summary: completeDeepCleanRun(lifecycle) };
    } catch (error) {
        if (lifecycle.stopRequested) return { stopped: true, nextSession: null };
        if (deepCleanRuntimeState.deepCleanSelection === lifecycle) {
            finalizeDeepCleanFailure(lifecycle, 'review-apply', 'review_apply_failed');
        }
        throw error;
    }
}

export function getDeepCleanFrozenRun() {
    return deepCleanRuntimeState.deepCleanSelection?.run || null;
}
