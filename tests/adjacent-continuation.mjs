import test from 'node:test';
import assert from 'node:assert/strict';
import { trimAddedNarrationCopies } from '../src/aiRewrite/narrationCopies.js';
import { trimCopiedBoundaryDialogue } from '../src/aiRewrite/boundaryDialogue.js';

test('synthetic contrast copies only the untouched following assertion into a negative target',()=>{
    const target='那不再是草稿，也不是副本。',next='那是归档，是备份，是保留。';
    const source=target+'\n\n'+next;
    const replacement={start:0,end:target.length,rewritten:'那不再是草稿或副本，而是归档，是备份，是保留。'};
    const result=trimAddedNarrationCopies(source,[replacement]);
    assert.equal(result.replacements[0].rewritten,'那不再是草稿或副本。');
    assert.equal(result.removedCount,1);
    assert.equal(result.replacements[0].rewritten+source.slice(target.length),'那不再是草稿或副本。\n\n'+next);
});

test('contrast trim preserves changed facts, negation, original repetition and changing neighbors',()=>{
    const target='这不是撤回，也不是删除。',tail='这是归档，是备份，是保留。',source=target+'\n\n'+tail;
    const make=rewritten=>({start:0,end:target.length,rewritten});
    const valid='这不是撤回或删除，而是归档，是备份，是保留。';
    for(const value of ['这是撤回或删除，而是归档，是备份，是保留。',
        '这不是撤回或删除，而是归档，是备份，是销毁。',
        '这不是撤回，而是归档，是备份，是保留。']) {
        assert.equal(trimAddedNarrationCopies(source,[make(value)]).replacements[0].rewritten,value);
    }
    const changed={start:target.length+2,end:source.length,rewritten:'这是删除。'};
    assert.equal(trimAddedNarrationCopies(source,[make(valid),changed]).replacements[0].rewritten,valid);
    const repeated=source+'\n\n'+tail;
    const repaired=trimAddedNarrationCopies(repeated,[make(valid)]).replacements[0].rewritten;
    assert.equal(repaired,'这不是撤回或删除。');
    assert.equal(repaired+repeated.slice(target.length),'这不是撤回或删除。\n\n'+tail+'\n\n'+tail);
    const intervening=target+'\n他转身离开。\n'+tail;
    assert.equal(trimAddedNarrationCopies(intervening,[make(valid)]).replacements[0].rewritten,valid);
    const first=trimAddedNarrationCopies(source,[make(valid)]);
    assert.equal(trimAddedNarrationCopies(source,first.replacements).removedCount,0);
});

// Synthetic regression examples preserve the reported boundary shapes without
// publishing private chat records, endpoints or credentials.
export const fixtures = [
    { id: 'hit-4', target: '那股风来得如此突然，如此猛烈，不含任何其他的声响，只是纯粹的、想要撞开房门的力量。',
        after: '图书管理员被风推得向后踉跄了一步，文件瞬间散落。那件沾了灰尘的外套，在接触到清冷空气的刹那，被风掀起了衣角。',
        kept: '那股风猛烈而突兀，不含任何其他的声响，只是想要撞开房门。',
        added: '图书管理员被推得向后踉跄了一步，文件散落，外套接触到清冷的空气，被风掀起了衣角。' },
    { id: 'hit-10', before: '“归档”', target: '这两个字，像一把落了灰的钥匙，猛地打开了他记忆深处封存的那个抽屉。',
        after: '他想起了去年是如何从这个仓库出发，回到那个多年未曾踏入的旧书店。',
        kept: '这两个字，打开了他记忆深处封存的回忆。',
        added: '他想起了去年如何从这个仓库出发，回到那个多年未曾踏入的旧书店。', prefix: '“归档”' },
    { id: 'hit-15', before: '“等等……请稍等，等等……”', target: '管理员的声音在空旷的走廊响起，不再有任何一丝镇定，只剩下急切的提醒。',
        after: '急促的话语响在空旷的走廊，带着明显的回声，“我已经检查过……都是旧的记录……重新整理，重新核对，怎么样都可以……只是，请你，别用这种方式……别把文件带走……”',
        kept: '管理员的声音在空旷的走廊响起，只剩下急切的提醒。',
        added: '急促的话语响在空旷的走廊，带着明显的回声，“我已经检查过……都是旧的记录……重新整理，重新核对，怎么样都可以……只是，请你，别把文件带走……”' },
];

function run(c, extra = []) {
    const source = (c.before || '') + c.target + c.after;
    const replacement = { id: c.id, start: (c.before || '').length,
        end: (c.before || '').length + c.target.length, rewritten: (c.prefix || '') + c.kept + c.added };
    const dialogue = trimCopiedBoundaryDialogue(source, [replacement, ...extra]);
    const result = trimAddedNarrationCopies(source, dialogue.replacements);
    return { source, replacement, result, value: result.replacements[0].rewritten };
}

