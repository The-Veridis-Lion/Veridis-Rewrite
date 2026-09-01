// Owns deterministic persisted-Shujuku replay/materialization for Deep Clean, including V1 projection and current-V2 cell reading/application; realtime callbacks and Chat save orchestration remain elsewhere.
import { pinyin } from '../../../vendor/pinyin-pro/index.mjs';
import initSqlJs from '../../../vendor/sql.js/sql-wasm.mjs';
import { hasShujukuV2TableEvidence } from '../storageEvidence.js';

const SUPPORTED_OPERATION_KINDS = new Set([
    'sql_batch',
    'sql_sheet_batch',
    'row_upsert',
    'row_delete',
    'meta_update',
    'sheet_schema_migrate',
    'sheet_replace',
    'data_replace',
]);
const META_TABLE_NAME = '_acu_sheet_meta';
const META_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${META_TABLE_NAME} (
  sheet_key TEXT PRIMARY KEY,
  uid TEXT NOT NULL,
  name TEXT NOT NULL,
  order_no INTEGER DEFAULT 0,
  source_data_json TEXT,
  update_config_json TEXT,
  export_config_json TEXT,
  physical_table_name TEXT
);`;

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
    return !!(value && typeof value === 'object' && !Array.isArray(value));
}

function readShujukuIsolatedData(message) {
    const raw = message?.TavernDB_ACU_IsolatedData;
    if (isRecord(raw)) return raw;
    if (typeof raw !== 'string') return null;
    try {
        const parsed = JSON.parse(raw);
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function readV2Slot(message, isolationKey) {
    if (!isRecord(message) || message.is_user === true) return null;
    return readShujukuIsolatedData(message)?.[isolationKey] ?? null;
}

function collectIsolationKeys(chat) {
    const keys = new Set();
    chat.forEach((message) => {
        if (!isRecord(message) || message.is_user === true) return;
        const container = readShujukuIsolatedData(message);
        if (!container) return;
        Object.entries(container).forEach(([isolationKey, slot]) => {
            if (hasShujukuV2TableEvidence(slot)) keys.add(isolationKey);
        });
    });
    return [...keys];
}

function collectFrameRefs(chat, isolationKey) {
    const refs = [];
    chat.forEach((message, messageIndex) => {
        const slot = readV2Slot(message, isolationKey);
        if (hasShujukuV2TableEvidence(slot)) refs.push({ messageIndex, frame: slot.storageFrame });
    });
    return refs;
}

function latestFullCheckpointIndex(frameRefs) {
    for (let index = frameRefs.length - 1; index >= 0; index -= 1) {
        const checkpoint = frameRefs[index].frame?.checkpoint;
        if (isRecord(checkpoint) && checkpoint.kind === 'full' && isRecord(checkpoint.data)) return index;
    }
    return -1;
}

function assertCurrentWriterReplaySegment(frameRefs, baseIndex) {
    for (let frameIndex = baseIndex; frameIndex < frameRefs.length; frameIndex += 1) {
        const { frame, messageIndex } = frameRefs[frameIndex];
        if (!isRecord(frame) || frame.version !== 2 || !Array.isArray(frame.logEntries)) {
            throw new Error(`Deep Clean Shujuku V2 replay frame is unsupported: message ${messageIndex}`);
        }
        for (const entry of frame.logEntries) {
            if (!isRecord(entry)) throw new Error('Deep Clean Shujuku V2 log entry is invalid');
            const operations = entry.operations;
            if (!Array.isArray(operations)) {
                if (Array.isArray(entry.patches) && entry.patches.length > 0) {
                    throw new Error('Deep Clean Shujuku V2 patch replay is unsupported');
                }
                throw new Error('Deep Clean Shujuku V2 log entry has no operations array');
            }
            if (operations.length === 0 && Array.isArray(entry.patches) && entry.patches.length > 0) {
                throw new Error('Deep Clean Shujuku V2 patch replay is unsupported');
            }
            for (const operation of operations) {
                if (!isRecord(operation)) throw new Error('Deep Clean Shujuku V2 operation is invalid');
                if (operation.kind === 'table_edit_dsl') {
                    throw new Error('Deep Clean Shujuku V2 table_edit_dsl replay is unsupported');
                }
                if (!SUPPORTED_OPERATION_KINDS.has(operation.kind)) {
                    throw new Error(`Deep Clean Shujuku V2 operation is unsupported: ${String(operation.kind)}`);
                }
                if (operation.kind === 'sheet_schema_migrate'
                    && operation.contractVersion !== 1 && operation.contractVersion !== 2) {
                    throw new Error(`Deep Clean Shujuku schema migration contract is unsupported: ${String(operation.contractVersion)}`);
                }
            }
        }
    }
}

function assertCanonicalSheet(sheet, sheetKey) {
    if (!sheetKey.startsWith('sheet_') || !isRecord(sheet) || !Array.isArray(sheet.content)) {
        throw new Error(`Deep Clean Shujuku sheet is invalid: ${sheetKey}`);
    }
    const header = sheet.content[0];
    if (!Array.isArray(header) || header.length === 0 || header[0] !== 'row_id') {
        throw new Error(`Deep Clean Shujuku sheet has no canonical row_id header: ${sheetKey}`);
    }
    const rowIds = new Set();
    for (let rowIndex = 1; rowIndex < sheet.content.length; rowIndex += 1) {
        const row = sheet.content[rowIndex];
        if (!Array.isArray(row) || row.length !== header.length) {
            throw new Error(`Deep Clean Shujuku row width is invalid: ${sheetKey}/${rowIndex}`);
        }
        const rowId = String(row[0] ?? '').trim();
        if (!rowId || rowIds.has(rowId)) {
            throw new Error(`Deep Clean Shujuku row_id is invalid: ${sheetKey}/${rowIndex}`);
        }
        rowIds.add(rowId);
    }
}

function assertCanonicalState(state) {
    if (!isRecord(state)) throw new Error('Deep Clean Shujuku replay state is invalid');
    Object.entries(state).forEach(([sheetKey, sheet]) => {
        if (sheetKey.startsWith('sheet_')) assertCanonicalSheet(sheet, sheetKey);
    });
}

function canonicalizeDisplayName(value) {
    return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function toAsciiSlug(value, maxLength = 48) {
    const canonical = canonicalizeDisplayName(value);
    if (!canonical) return '';
    return pinyin(canonical, {
        toneType: 'none',
        traditional: true,
        v: true,
        separator: '_',
        nonZh: 'consecutive',
    }).normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, Math.max(1, maxLength))
        .replace(/_+$/g, '');
}

function physicalTableName(sheet, sheetKey) {
    const displaySlug = toAsciiSlug(sheet?.name).replace(/_/g, '');
    const keySlug = toAsciiSlug(String(sheetKey).replace(/^sheet_/, '')).replace(/_/g, '');
    let candidate = (displaySlug || keySlug || 'sheet').slice(0, 48);
    if (/^[0-9]/.test(candidate) || ['sqlite_', '_acu_'].some((prefix) => candidate.startsWith(prefix))) {
        candidate = `table_${candidate}`;
    }
    return candidate.slice(0, 48) || 'table_sheet';
}

function resolvePhysicalTableNames(state) {
    const result = new Map();
    const owners = new Map();
    Object.keys(state).filter((key) => key.startsWith('sheet_')).sort().forEach((sheetKey) => {
        const name = physicalTableName(state[sheetKey], sheetKey);
        const canonical = name.toLowerCase();
        if (owners.has(canonical)) throw new Error(`Deep Clean Shujuku physical table name collision: ${name}`);
        owners.set(canonical, sheetKey);
        result.set(sheetKey, name);
    });
    return result;
}

function skipSqlTrivia(value, start) {
    let index = start;
    while (index < value.length) {
        if (/\s/.test(value[index])) {
            index += 1;
            continue;
        }
        if (value[index] === '-' && value[index + 1] === '-') {
            index += 2;
            while (index < value.length && value[index] !== '\n' && value[index] !== '\r') index += 1;
            continue;
        }
        if (value[index] === '/' && value[index + 1] === '*') {
            const end = value.indexOf('*/', index + 2);
            return end < 0 ? value.length : skipSqlTrivia(value, end + 2);
        }
        break;
    }
    return index;
}

function consumeSqlKeyword(value, start, keyword) {
    const end = start + keyword.length;
    return value.slice(start, end).toUpperCase() === keyword
        && !/[A-Z0-9_$]/i.test(value[start - 1] || '')
        && !/[A-Z0-9_$]/i.test(value[end] || '')
        ? end
        : -1;
}

function skipSqlIdentifier(value, start) {
    const quote = value[start];
    if (quote === '"' || quote === '`' || quote === '[') {
        const close = quote === '[' ? ']' : quote;
        let index = start + 1;
        while (index < value.length) {
            if (value[index] === close) {
                if (value[index + 1] === close) {
                    index += 2;
                    continue;
                }
                return index + 1;
            }
            index += 1;
        }
        return value.length;
    }
    let index = start;
    while (index < value.length && !/\s|\(/.test(value[index])) index += 1;
    return index;
}

function findCreateTableBounds(value) {
    let index = skipSqlTrivia(value, 0);
    index = consumeSqlKeyword(value, index, 'CREATE');
    if (index < 0) return null;
    index = consumeSqlKeyword(value, skipSqlTrivia(value, index), 'TABLE');
    if (index < 0) return null;
    index = skipSqlTrivia(value, index);
    const afterIf = consumeSqlKeyword(value, index, 'IF');
    if (afterIf >= 0) {
        const afterNot = consumeSqlKeyword(value, skipSqlTrivia(value, afterIf), 'NOT');
        const afterExists = afterNot < 0 ? -1 : consumeSqlKeyword(value, skipSqlTrivia(value, afterNot), 'EXISTS');
        if (afterExists < 0) return null;
        index = skipSqlTrivia(value, afterExists);
    }
    const tableNameStart = index;
    const tableNameEnd = skipSqlIdentifier(value, index);
    if (tableNameEnd <= tableNameStart) return null;
    index = skipSqlTrivia(value, tableNameEnd);
    if (value[index] !== '(') return null;
    const openingIndex = index;
    let depth = 0;
    let quote = null;
    for (; index < value.length; index += 1) {
        const char = value[index];
        if (quote) {
            const close = quote === '[' ? ']' : quote;
            if (char === close) {
                if (value[index + 1] === close) index += 1;
                else quote = null;
            }
            continue;
        }
        if ((char === '-' && value[index + 1] === '-') || (char === '/' && value[index + 1] === '*')) {
            index = skipSqlTrivia(value, index) - 1;
            continue;
        }
        if (char === "'" || char === '"' || char === '`' || char === '[') {
            quote = char;
            continue;
        }
        if (char === '(') depth += 1;
        if (char === ')' && --depth === 0) {
            return { tableNameStart, tableNameEnd, openingIndex, closingIndex: index };
        }
    }
    return null;
}

function normalizeSqlStructure(sql) {
    const replacements = {
        '＝': '=', '＞': '>', '＜': '<', '＋': '+', '－': '-', '＊': '*', '／': '/',
        '（': '(', '）': ')', '，': ',', '；': ';', '\u3000': ' ',
    };
    let result = '';
    let inString = false;
    let inComment = false;
    for (let index = 0; index < String(sql).length; index += 1) {
        const char = String(sql)[index];
        if (inComment) {
            result += char;
            if (char === '\n') inComment = false;
            continue;
        }
        if (inString) {
            result += char;
            if (char === "'") {
                if (String(sql)[index + 1] === "'") result += String(sql)[++index];
                else inString = false;
            }
            continue;
        }
        if (char === "'") inString = true;
        if (char === '-' && String(sql)[index + 1] === '-') inComment = true;
        result += replacements[char] ?? char;
    }
    return result;
}

