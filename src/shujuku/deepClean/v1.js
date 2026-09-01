// Owns late-V1 evidence reconstruction and preparation of migration to current V2 storage; current-V2 replay internals and Chat persistence remain elsewhere.
import { projectLateV1ShujukuCells } from './replay.js';
import {
    hasShujukuTopLevelLegacyTableEvidence,
    hasShujukuV1TableEvidence,
    hasShujukuV2TableEvidence,
    isSupportedLateShujukuV1Slot,
    parseShujukuIsolatedData,
    shujukuLegacyMessageMatchesIsolation,
} from '../storageEvidence.js';

const ISOLATED_FIELD = 'TavernDB_ACU_IsolatedData';
const SCOPED_CONFIG_FIELD = 'TavernDB_ACU_ScopedConfig';
const SHEET_GUIDE_FIELD = 'TavernDB_ACU_InternalSheetGuide';
const LEGACY_CLEANUP_FIELDS = [
    'TavernDB_ACU_IndependentData',
    'TavernDB_ACU_Data',
    'TavernDB_ACU_SummaryData',
    'TavernDB_ACU_ModifiedKeys',
    'TavernDB_ACU_UpdateGroupKeys',
    'TavernDB_ACU_Identity',
];
const SETTINGS_NAMESPACE = 'shujuku_v120__userscript_settings_v1';
const PROFILE_SETTINGS_PREFIX = 'shujuku_v120_profile_v1';

function isRecord(value) {
    return !!(value && typeof value === 'object' && !Array.isArray(value));
}

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function readRecord(value, label, { optional = true } = {}) {
    if (value === undefined || value === null || value === '') {
        if (optional) return null;
        throw new Error(`${label} is missing`);
    }
    if (isRecord(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            if (isRecord(parsed)) return parsed;
        } catch {
            // The authoritative persisted value is malformed.
        }
    }
    throw new Error(`${label} is invalid`);
}

function readIsolatedData(message) {
    const raw = message?.[ISOLATED_FIELD];
    if (raw === undefined || raw === null || raw === '') return null;
    const isolatedData = parseShujukuIsolatedData(raw);
    if (isolatedData) return isolatedData;
    throw new Error('Deep Clean Shujuku isolated storage is invalid');
}

function inspectLateV1Evidence(chat) {
    if (!Array.isArray(chat)) throw new Error('Deep Clean Shujuku V1 requires a Chat Branch');
    const refsByIsolation = new Map();
    const v1Evidence = new Set();
    const v2Evidence = new Set();
    for (let messageIndex = 1; messageIndex < chat.length; messageIndex += 1) {
        const message = chat[messageIndex];
        if (!isRecord(message) || message.is_user === true) continue;
        if (hasShujukuTopLevelLegacyTableEvidence(message)) {
            throw new Error(`Deep Clean Shujuku old top-level legacy storage is unsupported: message ${messageIndex}`);
        }
        const isolatedData = readIsolatedData(message);
        if (!isolatedData) continue;
        for (const [isolationKey, slot] of Object.entries(isolatedData)) {
            if (hasShujukuV2TableEvidence(slot)) {
                v2Evidence.add(isolationKey);
                continue;
            }
            if (!hasShujukuV1TableEvidence(slot)) continue;
            v1Evidence.add(isolationKey);
            if (!isSupportedLateShujukuV1Slot(slot)) {
                throw new Error(`Deep Clean Shujuku V1 slot shape is unsupported: ${isolationKey}/message ${messageIndex}`);
            }
            if (!refsByIsolation.has(isolationKey)) refsByIsolation.set(isolationKey, []);
            refsByIsolation.get(isolationKey).push({ messageIndex, slot });
        }
    }
    v1Evidence.forEach((isolationKey) => {
        if (v2Evidence.has(isolationKey)) {
            throw new Error(`Deep Clean Shujuku V1 rejects mixed V1/V2 evidence: ${isolationKey}`);
        }
    });
    if (refsByIsolation.size === 0) return null;
    if (refsByIsolation.size > 1) {
        throw new Error('Deep Clean Shujuku V1 rejects multiple late-V1 isolation migrations in one Chat Branch');
    }
    const [isolationKey, refs] = refsByIsolation.entries().next().value;
    return { isolationKey, refs };
}

