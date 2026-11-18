import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

// 运行完整生产页面和进度控件；仅把 client 请求边界替换为可控的合成阶段，不接触真实账号或上传。
const root = fileURLToPath(new URL('../app/', import.meta.url));
const output = fileURLToPath(new URL('../output/playwright/', import.meta.url));
await mkdir(output, {recursive: true});
const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#abc"/></svg>';
const client = `
const fixture = window.fixture;
export const studioClient = {
  onStatus(callback) { fixture.status = callback; },
  async listAccounts() { return fixture.session; },
  request(operation, params, options = {}) {
    fixture.calls.push(operation);
    if (operation !== 'publication.prepare') throw Error('Unexpected synthetic operation: ' + operation);
    return new Promise((resolve, reject) => {
      fixture.pending = {emit: options.onProgress, resolve, reject};
      options.signal.addEventListener('abort', () => reject(new DOMException('Synthetic cancellation', 'AbortError')), {once: true});
    });
  },
};`;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/studio-client.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(client); return; }
  if (url.pathname.startsWith('/api/v1/assets/')) {
    const parts = url.pathname.split('/'), id = parts[4];
    response.setHeader('Content-Type', parts.length > 5 ? 'image/svg+xml' : 'application/json');
    response.end(parts.length > 5 ? picture : JSON.stringify({code: 0, data: {id, name: id === 'independent-cover' ? '图库独立封面.jpg' : '图库素材 ' + id, mediaType: id.startsWith('video-') ? 'video' : 'image', sizeBytes: 1000}}));
    return;
  }
  const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
  try {
    response.setHeader('Content-Type', ({'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html'})[extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
const errors = [], external = [];

// openFixture 仅创建合成草稿和图库元数据，真实页面负责点击、取消、保存及完成后的重新渲染。
async function openFixture({count = 35, kind = 'image', coverId = 'independent-cover', coverName = '选中的独立封面.jpg'} = {}) {
  const page = await browser.newPage({viewport: {width: 1280, height: 960}});
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  await page.addInitScript(({origin, count, kind, coverId, coverName}) => {
    const draft = {id: 'progress-draft', name: '合成进度草稿', kind, title: '合成标题', description: '',
      assets: Array.from({length: count}, (_, index) => ({id: kind + '-' + (index + 1), name: '正文素材 ' + (index + 1), kind})),
      cover: {type: 'asset', assetId: coverId, name: coverName}, settings: {visibility: 'public', download: 'allow', publishTime: 'now'},
      topics: [], mentions: [], activities: [], receipt: null};
    window.fixture = {calls: [], pending: null, session: {connected: true, activeProfileId: 'synthetic-profile', account: {id: 'synthetic-account', name: '合成账号'},
      profiles: [], capabilities: {operations: ['publication.prepare', 'publication.publish'], limits: {imageCount: 35}}}};
    window.pluginContext = {nativeUIAvailable: true, nativeCapabilities: {sessionProfilesVersion: 1}, apiBaseURL: origin + '/api/v1',
      frontendState: {version: 2, activeDraftId: draft.id, drafts: [draft]}, libraryID: 'synthetic-progress'};
    window.webkit = {messageHandlers: {pluginUI: {postMessage: async message => {
      if (message.op !== 'persist') throw Error('Unexpected host operation: ' + message.op);
      fixture.saved = structuredClone(message.value); return {ok: true};
    }}}};
  }, {origin, count, kind, coverId, coverName});
  await page.goto(origin);
  await page.waitForFunction(() => document.body.dataset.phase === 'editing' && document.querySelector('#connection-label').textContent.includes('合成账号'));
  await page.waitForFunction(() => !document.querySelector('#prepare').disabled);
  return page;
}

// begin 通过真实按钮开始新一轮准备，确认上一轮列表由生产入口清空。
async function begin(page) {
  await page.evaluate(() => { fixture.pending = null; });
  await page.locator('#prepare').click();
  await page.waitForFunction(() => !!fixture.pending);
  assert.equal(await page.locator('#activity-items > div').count(), 0);
}
const emit = (page, values) => page.evaluate(values => { for (const value of values) fixture.pending.emit(value); }, values);
const row = (page, role, id) => page.locator('#activity-items > div[data-role="' + role + '"][data-asset-id="' + id + '"]');

try {
  const page = await openFixture();
  await begin(page);
  await emit(page, [{assetID: 'image-1', assetName: '实际名称 <1>.jpg', role: 'image', phase: 'reading', completed: 0, total: 35, countRole: 'image'}]);
  await page.evaluate(() => { window.originalProgressRow = document.querySelector('#activity-items > div'); });
  await emit(page, [{assetId: 'image-1', assetName: '实际名称 <1>.jpg', role: 'image', phase: 'uploading'},
    {assetId: 'image-1', assetName: '实际名称 <1>.jpg', role: 'image', phase: 'uploaded', message: '正在上传素材'}]);
  assert.equal(await page.locator('#activity-items > div').count(), 1, 'three phases update one row');
  assert.equal(await page.evaluate(() => originalProgressRow === document.querySelector('#activity-items > div')), true, 'the same DOM row is updated in place');
  assert.equal(await row(page, 'image', 'image-1').textContent(), '正文图片 · 实际名称 <1>.jpg上传完成');
  assert.equal(await row(page, 'image', 'image-1').locator('img').count(), 0, 'asset names stay plain text');

  const remaining = [];
  for (let index = 2; index <= 35; index += 1) for (const phase of ['reading', 'uploading', index === 2 ? 'reused' : 'uploaded']) remaining.push({assetId: 'image-' + index, role: 'image', phase, completed: index, total: 35, countRole: 'image'});
  await emit(page, remaining);
  await emit(page, [{assetID: 'independent-cover', role: 'cover', phase: 'uploading', message: '正在上传封面', completed: 35, total: 35, countRole: 'image'}]);
  assert.equal(await page.locator('#activity-items > div').count(), 36, 'all 35 body images and independent cover remain available');
  assert.match(await row(page, 'cover', 'independent-cover').textContent(), /封面 · 选中的独立封面.jpg/);
  assert.equal(await page.locator('#activity-progress').isHidden(), true, 'cover events carrying a complete body count are not total progress');
  await page.locator('#activity-items').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.locator('#activity-panel').screenshot({path: output + 'preparation-progress-wide.png'});
  await page.setViewportSize({width: 560, height: 960});
  await page.locator('#activity-panel').screenshot({path: output + 'preparation-progress-narrow.png'});
  await page.setViewportSize({width: 1280, height: 960});
  await emit(page, [{assetId: 'independent-cover', role: 'cover', phase: 'uploaded'}, {phase: 'staging', completed: 35, total: 35, countRole: 'image'}]);
  assert.equal(await page.locator('#activity-progress').isHidden(), true, 'starting final checks is not global completion');
  await page.evaluate(() => fixture.pending.resolve({preparationId: 'synthetic-preparation', canPublish: true, account: fixture.session.account}));
  await page.waitForFunction(() => !document.body.classList.contains('busy'));
  assert.equal(await page.locator('#activity-items > div').count(), 36, 'the final full-page render preserves item results');
  assert.doesNotMatch(await page.locator('#activity-items').textContent(), /正在/);
  assert.equal(await row(page, 'image', 'image-2').locator('.preparation-progress-status').textContent(), '已复用上传结果');
  assert.equal(await page.locator('#publish').isEnabled(), true, 'progress presentation preserves the successful preparation snapshot');

  await begin(page);
  await emit(page, [{assetId: 'image-1', role: 'image', phase: 'uploaded'}, {assetId: 'image-2', role: 'image', phase: 'failed', message: '合成读取失败'}, {assetId: 'image-3', role: 'image', phase: 'uploading'}]);
  await page.evaluate(() => fixture.pending.reject(Error('合成准备失败')));
  await page.waitForFunction(() => !document.body.classList.contains('busy'));
  assert.equal(await row(page, 'image', 'image-1').getAttribute('data-phase'), 'uploaded');
  assert.equal(await row(page, 'image', 'image-2').locator('.preparation-progress-status').textContent(), '合成读取失败');
  assert.equal(await row(page, 'image', 'image-3').getAttribute('data-phase'), 'stopped');

  await begin(page);
  await emit(page, [{assetId: 'image-1', role: 'image', phase: 'reused'}, {assetId: 'image-2', role: 'image', phase: 'uploading'}]);
  await page.locator('#cancel-operation').click();
  await page.waitForFunction(() => !document.body.classList.contains('busy'));
  assert.equal(await row(page, 'image', 'image-1').getAttribute('data-phase'), 'reused');
  assert.equal(await row(page, 'image', 'image-2').getAttribute('data-phase'), 'cancelled');
  await emit(page, [{assetId: 'image-2', role: 'image', phase: 'uploaded'}]);
  assert.equal(await row(page, 'image', 'image-2').getAttribute('data-phase'), 'cancelled', 'late events cannot revive a finished run');

  const sameSource = await openFixture({count: 1, coverId: 'image-1', coverName: '同源封面.jpg'});
  await begin(sameSource);
  await emit(sameSource, [{assetId: 'image-1', role: 'image', phase: 'uploaded'}, {assetId: 'image-1', role: 'cover', phase: 'uploading'}]);
  assert.equal(await sameSource.locator('#activity-items > div').count(), 2, 'same source used in body and cover has distinct purposes');
  assert.match(await row(sameSource, 'image', 'image-1').textContent(), /正文图片/);
  assert.match(await row(sameSource, 'cover', 'image-1').textContent(), /封面 · 同源封面.jpg/);
  await sameSource.evaluate(() => fixture.pending.resolve({preparationId: 'same-source-preparation', canPublish: true, account: fixture.session.account}));
  await sameSource.waitForFunction(() => !document.body.classList.contains('busy'));
  assert.equal(await row(sameSource, 'cover', 'image-1').getAttribute('data-phase'), 'completed', 'successful overall checks end any remaining active row');
  assert.doesNotMatch(await sameSource.locator('#activity-items').textContent(), /正在/);

  const metadata = await openFixture({count: 1, coverName: ''});
  await begin(metadata);
  await emit(metadata, [{assetID: 'independent-cover', role: 'cover', phase: 'reading'}]);
  assert.match(await row(metadata, 'cover', 'independent-cover').textContent(), /封面 · 图库独立封面.jpg/);
  await metadata.locator('#cancel-operation').click();
  await metadata.waitForFunction(() => !document.body.classList.contains('busy'));

  const video = await openFixture({count: 1, kind: 'video'});
  await begin(video);
  await emit(video, ['reading', 'uploading', 'uploaded', 'processing', 'ready'].map(phase => ({assetId: 'video-1', role: 'video', phase})));
  assert.equal(await video.locator('#activity-items > div').count(), 1);
  assert.equal(await row(video, 'video', 'video-1').locator('.preparation-progress-status').textContent(), '视频已就绪');
  await video.evaluate(() => fixture.pending.resolve({preparationId: 'video-preparation', canPublish: true, account: fixture.session.account}));
  await video.waitForFunction(() => !document.body.classList.contains('busy'));
  assert.equal(await row(video, 'video', 'video-1').getAttribute('data-phase'), 'ready', 'global success keeps confirmed video readiness');
  await begin(video);
  await emit(video, [{assetId: 'video-1', role: 'video', phase: 'processing'}]);
  await video.evaluate(() => fixture.pending.resolve({preparationId: 'video-final-preparation', canPublish: true, account: fixture.session.account}));
  await video.waitForFunction(() => !document.body.classList.contains('busy'));
  assert.equal(await row(video, 'video', 'video-1').getAttribute('data-phase'), 'completed', 'confirmed overall success ends a missing final video event');
  assert.doesNotMatch(await video.locator('#activity-items').textContent(), /正在/);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(await page.evaluate(() => [...new Set(fixture.calls)]), ['publication.prepare']);
  console.log('preparation progress UI passed: one row per role/asset, 35 images plus cover, source-name fallbacks, video readiness, completion/failure/cancellation, no false overall percentage, real page preparation retained; no real upload');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
