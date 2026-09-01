import { annotateTauriMobileSurfaces, showResponsivePage } from './shell.js';

export const guidedTourStorageKey = 'ultimate_purifier_ai_rewrite_guided_tour_v1';

let activeTour = null;

function tourStorage(storage = globalThis.localStorage) {
    if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function') {
        throw new Error('Veridis Rewrite 导览无法访问本地存储。');
    }
    return storage;
}

export function getGuidedTourState(storage = globalThis.localStorage) {
    const value = tourStorage(storage).getItem(guidedTourStorageKey);
    if (value === null) return { mainSeen: false, deepCleanSeen: false };
    let parsed;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new Error('Veridis Rewrite 导览本地状态格式无效。');
    }
    const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).sort() : [];
    if (keys.join(',') !== 'deepCleanSeen,mainSeen' || typeof parsed.mainSeen !== 'boolean' || typeof parsed.deepCleanSeen !== 'boolean') {
        throw new Error('Veridis Rewrite 导览本地状态结构无效。');
    }
    return { mainSeen: parsed.mainSeen, deepCleanSeen: parsed.deepCleanSeen };
}

export function markGuidedTourSeen(kind, storage = globalThis.localStorage) {
    const state = getGuidedTourState(storage);
    if (kind === 'main') state.mainSeen = true;
    else if (kind === 'deep-clean') state.deepCleanSeen = true;
    else throw new TypeError(`Unknown Veridis Rewrite guided tour: ${kind}`);
    tourStorage(storage).setItem(guidedTourStorageKey, JSON.stringify(state));
    return state;
}

function currentMainPage() {
    return document.querySelector('#blai-purifier-popup .page-panel.active')?.getAttribute('data-page') || 'overview';
}