for (const fixture of fixtures) test(`recorded ${fixture.id}: remove only proven outside continuation`, () => {
    const { source, replacement, result, value } = run(fixture);
    assert.equal(value, fixture.kept);
    assert.equal(source.slice(0, replacement.start) + value + source.slice(replacement.end),
        (fixture.before || '') + fixture.kept + fixture.after);
    assert.equal(trimAddedNarrationCopies(source, result.replacements).removedCount, 0, 'idempotent');
});

const base = fixtures[0];
const negatives = [
    ['new direction', { added: base.added.replace('向后', '向前') }],
    ['new quantity', { added: base.added.replace('一步', '两步') }],
    ['new negation', { added: base.added.replace('被推得', '没有被推得') }],
    ['new object', { added: base.added.replace('外套', '鞋面') }],
    ['new event', { added: base.added.replace('文件散落', '拿起茶杯') }],
    ['again in target', { target: base.target.replace('那股', '又一次，那股') }],
    ['multiple original sentences', { target: base.target + base.after }],
    ['original contains the action', { target: base.target.replace('想要撞开房门的力量', '图书管理员被风推得向后踉跄了一步的原因') }],
    ['outside next paragraph', { after: '\n\n' + base.after }],
    ['outside code', { after: '```\n' + base.after + '\n```' }],
    ['outside markup', { after: '<aside>' + base.after + '</aside>' }],
    ['protected original dialogue', { target: '“' + base.target + '”' }],
    ['unrelated first sentence', { kept: '他关上了窗户，然后走到了房间的角落。' }],
    ['changed digit run', { after: base.after.replace('一步', '12步'), added: base.added.replace('一步', '2步') }],
    ['legitimate expanded target', { after: '窗外雨声停了。', added: '她想从这里离开，想走出房间，走到外面吹吹风。' }],
];
for (const [name, overrides] of negatives) test(`preserve uncertain continuation: ${name}`, () => {
    const c = { ...base, ...overrides };
    assert.equal(run(c).value, c.kept + c.added);
});
test('do not anchor to another changing target', () => {
    const start = base.target.length;
    assert.equal(run(base, [{ start, end: start + base.after.length, rewritten: '他站稳了。' }]).value,
        base.kept + base.added);
});
test('a closing scope tag after the anchor does not hide the copy', () => {
    const c = { ...base, before: '<content>', after: base.after + '</content>' };
    assert.equal(run(c).value, base.kept);
});
test('same textual shape with unrelated neutral names and objects', () => {
    const c = { target: '这声通知来得如此突然，让正在整理书架的管理员有些措手不及。',
        kept: '这声通知让正在整理书架的管理员措手不及。',
        after: '管理员打开了那扇朝向院子的木门，把堆在门口的旧报纸搬进走廊尽头空着的储物室。',
        added: '管理员打开了朝向院子的木门，把旧报纸搬进走廊尽头空着的储物室。' };
    assert.equal(run(c).value, c.kept);
});


test('comma-joined leading clauses copied from the next sentence are removed without touching source',()=>{
    const target='他站在书架旁，神情专注而庄重，仿佛在进行一项最重要的仪式。';
    const next='他为你整理散落的书籍，动作轻柔得不可思议，生怕弄坏那些旧书。';
    const rewritten='他站在书架旁，神情专注，为你整理散落的书籍，动作轻柔得不可思议。';
    const source=target+next;
    const make=value=>({start:0,end:target.length,rewritten:value});
    const result=trimAddedNarrationCopies(source,[make(rewritten)]);
    assert.equal(result.replacements[0].rewritten,'他站在书架旁，神情专注。');
    assert.equal(source.slice(target.length),next);
    assert.equal(trimAddedNarrationCopies(source,result.replacements).removedCount,0);
    for(const changed of [rewritten.replace('整理','丢弃'),rewritten.replace('轻柔','粗暴'),rewritten.replace('为你','又为你')]) {
        assert.equal(trimAddedNarrationCopies(source,[make(changed)]).replacements[0].rewritten,changed);
    }
    const neighbor={start:target.length,end:source.length,rewritten:'他没有整理书籍。'};
    assert.equal(trimAddedNarrationCopies(source,[make(rewritten),neighbor]).replacements[0].rewritten,rewritten);
});

test('comma copy guard preserves negative clauses, original facts and intentional repeats',()=>{
    const next='他为你整理散落的书籍，动作轻柔得不可思议，生怕弄坏那些旧书。';
    for(const target of ['他又站在书架旁，神情专注，为你整理散落的书籍。', '他站在书架旁，为你整理散落的书籍，动作轻柔。']) {
        const rewritten='他站在书架旁，神情专注，为你整理散落的书籍，动作轻柔得不可思议。';
        assert.equal(trimAddedNarrationCopies(target+next,[{start:0,end:target.length,rewritten}]).replacements[0].rewritten,rewritten);
    }
    const target='他站在书架旁，并没有打开那只纸箱。';
    const rewritten='他站在书架旁，并没有打开那只纸箱，为你整理散落的书籍，动作轻柔得不可思议。';
    assert.equal(trimAddedNarrationCopies(target+next,[{start:0,end:target.length,rewritten}]).replacements[0].rewritten,target);
});
