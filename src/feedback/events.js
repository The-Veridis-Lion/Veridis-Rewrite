// Owns feedback workspace action binding and the exact serialized preview submitted to the gateway.
import { buildFeedbackPayload, getFeedbackPayloadReaders } from './payload.js';
import { submitFeedbackPayloadJson, validateFeedbackAttachments } from './client.js';
import {
    clearDeepCleanDiagnostics,
    getDeepCleanDiagnosticSlots,
} from '../deepClean/diagnostics.js';
import {
    clearRenderedFeedbackPreview,
    closeFeedbackWorkspace,
    openFeedbackWorkspace,
    renderAiContext,
    renderDeepCleanDiagnostics,
    renderFeedbackForm,
    renderFeedbackPreview,
    renderRuntimeLog,
    setFeedbackSubmitEnabled,
    showFeedbackSubmissionStatus,
    showDeepCleanDiagnosticJson,
    showFeedbackStatus,
    updateFeedbackAreaSummary,
} from './view.js';
import { getAiRewriteDebugLogText } from '../aiRewrite/debug.js';
import { clearAiCommunicationRecords } from '../aiRewrite/communicationMonitor.js';
import { logger } from '../log.js';
import { showToast } from '../ui/notifications.js';

let previewPayloadJson = '';
let previewAttachments = [];
let previewRevision = 0;

async function resolveFeedbackPreviewReaders(selected, readers) {
    const unresolvedReaders = readers || getFeedbackPayloadReaders();
    if (typeof unresolvedReaders.readExtensionManifest !== 'function') return unresolvedReaders;

    const pluginManifest = await unresolvedReaders.readExtensionManifest(unresolvedReaders.veridisExternalId);
    const resolvedReaders = {
        ...unresolvedReaders,
        getPluginVersion: () => pluginManifest?.version || '',
    };
    if (selected.installedEnabledExtensions === true) {
        const extensions = await unresolvedReaders.getInstalledEnabledExtensions();
        resolvedReaders.getInstalledEnabledExtensions = () => extensions;
    }
    return resolvedReaders;
}

export async function createFeedbackPreviewPayloadJson(form, selected, readers) {
    const resolvedReaders = await resolveFeedbackPreviewReaders(selected, readers);
    return JSON.stringify(buildFeedbackPayload(form, selected, resolvedReaders), null, 2);
}

export function invalidateFeedbackPreview() {
    previewRevision += 1;
    previewPayloadJson = '';
    previewAttachments = [];
    return previewPayloadJson;
}

export function getFeedbackPreviewPayloadJson() {
    return previewPayloadJson;
}

export function submitCurrentFeedbackPreview(fetchImpl) {
    if (!previewPayloadJson) throw new Error('Generate a new preview before submitting.');
    return submitFeedbackPayloadJson(previewPayloadJson, previewAttachments, fetchImpl);
}

function readFeedbackAttachments(form) {
    return [...(form.querySelector('#blai-feedback-files')?.files || [])];
}

function readFeedbackForm(form) {
    return {
        type: form.querySelector('[name="feedbackType"]')?.value || '',
        area: [...form.querySelectorAll('input[name="feedbackArea"]:checked')].map((input) => input.value),
        title: form.querySelector('#blai-feedback-title')?.value || '',
        details: form.querySelector('#blai-feedback-details')?.value || '',
    };
}

function readDiagnosticSelections(form) {
    const checked = (name) => form.querySelector(`input[name="${name}"]`)?.checked === true;
    return {
        installedEnabledExtensions: checked('installedEnabledExtensions'),
        runtimeLog: checked('runtimeLog'),
        deepCleanLatestFailure: checked('deepCleanLatestFailure'),
        deepCleanPreviousFailure: checked('deepCleanPreviousFailure'),
        deepCleanLastSuccess: checked('deepCleanLastSuccess'),
    };
}

