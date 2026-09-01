// Owns Deep Clean DOM projection only; it reads session and review state without owning lifecycle transitions or resource persistence.
import { deepCleanRuntimeState } from './state.js';
import { renderFullTextDiffBlocks } from '../diff/compare.js';
import { resolveDeepCleanFinalProposedText } from './aiProcessing.js';
import { getDeepCleanReviewEntry, resolveDeepCleanReviewedText, resolveDeepCleanReviewRunsText } from './review.js';
import { offerDeepCleanTourFirstUse } from '../ui/tour.js';

function deepCleanSafeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function deepCleanSearchValue(name) {
    return String($(`[data-deep-clean-search="${name}"]`).val() || '');
}

function deepCleanMatchesSearch(item, query) {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return true;
    return String(item.displayLabel || '').toLocaleLowerCase().includes(normalizedQuery)
        || String(item.characterKey || item.personaKey || item.worldBookKey || item.chatId || '')
            .toLocaleLowerCase()
            .includes(normalizedQuery);
}

function renderDeepCleanChoice({ value, checked, title, detail, kind, source }) {
    const encodedValue = encodeURIComponent(value);
    return `
        <label class="blai-deep-clean-choice">
            <input type="checkbox" data-deep-clean-${source}="${kind}" data-deep-clean-value="${encodedValue}" ${checked ? 'checked' : ''}>
            <span class="blai-deep-clean-choice-copy">
                <span class="blai-deep-clean-choice-title">${deepCleanSafeHtml(title)}</span>
                ${detail ? `<span class="blai-deep-clean-choice-meta">${deepCleanSafeHtml(detail)}</span>` : ''}
            </span>
        </label>
    `;
}

function renderDeepCleanResourcePanel({ kind, title, items, selectionKeys, keyName, searchName, detailFor, hasCurrentSearchSelectionActions = false }) {
    const query = deepCleanSearchValue(searchName);
    const visibleItems = items.filter((item) => deepCleanMatchesSearch(item, query));
    const orderedItems = [
        ...visibleItems.filter((item) => selectionKeys.includes(item[keyName])),
        ...visibleItems.filter((item) => !selectionKeys.includes(item[keyName])),
    ];
    return `
        <section id="blai-deep-clean-${kind}-panel" class="blai-deep-clean-resource-panel" role="tabpanel" aria-labelledby="blai-deep-clean-${kind}-tab">
            <div class="blai-deep-clean-resource-toolbar">
                <div class="blai-deep-clean-search-field">
                    <i class="fas fa-magnifying-glass" aria-hidden="true"></i>
                    <input id="blai-deep-clean-${kind}-search" class="blai-deep-clean-input" type="search" data-deep-clean-search="${searchName}" value="${deepCleanSafeHtml(query)}" placeholder="搜索${title}" aria-label="搜索${title}">
                </div>
                <div class="blai-deep-clean-resource-summary">
                    <span>已选择 <strong>${selectionKeys.length}</strong> 项 · 共 ${items.length} 项</span>
                    ${hasCurrentSearchSelectionActions ? `
                    <span class="blai-deep-clean-search-selection-actions" aria-label="${title}当前搜索结果选择">
                        <button type="button" data-deep-clean-search-selection="${kind}" data-deep-clean-search-selection-action="select">选择当前结果</button>
                        <button type="button" data-deep-clean-search-selection="${kind}" data-deep-clean-search-selection-action="deselect">取消当前结果</button>
                    </span>
                    ` : ''}
                </div>
            </div>
            <div class="blai-deep-clean-resource-list" aria-label="${title}最终选择">
                ${orderedItems.length
        ? orderedItems.map((item) => renderDeepCleanChoice({
            value: item[keyName],
            checked: selectionKeys.includes(item[keyName]),
            title: item.displayLabel,
            detail: detailFor(item),
            kind,
            source: 'resource',
        })).join('')
        : '<p class="blai-deep-clean-empty">没有匹配的资源。</p>'}
            </div>
        </section>
    `;
}
export function openDeepCleanInitialSelection(options = {}) {
    $('#blai-deep-clean-workspace').addClass('blai-is-open').attr('aria-hidden', 'false');
    if (options.preserveContent === true) return;
    setDeepCleanWorkspaceHeader('', '深度净化', '初始选择');
    $('#blai-deep-clean-content').html(`
        <section class="blai-deep-clean-state blai-deep-clean-loading-state" aria-label="正在读取可选资源">
            <i class="fas fa-spinner fa-spin" aria-hidden="true"></i>
            <h3>正在读取可选资源</h3>
        </section>
    `);
}

export function closeDeepCleanInitialSelection() {
    $('#blai-deep-clean-workspace').removeClass('blai-is-open').attr('aria-hidden', 'true');
}

export function showDeepCleanInitialSelectionError(error) {
    setDeepCleanWorkspaceHeader('深度净化 · 错误', '深度净化无法完成', '请查看错误信息后结束当前工作区。');
    $('#blai-deep-clean-content').html(`
        <section class="blai-deep-clean-state blai-deep-clean-error-state" aria-label="深度净化错误">
            <i class="fas fa-triangle-exclamation" aria-hidden="true"></i>
            <p class="blai-deep-clean-error">${deepCleanSafeHtml(error?.message || error)}</p>
            <button id="blai-deep-clean-close" type="button">关闭工作区</button>
        </section>
    `);
}

function setDeepCleanWorkspaceHeader(eyebrow, title, description, actionHtml = '', showTourHelp = false) {
    $('#blai-deep-clean-workspace .blai-deep-clean-eyebrow').text(eyebrow).prop('hidden', !eyebrow);
    $('#blai-deep-clean-title').text(title).prop('hidden', !title);
    $('#blai-deep-clean-description').text(description).prop('hidden', !description);
    const tourHelp = showTourHelp
        ? '<button id="blai-deep-clean-tour-help" type="button" class="blai-deep-clean-header-stop" title="Deep Clean 导览" aria-label="Deep Clean 导览"><i class="fas fa-question" aria-hidden="true"></i></button>'
        : '';
    $('#blai-deep-clean-header-actions').html(`${tourHelp}${actionHtml}`);
}

