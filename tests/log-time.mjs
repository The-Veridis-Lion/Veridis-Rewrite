import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { formatLocalLogTime } from '../src/aiRewrite/logTime.js';
import { recordAiCommunicationSuccess, clearAiCommunicationRecords, getAiCommunicationRecords, formatAiCommunicationRecords, getAiCommunicationDisplayGroups } from '../src/aiRewrite/communicationMonitor.js';
import { recordAiRewriteDebug, getAiRewriteDebugDisplayText, getAiRewriteDebugLogText, groupDebugDisplayEvents } from '../src/aiRewrite/debug.js';

for (const [zone, input, expected] of [
    ['Asia/Shanghai', '2026-10-28T05:39:00.000Z', '2026-10-28 13:39:00.000 UTC+08:00'],
    ['Asia/Shanghai', '2026-10-28T10:19:21.475Z', '2026-10-28 18:19:21.475 UTC+08:00'],
    ['America/New_York', '2026-01-01T01:00:00.000Z', '2025-12-31 20:00:00.000 UTC-05:00'],
    ['UTC', '2026-10-28T05:39:00.000Z', '2026-10-28 05:39:00.000 UTC+00:00'],
]) test(`local log time ${zone}: ${input}`, () => {
    const module = new URL('../src/aiRewrite/logTime.js', import.meta.url).href;
    const script = `import {formatLocalLogTime} from ${JSON.stringify(module)}; console.log(formatLocalLogTime(${JSON.stringify(input)}));`;
    assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, TZ: zone }, encoding: 'utf8',
    }).trim(), expected);
});

test('communication display labels request start and preserves the stored UTC instant', () => {
    clearAiCommunicationRecords();
    const input = '2026-10-28T05:39:00.000Z';
    recordAiCommunicationSuccess({ startedAt: Date.parse(input), endedAt: Date.parse(input) + 9878,
        requestJson: '{}', response: '{}' });
    assert.equal(getAiCommunicationRecords()[0].timestamp, input);
    assert.ok(formatAiCommunicationRecords().includes(`请求开始：${formatLocalLogTime(input)}`));
    assert.ok(formatAiCommunicationRecords().includes('9878 ms'));
    clearAiCommunicationRecords();
});

test('invalid historical timestamps stay visible rather than crashing log display', () => {
    assert.equal(formatLocalLogTime('invalid-date'), 'invalid-date');
    assert.equal(formatLocalLogTime(undefined), '');
});

test('runtime UI converts the same instant while copied JSON retains UTC', () => {
    const event = recordAiRewriteDebug('fixture-time-check', { count: 1 });
    assert.ok(getAiRewriteDebugDisplayText().includes(formatLocalLogTime(event.time)));
    const exported = JSON.parse(getAiRewriteDebugLogText()).find(item => item.stage === 'fixture-time-check');
    assert.equal(exported.time, event.time);
    assert.ok(exported.time.endsWith('Z'));
});

test('runtime separators keep unidentified events separate and preserve raw records', () => {
    recordAiRewriteDebug('separator-first', { generationId: 'generation-fixture-a', messageId: 0 });
    recordAiRewriteDebug('separator-unassigned', { reason: 'dry-run' });
    recordAiRewriteDebug('separator-second', { generationId: 'generation-fixture-b' });
    const before = getAiRewriteDebugLogText();
    const display = getAiRewriteDebugDisplayText();
    assert.ok(display.includes('改写记录 · generation-fixture-a'));
    assert.ok(display.includes('历史记录缺少归属信息'));
    assert.ok(display.indexOf('separator-second') < display.indexOf('separator-unassigned'));
    assert.ok(display.indexOf('separator-unassigned') < display.indexOf('separator-first'));
    assert.equal(getAiRewriteDebugLogText(), before);
});

