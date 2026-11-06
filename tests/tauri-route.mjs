import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {initAppContext} from '../src/host/appContext.js';
import {callTavernHelperGenerateRaw,buildAiRewriteGenerateRawConfig} from '../src/aiRewrite/generation.js';
if (!process.env.VERIDIS_TAURI_REFERENCE) throw new Error('Set VERIDIS_TAURI_REFERENCE to the pinned TauriTavern fixture directory; see tests/README.md');
const base=pathToFileURL(resolve(process.env.VERIDIS_TAURI_REFERENCE) + '/');
const source=readFileSync(new URL('tauri240-ai-routes.js',base),'utf8').replace(/^import[\s\S]*?;\r?\n/gm,'').replace(/^export /gm,'');
const lifecycle=readFileSync(new URL('tauri240-generation-lifecycle.js',base),'utf8').replace(/^export /gm,'');
function harness({stream=false,fail=false}={}){
 const calls=[],routes=new Map();let notifications=0,helpers=0;
 const sandbox={console:{debug(){},error(){}},setTimeout,clearTimeout,TextEncoder,ReadableStream,Response,crypto,
  createAndroidGenerationBridge:()=>({}),createGenerationStatusBridge:()=>({supportsProgressUpdates:()=>false,handlesCompletion:()=>false}),
  createSystemNotificationService:()=>({preparePermission:async()=>{notifications++;return 'granted'},show:async()=>{notifications++}}),
  confirmAiNotificationPermissionRationale:()=>{},estimateTokenCount:()=>0,
  getSillyTavernLocale:()=> 'zh-CN',translateSillyTavern:(_,fallback)=>fallback,
  stripCommandErrorPrefixes:x=>x,isAbortError:e=>e?.name==='AbortError',createAbortError:()=>new DOMException('Aborted','AbortError'),
  getErrorMessage:e=>e?.message||String(e),getUserFacingErrorMessage:e=>e?.message||String(e),
  getUpstreamFailureDetails:()=>null,asUpstreamFailureDetails:()=>null,buildLegacyErrorPayload:()=>({error:true}),
  registerCaptionRoutes(){},document:{visibilityState:'hidden'},
  consumeChatCompletionStream:async({onEvent})=>{onEvent({type:'chunk',data:JSON.stringify({choices:[{delta:{content:'{"hit-1":"clean"}'}}]})});return 'done'},
 };
 vm.createContext(sandbox);vm.runInContext(lifecycle+'\n'+source+'\nglobalThis.register=registerAiRoutes;',sandbox);
 sandbox.register({post:(path,handler)=>routes.set(path,handler)},{safeInvoke:async(command,args)=>{
  calls.push({command,args});
  if(fail)throw Error('fixture failure');
  if(command==='generate_chat_completion')return{choices:[{message:{content:'{"hit-1":"clean"}'}}]};
 }},{jsonResponse:(data,status=200)=>Response.json(data,{status})});
 globalThis.__TAURITAVERN__={};delete globalThis.CultivationRuleRouter;
 globalThis.TavernHelper={generateRaw(){helpers++;throw Error('must not enter generation')}};
 globalThis.fetch=(path,init)=>routes.get(path)({body:JSON.parse(init.body),init});
 initAppContext({getSillyTavernContext:()=>({getRequestHeaders:()=>({'Content-Type':'application/json'})}),
  createEventSourceStream:()=>new TransformStream({transform(chunk,controller){
   for(const frame of new TextDecoder().decode(chunk).split('\n\n').filter(Boolean)) controller.enqueue({data:frame.slice(6),type:'message'});
  }})});
 const config=buildAiRewriteGenerateRawConfig('Clean',{baseUrl:'https://fixture.invalid/v1',apiKey:'fixture',model:'fixture',streamingEnabled:stream});
 return{run:()=>callTavernHelperGenerateRaw(config,new AbortController().signal),calls,check:()=>{assert.equal(helpers,0);assert.equal(notifications,0);delete globalThis.__TAURITAVERN__}};
}
for(const stream of [false,true])test(`Tauri 2.4.0 real route and lifecycle: stream=${stream}`,async()=>{
 const h=harness({stream});assert.equal(await h.run(),'{"hit-1":"clean"}');
 const entry=h.calls.find(x=>x.command===(stream?'start_chat_completion_stream':'generate_chat_completion'));
 assert.ok(entry);assert.equal(entry.args.dto.type,'quiet');assert.equal(entry.args.dto.stream,stream);h.check();
});
test('Tauri real quiet route returns an HTTP failure, never an assistant error message',async()=>{
 const h=harness({fail:true});await assert.rejects(h.run(),/HTTP 502/);h.check();
});
