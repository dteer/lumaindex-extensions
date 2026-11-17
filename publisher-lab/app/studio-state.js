// 独立工作台只持久化可读的小型作品数据，不保存媒体、路径、上传凭据或平台会话。
export const MAX_DRAFTS = 40;
const kinds = new Set(['image', 'video']);
const statuses = new Set(['published', 'scheduled', 'processing', 'failed', 'unknown']);

// newID 为本机草稿和明确提交动作生成独立身份。
export function newID() {
  return globalThis.crypto?.randomUUID?.() || `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// textValue 限制持久化字段大小，并拒绝把对象隐式转为字符串。
function textValue(value, limit = 300) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

// entityValue 只保留公开资源身份与名称，不复制搜索返回的 URL 或临时凭据。
export function entityValue(value) {
  if (!value || !textValue(value.id)) return null;
  return {id: textValue(value.id), name: textValue(value.name, 500)};
}

// entitiesValue 去重保存作品明确选择的话题、提及或声明资源。
function entitiesValue(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).map(entityValue).filter(value => {
    if (!value || seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  }).slice(0, 50);
}

// emptyDraft 创建独立作品；不预设账号，不虚构上传或发布结果。
export function emptyDraft(kind = 'image') {
  return {
    id: newID(), name: kind === 'video' ? '未命名视频' : '未命名图文', kind,
    assets: [], title: '', description: '', topics: [], mentions: [],
    music: null, location: null, collection: null, cover: null,
    settings: {visibility: 'public', download: 'allow', publishTime: 'now', scheduledAt: '', declarations: []},
    updatedAt: new Date().toISOString(), receipt: null,
  };
}

// coverValue 只保存封面的资源身份、帧时间及归一化裁剪参数。
function coverValue(value) {
  if (!value || !['asset', 'frame', 'upload'].includes(value.type)) return null;
  const result = {type: value.type};
  for (const key of ['assetId', 'id', 'name']) if (typeof value[key] === 'string') result[key] = textValue(value[key], key === 'name' ? 500 : 300);
  if (Number.isFinite(value.timeMs) && value.timeMs >= 0) result.timeMs = Math.round(value.timeMs);
  if (value.localOnly === true) result.localOnly = true;
  const crop = value.crop;
  if (crop && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(crop[key]) && crop[key] >= 0 && crop[key] <= 1)) {
    result.crop = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, crop[key]]));
  }
  return result;
}

// sanitizeDraft 对本机恢复数据执行白名单归一化，防止平台返回值进入持久化。
export function sanitizeDraft(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const kind = kinds.has(source.kind) ? source.kind : 'image';
  const result = emptyDraft(kind);
  result.id = textValue(source.id) || result.id;
  result.name = textValue(source.name, 100) || result.name;
  result.title = textValue(source.title, 2000);
  result.description = textValue(source.description, 20000);
  const seen = new Set();
  result.assets = (Array.isArray(source.assets) ? source.assets : []).filter(asset => {
    if (!asset || !textValue(asset.id) || !kinds.has(asset.kind) || seen.has(asset.id)) return false;
    seen.add(asset.id);
    return true;
  }).slice(0, 100).map(asset => ({id: textValue(asset.id), name: textValue(asset.name, 500), kind: asset.kind, ...(asset.localOnly === true ? {localOnly: true} : {})}));
  result.topics = entitiesValue(source.topics);
  result.mentions = entitiesValue(source.mentions);
  for (const key of ['music', 'location', 'collection']) result[key] = entityValue(source[key]);
  if (result.location && source.location?.cityCode) {
    result.location.cityCode = textValue(source.location.cityCode, 30);
    result.location.cityName = textValue(source.location.cityName, 100);
  }
  result.cover = coverValue(source.cover);
  const settings = source.settings || {};
  result.settings = {
    visibility: textValue(settings.visibility, 50) || 'public',
    download: textValue(settings.download, 50) || 'allow',
    publishTime: settings.publishTime === 'scheduled' ? 'scheduled' : 'now',
    scheduledAt: textValue(settings.scheduledAt, 80),
    declarations: [...new Set((Array.isArray(settings.declarations) ? settings.declarations : []).filter(value => typeof value === 'string'))].slice(0, 30).map(value => value.slice(0, 150)),
  };
  result.updatedAt = textValue(source.updatedAt, 60) || result.updatedAt;
  if (source.receipt && statuses.has(source.receipt.status)) {
    result.receipt = {
      status: source.receipt.status, requestId: textValue(source.receipt.requestId),
      publicationId: textValue(source.receipt.publicationId),
      message: textValue(source.receipt.message, 1000), updatedAt: textValue(source.receipt.updatedAt, 60),
    };
  }
  return result;
}

// publicationDraft 生成单次提交快照；本机草稿名称、回执等不会误入平台作品字段。
export function publicationDraft(raw) {
  const {receipt, updatedAt, name, ...draft} = sanitizeDraft(raw);
  if (draft.settings.publishTime === 'scheduled' && draft.settings.scheduledAt) {
    const timestamp = new Date(draft.settings.scheduledAt);
    if (Number.isFinite(timestamp.getTime())) draft.settings.scheduledAt = timestamp.toISOString();
  }
  return draft;
}

// contentSignature 精确比较可发布内容，任何作品变更都会使上传准备失效。
export function contentSignature(draft) {
  return JSON.stringify(publicationDraft(draft));
}

// normalizeState 恢复本工作台数据，不读取或迁移原发布助手草稿。
export function normalizeState(raw) {
  const drafts = raw?.version === 1 && Array.isArray(raw.drafts) ? raw.drafts.slice(0, MAX_DRAFTS).map(sanitizeDraft) : [];
  const unique = drafts.filter((draft, index) => drafts.findIndex(item => item.id === draft.id) === index);
  if (!unique.length) unique.push(emptyDraft());
  return {
    version: 1, activeDraftId: unique.some(draft => draft.id === raw?.activeDraftId) ? raw.activeDraftId : unique[0].id,
    drafts: unique,
    handledTransfers: (Array.isArray(raw?.handledTransfers) ? raw.handledTransfers : []).filter(value => typeof value === 'string').slice(-50).map(value => value.slice(0, 200)),
  };
}

// StudioStore 串行等待宿主确认；保存失败不会撤销内存草稿，用户可显式重试。
export class StudioStore {
  constructor(initial, writer) {
    this.data = normalizeState(initial);
    this.writer = writer;
    this.pending = Promise.resolve();
    this.revision = 0;
    this.savedRevision = 0;
  }

  // current 返回当前草稿，不隐式创建或切换作品。
  current() {
    return this.data.drafts.find(draft => draft.id === this.data.activeDraftId) || this.data.drafts[0];
  }

  // touch 标记本机内容变化，持久化动作由调用方统一调度。
  touch() {
    this.revision += 1;
    this.current().updatedAt = new Date().toISOString();
  }

  // add 在上限内创建草稿，达到上限时保留所有已有作品。
  add(kind = 'image') {
    if (this.data.drafts.length >= MAX_DRAFTS) throw Error(`最多保留 ${MAX_DRAFTS} 份本机草稿，请先删除不需要的草稿。`);
    const draft = emptyDraft(kind);
    this.data.drafts.unshift(draft);
    this.data.activeDraftId = draft.id;
    this.touch();
    return draft;
  }

  // copy 复制作品编辑字段，复制品没有原发布请求身份和回执。
  copy() {
    if (this.data.drafts.length >= MAX_DRAFTS) throw Error(`最多保留 ${MAX_DRAFTS} 份本机草稿。`);
    const draft = sanitizeDraft(this.current());
    draft.id = newID();
    draft.name = `${draft.name} 副本`.slice(0, 100);
    draft.receipt = null;
    this.data.drafts.unshift(draft);
    this.data.activeDraftId = draft.id;
    this.touch();
    return draft;
  }

  // remove 只删除指定本机草稿，至少保留一个空白编辑入口。
  remove(id) {
    this.data.drafts = this.data.drafts.filter(draft => draft.id !== id);
    if (!this.data.drafts.length) this.data.drafts.push(emptyDraft());
    if (this.data.activeDraftId === id) this.data.activeDraftId = this.data.drafts[0].id;
    this.touch();
  }

  // commit 顺序写入白名单快照；较早应答不会让较新修改错误显示为已保存。
  commit() {
    const revision = this.revision;
    const snapshot = normalizeState(this.data);
    const task = this.pending.catch(() => {}).then(async () => {
      await this.writer(snapshot);
      this.savedRevision = Math.max(this.savedRevision, revision);
    });
    this.pending = task;
    return task;
  }
}
