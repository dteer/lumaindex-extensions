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

/** 检查同一作品编辑版本；明确重试资源时可重新绑定刚登录的账号，旧在途结果始终检查账号。 */
function sameBinding(left, right, includeAccount = true) {
  return left.draftId === right.draftId && left.revision === right.revision && (!includeAccount || left.accountId === right.accountId && left.profileId === right.profileId);
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

  /** 每个异步边界都校验账号与编辑版本；取消只停止本次读取，不修改已有草稿。 */
  function check(job) {
    if (job.staleError) throw job.staleError;
    if (job.signal.aborted) throw new DOMException('AI 建议已取消。', 'AbortError');
    if (disposed || generation !== job.generation || !sameBinding(job.binding, currentBinding(getCurrent))) {
      job.staleError = failure('AI_STALE_RESULT', '作品内容或账号已变化，本次 AI 结果未采用，请重新生成。');
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

  /** 单个资源失败不丢已经生成的文案；只有同草稿同账号的资源结果可进入本次匹配。 */
  async function resources(input, analysis, job) {
    const warnings = [], candidates = {locations: [], music: []};
    const warn = (scope, code, message) => warnings.push({scope, code, message});
    if (input.kind !== 'image') {
      warn('resources', 'AI_RESOURCES_UNSUPPORTED', '视频配乐和地点发布尚未接入，已保留文案与搜索线索。');
      return {location: null, music: null, warnings};
    }
    if (!job.binding.accountId) {
      warn('resources', 'AI_ACCOUNT_REQUIRED', '请先选择已保存的抖音账号，再重试地点和音乐匹配；当前文案已保留。');
      return {location: null, music: null, warnings};
    }
    progress(job, 'resources', '正在查询抖音真实地点和音乐候选…');
    // 两类只读查询相互独立；局部失败保留另一类结果，不重发已经成功的 AI 分析。
    await Promise.all([
      (async () => {
        if (!analysis.location) { warn('location', 'AI_LOCATION_UNCERTAIN', '没有足够的地点线索，可手动选择位置。'); return; }
        try {
          const city = resolveCity(await cities(job), analysis.location.cityName);
          if (!city) { warn('location', 'AI_CITY_UNCERTAIN', '无法唯一确认建议中的城市，请先手动确认城市。'); return; }
          check(job);
          const page = await client.request('locations.search', {kind: 'image', query: analysis.location.query, cityCode: city.code, cityName: city.name}, {signal: job.signal});
          check(job); candidates.locations = locationCandidates(page, city);
          if (!candidates.locations.length) warn('location', 'AI_LOCATION_EMPTY', '未找到可用的真实地点候选，可调整地点关键词后手动选择。');
        } catch (error) { check(job); warn('location', 'AI_LOCATION_QUERY_FAILED', publicMessage(error, '地点查询未完成，可仅重试资源匹配。')); }
      })(),
      (async () => {
        const seen = new Set();
        for (const query of analysis.music.queries.length ? analysis.music.queries : ['']) {
          try {
            check(job);
            const page = await client.request('music.search', {kind: 'image', query}, {signal: job.signal});
            check(job);
            for (const candidate of musicCandidates(page)) if (!seen.has(candidate.id) && candidates.music.length < CANDIDATE_LIMIT) { seen.add(candidate.id); candidates.music.push(candidate); }
          } catch (error) {
            check(job); warn('music', 'AI_MUSIC_QUERY_FAILED', publicMessage(error, '音乐查询未完成，可仅重试资源匹配。'));
            // 账号问题交给用户处理，不再用下一个关键词重复请求；此前成功的候选和文案仍保留。
            if (['SESSION_EXPIRED', 'ACCOUNT_CHANGED', 'SESSION_CHANGED', 'SESSION_IDENTITY_MISMATCH'].includes(error.code)) break;
          }
          if (candidates.music.length >= CANDIDATE_LIMIT) break;
        }
        if (!candidates.music.length && !warnings.some(item => item.scope === 'music')) warn('music', 'AI_MUSIC_EMPTY', '未找到可用的真实音乐候选，可手动搜索音乐。');
      })(),
    ]);
    check(job);
    if (!candidates.locations.length && !candidates.music.length) return {location: null, music: null, warnings};
    progress(job, 'match', '正在从真实候选中选择地点和背景音乐…');
    try {
      const context = `作品背景：\n${input.context}\n本次作品分析：\n${JSON.stringify(analysis)}`;
      if (context.length > 16000) throw failure('AI_CONTEXT_TOO_LONG', '作品信息过长，已保留文案；请精简背景后重新匹配资源。');
      // 模型只收到候选白名单，不接收播放地址、封面 URL 或任何上传/会话凭据。
      const result = await ask(input.baseURL, {phase: 'match', context, candidates: {locations: candidates.locations,
        music: candidates.music.map(({id, name, author, duration}) => ({id, name, author, duration}))}}, job);
      const location = matchedItem(result?.location, candidates.locations), music = matchedItem(result?.music, candidates.music);
      if (!location && candidates.locations.length) warn('location', 'AI_LOCATION_UNMATCHED', '现有地点候选不足以确认拍摄位置，请手动核对。');
      if (!music && candidates.music.length) warn('music', 'AI_MUSIC_UNMATCHED', '现有候选中没有明确合适的背景音乐，可手动试听选择。');
      return {location, music, warnings};
    } catch (error) {
      check(job); warn('resources', 'AI_MATCH_FAILED', publicMessage(error, '资源匹配未完成，文案已保留，可仅重试资源匹配。'));
      return {location: null, music: null, warnings};
    }
  }

  /** 完成后只返回可检查建议；应用必须由界面显式决定，并先调用 isCurrent。 */
  function finish(input, analysis, matched, job) {
    check(job);
    const result = {id: uuid(), binding: {...job.binding}, title: analysis.title, description: analysis.description, topics: structuredClone(analysis.topics), analysis: structuredClone(analysis), ...matched};
    latest = {result, input, analysis, binding: {...job.binding}, generation: job.generation};
    return result;
  }

  return {
    /** 分析仅发送用户显式选择的最多六个素材 ID，模型取图和提示词规则由本机服务管理。 */
    async generate(input, {signal, onProgress} = {}) {
      const request = {baseURL: localBaseURL(input?.baseURL), prompt: typeof input?.prompt === 'string' ? input.prompt.trim() : '', context: typeof input?.context === 'string' ? input.context.trim() : '', assetIds: input?.assetIds ?? [], kind: input?.kind ?? 'image', dateTag: input?.dateTag ?? ''};
      if (request.prompt.length > 8000 || request.context.length > 12000 || !['image', 'video'].includes(request.kind) || (typeof request.dateTag !== 'string' || request.dateTag !== '' && (!/^#\d{8}$/.test(request.dateTag) || dateTag(request.dateTag) !== request.dateTag)) || !Array.isArray(request.assetIds) || request.assetIds.length > 6 || request.assetIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 128) || new Set(request.assetIds).size !== request.assetIds.length || (!request.assetIds.length && !request.context)) throw failure('AI_INVALID_REQUEST', '请提供作品信息或勾选最多六张图片，并检查提示词与输入长度。');
      request.assetIds = [...request.assetIds];
      const job = begin(currentBinding(getCurrent), signal, onProgress);
      try {
        progress(job, 'analyze', request.assetIds.length ? `正在分析所选 ${request.assetIds.length} 张图片和作品信息…` : '正在分析当前文字信息…');
        const raw = await ask(request.baseURL, {phase: 'analyze', prompt: request.prompt, context: request.context, assetIds: request.assetIds}, job);
        const analysis = analyzeResult(raw, request.dateTag);
        return finish(request, analysis, await resources(request, analysis, job), job);
      } finally { if (active === job) active = null; }
    },
    /** 仅重做资源查询与匹配；保留原文案，明确重试允许同一作品重新绑定新登录账号。 */
    async retryResources(result, {signal, onProgress} = {}) {
      const record = latest, binding = currentBinding(getCurrent);
      if (!record || record.result !== result || record.generation !== generation || !sameBinding(record.binding, binding, false)) throw failure('AI_STALE_RESULT', '作品内容已变化，请重新生成 AI 建议。');
      const job = begin(binding, signal, onProgress);
      try { return finish(record.input, record.analysis, await resources(record.input, record.analysis, job), job); }
      finally { if (active === job) active = null; }
    },
    /** 只有当前任务生成且内容/账号均未变化的结果可供界面应用，不自动覆盖任何手动选择。 */
    isCurrent(result) {
      try { return !disposed && !!latest && latest.result === result && latest.generation === generation && sameBinding(latest.binding, currentBinding(getCurrent)); } catch { return false; }
    },
    /** 关闭或取消时撤销候选应用资格；忽略取消的模型或平台回执也不能重新激活结果。 */
    cancel() { generation++; active?.controller.abort(); active = null; latest = null; },
    /** 释放该编辑器的所有在途读取和结果引用，不操作平台会话或本机作品。 */
    dispose() { this.cancel(); disposed = true; },
  };
}
