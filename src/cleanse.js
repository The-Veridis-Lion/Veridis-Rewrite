import { defaultDeepCleanTimeoutSec, extensionName, getAppContext, runtimeState } from './state.js';
import { logger } from './log.js';
import { applyScopedReplacements, buildProcessors } from './core.js';
import { showDeepCleanOverlay, updateDeepCleanOverlay } from './ui.js';
import { markHostChatDirtyFromIndex, runPreferredSaveChat } from './platform.js';

function isRevertedMessageObject(value) {
    return !!(value && typeof value === 'object' && value.__blai_is_reverted === true);
}

function createDeepCleanCancelledError(totalChanges = 0, partialChanges = 0) {
    const err = new Error('DEEP_CLEAN_CANCELLED');
    err.partialChanges = partialChanges;
    err.totalChanges = totalChanges;
    return err;
}

/**
 * 按数据类型 allowlist 同步清理明确的用户内容字段。
 * @param {object} rootObj 待清理对象。
 * @param {{scope?: 'chat'|'characters'|'world-info'|'personas', transform?: Function}} [options={}] 数据范围与替换函数。
 * @returns {number} 命中并替换的字段数量。
 */
function collectDeepCleanSlots(rootObj, scope = 'chat') {
    const slots = [];
    const addSlot = (owner, key, path) => {
        if (owner && typeof owner[key] === 'string') slots.push({ owner, key, path });
    };

    if (scope === 'chat') {
        const messages = Array.isArray(rootObj) ? rootObj : [rootObj];
        messages.forEach((message, messageIndex) => {
            if (!message || typeof message !== 'object' || isRevertedMessageObject(message)) return;
            addSlot(message, 'mes', `[${messageIndex}].mes`);
            if (!Array.isArray(message.swipes)) return;
            message.swipes.forEach((swipe, swipeIndex) => {
                if (typeof swipe === 'string') addSlot(message.swipes, swipeIndex, `[${messageIndex}].swipes[${swipeIndex}]`);
                else if (swipe && typeof swipe === 'object') addSlot(swipe, 'mes', `[${messageIndex}].swipes[${swipeIndex}].mes`);
            });
        });
        return slots;
    }

    if (scope === 'characters') {
        const characters = Array.isArray(rootObj) ? rootObj : [];
        const fields = ['description', 'personality', 'scenario', 'first_mes'];
        characters.forEach((character, index) => {
            if (!character || typeof character !== 'object') return;
            fields.forEach((field) => addSlot(character, field, `[${index}].${field}`));
            if (Array.isArray(character.alternate_greetings)) {
                character.alternate_greetings.forEach((_, greetingIndex) => addSlot(character.alternate_greetings, greetingIndex, `[${index}].alternate_greetings[${greetingIndex}]`));
            }
        });
        return slots;
    }

    if (scope === 'world-info') {
        const entryContainer = rootObj?.entries ?? rootObj;
        const entries = Array.isArray(entryContainer)
            ? entryContainer
            : entryContainer && typeof entryContainer === 'object'
                ? Object.values(entryContainer)
                : [];
        entries.forEach((entry, index) => {
            if (entry && typeof entry === 'object') addSlot(entry, 'content', `entries[${index}].content`);
        });
        return slots;
    }

    if (scope === 'personas') {
        if (!rootObj || typeof rootObj !== 'object') return slots;
        Object.entries(rootObj).forEach(([key, persona]) => {
            if (typeof persona === 'string') addSlot(rootObj, key, `personas.${key}`);
            else if (persona && typeof persona === 'object') addSlot(persona, 'description', `personas.${key}.description`);
        });
    }
    return slots;
}

export function deepCleanObjectSync(rootObj, options = {}) {
    if (!rootObj || typeof rootObj !== 'object') return 0;
    const scope = String(options.scope || 'chat');
    const transform = typeof options.transform === 'function' ? options.transform : applyScopedReplacements;
    let changes = 0;
    for (const slot of collectDeepCleanSlots(rootObj, scope)) {
        const value = slot.owner[slot.key];
        const cleaned = transform(value);
        if (cleaned !== value) {
            slot.owner[slot.key] = cleaned;
            changes++;
        }
    }
    return changes;
}

