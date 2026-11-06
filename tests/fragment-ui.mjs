// Isolated browser host: real plugin template, styles, shell and rule-card renderer.
// Optional BLAI_TEST_MODULES points at a node_modules directory containing Playwright.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.BLAI_TEST_MODULES || import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const template = fs.readFileSync(path.join(root, 'templates/purifier.html'), 'utf8').replace('{{logoUrl}}', '/images/veridis-logo.png');
const fixture = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css">
<style>html,body{margin:0;font-family:Arial,'Microsoft YaHei',sans-serif;font-size:14px}body{background:linear-gradient(120deg,#dce8dc,#e5cfc3)}
#sheld{position:absolute;width:51vw;left:24.5vw;top:0;height:100vh;background:#eef1f4}#outside-left,#outside-right{position:absolute;top:160px;padding:18px}#outside-left{left:12px}#outside-right{right:12px}
:root{--SmartThemeBlurTintColor:#fbfaf7;--SmartThemeQuoteColor:#62564f;--SmartThemeBodyColor:#403831;--SmartThemeBorderColor:#d9cec4}
.fas:before{content:'·'}button{font:inherit}</style></head><body><div id="sheld"></div><button id="outside-left">左侧区域</button><button id="outside-right">右侧区域</button>${template}
<script type="module">
class Q {
 constructor(nodes){this.nodes=nodes;this.length=nodes.length;nodes.forEach((n,i)=>this[i]=n)}
 each(fn){this.nodes.forEach((n,i)=>fn.call(n,i,n));return this}
 find(sel){return new Q(this.nodes.flatMap(n=>Array.from(n.querySelectorAll(sel))))}
 children(){return new Q(this.nodes.flatMap(n=>Array.from(n.children)))}
 filter(fn){return new Q(this.nodes.filter((n,i)=>fn(i,n)))}
 closest(sel){return new Q(this.nodes.map(n=>n.closest(sel)).filter(Boolean))}
 text(value){if(value===undefined)return this.nodes[0]?.textContent;return this.each(function(){this.textContent=value})}
 html(value){if(value===undefined)return this.nodes[0]?.innerHTML;return this.each(function(){this.innerHTML=value})}
 val(value){if(value===undefined)return this.nodes[0]?.value;return this.each(function(){this.value=value})}
 attr(name,value){if(value===undefined)return this.nodes[0]?.getAttribute(name);return this.each(function(){this.setAttribute(name,value)})}
 prop(name,value){if(value===undefined)return this.nodes[0]?.[name];return this.each(function(){this[name]=value})}
 toggleClass(name,on){return this.each(function(){this.classList.toggle(name,on)})}
 addClass(name){return this.each(function(){this.classList.add(name)})}
 removeClass(name){return this.each(function(){this.classList.remove(name)})}
 detach(){return this.each(function(){this.remove()})}
 remove(){return this.each(function(){this.remove()})}
 hasClass(name){return this.nodes.some(n=>n.classList.contains(name))}
 is(sel){return this.nodes.some(n=>sel===':visible'?getComputedStyle(n).display!=='none':sel===':focus'?n===document.activeElement:n.matches(sel))}
 hide(){return this.css('display','none')}
 toggle(on){return this.css('display',on?'':'none')}
 css(name,value){return this.each(function(){this.style.setProperty(name,value)})}
 insertAfter(target){const el=$(target)[0];if(el)this.nodes.forEach(n=>el.after(n));return this}
 prependTo(target){const el=$(target)[0];if(el)this.nodes.slice().reverse().forEach(n=>el.prepend(n));return this}
 trigger(type){return this.each(function(){if(type==='focus')this.focus();else this.dispatchEvent(new Event(type,{bubbles:true}))})}
 off(){return this}
 on(types,selector,handler){if(typeof selector==='function'){handler=selector;selector=null}return this.each(function(){for(const type of types.split(' ')){this.addEventListener(type.split('.')[0],e=>{const matched=selector?e.target.closest(selector):this;if(matched)handler.call(matched,e)})}})}
 empty(){return this.html('')}
 append(child){return this.each(function(){for(const node of child.nodes||(child.nodeType?[child]:[]))this.append(node)})}
 appendTo(target){$(target).append(this);return this}
}
window.$=(sel,props)=>{
 if(sel instanceof Q)return sel;
 if(typeof sel==='string'&&sel.startsWith('<')){const t=document.createElement('template');t.innerHTML=sel.replace(/^<(\\w+)>$/,'<$1></$1>');const q=new Q(Array.from(t.content.children));if(props)for(const[k,v]of Object.entries(props))k==='text'?q.text(v):q.attr(k,v);return q}
 return new Q(typeof sel==='string'?Array.from(document.querySelectorAll(sel)):sel?[sel]:[])
};
const {initAppContext}=await import('/src/host/appContext.js');
const {extensionName,defaultSettings}=await import('/src/settings/defaults.js');
const meta=await import('/src/diff/messageMeta.js');
const chat=JSON.parse(localStorage.getItem('testChat')||'null')||[{mes:'好。好。',swipe_id:0,swipes:['好。好。','其他'],extra:{}}];
if(!localStorage.getItem('testChat'))meta.writeMessageDiffAiStage(chat[0],'swipe:0','旧。旧。','好。好。','好。好。');
window.fixture={chat,saves:0,meta};
const settings=structuredClone(defaultSettings);settings.diffViewMode='full';settings.logLevel=0;
const context={chat,updateMessageBlock:()=>{},saveChat:async()=>{localStorage.setItem('testChat',JSON.stringify(chat));fixture.saves++}};
initAppContext({chat,extension_settings:{[extensionName]:settings},saveSettingsDebounced:()=>{},saveChat:context.saveChat,getSillyTavernContext:()=>context});
(await import('/src/diff/events.js')).bindDiffEvents();
document.body.insertAdjacentHTML('beforeend','<button class="blai-diff-btn" data-index="0" id="test-open">打开透视</button>');
fixture.ready=true;
</script></body></html>`;

const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://fixture').pathname);
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html;charset=utf-8'); return res.end(fixture); }
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'image/png');
    res.end(fs.readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], executablePath: process.env.BLAI_TEST_CHROME || undefined });
const results = [], errors = [];
const output = process.env.BLAI_TEST_OUTPUT || path.join(root, '..', 'scrollbar-ui-results');
fs.mkdirSync(output, { recursive: true });
const page = await browser.newPage();
page.on('pageerror', error => { errors.push(error.message); console.log('BROWSER ERROR '+error.message); });
const check = (name, data = {}) => { results.push({ name, passed: true, ...data }); console.log('PASS ' + name); };

try {
 await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.fixture?.ready);
 await page.locator('#test-open').click();
 await page.locator('#blai-diff-modal-content ins').last().click();
 await page.locator('#blai-fragment-text').fill('新');await page.locator('#blai-fragment-save').click();
 assert.equal(await page.evaluate(()=>fixture.chat[0].mes),'好。新。');check('click edit');
 await page.locator('#blai-diff-modal-content ins[data-blai-diff-section="program"]').last().click();
 await page.locator('#blai-fragment-restore').click();
 assert.equal(await page.evaluate(()=>fixture.chat[0].mes),'好。好。');check('click partial restore');
 await page.locator('#blai-diff-modal-content ins').last().click();
 await page.locator('#blai-fragment-text').fill('改');await page.locator('#blai-fragment-save').click();
 await page.locator('#blai-diff-revert-toggle').click();
 assert.equal(await page.evaluate(()=>fixture.chat[0].mes),'旧。旧。');
 await page.locator('#blai-diff-revert-toggle').click();
 assert.equal(await page.evaluate(()=>fixture.chat[0].mes),'好。改。');check('whole undo and restore retains edit');
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('testChat')||'[]')[0]?.mes==='好。改。');
 await page.reload();await page.waitForFunction(()=>window.fixture?.ready);await page.locator('#test-open').click();
 assert.equal(await page.evaluate(()=>fixture.chat[0].mes),'好。改。');
 await page.locator('#blai-diff-revert-toggle').click();await page.locator('#blai-diff-revert-toggle').click();
 assert.equal(await page.evaluate(()=>fixture.chat[0].swipes[0]),'好。改。');check('reload and another undo restore');
 await page.locator('#blai-diff-modal-content ins[data-blai-diff-section="program"]').last().click();
 await page.evaluate(()=>fixture.chat[0].mes='外部编辑');await page.locator('#blai-fragment-save').click();
 assert.equal(await page.evaluate(()=>fixture.chat[0].mes),'外部编辑');assert.match(await page.locator('#blai-fragment-status').innerText(),/未保存/);check('stale save blocked');
 await page.locator('#blai-diff-related-close').click();
 page.once('dialog',d=>d.dismiss());
 await page.locator('#blai-diff-revert-toggle').click();
 assert.equal(await page.evaluate(()=>fixture.chat[0].mes),'外部编辑');check('external edit undo cancelled');
 page.once('dialog',d=>d.accept());
 await page.locator('#blai-diff-revert-toggle').click();
 assert.equal(await page.evaluate(()=>fixture.chat[0].mes),'旧。旧。');
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('testChat')||'[]')[0]?.mes==='旧。旧。');
 await page.reload();await page.waitForFunction(()=>window.fixture?.ready);await page.locator('#test-open').click();
 await page.locator('#blai-diff-revert-toggle').click();
 assert.equal(await page.evaluate(()=>fixture.chat[0].mes),'外部编辑');
 assert.deepEqual(await page.evaluate(()=>fixture.chat[0].swipes),['外部编辑','其他']);check('external edit undo reload restore');
 await page.reload();await page.waitForFunction(()=>window.fixture?.ready);
 await page.evaluate(()=>{
  const text='开头。保持原文。结尾。';fixture.chat[0].mes=text;fixture.chat[0].swipes[0]=text;
  fixture.meta.writeMessageDiffAiStage(fixture.chat[0],'swipe:0',text,text,text,[{start:3,end:8,reason:'unchanged'}]);
 });
 await page.locator('#test-open').click();
 await page.locator('#blai-diff-modal-content mark.blai-diff-ai-unchanged').waitFor();
 assert.equal(await page.locator('#blai-diff-modal-content mark').innerText(),'保持原文。');
 assert.match(await page.locator('#blai-diff-modal-content mark').getAttribute('title'),/规则例外/);
 assert.equal(await page.locator('.blai-diff-unchanged-item').count(),0);
 await page.screenshot({path:path.join(output,'inline-amber.png')});check('unchanged target appears inline in original order');
 await page.locator('#blai-diff-revert-toggle').click();await page.locator('#blai-diff-revert-toggle').click();
 await page.waitForFunction(()=>JSON.parse(localStorage.getItem('testChat')||'[]')[0]?.mes==='开头。保持原文。结尾。');
 await page.reload();await page.waitForFunction(()=>window.fixture?.ready);await page.locator('#test-open').click();
 await page.locator('#blai-diff-modal-content mark.blai-diff-ai-unchanged').waitFor();
 assert.equal(await page.locator('#blai-diff-modal-content mark').innerText(),'保持原文。');check('inline amber survives undo restore and reload');
 assert.deepEqual(errors,[]);
} finally {fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({results,errors},null,2));await browser.close();server.close();}

