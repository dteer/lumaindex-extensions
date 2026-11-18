import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, webkit} from 'playwright';

// 真实页面、客户端和编排模块配合合成宿主/AI 边界；绝不连接真实模型或上传发布。
const root = fileURLToPath(new URL('../app/', import.meta.url));
const output = fileURLToPath(new URL('../output/playwright/', import.meta.url));
const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#b8cbd5"/><path d="M0 600 250 200 480 510 680 300 800 600Z" fill="#687f8b"/><circle cx="610" cy="140" r="55" fill="#f0e8cf"/></svg>';
const model = {calls: [], fail: '', hold: '', pending: [], title: '湖边的好时光'};
await mkdir(output, {recursive: true});
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/api/v1/ai/publish-assist') {
    const parts = []; for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts)); model.calls.push(body);
    const result = body.phase === 'analyze' ? {title: model.title, description: '沿着湖边慢慢走，留住今天的光。', location: {cityName: '杭州', query: '西湖', evidence: '作品背景提供杭州'}, music: {queries: [model.musicQuery || '舒缓钢琴'], style: '轻柔舒缓'}}
      : {location: body.candidates.locations[0] ? {id: body.candidates.locations[0].id, reason: '与作品背景一致'} : null, music: body.candidates.music[0] ? {id: body.candidates.music[0].id, reason: '适合画面和文字的轻缓节奏'} : null};
    const failed = model.fail === body.phase;
    const finish = () => {
      if (response.destroyed) return;
      response.setHeader('Content-Type', 'application/json');
      response.writeHead(failed ? 400 : 200).end(JSON.stringify(failed ? {code: 10001, message: '合成 AI 请求失败，请检查输入后重试。'} : {code: 0, data: result}));
    };
    if (model.hold === body.phase) { model.pending.push(finish); model.onHeld?.(); } else finish();
    return;
  }
  if (/^\/api\/v1\/assets\/fixture-\d+\//.test(url.pathname)) { response.setHeader('Content-Type', 'image/svg+xml'); response.end(picture); return; }
  if (/^\/api\/v1\/assets\/fixture-\d+$/.test(url.pathname)) {
    const id = url.pathname.split('/').at(-1);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({code: 0, data: {id, name: `杭州摄影${id.slice(8)}.jpg`, mediaType: 'image', sizeBytes: 1000, directoryPath: id === 'fixture-1' ? '/private/synthetic/2024-02-29 杭州西湖/修图' : id === 'fixture-2' ? '/private/synthetic/2021_7_6 合成旅拍' : '/private/synthetic/2023-01-01/无日期目录', shootDate: '2026-11-18T10:00:00Z', photoMetadata: id === 'fixture-1' ? JSON.stringify({rawFields: {'{Exif}.DateTimeOriginal': '2019:01:01 00:05:06', '{Exif}.OffsetTimeOriginal': '+14:00', '{GPS}.Latitude': 'synthetic-private'}}) : JSON.stringify({rawFields: {'{TIFF}.DateTime': '2026:11:18 10:00:00'}})}})); return;
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
const browserType = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
const browser = await browserType.launch({headless: true, ...(browserType === chromium && process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 980}}), errors = [], alerts = [];
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  // Playwright 接收真正的 window.alert 对话框，验证错误走原生 alert 而非悄悄吞掉。
  page.on('dialog', async dialog => { alerts.push({type: dialog.type(), message: dialog.message()}); await dialog.accept(); });
  await page.route('https://media.example.test/**', route => route.fulfill({status: 200, contentType: 'image/svg+xml', body: picture}));
  await page.addInitScript(({origin}) => {
    const initial = {version: 2, activeDraftId: 'ai-draft', aiPrompt: '请用自然简洁的中文创作', drafts: [{id: 'ai-draft', name: 'AI 回归作品', kind: 'image',
      assets: Array.from({length: 8}, (_, index) => ({id: `fixture-${index + 1}`, name: `杭州摄影${index + 1}.jpg`, kind: 'image'})),
      title: '手写标题', description: '手写描述 #旧话题', aiContext: '杭州西湖散步', topics: [{id: '8801', name: '旧话题'}], mentions: [],
      location: {id: '9001', name: '手动选择的位置', cityCode: '110100', cityName: '北京市'}, music: {id: '9002', name: '手动选择的音乐'},
      settings: {visibility: 'public', download: 'allow', publishTime: 'now', scheduledAt: '', declarations: []}}]};
    const state = JSON.parse(sessionStorage.getItem('ai-ui-state') || JSON.stringify(initial));
    const profile = {id: 'ai-profile', accountId: '123', name: '合成 AI 回归账号', browserSessionAvailable: true, hasCookies: true, expiresAt: '2099-01-01T00:00:00Z'}, runtime = {};
    window.__aiUI = {state, requests: [], messages: []};
    // 仅在迟到测试中模拟传输忽略取消，让真实晚到 HTTP 回执检验界面的任务所有权。
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, options) => window.__aiUI.ignoreAIAbort && String(input).endsWith('/ai/publish-assist') ? nativeFetch(input, {...options, signal: undefined}) : nativeFetch(input, options);
    window.pluginContext = {nativeUIAvailable: true, browserEnvironment: {userAgent: 'SyntheticWebKit/1.0', languages: ['zh-CN', 'en-US']}, nativeCapabilities: {browserRequestsVersion: 1, persistentWebsiteSessionsVersion: 1, sessionLoginOptionsVersion: 1, networkHeadersVersion: 1, sessionVersion: 1, sessionProfilesVersion: 1, mediaSelectionVersion: 1}, apiBaseURL: origin + '/api/v1', libraryID: 'ai-ui-fixture', frontendState: state};
    const status = () => ({browserSessionAvailable: true, hasCookies: true, activeProfileId: profile.id, accountId: profile.accountId, name: profile.name, expiresAt: profile.expiresAt});
    window.webkit = {messageHandlers: {pluginUI: {postMessage: async message => {
      window.__aiUI.messages.push(structuredClone(message));
      if (message.op === 'persist') { window.__aiUI.state = structuredClone(message.value); sessionStorage.setItem('ai-ui-state', JSON.stringify(message.value)); return {ok: true}; }
      if (['session.status', 'session.identify', 'session.select'].includes(message.op)) return {ok: true, data: status()};
      if (message.op === 'session.list') return {ok: true, data: {items: [profile], activeProfileId: profile.id, hasMore: false, nextOffset: null}};
      if (message.op === 'state.get') return {ok: true, data: message.keys ? {[message.keys]: runtime[message.keys]} : runtime};
      if (message.op === 'state.set') { Object.assign(runtime, message.values); return {ok: true, data: {saved: true}}; }
      if (message.op === 'session.cancel') return {ok: true, data: {cancelled: true}};
      if (message.op !== 'browser.request') throw Error('Unexpected native AI operation: ' + message.op);
      const url = new URL(message.url); window.__aiUI.requests.push({url: message.url, method: message.method});
      if (window.__aiUI.failMusic && url.origin === 'https://tsearch.amemv.com') return {ok: false, error: {code: 'SESSION_EXPIRED', message: '合成账号暂时离线，请手动处理后重试音乐查询。'}};
      let data;
      if (url.pathname === '/web/api/media/user/info/') data = {status_code: 0, user: {uid: '123', nickname: profile.name}};
      else if (url.pathname === '/web/api/media/activity/get/') data = {status_code: 0, activity_list: []};
      else if (url.pathname === '/aweme/v3/user_declaration/suggestion/') data = {status_code: 0, data: {block_type: 0, options: []}};
      else if (url.pathname === '/web/api/media/aweme/search/post/auth') data = {status_code: 0, signature: 'synthetic-ai-search-grant'};
      else if (url.origin === 'https://tsearch.amemv.com' && url.pathname === '/openapi/aweme/v1/music/search/') data = {status_code: 0, music: [{id_str: '3302', title: '舒缓钢琴曲', author: '合成作者', duration: 120, cover_thumb: {url_list: ['https://media.example.test/piano.svg']}}], has_more: 0};
      else if (url.pathname === '/aweme/v1/life/video_api/search/poi/') data = {status_code: 0, poi_list: [{poi_id: '4401', poi_name: '西湖风景区', address_info: {simple_addr: '杭州市西湖区'}, anchor_post_ext: {anchor_content: '{}'}}], has_more: false};
      else throw Error('Unexpected platform request: ' + url.pathname);
      return {ok: true, data: {status: 200, headers: {'content-type': 'application/json'}, body: JSON.stringify(data)}};
    }}}};
  }, {origin});

  // 显式检查账号后运行真实平台查询适配；默认只生成文字，不隐式发送首图。
  async function connect() {
    if (!await page.locator('#account-menu').evaluate(node => node.open)) await page.locator('#account-menu summary').click();
    await page.locator('#connect').click();
    await page.locator('#connection-label').filter({hasText: '合成 AI 回归账号'}).waitFor();
    if (await page.locator('#account-menu').evaluate(node => node.open)) await page.locator('#account-menu summary').click();
  }
  // 等到生成结束再检查结果，不把中途可见的旧文案误判为新结果。
  async function generate() {
    await page.locator('#ai-generate').click();
    await page.waitForFunction(() => !document.querySelector('#ai-result').hidden && !document.querySelector('#ai-generate').disabled && !document.querySelector('#ai-apply').disabled);
  }
  // 应用现有字段时确认产品内替换提示，最终从真实持久化快照核验。
  async function applySelected() {
    await page.locator('#ai-apply').click();
    await page.locator('#confirm-dialog[open]').waitFor();
    await page.locator('#confirm-submit').click();
    await page.waitForFunction(() => !document.querySelector('#ai-dialog').open);
  }
  // 日期话题是本地确定性绑定；只应用正文不能触发搜索或额外账号核验。
  const lookupCounts = () => page.evaluate(() => ({
    topics: window.__aiUI.requests.filter(item => new URL(item.url).pathname === '/aweme/v1/search/challengesug/').length,
    account: window.__aiUI.requests.filter(item => new URL(item.url).pathname === '/web/api/media/user/info/').length,
    session: window.__aiUI.messages.filter(item => ['session.status', 'session.list', 'session.identify', 'session.login'].includes(item.op)).length,
  }));
  // 使用真实滚轮验证背景与弹窗滚动隔离；不靠修改 scrollTop 模拟实际用户滚动结果。
  async function verifyModalScrolling() {
    await page.setViewportSize({width: 1280, height: 640});
    const position = await page.evaluate(() => {
      document.querySelector('.editor-column').scrollTop = 250;
      document.querySelector('.preview-column').scrollTop = 30;
      const position = {left: document.querySelector('.editor-column').scrollTop, right: document.querySelector('.preview-column').scrollTop};
      document.querySelector('#open-ai').click();
      return position;
    });
    const backgroundPosition = () => page.evaluate(() => ({left: document.querySelector('.editor-column').scrollTop, right: document.querySelector('.preview-column').scrollTop}));
    assert.ok(position.left > 0, 'fixture must start at a nonzero editor position');
    await page.locator('#ai-dialog[open]').waitFor();
    await page.locator('#ai-use-images').check();
    await page.locator('#ai-dialog details summary').click();
    await page.evaluate(() => { document.querySelector('#ai-dialog').scrollTop = 0; });
    const bounds = await page.locator('#ai-dialog').boundingBox();
    assert.equal(await page.locator('#ai-dialog').evaluate(node => node.scrollHeight > node.clientHeight), true, 'AI content must be long enough to scroll independently');
    await page.mouse.move(bounds.x + 10, bounds.y + Math.min(180, bounds.height / 2));
    await page.mouse.wheel(0, 240);
    await page.waitForFunction(() => document.querySelector('#ai-dialog').scrollTop > 0);
    assert.deepEqual(await backgroundPosition(), position, 'scrolling AI content must leave both workspace columns fixed');
    // 弹窗滚到末尾后继续滚、或在遮罩上滚动，都不能穿透背景。
    await page.locator('#ai-dialog').evaluate(node => { node.scrollTop = node.scrollHeight; });
    await page.mouse.wheel(0, 300);
    await page.mouse.move(5, 320); await page.mouse.wheel(0, 350);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await backgroundPosition(), position, 'modal boundary and backdrop wheels must not scroll either background column');
    // 顶层确认框关闭后，下层 AI 仍是 modal，不能提前恢复背景滚动。
    await page.locator('#confirm-dialog').evaluate(node => node.showModal());
    await page.mouse.move(5, 320); await page.mouse.wheel(0, 350);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await backgroundPosition(), position);
    await page.locator('#confirm-dialog').evaluate(node => node.close());
    assert.deepEqual(await page.evaluate(() => ['.editor-column', '.preview-column'].map(selector => getComputedStyle(document.querySelector(selector)).overflowY)), ['hidden', 'hidden']);
    await page.mouse.wheel(0, 350);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(await backgroundPosition(), position, 'remaining modal must retain both background scroll locks');
    await page.locator('#ai-dialog details').evaluate(node => { node.open = false; });
    await page.locator('#ai-use-images').uncheck();
    await page.locator('#ai-close').click();
    await page.waitForFunction(() => !document.querySelector('dialog:modal'));
    assert.deepEqual(await backgroundPosition(), position, 'closing all dialogs must preserve both original scroll positions');
    const editor = await page.locator('.editor-column').boundingBox();
    await page.mouse.move(editor.x + 8, editor.y + 120); await page.mouse.wheel(0, 300);
    await page.waitForFunction(oldPosition => document.querySelector('.editor-column').scrollTop !== oldPosition, position.left);
    await page.setViewportSize({width: 1280, height: 980});
    await page.evaluate(() => { scrollTo(0, 0); for (const node of document.querySelectorAll('.editor-column, .preview-column')) node.scrollTop = 0; });
  }
  await page.goto(origin);
  await page.waitForFunction(() => document.body.dataset.phase === 'editing' && document.querySelectorAll('#studio-gallery .studio-gallery-image').length === 8);
  await connect(); await verifyModalScrolling(); await page.locator('#open-ai').click();
  assert.equal(await page.locator('#ai-use-images').isChecked(), false);
  assert.equal(await page.locator('#ai-image-section').isHidden(), true);
  await generate();
  assert.deepEqual(model.calls.find(item => item.phase === 'analyze').assetIds, []);
  assert.equal(await page.locator('#ai-apply-location').isChecked(), false);
  assert.equal(await page.locator('#ai-apply-music').isChecked(), false);
  assert.match(await page.locator('#ai-existing-location').textContent(), /手动选择的位置/);
  assert.match(await page.locator('#ai-existing-music').textContent(), /手动选择的音乐/);
  const topicsBeforeApply = await page.evaluate(() => structuredClone(window.__aiUI.state.drafts[0].topics));
  await page.locator('#ai-apply').click(); await page.locator('#confirm-dialog[open]').waitFor(); await page.locator('#confirm-cancel').click();
  assert.deepEqual(await page.evaluate(() => window.__aiUI.state.drafts[0].topics), topicsBeforeApply, 'cancelling replacement must not bind the proposed date');
  assert.equal(await page.locator('#description').inputValue(), '手写描述 #旧话题');
  const lookupsBeforeApply = await lookupCounts();
  await applySelected();
  await page.waitForFunction(() => window.__aiUI.state.drafts[0].title === '湖边的好时光');
  assert.equal(await page.evaluate(() => window.__aiUI.state.drafts[0].location.id), '9001');
  assert.equal(await page.evaluate(() => window.__aiUI.state.drafts[0].music.id), '9002');
  assert.match(await page.locator('#description').inputValue(), /\n#20190101$/);
  assert.match(await page.locator('#description').inputValue(), /^#有序图库\n/);
  assert.equal(JSON.parse(model.calls.find(item => item.phase === 'analyze').context).dateTag, '#20190101');
  assert.deepEqual(await page.evaluate(() => window.__aiUI.state.drafts[0].topics), [{id: '0', name: '有序图库'}, {id: '0', name: '20190101'}], 'brand and date must remain distinct zero-ID bindings and removed old-description topics must be cleared');
  assert.deepEqual(await page.locator('.studio-description-entity[data-kind=topic]').allTextContents(), ['#有序图库', '#20190101']);
  const dateMark = page.locator('.studio-description-entity[data-kind=topic]').filter({hasText: '#20190101'});
  assert.equal(await dateMark.count(), 1);
  assert.equal(await dateMark.getAttribute('data-entity-id'), '0');
  assert.equal(await dateMark.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(228, 240, 255)');
  assert.deepEqual(await lookupCounts(), lookupsBeforeApply, 'copy-only application must not search topics or recheck the account');
  await page.locator('.description-editor').screenshot({path: output + 'studio-ai-applied-topics.png'});
  await page.reload(); await connect();
  await page.waitForFunction(() => [...document.querySelectorAll('.studio-description-entity[data-entity-id="0"]')].some(node => node.textContent === '#20190101'));
  assert.deepEqual(await page.evaluate(() => window.__aiUI.state.drafts[0].topics), [{id: '0', name: '有序图库'}, {id: '0', name: '20190101'}], 'reopening the real page must preserve both saved zero-ID bindings');
  assert.deepEqual(await page.locator('.studio-description-entity[data-kind=topic]').allTextContents(), ['#有序图库', '#20190101']);

  // 开启后仅选第一张；圆圈与点击范围都在缩略图右下，图片主体点击不切换选择。
  await page.locator('#open-ai').click(); await page.locator('#ai-use-images').check();
  assert.equal(await page.locator('.ai-image-toggle[aria-pressed=true]').count(), 1);
  assert.match(await page.locator('.ai-image-toggle[aria-pressed=true]').getAttribute('aria-label'), /杭州摄影1/);
  const metrics = await page.locator('.ai-image-card').first().evaluate(card => {
    const frame = card.querySelector('.ai-image-frame').getBoundingClientRect(), toggle = card.querySelector('button').getBoundingClientRect(), name = card.querySelector('.ai-image-name').getBoundingClientRect();
    return {right: frame.right - toggle.right, bottom: frame.bottom - toggle.bottom, overlapsName: toggle.bottom > name.top, radius: getComputedStyle(card.querySelector('.ai-image-circle')).borderRadius};
  });
  assert.ok(metrics.right >= 0 && metrics.right <= 8 && metrics.bottom >= 0 && metrics.bottom <= 8);
  assert.equal(metrics.overlapsName, false); assert.equal(metrics.radius, '50%');
  await page.locator('.ai-image-frame img').nth(1).click();
  assert.equal(await page.locator('.ai-image-toggle[aria-pressed=true]').count(), 1);
  for (let index = 1; index < 6; index++) await page.locator('.ai-image-toggle').nth(index).click();
  await page.locator('.ai-image-toggle').nth(6).click();
  assert.equal(await page.locator('.ai-image-toggle[aria-pressed=true]').count(), 6);
  assert.match(await page.locator('#ai-status').textContent(), /最多选择 6/);
  await page.locator('#ai-context').fill('杭州西湖傍晚散步，自然克制的摄影记录');
  await page.locator('#ai-dialog details summary').click();
  await page.locator('#ai-prompt').fill('请写短句，突出傍晚的湖面，不编造经历。');
  await page.waitForFunction(() => window.__aiUI.state.aiPrompt === '请写短句，突出傍晚的湖面，不编造经历。' && window.__aiUI.state.drafts[0].aiContext.includes('傍晚散步'));
  await generate();
  const imageRequest = model.calls.filter(item => item.phase === 'analyze').at(-1);
  assert.deepEqual(imageRequest.assetIds, ['fixture-1', 'fixture-2', 'fixture-3', 'fixture-4', 'fixture-5', 'fixture-6']);
  assert.equal(JSON.parse(imageRequest.context).directoryName, '2024-02-29 杭州西湖');
  assert.equal(JSON.parse(imageRequest.context).dateTag, '#20190101');
  assert.equal(imageRequest.context.includes('/private/synthetic'), false);
  await page.screenshot({path: output + 'studio-ai-suggestions.png'});
  await page.locator('#ai-result-music').scrollIntoViewIfNeeded();
  await page.screenshot({path: output + 'studio-ai-resources.png'});

  // 只勾选资源则保留现有文案，替换仍有确认；平台候选 URL 不进入持久化作品。
  await page.locator('#ai-apply-copy').uncheck();
  await page.locator('#ai-apply-location').check(); await page.locator('#ai-apply-music').check();
  const oldCopy = await page.locator('#title').inputValue();
  const oldTopics = await page.evaluate(() => structuredClone(window.__aiUI.state.drafts[0].topics));
  await applySelected();
  await page.waitForFunction(() => window.__aiUI.state.drafts[0].music.id === '3302' && window.__aiUI.state.drafts[0].location.id === '4401');
  assert.equal(await page.locator('#title').inputValue(), oldCopy);
  assert.deepEqual(await page.evaluate(() => window.__aiUI.state.drafts[0].topics), oldTopics, 'resource-only application must preserve existing topic bindings');
  assert.deepEqual(await page.evaluate(() => window.__aiUI.state.drafts[0].location), {id: '4401', name: '西湖风景区', cityCode: '330100', cityName: '杭州市'});
  assert.equal(await page.evaluate(() => JSON.stringify(window.__aiUI.state).includes('https://media.example.test')), false);

  // 背景按草稿、提示词按全局恢复；页面重新打开默认仍不发送图片。
  await page.reload(); await connect(); await page.locator('#open-ai').click();
  assert.equal(await page.locator('#ai-context').inputValue(), '杭州西湖傍晚散步，自然克制的摄影记录');
  await page.locator('#ai-dialog details summary').click();
  assert.equal(await page.locator('#ai-prompt').inputValue(), '请写短句，突出傍晚的湖面，不编造经历。');
  assert.equal(await page.locator('#ai-use-images').isChecked(), false);

  // 资源失败保留可用文案；重试只发 match，不重新 analyze 或再次选择图片。
  model.fail = 'match'; await generate();
  assert.match(await page.locator('#ai-warnings').textContent(), /合成 AI 请求失败/);
  assert.equal(await page.locator('#ai-apply-copy').isChecked(), true);
  assert.equal(await page.locator('#ai-apply-location').isDisabled(), true);
  const analyzeBeforeRetry = model.calls.filter(item => item.phase === 'analyze').length;
  const matchBeforeRetry = model.calls.filter(item => item.phase === 'match').length;
  model.fail = ''; await page.locator('#ai-retry-resources').click();
  await page.waitForFunction(() => !document.querySelector('#ai-generate').disabled && !document.querySelector('#ai-apply-location').disabled);
  assert.equal(model.calls.filter(item => item.phase === 'analyze').length, analyzeBeforeRetry);
  assert.equal(model.calls.filter(item => item.phase === 'match').length, matchBeforeRetry + 1);

  // 完整生成失败触发真实 alert，输入仍保留；部分资源失败不把整份文案误判为失败。
  model.fail = 'analyze';
  await page.locator('#ai-generate').click();
  await page.waitForFunction(() => !document.querySelector('#ai-generate').disabled && document.querySelector('#ai-status').textContent.includes('合成 AI 请求失败'));
  assert.ok(alerts.some(item => item.type === 'alert' && item.message.includes('合成 AI 请求失败')));
  assert.equal(await page.locator('#ai-context').inputValue(), '杭州西湖傍晚散步，自然克制的摄影记录');
  model.fail = '';

  // 关闭或取消后晚到的后端应答不能重新显示结果；快速重新打开仍由新任务独占界面。
  const topicsBeforeCancellation = await page.evaluate(() => structuredClone(window.__aiUI.state.drafts[0].topics));
  model.hold = 'analyze';
  let held = new Promise(resolve => { model.onHeld = resolve; });
  await page.evaluate(() => { window.__aiUI.ignoreAIAbort = true; });
  await page.locator('#ai-generate').click();
  await held;
  await page.waitForFunction(() => !document.querySelector('#ai-cancel').hidden);
  await page.locator('#ai-close').click();
  await page.locator('#open-ai').click();
  await page.evaluate(() => { window.__aiUI.ignoreAIAbort = false; });
  let late = page.waitForResponse(response => response.url().endsWith('/ai/publish-assist'));
  model.hold = ''; for (const finish of model.pending.splice(0)) finish(); await late;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#ai-result').isHidden(), true); assert.equal(await page.locator('#ai-apply').isDisabled(), true);
  await generate();
  model.hold = 'match';
  held = new Promise(resolve => { model.onHeld = resolve; });
  await page.evaluate(() => { window.__aiUI.ignoreAIAbort = true; });
  await page.locator('#ai-generate').click();
  await held;
  await page.locator('#ai-status').filter({hasText: '正在从真实候选'}).waitFor();
  await page.locator('#ai-cancel').click();
  await page.evaluate(() => { window.__aiUI.ignoreAIAbort = false; });
  late = page.waitForResponse(response => response.url().endsWith('/ai/publish-assist'));
  model.hold = ''; for (const finish of model.pending.splice(0)) finish(); await late;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#ai-result').isHidden(), true); assert.match(await page.locator('#ai-status').textContent(), /已取消/);
  assert.deepEqual(await page.evaluate(() => window.__aiUI.state.drafts[0].topics), topicsBeforeCancellation, 'cancelled or late generation must not modify draft topics');

  // 日期跟随正文第一张图的顺序，与 AI 选中分析哪张无关；没有日期不向上越级或猜当天。
  await page.locator('#ai-close').click();
  await page.locator('#studio-gallery .studio-gallery-image').nth(1).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForFunction(() => window.__aiUI.state.drafts[0].assets[0].id === 'fixture-2');
  await page.locator('#open-ai').click();
  await generate();
  let firstImageContext = JSON.parse(model.calls.filter(item => item.phase === 'analyze').at(-1).context);
  assert.equal(firstImageContext.directoryName, '2021_7_6 合成旅拍');
  assert.equal(firstImageContext.dateTag, '#20210706');
  assert.match(await page.locator('#ai-result-description').textContent(), /\n#20210706$/);
  const oldDateCopy = await page.locator('#description').inputValue();
  const oldDateTopics = await page.evaluate(() => structuredClone(window.__aiUI.state.drafts[0].topics));
  await page.locator('#ai-apply-copy').uncheck(); await page.locator('#ai-apply-location').check(); await applySelected();
  assert.equal(await page.locator('#description').inputValue(), oldDateCopy);
  assert.deepEqual(await page.evaluate(() => window.__aiUI.state.drafts[0].topics), oldDateTopics, 'not selecting copy must not bind the newly suggested different date');
  await page.locator('#studio-gallery .studio-gallery-image').nth(2).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForFunction(() => window.__aiUI.state.drafts[0].assets[1].id === 'fixture-3');
  await page.locator('#studio-gallery .studio-gallery-image').nth(1).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForFunction(() => window.__aiUI.state.drafts[0].assets[0].id === 'fixture-3');
  await page.locator('#open-ai').click();
  await generate();
  firstImageContext = JSON.parse(model.calls.filter(item => item.phase === 'analyze').at(-1).context);
  assert.deepEqual({directoryName: firstImageContext.directoryName, dateTag: firstImageContext.dateTag}, {directoryName: '无日期目录', dateTag: ''});
  assert.doesNotMatch(await page.locator('#ai-result-description').textContent(), /#\d{8}/);
  assert.match(await page.locator('#ai-result-description').textContent(), /^#有序图库\n/);
  assert.equal(model.calls.some(call => call.context?.includes('/private/synthetic') || call.context?.includes('synthetic-private') || call.context?.includes('rawFields')), false);

  // 窄窗内控件仍可达，不产生横向溢出；末尾确认测试没有调用上传或发布接口。
  await page.setViewportSize({width: 560, height: 850}); await page.locator('#ai-use-images').check();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const bounds = await page.locator('#ai-dialog').boundingBox(); assert.ok(bounds.width <= 560 && bounds.height <= 850);
  await page.screenshot({path: output + 'studio-ai-narrow.png'});

  // 实际客户端收到账号资源错误后，已完成的文字与另一类成功资源仍能显示和本地应用。
  model.title = '离线仍可编辑的文案'; model.musicQuery = '合成离线音乐查询';
  const beforeOffline = await page.evaluate(() => {
    window.__aiUI.failMusic = true;
    return {accountReads: window.__aiUI.requests.filter(item => new URL(item.url).pathname === '/web/api/media/user/info/').length,
      music: structuredClone(window.__aiUI.state.drafts[0].music), location: structuredClone(window.__aiUI.state.drafts[0].location)};
  });
  const analysesBeforeOffline = model.calls.filter(item => item.phase === 'analyze').length;
  await generate();
  assert.equal(await page.locator('#ai-result-title').textContent(), model.title);
  assert.match(await page.locator('#ai-warnings').textContent(), /账号暂时离线.*手动处理/);
  assert.equal(await page.locator('#ai-apply-location').isDisabled(), false, 'successful same-account location remains usable');
  assert.equal(await page.locator('#ai-apply-music').isDisabled(), true, 'failed music lookup must not invent a replacement');
  assert.equal(await page.locator('#ai-apply-copy').isChecked(), true);
  await applySelected();
  await page.waitForFunction(title => window.__aiUI.state.drafts[0].title === title, model.title);
  assert.deepEqual(await page.evaluate(() => window.__aiUI.state.drafts[0].topics), [{id: '0', name: '有序图库'}], 'copy without a deterministic date retains the brand only, without keeping removed date bindings or inventing today');
  assert.deepEqual(await page.evaluate(() => window.__aiUI.state.drafts[0].music), beforeOffline.music);
  assert.deepEqual(await page.evaluate(() => window.__aiUI.state.drafts[0].location), beforeOffline.location);
  assert.equal(model.calls.filter(item => item.phase === 'analyze').length, analysesBeforeOffline + 1);
  assert.equal(await page.evaluate(() => window.__aiUI.requests.filter(item => new URL(item.url).pathname === '/web/api/media/user/info/').length), beforeOffline.accountReads, 'resource failure cannot silently recheck the account');
  assert.equal(await page.evaluate(() => window.__aiUI.messages.some(item => item.op === 'session.login')), false);
  assert.equal(await page.evaluate(() => window.__aiUI.requests.some(item => item.method !== 'GET' || /upload|create_v2/.test(item.url))), false);

  // 重开带同名真实 ID 的合成草稿；AI 日期只能复用该绑定，不能替换成零 ID 或留下重复项。
  await page.evaluate(() => {
    const state = structuredClone(window.__aiUI.state), draft = state.drafts[0];
    draft.assets.sort((a, b) => a.id === 'fixture-1' ? -1 : b.id === 'fixture-1' ? 1 : 0);
    draft.description = '已有品牌 #有序图库 和日期 #20190101，以及将被移除的话题 #旧话题';
    draft.topics = [{id: '99200', name: '有序图库'}, {id: '99201', name: '20190101'}, {id: '99202', name: '旧话题'}];
    sessionStorage.setItem('ai-ui-state', JSON.stringify(state));
  });
  await page.reload(); await connect(); await page.locator('#open-ai').click(); await generate();
  const positiveLookups = await lookupCounts();
  await applySelected();
  await page.waitForFunction(() => window.__aiUI.state.drafts[0].description.endsWith('#20190101') && window.__aiUI.state.drafts[0].topics.length === 2);
  assert.deepEqual(await page.evaluate(() => window.__aiUI.state.drafts[0].topics), [{id: '99200', name: '有序图库'}, {id: '99201', name: '20190101'}]);
  assert.match(await page.locator('#description').inputValue(), /^#有序图库\n/);
  assert.deepEqual(await page.locator('.studio-description-entity[data-kind=topic]').evaluateAll(nodes => nodes.map(node => ({text: node.textContent, id: node.dataset.entityId}))), [{text: '#有序图库', id: '99200'}, {text: '#20190101', id: '99201'}]);
  assert.deepEqual(await lookupCounts(), positiveLookups, 'reusing an existing date ID must remain a local copy operation');
  assert.equal(await page.evaluate(() => window.__aiUI.requests.some(item => item.method !== 'GET' || /upload|create_v2/.test(item.url))), false);
  assert.deepEqual(errors, []);
  console.log('AI UI: deterministic date-topic marks and restore, existing ID preservation, local-only copy application, modal wheel isolation, image selection, preferences, explicit field application, partial retry and cancellation races passed');
} finally {
  for (const finish of model.pending.splice(0)) finish();
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
