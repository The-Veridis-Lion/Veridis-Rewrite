function localEditResponse(prompt, values) {
 const targets=new Map([...prompt.matchAll(/<rewrite_target id="([^"]+)"[^>]*>([\s\S]*?)<\/rewrite_target>/g)].map(m=>[m[1],m[2]]));
 return JSON.stringify(Object.fromEntries(Object.entries(values).map(([id,after])=>[id,[{before:targets.get(id),occurrence:0,after}]])));
}
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initAppContext } from '../src/host/appContext.js';
import { extensionName, defaultSettings, defaultAiRewriteSettings } from '../src/settings/defaults.js';
import { buildAiRewriteTaskCheck, runAiRewriteForMessageNow, cancelAiRewriteTask, resetAiRewriteRuntimeState } from '../src/aiRewrite/runtime.js';
import { applyAcceptedRewrites, applyProgramFallbackRewrites } from '../src/aiRewrite/apply.js';
import { resolveManualProgramTail } from '../src/aiRewrite/task.js';
import { writeMessageDiffProgram, writeMessageDiffAiStage, getMessageDiffMeta, setMessageDiffReverted, restoreMessageDiffResult } from '../src/diff/messageMeta.js';
import { getMessageDiffBranchKey, setCurrentSwipeText } from '../src/chat/messageBranch.js';
import { applyScopedCompiledReplacements } from '../src/rules/engine.js';
import { getAiRewriteRuntimeLog, clearAiRewriteDebugLog } from '../src/aiRewrite/debug.js';

const oldOriginal = '他极其认真地检查桌面——随后停下。';
const oldProgram = '他极其认真地检查桌面，随后停下。';
const edited = '他极其认真地检查柜子——随后离开。\n“保留对白。”他拿起两个杯子。';
const rewritten = '他认真地检查柜子，随后离开。';
globalThis.document = { getElementById: () => null, querySelector: () => null,
    documentElement: { setAttribute() {} } };
globalThis.CultivationRuleRouter = {};

