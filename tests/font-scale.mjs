import assert from 'node:assert/strict';
import {test} from 'node:test';
import {initAppContext} from '../src/host/appContext.js';
import {extensionName} from '../src/settings/defaults.js';
import {normalizeUiFontScale,bindUiFontScaleEvents} from '../src/ui/fontScale.js';
test('font scale defaults, rounds and clamps unsupported stored values',()=>{
 for(const [value,expected] of [[undefined,1],[NaN,1],['bad',1],[Infinity,1],[0,1],[0.5,1],[1,1],['1.2',1.2],[1.35,1.4],[1.6,1.6],[9,1.6]])assert.equal(normalizeUiFontScale(value),expected);
});
test('UI and diff sizes save independently; missing diff preference starts at standard size',()=>{
 let saves=0;const style=new Map(),select={value:'1'},diffSelect={value:'1'};
 globalThis.document={documentElement:{style:{setProperty:(key,value)=>style.set(key,value)}},getElementById:id=>id==='blai-ui-font-scale'?select:diffSelect};
 const settings={rules:[{enabled:true}],aiRewrite:{temperature:0.95,promptTemplate:'Keep'},presets:{mine:{rules:[]}},uiFontScale:1.3};
 initAppContext({extension_settings:{[extensionName]:settings},saveSettingsDebounced:()=>saves++});
 const before=structuredClone(settings);
 bindUiFontScaleEvents();assert.equal(select.value,'1.3');assert.equal(style.get('--blai-ui-font-scale'),'1.3');assert.equal(saves,0);
 assert.equal(diffSelect.value,'1');assert.equal(style.get('--blai-diff-font-scale'),'1');assert.deepEqual(settings,before);
 bindUiFontScaleEvents();select.value='1.6';select.onchange();assert.equal(saves,1);assert.equal(settings.uiFontScale,1.6);
 const expected={...before,uiFontScale:1.6};assert.deepEqual(settings,expected);
 assert.equal(diffSelect.value,'1');assert.equal(style.get('--blai-diff-font-scale'),'1');
 style.clear();bindUiFontScaleEvents();assert.equal(style.get('--blai-ui-font-scale'),'1.6');assert.equal(saves,1);
 select.value='1';select.onchange();assert.equal(style.get('--blai-ui-font-scale'),'1');assert.equal(saves,2);
 diffSelect.value='1.2';diffSelect.onchange();assert.equal(saves,3);
 assert.deepEqual(settings,{...before,uiFontScale:1,diffFontScale:1.2});
 assert.equal(style.get('--blai-ui-font-scale'),'1');assert.equal(style.get('--blai-diff-font-scale'),'1.2');
 style.clear();bindUiFontScaleEvents();assert.equal(saves,3);
 assert.equal(select.value,'1');assert.equal(diffSelect.value,'1.2');
 assert.equal(style.get('--blai-ui-font-scale'),'1');assert.equal(style.get('--blai-diff-font-scale'),'1.2');
});

test('missing controls and invalid stored values still initialize both CSS preferences safely',()=>{
 const style=new Map();let saves=0;
 globalThis.document={documentElement:{style:{setProperty:(key,value)=>style.set(key,value)}},getElementById:()=>null};
 const settings={uiFontScale:'invalid',diffFontScale:Infinity};
 initAppContext({extension_settings:{[extensionName]:settings},saveSettingsDebounced:()=>saves++});
 bindUiFontScaleEvents();assert.equal(style.get('--blai-ui-font-scale'),'1');assert.equal(style.get('--blai-diff-font-scale'),'1');assert.equal(saves,0);
});
