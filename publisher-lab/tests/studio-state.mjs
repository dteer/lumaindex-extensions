import assert from 'node:assert/strict';
import {DRAFT_STATE_VERSION, StudioStore, emptyDraft, sanitizeDraft, normalizeState, publicationDraft, contentSignature} from '../app/studio-state.js';

// 只使用合成资源；搜索响应中的地址、凭据、序号和时长不能成为草稿发布依据。
const selected = {
  ...emptyDraft(), id: 'fixture-draft', name: '本机草稿名称',
  assets: [{id: 'image-b', name: '第二张.jpg', kind: 'image', originalPath: '/synthetic/private'}, {id: 'image-a', name: '第一张.jpg', kind: 'image'}],
  title: '旅行🙂', description: '第一行🙂 #旅行，\n第二行 #夏天 ', aiContext: '惠州大南山的周末徒步',
  topics: [{id: '101', name: '旅行', heat: 123456}, {id: '102', name: '夏天', previewURL: 'https://synthetic.invalid/topic'}, {id: '101', name: '旅行'}],
  mentions: [{id: '201', name: '作者🙂'}],
  music: {id: '301', name: '合成音乐', duration: 123, previewURL: 'https://synthetic.invalid/music?auth=not-real', signature: 'synthetic'},
  collection: {id: '401', name: '合成合集', order: 9, info: {mix_id: '401'}},
  location: {id: '501', name: '合成公园', cityCode: '110100', cityName: '北京市', address: '合成地址', extra: '{"synthetic":true}'},
  cover: {type: 'asset', assetId: 'image-a', crop: {x: 0.1, y: 0.2, width: 0.6, height: 0.7}, url: 'blob:synthetic'},
  settings: {visibility: 'public', download: 'allow', publishTime: 'now', scheduledAt: '', declarations: ['7']},
  receipt: {status: 'unknown', requestId: 'fixture-request', publicationId: '', message: '等待确认', updatedAt: '2030-01-01T00:00:00Z'},
};
const normalized = sanitizeDraft(selected);
assert.deepEqual(normalized.assets.map(item => item.id), ['image-b', 'image-a']);
assert.equal(normalized.description, selected.description, '正文中的话题、换行和 UTF-16 内容必须原样保存');
assert.deepEqual(normalized.topics, [{id: '101', name: '旅行'}, {id: '102', name: '夏天'}]);
const nameTopics = [{id: '0', name: '20190701'}, {id: '0', name: '未收录的新话题'}];
const namedDraft = sanitizeDraft({...selected, topics: [...nameTopics, nameTopics[0], {id: '', name: '无身份'}]});
assert.deepEqual(namedDraft.topics, nameTopics, '官网 0 标记按名称去重，多个新话题独立保留');
assert.deepEqual(sanitizeDraft(namedDraft).topics, nameTopics, '保存后恢复仍保留名称话题');
assert.deepEqual(publicationDraft(namedDraft).topics, nameTopics, '名称话题进入发布快照');
for (const topics of [[nameTopics[0], {id: '123', name: '20190701'}], [{id: '123', name: '20190701'}, nameTopics[0]]]) {
  assert.deepEqual(sanitizeDraft({...selected, topics}).topics, [{id: '123', name: '20190701'}], '同名已知 ID 优先于 0 标记');
}
assert.notEqual(contentSignature(namedDraft), contentSignature({...namedDraft, topics: [nameTopics[0]]}), '每个名称话题都影响发布内容版本');
assert.deepEqual(normalized.music, {id: '301', name: '合成音乐'});
assert.deepEqual(normalized.collection, {id: '401', name: '合成合集'});
assert.deepEqual(normalized.location, {id: '501', name: '合成公园', cityCode: '110100', cityName: '北京市'});
assert.deepEqual(normalized.settings.declarations, ['7']);
assert.deepEqual(normalized.cover.crop, selected.cover.crop);
assert.equal(JSON.stringify(normalized).includes('synthetic.invalid'), false);
assert.equal(JSON.stringify(normalized).includes('/synthetic/private'), false);
assert.equal(JSON.stringify(normalized).includes('signature'), false);
assert.equal(sanitizeDraft({...selected, location: {cityCode: '110100', cityName: '北京市'}}).location, null, '城市筛选不能被保存为已选地点');
assert.deepEqual(normalizeState({version: DRAFT_STATE_VERSION, activeDraftId: selected.id, drafts: [selected]}).drafts[0], normalized);

