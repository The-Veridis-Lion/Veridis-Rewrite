/** Owns rendered message-node identity and atomic visual message swapping. It does not own message data mutation, Diff state, or persistence. */

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
