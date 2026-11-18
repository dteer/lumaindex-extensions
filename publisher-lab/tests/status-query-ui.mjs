import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {createPublicationStore} from '../app/platform/publication-store.js';

// 真实页面、client、engine 与本机发布存储；仅原生桥返回合成平台回执，不上传或发布。
const root = fileURLToPath(new URL('../app/', import.meta.url));
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
  try {
    response.setHeader('Content-Type', ({'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json'})[extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
try {
  // 通过生产纯本地存储 API 建立已存在的提交记录，测试中不会调用发布执行入口。
  const runtime = {};
  const storage = {get: async key => structuredClone({[key]: runtime[key]}), set: async values => Object.assign(runtime, structuredClone(values))};
  let sequence = 0;
  const records = createPublicationStore({storage, uuid: () => 'status-preparation-' + ++sequence});
  for (const [name, publicationId] of [['a', '71001'], ['b', '71002']]) {
    const prepared = await records.prepare({origin, account: {id: '123', name: '合成状态查询账号'}, draft: {title: '合成草稿 ' + name}, payload: {}, summary: {kind: 'image', count: 0}});
    await records.beginSubmit({preparationId: prepared.preparationId, requestId: 'status-request-' + name, origin, expectedAccountId: '123', confirmed: true});
    await records.finish(prepared.preparationId, {status: 'processing', publicationId, message: '合成本地提交记录'});
  }

  const page = await browser.newPage({viewport: {width: 1280, height: 950}}), errors = [], externalRequests = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    externalRequests.push(route.request().url()); return route.abort();
  });
  await page.addInitScript(({origin, runtime}) => {
    const receipt = (name, publicationId) => ({requestId: 'status-request-' + name, publicationId, status: 'unknown', message: '原回执 ' + name, updatedAt: '2026-11-18T00:00:00Z'});
    const draft = (name, publicationId) => ({id: 'draft-' + name, name: '状态草稿 ' + name.toUpperCase(), kind: 'image', title: '标题 ' + name, description: '正文 ' + name,
      assets: [], topics: [], mentions: [], activities: [], settings: {visibility: 'public', download: 'allow', publishTime: 'now', declarations: []}, receipt: receipt(name, publicationId)});
    const initial = {version: 2, activeDraftId: 'draft-a', drafts: [draft('a', '71001'), draft('b', '71002')]};
    const profile = {id: 'status-profile', accountId: '123', name: '合成状态查询账号', browserSessionAvailable: true, hasCookies: true};
    const fixture = window.__statusUI = {state: structuredClone(initial), runtime, messages: [], requests: [], pending: [], released: [], closed: 0};
    window.pluginContext = {nativeUIAvailable: true, nativeCapabilities: {browserRequestsVersion: 1, persistentWebsiteSessionsVersion: 1, sessionLoginOptionsVersion: 1,
      networkHeadersVersion: 1, sessionVersion: 1, sessionProfilesVersion: 1, temporaryFilesVersion: 1}, apiBaseURL: origin + '/api/v1', frontendState: initial, libraryID: 'status-ui-fixture'};
    const status = () => ({activeProfileId: profile.id, accountId: profile.accountId, name: profile.name, browserSessionAvailable: true, hasCookies: true});
    fixture.release = (requestId, fail = false) => {
      const index = fixture.pending.findIndex(item => item.requestId === requestId);
      if (index < 0) throw Error('Missing synthetic status request');
      const [request] = fixture.pending.splice(index, 1);
      request.resolve(fail ? {ok: false, error: {code: 'BROWSER_NETWORK_ERROR', message: '合成状态查询失败，原回执保留。'}}
        : {ok: true, data: {status: 200, headers: {'content-type': 'application/json'}, body: JSON.stringify({status_code: 0, aweme: {aweme_id: request.publicationId}})}});
    };
    window.webkit = {messageHandlers: {pluginUI: {postMessage: async message => {
      fixture.messages.push(structuredClone(message));
      if (message.op === 'persist') { fixture.state = structuredClone(message.value); return {ok: true}; }
      if (message.op === 'close') { fixture.closed++; return {ok: true}; }
      if (message.op === 'session.list') return {ok: true, data: {items: [profile], activeProfileId: profile.id, hasMore: false, nextOffset: null}};
      if (['session.status', 'session.select', 'session.identify'].includes(message.op)) return {ok: true, data: status()};
      if (message.op === 'session.cancel') return {ok: true, data: {cancelled: true}};
      if (message.op === 'state.get') return {ok: true, data: message.keys ? {[message.keys]: fixture.runtime[message.keys]} : fixture.runtime};
      if (message.op === 'state.set') { Object.assign(fixture.runtime, structuredClone(message.values)); return {ok: true, data: {saved: true}}; }
      if (message.op !== 'browser.request') throw Error('Unexpected host operation: ' + message.op);
      const url = new URL(message.url);
      fixture.requests.push({path: url.pathname, method: message.method, requestId: message.requestId});
      if (message.method === 'GET' && url.pathname === '/web/api/media/activity/get/') return {ok: true, data: {status: 200, headers: {'content-type': 'application/json'}, body: JSON.stringify({status_code: 0, activity_list: []})}};
      if (message.method !== 'GET' || url.pathname !== '/web/api/media/item/info/') throw Error('Status regression must only query existing publication records');
      const result = await new Promise(resolve => fixture.pending.push({requestId: message.requestId, publicationId: url.searchParams.get('item_id'), resolve}));
      fixture.released.push(message.requestId);
      return result;
    }}}};
  }, {origin, runtime});
  await page.goto(origin);
  await page.waitForFunction(() => document.body.dataset.phase === 'editing' && !document.querySelector('#status-shortcut').disabled);
  assert.equal(await page.evaluate(() => __statusUI.requests.some(item => /user\/info|item\/info/.test(item.path))), false, 'restoring local state cannot check accounts or receipts');

  // 慢查询只禁用发起草稿的查询按钮；正文、保存和草稿切换保持可操作。
  await page.locator('#status-shortcut').click();
  await page.waitForFunction(() => __statusUI.pending.length === 1);
  const firstRequest = await page.evaluate(() => __statusUI.pending[0].requestId);
  assert.equal(await page.locator('#status-shortcut').textContent(), '查询中…');
  assert.equal(await page.locator('#status-shortcut').isDisabled(), true);
  await page.locator('#status-shortcut').click({force: true});
  assert.equal(await page.evaluate(() => __statusUI.requests.filter(item => item.path === '/web/api/media/item/info/').length), 1);
  assert.equal(await page.evaluate(() => document.body.classList.contains('busy') || [...document.querySelectorAll('.editor-scroll > section, .draft-sidebar')].some(node => node.inert)), false);
  await page.locator('#description').fill('查询期间继续编辑 A');
  await page.locator('#save-draft').click();
  await page.waitForFunction(() => __statusUI.state.drafts.find(item => item.id === 'draft-a').description === '查询期间继续编辑 A');
  await page.locator('#open-drafts').click();
  await page.locator('.draft-item').filter({hasText: '状态草稿 B'}).click();
  await page.waitForFunction(() => __statusUI.state.activeDraftId === 'draft-b');
  await page.locator('#description').fill('正在编辑的 B 不接收 A 回执');
  await page.locator('#save-draft').click();
  await page.waitForFunction(() => __statusUI.state.drafts.find(item => item.id === 'draft-b').description === '正在编辑的 B 不接收 A 回执');
  const beforeB = await page.evaluate(() => structuredClone(__statusUI.state.drafts.find(item => item.id === 'draft-b')));
  assert.equal(await page.locator('#status-shortcut').isDisabled(), false, 'another draft has independent query state');
  await page.evaluate(id => __statusUI.release(id), firstRequest);
  await page.waitForFunction(() => __statusUI.state.drafts.find(item => item.id === 'draft-a').receipt.status === 'processing');
  assert.deepEqual(await page.evaluate(() => __statusUI.state.drafts.find(item => item.id === 'draft-b')), beforeB, 'late A receipt must not alter B or its timestamp');
  assert.equal(await page.locator('#description').inputValue(), beforeB.description);
  assert.equal(await page.locator('#receipt-message').textContent(), beforeB.receipt.message);
  assert.equal(await page.evaluate(() => __statusUI.state.drafts.find(item => item.id === 'draft-a').description), '查询期间继续编辑 A');
  assert.match(await page.evaluate(() => __statusUI.state.drafts.find(item => item.id === 'draft-a').receipt.message), /已查到作品记录/);

  // 失败保留原回执和等待期间的正文，允许用户随后再次查询。
  await page.locator('#status-shortcut').click();
  await page.waitForFunction(() => __statusUI.pending.length === 1);
  await page.locator('#description').fill('B 的查询失败也保留编辑');
  await page.evaluate(() => __statusUI.release(__statusUI.pending[0].requestId, true));
  await page.locator('#page-notice').filter({hasText: '合成状态查询失败'}).waitFor();
  await page.waitForFunction(() => !document.querySelector('#status-shortcut').disabled);
  await page.waitForFunction(() => __statusUI.state.drafts.find(item => item.id === 'draft-b').description === 'B 的查询失败也保留编辑');
  // 键盘关闭红色通知只隐藏本条提示，不修改任何草稿、回执、持久发布状态或防重按钮。
  const beforeDismiss = await page.evaluate(() => ({state: structuredClone(__statusUI.state), runtime: structuredClone(__statusUI.runtime),
    messages: __statusUI.messages.length, requests: __statusUI.requests.length, description: document.querySelector('#description').value}));
  const dismiss = page.getByRole('button', {name: '关闭提示', exact: true});
  assert.equal(await page.locator('#page-notice').getAttribute('role'), 'alert');
  await dismiss.focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#page-notice').isHidden(), true);
  assert.deepEqual(await page.evaluate(() => ({state: structuredClone(__statusUI.state), runtime: structuredClone(__statusUI.runtime),
    messages: __statusUI.messages.length, requests: __statusUI.requests.length, description: document.querySelector('#description').value})), beforeDismiss);
  assert.equal(await page.locator('#publish').isDisabled(), true, 'dismissing an error must not clear duplicate-publication protection');
  assert.equal(await page.locator('#receipt-message').textContent(), beforeB.receipt.message);

  // 后续一次真实查询错误仍重新显示；鼠标关闭同样只处理当前提示。
  await page.locator('#status-shortcut').click();
  await page.waitForFunction(() => __statusUI.pending.length === 1);
  await page.evaluate(() => __statusUI.release(__statusUI.pending[0].requestId, true));
  await page.locator('#page-notice').filter({hasText: '合成状态查询失败'}).waitFor();
  await dismiss.click();
  assert.equal(await page.locator('#page-notice').isHidden(), true);
  assert.deepEqual(await page.evaluate(() => __statusUI.state.drafts.find(item => item.id === 'draft-b').receipt), beforeB.receipt);
  await page.locator('#save-draft').click();
  await page.waitForFunction(() => __statusUI.state.drafts.find(item => item.id === 'draft-b').description === 'B 的查询失败也保留编辑');
  assert.deepEqual(await page.evaluate(() => __statusUI.state.drafts.find(item => item.id === 'draft-b').receipt), beforeB.receipt);

  // 宿主关闭事件是生产关闭入口：先保存编辑并取消读取，迟到的桥回执不更新草稿。
  await page.locator('#status-shortcut').click();
  await page.waitForFunction(() => __statusUI.pending.length === 1);
  const closingRequest = await page.evaluate(() => __statusUI.pending[0].requestId);
  await page.locator('#description').fill('关闭前最后编辑的 B');
  assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event('luma:close-request', {cancelable: true}))), true);
  await page.waitForFunction(() => __statusUI.closed === 1);
  assert.equal(await page.evaluate(id => __statusUI.messages.some(message => message.op === 'session.cancel' && message.requestId === id), closingRequest), true);
  assert.equal(await page.evaluate(() => __statusUI.state.drafts.find(item => item.id === 'draft-b').description), '关闭前最后编辑的 B');
  const closedState = await page.evaluate(() => structuredClone(__statusUI.state));
  await page.evaluate(id => __statusUI.release(id), closingRequest);
  await page.waitForFunction(id => __statusUI.released.includes(id), closingRequest);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await page.evaluate(() => __statusUI.state), closedState, 'cancelled late result cannot rewrite closed drafts');
  assert.equal(await page.evaluate(() => __statusUI.requests.filter(item => item.path === '/web/api/media/item/info/').length), 4);
  assert.equal(await page.evaluate(() => __statusUI.requests.some(item => item.method !== 'GET' || /upload|create_v2|user\/info/.test(item.path))), false);
  assert.equal(await page.evaluate(() => __statusUI.messages.some(message => message.op === 'session.login' || message.op.startsWith('body.'))), false);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  console.log('status query UI passed: non-blocking reads, originating-draft receipts, dismissible errors without state changes, repeat error visibility, failure preservation, cancellation and no uploads/publication');
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
