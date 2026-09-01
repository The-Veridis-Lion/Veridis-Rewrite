import { extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { isCotScopeSkippingEnabled } from '../scope/model.js';
import { loreFrameDomSelector } from '../integrations/loreFrame.js';
import { isMessageManualFinal } from '../diff/messageMeta.js';
import { isUserMessageDomNode, resolveMessageIndexFromDomNode } from './message.js';

/** Owns classification of DOM surfaces/text nodes that Veridis may or may not visually process. It does not mutate message data. */
export const messageBodySelector = '.mes .mes_text';
export const excludedMessageContentSelector = [
    'script',
    'style',
    'code',
    'pre',
    'textarea',
    'input',
    'select',
    'option',
    'button',
    '[role="button"]',
    '[role="menu"]',
    '[role="menuitem"]',
    '[role="dialog"]',
    '[aria-controls]',
    '[contenteditable]:not([contenteditable="false"])',
    '.mes_reasoning',
    '.mes_reasoning_details',
    '.mes_buttons',
    '.mes_controls',
    '.swipe_left',
    '.swipe_right',
    '.swipeRightBlock',
    '.blai-diff-btn',
    '.TH-collapse-code-block-button',
    '[class*="blai-diff"]',
].join(', ');

export const knownPluginContainerSelector = [
    '#tavern_helper',
    '#regex_editor_template',
    '#qr--settings',
    '#completion_prompt_manager_popup',
    '#xiaobai_template_editor',
    '#task_editor',
    loreFrameDomSelector,
].join(', ');

function isPersonaDescriptionProtectionEnabled() {
    return getAppContext().extension_settings?.[extensionName]?.protectPersonaDescription === true;
}

/**
 * 判断节点是否位于宿主应用的脚本编辑弹窗中。
 * 该弹窗可能同时存在多个实例，但内部结构一致，因此使用稳定的结构特征做匹配。
 * @param {Element} node 待检查节点。
 * @returns {boolean} true 表示节点位于脚本编辑弹窗内。
 */
function isScriptEditorDialogNode(node) {
    if (!node || !node.closest) return false;
    const dialog = node.closest('[role="dialog"], .popup, .vfm__content');
    if (!dialog) return false;
    return Boolean(
        dialog.querySelector('.TH-script-editor-container')
        && dialog.querySelector('#TH-script-editor-button-enabled-toggle')
        && dialog.querySelector('.text_pole')
    );
}

/**
 * 判断节点是否位于已知宿主插件容器内。
 * 这里不需要真正识别“插件类型”，只要容器 id 稳定，就可以把整个区域视为受保护输入区。
 * @param {Element} node 待检查节点。
 * @returns {boolean} true 表示节点位于已知插件容器内。
 */
function isKnownPluginContainerNode(node) {
    if (!node || !node.closest) return false;
    return Boolean(node.closest(knownPluginContainerSelector)); //酒馆助手，正则弹窗，qr，预设，小白角色模板，LoreFrame
} 

function isPersonaDescriptionNode(node) {
    if (!node || !node.closest) return false;
    if (!isPersonaDescriptionProtectionEnabled()) return false;
    const personaSelector = '#persona_description, [name="persona_description"], [data-for="persona_description"]';
    if (node.closest(personaSelector)) return true;
    const editorDialog = node.closest('[role="dialog"], .popup, .vfm__content');
    return Boolean(editorDialog?.querySelector?.(personaSelector));
}

function shouldProtectSkipUserNode(node) {
    if (!node || !node.closest) return false;
    const skipUserMessages = getAppContext().extension_settings?.[extensionName]?.skipUserMessages === true;
    if (!skipUserMessages) return false;
    if (node.closest('#send_textarea')) return true;
    return isUserMessageDomNode(node);
}

function shouldProtectReasoningNode(node) {
    if (!node || !node.closest) return false;
    if (!isCotScopeSkippingEnabled()) return false;
    return Boolean(node.closest('.mes_reasoning_details, .mes_reasoning'));
}

/**
 * 判断节点是否属于受保护区域。
 * @param {Element} node 待检查节点。
 * @returns {boolean} true 表示应跳过净化。
 */
export function isProtectedNode(node) {
    if (!node || !node.closest) return false;
    if (node.closest('.name_text')) return true;
    if (isPersonaDescriptionNode(node)) return true;
    if (shouldProtectReasoningNode(node)) return true;
    if (node.closest('#blai-purifier-popup, #blai-batch-popup, #blai-deep-clean-workspace, #blai-zh-dictionary-modal, #blai-rule-edit-modal, #blai-rule-transfer-modal, #blai-preset-import-choice-modal, #blai-rule-search-modal, #blai-scope-tags-modal, #blai-diff-modal, #blai-subrule-edit-modal, #blai-loading-overlay')) return true;
    if (shouldProtectSkipUserNode(node)) return true;
    if (isKnownPluginContainerNode(node)) return true;
    if (isScriptEditorDialogNode(node)) return true;
    if (node.closest('#advanced_formatting, #api_settings')) return true;
    if ((node.id && node.id.includes('shujuku_v120-')) || node.closest('[id*="shujuku_v120-"]')) return true;

    const promptIds = [
        'system_prompt', 'post_history_prompt', 'floating_prompt', 'nsfw_prompt', 'author_note', 'jailbreak_prompt', //预设
        'chat_completions_system_prompt', 'chat_completions_jailbreak_prompt', 'completion_prompt_manager_popup_entry_form_prompt',//预设
        'completion_prompt_manager_popup_entry_form_name', 'description_textarea', 'personality_textarea', 'scenario_textarea',//世界书&人设
        'mes_example_textarea', 'first_mes_textarea', 'creator_notes_textarea', '' //聊天
    ];
    if (node.id && promptIds.includes(node.id)) return true;
    if (node.id && node.id.startsWith('world_entry_content_')) return true;
    if (node.matches?.('.task_name_edit, .task_commands_edit')) return true; //小白任务
    const dataFor = typeof node.getAttribute === 'function' ? node.getAttribute('data-for') : '';
    if (dataFor && dataFor.startsWith('world_entry_content_')) return true;
    if (node.tagName === 'TEXTAREA' && node.name === 'comment') return true;
    return false;
}

export function isRevertedMessageDomNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const mesNode = node.matches?.('.mes') ? node : node.closest?.('.mes');
    if (!mesNode) return false;
    const index = resolveMessageIndexFromDomNode(mesNode);
    const { chat } = getAppContext();
    const msg = Array.isArray(chat) ? chat[index] : null;
    return msg?.__blai_is_reverted === true;
}

export function isManualFinalMessageDomNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const mesNode = node.matches?.('.mes') ? node : node.closest?.('.mes');
    if (!mesNode) return false;
    const index = resolveMessageIndexFromDomNode(mesNode);
    const { chat } = getAppContext();
    const msg = Array.isArray(chat) ? chat[index] : null;
    return isMessageManualFinal(msg);
}


export function isMessageOnAllowedSurface(messageNode) {
    if (!messageNode || !messageNode.closest) return false;
    if (messageNode.closest('#chat')) return true;
    const root = messageNode.getRootNode?.();
    const host = root?.host;
    return Boolean(host?.matches?.('#t-output-content .t-shadow-host')
        || host?.closest?.('#t-output-content .t-shadow-host'));
}

export function isPurifiableMessageTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return false;
    const parent = node.parentElement || node.parentNode;
    if (!parent?.closest) return false;
    const messageBody = parent.closest(messageBodySelector);
    if (!messageBody) return false;
    const messageNode = messageBody.closest('.mes');
    if (!isMessageOnAllowedSurface(messageNode)) return false;
    if (parent.closest(excludedMessageContentSelector)) return false;
    return true;
}

export function isAllowedChatInputElement(element) {
    return Boolean(element?.matches?.('#send_textarea'));
}