function harness(kind = 'main', text = edited, previousAi = false) {
    resetAiRewriteRuntimeState();
    const settings = structuredClone(defaultSettings);
    Object.assign(settings, { logLevel: 0, diffTrackedMessageLimit: 20, scopeTagMode: 'protect', scopeTags: [],
        rules: [{ name: 'Fixture', enabled: true, subRules: [
            { enabled: true, mode: 'text', rewriteMode: 'ai', targets: ['极其'], replacements: [''], aiPromptTemplate: 'Remove excess intensity; preserve meaning.' },
            { enabled: true, mode: 'regex', rewriteMode: 'program', targets: ['—+'], replacements: ['，'] },
        ] }], aiRewrite: { ...defaultAiRewriteSettings, enabled: true, xmlScopeTag: '',
            baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-key', model: 'fixture-model', maxRetries: 0 } });
    const neighbor = { is_user: false, mes: '其他楼层。', __blai_diff_branch_meta: { main: {
        originalMes: '其他楼层。', programMes: '其他楼层。', aiMes: null, reverted: false } } };
    const msg = { is_user: false, mes: text, extra: { fixture: true } };
    if (kind !== 'main') {
        msg.swipe_id = 1;
        msg.swipes = ['另一个分支。', kind === 'object' ? { mes: text, custom: 'preserve' } : text];
        writeMessageDiffProgram(msg, 'swipe:0', '另一个分支。', '另一个分支。');
    }
    const chat = [neighbor, msg];
    const host = { chat, chatId: 'fixture', getRequestHeaders: () => ({ 'Content-Type': 'application/json' }), updateMessageBlock() {} };
    initAppContext({ chat, extension_settings: { [extensionName]: settings }, saveSettingsDebounced() {},
        saveChat: async () => {}, getSillyTavernContext: () => host });
    const key = getMessageDiffBranchKey(msg);
    if (previousAi) writeMessageDiffAiStage(msg, key, oldOriginal, oldProgram, oldProgram);
    else writeMessageDiffProgram(msg, key, oldOriginal, oldProgram);
    const unchangedNeighbor = structuredClone(neighbor);
    const otherBranch = structuredClone(msg.__blai_diff_branch_meta['swipe:0']);
    const build = () => {
        const result = buildAiRewriteTaskCheck(1, { manual: true });
        assert.ok(result.task, result.reason);
        return result.task;
    };
    const reply = task => new Map(task.items.map(item => [item.id, rewritten]));
    const assertUntouched = () => {
        assert.deepEqual(neighbor, unchangedNeighbor);
        if (kind !== 'main') {
            assert.equal(msg.swipes[0], '另一个分支。');
            assert.deepEqual(msg.__blai_diff_branch_meta['swipe:0'], otherBranch);
            if (kind === 'object') assert.equal(msg.swipes[1].custom, 'preserve');
        }
    };
    return { msg, chat, settings, key, build, reply, assertUntouched, meta: () => getMessageDiffMeta(msg, key) };
}

for (const kind of ['main', 'string', 'object']) test(`${kind}: copied quoted noun suffix is trimmed through actual writeback`, () => {
    const target='纸面留下了极其清晰的、名为',tail='“确认”的印记。';
    const h=harness(kind,target+tail),task=h.build();
    assert.equal(task.items.length,1);
    const result=applyAcceptedRewrites(task,new Map([[task.items[0].id,'纸面留下了'+tail]]));
    assert.equal(result.committed,true,result.reason);
    assert.equal(h.msg.mes,'纸面留下了'+tail);
    assert.equal(h.meta().originalMes,target+tail);
    h.assertUntouched();
});

for (const kind of ['main', 'string', 'object']) test(`${kind}: contrast copy is removed without changing original negative facts or the next paragraph`, () => {
    const target='那不再是草稿，也不是副本。',tail='\n\n那是归档，是备份，是保留。';
    const h=harness(kind,target+tail);
    h.settings.rules[0].subRules[0].targets=['不再是'];
    const task=h.build();
    assert.equal(task.items.length,1);
    const result=applyAcceptedRewrites(task,new Map([[task.items[0].id,'那不再是草稿或副本，而是归档，是备份，是保留。']]));
    assert.equal(result.committed,true,result.reason);
    assert.equal(h.msg.mes,'那不再是草稿或副本。'+tail);
    assert.equal(h.meta().originalMes,target+tail);
    h.assertUntouched();
});

for (const kind of ['main', 'string', 'object']) test(`${kind}: synthetic sound suffix copy leaves the original message intact`, () => {
    const target='那只放在桌面的、带有金属搭扣的箱子，发出了轻微的',tail='“咔哒”声。';
    const h=harness(kind,target+tail);
    h.settings.rules[0].subRules[0].targets=['轻微'];
    const task=h.build();
    assert.equal(task.items.length,1);
    const result=applyAcceptedRewrites(task,new Map([[task.items[0].id,target+tail]]));
    assert.equal(result.committed,true,result.reason);
    assert.equal(h.msg.mes,target+tail);
    assert.equal(h.meta().originalMes,target+tail);
    h.assertUntouched();
});

for (const kind of ['main', 'string', 'object']) test(`${kind}: synthetic keeps word-order edit and removes only the copied subject`, () => {
    const prefix='架子上的铁盒“哐当”',target='一声掉在了地上，发出清脆的声响。',tail='\n\n管理员没有回头，也不需要回头。';
    const h=harness(kind,prefix+target+tail);
    h.settings.rules[0].subRules[0].targets=['一声'];
    const task=h.build();
    assert.equal(task.items.length,1);
    const result=applyAcceptedRewrites(task,new Map([[task.items[0].id,'铁盒掉在了地上，发出清脆的响声。']]));
    assert.equal(result.committed,true,result.reason);
    assert.equal(h.msg.mes,prefix+'掉在了地上，发出清脆的响声。'+tail);
    assert.equal(h.meta().originalMes,prefix+target+tail);
    h.assertUntouched();
});

for (const kind of ['main', 'string', 'object']) test(`${kind}: interior copied name preserves target facts and still applies independent edits`, () => {
    const target='面板上，有一行用激光刻下的、如今已与涂层融为一体的银色花体铭文，';
    const tail='“Archive”。\n他极其认真地记录。',original=target+tail;
    const h=harness(kind,original);
    h.settings.rules[0].subRules[0].targets=['铭文','极其'];
    const task=h.build();
    assert.equal(task.items.length,2);
    const replies=new Map(task.items.map(item=>[item.id,item.text.includes('铭文')
        ?'面板上有一行用激光刻下的银色花体铭文，“Archive”，已与涂层融为一体。':'他认真地记录。']));
    const result=applyAcceptedRewrites(task,replies);
    assert.equal(result.committed,true,result.reason);
    assert.equal(h.msg.mes,target+'“Archive”。\n他认真地记录。');
    assert.equal(h.meta().originalMes,original);
    h.assertUntouched();
});

test('accepted naming-fragment completion preserves external term and dialogue through actual writeback', () => {
    const target='管理员的语气里甚至带上了一丝可以称之为';
    const quote='“好的。既然是读者的请求，我们当然会认真地、及时地回复。”';
    const tail='“亲切”的笑意，'+quote;
    const h=harness('main',target+tail);
    h.settings.rules[0].subRules[0].targets=['甚至'];
    const task=h.build();
    assert.equal(task.items.length,1);
    const result=applyAcceptedRewrites(task,new Map([[task.items[0].id,'管理员的语气里带上了一丝笑意，'+quote]]));
    assert.equal(result.committed,true,result.reason);
    assert.equal(h.msg.mes,'管理员的语气里带上了一丝'+tail);
    assert.equal(h.meta().originalMes,target+tail);
    h.assertUntouched();
});

for (const kind of ['main', 'string', 'object']) {
    for (const previousAi of [false, true]) test(`${kind}: edits before request rebase ${previousAi ? 'AI' : 'Program'} history on successful commit`, () => {
        const h = harness(kind, edited, previousAi), previous = structuredClone(h.meta());
        const task = h.build();
        assert.equal(task.rebaseFromCurrentText, true);
        assert.equal(task.originalText, edited);
        assert.deepEqual(h.meta(), previous, 'building a request must not mutate history');
        const result = applyAcceptedRewrites(task, h.reply(task));
        assert.equal(result.committed, true, result.reason);
        assert.equal(h.msg.mes, rewritten + '\n“保留对白。”他拿起两个杯子。');
        assert.equal(h.meta().originalMes, edited);
        assert.equal(h.meta().programMes, h.msg.mes);
        if (kind !== 'main') assert.equal(typeof h.msg.swipes[1] === 'string' ? h.msg.swipes[1] : h.msg.swipes[1].mes, h.msg.mes);
        h.assertUntouched();
    });
}

test('unedited repeat request keeps retained Original and does not rebase', () => {
    const h = harness('main', oldProgram), task = h.build();
    assert.equal(task.rebaseFromCurrentText, false);
    assert.equal(task.originalText, oldOriginal);
    assert.equal(applyAcceptedRewrites(task, h.reply(task)).committed, true);
    assert.equal(h.meta().originalMes, oldOriginal);
});

for (const tail of ['<host-tail>unchanged</host-tail>', '\n\n<host-tail>unchanged</host-tail>']) {
    test('supported host tail survives without entering retained stage chain: ' + JSON.stringify(tail), () => {
        const h = harness('main', oldProgram + tail), task = h.build();
        assert.equal(task.rebaseFromCurrentText, false);
        assert.equal(applyAcceptedRewrites(task, h.reply(task)).committed, true);
        assert.equal(h.msg.mes, rewritten + tail);
        assert.equal(h.meta().programMes, rewritten);
    });
}
test('trimmed Program plus host suffix keeps native suffix semantics', () => {
    const previous = { originalMes: oldOriginal, aiMes: null, programMes: oldProgram + '\n', reverted: false };
    assert.deepEqual(resolveManualProgramTail(oldProgram + '\n\nHOST', previous), { tail: '\n\nHOST', trimProgramEnd: true });
    assert.equal(resolveManualProgramTail(edited, previous), null);
});

for (const [name, mutate, reason] of [
    ['edit while request pending', h => { h.msg.mes += '稍后编辑。'; }, 'message-text-changed'],
    ['swipe while request pending', h => { h.msg.swipe_id = 0; h.msg.mes = h.msg.swipes[0]; }, 'branch-changed'],
    ['message replacement', h => { h.chat[1] = structuredClone(h.msg); }, 'message-ref-changed'],
    ['revert protection', h => { setMessageDiffReverted(h.msg, true); }, 'message-reverted'],
    ['concurrent stage writer', h => { writeMessageDiffProgram(h.msg, h.key, '另一来源。', '另一结果。'); }, 'message-stage-changed'],
]) test(name + ' still rejects stale result', () => {
    const h = harness('string'), task = h.build(); mutate(h);
    const before = structuredClone(h.chat);
    assert.equal(applyAcceptedRewrites(task, h.reply(task)).reason, reason);
    assert.deepEqual(h.chat, before);
});

test('edited source without rule hits does not write metadata or resurrect old source', () => {
    const h = harness('main', '他检查柜子。'), before = structuredClone(h.chat);
    const result = buildAiRewriteTaskCheck(1, { manual: true });
    assert.equal(result.task, null); assert.match(result.reason, /未命中/);
    assert.deepEqual(h.chat, before);
});
test('new message without history still rewrites normally', () => {
    const h = harness(); delete h.msg.__blai_diff_branch_meta;
    const task = h.build(); assert.equal(task.rebaseFromCurrentText, false);
    assert.equal(task.originalText, edited);
    assert.equal(applyAcceptedRewrites(task, h.reply(task)).committed, true);
});
test('Program fallback on edited source preserves edits, dialogue, counts and applies normal cleanup', () => {
    const h = harness(), task = h.build();
    const result = applyProgramFallbackRewrites(task);
    assert.equal(result.committed, true, result.reason);
    assert.ok(h.msg.mes.includes('柜子')); assert.ok(!h.msg.mes.includes('桌面'));
    assert.ok(h.msg.mes.includes('“保留对白。”他拿起两个杯子。'));
    assert.equal(h.msg.mes.includes('—'), false);
    h.assertUntouched();
});

test('full manual request, valid model response, rebase and native atomic writeback succeed together', async () => {
    const h = harness('object'); let requests = 0;
    globalThis.fetch = async (_url,options) => { requests++; return { ok: true, status: 200, json: async () => ({ choices: [
        { message: { content: localEditResponse(JSON.parse(options.body).messages[0].content,{ 'hit-1': rewritten }) } } ] }) }; };
    await runAiRewriteForMessageNow(1, { manual: true });
    assert.equal(requests, 1); assert.ok(h.msg.mes.startsWith(rewritten));
    assert.equal(h.meta().originalMes, edited); h.assertUntouched();
});
test('cancelling an edited-body request preserves live text and old history', async () => {
    const h = harness(), before = structuredClone(h.chat);
    let started;
    const sent = new Promise(resolve => { started = resolve; });
    globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason || new DOMException('Aborted', 'AbortError')), { once: true }); started();
    });
    const running = runAiRewriteForMessageNow(1, { manual: true });
    await sent; cancelAiRewriteTask('fixture-cancel'); await running;
    assert.deepEqual(h.chat, before);
});