function parseOwnedContainer(chat, chatId, field) {
    const metadata = isRecord(chat[0]?.chat_metadata) ? chat[0].chat_metadata : {};
    const owner = String(metadata[`${field}__chatId`] ?? '').trim();
    let metadataContainer = null;
    if (!owner || owner === String(chatId || '')) {
        metadataContainer = readRecord(metadata[field], `Deep Clean Shujuku ${field}`);
    }
    const firstMessage = isRecord(chat[1]) ? chat[1] : null;
    const legacyContainer = readRecord(firstMessage?.[field], `Deep Clean Shujuku legacy ${field}`);
    if (!metadataContainer) return legacyContainer ? cloneJson(legacyContainer) : null;
    if (!legacyContainer) return cloneJson(metadataContainer);
    const merged = cloneJson(metadataContainer);
    for (const [key, value] of Object.entries(legacyContainer)) {
        if (key === 'version') continue;
        if (isRecord(value) && isRecord(merged[key])) {
            for (const [slotKey, slotValue] of Object.entries(value)) {
                if (!Object.prototype.hasOwnProperty.call(merged[key], slotKey)) {
                    merged[key][slotKey] = cloneJson(slotValue);
                }
            }
        } else if (!Object.prototype.hasOwnProperty.call(merged, key)) {
            merged[key] = cloneJson(value);
        }
    }
    return merged;
}

function normalizePlacement(raw, fallback) {
    const source = isRecord(raw) ? raw : {};
    const rawPosition = String(source.position ?? '').trim().toLowerCase();
    let position = fallback.position;
    if (rawPosition === 'at_depth_as_system' || rawPosition === 'system') position = 'at_depth_as_system';
    else if (['before_char', 'before_character', 'before_character_definition', '0'].includes(rawPosition)) position = 'before_character_definition';
    else if (['after_char', 'after_character', 'after_character_definition', '1'].includes(rawPosition)) position = 'after_character_definition';
    const depth = Number.parseInt(source.depth, 10);
    const order = Number.parseInt(source.order, 10);
    return {
        position,
        depth: Number.isFinite(depth) ? depth : fallback.depth,
        order: Number.isFinite(order) ? order : fallback.order,
    };
}

function fixedPlacementDefaults(tableName) {
    const name = String(tableName || '').trim();
    if (name === '总结表') return { entry: { position: 'at_depth_as_system', depth: 9999, order: 99987 }, index: { position: 'at_depth_as_system', depth: 9999, order: 99988 } };
    if (name === '总体大纲') return { entry: { position: 'at_depth_as_system', depth: 9998, order: 99985 }, index: { position: 'at_depth_as_system', depth: 9998, order: 99986 } };
    if (name === '重要人物表') return { entry: { position: 'at_depth_as_system', depth: 10000, order: 99983 }, index: { position: 'at_depth_as_system', depth: 10000, order: 99984 } };
    if (name === '全局数据表' || name === '全局表') return { entry: { position: 'before_character_definition', depth: 2, order: 99981 }, index: { position: 'before_character_definition', depth: 2, order: 99982 } };
    return { entry: { position: 'at_depth_as_system', depth: 2, order: 99990 }, index: { position: 'at_depth_as_system', depth: 2, order: 99991 } };
}

function normalizeExportConfig(value, tableName) {
    const fixed = fixedPlacementDefaults(tableName);
    const base = {
        enabled: false,
        splitByRow: false,
        entryName: tableName || '',
        entryType: 'constant',
        keywords: '',
        preventRecursion: true,
        injectionTemplate: '',
        extraIndexEnabled: false,
        extraIndexEntryName: `${tableName || '表格'}-索引`,
        extraIndexColumns: [],
        extraIndexColumnModes: {},
        extraIndexInjectionTemplate: '',
        sqlInjectionTemplate: '',
        entryPlacement: { position: 'at_depth_as_system', depth: 2, order: 10000 },
        extraIndexPlacement: { position: 'at_depth_as_system', depth: 2, order: 10010 },
        fixedEntryPlacement: fixed.entry,
        fixedIndexPlacement: fixed.index,
    };
    const raw = isRecord(value) ? value : {};
    return {
        ...base,
        ...cloneJson(raw),
        entryPlacement: normalizePlacement(raw.entryPlacement, base.entryPlacement),
        extraIndexPlacement: normalizePlacement(raw.extraIndexPlacement, base.extraIndexPlacement),
        fixedEntryPlacement: normalizePlacement(raw.fixedEntryPlacement, base.fixedEntryPlacement),
        fixedIndexPlacement: normalizePlacement(raw.fixedIndexPlacement, base.fixedIndexPlacement),
    };
}

function normalizeGlobalInjectionConfig(value) {
    const raw = isRecord(value) ? value : {};
    return {
        readableEntryPlacement: normalizePlacement(raw.readableEntryPlacement, { position: 'before_character_definition', depth: 2, order: 99981 }),
        wrapperPlacement: normalizePlacement(raw.wrapperPlacement, { position: 'before_character_definition', depth: 2, order: 99980 }),
    };
}

function sortedGuideKeys(guide) {
    return Object.keys(guide).filter((key) => key.startsWith('sheet_')).sort((left, right) => {
        const leftOrder = Number.isFinite(guide[left]?.orderNo) ? Math.trunc(guide[left].orderNo) : Number.POSITIVE_INFINITY;
        const rightOrder = Number.isFinite(guide[right]?.orderNo) ? Math.trunc(guide[right].orderNo) : Number.POSITIVE_INFINITY;
        return leftOrder - rightOrder || left.localeCompare(right);
    });
}

