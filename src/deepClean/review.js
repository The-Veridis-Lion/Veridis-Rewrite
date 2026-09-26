import { resolveDeepCleanFinalProposedText } from './aiProcessing.js';
import { compareTextPairsInBackground } from '../diff/background.js';

// Pending user edits are awaited before navigation or Apply; superseded work is terminated.
const pendingEdits = new WeakMap();

export async function waitForDeepCleanReviewEdits(session) {
    const jobs = pendingEdits.get(session);
    while (jobs?.size) await Promise.all([...jobs.values()].map(job => job.promise));
}

export function cancelDeepCleanReviewComparisons(session) {
    const jobs = pendingEdits.get(session);
    if (!jobs) return;
    for (const job of jobs.values()) job.controller.abort();
    jobs.clear();
}

function updateReviewBlock(session, itemIndex, blockIndex, block, property, editedText) {
    if (!block) return Promise.resolve(session);
    let jobs = pendingEdits.get(session);
    if (!jobs) { jobs = new Map(); pendingEdits.set(session, jobs); }
    const key = `${itemIndex}:${blockIndex}:${property}`;
    jobs.get(key)?.controller.abort();
    const controller = new AbortController();
    const job = { controller, promise: null };
    job.promise = updateDeepCleanReviewRuns(block[property], editedText, controller.signal)
        .then(runs => {
            if (controller.signal.aborted || jobs.get(key) !== job) return session;
            block[property] = runs;
            return session;
        }).catch(error => {
            if (!controller.signal.aborted) throw error;
            return session;
        }).finally(() => {
            if (jobs.get(key) === job) jobs.delete(key);
        });
    jobs.set(key, job);
    return job.promise;
}

function getContentItem(run, itemIndex) {
    const item = run?.contentItems?.[itemIndex];
    return item && typeof item.originalText === 'string' ? item : null;
}

function getReviewEntry(session, itemIndex) {
    return Array.isArray(session?.reviewItems)
        ? session.reviewItems.find((entry) => entry.itemIndex === itemIndex) || null
        : null;
}

export function getDeepCleanReviewItemIndexes(processedRun, itemIndexes = null) {
    const reviewItemIndexes = [];
    const contentItems = Array.isArray(processedRun?.contentItems) ? processedRun.contentItems : [];
    const candidateItemIndexes = Array.isArray(itemIndexes)
        ? itemIndexes
        : contentItems.map((_, itemIndex) => itemIndex);
    candidateItemIndexes.forEach((itemIndex) => {
        const item = contentItems[itemIndex];
        if (typeof item?.originalText !== 'string') return;
        if (!item.protectionReason && resolveDeepCleanFinalProposedText(processedRun, itemIndex) === item.originalText) return;
        reviewItemIndexes.push(itemIndex);
    });
    return reviewItemIndexes;
}

function createDeepCleanReviewRuns(text, source) {
    const value = String(text ?? '');
    return value ? [{ source, text: value }] : [];
}

export function resolveDeepCleanReviewRunsText(runs = []) {
    return Array.isArray(runs)
        ? runs.reduce((text, run) => text + String(run?.text ?? ''), '')
        : '';
}

function pushDeepCleanReviewRun(runs, source, text) {
    const value = String(text ?? '');
    if (!value) return;
    const previous = runs[runs.length - 1];
    if (previous?.source === source) previous.text += value;
    else runs.push({ source, text: value });
}

function appendDeepCleanReviewRunRange(target, runs, start, length) {
    const end = start + length;
    let cursor = 0;
    for (const run of runs) {
        const value = String(run.text ?? '');
        const runEnd = cursor + value.length;
        const rangeStart = Math.max(start, cursor);
        const rangeEnd = Math.min(end, runEnd);
        if (rangeStart < rangeEnd) {
            pushDeepCleanReviewRun(target, run.source, value.slice(rangeStart - cursor, rangeEnd - cursor));
        }
        cursor = runEnd;
        if (cursor >= end) break;
    }
}

async function updateDeepCleanReviewRuns(runs, editedText, signal) {
    const previousRuns = Array.isArray(runs) ? runs : [];
    const previousText = resolveDeepCleanReviewRunsText(previousRuns);
    const nextText = String(editedText ?? '');
    if (previousText === nextText) return previousRuns;

    const nextRuns = [];
    let previousOffset = 0;
    const [operations] = await compareTextPairsInBackground([{ oldText: previousText, newText: nextText }], { signal });
    for (const operation of operations) {
        const length = String(operation.text ?? '').length;
        if (operation.type === 'equal') {
            appendDeepCleanReviewRunRange(nextRuns, previousRuns, previousOffset, length);
            previousOffset += length;
        } else if (operation.type === 'delete') {
            previousOffset += length;
        } else if (operation.type === 'insert') {
            pushDeepCleanReviewRun(nextRuns, 'manual', operation.text);
        }
    }
    return nextRuns;
}

