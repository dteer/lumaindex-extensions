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

const QUERY_OPERATIONS = ['topics.search', 'users.search', 'music.search', 'locations.search', 'collections.list'];
const OPERATIONS = ['studio.session', ...QUERY_OPERATIONS, 'cover.upload', 'publication.prepare', 'publication.publish', 'publication.status'];
const PLATFORM_ID = /^\d{1,30}$/;
const LOCAL_ID = /^[a-zA-Z0-9_-]{1,100}$/;

// capabilities 只公布已接入的固定操作；视频的未验证选项不能因图文支持而被启用。
export function capabilities() {
  return {
    operations: [...OPERATIONS],
    limits: {imageCount: 35, titleLength: 20, descriptionLength: 1000, imageBytes: 50 * 1024 * 1024, videoBytes: 80 * 1024 * 1024, coverBytes: 50 * 1024 * 1024},
    options: {
      visibility: [{value: 'public', label: '公开'}, {value: 'friends', label: '好友可见'}, {value: 'private', label: '仅自己可见'}],
      download: [{value: 'allow', label: '允许保存'}, {value: 'deny', label: '不允许保存'}],
    },
    declarations: [],
    byKind: {video: {disabledOperations: ['music.search', 'locations.search', 'collections.list']}},
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
export function createStudioEngine({storage, send, publicationStore, now = Date.now, uuid = () => crypto.randomUUID(), upload = {}, libraryAsset} = {}) {
  if (!storage?.get || !storage?.set || typeof send !== 'function') throw Error('App 会话和持久化接口尚未就绪。');
  const store = publicationStore || createPublicationStore({storage, now, uuid});
  const cache = new Map();
  const media = {resolveAssets, prepareFile, importImages, importVideo, uploadImage, uploadVideo, cropCoverFile, ...upload};
  const accountTasks = new Set();

  // creator 由宿主发送固定 HTTPS 请求，业务参数不依赖宿主标签页或页面运行时。
  async function creator(operation, params = {}, context) {
    throwIfCancelled(context?.signal);
    const result = await createCreatorAPI(context?.send || send)(operation, params);
    throwIfCancelled(context?.signal);
    if (result?.ok !== true) throw Object.assign(Error(publicError({message: result?.error})), {definiteFailure: result?.definiteFailure === true});
    return result;
  }

  // currentAccount 始终读取平台当前身份，不用宿主连接或旧缓存推定已登录。
  async function currentAccount(context) {
    const account = (await creator('account', {}, context)).data;
    if (!account || !PLATFORM_ID.test(account.id) || typeof account.name !== 'string' || !account.name) throw Error('无法确认当前抖音账号，请重新登录抖音后重试。');
    return account;
  }

  // verifyAccount 在长任务和候选查询前后核对同一标签页身份，切换账号立即停止。
  async function verifyAccount(expected, context) {
    const account = await currentAccount(context);
    if (account.id !== expected) throw Object.assign(Error('抖音账号已变化，请重新连接并准备当前账号的作品。'), {code: 'ACCOUNT_CHANGED'});
    return account;
  }

  // session 只读取宿主临时会话对应的真实平台账号，不能由 UI 或连接状态推定账号。
  async function session(context) { return {...context, account: await currentAccount(context)}; }

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
    if (operation === 'locations.search') {
      Object.assign(result, {cityCode: input.cityCode, cityName: input.cityName});
      validateLocationQuery({cityCode: result.cityCode, cityName: result.cityName, keyword: result.query, page: cursor === '0' ? 1 : Number(cursor)});
    }
    return result;
  }

  // fetchCandidates 读取真实列表；音乐仅支持推荐和已知抖音音乐链接。
  async function fetchCandidates(operation, params, context, origin) {
    const {account} = context;
    await verifyAccount(account.id, context);
    let data;
    if (operation === 'locations.search') {
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
      data = {items: result.items.filter(item => !params.query || item.title.includes(params.query)).map(item => ({id: item.id, name: item.title, order: item.order, description: `下一集 ${item.order}`})), nextCursor: result.nextCursor};
    } else if (operation === 'music.search') {
      if (params.query) {
        let url;
        try { url = new URL(params.query); } catch {}
        if (!url || url.origin !== 'https://v.douyin.com' || url.username || url.password) throw Error('音乐暂不支持关键词搜索。留空查看推荐，或粘贴 https://v.douyin.com/ 音乐链接。');
        data = (await creator('music.validate', {query: url.href}, context)).data;
      } else {
        const categories = (await creator('music.categories', {}, context)).data?.items;
        const category = categories?.[0];
        if (!category) throw Error('当前账号没有可用的推荐音乐分类。');
        const key = cacheKey('music-browser', origin, account.id, 'context');
        let browsing = await readCache(key);
        if (!browsing || now() - browsing.createdAt < 0 || now() - browsing.createdAt >= 30 * 60 * 1000) {
          browsing = {creationId: uuid(), createdAt: now()};
          await writeCache(key, browsing);
        }
        data = (await creator('music.list', {category_id: category.id, type: category.type, cursor: params.cursor, creation_id: browsing.creationId}, context)).data;
      }
    } else data = (await creator(operation, {query: params.query, cursor: params.cursor}, context)).data;
    await verifyAccount(account.id, context);
    if (!data || !Array.isArray(data.items)) throw Error('平台候选格式已变化，请稍后重新查询。');
    const ids = new Set();
    data.items = data.items.filter(item => {
      if (!item || typeof item.id !== 'string' || !PLATFORM_ID.test(item.id) || typeof item.name !== 'string' || !item.name || item.name.length > 200 || ids.has(item.id)) return false;
      ids.add(item.id); return true;
    });
    return data;
  }

  // query 保存最少来源证据；播放和头像 URL 只返回界面，不持久化为候选身份。
  async function query(operation, input, context, origin) {
    const params = queryParams(operation, input), data = await fetchCandidates(operation, params, context, origin);
    for (const item of data.items) {
      const identity = {id: item.id, name: item.name};
      for (const key of ['duration', 'order', 'cityCode', 'cityName']) if (item[key] !== undefined) identity[key] = item[key];
      await writeCache(cacheKey('candidate', origin, context.account.id, `${operation}:${item.id}`), {operation, params, item: identity, queriedAt: now()});
    }
    return data;
  }

  // resolveChoice 要求选择来自当前来源账号的真实查询，并重新执行原查询核对身份与名称。
  async function resolveChoice(operation, selected, context, origin) {
    if (!selected) return null;
    const record = await readCache(cacheKey('candidate', origin, context.account.id, `${operation}:${selected.id}`));
    if (!record || record.operation !== operation || record.item?.id !== selected.id || record.item.name !== selected.name) throw Error('所选项目没有当前账号的查询记录，请重新搜索并选择。');
    // 推荐音乐会动态重排；只复用当前来源账号 30 分钟内的真实候选，不信任前端时长。
    if (operation === 'music.search') {
      const age = now() - record.queriedAt;
      if (!Number.isFinite(age) || age < 0 || age >= 30 * 60 * 1000) throw Error('音乐选择已超过 30 分钟，请重新读取并选择。');
      return structuredClone(record.item);
    }
    const result = await fetchCandidates(operation, queryParams(operation, record.params), context, origin);
    const match = result.items.find(item => item.id === selected.id);
    if (!match || match.name !== selected.name) throw Error('所选项目已变化或不可用，请重新搜索并选择。');
    return match;
  }

  // resolveChoices 不信任 App 提交的平台附加字段，只使用刚从固定查询取得的业务值。
  async function resolveChoices(draft, context, origin) {
    const topics = [], mentions = [];
    for (const item of draft.topics) topics.push(await resolveChoice('topics.search', item, context, origin));
    for (const item of draft.mentions) mentions.push(await resolveChoice('users.search', item, context, origin));
    const music = await resolveChoice('music.search', draft.music, context, origin);
    if (music && (!Number.isFinite(music.duration) || music.duration <= 0)) throw Error('此音乐未返回可确认时长，请重新选择推荐音乐。');
    const location = await resolveChoice('locations.search', draft.location, context, origin);
    if (location?.requiresNativeSelection) throw Error('此地点需要平台额外确认，请清除地点后继续。');
    const collection = await resolveChoice('collections.list', draft.collection, context, origin);
    draft.topics = topics.map(({id, name}) => ({id, name})); draft.mentions = mentions.map(({id, name}) => ({id, name}));
    return {music, location, collection};
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
      const job = {id: draft.id, kind: draft.kind, assets: draft.assets, settings: {}};
      if (draft.cover?.type === 'asset' && draft.cover.crop) Object.assign(job.settings, {coverIndex: draft.assets.findIndex(item => item.id === draft.cover.assetId), coverCrop: draft.cover.crop});
      const key = cacheKey('uploads', origin, context.account.id, draft.id), previous = (await readCache(key))?.records || [];
      const checkpoint = records => writeCache(key, {records, updatedAt: now()});
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
      // 长时间上传后重查选项，尤其是合集集数，不能使用上传开始时的旧值。
      selected = await resolveChoices(draft, context, origin);
      let cover;
      if (draft.cover?.type === 'upload') cover = await imageCoverRecord(draft.cover.id, context, origin);
      else if (draft.kind === 'image') {
        const index = draft.cover?.type === 'asset' ? draft.assets.findIndex(item => item.id === draft.cover.assetId) : 0;
        cover = prepared.draft.cover || prepared.draft.images?.[index];
      }
      validateStudioDraft(draft, {...capabilities(), now: now()});
      const payload = buildPublicationPayload({draft, ...prepared.draft, ...selected, cover, creationId: uuid()});
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
  async function dispatch(operation, params = {}, {origin, progress, signal} = {}) {
    checkedOrigin(origin);
    if (!OPERATIONS.includes(operation)) throw Error('此功能尚未接入实验工作台。');
    throwIfCancelled(signal);
    // 发布开始后必须取得并持久化真实或未知回执；UI 不提供撤销提交的假承诺。
    const operationSignal = operation === 'publication.publish' ? undefined : signal;
    const scopedSend = (url, options = {}) => {
      throwIfCancelled(operationSignal);
      return send(url, {...options, signal: combineSignals(operationSignal, options.signal)});
    };
    try {
      const context = await session({signal: operationSignal, send: scopedSend});
      let value;
      if (operation === 'studio.session') value = {connected: true, account: context.account, capabilities: capabilities()};
      else if (QUERY_OPERATIONS.includes(operation)) value = await query(operation, params, context, origin);
      else if (operation === 'cover.upload') value = await uploadCover(params, context, origin);
      else if (operation === 'publication.prepare') value = await prepare(params, context, origin, progress);
      else if (operation === 'publication.publish') return publish(params, context, origin);
      else if (operation === 'publication.status') value = await publicationStatus(params, context, origin);
      await verifyAccount(context.account.id, context);
      return value;
    } catch (error) { throwIfCancelled(operationSignal); throw error; }
  }

  // invalidate 清理临时查询证据；持久化的发布回执和上传检查点仍按账号隔离保留。
  function invalidate() { cache.clear(); }
  return {dispatch, invalidate};
}
