// Owns only the local HTTP/JSON primitives shared by Deep Clean Apply writers.

export function isRecord(value) {
    return !!(value && typeof value === 'object' && !Array.isArray(value));
}

export function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

function requestHeaders(context) {
    return typeof context?.getRequestHeaders === 'function'
        ? context.getRequestHeaders()
        : { 'Content-Type': 'application/json' };
}

export async function postResponse(fetchImpl, context, path, body, label) {
    const response = await fetchImpl(path, {
        method: 'POST',
        headers: requestHeaders(context),
        body: JSON.stringify(body),
        cache: 'no-cache',
    });
    if (!response?.ok) throw new Error(`${label}: ${response?.status ?? 'request failed'}`);
    return response;
}

export async function postJson(fetchImpl, context, path, body, label) {
    const response = await postResponse(fetchImpl, context, path, body, label);
    try {
        return await response.json();
    } catch {
        throw new Error(`${label}: invalid response body`);
    }
}
