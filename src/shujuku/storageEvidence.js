/** Pure Shujuku storage/protocol evidence classification; it performs no mutation or repair. */
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function owns(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function hasSheetKeyRecord(value) {
    return isRecord(value) && Object.keys(value).some(key => key.startsWith('sheet_'));
}

function hasSheetKeyList(value) {
    return Array.isArray(value) && value.some(key => typeof key === 'string' && key.startsWith('sheet_'));
}

export function parseShujukuIsolatedData(raw) {
    if (isRecord(raw)) return raw;
    if (typeof raw !== 'string') return null;
    try {
        const parsed = JSON.parse(raw);
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function hasShujukuV2TableEvidence(slot) {
    if (!isRecord(slot)) return false;
    if (slot._acu_storage_version === 2) return true;
    const frame = slot.storageFrame;
    return isRecord(frame) && (
        frame.version === 2
        || frame.checkpoint !== undefined
        || frame.perSheetCheckpoints !== undefined
        || (Array.isArray(frame.logEntries) && frame.logEntries.length > 0)
        || frame.manualRefillProgress !== undefined
        || (frame.headRevision !== undefined
            && frame.headRevision !== null
            && (typeof frame.headRevision !== 'string' || frame.headRevision.length > 0))
    );
}

export function hasShujukuV1TableEvidence(slot) {
    if (!isRecord(slot)) return false;
    const ownsV1DataContainer = owns(slot, 'independentData') || owns(slot, 'incrementalData');
    return hasSheetKeyRecord(slot.independentData)
        || hasSheetKeyRecord(slot.incrementalData)
        || hasSheetKeyList(slot.modifiedKeys)
        || hasSheetKeyList(slot.updateGroupKeys)
        || (ownsV1DataContainer
            && (slot._acu_storage_mode === 'checkpoint'
                || slot._acu_storage_mode === 'delta'
                || slot._acu_storage_mode === 'legacy'))
        || (ownsV1DataContainer && slot._acu_storage_version === 1);
}

export function isSupportedLateShujukuV1Slot(slot) {
    if (!isRecord(slot) || (slot._acu_storage_mode !== 'checkpoint' && slot._acu_storage_mode !== 'delta')) {
        return false;
    }
    if (slot._acu_storage_version !== undefined && slot._acu_storage_version !== 1) return false;
    if ((slot.modifiedKeys !== undefined && (!Array.isArray(slot.modifiedKeys) || slot.modifiedKeys.some(key => typeof key !== 'string')))
        || (slot.updateGroupKeys !== undefined && (!Array.isArray(slot.updateGroupKeys) || slot.updateGroupKeys.some(key => typeof key !== 'string')))) {
        return false;
    }
    if (slot.migrationAuditBackup !== undefined) {
        const audit = slot.migrationAuditBackup;
        if (!isRecord(audit) || audit.auditStatus !== 'clean'
            || !Array.isArray(audit.issues) || audit.issues.length > 0
            || !Array.isArray(audit.repairPlan) || audit.repairPlan.length > 0
            || !Array.isArray(audit.idRemap) || audit.idRemap.length > 0
            || (audit.supersededV2Frames !== undefined
                && (!Array.isArray(audit.supersededV2Frames) || audit.supersededV2Frames.length > 0))) {
            return false;
        }
    }
    if (slot._acu_storage_mode === 'checkpoint') {
        return isRecord(slot.independentData)
            && (slot.incrementalData === undefined
                || (isRecord(slot.incrementalData) && Object.keys(slot.incrementalData).length === 0));
    }
    return isRecord(slot.incrementalData)
        && (slot.independentData === undefined
            || (isRecord(slot.independentData) && Object.keys(slot.independentData).length === 0));
}

export function shujukuLegacyMessageMatchesIsolation(message, isolationKey) {
    return isolationKey
        ? message?.TavernDB_ACU_Identity === isolationKey
        : !message?.TavernDB_ACU_Identity;
}

export function hasShujukuTopLevelLegacyTableEvidence(message) {
    return hasSheetKeyRecord(message?.TavernDB_ACU_IndependentData)
        || hasSheetKeyRecord(message?.TavernDB_ACU_Data)
        || hasSheetKeyRecord(message?.TavernDB_ACU_SummaryData)
        || hasSheetKeyList(message?.TavernDB_ACU_ModifiedKeys)
        || hasSheetKeyList(message?.TavernDB_ACU_UpdateGroupKeys);
}