const deepCleanScanStageLabels = {
    prepare: '准备资源',
    read: '读取内容',
    analyze: '分析规则',
    summarize: '汇总结果',
};

function deepCleanMeasuredProgress(progress = {}) {
    const current = Number(progress.current);
    const total = Number(progress.total);
    if (!Number.isFinite(current) || !Number.isFinite(total) || current < 0 || total <= 0 || current > total) return null;
    return { current, total, percent: Math.round((current / total) * 100) };
}

export function renderDeepCleanScanProgress(progress = {}) {
    const stage = deepCleanScanStageLabels[progress.stage] || '准备资源';
    const measuredProgress = deepCleanMeasuredProgress(progress);
    const detail = measuredProgress
        ? `${measuredProgress.current.toLocaleString('zh-CN')} / ${measuredProgress.total.toLocaleString('zh-CN')} · ${measuredProgress.percent}%`
        : '进行中';
    const stageOrder = ['prepare', 'read', 'analyze', 'summarize'];
    const activeIndex = Math.max(stageOrder.indexOf(progress.stage), 0);
    const stages = stageOrder.map((stageName, index) => ({
        label: deepCleanScanStageLabels[stageName],
        state: index < activeIndex ? 'complete' : (index === activeIndex ? 'active' : 'pending'),
    }));
    const frozenItems = deepCleanRuntimeState.deepCleanSelection?.run?.contentItems || [];
    setDeepCleanWorkspaceHeader('深度净化 · 扫描', '深度净化进行中', '扫描冻结资源；不会写入正式数据。');
    $('#blai-deep-clean-content').html(`
        <div class="blai-deep-clean-processing" aria-label="深度净化扫描进度">
            <main class="blai-deep-clean-processing-main">
                <div class="blai-deep-clean-processing-intro">
                    <h3>深度净化进行中</h3>
                    <p>正在读取并分析本次选择的真实内容项。</p>
                </div>
                <ol class="blai-deep-clean-pipeline">
                    ${stages.map((entry, index) => `
                        <li class="is-${entry.state}">
                            <span class="blai-deep-clean-pipeline-marker">${entry.state === 'complete' ? '<i class="fas fa-check" aria-hidden="true"></i>' : ''}</span>
                            <div>
                                <strong>${deepCleanSafeHtml(entry.label)}</strong>
                                ${index === activeIndex ? `
                                    <span>${deepCleanSafeHtml(detail)}</span>
                                    ${measuredProgress ? `<progress class="is-determinate" value="${measuredProgress.current}" max="${measuredProgress.total}" aria-label="${deepCleanSafeHtml(stage)}"></progress>` : ''}
                                ` : ''}
                            </div>
                        </li>
                    `).join('')}
                </ol>
                <button id="blai-deep-clean-stop" class="blai-deep-clean-secondary-action" type="button">停止处理</button>
            </main>
            ${deepCleanBatchSummaryHtml({
        title: '扫描摘要',
        itemIndexes: frozenItems.map((_, itemIndex) => itemIndex),
        sourceCharacterCount: frozenItems.reduce((total, item) => total + String(item.originalText || '').length, 0),
        emptyText: progress.stage === 'read' ? '正在读取内容项。' : '建立审核批次后显示具体内容。',
        showContents: false,
    })}
        </div>
    `);
}

export function renderDeepCleanScanResult(scanResult = {}) {
    const affectedByType = scanResult.affectedByType || {};
    const metrics = [
        ['扫描项目', scanResult.scannedItemCount],
        ['受影响项目', scanResult.affectedItemCount],
        ['程序命中', scanResult.programHitCount],
        ['AI 原始匹配', scanResult.aiHitCount],
        ['待处理字符', scanResult.pendingCharacterCount],
    ];
    const categories = [
        ['Character', '角色卡内容'],
        ['Message', '消息'],
        ['Persona', 'User 设定'],
        ['World Book', '世界书'],
        ['Shujuku', 'Shujuku'],
    ];
    const directProgramApply = deepCleanRuntimeState.deepCleanSelection?.run?.input?.processingMode === 'program'
        && deepCleanRuntimeState.deepCleanSelection?.run?.input?.programApplyPolicy === 'direct';
    setDeepCleanWorkspaceHeader(
        '深度净化 · 扫描结果',
        '扫描结果',
        directProgramApply ? '扫描检查点：确认后开始按批处理并直接应用。' : '扫描检查点：确认后才开始处理审核批次。',
    );
    $('#blai-deep-clean-content').html(`
        <section class="blai-deep-clean-result" aria-label="深度净化扫描结果">
            <header><h3>扫描完成</h3><p>结果仅描述冻结内容中的当前规则命中；尚未处理或写入。</p></header>
            <div class="blai-deep-clean-scan-metrics">
                ${metrics.map(([label, value]) => `<div><span>${deepCleanSafeHtml(label)}</span><strong>${Number(value) || 0}</strong></div>`).join('')}
            </div>
            <section class="blai-deep-clean-scan-categories" aria-labelledby="blai-deep-clean-scan-categories-title">
                <h3 id="blai-deep-clean-scan-categories-title">受影响内容项</h3>
                ${categories.map(([key, label]) => `<div><span>${deepCleanSafeHtml(label)}</span><strong>${Number(affectedByType[key]) || 0}</strong></div>`).join('')}
            </section>
            <div class="blai-deep-clean-actions">
                <button id="blai-deep-clean-stop" class="blai-deep-clean-secondary-action" type="button">停止</button>
                <button id="blai-deep-clean-process-program" class="blai-deep-clean-primary-action" type="button">${directProgramApply ? '开始处理并直接应用' : '开始处理审核批次'}</button>
            </div>
        </section>
    `);
}

