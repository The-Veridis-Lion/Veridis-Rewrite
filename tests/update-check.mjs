import {initAppContext} from '../src/host/appContext.js';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bindUpdateStatusEvents, initializeUpdateStatus, resolveUpdateSource, compareBuildVersions, loadLocalUpdateVersion} from '../src/update/status.js';

const selector='#blai-tools-version-section [data-update-action="check"]';
function fixture(){
 const handlers=new Map();
 class Element {
  constructor(){this.children=[];this.dataset={};this.textContent='';this.disabled=false;}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(){this.children=[];}
  querySelector(){return this.children.find(x=>x.dataset.updateAction==='check')||null;}
 }
 const content=new Element();
 globalThis.document={createElement:()=>new Element(),getElementById:id=>id==='blai-tools-version-content'?content:null};
 globalThis.$=()=>({prop(){return this;},text(){return this;},off(_event,sel){handlers.delete(sel);return this;},on(_event,sel,fn){handlers.set(sel,fn);return this;}});
 return {content,click:()=>handlers.get(selector).call(content.querySelector()),update:()=>handlers.get('#blai-tools-version-section [data-update-action="update"]').call(null)};
}
test('initialization performs no version request and offers an explicit check',()=>{
 const f=fixture();let calls=0;bindUpdateStatusEvents(()=>{calls++;});
 assert.equal(calls,0);assert.equal(f.content.querySelector().textContent,'检查版本');
});
test('repeated clicks share a single in-flight check and allow a later check',async()=>{
 const f=fixture();let calls=0,finish;bindUpdateStatusEvents(()=>{calls++;return new Promise(r=>finish=r);});
 const first=f.click();await f.click();assert.equal(calls,1);assert.equal(f.content.querySelector().disabled,true);
 finish();await first;assert.equal(f.content.querySelector().disabled,false);
 const second=f.click();assert.equal(calls,2);finish();await second;
});
test('rendering the version result retains a way to check again',async()=>{
 const f=fixture();bindUpdateStatusEvents(()=>{f.content.replaceChildren();});await f.click();
 assert.equal(f.content.querySelector().textContent,'检查版本');assert.equal(f.content.children.length,1);
});
test('rebinding does not accumulate check buttons or listeners',async()=>{
 const f=fixture();let oldCalls=0,newCalls=0;bindUpdateStatusEvents(()=>{oldCalls++;});bindUpdateStatusEvents(()=>{newCalls++;});
 await f.click();assert.equal(oldCalls,0);assert.equal(newCalls,1);assert.equal(f.content.children.filter(x=>x.dataset.updateAction==='check').length,1);
});

const textOf=node=>[node.textContent,...(node.children||[]).map(textOf)].join(' ');
const sha='a'.repeat(40),newSha='b'.repeat(40);
const info={remoteUrl:'https://github.com/qiyuebuyuan1993/Veridis-Rewrite.git',currentBranchName:'fix/luker-api-rewrite-compat',currentCommitHash:sha,remoteCommitHash:newSha};
test('source follows Git checkout, handles SSH, and never guesses main',()=>{
 assert.deepEqual(resolveUpdateSource(info),{repository:'qiyuebuyuan1993/Veridis-Rewrite',branch:info.currentBranchName});
 assert.deepEqual(resolveUpdateSource({...info,remoteUrl:'git@github.com:The-Veridis-Lion/Veridis-Rewrite.git',currentBranchName:'main'}),{repository:'The-Veridis-Lion/Veridis-Rewrite',branch:'main'});
 for(const value of [{}, {...info,currentBranchName:'HEAD'},{...info,remoteUrl:'https://example.com/a/b'},{...info,currentBranchName:'../main'}]) assert.equal(resolveUpdateSource(value),null);
 assert.equal(compareBuildVersions('3.5.0-fix.36','3.5'),1);
 assert.equal(compareBuildVersions('3.5.0-fix.36','3.5.0-fix.37'),-1);
});
test('local version is visible without a remote request',async()=>{
 const f=fixture();let calls=0;
 initAppContext({readExtensionManifest:async()=>({version:'3.5.0-fix.36'})});
 globalThis.fetch=async()=>{calls++;throw new Error('Unexpected remote request');};
 await loadLocalUpdateVersion();bindUpdateStatusEvents(()=>{});
 assert.match(textOf(f.content),/3\.5\.0-fix\.36/);assert.equal(calls,0);
});
test('check uses installed fork branch and update never switches branch',async()=>{
 const f=fixture(),requests=[];let reloads=0;
 initAppContext({veridisExtensionFolderName:'Veridis-Rewrite',readExtensionManifest:async()=>({version:'3.5.0-fix.36'}),getSillyTavernContext:()=>({getRequestHeaders:()=>({})})});
 globalThis.location={reload(){reloads++;}};
 globalThis.fetch=async(url,options)=>{
  requests.push({url,body:options?.body&&JSON.parse(options.body)});
  return{ok:true,json:async()=>url==='/api/extensions/version'?info:{version:'3.5.0-fix.37',update_note:'Update'}};
 };
 bindUpdateStatusEvents(()=>{});await initializeUpdateStatus({versionInfo:info});
 assert.match(requests[0].url,/qiyuebuyuan1993\/Veridis-Rewrite\/fix\/luker-api-rewrite-compat\/manifest.json/);
 assert.match(textOf(f.content),/fix\/luker-api-rewrite-compat/);
 await f.update();assert.equal(reloads,1);
 assert.deepEqual(requests.slice(1).map(r=>r.url),['/api/extensions/version','/api/extensions/update']);
});
test('unknown source, older remote, and changed checkout do not update or switch',async()=>{
 const f=fixture(),requests=[];
 initAppContext({readExtensionManifest:async()=>({version:'3.5.0-fix.36'}),getSillyTavernContext:()=>({getRequestHeaders:()=>({})})});
 globalThis.fetch=async(url)=>{requests.push(url);return {ok:true,json:async()=>({version:'3.5'})};};
 await initializeUpdateStatus({versionInfo:{}});assert.equal(requests.length,0);
 await initializeUpdateStatus({versionInfo:info});assert.match(textOf(f.content),/不进行降级/);
 globalThis.fetch=async(url)=>{requests.push(url);return{ok:true,json:async()=>url==='/api/extensions/version'?{...info,currentBranchName:'main'}:{version:'3.5.0-fix.37'}};};
 bindUpdateStatusEvents(()=>{});await initializeUpdateStatus({versionInfo:info});await f.update();
 assert.equal(requests.includes('/api/extensions/update'),false);assert.equal(requests.includes('/api/extensions/switch'),false);
});