test('final Program processors still run on accepted AI output', () => {
    const h = harness(), task = h.build();
    const result = applyAcceptedRewrites(task, new Map(task.items.map(item => [item.id, '他检查柜子——随后离开。'])));
    assert.equal(result.committed, true);
    assert.equal(h.msg.mes, '他检查柜子，随后离开。\n“保留对白。”他拿起两个杯子。');
    assert.equal(applyScopedCompiledReplacements(h.meta().aiMes, task.programProcessors, task.settings), h.msg.mes);
});

test('native target selection and writeback trim a copied short quote while preserving both source quotes', () => {
    const source='“别怕。”档案管理员的声音像是恶魔的低语，温柔地安抚着，“只是确认一下。”';
    const h=harness('string',source);
    h.settings.rules[0].subRules[0].targets=['像是恶魔的低语'];
    const task=h.build();assert.equal(task.items.length,1);
    assert.equal(task.items[0].text,'档案管理员的声音像是恶魔的低语，温柔地安抚着，');
    const result=applyAcceptedRewrites(task,new Map([[task.items[0].id,'“别怕。”档案管理员说道，']]));
    assert.equal(result.committed,true,result.reason);
    assert.equal(h.msg.mes,'“别怕。”档案管理员说道，“只是确认一下。”');
    assert.equal(h.meta().originalMes,source);assert.equal(h.meta().programMes,h.msg.mes);h.assertUntouched();
});

