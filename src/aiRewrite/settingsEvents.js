/**
 * Owns AI provider/settings and AI communication-monitor UI bindings.
 */
import { defaultAiRewriteSettings, extensionName, normalizeAiSamplingSettings } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { markRulesDataDirty } from '../rules/state.js';
import { logger } from '../log.js';
import { normalizeOptionalXmlTagNameInput, parseScopeTagInput } from '../scope/model.js';
import { showToast } from '../ui/notifications.js';
import { injectDiffButtons } from '../diff/view.js';
let aiApiCheckSequence = 0;

function resolveAiModelListBaseUrl(value) {
    const baseUrl = String(value || '').trim();
    if (!baseUrl) return '';
    try {
        const parsed = new URL(baseUrl);
        const pathname = parsed.pathname.replace(/\/+$/, '');
        if (parsed.hostname.toLowerCase() === 'qianfan.baidubce.com'
            && pathname === '/v2/tokenplan/personal') {
            parsed.pathname = '/v2';
            parsed.search = '';
            parsed.hash = '';
            return parsed.toString().replace(/\/$/, '');
        }
    } catch {
        return baseUrl;
    }
    return baseUrl;
}

export function bindAiSettingsEvents() {
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const settings = extension_settings[extensionName];
    const ensureAiRewriteSettings = () => {
        const currentAiSettings = settings.aiRewrite && typeof settings.aiRewrite === 'object'
            ? settings.aiRewrite
            : {};
        settings.aiRewrite = {
            ...defaultAiRewriteSettings,
            ...currentAiSettings,
            apiPresets: currentAiSettings.apiPresets && typeof currentAiSettings.apiPresets === 'object' && !Array.isArray(currentAiSettings.apiPresets)
                ? { ...currentAiSettings.apiPresets }
                : {},
        };
        settings.aiRewrite.xmlScopeTag = normalizeOptionalXmlTagNameInput(settings.aiRewrite.xmlScopeTag, defaultAiRewriteSettings.xmlScopeTag);
        settings.aiRewrite.activeApiPreset = String(settings.aiRewrite.activeApiPreset || '').trim();
        if (!Object.prototype.hasOwnProperty.call(settings.aiRewrite.apiPresets, settings.aiRewrite.activeApiPreset)) {
            settings.aiRewrite.activeApiPreset = '';
        }
        return settings.aiRewrite;
    };
    const getTavernHelperApi = () => {
        const direct = globalThis?.TavernHelper;
        if (direct) return direct;
        try {
            return globalThis?.parent?.TavernHelper || null;
        } catch {
            return null;
        }
    };
    const isLocalHttpUrl = (value) => {
        try {
            const parsed = new URL(String(value || '').trim());
            if (parsed.protocol !== 'http:') return true;
            return ['localhost', '127.0.0.1', '0.0.0.0', '[::1]', '::1'].includes(parsed.hostname);
        } catch {
            return true;
        }
    };
    const getAiTimeoutSeconds = (timeoutMs) => {
        const parsed = Number(timeoutMs);
        const fallback = Number(defaultAiRewriteSettings.timeoutMs) || 120000;
        const normalizedMs = Number.isFinite(parsed) ? parsed : fallback;
        return Math.min(Math.max(Math.round(normalizedMs / 1000), 1), 120);
    };
    const setAiApiCheckState = (state, title = '') => {
        const normalizedState = state || 'idle';
        const connectionLabels = {
            idle: '未检测',
            checking: '检测中',
            ok: '连接正常',
            failed: '连接失败',
            missing: '未配置',
            disabled: '未启用',
        };
        $('#blai-ai-connection-status')
            .attr('data-state', normalizedState)
            .text(connectionLabels[normalizedState]);
        $('#blai-ai-model-fetch')
            .toggleClass('accent', normalizedState === 'ok')
            .prop('disabled', normalizedState === 'checking')
            .attr('title', title || '通过酒馆助手拉取模型列表，不发送聊天消息')
            .attr('aria-label', normalizedState === 'checking' ? '正在刷新模型列表' : '刷新模型列表');
        $('#blai-ai-model-fetch i').toggleClass('fa-spin', normalizedState === 'checking');
    };
    const resetAiApiCheckState = () => {
        aiApiCheckSequence += 1;
        if (ensureAiRewriteSettings().enabled !== true) {
            setAiApiCheckState('disabled', 'AI 改写未启用，开启后再拉取模型列表。');
            return;
        }
        setAiApiCheckState('idle');
    };
    const normalizeAiModelOptions = (options) => {
        if (!Array.isArray(options)) return [];
        return [...new Set(options.map((value) => String(value || '').trim()).filter(Boolean))];
    };
    const syncAiModelSelect = (aiSettings) => {
        const $select = $('#blai-ai-model');
        if (!$select.length) return;
        const selectedModel = String(aiSettings.model || '').trim();
        const fetchedModels = normalizeAiModelOptions(aiSettings.modelOptions);
        const optionModels = selectedModel && !fetchedModels.includes(selectedModel)
            ? [selectedModel, ...fetchedModels]
            : fetchedModels;
        const fragment = document.createDocumentFragment();
        const placeholder = new Option(optionModels.length > 0 ? '请选择模型' : '先拉取模型列表', '');
        placeholder.disabled = optionModels.length > 0;
        fragment.appendChild(placeholder);
        optionModels.forEach((modelId) => fragment.appendChild(new Option(modelId, modelId)));
        $select.empty().append(fragment);
        $select.prop('disabled', optionModels.length === 0);
        $select.val(optionModels.includes(selectedModel) ? selectedModel : '');
    };
    const normalizeAiApiPresetSnapshot = (value = {}) => ({
        baseUrl: String(value.baseUrl || '').trim(),
        apiKey: String(value.apiKey || ''),
        model: String(value.model || '').trim(),
        modelOptions: normalizeAiModelOptions(value.modelOptions),
        ...normalizeAiSamplingSettings(value),
        xmlScopeTag: normalizeOptionalXmlTagNameInput(value.xmlScopeTag, defaultAiRewriteSettings.xmlScopeTag),
    });
    const getCurrentAiApiPresetSnapshot = (aiSettings = ensureAiRewriteSettings()) => normalizeAiApiPresetSnapshot(aiSettings);
    const isActiveAiApiPresetDirty = (aiSettings) => {
        const activeName = String(aiSettings.activeApiPreset || '');
        const activePreset = activeName ? aiSettings.apiPresets?.[activeName] : null;
        if (!activePreset) return false;
        return JSON.stringify(normalizeAiApiPresetSnapshot(activePreset)) !== JSON.stringify(normalizeAiApiPresetSnapshot(aiSettings));
    };
    const syncAiApiPresetSelect = (aiSettings) => {
        const $select = $('#blai-ai-api-preset');
        if (!$select.length) return;
        const activeName = String(aiSettings.activeApiPreset || '');
        const presetNames = Object.keys(aiSettings.apiPresets || {});
        const fragment = document.createDocumentFragment();
        const placeholder = new Option(presetNames.length > 0 ? '请选择 API 预设' : '暂无 API 预设', '');
        placeholder.disabled = true;
        fragment.appendChild(placeholder);
        presetNames.forEach((name) => {
            const label = name === activeName && isActiveAiApiPresetDirty(aiSettings) ? `${name}（未保存）` : name;
            fragment.appendChild(new Option(label, name));
        });
        $select.empty().append(fragment).val(activeName || '');
        $('#blai-ai-api-preset-edit, #blai-ai-api-preset-delete').prop('disabled', !activeName);
    };
    const saveCurrentAiApiPreset = ({ forceNew = false } = {}) => {
        const aiSettings = ensureAiRewriteSettings();
        let name = forceNew ? '' : String(aiSettings.activeApiPreset || '');
        if (!name) {
            const enteredName = prompt('输入 API 预设名称：');
            if (enteredName === null) return false;
            name = String(enteredName || '').trim();
            if (!name) {
                showToast('API 预设名称不能为空');
                return false;
            }
            if (Object.prototype.hasOwnProperty.call(aiSettings.apiPresets, name)
                && !confirm(`API 预设“${name}”已存在，是否覆盖？`)) return false;
        }
        aiSettings.apiPresets[name] = getCurrentAiApiPresetSnapshot(aiSettings);
        aiSettings.activeApiPreset = name;
        saveSettingsDebounced();
        syncAiRewriteSettingsUI();
        showToast(`API 预设已保存：${name}`);
        return true;
    };
    const renameActiveAiApiPreset = () => {
        const aiSettings = ensureAiRewriteSettings();
        const activeName = String(aiSettings.activeApiPreset || '');
        if (!activeName) return false;
        const enteredName = prompt('输入新的 API 预设名称：', activeName);
        if (enteredName === null) return false;
        const nextName = String(enteredName || '').trim();
        if (!nextName) {
            showToast('API 预设名称不能为空');
            return false;
        }
        if (nextName === activeName) return false;
        if (Object.prototype.hasOwnProperty.call(aiSettings.apiPresets, nextName)) {
            showToast(`API 预设“${nextName}”已存在`);
            return false;
        }
        aiSettings.apiPresets[nextName] = aiSettings.apiPresets[activeName];
        delete aiSettings.apiPresets[activeName];
        aiSettings.activeApiPreset = nextName;
        saveSettingsDebounced();
        syncAiRewriteSettingsUI();
        showToast(`API 预设已重命名：${nextName}`);
        return true;
    };
    const applyAiApiPreset = (name) => {
        const aiSettings = ensureAiRewriteSettings();
        const preset = aiSettings.apiPresets?.[name];
        if (!preset) return false;
        Object.assign(aiSettings, normalizeAiApiPresetSnapshot(preset), { activeApiPreset: name });
        saveSettingsDebounced();
        syncAiRewriteSettingsUI();
        resetAiApiCheckState();
        showToast(`已切换 API 预设：${name}`);
        return true;
    };
    const runAiModelsHealthCheck = async (options = {}) => {
        const { silent = false } = options;
        const aiSettings = ensureAiRewriteSettings();
        if (aiSettings.enabled !== true) {
            setAiApiCheckState('disabled', 'AI 改写未启用，开启后再拉取模型列表。');
            return false;
        }
        const apiurl = resolveAiModelListBaseUrl(aiSettings.baseUrl);
        const key = String(aiSettings.apiKey || '');
        if (!apiurl || !key) {
            setAiApiCheckState('missing', '需要先填写 API 地址和 API Key。');
            return false;
        }
        const tavernHelper = getTavernHelperApi();
        if (typeof tavernHelper?.getModelList !== 'function') {
            setAiApiCheckState('failed', 'TavernHelper.getModelList 不可用，请更新或启用酒馆助手。');
            if (!silent) showToast('酒馆助手模型列表接口不可用');
            return false;
        }
        const requestId = ++aiApiCheckSequence;
        setAiApiCheckState('checking', `正在通过酒馆助手从 ${apiurl} 拉取模型列表；不会发送聊天消息。`);
        try {
            const modelIds = normalizeAiModelOptions(await tavernHelper.getModelList({ apiurl, key }));
            if (requestId !== aiApiCheckSequence) return false;
            if (modelIds.length === 0) throw new Error('返回的模型列表为空');
            aiSettings.modelOptions = modelIds;
            if (!String(aiSettings.model || '').trim()) aiSettings.model = modelIds[0];
            saveSettingsDebounced();
            syncAiRewriteSettingsUI();
            const selectedModel = String(aiSettings.model || '').trim();
            const hasSelectedModel = !selectedModel || modelIds.includes(selectedModel);
            const title = hasSelectedModel
                ? `已拉取 ${modelIds.length} 个模型。`
                : `模型列表已拉取，但其中没有当前模型 ${selectedModel}。`;
            setAiApiCheckState('ok', title);
            if (!silent) showToast(`已拉取 ${modelIds.length} 个模型`);
            return true;
        } catch (error) {
            if (requestId !== aiApiCheckSequence) return false;
            const reason = error?.message || '请求失败';
            setAiApiCheckState('failed', `模型列表拉取失败：${reason}`);
            if (!silent) showToast(`模型列表拉取失败：${reason}`);
            logger.warn('酒馆助手模型列表拉取失败', reason);
            return false;
        }
    };
    const syncAiRewriteSettingsUI = () => {
        const aiSettings = ensureAiRewriteSettings();
        const setValueIfNotFocused = (selector, value) => {
            const $field = $(selector);
            if (!$field.is(':focus')) $field.val(value);
        };
        $('#blai-ai-enabled').prop('checked', aiSettings.enabled === true);
        $('#blai-ai-protect-comments').prop('checked', aiSettings.protectXmlComments === true);
        const xmlScopeTag = normalizeOptionalXmlTagNameInput(aiSettings.xmlScopeTag, defaultAiRewriteSettings.xmlScopeTag);
        setValueIfNotFocused('#blai-ai-base-url', aiSettings.baseUrl || '');
        setValueIfNotFocused('#blai-ai-xml-scope', xmlScopeTag ? `<${xmlScopeTag}>` : '');
        setValueIfNotFocused('#blai-ai-api-key', aiSettings.apiKey || '');
        syncAiApiPresetSelect(aiSettings);
        syncAiModelSelect(aiSettings);
        setValueIfNotFocused('#blai-ai-temperature', aiSettings.temperature);
        setValueIfNotFocused('#blai-ai-top-p', aiSettings.topP);
        setValueIfNotFocused('#blai-ai-top-k', aiSettings.topK);
        setValueIfNotFocused('#blai-ai-frequency-penalty', aiSettings.frequencyPenalty);
        setValueIfNotFocused('#blai-ai-presence-penalty', aiSettings.presencePenalty);
        setValueIfNotFocused('#blai-ai-repetition-penalty', aiSettings.repetitionPenalty);
        setValueIfNotFocused('#blai-ai-max-tokens', aiSettings.maxTokens);
        setValueIfNotFocused('#blai-ai-timeout', getAiTimeoutSeconds(aiSettings.timeoutMs));
        setValueIfNotFocused('#blai-ai-max-retries', aiSettings.maxRetries);
        setValueIfNotFocused('#blai-ai-max-items', aiSettings.maxItemsPerRequest);
        setValueIfNotFocused('#blai-ai-max-context', aiSettings.maxContextChars);
        setValueIfNotFocused('#blai-ai-prompt', aiSettings.promptTemplate || defaultAiRewriteSettings.promptTemplate);
        setValueIfNotFocused('#blai-ai-prompt-expanded', aiSettings.promptTemplate || defaultAiRewriteSettings.promptTemplate);
        $('#blai-ai-enabled-status').text(aiSettings.enabled === true ? 'AI 启用中' : 'AI 关闭中');
        if (aiSettings.enabled !== true) setAiApiCheckState('disabled', 'AI 改写未启用，开启后再拉取模型列表。');
        $('#blai-ai-http-warning').prop('hidden', isLocalHttpUrl(aiSettings.baseUrl));
    };
    const updateAiRewriteSetting = (key, value, options = {}) => {
        const aiSettings = ensureAiRewriteSettings();
        aiSettings[key] = value;
        if (['baseUrl', 'apiKey'].includes(key)) aiSettings.modelOptions = [];
        if (options.markRulesDirty !== false) markRulesDataDirty({ rulesUi: false });
        saveSettingsDebounced();
        syncAiRewriteSettingsUI();
        if (['enabled', 'baseUrl', 'apiKey', 'model'].includes(key)) resetAiApiCheckState();
    };
    const openAiPromptEditor = () => {
        const aiSettings = ensureAiRewriteSettings();
        $('#blai-ai-prompt-expanded').val(aiSettings.promptTemplate || defaultAiRewriteSettings.promptTemplate);
        $('#blai-ai-prompt-modal').addClass('blai-is-open');
        window.setTimeout(() => $('#blai-ai-prompt-expanded').trigger('focus'), 0);
    };
    const closeAiPromptEditor = () => {
        $('#blai-ai-prompt-modal').removeClass('blai-is-open');
    };
    const aiMobileLayoutMedia = window.matchMedia('(max-width: 600px)');
    const closeAiGenerationEditor = () => {
        $('#blai-ai-generation-modal')
            .removeClass('blai-is-open')
            .attr('aria-hidden', 'true');
        $('#blai-ai-generation-open').attr('aria-expanded', 'false');
    };
    const syncAiResponsiveLayout = () => {
        const $generationSection = $('#blai-ai-generation-section');
        const $temperatureField = $('.blai-temperature-field');
        const $secondaryColumn = $('.blai-ai-secondary-column');
        if (aiMobileLayoutMedia.matches) {
            $temperatureField.insertAfter('.blai-ai-xml-control');
            $generationSection.appendTo('#blai-ai-generation-modal-body');
            return;
        }
        closeAiGenerationEditor();
        $generationSection.appendTo($secondaryColumn);
        $temperatureField.prependTo($generationSection.find('.blai-ai-parameter-grid'));
    };
    const openAiGenerationEditor = () => {
        if (!aiMobileLayoutMedia.matches) return;
        $('#blai-ai-generation-modal')
            .addClass('blai-is-open')
            .attr('aria-hidden', 'false');
        $('#blai-ai-generation-open').attr('aria-expanded', 'true');
        $('#blai-ai-generation-modal-close').trigger('focus');
    };
    const applyAiPromptEditor = () => {
        const value = String($('#blai-ai-prompt-expanded').val() || defaultAiRewriteSettings.promptTemplate);
        $('#blai-ai-prompt').val(value);
        updateAiRewriteSetting('promptTemplate', value, { markRulesDirty: false });
        closeAiPromptEditor();
    };
    syncAiRewriteSettingsUI();
    syncAiResponsiveLayout();
    aiMobileLayoutMedia.addEventListener('change', syncAiResponsiveLayout);

    $(document).off('change', '#blai-ai-enabled').on('change', '#blai-ai-enabled', function() {
        const enabled = $(this).prop('checked') === true;
        const aiSettings = ensureAiRewriteSettings();
        aiSettings.enabledDefaultApplied = true;
        if (enabled && !isLocalHttpUrl(aiSettings.baseUrl)) showToast('当前 Base URL 使用非本地 HTTP，建议改用 HTTPS 或本地代理。');
        updateAiRewriteSetting('enabled', enabled);
    });

    $(document).off('change', '#blai-ai-api-preset').on('change', '#blai-ai-api-preset', function() {
        const aiSettings = ensureAiRewriteSettings();
        const nextName = String($(this).val() || '');
        if (!nextName || nextName === aiSettings.activeApiPreset) {
            syncAiApiPresetSelect(aiSettings);
            return;
        }
        if (isActiveAiApiPresetDirty(aiSettings)
            && !confirm(`API 预设“${aiSettings.activeApiPreset}”有未保存修改，是否放弃并切换？`)) {
            syncAiApiPresetSelect(aiSettings);
            return;
        }
        applyAiApiPreset(nextName);
    });

    $(document).off('click', '#blai-ai-api-preset-edit').on('click', '#blai-ai-api-preset-edit', function(e) {
        e.preventDefault();
        renameActiveAiApiPreset();
    });

    $(document).off('click', '#blai-ai-api-preset-new').on('click', '#blai-ai-api-preset-new', function(e) {
        e.preventDefault();
        saveCurrentAiApiPreset({ forceNew: true });
    });

    $(document).off('click', '#blai-ai-api-preset-save').on('click', '#blai-ai-api-preset-save', function(e) {
        e.preventDefault();
        saveCurrentAiApiPreset();
    });

    $(document).off('click', '#blai-ai-api-preset-delete').on('click', '#blai-ai-api-preset-delete', function(e) {
        e.preventDefault();
        const aiSettings = ensureAiRewriteSettings();
        const name = String(aiSettings.activeApiPreset || '');
        if (!name || !aiSettings.apiPresets?.[name]) return;
        if (!confirm(`确定删除 API 预设“${name}”吗？当前输入的连接配置会保留。`)) return;
        delete aiSettings.apiPresets[name];
        aiSettings.activeApiPreset = '';
        saveSettingsDebounced();
        syncAiRewriteSettingsUI();
        showToast(`已删除 API 预设：${name}`);
    });

    $(document).off('input change', '#blai-ai-base-url').on('input change', '#blai-ai-base-url', function() {
        updateAiRewriteSetting('baseUrl', String($(this).val() || '').trim());
    });

    $(document).off('change', '#blai-ai-protect-comments').on('change', '#blai-ai-protect-comments', function() {
        updateAiRewriteSetting('protectXmlComments', $(this).prop('checked') === true);
    });

    $(document).off('change blur', '#blai-ai-xml-scope').on('change blur', '#blai-ai-xml-scope', function() {
        const rawValue = String($(this).val() || '').trim();
        if (!rawValue) {
            updateAiRewriteSetting('xmlScopeTag', '');
            return;
        }
        const parsed = parseScopeTagInput(rawValue);
        if (!parsed.ok) {
            showToast(`AI XML 标签无效：${parsed.error?.message || '请填写标签名'}`);
            syncAiRewriteSettingsUI();
            return;
        }
        updateAiRewriteSetting('xmlScopeTag', parsed.value.tagName);
    });

    $(document).off('input change', '#blai-ai-api-key').on('input change', '#blai-ai-api-key', function() {
        updateAiRewriteSetting('apiKey', String($(this).val() || ''), { markRulesDirty: false });
    });

    $(document).off('input change', '#blai-ai-model').on('input change', '#blai-ai-model', function() {
        updateAiRewriteSetting('model', String($(this).val() || '').trim(), { markRulesDirty: false });
    });

    $(document).off('input change', '#blai-ai-temperature, #blai-ai-top-p, #blai-ai-top-k, #blai-ai-frequency-penalty, #blai-ai-presence-penalty, #blai-ai-repetition-penalty, #blai-ai-max-tokens, #blai-ai-timeout, #blai-ai-max-retries, #blai-ai-max-items, #blai-ai-max-context').on('input change', '#blai-ai-temperature, #blai-ai-top-p, #blai-ai-top-k, #blai-ai-frequency-penalty, #blai-ai-presence-penalty, #blai-ai-repetition-penalty, #blai-ai-max-tokens, #blai-ai-timeout, #blai-ai-max-retries, #blai-ai-max-items, #blai-ai-max-context', function() {
        const id = String(this.id || '');
        const value = Number($(this).val());
        const keyMap = {
            'blai-ai-temperature': 'temperature',
            'blai-ai-top-p': 'topP',
            'blai-ai-top-k': 'topK',
            'blai-ai-frequency-penalty': 'frequencyPenalty',
            'blai-ai-presence-penalty': 'presencePenalty',
            'blai-ai-repetition-penalty': 'repetitionPenalty',
            'blai-ai-max-tokens': 'maxTokens',
            'blai-ai-timeout': 'timeoutMs',
            'blai-ai-max-retries': 'maxRetries',
            'blai-ai-max-items': 'maxItemsPerRequest',
            'blai-ai-max-context': 'maxContextChars',
        };
        const key = keyMap[id];
        const samplingKeys = new Set(['temperature', 'topP', 'topK', 'frequencyPenalty', 'presencePenalty', 'repetitionPenalty', 'maxTokens']);
        const normalizedValue = samplingKeys.has(key)
            ? normalizeAiSamplingSettings({ [key]: value })[key]
            : id === 'blai-ai-timeout'
            ? Math.min(Math.max(Math.round(value || 0), 1), 120) * 1000
            : value;
        updateAiRewriteSetting(key, normalizedValue, { markRulesDirty: false });
    });

    $(document).off('input change', '#blai-ai-prompt').on('input change', '#blai-ai-prompt', function() {
        updateAiRewriteSetting('promptTemplate', String($(this).val() || defaultAiRewriteSettings.promptTemplate), { markRulesDirty: false });
    });

    $(document).off('click', '#blai-ai-prompt-expand').on('click', '#blai-ai-prompt-expand', function(e) {
        e.preventDefault();
        openAiPromptEditor();
    });

    $(document).off('click', '#blai-ai-generation-open').on('click', '#blai-ai-generation-open', function(e) {
        e.preventDefault();
        openAiGenerationEditor();
    });

    $(document).off('click', '#blai-ai-generation-modal-close, #blai-ai-generation-modal-done').on('click', '#blai-ai-generation-modal-close, #blai-ai-generation-modal-done', function(e) {
        e.preventDefault();
        closeAiGenerationEditor();
        $('#blai-ai-generation-open').trigger('focus');
    });

    $(document).off('click', '#blai-ai-generation-modal').on('click', '#blai-ai-generation-modal', function(e) {
        if (e.target === this) closeAiGenerationEditor();
    });

    $(document).off('keydown.blaiAiGenerationModal').on('keydown.blaiAiGenerationModal', function(e) {
        if (e.key === 'Escape' && $('#blai-ai-generation-modal').hasClass('blai-is-open')) {
            e.preventDefault();
            closeAiGenerationEditor();
            $('#blai-ai-generation-open').trigger('focus');
        }
    });

    $(document).off('click', '#blai-ai-prompt-modal-close, #blai-ai-prompt-modal-cancel').on('click', '#blai-ai-prompt-modal-close, #blai-ai-prompt-modal-cancel', function(e) {
        e.preventDefault();
        closeAiPromptEditor();
    });

    $(document).off('click', '#blai-ai-prompt-modal').on('click', '#blai-ai-prompt-modal', function(e) {
        if (e.target === this) closeAiPromptEditor();
    });

    $(document).off('click', '#blai-ai-prompt-modal-apply').on('click', '#blai-ai-prompt-modal-apply', function(e) {
        e.preventDefault();
        applyAiPromptEditor();
    });

    $(document).off('keydown', '#blai-ai-prompt-expanded').on('keydown', '#blai-ai-prompt-expanded', function(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeAiPromptEditor();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 's') {
            e.preventDefault();
            applyAiPromptEditor();
        }
    });

    $(document).off('click', '#blai-ai-api-key-reveal').on('click', '#blai-ai-api-key-reveal', function(e) {
        e.preventDefault();
        const $input = $('#blai-ai-api-key');
        const nextType = $input.attr('type') === 'password' ? 'text' : 'password';
        $input.attr('type', nextType);
        $(this).find('i').attr('class', nextType === 'password' ? 'fas fa-eye' : 'fas fa-eye-slash');
    });

    $(document).off('click', '#blai-ai-api-key-clear').on('click', '#blai-ai-api-key-clear', function(e) {
        e.preventDefault();
        updateAiRewriteSetting('apiKey', '', { markRulesDirty: false });
        showToast('API Key 已清空');
    });

    $(document).off('click', '#blai-ai-model-fetch').on('click', '#blai-ai-model-fetch', function(e) {
        e.preventDefault();
        void runAiModelsHealthCheck({ silent: false });
    });

    if (settings.enableVisualDiff === false) {
        settings.enableVisualDiff = true;
        saveSettingsDebounced();
        injectDiffButtons();
    }

}
