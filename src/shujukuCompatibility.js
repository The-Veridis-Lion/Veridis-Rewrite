import { isAssistantMessage } from './diff.js';
import { logger } from './log.js';
import { applyScopedReplacements } from './replacementEngine.js';
import { extensionName, getAppContext } from './state.js';
import { recordAiRewriteDebug } from './aiRewrite/debug.js';

let pendingShujukuRewrite = null;
let activeShujukuRewritePromise = null;

function readCurrentV2Frame(message) {
    let isolatedData = message?.TavernDB_ACU_IsolatedData;
    if (typeof isolatedData === 'string') {
        try {
            isolatedData = JSON.parse(isolatedData);
        } catch {
            return null;
        }
    }
    if (!isolatedData || typeof isolatedData !== 'object' || Array.isArray(isolatedData)) return null;

    const isolationKey = typeof message?.TavernDB_ACU_Identity === 'string'
        ? message.TavernDB_ACU_Identity
        : '';
    const frame = isolatedData[isolationKey]?.storageFrame;
    return frame?.version === 2 && Array.isArray(frame.logEntries) ? frame : null;
}

function deleteOwnedRowsForSheet(rows, sheetKey) {
    const prefix = `${sheetKey}\u0000`;
    for (const key of rows.keys()) {
        if (key.startsWith(prefix)) rows.delete(key);
    }
}

function readSheetReplaceOwnedRows(operation) {
    if (typeof operation?.sheetKey !== 'string'
        || !operation.sheet
        || typeof operation.sheet !== 'object'
        || Array.isArray(operation.sheet)
        || !Array.isArray(operation.sheet.content)
        || !Array.isArray(operation.sheet.content[0])) return null;

    const headers = operation.sheet.content[0];
    if (headers[0] !== 'row_id') return null;

    const ownedRows = [];
    for (let index = 1; index < operation.sheet.content.length; index++) {
        const cells = operation.sheet.content[index];
        if (!Array.isArray(cells)
            || cells.length !== headers.length
            || typeof cells[0] !== 'string'
            || !cells[0]
            || ownedRows.some(row => row.rowId === cells[0])) return null;
        ownedRows.push({
            sheetKey: operation.sheetKey,
            rowId: cells[0],
            cells,
            headers,
        });
    }
    return ownedRows;
}

function reduceFinalOwnedRowsFromEntries(entries, messageIndex, rows, includeSheetReplace) {
    for (const entry of entries) {
        if (!entry || entry.targetMessageIndex !== messageIndex || !Array.isArray(entry.operations)) {
            rows.clear();
            continue;
        }

        for (const operation of entry.operations) {
            if (operation?.kind === 'row_upsert'
                && typeof operation.sheetKey === 'string'
                && typeof operation.rowId === 'string'
                && Array.isArray(operation.cells)
                && operation.cells[0] === operation.rowId) {
                rows.set(`${operation.sheetKey}\u0000${operation.rowId}`, operation);
                continue;
            }

            if (includeSheetReplace && operation?.kind === 'sheet_replace') {
                const replacementRows = readSheetReplaceOwnedRows(operation);
                if (!replacementRows) {
                    rows.clear();
                    continue;
                }
                deleteOwnedRowsForSheet(rows, operation.sheetKey);
                if (Array.isArray(entry.changedSheetKeys)
                    && entry.changedSheetKeys.includes(operation.sheetKey)) {
                    for (const row of replacementRows) {
                        rows.set(`${row.sheetKey}\u0000${row.rowId}`, row);
                    }
                }
                continue;
            }

            if (operation?.kind === 'row_delete'
                && typeof operation.sheetKey === 'string'
                && typeof operation.rowId === 'string') {
                rows.delete(`${operation.sheetKey}\u0000${operation.rowId}`);
                continue;
            }

            rows.clear();
        }
    }

    return rows;
}

function collectFinalRowUpsertsFromEntries(entries, messageIndex) {
    const rows = reduceFinalOwnedRowsFromEntries(entries, messageIndex, new Map(), false);

    return [...rows.values()];
}

