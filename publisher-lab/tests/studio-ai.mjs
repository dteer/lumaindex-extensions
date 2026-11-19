import assert from 'node:assert/strict';
import {createStudioAI} from '../app/studio-ai.js';
import {directoryContext, dateTag, withDateTag, withPublicationTags, captureDateTag, photoContext} from '../app/ai-context.js';
import {defaultPrompt, currentPrompt} from '../app/ai-copy.js';


// 拍照日期只来自当前目录或明确修图子目录的直接父级，完整日期与闰日必须真实。
for (const [name, expected] of [
  ['20240229 湖畔', '#20240229'], ['湖畔 2024-2-29', '#20240229'], ['2021.7.6 旅拍', '#20210706'],
  ['2021_07_06', '#20210706'], ['2020年2月29日 冬日', '#20200229'], ['２０２４年２月２９日', '#20240229'],
  ['2000-02-29', '#20000229'], ['2024-02-29 20240229', '#20240229'],
  ['2023-02-29', ''], ['1900-02-29', ''], ['2026-04-31', ''], ['20261301', ''], ['20260001', ''],
  ['11月18日', ''], ['2026年11月', ''], ['2026-11', ''], ['日常照片', ''], ['1202611189', ''],
  ['2024-02-29 至 2024-03-01', ''], ['', ''],
]) assert.equal(dateTag(name), expected, name);
assert.equal(dateTag(), '', 'missing metadata never becomes today');
assert.equal(dateTag(new Date()), '', 'a clock value is not a photo-directory date');
assert.deepEqual(directoryContext('/synthetic/2024-02-29 湖畔/修图'), {directoryName: '2024-02-29 湖畔', dateTag: '#20240229'});
assert.deepEqual(directoryContext('/synthetic/2024-02-29 湖畔/修图第二版'), {directoryName: '2024-02-29 湖畔', dateTag: '#20240229'});
for (const edited of ['精修', '修片', '后期', 'Edited', 'retouched']) {
  assert.deepEqual(directoryContext('/synthetic/2021_7_6 旅拍/' + edited), {directoryName: '2021_7_6 旅拍', dateTag: '#20210706'});
}
assert.deepEqual(directoryContext('C:\\synthetic\\2020年2月29日\\修图\\'), {directoryName: '2020年2月29日', dateTag: '#20200229'});
assert.deepEqual(directoryContext('/synthetic/2024-02-29/无日期/修图'), {directoryName: '无日期', dateTag: ''});
assert.deepEqual(directoryContext('/synthetic/2024-02-29/普通子目录'), {directoryName: '普通子目录', dateTag: ''});
assert.deepEqual(directoryContext('/synthetic/2024-02-29/修图/精修'), {directoryName: '修图', dateTag: ''});
assert.deepEqual(directoryContext('/synthetic/2024-02-29/修图/2021-07-06'), {directoryName: '2021-07-06', dateTag: '#20210706'});
assert.deepEqual(directoryContext(undefined), {directoryName: '', dateTag: ''});
assert.equal(withDateTag('无日期文案。\n#20261118', ''), '无日期文案。');
assert.equal(withDateTag('正文。\n#20261118', '#20240229'), '正文。\n#20240229');
assert.throws(() => withDateTag('正文。', '#20230229'));
assert.equal(withPublicationTags('正文。', '#20240229'), '#有序图库\n正文。\n#20240229');
assert.equal(withPublicationTags('#有序图库\n正文。\n#有序图库', '#20240229'), '#有序图库\n正文。\n#20240229', '模型重复品牌话题只保留首行一次');
assert.equal(withPublicationTags('正文 #有序图库摄影', ''), '#有序图库\n正文 #有序图库摄影', '不截断包含相同前缀的其他话题');
assert.equal(withPublicationTags('#有序图库\n正文。\n#20240229', '#20240229'), '#有序图库\n正文。\n#20240229', '固定话题格式化可重复应用');
assert.equal(withPublicationTags('#有序图库#20190701', '#20190701'), '#有序图库\n#20190701', '模型把品牌与日期紧邻时仍只保留一个品牌话题');

