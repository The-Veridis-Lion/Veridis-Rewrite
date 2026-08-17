import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { clearAiRewriteDebugLog, getAiRewriteDebugDisplayText, getAiRewriteDebugLogText, recordAiRewriteDebug } from '../src/aiRewrite/debug.js';
import { extensionName, runtimeState } from '../src/state.js';

const normalStorageKey = `${extensionName}_ai_rewrite_debug_events`;
const criticalStorageKey = `${extensionName}_ai_rewrite_critical_debug_events`;
const storedValues = new Map();
let previousDocument;

globalThis.localStorage = {
    getItem: key => storedValues.get(key) ?? null,
    setItem: (key, value) => storedValues.set(key, value),
    removeItem: key => storedValues.delete(key),
};

test.beforeEach(() => {
    previousDocument = globalThis.document;
    delete globalThis.document;
    storedValues.clear();
    runtimeState.aiRewrite.debugEvents = [];
    runtimeState.aiRewrite.criticalDebugEvents = [];
});

test.afterEach(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
});

test('AI rewrite display keeps the latest 60 merged events in reverse chronological text', () => {
    const events = Array.from({ length: 65 }, (_, index) => ({
        time: new Date(Date.UTC(2026, 7, 15, 9, 18, 16, index)).toISOString(),
        stage: index === 64 ? 'pre-run-validation' : 'run-start',
        details: index === 64 ? {
            generationId: 'generation-1',
            messageId: 0,
            requestState: 'running',
            source: 'streaming',
            chatId: 'host:温其序',
            validationMode: 'target-identity',
            validationReason: '',
            contentSnapshotHash: 'h9a4287c8',
            mode: 'swipe',
            phase: 'active',
            status: false,
            itemCount: 0,
            responseMetadata: { accepted: false },
            futureProperty: 'line one\r\nline two',
        } : { attempt: index },
    })).reverse();
    storedValues.set(criticalStorageKey, JSON.stringify(events));

    const display = getAiRewriteDebugDisplayText();
    const sourceAfterDisplay = JSON.stringify(JSON.parse(storedValues.get(criticalStorageKey)));
    const repeatedDisplay = getAiRewriteDebugDisplayText();
    const headers = display.match(/^\[[^\]]+\] .+$/gm) || [];

    assert.equal(headers.length, 60);
    assert.match(headers[0], /09:18:16\.064Z\] pre-run-validation$/);
    assert.match(headers.at(-1), /09:18:16\.005Z\] run-start$/);
    assert.doesNotMatch(display, /09:18:16\.004Z/);
    assert.equal(repeatedDisplay, display);
    assert.equal(JSON.stringify(JSON.parse(storedValues.get(criticalStorageKey))), sourceAfterDisplay);
    assert.doesNotMatch(display, /^\s*[\[{]\s*$/m);
    assert.match(display, /生成 ID=generation-1 \| 消息 ID=0 \| 请求状态=running \| 来源=streaming/);
    assert.match(display, /^  会话 ID=host:温其序$/m);
    assert.match(display, /^  校验模式=target-identity \| 校验原因=— \| 内容快照哈希=h9a4287c8$/m);
    assert.match(display, /模式=swipe \| 阶段=active \| 状态=false \| 项目数=0/);
    assert.match(display, /responseMetadata=\{"accepted":false\}/);
    assert.match(display, /futureProperty=line one\\r\\nline two/);
    assert.doesNotMatch(display, /生成 ID=undefined|消息 ID=undefined|会话 ID=undefined/);
    assert.equal(display.split('\n\n').length, 60);

    const structured = JSON.parse(getAiRewriteDebugLogText());
    assert.equal(structured.length, 65);
    assert.equal(structured[0].stage, 'run-start');
    assert.equal(structured.at(-1).stage, 'pre-run-validation');
    assert.equal(structured.at(-1).details.requestState, 'running');
    assert.equal(structured.at(-1).details.futureProperty, 'line one\r\nline two');
    assert.ok(storedValues.has(normalStorageKey));
});

