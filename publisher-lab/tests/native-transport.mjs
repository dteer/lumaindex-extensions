import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createNativeFetch as createUnboundNativeFetch} from '../app/native-transport.js';
import {createStudioClient} from '../app/studio-client.js';
import {CREATOR_ORIGIN, CREATOR_REFERRER} from '../app/platform/browser-request.js';
import {CREATOR_LOGIN_URL} from '../app/platform/session.js';

const browserContext = {origin: CREATOR_ORIGIN, contextURL: CREATOR_REFERRER, profileId: 'synthetic-profile'};
// Direct bridge tests always supply an explicit synthetic browsing context.
function createNativeFetch(call, config) {
  const send = createUnboundNativeFetch(call, config);
  return (url, options = {}) => send(url, {browserContext, ...options});
}

// nativeHost 使用合成数据模拟原生接口，测试不联网、不读取任何用户登录材料。
function nativeHost({failAppend = false, failRequest = false, consumedReceipt = true} = {}) {
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
    if (op === 'browser.request') {
      if (failRequest) throw Error('请求未通过宿主校验');
      if (params.bodyHandle) { assert.equal(handles.get(params.bodyHandle).ready, true); handles.delete(params.bodyHandle); }
      return {status: 200, headers: {'content-type': 'application/json'}, body: '{"status_code":0}',
        ...(params.bodyHandle && consumedReceipt ? {consumedBodyHandle: consumedReceipt === true ? params.bodyHandle : consumedReceipt} : {})};
    }
    if (op === 'session.cancel') return {cancelled: true};
    throw Error(op);
  };
  return {host, calls, handles};
}
// 以原生 Request 的无网络正文提取为参照，覆盖自动 MIME、显式空头和签名字段，避免原生上传悄然改变协议。
{
  const storage = new Uint8Array([11, 22, 33, 44]);
  const cases = [
    {name: '文字正文', body: '作品说明：合成内容'},
    {name: '空字符串正文', body: ''},
    {name: '具有 MIME 的 Blob', body: new Blob(['synthetic'], {type: 'IMAGE/JPEG'})},
    {name: '无 MIME 的 Blob', body: new Blob(['synthetic'])},
    {name: 'ArrayBuffer', body: storage.buffer},
    {name: 'TypedArray 子视图', body: storage.subarray(1, 3)},
    {name: 'DataView 子视图', body: new DataView(storage.buffer, 1, 2)},
    {name: 'JSON 显式类型', body: '{}', headers: {'CoNtEnT-TyPe': 'application/json;charset=UTF-8'}},
    {name: '空类型仍为显式声明', body: '', headers: new Headers({'CONTENT-TYPE': ''})},
    {name: 'Blob 的签名类型优先', body: new Blob(['synthetic'], {type: 'image/jpeg'}), headers: [['Content-Type', 'application/octet-stream'], ['Authorization', 'synthetic-upload-signature'], ['X-Amz-Date', '20261118T000000Z']]},
    {name: '字节的签名类型优先', body: storage, headers: {'CONTENT-TYPE': 'application/octet-stream', Authorization: 'synthetic-byte-signature'}},
    {name: '无正文', body: undefined},
    {name: '显式 null 正文', body: null},
  ];
  for (const fixture of cases) {
    const h = nativeHost(), send = createNativeFetch(h.host);
    const url = 'https://tos-test.snssdk.com/upload/v1/test';
    const options = {method: 'POST', credentials: 'omit', body: fixture.body, headers: fixture.headers};
    const reference = new Request(url, options);
    await send(url, options);
    const sent = h.calls.find(item => item.op === 'browser.request').params;
    assert.deepEqual(sent.headers, Object.fromEntries(reference.headers), fixture.name + ' 的正文类型与显式头必须匹配 fetch');
    assert.equal(Object.keys(sent.headers).filter(name => name.toLowerCase() === 'content-type').length, reference.headers.has('content-type') ? 1 : 0, fixture.name + ' 不得产生大小写重复类型头');
    const actualBytes = Object.hasOwn(sent, 'bodyText') ? Buffer.from(sent.bodyText) : Buffer.concat(h.calls.filter(item => item.op === 'body.append').map(item => Buffer.from(item.params.base64, 'base64')));
    assert.deepEqual(actualBytes, Buffer.from(await reference.arrayBuffer()), fixture.name + ' 必须保留原始正文字节与子视图边界');
    assert.equal(h.handles.size, 0);
    assert.equal(Object.hasOwn(sent, 'referrer'), false, '通用传输未配置时不能凭空生成页面来源');
  }
}
// 通用桥只转交显式请求头，不知道创作者页面、浏览器品牌或跨站策略。
{
  const h = nativeHost(), send = createNativeFetch(h.host);
  const explicit = {'Accept': 'application/json', 'X-Business-Trace': 'synthetic'};
  await send('https://api.example.com/query', {headers: explicit});
  await send('https://creator.douyin.com/web/api/media/user/info/');
  const requests = h.calls.filter(item => item.op === 'browser.request').map(item => item.params);
  assert.deepEqual(requests[0].headers, Object.fromEntries(new Headers(explicit)));
  assert.deepEqual(requests[1].headers, {}, '通用桥不得从平台域名生成请求头');
  assert.ok(requests.every(item => !Object.hasOwn(item, 'referrer')), '通用协议没有平台 referrer 元数据');
  for (const name of ['User-Agent', 'Accept-Language', 'Origin', 'Referer', 'Sec-Fetch-Site', 'Sec-CH-UA', 'Cookie', 'Cookie2', 'Set-Cookie', 'Host', 'Content-Length', 'Connection', 'Transfer-Encoding', 'Proxy-Authorization', 'X-Forwarded-For', 'X-HTTP-Method-Override']) {
    await assert.rejects(send('https://api.example.com/', {headers: {[name]: 'forbidden'}}), /浏览器生成/);
  }
  assert.equal(h.calls.length, 2, '禁止的头在桥接之前失败');
}
{
  const h = nativeHost(), send = createNativeFetch(h.host, {uuid: () => 'request-body'});
  const bytes = new Uint8Array(700000); bytes.fill(23);
  assert.equal((await (await send('https://tos-test.snssdk.com/upload/v1/test', {method: 'POST', credentials: 'omit', body: bytes, headers: {Authorization: 'synthetic-upload-auth'}})).json()).status_code, 0);
  assert.equal(h.calls.filter(c => c.op === 'body.append').length, 3);
  const sent = h.calls.find(c => c.op === 'browser.request').params;
  assert.equal(sent.bodyText, undefined); assert.equal(sent.credentials, 'omit'); assert.equal(sent.bodyHandle, 'body-1');
  assert.equal(h.handles.size, 0);
  assert.equal(h.calls.filter(c => c.op === 'body.remove').length, 0, '确认消费句柄后，上传结果不能再等待一次冗余清理');
  const before = h.calls.length;
  await assert.rejects(send('http://remote.test/', {}), /地址无效/);
  await assert.rejects(send('https://creator.douyin.com/', {headers: {Cookie: 'forbidden'}}), /浏览器生成/);
  assert.equal(h.calls.length, before);
}
{
  const h = nativeHost({failAppend: true}), send = createNativeFetch(h.host);
  await assert.rejects(send('https://tos-test.snssdk.com/upload/v1/test', {method: 'POST', body: new Uint8Array(30)}), /缓存不可用/);
  assert.equal(h.calls.filter(c => c.op === 'browser.request').length, 0);
  assert.equal(h.handles.size, 0, 'failed staging must be removed');
}
// 旧宿主、回执不匹配和发送前拒绝仍清理临时体，不能把“收到响应”等同于消费确认。
for (const consumedReceipt of [false, 'different-handle']) {
  const h = nativeHost({consumedReceipt}), send = createNativeFetch(h.host);
  await send('https://tos-test.snssdk.com/upload/v1/test', {method: 'POST', body: new Uint8Array(3)});
  assert.deepEqual(h.calls.filter(c => c.op === 'body.remove').map(c => c.params.handle), ['body-1']);
  assert.equal(h.handles.size, 0);
}
{
  const h = nativeHost({failRequest: true}), send = createNativeFetch(h.host);
  await assert.rejects(send('https://tos-test.snssdk.com/upload/v1/test', {method: 'POST', body: new Uint8Array(3)}), /宿主校验/);
  assert.equal(h.calls.filter(c => c.op === 'body.remove').length, 1);
  assert.equal(h.handles.size, 0, '宿主消费前失败必须回收已完成的临时体');
}
// 宿主已消费后即使本机刚取消等待，也不再发冗余删除；未经确认的取消仍由 finally 清理。
for (const consumedReceipt of [true, false]) {
  const controller = new AbortController(), h = nativeHost({consumedReceipt});
  const send = createNativeFetch(async (op, params) => {
    const result = await h.host(op, params);
    if (op === 'browser.request') controller.abort();
    return result;
  });
  await assert.rejects(send('https://tos-test.snssdk.com/upload/v1/test', {method: 'POST', body: new Uint8Array(3), signal: controller.signal}), error => error.name === 'AbortError');
  assert.equal(h.calls.filter(c => c.op === 'body.remove').length, consumedReceipt ? 0 : 1);
  assert.equal(h.handles.size, 0);
}
// 音乐搜索只将短期业务授权发给显式声明的无 Cookie 来源；这些头不写入通用状态。
{
  const manifest = JSON.parse(await readFile(new URL('../app/manifest.json', import.meta.url)));
  const rule = manifest.permissions.network.find(item => item.origin === 'https://tsearch.amemv.com');
  assert.deepEqual(rule.pathPrefixes, ['/openapi/aweme/v1/music/search/']);
  assert.equal(rule.useSession, false);
  assert.ok(['Agw-Auth', 'Openapi-Omit-Shark'].every(name => rule.allowedHeaders.includes(name)));
  const creator = manifest.permissions.network.find(item => item.origin === 'https://creator.douyin.com');
  assert.ok(creator.pathPrefixes.includes('/web/api/media/aweme/search/post/auth'));
  assert.ok(creator.pathPrefixes.includes('/web/api/media/activity/get/'));
  assert.ok(creator.pathPrefixes.includes('/web/api/media/activity/detail/'));
  assert.equal(creator.allowedHeaders.includes('Origin'), false);
  assert.ok(!creator.allowedHeaders.includes('Agw-Auth'));
  const h = nativeHost(), send = createNativeFetch(h.host);
  await send('https://tsearch.amemv.com/openapi/aweme/v1/music/search/?keyword=fixture&cursor=0', {credentials: 'omit', headers: {'Agw-Auth': 'synthetic-signature', 'Openapi-Omit-Shark': '1'}});
  const request = h.calls.find(item => item.op === 'browser.request').params;
  assert.equal(request.credentials, 'omit');
  assert.deepEqual(request.headers, {'agw-auth': 'synthetic-signature', 'openapi-omit-shark': '1'});
  assert.equal(h.calls.some(item => ['state.set', 'persist', 'body.begin'].includes(item.op)), false);
}
{
  const controller = new AbortController(); let requestCount = 0, cancelCount = 0, release;
  const send = createNativeFetch(async (op) => {
    if (op === 'browser.request') { requestCount++; return new Promise(resolve => { release = resolve; }); }
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
// 旧宿主即使支持会话，也不能静默使用缺少平台请求选项的新插件。
for (const capabilities of [
  {sessionVersion: 1},
  {sessionVersion: 1, sessionLoginOptionsVersion: 1},
  {sessionVersion: 1, networkHeadersVersion: 1},
  {sessionVersion: 1, sessionLoginOptionsVersion: 1, networkHeadersVersion: 1},
]) {
  let calls = 0;
  const client = createStudioClient({context: () => ({nativeUIAvailable: true, browserEnvironment: {userAgent: 'SyntheticWebKit/1.0', languages: ['en-US']}, nativeCapabilities: capabilities}), post: () => { calls++; }});
  const status = await client.connect();
  assert.equal(status.connected, false);
  assert.match(status.message, /更新 App/);
  const listed = await client.listAccounts();
  assert.match(listed.message, /更新 App/);
  await assert.rejects(client.importSession(), error => error.code === 'HOST_CAPABILITY_UNAVAILABLE');
  await assert.rejects(client.request('topics.search', {query: '合成'}), error => error.code === 'HOST_CAPABILITY_UNAVAILABLE');
  assert.equal(calls, 0, '不支持契约的宿主不能收到登录或平台请求');
}
// Even a host with all prior capabilities must explicitly advertise real browser requests.
{
  let calls = 0;
  const client = createStudioClient({context: () => ({nativeUIAvailable: true, nativeCapabilities: {sessionVersion: 1, sessionLoginOptionsVersion: 1, networkHeadersVersion: 1, persistentWebsiteSessionsVersion: 1}}), post: () => { calls++; }});
  assert.match((await client.connect()).message, /更新 App/);
  await assert.rejects(client.importSession(), error => error.code === 'HOST_CAPABILITY_UNAVAILABLE');
  assert.equal(calls, 0);
}

{
  let cookies = false, cancelImport = false;
  const messages = [], data = {};
  const context = () => ({nativeUIAvailable: true, nativeCapabilities: {browserRequestsVersion: 1, persistentWebsiteSessionsVersion: 1, sessionLoginOptionsVersion: 1, networkHeadersVersion: 1, sessionVersion: 1}, apiBaseURL: 'http://127.0.0.1:8900/api/v1'});
  const client = createStudioClient({context, post: async message => {
    messages.push(message);
    if (message.op === 'session.status') return {ok: true, data: {hasCookies: cookies, browserSessionAvailable: cookies, activeProfileId: cookies ? 'synthetic-profile' : null}};
    if (message.op === 'session.login') { if (cancelImport) return {ok: false, error: {code: 'SESSION_LOGIN_CANCELLED', message: '已取消登录，原有会话未改变。'}}; cookies = true; return {ok: true, data: {imported: true}}; }
    if (message.op === 'session.clear') { cookies = false; return {ok: true, data: {cleared: true}}; }
    if (message.op === 'state.get') return {ok: true, data: message.keys ? {[message.keys]: data[message.keys]} : data};
    if (message.op === 'state.set') { Object.assign(data, message.values); return {ok: true, data: {saved: true}}; }
    if (message.op === 'browser.request') return {ok: true, data: {status: 200, headers: {}, body: JSON.stringify({status_code: 0, user: {uid: '123', nickname: '合成测试账号'}})}};
    throw Error(message.op);
  }});
  assert.equal((await client.connect()).connected, false);
  assert.equal(messages.filter(x => x.op === 'session.login').length, 0, 'checking must not open native import');
  const verified = await client.importSession();
  assert.equal(verified.account.id, '123'); assert.equal(verified.connected, true);
  const accountRequest = messages.find(x => x.op === 'browser.request');
  assert.equal(accountRequest.contextURL, CREATOR_REFERRER);
  assert.equal(accountRequest.origin, CREATOR_ORIGIN);
  assert.equal(accountRequest.profileId, 'synthetic-profile');
  assert.equal(accountRequest.headers.referer, undefined);
  assert.equal(accountRequest.headers.origin, undefined);
  assert.equal(accountRequest.headers['user-agent'], undefined);
  assert.equal(accountRequest.headers.accept, 'application/json, text/plain, */*');
  const imported = messages.find(x => x.op === 'session.login');
  assert.deepEqual(imported, {op: 'session.login', origin: CREATOR_ORIGIN, url: CREATOR_LOGIN_URL});
  const announcements = [];
  client.onStatus(value => announcements.push(value));
  cancelImport = true;
  const beforeCancel = messages.length;
  await assert.rejects(client.importSession(), error => error.code === 'SESSION_LOGIN_CANCELLED');
  assert.deepEqual(messages.slice(beforeCancel), [{op: 'session.login', origin: CREATOR_ORIGIN, url: CREATOR_LOGIN_URL}]);
  assert.equal(announcements.length, 0, 'cancelled import must not reset existing account or preparation');
  assert.equal(cookies, true);
  assert.equal((await client.connect()).account.id, '123');
  assert.equal((await client.clearSession()).connected, false);
  await assert.rejects(client.request('publication.prepare'), /登录抖音/);
}
console.log('native transport/client: bounded chunks, cleanup, cancellation, persistent browser context, real identity gating passed');

// profileHost 模拟宿主独立档案和 CAS；账号、会话及请求都使用合成数据，不联网。
function profileHost(count = 2) {
  const profiles = Array.from({length: count}, (_, index) => ({id: `profile-${index + 1}`, accountId: String(index + 101), name: `合成账号${index + 1}`, expiresAt: '2099-01-01T00:00:00Z', browserSessionAvailable: true, hasCookies: true}));
  const state = {profiles, active: profiles[0]?.id || null, loginAccount: String(count + 101), loginFailure: null, requestFailure: false, holdRequest: null};
  const calls = [], values = {};
  const active = () => profiles.find(item => item.id === state.active);
  const status = () => ({activeProfileId: state.active, accountId: active()?.accountId || null, name: active()?.name || null, browserSessionAvailable: active()?.browserSessionAvailable === true, hasCookies: active()?.hasCookies === true, expiresAt: active()?.expiresAt});
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
        if (message.keepBrowserData === true && (!message.profileId || index < 0 || profiles[index].accountId)) return {ok: false, error: {code: 'SESSION_CLEAR_INVALID', message: '只允许为未识别候选保留网页环境。'}};
        if (index >= 0) profiles.splice(index, 1);
        if (id === state.active) state.active = null;
        return ok(status());
      }
      case 'session.login':
        if (state.loginFailure) return {ok: false, error: {code: state.loginFailure, message: '登录未完成，原账号保持不变。'}};
        // 宿主新登录替换未identify的临时槽；用实际边界覆盖升级会话的丢失风险。
        for (let index = profiles.length - 1; index >= 0; index--) if (!profiles[index].accountId) profiles.splice(index, 1);
        if (message.profileId && !profiles.some(item => item.id === message.profileId && item.accountId)) return {ok: false, error: {code: 'SESSION_PROFILE_NOT_FOUND', message: '未找到此账号。'}};
        profiles.push({id: 'new-login', accountId: null, actualAccountId: state.loginAccount, reloginProfileId: message.profileId, name: '', expiresAt: '2099-01-01T00:00:00Z', browserSessionAvailable: true, hasCookies: true});
        state.active = 'new-login';
        return ok(status());
      case 'session.identify': {
        if (message.profileId !== state.active) return {ok: false, error: {code: 'SESSION_CHANGED', message: '当前账号已变化。'}};
        const current = active();
        if (current.accountId && current.accountId !== message.accountId) return {ok: false, error: {code: 'SESSION_IDENTITY_MISMATCH', message: '所选账号身份不一致。'}};
        const duplicate = profiles.find(item => item.accountId === message.accountId && item.id !== current.id);
        if (current.reloginProfileId) {
          const target = profiles.find(item => item.id === current.reloginProfileId);
          if (!target || target.accountId !== message.accountId) return {ok: false, error: {code: 'SESSION_IDENTITY_MISMATCH', message: '账号不一致。'}};
          profiles.splice(profiles.indexOf(current), 1); target.hasCookies = true; target.browserSessionAvailable = true; state.active = target.id;
        } else if (duplicate) return {ok: false, error: {code: 'SESSION_ACCOUNT_EXISTS', message: '账号已经存在。'}};
        else Object.assign(current, {accountId: message.accountId, name: message.name});
        return ok(status());
      }
      case 'state.get': return ok(message.keys ? {[message.keys]: values[message.keys]} : values);
      case 'state.set': Object.assign(values, message.values); return ok({saved: true});
      case 'session.cancel': return ok({cancelled: true});
      case 'browser.request': {
        assert.equal(message.profileId, state.active, 'request must bind the active account or candidate');
        assert.equal(message.origin, CREATOR_ORIGIN);
        assert.equal(message.contextURL, CREATOR_REFERRER);
        if (!active()?.browserSessionAvailable) return {ok: false, error: {code: 'SESSION_EXPIRED', message: '账号离线，请重新登录。'}};
        if (state.requestFailure) throw Error('合成网络失败');
        const accountId = active()?.actualAccountId || active()?.accountId;
        const result = ok({status: 200, headers: {}, body: JSON.stringify(new URL(message.url).pathname.includes('challengesug') ? {status_code: 0, sug_list: []} : {status_code: 0, user: {uid: accountId, nickname: `合成账号 ${accountId}`}})});
        if (state.holdRequest) return state.holdRequest(message, result);
        return result;
      }
      default: throw Error(message.op);
    }
  };
  const client = createStudioClient({context: () => ({nativeUIAvailable: true, nativeCapabilities: {browserRequestsVersion: 1, persistentWebsiteSessionsVersion: 1, sessionLoginOptionsVersion: 1, networkHeadersVersion: 1, sessionVersion: 1, sessionProfilesVersion: 1}, apiBaseURL: 'http://127.0.0.1:8900/api/v1'}), post});
  return {client, state, calls};
}

