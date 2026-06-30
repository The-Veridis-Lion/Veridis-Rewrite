import { extensionName, getAppContext, runtimeState } from './state.js';
import { applyScopedReplacements, applyVisualMask, buildProcessors, resolveRegexProcessorReplacement } from './core.js';
import { isCotScopeSkippingEnabled } from './utils.js';
import { loreFrameDomSelector } from './platform.js';

const streamingTailMaxChars = 1600;
const streamingTailContextChars = 180;
const streamingTailSegmentCount = 2;

const knownPluginContainerSelector = [
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

export function syncPersonaDescriptionProtectionControl() {
    const settings = getAppContext().extension_settings?.[extensionName];
    if (!settings || typeof document === 'undefined') return;

    const updateButton = (button) => {
        if (!button) return;
        const enabled = settings.protectPersonaDescription === true;
        button.classList.toggle('is-active', enabled);
        button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
        button.setAttribute('title', enabled ? '已保护用户设定描述，点击取消保护' : '点击保护用户设定描述');
        const text = button.querySelector('.blai-persona-protect-text');
        const isPanelControl = Boolean(button.closest('#blai-purifier-popup'));
        if (text) text.textContent = isPanelControl ? (enabled ? '开启' : '关闭') : (enabled ? '已保护' : '保护');
        const icon = button.querySelector('i');
        if (icon) icon.className = enabled ? 'fa-solid fa-shield-halved' : 'fa-solid fa-shield';
    };

    document
        .querySelectorAll('.blai-persona-description-protect-toggle')
        .forEach(updateButton);

    const anchor = document.querySelector('[data-for="persona_description"]');
    const textarea = document.querySelector('#persona_description, [name="persona_description"]');
    const heading = anchor?.closest?.('h4') || textarea?.previousElementSibling;
    if (!heading || heading.querySelector?.('.blai-persona-description-protect-toggle')) {
        return;
    }

    const enabled = settings.protectPersonaDescription === true;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `blai-persona-description-protect-toggle${enabled ? ' is-active' : ''}`;
    button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    button.setAttribute('title', enabled ? '已保护用户设定描述，点击取消保护' : '点击保护用户设定描述');
    button.innerHTML = `<i class="${enabled ? 'fa-solid fa-shield-halved' : 'fa-solid fa-shield'}"></i><span class="blai-persona-protect-text">${enabled ? '已保护' : '保护'}</span>`;
    heading.appendChild(button);
    updateButton(button);
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
    if (node.closest('#blai-purifier-popup, #blai-batch-popup, #blai-confirm-modal, #blai-zh-dictionary-modal, #blai-rule-edit-modal, #blai-rule-transfer-modal, #blai-preset-import-choice-modal, #blai-rule-search-modal, #blai-scope-tags-modal, #blai-diff-modal, #blai-subrule-edit-modal, #blai-loading-overlay')) return true;
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

function shouldSkipTextNode(node) {
    const parent = node?.parentNode;
    if (!parent) return true;
    if (isProtectedNode(parent) || isRevertedMessageDomNode(parent)) return true;
    if (document.activeElement && (document.activeElement === parent || parent.contains(document.activeElement))) return true;
    if (getAppContext().extension_settings?.[extensionName]?.skipUserMessages && isUserMessageDomNode(parent)) return true;
    return false;
}

function collectPurifiableTextNodes(rootNode) {
    const nodes = [];
    if (!rootNode) return nodes;
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, null, false);
    let node;
    while (node = walker.nextNode()) {
        if (!node.nodeValue || shouldSkipTextNode(node)) continue;
        nodes.push(node);
    }
    return nodes;
}

function projectTextAcrossNodes(textNodes, nextText) {
    let offset = 0;
    for (let i = 0; i < textNodes.length; i++) {
        const node = textNodes[i];
        const originalLength = String(node.nodeValue || '').length;
        const remainingLength = Math.max(0, nextText.length - offset);
        const takeLength = i === textNodes.length - 1
            ? remainingLength
            : Math.min(originalLength, remainingLength);
        const projected = takeLength > 0 ? nextText.slice(offset, offset + takeLength) : '';
        if (node.nodeValue !== projected) node.nodeValue = projected;
        offset += takeLength;
    }
}

function getLineBreakSignature(text = '') {
    return String(text).match(/\r\n|\r|\n/g)?.join('|') || '';
}

function getStreamingTailStart(text = '') {
    const value = String(text || '');
    if (value.length <= streamingTailMaxChars) return 0;

    const searchStart = Math.max(0, value.length - streamingTailMaxChars - streamingTailContextChars);
    const searchText = value.slice(searchStart);
    const segmentStarts = [searchStart];
    const lineBreakRegex = /\r\n|\r|\n/g;
    let match;

    while ((match = lineBreakRegex.exec(searchText)) !== null) {
        segmentStarts.push(searchStart + match.index + match[0].length);
    }

    if (segmentStarts.length > streamingTailSegmentCount) {
        const start = segmentStarts[segmentStarts.length - streamingTailSegmentCount];
        return Math.max(0, start - streamingTailContextChars);
    }

    return Math.max(0, value.length - streamingTailMaxChars - streamingTailContextChars);
}

function selectStreamingTailTextNodes(textNodes) {
    if (!Array.isArray(textNodes) || textNodes.length <= 1) return textNodes || [];

    const selected = [];
    let totalLength = 0;
    let segmentBreaks = 0;
    const targetLength = streamingTailMaxChars + streamingTailContextChars;

    for (let i = textNodes.length - 1; i >= 0; i--) {
        const node = textNodes[i];
        const value = String(node?.nodeValue || '');
        selected.unshift(node);
        totalLength += value.length;
        segmentBreaks += (value.match(/\r\n|\r|\n/g) || []).length;

        if (totalLength >= targetLength && segmentBreaks >= streamingTailSegmentCount - 1) break;
        if (totalLength >= targetLength + streamingTailMaxChars) break;
    }

    return selected;
}

export function applyStreamingVisualMask(originalText, options = {}) {
    if (typeof originalText !== 'string' || !originalText) return originalText;

    const tailStart = getStreamingTailStart(originalText);
    if (tailStart <= 0) return applyVisualMask(originalText, options);

    const prefix = originalText.slice(0, tailStart);
    const tail = originalText.slice(tailStart);
    const nextTail = applyVisualMask(tail, options);
    return prefix + nextTail;
}

function getReplaceCallbackMatchOffset(args) {
    const hasNamedGroups = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null;
    return Number(args[hasNamedGroups ? args.length - 3 : args.length - 2]);
}

function buildTextNodeRanges(textNodes) {
    const ranges = [];
    let offset = 0;
    textNodes.forEach((node, index) => {
        const value = String(node.nodeValue || '');
        ranges.push({
            node,
            index,
            start: offset,
            end: offset + value.length,
        });
        offset += value.length;
    });
    return ranges;
}

function findRangeForPosition(ranges, position) {
    return ranges.find((range) => position >= range.start && position < range.end) || null;
}

function applyUnsafeRegexEdit(edit, ranges) {
    const startRange = ranges[edit.startRangeIndex];
    const endRange = ranges[edit.endRangeIndex];
    if (!startRange || !endRange) return false;

    const startNode = startRange.node;
    const endNode = endRange.node;
    const startValue = String(startNode.nodeValue || '');
    const endValue = String(endNode.nodeValue || '');
    const localStart = edit.start - startRange.start;
    const localEnd = edit.end - endRange.start;

    if (startRange.index === endRange.index) {
        startNode.nodeValue = startValue.slice(0, localStart) + edit.replacement + startValue.slice(localEnd);
        return true;
    }

    startNode.nodeValue = startValue.slice(0, localStart) + edit.replacement;
    for (let i = startRange.index + 1; i < endRange.index; i++) {
        ranges[i].node.nodeValue = '';
    }
    endNode.nodeValue = endValue.slice(localEnd);
    return true;
}

function applyUnsafeRegexWithinTextNodes(textNodes, processors = runtimeState.activeProcessors) {
    let changed = false;

    processors.forEach((proc, procIndex) => {
        if (proc.kind !== 'regex' || proc.domSafe !== false) return;

        const ranges = buildTextNodeRanges(textNodes);
        const originalText = ranges.map((range) => range.node.nodeValue || '').join('');
        if (!originalText.trim()) return;

        const edits = [];
        proc.regex.lastIndex = 0;
        originalText.replace(proc.regex, (match, ...args) => {
            const start = getReplaceCallbackMatchOffset(args);
            const end = start + String(match).length;
            if (!Number.isInteger(start) || end <= start) return match;

            const replacement = resolveRegexProcessorReplacement(proc, procIndex, match, args, true);
            if (/[\r\n]/.test(String(match)) || /[\r\n]/.test(String(replacement))) return match;

            const startRange = findRangeForPosition(ranges, start);
            const endRange = findRangeForPosition(ranges, end - 1);
            if (!startRange || !endRange) return match;

            edits.push({
                start,
                end,
                replacement,
                startRangeIndex: startRange.index,
                endRangeIndex: endRange.index,
            });
            return match;
        });

        edits.sort((a, b) => b.start - a.start);
        edits.forEach((edit) => {
            if (applyUnsafeRegexEdit(edit, ranges)) changed = true;
        });
    });

    return changed;
}

/**
 * 对指定 DOM 子树执行净化替换。
 * @param {Node} rootNode 待净化根节点。
 * @returns {void}
 */
export function purifyDOM(rootNode) {
    if (!rootNode) return;
    if (rootNode.nodeType === 1 && isRevertedMessageDomNode(rootNode)) return;
    const processors = buildProcessors({ includeAiRewrite: runtimeState.isStreamingGeneration === true });
    if (processors.length === 0) return;

    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT, null, false);

let node;
    while (node = walker.nextNode()) {
        if (shouldSkipTextNode(node)) continue;

        const original = node.nodeValue || '';
        if (original.trim() === '') continue;

        const nextValue = runtimeState.isStreamingGeneration
            ? applyStreamingVisualMask(original, { domSafeOnly: true })
            : applyScopedReplacements(original, { deterministic: true, domSafeOnly: true });
        if (original !== nextValue) node.nodeValue = nextValue;
    }
}

