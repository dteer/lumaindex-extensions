import assert from 'node:assert/strict';
import {createStudioClient} from '../app/studio-client.js';
import {createStudioEngine} from '../app/platform/studio-engine.js';

const origin = 'http://127.0.0.1:8765';
const account = {status_code: 0, user: {uid: '123', nickname: '合成账号'}};
const draft = {id: 'cancel-draft', name: '合成作品', kind: 'image', assets: Array.from({length: 5}, (_, index) => ({id: `asset-${index}`, name: `${index}.jpg`, kind: 'image'})), title: '作品', description: '', topics: [], mentions: [], music: null, location: null, collection: null, cover: null, settings: {visibility: 'public', download: 'allow', publishTime: 'now', scheduledAt: '', declarations: []}};

// 查询测试经过真实 client → engine → native transport，仅宿主回执使用可取消的合成响应。
{
  const controller = new AbortController(), calls = [];
  let releaseQuery, startQuery;
  const queried = new Promise(resolve => { startQuery = resolve; });
  const client = createStudioClient({context: () => ({nativeUIAvailable: true, nativeCapabilities: {sessionVersion: 1}, apiBaseURL: origin + '/api/v1'}), post: async message => {
    calls.push(message);
    if (message.op === 'session.status') return {ok: true, data: {hasCookies: true}};
    if (message.op === 'session.cancel') { releaseQuery({ok: false, error: {code: 'NETWORK_CANCELLED', message: '请求已停止'}}); return {ok: true, data: {cancelled: true}}; }
    assert.equal(message.op, 'session.request');
    if (new URL(message.url).pathname.includes('challengesug')) {
      startQuery();
      return new Promise(resolve => { releaseQuery = resolve; });
    }
    return {ok: true, data: {status: 200, headers: {}, body: JSON.stringify(account)}};
  }});
  await client.connect();
  const request = client.request('topics.search', {query: '合成'}, {signal: controller.signal});
  await queried;
  controller.abort();
  await assert.rejects(request, error => error.name === 'AbortError');
  assert.equal(calls.filter(item => item.op === 'session.cancel').length, 1);
  assert.equal(calls.filter(item => item.url?.includes('challengesug')).length, 1, 'query must not retry');
  assert.equal(calls.at(-1).op, 'session.cancel', 'no identity refresh or next query after cancellation');
}

// 准备取消覆盖两条并发上传通道；停止后不读第三张、不申请发布快照，已确认检查点继续保留。
{
  const controller = new AbortController(), values = {}, reads = [], uploads = [];
  let startUploads;
  const started = new Promise(resolve => { startUploads = resolve; });
  const engine = createStudioEngine({storage: {
    get: async key => structuredClone({[key]: values[key]}),
    set: async update => { Object.assign(values, structuredClone(update)); },
  }, send: async input => {
    const path = new URL(input).pathname;
    if (path === '/web/api/media/user/info/') return new Response(JSON.stringify(account));
    assert.equal(path, '/web/api/media/upload/auth/v5/');
    return new Response(JSON.stringify({status_code: 0, auth: JSON.stringify({AccessKeyID: 'test', SecretAccessKey: 'test', SessionToken: 'test', ExpiredTime: '2060-01-01T00:00:00Z'})}));
  }, upload: {
    resolveAssets: async job => ({assets: job.assets.map(asset => ({...asset, revision: 'v1'}))}),
    prepareFile: async (job, origin, asset) => { reads.push(asset.id); return {assetID: asset.id, revision: asset.revision, file: new File(['x'], asset.name, {type: 'image/jpeg'})}; },
    uploadImage: async (file, auth, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      uploads.push(file.name);
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new DOMException('测试取消', 'AbortError')), {once: true});
        if (uploads.length === 2) startUploads();
      });
    },
  }});
  const prepare = engine.dispatch('publication.prepare', {draft}, {origin, signal: controller.signal});
  await started;
  controller.abort();
  await assert.rejects(prepare, error => error.name === 'AbortError');
  assert.equal(reads.length, 2);
  assert.equal(uploads.length, 2);
  assert.deepEqual(values, {}, 'no invented checkpoint or completed preparation after interrupted uploads');
  await assert.rejects(engine.dispatch('publication.prepare', {draft}, {origin, signal: controller.signal}), error => error.name === 'AbortError');
  assert.equal(reads.length, 2, 'already cancelled operation must do no work');
}

console.log('native cancellation: import preservation, query reaches native cancel once, preparation stops both channels and later uploads');