// 启动本地恢复已识别档案与能力，完整分页，不额外请求账号接口。
{
  const h = profileHost(12), listed = await h.client.listAccounts();
  assert.equal(listed.profiles.length, 12); assert.equal(listed.activeProfileId, 'profile-1');
  assert.equal(listed.connected, true); assert.equal(listed.account.id, '101');
  assert.ok(listed.capabilities.operations.includes('music.search'));
  assert.deepEqual(h.calls.map(item => [item.op, item.offset, item.limit]), [['session.list', 0, 10], ['session.list', 10, 10]]);
  const verified = await h.client.connect();
  assert.equal(verified.account.id, '101'); assert.equal(verified.activeProfileId, 'profile-1');
  assert.equal(h.calls.find(item => item.op === 'session.identify').profileId, 'profile-1');
}

// 切换只选择明确本机档案；实际身份不一致由显式检查或上传提交的核验报告。
{
  const h = profileHost(3), updates = [];
  await h.client.connect(); h.client.onStatus(value => updates.push(value));
  const before = h.calls.length, switching = h.client.selectAccount('profile-2');
  const selected = await switching;
  assert.equal(selected.connected, true); assert.equal(selected.account.id, '102');
  assert.equal(h.calls.slice(before).some(item => item.op === 'browser.request'), false);
  h.state.profiles[2].actualAccountId = '999';
  assert.equal((await h.client.selectAccount('profile-3')).account.id, '103');
  await assert.rejects(h.client.connect(), error => error.code === 'ACCOUNT_CHANGED');
  assert.equal(h.state.active, 'profile-3'); assert.equal(updates.at(-1).activeProfileId, 'profile-3');
  assert.equal(updates.at(-1).connected, false);
  assert.equal(updates.at(-1).account.id, '103', 'an account error retains the selected identity');
  assert.equal(h.calls.filter(item => item.op === 'session.identify' && item.profileId === 'profile-3').length, 0);
}