function isPhone() {
    return window.matchMedia?.('(max-width: 600px)').matches === true;
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function activeNavigationTarget() {
    return isPhone()
        ? document.querySelector('#blai-purifier-popup .bottom-nav')
        : document.querySelector('#blai-purifier-popup .rail');
}

function toolsPageTourTarget() {
    return isPhone()
        ? document.querySelector('#blai-purifier-popup .bottom-nav [data-page-target="tools"]')
        : document.querySelector('#blai-purifier-popup .rail [data-page-target="tools"]');
}

function aiAdvancedGenerationTourTarget() {
    return isPhone()
        ? document.querySelector('#blai-ai-generation-open')
        : document.querySelector('#blai-ai-generation-section');
}

function currentRulesetTourTarget() {
    return document.querySelector('#blai-preset-select')?.closest('.blai-home-dataset-row');
}

function ruleToolsTourTarget() {
    return document.querySelector('#blai-open-new-rule-btn')?.closest('.blai-home-toolbar');
}

function deepCleanLaunchTourTarget() {
    return document.querySelector('#blai-deep-clean-btn')?.closest('.blai-clean-danger-content');
}

function deepCleanQuickSelectionTourTarget() {
    return document.querySelector('#blai-deep-clean-quick-title')?.closest('.blai-deep-clean-section');
}

function deepCleanFinalSelectionTourTarget() {
    return document.querySelector('#blai-deep-clean-final-title')?.closest('.blai-deep-clean-main');
}

function deepCleanPresetTourTarget() {
    return document.querySelector('[data-deep-clean-option="presetName"]')?.closest('.blai-deep-clean-option');
}

function deepCleanOptionsTourTarget() {
    return document.querySelector('#blai-deep-clean-options-title')?.closest('.blai-deep-clean-section');
}

function createThemedTourLayer() {
    const theme = document.getElementById('blai-purifier-popup')?.getAttribute('data-theme');
    if (!['auto', 'light', 'dark'].includes(theme)) {
        throw new Error('Veridis Rewrite 主界面未提供有效主题，无法创建导览图层。');
    }
    const layer = document.createElement('div');
    layer.id = 'blai-tour-layer';
    layer.className = 'blai-tour-layer blai-modal-shell blai-is-open';
    layer.setAttribute('data-theme', theme);
    document.body.append(layer);
    annotateTauriMobileSurfaces();
    return layer;
}

function tourError(operation, error) {
    closeGuidedTour({ restore: false });
    let layer;
    try {
        layer = createThemedTourLayer();
    } catch (themeError) {
        throw new Error(`${operation}，且无法显示错误信息：${themeError.message}`);
    }
    layer.innerHTML = `<section class="blai-tour-card blai-modal-card blai-tour-centered" role="alertdialog" aria-modal="true" aria-labelledby="blai-tour-error-title"><p class="blai-tour-kicker">导览无法继续</p><h2 id="blai-tour-error-title">${escapeHtml(operation)}</h2><p>${escapeHtml(error instanceof Error ? error.message : error)}</p><div class="blai-tour-actions"><button type="button" data-tour-action="close-error">关闭</button></div></section>`;
    annotateTauriMobileSurfaces();
    layer.querySelector('button')?.focus();
    layer.addEventListener('click', (event) => {
        if (event.target.closest('[data-tour-action="close-error"]')) layer.remove();
    });
}

function requiredTarget(step) {
    if (step.previewTarget) return document.querySelector(step.previewTarget);
    const target = typeof step.target === 'function' ? step.target() : document.querySelector(step.target);
    if (!target) throw new Error(`无法定位「${step.title}」所需的界面目标。`);
    return target;
}

const mainSteps = [
    { title: 'Veridis Rewrite 的四个区域', badge: '基础', body: '首页用于管理规则集和规则；AI 页面配置模型改写；净化页面包含标签作用范围和深度净化；工具页面包含按需使用的附加功能。', target: activeNavigationTarget },
    { page: 'overview', title: '当前规则集', badge: '基础', body: '这里显示当前查看和使用的净化规则集。\n\n规则集中的规则可以在下方添加、编辑、启用或停用。', target: currentRulesetTourTarget },
    { page: 'overview', title: '导入预设', badge: '基础', body: '可直接导入 AI 改写预设。预设可在帖子内下载，下载后在这里导入即可。', target: '[data-blai-click-proxy="#blai-preset-import"]' },
    { page: 'overview', title: '编辑规则', badge: '基础', body: '「添加」用于建立新的规则组，现有规则显示在下方。\n\n顶部保存按钮保存当前规则集；搜索、批量编辑和反序排序用于规则管理。', target: ruleToolsTourTarget },
    { page: 'ai', title: 'AI 改写', badge: '按需', body: 'AI 页面包含 API、API Key、模型和「启用改写」设置。\n\n启用 AI 改写的规则会使用这里配置的连接和模型。', target: '#blai-ai-connection-title' },
    { page: 'ai', title: '其他生成参数', badge: '高级', body: '这里包含 Top P、Top K、Max Tokens、惩罚参数、重试、超时、单次条目和 Context 等生成与请求参数。\n\n它们分别控制采样范围、输出长度、请求行为和单次处理规模。', target: aiAdvancedGenerationTourTarget },
    { page: 'clean', title: '标签作用范围', badge: '可选', body: '这个设置用于限制 XML 标签内容的净化范围。\n\n「保护特定标签」会排除启用标签中的内容；「净化特定标签」只处理启用标签中的内容。\n\n在「保护特定标签」模式下，如果没有启用任何标签，不会额外限制净化范围，普通内容会照常净化。', target: '#blai-clean-scope-title' },
    { page: 'clean', title: '深度净化', badge: '高级', body: '深度净化批量处理已有的角色、聊天分支、User 设定、世界书和相关数据。\n\n第一次打开深度净化时会显示独立导览。', target: deepCleanLaunchTourTarget },
    { page: 'tools', title: '工具页', badge: '高级 / 按需', body: '这里包含预设绑定解析、反馈与诊断、输入框 AI 改写快捷键、净化结果楼层数、Shujuku 数据库自动净化和简繁转换 (OpenCC) 等附加功能。', target: toolsPageTourTarget },
    { page: 'tools', title: '净化结果楼层数', badge: '按需', body: '这里设置可以查看多少个最近楼层的插件净化结果。\n\n例如设置为 5 条时，Veridis Rewrite 会保留最近 5 个可追踪楼层的净化结果供查看和审查。\n\n这个设置只控制净化结果的保留 / 查看范围，不会改变净化规则本身。', target: 'label[for="blai-diff-limit-input"]' },
    { page: 'tools', title: '反馈与诊断', badge: '排查问题 / 提交反馈', body: '排查 AI 改写问题时，可在「AI 上下文」查看本次实际发送给 AI 的内容和返回结果；这些内容只在本地显示。\n\n提交匿名反馈前会先展示完整 JSON 预览，只有你选择的诊断附件会随反馈发送。', target: '.blai-tools-feedback-section' },
    { title: 'Veridis Rewrite 界面导览完成', body: '首页用于管理规则集和规则；\nAI 页面配置 AI 改写；\n净化页面包含标签作用范围和深度净化；\n工具页面包含附加设置、净化结果、反馈与诊断以及第三方集成。', centered: true, finish: '完成导览' },
];

const deepCleanSteps = [
    { title: '深度净化的两种处理路径', body: '深度净化可以只运行程序规则，也可以在程序处理后继续执行 AI 改写和人工审查。', centered: true, extra: '<div class="blai-tour-paths"><div><strong>程序处理</strong><span>基础净化预设 → 仅程序 → 直接应用 → 扫描确认 → 处理并保存</span><small>执行确定性的程序规则，例如格式整理、标签处理和固定替换。扫描确认后，处理结果会按批直接写入对应资源。</small></div><div><strong>程序 + AI</strong><span>创作类预设 → 程序 + AI → 扫描 → 处理 → 审查 → 选择 / 手工修改 → 正式应用</span><small>程序处理后继续进行 AI 改写，并进入审查界面。审查中可以选择不同结果或直接修改最终文本。</small></div></div>' },
    { title: '快速选择处理对象', body: '当前聊天、当前角色、指定角色和酒馆全部只是帮你快速建立处理范围。\n\n选择后，相关的角色、聊天分支、User 设定和世界书会反映到右侧资源列表。\n\n快速选择不是最终处理范围。', target: deepCleanQuickSelectionTourTarget },
    { title: '右侧才是最终处理范围', body: '右侧资源列表中的最终勾选才是深度净化真正会处理的内容。\n\n快速选择之后，你仍然可以手动增加或取消角色、聊天分支、User 设定和世界书。\n\n开始扫描时会冻结这里的最终选择。', target: deepCleanFinalSelectionTourTarget },
    { title: '深度净化预设', body: '帖子内已提供「专供无AI无人工批改的深度清理使用」预设。\n\n这个预设对应「仅程序 + 直接应用」流程，内容以确定性的程序净化规则为主。\n\n导入该预设后，可以在这里从已有深度净化预设中选择它。\n\nVeridis Rewrite 不会根据预设名称自动判断用途，当前使用的预设由这里的选择决定。', target: deepCleanPresetTourTarget },
    { title: '处理模式与应用方式', body: '「仅程序」只执行程序规则。\n\n在仅程序模式下：\n\n「直接应用」会在扫描确认后处理并按批保存结果；\n\n「批改后应用」会先生成审查结果，再由审查界面确认最终内容。\n\n「程序 + AI」会在程序处理后继续执行 AI 改写，并进入审查流程。\n\n「消息 AI 范围」只影响 AI 对聊天消息读取和处理的范围。', target: deepCleanOptionsTourTarget },
    { title: '扫描', body: '点击「开始深度净化」后，Veridis Rewrite 会冻结当前资源选择并扫描受影响内容。\n\n扫描阶段不会写入角色、聊天、User 设定、世界书或 Shujuku。\n\n扫描结果会显示命中数量和受影响范围。\n\n「仅程序 + 直接应用」在扫描结果确认后进入处理，并从处理阶段开始按批保存。\n\n需要审查的模式会在处理后进入审查界面。', target: '#blai-deep-clean-scan' },
    { title: '审查界面', body: '需要审查的处理模式会进入这个界面。\n\n「Review」在完整正文上下文中显示差异。原文和净化后片段可以切换选择；当前采用的片段以及未变化正文都可以直接编辑。\n\n「原版 / 净化后 / 最终」分别显示冻结原文、初始处理结果和当前最终全文。\n\n「上一个 / 下一个」切换当前批中的内容项，旁边显示下一批处理状态。\n\n「正式应用本批修改」将当前批的最终结果写回对应资源。', preview: 'review', centered: true, finish: '完成深度净化导览' },
];

function previewHtml(kind) {
    if (kind !== 'review') return '';
    return `<div class="blai-tour-preview blai-tour-review-preview"><p class="blai-tour-preview-label">教学示例 · 不会读取或修改你的内容</p><div class="blai-tour-review-surface"><div class="blai-tour-review-main"><section class="blai-tour-review-area"><header class="blai-tour-review-head"><div><p>当前审核</p><strong>教学内容项 · 角色卡</strong></div><nav class="blai-tour-review-tabs" aria-label="教学示例审核视图"><span class="is-active">Review</span><span>原版</span><span>净化后</span><span>最终</span></nav></header><div class="blai-tour-review-document">她看向门口<del class="is-old">，停顿了一下</del><ins class="is-new">，随后移开视线</ins>。</div></section><aside class="blai-tour-review-lookahead"><strong>下一批</strong><span>正在准备……</span></aside></div><nav class="blai-tour-review-navigation"><span>上一个</span><strong>当前项 3 / 18</strong><span>下一个</span></nav><footer class="blai-tour-review-apply"><span>当前批 · <strong>18 个内容项</strong></span><b>正式应用本批修改</b></footer></div></div>`;
}

function cardHtml(step, index, total) {
    const description = step.body.split('\n').map((line) => line ? `<p>${escapeHtml(line)}</p>` : '').join('');
    return `<section class="blai-tour-card blai-modal-card ${step.centered || step.preview ? 'blai-tour-centered' : ''}" role="dialog" aria-modal="true" aria-labelledby="blai-tour-title"><div class="blai-tour-card-head"><span>步骤 ${index + 1} / ${total}</span>${step.badge ? `<b>${escapeHtml(step.badge)}</b>` : ''}</div><h2 id="blai-tour-title">${escapeHtml(step.title)}</h2><div class="blai-tour-copy">${description}</div>${step.extra || ''}${step.preview ? previewHtml(step.preview) : ''}<div class="blai-tour-actions"><button type="button" data-tour-action="previous" ${index === 0 ? 'disabled' : ''}>上一步</button>${step.finish ? `<button type="button" class="blai-tour-primary" data-tour-action="finish">${escapeHtml(step.finish)}</button>` : `<button type="button" class="blai-tour-primary" data-tour-action="next">下一步</button>`}<button type="button" data-tour-action="skip" aria-label="跳过并关闭导览">跳过</button></div></section>`;
}

function welcomeHtml(kind) {
    const deepClean = kind === 'deep-clean';
    return `<section class="blai-tour-card blai-modal-card blai-tour-centered" role="dialog" aria-modal="true" aria-labelledby="blai-tour-welcome-title"><p class="blai-tour-kicker">${deepClean ? '深度净化导览' : 'Veridis Rewrite 导览'}</p><h2 id="blai-tour-welcome-title">第一次使用 ${deepClean ? '深度净化' : 'Veridis Rewrite'}？</h2><div class="blai-tour-copy"><p>${deepClean ? '深度净化用于批量处理已有内容，包含程序处理、AI 改写和人工审查等处理路径。' : '导览说明 Veridis Rewrite 的主要界面区域与相关设置。'}</p>${deepClean ? '<p>导览覆盖扫描和审查界面，不会运行深度净化或修改内容。</p>' : ''}</div><div class="blai-tour-actions"><button type="button" class="blai-tour-primary" data-tour-action="start">开始导览</button><button type="button" data-tour-action="direct">直接使用</button></div></section>`;
}

function removeLayer() {
    document.getElementById('blai-tour-layer')?.remove();
}

function restoreTourPresentation(tour) {
    if (tour.kind === 'main' && tour.manual && tour.previousPage) showResponsivePage(tour.previousPage);
    if (tour.kind === 'deep-clean' && tour.controlsWasOpen !== undefined) {
        const controls = document.getElementById('blai-deep-clean-controls');
        if (controls) controls.open = tour.controlsWasOpen;
    }
}

export function closeGuidedTour({ restore = true } = {}) {
    const tour = activeTour;
    activeTour = null;
    window.removeEventListener('resize', onTourResize);
    document.removeEventListener('keydown', onTourKeydown, true);
    removeLayer();
    if (!tour) return;
    if (restore) restoreTourPresentation(tour);
    if (tour.launcher?.isConnected) tour.launcher.focus();
}

function onTourResize() {
    try {
        positionActiveTour();
    } catch (error) {
        tourError(`${activeTour?.kind === 'deep-clean' ? '深度净化' : 'Veridis Rewrite'} 导览无法继续`, error);
    }
}

function activeMainTourTarget(step) {
    const target = requiredTarget(step);
    if (activeTour?.kind !== 'main' || !step.page) return target;
    const activePage = document.querySelector('#blai-purifier-popup .page-panel.active');
    const persistentSurface = target.closest('#blai-purifier-popup .bottom-nav, #blai-purifier-popup .blai-global-header, #blai-purifier-popup .rail');
    if (target.closest('#blai-purifier-popup .page-panel') !== activePage && !persistentSurface) {
        throw new Error(`「${step.title}」未定位到当前页面中的目标。`);
    }
    return target;
}

function phoneTourScrollOwner(target) {
    if (activeTour?.kind === 'main') {
        const activePage = document.querySelector('#blai-purifier-popup .page-panel.active');
        return target.closest('#blai-purifier-popup .page-panel') === activePage ? activePage : null;
    }
    if (activeTour?.kind === 'deep-clean') {
        return target.closest('#blai-deep-clean-workspace .blai-deep-clean-side');
    }
    return null;
}

function scrollPhoneTourTargetIntoView(target, card) {
    const scrollOwner = phoneTourScrollOwner(target);
    if (!scrollOwner) return;
    const targetRect = target.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const ownerRect = scrollOwner.getBoundingClientRect();
    const padding = 12;
    let visibleTop = ownerRect.top + padding;
    let visibleBottom = Math.min(ownerRect.bottom - padding, cardRect.top - padding);
    if (visibleBottom <= visibleTop) {
        visibleTop = Math.max(ownerRect.top + padding, cardRect.bottom + padding);
        visibleBottom = ownerRect.bottom - padding;
    }
    if (visibleBottom <= visibleTop) return;
    const visibleHeight = visibleBottom - visibleTop;
    const delta = targetRect.height > visibleHeight
        ? (targetRect.bottom <= visibleTop || targetRect.top >= visibleBottom
            ? targetRect.top - visibleTop
            : 0)
        : (targetRect.top < visibleTop
            ? targetRect.top - visibleTop
            : (targetRect.bottom > visibleBottom ? targetRect.bottom - visibleBottom : 0));
    if (delta) scrollOwner.scrollTop += delta;
}

function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
}