test('AI settings renders display text while copy retains structured JSON export', async () => {
    const source = await readFile(new URL('../src/events/aiSettings.js', import.meta.url), 'utf8');
    const renderStart = source.indexOf('const syncAiRewriteSettingsUI = () =>');
    const renderEnd = source.indexOf('const updateAiRewriteSetting', renderStart);
    const renderBlock = source.slice(renderStart, renderEnd);
    const copyStart = source.indexOf("$(document).off('click', '#blai-ai-copy-log')");
    const copyEnd = source.indexOf("$(document).off('change', '#blai-ai-api-preset')", copyStart);
    const copyBlock = source.slice(copyStart, copyEnd);

    assert.match(renderBlock, /\$\('#blai-ai-debug-log'\)\.text\(getAiRewriteDebugDisplayText\(\)\)/);
    assert.doesNotMatch(renderBlock, /getAiRewriteDebugLogText\(/);
    assert.match(copyBlock, /const logText = getAiRewriteDebugLogText\(\)/);
    assert.doesNotMatch(copyBlock, /getAiRewriteDebugDisplayText\(/);
});

test('compact modification summaries use display-only labels and retain English stages', () => {
    const messageText = 'PRIVATE MESSAGE TEXT';
    const cellValue = 'PRIVATE SHUJUKU CELL';
    const tableSnapshot = 'PRIVATE TABLE SNAPSHOT';
    const promptResponse = 'PRIVATE PROMPT RESPONSE';

    recordAiRewriteDebug('program-commit', {
        source: 'message-cleanse',
        messageId: 22,
        changedTargets: 1,
        changedSwipeCount: 0,
        beforeLength: messageText.length,
        afterLength: 12,
    });
    recordAiRewriteDebug('apply-success', {
        task: 'compact-task',
        index: 22,
        appliedCount: 2,
        skippedCount: 0,
        strategies: ['exact'],
        beforeLength: 20,
        afterLength: 18,
    });
    recordAiRewriteDebug('shujuku-program-commit', {
        source: 'shujuku-auto',
        messageId: 22,
        targetCount: 4,
        changedCount: 3,
    });
    recordAiRewriteDebug('shujuku-pending-armed', {
        source: 'ai-finalization',
        messageId: 22,
    });
    recordAiRewriteDebug('shujuku-callback-received', {
        hasPending: true,
        active: false,
        messageId: 22,
    });

    const display = getAiRewriteDebugDisplayText();
    const structuredText = getAiRewriteDebugLogText();
    const structured = JSON.parse(structuredText);

    assert.match(display, /程序净化完成/);
    assert.match(display, /来源=普通消息 \| 消息 ID=22/);
    assert.match(display, /写回目标=1 \| Swipe 修改=0 \| 修改前长度=20 \| 修改后长度=12/);
    assert.match(display, /AI 改写完成/);
    assert.match(display, /消息 ID=22 \| 应用项目=2 \| 跳过项目=0/);
    assert.match(display, /Shujuku 净化完成/);
    assert.match(display, /来源=自动回调 \| 消息 ID=22/);
    assert.match(display, /Shujuku 等待目标已建立/);
    assert.match(display, /来源=AI 终稿内程序净化 \| 消息 ID=22/);
    assert.match(display, /Shujuku 更新回调/);
    assert.match(display, /有等待目标=true \| 正在处理=false \| 消息 ID=22/);
    assert.doesNotMatch(display, /task=|strategies=/);
    assert.match(display, /候选单元格=4 \| 实际修改=3/);
    assert.deepEqual(structured.map(event => event.stage).sort(), [
        'apply-success',
        'program-commit',
        'shujuku-callback-received',
        'shujuku-pending-armed',
        'shujuku-program-commit',
    ]);
    assert.equal(structured.filter(event => event.stage === 'apply-success').length, 1);
    assert.equal(structured.find(event => event.stage === 'apply-success').details.task, 'compact-task');
    assert.deepEqual(runtimeState.aiRewrite.criticalDebugEvents.map(event => event.stage), ['apply-success']);
    for (const output of [display, structuredText]) {
        assert.doesNotMatch(output, new RegExp(messageText));
        assert.doesNotMatch(output, new RegExp(cellValue));
        assert.doesNotMatch(output, new RegExp(tableSnapshot));
        assert.doesNotMatch(output, new RegExp(promptResponse));
    }
});

test('ordinary modification summaries rotate at 60 without entering critical retention', () => {
    for (let messageId = 0; messageId < 65; messageId++) {
        recordAiRewriteDebug('program-commit', {
            source: 'message-cleanse',
            messageId,
            changedTargets: 1,
            changedSwipeCount: 0,
        });
    }

    const structured = JSON.parse(getAiRewriteDebugLogText());
    const display = getAiRewriteDebugDisplayText();
    assert.equal(runtimeState.aiRewrite.debugEvents.length, 60);
    assert.equal(runtimeState.aiRewrite.criticalDebugEvents.length, 0);
    assert.equal(structured.length, 60);
    assert.equal(structured[0].details.messageId, 5);
    assert.equal(structured.at(-1).details.messageId, 64);
    assert.match(display.split('\n\n')[0], /消息 ID=64/);
    assert.equal(display.split('\n\n').length, 60);
});

test('Shujuku checks render compact no-target and no-change result labels', () => {
    const privateCellValue = 'PRIVATE SHUJUKU CHECK VALUE';
    recordAiRewriteDebug('shujuku-program-check', {
        source: 'shujuku-auto',
        messageId: 4,
        persistenceTargetCount: 1,
        newEntryCount: 1,
        operationKindCounts: { sql_sheet_batch: 1 },
        rowUpsertCount: 0,
        candidateCellCount: 0,
        targetCount: 0,
        changedCount: 0,
        result: 'no-targets',
    });
    recordAiRewriteDebug('shujuku-program-check', {
        source: 'shujuku-direct',
        messageId: 5,
        targetCount: 6,
        changedCount: 0,
        result: 'no-changes',
    });

    const display = getAiRewriteDebugDisplayText();
    const structuredText = getAiRewriteDebugLogText();
    const structured = JSON.parse(structuredText);
    assert.equal(display.match(/Shujuku 净化检查/g)?.length, 2);
    assert.match(display, /来源=自动回调 \| 消息 ID=4 \| 持久化目标=1 \| 新增日志项=1 \| 操作类型计数=\{"sql_sheet_batch":1\} \| 行写入操作=0 \| 结构候选单元格=0 \| 候选单元格=0 \| 实际修改=0 \| 结果=未取得候选单元格/);
    assert.match(display, /来源=直接改写 \| 消息 ID=5 \| 候选单元格=6 \| 实际修改=0 \| 结果=候选无需修改/);
    assert.equal(display.indexOf('消息 ID=5') < display.indexOf('消息 ID=4'), true);
    assert.deepEqual(structured.map(event => event.details.result), ['no-targets', 'no-changes']);
    assert.equal(runtimeState.aiRewrite.criticalDebugEvents.length, 0);
    assert.doesNotMatch(display, new RegExp(privateCellValue));
    assert.doesNotMatch(structuredText, new RegExp(privateCellValue));
});

test('recording and clearing diagnostics synchronously refreshes an already-mounted compact log', () => {
    const mountedLog = { textContent: '' };
    globalThis.document = {
        getElementById: id => id === 'blai-ai-debug-log' ? mountedLog : null,
        documentElement: { setAttribute() {}, removeAttribute() {} },
    };

    recordAiRewriteDebug('apply-success', {
        index: 1,
        appliedCount: 1,
        skippedCount: 0,
    });
    assert.match(mountedLog.textContent, /AI 改写完成/);
    assert.match(mountedLog.textContent, /消息 ID=1 \| 应用项目=1 \| 跳过项目=0/);

    recordAiRewriteDebug('program-commit', {
        source: 'ai-finalization',
        messageId: 2,
        beforeLength: 30,
        afterLength: 28,
    });
    const headers = mountedLog.textContent.match(/^\[[^\]]+\] .+$/gm) || [];
    assert.equal(headers.length, 2);
    assert.match(headers[0], /程序净化完成$/);
    assert.match(headers[1], /AI 改写完成$/);
    assert.match(mountedLog.textContent, /来源=AI 终稿内程序净化/);

    recordAiRewriteDebug('program-commit', {
        source: 'ai-fallback',
        messageId: 3,
        beforeLength: 30,
        afterLength: 26,
    });
    assert.match(mountedLog.textContent, /来源=AI 回退程序净化/);

    globalThis.document.getElementById = () => null;
    assert.doesNotThrow(() => recordAiRewriteDebug('run-success', { messageId: 4 }));

    globalThis.document.getElementById = id => id === 'blai-ai-debug-log' ? mountedLog : null;
    clearAiRewriteDebugLog();
    assert.equal(mountedLog.textContent, '');
});

test('live mounted display synchronously retains only the newest 60 events', () => {
    const mountedLog = { textContent: '' };
    globalThis.document = {
        getElementById: id => id === 'blai-ai-debug-log' ? mountedLog : null,
        documentElement: { setAttribute() {}, removeAttribute() {} },
    };

    for (let messageId = 0; messageId < 65; messageId++) {
        recordAiRewriteDebug('program-commit', {
            source: 'message-cleanse',
            messageId,
            changedTargets: 1,
            changedSwipeCount: 0,
        });
    }

    const entries = mountedLog.textContent.split('\n\n');
    assert.equal(entries.length, 60);
    assert.match(entries[0], /消息 ID=64/);
    assert.match(entries.at(-1), /消息 ID=5/);
    assert.doesNotMatch(mountedLog.textContent, /消息 ID=4(?:\D|$)/);
});
