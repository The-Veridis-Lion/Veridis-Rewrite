// Owns persisted Veridis settings defaults and pure setting normalizers only.
export const legacyExtensionName = "ultimate_purifier";
export const extensionName = "ultimate_purifier_ai_rewrite";
export const modifiedExtensionName = "ultimate_purifier_ai_rewrite_modified";
export const minTrackedDiffMessages = 1;
export const defaultTrackedDiffMessages = 3;
export const maxTrackedDiffMessages = 20;
export const aiRewritePromptProtocolVersion = 5;

export const previousDefaultAiRewritePrompt = `身份确认: 你是文本改写助手。你需要严格按照以下的要求修改指定的文本。

【任务说明】
<task>
核心要求: 执行分配给目标的 AI 规则。你只能改写在 <rewrite_target> 标签中的完整目标句子。
分配规则: <rewrite_rules> 中每条指令只适用于 rules 属性引用该规则 ID 的 <rewrite_target>。
改写要求:
  - 完整目标句子可在必要时进行句内润色
  - 保持句子已有含义、角色声音、叙事风格、视角和事实内容
  - 必要时可调整语序、动词、冗余修饰、标点和句内措辞，使表达自然
  - 润色只能重新表达句中已有信息
  - 不得新增动作、思想或心理、事实、环境细节、情节事件、设定信息、解释或因果主张
  - 不得仅为润色而扩写句子
  - 返回完整的结果句子
文风参考: <source> 中不在 <rewrite_target> 标签内的文本不是改写对象，仅作文风与衔接参考。
对话标点: 当改写的文本包含对话(例如：“xxx”或：「xxx」或，“xxx”或，「xxx」)，改写后需保留原文的对话引号和引号前的标点(冒号或逗号)。
输出要求: 必须以 JSON 格式输出改写的内容，禁止使用 markdown。
</task>

【本次触发的改写规则】
<rewrite_rules>
{{rewriteRulesJson}}
</rewrite_rules>

【原文与改写对象】
改写范围: 你只能改写 <source> 中 <rewrite_target> 标签内的文本，禁止改写标签外的文本。每个 <rewrite_target> 的 id 是输出键，rules 是适用的规则 ID。
<source>
{{annotatedSource}}
</source>

【输出格式】
格式要求: 严格输出一个 JSON 对象。对象的键必须是所有 <rewrite_target> 的 id，值必须是替换对应完整目标句子的完整结果字符串；不得遗漏、增加或重复 id，禁止出现 markdown 语法或额外文字。删除整个目标句子时返回空字符串。
输出示例:
{"hit-1":"改写结果1","hit-2":"改写结果2"}`;

export const tongYong13AiRewritePrompt = `身份确认: 你是文本改写助手。你需要严格按照以下的要求修改指定的文本。

【任务说明】
<task>
核心要求: 你只能改写在 <rewrite_target> 标签中的文本，禁止过度扩写或改变原意。
分配规则:
  - <rewrite_rules> 中每条改写指令只适用于 rules 属性引用该规则 ID 的 <rewrite_target>
  - <rewrite_reference> 中每组改写参考只适用于 candidates 属性引用该候选组 ID 的 <rewrite_target>
  - 不同 id 的 <rewrite_target> 禁止交叉使用 rules 属性 或 candidates 属性
改写要求:
  - 按指令修改文本，保持原句意、文风或人设
  - 改写句子时，需确保修改后的句子自然流畅
文风参考: 改写文本时可以将 <original_text> 作为文风和衔接的参考；<original_text> 中只有 <rewrite_target> 标签内的文本为改写对象，不可改写其他文本。
对话标点: 当改写的文本包含对话时，改写后需保留原文的对话标点。
输出要求: 必须以 JSON 格式输出改写的内容，禁止使用 markdown。
</task>

【本次触发的改写规则】
<rewrite_rules>
{{rewriteRulesJson}}
</rewrite_rules>

【本次改写参考】
<rewrite_reference>
{{localFallbackCandidatesJson}}
</rewrite_reference>

【原文与改写对象】
改写范围: 你只能改写 <original_text> 中 <rewrite_target> 标签内的文本，禁止改写标签外的文本。每个 <rewrite_target> 的 id 是输出键，rules 是适用的规则 ID，candidates 是仅供该目标参考的候选组 ID。
<original_text>
{{annotatedSource}}
</original_text>

【输出格式】
格式要求: 严格输出一个 JSON 对象，其内部的键必须是所有 <rewrite_target> 的 id，值必须是 id 对应的改写结果字符串；不得遗漏、增加或重复 id，禁止出现 markdown 语法。删除目标文本时返回空字符串。
输出示例:
{"hit-1":"改写结果1","hit-2":"改写结果2"}`;