function popoverCandidate(side, exclusion, popover, viewport, margin) {
    const horizontal = side === 'right' || side === 'left';
    const primarySpace = side === 'bottom'
        ? viewport.height - margin - exclusion.bottom
        : side === 'top'
            ? exclusion.top - margin
            : side === 'right'
                ? viewport.width - margin - exclusion.right
                : exclusion.left - margin;
    const crossSpace = horizontal ? viewport.height - margin * 2 : viewport.width - margin * 2;
    const primarySize = horizontal ? popover.width : popover.height;
    const crossSize = horizontal ? popover.height : popover.width;
    const left = horizontal
        ? (side === 'right' ? exclusion.right : exclusion.left - popover.width)
        : clamp(exclusion.left + (exclusion.width - popover.width) / 2, margin, viewport.width - margin - popover.width);
    const top = horizontal
        ? clamp(exclusion.top + (exclusion.height - popover.height) / 2, margin, viewport.height - margin - popover.height)
        : (side === 'bottom' ? exclusion.bottom : exclusion.top - popover.height);
    return {
        side,
        left,
        top,
        primarySpace,
        fits: primarySpace >= primarySize && crossSpace >= crossSize,
    };
}

export function calculateTourPopoverPlacement(targetRect, popoverRect, viewport, { targetGap = 12, viewportMargin = 12 } = {}) {
    const exclusion = {
        left: targetRect.left - targetGap,
        top: targetRect.top - targetGap,
        right: targetRect.right + targetGap,
        bottom: targetRect.bottom + targetGap,
        width: targetRect.width + targetGap * 2,
        height: targetRect.height + targetGap * 2,
    };
    const popover = { width: popoverRect.width, height: popoverRect.height };
    const candidates = ['bottom', 'top', 'right', 'left']
        .map((side) => popoverCandidate(side, exclusion, popover, viewport, viewportMargin));
    const placement = candidates.find((candidate) => candidate.fits);
    if (placement) return { ...placement, constrained: false };
    const fallback = candidates.reduce((best, candidate) => candidate.primarySpace > best.primarySpace ? candidate : best);
    return {
        ...fallback,
        constrained: true,
        maxWidth: Math.max(0, (fallback.side === 'right' || fallback.side === 'left') ? fallback.primarySpace : viewport.width - viewportMargin * 2),
        maxHeight: Math.max(0, (fallback.side === 'bottom' || fallback.side === 'top') ? fallback.primarySpace : viewport.height - viewportMargin * 2),
    };
}

