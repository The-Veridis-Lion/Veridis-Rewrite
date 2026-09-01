/** Owns realtime Shujuku integration, not historical Deep Clean replay. */
import { isAssistantMessage } from '../diff/tracking.js';
import { logger } from '../log.js';
import { applyScopedReplacements } from '../rules/engine.js';
import { extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { recordAiRewriteDebug } from '../aiRewrite/debug.js';
import { getCurrentChatIdentity } from '../host/context.js';
import {
    hasShujukuTopLevelLegacyTableEvidence,
    hasShujukuV1TableEvidence,
    hasShujukuV2TableEvidence,
    isSupportedLateShujukuV1Slot,
    parseShujukuIsolatedData,
    shujukuLegacyMessageMatchesIsolation,
} from './storageEvidence.js';

let pendingShujukuRewrite = null;
let activeShujukuRewritePromise = null;

function readMessageIsolationKey(message) {
    return typeof message?.TavernDB_ACU_Identity === 'string'
        ? message.TavernDB_ACU_Identity
        : '';
}

function readCurrentV2Frame(message) {
    return readV2FrameFromIsolation(message, readMessageIsolationKey(message));
}

function readV2FrameFromIsolation(message, isolationKey) {
    const isolatedData = readIsolatedData(message);
    if (!isolatedData) return null;
    const frame = isolatedData[isolationKey]?.storageFrame;
    return frame?.version === 2 && Array.isArray(frame.logEntries) ? frame : null;
}

const SHUJUKU_SETTINGS_NAMESPACE = 'shujuku_v120__userscript_settings_v1';
const SHUJUKU_GLOBAL_META_KEY = 'shujuku_v120_globalMeta_v1';

function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readIsolatedData(message) {
    return parseShujukuIsolatedData(message?.TavernDB_ACU_IsolatedData);
}

function readPinnedShujukuActiveIsolationKey() {
    const userscripts = getAppContext().extension_settings?.__userscripts;
    const namespace = userscripts?.[SHUJUKU_SETTINGS_NAMESPACE];
    if (!isRecord(namespace)) return null;

    const raw = namespace[SHUJUKU_GLOBAL_META_KEY];
    if (typeof raw !== 'string' || !raw) return '';
    try {
        const parsed = JSON.parse(raw);
        return isRecord(parsed) && typeof parsed.activeIsolationCode === 'string'
            ? parsed.activeIsolationCode.trim()
            : '';
    } catch {
        return '';
    }
}

function hasMatchingTopLevelLegacy(chat, isolationKey) {
    return chat.some((message) => (
        isAssistantMessage(message)
        && shujukuLegacyMessageMatchesIsolation(message, isolationKey)
        && hasShujukuTopLevelLegacyTableEvidence(message)
    ));
}

function isSupportedLateV1Isolation(chat, isolationKey) {
    if (hasMatchingTopLevelLegacy(chat, isolationKey)) return false;
    let hasV1Evidence = false;
    for (let messageIndex = 0; messageIndex < chat.length; messageIndex++) {
        const message = chat[messageIndex];
        if (!isAssistantMessage(message)) continue;
        const rawIsolatedData = message?.TavernDB_ACU_IsolatedData;
        if (rawIsolatedData === undefined || rawIsolatedData === null || rawIsolatedData === '') continue;
        const isolatedData = readIsolatedData(message);
        if (!isolatedData) return false;
        const slot = isolatedData?.[isolationKey];
        if (slot === undefined) continue;
        if (!isRecord(slot)) return false;
        if (hasShujukuV2TableEvidence(slot)) return false;
        if (!hasShujukuV1TableEvidence(slot)) continue;
        if (!isSupportedLateShujukuV1Slot(slot)) return false;
        hasV1Evidence = true;
    }
    return hasV1Evidence;
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
                canonicalHeader: header,
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

function captureShujukuFrameBoundaries(chat, targetIsolationKey, lateV1MigrationExpected) {
    const boundaries = [];
    for (let messageIndex = 0; messageIndex < chat.length; messageIndex++) {
        const message = chat[messageIndex];
        if (!isAssistantMessage(message)) continue;
        const frame = lateV1MigrationExpected
            ? readV2FrameFromIsolation(message, targetIsolationKey)
            : readCurrentV2Frame(message);
        boundaries.push({
            messageRef: message,
            messageIndex,
            allowMigrationMessageReplacement: lateV1MigrationExpected,
            hadV2Frame: Boolean(frame),
            headRevision: readFrameHeadRevision(frame),
            logEntryCount: frame?.logEntries.length || 0,
        });
    }
    return boundaries;
}

function readPostArmShujukuEntries(boundary, frame) {
    const currentHeadRevision = readFrameHeadRevision(frame);
    if (boundary.hadV2Frame && currentHeadRevision === boundary.headRevision) return [];

    const entries = frame.logEntries;
    const startIndex = boundary.hadV2Frame ? boundary.logEntryCount : 0;
    if (entries.length < startIndex) {
        throw new Error(`Shujuku Program Rewrite 无法建立精确 revision 边界：message ${boundary.messageIndex} 的 V2 日志被截断`);
    }

    if (boundary.hadV2Frame && boundary.logEntryCount > 0) {
        const armedHeadEntry = entries[boundary.logEntryCount - 1];
        if (armedHeadEntry?.commitRevision !== boundary.headRevision) {
            throw new Error(`Shujuku Program Rewrite 无法建立精确 revision 边界：message ${boundary.messageIndex} 的 arm-time head 已变化`);
        }
    } else if (boundary.hadV2Frame && boundary.headRevision === null && boundary.logEntryCount !== 0) {
        throw new Error(`Shujuku Program Rewrite 无法建立精确 revision 边界：message ${boundary.messageIndex} 缺少 arm-time head`);
    }

    const postArmEntries = entries.slice(startIndex);
    if (postArmEntries.length === 0) return [];

    let expectedParentRevision = boundary.hadV2Frame
        ? boundary.headRevision
        : postArmEntries[0]?.parentRevision;
    if (expectedParentRevision !== null && typeof expectedParentRevision !== 'string') {
        throw new Error(`Shujuku Program Rewrite 无法建立精确 revision 边界：message ${boundary.messageIndex} 的新增日志 parentRevision 无效`);
    }

    for (const entry of postArmEntries) {
        if (entry?.parentRevision !== expectedParentRevision
            || typeof entry.commitRevision !== 'string'
            || !entry.commitRevision) {
            throw new Error(`Shujuku Program Rewrite 无法建立精确 revision 边界：message ${boundary.messageIndex} 的新增日志不连续`);
        }
        expectedParentRevision = entry.commitRevision;
    }
    if (expectedParentRevision !== currentHeadRevision) {
        throw new Error(`Shujuku Program Rewrite 无法建立精确 revision 边界：message ${boundary.messageIndex} 的 frame head 不匹配新增日志`);
    }
    return postArmEntries;
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
        if (!isAssistantMessage(message)
            || (message !== boundary.messageRef && !boundary.allowMigrationMessageReplacement)) continue;

        const frame = boundary.allowMigrationMessageReplacement
            ? readV2FrameFromIsolation(message, pending.targetIsolationKey)
            : readCurrentV2Frame(message);
        if (!frame || (boundary.hadV2Frame && readFrameHeadRevision(frame) === boundary.headRevision)) continue;
        diagnostics.persistenceTargetCount++;

        const newEntries = readPostArmShujukuEntries(boundary, frame);
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

    return { targets, diagnostics, hasPostArmEntries: diagnostics.newEntryCount > 0 };
}

function findLatestAssistantMessageIndex(chat) {
    for (let index = chat.length - 1; index >= 0; index--) {
        if (isAssistantMessage(chat[index])) return index;
    }
    return -1;
}

function getCurrentLatestAssistantMessage(messageIndex, messageRef, chatIdentity, allowMigrationMessageReplacement = false) {
    const { chat } = getAppContext();
    if (!Array.isArray(chat)
        || !Number.isInteger(messageIndex)
        || (chatIdentity !== undefined && getCurrentChatIdentity() !== chatIdentity)) return null;
    const message = chat[messageIndex];
    if (!isAssistantMessage(message)
        || (message !== messageRef && !allowMigrationMessageReplacement)) return null;
    return messageIndex === findLatestAssistantMessageIndex(chat) ? message : null;
}

function getShujukuApi() {
    const api = globalThis.window?.AutoCardUpdaterAPI;
    if (typeof api?.exportTableAsJson !== 'function' || typeof api?.updateRow !== 'function') return null;
    return api;
}

function isAutomaticShujukuRewriteEnabled() {
    return getAppContext().extension_settings?.[extensionName]?.shujukuAutoProgramRewriteEnabled === true;
}

async function rewriteEligibleShujukuCells(api, targets) {
    const rowBatches = [];
    for (const target of targets) {
        const rewritten = applyScopedReplacements(target.value);
        if (rewritten === target.value) continue;

        let batch = rowBatches.find(candidate => (
            candidate.tableName === target.tableName && candidate.rowIndex === target.rowIndex
        ));
        if (!batch) {
            batch = {
                tableName: target.tableName,
                rowIndex: target.rowIndex,
                data: {},
                changedCount: 0,
            };
            rowBatches.push(batch);
        }
        batch.data[target.canonicalHeader] = rewritten;
        batch.changedCount++;
    }

    let changes = 0;
    for (const batch of rowBatches) {
        const saved = await api.updateRow({
            tableName: batch.tableName,
            rowIndex: batch.rowIndex,
            data: batch.data,
            skipNotify: true,
        });
        if (saved !== true) throw new Error('shujuku updateRow 未能保存改写后的行');
        changes += batch.changedCount;
    }
    return changes;
}

export function markLatestMessageShujukuRewritePending(messageIndex, source = 'message-cleanse') {
    if (!isAutomaticShujukuRewriteEnabled()) return false;
    const { chat } = getAppContext();
    if (!Array.isArray(chat) || !Number.isInteger(messageIndex)) return false;
    const message = chat[messageIndex];
    if (!isAssistantMessage(message)) return false;
    if (messageIndex !== findLatestAssistantMessageIndex(chat)) return false;
    const targetIsolationKey = readPinnedShujukuActiveIsolationKey();
    const lateV1MigrationExpected = targetIsolationKey !== null
        && isSupportedLateV1Isolation(chat, targetIsolationKey);
    registerShujukuTableUpdateCallback();
    pendingShujukuRewrite = {
        messageRef: message,
        messageIndex,
        chatIdentity: getCurrentChatIdentity(),
        targetIsolationKey,
        lateV1MigrationExpected,
        frameBoundaries: captureShujukuFrameBoundaries(chat, targetIsolationKey, lateV1MigrationExpected),
    };
    recordAiRewriteDebug('shujuku-pending-armed', { source, messageId: messageIndex });
    return true;
}

async function processPendingShujukuRewrite() {
    const pending = pendingShujukuRewrite;
    if (!pending) return;

    const message = getCurrentLatestAssistantMessage(
        pending.messageIndex,
        pending.messageRef,
        pending.chatIdentity,
        pending.lateV1MigrationExpected,
    );
    if (!message) {
        if (pendingShujukuRewrite === pending) pendingShujukuRewrite = null;
        return;
    }

    const api = getShujukuApi();
    if (!api) return;

    try {
        const { chat } = getAppContext();
        const { targets, diagnostics, hasPostArmEntries } = collectPostArmShujukuCellTargets(
            pending,
            chat,
            api.exportTableAsJson(),
        );
        if (targets.length === 0) {
            if (hasPostArmEntries && pendingShujukuRewrite === pending) pendingShujukuRewrite = null;
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
    const message = getCurrentLatestAssistantMessage(messageIndex, chat[messageIndex]);
    if (!message) return 0;

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
