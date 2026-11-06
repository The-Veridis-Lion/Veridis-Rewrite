// A/B loads each complete Veridis entry point. Luker CSS and jQuery are pinned;
// host lifecycle/data and the binding backend response are controlled fixtures.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require=createRequire(process.env.BLAI_TEST_MODULES || import.meta.url);
const {chromium}=require('playwright');
const base=process.env.BLAI_AB_BASE; if(!base)throw Error('Set BLAI_AB_BASE to a workspace containing the original source snapshot');
const roots={original:process.env.BLAI_AB_ORIGINAL || 'Veridis-Rewrite-original-46182c6',
 candidate:process.env.BLAI_AB_CANDIDATE || fileURLToPath(new URL('..',import.meta.url))};
const reference=process.env.BLAI_AB_REFERENCE;
if(!reference)throw Error('Set BLAI_AB_REFERENCE to a folder containing pinned jquery.js and luker-style.css');
const prefix='/scripts/extensions/third-party/Veridis-Rewrite/';
const scriptStub=`export const chat=[],event_types=Object.fromEntries(['APP_READY','CHAT_CHANGED','MESSAGE_RECEIVED','MESSAGE_EDITED','MESSAGE_UPDATED','CHARACTER_MESSAGE_RENDERED','USER_MESSAGE_RENDERED','MESSAGE_SWIPED','MESSAGE_DELETED','GENERATION_STARTED','GENERATION_ENDED','GENERATION_STOPPED','STREAM_TOKEN_RECEIVED'].map(x=>[x,x]));
const listeners=new Map();export const eventSource={on(e,f){if(!listeners.has(e))listeners.set(e,[]);listeners.get(e).push(f)},off(e,f){listeners.set(e,(listeners.get(e)||[]).filter(x=>x!==f))},makeFirst(){},makeLast(){},async emit(e,...a){for(const f of listeners.get(e)||[])await f(...a)}};
export const CLIENT_VERSION='Luker:fixture',streamingProcessor=null;
export function saveSettingsDebounced(){window.counts.settingsSaves++}
export async function saveChat(){window.counts.chatSaves++}
window.host={chat,eventSource,eventTypes:event_types,chatId:'fixture',characters:[{name:'Fixture'}],characterId:0,chatMetadata:{},getCurrentChatId:()=> 'fixture',getRequestHeaders:()=>({}),saveChat,updateMessageBlock(){}};`;
const extensionsStub=`import {defaultSettings,extensionName} from '${prefix}src/settings/defaults.js';
export const extension_settings={[extensionName]:structuredClone(defaultSettings)};
Object.assign(extension_settings[extensionName],{logLevel:0,showComposerAiRewriteButton:false});
extension_settings[extensionName].aiRewrite.autoTriggerEnabled=false;
export const extensionTypes={'third-party/Veridis-Rewrite':'local'},extensionNames=['third-party/Veridis-Rewrite'];
export const getContext=()=>window.host;
export async function renderExtensionTemplateAsync(){return await(await fetch('${prefix}templates/purifier.html')).text()}
export async function getExtensionManifest(){return await(await fetch('${prefix}manifest.json')).json()}
window.settings=extension_settings[extensionName];`;
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/luker-style.css"><link rel="stylesheet" href="${prefix}style.css">
<style>html,body{width:100%;height:100%;margin:0}#sheld{position:absolute;top:0;left:24.5%;width:51%;height:100vh}#chat{overflow:auto;height:80vh}@media(max-width:600px){#sheld{left:0;width:100%}}</style>
<body><div id="extensions_settings"></div><div id="data_bank_wand_container"></div><div id="sheld"><div id="chat"></div><textarea id="send_textarea"></textarea></div>
<script>window.counts={chatSaves:0,settingsSaves:0,rectReads:0,layoutCallbacks:0,resizeCallbacks:0,mutations:0};const nativeRect=Element.prototype.getBoundingClientRect;Element.prototype.getBoundingClientRect=function(){if(this.id==='sheld')counts.rectReads++;return nativeRect.call(this)};
const MO=MutationObserver;window.MutationObserver=class extends MO{constructor(fn){super((records,self)=>{counts.mutations++;if(records.some(r=>r.type==='attributes'&&['blai-purifier-popup','sheld'].includes(r.target.id)||r.target===document.body))counts.layoutCallbacks++;fn(records,self)})}};
const RO=ResizeObserver;window.ResizeObserver=class extends RO{constructor(fn){super((entries,self)=>{counts.resizeCallbacks++;fn(entries,self)})}};
window.LukerAndroid={};window.TavernHelper={generateRaw(){throw Error('unexpected model call')}};</script><script src="/jquery.js"></script>
<script type="module">await import('${prefix}index.js');window.imported=true;</script>`;
const requests=[],results=[];
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://fixture'), version=url.searchParams.get('version')||req.headers.cookie?.match(/version=([^;]+)/)?.[1]||'original';
 const root=path.resolve(base,roots[version]||roots.original);let body,type='text/javascript';
 if(url.pathname==='/'){res.setHeader('Set-Cookie','version='+version);body=html;type='text/html;charset=utf-8'}
 else if(url.pathname==='/lib.js')body='export const yaml={parse:JSON.parse};';
 else if(url.pathname==='/script.js')body=scriptStub;
 else if(url.pathname==='/scripts/extensions.js')body=extensionsStub;
 else if(url.pathname==='/scripts/personas.js')body="export const user_avatar='fixture.png';";
 else if(url.pathname==='/scripts/world-info.js')body='export const world_info={},worldInfoCache=new Map();';
 else if(url.pathname==='/scripts/util/stream-fadein.js')body='export function applyStreamFadeIn(){}';
 else if(['/jquery.js','/luker-style.css'].includes(url.pathname)){body=fs.readFileSync(path.join(reference,url.pathname.slice(1)));type=url.pathname.endsWith('.css')?'text/css':type}
 else if(url.pathname.startsWith('/api/')){requests.push({version,path:url.pathname,method:req.method});type='application/json';body=JSON.stringify({currentCommitHash:'46182c691688360ee698f3d9d44b46fbfb057d64',revision:1,data:{}})}
 else if(url.pathname.startsWith(prefix)){
  const file=path.resolve(root,url.pathname.slice(prefix.length));if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);return res.end()}
  body=fs.readFileSync(file);type=file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':file.endsWith('.json')?'application/json':type;
 }else {res.writeHead(404);return res.end()}
 res.setHeader('Content-Type',type);res.end(body);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,executablePath:process.env.BLAI_TEST_CHROME || undefined});
try{
 for(const version of Object.keys(roots)){
  const context=await browser.newContext({viewport:{width:360,height:744},isMobile:true,hasTouch:true});
  await context.route('https://**/*',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({version:'3.5',update_note:'fixture',object:{sha:'46182c691688360ee698f3d9d44b46fbfb057d64'}})}));
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('ERROR '+e.message)});page.on('console',msg=>{if(msg.type()==='error')console.log('CONSOLE '+msg.text())});
  const cdp=await context.newCDPSession(page);await cdp.send('Emulation.setCPUThrottlingRate',{rate:6});
  await page.goto('http://127.0.0.1:'+server.address().port+'/?version='+version,{waitUntil:'networkidle'});
  await page.waitForFunction(()=>window.imported&&document.getElementById('blai-tools-version-content')?.textContent.trim(),null,{timeout:10000}).catch(async e=>{console.log(await page.evaluate(()=>({imported:window.imported,body:document.body.innerText.slice(-1300)})));throw e});
  await page.waitForTimeout(900);
  const initial=await page.evaluate(()=>({...counts}));
  const timing=await page.evaluate(async()=>{
   const start=performance.now();host.chat.splice(0,host.chat.length,...Array.from({length:700},(_,i)=>({is_user:false,mes:'<content>两人搬来两个箱子。第'+i+'页。</content>',extra:{fixture:true}})));
   const p=fetch('/api/plugins/st-bainiaodata/fixture-binding').then(r=>r.json());
   await host.eventSource.emit('CHAT_CHANGED','fixture');
   const fragment=document.createDocumentFragment();for(let i=0;i<700;i++){const e=document.createElement('div');e.className='mes';e.setAttribute('mesid',i);e.innerHTML='<div class="mes_buttons"><span class="mes_edit"></span></div><div class="mes_text">两个人搬来两个箱子。</div><div class="swipeRightBlock"></div>';fragment.append(e)}
   document.getElementById('chat').append(fragment);await host.eventSource.emit('GENERATION_STARTED','normal',{},true);await p;
   return performance.now()-start;
  });
  await page.waitForTimeout(1000);const opened=await page.evaluate(()=>({...counts}));
  const churn=await page.evaluate(async()=>{const before={...counts};for(let i=0;i<30;i++){document.body.classList.toggle('fixture-switch');document.getElementById('sheld').style.height=(740+i%2)+'px';await new Promise(requestAnimationFrame)}return{before,after:{...counts}}});
  await page.waitForTimeout(500);const settled1=await page.evaluate(()=>({...counts}));await page.waitForTimeout(500);const settled2=await page.evaluate(()=>({...counts}));
  assert.deepEqual(errors,[]);assert.equal(settled2.chatSaves,0);assert.equal(settled1.rectReads,settled2.rectReads,'no persistent layout loop');
  const checks=[];
  if(version==='candidate'){
   assert.equal(initial.rectReads,0);assert.equal(settled2.rectReads,0);assert.equal(settled2.layoutCallbacks,0);assert.equal(settled2.resizeCallbacks,0);
   checks.push('closed mobile window performs zero host layout reads or layout callbacks');
   await page.evaluate(()=>document.getElementById('blai-purifier-popup').style.display='grid');
   await page.waitForFunction(()=>matchMedia('(max-width: 600px)').matches);
   const mobile=await page.evaluate(async()=>{const before={...counts};for(let i=0;i<8;i++){document.body.classList.toggle('fixture-switch');document.getElementById('sheld').style.height=(740+i%2)+'px';await new Promise(requestAnimationFrame)}return{before,after:{...counts}}});
   assert.equal(mobile.after.rectReads,0);assert.equal(mobile.after.resizeCallbacks,0);checks.push('open mobile window also avoids host column measurements and observers');
   await page.setViewportSize({width:1920,height:1080});
   await page.waitForFunction(()=>Math.round(document.getElementById('blai-purifier-popup').getBoundingClientRect().width)===1040);
   await page.evaluate(()=>{document.getElementById('sheld').style.width='800px';document.getElementById('sheld').style.left='200px'});
   await page.waitForTimeout(100);assert.equal(await page.locator('#blai-purifier-popup').evaluate(el=>Math.round(el.getBoundingClientRect().width)),1040);assert.equal(await page.locator('#blai-purifier-popup').evaluate(el=>Math.round(el.getBoundingClientRect().left)),440);
   checks.push('open desktop window is fixed at 1040px and centered independently of chat column');
   await page.evaluate(()=>document.getElementById('blai-purifier-popup').style.display='none');await page.waitForTimeout(150);
   const closed=await page.evaluate(async()=>{const before={...counts};for(let i=0;i<8;i++){document.body.classList.toggle('fixture-switch');document.getElementById('sheld').style.width=(800+i%2)+'px';await new Promise(requestAnimationFrame)}return{before,after:{...counts}}});
   assert.equal(closed.after.rectReads,closed.before.rectReads);assert.equal(closed.after.resizeCallbacks,closed.before.resizeCallbacks);assert.equal(closed.after.layoutCallbacks,closed.before.layoutCallbacks);assert.equal(closed.after.rectReads,0);assert.equal(closed.after.resizeCallbacks,0);checks.push('desktop window never registers layout observers or reads chat bounds');
   await page.evaluate(()=>document.getElementById('blai-purifier-popup').style.display='grid');
   await page.waitForFunction(()=>Math.round(document.getElementById('blai-purifier-popup').getBoundingClientRect().width)===1040);
   await page.evaluate(()=>{document.getElementById('sheld').style.width='100%';document.getElementById('sheld').style.left='0'});
   await page.setViewportSize({width:360,height:744});await page.waitForFunction(()=>matchMedia('(max-width: 600px)').matches);await page.waitForTimeout(150);
   const before=await page.evaluate(()=>({...counts}));await page.evaluate(()=>document.getElementById('sheld').style.width='320px');await page.waitForTimeout(200);
   assert.deepEqual(await page.evaluate(()=>({...counts})),before);checks.push('reopen and desktop-to-mobile breakpoint work entirely through CSS');
  }
  results.push({version,completeEntryPoint:true,cpuThrottle:6,viewport:360,initial,opened,churn,settled:settled2,chatOpenElapsedMs:timing,checks,errors});
  console.log(JSON.stringify(results.at(-1)));await context.close();
 }
}finally{fs.writeFileSync(path.join(base,'luker-original-ab-results.json'),JSON.stringify({results,requests,scope:'Complete Veridis entry point; pinned Luker CSS/jQuery; stub host lifecycle/backend, not an Android APK or actual memory service'},null,2));await browser.close();server.close()}
