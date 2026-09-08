import { markPresetsUiDirty } from '../presets/state.js';

// Owns final Program and streaming processor sets under one invalidation boundary.
// Persisted Rules remain in extension settings.
export const programRuntimeState = {
    activeProcessors: [],
    streamingProcessors: [],
    isRegexDirty: true,
};

// Owns the transient Rules UI/editor session independently of the Program cache.
export const rulesUiState = {
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
    programRuntimeState.isRegexDirty = dirty;
}

export function markRulesUiDirty(dirty = true) {
    rulesUiState.rulesUiDirty = dirty;
}

export function markRulesDataDirty(options = {}) {
    const { rulesUi = true, presetsUi = false } = options;
    markRegexDirty(true);
    if (rulesUi) markRulesUiDirty(true);
    if (presetsUi) markPresetsUiDirty(true);
}
