import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

// 全编辑器集成回归运行真实 state/resources/activities/AI 模块；边界仅返回合成只读数据。
const root = fileURLToPath(new URL('../app/', import.meta.url));
const output = fileURLToPath(new URL('../output/playwright/', import.meta.url));
const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#b6c7d0"/><path d="M0 600 300 200 600 500 800 300 800 600Z" fill="#708590"/></svg>';
const aiCalls = [];
await mkdir(output, {recursive: true});
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/api/v1/ai/publish-assist') {
    const parts = []; for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts)); aiCalls.push(body);
    assert.ok(['analyze', 'select'].includes(body.phase));
    response.setHeader('Content-Type', 'application/json');
    const data = body.phase === 'select' ? {choice: null} : {title: '一段新的记录', description: '用新的文字记下这个下午。', location: null, music: {queries: ['合成音乐搜索'], style: '轻柔'}};
    response.end(JSON.stringify({code: 0, data})); return;
  }
  if (url.pathname.startsWith('/api/v1/assets/activity-image/')) { response.setHeader('Content-Type', 'image/svg+xml'); response.end(picture); return; }
  if (url.pathname === '/api/v1/assets/activity-image') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({code: 0, data: {id: 'activity-image', name: '合成活动图片.jpg', mediaType: 'image', sizeBytes: 1000, directoryPath: '/synthetic/摄影日记'}})); return;
  }
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
  const page = await browser.newPage({viewport: {width: 1280, height: 980}}), errors = [], alerts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { alerts.push(dialog.message()); await dialog.accept(); });
  await page.addInitScript(({origin}) => {
    const initial = {version: 2, activeDraftId: 'activity-draft', drafts: [{id: 'activity-draft', name: '活动集成回归', kind: 'image',
      assets: [{id: 'activity-image', name: '合成活动图片.jpg', kind: 'image'}], title: '摄影记录', description: '原文😀 #摄影日常', aiContext: '一段新的摄影记录',
      topics: [{id: '7001', name: '摄影日常'}], mentions: [], activities: [], settings: {visibility: 'public', download: 'allow', publishTime: 'now', scheduledAt: '', declarations: []}}]};
    const state = JSON.parse(sessionStorage.getItem('activity-integration-state') || JSON.stringify(initial));
    const profile = {id: 'activity-profile', accountId: '123', name: '活动回归账号', browserSessionAvailable: true, hasCookies: true, expiresAt: '2099-01-01T00:00:00Z'}, runtime = {};
    window.__activityUI = {state, requests: []};
    window.pluginContext = {nativeUIAvailable: true, browserEnvironment: {userAgent: 'SyntheticWebKit/1.0', languages: ['zh-CN', 'en-US']}, nativeCapabilities: {browserRequestsVersion: 1, persistentWebsiteSessionsVersion: 1, sessionLoginOptionsVersion: 1, networkHeadersVersion: 1, sessionVersion: 1, sessionProfilesVersion: 1, mediaSelectionVersion: 1}, apiBaseURL: origin + '/api/v1', libraryID: 'activity-integration-fixture', frontendState: state};
    const status = () => ({browserSessionAvailable: true, hasCookies: true, activeProfileId: profile.id, accountId: profile.accountId, name: profile.name, expiresAt: profile.expiresAt});
    window.webkit = {messageHandlers: {pluginUI: {postMessage: async message => {
      if (message.op === 'persist') { window.__activityUI.state = structuredClone(message.value); sessionStorage.setItem('activity-integration-state', JSON.stringify(message.value)); return {ok: true}; }
      if (['session.status', 'session.identify', 'session.select'].includes(message.op)) return {ok: true, data: status()};
      if (message.op === 'session.list') return {ok: true, data: {items: [profile], activeProfileId: profile.id, hasMore: false, nextOffset: null}};
      if (message.op === 'state.get') return {ok: true, data: message.keys ? {[message.keys]: runtime[message.keys]} : runtime};
      if (message.op === 'state.set') { Object.assign(runtime, message.values); return {ok: true, data: {saved: true}}; }
      if (message.op === 'session.cancel') return {ok: true, data: {cancelled: true}};
      if (message.op !== 'browser.request') throw Error('Unexpected native operation: ' + message.op);
      const url = new URL(message.url); window.__activityUI.requests.push({url: message.url, method: message.method});
      let data;
      if (url.pathname === '/web/api/media/user/info/') data = {status_code: 0, user: {uid: '123', nickname: profile.name}};
      // 列表数字已被服务端舍入；准确字符串只来自选择时的详情，不能在 UI 中修补数字。
      else if (url.pathname === '/web/api/media/activity/get/') data = {status_code: 0, activity_list: [{activity_id: '101', activity_name: '官方摄影活动', challenge_ids: [7655295256916658000], challenge: ['活动摄影话题'], hot_score: 12000, activity_status: 1}]};
      else if (url.pathname === '/web/api/media/activity/detail/') data = {status_code: 0, activity_info: {activity_id: '101', activity_name: '官方摄影活动'}, topics: ['活动摄影话题'], topics_ids: ['7655295256916658211']};
      else if (url.pathname === '/aweme/v3/user_declaration/suggestion/') data = {status_code: 0, data: {block_type: 0, options: []}};
      else if (url.pathname === '/web/api/media/aweme/search/post/auth') data = {status_code: 0, signature: 'synthetic-activity-ai-grant'};
      else if (url.origin === 'https://tsearch.amemv.com' && url.pathname === '/openapi/aweme/v1/music/search/') data = {status_code: 0, music: [], has_more: 0};
      else if (url.pathname === '/aweme/v1/hotspot/recommend/') data = {status_code: 0, all_sentences: [], rec_sentences: []};
      else if (url.pathname === '/aweme/v1/search/challengesug/') data = {status_code: 0, sug_list: []};
      else throw Error('Unexpected platform request: ' + url.pathname);
      return {ok: true, data: {status: 200, headers: {'content-type': 'application/json'}, body: JSON.stringify(data)}};
    }}}};
  }, {origin});

  // 通过真实入口核验账号；活动请求使用生产 creator API 解包，未伪造 capabilities。
  async function connect() {
    if (!await page.locator('#account-menu').evaluate(node => node.open)) await page.locator('#account-menu summary').click();
    await page.locator('#connect').click();
    await page.locator('#connection-label').filter({hasText: '活动回归账号'}).waitFor();
    if (await page.locator('#account-menu').evaluate(node => node.open)) await page.locator('#account-menu summary').click();
    await page.locator('[data-activity-id="101"]').waitFor();
  }
  // 比较真实 textarea、UTF-16 计数和镜像高亮，不依赖控件自身报告的选择数量。
  async function expectDescription(value, topicIDs) {
    assert.equal(await page.locator('#description').inputValue(), value);
    assert.equal(await page.locator('#description-count').textContent(), `${value.length} / 1000`);
    const marks = await page.locator('.studio-description-entity').evaluateAll(nodes => nodes.map(node => ({id: node.dataset.entityId, color: getComputedStyle(node).backgroundColor})));
    assert.deepEqual(marks.map(item => item.id).sort(), [...topicIDs].sort());
    assert.ok(marks.every(item => item.color === 'rgb(228, 240, 255)'), 'selected activity topics use the existing light-blue background');
  }
  const original = '原文😀 #摄影日常', joined = original + ' #活动摄影话题';
  await page.goto(origin); await connect();
  const card = page.locator('[data-activity-id="101"]'), toggle = card.locator('.studio-activity-add');
  await expectDescription(original, ['7001']);
  assert.equal(await page.evaluate(() => window.__activityUI.requests.filter(item => item.url.includes('/activity/detail/')).length), 0, 'listing does not prefetch every activity detail');
  await card.hover(); await toggle.click();
  await page.waitForFunction(() => window.__activityUI.state.drafts[0].activities.length === 1);
  await expectDescription(joined, ['7001', '7655295256916658211']);
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  // 标题、普通正文输入只更新摘要和预览，草稿行与无变化的活动卡片保持原节点。
  await page.evaluate(() => { window.stableDraftRow = document.querySelector('.draft-row'); window.stableActivityCard = document.querySelector('[data-activity-id="101"]'); });
  const titleBefore = await page.locator('#title').inputValue();
  await page.locator('#title').fill('改过的标题');
  await page.locator('#description').fill(joined + ' 补充说明');
  assert.equal(await page.locator('#description-count').textContent(), `${(joined + ' 补充说明').length} / 1000`);
  assert.deepEqual(await page.evaluate(() => ({draft: stableDraftRow === document.querySelector('.draft-row'), activity: stableActivityCard === document.querySelector('[data-activity-id="101"]')})), {draft:true,activity:true});
  await page.locator('#description').fill(joined);
  await page.locator('#title').fill(titleBefore);
  assert.deepEqual(await page.evaluate(() => window.__activityUI.state.drafts[0].activities), [{id: '101', name: '官方摄影活动', topic: {id: '7655295256916658211', name: '活动摄影话题'}}]);
  assert.equal(await page.evaluate(() => JSON.stringify(window.__activityUI.state).includes('7655295256916658000')), false, 'rounded list ID never enters draft state');
  await page.screenshot({path: output + 'studio-activity-integrated-topic.png'});

  // 取消只解除活动参加状态；正文和普通话题身份保持，重新添加不会重复标记或空格。
  const beforeCancel = await page.evaluate(() => window.__activityUI.requests.length);
  await toggle.click();
  await page.waitForFunction(() => window.__activityUI.state.drafts[0].activities.length === 0);
  await expectDescription(joined, ['7001', '7655295256916658211']);
  assert.equal(await page.evaluate(() => window.__activityUI.requests.length), beforeCancel, 'cancel only changes local association');
  assert.deepEqual(await page.evaluate(() => window.__activityUI.state.drafts[0].topics), [{id: '7001', name: '摄影日常'}, {id: '7655295256916658211', name: '活动摄影话题'}]);
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  await toggle.click();
  await page.waitForFunction(() => window.__activityUI.state.drafts[0].activities.length === 1);
  await expectDescription(joined, ['7001', '7655295256916658211']);

  // 手动删除 token 同步解除活动和对应话题；其他普通话题与高亮保留。
  await page.locator('#description').fill(original);
  await page.waitForFunction(() => window.__activityUI.state.drafts[0].activities.length === 0 && window.__activityUI.state.drafts[0].topics.length === 1);
  await expectDescription(original, ['7001']);
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');

  // 刷新恢复活动与话题身份；只采纳 AI 文案时，未勾选的手选活动及其可见话题继续保留。
  await page.keyboard.press('Escape');
  await card.hover(); await toggle.click();
  await page.waitForFunction(() => window.__activityUI.state.drafts[0].activities.length === 1);
  await page.reload(); await connect();
  await expectDescription(joined, ['7001', '7655295256916658211']);
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  await page.locator('#open-ai').click(); await page.locator('#ai-generate').click();
  await page.waitForFunction(() => !document.querySelector('#ai-result').hidden && !document.querySelector('#ai-apply').disabled);
  assert.equal(await page.locator('#ai-apply-activity').isChecked(), false, 'manually chosen activity is not replaced by a no-activity recommendation');
  const beforeApplyRequests = await page.evaluate(() => window.__activityUI.requests.length);
  await page.locator('#ai-apply').click();
  await page.waitForFunction(() => window.__activityUI.state.drafts[0].title === '一段新的记录');
  assert.equal(await page.locator('#confirm-dialog').evaluate(node => node.open), false, 'explicitly selecting AI suggestions does not open another confirmation');
  const replacement = await page.locator('#description').inputValue();
  assert.equal(replacement, '#有序图库\n用新的文字记下这个下午。\n#活动摄影话题', 'copy replacement preserves the unselected activity and its visible topic without inventing a photo date');
  await expectDescription(replacement, ['0', '7655295256916658211']);
  assert.deepEqual(await page.locator('.studio-description-entity').allTextContents(), ['#有序图库', '#活动摄影话题']);
  assert.deepEqual(await page.evaluate(() => window.__activityUI.state.drafts[0].activities), [{id: '101', name: '官方摄影活动', topic: {id: '7655295256916658211', name: '活动摄影话题'}}]);
  assert.deepEqual(await page.evaluate(() => window.__activityUI.state.drafts[0].topics), [{id: '0', name: '有序图库'}, {id: '7655295256916658211', name: '活动摄影话题'}]);
  assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => window.__activityUI.requests.length), beforeApplyRequests, 'applying prepared suggestions does not recheck the account or resolve activities again');
  assert.equal(aiCalls.filter(call => call.phase === 'analyze').length, 1);
  assert.equal(aiCalls.filter(call => call.phase === 'select').length, 1, 'actual activity candidates are evaluated independently of copy');
  assert.equal(await page.evaluate(() => window.__activityUI.requests.some(item => item.method !== 'GET' || /upload|create_v2/.test(item.url))), false);
  assert.deepEqual(alerts, []); assert.deepEqual(errors, []);
  console.log('activity integration UI: real API fields, blue topic highlight, UTF-16 count, selection persistence, token removal, AI copy replacement preserves unselected activities and ordinary-topic removal passed');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
