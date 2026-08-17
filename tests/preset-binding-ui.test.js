import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const readProjectFile = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('tools binding rows show the actual setting and bound target in the requested order', async () => {
    const template = await readProjectFile('templates/purifier.html');
    const characterIndex = template.indexOf('data-blai-click-proxy="#blai-bind-current-character"');
    const chatIndex = template.indexOf('data-blai-click-proxy="#blai-bind-current-chat-preset"');
    const globalIndex = template.indexOf('data-blai-click-proxy="#blai-default-toggle"');

    assert.ok(globalIndex >= 0 && globalIndex < characterIndex && characterIndex < chatIndex);
    assert.match(template, /当前设置：<strong id="blai-tools-character-binding">无<\/strong>.*当前绑定：<strong id="blai-tools-character-context">无<\/strong>/s);
    assert.match(template, /当前设置：<strong id="blai-tools-chat-binding">无<\/strong>.*当前绑定：<strong id="blai-tools-chat-context">无<\/strong>/s);
    assert.match(template, /作为未命中角色或补全绑定时的默认预设。/);
    assert.equal(template.match(/class="blai-tools-binding-description"/g)?.length, 1);
});

test('binding actions only open a modal for role and chat-preset conflicts', async () => {
    const events = await readProjectFile('src/events.js');
    const handlerStart = events.indexOf("$(document).off('click', '.blai-bind-menu-item')");
    const handlerEnd = events.indexOf("$(document).off('click', '#blai-preset-rename')", handlerStart);
    const bindingHandler = events.slice(handlerStart, handlerEnd);
    const defaultStart = events.indexOf("$(document).off('click', '#blai-default-toggle')");
    const defaultEnd = events.indexOf("$(document).off('click', '#blai-character-bind-toggle')", defaultStart);
    const defaultHandler = events.slice(defaultStart, defaultEnd);

    assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
    assert.equal(bindingHandler.match(/showRiskConfirmModal/g)?.length, 2);
    assert.doesNotMatch(bindingHandler, /showRiskInfoModal|showToast/);
    assert.doesNotMatch(defaultHandler, /showRiskInfoModal|showRiskConfirmModal|showToast/);
});

test('binding UI reads target names from the active character and chat completion preset', async () => {
    const ui = await readProjectFile('src/ui.js');

    assert.match(ui, /\$\('#blai-tools-character-context'\)\.text\(currentBound \? context\.name : '无'\)/);
    assert.match(ui, /\$\('#blai-tools-chat-context'\)\.text\(currentChatBound \? chatCompletionPresetName : '无'\)/);
});
