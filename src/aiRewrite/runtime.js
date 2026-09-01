import { defaultAiRewriteSettings, normalizeAiSamplingSettings } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { streamingRuntimeState } from '../host/streamingState.js';
import { aiRewriteState } from './state.js';
import { logger } from '../log.js';
import { isAssistantMessage } from '../diff/tracking.js';
import { getMessageDiffMeta } from '../diff/messageMeta.js';
import { getMessageDiffBranchKey, setMessageTextForMvuTransaction } from '../chat/messageBranch.js';
import { getCurrentChatIdentity } from '../host/context.js';
import { generationLifecycle } from '../host/generationLifecycle.js';
import { showToast } from '../ui/notifications.js';
import { buildAiRewriteGenerateRawConfig, callTavernHelperGenerateRaw, getTavernHelperGenerationApi } from './generation.js';
import { recordAiCommunicationFailure, recordAiCommunicationSuccess, snapshotAiCommunicationRequest } from './communicationMonitor.js';
import { recordAiRewriteDebug } from './debug.js';
import {
    getAiSettings,
    getSettings,
    getTaskFreshnessIssue,
    isTaskStillFresh,
    snapshotAiRewriteTaskSettings,
    validateAutomaticAiRewriteContent,
} from './task.js';
import { applyAcceptedRewrites, applyProgramFallbackRewrites, buildProgramStageForRewrite } from './apply.js';
import { replayProgramProjection } from '../rules/engine.js';
import { groupRewriteItemsByPrompt, normalizeLimit, renderPrompt } from './planning.js';
import { isAiRewriteResponseFormatError, validateAiRewriteResponse } from './response.js';
import {
    buildRewriteItems,
    collectAiMatches,
    collectAiXmlScopeSegments,
    escapeRegExp,
    getAiXmlScopedRequestText,
    getAiXmlScopeTag,
    materializeProjectedRewriteItems,
    resolveRewriteTrackedRanges,
} from './matching.js';

// Owns normal-message AI request and pending/final-cleanse lifecycle; matching, generation-target freshness, and accepted-result application are delegated to their respective modules.

let automaticRunGenerationId = '';
let automaticRunPromise = null;
const streamingXmlTailLookbackChars = 64;
const streamingXmlScanByMessageId = new Map();

function getAiRewriteMessageId(payload) {
    if (Number.isInteger(payload) && payload >= 0) return payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return -1;
    return Number.isInteger(payload.messageId) && payload.messageId >= 0
        ? payload.messageId
        : -1;
}

function getAiRetryCount(aiSettings) {
    return normalizeLimit(aiSettings?.maxRetries, 2, 0, 5);
}

function stripStatusText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function getToastApi() {
    return globalThis?.toastr || (typeof window !== 'undefined' ? window.toastr : null);
}

function getToastElement(toast) {
    if (!toast) return null;
    if (typeof Element !== 'undefined' && toast instanceof Element) return toast;
    if (toast?.jquery) return toast[0] || null;
    if (typeof toast?.get === 'function') return toast.get(0);
    return null;
}

function removeToastElement(toastElement) {
    if (!toastElement) return;
    try {
        if (typeof toastElement.remove === 'function') {
            toastElement.remove();
            return;
        }
    } catch {
        // Fall through to parent removal.
    }
    if (toastElement.parentNode) {
        toastElement.parentNode.removeChild(toastElement);
    }
}

function clearAiRewriteStatusToast(extraToastElement = null, reason = '') {
    const rewriteState = aiRewriteState;
    const clearedTask = rewriteState?.statusTask || null;
    const hadStatus = Boolean(rewriteState?.statusToast || clearedTask);
    const toastApi = getToastApi();
    const toastElement = getToastElement(rewriteState?.statusToast);
    if (rewriteState?.statusToast && toastApi && typeof toastApi.clear === 'function') {
        try {
            toastApi.clear(rewriteState.statusToast);
        } catch (err) {
            logger.warn('清理 AI 改写状态弹窗失败', err);
        }
    }
    if (rewriteState?.statusToast && toastApi && typeof toastApi.remove === 'function') {
        try {
            toastApi.remove(rewriteState.statusToast);
        } catch {
            // Fall through to DOM removal.
        }
    }
    removeToastElement(toastElement);
    if (extraToastElement && extraToastElement !== toastElement) removeToastElement(extraToastElement);
    if (rewriteState) {
        rewriteState.statusToast = null;
        rewriteState.statusTask = null;
    }
    if (hadStatus && reason) {
        recordAiRewriteDebug('popup-cleared', {
            generationId: clearedTask?.generationId || '',
            index: Number.isInteger(clearedTask?.index) ? clearedTask.index : null,
            reason: String(reason),
        });
    }
}

function dismissAiRewriteStatusToast(toastElement, task) {
    const rewriteState = aiRewriteState;
    const dismissedTask = task || rewriteState.statusTask || null;
    clearAiRewriteStatusToast(toastElement, 'user-dismissed');
    rewriteState.statusDismissedTask = dismissedTask;
    recordAiRewriteDebug('popup-dismissed', {
        generationId: dismissedTask?.generationId || '',
        index: Number.isInteger(dismissedTask?.index) ? dismissedTask.index : null,
        requestContinues: true,
    });
}

function attachAiRewriteDismissAction(toast, task) {
    const toastElement = getToastElement(toast);
    const closeButton = toastElement?.querySelector?.('.toast-close-button');
    if (!toastElement || !closeButton || closeButton.dataset?.blaiDismissBound === 'true') return;
    if (closeButton.dataset) closeButton.dataset.blaiDismissBound = 'true';
    closeButton.setAttribute('aria-label', '关闭提示');
    closeButton.setAttribute('title', '关闭提示（后台改写会继续）');
    closeButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        dismissAiRewriteStatusToast(toastElement, task);
    }, { capture: true });
}

function terminateAiRewriteTask(task = null, options = {}) {
    const rewriteState = aiRewriteState;
    const targetTask = task || rewriteState.statusTask || rewriteState.activeTask || null;
    if (isSameAiRewriteTask(rewriteState.pendingApply?.task, targetTask)) rewriteState.pendingApply = null;
    if (targetTask?.automatic === true) {
        generationLifecycle.markRequestTerminated(targetTask.generationId, 'cancelled', 'user-terminated');
    }
    clearAiRewriteStatusToast(options.toastElement || null);
    recordAiRewriteDebug('terminate-requested', {
        generationId: targetTask?.generationId || '',
        index: Number.isInteger(targetTask?.index) ? targetTask.index : null,
        hasActiveController: !!rewriteState.activeController,
    }, 'warn');
    if (rewriteState.activeController && (!targetTask || isSameAiRewriteTask(rewriteState.activeTask, targetTask))) {
        cancelAiRewriteTask('user-terminated');
    }
    if (options.silent !== true) {
        showToast('AI 改写已终止');
    }
}

function attachAiRewriteTerminateAction(toast, task) {
    if (typeof document === 'undefined') return;
    const toastElement = getToastElement(toast);
    if (!toastElement || !task || toastElement.querySelector('.blai-ai-toast-actions')) return;

    const actions = document.createElement('div');
    actions.className = 'blai-ai-toast-actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'blai-ai-toast-stop';
    button.textContent = '终止';
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        button.disabled = true;
        button.textContent = '终止中';
        terminateAiRewriteTask(task, { toastElement, silent: true });
    });
    actions.appendChild(button);
    toastElement.appendChild(actions);
}

