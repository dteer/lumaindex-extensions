import assert from 'node:assert/strict';
import {createStudioEngine} from '../app/platform/studio-engine.js';

const origin = 'http://127.0.0.1:8765';
const draft = (extra = {}) => ({id: 'draft-native', name: '合成测试作品', kind: 'image', assets: [{id: 'asset-a', name: 'photo.jpg', kind: 'image'}], title: '作品', description: '正文', topics: [], mentions: [], music: null, location: null, collection: null, cover: null, settings: {visibility: 'public', download: 'allow', publishTime: 'now', scheduledAt: '', declarations: []}, ...extra});

// harness 只模拟固定平台业务回执和图库上传元信息，不调用系统浏览器或真实网络。
function harness(shared = {}) {
  const values = shared.values || {}, state = {account: '123', queries: 0, uploads: 0, posts: [], failPost: false};
  let counter = 0;
  const storage = {
    async get(key) { return structuredClone(key ? {[key]: values[key]} : values); },
    async set(update) { Object.assign(values, structuredClone(update)); },
  };
  const send = async (input, options = {}) => {
    const url = new URL(input); assert.equal(url.origin, 'https://creator.douyin.com');
    let data;
    switch (url.pathname) {
      case '/web/api/media/user/info/': data = {status_code: 0, user: {uid: state.account, nickname: '合成账号'}}; break;
      case '/web/api/media/upload/auth/v5/': data = {status_code: 0, auth: JSON.stringify({AccessKeyID: 'synthetic-id', SecretAccessKey: 'temporary-secret', SessionToken: 'temporary-token', ExpiredTime: '2060-01-01T00:00:00Z'})}; break;
      case '/aweme/v1/search/challengesug/': state.queries++; data = {status_code: 0, sug_list: [{cid: '222', cha_name: '真实候选'}]}; break;
      case '/web/api/media/aweme/create_v2/':
        assert.equal(options.method, 'POST');
        assert.ok(JSON.stringify(values).includes('submitting'), 'submission record must be durable before request');
        state.posts.push(JSON.parse(options.body));
        state.onPost?.();
        if (state.failPost) throw Error('Simulated uncertain response');
        data = {status_code: 0, item_id: '987654'}; break;
      case '/web/api/media/item/info/': data = {status_code: 0, aweme: {timer: {status: 999}}}; break;
      default: throw Error('Unexpected endpoint: ' + url.pathname);
    }
    return new Response(JSON.stringify(data), {status: 200});
  };
  const upload = {
    async importImages(input, deps) {
      state.uploads++;
      const auth = await deps.getAuth(); assert.equal(auth.SecretAccessKey, 'temporary-secret');
      const files = input.job.assets.map((asset, index) => ({uri: `tos/native-${index}.jpg`, uriStatus: 2000, imageWidth: 1000, imageHeight: 800}));
      await deps.checkpoint(files.map((file, index) => ({account: state.account, assetID: input.job.assets[index].id, revision: 'v1', kind: 'image', uploadFile: file})));
      return {draft: await deps.buildImageDraft({files})};
    },
  };
  const engine = createStudioEngine({storage, send, upload, now: () => 1800000000000, uuid: () => `native-${++counter}`});
  const run = (operation, params = {}) => engine.dispatch(operation, params, {origin});
  return {run, engine, state, values};
}
{
  const h = harness();
  assert.equal((await h.run('studio.session')).account.id, '123');
  await assert.rejects(h.run('arbitrary.fetch'), /尚未接入/);
  await assert.rejects(h.run('publication.prepare', {draft: draft({topics: [{id: '222', name: '真实候选'}]})}), /查询记录/);
  assert.equal(h.state.uploads, 0);
  await h.run('topics.search', {query: '真实'});
  const prepared = await h.run('publication.prepare', {draft: draft({topics: [{id: '222', name: '真实候选'}]})});
  assert.equal(prepared.canPublish, true); assert.equal(h.state.queries, 3);
  assert.equal(JSON.stringify(h.values).includes('temporary-secret'), false);
  assert.equal(JSON.stringify(h.values).includes('temporary-token'), false);
  const request = {preparationId: prepared.preparationId, requestId: 'request-one', expectedAccountId: '123', confirmed: true};
  assert.equal((await h.run('publication.publish', request)).status, 'processing');
  assert.equal((await h.run('publication.publish', {...request, requestId: 'request-alias'})).status, 'processing');
  assert.equal(h.state.posts.length, 1);
  assert.equal((await h.run('publication.status', {requestId: 'request-one'})).status, 'processing');
  h.state.account = '456';
  await assert.rejects(h.run('publication.status', {requestId: 'request-one'}), /其他抖音账号/);
}
{
  const h = harness(); h.state.failPost = true;
  const prepared = await h.run('publication.prepare', {draft: draft()});
  const request = {preparationId: prepared.preparationId, requestId: 'request-unknown', expectedAccountId: '123', confirmed: true};
  assert.equal((await h.run('publication.publish', request)).status, 'unknown');
  assert.equal(h.state.posts.length, 1);
  const restarted = harness(h);
  assert.equal((await restarted.run('publication.publish', {...request, requestId: 'request-again'})).status, 'unknown');
  assert.equal(restarted.state.posts.length, 0);
}
{
  const h = harness(), controller = new AbortController();
  h.state.failPost = true;
  h.state.onPost = () => controller.abort();
  const prepared = await h.run('publication.prepare', {draft: draft()});
  const request = {preparationId: prepared.preparationId, requestId: 'request-aborted-after-send', expectedAccountId: '123', confirmed: true};
  const result = await h.engine.dispatch('publication.publish', request, {origin, signal: controller.signal});
  assert.equal(result.status, 'unknown', 'abort after sending must not turn uncertain publication into cancellation');
  assert.equal((await h.run('publication.publish', request)).status, 'unknown');
  assert.equal(h.state.posts.length, 1);
}
console.log('native engine: fixed protocol, candidate provenance, upload checkpoints, persistent one-shot submit and unknown restart passed');