function positionTourPopover(card, targetRect) {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    card.style.setProperty('--blai-tour-popover-max-width', `${Math.max(0, viewport.width - 24)}px`);
    card.style.setProperty('--blai-tour-popover-max-height', `${Math.max(0, viewport.height - 24)}px`);
    let placement = calculateTourPopoverPlacement(targetRect, card.getBoundingClientRect(), viewport);
    if (placement.constrained) {
        card.style.setProperty('--blai-tour-popover-max-width', `${placement.maxWidth}px`);
        card.style.setProperty('--blai-tour-popover-max-height', `${placement.maxHeight}px`);
        placement = popoverCandidate(
            placement.side,
            {
                left: targetRect.left - 12,
                top: targetRect.top - 12,
                right: targetRect.right + 12,
                bottom: targetRect.bottom + 12,
                width: targetRect.width + 24,
                height: targetRect.height + 24,
            },
            card.getBoundingClientRect(),
            viewport,
            12,
        );
    }
    card.style.left = `${placement.left}px`;
    card.style.top = `${placement.top}px`;
}

function positionActiveTour() {
    if (!activeTour || activeTour.phase !== 'tour') return;
    const layer = document.getElementById('blai-tour-layer');
    const card = layer?.querySelector('.blai-tour-card');
    const step = activeTour.steps[activeTour.index];
    if (!layer || !card) return;
    const target = step.previewTarget ? requiredTarget(step) : (!step.centered && !step.preview ? activeMainTourTarget(step) : null);
    if (!target) return;
    if (isPhone()) scrollPhoneTourTargetIntoView(target, card);
    const rect = target.getBoundingClientRect();
    const pad = 8;
    const spotlight = layer.querySelector('.blai-tour-spotlight');
    spotlight.style.left = `${Math.max(0, rect.left - pad)}px`;
    spotlight.style.top = `${Math.max(0, rect.top - pad)}px`;
    spotlight.style.width = `${Math.min(window.innerWidth, rect.width + pad * 2)}px`;
    spotlight.style.height = `${Math.min(window.innerHeight, rect.height + pad * 2)}px`;
    positionTourPopover(card, rect);
}

