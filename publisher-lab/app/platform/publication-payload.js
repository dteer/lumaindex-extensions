// This module transforms verified business values only. It performs no network,
// browser storage, clock reads, platform-module calls, or publication side effects.

const VISIBILITY = Object.freeze({public: 0, friends: 2, private: 1});
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const PLATFORM_ID = /^[1-9]\d{0,29}$/;
const OWN = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/** fail reports a stable local error without exposing transport or credentials. */
function fail(message, code = 'INVALID_DRAFT') {
  throw Object.assign(new Error(message), {code});
}

/** record accepts a JSON object, never arrays or null. */
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** text validates bounded user text; newlines are allowed only where meaningful. */
function text(value, label, max, multiline = false) {
  if (typeof value !== 'string' || value.length > max ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
      (!multiline && /[\r\n\t]/u.test(value))) fail(`${label}格式或长度无效。`);
  return value;
}

/** identity retains only a real query identity and its display name. */
function identity(value, label) {
  if (!record(value) || typeof value.id !== 'string' || !PLATFORM_ID.test(value.id)) {
    fail(`请重新选择${label}，不能使用未经确认的身份。`);
  }
  const name = text(value.name, label, 200).trim();
  if (!name) fail(`请重新选择${label}。`);
  return {id: value.id, name};
}

/** identities rejects duplicates rather than silently altering explicit choices. */
function identities(values, label) {
  if (!Array.isArray(values)) fail(`${label}列表无效。`);
  const result = values.map(value => identity(value, label));
  if (new Set(result.map(value => value.id)).size !== result.length) fail(`${label}不能重复选择同一身份。`);
  return result;
}

/** topicIdentities also accepts the official explicit name-topic sentinel; other resources still require real IDs. */
function topicIdentities(values) {
  if (!Array.isArray(values)) fail('话题列表无效。');
  const result = values.map(value => {
    if (!record(value) || value.id !== '0') return identity(value, '话题');
    const name = text(value.name, '话题', 200).trim();
    if (!name) fail('请重新选择话题。');
    return {id: '0', name};
  });
  const identified = result.filter(value => value.id !== '0');
  if (new Set(identified.map(value => value.id)).size !== identified.length) fail('话题不能重复选择同一身份。');
  return result;
}

/** normalizeVisibility accepts the UI's named values and exact numeric aliases. */
function normalizeVisibility(value) {
  if (typeof value === 'string' && OWN(VISIBILITY, value)) return value;
  if (value === 0 || value === '0') return 'public';
  if (value === 2 || value === '2') return 'friends';
  if (value === 1 || value === '1') return 'private';
  fail('请选择有效的可见范围。');
}

/** normalizeDownload never coerces booleans, blanks, or arbitrary numbers. */
function normalizeDownload(value) {
  if (value === 'allow' || value === 1 || value === '1') return 'allow';
  if (value === 'deny' || value === 0 || value === '0') return 'deny';
  fail('请选择有效的保存权限。');
}

/** limit applies a stricter advertised limit without expanding this implementation. */
function limit(capabilities, name, maximum) {
  const value = capabilities?.limits?.[name];
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1) fail('服务能力限制无效。', 'INVALID_CAPABILITIES');
  return Math.min(value, maximum);
}

/** requireOperation checks an explicitly supplied capability allowlist. */
function requireOperation(capabilities, operation, label) {
  if (capabilities === undefined) return;
  if (!Array.isArray(capabilities.operations) || !capabilities.operations.includes(operation)) {
    fail(`${label}暂不可用，请清除此项后继续。`, 'UNSUPPORTED_FEATURE');
  }
}