function notifyAiRewriteStatus(type, title, message, options = {}) {
    const method = ['success', 'error', 'warning', 'info'].includes(type) ? type : 'info';
    const safeTitle = String(title || 'AI 改写');
    const safeMessage = String(message || '');
    const toastApi = getToastApi();
    if (toastApi && typeof toastApi[method] === 'function') {
        const sticky = options.sticky === true;
        const task = sticky ? options.task || null : null;
        if (sticky && task && isSameAiRewriteTask(aiRewriteState.statusDismissedTask, task)) return;
        if (options.replaceCurrent !== false) clearAiRewriteStatusToast(null, `status-${method}`);
        const toast = toastApi[method](safeMessage, safeTitle, {
            timeOut: sticky ? 0 : (options.timeOut ?? 5000),
            extendedTimeOut: sticky ? 0 : (options.extendedTimeOut ?? 10000),
            tapToDismiss: sticky ? false : (options.tapToDismiss ?? true),
            closeButton: options.closeButton ?? !sticky,
            preventDuplicates: false,
            escapeHtml: true,
        });
        const toastElement = getToastElement(toast);
        toastElement?.classList?.add('blai-ai-rewrite-toast');
        if (sticky) toastElement?.classList?.add('blai-ai-rewrite-progress-toast');
        aiRewriteState.statusToast = sticky ? toast : null;
        aiRewriteState.statusTask = task;
        if (sticky) attachAiRewriteDismissAction(toast, task);
        if (sticky && options.cancellable === true) {
            attachAiRewriteTerminateAction(toast, task);
        }
        return;
    }

    showToast(`${safeTitle}${safeMessage ? `：${stripStatusText(safeMessage)}` : ''}`);
}

function countMatchedAiRules(matches = []) {
    return new Set(matches.map(match => `${match.ruleIndex}:${match.subRuleIndex}`)).size;
}

function isLatestTrackableMessageIndex(index) {
    const { chat } = getAppContext();
    if (!Array.isArray(chat) || !Number.isInteger(index) || index < 0) return false;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!isAssistantMessage(chat[i])) continue;
        return i === index;
    }
    return false;
}

function getAiConfigIssue(aiSettings) {
    if (aiSettings?.enabled !== true) {
        return {
            code: 'disabled',
            reason: 'AI改写未启用',
        };
    }

    const missingConfig = [];
    if (!String(aiSettings.baseUrl || '').trim()) missingConfig.push('Base URL');
    if (!String(aiSettings.apiKey || '')) missingConfig.push('API Key');
    if (!String(aiSettings.model || '').trim()) missingConfig.push('模型');
    if (missingConfig.length > 0) {
        return {
            code: 'incomplete-config',
            reason: `AI API配置不完整：缺少 ${missingConfig.join('、')}`,
        };
    }

    if (!getTavernHelperApi()) {
        return {
            code: 'tavern-helper-unavailable',
            reason: 'TavernHelper.generateRaw 不可用',
        };
    }

    return null;
}

function formatAiRewriteProgress(task, current, total, attempt = 1, maxAttempts = 1) {
    const sentenceTargetCount = Math.max(0, Array.isArray(task?.items) ? task.items.length : 0);
    const safeTotal = Math.max(1, Number(total) || 1);
    const safeCurrent = Math.min(safeTotal, Math.max(1, Number(current) || 1));
    const safeMaxAttempts = Math.max(1, Number(maxAttempts) || 1);
    const safeAttempt = Math.min(safeMaxAttempts, Math.max(1, Number(attempt) || 1));
    if (safeAttempt > 1) {
        return `句子目标 ${sentenceTargetCount} 处 · 正在重试 ${safeAttempt - 1}/${safeMaxAttempts - 1} · 处理 ${safeCurrent}/${safeTotal}…`;
    }
    return `句子目标 ${sentenceTargetCount} 处 · 正在处理 ${safeCurrent}/${safeTotal}…`;
}

function notifyAiRewriteProgress(task, current, total, attempt = 1, maxAttempts = 1) {
    const retrying = Number(attempt) > 1;
    notifyAiRewriteStatus('info', retrying ? 'AI 改写重试中' : 'AI 改写中', formatAiRewriteProgress(task, current, total, attempt, maxAttempts), {
        sticky: true,
        closeButton: true,
        cancellable: true,
        task,
    });
}

function getAiRewriteMessageKey(index, branchKey = 'main') {
    return `${Number(index)}:${String(branchKey || 'main')}`;
}

function getTaskMessageKey(task) {
    return getAiRewriteMessageKey(task.index, task.branchKey);
}

function extractCurrentAiRewriteScope(text, aiSettings) {
    const source = String(text || '');
    const segments = collectAiXmlScopeSegments(source, aiSettings);
    if (segments.length === 0) {
        return { ok: false, text: '', tailLength: source.length, reason: 'content-scope-missing' };
    }
    const scopedText = getAiXmlScopedRequestText(source, aiSettings);
    return {
        ok: true,
        text: scopedText,
        tailLength: Math.max(0, source.length - scopedText.length),
        reason: '',
    };
}

function freezeAiRewriteContentIdentity(payload, snapshotText, aiSettings) {
    const generationId = String(payload?.generationId || '');
    if (!generationId) return null;
    const session = generationLifecycle.getSession(generationId);
    if (!session || session.phase === 'cancelled') return null;
    if (session.contentIdentity) return session.contentIdentity;

    const { chat } = getAppContext();
    const messageId = getAiRewriteMessageId(payload);
    if (messageId < 0 || !Array.isArray(chat)) return null;
    const messageRef = chat[messageId];
    if (!isAssistantMessage(messageRef)
        || session.chatId !== String(payload?.chatId || '')
        || session.chatRef !== chat
        || session.messageId !== messageId
        || session.messageRef !== messageRef) {
        return null;
    }
    const scoped = extractCurrentAiRewriteScope(snapshotText, aiSettings);
    if (!scoped.ok) return null;
    const currentBranchKey = getMessageDiffBranchKey(messageRef);
    const branchKey = payload?.source === 'message-received'
        && currentBranchKey === 'main'
        && messageRef.swipe_id === undefined
        ? 'swipe:0'
        : currentBranchKey;
    const xmlTag = getAiXmlScopeTag(aiSettings).tagName;
    const identity = { branchKey };
    session.contentIdentity = identity;
    recordAiRewriteDebug('content-snapshot-frozen', {
        generationId,
        chatId: session.chatId,
        messageId: session.messageId,
        scopedLength: scoped.text.length,
        xmlTag,
    });
    return identity;
}

function getLiveAiRewriteTargets() {
    const state = aiRewriteState;
    const targets = [];
    if (state.runningTask?.messageRef) targets.push(state.runningTask);
    const session = generationLifecycle.getActive();
    if (session?.contentIdentity && session.messageRef) {
        targets.push({
            index: session.messageId,
            messageRef: session.messageRef,
            branchKey: session.contentIdentity.branchKey,
        });
    }
    if (state.pendingApply?.task?.messageRef) targets.push(state.pendingApply.task);
    return targets;
}

export function getActiveAiRewriteBranchKeyForMessage(messageRef) {
    const target = getLiveAiRewriteTargets().find(entry => entry.messageRef === messageRef);
    return String(target?.branchKey || '');
}

export function isLiveAiRewriteTargetMessage(messageRef) {
    return getLiveAiRewriteTargets().some(target => target.messageRef === messageRef);
}

export function hasInvalidAiRewriteTarget(chat) {
    if (!Array.isArray(chat)) return false;
    return getLiveAiRewriteTargets().some(target => chat[Number(target.index)] !== target.messageRef);
}

function hasFinalCleanseAfterTaskStart(task) {
    if (task.waitForFinalCleanse !== true) return true;
    const rewriteState = aiRewriteState;
    const readySequence = Number(rewriteState.finalCleanseByMessageKey.get(getTaskMessageKey(task))) || 0;
    return readySequence > (Number(task.finalCleanseSequence) || 0);
}

function getTavernHelperApi() {
    return getTavernHelperGenerationApi();
}


class AiRewriteRequestFormatError extends Error {
    constructor(message, cause = null) {
        super(message);
        this.name = 'AiRewriteRequestFormatError';
        if (cause) this.cause = cause;
    }
}


function isAiRewriteRequestFormatError(error) {
    return error instanceof AiRewriteRequestFormatError
        || error?.name === 'AiRewriteRequestFormatError';
}

function isBadRequestError(error) {
    const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
    if (status === 400) return true;
    return /(?:bad request|http\s*400)/i.test(String(error?.message || ''));
}

