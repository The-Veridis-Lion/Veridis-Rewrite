import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trimCopiedBoundaryDialogue } from '../src/aiRewrite/boundaryDialogue.js';
const replace = (source, target, rewritten) => ({start: source.indexOf(target), end: source.indexOf(target) + target.length, rewritten});
const guard = (source, replacements) => {
    const before = structuredClone(replacements), result = trimCopiedBoundaryDialogue(source, replacements);
    assert.deepEqual(replacements, before);
    return { ...result, text: result.replacements.slice().sort((a,b)=>b.start-a.start).reduce((text,r)=>text.slice(0,r.start)+r.rewritten+text.slice(r.end),source) };
};

test('empty predicate after a nominal quoted response is rejected without deleting source',()=>{
    const prefix='那一声迟疑的“好！”',target='，像一颗石子，落入他的心中。',source=prefix+target;
    const result=guard(source,[replace(source,target,'')]);
    assert.equal(result.text,source);
    assert.equal(result.replacements[0].strategy,'boundary-dialogue-rejected');
    assert.equal(guard(source,[replace(source,target,'，让他感到安慰。')]).text,prefix+'，让他感到安慰。');
});
test('empty standalone descriptions and predicates after complete speech remain allowed',()=>{
    for(const [prefix,target] of [['','因为用力而泛白。'],['他说“好！”','，像一颗石子。']]) {
        const source=prefix+target;
        assert.equal(guard(source,[replace(source,target,'')]).text,prefix);
    }
});

test('leading paired terms and narration plus term are removed only from generated prefix',()=>{
    for (const [before,target,value,kept] of [
        ['一种用“礼貌”和“沉稳”','精心包裹起来的东西，出现了裂缝。','“礼貌”和“沉稳”的外壳，出现了裂缝。','的外壳，出现了裂缝。'],
        ['我想确认，“登记”','这个仪式，对他而言，是否依然重要。','我想确认“登记”这个仪式，对他而言是否依然重要。','这个仪式，对他而言是否依然重要。'],
    ]) {
        const source=before+target, result=guard(source,[replace(source,target,value)]);
        assert.equal(result.text,before+kept);
        assert.equal(trimCopiedBoundaryDialogue(source,result.replacements).removedCount,0);
        assert.equal(guard(source,[replace(source,target,value),replace(source,before,'其他前文')]).replacements[0].rewritten,value);
    }
});
test('leading context guard preserves different negation and quoted source facts',()=>{
    const before='我不想确认，“登记”',target='这个仪式是否重要。',source=before+target;
    const value='我想确认“登记”这个仪式是否重要。';
    assert.equal(guard(source,[replace(source,target,value)]).replacements[0].rewritten,value);
    assert.equal(guard(value,[replace(value,value,value)]).text,value);
});

test('short quoted modifier copies with omitted linker or comma keep external text once',()=>{
    for (const [target,tail,value,kept] of [
        ['管理员没有追问来意，也没有表示好奇，只是将安排纳入既有的、名为','“日常”的轨道里。','管理员没有追问来意，也没有表示好奇，只是将安排纳入既有的“日常”轨道里。','管理员没有追问来意，也没有表示好奇，只是将安排纳入既有的'],
        ['管理员的声音里带着一丝几乎可以称之为','“哄劝”的意味，“请先登记，好吗？”','管理员的声音里带着一丝“哄劝”的意味，','管理员的声音里带着一丝'],
    ]) {
        const source=target+tail, result=guard(source,[replace(source,target,value)]);
        assert.equal(result.text,kept+tail);
        assert.equal(result.removedCount,1);
        assert.equal(trimCopiedBoundaryDialogue(source,result.replacements).removedCount,0);
    }
});

