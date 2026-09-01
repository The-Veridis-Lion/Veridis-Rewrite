// Owns in-memory Chinese dictionary package state and current installation-cancel marker; persisted dictionary metadata remains elsewhere.
export const zhRuntimeState = {
    zhDictionaryInstallCancelRequested: false,
    zhVariantDictionary: null,
};