function isNonRetryableAiRewriteError(error) {
    return isAiRewriteResponseFormatError(error) || isAiRewriteRequestFormatError(error);
}

function parseAiResponse(rawText, itemById) {
    try {
        const accepted = validateAiRewriteResponse(rawText, itemById);
        recordAiRewriteDebug('parse-result', {
            returnedCount: itemById.size,
            acceptedCount: accepted.size,
            rejectedCount: 0,
        });
        return accepted;
    } catch (error) {
        if (error?.diagnostic) recordAiRewriteDebug('parse-failed', error.diagnostic, 'warn');
        throw error;
    }
}

function applyAiProgramFallback(taskLike, reason = '') {
    const { chat } = getAppContext();
    const index = Number(taskLike?.index);
    if (!Array.isArray(chat) || !Number.isInteger(index) || index < 0 || index >= chat.length) {
        return { applied: false, reason: 'invalid-index' };
    }
    if (!isLatestTrackableMessageIndex(index)) {
        recordAiRewriteDebug('fallback-skip', {
            reason: 'not-latest-trackable-message',
            index,
        }, 'warn');
        return { applied: false, reason: 'not-latest-trackable-message' };
    }

    const msg = chat[index];
    if (!isAssistantMessage(msg)) return { applied: false, reason: 'not-assistant-message' };
    if (msg?.__blai_is_reverted) return { applied: false, reason: 'message-reverted' };
    if (taskLike?.messageRef && msg !== taskLike.messageRef) return { applied: false, reason: 'message-ref-changed' };
    if (taskLike?.automatic === true) {
        const validation = validateAutomaticAiRewriteContent(taskLike, { source: 'program-fallback' });
        if (!validation.ok || validation.session.messageId !== index) {
            return { applied: false, reason: validation.reason || 'generation-message-mismatch' };
        }
    }
    const applyResult = applyProgramFallbackRewrites({ ...taskLike, messageRef: msg });
    if (applyResult.committed !== true) return { applied: false, reason: applyResult.reason };

    recordAiRewriteDebug('program-commit', {
        source: 'ai-fallback',
        messageId: index,
        beforeLength: String(taskLike.snapshotText || '').length,
        afterLength: String(msg.mes || '').length,
    });

    recordAiRewriteDebug('fallback-applied', {
        index,
        branchKey: getMessageDiffBranchKey(msg),
        trigger: String(reason || ''),
        sentenceTargetCount: taskLike.items?.length || 0,
        matchedAiRuleCount: taskLike.matchedAiRuleCount || 0,
        rawAiMatchCount: taskLike.rawAiMatchCount || 0,
        beforeLength: String(taskLike.snapshotText || '').length,
        afterLength: String(msg.mes || '').length,
    }, 'warn');

    return {
        applied: true,
        reason: '',
        sentenceTargetCount: taskLike.items?.length || 0,
        matchedAiRuleCount: taskLike.matchedAiRuleCount || 0,
        rawAiMatchCount: taskLike.rawAiMatchCount || 0,
    };
}

function formatAiRewriteCompletionMessage(task, message) {
    const elapsedSeconds = Math.max(0, Date.now() - task.startedAtMs) / 1000;
    return `${message} · 用时 ${elapsedSeconds.toFixed(1)} 秒`;
}

function finishAiRewriteApply(task, accepted) {
    const rewriteState = aiRewriteState;
    if (isSameAiRewriteTask(rewriteState.pendingApply?.task, task)) rewriteState.pendingApply = null;

    if (!isTaskStillFresh(task)) {
        const freshnessIssue = getTaskFreshnessIssue(task) || 'stale';
        recordAiRewriteDebug('run-stale-before-apply', {
            generationId: task.generationId || '',
            reason: freshnessIssue,
        }, 'warn');
        notifyAiRewriteStatus('error', 'AI 改写失败', '消息状态已变化，未写回', { timeOut: 8000, extendedTimeOut: 16000 });
        return { status: 'stale' };
    }

    const applyResult = applyAcceptedRewrites(task, accepted);
    const appliedCount = applyResult.appliedCount || 0;
    if (appliedCount > 0) {
        recordAiRewriteDebug('run-success', {
            generationId: task.generationId || '',
            appliedCount,
        });
        notifyAiRewriteStatus('success', 'AI 改写成功', formatAiRewriteCompletionMessage(task, `已应用 ${appliedCount} 个句子改写`), { timeOut: 5000 });
        return { status: 'applied', applyResult };
    }
    if (applyResult.reason !== 'no-text-change') {
        recordAiRewriteDebug('run-apply-failed', {
            generationId: task.generationId || '',
            reason: applyResult.reason,
        }, 'warn');
        const fallbackResult = applyAiProgramFallback(task, applyResult.reason || 'apply-failed');
        if (fallbackResult.applied) return { status: 'fallback-applied', applyResult, fallbackResult };
        notifyAiRewriteStatus('error', 'AI 改写未写入', `改写结果未覆盖聊天数据：${applyResult.reason || fallbackResult.reason || 'apply-failed'}`, {
            timeOut: 8000,
            extendedTimeOut: 16000,
        });
        return { status: 'apply-failed', applyResult, fallbackResult };
    }

    recordAiRewriteDebug('run-no-change', {
        generationId: task.generationId || '',
        acceptedCount: accepted.size,
        reason: 'no-text-change',
    });
    notifyAiRewriteStatus('success', 'AI 改写成功', formatAiRewriteCompletionMessage(task, '没有新的文本变更需要写入'), { timeOut: 5000 });
    return { status: 'no-change', applyResult };
}

function isSameAiRewriteTask(left, right) {
    if (!left || !right) return false;
    if (left.automatic === true || right.automatic === true) {
        return left.automatic === true
            && right.automatic === true
            && String(left.generationId || '') !== ''
            && String(left.generationId || '') === String(right.generationId || '');
    }
    return left.messageRef === right.messageRef
        && String(left.branchKey || '') === String(right.branchKey || '');
}

function deferAiRewriteApplyUntilFinalCleanse(task, accepted) {
    const rewriteState = aiRewriteState;
    rewriteState.pendingApply = {
        mode: 'accepted',
        task,
        accepted: new Map(accepted),
    };
    recordAiRewriteDebug('apply-deferred', {
        generationId: task.generationId || '',
        index: task.index,
        finalCleanseSequence: task.finalCleanseSequence,
        pendingApplyCount: 1,
    });
    recordAiRewriteDebug('response-deferred', {
        generationId: task.generationId || '',
        chatId: task.chatId || '',
        messageId: task.index,
        finalCleanseSequence: task.finalCleanseSequence,
    });
    return { status: 'deferred' };
}

function deferAiRewriteFallbackUntilFinalCleanse(task, reason) {
    aiRewriteState.pendingApply = {
        mode: 'fallback',
        task,
        reason: String(reason || ''),
    };
    recordAiRewriteDebug('apply-deferred', {
        generationId: task.generationId || '',
        index: task.index,
        finalCleanseSequence: task.finalCleanseSequence,
        mode: 'fallback',
    });
    return { status: 'deferred-fallback' };
}

function finishOrDeferAiRewriteApply(task, accepted) {
    if (!hasFinalCleanseAfterTaskStart(task)) {
        return deferAiRewriteApplyUntilFinalCleanse(task, accepted);
    }
    return finishAiRewriteApply(task, accepted);
}

function getPendingApplyCountForMessageKey(messageKey) {
    return aiRewriteState.pendingApply
        && getTaskMessageKey(aiRewriteState.pendingApply.task) === messageKey
        ? 1
        : 0;
}

