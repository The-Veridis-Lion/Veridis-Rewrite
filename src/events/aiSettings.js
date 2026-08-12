/**
 * Owns theme, Chinese dictionary, and AI provider/settings UI bindings.
 */
import { defaultAiRewriteSettings, extensionName, getAppContext, normalizeAiSamplingSettings, runtimeState, markRulesDataDirty } from '../state.js';
import { logger } from '../log.js';
import { normalizeOptionalXmlTagNameInput, parseScopeTagInput, resolveAiModelListBaseUrl } from '../utils.js';
import {
    showToast,
    openZhDictionaryModal,
    closeZhDictionaryModal,
    showZhDictionaryInstallOverlay,
    updateZhDictionaryInstallOverlay,
    closeLoadingOverlay,
} from '../ui.js';
import { performGlobalCleanse } from '../core.js';
import { injectDiffButtons } from '../diff.js';
import { getAiRewriteDebugLogText } from '../aiRewrite.js';
import {
    downloadZhDictionaryPackage,
    getZhDictionaryPackageStats,
    getZhDictionaryPackageStatus,
    getZhVariantCompatOptions,
    isZhDictionaryReady,
    markZhDictionaryInstallFailed,
    restoreZhDictionaryPackageFromCache,
} from '../zhConversion.js';

let zhDictionaryInstallAbortController = null;
let aiApiCheckSequence = 0;