// 过期档案仍可看到并选择；清除只影响当前账号，其他账号保留。
{
  const h = profileHost(); await h.client.connect(); h.state.profiles[1].browserSessionAvailable = false;
  const expired = await h.client.selectAccount('profile-2');
  assert.equal(expired.connected, false); assert.equal(expired.activeProfileId, 'profile-2');
  assert.match(expired.message, /重新登录/); assert.equal(expired.profiles.length, 2);
  assert.equal(expired.account.id, '102');
  await assert.rejects(h.client.request('publication.prepare'), error => error.code === 'SESSION_EXPIRED');
  const cleared = await h.client.clearSession();
  assert.equal(cleared.activeProfileId, null); assert.equal(cleared.profiles.length, 1);
  assert.equal(cleared.profiles[0].accountId, '101');
  assert.deepEqual(h.calls.filter(item => item.op === 'session.clear').at(-1), {op: 'session.clear', origin: CREATOR_ORIGIN}, '用户移除账号不得保留其网页数据');
}

// 宿主选择回执不一致时不能把另一个真实账号当作本次选择成功。
{
  const h = profileHost(3); await h.client.connect();
  h.state.redirectOnSelect = 'profile-3';
  await assert.rejects(h.client.selectAccount('profile-2'), error => error.code === 'SESSION_CHANGED');
  assert.equal(h.state.active, 'profile-1');
  const state = await h.client.listAccounts();
  assert.equal(state.connected, true); assert.equal(state.activeProfileId, 'profile-1');
}

