import assert from 'node:assert/strict';
import {createStudioAI} from '../app/studio-ai.js';

// 合成模型和平台回执只用于离线编排验证；测试不会调用真实 AI、读取图片或上传发布。
function harness() {
  const binding = {draftId: 'draft-one', accountId: '123', profileId: 'profile-one', revision: 'manual-content-v1'};
  const input = {baseURL: 'http://127.0.0.1:8765/api/v1', prompt: '合成提示词', context: '合成背景', assetIds: ['asset-1', 'asset-2'], kind: 'image', dateTag: '#20261117'};
  const analysis = {title: '湖边的午后', description: '沿着湖边慢慢走。\n#20200101\n#20200101', location: {cityName: '杭州', query: '西湖', evidence: '作品背景给出杭州，画面有湖景'}, music: {queries: ['轻音乐', '钢琴'], style: '舒缓'} };
  const state = {
    analysis, aiRequests: [], queries: [], cities: [{code: '330100', name: '杭州市'}, {code: '110100', name: '北京市'}],
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
      const data = request.phase === 'analyze' ? state.analysis : state.match || {
        location: request.candidates.locations[0] ? {id: request.candidates.locations[0].id, reason: '与作品线索一致'} : null,
        music: request.candidates.music[0] ? {id: request.candidates.music[0].id, reason: '节奏符合当前画面和文案'} : null,
      };
      return new Response(JSON.stringify({code: 0, data}));
    },
    client: {async request(operation, params, options) {
      assert.ok(['locations.search', 'music.search'].includes(operation), 'orchestrator must never call uploads or publication');
      state.queries.push({operation, params, signal: options.signal});
      await state.onQuery?.(operation, params, options);
      if (state.failQuery === operation) throw Error('合成平台查询失败');
      return {items: structuredClone(operation === 'locations.search' ? state.locations : state.music), nextCursor: '20'};
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
  assert.equal(value.title, '湖边的午后'); assert.equal(value.description, '沿着湖边慢慢走。\n#20261117');
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
  assert.equal(h.ai.isCurrent(offline), false);
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
  {assetIds: [], context: ''}, {prompt: '长'.repeat(8001)}, {dateTag: '20261117'},
]) {
  const h = harness(); await assert.rejects(h.ai.generate({...h.input, ...invalid}));
  assert.equal(h.state.aiRequests.length, 0); assert.equal(h.state.queries.length, 0);
}
for (const invalid of [{title: '😀'.repeat(11)}, {description: '长'.repeat(991)}, {music: {queries: ['重复', '重复'], style: ''}}]) {
  const h = harness(); Object.assign(h.state.analysis, invalid);
  await assert.rejects(h.ai.generate(h.input));
  assert.equal(h.state.queries.length, 0);
}
{
  const h = harness(); h.state.analysis.description = '长'.repeat(990);
  const value = await h.ai.generate(h.input); assert.equal(value.description.length, 1000);
}
{
  const h = harness(); h.state.failAI = 'analyze';
  await assert.rejects(h.ai.generate(h.input), error => error.code === 10001);
  assert.equal(h.state.aiRequests.length, 1); assert.equal(h.state.queries.length, 0);
}
{
  const h = harness(), value = await h.ai.generate({...h.input, kind: 'video'});
  assert.ok(value.title); assert.equal(value.music, null); assert.equal(h.state.queries.length, 0);
  assert.ok(value.warnings.some(item => item.code === 'AI_RESOURCES_UNSUPPORTED'));
}
console.log('studio AI: explicit images, local-only contract, actual candidate provenance, city resolution, bounded matching, dates, offline/partial retry, cancellation and edit/account race isolation passed');
