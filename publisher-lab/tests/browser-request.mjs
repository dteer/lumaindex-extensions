import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createNativeFetch} from '../app/native-transport.js';
import {createCreatorFetch, creatorJSONOptions, CREATOR_ORIGIN, CREATOR_REFERRER} from '../app/platform/browser-request.js';
import {beginCreatorLogin, CREATOR_LOGIN_URL} from '../app/platform/session.js';
import {signImageXRequest} from '../app/platform/image-upload.js';

// Exercise platform → generic bridge with synthetic responses only; the host owns real page execution.
const requests = [], profileId = 'synthetic-profile';
const send = createCreatorFetch(createNativeFetch(async (op, request) => {
  assert.equal(op, 'browser.request');
  requests.push(request);
  return {status: 200, headers: {}, body: '{}'};
}));
const cases = [
  {url: CREATOR_ORIGIN + '/web/api/media/user/info/', method: 'GET', credentials: 'include'},
  {url: CREATOR_ORIGIN + '/web/api/media/user/info/', method: 'HEAD', credentials: 'include'},
  {url: CREATOR_ORIGIN + '/web/api/media/aweme/create_v2/', method: 'POST', credentials: 'include'},
  {url: 'https://tos-test.douyin.com/upload/v1/test', method: 'POST', credentials: 'omit'},
  {url: 'https://tsearch.amemv.com/openapi/aweme/v1/music/search/', method: 'GET', credentials: 'omit'},
];
for (const fixture of cases) {
  await send(fixture.url, {...fixture, profileId});
  const actual = requests.at(-1);
  assert.equal(actual.origin, CREATOR_ORIGIN);
  assert.equal(actual.contextURL, CREATOR_REFERRER);
  assert.equal(actual.profileId, profileId, 'cross-origin cookie-free requests keep the same account browsing environment');
  assert.equal(actual.credentials, fixture.credentials === 'omit' ? 'omit' : 'session');
  assert.deepEqual(actual.headers, {}, 'browser-generated headers are never synthesized by the plugin');
  assert.equal(Object.hasOwn(actual, 'referrer'), false);
}
// Business Accept, explicit empty values and signed upload bytes retain their exact semantics.
await send(CREATOR_ORIGIN + '/web/api/media/user/info/', creatorJSONOptions({profileId}));
assert.equal(requests.at(-1).headers.accept, 'application/json, text/plain, */*');
await send(CREATOR_ORIGIN + '/web/api/media/aweme/create_v2/', creatorJSONOptions({profileId, method: 'POST', body: '{}', headers: {'Accept': '', 'Content-Type': 'application/custom+json'}}));
assert.equal(requests.at(-1).headers.accept, '');
assert.equal(requests.at(-1).headers['content-type'], 'application/custom+json');
const auth = {AccessKeyID: 'synthetic-access', SecretAccessKey: 'synthetic-secret', SessionToken: 'synthetic-token', ExpiredTime: '2031-01-01T00:00:00Z'};
for (const [action, payload] of [['ApplyImageUpload', null], ['CommitImageUpload', {SessionKey: 'synthetic-session'}]]) {
  const signed = await signImageXRequest(auth, action, payload, {now: new Date('2030-01-01T00:00:00Z'), nonce: '123456abcdef'});
  const {url, ...options} = signed;
  await send(url, {...options, profileId, credentials: 'omit'});
  const actual = requests.at(-1);
  for (const [name, value] of new Headers(signed.headers)) assert.equal(actual.headers[name], value, name + ' must preserve signed upload input');
  assert.equal(actual.bodyText, signed.body);
  assert.equal(actual.credentials, 'omit');
  assert.equal(actual.profileId, profileId);
}
// Only business header permissions are declared. Browser identity and origin fields are not plugin authority.
const manifest = JSON.parse(await readFile(new URL('../app/manifest.json', import.meta.url)));
assert.equal(manifest.permissions.browserContext, undefined);
for (const rule of manifest.permissions.network) {
  assert.ok(rule.allowedHeaders.length <= 32);
  assert.equal(rule.allowedHeaders.some(name => /^(user-agent|accept-language|origin|referer|sec-)/i.test(name)), false);
  assert.equal(new Set(rule.allowedHeaders.map(name => name.toLowerCase())).size, rule.allowedHeaders.length);
  if (rule.origin.includes('bytedanceapi.com')) for (const name of ['X-Amz-Date', 'X-Amz-Security-Token', 'X-Amz-Content-Sha256']) assert.ok(rule.allowedHeaders.includes(name));
  if (rule.origin.startsWith('https://*.')) for (const name of ['Content-CRC32', 'X-Storage-U', 'X-Storage-Mode', 'X-Upload-Storage-Mode']) assert.ok(rule.allowedHeaders.includes(name));
}
// Platform decides add-versus-relogin entry; both use the host's default browser environment.
let login;
await beginCreatorLogin(async (op, params) => { login = {op, ...params}; return {browserSessionAvailable: true}; });
assert.deepEqual(login, {op: 'session.login', origin: CREATOR_ORIGIN, url: CREATOR_LOGIN_URL});
await beginCreatorLogin(async (op, params) => { login = {op, ...params}; }, {profileId});
assert.deepEqual(login, {op: 'session.login', origin: CREATOR_ORIGIN, url: CREATOR_LOGIN_URL, profileId});
// Missing scope, spoofed browser headers, CORS rejection and transport failure never fall back to native HTTP.
const before = requests.length;
await assert.rejects(send(CREATOR_ORIGIN), /选择并核对/);
for (const name of ['Cookie', 'User-Agent', 'Accept-Language', 'Origin', 'Referer', 'Sec-Fetch-Site', 'Sec-CH-UA']) {
  await assert.rejects(send(CREATOR_ORIGIN, {profileId, headers: {[name]: 'synthetic'}}), /浏览器生成/);
}
assert.equal(requests.length, before);
const failedOperations = [];
const failed = createCreatorFetch(createNativeFetch(async op => { failedOperations.push(op); throw Object.assign(Error('页面请求失败，请检查登录状态或跨域权限。'), {code: 'BROWSER_REQUEST_FAILED'}); }));
await assert.rejects(failed('https://tsearch.amemv.com/openapi/aweme/v1/music/search/', {profileId, credentials: 'omit'}), error => error.code === 'BROWSER_REQUEST_FAILED');
assert.deepEqual(failedOperations, ['browser.request']);
console.log('platform browser requests: explicit profile/page context, browser-owned headers, signed uploads, manifest scope, login and no-fallback failures passed');