test('quoted suffix guard preserves changed facts, punctuation, neighbors and source repetitions',()=>{
    const target='他没有拒绝这项所谓的',tail='“日常”的安排。',source=target+tail;
    for (const value of ['他没有拒绝“日常”安排！','他没有拒绝“日常”计划。','他没有拒绝“特殊”安排。','“日常”安排。'])
        assert.equal(guard(source,[replace(source,target,value)]).replacements[0].rewritten,value);
    const value='他没有拒绝“日常”安排。';
    assert.equal(guard(source,[replace(source,target,value),replace(source,'的安排。','的计划。')]).replacements[0].rewritten,value);
    assert.equal(guard(source+tail,[replace(source+tail,target,value)]).text,'他没有拒绝'+tail+tail);
    assert.equal(guard(value,[replace(value,value,value)]).text,value);
});

test('synthetic internal copied name rejects only the unsafe replacement without losing its relocated fact',()=>{
    const target='面板上，有一行用激光刻下的、如今已与涂层融为一体的银色花体铭文，';
    const source=target+'“Archive”。';
    const value='面板上有一行用激光刻下的银色花体铭文，“Archive”，已与涂层融为一体。';
    const result=guard(source,[replace(source,target,value)]);
    assert.equal(result.text,source);
    assert.equal(result.replacements[0].strategy,'boundary-dialogue-rejected');
    assert.equal(result.removedCount,0);
});

test('internal copied quote fallback is local and does not reject unrelated or original quoted facts',()=>{
    const target='那里有一道复杂的铭文，',next='他极其认真地记录。',source=target+'“Archive”。'+next;
    const value='那里有一道铭文，“Archive”，已经刻好了。';
    const result=guard(source,[replace(source,target,value),replace(source,next,'他认真地记录。')]);
    assert.equal(result.text,target+'“Archive”。他认真地记录。');
    const different='那里有一道铭文，“Other”，已经刻好了。';
    assert.equal(guard(source,[replace(source,target,different)]).replacements[0].rewritten,different);
    assert.equal(guard(source,[replace(source,target,value),replace(source,'“Archive”','“Other”')]).replacements[0].rewritten,value);
    const quoted='原名是“Archive”，已经刻好了。';
    assert.equal(guard(quoted,[replace(quoted,quoted,quoted)]).text,quoted);
});

test('synthetic subject copied across a sound quote is trimmed, while word reordering is retained',()=>{
    const prefix='架子上的铁盒“哐当”',target='一声掉在了地上，发出清脆的声响。';
    const source=prefix+target+'\n\n管理员没有回头，也不需要回头。';
    const result=guard(source,[replace(source,target,'铁盒掉在了地上，发出清脆的响声。')]);
    assert.equal(result.text,prefix+'掉在了地上，发出清脆的响声。\n\n管理员没有回头，也不需要回头。');
    assert.equal(result.removedCount,1);
    assert.equal(trimCopiedBoundaryDialogue(source,result.replacements).removedCount,0);
});

test('sound subject guard preserves different actions, subjects, negation and edited source anchors',()=>{
    const prefix='架子上的铁盒“哐当”',target='一声掉在了地上，发出清脆的声响。',source=prefix+target;
    for(const value of ['杯子掉在了地上，发出清脆的响声。','铁盒没有掉在了地上。','铁盒掉进了水里，发出清脆的响声。'])
        assert.equal(guard(source,[replace(source,target,value)]).replacements[0].rewritten,value);
    const value='铁盒掉在了地上，发出清脆的响声。';
    assert.equal(guard(source,[replace(source,'架子上的铁盒','你的杯子'),replace(source,target,value)]).replacements[1].rewritten,value);
    const own='一声之后，铁盒掉在了地上。',full=prefix+own;
    assert.equal(guard(full,[replace(full,own,'铁盒掉在了地上。')]).replacements[0].rewritten,'铁盒掉在了地上。');
});

