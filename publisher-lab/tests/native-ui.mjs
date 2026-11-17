import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
const root = fileURLToPath(new URL('../app/', import.meta.url));
const output = fileURLToPath(new URL('../output/playwright/', import.meta.url));
await mkdir(output, {recursive: true});
let assetListRequests = 0;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/api/v1/assets') {
    assetListRequests++;
    const video = url.searchParams.get('mediaClasses')?.includes('video');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({code: 0, data: {items: [{id: video ? 'fixture-video' : 'fixture-image', name: video ? '界面测试视频.mp4' : '界面测试图片.jpg', mediaType: video ? 'video' : 'image'}]}})); return;
  }
  if (url.pathname.startsWith('/api/v1/assets/fixture-image/')) {
    response.setHeader('Content-Type', 'image/svg+xml');
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200"><rect width="900" height="1200" fill="#c9d2d8"/><rect y="740" width="900" height="460" fill="#9dabb1"/><path d="M0 820 270 430 490 760 670 540 900 820Z" fill="#687d87"/><circle cx="660" cy="260" r="80" fill="#eae6d7"/><text x="450" y="1080" text-anchor="middle" fill="#fff" font-family="sans-serif" font-size="34">UI TEST FIXTURE</text></svg>'); return;
  }
  if (url.pathname === '/api/v1/assets/fixture-image') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({code: 0, data: {id: 'fixture-image', name: '界面测试图片.jpg', mediaType: 'image', sizeBytes: 1000}})); return;
  }
  const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
  try { const bytes = await readFile(file); response.setHeader('Content-Type', ({'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json'})[extname(file)] || 'application/octet-stream'); response.end(bytes); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // 账号操作集中在展开菜单中；用真实点击检查菜单入口与收起后的页面空间。
  async function accountMenu(open = true) {
    const menu = page.locator('#account-menu');
    if (await menu.evaluate(node => node.open) !== open) await menu.locator('summary').click();
  }
  // 检查实际编辑首屏的比例，避免功能通过但又堆出多层标题或大块空白。
  async function inspectEditorLayout(width, screenshot) {
    await page.setViewportSize({width, height: 900});
    await page.evaluate(() => scrollTo(0, 0));
    const metrics = await page.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {x: r.x, y: r.y, width: r.width, height: r.height}; };
      return {card: rect('.basic-card'), preview: rect('.preview-column'), description: rect('.description-editor'), cover: rect('.cover-row'),
        overflow: document.documentElement.scrollWidth > innerWidth,
        previewVisible: getComputedStyle(document.querySelector('.preview-column')).display !== 'none',
        tabsVisible: getComputedStyle(document.querySelector('.publish-tabs')).display !== 'none',
        successBannerVisible: !document.querySelector('#connection-banner').hidden};
    });
    assert.equal(metrics.overflow, false, `editor must not overflow at ${width}px`);
    assert.equal(metrics.tabsVisible, false, 'editing starts with the form, not upload tabs');
    assert.equal(metrics.successBannerVisible, false, 'verified account does not leave a persistent banner');
    if (width >= 1200) {
      assert.ok(metrics.card.y >= 40 && metrics.card.y <= 100, `form starts near the compact toolbar: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.card.width >= 650 && metrics.card.width <= 712, `official form width: ${JSON.stringify(metrics)}`);
      assert.equal(metrics.previewVisible, true);
      assert.ok(metrics.preview.width >= 235 && metrics.preview.width <= 245, `official preview width: ${JSON.stringify(metrics)}`);
      assert.ok(Math.abs(metrics.preview.y - metrics.card.y) <= 5, 'preview aligns with the first card');
      assert.ok(metrics.description.height >= 140 && metrics.description.height <= 200, 'description stays compact');
      assert.ok(metrics.cover.height <= 100, 'cover is a compact horizontal field');
    }
    await page.screenshot({path: output + screenshot});
    return metrics;
  }
  await page.addInitScript(({origin}) => {
    window.pluginContext = {nativeUIAvailable: true, nativeCapabilities: {sessionVersion: 1, temporaryFilesVersion: 1, mediaSelectionVersion: 1}, apiBaseURL: origin + '/api/v1', frontendState: {}, libraryID: 'native-ui-fixture'};
    let hasCookies = false; const runtime = {};
    window.__nativeTest = {messages: [], state: {}};
    window.webkit = {messageHandlers: {pluginUI: {postMessage: async message => {
      window.__nativeTest.messages.push(structuredClone(message));
      if (message.op === 'persist') { if (window.__nativeTest.failPersist) throw Error('合成保存失败'); window.__nativeTest.state = structuredClone(message.value); return {ok: true}; }
      if (message.op === 'assets.select') {
        if (window.__nativeTest.holdSelection) return new Promise(resolve => { window.__nativeTest.finishSelection = result => resolve({ok: true, data: result}); });
        return {ok: true, data: {cancelled: false, assetIDs: ['fixture-image']}};
      }
      if (message.op === 'session.status') return {ok: true, data: {hasCookies}};
      if (message.op === 'session.login') { hasCookies = true; return {ok: true, data: {hasCookies}}; }
      if (message.op === 'session.clear') { hasCookies = false; return {ok: true, data: {hasCookies}}; }
      if (message.op === 'state.get') return {ok: true, data: message.keys ? {[message.keys]: runtime[message.keys]} : runtime};
      if (message.op === 'state.set') { Object.assign(runtime, message.values); return {ok: true, data: {saved: true}}; }
      if (message.op === 'session.request') {
        const url = new URL(message.url); let data;
        if (url.pathname === '/web/api/media/user/info/') data = {status_code: 0, user: {uid: '123', nickname: '合成 UI 测试账号'}};
        else if (url.pathname === '/aweme/v1/search/challengesug/') data = {status_code: 0, sug_list: [{cid: '222', cha_name: '测试摄影话题'}]};
        else throw Error('Unexpected platform operation');
        return {ok: true, data: {status: 200, headers: {'content-type': 'application/json'}, body: JSON.stringify(data)}};
      }
      throw Error('Unexpected native op: ' + message.op);
    }}}};
  }, {origin});
  await page.goto(origin);
  await page.getByRole('tab', {name: '发布图文', exact: true}).waitFor();
  assert.equal(await page.getByRole('tab', {name: '发布全景视频', exact: true}).isDisabled(), true);
  assert.equal(await page.getByRole('tab', {name: '发布文章', exact: true}).isDisabled(), true);
  await page.getByRole('tab', {name: '发布视频', exact: true}).click();
  await page.getByRole('button', {name: '选择图库视频', exact: false}).waitFor();
  await page.screenshot({path: output + 'studio-publish-upload-wide.png'});
  await page.getByRole('tab', {name: '发布图文', exact: true}).click();
  await accountMenu();
  await page.getByRole('button', {name: '检查会话', exact: true}).click();
  await page.getByText('请先登录抖音，在官方登录窗口完成扫码或验证。').waitFor();
  assert.equal(await page.evaluate(() => window.__nativeTest.messages.some(x => x.op === 'session.login')), false);
  await accountMenu();
  await page.getByRole('button', {name: '登录抖音', exact: true}).click();
  await page.locator('#connection-label').filter({hasText: '合成 UI 测试账号'}).waitFor();
  await accountMenu();
  assert.equal(await page.getByRole('button', {name: '重新登录', exact: true}).isVisible(), true);
  await accountMenu(false);
  await page.getByRole('button', {name: '选择图库图片', exact: false}).click();
  await page.waitForFunction(() => document.body.dataset.phase === 'editing' && !document.body.classList.contains('busy'));
  assert.equal(await page.locator('#search-dialog').isVisible(), false);
  const selectionStart = await page.evaluate(() => {
    const messages = window.__nativeTest.messages, index = messages.findIndex(item => item.op === 'assets.select');
    return {before: messages[index - 1]?.op, request: messages[index]};
  });
  assert.deepEqual(selectionStart, {before: 'persist', request: {op: 'assets.select', kind: 'image', maximumCount: 35, excludeAssetIDs: []}});
  assert.equal(await page.locator('body').getAttribute('data-phase'), 'editing');
  await page.getByRole('textbox', {name: '标题', exact: false}).fill('原生会话界面测试');
  await page.locator('#choose-cover').click();
  await page.waitForFunction(() => !document.body.classList.contains('busy') && window.__nativeTest.state.drafts[0].cover?.assetId === 'fixture-image');
  assert.equal(await page.evaluate(() => window.__nativeTest.state.drafts[0].assets.length), 1);
  assert.deepEqual(await page.evaluate(() => window.__nativeTest.messages.filter(item => item.op === 'assets.select').at(-1)), {op: 'assets.select', kind: 'image', maximumCount: 1, excludeAssetIDs: []});
  const beforeCancel = await page.evaluate(() => structuredClone(window.__nativeTest.state.drafts[0]));
  await page.evaluate(() => { window.__nativeTest.holdSelection = true; });
  await page.locator('#add-library-media').click();
  await page.waitForFunction(() => typeof window.__nativeTest.finishSelection === 'function');
  assert.equal(await page.locator('#open-drafts').isDisabled(), true);
  assert.equal(await page.locator('#draft-name').isDisabled(), true, 'moved draft name remains locked during selection');
  assert.equal(await page.locator('#prepare').isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.__nativeTest.messages.filter(item => item.op === 'assets.select').at(-1)), {op: 'assets.select', kind: 'image', maximumCount: 34, excludeAssetIDs: ['fixture-image']});
  await page.evaluate(() => { window.__nativeTest.finishSelection({cancelled: true, assetIDs: []}); window.__nativeTest.holdSelection = false; });
  await page.waitForFunction(() => !document.body.classList.contains('busy'));
  assert.deepEqual(await page.evaluate(() => window.__nativeTest.state.drafts[0]), beforeCancel, 'cancel preserves draft, cover and assets');
  await page.getByRole('button', {name: '＃ 添加话题', exact: true}).click();
  await page.locator('#search-query').fill('摄影'); await page.locator('#run-search').click();
  await page.getByText('测试摄影话题', {exact: true}).waitFor();
  await page.locator('#search-close').click();
  await page.getByRole('radio', {name: '好友可见', exact: true}).check();
  await page.getByRole('radio', {name: '不允许保存', exact: true}).check();
  await page.getByRole('radio', {name: '定时发布', exact: true}).check();
  assert.equal(await page.locator('#schedule-fields').isVisible(), true);
  await page.locator('#scheduled-at').fill('2030-06-15T12:00');
  await page.getByRole('button', {name: '保存草稿', exact: true}).click();
  assert.equal(await page.evaluate(() => window.__nativeTest.state.drafts[0].title), '原生会话界面测试');
  assert.deepEqual(await page.evaluate(() => {
    const {visibility, download, publishTime, scheduledAt} = window.__nativeTest.state.drafts[0].settings;
    return {visibility, download, publishTime, scheduledAt};
  }), {visibility: 'friends', download: 'deny', publishTime: 'scheduled', scheduledAt: '2030-06-15T12:00'});
  await page.getByRole('radio', {name: '公开', exact: true}).check();
  await page.getByRole('radio', {name: '允许保存', exact: true}).check();
  await page.getByRole('radio', {name: '立即发布', exact: true}).check();
  assert.equal(await page.locator('#schedule-fields').isVisible(), false);
  assert.equal(await page.locator('#unsupported-declaration').isDisabled(), true);
  await page.locator('#page-notice').waitFor({state: 'hidden', timeout: 7000});
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({path: output + 'studio-native-session-wide.png', fullPage: true});
  const layouts = [];
  layouts.push(await inspectEditorLayout(1440, 'studio-native-session-viewport.png'));
  layouts.push(await inspectEditorLayout(1290, 'studio-native-session-app-width.png'));
  layouts.push(await inspectEditorLayout(960, 'studio-native-session-960.png'));
  await page.setViewportSize({width: 1290, height: 900});
  await page.locator('#description').focus();
  const focusStyle = await page.locator('#description').evaluate(node => {
    const style = getComputedStyle(node);
    return {width: parseFloat(style.outlineWidth), color: style.outlineColor, style: style.outlineStyle};
  });
  const focusRGB = focusStyle.color.match(/\d+/g)?.slice(0, 3).map(Number) || [];
  assert.ok(focusStyle.style === 'none' || focusStyle.width === 0 || (focusRGB.length === 3 && Math.max(...focusRGB) - Math.min(...focusRGB) < 35), 'editor focus does not draw a clipped blue line');
  await page.screenshot({path: output + 'studio-native-session-focus.png'});
  await page.locator('#description').blur();
  await page.setViewportSize({width: 1440, height: 1000});
  await page.locator('#open-drafts').click();
  await page.getByRole('button', {name: '＋ 新建视频', exact: true}).click();
  assert.equal(await page.locator('body').getAttribute('data-phase'), 'upload');
  await page.locator('#open-drafts').click();
  await page.locator('.draft-item').filter({hasText: '图文 · 1 项'}).click();
  assert.equal(await page.locator('#title').inputValue(), '原生会话界面测试', 'drawer switching retains local content');
  await page.setViewportSize({width: 820, height: 850});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({path: output + 'studio-native-session-narrow.png', fullPage: true});
  await page.setViewportSize({width: 560, height: 850});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({path: output + 'studio-publish-mobile.png', fullPage: true});
  await page.locator('#open-media-preview').click();
  await page.locator('.media-preview-dialog[open] .expanded-media img').waitFor();
  const expandedBounds = await page.locator('.media-preview-dialog').boundingBox();
  assert.ok(expandedBounds.width <= 560 && expandedBounds.height <= 850, 'narrow-window media preview remains usable');
  await page.getByRole('button', {name: '关闭素材预览', exact: true}).click();
  await accountMenu();
  await page.locator('#clear-session').click();
  await page.getByText('临时会话已清除，本机草稿仍保留。').waitFor();
  assert.equal(await page.locator('#publish').isDisabled(), true);
  await accountMenu(false);
  const selectionCount = await page.evaluate(() => window.__nativeTest.messages.filter(item => item.op === 'assets.select').length);
  await page.evaluate(() => { window.__nativeTest.failPersist = true; });
  await page.locator('#choose-cover').click();
  await page.getByText('草稿未能保存，暂不离开工作台。请先保存成功后再选择素材。', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => window.__nativeTest.messages.filter(item => item.op === 'assets.select').length), selectionCount);
  await page.evaluate(() => { window.__nativeTest.failPersist = false; window.pluginContext.nativeCapabilities.mediaSelectionVersion = 0; });
  await page.locator('#choose-cover').click();
  await page.getByText('当前 App 尚不支持从来源选择素材，请更新 App 后重新打开工作台。', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => window.__nativeTest.messages.filter(item => item.op === 'assets.select').length), selectionCount);
  assert.equal(await page.locator('#search-dialog').isVisible(), false);
  assert.equal(await page.evaluate(() => window.__nativeTest.messages.some(x => JSON.stringify(x).includes('chrome-extension://'))), false);
  assert.equal(await page.evaluate(() => window.__nativeTest.messages.some(x => x.op === 'session.request' && x.method === 'POST')), false);
  assert.deepEqual(errors, []);
  assert.equal(assetListRequests, 0, 'media selection never falls back to immediate-add asset search');
  console.log('native UI passed: source selection, cover, cancellation, busy lock, account menu, compact official editor, focus, draft/radio persistence, 1440/1290/960/820/560; no real platform calls');
  console.log('editor layout metrics:', JSON.stringify(layouts));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
