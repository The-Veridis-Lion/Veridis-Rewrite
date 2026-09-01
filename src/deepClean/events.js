// Owns Deep Clean user-action bindings and delegates lifecycle and review mutations to the existing Deep Clean owners.
import { extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { deepCleanRuntimeState } from './state.js';
import { logger } from '../log.js';
import {
    chooseDeepCleanQuickSelection,
    getDeepCleanInitialSelection,
    getDeepCleanLookaheadProgress,
    getDeepCleanReviewSession,
    requestDeepCleanStop,
    setDeepCleanFinalSelection,
    setDeepCleanLocalOption,
    setDeepCleanSpecifiedCharacters,
    runDeepCleanProgramProcessing,
    runDeepCleanScan,
    runDeepCleanApply,
    startDeepCleanRun,
} from './lifecycle.js';
import {
    selectDeepCleanReviewBlock,
    setDeepCleanReviewBlockText,
    setDeepCleanReviewEqualText,
    setDeepCleanReviewCurrentItem,
    setDeepCleanReviewViewMode,
} from './review.js';
import {
    closeDeepCleanInitialSelection,
    openDeepCleanInitialSelection,
    renderDeepCleanInitialSelection,
    renderDeepCleanScanProgress,
    renderDeepCleanScanResult,
    renderDeepCleanBatchProgress,
    renderDeepCleanLookaheadProgress,
    renderDeepCleanReview,
    renderDeepCleanApplyProgress,
    renderDeepCleanComplete,
    renderDeepCleanStopped,
    showDeepCleanInitialSelectionError,
} from './view.js';

export function bindDeepCleanEvents() {
const renderDeepCleanSelection = (selection = getDeepCleanInitialSelection()) => {
    renderDeepCleanInitialSelection(selection, getAppContext().extension_settings[extensionName]?.presets || {});
};
const updateDeepCleanFinalSelection = (kind, value, checked) => {
    const selection = getDeepCleanInitialSelection();
    if (!selection) return;
    const propertyByKind = {
        character: 'characterKeys',
        chat: 'chatKeys',
        persona: 'personaKeys',
        'world-book': 'worldBookKeys',
    };
    const current = selection[propertyByKind[kind]] || [];
    const next = checked
        ? (current.includes(value) ? current : [...current, value])
        : current.filter((item) => item !== value);
    renderDeepCleanSelection(setDeepCleanFinalSelection(kind, next));
};

$(document).off('click', '#blai-deep-clean-btn').on('click', '#blai-deep-clean-btn', async () => {
    const activeSession = getDeepCleanReviewSession();
    const activePhase = ['frozen', 'scan-result', 'batch-processing', 'review', 'apply', 'stopping'].includes(deepCleanRuntimeState.deepCleanPhase);
    openDeepCleanInitialSelection({ preserveContent: activePhase || deepCleanRuntimeState.deepCleanPhase === 'initial-selection' });
    if (activeSession) {
        renderDeepCleanReview(activeSession, getDeepCleanLookaheadProgress());
        return;
    }
    if (deepCleanRuntimeState.deepCleanPhase === 'initial-selection') {
        renderDeepCleanSelection();
        return;
    }
    if (activePhase) return;
    try {
        renderDeepCleanSelection(await startDeepCleanRun());
    } catch (error) {
        logger.error('[Deep Clean] 读取 Initial Selection 资源失败', error);
        showDeepCleanInitialSelectionError(error);
    }
});

$(document).off('click', '#blai-deep-clean-close').on('click', '#blai-deep-clean-close', () => {
    closeDeepCleanInitialSelection();
});

$(document).off('click', '#blai-deep-clean-scan').on('click', '#blai-deep-clean-scan', async () => {
    try {
        const run = await runDeepCleanScan({
            onProgress: renderDeepCleanScanProgress,
        });
        if (run?.scanResult) renderDeepCleanScanResult(run.scanResult);
        else if (deepCleanRuntimeState.deepCleanPhase === 'stopped') renderDeepCleanStopped();
    } catch (error) {
        logger.error('[Deep Clean] scan failed', error);
        showDeepCleanInitialSelectionError(error);
    }
});

$(document).off('click', '#blai-deep-clean-process-program').on('click', '#blai-deep-clean-process-program', async () => {
    try {
        const result = await runDeepCleanProgramProcessing({
            onProgress: renderDeepCleanBatchProgress,
            onLookaheadProgress: renderDeepCleanLookaheadProgress,
        });
        if (result?.complete) renderDeepCleanComplete(result.summary);
        else if (result) renderDeepCleanReview(result, getDeepCleanLookaheadProgress());
        else if (deepCleanRuntimeState.deepCleanPhase === 'stopped') renderDeepCleanStopped();
    } catch (error) {
        logger.error('[Deep Clean] Batch processing failed', error);
        showDeepCleanInitialSelectionError(error);
    }
});

const focusDeepCleanReviewBlock = (blockIndex, branch) => {
    const target = document.querySelector(`[data-deep-clean-review-block-branch="${branch}"][data-deep-clean-review-block-index="${blockIndex}"]`);
    if (!(target instanceof HTMLElement)) return;
    target.focus();
    if (target.matches('[data-deep-clean-review-empty-branch]')) return;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
};
const chooseDeepCleanReviewBlock = (element) => {
    const session = getDeepCleanReviewSession();
    if (!session) return;
    const blockIndex = Number($(element).attr('data-deep-clean-review-block-index'));
    const branch = String($(element).attr('data-deep-clean-review-block-branch') || '');
    const alreadyActive = element.classList.contains('is-active');
    if (alreadyActive) return;
    selectDeepCleanReviewBlock(session, session.currentItemIndex, blockIndex, branch);
    renderDeepCleanReview(session, getDeepCleanLookaheadProgress());
    focusDeepCleanReviewBlock(blockIndex, branch);
};

$(document).off('click', '[data-deep-clean-review-block-branch]').on('click', '[data-deep-clean-review-block-branch]', function() {
    chooseDeepCleanReviewBlock(this);
});

$(document).off('keydown', '[data-deep-clean-review-block-branch]').on('keydown', '[data-deep-clean-review-block-branch]', function(event) {
    if (this.classList.contains('is-active')) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    chooseDeepCleanReviewBlock(this);
});

$(document).off('input', '[data-deep-clean-review-block-branch].is-active').on('input', '[data-deep-clean-review-block-branch].is-active', function() {
    const session = getDeepCleanReviewSession();
    if (!session) return;
    const blockIndex = Number($(this).attr('data-deep-clean-review-block-index'));
    setDeepCleanReviewBlockText(session, session.currentItemIndex, blockIndex, this.innerText);
});

$(document).off('input', '[data-deep-clean-review-equal-block-index]').on('input', '[data-deep-clean-review-equal-block-index]', function() {
    const session = getDeepCleanReviewSession();
    if (!session) return;
    const blockIndex = Number($(this).attr('data-deep-clean-review-equal-block-index'));
    setDeepCleanReviewEqualText(session, session.currentItemIndex, blockIndex, this.innerText);
});

$(document).off('click', '[data-deep-clean-review-view]').on('click', '[data-deep-clean-review-view]', function() {
    const session = getDeepCleanReviewSession();
    if (!session) return;
    const viewMode = String($(this).attr('data-deep-clean-review-view') || '');
    if (session.viewMode === viewMode) return;
    setDeepCleanReviewViewMode(session, viewMode);
    renderDeepCleanReview(session, getDeepCleanLookaheadProgress());
});

$(document).off('click', '[data-deep-clean-review-nav]').on('click', '[data-deep-clean-review-nav]', function() {
    const session = getDeepCleanReviewSession();
    if (!session) return;
    const position = session.reviewItemIndexes.indexOf(session.currentItemIndex);
    const direction = String($(this).attr('data-deep-clean-review-nav') || '');
    const nextPosition = direction === 'previous' ? position - 1 : position + 1;
    if (nextPosition < 0 || nextPosition >= session.reviewItemIndexes.length) return;
    setDeepCleanReviewCurrentItem(session, session.reviewItemIndexes[nextPosition]);
    renderDeepCleanReview(session, getDeepCleanLookaheadProgress());
});

$(document).off('click', '#blai-deep-clean-stop').on('click', '#blai-deep-clean-stop', function() {
    $(this).prop('disabled', true);
    const stoppedPhase = requestDeepCleanStop();
    if (stoppedPhase === 'stopped') renderDeepCleanStopped();
});

$(document).off('click', '#blai-deep-clean-apply').on('click', '#blai-deep-clean-apply', async function() {
    const session = getDeepCleanReviewSession();
    if (!session) return;
    $(this).prop('disabled', true);
    try {
        const result = await runDeepCleanApply({
            onProgress: renderDeepCleanApplyProgress,
            onLookaheadProgress: renderDeepCleanLookaheadProgress,
        });
        if (result?.stopped) renderDeepCleanStopped();
        else if (result?.nextSession) renderDeepCleanReview(result.nextSession, getDeepCleanLookaheadProgress());
        else if (result?.complete) renderDeepCleanComplete(result.summary);
    } catch (error) {
        logger.error('[Deep Clean] apply failed', error);
        showDeepCleanInitialSelectionError(error);
    }
});

$(document).off('click', '[data-deep-clean-quick]').on('click', '[data-deep-clean-quick]', function() {
    const quickSelection = String($(this).attr('data-deep-clean-quick') || '');
    const selection = getDeepCleanInitialSelection();
    if (quickSelection === 'specified-characters' && selection?.quickSelection === quickSelection) return;
    const nextSelection = chooseDeepCleanQuickSelection(quickSelection);
    const preferredTab = quickSelection === 'current-chat'
        ? 'chat'
        : (quickSelection === 'current-character' || quickSelection === 'specified-characters' || quickSelection === 'all-tavern'
            ? 'character'
            : null);
    if (preferredTab) {
        const searchByTab = {
            character: 'characters',
            chat: 'chats',
        };
        $('#blai-deep-clean-workspace').attr('data-deep-clean-active-resource', preferredTab);
        $(`[data-deep-clean-search="${searchByTab[preferredTab] || ''}"]`).val('');
    }
    renderDeepCleanSelection(nextSelection);
});

$(document).off('click', '[data-deep-clean-resource-tab]').on('click', '[data-deep-clean-resource-tab]', function() {
    const activeTab = String($(this).attr('data-deep-clean-resource-tab') || 'character');
    $('#blai-deep-clean-workspace').attr('data-deep-clean-active-resource', activeTab);
    renderDeepCleanSelection();
});

$(document).off('change', '[data-deep-clean-specified]').on('change', '[data-deep-clean-specified]', function() {
    const selection = getDeepCleanInitialSelection();
    if (!selection) return;
    const characterKey = decodeURIComponent(String($(this).attr('data-deep-clean-value') || ''));
    const next = this.checked
        ? (selection.specifiedCharacterKeys.includes(characterKey)
            ? selection.specifiedCharacterKeys
            : [...selection.specifiedCharacterKeys, characterKey])
        : selection.specifiedCharacterKeys.filter((item) => item !== characterKey);
    renderDeepCleanSelection(setDeepCleanSpecifiedCharacters(next));
});

$(document).off('change', '[data-deep-clean-resource]').on('change', '[data-deep-clean-resource]', function() {
    const kind = String($(this).attr('data-deep-clean-resource') || '');
    const value = decodeURIComponent(String($(this).attr('data-deep-clean-value') || ''));
    updateDeepCleanFinalSelection(kind, value, this.checked);
});

$(document).off('click', '[data-deep-clean-search-selection]').on('click', '[data-deep-clean-search-selection]', function() {
    const kind = String($(this).attr('data-deep-clean-search-selection') || '');
    const action = String($(this).attr('data-deep-clean-search-selection-action') || '');
    const selection = getDeepCleanInitialSelection();
    const propertyByKind = {
        chat: 'chatKeys',
        persona: 'personaKeys',
        'world-book': 'worldBookKeys',
    };
    const property = propertyByKind[kind];
    if (!selection || !property || (action !== 'select' && action !== 'deselect')) return;
    const currentSearchKeys = $(`[data-deep-clean-resource="${kind}"]`).map((_, input) => (
        decodeURIComponent(String($(input).attr('data-deep-clean-value') || ''))
    )).get();
    const next = action === 'select'
        ? [...selection[property], ...currentSearchKeys.filter((key) => !selection[property].includes(key))]
        : selection[property].filter((key) => !currentSearchKeys.includes(key));
    renderDeepCleanSelection(setDeepCleanFinalSelection(kind, next));
});

$(document).off('change', '[data-deep-clean-option]').on('change', '[data-deep-clean-option]', function() {
    const selection = setDeepCleanLocalOption(String($(this).attr('data-deep-clean-option') || ''), $(this).val());
    if (selection && this instanceof HTMLInputElement && this.type === 'radio') renderDeepCleanSelection(selection);
});

$(document).off('click', '[data-deep-clean-option-choice]').on('click', '[data-deep-clean-option-choice]', function() {
    const selection = setDeepCleanLocalOption(
        String($(this).attr('data-deep-clean-option-choice') || ''),
        String($(this).attr('data-deep-clean-option-value') || ''),
    );
    if (selection) renderDeepCleanSelection(selection);
});

$(document).off('input', '[data-deep-clean-search]').on('input', '[data-deep-clean-search]', function() {
    const searchName = String($(this).attr('data-deep-clean-search') || '');
    const value = String($(this).val() || '');
    renderDeepCleanSelection();
    const input = document.querySelector(`[data-deep-clean-search="${searchName}"]`);
    if (input instanceof HTMLInputElement) {
        input.focus();
        input.setSelectionRange(value.length, value.length);
    }
});

}
