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

// 原生协议新增查询使用真实固定目标，全部网络由合成响应替代。
const {createCreatorAPI} = await import('../app/platform/creator-api.js');
async function nativeRequest(operation, params, replies) {
  const calls = [];
  const result = await createCreatorAPI(async (url, options) => {
    calls.push({url: String(url), options});
    const reply = replies.shift();
    assert.ok(reply, 'unexpected native request');
    if (reply instanceof Error) throw reply;
    if (reply instanceof Response) return reply;
    return new Response(JSON.stringify(reply));
  })(operation, params);
  return {result, calls};
}

// 宿主稳定错误码和明确 HTTP 登录拒绝原样反馈；未知平台业务码不能猜成账号失效。
for (const code of ['SESSION_EXPIRED', 'ACCOUNT_CHANGED', 'SESSION_CHANGED', 'NETWORK_CANCELLED']) {
  const {result} = await nativeRequest('account', {}, [Object.assign(Error('合成宿主请求失败'), {code})]);
  assert.equal(result.code, code); assert.match(result.error, /合成宿主/);
}
for (const status of [401, 403]) {
  const {result} = await nativeRequest('account', {}, [new Response('login rejected', {status})]);
  assert.equal(result.code, 'SESSION_EXPIRED'); assert.equal(result.ok, false);
}
assert.equal((await nativeRequest('account', {}, [{status_code: 123456}])).result.code, undefined);
assert.equal((await nativeRequest('account', {}, [Object.assign(Error('失败'), {code: 'https://untrusted.example/error'})])).result.code, undefined);
{
  const {result, calls} = await nativeRequest('publication.publish', {expectedAccountId: '123', payload: {item: {common: {media_type: 2}}}}, [new Response('login rejected', {status: 401})]);
  assert.equal(result.code, 'SESSION_EXPIRED'); assert.equal(result.definiteFailure, true); assert.equal(calls.length, 1);
}
for (const [module, method, params] of [
  ['../app/platform/location.js', 'searchLocations', {cityCode: '440300', cityName: '深圳市', keyword: '公园', page: 1}],
  ['../app/platform/collection.js', 'listCollections', {kind: 'image', cursor: '0'}],
]) {
  const request = (await import(module))[method];
  const host = await request(params, async () => { throw Object.assign(Error('合成账号需要登录'), {code: 'SESSION_EXPIRED'}); });
  assert.equal(host.code, 'SESSION_EXPIRED');
  const response = await request(params, async () => new Response('login rejected', {status: 403}));
  assert.equal(response.code, 'SESSION_EXPIRED');
}
{
  const result = await nativeRequest('music.search', {query: '钢琴', cursor: '20'}, [
    {status_code: 0, signature: 'synthetic-short-lived-search-grant'},
    {status_code: 0, music: [{id_str: '303', title: '合成钢琴', author: '合成作者', duration: 23, user_count: 120,
      play_url: {url_list: ['https://media.example.test/test.mp3']}, cover_thumb: {url_list: ['https://media.example.test/cover.jpg']}}], has_more: 1, cursor: 40},
  ]);
  assert.equal(new URL(result.calls[0].url).pathname, '/web/api/media/aweme/search/post/auth');
  assert.equal(result.calls[0].options.credentials, 'include');
  const search = result.calls[1], url = new URL(search.url);
  assert.equal(url.origin, 'https://tsearch.amemv.com'); assert.equal(url.searchParams.get('keyword'), '钢琴');
  assert.equal(url.searchParams.get('aid'), '1128'); assert.equal(url.searchParams.get('cursor'), '20');
  assert.equal(search.options.credentials, 'omit'); assert.equal(search.options.redirect, 'error');
  assert.deepEqual(search.options.headers, {accept: 'application/json, text/plain, */*', 'agw-auth': 'synthetic-short-lived-search-grant', 'openapi-omit-shark': '1'});
  assert.equal(result.calls[0].options.headers.accept, 'application/json, text/plain, */*');
  assert.equal(result.result.data.nextCursor, '40'); assert.equal(result.result.data.items[0].duration, 23);
  assert.equal(result.result.data.items[0].userCount, 120);
  assert.equal(JSON.stringify(result.result).includes('synthetic-short-lived-search-grant'), false);
}
// JSON 协议层统一补 Accept；发布的 JSON 类型、显式 Accept 与签名字段仍优先保留。
{
  const result = await nativeRequest('publication.publish', args, [{status_code: 0, user: {uid: '123'}}, {status_code: 0, item_id: '888'}]);
  assert.equal(result.result.ok, true);
  assert.ok(result.calls.every(item => item.options.headers.accept === 'application/json, text/plain, */*'));
  assert.equal(result.calls[1].options.headers['content-type'], 'application/json');
  const {creatorJSONOptions} = await import('../app/platform/browser-request.js');
  assert.deepEqual(creatorJSONOptions({headers: {'aCcEpT': 'application/problem+json', 'Content-Type': 'custom/type', Authorization: 'synthetic-signed'}}).headers,
    {accept: 'application/problem+json', authorization: 'synthetic-signed', 'content-type': 'custom/type'});
  const calls = [], send = async (url, options) => {
    calls.push({url, options});
    return new Response(JSON.stringify({status_code: 0, has_more: false, mix_list: [], poi_list: []}));
  };
  const {searchLocations} = await import('../app/platform/location.js');
  const {listCollections} = await import('../app/platform/collection.js');
  assert.equal((await searchLocations({cityCode: '110100', cityName: '北京市', keyword: '合成地点', page: 1}, send)).ok, true);
  assert.equal((await listCollections({kind: 'image', cursor: '0'}, send)).ok, true);
  assert.ok(calls.every(item => item.options.headers.accept === 'application/json, text/plain, */*'));
  assert.ok(calls.every(item => !Object.keys(item.options.headers).some(name => ['origin', 'referer', 'user-agent'].includes(name) || name.startsWith('sec-'))));
}
{
  const denied = await nativeRequest('music.search', {query: '钢琴'}, [{status_code: 1001}]);
  assert.equal(denied.result.ok, false); assert.equal(denied.calls.length, 1);
  const stalled = await nativeRequest('music.search', {query: '钢琴', cursor: '20'}, [{status_code: 0, signature: 'synthetic'}, {status_code: 0, music: [], has_more: 1, cursor: 20}]);
  assert.equal(stalled.result.ok, false); assert.match(stalled.result.error, /分页/);
}
{
  const topics = await nativeRequest('topics.search', {query: '摄影'}, [{status_code: 0, sug_list: [{cid: '101', cha_name: '摄影', view_count: 12345}]}]);
  assert.equal(topics.result.data.items[0].viewCount, 12345);
  const recommended = await nativeRequest('topics.recommend', {frames: 'tos/first.jpg,tos/second.jpg'}, [{status_code: 0, challenge_list: [{cid: '102', cha_name: '日常'}]}]);
  assert.equal(new URL(recommended.calls[0].url).searchParams.get('frames'), 'tos/first.jpg,tos/second.jpg');
  assert.equal(recommended.result.data.items[0].id, '102');
  assert.equal((await nativeRequest('topics.recommend', {frames: 'https://external.example/test.jpg'}, [])).calls.length, 0);
}
{
  const declarations = await nativeRequest('declarations.list', {kind: 'image', draftId: 'draft-one'}, [{status_code: 0, data: {block_type: 1, options: [
    {choose_value: 'aigc', text: '内容由AI生成'}, {choose_value: 'personal_opinion', text: '个人观点'},
    {choose_value: 'from_net_v3', text: '转载来源', show_type: 'source_option'},
    {choose_value: 'shot_at', text: '拍摄地点日期', show_type: 'location_and_date'},
  ]}}]);
  assert.equal(declarations.result.data.required, true);
  assert.equal(declarations.result.data.items[0].disabled, false);
  assert.equal(declarations.result.data.items[2].disabled, true);
  const url = new URL(declarations.calls[0].url);
  assert.equal(url.pathname, '/aweme/v3/user_declaration/suggestion/');
  assert.equal(url.searchParams.get('scene'), 'new_self_media_before_publish');
  assert.equal(url.searchParams.get('creation_id'), 'draft-one');
  assert.equal(JSON.parse(url.searchParams.get('user_decl_judge_feats')).item_type, 'image');
}
console.log('native creator options: real music authorization routing, pagination, topic heat and dynamic declaration contracts passed');

