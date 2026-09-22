/**
 * Owns on-demand Difference modal rendering, actions, and existing DOM bindings.
 */
import { extensionName, minTrackedDiffMessages, maxTrackedDiffMessages, normalizeDiffTrackedMessageLimit } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { openSingleRuleModal, openEditModal } from '../rules/view.js';
import {
    cleanseMessageDataAtIndex,
} from '../chat/cleanse.js';
import { refreshMessageDisplay } from '../chat/display.js';
import { markHostChatDirtyFromIndex } from '../integrations/tauriTavern.js';
import { queueIncrementalChatSave } from '../chat/persistence.js';
import { diffRuntimeState, getCurrentDiffIndex, getDiffComparisonForMessage, refreshDiffViewer } from './state.js';
import { injectDiffButtons } from './view.js';
import { escapeHtml, renderDiffDocument } from './compare.js';
import { clearMessageDisplayText, commitCurrentMessageText, getMessageDiffBranchKey, syncCurrentSwipeExtra } from '../chat/messageBranch.js';
import { omitVariableUpdates } from '../text/variableUpdates.js';
import { getMessageDiffMeta, isMessageDiffReverted, setMessageDiffReverted } from './messageMeta.js';
import { findRelatedRulesForDiffChange } from './relatedRules.js';
import { requestManualAiRewriteForMessage } from '../aiRewrite/index.js';

export function recleanseDiffMessageAtIndex(index) {
    const { chat } = getAppContext();
    const msg = Array.isArray(chat) && Number.isInteger(index) && index >= 0 && index < chat.length
        ? chat[index]
        : null;
    if (!isMessageDiffReverted(msg)) return false;

    const sourceMes = typeof msg.mes === 'string' ? msg.mes : '';
    return cleanseMessageDataAtIndex(index, {
        diffSourceMes: sourceMes,
        explicitRecleanse: true,
    });
}