/**
 * 流式输出时按尾部窗口做简单视觉净化。
 * 该模式只改 DOM 显示，不写入 chat 数据；生成结束后仍由数据净化流程落盘。
 * @param {Element} messageNode 消息 DOM 节点。
 * @param {{domSafeOnly?: boolean, unsafeRegexOnly?: boolean}} [options={}] 净化选项。
 * @returns {boolean} 是否发生视觉替换。
 */
export function purifyStreamingMessageDom(messageNode, options = {}) {
    if (!messageNode || messageNode.nodeType !== 1 || runtimeState.isStreamingGeneration !== true) return false;
    if (isRevertedMessageDomNode(messageNode)) return false;

    const processors = buildProcessors({ includeAiRewrite: true });
    if (processors.length === 0) return false;

    const rootNode = messageNode.querySelector?.('.mes_text') || messageNode;
    const textNodes = collectPurifiableTextNodes(rootNode);
    const unsafeRegexOnly = options.unsafeRegexOnly === true;
    if (textNodes.length === 0) return false;
    const scanTextNodes = selectStreamingTailTextNodes(textNodes);

    const originalText = scanTextNodes.map((node) => node.nodeValue || '').join('');
    if (!originalText.trim()) return false;

    if (unsafeRegexOnly) return applyUnsafeRegexWithinTextNodes(scanTextNodes, processors);

    const nextText = applyStreamingVisualMask(originalText, { domSafeOnly: options.domSafeOnly !== false });
    if (originalText === nextText) return false;
    if (getLineBreakSignature(originalText) !== getLineBreakSignature(nextText)) return false;

    projectTextAcrossNodes(scanTextNodes, nextText);
    return true;
}

