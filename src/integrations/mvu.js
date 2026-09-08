/** Owns active MVU presence detection only; MVU owns its requests and message updates. */
import { getGlobalObject } from '../host/context.js';

function getMvuGlobalApi() {
    const root = getGlobalObject();
    if (root?.Mvu && typeof root.Mvu === 'object') return root.Mvu;
    try {
        const parentApi = root?.parent?.Mvu;
        if (parentApi && typeof parentApi === 'object') return parentApi;
    } catch {
        // Cross-window access can fail outside the SillyTavern host.
    }
    return null;
}

export function getMvuIntegrationSignal() {
    return getMvuGlobalApi() ? 'detected' : 'not_detected';
}