// 原始拍摄日优先；带偏移也保留拍摄地的日历日，不能拿创建、导出或 TIFF 修改时间代替。
const originalPhoto = JSON.stringify({rawFields: {'{Exif}.DateTimeOriginal': '2019:01:01 00:05:06', '{Exif}.OffsetTimeOriginal': '+14:00', '{GPS}.Latitude': 'synthetic-private'}});
assert.equal(captureDateTag(originalPhoto), '#20190101');
assert.equal(captureDateTag(JSON.stringify({rawFields: {'{Exif}.DateTimeOriginal': '2019:12:31 23:55:00', '{Exif}.OffsetTimeOriginal': '-12:00'}})), '#20191231');
assert.deepEqual(photoContext({photoMetadata: originalPhoto, directoryPath: '/synthetic/2024-02-29 湖畔/修图', shootDate: '2026-11-18T10:00:00Z'}), {directoryName: '2024-02-29 湖畔', dateTag: '#20190101'});
for (const invalid of [undefined, '{}', 'bad json', 'null', JSON.stringify({rawFields: {'{Exif}.DateTimeOriginal': '2023:02:29 01:02:03'}}),
  JSON.stringify({rawFields: {'{Exif}.DateTimeOriginal': '2024:02:29 24:00:00'}}),
  JSON.stringify({rawFields: {'{TIFF}.DateTime': '2024:02:29 10:00:00', '{Exif}.DateTimeDigitized': '2024:02:29 10:00:00'}})]) {
  assert.equal(captureDateTag(invalid), '');
  assert.equal(photoContext({photoMetadata: invalid, directoryPath: '/synthetic/2021-07-06/修图'}).dateTag, '#20210706');
}
assert.deepEqual(photoContext({shootDate: '2026-11-18T10:00:00Z', createdAt: '2026-11-18T10:00:00Z', modifiedAt: '2026-11-18T10:00:00Z', directoryPath: '/synthetic/无日期'}), {directoryName: '无日期', dateTag: ''});

// 只精确迁移旧默认；自定义、与旧默认仅相似的内容必须原样保留。
const previousPrompt = '你是一位抖音内容编辑。根据用户提供的作品信息，为图文或视频创作自然、具体的中文标题和描述。突出作品本身与真实感受，避免夸张营销、空泛口号和编造人物、地点、经历。信息不足时使用克制的表达。标题简洁有吸引力，描述流畅易读，不添加未经用户提供的事实，不自动添加无关话题或 @ 用户。参考作品首图当前所在目录名称提炼主题和地点线索，目录名只是参考，不把它当成已核实的拍摄地点；描述末尾单独一行写入提供的 dateTag（#YYYYMMDD），正文不超过 980 字符。';
assert.equal(currentPrompt(previousPrompt), defaultPrompt);
const capturePrompt = defaultPrompt.replace('描述首行固定为 #有序图库，随后换行写正文，不重复添加这个话题。', '');
assert.equal(currentPrompt(capturePrompt), defaultPrompt, '此前拍照日期默认升级为首行品牌话题');
assert.equal(currentPrompt(capturePrompt + '\n用户自定义内容'), capturePrompt + '\n用户自定义内容', '不覆盖用户自定义提示词');
assert.equal(currentPrompt(''), defaultPrompt);
for (const custom of ['按我的拍摄日记风格写作。', previousPrompt + '\n我的自定义要求']) assert.equal(currentPrompt(custom), custom);
assert.match(defaultPrompt, /拍照日期/); assert.match(defaultPrompt, /为空时不添加或猜测日期/);

// 合成模型和平台回执只用于离线编排验证；测试不会调用真实 AI、读取图片或上传发布。
function harness() {
  const binding = {draftId: 'draft-one', accountId: '123', profileId: 'profile-one', revision: 'manual-content-v1'};
  const input = {baseURL: 'http://127.0.0.1:8765/api/v1', prompt: '合成提示词', context: '合成背景', assetIds: ['asset-1', 'asset-2'], kind: 'image', dateTag: '#20261117'};
  const analysis = {title: '湖边的午后', description: '沿着湖边慢慢走。\n#20200101\n#20200101', location: {cityName: '杭州', query: '西湖', evidence: '作品背景给出杭州，画面有湖景'}, music: {queries: ['轻音乐', '钢琴'], style: '舒缓'} };
  const state = {
    analysis, aiRequests: [], queries: [], activities: [], hotspots: [], cities: [{code: '330100', name: '杭州市'}, {code: '110100', name: '北京市'}],
    locations: [{id: '101', name: '合成西湖候选', address: '合成地址', cityCode: '330100', cityName: '杭州市'}],
    music: [{id: '201', name: '合成轻音乐', description: '合成作者', duration: 120, thumbnailURL: 'https://media.example.test/cover.jpg', previewURL: 'https://media.example.test/song.mp3'}],
  };
  let sequence = 0;
  const ai = createStudioAI({getCurrent: () => binding, uuid: () => `suggestion-${++sequence}`, now: () => new Date(2026, 10, 17),
    loadCities: async () => { if (state.cityError) throw Error('合成城市读取失败'); return state.cities; },
    fetchImpl: async (url, options) => {
      assert.equal(url, input.baseURL + '/ai/publish-assist');
      assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
      const request = JSON.parse(options.body); state.aiRequests.push(request);
      await state.onAI?.(request, options);
      if (state.failAI === request.phase) return new Response(JSON.stringify({code: 10001, message: '合成模型请求失败'}), {status: 400});
      const data = request.phase === 'analyze' ? state.analysis : request.phase === 'select' ? (state.selection || {choice: request.options[0] ? {id: request.options[0].id, reason: '与作品内容直接相关'} : null}) : state.match || {
        location: request.candidates.locations[0] ? {id: request.candidates.locations[0].id, reason: '与作品线索一致'} : null,
        music: request.candidates.music[0] ? {id: request.candidates.music[0].id, reason: '节奏符合当前画面和文案'} : null,
      };
      return new Response(JSON.stringify({code: 0, data}));
    },
    client: {async request(operation, params, options) {
      assert.ok(['locations.search', 'music.search', 'activities.list', 'activities.resolve', 'hotspots.search'].includes(operation), 'orchestrator must never call uploads or publication');
      state.queries.push({operation, params, signal: options.signal});
      await state.onQuery?.(operation, params, options);
      if (state.failQuery === operation) throw Error('合成平台查询失败');
      if (operation === 'activities.resolve') return state.resolvedActivity || {...state.activities.find(item => item.id === params.id), topic: {id: '777', name: '徒步日记'}};
      return {items: structuredClone(operation === 'locations.search' ? state.locations : operation === 'music.search' ? state.music : operation === 'activities.list' ? state.activities : state.hotspots), nextCursor: '20'};
    }},
  });
  return {ai, state, input, binding};
}