test('synthetic copies a sound quote with an unlinked noun suffix',()=>{
    const target='那只放在桌面的、带有金属搭扣的箱子，发出了轻微的';
    const tail='“咔哒”声。',source=target+tail;
    const result=guard(source,[replace(source,target,source)]);
    assert.equal(result.text,source);
    assert.equal(result.replacements[0].rewritten,target);
    assert.equal(result.removedCount,1);
    assert.equal(trimCopiedBoundaryDialogue(source,result.replacements).removedCount,0);
});

test('unlinked quoted suffix trimming requires exact preserved continuation and nonempty narration',()=>{
    const target='盒子发出了轻微的',tail='“咔哒”声。',source=target+tail;
    for(const response of ['盒子发出了轻微的“咔哒”响声。','盒子发出了轻微的“砰”声。'])
        assert.equal(guard(source,[replace(source,target,response)]).replacements[0].rewritten,response);
    const output=source;
    assert.equal(guard(source,[replace(source,target,output),replace(source,'声。','响声。')]).replacements[0].rewritten,output);
    assert.equal(guard(source+tail,[replace(source+tail,target,output)]).text,source+tail);
});

test('copied following quoted term plus its external full stop is removed together',()=>{
    const target='他想阅读这未知的、由编辑主导的新';
    const source=target+'“章节”。后文保留。';
    const result=guard(source,[replace(source,target,'他想阅读这未知的“章节”。')]);
    assert.equal(result.text,'他想阅读这未知的“章节”。后文保留。');
    assert.equal(result.removedCount,1);
});

test('a copied quoted term with a noun and full stop is removed as one external suffix',()=>{
    const target='纸面留下了清晰的、名为',tail='“确认”的印记。',source=target+tail;
    const result=guard(source,[replace(source,target,'纸面留下了'+tail)]);
    assert.equal(result.text,'纸面留下了'+tail);
    assert.equal(result.removedCount,1);
    assert.equal(trimCopiedBoundaryDialogue(source,result.replacements).removedCount,0);
});

test('quoted noun suffix changes and existing repeated source suffixes are preserved',()=>{
    const target='纸面留下了清晰的、名为',tail='“确认”的印记。',source=target+tail;
    for(const response of ['纸面留下了“确认”的字迹。','纸面留下了“撤销”的印记。',tail]) {
        assert.equal(guard(source,[replace(source,target,response)]).replacements[0].rewritten,response);
    }
    const response='纸面留下了'+tail;
    assert.equal(guard(source,[replace(source,target,response),replace(source,'的印记。','的字迹。')]).replacements[0].rewritten,response);
    assert.equal(guard(source+tail,[replace(source+tail,target,response)]).text,'纸面留下了'+tail+tail);
});

test('punctuated term repair does not cut uncertain punctuation or changed retained ranges',()=>{
    const target='这是所谓的新',source=target+'“章节”。';
    for(const response of ['这是“章节”！','这是“作业”。','“章节”。']) {
        assert.equal(guard(source,[replace(source,target,response)]).replacements[0].rewritten,response);
    }
    const response='这是“章节”。';
    assert.equal(guard(source,[replace(source,target,response),replace(source,'。','！')]).replacements[0].rewritten,response);
    const repeated=source+'“章节”。';
    assert.equal(guard(repeated,[replace(repeated,target,response)]).text,'这是“章节”。“章节”。');
});

test('a naming fragment completed with the retained noun and speech is spliced before the original term',()=>{
    const target='管理员的语气里甚至带上了一丝可以称之为';
    const quote='“好的。既然是读者的请求，我们当然会认真地、及时地回复。”';
    const tail='“亲切”的笑意，'+quote,source=target+tail;
    const result=guard(source,[replace(source,target,'管理员的语气里带上了一丝笑意，'+quote)]);
    assert.equal(result.text,'管理员的语气里带上了一丝'+tail);
    assert.equal(result.removedCount,1);
    assert.equal(trimCopiedBoundaryDialogue(source,result.replacements).removedCount,0);
});

