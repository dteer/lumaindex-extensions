import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

// 合成设置页只加载本地样式与帮助模块，不连接宿主、账号或平台。
const root = fileURLToPath(new URL('../app/', import.meta.url));
const output = fileURLToPath(new URL('../output/playwright/', import.meta.url));
const explanation = '允许：其他用户可以下载保存作品。\n不允许：关闭平台提供的下载保存入口。';
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/studio.css"><link rel="stylesheet" href="/studio-resources.css"><link rel="stylesheet" href="/studio-help.css">
<style>main { width: min(900px, calc(100% - 48px)); margin: 64px auto; } .settings-panel { padding: 28px; background: #fff; border: 1px solid #e9e9ed; border-radius: 8px; } h1 { margin: 0 0 28px; font-size: 20px; } .fixture-spacer { height: 1000px; } @media(max-width:600px) { main { margin: 36px auto; } .settings-panel { padding: 20px; } .settings-panel .radio-options { grid-template-columns: repeat(2,minmax(0,1fr)); } }</style>
<main><section class="settings-panel"><h1>发布设置</h1><form><div class="settings-grid">
<div class="setting-row"><span class="setting-label">谁可以看</span><div class="radio-options"><label><input type="radio" name="visibility" checked>公开</label><label><input type="radio" name="visibility">仅自己可见</label></div></div>
<div class="setting-row"><span class="setting-label" id="download-label">保存权限 <span id="save-help" class="setting-help" title="允许其他用户保存作品" aria-label="保存权限说明">?</span></span><div class="radio-options"><label><input type="radio" name="download" value="allow" checked>允许</label><label><input type="radio" name="download" value="deny">不允许</label></div></div>
<div class="setting-row"><span class="setting-label">发布时间</span><div class="radio-options"><label><input type="radio" name="publish-time" checked>立即发布</label><label><input type="radio" name="publish-time">定时发布</label></div></div>
</div></form></section><div class="fixture-spacer"></div></main>
<script type="module">import {mountSettingHelp} from '/studio-help.js';
window.mutations = 0; document.querySelector('form').addEventListener('change', () => window.mutations++); document.querySelector('form').addEventListener('submit', event => { event.preventDefault(); window.mutations++; });
window.mountHelp = () => window.help = mountSettingHelp(document.querySelector('#save-help'), {text: ${JSON.stringify(explanation)}, id: 'save-help-description'});
</script></html>`;
await mkdir(output, {recursive: true});
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
  const file = resolve(root, '.' + url.pathname);
  if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
  try { response.setHeader('Content-Type', ({'.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json'})[extname(file)] || 'application/octet-stream'); response.end(await readFile(file)); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
try {
  const context = await browser.newContext({viewport: {width: 1280, height: 820}, hasTouch: true});
  const page = await context.newPage(), errors = [], unexpectedRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => { if (route.request().url().startsWith(origin + '/')) return route.continue(); unexpectedRequests.push(route.request().url()); return route.abort(); });
  await page.goto(origin);
  await page.waitForFunction(() => typeof window.mountHelp === 'function');
  // 保存所有设置行的几何位置，按钮替换和浮层出现都不能推动字段。
  const layout = () => page.locator('.setting-row').evaluateAll(nodes => nodes.map(node => { const {x, y, width, height} = node.getBoundingClientRect(); return {x, y, width, height}; }));
  const originalLayout = await layout();
  await page.evaluate(() => window.mountHelp());
  const button = page.getByRole('button', {name: '保存权限说明'}), tip = page.locator('#save-help-description');
  assert.deepEqual(await layout(), originalLayout, 'replacing span with semantic button must preserve layout');
  assert.equal(await button.getAttribute('type'), 'button');
  assert.equal(await button.getAttribute('title'), null);
  assert.equal(await button.getAttribute('aria-describedby'), 'save-help-description');
  assert.equal(await tip.getAttribute('role'), 'tooltip');
  assert.equal(await tip.textContent(), explanation);
  assert.equal(await button.evaluate(node => node.offsetWidth), 13);
  assert.equal(await button.evaluate(node => node.offsetHeight), 13);
  const hidden = async message => assert.equal(await tip.isVisible(), false, message);
  const visible = async message => assert.equal(await tip.isVisible(), true, message);
  // 真正的鼠标按下/松开；悬停和松开后的悬停都不显示。
  await button.hover(); await hidden('hover alone must not show help');
  await page.mouse.down(); await visible('pointerdown must show help immediately');
  assert.deepEqual(await layout(), originalLayout, 'fixed help must not shift settings');
  await page.screenshot({path: resolve(output, 'settings-help-1280.png')});
  await page.mouse.up(); await hidden('release over button must close help');
  await button.hover(); await hidden('remaining hovered after release must stay closed');
  await page.mouse.down(); await page.mouse.move(1100, 500); await visible('moving outside while held must retain help');
  await page.mouse.up(); await hidden('release outside button must close help');
  await button.focus();
  for (const key of ['Space', 'Enter']) {
    await page.keyboard.down(key); await visible(key + ' down must show help');
    await page.keyboard.up(key); await hidden(key + ' up must close help');
  }
  await page.keyboard.down('Space'); await page.keyboard.press('Escape'); await hidden('Escape must close help'); await page.keyboard.up('Space');
  await page.keyboard.down('Enter'); await page.locator('input[name=download][value=allow]').focus(); await hidden('focus leaving button must close help'); await page.keyboard.up('Enter');
  // 真实触摸指针覆盖正常结束与系统取消，不能只依赖 click 或 mouseup。
  const session = await context.newCDPSession(page);
  const center = async () => { const box = await button.boundingBox(); return {x: box.x + box.width / 2, y: box.y + box.height / 2}; };
  for (const ending of ['touchEnd', 'touchCancel']) {
    await session.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{...await center(), id: 7}]});
    await visible('touch must show help');
    await session.send('Input.dispatchTouchEvent', {type: ending, touchPoints: []});
    await hidden(ending + ' must close help');
  }
  await button.hover(); await page.mouse.down(); await page.mouse.wheel(0, 180);
  await page.waitForFunction(() => window.scrollY > 0); await hidden('actual scrolling must close help'); await page.mouse.up();
  await page.evaluate(() => window.scrollTo(0, 0));
  await button.hover(); await page.mouse.down(); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await hidden('window blur must close help'); await page.mouse.up();
  await button.hover(); await page.mouse.down(); await page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await hidden('page leave must close help'); await page.mouse.up();

  await page.setViewportSize({width: 560, height: 820});
  const narrowLayout = await layout();
  await button.hover(); await page.mouse.down(); await visible('narrow view must show help');
  const bounds = await tip.boundingBox();
  assert.ok(bounds.x >= 12 && bounds.x + bounds.width <= 548 && bounds.y >= 12 && bounds.y + bounds.height <= 808, 'tooltip must fit narrow viewport');
  const helpBox = await button.boundingBox(), labelBox = await page.locator('#download-label').boundingBox(), optionsBox = await page.locator('#download-label + .radio-options').boundingBox();
  assert.ok(helpBox.y >= labelBox.y && helpBox.y + helpBox.height <= labelBox.y + 36 && helpBox.x + helpBox.width < optionsBox.x,
    'narrow help must stay alongside the label without overlapping the radio options');
  assert.deepEqual(await layout(), narrowLayout, 'narrow help must not shift settings');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'help must not introduce horizontal overflow');
  await page.screenshot({path: resolve(output, 'settings-help-560.png')});
  await page.mouse.up(); await hidden('narrow view release must close help');
  // 同一按钮可由集成方卸载；其后没有残留浮层或文档级监听行为。
  await page.evaluate(() => window.help.destroy());
  assert.equal(await tip.count(), 0);
  assert.equal(await button.getAttribute('aria-describedby'), null);
  await button.hover(); await page.mouse.down(); await page.mouse.up();
  assert.equal(await page.locator('[role=tooltip]').count(), 0);
  assert.equal(await page.evaluate(() => window.mutations), 0, 'help must not submit a form or mutate settings');
  assert.equal(await page.locator('input[name=download][value=allow]').isChecked(), true);

  // 真实入口只使用隔离浏览器的合成文字草稿，进入设置区且无需任何图库或账号请求。
  await page.evaluate(() => localStorage.setItem('luma.douyin.studio.frontend:file-preview', JSON.stringify({version: 2, activeDraftId: 'help-fixture', drafts: [
    {id: 'help-fixture', name: '帮助测试', kind: 'image', title: '合成设置说明测试', description: '', assets: [], topics: [], mentions: [], settings: {visibility: 'public', download: 'allow', publishTime: 'now', scheduledAt: '', declarations: []}},
  ]})));
  await page.goto(origin + '/index.html');
  const integrated = page.locator('#download-label button.setting-help'), integratedTip = page.locator('#download-help-description');
  await integrated.waitFor();
  await page.waitForFunction(() => document.querySelectorAll('#download input[type=radio]').length === 2);
  const settings = () => page.locator('#download input').evaluateAll(nodes => nodes.map(node => ({value: node.value, checked: node.checked, disabled: node.disabled})));
  const savedSettings = await settings(), savedDrafts = await page.evaluate(() => JSON.stringify({...localStorage}));
  await integrated.hover(); await page.mouse.down();
  assert.equal(await integratedTip.isVisible(), true, 'real entry must load and mount help');
  assert.equal(await integratedTip.textContent(), explanation);
  const actualHelp = await integrated.boundingBox(), actualOptions = await page.locator('#download').boundingBox();
  assert.ok(actualHelp.x + actualHelp.width < actualOptions.x, 'real narrow layout must keep help separate from radio options');
  await page.mouse.up();
  assert.equal(await integratedTip.isVisible(), false, 'real entry must hide help after release');
  assert.deepEqual(await settings(), savedSettings, 'help must preserve real save-permission radio state');
  assert.equal(await page.evaluate(() => JSON.stringify({...localStorage})), savedDrafts, 'help must not save or alter the real page synthetic draft');
  assert.deepEqual(errors, []); assert.deepEqual(unexpectedRequests, []);
  console.log('settings-help-ui: held pointer, outside release, touch cancellation, keyboard, blur, scroll, page leave, accessibility and fixed layout passed');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
