// Owns Veridis update-status derivation and its Tools/Feedback projections.
import { getAppContext } from '../host/appContext.js';
import { logger } from '../log.js';

let localManifest = null;
let installedSource = null;

let updateState = null;
let updateInFlight = false;
let checkInFlight = false;

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
        if (localManifest?.version) appendStatusRow(content, localManifest.version, message);
        else content.append(makeElement('p', 'blai-tools-version-status', message));
        if (installedSource) content.append(makeElement('p', 'blai-tools-version-status', `更新来源：${installedSource.repository} · ${installedSource.branch}`));
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
            appendReleaseNotes(body, updateState.updateNote);
        }
        appendUpdateAction(body);
    }

    if (installedSource) details.append(makeElement('p', 'blai-tools-version-status', `更新来源：${installedSource.repository} · ${installedSource.branch}`));
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

async function readRemoteJson(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(url, { ...options, cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`Version request returned HTTP ${response.status}.`);
        return await response.json();
    } finally {
        clearTimeout(timeout);
    }
}

export function resolveUpdateSource(versionInfo) {
    const remote = String(versionInfo?.remoteUrl || '').trim();
    const match = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
    const branch = String(versionInfo?.currentBranchName || '').replace(/^refs\/heads\//, '').trim();
    if (!match || !branch || branch === 'HEAD' || /[\s~^:?*\[\]\\]/.test(branch) || branch.includes('..')) return null;
    return { repository: `${match[1]}/${match[2]}`, branch };
}

export async function loadLocalUpdateVersion() {
    const app = getAppContext();
    if (typeof app.readExtensionManifest !== 'function') return;
    try { localManifest = await app.readExtensionManifest(app.veridisExternalId); }
    catch (error) { logger.warn('[Veridis Update] Local manifest unavailable.', error); }
}

// Local fix builds may be newer than their Git checkout. Do not offer a downgrade.
export function compareBuildVersions(left, right) {
    const parse = value => String(value).match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:-fix\.(\d+))?$/);
    const a = parse(left), b = parse(right);
    if (!a || !b) return null;
    for (let i=1;i<=4;i++) {
        const difference=Number(a[i] || 0)-Number(b[i] || 0);
        if(difference) return Math.sign(difference);
    }
    return 0;
}

export async function initializeUpdateStatus({ versionInfo, isGlobal } = {}) {
    updateState = null;
    projectFeedbackUpdateWarning();
    installedSource = resolveUpdateSource(versionInfo);
    await loadLocalUpdateVersion();
    const localVersion = String(localManifest?.version || '').trim();
    if (!localVersion || !installedSource) {
        projectToolsVersion('无法确认安装仓库或分支；请在宿主扩展管理中检查，不自动切换来源。');
        projectFeedbackUpdateWarning();
        return;
    }
    projectToolsVersion('正在检查当前安装分支…');
    try {
        const {repository,branch}=installedSource;
        const ref=branch.split('/').map(encodeURIComponent).join('/');
        const remoteManifest=await readRemoteJson(`https://raw.githubusercontent.com/${repository}/${ref}/manifest.json`);
        const remoteVersion=String(remoteManifest?.version || '').trim();
        const comparison=compareBuildVersions(localVersion,remoteVersion);
        if (!remoteVersion || (comparison === null && localVersion !== remoteVersion)) {
            projectToolsVersion('已读取分支信息，但版本号无法可靠比较；不自动更新。');return;
        }
        if (comparison > 0) {
            projectToolsVersion(`本地修复版本高于分支版本 v${remoteVersion}，不进行降级。`);return;
        }
        const current=String(versionInfo?.currentCommitHash || '');
        let remote=String(versionInfo?.remoteCommitHash || '');
        if (!/^[0-9a-f]{40}$/i.test(remote)) {
            const result=await readRemoteJson(`https://api.github.com/repos/${repository}/git/ref/heads/${ref}`,{headers:{Accept:'application/vnd.github+json'}});
            remote=String(result.object?.sha || '');
        }
        if (!/^[0-9a-f]{40}$/i.test(current) || !/^[0-9a-f]{40}$/i.test(remote)) {
            projectToolsVersion('已读取分支版本，但无法确认安装提交；不自动更新。');return;
        }
        updateState={kind:comparison<0?'formal':current===remote?'latest':'minor',localVersion,remoteVersion,
            updateNote:String(remoteManifest.update_note || ''),isGlobal:isGlobal===true,
            source:{...installedSource}};
        projectUpdateSurfaces();
    } catch(error) {
        logger.warn('[Veridis Update] Current branch check failed.',error);
        projectToolsVersion('当前分支检查失败，请稍后重试。');
    }
}

async function updateAndReload() {
    if (updateInFlight || !updateState || updateState.kind === 'latest') return;
    const context = getAppContext().getSillyTavernContext?.();
    const extensionFolderName = getAppContext().veridisExtensionFolderName;
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
        // Verify the source again in case the host switched branches since the check.
        const versionResponse=await fetch('/api/extensions/version', {
            method:'POST',headers:getRequestHeaders(),
            body:JSON.stringify({extensionName:extensionFolderName,global:updateState.isGlobal}),
        });
        if(!versionResponse.ok) throw new Error('无法确认当前安装分支，未执行更新。');
        const currentSource=resolveUpdateSource(await versionResponse.json());
        if(!currentSource || currentSource.repository!==updateState.source.repository || currentSource.branch!==updateState.source.branch)
            throw new Error('安装来源已变化，请重新检查版本。');
        // The host updates the existing checkout. Never switch to another branch.
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

export function bindUpdateStatusEvents(checkForUpdates) {
    const appendCheckButton = () => {
        const content = document.getElementById('blai-tools-version-content');
        if (!content || content.querySelector('[data-update-action="check"]')) return;
        const button = makeElement('button', 'blai-tools-version-update-action', '检查版本');
        button.type = 'button';
        button.dataset.updateAction = 'check';
        content.append(button);
    };
    projectToolsVersion('需要时点击检查版本。');
    appendCheckButton();
    $(document).off('click', '#blai-tools-version-section [data-update-action="check"]').on('click', '#blai-tools-version-section [data-update-action="check"]', async function () {
        if (checkInFlight || updateInFlight || typeof checkForUpdates !== 'function') return;
        checkInFlight = true;
        this.disabled = true;
        this.textContent = '正在检查…';
        try {
            await checkForUpdates();
        } catch (error) {
            logger.warn('[Veridis Update] Version check failed.', error);
            projectToolsVersion('暂时无法确认版本状态。');
        } finally {
            checkInFlight = false;
            this.disabled = false;
            this.textContent = '检查版本';
            appendCheckButton();
        }
    });
    $(document).off('click', '#blai-tools-version-section [data-update-action="update"]').on('click', '#blai-tools-version-section [data-update-action="update"]', updateAndReload);
}
