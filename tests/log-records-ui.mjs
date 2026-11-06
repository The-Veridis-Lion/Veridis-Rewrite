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
 is(sel){return this.nodes.some(n=>sel===':focus'?n===document.activeElement:n.matches(sel))}
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
const shell=await import('/src/ui/shell.js');
const {initAppContext}=await import('/src/host/appContext.js');
const {extensionName,defaultSettings,defaultAiRewriteSettings}=await import('/src/settings/defaults.js');
const {renderTags}=await import('/src/rules/view.js');
const {updateToolbarUI}=await import('/src/presets/view.js');
const {applyPresetByName}=await import('/src/presets/application.js');
const {bindAiSettingsEvents}=await import('/src/aiRewrite/settingsEvents.js');
const fonts=await import('/src/ui/fontScale.js');
window.fixture={shell,fonts,saves:0,sideClicks:0};
const rules=Array.from({length:20},(_,i)=>({name:'规则组 '+(i+1),enabled:i%5!==0,subRules:Array.from({length:5},(_,n)=>({mode:'regex',rewriteMode:'ai',enabled:n%3!==0,targets:['(?<![“「])示例目标与较长正则表达式'.repeat(4)],replacements:[],aiPromptTemplate:'保持实际动作、对白和正常数量。'}))}));
const settings=structuredClone(defaultSettings);Object.assign(settings,{logLevel:0,rules,activePreset:'原有规则集',presets:{'原有规则集':{rules},'新规则集':{rules:rules.slice(0,3),aiRewrite:{temperature:1.9,promptTemplate:'不覆盖'}}},aiRewrite:{...defaultAiRewriteSettings,enabled:true,temperature:0.65,promptTemplate:'保持当前全局提示词。'}});
fixture.settings=settings;
initAppContext({extension_settings:{[extensionName]:settings},saveSettingsDebounced:()=>fixture.saves++,getSillyTavernContext:()=>({})});
document.querySelector('#blai-purifier-popup').style.display='grid';
renderTags();updateToolbarUI();bindAiSettingsEvents();fonts.bindUiFontScaleEvents();
document.querySelector('#blai-ai-temperature').value=settings.aiRewrite.temperature;
document.querySelector('#blai-ai-prompt').value=settings.aiRewrite.promptTemplate;
document.addEventListener('click',e=>{const nav=e.target.closest('[data-page-target]');if(nav)shell.showResponsivePage(nav.dataset.pageTarget)});
document.querySelector('#blai-close-btn').onclick=()=>document.querySelector('#blai-purifier-popup').style.display='none';
document.querySelector('#blai-preset-save').onclick=()=>fixture.saves++;
document.querySelector('#blai-preset-select').onchange=e=>applyPresetByName(e.target.value);
for(const id of ['outside-left','outside-right'])document.getElementById(id).onclick=()=>fixture.sideClicks++;
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
const setStreaming = async enabled => {
    const input = page.locator('#blai-ai-streaming-enabled');
    if (await input.isChecked() !== enabled) await page.locator('label.blai-ai-switch:has(#blai-ai-streaming-enabled)').click();
    assert.equal(await input.isChecked(), enabled);
};
try {
    await page.goto('http://127.0.0.1:' + server.address().port, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.fixture?.ready);
    await page.evaluate(async()=>{
        window.logs=await import('/src/aiRewrite/debug.js');
        window.monitor=await import('/src/aiRewrite/communicationMonitor.js');
        window.logView=await import('/src/feedback/view.js');
        window.copied=[];
        window.TavernHelper={builtin:{copyText:async text=>copied.push(text)}};
        (await import('/src/feedback/events.js')).bindFeedbackEvents();
        logs.clearAiRewriteDebugLog();
        for (const id of ['generation-1','generation-2']) {
            logs.recordAiRewriteDebug('generation-created',{generationId:id});
            logs.recordAiRewriteDebug('fetch-start',{generationId:id});
            logs.recordAiRewriteDebug('parse-result',{acceptedCount:id === 'generation-1' ? 1 : 2});
            logs.recordAiRewriteDebug('run-success',{generationId:id});
        }
        logView.openFeedbackWorkspace('runtime-log');logView.renderRuntimeLog();
    });
    for(const width of [390,768,1920]) {
        await page.setViewportSize({width,height:900});
        const cards=page.locator('#blai-ai-debug-log .blai-log-record');
        assert.equal(await cards.count(),2);
        await cards.first().getByRole('button',{name:'复制本组'}).click();
        const copied=await page.evaluate(()=>window.copied.at(-1));
        assert.match(copied,/generation-2/);assert.match(copied,/parse-result/);assert.doesNotMatch(copied,/generation-1/);
        assert.equal(copied.split('run-success').length-1,1);
        await page.screenshot({path:path.join(output,`runtime-${width}.png`)});
        check(`runtime group copy at ${width}px contains exactly one rewrite`);
    }
    await page.evaluate(()=>{
        monitor.clearAiCommunicationRecords();
        for(const [n,startedAtMs] of [[1,100],[2,100],[3,200]]) monitor.recordAiCommunicationSuccess({
            context:{generationId:'generation-'+startedAtMs,startedAtMs},startedAt:n,endedAt:n+1,requestJson:`request-${n}`,response:`response-${n}`,
        });
        logView.openFeedbackWorkspace('ai-context');logView.renderAiContext();
    });
    const aiCards=page.locator('#blai-ai-monitor-output .blai-log-record');
    assert.equal(await aiCards.count(),2);
    await aiCards.nth(1).getByRole('button',{name:'复制本组'}).click();
    const copied=await page.evaluate(()=>window.copied.at(-1));
    assert.match(copied,/request-1/);assert.match(copied,/response-2/);assert.doesNotMatch(copied,/request-3/);
    check('AI copy includes all retained requests from one task, excludes next task');
    await page.reload({waitUntil:'networkidle'});
    await page.waitForFunction(()=>window.fixture?.ready);
    await page.evaluate(async()=>{
        window.monitor=await import('/src/aiRewrite/communicationMonitor.js');
        window.logView=await import('/src/feedback/view.js');
        window.copied=[];window.TavernHelper={builtin:{copyText:async text=>copied.push(text)}};
        (await import('/src/feedback/events.js')).bindFeedbackEvents();
        logView.openFeedbackWorkspace('ai-context');logView.renderAiContext();
    });
    assert.equal(await aiCards.count(),2);
    await aiCards.nth(1).getByRole('button',{name:'复制本组'}).click();
    assert.match(await page.evaluate(()=>copied.at(-1)),/response-2/);
    check('real page reload restores AI request groups and copy buttons');
    await page.getByRole('button',{name:'清空',exact:true}).click();
    assert.equal(await aiCards.count(),0);
    assert.match(await page.locator('#blai-ai-monitor-output').textContent(),/暂无通信记录/);
    check('clear removes both cards and copy buttons');
    await page.evaluate(()=>{
        logView.closeFeedbackWorkspace();
        const overlay=document.createElement('div');overlay.id='other-plugin';
        Object.assign(overlay.style,{position:'fixed',inset:'0',zIndex:'2000000000',background:'red'});document.body.append(overlay);
    });
    for(const width of [390,768,1920]) {
        await page.setViewportSize({width,height:900});
        const top=await page.evaluate(()=>{
            const root=document.getElementById('blai-purifier-popup'),r=root.getBoundingClientRect();
            return !!document.elementFromPoint(r.x+r.width/2,r.y+25)?.closest('#blai-purifier-popup');
        });
        assert.equal(top,true);check(`main window above competing high-z overlay at ${width}px`);
        await page.screenshot({path:path.join(output,`layer-${width}.png`)});
    }
    await page.evaluate(()=>{logView.openFeedbackWorkspace('runtime-log');logView.renderRuntimeLog();});
    assert.equal(await page.evaluate(()=>{const r=document.getElementById('blai-feedback-workspace').getBoundingClientRect();return !!document.elementFromPoint(r.x+r.width/2,r.y+25)?.closest('#blai-feedback-workspace')}),true);
    check('feedback workspace remains above plugin main window');
    assert.deepEqual(errors,[]);
} finally {
    fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({results,errors,realModelCalls:0,host:'isolated Chromium fixture; actual template/CSS/log modules and delegated copy handler'},null,2));
    await browser.close();server.close();
}

