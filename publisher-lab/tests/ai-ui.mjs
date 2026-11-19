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
const model = {calls: [], fail: '', hold: '', pending: [], title: '湖边的好时光', selectNone: new Set()};
await mkdir(output, {recursive: true});
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/api/v1/ai/publish-assist') {
    const parts = []; for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts)); model.calls.push(body);
    const selectionScope = body.phase === 'select' ? (body.options.some(item => item.id.startsWith('hotspot-')) ? 'hotspot' : 'activity') : '';
    const result = body.phase === 'select' ? {choice: model.selectNone.has(selectionScope) || !body.options.length ? null : {id: body.options[0].id, reason: '与作品内容直接相关'}} : body.phase === 'analyze' ? {title: model.title, description: '沿着湖边慢慢走，留住今天的光。', location: {cityName: '杭州', query: '西湖', evidence: '作品背景提供杭州'}, music: {queries: [model.musicQuery || '舒缓钢琴'], style: '轻柔舒缓'}}
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
    initial.drafts.push({...structuredClone(initial.drafts[0]), id: 'other-ai-draft', name: '另一份 AI 草稿', aiContext: '另一份作品背景'});
    const state = JSON.parse(sessionStorage.getItem('ai-ui-state') || JSON.stringify(initial));
    const profile = {id: 'ai-profile', accountId: '123', name: '合成 AI 回归账号', browserSessionAvailable: true, hasCookies: true, expiresAt: '2099-01-01T00:00:00Z'}, runtime = {};
    window.__aiUI = {state, requests: [], messages: [], changeAccount: (accountId = '456') => { profile.accountId = accountId; profile.id = 'profile-' + accountId; profile.name = '另一个合成账号'; }};
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
      if (url.pathname === '/web/api/media/user/info/') data = {status_code: 0, user: {uid: profile.accountId, nickname: profile.name}};
      else if (url.pathname === '/web/api/media/activity/get/') data = {status_code: 0, activity_list: [{activity_id: '101', activity_name: '官方摄影活动', challenge_ids: [7655295256916658000], challenge: ['活动摄影话题'], hot_score: 12000, activity_status: 1}]};
      else if (url.pathname === '/web/api/media/activity/detail/') data = {status_code: 0, activity_info: {activity_id: '101', activity_name: '官方摄影活动'}, topics: ['活动摄影话题'], topics_ids: ['7655295256916658211']};
      else if (url.pathname === '/aweme/v1/hotspot/recommend/') data = {status_code: 0, rec_sentences: [], all_sentences: [{word: '山野徒步发现新风景', hot_value: 123000}, {word: '湖畔散步慢生活', hot_value: 45600}]};
      else if (url.pathname === '/aweme/v3/user_declaration/suggestion/') data = {status_code: 0, data: {block_type: 0, options: []}};
      else if (url.pathname === '/web/api/media/aweme/search/post/auth') data = {status_code: 0, signature: 'synthetic-ai-search-grant'};
      else if (url.origin === 'https://tsearch.amemv.com' && url.pathname === '/openapi/aweme/v1/music/search/') data = {status_code: 0, music: [{id_str: '3302', title: '舒缓钢琴曲', author: '合成作者', duration: 120, cover_thumb: {url_list: ['https://media.example.test/piano.svg']}}], has_more: 0};
      else if (url.pathname === '/aweme/v1/life/video_api/search/poi/') data = {status_code: 0, poi_list: [{poi_id: '4401', poi_name: '西湖风景区', address_info: {simple_addr: '杭州市西湖区'}, anchor_post_ext: {anchor_content: '{}'}}], has_more: false};
      else throw Error('Unexpected platform request: ' + url.pathname);
      return {ok: true, data: {status: 200, headers: {'content-type': 'application/json'}, body: JSON.stringify(data)}};
    }}}};
  }, {origin});

  const scopes = ['copy', 'activity', 'music', 'location', 'hotspot'];
  const draft = () => page.evaluate(() => structuredClone(__aiUI.state.drafts.find(item => item.id === __aiUI.state.activeDraftId)));
  const pauseFrames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  // 账号检查只由测试模拟用户点击，AI 生成与应用不得自行触发登录。
  async function connect(name = '合成 AI 回归账号') {
    if (!await page.locator('#account-menu').evaluate(node => node.open)) await page.locator('#account-menu summary').click();
    await page.locator('#connect').click();
    await page.locator('#connection-label').filter({hasText: name}).waitFor();
    if (await page.locator('#account-menu').evaluate(node => node.open)) await page.locator('#account-menu summary').click();
  }
  async function openAI() {
    if (await page.locator('#ai-dialog').isHidden()) await page.locator('#open-ai').click();
    await page.locator('#ai-suggestions').waitFor();
  }
  async function generate() {
    await page.locator('#ai-generate').click();
    await page.waitForFunction(() => !document.querySelector('#ai-result').hidden && !document.querySelector('#ai-generate').disabled);
  }
  async function selectOnly(keys) {
    for (const key of scopes) {
      const checkbox = page.locator('#ai-apply-' + key);
      if (!await checkbox.isDisabled()) await checkbox.setChecked(keys.includes(key));
    }
  }
  async function applySelected() {
    await page.locator('#ai-apply').click();
    await page.locator('#ai-status').filter({hasText: '所选建议已填入作品'}).waitFor();
    assert.equal(await page.locator('#confirm-dialog').evaluate(node => node.open), false, 'applying checked suggestions needs no extra confirmation');
    await page.waitForFunction(() => document.querySelector('#save-state').textContent.includes('已保存'));
  }
  async function regenerate(scope) {
    await page.locator('#ai-regenerate-' + scope).click();
    await page.waitForFunction(key => !document.querySelector('#ai-generate').disabled && !document.querySelector('#ai-regenerate-' + key).disabled, scope);
  }
  async function promptEditor(scope, text, save = true) {
    await page.locator('#ai-edit-' + scope + '-prompt').click();
    await page.locator('#ai-resource-prompt-dialog[open]').waitFor();
    assert.equal(await page.locator('#ai-resource-prompt-title').textContent(), scope === 'music' ? '音乐推荐提示词' : '热点推荐提示词');
    await page.locator('#ai-resource-prompt').fill(text);
    await page.locator(save ? '#ai-resource-prompt-save' : '#ai-resource-prompt-cancel').click();
    await page.waitForFunction(() => !document.querySelector('#ai-resource-prompt-dialog').open);
  }
  async function switchDraft(id) {
    await page.locator('#open-drafts').click();
    await page.locator(`#draft-list [data-draft-id="${id}"] .draft-item`).click();
    await page.waitForFunction(id => __aiUI.state.activeDraftId === id, id);
    await openAI();
  }
  const lookupCounts = () => page.evaluate(() => ({
    topics: __aiUI.requests.filter(item => new URL(item.url).pathname === '/aweme/v1/search/challengesug/').length,
    account: __aiUI.requests.filter(item => new URL(item.url).pathname === '/web/api/media/user/info/').length,
    session: __aiUI.messages.filter(item => ['session.identify', 'session.login'].includes(item.op)).length,
  }));
  const requestPaths = start => page.evaluate(start => __aiUI.requests.slice(start).map(item => new URL(item.url).pathname), start);
  const requestCount = () => page.evaluate(() => __aiUI.requests.length);

  await page.goto(origin);
  await page.waitForFunction(() => document.body.dataset.phase === 'editing' && document.querySelectorAll('#studio-gallery .studio-gallery-image').length === 8);
  await connect();
  assert.equal(await page.locator('.preview-column').isVisible(), true, 'normal editing shows the publishing preview');
  await openAI();
  assert.equal(await page.locator('#douyin-preview').count(), 1, 'preview container remains available for returning to normal editing');
  assert.equal(await page.locator('.preview-column').isHidden(), true, 'AI uses the side column in place of the publishing preview');
  assert.equal(await page.locator('#ai-dialog').evaluate(node => node.tagName), 'SECTION', 'AI work input is part of the workspace, not a modal');
  assert.equal(await page.locator('#ai-use-images').isChecked(), false);
  assert.equal(await page.locator('#ai-image-section').isHidden(), true);
  const beforeGenerationLookups = await lookupCounts();
  await generate();
  assert.deepEqual(model.calls.find(item => item.phase === 'analyze').assetIds, [], 'images stay opt-in');
  assert.equal(await page.locator('#ai-apply-location').isChecked(), false);
  assert.equal(await page.locator('#ai-apply-music').isChecked(), false);
  assert.match(await page.locator('#ai-existing-location').textContent(), /手动选择的位置/);
  assert.match(await page.locator('#ai-existing-music').textContent(), /手动选择的音乐/);
  assert.equal(await page.locator('#ai-result-activity').textContent(), '官方摄影活动');
  assert.match(await page.locator('#ai-activity-reason').textContent(), /#活动摄影话题/);
  assert.equal(await page.locator('#ai-result-hotspot').textContent(), '山野徒步发现新风景');
  assert.deepEqual(await lookupCounts(), beforeGenerationLookups, 'generation cannot add account checks or login operations');

  // 作品信息位于右栏滚动区首项，与建议一起滚动；栏头和底部操作保持固定。
  await page.setViewportSize({width: 1280, height: 740});
  await page.evaluate(() => { document.querySelector('.ai-suggestions-scroll').scrollTop = 0; });
  const layout = await page.evaluate(() => {
    const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {left: r.left, right: r.right, top: r.top, bottom: r.bottom}; };
    return {input: box('#ai-dialog'), editor: box('.editor-column'), suggestions: box('#ai-suggestions'), heading: box('.ai-suggestions-heading'), footer: box('.ai-suggestions-footer')};
  });
  assert.equal(await page.locator('.ai-suggestions-scroll').evaluate(node => node.firstElementChild.id), 'ai-dialog', 'work information starts the AI scroll area');
  assert.ok(layout.input.left >= layout.suggestions.left && layout.input.right <= layout.suggestions.right, 'work information stays within the right column');
  assert.ok(layout.input.top >= layout.heading.bottom && Math.abs(layout.editor.top - layout.suggestions.top) <= 1, 'editor and AI columns align at the top');
  assert.equal(await page.locator('#ai-input-body').isVisible(), true, 'work information starts expanded');
  assert.equal(await page.locator('#ai-toggle-input').getAttribute('aria-expanded'), 'true');
  const scrollPositions = () => page.evaluate(() => ({editor: document.querySelector('.editor-scroll').scrollTop, ai: document.querySelector('.ai-suggestions-scroll').scrollTop}));
  await page.evaluate(() => { document.querySelector('.editor-scroll').scrollTop = 100; document.querySelector('.ai-suggestions-scroll').scrollTop = 0; });
  const beforeScroll = await scrollPositions(), aiBounds = await page.locator('.ai-suggestions-scroll').boundingBox();
  await page.mouse.move(aiBounds.x + 6, aiBounds.y + 40); await page.mouse.wheel(0, 260);
  await page.waitForFunction(() => document.querySelector('.ai-suggestions-scroll').scrollTop > 0);
  assert.equal((await scrollPositions()).editor, beforeScroll.editor);
  const afterScroll = await page.evaluate(() => ({input: document.querySelector('#ai-dialog').getBoundingClientRect().top, heading: document.querySelector('.ai-suggestions-heading').getBoundingClientRect().top, footer: document.querySelector('.ai-suggestions-footer').getBoundingClientRect().top}));
  assert.ok(afterScroll.input < layout.input.top, 'work information scrolls together with AI suggestions');
  assert.equal(afterScroll.heading, layout.heading.top); assert.equal(afterScroll.footer, layout.footer.top);
  const aiPosition = (await scrollPositions()).ai, editorBounds = await page.locator('.editor-scroll').boundingBox();
  await page.mouse.move(editorBounds.x + 12, editorBounds.y + 40); await page.mouse.wheel(0, 240);
  await page.waitForFunction(position => document.querySelector('.editor-scroll').scrollTop > position, beforeScroll.editor);
  assert.equal((await scrollPositions()).ai, aiPosition);
  await page.setViewportSize({width: 1280, height: 980});

  for (const key of ['music', 'hotspot']) {
    const placement = await page.locator('#ai-edit-' + key + '-prompt').evaluate((node, key) => {
      const action = document.querySelector('#ai-regenerate-' + key), a = action.getBoundingClientRect(), b = node.getBoundingClientRect();
      return {sameParent: action.parentElement === node.parentElement, preceding: node.previousElementSibling === action, gap: b.left - a.right, centerDelta: Math.abs((a.top + a.bottom - b.top - b.bottom) / 2)};
    }, key);
    assert.ok(placement.sameParent && placement.preceding && placement.gap >= 0 && placement.gap < 24 && placement.centerDelta <= 1, 'pencil belongs immediately beside the corresponding action');
  }
  await page.evaluate(() => { for (const node of document.querySelectorAll('.editor-scroll, .ai-suggestions-scroll')) node.scrollTop = 0; });
  await page.screenshot({path: output + 'studio-ai-workspace.png'});

  // 提示词弹窗保存、取消和清空只改本草稿偏好，绝不隐式调用模型或丢失已完成建议。
  const beforePrompts = model.calls.length;
  await promptEditor('music', '优先纯音乐，不要人声。');
  await page.waitForFunction(() => __aiUI.state.drafts.find(item => item.id === 'ai-draft').aiResourcePrompts?.music === '优先纯音乐，不要人声。');
  await promptEditor('music', '这次取消不保存', false);
  assert.equal((await draft()).aiResourcePrompts?.music, '优先纯音乐，不要人声。');
  await promptEditor('hotspot', '只选择与自然风景直接相关的热点。');
  await page.waitForFunction(() => __aiUI.state.drafts.find(item => item.id === 'ai-draft').aiResourcePrompts?.hotspot?.includes('自然风景'));
  assert.equal(model.calls.length, beforePrompts);
  await page.locator('#ai-edit-music-prompt').click();
  const locked = await scrollPositions();
  await page.mouse.move(5, 500); await page.mouse.wheel(0, 300); await pauseFrames();
  assert.deepEqual(await scrollPositions(), locked, 'prompt modal locks the underlying columns');
  await page.screenshot({path: output + 'studio-ai-prompt-dialog.png'});
  await page.locator('#ai-resource-prompt-cancel').click();
  const closedTitle = await page.locator('#ai-result-title').textContent();
  await page.locator('#ai-close').click();
  assert.equal(await page.locator('.preview-column').isVisible(), true, 'closing AI restores the preview');
  assert.equal(await page.locator('.studio-phone-title').textContent(), await page.locator('#title').inputValue());
  await openAI();
  assert.equal(await page.locator('.preview-column').isHidden(), true);
  assert.equal(await page.locator('#ai-result-title').textContent(), closedTitle);
  assert.equal(await page.locator('#ai-result').isVisible(), true);
  assert.equal(model.calls.length, beforePrompts, 'closing and reopening preserves completed suggestions without model calls');

  // 修改音乐偏好后只刷新音乐；热点单项刷新只请求热点，旧文案和其他推荐保持不变。
  model.musicQuery = '独立纯音乐查询';
  let callStart = model.calls.length, platformStart = await requestCount();
  const copyBeforeRegenerate = await page.locator('#ai-result-description').textContent();
  await regenerate('music');
  const musicCalls = model.calls.slice(callStart);
  assert.deepEqual(musicCalls.map(item => item.phase), ['analyze', 'match']);
  assert.ok(musicCalls.some(item => JSON.stringify(item).includes('优先纯音乐，不要人声。')));
  assert.equal(musicCalls.find(item => item.phase === 'match').candidates.locations.length, 0);
  assert.equal((await requestPaths(platformStart)).some(path => /activity|hotspot|search\/poi/.test(path)), false);
  assert.equal(await page.locator('#ai-result-description').textContent(), copyBeforeRegenerate);
  callStart = model.calls.length; platformStart = await requestCount();
  await regenerate('hotspot');
  assert.deepEqual(model.calls.slice(callStart).map(item => item.phase), ['select']);
  assert.match(model.calls.at(-1).prompt, /只选择与自然风景直接相关/);
  assert.equal((await requestPaths(platformStart)).every(path => path === '/aweme/v1/hotspot/recommend/'), true);
  assert.equal(await page.locator('#ai-result-description').textContent(), copyBeforeRegenerate);
  await promptEditor('music', '');
  await page.waitForFunction(() => !__aiUI.state.drafts.find(item => item.id === 'ai-draft').aiResourcePrompts?.music);
  await promptEditor('music', '优先纯音乐，不要人声。');
  await switchDraft('other-ai-draft'); await generate();
  await page.locator('#ai-edit-music-prompt').click();
  assert.equal(await page.locator('#ai-resource-prompt').inputValue(), '', 'custom prompt does not bleed into another draft');
  await page.locator('#ai-resource-prompt-cancel').click();
  await switchDraft('ai-draft'); await generate();
  await page.locator('#ai-edit-music-prompt').click();
  assert.equal(await page.locator('#ai-resource-prompt').inputValue(), '优先纯音乐，不要人声。');
  await page.locator('#ai-resource-prompt-cancel').click();

  // 正文首图原始拍摄日期优先于修图/文件时间；只应用正文保留手选资源并绑定品牌和日期。
  await generate(); await selectOnly(['copy']);
  const beforeCopyEdit = model.calls.length;
  await page.locator('#ai-edit-copy').click();
  await page.locator('#ai-copy-title').fill('取消的标题');
  await page.locator('#ai-copy-cancel').click();
  assert.equal(await page.locator('#ai-result-title').textContent(), '湖边的好时光');
  await page.locator('#ai-edit-copy').click();
  await page.locator('#ai-copy-title').fill('湖边的一段慢时光');
  await page.locator('#ai-copy-save').click();
  assert.equal(await page.locator('#ai-result-title').textContent(), '湖边的一段慢时光');
  assert.equal(model.calls.length, beforeCopyEdit, 'editing a suggestion is local');
  const beforeCopyApply = await lookupCounts();
  await applySelected();
  let saved = await draft();
  assert.equal(saved.title, '湖边的一段慢时光'); assert.equal(saved.music.id, '9002'); assert.equal(saved.location.id, '9001');
  assert.match(saved.description, /^#有序图库\n/); assert.match(saved.description, /\n#20190101$/);
  assert.deepEqual(saved.topics, [{id: '0', name: '有序图库'}, {id: '0', name: '20190101'}]);
  assert.deepEqual(await lookupCounts(), beforeCopyApply, 'local copy application adds no account/topic calls');
  assert.deepEqual(await page.locator('.studio-description-entity[data-kind=topic]').allTextContents(), ['#有序图库', '#20190101']);
  await page.locator('#ai-close').click();
  assert.equal(await page.locator('.preview-column').isVisible(), true);
  assert.equal(await page.locator('.studio-phone-title').textContent(), saved.title, 'restored preview shows applied AI title');
  assert.equal(await page.locator('.studio-phone-description').textContent(), saved.description, 'restored preview shows applied AI copy');
  await page.screenshot({path: output + 'studio-ai-applied-preview.png'});
  await openAI();

  // 真实活动详情中的精确话题 ID 与选中热点一起落入草稿，未勾选正文维持原文。
  await generate(); await selectOnly(['activity', 'hotspot']);
  const activityCopy = (await draft()).description, proposedHotspot = await page.locator('#ai-result-hotspot').textContent();
  await applySelected(); saved = await draft();
  assert.deepEqual(saved.activities, [{id: '101', name: '官方摄影活动', topic: {id: '7655295256916658211', name: '活动摄影话题'}}]);
  assert.ok(saved.topics.some(item => item.id === '7655295256916658211' && item.name === '活动摄影话题'));
  assert.equal(saved.description.replace(/\n#活动摄影话题/u, ''), activityCopy); assert.match(saved.description, /#活动摄影话题/);
  assert.equal(saved.hotspot, proposedHotspot);
  model.selectNone.add('activity'); model.selectNone.add('hotspot');
  await generate();
  assert.equal(await page.locator('#ai-result-activity').textContent(), '不参加活动');
  assert.equal(await page.locator('#ai-result-hotspot').textContent(), '不关联热点');
  assert.equal(await page.locator('#ai-apply-activity').isChecked(), false, 'existing association is not removed automatically');
  assert.equal(await page.locator('#ai-apply-hotspot').isChecked(), false);
  await selectOnly(['activity', 'hotspot']); await applySelected(); saved = await draft();
  assert.deepEqual(saved.activities, []); assert.equal(saved.hotspot, '');
  assert.doesNotMatch(saved.description, /#活动摄影话题/); assert.ok(saved.description.includes('沿着湖边慢慢走'));
  model.selectNone.clear();

  // 图片分析明确勾选，最多六张；缩略图圈保持在右下且不覆盖文件名。
  await page.locator('#ai-use-images').check();
  assert.equal(await page.locator('.ai-image-toggle[aria-pressed=true]').count(), 1);
  const metrics = await page.locator('.ai-image-card').first().evaluate(card => {
    const frame = card.querySelector('.ai-image-frame').getBoundingClientRect(), toggle = card.querySelector('button').getBoundingClientRect(), name = card.querySelector('.ai-image-name').getBoundingClientRect();
    return {right: frame.right - toggle.right, bottom: frame.bottom - toggle.bottom, overlapsName: toggle.bottom > name.top, radius: getComputedStyle(card.querySelector('.ai-image-circle')).borderRadius};
  });
  assert.ok(metrics.right >= 0 && metrics.right <= 8 && metrics.bottom >= 0 && metrics.bottom <= 8);
  assert.equal(metrics.overlapsName, false); assert.equal(metrics.radius, '50%');
  for (let index = 1; index < 6; index++) await page.locator('.ai-image-toggle').nth(index).click();
  await page.locator('.ai-image-toggle').nth(6).click();
  assert.equal(await page.locator('.ai-image-toggle[aria-pressed=true]').count(), 6);
  await page.locator('#ai-context').fill('杭州西湖傍晚散步，自然克制的摄影记录');
  await page.waitForFunction(() => __aiUI.state.drafts.find(item => item.id === 'ai-draft').aiContext === '杭州西湖傍晚散步，自然克制的摄影记录');
  // 收起只改变展示；生成任务、已填写内容和六张勾选图片继续保留。
  model.hold = 'analyze';
  const waitingForAnalysis = new Promise(resolve => { model.onHeld = resolve; });
  await page.locator('#ai-generate').click(); await waitingForAnalysis;
  const callsBeforeCollapse = model.calls.length;
  await page.locator('#ai-toggle-input').click();
  assert.equal(await page.locator('#ai-input-body').isHidden(), true);
  assert.equal(await page.locator('#ai-toggle-input').getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('#ai-status').isVisible(), true, 'generation status remains visible when work information is collapsed');
  assert.equal(await page.locator('#ai-context').inputValue(), '杭州西湖傍晚散步，自然克制的摄影记录');
  assert.equal(await page.locator('.ai-image-toggle[aria-pressed=true]').count(), 6);
  assert.equal(await page.locator('#ai-generate').isDisabled(), true, 'collapsing does not cancel generation');
  await page.screenshot({path: output + 'studio-ai-collapsed.png'});
  await page.locator('#ai-toggle-input').click();
  assert.equal(await page.locator('#ai-input-body').isVisible(), true);
  assert.equal(await page.locator('#ai-toggle-input').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('#ai-cancel').isVisible(), true);
  assert.equal(await page.locator('#ai-use-images').isChecked(), true);
  assert.equal(await page.locator('.ai-image-toggle[aria-pressed=true]').count(), 6);
  assert.equal(model.calls.length, callsBeforeCollapse, 'collapse and expand do not issue extra requests');
  model.hold = ''; for (const finish of model.pending.splice(0)) finish();
  await page.waitForFunction(() => !document.querySelector('#ai-result').hidden && !document.querySelector('#ai-generate').disabled);
  const selectedAnalysis = model.calls.filter(item => item.phase === 'analyze').at(-1);
  assert.deepEqual(selectedAnalysis.assetIds, ['fixture-1', 'fixture-2', 'fixture-3', 'fixture-4', 'fixture-5', 'fixture-6']);
  assert.equal(JSON.parse(selectedAnalysis.context).dateTag, '#20190101');
  assert.equal(JSON.parse(selectedAnalysis.context).directoryName, '2024-02-29 杭州西湖');
  assert.equal(model.calls.some(call => call.context?.includes('/private/synthetic') || call.context?.includes('synthetic-private') || call.context?.includes('rawFields')), false);
  await page.locator('#ai-use-images').uncheck();
  await page.reload(); await connect(); await openAI();
  assert.equal(await page.locator('#ai-context').inputValue(), '杭州西湖傍晚散步，自然克制的摄影记录');
  assert.equal(await page.locator('#ai-use-images').isChecked(), false);
  assert.equal((await draft()).aiResourcePrompts?.music, '优先纯音乐，不要人声。');

  // 部分失败留在对应项，已有文案可用；重试不会重复完整分析。
  model.fail = 'match'; await generate();
  assert.match(await page.locator('#ai-music-reason').textContent(), /合成 AI 请求失败/);
  assert.equal(await page.locator('#ai-apply-copy').isChecked(), true);
  assert.equal(await page.locator('#ai-apply-music').isDisabled(), true);
  const analysesBeforeRetry = model.calls.filter(item => item.phase === 'analyze').length;
  model.fail = ''; await page.locator('#ai-retry-resources').click();
  await page.waitForFunction(() => !document.querySelector('#ai-generate').disabled && !document.querySelector('#ai-apply-location').disabled);
  assert.equal(model.calls.filter(item => item.phase === 'analyze').length, analysesBeforeRetry);

  // 完成的公共建议换号后直接可用；旧账号音乐/活动只需分别更新，公共操作不触发隐式核验。
  const publicSuggestions = await page.evaluate(() => Object.fromEntries(['title', 'description', 'location', 'hotspot'].map(key => [key, document.querySelector('#ai-result-' + key).textContent])));
  const aiCallsBeforeSwitch = model.calls.length;
  await page.evaluate(() => __aiUI.changeAccount()); await connect('另一个合成账号');
  for (const key of ['copy', 'location', 'hotspot']) assert.equal(await page.locator('#ai-apply-' + key).isDisabled(), false);
  for (const key of ['music', 'activity']) assert.equal(await page.locator('#ai-apply-' + key).isDisabled(), true);
  assert.equal(await page.locator('#ai-result-audio').getAttribute('src'), null, '换号后不播放前一个账号的临时音源');
  assert.equal(model.calls.length, aiCallsBeforeSwitch, '换号不自动重新分析作品');
  assert.deepEqual(await page.evaluate(() => Object.fromEntries(['title', 'description', 'location', 'hotspot'].map(key => [key, document.querySelector('#ai-result-' + key).textContent]))), publicSuggestions);
  const beforePublicApply = await lookupCounts();
  await selectOnly(['copy', 'location', 'hotspot']); await applySelected();
  assert.deepEqual(await lookupCounts(), beforePublicApply, '应用已有公共建议不添加账号或话题查询');
  assert.equal((await draft()).location.id, '4401');
  await regenerate('hotspot');
  for (const key of ['music', 'activity']) assert.equal(await page.locator('#ai-apply-' + key).isDisabled(), true, '更新热点不使旧账号音乐或活动恢复资格');
  await regenerate('music');
  assert.equal(await page.locator('#ai-apply-music').isDisabled(), false);
  assert.equal(await page.locator('#ai-apply-activity').isDisabled(), true, '更新音乐仅恢复音乐本项');
  await regenerate('activity');
  assert.equal(await page.locator('#ai-apply-activity').isDisabled(), false);

  // 迟到的模型响应不能跨账号或素材版本恢复应用资格，背景与已保存草稿始终保留。
  async function heldGeneration() {
    model.hold = 'analyze';
    const held = new Promise(resolve => { model.onHeld = resolve; });
    await page.evaluate(() => { __aiUI.ignoreAIAbort = true; });
    await page.locator('#ai-generate').click(); await held;
  }
  async function releaseGeneration() {
    const late = page.waitForResponse(response => response.url().endsWith('/ai/publish-assist'));
    model.hold = ''; for (const finish of model.pending.splice(0)) finish(); await late;
    await page.evaluate(() => { __aiUI.ignoreAIAbort = false; });
    await page.waitForFunction(() => !document.querySelector('#ai-generate').disabled);
  }
  const beforeLate = (await draft()).description;
  await heldGeneration();
  await page.locator('#studio-gallery .studio-gallery-image').nth(1).focus(); await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForFunction(() => __aiUI.state.drafts.find(item => item.id === 'ai-draft').assets[0].id === 'fixture-2');
  await releaseGeneration();
  assert.equal(await page.locator('#ai-apply').isDisabled(), true);
  assert.equal((await draft()).description, beforeLate);
  assert.equal(await page.locator('#ai-context').inputValue(), '杭州西湖傍晚散步，自然克制的摄影记录');
  await generate();
  assert.equal(JSON.parse(model.calls.filter(item => item.phase === 'analyze').at(-1).context).dateTag, '#20210706', 'date fallback follows the new first image directory');
  const completedTitle = await page.locator('#ai-result-title').textContent();
  model.title = '不应接收的迟到标题';
  await heldGeneration(); await page.evaluate(() => __aiUI.changeAccount('789')); await connect('另一个合成账号');
  await releaseGeneration();
  assert.equal(await page.locator('#ai-result-title').textContent(), completedTitle, '迟到响应不能替换换号前已完成的建议');
  assert.equal(await page.locator('#ai-apply-copy').isDisabled(), false);
  assert.equal(await page.locator('#ai-apply-music').isDisabled(), true);
  model.title = '湖边的好时光';
  assert.equal((await draft()).description, beforeLate);
  await generate();

  // 窄屏保持按钮可达，不产生横向溢出。测试全过程不调用登录、上传或发布。
  await page.setViewportSize({width: 560, height: 850});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('#ai-edit-hotspot-prompt').click();
  assert.ok((await page.locator('#ai-resource-prompt-dialog').boundingBox()).width <= 560);
  await page.screenshot({path: output + 'studio-ai-narrow.png'});
  await page.locator('#ai-resource-prompt-cancel').click();
  assert.equal(await page.evaluate(() => __aiUI.messages.some(item => item.op === 'session.login')), false);
  assert.equal(await page.evaluate(() => __aiUI.requests.some(item => item.method !== 'GET' || /upload|create_v2/.test(item.url))), false);
  assert.equal(await page.evaluate(() => JSON.stringify(__aiUI.state).includes('https://media.example.test')), false);
  assert.deepEqual(errors, []);
  console.log('AI UI: collapsible input in AI column, independent scrolling, prompt dialogs and draft scope, single-item regeneration, five-field application, manual-selection preservation, explicit image analysis, date tags, partial retry and account/media races passed');
} finally {
  for (const finish of model.pending.splice(0)) finish();
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