/** bodyWithAssociations 复用正文中已选话题和用户的完整标记，缺失时追加，并生成 UTF-16 范围。 */
function bodyWithAssociations(draft) {
  let body = draft.description.trim();
  const extras = [];
  for (const [values, prefix, type] of [[draft.topics, '#', 1], [draft.mentions, '@', 0]]) {
    for (const value of values) {
      const token = prefix + value.name;
      let start = -1;
      // 按完整码点判断边界，不能把非 BMP 汉字/字母的代理项误当分隔符；同昵称用户各占一个范围。
      let candidate = body.indexOf(token);
      while (candidate >= 0) {
        const before = Array.from(body.slice(0, candidate)).at(-1), after = Array.from(body.slice(candidate + token.length))[0];
        const boundary = character => !character || !/[\p{L}\p{N}\p{M}_#@]/u.test(character);
        const occupied = extras.some(item => candidate < item.end && candidate + token.length > item.start);
        if (!occupied && boundary(before) && boundary(after)) { start = candidate; break; }
        candidate = body.indexOf(token, candidate + token.length);
      }
      if (start < 0) {
        if (body) body += ' ';
        start = body.length;
        body += token;
      }
      const end = start + token.length;
      extras.push({start, end, caption_start: start, caption_end: end,
        type, hashtag_name: type === 1 ? value.name : '',
        hashtag_id: type === 1 && value.id !== '0' ? value.id : 0, user_id: type === 0 ? value.id : ''});
    }
  }
  return {body, extras};
}

/** validateStudioDraft returns a normalized copy without mutating the UI draft.
 * Identity provenance belongs to the query/worker layer. Optional capabilities.now
 * is an explicit epoch-millisecond clock for the existing 2-hour–14-day window;
 * without it, this pure function validates only the timestamp's absolute format.
 */
export function validateStudioDraft(draft, capabilities) {
  if (!record(draft) || typeof draft.id !== 'string' || !ID.test(draft.id) || !['image', 'video'].includes(draft.kind)) {
    fail('作品身份或发布类型无效。');
  }
  if (capabilities !== undefined && !record(capabilities)) fail('服务能力无效。', 'INVALID_CAPABILITIES');
  const imageCount = limit(capabilities, 'imageCount', 35);
  if (!Array.isArray(draft.assets) || !draft.assets.length ||
      draft.assets.length > (draft.kind === 'video' ? 1 : imageCount)) {
    fail(draft.kind === 'video' ? '请选择一个视频。' : `请选择 1–${imageCount} 张图片。`);
  }
  const assets = draft.assets.map(asset => {
    if (!record(asset) || typeof asset.id !== 'string' || !ID.test(asset.id) || asset.kind !== draft.kind) fail('素材身份或类型无效。');
    return {id: asset.id, name: text(asset.name, '素材名称', 255), kind: asset.kind};
  });
  if (new Set(assets.map(asset => asset.id)).size !== assets.length) fail('不能重复添加同一素材。');
  const title = text(draft.title, '标题', limit(capabilities, 'titleLength', 20));
  const description = text(draft.description, '正文', limit(capabilities, 'descriptionLength', 1000), true);
  const topics = topicIdentities(draft.topics ?? []);
  if (!Array.isArray(draft.activities ?? [])) fail('官方活动列表无效。');
  const activities = (draft.activities ?? []).map(value => ({...identity(value, '官方活动'), topic: identity(value.topic, '活动话题')}));
  if (new Set(activities.map(value => value.id)).size !== activities.length) fail('不能重复选择同一官方活动。');
  // 官方活动使用自己的第一项真实话题；UI 同时保留普通话题关联时只生成一次标记。
  for (const activity of activities) {
    const existing = topics.find(value => value.id === activity.topic.id);
    if (existing && existing.name !== activity.topic.name) fail('活动话题与已选话题身份不一致，请重新选择。');
    if (!existing) topics.push({...activity.topic});
  }
  const mentions = identities(draft.mentions ?? [], '@ 用户');
  if (new Set(topics.map(value => value.name)).size !== topics.length) fail('话题不能重复选择同一名称。');
  if (topics.length > 5) fail('话题和官方活动合计最多添加 5 个。');
  if (topics.some(topic => /[#\r\n]/u.test(topic.name))) fail('话题名称无效，请重新选择。');
  if (topics.some(topic => topic.id !== '0')) requireOperation(capabilities, 'topics.search', '话题关联');
  if (mentions.length) requireOperation(capabilities, 'users.search', '@ 用户');
  if (activities.length) requireOperation(capabilities, 'activities.resolve', '官方活动');
  const result = {id: draft.id, name: text(draft.name ?? '', '作品名称', 200), kind: draft.kind,
    assets, title, description, topics, activities, mentions, music: null, location: null, collection: null, cover: null};
  for (const [key, label, operation] of [['music', '配乐', 'music.search'],
    ['location', '地点', 'locations.search'], ['collection', '合集', 'collections.list']]) {
    if (draft[key] !== undefined && draft[key] !== null) {
      result[key] = identity(draft[key], label);
      requireOperation(capabilities, operation, label);
    }
  }
  // 城市只用于恢复地点查询；发布地点及附加参数仍必须来自当前账号的实时平台结果。
  if (result.location && (draft.location.cityCode !== undefined || draft.location.cityName !== undefined)) {
    if (typeof draft.location.cityCode !== 'string' || !/^\d{6}$/.test(draft.location.cityCode)) fail('地点城市信息无效，请重新选择城市和地点。');
    const cityName = text(draft.location.cityName, '地点城市', 50).trim();
    if (!cityName) fail('请选择地点所在城市。');
    Object.assign(result.location, {cityCode: draft.location.cityCode, cityName});
  }
  if (!record(draft.settings)) fail('发布设置无效。');
  const settings = draft.settings;
  if (!['now', 'scheduled'].includes(settings.publishTime)) fail('请选择立即发布或定时发布。');
  const declarations = settings.declarations ?? [];
  if (!Array.isArray(declarations) || declarations.length > 1 || declarations.some(value => typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))) {
    fail('请选择一项有效的自主声明。');
  }
  if (declarations.length) requireOperation(capabilities, 'declarations.list', '自主声明');
  result.settings = {visibility: normalizeVisibility(settings.visibility), download: normalizeDownload(settings.download),
    publishTime: settings.publishTime, scheduledAt: '', declarations: [...declarations]};
  if (settings.publishTime === 'scheduled') {
    const value = settings.scheduledAt;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
      fail('定时时间必须包含时区，请重新选择发布时间。');
    }
    const scheduled = Date.parse(value);
    if (!Number.isFinite(scheduled)) fail('定时发布时间无效。');
    const [year, month, day] = value.slice(0, 10).split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth) fail('定时发布日期无效。');
    if (capabilities?.now !== undefined) {
      if (!Number.isFinite(capabilities.now)) fail('校验时间无效。', 'INVALID_CAPABILITIES');
      const delta = scheduled - capabilities.now;
      if (delta < 2 * 3600000 || delta > 14 * 86400000) fail('请选择 2 小时后至 14 天内的发布时间。');
    }
    result.settings.scheduledAt = new Date(scheduled).toISOString();
  }
  if (result.collection && result.settings.visibility !== 'public') fail('加入合集的作品必须公开可见。');
  if (draft.cover !== undefined && draft.cover !== null) {
    const value = draft.cover;
    if (!record(value) || !['asset', 'frame', 'upload'].includes(value.type)) fail('封面选择无效。');
    if (value.type === 'asset') {
      if (draft.kind !== 'image' || typeof value.assetId !== 'string' || !ID.test(value.assetId)) fail('请从图库选择有效图片作为封面。');
      result.cover = {type: 'asset', assetId: value.assetId};
      if (value.crop !== undefined) {
        const crop = value.crop;
        if (!record(crop) || !['x', 'y', 'width', 'height'].every(key => typeof crop[key] === 'number' && Number.isFinite(crop[key])) ||
            crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0 ||
            crop.x + crop.width > 1.000001 || crop.y + crop.height > 1.000001) fail('封面裁剪范围无效。');
        result.cover.crop = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, crop[key]]));
      }
    } else {
      requireOperation(capabilities, value.type === 'frame' ? 'cover.frames' : 'cover.upload', '所选封面');
      if (typeof value.id !== 'string' || !ID.test(value.id)) fail('封面身份无效。');
      if (value.type === 'frame' && (draft.kind !== 'video' || !Number.isSafeInteger(value.timeMs) || value.timeMs < 0)) fail('视频封面时间无效。');
      result.cover = {type: value.type, id: value.id};
      if (value.type === 'frame') result.cover.timeMs = value.timeMs;
    }
  }
  const {body} = bodyWithAssociations(result);
  if (body.length > limit(capabilities, 'descriptionLength', 1000)) fail('正文加上所选话题和 @ 用户后超过字数限制。');
  if (draft.updatedAt !== undefined && Number.isFinite(draft.updatedAt)) result.updatedAt = draft.updatedAt;
  return result;
}

