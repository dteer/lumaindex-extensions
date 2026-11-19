import {dateTag, withPublicationTags} from './ai-context.js';

// PLATFORM_ID 只接受实际平台查询返回的数字身份，AI 生成的名称不能自行变成发布身份。
const PLATFORM_ID = /^\d{1,30}$/;
// CANDIDATE_LIMIT 与本机匹配契约一致；只提供有界首批候选，不隐式遍历平台所有结果。
const CANDIDATE_LIMIT = 20;

/** 创建带稳定错误码的本机编排错误，界面可保留输入并提供对应操作。 */
function failure(code, message) { return Object.assign(Error(message), {code}); }

/** 校验文字字段而不静默截断 AI 文案；平台展示附加字段另行按白名单裁剪。 */
function checkedText(value, maximum, {empty = false} = {}) {
  if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim())) throw failure('AI_INVALID_RESULT', 'AI 返回的建议格式不正确，请重新生成。');
  return value.trim();
}

/** 只接受本机图库 AI 入口，不允许作品背景和图片身份发送到调用方指定的外部地址。 */
function localBaseURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname.replace(/\/$/, '') === '/api/v1' && !url.username && !url.password && !url.search && !url.hash) return url.origin + '/api/v1';
  } catch {}
  throw failure('AI_INVALID_REQUEST', '请从有序图库打开工作台后使用 AI 建议。');
}

/** 将真实候选的媒体地址留作临时预览；模型匹配和持久化都不需要这些地址。 */
function mediaURL(value) {
  try { const url = new URL(value); if (url.protocol === 'https:' && !url.username && !url.password) return url.href; } catch {}
  return undefined;
}

/** 仅展示可读的短中文提示，避免底层诊断或请求内容进入用户建议。 */
function publicMessage(error, fallback) {
  return typeof error?.message === 'string' && error.message.length <= 350 && /[\u3400-\u9fff]/u.test(error.message) ? error.message : fallback;
}

/** 复制当前草稿、账号和编辑版本；该绑定只用于迟到结果检查，不发送给 AI。 */
function currentBinding(getCurrent) {
  const value = getCurrent();
  if (!value || typeof value.draftId !== 'string' || !value.draftId || !['string', 'number'].includes(typeof value.revision) || (typeof value.revision === 'number' && !Number.isSafeInteger(value.revision))) throw failure('AI_INVALID_REQUEST', '当前作品状态无法确认，请重新打开 AI 建议。');
  return {draftId: value.draftId, accountId: typeof value.accountId === 'string' ? value.accountId : '', profileId: typeof value.profileId === 'string' ? value.profileId : '', revision: value.revision};
}

/** 建议属于同一作品；素材变化只提示，账号相关资源和在途请求仍核对账号来源。 */
function sameBinding(left, right, includeAccount = true) {
  return left.draftId === right.draftId && (!includeAccount || left.accountId === right.accountId && left.profileId === right.profileId);
}

/** 固定首行品牌话题和末尾拍照日期，并使用官网的 0 标记绑定名称话题。 */
function analyzeResult(raw, tag) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw failure('AI_INVALID_RESULT', 'AI 返回的建议格式不正确，请重新生成。');
  const title = checkedText(raw.title, 20), description = withPublicationTags(checkedText(raw.description, 1000), tag);
  let location = null;
  if (raw.location !== null && raw.location !== undefined) {
    location = {cityName: checkedText(raw.location.cityName, 80), query: checkedText(raw.location.query, 100), evidence: checkedText(raw.location.evidence, 500, {empty: true})};
  }
  if (!raw.music || !Array.isArray(raw.music.queries) || raw.music.queries.length > 2) throw failure('AI_INVALID_RESULT', 'AI 返回的音乐线索格式不正确，请重新生成。');
  const queries = raw.music.queries.map(value => checkedText(value, 80));
  if (new Set(queries).size !== queries.length) throw failure('AI_INVALID_RESULT', 'AI 返回了重复的音乐线索，请重新生成。');
  const topics = [{id: '0', name: '有序图库'}, ...(tag ? [{id: '0', name: tag.slice(1)}] : [])];
  return {title, description, topics, location, music: {queries, style: checkedText(raw.music.style, 300, {empty: true})}};
}

