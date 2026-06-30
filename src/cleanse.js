import { defaultDeepCleanTimeoutSec, extensionName, getAppContext, runtimeState } from './state.js';
import { logger } from './log.js';
import { applyScopedReplacements, buildProcessors } from './core.js';
import { showDeepCleanOverlay, updateDeepCleanOverlay } from './ui.js';
import { markHostChatDirtyFromIndex, runPreferredSaveChat } from './platform.js';

/**
 * 判断是否应跳过数据库扩展字段。
 * @param {string[]} [pathKeys=[]] 当前字段路径键列表。
 * @param {boolean} [isGlobalSettings=false] 是否处于全局设置扫描。
 * @returns {boolean} true 表示跳过该字段。
 */
export function shouldSkipDbExtensionField(pathKeys = [], isGlobalSettings = false) {
    if (!isGlobalSettings || pathKeys.length < 2) return false;
    const rootNamespace = String(pathKeys[0] || '');
    if (!rootNamespace.includes('shujuku_v120')) return false;
    const currentKey = String(pathKeys[pathKeys.length - 1] || '');
    return currentKey.includes('Prompt') || currentKey.includes('Settings') || currentKey.includes('Template');
}

function shouldSkipDbExtensionFieldByMeta(depth, rootNamespace, currentKey, isGlobalSettings = false) {
    if (!isGlobalSettings || depth < 2) return false;
    const rootNs = String(rootNamespace || '');
    if (!rootNs.includes('shujuku_v120')) return false;
    const key = String(currentKey || '');
    return key.includes('Prompt') || key.includes('Settings') || key.includes('Template');
}

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
 * 同步深度清理对象中的所有字符串字段。
 * @param {object} rootObj 待清理对象。
 * @returns {number} 命中并替换的字段数量。
 */
export function deepCleanObjectSync(rootObj) {
    if (!rootObj || typeof rootObj !== 'object') return 0;
    let changes = 0;
    const stack = [rootObj];
    const seen = new Set();

    while (stack.length > 0) {
        const current = stack.pop();
        if (!current || seen.has(current)) continue;
        seen.add(current);
        if (isRevertedMessageObject(current)) continue;

        for (let key in current) {
            if (!Object.prototype.hasOwnProperty.call(current, key)) continue;
            if (typeof key === 'string' && key.startsWith('__blai_')) continue;
            const val = current[key];
            if (typeof val === 'string') {
                const cleaned = applyScopedReplacements(val);
                if (cleaned !== val) {
                    current[key] = cleaned;
                    changes++;
                }
            } else if (val && typeof val === 'object') {
                stack.push(val);
            }
        }
    }
    return changes;
}

/**
 * 分片执行异步深度清理。
 * @param {object} rootObj 待清理对象根节点。
 * @param {boolean} [isGlobalSettings=false] 是否对全局设置执行清理。
 * @param {{onProgress?: Function, deadline?: number, getDeadline?: Function, onTimeout?: Function, completedChanges?: number}} [options={}] 进度回调与截止时间。
 * @returns {Promise<number>} 命中并替换的字段数量。
 */
export async function safeDeepScrub(rootObj, isGlobalSettings = false, options = {}) {
    let changes = 0;
    if (!rootObj || typeof rootObj !== 'object') return changes;
    const stack = [{ node: rootObj, depth: 0, rootNamespace: '' }];
    const seen = new Set();
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
            const shouldContinue = await onTimeout({ visited: seen.size, pending: stack.length, changes });
            if (shouldContinue === true) return;
            throw createDeepCleanCancelledError(completedChanges + changes, changes);
        }
        const err = new Error('DEEP_CLEAN_TIMEOUT');
        err.partialChanges = changes;
        err.totalChanges = completedChanges + changes;
        throw err;
    };

    while (stack.length > 0) {
        await assertWithinDeadline();

        if (++iterations % 500 === 0) {
            if (onProgress) onProgress({ visited: seen.size, pending: stack.length, changes });
            await new Promise(r => setTimeout(r, 0));
        }

        const currentItem = stack.pop();
        const current = currentItem?.node;
        const depth = currentItem?.depth || 0;
        const rootNamespace = currentItem?.rootNamespace || '';
        if (!current || seen.has(current)) continue;
        seen.add(current);
        if (isRevertedMessageObject(current)) continue;

        try {
            for (let key in current) {
                if (Object.prototype.hasOwnProperty.call(current, key)) {
                    if (isGlobalSettings && key === extensionName) continue;
                    if (typeof key === 'string' && key.startsWith('__blai_')) continue;
                    const nextDepth = depth + 1;
                    const nextRootNamespace = depth === 0 ? key : rootNamespace;
                    if (shouldSkipDbExtensionFieldByMeta(nextDepth, nextRootNamespace, key, isGlobalSettings)) continue;
                    const val = current[key];
                    if (typeof val === 'string') {
                        const cleaned = applyScopedReplacements(val);
                        if (val !== cleaned) {
                            current[key] = cleaned;
                            changes++;
                        }
                    } else if (val !== null && typeof val === 'object') {
                        stack.push({ node: val, depth: nextDepth, rootNamespace: nextRootNamespace });
                    }
                }
            }
        } catch (e) { }
    }

    if (onProgress) onProgress({ visited: seen.size, pending: stack.length, changes });
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
    const { chat, chat_metadata, extension_settings, saveSettingsDebounced } = getAppContext();
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
        if (chat && Array.isArray(chat)) phases.push({ label: '聊天记录', root: chat, isGlobalSettings: false });
        if (typeof chat_metadata === 'object' && chat_metadata !== null) phases.push({ label: '聊天元数据', root: chat_metadata, isGlobalSettings: false });
        if (typeof extension_settings === 'object' && extension_settings !== null) phases.push({ label: '插件设置', root: extension_settings, isGlobalSettings: true });
        if (typeof window.characters !== 'undefined' && Array.isArray(window.characters)) phases.push({ label: '角色卡', root: window.characters, isGlobalSettings: false });
        if (typeof window.world_info !== 'undefined' && window.world_info !== null) phases.push({ label: '世界书', root: window.world_info, isGlobalSettings: false });
        if (extension_settings?.[extensionName]?.protectPersonaDescription !== true && typeof window.power_user !== 'undefined' && window.power_user !== null && window.power_user.personas) {
            phases.push({ label: '人设', root: window.power_user.personas, isGlobalSettings: false });
        }

        for (let i = 0; i < phases.length; i++) {
            const phase = phases[i];
            logger.info(`深度清理阶段 ${i + 1}/${phases.length}: ${phase.label}`);
            const phaseBase = i / phases.length;
            const phaseSpan = 1 / phases.length;

            const phaseChanges = await safeDeepScrub(phase.root, phase.isGlobalSettings, {
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