/** resourceURI validates a platform resource identity, never a remote download URL. */
function resourceURI(value, label) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\u0000-\u001f\\?#]/u.test(value) ||
      value.includes('://') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    fail(`${label}资源无效，请重新准备。`, 'INVALID_PREPARED_MEDIA');
  }
  return value;
}

/** resolvedIdentity requires the freshly resolved identity to match the snapshot. */
function resolvedIdentity(selected, resolved, label) {
  if (!selected) {
    if (resolved !== undefined && resolved !== null) fail(`${label}与作品快照不一致。`, 'PREPARATION_MISMATCH');
    return null;
  }
  if (!record(resolved) || resolved.id !== selected.id) fail(`${label}未重新确认，请重新准备。`, 'PREPARATION_MISMATCH');
  return resolved;
}

/** publicationText builds documented JSON-string fields with exact appended offsets. */
function publicationText(draft) {
  const {body, extras} = bodyWithAssociations(draft);
  const activityTopics = new Set(draft.activities.map(value => value.topic.id));
  let content = body;
  let prefix = '';
  let titleExtras = [];
  if (draft.kind === 'image' && draft.title) {
    prefix = draft.title;
    titleExtras = [{start: 0, end: prefix.length, hashtag_id: 0, hashtag_name: '', type: 7}];
    if (!prefix.endsWith('。')) {
      titleExtras.push({start: prefix.length, end: prefix.length + 1, hashtag_id: 0, hashtag_name: '', type: 8});
      prefix += '。';
    }
  } else if (draft.kind === 'video' && draft.title.trim()) prefix = draft.title.trim() + ' ';
  content = prefix + body;
  const common = {text: content,
    text_extra: JSON.stringify([...titleExtras, ...extras.map(value => ({...value, start: value.start + prefix.length, end: value.end + prefix.length}))]),
    activity: JSON.stringify([...activityTopics]), challenges: JSON.stringify(draft.topics.filter(value => value.id !== '0').map(value => value.id)),
    mentions: JSON.stringify(draft.mentions.map(value => value.id)),
    hashtag_source: draft.topics.map(value => activityTopics.has(value.id) ? 'recommend' : 'search').join('/')};
  if (draft.kind === 'video') Object.assign(common, {item_title: draft.title.trim(), caption: body});
  return common;
}