// 新增登录取消/失败不丢原账号；新账号使用独立档案，重复添加要求明确选择重登。
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
  const added = await h.client.importSession();
  assert.equal(added.activeProfileId, 'new-login'); assert.equal(added.account.id, '103');
  assert.equal(added.profiles.length, 3); assert.equal(added.profiles.some(item => item.id === 'profile-1'), true);
}

// 添加已存在账号时不覆盖其持久环境；仅清理候选并恢复原选择。
{
  const h = profileHost(); await h.client.connect();
  h.state.loginAccount = '102';
  const original = structuredClone(h.state.profiles);
  await assert.rejects(h.client.importSession(), error => error.code === 'SESSION_ACCOUNT_EXISTS' && /重新登录当前账号/.test(error.message));
  assert.equal(h.state.active, 'profile-1');
  assert.deepEqual(h.state.profiles, original);
  assert.deepEqual(h.calls.find(item => item.op === 'session.clear'), {op: 'session.clear', origin: CREATOR_ORIGIN, profileId: 'new-login', keepBrowserData: true});
}
// 当前账号重登始终明确传原档案；过期、取消、失败和错误账号均不删除旧档案。
{
  const h = profileHost(); await h.client.connect();
  h.state.loginAccount = '101';
  for (const code of ['SESSION_LOGIN_CANCELLED', 'SESSION_WRITE_FAILED']) {
    const original = structuredClone(h.state.profiles);
    h.state.loginFailure = code;
    await assert.rejects(h.client.reloginSession(), error => error.code === code);
    assert.equal(h.state.active, 'profile-1'); assert.deepEqual(h.state.profiles, original);
    assert.equal(h.calls.filter(item => item.op === 'session.login').at(-1).profileId, 'profile-1');
  }
  h.state.loginFailure = null;
  h.state.profiles[0].browserSessionAvailable = false;
  await h.client.listAccounts();
  const result = await h.client.reloginSession();
  assert.equal(result.connected, true); assert.equal(result.activeProfileId, 'profile-1'); assert.equal(result.account.id, '101');
  assert.equal(h.state.profiles.length, 2); assert.equal(h.state.profiles[0].hasCookies, true);
  assert.equal(h.calls.filter(item => item.op === 'session.login').at(-1).profileId, 'profile-1');
  assert.equal(h.calls.some(item => item.op === 'session.clear'), false);
}
{
  const h = profileHost(); await h.client.connect();
  h.state.loginAccount = '102';
  const original = structuredClone(h.state.profiles), before = h.calls.length;
  await assert.rejects(h.client.reloginSession(), error => error.code === 'SESSION_IDENTITY_MISMATCH');
  assert.equal(h.state.active, 'profile-1'); assert.deepEqual(h.state.profiles, original);
  assert.equal(h.calls.slice(before).some(item => item.op === 'session.identify'), false, '插件必须在提交身份前拒绝错误账号');
  assert.deepEqual(h.calls.filter(item => item.op === 'session.clear').at(-1), {op: 'session.clear', origin: CREATOR_ORIGIN, profileId: 'new-login', keepBrowserData: true});
}
{
  const h = profileHost(); await h.client.connect();
  h.state.loginAccount = '101'; h.state.requestFailure = true;
  const original = structuredClone(h.state.profiles);
  await assert.rejects(h.client.reloginSession());
  assert.deepEqual(h.state.profiles, original); assert.equal(h.state.active, 'profile-1');
  assert.equal(h.calls.some(item => item.op === 'session.clear' && item.profileId === 'profile-1'), false);
  assert.equal(h.calls.filter(item => item.op === 'session.clear').at(-1).keepBrowserData, true);
}
// 普通查询在途不阻止换号；取消与代际检查丢弃旧结果，连续账号操作仍互斥。
{
  const h = profileHost(); await h.client.connect();
  let release, started;
  const held = new Promise(resolve => { started = resolve; });
  h.state.holdRequest = (message, result) => {
    if (!message.url.includes('challengesug')) return result;
    started(); return new Promise(resolve => { release = () => resolve(result); });
  };
  const querying = h.client.request('topics.search', {query: '合成'});
  const outcome = assert.rejects(querying, error => error.name === 'AbortError' || error.code === 'SESSION_CHANGED');
  await held;
  await h.client.selectAccount('profile-2');
  assert.equal(h.state.active, 'profile-2'); release(); await outcome;
  assert.ok(h.calls.some(item => item.op === 'session.cancel'));
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
  const checking = h.client.connect();
  await held;
  await assert.rejects(h.client.selectAccount('profile-2'), error => error.code === 'SESSION_BUSY');
  release(); await checking;
  const selected = await h.client.selectAccount('profile-2');
  assert.equal(selected.account.id, '102');
  const listed = await h.client.listAccounts();
  assert.equal(listed.connected, true); assert.equal(listed.account.id, '102');
  assert.equal(listed.activeProfileId, 'profile-2');
}
// 上传准备期间仍禁止切换底层档案；这与可取消的普通查询分开。
{
  const h = profileHost(); await h.client.listAccounts();
  let release, started;
  const held = new Promise(resolve => { started = resolve; });
  h.state.holdRequest = (_message, result) => { started(); return new Promise(resolve => { release = () => resolve(result); }); };
  const preparing = h.client.request('publication.prepare', {draft: {}});
  const outcome = assert.rejects(preparing);
  await held;
  await assert.rejects(h.client.selectAccount('profile-2'), error => error.code === 'SESSION_BUSY');
  assert.equal(h.state.active, 'profile-1');
  release(); await outcome;
  assert.ok(h.calls.filter(item => item.op === 'browser.request').every(item => item.url.includes('/user/info/')));
}
console.log('native account profiles: local restoration/switching, offline identity retention, cancelled reads and protected upload/publish writes passed');

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
  assert.deepEqual(h.calls.find(item => item.op === 'session.clear'), {op: 'session.clear', origin: 'https://creator.douyin.com', profileId: 'new-login', keepBrowserData: true});
  h.state.requestFailure = false;
  await h.client.connect();
  h.state.profiles[0].browserSessionAvailable = false;
  const expired = await h.client.listAccounts();
  assert.equal(expired.connected, false, 'offline refresh must revoke an expired current account without contacting the platform');
  assert.equal(expired.activeProfileId, 'profile-1');
}