test('native writeback removes the reported narration copy before punctuation cleanup, preserving actions and counts', () => {
    const sentence='档案管理员满意地看着这一切。';
    const source=sentence+'他极其认真地整理文件——随后拿起两个杯子。\n“保留对白。”';
    const h=harness('object',source),task=h.build();assert.equal(task.items.length,1);
    const result=applyAcceptedRewrites(task,new Map([[task.items[0].id,sentence+'他整理文件——随后拿起两个杯子。']]));
    assert.equal(result.committed,true,result.reason);
    assert.equal(h.msg.mes,sentence+'他整理文件，随后拿起两个杯子。\n“保留对白。”');
    assert.equal(h.meta().originalMes,source);assert.equal(h.meta().programMes,h.msg.mes);h.assertUntouched();
});

test('native selection around a quoted term trims an added long suffix without touching the term or other page', () => {
    const source='他以身为“刀”最重要、最珍视的职责，守护着这里的所有人。';
    const h=harness('string',source);h.settings.rules[0].subRules[0].targets=['职责'];
    const task=h.build();assert.equal(task.items.length,1);
    const tail='最重要、最珍视的职责，守护着这里的所有人。';
    assert.equal(task.items[0].text,tail);
    const result=applyAcceptedRewrites(task,new Map([[task.items[0].id,tail+'“刀”'+tail]]));
    assert.equal(result.committed,true,result.reason);
    assert.equal(h.msg.mes,source);assert.equal(h.meta().programMes,source);h.assertUntouched();
});

for (const kind of ['main', 'string', 'object']) {
    for (const [name, original, program] of [
        ['empty Original and Program', '', ''],
        ['empty Original but nonempty Program', '', '<content>他极其认真地检查柜子。</content>'],
        ['nonempty Original but empty Program', '<content>他极其认真地检查旧桌面。</content>', ''],
        ['whitespace-only Original and Program', ' \n ', '\n\n'],
    ]) test(`${kind}: ${name} cannot hide saved current content before a manual rewrite`, () => {
        const current='<content>他极其认真地检查柜子。</content>\n“保留对白。”他拿起两个杯子。';
        const h=harness(kind,current);
        h.settings.aiRewrite.xmlScopeTag='content';
        writeMessageDiffProgram(h.msg,h.key,original,program);
        const before=structuredClone(h.chat),task=h.build();
        assert.equal(task.originalText,current);assert.equal(task.rebaseFromCurrentText,true);
        assert.equal(task.items.length,1);assert.deepEqual(h.chat,before);
        const result=applyAcceptedRewrites(task,new Map([[task.items[0].id,'他认真地检查柜子。']]));
        assert.equal(result.committed,true,result.reason);
        assert.equal(h.msg.mes,'<content>他认真地检查柜子。</content>\n“保留对白。”他拿起两个杯子。');
        assert.equal(h.meta().originalMes,current);assert.equal(h.meta().programMes,h.msg.mes);
        h.assertUntouched();
    });
}

