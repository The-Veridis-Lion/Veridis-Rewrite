// DOM/event contract test, not a full Luker APK integration test.
// References are read-only snapshots; the renderer and backend client run unchanged
// except for imports whose memory/host dependencies are explicit fixture stubs.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.BLAI_TEST_MODULES || import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const reference = process.env.BLAI_MYRIAD_REFERENCE;
if (!reference) throw new Error('Set BLAI_MYRIAD_REFERENCE to the pinned ST-MyriadKnots source directory');
const renderer = fs.readFileSync(path.join(reference, 'inline-renderer.js'), 'utf8').replace(/^import .*;\r?\n/gm, '');
const backend = fs.readFileSync(path.join(reference, 'backend-client.js'), 'utf8').replace(/^import .*;\r?\n/gm, '');
const rendererDeps = `
const RECALL_RECEIPT_KEY='fixtureReceipt', MIGRATION_ALIAS_KEY='fixtureAlias';
const projectHistoricalRecallReceipt=async()=>null,inspectMessageFloorAnchor=()=>({status:'missing'});
const isMemoryExcludedMessage=()=>false, publicErrorMessage=e=>e?.message||'',patchRecallTabs=()=>{};
const scaleCssFontSizes=s=>s;
const classifyInlineMessage=m=>!m?null:m.is_user?'user':'assistant';
const projectInlineMemoryFloor=(state,index)=>({kind:'assistant',messageIndex:index,status:state.ready?'ready':'idle',statusText:state.ready?'已读取':'读取中',time:'21:00',locations:'测试场景',people:'测试人物',summary:'两个人搬来两个箱子。',canExtract:true});
const projectInlineRecallReceipt=()=>({kind:'user',statusText:'已读取'});
`;
const backendDeps = `const API_BASE='/api/plugins/st-bainiaodata',NAMESPACE='qianqianjie';const isTauriTavern=()=>false,createTauriBackendFetch=()=>{throw Error('unused')};\n`;
const uiTest = fs.readFileSync(path.join(root, 'tests/ui-column.mjs'), 'utf8');
const jqueryFacade = uiTest.slice(uiTest.indexOf('class Q {'), uiTest.indexOf("const shell=await import"));
const html = `<!doctype html><html><meta charset="utf-8"><body><div id="chat"></div><textarea id="send_textarea"></textarea><script type="module">
${jqueryFacade}
const NativeObserver=window.MutationObserver;
window.counts={callbacks:0,records:0,snapshots:0,saves:0,model:0};
window.MutationObserver=class extends NativeObserver{constructor(fn){super((records,self)=>{counts.callbacks++;counts.records+=records.length;fn(records,self)})}};
const {initAppContext}=await import('/src/host/appContext.js');
const {defaultSettings,extensionName}=await import('/src/settings/defaults.js');
const {initRealtimeInterceptor,bindHostLifecycleEvents}=await import('/src/host/lifecycleEvents.js');
const {getAiRewriteRuntimeLog}=await import('/src/aiRewrite/debug.js');
const {createInlineRenderer}=await import('/reference/renderer.js');
const {createBackendClient}=await import('/reference/backend.js');
const handlers=new Map();
const eventSource={on(event,fn){if(!handlers.has(event))handlers.set(event,[]);handlers.get(event).push(fn)},off(event,fn){handlers.set(event,(handlers.get(event)||[]).filter(x=>x!==fn))},emit(event,...args){for(const fn of [...handlers.get(event)||[]])fn(...args)}};
const eventTypes=Object.fromEntries(['CHAT_CHANGED','MESSAGE_RECEIVED','MESSAGE_EDITED','MESSAGE_UPDATED','CHARACTER_MESSAGE_RENDERED','USER_MESSAGE_RENDERED','MESSAGE_SWIPED','MESSAGE_DELETED','GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED','STREAM_TOKEN_RECEIVED'].map(x=>[x,x]));
const chat=Array.from({length:700},(_,i)=>({is_user:false,mes:'<content>他极其认真地搬来两个箱子。第'+i+'页。</content>',extra:{qianqianjie:{keep:true}}}));
const original=chat.map(m=>m.mes),settings=structuredClone(defaultSettings);settings.logLevel=0;settings.diffTrackedMessageLimit=5;settings.aiRewrite.autoTriggerEnabled=false;
settings.rules=[{enabled:true,subRules:[{enabled:true,mode:'regex',rewriteMode:'program',targets:['—+'],replacements:['，']},{enabled:true,mode:'text',rewriteMode:'ai',targets:['极其'],replacements:[]}]}];
const host={chat,chatId:'fixture-chat',characters:[{name:'Fixture'}],characterId:0,chatMetadata:{qianqianjie:{chatId:'fixture-chat'}},eventSource,eventTypes,getRequestHeaders:()=>({}),saveChat:async()=>{counts.saves++},updateMessageBlock(){}};
initAppContext({chat,extension_settings:{[extensionName]:settings},saveSettingsDebounced(){},eventSource,event_types:eventTypes,getSillyTavernContext:()=>host,getStreamingProcessor:()=>null});
window.TavernHelper={generateRaw(){counts.model++;throw Error('must not generate on chat open')}};
let notifyMemory;let ready=false;
const memoryRuntime={getState:()=>({ready,chatId:'fixture-chat',floors:[]}),extractFloor:async()=>{},subscribe:fn=>{notifyMemory=fn;return()=>{}}};
const recallRuntime={getState:()=>({}),subscribe:()=>()=>{}};
const inline=createInlineRenderer({memoryRuntime,recallRuntime,hostAdapter:{snapshot:()=>{counts.snapshots++;return{...host,context:{chatMetadata:host.chatMetadata}}}}});
const client=createBackendClient({fetchImpl:window.fetch.bind(window)});
const withVeridis=new URL(location.href).searchParams.get('veridis')!=='off';
if(withVeridis){initRealtimeInterceptor();bindHostLifecycleEvents();}inline.start();
window.fixture={chat,original,settings,inline,client,createBackendClient,eventSource,eventTypes,getAiRewriteRuntimeLog,
async open(){const started=performance.now();const pending=client.get('memory','v3-root');
eventSource.emit('CHAT_CHANGED','fixture-chat');
const fragment=document.createDocumentFragment();
for(let i=0;i<chat.length;i++){const el=document.createElement('div');el.className='mes';el.setAttribute('mesid',String(i));el.innerHTML='<div class="mes_buttons"><span class="mes_edit"></span></div><div class="mes_text">两个人搬来两个箱子。</div><div><span class="swipeRightBlock"></span></div>';fragment.append(el)}
document.getElementById('chat').append(fragment);
// Luker runs token-count dry-run after opening a chat.
eventSource.emit('GENERATION_STARTED','normal',{},true);
await pending;ready=true;notifyMemory?.();return{elapsedMs:performance.now()-started};},ready:true};
</script></body></html>`;
const results = [], requests = [];
const server = http.createServer((req,res)=>{
    const url=new URL(req.url,'http://fixture');
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html;charset=utf-8');return res.end(html);}
    if(url.pathname.startsWith('/reference/')){res.setHeader('Content-Type','text/javascript');return res.end(url.pathname.endsWith('renderer.js')?rendererDeps+renderer:backendDeps+backend);}
    if(url.pathname.startsWith('/api/')){requests.push({method:req.method,path:url.pathname});return setTimeout(()=>{res.setHeader('Content-Type','application/json');res.end('{"revision":1,"data":{}}')},180);}
    const file=path.resolve(root,'.'+decodeURIComponent(url.pathname));
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file)){res.writeHead(404);return res.end();}
    res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,executablePath:process.env.BLAI_TEST_CHROME||undefined});
