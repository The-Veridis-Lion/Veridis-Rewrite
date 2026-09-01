// Owns the dedicated feedback and Deep Clean diagnostics workspace rendering.
import { feedbackAreas, feedbackTypes } from './payload.js';
import { getAiRewriteDebugDisplayText } from '../aiRewrite/debug.js';
import { formatAiCommunicationRecords } from '../aiRewrite/communicationMonitor.js';

const feedbackAreaLabels = Object.freeze({
    'Deep Clean': '深度净化',
    'AI Rewrite': 'AI 改写',
    'Program Rewrite': '程序改写',
    'Streaming Filter': '流式过滤',
    Regex: '正则',
    'Diff / Review': '净化结果 / 审查',
    'Rule Search': '规则搜索',
    'Settings / API': '设置 / API',
    'UI / Layout': '界面 / 布局',
    'Third-party Integration': '第三方集成',
    Other: '其他',
});

function feedbackAreaDisplayLabel(value) {
    return feedbackAreaLabels[value] || value;
}

export function updateFeedbackAreaSummary() {
    const summary = document.querySelector('#blai-feedback-workspace .blai-feedback-area-select > summary');
    if (!summary) return;
    const selectedLabels = [...document.querySelectorAll('#blai-feedback-form input[name="feedbackArea"]:checked')]
        .map((input) => feedbackAreaDisplayLabel(input.value));
    summary.textContent = selectedLabels.length ? selectedLabels.join('、') : '选择涉及区域';
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function diagnosticAttachment(label, name, available = true, description = '') {
    return `
        <label class="blai-feedback-check${available ? '' : ' is-unavailable'}">
            <input type="checkbox" name="${name}"${available ? '' : ' disabled'}>
            <span class="blai-feedback-check-copy">
                <span class="blai-feedback-check-title">${escapeHtml(label)}</span>
                ${description ? `<small class="blai-feedback-check-description">${escapeHtml(description)}</small>` : ''}
            </span>
            ${available ? '' : '<small class="blai-feedback-check-status">不可用</small>'}
        </label>
    `;
}

export function renderFeedbackForm(slots = {}) {
    const content = document.getElementById('blai-feedback-workspace-content');
    if (!content) return;
    content.innerHTML = `
        <form id="blai-feedback-form" class="blai-feedback-form" novalidate>
            <div class="blai-feedback-form-main">
                <label class="blai-feedback-control">
                    <span>类型</span>
                    <select id="blai-feedback-type" name="feedbackType">
                        <option value="">请选择类型</option>
                        ${feedbackTypes.map((type) => `<option value="${escapeHtml(type)}">${type === 'Feature' ? '功能建议' : escapeHtml(type)}</option>`).join('')}
                    </select>
                </label>

                <fieldset class="blai-feedback-fieldset">
                    <legend>涉及区域</legend>
                    <p>可选择多个相关区域；例如深度净化中的结果或审查问题，可以同时选择「深度净化」和「净化结果 / 审查」。</p>
                    <details class="blai-feedback-area-select">
                        <summary>选择涉及区域</summary>
                        <div>
                        ${feedbackAreas.map((area) => `
                            <label><input type="checkbox" name="feedbackArea" value="${escapeHtml(area)}"><span>${escapeHtml(feedbackAreaDisplayLabel(area))}</span></label>
                        `).join('')}
                        </div>
                    </details>
                </fieldset>

                <label class="blai-feedback-control">
                    <span>标题</span>
                    <input id="blai-feedback-title" name="feedbackTitle" type="text" autocomplete="off">
                </label>

                <label class="blai-feedback-control">
                    <span>详细说明</span>
                    <textarea id="blai-feedback-details" name="feedbackDetails" rows="9"></textarea>
                </label>
            </div>

            <aside class="blai-feedback-form-side">
                <section class="blai-feedback-attachments" aria-labelledby="blai-feedback-attachments-title">
                    <h3 id="blai-feedback-attachments-title">可选诊断附件</h3>
                    <p>仅勾选的附件会在生成预览时读取。</p>
                    ${diagnosticAttachment('第三方扩展与酒馆助手脚本环境', 'installedEnabledExtensions', true, '包括已安装且未禁用的第三方扩展，以及酒馆助手中已启用的全局脚本；不会附加脚本正文。')}
                    ${diagnosticAttachment('运行日志', 'runtimeLog', true, '包括 Veridis 已记录的结构化运行事件；不会附加 AI 上下文中的提示词、请求或回复正文。')}
                    ${diagnosticAttachment('最近一次失败的 Deep Clean 诊断', 'deepCleanLatestFailure', Boolean(slots.latestFailure))}
                    ${diagnosticAttachment('上一次失败的 Deep Clean 诊断', 'deepCleanPreviousFailure', Boolean(slots.previousFailure))}
                    ${diagnosticAttachment('最近一次成功的 Deep Clean 诊断', 'deepCleanLastSuccess', Boolean(slots.lastSuccess))}
                </section>

                <p class="blai-feedback-privacy" role="note">
                    Veridis 不会自动读取或附加 API Key、API URL、聊天内容、提示词、AI 回复、角色卡正文或世界书正文。请勿在详细说明中主动粘贴敏感信息。
                </p>

                <button id="blai-feedback-preview-generate" class="blai-feedback-primary" type="button">生成提交预览</button>
                <div id="blai-feedback-status" class="blai-feedback-status" aria-live="polite"></div>
            </aside>

            <section id="blai-feedback-preview-section" class="blai-feedback-preview" hidden>
                <header>
                    <div>
                        <h3>提交预览</h3>
                        <p>下方 JSON 将作为请求正文原样发送。</p>
                    </div>
                </header>
                <pre id="blai-feedback-preview-json" tabindex="0"></pre>
                <label class="blai-feedback-confirm">
                    <input id="blai-feedback-confirm" type="checkbox">
                    <span>我已检查并确认提交以上完整内容。</span>
                </label>
                <button id="blai-feedback-submit" class="blai-feedback-primary" type="button" disabled>提交匿名反馈</button>
                <div id="blai-feedback-submit-status" class="blai-feedback-submit-status" aria-live="polite"></div>
            </section>
        </form>
    `;
    updateFeedbackAreaSummary();
}

export function renderRuntimeLog() {
    const content = document.getElementById('blai-feedback-workspace-content');
    if (!content) return;
    content.innerHTML = `
        <section class="blai-feedback-local-view">
            <header class="blai-feedback-local-heading">
                <div><h2>运行日志</h2><p>查看 Veridis 最近记录的本地运行诊断事件。</p></div>
                <button id="blai-feedback-copy-log" type="button">复制日志</button>
            </header>
            <pre id="blai-ai-debug-log" class="blai-feedback-log-output" tabindex="0" aria-live="polite"></pre>
        </section>
    `;
    content.querySelector('#blai-ai-debug-log').textContent = getAiRewriteDebugDisplayText();
}

export function renderAiContext() {
    const content = document.getElementById('blai-feedback-workspace-content');
    if (!content) return;
    content.innerHTML = `
        <section class="blai-feedback-local-view">
            <header class="blai-feedback-local-heading">
                <div><h2>AI 上下文</h2><p>查看 Veridis 实际发送给 AI 的请求上下文及返回结果。其中可能包含提示词、上下文和 AI 回复，仅在本地显示。</p></div>
                <button id="blai-ai-monitor-clear" type="button">清空</button>
            </header>
            <pre id="blai-ai-monitor-output" class="blai-feedback-log-output" tabindex="0" aria-label="AI 上下文"></pre>
        </section>
    `;
    content.querySelector('#blai-ai-monitor-output').textContent = formatAiCommunicationRecords();
}

function diagnosticSummaryRows(record) {
    const summary = record?.summary || {};
    const rows = [
        ['时间', record?.endedAt],
        ['时长', Number.isFinite(record?.durationMs) ? `${record.durationMs} ms` : '—'],
        ['处理模式', record?.mode?.processingMode || '—'],
        ['终止阶段', record?.terminalStage || '—'],
        ['结果', record?.outcome || '—'],
    ];
    if (record?.failureCode) rows.push(['失败代码', record.failureCode]);
    rows.push(
        ['扫描项', summary.scannedItemCount ?? '—'],
        ['受影响项', summary.affectedItemCount ?? '—'],
        ['已应用项', summary.appliedItemCount ?? '—'],
        ['失败项', summary.failedItemCount ?? '—'],
    );
    if (Object.hasOwn(summary, 'failedAiRequestCount')) {
        rows.push(['AI 请求失败', summary.failedAiRequestCount]);
    }
    return rows;
}

function diagnosticSlot(slot, title, record) {
    if (!record) {
        return `
            <section class="blai-feedback-diagnostic-record" data-diagnostic-slot="${slot}">
                <h3>${escapeHtml(title)}</h3>
                <p class="blai-feedback-no-record">暂无记录</p>
            </section>
        `;
    }
    return `
        <section class="blai-feedback-diagnostic-record" data-diagnostic-slot="${slot}">
            <div class="blai-feedback-diagnostic-heading">
                <h3>${escapeHtml(title)}</h3>
                <button type="button" data-feedback-expand-diagnostic="${slot}" aria-expanded="false">展开安全 JSON</button>
            </div>
            <dl>
                ${diagnosticSummaryRows(record).map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}
            </dl>
            <pre data-feedback-diagnostic-json="${slot}" tabindex="0" hidden></pre>
        </section>
    `;
}

export function renderDeepCleanDiagnostics(slots = {}) {
    const content = document.getElementById('blai-feedback-workspace-content');
    if (!content) return;
    content.innerHTML = `
        <div class="blai-feedback-diagnostics-view">
            <header class="blai-feedback-diagnostics-intro">
                <div>
                    <h2>Deep Clean 诊断</h2>
                    <p>仅显示本地保存的安全执行信息。</p>
                </div>
                <button id="blai-feedback-clear-deep-clean" type="button">清除本地 Deep Clean 诊断</button>
            </header>
            ${diagnosticSlot('latestFailure', '最近一次失败', slots.latestFailure)}
            ${diagnosticSlot('previousFailure', '上一次失败', slots.previousFailure)}
            ${diagnosticSlot('lastSuccess', '最近一次成功', slots.lastSuccess)}
        </div>
    `;
}

export function openFeedbackWorkspace(view) {
    const workspace = document.getElementById('blai-feedback-workspace');
    if (!workspace) return;
    workspace.setAttribute('aria-hidden', 'false');
    workspace.dataset.feedbackView = view;
    workspace.querySelectorAll('[data-feedback-view]').forEach((button) => {
        const active = button.dataset.feedbackView === view;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
    });
}

export function closeFeedbackWorkspace() {
    document.getElementById('blai-feedback-workspace')?.setAttribute('aria-hidden', 'true');
}

export function renderFeedbackPreview(payloadJson) {
    const section = document.getElementById('blai-feedback-preview-section');
    const output = document.getElementById('blai-feedback-preview-json');
    if (!section || !output) return;
    output.textContent = payloadJson;
    section.hidden = false;
    document.getElementById('blai-feedback-confirm')?.removeAttribute('checked');
    const confirmation = document.getElementById('blai-feedback-confirm');
    if (confirmation) confirmation.checked = false;
    const submit = document.getElementById('blai-feedback-submit');
    if (submit) submit.disabled = true;
    clearFeedbackSubmissionStatus();
}

export function clearRenderedFeedbackPreview({ preserveSubmissionStatus = false } = {}) {
    const section = document.getElementById('blai-feedback-preview-section');
    const output = document.getElementById('blai-feedback-preview-json');
    if (output) output.textContent = '';
    if (section) section.hidden = true;
    const confirmation = document.getElementById('blai-feedback-confirm');
    if (confirmation) confirmation.checked = false;
    const submit = document.getElementById('blai-feedback-submit');
    if (submit) submit.disabled = true;
    if (!preserveSubmissionStatus) clearFeedbackSubmissionStatus();
    if (preserveSubmissionStatus && section && document.getElementById('blai-feedback-submit-status')?.textContent) {
        section.hidden = false;
    }
}

export function setFeedbackSubmitEnabled(enabled) {
    const submit = document.getElementById('blai-feedback-submit');
    if (submit) submit.disabled = !enabled;
}

export function showFeedbackStatus(message, status = '') {
    const element = document.getElementById('blai-feedback-status');
    if (!element) return;
    element.textContent = String(message || '');
    element.dataset.status = status;
}

export function showFeedbackSubmissionStatus(message, status = '') {
    const element = document.getElementById('blai-feedback-submit-status');
    if (!element) return;
    element.textContent = String(message || '');
    element.dataset.status = status;
}

export function clearFeedbackSubmissionStatus() {
    const element = document.getElementById('blai-feedback-submit-status');
    if (!element) return;
    element.textContent = '';
    element.dataset.status = '';
}

export function showDeepCleanDiagnosticJson(slot, record, expanded) {
    const output = document.querySelector(`[data-feedback-diagnostic-json="${slot}"]`);
    const button = document.querySelector(`[data-feedback-expand-diagnostic="${slot}"]`);
    if (!output || !button) return;
    output.textContent = expanded ? JSON.stringify(record, null, 2) : '';
    output.hidden = !expanded;
    button.setAttribute('aria-expanded', String(expanded));
    button.textContent = expanded ? '收起安全 JSON' : '展开安全 JSON';
}