// 全流程仅传选中图片 ID；模型匹配只能返回真实候选身份，公开名称/城市/时长均取平台原值。
{
  const h = harness(), progress = [];
  h.state.match = {location: {id: '101', name: '模型伪造名称', cityCode: '999999', reason: '合成依据'}, music: {id: '201', duration: 999, reason: '合成配乐依据'}};
  const inputSnapshot = structuredClone(h.input), bindingSnapshot = structuredClone(h.binding);
  const value = await h.ai.generate(h.input, {onProgress: update => progress.push(update.phase)});
  assert.equal(value.title, '湖边的午后'); assert.equal(value.description, '#有序图库\n沿着湖边慢慢走。\n#20261117');
  assert.deepEqual(value.topics, [{id: '0', name: '有序图库'}, {id: '0', name: '20261117'}], '固定首行与日期绑定官网名称话题，而非模型生成 ID');
  assert.equal(h.state.queries.some(query => query.operation === 'topics.search'), false, '绑定日期无需额外搜索');
  assert.deepEqual(value.location, {id: '101', name: '合成西湖候选', address: '合成地址', cityCode: '330100', cityName: '杭州市', reason: '合成依据'});
  assert.equal(value.music.id, '201'); assert.equal(value.music.name, '合成轻音乐'); assert.equal(value.music.duration, 120);
  assert.equal(value.music.author, '合成作者'); assert.equal(value.music.previewURL, 'https://media.example.test/song.mp3');
  assert.deepEqual(progress, ['analyze', 'resources', 'match']); assert.equal(h.ai.isCurrent(value), true);
  assert.deepEqual(h.input, inputSnapshot); assert.deepEqual(h.binding, bindingSnapshot);
  assert.deepEqual(h.state.aiRequests[0].assetIds, ['asset-1', 'asset-2']);
  const matching = h.state.aiRequests[1];
  assert.equal(matching.phase, 'match'); assert.equal(matching.assetIds, undefined); assert.equal(matching.prompt, undefined);
  assert.match(matching.context, /合成背景/); assert.match(matching.context, /湖边的午后/);
  assert.equal(JSON.stringify(matching).includes('https://media.example.test'), false);
  assert.deepEqual(matching.candidates.music, [{id: '201', name: '合成轻音乐', author: '合成作者', duration: 120}]);
  assert.equal(h.state.queries.find(item => item.operation === 'locations.search').params.cityCode, '330100');
}

// 离线仍生成文案和线索；明确登录后只重试资源，不重新读取图片或生成文案。
{
  const h = harness(); h.binding.accountId = ''; h.binding.profileId = '';
  const offline = await h.ai.generate(h.input);
  assert.equal(offline.location, null); assert.equal(offline.music, null); assert.equal(offline.analysis.location.query, '西湖');
  assert.ok(offline.warnings.some(item => item.code === 'AI_ACCOUNT_REQUIRED'));
  assert.equal(h.state.aiRequests.length, 1); assert.equal(h.state.queries.length, 0);
  h.binding.accountId = '456'; h.binding.profileId = 'profile-two';
  assert.equal(h.ai.isCurrent(offline), true, '登录后已有文案仍可使用');
  assert.equal(h.ai.isCurrent(offline, 'music'), false);
  const matched = await h.ai.retryResources(offline);
  assert.equal(matched.description, offline.description); assert.equal(matched.music.id, '201');
  assert.equal(matched.binding.accountId, '456'); assert.equal(h.ai.isCurrent(matched), true);
  assert.equal(h.state.aiRequests.filter(item => item.phase === 'analyze').length, 1);
  await assert.rejects(h.ai.retryResources(offline), error => error.code === 'AI_STALE_RESULT');
}

