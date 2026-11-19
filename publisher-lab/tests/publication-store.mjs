import assert from 'node:assert/strict';
import {createPublicationStore} from '../app/platform/publication-store.js';

// memoryStorage 模拟插件存储的值复制和异步持久化；可在写入前失败或延迟。
function memoryStorage() {
  const values = {};
  return {
    values, failRead: false, failWrite: false, pauseWrite: null,
    async get(key) { if (this.failRead) throw Error('storage read'); return structuredClone({[key]: values[key]}); },
    async set(update) {
      if (this.pauseWrite) await this.pauseWrite;
      if (this.failWrite) throw Error('storage write');
      Object.assign(values, structuredClone(update));
    },
  };
}
let sequence = 0, clock = 100000;
const origin = 'http://127.0.0.1:8765';
const otherOrigin = 'http://127.0.0.1:8766';
const create = storage => createPublicationStore({storage, now: () => clock, uuid: () => `id-${++sequence}`});
const input = (extra = {}) => ({account: {id: 'account-a', name: '测试账号'}, draft: {title: '作品', assets: [{id: 'asset-a'}]}, payload: {title: '作品', image_uri: ['uploaded-a']}, summary: {title: '作品', kind: 'image', count: 1}, origin, ...extra});
const submission = (prepared, extra = {}) => ({preparationId: prepared.preparationId, requestId: `request-${++sequence}`, origin, expectedAccountId: 'account-a', confirmed: true, ...extra});
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

// 快照与返回对象均不能被调用者修改；过期边界准确到毫秒。
{
  const storage = memoryStorage(), store = create(storage), data = input();
  const prepared = await store.prepare(data);
  assert.equal(prepared.expiresAt, clock + 30 * 60 * 1000);
  data.payload.image_uri[0] = 'changed'; prepared.summary.title = 'changed';
  const first = await store.getPrepared(prepared.preparationId, origin, 'account-a');
  assert.equal(first.payload.image_uri[0], 'uploaded-a'); assert.equal(first.summary.title, '作品');
  first.payload.title = 'changed';
  assert.equal((await store.getPrepared(prepared.preparationId, origin, 'account-a')).payload.title, '作品');
  await rejectsCode(store.getPrepared(prepared.preparationId, otherOrigin, 'account-a'), 'PREPARATION_NOT_FOUND');
  await rejectsCode(store.getPrepared(prepared.preparationId, origin, 'account-b'), 'ACCOUNT_CHANGED');
  await rejectsCode(store.beginSubmit(submission(prepared, {confirmed: false})), 'CONFIRMATION_REQUIRED');
  clock = prepared.expiresAt;
  await rejectsCode(store.getPrepared(prepared.preparationId, origin, 'account-a'), 'PREPARATION_EXPIRED');
  await rejectsCode(store.beginSubmit(submission(prepared)), 'PREPARATION_EXPIRED');
}

// 同份准备即便换请求 ID、并发点击，也只有一个调用获得发送资格。
{
  const storage = memoryStorage(), store = create(storage), prepared = await store.prepare(input());
  const requests = [submission(prepared), submission(prepared), submission(prepared)];
  const results = await Promise.all(requests.map(value => store.beginSubmit(value)));
  assert.equal(results.filter(value => !value.duplicate).length, 1);
  assert.ok(results.filter(value => value.duplicate).every(value => value.result.status === 'unknown'));
  assert.equal((await store.findStatus({requestId: requests[2].requestId, origin})).preparationId, prepared.preparationId);
  await store.finish(prepared.preparationId, {status: 'published', publicationId: '98765', message: '已发布'});
  assert.equal((await store.beginSubmit(submission(prepared))).result.status, 'published');
  assert.equal((await store.findStatus({publicationId: '98765', origin})).status, 'published');
  assert.equal(await store.findStatus({publicationId: '98765', origin: otherOrigin}), null);
  assert.equal(await store.findStatus({requestId: requests[0].requestId, publicationId: 'wrong', origin}), null);
  const other = await store.prepare(input());
  await rejectsCode(store.beginSubmit(submission(other, {requestId: requests[2].requestId})), 'REQUEST_ID_REUSED');
  await rejectsCode(store.finish(prepared.preparationId, {status: 'failed'}), 'RESULT_CONFLICT');
  clock += 31 * 60 * 1000;
  assert.equal((await store.beginSubmit(submission(prepared))).result.status, 'published');
}