function collectFinalRowUpserts(frame, messageIndex) {
    return collectFinalRowUpsertsFromEntries(frame.logEntries, messageIndex);
}

function findUniqueRowIndex(content, rowId) {
    let match = -1;
    for (let index = 1; index < content.length; index++) {
        if (!Array.isArray(content[index]) || content[index][0] !== rowId) continue;
        if (match >= 0) return -1;
        match = index;
    }
    return match;
}

function hasUniqueTableName(tableData, tableName) {
    let matches = 0;
    for (const [sheetKey, sheet] of Object.entries(tableData)) {
        if (sheetKey === 'mate' || !sheet || typeof sheet !== 'object') continue;
        if (sheet.name === tableName) matches++;
    }
    return matches === 1;
}

function collectShujukuCellTargetsFromOperations(operations, tableData) {
    if (!tableData || typeof tableData !== 'object' || Array.isArray(tableData)) return [];

    const targets = [];
    for (const operation of operations) {
        const sheet = tableData[operation.sheetKey];
        if (!sheet || typeof sheet !== 'object' || typeof sheet.name !== 'string' || !sheet.name) continue;
        if (!Array.isArray(sheet.content) || !Array.isArray(sheet.content[0])) continue;
        if (!hasUniqueTableName(tableData, sheet.name)) continue;

        const rowIndex = findUniqueRowIndex(sheet.content, operation.rowId);
        if (rowIndex < 1) continue;
        const row = sheet.content[rowIndex];
        const headers = sheet.content[0];
        if (row.length !== headers.length || operation.cells.length !== row.length) continue;
        if (operation.headers !== undefined
            && (!Array.isArray(operation.headers)
                || operation.headers.length !== headers.length)) continue;

        const hiddenColumns = Array.isArray(sheet.sourceData?.hiddenPhysicalColumns)
            ? sheet.sourceData.hiddenPhysicalColumns
            : [];
        for (let columnIndex = 1; columnIndex < row.length; columnIndex++) {
            const header = headers[columnIndex];
            const currentValue = row[columnIndex];
            if (typeof header !== 'string' || !header || hiddenColumns.includes(header)) continue;
            if (operation.headers !== undefined && operation.headers[columnIndex] !== header) continue;
            if (typeof currentValue !== 'string' || operation.cells[columnIndex] !== currentValue) continue;
            targets.push({
                tableName: sheet.name,
                rowIndex,
                columnIndex,
                value: currentValue,
            });
        }
    }
    return targets;
}

export function collectShujukuCellTargets(message, messageIndex, tableData) {
    const frame = readCurrentV2Frame(message);
    if (!frame) return [];
    return collectShujukuCellTargetsFromOperations(collectFinalRowUpserts(frame, messageIndex), tableData);
}

function readFrameHeadRevision(frame) {
    return typeof frame?.headRevision === 'string' && frame.headRevision ? frame.headRevision : null;
}

function captureShujukuFrameBoundaries(chat) {
    const boundaries = [];
    for (let messageIndex = 0; messageIndex < chat.length; messageIndex++) {
        const messageRef = chat[messageIndex];
        if (!isAssistantMessage(messageRef)) continue;
        const frame = readCurrentV2Frame(messageRef);
        boundaries.push({
            messageRef,
            messageIndex,
            headRevision: readFrameHeadRevision(frame),
            entryIds: frame
                ? frame.logEntries
                    .map(entry => typeof entry?.entryId === 'string' && entry.entryId ? entry.entryId : null)
                    .filter(Boolean)
                : [],
        });
    }
    return boundaries;
}

