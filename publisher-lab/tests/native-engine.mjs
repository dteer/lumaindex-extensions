import assert from 'node:assert/strict';
import {createStudioEngine} from '../app/platform/studio-engine.js';
import {importImages as importNativeImages} from '../app/platform/import-images.js';
import {importVideo as importNativeVideo} from '../app/platform/import-video.js';
import {resolveAssets as resolveNativeAssets} from '../app/platform/media.js';

const origin = 'http://127.0.0.1:8765';
const draft = (extra = {}) => ({id: 'draft-native', name: '合成测试作品', kind: 'image', assets: [{id: 'asset-a', name: 'photo.jpg', kind: 'image'}], title: '作品', description: '正文', topics: [], mentions: [], music: null, location: null, collection: null, cover: null, settings: {visibility: 'public', download: 'allow', publishTime: 'now', scheduledAt: '', declarations: []}, ...extra});

// harness 只模拟固定平台业务回执和图库上传元信息，不调用系统浏览器或真实网络。
function harness(shared = {}) {
  const values = shared.values || {}, state = {account: '123', hostAccount: '123', profile: 'profile-123', cookies: true, browserReady: true, expiresAt: '2099-01-01T00:00:00Z', clock: 1800000000000, paths: [], musicRequests: [], statusReads: 0, storageReads: 0, storageWrites: 0, queries: 0, uploads: 0, posts: [], failPost: false};
  let counter = 0;
  const storage = {
    async get(key) { state.storageReads++; await state.onStorageGet?.(key); return structuredClone(key ? {[key]: values[key]} : values); },
    async set(update) { state.storageWrites++; await state.onStorageSet?.(update); Object.assign(values, structuredClone(update)); },
  };
  const send = async (input, options = {}) => {
    const url = new URL(input);
    assert.ok(url.origin === 'https://creator.douyin.com' || url.origin === 'https://tsearch.amemv.com' && url.pathname === '/openapi/aweme/v1/music/search/');
    state.paths.push(url.pathname);
    await state.onRequest?.(url, options);
    let data;
    switch (url.pathname) {
      case '/web/api/media/user/info/': data = {status_code: 0, user: {uid: state.account, nickname: '合成账号'}}; break;
      case '/web/api/media/video/enable/': data = {status_code: 0}; break;
      case '/web/api/media/video/transend/':
        state.videoPolls = (state.videoPolls || 0) + 1;
        data = {status_code: 0, encode: state.videoPolls >= (state.videoReadyAfter || 1) ? 1 : 0, duration: 10, width: 1920, height: 1080, poster_uri: 'tos/cover.jpg', format: 'mp4', play_url: 'https://media.example.test/video.mp4'};
        break;
      case '/web/api/media/music/info/': data = state.musicInfoPage?.(url) ?? {status_code: 0, music_id: url.searchParams.get('id'), music_name: '合成音乐', music_author: '作者', cover_url: 'https://media.example.test/cover.jpg'}; break;
      case '/web/api/media/music/category': data = {status_code: 0, categories: state.musicCategories ?? [{category_id: '1', type: 'recommend', category_name: '推荐'}]}; break;
      case '/web/api/media/music/list':
        state.musicRequests.push(Object.fromEntries(url.searchParams));
        data = state.musicPage?.(url) ?? {status_code: 0, songs: [{music_id: '333', music_name: '合成音乐', music_author: '作者', duration: 100, play_url: 'https://media.example.test/333.mp3'}], has_more: true, cursor: String(Number(url.searchParams.get('cursor')) + 20)}; break;
      case '/web/api/media/aweme/search/post/auth': data = {status_code: 0, signature: 'synthetic-memory-only-signature'}; break;
      case '/openapi/aweme/v1/music/search/': data = state.musicSearchPage?.(url) ?? {status_code: 0, music: [{id_str: '333', title: '合成音乐', author: '作者', duration: 100, play_url: {url_list: ['https://media.example.test/333.mp3']}}], has_more: false}; break;
      case '/web/api/v2/discover/search/': data = state.userPage?.(url) ?? {status_code: 0, user_list: [{uid: '601', nickname: '合成好友'}], has_more: false}; break;
      case '/aweme/v1/life/video_api/search/poi/': data = state.locationPage?.(url) ?? {status_code: 0, poi_list: [{poi_id: '401', poi_name: '合成公园', address_info: {simple_addr: '合成地址'}, anchor_post_ext: {anchor_content: '{"verified":true}'}, is_commerce_intention: false}], has_more: false}; break;
      case '/aweme/v3/user_declaration/suggestion/': data = {status_code: 0, data: state.declarations || {options: [], block_type: 0}}; break;
      case '/web/api/mix/list/': data = state.collectionPage?.(url) ?? {status_code: 0, has_more: 0, cursor: '0', mix_list: [{mix_id: '501', mix_name: '合成合集', type: 0, status: {status: 0}, statis: {updated_to_episode: 2}, cover_url: {url_list: ['https://media.example.test/fixture-collection-cover.jpg']}}]}; break;
      case '/web/api/media/hashtag/rec/': data = {status_code: 0, challenge_list: [{cid: '222', cha_name: '真实候选', view_count: 123}]}; break;
      case '/aweme/v1/hotspot/search/': data = {status_code: 0, sentences: [{word: '城市日落', hot_value: 123}]}; break;
      case '/aweme/v1/hotspot/recommend/': data = state.hotspotPage?.(url) ?? {status_code: 0, rec_sentences: [{word: '推荐热点'}], all_sentences: [{word: '全部热点'}]}; break;
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
      state.onUpload?.(input);
      const auth = await deps.getAuth(); assert.equal(auth.SecretAccessKey, 'temporary-secret');
      const files = input.job.assets.map((asset, index) => ({uri: `tos/native-${index}.jpg`, uriStatus: 2000, imageWidth: 1000, imageHeight: 800}));
      await deps.checkpoint(files.map((file, index) => ({account: state.account, assetID: input.job.assets[index].id, revision: 'v1', kind: 'image', uploadFile: file})));
      if (state.failAfterCheckpoint) throw Error('合成素材准备失败');
      return {draft: await deps.buildImageDraft({files})};
    },
  };
  const sessionStatus = shared.sessionProfiles ? async () => {
    state.statusReads++;
    if (state.statusOverride !== undefined) return state.statusOverride;
    return {activeProfileId: state.profile, accountId: state.hostAccount, hasCookies: state.cookies, browserSessionAvailable: state.browserReady, expiresAt: state.expiresAt};
  } : undefined;
  const engine = createStudioEngine({storage, send, sessionStatus, upload: {...upload, ...shared.upload}, now: () => state.clock, uuid: () => `native-${++counter}`});
  const run = (operation, params = {}, context = {}) => engine.dispatch(operation, params, {origin, profileId: state.profile, ...context});
  return {run, engine, state, values};
}

