// Owns conversion of reviewed/proposed Deep Clean changes into ordered resource persistence units and sequential execution/progress/result aggregation. It does not implement resource-specific writes.

import { getSillyTavernContextSnapshot } from '../../host/context.js';
import { resolveDeepCleanFinalProposedText } from '../aiProcessing.js';
import { resolveDeepCleanReviewedText } from '../review.js';
import { applyCharacterUnit } from './character.js';
import { applyBranchUnit, currentOpenCharacterBranch } from './chat.js';
import { applyPersonaUnit } from './persona.js';
import { applyWorldBookUnit } from './worldBook.js';

function collectReviewedChanges(reviewSession) {
    const changes = [];
    for (const itemIndex of reviewSession.reviewItemIndexes) {
        const item = reviewSession.processedRun?.contentItems?.[itemIndex];
        const reviewedText = resolveDeepCleanReviewedText(reviewSession, itemIndex);
        if (!item || typeof item.originalText !== 'string' || reviewedText === null) {
            throw new Error(`Deep Clean Review Item cannot be resolved: ${itemIndex}`);
        }
        if (reviewedText === item.originalText) continue;
        changes.push({
            itemIndex,
            kind: item.kind,
            storageProtocol: item.storageProtocol,
            locator: item.locator || {},
            originalText: item.originalText,
            reviewedText,
        });
    }
    return changes;
}

function collectProposedChanges(processedRun, itemIndexes) {
    const changes = [];
    for (const itemIndex of itemIndexes) {
        const item = processedRun?.contentItems?.[itemIndex];
        if (!item || typeof item.originalText !== 'string') {
            throw new Error(`Deep Clean proposed Item cannot be resolved: ${itemIndex}`);
        }
        const reviewedText = resolveDeepCleanFinalProposedText(processedRun, itemIndex);
        if (reviewedText === item.originalText) continue;
        changes.push({
            itemIndex,
            kind: item.kind,
            storageProtocol: item.storageProtocol,
            locator: item.locator || {},
            originalText: item.originalText,
            reviewedText,
        });
    }
    return changes;
}

function groupReviewedChanges(changes) {
    const characters = new Map();
    const branches = new Map();
    const personas = [];
    const worldBooks = new Map();
    const add = (map, key, change) => {
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(change);
    };
    for (const change of changes) {
        if (change.kind.startsWith('character-') || change.kind === 'embedded-world-book-entry') {
            if (!change.locator.characterKey) throw new Error(`Deep Clean Character Item has no owner: ${change.itemIndex}`);
            add(characters, change.locator.characterKey, change);
        } else if (change.kind === 'user-message' || change.kind === 'assistant-swipe' || change.kind === 'shujuku-cell') {
            const { characterKey, chatId } = change.locator;
            if (!characterKey || !chatId) throw new Error(`Deep Clean Chat Item has no owner: ${change.itemIndex}`);
            add(branches, `${characterKey}\u0000${chatId}`, change);
        } else if (change.kind === 'persona-description') {
            if (!change.locator.personaKey) throw new Error(`Deep Clean Persona Item has no owner: ${change.itemIndex}`);
            personas.push(change);
        } else if (change.kind === 'external-world-book-entry') {
            if (!change.locator.worldBookKey || change.locator.entryKey === undefined) {
                throw new Error(`Deep Clean World Book Item has no owner: ${change.itemIndex}`);
            }
            add(worldBooks, change.locator.worldBookKey, change);
        } else {
            throw new Error(`Deep Clean Apply Item kind is unsupported: ${change.kind}`);
        }
    }
    return { characters, branches, personas, worldBooks };
}

function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}

async function persistDeepCleanChanges(changes, resultOwner, options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch?.bind(globalThis);
    if (typeof fetchImpl !== 'function') throw new Error('Deep Clean Apply fetch is unavailable');
    const context = options.context || getSillyTavernContextSnapshot();
    const grouped = groupReviewedChanges(changes);
    if (grouped.branches.size > 0) currentOpenCharacterBranch(getSillyTavernContextSnapshot());
    const units = [
        ...[...grouped.characters].map(([characterKey, changes]) => ({
            resourceType: 'character',
            resourceKey: characterKey,
            changes,
            run: () => applyCharacterUnit(fetchImpl, context, characterKey, changes),
        })),
        ...[...grouped.branches].map(([key, changes]) => {
            const [characterKey, chatId] = key.split('\u0000');
            return {
                resourceType: 'chat-branch',
                resourceKey: `${characterKey} :: ${chatId}`,
                changes,
                run: () => applyBranchUnit(fetchImpl, context, characterKey, chatId, changes),
            };
        }),
        ...(grouped.personas.length > 0 ? [{
            resourceType: 'persona-settings',
            resourceKey: 'global-settings',
            changes: grouped.personas,
            run: () => applyPersonaUnit(fetchImpl, context, grouped.personas),
        }] : []),
        ...[...grouped.worldBooks].map(([worldBookKey, changes]) => ({
            resourceType: 'world-book',
            resourceKey: worldBookKey,
            changes,
            run: () => applyWorldBookUnit(fetchImpl, context, worldBookKey, changes),
        })),
    ];
    const unitResults = [];
    if (!options.shouldStop?.()) options.onProgress?.({ completed: 0, total: units.length });
    for (const unit of units) {
        if (options.shouldStop?.()) break;
        const result = {
            resourceType: unit.resourceType,
            resourceKey: unit.resourceKey,
            itemIndexes: unit.changes.map((change) => change.itemIndex),
            status: 'applied',
        };
        try {
            await unit.run();
        } catch (error) {
            result.status = 'failed';
            result.error = errorText(error);
        }
        unitResults.push(result);
        if (!options.shouldStop?.()) {
            options.onProgress?.({
                completed: unitResults.length,
                total: units.length,
                resourceType: unit.resourceType,
                resourceKey: unit.resourceKey,
                status: result.status,
            });
        }
    }
    return { ...resultOwner, unitResults };
}

export async function persistDeepCleanReview(reviewSession, options = {}) {
    return persistDeepCleanChanges(
        collectReviewedChanges(reviewSession),
        { reviewSession },
        options,
    );
}

export async function persistDeepCleanProposedBatch(processedRun, itemIndexes, options = {}) {
    return persistDeepCleanChanges(
        collectProposedChanges(processedRun, itemIndexes),
        { itemIndexes },
        options,
    );
}