const output=process.env.BLAI_COMPAT_OUTPUT||path.join(root,'../luker-myriad-results.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
try{
    for(const [width,rate,withVeridis]of [[1920,1,true],[390,6,true],[390,6,false]]){
        const page=await browser.newPage({viewport:{width,height:900}}),errors=[];
        page.on('pageerror',e=>errors.push(e.message));
        const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate});
        await page.goto('http://127.0.0.1:'+server.address().port+'/?veridis='+(withVeridis?'on':'off'),{waitUntil:'networkidle'});await page.waitForFunction(()=>window.fixture?.ready);
        const timing=await page.evaluate(()=>fixture.open());
        await page.waitForFunction(()=>fixture.inline.getDebugState().cards===700,undefined,{timeout:20000});
        await page.waitForTimeout(1500);
        const before=await page.evaluate(()=>({...counts}));await page.waitForTimeout(900);
        const after=await page.evaluate(()=>({...counts}));
        assert.equal(after.callbacks,before.callbacks,'observers settle instead of feeding each other');
        assert.equal(after.snapshots,before.snapshots,'renderer stops retrying once messages are present');
        assert.equal(after.saves,0,'unchanged chat load does not save history');assert.equal(after.model,0);
        assert.equal(await page.evaluate(()=>fixture.chat.every((m,i)=>m.mes===fixture.original[i]&&m.extra.qianqianjie.keep===true)),true);
        assert.equal(await page.locator('.blai-diff-btn-top').count(),withVeridis?5:0);assert.equal(await page.locator('.qqj-inline-host').count(),700);
        assert.equal(await page.evaluate(()=>fixture.inline.getDebugState().observing),false);
        assert.equal(await page.evaluate(()=>fixture.client.getDiagnosticSnapshot().latestRead.outcome),'success');
        assert.equal(await page.evaluate(()=>fixture.getAiRewriteRuntimeLog().some(e=>e.stage==='generation-created')),false);
        assert.deepEqual(errors,[]);
        const deadline=await page.evaluate(async()=>{const client=fixture.createBackendClient({baseUrl:'/api/slow',timeoutMs:25});try{await client.get('memory','v3-root');return null;}catch(e){return{code:e.code,message:e.message,diagnostic:client.getDiagnosticSnapshot().lastFailure}}});
        assert.equal(deadline.code,'BACKEND_TIMEOUT');assert.match(deadline.message,/读取记忆超时/);assert.equal(deadline.diagnostic.outcome,'timeout');
        results.push({width,cpuThrottle:rate,withVeridis,passed:true,timing,counts:after,backendDeadline:deadline});await page.close();
    }
    assert.equal(requests.filter(r=>r.path.startsWith('/api/plugins/st-bainiaodata/')).length,3);assert.ok(requests.every(r=>r.method==='GET'));
    console.log(JSON.stringify({results,requests,scenariosPassed:3,failed:0}));
}finally{fs.writeFileSync(output,JSON.stringify({results,requests,referenceCommit:'7948af1a7c0e7265b290dded3a7974a7b3be2823',scope:'native Veridis event/DOM modules + pinned Myriad renderer/backend-client; memory projection, host and data responses stubbed; not APK or actual server',realModelCalls:0},null,2));await browser.close();server.close();}