function haveSameValues(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isCurrentVisibleFeedbackForm(form) {
    const workspace = document.getElementById('blai-feedback-workspace');
    return document.getElementById('blai-feedback-form') === form
        && workspace?.getAttribute('aria-hidden') === 'false'
        && workspace?.dataset.feedbackView === 'submit';
}

function feedbackPreviewInputsStillMatch(form, capturedForm, capturedDiagnostics, capturedAttachments) {
    if (!isCurrentVisibleFeedbackForm(form)) return false;
    const currentForm = readFeedbackForm(form);
    const currentDiagnostics = readDiagnosticSelections(form);
    return currentForm.type === capturedForm.type
        && currentForm.title === capturedForm.title
        && currentForm.details === capturedForm.details
        && haveSameValues(currentForm.area, capturedForm.area)
        && haveSameValues(readFeedbackAttachments(form), capturedAttachments)
        && currentDiagnostics.installedEnabledExtensions === capturedDiagnostics.installedEnabledExtensions
        && currentDiagnostics.runtimeLog === capturedDiagnostics.runtimeLog
        && currentDiagnostics.deepCleanLatestFailure === capturedDiagnostics.deepCleanLatestFailure
        && currentDiagnostics.deepCleanPreviousFailure === capturedDiagnostics.deepCleanPreviousFailure
        && currentDiagnostics.deepCleanLastSuccess === capturedDiagnostics.deepCleanLastSuccess;
}

function showWorkspaceView(view) {
    invalidateFeedbackPreview();
    clearRenderedFeedbackPreview({ preserveSubmissionStatus: true });
    openFeedbackWorkspace(view);
    if (view === 'runtime-log') renderRuntimeLog();
    else if (view === 'ai-context') renderAiContext();
    else if (view === 'diagnostics') renderDeepCleanDiagnostics(getDeepCleanDiagnosticSlots());
    else renderFeedbackForm(getDeepCleanDiagnosticSlots());
}

export function bindFeedbackEvents() {
    $(document).off('click', '#blai-tools-feedback-open').on('click', '#blai-tools-feedback-open', () => {
        showWorkspaceView('runtime-log');
    });
    $(document).off('click', '#blai-feedback-close').on('click', '#blai-feedback-close', () => {
        invalidateFeedbackPreview();
        clearRenderedFeedbackPreview({ preserveSubmissionStatus: true });
        closeFeedbackWorkspace();
    });
    $(document).off('click', '#blai-feedback-workspace [data-feedback-view]').on('click', '#blai-feedback-workspace [data-feedback-view]', function() {
        showWorkspaceView(String($(this).attr('data-feedback-view') || 'runtime-log'));
    });

    $(document).off('input change', '#blai-feedback-form input, #blai-feedback-form textarea, #blai-feedback-form select').on('input change', '#blai-feedback-form input, #blai-feedback-form textarea, #blai-feedback-form select', function() {
        if (this.id === 'blai-feedback-confirm') return;
        if (this.name === 'feedbackArea') updateFeedbackAreaSummary();
        invalidateFeedbackPreview();
        clearRenderedFeedbackPreview();
        showFeedbackStatus('内容已更改，请重新生成预览。', 'notice');
    });

    $(document).off('click', '#blai-feedback-preview-generate').on('click', '#blai-feedback-preview-generate', async function() {
        const form = document.getElementById('blai-feedback-form');
        if (!form || this.disabled) return;
        const capturedForm = readFeedbackForm(form);
        const capturedDiagnostics = readDiagnosticSelections(form);
        const capturedAttachments = readFeedbackAttachments(form);
        invalidateFeedbackPreview();
        clearRenderedFeedbackPreview();
        this.disabled = true;
        const revision = previewRevision;
        try {
            validateFeedbackAttachments(capturedAttachments);
            const payloadJson = await createFeedbackPreviewPayloadJson(capturedForm, capturedDiagnostics);
            if (revision !== previewRevision || !feedbackPreviewInputsStillMatch(form, capturedForm, capturedDiagnostics, capturedAttachments)) return;
            previewPayloadJson = payloadJson;
            previewAttachments = capturedAttachments;
            renderFeedbackPreview(payloadJson, capturedAttachments);
            document.getElementById('blai-feedback-preview-section')?.scrollIntoView({ block: 'start' });
            showFeedbackStatus('预览已生成。请检查完整 JSON 和所选文件后确认提交。', 'success');
        } catch (error) {
            if (revision !== previewRevision || !feedbackPreviewInputsStillMatch(form, capturedForm, capturedDiagnostics, capturedAttachments)) return;
            invalidateFeedbackPreview();
            clearRenderedFeedbackPreview();
            showFeedbackStatus(`无法生成预览：${error instanceof Error ? error.message : String(error)}`, 'error');
        } finally {
            this.disabled = false;
        }
    });

    $(document).off('click', '#blai-feedback-files-trigger').on('click', '#blai-feedback-files-trigger', () => {
        document.getElementById('blai-feedback-files')?.click();
    });

    $(document).off('click', '#blai-feedback-copy-log').on('click', '#blai-feedback-copy-log', async () => {
        const logText = getAiRewriteDebugLogText();
        if (!logText || logText === '[]') {
            showToast('暂无运行日志');
            return;
        }
        try {
            const tavernHelper = globalThis.TavernHelper || globalThis.parent?.TavernHelper;
            if (typeof tavernHelper?.builtin?.copyText !== 'function') throw new Error('TavernHelper.builtin.copyText 不可用');
            await tavernHelper.builtin.copyText(logText);
        } catch (error) {
            logger.warn('复制运行日志失败', error);
        }
    });

    $(document).off('click', '#blai-ai-monitor-clear').on('click', '#blai-ai-monitor-clear', () => {
        clearAiCommunicationRecords();
    });

    $(document).off('change', '#blai-feedback-confirm').on('change', '#blai-feedback-confirm', function() {
        setFeedbackSubmitEnabled(this.checked === true && Boolean(previewPayloadJson));
    });

    $(document).off('click', '#blai-feedback-submit').on('click', '#blai-feedback-submit', async function() {
        if (!previewPayloadJson || document.getElementById('blai-feedback-confirm')?.checked !== true) return;
        const form = this.form;
        const submittedInputs = [...form.querySelectorAll('input, textarea, select')]
            .filter((input) => !input.disabled);
        submittedInputs.forEach((input) => { input.disabled = true; });
        const previewButton = form.querySelector('#blai-feedback-preview-generate');
        previewButton.disabled = true;
        $(this).prop('disabled', true);
        showFeedbackSubmissionStatus('正在提交匿名反馈…', 'notice');
        try {
            const result = await submitCurrentFeedbackPreview();
            form.reset();
            updateFeedbackAreaSummary();
            invalidateFeedbackPreview();
            showFeedbackSubmissionStatus(`提交成功。反馈 ID：${result.feedbackId}`, 'success');
            clearRenderedFeedbackPreview({ preserveSubmissionStatus: true });
            showToast(`匿名反馈提交成功 · ID ${result.feedbackId}`, '如需更新提醒，请在贴内附 ID 并 @我，处理后会在贴内回复。');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            showFeedbackSubmissionStatus(`提交失败：${message}`, 'error');
            setFeedbackSubmitEnabled(Boolean(previewPayloadJson) && document.getElementById('blai-feedback-confirm')?.checked === true);
        } finally {
            submittedInputs.forEach((input) => { input.disabled = false; });
            previewButton.disabled = false;
        }
    });

    $(document).off('click', '[data-feedback-expand-diagnostic]').on('click', '[data-feedback-expand-diagnostic]', function() {
        const slot = String($(this).attr('data-feedback-expand-diagnostic') || '');
        const record = getDeepCleanDiagnosticSlots()[slot];
        if (!record) return;
        const expanded = $(this).attr('aria-expanded') !== 'true';
        showDeepCleanDiagnosticJson(slot, record, expanded);
    });

    $(document).off('click', '#blai-feedback-clear-deep-clean').on('click', '#blai-feedback-clear-deep-clean', () => {
        if (!confirm('仅清除本地 Deep Clean 诊断记录？')) return;
        clearDeepCleanDiagnostics();
        renderDeepCleanDiagnostics(getDeepCleanDiagnosticSlots());
    });
}