test('quoted term repair preserves original repeat speech and works with other quoted nouns',()=>{
    const target='他的表情带着可以称为',quote='「请进。请进。」';
    const tail='「礼貌」的微笑，'+quote;
    assert.equal(guard(target+tail,[replace(target+tail,target,'他的表情带着微笑，'+quote)]).text,'他的表情带着'+tail);
});

test('uncertain completions, changed neighbors and a copied quote without noun do not authorize cutting',()=>{
    const target='管理员的语气里甚至带上了一丝可以称之为',quote='“请进。”',tail='“亲切”的笑意，'+quote,source=target+tail;
    for(const output of ['管理员的语气里带上了一丝笑意，“请停下。”','管理员的语气里带上了一丝怒意，'+quote,'笑意，'+quote,'他回答，带上笑意，'+quote]){
        assert.equal(guard(source,[replace(source,target,output)]).replacements[0].rewritten,output);
    }
    const r=replace(source,target,'管理员的语气里带上了一丝笑意，'+quote);
    assert.equal(guard(source,[r,replace(source,'的笑意，','的怒意，')]).replacements[0].rewritten,r.rewritten);
    const separated=target+'“亲切”的笑意。'+quote;
    assert.equal(guard(separated,[replace(separated,target,r.rewritten)]).replacements[0].rewritten,r.rewritten);
});
test('short dialogue copied before narration is removed without undoing simile cleanup', () => {
    const source='“别怕。”档案管理员的声音像是恶魔的低语，温柔地安抚着，“只是确认一下。”';
    const target='档案管理员的声音像是恶魔的低语，温柔地安抚着，';
    const result=guard(source,[replace(source,target,'“别怕。”档案管理员说道，')]);
    assert.equal(result.text,'“别怕。”档案管理员说道，“只是确认一下。”');assert.equal(result.removedCount,1);
});
test('copied next dialogue is removed while retaining the already cleaned narration', () => {
    const target='他的声音仿佛在远处传来，',source=target+'“先放松……再慢慢说。”';
    const result=guard(source,[replace(source,target,'他说道，“先放松再慢慢说。”')]);
    assert.equal(result.text,'他说道，“先放松……再慢慢说。”');assert.equal(result.removedCount,1);
});
for(const [open,close] of [['“','”'],['「','」'],['『','』'],['"','"'],["'","'"],['«','»']]) {
    test('short copy with '+open+close+' quote pair and boundary whitespace',()=>{
        const quote=open+'别怕。'+close,target='他轻声说道，',source=quote+'\n'+target;
        const result=guard(source,[replace(source,target,'  '+quote+'\n'+target)]);
        assert.equal(result.text,quote+'\n\n'+target);assert.equal(result.removedCount,1);
    });
}
test('both boundary copies and repeated added copies are trimmed locally',()=>{
    const target='他像秘书般回答，',source='“别怕。”'+target+'“继续。”';
    const result=guard(source,[replace(source,target,'“别怕。”“别怕。”他说道，“继续。”')]);
    assert.equal(result.text,'“别怕。”他说道，“继续。”');assert.equal(result.removedCount,3);
});
test('preexisting repeated speech, actions and normal counts are preserved',()=>{
    const target='他像秘书般回答，',source='“别怕。”“别怕。”'+target+'“拿两个杯子，再拿两条毛巾。”';
    const result=guard(source,[replace(source,target,'他拿起杯子，回答，')]);
    assert.equal(result.text,'“别怕。”“别怕。”他拿起杯子，回答，“拿两个杯子，再拿两条毛巾。”');assert.equal(result.removedCount,0);
});
test('quoted source targets are never deduplicated by this narration boundary guard',()=>{
    const source='“别怕。”“别怕。”',target=source.slice(5),result=guard(source,[replace(source,target,target)]);
    assert.equal(result.text,source);assert.equal(result.removedCount,0);
});
for(const source of ['```\n“别怕。”他像秘书般回答，\n```','<!--“别怕。”他像秘书般回答，-->','“他说‘别怕。’他像秘书般回答，”']) {
    test('enclosing code, comments or dialogue are protected: '+source.slice(0,15),()=>{
        const target='他像秘书般回答，',r=replace(source,target,'“别怕。”他说道，');
        assert.equal(guard(source,[r]).removedCount,0);
    });
}
test('different or nonadjacent dialogue is not treated as a proven copy',()=>{
    for(const [source,output] of [['“别怕。”他停下。他像秘书般回答，','“别怕。”他说道，'],['“别怕。”他像秘书般回答，','“别动。”他说道，']]){
        assert.equal(guard(source,[replace(source,'他像秘书般回答，',output)]).removedCount,0);
    }
});
test('a changed neighboring target cannot authorize deletion of dialogue',()=>{
    const target='他像秘书般回答，',source='“别怕。”'+target;
    const result=guard(source,[replace(source,'“别怕。”','“别动。”'),replace(source,target,'“别怕。”他说道，')]);
    assert.equal(result.removedCount,0);
});
test('a response consisting only of copied dialogue is not silently changed into deletion',()=>{
    const target='他像秘书般回答，',source='“别怕。”'+target;
    const result=guard(source,[replace(source,target,'“别怕。”')]);assert.equal(result.removedCount,0);
});
test('a quote inside generated code or an enclosing quote is not cut as boundary speech',()=>{
    const target='他像秘书般回答，';
    for(const [quote,output] of [['“别怕。”','```text\n他说道，“别怕。”'],['‘别怕。’','“转述他说道，‘别怕。’']]){
        const source=target+quote;
        assert.equal(guard(source,[replace(source,target,output)]).removedCount,0);
    }
});