// 原生合集下拉展示官方封面与原始作品数，显示数据不混入最小发布身份。
{
  const {listCollections} = await import('../app/platform/collection.js');
  const result = await listCollections({kind: 'image', cursor: '0'}, async () => new Response(JSON.stringify({status_code: 0, has_more: 0, cursor: '0', mix_list: [
    {mix_id: '501', mix_name: '合成合集', type: 0, status: {status: 0}, statis: {updated_to_episode: 2}, cover_url: {url_list: ['https://media.example.test/mix-cover.jpg']}},
    {mix_id: '502', mix_name: '空合集', type: 0, status: {status: 0}, statis: {updated_to_episode: 0}, cover_url: {url_list: ['https://user:secret@media.example.test/not-used.jpg']}},
  ]})));
  assert.equal(result.ok, true);
  assert.equal(result.data.items[0].itemCount, 2); assert.equal(result.data.items[0].order, 3);
  assert.equal(result.data.items[0].thumbnailURL, 'https://media.example.test/mix-cover.jpg');
  assert.equal(JSON.stringify(result.data.items[0].info).includes('mix-cover'), false);
  assert.equal(result.data.items[1].itemCount, 0); assert.equal(result.data.items[1].order, 1);
  assert.equal(result.data.items[1].thumbnailURL, undefined);
}
console.log('native collection display: platform cover and raw item count remain separate from next episode and publication identity');

