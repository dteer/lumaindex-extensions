import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

// 使用真实发布页和客户端；账号档案、宿主及草稿均为本测试合成，不连接真实网站。
const root = fileURLToPath(new URL('../app/', import.meta.url));
const output = fileURLToPath(new URL('../output/playwright/', import.meta.url));
await mkdir(output, {recursive: true});
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
  try { response.setHeader('Content-Type', ({'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json'})[extname(file)] || 'application/octet-stream'); response.end(await readFile(file)); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 900}}), errors = [], unexpectedRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => { if (route.request().url().startsWith(origin + '/')) return route.continue(); unexpectedRequests.push(route.request().url()); return route.abort(); });
  await page.addInitScript(() => {
    const profiles = [
      {id: 'account-a', accountId: '80001001', name: '合成旅行摄影', browserSessionAvailable: true, hasCookies: true},
      {id: 'account-b', accountId: '80001002', name: '合成旅行摄影', browserSessionAvailable: true, hasCookies: true},
      {id: 'account-c', accountId: '80001003', name: '合成长名称摄影工作室：旅行、人像与城市日常作品记录', browserSessionAvailable: false, hasCookies: false},
    ];
    const state = {version: 2, activeDraftId: 'account-fixture', drafts: [{id: 'account-fixture', name: '合成账号界面草稿', kind: 'image', assets: [], title: '账号选择验证', description: '仅用于本机合成测试', topics: [], mentions: [], settings: {visibility: 'public', download: 'allow', publishTime: 'now', scheduledAt: '', declarations: []}}]};
    let active = profiles[0]; const storage = {};
    window.__accountUI = {messages: [], state, holdSelect: false, finishSelect: null};
    window.pluginContext = {nativeUIAvailable: true, nativeCapabilities: {browserRequestsVersion: 1, persistentWebsiteSessionsVersion: 1, sessionLoginOptionsVersion: 1, networkHeadersVersion: 1, sessionVersion: 1, sessionProfilesVersion: 1}, libraryID: 'account-picker-fixture', frontendState: state};
    const status = () => ({activeProfileId: active.id, accountId: active.accountId, name: active.name, browserSessionAvailable: active.browserSessionAvailable, hasCookies: active.hasCookies});
    window.webkit = {messageHandlers: {pluginUI: {postMessage: async message => {
      window.__accountUI.messages.push(structuredClone(message));
      if (message.op === 'persist') { window.__accountUI.state = structuredClone(message.value); return {ok: true}; }
      if (message.op === 'session.list') return {ok: true, data: {items: profiles, activeProfileId: active.id, hasMore: false, nextOffset: null}};
      if (message.op === 'session.status') return {ok: true, data: status()};
      if (message.op === 'session.select') {
        const finish = () => { active = profiles.find(item => item.id === message.profileId); if (!active) throw Error('Unknown synthetic profile'); return {ok: true, data: status()}; };
        if (window.__accountUI.holdSelect) return new Promise(resolve => { window.__accountUI.finishSelect = () => { window.__accountUI.holdSelect = false; resolve(finish()); }; });
        return finish();
      }
      if (message.op === 'state.get') return {ok: true, data: message.keys ? {[message.keys]: storage[message.keys]} : storage};
      if (message.op === 'state.set') { Object.assign(storage, message.values); return {ok: true, data: {saved: true}}; }
      throw Error('Unexpected account picker operation: ' + message.op);
    }}}};
  });
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector('#account-select')?.value === 'account-a' && !document.querySelector('#account-select-button')?.disabled);
  const menu = page.locator('#account-menu'), trigger = page.locator('#account-select-button'), list = page.locator('#account-select-listbox');
  const option = value => list.locator(`[role=option][data-value="${value}"]`);
  const selectCount = () => page.evaluate(() => window.__accountUI.messages.filter(item => item.op === 'session.select').length);
  const current = () => page.locator('#account-select').inputValue();
  const draft = await page.evaluate(() => structuredClone(window.__accountUI.state));
  // 外层菜单与内部 listbox 各有独立展开状态。
  async function openMenu() { if (!await menu.evaluate(node => node.open)) await menu.locator('summary').click(); }
  async function openPicker() { await openMenu(); if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click(); }
  async function activeValue() { return page.evaluate(() => document.getElementById(document.querySelector('#account-select-button').getAttribute('aria-activedescendant'))?.dataset.value); }
  // 截图与几何断言都针对真实菜单，长名称也不得把列表撑出账号框或视口。
  async function inspect(width) {
    await page.setViewportSize({width, height: 900}); await openPicker();
    const button = await trigger.boundingBox(), bounds = await list.boundingBox();
    assert.ok(Math.abs(button.x - bounds.x) < 1 && Math.abs(button.width - bounds.width) < 1, 'list must align to and match the account control width');
    assert.ok(bounds.y >= button.y + button.height && bounds.y <= button.y + button.height + 8, 'list must sit immediately below the control');
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'list must stay inside narrow viewport');
    assert.equal(await list.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)', 'list uses page white background instead of a system gray popup');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await option('account-c').locator('.account-selector-name').evaluate(node => getComputedStyle(node).textOverflow), 'ellipsis');
    assert.equal(await list.locator('[aria-selected=true]').count(), 1);
    assert.equal(await option('account-a').getAttribute('aria-selected'), 'true');
    assert.equal(await option('account-a').locator('.account-selector-check').evaluate(node => getComputedStyle(node).visibility), 'visible');
    await page.screenshot({path: resolve(output, `account-picker-${width}.png`)});
  }
  assert.equal(await page.locator('#account-select').isHidden(), true);
  await openMenu();
  assert.equal(await page.getByRole('combobox', {name: '切换抖音账号'}).count(), 1, 'only the visible control is exposed to accessibility');
  await inspect(1280); await inspect(560);
  assert.equal(await selectCount(), 0, 'opening or resizing account choices must not switch an account');
  assert.match(await option('account-a').textContent(), /1001/); assert.match(await option('account-b').textContent(), /1002/);
  assert.match(await option('account-c').textContent(), /需重新登录/);
  await option('account-b').hover();
  assert.equal(await option('account-b').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(234, 244, 255)');
  assert.equal(await activeValue(), 'account-b');
  assert.equal(await option('account-a').getAttribute('aria-selected'), 'true', 'hover-active option must not become the selected account');
  await trigger.focus(); await page.keyboard.press('Home'); assert.equal(await activeValue(), 'account-a');
  await page.keyboard.press('End'); assert.equal(await activeValue(), 'account-c');
  assert.equal(await current(), 'account-a'); assert.equal(await selectCount(), 0);
  await page.keyboard.press('Escape');
  assert.equal(await list.isHidden(), true); assert.equal(await menu.evaluate(node => node.open), true, 'first Escape closes only the inner choices');
  assert.equal(await trigger.evaluate(node => document.activeElement === node), true);
  await page.keyboard.press('Escape'); assert.equal(await menu.evaluate(node => node.open), false);
  await openPicker(); await page.locator('#title').click();
  assert.equal(await list.isHidden(), true); assert.equal(await menu.evaluate(node => node.open), false, 'outside pointer closes both account layers');
  await openPicker(); await page.keyboard.press('Tab'); assert.equal(await list.isHidden(), true, 'Tab leaves and closes inner choices');

  await openPicker(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowDown');
  assert.equal(await activeValue(), 'account-b'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#account-select').value === 'account-b' && !document.querySelector('#account-select-button').disabled && !document.querySelector('#account-menu').open);
  assert.equal(await selectCount(), 1, 'one keyboard confirmation must dispatch one account switch');
  assert.match(await trigger.textContent(), /1002/);
  // 延迟宿主切换时，可见控件和模型同时禁用，不能因重复点击或键盘确认重发。
  await openPicker(); await page.evaluate(() => { window.__accountUI.holdSelect = true; }); await option('account-a').click();
  await page.waitForFunction(() => typeof window.__accountUI.finishSelect === 'function');
  assert.equal(await trigger.isDisabled(), true); assert.equal(await page.locator('#account-select').isDisabled(), true); assert.equal(await list.isHidden(), true);
  await trigger.evaluate(node => node.click()); await page.keyboard.press('Enter');
  assert.equal(await selectCount(), 2);
  await page.evaluate(() => window.__accountUI.finishSelect());
  await page.waitForFunction(() => document.querySelector('#account-select').value === 'account-a' && !document.querySelector('#account-select-button').disabled && !document.querySelector('#account-menu').open);
  await openPicker(); await option('account-a').click();
  assert.equal(await list.isHidden(), true); assert.equal(await selectCount(), 2, 'confirming the already selected account must not dispatch change');
  assert.equal(await page.evaluate(() => window.__accountUI.messages.some(item => ['session.login', 'session.identify', 'browser.request'].includes(item.op))), false, 'selection never opens login or performs a platform identity request');
  assert.deepEqual(await page.evaluate(() => window.__accountUI.state), draft, 'account selector must not alter the synthetic draft');
  assert.deepEqual(errors, []); assert.deepEqual(unexpectedRequests, []);
  console.log('account-picker-ui: aligned white list, narrow/long names, distinct active/selected, keyboard, outside/Escape/Tab, busy and exactly-once local account switching passed');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
