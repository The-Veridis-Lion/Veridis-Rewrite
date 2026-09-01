/**
 * Owns Chinese dictionary installation/modal DOM projection only. It does not own dictionary download/storage semantics.
 */
import { zhRuntimeState } from './state.js';

function showProgressOverlay({ title, statusText, cancelText = '停止', onCancel = null }) {
    const themeMode = String($('#blai-purifier-popup').attr('data-theme') || 'auto');
    $('#blai-loading-overlay').remove();
    $('body').append(`
        <div id="blai-loading-overlay" class="blai-loading-overlay" data-theme="${themeMode}" data-tt-mobile-surface="backdrop">
            <div class="blai-loading-panel" data-tt-mobile-surface="fullscreen-window" role="dialog" aria-modal="true" aria-labelledby="blai-loading-title">
                <div class="blai-loading-head">
                    <h2 id="blai-loading-title" class="blai-loading-title"><i class="fas fa-spinner fa-spin"></i> ${title}</h2>
                    <button id="blai-loading-cancel" type="button" class="blai-loading-cancel" title="${cancelText}">${cancelText}</button>
                </div>
                <p id="blai-loading-status">${statusText}</p>
                <div class="blai-progress-track"><div id="blai-progress-fill" class="blai-progress-fill"></div></div>
                <p id="blai-progress-percent" class="blai-progress-percent">0%</p>
            </div>
        </div>
    `);
    if (typeof onCancel === 'function') {
        $('#blai-loading-cancel').off('click').on('click', onCancel);
    }
}

export function showZhDictionaryInstallOverlay(onCancel) {
    zhRuntimeState.zhDictionaryInstallCancelRequested = false;
    showProgressOverlay({
        title: '正在安装增强简繁词典',
        statusText: '正在初始化下载任务。',
        cancelText: '取消',
        onCancel: () => {
            zhRuntimeState.zhDictionaryInstallCancelRequested = true;
            $('#blai-loading-cancel')
                .prop('disabled', true)
                .addClass('is-disabled')
                .text('取消中');
            $('#blai-loading-status').text('正在取消下载，请等待当前请求结束。');
            if (typeof onCancel === 'function') onCancel();
        },
    });
}

export function closeLoadingOverlay() {
    $('#blai-loading-overlay').remove();
}

export function updateZhDictionaryInstallOverlay(progressRatio, statusText) {
    updateProgressOverlay(progressRatio, statusText);
}

export function openZhDictionaryModal(stats = {}, options = {}) {
    const themeMode = String($('#blai-purifier-popup').attr('data-theme') || 'auto');
    const bytes = Number(stats.bytes) || 0;
    const mb = bytes > 0 ? (bytes / 1024 / 1024).toFixed(2) : '1.20';
    const entries = Number(stats.entries) || 0;
    $('#blai-zh-dictionary-modal')
        .attr('data-theme', themeMode)
        .css('display', 'flex');
    $('#blai-zh-dict-stats').text(`词典包约 ${mb} MB，包含 ${entries.toLocaleString('zh-CN')} 条字词与异体映射。`);
    $('#blai-zh-dict-tw').prop('checked', options.tw !== false);
    $('#blai-zh-dict-hk').prop('checked', options.hk !== false);
}

export function closeZhDictionaryModal() {
    $('#blai-zh-dictionary-modal').fadeOut(120);
}

function updateProgressOverlay(progressRatio, statusText) {
    const ratio = Math.max(0, Math.min(1, Number(progressRatio) || 0));
    $('#blai-progress-fill').css('width', `${Math.round(ratio * 100)}%`);
    $('#blai-progress-percent').text(`${Math.round(ratio * 100)}%`);
    if (statusText) $('#blai-loading-status').text(statusText);
}