// 官方活动列表仅提供显示线索；即使 challenge_ids 已舍入或缺失，也必须通过详情取得发布身份。
{
  const response = await nativeRequest('activities.list', {cursor: '0'}, [{status_code: 0, activity_list: [
    {activity_id: '701', activity_name: '合成官方活动', activity_status: 1, challenge: ['摄影日常'], challenge_ids: ['801'], hot_score: 419, cover_image: 'https://media.example.test/activity.jpg', show_start_time: '2026.01.01', show_end_time: '2026.12.31'},
    {activity_id: '702', activity_name: '额外推广活动', activity_status: 1, challenge: ['游戏日常'], challenge_ids: ['802'], game_id: '901'},
    {activity_id: '703', activity_name: '无关联话题', challenge: [], challenge_ids: []},
    {activity_id: '704', activity_name: '错误形状', challenge: ['不取首字符'], challenge_ids: '899'},
  ]}]);
  assert.equal(response.result.ok, true);
  const url = new URL(response.calls[0].url);
  assert.equal(url.pathname, '/web/api/media/activity/get/');
  assert.equal(url.searchParams.get('page'), '1'); assert.equal(url.searchParams.get('size'), '10'); assert.equal(url.searchParams.get('need_challenge'), '1');
  assert.equal(response.calls[0].options.method, 'GET'); assert.equal(response.calls[0].options.credentials, 'include');
  assert.equal(response.result.data.items[0].topicName, '摄影日常');
  assert.equal(response.result.data.items[0].topic, undefined);
  assert.equal(response.result.data.items[0].id, '701'); assert.equal(response.result.data.items[0].heat, 419);
  assert.equal(response.result.data.items[0].startTime, '2026.01.01'); assert.equal(response.result.data.items[1].disabled, true);
  assert.equal(response.result.data.items.length, 3); assert.equal(response.result.data.nextCursor, null);
  for (const params of [{cursor: '-1'}, {cursor: '2'}, {cursor: '10001'}, {query: '未经证实的搜索参数'}]) assert.equal((await nativeRequest('activities.list', params, [])).calls.length, 0);
  const complete = await nativeRequest('activities.list', {}, [{status_code: 0, activity_list: Array.from({length: 11}, (_,index) => ({activity_id: String(700 + index), activity_name: '合成活动' + index, activity_status: 1, challenge: ['活动话题' + index], challenge_ids: [String(800 + index)]}))}]);
  assert.equal(complete.result.data.items.length, 11, 'the external directory ignores page size; every eligible item remains available without slicing');
  assert.equal(complete.result.data.nextCursor, null); assert.equal(complete.result.data.message, '');
  const tooMany = await nativeRequest('activities.list', {}, [{status_code: 0, activity_list: Array.from({length: 201}, () => ({}))}]);
  assert.equal(tooMany.result.ok, false, 'the full external directory still has an explicit bounded response');
  for (const state of [undefined, 0, 2, 3, 4, 9]) {
    const unavailable = await nativeRequest('activities.list', {}, [{status_code: 0, activity_list: [{activity_id: '701', activity_name: '不可参加', activity_status: state, challenge: ['活动话题'], challenge_ids: ['801']}]}]);
    assert.equal(unavailable.result.data.items[0].disabled, true);
  }
}
{
  const raw = '{"status_code":0,"activity_list":[{"activity_id":"7706830008333652992","activity_name":"合成活动","challenge":["宝藏经验分享计划"],"challenge_ids":[7655295256916658000],"hot_score":419},{"activity_id":"702","activity_name":"数字7655295256916658000及转义\\\"字符串","challenge":["保持文本"],"challenge_ids":[7655295256916658001]}]}';
  const parsed = await createCreatorAPI(async () => new Response(raw))('activities.list');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.items[0].topic, undefined);
  assert.equal(parsed.data.items[1].topic, undefined, 'list integer literals are never promoted to publication identities');
  assert.equal(parsed.data.items[1].name, '数字7655295256916658000及转义"字符串');
  assert.equal(parsed.data.items[0].heat, 419, 'ordinary numeric display fields keep numeric types');
  const exponent = await createCreatorAPI(async () => new Response('{"status_code":0,"activity_list":[{"activity_id":"1","activity_name":"不可靠数字","challenge":["不猜身份"],"challenge_ids":[7.655295256916658e18]}]}'))('activities.list');
  assert.equal(exponent.data.items.length, 1); assert.equal(exponent.data.items[0].topic, undefined, 'list numeric format cannot affect the authoritative identity');
}
{
  const detail = await nativeRequest('activities.detail', {id: '701'}, [{status_code: 0, activity_info: {activity_id: '701', activity_name: '合成官方活动'},
    activity_description: '记录摄影日常', topics: ['摄影日常'], topics_ids: ['7655295256916658211'], publish_start_time: '2026.01.01', publish_end_time: '2026.12.31', reward_rules: JSON.stringify({text: ['平台第一项说明', '平台第二项说明']})}]);
  assert.equal(new URL(detail.calls[0].url).pathname, '/web/api/media/activity/detail/');
  assert.equal(new URL(detail.calls[0].url).searchParams.get('activity_id'), '701');
  assert.deepEqual(detail.result.data.topics, ['摄影日常']); assert.equal(detail.result.data.rewardDescription, '平台第一项说明\n平台第二项说明');
  assert.deepEqual(detail.result.data.topicChoices, [{id: '7655295256916658211', name: '摄影日常'}]);
  assert.equal((await nativeRequest('activities.detail', {id: 'https://wrong.invalid/'}, [])).calls.length, 0);
  const changed = await nativeRequest('activities.detail', {id: '701'}, [{status_code: 0, activity_info: {activity_id: '702', activity_name: '另一活动'}, topics: []}]);
  assert.equal(changed.result.ok, false);
  for (const ids of [undefined, [], ['801', '802'], [801], [7655295256916658000], ['bad']]) {
    const invalid = await nativeRequest('activities.detail', {id: '701'}, [{status_code: 0, activity_info: {activity_id: '701', activity_name: '合成官方活动'}, topics: ['摄影日常'], topics_ids: ids}]);
    assert.deepEqual(invalid.result.data.topicChoices, [], 'missing, mismatched, numeric or invalid detail IDs cannot be paired or guessed');
  }
  const pairs = await nativeRequest('activities.detail', {id: '701'}, [{status_code: 0, activity_info: {activity_name: '合成官方活动'}, topics: ['摄影日常', '第二话题'], topics_ids: ['7655295256916658211', '7655295256916658212']}]);
  assert.deepEqual(pairs.result.data.topicChoices, [{id: '7655295256916658211', name: '摄影日常'}, {id: '7655295256916658212', name: '第二话题'}], 'large adjacent string IDs retain exact index pairing');
  const badPair = await nativeRequest('activities.detail', {id: '701'}, [{status_code: 0, activity_info: {activity_name: '合成官方活动'}, topics: [null, '摄影日常'], topics_ids: ['801', '802']}]);
  assert.deepEqual(badPair.result.data.topicChoices, [], 'filtering display topics must never shift ID pairing');
}
console.log('native activities: bounded directory hints, exact detail string ID pairing, eligibility and official detail text passed');

