import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trimAddedNarrationCopies } from '../src/aiRewrite/narrationCopies.js';

const replace = (source, target, rewritten) => ({ start: source.indexOf(target), end: source.indexOf(target) + target.length, rewritten });
function guard(source, replacements) {
    const before = structuredClone(replacements);
    const result = trimAddedNarrationCopies(source, replacements);
    assert.deepEqual(replacements, before);
    return { ...result, text: result.replacements.slice().sort((a,b) => b.start-a.start)
        .reduce((text,r) => text.slice(0,r.start)+r.rewritten+text.slice(r.end),source) };
}
const sentence = '档案管理员满意地看着这一切。';
const target = '他像核对清单一样整理文件。';
test('the reported whole narration copy is removed from the next target, retaining cleaned text', () => {
    const source = sentence + target;
    const result = guard(source,[replace(source,target,sentence+'他整理文件。')]);
    assert.equal(result.text,sentence+'他整理文件。');assert.equal(result.removedCount,1);
});
test('an internal extra copy of an original narration sentence is removed locally', () => {
    const source = sentence+target;
    const result = guard(source,[replace(source,source,sentence+sentence+'他整理文件。')]);
    assert.equal(result.text,sentence+'他整理文件。');assert.equal(result.removedCount,1);
});
test('a generated copy of the next untouched narration is removed from the end of the target', () => {
    const source = target+sentence;
    assert.equal(guard(source,[replace(source,target,'他整理文件。'+sentence)]).text,'他整理文件。'+sentence);
});
const prefix = '他以身为“刀”最重要、最珍视的职责，守护着这里的所有人。';
const suffix = '“刀”最重要、最珍视的职责，守护着这里的所有人。';
test('a long copied suffix starting with a quoted term is removed from a new target', () => {
    const source=prefix+target;
    const result=guard(source,[replace(source,target,suffix+'他整理文件。')]);
    assert.equal(result.text,prefix+'他整理文件。');assert.equal(result.removedCount,1);
});
test('an internal suffix copy with a quoted term is removed, preserving the complete first sentence', () => {
    const source=prefix+target;
    assert.equal(guard(source,[replace(source,source,prefix+suffix+'他整理文件。')]).text,prefix+'他整理文件。');
});
test('a target beginning after a protected term still removes its newly appended quoted suffix', () => {
    const original=prefix.slice(prefix.indexOf('”')+1),source=prefix;
    assert.equal(guard(source,[replace(source,original,original+suffix)]).text,source);
});
test('multiple new copies across whitespace are trimmed without deleting the source occurrence', () => {
    const source=sentence+'\n'+target;
    const result=guard(source,[replace(source,target,sentence+'\n'+sentence+'他整理文件。')]);
    assert.equal(result.removedCount,2);assert.equal(result.text.replace(/\n/gu,''),sentence+'他整理文件。');
});
test('source occurrence counts preserve both preexisting identical narration sentences', () => {
    const source=sentence+sentence+target;
    const result=guard(source,[replace(source,source,sentence+sentence+sentence+'他整理文件。')]);
    assert.equal(result.text,sentence+sentence+'他整理文件。');assert.equal(result.removedCount,1);
});
test('an original long suffix repetition is preserved', () => {
    const source=prefix+suffix+target;
    assert.equal(guard(source,[replace(source,source,prefix+suffix+'他整理文件。')]).removedCount,0);
});
for (const cue of ['又','再一次','第二次','反复','分别']) test('explicit repeated events remain protected: '+cue, () => {
    const source=sentence+'他'+cue+'看着这里。';
    assert.equal(guard(source,[replace(source,source,sentence+sentence)]).removedCount,0);
});
for (const source of ['“'+sentence+'”'+target,'```text\n'+sentence+target+'\n```','<!--'+sentence+target+'-->']) {
    test('speech, code or comment content does not authorize narration deletion: '+source.slice(0,12), () => {
        assert.equal(guard(source,[replace(source,target,sentence+'他整理文件。')]).removedCount,0);
    });
}
test('new quoted speech is preserved by the narration-only guard', () => {
    const source=sentence+target;
    assert.equal(guard(source,[replace(source,target,'“'+sentence+'”他整理文件。')]).removedCount,0);
});
test('different actions, objects, counts, directions and near-semantic versions are preserved', () => {
    const source=sentence+target;
    for (const output of ['档案管理员满意地看着那一切。他整理文件。','他拿来两个杯子。他拿来三条毛巾。',
        '他向左看。他向右看。','他整理了文件。他把文件整理好。']) {
        assert.equal(guard(source,[replace(source,target,output)]).removedCount,0);
    }
});
test('unchanged source and response consisting only of a copied neighbor never become deletion', () => {
    const source=sentence+target;
    assert.equal(guard(source,[replace(source,target,sentence)]).removedCount,0);
    assert.equal(guard(source,[replace(source,sentence,sentence)]).text,source);
});
test('a neighboring target being changed cannot act as an unchanged copy anchor', () => {
    const source=sentence+target;
    assert.equal(guard(source,[replace(source,sentence,'他满意地点头。'),replace(source,target,sentence+'他整理文件。')]).removedCount,0);
});
test('a short fragment without sentence boundary evidence is not trimmed', () => {
    const source='他拿起两个杯子。'+target;
    assert.equal(guard(source,[replace(source,target,'两个杯子。他整理文件。')]).removedCount,0);
});
test('the guard remains idempotent and does not mutate source ranges', () => {
    const source=sentence+target,first=guard(source,[replace(source,target,sentence+'他整理文件。')]);
    assert.deepEqual(trimAddedNarrationCopies(source,first.replacements),{replacements:first.replacements,removedCount:0});
});

