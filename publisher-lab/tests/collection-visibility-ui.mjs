import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

// 运行生产页面/client/engine，仅宿主桥提供合成账号、合集和草稿；禁止真实平台、素材、上传和发布请求。
const root = fileURLToPath(new URL('../app/', import.meta.url));
const output = fileURLToPath(new URL('../output/playwright/', import.meta.url));
await mkdir(output, {recursive: true});
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
const pages = [], errors = [], externalRequests = [];

async function openFixture({active = 'public', offline = false, width = 1280} = {}) {
  const page = await browser.newPage({viewport: {width, height: 950}});
  pages.push(page); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    externalRequests.push(route.request().url()); return route.abort();
  });
  await page.addInitScript(({origin, active, offline}) => {
    const draft = (id, visibility, collection = null) => ({id, name: '合集回归 ' + id, kind: 'image', title: '本机标题 ' + id,
      description: '正文和选中资源必须保留', assets: [], topics: [], mentions: [], activities: [], music: null, location: null,
      collection, cover: null, aiContext: '', settings: {visibility, download: 'allow', publishTime: 'now', scheduledAt: '', declarations: []},
      updatedAt: '2026-11-18T00:00:00Z', receipt: null});
    const initial = {version: 2, activeDraftId: active, drafts: [draft('public', 'public'), draft('private', 'private'), draft('friends', 'friends'),
      draft('old-private', 'private', {id: '1101', name: '周末摄影'}), draft('old-friends', 'friends', {id: '1101', name: '周末摄影'})], aiPrompt: '', handledTransfers: []};
    const profile = {id: 'collection-profile', accountId: '123', name: '合成合集账号', browserSessionAvailable: true, hasCookies: true};
    const fixture = window.__collectionUI = {state: structuredClone(initial), runtime: {}, messages: [], requests: [], offline};
    window.pluginContext = {nativeUIAvailable: true, nativeCapabilities: {browserRequestsVersion: 1, persistentWebsiteSessionsVersion: 1,
      sessionLoginOptionsVersion: 1, networkHeadersVersion: 1, sessionVersion: 1, sessionProfilesVersion: 1, temporaryFilesVersion: 1},
      apiBaseURL: origin + '/api/v1', frontendState: initial, libraryID: 'collection-visibility-fixture'};
    const status = () => ({activeProfileId: profile.id, accountId: profile.accountId, name: profile.name, browserSessionAvailable: true, hasCookies: true});
    window.webkit = {messageHandlers: {pluginUI: {postMessage: async message => {
      fixture.messages.push(structuredClone(message));
      if (message.op === 'persist') { fixture.state = structuredClone(message.value); return {ok: true}; }
      if (message.op === 'session.list') return {ok: true, data: {items: [profile], activeProfileId: profile.id, hasMore: false, nextOffset: null}};
      if (['session.status', 'session.select', 'session.identify'].includes(message.op)) return {ok: true, data: status()};
      if (message.op === 'session.cancel') return {ok: true, data: {cancelled: true}};
      if (message.op === 'state.get') return {ok: true, data: message.keys ? {[message.keys]: fixture.runtime[message.keys]} : fixture.runtime};
      if (message.op === 'state.set') { Object.assign(fixture.runtime, structuredClone(message.values)); return {ok: true, data: {saved: true}}; }
      if (message.op !== 'browser.request') throw Error('Unexpected collection host operation: ' + message.op);
      const url = new URL(message.url);
      fixture.requests.push({path: url.pathname, method: message.method});
      if (message.method !== 'GET' || !['/web/api/mix/list/', '/web/api/media/activity/get/'].includes(url.pathname)) {
        throw Error('Collection editing must not verify accounts, upload, or publish: ' + url.pathname);
      }
      if (fixture.offline) return {ok: false, error: {code: 'SESSION_EXPIRED', message: '合成账号当前离线，请自行处理登录。'}};
      const data = url.pathname === '/web/api/mix/list/' ? {status_code: 0, mix_list: [
        {mix_id: '1101', mix_name: '周末摄影', type: 0, status: {status: 0}, statis: {updated_to_episode: 4}},
        {mix_id: '1102', mix_name: '城市漫游', type: 0, status: {status: 0}, statis: {updated_to_episode: 2}},
      ], has_more: 0, cursor: '0'} : {status_code: 0, activity_list: []};
      return {ok: true, data: {status: 200, headers: {'content-type': 'application/json'}, body: JSON.stringify(data)}};
    }}}};
  }, {origin, active, offline});
  await page.goto(origin);
  await page.waitForFunction(() => document.body.dataset.phase === 'editing' && document.querySelector('#connection-label').textContent.includes('合成合集账号'));
  return page;
}

