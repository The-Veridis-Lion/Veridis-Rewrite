/** Owns Veridis interpretation of the existing MVU extra-model transaction contract used by host finalization. */
import { getAppContext } from '../host/appContext.js';
import { logger } from '../log.js';
import { getGlobalObject, getSillyTavernContextSnapshot } from '../host/context.js';
import { getTavernHelperGlobalApi } from './tavernHelper.js';

const minMvuToolCallingTavernHelperVersion = [4, 8, 4];
const mvuExtraModelLorebookEntryPattern = /\[mvu_(?:update|plot)\]/i;

function getMvuGlobalApi() {
    const root = getGlobalObject();
    if (root?.Mvu && typeof root.Mvu === 'object') return root.Mvu;
    try {
        const parentApi = root?.parent?.Mvu;
        if (parentApi && typeof parentApi === 'object') return parentApi;
    } catch {
        // Cross-window access can fail outside the SillyTavern host.
    }
    return null;
}

export function getMvuIntegrationSignal() {
    return getMvuGlobalApi() ? 'detected' : 'not_detected';
}

function isVersionAtLeast(version, minimum) {
    const match = String(version || '').match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return true;
    const current = match.slice(1, 4).map(Number);
    for (let index = 0; index < minimum.length; index++) {
        if (current[index] > minimum[index]) return true;
        if (current[index] < minimum[index]) return false;
    }
    return true;
}

function isMvuToolCallingSupported(settings, tavernHelper) {
    if (settings?.['额外模型解析配置']?.['应答格式'] !== '工具调用') return true;

    try {
        const version = tavernHelper?.getTavernHelperVersion?.();
        if (!isVersionAtLeast(version, minMvuToolCallingTavernHelperVersion)) return false;
    } catch {
        return false;
    }

    const context = getSillyTavernContextSnapshot();
    const supportCheck = context?.isToolCallingSupported
        || context?.ToolManager?.isToolCallingSupported;
    if (typeof supportCheck !== 'function') return false;
    try {
        return Boolean(supportCheck.call(context?.ToolManager || context));
    } catch {
        return false;
    }
}

export function getMvuExtraModelTransaction() {
    const settings = getAppContext()?.extension_settings?.mvu_settings;
    const api = getMvuGlobalApi();
    const enabled = Boolean(
        settings?.['更新方式'] === '额外模型解析'
        && settings?.['额外模型解析配置']?.['启用自动请求'] !== false,
    );
    return {
        enabled,
        api,
        beforeMessageUpdateEvent: String(api?.events?.BEFORE_MESSAGE_UPDATE || 'mag_before_message_update'),
    };
}

export async function shouldWaitForMvuExtraModelTransaction(messageIndex) {
    const transaction = getMvuExtraModelTransaction();
    if (!transaction.enabled) return false;

    const { chat } = getAppContext();
    if (!Array.isArray(chat) || chat.length <= 1) return false;
    const index = Number(messageIndex);
    if (!Number.isInteger(index) || index < 0 || index >= chat.length) return false;

    const settings = getAppContext()?.extension_settings?.mvu_settings;
    const tavernHelper = getTavernHelperGlobalApi();
    if (!isMvuToolCallingSupported(settings, tavernHelper)) return false;
    if (typeof tavernHelper?.getCurrentCharPrimaryLorebook !== 'function'
        || typeof tavernHelper?.getLorebookEntries !== 'function') {
        return false;
    }

    try {
        const lorebookName = await tavernHelper.getCurrentCharPrimaryLorebook();
        if (!lorebookName) return false;
        const entries = await tavernHelper.getLorebookEntries(lorebookName);
        return Array.isArray(entries) && entries.some(entry => (
            mvuExtraModelLorebookEntryPattern.test(String(entry?.comment || ''))
        ));
    } catch (error) {
        logger.warn('读取 MVU 额外模型解析适配状态失败', error);
        return false;
    }
}
