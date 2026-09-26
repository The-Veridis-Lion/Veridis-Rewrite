// Reuses the sole pure comparison/rendering owner; receives text, never host state.
import { getTextDiffOperations, renderDiffDocument } from './compare.js';

self.onmessage = ({ data }) => {
    try {
        let result;
        if (data.kind === 'document') result = renderDiffDocument(data.pairs, data.mode);
        else if (data.kind === 'pairs') {
            result = data.pairs.map(pair => getTextDiffOperations(pair.oldText, pair.newText));
        } else throw new Error('Unknown Difference request');
        self.postMessage({ result });
    } catch (error) {
        self.postMessage({ error: error instanceof Error ? error.message : String(error) });
    }
};
