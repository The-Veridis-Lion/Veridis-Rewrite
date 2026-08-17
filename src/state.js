export const legacyExtensionName = "ultimate_purifier";
export const extensionName = "ultimate_purifier_ai_rewrite";
export const modifiedExtensionName = "ultimate_purifier_ai_rewrite_modified";
export const diffMetadataKey = `${extensionName}_diff_state_v3`;
export const minTrackedDiffMessages = 1;
export const defaultTrackedDiffMessages = 3;
export const maxTrackedDiffMessages = 20;
export const defaultDeepCleanTimeoutSec = 120;

export const aiRewritePromptProtocolVersion = 2;

export const defaultAiRewritePrompt = `身份确认: 你是文本改写助手。你需要严格按照以下的要求修改指定的文本。

【任务说明】
<task>
核心要求: 你只能改写在 <rewrite_target> 标签中的文本，禁止过度扩写或改变原意。
分配规则: <rewrite_rules> 中每条指令只适用于 rules 属性引用该规则 ID 的 <rewrite_target>；<local_fallback_candidates> 中每组改写参考只适用于 candidates 属性引用该候选组 ID 的 <rewrite_target>，**禁止交叉**。
改写要求:
  - 按指令修改文本，保持原句意、文风或人设
  - 改写句子时，需确保修改后的句子自然流畅
文风参考: <source> 中不在 <rewrite_target> 标签内的文本不是改写对象，仅作文风与衔接参考。
对话标点: 当改写的文本包含对话(例如：“xxx”或：「xxx」或，“xxx”或，「xxx」)，改写后需保留原文的对话引号和引号前的标点(冒号或逗号)。
输出要求: 必须以 JSON 格式输出改写的内容，禁止使用 markdown。
</task>

【本次触发的改写规则】
<rewrite_rules>
{{rewriteRulesJson}}
</rewrite_rules>

【本次改写参考】
<local_fallback_candidates>
{{localFallbackCandidatesJson}}
</local_fallback_candidates>

【原文与改写对象】
改写范围: 你只能改写 <source> 中 <rewrite_target> 标签内的文本，禁止改写标签外的文本。每个 <rewrite_target> 的 id 是输出键，rules 是适用的规则 ID，candidates 是仅供该目标参考的候选组 ID。
<source>
{{annotatedSource}}
</source>

【输出格式】
格式要求: 严格输出一个 JSON 对象。对象的键必须是所有 <rewrite_target> 的 id，值必须是对应的改写结果字符串；不得遗漏、增加或重复 id，禁止出现 markdown 语法或额外文字。删除目标文本时返回空字符串。
输出示例:
{"hit-1":"改写结果1","hit-2":"改写结果2"}`;

export const defaultAiRewriteSettings = {
    enabled: true,
    enabledDefaultApplied: true,
    baseUrl: "",
    apiKey: "",
    model: "",
    modelOptions: [],
    apiPresets: {},
    activeApiPreset: "",
    temperature: 0.3,
    topP: 1,
    topK: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    repetitionPenalty: 1,
    maxTokens: 0,
    timeoutMs: 120000,
    timeoutDefault120sApplied: true,
    maxRetries: 2,
    maxItemsPerRequest: 20,
    maxItemsDefault20Applied: true,
    maxContextChars: 12000,
    maxRewriteCharsPerItem: 2000,
    xmlScopeTag: "content",
    protectXmlComments: false,
    promptTemplate: defaultAiRewritePrompt,
    promptProtocolVersion: aiRewritePromptProtocolVersion,
};

export function normalizeAiSamplingSettings(value = {}) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const readNumber = (key, min, max, fallback) => {
        const parsed = Number(source[key]);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(Math.max(parsed, min), max);
    };
    const readInteger = (key, min, max, fallback) => Math.round(readNumber(key, min, max, fallback));
    return {
        temperature: readNumber('temperature', 0, 2, defaultAiRewriteSettings.temperature),
        topP: readNumber('topP', 0, 1, defaultAiRewriteSettings.topP),
        topK: readInteger('topK', 0, 500, defaultAiRewriteSettings.topK),
        frequencyPenalty: readNumber('frequencyPenalty', -2, 2, defaultAiRewriteSettings.frequencyPenalty),
        presencePenalty: readNumber('presencePenalty', -2, 2, defaultAiRewriteSettings.presencePenalty),
        repetitionPenalty: readNumber('repetitionPenalty', 1, 2, defaultAiRewriteSettings.repetitionPenalty),
        maxTokens: readInteger('maxTokens', 0, 65536, defaultAiRewriteSettings.maxTokens),
    };
}

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
    showComposerAiRewriteButton: false,
    shujukuAutoProgramRewriteEnabled: false,
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
    modifiedSettingsImportedThisBoot: false,
    diffSnippetsCache: new Map(),
    diffRawSourceCache: new Map(),
    nonStreamingRawMessageCache: new Map(),
    streamingCommittedMessageCache: new Map(),
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
        statusToast: null,
        statusTaskKey: "",
        statusDismissedTaskKey: "",
        debugEvents: [],
        criticalDebugEvents: [],
        cancelledKeys: new Set(),
        runningTaskMetaByKey: new Map(),
        contentIdentityByGenerationId: new Map(),
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

export function normalizeShujukuAutoProgramRewriteEnabled(value) {
    return value === true;
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
