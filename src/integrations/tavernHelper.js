/** Owns TavernHelper host API discovery and its anonymous-feedback environment projection. */
import { getGlobalObject } from '../host/context.js';

const shujukuLoaderPattern = /^\s*import\s+['"]https:\/\/gcore\.jsdelivr\.net\/gh\/AlbusKen\/shujuku@([^/'"]+)\/index\.js['"]\s*;?/m;

export function getTavernHelperGlobalApi() {
    const root = getGlobalObject();
    if (root?.TavernHelper && typeof root.TavernHelper === 'object') return root.TavernHelper;
    try {
        const parentApi = root?.parent?.TavernHelper;
        if (parentApi && typeof parentApi === 'object') return parentApi;
    } catch {
        // Cross-window access can fail outside the SillyTavern host.
    }
    return null;
}

function projectEnabledGlobalScript(script) {
    const shujukuTag = String(script?.content || '').match(shujukuLoaderPattern)?.[1] || '';
    return {
        externalId: `tavern-helper/script/${String(script?.id || '')}`,
        displayName: String(script?.name || ''),
        version: shujukuTag,
    };
}

function collectEnabledGlobalScripts(scriptTrees) {
    return (Array.isArray(scriptTrees) ? scriptTrees : []).flatMap((entry) => {
        if (entry?.type === 'script') return entry.enabled === true ? [projectEnabledGlobalScript(entry)] : [];
        if (entry?.type !== 'folder' || entry.enabled !== true || !Array.isArray(entry.children)) return [];
        return entry.children
            .filter((script) => script?.type === 'script' && script.enabled === true)
            .map(projectEnabledGlobalScript);
    });
}

export function collectTavernHelperFeedbackEnvironment(tavernHelper = getTavernHelperGlobalApi()) {
    if (!tavernHelper) return [];
    if (typeof tavernHelper.getTavernHelperVersion !== 'function') {
        throw new Error('TavernHelper.getTavernHelperVersion is unavailable.');
    }
    if (typeof tavernHelper.getScriptTrees !== 'function') {
        throw new Error('TavernHelper.getScriptTrees is unavailable.');
    }

    const version = tavernHelper.getTavernHelperVersion();
    if (typeof version !== 'string') {
        throw new Error('TavernHelper.getTavernHelperVersion returned an invalid version.');
    }
    const scriptTrees = tavernHelper.getScriptTrees({ type: 'global' });
    if (!Array.isArray(scriptTrees)) {
        throw new Error('TavernHelper.getScriptTrees returned an invalid global ScriptTree.');
    }
    return [
        {
            externalId: 'tavern-helper',
            displayName: 'TavernHelper',
            version,
        },
        ...collectEnabledGlobalScripts(scriptTrees),
    ];
}