// 热点为独立字符串关联，普通读取不查远端账号；完整图文快照只用于同账号同草稿推荐。
{
  const h = harness({sessionProfiles: true}), requests = [];
  h.state.onRequest = url => requests.push(new URL(url));
  assert.ok(h.engine.capabilities().operations.includes('hotspots.search'));
  const empty = await h.run('hotspots.search', {query: '', kind: 'image', draftId: 'draft-native'});
  assert.deepEqual(empty, {items: [{name: '推荐热点'}, {name: '全部热点'}], nextCursor: null});
  assert.deepEqual(h.state.paths, ['/aweme/v1/hotspot/recommend/'], '图文上传前也读取平台热点，不额外查询账号');
  assert.equal(requests.at(-1).searchParams.get('zip_uri'), '');
  h.state.hotspotPage = () => ({status_code: 0, rec_sentences: [], all_sentences: [{word: '刚更新的热点'}]});
  assert.deepEqual((await h.run('hotspots.search', {query: '', kind: 'image', draftId: 'draft-native'})).items, [{name: '刚更新的热点'}]);
  assert.equal(h.state.paths.length, 2, '重复打开空关键词列表必须读当前数据，不复用旧热点');
  h.state.hotspotPage = undefined;
  for (const kind of ['image', 'video']) {
    const result = await h.run('hotspots.search', {query: '日落', kind});
    assert.deepEqual(result.items, [{name: '城市日落', heat: 123}]);
    assert.equal(result.nextCursor, null);
  }
  assert.equal(h.state.paths.includes('/web/api/media/user/info/'), false);
  const recommendedVideo = await h.run('hotspots.search', {kind: 'video', query: ''});
  assert.equal(recommendedVideo.items[0].name, '推荐热点');
  assert.equal(requests.at(-1).searchParams.get('zip_uri'), '');
  const priorHotspotReads = h.state.paths.filter(path => path.includes('/hotspot/')).length;
  const value = draft({hotspot: '城市日落'}), prepared = await h.run('publication.prepare', {draft: value});
  assert.equal(preparedRecord(h, prepared).payload.item.common.hot_sentence, '城市日落');
  assert.equal(preparedRecord(h, prepared).draft.hotspot, '城市日落');
  assert.equal(h.state.paths.filter(path => path.includes('/hotspot/')).length, priorHotspotReads, '准备不重新查询已选热点词或构造来源池');
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/user/info/').length, 1, '准备只保留原有入口账号核验');
  await h.run('publication.publish', {preparationId: prepared.preparationId, requestId: 'hotspot-submit', expectedAccountId: '123', confirmed: true});
  assert.equal(h.state.posts[0].item.common.hot_sentence, '城市日落');
  assert.equal(h.state.paths.filter(path => path.includes('/hotspot/')).length, priorHotspotReads, '提交使用固定快照，不增加热点查询');
  const recommended = await h.run('hotspots.search', {query: '', kind: 'image', draftId: value.id});
  assert.deepEqual(recommended.items, [{name: '推荐热点'}, {name: '全部热点'}]);
  assert.equal(requests.at(-1).searchParams.get('zip_uri'), 'tos/native-0.jpg');
  const reads = h.state.paths.length;
  assert.equal((await h.run('hotspots.search', {kind: 'image', draftId: 'another-draft'})).items.length, 2);
  assert.equal(requests.at(-1).searchParams.get('zip_uri'), '', '不同草稿只读取默认热点，不复用上传素材');
  h.state.hostAccount = h.state.account = '456';
  assert.equal((await h.run('hotspots.search', {kind: 'image', draftId: value.id})).items.length, 2);
  assert.equal(requests.at(-1).searchParams.get('zip_uri'), '', '不同账号只读取默认热点，不复用旧账号上传素材');
  assert.equal(h.state.paths.length, reads + 2);
  for (const params of [{query: {}}, {query: '词'.repeat(501)}, {kind: 'other'}, {draftId: 123}]) await assert.rejects(h.run('hotspots.search', params), /热点查询参数/);
}
for (const reason of ['cancel', 'account-change']) {
  const h = harness({sessionProfiles: true}), controller = new AbortController();
  let finish, start;
  const started = new Promise(resolve => { start = resolve; });
  h.state.onRequest = async url => {
    if (!url.pathname.includes('/hotspot/')) return;
    start(); await new Promise(resolve => { finish = resolve; });
  };
  const pending = h.run('hotspots.search', {query: '日落'}, {signal: controller.signal, expectedAccountId: '123'});
  const rejection = assert.rejects(pending, error => reason === 'cancel' ? error.name === 'AbortError' : error.code === 'ACCOUNT_CHANGED');
  await started;
  if (reason === 'cancel') controller.abort(); else h.state.profile = 'profile-456';
  finish(); await rejection;
  assert.equal(h.state.storageWrites, 0, '取消或换号的热点结果不能写持久化状态');
}
console.log('native hotspots engine: fixed string payload, no extra account/hotspot verification, complete snapshot recommendation and cancellation/account isolation passed');
{
  const h = harness();
  assert.equal((await h.run('studio.session')).account.id, '123');
  await assert.rejects(h.run('arbitrary.fetch'), /尚未接入/);
  await assert.rejects(h.run('publication.prepare', {draft: draft({topics: [{id: 'invalid-id', name: '真实候选'}]})}), /未经确认的身份/);
  assert.equal(h.state.uploads, 0);
  await h.run('topics.search', {query: '真实'});
  const prepared = await h.run('publication.prepare', {draft: draft({topics: [{id: '222', name: '真实候选'}]})});
  assert.equal(prepared.canPublish, true); assert.equal(h.state.queries, 1, 'only explicit topic browsing searches the platform');
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
console.log('native engine: fixed protocol, validated identity format, upload checkpoints, persistent one-shot submit and unknown restart passed');

// 明确选择的名称话题按官网0标记提交；准备无需为其远程搜索或替换成猜测的既存身份。
{
  const h = harness({sessionProfiles: true});
  const value = draft({description: '拍摄日期\n#20190701 #新主题', topics: [{id: '0', name: '20190701'}, {id: '0', name: '新主题'}]});
  const before = structuredClone(value);
  const result = await h.run('publication.prepare', {draft: value});
  assert.equal(result.canPublish, true);
  const common = preparedRecord(h, result).payload.item.common;
  assert.deepEqual(JSON.parse(common.text_extra).filter(item => item.type === 1).map(item => [item.hashtag_id, item.hashtag_name]), [[0, '20190701'], [0, '新主题']]);
  assert.equal(common.challenges, '[]'); assert.equal(common.hashtag_source, 'search/search');
  assert.equal(h.state.paths.filter(path => path.includes('challengesug') || path.includes('/hashtag/')).length, 0);
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/user/info/').length, 1);
  assert.equal(h.state.uploads, 1); assert.equal(h.state.posts.length, 0);
  assert.deepEqual(value, before);
  const mixed = await h.run('publication.prepare', {draft: {...value, topics: [...value.topics, {id: '222', name: '真实候选'}]}});
  assert.equal(preparedRecord(h, mixed).payload.item.common.challenges, '["222"]');
  assert.equal(h.state.paths.filter(path => path.includes('challengesug')).length, 0, 'saved positive topic IDs are not searched again during preparation');
}
console.log('native name-topic preparation: zero-search explicit names and saved IDs, numeric-zero payload and no publication passed');

// 声明规则在媒体准备时读取一次；不接受自造或准备前已经失效的选项。
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
  const next = await h.run('publication.prepare', {draft: value});
  assert.deepEqual(preparedRecord(h, next).payload.item.declare, {user_declare_info: '{"choose_value":"aigc"}'}, 'the confirmed declaration is reused within this preparation');
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
  assert.equal((await h.run('publication.prepare', {draft: chosen})).canPublish, true, 'retry retains the selected topic ID even when its recommendation image snapshot was invalidated');
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

// 普通读取只核对本机档案；页面缓存保持有界，但不定时发起额外的远端账号查询。
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
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/user/info/').length, 1, 'ordinary reads do not recheck remote identity after sixty seconds');
  h.state.clock -= 1;
  await h.run('topics.search', {query: '时钟回拨'});
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/user/info/').length, 1, 'clock rollback does not introduce an account-check timer');
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

// 离线保留当前资料，真实业务请求自行报错；换号仍隔离候选，准备/发布仍核对真实身份。
{
  const h = harness({sessionProfiles: true});
  await h.run('studio.session'); await h.run('topics.search', {query: '真实'});
  h.state.expiresAt = new Date(h.state.clock).toISOString();
  h.state.cookies = false;
  await h.run('topics.search', {query: '真实'});
  h.state.browserReady = false;
  const before = h.state.paths.length;
  assert.equal((await h.run('topics.search', {query: '真实'})).items[0].id, '222');
  assert.equal(h.state.paths.length, before, 'offline does not discard an existing local result');
  h.state.onRequest = () => { throw Object.assign(Error('合成平台连接不可用'), {code: 'SESSION_EXPIRED'}); };
  await assert.rejects(h.run('topics.search', {query: '离线新查询'}), /平台连接不可用/);
  h.state.onRequest = null;
  h.state.browserReady = true;
  const queriesBeforeRecovery = h.state.queries;
  assert.equal((await h.run('publication.prepare', {draft: draft({topics: [{id: '222', name: '真实候选'}]})})).canPublish, true);
  assert.equal(h.state.queries - queriesBeforeRecovery, 0, 'recovery preserves saved topic identities without another search');
  await h.run('topics.search', {query: '真实'});
  h.state.profile = 'profile-456'; h.state.hostAccount = h.state.account = '456';
  const changedBefore = h.state.paths.length;
  await assert.rejects(h.engine.dispatch('topics.search', {query: '真实'}, {origin, profileId: h.state.profile, expectedAccountId: '123'}), error => error.code === 'ACCOUNT_CHANGED');
  assert.equal(h.state.paths.length, changedBefore, 'an externally selected different account cannot receive the old account lookup');
}
{
  const h = harness({sessionProfiles: true}); await h.run('studio.session');
  h.state.onRequest = url => { if (url.pathname.includes('challengesug')) { h.state.profile = 'changed-profile'; h.state.onRequest = null; } };
  await assert.rejects(h.run('topics.search', {query: '真实'}), error => ['SESSION_CHANGED', 'ACCOUNT_CHANGED'].includes(error.code));
  h.state.profile = 'profile-123';
  const queriesBeforeRecovery = h.state.queries;
  assert.equal((await h.run('publication.prepare', {draft: draft({topics: [{id: '222', name: '真实候选'}]})})).canPublish, true);
  assert.equal(h.state.queries - queriesBeforeRecovery, 0, 'recovery preserves saved topic identities without another search');
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
  assert.equal(h.state.queries - queriesBeforeRecovery, 0, 'recovery preserves saved topic identities without another search');
}
{
  const h = harness({sessionProfiles: true}); await h.run('studio.session');
  await h.run('topics.search', {query: '真实'});
  const prepared = await h.run('publication.prepare', {draft: draft({topics: [{id: '222', name: '真实候选'}]})});
  assert.equal(h.state.queries, 1, 'preparation does not confuse topic search cache with permission to use the saved ID');
  h.state.account = '456';
  const rejected = await h.engine.dispatch('publication.publish', {preparationId: prepared.preparationId, requestId: 'cached-account-mismatch', expectedAccountId: '123', confirmed: true}, {origin, profileId: h.state.profile, expectedAccountId: '123'});
  assert.equal(rejected.status, 'failed'); assert.match(rejected.message, /账号已变化/);
  assert.equal(h.state.posts.length, 0, 'the single pre-submit identity check still prevents sending to a different account');
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
// ID 恢复入口不接受关键词、URL 或不可靠数值；错误输入在任何平台请求之前失败。
{
  const h = harness({sessionProfiles: true});
  for (const params of [{}, {id: 333}, {id: 'not-an-id'}, {id: '333', query: '合成音乐'}, {id: '333', url: 'https://example.test/'}]) {
    await assert.rejects(h.run('music.resolve', params), /音乐身份/);
  }
  assert.equal(h.state.paths.length, 0);
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
  h.state.activities = [{activity_id: '701', activity_name: activity.name, activity_status: 1, challenge: [activity.topic.name], challenge_ids: [activity.topic.id], hot_score: 520}];
  const refreshed = await h.run('activities.list');
  assert.equal(refreshed.items[0].heat, 520, 'an explicit activity reread returns changed platform data even within the query cache TTL');
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/activity/get/').length, 2, 'activity refresh bypasses the short query cache');
  assert.equal(h.state.paths.includes('/web/api/media/user/info/'), false, 'activity browsing and refresh do not request extra account verification');
  const prepared = await h.run('publication.prepare', {draft: value});
  assert.equal(prepared.canPublish, true);
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/activity/get/').length, 3, 'preparation reads current activity eligibility once');
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/activity/detail/').length, 2, 'detail browsing cannot replace the exact preparation check');
  assert.equal(h.state.queries, 0, 'an activity hashtag uses its verified detail rather than a separate generic topic search');
  const record = Object.values(h.values).flatMap(value => Object.values(value?.preparations || {})).find(value => value.preparationId === prepared.preparationId);
  assert.deepEqual(record.draft.activities, [activity]); assert.equal(record.payload.item.common.activity, '["801"]');
  assert.equal(record.payload.item.common.challenges, '["801"]'); assert.equal(h.state.posts.length, 0);
  h.state.hostAccount = h.state.account = '456'; h.state.profile = 'profile-other';
  await assert.rejects(h.engine.dispatch('publication.prepare', {draft: value}, {origin, profileId: h.state.profile, expectedAccountId: '123'}), error => error.code === 'ACCOUNT_CHANGED');
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
  const prepared = await h.run('publication.prepare', {draft: draft({activities: [activity]})});
  assert.deepEqual(preparedRecord(h, prepared).draft.activities, [activity], 'reuse the activity identity confirmed before uploading');
  assert.equal(h.state.uploads, 1); assert.equal(h.state.posts.length, 0);
  await assert.rejects(h.run('publication.prepare', {draft: draft({activities: [activity]})}), /游戏推广|可参加状态|已变化或不可用/, 'a new preparation reads current platform choices');
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
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/activity/detail/').length - detailBeforeRecovery, 1, 'retry queries exact current details instead of adopting the late response');
}
console.log('native activities engine: exact detail identities, restored drafts, current-account eligibility and one check per preparation passed');

// preparedRecord 读取离线准备快照，以验证提交字段来自平台响应而不是草稿附加值。
function preparedRecord(h, prepared) {
  return h.values['luma-studio-publications-v1'].preparations[prepared.preparationId];
}

// collectionFixture 模拟一项可发布的普通合集；作品数量用于确认重新计算下一集序号。
function collectionFixture(id = '501', name = '合成合集', count = 2) {
  return {mix_id: id, mix_name: name, type: 0, status: {status: 0}, statis: {updated_to_episode: count}};
}

// 重建引擎保留公共身份；地点附加字段、合集集数和账号相关发布状态仍从当前账号取得。
{
  const h = harness();
  await h.run('music.search'); await h.run('music.select', {id: '333', keepIds: ['333']});
  await h.run('topics.search', {query: '真实'});
  const value = draft({topics: [{id: '222', name: '真实候选'}], mentions: [{id: '601', name: '合成好友'}],
    music: {id: '333', name: '合成音乐', duration: 9999},
    location: {id: '401', name: '合成公园', cityCode: '440300', cityName: '深圳市', extra: '{"untrusted":true}'},
    collection: {id: '501', name: '合成合集', order: 9999}});
  const snapshot = structuredClone(value), restarted = harness(h), locationRequests = [];
  restarted.state.onRequest = url => { if (url.pathname.includes('/search/poi/')) locationRequests.push(Object.fromEntries(url.searchParams)); };
  const prepared = await restarted.run('publication.prepare', {draft: value}), record = preparedRecord(restarted, prepared);
  assert.equal(prepared.canPublish, true); assert.deepEqual(value, snapshot, 'revalidation leaves the saved draft untouched');
  assert.equal(record.payload.item.common.music_end_time, 100000, 'music duration comes from the real saved selection, never the draft');
  assert.deepEqual(record.payload.item.anchor, {poi_id: '401', poi_name: '合成公园', anchor_content: '{"verified":true,"is_commerce_intention":false}'});
  assert.deepEqual(record.payload.item.mix, {mix_id: '501', mix_order: 2});
  assert.equal(locationRequests.length, 1);
  for (const params of locationRequests) {
    assert.equal(params.selected_city_code, '440300'); assert.equal(params.selected_city_name, '深圳市'); assert.equal(params.keywords, '合成公园');
  }
  assert.equal(restarted.state.paths.filter(path => path.endsWith('/music/info/')).length, 1, 'identity is checked once within a preparation');
  assert.equal(restarted.state.paths.filter(path => path.includes('/music/search/')).length, 0, 'restoration never searches a name');
  assert.equal(restarted.state.queries, 0, 'saved topic IDs survive engine recreation without a name search');
  assert.equal(restarted.state.paths.filter(path => path === '/web/api/v2/discover/search/').length, 0, 'saved user IDs do not have to reappear in a new search');
  assert.equal(restarted.state.posts.length, 0, 'restoring a selection does not publish');
}

// 已展示歌曲的真实时长不随缓存时间或时钟回拨失效；准备只核验一次详情。
for (const delta of [30 * 60 * 1000, -1]) {
  const h = harness(); await h.run('music.search');
  h.state.clock += delta;
  h.state.musicPage = () => ({status_code: 0, songs: [{music_id: '333', music_name: '合成音乐', duration: 23}], has_more: false});
  const prepared = await h.run('publication.prepare', {draft: draft({music: {id: '333', name: '合成音乐'}})});
  assert.equal(preparedRecord(h, prepared).payload.item.common.music_end_time, 100000);
  assert.equal(h.state.paths.filter(path => path.endsWith('/music/info/')).length, 1);
  assert.equal(h.state.paths.filter(path => path.includes('/music/search/')).length, 0);
}

// 音乐名字只展示；详情同 ID 改名仍是原歌曲，不发送名称搜索或改写保存的草稿。
{
  const h = harness(), name = '长'.repeat(110), value = draft({music: {id: '333', name}}), snapshot = structuredClone(value);
  await h.run('music.search');
  h.state.musicInfoPage = () => ({status_code: 0, music_id: '333', music_name: '平台已改名', music_author: '作者'});
  assert.equal((await h.run('publication.prepare', {draft: value})).canPublish, true);
  assert.deepEqual(value, snapshot);
  assert.equal(h.state.paths.some(path => path.includes('/music/search/')), false);
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
  h.state.musicPage = url => {
    const cursor = url.searchParams.get('cursor'); cursors.push(cursor);
    return cursor === '0' ? {status_code: 0, songs: [{music_id: '334', music_name: '合成音乐', duration: 5}], has_more: true, cursor: '20'}
      : {status_code: 0, songs: [{music_id: '333', music_name: '合成音乐', duration: 30}], has_more: false};
  };
  const first = await h.run('music.search', {cursor: '0'});
  await h.run('music.search', {cursor: first.nextCursor});
  await h.run('music.select', {id: '333', keepIds: ['333']});
  const prepared = await h.run('publication.prepare', {draft: draft({music: {id: '333', name: '合成音乐'}})});
  assert.deepEqual(cursors, ['0', '20'], 'preparation does not rescan the selected song’s list');
  assert.equal(preparedRecord(h, prepared).payload.item.common.music_end_time, 30000);
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

// 同名不同 ID 与平台明确拒绝保留草稿，并在上传之前停止。
for (const info of [{status_code: 0, music_id: '334', music_name: '合成音乐'}, {status_code: 5}]) {
  const h = harness(), value = draft({music: {id: '333', name: '合成音乐'}}), snapshot = structuredClone(value);
  h.state.musicInfoPage = () => info;
  await assert.rejects(h.run('publication.prepare', {draft: value}), error => error.code === 'CHOICE_LOOKUP_FAILED');
  assert.equal(h.state.uploads, 0); assert.deepEqual(value, snapshot);
}
{
  const h = harness();
  h.state.onRequest = url => { if (url.pathname.endsWith('/music/info/')) throw Error('合成断网'); };
  await assert.rejects(h.run('publication.prepare', {draft: draft({music: {id: '333', name: '合成音乐'}})}), error => error.code === 'CHOICE_LOOKUP_FAILED');
  assert.equal(h.state.uploads, 0); assert.equal(h.state.posts.length, 0);
}
{
  const h = harness();
  await assert.rejects(h.run('publication.prepare', {draft: draft({location: {id: '401', name: '合成公园'}})}), error => error.code === 'CHOICE_LOCATION_CITY_REQUIRED');
  assert.equal(h.state.uploads, 0);
}

// 恢复期间账号改变或取消不能采用迟到候选；同一地点改名采用当前名称，身份不能被替换。
for (const reason of ['account', 'cancel']) {
  const h = harness({sessionProfiles: true}), controller = new AbortController();
  h.state.onRequest = url => {
    if (!url.pathname.endsWith('/music/info/')) return;
    if (reason === 'account') h.state.account = h.state.hostAccount = '456';
    else controller.abort();
  };
  await assert.rejects(h.engine.dispatch('publication.prepare', {draft: draft({music: {id: '333', name: '合成音乐'}})},
    {origin, profileId: h.state.profile, expectedAccountId: '123', signal: controller.signal}), error => reason === 'account' ? error.code === 'ACCOUNT_CHANGED' : error.name === 'AbortError');
  assert.equal(h.state.uploads, 0); assert.equal(h.state.posts.length, 0);
}
{
  const h = harness();
  h.state.onUpload = () => { h.state.locationPage = () => ({status_code: 0, poi_list: [{poi_id: '401', poi_name: '公园已改名'}], has_more: false}); };
  const value = draft({location: {id: '401', name: '合成公园', cityCode: '440300', cityName: '深圳市'}}), original = structuredClone(value);
  const prepared = await h.run('publication.prepare', {draft: value});
  assert.deepEqual(value, original);
  assert.equal(preparedRecord(h, prepared).payload.item.anchor.poi_name, '合成公园', 'reuse the name confirmed before upload');
  assert.equal(preparedRecord(h, prepared).payload.item.anchor.poi_id, '401');
  assert.equal(h.state.uploads, 1); assert.equal(h.state.posts.length, 0);
  const next = await h.run('publication.prepare', {draft: value});
  assert.equal(preparedRecord(h, next).payload.item.anchor.poi_name, '公园已改名', 'a new preparation reads the current name');
}
console.log('native draft restoration: restart, expired music, exact identity, city metadata, bounded pagination, failed lookup, cancellation and current-account revalidation passed');

// independentCoverHarness 用真实 importImages + engine，只有本机素材字节和平台上传回执是合成的。
function independentCoverHarness() {
  const source = new Map(['asset-a', 'asset-b', 'external-cover'].map(id => [id, {id, name: id + '.jpg', kind: 'image', revision: 'version-1'}]));
  const calls = {resolve: [], read: [], crop: [], upload: []};
  let h;
  const upload = {
    importImages: importNativeImages,
    async resolveAssets(job, ownOrigin, {signal} = {}) {
      assert.equal(ownOrigin, origin);
      signal?.throwIfAborted();
      calls.resolve.push(job.assets.map(asset => asset.id));
      return {assets: job.assets.map(asset => {
        const current = source.get(asset.id);
        if (!current) throw Error('合成封面不存在。');
        return {...current};
      })};
    },
    async prepareFile(_job, ownOrigin, asset, {signal} = {}) {
      assert.equal(ownOrigin, origin); signal?.throwIfAborted(); calls.read.push(asset.id);
      calls.afterRead?.(asset.id);
      return {assetID: asset.id, revision: asset.revision,
        file: Object.assign(new Blob(['synthetic-local-image'], {type: 'image/jpeg'}), {fixtureID: asset.id})};
    },
    async cropCoverFile(ownOrigin, assetID, crop, {signal} = {}) {
      assert.equal(ownOrigin, origin); signal?.throwIfAborted(); calls.crop.push({assetID, crop: structuredClone(crop)});
      calls.afterCrop?.(assetID);
      return Object.assign(new Blob(['synthetic-cropped-image'], {type: 'image/jpeg'}), {fixtureID: assetID + '-cropped'});
    },
    async uploadImage(file, auth, options) {
      assert.equal(auth.SecretAccessKey, 'temporary-secret');
      assert.equal(typeof options.fetch, 'function', 'cover uses the same account-scoped browser sender as body uploads');
      options.signal?.throwIfAborted(); calls.upload.push(file.fixtureID);
      await calls.afterUpload?.(file.fixtureID);
      return {uploadFile: {uri: `tos/independent-${file.fixtureID}.jpg`, uriStatus: 2000, imageWidth: 1200, imageHeight: 1600}};
    },
  };
  h = harness({upload, sessionProfiles: true});
  return {...h, source, calls};
}
function independentCoverDraft(crop) {
  return draft({assets: [{id: 'asset-a', name: 'a.jpg', kind: 'image'}, {id: 'asset-b', name: 'b.jpg', kind: 'image'}],
    cover: {type: 'asset', assetId: 'external-cover', ...(crop ? {crop} : {})}});
}
// 记录回调时已落盘的资源，避免把进度自身的断言异常被生产可选回调吞掉。
function mediaProgress(h) {
  const events = [];
  const progress = value => {
    const records = Object.entries(h.values).find(([key]) => key.startsWith('studio-uploads:'))?.[1]?.records || [];
    const saved = records.find(record => record.assetID === value.assetId && record.kind === value.role);
    events.push({...structuredClone(value), checkpointed: !!saved, readyCheckpointed: saved?.ready === true && saved?.transcode?.encode === 1});
  };
  return {events, progress};
}
for (const crop of [undefined, {x: 0.1, y: 0, width: 0.8, height: 1}]) {
  const h = independentCoverHarness(), value = independentCoverDraft(crop), original = structuredClone(value);
  const firstProgress = mediaProgress(h);
  const prepared = await h.run('publication.prepare', {draft: value}, firstProgress), record = preparedRecord(h, prepared);
  assert.equal(prepared.canPublish, true);
  assert.deepEqual(record.payload.item.common.images.map(image => image.uri), ['tos/independent-asset-a.jpg', 'tos/independent-asset-b.jpg']);
  assert.equal(record.payload.item.cover.upload_poster, `tos/independent-external-cover${crop ? '-cropped' : ''}.jpg`);
  assert.equal(record.draft.assets.length, 2); assert.deepEqual(value, original); assert.equal(h.state.posts.length, 0);
  assert.equal(h.calls.crop.length, crop ? 1 : 0);
  assert.equal(h.calls.upload.length, 3, 'independent cover uploads once in addition to unchanged body images');
  for (const id of ['asset-a', 'asset-b']) {
    const events = firstProgress.events.filter(item => item.assetId === id);
    assert.deepEqual(events.map(item => item.phase), ['reading', 'uploading', 'uploaded']);
    assert.ok(events.every(item => item.assetID === id && item.assetName === id + '.jpg' && item.role === 'image' && item.countRole === 'image'));
    assert.equal(events.at(-1).checkpointed, true, 'completed progress follows durable upload checkpoint');
    assert.equal(events.at(-1).message, '已上传');
  }
  const coverEvents = firstProgress.events.filter(item => item.role === 'cover');
  assert.deepEqual(coverEvents.map(item => item.phase), [crop ? 'cropping' : 'reading', 'uploading', 'uploaded']);
  assert.ok(coverEvents.every(item => item.assetId === 'external-cover' && item.assetID === 'external-cover' && item.assetName === 'external-cover.jpg'));
  assert.ok(coverEvents.every(item => item.completed === 2 && item.total === 2 && item.countRole === 'image'), 'cover progress retains explicit body-image counts, not fictitious overall completion');
  assert.equal(coverEvents.at(-1).checkpointed, true);
  assert.ok(firstProgress.events.filter(item => ['resolving', 'staging'].includes(item.phase)).every(item => !item.assetId && !item.role));
  const retryProgress = mediaProgress(h);
  const retried = await h.run('publication.prepare', {draft: value}, retryProgress);
  assert.equal(retried.canPublish, true); assert.equal(h.calls.upload.length, 3, 'same account/source/version/crop reuses the cover checkpoint');
  assert.deepEqual(retryProgress.events.filter(item => item.assetId).map(item => [item.assetId, item.role, item.phase]),
    [['asset-a', 'image', 'reused'], ['asset-b', 'image', 'reused'], ['external-cover', 'cover', 'reused']]);
  const cache = Object.entries(h.values).find(([key]) => key.startsWith('studio-uploads:'))[1];
  assert.equal(cache.records.filter(item => item.kind === 'cover').length, 1);
  assert.equal(JSON.stringify(cache).includes('temporary-secret'), false);
  h.source.get('external-cover').revision = 'version-2';
  await h.run('publication.prepare', {draft: value});
  assert.equal(h.calls.upload.length, 4, 'changing only the cover source revision reuploads cover without reordering or repeating body images');
}
{
  const h = independentCoverHarness(), value = independentCoverDraft();
  value.cover.assetId = 'asset-b';
  const progress = mediaProgress(h);
  const result = await h.run('publication.prepare', {draft: value}, progress), record = preparedRecord(h, result);
  assert.equal(record.payload.item.cover.upload_poster, 'tos/independent-asset-b.jpg');
  assert.equal(h.calls.upload.length, 2, 'an uncropped body-image cover keeps the existing upload-reuse path');
  assert.deepEqual(progress.events.filter(item => item.assetId === 'asset-b').map(item => [item.role, item.phase]),
    [['image', 'reading'], ['image', 'uploading'], ['image', 'uploaded'], ['cover', 'reused']], 'same image and cover have separate roles without another upload');
}
// 一条并发通道失败不污染另一条成功记录；完成事件必须等存储成功，不能只看上传响应。
{
  const h = independentCoverHarness(), progress = mediaProgress(h), releases = new Map();
  let bothStarted;
  const started = new Promise(resolve => { bothStarted = resolve; });
  h.calls.afterUpload = id => new Promise((resolve, reject) => {
    releases.set(id, {resolve, reject}); if (releases.size === 2) bothStarted();
  });
  const value = independentCoverDraft(); value.cover = null;
  const pending = assert.rejects(h.run('publication.prepare', {draft: value}, progress), /合成单图失败/);
  await started;
  releases.get('asset-a').reject(Error('合成单图失败'));
  releases.get('asset-b').resolve();
  await pending;
  assert.deepEqual(progress.events.filter(item => item.assetId === 'asset-a').map(item => item.phase), ['reading', 'uploading', 'failed']);
  assert.deepEqual(progress.events.filter(item => item.assetId === 'asset-b').map(item => item.phase), ['reading', 'uploading', 'uploaded']);
  assert.equal(progress.events.find(item => item.phase === 'failed').assetName, 'asset-a.jpg');
  assert.equal(progress.events.find(item => item.phase === 'uploaded').checkpointed, true);
}
{
  const h = independentCoverHarness(), progress = mediaProgress(h);
  h.state.onStorageSet = update => {
    if (Object.entries(update).some(([key, value]) => key.startsWith('studio-uploads:') && value.records?.length)) throw Error('合成检查点保存失败');
  };
  await assert.rejects(h.run('publication.prepare', {draft: draft()}, progress), /合成检查点保存失败/);
  assert.deepEqual(progress.events.filter(item => item.assetId).map(item => item.phase), ['reading', 'uploading', 'failed']);
  assert.equal(progress.events.some(item => item.phase === 'uploaded'), false);
}
for (const phase of ['read', 'crop', 'upload', 'final']) {
  const h = independentCoverHarness(), crop = phase === 'crop' ? {x: 0, y: 0, width: 1, height: 1} : undefined;
  const progress = mediaProgress(h);
  const change = id => { if (id.startsWith('external-cover')) h.source.get('external-cover').revision = 'changed-during-prepare'; };
  if (phase === 'read') h.calls.afterRead = change;
  if (phase === 'crop') h.calls.afterCrop = change;
  if (phase === 'upload') h.calls.afterUpload = change;
  if (phase === 'final') {
    let collections = 0;
    h.state.onRequest = url => { if (url.pathname === '/web/api/mix/list/' && ++collections === 2) change('external-cover'); };
  }
  const value = {...independentCoverDraft(crop), ...(phase === 'final' ? {collection: {id: '501', name: '合成合集'}} : {})};
  await assert.rejects(h.run('publication.prepare', {draft: value}, progress), /封面.*变化/);
  assert.equal(h.state.posts.length, 0);
  assert.equal(Object.values(h.values['luma-studio-publications-v1']?.preparations || {}).length, 0, 'cover changes cannot leave a publishable preparation');
  if (['read', 'crop'].includes(phase)) assert.equal(h.calls.upload.some(id => id.startsWith('external-cover')), false, 'changed source is rejected before uploading its bytes');
  if (phase !== 'final') {
    const failures = progress.events.filter(item => item.phase === 'failed');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].role, 'cover'); assert.equal(failures[0].assetName, 'external-cover.jpg');
    assert.equal(progress.events.filter(item => item.role === 'image' && item.phase === 'uploaded').length, 2, 'cover failure preserves completed body-image progress');
  }
}
for (const wrongKind of ['video', 'audio', undefined]) {
  const h = independentCoverHarness(); h.source.get('external-cover').kind = wrongKind;
  await assert.rejects(h.run('publication.prepare', {draft: independentCoverDraft()}), /封面图片不可用/);
  assert.equal(h.calls.upload.length, 0, 'unavailable external cover fails before body upload');
}
{
  const h = independentCoverHarness(), controller = new AbortController();
  const progress = mediaProgress(h);
  h.calls.afterRead = id => { if (id === 'external-cover') controller.abort(); };
  await assert.rejects(h.engine.dispatch('publication.prepare', {draft: independentCoverDraft()}, {origin, signal: controller.signal, progress: progress.progress}));
  assert.equal(h.calls.upload.includes('external-cover'), false); assert.equal(h.state.posts.length, 0);
  assert.equal(progress.events.some(item => item.phase === 'failed'), false, 'user cancellation is not a fabricated file failure');
}
{
  const h = independentCoverHarness();
  h.calls.afterUpload = id => { if (id === 'external-cover') h.state.account = h.state.hostAccount = '456'; };
  await assert.rejects(h.run('publication.prepare', {draft: independentCoverDraft()}), /账号.*变化/);
  assert.equal(h.state.posts.length, 0); assert.equal(Object.values(h.values['luma-studio-publications-v1']?.preparations || {}).length, 0);
}
// 既有 cover.upload 入口也使用同一图库解析合同，不依赖错误的原始 kind 字段或额外 metadata 路由。
{
  const h = independentCoverHarness();
  const selected = await h.run('cover.upload', {assetId: 'external-cover'});
  assert.ok(selected.id); assert.deepEqual(h.calls.read, ['external-cover']);
  const prepared = await h.run('publication.prepare', {draft: draft({cover: {type: 'upload', id: selected.id}})});
  assert.equal(preparedRecord(h, prepared).payload.item.cover.upload_poster, 'tos/independent-external-cover.jpg');
  h.source.get('external-cover').kind = 'video';
  await assert.rejects(h.run('publication.prepare', {draft: draft({cover: {type: 'upload', id: selected.id}})}), /封面源文件已变化/);
  assert.equal(h.state.posts.length, 0);
}
// 原始图库响应使用 mediaType，实况照片重新查询静态组件时也必须传递真实图片类型。
{
  const originalFetch = globalThis.fetch, calls = [];
  globalThis.fetch = async input => {
    const url = new URL(input); assert.equal(url.origin, origin); calls.push(url.pathname);
    const id = decodeURIComponent(url.pathname.split('/').at(-1));
    const data = id === 'live-photo' ? {name: 'motion.mov', mediaType: 'video', livePhoto: {imageAssetId: 'still-image'}, sizeBytes: 20, modifiedAt: '2030-01-01'}
      : {name: 'still.jpg', mediaType: 'image', sizeBytes: 10, modifiedAt: '2030-01-01'};
    return new Response(JSON.stringify({code: 0, data}), {status: 200});
  };
  try {
    const resolved = await resolveNativeAssets({kind: 'image', assets: [{id: 'live-photo', name: 'live.mov'}]}, origin);
    assert.equal(resolved.assets[0].id, 'still-image'); assert.equal(resolved.assets[0].kind, 'image'); assert.equal(calls.length, 2);
  } finally { globalThis.fetch = originalFetch; }
}
console.log('native independent covers: raw/cropped upload, body-order preservation, account/cancel isolation, version checks and real mediaType mapping passed');

const musicRecordKey = 'luma-studio-selected-music-v1';
// 页面中仍可见的歌曲在翻页超过 200 首、停留超过 30 分钟或时钟回拨后仍可选择，无额外网络。
for (const delta of [31 * 60 * 1000, -1]) {
  const h = harness({sessionProfiles: true});
  h.state.musicPage = url => ({status_code: 0, songs: Array.from({length: 20}, (_, index) => {
    const id = String(Number(url.searchParams.get('cursor')) + index + 1);
    return {music_id: id, music_name: `曲目${id}`, duration: 23, play_url: `https://media.example.test/${id}.mp3`};
  }), has_more: true, cursor: String(Number(url.searchParams.get('cursor')) + 20)});
  for (let page = 0; page < 11; page++) await h.run('music.search', {cursor: String(page * 20)});
  h.state.clock += delta;
  const before = h.state.paths.length;
  assert.match((await h.run('music.select', {id: '1', keepIds: ['1']})).previewURL, /\/1.mp3$/);
  assert.equal(h.state.paths.length, before);
  h.engine.invalidate();
  await assert.rejects(h.run('music.select', {id: '1', keepIds: ['1']}), /没有这首音乐的查询记录/, 'explicit account lifecycle invalidation still clears candidates');
}
// 点击使用只持久化当前档案已查询的候选；一分钟身份缓存到期不会让本机保存等待平台网络。
{
  const h = harness({sessionProfiles: true});
  await h.run('music.search'); h.state.clock += 61000;
  const before = {paths: h.state.paths.length, status: h.state.statusReads, reads: h.state.storageReads, writes: h.state.storageWrites};
  const saved = await h.engine.dispatch('music.select', {id: '333', keepIds: ['333']}, {origin, profileId: 'profile-123', expectedAccountId: '123'});
  assert.equal(saved.id, '333');
  assert.equal(h.state.paths.length, before.paths, 'selecting a verified candidate never refreshes the expired remote identity cache');
  assert.equal(h.state.statusReads - before.status, 2, 'local identity is checked before selection and immediately before the queued write');
  assert.equal(h.state.storageReads - before.reads, 1); assert.equal(h.state.storageWrites - before.writes, 1);
  assert.equal(h.values[musicRecordKey].items[0].profileId, 'profile-123');
  assert.equal(h.values[musicRecordKey].items[0].accountId, '123');
  const prepareBefore = h.state.paths.length;
  await h.run('publication.prepare', {draft: draft({music: {id: '333', name: '合成音乐'}})});
  assert.ok(h.state.paths.slice(prepareBefore).includes('/web/api/media/user/info/'), 'publication preparation still verifies the live remote identity');
}

// 账号与档案变化时拒绝跨账号选曲；空宿主状态不能偷偷退回联网查询。
for (const reason of ['profile', 'account', 'missing-status', 'different-scope']) {
  const h = harness({sessionProfiles: true}); await h.run('music.search'); h.state.clock += 61000;
  let expectedCode, expectedMessage;
  if (reason === 'profile') { h.state.profile = 'profile-other'; expectedCode = 'ACCOUNT_CHANGED'; }
  if (reason === 'account') { h.state.hostAccount = '456'; expectedCode = 'ACCOUNT_CHANGED'; }
  if (reason === 'missing-status') { h.state.statusOverride = null; expectedCode = 'SESSION_CHANGED'; }
  if (reason === 'different-scope') { h.state.profile = 'profile-other'; expectedMessage = /没有这首音乐的查询记录/; }
  const before = {paths: h.state.paths.length, writes: h.state.storageWrites};
  await assert.rejects(h.engine.dispatch('music.select', {id: '333', keepIds: ['333']},
    {origin, profileId: reason === 'different-scope' ? 'profile-other' : 'profile-123', expectedAccountId: '123'}),
    error => expectedCode ? error.code === expectedCode : expectedMessage.test(error.message));
  assert.equal(h.state.paths.length, before.paths); assert.equal(h.state.storageWrites, before.writes);
  assert.equal(h.values[musicRecordKey], undefined);
}

// 写队列内读取之后再次核对；等待期间换号、取消及持久化失败均不得返回选曲成功。
for (const reason of ['profile', 'account', 'cancel', 'write']) {
  const h = harness({sessionProfiles: true}); await h.run('music.search'); h.state.clock += 61000;
  const controller = new AbortController(), before = h.state.paths.length;
  h.state.onStorageGet = () => {
    if (reason === 'profile') h.state.profile = 'profile-other';
    if (reason === 'account') h.state.hostAccount = '456';
    if (reason === 'cancel') controller.abort();
  };
  if (reason === 'write') h.state.onStorageSet = () => { throw Error('合成本机写入失败'); };
  await assert.rejects(h.engine.dispatch('music.select', {id: '333', keepIds: ['333']},
    {origin, profileId: 'profile-123', expectedAccountId: '123', signal: controller.signal}),
    error => reason === 'cancel' ? error.name === 'AbortError' : reason === 'write' ? /本机写入失败/.test(error.message) : ['ACCOUNT_CHANGED', 'SESSION_CHANGED'].includes(error.code));
  assert.equal(h.state.paths.length, before); assert.equal(h.values[musicRecordKey], undefined);
  assert.equal(h.state.storageWrites, reason === 'write' ? 1 : 0);
}
{
  const h = harness({sessionProfiles: true}); await h.run('music.search'); h.state.clock += 61000;
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  h.state.onStorageGet = () => { entered(); return new Promise(resolve => { release = resolve; }); };
  const first = h.run('music.select', {id: '333', keepIds: ['333']});
  await waiting;
  const controller = new AbortController();
  const second = h.engine.dispatch('music.select', {id: '333', keepIds: ['333']}, {origin, profileId: 'profile-123', expectedAccountId: '123', signal: controller.signal});
  const cancelled = assert.rejects(second, error => error.name === 'AbortError');
  controller.abort(); h.state.onStorageGet = null; release();
  await first; await cancelled;
  assert.equal(h.state.storageReads, 1); assert.equal(h.state.storageWrites, 1, 'a cancelled queued selection cannot start another write');
}
console.log('native music selection: local-only persistence after identity TTL, scoped candidate checks, queued cancellation and write failures passed');

// 准备旧稿缺少音乐时长时明确反馈资料缺失，不遍历推荐或收藏碰运气找相同 ID。
{
  const h = harness({sessionProfiles: true});
  h.state.musicCategories = [{category_id: '1', type: 'recommend', category_name: '推荐'}, {category_id: '2', type: 'fav', category_name: '收藏'}];
  h.state.musicPage = () => { assert.fail('metadata recovery must not scan recommendations or favorites'); };
  await assert.rejects(h.run('publication.prepare', {draft: draft({music: {id: '333', name: '原声'}})}), error => error.code === 'MUSIC_METADATA_MISSING');
  assert.equal(h.state.paths.filter(path => path.endsWith('/music/info/')).length, 1);
  assert.equal(h.state.paths.filter(path => path.endsWith('/music/category')).length, 0);
  assert.equal(h.state.musicRequests.length, 0);
  assert.equal(h.state.uploads, 0);
}

// 从本机记录恢复试听期间换号或取消，旧音源仍不得返回给当前页面。
for (const reason of ['profile', 'cancel']) {
  const h = harness({sessionProfiles: true}); await h.run('music.search'); await h.run('music.select', {id: '333', keepIds: ['333']});
  const controller = new AbortController(), before = h.state.paths.length;
  h.state.onStorageGet = key => {
    if (key !== musicRecordKey) return;
    if (reason === 'profile') h.state.profile = 'other-profile';
    else controller.abort();
  };
  await assert.rejects(h.run('music.resolve', {id: '333'}, {signal: controller.signal}),
    error => reason === 'profile' ? error.code === 'ACCOUNT_CHANGED' : error.name === 'AbortError');
  assert.equal(h.state.paths.length, before);
}

// 真实选曲记录单独保存；重建引擎后直接试听同账号音源，详情失败不阻断已有地址。
{
  const h = harness({sessionProfiles: true});
  await h.run('music.search');
  assert.equal(h.values[musicRecordKey], undefined);
  const saved = await h.run('music.select', {id: '333', keepIds: ['333']});
  assert.equal(saved.duration, 100); assert.match(saved.previewURL, /333.mp3$/);
  assert.equal(h.values[musicRecordKey].items.length, 1);
  const restarted = harness({values: h.values, sessionProfiles: true});
  restarted.state.musicInfoPage = () => ({status_code: 5});
  restarted.state.musicPage = () => { assert.fail('saved source does not require searching or list scans'); };
  const result = await restarted.run('music.resolve', {id: '333'});
  assert.equal(result.name, '合成音乐'); assert.equal(result.duration, 100); assert.equal(result.previewURL, saved.previewURL);
  assert.equal(restarted.state.paths.length, 0, 'restored preview does not wait for any remote request');
  delete h.values[musicRecordKey].items[0].name;
  assert.equal((await restarted.run('music.resolve', {id: '333'})).name, undefined, 'legacy records remain usable without fabricated metadata');
  assert.equal(JSON.stringify(h.values).includes('synthetic-memory-only-signature'), false);
  restarted.state.profile = 'other-profile';
  restarted.state.musicInfoPage = undefined;
  restarted.state.musicPage = () => ({status_code: 0, songs: [], has_more: false});
  assert.equal((await restarted.run('music.resolve', {id: '333'})).previewURL, null, 'same account ID in a different profile cannot borrow audio');
  await assert.rejects(restarted.run('music.select', {id: '333', keepIds: ['333']}), /没有这首音乐的查询记录/);
  assert.equal(h.values[musicRecordKey].items.length, 1);
}
// 来源过期只在下一次明确请求时刷新，并先抛弃旧地址；找不到不能回送原地址或按名称搜索。
{
  const h = harness(); await h.run('music.search'); await h.run('music.select', {id: '333', keepIds: ['333']});
  h.state.musicPage = () => ({status_code: 0, songs: [{music_id: '333', music_name: '原声', duration: 23, play_url: 'https://media.example.test/fresh.mp3'}], has_more: false});
  assert.match((await h.run('music.resolve', {id: '333', refreshSource: true})).previewURL, /fresh.mp3$/);
  h.state.musicCategories = [{category_id: '1', type: 'recommend', category_name: '推荐'}, {category_id: '2', type: 'fav', category_name: '收藏'}];
  h.state.clock += 5 * 60 * 1000;
  h.state.musicPage = url => ({status_code: 0, songs: [], has_more: true, cursor: String(Number(url.searchParams.get('cursor')) + 20)});
  const before = h.state.musicRequests.length;
  const missing = await h.run('music.resolve', {id: '333', refreshSource: true});
  assert.equal(missing.id, '333'); assert.equal(missing.previewURL, null); assert.equal(missing.duration, 23);
  assert.equal(h.state.musicRequests.length - before, 4, 'at most two recommendation and two favorite pages');
  assert.equal(h.values[musicRecordKey].items[0].previewURL, null, 'the expired persistent address is not resurrected');
  assert.equal((await h.run('music.resolve', {id: '333'})).previewURL, null, 'ordinary restore after refresh failure cannot resurrect an old in-memory candidate');
  assert.equal(h.values[musicRecordKey].items[0].previewURL, null);
  assert.equal(h.state.paths.some(path => path.includes('/music/search/')), false);
}
// 只清理当前档案不再被草稿引用的记录；其它账号记录保留，满额不能悄悄淘汰仍被引用的配乐。
{
  const h = harness(); await h.run('music.search'); await h.run('music.select', {id: '333', keepIds: ['333']});
  h.values[musicRecordKey].items.push({profileId: 'other-profile', accountId: '123', id: '333', duration: 12, previewURL: 'https://media.example.test/other.mp3'});
  h.state.musicPage = () => ({status_code: 0, songs: [{music_id: '334', music_name: '新曲', duration: 8, play_url: 'https://media.example.test/334.mp3'}], has_more: false});
  await h.run('music.search'); await h.run('music.select', {id: '334', keepIds: ['334']});
  assert.deepEqual(h.values[musicRecordKey].items.map(item => [item.profileId, item.id]), [['other-profile', '333'], ['profile-123', '334']]);
  const full = harness(); await full.run('music.search');
  full.values[musicRecordKey] = {version: 1, items: Array.from({length: 128}, (_, index) => ({profileId: 'preserved-' + index, accountId: '123', id: String(index + 1000), duration: 10, previewURL: null}))};
  await assert.rejects(full.run('music.select', {id: '333', keepIds: ['333']}), /记录已满/);
  assert.equal(full.values[musicRecordKey].items.length, 128);
}
// 旧稿只有身份且无真实时长记录时保留选择，不使用草稿自带时长，也不开始上传。
{
  const h = harness(), value = draft({music: {id: '333', name: '原声', duration: 9999}}), snapshot = structuredClone(value);
  h.state.musicPage = () => { assert.fail('missing duration does not trigger a list scan'); };
  await assert.rejects(h.run('publication.prepare', {draft: value}), error => error.code === 'MUSIC_METADATA_MISSING');
  assert.equal(h.state.musicRequests.length, 0);
  assert.equal(h.state.uploads, 0); assert.deepEqual(value, snapshot);
}
// A 的选曲切到 B 后，同一音乐 ID 的真实时长可复用，音源、账号和上传检查点仍保持隔离。
{
  const h = harness({sessionProfiles: true});
  await h.run('music.search'); await h.run('music.select', {id: '333', keepIds: ['333']});
  const value = draft({music: {id: '333', name: '合成音乐', duration: 9999}}), snapshot = structuredClone(value);
  const first = await h.run('publication.prepare', {draft: value});
  const selectedBefore = structuredClone(h.values[musicRecordKey]), before = h.state.paths.length;
  h.state.account = h.state.hostAccount = '456'; h.state.profile = 'profile-456'; h.engine.invalidate();
  h.state.onUpload = input => {
    assert.equal(input.account, '456');
    assert.deepEqual(input.previous, [], 'B must not reuse A’s uploaded assets or preparation checkpoint');
  };
  h.state.musicPage = () => { assert.fail('B must not scan recommendation or favorite lists for the retained ID'); };
  const prepared = await h.run('publication.prepare', {draft: value}), record = preparedRecord(h, prepared);
  assert.equal(prepared.canPublish, true); assert.notEqual(prepared.preparationId, first.preparationId);
  assert.equal(record.accountId, '456'); assert.equal(record.account.id, '456');
  assert.equal(record.payload.item.common.music_id, '333');
  assert.equal(record.payload.item.common.music_end_time, 100000, 'reuse verified music metadata, not the draft’s arbitrary duration');
  assert.equal(h.state.uploads, 2, 'each account prepares its own upload');
  assert.equal(JSON.stringify(record).includes(selectedBefore.items[0].previewURL), false, 'A’s audio URL is not copied into B’s preparation');
  assert.deepEqual(value, snapshot); assert.equal(h.state.posts.length, 0);
  const requests = h.state.paths.slice(before);
  assert.equal(requests.filter(path => path === '/web/api/media/music/info/').length, 1);
  assert.equal(requests.filter(path => path === '/web/api/media/user/info/').length, 1);
  assert.equal(requests.some(path => ['/web/api/media/music/category', '/web/api/media/music/list', '/web/api/media/aweme/search/post/auth', '/openapi/aweme/v1/music/search/'].includes(path)), false);
  const foreign = h.values[musicRecordKey].items.filter(item => item.profileId === 'profile-123' && item.accountId === '123');
  assert.deepEqual(foreign, selectedBefore.items, 'reading public duration does not mutate A’s selected music records');
  assert.equal(h.values[musicRecordKey].items.some(item => item.accountId === '456' && item.previewURL === selectedBefore.items[0].previewURL), false);
  h.state.musicPage = () => ({status_code: 0, songs: [], has_more: false});
  assert.equal((await h.run('music.resolve', {id: '333'})).previewURL, null, 'B still cannot borrow A’s audio URL for preview');
}

// 即使 A 有真实时长，B 的详情拒绝或回错 ID 时也不能获得可发布资格。
for (const info of [{status_code: 0, music_id: '334', music_name: '合成音乐'}, {status_code: 5}]) {
  const h = harness({sessionProfiles: true});
  await h.run('music.search'); await h.run('music.select', {id: '333', keepIds: ['333']});
  h.state.account = h.state.hostAccount = '456'; h.state.profile = 'profile-456'; h.engine.invalidate();
  h.state.musicInfoPage = () => info;
  const before = h.state.paths.length, value = draft({music: {id: '333', name: '合成音乐'}}), snapshot = structuredClone(value);
  await assert.rejects(h.run('publication.prepare', {draft: value}), error => error.code === 'CHOICE_LOOKUP_FAILED');
  assert.equal(h.state.uploads, 0); assert.equal(h.state.posts.length, 0); assert.deepEqual(value, snapshot);
  assert.equal(h.state.paths.slice(before).filter(path => path === '/web/api/media/music/info/').length, 1);
  assert.equal(h.state.paths.slice(before).some(path => ['/web/api/media/music/category', '/web/api/media/music/list'].includes(path)), false);
}

// 公共时长只按完整音乐 ID 使用；同名其他歌曲的真实记录不能填补当前音乐缺失的时长。
{
  const h = harness({sessionProfiles: true});
  h.state.musicPage = () => ({status_code: 0, songs: [{music_id: '334', music_name: '合成音乐', duration: 30}], has_more: false});
  await h.run('music.search'); await h.run('music.select', {id: '334', keepIds: ['334']});
  h.state.account = h.state.hostAccount = '456'; h.state.profile = 'profile-456'; h.engine.invalidate();
  const before = h.state.paths.length;
  await assert.rejects(h.run('publication.prepare', {draft: draft({music: {id: '333', name: '合成音乐', duration: 9999}})}), error => error.code === 'MUSIC_METADATA_MISSING');
  assert.equal(h.state.uploads, 0); assert.equal(h.state.posts.length, 0);
  assert.equal(h.state.paths.slice(before).some(path => ['/web/api/media/music/category', '/web/api/media/music/list'].includes(path)), false);
}
console.log('native saved music: exact-ID metadata across accounts, isolated preview/upload state, no preparation list scans, source refresh and explicit missing metadata passed');

// 实际图文上传编排只在准备入口核验一次账号；候选数量与独立封面都不增加账号请求。
for (const withMusic of [false, true]) {
  const h = independentCoverHarness();
  if (withMusic) { await h.run('music.search'); await h.run('music.select', {id: '333', keepIds: ['333']}); }
  const start = h.state.paths.length;
  const value = {...independentCoverDraft(), ...(withMusic ? {music: {id: '333', name: '合成音乐'}} : {})};
  await h.run('publication.prepare', {draft: value});
  const requests = h.state.paths.slice(start);
  assert.equal(requests.filter(path => path === '/web/api/media/user/info/').length, 1);
  assert.equal(requests.filter(path => path === '/web/api/media/upload/auth/v5/').length, 1);
  assert.equal(requests.filter(path => path === '/aweme/v3/user_declaration/suggestion/').length, 1, 'declaration rules are read once per preparation');
  if (withMusic) assert.equal(requests.filter(path => path === '/web/api/media/music/info/').length, 1, 'music ID metadata is verified once per preparation');
}

// 视频处理的真实循环只增加转码请求，不按每一轮加两次账号核验。
for (const polls of [1, 3]) {
  let videoUploads = 0;
  const h = harness({sessionProfiles: true, upload: {
    importVideo: (input, deps) => importNativeVideo(input, {...deps, wait: async () => {}}),
    resolveAssets: async () => ({assets: [{id: 'video-a', name: 'video.mp4', kind: 'video', revision: 'v1'}]}),
    prepareFile: async () => ({assetID: 'video-a', revision: 'v1', file: new Blob(['synthetic video'])}),
    uploadVideo: async () => { videoUploads++; return {vid: 'vid-a', uploadFile: {vid: 'vid-a', name: 'video.mp4', size: 100, type: 'video/mp4'}}; },
  }});
  h.state.videoReadyAfter = polls;
  const value = draft({kind: 'video', assets: [{id: 'video-a', name: 'old-video-name.mp4', kind: 'video'}]});
  const progress = mediaProgress(h);
  await h.run('publication.prepare', {draft: value}, progress);
  assert.equal(h.state.videoPolls, polls);
  assert.equal(h.state.paths.filter(path => path === '/web/api/media/user/info/').length, 1);
  const assetEvents = progress.events.filter(item => item.assetId);
  assert.deepEqual(assetEvents.map(item => item.phase), ['reading', 'uploading', 'uploaded', 'processing', 'ready']);
  assert.ok(assetEvents.every(item => item.assetId === 'video-a' && item.assetID === 'video-a' && item.assetName === 'video.mp4' && item.role === 'video' && item.countRole === 'video'));
  assert.equal(assetEvents.find(item => item.phase === 'uploaded').checkpointed, true);
  assert.equal(assetEvents.find(item => item.phase === 'ready').readyCheckpointed, true, 'video readiness follows the persisted transcode result');
  const reused = mediaProgress(h);
  await h.run('publication.prepare', {draft: value}, reused);
  assert.deepEqual(reused.events.filter(item => item.assetId).map(item => item.phase), ['reused', 'ready']);
  assert.equal(videoUploads, 1); assert.equal(h.state.videoPolls, polls);
}

// 明确成功回执直接落盘；之后失联或界面生命周期变化不能丢失平台作品 ID。
for (const failure of ['offline', 'generation']) {
  const h = harness({sessionProfiles: true}), prepared = await h.run('publication.prepare', {draft: draft()});
  const before = h.state.paths.length;
  h.state.onPost = () => {
    if (failure === 'generation') h.engine.invalidate();
    else { h.state.browserReady = false; h.state.onRequest = () => { throw Object.assign(Error('合成断网'), {code: 'SESSION_EXPIRED'}); }; }
  };
  const request = {preparationId: prepared.preparationId, requestId: 'known-success-' + failure, expectedAccountId: '123', confirmed: true};
  const result = await h.run('publication.publish', request);
  assert.equal(result.status, 'processing'); assert.equal(result.publicationId, '987654');
  assert.deepEqual(h.state.paths.slice(before), ['/web/api/media/user/info/', '/web/api/media/aweme/create_v2/']);
  const duplicateBefore = h.state.paths.length;
  assert.equal((await h.run('publication.publish', request)).publicationId, '987654');
  assert.equal(h.state.paths.length, duplicateBefore, 'known duplicate receipts require no network');
  h.state.onRequest = null;
  const statusBefore = h.state.paths.length;
  assert.equal((await h.run('publication.status', {requestId: request.requestId})).publicationId, '987654');
  assert.deepEqual(h.state.paths.slice(statusBefore), ['/web/api/media/item/info/']);
}

// 未知结果不重发；没有作品 ID 的状态与重复请求离线时只返回原本机记录。
{
  const h = harness({sessionProfiles: true}), prepared = await h.run('publication.prepare', {draft: draft()});
  h.state.failPost = true;
  const request = {preparationId: prepared.preparationId, requestId: 'local-unknown', expectedAccountId: '123', confirmed: true};
  assert.equal((await h.run('publication.publish', request)).status, 'unknown');
  const before = h.state.paths.length;
  h.state.browserReady = false; h.state.onRequest = () => { throw Error('must not call remote while reading an unknown receipt'); };
  assert.equal((await h.run('publication.publish', request)).status, 'unknown');
  assert.equal((await h.run('publication.status', {requestId: request.requestId})).status, 'unknown');
  assert.equal(h.state.paths.length, before); assert.equal(h.state.posts.length, 1);
  h.state.hostAccount = '456';
  await assert.rejects(h.engine.dispatch('publication.publish', request, {origin, profileId: h.state.profile, expectedAccountId: '123'}), error => error.code === 'ACCOUNT_CHANGED');
  assert.equal(h.state.paths.length, before, 'local receipt access still enforces account ownership');
}

// 平台登录失败保留已查候选和持久资料；本地选曲仍可用，准备时才请求平台并反馈失败。
{
  const h = harness({sessionProfiles: true}); await h.run('music.search');
  await h.run('music.select', {id: '333', keepIds: ['333']});
  const snapshot = structuredClone(h.values), start = h.state.paths.length;
  h.state.clock += 61000; h.state.browserReady = false;
  h.state.onRequest = () => { throw Object.assign(Error('合成平台登录已失效'), {code: 'SESSION_EXPIRED'}); };
  await assert.rejects(h.run('topics.search', {query: '离线新请求'}), error => error.code === 'SESSION_EXPIRED');
  assert.deepEqual(h.state.paths.slice(start), ['/aweme/v1/search/challengesug/']);
  const localStart = h.state.paths.length;
  assert.equal((await h.run('music.select', {id: '333', keepIds: ['333']})).id, '333');
  assert.equal(h.state.paths.length, localStart); assert.deepEqual(h.values, snapshot);
  const staticCapabilities = h.engine.capabilities(); staticCapabilities.operations.length = 0;
  assert.ok(h.engine.capabilities().operations.includes('publication.prepare')); assert.equal(h.state.paths.length, localStart);
  await assert.rejects(h.run('publication.prepare', {draft: draft()}), error => error.code === 'SESSION_EXPIRED');
  assert.equal(h.state.uploads, 0); assert.deepEqual(h.values, snapshot);
}

// A 已选的公共身份可用于 B 草稿；地点复用城市线索，但发布附加字段必须来自 B 的新响应。
{
  const h = harness({sessionProfiles: true});
  await h.run('topics.search', {query: '真实'}); await h.run('users.search', {query: '好友'});
  h.state.locationPage = () => ({status_code: 0, poi_list: [{poi_id: '401', poi_name: '合成公园',
    anchor_post_ext: {anchor_content: '{"scope":"A"}'}, is_commerce_intention: false}], has_more: false});
  const locations = await h.run('locations.search', {query: '公园', cityCode: '440300', cityName: '深圳市'});
  const value = draft({topics: [{id: '222', name: '真实候选'}], mentions: [{id: '601', name: '合成好友'}], hotspot: '城市日落',
    location: {id: locations.items[0].id, name: locations.items[0].name}}), snapshot = structuredClone(value);
  const first = await h.run('publication.prepare', {draft: value}), firstRecord = structuredClone(preparedRecord(h, first));
  assert.deepEqual(JSON.parse(firstRecord.payload.item.anchor.anchor_content), {scope: 'A', is_commerce_intention: false});
  h.state.account = h.state.hostAccount = '456'; h.state.profile = 'profile-456'; h.engine.invalidate();
  h.state.locationPage = () => ({status_code: 0, poi_list: [{poi_id: '401', poi_name: '公园当前名称',
    anchor_post_ext: {anchor_content: '{"scope":"B"}'}, is_commerce_intention: true}], has_more: false});
  h.state.onUpload = input => {
    assert.equal(input.account, '456');
    assert.deepEqual(input.previous, [], 'public identity reuse never transfers A’s upload checkpoint into B');
  };
  const requests = [];
  h.state.onRequest = (url, options) => requests.push({url: new URL(url), profileId: options.profileId});
  const prepared = await h.run('publication.prepare', {draft: value}), record = preparedRecord(h, prepared), common = record.payload.item.common;
  assert.equal(prepared.canPublish, true); assert.notEqual(prepared.preparationId, first.preparationId);
  assert.equal(record.accountId, '456'); assert.deepEqual(value, snapshot);
  assert.deepEqual(record.draft.topics, snapshot.topics); assert.deepEqual(record.draft.mentions, snapshot.mentions);
  assert.deepEqual(JSON.parse(common.challenges), ['222']); assert.deepEqual(JSON.parse(common.mentions), ['601']);
  const extras = JSON.parse(common.text_extra);
  assert.ok(extras.some(item => item.type === 1 && item.hashtag_id === '222' && item.hashtag_name === '真实候选'));
  assert.ok(extras.some(item => item.type === 0 && item.user_id === '601'));
  assert.equal(common.hot_sentence, snapshot.hotspot);
  assert.equal(record.payload.item.anchor.poi_id, '401'); assert.equal(record.payload.item.anchor.poi_name, '公园当前名称');
  assert.deepEqual(JSON.parse(record.payload.item.anchor.anchor_content), {scope: 'B', is_commerce_intention: true});
  const lookups = requests.filter(request => request.url.pathname === '/aweme/v1/life/video_api/search/poi/');
  assert.equal(lookups.length, 1); assert.equal(lookups[0].url.searchParams.get('selected_city_code'), '440300');
  assert.equal(lookups[0].url.searchParams.get('selected_city_name'), '深圳市'); assert.equal(lookups[0].url.searchParams.get('keywords'), '公园');
  assert.ok(requests.every(request => request.profileId === 'profile-456'), 'all current responses are obtained using B’s browser profile');
  assert.equal(requests.filter(request => request.url.pathname === '/web/api/media/user/info/').length, 1);
  assert.equal(requests.some(request => ['/aweme/v1/search/challengesug/', '/web/api/v2/discover/search/', '/web/api/v2/user/recent/contact/', '/aweme/v1/hotspot/search/', '/aweme/v1/hotspot/recommend/'].includes(request.url.pathname)), false);
  assert.equal(h.state.uploads, 2); assert.equal(h.state.posts.length, 0);
  assert.deepEqual(preparedRecord(h, first), firstRecord, 'B preparation leaves A’s publication record unchanged');
  const requestCount = requests.length;
  await assert.rejects(h.engine.dispatch('publication.publish', {preparationId: first.preparationId, requestId: 'public-identities-cross-account', expectedAccountId: '456', confirmed: true},
    {origin, profileId: h.state.profile, expectedAccountId: '456'}), error => error.code === 'ACCOUNT_CHANGED');
  assert.equal(requests.length, requestCount); assert.equal(h.state.posts.length, 0, 'B cannot submit A’s prepared record');
  assert.deepEqual(preparedRecord(h, first), firstRecord);
}

// B 查不到原地点或需要原生确认时，不能用 A 的旧附加字段继续准备，也不产生 B 上传或发布记录。
for (const reason of ['missing', 'native-confirmation']) {
  const h = harness({sessionProfiles: true});
  h.state.locationPage = () => ({status_code: 0, poi_list: [{poi_id: '401', poi_name: '合成公园',
    anchor_post_ext: {anchor_content: '{"scope":"A"}'}, is_commerce_intention: false}], has_more: false});
  const locations = await h.run('locations.search', {query: '公园', cityCode: '440300', cityName: '深圳市'});
  const value = draft({location: {id: locations.items[0].id, name: locations.items[0].name}}), snapshot = structuredClone(value);
  const first = await h.run('publication.prepare', {draft: value}), firstRecord = structuredClone(preparedRecord(h, first));
  h.state.account = h.state.hostAccount = '456'; h.state.profile = 'profile-456'; h.engine.invalidate();
  h.state.locationPage = () => ({status_code: 0, poi_list: reason === 'missing' ? [] : [{poi_id: '401', poi_name: '合成公园',
    anchor_post_ext: {anchor_content: '{"scope":"B"}'}, trigger_key_user_block: true}], has_more: false});
  h.state.onUpload = () => { assert.fail('B’s unavailable location must stop before upload'); };
  const before = h.state.paths.length;
  await assert.rejects(h.run('publication.prepare', {draft: value}), error => reason === 'missing' ? error.code === 'CHOICE_UNAVAILABLE' : /平台额外确认/.test(error.message));
  assert.ok(h.state.paths.slice(before).includes('/aweme/v1/life/video_api/search/poi/'));
  assert.equal(h.state.uploads, 1); assert.equal(h.state.posts.length, 0); assert.deepEqual(value, snapshot);
  assert.deepEqual(Object.keys(h.values['luma-studio-publications-v1'].preparations), [first.preparationId]);
  assert.deepEqual(preparedRecord(h, first), firstRecord);
}
console.log('native public identities: A-to-B topic/mention/hotspot reuse, current-profile location fields, isolated uploads and publication ownership passed');

// 话题和用户保留已编辑的名称及ID；合集与地点仍从当前业务查询取得新名称、集数及附加字段。
{
  const h = harness({sessionProfiles: true});
  await h.run('topics.search', {query: '真实'}); await h.run('users.search', {query: '好友'});
  await h.run('collections.list', {query: '合成', kind: 'image'});
  h.state.topicPage = () => ({status_code: 0, sug_list: [{cid: '222', cha_name: '新话题名称'}]});
  h.state.userPage = () => ({status_code: 0, user_list: [{uid: '601', nickname: '新好友名称'}]});
  h.state.locationPage = () => ({status_code: 0, poi_list: [{poi_id: '401', poi_name: '新地点名称', anchor_post_ext: {anchor_content: '{"verified":true}'}, is_commerce_intention: false}], has_more: false});
  h.state.collectionPage = () => ({status_code: 0, has_more: 0, mix_list: [{mix_id: '501', mix_name: '全新合集名称', type: 0, status: {status: 0}, statis: {updated_to_episode: 8}}]});
  const value = draft({topics: [{id: '222', name: '真实候选'}], mentions: [{id: '601', name: '合成好友'}],
    location: {id: '401', name: '合成公园', cityCode: '440300', cityName: '深圳市'}, collection: {id: '501', name: '合成合集'}});
  const original = structuredClone(value), prepared = await h.run('publication.prepare', {draft: value}), record = preparedRecord(h, prepared);
  assert.deepEqual(value, original);
  assert.equal(record.draft.topics[0].name, '真实候选'); assert.equal(record.draft.mentions[0].name, '合成好友');
  assert.equal(h.state.queries, 1);
  assert.equal(h.state.paths.filter(path => path === '/web/api/v2/discover/search/').length, 1, 'only the explicit selection query runs; preparation keeps the edited identities');
  assert.equal(record.draft.collection.name, '全新合集名称'); assert.deepEqual(record.payload.item.mix, {mix_id: '501', mix_order: 8});
  assert.equal(record.payload.item.anchor.poi_name, '新地点名称'); assert.equal(record.payload.item.anchor.poi_id, '401');
  assert.deepEqual(JSON.parse(record.payload.item.anchor.anchor_content), {verified: true, is_commerce_intention: false});
}
{
  const h = harness({sessionProfiles: true}), selected = await h.run('activities.resolve', {id: '701'});
  h.state.activities = [{activity_id: '701', activity_name: '活动新名称', activity_status: 1, challenge: ['话题新名称'], challenge_ids: ['801']}];
  h.state.activityDetail = {status_code: 0, activity_info: {activity_id: '701', activity_name: '活动新名称'}, topics: ['话题新名称'], topics_ids: ['801']};
  const prepared = await h.run('publication.prepare', {draft: draft({activities: [selected]})}), record = preparedRecord(h, prepared);
  assert.equal(record.draft.activities[0].name, '活动新名称'); assert.equal(record.draft.activities[0].topic.name, '话题新名称');
  assert.equal(record.payload.item.common.activity, '["801"]');
}
console.log('native streamlined flow: one prepare identity, one pre-submit identity, zero duplicate checks, one status request, retained offline state, immutable success receipts and same-ID renames passed');