function splitSqlValueList(value) {
    const values = [];
    let current = '';
    let inString = false;
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (inString) {
            current += char;
            if (char === "'") {
                if (value[index + 1] === "'") current += value[++index];
                else inString = false;
            }
        } else if (char === "'") {
            inString = true;
            current += char;
        } else if (char === ',') {
            values.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    if (current.trim()) values.push(current);
    return values;
}

function normalizeCodeIndexLiteral(value) {
    if (!(value.startsWith("'") && value.endsWith("'") && value.length >= 2)) return value;
    const inner = value.slice(1, -1).replace(/''/g, "'");
    const normalized = inner.trim().normalize('NFKC').toUpperCase();
    return normalized === inner ? value : `'${normalized.replace(/'/g, "''")}'`;
}

function normalizeStatementValues(sql) {
    const insert = sql.match(/^(INSERT\s+INTO\s+\w+\s*)\(([^)]+)\)(\s*VALUES\s*)\((.+)\)\s*;?\s*$/is);
    if (insert) {
        const columns = insert[2].split(',').map((value) => value.trim()).filter(Boolean);
        const values = splitSqlValueList(insert[4]).map((value) => value.trim());
        if (columns.length === values.length) {
            let changed = false;
            const normalized = values.map((value, index) => {
                if (columns[index].toLowerCase() !== 'code_index') return value;
                const next = normalizeCodeIndexLiteral(value);
                changed ||= next !== value;
                return next;
            });
            if (changed) {
                const suffix = sql.trimEnd().endsWith(';') ? ';' : '';
                return `${insert[1]}(${columns.join(', ')})${insert[3]}(${normalized.join(', ')})${suffix}`;
            }
        }
    }
    const update = sql.match(/^(UPDATE\s+\w+\s+SET\s+)(.+?)(\s+WHERE\s+.+)?$/is);
    if (!update) return sql;
    let changed = false;
    const assignments = splitSqlValueList(update[2]).map((assignment) => {
        const match = assignment.match(/^(\s*\w+\s*)=\s*(.+)$/s);
        if (!match || match[1].trim().toLowerCase() !== 'code_index') return assignment;
        const rawValue = match[2].trim();
        const normalized = normalizeCodeIndexLiteral(rawValue);
        if (normalized === rawValue) return assignment;
        changed = true;
        return `${match[1]}= ${normalized}`;
    });
    return changed ? `${update[1]}${assignments.join(', ')}${update[3] || ''}` : sql;
}

function rebindCreateTableName(ddl, tableName) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) throw new Error(`Invalid Shujuku table name: ${tableName}`);
    const normalized = normalizeSqlStructure(String(ddl || ''));
    const bounds = findCreateTableBounds(normalized);
    if (!bounds) throw new Error('Deep Clean Shujuku DDL is not a supported CREATE TABLE statement');
    return `${normalized.slice(0, bounds.tableNameStart)}${tableName}${normalized.slice(bounds.tableNameEnd)}`;
}

function parseDdlColumnComments(ddl) {
    const bounds = findCreateTableBounds(ddl);
    const comments = new Map();
    if (!bounds) return comments;
    ddl.slice(bounds.openingIndex + 1, bounds.closingIndex).split('\n').forEach((line) => {
        const match = line.trim().match(/^([^\s,()]+)\s+.*?--\s*(.+?)\s*,?\s*$/);
        if (match) comments.set(match[1], match[2]);
    });
    return comments;
}

function createTableBody(ddl) {
    const value = String(ddl || '');
    const bounds = findCreateTableBounds(value);
    return bounds ? value.slice(bounds.openingIndex + 1, bounds.closingIndex) : null;
}

function parseDdlTableName(ddl) {
    const value = String(ddl || '');
    const bounds = findCreateTableBounds(value);
    return bounds ? value.slice(bounds.tableNameStart, bounds.tableNameEnd) : null;
}

function splitColumnDefinitions(body) {
    const definitions = [];
    let current = '';
    let depth = 0;
    let inLineComment = false;
    let inBlockComment = false;
    let quote = null;
    for (let index = 0; index < body.length; index += 1) {
        const char = body[index];
        if (quote) {
            current += char;
            const close = quote === '[' ? ']' : quote;
            if (char === close) {
                if (quote !== '[' && body[index + 1] === close) current += body[++index];
                else quote = null;
            }
            continue;
        }
        if (inBlockComment) {
            current += char;
            if (char === '*' && body[index + 1] === '/') {
                current += body[++index];
                inBlockComment = false;
            }
            continue;
        }
        if (char === '/' && body[index + 1] === '*') {
            inBlockComment = true;
            current += char;
            continue;
        }
        if (!inLineComment && char === '-' && body[index + 1] === '-') {
            inLineComment = true;
            current += char;
            continue;
        }
        if (inLineComment && char === '\n') {
            inLineComment = false;
            current += char;
            continue;
        }
        if (inLineComment) {
            current += char;
            continue;
        }
        if (char === "'" || char === '"' || char === '`' || char === '[') {
            quote = char;
            current += char;
        } else if (char === '(') {
            depth += 1;
            current += char;
        } else if (char === ')') {
            depth -= 1;
            current += char;
        } else if (char === ',' && depth === 0) {
            definitions.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    if (current.trim()) definitions.push(current);
    return definitions;
}

function stripSqlLineComments(value) {
    let result = '';
    let quote = null;
    let inBlockComment = false;
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (inBlockComment) {
            if (char === '*' && value[index + 1] === '/') {
                inBlockComment = false;
                index += 1;
            } else if (char === '\n') {
                result += '\n';
            }
            continue;
        }
        if (quote) {
            result += char;
            const close = quote === '[' ? ']' : quote;
            if (char === close) {
                if (quote !== '[' && value[index + 1] === close) result += value[++index];
                else quote = null;
            }
            continue;
        }
        if (char === "'" || char === '"' || char === '`' || char === '[') {
            quote = char;
            result += char;
            continue;
        }
        if (char === '/' && value[index + 1] === '*') {
            inBlockComment = true;
            index += 1;
            continue;
        }
        if (char === '-' && value[index + 1] === '-') {
            while (index < value.length && value[index] !== '\n') index += 1;
            if (index < value.length) result += '\n';
            continue;
        }
        result += char;
    }
    return result;
}

function extractTopLevelSqlTokens(definition) {
    const result = [];
    let current = '';
    let depth = 0;
    let quote = null;
    let inBlockComment = false;
    const flush = () => {
        if (current) result.push(current.toUpperCase());
        current = '';
    };
    for (let index = 0; index < definition.length; index += 1) {
        const char = definition[index];
        if (inBlockComment) {
            if (char === '*' && definition[index + 1] === '/') {
                inBlockComment = false;
                index += 1;
            }
            continue;
        }
        if (quote) {
            const close = quote === '[' ? ']' : quote;
            if (char === close) {
                if (quote !== '[' && definition[index + 1] === close) index += 1;
                else quote = null;
            }
            continue;
        }
        if (char === "'" || char === '"' || char === '`' || char === '[') {
            flush();
            quote = char;
        } else if (char === '/' && definition[index + 1] === '*') {
            flush();
            inBlockComment = true;
            index += 1;
        } else if (char === '(') {
            flush();
            depth += 1;
        } else if (char === ')') {
            flush();
            depth = Math.max(0, depth - 1);
        } else if (depth === 0 && /[A-Za-z0-9_]/.test(char)) {
            current += char;
        } else {
            flush();
        }
    }
    flush();
    return result;
}

function consumeDefaultLiteralToken(value, start) {
    if (value[start] === "'") {
        let index = start + 1;
        while (index < value.length) {
            if (value[index] === "'") {
                if (value[index + 1] === "'") {
                    index += 2;
                    continue;
                }
                return value.slice(start, index + 1);
            }
            index += 1;
        }
        return null;
    }
    const blob = value.slice(start).match(/^X'(?:[0-9A-F]{2})*'/i);
    if (blob) return blob[0];
    return value.slice(start).match(/^(?:NULL|TRUE|FALSE|[+-]?(?:\d+\.\d*|\d*\.\d+|\d+)(?:[eE][+-]?\d+)?)/i)?.[0] || null;
}

function extractDdlDefaultExpression(definition) {
    const value = stripSqlLineComments(definition);
    let quote = null;
    let depth = 0;
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (quote) {
            const close = quote === '[' ? ']' : quote;
            if (char === close) {
                if (quote !== '[' && value[index + 1] === close) index += 1;
                else quote = null;
            }
            continue;
        }
        if (char === "'" || char === '"' || char === '`' || char === '[') {
            quote = char;
            continue;
        }
        if (char === '(') {
            depth += 1;
            continue;
        }
        if (char === ')') {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth !== 0 || value.slice(index, index + 7).toUpperCase() !== 'DEFAULT') continue;
        if (/[A-Z0-9_$]/i.test(value[index - 1] || '') || /[A-Z0-9_$]/i.test(value[index + 7] || '')) continue;
        const start = skipSqlTrivia(value, index + 7);
        return consumeDefaultLiteralToken(value, start) || value.slice(start).trim() || null;
    }
    return null;
}