test('the reported preceding dialogue copied after narration is removed together with its added colon',()=>{
    const quote='“管理员甲，放下它！”',target='档案管理员的声音里第一次出现了罕见的、近乎严厉的急切。';
    const source=quote+target,cleaned='档案管理员的声音里第一次出现了罕见的急切。';
    for(const connector of ['：',':',' ： ', '：:']){
        const result=guard(source,[replace(source,target,cleaned+connector+quote)]);
        assert.equal(result.text,quote+cleaned);assert.equal(result.removedCount,1);
    }
});

test('a following quote copied before narration is removed without touching the original quote',()=>{
    const target='他像秘书般回答，',quote='“先放松。”',source=target+quote;
    const result=guard(source,[replace(source,target,quote+'他回答，')]);
    assert.equal(result.text,'他回答，'+quote);assert.equal(result.removedCount,1);
});

test('all generated boundary copies can refer to either untouched source neighbor',()=>{
    const target='他像秘书般回答，',source='“别怕。”'+target+'“继续。”';
    const result=guard(source,[replace(source,target,'“继续。”他回答，：“别怕。”')]);
    assert.equal(result.text,'“别怕。”他回答，“继续。”');assert.equal(result.removedCount,2);
});

test('an added speech colon is removed and original terminal punctuation is restored when necessary',()=>{
    for(const ending of ['。','，','！','；']){
        const target='他像秘书般回答'+ending,source='“别怕。”'+target;
        assert.equal(guard(source,[replace(source,target,'他回答：“别怕。”')]).text,'“别怕。”他回答'+ending);
    }
});

test('a source speech colon before retained following dialogue is preserved',()=>{
    const target='他像秘书般回答：',source='“别怕。”'+target+'“继续。”';
    assert.equal(guard(source,[replace(source,target,'他回答：“别怕。”')]).text,'“别怕。”他回答：“继续。”');
});

