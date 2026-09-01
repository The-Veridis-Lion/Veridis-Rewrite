export class AiRewriteResponseFormatError extends Error {
    constructor(message, cause = null, diagnostic = null) {
        super(message);
        this.name = 'AiRewriteResponseFormatError';
        if (cause) this.cause = cause;
        if (diagnostic) this.diagnostic = diagnostic;
    }
}

export function isAiRewriteResponseFormatError(error) {
    return error instanceof AiRewriteResponseFormatError
        || error?.name === 'AiRewriteResponseFormatError';
}

export function parseAiRewriteResponseObject(rawText) {
    const candidate = String(rawText || '').trim();
    if (!/^\{[\s\S]*\}$/.test(candidate)) {
        throw new AiRewriteResponseFormatError('API 返回不是单个 JSON 对象', null, {
            reason: 'not-json-object',
            rawLength: String(rawText || '').length,
            preview: String(rawText || '').slice(0, 300),
        });
    }

    let parsed;
    try {
        parsed = JSON.parse(candidate);
    } catch (error) {
        throw new AiRewriteResponseFormatError('API 返回的 JSON 无法解析', error, {
            reason: 'json-parse-error',
            error: error?.message || String(error),
            rawLength: String(rawText || '').length,
            preview: String(rawText || '').slice(0, 300),
        });
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new AiRewriteResponseFormatError('API 返回不是 id 到改写文本的 JSON 对象', null, {
            reason: 'invalid-rewrite-map',
        });
    }
    return parsed;
}

export function validateAiRewriteTargetValue(id, rawValue) {
    if (typeof rawValue !== 'string') {
        throw new AiRewriteResponseFormatError(`API 返回 ${id} 的改写结果不是字符串`);
    }
    return rawValue;
}

export function validateAiRewriteEntries(returnedEntries, itemById) {
    if (returnedEntries.length !== itemById.size) {
        throw new AiRewriteResponseFormatError(
            `API 返回改写数量不一致：需要 ${itemById.size} 项，实际 ${returnedEntries.length} 项`,
            null,
            {
                reason: 'rewrite-count-mismatch',
                expectedCount: itemById.size,
                returnedCount: returnedEntries.length,
            },
        );
    }

    const accepted = new Map();
    for (const [rawId, rawValue] of returnedEntries) {
        const id = String(rawId || '');
        if (!itemById.has(id)) throw new AiRewriteResponseFormatError(`API 返回未知改写 id：${id || '(空)'}`);
        accepted.set(id, validateAiRewriteTargetValue(id, rawValue));
    }
    return accepted;
}

export function validateAiRewriteResponse(rawText, itemById) {
    const parsed = parseAiRewriteResponseObject(rawText);
    return validateAiRewriteEntries(Object.entries(parsed), itemById);
}