const commandPrefix='他执行着“检查”';
const commandTail='的命令，每一次都用尽全力，将手中的两个零件，紧紧地固定在底座上。';
const cleanedTail='的命令，每一次都用尽全力，将手中的两个零件紧紧固定在底座上。';
test('a long quoted-term suffix copy differing only in commas and reduplicated-adverb 地 is trimmed',()=>{
    const source=commandPrefix+commandTail;
    const result=guard(source,[replace(source,commandTail,cleanedTail+'“检查”'+commandTail)]);
    assert.equal(result.text,commandPrefix+cleanedTail);assert.equal(result.removedCount,1);
});
test('changed narration before the copied quoted-term suffix does not invalidate an untouched suffix anchor',()=>{
    const first='他像机器一样执行着',source=first+'“检查”'+commandTail;
    const result=guard(source,[replace(source,first,'他执行着'),replace(source,commandTail,cleanedTail+'“检查”'+commandTail)]);
    assert.equal(result.text,commandPrefix+cleanedTail);assert.equal(result.removedCount,1);
});
test('comma differences in source repetitions still preserve the original number of events',()=>{
    const source=commandPrefix+cleanedTail+'“检查”'+commandTail;
    assert.equal(guard(source,[replace(source,source,source)]).removedCount,0);
});
test('different quoted command payloads or normal quantities cannot be normalized into duplicates',()=>{
    const source=commandPrefix+commandTail;
    for(const different of [commandTail.replace('两个','三个'),commandTail.replace('底座','桌面')]){
        const output=cleanedTail+'“检查”'+different;
        assert.equal(guard(source,[replace(source,commandTail,output)]).removedCount,0);
    }
    assert.equal(guard(source,[replace(source,commandTail,cleanedTail+'“复查”'+commandTail)]).removedCount,0);
});
test('commas inside a quoted command remain meaningful literal content',()=>{
    const source='他执行着“甲，乙”'+commandTail;
    assert.equal(guard(source,[replace(source,commandTail,cleanedTail+'“甲乙”'+commandTail)]).removedCount,0);
});
test('a noun ending in 地 and other word changes are not adverb-normalization candidates',()=>{
    const source='他仔细检查这片土地，确认地面没有裂缝。'+target;
    const output='他仔细检查这片土，确认面没有裂缝。他整理文件。';
    assert.equal(guard(source,[replace(source,target,output)]).removedCount,0);
});