function flushPendingAiRewriteApplyForMessageKey(messageKey) {
    const rewriteState = aiRewriteState;
    const entry = rewriteState.pendingApply;
    if (!entry || getTaskMessageKey(entry.task) !== messageKey) return 0;
    rewriteState.pendingApply = null;
    const freshnessIssue = getTaskFreshnessIssue(entry.task);
    if (freshnessIssue) {
        recordAiRewriteDebug('apply-flush-skip', {
            generationId: entry.task.generationId || '',
            index: entry.task.index,
            reason: freshnessIssue,
        }, 'warn');
        return 0;
    }
    recordAiRewriteDebug('apply-flush', {
        generationId: entry.task.generationId || '',
        index: entry.task.index,
        finalCleanseSequence: rewriteState.finalCleanseSequence,
    });
    const result = entry.mode === 'fallback'
        ? applyAiProgramFallback(entry.task, entry.reason)
        : finishAiRewriteApply(entry.task, entry.accepted);
    return entry.mode === 'fallback'
        ? Number(result?.applied === true)
        : Number(['applied', 'fallback-applied'].includes(result?.status));
}

export function markAiRewriteFinalCleanseReady(payload, options = {}) {
    const { chat } = getAppContext();
    const index = getAiRewriteMessageId(payload);
    if (index < 0) {
        recordAiRewriteDebug('payload-rejected', { source: 'final', reason: 'invalid-message-id' }, 'warn');
        return false;
    }
    if (!Array.isArray(chat) || index < 0 || !isAssistantMessage(chat[index])) return false;
    const validation = validateAiRewriteFinalization(payload);
    if (!validation.ok || validation.session.messageId !== index) {
        recordAiRewriteDebug('run-skip', {
            generationId: String(payload?.generationId || ''),
            index,
            reason: validation.reason || 'generation-message-mismatch',
        }, 'warn');
        return false;
    }

    const msg = chat[index];
    const branchKey = getMessageDiffBranchKey(msg);
    const messageKey = getAiRewriteMessageKey(index, branchKey);
    const rewriteState = aiRewriteState;
    rewriteState.finalCleanseSequence = (Number(rewriteState.finalCleanseSequence) || 0) + 1;
    rewriteState.finalCleanseByMessageKey.set(messageKey, rewriteState.finalCleanseSequence);

    recordAiRewriteDebug('final-cleanse-ready', {
        index,
        branchKey,
        sequence: rewriteState.finalCleanseSequence,
        pendingApplyCount: getPendingApplyCountForMessageKey(messageKey),
        scheduleRequest: options.scheduleRequest !== false,
        generationId: validation.session.generationId,
        chatId: validation.session.chatId,
    });
    const flushedCount = flushPendingAiRewriteApplyForMessageKey(messageKey);
    if (flushedCount > 0) return true;
    if (options.scheduleRequest === false) return false;

    if (validation.session.requestState !== 'idle') {
        if (['scheduled', 'running', 'succeeded'].includes(validation.session.requestState)) {
            recordAiRewriteDebug('final-cleanse-skip-request', {
                index,
                branchKey,
                reason: 'generation-request-already-owned',
                requestState: validation.session.requestState,
            });
            return true;
        }
        return false;
    }

    const taskCheck = buildAiRewriteTaskCheck(payload);
    if (taskCheck.fallbackTask) {
        const fallbackResult = applyAiProgramFallback(taskCheck.fallbackTask, taskCheck.fallbackCode || 'not-sent');
        return fallbackResult.applied === true;
    }
    const readyTask = taskCheck.task;
    if (!readyTask) {
        recordAiRewriteDebug('final-cleanse-no-ai-task', {
            index,
            branchKey,
            reason: taskCheck.reason || 'not-ready',
        });
        return false;
    }
    return scheduleAiRewriteForMessage(payload, { delayMs: 0, preparedTask: readyTask });
}

export async function requestAiRewrite(prompt, aiSettings, signal, task = null) {
    const tavernHelper = getTavernHelperApi();
    if (!tavernHelper) throw new Error('TavernHelper.generateRaw 不可用');
    const requestStartedAt = Date.now();
    const helperGenerationId = task?.automatic === true
        ? `veridis-ai-rewrite-${task.generationId}-${requestStartedAt}`
        : `veridis-ai-rewrite-manual-${Number.isInteger(task?.index) ? task.index : 'message'}-${requestStartedAt}`;
    const requestConfig = buildAiRewriteGenerateRawConfig(prompt, aiSettings, helperGenerationId);
    const sampling = normalizeAiSamplingSettings(aiSettings);
    const startedAt = requestStartedAt;
    recordAiRewriteDebug('fetch-start', {
        endpoint: 'TavernHelper.generateRaw',
        helperGenerationId,
        model: aiSettings.model,
        apiSource: 'custom',
        responseFormat: 'json_object',
        sampling: {
            temperature: sampling.temperature,
            topP: sampling.topP,
            topK: sampling.topK,
            frequencyPenalty: sampling.frequencyPenalty,
            presencePenalty: sampling.presencePenalty,
            repetitionPenalty: sampling.repetitionPenalty,
            maxTokens: sampling.maxTokens,
        },
        promptLength: String(prompt || '').length,
        timeoutMs: aiSettings.timeoutMs,
        generationId: task?.generationId || '',
        chatId: task?.chatId || '',
        index: Number.isInteger(task?.index) ? task.index : null,
        source: task?.scheduleSource || '',
    });
    const stopGeneration = () => {
        try {
            tavernHelper.stopGenerationById?.(helperGenerationId);
        } catch (error) {
            logger.warn('停止酒馆助手自定义 API 改写请求失败', error);
        }
    };
    signal?.addEventListener?.('abort', stopGeneration, { once: true });
    try {
        const requestJson = snapshotAiCommunicationRequest(requestConfig);
        const communicationStartedAt = Date.now();
        let response;
        try {
            response = await callTavernHelperGenerateRaw(requestConfig);
        } catch (error) {
            recordAiCommunicationFailure({
                startedAt: communicationStartedAt,
                endedAt: Date.now(),
                requestJson,
                error,
            });
            throw error;
        }
        recordAiCommunicationSuccess({
            startedAt: communicationStartedAt,
            endedAt: Date.now(),
            requestJson,
            response,
        });
        if (signal?.aborted) {
            const abortError = new Error('请求已取消');
            abortError.name = 'AbortError';
            throw abortError;
        }
        const content = typeof response === 'string' ? response : String(response ?? '');
        if (!content) throw new Error('酒馆助手自定义 API 返回空响应');
        recordAiRewriteDebug('fetch-response', {
            endpoint: 'TavernHelper.generateRaw',
            ok: true,
            elapsedMs: Date.now() - startedAt,
            responseLength: content.length,
            generationId: task?.generationId || '',
            chatId: task?.chatId || '',
            index: Number.isInteger(task?.index) ? task.index : null,
        });
        recordAiRewriteDebug('response-content', {
            contentLength: content.length,
            transport: 'tavern-helper-custom-api',
        });
        return content;
    } finally {
        signal?.removeEventListener?.('abort', stopGeneration);
    }
}

export function cancelAiRewriteTask(reason = 'cancelled') {
    const state = aiRewriteState;
    if (state?.activeController) {
        try {
            state.activeController.abort(reason);
        } catch (err) {
            logger.warn('取消 AI 改写请求失败', err);
        }
    }
    if (state) {
        state.activeController = null;
        state.activeTask = null;
    }
}

function finishAutomaticTaskBeforeRun(payload, reason, state = 'stale') {
    const generationId = String(payload?.generationId || '');
    const session = generationLifecycle.getSession(generationId);
    if (aiRewriteState.pendingApply?.task?.generationId === generationId) aiRewriteState.pendingApply = null;
    if (aiRewriteState.runningTask?.generationId === generationId) aiRewriteState.runningTask = null;
    if (aiRewriteState.activeTask?.generationId === generationId) cancelAiRewriteTask(reason);
    generationLifecycle.markRequestTerminated(generationId, state, reason);
    if (generationLifecycle.getSession(generationId) === session && session) {
        session.contentIdentity = null;
    }
    if (!aiRewriteState.statusTask || aiRewriteState.statusTask.generationId === generationId) {
        clearAiRewriteStatusToast(null, reason);
    }
    recordAiRewriteDebug('task-cancelled', {
        generationId,
        chatId: String(payload?.chatId || session?.chatId || ''),
        messageId: Number.isInteger(session?.messageId) ? session.messageId : null,
        requestState: generationLifecycle.getSession(generationId)?.requestState || state,
        reason: String(reason || state),
        source: String(payload?.source || ''),
    }, 'warn');
}

