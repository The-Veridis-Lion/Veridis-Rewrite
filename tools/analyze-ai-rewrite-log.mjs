#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

function readArgs(argv) {
    const files = argv.slice(2).filter(arg => !arg.startsWith('-'));
    if (files.length === 0) {
        throw new Error('用法: node tools/analyze-ai-rewrite-log.mjs <日志文件> [更多日志文件...]');
    }
    return files;
}

function salvageEvents(text) {
    const events = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (inString) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') inString = false;
            continue;
        }
        if (char === '"') {
            inString = true;
            continue;
        }
        if (char === '{') {
            if (depth === 0) start = index;
            depth += 1;
            continue;
        }
        if (char !== '}' || depth === 0) continue;
        depth -= 1;
        if (depth !== 0 || start < 0) continue;
        try {
            const value = JSON.parse(text.slice(start, index + 1));
            if (value && typeof value === 'object' && typeof value.stage === 'string') {
                events.push(value);
            }
        } catch {
            // Ignore an incomplete trailing object and continue salvaging complete events.
        }
        start = -1;
    }
    return events;
}

function getDetails(event) {
    return event?.details && typeof event.details === 'object' ? event.details : {};
}

function ensureTask(tasks, taskId) {
    if (!tasks.has(taskId)) {
        tasks.set(taskId, {
            taskId,
            generationId: '',
            chatId: '',
            messageId: null,
            model: '',
            itemCount: null,
            automaticRuns: 0,
            manualRuns: 0,
            automaticFetchResponses: 0,
            scopeChanged: 0,
            finalCleanseReady: 0,
            automaticApplySuccess: 0,
            manualApplySuccess: 0,
            warningCommits: 0,
            firstTime: '',
            lastTime: '',
        });
    }
    return tasks.get(taskId);
}

function analyzeEvents(events) {
    const tasks = new Map();
    const generationToTask = new Map();
    const pendingApplyModeByTask = new Map();
    const chats = new Set();

    for (const event of events) {
        const details = getDetails(event);
        const taskId = String(details.task || '');
        const generationId = String(details.generationId || '');
        const chatId = String(details.chatId || '');
        if (chatId) chats.add(chatId);

        if (taskId && generationId && ['task-built', 'request-claimed'].includes(event.stage)) {
            generationToTask.set(generationId, taskId);
        }
        const mappedTaskId = taskId || generationToTask.get(generationId) || '';
        if (!mappedTaskId) continue;

        const task = ensureTask(tasks, mappedTaskId);
        task.firstTime ||= String(event.time || '');
        task.lastTime = String(event.time || task.lastTime);
        task.generationId ||= generationId;
        task.chatId ||= chatId;
        if (Number.isInteger(details.messageId)) task.messageId = details.messageId;

        if (event.stage === 'run-start' && taskId) {
            task.model ||= String(details.model || '');
            if (Number.isInteger(details.itemCount)) task.itemCount = details.itemCount;
            if (details.waitForFinalCleanse === true) task.automaticRuns += 1;
            if (details.waitForFinalCleanse === false) task.manualRuns += 1;
        }
        if (event.stage === 'pre-run-validation' && details.validationReason === 'content-scope-changed') {
            task.scopeChanged += 1;
        }
        if (event.stage === 'fetch-response' && generationId) task.automaticFetchResponses += 1;
        if (event.stage === 'final-cleanse-ready') task.finalCleanseReady += 1;
        if (event.stage === 'apply-start') {
            pendingApplyModeByTask.set(mappedTaskId, generationId ? 'automatic' : 'manual');
        }
        if (event.stage === 'apply-success') {
            const applyMode = pendingApplyModeByTask.get(mappedTaskId);
            if (applyMode === 'automatic') task.automaticApplySuccess += 1;
            else if (applyMode === 'manual') task.manualApplySuccess += 1;
            pendingApplyModeByTask.delete(mappedTaskId);
        }
        if (event.stage === 'popup-cleared' && details.reason === 'status-warning') {
            task.warningCommits += 1;
        }
    }

    return { chats: [...chats], tasks: [...tasks.values()] };
}

function taskOutcome(task) {
    if (task.automaticApplySuccess > 0) return '自动成功写回';
    if (task.scopeChanged > 0) return '自动任务因 content-scope-changed 被取消';
    if (task.automaticRuns > 0 && task.finalCleanseReady > 0) return '自动内容稳定，但日志未记录最终写回';
    if (task.automaticRuns > 0) return '自动任务已启动，结果在截断日志中不可见';
    if (task.manualApplySuccess > 0) return '手动成功写回';
    return '结果不足';
}

function printReport(file, text, events, analysis) {
    const isTruncated = text.includes('（还剩') || !text.trimEnd().endsWith(']');
    const automaticTasks = analysis.tasks.filter(task => task.automaticRuns > 0);
    const manualTasks = analysis.tasks.filter(task => task.manualRuns > 0);
    const scopeChangedTasks = automaticTasks.filter(task => task.scopeChanged > 0);
    const automaticSuccesses = automaticTasks.filter(task => task.automaticApplySuccess > 0);
    const manualSuccesses = analysis.tasks.filter(task => task.manualApplySuccess > 0);
    const automaticResponses = automaticTasks.reduce((sum, task) => sum + task.automaticFetchResponses, 0);

    console.log(`\n=== ${path.resolve(file)} ===`);
    console.log(`完整事件: ${events.length}; 日志截断: ${isTruncated ? '是' : '否'}`);
    console.log(`聊天: ${analysis.chats.length > 0 ? analysis.chats.join(' | ') : '未记录'}`);
    console.log(`自动任务: ${automaticTasks.length}; content-scope-changed: ${scopeChangedTasks.length}; 自动成功: ${automaticSuccesses.length}; 自动 API 响应: ${automaticResponses}`);
    console.log(`手动任务: ${manualTasks.length}; 手动成功: ${manualSuccesses.length}`);

    for (const task of automaticTasks) {
        const manualSuffix = task.manualRuns > 0
            ? `; 后续手动=${task.manualApplySuccess > 0 ? '成功' : task.warningCommits > 0 ? '有警告写回' : '未见成功'}`
            : '';
        console.log([
            `- ${task.taskId}`,
            `generation=${task.generationId || '-'}`,
            `message=${task.messageId ?? '-'}`,
            `model=${task.model || '-'}`,
            `items=${task.itemCount ?? '-'}`,
            `结果=${taskOutcome(task)}${manualSuffix}`,
        ].join('; '));
    }

    const manualOnly = manualTasks.filter(task => task.automaticRuns === 0);
    for (const task of manualOnly) {
        console.log(`- ${task.taskId}; 仅手动; model=${task.model || '-'}; items=${task.itemCount ?? '-'}; 结果=${taskOutcome(task)}`);
    }
}

function main() {
    const files = readArgs(process.argv);
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        const events = salvageEvents(text);
        if (events.length === 0) throw new Error(`${file}: 没有找到完整日志事件`);
        printReport(file, text, events, analyzeEvents(events));
    }
}

try {
    main();
} catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
}
