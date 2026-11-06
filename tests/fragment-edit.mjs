import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureFragmentEdit, applyFragmentEdit } from '../src/diff/fragmentEdit.js';
import { writeMessageDiffAiStage, getMessageDiffMeta, restoreMessageDiffResult, setMessageDiffReverted } from '../src/diff/messageMeta.js';
function fixture(){
 const msg={mes:'好。好。',swipe_id:0,swipes:['好。好。','其他']},chat=[msg];
 writeMessageDiffAiStage(msg,'swipe:0','旧。旧。','好。好。','好。好。');
 const change={oldStart:2,oldEnd:3,newStart:2,newEnd:3,deletedText:'旧',insertedText:'好'};
 return {msg,chat,change,draft:captureFragmentEdit(chat,msg,'ai',change)};
}
test('edit only selected repeated occurrence and persist stages/swipe',()=>{
 const {msg,chat,draft}=fixture();assert.ok(draft);
 assert.equal(applyFragmentEdit(chat,draft,'新'),true);assert.equal(msg.mes,'好。新。');
 assert.deepEqual(msg.swipes,['好。新。','其他']);assert.equal(getMessageDiffMeta(msg).originalMes,'旧。旧。');
 assert.equal(applyFragmentEdit(chat,draft,'过时'),false);
 const saved=JSON.parse(JSON.stringify(msg));assert.equal(getMessageDiffMeta(saved).programMes,'好。新。');
 saved.mes='旧。旧。';setMessageDiffReverted(saved,true);assert.equal(restoreMessageDiffResult(saved),true);assert.equal(saved.mes,'好。新。');
});
test('restore one fragment preserves every other change',()=>{
 const {msg,chat,draft}=fixture();assert.equal(applyFragmentEdit(chat,draft,draft.deletedText),true);assert.equal(msg.mes,'好。旧。');
});
test('stale chat, branch, metadata, body and reordered message reject writes',()=>{
 for(const mutate of [f=>f.msg.swipe_id=1,f=>f.msg.mes='手工',f=>f.chat.unshift({}),f=>setMessageDiffReverted(f.msg,true),f=>writeMessageDiffAiStage(f.msg,'swipe:0','改变原文','好。好。','好。好。')]){
  const f=fixture();mutate(f);const before=JSON.stringify(f.chat);assert.equal(applyFragmentEdit(f.chat,f.draft,'错误'),false);assert.equal(JSON.stringify(f.chat),before);
 }
 const f=fixture();assert.equal(applyFragmentEdit([...f.chat],f.draft,'错误'),false);
});
test('intermediate AI stage and invalid offsets cannot write final body',()=>{
 const f=fixture();writeMessageDiffAiStage(f.msg,'swipe:0','旧。旧。','好。好。','好。新。');f.msg.mes='好。新。';
 assert.equal(captureFragmentEdit(f.chat,f.msg,'ai',f.change),null);
 assert.equal(captureFragmentEdit(f.chat,f.msg,'program',{...f.change,deletedText:'好',insertedText:'新'}).newStart,2);
 assert.equal(captureFragmentEdit(f.chat,f.msg,'program',{...f.change,newStart:-1}),null);
});
test('insert-only and delete-only fragments can be restored',()=>{
 for(const [oldText,newText,start,end,deletedText,insertedText] of [['甲乙','甲新乙',1,2,'','新'],['甲旧乙','甲乙',1,1,'旧','']]){
 const msg={mes:newText},chat=[msg];writeMessageDiffAiStage(msg,'main',oldText,null,newText);
 const draft=captureFragmentEdit(chat,msg,'program',{oldStart:1,oldEnd:1+deletedText.length,newStart:start,newEnd:end,deletedText,insertedText});
 assert.ok(draft);assert.equal(applyFragmentEdit(chat,draft,deletedText),true);assert.equal(msg.mes,oldText);
 }
});
import { commitCurrentMessageText } from '../src/chat/messageBranch.js';

test('multiple edits and partial revert survive whole-message undo and restore cycles',()=>{
 const f=fixture();
 applyFragmentEdit(f.chat,f.draft,'新');
 const second=captureFragmentEdit(f.chat,f.msg,'program',{oldStart:2,oldEnd:3,newStart:2,newEnd:3,deletedText:'好',insertedText:'新'});
 assert.ok(second);assert.equal(applyFragmentEdit(f.chat,second,'改'),true);
 for(let i=0;i<3;i++){
  const meta=getMessageDiffMeta(f.msg);
  assert.equal(commitCurrentMessageText(f.msg,meta.originalMes,'swipe:0').ok,true);
  setMessageDiffReverted(f.msg,true);
  assert.equal(f.msg.mes,'旧。旧。');assert.equal(f.msg.swipes[0],'旧。旧。');
  assert.equal(getMessageDiffMeta(f.msg).programMes,'好。改。');
  assert.equal(restoreMessageDiffResult(f.msg),true);
  assert.equal(f.msg.mes,'好。改。');assert.equal(f.msg.swipes[0],'好。改。');
  assert.equal(f.msg.swipes[1],'其他');
 }
 const partial=captureFragmentEdit(f.chat,f.msg,'program',{oldStart:2,oldEnd:3,newStart:2,newEnd:3,deletedText:'好',insertedText:'改'});
 assert.equal(applyFragmentEdit(f.chat,partial,partial.deletedText),true);
 commitCurrentMessageText(f.msg,'旧。旧。','swipe:0');setMessageDiffReverted(f.msg,true);
 assert.equal(restoreMessageDiffResult(f.msg),true);assert.equal(f.msg.mes,'好。好。');
});
test('whole-message undo blocks a pending fragment save and preserves retained result',()=>{
 const f=fixture();commitCurrentMessageText(f.msg,'旧。旧。','swipe:0');setMessageDiffReverted(f.msg,true);
 assert.equal(applyFragmentEdit(f.chat,f.draft,'不能写入'),false);
 assert.equal(getMessageDiffMeta(f.msg).programMes,'好。好。');
 f.msg.mes='撤回后手动编辑';assert.equal(restoreMessageDiffResult(f.msg),false);
 assert.equal(f.msg.mes,'撤回后手动编辑');
});
