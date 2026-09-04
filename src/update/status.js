// Owns Veridis update-status derivation and its Tools/Feedback projections.
import { getAppContext } from '../host/appContext.js';
import { logger } from '../log.js';

const extensionFolderName = 'Veridis-Rewrite';
const remoteManifestRepository = 'The-Veridis-Lion/Veridis-Rewrite';

let updateState = null;
let updateInFlight = false;

function makeElement(tagName, className, text = '') {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
}

function releaseNoteItems(note) {
    return String(note || '').split(/[；;]/).map((item) => item.trim()).filter(Boolean);
}

function appendStatusRow(container, version, status, statusClass = '') {
    const row = makeElement('div', 'blai-tools-version-status-row');
    const current = makeElement('div', 'blai-tools-version-current');
    current.append(makeElement('span', 'blai-tools-version-label', '当前版本'));
    current.append(makeElement('strong', 'blai-tools-version-value', `v${version}`));
    row.append(current);
    row.append(makeElement('p', `blai-tools-version-status ${statusClass}`.trim(), status));
    container.append(row);
}

function appendReleaseItems(container, items) {
    const normalizedItems = items.map((item) => String(item || '').trim()).filter(Boolean);
    if (!normalizedItems.length) return;
    const list = makeElement('ul', 'blai-tools-version-note-list');
    normalizedItems.forEach((item) => list.append(makeElement('li', '', item)));
    container.append(list);
}

function appendReleaseNotes(container, note) {
    appendReleaseItems(container, releaseNoteItems(note));
}

function appendUpdateAction(container) {
    const action = makeElement('button', 'blai-tools-version-update-action', '更新并刷新');
    action.type = 'button';
    action.dataset.updateAction = 'update';
    container.append(action);
    const error = makeElement('p', 'blai-tools-version-error');
    error.id = 'blai-tools-version-error';
    error.hidden = true;
    container.append(error);
}

function projectToolsVersion(message = '正在检查版本信息…') {
    const content = document.getElementById('blai-tools-version-content');
    if (!content) return;
    content.replaceChildren();

    if (!updateState) {
        content.append(makeElement('p', 'blai-tools-version-status', message));
        return;
    }

    const details = makeElement('div', 'blai-tools-version-details');
    const body = makeElement('div', 'blai-tools-version-body');
    if (updateState.kind === 'latest') {
        appendStatusRow(details, updateState.localVersion, '已是最新版本', 'is-latest');
        appendReleaseNotes(body, updateState.updateNote);
    } else {
        if (updateState.kind === 'formal') {
            appendStatusRow(details, updateState.localVersion, `检测到新版本 v${updateState.remoteVersion}`, 'is-update');
            appendReleaseNotes(body, updateState.updateNote);
        } else {
            appendStatusRow(details, updateState.localVersion, '检测到小型修复更新', 'is-update');
            body.append(makeElement('p', 'blai-tools-version-minor-copy', '本次更新包含一些小问题修复与细节调整。'));
        }
        appendUpdateAction(body);
    }

    details.append(body);
    content.append(details);
}

export function projectFeedbackUpdateWarning() {
    const form = document.getElementById('blai-feedback-form');
    if (!form) return;
    form.querySelector('.blai-feedback-update-warning')?.remove();
    if (!updateState || updateState.kind === 'latest') return;

    const warning = makeElement('p', 'blai-feedback-update-warning', '当前版本不是最新版本哦。建议先更新到最新版，如果问题仍然存在，再来反馈哦～');
    warning.setAttribute('role', 'note');
    form.prepend(warning);
}

function projectUpdateSurfaces() {
    projectToolsVersion();
    projectFeedbackUpdateWarning();
}

async function readRemoteManifest(branchName) {
    const branch = String(branchName || '').trim();
    if (!branch) throw new Error('SillyTavern version response did not provide currentBranchName.');
    const response = await fetch(`https://raw.githubusercontent.com/${remoteManifestRepository}/${encodeURIComponent(branch)}/manifest.json`, {
        cache: 'no-store',
    });
    if (!response.ok) throw new Error(`Remote manifest request returned HTTP ${response.status}.`);
    return await response.json();
}