test('cross-boundary removal remains conservative for changed neighbors, quoted source and copy-only responses',()=>{
    const target='他像秘书般回答。',quote='“别怕。”',source=quote+target;
    assert.equal(guard(source,[replace(source,quote,'“别动。”'),replace(source,target,'他回答：'+quote)]).removedCount,0);
    assert.equal(guard(source,[replace(source,target,'：'+quote)]).removedCount,0);
    const first=guard(source,[replace(source,target,'他回答。'+quote)]);
    assert.deepEqual(trimCopiedBoundaryDialogue(source,first.replacements),{replacements:first.replacements,removedCount:0});
});


test('unquoted paraphrase of a retained named term is rejected for correction',()=>{
    const target='室内的茶香尚未散尽，构成了一种名为',tail='“日常”的、令人安心的氛围。大家收起杯子。',source=target+tail;
    const result=guard(source,[replace(source,target,'室内的茶香尚未散尽，构成了一幅令人安心的日常图景。')]);
    assert.equal(result.replacements[0].strategy,'boundary-dialogue-rejected');
    assert.equal(result.text,source);
    assert.equal(guard(source,[replace(source,target,'室内的茶香尚未散尽，形成了')]).text,'室内的茶香尚未散尽，形成了'+tail);
});
test('named-term guard preserves original facts and changed neighbors',()=>{
    const target='日常工作构成了一种名为',source=target+'“日常”的氛围。';
    assert.equal(guard(source,[replace(source,target,'日常工作形成了')]).replacements[0].strategy,undefined);
    const t='茶香构成了一种名为',s=t+'“日常”的氛围。';
    assert.equal(guard(s,[replace(s,t,'茶香构成日常图景。'),replace(s,'“日常”','“生活”')]).replacements[0].strategy,undefined);
    assert.equal(guard(s,[replace(s,t,'茶香形成了')]).text,'茶香形成了“日常”的氛围。');
});

test('retained quoted option and complete action tail are trimmed despite a comma change',()=>{
 const target='他拿起朱笔，不再是询问，而是在',tail='“绿茶”的选项上，画下了一个清晰而有力的圆圈。',source=target+tail;
 const clean='他拿起朱笔，在';
 const result=guard(source,[replace(source,target,clean+tail.replace('上，','上'))]);
 assert.equal(result.text,clean+tail);
 assert.equal(result.replacements[0].strategy,'boundary-dialogue-trimmed');
 for(const changed of [tail.replace('一个','两个'),tail.replace('画下','没有画下')]){
  const response=clean+changed;
  assert.equal(guard(source,[replace(source,target,response)]).replacements[0].rewritten,response);
 }
 assert.equal(guard(source,[replace(source,target,clean+tail),replace(source,tail,'其他事件。')]).removedCount,0);
});

test('copied exact nominal quote is removed, changed quotes and changed neighboring targets are preserved',()=>{
 const prefix='那句“不要离开。”',target='像石子落入心中。',source=prefix+target;
 const clean='让他心中泛起波动。';
 assert.equal(guard(source,[replace(source,target,prefix+clean)]).text,prefix+clean);
 const changed='那句“可以离开。”'+clean;
 assert.equal(guard(source,[replace(source,target,changed)]).text,prefix+changed);
 const result=guard(source,[{start:0,end:2,rewritten:'这句话'},replace(source,target,prefix+clean)]);
 assert.equal(result.replacements[1].rewritten,prefix+clean);
});

test('nominal speech with modifiers and whitespace preserves source and cleaned predicate',()=>{
 for(const prefix of ['那句带着绝对信赖的“我们是一家人，不是吗？”','这句带着迟疑的 “请留下。”']){
  const target='，像一颗投入深潭的石子，在他心中激起巨浪。',source='前句。\n'+prefix+target;
  const clean='让他心中产生了剧烈的震颤。';
  assert.equal(guard(source,[replace(source,target,prefix+clean)]).text,'前句。\n'+prefix+clean);
  assert.equal(guard(source,[replace(source,target,prefix)]).text,source);
 }
});


