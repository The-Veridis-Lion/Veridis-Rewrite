import test from 'node:test';
import assert from 'node:assert/strict';
const values=new Map();
let quota=Infinity, denied=false;
globalThis.localStorage={
 getItem:key=>values.get(key)??null,
 setItem:(key,value)=>{if(denied)throw new Error('disabled');if(value.length>quota){const e=new Error('full');e.name='QuotaExceededError';throw e;}values.set(key,value);},
 removeItem:key=>values.delete(key),
};
let sequence=0;
const load=()=>import(`../src/aiRewrite/communicationMonitor.js?storage-test=${++sequence}`);
const add=(m,n)=>m.recordAiCommunicationSuccess({startedAt:n,endedAt:n+10,requestJson:`request-${n}`,response:`response-${n}`,context:{generationId:'generation-1',startedAtMs:1}});

test('reload restores full requests, responses, time and grouping; clear remains cleared',async()=>{
 values.clear();const first=await load();add(first,1);add(first,2);
 first.recordAiCommunicationFailure({startedAt:3,endedAt:4,requestJson:'failed-request',error:{name:'Error',message:'fixture failure'}});
 const reload=await load();assert.deepEqual(reload.getAiCommunicationRecords(),JSON.parse(JSON.stringify(first.getAiCommunicationRecords())));
 assert.equal(reload.getAiCommunicationDisplayGroups().length,2);
 reload.clearAiCommunicationRecords();assert.deepEqual((await load()).getAiCommunicationRecords(),[]);
});
test('only ten newest requests are retained across reload',async()=>{
 values.clear();const m=await load();for(let i=1;i<=12;i++)add(m,i);
 const records=(await load()).getAiCommunicationRecords();assert.equal(records.length,10);assert.equal(records[0].requestJson,'request-12');assert.equal(records.at(-1).requestJson,'request-3');
});
test('quota evicts old complete records and does not break the current response',async()=>{
 values.clear();const m=await load();add(m,1);quota=[...values.values()][0].length+5;add(m,2);
 const records=(await load()).getAiCommunicationRecords();assert.equal(records.length,1);assert.equal(records[0].response,'response-2');assert.equal(m.getAiCommunicationRecords().length,2);
 quota=0;assert.doesNotThrow(()=>add(m,3));assert.equal(values.size,0);quota=Infinity;
});
test('malformed storage and unavailable writes do not break generation',async()=>{
 values.clear();const m=await load();add(m,1);const key=[...values.keys()][0];
 for(const raw of ['broken','{}','[null,{}, {"status":"failed","timestamp":"x","requestJson":"x"}]']){values.set(key,raw);assert.deepEqual((await load()).getAiCommunicationRecords(),[]);}
 denied=true;assert.doesNotThrow(()=>add(m,2));denied=false;
});
test('stored request keeps existing credential redaction',async()=>{
 values.clear();const m=await load();const requestJson=m.snapshotAiCommunicationRequest({custom_api:{key:'fixture-secret'},custom_include_headers:'Authorization: fixture-token'});
 m.recordAiCommunicationSuccess({startedAt:1,endedAt:2,requestJson,response:'{}'});
 const stored=[...values.values()][0];assert.ok(!stored.includes('fixture-secret'));assert.ok(!stored.includes('fixture-token'));assert.ok(stored.includes('[REDACTED]'));
});

