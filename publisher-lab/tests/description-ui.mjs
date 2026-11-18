import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

// 仅运行生产镜像模块；正文始终留在当前 textarea，不使用 localStorage 或宿主保存接口。
const root = fileURLToPath(new URL('../app/', import.meta.url));
const output = fileURLToPath(new URL('../output/playwright/', import.meta.url));
await mkdir(output, {recursive: true});
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/studio.css"><link rel="stylesheet" href="/studio-description.css"><style>body{padding:32px}.fixture{width:680px;max-width:100%}.description-editor{border-color:#5684ff}.description-editor #description{height:130px;min-height:90px}.description-footer{justify-content:flex-end}</style><div class="fixture"><label for="description">描述</label><div class="description-editor"><textarea id="description" aria-label="描述" maxlength="1000" rows="4" placeholder="添加作品描述…"></textarea><div class="description-footer"><span id="count"></span></div></div></div><script type="module">
import {mountDescriptionHighlight} from '/studio-description.js';
window.entities=[{kind:'topic',id:'1',name:'摄影'},{kind:'topic',id:'duplicate',name:'摄影'},{kind:'mention',id:'2',name:'小明'},{kind:'topic',id:'3',name:'海边'}];
window.original='旅行见闻 #摄影 和 @小明。\\n#摄影技巧不是已选话题；#摄影 再出现。🌊 #海边';
window.input=document.querySelector('#description');input.value=original;window.inputEvents=0;
input.addEventListener('input',()=>{inputEvents++;document.querySelector('#count').textContent=input.value.length+' / 1000';});
input.focus();input.setSelectionRange(2,7,'backward');window.before={value:input.value,start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection};
window.highlighter=mountDescriptionHighlight(input,{getEntities:()=>entities});window.ready=true;
</script></html>`;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
  const file = resolve(root, '.' + url.pathname);
  if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
  try { response.setHeader('Content-Type', ({'.js': 'text/javascript', '.css': 'text/css'})[extname(file)] || 'application/octet-stream'); response.end(await readFile(file)); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
try {
  const page = await browser.newPage({viewport: {width: 900, height: 600}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => window.ready);
  assert.deepEqual(await page.evaluate(() => ({value:input.value,start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection})), await page.evaluate(() => before));
  assert.equal(await page.locator('#description').evaluate(input => document.activeElement === input), true);
  assert.equal(await page.getByRole('textbox', {name: '描述', exact: true}).count(), 1);
  assert.equal(await page.locator('.studio-description-highlight-viewport').getAttribute('aria-hidden'), 'true');
  assert.deepEqual(await page.locator('.studio-description-entity').allTextContents(), ['#摄影', '@小明', '#摄影', '#海边']);
  assert.equal(await page.evaluate(() => inputEvents), 0, 'mount and render cannot dispatch input');
  assert.notEqual(await page.locator('#description').evaluate(input => getComputedStyle(input).color), 'rgba(0, 0, 0, 0)', 'native input keeps its own visible text');
  await page.evaluate(() => { input.setSelectionRange(input.value.length,input.value.length); highlighter.render(); });
  await page.screenshot({path: output + 'studio-description-wide.png'});

  // 新建话题的字符串 "0" 是有效身份；不同名称不能被按同一个 ID 合并，边界外的相似文本不高亮。
  await page.evaluate(() => {
    entities=[{kind:'topic',id:'0',name:'有序图库'},{kind:'topic',id:'0',name:'20190101'},{kind:'topic',id:'0',name:'20210706'},{kind:'topic',id:'0',name:'手动新话题'}];
    input.value='#有序图库\n日期 #20190101，下一天 #20210706。#手动新话题\n#201901010 #202107060 #手动新话题扩展 #有序图库摄影 #未绑定\n再次 #20190101';
    input.setSelectionRange(3,12,'backward');window.zeroBefore={value:input.value,start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection};highlighter.render();
  });
  assert.deepEqual(await page.locator('.studio-description-entity').allTextContents(), ['#有序图库', '#20190101', '#20210706', '#手动新话题', '#20190101']);
  assert.deepEqual(await page.locator('.studio-description-entity').evaluateAll(nodes => nodes.map(node => node.dataset.entityId)), ['0', '0', '0', '0', '0']);
  assert.equal(await page.locator('.studio-description-entity').first().evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(228, 240, 255)', 'new topic must use the normal light-blue entity mark');
  assert.deepEqual(await page.evaluate(() => ({value:input.value,start:input.selectionStart,end:input.selectionEnd,direction:input.selectionDirection})), await page.evaluate(() => zeroBefore));
  await page.evaluate(() => { entities=entities.filter(item=>item.name!=='20190101');highlighter.render(); });
  assert.deepEqual(await page.locator('.studio-description-entity').allTextContents(), ['#有序图库', '#20210706', '#手动新话题'], 'removing one zero-ID name must retain other zero-ID names');
  assert.equal(await page.evaluate(() => inputEvents), 0, 'zero-ID highlighting must not rewrite input or dispatch edits');

  // 完整 Unicode 字符与词边界：补充平面汉字、组合音标、家庭 emoji、国旗均不可被截断。
  await page.evaluate(() => {
    entities=[{kind:'topic',id:'1',name:'摄影'},{kind:'topic',id:'2',name:'A'},{kind:'topic',id:'3',name:'Á'},{kind:'topic',id:'4',name:'👨‍👩‍👧'},{kind:'topic',id:'5',name:'🇨'},{kind:'topic',id:'6',name:'🌊'}];
    input.value='𠀀#摄影 #摄影𠀀 #Á #👨‍👩‍👧‍👦 #🇨🇳 #🌊 👨‍👩‍👧‍👦#摄影';highlighter.render();
  });
  assert.deepEqual(await page.locator('.studio-description-entity').allTextContents(), ['#Á', '#🌊', '#摄影']);
  assert.equal(await page.locator('.studio-description-entity').first().getAttribute('data-entity-id'), '3');
  await page.locator('#description').fill('#摄影');
  await page.waitForFunction(() => document.querySelectorAll('.studio-description-entity').length === 1);
  assert.equal(await page.locator('#description').inputValue(), '#摄影');
  assert.equal(await page.locator('#count').textContent(), '3 / 1000');
  assert.equal(await page.evaluate(() => inputEvents), 1);
  await page.evaluate(() => { entities=[];highlighter.render(); });
  assert.equal(await page.locator('.studio-description-entity').count(), 0, 'unselected plain token must not stay highlighted');

  // 窄屏折行与多行滚动使用同一实际字体/宽度，镜像不得改变输入框滚动和选区。
  await page.evaluate(() => { entities=[{kind:'topic',id:'1',name:'摄影'},{kind:'mention',id:'2',name:'小明'}];input.value=Array.from({length:25},(_,index)=>'第'+index+'行 旅行里的光影与人物 #摄影 和 @小明。').join('\n')+'\n';input.style.height='110px';highlighter.render(); });
  await page.setViewportSize({width: 820, height: 400});
  await page.setViewportSize({width: 560, height: 400});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'resize must not expose stale mirror width before ResizeObserver runs');
  await page.setViewportSize({width: 310, height: 400});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'immediate narrow resize cannot create horizontal page overflow');
  await page.waitForFunction(() => document.querySelector('.studio-description-highlight-content').getBoundingClientRect().width === input.clientWidth);
  await page.evaluate(() => { input.focus(); input.setSelectionRange(8,11);input.scrollTop=input.scrollHeight-input.clientHeight;input.dispatchEvent(new Event('scroll')); });
  const metrics = await page.evaluate(() => {
    const mirror=document.querySelector('.studio-description-highlight-content'),viewport=document.querySelector('.studio-description-highlight-viewport');
    return {nativeHeight:input.scrollHeight,mirrorHeight:mirror.scrollHeight,nativeWidth:input.clientWidth,mirrorWidth:mirror.getBoundingClientRect().width,viewWidth:viewport.getBoundingClientRect().width,transform:mirror.style.transform,scroll:input.scrollTop,start:input.selectionStart,end:input.selectionEnd,font:getComputedStyle(input).font,mirrorFont:getComputedStyle(mirror).font};
  });
  assert.equal(metrics.nativeWidth, metrics.mirrorWidth);
  assert.equal(metrics.nativeWidth, metrics.viewWidth);
  assert.ok(Math.abs(metrics.nativeHeight-metrics.mirrorHeight) <= 1, 'native and mirror wrap to the same total height: '+JSON.stringify(metrics));
  assert.equal(metrics.transform, `translate(0px, ${-metrics.scroll}px)`);
  assert.deepEqual([metrics.start,metrics.end],[8,11]);
  assert.equal(metrics.font,metrics.mirrorFont);
  await page.screenshot({path: output + 'studio-description-narrow-scroll.png'});
  await page.evaluate(() => { input.style.fontSize='17px';input.style.lineHeight='26px'; });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.studio-description-highlight-content')).fontSize === '17px');
  assert.ok(await page.evaluate(() => Math.abs(input.scrollHeight-document.querySelector('.studio-description-highlight-content').scrollHeight) <= 1));
  await page.evaluate(() => { input.wrap='off';input.value='非常长的单行文字'.repeat(40)+' #摄影';highlighter.render();input.scrollLeft=350;input.dispatchEvent(new Event('scroll')); });
  assert.match(await page.locator('.studio-description-highlight-content').getAttribute('style'), /translate\(-350px,/);
  const priorDispose = await page.evaluate(() => ({value:input.value,start:input.selectionStart,end:input.selectionEnd,left:input.scrollLeft,top:input.scrollTop,events:inputEvents}));
  await page.evaluate(() => { highlighter.dispose();highlighter.dispose(); });
  assert.deepEqual(await page.evaluate(() => ({value:input.value,start:input.selectionStart,end:input.selectionEnd,left:input.scrollLeft,top:input.scrollTop,events:inputEvents})),priorDispose);
  assert.equal(await page.locator('.studio-description-highlight').count(),0);
  assert.equal(await page.locator('#description').evaluate(input=>document.activeElement===input),true);
  assert.deepEqual(errors,[]);
  console.log('description UI passed: exact selected entities, distinct zero-ID names, light-blue marks, Unicode/grapheme boundaries, unchanged text/selection/focus, native accessibility, narrow wrapping, scroll and font sync, disposal');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
