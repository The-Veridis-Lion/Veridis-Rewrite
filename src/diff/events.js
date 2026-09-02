/**
 * Owns diff viewer controls and diff-specific DOM bindings.
 */
import { extensionName, minTrackedDiffMessages, maxTrackedDiffMessages, normalizeDiffTrackedMessageLimit } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { openSingleRuleModal, openEditModal } from '../rules/view.js';
import { showToast } from '../ui/notifications.js';
import {
    cleanseMessageDataAtIndex,
} from '../chat/cleanse.js';
import { refreshMessageDisplay } from '../chat/display.js';
import { queueIncrementalChatSave } from '../chat/persistence.js';
import { clearTrackedDiffEntry, diffRuntimeState, getDiffComparisonForMessage, getDiffSnippetsForMessage, getDiffStateForMessage, refreshDiffCacheIfStale, syncTrackedIndicesToLatestAssistantMessages } from './state.js';
import { injectDiffButtons } from './view.js';
import { escapeHtml } from './compare.js';
import { setCurrentSwipeText } from '../chat/messageBranch.js';
import { getCurrentMessageOriginalMes } from './messageMeta.js';
import { findRelatedRulesForDiffChange } from './relatedRules.js';
import { requestManualAiRewriteForMessage } from '../aiRewrite/index.js';

export function recleanseDiffMessageAtIndex(index) {
    const { chat } = getAppContext();
    const msg = Array.isArray(chat) && Number.isInteger(index) && index >= 0 && index < chat.length
        ? chat[index]
        : null;
    if (!msg || typeof msg !== 'object' || msg.__blai_is_reverted !== true) return false;

    const sourceMes = typeof msg.mes === 'string' ? msg.mes : '';
    delete msg.__blai_is_reverted;
    return cleanseMessageDataAtIndex(index, {
        diffSourceMes: sourceMes,
        allowManualFinal: true,
        explicitRecleanse: true,
    });
}