// 地点或匹配阶段单独失败时保留完整文案；显式重试仅进入资源阶段。
{
  const h = harness(); h.state.failQuery = 'locations.search';
  const partial = await h.ai.generate(h.input);
  assert.equal(partial.location, null); assert.equal(partial.music.id, '201'); assert.ok(partial.title);
  assert.ok(partial.warnings.some(item => item.code === 'AI_LOCATION_QUERY_FAILED'));
  h.state.failQuery = null;
  const retried = await h.ai.retryResources(partial);
  assert.equal(retried.location.id, '101'); assert.equal(retried.title, partial.title);
  assert.equal(h.state.aiRequests.filter(item => item.phase === 'analyze').length, 1);
}

// 会话离线只影响失败的资源请求；已生成文案、成功候选及其本地应用资格保留。
for (const failAfterFirstCandidate of [false, true]) {
  const h = harness(); h.binding.connected = true;
  let musicQueries = 0;
  h.state.onQuery = operation => {
    if (operation !== 'music.search') return;
    musicQueries++;
    if (failAfterFirstCandidate && musicQueries === 1) return;
    h.binding.connected = false; // 与真实客户端一致：保留已知账号及档案，不把离线误认成换号。
    throw Object.assign(Error('账号暂时离线，请手动处理后重试。'), {code: 'SESSION_EXPIRED'});
  };
  const partial = await h.ai.generate(h.input);
  assert.equal(partial.title, '湖边的午后');
  assert.equal(partial.location.id, '101');
  assert.equal(partial.music?.id ?? null, failAfterFirstCandidate ? '201' : null);
  assert.ok(partial.warnings.some(item => item.scope === 'music' && item.message.includes('手动处理')));
  assert.equal(h.ai.isCurrent(partial), true);
  assert.equal(musicQueries, failAfterFirstCandidate ? 2 : 1, 'account errors must not trigger another keyword request');
  assert.equal(h.state.aiRequests.filter(item => item.phase === 'analyze').length, 1);
  h.binding.accountId = '456';
  assert.equal(h.ai.isCurrent(partial), true, '换号不使已完成公共建议失效');
  assert.equal(h.ai.isCurrent(partial, 'music'), false, '音乐来源仍需匹配当前账号');
}

// 完成后仅离线提示变化不使建议失效，也不自动查询或重新生成。
{
  const h = harness(), value = await h.ai.generate(h.input);
  const requests = h.state.aiRequests.length, queries = h.state.queries.length;
  h.binding.connected = false;
  assert.equal(h.ai.isCurrent(value), true);
  assert.equal(value.music.id, '201'); assert.equal(value.location.id, '101');
  assert.equal(h.state.aiRequests.length, requests); assert.equal(h.state.queries.length, queries);
}
for (const mode of ['unknown-id', 'backend-failure', 'missing-field']) {
  const h = harness();
  if (mode === 'unknown-id') h.state.match = {location: {id: '9999', reason: '编造'}, music: {id: '201', reason: '真实'}};
  if (mode === 'backend-failure') h.state.failAI = 'match';
  if (mode === 'missing-field') h.state.match = {location: null};
  const value = await h.ai.generate(h.input);
  assert.ok(value.description.endsWith('#20261117')); assert.equal(value.location, null); assert.equal(value.music, null);
  assert.ok(value.warnings.some(item => item.code === 'AI_MATCH_FAILED')); assert.equal(h.ai.isCurrent(value), true);
  h.state.match = null; h.state.failAI = null;
  const retried = await h.ai.retryResources(value);
  assert.equal(retried.music.id, '201'); assert.equal(h.state.aiRequests.filter(item => item.phase === 'analyze').length, 1);
}

// 城市不能模糊猜测或由模型直接提供代码；模糊/重复名称只留下可检查线索。
for (const mode of ['unknown', 'ambiguous', 'unavailable']) {
  const h = harness();
  if (mode === 'unknown') h.state.analysis.location.cityName = '湖边小城';
  if (mode === 'ambiguous') h.state.cities.push({code: '330199', name: '杭州市'});
  if (mode === 'unavailable') h.state.cityError = true;
  h.state.analysis.location.cityCode = '999999';
  const value = await h.ai.generate(h.input);
  assert.equal(value.location, null); assert.equal(value.music.id, '201');
  assert.equal(h.state.queries.some(item => item.operation === 'locations.search'), false);
  assert.ok(value.warnings.some(item => item.scope === 'location'));
}