function normalizeGuideData(source) {
    if (!isRecord(source)) return null;
    const sourceKeys = Object.keys(source).filter((key) => key.startsWith('sheet_'));
    if (sourceKeys.length === 0) return null;
    const mate = isRecord(source.mate) ? cloneJson(source.mate) : { type: 'chatSheets', version: 2 };
    if (!mate.type) mate.type = 'chatSheets';
    mate.version = Number.isFinite(mate.version) ? Math.max(2, Math.trunc(mate.version)) : 2;
    mate.globalInjectionConfig = normalizeGlobalInjectionConfig(mate.globalInjectionConfig);
    const guide = { mate };
    sourceKeys.forEach((sheetKey) => {
        const sheet = source[sheetKey];
        if (!isRecord(sheet)) throw new Error(`Deep Clean Shujuku V1 Guide sheet is invalid: ${sheetKey}`);
        const header = Array.isArray(sheet.content?.[0]) ? cloneJson(sheet.content[0]) : [null];
        const name = sheet.name || sheetKey;
        const normalized = {
            uid: sheet.uid || sheetKey,
            name,
            sourceData: isRecord(sheet.sourceData) ? cloneJson(sheet.sourceData) : { note: '', initNode: '', insertNode: '', updateNode: '', deleteNode: '' },
            content: [header],
            updateConfig: isRecord(sheet.updateConfig)
                ? cloneJson(sheet.updateConfig)
                : { uiSentinel: -1, contextDepth: -1, updateFrequency: -1, batchSize: -1, skipFloors: -1, sendLatestRows: -1, groupId: -1 },
            exportConfig: normalizeExportConfig(sheet.exportConfig, name),
        };
        const seedRows = Array.isArray(sheet.seedRows) ? sheet.seedRows : sheet._seedRows;
        if (Array.isArray(seedRows)) normalized.seedRows = cloneJson(seedRows);
        if (sheet.orderNo !== undefined) normalized.orderNo = sheet.orderNo;
        guide[sheetKey] = normalized;
    });
    return guide;
}

function buildGuideFromTemplate(templateSource) {
    let template = templateSource;
    if (typeof templateSource === 'string') {
        try {
            template = JSON.parse(templateSource);
        } catch {
            return null;
        }
    }
    if (!isRecord(template)) return null;
    const copy = cloneJson(template);
    const keys = Object.keys(copy).filter((key) => key.startsWith('sheet_'));
    if (keys.length === 0) return null;
    const usedOrders = new Set();
    let rebuildOrder = false;
    keys.forEach((key) => {
        const order = copy[key]?.orderNo;
        if (!Number.isFinite(order) || usedOrders.has(Math.trunc(order))) rebuildOrder = true;
        else usedOrders.add(Math.trunc(order));
    });
    keys.forEach((key, index) => {
        const sheet = copy[key];
        if (!isRecord(sheet)) throw new Error(`Deep Clean Shujuku V1 template sheet is invalid: ${key}`);
        if (rebuildOrder) sheet.orderNo = index;
        if (Array.isArray(sheet.content) && sheet.content.length > 1) sheet.seedRows = cloneJson(sheet.content.slice(1));
    });
    return normalizeGuideData(copy);
}

function readNamedTemplatePreset(context, presetName) {
    const normalizedName = String(presetName ?? '').trim() === '__ACU_DEFAULT_TEMPLATE_PRESET__'
        ? ''
        : String(presetName ?? '').trim();
    if (!normalizedName) return null;
    const extensionSettings = context?.extensionSettings;
    const namespace = extensionSettings?.__userscripts?.[SETTINGS_NAMESPACE];
    if (!isRecord(namespace)) return null;
    const store = readRecord(namespace.shujuku_v120_templatePresets_v1, 'Deep Clean Shujuku template preset store');
    const preset = isRecord(store?.presets) ? store.presets[normalizedName] : null;
    return typeof preset?.templateStr === 'string' && preset.templateStr.trim() ? preset.templateStr : null;
}

function readProfileTemplate(context, isolationKey) {
    const extensionSettings = context?.extensionSettings;
    if (!isRecord(extensionSettings)) {
        throw new Error('Deep Clean Shujuku V1 cannot read authoritative Shujuku settings');
    }
    const namespace = extensionSettings.__userscripts?.[SETTINGS_NAMESPACE];
    if (!isRecord(namespace)) {
        throw new Error('Deep Clean Shujuku V1 Shujuku settings namespace is unavailable');
    }
    const slot = isolationKey ? encodeURIComponent(isolationKey) : '__default__';
    const template = namespace[`${PROFILE_SETTINGS_PREFIX}__${slot}__template`];
    if (template === undefined || template === null || template === '') return null;
    return template;
}