const persisted = page => page.evaluate(() => structuredClone(__collectionUI.state));
const persistCount = page => page.evaluate(() => __collectionUI.messages.filter(item => item.op === 'persist').length);
const selectedVisibility = page => page.locator('#visibility input:checked').inputValue();
async function settle(page) {
  await page.waitForFunction(() => document.querySelector('#save-state').textContent === '已保存至本机');
}
async function chooseCollection(page, {repeat = false} = {}) {
  await page.locator('#search-collection').click();
  const option = page.locator('#collection-popover [role=option]').filter({hasText: '周末摄影'});
  await option.waitFor();
  if (repeat) await option.evaluate(button => { button.click(); button.click(); });
  else await option.click();
}
async function switchDraft(page, id) {
  await page.locator('#open-drafts').click();
  await page.locator('.draft-item').filter({hasText: '合集回归 ' + id}).click();
  await page.waitForFunction(id => __collectionUI.state.activeDraftId === id, id);
  await settle(page);
}
async function assertNoChange(page, before, count, visibility) {
  // 超过生产自动保存的450ms，确认取消没有排入延迟保存任务。
  await page.waitForTimeout(550);
  assert.deepEqual(await persisted(page), before, 'cancelling cannot modify any persisted draft or timestamp');
  assert.equal(await persistCount(page), count, 'cancelling cannot schedule a persist');
  assert.equal(await selectedVisibility(page), visibility, 'radio must continue to represent the saved draft');
  assert.equal(await page.locator('#save-state').textContent(), '已保存至本机');
}
async function inspectLayout(page, width, name) {
  await page.setViewportSize({width, height: 950});
  const dialog = page.locator('#confirm-dialog');
  const bounds = await dialog.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'confirmation must fit viewport at ' + width);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 951, 'confirmation actions remain visible at ' + width);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'page must not overflow at ' + width);
  assert.equal(await page.locator('#confirm-cancel').isVisible(), true);
  assert.equal(await page.locator('#confirm-submit').isVisible(), true);
  await page.screenshot({path: output + 'studio-collection-' + name + '-' + width + '.png'});
}