// 候选去重并有界；需要平台额外确认的地点、错误城市和无时长音乐不进入模型。
{
  const h = harness();
  h.state.locations = [
    {...h.state.locations[0], requiresNativeSelection: true},
    {...h.state.locations[0], id: '102', cityCode: '110100'},
    {...h.state.locations[0], id: 103},
  ];
  h.state.music = [
    {...h.state.music[0], duration: undefined}, {...h.state.music[0], id: '202', duration: 0},
    {...h.state.music[0], id: '203', duration: 90000}, {...h.state.music[0], id: 204},
  ];
  const value = await h.ai.generate(h.input);
  assert.equal(value.location, null); assert.equal(value.music, null);
  assert.equal(h.state.aiRequests.length, 1, 'no matching model request when no usable platform candidates exist');
}
{
  const h = harness();
  h.state.music = Array.from({length: 25}, (_, index) => ({id: String(300 + index), name: `真实音乐${index}`, description: '作者', duration: 100}));
  h.state.locations = Array.from({length: 25}, (_, index) => ({id: String(400 + index), name: `真实地点${index}`, address: '地址', cityCode: '330100', cityName: '杭州市'}));
  await h.ai.generate(h.input);
  const match = h.state.aiRequests.find(item => item.phase === 'match');
  assert.equal(match.candidates.locations.length, 20); assert.equal(match.candidates.music.length, 20);
  assert.equal(h.state.queries.filter(item => item.operation === 'music.search').length, 1);
}
{
  const h = harness(); h.state.analysis.music.queries = [];
  await h.ai.generate(h.input);
  assert.equal(h.state.queries.find(item => item.operation === 'music.search').params.query, '', 'lack of search words uses real recommendations for model matching');
}

// 编辑、手动选择和切换账号让结果失效；旧异步响应不得恢复建议或覆盖现有字段。
for (const field of ['revision', 'draftId', 'accountId', 'profileId']) {
  const h = harness();
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  h.state.onAI = request => { if (request.phase === 'analyze') { started(); return new Promise(resolve => { release = resolve; }); } };
  const pending = h.ai.generate(h.input);
  const outcome = assert.rejects(pending, error => error.code === 'AI_STALE_RESULT');
  await waiting; h.binding[field] += '-changed'; release(); await outcome;
  assert.equal(h.state.queries.length, 0);
}
{
  const h = harness(), value = await h.ai.generate(h.input);
  h.binding.revision = 'user-selected-different-music';
  assert.equal(h.ai.isCurrent(value), false);
  const before = h.state.aiRequests.length;
  await assert.rejects(h.ai.retryResources(value), error => error.code === 'AI_STALE_RESULT');
  assert.equal(h.state.aiRequests.length, before);
}
{
  const h = harness(); let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  h.state.onQuery = operation => { if (operation === 'music.search') { started(); return new Promise(resolve => { release = resolve; }); } };
  const pending = h.ai.generate(h.input), outcome = assert.rejects(pending, error => error.code === 'AI_STALE_RESULT');
  await waiting; h.binding.accountId = '456'; release(); await outcome;
  assert.equal(h.state.aiRequests.filter(item => item.phase === 'match').length, 0);
  assert.ok(h.state.queries.every(item => item.signal.aborted));
}

// 新生成和显式取消使旧任务无效，即使合成服务忽略 AbortSignal 也不能交付旧结果。
{
  const h = harness(); let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  h.state.onAI = request => { if (request.phase === 'analyze') { h.state.onAI = null; started(); return new Promise(resolve => { release = resolve; }); } };
  const first = h.ai.generate(h.input), outcome = assert.rejects(first, error => error.name === 'AbortError');
  await waiting;
  const second = await h.ai.generate(h.input); release(); await outcome;
  assert.equal(h.ai.isCurrent(second), true);
  h.ai.cancel(); assert.equal(h.ai.isCurrent(second), false);
}
{
  const h = harness(); let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  h.state.onAI = request => { if (request.phase === 'match') { started(); return new Promise(resolve => { release = resolve; }); } };
  const controller = new AbortController();
  const pending = h.ai.generate(h.input, {signal: controller.signal}), outcome = assert.rejects(pending, error => error.name === 'AbortError');
  await waiting; controller.abort(); release(); await outcome;
  h.ai.dispose(); await assert.rejects(h.ai.generate(h.input), error => error.code === 'AI_DISPOSED');
}