export function validateAiRewriteFinalization(payload) {
    const generationId = String(payload?.generationId || '');
    const session = generationLifecycle.getSession(generationId);
    if (!session?.contentIdentity) {
        return generationLifecycle.validate(generationId, {
            chatId: getCurrentChatIdentity(),
            chat: getAppContext().chat,
        });
    }
    return validateAutomaticAiRewriteContent({
        generationId,
        chatId: String(payload?.chatId || ''),
        index: getAiRewriteMessageId(payload),
        scheduleSource: String(payload?.source || 'finalization'),
    }, { source: 'finalization' });
}

export function validateAiRewriteMessageTarget(payload) {
    const generationId = String(payload?.generationId || '');
    const session = generationLifecycle.getSession(generationId);
    const identity = session?.contentIdentity || null;
    if (!identity) return { ok: true, changed: false, reason: '' };
    const validation = validateAutomaticAiRewriteContent({
        generationId,
        chatId: String(payload?.chatId || ''),
        index: getAiRewriteMessageId(payload),
        scheduleSource: String(payload?.source || 'final-cleanse'),
    }, { source: 'message-acknowledgement' });
    if (!validation.ok) return validation;

    const resolution = generationLifecycle.bindMessage(validation.session.messageId, {
        generationId,
        chatId: validation.session.chatId,
        chat: getAppContext().chat,
        source: 'message-content-accepted',
    });
    if (!resolution.ok) return resolution;
    recordAiRewriteDebug('message-target-confirmed', {
        generationId,
        chatId: validation.session.chatId,
        messageId: validation.session.messageId,
        messageLength: String(resolution.message?.mes || '').length,
    });
    return {
        ok: true,
        changed: false,
        reason: '',
    };
}

export function handleAiRewriteGenerationStarted(session = null) {
    streamingXmlScanByMessageId.clear();
    automaticRunGenerationId = '';
    automaticRunPromise = null;
    const state = aiRewriteState;
    if (state?.activeController) {
        recordAiRewriteDebug('generation-started-cancelled-active', {
            previousGenerationId: state.activeTask?.generationId || '',
            reason: 'superseded-by-new-generation',
            generationId: session?.generationId || '',
        });
    }
    clearAiRewriteStatusToast(null, 'superseded-by-new-generation');
    state.statusDismissedTask = null;
    cancelAiRewriteTask('generation-started');
    state.pendingApply = null;
    state.runningTask = null;
}

export function resetAiRewriteRuntimeState(reason = 'reset') {
    cancelAiRewriteTask(reason);
    clearAiRewriteStatusToast();
    const state = aiRewriteState;
    state.statusDismissedTask = null;
    streamingXmlScanByMessageId.clear();
    automaticRunGenerationId = '';
    automaticRunPromise = null;
    state.runningTask = null;
    state.finalCleanseSequence = 0;
    state.finalCleanseByMessageKey.clear();
    state.pendingApply = null;
    const session = generationLifecycle.getActive();
    if (session) session.contentIdentity = null;
}

function buildAiRewriteCandidate(payload, options = {}) {
    const settings = getSettings();
    const aiSettings = getAiSettings();
    const { chat } = getAppContext();
    const index = getAiRewriteMessageId(payload);
    if (index < 0) return { task: null, reason: '消息参数无效：invalid-message-id' };
    if (!Array.isArray(chat) || index >= chat.length) {
        return { task: null, reason: '未找到可改写的助手消息' };
    }

    const msg = chat[index];
    if (!isAssistantMessage(msg)) return { task: null, reason: '目标消息不是助手消息' };
    if (msg?.__blai_is_reverted) return { task: null, reason: '目标消息已撤回净化' };
    const isAutomatic = payload?.automatic === true;
    if (isAutomatic) {
        const validation = generationLifecycle.validate(payload.generationId, {
            chatId: getCurrentChatIdentity(),
            chat,
        });
        if (!validation.ok) return { task: null, reason: `生成事务已失效：${validation.reason}` };
        if (validation.session.messageId !== index || validation.session.messageRef !== msg) {
            return { task: null, reason: '生成事务目标消息不一致' };
        }
        if (String(payload.chatId || '') !== validation.session.chatId) {
            return { task: null, reason: '生成事务聊天身份不一致' };
        }
    } else if (options.manual !== true) {
        return { task: null, reason: '自动 AI 改写缺少生成事务身份' };
    }

    const currentText = typeof msg.mes === 'string' ? msg.mes : '';
    const branchKey = getMessageDiffBranchKey(msg);
    const previous = getMessageDiffMeta(msg, branchKey);
    if (!isAutomatic && previous && !Array.isArray(previous.programProjection)) {
        return {
            task: null,
            reason: '此消息缺少精确的 Program 投影来源。请先重新净化消息，再运行手动 AI 改写。',
        };
    }

    const frozenSnapshot = isAutomatic && payload && typeof payload === 'object' && typeof payload.snapshotText === 'string'
        ? payload.snapshotText
        : '';
    const sourceText = isAutomatic
        ? (frozenSnapshot || currentText)
        : (previous?.originalMes || currentText);
    if (!sourceText.trim()) return { task: null, reason: '目标消息为空' };

    const taskSettings = snapshotAiRewriteTaskSettings(settings, aiSettings);
    const { wholeMessage, tagName } = getAiXmlScopeTag(taskSettings.aiSettings);
    const segments = collectAiXmlScopeSegments(sourceText, taskSettings.aiSettings);
    if (segments.length === 0) {
        return { task: null, reason: `未找到完整 <${tagName}>...</${tagName}>` };
    }

    const matches = collectAiMatches(sourceText, settings, taskSettings.aiSettings);
    if (matches.length === 0) {
        return { task: null, reason: wholeMessage ? '整条消息内未命中 AI 改写规则' : `<${tagName}> 内未命中 AI 改写规则` };
    }
    const originalItems = buildRewriteItems(
        sourceText,
        matches,
        taskSettings.settings,
        taskSettings.aiSettings,
    );
    if (originalItems.length === 0) {
        return { task: null, reason: '命中内容没有可改写句子' };
    }

    let programStage;
    if (!isAutomatic && previous) {
        const resolved = resolveRewriteTrackedRanges(sourceText, originalItems, taskSettings.aiSettings);
        if (!resolved.valid) {
            return { task: null, reason: `Original 句子目标身份无效：${resolved.failedItemId || 'unknown'}` };
        }
        const replayed = replayProgramProjection(sourceText, previous.programProjection, resolved.ranges);
        if (!replayed.valid || replayed.outputLength !== previous.programMes.length) {
            return { task: null, reason: '此消息的 Program 投影来源无效。请先重新净化消息，再运行手动 AI 改写。' };
        }
        const projected = materializeProjectedRewriteItems(previous.programMes, originalItems, replayed.ranges);
        if (!projected.valid) {
            return { task: null, reason: `Program 句子目标投影无效：${projected.failedItemId || 'unknown'}` };
        }
        programStage = {
            valid: true,
            text: previous.programMes,
            items: projected.items,
            projection: previous.programProjection,
            projectionOutputLength: replayed.outputLength,
        };
    } else {
        programStage = buildProgramStageForRewrite(
            sourceText,
            msg,
            taskSettings.aiSettings,
            originalItems,
            taskSettings.settings,
            taskSettings.programProcessors,
        );
        if (!programStage.valid) {
            return { task: null, reason: `Program 句子目标投影失败：${programStage.failedItemId || 'unknown'}` };
        }
        if (!isAutomatic && programStage.projectionOutputLength !== programStage.text.length) {
            return { task: null, reason: 'Program 阶段包含无法映射到 Original 的内容' };
        }
    }

    const contentIdentity = isAutomatic
        ? freezeAiRewriteContentIdentity(payload, sourceText, taskSettings.aiSettings)
        : null;
    if (isAutomatic && !contentIdentity) {
        return { task: null, reason: '无法冻结自动 AI 改写 content identity' };
    }
    if (options.logTask === true) {
        recordAiRewriteDebug('task-ready', {
            index,
            branchKey,
            scopeMode: wholeMessage ? 'whole-message' : 'xml',
            xmlTag: tagName,
            segmentCount: segments.length,
            rawAiMatchCount: matches.length,
            matchedAiRuleCount: countMatchedAiRules(matches),
            sentenceTargetCount: programStage.items.length,
            itemLengths: programStage.items.map((item) => item.text.length),
            isStreaming: streamingRuntimeState.isStreamingGeneration === true,
            source: !isAutomatic && previous ? 'persisted-program-stage' : 'frozen-program-stage',
            rawSourceLength: currentText.length,
            sourceLength: sourceText.length,
            generationId: isAutomatic ? String(payload.generationId || '') : '',
            chatId: isAutomatic ? String(payload.chatId || '') : '',
        });
    }
    return {
        task: {
            settings: taskSettings.settings,
            aiSettings: taskSettings.aiSettings,
            programProcessors: taskSettings.programProcessors,
            index,
            messageRef: msg,
            branchKey,
            originalText: sourceText,
            originalItems,
            programText: programStage.text,
            programProjection: programStage.projection,
            programProjectionOutputLength: programStage.projectionOutputLength,
            snapshotText: programStage.text,
            items: programStage.items,
            rawAiMatchCount: matches.length,
            matchedAiRuleCount: countMatchedAiRules(matches),
            claimedMessageText: currentText,
            claimedProgramMeta: previous,
            usesPersistedProgramStage: !isAutomatic && Boolean(previous),
            automatic: isAutomatic,
            generationId: isAutomatic ? String(payload.generationId || '') : '',
            chatId: isAutomatic ? String(payload.chatId || '') : '',
            scheduleSource: isAutomatic ? String(payload.source || '') : 'manual',
        },
        reason: '',
    };
}

