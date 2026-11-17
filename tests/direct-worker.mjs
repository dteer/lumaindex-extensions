import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {validate} from '../browser/protocol.js';
import {validateLocationQuery, searchLocations} from '../browser/location.js';
import {validateCollectionQuery, listCollections} from '../browser/collection.js';
import {buildImageDraft, buildVideoDraft, withDraftCollection} from '../browser/draft-model.js';
import {importImages} from '../browser/import-images.js';
import {importVideo} from '../browser/import-video.js';
import {requestCreatorContext, draftStorage, stagingPageBinding, draftPageBinding, restoreVideoDownload, renderImportStatus, verifyDraftRender} from '../browser/draft-page.js';

const source = (await readFile(new URL('../browser/worker.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const creator = 'https://creator.douyin.com', local = 'http://127.0.0.1:1234';
const handoffURL = `${local}/api/v1/plugins/com.lumaindex.douyin/files/handoff.html`;
// stageKind 只识别由随机令牌绑定的发布准备页，不能退回旧的上传入口。
function stageKind(value) {
  const url = new URL(value);
  const kind = /^\/creator-micro\/content\/post\/(image|video)$/.exec(url.pathname)?.[1];
  return url.origin === creator && /^[a-zA-Z0-9-]{16,100}$/.test(url.searchParams.get('luma_import') || '') ? kind : undefined;
}
// routeName 在断言中去掉随机令牌，仍保留真实发布类型和完整非准备页地址。
const routeName = value => stageKind(value) ? `staging:${stageKind(value)}` : value;
const account = '123456', imageKey = `publish_cache:${account}:image`, videoKey = `publish_form_cache:${account}`;
const message = (id = 'job-1', kind = 'image') => ({op: 'continue', job: {version: 1, id, draftKey: `draft-${kind}`, kind,
  title: '标题', description: '描述', assets: [{id: 'asset-1', name: kind === 'image' ? 'one.jpg' : 'movie.mp4'}],
  settings: {visibility: 'public', download: 'allow', publishTime: 'now', location: null}}});

// storage 模拟两个独立的扩展存储域，保留真实 structuredClone 边界，避免引用共享掩盖检查点问题。
function storage() {
  const values = new Map();
  return {values, async get(key) { return key === null ? Object.fromEntries(values) : {[key]: structuredClone(values.get(key))}; },
    async set(patch) { for (const [key, value] of Object.entries(patch)) values.set(key, structuredClone(value)); },
    async remove(key) { for (const entry of Array.isArray(key) ? key : [key]) values.delete(entry); }};
}

// fixture 执行真实 worker 编排、导入模块和草稿存储函数，仅替换 Chrome、网络上传与可见 DOM 观测。
function fixture(options = {}) {
  const localStore = storage(), session = storage(), native = new Map(), events = [], statuses = [], timers = new Set();
  const setSession = session.set;
  session.set = async patch => {
    await setSession(patch);
    for (const [key, value] of Object.entries(patch)) if (value?.job) events.push({type: 'staging-job', key, value: structuredClone(value)});
  };
  let listener, clock = Date.now(), accountReads = 0, uploads = 0, resolutions = 0, reads = 0;
  const tabs = new Map();
  const newTab = (id, url = handoffURL) => {
    const tab = {id, url, status: 'complete', dataset: {}, navigationListeners: [], pageListeners: []};
    tabs.set(id, tab); return tab;
  };
  const tab = newTab(7);
  const navigateUser = (id, url, sameDocument = false) => {
    const current = tabs.get(id);
    current.navigationListeners.splice(0).forEach(callback => callback());
    if (!sameDocument) { current.pageListeners.splice(0).forEach(callback => callback()); current.dataset = {}; }
    current.url = url;
  };
  if (options.original !== undefined) native.set(options.kind === 'video' ? videoKey : imageKey, options.original);
  class Clock extends Date { static now() { return clock; } }
  const sender = {id: 'extension-id', frameId: 0, url: handoffURL, tab: {id: tab.id}};
  const env = {
    console, URL, URLSearchParams, structuredClone, Date: Clock, Error, SyntaxError, DOMException, crypto: {randomUUID},
    setTimeout(callback, ms) { clock += ms; queueMicrotask(callback); return 1; },
    setInterval(callback, ms) { const token = {callback, ms}; timers.add(token); return token; },
    clearInterval(token) { timers.delete(token); },
    location: new URL(handoffURL),
    localStorage: {getItem(key) { return native.get(key) ?? null; }, setItem(key, value) {
      events.push({type: 'native-write', key, tabId: env.targetTabId});
      if (options.quota && key === imageKey) throw new DOMException('hidden storage details', 'QuotaExceededError');
      native.set(key, value);
    }},
    WebSocket: class {},
    createBackgroundBridge() { return {async status() { return []; }, async isEnabled() { return true; }, async setEnabled() {},
      async disconnect() { events.push({type: 'disconnect'}); }, async connect(origin, channel) { return {ok: true, origin, channel}; }}; },
    validate, validateLocationQuery, searchLocations, validateCollectionQuery, listCollections, buildImageDraft, buildVideoDraft, withDraftCollection, importImages, importVideo,
    requestCreatorContext, draftStorage, stagingPageBinding, draftPageBinding, restoreVideoDownload, renderImportStatus, verifyDraftRender,
    async resolveAssets(job) { resolutions++; events.push({type: 'resolve'}); return {assets: job.assets.map(asset => ({...asset, revision: 'revision-1'})), duplicates: 0}; },
    async prepareFile(job, origin, asset) {
      assert.equal(origin, local);
      assert.ok(asset && !Array.isArray(asset), 'each read must prepare exactly one asset');
      reads++; events.push({type: 'read', assetID: asset.id});
      const size = options.fileSize || 10, type = job.kind === 'video' ? 'video/mp4' : 'image/jpeg';
      return {assetID: asset.id, revision: asset.revision, name: asset.name, type, size, file: {name: asset.name, size, type}};
    },
    async cropCoverFile() { throw Error('unexpected crop'); },
    async uploadImage() {
      const uploadIndex = ++uploads; events.push({type: 'upload'});
      await options.onUpload?.();
      if (options.uploadError) throw options.uploadError instanceof Error ? options.uploadError : Error('模拟上传失败');
      if (options.conflict) native.set(imageKey, '{"files":[],"title":"人工修改"}');
      return {uploadFile: {uri: `image/resource-${uploadIndex}`, uriStatus: 2000, imageWidth: 10, imageHeight: 10, key: `image-${uploadIndex}`}};
    },
    async uploadVideo() { uploads++; events.push({type: 'upload'}); return {vid: 'video-resource', uploadFile: {vid: 'video-resource', name: 'movie.mp4', size: 10, type: 'video/mp4'}}; },
  };
  const context = vm.createContext(env);
  env.chrome = {
    storage: {local: localStore, session},
    runtime: {id: sender.id, getURL: path => `chrome-extension://${sender.id}/${path}`, async getPlatformInfo() {},
      async sendMessage(message) {
        assert.equal(message.op, 'staging-progress');
        events.push({type: 'staging-progress', message: structuredClone(message)});
        statuses.push(message.message);
      },
      onMessage: {addListener(fn) { listener = fn; }}},
    tabs: {
      async update(id, patch) {
        assert.notEqual(new URL(patch.url).pathname, '/creator-micro/content/upload', 'all import paths must enter the publishing preparation page directly');
        assert.ok(tabs.has(id)); events.push({type: 'navigate', url: patch.url, tabId: id});
        options.beforeNavigate?.(id, patch.url, native);
        navigateUser(id, patch.url);
        // 主文档 CSP 隔离原生脚本，document_end 内容脚本挂载准备页并标记本次令牌。
        if (stageKind(patch.url)) tabs.get(id).dataset.lumaStagingToken = new URL(patch.url).searchParams.get('luma_import');
        return {id, url: patch.url, status: 'complete'};
      },
      async get(id) { const current = tabs.get(id); if (!current) throw Error('No such tab'); return {id, url: current.url, status: current.status}; },
      async query() { return [...tabs.values()].map(({id, url, status}) => ({id, url, status})); },
      async remove(id) { events.push({type: 'close', id}); tabs.delete(id); },
    },
    scripting: {async executeScript({target, world, func, args, injectImmediately}) {
      const current = tabs.get(target.tabId); assert.ok(current);
      assert.equal(world, 'ISOLATED');
      assert.equal(injectImmediately, true, 'publishing preparation and readback requests must inject without an idle wait');
      env.targetTabId = current.id;
      env.location = new URL(current.url);
      env.document = {documentElement: {dataset: current.dataset}};
      env.navigation = {addEventListener(event, callback) { assert.equal(event, 'navigate'); current.navigationListeners.push(callback); }};
      env.addEventListener = (event, callback) => { assert.equal(event, 'pagehide'); current.pageListeners.push(callback); };
      events.push({type: 'inject', name: func.name, operation: args[0], tabId: current.id, skipVideoDownload: args[2]});
      let result;
      if (func === requestCreatorContext) {
        if (args[0] === 'account') {
          accountReads++;
          result = {ok: true, account: options.changeAccountAt === accountReads ? '999999' : options.accountByTab?.[current.id] || account};
          options.onAccountRead?.(current.id, accountReads, navigateUser);
        }
        else if (args[0] === 'auth') result = {ok: true, auth: {SecretAccessKey: 'memory-only-test-secret'}};
        else if(args[0] === 'video-enable') result={ok:true,data:{status_code:0}};
        else { assert.equal(args[0], 'video-status'); result = {ok: true, data: {encode: 1, play_url:'https://video.example/play', duration: 5, width: 1920, height: 1080, poster_uri: 'video/cover', format: 'mp4'}}; }
      } else if (func === draftStorage || func === draftPageBinding || func === stagingPageBinding) {
        if (func === draftStorage) {
          assert.equal(stageKind(current.url), args[1].kind);
          assert.equal(args[1].stagingToken, current.dataset.lumaStagingToken);
        }
        // 实际 Chrome 的对象参数可能省略 null 属性；CAS 用明确存在标记，不能依赖 null 透传。
        context.injectedArgs = JSON.parse(JSON.stringify(args,(key,value)=>value === null ? undefined : value));
        result = vm.runInContext(`(${func.toString()})(...injectedArgs)`, context);
      } else if (func === renderImportStatus) {
        statuses.push(args[0]); result = {ok: true};
      } else if (func === restoreVideoDownload) {
        // 唯一授权的原生设置操作必须拥有当前视频页的 DOM 和 session 双重绑定。
        assert.equal(args.length, 1);
        assert.equal(current.url, `${creator}/creator-micro/content/post/video?enter_from=draft`);
        assert.equal(args[0], current.dataset.lumaDirectDraftMarker);
        const binding = session.values.get(`direct-page:${local}:draft-video`);
        assert.equal(binding.tabId, current.id);
        assert.equal(binding.marker, args[0]);
        result = options.downloadFailure ? {ok: false, error: '视频保存权限未稳定恢复'} : {ok: true};
      } else if (func === verifyDraftRender) {
        assert.equal(current.url, `${creator}/creator-micro/content/post/${args[1]}?enter_from=draft`);
        // 前置回读只允许跳过视频禁止保存项，其余作品与设置仍由真实 worker 等待核验。
        if (args[2] === true) { assert.equal(args[1], 'video'); assert.equal(args[0].cache.download, 0); }
        result = options.visibleFailure ? {ok: false, error: '原生内容尚未恢复'} : {ok: true};
      } else if (func === listCollections) {
        result = options.collectionResult?.(args[0]) || {ok:true,data:{items:options.collections || [],nextCursor:null}};
      } else if (func === searchLocations) result = {ok: true, data: {items: options.locations || [], nextPage: null}};
      else assert.fail(`unexpected injected function: ${func.name}`);
      return [{result}];
    }},
  };
  vm.runInContext(source, context, {filename: 'browser/worker.js'});
  return {native, events, statuses, timers, localStore, session, sender, tabs, navigateUser,
    openHandoff(id) { newTab(id); return {...sender, tab: {id}}; },
    get uploads() { return uploads; }, get reads() { return reads; }, get resolutions() { return resolutions; },
    send(input = message(), from = sender) { return new Promise(resolve => { assert.equal(listener(input, from, resolve), true); }); }};
}

// 完整成功链路必须先退出旧编辑器，再 CAS 写入草稿，最后恢复原生界面。
const first = fixture({original: '{"files":[],"title":"原草稿"}'});
assert.equal((await first.send()).ok, true);
const sequence = first.events.filter(event => event.type === 'navigate' || (event.type === 'native-write' && event.key === imageKey));
assert.deepEqual(sequence.map(event => event.url ? routeName(event.url) : event.key), ['staging:image', imageKey, `${creator}/creator-micro/content/post/image?enter_from=draft`]);
const stageIndex = first.events.findIndex(event => event.type === 'navigate' && stageKind(event.url) === 'image');
for (const type of ['resolve', 'read', 'upload']) assert.ok(first.events.findIndex(event => event.type === type) > stageIndex, type);
assert.ok(first.events.some(event => event.type === 'staging-job' && event.value.job.id === 'job-1'));
assert.ok(first.events.some(event => event.type === 'staging-progress'));
for (const event of first.events.filter(event => event.type === 'staging-progress')) {
  assert.deepEqual(Object.keys(event.message).sort(), ['details', 'failed', 'message', 'op', 'token']);
  assert.equal(event.message.op, 'staging-progress');
}
assert.ok(first.events.filter(event => event.type === 'navigate').every(event => new URL(event.url).pathname !== '/creator-micro/content/upload'));
assert.ok(first.events.filter(event => event.type === 'navigate' && stageKind(event.url)).every(event => [...new URL(event.url).searchParams.keys()].join(',') === 'luma_import'));
assert.doesNotMatch(JSON.stringify([...first.localStore.values]), /"description":"描述"|"job":/);
assert.equal([...first.session.values.keys()].some(key => key.startsWith('staging:') || key.startsWith('staging-draft:')), false);
assert.equal(JSON.parse(first.native.get(imageKey)).title, '标题');
assert.equal(JSON.parse(first.native.get(`luma_import_backup:${account}:image`)).raw, '{"files":[],"title":"原草稿"}');
assert.equal(first.uploads, 1);
assert.equal(first.timers.size, 0);
assert.doesNotMatch(JSON.stringify([...first.localStore.values]), /memory-only-test-secret/);
assert.equal(first.session.values.get(`handoff:${local}:job-1`).state, 'installed');
assert.equal(first.events.some(event => event.name === 'restoreVideoDownload'), false);

// 同一交接任务重复投递不动页面；用户主动产生的新任务只复用成功资源。
const eventCount = first.events.length;
assert.equal((await first.send()).ok, false);
assert.equal(first.events.length, eventCount);
assert.equal((await first.send(message('job-2'))).ok, true);
assert.equal(first.uploads, 1);
assert.equal(first.reads, 1);

// 多图任务按实际单文件计数；模拟总量超过 80 MiB 时 worker 不得另设图文总量限制。
// 真实单文件读取限额由 media 测试覆盖，此处检查新 API、完整顺序及资源复用编排。
const manyImages = fixture({fileSize: 6 * 1024 * 1024}), manyJob = message('seventeen-images');
manyJob.job.assets = Array.from({length: 17}, (_, index) => ({id: `asset-${index + 1}`, name: `image-${index + 1}.jpg`}));
assert.equal((await manyImages.send(manyJob)).ok, true);
assert.equal(manyImages.reads, 17);
assert.equal(manyImages.uploads, 17);
assert.equal(JSON.parse(manyImages.native.get(imageKey)).files.length, 17);
assert.deepEqual(manyImages.events.filter(event => event.type === 'read').map(event => event.assetID), manyJob.job.assets.map(asset => asset.id));
const allRecords = [...manyImages.localStore.values.values()].flatMap(value => value.records || []);
assert.equal(allRecords.length, 17);
assert.ok(allRecords.every(record => record.uploadFile.uriStatus === 2000 && !Object.hasOwn(record, 'file')));
assert.doesNotMatch(JSON.stringify([...manyImages.localStore.values]), /"file":|"base64":|memory-only-test-secret/);
const repeatMany = structuredClone(manyJob); repeatMany.job.id = 'seventeen-images-again';
assert.equal((await manyImages.send(repeatMany)).ok, true);
assert.equal(manyImages.reads, 17, 'reused resources must not read any files again');
assert.equal(manyImages.uploads, 17);

for (const changeAccountAt of [2, 3]) {
  const changed = fixture({changeAccountAt});
  const result = await changed.send();
  assert.equal(result.ok, false);
  assert.match(result.error, /账号已切换/);
  assert.equal(changed.native.has(imageKey), false);
  assert.equal(changed.events.filter(event => event.type === 'navigate').length, 1);
  assert.equal(stageKind(changed.tabs.get(7).url), 'image');
  assert.equal(changed.uploads, changeAccountAt === 2 ? 0 : 1);
  assert.equal(changed.timers.size, 0);
}
const conflict = fixture({conflict: true});
assert.equal((await conflict.send()).ok, false);
assert.equal(JSON.parse(conflict.native.get(imageKey)).title, '人工修改');
assert.equal(conflict.events.filter(event => event.type === 'navigate').length, 1);
assert.equal(stageKind(conflict.tabs.get(7).url), 'image');
assert.equal(conflict.uploads, 1);
const full = fixture({quota: true});
assert.equal((await full.send()).ok, false);
assert.equal(full.native.has(imageKey), false);
assert.equal(stageKind(full.tabs.get(7).url), 'image');
assert.equal(full.timers.size, 0);

// 上传成功但界面回读失败不能伪报完成；轮询只重读，不重传/重写。
const failedView = fixture({visibleFailure: true});
assert.equal((await failedView.send()).ok, false);
assert.equal(failedView.uploads, 1);
assert.equal(failedView.events.filter(event => event.type === 'native-write' && event.key === imageKey).length, 1);
assert.ok(failedView.events.filter(event => event.name === 'verifyDraftRender').length > 1);
assert.ok(failedView.statuses.at(-1).startsWith('带入未完成'));
assert.equal(failedView.timers.size, 0);
assert.equal((await failedView.send()).ok, false);

const movie = fixture({kind: 'video'});
assert.equal((await movie.send(message('video-job', 'video'))).ok, true);
assert.equal(movie.native.has(imageKey), false);
assert.equal(JSON.parse(movie.native.get(videoKey)).cache.longFileInfo.vid, 'video-resource');
assert.ok(movie.events.some(event => event.operation === 'video-status'));
assert.equal(movie.events.some(event => event.name === 'restoreVideoDownload'), false);

// 禁止保存仅为视频触发唯一原生补写；图文沿用缓存恢复，不能扩展为通用控件操作。
const imageDenied = fixture(), deniedImageJob = message('image-deny');
deniedImageJob.job.settings.download = 'deny';
assert.equal((await imageDenied.send(deniedImageJob)).ok, true);
assert.equal(JSON.parse(imageDenied.native.get(imageKey)).download, 0);
assert.equal(imageDenied.events.some(event => event.name === 'restoreVideoDownload'), false);

const movieDenied = fixture({kind: 'video'}), deniedVideoJob = message('video-deny', 'video');
deniedVideoJob.job.settings.download = 'deny';
assert.equal((await movieDenied.send(deniedVideoJob)).ok, true);
assert.equal(JSON.parse(movieDenied.native.get(videoKey)).cache.download, 0);
assert.equal(movieDenied.events.filter(event => event.name === 'restoreVideoDownload').length, 1);
const markedIndex = movieDenied.events.findIndex(event => event.name === 'draftPageBinding' && event.operation === 'mark');
const preverifiedIndex = movieDenied.events.findIndex(event => event.name === 'verifyDraftRender' && event.skipVideoDownload === true);
const restoredIndex = movieDenied.events.findIndex(event => event.name === 'restoreVideoDownload');
const verifiedIndex = movieDenied.events.findIndex(event => event.name === 'verifyDraftRender' && event.skipVideoDownload !== true);
assert.ok(markedIndex >= 0 && preverifiedIndex > markedIndex && restoredIndex > preverifiedIndex && verifiedIndex > restoredIndex);
assert.ok(movieDenied.events.slice(preverifiedIndex + 1, restoredIndex).some(event => event.name === 'requestCreatorContext' && event.operation === 'account'));
assert.equal(movieDenied.uploads, 1);
assert.equal(movieDenied.timers.size, 0);

// 原生权限补写失败就结束本次任务，不能伪报成功、重试补写或再次上传；新任务仍复用已确认视频。
const deniedFailureOptions = {kind: 'video', downloadFailure: true}, deniedFailure = fixture(deniedFailureOptions);
const deniedFailureJob = message('video-deny-failure', 'video'); deniedFailureJob.job.settings.download = 'deny';
const deniedFailureResult = await deniedFailure.send(deniedFailureJob);
assert.equal(deniedFailureResult.ok, false);
assert.match(deniedFailureResult.error, /视频保存权限未稳定恢复/);
assert.equal(deniedFailure.events.filter(event => event.name === 'restoreVideoDownload').length, 1);
assert.equal(deniedFailure.events.filter(event => event.name === 'verifyDraftRender' && event.skipVideoDownload === true).length, 1);
assert.equal(deniedFailure.events.some(event => event.name === 'verifyDraftRender' && event.skipVideoDownload !== true), false);
assert.equal(deniedFailure.events.filter(event => event.type === 'native-write' && event.key === videoKey).length, 1);
assert.equal(deniedFailure.uploads, 1); assert.equal(deniedFailure.timers.size, 0);
assert.ok(deniedFailure.statuses.at(-1).startsWith('带入未完成'));
const rejectedCount = deniedFailure.events.length;
assert.equal((await deniedFailure.send(deniedFailureJob)).ok, false);
assert.equal(deniedFailure.events.length, rejectedCount);
deniedFailureOptions.downloadFailure = false;
const deniedRetryJob = message('video-deny-retry', 'video'); deniedRetryJob.job.settings.download = 'deny';
assert.equal((await deniedFailure.send(deniedRetryJob, deniedFailure.openHandoff(8))).ok, true);
assert.equal(deniedFailure.uploads, 1); assert.equal(deniedFailure.reads, 1);
assert.equal(deniedFailure.events.filter(event => event.name === 'restoreVideoDownload').length, 2);
assert.equal(deniedFailure.events.filter(event => event.name === 'verifyDraftRender' && event.skipVideoDownload !== true).length, 1);
assert.equal(deniedFailure.tabs.has(8), false);

// 其他原生内容尚未就绪时只做前置回读，绝不能提前点击保存选项或执行最终成功回读。
const deniedUnready = fixture({kind: 'video', visibleFailure: true}), deniedUnreadyJob = message('video-deny-unready', 'video');
deniedUnreadyJob.job.settings.download = 'deny';
assert.equal((await deniedUnready.send(deniedUnreadyJob)).ok, false);
assert.equal(deniedUnready.events.some(event => event.name === 'restoreVideoDownload'), false);
assert.ok(deniedUnready.events.filter(event => event.name === 'verifyDraftRender' && event.skipVideoDownload === true).length > 1);
assert.equal(deniedUnready.events.some(event => event.name === 'verifyDraftRender' && event.skipVideoDownload !== true), false);
assert.equal(deniedUnready.uploads, 1); assert.equal(deniedUnready.timers.size, 0);

for (const [kind, original] of [['image', '{"files":[],"modifyId":"published"}'], ['video', '{"cache":{"modifyItemId":"published"}}']]) {
  const published = fixture({kind, original});
  assert.equal((await published.send(message('published-check', kind))).ok, false);
  assert.equal(published.uploads, 0);
  assert.equal(published.native.get(kind === 'image' ? imageKey : videoKey), original);
}

// 未授权来源、子框架和旧操作均在导航与上传之前拒绝。
for (const patch of [{id: 'another-extension'}, {frameId: 1}, {url: 'https://evil.example/handoff.html'}, {url: `${local}/unrelated`}]) {
  const invalid = fixture();
  assert.equal((await invalid.send(message(), {...invalid.sender, ...patch})).ok, false);
  assert.equal(invalid.events.length, 0);
}
const invalid = fixture();
assert.equal((await invalid.send({...message(), op: 'fill'})).ok, false);
assert.equal((await invalid.send({op: 'bridge-disconnect'})).ok, false);
assert.equal(invalid.events.length, 0);
assert.equal((await invalid.send({op: 'bridge-status'}, {...invalid.sender, url: 'chrome-extension://extension-id/settings.html'})).ok, true);
assert.equal((await invalid.send({op: 'connect-background', channel: 'a'.repeat(64)}, {...invalid.sender, url: `${local}/api/v1/plugins/com.lumaindex.douyin/files/relay.html#${'b'.repeat(64)}`})).ok, false);

// 同草稿并发带入不能启动第二次上传，锁最终必须释放。
let release, started;
const ready = new Promise(resolve => { started = resolve; });
const gate = new Promise(resolve => { release = resolve; });
const concurrent = fixture({onUpload: async () => { started(); await gate; }});
const running = concurrent.send();
await ready;
assert.equal((await concurrent.send(message('second-job'))).ok, false);
assert.equal(concurrent.uploads, 1);

// 只有本次发布准备页内的扩展 iframe 可以读取 session 草稿，frame 例外不允许执行导入或其他操作。
const stagingToken = new URL(concurrent.tabs.get(7).url).searchParams.get('luma_import');
const stagingSender = {...concurrent.sender, frameId: 1, url: `chrome-extension://extension-id/staging.html?token=${stagingToken}`};
const contextResponse = await concurrent.send({op: 'staging-context', token: stagingToken, job: {title: '伪造内容'}}, stagingSender);
assert.equal(contextResponse.ok, true);
assert.deepEqual(JSON.parse(JSON.stringify(contextResponse.job)), message().job);
assert.equal(contextResponse.origin, local);
assert.equal(contextResponse.progress.failed, false);
assert.equal(Object.hasOwn(contextResponse, 'lock'), false);
assert.equal(Object.hasOwn(contextResponse, 'auth'), false);
const extraSender = concurrent.openHandoff(9);
for (const patch of [
  {id: 'another-extension'}, {frameId: 0}, {frameId: -1}, {tab: undefined}, {tab: extraSender.tab},
  {url: `${creator}/creator-micro/content/post/image?luma_import=${stagingToken}`},
  {url: `chrome-extension://extension-id/staging.html?token=${stagingToken}&extra=1`},
  {url: `chrome-extension://extension-id/settings.html?token=${stagingToken}`},
]) assert.equal((await concurrent.send({op: 'staging-context', token: stagingToken}, {...stagingSender, ...patch})).ok, false);
const missingToken = randomUUID();
assert.equal((await concurrent.send({op: 'staging-context', token: missingToken}, {...stagingSender, url: `chrome-extension://extension-id/staging.html?token=${missingToken}`})).ok, false);
assert.equal((await concurrent.send({op: 'staging-context', token: 'invalid'}, stagingSender)).ok, false);
assert.equal((await concurrent.send(message('iframe-import'), stagingSender)).ok, false);
assert.equal((await concurrent.send({op: 'staging-progress', token: stagingToken, message: '伪造成功'}, stagingSender)).ok, false);
const originalToken = concurrent.tabs.get(7).dataset.lumaStagingToken;
concurrent.tabs.get(7).dataset.lumaStagingToken = randomUUID();
assert.equal((await concurrent.send({op: 'staging-context', token: stagingToken}, stagingSender)).ok, false);
concurrent.tabs.get(7).dataset.lumaStagingToken = originalToken;
assert.equal(concurrent.uploads, 1);
release();
assert.equal((await running).ok, true);
assert.equal(concurrent.timers.size, 0);
assert.equal((await concurrent.send({op: 'staging-context', token: stagingToken}, stagingSender)).ok, false);
assert.equal((await concurrent.send(message('third-job'))).ok, true);
assert.equal(concurrent.uploads, 1);

// 新交接任务复用同草稿绑定页；退出旧编辑器产生的最终缓存必须先读出再比较写入。
const bindingKey = `direct-page:${local}:draft-image`, reboundOptions = {}, rebound = fixture(reboundOptions);
assert.equal((await rebound.send()).ok, true);
const initialBinding = rebound.session.values.get(bindingKey);
assert.equal(initialBinding.tabId, 7);
assert.equal(initialBinding.account, account);
assert.equal(rebound.tabs.get(7).dataset.lumaDirectDraftMarker, initialBinding.marker);
const nextSender = rebound.openHandoff(8), start = rebound.events.length;
reboundOptions.beforeNavigate = (id, url, native) => {
  if (id === 7 && stageKind(url) === 'image') native.set(imageKey, '{"files":[],"title":"旧编辑器卸载保存"}');
};
assert.equal((await rebound.send(message('rebound'), nextSender)).ok, true);
const repeated = rebound.events.slice(start);
assert.deepEqual(repeated.filter(event => event.type === 'navigate').map(({tabId, url}) => [tabId, routeName(url)]), [
  [8, 'staging:image'], [7, 'staging:image'], [7, `${creator}/creator-micro/content/post/image?enter_from=draft`],
]);
assert.deepEqual(repeated.filter(event => event.type === 'native-write' && event.key === imageKey).map(event => event.tabId), [7]);
assert.equal(JSON.parse(rebound.native.get(`luma_import_backup:${account}:image`)).raw, '{"files":[],"title":"旧编辑器卸载保存"}');
assert.equal(rebound.tabs.has(8), false);
assert.equal(rebound.uploads, 1);
assert.equal(rebound.reads, 1);
assert.equal(rebound.session.values.get('handoff:' + local + ':rebound').tabId, 7);
assert.notEqual(rebound.session.values.get(bindingKey).marker, initialBinding.marker);
assert.ok(repeated.findIndex(event => event.name === 'draftPageBinding' && event.operation === 'mark') < repeated.findIndex(event => event.name === 'verifyDraftRender'));

// 原生回读失败仍保留新绑定；随后人工再次提交可复用同页及上传成果，不受旧任务回执干扰。
const slowOptions = {visibleFailure: true}, slow = fixture(slowOptions);
assert.equal((await slow.send()).ok, false);
assert.equal(slow.session.values.get(bindingKey).tabId, 7);
slowOptions.visibleFailure = false;
assert.equal((await slow.send(message('retry-render'), slow.openHandoff(8))).ok, true);
assert.equal(slow.session.values.get(bindingKey).tabId, 7);
assert.equal(slow.tabs.has(8), false);
assert.equal(slow.uploads, 1);

// 旧页丢失、路由/类型/标记/账号变化均只使用本次交接页，绝不能导航或关闭旧用户页。
for (const invalidation of ['closed', 'path', 'kind', 'published', 'marker', 'stored-account', 'live-account', 'spa-round-trip', 'during-account']) {
  const opts = {}, check = fixture(opts);
  assert.equal((await check.send()).ok, true);
  const savedBinding = check.session.values.get(bindingKey);
  if (invalidation === 'closed') check.tabs.delete(7);
  if (invalidation === 'path') check.navigateUser(7, `${creator}/creator-micro/home`);
  if (invalidation === 'kind') check.navigateUser(7, `${creator}/creator-micro/content/post/video?enter_from=draft`);
  if (invalidation === 'published') check.tabs.get(7).url += '&iid=published';
  if (invalidation === 'marker') check.tabs.get(7).dataset.lumaDirectDraftMarker = 'someone-elses-page-marker';
  if (invalidation === 'stored-account') check.session.values.set(bindingKey, {...savedBinding, account: '999999'});
  if (invalidation === 'live-account') opts.accountByTab = {7: '999999'};
  if (invalidation === 'spa-round-trip') {
    const oldURL = check.tabs.get(7).url;
    check.navigateUser(7, `${creator}/creator-micro/home`, true);
    check.navigateUser(7, oldURL, true);
  }
  if (invalidation === 'during-account') opts.onAccountRead = (id, count, navigate) => { if (id === 7) navigate(7, `${creator}/creator-micro/home`, true); };
  const before = check.events.length, freshSender = check.openHandoff(8);
  assert.equal((await check.send(message('fresh'), freshSender)).ok, true, invalidation);
  const changedEvents = check.events.slice(before);
  assert.ok(changedEvents.filter(event => event.type === 'navigate').every(event => event.tabId === 8), invalidation);
  assert.equal(changedEvents.some(event => event.type === 'close'), false, invalidation);
  assert.equal(check.session.values.get(bindingKey).tabId, 8, invalidation);
}

// 复用中明确失败时结果留在绑定页，关闭新的空交接页；用户主动导航的新页则保留。
const uploadFailureOptions = {}, uploadFailure = fixture(uploadFailureOptions);
assert.equal((await uploadFailure.send()).ok, true);
uploadFailureOptions.uploadError = true;
const replacementJob = message('failed-replacement'); replacementJob.job.assets[0].id = 'asset-2';
assert.equal((await uploadFailure.send(replacementJob, uploadFailure.openHandoff(8))).ok, false);
assert.equal(uploadFailure.tabs.has(8), false);
assert.equal(stageKind(uploadFailure.tabs.get(7).url), 'image');
assert.ok(uploadFailure.statuses.at(-1).includes('模拟上传失败'));
const failedStageToken = new URL(uploadFailure.tabs.get(7).url).searchParams.get('luma_import');
const failedStageSender = {...uploadFailure.sender, frameId: 2, url: `chrome-extension://extension-id/staging.html?token=${failedStageToken}`};
const failedStageContext = await uploadFailure.send({op: 'staging-context', token: failedStageToken}, failedStageSender);
assert.equal(failedStageContext.ok, true); assert.equal(failedStageContext.progress.failed, true);
assert.match(failedStageContext.progress.message, /模拟上传失败/);
assert.equal(failedStageContext.job.id, replacementJob.job.id);
// 后台意外退出但未留下失败状态时，只报告中断，不恢复上传或把旧进度当作仍在执行。
const interruptedStage = uploadFailure.session.values.get(`staging:${failedStageToken}`);
interruptedStage.progress.failed = false;
uploadFailure.session.values.set(`staging:${failedStageToken}`, interruptedStage);
const beforeInterrupted = uploadFailure.uploads;
const interruptedContext = await uploadFailure.send({op: 'staging-context', token: failedStageToken}, failedStageSender);
assert.equal(interruptedContext.ok, true); assert.equal(interruptedContext.progress.failed, true);
assert.match(interruptedContext.progress.message, /连接已中断/); assert.equal(uploadFailure.uploads, beforeInterrupted);
const movedOptions = {}, moved = fixture(movedOptions);
assert.equal((await moved.send()).ok, true);
const movedSender = moved.openHandoff(8);
movedOptions.beforeNavigate = id => { if (id === 7) moved.navigateUser(8, `${creator}/creator-micro/home`); };
assert.equal((await moved.send(message('manual-navigation'), movedSender)).ok, true);
assert.equal(moved.tabs.get(8).url, `${creator}/creator-micro/home`);

// 原生视频恢复会写字符串 null；未知运行时异常不能把内部诊断直接显示到页面或回执。
const consumed = fixture({kind: 'video', original: 'null'});
assert.equal((await consumed.send(message('consumed-video', 'video'))).ok, true);
assert.equal(JSON.parse(consumed.native.get(`luma_import_backup:${account}:video`)).raw, 'null');
const unexpected = fixture({uploadError: new TypeError('Cannot read properties of null secret=internal')});
const unexpectedResult = await unexpected.send();
assert.equal(unexpectedResult.ok, false);
assert.doesNotMatch(unexpectedResult.error, /Cannot read|secret|TypeError/);
assert.doesNotMatch(unexpected.statuses.at(-1), /Cannot read|secret|TypeError/);
assert.match(unexpectedResult.error, /带入暂未完成/);
console.log('PASS immediate publishing preparation before I/O, session-only jobs, scoped iframe context, staging failure retention, CAS, tab/account guards, video-deny restoration and upload reuse');

// 合集从当前账号重新分页读取后才进入草稿；外部封套不能提供原生字段或跨账号选择。
const selectedCollection = {id:'1234567890123456789',title:'风景合集',account};
const resolvedCollection = {...selectedCollection,order:4,info:{mix_id:selectedCollection.id,mix_name:selectedCollection.title,type:0,statis:{updated_to_episode:3}}};
for (const kind of ['image','video']) {
  const task = message(`collection-${kind}`,kind);
  task.job.settings.collection = {...selectedCollection,order:999,info:{mix_id:'forged'}};
  const check = fixture({collectionResult: ({cursor})=>({ok:true,data:cursor === '0' ? {items:[],nextCursor:'10'} : {items:[resolvedCollection],nextCursor:null}})});
  assert.equal((await check.send(task)).ok,true);
  const saved = JSON.parse(check.native.get(kind === 'image' ? imageKey : videoKey));
  if (kind === 'image') assert.deepEqual(saved.collectionInfo,{mix_id:selectedCollection.id,mix_name:selectedCollection.title,mix_order:4});
  else { assert.equal(saved.cache.mixId,selectedCollection.id); assert.equal(saved.cache.mixOrder,4); assert.equal(saved.cache.mixInfo.mix_name,selectedCollection.title); }
  assert.deepEqual(check.events.filter(event=>event.name === 'listCollections').map(event=>event.operation.cursor),['0','10','0','10']);
}
for (const [patch,candidates,pattern] of [
  [{account:'99999'},[resolvedCollection],/其他抖音账号/],
  [{title:'旧名称'},[resolvedCollection],/名称已变化/],
  [{},[],/不可用/],
]) {
  const task = message('bad-collection'); task.job.settings.collection = {...selectedCollection,...patch};
  const check = fixture({collections:candidates}); const result = await check.send(task);
  assert.equal(result.ok,false); assert.match(result.error,pattern); assert.equal(check.reads,0); assert.equal(check.uploads,0);
  assert.equal(check.events.some(event=>event.type === 'native-write'),false);
}
for (const collection of [{...selectedCollection,id:'x'}, {...selectedCollection,title:''}, {...selectedCollection,account:123}, [], '123']) {
  const task = message(); task.job.settings.collection = collection;
  assert.throws(()=>validate(task,handoffURL),/合集/);
}
const privateCollectionTask = message(); privateCollectionTask.job.settings = {...privateCollectionTask.job.settings,collection:selectedCollection,visibility:'private'};
assert.throws(()=>validate(privateCollectionTask,handoffURL),/公开可见/);
console.log('PASS collection pagination, account ownership, fresh metadata, unavailable/renamed selections and public visibility guard');

// 上传后合集新增集数必须采用最新集数；删除/改名必须停止写入而保留已上传检查点。
for (const change of ['episode','deleted','renamed']) {
  let reads=0;
  const check=fixture({collectionResult:()=>({ok:true,data:{items:++reads===1 ? [resolvedCollection] : change==='deleted' ? [] : [{...resolvedCollection,order:5,...(change==='renamed'?{title:'新名称'}:{})}],nextCursor:null}})});
  const task=message(`changed-${change}`);task.job.settings.collection=selectedCollection;
  const result=await check.send(task);
  assert.equal(reads,2);assert.equal(check.uploads,1);
  if(change==='episode'){assert.equal(result.ok,true);assert.equal(JSON.parse(check.native.get(imageKey)).collectionInfo.mix_order,5);}
  else {assert.equal(result.ok,false);assert.equal(check.events.some(event=>event.type==='native-write'),false);assert.equal(check.localStore.values.get(`direct-import:${account}:${local}:draft-image`).records.length,1);}
}
console.log('PASS collection changes during upload preserve successful resources and verify the latest episode before write');