// 文字/图片输入与最终 UTF-16 文案长度均严格校验；非法本机地址不会触发请求。
for (const invalid of [
  {baseURL: 'https://external.example.test/api/v1'}, {baseURL: 'http://user@127.0.0.1:8765/api/v1'},
  {assetIds: Array.from({length: 7}, (_, index) => `asset-${index}`)}, {assetIds: ['duplicate', 'duplicate']},
  {assetIds: [], context: ''}, {prompt: '长'.repeat(8001)}, {dateTag: '20261117'}, {dateTag: '#20230229'}, {dateTag: 20261117},
]) {
  const h = harness(); await assert.rejects(h.ai.generate({...h.input, ...invalid}));
  assert.equal(h.state.aiRequests.length, 0); assert.equal(h.state.queries.length, 0);
}
for (const invalid of [{title: '😀'.repeat(11)}, {description: '长'.repeat(985)}, {music: {queries: ['重复', '重复'], style: ''}}]) {
  const h = harness(); Object.assign(h.state.analysis, invalid);
  await assert.rejects(h.ai.generate(h.input));
  assert.equal(h.state.queries.length, 0);
}
{
  const h = harness(); h.state.analysis.description = '长'.repeat(984);
  const value = await h.ai.generate(h.input); assert.equal(value.description.length, 1000);
}
{
  const h = harness(); h.state.failAI = 'analyze';
  await assert.rejects(h.ai.generate(h.input), error => error.code === 10001);
  assert.equal(h.state.aiRequests.length, 1); assert.equal(h.state.queries.length, 0);
}
{
  const h = harness(), value = await h.ai.generate({...h.input, kind: 'video'});
  assert.ok(value.title); assert.equal(value.music, null); assert.deepEqual(h.state.queries.map(item => item.operation).sort(), ['activities.list', 'hotspots.search']);
  assert.ok(value.warnings.some(item => item.code === 'AI_RESOURCES_UNSUPPORTED'));
}
// 无日期或省略日期时不回退到机器时钟，并移除模型重复/猜测的末尾日期。
for (const tag of ['', undefined]) {
  const h = harness();
  const value = await h.ai.generate({...h.input, dateTag: tag});
  assert.equal(value.description, '#有序图库\n沿着湖边慢慢走。');
  assert.equal(value.analysis.description, '#有序图库\n沿着湖边慢慢走。');
  assert.deepEqual(value.topics, [{id: '0', name: '有序图库'}], '没有拍照日期只绑定固定品牌话题');
}
// 活动使用真实列表和已解析话题；热点仅采用真实词语，不让 AI 编造发布身份。
{
  const h = harness();
  h.state.activities = [
    {id: '600', name: '不可参加', disabled: true},
    {id: '601', name: '周末徒步', topicName: '徒步日记', thumbnailURL: 'https://media.example.test/activity.jpg', credential: 'must-not-send'},
  ];
  h.state.hotspots = [{name: '一起去山野', heat: 12345, thumbnailURL: 'https://media.example.test/hotspot.jpg', credential: 'must-not-send'}];
  const value = await h.ai.generate(h.input);
  assert.equal(value.activity.id, '601');
  assert.deepEqual(value.activity.topic, {id: '777', name: '徒步日记'});
  assert.equal(value.hotspot.name, '一起去山野');
  assert.deepEqual(value.states, {copy: 'ready', location: 'ready', music: 'ready', activity: 'ready', hotspot: 'ready'});
  const selectors = h.state.aiRequests.filter(item => item.phase === 'select');
  assert.equal(selectors.length, 2);
  assert.deepEqual(selectors.flatMap(item => item.options.map(option => option.id)).sort(), ['601', 'hotspot-0']);
  assert.equal(JSON.stringify(selectors).includes('must-not-send'), false);
  assert.equal(JSON.stringify(selectors).includes('https://media.example.test'), false);
  assert.equal(h.state.queries.filter(item => item.operation === 'activities.resolve').length, 1);
  assert.equal(h.state.queries.find(item => item.operation === 'hotspots.search').params.draftId, 'draft-one');
}

// 不关联是成功建议，查询或匹配失败则单独标错，不把失败伪装成“不关联”。
{
  const h = harness(); h.state.activities = [{id: '601', name: '无关活动'}]; h.state.hotspots = [{name: '无关热点'}];
  h.state.selection = {choice: null};
  const value = await h.ai.generate(h.input);
  assert.equal(value.states.activity, 'empty'); assert.equal(value.states.hotspot, 'empty');
  assert.equal(value.activity, null); assert.equal(value.hotspot, null);
  assert.equal(h.state.queries.some(item => item.operation === 'activities.resolve'), false);
  assert.equal(value.warnings.some(item => ['activity', 'hotspot'].includes(item.scope)), false);
}
for (const mode of ['query', 'unknown-choice', 'invalid-topic']) {
  const h = harness(); h.state.activities = [{id: '601', name: '活动'}]; h.state.hotspots = [{name: '热点'}];
  if (mode === 'query') h.state.failQuery = 'hotspots.search';
  if (mode === 'unknown-choice') h.state.selection = {choice: {id: 'made-up-id', reason: '编造'}};
  if (mode === 'invalid-topic') h.state.resolvedActivity = {id: '601', name: '活动', topic: {id: 777, name: '错误数字身份'}};
  const value = await h.ai.generate(h.input);
  assert.equal(value.states[mode === 'query' ? 'hotspot' : 'activity'], 'error');
  assert.equal(value.music.id, '201'); assert.equal(value.location.id, '101'); assert.ok(value.title);
}

