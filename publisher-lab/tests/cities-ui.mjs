import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

// 使用生产城市控件和完整本地城市表，覆盖键盘、视口定位与失败恢复，不查询平台地点。
const root = fileURLToPath(new URL('../app/', import.meta.url));
const output = fileURLToPath(new URL('../output/playwright/', import.meta.url));
await mkdir(output, {recursive: true});
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/studio.css"><link rel="stylesheet" href="/studio-cities.css"><style>body{min-height:1600px}#anchor{position:absolute;left:260px;top:120px;overflow:hidden;width:180px}#location-city{width:180px;background:#f5f5f7;border:0;color:#777983;font-size:12px}#outside{position:fixed;left:10px;top:10px}</style><button id="outside">其他字段</button><div id="anchor"><button id="location-city" type="button" aria-label="选择城市">选择城市</button><div id="city-popover" hidden></div></div><script type="module">
import {mountCityPicker} from '/studio-cities.js';
window.changes=[];window.opens=0;
window.picker=mountCityPicker({button:document.querySelector('#location-city'),popover:document.querySelector('#city-popover'),onSelect:city=>changes.push(city),onOpen:()=>{opens++;}});
picker.render('310100');window.ready=true;
</script></html>`;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
  const file = resolve(root, '.' + url.pathname);
  if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
  try { response.setHeader('Content-Type', ({'.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json'})[extname(file)] || 'application/octet-stream'); response.end(await readFile(file)); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
try {
  const page = await browser.newPage({viewport: {width: 800, height: 800}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.waitForFunction(() => window.ready && document.querySelector('#location-city').textContent === '上海市');
  assert.equal(await page.locator('#location-city').evaluate(button => button.tagName), 'BUTTON', 'city field must never use native select');
  assert.deepEqual(await page.evaluate(() => changes), []);
  await page.locator('#location-city').click();
  assert.equal(await page.evaluate(() => opens), 1);
  assert.equal(await page.locator('#city-popover').evaluate(popover => popover.parentNode === document.body), true, 'popover escapes clipping card');
  assert.equal(await page.locator('#city-popover').getAttribute('data-direction'), 'down');
  const initial = await page.locator('#city-popover').boundingBox();
  assert.ok(initial.height <= 280 && initial.width >= 200 && initial.width <= 240);
  assert.ok((await page.locator('.studio-city-list').boundingBox()).height <= 220);
  const selected = page.locator('.studio-city-option[aria-selected=true]');
  assert.equal(await selected.textContent(), '上海市');
  const selectedBounds = await selected.boundingBox(), listBounds = await page.locator('.studio-city-list').boundingBox();
  assert.ok(selectedBounds.y >= listBounds.y - 1 && selectedBounds.y + selectedBounds.height <= listBounds.y + listBounds.height + 1, 'saved city is visible within internal scroller');
  await page.locator('.studio-city-search').fill('深圳');
  assert.equal(await page.locator('.studio-city-option').count(), 1);
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => changes), [{code: '440300', name: '深圳市'}]);
  assert.equal(await page.locator('#location-city').textContent(), '深圳市');
  assert.equal(await page.locator('#city-popover').isHidden(), true);
  assert.equal(await page.locator('#location-city').evaluate(button => document.activeElement === button), true);
  // 下拉键盘导航保持组合框焦点，Enter 只选择当前高亮项。
  await page.keyboard.press('ArrowDown');
  await page.locator('.studio-city-search').fill('北京');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  assert.equal(await page.locator('.studio-city-search').evaluate(input => document.activeElement === input), true);
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#location-city').textContent(), '北京市');
  assert.equal(await page.evaluate(() => changes.length), 2);
  await page.evaluate(() => picker.render('310100'));
  assert.equal(await page.locator('#location-city').textContent(), '上海市');
  assert.equal(await page.evaluate(() => changes.length), 2, 'render must not invoke onSelect');
  await page.locator('#location-city').click();
  await page.locator('.studio-city-search').fill('不存在的城市');
  assert.equal(await page.locator('.studio-city-option').count(), 0);
  assert.equal(await page.locator('.studio-city-message').textContent(), '没有找到匹配城市');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => changes.length), 2);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#city-popover').isHidden(), true);
  await page.evaluate(() => { document.querySelector('#anchor').style.top = '744px'; });
  await page.locator('#location-city').click();
  assert.equal(await page.locator('#city-popover').getAttribute('data-direction'), 'up');
  const upward = await page.locator('#city-popover').boundingBox();
  assert.ok(upward.y >= 8 && upward.y + upward.height < 744);
  await page.screenshot({path: output + 'studio-cities-upward.png'});
  await page.evaluate(() => scrollTo(0, 250));
  await page.waitForFunction(previous => document.querySelector('#city-popover').getBoundingClientRect().top !== previous, upward.y);
  const afterScroll = await page.locator('#city-popover').boundingBox();
  assert.notEqual(afterScroll.y, upward.y, 'open popup follows page scrolling');
  await page.locator('#outside').click();
  assert.equal(await page.locator('#city-popover').isHidden(), true);
  await page.setViewportSize({width: 220, height: 160});
  await page.evaluate(() => { scrollTo(0, 0); const anchor = document.querySelector('#anchor'); anchor.style.top = '90px'; anchor.style.left = '32px'; });
  await page.locator('#location-city').click();
  const narrow = await page.locator('#city-popover').boundingBox();
  assert.ok(narrow.x >= 8 && narrow.x + narrow.width <= 212.5 && narrow.y >= 8 && narrow.y + narrow.height <= 152.5, 'tiny viewport constrains all popup edges');
  await page.screenshot({path: output + 'studio-cities-narrow.png'});
  await page.evaluate(() => { picker.dispose(); picker.dispose(); });
  assert.equal(await page.locator('#city-popover').isHidden(), true);
  assert.equal(await page.locator('#city-popover').evaluate(popover => popover.parentNode.id), 'anchor');
  await page.locator('#location-city').click();
  assert.equal(await page.locator('#city-popover').isHidden(), true, 'disposed picker removes button listeners');

  // 首次静态表读取失败时保留字段和重试，不展开原生长列表或发送平台请求。
  const recovery = await browser.newPage({viewport: {width: 800, height: 800}});
  let attempts = 0;
  await recovery.route('**/cities.json', async route => {
    attempts++;
    if (attempts === 1) await route.fulfill({status: 503, body: 'fixture unavailable'});
    else await route.fulfill({status: 200, contentType: 'application/json', body: await readFile(resolve(root, 'cities.json'))});
  });
  await recovery.goto(origin);
  await recovery.waitForFunction(() => window.ready);
  await recovery.locator('#location-city').click();
  await recovery.locator('.studio-city-message').filter({hasText: '城市列表读取失败'}).waitFor();
  await recovery.keyboard.press('Tab');
  assert.equal(await recovery.getByRole('button', {name: '重新读取', exact: true}).evaluate(button => document.activeElement === button), true);
  await recovery.keyboard.press('Enter');
  await recovery.locator('.studio-city-option').filter({hasText: '上海市'}).waitFor();
  assert.equal(attempts, 2);
  assert.equal(await recovery.locator('#location-city').textContent(), '上海市');
  assert.deepEqual(await recovery.evaluate(() => changes), []);
  await recovery.close();
  assert.deepEqual(errors, []);
  console.log('cities UI passed: real local table, button/combobox, search/keyboard, saved city, clipped parent, bounded up/down placement, scroll, tiny viewport, retry and disposal');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
