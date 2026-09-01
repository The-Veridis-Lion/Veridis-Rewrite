import { markPresetsUiDirty } from '../presets/state.js';

// Owns compiled Program processor cache and transient Rules editor/search UI state. Persisted Rules remain in extension settings.
export const rulesRuntimeState = {
    activeProcessors: [],
    activeVisualProcessors: [],
    isRegexDirty: true,
    rulesUiDirty: true,
    ruleSearchKeyword: '',
    ruleSearchDraftKeyword: '',
    ruleSearchHasSearched: false,
    ruleSearchExpandedMenuKey: '',
    searchEditFlow: {
        active: false,
        returnMode: '',
        ruleIndex: -1,
        subRuleIndex: -1,
    },
    currentEditingIndex: -1,
    currentEditingSubrules: [],
    currentSubruleEditIndex: -1,
    batchSelectedRuleIds: [],
    currentTransferRuleIndexes: [],
};

export function markRegexDirty(dirty = true) {
    rulesRuntimeState.isRegexDirty = dirty;
}

export function markRulesUiDirty(dirty = true) {
    rulesRuntimeState.rulesUiDirty = dirty;
}

export function markRulesDataDirty(options = {}) {
    const { rulesUi = true, presetsUi = false } = options;
    markRegexDirty(true);
    if (rulesUi) markRulesUiDirty(true);
    if (presetsUi) markPresetsUiDirty(true);
}