export function buildAiRewriteTaskCheck(payload, options = {}) {
    const candidate = buildAiRewriteCandidate(payload, options);
    if (!candidate.task) return candidate;

    const configIssue = getAiConfigIssue(candidate.task.aiSettings);
    if (configIssue) {
        return {
            task: null,
            reason: configIssue.reason,
            fallbackTask: candidate.task,
            fallbackCode: configIssue.code,
        };
    }

    return candidate;
}

function buildReadyAiRewriteTask(payload) {
    return buildAiRewriteTaskCheck(payload).task;
}

function notifyAiRewriteNotSent(taskCheckOrReason) {
    const taskCheck = taskCheckOrReason && typeof taskCheckOrReason === 'object'
        ? taskCheckOrReason
        : null;
    if (taskCheck?.fallbackTask) {
        const fallbackResult = applyAiProgramFallback(taskCheck.fallbackTask, taskCheck.fallbackCode || 'not-sent');
        if (fallbackResult.applied) return;
    }

    const message = String(taskCheck?.reason || taskCheckOrReason || '未满足发送条件');
    recordAiRewriteDebug('not-sent', { reason: message }, aiRewriteState.statusToast ? 'warn' : 'info');
    if (!aiRewriteState.statusToast) {
        logger.info(`AI 改写未发送：${message}`);
        return;
    }
    logger.warn(`AI 改写未发送：${message}`);
    notifyAiRewriteStatus('error', 'AI 改写未发送', message, { timeOut: 8000, extendedTimeOut: 16000 });
}

function notifyAiRewriteReadyForMessage(payload) {
    if (streamingRuntimeState.isStreamingGeneration !== true) return;
    const task = buildReadyAiRewriteTask(payload);
    if (!task) return;

    const rewriteState = aiRewriteState;
    const requestState = generationLifecycle.getSession(task.generationId)?.requestState || '';
    if (isSameAiRewriteTask(rewriteState.runningTask, task) || requestState !== 'idle') return;

    recordAiRewriteDebug('task-built', {
        generationId: task.generationId,
        chatId: task.chatId,
        messageId: task.index,
        source: task.scheduleSource,
    });
    recordAiRewriteDebug('xml-ready-request', {
        generationId: task.generationId,
        index: task.index,
        matchedAiRuleCount: task.matchedAiRuleCount,
        rawAiMatchCount: task.rawAiMatchCount,
        sentenceTargetCount: task.items.length,
        itemLengths: task.items.map(item => item.text.length),
    });
    recordAiRewriteDebug('popup-preparing', {
        generationId: task.generationId,
        messageId: task.index,
    });
    const groupCount = Math.max(1, groupRewriteItemsByPrompt(task.items, task.aiSettings).length);
    notifyAiRewriteProgress(task, 1, groupCount);
    scheduleAiRewriteForMessage(payload, { delayMs: 0, preparedTask: task });
}

export function maybeNotifyAiRewriteReadyFromStreamingText(messageId, text, lifecycle = {}) {
    const index = Number(messageId);
    if (!Number.isInteger(index) || index < 0) return;
    const sourceText = typeof text === 'string' ? text : String(text ?? '');
    if (!sourceText) return;

    const { chat } = getAppContext();
    const resolution = generationLifecycle.bindMessage(index, {
        generationId: lifecycle.generationId,
        chatId: lifecycle.chatId || getCurrentChatIdentity(),
        chat,
        source: lifecycle.source || 'streaming',
    });
    if (!resolution.ok) {
        recordAiRewriteDebug('payload-rejected', {
            source: 'streaming',
            index,
            reason: resolution.reason,
        }, 'warn');
        return;
    }

    const aiSettings = getAiSettings();
    if (aiSettings.enabled !== true) return;
    const { wholeMessage, tagName } = getAiXmlScopeTag(aiSettings);
    if (wholeMessage) return;
    const scanKey = `${index}:${tagName}`;
    const scanState = streamingXmlScanByMessageId.get(scanKey) || {
        checkedLength: 0,
        closeObserved: false,
        closedSeen: false,
    };
    if (scanState.closedSeen === true) return;

    const previousLength = Number(scanState.checkedLength) || 0;
    const stablePreviousLength = sourceText.length < previousLength ? 0 : previousLength;
    const scanStart = Math.max(0, stablePreviousLength - streamingXmlTailLookbackChars);
    const scanText = sourceText.slice(scanStart);
    scanState.checkedLength = sourceText.length;

    const endTagRegex = new RegExp(`<\\s*/\\s*${escapeRegExp(tagName)}\\s*>`, 'iu');
    if (endTagRegex.test(scanText)) scanState.closeObserved = true;
    if (scanState.closeObserved !== true) {
        streamingXmlScanByMessageId.set(scanKey, scanState);
        return;
    }
    if (lifecycle.hostCommitted !== true) {
        streamingXmlScanByMessageId.set(scanKey, scanState);
        return;
    }

    const committedText = typeof resolution.message?.mes === 'string'
        ? resolution.message.mes
        : '';
    const committedScope = extractCurrentAiRewriteScope(committedText, aiSettings);
    if (!committedScope.ok) {
        streamingXmlScanByMessageId.set(scanKey, scanState);
        return;
    }

    scanState.closedSeen = true;
    streamingXmlScanByMessageId.set(scanKey, scanState);
    recordAiRewriteDebug('streaming-xml-end-detected', {
        index,
        xmlTag: tagName,
        sourceLength: sourceText.length,
        committedSourceLength: committedText.length,
        scanStart,
    });
    const frozenSnapshot = committedScope.text;
    notifyAiRewriteReadyForMessage({
        automatic: true,
        generationId: resolution.generationId,
        chatId: resolution.chatId,
        messageId: index,
        snapshotText: frozenSnapshot,
        streamingSnapshot: true,
        source: 'streaming',
    });
}