// 音乐目录是有界的真实配置；相同 ID 的不同 type 独立，数字身份只接受精确整数。
{
  const response = await nativeRequest('music.categories', {}, [{status_code: 0, categories: [
    {category_id: 0, type: 'recommend', category_name: '推荐'},
    {category_id: '1', type: 'rank', category_name: '热门榜'},
    {category_id: '1', type: 'category', category_name: '分类'},
    {category_id: '1', type: 'rank', category_name: '重复'},
    {category_id: '2', type: 'fav', category_name: '收藏'},
    {category_id: 7655295256916658000, type: 'category', category_name: '不可靠数字'},
    {category_id: '3', type: 'unknown', category_name: '未知'},
    {category_id: '4', type: 'category', category_name: ''},
  ]}]);
  assert.deepEqual(response.result.data.items, [{id: '0', type: 'recommend', name: '推荐'}, {id: '1', type: 'rank', name: '热门榜'}, {id: '1', type: 'category', name: '分类'}, {id: '2', type: 'fav', name: '收藏'}]);
  for (const categories of [null, {}, Array.from({length: 101}, () => ({}))]) assert.equal((await nativeRequest('music.categories', {}, [{status_code: 0, categories}])).result.ok, false);
  for (const cursor of [undefined, '20', 'bad', '', -1, 0.5, true, 9007199254740992, '1'.repeat(31)]) {
    const result = await nativeRequest('music.list', {category_id: '1', type: 'rank', cursor: '20', creation_id: 'fixture'}, [{status_code: 0, songs: [], has_more: 1, cursor}]);
    assert.equal(result.result.ok, false, 'missing, repeated, unsafe or malformed cursor must fail without a fabricated continuation');
  }
  const done = await nativeRequest('music.list', {category_id: '1', type: 'rank', cursor: '20', creation_id: 'fixture'}, [{status_code: 0, songs: [], has_more: 0}]);
  assert.equal(done.result.data.nextCursor, null);
}
// 实机收藏是长字符串令牌，最后一页 has_more:false/cursor:""；合成歌曲避免读取个人收藏明细。
{
  const cursor = '1749660141636916';
  const first = await nativeRequest('music.list', {category_id: '1', type: 'fav', cursor: '0', creation_id: 'fixture'}, [{status_code: 0,
    songs: [{music_id: '901', music_name: '合成收藏一', duration: 20}], has_more: true, cursor}]);
  assert.equal(first.result.ok, true); assert.equal(first.result.data.nextCursor, cursor); assert.equal(first.result.data.items.length, 1);
  const second = await nativeRequest('music.list', {category_id: '1', type: 'fav', cursor: first.result.data.nextCursor, creation_id: 'fixture'}, [{status_code: 0,
    songs: [{music_id: '902', music_name: '合成收藏二', duration: 30}], has_more: false, cursor: ''}]);
  assert.equal(new URL(second.calls[0].url).searchParams.get('cursor'), cursor, 'the exact returned string is sent without incrementing or converting its value');
  assert.equal(second.result.ok, true); assert.equal(second.result.data.nextCursor, null); assert.equal(second.result.data.items.length, 1);
  const lower = await nativeRequest('music.list', {category_id: '1', type: 'fav', cursor, creation_id: 'fixture'}, [{status_code: 0, songs: [], has_more: true, cursor: '1749000000000000'}]);
  assert.equal(lower.result.data.nextCursor, '1749000000000000', 'official code treats cursor as an opaque token, not a numerically increasing page counter');
  const exact = '9007199254740993';
  const longString = await nativeRequest('music.list', {category_id: '1', type: 'fav', cursor: exact, creation_id: 'fixture'}, [{status_code: 0, songs: [], has_more: true, cursor: '9007199254740992'}]);
  assert.equal(new URL(longString.calls[0].url).searchParams.get('cursor'), exact); assert.equal(longString.result.data.nextCursor, '9007199254740992');
  for (const invalid of [9007199254740992, '1'.repeat(31), '1e16', '-1', '']) assert.equal((await nativeRequest('music.list', {category_id: '1', type: 'fav', cursor: invalid, creation_id: 'fixture'}, [])).calls.length, 0);
}
console.log('native music catalog: real identities, bounded shape, exact long favorite cursors, terminal page and repeated-cursor rejection passed');