export function bindDiffEvents() {
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const settings = extension_settings[extensionName];
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
        syncTrackedIndicesToLatestAssistantMessages({ cleanupHistoricalResidue: true });
        injectDiffButtons();
        if (diffRuntimeState.currentDiffIndex !== undefined) renderDiffModalContent(diffRuntimeState.currentDiffIndex);
        showToast(`透视楼层已设为最近 ${next} 层`);
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
        const value = Number(element?.getAttribute?.(`data-blai-${name}`));
        return Number.isFinite(value) ? value : null;
    };

    const getAdjacentDiffChangeElement = (element, direction) => {
        let node = element?.[direction] || null;
        while (node) {
            if (node.nodeType === Node.TEXT_NODE && String(node.textContent || '').trim() === '') {
                node = node[direction];
                continue;
            }
            if (node.nodeType === Node.ELEMENT_NODE && node.matches?.('del.blai-diff-change, ins.blai-diff-change')) return node;
            return null;
        }
        return null;
    };

    const getContextWindow = (text = '', start = 0, end = start, radius = 160) => {
        const source = String(text || '');
        const safeStart = Math.max(0, Math.min(source.length, Number(start) || 0));
        const safeEnd = Math.max(safeStart, Math.min(source.length, Number(end) || safeStart));
        return source.slice(Math.max(0, safeStart - radius), Math.min(source.length, safeEnd + radius));
    };

    const buildDiffChangeFromElement = (element) => {
        const index = diffRuntimeState.currentDiffIndex;
        const pair = getDiffComparisonForMessage(index);
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
            oldSourceText: pair.sourceDisplayText || '',
            oldContext: getContextWindow(pair.sourceDisplayText || '', oldStart, oldEnd),
            newContext: getContextWindow(pair.cleanedDisplayText || '', newStart, newEnd),
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
        const isReverted = msg?.__blai_is_reverted === true;
        const revertTitle = isReverted ? '重新净化文本' : '撤回净化并保护原文';
        $('#blai-diff-revert-icon').attr('class', isReverted ? 'fas fa-wand-magic-sparkles' : 'fas fa-rotate-left');
        $('#blai-diff-revert-text').text(isReverted ? '重新净化' : '撤回净化');
        $('#blai-diff-revert-toggle').attr('title', revertTitle);
        $('#blai-diff-mode-toggle').toggle(!isReverted);
    };

    const syncDiffAiRewriteButtonState = (msg) => {
        const isReverted = msg?.__blai_is_reverted === true;
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
        const index = diffRuntimeState.currentDiffIndex;
        const msg = getDiffMessageByIndex(index);
        if (!Number.isInteger(index) || index < 0 || !msg || typeof msg !== 'object') return;

        if (msg.__blai_is_reverted === true) {
            recleanseDiffMessageAtIndex(index);
        } else {
            const originalMes = getCurrentMessageOriginalMes(msg);
            if (originalMes) {
                msg.mes = originalMes;
                setCurrentSwipeText(msg, originalMes);
            }
            msg.__blai_is_reverted = true;
            clearTrackedDiffEntry(index);
        }

        closeDiffActionsMenu();
        refreshMessageAfterRevertToggle(index, msg);
    };

    const triggerCurrentDiffAiRewrite = () => {
        const index = diffRuntimeState.currentDiffIndex;
        const msg = getDiffMessageByIndex(index);
        if (!Number.isInteger(index) || index < 0 || !msg || typeof msg !== 'object') {
            showToast('未找到可改写的助手消息');
            return;
        }
        if (msg.__blai_is_reverted === true) {
            showToast('请先重新净化文本，再执行 AI 改写');
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
    };

    function renderDiffModalContent(index) {
        const settings = extension_settings[extensionName];
        const mode = settings.diffViewMode || 'snippet';
        const msg = getDiffMessageByIndex(index);
        const contentEl = $('#blai-diff-modal-content');
        closeDiffRelatedModal();
        syncDiffPreferenceMenuState();
        syncDiffModeToggleState(mode);
        syncDiffRevertToggleState(msg);
        syncDiffAiRewriteButtonState(msg);

        if (msg?.__blai_is_reverted) {
            contentEl.html('<div class="blai-diff-empty"><i class="fas fa-shield-halved" style="margin-right:6px;"></i>此消息已撤回并处于免净化保护状态，当前显示为原始文本。点击 <i class="fas fa-wand-magic-sparkles blai-diff-inline-icon"></i> 重新净化文本。</div>');
            return;
        }

        refreshDiffCacheIfStale(index);
        const state = getDiffStateForMessage(index);
        const cached = getDiffSnippetsForMessage(index);

        if (state.status !== 'ready') {
            contentEl.html('<div class="blai-diff-loading"><i class="fas fa-spinner fa-spin"></i><span>Loading...</span></div>');
            return;
        }
        if (mode === 'full') {
            contentEl.html(`<div class="blai-diff-full-text">${cached.fullDiff || '<div class="blai-diff-empty">当前消息未触发差异。</div>'}</div>`);
        } else {
            contentEl.html(cached.snippets.length > 0 ? cached.snippets.join('<hr class="blai-diff-divider">') : '<div class="blai-diff-empty">当前消息未触发差异。</div>');
        }
    }

    diffRuntimeState.diffModalRefresh = (index) => {
        if (diffRuntimeState.currentDiffIndex === undefined) return;
        if (index !== undefined && index !== diffRuntimeState.currentDiffIndex) return;
        if ($('#blai-diff-modal').is(':visible')) renderDiffModalContent(diffRuntimeState.currentDiffIndex);
    };

    $(document).off('click', '.blai-diff-btn').on('click', '.blai-diff-btn', function() {
        const index = Number($(this).attr('data-index'));
        if (!Number.isInteger(index) || index < 0) return;
        diffRuntimeState.currentDiffIndex = index;
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
        if (diffRuntimeState.currentDiffIndex !== undefined) renderDiffModalContent(diffRuntimeState.currentDiffIndex);
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