const deepCleanBatchStageLabels = {
    waiting: '等待开始',
    'program-processing': '程序处理',
    'ai-planning': 'AI 规划',
    'ai-processing': '等待 AI 返回',
    'proposed-ready': '准备审核',
    'direct-applying': '直接应用',
    'batch-applied': '批次已应用',
    prepared: '已就绪',
    failed: '下一批处理失败',
};

function deepCleanBatchProgressText(progress = {}) {
    return `${Number(progress.sourceCharacterCount || 0).toLocaleString('zh-CN')} 字符 · ${Number(progress.itemCount) || 0} 个内容项`;
}

function deepCleanFrozenContentItems() {
    return deepCleanRuntimeState.deepCleanSelection?.run?.contentItems || [];
}

function deepCleanBatchSummaryBodyHtml({ title, itemIndexes, sourceCharacterCount, status, emptyText, showContents = true }) {
    const contentItems = deepCleanFrozenContentItems();
    const indexes = Array.isArray(itemIndexes) ? itemIndexes : [];
    const identities = showContents ? indexes
        .map((itemIndex) => contentItems[itemIndex])
        .filter(Boolean)
        .map((item) => deepCleanReviewIdentity(item)) : [];
    return `
        <header class="blai-deep-clean-batch-head"><h3>${deepCleanSafeHtml(title)}</h3></header>
        <div class="blai-deep-clean-batch-body">
            ${indexes.length ? `
                <div class="blai-deep-clean-batch-metrics">
                    <span><strong>${Number(sourceCharacterCount || 0).toLocaleString('zh-CN')}</strong> 字符</span>
                    <i aria-hidden="true">·</i>
                    <span><strong>${indexes.length}</strong> 个内容项</span>
                </div>
            ` : ''}
            ${status ? `<p class="blai-deep-clean-batch-status"><span aria-hidden="true"></span>${deepCleanSafeHtml(status)}</p>` : ''}
            ${identities.length ? `
                <div class="blai-deep-clean-batch-contents">
                    <h4>内容</h4>
                    <ul>${identities.map((identity) => `<li>${deepCleanSafeHtml(identity)}</li>`).join('')}</ul>
                </div>
            ` : `<p class="blai-deep-clean-batch-empty">${deepCleanSafeHtml(emptyText || '没有后续审核批次。')}</p>`}
        </div>
    `;
}

function deepCleanBatchSummaryHtml(options = {}) {
    return `<aside class="blai-deep-clean-batch-summary">${deepCleanBatchSummaryBodyHtml(options)}</aside>`;
}

function deepCleanLookaheadHtml(progress = null) {
    if (!progress) return deepCleanBatchSummaryBodyHtml({ title: '下一批', emptyText: '没有后续审核批次。' });
    const stage = deepCleanBatchStageLabels[progress.stage] || progress.stage || '处理中';
    return deepCleanBatchSummaryBodyHtml({
        title: '下一批',
        itemIndexes: progress.itemIndexes,
        sourceCharacterCount: progress.sourceCharacterCount,
        status: progress.error || stage,
        emptyText: progress.stage === 'waiting' ? '正在确定下一批内容。' : '当前没有可显示的批次内容。',
    });
}

export function renderDeepCleanBatchProgress(progress = {}) {
    const input = deepCleanRuntimeState.deepCleanSelection?.run?.input;
    const includeAi = input?.processingMode === 'program-ai';
    const directProgramApply = input?.processingMode === 'program' && input?.programApplyPolicy === 'direct';
    const stage = directProgramApply && progress.stage === 'proposed-ready'
        ? '准备直接应用'
        : (deepCleanBatchStageLabels[progress.stage] || progress.stage || '处理中');
    const measuredProgress = deepCleanMeasuredProgress(progress);
    const completedBatchText = directProgramApply
        ? ` · 已完成 ${Number(progress.completedBatchCount) || 0} 批`
        : '';
    const pipeline = directProgramApply
        ? [
            { id: 'program-processing', label: '程序处理' },
            { id: 'proposed-ready', label: '准备直接应用' },
            { id: 'direct-applying', label: '直接应用' },
            { id: 'batch-applied', label: '批次已应用' },
        ]
        : [
            { id: 'program-processing', label: '程序处理' },
            ...(includeAi ? [
            { id: 'ai-planning', label: 'AI 规划' },
            { id: 'ai-processing', label: '等待 AI 返回' },
            ] : []),
            { id: 'proposed-ready', label: '准备审核' },
        ];
    const activeIndex = Math.max(pipeline.findIndex((entry) => entry.id === progress.stage), 0);
    setDeepCleanWorkspaceHeader(
        '深度净化 · 处理中',
        '深度净化进行中',
        directProgramApply
            ? '按冻结后受影响内容项的原始顺序处理并直接应用当前批次。'
            : '按冻结后受影响内容项的原始顺序处理当前审核批次。',
    );
    $('#blai-deep-clean-content').html(`
        <div class="blai-deep-clean-processing" aria-label="${directProgramApply ? '深度净化直接应用批次处理进度' : '深度净化审核批次处理进度'}">
            <main class="blai-deep-clean-processing-main">
                <div class="blai-deep-clean-processing-intro">
                    <h3>${directProgramApply ? '正在处理并直接应用' : '深度净化进行中'}</h3>
                    <p>${deepCleanSafeHtml(deepCleanBatchProgressText(progress) + completedBatchText)}</p>
                </div>
                <ol class="blai-deep-clean-pipeline">
                    ${pipeline.map((entry, index) => {
        const state = index < activeIndex ? 'complete' : (index === activeIndex ? 'active' : 'pending');
        return `
                            <li class="is-${state}">
                                <span class="blai-deep-clean-pipeline-marker">${state === 'complete' ? '<i class="fas fa-check" aria-hidden="true"></i>' : ''}</span>
                                <div>
                                    <strong>${deepCleanSafeHtml(entry.label)}</strong>
                                    ${state === 'active' ? `
                                        <span>${entry.id === 'ai-processing' ? '<i class="fas fa-spinner fa-spin" aria-hidden="true"></i>' : ''}${deepCleanSafeHtml(measuredProgress ? `${stage} · ${measuredProgress.current.toLocaleString('zh-CN')} / ${measuredProgress.total.toLocaleString('zh-CN')} · ${measuredProgress.percent}%` : stage)}</span>
                                        ${measuredProgress ? `<progress class="is-determinate" value="${measuredProgress.current}" max="${measuredProgress.total}" aria-label="${deepCleanSafeHtml(stage)}"></progress>` : ''}
                                    ` : ''}
                                </div>
                            </li>
                        `;
    }).join('')}
                </ol>
                <button id="blai-deep-clean-stop" class="blai-deep-clean-secondary-action" type="button">停止处理</button>
            </main>
            ${deepCleanBatchSummaryHtml({
        title: '批次摘要',
        itemIndexes: progress.itemIndexes,
        sourceCharacterCount: progress.sourceCharacterCount,
        status: stage,
        emptyText: '批次内容尚未报告。',
    })}
        </div>
    `);
}

