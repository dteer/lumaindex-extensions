import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium, webkit} from 'playwright';

// 分类整合回归运行真实页面/client/engine；平台和音频仅使用本地合成数据，不上传发布。
const root = fileURLToPath(new URL('../app/', import.meta.url)), output = fileURLToPath(new URL('../output/playwright/', import.meta.url));
const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#d8b69b"/><circle cx="600" cy="130" r="60" fill="#ffe9bd"/><path d="M0 600 300 160 700 550 800 300v300Z" fill="#8b8f82"/></svg>';
const wav = Buffer.alloc(44 + 8000 * 2 * 30);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
await mkdir(output, {recursive: true});
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname.startsWith('/api/v1/assets/music-image/')) { response.setHeader('Content-Type', 'image/svg+xml'); response.end(picture); return; }
  if (url.pathname === '/api/v1/assets/music-image') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({code: 0, data: {id: 'music-image', name: '音乐分类测试.jpg', mediaType: 'image', sizeBytes: 1000}})); return; }
  const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
  try { response.setHeader('Content-Type', ({'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json'})[extname(file)] || 'application/octet-stream'); response.end(await readFile(file)); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browserType = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium;
const browser = await browserType.launch({headless: true, ...(browserType === chromium && process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
try {
  const page = await browser.newPage({viewport: {width: 1240, height: 980}}), errors = [], audioRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  // 使用浏览器真实跨源请求头模拟 CDN：携带本机 Referer 的音频请求必须失败，不联网读取真实曲目。
  await page.route('https://media.example.test/**', async route => {
    const audio = route.request().url().includes('.wav');
    const headers = await route.request().allHeaders();
    if (audio) audioRequests.push(headers);
    if (audio && headers.referer) { await route.fulfill({status: 403, contentType: 'text/html', body: 'referrer rejected'}); return; }
    if (route.request().url().includes('/broken.wav')) { await route.fulfill({status: 200, contentType: 'audio/wav', body: 'invalid media fixture'}); return; }
    await route.fulfill({status: 200, contentType: audio ? 'audio/wav' : 'image/svg+xml', body: audio ? wav : picture});
  });
  await page.addInitScript(({origin}) => {
    const state = {version: 2, activeDraftId: 'music-draft', drafts: [{id: 'music-draft', name: '音乐分类回归', kind: 'image', assets: [{id: 'music-image', name: '音乐分类测试.jpg', kind: 'image'}], title: '分类回归', description: '', topics: [], mentions: [], activities: [], settings: {visibility: 'public', download: 'allow', publishTime: 'now', scheduledAt: '', declarations: []}}]};
    if (new URL(location.href).searchParams.has('savedMusic')) state.drafts[0].music = {id: '100000', name: '推荐曲目1'};
    const profile = {id: 'music-profile', accountId: '123', name: '音乐分类账号', browserSessionAvailable: true, hasCookies: true, expiresAt: '2099-01-01T00:00:00Z'}, runtime = JSON.parse(localStorage.getItem('music-runtime-fixture') || '{}');
    if (new URL(location.href).searchParams.has('missingSavedSource')) delete runtime['luma-studio-selected-music-v1'];
    window.__musicUI = {state, calls: [], hostCalls: [], pendingMusicWrites: [], holdMusicWrite: false, failCatalog: new URL(location.href).searchParams.has('catalogFail'), failPage: '', holdPage: '', pending: [], cancelled: [], expired: false, expireOnInfo: new URL(location.href).searchParams.has('infoExpires'), brokenPreview: new URL(location.href).searchParams.has('brokenPreview')};
    const categories = [{category_id: '0', type: 'recommend', category_name: '推荐'}, {category_id: '0', type: 'rank', category_name: '热门榜'}, {category_id: '0', type: 'fav', category_name: '收藏'}, {category_id: '3', type: 'rank', category_name: '飙升榜'}, {category_id: '4', type: 'rank', category_name: '原创榜'}, {category_id: '5', type: 'category', category_name: '卡点'}, {category_id: '6', type: 'category', category_name: '轻音乐'}, {category_id: '7', type: 'category', category_name: '治愈'}];
    window.pluginContext = {nativeUIAvailable: true, browserEnvironment: {userAgent: 'SyntheticWebKit/1.0', languages: ['zh-CN', 'en-US']}, nativeCapabilities: {browserRequestsVersion: 1, persistentWebsiteSessionsVersion: 1, sessionLoginOptionsVersion: 1, networkHeadersVersion: 1, sessionVersion: 1, sessionProfilesVersion: 1, mediaSelectionVersion: 1}, apiBaseURL: origin + '/api/v1', libraryID: 'music-categories-fixture', frontendState: state};
    const assertInfoParams = url => { if (!/^\d+$/.test(url.searchParams.get('id') || '') || url.searchParams.has('music_id')) throw Error('Music info uses the verified id parameter'); };
    const status = () => ({browserSessionAvailable: !window.__musicUI.expired, hasCookies: true, activeProfileId: profile.id, accountId: profile.accountId, name: profile.name, expiresAt: profile.expiresAt});
    window.webkit = {messageHandlers: {pluginUI: {postMessage: async message => {
      window.__musicUI.hostCalls.push(message.op);
      if (message.op === 'persist') { if (window.__musicUI.failDraftPersist) throw Error('合成草稿保存失败'); window.__musicUI.state = structuredClone(message.value); return {ok: true}; }
      if (['session.status', 'session.identify', 'session.select'].includes(message.op)) return {ok: true, data: status()};
      if (message.op === 'session.list') return {ok: true, data: {items: [profile], activeProfileId: profile.id, hasMore: false, nextOffset: null}};
      if (message.op === 'state.get') return {ok: true, data: message.keys ? Object.fromEntries((Array.isArray(message.keys) ? message.keys : [message.keys]).map(key => [key, runtime[key]])) : runtime};
      if (message.op === 'state.set') {
        if (window.__musicUI.holdMusicWrite) await new Promise(resolve => window.__musicUI.pendingMusicWrites.push(resolve));
        if (window.__musicUI.failMusicPersist) throw Error('合成音乐资料保存失败');
        Object.assign(runtime, message.values); localStorage.setItem('music-runtime-fixture', JSON.stringify(runtime)); return {ok: true, data: {saved: true}};
      }
      if (message.op === 'session.cancel') { window.__musicUI.cancelled.push(message.requestId); return {ok: true, data: {cancelled: true}}; }
      if (message.op !== 'browser.request') throw Error('Unexpected operation: ' + message.op);
      const url = new URL(message.url); window.__musicUI.calls.push({path: url.pathname, params: Object.fromEntries(url.searchParams), method: message.method});
      let data;
      if (url.pathname === '/web/api/media/user/info/') data = {status_code: 0, user: {uid: '123', nickname: profile.name}};
      else if (url.pathname === '/web/api/media/activity/get/') data = {status_code: 0, activity_list: []};
      else if (url.pathname === '/aweme/v3/user_declaration/suggestion/') data = {status_code: 0, data: {block_type: 0, options: []}};
      else if (url.pathname === '/web/api/media/music/category') data = window.__musicUI.failCatalog ? {status_code: 1} : {status_code: 0, categories};
      else if (url.pathname === '/web/api/media/music/info/') {
        assertInfoParams(url);
        if (window.__musicUI.expireOnInfo) {
          window.__musicUI.expired = true;
          return {ok: false, error: {code: 'SESSION_EXPIRED', message: '账号离线，需要重新登录。'}};
        }
        // 官方详情只返回身份/名称/封面，音源和时长必须来自此前实际选曲记录。
        data = {status_code: 0, music_id: url.searchParams.get('id'), music_name: '平台更新后的原声名称', music_author: '合成作者', cover_url: 'https://media.example.test/cover.svg'};
      } else if (url.pathname === '/web/api/media/music/list') {
        const type = url.searchParams.get('type'), id = url.searchParams.get('category_id'), cursor = url.searchParams.get('cursor');
        const key = `${type}:${id}:${cursor}`, index = categories.findIndex(item => item.type === type && item.category_id === id);
        if (index < 0) throw Error('Synthetic category must match actual catalog');
        if (window.__musicUI.holdPage === key) await new Promise(resolve => window.__musicUI.pending.push(resolve));
        if (window.__musicUI.failPage === key) data = {status_code: 1};
        else data = {status_code: 0, songs: type === 'fav' ? [] : Array.from({length: id === '6' ? cursor === '0' ? 1 : cursor === '20' ? 0 : 20 : 20}, (_, item) => ({music_id: String(100000 + index * 10000 + Number(cursor) * 10 + item), music_name: `${categories[index].category_name}曲目${Number(cursor) + item + 1}`, music_author: '合成音乐人', duration: 30, user_count: 1234, cover_url: 'https://media.example.test/cover.svg', play_url: `https://media.example.test/song.wav?id=${index}-${item}`})), has_more: type !== 'fav' && (id === '6' ? cursor !== '40' : cursor === '0') ? 1 : 0, cursor: cursor === '0' ? '20' : cursor === '20' ? '40' : '60'};
        if (window.__musicUI.brokenPreview && key === 'recommend:0:0' && data.songs?.length) {
          const hasResolved = window.__musicUI.calls.some(call => call.path === '/web/api/media/music/info/');
          data.songs[0].play_url = `https://media.example.test/${hasResolved ? 'refreshed' : 'broken'}.wav`;
        }
      } else if (url.pathname === '/web/api/media/aweme/search/post/auth') data = {status_code: 0, signature: 'synthetic-category-search-grant'};
      else if (url.origin === 'https://tsearch.amemv.com' && url.pathname === '/openapi/aweme/v1/music/search/') data = {status_code: 0, music: [{id_str: '900001', title: '关键词搜索结果', author: '搜索作者', duration: 30, play_url: {url_list: ['https://media.example.test/search.wav']}}], has_more: 0};
      else throw Error('Unexpected platform endpoint: ' + url.pathname);
      return {ok: true, data: {status: 200, headers: {'content-type': 'application/json'}, body: JSON.stringify(data)}};
    }}}};
  }, {origin});
  // 通过真实会话检查和音乐入口打开抽屉，分类能力由平台 engine 提供。
  async function open() {
    await page.locator('#account-menu summary').click(); await page.locator('#connect').click();
    await page.locator('#connection-label').filter({hasText: '音乐分类账号'}).waitFor();
    await page.locator('#account-menu summary').click(); await page.locator('#search-music').click();
  }
  const tab = name => page.getByRole('tab', {name, exact: true});
  const calls = () => page.evaluate(() => window.__musicUI.calls.filter(item => item.path === '/web/api/media/music/list'));
  // 近底预加载继续当前分类的下一位置，不能借用另一分类的游标。
  async function nextPage() {
    await page.locator('#search-results').evaluate(list => { list.scrollTop = list.scrollHeight - list.clientHeight * 1.5; list.dispatchEvent(new Event('scroll')); });
  }
  await page.goto(origin); await open();
  await page.waitForFunction(() => document.querySelectorAll('.studio-music-row').length === 20);
  assert.equal(await page.locator('.studio-music-category').count(), 8);
  assert.equal(await tab('推荐').getAttribute('aria-selected'), 'true');
  assert.equal((await calls())[0].params.type, 'recommend'); assert.equal((await calls())[0].params.category_id, '0');
  assert.equal(await page.evaluate(() => window.__musicUI.calls.filter(item => item.path === '/web/api/media/music/category').length), 1);
  const style = await tab('推荐').evaluate(button => ({weight: getComputedStyle(button).fontWeight, color: getComputedStyle(button).color, underline: getComputedStyle(button, '::after').height}));
  assert.deepEqual(style, {weight: '600', color: 'rgb(22, 24, 35)', underline: '3px'});
  assert.equal(await page.getByRole('button', {name: '上一组音乐分类', exact: true}).isDisabled(), true);
  await page.getByRole('button', {name: '下一组音乐分类', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('.studio-music-category-list').scrollLeft > 40);
  assert.equal(await page.getByRole('button', {name: '上一组音乐分类', exact: true}).isDisabled(), false);
  await page.getByRole('button', {name: '上一组音乐分类', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('.studio-music-category-list').scrollLeft < 2);
  await page.screenshot({path: output + 'studio-music-categories.png'});

  // 同 ID 的推荐/热门分类分别查询；切分类保持试听，不自动选择作品配乐。
  await page.locator('.studio-music-listen').first().click();
  await page.waitForFunction(() => !document.querySelector('#music-player').paused && document.querySelector('#music-player').readyState >= 2);
  assert.ok(audioRequests.length > 0, 'playback must load a real cross-origin audio request');
  assert.ok(audioRequests.every(headers => !headers.referer), 'production page must omit the local host Referer from media requests');
  const source = await page.locator('#music-player').getAttribute('src');
  await tab('热门榜').click(); await page.locator('.studio-music-name').first().filter({hasText: '热门榜曲目1'}).waitFor();
  assert.equal(await page.locator('#music-player').getAttribute('src'), source);
  assert.equal(await page.locator('#music-player').evaluate(audio => audio.paused), false);
  assert.equal((await calls()).at(-1).params.type, 'rank'); assert.equal((await calls()).at(-1).params.cursor, '0');
  await nextPage(); await page.waitForFunction(() => document.querySelectorAll('.studio-music-row').length === 40);
  assert.equal((await calls()).at(-1).params.cursor, '20');
  await tab('推荐').click(); assert.equal(await page.locator('.studio-music-row').count(), 20);
  await nextPage(); await page.waitForFunction(() => document.querySelectorAll('.studio-music-row').length === 40);
  assert.equal((await calls()).at(-1).params.type, 'recommend'); assert.equal((await calls()).at(-1).params.cursor, '20');
  const beforeCached = (await calls()).length;
  await tab('热门榜').click(); assert.equal(await page.locator('.studio-music-row').count(), 40); assert.equal((await calls()).length, beforeCached);

  // 关键词不携带分类；清空后恢复此前类别和已经加载的页面。
  await page.locator('#search-query').fill('夜'); await page.locator('.studio-music-name').filter({hasText: '关键词搜索结果'}).waitFor();
  assert.equal(await page.locator('.studio-music-category[aria-selected=true]').count(), 0);
  const keyword = await page.evaluate(() => window.__musicUI.calls.find(item => item.path === '/openapi/aweme/v1/music/search/').params);
  assert.equal(keyword.keyword, '夜'); assert.equal(keyword.category_id, undefined); assert.equal(keyword.type, undefined);
  await page.locator('#search-query').fill('');
  await page.locator('.studio-music-name').first().filter({hasText: '热门榜曲目1'}).waitFor();
  assert.equal(await tab('热门榜').getAttribute('aria-selected'), 'true'); assert.equal(await page.locator('.studio-music-row').count(), 40);

  // 分类旧请求忽略取消并迟到，也不能覆盖后选分类；失败页保留位置，只由显式重试继续。
  await page.evaluate(() => { window.__musicUI.holdPage = 'rank:3:0'; });
  await tab('飙升榜').click(); await page.waitForFunction(() => window.__musicUI.pending.length === 1);
  await tab('原创榜').click(); await page.locator('.studio-music-name').first().filter({hasText: '原创榜曲目1'}).waitFor();
  await page.evaluate(() => { window.__musicUI.holdPage = ''; for (const finish of window.__musicUI.pending.splice(0)) finish(); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(await tab('原创榜').getAttribute('aria-selected'), 'true'); assert.match(await page.locator('.studio-music-name').first().textContent(), /^原创榜/);
  assert.ok(await page.evaluate(() => window.__musicUI.cancelled.length > 0));
  await page.evaluate(() => { window.__musicUI.failPage = 'rank:4:20'; });
  await nextPage(); await page.locator('#search-more').filter({hasText: '重试'}).waitFor();
  assert.equal(await page.locator('.studio-music-row').count(), 20);
  await page.evaluate(() => { window.__musicUI.failPage = ''; });
  await page.locator('#search-more').click(); await page.waitForFunction(() => document.querySelectorAll('.studio-music-row').length === 40);
  const retries = (await calls()).filter(item => item.params.type === 'rank' && item.params.category_id === '4' && item.params.cursor === '20');
  assert.equal(retries.length, 2);
  // 短首页会自动续载；续页为空仍继续，重复滚动不能重入相同游标。
  await page.evaluate(() => { window.__musicUI.holdPage = 'category:6:20'; });
  await tab('轻音乐').click(); await page.waitForFunction(() => window.__musicUI.pending.length === 1);
  assert.equal(await page.locator('.studio-music-row').count(), 1);
  await nextPage(); await nextPage();
  assert.equal((await calls()).filter(item => item.params.category_id === '6' && item.params.cursor === '20').length, 1);
  await page.evaluate(() => { window.__musicUI.holdPage = ''; for (const finish of window.__musicUI.pending.splice(0)) finish(); });
  await page.waitForFunction(() => document.querySelectorAll('.studio-music-row').length === 21);
  assert.deepEqual((await calls()).filter(item => item.params.category_id === '6').map(item => item.params.cursor), ['0', '20', '40']);
  await tab('收藏').click(); await page.locator('#search-message').filter({hasText: '没有找到匹配结果'}).waitFor();
  assert.equal(await page.locator('.studio-music-row').count(), 0); assert.equal(await tab('收藏').getAttribute('aria-selected'), 'true');
  await page.setViewportSize({width: 420, height: 850});
  assert.equal(await page.locator('#search-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth), true);
  await page.screenshot({path: output + 'studio-music-categories-narrow.png'});

  // 关闭后重新载入故障目录，错误提供单独重试；没有凭空的固定分类或结果。
  await page.goto(origin + '/?catalogFail=1'); await open();
  await page.locator('.studio-music-category-retry').waitFor();
  assert.equal(await page.locator('.studio-music-category').count(), 0);
  assert.equal(await page.locator('.studio-music-row').count(), 0);
  await page.evaluate(() => { window.__musicUI.failCatalog = false; });
  await page.locator('.studio-music-category-retry').click();
  await page.waitForFunction(() => document.querySelectorAll('.studio-music-row').length === 20);
  assert.equal(await tab('推荐').getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => window.__musicUI.calls.filter(item => item.path === '/web/api/media/music/category').length), 2);
  await page.evaluate(() => {
    window.__musicUI.failDraftPersist = true;
    const title = document.querySelector('#title'); title.value = '待保存的作品修改'; title.dispatchEvent(new Event('input', {bubbles: true}));
  });
  await page.locator('.studio-music-row').first().hover(); await page.locator('.studio-music-use').first().click();
  await page.locator('#search-message').filter({hasText: '草稿保存失败'}).waitFor();
  assert.equal(await page.evaluate(() => window.__musicUI.state.drafts[0].music?.id || null), null);
  await page.evaluate(() => { window.__musicUI.failDraftPersist = false; window.__musicUI.failMusicPersist = true; });
  await page.locator('.studio-music-row').first().hover(); await page.locator('.studio-music-use').first().click();
  await page.locator('#search-message').filter({hasText: '保存失败'}).waitFor();
  assert.equal(await page.evaluate(() => window.__musicUI.state.drafts[0].music?.id || null), null);
  assert.equal(await page.locator('#search-dialog').evaluate(dialog => dialog.open), true);
  await page.evaluate(() => { window.__musicUI.failMusicPersist = false; });
  await page.locator('.studio-music-use').first().click();
  await page.waitForFunction(() => !document.querySelector('#search-dialog').open && window.__musicUI.state.drafts[0].music?.id === '100000');
  assert.equal(await page.locator('#music-player').evaluate(audio => audio.paused), true);
  assert.equal(await page.evaluate(() => window.__musicUI.calls.some(item => item.method !== 'GET')), false);
  // 刚选中的列表歌曲可能不出现在关键词搜索中；试听直接复用真实候选，不按名称重搜。
  const beforeSelectedPreview = await page.evaluate(() => window.__musicUI.calls.length);
  await page.locator('#preview-music-icon').click();
  await page.waitForFunction(() => !document.querySelector('#music-player').paused && document.querySelector('#music-player').readyState >= 2);
  assert.equal(await page.evaluate(() => window.__musicUI.calls.length), beforeSelectedPreview);
  assert.equal(await page.locator('#music-preview-message').isHidden(), true);
  await page.locator('#preview-music').click();
  // 重新打开的编辑页通过音乐身份读取同账号音源，无需先打开抽屉或查询详情。
  await page.setViewportSize({width: 1240, height: 980});
  await page.goto(origin + '/?savedMusic=1');
  await page.locator('#music-name').filter({hasText: '推荐曲目1'}).waitFor();
  await page.waitForFunction(() => document.querySelector('#account-select')?.value === 'music-profile');
  assert.equal(await page.locator('#preview-music').isVisible(), true);
  assert.equal(await page.evaluate(() => window.__musicUI.calls.filter(call => /\/music\/|\/user\/info\//.test(call.path)).length), 0, 'restoring selected music does not fetch music or recheck the account');
  await page.locator('#preview-music-icon').click();
  await page.waitForFunction(() => !document.querySelector('#music-player').paused && document.querySelector('#music-player').readyState >= 2);
  assert.equal(await page.locator('#preview-music').textContent(), '暂停');
  assert.equal(await page.locator('#search-dialog').evaluate(dialog => dialog.open), false);
  const restoredInfo = await page.evaluate(() => window.__musicUI.calls.filter(item => item.path === '/web/api/media/music/info/'));
  assert.equal(restoredInfo.length, 0, 'saved audio plays without an info request');
  assert.equal(await page.evaluate(() => window.__musicUI.calls.some(item => item.path === '/openapi/aweme/v1/music/search/')), false);
  assert.deepEqual(await page.evaluate(() => window.__musicUI.state.drafts[0].music), {id: '100000', name: '推荐曲目1'});
  await page.locator('#preview-music').click(); assert.equal(await page.locator('#music-player').evaluate(audio => audio.paused), true);
  await page.locator('#preview-music-icon').click();
  await page.waitForFunction(() => !document.querySelector('#music-player').paused);
  assert.equal(await page.evaluate(() => window.__musicUI.calls.filter(item => item.path === '/web/api/media/music/info/').length), 0);
  assert.ok(audioRequests.every(headers => !headers.referer));
  // 详情接口不可用不影响已保存音源；缺少音源必须查询时，账号错误仍直接提示并保留草稿。
  await page.goto(origin + '/?savedMusic=1&infoExpires=1');
  await page.locator('#music-name').filter({hasText: '推荐曲目1'}).waitFor();
  await page.waitForFunction(() => document.querySelector('#account-select')?.value === 'music-profile');
  await page.locator('#preview-music').click();
  await page.waitForFunction(() => !document.querySelector('#music-player').paused && document.querySelector('#music-player').readyState >= 2);
  assert.equal(await page.evaluate(() => window.__musicUI.calls.filter(item => item.path === '/web/api/media/music/info/').length), 0);
  assert.equal(await page.locator('#music-preview-message').isHidden(), true);
  await page.goto(origin + '/?savedMusic=1&infoExpires=1&missingSavedSource=1');
  await page.locator('#music-name').filter({hasText: '推荐曲目1'}).waitFor();
  await page.waitForFunction(() => document.querySelector('#account-select')?.value === 'music-profile');
  await page.locator('#preview-music').click();
  await page.locator('#music-preview-message').filter({hasText: /需要重新登录|账号已变化/}).waitFor();
  assert.equal(await page.locator('#music-player').evaluate(audio => audio.paused), true);
  assert.equal(await page.locator('#preview-music').textContent(), '试听');
  assert.deepEqual(await page.evaluate(() => window.__musicUI.state.drafts[0].music), {id: '100000', name: '推荐曲目1'});
  assert.equal(await page.evaluate(() => window.__musicUI.calls.some(item => item.path === '/openapi/aweme/v1/music/search/')), false);
  await page.locator('.extended-panel').screenshot({path: output + 'studio-saved-music-feedback.png'});
  await page.setViewportSize({width: 420, height: 850});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.locator('.extended-panel').screenshot({path: output + 'studio-saved-music-feedback-narrow.png'});

  // 抽屉单曲真实解码失败后，仅下一次用户点击按原 ID 刷新；同页缓存不可带回失败源。
  await page.setViewportSize({width: 1240, height: 980});
  await page.goto(origin + '/?brokenPreview=1'); await open();
  await page.waitForFunction(() => document.querySelectorAll('.studio-music-row').length === 20);
  const draftBeforeRecovery = await page.evaluate(() => structuredClone(window.__musicUI.state.drafts));
  await page.locator('.studio-music-listen').first().click();
  await page.locator('.studio-music-playback-status').filter({hasText: '请点击重试'}).waitFor();
  assert.equal(await page.locator('#music-player').evaluate(audio => audio.error?.code), 4);
  assert.equal(await page.evaluate(() => window.__musicUI.calls.filter(call => call.path === '/web/api/media/music/info/').length), 0);
  assert.equal((await calls()).length, 1, 'a media failure must not start an automatic platform refresh');
  await page.locator('.studio-music-player-cover').click();
  await page.waitForFunction(() => {
    const audio = document.querySelector('#music-player');
    return audio.src.includes('/refreshed.wav') && !audio.paused && !audio.error && audio.currentTime > 0;
  });
  assert.equal(await page.locator('#music-player').evaluate(audio => audio.duration), 30);
  assert.equal(await page.locator('.studio-music-playback-status').isHidden(), true);
  const refreshInfo = await page.evaluate(() => window.__musicUI.calls.filter(call => call.path === '/web/api/media/music/info/'));
  assert.equal(refreshInfo.length, 1); assert.equal(refreshInfo[0].params.id, '100000');
  assert.equal((await calls()).filter(call => call.params.type === 'recommend' && call.params.cursor === '0').length, 2);
  assert.deepEqual(await page.evaluate(() => window.__musicUI.state.drafts), draftBeforeRecovery);
  await page.locator('.studio-music-player-cover').click();
  await tab('热门榜').click(); await page.locator('.studio-music-name').first().filter({hasText: '热门榜曲目1'}).waitFor();
  await tab('推荐').click();
  assert.equal(await page.locator('.studio-music-row').first().evaluate(row => row.classList.contains('is-current')), true);
  const beforeCachedRetry = await page.evaluate(() => window.__musicUI.calls.length);
  await page.locator('.studio-music-listen').first().click();
  await page.waitForFunction(() => !document.querySelector('#music-player').paused);
  assert.match(await page.locator('#music-player').getAttribute('src'), /\/refreshed\.wav$/);
  assert.equal(await page.evaluate(() => window.__musicUI.calls.length), beforeCachedRetry);
  assert.deepEqual(await page.evaluate(() => window.__musicUI.state.drafts), draftBeforeRecovery);

  // 使用只保存已读取候选；慢本地保存有可见反馈，续页不覆盖状态，完成才应用并关闭。
  await page.goto(origin); await open();
  await page.waitForFunction(() => document.querySelectorAll('.studio-music-row').length === 20);
  await page.evaluate(() => { window.__musicUI.holdMusicWrite = true; });
  const requestsBeforeUse = await page.evaluate(() => window.__musicUI.calls.length);
  await page.locator('.studio-music-row').first().hover(); await page.locator('.studio-music-use').first().click();
  await page.waitForFunction(() => window.__musicUI.pendingMusicWrites.length === 1);
  assert.equal(await page.locator('.studio-music-use').first().textContent(), '保存中…');
  assert.equal(await page.locator('.studio-music-use').first().getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('.studio-music-use:enabled').count(), 0);
  assert.equal(await page.evaluate(() => window.__musicUI.calls.length), requestsBeforeUse, 'using a candidate must not request the platform');
  assert.equal(await page.evaluate(() => window.__musicUI.hostCalls.filter(op => op === 'persist').length), 0, 'a clean draft must not be written before using music');
  assert.equal(await page.evaluate(() => window.__musicUI.state.drafts[0].music || null), null);
  await nextPage(); await page.waitForFunction(() => document.querySelectorAll('.studio-music-row').length === 40);
  assert.equal(await page.locator('#search-message').textContent(), '正在保存配乐…');
  assert.equal(await page.locator('.studio-music-use:enabled').count(), 0);
  await page.evaluate(() => { window.__musicUI.holdMusicWrite = false; window.__musicUI.pendingMusicWrites.splice(0).forEach(finish => finish()); });
  await page.waitForFunction(() => !document.querySelector('#search-dialog').open && window.__musicUI.state.drafts[0].music?.id === '100000');
  assert.equal(await page.evaluate(() => window.__musicUI.hostCalls.filter(op => op === 'persist').length), 1, 'the changed draft is saved once after selection');

  // 关闭等待中的选曲后，迟到的本机保存回执不能改变草稿或重新打开弹窗。
  await page.goto(origin); await open();
  await page.waitForFunction(() => document.querySelectorAll('.studio-music-row').length === 20);
  await page.evaluate(() => { window.__musicUI.holdMusicWrite = true; });
  await page.locator('.studio-music-row').first().hover(); await page.locator('.studio-music-use').first().click();
  await page.waitForFunction(() => window.__musicUI.pendingMusicWrites.length === 1);
  await page.locator('#search-close').click();
  await page.waitForFunction(() => !document.querySelector('#search-dialog').open);
  await page.evaluate(() => { window.__musicUI.holdMusicWrite = false; window.__musicUI.pendingMusicWrites.splice(0).forEach(finish => finish()); });
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 500)));
  assert.equal(await page.evaluate(() => window.__musicUI.state.drafts[0].music || null), null);
  assert.equal(await page.evaluate(() => window.__musicUI.hostCalls.filter(op => op === 'persist').length), 0);
  assert.deepEqual(errors, []);
  console.log('music categories UI: local selection without remote or duplicate draft writes, visible pending state across pagination, close cancellation; failed audio same-ID refresh, cache replacement, saved music restoration, tabs and pagination passed');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