function resolveGuide(chat, chatId, isolationKey, context) {
    const guideContainer = parseOwnedContainer(chat, chatId, SHEET_GUIDE_FIELD);
    const guideSlot = isRecord(guideContainer?.tags) ? guideContainer.tags[isolationKey] : null;
    const guideMode = typeof guideSlot?.templateScopeMode === 'string' && guideSlot.templateScopeMode.trim()
        ? guideSlot.templateScopeMode
        : 'chat_override';
    if (isRecord(guideSlot) && guideMode === 'chat_override') {
        const guide = normalizeGuideData(guideSlot.data);
        if (guide) return guide;
        throw new Error(`Deep Clean Shujuku V1 chat Guide is invalid: ${isolationKey}`);
    }

    const scoped = parseOwnedContainer(chat, chatId, SCOPED_CONFIG_FIELD);
    const scopedState = isRecord(scoped?.template) ? scoped.template[isolationKey] : null;
    if (isRecord(scopedState)) {
        const mode = scopedState.mode === undefined || scopedState.mode === 'inherit_global'
            ? 'inherit_global'
            : scopedState.mode;
        if (mode === 'preset_link') {
            const templateSource = readNamedTemplatePreset(context, scopedState.presetName);
            const guide = buildGuideFromTemplate(templateSource);
            if (!guide) {
                throw new Error(`Deep Clean Shujuku V1 cannot resolve a preset-linked Guide read-only: ${isolationKey}`);
            }
            return guide;
        }
        if (mode === 'chat_override') {
            if (typeof scopedState.templateStr !== 'string' || !scopedState.templateStr.trim()) {
                throw new Error(`Deep Clean Shujuku V1 chat template is unavailable: ${isolationKey}`);
            }
            const guide = normalizeGuideData(scopedState.guideData) || buildGuideFromTemplate(scopedState.templateStr);
            if (!guide) throw new Error(`Deep Clean Shujuku V1 chat template is invalid: ${isolationKey}`);
            return guide;
        }
        if (mode !== 'inherit_global') {
            throw new Error(`Deep Clean Shujuku V1 template scope is unsupported: ${isolationKey}`);
        }
    }

    const guide = buildGuideFromTemplate(readProfileTemplate(context, isolationKey));
    if (!guide) throw new Error(`Deep Clean Shujuku V1 inherited profile template is unavailable: ${isolationKey}`);
    return guide;
}