export function renderDeepCleanLookaheadProgress(progress = null) {
    const target = $('#blai-deep-clean-lookahead');
    if (target.length) target.html(deepCleanLookaheadHtml(progress));
}

export function renderDeepCleanStopped() {
    setDeepCleanWorkspaceHeader('', '', '');
    $('#blai-deep-clean-content').html(`
        <section class="blai-deep-clean-state blai-deep-clean-stopped-state" aria-label="深度净化已停止">
            <i class="fas fa-stop-circle" aria-hidden="true"></i>
            <h3>深度净化 · 已停止</h3>
            <p>未正式应用的当前审核批次与预处理结果已丢弃；之前成功应用的结果保持不变。</p>
            <button id="blai-deep-clean-close" type="button">关闭</button>
        </section>
    `);
}

export function renderDeepCleanComplete(summary) {
    const renderMetrics = (metrics, className = '') => `
        <dl class="blai-deep-clean-completion-metrics ${className}">
            ${metrics.map(([label, value]) => `
                <div>
                    <dt>${deepCleanSafeHtml(label)}</dt>
                    <dd>${Number(value).toLocaleString('zh-CN')}</dd>
                </div>
            `).join('')}
        </dl>
    `;
    const hasAiSummary = Object.hasOwn(summary, 'totalAiRequestCount');
    setDeepCleanWorkspaceHeader('', '', '');
    $('#blai-deep-clean-content').html(`
        <section class="blai-deep-clean-state blai-deep-clean-complete-state" aria-label="深度净化已完成">
            <i class="fas fa-check" aria-hidden="true"></i>
            <h3>深度净化 · 已完成</h3>
            <p>所有批次均已处理，冻结范围内的受影响 Content Items 均已得到最终结果。</p>
            <div class="blai-deep-clean-completion-summary">
                <section aria-labelledby="blai-deep-clean-completion-scope">
                    <h4 id="blai-deep-clean-completion-scope">处理范围</h4>
                    ${renderMetrics([
        ['角色资源', summary.characterResourceCount],
        ['聊天分支', summary.chatBranchResourceCount],
        ['扫描 Content Items', summary.scannedItemCount],
        ['受影响 Content Items', summary.affectedItemCount],
    ])}
                </section>
                <section aria-labelledby="blai-deep-clean-completion-outcome">
                    <h4 id="blai-deep-clean-completion-outcome">Item 结果</h4>
                    ${renderMetrics([
        ['成功应用', summary.appliedItemCount],
        ['保留原文', summary.retainedOriginalItemCount],
        ['失败', summary.failedItemCount],
        ['未处理', summary.unprocessedItemCount],
    ])}
                </section>
                ${hasAiSummary ? `
                    <section aria-labelledby="blai-deep-clean-completion-ai">
                        <h4 id="blai-deep-clean-completion-ai">Program + AI</h4>
                        ${renderMetrics([
        ['AI Requests', summary.totalAiRequestCount],
        ['成功 Requests', summary.successfulAiRequestCount],
        ['失败 Requests', summary.failedAiRequestCount],
        ['AI 失败保留原文', summary.aiFailedOriginalItemCount],
        ['超长未执行 AI', summary.oversizedAiItemCount],
    ], 'is-ai')}
                    </section>
                ` : ''}
            </div>
            <button id="blai-deep-clean-close" type="button">关闭</button>
        </section>
    `);
}

function deepCleanReviewIdentity(item = {}) {
    const locator = item.locator || {};
    const character = locator.characterKey ? `角色 · ${locator.characterKey}` : '角色';
    if (item.kind === 'character-description') return `${character} · 描述`;
    if (item.kind === 'character-personality') return `${character} · 性格`;
    if (item.kind === 'character-first-message') return `${character} · 首条消息`;
    if (item.kind === 'character-alternate-greeting') return `${character} · 备选开场白 ${Number(locator.alternateGreetingIndex) + 1}`;
    if (item.kind === 'embedded-world-book-entry') {
        const ownerName = String(item.ownerDisplayName || locator.characterKey || '').trim();
        const entryName = String(item.displayName || '').trim() || '世界书条目';
        return `角色 · ${ownerName} · 内嵌世界书 · ${entryName}`;
    }
    if (item.kind === 'user-message') return `聊天 · ${locator.chatId || '分支'} · 消息 ${Number(locator.messageIndex) + 1} · 用户`;
    if (item.kind === 'assistant-swipe') return `聊天 · ${locator.chatId || '分支'} · 消息 ${Number(locator.messageIndex) + 1}${Number.isInteger(locator.swipeIndex) ? ` · Swipe ${locator.swipeIndex + 1}` : ''}`;
    if (item.kind === 'persona-description') return `User 设定 · ${locator.personaKey || '描述'}`;
    if (item.kind === 'external-world-book-entry') {
        const entryName = String(item.displayName || '').trim() || '世界书条目';
        return `世界书 · ${locator.worldBookKey || '世界书'} · ${entryName}`;
    }
    if (item.kind === 'shujuku-cell') {
        const protocolLabel = item.storageProtocol === 'v1' ? 'Shujuku V1' : 'Shujuku V2';
        return `${protocolLabel} · ${locator.sheetKey || '表'} · 行 ${locator.rowId ?? ''} · ${locator.columnKey || '单元格'}`;
    }
    return '内容项';
}