test('anchored paraphrase projection retains cleanup and every original external byte',()=>{
 const target='这句话，彻底打破了他建立起来的那套';
 const tail='“效率”的逻辑。它绕过了所有关于“职责”的思考。\n他没有离开，又检查了两遍。';
 const value='这句话，打破了他建立起来的那套逻辑。它绕过了关于职责的思考。';
 const result=guard(target+tail,[replace(target+tail,target,value)]);
 assert.equal(result.text,'这句话，打破了他建立起来的那套'+tail);
 assert.notEqual(result.replacements[0].rewritten,target);
 assert.equal(trimCopiedBoundaryDialogue(target+tail,result.replacements).removedCount,0);
});

test('anchored projection does not trim moved target facts, changed neighbors or complete sentences',()=>{
 const target='他确认计划已经取消，准备进入', tail='“登记”流程。', source=target+tail;
 const moved='他准备进入“登记”流程，原计划已经取消。';
 assert.equal(guard(source,[replace(source,target,moved)]).replacements[0].rewritten,moved);
 const copied='他确认计划已经取消，准备进入“登记”流程。';
 assert.equal(guard(source,[replace(source,target,copied),replace(source,'流程。','房间。')]).replacements[0].rewritten,copied);
 const complete='他没有进入。';
 assert.equal(guard(complete+tail,[replace(complete+tail,complete,'他没有进入“登记”流程。')]).replacements[0].rewritten,'他没有进入“登记”流程。');
});


test('external cause projection preserves the original negative fact and completes contrast cleanup',()=>{
 const target='他不是在哭泣，而是在颤抖。',tail='为这份他从未想象过的、被珍视的感觉。';
 const value='他因这份从未想象过的、被珍视的感觉而颤抖。';
 const result=guard(target+tail,[replace(target+tail,target,value)]);
 assert.equal(result.text,'他在颤抖，没有哭泣。'+tail);
 assert.equal(result.replacements[0].strategy,'boundary-dialogue-trimmed');
 assert.equal(trimCopiedBoundaryDialogue(target+tail,result.replacements).removedCount,0);
 for(const other of ['她因这份从未想象过的、被珍视的感觉而颤抖。','他因这份从未想象过的、被珍视的感觉而哭泣。','他因完全不同的原因与对象而颤抖。'])
  assert.equal(guard(target+tail,[replace(target+tail,target,other)]).replacements[0].rewritten,other);
 const changed=guard(target+tail,[replace(target+tail,target,value),replace(target+tail,tail,'为了别的原因。')]);
 assert.equal(changed.replacements[0].rewritten,value);
});
test('quoted object completion with a relocated proven predicate keeps target cleanup', () => {
    const target='这些词组合在一起，形成了洪流，瞬间冲垮了他心中最后一道名为';
    const tail='“顾虑”的堤坝。';
    const value='这些词组合在一起，让他心中最后一道名为“顾虑”的堤坝瞬间冲垮。';
    const result=guard(target+tail,[replace(target+tail,target,value)]);
    assert.equal(result.text,'这些词组合在一起，瞬间冲垮了他心中最后一道名为'+tail);
    assert.doesNotMatch(result.text,/洪流/);
    assert.equal(result.replacements[0].strategy,'boundary-dialogue-trimmed');
});
test('anchored quote plus following explanation permits sentence demonstrative variation only', () => {
    const target='同伴的存在，非但没有削弱他的地位，反而是在以另一种方式，巩固他作为这个团队';
    const tail='“负责人”的权力。因为同伴是你通过他，才纳入这个团队的。那是你给予他的、协调成员的权力。';
    const value='同伴的存在巩固了他作为这个团队“负责人”的权力，因为同伴是你通过他纳入这个团队的，这是你给予他的权力。';
    const result=guard(target+tail,[replace(target+tail,target,value)]);
    assert.equal(result.text,'同伴的存在巩固了他作为这个团队'+tail);
    assert.equal(result.replacements[0].strategy,'boundary-dialogue-trimmed');
});