/** 城市必须唯一命中插件静态表；“杭州”和“杭州市”可对应，但不模糊推断省份或行政代码。 */
function resolveCity(values, name) {
  if (!Array.isArray(values)) throw failure('AI_CITY_UNAVAILABLE', '城市列表读取失败，请重试地点匹配。');
  const seen = new Set();
  const cities = values.filter(value => value && /^\d{6}$/.test(value.code) && typeof value.name === 'string' && value.name.trim() && value.name.length <= 50 && !seen.has(value.code) && seen.add(value.code));
  const exact = cities.filter(city => city.name === name);
  if (exact.length === 1) return exact[0];
  const normalize = text => text.normalize('NFKC').trim().replace(/市$/u, '');
  const matches = cities.filter(city => normalize(city.name) === normalize(name));
  return matches.length === 1 ? matches[0] : null;
}

/** 从真实平台结果提取地点候选；需要平台额外确认的地点不交给 AI 自动挑选。 */
function locationCandidates(page, city) {
  if (!Array.isArray(page?.items)) throw failure('AI_RESOURCE_FAILED', '地点候选读取失败，请重试地点匹配。');
  const seen = new Set(), items = [];
  for (const item of page.items) {
    if (!item || typeof item.id !== 'string' || !PLATFORM_ID.test(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200 || item.requiresNativeSelection || seen.has(item.id)) continue;
    // 必须与真实查询的城市一致，不接受响应夹带的其他城市身份。
    if (item.cityCode !== city.code || item.cityName !== city.name) continue;
    seen.add(item.id);
    items.push({id: item.id, name: item.name, address: typeof item.address === 'string' ? item.address.slice(0, 500) : '', cityCode: city.code, cityName: city.name});
    if (items.length === CANDIDATE_LIMIT) break;
  }
  return items;
}

/** 从真实平台结果提取可准备发布的音乐；时长缺失时不能由 AI 补造时长。 */
function musicCandidates(page) {
  if (!Array.isArray(page?.items)) throw failure('AI_RESOURCE_FAILED', '音乐候选读取失败，请重试音乐匹配。');
  const seen = new Set(), items = [];
  for (const item of page.items) {
    if (!item || typeof item.id !== 'string' || !PLATFORM_ID.test(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200 || !Number.isFinite(item.duration) || item.duration <= 0 || item.duration > 86400 || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push({id: item.id, name: item.name, author: typeof item.description === 'string' ? item.description.slice(0, 200) : '', duration: item.duration,
      thumbnailURL: mediaURL(item.thumbnailURL), previewURL: mediaURL(item.previewURL)});
    if (items.length === CANDIDATE_LIMIT) break;
  }
  return items;
}

/** 检查模型选中的 ID 确实在本次对应真实候选内，名称和发布字段始终取原候选。 */
function matchedItem(raw, candidates) {
  if (raw === null) return null;
  if (!raw || typeof raw.id !== 'string') throw failure('AI_INVALID_MATCH', 'AI 资源匹配结果无法确认，请重试资源匹配。');
  const candidate = candidates.find(item => item.id === raw.id);
  if (!candidate) throw failure('AI_INVALID_MATCH', 'AI 选择的资源不在本次真实候选中，请重试资源匹配。');
  return {...candidate, reason: checkedText(raw.reason, 500, {empty: true})};
}

/** 独立编排图片/文字分析、真实平台候选查询和 AI 候选匹配；不修改草稿，不上传或发布。 */
export function createStudioAI({client, getCurrent, fetchImpl = globalThis.fetch, loadCities, uuid = () => crypto.randomUUID()} = {}) {
  if (typeof getCurrent !== 'function' || typeof fetchImpl !== 'function' || typeof client?.request !== 'function') throw TypeError('AI 编排需要当前作品、本机请求和平台查询接口。');
  let generation = 0, active = null, latest = null, disposed = false;

  /** 每个异步边界校验作品与账号；同稿素材变化仍完成显式输入的建议，结果不会自动应用。 */
  function check(job) {
    if (job.staleError) throw job.staleError;
    if (job.signal.aborted) throw new DOMException('AI 建议已取消。', 'AbortError');
    if (disposed || generation !== job.generation || !sameBinding(job.binding, currentBinding(getCurrent))) {
      job.staleError = failure('AI_STALE_RESULT', '作品或账号已切换，本次 AI 结果未采用，请重新生成。');
      job.controller.abort();
      throw job.staleError;
    }
  }

  /** 新任务显式替换旧任务并传递用户取消；旧模型即使忽略取消也不能恢复结果。 */
  function begin(binding, signal, onProgress) {
    if (disposed) throw failure('AI_DISPOSED', 'AI 建议已关闭，请重新打开。');
    active?.controller.abort();
    const controller = new AbortController();
    const job = {generation: ++generation, binding, controller, signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal, onProgress};
    active = job;
    check(job);
    return job;
  }

  /** 进度仅用于展示，不携带图片、账号凭据或未核验的发布身份。 */
  function progress(job, phase, message) { check(job); job.onProgress?.({phase, message}); check(job); }

  /** 本机 AI 请求不重试；取消、错误业务码或格式错误由对应阶段独立处理。 */
  async function ask(baseURL, body, job) {
    check(job);
    const response = await fetchImpl(baseURL + '/ai/publish-assist', {method: 'POST', credentials: 'omit', redirect: 'error', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.any([job.signal, AbortSignal.timeout(185000)])});
    check(job);
    const payload = await response.json();
    check(job);
    if (!response.ok || payload?.code !== 0) throw failure(payload?.code || 'AI_REQUEST_FAILED', publicMessage(payload, 'AI 建议暂未完成，请重试。'));
    return payload.data;
  }

  /** 默认城市表来自当前插件包；不请求定位权限，也不向模型发送行政代码让其猜测。 */
  async function cities(job) {
    const values = loadCities ? await loadCities({signal: job.signal}) : await (async () => {
      const response = await fetchImpl(new URL('./cities.json', import.meta.url), {signal: job.signal});
      if (!response.ok) throw failure('AI_CITY_UNAVAILABLE', '城市列表读取失败，请重试地点匹配。');
      return response.json();
    })();
    check(job);
    return values;
  }

  /** 单项偏好只影响对应任务；共同背景和图片仍由当前作品提供。 */
  function analysisPrompt(input) {
    const music = input.resourcePrompts.music;
    return [input.prompt, music && `音乐推荐的单独要求（仅影响音乐线索，优先于共同要求）：\n${music}`].filter(Boolean).join('\n\n');
  }

  /** 分析仍使用已有结构契约；单项重做只提取所需结果，不覆盖其他建议。 */
  async function analyze(input, job) {
    const prompt = analysisPrompt(input);
    if (prompt.length > 8000) throw failure('AI_INVALID_REQUEST', '创作要求与音乐提示词合计过长，请精简后重试。');
    return analyzeResult(await ask(input.baseURL, {phase: 'analyze', prompt, context: input.context, assetIds: input.assetIds}, job), input.dateTag);
  }

  /** 只发送共同背景、文案及已抽取的线索，不把资源 URL 或会话信息交给模型。 */
  function matchingContext(input, analysis) {
    const context = `作品背景：\n${input.context}\n本次作品分析：\n${JSON.stringify(analysis)}`;
    if (context.length > 16000) throw failure('AI_CONTEXT_TOO_LONG', '作品信息过长，请精简背景后重新匹配资源。');
    return context;
  }

  /** 单个资源失败不丢其他建议；states 区分查询失败与成功但没有适合的候选。 */
  async function resources(input, analysis, job, scopes = ['location', 'music'], previous = {}) {
    const warnings = [], states = {}, candidates = {locations: [], music: []};
    const values = Object.fromEntries(scopes.map(scope => [scope, null]));
    const warn = (scope, code, message, state = 'error') => {
      for (const key of scope === 'resources' ? scopes : [scope]) {
        states[key] = state; warnings.push({scope: key, code, message});
      }
    };
    if (input.kind !== 'image') {
      warn('resources', 'AI_RESOURCES_UNSUPPORTED', '视频配乐和地点发布尚未接入，已保留文案与搜索线索。');
      return {...values, states, warnings};
    }
    if (!job.binding.accountId) {
      warn('resources', 'AI_ACCOUNT_REQUIRED', '请先选择已保存的抖音账号，再重试资源推荐；当前文案已保留。');
      return {...values, states, warnings};
    }
    progress(job, 'resources', '正在查询真实资源候选…');
    await Promise.all([
      (async () => {
        if (!scopes.includes('location')) return;
        if (!analysis.location) { warn('location', 'AI_LOCATION_UNCERTAIN', '没有足够的地点线索，可手动选择位置。', 'empty'); return; }
        try {
          const city = resolveCity(await cities(job), analysis.location.cityName);
          if (!city) { warn('location', 'AI_CITY_UNCERTAIN', '无法唯一确认建议中的城市，请先手动确认城市。', 'empty'); return; }
          check(job);
          const page = await client.request('locations.search', {kind: 'image', query: analysis.location.query, cityCode: city.code, cityName: city.name}, {signal: job.signal});
          check(job); candidates.locations = locationCandidates(page, city);
          if (!candidates.locations.length) warn('location', 'AI_LOCATION_EMPTY', '未找到可用的真实地点候选，可手动选择。', 'empty');
        } catch (error) { check(job); warn('location', 'AI_LOCATION_QUERY_FAILED', publicMessage(error, '地点查询未完成，请重试。')); }
      })(),
      (async () => {
        if (!scopes.includes('music')) return;
        const seen = new Set();
        for (const query of analysis.music.queries.length ? analysis.music.queries : ['']) {
          try {
            check(job);
            const page = await client.request('music.search', {kind: 'image', query}, {signal: job.signal});
            check(job);
            for (const candidate of musicCandidates(page)) if (!seen.has(candidate.id) && candidates.music.length < CANDIDATE_LIMIT) { seen.add(candidate.id); candidates.music.push(candidate); }
          } catch (error) {
            check(job); warn('music', 'AI_MUSIC_QUERY_FAILED', publicMessage(error, '音乐查询未完成，请重试。'));
            if (['SESSION_EXPIRED', 'ACCOUNT_CHANGED', 'SESSION_CHANGED', 'SESSION_IDENTITY_MISMATCH'].includes(error.code)) break;
          }
          if (candidates.music.length >= CANDIDATE_LIMIT) break;
        }
        if (!candidates.music.length && !warnings.some(item => item.scope === 'music')) warn('music', 'AI_MUSIC_EMPTY', '未找到可用的真实音乐候选，可手动搜索。', 'empty');
      })(),
    ]);
    check(job);
    if (!candidates.locations.length && !candidates.music.length) return {...values, states, warnings};
    for (const [scope, key] of [['location', 'locations'], ['music', 'music']]) {
      if (previous[scope] && candidates[key].some(item => item.id !== previous[scope].id)) candidates[key] = candidates[key].filter(item => item.id !== previous[scope].id);
    }
    progress(job, 'match', '正在从真实候选中选择建议…');
    try {
      let context = matchingContext(input, analysis);
      if (scopes.includes('music') && input.resourcePrompts.music) context += `\n音乐单独要求（优先）：\n${input.resourcePrompts.music}`;
      if (context.length > 16000) throw failure('AI_CONTEXT_TOO_LONG', '作品信息和音乐要求过长，请精简后重试。');
      const result = await ask(input.baseURL, {phase: 'match', context, candidates: {locations: candidates.locations,
        music: candidates.music.map(({id, name, author, duration}) => ({id, name, author, duration}))}}, job);
      // 未请求的种类不会读取或修改；请求的种类仍严格匹配本轮真实候选。
      for (const [scope, key] of [['location', 'locations'], ['music', 'music']]) {
        if (!scopes.includes(scope) || !candidates[key].length) continue;
        values[scope] = matchedItem(result?.[scope], candidates[key]);
        states[scope] = values[scope] ? 'ready' : 'empty';
        if (!values[scope]) warn(scope, scope === 'music' ? 'AI_MUSIC_UNMATCHED' : 'AI_LOCATION_UNMATCHED', scope === 'music' ? '现有候选中没有合适的背景音乐，可手动试听选择。' : '现有地点候选不足以确认拍摄位置，请手动核对。', 'empty');
      }
      return {...values, states, warnings};
    } catch (error) {
      check(job); warn('resources', 'AI_MATCH_FAILED', publicMessage(error, '资源匹配未完成，其他建议已保留，请重试。'));
      return {...Object.fromEntries(scopes.map(scope => [scope, null])), states, warnings};
    }
  }

  /** 活动和热点只从平台实际列表中挑选，空结果表示明确建议不关联。 */
  async function selectResource(input, analysis, job, scope, previous) {
    const fail = error => ({[scope]: null, states: {[scope]: 'error'}, warnings: [{scope, code: error.code || 'AI_RESOURCE_FAILED', message: publicMessage(error, `${scope === 'activity' ? '活动' : '热点'}推荐未完成，请重试。`)}]});
    if (!job.binding.accountId) return fail(failure('AI_ACCOUNT_REQUIRED', '请先选择已保存的抖音账号，再重试资源推荐。'));
    try {
      check(job);
      const page = await client.request(scope === 'activity' ? 'activities.list' : 'hotspots.search',
        scope === 'activity' ? {kind: input.kind} : {kind: input.kind, draftId: job.binding.draftId, query: ''}, {signal: job.signal});
      check(job);
      if (!Array.isArray(page?.items)) throw failure('AI_RESOURCE_FAILED', '平台候选列表读取失败，请重试。');
      const seen = new Set();
      let candidates = [];
      for (const item of page.items) {
        if (typeof item?.name !== 'string' || !item.name.trim() || item.name.length > 500) continue;
        if (scope === 'activity' && (item.disabled || typeof item.id !== 'string' || !PLATFORM_ID.test(item.id))) continue;
        const key = scope === 'activity' ? item.id : item.name;
        if (seen.has(key)) continue;
        seen.add(key);
        // 热点只有真实词语，没有平台 ID；索引仅供本轮模型选择，绝不作为发布身份。
        candidates.push(scope === 'activity'
          ? {id: item.id, name: item.name, description: [item.topicName && `关联话题：${item.topicName}`, item.description].filter(Boolean).join('；').slice(0, 1000)}
          : {id: `hotspot-${candidates.length}`, name: item.name, ...(Number.isFinite(item.heat) ? {heat: item.heat} : {})});
        if (candidates.length >= 100) break;
      }
      if (previous && candidates.some(item => item.name !== previous.name)) candidates = candidates.filter(item => item.name !== previous.name);
      if (!candidates.length) return {[scope]: null, states: {[scope]: 'empty'}, warnings: []};
      const instruction = scope === 'activity'
        ? '根据作品内容判断是否参加官方活动，只选择主题直接相关的活动；没有合适活动时返回 null，不为参加活动牵强改写作品。'
        : '根据作品内容判断是否关联当前热点，只选择有明确内容关联的热点；没有合适热点时返回 null，不为热度强行关联。';
      const custom = scope === 'hotspot' ? input.resourcePrompts.hotspot : '';
      const prompt = [instruction, custom && `用户为本项单独定制的要求（与共同偏好冲突时以此为准）：\n${custom}`].filter(Boolean).join('\n');
      if (prompt.length > 8000) throw failure('AI_INVALID_REQUEST', '本项提示词过长，请精简后重试。');
      const selected = await ask(input.baseURL, {phase: 'select', context: matchingContext(input, analysis), prompt,
        options: candidates.map(({id, name, description}) => ({id, name, ...(description ? {description} : {})}))}, job);
      const choice = matchedItem(selected?.choice, candidates);
      if (!choice) return {[scope]: null, states: {[scope]: 'empty'}, warnings: []};
      if (scope === 'hotspot') return {hotspot: choice, states: {hotspot: 'ready'}, warnings: []};
      const resolved = await client.request('activities.resolve', {id: choice.id}, {signal: job.signal});
      check(job);
      if (resolved?.id !== choice.id || resolved.disabled || typeof resolved.name !== 'string' || !resolved.name.trim() ||
          typeof resolved.topic?.id !== 'string' || !PLATFORM_ID.test(resolved.topic.id) || typeof resolved.topic.name !== 'string' ||
          !resolved.topic.name.trim() || resolved.topic.name.length > 200 || /[#\r\n]/u.test(resolved.topic.name)) throw failure('AI_ACTIVITY_UNAVAILABLE', '活动话题无法确认，请重新推荐或手动选择。');
      return {activity: {id: resolved.id, name: resolved.name, topic: {id: resolved.topic.id, name: resolved.topic.name}, reason: choice.reason}, states: {activity: 'ready'}, warnings: []};
    } catch (error) { check(job); return fail(error); }
  }

  /** 四项资源并行读取；本机账号错误留在对应项，其他已成功建议仍可采用。 */
  async function recommend(input, analysis, job, scopes = ['activity', 'music', 'location', 'hotspot'], previous = {}) {
    const tasks = [], basic = scopes.filter(scope => ['music', 'location'].includes(scope));
    if (basic.length) tasks.push(resources(input, analysis, job, basic, previous));
    for (const scope of ['activity', 'hotspot']) if (scopes.includes(scope)) tasks.push(selectResource(input, analysis, job, scope, previous[scope]));
    const results = await Promise.all(tasks);
    check(job);
    const merged = {states: {}, warnings: []};
    for (const value of results) {
      const {states, warnings, ...items} = value;
      Object.assign(merged, items); Object.assign(merged.states, states); merged.warnings.push(...warnings);
    }
    return merged;
  }

  /** 完成后只返回可检查建议；应用必须由界面显式决定，并先调用 isCurrent。 */
  function finish(input, analysis, matched, job, updatedScopes = ['music', 'activity'], analysisRevision = job.binding.revision) {
    check(job);
    const result = {...matched, id: uuid(), binding: {...job.binding}, title: analysis.title, description: analysis.description, topics: structuredClone(analysis.topics), analysis: structuredClone(analysis), states: {copy: 'ready', ...matched.states}};
    // 只更新本次实际生成的账号相关项；换一项不能顺带使另一项的旧账号候选重新有效。
    const scopeBindings = {...latest?.scopeBindings};
    for (const scope of updatedScopes) if (['music', 'activity'].includes(scope)) scopeBindings[scope] = {...job.binding};
    // 单项重试沿用最初分析素材的版本，不能把未重做的其他建议标成已匹配新素材。
    latest = {result, input, analysis, analysisRevision, binding: {...job.binding}, scopeBindings, generation: job.generation};
    return result;
  }

  return {
    /** 分析仅发送用户显式选择的最多六个素材 ID；资源偏好不改写共同作品背景。 */
    async generate(input, {signal, onProgress} = {}) {
      const request = {baseURL: localBaseURL(input?.baseURL), prompt: typeof input?.prompt === 'string' ? input.prompt.trim() : '', context: typeof input?.context === 'string' ? input.context.trim() : '', assetIds: input?.assetIds ?? [], kind: input?.kind ?? 'image', dateTag: input?.dateTag ?? '',
        resourcePrompts: {music: typeof input?.resourcePrompts?.music === 'string' ? input.resourcePrompts.music.trim() : '', hotspot: typeof input?.resourcePrompts?.hotspot === 'string' ? input.resourcePrompts.hotspot.trim() : ''}};
      if (request.prompt.length > 8000 || Object.values(request.resourcePrompts).some(value => value.length > 7800) || request.context.length > 12000 || !['image', 'video'].includes(request.kind) || (typeof request.dateTag !== 'string' || request.dateTag !== '' && (!/^#\d{8}$/.test(request.dateTag) || dateTag(request.dateTag) !== request.dateTag)) || !Array.isArray(request.assetIds) || request.assetIds.length > 6 || request.assetIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 128) || new Set(request.assetIds).size !== request.assetIds.length || (!request.assetIds.length && !request.context)) throw failure('AI_INVALID_REQUEST', '请提供作品信息或勾选最多六张图片，并检查提示词与输入长度。');
      request.assetIds = [...request.assetIds];
      const job = begin(currentBinding(getCurrent), signal, onProgress);
      try {
        progress(job, 'analyze', request.assetIds.length ? `正在分析所选 ${request.assetIds.length} 张图片和作品信息…` : '正在分析当前文字信息…');
        const analysis = await analyze(request, job);
        return finish(request, analysis, await recommend(request, analysis, job), job);
      } finally { if (active === job) active = null; }
    },
    /** 只重试失败或账号来源已变化的资源；公共地点和热点建议不因换号重复生成。 */
    async retryResources(result, {signal, onProgress} = {}) {
      const record = latest, binding = currentBinding(getCurrent);
      if (!record || record.result !== result || !sameBinding(record.binding, binding, false)) throw failure('AI_STALE_RESULT', '建议已更新或所属作品已切换，请使用当前作品的 AI 建议。');
      const scopes = ['activity', 'music', 'location', 'hotspot'].filter(scope => !this.isCurrent(result, scope) || result.states[scope] === 'error');
      if (!scopes.length) return result;
      const job = begin(binding, signal, onProgress);
      try {
        const retried = await recommend(record.input, record.analysis, job, scopes);
        const matched = {...result, ...retried, states: {...result.states, ...retried.states}, warnings: [...result.warnings.filter(item => !scopes.includes(item.scope) && item.scope !== 'resources'), ...retried.warnings]};
        return finish(record.input, record.analysis, matched, job, scopes, record.analysisRevision);
      } finally { if (active === job) active = null; }
    },
    /** 用户明确重做一项时不触碰其他建议；单独提示词留空即恢复共同要求。 */
    async regenerate(result, scope, {signal, onProgress, prompt} = {}) {
      const record = latest, binding = currentBinding(getCurrent);
      if (!['copy', 'activity', 'music', 'location', 'hotspot'].includes(scope)) throw failure('AI_INVALID_REQUEST', '请选择要重新生成的建议。');
      if (!record || record.result !== result || !sameBinding(record.binding, binding, false)) throw failure('AI_STALE_RESULT', '建议已更新或所属作品已切换，请使用当前作品的 AI 建议。');
      const input = {...record.input, resourcePrompts: {...record.input.resourcePrompts}};
      if (prompt !== undefined) {
        if (!['music', 'hotspot'].includes(scope) || typeof prompt !== 'string' || prompt.length > 7800) throw failure('AI_INVALID_REQUEST', '单项提示词格式或长度不正确，请调整后重试。');
        input.resourcePrompts[scope] = prompt.trim();
      }
      const job = begin(binding, signal, onProgress);
      try {
        let analysis = record.analysis, update;
        if (scope === 'copy' || scope === 'music') {
          progress(job, scope, scope === 'copy' ? '正在重新生成作品描述…' : '正在按音乐要求重新推荐…');
          const generated = await analyze(input, job);
          analysis = scope === 'copy' ? {...analysis, title: generated.title, description: generated.description, topics: generated.topics} : {...analysis, music: generated.music};
        }
        if (scope === 'copy') update = {title: analysis.title, description: analysis.description, topics: structuredClone(analysis.topics), states: {copy: 'ready'}, warnings: []};
        else update = await recommend(input, analysis, job, [scope], result);
        const merged = {...result, ...update, states: {...result.states, ...update.states}, warnings: [...result.warnings.filter(item => item.scope !== scope && item.scope !== 'resources'), ...update.warnings]};
        return finish(input, analysis, merged, job, [scope], record.analysisRevision);
      } finally { if (active === job) active = null; }
    },
    /** 编辑建议文案只更新当前结果，保留对象身份和其他资源；允许用户明确清空。 */
    editCopy(result, {title, description} = {}) {
      if (!this.isCurrent(result)) throw failure('AI_STALE_RESULT', '建议已更新或所属作品已切换，请使用当前作品的 AI 建议。');
      if (typeof title !== 'string' || title.length > 20 || typeof description !== 'string' || description.length > 1000) throw failure('AI_INVALID_REQUEST', '标题最多 20 字，作品描述最多 1000 字。');
      result.title = title; result.description = description;
      latest.analysis = {...latest.analysis, title, description};
      result.analysis = structuredClone(latest.analysis);
      return result;
    },
    /** 同稿建议不因素材变化失效；音乐来源与活动资格仍按各自生成时的账号检查。 */
    isCurrent(result, scope) {
      try {
        const binding = currentBinding(getCurrent);
        return !disposed && !!latest && latest.result === result && sameBinding(latest.binding, binding, false) &&
          (!['music', 'activity'].includes(scope) || !!latest.scopeBindings[scope] && sameBinding(latest.scopeBindings[scope], binding));
      } catch { return false; }
    },
    /** 原分析的素材版本仅用作提醒，不限制编辑、单项重试或显式应用。 */
    hasMediaChanges(result) {
      try { return this.isCurrent(result) && latest.analysisRevision !== currentBinding(getCurrent).revision; }
      catch { return false; }
    },
    /** 关闭面板只终止在途读取，已完成建议可在同一作品中继续查看。 */
    cancelPending() { generation++; active?.controller.abort(); active = null; },
    /** 切换作品或明确清除分析时撤销候选；迟到回执不能重新激活结果。 */
    cancel() { generation++; active?.controller.abort(); active = null; latest = null; },
    /** 释放该编辑器的所有在途读取和结果引用，不操作平台会话或本机作品。 */
    dispose() { this.cancel(); disposed = true; },
  };
}
