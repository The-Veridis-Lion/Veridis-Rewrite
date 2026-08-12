import { extensionName, getAppContext, runtimeState } from './state.js';
import {
    applyScopedReplacements,
    applyVisualMask,
    buildProcessors,
    collectScopedReplacementRanges,
    hasEnabledScopeTags,
    isStreamingVisualProcessorSafe,
    resolveProcessorReplacement,
} from './replacementEngine.js';
import { isCotScopeSkippingEnabled } from './utils.js';
import { loreFrameDomSelector } from './platform.js';
import { isMessageManualFinal } from './messageMeta.js';

const messageBodySelector = '.mes .mes_text';
const excludedMessageContentSelector = [
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

export function isManualFinalMessageDomNode(node) {
    if (!node || node.nodeType !== 1) return false;
    const mesNode = node.matches?.('.mes') ? node : node.closest?.('.mes');
    if (!mesNode) return false;
    const index = resolveMessageIndexFromDomNode(mesNode);
    const { chat } = getAppContext();
    const msg = Array.isArray(chat) ? chat[index] : null;
    return isMessageManualFinal(msg);
}

function shouldSkipTextNode(node) {
    const parent = node?.parentNode;
    if (!parent) return true;
    if (node.nodeType !== Node.TEXT_NODE) return true;
    if (!isPurifiableMessageTextNode(node)) return true;
    if (isProtectedNode(parent) || isRevertedMessageDomNode(parent) || isManualFinalMessageDomNode(parent)) return true;
    if (document.activeElement && (document.activeElement === parent || parent.contains(document.activeElement))) return true;
    if (getAppContext().extension_settings?.[extensionName]?.skipUserMessages && isUserMessageDomNode(parent)) return true;
    return false;
}

function isMessageOnAllowedSurface(messageNode) {
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

function collectMessageBodyRoots(rootNode) {
    const roots = [];
    if (!rootNode) return roots;
    if (rootNode.nodeType === Node.ELEMENT_NODE && rootNode.matches?.(messageBodySelector)) roots.push(rootNode);
    rootNode.querySelectorAll?.(messageBodySelector).forEach((node) => roots.push(node));
    return [...new Set(roots)].filter((body) => isMessageOnAllowedSurface(body.closest?.('.mes')));
}

/**
 * 对指定 DOM 子树执行净化替换。
 * @param {Node} rootNode 待净化根节点。
 * @returns {void}
 */
export function purifyDOM(rootNode) {
    if (!rootNode || runtimeState.isStreamingGeneration === true) return;
    if (rootNode.nodeType === 1 && (isRevertedMessageDomNode(rootNode) || isManualFinalMessageDomNode(rootNode))) return;
    const processors = buildProcessors();
    if (processors.length === 0) return;

    const messageBodies = collectMessageBodyRoots(rootNode);
    for (const messageBody of messageBodies) {
        const walker = document.createTreeWalker(messageBody, NodeFilter.SHOW_TEXT, null, false);
        let node;
        while (node = walker.nextNode()) {
            if (shouldSkipTextNode(node)) continue;

            const original = node.nodeValue || '';
            if (original.trim() === '') continue;

            const nextValue = applyScopedReplacements(original, { deterministic: true, domSafeOnly: true });
            if (original !== nextValue) node.nodeValue = nextValue;
        }
    }
}

function findTavernHelperStreamingSurface(messageNode) {
    const local = messageNode?.querySelectorAll?.('.TH-streaming');
    return local?.length ? local[local.length - 1] : null;
}

function shouldSkipStreamingPresentationTextNode(node, surface) {
    const parent = node?.parentElement || node?.parentNode;
    if (!parent || node.nodeType !== Node.TEXT_NODE) return true;
    if (!surface?.contains?.(parent)) return true;
    if (parent.closest?.(excludedMessageContentSelector)) return true;
    if (isProtectedNode(parent) || isRevertedMessageDomNode(parent) || isManualFinalMessageDomNode(parent)) return true;
    if (document.activeElement && (document.activeElement === parent || parent.contains?.(document.activeElement))) return true;
    if (getAppContext().extension_settings?.[extensionName]?.skipUserMessages && isUserMessageDomNode(parent)) return true;
    return false;
}

/**
 * 在宿主或酒馆助手已经渲染完成的显示面上只替换普通文本节点。
 * 不重建 innerHTML，从而保留代码块折叠、iframe 和其他扩展绑定的 DOM 与事件。
 * @param {Element} surface 当前帧的显示面。
 * @returns {boolean} 是否修改了至少一个文本节点。
 */
function stripStreamingWrapperTags(text) {
    return String(text || '').replace(/<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*?)?>/g, '');
}

export function resolveSingleNodeStreamingProjection(rawSource, cleanSource, currentText) {
    const rawText = String(rawSource || '');
    const cleanText = String(cleanSource || '');
    if (!rawText || rawText === cleanText) return null;
    if (currentText === rawText) return cleanText;

    const visibleRawText = stripStreamingWrapperTags(rawText);
    if (currentText !== visibleRawText) return null;
    return stripStreamingWrapperTags(cleanText);
}

function isStreamingRunBoundaryElement(element) {
    return element?.matches?.('p, div, li, blockquote, h1, h2, h3, h4, h5, h6, table, thead, tbody, tfoot, tr, td, th, ul, ol');
}

function collectStreamingTextRuns(surface) {
    const runs = [];
    let currentRun = [];
    const flush = () => {
        if (currentRun.length > 0) runs.push(currentRun);
        currentRun = [];
    };

    const walk = (node) => {
        if (node?.nodeType === Node.TEXT_NODE) {
            if (shouldSkipStreamingPresentationTextNode(node, surface)) {
                flush();
                return;
            }
            currentRun.push(node);
            return;
        }
        if (node?.nodeType !== Node.ELEMENT_NODE) return;

        if (node !== surface && (
            node.matches?.('br, hr')
            || node.matches?.(excludedMessageContentSelector)
            || isProtectedNode(node)
            || isRevertedMessageDomNode(node)
            || isManualFinalMessageDomNode(node)
            || (document.activeElement && (document.activeElement === node || node.contains?.(document.activeElement)))
        )) {
            flush();
            return;
        }

        const isBoundary = node !== surface && isStreamingRunBoundaryElement(node);
        if (isBoundary) flush();
        Array.from(node.childNodes || []).forEach(walk);
        if (isBoundary) flush();
    };

    walk(surface);
    flush();
    return runs;
}

function collectStreamingSurfaceText(surface) {
    let text = '';
    const walk = (node) => {
        if (node?.nodeType === Node.TEXT_NODE) {
            text += node.nodeValue || '';
            return;
        }
        Array.from(node?.childNodes || []).forEach(walk);
    };
    walk(surface);
    return text;
}

function buildNodeRangeSnapshot(nodes, startNode = null, startOffset = 0, endNode = null, endOffset = 0) {
    const firstIndex = startNode ? nodes.indexOf(startNode) : 0;
    const lastIndex = endNode ? nodes.indexOf(endNode) : nodes.length - 1;
    const ranges = [];
    let text = '';

    for (let index = firstIndex; index <= lastIndex; index++) {
        const node = nodes[index];
        const value = node?.nodeValue || '';
        const localStart = node === startNode ? startOffset : 0;
        const localEnd = node === endNode ? endOffset : value.length;
        const slice = value.slice(localStart, localEnd);
        ranges.push({
            node,
            nodeIndex: index,
            localStart,
            localEnd,
            globalStart: text.length,
            globalEnd: text.length + slice.length,
        });
        text += slice;
    }

    return { text, ranges };
}

function locateRangeStart(ranges, offset) {
    for (const range of ranges) {
        if (offset === range.globalStart) {
            return { node: range.node, nodeIndex: range.nodeIndex, offset: range.localStart };
        }
        if (offset < range.globalEnd) {
            return { node: range.node, nodeIndex: range.nodeIndex, offset: range.localStart + offset - range.globalStart };
        }
    }
    const last = ranges[ranges.length - 1];
    return last ? { node: last.node, nodeIndex: last.nodeIndex, offset: last.localEnd } : null;
}

function locateRangeEnd(ranges, offset) {
    for (const range of ranges) {
        if (offset > range.globalStart && offset <= range.globalEnd) {
            return { node: range.node, nodeIndex: range.nodeIndex, offset: range.localStart + offset - range.globalStart };
        }
    }
    return locateRangeStart(ranges, offset);
}

function createStreamingSegment(nodes, runSnapshot, range) {
    const start = locateRangeStart(runSnapshot.ranges, range.start);
    const end = locateRangeEnd(runSnapshot.ranges, range.end);
    if (!start || !end) return null;
    return {
        nodes: nodes.slice(start.nodeIndex, end.nodeIndex + 1),
        startNode: start.node,
        startOffset: start.offset,
        endNode: end.node,
        endOffset: end.offset,
    };
}

function collectProcessorMatches(text, processor, processorIndex) {
    const matches = [];
    text.replace(processor.regex, (match, ...args) => {
        const hasNamedGroups = typeof args[args.length - 1] === 'object' && args[args.length - 1] !== null;
        const offset = Number(args[args.length - (hasNamedGroups ? 3 : 2)]);
        const replacement = String(resolveProcessorReplacement(processor, processorIndex, match, args, true) ?? '');
        if (replacement === match) return match;
        matches.push({
            start: offset,
            end: offset + match.length,
            replacement,
        });
        return match;
    });
    return matches;
}

function insertAtStreamingOffset(segment, snapshot, offset, replacement) {
    const location = locateRangeStart(snapshot.ranges, offset);
    if (!location) return;
    const value = location.node.nodeValue || '';
    location.node.nodeValue = value.slice(0, location.offset) + replacement + value.slice(location.offset);
    if (location.node === segment.endNode && location.offset <= segment.endOffset) {
        segment.endOffset += replacement.length;
    }
}

function replaceStreamingRange(segment, snapshot, match) {
    if (match.start === match.end) {
        insertAtStreamingOffset(segment, snapshot, match.start, match.replacement);
        return;
    }

    const start = locateRangeStart(snapshot.ranges, match.start);
    const end = locateRangeEnd(snapshot.ranges, match.end);
    if (!start || !end) return;

    if (start.node === end.node) {
        const value = start.node.nodeValue || '';
        start.node.nodeValue = value.slice(0, start.offset) + match.replacement + value.slice(end.offset);
        if (start.node === segment.endNode && start.offset < segment.endOffset) {
            segment.endOffset += match.replacement.length - (end.offset - start.offset);
        }
        return;
    }

    const startValue = start.node.nodeValue || '';
    const endValue = end.node.nodeValue || '';
    start.node.nodeValue = startValue.slice(0, start.offset) + match.replacement;
    for (let index = start.nodeIndex + 1; index < end.nodeIndex; index++) {
        snapshot.ranges[index].node.nodeValue = '';
    }
    end.node.nodeValue = endValue.slice(end.offset);
    if (end.node === segment.endNode) segment.endOffset -= end.offset;
}

function applyStreamingMaskToRun(nodes, processors, scopedRanges = null) {
    const runSnapshot = buildNodeRangeSnapshot(nodes);
    const ranges = scopedRanges || [{ start: 0, end: runSnapshot.text.length }];
    const segments = ranges
        .map((range) => createStreamingSegment(nodes, runSnapshot, range))
        .filter(Boolean)
        .reverse();
    let changed = false;

    for (const segment of segments) {
        processors.forEach((processor, processorIndex) => {
            const snapshot = buildNodeRangeSnapshot(
                segment.nodes,
                segment.startNode,
                segment.startOffset,
                segment.endNode,
                segment.endOffset,
            );
            const matches = collectProcessorMatches(snapshot.text, processor, processorIndex);
            for (let index = matches.length - 1; index >= 0; index--) {
                replaceStreamingRange(segment, snapshot, matches[index]);
                changed = true;
            }
        });
    }
    return changed;
}

function projectStreamingScopeRanges(rawText) {
    const rawRanges = collectScopedReplacementRanges(rawText);
    return rawRanges
        .map((range) => ({
            start: stripStreamingWrapperTags(rawText.slice(0, range.start)).length,
            end: stripStreamingWrapperTags(rawText.slice(0, range.end)).length,
        }))
        .filter((range) => range.end > range.start);
}

function applyScopedStreamingRuns(runs, processors, scopedRanges) {
    let globalOffset = 0;
    let changed = false;

    for (const run of runs) {
        const runLength = run.reduce((length, node) => length + String(node?.nodeValue || '').length, 0);
        const runEnd = globalOffset + runLength;
        const localRanges = scopedRanges
            .map((range) => ({
                start: Math.max(range.start, globalOffset) - globalOffset,
                end: Math.min(range.end, runEnd) - globalOffset,
            }))
            .filter((range) => range.end > range.start);
        changed = applyStreamingMaskToRun(run, processors, localRanges) || changed;
        globalOffset = runEnd;
    }

    return changed;
}

export function applyStreamingVisualMask(surface, rawSource, cleanSource, options = {}) {
    if (!surface) return false;
    const runs = collectStreamingTextRuns(surface);
    const eligibleTextNodes = runs.flat();
    const rawText = String(rawSource || '');
    const cleanText = String(cleanSource || '');
    const currentVisibleText = eligibleTextNodes.map((node) => node.nodeValue || '').join('');
    const currentSurfaceText = collectStreamingSurfaceText(surface);
    const visibleRawText = stripStreamingWrapperTags(rawText);
    const visibleCleanText = stripStreamingWrapperTags(cleanText);
    if (visibleCleanText !== visibleRawText && currentSurfaceText === visibleCleanText) return false;
    if (options.requireSourceCorrespondence === true
        && currentSurfaceText !== visibleRawText
        && currentSurfaceText !== visibleCleanText) return false;

    const processors = buildProcessors({ includeAiRewrite: true });
    const streamingProcessors = processors.filter((processor) => (
        isStreamingVisualProcessorSafe(processor, {
            anchorsChangeSemantics: runs.length !== 1 || currentVisibleText !== visibleRawText,
        })
    ));

    if (eligibleTextNodes.length === 1 && streamingProcessors.length === processors.length) {
        const textNode = eligibleTextNodes[0];
        const currentText = textNode.nodeValue || '';
        const projectedText = resolveSingleNodeStreamingProjection(rawText, cleanText, currentText);
        if (projectedText !== null && projectedText !== currentText) {
            textNode.nodeValue = projectedText;
            return true;
        }
    }

    if (hasEnabledScopeTags()) {
        if (currentVisibleText !== visibleRawText) return false;
        return applyScopedStreamingRuns(runs, streamingProcessors, projectStreamingScopeRanges(rawText));
    }
    return runs.reduce((changed, run) => applyStreamingMaskToRun(run, streamingProcessors) || changed, false);
}

export function renderStreamingVisualMask(messageId, committedRawText, options = {}) {
    const index = Number(messageId);
    if (!Number.isInteger(index) || index < 0 || runtimeState.isStreamingGeneration !== true) return false;

    const messageNode = getMessageDomNode(index);
    if (!messageNode || isRevertedMessageDomNode(messageNode) || isManualFinalMessageDomNode(messageNode)) return false;
    const surface = findTavernHelperStreamingSurface(messageNode) || messageNode.querySelector?.('.mes_text');
    const rawText = String(committedRawText || '');
    return applyStreamingVisualMask(surface, rawText, applyVisualMask(rawText), options);
}

export function replayStreamingVisualMask(messageId) {
    const index = Number(messageId);
    if (!runtimeState.streamingCommittedMessageCache.has(index)) return false;
    return renderStreamingVisualMask(index, runtimeState.streamingCommittedMessageCache.get(index), {
        requireSourceCorrespondence: true,
    });
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

function removeSnapshotIdentifiers(root) {
    if (!root?.removeAttribute) return;
    root.removeAttribute('id');
    root.querySelectorAll?.('[id]').forEach((node) => node.removeAttribute('id'));
    ['mesid', 'data-mesid', 'messageid', 'data-message-id'].forEach((name) => root.removeAttribute(name));
}

/**
 * 在宿主渲染最终消息期间保留一份不可交互的旧消息视觉快照。
 * 真实消息节点保持布局但不可见，宿主和其他插件可在其上完成全部渲染；release 后才显示最终节点。
 * @param {number} index 消息索引。
 * @returns {{release: () => void}|null} 原子交换控制器。
 */
export function beginAtomicMessageDisplaySwap(index) {
    if (typeof document === 'undefined' || !document.body) return null;
    const messageNode = getMessageDomNode(index);
    if (!messageNode?.cloneNode || !messageNode.getBoundingClientRect) return null;

    const rect = messageNode.getBoundingClientRect();
    const snapshot = messageNode.cloneNode(true);
    removeSnapshotIdentifiers(snapshot);
    snapshot.setAttribute('data-blai-atomic-message-snapshot', 'true');
    snapshot.setAttribute('aria-hidden', 'true');
    if ('inert' in snapshot) snapshot.inert = true;

    const computed = typeof globalThis.getComputedStyle === 'function'
        ? globalThis.getComputedStyle(messageNode)
        : null;
    Object.assign(snapshot.style, {
        position: 'fixed',
        top: `${rect.top}px`,
        left: `${rect.left}px`,
        width: `${rect.width}px`,
        minHeight: `${rect.height}px`,
        boxSizing: 'border-box',
        margin: '0',
        pointerEvents: 'none',
        visibility: 'visible',
        zIndex: computed?.zIndex && computed.zIndex !== 'auto' ? computed.zIndex : '1',
    });

    const previousVisibility = messageNode.style.visibility;
    const previousMinHeight = messageNode.style.minHeight;
    messageNode.style.visibility = 'hidden';
    messageNode.style.minHeight = `${rect.height}px`;
    document.body.appendChild(snapshot);

    let released = false;
    return {
        release() {
            if (released) return;
            released = true;
            snapshot.remove?.();
            if (messageNode.isConnected !== false) {
                messageNode.style.visibility = previousVisibility;
                messageNode.style.minHeight = previousMinHeight;
            }
        },
    };
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