// 同一已核验档案的只读查询不再重复四次平台身份请求；缓存命中仍两次检查本机档案。
{
  const h = profileHost(); await h.client.connect();
  const requests = () => h.calls.filter(item => item.op === 'browser.request');
  assert.equal(requests().length, 1, 'explicit session check requires one actual identity request');
  const before = h.calls.length;
  await h.client.request('topics.search', {query: '第一个'});
  assert.equal(requests().length, 2);
  await h.client.request('topics.search', {query: '第二个'});
  assert.equal(requests().length, 3);
  await h.client.request('topics.search', {query: '第一个'});
  assert.equal(requests().length, 3, 'short page reuse performs no remote request');
  assert.equal(h.calls.slice(before).filter(item => item.op === 'session.status').length, 6);
  h.state.profiles[0].browserSessionAvailable = false;
  await h.client.request('topics.search', {query: '第一个'});
  assert.equal(requests().length, 3);
  const updates = []; h.client.onStatus(value => updates.push(value));
  await assert.rejects(h.client.request('topics.search', {query: '离线新请求'}), error => error.code === 'SESSION_EXPIRED');
  assert.equal(updates.at(-1).connected, false);
  assert.equal(updates.at(-1).account.id, '101');
  assert.ok(updates.at(-1).capabilities.operations.includes('topics.search'));
  assert.equal(h.calls.filter(item => item.op === 'browser.request' && item.url.includes('/user/info/')).length, 1, 'offline errors must not trigger hidden account checks');
}

