/**
 * Owns Chinese dictionary enable/install user actions and the installation UI lifecycle.
 * Dictionary package/storage semantics live in zh/dictionary.js; runtime conversion lives in zh/conversion.js.
 */
import { extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { markRulesDataDirty } from '../rules/state.js';
import { showToast } from '../ui/notifications.js';
import {
    closeLoadingOverlay,
    closeZhDictionaryModal,
    openZhDictionaryModal,
    showZhDictionaryInstallOverlay,
    updateZhDictionaryInstallOverlay,
} from './view.js';
import {
    downloadZhDictionaryPackage,
    getZhDictionaryPackageStats,
    getZhDictionaryPackageStatus,
    getZhVariantCompatOptions,
    isZhDictionaryReady,
    markZhDictionaryInstallFailed,
    restoreZhDictionaryPackageFromCache,
} from './dictionary.js';

let zhDictionaryInstallAbortController = null;

export function bindZhEvents() {
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const settings = extension_settings[extensionName];
    const syncZhCompatToggle = () => {
        const packageStatus = getZhDictionaryPackageStatus(settings);
        const ready = settings.zhVariantCompatEnabled === true
            ? isZhDictionaryReady(settings)
            : packageStatus.ready;
        if (settings.zhVariantCompatEnabled === true && !ready) {
            settings.zhVariantCompatEnabled = false;
        }
        const enabled = settings.zhVariantCompatEnabled === true && ready;
        const options = getZhVariantCompatOptions(settings);
        const regionText = [
            options.tw ? '台繁' : '',
            options.hk ? '港繁' : '',
        ].filter(Boolean).join('、') || '标准简繁';
        $('#blai-zh-dict-status-chip').text(enabled ? '已启用' : packageStatus.ready ? '已安装' : '未安装');
        $('#blai-zh-dict-install-open')
            .attr('aria-pressed', String(enabled))
            .text(enabled ? '停用简繁转换' : packageStatus.ready ? '启用简繁转换' : '下载并安装字典')
            .attr('title', enabled
                ? `简繁兼容已开启：${regionText} 变体参与匹配（点击关闭）`
                : packageStatus.ready
                    ? `简繁兼容已关闭：已安装增强词典，点击启用 ${regionText} 匹配`
                    : '简繁兼容未安装：点击下载 OpenCC 增强词典包');
    };
    const enableVerifiedZhCompat = (toastMessage = '简繁兼容已开启') => {
        if (!restoreZhDictionaryPackageFromCache(settings)) return false;
        settings.zhVariantCompatEnabled = true;
        markRulesDataDirty({ rulesUi: false });
        saveSettingsDebounced();
        syncZhCompatToggle();
        showToast(toastMessage);
        return true;
    };
    const openZhDictionaryInstallPrompt = () => {
        const stats = getZhDictionaryPackageStats();
        openZhDictionaryModal(stats, getZhVariantCompatOptions(settings));
    };
    const runZhDictionaryInstall = async () => {
        if (zhDictionaryInstallAbortController) return;
        settings.zhVariantCompatOptions = {
            tw: $('#blai-zh-dict-tw').prop('checked') === true,
            hk: $('#blai-zh-dict-hk').prop('checked') === true,
        };
        settings.zhVariantCompatEnabled = false;
        saveSettingsDebounced();
        closeZhDictionaryModal();

        zhDictionaryInstallAbortController = new AbortController();
        showZhDictionaryInstallOverlay(() => {
            zhDictionaryInstallAbortController?.abort();
        });

        try {
            await downloadZhDictionaryPackage({
                signal: zhDictionaryInstallAbortController.signal,
                onProgress: ({ ratio, statusText }) => updateZhDictionaryInstallOverlay(ratio, statusText),
            });
            settings.zhVariantCompatEnabled = true;
            markRulesDataDirty({ rulesUi: false });
            saveSettingsDebounced();
            syncZhCompatToggle();
            showToast('增强简繁词典已安装并启用');
        } catch (error) {
            const message = markZhDictionaryInstallFailed(error);
            settings.zhVariantCompatEnabled = false;
            markRulesDataDirty({ rulesUi: false });
            saveSettingsDebounced();
            syncZhCompatToggle();
            if (error?.name === 'AbortError') showToast('已取消词典下载');
            else showToast(`词典安装失败：${message}`);
        } finally {
            zhDictionaryInstallAbortController = null;
            window.setTimeout(() => closeLoadingOverlay(), 260);
        }
    };

    syncZhCompatToggle();

    $(document).off('click', '#blai-zh-dict-install-open').on('click', '#blai-zh-dict-install-open', function(e) {
        e.preventDefault();
        if (settings.zhVariantCompatEnabled === true && isZhDictionaryReady(settings)) {
            settings.zhVariantCompatEnabled = false;
            markRulesDataDirty({ rulesUi: false });
            saveSettingsDebounced();
            syncZhCompatToggle();
            showToast('简繁兼容已关闭');
            return;
        }
        if (enableVerifiedZhCompat()) return;
        openZhDictionaryInstallPrompt();
    });

    $(document).off('click', '#blai-zh-dict-close, #blai-zh-dict-cancel').on('click', '#blai-zh-dict-close, #blai-zh-dict-cancel', function(e) {
        e.preventDefault();
        closeZhDictionaryModal();
    });

    $(document).off('click', '#blai-zh-dict-download').on('click', '#blai-zh-dict-download', function(e) {
        e.preventDefault();
        runZhDictionaryInstall();
    });
}