test('truly empty current message and empty history remain unsent without an API call or metadata changes', async () => {
    const h=harness('string','');writeMessageDiffProgram(h.msg,h.key,'','');
    clearAiRewriteDebugLog();
    const before=structuredClone(h.chat);let requests=0;
    globalThis.fetch=async()=>{requests++;throw new Error('Empty source must not be sent');};
    assert.equal(buildAiRewriteTaskCheck(1,{manual:true}).reason,'目标消息为空');
    await runAiRewriteForMessageNow(1,{manual:true});
    assert.equal(requests,0);assert.deepEqual(h.chat,before);
    const event=getAiRewriteRuntimeLog().find(item=>item.stage==='task-source-empty');
    assert.ok(event);assert.equal(event.details.index,1);assert.equal(event.details.currentTextLength,0);
    assert.equal(event.details.retainedOriginalLength,0);assert.equal(event.details.currentHasText,false);
    assert.equal(event.details.messageTextType,'string');
});

test('legitimately empty Program keeps nonempty retained Original when the live message is also empty', () => {
    const h=harness('string','');
    writeMessageDiffProgram(h.msg,h.key,oldOriginal,'');
    const task=h.build();assert.equal(task.rebaseFromCurrentText,false);assert.equal(task.originalText,oldOriginal);
});

test('a nonempty current body with stale empty history still requires a complete configured XML scope', () => {
    const h=harness('string','他极其认真地检查柜子。');
    h.settings.aiRewrite.xmlScopeTag='content';writeMessageDiffProgram(h.msg,h.key,'','');
    const before=structuredClone(h.chat),check=buildAiRewriteTaskCheck(1,{manual:true});
    assert.equal(check.task,null);assert.match(check.reason,/未找到完整 <content>/u);assert.deepEqual(h.chat,before);
});

for (const previousAi of [false,true]) test(`single Swipe 0: empty ${previousAi?'AI':'Program'} history rewrites current saved content through the complete manual request`, async () => {
    const current='<content>他极其认真地检查柜子。</content>\n“保留对白。”他拿起两个杯子。';
    const h=harness('main',current),priorMain=structuredClone(h.meta());
    h.settings.aiRewrite.xmlScopeTag='content';h.msg.swipe_id=0;h.msg.swipes=[current];
    if(previousAi)writeMessageDiffAiStage(h.msg,'swipe:0','','','');
    else writeMessageDiffProgram(h.msg,'swipe:0','','');
    let requests=0;
    globalThis.fetch=async(_url,options)=>{
        requests++;const body=JSON.parse(options.body);
        assert.ok(body.messages[0].content.includes('检查柜子'));assert.ok(!body.messages[0].content.includes('检查桌面'));
        return{ok:true,status:200,json:async()=>({choices:[{message:{content:localEditResponse(body.messages[0].content,{'hit-1':'他认真地检查柜子。'})}}]})};
    };
    await runAiRewriteForMessageNow(1,{manual:true});
    assert.equal(requests,1);
    assert.equal(h.msg.mes,'<content>他认真地检查柜子。</content>\n“保留对白。”他拿起两个杯子。');
    assert.equal(h.msg.swipes[0],h.msg.mes);
    assert.equal(getMessageDiffMeta(h.msg,'swipe:0').originalMes,current);
    assert.deepEqual(getMessageDiffMeta(h.msg,'main'),priorMain);h.assertUntouched();
});

test('native split targets keep earlier simile cleanup while trimming a comma/adverb variant of a copied quoted-term tail',()=>{
    const first='他像机器一样执行着',tail='的命令，每一次都用尽全力，将手中的两个零件，紧紧地固定在底座上。';
    const source=first+'“检查”'+tail,h=harness('object',source);
    h.settings.rules[0].subRules[0].targets=['像','每一次'];
    const task=h.build();assert.equal(task.items.length,2);
    const cleaned='的命令，每一次都用尽全力，将手中的两个零件紧紧固定在底座上。';
    const accepted=new Map(task.items.map(item=>[item.id,item.text===first?'他执行着':cleaned+'“检查”'+tail]));
    const result=applyAcceptedRewrites(task,accepted);
    assert.equal(result.committed,true,result.reason);assert.equal(h.msg.mes,'他执行着“检查”'+cleaned);
    assert.equal(h.meta().originalMes,source);assert.equal(h.meta().programMes,h.msg.mes);h.assertUntouched();
});

