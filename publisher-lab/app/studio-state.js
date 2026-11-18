// 独立工作台只持久化可读的小型作品数据，不保存媒体、路径、上传凭据或平台会话。
export const MAX_DRAFTS = 40;
export const DRAFT_STATE_VERSION = 2;
// 旧版最多 20000 字正文及各 50 个、每名 500 字的话题/提及；迁入正文后仍须完整保留。
const MAX_DESCRIPTION_LENGTH = 20000 + 2 * 50 * 502;
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

// topicKey 按平台身份区分已有话题；名称话题共用官方 0 标记，因此按名称区分。
export function topicKey(value) {
  return value.id === '0' ? 'name:' + value.name : 'id:' + value.id;
}

// entitiesValue 去重保存作品明确选择的话题、提及或声明资源。
function entitiesValue(values, topics = false) {
  const seen = new Set();
  const entities = (Array.isArray(values) ? values : []).map(entityValue).filter(Boolean);
  const knownNames = new Set(topics ? entities.filter(value => value.id !== '0').map(value => value.name) : []);
  return entities.filter(value => {
    if (topics && value.id === '0' && (!value.name || knownNames.has(value.name))) return false;
    const key = topics ? topicKey(value) : value.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 50);
}

// activitiesValue 分开保存活动身份和发布话题身份，不持久化平台热度、详情或临时地址。
function activitiesValue(values) {
  const seen = new Set();
  return (Array.isArray(values) ? values : []).flatMap(value => {
    const activity = entityValue(value), topic = entityValue(value?.topic);
    if (!activity || !topic || seen.has(activity.id)) return [];
    seen.add(activity.id);
    return [{...activity, topic}];
  }).slice(0, 5);
}

// emptyDraft 创建独立作品；不预设账号，不虚构上传或发布结果。
export function emptyDraft(kind = 'image') {
  return {
    id: newID(), name: kind === 'video' ? '未命名视频' : '未命名图文', kind,
    assets: [], title: '', description: '', aiContext: '', topics: [], mentions: [], activities: [],
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
  result.description = textValue(source.description, MAX_DESCRIPTION_LENGTH);
  result.aiContext = textValue(source.aiContext, 6000);
  const seen = new Set();
  result.assets = (Array.isArray(source.assets) ? source.assets : []).filter(asset => {
    if (!asset || !textValue(asset.id) || !kinds.has(asset.kind) || seen.has(asset.id)) return false;
    seen.add(asset.id);
    return true;
  }).slice(0, 100).map(asset => ({id: textValue(asset.id), name: textValue(asset.name, 500), kind: asset.kind, ...(asset.localOnly === true ? {localOnly: true} : {})}));
  result.topics = entitiesValue(source.topics, true);
  result.mentions = entitiesValue(source.mentions);
  result.activities = activitiesValue(source.activities);
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
  const {receipt, updatedAt, name, aiContext, ...draft} = sanitizeDraft(raw);
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

// migrateVersion1 将旧版独立话题和提及一次性转为可见正文，不修改资源身份或已有文本。
function migrateVersion1(raw) {
  const drafts = (Array.isArray(raw.drafts) ? raw.drafts : []).slice(0, MAX_DRAFTS).map(value => {
    const draft = sanitizeDraft(value);
    let body = textValue(value?.description, 20000);
    const occupied = [];
    for (const [values, prefix] of [[draft.topics, '#'], [draft.mentions, '@']]) {
      for (const entity of values) {
        const name = entity.name.trim();
        if (!name) continue;
        const token = prefix + name;
        let start = -1, candidate = body.indexOf(token);
        while (candidate >= 0) {
          const before = Array.from(body.slice(0, candidate)).at(-1), after = Array.from(body.slice(candidate + token.length))[0];
          const boundary = character => !character || !/[\p{L}\p{N}\p{M}_#@]/u.test(character);
          const overlaps = occupied.some(range => candidate < range.end && candidate + token.length > range.start);
          if (!overlaps && boundary(before) && boundary(after)) { start = candidate; break; }
          candidate = body.indexOf(token, candidate + token.length);
        }
        if (start < 0) {
          if (body && !/\s$/u.test(body)) body += ' ';
          start = body.length;
          body += token;
        }
        occupied.push({start, end: start + token.length});
      }
    }
    draft.description = body;
    return draft;
  });
  return {...raw, version: DRAFT_STATE_VERSION, drafts};
}

// normalizeState 先迁移本工作台旧版本，再只使用当前正文模型；不读取原发布助手草稿。
export function normalizeState(raw) {
  const current = raw?.version === 1 ? migrateVersion1(raw) : raw;
  const drafts = current?.version === DRAFT_STATE_VERSION && Array.isArray(current.drafts) ? current.drafts.slice(0, MAX_DRAFTS).map(sanitizeDraft) : [];
  const unique = drafts.filter((draft, index) => drafts.findIndex(item => item.id === draft.id) === index);
  if (!unique.length) unique.push(emptyDraft());
  return {
    version: DRAFT_STATE_VERSION, activeDraftId: unique.some(draft => draft.id === current?.activeDraftId) ? current.activeDraftId : unique[0].id,
    drafts: unique,
    aiPrompt: textValue(current?.aiPrompt, 8000),
    handledTransfers: (Array.isArray(current?.handledTransfers) ? current.handledTransfers : []).filter(value => typeof value === 'string').slice(-50).map(value => value.slice(0, 200)),
  };
}

// StudioStore 串行等待宿主确认；保存失败不会撤销内存草稿，用户可显式重试。
export class StudioStore {
  constructor(initial, writer) {
    this.data = normalizeState(initial);
    this.writer = writer;
    this.pending = Promise.resolve();
    // 升级结果需由界面沿用保存/失败重试流程写回，不能在尚未确认落盘时显示为已保存。
    this.revision = initial?.version === 1 ? 1 : 0;
    this.savedRevision = 0;
  }

  // current 返回当前草稿，不隐式创建或切换作品。
  current() {
    return this.data.drafts.find(draft => draft.id === this.data.activeDraftId) || this.data.drafts[0];
  }

  // touch 标记指定草稿变化；异步回执可更新发起查询的草稿，不误改当前编辑中的另一草稿。
  touch(draft = this.current()) {
    this.revision += 1;
    draft.updatedAt = new Date().toISOString();
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
    if (!this.data.drafts.some(draft => draft.id === id)) return;
    this.data.drafts = this.data.drafts.filter(draft => draft.id !== id);
    if (!this.data.drafts.length) this.data.drafts.push(emptyDraft());
    if (this.data.activeDraftId === id) this.data.activeDraftId = this.data.drafts[0].id;
    this.revision += 1;
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
