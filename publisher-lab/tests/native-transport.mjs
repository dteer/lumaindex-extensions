import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
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
// 音乐搜索只将短期业务授权发给显式声明的无 Cookie 来源；这些头不写入通用状态。
{
  const manifest = JSON.parse(await readFile(new URL('../app/manifest.json', import.meta.url)));
  const rule = manifest.permissions.network.find(item => item.origin === 'https://tsearch.amemv.com');
  assert.deepEqual(rule, {origin: 'https://tsearch.amemv.com', pathPrefixes: ['/openapi/aweme/v1/music/search/'], methods: ['GET'], useSession: false, allowedHeaders: ['Agw-Auth', 'Openapi-Omit-Shark']});
  const creator = manifest.permissions.network.find(item => item.origin === 'https://creator.douyin.com');
  assert.ok(creator.pathPrefixes.includes('/web/api/media/aweme/search/post/auth'));
  assert.ok(creator.pathPrefixes.includes('/web/api/media/activity/get/'));
  assert.ok(creator.pathPrefixes.includes('/web/api/media/activity/detail/'));
  assert.equal(creator.allowedHeaders, undefined);
  const h = nativeHost(), send = createNativeFetch(h.host);
  await send('https://tsearch.amemv.com/openapi/aweme/v1/music/search/?keyword=fixture&cursor=0', {credentials: 'omit', headers: {'Agw-Auth': 'synthetic-signature', 'Openapi-Omit-Shark': '1'}});
  const request = h.calls.find(item => item.op === 'session.request').params;
  assert.equal(request.credentials, 'omit');
  assert.deepEqual(request.headers, {'agw-auth': 'synthetic-signature', 'openapi-omit-shark': '1'});
  assert.equal(h.calls.some(item => ['state.set', 'persist', 'body.begin'].includes(item.op)), false);
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

// profileHost 模拟宿主独立档案和 CAS；账号、会话及请求都使用合成数据，不联网。
function profileHost(count = 2) {
  const profiles = Array.from({length: count}, (_, index) => ({id: `profile-${index + 1}`, accountId: String(index + 101), name: `合成账号${index + 1}`, expiresAt: '2099-01-01T00:00:00Z', hasCookies: true}));
  const state = {profiles, active: profiles[0]?.id || null, loginAccount: '102', loginFailure: null, requestFailure: false, holdRequest: null};
  const calls = [], values = {};
  const active = () => profiles.find(item => item.id === state.active);
  const status = () => ({activeProfileId: state.active, accountId: active()?.accountId || null, name: active()?.name || null, hasCookies: active()?.hasCookies === true, expiresAt: active()?.expiresAt});
  const ok = data => ({ok: true, data});
  const post = async message => {
    calls.push(message);
    switch (message.op) {
      case 'session.list': {
        const offset = message.offset ?? 0, limit = message.limit ?? 10;
        const saved = profiles.filter(item => item.accountId);
        return ok({items: structuredClone(saved.slice(offset, offset + limit)), activeProfileId: state.active, hasMore: offset + limit < saved.length, nextOffset: offset + limit < saved.length ? offset + limit : null});
      }
      case 'session.status': return ok(status());
      case 'session.select':
        if (!profiles.some(item => item.id === message.profileId)) return {ok: false, error: {code: 'SESSION_PROFILE_NOT_FOUND', message: '未找到此账号。'}};
        state.active = state.redirectOnSelect || message.profileId;
        state.redirectOnSelect = null;
        return ok(status());
      case 'session.clear': {
        const id = message.profileId || state.active, index = profiles.findIndex(item => item.id === id);
        if (index >= 0) profiles.splice(index, 1);
        if (id === state.active) state.active = null;
        return ok(status());
      }
      case 'session.login':
        if (state.loginFailure) return {ok: false, error: {code: state.loginFailure, message: '登录未完成，原账号保持不变。'}};
        // 宿主新登录替换未identify的临时槽；用实际边界覆盖升级会话的丢失风险。
        for (let index = profiles.length - 1; index >= 0; index--) if (!profiles[index].accountId) profiles.splice(index, 1);
        profiles.push({id: 'new-login', accountId: null, actualAccountId: state.loginAccount, name: '', expiresAt: '2099-01-01T00:00:00Z', hasCookies: true});
        state.active = 'new-login';
        return ok(status());
      case 'session.identify': {
        if (message.profileId !== state.active) return {ok: false, error: {code: 'SESSION_CHANGED', message: '当前账号已变化。'}};
        const current = active();
        if (current.accountId && current.accountId !== message.accountId) return {ok: false, error: {code: 'SESSION_IDENTITY_MISMATCH', message: '所选账号身份不一致。'}};
        const duplicate = profiles.find(item => item.accountId === message.accountId && item.id !== current.id);
        if (duplicate) { profiles.splice(profiles.indexOf(current), 1); duplicate.hasCookies = true; state.active = duplicate.id; }
        else Object.assign(current, {accountId: message.accountId, name: message.name});
        return ok(status());
      }
      case 'state.get': return ok(message.keys ? {[message.keys]: values[message.keys]} : values);
      case 'state.set': Object.assign(values, message.values); return ok({saved: true});
      case 'session.request': {
        if (state.requestFailure) throw Error('合成网络失败');
        const accountId = active()?.actualAccountId || active()?.accountId;
        const result = ok({status: 200, headers: {}, body: JSON.stringify(new URL(message.url).pathname.includes('challengesug') ? {status_code: 0, sug_list: []} : {status_code: 0, user: {uid: accountId, nickname: `合成账号 ${accountId}`}})});
        if (state.holdRequest) return state.holdRequest(message, result);
        return result;
      }
      default: throw Error(message.op);
    }
  };
  const client = createStudioClient({context: () => ({nativeUIAvailable: true, nativeCapabilities: {sessionVersion: 1, sessionProfilesVersion: 1}, apiBaseURL: 'http://127.0.0.1:8900/api/v1'}), post});
  return {client, state, calls};
}

// 启动只读账号目录完整翻页；显示历史身份不会误报平台已连接。
{
  const h = profileHost(12), listed = await h.client.listAccounts();
  assert.equal(listed.profiles.length, 12); assert.equal(listed.activeProfileId, 'profile-1');
  assert.equal(listed.connected, false); assert.equal(listed.account, null);
  assert.deepEqual(h.calls.map(item => [item.op, item.offset, item.limit]), [['session.list', 0, 10], ['session.list', 10, 10]]);
  const verified = await h.client.connect();
  assert.equal(verified.account.id, '101'); assert.equal(verified.activeProfileId, 'profile-1');
  assert.equal(h.calls.find(item => item.op === 'session.identify').profileId, 'profile-1');
}

// 切换先撤销原发布资格；身份不一致回选原档案但不恢复未经重新核验的在线状态。
{
  const h = profileHost(3), updates = [];
  await h.client.connect(); h.client.onStatus(value => updates.push(value));
  const switching = h.client.selectAccount('profile-2');
  assert.equal(updates[0].connected, false); assert.equal(updates[0].account, null);
  const selected = await switching;
  assert.equal(selected.connected, true); assert.equal(selected.account.id, '102');
  h.state.profiles[2].actualAccountId = '999';
  await assert.rejects(h.client.selectAccount('profile-3'), error => error.code === 'SESSION_IDENTITY_MISMATCH');
  assert.equal(h.state.active, 'profile-2'); assert.equal(updates.at(-1).activeProfileId, 'profile-2');
  assert.equal(updates.at(-1).connected, false);
  await assert.rejects(h.client.request('publication.prepare'), /登录抖音/);
  assert.equal(h.calls.filter(item => item.op === 'session.identify' && item.profileId === 'profile-3').length, 0);
}

// 过期档案仍可看到并选择；清除只影响当前账号，其他账号保留。
{
  const h = profileHost(); await h.client.connect(); h.state.profiles[1].hasCookies = false;
  const expired = await h.client.selectAccount('profile-2');
  assert.equal(expired.connected, false); assert.equal(expired.activeProfileId, 'profile-2');
  assert.match(expired.message, /过期.*重新登录/); assert.equal(expired.profiles.length, 2);
  await assert.rejects(h.client.request('publication.prepare'), /登录抖音/);
  const cleared = await h.client.clearSession();
  assert.equal(cleared.activeProfileId, null); assert.equal(cleared.profiles.length, 1);
  assert.equal(cleared.profiles[0].accountId, '101');
}

// 宿主选择回执不一致时不能把另一个真实账号当作本次选择成功。
{
  const h = profileHost(3); await h.client.connect();
  h.state.redirectOnSelect = 'profile-3';
  await assert.rejects(h.client.selectAccount('profile-2'), error => error.code === 'SESSION_CHANGED');
  assert.equal(h.state.active, 'profile-1');
  const state = await h.client.listAccounts();
  assert.equal(state.connected, false); assert.equal(state.activeProfileId, 'profile-1');
}

// 登录取消/失败不丢原账号；同一真实账号重登由宿主去重，切回已有档案。
{
  const h = profileHost(), updates = [];
  await h.client.connect(); h.client.onStatus(value => updates.push(value));
  for (const code of ['SESSION_LOGIN_CANCELLED', 'SESSION_WRITE_FAILED']) {
    h.state.loginFailure = code;
    await assert.rejects(h.client.importSession(), error => error.code === code);
    assert.equal(h.state.active, 'profile-1'); assert.equal(updates.length, 0);
    assert.deepEqual(await h.client.request('topics.search', {query: '合成'}), {items: [], nextCursor: null});
  }
  h.state.loginFailure = null;
  const duplicate = await h.client.importSession();
  assert.equal(duplicate.activeProfileId, 'profile-2'); assert.equal(duplicate.account.id, '102');
  assert.equal(duplicate.profiles.length, 2); assert.equal(duplicate.profiles.some(item => item.id === 'profile-1'), true);
}

// 业务请求在途时不能改底层会话；连续账号操作互斥，迟到的旧核验不能覆盖新选择。
{
  const h = profileHost(); await h.client.connect();
  let release, started;
  const held = new Promise(resolve => { started = resolve; });
  h.state.holdRequest = (message, result) => {
    if (!message.url.includes('challengesug')) return result;
    started(); return new Promise(resolve => { release = () => resolve(result); });
  };
  const querying = h.client.request('topics.search', {query: '合成'});
  await held;
  await assert.rejects(h.client.selectAccount('profile-2'), error => error.code === 'SESSION_BUSY');
  assert.equal(h.state.active, 'profile-1'); release(); await querying;
  h.state.holdRequest = null;
  const switching = h.client.selectAccount('profile-2');
  await assert.rejects(h.client.selectAccount('profile-1'), error => error.code === 'SESSION_BUSY');
  await assert.rejects(h.client.request('publication.publish', {}), error => error.code === 'SESSION_BUSY');
  await switching;
}
{
  const h = profileHost(); await h.client.connect();
  let release, started;
  const held = new Promise(resolve => { started = resolve; });
  h.state.holdRequest = (_message, result) => {
    h.state.holdRequest = null; started();
    return new Promise(resolve => { release = () => resolve(result); });
  };
  const stale = h.client.connect();
  const staleOutcome = assert.rejects(stale, error => error.code === 'SESSION_CHANGED');
  await held;
  const selected = await h.client.selectAccount('profile-2');
  assert.equal(selected.account.id, '102');
  release(); await staleOutcome;
  const listed = await h.client.listAccounts();
  assert.equal(listed.connected, true); assert.equal(listed.account.id, '102');
  assert.equal(listed.activeProfileId, 'profile-2');
}
console.log('native account profiles: paginated offline listing, verified switching, expiry, selective clear, login preservation, deduplication and race isolation passed');

// 升级后的旧登录先识别保存再添加账号；新登录取消或失败也不能删除旧凭据。
for (const loginFailure of [null, 'SESSION_LOGIN_CANCELLED', 'SESSION_WRITE_FAILED']) {
  const h = profileHost(1);
  Object.assign(h.state.profiles[0], {accountId: null, actualAccountId: '101', name: ''});
  const initial = await h.client.listAccounts();
  assert.equal(initial.profiles.length, 0); assert.equal(initial.activeProfileId, 'profile-1');
  h.state.loginFailure = loginFailure;
  if (loginFailure) await assert.rejects(h.client.importSession(), error => error.code === loginFailure);
  else assert.equal((await h.client.importSession()).account.id, '102');
  const preserved = h.state.profiles.find(item => item.id === 'profile-1');
  assert.equal(preserved.accountId, '101'); assert.equal(preserved.hasCookies, true);
  const identifiedIndex = h.calls.findIndex(item => item.op === 'session.identify' && item.profileId === 'profile-1');
  const loginIndex = h.calls.findIndex(item => item.op === 'session.login');
  assert.ok(identifiedIndex >= 0 && identifiedIndex < loginIndex, 'migrated session must become durable before another login starts');
  if (loginFailure) assert.equal(h.state.active, 'profile-1');
}

// 无法核验旧会话时禁止新登录覆盖；原临时档案保留，用户可检查或明确清除后重登。
{
  const h = profileHost(1);
  Object.assign(h.state.profiles[0], {accountId: null, actualAccountId: '101', name: ''});
  h.state.requestFailure = true;
  await h.client.listAccounts();
  await assert.rejects(h.client.importSession(), error => error.code === 'SESSION_IDENTIFICATION_REQUIRED' && /已为你保留/.test(error.message));
  assert.equal(h.calls.some(item => ['session.login', 'session.clear'].includes(item.op)), false);
  assert.equal(h.state.active, 'profile-1'); assert.equal(h.state.profiles[0].hasCookies, true);
  assert.equal(h.state.profiles[0].accountId, null);
}

// 新登录的真实身份核验失败只移除本次临时会话，回选旧档案但要求重新核验。
{
  const h = profileHost(), updates = [];
  await h.client.connect(); h.client.onStatus(value => updates.push(value));
  h.state.requestFailure = true;
  await assert.rejects(h.client.importSession());
  assert.equal(h.state.active, 'profile-1'); assert.equal(h.state.profiles.length, 2);
  assert.equal(updates.at(-1).connected, false);
  assert.deepEqual(h.calls.find(item => item.op === 'session.clear'), {op: 'session.clear', origin: 'https://creator.douyin.com', profileId: 'new-login'});
  h.state.requestFailure = false;
  await h.client.connect();
  h.state.profiles[0].hasCookies = false;
  const expired = await h.client.listAccounts();
  assert.equal(expired.connected, false, 'offline refresh must revoke an expired current account without contacting the platform');
  assert.equal(expired.activeProfileId, 'profile-1');
}

// 同一已核验档案的只读查询不再重复四次平台身份请求；缓存命中仍两次检查本机档案。
{
  const h = profileHost(); await h.client.connect();
  const requests = () => h.calls.filter(item => item.op === 'session.request');
  assert.equal(requests().length, 1, 'explicit session check requires one actual identity request');
  const before = h.calls.length;
  await h.client.request('topics.search', {query: '第一个'});
  assert.equal(requests().length, 2);
  await h.client.request('topics.search', {query: '第二个'});
  assert.equal(requests().length, 3);
  await h.client.request('topics.search', {query: '第一个'});
  assert.equal(requests().length, 3, 'short page reuse performs no remote request');
  assert.equal(h.calls.slice(before).filter(item => item.op === 'session.status').length, 6);
  h.state.profiles[0].hasCookies = false;
  await assert.rejects(h.client.request('topics.search', {query: '第一个'}), error => error.code === 'SESSION_EXPIRED');
  assert.equal(requests().length, 3);
  await assert.rejects(h.client.request('topics.search', {query: '第一个'}), /登录抖音/);
}

// 宿主外部切换立即撤销旧在线状态；查询失败后下一次重新核验，不把短期缓存当成永久登录。
{
  const h = profileHost(), updates = [];
  await h.client.connect(); h.client.onStatus(value => updates.push(value));
  h.state.active = 'profile-2';
  const before = h.calls.filter(item => item.op === 'session.request').length;
  await assert.rejects(h.client.request('topics.search', {query: '合成'}), error => error.code === 'ACCOUNT_CHANGED');
  assert.equal(h.calls.filter(item => item.op === 'session.request').length, before);
  assert.equal(updates.at(-1).connected, false);
}
{
  const h = profileHost(); await h.client.connect();
  h.state.requestFailure = true;
  await assert.rejects(h.client.request('topics.search', {query: '失败'}));
  h.state.requestFailure = false;
  const before = h.calls.filter(item => item.op === 'session.request').length;
  await h.client.request('topics.search', {query: '重试'});
  const requests = h.calls.filter(item => item.op === 'session.request').slice(before);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /user\/info/);
  assert.match(requests[1].url, /challengesug/);
}
console.log('native client read lifecycle: one-request lookups, cached-page local guards, immediate expiry/account change and failure revalidation passed');