/**
 * 根据消息索引获取对应 DOM 节点。
 * @param {number} index 消息索引。
 * @returns {Element | null} 对应消息节点，找不到时返回 null。
 */
export function getMessageDomNode(index) {
    const chatEl = document.getElementById('chat');
    if (!chatEl || !Number.isInteger(index) || index < 0) return null;
    const selectors = [`.mes[mesid="${index}"]`, `.mes[data-mesid="${index}"]`, `.mes[messageid="${index}"]`, `.mes[data-message-id="${index}"]`];
    for (const selector of selectors) {
        const node = chatEl.querySelector(selector);
        if (node) return node;
    }
    const allMes = Array.from(chatEl.querySelectorAll('.mes'));
    const byOrder = allMes[index];
    if (byOrder && resolveMessageIndexFromDomNode(byOrder) === index) return byOrder;
    return null;
}

export function isUserMessageDomNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const mesNode = node.matches?.('.mes') ? node : node.closest?.('.mes');
    if (!mesNode) return false;
    return mesNode.getAttribute('is_user') === 'true' || mesNode.dataset?.isUser === 'true';
}

export function isTrackableMessageDomNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const mesNode = node.matches?.('.mes') ? node : node.closest?.('.mes');
    if (!mesNode) return false;
    return !isUserMessageDomNode(mesNode);
}

export function resolveMessageIndexFromDomNode(node) {
    if (!node || node.nodeType !== 1) return -1;
    const mesNode = node.matches?.('.mes') ? node : node.closest?.('.mes');
    if (!mesNode) return -1;

    const attrs = [
        mesNode.getAttribute('mesid'),
        mesNode.getAttribute('data-mesid'),
        mesNode.getAttribute('messageid'),
        mesNode.getAttribute('data-message-id')
    ];

    for (const raw of attrs) {
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 0) return n;
    }

    const chatEl = document.getElementById('chat');
    if (!chatEl) return -1;
    const nodes = Array.from(chatEl.querySelectorAll('.mes'));
    const index = nodes.indexOf(mesNode);
    return index >= 0 ? index : -1;
}