function canonicalDisplayName(value) {
    return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function isSheetAllowed(sheetKey, sheet, guide, allowedKeys) {
    if (allowedKeys.has(sheetKey)) return true;
    const name = canonicalDisplayName(sheet?.name);
    return !!name && [...allowedKeys].some((key) => canonicalDisplayName(guide[key]?.name) === name);
}

function applyDelta(base, delta, sheetKey) {
    if (!isRecord(delta) || !Array.isArray(delta.rowDeltas)
        || (delta.metaChanged !== undefined && !isRecord(delta.metaChanged))
        || (delta.structureChanged !== undefined && delta.structureChanged !== false)) {
        throw new Error(`Deep Clean Shujuku V1 delta is invalid: ${sheetKey}`);
    }
    const result = cloneJson(base);
    if (delta.metaChanged) {
        ['name', 'orderNo', 'updateConfig', 'exportConfig', 'sourceData'].forEach((field) => {
            if (delta.metaChanged[field] !== undefined) result[field] = cloneJson(delta.metaChanged[field]);
        });
    }
    if (!Array.isArray(result.content)) throw new Error(`Deep Clean Shujuku V1 delta base is invalid: ${sheetKey}`);
    const rowIndexes = new Map();
    result.content.forEach((row, index) => {
        if (Array.isArray(row) && row[0]) rowIndexes.set(row[0], index);
    });
    const deletes = new Set();
    delta.rowDeltas.forEach((rowDelta) => {
        if (!isRecord(rowDelta) || (rowDelta.op !== 'delete' && rowDelta.op !== 'upsert')) {
            throw new Error(`Deep Clean Shujuku V1 row delta is invalid: ${sheetKey}`);
        }
        const rowId = rowDelta.row_id;
        if (typeof rowId !== 'string' || !rowId || rowId === 'row_id') {
            throw new Error(`Deep Clean Shujuku V1 row delta has no canonical row_id: ${sheetKey}`);
        }
        const index = rowIndexes.get(rowId);
        if (rowDelta.op === 'delete') {
            if (index !== undefined) deletes.add(index);
            return;
        }
        if (!Array.isArray(rowDelta.cells) || rowDelta.cells[0] !== rowId) {
            throw new Error(`Deep Clean Shujuku V1 upsert row identity is invalid: ${sheetKey}/${rowId}`);
        }
        if (index !== undefined) result.content[index] = cloneJson(rowDelta.cells);
        else {
            result.content.push(cloneJson(rowDelta.cells));
            rowIndexes.set(rowId, result.content.length - 1);
        }
    });
    [...deletes].sort((left, right) => right - left).forEach((index) => result.content.splice(index, 1));
    return result;
}

function normalizeLegacyUpdateConfig(state) {
    Object.entries(state).forEach(([sheetKey, sheet]) => {
        if (!sheetKey.startsWith('sheet_') || !isRecord(sheet?.updateConfig) || sheet.updateConfig.uiSentinel === -1) return;
        ['contextDepth', 'updateFrequency', 'batchSize', 'skipFloors'].forEach((field) => {
            if (Object.prototype.hasOwnProperty.call(sheet.updateConfig, field) && sheet.updateConfig[field] === 0) {
                sheet.updateConfig[field] = -1;
            }
        });
        sheet.updateConfig.uiSentinel = -1;
    });
}

function overlayGuide(state, guide) {
    const historicalByName = new Map();
    Object.entries(state).forEach(([sheetKey, sheet]) => {
        if (!sheetKey.startsWith('sheet_') || !isRecord(sheet)) return;
        const name = canonicalDisplayName(sheet.name);
        if (!name) throw new Error(`Deep Clean Shujuku V1 sheet has no canonical display name: ${sheetKey}`);
        const keys = historicalByName.get(name) || [];
        keys.push(sheetKey);
        historicalByName.set(name, keys);
    });
    const projected = { mate: cloneJson(guide.mate) };
    const matchedHistorical = new Set();
    for (const sheetKey of sortedGuideKeys(guide)) {
        const guideSheet = guide[sheetKey];
        const name = canonicalDisplayName(guideSheet?.name);
        if (!name) throw new Error(`Deep Clean Shujuku V1 Guide sheet has no canonical display name: ${sheetKey}`);
        const historicalKeys = historicalByName.get(name) || [];
        if (historicalKeys.length > 1) {
            throw new Error(`Deep Clean Shujuku V1 Guide sheet identity is ambiguous: ${sheetKey}`);
        }
        if (historicalKeys.length === 0) {
            projected[sheetKey] = cloneJson(guideSheet);
            continue;
        }
        const historicalKey = historicalKeys[0];
        if (historicalKey !== sheetKey) {
            throw new Error(`Deep Clean Shujuku V1 Sheet key requires identity migration: ${historicalKey}/${sheetKey}`);
        }
        matchedHistorical.add(historicalKey);
        const next = cloneJson(state[historicalKey]);
        next.uid = sheetKey;
        if (guideSheet.name) next.name = guideSheet.name;
        if (guideSheet.sourceData) next.sourceData = cloneJson(guideSheet.sourceData);
        if (guideSheet.updateConfig) next.updateConfig = cloneJson(guideSheet.updateConfig);
        if (guideSheet.exportConfig) next.exportConfig = cloneJson(guideSheet.exportConfig);
        const header = Array.isArray(guideSheet.content?.[0]) ? cloneJson(guideSheet.content[0]) : null;
        if (!header || header[0] !== 'row_id') {
            throw new Error(`Deep Clean Shujuku V1 Guide header requires repair: ${sheetKey}`);
        }
        const historicalHeader = Array.isArray(next.content?.[0]) ? next.content[0] : null;
        if (!historicalHeader || JSON.stringify(historicalHeader) !== JSON.stringify(header)) {
            throw new Error(`Deep Clean Shujuku V1 header requires structural repair or renaming: ${sheetKey}`);
        }
        next.content[0] = header;
        for (let rowIndex = 1; rowIndex < next.content.length; rowIndex += 1) {
            const row = next.content[rowIndex];
            if (!Array.isArray(row)) throw new Error(`Deep Clean Shujuku V1 row shape is invalid: ${sheetKey}/${rowIndex}`);
            if (row.length > header.length) {
                throw new Error(`Deep Clean Shujuku V1 row exceeds the Guide header: ${sheetKey}/${rowIndex}`);
            }
            while (row.length < header.length) row.push(null);
        }
        if (Number.isFinite(guideSheet.orderNo)) next.orderNo = Math.trunc(guideSheet.orderNo);
        if (Array.isArray(guideSheet.seedRows)) next.seedRows = cloneJson(guideSheet.seedRows);
        projected[sheetKey] = next;
    }
    const unmatched = Object.keys(state).filter((key) => key.startsWith('sheet_') && !matchedHistorical.has(key));
    if (unmatched.length > 0) {
        throw new Error(`Deep Clean Shujuku V1 Sheet identity cannot be resolved by the Guide: ${unmatched.join(', ')}`);
    }
    return projected;
}

function assertCleanRows(state) {
    const sheetKeys = Object.keys(state).filter((key) => key.startsWith('sheet_'));
    if (sheetKeys.length === 0) throw new Error('Deep Clean Shujuku V1 reconstruction has no Sheet');
    sheetKeys.forEach((sheetKey) => {
        const sheet = state[sheetKey];
        if (!isRecord(sheet) || !Array.isArray(sheet.content) || !Array.isArray(sheet.content[0])
            || sheet.content[0].length === 0 || sheet.content[0][0] !== 'row_id') {
            throw new Error(`Deep Clean Shujuku V1 header requires repair: ${sheetKey}`);
        }
        const header = sheet.content[0];
        const headerNames = header.map((value) => String(value ?? '').trim());
        if (headerNames.some((value) => !value) || new Set(headerNames).size !== headerNames.length) {
            throw new Error(`Deep Clean Shujuku V1 physical column mapping is ambiguous: ${sheetKey}`);
        }
        const ids = new Set();
        const inspectRows = (rows, pool, offset) => {
            rows.forEach((row, index) => {
                if (!Array.isArray(row) || row.length !== header.length) {
                    throw new Error(`Deep Clean Shujuku V1 ${pool} row width is invalid: ${sheetKey}/${index + offset}`);
                }
                const rowId = typeof row[0] === 'string' ? row[0].trim() : '';
                if (!rowId || row[0] !== rowId || ids.has(rowId)) {
                    throw new Error(`Deep Clean Shujuku V1 ${pool} row_id requires repair: ${sheetKey}/${index + offset}`);
                }
                ids.add(rowId);
            });
        };
        inspectRows(sheet.content.slice(1), 'content', 1);
        if (sheet.seedRows !== undefined) {
            if (!Array.isArray(sheet.seedRows)) throw new Error(`Deep Clean Shujuku V1 seedRows is invalid: ${sheetKey}`);
            inspectRows(sheet.seedRows, 'seedRows', 0);
        }
    });
}

async function reconstructLateV1(chat, options = {}) {
    const evidence = inspectLateV1Evidence(chat);
    if (!evidence) return null;
    const guide = resolveGuide(chat, options.chatId, evidence.isolationKey, options.context);
    const allowedKeys = new Set(sortedGuideKeys(guide));
    const state = {};
    const found = new Set();
    const pendingDeltas = [];
    for (let index = evidence.refs.length - 1; index >= 0; index -= 1) {
        const ref = evidence.refs[index];
        if (ref.slot._acu_storage_mode === 'delta') {
            if (Object.keys(ref.slot.incrementalData).length > 0) pendingDeltas.push(ref);
            continue;
        }
        Object.entries(ref.slot.independentData).forEach(([sheetKey, sheet]) => {
            if (!sheetKey.startsWith('sheet_') || !isRecord(sheet)) return;
            if (!isSheetAllowed(sheetKey, sheet, guide, allowedKeys) || found.has(sheetKey)) return;
            state[sheetKey] = cloneJson(sheet);
            found.add(sheetKey);
        });
    }
    pendingDeltas.reverse();
    pendingDeltas.forEach((ref) => {
        Object.entries(ref.slot.incrementalData).forEach(([sheetKey, delta]) => {
            if (!allowedKeys.has(sheetKey)) return;
            if (!state[sheetKey]) {
                throw new Error(`Deep Clean Shujuku V1 delta has no exact Sheet checkpoint: ${sheetKey}/message ${ref.messageIndex}`);
            }
            state[sheetKey] = applyDelta(state[sheetKey], delta, sheetKey);
        });
    });
    normalizeLegacyUpdateConfig(state);
    const projected = overlayGuide(state, guide);
    assertCleanRows(projected);
    await projectLateV1ShujukuCells(projected, evidence.isolationKey);
    return { ...evidence, state: projected };
}

export async function readLateShujukuV1Cells(chat, options = {}) {
    const replay = await reconstructLateV1(chat, options);
    if (!replay) return [];
    const globalSkip = readGlobalSkipUpdateFloors(options.context, replay.isolationKey);
    const effectiveSkip = resolveEffectiveSkip(replay.state, globalSkip);
    const targetMessageIndex = migrationTarget(chat, effectiveSkip);
    collectMigrationEvidence(chat, replay.isolationKey, replay.state, targetMessageIndex);
    return projectLateV1ShujukuCells(replay.state, replay.isolationKey);
}

function fingerprint(value) {
    const text = JSON.stringify(value, (_key, item) => {
        if (!isRecord(item)) return item;
        return Object.keys(item).sort().reduce((result, key) => {
            result[key] = item[key];
            return result;
        }, {});
    });
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function countAiFloor(chat, branchMessageIndex) {
    let count = 0;
    for (let index = 1; index <= branchMessageIndex && index < chat.length; index += 1) {
        if (isRecord(chat[index]) && chat[index].is_user !== true) count += 1;
    }
    return count;
}

function normalizeSkip(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
}

function readGlobalSkipUpdateFloors(context, isolationKey) {
    const extensionSettings = context?.extensionSettings;
    if (!isRecord(extensionSettings)) {
        throw new Error('Deep Clean Shujuku V1 migration cannot read authoritative Shujuku settings');
    }
    const namespace = extensionSettings.__userscripts?.[SETTINGS_NAMESPACE];
    if (!isRecord(namespace)) {
        throw new Error('Deep Clean Shujuku V1 migration settings namespace is unavailable');
    }
    const slot = isolationKey ? encodeURIComponent(isolationKey) : '__default__';
    const profileKey = `${PROFILE_SETTINGS_PREFIX}__${slot}__settings`;
    if (!Object.prototype.hasOwnProperty.call(namespace, profileKey)) {
        throw new Error(`Deep Clean Shujuku V1 migration target profile settings are missing: ${slot}`);
    }
    const settings = readRecord(
        namespace[profileKey],
        `Deep Clean Shujuku V1 migration target profile settings (${slot})`,
        { optional: false },
    );
    return normalizeSkip(settings.skipUpdateFloors);
}

function resolveEffectiveSkip(state, inheritedSkip) {
    let skip = normalizeSkip(inheritedSkip);
    Object.entries(state).forEach(([sheetKey, sheet]) => {
        if (!sheetKey.startsWith('sheet_')) return;
        const raw = sheet?.updateConfig?.skipFloors;
        if (Number.isFinite(raw) && raw >= 0) skip = Math.max(skip, normalizeSkip(raw));
    });
    return skip;
}

function migrationTarget(chat, skip) {
    const assistants = [];
    for (let messageIndex = 1; messageIndex < chat.length; messageIndex += 1) {
        if (isRecord(chat[messageIndex]) && chat[messageIndex].is_user !== true) assistants.push(messageIndex);
    }
    if (assistants.length === 0) throw new Error('Deep Clean Shujuku V1 migration has no assistant Message target');
    return assistants[Math.max(0, assistants.length - 1 - normalizeSkip(skip))];
}

function noteSchedule(summary, sheetKey, aiFloor, changed) {
    if (!summary[sheetKey]) summary[sheetKey] = {};
    summary[sheetKey].lastFilledAiFloor = Math.max(summary[sheetKey].lastFilledAiFloor || 0, aiFloor);
    if (changed) summary[sheetKey].lastChangedAiFloor = Math.max(summary[sheetKey].lastChangedAiFloor || 0, aiFloor);
}

function collectMigrationEvidence(chat, isolationKey, state, targetMessageIndex) {
    const allowed = new Set(Object.keys(state).filter((key) => key.startsWith('sheet_')));
    const scheduleSummary = {};
    const sourceMessageIndices = [];
    const sourceAiFloors = [];
    for (let messageIndex = 1; messageIndex <= targetMessageIndex; messageIndex += 1) {
        const message = chat[messageIndex];
        if (!isRecord(message) || message.is_user === true) continue;
        const slot = readIsolatedData(message)?.[isolationKey];
        if (!isRecord(slot) || hasShujukuV2TableEvidence(slot)) continue;
        const dataKeys = isRecord(slot.independentData) ? Object.keys(slot.independentData).filter((key) => allowed.has(key)) : [];
        const deltaKeys = isRecord(slot.incrementalData) ? Object.keys(slot.incrementalData).filter((key) => allowed.has(key)) : [];
        const modified = Array.isArray(slot.modifiedKeys) ? [...new Set(slot.modifiedKeys.filter((key) => allowed.has(key)))] : [];
        const groups = Array.isArray(slot.updateGroupKeys) ? [...new Set(slot.updateGroupKeys.filter((key) => allowed.has(key)))] : [];
        if (dataKeys.length + deltaKeys.length + modified.length + groups.length === 0) continue;
        const aiFloor = countAiFloor(chat, messageIndex);
        groups.forEach((key) => noteSchedule(scheduleSummary, key, aiFloor, false));
        modified.forEach((key) => noteSchedule(scheduleSummary, key, aiFloor, true));
        deltaKeys.forEach((key) => noteSchedule(scheduleSummary, key, aiFloor, true));
        if (groups.length === 0 && modified.length === 0 && deltaKeys.length === 0) {
            dataKeys.forEach((key) => noteSchedule(scheduleSummary, key, aiFloor, true));
        }
        sourceMessageIndices.push(messageIndex - 1);
        sourceAiFloors.push(aiFloor);
    }
    if (sourceMessageIndices.length === 0) {
        throw new Error('Deep Clean Shujuku V1 migration target precedes all authoritative V1 source evidence');
    }
    return { scheduleSummary, sourceMessageIndices, sourceAiFloors };
}

function validateFrozenTargets(cells, changes, isolationKey) {
    const byIdentity = new Map(cells.map((cell) => [
        `${cell.sheetKey}\u0000${cell.rowId}\u0000${cell.columnKey}`,
        cell,
    ]));
    const seen = new Set();
    changes.forEach((change) => {
        const locator = change.locator || {};
        if (change.storageProtocol !== 'v1' || locator.isolationKey !== isolationKey) {
            throw new Error('Deep Clean Shujuku V1 Apply received a mismatched storage protocol or isolation key');
        }
        const identity = `${locator.sheetKey}\u0000${locator.rowId}\u0000${locator.columnKey}`;
        if (seen.has(identity)) throw new Error(`Deep Clean Shujuku V1 Cell locator is duplicated: ${identity}`);
        seen.add(identity);
        const cell = byIdentity.get(identity);
        if (!cell || cell.originalText !== change.originalText) {
            throw new Error(`Deep Clean Shujuku V1 Cell changed after Freeze: ${locator.sheetKey}/${locator.rowId}/${locator.columnKey}`);
        }
    });
}

function cleanLegacyFields(chat, isolationKey) {
    const changed = new Set();
    for (let messageIndex = 1; messageIndex < chat.length; messageIndex += 1) {
        const message = chat[messageIndex];
        if (!isRecord(message) || message.is_user === true) continue;
        const isolatedData = readIsolatedData(message);
        if (isolatedData && Object.prototype.hasOwnProperty.call(isolatedData, isolationKey)) {
            const slot = isolatedData[isolationKey];
            if (!hasShujukuV2TableEvidence(slot)) {
                const next = cloneJson(isolatedData);
                delete next[isolationKey];
                if (Object.keys(next).length === 0) delete message[ISOLATED_FIELD];
                else message[ISOLATED_FIELD] = next;
                changed.add(messageIndex);
            }
        }
        if (shujukuLegacyMessageMatchesIsolation(message, isolationKey)) {
            let removed = false;
            LEGACY_CLEANUP_FIELDS.forEach((field) => {
                if (Object.prototype.hasOwnProperty.call(message, field)) {
                    delete message[field];
                    removed = true;
                }
            });
            if (removed) changed.add(messageIndex);
        }
    }
    return changed;
}

export async function prepareLateShujukuV1Migration(chat, changes, options = {}) {
    const replay = await reconstructLateV1(chat, options);
    if (!replay) throw new Error('Deep Clean Shujuku V1 fresh reconstruction is unavailable');
    const cells = await projectLateV1ShujukuCells(replay.state, replay.isolationKey);
    validateFrozenTargets(cells, changes, replay.isolationKey);

    const globalSkip = readGlobalSkipUpdateFloors(options.context, replay.isolationKey);
    const effectiveSkip = resolveEffectiveSkip(replay.state, globalSkip);
    const targetMessageIndex = migrationTarget(chat, effectiveSkip);
    const evidence = collectMigrationEvidence(chat, replay.isolationKey, replay.state, targetMessageIndex);
    const migratedAt = Date.now();
    const targetAiFloor = countAiFloor(chat, targetMessageIndex);
    const dataFingerprint = fingerprint(replay.state);
    const migrationProvenance = {
        version: 1,
        legacyDataFingerprint: dataFingerprint,
        legacySourceMessageIndices: evidence.sourceMessageIndices,
        legacySourceAiFloors: evidence.sourceAiFloors,
        legacyLastChangedAiFloorBySheet: Object.fromEntries(
            Object.entries(evidence.scheduleSummary)
                .filter(([, value]) => Number.isInteger(value.lastChangedAiFloor) && value.lastChangedAiFloor >= 0)
                .map(([sheetKey, value]) => [sheetKey, value.lastChangedAiFloor]),
        ),
        targetMessageIndex: targetMessageIndex - 1,
        targetAiFloor,
        isolationKey: replay.isolationKey,
        migratedAt,
    };
    const checkpoint = {
        kind: 'full',
        createdAt: migratedAt,
        reason: 'migration',
        data: cloneJson(replay.state),
        scheduleSummary: cloneJson(evidence.scheduleSummary),
        migrationProvenance: cloneJson(migrationProvenance),
    };
    const targetMessage = chat[targetMessageIndex];
    const existingTargetSlot = readIsolatedData(targetMessage)?.[replay.isolationKey];
    const changedMessageIndexes = cleanLegacyFields(chat, replay.isolationKey);
    const isolatedData = readIsolatedData(targetMessage) || {};
    isolatedData[replay.isolationKey] = {
        ...(existingTargetSlot?.summaryVectorIndexState !== undefined ? { summaryVectorIndexState: cloneJson(existingTargetSlot.summaryVectorIndexState) } : {}),
        ...(existingTargetSlot?.summaryVectorIndexManifest !== undefined ? { summaryVectorIndexManifest: cloneJson(existingTargetSlot.summaryVectorIndexManifest) } : {}),
        storageFrame: {
            version: 2,
            headRevision: `checkpoint:migration:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`,
            checkpoint,
            logEntries: [],
        },
        migrationAuditBackup: {
            version: 1,
            createdAt: migratedAt,
            sourceData: cloneJson(replay.state),
            dataFingerprintBefore: dataFingerprint,
            dataFingerprintAfter: dataFingerprint,
            auditStatus: 'clean',
            issues: [],
            repairPlan: [],
            idRemap: [],
        },
        _acu_storage_version: 2,
    };
    targetMessage[ISOLATED_FIELD] = isolatedData;
    changedMessageIndexes.add(targetMessageIndex);
    return {
        isolationKey: replay.isolationKey,
        changedMessageIndexes: [...changedMessageIndexes].sort((left, right) => left - right),
    };
}
