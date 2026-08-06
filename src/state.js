export const legacyExtensionName = "ultimate_purifier";
export const extensionName = "ultimate_purifier_ai_rewrite";
export const diffMetadataKey = `${extensionName}_diff_state_v3`;
export const minTrackedDiffMessages = 1;
export const defaultTrackedDiffMessages = 3;
export const maxTrackedDiffMessages = 20;
export const defaultDeepCleanTimeoutSec = 120;

export const defaultAiRewritePrompt = `你是文本局部改写助手。你会收到一整条 AI 回复作为文风参考，以及若干需要改写的分组。
每个 rewriteGroups 条目中的 instructions 和 localFallbackCandidates 只适用于同组 items。
只改写 rewriteGroups[].items 里列出的片段，不要扩写、总结、解释或改变剧情事实。
目标是去除命中的八股句式、夸张副词或不自然表达，同时尽量保持原文文风、语气、人物口吻和原意。
必须只返回 JSON，不要返回 markdown。

整条回复：
{{originalMessage}}

需要改写的分组与片段：
{{rewriteItemsJson}}

输出格式：
{"rewrites":[{"id":"hit-1","rewritten":"改写后的片段"}]}`;

export const defaultAiRewriteSettings = {
    enabled: true,
    enabledDefaultApplied: true,
    baseUrl: "",
    apiKey: "",
    model: "",
    modelOptions: [],
    temperature: 0.3,
    timeoutMs: 120000,
    timeoutDefault120sApplied: true,
    maxRetries: 2,
    maxItemsPerRequest: 20,
    maxItemsDefault20Applied: true,
    maxContextChars: 12000,
    maxRewriteCharsPerItem: 2000,
    streamingRoughPreview: true,
    xmlScopeTag: "content",
    promptTemplate: defaultAiRewritePrompt,
};

export const defaultSettings = {
    rules: [],
    presets: {},
    activePreset: "",
    defaultPreset: "",
    characterBindings: {},
    chatCompletionPresetBindings: {},
    scopeTags: [],
    scopeTagGroups: [{ id: "default", name: "默认分组" }],
    scopeTagCollapsedGroups: [],
    scopeTagBuiltinDismissed: [],
    scopeTagMode: "protect",
    enableVisualDiff: true,
    diffViewMode: "snippet",
    diffButtonInExtraMenu: false,
    showBottomDiffButton: true,
    diffTrackedMessageLimit: defaultTrackedDiffMessages,
    themeMode: "auto",
    logLevel: 2,  // 0=off, 1=error, 2=warn(default), 3=info, 4=debug
    skipUserMessages: false,
    realtimeMaskMode: "simple-visual",
    zhVariantCompatEnabled: false,
    zhVariantCompatOptions: { tw: true, hk: true },
    zhVariantDictionary: {
        status: "missing",
        packageVersion: "",
        verifiedAt: 0,
        bytes: 0,
        entries: 0,
        fileCount: 0,
        digest: "",
    },
    protectPersonaDescription: false,
    aiRewrite: { ...defaultAiRewriteSettings },
    legacySettingsCopied: false,
};

export const runtimeState = {
    activeProcessors: [],
    activeVisualProcessors: [],
    isRegexDirty: true,
    rulesUiDirty: true,
    presetsUiDirty: true,
    ruleSearchKeyword: "",
    ruleSearchDraftKeyword: "",
    ruleSearchHasSearched: false,
    ruleSearchExpandedMenuKey: "",
    searchEditFlow: {
        active: false,
        returnMode: "",
        ruleIndex: -1,
        subRuleIndex: -1,
    },
    currentEditingIndex: -1,
    currentEditingSubrules: [],
    currentSubruleEditIndex: -1,
    currentTransferRuleIndex: -1,
    lastCharacterContextKey: "",
    lastPresetBindingSignature: "",
    isStreamingGeneration: false,
    chatSaveTimer: null,
    chatSaveInFlight: false,
    pendingChatSave: false,
    chatSaveDelayCount: 0,
    isBooted: false,
    legacySettingsCopiedThisBoot: false,
    diffSnippetsCache: new Map(),
    diffRawSourceCache: new Map(),
    nonStreamingRawMessageCache: new Map(),
    streamingRawMessageCache: new Map(),
    diffMessageStates: new Map(),
    trackedDiffMessageOrder: [],
    hostRenderedEventSuppressUntil: new Map(),
    currentDiffIndex: undefined,
    diffModalRefresh: null,
    diffRelatedRuleMode: false,
    batchSelectedRuleIds: [],
    currentTransferRuleIndexes: [],
    importPresetDraft: null,
    deepCleanCancelRequested: false,
    zhDictionaryInstallCancelRequested: false,
    zhVariantDictionary: null,
    globalCleanseJob: null,
    aiRewrite: {
        activeController: null,
        activeTaskKey: "",
        activeTaskMeta: null,
        statusToast: null,
        statusTaskKey: "",
        debugEvents: [],
        pendingKeys: new Set(),
        startedKeys: new Set(),
        appliedKeys: new Set(),
        cancelledKeys: new Set(),
        readyNoticeKeys: new Set(),
        runningTaskMetaByKey: new Map(),
        finalCleanseSequence: 0,
        finalCleanseByMessageKey: new Map(),
        pendingApplyByKey: new Map(),
    },
};

const appContext = {
    extension_settings: null,
    saveSettingsDebounced: null,
    eventSource: null,
    event_types: null,
    getStreamingProcessor: null,
    saveChat: null,
    chat_metadata: null,
    chat: null,
    getSillyTavernContext: null,
    markWindowedChatDirtyFromIndex: null,
};

export function initAppContext(context) {
    Object.assign(appContext, context);
}

export function getAppContext() {
    return appContext;
}

function normalizeIntegerSetting(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(Math.round(parsed), min), max);
}

export function normalizeDiffTrackedMessageLimit(value) {
    return normalizeIntegerSetting(value, minTrackedDiffMessages, maxTrackedDiffMessages, defaultTrackedDiffMessages);
}

export function getDiffTrackedMessageLimit() {
    const settings = appContext.extension_settings?.[extensionName];
    return normalizeDiffTrackedMessageLimit(settings?.diffTrackedMessageLimit);
}

export function markRegexDirty(dirty = true) {
    runtimeState.isRegexDirty = dirty;
}

export function markRulesUiDirty(dirty = true) {
    runtimeState.rulesUiDirty = dirty;
}

export function markPresetsUiDirty(dirty = true) {
    runtimeState.presetsUiDirty = dirty;
}

export function markRulesDataDirty(options = {}) {
    const { rulesUi = true, presetsUi = false } = options;
    markRegexDirty(true);
    if (rulesUi) markRulesUiDirty(true);
    if (presetsUi) markPresetsUiDirty(true);
}