export async function initializeUpdateStatus({ versionInfo, isGlobal } = {}) {
    updateState = null;
    updateInFlight = false;
    projectUpdateSurfaces();
    if (!versionInfo || typeof versionInfo !== 'object') {
        logger.error('[Veridis Update] The SillyTavern version response is unavailable; update status will remain hidden.');
        projectToolsVersion('暂时无法确认版本状态。');
        return;
    }

    if (versionInfo.isUpToDate === true) {
        try {
            const appContext = getAppContext();
            const localManifest = await appContext.readExtensionManifest(appContext.veridisExternalId);
            const localVersion = String(localManifest?.version || '').trim();
            if (!localVersion) {
                logger.error('[Veridis Update] Local manifest does not provide a version; update status will remain hidden.');
                projectToolsVersion('暂时无法确认版本状态。');
                return;
            }
            updateState = {
                kind: 'latest',
                localVersion,
                updateNote: String(localManifest?.update_note || '').trim(),
                isGlobal: isGlobal === true,
            };
            projectUpdateSurfaces();
        } catch (error) {
            logger.error('[Veridis Update] Failed to read the local manifest; update status will remain hidden.', error);
            projectToolsVersion('暂时无法确认版本状态。');
        }
        return;
    }

    if (versionInfo.isUpToDate !== false) {
        logger.error('[Veridis Update] SillyTavern version response did not provide isUpToDate; update status will remain hidden.');
        projectToolsVersion('暂时无法确认版本状态。');
        return;
    }

    const appContext = getAppContext();
    let localManifest;
    try {
        localManifest = await appContext.readExtensionManifest(appContext.veridisExternalId);
    } catch (error) {
        logger.error('[Veridis Update] Failed to read the local manifest; update status will remain hidden.', error);
        projectToolsVersion('暂时无法确认版本状态。');
        return;
    }

    let remoteManifest;
    try {
        remoteManifest = await readRemoteManifest(versionInfo.currentBranchName);
    } catch (error) {
        logger.error('[Veridis Update] Failed to retrieve or parse the remote manifest; update status will remain hidden.', error);
        projectToolsVersion('暂时无法确认版本状态。');
        return;
    }

    const localVersion = String(localManifest?.version || '').trim();
    const remoteVersion = String(remoteManifest?.version || '').trim();
    if (!localVersion || !remoteVersion) {
        logger.error('[Veridis Update] Local or remote manifest does not provide a version; update status will remain hidden.');
        projectToolsVersion('暂时无法确认版本状态。');
        return;
    }
    if (remoteVersion !== localVersion) {
        const updateNote = String(remoteManifest?.update_note || '').trim();
        if (!updateNote) logger.warn('[Veridis Update] Formal remote version update has no update_note metadata.');
        updateState = { kind: 'formal', localVersion, remoteVersion, updateNote, isGlobal: isGlobal === true };
    } else {
        updateState = { kind: 'minor', localVersion, remoteVersion, isGlobal: isGlobal === true };
    }
    projectUpdateSurfaces();
}

async function updateAndReload() {
    if (updateInFlight || !updateState || updateState.kind === 'latest') return;
    const context = getAppContext().getSillyTavernContext?.();
    const getRequestHeaders = context?.getRequestHeaders;
    const $button = $('#blai-tools-version-section [data-update-action="update"]');
    if (typeof getRequestHeaders !== 'function') {
        const error = new Error('SillyTavern request headers are unavailable.');
        logger.error('[Veridis Update] Extension update failed.', error);
        $('#blai-tools-version-error').text(error.message).prop('hidden', false);
        return;
    }

    updateInFlight = true;
    $button.prop('disabled', true).text('正在更新…');
    try {
        const response = await fetch('/api/extensions/update', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ extensionName: extensionFolderName, global: updateState.isGlobal }),
        });
        if (!response.ok) throw new Error(`Extension update request returned HTTP ${response.status}.`);
        await response.json();
        globalThis.location.reload();
    } catch (error) {
        logger.error('[Veridis Update] Extension update failed.', error);
        $('#blai-tools-version-error').text(error instanceof Error ? error.message : String(error)).prop('hidden', false);
        $button.prop('disabled', false).text('更新并刷新');
        updateInFlight = false;
    }
}

export function bindUpdateStatusEvents() {
    $(document).off('click', '#blai-tools-version-section [data-update-action="update"]').on('click', '#blai-tools-version-section [data-update-action="update"]', updateAndReload);
}
