import {createPublicationStore} from './publication-store.js';
import {createCreatorAPI} from './creator-api.js';
import {resolveAssets, prepareFile} from './media.js';
import {importImages} from './import-images.js';
import {importVideo} from './import-video.js';
import {uploadImage} from './image-upload.js';
import {uploadVideo} from './video-upload.js';
import {cropCoverFile} from './crop-file.js';
import {searchLocations, validateLocationQuery} from './location.js';
import {listCollections, validateCollectionQuery} from './collection.js';
import {validateStudioDraft, buildPublicationPayload} from './publication-payload.js';
import {throwIfCancelled, combineSignals, cancellableWait} from './cancellation.js';

const QUERY_OPERATIONS = ['topics.search', 'users.search', 'music.search', 'locations.search', 'collections.list', 'activities.list'];
const OPERATIONS = ['studio.session', 'declarations.list', 'hotspots.search', 'music.categories', 'music.resolve', 'music.select', 'activities.detail', 'activities.resolve', ...QUERY_OPERATIONS, 'cover.upload', 'publication.prepare', 'publication.publish', 'publication.status'];
const PLATFORM_ID = /^\d{1,30}$/;
const LOCAL_ID = /^[a-zA-Z0-9_-]{1,100}$/;
const MUSIC_CATEGORY_TTL = 5 * 60 * 1000;
const QUERY_PAGE_TTL = 15 * 1000;
const QUERY_PAGE_LIMIT = 64;
const MUSIC_RECORD_KEY = 'luma-studio-selected-music-v1';
const MUSIC_RECORD_LIMIT = 128;
// CHOICE_LOOKUP_PAGES 限制草稿恢复时的逐页核验，找不到精确身份时保留原选择并提示重新选择。
const CHOICE_LOOKUP_PAGES = 5;

// capabilities 只公布已接入的固定操作；视频的未验证选项不能因图文支持而被启用。
export function capabilities() {
  return {
    operations: [...OPERATIONS],
    limits: {imageCount: 35, titleLength: 20, descriptionLength: 1000, topicCount: 5, imageBytes: 50 * 1024 * 1024, videoBytes: 80 * 1024 * 1024, coverBytes: 50 * 1024 * 1024},
    options: {
      visibility: [{value: 'public', label: '公开'}, {value: 'friends', label: '好友可见'}, {value: 'private', label: '仅自己可见'}],
      download: [{value: 'allow', label: '允许保存'}, {value: 'deny', label: '不允许保存'}],
    },
    declarations: [],
    byKind: {video: {disabledOperations: ['music.search', 'music.categories', 'music.resolve', 'music.select', 'locations.search', 'collections.list']}},
  };
}

// publicError 仅向 App 返回简短中文错误，不泄露宿主内部诊断或平台原始响应。
function publicError(error) {
  const message = error?.message;
  return typeof message === 'string' && /[\u3400-\u9fff]/u.test(message) && message.length < 350 ? message : '操作暂未完成，请检查抖音页面与网络后重试。';
}

// checkedOrigin 固定本机 App 来源，禁止通过参数将素材读取转发到其他主机。
function checkedOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.origin === value) return value;
  } catch {}
  throw Error('当前 App 来源无效，请重新连接发布工作台。');
}