const publication = publicationDraft(selected);
for (const field of ['name', 'receipt', 'updatedAt', 'aiContext']) assert.equal(Object.hasOwn(publication, field), false);
assert.equal(publication.description, selected.description);
assert.deepEqual(publication.location, normalized.location);
const signature = contentSignature(selected);
assert.equal(contentSignature({...selected, name: '只改本机名称', receipt: null}), signature);
assert.equal(contentSignature({...selected, aiContext: '修改 AI 背景不影响当前可发布作品'}), signature);
const preferences = normalizeState({version: DRAFT_STATE_VERSION, activeDraftId: selected.id, drafts: [selected], aiPrompt: '使用自然的徒步日记语气'});
assert.equal(preferences.aiPrompt, '使用自然的徒步日记语气');
assert.equal(preferences.drafts[0].aiContext, selected.aiContext);
assert.deepEqual(normalizeState(preferences), preferences, 'AI 偏好与作品背景可重复恢复，且不进入发布字段');
const activity = {id: '601', name: '徒步分享活动', topic: {id: '602', name: '徒步日记'}, heat: 100, previewURL: 'https://synthetic.invalid/activity'};
const withActivity = sanitizeDraft({...selected, activities: [activity, activity]});
assert.deepEqual(withActivity.activities, [{id: '601', name: '徒步分享活动', topic: {id: '602', name: '徒步日记'}}]);
assert.deepEqual(publicationDraft(withActivity).activities, withActivity.activities, '活动身份和话题身份分别进入提交快照');
assert.notEqual(contentSignature(withActivity), signature, '活动变化使上传准备失效');
assert.deepEqual(sanitizeDraft({...selected, activities: [{id: '601', name: '缺少话题'}]}).activities, []);
for (const patch of [
  {description: selected.description + '#新内容'}, {topics: [{id: '103', name: '其他话题'}]},
  {music: {id: '302', name: '其他音乐'}}, {location: {...selected.location, id: '502'}},
  {collection: {id: '402', name: '其他合集'}}, {assets: [...selected.assets].reverse()},
  {settings: {...selected.settings, declarations: ['8']}},
]) assert.notEqual(contentSignature({...selected, ...patch}), signature, '作品变更必须使已准备快照失效');

// 保存快照不能被排队期间的新编辑覆盖；失败保留内存草稿，重试按最新修订保存。
const writes = [], pending = [];
const store = new StudioStore({version: DRAFT_STATE_VERSION, activeDraftId: selected.id, drafts: [selected]}, snapshot => new Promise((resolve, reject) => { writes.push(snapshot); pending.push({resolve, reject}); }));
store.touch();
const first = store.commit();
await Promise.resolve(); await Promise.resolve();
store.current().description = '尚未保存的新正文 #旅行';
store.current().location = null;
store.touch();
assert.equal(writes[0].drafts[0].description, selected.description);
pending[0].resolve();
await first;
assert.equal(store.savedRevision, 1);
assert.equal(store.revision, 2);
const failed = store.commit();
await Promise.resolve(); await Promise.resolve();
const failure = assert.rejects(failed, /合成保存失败/);
pending[1].reject(Error('合成保存失败'));
await failure;
assert.equal(store.current().description, '尚未保存的新正文 #旅行');
assert.equal(store.current().location, null);
assert.equal(store.savedRevision, 1);
const retried = store.commit();
await Promise.resolve(); await Promise.resolve();
pending[2].resolve();
await retried;
assert.equal(store.savedRevision, 2);
const reopened = new StudioStore(writes[2], async () => {});
assert.equal(reopened.current().description, store.current().description);
assert.deepEqual(reopened.current().music, normalized.music);
assert.equal(reopened.current().location, null);
const copy = reopened.copy();
assert.notEqual(copy.id, selected.id);
assert.equal(copy.receipt, null);
assert.deepEqual(copy.topics, normalized.topics);
assert.deepEqual(copy.assets, normalized.assets);