export function bindAiSettingsEvents() {
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const settings = extension_settings[extensionName];
    const applyThemeMode = (mode) => {
        const normalized = ['auto', 'light', 'dark'].includes(mode) ? mode : 'auto';
        const labels = {
            auto: '跟随酒馆',
            light: '白色主题',
            dark: '暗色主题',
        };
        const icons = {
            auto: 'fa-circle-half-stroke',
            light: 'fa-sun',
            dark: 'fa-moon',
        };
        settings.themeMode = normalized;
        $('#blai-purifier-popup, .blai-modal-shell, #blai-rule-transfer-modal, #blai-diff-modal, #blai-rule-search-modal, #blai-preset-import-choice-modal, .blai-toast, #blai-loading-overlay, #blai-scope-tag-editor-modal').attr('data-blai-theme', normalized);
        $('#blai-theme-toggle, #blai-purifier-popup [data-blai-click-proxy="#blai-theme-toggle"]')
            .attr('title', `当前主题：${labels[normalized]}，点击切换`)
            .attr('aria-label', `当前主题：${labels[normalized]}，点击切换`);
        $('#blai-theme-toggle i, #blai-purifier-popup [data-blai-click-proxy="#blai-theme-toggle"] i').attr('class', `fas ${icons[normalized]}`);
    };
    const syncZhCompatToggle = () => {
        const packageStatus = getZhDictionaryPackageStatus(settings);
        const ready = settings.zhVariantCompatEnabled === true
            ? isZhDictionaryReady(settings)
            : packageStatus.ready;
        if (settings.zhVariantCompatEnabled === true && !ready) {
            settings.zhVariantCompatEnabled = false;
        }
        const enabled = settings.zhVariantCompatEnabled === true && ready;
        const options = getZhVariantCompatOptions(settings);
        const regionText = [
            options.tw ? '台繁' : '',
            options.hk ? '港繁' : '',
        ].filter(Boolean).join('、') || '标准简繁';
        $('#blai-zh-dict-status-chip').text(enabled ? '已启用' : packageStatus.ready ? '已安装' : '未安装');
        $('#blai-zh-dict-install-open')
            .toggleClass('accent', !enabled)
            .attr('title', enabled ? '增强简繁词典已启用' : packageStatus.ready ? '增强简繁词典已安装，点击启用' : '下载并启用增强简繁词典');
        $('#blai-zh-compat-toggle')
            .toggleClass('blai-bind-active', enabled)
            .toggleClass('accent', enabled)
            .text(enabled ? '关闭' : '开启')
            .attr('aria-pressed', String(enabled))
            .attr('title', enabled
                ? `简繁兼容已开启：${regionText} 变体参与匹配（点击关闭）`
                : packageStatus.ready
                    ? `简繁兼容已关闭：已安装增强词典，点击启用 ${regionText} 匹配`
                    : '简繁兼容未安装：点击下载 OpenCC 增强词典包');
    };
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
    const setAiApiCheckState = (state, label, title = '') => {
        const normalizedState = state || 'idle';
        $('#blai-ai-api-check')
            .attr('data-state', normalizedState)
            .attr('title', title || '通过酒馆助手拉取模型列表，不发送聊天消息。')
            .attr('aria-label', `模型列表：${label}`);
        $('#blai-ai-api-status').text(label);
        $('#blai-ai-model-fetch')
            .toggleClass('accent', normalizedState === 'ok')
            .prop('disabled', normalizedState === 'checking')
            .text(normalizedState === 'checking' ? '拉取中' : '拉取模型')
            .attr('title', title || '通过酒馆助手拉取模型列表，不发送聊天消息');
    };
    const resetAiApiCheckState = () => {
        aiApiCheckSequence += 1;
        if (ensureAiRewriteSettings().enabled !== true) {
            setAiApiCheckState('disabled', '未启用', 'AI 改写未启用，开启后再拉取模型列表。');
            return;
        }
        setAiApiCheckState('idle', '拉取');
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
        $('#blai-ai-api-preset-delete').prop('disabled', !activeName);
    };
    const saveCurrentAiApiPreset = (options = {}) => {
        const aiSettings = ensureAiRewriteSettings();
        const forceNew = options.forceNew === true;
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
            setAiApiCheckState('disabled', '未启用', 'AI 改写未启用，开启后再拉取模型列表。');
            return false;
        }
        const apiurl = resolveAiModelListBaseUrl(aiSettings.baseUrl);
        const key = String(aiSettings.apiKey || '');
        if (!apiurl || !key) {
            setAiApiCheckState('missing', '未配置', '需要先填写 API 地址和 API Key。');
            return false;
        }
        const tavernHelper = getTavernHelperApi();
        if (typeof tavernHelper?.getModelList !== 'function') {
            setAiApiCheckState('failed', '不可用', 'TavernHelper.getModelList 不可用，请更新或启用酒馆助手。');
            if (!silent) showToast('酒馆助手模型列表接口不可用');
            return false;
        }
        const requestId = ++aiApiCheckSequence;
        setAiApiCheckState('checking', '检测中', `正在通过酒馆助手从 ${apiurl} 拉取模型列表；不会发送聊天消息。`);
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
            setAiApiCheckState('ok', '正常', title);
            if (!silent) showToast(`已拉取 ${modelIds.length} 个模型`);
            return true;
        } catch (error) {
            if (requestId !== aiApiCheckSequence) return false;
            const reason = error?.message || '请求失败';
            setAiApiCheckState('failed', '失败', `模型列表拉取失败：${reason}`);
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
        setValueIfNotFocused('#blai-ai-max-rewrite', aiSettings.maxRewriteCharsPerItem);
        setValueIfNotFocused('#blai-ai-prompt', aiSettings.promptTemplate || defaultAiRewriteSettings.promptTemplate);
        setValueIfNotFocused('#blai-ai-prompt-expanded', aiSettings.promptTemplate || defaultAiRewriteSettings.promptTemplate);
        if (aiSettings.enabled !== true) setAiApiCheckState('disabled', '未启用', 'AI 改写未启用，开启后再拉取模型列表。');
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
    const enableVerifiedZhCompat = (toastMessage = '简繁兼容已开启') => {
        if (!restoreZhDictionaryPackageFromCache(settings)) return false;
        settings.zhVariantCompatEnabled = true;
        markRulesDataDirty({ rulesUi: false });
        saveSettingsDebounced();
        syncZhCompatToggle();
        performGlobalCleanse();
        showToast(toastMessage);
        return true;
    };
    const openZhDictionaryInstallPrompt = () => {
        const stats = getZhDictionaryPackageStats();
        openZhDictionaryModal(stats, getZhVariantCompatOptions(settings));
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
    const applyAiPromptEditor = () => {
        const value = String($('#blai-ai-prompt-expanded').val() || defaultAiRewriteSettings.promptTemplate);
        $('#blai-ai-prompt').val(value);
        updateAiRewriteSetting('promptTemplate', value, { markRulesDirty: false });
        closeAiPromptEditor();
    };
    const runZhDictionaryInstall = async () => {
        if (zhDictionaryInstallAbortController) return;
        settings.zhVariantCompatOptions = {
            tw: $('#blai-zh-dict-tw').prop('checked') === true,
            hk: $('#blai-zh-dict-hk').prop('checked') === true,
        };
        settings.zhVariantCompatEnabled = false;
        saveSettingsDebounced();
        closeZhDictionaryModal();

        zhDictionaryInstallAbortController = new AbortController();
        showZhDictionaryInstallOverlay(() => {
            zhDictionaryInstallAbortController?.abort();
        });

        try {
            await downloadZhDictionaryPackage({
                signal: zhDictionaryInstallAbortController.signal,
                onProgress: ({ ratio, statusText }) => updateZhDictionaryInstallOverlay(ratio, statusText),
            });
            settings.zhVariantCompatEnabled = true;
            markRulesDataDirty({ rulesUi: false });
            saveSettingsDebounced();
            syncZhCompatToggle();
            performGlobalCleanse();
            showToast('增强简繁词典已安装并启用');
        } catch (error) {
            const message = markZhDictionaryInstallFailed(error);
            settings.zhVariantCompatEnabled = false;
            markRulesDataDirty({ rulesUi: false });
            saveSettingsDebounced();
            syncZhCompatToggle();
            if (error?.name === 'AbortError') showToast('已取消词典下载');
            else showToast(`词典安装失败：${message}`);
        } finally {
            zhDictionaryInstallAbortController = null;
            window.setTimeout(() => closeLoadingOverlay(), 260);
        }
    };
    applyThemeMode(settings.themeMode || 'auto');
    syncZhCompatToggle();
    syncAiRewriteSettingsUI();

    $(document).off('click', '#blai-theme-toggle').on('click', '#blai-theme-toggle', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const modes = ['auto', 'light', 'dark'];
        const current = String(settings.themeMode || 'auto');
        const nextMode = modes[(Math.max(0, modes.indexOf(current)) + 1) % modes.length];
        applyThemeMode(nextMode);
        saveSettingsDebounced();
        showToast(`已切换主题：${nextMode === 'auto' ? '跟随酒馆' : nextMode === 'light' ? '白色主题' : '暗色主题'}`);
    });

    $(document).off('click', '#blai-zh-dict-install-open').on('click', '#blai-zh-dict-install-open', function(e) {
        e.preventDefault();
        if (settings.zhVariantCompatEnabled === true && isZhDictionaryReady(settings)) {
            showToast('增强简繁词典已启用');
            return;
        }
        if (enableVerifiedZhCompat()) return;
        openZhDictionaryInstallPrompt();
    });

    $(document).off('click.blaiBindMenu').on('click.blaiBindMenu', function(e) {
        if ($(e.target).closest('.blai-bind-menu-wrap').length > 0) return;
        $('#blai-bind-menu').prop('hidden', true);
        $('#blai-character-bind-toggle').attr('aria-expanded', 'false');
    });

    $(document).off('click', '#blai-zh-compat-toggle').on('click', '#blai-zh-compat-toggle', function(e) {
        e.preventDefault();
        if (settings.zhVariantCompatEnabled === true && isZhDictionaryReady(settings)) {
            settings.zhVariantCompatEnabled = false;
            markRulesDataDirty({ rulesUi: false });
            saveSettingsDebounced();
            syncZhCompatToggle();
            performGlobalCleanse();
            showToast('简繁兼容已关闭');
            return;
        }

        if (enableVerifiedZhCompat()) return;
        openZhDictionaryInstallPrompt();
    });

    $(document).off('click', '#blai-zh-dict-close, #blai-zh-dict-cancel').on('click', '#blai-zh-dict-close, #blai-zh-dict-cancel', function(e) {
        e.preventDefault();
        closeZhDictionaryModal();
    });

    $(document).off('click', '#blai-zh-dict-download').on('click', '#blai-zh-dict-download', function(e) {
        e.preventDefault();
        runZhDictionaryInstall();
    });

    $(document).off('change', '#blai-ai-enabled').on('change', '#blai-ai-enabled', function() {
        const enabled = $(this).prop('checked') === true;
        const aiSettings = ensureAiRewriteSettings();
        aiSettings.enabledDefaultApplied = true;
        if (enabled && !isLocalHttpUrl(aiSettings.baseUrl)) showToast('当前 Base URL 使用非本地 HTTP，建议改用 HTTPS 或本地代理。');
        updateAiRewriteSetting('enabled', enabled);
    });

    $(document).off('click', '#blai-ai-copy-log').on('click', '#blai-ai-copy-log', async function(e) {
        e.preventDefault();
        const logText = getAiRewriteDebugLogText();
        if (!logText || logText === '[]') {
            showToast('暂无 AI 改写日志');
            return;
        }
        try {
            const tavernHelper = getTavernHelperApi();
            if (typeof tavernHelper?.builtin?.copyText !== 'function') {
                throw new Error('TavernHelper.builtin.copyText 不可用');
            }
            await tavernHelper.builtin.copyText(logText);
            showToast('AI Debug 日志已复制');
        } catch (error) {
            logger.warn('复制 AI 改写日志失败', error);
            showToast('复制 Debug 日志失败，请更新或启用酒馆助手');
        }
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

    $(document).off('input change', '#blai-ai-temperature, #blai-ai-top-p, #blai-ai-top-k, #blai-ai-frequency-penalty, #blai-ai-presence-penalty, #blai-ai-repetition-penalty, #blai-ai-max-tokens, #blai-ai-timeout, #blai-ai-max-retries, #blai-ai-max-items, #blai-ai-max-context, #blai-ai-max-rewrite').on('input change', '#blai-ai-temperature, #blai-ai-top-p, #blai-ai-top-k, #blai-ai-frequency-penalty, #blai-ai-presence-penalty, #blai-ai-repetition-penalty, #blai-ai-max-tokens, #blai-ai-timeout, #blai-ai-max-retries, #blai-ai-max-items, #blai-ai-max-context, #blai-ai-max-rewrite', function() {
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
            'blai-ai-max-rewrite': 'maxRewriteCharsPerItem',
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