function renderActiveTourStep() {
    const { steps, index } = activeTour;
    const step = steps[index];
    if (step.page) showResponsivePage(step.page);
    if (activeTour.kind === 'deep-clean' && !step.preview) {
        const controls = document.getElementById('blai-deep-clean-controls');
        if (controls && !controls.open) controls.open = true;
    }
    const layer = document.getElementById('blai-tour-layer');
    layer.innerHTML = '<div class="blai-tour-spotlight" aria-hidden="true"></div>' + cardHtml(step, index, steps.length);
    annotateTauriMobileSurfaces();
    const target = step.previewTarget ? requiredTarget(step) : (!step.centered && !step.preview ? activeMainTourTarget(step) : null);
    layer.classList.toggle('blai-tour-has-spotlight', Boolean(target));
    if (target && !isPhone()) target.scrollIntoView({ block: 'center', inline: 'nearest' });
    positionActiveTour();
    layer.querySelector('[data-tour-action="next"], [data-tour-action="finish"], [data-tour-action="previous"]:not(:disabled)')?.focus();
    return target;
}

function startTour(kind, launcher, firstUse) {
    removeLayer();
    const steps = kind === 'main' ? mainSteps : deepCleanSteps;
    activeTour = {
        kind,
        steps,
        index: 0,
        phase: 'tour',
        launcher,
        firstUse,
        manual: !firstUse,
        previousPage: kind === 'main' ? currentMainPage() : '',
        controlsWasOpen: kind === 'deep-clean' ? document.getElementById('blai-deep-clean-controls')?.open : undefined,
    };
    const layer = createThemedTourLayer();
    layer.addEventListener('click', onTourClick);
    window.addEventListener('resize', onTourResize);
    document.addEventListener('keydown', onTourKeydown, true);
    renderActiveTourStep();
}