function collectPostArmShujukuCellTargets(pending, chat, tableData) {
    const rows = new Map();
    const diagnostics = {
        persistenceTargetCount: 0,
        newEntryCount: 0,
        operationKindCounts: {},
        rowUpsertCount: 0,
        candidateCellCount: 0,
    };

    for (const boundary of pending.frameBoundaries) {
        const message = chat[boundary.messageIndex];
        if (message !== boundary.messageRef || !isAssistantMessage(message)) continue;

        const frame = readCurrentV2Frame(message);
        if (!frame || readFrameHeadRevision(frame) === boundary.headRevision) continue;
        diagnostics.persistenceTargetCount++;

        const newEntries = frame.logEntries.filter(entry => (
            typeof entry?.entryId === 'string'
            && entry.entryId
            && typeof entry.commitRevision === 'string'
            && entry.commitRevision
            && !boundary.entryIds.includes(entry.entryId)
        ));
        diagnostics.newEntryCount += newEntries.length;
        for (const entry of newEntries) {
            if (!Array.isArray(entry?.operations)) continue;
            for (const operation of entry.operations) {
                if (typeof operation?.kind !== 'string') continue;
                diagnostics.operationKindCounts[operation.kind]
                    = (diagnostics.operationKindCounts[operation.kind] || 0) + 1;
                if (operation.kind === 'row_upsert') diagnostics.rowUpsertCount++;
            }
        }
        reduceFinalOwnedRowsFromEntries(newEntries, boundary.messageIndex, rows, true);
    }

    const operations = [...rows.values()];
    // Structural cells after final-operation reduction, before exported table/row/column/value validation.
    for (const operation of operations) {
        diagnostics.candidateCellCount += Math.max(0, operation.cells.length - 1);
    }
    const targets = collectShujukuCellTargetsFromOperations(operations, tableData);

    return { targets, diagnostics };
}

function findLatestAssistantMessageIndex(chat) {
    for (let index = chat.length - 1; index >= 0; index--) {
        if (isAssistantMessage(chat[index])) return index;
    }
    return -1;
}

function getCurrentLatestAssistantMessage(messageIndex, messageRef) {
    const { chat } = getAppContext();
    if (!Array.isArray(chat) || !Number.isInteger(messageIndex)) return null;
    const message = chat[messageIndex];
    if (message !== messageRef || !isAssistantMessage(message)) return null;
    return messageIndex === findLatestAssistantMessageIndex(chat) ? message : null;
}

function getShujukuApi() {
    const api = globalThis.window?.AutoCardUpdaterAPI;
    if (typeof api?.exportTableAsJson !== 'function' || typeof api?.updateCell !== 'function') return null;
    return api;
}

function isAutomaticShujukuRewriteEnabled() {
    return getAppContext().extension_settings?.[extensionName]?.shujukuAutoProgramRewriteEnabled === true;
}

async function rewriteEligibleShujukuCells(api, targets) {
    let changes = 0;
    for (const target of targets) {
        const rewritten = applyScopedReplacements(target.value);
        if (rewritten === target.value) continue;
        const saved = await api.updateCell({
            tableName: target.tableName,
            rowIndex: target.rowIndex,
            colIdentifier: target.columnIndex,
            value: rewritten,
            skipNotify: true,
        });
        if (saved !== true) throw new Error('shujuku updateCell 未能保存改写后的单元格');
        changes++;
    }
    return changes;
}

export function markLatestMessageShujukuRewritePending(messageIndex, source = 'message-cleanse') {
    if (!isAutomaticShujukuRewriteEnabled()) return false;
    const { chat } = getAppContext();
    if (!Array.isArray(chat) || !Number.isInteger(messageIndex)) return false;
    const messageRef = chat[messageIndex];
    if (!isAssistantMessage(messageRef)) return false;
    if (messageIndex !== findLatestAssistantMessageIndex(chat)) return false;

    registerShujukuTableUpdateCallback();
    pendingShujukuRewrite = {
        messageRef,
        messageIndex,
        frameBoundaries: captureShujukuFrameBoundaries(chat),
    };
    recordAiRewriteDebug('shujuku-pending-armed', { source, messageId: messageIndex });
    return true;
}

