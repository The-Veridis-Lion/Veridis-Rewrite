// Owns transient toast and shared risk-dialog presentation only, not their business decisions.
export function showToast(message, description) {
    $('.blai-toast').remove();
    const themeMode = String($('#blai-purifier-popup').attr('data-theme') || 'auto');
    // 替换为 100% 兼容的 fas fa-exclamation-circle 图标
    const $toast = $(`<div class="blai-toast" data-theme="${themeMode}" data-tt-mobile-surface="free-window" role="status" aria-live="polite"><i class="fas fa-exclamation-circle"></i><span class="blai-toast-text"></span></div>`);
    $toast.find('.blai-toast-text').text(String(message || ''));
    const hasDescription = description !== undefined && description !== null && String(description);
    if (hasDescription) {
        const $content = $('<div class="blai-toast-content"></div>');
        const $title = $toast.find('.blai-toast-text').detach().addClass('blai-toast-title');
        const $description = $('<span class="blai-toast-description"></span>').text(String(description));
        $content.append($title, $description);
        $toast.append($content);
    }
    $('body').append($toast);
    setTimeout(() => $toast.addClass('blai-show'), 10);
    setTimeout(() => {
        $toast.removeClass('blai-show');
        setTimeout(() => $toast.remove(), 300);
    }, hasDescription ? 6000 : 2000);
}

export function showRiskConfirmModal(message) {
    return new Promise((resolve) => {
        const $modal = $('#blai-risk-confirm-modal');
        const finish = (confirmed) => {
            $modal.hide().attr('aria-hidden', 'true');
            $('#blai-risk-confirm-cancel, #blai-risk-confirm-ok').off('.blaiRiskConfirm');
            $modal.off('.blaiRiskConfirm');
            resolve(confirmed);
        };

        $('#blai-risk-confirm-text').text(String(message || ''));
        $modal.css('display', 'flex').attr('aria-hidden', 'false');
        $('#blai-risk-confirm-cancel').on('click.blaiRiskConfirm', () => finish(false));
        $('#blai-risk-confirm-ok').on('click.blaiRiskConfirm', () => finish(true));
        $modal.on('click.blaiRiskConfirm', (event) => {
            if (event.target === $modal[0]) finish(false);
        });
    });
}

export function showRiskInfoModal(message) {
    const $modal = $('#blai-risk-info-modal');
    const close = () => {
        $modal.hide().attr('aria-hidden', 'true');
        $('#blai-risk-info-close').off('.blaiRiskInfo');
        $modal.off('.blaiRiskInfo');
    };

    $('#blai-risk-info-text').text(String(message || ''));
    $modal.css('display', 'flex').attr('aria-hidden', 'false');
    $('#blai-risk-info-close').on('click.blaiRiskInfo', close).trigger('focus');
    $modal.on('click.blaiRiskInfo', (event) => {
        if (event.target === $modal[0]) close();
    });
}
