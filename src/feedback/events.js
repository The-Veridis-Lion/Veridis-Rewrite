// Owns feedback workspace action binding and the exact serialized preview submitted to the gateway.
import { buildFeedbackPayload } from './payload.js';
import { submitFeedbackPayloadJson } from './client.js';
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

export function createFeedbackPreviewPayloadJson(form, selected, readers) {
    previewPayloadJson = JSON.stringify(buildFeedbackPayload(form, selected, readers), null, 2);
    return previewPayloadJson;
}

export function invalidateFeedbackPreview() {
    previewPayloadJson = '';
    return previewPayloadJson;
}

export function getFeedbackPreviewPayloadJson() {
    return previewPayloadJson;
}

export function submitCurrentFeedbackPreview(fetchImpl) {
    if (!previewPayloadJson) throw new Error('Generate a new preview before submitting.');
    return submitFeedbackPayloadJson(previewPayloadJson, fetchImpl);
}

function readFeedbackForm() {
    return {
        type: document.querySelector('[name="feedbackType"]')?.value || '',
        area: [...document.querySelectorAll('input[name="feedbackArea"]:checked')].map((input) => input.value),
        title: document.getElementById('blai-feedback-title')?.value || '',
        details: document.getElementById('blai-feedback-details')?.value || '',
    };
}

function readDiagnosticSelections() {
    const checked = (name) => document.querySelector(`input[name="${name}"]`)?.checked === true;
    return {
        installedEnabledExtensions: checked('installedEnabledExtensions'),
        runtimeLog: checked('runtimeLog'),
        deepCleanLatestFailure: checked('deepCleanLatestFailure'),
        deepCleanPreviousFailure: checked('deepCleanPreviousFailure'),
        deepCleanLastSuccess: checked('deepCleanLastSuccess'),
    };
}

function showWorkspaceView(view) {
    invalidateFeedbackPreview();
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
    $(document).off('click', '#blai-feedback-close').on('click', '#blai-feedback-close', closeFeedbackWorkspace);
    $(document).off('click', '#blai-feedback-workspace [data-feedback-view]').on('click', '#blai-feedback-workspace [data-feedback-view]', function() {
        showWorkspaceView(String($(this).attr('data-feedback-view') || 'runtime-log'));
    });

    $(document).off('input change', '#blai-feedback-form input, #blai-feedback-form textarea').on('input change', '#blai-feedback-form input, #blai-feedback-form textarea', function() {
        if (this.id === 'blai-feedback-confirm') return;
        if (this.name === 'feedbackArea') updateFeedbackAreaSummary();
        invalidateFeedbackPreview();
        clearRenderedFeedbackPreview();
        showFeedbackStatus('内容已更改，请重新生成预览。', 'notice');
    });

    $(document).off('click', '#blai-feedback-preview-generate').on('click', '#blai-feedback-preview-generate', () => {
        try {
            const payloadJson = createFeedbackPreviewPayloadJson(readFeedbackForm(), readDiagnosticSelections());
            renderFeedbackPreview(payloadJson);
            document.getElementById('blai-feedback-preview-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            showFeedbackStatus('预览已生成。请检查完整 JSON 后确认提交。', 'success');
        } catch (error) {
            invalidateFeedbackPreview();
            clearRenderedFeedbackPreview();
            showFeedbackStatus(`无法生成预览：${error instanceof Error ? error.message : String(error)}`, 'error');
        }
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
            showToast('运行日志已复制');
        } catch (error) {
            logger.warn('复制运行日志失败', error);
            showToast('复制运行日志失败，请更新或启用酒馆助手');
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
        $(this).prop('disabled', true);
        showFeedbackSubmissionStatus('正在提交匿名反馈…', 'notice');
        try {
            const result = await submitCurrentFeedbackPreview();
            invalidateFeedbackPreview();
            showFeedbackSubmissionStatus(`提交成功。反馈 ID：${result.feedbackId}`, 'success');
            clearRenderedFeedbackPreview({ preserveSubmissionStatus: true });
            showToast(`匿名反馈提交成功 · ID ${result.feedbackId}`, '如需更新提醒，请在贴内附 ID 并 @我，处理后会在贴内回复。');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            showFeedbackSubmissionStatus(`提交失败：${message}`, 'error');
            showToast(`反馈提交失败：${message}`);
            setFeedbackSubmitEnabled(true);
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