async function processPendingShujukuRewrite() {
    const pending = pendingShujukuRewrite;
    if (!pending) return;

    const message = getCurrentLatestAssistantMessage(pending.messageIndex, pending.messageRef);
    if (!message) {
        if (pendingShujukuRewrite === pending) pendingShujukuRewrite = null;
        return;
    }

    const api = getShujukuApi();
    if (!api) return;

    try {
        const { chat } = getAppContext();
        const { targets, diagnostics } = collectPostArmShujukuCellTargets(
            pending,
            chat,
            api.exportTableAsJson(),
        );
        if (targets.length === 0) {
            recordAiRewriteDebug('shujuku-program-check', {
                source: 'shujuku-auto',
                messageId: pending.messageIndex,
                ...diagnostics,
                targetCount: 0,
                changedCount: 0,
                result: 'no-targets',
            });
            return;
        }

        if (pendingShujukuRewrite === pending) pendingShujukuRewrite = null;
        const changedCount = await rewriteEligibleShujukuCells(api, targets);
        if (changedCount > 0) {
            recordAiRewriteDebug('shujuku-program-commit', {
                source: 'shujuku-auto',
                messageId: pending.messageIndex,
                targetCount: targets.length,
                changedCount,
            });
        } else {
            recordAiRewriteDebug('shujuku-program-check', {
                source: 'shujuku-auto',
                messageId: pending.messageIndex,
                ...diagnostics,
                targetCount: targets.length,
                changedCount: 0,
                result: 'no-changes',
            });
        }
    } catch (error) {
        if (pendingShujukuRewrite === pending) pendingShujukuRewrite = null;
        throw error;
    }
}

function onShujukuTableUpdate() {
    if (!isAutomaticShujukuRewriteEnabled()) return;
    const callbackDetails = {
        hasPending: Boolean(pendingShujukuRewrite),
        active: Boolean(activeShujukuRewritePromise),
    };
    if (pendingShujukuRewrite) callbackDetails.messageId = pendingShujukuRewrite.messageIndex;
    recordAiRewriteDebug('shujuku-callback-received', callbackDetails);
    if (!pendingShujukuRewrite || activeShujukuRewritePromise) return;

    activeShujukuRewritePromise = processPendingShujukuRewrite()
        .catch((error) => {
            logger.warn(`shujuku Program Rewrite 跳过: ${error?.message || error}`);
        })
        .finally(() => {
            activeShujukuRewritePromise = null;
        });
}

export function registerShujukuTableUpdateCallback() {
    if (!isAutomaticShujukuRewriteEnabled()) return;
    const api = globalThis.window?.AutoCardUpdaterAPI;
    if (typeof api?.registerTableUpdateCallback === 'function') {
        api.registerTableUpdateCallback(onShujukuTableUpdate);
    }
}

export function clearPendingShujukuRewrite() {
    pendingShujukuRewrite = null;
}

export async function rewriteLatestMessageShujukuCells(messageIndex) {
    const { chat } = getAppContext();
    if (!Array.isArray(chat) || !Number.isInteger(messageIndex)) return 0;
    const message = chat[messageIndex];
    if (!getCurrentLatestAssistantMessage(messageIndex, message)) return 0;

    const api = getShujukuApi();
    if (!api) return 0;

    try {
        const targets = collectShujukuCellTargets(message, messageIndex, api.exportTableAsJson());
        if (targets.length === 0) {
            recordAiRewriteDebug('shujuku-program-check', {
                source: 'shujuku-direct',
                messageId: messageIndex,
                targetCount: 0,
                changedCount: 0,
                result: 'no-targets',
            });
            return 0;
        }
        const changedCount = await rewriteEligibleShujukuCells(api, targets);
        if (changedCount > 0) {
            recordAiRewriteDebug('shujuku-program-commit', {
                source: 'shujuku-direct',
                messageId: messageIndex,
                targetCount: targets.length,
                changedCount,
            });
        } else {
            recordAiRewriteDebug('shujuku-program-check', {
                source: 'shujuku-direct',
                messageId: messageIndex,
                targetCount: targets.length,
                changedCount: 0,
                result: 'no-changes',
            });
        }
        return changedCount;
    } catch (error) {
        logger.warn(`shujuku Program Rewrite 跳过: ${error?.message || error}`);
        return 0;
    }
}
