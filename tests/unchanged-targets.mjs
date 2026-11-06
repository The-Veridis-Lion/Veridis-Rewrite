import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderDiffDocument } from '../src/diff/compare.js';
import { writeMessageDiffAiStage, getMessageDiffMeta, setMessageDiffReverted, restoreMessageDiffResult, pruneChatDiffMetadata } from '../src/diff/messageMeta.js';
for (const mode of ['full', 'snippet']) test(`inline amber preserves order, escaping and original offsets: ${mode}`, () => {
    const oldText='旧。<script>文本。相同。相同。';
    const html=renderDiffDocument([{section:'ai',oldText,newText:oldText.replace('旧','新'),aiUnchanged:[
        {start:2,end:13,reason:'boundary-risk'}, {start:16,end:19,reason:'unchanged'}]}],mode).join('');
    assert.match(html,/blai-diff-ai-unchanged/); assert.match(html,/&lt;script&gt;/);
    assert.doesNotMatch(html,/<script>/); assert.match(html,/回抄风险/); assert.match(html,/规则例外/);
    assert.ok(html.indexOf('新') < html.indexOf('<mark'));
    assert.doesNotMatch(html,/blai-diff-unchanged-item/);
});
test('all unchanged targets remain visible in snippet mode without a second full body',()=>{
    const ai={section:'ai',oldText:'原文。',newText:'原文。',aiUnchanged:[{start:0,end:3,reason:'unchanged'}]};
    assert.match(renderDiffDocument([ai],'snippet').join(''),/<mark/);
    assert.equal(renderDiffDocument([ai,{section:'program',oldText:'原文。',newText:'原文。'}],'full').length,1);
});
test('branch annotations survive reload, undo and restore; replacement and retention clear them', () => {
    let msg = {mes:'原文',swipe_id:0,swipes:['原文','其他']};
    const entries=[{start:0,end:2,reason:'unchanged'}];
    writeMessageDiffAiStage(msg,'swipe:0','原文','原文','原文',entries);
    msg=JSON.parse(JSON.stringify(msg));
    setMessageDiffReverted(msg,true);
    assert.equal(restoreMessageDiffResult(msg),true);
    assert.deepEqual(getMessageDiffMeta(msg).aiUnchanged,entries);
    assert.equal(getMessageDiffMeta(msg,'swipe:1'),null);
    assert.equal(writeMessageDiffAiStage(msg,'swipe:0','原文','原文','原文'),true);
    assert.equal(getMessageDiffMeta(msg).aiUnchanged,undefined);
    writeMessageDiffAiStage(msg,'swipe:0','原文','原文','原文',entries);
    pruneChatDiffMetadata([msg],[]);
    assert.equal(getMessageDiffMeta(msg),null);
});