for(const kind of ['main','string','object']) test(`${kind}: preceding speech copied after cleaned narration is trimmed before punctuation and atomic writeback`,()=>{
    const quote='“管理员甲，放下它！”',target='档案管理员的声音里第一次出现了罕见的、近乎严厉的急切。';
    const tail='他拿来两个杯子——然后关上门。\n“保留后面的对白。”',source=quote+target+tail;
    const h=harness(kind,source);h.settings.rules[0].subRules[0].targets=['近乎严厉'];
    const task=h.build();assert.equal(task.items.length,1);assert.equal(task.items[0].text,target);
    const cleaned='档案管理员的声音里第一次出现了罕见的急切。';
    const result=applyAcceptedRewrites(task,new Map([[task.items[0].id,cleaned+'：'+quote]]));
    assert.equal(result.committed,true,result.reason);
    assert.equal(h.msg.mes,quote+cleaned+tail.replace('——','，'));
    assert.equal(h.meta().originalMes,source);assert.equal(h.meta().aiMes,quote+cleaned+tail);
    assert.equal(h.meta().programMes,h.msg.mes);h.assertUntouched();
});

for (const succeeds of [true, false]) test(`single request accepts clean result and explicitly reports uncertain interior copy: clean=${succeeds}`, async () => {
    const target='面板上，有一行用激光刻下的、如今已与涂层融为一体的银色花体铭文，';
    const tail='“Archive”。\n他极其认真地记录。';
    const h=harness('string',target+tail);
    h.settings.rules[0].subRules[0].targets=['铭文','极其'];
    const clean='面板上有一行以激光刻下、已与涂层融为一体的银色花体铭文，';
    const bad='面板上有一行用激光刻下的银色花体铭文，“Archive”，已与涂层融为一体。';
    let requests=0;
    globalThis.fetch=async(_url,options)=>{
        requests++;
        const prompt=JSON.parse(options.body).messages[0].content;
        const ids=[...prompt.matchAll(/<rewrite_target id="([^"]+)"/g)].map(match=>match[1]);
        const response=Object.fromEntries(ids.map((id,index)=>[id,index===0?(succeeds?clean:bad):'他认真地记录。']));
        return {ok:true,status:200,json:async()=>({choices:[{message:{content:localEditResponse(prompt,response)}}]})};
    };
    const result=await runAiRewriteForMessageNow(1,{manual:true});
    assert.equal(requests,1);
    assert.equal(result.status,succeeds?'applied':'partial');
    assert.equal(h.msg.mes,(succeeds?clean:target)+'“Archive”。\n他认真地记录。');
    assert.equal(h.meta().originalMes,target+tail);
    h.assertUntouched();
});

for (const mode of ['cancel', 'stale', 'invalid-json']) test(`single request respects ${mode} without correction calls`, async () => {
    const target='那里有极其清晰的、已与纸面融为一体的铭文，',tail='“确认”。';
    const h=harness('main',target+tail);let requests=0;
    globalThis.fetch=async(_url,options)=>{
        requests++;
        if(requests===1){
            if(mode==='stale')h.msg.mes='用户新写的正文。';
            if(mode==='cancel'){cancelAiRewriteTask();throw new DOMException('Aborted','AbortError');}
        }
        return{ok:true,status:200,json:async()=>({choices:[{message:{content:mode==='invalid-json'?'bad JSON':localEditResponse(JSON.parse(options.body).messages[0].content,{'hit-1':'那里有清晰的铭文，“确认”，已与纸面融为一体。'})}}]})};
    };
    await runAiRewriteForMessageNow(1,{manual:true});
    assert.equal(requests,1);
    assert.equal(h.msg.mes,mode==='stale'?'用户新写的正文。':(mode==='invalid-json'?target.replace('极其',''):target)+tail);
    h.assertUntouched();
});


test('restore retained result keeps stages, swipe and manual edits safe',()=>{
    const msg={mes:'原文',swipe_id:0,swipes:['原文','另一分支']};
    writeMessageDiffAiStage(msg,'swipe:0','原文','AI结果','最终结果');
    setMessageDiffReverted(msg,true);
    assert.equal(restoreMessageDiffResult(msg),true);
    assert.equal(msg.mes,'最终结果');assert.equal(msg.swipes[0],'最终结果');
    assert.equal(msg.swipes[1],'另一分支');assert.equal(getMessageDiffMeta(msg).aiMes,'AI结果');
    assert.equal(getMessageDiffMeta(msg).reverted,false);
    setMessageDiffReverted(msg,true);msg.mes='手动编辑';
    assert.equal(restoreMessageDiffResult(msg),false);assert.equal(msg.mes,'手动编辑');
    msg.swipe_id=1;assert.equal(restoreMessageDiffResult(msg),false);
    assert.equal(restoreMessageDiffResult({mes:'旧文',__blai_diff_branch_meta:{main:{reverted:true}}}),false);
});