function parseDdlColumnInfos(ddl) {
    const body = createTableBody(ddl);
    if (body === null) return [];
    const comments = parseDdlColumnComments(ddl);
    return splitColumnDefinitions(body).flatMap((rawDefinition) => {
        const definition = stripSqlLineComments(rawDefinition).trim();
        if (!definition || /^(?:PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(definition)) return [];
        const match = definition.match(/^([^\s,()]+)/);
        if (!match) return [];
        const sqlName = match[1];
        const tokens = extractTopLevelSqlTokens(definition);
        const defaultExpression = extractDdlDefaultExpression(definition);
        return [{
            sqlName,
            declaredType: tokens[1] || null,
            comment: comments.get(sqlName)?.trim() || null,
            normalizedDefinition: definition.replace(/\s+/g, ' ').trim(),
            isPrimaryKey: tokens.some((token, index) => token === 'PRIMARY' && tokens[index + 1] === 'KEY'),
            isNotNull: tokens.some((token, index) => token === 'NOT' && tokens[index + 1] === 'NULL'),
            hasDefault: defaultExpression !== null,
            defaultExpression,
        }];
    }).map((column, index) => ({ ...column, index }));
}

function parseDdlTableConstraints(ddl) {
    const body = createTableBody(ddl);
    if (body === null) return [];
    return splitColumnDefinitions(body)
        .map((definition) => stripSqlLineComments(definition).replace(/\s+/g, ' ').trim())
        .filter((definition) => /^(?:PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK|CONSTRAINT)\b/i.test(definition));
}

function parseDdlTableSuffix(ddl) {
    const value = String(ddl || '');
    const bounds = findCreateTableBounds(value);
    return bounds
        ? stripSqlLineComments(value.slice(bounds.closingIndex + 1)).replace(/;\s*$/, '').replace(/\s+/g, ' ').trim()
        : '';
}

function parseSafeDefaultLiteral(expression) {
    const value = String(expression || '').trim();
    if (!value) return null;
    if (/^NULL$/i.test(value)) return { kind: 'null', sql: 'NULL', value: null };
    if (/^TRUE$/i.test(value)) return { kind: 'boolean', sql: 'TRUE', value: true };
    if (/^FALSE$/i.test(value)) return { kind: 'boolean', sql: 'FALSE', value: false };
    if (/^X'(?:[0-9A-F]{2})*'$/i.test(value)) return { kind: 'blob', sql: value.toUpperCase(), value: value.slice(2, -1).toUpperCase() };
    if (/^[+-]?\d+$/.test(value)) {
        const numeric = Number(value);
        return Number.isSafeInteger(numeric) ? { kind: 'integer', sql: value, value: numeric } : null;
    }
    if (/^[+-]?(?:\d+\.\d*|\d*\.\d+)(?:[eE][+-]?\d+)?$|^[+-]?\d+[eE][+-]?\d+$/.test(value)) {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? { kind: 'real', sql: value, value: numeric } : null;
    }
    if (value.startsWith("'") && value.endsWith("'")) {
        const inner = value.slice(1, -1);
        if (!/(^|[^'])'(?!')/.test(inner)) return { kind: 'string', sql: value, value: inner.replace(/''/g, "'") };
    }
    return null;
}

function quoteIdentifier(value) {
    return `"${String(value).replace(/"/g, '""')}"`;
}

function query(db, sql) {
    const results = db.exec(sql);
    return results.length > 0 ? results[0] : { columns: [], values: [] };
}

function tableInfo(db, tableName) {
    const result = query(db, `PRAGMA table_info(${quoteIdentifier(tableName)});`);
    return result.values.map((row) => ({
        name: String(row[1]),
        declaredType: String(row[2]),
        notNull: Number(row[3]) === 1,
        defaultValue: row[4],
        primaryKey: Number(row[5]) > 0,
    }));
}

function matchesHeader(columnName, comment, header) {
    return !!header && (header === columnName || (columnName === 'row_id' && header === '行号') || (!!comment && header === comment));
}

function createInsertPlan(sheet, schema, comments) {
    const headers = sheet.content[0].map((header) => String(header ?? '').trim());
    const nonEmptyHeaders = headers.filter(Boolean);
    if (new Set(nonEmptyHeaders).size !== nonEmptyHeaders.length) {
        throw new Error('Deep Clean Shujuku snapshot contains duplicate headers');
    }
    const mappings = [];
    const usedIndexes = new Set();
    schema.forEach((column) => {
        const candidates = headers
            .map((header, index) => ({ header, index }))
            .filter(({ header }) => matchesHeader(column.name, comments.get(column.name), header));
        if (candidates.length > 1) throw new Error(`Deep Clean Shujuku DDL column is ambiguous: ${column.name}`);
        if (candidates.length === 1) {
            const sourceIndex = candidates[0].index;
            if (usedIndexes.has(sourceIndex)) throw new Error(`Deep Clean Shujuku header is reused: ${headers[sourceIndex]}`);
            usedIndexes.add(sourceIndex);
            mappings.push({ column, sourceIndex });
        } else if (column.primaryKey || (column.notNull && column.defaultValue === null)) {
            throw new Error(`Deep Clean Shujuku required DDL column is missing: ${column.name}`);
        }
    });
    headers.forEach((header, sourceIndex) => {
        if (usedIndexes.has(sourceIndex)) return;
        const hasBusinessValue = sheet.content.slice(1).some((row) => row[sourceIndex] !== null && row[sourceIndex] !== undefined && row[sourceIndex] !== '');
        if (hasBusinessValue) throw new Error(`Deep Clean Shujuku header has no DDL column: ${header}`);
    });
    return mappings;
}

function sqlLiteral(value, columnName) {
    if (value === null || value === undefined) return 'NULL';
    let text = String(value);
    if (columnName.toLowerCase() === 'code_index') text = text.trim().normalize('NFKC').toUpperCase();
    if (/^-?\d+(\.\d+)?$/.test(text)) return text;
    return `'${text.replace(/'/g, "''")}'`;
}

function hydrateState(SQL, state) {
    assertCanonicalState(state);
    const db = new SQL.Database();
    db.run('PRAGMA foreign_keys = ON;');
    db.run(META_TABLE_DDL);
    const physicalNames = resolvePhysicalTableNames(state);
    const sheets = new Map();
    try {
        Object.keys(state).filter((sheetKey) => sheetKey.startsWith('sheet_')).forEach((sheetKey) => {
            const sheet = state[sheetKey];
            const tableName = physicalNames.get(sheetKey);
            const ddl = rebindCreateTableName(sheet?.sourceData?.ddl, tableName);
            db.run(ddl);
            const schema = tableInfo(db, tableName);
            if (schema.length === 0 || schema[0].name !== 'row_id'
                || schema[0].declaredType.toUpperCase() !== 'INTEGER' || !schema[0].primaryKey) {
                throw new Error(`Deep Clean Shujuku DDL has no row_id primary key: ${sheetKey}`);
            }
            const comments = parseDdlColumnComments(normalizeSqlStructure(String(sheet.sourceData.ddl || '')));
            const insertPlan = createInsertPlan(sheet, schema, comments);
            for (const row of sheet.content.slice(1)) {
                const columns = insertPlan.map(({ column }) => quoteIdentifier(column.name)).join(', ');
                const values = insertPlan.map(({ column, sourceIndex }) => sqlLiteral(row[sourceIndex], column.name)).join(', ');
                db.run(`INSERT INTO ${quoteIdentifier(tableName)} (${columns}) VALUES (${values});`);
            }
            db.run(
                `INSERT OR REPLACE INTO ${META_TABLE_NAME} (
                    sheet_key, uid, name, order_no, source_data_json,
                    update_config_json, export_config_json, physical_table_name
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
                [
                    sheetKey,
                    sheet.uid || sheetKey,
                    sheet.name || sheetKey,
                    sheet.orderNo ?? 0,
                    JSON.stringify(sheet.sourceData || {}),
                    JSON.stringify(sheet.updateConfig || {}),
                    JSON.stringify(sheet.exportConfig || {}),
                    tableName,
                ],
            );
            sheets.set(sheetKey, { tableName, schema });
        });
        return { db, sheets };
    } catch (error) {
        db.close();
        throw error;
    }
}

function sqliteValueToCell(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Uint8Array) return '[BLOB]';
    return String(value);
}

function parseMetadataJson(value, fieldName) {
    try {
        const parsed = JSON.parse(String(value ?? '{}'));
        if (!isRecord(parsed)) throw new Error();
        return parsed;
    } catch {
        throw new Error(`Deep Clean Shujuku SQL metadata is invalid: ${fieldName}`);
    }
}

function materializeRuntime(runtime, state) {
    if (!runtime) return state;
    try {
        const metaResult = query(runtime.db, `SELECT * FROM ${META_TABLE_NAME};`);
        const metaColumnIndexes = new Map(metaResult.columns.map((name, index) => [name, index]));
        const metadataRows = metaResult.values.map((row) => {
            const at = (name) => metaColumnIndexes.has(name) ? row[metaColumnIndexes.get(name)] : null;
            return {
                sheetKey: String(at('sheet_key')),
                uid: String(at('uid')),
                name: String(at('name')),
                orderNo: Number(at('order_no')) || 0,
                sourceData: parseMetadataJson(at('source_data_json'), 'source_data_json'),
                updateConfig: parseMetadataJson(at('update_config_json'), 'update_config_json'),
                exportConfig: parseMetadataJson(at('export_config_json'), 'export_config_json'),
                physicalTableName: at('physical_table_name') == null ? '' : String(at('physical_table_name')),
            };
        });
        const metadataState = { mate: {} };
        metadataRows.forEach((metadata) => {
            metadataState[metadata.sheetKey] = {
                uid: metadata.uid,
                name: metadata.name,
                sourceData: metadata.sourceData,
                content: [],
            };
        });
        let currentPhysicalNames = null;
        try {
            currentPhysicalNames = resolvePhysicalTableNames(metadataState);
        } catch {
            // Match Shujuku's strict export lookup: a current-name resolution
            // failure still permits the persisted physical and DDL identities.
        }
        const findMetadata = (tableName) => {
            const stored = metadataRows.find((metadata) => metadata.physicalTableName === tableName);
            if (stored) return stored;
            const current = currentPhysicalNames
                ? metadataRows.find((metadata) => currentPhysicalNames.get(metadata.sheetKey) === tableName)
                : null;
            if (current) return current;
            const ddlMatches = metadataRows.filter((metadata) => parseDdlTableName(String(metadata.sourceData?.ddl || '')) === tableName);
            return ddlMatches.length === 1 ? ddlMatches[0] : null;
        };
        const tableNames = query(runtime.db, `SELECT name FROM sqlite_master
            WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '${META_TABLE_NAME}' ORDER BY rowid;`)
            .values.map((row) => String(row[0]));
        const next = Object.prototype.hasOwnProperty.call(state, 'mate') ? { mate: cloneJson(state.mate) } : {};
        tableNames.forEach((tableName) => {
            const metadata = findMetadata(tableName);
            if (!metadata || !metadata.sheetKey.startsWith('sheet_')) {
                throw new Error(`Deep Clean Shujuku SQL created an unowned table: ${tableName}`);
            }
            const result = query(runtime.db, `SELECT * FROM ${quoteIdentifier(tableName)};`);
            const ddlResult = query(runtime.db, `SELECT sql FROM sqlite_master WHERE type='table' AND name=${sqlLiteral(tableName, 'name')};`);
            const ddl = String(ddlResult.values[0]?.[0] || '');
            const comments = parseDdlColumnComments(ddl);
            const columns = result.columns.length > 0
                ? result.columns
                : tableInfo(runtime.db, tableName).map((column) => column.name);
            const header = columns.map((column) => column === 'row_id' ? 'row_id' : (comments.get(column) || column));
            next[metadata.sheetKey] = {
                uid: metadata.uid,
                name: metadata.name,
                orderNo: metadata.orderNo,
                sourceData: metadata.sourceData,
                updateConfig: metadata.updateConfig,
                exportConfig: metadata.exportConfig,
                content: [header, ...result.values.map((row) => row.map(sqliteValueToCell))],
            };
        });
        assertCanonicalState(next);
        return next;
    } finally {
        runtime.db.close();
    }
}

async function createSqlRuntime(state) {
    const SQL = await initSqlJs({
        locateFile: () => new URL('../../../vendor/sql.js/sql-wasm.wasm', import.meta.url).href,
    });
    return hydrateState(SQL, state);
}

function splitSqlStatements(sql) {
    const statements = [];
    let current = '';
    let inString = false;
    let stringChar = '';
    const input = String(sql || '').replace(/<!--|-->/g, '').trim();
    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];
        if (inString) {
            current += char;
            if (char === stringChar) {
                if (input[index + 1] === stringChar) current += input[++index];
                else inString = false;
            }
        } else if (char === "'" || char === '"') {
            inString = true;
            stringChar = char;
            current += char;
        } else if (char === ';') {
            if (current.trim()) statements.push(normalizeStatementValues(normalizeSqlStructure(current.trim())));
            current = '';
        } else {
            current += char;
        }
    }
    if (current.trim()) statements.push(normalizeStatementValues(normalizeSqlStructure(current.trim())));
    return statements;
}

function decodeSqlIdentifier(value) {
    const text = String(value || '').trim();
    if (text.length >= 2 && ((text[0] === '"' && text.at(-1) === '"') || (text[0] === '`' && text.at(-1) === '`'))) {
        return text.slice(1, -1).split(text[0] + text[0]).join(text[0]);
    }
    if (text.length >= 2 && text[0] === '[' && text.at(-1) === ']') return text.slice(1, -1).split(']]').join(']');
    return text;
}

function sqlWordStart(char) {
    return /^[A-Za-z_\u0080-\uFFFF]$/.test(char);
}

function sqlWordPart(char) {
    return /^[A-Za-z0-9_$\u0080-\uFFFF]$/.test(char);
}

function tokenizeMutationSql(sql) {
    const tokens = [];
    let index = 0;
    let depth = 0;
    const commaDepths = new Set();
    while (index < sql.length) {
        const char = sql[index];
        const next = sql[index + 1];
        if (char === '-' && next === '-') {
            index += 2;
            while (index < sql.length && sql[index] !== '\n' && sql[index] !== '\r') index += 1;
        } else if (char === '/' && next === '*') {
            const end = sql.indexOf('*/', index + 2);
            if (end < 0) throw new Error('Deep Clean SQL has an unterminated comment');
            index = end + 2;
        } else if (char === "'") {
            index += 1;
            while (index < sql.length) {
                if (sql[index] !== "'") index += 1;
                else if (sql[index + 1] === "'") index += 2;
                else {
                    index += 1;
                    break;
                }
            }
            if (sql[index - 1] !== "'") throw new Error('Deep Clean SQL has an unterminated string');
        } else if (char === ',') {
            commaDepths.add(depth);
            index += 1;
        } else if (char === '(') {
            commaDepths.delete(depth);
            depth += 1;
            index += 1;
        } else if (char === ')') {
            depth = Math.max(0, depth - 1);
            index += 1;
        } else if (char === '"' || char === '`' || char === '[') {
            const quote = char;
            const close = quote === '[' ? ']' : quote;
            const start = index;
            let value = '';
            let closed = false;
            index += 1;
            while (index < sql.length) {
                if (sql[index] !== close) value += sql[index++];
                else if (sql[index + 1] === close) {
                    value += close;
                    index += 2;
                } else {
                    index += 1;
                    closed = true;
                    break;
                }
            }
            if (!closed) throw new Error('Deep Clean SQL has an unterminated quoted identifier');
            tokens.push({ start, end: index, value, quote, depth, commaBefore: commaDepths.delete(depth) });
        } else if (sqlWordStart(char)) {
            const start = index;
            index += 1;
            while (index < sql.length && sqlWordPart(sql[index])) index += 1;
            tokens.push({ start, end: index, value: sql.slice(start, index), quote: null, depth, commaBefore: commaDepths.delete(depth) });
        } else {
            index += 1;
        }
    }
    return tokens;
}

function isSqlKeyword(token, value) {
    return !!token && token.quote === null && token.value.toUpperCase() === value;
}

function qualifiedSqlTail(sql, tokens, start) {
    let token = tokens[start];
    if (!token) return undefined;
    let index = start;
    while (tokens[index + 1] && tokens[index + 1].depth === token.depth
        && /^\s*\.\s*$/.test(sql.slice(token.end, tokens[index + 1].start))) {
        token = tokens[++index];
    }
    return token;
}

function mutationTarget(sql, tokens) {
    const first = tokens[0];
    const actionIndex = isSqlKeyword(first, 'WITH')
        ? tokens.findIndex((token, index) => index > 0 && token.depth === 0
            && ['INSERT', 'REPLACE', 'UPDATE', 'DELETE'].includes(token.value.toUpperCase()))
        : 0;
    const action = tokens[actionIndex];
    if (!action) return undefined;
    if (isSqlKeyword(action, 'INSERT') || isSqlKeyword(action, 'REPLACE')) {
        let index = actionIndex + 1;
        if (isSqlKeyword(action, 'INSERT') && isSqlKeyword(tokens[index], 'OR')) index += 2;
        return isSqlKeyword(tokens[index], 'INTO') ? qualifiedSqlTail(sql, tokens, index + 1) : undefined;
    }
    if (isSqlKeyword(action, 'UPDATE')) {
        let index = actionIndex + 1;
        if (isSqlKeyword(tokens[index], 'OR')) index += 2;
        return qualifiedSqlTail(sql, tokens, index);
    }
    return isSqlKeyword(action, 'DELETE') && isSqlKeyword(tokens[actionIndex + 1], 'FROM')
        ? qualifiedSqlTail(sql, tokens, actionIndex + 2)
        : undefined;
}

function cteScopes(tokens) {
    const result = [];
    for (let withIndex = 0; withIndex < tokens.length; withIndex += 1) {
        const withToken = tokens[withIndex];
        if (!isSqlKeyword(withToken, 'WITH')) continue;
        const depth = withToken.depth;
        let index = withIndex + 1;
        if (isSqlKeyword(tokens[index], 'RECURSIVE')) index += 1;
        const names = [];
        let valid = false;
        while (tokens[index]) {
            const name = tokens[index];
            if (name.depth !== depth) break;
            index += 1;
            if (tokens[index]?.depth === depth + 1) {
                const columnDepth = tokens[index].depth;
                while (tokens[index] && tokens[index].depth >= columnDepth) index += 1;
            }
            if (!isSqlKeyword(tokens[index], 'AS')) break;
            names.push(name.value.toLowerCase());
            index += 1;
            if (!tokens[index] || tokens[index].depth !== depth + 1) break;
            const definitionDepth = tokens[index].depth;
            while (tokens[index] && tokens[index].depth >= definitionDepth) index += 1;
            valid = true;
            if (!tokens[index]?.commaBefore || tokens[index].depth !== depth) break;
        }
        if (!valid) continue;
        const end = tokens.findIndex((token, tokenIndex) => tokenIndex > index && token.depth < depth);
        names.forEach((name) => result.push({ name, depth, start: withIndex, end: end < 0 ? tokens.length : end }));
    }
    return result;
}

function isCteReference(tokens, token, scopes) {
    const index = tokens.indexOf(token);
    return index >= 0 && scopes.some((scope) => (
        scope.name === token.value.toLowerCase()
        && index >= scope.start && index < scope.end && token.depth >= scope.depth
    ));
}

function mutationTableReferences(sql, tokens, target) {
    const result = new Map([[target.start, target]]);
    const scopes = cteScopes(tokens);
    const terminators = new Set(['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION', 'EXCEPT', 'INTERSECT', 'WINDOW', 'RETURNING', 'VALUES', 'SET']);
    const fromDepths = new Set();
    tokens.forEach((token, index) => {
        const value = token.quote === null ? token.value.toUpperCase() : '';
        if (terminators.has(value)) fromDepths.delete(token.depth);
        if (value === 'FROM') fromDepths.add(token.depth);
        if (value === 'FROM' || value === 'JOIN') {
            const reference = qualifiedSqlTail(sql, tokens, index + 1);
            if (reference && reference.depth === token.depth && !isCteReference(tokens, reference, scopes)) {
                result.set(reference.start, reference);
            }
        } else if (token.commaBefore && fromDepths.has(token.depth) && !isCteReference(tokens, token, scopes)) {
            result.set(token.start, token);
        }
    });
    return [...result.values()];
}

function formatSqlIdentifier(value, quote) {
    if (quote === '"') return `"${value.replace(/"/g, '""')}"`;
    if (quote === '`') return `\`${value.replace(/`/g, '``')}\``;
    if (quote === '[') return `[${value.replace(/]/g, ']]')}]`;
    return value;
}

function rebindMutationTables(statements, aliases, ambiguousAliases) {
    const resolved = new Map([...aliases].map(([alias, physicalName]) => [decodeSqlIdentifier(alias).toLowerCase(), physicalName]));
    const ambiguous = new Set([...ambiguousAliases].map((alias) => decodeSqlIdentifier(alias).toLowerCase()));
    return statements.map((statement) => {
        try {
            const tokens = tokenizeMutationSql(statement);
            const target = mutationTarget(statement, tokens);
            if (!target) return statement;
            const references = mutationTableReferences(statement, tokens, target);
            if (references.some((reference) => ambiguous.has(reference.value.toLowerCase()))) {
                throw new Error(`Deep Clean SQL references an ambiguous table alias: ${target.value}`);
            }
            if (!resolved.has(target.value.toLowerCase())) return statement;
            const replacements = references
                .map((token) => ({ token, name: resolved.get(token.value.toLowerCase()) }))
                .filter((item) => !!item.name)
                .sort((left, right) => right.token.start - left.token.start);
            return replacements.reduce((result, { token, name }) => (
                `${result.slice(0, token.start)}${formatSqlIdentifier(name, token.quote)}${result.slice(token.end)}`
            ), statement);
        } catch {
            return statement;
        }
    });
}

const SQL_RESERVED_IDENTIFIERS = new Set([
    'abort', 'action', 'add', 'after', 'all', 'alter', 'analyze', 'and', 'as', 'asc', 'attach',
    'autoincrement', 'before', 'begin', 'between', 'by', 'cascade', 'case', 'cast', 'check',
    'collate', 'column', 'commit', 'conflict', 'constraint', 'create', 'cross', 'current_date',
    'current', 'current_time', 'current_timestamp', 'database', 'default', 'deferrable', 'deferred', 'delete',
    'desc', 'detach', 'distinct', 'drop', 'each', 'else', 'end', 'escape', 'except', 'exclude',
    'exclusive', 'exists', 'explain', 'fail', 'filter', 'first', 'following', 'for', 'foreign',
    'from', 'full', 'generated', 'glob', 'group', 'groups', 'having', 'if', 'ignore', 'immediate', 'in',
    'index', 'indexed', 'initially', 'inner', 'insert', 'instead', 'intersect', 'into', 'is',
    'isnull', 'join', 'key', 'last', 'left', 'like', 'limit', 'match', 'materialized', 'natural', 'no', 'not',
    'nothing', 'notnull', 'null', 'nulls', 'of', 'offset', 'on', 'or', 'order', 'others', 'outer',
    'over', 'partition', 'plan', 'pragma', 'preceding', 'primary', 'query', 'raise', 'range',
    'recursive', 'references', 'regexp', 'reindex', 'release', 'rename', 'replace', 'restrict',
    'returning', 'right', 'rollback', 'row', 'rowid', 'rows', 'savepoint', 'select', 'set', 'table', 'temp',
    'temporary', 'then', 'ties', 'to', 'transaction', 'trigger', 'unbounded', 'union', 'unique',
    'update', 'using', 'vacuum', 'values', 'view', 'virtual', 'when', 'where', 'window', 'with', 'without',
]);

function mapSqlColumnIdentifiers(headers) {
    const used = new Set();
    return headers.map((header, index) => {
        const canonical = canonicalizeDisplayName(header);
        const isRowId = index === 0 && (canonical === 'row_id' || header == null);
        let base = isRowId ? 'row_id' : toAsciiSlug(String(header ?? '').normalize('NFKC').trim());
        base = base.replace(/^\d+/, (value) => `col_${value}`) || `col_${index + 1}`;
        if (!isRowId && (base === 'row_id' || SQL_RESERVED_IDENTIFIERS.has(base))) base = `col_${base}`;
        let sqlName = base;
        let suffix = 2;
        while (used.has(sqlName.toLowerCase())) sqlName = `${base}_${suffix++}`;
        used.add(sqlName.toLowerCase());
        return { index, sqlName, isRowId };
    });
}

function buildReplayTableAliases(state, operation) {
    const physicalNames = resolvePhysicalTableNames(state);
    const aliases = new Map();
    const conflicts = new Set();
    const addAlias = (rawAlias, physicalName) => {
        const alias = canonicalizeDisplayName(decodeSqlIdentifier(rawAlias));
        if (!alias || conflicts.has(alias)) return;
        const existing = aliases.get(alias);
        if (existing && existing !== physicalName) {
            aliases.delete(alias);
            conflicts.add(alias);
        } else {
            aliases.set(alias, physicalName);
        }
    };
    physicalNames.forEach((physicalName, sheetKey) => {
        const sheet = state[sheetKey];
        const declaredAliases = Array.isArray(sheet?.sourceData?.tableAliases) ? sheet.sourceData.tableAliases : [];
        [parseDdlTableName(String(sheet?.sourceData?.ddl || '')), physicalName, ...declaredAliases,
            sheetKey, sheet?.uid, sheet?.name].forEach((alias) => addAlias(alias, physicalName));
        const shortKey = sheetKey.slice('sheet_'.length);
        if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(shortKey)) addAlias(shortKey, physicalName);
    });
    if (operation.kind === 'sql_sheet_batch') {
        let target = null;
        if (state[operation.sheetKey]) {
            target = physicalNames.get(operation.sheetKey);
            const historical = canonicalizeDisplayName(decodeSqlIdentifier(operation.tableName));
            const occupied = aliases.get(historical);
            if (historical && occupied && occupied !== target) {
                throw new Error(`Deep Clean sql_sheet_batch historical table name conflicts with another sheet: ${operation.tableName}`);
            }
        } else {
            target = aliases.get(canonicalizeDisplayName(decodeSqlIdentifier(operation.tableName))) || null;
        }
        if (target) addAlias(operation.tableName, target);
    }
    return { aliases, conflicts, physicalNames };
}

function buildReplayColumnAliases(state, sheetKey, physicalNames) {
    const sheet = state[sheetKey];
    const physicalName = physicalNames.get(sheetKey);
    const columns = new Map();
    const conflicts = new Set();
    const add = (source, target) => {
        const sourceKey = String(source).toLowerCase();
        const targetKey = String(target).toLowerCase();
        if (!sourceKey || sourceKey === targetKey || conflicts.has(sourceKey)) return;
        const existing = columns.get(sourceKey);
        if (existing && existing.toLowerCase() !== targetKey) {
            if (columns.get(existing.toLowerCase()) === existing) columns.delete(existing.toLowerCase());
            columns.delete(sourceKey);
            conflicts.add(sourceKey);
        } else if (!existing) {
            columns.set(sourceKey, target);
        }
    };
    const headers = sheet.content[0].map((header) => String(header ?? ''));
    const ddlColumns = parseDdlColumnInfos(String(sheet.sourceData?.ddl || ''));
    if (ddlColumns.length !== headers.length) throw new Error(`Deep Clean sql_sheet_batch DDL/header mismatch: ${sheetKey}`);
    ddlColumns.forEach((column, index) => {
        if (!matchesHeader(column.sqlName, column.comment, headers[index].trim())) {
            throw new Error(`Deep Clean sql_sheet_batch column mapping mismatch: ${column.sqlName}`);
        }
        columns.set(column.sqlName.toLowerCase(), column.sqlName);
        add(headers[index], column.sqlName);
    });
    const targetByIndex = new Map(ddlColumns.map((column, index) => [index, column.sqlName]));
    mapSqlColumnIdentifiers(headers).forEach((mapping) => {
        const target = targetByIndex.get(mapping.index);
        if (target) add(mapping.sqlName, target);
    });
    return {
        aliases: new Map([[physicalName, columns]]),
        conflicts: new Map([[physicalName, conflicts]]),
    };
}

const MUTATION_COLUMN_KEYWORDS = new Set([
    'SELECT', 'FROM', 'JOIN', 'AS', 'ON', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET',
    'UNION', 'EXCEPT', 'INTERSECT', 'WITH', 'RECURSIVE', 'DISTINCT', 'BY', 'AND', 'OR', 'NOT',
    'IN', 'IS', 'NULL', 'LIKE', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC',
    'COLLATE', 'USING',
]);

function isSqlFunctionCall(sql, token) {
    return /^\s*\(/.test(sql.slice(token.end));
}

function collectMutationColumnReplacements(sql, tokens, aliases, ambiguous) {
    const replacements = [];
    const handled = new Set();
    const add = (token) => {
        if (!token) return;
        const key = decodeSqlIdentifier(token.value).toLowerCase();
        if (ambiguous.has(key)) throw new Error(`Deep Clean SQL references an ambiguous column alias: ${token.value}`);
        const target = aliases.get(key);
        if (!target || target.toLowerCase() === key || handled.has(token.start)) return;
        handled.add(token.start);
        replacements.push({ token, value: target });
    };
    const first = tokens[0];
    const actionIndex = isSqlKeyword(first, 'WITH')
        ? tokens.findIndex((token, index) => index > 0 && token.depth === 0
            && ['INSERT', 'REPLACE', 'UPDATE', 'DELETE'].includes(token.value.toUpperCase()))
        : 0;
    const action = tokens[actionIndex];
    if (!action) return replacements;
    const actionValue = action.value.toUpperCase();
    const actionDepth = action.depth;
    if (actionValue === 'UPDATE') {
        let setIndex = -1;
        for (let index = actionIndex + 1; index < tokens.length; index += 1) {
            const token = tokens[index];
            if (token.depth !== actionDepth) continue;
            if (isSqlKeyword(token, 'SET')) {
                setIndex = index;
                break;
            }
            if (['WHERE', 'GROUP', 'ORDER', 'LIMIT'].includes(token.value.toUpperCase())) break;
        }
        if (setIndex >= 0) {
            for (let index = setIndex + 1; index < tokens.length; index += 1) {
                const token = tokens[index];
                if (token.depth !== actionDepth) continue;
                if (['WHERE', 'GROUP', 'ORDER', 'LIMIT', 'RETURNING'].includes(token.value.toUpperCase())) break;
                const next = tokens[index + 1];
                if (next && next.depth === token.depth && /=/.test(sql.slice(token.end, next.start))) add(token);
            }
        }
    } else if (actionValue === 'INSERT' || actionValue === 'REPLACE') {
        const openIndex = tokens.findIndex((token) => token.depth === actionDepth + 1 && token.start > action.start);
        if (openIndex >= 0) {
            let cursor = openIndex + 1;
            while (cursor < tokens.length && tokens[cursor].depth >= actionDepth + 1) {
                if (tokens[cursor].depth === actionDepth + 1) add(tokens[cursor]);
                cursor += 1;
            }
        }
    }
    tokens.forEach((token, index) => {
        if (token.quote !== null || MUTATION_COLUMN_KEYWORDS.has(token.value.toUpperCase()) || isSqlFunctionCall(sql, token)) return;
        const previous = tokens[index - 1];
        if (previous && previous.depth === token.depth && isSqlKeyword(previous, 'AS')) return;
        if (previous && previous.depth === token.depth && /^\s*\.\s*$/.test(sql.slice(previous.end, token.start))) return;
        add(token);
    });
    return replacements;
}

function rebindMutationColumns(statements, columnAliases, targetPhysicalName, ambiguousColumns) {
    const tableKey = decodeSqlIdentifier(targetPhysicalName).toLowerCase();
    const aliases = new Map();
    for (const [alias, physicalName] of columnAliases.get(tableKey) || []) {
        aliases.set(decodeSqlIdentifier(alias).toLowerCase(), physicalName);
    }
    const ambiguous = new Set([...(ambiguousColumns || [])].map((alias) => decodeSqlIdentifier(alias).toLowerCase()));
    return statements.map((statement) => {
        const tokens = tokenizeMutationSql(statement);
        const target = mutationTarget(statement, tokens);
        if (!target || decodeSqlIdentifier(target.value).toLowerCase() !== tableKey) return statement;
        if (tokens.some((token) => isSqlKeyword(token, 'SELECT'))) return statement;
        if (mutationTableReferences(statement, tokens, target).length > 1) {
            throw new Error('Deep Clean sql_sheet_batch column rebinding cannot prove cross-table column ownership');
        }
        const replacements = collectMutationColumnReplacements(statement, tokens, aliases, ambiguous)
            .sort((left, right) => right.token.start - left.token.start);
        return replacements.reduce((result, { token, value }) => (
            `${result.slice(0, token.start)}${formatSqlIdentifier(value, token.quote)}${result.slice(token.end)}`
        ), statement);
    });
}

function prepareSqlStatements(state, operation) {
    const statements = operation.statements.flatMap(splitSqlStatements);
    if (statements.length === 0) return statements;
    const { aliases, conflicts, physicalNames } = buildReplayTableAliases(state, operation);
    const tableRebound = rebindMutationTables(statements, aliases, conflicts);
    if (operation.kind !== 'sql_sheet_batch' || !state[operation.sheetKey]) return tableRebound;
    const targetPhysicalName = physicalNames.get(operation.sheetKey);
    const columnRegistry = buildReplayColumnAliases(state, operation.sheetKey, physicalNames);
    const normalizedAliases = new Map([...columnRegistry.aliases].map(([tableName, columns]) => [tableName.toLowerCase(), columns]));
    return rebindMutationColumns(
        tableRebound,
        normalizedAliases,
        targetPhysicalName,
        columnRegistry.conflicts.get(targetPhysicalName),
    );
}

function runSqlOperation(runtime, state, operation) {
    const statements = prepareSqlStatements(state, operation);
    if (statements.length === 0) return;
    const params = Array.isArray(operation.params) ? operation.params : [];
    runtime.db.run('BEGIN TRANSACTION;');
    try {
        statements.forEach((statement, index) => runtime.db.run(statement, params[index]));
        runtime.db.run('COMMIT;');
    } catch (error) {
        try {
            runtime.db.run('ROLLBACK;');
        } catch {
            // The original SQL error is authoritative.
        }
        throw error;
    }
}

const P1_COLUMN_CONSTRAINT_TOKENS = new Set([
    'AS', 'CHECK', 'COLLATE', 'CONSTRAINT', 'DEFAULT', 'FOREIGN',
    'GENERATED', 'NOT', 'PRIMARY', 'REFERENCES', 'UNIQUE',
]);

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

async function sha256(value) {
    if (!globalThis.crypto?.subtle) throw new Error('Deep Clean schema migration requires Web Crypto SHA-256');
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return `sha256:${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function requireSheetShape(sheet, phase) {
    const rawHeaders = sheet?.content?.[0];
    if (!Array.isArray(rawHeaders) || rawHeaders[0] !== 'row_id') {
        throw new Error(`Deep Clean ${phase} must retain row_id as its first column`);
    }
    const headers = rawHeaders.map((value) => String(value ?? ''));
    const normalizedHeaders = headers.map((value) => value.normalize('NFKC').trim());
    const canonicalHeaders = normalizedHeaders.map((value) => value.toLocaleLowerCase('en-US').replace(/\s+/g, ' '));
    if (normalizedHeaders.some((value) => !value) || new Set(canonicalHeaders).size !== canonicalHeaders.length) {
        throw new Error(`Deep Clean ${phase} has invalid headers`);
    }
    const ddl = String(sheet?.sourceData?.ddl || '');
    const columns = parseDdlColumnInfos(ddl);
    if (!parseDdlTableName(ddl) || columns.length !== headers.length
        || columns[0]?.sqlName !== 'row_id' || columns[0]?.declaredType !== 'INTEGER' || !columns[0]?.isPrimaryKey) {
        throw new Error(`Deep Clean ${phase} must begin with row_id INTEGER PRIMARY KEY`);
    }
    columns.forEach((column, index) => {
        if (!matchesHeader(column.sqlName, column.comment, normalizedHeaders[index])) {
            throw new Error(`Deep Clean ${phase} DDL/header mismatch: ${column.sqlName}`);
        }
        if (!/^[\x00-\x7F]+$/.test(normalizedHeaders[index]) && !/^[\x00-\x7F]+$/.test(column.sqlName)) {
            throw new Error(`Deep Clean ${phase} requires an ASCII physical column: ${column.sqlName}`);
        }
    });
    const physicalNames = columns.map((column) => column.sqlName);
    if (new Set(physicalNames).size !== physicalNames.length) {
        throw new Error(`Deep Clean ${phase} has duplicate physical columns`);
    }
    return { headers, columns, ddl };
}

function sheetSchemaDescriptor(sheet, descriptorVersion) {
    const { headers, columns, ddl } = requireSheetShape(sheet, `schema descriptor V${descriptorVersion}`);
    return {
        descriptorVersion,
        uid: String(sheet.uid || ''),
        tableName: parseDdlTableName(ddl),
        headers: [...headers],
        ddl,
        normalizedSql: stripSqlLineComments(ddl).replace(/\s+/g, ' ').trim(),
        columns: columns.map((column, index) => ({
            index,
            physicalName: column.sqlName,
            displayHeader: headers[index],
            normalizedDefinition: column.normalizedDefinition,
            ...(descriptorVersion === 2 ? { defaultExpression: column.defaultExpression } : {}),
        })),
        tableConstraints: parseDdlTableConstraints(ddl),
        tableSuffix: parseDdlTableSuffix(ddl),
    };
}

function descriptorSheet(descriptor) {
    return {
        uid: descriptor.uid,
        name: '',
        content: [descriptor.headers.map((value) => value == null ? null : String(value))],
        sourceData: { ddl: descriptor.ddl },
    };
}

function assertDescriptorMatchesSheet(descriptor, sheet, descriptorVersion, phase) {
    if (!isRecord(descriptor) || descriptor.descriptorVersion !== descriptorVersion) {
        throw new Error(`Deep Clean ${phase} has an unsupported descriptor version`);
    }
    if (canonicalJson(descriptor) !== canonicalJson(sheetSchemaDescriptor(sheet, descriptorVersion))) {
        throw new Error(`Deep Clean ${phase} does not match its DDL/header definition`);
    }
}

function expectedV1Changes(before, target) {
    if (before.uid !== target.uid) throw new Error('Deep Clean schema migration cannot change sheet uid');
    if (canonicalJson(before.tableConstraints) !== canonicalJson(target.tableConstraints)) {
        throw new Error('Deep Clean V1 schema migration cannot change table constraints');
    }
    if (before.tableSuffix !== target.tableSuffix) throw new Error('Deep Clean V1 schema migration cannot change table suffix');
    const beforeByName = new Map(before.columns.map((column) => [column.physicalName, column]));
    const targetByName = new Map(target.columns.map((column) => [column.physicalName, column]));
    const removed = before.columns.slice(1).filter((column) => !targetByName.has(column.physicalName));
    const added = target.columns.slice(1).filter((column) => !beforeByName.has(column.physicalName));
    if (removed.length > 0 && added.length > 0) throw new Error('Deep Clean V1 schema migration cannot combine physical add and drop');
    const retainedBefore = before.columns.filter((column) => targetByName.has(column.physicalName)).map((column) => column.physicalName);
    const retainedTarget = target.columns.filter((column) => beforeByName.has(column.physicalName)).map((column) => column.physicalName);
    if (canonicalJson(retainedBefore) !== canonicalJson(retainedTarget)) {
        throw new Error('Deep Clean V1 schema migration cannot reorder retained physical columns');
    }
    const changes = [];
    before.columns.forEach((column) => {
        const targetColumn = targetByName.get(column.physicalName);
        if (!targetColumn) {
            if (column.physicalName === 'row_id') throw new Error('Deep Clean schema migration cannot remove row_id');
            changes.push({ kind: 'drop', physicalName: column.physicalName, header: column.displayHeader, index: column.index });
        } else if (column.normalizedDefinition !== targetColumn.normalizedDefinition) {
            throw new Error(`Deep Clean V1 schema migration cannot change a column definition: ${column.physicalName}`);
        } else if (column.displayHeader !== targetColumn.displayHeader) {
            changes.push({
                kind: 'rename_display',
                physicalName: column.physicalName,
                fromHeader: column.displayHeader,
                toHeader: targetColumn.displayHeader,
            });
        }
    });
    added.forEach((column) => {
        if (column.physicalName === 'row_id') throw new Error('Deep Clean schema migration cannot add row_id');
        const targetInfo = requireSheetShape(descriptorSheet(target), 'target schema').columns[column.index];
        const pureDefinition = targetInfo?.declaredType ? `${targetInfo.sqlName} ${targetInfo.declaredType}` : targetInfo?.sqlName;
        if (!targetInfo || targetInfo.isNotNull || targetInfo.hasDefault
            || P1_COLUMN_CONSTRAINT_TOKENS.has(targetInfo.declaredType?.toUpperCase() || '')
            || targetInfo.normalizedDefinition !== pureDefinition) {
            throw new Error(`Deep Clean V1 schema migration cannot add this column definition: ${column.physicalName}`);
        }
        changes.push({ kind: 'add', physicalName: column.physicalName, header: column.displayHeader, index: column.index });
    });
    return changes;
}

function buildMigratedSheetV1(currentSheet, target) {
    const current = sheetSchemaDescriptor(currentSheet, 1);
    const sourceIndexByName = new Map(current.columns.map((column) => [column.physicalName, column.index]));
    const content = [target.headers.map((value) => value == null ? null : String(value))];
    currentSheet.content.slice(1).forEach((row) => {
        if (!Array.isArray(row)) return;
        content.push(target.columns.map((column) => {
            const sourceIndex = sourceIndexByName.get(column.physicalName);
            return sourceIndex === undefined || row[sourceIndex] == null ? null : String(row[sourceIndex]);
        }));
    });
    return {
        ...cloneJson(currentSheet),
        uid: target.uid,
        content,
        sourceData: { ...cloneJson(currentSheet.sourceData || {}), ddl: target.ddl },
    };
}

function requireUniqueNames(values, label) {
    if (values.some((value) => !value || value === 'row_id') || new Set(values).size !== values.length) {
        throw new Error(`Deep Clean ${label} contains an invalid or duplicate physical column`);
    }
}

function literalToCellValue(literal) {
    if (literal.kind === 'null') return null;
    if (literal.kind === 'boolean') return literal.value ? '1' : '0';
    return String(literal.value);
}

function convertCellValue(value, policy) {
    if (value == null) return { value: null, lossy: false };
    const input = String(value);
    if (policy?.kind === 'identity' || policy?.kind === 'stringify') return { value: input, lossy: false };
    if (policy?.kind === 'integer_strict') {
        if (!/^[+-]?\d+$/.test(input)) throw new Error(`Deep Clean integer_strict cannot convert: ${input}`);
        const numeric = Number(input);
        if (!Number.isSafeInteger(numeric)) throw new Error(`Deep Clean integer_strict exceeds safe integer range: ${input}`);
        const output = String(numeric);
        return { value: output, lossy: output !== input };
    }
    if (policy?.kind === 'real_strict') {
        if (!/^[+-]?(?:\d+\.\d*|\d*\.\d+|\d+)(?:[eE][+-]?\d+)?$/.test(input)) {
            throw new Error(`Deep Clean real_strict cannot convert: ${input}`);
        }
        const numeric = Number(input);
        if (!Number.isFinite(numeric)) throw new Error(`Deep Clean real_strict cannot convert: ${input}`);
        const output = String(numeric);
        return { value: output, lossy: output !== input };
    }
    throw new Error(`Deep Clean schema migration conversion policy is unsupported: ${String(policy?.kind)}`);
}

function semanticColumnDefinition(column) {
    return column.normalizedDefinition.slice(column.physicalName.length).trim();
}

function buildMigratedSheetV2(currentSheet, operation) {
    const current = sheetSchemaDescriptor(currentSheet, 2);
    assertDescriptorMatchesSheet(operation.beforeSchema, currentSheet, 2, 'schema migration V2 beforeSchema');
    assertDescriptorMatchesSheet(operation.targetSchema, descriptorSheet(operation.targetSchema), 2, 'schema migration V2 targetSchema');
    if (current.uid !== operation.targetSchema.uid) throw new Error('Deep Clean schema migration V2 cannot change sheet uid');
    if (current.columns[0]?.physicalName !== 'row_id' || operation.targetSchema.columns[0]?.physicalName !== 'row_id') {
        throw new Error('Deep Clean schema migration V2 must retain row_id');
    }
    const sourceByName = new Map(current.columns.map((column) => [column.physicalName, column]));
    const targetByName = new Map(operation.targetSchema.columns.map((column) => [column.physicalName, column]));
    const mappings = Array.isArray(operation.physicalColumnMappings) ? operation.physicalColumnMappings : [];
    requireUniqueNames(mappings.map((item) => String(item?.fromPhysicalName || '')), 'physicalColumnMappings source');
    requireUniqueNames(mappings.map((item) => String(item?.toPhysicalName || '')), 'physicalColumnMappings target');
    const mappedSource = new Map();
    mappings.forEach((item) => {
        if (!sourceByName.has(item.fromPhysicalName) || !targetByName.has(item.toPhysicalName)
            || sourceByName.has(item.toPhysicalName) || targetByName.has(item.fromPhysicalName)) {
            throw new Error('Deep Clean physicalColumnMappings has an invalid source or target');
        }
        mappedSource.set(item.toPhysicalName, item.fromPhysicalName);
    });
    const removed = current.columns.slice(1).filter((column) => (
        !targetByName.has(column.physicalName)
        && !mappings.some((item) => item.fromPhysicalName === column.physicalName)
    ));
    const added = operation.targetSchema.columns.slice(1).filter((column) => (
        !sourceByName.has(column.physicalName) && !mappedSource.has(column.physicalName)
    ));
    if (removed.length > 0 && !operation.migrationPolicy?.destructiveChangeConfirmed) {
        throw new Error('Deep Clean schema migration V2 destructive drop is not confirmed');
    }
    const conversionByTarget = new Map();
    for (const conversion of Array.isArray(operation.conversions) ? operation.conversions : []) {
        if (!conversion || conversion.fromPhysicalName === 'row_id' || conversion.toPhysicalName === 'row_id'
            || conversionByTarget.has(conversion.toPhysicalName)) {
            throw new Error('Deep Clean schema migration V2 conversion is invalid');
        }
        conversionByTarget.set(conversion.toPhysicalName, conversion.policy);
    }
    const fills = isRecord(operation.fills) ? operation.fills : {};
    Object.keys(fills).forEach((name) => {
        const fill = fills[name];
        if (!added.some((column) => column.physicalName === name)
            || !fill || (fill.kind !== 'literal' && fill.kind !== 'ddl_literal_default')) {
            throw new Error(`Deep Clean schema migration V2 fill is invalid: ${name}`);
        }
        const parsed = parseSafeDefaultLiteral(fill.literal?.sql);
        if (!parsed || canonicalJson(parsed) !== canonicalJson(fill.literal)) {
            throw new Error(`Deep Clean schema migration V2 fill literal is invalid: ${name}`);
        }
        if (fill.kind === 'ddl_literal_default'
            && canonicalJson(parsed) !== canonicalJson(parseSafeDefaultLiteral(targetByName.get(name)?.defaultExpression))) {
            throw new Error(`Deep Clean schema migration V2 DDL default does not match: ${name}`);
        }
    });
    if (Object.keys(fills).length !== added.length) throw new Error('Deep Clean schema migration V2 requires one fill for every added column');
    const sourceForTarget = (targetName) => sourceByName.has(targetName) ? targetName : mappedSource.get(targetName);
    operation.targetSchema.columns.slice(1).forEach((target) => {
        const sourceName = sourceForTarget(target.physicalName);
        const declared = Array.isArray(operation.conversions)
            ? operation.conversions.find((item) => item?.toPhysicalName === target.physicalName)
            : undefined;
        if (declared && declared.fromPhysicalName !== sourceName) throw new Error(`Deep Clean conversion source mismatch: ${target.physicalName}`);
        if (!sourceName) return;
        const definitionChanged = semanticColumnDefinition(sourceByName.get(sourceName)) !== semanticColumnDefinition(target);
        const conversion = conversionByTarget.get(target.physicalName);
        if (definitionChanged !== !!conversion) throw new Error(`Deep Clean conversion contract mismatch: ${target.physicalName}`);
    });
    const coveredConversions = [...conversionByTarget].filter(([targetName]) => {
        const sourceName = sourceForTarget(targetName);
        return !!sourceName
            && semanticColumnDefinition(sourceByName.get(sourceName)) !== semanticColumnDefinition(targetByName.get(targetName));
    });
    if (conversionByTarget.size !== coveredConversions.length) throw new Error('Deep Clean conversion must cover only changed definitions');
    const content = [operation.targetSchema.headers.map((value) => value == null ? null : String(value))];
    let convertedRowCount = 0;
    let lossyRowCount = 0;
    currentSheet.content.slice(1).forEach((row) => {
        if (!Array.isArray(row)) return;
        let rowLossy = false;
        const targetRow = operation.targetSchema.columns.map((target) => {
            const sourceName = sourceForTarget(target.physicalName);
            if (!sourceName) return literalToCellValue(fills[target.physicalName].literal);
            const sourceIndex = sourceByName.get(sourceName).index;
            const policy = conversionByTarget.get(target.physicalName);
            if (!policy) return row[sourceIndex] == null ? null : String(row[sourceIndex]);
            const converted = convertCellValue(row[sourceIndex], policy);
            convertedRowCount += 1;
            rowLossy ||= converted.lossy;
            return converted.value;
        });
        if (rowLossy) lossyRowCount += 1;
        content.push(targetRow);
    });
    if (lossyRowCount > 0 && !operation.migrationPolicy?.lossyConversionConfirmed) {
        throw new Error('Deep Clean schema migration V2 lossy conversion is not confirmed');
    }
    const dryRun = { convertedRowCount, failedRowCount: 0, lossyRowCount };
    if (canonicalJson(operation.dryRun) !== canonicalJson(dryRun)) throw new Error('Deep Clean schema migration V2 dry-run mismatch');
    return {
        ...cloneJson(currentSheet),
        uid: operation.targetSchema.uid,
        content,
        sourceData: { ...cloneJson(currentSheet.sourceData || {}), ddl: operation.targetSchema.ddl },
    };
}

async function validateSchemaCandidate(candidate) {
    assertCanonicalState(candidate);
    const runtime = await createSqlRuntime(candidate);
    runtime.db.close();
}

async function applySchemaMigration(state, operation) {
    const currentSheet = state[operation.sheetKey];
    if (!isRecord(currentSheet)) throw new Error(`Deep Clean schema migration target is missing: ${operation.sheetKey}`);
    if (operation.contractVersion === 1) {
        assertDescriptorMatchesSheet(operation.beforeSchema, currentSheet, 1, 'schema migration beforeSchema');
        assertDescriptorMatchesSheet(operation.targetSchema, descriptorSheet(operation.targetSchema), 1, 'schema migration targetSchema');
        const expectedChanges = expectedV1Changes(operation.beforeSchema, operation.targetSchema);
        if (canonicalJson(operation.columnChanges) !== canonicalJson(expectedChanges)) {
            throw new Error('Deep Clean schema migration columnChanges mismatch');
        }
        const hasDrop = expectedChanges.some((change) => change.kind === 'drop');
        if (hasDrop !== operation.migrationPolicy?.destructiveChangeConfirmed) {
            throw new Error('Deep Clean schema migration destructive confirmation mismatch');
        }
    } else if (operation.contractVersion !== 2) {
        throw new Error(`Deep Clean schema migration contract is unsupported: ${String(operation.contractVersion)}`);
    }
    const beforeDigest = await sha256(canonicalJson(operation.beforeSchema));
    const targetDigest = await sha256(canonicalJson(operation.targetSchema));
    if (operation.beforeSchemaDigest !== beforeDigest || operation.targetSchemaDigest !== targetDigest) {
        throw new Error(`Deep Clean schema migration descriptor digest mismatch: ${operation.sheetKey}`);
    }
    const candidate = cloneJson(state);
    candidate[operation.sheetKey] = operation.contractVersion === 1
        ? buildMigratedSheetV1(currentSheet, operation.targetSchema)
        : buildMigratedSheetV2(currentSheet, operation);
    await validateSchemaCandidate(candidate);
    return candidate;
}

function applyRowOperation(state, operation) {
    const sheet = state[operation.sheetKey];
    if (!isRecord(sheet) || !Array.isArray(sheet.content)) {
        throw new Error(`Deep Clean Shujuku operation targets a missing sheet: ${operation.sheetKey}`);
    }
    if (operation.kind === 'row_delete') {
        const rowId = String(operation.rowId ?? '').trim();
        sheet.content = sheet.content.filter((row, index) => index === 0 || String(row?.[0] ?? '').trim() !== rowId);
        return;
    }
    if (!Array.isArray(operation.cells)) throw new Error(`Deep Clean Shujuku row_upsert has no cells: ${operation.sheetKey}`);
    const rowId = String(operation.rowId ?? '').trim();
    const cells = cloneJson(operation.cells);
    if (!rowId || String(cells[0] ?? '').trim() !== rowId || cells.length !== sheet.content[0].length) {
        throw new Error(`Deep Clean Shujuku row_upsert identity mismatch: ${operation.sheetKey}`);
    }
    const matches = [];
    sheet.content.forEach((row, index) => {
        if (index > 0 && String(row?.[0] ?? '').trim() === rowId) matches.push(index);
    });
    if (matches.length > 1) throw new Error(`Deep Clean Shujuku row_upsert found duplicate row_id: ${operation.sheetKey}/${rowId}`);
    cells[0] = rowId;
    if (matches.length === 1) sheet.content[matches[0]] = cells;
    else sheet.content.push(cells);
}

async function applyStructuredOperation(state, operation, runtime) {
    if (operation.kind === 'sql_batch' || operation.kind === 'sql_sheet_batch') {
        const nextRuntime = runtime || await createSqlRuntime(state);
        if (!Array.isArray(operation.statements)) throw new Error(`Deep Clean Shujuku ${operation.kind} has no statements`);
        runSqlOperation(nextRuntime, state, operation);
        return { state, runtime: nextRuntime };
    }
    const nextState = runtime ? materializeRuntime(runtime, state) : cloneJson(state);
    if (operation.kind === 'data_replace') {
        if (!isRecord(operation.data)) throw new Error('Deep Clean Shujuku data_replace has no data');
        const data = cloneJson(operation.data);
        assertCanonicalState(data);
        return { state: data, runtime: null };
    }
    if (operation.kind === 'sheet_replace') {
        if (!operation.sheetKey?.startsWith('sheet_') || !isRecord(operation.sheet)) {
            throw new Error('Deep Clean Shujuku sheet_replace is invalid');
        }
        nextState[operation.sheetKey] = cloneJson(operation.sheet);
    } else if (operation.kind === 'row_upsert' || operation.kind === 'row_delete') {
        applyRowOperation(nextState, operation);
    } else if (operation.kind === 'meta_update') {
        const sheet = nextState[operation.sheetKey];
        if (!isRecord(sheet) || !isRecord(operation.meta)) throw new Error('Deep Clean Shujuku meta_update is invalid');
        if (isRecord(operation.meta.sourceData) && Object.prototype.hasOwnProperty.call(operation.meta.sourceData, 'ddl')) {
            throw new Error('Deep Clean Shujuku meta_update cannot change DDL');
        }
        ['name', 'orderNo', 'updateConfig', 'exportConfig'].forEach((key) => {
            if (operation.meta[key] !== undefined) sheet[key] = cloneJson(operation.meta[key]);
        });
        if (operation.meta.sourceData !== undefined) {
            sheet.sourceData = { ...cloneJson(sheet.sourceData || {}), ...cloneJson(operation.meta.sourceData) };
        }
    } else if (operation.kind === 'sheet_schema_migrate') {
        return { state: await applySchemaMigration(nextState, operation), runtime: null };
    }
    assertCanonicalState(nextState);
    return { state: nextState, runtime: null };
}

function validatedSheetCheckpoints(frame) {
    if (frame.perSheetCheckpoints === undefined) return [];
    if (!isRecord(frame.perSheetCheckpoints)) throw new Error('Deep Clean Shujuku per-sheet checkpoints are invalid');
    return Object.entries(frame.perSheetCheckpoints).map(([sheetKey, checkpoint]) => {
        if (!sheetKey.startsWith('sheet_') || !isRecord(checkpoint) || checkpoint.kind !== 'sheet_full'
            || checkpoint.sheetKey !== sheetKey || !isRecord(checkpoint.data)) {
            throw new Error(`Deep Clean Shujuku per-sheet checkpoint is invalid: ${sheetKey}`);
        }
        if (checkpoint.timeline !== undefined) {
            const timeline = checkpoint.timeline;
            if (!isRecord(timeline)
                || !['sheet_introduction', 'sheet_rebase', 'sheet_reveal', 'sheet_hide'].includes(timeline.kind)
                || !Number.isInteger(timeline.afterSeq) || timeline.afterSeq < 0) {
                throw new Error(`Deep Clean Shujuku sheet timeline is invalid: ${sheetKey}`);
            }
        }
        assertCanonicalSheet(checkpoint.data, sheetKey);
        return cloneJson(checkpoint);
    }).sort((left, right) => left.sheetKey.localeCompare(right.sheetKey));
}

function canonicalLogEntries(frame) {
    let previousSeq = -1;
    return frame.logEntries.map((entry) => {
        if (!isRecord(entry) || !Number.isInteger(entry.seq) || entry.seq < 0 || entry.seq <= previousSeq) {
            throw new Error('Deep Clean Shujuku V2 log ordering is invalid');
        }
        previousSeq = entry.seq;
        return entry;
    });
}

function applySheetCheckpoints(state, checkpoints, lifecycle) {
    const candidate = cloneJson(state);
    checkpoints.forEach((checkpoint) => {
        if (checkpoint.timeline?.kind === 'sheet_hide') {
            delete candidate[checkpoint.sheetKey];
            lifecycle.set(checkpoint.sheetKey, 'hidden');
        } else {
            candidate[checkpoint.sheetKey] = cloneJson(checkpoint.data);
            lifecycle.set(checkpoint.sheetKey, 'active');
        }
    });
    assertCanonicalState(candidate);
    return candidate;
}

async function replayIsolationSlot(frameRefs, baseIndex) {
    const checkpoint = frameRefs[baseIndex].frame.checkpoint;
    let state = cloneJson(checkpoint.data);
    assertCanonicalState(state);
    const lifecycle = new Map(Object.keys(state).filter((key) => key.startsWith('sheet_')).map((key) => [key, 'active']));
    let runtime = null;

    for (let frameIndex = baseIndex; frameIndex < frameRefs.length; frameIndex += 1) {
        const frame = frameRefs[frameIndex].frame;
        const checkpoints = validatedSheetCheckpoints(frame);
        const untimed = checkpoints.filter((item) => item.timeline === undefined);
        if (untimed.length > 0) {
            if (runtime) {
                state = materializeRuntime(runtime, state);
                runtime = null;
            }
            state = applySheetCheckpoints(state, untimed, lifecycle);
        }
        const pending = checkpoints.filter((item) => item.timeline !== undefined);
        const applyDue = (nextSeq) => {
            const due = pending.filter((item) => item.timeline.afterSeq < nextSeq);
            if (due.length === 0) return;
            if (runtime) {
                state = materializeRuntime(runtime, state);
                runtime = null;
            }
            state = applySheetCheckpoints(state, due, lifecycle);
            due.forEach((item) => pending.splice(pending.indexOf(item), 1));
        };
        for (const entry of canonicalLogEntries(frame)) {
            applyDue(entry.seq);
            for (const operation of entry.operations) {
                const applied = await applyStructuredOperation(state, operation, runtime);
                state = applied.state;
                runtime = applied.runtime;
            }
        }
        applyDue(Number.POSITIVE_INFINITY);
    }
    if (runtime) state = materializeRuntime(runtime, state);
    assertCanonicalState(state);
    return { state, lifecycle };
}

async function describeStateSchemas(state) {
    const runtime = await createSqlRuntime(state);
    try {
        return new Map([...runtime.sheets.entries()].map(([sheetKey, metadata]) => [sheetKey, metadata.schema.map((column) => column.name)]));
    } finally {
        runtime.db.close();
    }
}

function projectBusinessColumns(sheet, ddlColumns) {
    const headers = sheet.content[0].map((value) => String(value ?? ''));
    const rawHidden = sheet.sourceData?.hiddenPhysicalColumns;
    if (rawHidden !== undefined && !Array.isArray(rawHidden)) return null;
    const hidden = (rawHidden || []).map((value) => String(value ?? '').trim()).filter(Boolean);
    const hiddenCanonical = hidden.map((value) => value.toLowerCase());
    if (new Set(hiddenCanonical).size !== hiddenCanonical.length || hiddenCanonical.includes('row_id')) return null;
    const canMapByIndex = ddlColumns.length === headers.length;
    const physicalNames = canMapByIndex ? ddlColumns : headers;
    const knownPhysical = new Set([
        ...physicalNames.map((value) => value.toLowerCase()),
        ...(canMapByIndex ? [] : ddlColumns.map((value) => value.toLowerCase())),
    ]);
    if (hidden.some((value) => !knownPhysical.has(value.toLowerCase()))) return null;
    const hiddenSet = new Set(hiddenCanonical);
    const columns = headers.map((header, sourceIndex) => {
        const physicalName = physicalNames[sourceIndex] || header;
        const ddlName = canMapByIndex ? '' : (ddlColumns[sourceIndex] || '');
        const isHidden = hiddenSet.has(physicalName.toLowerCase())
            || (!!ddlName && hiddenSet.has(ddlName.toLowerCase()))
            || (!!header && hiddenSet.has(header.toLowerCase()));
        return { sourceIndex, physicalName, isHidden };
    }).filter((column) => column.sourceIndex > 0 && !column.isHidden && column.physicalName !== 'row_id');
    const keys = columns.map((column) => column.physicalName.trim());
    if (keys.some((key) => !key) || new Set(keys).size !== keys.length) return null;
    return columns;
}

async function cellsFromReplay(replay, isolationKey, options = {}) {
    const schemas = await describeStateSchemas(replay.state);
    const cells = [];
    for (const [sheetKey, sheet] of Object.entries(replay.state)) {
        if (!sheetKey.startsWith('sheet_') || replay.lifecycle.get(sheetKey) !== 'active') continue;
        try {
            assertCanonicalSheet(sheet, sheetKey);
        } catch (error) {
            if (options.strict === true) throw error;
            continue;
        }
        const columns = projectBusinessColumns(sheet, schemas.get(sheetKey) || []);
        if (!columns) {
            if (options.strict === true) {
                throw new Error(`Deep Clean Shujuku physical column projection is ambiguous: ${sheetKey}`);
            }
            continue;
        }
        sheet.content.slice(1).forEach((row) => {
            const rowId = String(row[0]).trim();
            columns.forEach((column) => {
                const value = row[column.sourceIndex];
                if (typeof value !== 'string') return;
                cells.push({
                    isolationKey,
                    sheetKey,
                    rowId,
                    columnKey: column.physicalName,
                    originalText: value,
                });
            });
        });
    }
    return cells;
}

export async function projectLateV1ShujukuCells(state, isolationKey) {
    assertCanonicalState(state);
    const runtime = await createSqlRuntime(state);
    try {
        for (const [sheetKey, metadata] of runtime.sheets) {
            const sheet = state[sheetKey];
            const seedRows = sheet?.seedRows;
            if (seedRows === undefined) continue;
            if (!Array.isArray(seedRows)) {
                throw new Error(`Deep Clean Shujuku V1 seedRows is invalid: ${sheetKey}`);
            }
            const comments = parseDdlColumnComments(normalizeSqlStructure(String(sheet?.sourceData?.ddl || '')));
            const projectionInput = {
                ...sheet,
                content: [sheet.content[0], ...sheet.content.slice(1), ...seedRows],
            };
            const insertPlan = createInsertPlan(projectionInput, metadata.schema, comments);
            for (const row of seedRows) {
                for (const { column, sourceIndex } of insertPlan) {
                    if ((column.primaryKey || (column.notNull && column.defaultValue === null))
                        && (row[sourceIndex] === null || row[sourceIndex] === undefined)) {
                        throw new Error(`Deep Clean Shujuku V1 seedRows requires a business value: ${sheetKey}/${column.name}`);
                    }
                }
            }
        }
    } finally {
        runtime.db.close();
    }
    const lifecycle = new Map(
        Object.keys(state).filter((key) => key.startsWith('sheet_')).map((key) => [key, 'active']),
    );
    return cellsFromReplay({ state, lifecycle }, isolationKey, { strict: true });
}

export async function readCurrentShujukuV2Cells(chat) {
    if (!Array.isArray(chat)) return [];
    const cells = [];
    for (const isolationKey of collectIsolationKeys(chat)) {
        const frameRefs = collectFrameRefs(chat, isolationKey);
        const baseIndex = latestFullCheckpointIndex(frameRefs);
        if (baseIndex < 0) {
            throw new Error(`Deep Clean Shujuku V2 has no usable full-checkpoint replay root: ${isolationKey}`);
        }
        assertCurrentWriterReplaySegment(frameRefs, baseIndex);
        const replay = await replayIsolationSlot(frameRefs, baseIndex);
        cells.push(...await cellsFromReplay(replay, isolationKey, { strict: true }));
    }
    return cells;
}

function compareText(left, right) {
    const a = String(left);
    const b = String(right);
    return a < b ? -1 : a > b ? 1 : 0;
}

function compareCellIdentity(left, right) {
    return compareText(left.sheetKey, right.sheetKey)
        || compareText(left.rowId, right.rowId)
        || compareText(left.columnKey, right.columnKey);
}

function generateCurrentV2EntryId() {
    return `v2_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function countPersistedAiFloor(chat, targetMessageIndex) {
    let count = 0;
    for (let index = 1; index <= targetMessageIndex && index < chat.length; index += 1) {
        if (chat[index] && !chat[index].is_user) count += 1;
    }
    return count;
}

async function applyIsolationCellChanges(chat, isolationKey, changes) {
    const frameRefs = collectFrameRefs(chat, isolationKey);
    const baseIndex = latestFullCheckpointIndex(frameRefs);
    if (baseIndex < 0) {
        throw new Error(`Deep Clean Shujuku current-v2 replay is unavailable: ${isolationKey}`);
    }
    assertCurrentWriterReplaySegment(frameRefs, baseIndex);

    const replay = await replayIsolationSlot(frameRefs, baseIndex);
    const schemas = await describeStateSchemas(replay.state);
    const targets = [];
    const cellKeys = new Set();

    for (const change of changes) {
        const locator = change.locator || {};
        const sheetKey = String(locator.sheetKey || '');
        const rowId = String(locator.rowId || '').trim();
        const columnKey = String(locator.columnKey || '');
        const cellKey = `${sheetKey}\u0000${rowId}\u0000${columnKey}`;
        if (!sheetKey.startsWith('sheet_') || !rowId || !columnKey || cellKeys.has(cellKey)) {
            throw new Error(`Deep Clean Shujuku Cell locator is invalid or duplicated: ${sheetKey}/${rowId}/${columnKey}`);
        }
        cellKeys.add(cellKey);

        const sheet = replay.state[sheetKey];
        if (replay.lifecycle.get(sheetKey) !== 'active' || !isRecord(sheet)) {
            throw new Error(`Deep Clean Shujuku target sheet is not active: ${sheetKey}`);
        }
        assertCanonicalSheet(sheet, sheetKey);
        const columns = projectBusinessColumns(sheet, schemas.get(sheetKey) || []);
        const column = columns?.find((candidate) => candidate.physicalName === columnKey);
        if (!column) throw new Error(`Deep Clean Shujuku physical column is missing: ${sheetKey}/${columnKey}`);

        const rows = sheet.content.slice(1).filter((row) => String(row?.[0] ?? '').trim() === rowId);
        if (rows.length !== 1) {
            throw new Error(`Deep Clean Shujuku canonical row is missing or duplicated: ${sheetKey}/${rowId}`);
        }
        const row = rows[0];
        if (typeof row[column.sourceIndex] !== 'string' || row[column.sourceIndex] !== change.originalText) {
            throw new Error(`Deep Clean Shujuku Cell changed after Freeze: ${sheetKey}/${rowId}/${columnKey}`);
        }
        targets.push({ change, sheetKey, rowId, columnKey, row, columnIndex: column.sourceIndex });
    }

    targets.forEach((target) => {
        target.row[target.columnIndex] = target.change.reviewedText;
    });

    const changedRows = new Map();
    targets.forEach((target) => {
        changedRows.set(`${target.sheetKey}\u0000${target.rowId}`, {
            kind: 'row_upsert',
            sheetKey: target.sheetKey,
            rowId: target.rowId,
            cells: cloneJson(target.row),
        });
    });
    const operations = [...changedRows.values()].sort((left, right) => (
        compareText(left.sheetKey, right.sheetKey) || compareText(left.rowId, right.rowId)
    ));
    const writeSet = targets
        .map((target) => ({ kind: 'cell', sheetKey: target.sheetKey, rowId: target.rowId, columnKey: target.columnKey }))
        .sort(compareCellIdentity);
    const changedSheetKeys = [...new Set(operations.map((operation) => operation.sheetKey))].sort(compareText);

    const targetRef = frameRefs[frameRefs.length - 1];
    const targetMessageIndex = targetRef?.messageIndex;
    if (!Number.isInteger(targetMessageIndex) || targetMessageIndex <= 0 || !isRecord(chat[targetMessageIndex]) || chat[targetMessageIndex].is_user !== false) {
        throw new Error(`Deep Clean Shujuku append target is invalid: ${isolationKey}`);
    }
    const isolatedData = cloneJson(readShujukuIsolatedData(chat[targetMessageIndex]));
    const frame = isolatedData?.[isolationKey]?.storageFrame;
    if (!isRecord(frame) || frame.version !== 2 || !Array.isArray(frame.logEntries)) {
        throw new Error(`Deep Clean Shujuku append frame is invalid: ${isolationKey}`);
    }

    const seq = Math.max(0, ...frame.logEntries.map((entry) => Number(entry?.seq) || 0)) + 1;
    const entryId = generateCurrentV2EntryId();
    const parentRevision = frame.headRevision ?? null;
    const commitRevision = `${seq}:${entryId}`;
    const runtimeMessageIndex = targetMessageIndex - 1;
    frame.logEntries.push({
        seq,
        entryId,
        createdAt: Date.now(),
        source: 'manual_crud',
        targetMessageIndex: runtimeMessageIndex,
        aiFloor: countPersistedAiFloor(chat, targetMessageIndex),
        filledSheetKeys: [],
        changedSheetKeys,
        groupKeys: [],
        operations,
        baseRevision: parentRevision,
        parentRevision,
        commitRevision,
        writeSet,
    });
    frame.headRevision = commitRevision;
    chat[targetMessageIndex].TavernDB_ACU_IsolatedData = isolatedData;
    if (isolationKey) chat[targetMessageIndex].TavernDB_ACU_Identity = isolationKey;
    else delete chat[targetMessageIndex].TavernDB_ACU_Identity;
    return targetMessageIndex;
}

export async function applyCurrentShujukuV2CellChanges(chat, changes) {
    if (!Array.isArray(chat)) throw new Error('Deep Clean Shujuku Apply requires a fresh Chat Branch');
    const groups = new Map();
    for (const change of Array.isArray(changes) ? changes : []) {
        const isolationKey = change?.locator?.isolationKey;
        if (typeof isolationKey !== 'string') throw new Error('Deep Clean Shujuku Cell has no isolation key');
        if (!groups.has(isolationKey)) groups.set(isolationKey, []);
        groups.get(isolationKey).push(change);
    }
    const changedMessageIndexes = new Set();
    for (const isolationKey of [...groups.keys()].sort(compareText)) {
        changedMessageIndexes.add(await applyIsolationCellChanges(chat, isolationKey, groups.get(isolationKey)));
    }
    return [...changedMessageIndexes].sort((left, right) => left - right);
}