async function requestAcceptedRewritesOnce(task, rewriteState, attempt, maxAttempts, accepted, completedGroupKeys) {
    const timeoutMs = normalizeLimit(task.aiSettings.timeoutMs, defaultAiRewriteSettings.timeoutMs, 1000, 120000);
    const groups = groupRewriteItemsByPrompt(task.items, task.aiSettings);
    for (const [groupOffset, group] of groups.entries()) {
        if (completedGroupKeys.has(group.key)) {
            recordAiRewriteDebug('request-group-skip', {
                generationId: task.generationId || '',
                attempt,
                group: group.key,
                reason: 'already-completed',
            });
            continue;
        }
        const freshnessIssueBeforeFetch = getTaskFreshnessIssue(task);
        if (freshnessIssueBeforeFetch) {
            recordAiRewriteDebug('request-stale-before-fetch', {
                generationId: task.generationId || '',
                reason: freshnessIssueBeforeFetch,
            }, 'warn');
            return { stale: true, accepted };
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort('timeout'), timeoutMs);
        rewriteState.activeController = controller;
        rewriteState.activeTask = task;
        try {
            const prompt = renderPrompt(task.snapshotText, group.items, task.settings, task.aiSettings, group.promptTemplate);
            logger.info(`发送 AI 改写请求：第 ${attempt}/${maxAttempts} 次，句子目标 ${group.items.length} 个`);
            recordAiRewriteDebug('request-group', {
                generationId: task.generationId || '',
                attempt,
                maxAttempts,
                group: group.key,
                groupItemCount: group.items.length,
                groupItemIds: group.items.map(item => item.id),
                timeoutMs,
            });
            notifyAiRewriteProgress(task, groupOffset + 1, groups.length, attempt, maxAttempts);
            const rawResponse = await requestAiRewrite(prompt, task.aiSettings, controller.signal, task);
            const freshnessIssue = getTaskFreshnessIssue(task);
            if (freshnessIssue) {
                recordAiRewriteDebug('request-stale-after-fetch', { generationId: task.generationId || '', reason: freshnessIssue }, 'warn');
                return { stale: true, accepted };
            }
            const groupAccepted = parseAiResponse(rawResponse, new Map(group.items.map((item) => [item.id, item])));
            groupAccepted.forEach((value, key) => accepted.set(key, value));
            completedGroupKeys.add(group.key);
        } catch (err) {
            const abortReason = controller.signal.aborted ? String(controller.signal.reason || 'aborted') : '';
            if (abortReason && abortReason !== 'timeout') {
                logger.info(`AI 改写请求已取消: ${abortReason}`);
                recordAiRewriteDebug('request-aborted', {
                    generationId: task.generationId || '',
                    attempt,
                    group: group.key,
                    reason: abortReason,
                }, 'warn');
                return { cancelled: true, cancelReason: abortReason, accepted };
            }
            const reason = abortReason === 'timeout' ? '请求超时' : (err?.message || '请求未完成');
            recordAiRewriteDebug('request-error', {
                generationId: task.generationId || '',
                attempt,
                group: group.key,
                groupItemCount: group.items.length,
                reason,
            }, 'warn');
            if (isAiRewriteResponseFormatError(err)) throw err;
            if (isBadRequestError(err)) throw new AiRewriteRequestFormatError(reason, err);
            const wrapped = new Error(reason);
            wrapped.cause = err;
            wrapped.attempt = attempt;
            wrapped.maxAttempts = maxAttempts;
            throw wrapped;
        } finally {
            clearTimeout(timeoutId);
            if (rewriteState.activeTask === task && rewriteState.activeController === controller) {
                rewriteState.activeController = null;
                rewriteState.activeTask = null;
            }
        }
    }
    return { stale: false, accepted };
}

async function runAiRewriteForMessage(payload, options = {}) {
    if (payload?.automatic === true && options.claimRequest === true) {
        const claim = generationLifecycle.claimRequest(payload.generationId, payload.source || 'mvu-transaction');
        if (!claim.ok) {
            recordAiRewriteDebug('task-deduped', {
                generationId: String(payload.generationId || ''),
                chatId: String(payload.chatId || ''),
                index: getAiRewriteMessageId(payload),
                source: String(payload.source || ''),
                reason: claim.reason,
            });
            return { status: 'deduped', reason: claim.reason };
        }
    }
    const waitForFinalCleanse = typeof options.waitForFinalCleanse === 'boolean'
        ? options.waitForFinalCleanse
        : streamingRuntimeState.isStreamingGeneration === true || payload?.streamingSnapshot === true;
    if (waitForFinalCleanse === true) {
        logger.info('AI 改写在 XML 闭合后提前请求，返回后等待最终净化再写回');
    }
    const taskCheck = options.preparedTask
        ? { task: options.preparedTask, reason: '' }
        : buildAiRewriteTaskCheck(payload, {
            logTask: true,
            manual: options.manual === true,
        });
    const readyTask = taskCheck.task;
    if (!readyTask) {
        if (payload?.automatic === true) generationLifecycle.markRequestFailed(payload.generationId, taskCheck.reason || 'task-not-ready');
        notifyAiRewriteNotSent(taskCheck);
        return;
    }
    const { aiSettings, index, messageRef: msg, items } = readyTask;
    const rewriteState = aiRewriteState;
    if (isSameAiRewriteTask(rewriteState.runningTask, readyTask)) {
        recordAiRewriteDebug('run-skip', {
            generationId: readyTask.generationId || '',
            reason: 'already-pending',
        });
        return;
    }

    if (readyTask.automatic === true && !generationLifecycle.markRequestRunning(readyTask.generationId)) {
        recordAiRewriteDebug('run-skip', {
            generationId: readyTask.generationId,
            index: readyTask.index,
            reason: 'generation-request-not-scheduled',
        }, 'warn');
        finishAutomaticTaskBeforeRun(payload, 'generation-request-not-scheduled', 'failed');
        return;
    }

    if (rewriteState.activeController && !isSameAiRewriteTask(rewriteState.activeTask, readyTask)) {
        cancelAiRewriteTask('superseded');
    }

    const startedAtMs = Date.now();
    const branchKey = getMessageDiffBranchKey(msg);
    rewriteState.statusDismissedTask = null;
    recordAiRewriteDebug('run-start', {
        generationId: readyTask.generationId || '',
        index,
        branchKey,
        sentenceTargetCount: items.length,
        rawAiMatchCount: readyTask.rawAiMatchCount,
        matchedAiRuleCount: readyTask.matchedAiRuleCount,
        model: aiSettings.model,
        transport: 'tavern-helper-custom-api',
        maxRetries: getAiRetryCount(aiSettings),
        isStreaming: streamingRuntimeState.isStreamingGeneration === true,
        waitForFinalCleanse,
    });

    const task = {
        ...readyTask,
        branchKey,
        snapshotText: readyTask.snapshotText || msg.mes,
        startedAtMs,
        waitForFinalCleanse,
        finalCleanseSequence: options.finalCleanseSequence ?? (Number(rewriteState.finalCleanseSequence) || 0),
    };
    rewriteState.runningTask = task;

    try {
        const maxAttempts = getAiRetryCount(aiSettings) + 1;
        const accepted = new Map();
        const completedGroupKeys = new Set();
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const result = await requestAcceptedRewritesOnce(task, rewriteState, attempt, maxAttempts, accepted, completedGroupKeys);
                if (result?.cancelled) {
                    if (task.automatic === true) generationLifecycle.markRequestFailed(task.generationId, 'request-cancelled');
                    recordAiRewriteDebug('run-cancelled', {
                        generationId: task.generationId || '',
                        reason: result.cancelReason || 'request-cancelled',
                    }, 'warn');
                    return;
                }
                if (result?.stale) {
                    const freshnessIssue = getTaskFreshnessIssue(task) || 'stale';
                    if (task.automatic === true) generationLifecycle.markRequestFailed(task.generationId, freshnessIssue);
                    recordAiRewriteDebug('run-stale', { generationId: task.generationId || '', reason: freshnessIssue }, 'warn');
                    notifyAiRewriteStatus('error', 'AI 改写失败', '消息已变化，未写回', { timeOut: 8000, extendedTimeOut: 16000 });
                    return;
                }
                break;
            } catch (err) {
                if (isNonRetryableAiRewriteError(err)) throw err;
                if (attempt >= maxAttempts || !isTaskStillFresh(task)) throw err;
                recordAiRewriteDebug('retry', {
                    generationId: task.generationId || '',
                    nextAttempt: attempt + 1,
                    maxAttempts,
                    reason: err?.message || '请求未完成',
                }, 'warn');
            }
        }

        if (task.automatic === true) generationLifecycle.markRequestSucceeded(task.generationId);
        return finishOrDeferAiRewriteApply(task, accepted);
    } catch (err) {
        if (task.automatic === true) generationLifecycle.markRequestFailed(task.generationId, err?.message || 'request-failed');
        logger.warn('AI 改写失败', err);
        recordAiRewriteDebug('run-error', { generationId: task.generationId || '', reason: err?.message || '请求未完成' }, 'warn');
        if (isTaskStillFresh(task)) {
            if (!hasFinalCleanseAfterTaskStart(task)) {
                deferAiRewriteFallbackUntilFinalCleanse(task, 'ai-failed');
                return;
            }
            const fallbackResult = applyAiProgramFallback(task, 'ai-failed');
            if (fallbackResult.applied) return { status: 'fallback-applied', fallbackResult };
        }
        notifyAiRewriteStatus('error', 'AI 改写失败', err?.message || '请求未完成', { timeOut: 8000, extendedTimeOut: 16000 });
    } finally {
        if (rewriteState.runningTask === task) rewriteState.runningTask = null;
        if (isSameAiRewriteTask(rewriteState.statusDismissedTask, task)) {
            rewriteState.statusDismissedTask = null;
        }
        if (rewriteState.activeTask === task) {
            rewriteState.activeController = null;
            rewriteState.activeTask = null;
        }
    }
}

