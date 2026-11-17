import assert from 'node:assert/strict';
import {buildImageDraft, buildVideoDraft, validateDraftBase, validateUploadFile} from '../browser/draft-model.js';

const one = {uri: 'images/one', uriStatus: 2000, imageWidth: 1080, imageHeight: 1440, key: 'one'};
const two = {...one, uri: 'images/two', key: 'two'};
const cover = {...one, uri: 'images/cover', key: 'cover'};
const job = {kind: 'image', title: '秋日', description: '第一行\n第二行 #普通文本', settings: {visibility: 'public', download: 'allow', publishTime: 'now'}};

// 新草稿不需要先手动创建，占位 File 与组件私有状态不会混入恢复协议。
const fresh = buildImageDraft({job, files: [one, two]});
assert.deepEqual(fresh.files, [{uploadFile: one}, {uploadFile: two}]);
assert.equal(fresh.title, job.title);
assert.equal(fresh.text, job.description);
assert.deepEqual(fresh.text_extra, []);
assert.equal(fresh.visibilityType, 0);
assert.equal(fresh.download, 1);
assert.equal(fresh.scheduleTime, -1);
assert.deepEqual(fresh.coverInfo, {upload_uri: one.uri, uri: '', url: ''});

// 同一草稿保留原生人工编辑的非 App 字段；素材顺序和文案由这次快照决定。
const base = {
  ...fresh, title: '旧标题', text: '旧描述', text_extra: [{start: 0}], activity: ['old'],
  audio: {id: 'music'}, userDeclarationInfo: {type: 'personal'}, customNativeField: {value: 1},
  anchor: {type: -11, id: '12', payload: '旧地点', extra: '{}'},
  metaMap: {'images/one': {AIGC: 'original metadata'}, 'images/stale': {AIGC: 'stale'}},
};
const before = structuredClone(base);
const changed = buildImageDraft({base, job: {...job, settings: {...job.settings, visibility: 'friends', download: 'deny'}}, files: [two, one], cover});
assert.deepEqual(base, before);
assert.deepEqual(changed.files.map(file => file.uploadFile.uri), [two.uri, one.uri]);
assert.equal(changed.visibilityType, 2);
assert.equal(changed.download, 0);
assert.deepEqual(changed.audio, base.audio);
assert.deepEqual(changed.userDeclarationInfo, base.userDeclarationInfo);
assert.deepEqual(changed.customNativeField, base.customNativeField);
assert.deepEqual(changed.anchor, base.anchor);
assert.deepEqual(changed.metaMap, {'images/one': {AIGC: 'original metadata'}});
assert.deepEqual(changed.coverInfo, {upload_uri: cover.uri, uri: '', url: ''});
changed.audio.id = 'changed';
changed.files[0].uploadFile.uri = 'changed';
assert.equal(base.audio.id, 'music');
assert.equal(two.uri, 'images/two');

// 所有原生发布选项、位置与清空位置都由数据恢复，无需触发页面回调。
const location = {id: '123456', name: '公园', extra: '{"is_commerce_intention":false,"server_field":1}'};
const settings = {...job.settings, visibility: 'private', publishTime: 'scheduled', scheduledAt: new Date(2026, 10, 18, 14, 30).toISOString(), location};
const scheduled = buildImageDraft({job: {...job, settings}, files: [one]});
assert.equal(scheduled.visibilityType, 1);
assert.equal(scheduled.scheduleTime, '2026-11-18 14:30');
assert.deepEqual(scheduled.anchor, {type: -11, id: location.id, payload: location.name, extra: location.extra});
assert.deepEqual(buildImageDraft({base, job: {...job, settings: {...settings, location: null}}, files: [one]}).anchor,
  {type: -11, id: '', payload: '', extra: null});

// 旧已提交作品、未完成上传、缺封面、超限及格式错误必须在写缓存前失败。
for (const field of ['reEditId', 'modifyId', 'scheduleItemId', 'rawModifyItem', 'rawScheduleInfo']) {
  assert.throws(() => buildImageDraft({base: {...base, [field]: 'submitted'}, job, files: [one]}), /已提交作品/);
}
assert.throws(() => validateDraftBase([]), /结构/);
assert.throws(() => validateDraftBase({files: {}}), /结构/);
assert.throws(() => validateUploadFile({...one, uriStatus: 0}), /上传结果/);
assert.throws(() => validateUploadFile({...one, imageWidth: 0}), /上传结果/);
for (const files of [[], Array(36).fill(one), [one, one]]) {
  assert.throws(() => buildImageDraft({job, files}));
}
for (const bad of [{title: '🙂'.repeat(11)}, {title: 'a\nb'}, {description: 'a'.repeat(1001)}, {kind: 'video'}]) {
  assert.throws(() => buildImageDraft({job: {...job, ...bad}, files: [one]}));
}
for (const patch of [{visibility: 'all'}, {download: 'bad'}, {publishTime: 'bad'}, {publishTime: 'scheduled', scheduledAt: ''}, {coverIndex: 0}, {location: {id: '1', name: 'x', extra: '[]'}}]) {
  assert.throws(() => buildImageDraft({job: {...job, settings: {...job.settings, ...patch}}, files: [one]}));
}
assert.throws(() => buildImageDraft({base: {...base, collectionInfo: {mix_id: 'collection'}}, job: {...job, settings}, files: [one]}), /合集/);
assert.equal(buildImageDraft({job: {...job, title: '', description: ''}, files: [one]}).text, '');
assert.equal(buildImageDraft({job: {...job, settings: undefined}, files: [one]}).visibilityType, 0);
console.log('PASS image draft contract, immutable merge, native settings/location/cover, submitted-item guard and upload validation');