/**
 * 分片执行异步深度清理。
 * @param {object} rootObj 待清理对象根节点。
 * @param {'chat'|'characters'|'world-info'|'personas'} [scope='chat'] 明确的数据范围。
 * @param {{onProgress?: Function, deadline?: number, getDeadline?: Function, onTimeout?: Function, completedChanges?: number}} [options={}] 进度回调与截止时间。
 * @returns {Promise<number>} 命中并替换的字段数量。
 */
export async function safeDeepScrub(rootObj, scope = 'chat', options = {}) {
    let changes = 0;
    if (!rootObj || typeof rootObj !== 'object') return changes;
    const slots = collectDeepCleanSlots(rootObj, String(scope || 'chat'));
    buildProcessors();

    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const staticDeadline = Number.isFinite(options.deadline) ? options.deadline : Infinity;
    const getDeadline = typeof options.getDeadline === 'function' ? options.getDeadline : () => staticDeadline;
    const onTimeout = typeof options.onTimeout === 'function' ? options.onTimeout : null;
    const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : null;
    const completedChanges = Number.isFinite(Number(options.completedChanges)) ? Number(options.completedChanges) : 0;
    let iterations = 0;

    const assertWithinDeadline = async () => {
        if (shouldCancel && shouldCancel()) {
            throw createDeepCleanCancelledError(completedChanges + changes, changes);
        }
        const deadline = Number(getDeadline());
        if (!Number.isFinite(deadline) || Date.now() <= deadline) return;
        if (onTimeout) {
            const shouldContinue = await onTimeout({ visited: iterations, pending: Math.max(0, slots.length - iterations), changes });
            if (shouldContinue === true) return;
            throw createDeepCleanCancelledError(completedChanges + changes, changes);
        }
        const err = new Error('DEEP_CLEAN_TIMEOUT');
        err.partialChanges = changes;
        err.totalChanges = completedChanges + changes;
        throw err;
    };

    for (const slot of slots) {
        await assertWithinDeadline();

        if (++iterations % 500 === 0) {
            if (onProgress) onProgress({ visited: iterations, pending: Math.max(0, slots.length - iterations), changes });
            await new Promise(r => setTimeout(r, 0));
        }
        try {
            const value = slot.owner[slot.key];
            const cleaned = applyScopedReplacements(value);
            if (value !== cleaned) {
                slot.owner[slot.key] = cleaned;
                changes++;
            }
        } catch (e) { }
    }

    if (onProgress) onProgress({ visited: slots.length, pending: 0, changes });
    return changes;
}

/**
 * 获取深度清理超时时间。
 * @returns {number} 超时毫秒值。
 */
export function getDeepCleanTimeoutMs() {
    return defaultDeepCleanTimeoutSec * 1000;
}

/**
 * 执行全域深度清理流程。
 * @returns {Promise<void>}
 */