export function runAiRewriteForMessageNow(payload, options = {}) {
    return runAiRewriteForMessage(payload, {
        ...options,
        waitForFinalCleanse: false,
        claimRequest: payload?.automatic === true,
    });
}

export function adoptMvuMessageContentForAiRewrite(payload, messageContent) {
    const generationId = String(payload?.generationId || '');
    const messageId = getAiRewriteMessageId(payload);
    const { chat } = getAppContext();
    if (!generationId || messageId < 0 || !Array.isArray(chat)) {
        return { ok: false, reason: 'invalid-mvu-payload' };
    }

    const msg = chat[messageId];
    if (!isAssistantMessage(msg) || typeof msg.mes !== 'string') {
        return { ok: false, reason: 'message-not-assistant' };
    }

    const nextText = String(messageContent ?? '');
    const previousText = msg.mes;
    if (nextText === previousText) return { ok: true, changed: false, reason: '' };

    const session = generationLifecycle.getSession(generationId);
    if (!session || session.phase === 'cancelled') {
        return { ok: false, reason: 'generation-inactive' };
    }
    if (session.messageRef !== msg || session.messageId !== messageId) {
        return { ok: false, reason: 'generation-message-mismatch' };
    }

    setMessageTextForMvuTransaction(msg, nextText);
    const acknowledgement = generationLifecycle.acknowledgeInternalMessageMutation(generationId, {
        chatId: String(payload?.chatId || ''),
        chat,
        messageId,
        messageRef: msg,
        beforeText: previousText,
        afterText: nextText,
        source: 'mvu-before-message-update',
    });
    if (!acknowledgement.ok) {
        setMessageTextForMvuTransaction(msg, previousText);
        return acknowledgement;
    }

    recordAiRewriteDebug('mvu-message-content-adopted', {
        generationId,
        chatId: String(payload?.chatId || ''),
        messageId,
        beforeLength: previousText.length,
        afterLength: nextText.length,
        contentIdentityActive: Boolean(session.contentIdentity),
    });
    return { ok: true, changed: true, reason: '' };
}

export async function waitForAutomaticAiRewrite(generationId) {
    const normalizedGenerationId = String(generationId || '');
    if (!automaticRunPromise || automaticRunGenerationId !== normalizedGenerationId) return null;
    return automaticRunPromise;
}

export function scheduleAiRewriteForMessage(payload, options = {}) {
    const delay = normalizeLimit(options.delayMs, 0, 0, 10000);
    const finalCleanseSequence = Number(aiRewriteState.finalCleanseSequence) || 0;
    if (payload?.automatic === true) {
        const claim = generationLifecycle.claimRequest(payload.generationId, payload.source || (payload.streamingSnapshot ? 'streaming' : 'final'));
        if (!claim.ok) {
            recordAiRewriteDebug('task-deduped', {
                generationId: String(payload.generationId || ''),
                chatId: String(payload.chatId || ''),
                index: getAiRewriteMessageId(payload),
                source: String(payload.source || ''),
                reason: claim.reason,
            });
            if (!String(claim.reason || '').startsWith('request-')) {
                finishAutomaticTaskBeforeRun(payload, `request-claim-${claim.reason}`, 'failed');
            }
            return false;
        }
        recordAiRewriteDebug('request-claimed', {
            generationId: String(payload.generationId || ''),
            chatId: String(payload.chatId || ''),
            messageId: getAiRewriteMessageId(payload),
            requestState: claim.session.requestState,
            source: String(payload.source || ''),
        });
    }
    const runScheduledTask = async () => {
        if (payload?.automatic === true) {
            const validation = validateAutomaticAiRewriteContent({
                generationId: String(payload.generationId || ''),
                chatId: String(payload.chatId || ''),
                index: getAiRewriteMessageId(payload),
                scheduleSource: String(payload.source || ''),
            }, { source: 'schedule-callback' });
            if (!validation.ok) {
                recordAiRewriteDebug('run-skip', {
                    generationId: String(payload.generationId || ''),
                    reason: validation.reason,
                }, 'warn');
                finishAutomaticTaskBeforeRun(payload, validation.reason, 'stale');
                return;
            }
        }
        return runAiRewriteForMessage(payload, { ...options, finalCleanseSequence });
    };
    const generationId = String(payload?.generationId || '');
    const scheduledPromise = new Promise((resolve) => {
        setTimeout(() => resolve(runScheduledTask()), delay);
    });
    if (payload?.automatic === true && generationId) {
        automaticRunGenerationId = generationId;
        automaticRunPromise = scheduledPromise;
        const clearScheduledPromise = () => {
            if (automaticRunPromise === scheduledPromise) {
                automaticRunGenerationId = '';
                automaticRunPromise = null;
            }
        };
        scheduledPromise.then(clearScheduledPromise, clearScheduledPromise);
    }
    return true;
}

export function requestManualAiRewriteForMessage(payload) {
    const taskCheck = buildAiRewriteTaskCheck(payload, { logTask: true, manual: true });
    const task = taskCheck.task;
    if (!task) {
        recordAiRewriteDebug('not-sent', { reason: taskCheck.reason || '未满足发送条件', manual: true }, 'warn');
        notifyAiRewriteStatus('error', 'AI 改写未发送', taskCheck.reason || '未满足发送条件', { timeOut: 8000, extendedTimeOut: 16000 });
        return false;
    }

    const rewriteState = aiRewriteState;
    if (isSameAiRewriteTask(rewriteState.runningTask, task)) {
        if (!rewriteState.statusToast) {
            notifyAiRewriteProgress(task, 1, Math.max(1, groupRewriteItemsByPrompt(task.items, task.aiSettings).length));
        }
        return false;
    }

    if (isSameAiRewriteTask(rewriteState.pendingApply?.task, task)) rewriteState.pendingApply = null;
    recordAiRewriteDebug('manual-request', {
        index: task.index,
        sentenceTargetCount: task.items.length,
        rawAiMatchCount: task.rawAiMatchCount,
        matchedAiRuleCount: task.matchedAiRuleCount,
    });
    runAiRewriteForMessage(payload, {
        waitForFinalCleanse: false,
        manual: true,
        preparedTask: task,
    });
    return true;
}