function deepCleanProtectionLabel(item = {}) {
    return item.protectionReason === 'mvu'
        ? '疑似 MVU'
        : (item.protectionReason === 'ejs' ? '疑似 EJS' : '');
}

function renderDeepCleanReviewDocument(entry) {
    const renderRuns = (runs) => (runs || []).map((run) => {
        const text = deepCleanSafeHtml(run.text);
        return run.source === 'manual' ? `<span class="blai-deep-clean-review-manual">${text}</span>` : text;
    }).join('');
    const operations = entry.blocks.flatMap((block, blockIndex) => {
        if (block.type === 'equal') {
            const text = resolveDeepCleanReviewRunsText(block.runs);
            return text === '' ? [] : [{ type: 'equal', text, runs: block.runs, blockIndex, atomic: true }];
        }
        const oldText = resolveDeepCleanReviewRunsText(block.oldRuns);
        const newText = resolveDeepCleanReviewRunsText(block.newRuns);
        return [
            { type: 'delete', text: oldText, runs: block.oldRuns, blockIndex, branch: 'old', active: block.active, isEmpty: oldText === '', isPureDeletion: newText === '', atomic: true, forceRender: oldText === '' },
            { type: 'insert', text: newText, runs: block.newRuns, blockIndex, branch: 'new', active: block.active, isEmpty: newText === '', atomic: true, forceRender: newText === '' },
        ];
    });
    const renderBranch = (operation) => {
        if (operation.type === 'equal') {
            return `<span
                class="blai-deep-clean-review-equal"
                data-deep-clean-review-equal-block-index="${operation.blockIndex}"
                tabindex="0"
                role="textbox"
                contenteditable="plaintext-only"
                aria-multiline="true"
                spellcheck="true"
                aria-label="未变化文本，可直接编辑"
            >${renderRuns(operation.runs)}</span>`;
        }
        const selected = operation.active === operation.branch;
        if (operation.isEmpty) {
            const label = operation.branch === 'old' ? '空原文' : '空净化后文本';
            return `<button
                class="blai-deep-clean-review-empty-branch is-${operation.branch} ${selected ? 'is-active' : 'is-inactive'}"
                type="button"
                data-deep-clean-review-empty-branch
                data-deep-clean-review-block-branch="${operation.branch}"
                data-deep-clean-review-block-index="${operation.blockIndex}"
                aria-pressed="${selected}"
                aria-label="${label}${selected ? '，已选择' : '，点击选择'}"
            >${label}</button>`;
        }
        const isManualOverride = selected && operation.branch === 'old';
        const isRestoredDeletion = isManualOverride && operation.isPureDeletion;
        const tag = operation.branch === 'old'
            ? (selected ? 'span' : 'del')
            : 'ins';
        const label = operation.branch === 'old' ? '原文片段' : '净化后片段';
        return `<${tag}
            class="blai-deep-clean-review-fragment is-${operation.branch} ${selected ? 'is-active' : 'is-inactive'} ${isManualOverride ? 'is-manual-override' : ''} ${isRestoredDeletion ? 'is-restored-deletion' : ''}"
            data-deep-clean-review-block-branch="${operation.branch}"
            data-deep-clean-review-block-index="${operation.blockIndex}"
            tabindex="0"
            role="${selected ? 'textbox' : 'button'}"
            ${selected ? 'contenteditable="plaintext-only" aria-multiline="true" spellcheck="true"' : ''}
            aria-label="${label}${selected ? '，已选择，可直接编辑' : '，点击选择'}"
        >${renderRuns(operation.runs)}</${tag}>`;
    };
    return `<div class="blai-diff-full-text">${renderFullTextDiffBlocks(operations, renderBranch, {
        modified: 'blai-diff-full-modified blai-deep-clean-review-modified',
    })}</div>`;
}

function renderDeepCleanReviewViewSwitcher(viewMode) {
    return `<nav class="blai-deep-clean-review-views" aria-label="审核视图">
        ${[
            ['review', 'Review'],
            ['original', '原版'],
            ['cleaned', '净化后'],
            ['final', '最终'],
        ].map(([value, label]) => `<button
            type="button"
            data-deep-clean-review-view="${value}"
            aria-pressed="${viewMode === value}"
        >${label}</button>`).join('')}
    </nav>`;
}

function renderDeepCleanReviewView(session, itemIndex, item, entry) {
    const viewMode = ['review', 'original', 'cleaned', 'final'].includes(session.viewMode)
        ? session.viewMode
        : 'review';
    if (viewMode === 'review') {
        return `<div aria-label="全文差异审核">${renderDeepCleanReviewDocument(entry)}</div>`;
    }
    const projections = {
        original: { label: '冻结原版', text: item.originalText },
        cleaned: { label: '初始净化后结果', text: resolveDeepCleanFinalProposedText(session.processedRun, itemIndex) },
        final: { label: '当前最终结果', text: resolveDeepCleanReviewedText(session, itemIndex) },
    };
    const projection = projections[viewMode];
    return `<div class="blai-deep-clean-review-projection" role="document" aria-label="${projection.label}">${deepCleanSafeHtml(projection.text)}</div>`;
}