// 音乐单独定制同时影响搜索线索与候选选择，热点提示词不会泄露到其他推荐项。
{
  const h = harness(); h.state.hotspots = [{name: '一起徒步'}];
  h.input.resourcePrompts = {music: '只要纯音乐，不要人声。', hotspot: '只关联户外徒步。'};
  await h.ai.generate(h.input);
  assert.match(h.state.aiRequests.find(item => item.phase === 'analyze').prompt, /只要纯音乐/);
  assert.match(h.state.aiRequests.find(item => item.phase === 'match').context, /只要纯音乐/);
  assert.match(h.state.aiRequests.find(item => item.phase === 'select').prompt, /只关联户外徒步/);
  assert.equal(h.state.aiRequests.find(item => item.phase === 'analyze').prompt.includes('只关联户外'), false);
}

// 换一首只读取音乐候选，保留文案、地点、活动和热点，并优先换成另一个真实候选。
{
  const h = harness(); h.state.activities = [{id: '601', name: '徒步活动'}]; h.state.hotspots = [{name: '一起徒步'}];
  const first = await h.ai.generate(h.input);
  h.state.music.push({...h.state.music[0], id: '202', name: '另一首纯音乐'});
  h.state.analysis.title = '不应覆盖原文案'; h.state.analysis.music.queries = ['纯音乐'];
  const queryStart = h.state.queries.length, askStart = h.state.aiRequests.length;
  const next = await h.ai.regenerate(first, 'music', {prompt: '轻快一点，只要纯音乐'});
  assert.equal(next.music.id, '202'); assert.equal(next.title, first.title); assert.equal(next.description, first.description);
  for (const key of ['location', 'activity', 'hotspot']) assert.equal(next[key], first[key]);
  assert.deepEqual(h.state.queries.slice(queryStart).map(item => item.operation), ['music.search']);
  assert.deepEqual(h.state.aiRequests.slice(askStart).map(item => item.phase), ['analyze', 'match']);
  assert.match(h.state.aiRequests.at(-2).prompt, /轻快一点，只要纯音乐/);
  assert.deepEqual(h.state.aiRequests.at(-1).candidates.locations, []);
  assert.equal(h.ai.isCurrent(first), false); assert.equal(h.ai.isCurrent(next), true);
  const reset = await h.ai.regenerate(next, 'music', {prompt: ''});
  assert.equal(h.state.aiRequests.at(-2).prompt.includes('轻快一点'), false);
  assert.equal(h.ai.isCurrent(reset), true);
}

// 更换热点不重新分析图片或查询音乐；单独文案重做也不触碰资源查询。
{
  const h = harness(); h.state.hotspots = [{name: '一起徒步'}, {name: '走进山野'}];
  const first = await h.ai.generate(h.input), queryStart = h.state.queries.length, askStart = h.state.aiRequests.length;
  const second = await h.ai.regenerate(first, 'hotspot', {prompt: '只选山野主题'});
  assert.equal(second.hotspot.name, '走进山野'); assert.equal(second.music, first.music);
  assert.deepEqual(h.state.queries.slice(queryStart).map(item => item.operation), ['hotspots.search']);
  assert.deepEqual(h.state.aiRequests.slice(askStart).map(item => item.phase), ['select']);
  assert.match(h.state.aiRequests.at(-1).prompt, /只选山野主题/);
  h.state.analysis.title = '重新写的文案';
  const queries = h.state.queries.length;
  const copy = await h.ai.regenerate(second, 'copy');
  assert.equal(copy.title, '重新写的文案'); assert.equal(copy.hotspot, second.hotspot); assert.equal(copy.music, second.music);
  assert.equal(h.state.queries.length, queries);
}

// 局部失败只重试该项；已经成功的候选和文案不重复生成或读取。
{
  const h = harness(); h.state.failQuery = 'hotspots.search'; h.state.hotspots = [{name: '一起徒步'}];
  const partial = await h.ai.generate(h.input); h.state.failQuery = null;
  const queries = h.state.queries.length, asks = h.state.aiRequests.length;
  const retried = await h.ai.retryResources(partial);
  assert.equal(retried.hotspot.name, '一起徒步'); assert.equal(retried.music, partial.music);
  assert.deepEqual(h.state.queries.slice(queries).map(item => item.operation), ['hotspots.search']);
  assert.deepEqual(h.state.aiRequests.slice(asks).map(item => item.phase), ['select']);
}

