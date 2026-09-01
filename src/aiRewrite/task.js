import { extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { getCurrentChatIdentity } from '../host/context.js';
import { generationLifecycle } from '../host/generationLifecycle.js';
import { getMessageDiffBranchKey } from '../chat/messageBranch.js';
import { isAssistantMessage } from '../diff/tracking.js';
import { compileProcessors } from '../rules/engine.js';
import { getZhVariantCompatOptions, isZhDictionaryReady } from '../zh/dictionary.js';
import { recordAiRewriteDebug } from './debug.js';

// Owns current settings access, automatic generation target validation, and task freshness predicates.

export function getSettings() {
    const { extension_settings } = getAppContext();
    return extension_settings?.[extensionName] || {};
}

export function getAiSettings() {
    return getSettings().aiRewrite || {};
}

export function snapshotAiRewriteTaskSettings(settings, aiSettings) {
    const frozenSettings = {
        scopeTagMode: settings?.scopeTagMode,
        scopeTags: Array.isArray(settings?.scopeTags)
            ? settings.scopeTags.map((scopeTag) => ({ ...scopeTag }))
            : [],
        scopeTagBuiltinDismissed: Array.isArray(settings?.scopeTagBuiltinDismissed)
            ? [...settings.scopeTagBuiltinDismissed]
            : [],
    };
    const programProcessors = compileProcessors(settings?.rules || [], {
        useZhVariantCompat: settings?.zhVariantCompatEnabled === true && isZhDictionaryReady(settings),
        zhVariantOptions: getZhVariantCompatOptions(settings),
    }).dataProcessors;
    return {
        settings: frozenSettings,
        programProcessors,
        aiSettings: {
            enabled: aiSettings?.enabled,
            baseUrl: aiSettings?.baseUrl,
            apiKey: aiSettings?.apiKey,
            model: aiSettings?.model,
            temperature: aiSettings?.temperature,
            topP: aiSettings?.topP,
            topK: aiSettings?.topK,
            frequencyPenalty: aiSettings?.frequencyPenalty,
            presencePenalty: aiSettings?.presencePenalty,
            repetitionPenalty: aiSettings?.repetitionPenalty,
            maxTokens: aiSettings?.maxTokens,
            timeoutMs: aiSettings?.timeoutMs,
            maxRetries: aiSettings?.maxRetries,
            maxItemsPerRequest: aiSettings?.maxItemsPerRequest,
            maxContextChars: aiSettings?.maxContextChars,
            xmlScopeTag: aiSettings?.xmlScopeTag,
            protectXmlComments: aiSettings?.protectXmlComments,
            promptTemplate: aiSettings?.promptTemplate,
        },
    };
}

export function validateAutomaticAiRewriteContent(taskLike, options = {}) {
    const generationId = String(taskLike?.generationId || '');
    const { chat } = getAppContext();
    const lifecycleValidation = generationLifecycle.validate(generationId, {
        chatId: getCurrentChatIdentity(),
        chat,
    });
    if (!lifecycleValidation.ok) return lifecycleValidation;

    const identity = lifecycleValidation.session.contentIdentity;
    if (!identity) return { ok: false, reason: 'content-identity-missing' };
    if (taskLike?.index !== undefined && Number(taskLike.index) !== lifecycleValidation.session.messageId) {
        return { ok: false, reason: 'generation-message-mismatch' };
    }
    if (String(taskLike?.chatId || lifecycleValidation.session.chatId) !== lifecycleValidation.session.chatId) {
        return { ok: false, reason: 'chat-changed' };
    }
    if (getMessageDiffBranchKey(lifecycleValidation.message) !== identity.branchKey) {
        return { ok: false, reason: 'branch-changed' };
    }
    recordAiRewriteDebug('pre-run-validation', {
        generationId,
        chatId: lifecycleValidation.session.chatId,
        messageId: lifecycleValidation.session.messageId,
        requestState: lifecycleValidation.session.requestState,
        validationMode: 'target-identity',
        validationReason: '',
        source: String(options.source || taskLike?.scheduleSource || ''),
    });
    return {
        ok: true,
        reason: '',
        session: lifecycleValidation.session,
        message: lifecycleValidation.message,
        contentIdentity: identity,
    };
}

export function getTaskFreshnessIssue(task) {
    const { chat } = getAppContext();
    const msg = Array.isArray(chat) ? chat[task.index] : null;
    if (task.automatic === true) {
        const validation = validateAutomaticAiRewriteContent(task, { source: 'task-freshness' });
        if (!validation.ok) return `generation-${validation.reason}`;
        if (validation.session.messageId !== task.index) return 'generation-message-changed';
    }
    if (msg !== task.messageRef) return 'message-ref-changed';
    if (!isAssistantMessage(msg)) return 'not-assistant-message';
    if (msg?.__blai_is_reverted) return 'message-reverted';
    if (getMessageDiffBranchKey(msg) !== task.branchKey) return 'branch-changed';
    if (typeof msg.mes !== 'string') return 'message-text-missing';
    if (task.automatic !== true
        && typeof task.claimedMessageText === 'string'
        && msg.mes !== task.claimedMessageText) {
        return 'message-text-changed';
    }
    return '';
}

export function isTaskStillFresh(task) {
    return !getTaskFreshnessIssue(task);
}
