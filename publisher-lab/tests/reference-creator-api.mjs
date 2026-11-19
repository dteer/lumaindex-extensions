// Historical Chrome query contract; run with npm run test:reference.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {creatorRequest} from '../browser/creator-api.js';

// request 用隔离运行时模拟服务器回执，不调用真实平台，也不读取浏览器会话。
async function request(operation, params = {}, replies = []) {
  const calls = [];
  const context = vm.createContext({URL, AbortSignal, location: {origin: 'https://creator.douyin.com'}, fetch: async (url, options) => {
    calls.push({url: String(url), options});
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (!reply) throw Error('Unexpected request');
    return {ok: reply.httpOK !== false, json: async () => reply};
  }});
  const run = vm.runInContext(`(${creatorRequest.toString()})`, context);
  return {result: JSON.parse(JSON.stringify(await run(operation, params))), calls};
}

assert.equal((await request('https://example.com/steal')).calls.length, 0);
assert.equal((await request('music.validate', {query: 'https://v.douyin.com.evil.test/abc'})).calls.length, 0);
assert.equal((await request('music.list', {category_id: '../x', type: 1, creation_id: 'test'})).calls.length, 0);
const account = await request('account', {}, [{status_code: 0, user: {uid: '123', nickname: '测试账号', cookie: 'must-not-cross'}}]);
assert.deepEqual(account.result, {ok: true, data: {id: '123', name: '测试账号'}});
const login = await request('account', {}, [{status_code: 0, user: {uid: 123}}]);
assert.equal(login.result.ok, false, 'unsafe numeric identity must not be rounded');
const categories = await request('music.categories', {}, [{status_code: 0, categories: ['recommend', 'rank', 'fav', 'category', 'unknown'].map((type, i) => ({category_id: String(i + 1), category_name: type, type}))}]);
assert.deepEqual(categories.result.data.items.map(x => x.type), ['recommend', 'rank', 'fav', 'category']);
const music = await request('music.list', {category_id: '1', type: 'recommend', creation_id: 'test-creation'}, [{status_code: 0, songs: [{music_id: '999', music_name: '测试音乐', duration: 29}], has_more: 1, cursor: 20}]);
assert.equal(music.result.data.items[0].duration, 29);
assert.equal(music.result.data.nextCursor, '20');
const args = {expectedAccountId: '123', payload: {item: {common: {media_type: 2}}}};
const changed = await request('publication.publish', args, [{status_code: 0, user: {uid: '456'}}]);
assert.equal(changed.result.definiteFailure, true);
assert.equal(changed.calls.length, 1, 'account change must never reach POST');
const accepted = await request('publication.publish', args, [{status_code: 0, user: {uid: '123'}}, {status_code: 0, item_id: '888'}]);
assert.equal(accepted.result.data.status, 'processing', 'acceptance does not prove publication');
assert.equal(accepted.calls[1].options.method, 'POST');
assert.equal(accepted.calls[1].options.credentials, 'include');
assert.equal(accepted.calls[1].options.redirect, 'error');
assert.equal(accepted.calls[1].options.headers['Content-Type'], 'application/json');
const absent = await request('publication.publish', args, [{status_code: 0, user: {uid: '123'}}, {status_code: 0}]);
assert.equal(absent.result.ok, false);
assert.notEqual(absent.result.definiteFailure, true, 'missing receipt is uncertain');
const timeout = await request('publication.publish', args, [{status_code: 0, user: {uid: '123'}}, Error('timeout')]);
assert.equal(timeout.calls.length, 2, 'unknown submit has no automatic retry');
assert.notEqual(timeout.result.definiteFailure, true);
const rejected = await request('publication.publish', args, [{status_code: 0, user: {uid: '123'}}, {status_code: 1001}]);
assert.equal(rejected.result.definiteFailure, true);
const status = await request('publication.status', {publicationId: '888'}, [{status_code: 0, aweme: {timer: {status: 999}}}]);
assert.equal(status.result.data.status, 'processing', 'unknown platform enum is never treated as published');
console.log('creator-api: whitelist, login/account binding, one-shot publish and honest receipts passed');