export async function performDeepCleanse() {
    logger.info('[performDeepCleanse] 深度清理开始');
    const { chat, extension_settings, saveSettingsDebounced } = getAppContext();
    buildProcessors();
    if (runtimeState.activeProcessors.length === 0) {
        alert('没有开启的屏蔽规则，无需清理。');
        return;
    }

    runtimeState.deepCleanCancelRequested = false;
    showDeepCleanOverlay();
    await new Promise(r => setTimeout(r, 100));

    try {
        let scrubbedItems = 0;
        const timeoutMs = getDeepCleanTimeoutMs();
        const timeoutSec = Math.round(timeoutMs / 1000);
        const startAt = Date.now();
        let deadline = startAt + timeoutMs;
        let continueCount = 0;

        const phases = [];
        if (chat && Array.isArray(chat)) phases.push({ label: '聊天记录', root: chat, scope: 'chat' });
        if (typeof window.characters !== 'undefined' && Array.isArray(window.characters)) phases.push({ label: '角色卡', root: window.characters, scope: 'characters' });
        if (typeof window.world_info !== 'undefined' && window.world_info !== null) phases.push({ label: '世界书', root: window.world_info, scope: 'world-info' });
        if (extension_settings?.[extensionName]?.protectPersonaDescription !== true && typeof window.power_user !== 'undefined' && window.power_user !== null && window.power_user.personas) {
            phases.push({ label: '人设', root: window.power_user.personas, scope: 'personas' });
        }
        logger.info('深度清理已跳过聊天 metadata、插件设置和未知扩展字段。');

        for (let i = 0; i < phases.length; i++) {
            const phase = phases[i];
            logger.info(`深度清理阶段 ${i + 1}/${phases.length}: ${phase.label}`);
            const phaseBase = i / phases.length;
            const phaseSpan = 1 / phases.length;

            const phaseChanges = await safeDeepScrub(phase.root, phase.scope, {
                completedChanges: scrubbedItems,
                getDeadline: () => deadline,
                shouldCancel: () => runtimeState.deepCleanCancelRequested === true,
                onTimeout: async ({ visited, pending, changes }) => {
                    const elapsed = Math.round((Date.now() - startAt) / 1000);
                    updateDeepCleanOverlay(
                        phaseBase + phaseSpan * 0.5,
                        `已清理 ${elapsed}s，正在等待是否继续（${phase.label}：已扫描 ${visited}，剩余队列 ${pending}，命中 ${changes}）`
                    );
                    await new Promise(r => setTimeout(r, 60));
                    const shouldContinue = confirm(`深度清理已运行 ${elapsed}s，本轮 ${timeoutSec}s 已到。\n\n当前阶段：${phase.label}\n已扫描：${visited}\n剩余队列：${pending}\n当前阶段命中：${changes}\n\n是否继续再清理 ${timeoutSec}s？\n点击“取消”会停止任务，并保留已完成的处理。`);
                    if (!shouldContinue) return false;
                    continueCount++;
                    deadline = Date.now() + timeoutMs;
                    updateDeepCleanOverlay(
                        phaseBase + phaseSpan * 0.5,
                        `继续清理 ${phase.label}，第 ${continueCount + 1} 轮确认窗口已开始...`
                    );
                    await new Promise(r => setTimeout(r, 60));
                    return true;
                },
                onProgress: ({ visited, pending, changes }) => {
                    const elapsed = ((Date.now() - startAt) / 1000).toFixed(1);
                    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
                    const dynamic = (visited + pending > 0) ? (visited / (visited + pending)) : 0;
                    updateDeepCleanOverlay(
                        phaseBase + dynamic * phaseSpan,
                        `正在清理 ${phase.label}（已扫描 ${visited}，剩余队列 ${pending}，命中 ${changes}）｜耗时 ${elapsed}s / 距下次确认约 ${remaining}s`
                    );
                }
            });
            scrubbedItems += phaseChanges;
            if (phase.root === chat && phaseChanges > 0) markHostChatDirtyFromIndex(0);

            updateDeepCleanOverlay((i + 1) / phases.length, `已完成 ${phase.label}，准备进入下一阶段...`);
        }

        if (runtimeState.deepCleanCancelRequested === true) {
            throw createDeepCleanCancelledError(scrubbedItems, 0);
        }
        updateDeepCleanOverlay(0.97, '正在同步数据到磁盘，请稍候。');

        if (scrubbedItems > 0) {
            await runPreferredSaveChat();

            saveSettingsDebounced();
            const remainingMs = Math.max(300, Math.min(2000, deadline - Date.now()));
            await new Promise(r => setTimeout(r, remainingMs));

            updateDeepCleanOverlay(1, '清理完成，正在准备刷新页面...');
            await new Promise(r => setTimeout(r, 180));
            $('#blai-loading-overlay').remove();

            alert(`清理完成，共处理 ${scrubbedItems} 处匹配项。\n\n页面即将刷新，请在刷新后将系统预设切换回常用预设！`);
            location.reload();
        } else {
            updateDeepCleanOverlay(1, '未发现残留，任务结束。');
            await new Promise(r => setTimeout(r, 260));
            $('#blai-loading-overlay').remove();
            alert('未发现需要替换的数据残留。');
        }
    } catch (e) {
        logger.error(`深度清理出错`, e);
        $('#blai-loading-overlay').remove();
        if (e && e.message === 'DEEP_CLEAN_CANCELLED') {
            const totalChanges = Number.isFinite(Number(e.totalChanges)) ? Number(e.totalChanges) : 0;
            alert(`深度清理已停止，已处理 ${totalChanges} 处匹配项。\n已完成的处理会保留在当前页面内；如不想保留，请刷新页面后再操作。`);
        } else if (e && e.message === 'DEEP_CLEAN_TIMEOUT') {
            const timeoutSec = Math.round(getDeepCleanTimeoutMs() / 1000);
            alert(`清理超时（${timeoutSec}s）已自动中止。`);
        } else {
            alert('清理失败，请查看控制台。');
        }
    } finally {
        runtimeState.deepCleanCancelRequested = false;
    }
}
