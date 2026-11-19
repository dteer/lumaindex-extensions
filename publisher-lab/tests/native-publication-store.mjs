import assert from 'node:assert/strict';
import {createPublicationStore} from '../app/platform/publication-store.js';

const origin = 'http://127.0.0.1:8765', key = 'luma-studio-publications-v1';
let clock = 100000, sequence = 0, maximumBytes = 0;
const values = {};
// storage 按真实宿主的 1 MiB 上限拒绝写入，保证回归能发现准备快照无界累计。
const storage = {
  async get(name) { return structuredClone({[name]: values[name]}); },
  async set(update) {
    const size = Buffer.byteLength(JSON.stringify({...values, ...update}));
    assert.ok(size <= 1024 * 1024, 'state must fit host quota');
    maximumBytes = Math.max(maximumBytes, size);
    Object.assign(values, structuredClone(update));
  },
};
const create = () => createPublicationStore({storage, now: () => clock, uuid: () => `native-store-${++sequence}`});
const store = create();
const input = () => ({account: {id: '123', name: '合成账号'}, origin, draft: {title: '作品', description: 'd'.repeat(40000)}, payload: {item: 'p'.repeat(40000)}, summary: {title: '作品', kind: 'image', count: 1}});
const submit = (prepared, requestId) => ({preparationId: prepared.preparationId, requestId, origin, expectedAccountId: '123', confirmed: true});

// 用户可以发布 JSON 教程；正文/标题/展示文本中的字段名不是实际凭据。
{
  const data = {};
  const textStore = createPublicationStore({storage: {
    async get(name) { return structuredClone({[name]: data[name]}); },
    async set(update) { Object.assign(data, structuredClone(update)); },
  }, now: () => clock, uuid: () => `text-store-${++sequence}`});
  const text = '{"password":"这里只是文案示例","authorization":"字段说明"}';
  const draft = {title: '["secret"]', description: text};
  const prepared = await textStore.prepare({...input(), draft, payload: {common: {text}}, summary: {title: draft.title}});
  const snapshot = await textStore.getPrepared(prepared.preparationId, origin, '123');
  assert.deepEqual(snapshot.draft, draft, 'JSON-shaped user text remains unchanged');
  assert.equal(snapshot.payload.common.text, text);
  await textStore.beginSubmit(submit(prepared, 'text-request'));
  await textStore.finish(prepared.preparationId, {status: 'unknown', message: text});
  assert.equal((await textStore.findStatus({requestId: 'text-request', origin})).message, text);
  for (const field of ['cookie', 'upload_auth', 'authorization', 'access_token', 'refresh_token', 'session_key', 'password']) {
    await assert.rejects(textStore.prepare({...input(), payload: {nested: [{[field]: 'synthetic-credential'}]}}), {code: 'SENSITIVE_SNAPSHOT'});
  }
  await assert.rejects(textStore.prepare({...input(), account: {id: '123', secret: 'synthetic-credential'}}), {code: 'SENSITIVE_SNAPSHOT'});
  await assert.rejects(textStore.finish(prepared.preparationId, {status: 'unknown', authorization: 'synthetic-credential'}), {code: 'SENSITIVE_SNAPSHOT'});
}

// 首份明确回执和后续处理中/未知/在途记录过期后仍保留，不能被快照清理解锁。
const published = await store.prepare(input());
const sent = await store.beginSubmit(submit(published, 'published-request'));
assert.equal(sent.payload.item.length, 40000, 'first send still receives immutable payload');
await store.beginSubmit(submit(published, 'published-alias'));
await store.finish(published.preparationId, {status: 'published', publicationId: '987', message: '已发布'});
const terminal = values[key].preparations[published.preparationId];
assert.equal(Object.hasOwn(terminal, 'draft'), false);
assert.equal(Object.hasOwn(terminal, 'payload'), false);
assert.equal(terminal.summary.title, '作品');
assert.equal(terminal.account.id, '123');

const unknown = await store.prepare(input());
await store.beginSubmit(submit(unknown, 'unknown-request'));
await store.finish(unknown.preparationId, {status: 'unknown', message: '回执待确认'});
const inFlight = await store.prepare(input());
await store.beginSubmit(submit(inFlight, 'inflight-request'));
let previous = await store.prepare(input());
for (let i = 0; i < 30; i++) {
  clock += 30 * 60 * 1000;
  const next = await store.prepare(input());
  assert.equal(Object.hasOwn(values[key].preparations, previous.preparationId), false, 'expired unsubmitted snapshot is removed at exact TTL');
  assert.ok(values[key].preparations[inFlight.preparationId].payload, 'inflight snapshot and evidence must survive expiry');
  assert.equal(values[key].preparations[unknown.preparationId].status, 'unknown');
  assert.equal(values[key].requestIndex['published-alias'], published.preparationId);
  previous = next;
}
assert.equal(Object.keys(values[key].preparations).length, 4, 'history survives while only latest unsubmitted snapshot remains');
assert.ok(maximumBytes < 300000, 'large expired snapshots must not accumulate toward quota');
assert.equal((await store.beginSubmit(submit(published, 'published-after-expiry'))).result.status, 'published');
assert.equal((await store.beginSubmit(submit(unknown, 'unknown-after-expiry'))).result.status, 'unknown');
assert.equal((await store.findStatus({requestId: 'published-alias', origin})).publicationId, '987');

// 重启将 submitting 恢复 unknown 后可删除 payload，但原请求、全部别名及回执仍禁止重发。
const restarted = create();
assert.equal((await restarted.findStatus({requestId: 'inflight-request', origin})).status, 'unknown');
assert.equal(Object.hasOwn(values[key].preparations[inFlight.preparationId], 'payload'), false);
assert.equal((await restarted.beginSubmit(submit(inFlight, 'inflight-alias'))).duplicate, true);
assert.equal((await restarted.findStatus({requestId: 'inflight-alias', origin})).status, 'unknown');
assert.equal((await restarted.listHistory(origin)).filter(record => record.status !== 'prepared').length, 3);
console.log('native publication storage: expired unused snapshots pruned under 1 MiB; compact receipts, history, aliases and unknown restart remain durable');
