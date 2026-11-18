import assert from 'node:assert/strict';
import {createStudioEngine} from '../app/platform/studio-engine.js';

const origin = 'http://127.0.0.1:8765';
const draft = (extra = {}) => ({id: 'draft-native', name: '合成测试作品', kind: 'image', assets: [{id: 'asset-a', name: 'photo.jpg', kind: 'image'}], title: '作品', description: '正文', topics: [], mentions: [], music: null, location: null, collection: null, cover: null, settings: {visibility: 'public', download: 'allow', publishTime: 'now', scheduledAt: '', declarations: []}, ...extra});

// harness 只模拟固定平台业务回执和图库上传元信息，不调用系统浏览器或真实网络。
function harness(shared = {}) {
  const values = shared.values || {}, state = {account: '123', hostAccount: '123', profile: 'profile-123', cookies: true, expiresAt: '2099-01-01T00:00:00Z', clock: 1800000000000, paths: [], musicRequests: [], statusReads: 0, queries: 0, uploads: 0, posts: [], failPost: false};
  let counter = 0;
  const storage = {
    async get(key) { return structuredClone(key ? {[key]: values[key]} : values); },
    async set(update) { Object.assign(values, structuredClone(update)); },
  };
  const send = async (input, options = {}) => {
    const url = new URL(input);
    assert.ok(url.origin === 'https://creator.douyin.com' || url.origin === 'https://tsearch.amemv.com' && url.pathname === '/openapi/aweme/v1/music/search/');
    state.paths.push(url.pathname);
    await state.onRequest?.(url, options);
    let data;
    switch (url.pathname) {
      case '/web/api/media/user/info/': data = {status_code: 0, user: {uid: state.account, nickname: '合成账号'}}; break;
      case '/web/api/media/music/category': data = {status_code: 0, categories: state.musicCategories ?? [{category_id: '1', type: 'recommend', category_name: '推荐'}]}; break;
      case '/web/api/media/music/list':
        state.musicRequests.push(Object.fromEntries(url.searchParams));
        data = state.musicPage?.(url) ?? {status_code: 0, songs: [{music_id: '333', music_name: '合成音乐', music_author: '作者', duration: 100}], has_more: true, cursor: String(Number(url.searchParams.get('cursor')) + 20)}; break;
      case '/web/api/media/aweme/search/post/auth': data = {status_code: 0, signature: 'synthetic-memory-only-signature'}; break;
      case '/openapi/aweme/v1/music/search/': data = state.musicSearchPage?.(url) ?? {status_code: 0, music: [{id_str: '333', title: '合成音乐', author: '作者', duration: 100}], has_more: false}; break;
      case '/web/api/v2/discover/search/': data = state.userPage?.(url) ?? {status_code: 0, user_list: [{uid: '601', nickname: '合成好友'}], has_more: false}; break;
      case '/aweme/v1/life/video_api/search/poi/': data = state.locationPage?.(url) ?? {status_code: 0, poi_list: [{poi_id: '401', poi_name: '合成公园', address_info: {simple_addr: '合成地址'}, anchor_post_ext: {anchor_content: '{"verified":true}'}, is_commerce_intention: false}], has_more: false}; break;
      case '/aweme/v3/user_declaration/suggestion/': data = {status_code: 0, data: state.declarations || {options: [], block_type: 0}}; break;
      case '/web/api/mix/list/': data = state.collectionPage?.(url) ?? {status_code: 0, has_more: 0, cursor: '0', mix_list: [{mix_id: '501', mix_name: '合成合集', type: 0, status: {status: 0}, statis: {updated_to_episode: 2}, cover_url: {url_list: ['https://media.example.test/fixture-collection-cover.jpg']}}]}; break;
      case '/web/api/media/hashtag/rec/': data = {status_code: 0, challenge_list: [{cid: '222', cha_name: '真实候选', view_count: 123}]}; break;
      case '/web/api/media/activity/get/': data = {status_code: 0, activity_list: state.activities ?? [{activity_id: '701', activity_name: '官方摄影活动', activity_status: 1, challenge: ['摄影日常'], challenge_ids: ['801'], hot_score: 419}]}; break;
      case '/web/api/media/activity/detail/': data = state.activityDetail ?? {status_code: 0, activity_info: {activity_id: '701', activity_name: '官方摄影活动'}, activity_description: '平台活动说明', topics: ['摄影日常'], topics_ids: ['801']}; break;
      case '/web/api/media/upload/auth/v5/': data = {status_code: 0, auth: JSON.stringify({AccessKeyID: 'synthetic-id', SecretAccessKey: 'temporary-secret', SessionToken: 'temporary-token', ExpiredTime: '2060-01-01T00:00:00Z'})}; break;
      case '/aweme/v1/search/challengesug/': state.queries++; data = state.topicPage?.(url) ?? {status_code: 0, sug_list: [{cid: '222', cha_name: '真实候选'}]}; break;
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
      state.onUpload?.();
      const auth = await deps.getAuth(); assert.equal(auth.SecretAccessKey, 'temporary-secret');
      const files = input.job.assets.map((asset, index) => ({uri: `tos/native-${index}.jpg`, uriStatus: 2000, imageWidth: 1000, imageHeight: 800}));
      await deps.checkpoint(files.map((file, index) => ({account: state.account, assetID: input.job.assets[index].id, revision: 'v1', kind: 'image', uploadFile: file})));
      if (state.failAfterCheckpoint) throw Error('合成素材准备失败');
      return {draft: await deps.buildImageDraft({files})};
    },
  };
  const sessionStatus = shared.sessionProfiles ? async () => {
    state.statusReads++;
    return {activeProfileId: state.profile, accountId: state.hostAccount, hasCookies: state.cookies, expiresAt: state.expiresAt};
  } : undefined;
  const engine = createStudioEngine({storage, send, sessionStatus, upload, now: () => state.clock, uuid: () => `native-${++counter}`});
  const run = (operation, params = {}) => engine.dispatch(operation, params, {origin});
  return {run, engine, state, values};
}
{
  const h = harness();
  assert.equal((await h.run('studio.session')).account.id, '123');
  await assert.rejects(h.run('arbitrary.fetch'), /尚未接入/);
  await assert.rejects(h.run('publication.prepare', {draft: draft({topics: [{id: '999', name: '真实候选'}]})}), error => error.code === 'CHOICE_UNAVAILABLE');
  assert.equal(h.state.uploads, 0);
  await h.run('topics.search', {query: '真实'});
  const prepared = await h.run('publication.prepare', {draft: draft({topics: [{id: '222', name: '真实候选'}]})});
  assert.equal(prepared.canPublish, true); assert.equal(h.state.queries, 4);
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

// 声明规则在媒体准备前后重查；不接受自造或已经失效的选项。
{
  const h = harness();
  h.state.declarations = {options: [{choose_value: 'aigc', text: '内容由AI生成'}], block_type: 1};
  const choices = await h.run('declarations.list', {kind: 'image', draftId: 'draft-native'});
  assert.equal(choices.required, true); assert.equal(choices.items[0].id, 'aigc');
  await assert.rejects(h.run('publication.prepare', {draft: draft()}), /需要自主声明/);
  assert.equal(h.state.uploads, 0);
  await assert.rejects(h.run('publication.prepare', {draft: draft({settings: {...draft().settings, declarations: ['invented']}})}), /声明已变化/);
  const value = draft({settings: {...draft().settings, declarations: ['aigc']}});
  const prepared = await h.run('publication.prepare', {draft: value});
  const record = Object.values(h.values['luma-studio-publications-v1'].preparations).find(item => item.preparationId === prepared.preparationId);
  assert.deepEqual(record.payload.item.declare, {user_declare_info: '{"choose_value":"aigc"}'});
  h.state.onUpload = () => { h.state.declarations = {options: [], block_type: 0}; };
  await assert.rejects(h.run('publication.prepare', {draft: value}), /声明已变化/);
  assert.ok(Object.keys(h.values).some(key => key.startsWith('studio-uploads:')));
}
{
  const h = harness();
  const empty = await h.run('topics.search', {query: '', kind: 'image', draftId: 'draft-native'});
  assert.deepEqual(empty.items, []); assert.match(empty.message, /上传图片后/);
  await h.run('publication.prepare', {draft: draft()});
  const recommended = await h.run('topics.search', {query: '', kind: 'image', draftId: 'draft-native'});
  assert.equal(recommended.items[0].id, '222'); assert.equal(recommended.items[0].viewCount, 123);
  const chosen = draft({topics: [{id: '222', name: '真实候选'}]});
  h.state.failAfterCheckpoint = true;
  await assert.rejects(h.run('publication.prepare', {draft: chosen}), /合成素材准备失败/);
  const key = Object.keys(h.values).find(value => value.startsWith('studio-uploads:'));
  assert.deepEqual(h.values[key].recommendationFrames, []);
  h.state.failAfterCheckpoint = false;
  assert.equal((await h.run('publication.prepare', {draft: chosen})).canPublish, true, 'retry verifies selected recommendation by name even when the old image snapshot was invalidated');
  h.state.account = '456';
  assert.deepEqual((await h.run('topics.search', {query: '', kind: 'image', draftId: 'draft-native'})).items, []);
}
console.log('native engine options: declaration freshness, required validation, upload checkpoint preservation and account-isolated recommendations passed');

// 封面与作品计数只供合集展示；发布仍使用独立重查的下一集，草稿和状态不保存封面地址。
{
  const h = harness();
  const choices = await h.run('collections.list', {kind: 'image', query: '合成'});
  assert.equal(choices.items[0].itemCount, 2); assert.equal(choices.items[0].order, 3);
  assert.equal(choices.items[0].description, '共 2 个作品');
  assert.equal(choices.items[0].thumbnailURL, 'https://media.example.test/fixture-collection-cover.jpg');
  const prepared = await h.run('publication.prepare', {draft: draft({collection: {id: '501', name: '合成合集'}})});
  const record = Object.values(h.values['luma-studio-publications-v1'].preparations).find(item => item.preparationId === prepared.preparationId);
  assert.deepEqual(record.payload.item.mix, {mix_id: '501', mix_order: 2});
  assert.equal(JSON.stringify(h.values).includes('fixture-collection-cover'), false);
}

// 读取复用仅限当前档案的近期平台核验；每次页面缓存命中仍检查宿主会话，并保持原候选时间。
{
  const h = harness({sessionProfiles: true});
  await h.run('studio.session');
  assert.deepEqual(h.state.paths, ['/web/api/media/user/info/']);
  const before = h.state.paths.length, statusBefore = h.state.statusReads;
  const page = await h.run('topics.search', {query: '真实'});
  assert.equal(h.state.paths.length - before, 1, 'warm topic lookup uses only its actual resource request');
  assert.equal(h.state.statusReads - statusBefore, 2, 'local profile is checked before and after every read');
  page.items[0].name = '不能污染缓存';
  assert.equal((await h.run('topics.search', {query: '真实'})).items[0].name, '真实候选');
  assert.equal(h.state.queries, 1);
  h.state.clock += 14999;
  await h.run('topics.search', {query: '真实'}); assert.equal(h.state.queries, 1);
  h.state.clock++;
  await h.run('topics.search', {query: '真实'}); assert.equal(h.state.queries, 2, 'page TTL is measured from retrieval, not last access');
  const declarationBefore = h.state.paths.length;
  await h.run('declarations.list', {kind: 'image', draftId: 'draft-native'});
  assert.equal(h.state.paths.length - declarationBefore, 1);
  h.state.clock += 45000;
  await h.run('topics.search', {query: '到期重查'});
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/user/info/').length, 2, 'identity is rechecked at sixty seconds');
  h.state.clock -= 1;
  await h.run('topics.search', {query: '时钟回拨'});
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/user/info/').length, 3, 'clock rollback cannot extend identity TTL');
  const stored = JSON.stringify(h.values);
  assert.equal(stored.includes('真实候选'), false, 'read pages and identity remain in memory only');
}

// 推荐音乐分类跨页复用，但每页仍读平台列表；关键词搜索严格保留官方每次授权链。
{
  const h = harness({sessionProfiles: true});
  await h.run('studio.session');
  const before = h.state.paths.length;
  await h.run('music.search', {query: ''});
  assert.equal(h.state.paths.length - before, 2);
  await h.run('music.search', {query: '', cursor: '20'});
  assert.equal(h.state.paths.length - before, 3, 'subsequent recommendation page requires only music/list');
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/music/category').length, 1);
  h.state.clock += 5 * 60 * 1000;
  await h.run('music.search', {query: '', cursor: '40'});
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/music/category').length, 2);
  const searchBefore = h.state.paths.length;
  await h.run('music.search', {query: '合成'});
  await h.run('music.search', {query: '第二个关键词'});
  assert.equal(h.state.paths.length - searchBefore, 4);
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/aweme/search/post/auth').length, 2);
  assert.equal(JSON.stringify(h.values).includes('synthetic-memory-only-signature'), false);
}

// 到期、宿主外部切换和在途失效不能返回旧候选；缓存也不能越过准备/发布的实时身份核验。
{
  const h = harness({sessionProfiles: true});
  await h.run('studio.session'); await h.run('topics.search', {query: '真实'});
  h.state.expiresAt = new Date(h.state.clock).toISOString();
  const before = h.state.paths.length;
  await assert.rejects(h.run('topics.search', {query: '真实'}), error => error.code === 'SESSION_EXPIRED');
  assert.equal(h.state.paths.length, before, 'expired profile is rejected before any remote lookup or cached return');
  h.state.expiresAt = '2099-01-01T00:00:00Z';
  const queriesBeforeRecovery = h.state.queries;
  assert.equal((await h.run('publication.prepare', {draft: draft({topics: [{id: '222', name: '真实候选'}]})})).canPublish, true);
  assert.equal(h.state.queries - queriesBeforeRecovery, 2, 'cleared provenance is recovered using fresh pre-upload and post-upload queries');
  await h.run('topics.search', {query: '真实'});
  h.state.profile = 'profile-456'; h.state.hostAccount = h.state.account = '456';
  const changedBefore = h.state.paths.length;
  await assert.rejects(h.engine.dispatch('topics.search', {query: '真实'}, {origin, expectedAccountId: '123'}), error => error.code === 'ACCOUNT_CHANGED');
  assert.equal(h.state.paths.length, changedBefore, 'an externally selected different account cannot receive the old account lookup');
}
{
  const h = harness({sessionProfiles: true}); await h.run('studio.session');
  h.state.onRequest = url => { if (url.pathname.includes('challengesug')) { h.state.profile = 'changed-profile'; h.state.onRequest = null; } };
  await assert.rejects(h.run('topics.search', {query: '真实'}), error => error.code === 'SESSION_CHANGED');
  h.state.profile = 'profile-123';
  const queriesBeforeRecovery = h.state.queries;
  assert.equal((await h.run('publication.prepare', {draft: draft({topics: [{id: '222', name: '真实候选'}]})})).canPublish, true);
  assert.equal(h.state.queries - queriesBeforeRecovery, 2, 'cleared provenance is recovered using fresh pre-upload and post-upload queries');
}
{
  const h = harness({sessionProfiles: true}); await h.run('studio.session');
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  h.state.onRequest = url => {
    if (url.pathname.includes('challengesug')) { started(); return new Promise(resolve => { release = resolve; }); }
  };
  const pending = h.run('topics.search', {query: '真实'});
  const outcome = assert.rejects(pending, error => error.code === 'SESSION_CHANGED');
  await waiting; h.engine.invalidate(); release(); await outcome;
  h.state.onRequest = null;
  const queriesBeforeRecovery = h.state.queries;
  assert.equal((await h.run('publication.prepare', {draft: draft({topics: [{id: '222', name: '真实候选'}]})})).canPublish, true);
  assert.equal(h.state.queries - queriesBeforeRecovery, 2, 'cleared provenance is recovered using fresh pre-upload and post-upload queries');
}
{
  const h = harness({sessionProfiles: true}); await h.run('studio.session');
  await h.run('topics.search', {query: '真实'});
  const prepared = await h.run('publication.prepare', {draft: draft({topics: [{id: '222', name: '真实候选'}]})});
  assert.equal(h.state.queries, 3, 'prepare bypasses page cache for both pre-upload and post-upload candidate checks');
  h.state.account = '456';
  await assert.rejects(h.engine.dispatch('publication.publish', {preparationId: prepared.preparationId, requestId: 'cached-account-mismatch', expectedAccountId: '123', confirmed: true}, {origin, expectedAccountId: '123'}), error => error.code === 'ACCOUNT_CHANGED');
  assert.equal(h.state.posts.length, 0, 'fresh publish identity gate cannot be replaced by a warm read identity');
}
console.log('native read performance: request counts, bounded TTL, category reuse, memory-only authorization, profile isolation, expiry, stale-result rejection and fresh publish identity passed');

// 所有分类来自同一真实目录；切换和翻页只读取所选分类列表，不能借前端参数构造未返回的分类。
{
  const h = harness({sessionProfiles: true});
  h.state.musicCategories = [
    {category_id: '1', type: 'rank', category_name: '热门榜'}, {category_id: '0', type: 'recommend', category_name: '推荐'},
    {category_id: '2', type: 'fav', category_name: '收藏'}, {category_id: '3', type: 'rank', category_name: '飙升榜'},
    {category_id: '4', type: 'rank', category_name: '原创榜'}, {category_id: '1', type: 'category', category_name: '后续分类'},
  ];
  h.state.musicPage = url => ({status_code: 0, songs: [{music_id: url.searchParams.get('type') === 'category' ? '334' : '333', music_name: url.searchParams.get('type'), duration: 100}], has_more: true, cursor: String(Number(url.searchParams.get('cursor')) + 20)});
  const catalog = await h.run('music.categories', {kind: 'image'});
  assert.equal(catalog.items.length, 6); assert.equal(catalog.items[0].name, '热门榜', 'platform order is retained instead of a hardcoded menu');
  catalog.items[0].name = '本地篡改';
  assert.equal((await h.run('music.categories')).items[0].name, '热门榜', 'returned category data cannot mutate the cached catalog');
  await h.run('music.search');
  assert.equal(h.state.musicRequests.at(-1).category_id, '0'); assert.equal(h.state.musicRequests.at(-1).type, 'recommend', 'default finds the actual recommendation category even if not first');
  for (const item of (await h.run('music.categories')).items) {
    await h.run('music.search', {categoryId: item.id, type: item.type, cursor: '0'});
    assert.equal(h.state.musicRequests.at(-1).category_id, item.id); assert.equal(h.state.musicRequests.at(-1).type, item.type);
  }
  const count = h.state.musicRequests.length;
  const rank = await h.run('music.search', {categoryId: '1', type: 'rank', cursor: '0'});
  const genre = await h.run('music.search', {categoryId: '1', type: 'category', cursor: '0'});
  assert.equal(rank.items[0].id, '333'); assert.equal(genre.items[0].id, '334'); assert.equal(h.state.musicRequests.length, count, 'different type/id pages remain distinct and reusable');
  await h.run('music.search', {categoryId: '3', type: 'rank', cursor: '20'});
  assert.equal(h.state.musicRequests.at(-1).cursor, '20');
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/music/category').length, 1, 'tabs and pages share one five-minute directory request');
  for (const params of [{categoryId: '999', type: 'rank'}, {categoryId: '3', type: 'fav'}, {categoryId: '3'}, {type: 'rank'}, {categoryId: 3, type: 'rank'}]) await assert.rejects(h.run('music.search', params), /音乐分类/);
  assert.equal(h.state.musicRequests.length, count + 1, 'forged categories never reach the platform music list');
  const beforeSearch = h.state.paths.length;
  await h.run('music.search', {query: '钢琴', categoryId: 'unused', type: 'unused'});
  assert.deepEqual(h.state.paths.slice(beforeSearch).filter(path => path !== '/web/api/media/user/info/'), ['/web/api/media/aweme/search/post/auth', '/openapi/aweme/v1/music/search/'], 'keyword search retains its authorization and search calls, independent of tabs');
  await assert.rejects(h.run('music.categories', {kind: 'video'}), /视频配乐/);
  assert.equal(JSON.stringify(h.values).includes('热门榜'), false, 'catalog metadata is memory only');
  const beforeProfile = h.state.paths.filter(path => path === '/web/api/media/music/category').length;
  h.state.profile = 'second-profile'; h.state.musicCategories = [{category_id: '9', type: 'rank', category_name: '新档案榜单'}];
  assert.equal((await h.run('music.categories')).items[0].id, '9');
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/music/category').length, beforeProfile + 1, 'a different profile must read its own catalog');
  await assert.rejects(h.run('music.search', {categoryId: '3', type: 'rank'}), /不可用/);
  await h.run('music.search'); assert.equal(h.state.musicRequests.at(-1).category_id, '9', 'without recommendation, default uses the first actual category');
  h.state.profile = 'third-profile'; h.state.account = h.state.hostAccount = '456';
  h.state.musicCategories = []; assert.deepEqual((await h.run('music.categories')).items, []);
  await assert.rejects(h.run('music.search'), /没有可用/);
}
for (const reason of ['failure', 'cancel', 'account']) {
  const h = harness({sessionProfiles: true}), controller = new AbortController();
  h.state.onRequest = async url => {
    if (url.pathname !== '/web/api/media/music/category') return;
    if (reason === 'failure') throw Error('合成分类读取失败');
    if (reason === 'cancel') controller.abort();
    else if (reason === 'account') { h.state.profile = 'other-profile'; h.state.account = h.state.hostAccount = '456'; }
  };
  await assert.rejects(h.engine.dispatch('music.categories', {}, {origin, signal: controller.signal, expectedAccountId: '123'}));
  h.state.onRequest = null; h.state.profile = 'profile-123'; h.state.account = h.state.hostAccount = '123';
  assert.equal((await h.run('music.categories')).items[0].id, '1');
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/music/category').length, 2, 'failure, cancellation or account change cannot cache a late category response and retry must requery');
}
console.log('native music tabs: real category identities, shared catalog, independent pages, default selection, account isolation and cancellation passed');

// 收藏的真实分页结构：首屏返回长字符串游标，续页原样发送，终页空游标仍保留该页歌曲。
{
  const h = harness({sessionProfiles: true}), cursor = '1749660141636916';
  h.state.musicCategories = [{category_id: '1', type: 'fav', category_name: '收藏'}];
  h.state.musicPage = url => url.searchParams.get('cursor') === '0'
    ? {status_code: 0, songs: [{music_id: '901', music_name: '合成收藏一', duration: 20}], cursor, has_more: true}
    : {status_code: 0, songs: [{music_id: '902', music_name: '合成收藏二', duration: 30}], cursor: '', has_more: false};
  const first = await h.run('music.search', {categoryId: '1', type: 'fav', cursor: '0'});
  assert.equal(first.nextCursor, cursor); assert.equal(first.items[0].id, '901');
  const last = await h.run('music.search', {categoryId: '1', type: 'fav', cursor: first.nextCursor});
  assert.equal(last.nextCursor, null); assert.equal(last.items[0].id, '902');
  assert.equal(h.state.musicRequests[1].cursor, cursor, 'the engine and native request preserve every digit of the favorite cursor');
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/music/category').length, 1);
  const repeated = await h.run('music.search', {categoryId: '1', type: 'fav', cursor});
  assert.equal(repeated.items[0].id, '902'); assert.equal(h.state.musicRequests.length, 2, 'long cursor pages retain the existing bounded page cache');
}
console.log('native favorite music: exact long cursor through full engine, terminal-page songs and shared catalog passed');

// 页面缓存有容量上限；被淘汰的查询会重新读取，不随连续搜索无限增长。
{
  const h = harness({sessionProfiles: true}); await h.run('studio.session');
  for (let index = 0; index < 65; index++) await h.run('topics.search', {query: `查询${index}`});
  assert.equal(h.state.queries, 65);
  await h.run('topics.search', {query: '查询64'}); assert.equal(h.state.queries, 65);
  await h.run('topics.search', {query: '查询0'}); assert.equal(h.state.queries, 66);
}

// 草稿中的活动身份必须用当前账号目录及单条详情重新确认，不依赖此前浏览或内存中的选择记录。
{
  const h = harness({sessionProfiles: true}), activity = {id: '701', name: '官方摄影活动', topic: {id: '801', name: '摄影日常'}};
  const value = draft({description: '作品 #摄影日常', topics: [{id: '801', name: '摄影日常'}], activities: [activity]});
  await h.run('activities.detail', {id: '701'});
  const items = await h.run('activities.list'); assert.equal(items.items[0].topicName, activity.topic.name); assert.equal(items.items[0].topic, undefined);
  await h.run('activities.list');
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/activity/get/').length, 1, 'read-only lists can reuse the short same-account cache');
  const prepared = await h.run('publication.prepare', {draft: value});
  assert.equal(prepared.canPublish, true);
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/activity/get/').length, 3, 'both preparation boundaries reread current activity eligibility');
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/activity/detail/').length, 3, 'detail browsing cannot replace either exact preparation check');
  assert.equal(h.state.queries, 0, 'an activity hashtag uses its verified detail rather than a separate generic topic search');
  const record = Object.values(h.values).flatMap(value => Object.values(value?.preparations || {})).find(value => value.preparationId === prepared.preparationId);
  assert.deepEqual(record.draft.activities, [activity]); assert.equal(record.payload.item.common.activity, '["801"]');
  assert.equal(record.payload.item.common.challenges, '["801"]'); assert.equal(h.state.posts.length, 0);
  h.state.hostAccount = h.state.account = '456'; h.state.profile = 'profile-other';
  await assert.rejects(h.engine.dispatch('publication.prepare', {draft: value}, {origin, expectedAccountId: '123'}), error => error.code === 'ACCOUNT_CHANGED');
  assert.equal(h.state.uploads, 1, 'a different account cannot upload for the expected account');
  h.state.activities = [];
  await assert.rejects(h.engine.dispatch('publication.prepare', {draft: value}, {origin, expectedAccountId: '456'}), /已变化或不可用/);
  assert.equal(h.state.uploads, 1, 'switching accounts requires current eligibility and cannot reuse the old directory');
}

{
  const h = harness(), activity = {id: '701', name: '官方摄影活动', topic: {id: '801', name: '摄影日常'}};
  await h.run('activities.resolve', {id: activity.id});
  await assert.rejects(h.run('publication.prepare', {draft: draft({activities: [{...activity, topic: {id: '999', name: '伪造活动话题'}}]})}), /活动话题/);
  assert.equal(h.state.uploads, 0);
  h.state.activities = [];
  await assert.rejects(h.run('publication.prepare', {draft: draft({activities: [activity]})}), /已变化或不可用/);
  assert.equal(h.state.uploads, 0);
}
for (const change of ['game', 'ended', 'topic']) {
  const h = harness(), activity = {id: '701', name: '官方摄影活动', topic: {id: '801', name: '摄影日常'}};
  await h.run('activities.resolve', {id: activity.id});
  h.state.onUpload = () => { h.state.activities = [{activity_id: '701', activity_name: '官方摄影活动', activity_status: change === 'ended' ? 2 : 1,
    challenge: ['摄影日常'], challenge_ids: ['801'], game_id: change === 'game' ? '901' : ''}];
    if (change === 'topic') h.state.activityDetail = {status_code: 0, activity_info: {activity_id: '701', activity_name: '官方摄影活动'}, topics: ['摄影日常'], topics_ids: ['802']}; };
  await assert.rejects(h.run('publication.prepare', {draft: draft({activities: [activity]})}), /游戏推广|可参加状态|已变化或不可用/);
  assert.equal(h.state.uploads, 1); assert.equal(h.state.posts.length, 0);
  assert.equal(Object.values(h.values).flatMap(value => Object.values(value?.preparations || {})).length, 0, 'changed eligibility after upload cannot yield a publishable snapshot');
}
// 平台目录可能在服务端把 ID 舍入，详情字符串才是唯一准确来源；列表变化不得偷偷替换已选身份。
{
  const h = harness(), exact = '7655295256916658211';
  h.state.activities = [{activity_id: '701', activity_name: '官方摄影活动', activity_status: 1, challenge: ['摄影日常'], challenge_ids: [7655295256916658000]}];
  h.state.activityDetail = {status_code: 0, activity_info: {activity_id: '701', activity_name: '官方摄影活动'}, topics: ['摄影日常'], topics_ids: [exact]};
  const listed = await h.run('activities.list'); assert.equal(listed.items[0].topic, undefined);
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/activity/detail/').length, 0, 'listing does not fan out detail requests');
  const resolved = await h.run('activities.resolve', {id: '701'}); assert.equal(resolved.topic.id, exact);
  const activity = {id: resolved.id, name: resolved.name, topic: resolved.topic};
  const value = draft({description: '作品 #摄影日常', activities: [activity], topics: [activity.topic]});
  const prepared = await h.run('publication.prepare', {draft: value});
  const record = Object.values(h.values).flatMap(value => Object.values(value?.preparations || {})).find(value => value.preparationId === prepared.preparationId);
  assert.equal(record.payload.item.common.activity, JSON.stringify([exact])); assert.equal(record.payload.item.common.challenges, JSON.stringify([exact]));
  await assert.rejects(h.run('publication.prepare', {draft: draft({activities: [{...activity, topic: {...activity.topic, id: '7655295256916658000'}}]})}), /活动话题/);
  assert.equal(h.state.posts.length, 0);
}
for (const patch of [{topics_ids: undefined}, {topics_ids: [801]}, {topics_ids: ['801', '802']}, {topics: ['不同话题'], topics_ids: ['801']}, {topics: ['摄影日常', '摄影日常'], topics_ids: ['801', '802']}]) {
  const h = harness();
  h.state.activityDetail = {status_code: 0, activity_info: {activity_id: '701', activity_name: '官方摄影活动'}, topics: ['摄影日常'], topics_ids: ['801'], ...patch};
  await assert.rejects(h.run('activities.resolve', {id: '701'}), /话题身份无法确认/);
  await assert.rejects(h.run('publication.prepare', {draft: draft({activities: [{id: '701', name: '官方摄影活动', topic: {id: '801', name: '摄影日常'}}]})}), /话题身份无法确认/);
  assert.equal(h.state.uploads, 0, 'restoration cannot bypass precise activity identity resolution');
}
{
  const h = harness(), selected = await h.run('activities.resolve', {id: '701'});
  h.state.activityDetail = {status_code: 0, activity_info: {activity_id: '701', activity_name: '官方摄影活动'}, topics: ['摄影日常'], topics_ids: ['802']};
  await assert.rejects(h.run('publication.prepare', {draft: draft({activities: [selected]})}), /已变化或不可用/);
  assert.equal(h.state.uploads, 0, 'an accurate detail ID changing before preparation is rejected before uploading');
}
for (const reason of ['account', 'cancel']) {
  const h = harness({sessionProfiles: true}), controller = new AbortController();
  h.state.onRequest = async url => {
    if (url.pathname !== '/web/api/media/activity/detail/') return;
    if (reason === 'account') { h.state.profile = 'profile-other'; h.state.account = h.state.hostAccount = '456'; }
    else controller.abort();
  };
  await assert.rejects(h.engine.dispatch('activities.resolve', {id: '701'}, {origin, signal: controller.signal, expectedAccountId: '123'}));
  h.state.onRequest = null; h.state.profile = 'profile-123'; h.state.account = h.state.hostAccount = '123';
  assert.equal(h.state.uploads, 0, 'a cancelled or changed-account response cannot start an upload');
  const detailBeforeRecovery = h.state.paths.filter(path => path === '/web/api/media/activity/detail/').length;
  assert.equal((await h.run('publication.prepare', {draft: draft({activities: [{id: '701', name: '官方摄影活动', topic: {id: '801', name: '摄影日常'}}]})})).canPublish, true);
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/activity/detail/').length - detailBeforeRecovery, 2, 'retry queries exact current details before and after upload instead of adopting the late response');
}
console.log('native activities engine: exact detail identities, restored drafts, current-account eligibility and fresh pre/post-upload checks passed');

// preparedRecord 读取离线准备快照，以验证提交字段来自平台响应而不是草稿附加值。
function preparedRecord(h, prepared) {
  return h.values['luma-studio-publications-v1'].preparations[prepared.preparationId];
}

// collectionFixture 模拟一项可发布的普通合集；作品数量用于确认重新计算下一集序号。
function collectionFixture(id = '501', name = '合成合集', count = 2) {
  return {mix_id: id, mix_name: name, type: 0, status: {status: 0}, statis: {updated_to_episode: count}};
}

// 重建引擎只恢复本机存储，所有选择仍显示，但必须重新从当前账号取得可信发布字段。
{
  const h = harness();
  await h.run('music.search'); await h.run('topics.search', {query: '真实'});
  const value = draft({topics: [{id: '222', name: '真实候选'}], mentions: [{id: '601', name: '合成好友'}],
    music: {id: '333', name: '合成音乐', duration: 9999},
    location: {id: '401', name: '合成公园', cityCode: '440300', cityName: '深圳市', extra: '{"untrusted":true}'},
    collection: {id: '501', name: '合成合集', order: 9999}});
  const snapshot = structuredClone(value), restarted = harness(h), locationRequests = [];
  restarted.state.onRequest = url => { if (url.pathname.includes('/search/poi/')) locationRequests.push(Object.fromEntries(url.searchParams)); };
  const prepared = await restarted.run('publication.prepare', {draft: value}), record = preparedRecord(restarted, prepared);
  assert.equal(prepared.canPublish, true); assert.deepEqual(value, snapshot, 'revalidation leaves the saved draft untouched');
  assert.equal(record.payload.item.common.music_end_time, 100000, 'music duration is reacquired, never copied from the draft');
  assert.deepEqual(record.payload.item.anchor, {poi_id: '401', poi_name: '合成公园', anchor_content: '{"verified":true,"is_commerce_intention":false}'});
  assert.deepEqual(record.payload.item.mix, {mix_id: '501', mix_order: 2});
  assert.equal(locationRequests.length, 2);
  for (const params of locationRequests) {
    assert.equal(params.selected_city_code, '440300'); assert.equal(params.selected_city_name, '深圳市'); assert.equal(params.keywords, '合成公园');
  }
  assert.equal(restarted.state.paths.filter(path => path.includes('/music/search/')).length, 1, 'freshly recovered music is reused across the two preparation boundaries');
  assert.equal(restarted.state.queries, 2, 'topics are freshly verified at both preparation boundaries');
  assert.equal(restarted.state.paths.filter(path => path === '/web/api/v2/discover/search/').length, 2);
  assert.equal(restarted.state.posts.length, 0, 'restoring a selection does not publish');
}

// 三十分钟到期和时钟回拨都重新查询音乐；近期候选不能通过延后读取无限续期。
for (const delta of [30 * 60 * 1000, -1]) {
  const h = harness(); await h.run('music.search');
  h.state.clock += delta;
  h.state.musicSearchPage = () => ({status_code: 0, music: [{id_str: '333', title: '合成音乐', duration: 23}], has_more: false});
  const prepared = await h.run('publication.prepare', {draft: draft({music: {id: '333', name: '合成音乐'}})});
  assert.equal(preparedRecord(h, prepared).payload.item.common.music_end_time, 23000);
  assert.equal(h.state.paths.filter(path => path.includes('/music/search/')).length, 1);
}

// 查询文本有一百字上限，完整资源名称仍参与精确身份比较，不能误选同名前缀。
{
  const h = harness(), name = '长'.repeat(110), queries = [];
  h.state.musicSearchPage = url => {
    queries.push(url.searchParams.get('keyword'));
    return {status_code: 0, music: [{id_str: '333', title: name, duration: 20}], has_more: false};
  };
  assert.equal((await h.run('publication.prepare', {draft: draft({music: {id: '333', name}})})).canPublish, true);
  assert.deepEqual(queries, [name.slice(0, 100)]);
}

// 后页资源按平台游标查找；上传后列表重排时，旧页查不到应回到名称查询起点。
{
  const h = harness(), cursors = [];
  h.state.collectionPage = url => {
    const cursor = url.searchParams.get('cursor'); cursors.push(cursor);
    if (h.state.uploads) return {status_code: 0, has_more: 0, cursor: '0', mix_list: cursor === '0' ? [collectionFixture('501', '合成合集', 7)] : []};
    return cursor === '0' ? {status_code: 0, has_more: 1, cursor: '20', mix_list: [collectionFixture('502', '其他合集')]}
      : {status_code: 0, has_more: 0, cursor: '0', mix_list: [collectionFixture()]};
  };
  const prepared = await h.run('publication.prepare', {draft: draft({collection: {id: '501', name: '合成合集'}})});
  assert.deepEqual(cursors, ['0', '20', '20', '0']);
  assert.deepEqual(preparedRecord(h, prepared).payload.item.mix, {mix_id: '501', mix_order: 7}, 'publication uses the post-upload order');
}
{
  const h = harness(), cursors = [];
  h.state.musicSearchPage = url => {
    const cursor = url.searchParams.get('cursor'); cursors.push(cursor);
    return cursor === '0' ? {status_code: 0, music: [{id_str: '334', title: '合成音乐', duration: 5}], has_more: true, cursor: '20'}
      : {status_code: 0, music: [{id_str: '333', title: '合成音乐', duration: 30}], has_more: false};
  };
  const prepared = await h.run('publication.prepare', {draft: draft({music: {id: '333', name: '合成音乐'}})});
  assert.deepEqual(cursors, ['0', '20']); assert.equal(preparedRecord(h, prepared).payload.item.common.music_end_time, 30000);
}

// 无匹配时最多查五页；循环游标不能无限请求，失效选择不会开始上传。
for (const cycle of [false, true]) {
  const h = harness(), cursors = [];
  h.state.collectionPage = url => {
    const cursor = url.searchParams.get('cursor'); cursors.push(cursor);
    return {status_code: 0, has_more: 1, cursor: cycle ? cursor === '0' ? '20' : '0' : String(Number(cursor) + 10), mix_list: []};
  };
  await assert.rejects(h.run('publication.prepare', {draft: draft({collection: {id: '501', name: '合成合集'}})}), error => error.code === 'CHOICE_UNAVAILABLE');
  assert.deepEqual(cursors, cycle ? ['0', '20'] : ['0', '10', '20', '30', '40']); assert.equal(h.state.uploads, 0);
}

// 同名不同身份、同身份改名和恢复请求失败均保留草稿，且在上传之前停止。
for (const mismatch of [{id: '334', name: '合成音乐'}, {id: '333', name: '已改名'}]) {
  const h = harness(), value = draft({music: {id: '333', name: '合成音乐'}}), snapshot = structuredClone(value);
  h.state.musicSearchPage = () => ({status_code: 0, music: [{id_str: mismatch.id, title: mismatch.name, duration: 20}], has_more: false});
  await assert.rejects(h.run('publication.prepare', {draft: value}), error => error.code === 'CHOICE_UNAVAILABLE' && /音乐「合成音乐」/.test(error.message));
  assert.equal(h.state.uploads, 0); assert.deepEqual(value, snapshot);
}
{
  const h = harness();
  h.state.onRequest = url => { if (url.pathname.includes('/music/search/')) throw Error('合成断网'); };
  await assert.rejects(h.run('publication.prepare', {draft: draft({music: {id: '333', name: '合成音乐'}})}), error => error.code === 'CHOICE_LOOKUP_FAILED');
  assert.equal(h.state.uploads, 0); assert.equal(h.state.posts.length, 0);
}
{
  const h = harness();
  await assert.rejects(h.run('publication.prepare', {draft: draft({location: {id: '401', name: '合成公园'}})}), error => error.code === 'CHOICE_LOCATION_CITY_REQUIRED');
  assert.equal(h.state.uploads, 0);
}

// 恢复期间账号改变或取消不能采用迟到候选；上传后资源身份变化也不能生成可发布快照。
for (const reason of ['account', 'cancel']) {
  const h = harness({sessionProfiles: true}), controller = new AbortController();
  h.state.onRequest = url => {
    if (!url.pathname.includes('/music/search/')) return;
    if (reason === 'account') h.state.account = h.state.hostAccount = '456';
    else controller.abort();
  };
  await assert.rejects(h.engine.dispatch('publication.prepare', {draft: draft({music: {id: '333', name: '合成音乐'}})},
    {origin, expectedAccountId: '123', signal: controller.signal}), error => reason === 'account' ? error.code === 'ACCOUNT_CHANGED' : error.name === 'AbortError');
  assert.equal(h.state.uploads, 0); assert.equal(h.state.posts.length, 0);
}
{
  const h = harness();
  h.state.onUpload = () => { h.state.locationPage = () => ({status_code: 0, poi_list: [{poi_id: '401', poi_name: '公园已改名'}], has_more: false}); };
  await assert.rejects(h.run('publication.prepare', {draft: draft({location: {id: '401', name: '合成公园', cityCode: '440300', cityName: '深圳市'}})}), error => error.code === 'CHOICE_UNAVAILABLE');
  assert.equal(h.state.uploads, 1); assert.equal(h.state.posts.length, 0);
  assert.equal(Object.keys(h.values['luma-studio-publications-v1']?.preparations || {}).length, 0);
}
console.log('native draft restoration: restart, expired music, exact identity, city metadata, bounded pagination, failed lookup, cancellation and current-account revalidation passed');