test('local edits use real request/writeback and preserve the locked quoted action and neighboring sentence',async()=>{
 const target='他忽然拿起笔，在',tail='“选项”上画了两个圆圈。并没有离开。',source=target+tail;
 const h=harness('string',source);h.settings.rules[0].subRules[0].targets=['忽然'];
 globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({'hit-1':[{before:'忽然',occurrence:0,after:''}]})}}]})});
 await runAiRewriteForMessageNow(1,{manual:true});
 assert.equal(h.msg.mes,'他拿起笔，在'+tail);assert.equal(h.meta().aiMes,'他拿起笔，在'+tail);h.assertUntouched();
});
test('out-of-target edit is rejected without another request or overwriting locked source',async()=>{
 const target='他忽然拿起笔，在',tail='“选项”上画了两个圆圈。并没有离开。',h=harness('string',target+tail);
 h.settings.rules[0].subRules[0].targets=['忽然'];let calls=0;
 globalThis.fetch=async()=>{calls++;return {ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({'hit-1':[{before:'并没有离开',occurrence:0,after:'离开了'}]})}}]})}};
 await runAiRewriteForMessageNow(1,{manual:true});
 assert.equal(calls,1);assert.ok(h.msg.mes.endsWith(tail));h.assertUntouched();
});

test('unchanged model output is not reported as completed cleanup', async()=>{
 const h=harness('string','他极其认真地记录。');
 globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({choices:[{message:{content:'{"hit-1":[]}'}}]})});
 const result=await runAiRewriteForMessageNow(1,{manual:true});
 assert.equal(result.status,'unchanged-targets');
 assert.equal(h.msg.mes,'他极其认真地记录。');h.assertUntouched();
});

for(const streamingEnabled of [false,true]) test(`private preset integration cleans matched wording: stream=${streamingEnabled}`,
 {skip:!process.env.VERIDIS_PRIVATE_PRESET},async()=>{
 const {readFileSync}=await import('node:fs');
 const preset=JSON.parse(readFileSync(process.env.VERIDIS_PRIVATE_PRESET,'utf8'));
 const source='<content>他忽然拿起笔，在“选项”上画了两个圆圈。\n他极其认真地记录。\n“忽然，别走。”\n他没有离开。又检查了两遍。</content>';
 const h=harness('string',source);
 h.settings.rules=preset.rules;
 h.settings.aiRewrite.streamingEnabled=streamingEnabled;
 const sse=readFileSync(process.env.VERIDIS_SSE_SOURCE,'utf8');
 const EventSourceStream=new Function(sse.slice(sse.indexOf('class EventSourceStream'),sse.indexOf('function getDelay'))+';return EventSourceStream;')();
 initAppContext({createEventSourceStream:async()=>new EventSourceStream()});
 const task=h.build();
 assert.ok(task.items.some(item=>item.text.includes('忽然')));
 assert.ok(task.items.some(item=>item.text.includes('极其')));
 let calls=0;
 globalThis.fetch=async(_url,options)=>{
  calls++;
  const body=JSON.parse(options.body);assert.equal(body.stream,streamingEnabled);
  const prompt=body.messages[0].content;
  assert.ok(prompt.includes('最终输出格式'));
  const targets=[...prompt.matchAll(/<rewrite_target id="([^"]+)"[^>]*>([\s\S]*?)<\/rewrite_target>/g)];
  const answer=JSON.stringify(Object.fromEntries(targets.map(m=>[m[1],
   m[2].replace('忽然','').replace('极其','')])));
  if(!streamingEnabled)return new Response(JSON.stringify({choices:[{message:{content:answer}}]}),{headers:{'Content-Type':'application/json'}});
  const event='data: '+JSON.stringify({choices:[{index:0,delta:{content:answer}}]})+'\n\ndata: [DONE]\n\n';
  const bytes=new TextEncoder().encode(event);
  return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=7)c.enqueue(bytes.slice(i,i+7));c.close();}}),{headers:{'Content-Type':'text/event-stream'}});
 };
 const result=await runAiRewriteForMessageNow(1,{manual:true});
 assert.ok(['applied','unchanged-targets'].includes(result.status),result.status);
 assert.equal(calls,1);
 assert.equal(h.msg.mes,source.replace('他忽然','他').replace('他极其','他'));
 assert.equal(h.meta().originalMes,source);h.assertUntouched();
});

test('original string protocol removes copied nominal speech while completing cleanup',async()=>{
 const prefix='那句“我们是一家人，不是吗？”',target='如同一颗投入静水的小石，在他心里激起涟漪。',tail='他没有离开。';
 const h=harness('string',prefix+target+tail);h.settings.rules[0].subRules[0].targets=['如同'];
 globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({'hit-1':prefix+'让他心中泛起波动。'})}}]})});
 const result=await runAiRewriteForMessageNow(1,{manual:true});
 assert.equal(result.status,'applied');assert.equal(h.msg.mes,prefix+'让他心中泛起波动。'+tail);
 assert.equal(h.meta().originalMes,prefix+target+tail);h.assertUntouched();
});