// createStudioEngine 注入宿主会话与上传边界便于离线验证；运行时只调用固定业务函数。
export function createStudioEngine({storage, send, sessionStatus, publicationStore, now = Date.now, uuid = () => crypto.randomUUID(), upload = {}, libraryAsset} = {}) {
  if (!storage?.get || !storage?.set || typeof send !== 'function') throw Error('App 会话和持久化接口尚未就绪。');
  const store = publicationStore || createPublicationStore({storage, now, uuid});
  const cache = new Map();
  const media = {resolveAssets, prepareFile, importImages, importVideo, uploadImage, uploadVideo, cropCoverFile, ...upload};
  const accountTasks = new Set();
  const queryPages = new Map(); // 短期页面仅在内存保留，完整查询参数和账号档案共同隔离。
  const locationQueries = new Map(); // 地点 ID 对应的公共城市和查询线索；不保存账号资格或发布附加字段。
  const musicSources = new Map(); // 当前账号生命周期内保留已展示音源，翻页或停留不会使可见歌曲失去选择资格。
  let musicWrites = Promise.resolve();
  let generation = 0; // 明确换号后，旧异步结果不能重新填充候选缓存。

  // requireContext 同时约束取消和账号生命周期，阻止旧请求回写新账号的缓存。
  function requireContext(context) {
    throwIfCancelled(context?.signal);
    if (context?.generation !== generation) throw Object.assign(Error('抖音账号已变化，请重新检查会话。'), {code: 'SESSION_CHANGED'});
  }

  // fresh 按创建时间而非访问时间失效；系统时钟回拨也不能延长缓存生命。
  function fresh(createdAt, ttl) { const age = now() - createdAt; return Number.isFinite(age) && age >= 0 && age < ttl; }

  // nativeBinding 只核对本机档案归属；离线不删除身份，也不阻断已有回执和候选的本地读取。
  async function nativeBinding(context, {allowUnidentified = false} = {}) {
    if (!sessionStatus) return null;
    const status = await sessionStatus();
    requireContext(context);
    if (!status) throw Object.assign(Error('当前账号档案无法读取，请重新打开工作台。'), {code: 'SESSION_CHANGED'});
    if (context.profileId && status.activeProfileId !== context.profileId) throw Object.assign(Error('当前抖音账号已变化，请重新检查会话。'), {code: 'ACCOUNT_CHANGED'});
    if (allowUnidentified && !status.accountId) return null;
    if (typeof status.activeProfileId !== 'string' || !status.activeProfileId || !PLATFORM_ID.test(status.accountId || '')) throw Object.assign(Error('当前账号尚未核验，请先检查会话。'), {code: 'SESSION_CHANGED'});
    return {key: JSON.stringify([context.origin, status.activeProfileId, status.accountId]), accountId: status.accountId, name: typeof status.name === 'string' ? status.name : ''};
  }

  // sameAccount 拒绝把另一真实账号的查询或准备结果当作界面当前账号的结果。
  function sameAccount(account, expected) {
    if (expected && account.id !== expected) throw Object.assign(Error('抖音账号已变化，请重新连接并准备当前账号的作品。'), {code: 'ACCOUNT_CHANGED'});
  }

  // creator 由宿主发送固定 HTTPS 请求，业务参数由插件编排，浏览器执行与登录相同环境的 fetch。
  async function creator(operation, params = {}, context) {
    requireContext(context);
    const result = await createCreatorAPI(context?.send || send)(operation, params);
    // 已提交的明确回执必须保存；迟到的页面状态变化不能把成功改写成 unknown。
    if (operation !== 'publication.publish') requireContext(context);
    if (result?.ok !== true) throw Object.assign(Error(publicError({message: result?.error})), {definiteFailure: result?.definiteFailure === true, ...(result?.code ? {code: result.code} : {})});
    return result;
  }

  // currentAccount 始终读取平台当前身份，不用宿主连接或旧缓存推定已登录。
  async function currentAccount(context) {
    const account = (await creator('account', {}, context)).data;
    if (!account || !PLATFORM_ID.test(account.id) || typeof account.name !== 'string' || !account.name) throw Error('无法确认当前抖音账号，请重新登录抖音后重试。');
    return account;
  }

  // session 对普通操作只使用明确的本机账号；登录核验和准备入口才读取平台真实身份。
  async function session(context, {verifyRemote = false, allowUnidentified = false} = {}) {
    const binding = await nativeBinding(context, {allowUnidentified});
    if (binding) sameAccount({id: binding.accountId}, context.expectedAccountId);
    if (binding && !verifyRemote) return {...context, binding, account: {id: binding.accountId, name: binding.name}};
    // 未提供宿主会话元数据的调用仍需取得一次真实身份，不以传入账号字段冒充已登录。
    const account = await currentAccount(context);
    sameAccount(account, binding?.accountId);
    sameAccount(account, context.expectedAccountId);
    return {...context, binding, account};
  }

  // verifyReadSession 只复查本机档案；子请求失败由对应平台接口直接反馈，不额外查询账号。
  async function verifyReadSession(context) {
    requireContext(context);
    if (!context.binding) return;
    const current = await nativeBinding(context);
    sameAccount({id: current?.accountId}, context.account.id);
    if (current?.key !== context.binding.key) throw Object.assign(Error('抖音账号已变化，本次查询未采用，请重新检查会话。'), {code: 'SESSION_CHANGED'});
  }

  // exclusive 拒绝同账号并发上传或提交；心跳仅覆盖用户已发起任务。
  async function exclusive(accountId, action) {
    if (accountTasks.has(accountId)) throw Error('该账号正在准备或提交作品，请等待当前任务结束。');
    accountTasks.add(accountId);
    try { return await action(); }
    finally { accountTasks.delete(accountId); }
  }

  // cacheKey 将账号候选、封面与媒体检查点按插件、来源和账号隔离；公共地点线索单独保留。
  function cacheKey(type, origin, accountId, id) { return `studio-${type}:${encodeURIComponent(origin)}:${accountId}:${encodeURIComponent(id)}`; }
  async function readCache(key) { return key.startsWith('studio-uploads:') || key.startsWith('studio-cover:') ? (await storage.get(key))[key] : cache.get(key); }
  async function writeCache(key, value) {
    if (key.startsWith('studio-uploads:') || key.startsWith('studio-cover:')) await storage.set({[key]: value});
    else cache.set(key, structuredClone(value));
  }

  // queryParams 只保留已支持的查询输入，不接收任意 URL、字段集合或协议参数。
  function queryParams(operation, input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('查询参数无效。');
    const query = input.query ?? '', cursor = input.cursor ?? '0', kind = input.kind ?? 'image';
    if (typeof query !== 'string' || query.length > 500 || typeof cursor !== 'string' || !/^\d{1,30}$/.test(cursor) || !['image', 'video'].includes(kind)) throw Error('查询文字、分页位置或作品类型无效。');
    if (kind === 'video' && ['music.search', 'locations.search', 'collections.list'].includes(operation)) throw Error('视频的配乐、地点和合集发布参数尚未验证，请先不添加这些选项。');
    const result = {query: query.trim(), cursor, kind};
    if (operation === 'music.search' && !result.query && (input.categoryId !== undefined || input.type !== undefined)) {
      if (typeof input.categoryId !== 'string' || !PLATFORM_ID.test(input.categoryId) || !['recommend', 'rank', 'fav', 'category'].includes(input.type)) throw Error('请选择平台返回的有效音乐分类。');
      result.categoryId = input.categoryId; result.type = input.type;
    }
    if (operation === 'topics.search' && input.draftId !== undefined) {
      if (typeof input.draftId !== 'string' || !LOCAL_ID.test(input.draftId)) throw Error('推荐话题的作品身份无效。');
      result.draftId = input.draftId;
    }
    if (operation === 'locations.search') {
      Object.assign(result, {cityCode: input.cityCode, cityName: input.cityName});
      validateLocationQuery({cityCode: result.cityCode, cityName: result.cityName, keyword: result.query, page: cursor === '0' ? 1 : Number(cursor)});
    }
    return result;
  }

  // 空输入每次读取平台当前热点；已有图文上传快照可附带推荐线索，未上传也可获取全部热点。
  async function hotspots(params, context, origin) {
    if (!params || typeof params !== 'object' || Array.isArray(params) || typeof (params.query ?? '') !== 'string' || (params.query ?? '').length > 500 || !['image', 'video'].includes(params.kind ?? 'image') || params.draftId !== undefined && (typeof params.draftId !== 'string' || !LOCAL_ID.test(params.draftId))) throw Error('热点查询参数无效。');
    const query = (params.query ?? '').trim();
    let result;
    if (query) result = (await creator('hotspots.search', {query}, context)).data;
    else {
      const saved = params.kind !== 'video' && params.draftId ? await readCache(cacheKey('uploads', origin, context.account.id, params.draftId)) : null;
      const frames = Array.isArray(saved?.recommendationFrames) ? saved.recommendationFrames : [];
      result = (await creator('hotspots.recommend', {frames: frames.join(',')}, context)).data;
    }
    await verifyReadSession(context);
    return result;
  }

  // musicCategories 返回账号当前可用的真实目录；五分钟缓存按宿主档案、账号及到期时间隔离。
  async function musicCategories(params, context, origin) {
    if ((params.kind ?? 'image') !== 'image') throw Error('视频配乐尚未接入，请在图文作品中选择音乐。');
    const key = cacheKey('music-categories', origin, context.account.id, context.binding?.key || 'current');
    const previous = context.readOnly ? await readCache(key) : null;
    if (previous && fresh(previous.createdAt, MUSIC_CATEGORY_TTL)) return {items: structuredClone(previous.items)};
    const result = (await creator('music.categories', {}, context)).data;
    await verifyReadSession(context);
    requireContext(context);
    if (context.readOnly) await writeCache(key, {items: result.items, createdAt: now()});
    return structuredClone(result);
  }

  // fetchCandidates 读取真实列表；推荐、关键词和链接始终使用平台返回的身份。
  async function fetchCandidates(operation, params, context, origin, musicCatalog) {
    const {account} = context;
    let data;
    if (operation === 'topics.search' && !params.query) {
      const saved = params.draftId ? await readCache(cacheKey('uploads', origin, account.id, params.draftId)) : null;
      // 只使用最近一次完整素材清单的资源顺序；检查点中已移除的旧图片不得混入本作品推荐。
      const frames = Array.isArray(saved?.recommendationFrames) ? saved.recommendationFrames : [];
      data = frames.length ? (await creator('topics.recommend', {frames: frames.join(',')}, context)).data
        : {items: [], nextCursor: null, message: '上传图片后可获取本作品的推荐话题。'};
    } else if (operation === 'locations.search') {
      const page = params.cursor === '0' ? 1 : Number(params.cursor);
      const request = validateLocationQuery({cityCode: params.cityCode, cityName: params.cityName, keyword: params.query, page});
      const response = await searchLocations(request, context.send);
      if (!response.ok) throw Object.assign(Error(response.error || '地点查询未完成。'), response.code ? {code: response.code} : {});
      const result = response.data;
      data = {items: result.items.map(item => ({...item, description: item.address || '', cityCode: params.cityCode, cityName: params.cityName})), nextCursor: Number.isInteger(result.nextPage) && result.nextPage > page ? String(result.nextPage) : null};
    } else if (operation === 'collections.list') {
      const response = await listCollections(validateCollectionQuery({kind: params.kind, cursor: params.cursor}), context.send);
      if (!response.ok) throw Object.assign(Error(response.error || '合集查询未完成。'), response.code ? {code: response.code} : {});
      const result = response.data;
      data = {items: result.items.filter(item => !params.query || item.title.includes(params.query)).map(item => ({id: item.id, name: item.title,
        order: item.order, itemCount: item.itemCount, thumbnailURL: item.thumbnailURL, description: `共 ${item.itemCount} 个作品`})), nextCursor: result.nextCursor};
    } else if (operation === 'music.search') {
      if (params.query) {
        let url;
        try { url = new URL(params.query); } catch {}
        if (url) {
          if (url.origin !== 'https://v.douyin.com' || url.username || url.password) throw Error('请使用抖音音乐链接，或输入音乐关键词。');
          data = (await creator('music.validate', {query: url.href}, context)).data;
        } else data = (await creator('music.search', {query: params.query, cursor: params.cursor}, context)).data;
      } else {
        const categories = musicCatalog || (await musicCategories({kind: params.kind}, context, origin)).items;
        const category = params.categoryId !== undefined ? categories.find(item => item.id === params.categoryId && item.type === params.type)
          : categories.find(item => item.type === 'recommend') || categories[0];
        if (!category) throw Error(params.categoryId !== undefined ? '此音乐分类已不可用，请重新读取分类后选择。' : '当前账号没有可用的音乐分类。');
        const key = cacheKey('music-browser', origin, account.id, context.binding?.key || 'current');
        let browsing = await readCache(key);
        if (!browsing || now() - browsing.createdAt < 0 || now() - browsing.createdAt >= 30 * 60 * 1000) {
          browsing = {creationId: uuid(), createdAt: now()};
          await writeCache(key, browsing);
        }
        data = (await creator('music.list', {category_id: category.id, type: category.type, cursor: params.cursor, creation_id: browsing.creationId}, context)).data;
      }
    } else data = (await creator(operation, {query: params.query, cursor: params.cursor}, context)).data;
    if (!context.readOnly) await verifyReadSession(context);
    if (!data || !Array.isArray(data.items)) throw Error('平台候选格式已变化，请稍后重新查询。');
    const ids = new Set();
    data.items = data.items.filter(item => {
      if (!item || typeof item.id !== 'string' || !PLATFORM_ID.test(item.id) || typeof item.name !== 'string' || !item.name || item.name.length > 200 || ids.has(item.id)) return false;
      ids.add(item.id); return true;
    });
    return data;
  }

  // rememberCandidate 仅保留需要再次获取发布附加字段的查询线索；地点是公共资源，合集属于账号。
  async function rememberCandidate(operation, params, item, context, origin, queriedAt = now()) {
    if (!['locations.search', 'collections.list'].includes(operation)) return;
    const identity = {id: item.id, name: item.name};
    for (const key of ['cityCode', 'cityName']) if (item[key] !== undefined) identity[key] = item[key];
    requireContext(context);
    const record = {operation, params: {...params}, item: identity, queriedAt};
    if (operation === 'locations.search') {
      const key = JSON.stringify([origin, item.id]);
      locationQueries.delete(key); locationQueries.set(key, record);
      while (locationQueries.size > QUERY_PAGE_LIMIT) locationQueries.delete(locationQueries.keys().next().value);
    } else await writeCache(cacheKey('candidate', origin, context.account.id, `${operation}:${item.id}`), record);
  }

  // query 保存最少来源证据；播放和头像 URL 只返回界面，不持久化为候选身份。
  async function query(operation, input, context, origin) {
    const params = queryParams(operation, input);
    const pageKey = JSON.stringify([origin, context.account.id, context.binding?.key, operation, params]);
    // 活动列表由页面复用，手动刷新必须读取平台；图片推荐不能按文字参数复用旧上传结果。
    const reusable = !!context.binding && operation !== 'activities.list' && !(operation === 'topics.search' && !params.query);
    const previous = reusable ? queryPages.get(pageKey) : null;
    const page = previous && fresh(previous.queriedAt, QUERY_PAGE_TTL) ? previous
      : {data: await fetchCandidates(operation, params, context, origin), queriedAt: now()};
    const data = structuredClone(page.data);
    await verifyReadSession(context);
    requireContext(context);
    if (reusable) {
      queryPages.delete(pageKey); queryPages.set(pageKey, page);
      while (queryPages.size > QUERY_PAGE_LIMIT) queryPages.delete(queryPages.keys().next().value);
    }
    if (operation === 'music.search') rememberMusicSources(data.items, context);
    for (const item of data.items) {
      // 目录只有显示线索，不能把经过舍入的列表话题或普通浏览记录当成发布身份。
      if (operation === 'activities.list') continue;
      await rememberCandidate(operation, params, item, context, origin, page.queriedAt);
    }
    return data;
  }

  // currentActivity 每次选择/准备都用目录核验可参加状态，再从单条详情严格配对准确字符串话题身份。
  async function currentActivity(id, context, origin, checks = new Map()) {
    if (typeof id !== 'string' || !/^[1-9]\d{0,29}$/.test(id)) throw Error('活动身份无效，请重新选择官方活动。');
    let list = checks.get('list');
    if (!list) {
      list = await fetchCandidates('activities.list', queryParams('activities.list'), context, origin);
      checks.set('list', list);
    }
    const item = list.items.find(value => value.id === id);
    if (!item || item.disabled) throw Error(item?.description || '官方活动已变化或不可用，请重新读取后选择。');
    const detail = (await creator('activities.detail', {id}, context)).data;
    await verifyReadSession(context);
    const matches = detail.topicChoices.filter(value => value.name === item.topicName);
    if (detail.name !== item.name || matches.length !== 1) throw Error('官方活动话题身份无法确认，请重新读取活动详情后选择。');
    return {...item, topic: structuredClone(matches[0])};
  }

  // selectActivity 用户选中时解析当前账号的精确活动话题；准备阶段会独立重查，不依赖页面缓存。
  async function selectActivity(params, context, origin) {
    return currentActivity(params.id, context, origin);
  }

  // resolveActivity 准备时核对一次目录及精确详情；草稿恢复无需依赖已经销毁的页面内存。
  async function resolveActivity(selected, context, origin, checks) {
    const current = await currentActivity(selected.id, context, origin, checks);
    if (current.topic.id !== selected.topic.id) throw Error('官方活动话题已变化或不可用，请重新读取后选择。');
    return current;
  }

  // 音乐身份与真实音源分开：info 只有身份，时长和地址只能来自同账号实际查询记录。
  function musicIdentity(params, extra = []) {
    if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => !['id', ...extra].includes(key)) ||
        typeof params.id !== 'string' || !PLATFORM_ID.test(params.id)) throw Error('请选择有效的音乐身份。');
    if (Object.hasOwn(params, 'refreshSource') && typeof params.refreshSource !== 'boolean') throw Error('音乐刷新选项无效。');
    return params.id;
  }
  function musicScope(context) {
    if (typeof context.profileId !== 'string' || !context.profileId || context.profileId.length > 256) throw Error('请先选择并核对账号，再恢复配乐。');
    return {profileId: context.profileId, accountId: context.account.id};
  }
  function musicSource(item) {
    let previewURL = null;
    try { const url = new URL(item?.previewURL); if (url.protocol === 'https:' && !url.username && !url.password && url.href.length <= 4096) previewURL = url.href; } catch {}
    const duration = Number.isFinite(item?.duration) && item.duration > 0 ? item.duration : undefined;
    return {previewURL, ...(duration ? {duration} : {})};
  }
  function musicRecordKey(value) { return JSON.stringify([value.profileId, value.accountId, value.id]); }
  function rememberMusicSources(items, context) {
    if (!context.profileId) return;
    const scope = musicScope(context);
    for (const item of items) {
      const source = musicSource(item);
      if (!PLATFORM_ID.test(item?.id || '') || !source.previewURL && !source.duration) continue;
      const entry = {...scope, id: item.id, name: item.name, ...source};
      musicSources.set(musicRecordKey(entry), entry);
    }
  }
  async function selectedMusicRecords() {
    const stored = (await storage.get(MUSIC_RECORD_KEY))?.[MUSIC_RECORD_KEY];
    if (stored === undefined) return [];
    if (stored?.version !== 1 || !Array.isArray(stored.items) || stored.items.length > MUSIC_RECORD_LIMIT) throw Error('本机配乐记录无法读取，已保留草稿。');
    return stored.items.filter(item => item && typeof item.profileId === 'string' && item.profileId.length <= 256 && PLATFORM_ID.test(item.accountId || '') && PLATFORM_ID.test(item.id || ''))
      .map(item => ({profileId: item.profileId, accountId: item.accountId, id: item.id,
        ...(typeof item.name === 'string' && item.name && item.name.length <= 200 ? {name: item.name} : {}), ...musicSource(item)}));
  }
  async function saveMusicRecord(record, context, keepIds) {
    const operation = musicWrites.catch(() => {}).then(async () => {
      requireContext(context);
      let items = await selectedMusicRecords();
      requireContext(context);
      // 选曲在队列与读盘之后复查本机档案，旧账号的候选不能越过等待写入当前选择。
      if (keepIds) {
        await verifyReadSession(context);
      }
      if (keepIds) items = items.filter(item => item.profileId !== record.profileId || item.accountId !== record.accountId || keepIds.has(item.id));
      const key = musicRecordKey(record), index = items.findIndex(item => musicRecordKey(item) === key);
      const value = {profileId: record.profileId, accountId: record.accountId, id: record.id,
        ...(record.name ? {name: record.name} : {}), ...musicSource(record)};
      if (index >= 0) items[index] = value;
      else {
        if (items.length >= MUSIC_RECORD_LIMIT) throw Error('本机已保存的配乐记录已满，请先移除不再使用的草稿配乐。');
        items.push(value);
      }
      await storage.set({[MUSIC_RECORD_KEY]: {version: 1, items}});
      requireContext(context);
      return value;
    });
    musicWrites = operation;
    return operation;
  }
  // 选曲记录来自同账号实际展示的候选；清理只依据调用方现存草稿引用。
  async function selectMusic(params, context) {
    const id = musicIdentity(params, ['keepIds']);
    if (!Array.isArray(params.keepIds) || params.keepIds.length > 41 || params.keepIds.some(value => typeof value !== 'string' || !PLATFORM_ID.test(value)) || !params.keepIds.includes(id)) throw Error('配乐草稿引用无法确认，请重试。');
    const scope = musicScope(context), record = musicSources.get(musicRecordKey({...scope, id}));
    if (!record) throw Error('当前账号没有这首音乐的查询记录，请重新打开音乐列表后选择。');
    const saved = await saveMusicRecord(record, context, new Set(params.keepIds));
    return {id, ...musicSource(saved)};
  }
  // 缺少音源的试听在当前账号推荐和收藏各读最多两页，按 ID 补齐；上传准备不依赖此列表。
  async function findMusicSource(id, context, origin) {
    const categories = (await musicCategories({kind: 'image'}, context, origin)).items;
    for (const type of ['recommend', 'fav']) {
      const category = categories.find(item => item.type === type);
      if (!category) continue;
      const visited = new Set(); let cursor = '0';
      for (let page = 0; page < 2; page++) {
        if (visited.has(cursor)) break;
        visited.add(cursor);
        const result = await fetchCandidates('music.search', {query: '', cursor, kind: 'image', categoryId: category.id, type}, context, origin, categories);
        await verifyReadSession(context);
        rememberMusicSources(result.items, context);
        const item = result.items.find(value => value.id === id), source = musicSource(item);
        if (item && source.previewURL) return {...musicScope(context), id, name: item.name, ...source};
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
    }
    return null;
  }
  async function resolveMusic(params, context, origin, requirement = 'preview') {
    const id = musicIdentity(params, ['refreshSource']), scope = musicScope(context);
    await musicWrites.catch(() => {});
    const records = await selectedMusicRecords();
    let record = records.find(value => musicRecordKey(value) === musicRecordKey({...scope, id}));
    requireContext(context);
    if (params.refreshSource) {
      musicSources.delete(musicRecordKey({...scope, id}));
      // 用户已确认该地址播放失败；同一账号的短期查询页也不能把旧候选重新写回。
      for (const [key, page] of queryPages) {
        const binding = JSON.parse(key);
        if (binding[0] === origin && binding[1] === context.account.id && binding[3] === 'music.search' && page.data?.items?.some(value => value.id === id)) queryPages.delete(key);
      }
      if (record) record = await saveMusicRecord({...record, previewURL: null}, context);
    }
    const hasSource = value => requirement === 'duration' ? !!value?.duration : !!value?.previewURL;
    if (!params.refreshSource && !hasSource(record)) {
      const candidate = musicSources.get(musicRecordKey({...scope, id}));
      if (candidate && hasSource(candidate)) record = await saveMusicRecord(candidate, context);
    }
    // 试听优先采用同账号保存的地址；播放失败后的明确刷新才重取，详情请求不阻断已有音源。
    if (requirement === 'preview' && hasSource(record)) {
      await verifyReadSession(context);
      return {id, ...(record.name ? {name: record.name} : {}), ...musicSource(record)};
    }
    const item = (await creator('music.resolve', {id}, context)).data;
    if (!item || item.id !== id || typeof item.name !== 'string' || !item.name || item.name.length > 200) throw Object.assign(Error('所选音乐无法确认，已保留原配乐，请稍后重试。'), {code: 'MUSIC_IDENTITY_MISMATCH'});
    await verifyReadSession(context);
    if (requirement === 'duration') {
      // 音乐 ID 和时长属于平台资源。当前账号按 ID 核验成功后可复用同 ID 的实测时长；
      // 不借用其他账号的试听地址、登录会话或上传记录，也不再扫描推荐/收藏来恢复歌曲身份。
      const duration = musicSource(item).duration || musicSource(record).duration || records.find(value => value.id === id && value.duration)?.duration;
      if (!duration) throw Object.assign(Error(`音乐「${item.name}」的 ID 已确认，但本机缺少时长，请重新选择这首音乐后再上传。`), {code: 'MUSIC_METADATA_MISSING'});
      return {...item, duration};
    }
    if (params.refreshSource || !hasSource(record)) {
      const found = await findMusicSource(id, context, origin);
      if (found) record = await saveMusicRecord({...record, ...found}, context);
    }
    await verifyReadSession(context);
    return {...item, ...musicSource(record)};
  }

  // 准备时用当前账号核验 ID，时长复用平台实际返回的同 ID 资料，不把音乐资源归属某个账号。
  async function resolveMusicChoice(selected, context, origin) {
    if (!selected) return null;
    try { return await resolveMusic({id: selected.id}, context, origin, 'duration'); }
    catch (error) {
      requireContext(context);
      if (['ACCOUNT_CHANGED', 'SESSION_CHANGED', 'SESSION_EXPIRED', 'MUSIC_METADATA_MISSING'].includes(error.code) || error.name === 'AbortError') throw error;
      throw Object.assign(Error(`无法核验音乐「${selected.name}」：${publicError(error)}`), {code: error.code || 'CHOICE_LOOKUP_FAILED'});
    }
  }

  // resolveChoice 获取地点或合集的当前发布附加字段；公共地点线索不能替代当前账号的实际响应。
  async function resolveChoice(operation, selected, context, origin, kind) {
    if (!selected) return null;
    const record = operation === 'locations.search' ? locationQueries.get(JSON.stringify([origin, selected.id]))
      : await readCache(cacheKey('candidate', origin, context.account.id, `${operation}:${selected.id}`));
    const known = record?.operation === operation && record.item?.id === selected.id;
    const label = {'locations.search': '地点', 'collections.list': '合集'}[operation];
    let lookup = known ? {...record.params} : {query: selected.name.slice(0, 100), cursor: '0', kind};
    // 合集目录可以按 ID 遍历，不用旧名称过滤掉已经改名的同一合集。
    if (operation === 'collections.list') lookup.query = '';
    if (operation === 'locations.search' && !known) {
      if (!selected.cityCode || !selected.cityName) throw Object.assign(Error(`地点「${selected.name}」缺少城市信息，请重新选择城市和地点。`), {code: 'CHOICE_LOCATION_CITY_REQUIRED'});
      Object.assign(lookup, {cityCode: selected.cityCode, cityName: selected.cityName});
    }
    const recovery = {...lookup, query: operation === 'collections.list' ? '' : selected.name.slice(0, 100), cursor: '0'};
    let restarted = JSON.stringify(queryParams(operation, lookup)) === JSON.stringify(queryParams(operation, recovery));
    const visited = new Set();
    for (let page = 0; page < CHOICE_LOOKUP_PAGES; page++) {
      const params = queryParams(operation, lookup);
      const position = JSON.stringify(params);
      if (visited.has(position)) break;
      visited.add(position);
      let result;
      try { result = await fetchCandidates(operation, params, context, origin); }
      catch (error) {
        requireContext(context);
        if (['ACCOUNT_CHANGED', 'SESSION_CHANGED', 'SESSION_EXPIRED'].includes(error.code) || error.name === 'AbortError') throw error;
        throw Object.assign(Error(`无法核验${label}「${selected.name}」：${publicError(error)}`), {code: error.code || 'CHOICE_LOOKUP_FAILED'});
      }
      const match = result.items.find(item => item.id === selected.id);
      if (match) {
        await rememberCandidate(operation, params, match, context, origin);
        return match;
      }
      // 排序和分页会变化，旧查询未命中时从名称搜索第一页重新核对，不能永久绑定旧游标。
      if (!restarted && position !== JSON.stringify(queryParams(operation, recovery))) {
        lookup = recovery; restarted = true; continue;
      }
      if (!result.nextCursor) break;
      lookup = {...params, cursor: result.nextCursor};
    }
    throw Object.assign(Error(`${label}「${selected.name}」已变化或当前账号无法使用，请重新搜索并选择。`), {code: 'CHOICE_UNAVAILABLE'});
  }

  // resolveChoices 保留普通话题和用户的已选平台 ID；活动、音乐及地点另获取发布所需资料。
  async function resolveChoices(draft, context, origin) {
    const topics = [], activities = [];
    const activityChecks = new Map();
    // 同一次准备共用目录，每个已选活动单独读详情。
    for (const item of draft.activities) activities.push(await resolveActivity(item, context, origin, activityChecks));
    for (const item of draft.topics) {
      if (item.id === '0') { topics.push({id: '0', name: item.name}); continue; }
      const activity = activities.find(value => value.topic.id === item.id);
      topics.push(activity ? activity.topic : {id: item.id, name: item.name});
    }
    const music = await resolveMusicChoice(draft.music, context, origin);
    // 只更新本次准备的内部快照，保存的草稿名称保持不变。
    if (music) draft.music = {id: music.id, name: music.name};
    const location = await resolveChoice('locations.search', draft.location, context, origin, draft.kind);
    if (location?.requiresNativeSelection) throw Error('此地点需要平台额外确认，请清除地点后继续。');
    const collection = await resolveChoice('collections.list', draft.collection, context, origin, draft.kind);
    if (location) draft.location = {...draft.location, name: location.name};
    if (collection) draft.collection = {...draft.collection, name: collection.name};
    draft.topics = topics.map(({id, name}) => ({id, name}));
    draft.activities = activities.map(({id, name, topic}) => ({id, name, topic: {id: topic.id, name: topic.name}}));
    return {music, location, collection};
  }

  // declarationOptions 读取当前作品与账号的真实声明规则，不把本机固定枚举伪装为平台能力。
  async function declarationOptions(params, context) {
    if (!['image', 'video'].includes(params?.kind) || !LOCAL_ID.test(params?.draftId || '')) throw Error('请选择有效作品后读取自主声明。');
    const result = (await creator('declarations.list', {kind: params.kind, draftId: params.draftId}, context)).data;
    await verifyReadSession(context);
    return result;
  }

  // resolveDeclaration 准备时核对声明可选项和必填规则。
  async function resolveDeclaration(draft, context) {
    const options = await declarationOptions({kind: draft.kind, draftId: draft.id}, context);
    const selected = draft.settings.declarations[0];
    if (!selected) {
      if (options.required) throw Error('当前作品需要自主声明，请选择一项声明后重新检查。');
      return null;
    }
    const item = options.items.find(value => value.id === selected);
    if (!item || item.disabled) throw Error(item?.description || '所选自主声明已变化，请重新读取并选择。');
    return item;
  }

  // uploadAuthorization 仅在本次任务内返回凭据，持久层永远只接收上传完成元数据。
  async function uploadAuthorization(context) {
    const result = await creator('auth', {}, context);
    await verifyReadSession(context);
    return result.auth;
  }

  // imageCoverRecord 校验图库封面记录及源版本，不接受 App 构造的远端资源 URI。
  async function imageCoverRecord(id, context, origin) {
    if (!LOCAL_ID.test(id || '')) throw Error('封面身份无效，请重新选择。');
    const record = await readCache(cacheKey('cover', origin, context.account.id, id));
    if (!record?.uploadFile?.uri || !record.assetId) throw Error('封面记录不可用，请重新上传图库图片。');
    const current = await media.resolveAssets({kind: 'image', assets: [{id: record.assetId, name: record.name}]}, origin, {signal: context.signal});
    if (current.assets?.length !== 1 || current.assets[0].id !== record.assetId || current.assets[0].kind !== 'image' || current.assets[0].revision !== record.revision) throw Error('封面源文件已变化，请重新选择并上传。');
    return record.uploadFile;
  }

  // uploadCover 仅接收图库图片身份，文件内容由受限的本机媒体读取边界取得。
  async function uploadCover(params, context, origin) {
    if (!LOCAL_ID.test(params?.assetId || '') || params.file !== undefined) throw Error('请从图库选择一张图片作为封面。');
    return exclusive(context.account.id, async () => {
      const job = {kind: 'image', assets: [{id: params.assetId, name: '封面.jpg', kind: 'image'}], settings: {}};
      const resolution = await media.resolveAssets(job, origin, {signal: context.signal});
      const resolved = resolution.assets?.[0];
      if (resolution.assets?.length !== 1 || resolved?.kind !== 'image') throw Error('封面必须使用图库中的图片素材。');
      if (!resolved.revision) throw Error('无法确认封面文件版本。');
      const file = await media.prepareFile(job, origin, resolved, {signal: context.signal});
      if (!file?.file || file.assetID !== resolved.id || file.revision !== resolved.revision) throw Error('封面读取不完整或版本已变化，请重新准备。');
      const current = await media.resolveAssets(job, origin, {signal: context.signal});
      if (current.assets?.length !== 1 || current.assets[0].id !== resolved.id || current.assets[0].kind !== 'image' || current.assets[0].revision !== resolved.revision) throw Error('封面源文件已变化，请重新准备。');
      const uploaded = await media.uploadImage(file.file, await uploadAuthorization(context), {fetch: context.send, signal: context.signal});
      const afterUpload = await media.resolveAssets(job, origin, {signal: context.signal});
      if (afterUpload.assets?.length !== 1 || afterUpload.assets[0].id !== resolved.id || afterUpload.assets[0].kind !== 'image' || afterUpload.assets[0].revision !== resolved.revision) throw Error('封面源文件已变化，请重新准备。');
      await verifyReadSession(context);
      if (uploaded?.uploadFile?.uriStatus !== 2000) throw Error('封面上传未得到确认，请重试。');
      const id = uuid();
      await writeCache(cacheKey('cover', origin, context.account.id, id), {assetId: resolved.id, name: resolved.name, revision: resolved.revision, uploadFile: uploaded.uploadFile, createdAt: now()});
      return {id, name: resolved.name};
    });
  }

  // prepare 完整核对选择、按账号复用媒体检查点，再保存不可变发布快照。
  async function prepare(params, context, origin, progress) {
    const draft = validateStudioDraft(params?.draft, {...capabilities(), now: now()});
    if (draft.kind === 'video' && (draft.music || draft.location || draft.collection)) throw Error('视频配乐、地点和合集尚未验证，请清除这些选项后继续。');
    if (draft.collection && draft.settings.publishTime === 'scheduled') throw Error('定时作品的合集序号尚未验证，请取消合集或改为立即发布。');
    if (draft.cover?.type === 'frame') throw Error('视频帧封面尚未接入，请选择图库图片或使用平台首帧。');
    return exclusive(context.account.id, async () => {
      const selected = await resolveChoices(draft, context, origin);
      const declaration = await resolveDeclaration(draft, context);
      const job = {id: draft.id, kind: draft.kind, assets: draft.assets, settings: {}};
      if (draft.cover?.type === 'asset') {
        const selectedCover = draft.assets.find(item => item.id === draft.cover.assetId);
        job.settings.coverAsset = selectedCover ?? {id: draft.cover.assetId, name: '封面.jpg', kind: 'image'};
        if (draft.cover.crop) job.settings.coverCrop = draft.cover.crop;
      }
      const key = cacheKey('uploads', origin, context.account.id, draft.id), previous = (await readCache(key))?.records || [];
      const checkpoint = records => writeCache(key, {records, recommendationFrames: [], updatedAt: now()});
      const onProgress = value => progress?.({...value, assetId: value.assetId || value.assetID,
        message: value.message || {resolving: '正在核对图库素材', reading: '正在读取素材', cropping: '正在裁剪封面', uploading: '正在上传素材',
          uploaded: '已上传', reused: '复用已上传素材', ready: '视频已就绪', failed: '素材处理失败', processing: '正在等待视频转码', cover: '正在准备封面', staging: '正在核对发布内容'}[value.phase] || '正在准备作品'});
      const dependencies = {...media, checkpoint, onProgress, signal: context.signal,
        resolveAssets: (job, origin) => { throwIfCancelled(context.signal); return media.resolveAssets(job, origin, {signal: context.signal}); },
        prepareFile: (job, origin, asset) => { throwIfCancelled(context.signal); return media.prepareFile(job, origin, asset, {signal: context.signal}); },
        cropCoverFile: (origin, id, crop) => { throwIfCancelled(context.signal); return media.cropCoverFile(origin, id, crop, {signal: context.signal}); },
        wait: milliseconds => cancellableWait(milliseconds, context.signal),
        getAuth: () => uploadAuthorization(context),
        uploadImage: (file, auth) => { throwIfCancelled(context.signal); return media.uploadImage(file, auth, {fetch: context.send, signal: context.signal}); },
        uploadVideo: (file, auth) => { throwIfCancelled(context.signal); return media.uploadVideo(file, auth, {fetch: context.send, signal: context.signal}); }};
      let prepared;
      if (draft.kind === 'image') {
        prepared = await media.importImages({job, account: context.account.id, origin, previous}, {...dependencies, buildImageDraft: ({files, cover}) => ({images: files, cover})});
      } else {
        prepared = await media.importVideo({job, account: context.account.id, origin, previous}, {...dependencies,
          buildVideoDraft: ({video}) => ({video}),
          enableVideo: async vid => { await creator('video-enable', {vid}, context); await verifyReadSession(context); },
          getVideoStatus: async vid => { const result = (await creator('video-status', {vid}, context)).data; await verifyReadSession(context); return result; },
        });
      }
      if (draft.kind === 'image') {
        const saved = await readCache(key);
        await writeCache(key, {records: saved?.records || [], recommendationFrames: prepared.draft.images.map(image => image.uri), updatedAt: now()});
      }
      // 本次已确认的身份直接复用；合集序号会随新增作品变化，仅在上传后重新计算这一项。
      if (draft.collection) {
        selected.collection = await resolveChoice('collections.list', draft.collection, context, origin, draft.kind);
        draft.collection = {...draft.collection, name: selected.collection.name};
      }
      // 平台选项复核可能耗时；保存发布快照前再次确认独立封面的真实图库版本。
      if (prepared.coverSource) {
        const current = await dependencies.resolveAssets({kind: 'image', assets: [prepared.coverSource.source]}, origin);
        const asset = current.assets?.[0];
        if (current.assets?.length !== 1 || asset?.id !== prepared.coverSource.assetID || asset.kind !== 'image' || asset.revision !== prepared.coverSource.revision) {
          throw Error('封面源文件已变化，请重新准备。');
        }
      }
      let cover;
      if (draft.cover?.type === 'upload') cover = await imageCoverRecord(draft.cover.id, context, origin);
      else if (draft.kind === 'image') {
        const index = draft.cover?.type === 'asset' ? draft.assets.findIndex(item => item.id === draft.cover.assetId) : 0;
        cover = prepared.draft.cover || (index >= 0 ? prepared.draft.images?.[index] : undefined);
        if (!cover) throw Error('所选图库封面尚未完整准备，请重新准备作品。');
      }
      validateStudioDraft(draft, {...capabilities(), now: now()});
      const payload = buildPublicationPayload({draft, ...prepared.draft, ...selected, cover, declaration, creationId: uuid()});
      await verifyReadSession(context);
      return store.prepare({account: context.account, draft, payload, origin, summary: {title: draft.title, assetCount: draft.assets.length, kind: draft.kind, visibility: draft.settings.visibility, scheduledAt: draft.settings.scheduledAt}});
    });
  }

  // publish 取得持久化防重资格后只发一次请求；不确定的网络结果永远记录为 unknown。
  async function publish(params, context, origin) {
    if (params?.expectedAccountId !== context.account.id) throw Error('确认账号与当前抖音账号不同，请重新准备。');
    return exclusive(context.account.id, async () => {
      const attempt = await store.beginSubmit({preparationId: params.preparationId, requestId: params.requestId, origin, expectedAccountId: context.account.id, confirmed: params.confirmed});
      if (attempt.duplicate) return attempt.result;
      let result;
      try {
        const response = await creator('publication.publish', {payload: attempt.payload, expectedAccountId: context.account.id}, context);
        result = response.data;
      } catch (error) {
        result = {status: error.definiteFailure === true ? 'failed' : 'unknown', message: error.definiteFailure === true ? publicError(error) : '发布结果尚未确认，请查询状态并核对抖音作品列表，勿重复提交。'};
      }
      return store.finish(params.preparationId, result);
    });
  }

  // publicationStatus 先读本地尝试，再在同一账号查询已知作品；没有作品 ID 时不能猜测结果。
  async function publicationStatus(params, context, origin) {
    const result = await store.findStatus({requestId: params?.requestId, publicationId: params?.publicationId, origin});
    if (!result) return {status: 'unknown', message: '未找到当前 App 的发布记录，请核对创作者中心，勿重复提交。'};
    const history = (await store.listHistory(origin)).find(item => item.preparationId === result.preparationId);
    const identity = typeof history?.account === 'string' ? history.account : history?.account?.id;
    if (identity !== context.account.id) throw Error('这条发布记录属于其他抖音账号，请切换回原账号后查询。');
    if (!result.publicationId || result.status === 'failed') return result;
    const remote = (await creator('publication.status', {publicationId: result.publicationId}, context)).data;
    await verifyReadSession(context);
    // 当前只核实“平台存在记录”，不将未知审核状态解释成已发布。
    return store.finish(result.preparationId, {publicationId: result.publicationId, status: 'processing', message: remote.message || '已取得平台作品记录，实际发布状态请在创作者中心确认。'});
  }

  // dispatch 是 App 唯一业务入口，未列入能力清单的操作一律拒绝。
  async function dispatch(operation, params = {}, {origin, progress, signal, expectedAccountId, profileId} = {}) {
    checkedOrigin(origin);
    if (!OPERATIONS.includes(operation)) throw Error('此功能尚未接入发布工作台。');
    if (operation === 'music.resolve') musicIdentity(params, ['refreshSource']);
    if (operation === 'music.select') musicIdentity(params, ['keepIds']);
    throwIfCancelled(signal);
    // 发布开始后必须取得并持久化真实或未知回执；UI 不提供撤销提交的假承诺。
    const operationSignal = operation === 'publication.publish' ? undefined : signal;
    const scope = {origin, profileId, generation, signal: operationSignal, expectedAccountId, readOnly: QUERY_OPERATIONS.includes(operation) || ['declarations.list', 'hotspots.search', 'music.categories', 'music.resolve', 'music.select', 'activities.detail', 'activities.resolve'].includes(operation)};
    const scopedSend = async (url, options = {}) => {
      requireContext(scope);
      const response = await send(url, {...options, ...(profileId ? {profileId} : {}), signal: combineSignals(operationSignal, options.signal)});
      if (operation !== 'publication.publish') requireContext(scope);
      return response;
    };
    try {
      const context = await session({...scope, send: scopedSend}, {
        verifyRemote: ['studio.session', 'publication.prepare', 'cover.upload'].includes(operation), allowUnidentified: operation === 'studio.session',
      });
      let value;
      if (operation === 'studio.session') value = {connected: true, account: context.account, capabilities: capabilities()};
      else if (operation === 'declarations.list') value = await declarationOptions(params, context);
      else if (operation === 'hotspots.search') value = await hotspots(params, context, origin);
      else if (operation === 'music.resolve') value = await resolveMusic(params, context, origin);
      else if (operation === 'music.select') value = await selectMusic(params, context);
      else if (operation === 'music.categories') { value = await musicCategories(params, context, origin); await verifyReadSession(context); }
      else if (operation === 'activities.detail') { value = (await creator('activities.detail', {id: params.id}, context)).data; await verifyReadSession(context); }
      else if (operation === 'activities.resolve') value = await selectActivity(params, context, origin);
      else if (QUERY_OPERATIONS.includes(operation)) value = await query(operation, params, context, origin);
      else if (operation === 'cover.upload') value = await uploadCover(params, context, origin);
      else if (operation === 'publication.prepare') value = await prepare(params, context, origin, progress);
      else if (operation === 'publication.publish') return publish(params, context, origin);
      else if (operation === 'publication.status') value = await publicationStatus(params, context, origin);
      if (operation === 'studio.session') {
        // 登录核验只确认本次真实身份；普通操作使用本机档案，不建立定时重验账号的缓存。
        const binding = await nativeBinding(context, {allowUnidentified: true});
        if (binding && context.account.id !== binding.accountId) throw Object.assign(Error('实际抖音账号与所选账号不一致，请重新登录。'), {code: 'SESSION_IDENTITY_MISMATCH'});
      }
      requireContext(context);
      return value;
    } catch (error) {
      throwIfCancelled(operationSignal);
      // 断网或平台拒绝只反馈本次错误，保留先前资料；明确换号才清除旧账号的临时候选。
      if (scope.generation === generation && ['SESSION_CHANGED', 'ACCOUNT_CHANGED'].includes(error.code)) invalidate();
      throw error;
    }
  }

  // invalidate 取消旧账号请求并清理其查询结果；公共地点线索保留，上传与发布记录仍按账号隔离。
  function invalidate() { generation++; cache.clear(); queryPages.clear(); musicSources.clear(); }
  return {dispatch, invalidate, capabilities};
}