function finishOrSkip() {
    if (activeTour?.firstUse) markGuidedTourSeen(activeTour.kind);
    closeGuidedTour();
}

function onTourKeydown(event) {
    if (event.key === 'Escape') {
        event.preventDefault();
        finishOrSkip();
        return;
    }
    if (event.key !== 'Tab') return;
    const layer = document.getElementById('blai-tour-layer');
    const focusable = Array.from(layer?.querySelectorAll('button:not(:disabled), [contenteditable="true"]') || []);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !layer.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
    }
}

function onTourClick(event) {
    const action = event.target.closest('[data-tour-action]')?.getAttribute('data-tour-action');
    try {
        if (action === 'previous' && activeTour.index > 0) { activeTour.index -= 1; renderActiveTourStep(); return; }
        if (action === 'next') { activeTour.index += 1; renderActiveTourStep(); return; }
        if (action === 'start') { startTour(activeTour.kind, activeTour.launcher, true); return; }
    } catch (error) {
        tourError(`${activeTour?.kind === 'deep-clean' ? '深度净化' : 'Veridis Rewrite'} 导览无法继续`, error);
        return;
    }
    if (action === 'finish' || action === 'skip') { finishOrSkip(); return; }
    if (action === 'direct') { markGuidedTourSeen(activeTour.kind); closeGuidedTour(); return; }
}