test('paraphrased protected mode is corrected without discarding the requested cleanup',async()=>{
 const target='他下意识地抬起头，看向同事，努力从思绪中抽离，进入',tail='“公务模式”。';
 const h=harness('string',target+tail);h.settings.rules[0].subRules[0].targets=['下意识'];
 let calls=0;
 globalThis.fetch=async()=>{calls++;return {ok:true,status:200,json:async()=>({choices:[{message:{content:JSON.stringify({'hit-1':calls===1?'他抬起头，看向同事，努力从思绪中抽离，进入公务状态。':'他抬起头，看向同事，努力从思绪中抽离，进入'})}}]})};};
 const result=await runAiRewriteForMessageNow(1,{manual:true});
 assert.equal(calls,1);assert.equal(result.status,'applied');
 assert.equal(h.msg.mes,target.replace('下意识地','')+tail);
 assert.equal(h.meta().originalMes,target+tail);h.assertUntouched();
});

for (const streamingEnabled of [false,true]) test(`recorded quoted completions retain cleanup with one request: stream=${streamingEnabled}`,async()=>{
 const {readFileSync}=await import('node:fs');
 const fixtures=process.env.VERIDIS_PRIVATE_BOUNDARY_CASES
  ? JSON.parse(readFileSync(process.env.VERIDIS_PRIVATE_BOUNDARY_CASES,'utf8'))
  : [{id:'hit-1',target:'这句话，彻底打破了他建立起来的那套',tail:'“效率”的逻辑。它绕过了所有关于“职责”的思考。',bad:'这句话，打破了他建立起来的那套逻辑。它绕过了关于职责的思考。',expected:'这句话，打破了他建立起来的那套'}];
 const sse=readFileSync(process.env.VERIDIS_SSE_SOURCE || new URL('../../compat-reference/sse-stream.js',import.meta.url),'utf8');
 const EventSourceStream=new Function(sse.slice(sse.indexOf('class EventSourceStream'),sse.indexOf('function getDelay'))+';return EventSourceStream;')();
 for(const f of fixtures){
  const h=harness('string',f.target+f.tail);
  h.settings.rules[0].subRules[0].targets=[f.target];
  h.settings.rules[0].subRules[1].enabled=false;
  h.settings.aiRewrite.streamingEnabled=streamingEnabled;
  // Even a user-configured retry budget must not be used to correct content.
  h.settings.aiRewrite.maxRetries=3;
  initAppContext({createEventSourceStream:async()=>new EventSourceStream()});
  const task=h.build();assert.equal(task.items.length,1);assert.equal(task.items[0].text,f.target);
  let requests=0;
  globalThis.fetch=async(_url,options)=>{
   requests++;assert.equal(JSON.parse(options.body).stream,streamingEnabled);
   const answer=JSON.stringify({[task.items[0].id]:f.bad});
   if(!streamingEnabled)return new Response(JSON.stringify({choices:[{message:{content:answer}}]}),{headers:{'Content-Type':'application/json'}});
   const bytes=new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:answer}}]})+'\n\ndata: [DONE]\n\n');
   return new Response(new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=5)c.enqueue(bytes.slice(i,i+5));c.close();}}),{headers:{'Content-Type':'text/event-stream'}});
  };
  const result=await runAiRewriteForMessageNow(1,{manual:true});
  assert.equal(requests,1);assert.equal(result.status,'applied');
  const expected=f.expected;
  assert.notEqual(expected,f.target,'must actually retain the model cleanup');
  assert.equal(h.msg.mes,expected+f.tail);assert.equal(h.meta().originalMes,f.target+f.tail);
  h.assertUntouched();
 }
});
test('unchanged AI targets persist even with no body changes and clear on a later clean result', () => {
    const h = harness('string', '他极其认真。');
    const task = h.build();
    const reply = new Map(task.items.map(item => [item.id, item.text]));
    const result = applyAcceptedRewrites(task, reply);
    assert.equal(result.unchangedCount, 1);
    assert.equal(h.meta().aiUnchanged.length, 1);
    const range = h.meta().aiUnchanged[0];
    assert.equal(h.meta().originalMes.slice(range.start, range.end), '他极其认真。');
    assert.equal(range.reason, 'unchanged');
    assert.deepEqual(getMessageDiffMeta(JSON.parse(JSON.stringify(h.msg))).aiUnchanged, h.meta().aiUnchanged);
    h.assertUntouched();
    const next = h.build();
    applyAcceptedRewrites(next, new Map(next.items.map(item => [item.id, '他认真。'])));
    assert.equal(h.meta().aiUnchanged, undefined);
    assert.equal(h.msg.mes, '他认真。');
});