export const defaultAiRewritePrompt = `身份确认: 你是文本改写助手。你需要严格按照以下要求修改指定文本。

【任务说明】\x20
<task>
核心要求:
* 只能改写 <rewrite_target> 标签中的文本。
* 每个 <rewrite_target> 只适用其 rules 属性引用的 <rewrite_rules>，按照对应规则的改写要求处理。
* 同一目标绑定多个规则时，需要同时考虑所有适用规则。
* 处理规则命中后，根据 <source> 中已有的前后文对整个目标句进行自然润色，使语法、措辞、指代、语气、节奏和衔接自然。
* 不要只机械删除或替换命中词后原样返回剩余文本；可以在不改变原意的前提下重新组织整个目标句。
* 保持原意、人物关系、人设、叙事视角和文风，不得无依据扩写剧情、动作、心理、事实或新的修辞内容。
* <rewrite_target> 标签外文本仅用于理解上下文和文风，不得修改或返回。

对话标点:
* 当目标句包含对话时，保留原有对话引号以及必要的冒号或逗号，除非对应规则本身要求修改相关内容。

输出要求:
* 每个结果必须是对应 <rewrite_target> 改写后的完整句子。
* 如果对应规则允许删除整个目标句，可以返回空字符串。
* 必须严格输出 JSON 对象，禁止 markdown、解释、分析或额外文字。
\x20 </task>

【本次触发的改写规则】
<rewrite_rules>
{{rewriteRulesJson}}
</rewrite_rules>

【原文与改写对象】
<source>
{{annotatedSource}}\x20
</source>

【输出格式】
严格输出一个 JSON 对象。键必须恰好为所有 <rewrite_target> 的 id，值必须是对应目标改写后的完整结果；不得遗漏、增加或重复 id，不得返回标签外文本。
{"hit-1":"改写后的完整句子","hit-2":"改写后的完整句子"}`;

export function normalizeAiRewritePromptForComparison(promptTemplate) {
    return String(promptTemplate || '')
        .replace(/\r\n?/gu, '\n')
        .split('\n')
        .map((line) => line.replace(/[\t ]+$/gu, ''))
        .join('\n')
        .trim();
}

export function isKnownBuiltInAiRewritePrompt(promptTemplate) {
    const normalized = normalizeAiRewritePromptForComparison(promptTemplate);
    return normalized === normalizeAiRewritePromptForComparison(previousDefaultAiRewritePrompt)
        || normalized === normalizeAiRewritePromptForComparison(tongYong13AiRewritePrompt);
}

export function migrateKnownAiRewritePrompt(promptTemplate) {
    return isKnownBuiltInAiRewritePrompt(promptTemplate)
        ? defaultAiRewritePrompt
        : String(promptTemplate || '');
}

export function needsCustomGlobalPromptMigrationConfirmation(aiRewrite) {
    if (!aiRewrite || typeof aiRewrite !== 'object') return false;
    const promptTemplate = String(aiRewrite.promptTemplate || '');
    return aiRewrite.globalPromptMigrationDecisionMade !== true
        && Boolean(promptTemplate)
        && !isKnownBuiltInAiRewritePrompt(promptTemplate)
        && promptTemplate !== defaultAiRewritePrompt;
}

export function resolveCustomGlobalPromptMigration(aiRewrite, accepted) {
    if (!aiRewrite || typeof aiRewrite !== 'object') return;
    if (accepted) aiRewrite.promptTemplate = defaultAiRewritePrompt;
    aiRewrite.promptProtocolVersion = aiRewritePromptProtocolVersion;
    aiRewrite.globalPromptMigrationDecisionMade = true;
}

export function applyGemini31TemperatureMigration(aiRewrite) {
    if (!aiRewrite || typeof aiRewrite !== 'object' || aiRewrite.gemini31TemperatureMigrationApplied === true) return;
    if (aiRewrite.model === 'gemini-3.1-pro-preview') aiRewrite.temperature = 1.0;
    Object.values(aiRewrite.apiPresets || {}).forEach((preset) => {
        if (preset?.model === 'gemini-3.1-pro-preview') preset.temperature = 1.0;
    });
    aiRewrite.gemini31TemperatureMigrationApplied = true;
}

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
    xmlScopeTag: "content",
    protectXmlComments: false,
    promptTemplate: defaultAiRewritePrompt,
    promptProtocolVersion: aiRewritePromptProtocolVersion,
    globalPromptMigrationDecisionMade: true,
    gemini31TemperatureMigrationApplied: true,
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
    guidedTourSeen: {
        main: false,
        deepClean: false,
    },
    aiRewrite: { ...defaultAiRewriteSettings },
    legacySettingsCopied: false,
};

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