function buildDeepCleanReviewBlocks(operations) {
    const blocks = [];
    let oldText = '';
    let newText = '';
    const flushChange = () => {
        if (oldText === '' && newText === '') return;
        blocks.push({
            type: 'diff',
            oldRuns: createDeepCleanReviewRuns(oldText, 'baseline'),
            newRuns: createDeepCleanReviewRuns(newText, 'baseline'),
            active: 'new',
        });
        oldText = '';
        newText = '';
    };

    for (const operation of operations) {
        if (operation.type === 'equal') {
            flushChange();
            if (operation.text !== '') blocks.push({ type: 'equal', runs: createDeepCleanReviewRuns(operation.text, 'original') });
        } else if (operation.type === 'delete') {
            oldText += operation.text;
        } else if (operation.type === 'insert') {
            newText += operation.text;
        }
    }
    flushChange();
    return blocks;
}

function getReviewDiffBlock(session, itemIndex, blockIndex) {
    const entry = getReviewEntry(session, itemIndex);
    const block = Number.isInteger(blockIndex) ? entry?.blocks?.[blockIndex] : null;
    return block?.type === 'diff' ? block : null;
}

function getReviewEqualBlock(session, itemIndex, blockIndex) {
    const entry = getReviewEntry(session, itemIndex);
    const block = Number.isInteger(blockIndex) ? entry?.blocks?.[blockIndex] : null;
    return block?.type === 'equal' ? block : null;
}

export async function createDeepCleanReviewSession(processedRun, itemIndexes = null, { signal } = {}) {
    const reviewItemIndexes = getDeepCleanReviewItemIndexes(processedRun, itemIndexes);
    const comparisons = await compareTextPairsInBackground(reviewItemIndexes.map(itemIndex => ({
        oldText: getContentItem(processedRun, itemIndex).originalText,
        newText: resolveDeepCleanFinalProposedText(processedRun, itemIndex),
    })), { signal });
    return {
        processedRun,
        reviewItemIndexes,
        reviewItems: reviewItemIndexes.map((itemIndex, position) => {
            return {
                itemIndex,
                blocks: buildDeepCleanReviewBlocks(comparisons[position]),
            };
        }),
        currentItemIndex: reviewItemIndexes[0] ?? null,
        viewMode: 'review',
    };
}

export function getDeepCleanReviewEntry(session, itemIndex) {
    return getReviewEntry(session, itemIndex);
}

export function setDeepCleanReviewCurrentItem(session, itemIndex) {
    if (!session?.reviewItemIndexes?.includes(itemIndex)) return session;
    session.currentItemIndex = itemIndex;
    return session;
}

export function setDeepCleanReviewViewMode(session, viewMode) {
    if (!session || !['review', 'original', 'cleaned', 'final'].includes(viewMode)) return session;
    session.viewMode = viewMode;
    return session;
}

export function selectDeepCleanReviewBlock(session, itemIndex, blockIndex, active) {
    const block = getReviewDiffBlock(session, itemIndex, blockIndex);
    if (!block || (active !== 'old' && active !== 'new')) return session;
    block.active = active;
    return session;
}

export function setDeepCleanReviewBlockText(session, itemIndex, blockIndex, editedText) {
    const block = getReviewDiffBlock(session, itemIndex, blockIndex);
    if (!block) return Promise.resolve(session);
    const property = block.active === 'old' ? 'oldRuns' : 'newRuns';
    return updateReviewBlock(session, itemIndex, blockIndex, block, property, editedText);
}

export function setDeepCleanReviewEqualText(session, itemIndex, blockIndex, editedText) {
    const block = getReviewEqualBlock(session, itemIndex, blockIndex);
    return updateReviewBlock(session, itemIndex, blockIndex, block, 'runs', editedText);
}

export function resolveDeepCleanReviewedText(session, itemIndex) {
    const entry = getReviewEntry(session, itemIndex);
    if (!entry) return null;
    return entry.blocks.reduce((text, block) => {
        if (block.type === 'equal') return text + resolveDeepCleanReviewRunsText(block.runs);
        return text + resolveDeepCleanReviewRunsText(block.active === 'old' ? block.oldRuns : block.newRuns);
    }, '');
}
