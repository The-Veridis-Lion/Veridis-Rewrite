import assert from 'node:assert/strict';
import {test} from 'node:test';
import {applyLocalEdits} from '../src/aiRewrite/localEdits.js';
import {validateAiRewriteResponse} from '../src/aiRewrite/response.js';
import {renderPromptPure} from '../src/aiRewrite/planning.js';
const edit=(before,after,occurrence=0)=>({before,after,occurrence});
for(const quote of ['“选项”','「选项」','"选项"'])for(const separator of ['，',',','、',' ']) {
 test(`locked prefix and suffix remain identical: ${quote}${separator}`,()=>{
  const prefix='他说'+quote+separator, target='他忽然拿起笔，在',tail=quote+'上画了两个圆圈。并没有离开。';
  const result=validateAiRewriteResponse(JSON.stringify({'hit-1':[edit('忽然','')]}),new Map([['hit-1',{text:target}]]));
  const source=prefix+target+tail, composed=prefix+result.get('hit-1')+tail;
  assert.equal(composed,prefix+'他拿起笔，在'+tail);
  assert.equal(composed.slice(0,prefix.length),source.slice(0,prefix.length));
  assert.equal(composed.slice(-tail.length),source.slice(-tail.length));
 });
}
test('repeated occurrences use original coordinates and preserve untouched characters',()=>{
 assert.equal(applyLocalEdits('甲甲甲',[edit('甲','乙',1),edit('甲','丙',2)]),'甲乙丙');
 assert.equal(applyLocalEdits('不去。又去。',[]),'不去。又去。');
});
test('malformed, overlapping, cross-target and old whole-text output cannot be applied',()=>{
 for(const value of ['整句',null,[edit('目标外','删除')],[edit('','新增')],[edit('甲','乙',99)],[edit('甲甲','乙'),edit('甲','丙',1)],[{...edit('甲','乙'),start:0}]]){
  assert.throws(()=>applyLocalEdits('甲甲',value));
 }
 assert.equal(validateAiRewriteResponse('{"hit-1":"原协议"}',new Map([['hit-1',{text:'甲'}]])).get('hit-1'),'原协议');
});
test('prompt retains locked surrounding sentence and ends with local edit protocol',()=>{
 const source='前句不变。他忽然拿起笔，在“选项”上画圈。后句不变。';
 const text='他忽然拿起笔，在',start=source.indexOf(text);
 const prompt=renderPromptPure(source,[{id:'hit-1',text,start,end:start+text.length,matches:[]}],{scopeTagMode:'cleanse-inside'},{maxContextChars:12000},'旧模板');
 assert.ok(prompt.includes('<locked_context>前句不变。</locked_context>'));
 assert.ok(prompt.includes('<locked_context>“选项”上画圈。后句不变。</locked_context>'));
 assert.ok(prompt.includes('最终输出格式'));
});

test('generated outside-span invariants across 200 deterministic fixtures',()=>{
 for(let n=0;n<200;n++){
  const left=`锁定前文${n}。没有删除。`,right=`“锁定${n}”后文，两个动作又发生。`;
  const target='甲'.repeat(n%11)+'忽然乙'+ '丙'.repeat(n%7);
  const rewritten=applyLocalEdits(target,[edit('忽然','')]);
  const composed=left+rewritten+right;
  assert.equal(composed.slice(0,left.length),left);
  assert.equal(composed.slice(left.length+rewritten.length),right);
  assert.equal(rewritten,target.replace('忽然',''));
 }
});
