// 抖音图文草稿的数据契约，来自 2026-11-16 发布页 image 字段的 beforeCache/backfillCache。
// 扩展只生成可恢复的 JSON，不调用页面组件、编辑器或上传器。
const visibilityTypes = Object.freeze({public: 0, friends: 2, private: 1});

// isRecord 排除数组及空值，避免把错误响应误当作草稿或上传资源。
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// cloneJSON 拷贝持久化数据；返回值及后续人工编辑均不应修改传入的资源检查点。
function cloneJSON(value) {
  return JSON.parse(JSON.stringify(value));
}

// validateUploadFile 只接收已确认完成且包含图片尺寸的远端资源。
export function validateUploadFile(file) {
  if (!isRecord(file) || typeof file.uri !== 'string' || !file.uri || file.uriStatus !== 2000 ||
      !Number.isFinite(file.imageWidth) || file.imageWidth <= 0 ||
      !Number.isFinite(file.imageHeight) || file.imageHeight <= 0) {
    throw Error('图片尚未取得完整的上传结果，请重新带入。');
  }
  return file;
}

// validateDraftBase 禁止将已发表作品的编辑缓存转换成新的发布草稿。
export function validateDraftBase(base) {
  if (base === null || base === undefined) return {};
  if (!isRecord(base) || (base.files !== undefined && !Array.isArray(base.files))) {
    throw Error('抖音草稿结构已变化，请保留现有内容并重新打开发布页。');
  }
  if (base.reEditId || base.modifyId || base.scheduleItemId || base.rawModifyItem || base.rawScheduleInfo) {
    throw Error('当前内容属于已提交作品，不能覆盖为新的图文草稿。');
  }
  return base;
}

