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
const OPERATIONS = ['studio.session', 'declarations.list', 'music.categories', 'activities.detail', 'activities.resolve', ...QUERY_OPERATIONS, 'cover.upload', 'publication.prepare', 'publication.publish', 'publication.status'];
const PLATFORM_ID = /^\d{1,30}$/;
const LOCAL_ID = /^[a-zA-Z0-9_-]{1,100}$/;
// 读取只短暂复用同一宿主档案的已核验身份；准备和发布永远不使用这些缓存。
const READ_IDENTITY_TTL = 60 * 1000;
const MUSIC_CATEGORY_TTL = 5 * 60 * 1000;
const QUERY_PAGE_TTL = 15 * 1000;
const QUERY_PAGE_LIMIT = 64;
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
    byKind: {video: {disabledOperations: ['music.search', 'music.categories', 'locations.search', 'collections.list']}},
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
  throw Error('当前 App 来源无效，请重新连接实验插件。');
}

// createStudioEngine 注入宿主会话与上传边界便于离线验证；运行时只调用固定业务函数。
export function createStudioEngine({storage, send, sessionStatus, publicationStore, now = Date.now, uuid = () => crypto.randomUUID(), upload = {}, libraryAsset} = {}) {
  if (!storage?.get || !storage?.set || typeof send !== 'function') throw Error('App 会话和持久化接口尚未就绪。');
  const store = publicationStore || createPublicationStore({storage, now, uuid});
  const cache = new Map();
  const media = {resolveAssets, prepareFile, importImages, importVideo, uploadImage, uploadVideo, cropCoverFile, ...upload};
  const accountTasks = new Set();
  const queryPages = new Map(); // 短期页面仅在内存保留，完整查询参数和账号档案共同隔离。
  let generation = 0, readIdentity = null; // 账号失效后，旧异步结果不能重新填充身份或候选缓存。

  // requireContext 同时约束取消和账号生命周期，阻止旧请求回写新账号的缓存。
  function requireContext(context) {
    throwIfCancelled(context?.signal);
    if (context?.generation !== generation) throw Object.assign(Error('抖音账号已变化，请重新检查会话。'), {code: 'SESSION_CHANGED'});
  }

  // fresh 按创建时间而非访问时间失效；系统时钟回拨也不能延长缓存生命。
  function fresh(createdAt, ttl) { const age = now() - createdAt; return Number.isFinite(age) && age >= 0 && age < ttl; }

  // nativeBinding 仅读宿主公开会话元数据，不读取 Cookie；旧宿主没有档案能力时继续实时核验。
  async function nativeBinding(context, {allowUnidentified = false} = {}) {
    if (!sessionStatus) return null;
    const status = await sessionStatus();
    requireContext(context);
    if (!status) return null;
    if (allowUnidentified && !status.accountId) return null;
    if (!status.hasCookies || !Number.isFinite(Date.parse(status.expiresAt)) || Date.parse(status.expiresAt) <= now()) throw Object.assign(Error('当前抖音会话已过期，请重新登录。'), {code: 'SESSION_EXPIRED'});
    if (typeof status.activeProfileId !== 'string' || !status.activeProfileId || !PLATFORM_ID.test(status.accountId || '')) throw Object.assign(Error('当前账号尚未核验，请先检查会话。'), {code: 'SESSION_CHANGED'});
    return {key: JSON.stringify([context.origin, status.activeProfileId, status.accountId, status.expiresAt]), accountId: status.accountId};
  }

  // sameAccount 拒绝把另一真实账号的查询或准备结果当作界面当前账号的结果。
  function sameAccount(account, expected) {
    if (expected && account.id !== expected) throw Object.assign(Error('抖音账号已变化，请重新连接并准备当前账号的作品。'), {code: 'ACCOUNT_CHANGED'});
  }

  // creator 由宿主发送固定 HTTPS 请求，业务参数不依赖宿主标签页或页面运行时。
  async function creator(operation, params = {}, context) {
    requireContext(context);
    const result = await createCreatorAPI(context?.send || send)(operation, params);
    requireContext(context);
    if (result?.ok !== true) throw Object.assign(Error(publicError({message: result?.error})), {definiteFailure: result?.definiteFailure === true});
    return result;
  }

  // currentAccount 始终读取平台当前身份，不用宿主连接或旧缓存推定已登录。
  async function currentAccount(context) {
    const account = (await creator('account', {}, context)).data;
    if (!account || !PLATFORM_ID.test(account.id) || typeof account.name !== 'string' || !account.name) throw Error('无法确认当前抖音账号，请重新登录抖音后重试。');
    return account;
  }

  // verifyAccount 在上传、准备和提交的关键边界实时核对平台身份，不使用读取缓存。
  async function verifyAccount(expected, context) {
    const account = await currentAccount(context);
    if (account.id !== expected) throw Object.assign(Error('抖音账号已变化，请重新连接并准备当前账号的作品。'), {code: 'ACCOUNT_CHANGED'});
    return account;
  }

  // session 只对资源读取复用近期真实核验；每次仍由宿主确认当前档案、账号和到期边界。
  async function session(context) {
    const binding = context.readOnly ? await nativeBinding(context) : null;
    if (binding) sameAccount({id: binding.accountId}, context.expectedAccountId);
    if (binding && readIdentity?.key === binding.key && fresh(readIdentity.verifiedAt, READ_IDENTITY_TTL)) {
      sameAccount(readIdentity.account, context.expectedAccountId);
      return {...context, binding, account: structuredClone(readIdentity.account)};
    }
    const account = await currentAccount(context);
    sameAccount(account, binding?.accountId);
    sameAccount(account, context.expectedAccountId);
    if (binding) readIdentity = {key: binding.key, account, verifiedAt: now()};
    return {...context, binding, account};
  }

  // verifyReadSession 在展示和保存候选前重读本机档案；没有宿主档案契约时回退到实时平台核验。
  async function verifyReadSession(context) {
    if (!context.binding) return verifyAccount(context.account.id, context);
    const current = await nativeBinding(context);
    if (current?.key !== context.binding.key) throw Object.assign(Error('抖音账号已变化，本次查询未采用，请重新检查会话。'), {code: 'SESSION_CHANGED'});
  }

  // exclusive 拒绝同账号并发上传或提交；心跳仅覆盖用户已发起任务。
  async function exclusive(accountId, action) {
    if (accountTasks.has(accountId)) throw Error('该账号正在准备或提交作品，请等待当前任务结束。');
    accountTasks.add(accountId);
    try { return await action(); }
    finally { accountTasks.delete(accountId); }
  }

  // cacheKey 将候选、封面与媒体检查点按插件、来源和账号隔离。
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
  async function fetchCandidates(operation, params, context, origin) {
    const {account} = context;
    if (!context.readOnly) await verifyAccount(account.id, context);
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
      if (!response.ok) throw Error(response.error || '地点查询未完成。');
      const result = response.data;
      data = {items: result.items.map(item => ({...item, description: item.address || '', cityCode: params.cityCode, cityName: params.cityName})), nextCursor: Number.isInteger(result.nextPage) && result.nextPage > page ? String(result.nextPage) : null};
    } else if (operation === 'collections.list') {
      const response = await listCollections(validateCollectionQuery({kind: params.kind, cursor: params.cursor}), context.send);
      if (!response.ok) throw Error(response.error || '合集查询未完成。');
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
        const categories = (await musicCategories({kind: params.kind}, context, origin)).items;
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
    if (!context.readOnly) await verifyAccount(account.id, context);
    if (!data || !Array.isArray(data.items)) throw Error('平台候选格式已变化，请稍后重新查询。');
    const ids = new Set();
    data.items = data.items.filter(item => {
      if (!item || typeof item.id !== 'string' || !PLATFORM_ID.test(item.id) || typeof item.name !== 'string' || !item.name || item.name.length > 200 || ids.has(item.id)) return false;
      ids.add(item.id); return true;
    });
    return data;
  }

  // rememberCandidate 只记录当前账号已核验的最小身份，媒体地址和平台附加字段不进入缓存。
  async function rememberCandidate(operation, params, item, context, origin, queriedAt = now()) {
    const identity = {id: item.id, name: item.name};
    for (const key of ['duration', 'order', 'cityCode', 'cityName']) if (item[key] !== undefined) identity[key] = item[key];
    requireContext(context);
    await writeCache(cacheKey('candidate', origin, context.account.id, `${operation}:${item.id}`), {operation, params, item: identity, queriedAt});
  }

  // query 保存最少来源证据；播放和头像 URL 只返回界面，不持久化为候选身份。
  async function query(operation, input, context, origin) {
    const params = queryParams(operation, input);
    const pageKey = JSON.stringify([origin, context.account.id, context.binding?.key, operation, params]);
    // 图片推荐依赖最近一次完整上传快照，不能按文字参数复用旧推荐。
    const reusable = !!context.binding && !(operation === 'topics.search' && !params.query);
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
    if (context.readOnly) await verifyReadSession(context);
    else await verifyAccount(context.account.id, context);
    const matches = detail.topicChoices.filter(value => value.name === item.topicName);
    if (detail.name !== item.name || matches.length !== 1) throw Error('官方活动话题身份无法确认，请重新读取活动详情后选择。');
    return {...item, topic: structuredClone(matches[0])};
  }

  // selectActivity 用户选中时解析当前账号的精确活动话题；准备阶段会独立重查，不依赖页面缓存。
  async function selectActivity(params, context, origin) {
    return currentActivity(params.id, context, origin);
  }

  // resolveActivity 上传前后重查目录及精确详情；草稿恢复无需依赖已经销毁的页面内存。
  async function resolveActivity(selected, context, origin, checks) {
    const current = await currentActivity(selected.id, context, origin, checks);
    if (current.name !== selected.name) throw Error('官方活动已变化或不可用，请重新读取后选择。');
    if (current.topic.id !== selected.topic.id || current.topic.name !== selected.topic.name) throw Error('官方活动话题已变化或不可用，请重新读取后选择。');
    return current;
  }

  // resolveChoice 把草稿身份只当查询线索；内存丢失或音乐到期时重新查平台，严格匹配 ID 和名称。
  async function resolveChoice(operation, selected, context, origin, kind) {
    if (!selected) return null;
    const record = await readCache(cacheKey('candidate', origin, context.account.id, `${operation}:${selected.id}`));
    const known = record?.operation === operation && record.item?.id === selected.id && record.item.name === selected.name;
    // 推荐榜会重排；近期已核验音乐可复用，到期后按名称重新搜索，不要求用户手动重复选择。
    if (operation === 'music.search' && known && fresh(record.queriedAt, 30 * 60 * 1000)) return structuredClone(record.item);
    const label = {'topics.search': '话题', 'users.search': '好友', 'music.search': '音乐', 'locations.search': '地点', 'collections.list': '合集'}[operation];
    let lookup = known && operation !== 'music.search' ? {...record.params} : {query: selected.name.slice(0, 100), cursor: '0', kind};
    if (operation === 'topics.search' && !lookup.query) lookup.query = selected.name.slice(0, 100);
    if (operation === 'locations.search' && !known) {
      if (!selected.cityCode || !selected.cityName) throw Object.assign(Error(`地点「${selected.name}」缺少城市信息，请重新选择城市和地点。`), {code: 'CHOICE_LOCATION_CITY_REQUIRED'});
      Object.assign(lookup, {cityCode: selected.cityCode, cityName: selected.cityName});
    }
    const recovery = {...lookup, query: selected.name.slice(0, 100), cursor: '0'};
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
        throw Object.assign(Error(`无法核验${label}「${selected.name}」：${publicError(error)}`), {code: 'CHOICE_LOOKUP_FAILED'});
      }
      const match = result.items.find(item => item.id === selected.id && item.name === selected.name);
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

  // resolveChoices 不信任 App 提交的平台附加字段，只使用刚从固定查询取得的业务值。
  async function resolveChoices(draft, context, origin) {
    const topics = [], mentions = [], activities = [];
    const activityChecks = new Map();
    // 同一次边界共用目录，每个已选活动单独读详情；上传后的边界使用全新检查缓存。
    for (const item of draft.activities) activities.push(await resolveActivity(item, context, origin, activityChecks));
    for (const item of draft.topics) {
      const activity = activities.find(value => value.topic.id === item.id);
      topics.push(activity ? activity.topic : await resolveChoice('topics.search', item, context, origin, draft.kind));
    }
    for (const item of draft.mentions) mentions.push(await resolveChoice('users.search', item, context, origin, draft.kind));
    const music = await resolveChoice('music.search', draft.music, context, origin, draft.kind);
    if (music && (!Number.isFinite(music.duration) || music.duration <= 0)) throw Error('此音乐未返回可确认时长，请重新选择推荐音乐。');
    const location = await resolveChoice('locations.search', draft.location, context, origin, draft.kind);
    if (location?.requiresNativeSelection) throw Error('此地点需要平台额外确认，请清除地点后继续。');
    const collection = await resolveChoice('collections.list', draft.collection, context, origin, draft.kind);
    draft.topics = topics.map(({id, name}) => ({id, name})); draft.mentions = mentions.map(({id, name}) => ({id, name}));
    draft.activities = activities.map(({id, name, topic}) => ({id, name, topic: {id: topic.id, name: topic.name}}));
    return {music, location, collection};
  }

  // declarationOptions 读取当前作品与账号的真实声明规则，不把本机固定枚举伪装为平台能力。
  async function declarationOptions(params, context) {
    if (!['image', 'video'].includes(params?.kind) || !LOCAL_ID.test(params?.draftId || '')) throw Error('请选择有效作品后读取自主声明。');
    if (!context.readOnly) await verifyAccount(context.account.id, context);
    const result = (await creator('declarations.list', {kind: params.kind, draftId: params.draftId}, context)).data;
    if (context.readOnly) await verifyReadSession(context);
    else await verifyAccount(context.account.id, context);
    return result;
  }

  // resolveDeclaration 在准备前后重新核对声明可选项和必填规则，上传期间规则变化时停止交付快照。
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
    await verifyAccount(context.account.id, context);
    const result = await creator('auth', {}, context);
    await verifyAccount(context.account.id, context);
    return result.auth;
  }

  // imageCoverRecord 校验图库封面记录及源版本，不接受 App 构造的远端资源 URI。
  async function imageCoverRecord(id, context, origin) {
    if (!LOCAL_ID.test(id || '')) throw Error('封面身份无效，请重新选择。');
    const record = await readCache(cacheKey('cover', origin, context.account.id, id));
    if (!record?.uploadFile?.uri || !record.assetId) throw Error('封面记录不可用，请重新上传图库图片。');
    const current = await media.resolveAssets({kind: 'image', assets: [{id: record.assetId, name: record.name}]}, origin, {signal: context.signal});
    if (current.assets?.length !== 1 || current.assets[0].revision !== record.revision) throw Error('封面源文件已变化，请重新选择并上传。');
    return record.uploadFile;
  }

  // uploadCover 仅接收图库图片身份，文件内容由受限的本机媒体读取边界取得。
  async function uploadCover(params, context, origin) {
    if (!LOCAL_ID.test(params?.assetId || '') || params.file !== undefined) throw Error('请从图库选择一张图片作为封面。');
    return exclusive(context.account.id, async () => {
      let asset;
      if (libraryAsset) asset = await libraryAsset(origin, params.assetId);
      else {
        const response = await fetch(`${origin}/api/v1/assets/${encodeURIComponent(params.assetId)}`, {credentials: 'omit', redirect: 'error', signal: combineSignals(context.signal, AbortSignal.timeout(15000))});
        const body = await response.json();
        if (!response.ok || body.code !== 0) throw Error('无法读取图库封面，请检查素材来源。');
        asset = body.data;
      }
      if (asset?.kind !== 'image') throw Error('封面必须使用图库中的图片素材。');
      const job = {kind: 'image', assets: [{id: params.assetId, name: asset.name || '封面.jpg'}], settings: {}};
      const resolved = (await media.resolveAssets(job, origin, {signal: context.signal})).assets?.[0];
      if (!resolved?.revision) throw Error('无法确认封面文件版本。');
      const file = await media.prepareFile(job, origin, resolved, {signal: context.signal});
      const uploaded = await media.uploadImage(file.file, await uploadAuthorization(context), {fetch: context.send, signal: context.signal});
      await verifyAccount(context.account.id, context);
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
      let selected = await resolveChoices(draft, context, origin);
      let declaration = await resolveDeclaration(draft, context);
      const job = {id: draft.id, kind: draft.kind, assets: draft.assets, settings: {}};
      if (draft.cover?.type === 'asset' && draft.cover.crop) Object.assign(job.settings, {coverIndex: draft.assets.findIndex(item => item.id === draft.cover.assetId), coverCrop: draft.cover.crop});
      const key = cacheKey('uploads', origin, context.account.id, draft.id), previous = (await readCache(key))?.records || [];
      const checkpoint = records => writeCache(key, {records, recommendationFrames: [], updatedAt: now()});
      const onProgress = value => progress?.({...value, assetId: value.assetID, message: {resolving: '正在核对图库素材', reading: '正在读取素材', uploading: '正在上传素材', processing: '正在等待视频转码', cover: '正在准备封面', staging: '正在核对发布内容'}[value.phase] || '正在准备作品'});
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
          enableVideo: async vid => { await verifyAccount(context.account.id, context); await creator('video-enable', {vid}, context); await verifyAccount(context.account.id, context); },
          getVideoStatus: async vid => { await verifyAccount(context.account.id, context); const result = (await creator('video-status', {vid}, context)).data; await verifyAccount(context.account.id, context); return result; },
        });
      }
      if (draft.kind === 'image') {
        const saved = await readCache(key);
        await writeCache(key, {records: saved?.records || [], recommendationFrames: prepared.draft.images.map(image => image.uri), updatedAt: now()});
      }
      // 长时间上传后重查选项，尤其是合集集数，不能使用上传开始时的旧值。
      selected = await resolveChoices(draft, context, origin);
      declaration = await resolveDeclaration(draft, context);
      let cover;
      if (draft.cover?.type === 'upload') cover = await imageCoverRecord(draft.cover.id, context, origin);
      else if (draft.kind === 'image') {
        const index = draft.cover?.type === 'asset' ? draft.assets.findIndex(item => item.id === draft.cover.assetId) : 0;
        cover = prepared.draft.cover || prepared.draft.images?.[index];
      }
      validateStudioDraft(draft, {...capabilities(), now: now()});
      const payload = buildPublicationPayload({draft, ...prepared.draft, ...selected, cover, declaration, creationId: uuid()});
      await verifyAccount(context.account.id, context);
      return store.prepare({account: context.account, draft, payload, origin, summary: {title: draft.title, assetCount: draft.assets.length, kind: draft.kind, visibility: draft.settings.visibility, scheduledAt: draft.settings.scheduledAt}});
    });
  }

  // publish 取得持久化防重资格后只发一次请求；不确定的网络结果永远记录为 unknown。
  async function publish(params, context, origin) {
    if (params?.expectedAccountId !== context.account.id) throw Error('确认账号与当前抖音账号不同，请重新准备。');
    return exclusive(context.account.id, async () => {
      await verifyAccount(context.account.id, context);
      const attempt = await store.beginSubmit({preparationId: params.preparationId, requestId: params.requestId, origin, expectedAccountId: context.account.id, confirmed: params.confirmed});
      if (attempt.duplicate) return attempt.result;
      let result;
      try {
        const response = await creator('publication.publish', {payload: attempt.payload, expectedAccountId: context.account.id}, context);
        result = response.data;
        await verifyAccount(context.account.id, context);
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
    await verifyAccount(context.account.id, context);
    // 当前只核实“平台存在记录”，不将未知审核状态解释成已发布。
    return store.finish(result.preparationId, {publicationId: result.publicationId, status: 'processing', message: remote.message || '已取得平台作品记录，实际发布状态请在创作者中心确认。'});
  }

  // dispatch 是 App 唯一业务入口，未列入能力清单的操作一律拒绝。
  async function dispatch(operation, params = {}, {origin, progress, signal, expectedAccountId} = {}) {
    checkedOrigin(origin);
    if (!OPERATIONS.includes(operation)) throw Error('此功能尚未接入实验工作台。');
    throwIfCancelled(signal);
    // 发布开始后必须取得并持久化真实或未知回执；UI 不提供撤销提交的假承诺。
    const operationSignal = operation === 'publication.publish' ? undefined : signal;
    const scope = {origin, generation, signal: operationSignal, expectedAccountId, readOnly: QUERY_OPERATIONS.includes(operation) || ['declarations.list', 'music.categories', 'activities.detail', 'activities.resolve'].includes(operation)};
    const scopedSend = async (url, options = {}) => {
      requireContext(scope);
      const response = await send(url, {...options, signal: combineSignals(operationSignal, options.signal)});
      requireContext(scope);
      return response;
    };
    try {
      const context = await session({...scope, send: scopedSend});
      let value;
      if (operation === 'studio.session') value = {connected: true, account: context.account, capabilities: capabilities()};
      else if (operation === 'declarations.list') value = await declarationOptions(params, context);
      else if (operation === 'music.categories') { value = await musicCategories(params, context, origin); await verifyReadSession(context); }
      else if (operation === 'activities.detail') { value = (await creator('activities.detail', {id: params.id}, context)).data; await verifyReadSession(context); }
      else if (operation === 'activities.resolve') value = await selectActivity(params, context, origin);
      else if (QUERY_OPERATIONS.includes(operation)) value = await query(operation, params, context, origin);
      else if (operation === 'cover.upload') value = await uploadCover(params, context, origin);
      else if (operation === 'publication.prepare') value = await prepare(params, context, origin, progress);
      else if (operation === 'publication.publish') return publish(params, context, origin);
      else if (operation === 'publication.status') value = await publicationStatus(params, context, origin);
      if (operation === 'studio.session') {
        // 显式检查已经取得真实身份，保存同一已识别档案的短期读取资格，避免紧接着再查一遍账号。
        const binding = await nativeBinding(context, {allowUnidentified: true});
        if (binding && context.account.id !== binding.accountId) throw Object.assign(Error('实际抖音账号与所选账号不一致，请重新登录。'), {code: 'SESSION_IDENTITY_MISMATCH'});
        if (binding) readIdentity = {key: binding.key, account: context.account, verifiedAt: now()};
      } else if (!context.readOnly) await verifyAccount(context.account.id, context);
      requireContext(context);
      return value;
    } catch (error) {
      throwIfCancelled(operationSignal);
      if (scope.generation === generation) {
        readIdentity = null;
        queryPages.clear();
        // 查询失败后重试重新读取分类，避免平台分类变更导致持续复用已失效的分类入口。
        for (const key of cache.keys()) if (key.startsWith('studio-music-categories:')) cache.delete(key);
        if (['SESSION_CHANGED', 'SESSION_EXPIRED', 'ACCOUNT_CHANGED'].includes(error.code)) invalidate();
      }
      throw error;
    }
  }

  // invalidate 清理临时查询证据；持久化的发布回执和上传检查点仍按账号隔离保留。
  function invalidate() { generation++; readIdentity = null; cache.clear(); queryPages.clear(); }
  return {dispatch, invalidate};
}
