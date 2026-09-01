// Owns host-injected application references configured once by the extension entry point.
const appContext = {
    extension_settings: null,
    saveSettingsDebounced: null,
    eventSource: null,
    event_types: null,
    getStreamingProcessor: null,
    saveChat: null,
    chat: null,
    getSillyTavernContext: null,
    markWindowedChatDirtyFromIndex: null,
    getWorldInfoState: null,
    setWorldInfoCache: null,
    getCurrentPersonaIdentity: null,
    getVeridisVersion: null,
    getSillyTavernVersion: null,
    getAiRewriteDiagnosticConfig: null,
    getCoarsePlatform: null,
    getInstalledEnabledExtensions: null,
};

export function initAppContext(context) {
    Object.assign(appContext, context);
}

export function getAppContext() {
    return appContext;
}

export function getCurrentChatMetadata() {
    if (typeof appContext.getSillyTavernContext !== 'function') return null;
    try {
        const chatMetadata = appContext.getSillyTavernContext()?.chatMetadata;
        return chatMetadata && typeof chatMetadata === 'object' ? chatMetadata : null;
    } catch {
        return null;
    }
}