// 写入失败时不得开始网络；写入完成之前 beginSubmit 也不能提前返回。
{
  const storage = memoryStorage(), store = create(storage), prepared = await store.prepare(input());
  let networkCalls = 0;
  storage.failWrite = true;
  await rejectsCode(store.beginSubmit(submission(prepared)).then(value => { if (!value.duplicate) networkCalls++; }), 'STORAGE_WRITE_FAILED');
  assert.equal(networkCalls, 0);
  storage.failWrite = false;
  let resume;
  storage.pauseWrite = new Promise(resolve => { resume = resolve; });
  const pending = store.beginSubmit(submission(prepared)).then(value => { if (!value.duplicate) networkCalls++; return value; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(networkCalls, 0);
  resume(); storage.pauseWrite = null;
  assert.equal((await pending).duplicate, false); assert.equal(networkCalls, 1);
  await rejectsCode(store.beginSubmit(submission(prepared, {expectedAccountId: 'account-b'})), 'ACCOUNT_CHANGED');
  await rejectsCode(store.beginSubmit(submission(prepared, {origin: otherOrigin})), 'PREPARATION_NOT_FOUND');
}

// 新 worker 实例遇到已开始但无回执的记录，只恢复 unknown，不重新发请求。
{
  const storage = memoryStorage(), originalStore = create(storage), prepared = await originalStore.prepare(input());
  const request = submission(prepared);
  await originalStore.beginSubmit(request);
  const restarted = create(storage);
  const recovered = await restarted.findStatus({requestId: request.requestId, origin});
  assert.equal(recovered.status, 'unknown'); assert.match(recovered.message, /中断/);
  const duplicate = await restarted.beginSubmit(submission(prepared));
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.result.status, 'unknown');
  await restarted.finish(prepared.preparationId, {status: 'processing', publicationId: 'pending-id'});
  await restarted.finish(prepared.preparationId, {status: 'scheduled', publicationId: 'pending-id', scheduledAt: '2026-11-18T04:00:00Z'});
  assert.equal((await restarted.findStatus({publicationId: 'pending-id', origin})).status, 'scheduled');
}

// 存储错误和无效回执保持失败关闭；未知结果不会解锁同一准备记录。
{
  const storage = memoryStorage(), store = create(storage), prepared = await store.prepare(input());
  await rejectsCode(store.finish(prepared.preparationId, {status: 'published'}), 'NOT_SUBMITTED');
  const request = submission(prepared);
  await store.beginSubmit(request);
  await rejectsCode(store.finish(prepared.preparationId, {status: 'ok'}), 'INVALID_RESULT');
  await store.finish(prepared.preparationId, {status: 'unknown', message: '网络中断'});
  assert.equal((await store.beginSubmit(request)).duplicate, true);
  storage.failRead = true;
  await rejectsCode(store.findStatus({requestId: request.requestId, origin}), 'STORAGE_READ_FAILED');
  storage.failRead = false; storage.failWrite = true;
  await rejectsCode(store.finish(prepared.preparationId, {status: 'published', publicationId: 'final'}), 'STORAGE_WRITE_FAILED');
  storage.failWrite = false;
  assert.equal((await store.findStatus({requestId: request.requestId, origin})).status, 'unknown');
}

// 不保存结构化凭据字段；历史只暴露当前来源的元数据。
{
  const storage = memoryStorage(), store = create(storage);
  for (const payload of [{Cookie: 'session'}, {uploadAuth: 'upload'}, {nested: {SigningSecret: 'secret'}}]) {
    await rejectsCode(store.prepare(input({payload})), 'SENSITIVE_SNAPSHOT');
  }
  await rejectsCode(store.prepare(input({origin: 'https://example.com'})), 'INVALID_ORIGIN');
  await rejectsCode(store.prepare(input({origin: origin + '/'})), 'INVALID_ORIGIN');
  const first = await store.prepare(input());
  await store.prepare(input({origin: otherOrigin}));
  const history = await store.listHistory(origin);
  assert.equal(history.length, 1); assert.equal(history[0].preparationId, first.preparationId);
  for (const key of ['payload', 'draft', 'origin', 'accountId', 'owner']) assert.equal(Object.hasOwn(history[0], key), false);
  assert.equal((await store.listHistory(otherOrigin)).length, 1);
}

console.log('发布状态回归通过：快照隔离、30 分钟失效、防重、并发、存储失败、账号来源校验、未知结果及重启恢复。');