/** buildPublicationPayload returns create_v2's JSON body from a fixed prepared snapshot.
 * Upload success, account ownership and identity freshness must be checked by the
 * worker. A built body is not evidence of platform acceptance or publication.
 */
export function buildPublicationPayload({draft, images = [], video, cover, location, collection, music, declaration, creationId} = {}) {
  const normalized = validateStudioDraft(draft);
  if (typeof (creationId ?? normalized.id) !== 'string' || !ID.test(creationId ?? normalized.id)) fail('本次创作身份无效。');
  const common = {creation_id: creationId ?? normalized.id, media_type: normalized.kind === 'image' ? 2 : 4,
    ...publicationText(normalized), visibility_type: VISIBILITY[normalized.settings.visibility],
    download: normalized.settings.download === 'allow' ? 1 : 0};
  if (normalized.settings.publishTime === 'scheduled') common.timing = Math.floor(Date.parse(normalized.settings.scheduledAt) / 1000);
  const item = {common};
  const declarationID = normalized.settings.declarations[0];
  if (declarationID) {
    if (!declaration || declaration.id !== declarationID || declaration.disabled) fail('自主声明未重新确认，请重新选择。', 'PREPARATION_MISMATCH');
    // 平台要求 JSON 字符串；只提交经当前账号实时选项确认的 choose_value，不接受前端拼接字段。
    item.declare = {user_declare_info: JSON.stringify({choose_value: declarationID})};
  } else if (declaration) fail('自主声明与作品快照不一致。', 'PREPARATION_MISMATCH');
  if (normalized.kind === 'image') {
    if (!Array.isArray(images) || images.length !== normalized.assets.length || video !== undefined && video !== null) {
      fail('已上传图片与作品清单不一致。', 'PREPARATION_MISMATCH');
    }
    common.images = images.map(value => {
      if (!record(value) || !Number.isSafeInteger(value.imageWidth) || value.imageWidth < 1 ||
          !Number.isSafeInteger(value.imageHeight) || value.imageHeight < 1 ||
          value.uriStatus !== undefined && value.uriStatus !== 2000) fail('图片尚未完整准备。', 'INVALID_PREPARED_MEDIA');
      return {uri: resourceURI(value.uri, '图片'), width: value.imageWidth, height: value.imageHeight};
    });
    if (new Set(common.images.map(value => value.uri)).size !== common.images.length) fail('已上传图片资源重复。', 'PREPARATION_MISMATCH');
    if (!record(cover)) fail('请先准备图片封面。', 'INVALID_PREPARED_MEDIA');
    item.cover = {upload_poster: resourceURI(cover.uri, '封面')};
  } else {
    if (!Array.isArray(images) || images.length || !record(video) || typeof video.vid !== 'string' || !ID.test(video.vid) ||
        !Number.isSafeInteger(video.width) || video.width < 1 || !Number.isSafeInteger(video.height) || video.height < 1 ||
        !Number.isFinite(video.duration) || video.duration <= 0) fail('视频转码结果尚未完整就绪。', 'INVALID_PREPARED_MEDIA');
    common.video_id = video.vid;
    if (cover !== undefined && cover !== null) {
      if (!record(cover)) fail('封面资源无效。', 'INVALID_PREPARED_MEDIA');
      if (normalized.cover?.type === 'frame' && normalized.cover.timeMs > video.duration * 1000) {
        fail('所选封面时间超出视频时长。', 'INVALID_PREPARED_MEDIA');
      }
      item.cover = normalized.cover?.type === 'frame'
        ? {poster: resourceURI(cover.uri, '视频封面'), poster_delay: normalized.cover.timeMs / 1000}
        : {upload_poster: resourceURI(cover.uri, '视频封面')};
    } else {
      if (normalized.cover) fail('所选视频封面尚未准备。', 'INVALID_PREPARED_MEDIA');
      item.cover = {poster: resourceURI(video.coverUri, '视频首帧'), poster_delay: 0};
    }
  }
  const resolvedMusic = resolvedIdentity(normalized.music, music, '配乐');
  if (resolvedMusic) {
    if (normalized.kind !== 'image') fail('视频配乐来源参数尚未完成验证。', 'UNSUPPORTED_FEATURE');
    if (!Number.isFinite(resolvedMusic.duration) || resolvedMusic.duration <= 0) fail('音乐时长尚未确认，请重新选择。');
    common.music_id = resolvedMusic.id;
    common.music_end_time = resolvedMusic.duration * 1000;
  }
  const resolvedLocation = resolvedIdentity(normalized.location, location, '地点');
  if (resolvedLocation) {
    if (normalized.kind !== 'image') fail('视频地点的发布参数尚未完成验证。', 'UNSUPPORTED_FEATURE');
    if (resolvedLocation.requiresNativeSelection) fail('此地点需要平台额外确认，助手暂不支持提交。', 'UNSUPPORTED_FEATURE');
    const name = text(resolvedLocation.name, '地点', 200).trim();
    if (!name) fail('地点名称未确认。');
    item.anchor = {poi_name: name, poi_id: resolvedLocation.id};
    if (resolvedLocation.extra !== undefined) {
      if (typeof resolvedLocation.extra !== 'string' || resolvedLocation.extra.length > 10000) fail('地点附加信息无效。');
      try { if (!record(JSON.parse(resolvedLocation.extra))) fail('地点附加信息无效。'); } catch { fail('地点附加信息无效。'); }
      item.anchor.anchor_content = resolvedLocation.extra;
    }
  }
  const resolvedCollection = resolvedIdentity(normalized.collection, collection, '合集');
  if (resolvedCollection) {
    if (normalized.kind !== 'image' || normalized.settings.publishTime === 'scheduled') {
      fail('视频或定时发布的合集序号尚未完成验证。', 'UNSUPPORTED_FEATURE');
    }
    if (!Number.isSafeInteger(resolvedCollection.order) || resolvedCollection.order < 1) fail('合集集数未确认。');
    item.mix = {mix_id: resolvedCollection.id, mix_order: resolvedCollection.order - 1};
  }
  return {item};
}