test('communication boundaries separate requests without changing their content', () => {
    clearAiCommunicationRecords();
    for (let i = 0; i < 2; i++) recordAiCommunicationSuccess({
        startedAt: 1000 + i, endedAt: 1100 + i, requestJson: `request-${i}`, response: `response-${i}`,
    });
    const before = JSON.stringify(getAiCommunicationRecords());
    const display = formatAiCommunicationRecords();
    assert.equal(display.split('【AI 请求记录 · 开始】').length - 1, 2);
    assert.equal(display.split('【本次请求记录 · 结束】').length - 1, 2);
    assert.ok(display.indexOf('response-1') < display.indexOf('request-0'));
    assert.equal(JSON.stringify(getAiCommunicationRecords()), before);
    clearAiCommunicationRecords();
    assert.equal(formatAiCommunicationRecords(), '暂无通信记录。');
});


test('whole generations include bracketed unlabelled events but exclude background checks', () => {
    const event = (stage, generationId, n, more = {}) => ({ stage, time: `2026-10-28T00:00:${String(n).padStart(2,'0')}.000Z`, details: { generationId, ...more } });
    const source = [event('generation-created','generation-1',1), event('fetch-start','generation-1',2),
        event('parse-result',undefined,3), event('generation-start-ignored',undefined,4), event('run-success','generation-1',5),
        event('generation-created','generation-2',6),event('run-success','generation-2',7),
        event('generation-created','generation-1',8),event('run-success','generation-1',9)];
    const before = JSON.stringify(source);
    const groups = groupDebugDisplayEvents(source);
    assert.equal(groups.length,4);
    assert.match(groups[2].text,/parse-result/);
    assert.doesNotMatch(groups[2].text,/generation-start-ignored/);
    assert.equal(groups.filter(g=>g.title.includes('generation-1')).length,2);
    assert.equal(JSON.stringify(source),before);
    assert.equal(groups.map(g=>g.text).join('').split('run-success').length-1,3);
});

test('different chats and ambiguous unlabelled boundaries stay separate', () => {
    const source = [
        {stage:'run-start',details:{generationId:'generation-1',chatId:'a'}},
        {stage:'parse-result',details:{}},
        {stage:'run-start',details:{generationId:'generation-1',chatId:'b'}},
    ];
    const groups=groupDebugDisplayEvents(source);
    assert.equal(groups.length,3);
    assert.match(groups.find(g=>g.title.startsWith('历史记录')).text,/parse-result/);
});

test('AI requests group only by the same existing task context', () => {
    clearAiCommunicationRecords();
    for (const [n,startedAtMs] of [[1,100],[2,100],[3,200]]) recordAiCommunicationSuccess({
        context:{generationId:'generation-1',chatId:'a',startedAtMs},
        startedAt:n,endedAt:n+1,requestJson:`request-${n}`,response:`response-${n}`,
    });
    const groups=getAiCommunicationDisplayGroups();
    assert.equal(groups.length,2);
    assert.match(groups[1].text,/request-1/);
    assert.match(groups[1].text,/response-2/);
    assert.doesNotMatch(groups[1].text,/request-3/);
    clearAiCommunicationRecords();
});


test('ignored dry runs and historical events without identity have separate copy groups', () => {
    const source = [
        { time: '2026-10-28T13:40:25.433Z', stage: 'streaming-xml-end-detected', details: { messageId: 769 } },
        { time: '2026-10-28T15:02:29.689Z', stage: 'generation-start-ignored', details: { dryRun: true, reason: 'dry-run' } },
        { time: '2026-10-28T15:07:01.895Z', stage: 'generation-start-ignored', details: { reason: 'dry-run' } },
    ];
    const before = JSON.stringify(source);
    const groups = groupDebugDisplayEvents(source);
    assert.equal(groups.length, 2);
    assert.match(groups[0].title, /^试运行已忽略/);
    assert.equal(groups[0].text.split('generation-start-ignored').length - 1, 2);
    assert.doesNotMatch(groups[0].text, /streaming-xml-end-detected/);
    assert.match(groups[1].title, /^历史记录缺少归属信息/);
    assert.match(groups[1].text, /streaming-xml-end-detected/);
    assert.doesNotMatch(groups[1].text, /generation-start-ignored/);
    assert.equal(JSON.stringify(source), before);
});