export function renderDeepCleanReview(session, lookaheadProgress = null) {
    if (!session) return;
    const total = session.reviewItemIndexes.length;
    const stopAction = '<button id="blai-deep-clean-stop" class="blai-deep-clean-header-stop" type="button"><i class="fas fa-xmark" aria-hidden="true"></i><span>停止</span></button>';
    if (total === 0) {
        setDeepCleanWorkspaceHeader('深度净化', '审核 0 / 0', '本批没有需要审核的文本变更。', stopAction);
        $('#blai-deep-clean-content').html(`
            <section class="blai-deep-clean-review-shell" aria-label="深度净化审核">
                <div class="blai-deep-clean-review-main">
                    <section class="blai-deep-clean-review-area"><p class="blai-deep-clean-empty">所有最终候选均与冻结原文相同。</p></section>
                    <aside id="blai-deep-clean-lookahead" class="blai-deep-clean-batch-summary" aria-live="polite">${deepCleanLookaheadHtml(lookaheadProgress)}</aside>
                </div>
                <nav class="blai-deep-clean-review-navigation" aria-label="审核内容项导航"><span></span><strong>当前项 0 / 0</strong><span></span></nav>
                <footer class="blai-deep-clean-review-apply">
                    <p>当前批 · <strong>0 个内容项</strong></p>
                    <button id="blai-deep-clean-apply" type="button">正式应用本批修改</button>
                </footer>
            </section>
        `);
        return;
    }
    const itemIndex = session.currentItemIndex;
    const position = session.reviewItemIndexes.indexOf(itemIndex);
    const item = session.processedRun?.contentItems?.[itemIndex];
    const entry = getDeepCleanReviewEntry(session, itemIndex);
    if (!item || !entry || position < 0) return;
    const viewMode = ['review', 'original', 'cleaned', 'final'].includes(session.viewMode)
        ? session.viewMode
        : 'review';
    setDeepCleanWorkspaceHeader('深度净化', `审核 ${position + 1} / ${total}`, '', stopAction);
    $('#blai-deep-clean-content').html(`
        <section class="blai-deep-clean-review-shell" aria-label="深度净化审核">
            <div class="blai-deep-clean-review-main">
                <section class="blai-deep-clean-review-area">
                    <header class="blai-deep-clean-review-head">
                        <div>
                            <p>当前审核</p>
                            <h3>${deepCleanSafeHtml(deepCleanReviewIdentity(item))}</h3>
                            ${deepCleanProtectionLabel(item) ? `<span class="blai-deep-clean-review-protection">${deepCleanProtectionLabel(item)}</span>` : ''}
                        </div>
                        ${renderDeepCleanReviewViewSwitcher(viewMode)}
                    </header>
                    <div class="blai-deep-clean-review-scroll">
                        ${renderDeepCleanReviewView(session, itemIndex, item, entry)}
                    </div>
                </section>
                <aside id="blai-deep-clean-lookahead" class="blai-deep-clean-batch-summary" aria-live="polite">${deepCleanLookaheadHtml(lookaheadProgress)}</aside>
            </div>
            <nav class="blai-deep-clean-review-navigation" aria-label="审核内容项导航">
                <button type="button" data-deep-clean-review-nav="previous" ${position === 0 ? 'disabled' : ''}><i class="fas fa-arrow-left" aria-hidden="true"></i>上一个</button>
                <strong>当前项 ${position + 1} / ${total}</strong>
                <button type="button" data-deep-clean-review-nav="next" ${position === total - 1 ? 'disabled' : ''}>下一个<i class="fas fa-arrow-right" aria-hidden="true"></i></button>
            </nav>
            <footer class="blai-deep-clean-review-apply">
                <p>当前批 · <strong>${total} 个内容项</strong></p>
                <button id="blai-deep-clean-apply" type="button">正式应用本批修改</button>
            </footer>
        </section>
    `);
}

function deepCleanApplyResourceTypeLabel(resourceType) {
    return {
        character: '角色',
        'chat-branch': '聊天分支',
        'persona-settings': 'User 设定',
        'world-book': '世界书',
    }[resourceType] || resourceType;
}

function deepCleanApplyStatusLabel(status) {
    return { applied: '已应用', failed: '失败' }[status] || status;
}

export function renderDeepCleanApplyProgress(progress = {}) {
    const completed = Number(progress.completed) || 0;
    const total = Number(progress.total) || 0;
    const detail = progress.resourceKey
        ? `${deepCleanApplyResourceTypeLabel(progress.resourceType)} · ${progress.resourceKey} · ${deepCleanApplyStatusLabel(progress.status)}`
        : '正在准备正式持久化单元';
    const session = deepCleanRuntimeState.deepCleanSelection?.currentReviewSession;
    const batch = session?.processedRun?.reviewBatch || {};
    setDeepCleanWorkspaceHeader('深度净化 · 正式应用', '正在正式应用', '进度按已完成的真实持久化单元计算。');
    $('#blai-deep-clean-content').html(`
        <div class="blai-deep-clean-processing" aria-label="深度净化正式应用进度">
            <main class="blai-deep-clean-processing-main">
                <div class="blai-deep-clean-processing-intro"><h3>正式应用</h3><p>${deepCleanSafeHtml(detail)}</p></div>
                <ol class="blai-deep-clean-pipeline"><li class="is-active"><span class="blai-deep-clean-pipeline-marker"></span><div><strong>正在持久化审核决定</strong><span>${completed} / ${total}</span>${total > 0 ? `<progress class="is-determinate" value="${completed}" max="${total}" aria-label="正式应用进度"></progress>` : ''}</div></li></ol>
                <button id="blai-deep-clean-stop" class="blai-deep-clean-secondary-action" type="button">停止处理</button>
            </main>
            ${deepCleanBatchSummaryHtml({ title: '当前批', itemIndexes: batch.itemIndexes, sourceCharacterCount: batch.sourceCharacterCount, status: '正在应用审核决定', emptyText: '没有可显示的内容项。' })}
        </div>
    `);
}