// 外部换号拒绝跨账号结果；普通网络错误的显式重试只执行原查询。
{
  const h = profileHost(), updates = [];
  await h.client.connect(); h.client.onStatus(value => updates.push(value));
  h.state.active = 'profile-2';
  const before = h.calls.filter(item => item.op === 'browser.request').length;
  await assert.rejects(h.client.request('topics.search', {query: '合成'}), error => error.code === 'ACCOUNT_CHANGED');
  assert.equal(h.calls.filter(item => item.op === 'browser.request').length, before);
  assert.equal(updates.at(-1).connected, false);
}
{
  const h = profileHost(); await h.client.connect();
  h.state.requestFailure = true;
  await assert.rejects(h.client.request('topics.search', {query: '失败'}));
  h.state.requestFailure = false;
  const before = h.calls.filter(item => item.op === 'browser.request').length;
  await h.client.request('topics.search', {query: '重试'});
  const requests = h.calls.filter(item => item.op === 'browser.request').slice(before);
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /challengesug/);
}
console.log('native client read lifecycle: direct business requests, offline cache/identity retention, account isolation and retries without hidden revalidation passed');

// 同账号的显式检查保留已查候选；成功、已知离线和实际检查失败都不让本地选择失效。
for (const entry of ['connect', 'studio.session']) {
  for (const outcome of ['success', 'offline', 'failure']) {
    const h = profileHost(); await h.client.listAccounts();
    h.state.holdRequest = (message, result) => {
      const path = new URL(message.url).pathname;
      const data = path.endsWith('/music/category') ? {status_code: 0, categories: [{category_id: '1', type: 'recommend', category_name: '推荐'}]}
        : path.endsWith('/music/list') ? {status_code: 0, songs: [{music_id: '777', music_name: '已查音乐', duration: 30, play_url: 'https://media.example.test/777.mp3'}], has_more: false} : null;
      return data ? {ok: true, data: {status: 200, headers: {}, body: JSON.stringify(data)}} : result;
    };
    await h.client.request('music.search', {});
    await h.client.request('topics.search', {query: '已查话题'});
    h.state.holdRequest = null;
    if (outcome === 'offline') h.state.profiles[0].browserSessionAvailable = false;
    if (outcome === 'failure') h.state.requestFailure = true;
    const checking = entry === 'connect' ? h.client.connect() : h.client.request('studio.session');
    if (outcome === 'failure') await assert.rejects(checking, /网络失败/);
    else assert.equal((await checking).connected, outcome === 'success');
    const before = h.calls.filter(item => item.op === 'browser.request').length;
    assert.equal((await h.client.request('music.select', {id: '777', keepIds: ['777']})).id, '777');
    await h.client.request('topics.search', {query: '已查话题'});
    assert.equal(h.calls.filter(item => item.op === 'browser.request').length, before, 'same-account checks preserve both candidate provenance and cached results');
  }
}

