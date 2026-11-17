import assert from 'node:assert/strict';
import {createStudioWorker, capabilities} from '../browser/worker.js';

function storage() {
  const values = {};
  return {values, async get(key) { return structuredClone({[key]: values[key]}); }, async set(update) { Object.assign(values, structuredClone(update)); }};
}
let id = 0;
const origin = 'http://127.0.0.1:8765';
const draft = (extra = {}) => ({id: 'draft-a', name: '测试作品', kind: 'image', assets: [{id: 'asset-a', name: 'photo.jpg', kind: 'image'}], title: '作品', description: '正文', topics: [], mentions: [], music: null, location: null, collection: null, cover: null, settings: {visibility: 'public', download: 'allow', publishTime: 'now', scheduledAt: '', declarations: []}, ...extra});

// harness 只返回合成平台业务值，不打开浏览器、不读取用户图库、不上传素材。
function harness(shared) {
  const calls = [], local = shared?.local || storage(), session = shared?.session || storage();
  const state = {account: '123', publishMode: 'ok', queryCount: 0, payloads: [], uploadCount: 0};
  const api = {
    storage: {local, session},
    runtime: {id: 'extension-studio', getURL: path => `chrome-extension://extension-studio/${path}`, async getPlatformInfo() { return {}; }},
    tabs: {
      async query() { return [{id: 7, url: 'https://creator.douyin.com/creator-micro/home', active: true}]; },
      async get() { return {id: 7, url: 'https://creator.douyin.com/creator-micro/home'}; },
      async remove() { throw Error('Tests must not close tabs'); },
    },
    scripting: {async executeScript({world, func, args}) {
      assert.equal(world, 'ISOLATED'); calls.push([func.name, ...args]);
      const [operation, params] = args;
      if (func.name === 'creatorRequest') {
        if (operation === 'account') return [{result: {ok: true, data: {id: state.account, name: '测试摄影师'}}}];
        if (operation === 'auth') return [{result: {ok: true, auth: {AccessKeyID: 'test-id', SecretAccessKey: 'test-secret', SessionToken: 'test-token'}}}];
        if (operation === 'topics.search') { state.queryCount++; return [{result: {ok: true, data: {items: [{id: '222', name: '真实话题'}]}}}]; }
        if (operation === 'users.search') return [{result: {ok: true, data: {items: [{id: '333', name: '真实用户'}]}}}];
        if (operation === 'music.categories') return [{result: {ok: true, data: {items: [{id: '1', type: 0, name: '推荐'}]}}}];
        if (operation === 'music.list') return [{result: {ok: true, data: {items: [{id: '444', name: '真实音乐', duration: 30, previewURL: 'https://example.test/music'}]}}}];
        if (operation === 'music.validate') return [{result: {ok: true, data: {items: [{id: '555', name: '链接音乐'}]}}}];
        if (operation === 'video-enable') return [{result: {ok: true, data: {status_code: 0}}}];
        if (operation === 'video-status') return [{result: {ok: true, data: {encode: 1}}}];
        if (operation === 'publication.publish') {
          state.payloads.push(params.payload);
          if (state.publishMode === 'network') throw Error('network lost');
          if (state.publishMode === 'reject') return [{result: {ok: false, definiteFailure: true, error: '平台拒绝本次作品。'}}];
          return [{result: {ok: true, data: {publicationId: '987654', status: 'processing', message: '已收到作品'}}}];
        }
        if (operation === 'publication.status') return [{result: {ok: true, data: {publicationId: params.publicationId, status: 'processing', message: '平台正在处理'}}}];
      }
      if (func.name === 'searchLocations') return [{result: {ok: true, data: {items: [{id: '666', name: '真实公园', address: '公园路', extra: '{}'}], nextPage: null}}}];
      if (func.name === 'listCollections') return [{result: {ok: true, data: {items: [{id: '777', title: '真实合集', order: 4}], nextCursor: null}}}];
      throw Error('Unexpected request: ' + func.name + ':' + operation);
    }},
  };
  const upload = {
    async resolveAssets(job) { return {assets: job.assets.map(item => ({...item, revision: 'version-1'}))}; },
    async prepareFile(_job, _origin, asset) { return {assetID: asset.id, revision: asset.revision, file: new Blob(['test'], {type: 'image/jpeg'})}; },
    async uploadImage() { return {uploadFile: {uri: 'tos/cover.jpg', uriStatus: 2000, imageWidth: 1000, imageHeight: 1000}}; },
    async importImages(input, dependencies) {
      state.uploadCount++;
      await dependencies.getAuth();
      const files = input.job.assets.map((_, i) => ({uri: `tos/image-${i}.jpg`, uriStatus: 2000, imageWidth: 1000, imageHeight: 800}));
      await dependencies.checkpoint([{kind: 'image', assetID: 'asset-a', uploadFile: files[0]}]);
      return {draft: await dependencies.buildImageDraft({files, cover: input.job.settings.coverCrop ? {uri: 'tos/cropped.jpg', uriStatus: 2000} : undefined})};
    },
    async importVideo(input, dependencies) {
      await dependencies.getAuth(); await dependencies.enableVideo('vid-a'); await dependencies.getVideoStatus('vid-a');
      return {draft: await dependencies.buildVideoDraft({video: {vid: 'vid-a', width: 1920, height: 1080, duration: 3, coverUri: 'tos/video-cover.jpg'}})};
    },
  };
  const worker = createStudioWorker({chromeAPI: api, now: () => 1800000000000, uuid: () => `uuid-${++id}`, upload, libraryAsset: async () => ({kind: 'image', name: 'cover.jpg'})});
  const run = (operation, params = {}, ownOrigin = origin) => worker.dispatch(operation, params, {origin: ownOrigin});
  return {worker, run, state, calls, local, session};
}