// 官方详情仅提供身份元数据：GET id 参数，不假装返回新的试听音源或时长。
{
  const reply = {status_code: 0, music_id: '900001', music_name: '平台更新后的名称', music_author: '合成作者', cover_url: 'https://media.example.test/cover.jpg'};
  const result = await nativeRequest('music.resolve', {id: '900001'}, [reply]);
  assert.equal(result.result.ok, true);
  const url = new URL(result.calls[0].url);
  assert.equal(url.pathname, '/web/api/media/music/info/');
  assert.deepEqual(Object.fromEntries(url.searchParams), {id: '900001'});
  assert.equal(result.calls[0].options.credentials, 'include');
  assert.equal(result.result.data.id, '900001'); assert.equal(result.result.data.name, reply.music_name);
  assert.equal(result.result.data.previewURL, null); assert.equal(result.result.data.duration, undefined);
  for (const params of [{id: 900001}, {id: 'x'}, {id: '900001', query: '名字'}, {id: '900001', url: 'https://example.test'}]) {
    const denied = await nativeRequest('music.resolve', params, []);
    assert.equal(denied.result.ok, false); assert.equal(denied.calls.length, 0);
  }
  for (const data of [{...reply, music_id: '900002'}, {...reply, music_id: 900001}, {...reply, music_name: ''}, {status_code: 5}, {status_code: 0}]) {
    assert.equal((await nativeRequest('music.resolve', {id: '900001'}, [data])).result.ok, false);
  }
}
console.log('native music info: official id query, exact ID binding, metadata-only response and malformed/unavailable rejection passed');