// 检查时发现确实换了账号，仍清除原账号候选；切回原档案不能复活前次的内存结果。
{
  const h = profileHost(); await h.client.listAccounts();
  await h.client.request('topics.search', {query: '原账号查询'});
  h.state.active = 'profile-2'; await h.client.connect();
  h.state.active = 'profile-1'; await h.client.connect();
  const before = h.calls.filter(item => item.op === 'browser.request').length;
  await h.client.request('topics.search', {query: '原账号查询'});
  assert.equal(h.calls.filter(item => item.op === 'browser.request').length, before + 1);
}

// 本机目录发现外部换号时同步推进请求代次；旧查询的迟到错误不能让新账号误显示离线。
for (const change of ['profile', 'account']) {
  const h = profileHost(); await h.client.listAccounts();
  const updates = []; h.client.onStatus(value => updates.push({account: value.account?.id, connected: value.connected}));
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  h.state.holdRequest = (_message, result) => { started(); return new Promise(resolve => { release = () => resolve(result); }); };
  const pending = h.client.request('topics.search', {query: '旧账号在途查询'});
  const rejected = assert.rejects(pending, error => error.name === 'AbortError' || error.code === 'SESSION_CHANGED');
  await waiting;
  if (change === 'profile') h.state.active = 'profile-2';
  else h.state.profiles[0].accountId = '999';
  const selected = await h.client.listAccounts();
  assert.equal(selected.account.id, change === 'profile' ? '102' : '999');
  assert.equal(selected.connected, true);
  assert.equal(h.calls.filter(item => item.op === 'session.cancel').length, 1);
  release(); await rejected;
  assert.deepEqual(updates, [{account: selected.account.id, connected: true}], 'old read rejection must not alter the new account state');
  h.state.holdRequest = null;
  await h.client.request('topics.search', {query: '新账号查询'});
  assert.equal(h.calls.filter(item => item.op === 'browser.request').at(-1).profileId, h.state.active);
}
console.log('native client verification: same-account checks preserve candidates, actual identity changes clear them and late cancelled reads never mark the new account offline');