// 能力、真实候选重查与不可伪造身份。
{
  const h = harness();
  assert.equal((await h.run('studio.session')).account.id, '123');
  assert.deepEqual(capabilities().byKind.video.disabledOperations, ['music.search', 'locations.search', 'collections.list']);
  await assert.rejects(h.run('arbitrary.fetch'), /尚未接入/);
  await assert.rejects(h.run('topics.search', {query: '作品'}, 'https://example.com'), /来源无效/);
  await assert.rejects(h.run('publication.prepare', {draft: draft({topics: [{id: '222', name: '真实话题'}]})}), /没有当前账号/);
  assert.equal(h.state.uploadCount, 0);
  await h.run('topics.search', {query: '真实'});
  const prepared = await h.run('publication.prepare', {draft: draft({topics: [{id: '222', name: '真实话题'}]})});
  assert.equal(prepared.canPublish, true); assert.equal(h.state.queryCount, 3);
  assert.equal(JSON.stringify(h.local.values).includes('test-secret'), false);
  assert.equal(JSON.stringify(h.session.values).includes('test-token'), false);
  assert.equal((await h.run('publication.publish', {preparationId: prepared.preparationId, requestId: 'request-a', expectedAccountId: '123', confirmed: true})).status, 'processing');
  const duplicate = await h.run('publication.publish', {preparationId: prepared.preparationId, requestId: 'request-b', expectedAccountId: '123', confirmed: true});
  assert.equal(duplicate.status, 'processing'); assert.equal(h.state.payloads.length, 1);
  assert.equal((await h.run('publication.status', {requestId: 'request-b'})).status, 'processing');
  h.state.account = '999';
  await assert.rejects(h.run('publication.status', {requestId: 'request-a'}), /其他抖音账号/);
}

// 不确定回执在 worker 重启后仍不允许重新提交。
{
  const h = harness(); h.state.publishMode = 'network';
  const prepared = await h.run('publication.prepare', {draft: draft()});
  const params = {preparationId: prepared.preparationId, requestId: 'request-unknown', expectedAccountId: '123', confirmed: true};
  assert.equal((await h.run('publication.publish', params)).status, 'unknown'); assert.equal(h.state.payloads.length, 1);
  const restarted = harness(h);
  assert.equal((await restarted.run('publication.publish', {...params, requestId: 'request-unknown-again'})).status, 'unknown');
  assert.equal(restarted.state.payloads.length, 0);
  assert.equal((await restarted.run('publication.status', {requestId: params.requestId})).status, 'unknown');
}

// 明确拒绝与缺少确认不应被当作平台已发布。
{
  const h = harness(); h.state.publishMode = 'reject';
  const prepared = await h.run('publication.prepare', {draft: draft()});
  const params = {preparationId: prepared.preparationId, requestId: 'request-reject', expectedAccountId: '123'};
  await assert.rejects(h.run('publication.publish', params), /明确确认/);
  assert.equal(h.state.payloads.length, 0);
  const result = await h.run('publication.publish', {...params, confirmed: true});
  assert.equal(result.status, 'failed'); assert.match(result.message, /平台拒绝/);
}

// 图文配乐/地点/合集必须是当前账号真实候选，视频未验证选项在上传前拒绝。
{
  const h = harness();
  await assert.rejects(h.run('music.search', {query: '关键词'}), /暂不支持关键词/);
  await assert.rejects(h.run('locations.search', {query: '公园'}), /城市/);
  await h.run('music.search', {query: ''});
  assert.equal(JSON.stringify(h.session.values).includes('example.test'), false);
  await h.run('locations.search', {query: '公园', cityCode: '310100', cityName: '上海'});
  await h.run('collections.list');
  const prepared = await h.run('publication.prepare', {draft: draft({music: {id: '444', name: '真实音乐'}, location: {id: '666', name: '真实公园'}, collection: {id: '777', name: '真实合集'}})});
  assert.equal(prepared.canPublish, true);
  await h.run('music.search', {query: 'https://v.douyin.com/music/'});
  await assert.rejects(h.run('publication.prepare', {draft: draft({music: {id: '555', name: '链接音乐'}})}), /时长/);
  const video = draft({kind: 'video', assets: [{id: 'video-a', name: 'video.mp4', kind: 'video'}]});
  await assert.rejects(h.run('publication.prepare', {draft: {...video, music: {id: '444', name: '真实音乐'}}}), /视频配乐/);
  assert.equal((await h.run('publication.prepare', {draft: video})).canPublish, true);
}

// 图片封面与裁剪路径保留，旧交接页面和外部消息不能触发新 worker。
{
  const h = harness();
  const cover = await h.run('cover.upload', {assetId: 'cover-a'});
  const prepared = await h.run('publication.prepare', {draft: draft({cover: {type: 'upload', id: cover.id}})});
  assert.equal(prepared.canPublish, true);
  assert.equal((await h.run('publication.prepare', {draft: draft({cover: {type: 'asset', assetId: 'asset-a', crop: {x: 0, y: 0, width: 1, height: 1}}})})).canPublish, true);
  await assert.rejects(h.worker.handle({op: 'studio-connect-background'}, {id: 'wrong'}), /来源无效/);
  await assert.rejects(h.worker.handle({op: 'studio-continue'}, {id: 'extension-studio'}), /旧发布/);
  await assert.rejects(h.worker.handle({op: 'studio-connect-background'}, {id: 'extension-studio', frameId: 0, tab: {id: 7}, url: 'http://127.0.0.1:8765/api/v1/plugins/com.lumaindex.douyin/files/relay.html#' + 'a'.repeat(64)}), /专属配对/);
}

console.log('worker 回归通过：真实候选重查、固定请求、账号隔离、媒体准备、封面、一次发布、防重重启和未知结果。');