export function renderDeepCleanInitialSelection(selection, presets = {}) {
    if (!selection) return;
    const { inventory } = selection;
    const specifiedSearch = deepCleanSearchValue('specified-characters');
    const specifiedCharacters = inventory.characters.filter((character) => deepCleanMatchesSearch(character, specifiedSearch));
    const presetNames = Object.keys(presets);
    const currentChatUnavailable = inventory.current.groupChat || !inventory.current.chatKey;
    const currentCharacterUnavailable = inventory.current.groupChat || !inventory.current.characterKey;
    const characterNames = inventory.characters.reduce((names, character) => {
        names[character.characterKey] = character.displayLabel;
        return names;
    }, {});
    const isSpecified = selection.quickSelection === 'specified-characters';
    const workspace = $('#blai-deep-clean-workspace');
    const requestedTab = String(workspace.attr('data-deep-clean-active-resource') || 'character');
    const activeTab = ['character', 'chat', 'persona', 'world-book'].includes(requestedTab) ? requestedTab : 'character';
    const controlsOpen = $('#blai-deep-clean-controls').prop('open') !== false;
    const totalSelected = selection.characterKeys.length + selection.chatKeys.length + selection.personaKeys.length + selection.worldBookKeys.length;
    const programModeSelected = selection.processingMode === 'program';
    const programApplyPolicy = selection.programApplyPolicy === 'direct' ? 'direct' : 'review';
    const tabs = [
        ['character', '角色', selection.characterKeys.length],
        ['chat', '聊天分支', selection.chatKeys.length],
        ['persona', 'User 设定', selection.personaKeys.length],
        ['world-book', '世界书', selection.worldBookKeys.length],
    ];

    workspace.attr('data-deep-clean-active-resource', activeTab);
    setDeepCleanWorkspaceHeader('', '深度净化', '初始选择', '', true);
    $('#blai-deep-clean-content').html(`
        <div class="blai-deep-clean-selection">
            <aside class="blai-deep-clean-side">
                <details id="blai-deep-clean-controls" class="blai-deep-clean-controls" ${controlsOpen ? 'open' : ''}>
                    <summary><span><i class="fas fa-sliders" aria-hidden="true"></i>快速选择与运行设置</span><i class="fas fa-chevron-right" aria-hidden="true"></i></summary>
                    <div class="blai-deep-clean-side-inner">
                <section class="blai-deep-clean-section" aria-labelledby="blai-deep-clean-quick-title">
                    <h3 id="blai-deep-clean-quick-title">快速选择</h3>
                    <p>${inventory.current.groupChat ? '当前是群聊，深度净化不纳入群聊。' : '快速选择只更新最终资源勾选。右侧列表始终是权威范围。'}</p>
                    <div class="blai-deep-clean-quick-list">
                        <button class="blai-deep-clean-quick ${selection.quickSelection === 'current-chat' ? 'is-active' : ''}" type="button" data-deep-clean-quick="current-chat" ${currentChatUnavailable ? 'disabled' : ''}><span>当前聊天</span><i class="fas fa-arrow-right" aria-hidden="true"></i></button>
                        <button class="blai-deep-clean-quick ${selection.quickSelection === 'current-character' ? 'is-active' : ''}" type="button" data-deep-clean-quick="current-character" ${currentCharacterUnavailable ? 'disabled' : ''}><span>当前角色</span><i class="fas fa-arrow-right" aria-hidden="true"></i></button>
                        <details class="blai-deep-clean-specified-picker" ${isSpecified ? 'open' : ''}>
                            <summary class="blai-deep-clean-quick ${isSpecified ? 'is-active' : ''}" data-deep-clean-quick="specified-characters"><span>指定角色</span><i class="fas fa-arrow-right" aria-hidden="true"></i></summary>
                            <div class="blai-deep-clean-specified">
                                <div class="blai-deep-clean-search-field">
                                    <i class="fas fa-magnifying-glass" aria-hidden="true"></i>
                                    <input class="blai-deep-clean-input" type="search" data-deep-clean-search="specified-characters" value="${deepCleanSafeHtml(specifiedSearch)}" placeholder="搜索角色" aria-label="搜索指定角色">
                                </div>
                                <div class="blai-deep-clean-specified-list" aria-label="指定角色">
                                    ${specifiedCharacters.length
        ? specifiedCharacters.map((character) => renderDeepCleanChoice({
            value: character.characterKey,
            checked: selection.specifiedCharacterKeys.includes(character.characterKey),
            title: character.displayLabel,
            detail: character.hasEmbeddedWorldBook ? '包含角色内嵌世界书' : character.characterKey,
            kind: 'character',
            source: 'specified',
        })).join('')
        : '<p class="blai-deep-clean-empty">没有匹配的角色。</p>'}
                                </div>
                            </div>
                        </details>
                        <button class="blai-deep-clean-quick ${selection.quickSelection === 'all-tavern' ? 'is-active' : ''}" type="button" data-deep-clean-quick="all-tavern"><span>酒馆全部</span><i class="fas fa-arrow-right" aria-hidden="true"></i></button>
                    </div>
                    <button class="blai-deep-clean-clear" type="button" data-deep-clean-quick="">清空最终选择</button>
                </section>
                <section class="blai-deep-clean-section" aria-labelledby="blai-deep-clean-options-title">
                    <h3 id="blai-deep-clean-options-title">运行设置</h3>
                    <p>这些选项只属于当前运行，不会改变全局 Veridis 设置。</p>
                    <div class="blai-deep-clean-options">
                        <label class="blai-deep-clean-option"><span>深度净化预设</span><select class="blai-deep-clean-select" data-deep-clean-option="presetName" aria-label="深度净化预设">${presetNames.map((name) => `<option value="${deepCleanSafeHtml(name)}" ${name === selection.presetName ? 'selected' : ''}>${deepCleanSafeHtml(name)}</option>`).join('')}</select></label>
                        <fieldset class="blai-deep-clean-option">
                            <legend>处理模式</legend>
                            <div class="blai-deep-clean-mode-options" aria-label="深度净化处理模式">
                                <label class="blai-deep-clean-mode-option">
                                    <input type="radio" name="blai-deep-clean-processing-mode" data-deep-clean-option="processingMode" value="program" ${programModeSelected ? 'checked' : ''}>
                                    <span class="blai-deep-clean-mode-copy"><strong>仅程序</strong></span>
                                </label>
                                ${programModeSelected ? `
                                    <div class="blai-deep-clean-program-policy" aria-label="仅程序应用方式">
                                        <label class="blai-deep-clean-mode-option">
                                            <input type="radio" name="blai-deep-clean-program-apply-policy" data-deep-clean-option="programApplyPolicy" value="direct" ${programApplyPolicy === 'direct' ? 'checked' : ''}>
                                            <span class="blai-deep-clean-mode-copy"><strong>直接应用</strong><small>按批处理并直接保存，不进入批改</small></span>
                                        </label>
                                        <label class="blai-deep-clean-mode-option">
                                            <input type="radio" name="blai-deep-clean-program-apply-policy" data-deep-clean-option="programApplyPolicy" value="review" ${programApplyPolicy === 'review' ? 'checked' : ''}>
                                            <span class="blai-deep-clean-mode-copy"><strong>批改后应用</strong><small>每批处理后进入批改，可调整结果</small></span>
                                        </label>
                                    </div>
                                ` : ''}
                                <label class="blai-deep-clean-mode-option">
                                    <input type="radio" name="blai-deep-clean-processing-mode" data-deep-clean-option="processingMode" value="program-ai" ${selection.processingMode === 'program-ai' ? 'checked' : ''}>
                                    <span class="blai-deep-clean-mode-copy"><strong>程序 + AI</strong></span>
                                </label>
                            </div>
                        </fieldset>
                        <fieldset class="blai-deep-clean-option"><legend>消息 AI 范围</legend><div class="blai-deep-clean-option-choices" role="group" aria-label="消息 AI 范围"><button type="button" data-deep-clean-option-choice="messageAiScope" data-deep-clean-option-value="body" aria-pressed="${selection.messageAiScope === 'body'}">仅正文</button><button type="button" data-deep-clean-option-choice="messageAiScope" data-deep-clean-option-value="whole-message" aria-pressed="${selection.messageAiScope === 'whole-message'}">整条消息</button></div></fieldset>
                    </div>
                </section>
                    </div>
                </details>
            </aside>
            <main class="blai-deep-clean-main">
                <header class="blai-deep-clean-resource-header">
                    <div><h3 id="blai-deep-clean-final-title">选择资源</h3><p>共选择 <strong>${totalSelected}</strong> 项</p></div>
                    <div class="blai-deep-clean-resource-tabs" role="tablist" aria-label="资源类型">
                        ${tabs.map(([kind, label, count]) => `<button id="blai-deep-clean-${kind}-tab" type="button" role="tab" data-deep-clean-resource-tab="${kind}" aria-controls="blai-deep-clean-${kind}-panel" aria-selected="${activeTab === kind}">${label}<span>${count}</span></button>`).join('')}
                    </div>
                </header>
                <div class="blai-deep-clean-resource-workspace">
                        ${activeTab === 'character' ? renderDeepCleanResourcePanel({
        kind: 'character',
        title: '角色',
        items: inventory.characters,
        selectionKeys: selection.characterKeys,
        keyName: 'characterKey',
        searchName: 'characters',
        detailFor: (character) => (character.hasEmbeddedWorldBook ? '角色内嵌世界书随角色处理' : character.characterKey),
    }) : ''}
                        ${activeTab === 'chat' ? renderDeepCleanResourcePanel({
        kind: 'chat',
        title: '聊天分支',
        items: inventory.chats,
        selectionKeys: selection.chatKeys,
        keyName: 'key',
        searchName: 'chats',
        detailFor: (chat) => `${characterNames[chat.characterKey] || chat.characterKey} · ${chat.chatId}`,
        hasCurrentSearchSelectionActions: true,
    }) : ''}
                        ${activeTab === 'persona' ? renderDeepCleanResourcePanel({
        kind: 'persona',
        title: 'User 设定',
        items: inventory.personas,
        selectionKeys: selection.personaKeys,
        keyName: 'personaKey',
        searchName: 'personas',
        detailFor: (persona) => persona.personaKey,
        hasCurrentSearchSelectionActions: true,
    }) : ''}
                        ${activeTab === 'world-book' ? renderDeepCleanResourcePanel({
        kind: 'world-book',
        title: '外部世界书',
        items: inventory.worldBooks,
        selectionKeys: selection.worldBookKeys,
        keyName: 'worldBookKey',
        searchName: 'world-books',
        detailFor: (worldBook) => worldBook.worldBookKey,
        hasCurrentSearchSelectionActions: true,
    }) : ''}
                    <p class="blai-deep-clean-shujuku-note">Shujuku 跟随所选聊天分支，不单独建立处理范围或单元格选择；冻结时只读回放 Shujuku V1 / V2 数据并读取有效业务单元格。</p>
                </div>
                <footer class="blai-deep-clean-selection-actions">
                    <button id="blai-deep-clean-close" class="blai-deep-clean-secondary-action" type="button">取消并关闭</button>
                    <button id="blai-deep-clean-scan" class="blai-deep-clean-primary-action" type="button">开始深度净化<i class="fas fa-arrow-right" aria-hidden="true"></i></button>
                </footer>
            </main>
        </div>
    `);
    offerDeepCleanTourFirstUse();
}

