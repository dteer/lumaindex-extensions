import assert from 'node:assert/strict';
import {createNativeFetch} from '../app/native-transport.js';
import {createStudioClient} from '../app/studio-client.js';

// nativeHost 使用合成数据模拟原生接口，测试不联网、不读取任何用户登录材料。
function nativeHost({failAppend = false} = {}) {
  const calls = [], handles = new Map(); let next = 0;
  const host = async (op, params) => {
    calls.push({op, params});
    if (op === 'body.begin') { const handle = 'body-' + ++next; handles.set(handle, {expected: params.size, parts: [], size: 0}); return {handle}; }
    if (op === 'body.append') {
      const body = handles.get(params.handle), bytes = Buffer.from(params.base64, 'base64');
      assert.ok(bytes.length <= 256 * 1024); assert.equal(params.offset, body.size);
      if (failAppend) throw Error('缓存不可用');
      body.parts.push(bytes); body.size += bytes.length; return {received: body.size};
    }
    if (op === 'body.finish') { const body = handles.get(params.handle); assert.equal(body.size, body.expected); body.ready = true; return {ready: true}; }
    if (op === 'body.remove') { handles.delete(params.handle); return {removed: true}; }
    if (op === 'session.request') { if (params.bodyHandle) assert.equal(handles.get(params.bodyHandle).ready, true); return {status: 200, headers: {'content-type': 'application/json'}, body: '{"status_code":0}'}; }
    if (op === 'session.cancel') return {cancelled: true};
    throw Error(op);
  };
  return {host, calls, handles};
}
{
  const h = nativeHost(), send = createNativeFetch(h.host, {uuid: () => 'request-body'});
  const bytes = new Uint8Array(700000); bytes.fill(23);
  assert.equal((await (await send('https://tos-test.snssdk.com/upload/v1/test', {method: 'POST', credentials: 'omit', body: bytes, headers: {Authorization: 'synthetic-upload-auth'}})).json()).status_code, 0);
  assert.equal(h.calls.filter(c => c.op === 'body.append').length, 3);
  const sent = h.calls.find(c => c.op === 'session.request').params;
  assert.equal(sent.bodyText, undefined); assert.equal(sent.credentials, 'omit'); assert.equal(sent.bodyHandle, 'body-1');
  assert.equal(h.handles.size, 0);
  const before = h.calls.length;
  await assert.rejects(send('http://remote.test/', {}), /地址无效/);
  await assert.rejects(send('https://creator.douyin.com/', {headers: {Cookie: 'forbidden'}}), /App 管理/);
  assert.equal(h.calls.length, before);
}
{
  const h = nativeHost({failAppend: true}), send = createNativeFetch(h.host);
  await assert.rejects(send('https://tos-test.snssdk.com/upload/v1/test', {method: 'POST', body: new Uint8Array(30)}), /缓存不可用/);
  assert.equal(h.calls.filter(c => c.op === 'session.request').length, 0);
  assert.equal(h.handles.size, 0, 'failed staging must be removed');
}
{
  const controller = new AbortController(); let requestCount = 0, cancelCount = 0, release;
  const send = createNativeFetch(async (op) => {
    if (op === 'session.request') { requestCount++; return new Promise(resolve => { release = resolve; }); }
    if (op === 'session.cancel') { cancelCount++; release({status: 200, body: '{}'}); return {}; }
  });
  const waiting = send('https://creator.douyin.com/web/api/media/aweme/create_v2/', {method: 'POST', body: '{}', signal: controller.signal});
  await Promise.resolve(); controller.abort();
  await assert.rejects(waiting, error => error.name === 'AbortError');
  assert.equal(requestCount, 1); assert.equal(cancelCount, 1);
}
{
  let calls = 0;
  const client = createStudioClient({context: () => ({}), post: () => { calls++; }});
  assert.equal((await client.connect()).connected, false);
  await assert.rejects(client.importSession(), /更新 App/); assert.equal(calls, 0);
}
{
  let cookies = false, cancelImport = false;
  const messages = [], data = {};
  const context = () => ({nativeUIAvailable: true, nativeCapabilities: {sessionVersion: 1}, apiBaseURL: 'http://127.0.0.1:8900/api/v1'});
  const client = createStudioClient({context, post: async message => {
    messages.push(message);
    if (message.op === 'session.status') return {ok: true, data: {hasCookies: cookies}};
    if (message.op === 'session.login') { if (cancelImport) return {ok: false, error: {code: 'SESSION_LOGIN_CANCELLED', message: '已取消登录，原有会话未改变。'}}; cookies = true; return {ok: true, data: {imported: true}}; }
    if (message.op === 'session.clear') { cookies = false; return {ok: true, data: {cleared: true}}; }
    if (message.op === 'state.get') return {ok: true, data: message.keys ? {[message.keys]: data[message.keys]} : data};
    if (message.op === 'state.set') { Object.assign(data, message.values); return {ok: true, data: {saved: true}}; }
    if (message.op === 'session.request') return {ok: true, data: {status: 200, headers: {}, body: JSON.stringify({status_code: 0, user: {uid: '123', nickname: '合成测试账号'}})}};
    throw Error(message.op);
  }});
  assert.equal((await client.connect()).connected, false);
  assert.equal(messages.filter(x => x.op === 'session.login').length, 0, 'checking must not open native import');
  const verified = await client.importSession();
  assert.equal(verified.account.id, '123'); assert.equal(verified.connected, true);
  const imported = messages.find(x => x.op === 'session.login');
  assert.deepEqual(imported, {op: 'session.login', origin: 'https://creator.douyin.com'});
  const announcements = [];
  client.onStatus(value => announcements.push(value));
  cancelImport = true;
  const beforeCancel = messages.length;
  await assert.rejects(client.importSession(), error => error.code === 'SESSION_LOGIN_CANCELLED');
  assert.deepEqual(messages.slice(beforeCancel), [{op: 'session.login', origin: 'https://creator.douyin.com'}]);
  assert.equal(announcements.length, 0, 'cancelled import must not reset existing account or preparation');
  assert.equal(cookies, true);
  assert.equal((await client.connect()).account.id, '123');
  assert.equal((await client.clearSession()).connected, false);
  await assert.rejects(client.request('publication.prepare'), /登录抖音/);
}
console.log('native transport/client: bounded chunks, cleanup, cancellation, no browser dependency, real identity gating passed');
