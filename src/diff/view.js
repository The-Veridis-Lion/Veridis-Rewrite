import { extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { getMessageDomNode, resolveMessageIndexFromDomNode, isTrackableMessageDomNode } from '../dom/message.js';
import { isAssistantMessage, getLatestTrackableDiffIndices } from './tracking.js';

// Owns only live Diff-button DOM projection; visibility comes from tracking and settings.
export function ensureMessageDiffButton(index, messageNode) {
    if (!messageNode || !Number.isInteger(index) || index < 0) return;
    const { chat } = getAppContext();
    const msg = Array.isArray(chat) ? chat[index] : null;

    if (!isAssistantMessage(msg) || !isTrackableMessageDomNode(messageNode)) {
        messageNode.querySelectorAll?.('.blai-diff-btn').forEach(btn => btn.remove());
        return;
    }

    const nodeIndex = resolveMessageIndexFromDomNode(messageNode);
    if (nodeIndex !== index) {
        messageNode.querySelectorAll?.('.blai-diff-btn').forEach(btn => btn.remove());
        return;
    }

    const { extension_settings } = getAppContext();
    const isEnabled = extension_settings[extensionName]?.enableVisualDiff !== false;
    const isTopInExtra = extension_settings[extensionName]?.diffButtonInExtraMenu === true;
    const showBottomButton = extension_settings[extensionName]?.showBottomDiffButton !== false;
    const shouldShow = isEnabled && getLatestTrackableDiffIndices().includes(index);

    const buttonArea = messageNode.querySelector('.mes_buttons');
    if (buttonArea) {
        let existing = buttonArea.querySelector('.blai-diff-btn-top');
        const extraMenu = buttonArea.querySelector('.extraMesButtons');
        const targetContainer = (isTopInExtra && extraMenu) ? extraMenu : buttonArea;

        if (existing && existing.parentElement !== targetContainer) {
            existing.remove();
            existing = null;
        }

        if (!shouldShow) {
            if (existing) existing.remove();
        } else if (!existing) {
            const button = document.createElement('div');
            button.className = 'mes_button blai-diff-btn blai-diff-btn-top fa-solid fa-clock-rotate-left interactable';
            button.title = '溯源净化前文';
            button.setAttribute('data-index', String(index));
            button.setAttribute('tabindex', '0');
            button.setAttribute('role', 'button');

            if (isTopInExtra && extraMenu) {
                extraMenu.appendChild(button);
            } else {
                const editBtn = buttonArea.querySelector('.mes_edit');
                if (editBtn) buttonArea.insertBefore(button, editBtn);
                else buttonArea.appendChild(button);
            }
        } else {
            existing.setAttribute('data-index', String(index));
        }
    }

    const swipeBlock = messageNode.querySelector('.swipeRightBlock');
    if (swipeBlock) {
        const parent = swipeBlock.parentNode;
        const existingBottom = parent?.querySelector('.blai-diff-btn-bottom');

        if (!shouldShow || !showBottomButton) {
            if (existingBottom) existingBottom.remove();
        } else if (!existingBottom && parent) {
            const btnBottom = document.createElement('div');
            btnBottom.className = 'blai-diff-btn blai-diff-btn-bottom fa-solid fa-clock-rotate-left interactable';
            btnBottom.title = '溯源净化前文 (尾部触发)';
            btnBottom.setAttribute('data-index', String(index));
            btnBottom.setAttribute('tabindex', '0');
            btnBottom.setAttribute('role', 'button');
            parent.insertBefore(btnBottom, swipeBlock);
        } else if (existingBottom) {
            existingBottom.setAttribute('data-index', String(index));
        }
    }
}

function cleanupStrayDiffButtons(trackedSet) {
    document.querySelectorAll('.blai-diff-btn[data-index]').forEach((button) => {
        const index = Number(button.getAttribute('data-index'));
        const mesNode = button.closest('.mes');
        const nodeIndex = resolveMessageIndexFromDomNode(mesNode);
        if (!trackedSet.has(index) || nodeIndex !== index || !isTrackableMessageDomNode(mesNode)) button.remove();
    });
}

/**
 * 仅对最新 N 条可追踪消息定向注入差异按钮。
 * @param {number[]} [targetIndices=[]] 可选的定向消息索引。
 * @returns {void}
 */
export function injectDiffButtons(targetIndices = []) {
    const latest = getLatestTrackableDiffIndices();
    const latestSet = new Set(latest);

    const indices = Array.isArray(targetIndices) && targetIndices.length > 0
        ? [...new Set(targetIndices.filter(index => latestSet.has(index)))]
        : latest;

    cleanupStrayDiffButtons(latestSet);
    for (const index of indices) {
        const node = getMessageDomNode(index);
        if (node) ensureMessageDiffButton(index, node);
    }
}