// v1 独立关联一次迁入可见正文：完整 token 复用，前缀、非 BMP 字母及组合附加符不误命中。
const legacy = {
  version: 1, activeDraftId: selected.id, handledTransfers: ['fixture-transfer'],
  drafts: [{...selected, description: '保留🙂 #旅行技巧 / #夏天，@同名',
    topics: [{id: '101', name: '旅行'}, {id: '102', name: '夏天'}],
    mentions: [{id: '201', name: '同名'}, {id: '202', name: '同名'}, {id: '203', name: '另一位'}]}],
};
const legacySnapshot = structuredClone(legacy), migrated = normalizeState(legacy);
assert.equal(migrated.version, 2);
assert.equal(migrated.drafts[0].description, '保留🙂 #旅行技巧 / #夏天，@同名 #旅行 @同名 @另一位');
assert.deepEqual(migrated.drafts[0].topics, legacy.drafts[0].topics);
assert.deepEqual(migrated.drafts[0].mentions, legacy.drafts[0].mentions);
assert.deepEqual(migrated.drafts[0].receipt, normalized.receipt);
assert.deepEqual(migrated.handledTransfers, legacy.handledTransfers);
assert.deepEqual(legacy, legacySnapshot, '迁移不能修改读入的旧存储对象');
assert.deepEqual(normalizeState(migrated), migrated, '已迁移状态重复启动保持幂等');
for (const text of ['𠀀#旅行', '#旅行𠀀', '#旅行\u0301', 'x#旅行', '#旅行技巧', '##旅行']) {
  const value = normalizeState({version: 1, drafts: [{...selected, description: text, topics: [{id: '101', name: '旅行'}], mentions: []}]}).drafts[0];
  assert.equal(value.description, text + ' #旅行');
}
for (const text of ['#旅行', '🙂#旅行，', '第一行\n#旅行\n末行', '（#旅行）']) {
  const value = normalizeState({version: 1, drafts: [{...selected, description: text, topics: [{id: '101', name: '旅行'}], mentions: []}]}).drafts[0];
  assert.equal(value.description, text);
}
let savedMigration;
const upgrading = new StudioStore(legacy, async value => { savedMigration = structuredClone(value); });
assert.equal(upgrading.revision, 1);
assert.equal(upgrading.savedRevision, 0);
await upgrading.commit();
assert.equal(upgrading.savedRevision, 1);
const upgraded = new StudioStore(savedMigration, async () => {});
assert.equal(upgraded.revision, 0);
assert.equal(upgraded.current().description, migrated.drafts[0].description);
// v2 输入端会同步解除关联；即使旧内存尚留关联，sanitize 也绝不能复活用户删除的可见文字。
upgraded.current().description = '用户已删除话题与提及';
assert.equal(publicationDraft(upgraded.current()).description, '用户已删除话题与提及');
assert.equal(normalizeState(upgraded.data).drafts[0].description, '用户已删除话题与提及');
const largeLegacy = normalizeState({version: 1, drafts: [{...selected, description: '字'.repeat(20000), topics: [{id: '101', name: '旅行'}], mentions: []}]});
assert.equal(normalizeState(largeLegacy).drafts[0].description, '字'.repeat(20000) + ' #旅行', '旧字段迁入正文不能在下一次保存时被旧正文上限截断');
// 删除列表项只改变草稿集合，不修改仍在编辑的内容、时间或版本签名。
{
  const a = {...emptyDraft(), id: 'delete-a', title: '保留中的编辑', updatedAt: '2026-01-01T00:00:00Z'};
  const b = {...emptyDraft(), id: 'delete-b', receipt: {status: 'unknown', requestId: 'existing-submit', updatedAt: '2026-01-01T00:00:00Z'}};
  const drafts = new StudioStore({version: 2, activeDraftId: a.id, drafts: [a, b]}, async () => {});
  const before = structuredClone(drafts.current()), signature = contentSignature(before);
  drafts.remove(b.id);
  assert.deepEqual(drafts.current(), before);
  assert.equal(contentSignature(drafts.current()), signature);
  assert.equal(drafts.revision, 1);
  drafts.remove('missing-draft'); assert.equal(drafts.revision, 1);
  drafts.remove(a.id);
  assert.equal(drafts.data.drafts.length, 1);
  assert.notEqual(drafts.current().id, a.id);
  assert.equal(drafts.current().title, ''); assert.equal(drafts.current().receipt, null);
}
console.log('studio-state: resource round-trip, inline topic text, publication invalidation, failed save, deletion isolation and retry passed');
