import { getTavernHelperGlobalApi } from '../integrations/tavernHelper.js';
import { extensionName } from '../settings/defaults.js';
import { getAppContext } from '../host/appContext.js';
import { logger } from '../log.js';
import { resolveLatestTrackableMessageIndex } from '../chat/cleanse.js';
import { requestManualAiRewriteForMessage } from './index.js';
import { showToast } from '../ui/notifications.js';

export const composerButtonScriptId = 'veridis-rewrite-composer-button';
export const composerButtonName = 'AI 改写';
export const composerButtonAiRewriteEvent = 'veridis-rewrite:manual-ai-rewrite-latest';

const composerButtonScriptName = '[Veridis Rewrite] 手动 AI 改写按钮';
const composerButtonScriptInfo = '由 Veridis Rewrite 管理；请通过 Veridis 工具页设置启用或停用。';
const composerButtonScriptContent = `eventOn(getButtonEvent('${composerButtonName}'), () => {
    eventEmit('${composerButtonAiRewriteEvent}');
});`;

function createManagedComposerButtonScript() {
    return {
        type: 'script',
        enabled: true,
        name: composerButtonScriptName,
        id: composerButtonScriptId,
        content: composerButtonScriptContent,
        info: composerButtonScriptInfo,
        button: {
            enabled: true,
            buttons: [{ name: composerButtonName, visible: true }],
        },
        data: {},
        export_with: {
            data: true,
            button: true,
        },
    };
}

function isCanonicalManagedScript(script) {
    if (!script || typeof script !== 'object') return false;
    const canonical = createManagedComposerButtonScript();
    return Object.keys(script).length === Object.keys(canonical).length
        && script.type === canonical.type
        && script.enabled === canonical.enabled
        && script.name === canonical.name
        && script.id === canonical.id
        && script.content === canonical.content
        && script.info === canonical.info
        && Object.keys(script.data || {}).length === 0
        && script.export_with?.data === true
        && script.export_with?.button === true
        && Object.keys(script.export_with || {}).length === 2
        && script.button?.enabled === true
        && Object.keys(script.button || {}).length === 2
        && Array.isArray(script.button?.buttons)
        && script.button.buttons.length === 1
        && script.button.buttons[0]?.name === composerButtonName
        && script.button.buttons[0]?.visible === true
        && Object.keys(script.button.buttons[0] || {}).length === 2;
}

function updateManagedComposerButtonTree(scriptTrees, enabled) {
    const trees = Array.isArray(scriptTrees) ? scriptTrees : [];
    const canonical = createManagedComposerButtonScript();
    let foundTopLevel = false;
    let changed = false;
    const nextTrees = [];

    trees.forEach((tree) => {
        if (tree?.id === composerButtonScriptId) {
            if (enabled === true && foundTopLevel === false) {
                foundTopLevel = true;
                if (isCanonicalManagedScript(tree)) {
                    nextTrees.push(tree);
                } else {
                    nextTrees.push(canonical);
                    changed = true;
                }
            } else {
                changed = true;
            }
            return;
        }

        if (tree?.type === 'folder' && Array.isArray(tree.scripts)) {
            const scripts = tree.scripts.filter((script) => script?.id !== composerButtonScriptId);
            if (scripts.length !== tree.scripts.length) {
                changed = true;
                nextTrees.push({ ...tree, scripts });
                return;
            }
        }
        nextTrees.push(tree);
    });

    if (enabled === true && foundTopLevel === false) {
        nextTrees.push(canonical);
        changed = true;
    }

    return changed ? nextTrees : trees;
}

export function syncComposerButtonScript(enabled, tavernHelper = getTavernHelperGlobalApi()) {
    if (typeof tavernHelper?.updateScriptTreesWith !== 'function') {
        logger.warn(`无法同步输入框手动 AI 改写按钮：TavernHelper.updateScriptTreesWith 不可用（目标状态：${enabled === true ? '开启' : '关闭'}）`);
        return false;
    }

    return tavernHelper.updateScriptTreesWith(
        (scriptTrees) => updateManagedComposerButtonTree(scriptTrees, enabled === true),
        { type: 'global' },
    );
}

export function updateComposerButtonSetting(enabled) {
    const { extension_settings, saveSettingsDebounced } = getAppContext();
    const settings = extension_settings[extensionName];
    settings.showComposerAiRewriteButton = enabled === true;
    saveSettingsDebounced();
    return syncComposerButtonScript(settings.showComposerAiRewriteButton);
}

export function bindComposerButtonAiRewriteEvent(
    eventSource,
    requestManualAiRewrite = requestManualAiRewriteForMessage,
    notify = showToast,
) {
    eventSource.on(composerButtonAiRewriteEvent, () => {
        const index = resolveLatestTrackableMessageIndex();
        if (index < 0) {
            notify('未找到可改写的助手消息');
            return false;
        }
        return requestManualAiRewrite(index);
    });
}
