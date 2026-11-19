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
  if (url.pathname === '/api/v1/ai/publish-assist') {
    const parts = []; for await (const part of request) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts));
    assert.equal(body.phase, 'analyze');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({code: 0, data: {title: '山野记录', description: '沿着山脊走走，记录周末的风景。', location: null, music: {queries: ['合成布局音乐'], style: '自然舒缓'}}})); return;
  }
  if (url.pathname === '/api/v1/assets') {
    assetListRequests++;
    const video = url.searchParams.get('mediaClasses')?.includes('video');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({code: 0, data: {items: [{id: video ? 'fixture-video' : 'fixture-image', name: video ? '界面测试视频.mp4' : '界面测试图片.jpg', mediaType: video ? 'video' : 'image'}]}})); return;
  }
  if (/^\/api\/v1\/assets\/fixture-image(?:-[23])?\//.test(url.pathname)) {
    response.setHeader('Content-Type', 'image/svg+xml');
    response.end('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200"><rect width="900" height="1200" fill="#c9d2d8"/><rect y="740" width="900" height="460" fill="#9dabb1"/><path d="M0 820 270 430 490 760 670 540 900 820Z" fill="#687d87"/><circle cx="660" cy="260" r="80" fill="#eae6d7"/><text x="450" y="1080" text-anchor="middle" fill="#fff" font-family="sans-serif" font-size="34">UI TEST FIXTURE</text></svg>'); return;
  }
  if (/^\/api\/v1\/assets\/fixture-image(?:-[23])?$/.test(url.pathname)) {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({code: 0, data: {id: url.pathname.split('/').at(-1), name: url.pathname.endsWith('image') ? '界面测试图片.jpg' : '界面测试图片' + url.pathname.at(-1) + '.jpg', mediaType: 'image', sizeBytes: 1000}})); return;
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
  // 原 select 仅保存模型；切换必须经过用户实际看到的网页账号框与候选。
  async function selectAccount(profileId) {
    await page.locator('#account-select-button').click();
    await page.locator(`#account-select-listbox [role=option][data-value="${profileId}"]`).click();
  }
  // 工具栏与操作栏固定，正文和 AI 建议分别在自己的滚动容器内移动。
  async function resetWorkspaceScroll() {
    await page.evaluate(() => { scrollTo(0, 0); for (const node of document.querySelectorAll('.editor-scroll, .ai-suggestions-scroll, .preview-column')) node.scrollTop = 0; });
  }
  // 真实 wheel 验证布局，不替代 macOS 触控板的系统惯性/橡皮筋测试。
  async function verifyWorkspaceScroll() {
    await page.setViewportSize({width: 1290, height: 700}); await resetWorkspaceScroll(); await page.locator('#description').focus();
    const snapshot = () => page.evaluate(() => {
      const rect = selector => { const {x, y, width, height} = document.querySelector(selector).getBoundingClientRect(); return {x, y, width, height}; };
      return {toolbar: rect('.studio-toolbar'), footer: rect('.actionbar'), height: document.querySelector('.editor-scroll').scrollHeight,
        documentHeight: document.documentElement.scrollHeight, bodyY: scrollY};
    });
    const before = await snapshot(), input = await page.locator('#description').boundingBox();
    await page.mouse.move(input.x + 20, input.y + 20); await page.mouse.wheel(0, 10000);
    await page.waitForFunction(() => { const node = document.querySelector('.editor-scroll'); return node.scrollTop > 0 && node.scrollTop >= node.scrollHeight - node.clientHeight - 1; });
    const bottom = await page.locator('.editor-scroll').evaluate(node => node.scrollTop);
    for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 900);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('.editor-scroll').evaluate(node => node.scrollTop), bottom, 'continued downward wheel remains at editor bottom');
    assert.deepEqual(await snapshot(), before, 'editor scrolling does not move toolbar/footer or page boundaries');
    const capability = await page.locator('.capability-panel summary').boundingBox(), editor = await page.locator('.editor-scroll').boundingBox();
    assert.ok(capability.y >= editor.y && capability.y + capability.height <= editor.y + editor.height + 1, 'capabilities remain reachable in the editor while preview is separate');
    await page.screenshot({path: output + 'studio-fixed-workspace-bottom.png'});
    await page.mouse.wheel(0, -350); await page.waitForFunction(previous => document.querySelector('.editor-scroll').scrollTop < previous, bottom);
    assert.deepEqual(await snapshot(), before, 'upward editor scrolling keeps the toolbar and footer fixed');

    await resetWorkspaceScroll(); await page.locator('#open-ai').click();
    await page.locator('#ai-context').fill('惠州大南山，周末徒步，自然记录。');
    await page.locator('#ai-generate').click();
    await page.waitForFunction(() => !document.querySelector('#ai-result').hidden && !document.querySelector('#ai-apply').disabled);
    const aiGeometry = () => page.evaluate(() => {
      const rect = selector => { const {x, y, width, height} = document.querySelector(selector).getBoundingClientRect(); return {x, y, width, height}; };
      return {left: rect('.editor-column'), right: rect('#ai-suggestions'), heading: rect('.ai-suggestions-heading'), footer: rect('.ai-suggestions-footer'), toolbar: rect('.studio-toolbar'), leftFooter: rect('.actionbar'), bodyY: scrollY};
    });
    await resetWorkspaceScroll();
    const columns = await aiGeometry(), workInput = await page.locator('#ai-dialog').boundingBox();
    assert.equal(columns.left.y, columns.right.y, 'editor and AI columns start together');
    assert.ok(workInput.x >= columns.right.x && workInput.x + workInput.width <= columns.right.x + columns.right.width, 'work information is contained in the AI column');
    assert.equal(await page.locator('.ai-suggestions-scroll').evaluate(node => node.firstElementChild.id), 'ai-dialog');
    assert.equal(await page.locator('#ai-dialog').evaluate(node => node.tagName), 'SECTION');
    assert.equal(await page.locator('#douyin-preview').count(), 1, 'AI replaces the visible preview without deleting its container');
    assert.equal(await page.locator('.preview-column').isHidden(), true, 'publishing preview is hidden while AI is open');
    await page.setViewportSize({width: 1290, height: 520}); await resetWorkspaceScroll();
    const pinned = await aiGeometry(), inputTop = (await page.locator('#ai-dialog').boundingBox()).y, right = await page.locator('.ai-suggestions-scroll').boundingBox();
    await page.mouse.move(right.x + 6, right.y + 20); await page.mouse.wheel(0, 10000);
    await page.waitForFunction(() => { const node = document.querySelector('.ai-suggestions-scroll'); return node.scrollTop > 0 && node.scrollTop >= node.scrollHeight - node.clientHeight - 1; });
    assert.equal(await page.locator('.editor-scroll').evaluate(node => node.scrollTop), 0, 'scrolling suggestions does not move the work form');
    assert.ok((await page.locator('#ai-dialog').boundingBox()).y < inputTop, 'work information scrolls out with the AI suggestions');
    assert.deepEqual(await aiGeometry(), pinned, 'column headings and action bars stay fixed while input and suggestions scroll');
    const rightY = await page.locator('.ai-suggestions-scroll').evaluate(node => node.scrollTop), left = await page.locator('.editor-scroll').boundingBox();
    await page.mouse.move(left.x + 15, left.y + 20); await page.mouse.wheel(0, 10000);
    await page.waitForFunction(() => document.querySelector('.editor-scroll').scrollTop > 0);
    assert.equal(await page.locator('.ai-suggestions-scroll').evaluate(node => node.scrollTop), rightY, 'scrolling the work form preserves suggestion scroll position');
    assert.deepEqual(await aiGeometry(), pinned);
    await page.screenshot({path: output + 'studio-fixed-workspace-short.png'});
    await page.locator('#ai-close').click();
    assert.equal(await page.locator('.preview-column').isVisible(), true, 'closing AI restores the publishing preview');
    assert.equal(await page.locator('.studio-phone-title').textContent(), await page.locator('#title').inputValue());
    await page.setViewportSize({width: 560, height: 700}); await resetWorkspaceScroll();
    assert.equal(await page.locator('#ai-suggestions').isVisible(), false);
    assert.equal(await page.locator('.preview-column').isVisible(), false, 'narrow layout retains responsive preview hiding');
    await page.mouse.move(40, 300); await page.mouse.wheel(0, 450); await page.waitForFunction(() => scrollY > 0);
    assert.equal((await page.locator('.studio-toolbar').boundingBox()).y, 0, 'narrow layout keeps natural page scrolling with a pinned toolbar');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.setViewportSize({width: 1290, height: 900}); await resetWorkspaceScroll();
  }
  // 普通编辑恢复右侧发布预览，表单保持紧凑，窄屏依旧优先编辑。
  async function inspectEditorLayout(width, screenshot) {
    await page.setViewportSize({width, height: 900});
    await resetWorkspaceScroll();
    const metrics = await page.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return {x: r.x, y: r.y, width: r.width, height: r.height}; };
      return {card: rect('.basic-card'), preview: rect('.preview-column'), phone: rect('.studio-phone'), description: rect('.description-editor'), cover: rect('.cover-row'), footer: rect('.actionbar'),
        overflow: document.documentElement.scrollWidth > innerWidth,
        tabsVisible: getComputedStyle(document.querySelector('.publish-tabs')).display !== 'none',
        successBannerVisible: !document.querySelector('#connection-banner').hidden};
    });
    assert.equal(metrics.overflow, false, `editor must not overflow at ${width}px`);
    assert.equal(metrics.tabsVisible, false, 'editing starts with the form, not upload tabs');
    assert.equal(metrics.successBannerVisible, false, 'verified account does not leave a persistent banner');
    assert.equal(await page.locator('#douyin-preview').count(), 1);
    assert.equal(await page.locator('.preview-column').isVisible(), width > 900, 'normal desktop editing shows the publishing preview');
    if (width >= 1200) {
      assert.ok(metrics.card.y >= 40 && metrics.card.y <= 100, `form starts near the compact toolbar: ${JSON.stringify(metrics)}`);
      assert.ok(metrics.card.width > metrics.preview.width * 1.5 && metrics.description.width > metrics.card.width * 0.6, 'editor keeps readable space beside the restored preview');
      assert.ok(metrics.preview.x >= metrics.card.x + metrics.card.width, 'preview stays in the right column');
      assert.ok(metrics.phone.width > 0 && metrics.phone.width <= metrics.preview.width, 'phone fits within its side column');
      assert.ok(metrics.description.height >= 140 && metrics.description.height <= 200, 'description stays compact');
      assert.ok(metrics.cover.height <= 100, 'cover is a compact horizontal field');
      assert.ok(metrics.footer.y + metrics.footer.height <= 900, 'publishing actions remain within the viewport');
    }
    await page.screenshot({path: output + screenshot});
    return metrics;
  }
  await page.addInitScript(({origin}) => {
    window.pluginContext = {nativeUIAvailable: true, browserEnvironment: {userAgent: 'SyntheticWebKit/1.0', languages: ['zh-CN', 'en-US']}, nativeCapabilities: {browserRequestsVersion: 1, persistentWebsiteSessionsVersion: 1, sessionLoginOptionsVersion: 1, networkHeadersVersion: 1, sessionVersion: 1, sessionProfilesVersion: 1, temporaryFilesVersion: 1, mediaSelectionVersion: 1}, apiBaseURL: origin + '/api/v1', frontendState: {}, libraryID: 'native-ui-fixture'};
    let active = null, loginCount = 0; const runtime = {}, profiles = [];
    window.__nativeTest = {messages: [], state: {}};
    const status = () => ({browserSessionAvailable: active?.browserSessionAvailable === true, hasCookies: active?.hasCookies === true, activeProfileId: active?.id || null, accountId: active?.accountId || null, name: active?.name || null, expiresAt: active?.expiresAt || null});
    window.__nativeTest.expireProfile = id => { profiles.find(item => item.id === id).browserSessionAvailable = false; };
    window.webkit = {messageHandlers: {pluginUI: {postMessage: async message => {
      window.__nativeTest.messages.push(structuredClone(message));
      if (message.op === 'persist') { if (window.__nativeTest.failPersist) throw Error('合成保存失败'); window.__nativeTest.state = structuredClone(message.value); return {ok: true}; }
      if (message.op === 'assets.select') {
        if (window.__nativeTest.holdSelection) return new Promise(resolve => { window.__nativeTest.finishSelection = result => resolve({ok: true, data: result}); });
        return {ok: true, data: {cancelled: false, assetIDs: window.__nativeTest.nextSelection || ['fixture-image']}};
      }
      if (message.op === 'session.status') return {ok: true, data: status()};
      if (message.op === 'session.login') {
        if (window.__nativeTest.cancelLogin) return {ok: false, error: {code: 'SESSION_LOGIN_CANCELLED', message: '已取消网站登录，原有会话未改变。'}};
        const target = message.profileId ? profiles.find(item => item.id === message.profileId) : null;
        if (message.profileId && !target) throw Error('Unknown relogin profile');
        active = {id: 'profile-' + ++loginCount, reloginProfileId: message.profileId, browserSessionAvailable: true, hasCookies: true, expiresAt: new Date(Date.now() + 8 * 3600000).toISOString(), identity: window.__nativeTest.nextAccount || target?.identity || {id: '123', name: '合成 UI 测试账号'}};
        return {ok: true, data: status()};
      }
      if (message.op === 'session.identify') {
        if (message.profileId !== active?.id) throw Error('Profile changed during verification');
        const existing = profiles.find(item => item.accountId === message.accountId);
        if (active.reloginProfileId) {
          const target = profiles.find(item => item.id === active.reloginProfileId);
          if (target?.accountId !== message.accountId) return {ok: false, error: {code: 'SESSION_IDENTITY_MISMATCH', message: '所选账号不一致。'}};
          Object.assign(target, active, {id: target.id}); delete target.reloginProfileId; active = target;
        } else if (existing && existing.id !== active.id) return {ok: false, error: {code: 'SESSION_ACCOUNT_EXISTS', message: '账号已存在。'}};
        else if (!existing) profiles.push(active);
        Object.assign(active, {accountId: message.accountId, name: message.name});
        return {ok: true, data: status()};
      }
      if (message.op === 'session.list') {
        const offset = message.offset || 0, end = offset + (message.limit || 10);
        return {ok: true, data: {items: profiles.slice(offset, end).map(({identity, ...item}) => item), activeProfileId: active?.id || null, hasMore: end < profiles.length, nextOffset: end < profiles.length ? end : null}};
      }
      if (message.op === 'session.select') { active = profiles.find(item => item.id === message.profileId); if (!active) throw Error('Unknown profile'); return {ok: true, data: status()}; }
      if (message.op === 'session.clear') {
        const targetId = message.profileId || active?.id, index = profiles.findIndex(item => item.id === targetId);
        if (message.keepBrowserData === true && (!message.profileId || index >= 0 || active?.id !== targetId || active?.accountId)) throw Error('Only unidentified candidates may retain website data');
        if (index >= 0) profiles.splice(index, 1);
        if (active?.id === targetId) active = null;
        return {ok: true, data: status()};
      }
      if (message.op === 'state.get') return {ok: true, data: message.keys ? {[message.keys]: runtime[message.keys]} : runtime};
      if (message.op === 'state.set') { Object.assign(runtime, message.values); return {ok: true, data: {saved: true}}; }
      if (message.op === 'browser.request') {
        const url = new URL(message.url); let data;
        if (url.pathname === '/web/api/media/user/info/') data = {status_code: 0, user: {uid: active.identity.id, nickname: active.identity.name}};
        else if (url.pathname === '/aweme/v1/search/challengesug/') data = {status_code: 0, sug_list: [{cid: '222', cha_name: '测试摄影话题'}]};
        else if (url.pathname === '/web/api/media/activity/get/') data = {status_code: 0, activity_list: []};
        else if (url.pathname === '/aweme/v1/hotspot/recommend/') data = {status_code: 0, all_sentences: [], rec_sentences: []};
        else if (url.pathname === '/web/api/media/aweme/search/post/auth') data = {status_code: 0, signature: 'synthetic-layout-auth'};
        else if (url.hostname === 'tsearch.amemv.com' && url.pathname === '/openapi/aweme/v1/music/search/') data = {status_code: 0, music: [], has_more: 0};
        else throw Error('Unexpected platform operation');
        const response = {ok: true, data: {status: 200, headers: {'content-type': 'application/json'}, body: JSON.stringify(data)}};
        if (window.__nativeTest.holdAccount && url.pathname === '/web/api/media/user/info/') return new Promise(resolve => { window.__nativeTest.finishAccount = () => resolve(response); });
        return response;
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
  assert.equal(await page.getByRole('button', {name: '添加账号', exact: true}).isVisible(), true);
  assert.equal(await page.locator('#account-select').inputValue(), 'profile-1');
  assert.equal(await page.getByRole('button', {name: '重新登录当前账号', exact: true}).isVisible(), true);
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
  const firstSelectionCount = await page.evaluate(() => window.__nativeTest.messages.filter(item => item.op === 'assets.select').length);
  await page.locator('#choose-cover').click();
  await page.locator('#cover-picker[open]').waitFor();
  assert.equal(await page.locator('#cover-picker-confirm').isDisabled(), true);
  await page.getByRole('button', {name: '选择素材：界面测试图片.jpg', exact: true}).click();
  assert.equal(await page.locator('#cover-picker-grid [aria-pressed=true]').count(), 1);
  await page.locator('#cover-picker-confirm').click();
  await page.waitForFunction(() => !document.body.classList.contains('busy') && window.__nativeTest.state.drafts[0].cover?.assetId === 'fixture-image');
  assert.equal(await page.evaluate(() => window.__nativeTest.state.drafts[0].assets.length), 1);
  assert.equal(await page.evaluate(() => window.__nativeTest.messages.filter(item => item.op === 'assets.select').length), firstSelectionCount, 'current-image cover selection does not reopen the library or upload anything');
  // 独立图库封面只绑定封面，不加入正文，也不改变正文顺序。
  await page.evaluate(() => { window.__nativeTest.nextSelection = ['fixture-image-2']; });
  await page.locator('#choose-cover').click();
  await page.locator('#cover-picker-library').click();
  await page.waitForFunction(() => !document.body.classList.contains('busy') && window.__nativeTest.state.drafts[0].cover?.assetId === 'fixture-image-2');
  assert.deepEqual(await page.evaluate(() => window.__nativeTest.state.drafts[0].assets.map(item => item.id)), ['fixture-image']);
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
  await page.locator('#description').fill('#摄影');
  await page.locator('#association-results').getByRole('option').filter({hasText: '测试摄影话题'}).waitFor();
  await page.locator('#description').press('Escape');
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
  assert.equal(await page.locator('#search-declaration').isDisabled(), false);
  await page.locator('#page-notice').waitFor({state: 'hidden', timeout: 7000});
  await resetWorkspaceScroll();
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
  await verifyWorkspaceScroll();
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
  await page.locator('.studio-gallery-image').first().click();
  await page.locator('.studio-gallery-lightbox[open] img').waitFor();
  const expandedBounds = await page.locator('.studio-gallery-lightbox').boundingBox();
  assert.ok(expandedBounds.width <= 560 && expandedBounds.height <= 850, 'narrow-window media preview remains usable');
  await page.getByRole('button', {name: '关闭预览', exact: true}).click();
  // 多账号使用真实 client/UI 与合成宿主：添加、切回、取消登录和失效会话不改作品内容。
  const draftBeforeSwitch = await page.evaluate(() => structuredClone(window.__nativeTest.state));
  await page.evaluate(() => { window.__nativeTest.nextAccount = {id: '456', name: '合成第二账号'}; });
  await accountMenu();
  await page.getByRole('button', {name: '添加账号', exact: true}).click();
  await page.locator('#connection-label').filter({hasText: '合成第二账号'}).waitFor();
  assert.equal(await page.locator('#account-select option').count(), 3);
  await accountMenu();
  const loginsBeforeSwitch = await page.evaluate(() => window.__nativeTest.messages.filter(item => item.op === 'session.login').length);
  await selectAccount('profile-1');
  await page.locator('#connection-label').filter({hasText: '合成 UI 测试账号'}).waitFor();
  assert.equal(await page.evaluate(() => window.__nativeTest.messages.filter(item => item.op === 'session.login').length), loginsBeforeSwitch);
  await page.evaluate(() => { window.__nativeTest.cancelLogin = true; });
  await accountMenu();
  await page.getByRole('button', {name: '添加账号', exact: true}).click();
  await page.getByText('已取消网站登录，原有会话未改变。', {exact: true}).waitFor();
  assert.equal(await page.locator('#account-select').inputValue(), 'profile-1');
  await page.evaluate(() => { window.__nativeTest.cancelLogin = false; window.__nativeTest.holdAccount = true; });
  const identitiesBeforeSwitch = await page.evaluate(() => window.__nativeTest.messages.filter(item => item.op === 'browser.request' && item.url.includes('/user/info/')).length);
  await selectAccount('profile-2');
  await page.locator('#connection-label').filter({hasText: '合成第二账号'}).waitFor();
  assert.equal(await page.evaluate(() => window.__nativeTest.messages.filter(item => item.op === 'browser.request' && item.url.includes('/user/info/')).length), identitiesBeforeSwitch);
  await accountMenu(); await page.getByRole('button', {name: '检查会话', exact: true}).click();
  await page.waitForFunction(() => typeof window.__nativeTest.finishAccount === 'function');
  assert.equal(await page.locator('#account-select').isDisabled(), true);
  assert.equal(await page.locator('#account-select-button').isDisabled(), true, 'visible account control must also stay disabled while checking');
  assert.equal(await page.locator('#prepare').isDisabled(), true);
  await page.evaluate(() => { window.__nativeTest.holdAccount = false; window.__nativeTest.finishAccount(); });
  await page.locator('#connection-label').filter({hasText: '合成第二账号'}).waitFor();
  await page.evaluate(() => { window.__nativeTest.expireProfile('profile-1'); });
  await accountMenu();
  await selectAccount('profile-1');
  await page.waitForFunction(() => !document.querySelector('#account-select').disabled);
  assert.equal(await page.locator('#account-select').inputValue(), 'profile-1');
  assert.match(await page.locator('#account-select option:checked').textContent(), /需重新登录/);
  assert.match(await page.locator('#connection-label').textContent(), /合成 UI 测试账号.*离线/);
  assert.equal(await page.locator('#search-music').isDisabled(), false, 'offline status must not remove existing editing capabilities');
  assert.equal(await page.locator('#title').isDisabled(), false);
  await accountMenu();
  assert.equal(await page.getByRole('button', {name: '添加账号', exact: true}).isVisible(), true);
  await page.evaluate(() => { window.__nativeTest.nextAccount = {id: '123', name: '合成 UI 测试账号'}; });
  await page.getByRole('button', {name: '重新登录当前账号', exact: true}).click();
  await page.locator('#connection-label').filter({hasText: '合成 UI 测试账号'}).waitFor();
  assert.equal(await page.locator('#account-select').inputValue(), 'profile-1');
  assert.equal(await page.locator('#account-select option').count(), 3, '重新登录不能创建额外账号');
  assert.equal(await page.evaluate(() => window.__nativeTest.messages.filter(item => item.op === 'session.login').at(-1).profileId), 'profile-1');
  assert.equal(await page.evaluate(() => Object.hasOwn(window.__nativeTest.messages.filter(item => item.op === 'session.login').at(-1), 'userAgent')), false);
  await accountMenu();
  await page.evaluate(() => { window.__nativeTest.cancelLogin = true; });
  await page.getByRole('button', {name: '重新登录当前账号', exact: true}).click();
  await page.getByText('已取消网站登录，原有会话未改变。', {exact: true}).waitFor();
  assert.equal(await page.locator('#account-select').inputValue(), 'profile-1');
  await page.evaluate(() => { window.__nativeTest.cancelLogin = false; });
  await selectAccount('profile-2');
  await page.locator('#connection-label').filter({hasText: '合成第二账号'}).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__nativeTest.state), draftBeforeSwitch);
  await accountMenu();
  await page.screenshot({path: output + 'studio-multiple-accounts-narrow.png'});
  await page.setViewportSize({width: 1290, height: 900});
  await page.screenshot({path: output + 'studio-multiple-accounts.png'});
  await accountMenu();
  await page.locator('#clear-session').click();
  await page.waitForFunction(() => !document.querySelector('#account-select').disabled && document.querySelector('#account-select').value === '');
  assert.equal(await page.locator('#account-select option').count(), 2, 'removing one account preserves the other account');
  assert.equal(await page.locator('#publish').isDisabled(), true);
  await accountMenu(false);
  const selectionCount = await page.evaluate(() => window.__nativeTest.messages.filter(item => item.op === 'assets.select').length);
  await page.evaluate(() => { window.__nativeTest.failPersist = true; });
  await page.locator('#add-library-media').click();
  await page.getByText('草稿未能保存，暂不离开工作台。请先保存成功后再选择素材。', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => window.__nativeTest.messages.filter(item => item.op === 'assets.select').length), selectionCount);
  await page.evaluate(() => { window.__nativeTest.failPersist = false; window.pluginContext.nativeCapabilities.mediaSelectionVersion = 0; });
  await page.locator('#add-library-media').click();
  await page.getByText('当前 App 尚不支持从来源选择素材，请更新 App 后重新打开工作台。', {exact: true}).waitFor();
  assert.equal(await page.evaluate(() => window.__nativeTest.messages.filter(item => item.op === 'assets.select').length), selectionCount);
  // 多图封面与移除都只修改草稿；取消不写入，保存失败保留编辑，可单独重试保存。
  await page.evaluate(() => { window.pluginContext.nativeCapabilities.mediaSelectionVersion = 1; window.__nativeTest.nextSelection = ['fixture-image-2', 'fixture-image-3']; });
  await page.locator('#add-library-media').click();
  await page.waitForFunction(() => !document.body.classList.contains('busy') && document.querySelectorAll('.studio-gallery-remove').length === 3);
  const savedDraft = () => page.evaluate(() => window.__nativeTest.state.drafts.find(item => item.id === window.__nativeTest.state.activeDraftId));
  const priorCover = (await savedDraft()).cover;
  await page.locator('#choose-cover').click();
  await page.getByRole('button', {name: '选择素材：界面测试图片3.jpg', exact: true}).click();
  assert.equal(await page.locator('#cover-picker-grid [aria-pressed=true]').count(), 1, 'cover is single-select');
  assert.deepEqual((await savedDraft()).cover, priorCover, 'temporary cover selection is not applied before confirmation');
  const checkPosition = await page.locator('#cover-picker-grid .is-selected').evaluate(card => {
    const thumb = card.querySelector('.cover-picker-preview').getBoundingClientRect(), check = card.querySelector('.cover-picker-select').getBoundingClientRect();
    return {right: thumb.right - check.right, bottom: thumb.bottom - check.bottom, color: getComputedStyle(card.querySelector('svg')).color};
  });
  assert.ok(checkPosition.right >= 0 && checkPosition.right <= 6 && checkPosition.bottom >= 0 && checkPosition.bottom <= 6);
  assert.equal(checkPosition.color, 'rgb(22, 135, 255)');
  await page.screenshot({path: output + 'studio-current-images-cover.png'});
  await page.getByRole('button', {name: '放大图片：界面测试图片3.jpg', exact: true}).click();
  await page.locator('.studio-gallery-lightbox[open]').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#cover-picker').evaluate(el => el.open), true);
  assert.equal(await page.locator('#cover-picker-grid [aria-pressed=true]').count(), 1, 'preview leaves cover selection intact');
  await page.locator('#cover-picker-cancel').click();
  assert.deepEqual((await savedDraft()).cover, priorCover, 'cancel preserves the previous cover');
  await page.locator('#choose-cover').click();
  await page.getByRole('button', {name: '选择素材：界面测试图片3.jpg', exact: true}).click();
  await page.locator('#cover-picker-confirm').click();
  await page.waitForFunction(() => !document.body.classList.contains('busy') && document.querySelector('#cover-name').textContent === '界面测试图片3.jpg');
  assert.equal((await savedDraft()).cover.assetId, 'fixture-image-3');
  assert.deepEqual((await savedDraft()).assets.map(item => item.id), ['fixture-image', 'fixture-image-2', 'fixture-image-3']);
  // 排序写入实际草稿，保持封面和预览素材身份；保存失败不丢弃当前编辑，单独重试即可。
  const sortCover = (await savedDraft()).cover;
  const sortPreviewImage = await page.locator('.studio-phone-stage .is-current img').getAttribute('alt');
  const alerts = []; page.on('dialog', async dialog => { alerts.push(dialog.message()); await dialog.accept(); });
  const photo = name => page.getByRole('button', {name: '查看图片：' + name, exact: true});
  const visibleOrder = () => page.locator('.studio-gallery-card').evaluateAll(cards => cards.map(card => card.dataset.assetId));
  await photo('界面测试图片.jpg').dragTo(photo('界面测试图片3.jpg'));
  await page.waitForFunction(() => !document.body.classList.contains('busy') && window.__nativeTest.state.drafts.find(item => item.id === window.__nativeTest.state.activeDraftId).assets.at(-1).id === 'fixture-image');
  assert.deepEqual((await savedDraft()).assets.map(item => item.id), ['fixture-image-2', 'fixture-image-3', 'fixture-image']);
  assert.deepEqual((await savedDraft()).cover, sortCover, 'reordering does not replace the selected cover or its crop');
  assert.equal(await page.locator('.studio-phone').count(), 1);
  assert.equal(await page.locator('.studio-phone-stage .is-current img').getAttribute('alt'), sortPreviewImage, 'sorting preserves the identity of the focused preview image');
  assert.equal(await page.locator('.studio-phone-segment').count(), 3);
  assert.equal(await page.locator('.studio-gallery-lightbox').evaluate(el => el.open), false);
  // 移除按钮不是拖动手柄；从该按钮发起拖动不能取得图片的排序资格。
  const removalDrag = await page.evaluateHandle(() => new DataTransfer());
  await page.getByRole('button', {name: '移除图片：界面测试图片3.jpg', exact: true}).dispatchEvent('dragstart', {dataTransfer: removalDrag});
  await photo('界面测试图片.jpg').dispatchEvent('drop', {dataTransfer: removalDrag});
  assert.deepEqual(await visibleOrder(), ['fixture-image-2', 'fixture-image-3', 'fixture-image']);
  await page.evaluate(() => { window.__nativeTest.failPersist = true; });
  await photo('界面测试图片2.jpg').dragTo(photo('界面测试图片.jpg'));
  await page.waitForFunction(() => !document.body.classList.contains('busy') && document.querySelector('#save-state').textContent.includes('保存失败'));
  assert.deepEqual(await visibleOrder(), ['fixture-image-3', 'fixture-image', 'fixture-image-2']);
  assert.deepEqual((await savedDraft()).assets.map(item => item.id), ['fixture-image-2', 'fixture-image-3', 'fixture-image']);
  assert.deepEqual(alerts, ['合成保存失败']);
  await page.evaluate(() => { window.__nativeTest.failPersist = false; });
  await page.locator('#save-draft').click();
  await page.waitForFunction(() => document.querySelector('#save-state').textContent === '已保存至本机');
  assert.deepEqual((await savedDraft()).assets.map(item => item.id), ['fixture-image-3', 'fixture-image', 'fixture-image-2']);
  await photo('界面测试图片3.jpg').dragTo(photo('界面测试图片2.jpg'));
  await page.waitForFunction(() => !document.body.classList.contains('busy') && document.querySelector('.studio-gallery-card').dataset.assetId === 'fixture-image');
  assert.deepEqual((await savedDraft()).assets.map(item => item.id), ['fixture-image', 'fixture-image-2', 'fixture-image-3']);
  assert.deepEqual((await savedDraft()).cover, sortCover);
  await photo('界面测试图片3.jpg').focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForFunction(() => !document.body.classList.contains('busy') && document.activeElement?.getAttribute('aria-label') === '查看图片：界面测试图片3.jpg');
  assert.deepEqual((await savedDraft()).assets.map(item => item.id), ['fixture-image', 'fixture-image-3', 'fixture-image-2']);
  await page.keyboard.press('Alt+ArrowRight');
  await page.waitForFunction(() => !document.body.classList.contains('busy') && document.querySelectorAll('.studio-gallery-card')[2].dataset.assetId === 'fixture-image-3');
  assert.deepEqual((await savedDraft()).assets.map(item => item.id), ['fixture-image', 'fixture-image-2', 'fixture-image-3']);
  alerts.length = 0;
  await page.getByRole('button', {name: '移除图片：界面测试图片.jpg', exact: true}).click();
  await page.waitForFunction(() => !document.body.classList.contains('busy') && document.querySelectorAll('.studio-gallery-image').length === 2);
  assert.equal(await page.locator('.studio-gallery-lightbox').evaluate(el => el.open), false, 'remove does not open preview');
  assert.equal((await savedDraft()).cover.assetId, 'fixture-image-3', 'removing another image preserves cover');
  assert.equal(await page.locator('.studio-gallery-card').count(), 2, 'material gallery continues to reflect image removal');
  await page.evaluate(() => { window.__nativeTest.failPersist = true; });
  await page.getByRole('button', {name: '移除图片：界面测试图片3.jpg', exact: true}).click();
  await page.waitForFunction(() => !document.body.classList.contains('busy') && document.querySelectorAll('.studio-gallery-image').length === 1);
  assert.equal(await page.locator('#cover-name').textContent(), '界面测试图片3.jpg', 'removing a body reference preserves its independently selected cover');
  assert.match(await page.locator('#save-state').textContent(), /保存失败/);
  assert.deepEqual(alerts, ['合成保存失败']);
  assert.equal((await savedDraft()).assets.length, 2, 'failed persistence does not pretend to update saved state');
  await page.evaluate(() => { window.__nativeTest.failPersist = false; });
  await page.locator('#save-draft').click();
  await page.waitForFunction(() => document.querySelector('#save-state').textContent === '已保存至本机');
  assert.deepEqual((await savedDraft()).cover, sortCover, 'retry retains independent cover and crop');
  assert.deepEqual((await savedDraft()).assets.map(item => item.id), ['fixture-image-2'], 'retry saves the same edit without removing another picture');
  await page.getByRole('button', {name: '移除图片：界面测试图片2.jpg', exact: true}).click();
  await page.waitForFunction(() => !document.body.classList.contains('busy') && document.querySelectorAll('.studio-gallery-image').length === 0);
  assert.equal(await page.locator('#choose-cover').isEnabled(), true, 'cover selection does not require body images');
  await page.evaluate(() => { window.__nativeTest.nextSelection = ['fixture-image']; });
  await page.locator('#choose-cover').click();
  await page.waitForFunction(() => !document.body.classList.contains('busy') && window.__nativeTest.state.drafts.find(item => item.id === window.__nativeTest.state.activeDraftId).cover?.assetId === 'fixture-image');
  assert.equal((await savedDraft()).assets.length, 0, 'selecting a cover for an empty body never inserts it into body images');
  assert.equal(await page.locator('.studio-phone-progress').isHidden(), true, 'empty body has no image progress');
  assert.equal((await savedDraft()).title, '原生会话界面测试', 'removing all pictures preserves the copy');
  assert.equal(await page.locator('#search-dialog').isVisible(), false);
  assert.equal(await page.evaluate(() => window.__nativeTest.messages.some(x => JSON.stringify(x).includes('chrome-extension://'))), false);
  assert.equal(await page.evaluate(() => window.__nativeTest.messages.some(x => x.op === 'browser.request' && x.method === 'POST')), false);
  assert.deepEqual(errors, []);
  assert.equal(assetListRequests, 0, 'media selection never falls back to immediate-add asset search');
  console.log('native UI passed: multiple accounts, expired session, cancel and busy lock, unchanged drafts, source selection, cover, compact editor, 1440/1290/960/820/560; no real platform calls');
  console.log('editor layout metrics:', JSON.stringify(layouts));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
