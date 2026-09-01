// Owns external World Book entry persistence and World Info cache synchronization.

import { getAppContext } from '../../host/appContext.js';
import { isRecord, postJson } from './io.js';

export async function applyWorldBookUnit(fetchImpl, context, worldBookKey, changes) {
    const setWorldInfoCache = getAppContext().setWorldInfoCache;
    if (typeof setWorldInfoCache !== 'function') throw new Error('Deep Clean World Book cache owner is unavailable');
    const worldBook = await postJson(
        fetchImpl,
        context,
        '/api/worldinfo/get',
        { name: worldBookKey },
        `Deep Clean World Book read failed for ${worldBookKey}`,
    );
    if (!isRecord(worldBook) || !isRecord(worldBook.entries)) {
        throw new Error(`Deep Clean World Book response is invalid for ${worldBookKey}`);
    }
    for (const change of changes) {
        const entry = worldBook.entries[change.locator.entryKey];
        if (!isRecord(entry) || entry.content !== change.originalText) {
            throw new Error(`Deep Clean World Book entry changed after Freeze: ${worldBookKey}/${change.locator.entryKey}`);
        }
        entry.content = change.reviewedText;
    }
    const saved = await postJson(
        fetchImpl,
        context,
        '/api/worldinfo/edit',
        { name: worldBookKey, data: worldBook },
        `Deep Clean World Book save failed for ${worldBookKey}`,
    );
    if (saved?.ok !== true) throw new Error(`Deep Clean World Book save was not confirmed: ${worldBookKey}`);
    setWorldInfoCache(worldBookKey, worldBook);
}