// localSchedule 把 App 的 ISO 时间转换为原生草稿使用的本地分钟值；相对时间范围由任务入口校验。
function localSchedule(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw Error('定时发布时间无效，请重新选择。');
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// locationAnchor 将查询得到的真实地点映射到原生位置标签，保留服务端附加字段。
function locationAnchor(location) {
  if (location === null) return {type: -11, id: '', payload: '', extra: null};
  if (!isRecord(location) || typeof location.id !== 'string' || !/^\d{1,30}$/.test(location.id) ||
      typeof location.name !== 'string' || !location.name || location.name.length > 200) {
    throw Error('位置无效，请重新选择地点。');
  }
  // 普通地点在平台恢复已有作品时也允许缺少 extra；已有查询附加数据必须完整保留。
  let extra;
  if (location.extra !== undefined) {
    try {
      const parsed = typeof location.extra === 'string' ? JSON.parse(location.extra) : location.extra;
      if (!isRecord(parsed)) throw Error();
      extra = JSON.stringify(parsed);
    } catch {
      throw Error('地点附加信息无效，请重新搜索并选择。');
    }
  }
  return {type: -11, id: location.id, payload: location.name, ...(extra === undefined ? {} : {extra})};
}

// withDraftCollection 将重新查询确认的普通合集写入对应原生恢复契约；null 表示明确清除。
// collection 的 order/info 只能由扩展查询提供；函数不联网、不修改原对象，也不保留付费或短剧选择。
export function withDraftCollection(source, collection, kind = 'image') {
  if (collection === undefined) return source;
  if (!['image','video'].includes(kind)) throw Error('合集发布类型无效，请重新选择。');
  const draft = kind === 'video' ? source.cache : source;
  if (!isRecord(draft)) throw Error('合集草稿信息无效，请重新带入。');
  if (collection !== null) {
    if (!isRecord(collection) || typeof collection.id !== 'string' || !/^\d{1,30}$/.test(collection.id) ||
        typeof collection.title !== 'string' || !collection.title.trim() || collection.title.length > 200 ||
        !Number.isSafeInteger(collection.order) || collection.order < 1 ||
        (kind === 'video' && (!isRecord(collection.info) || collection.info.mix_id !== collection.id || collection.info.mix_name !== collection.title || collection.info.type !== 0))) {
      throw Error('合集尚未取得有效的查询结果，请重新读取并选择。');
    }
    if (draft.visibilityType !== 0) throw Error('加入合集的作品需要公开可见，请调整可见范围或清除合集。');
  }
  if (kind === 'image') return {...draft,collectionInfo:collection ? {mix_id:collection.id,mix_name:collection.title,mix_order:collection.order} : null};
  // 视频用独立字段恢复合集及集数，mix 是当前下拉列表索引，不能把合集 ID 或分页序号当成索引。
  const cache = {...draft,mix:-2,mixType:0,mixId:collection?.id ?? null,mixOrder:collection?.order ?? null,
    mixInfo:collection ? cloneJSON(collection.info) : {},
    mixOriginInfo:collection ? {mixId:collection.id,mixOrder:collection.order,mixName:collection.title} : {},
    playletId:null,playletOrder:null,playletInfo:{},playletOriginInfo:{}};
  return {...source,cache};
}

// buildImageDraft 将 App 的完整快照一次性合并到本地草稿，files/cover 均为上传成功的 uploadFile 对象。
// base 仅可来自同一绑定草稿；首次带入应传 null，不能继承其他作品。函数不读写存储或联网。
export function buildImageDraft({base = null, job, files, cover} = {}) {
  const previous = validateDraftBase(base);
  if (!isRecord(job) || (job.kind !== undefined && job.kind !== 'image') ||
      typeof job.title !== 'string' || job.title.length > 20 || /[\r\n]/.test(job.title) ||
      typeof job.description !== 'string' || job.description.length > 1000) {
    throw Error('图文标题或描述无效，请检查后重新带入。');
  }
  if (!Array.isArray(files) || files.length < 1 || files.length > 35) {
    throw Error('请准备 1–35 张上传完成的图片。');
  }
  files.forEach(validateUploadFile);
  if (new Set(files.map(file => file.uri)).size !== files.length) {
    throw Error('图片资源重复，请重新核对素材。');
  }
  if (cover !== undefined) validateUploadFile(cover);
  const settings = job.settings ?? {visibility: 'public', download: 'allow', publishTime: 'now'};
  if (!isRecord(settings) || !Object.hasOwn(visibilityTypes, settings.visibility) ||
      !['allow', 'deny'].includes(settings.download) || !['now', 'scheduled'].includes(settings.publishTime)) {
    throw Error('发布设置无效，请重新选择。');
  }
  if (settings.coverIndex !== undefined && cover === undefined) {
    throw Error('选定的封面尚未上传完成，请重新带入。');
  }
  if (settings.collection === undefined && previous.collectionInfo?.mix_id && settings.visibility !== 'public') {
    throw Error('已加入合集的作品需要公开可见，请调整发布设置。');
  }
  // 默认值取自原生字段定义；未由 App 管理的配乐、声明等保留同一草稿中的原值。
  const draft = {
    audio: null,
    hotspot: '',
    anchor: {type: -11, id: '', extra: null, payload: ''},
    videoId: '',
    reEditId: '',
    modifyId: '',
    openSync: {sync: 0},
    ...cloneJSON(previous),
    title: job.title,
    text: job.description,
    text_extra: [],
    activity: [],
    files: files.map(uploadFile => ({uploadFile: cloneJSON(uploadFile)})),
    visibilityType: visibilityTypes[settings.visibility],
    download: settings.download === 'allow' ? 1 : 0,
    scheduleTime: settings.publishTime === 'scheduled' ? localSchedule(settings.scheduledAt) : -1,
    // 仅保留本次素材已有的声明元数据，不凭空把未读取的 AIGC 标记写为空。
    metaMap: Object.fromEntries(files.filter(file => Object.hasOwn(previous.metaMap || {}, file.uri))
      .map(file => [file.uri, cloneJSON(previous.metaMap[file.uri])])),
  };
  if (Object.hasOwn(settings, 'location')) draft.anchor = locationAnchor(settings.location);
  // 成品封面与正文使用同一种上传资源，采用原生自定义封面的 upload_uri 格式。
  const selectedCover = cover || (!draft.coverInfo ? files[0] : null);
  if (selectedCover) draft.coverInfo = {upload_uri: selectedCover.uri, uri: '', url: ''};
  return withDraftCollection(draft,settings.collection,'image');
}

// buildVideoDraft 生成原生视频恢复缓存；视频必须已经上传并完成平台转码。
// 协议来自 40396/98261/22855/51760 模块，外层 cache 与图文草稿格式不同。
export function buildVideoDraft({base = null, job, video} = {}) {
  if (base !== null && base !== undefined && (!isRecord(base) || !isRecord(base.cache))) {
    throw Error('抖音视频草稿结构已变化，请保留现有内容并重新打开发布页。');
  }
  const previous = validateDraftBase(base?.cache);
  if (previous.modifyItemId || previous.rawModifyInfo) {
    throw Error('当前内容属于已提交作品，不能覆盖为新的视频草稿。');
  }
  if (!isRecord(job) || job.kind !== 'video' || typeof job.title !== 'string' ||
      job.title.length > 20 || /[\r\n]/.test(job.title) ||
      typeof job.description !== 'string' || job.description.length > 1000) {
    throw Error('视频标题或描述无效，请检查后重新带入。');
  }
  if (!isRecord(video) || typeof video.vid !== 'string' || !video.vid ||
      typeof video.coverUri !== 'string' || !video.coverUri ||
      !['duration', 'width', 'height', 'size'].every(key => Number.isFinite(video[key]) && video[key] > 0) ||
      typeof video.name !== 'string' || !video.name || typeof video.type !== 'string' || !video.type.startsWith('video/')) {
    throw Error('视频尚未取得完整的转码结果，请等待处理完成后重试。');
  }
  const settings = job.settings ?? {visibility: 'public', download: 'allow', publishTime: 'now'};
  if (!isRecord(settings) || !Object.hasOwn(visibilityTypes, settings.visibility) ||
      !['allow', 'deny'].includes(settings.download) || !['now', 'scheduled'].includes(settings.publishTime)) {
    throw Error('发布设置无效，请重新选择。');
  }
  if (settings.collection === undefined && previous.mixId && settings.visibility !== 'public') throw Error('已加入合集的作品需要公开可见，请调整发布设置。');
  const fileInfo = Object.fromEntries(['name', 'size', 'vid', 'duration', 'coverUri', 'type', 'width', 'height']
    .map(key => [key, video[key]]));
  const cache = {
    anchorType: -11,
    anchorId: '',
    anchorPayload: '',
    anchorExtra: null,
    anchorTipChecked: false,
    scheduleItemId: '',
    rawScheduleInfo: null,
    ...cloneJSON(previous),
    longStatus: 2,
    longFileInfo: fileInfo,
    longFileMetaInfo: {...fileInfo},
    textResult: {text: job.description, textExtra: [], activity: [], caption: ''},
    itemTitle: job.title,
    visibilityType: visibilityTypes[settings.visibility],
    download: settings.download === 'allow' ? 1 : 0,
    scheduleTime: settings.publishTime === 'scheduled' ? localSchedule(settings.scheduledAt) : -1,
  };
  // 更换视频时旧封面不属于新素材；首帧由已完成转码的资源提供，不凭空写可发布标记。
  if (previous.longFileInfo?.vid !== video.vid || !cache.coverInfo) {
    cache.coverInfo = {uri: video.coverUri, posterDelay: 0};
    cache.coverHorizontalInfo = null;
    cache.pasterInfo = {uri: '', text: ''};
    cache.xiguaCoverInfo = {uri: video.coverUri, posterDelay: 0};
  }
  if (Object.hasOwn(settings, 'location')) {
    const anchor = locationAnchor(settings.location);
    cache.anchorType = anchor.type;
    cache.anchorId = anchor.id;
    cache.anchorPayload = anchor.payload;
    cache.anchorExtra = anchor.extra ?? null;
  }
  return withDraftCollection({cache},settings.collection,'video');
}