function showWelcome(kind, launcher) {
    closeGuidedTour({ restore: false });
    activeTour = { kind, phase: 'welcome', launcher, firstUse: true };
    const layer = createThemedTourLayer();
    layer.innerHTML = welcomeHtml(kind);
    annotateTauriMobileSurfaces();
    layer.addEventListener('click', onTourClick);
    document.addEventListener('keydown', onTourKeydown, true);
    layer.querySelector('[data-tour-action="start"]')?.focus();
}

function offerFirstUse(kind) {
    try {
        const state = getGuidedTourState();
        if ((kind === 'main' ? state.mainSeen : state.deepCleanSeen) === true || activeTour) return;
        showWelcome(kind, kind === 'main' ? document.getElementById('blai-tour-help') : document.getElementById('blai-deep-clean-tour-help'));
    } catch (error) {
        tourError(`${kind === 'main' ? 'Veridis Rewrite' : '深度净化'} 首次导览无法显示`, error);
    }
}

export function offerMainTourFirstUse() {
    offerFirstUse('main');
}

export function offerDeepCleanTourFirstUse() {
    offerFirstUse('deep-clean');
}

export function bindTourEvents() {
    $(document).off('click', '#blai-tour-help').on('click', '#blai-tour-help', function() {
        try { startTour('main', this, false); } catch (error) { tourError('Veridis Rewrite 界面导览无法开始', error); }
    });
    $(document).off('click', '#blai-deep-clean-tour-help').on('click', '#blai-deep-clean-tour-help', function() {
        try { startTour('deep-clean', this, false); } catch (error) { tourError('深度净化导览无法开始', error); }
    });
}
