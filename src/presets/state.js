// Owns transient Preset UI/application state only; persisted Presets and bindings remain in extension settings.
export const presetsRuntimeState = {
    presetsUiDirty: true,
    lastPresetBindingSignature: '',
    importPresetDraft: null,
};

export function markPresetsUiDirty(dirty = true) {
    presetsRuntimeState.presetsUiDirty = dirty;
}