export function bindDiffEvents() {
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const getDiffMessageByIndex = (index) => {
        const { chat } = getAppContext();
        return Array.isArray(chat) && Number.isInteger(index) && index >= 0 && index < chat.length ? chat[index] : null;
    };

    const closeDiffActionsMenu = () => {
        $('#blai-diff-actions-menu').prop('hidden', true);
        $('#blai-diff-menu-toggle').attr('aria-expanded', 'false');
    };

    const openDiffActionsMenu = () => {
        $('#blai-diff-actions-menu').prop('hidden', false);
        $('#blai-diff-menu-toggle').attr('aria-expanded', 'true');
    };

    const syncDiffLimitControlState = () => {
        const currentSettings = extension_settings[extensionName];
        const normalized = normalizeDiffTrackedMessageLimit(currentSettings.diffTrackedMessageLimit);
        currentSettings.diffTrackedMessageLimit = normalized;
        $('#blai-diff-limit-input')
            .attr('min', minTrackedDiffMessages)
            .attr('max', maxTrackedDiffMessages)
            .val(normalized);
        $('#blai-diff-limit-value').text(`${normalized} 条`);
    };

    const applyDiffLimitDraft = () => {
        const currentSettings = extension_settings[extensionName];
        const previous = normalizeDiffTrackedMessageLimit(currentSettings.diffTrackedMessageLimit);
        const next = normalizeDiffTrackedMessageLimit($('#blai-diff-limit-input').val());
        currentSettings.diffTrackedMessageLimit = next;
        syncDiffLimitControlState();
        if (next === previous) return;

        saveSettingsDebounced();
        injectDiffButtons();
        refreshDiffViewer();
    };

    const closeDiffRelatedModal = ({ clearSelection = true } = {}) => {
        $('#blai-diff-related-body').empty();
        $('#blai-diff-related-modal').hide();
        if (clearSelection) $('#blai-diff-modal-content .blai-diff-change-selected').removeClass('blai-diff-change-selected');
    };

    const syncDiffRelatedModeState = () => {
        const enabled = diffRuntimeState.diffRelatedRuleMode === true;
        $('#blai-diff-modal').toggleClass('blai-diff-related-mode', enabled);
        $('#blai-diff-related-mode-icon').attr('class', enabled ? 'fa-solid fa-crosshairs blai-related-active-icon' : 'fa-solid fa-crosshairs');
        $('#blai-diff-related-mode-text').text(enabled ? '相关规则：开启' : '相关规则：关闭');
        $('#blai-diff-related-mode-toggle').attr('title', enabled ? '关闭相关规则模式' : '点击差异文本后推测相关规则');
        if (!enabled) closeDiffRelatedModal();
    };

    const readDiffChangeNumber = (element, name) => {
        const raw = element?.getAttribute?.(`data-blai-${name}`);
        const value = raw === null || raw === undefined ? NaN : Number(raw);
        return Number.isFinite(value) ? value : null;
    };

    const getAdjacentDiffChangeElement = (element, direction) => {
        const node = element?.[direction];
        return node?.nodeType === Node.ELEMENT_NODE
            && node.matches('del.blai-diff-change, ins.blai-diff-change')
            && node.getAttribute('data-blai-diff-section') === element.getAttribute('data-blai-diff-section') ? node : null;
    };

    const getContextWindow = (text = '', start = 0, end = start, radius = 160) => {
        const source = String(text || '');
        const safeStart = Math.max(0, Math.min(source.length, Number(start) || 0));
        const safeEnd = Math.max(safeStart, Math.min(source.length, Number(end) || safeStart));
        return source.slice(Math.max(0, safeStart - radius), Math.min(source.length, safeEnd + radius));
    };

    const buildDiffChangeFromElement = (element) => {
        const index = getCurrentDiffIndex();
        const section = element?.closest('[data-blai-diff-section]')?.getAttribute('data-blai-diff-section');
        const pair = getDiffComparisonForMessage(index, section);
        if (!pair || !element) return null;

        const clickedType = element.getAttribute('data-blai-diff-type') || (element.tagName === 'DEL' ? 'delete' : 'insert');
        const clickedText = String(element.textContent || '');
        const previousChange = getAdjacentDiffChangeElement(element, 'previousSibling');
        const nextChange = getAdjacentDiffChangeElement(element, 'nextSibling');
        const pairedDelete = clickedType === 'delete' ? element : (previousChange?.tagName === 'DEL' ? previousChange : null);
        const pairedInsert = clickedType === 'insert' ? element : (nextChange?.tagName === 'INS' ? nextChange : null);
        const oldStart = readDiffChangeNumber(pairedDelete || element, 'old-start') ?? readDiffChangeNumber(element, 'old-start') ?? 0;
        const oldEnd = readDiffChangeNumber(pairedDelete || element, 'old-end') ?? oldStart;
        const newStart = readDiffChangeNumber(pairedInsert || element, 'new-start') ?? readDiffChangeNumber(element, 'new-start') ?? 0;
        const newEnd = readDiffChangeNumber(pairedInsert || element, 'new-end') ?? newStart;
        const deletedText = pairedDelete ? String(pairedDelete.textContent || '') : (clickedType === 'delete' ? clickedText : '');
        const insertedText = pairedInsert ? String(pairedInsert.textContent || '') : (clickedType === 'insert' ? clickedText : '');

        return {
            clickedType,
            clickedText,
            deletedText,
            insertedText,
            beforeText: deletedText,
            afterText: insertedText,
            oldStart,
            oldEnd,
            newStart,
            newEnd,
            oldSourceText: pair.oldText || '',
            oldContext: getContextWindow(pair.oldText || '', oldStart, oldEnd),
            newContext: getContextWindow(pair.newText || '', newStart, newEnd),
        };
    };

    const summarizeCandidateTargets = (candidate) => {
        const targets = Array.isArray(candidate.targets) ? candidate.targets.filter(Boolean) : [];
        const replacements = Array.isArray(candidate.replacements) ? candidate.replacements.filter(Boolean) : [];
        const targetText = targets.length > 0 ? targets.join(' / ') : '（空查找词）';
        const replacementText = replacements.length > 0 ? replacements.join(' / ') : '删除';
        return `${targetText} -> ${replacementText}`;
    };

    const renderRelatedRulesModal = (change, candidates) => {
        const $modal = $('#blai-diff-related-modal');
        const $body = $('#blai-diff-related-body');
        if (!$modal.length || !$body.length) return;
        const clickedText = change?.clickedText ? escapeHtml(change.clickedText).slice(0, 120) : '（空）';
        if (!Array.isArray(candidates) || candidates.length === 0) {
            $body.html(`
                <div class="blai-diff-related-head">
                    <strong><i class="fa-solid fa-crosshairs"></i> 未找到明显相关规则</strong>
                    <span>点击文本：${clickedText}</span>
                </div>
                <div class="blai-diff-related-note">这是相关规则推测，不保证为实际触发规则。</div>
            `);
            $modal.css('display', 'flex');
            return;
        }

        const items = candidates.map((candidate) => {
            const reasons = Array.isArray(candidate.reasons) && candidate.reasons.length > 0
                ? candidate.reasons.slice(0, 2).join('，')
                : '相关文本命中';
            const remark = candidate.remark ? ` · ${candidate.remark}` : '';
            return `
                <button type="button" class="blai-diff-related-candidate" data-rule-index="${candidate.ruleIndex}" data-subrule-index="${candidate.subRuleIndex}">
                    <span class="blai-diff-related-candidate-main">
                        <span class="blai-tag blai-badge-compact">${escapeHtml(candidate.modeLabel || candidate.mode || '规则')}</span>
                        <strong>${escapeHtml(candidate.groupName || `合集 ${candidate.ruleIndex + 1}`)}</strong>
                    </span>
                    <span class="blai-diff-related-candidate-preview">${escapeHtml(summarizeCandidateTargets(candidate))}</span>
                    <span class="blai-diff-related-candidate-reason">${escapeHtml(`${reasons} · 分数 ${Math.round(candidate.score)}${remark}`)}</span>
                </button>
            `;
        }).join('');

        $body.html(`
            <div class="blai-diff-related-head"><span>点击文本：${clickedText}</span></div>
            <div class="blai-diff-related-note">相关规则推测，不保证为实际触发规则。最多显示 10 条。</div>
            <div class="blai-diff-related-list">${items}</div>
        `);
        $modal.css('display', 'flex');
    };

    const showRelatedRulesForDiffElement = (element) => {
        const change = buildDiffChangeFromElement(element);
        if (!change) return;
        const rules = extension_settings[extensionName]?.rules || [];
        const candidates = findRelatedRulesForDiffChange(change, rules, { maxCount: 10 });
        renderRelatedRulesModal(change, candidates);
    };

    const syncDiffModeToggleState = (mode) => {
        const isFullMode = mode === 'full';
        const nextText = isFullMode ? '切回片段' : '全文模式';
        const nextTitle = isFullMode ? '切回片段模式' : '切换到全文模式';
        $('#blai-diff-mode-text').text(nextText);
        $('#blai-diff-mode-icon').attr('class', isFullMode ? 'fa-solid fa-list-ul' : 'fa-solid fa-file-lines');
        $('#blai-diff-mode-toggle').attr('title', nextTitle).attr('aria-label', nextTitle);
    };

    const syncDiffPositionMenuState = (settings) => {
        const shouldExposeTopButton = settings.diffButtonInExtraMenu === true;
        $('#blai-diff-menu-pos-icon').attr('class', shouldExposeTopButton ? 'fa-solid fa-thumbtack' : 'fa-solid fa-ellipsis');
        $('#blai-diff-menu-pos-text').text(shouldExposeTopButton ? '顶部按钮：外显' : '顶部按钮：收纳');
        $('#blai-diff-menu-pos-toggle').attr('title', shouldExposeTopButton ? '将顶部按钮恢复为外显' : '将顶部按钮收纳进菜单');
    };

    const syncDiffBottomMenuState = (settings) => {
        const isBottomVisible = settings.showBottomDiffButton !== false;
        $('#blai-diff-menu-bottom-icon').attr('class', isBottomVisible ? 'fa-solid fa-eye-slash' : 'fa-solid fa-eye');
        $('#blai-diff-menu-bottom-text').text(isBottomVisible ? '尾部按钮：隐藏' : '尾部按钮：显示');
        $('#blai-diff-menu-bottom-toggle').attr('title', isBottomVisible ? '隐藏消息尾部按钮' : '显示消息尾部按钮');
    };

    const syncDiffPreferenceMenuState = () => {
        const settings = extension_settings[extensionName];
        syncDiffLimitControlState();
        syncDiffRelatedModeState();
        syncDiffPositionMenuState(settings);
        syncDiffBottomMenuState(settings);
    };
    syncDiffLimitControlState();

    const syncDiffRevertToggleState = (msg) => {
        const isReverted = isMessageDiffReverted(msg);
        const meta = getMessageDiffMeta(msg);
        const revertTitle = isReverted ? '重新净化文本' : '撤回净化并保护原文';
        $('#blai-diff-revert-icon').attr('class', isReverted ? 'fas fa-wand-magic-sparkles' : 'fas fa-rotate-left');
        $('#blai-diff-revert-text').text(isReverted ? '重新净化' : '撤回净化');
        $('#blai-diff-revert-toggle').attr('title', revertTitle).prop('disabled', !meta);
        $('#blai-diff-mode-toggle').toggle(!isReverted);
    };

    const syncDiffAiRewriteButtonState = (msg) => {
        const isReverted = isMessageDiffReverted(msg);
        $('#blai-diff-ai-rewrite').attr('title', isReverted ? '请先重新净化文本' : '对当前消息手动执行 AI 改写');
    };

    const refreshMessageAfterRevertToggle = (index, msg) => {
        const { chat } = getAppContext();
        if (!Number.isInteger(index) || index < 0 || !Array.isArray(chat) || !msg) return;
        refreshMessageDisplay(index, { allowReloadFallback: true, emitRenderedEvent: 'auto' });
        injectDiffButtons([index]);
        renderDiffModalContent(index);
        queueIncrementalChatSave();
    };

    const toggleCurrentDiffRevert = () => {
        const index = getCurrentDiffIndex();
        const msg = getDiffMessageByIndex(index);
        if (!Number.isInteger(index) || index < 0 || !msg || typeof msg !== 'object') return;

        if (isMessageDiffReverted(msg)) {
            recleanseDiffMessageAtIndex(index);
        } else {
            const branchKey = getMessageDiffBranchKey(msg);
            const diffMeta = getMessageDiffMeta(msg, branchKey);
            if (!diffMeta) {
                return;
            }
            const commitResult = commitCurrentMessageText(msg, diffMeta.originalMes, branchKey);
            if (!commitResult.ok) {
                return;
            }
            clearMessageDisplayText(msg);
            syncCurrentSwipeExtra(msg);
            setMessageDiffReverted(msg, true, branchKey);
            markHostChatDirtyFromIndex(index);
        }

        closeDiffActionsMenu();
        refreshMessageAfterRevertToggle(index, msg);
    };

    const triggerCurrentDiffAiRewrite = () => {
        const index = getCurrentDiffIndex();
        const msg = getDiffMessageByIndex(index);
        if (!Number.isInteger(index) || index < 0 || !msg || typeof msg !== 'object') {
            return;
        }
        if (isMessageDiffReverted(msg)) {
            return;
        }

        closeDiffActionsMenu();
        requestManualAiRewriteForMessage(index);
    };

    const closeDiffModal = () => {
        closeDiffActionsMenu();
        closeDiffRelatedModal();
        diffRuntimeState.diffRelatedRuleMode = false;
        syncDiffRelatedModeState();
        $('#blai-diff-modal').hide();
        diffRuntimeState.currentMessage = null;
    };

    function renderDiffModalContent(index) {
        const msg = getDiffMessageByIndex(index);
        if (!msg) { closeDiffModal(); return; }
        const meta = getMessageDiffMeta(msg);
        const mode = extension_settings[extensionName].diffViewMode || 'snippet';
        closeDiffRelatedModal();
        syncDiffPreferenceMenuState();
        syncDiffModeToggleState(mode);
        syncDiffRevertToggleState(msg);
        syncDiffAiRewriteButtonState(msg);
        const contentEl = $('#blai-diff-modal-content');
        if (meta?.reverted) {
            const current = msg.mes === meta.originalMes ? '当前显示为原始文本。' : '当前文本与保留原文不同。';
            contentEl.html(`<div class="blai-diff-empty"><i class="fas fa-shield-halved blai-diff-reverted-icon"></i>此消息已撤回并处于免净化保护状态，${current}点击 <i class="fas fa-wand-magic-sparkles blai-diff-inline-icon"></i> 重新净化文本。</div>`);
            return;
        }
        if (!meta) {
            contentEl.html('<div class="blai-diff-empty">当前消息未触发差异。</div>');
            return;
        }
        const pairs = ['ai', 'program', 'manual'].flatMap(section => {
            const pair = getDiffComparisonForMessage(index, section);
            return pair ? [{ ...pair, section }] : [];
        });
        const rendered = renderDiffDocument(meta.originalMes, pairs, mode);
        const notice = omitVariableUpdates(msg.mes) !== omitVariableUpdates(meta.programMes)
            ? '<div class="blai-diff-empty">当前消息与记录的 Veridis 结果不同；下方展示记录的净化阶段。</div>' : '';
        const empty = '<div class="blai-diff-empty">当前消息未触发差异。</div>';
        contentEl.html(notice + (mode === 'full'
            ? `<div class="blai-diff-full-text">${rendered.join('') || empty}</div>`
            : rendered.join('<hr class="blai-diff-divider">') || empty));
    }

    diffRuntimeState.diffModalClose = closeDiffModal;
    diffRuntimeState.diffModalRefresh = (index) => {
        if ($('#blai-diff-modal').is(':visible')) renderDiffModalContent(index);
    };

    $(document).off('click', '.blai-diff-btn').on('click', '.blai-diff-btn', function() {
        const index = Number($(this).attr('data-index'));
        if (!Number.isInteger(index) || index < 0) return;
        const msg = getDiffMessageByIndex(index);
        if (!msg) return;
        diffRuntimeState.currentMessage = msg;
        closeDiffRelatedModal();
        renderDiffModalContent(index);
        closeDiffActionsMenu();
        $('#blai-diff-modal').css('display', 'flex');
    });

    $(document).off('click', '#blai-diff-menu-toggle').on('click', '#blai-diff-menu-toggle', function(e) {
        e.preventDefault();
        e.stopPropagation();
        if ($('#blai-diff-actions-menu').prop('hidden')) openDiffActionsMenu();
        else closeDiffActionsMenu();
    });

    $(document).off('click', '#blai-diff-actions-menu').on('click', '#blai-diff-actions-menu', function(e) {
        e.stopPropagation();
    });

    $(document).off('click.blai-diff-menu').on('click.blai-diff-menu', function(e) {
        if ($(e.target).closest('#blai-diff-menu-toggle, #blai-diff-actions-menu').length === 0) closeDiffActionsMenu();
    });

    $(document).off('click', '#blai-diff-menu-pos-toggle').on('click', '#blai-diff-menu-pos-toggle', function() {
        const settings = extension_settings[extensionName];
        settings.diffButtonInExtraMenu = !settings.diffButtonInExtraMenu;
        saveSettingsDebounced();
        syncDiffPreferenceMenuState();
        closeDiffActionsMenu();
        injectDiffButtons();
    });

    $(document).off('click', '#blai-diff-menu-bottom-toggle').on('click', '#blai-diff-menu-bottom-toggle', function() {
        const settings = extension_settings[extensionName];
        settings.showBottomDiffButton = settings.showBottomDiffButton === false;
        saveSettingsDebounced();
        syncDiffPreferenceMenuState();
        closeDiffActionsMenu();
        injectDiffButtons();
    });

    $(document).off('click', '#blai-diff-mode-toggle').on('click', '#blai-diff-mode-toggle', function() {
        const settings = extension_settings[extensionName];
        settings.diffViewMode = settings.diffViewMode === 'full' ? 'snippet' : 'full';
        saveSettingsDebounced();
        refreshDiffViewer();
    });

    $(document).off('click', '#blai-diff-related-mode-toggle').on('click', '#blai-diff-related-mode-toggle', function(e) {
        e.preventDefault();
        e.stopPropagation();
        diffRuntimeState.diffRelatedRuleMode = diffRuntimeState.diffRelatedRuleMode !== true;
        syncDiffRelatedModeState();
        closeDiffActionsMenu();
    });

    $(document).off('input', '#blai-diff-limit-input').on('input', '#blai-diff-limit-input', function() {
        $('#blai-diff-limit-value').text(`${$(this).val()} 条`);
    });

    $(document).off('change', '#blai-diff-limit-input').on('change', '#blai-diff-limit-input', applyDiffLimitDraft);

    $(document).off('keydown', '#blai-diff-limit-input').on('keydown', '#blai-diff-limit-input', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            applyDiffLimitDraft();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            syncDiffLimitControlState();
        }
    });

    $(document).off('click', '#blai-diff-revert-toggle').on('click', '#blai-diff-revert-toggle', () => toggleCurrentDiffRevert());
    $(document).off('click', '#blai-diff-ai-rewrite').on('click', '#blai-diff-ai-rewrite', () => triggerCurrentDiffAiRewrite());

    $(document).off('click', '#blai-diff-modal-content del.blai-diff-change, #blai-diff-modal-content ins.blai-diff-change').on('click', '#blai-diff-modal-content del.blai-diff-change, #blai-diff-modal-content ins.blai-diff-change', function(e) {
        if (diffRuntimeState.diffRelatedRuleMode !== true) return;
        e.preventDefault();
        e.stopPropagation();
        $('#blai-diff-modal-content .blai-diff-change').removeClass('blai-diff-change-selected');
        $(this).addClass('blai-diff-change-selected');
        showRelatedRulesForDiffElement(this);
    });

    $(document).off('click', '.blai-diff-related-candidate').on('click', '.blai-diff-related-candidate', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const ruleIndex = Number($(this).attr('data-rule-index'));
        const subRuleIndex = Number($(this).attr('data-subrule-index'));
        const rules = extension_settings[extensionName]?.rules || [];
        if (!Number.isInteger(ruleIndex) || ruleIndex < 0 || ruleIndex >= rules.length) return;
        if (!Number.isInteger(subRuleIndex) || subRuleIndex < 0 || subRuleIndex >= (rules[ruleIndex]?.subRules || []).length) return;
        closeDiffRelatedModal();
        openEditModal(ruleIndex, { source: 'search', returnMode: 'related', subRuleIndex });
        openSingleRuleModal(subRuleIndex, { hideEditModal: true });
    });

    $(document).off('click', '#blai-diff-related-close').on('click', '#blai-diff-related-close', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeDiffRelatedModal();
    });
    $(document).off('click', '#blai-diff-related-modal').on('click', '#blai-diff-related-modal', function(e) {
        if (e.target && e.target.id === 'blai-diff-related-modal') closeDiffRelatedModal();
    });

    $(document).off('click', '#blai-diff-modal-close').on('click', '#blai-diff-modal-close', () => closeDiffModal());
    $(document).off('click', '#blai-diff-modal').on('click', '#blai-diff-modal', function(e) { if (e.target && e.target.id === 'blai-diff-modal') closeDiffModal(); });
    
}