// 关闭助手保留完成建议；取消新的在途请求也不能将旧建议覆盖或重新激活迟到结果。
{
  const h = harness(), first = await h.ai.generate(h.input);
  h.ai.cancelPending(); assert.equal(h.ai.isCurrent(first), true);
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  h.state.onAI = request => { if (request.phase === 'analyze') { started(); return new Promise(resolve => { release = resolve; }); } };
  const pending = h.ai.regenerate(first, 'copy'), outcome = assert.rejects(pending, error => error.name === 'AbortError');
  await waiting; h.ai.cancelPending(); release(); await outcome;
  assert.equal(h.ai.isCurrent(first), true);
  h.ai.cancel(); assert.equal(h.ai.isCurrent(first), false);
}

// 素材或作品变化后的单项请求在读取前拒绝，不能复用旧作品建议。
for (const field of ['revision', 'draftId']) {
  const h = harness(), first = await h.ai.generate(h.input), queries = h.state.queries.length;
  h.binding[field] += '-changed';
  await assert.rejects(h.ai.regenerate(first, 'hotspot'), error => error.code === 'AI_STALE_RESULT');
  assert.equal(h.state.queries.length, queries);
}
// 编辑建议保留结果身份；其他单项重做不得恢复旧文案，明确清空同样保留。
{
  const h = harness(); h.state.hotspots = [{name: '一起徒步'}];
  const first = await h.ai.generate(h.input);
  assert.equal(h.ai.editCopy(first, {title: '手动改写标题', description: '手动改写正文'}), first);
  assert.equal(first.analysis.title, '手动改写标题'); assert.equal(h.ai.isCurrent(first), true);
  const next = await h.ai.regenerate(first, 'hotspot');
  assert.equal(next.title, '手动改写标题'); assert.equal(next.description, '手动改写正文');
  h.ai.editCopy(next, {title: '', description: ''});
  const empty = await h.ai.regenerate(next, 'location');
  assert.equal(empty.title, ''); assert.equal(empty.description, ''); assert.equal(h.ai.isCurrent(empty), true);
  assert.throws(() => h.ai.editCopy(empty, {title: '长'.repeat(21), description: ''}), error => error.code === 'AI_INVALID_REQUEST');
  h.binding.accountId = 'changed';
  assert.equal(h.ai.editCopy(empty, {title: '保留文案', description: ''}).title, '保留文案');
  assert.equal(h.ai.isCurrent(empty, 'music'), false, '编辑公共文案不能使旧账号音乐候选有效');
}
// 完成的公共建议可跨账号保留；每个账号相关项独立刷新，不能借另一项重推恢复资格。
for (const field of ['accountId', 'profileId']) {
  const h = harness(); h.state.hotspots = [{name: '一起徒步'}];
  const first = await h.ai.generate(h.input), queries = h.state.queries.length;
  h.binding[field] += '-changed';
  for (const scope of [undefined, 'copy', 'location', 'hotspot']) assert.equal(h.ai.isCurrent(first, scope), true);
  for (const scope of ['music', 'activity']) assert.equal(h.ai.isCurrent(first, scope), false);
  assert.equal(h.state.queries.length, queries, '换号自身不会发起额外查询');
  const next = await h.ai.regenerate(first, 'hotspot');
  assert.deepEqual(next.location, first.location); assert.deepEqual(next.music, first.music);
  assert.deepEqual(h.state.queries.slice(queries).map(item => item.operation), ['hotspots.search']);
  assert.equal(h.ai.isCurrent(next, 'music'), false); assert.equal(h.ai.isCurrent(next, 'activity'), false);
  const music = await h.ai.regenerate(next, 'music');
  assert.equal(h.ai.isCurrent(music, 'music'), true);
  assert.equal(h.ai.isCurrent(music, 'activity'), false, '换一首只能更新音乐的账号来源');
  const beforeRetry = h.state.queries.length;
  const refreshed = await h.ai.retryResources(music);
  assert.equal(h.ai.isCurrent(refreshed, 'activity'), true);
  assert.deepEqual(h.state.queries.slice(beforeRetry).map(item => item.operation), ['activities.list']);
  assert.deepEqual(refreshed.location, first.location);
}
// 更新其他建议不会清除尚未重试的音乐/地点错误。
{
  const h = harness(); h.state.failAI = 'match'; h.state.hotspots = [{name: '一起徒步'}];
  const first = await h.ai.generate(h.input);
  const next = await h.ai.regenerate(first, 'hotspot');
  for (const key of ['music', 'location']) {
    assert.equal(next.states[key], 'error');
    assert.ok(next.warnings.some(item => item.scope === key && item.code === 'AI_MATCH_FAILED'));
  }
}
console.log('studio AI: explicit images, local-only contract, actual candidate provenance, city resolution, bounded matching, dates, offline/partial retry, cancellation and edit/account race isolation passed');