try {
  const page = await openFixture();
  assert.equal(await persistCount(page), 0, 'restoring drafts must not rewrite existing collection/visibility');
  await chooseCollection(page);
  assert.equal(await page.locator('#confirm-dialog').isVisible(), false, 'public drafts can select collections directly');
  await page.waitForFunction(() => __collectionUI.state.drafts.find(item => item.id === 'public').collection?.id === '1101');
  await settle(page);
  assert.equal(await selectedVisibility(page), 'public');
  assert.equal(await page.locator('#collection-name').textContent(), '周末摄影');

  for (const visibility of ['private', 'friends']) {
    // 已有合集更改可见性：取消和Escape均保持radio/草稿，确认后一次保存同时移除合集。
    const before = await persisted(page), count = await persistCount(page);
    for (const cancel of ['button', 'escape']) {
      await page.locator('#visibility input[value=' + visibility + ']').click();
      await page.locator('#confirm-dialog[open]').waitFor();
      assert.match(await page.locator('#confirm-submit').textContent(), /移除合集并更改/);
      assert.equal(await selectedVisibility(page), 'public');
      assert.deepEqual(await persisted(page), before, 'opening confirmation must not change state');
      if (cancel === 'button') await page.locator('#confirm-cancel').click();
      else await page.keyboard.press('Escape');
      await assertNoChange(page, before, count, 'public');
    }
    await page.locator('#visibility input[value=' + visibility + ']').click();
    await page.locator('#confirm-submit').click();
    await page.waitForFunction(visibility => {
      const draft = __collectionUI.state.drafts.find(item => item.id === 'public');
      return draft.settings.visibility === visibility && draft.collection === null;
    }, visibility);
    await settle(page);
    assert.equal(await persistCount(page), count + 1, 'one confirmation must save both changes together');

    // 非公开草稿加入合集：显式确认才同时改公开并选中；重复点击不能产生多个确认或写入。
    const privateBefore = await persisted(page), privateCount = await persistCount(page);
    for (const cancel of ['button', 'escape']) {
      await chooseCollection(page, {repeat: true});
      await page.locator('#confirm-dialog[open]').waitFor();
      assert.match(await page.locator('#confirm-submit').textContent(), /设为公开并加入/);
      assert.equal(await page.locator('#confirm-dialog[open]').count(), 1);
      assert.equal(await selectedVisibility(page), visibility);
      if (cancel === 'button') await page.locator('#confirm-cancel').click();
      else await page.keyboard.press('Escape');
      await assertNoChange(page, privateBefore, privateCount, visibility);
    }
    await chooseCollection(page, {repeat: true});
    await page.locator('#confirm-dialog[open]').waitFor();
    if (visibility === 'private') for (const width of [1280, 560]) await inspectLayout(page, width, 'confirm');
    await page.locator('#confirm-submit').evaluate(button => { button.click(); button.click(); });
    await page.waitForFunction(() => {
      const draft = __collectionUI.state.drafts.find(item => item.id === 'public');
      return draft.settings.visibility === 'public' && draft.collection?.id === '1101';
    });
    await settle(page);
    assert.equal(await persistCount(page), privateCount + 1, 'double click must not persist twice');
    assert.equal(await selectedVisibility(page), 'public');
    await page.setViewportSize({width: 1280, height: 950});
  }

  // 已保存的冲突不能在恢复/切稿时被默默清除；行内动作明确各自影响后一次点击解决。
  await switchDraft(page, 'old-private');
  const conflict = (await persisted(page)).drafts.find(item => item.id === 'old-private');
  assert.equal(conflict.collection.id, '1101'); assert.equal(conflict.settings.visibility, 'private');
  await page.locator('#visibility-collection-conflict').waitFor({state: 'visible'});
  assert.equal(await page.locator('#visibility-conflict-public').isEnabled(), true);
  assert.equal(await page.locator('#visibility-conflict-remove').isEnabled(), true);
  for (const width of [1280, 560]) {
    await page.setViewportSize({width, height: 950});
    await page.locator('#visibility-collection-conflict').scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({path: output + 'studio-collection-conflict-' + width + '.png'});
  }
  await page.locator('#visibility-conflict-public').click();
  assert.equal(await page.locator('#confirm-dialog').isVisible(), false, 'explicit conflict action requires no nested confirmation');
  await page.waitForFunction(() => __collectionUI.state.drafts.find(item => item.id === 'old-private').settings.visibility === 'public');
  await settle(page);
  assert.equal((await persisted(page)).drafts.find(item => item.id === 'old-private').collection.id, '1101');
  await switchDraft(page, 'old-friends');
  await page.locator('#visibility-conflict-remove').click();
  await page.waitForFunction(() => __collectionUI.state.drafts.find(item => item.id === 'old-friends').collection === null);
  await settle(page);
  assert.equal((await persisted(page)).drafts.find(item => item.id === 'old-friends').settings.visibility, 'friends');

  // 模拟确认等待期间其他入口切稿；旧回调不得把联动更改写入新草稿或原草稿。
  await switchDraft(page, 'private');
  await chooseCollection(page);
  await page.locator('#confirm-dialog[open]').waitFor();
  const pendingDraft = (await persisted(page)).drafts.find(item => item.id === 'private');
  await page.locator('.draft-item').filter({hasText: '合集回归 friends'}).evaluate(button => button.click());
  await page.waitForFunction(() => __collectionUI.state.activeDraftId === 'friends');
  await settle(page);
  if (await page.locator('#confirm-dialog').isVisible()) await page.locator('#confirm-submit').click();
  await page.waitForTimeout(550);
  const afterSwitch = await persisted(page);
  assert.deepEqual(afterSwitch.drafts.find(item => item.id === 'private'), pendingDraft, 'late confirmation cannot alter original draft');
  assert.equal(afterSwitch.drafts.find(item => item.id === 'friends').settings.visibility, 'friends');
  assert.equal(afterSwitch.drafts.find(item => item.id === 'friends').collection, null);
  assert.equal(await selectedVisibility(page), 'friends');

  // 明确离线后仍可处理本机冲突、修改和保存；不偷偷登录或重新检查平台账号。
  const offlinePage = await openFixture({active: 'old-private', offline: true, width: 560});
  await offlinePage.waitForFunction(() => __collectionUI.requests.some(item => item.path === '/web/api/media/activity/get/'));
  await offlinePage.locator('#connection-label').filter({hasText: '离线'}).waitFor();
  assert.equal(await persistCount(offlinePage), 0);
  assert.equal(await offlinePage.locator('#collection-name').textContent(), '周末摄影');
  await offlinePage.locator('#visibility-conflict-remove').click();
  await offlinePage.waitForFunction(() => __collectionUI.state.drafts.find(item => item.id === 'old-private').collection === null);
  await offlinePage.locator('#description').fill('离线继续编辑本机草稿');
  await offlinePage.locator('#save-draft').click();
  await settle(offlinePage);
  const offlineDraft = (await persisted(offlinePage)).drafts.find(item => item.id === 'old-private');
  assert.equal(offlineDraft.description, '离线继续编辑本机草稿');
  assert.equal(offlineDraft.settings.visibility, 'private');
  assert.equal(offlineDraft.title, '本机标题 old-private');

  for (const candidate of pages) {
    assert.equal(await candidate.evaluate(() => __collectionUI.requests.some(item => /user\/info|upload|create_v2/.test(item.path) || item.method !== 'GET')), false);
    assert.equal(await candidate.evaluate(() => __collectionUI.messages.some(item => item.op === 'session.login' || item.op === 'assets.select' || item.op.startsWith('body.'))), false);
  }
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  console.log('collection visibility UI passed: public direct selection, private/friends confirmation, cancel/Escape persistence, duplicate clicks, restored conflicts, draft-switch ownership, offline edits, 1280/560 layouts, no account checks/uploads/publication');
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