// 视频使用独立缓存外壳和原生转码完成标识，文案与位置字段也不混用图文结构。
const video = {vid: 'video-id', name: 'movie.mp4', size: 4096, type: 'video/mp4', duration: 12.5, width: 1920, height: 1080, coverUri: 'video-cover'};
const videoJob = {...job, kind: 'video', settings};
const videoDraft = buildVideoDraft({job: videoJob, video});
assert.deepEqual(Object.keys(videoDraft), ['cache']);
assert.equal(videoDraft.cache.longStatus, 2);
assert.deepEqual(videoDraft.cache.longFileInfo, video);
assert.deepEqual(videoDraft.cache.longFileMetaInfo, video);
assert.deepEqual(videoDraft.cache.textResult, {text: job.description, textExtra: [], activity: [], caption: ''});
assert.equal(videoDraft.cache.itemTitle, job.title);
assert.equal(videoDraft.cache.anchorType, -11);
assert.equal(videoDraft.cache.anchorId, location.id);
assert.equal(videoDraft.cache.anchorPayload, location.name);
assert.equal(videoDraft.cache.anchorExtra, location.extra);
assert.equal(videoDraft.cache.visibilityType, 1);
assert.equal(videoDraft.cache.scheduleTime, '2026-11-18 14:30');
assert.deepEqual(videoDraft.cache.coverInfo, {uri: 'video-cover', posterDelay: 0});
const videoBase = {...videoDraft, cache: {...videoDraft.cache, customNativeField: {keep: true}, coverInfo: {uri: 'manual'}}};
const sameVideo = buildVideoDraft({base: videoBase, job: videoJob, video});
assert.deepEqual(sameVideo.cache.coverInfo, {uri: 'manual'});
assert.deepEqual(sameVideo.cache.customNativeField, {keep: true});
assert.equal(buildVideoDraft({base: videoBase, job: videoJob, video: {...video, vid: 'next'}}).cache.coverInfo.uri, video.coverUri);
for (const field of ['modifyItemId', 'rawModifyInfo', 'scheduleItemId', 'rawScheduleInfo']) {
  assert.throws(() => buildVideoDraft({base: {cache: {...videoBase.cache, [field]: 'submitted'}}, job: videoJob, video}), /已提交作品/);
}
for (const invalid of [{coverUri: ''}, {duration: 0}, {width: 0}, {size: 0}, {type: 'image/jpeg'}, {vid: ''}]) {
  assert.throws(() => buildVideoDraft({job: videoJob, video: {...video, ...invalid}}), /转码结果/);
}
assert.throws(() => buildVideoDraft({base: {}, job: videoJob, video}), /草稿结构/);
console.log('PASS separate native video cache, completed transcode validation, settings, cover preservation and submitted-video guard');

// 两种发布缓存分别恢复真实普通合集及集数；明确清除后不得继承旧合集或付费/短剧选择。
const collection = {id:'1234567890123456789',title:'旅行',order:4,account:'123456',info:{mix_id:'1234567890123456789',mix_name:'旅行',type:0,statis:{updated_to_episode:3}}};
const collectionSettings = {...job.settings,collection};
const imageCollection = buildImageDraft({job:{...job,settings:collectionSettings},files:[one]});
assert.deepEqual(imageCollection.collectionInfo,{mix_id:collection.id,mix_name:collection.title,mix_order:4});
const videoCollection = buildVideoDraft({job:{...job,kind:'video',settings:collectionSettings},video});
assert.equal(videoCollection.cache.mixId,collection.id); assert.equal(videoCollection.cache.mixOrder,4);
assert.equal(videoCollection.cache.mixType,0); assert.equal(videoCollection.cache.mix,-2);
assert.deepEqual(videoCollection.cache.mixInfo,collection.info);
assert.notEqual(videoCollection.cache.mixInfo,collection.info);
assert.deepEqual(videoCollection.cache.mixOriginInfo,{mixId:collection.id,mixName:collection.title,mixOrder:4});
assert.equal(videoCollection.cache.playletId,null);
assert.equal(buildImageDraft({base:imageCollection,job:{...job,settings:{...job.settings,collection:null,visibility:'private'}},files:[one]}).collectionInfo,null);
const clearedVideo = buildVideoDraft({base:videoCollection,job:{...job,kind:'video',settings:{...job.settings,collection:null,visibility:'private'}},video});
assert.equal(clearedVideo.cache.mixId,null); assert.equal(clearedVideo.cache.mixOrder,null);
assert.deepEqual(clearedVideo.cache.mixInfo,{}); assert.deepEqual(clearedVideo.cache.mixOriginInfo,{});
for (const patch of [{order:0},{order:1.5},{order:undefined},{title:''},{id:'not-id'}]) {
  const settings = {...collectionSettings,collection:{...collection,...patch}};
  assert.throws(()=>buildImageDraft({job:{...job,settings},files:[one]}),/合集/);
  assert.throws(()=>buildVideoDraft({job:{...job,kind:'video',settings},video}),/合集/);
}
for (const visibility of ['private','friends']) {
  const settings = {...collectionSettings,visibility};
  assert.throws(()=>buildImageDraft({job:{...job,settings},files:[one]}),/公开可见/);
  assert.throws(()=>buildVideoDraft({job:{...job,kind:'video',settings},video}),/公开可见/);
}
assert.throws(()=>buildVideoDraft({job:{...job,kind:'video',settings:{...collectionSettings,collection:{...collection,info:{...collection.info,type:1}}}},video}),/合集/);
console.log('PASS image/video collection fields, order, explicit clearing, public-only rule and resolved metadata validation');
