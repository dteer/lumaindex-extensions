import assert from 'node:assert/strict';
import {buildPublicationPayload, validateStudioDraft} from '../browser/publication-payload.js';

// Fixtures contain invented IDs only and never send network requests.
function draft(overrides = {}) {
  return {id: '60000000-0000-4000-8000-000000000001', name: '测试作品', kind: 'image',
    assets: [{id: 'local-image-1', name: 'test.jpg', kind: 'image'}],
    title: '作品🙂', description: '  海边 #夏天  ', topics: [{id: '101', name: '夏天'}],
    mentions: [{id: '202', name: '小 王'}], music: null, location: null, collection: null,
    cover: {type: 'asset', assetId: 'local-image-1'},
    settings: {visibility: 'public', download: 'deny', publishTime: 'now', scheduledAt: '', declarations: []},
    ...overrides};
}
const image = {uri: 'tos-image/fixture.jpg', imageWidth: 1080, imageHeight: 1440, uriStatus: 2000};
const cover = {uri: 'tos-image/cover.jpg'};
function build(value, options = {}) {
  return buildPublicationPayload({draft: value, images: [image], cover, ...options});
}
function rejected(run, code) {
  assert.throws(run, error => error instanceof Error && error.code === code && /[\u3400-\u9fff]/u.test(error.message));
}

// An existing literal hashtag must not be guessed as an association. A selected
// topic is appended separately, with UTF-16 offsets matching the actual text.
const original = draft();
const snapshot = structuredClone(original);
const imagePayload = build(original);
const common = imagePayload.item.common;
assert.equal(common.text, '作品🙂。海边 #夏天 #夏天 @小 王');
assert.equal(common.media_type, 2);
assert.equal(common.visibility_type, 0);
assert.equal(common.download, 0);
assert.deepEqual(common.images, [{uri: image.uri, width: 1080, height: 1440}]);
assert.deepEqual(imagePayload.item.cover, {upload_poster: cover.uri});
assert.equal(common.activity, '[]');
assert.equal(common.challenges, '["101"]');
assert.equal(common.mentions, '["202"]');
assert.equal(common.hashtag_source, 'search');
const extras = JSON.parse(common.text_extra);
assert.deepEqual(extras.slice(0, 2), [
  {start: 0, end: 4, hashtag_id: 0, hashtag_name: '', type: 7},
  {start: 4, end: 5, hashtag_id: 0, hashtag_name: '', type: 8},
]);
assert.equal(common.text.slice(extras[2].start, extras[2].end), '#夏天');
assert.equal(common.text.slice(extras[3].start, extras[3].end), '@小 王');
assert.equal(extras[2].start, common.text.lastIndexOf('#夏天'));
assert.equal(extras[2].caption_start, extras[2].start - 5);
assert.equal(extras[3].user_id, '202');
assert.equal(extras[2].hashtag_id, '101');
assert.ok(!Object.hasOwn(extras[3], 'sec_uid'));
assert.deepEqual(original, snapshot);

const noExtra = build(draft({title: '标题。', description: '', topics: [], mentions: []})).item.common;
assert.equal(noExtra.text, '标题。');
assert.equal(JSON.parse(noExtra.text_extra).length, 1);
assert.equal(noExtra.hashtag_source, '');
assert.equal(build(draft({title: '', description: '🙂', topics: [], mentions: []})).item.common.text_extra, '[]');

// The rendered body and caption coordinate systems must agree even when a
// supplementary-plane character appears before and inside associated tokens.
const unicode = build(draft({title: '🙂。', description: '\n🙂第一行\n第二行\n',
  topics: [{id: '102', name: '影像🙂'}], mentions: [{id: '203', name: '作者🙂'}]})).item.common;
const unicodeBody = '🙂第一行\n第二行 #影像🙂 @作者🙂';
assert.equal(unicode.text, '🙂。' + unicodeBody);
for (const [index, token] of ['#影像🙂', '@作者🙂'].entries()) {
  const extra = JSON.parse(unicode.text_extra)[index + 1];
  assert.equal(unicode.text.slice(extra.start, extra.end), token);
  assert.equal(unicodeBody.slice(extra.caption_start, extra.caption_end), token);
  assert.equal(extra.start - extra.caption_start, 3);
}

// Cropping resolves to a separate uploaded cover. It must not rewrite body
// image dimensions or leak unverified crop parameters into create_v2.
const croppedDraft = draft({cover: {type: 'asset', assetId: 'local-image-1', crop: {x: 0.1, y: 0.2, width: 0.6, height: 0.7}}});
const croppedPayload = build(croppedDraft, {cover: {uri: 'tos-image/cropped.jpg'}});
assert.deepEqual(croppedPayload.item.common.images, imagePayload.item.common.images);
assert.deepEqual(croppedPayload.item.cover, {upload_poster: 'tos-image/cropped.jpg'});
assert.deepEqual(validateStudioDraft(croppedDraft).cover.crop, croppedDraft.cover.crop);
rejected(() => validateStudioDraft(draft({cover: {...croppedDraft.cover, crop: {x: 0.9, y: 0, width: 0.2, height: 1}}})), 'INVALID_DRAFT');

// Video captions use a trimmed title and one space, not image title markers.
const videoDraft = draft({kind: 'video', title: '  标题🙂  ', description: '  正文  ',
  assets: [{id: 'local-video-1', name: 'test.mp4', kind: 'video'}], cover: null});
const video = {vid: 'fixture_vid_1', width: 1920, height: 1080, duration: 5, coverUri: 'tos-video/poster.jpg'};
const videoPayload = buildPublicationPayload({draft: videoDraft, video});
assert.equal(videoPayload.item.common.media_type, 4);
assert.equal(videoPayload.item.common.video_id, video.vid);
assert.equal(videoPayload.item.common.item_title, '标题🙂');
assert.equal(videoPayload.item.common.caption, '正文 #夏天 @小 王');
assert.equal(videoPayload.item.common.text, '标题🙂 正文 #夏天 @小 王');
assert.deepEqual(videoPayload.item.cover, {poster: video.coverUri, poster_delay: 0});
for (const extra of JSON.parse(videoPayload.item.common.text_extra)) {
  assert.ok([0, 1].includes(extra.type));
  assert.equal(extra.start - extra.caption_start, 5);
  assert.equal(videoPayload.item.common.text.slice(extra.start, extra.end), extra.type ? '#夏天' : '@小 王');
}
const videoCustomCover = buildPublicationPayload({draft: {...videoDraft, cover: {type: 'upload', id: 'cover-1'}}, video, cover});
assert.deepEqual(videoCustomCover.item.cover, {upload_poster: cover.uri});
const videoFrame = buildPublicationPayload({draft: {...videoDraft, cover: {type: 'frame', id: 'frame-1', timeMs: 1250}}, video, cover});
assert.deepEqual(videoFrame.item.cover, {poster: cover.uri, poster_delay: 1.25});

// Normalization accepts exact UI aliases only. It strips extra transport fields.
for (const [input, expected] of [['public', 'public'], [0, 'public'], ['0', 'public'],
  [2, 'friends'], ['2', 'friends'], [1, 'private'], ['1', 'private']]) {
  const normalized = validateStudioDraft(draft({settings: {...original.settings, visibility: input, download: '1'}}));
  assert.equal(normalized.settings.visibility, expected);
  assert.equal(normalized.settings.download, 'allow');
}
for (const value of ['', null, true, false, 3, '01', ['public'], {toString: () => 'public'}]) {
  rejected(() => validateStudioDraft(draft({settings: {...original.settings, visibility: value}})), 'INVALID_DRAFT');
}
const copied = validateStudioDraft({...original, requestURL: 'https://invalid.example', cookie: 'fixture', topics: [{id: '101', name: '夏天', secret: 'fixture'}]});
assert.ok(!Object.hasOwn(copied, 'cookie'));
assert.ok(!Object.hasOwn(copied.topics[0], 'secret'));

// Absolute timestamps are deterministic across local host timezones. A caller
// may inject now for the inherited schedule window without making this module read a clock.
const now = Date.parse('2030-01-01T00:00:00Z');
const scheduled = draft({settings: {...original.settings, publishTime: 'scheduled', scheduledAt: '2030-01-01T10:00:00+08:00'}});
assert.equal(validateStudioDraft(scheduled, {operations: ['topics.search', 'users.search'], now}).settings.scheduledAt, '2030-01-01T02:00:00.000Z');
assert.equal(build(scheduled).item.common.timing, (now + 2 * 3600000) / 1000);
assert.ok(!Object.hasOwn(build(original).item.common, 'timing'));
rejected(() => validateStudioDraft(scheduled, {operations: ['topics.search', 'users.search'], now: now + 1}), 'INVALID_DRAFT');
for (const value of ['2030-01-01T10:00', '2030-02-30T10:00:00Z', 'not a date']) {
  rejected(() => validateStudioDraft(draft({settings: {...original.settings, publishTime: 'scheduled', scheduledAt: value}})), 'INVALID_DRAFT');
}

// Query identities must survive unchanged from the selected snapshot, while
// request-only values (duration, POI metadata, collection order) come from a fresh resolution.
const withMusic = draft({music: {id: '303', name: '测试音乐'}});
assert.equal(build(withMusic, {music: {id: '303', duration: 12.5}}).item.common.music_end_time, 12500);
rejected(() => build(withMusic), 'PREPARATION_MISMATCH');
rejected(() => build(withMusic, {music: {id: '304', duration: 12}}), 'PREPARATION_MISMATCH');
rejected(() => build(withMusic, {music: {id: '303'}}), 'INVALID_DRAFT');
const withLocation = draft({location: {id: '404', name: '测试地点'}});
assert.deepEqual(build(withLocation, {location: {id: '404', name: '测试地点', extra: '{"fixture":true}'}}).item.anchor,
  {poi_name: '测试地点', poi_id: '404', anchor_content: '{"fixture":true}'});
rejected(() => build(withLocation, {location: {id: '404', name: '测试地点', requiresNativeSelection: true}}), 'UNSUPPORTED_FEATURE');
const withCollection = draft({collection: {id: '505', name: '测试合集'}});
assert.deepEqual(build(withCollection, {collection: {id: '505', order: 1}}).item.mix, {mix_id: '505', mix_order: 0});
rejected(() => build({...withCollection, settings: scheduled.settings}, {collection: {id: '505', order: 3}}), 'UNSUPPORTED_FEATURE');
rejected(() => validateStudioDraft({...withCollection, settings: {...original.settings, visibility: 'private'}}), 'INVALID_DRAFT');
for (const [key, resolved] of [['music', {id: '303', duration: 5}], ['location', {id: '404', name: '地点'}], ['collection', {id: '505', order: 1}]]) {
  rejected(() => buildPublicationPayload({draft: {...videoDraft, [key]: {id: resolved.id, name: '测试'}}, video, [key]: resolved}), 'UNSUPPORTED_FEATURE');
}

// Capabilities and content constraints fail before work can be reported ready.
rejected(() => validateStudioDraft(original, {operations: []}), 'UNSUPPORTED_FEATURE');
rejected(() => validateStudioDraft(draft({topics: [], mentions: [], settings: {...original.settings, declarations: ['aigc']}})), 'UNSUPPORTED_FEATURE');
rejected(() => validateStudioDraft(draft({topics: [], mentions: []}), {operations: [], declarations: [{id: 'required', required: true}]}), 'UNSUPPORTED_FEATURE');
rejected(() => validateStudioDraft(draft({description: '字'.repeat(1000)})), 'INVALID_DRAFT');
rejected(() => validateStudioDraft(draft({topics: [{id: '0', name: '未知话题'}]})), 'INVALID_DRAFT');
rejected(() => validateStudioDraft(draft({topics: [{id: '101', name: '夏天'}, {id: '101', name: '夏天'}]})), 'INVALID_DRAFT');
rejected(() => validateStudioDraft(draft({id: 123})), 'INVALID_DRAFT');
rejected(() => validateStudioDraft(draft({assets: [...original.assets, ...original.assets]})), 'INVALID_DRAFT');
rejected(() => validateStudioDraft(draft({assets: Array.from({length: 36}, (_, index) => ({id: `image-${index}`, name: 'a.jpg', kind: 'image'}))})), 'INVALID_DRAFT');
rejected(() => build(original, {images: []}), 'PREPARATION_MISMATCH');
rejected(() => build(original, {images: [{...image, imageWidth: 0}]}), 'INVALID_PREPARED_MEDIA');
rejected(() => build(original, {images: [{...image, uriStatus: 1}]}), 'INVALID_PREPARED_MEDIA');
rejected(() => build(original, {cover: {uri: 'https://invalid.example/cover.jpg'}}), 'INVALID_PREPARED_MEDIA');
rejected(() => buildPublicationPayload({draft: videoDraft, video: {...video, duration: undefined}}), 'INVALID_PREPARED_MEDIA');
rejected(() => buildPublicationPayload({draft: videoDraft, video, images: null}), 'INVALID_PREPARED_MEDIA');
rejected(() => buildPublicationPayload({draft: {...videoDraft, cover: {type: 'frame', id: 'frame-2', timeMs: 6000}}, video, cover}), 'INVALID_PREPARED_MEDIA');
rejected(() => build(original, {music: {id: '303', duration: 5}}), 'PREPARATION_MISMATCH');
assert.equal(build(original, {creationId: 'preparation-identity'}).item.common.creation_id, 'preparation-identity');

console.log('publication-payload: passed');

// 新原生编辑器将已选话题插入正文；构造器复用明确完整标记，避免双写文本并保持 UTF-16 范围。
const {buildPublicationPayload: buildNative, validateStudioDraft: validateNative} = await import('../app/platform/publication-payload.js');
const nativeBuild = (value, extra = {}) => buildNative({draft: value, images: [image], cover, ...extra});
{
  const value = draft({title: '标题🙂', description: '🙂 #摄影，\n第二行 #摄影技巧 #摄影', topics: [{id: '111', name: '摄影'}], mentions: []});
  const output = nativeBuild(value).item.common, tagged = JSON.parse(output.text_extra).find(item => item.type === 1);
  assert.equal(output.text, '标题🙂。🙂 #摄影，\n第二行 #摄影技巧 #摄影');
  assert.equal(output.text.slice(tagged.start, tagged.end), '#摄影');
  assert.equal(tagged.start, output.text.indexOf('#摄影'));
  assert.equal(value.description.trim().slice(tagged.caption_start, tagged.caption_end), '#摄影');
  const prefixOnly = nativeBuild({...value, description: '#摄影技巧'}).item.common;
  assert.equal(prefixOnly.text, '标题🙂。#摄影技巧 #摄影');
  assert.throws(() => validateNative({...value, topics: [{id: '111', name: '摄影'}, {id: '222', name: '摄影'}]}), /重复/);
}
{
  const value = draft({topics: [], mentions: [], settings: {...draft().settings, declarations: ['aigc']}});
  const output = nativeBuild(value, {declaration: {id: 'aigc', label: '内容由AI生成', disabled: false}});
  assert.deepEqual(output.item.declare, {user_declare_info: '{"choose_value":"aigc"}'});
  assert.throws(() => nativeBuild(value), /声明未重新确认/);
  assert.throws(() => nativeBuild(value, {declaration: {id: 'aigc', disabled: true}}), /声明未重新确认/);
  assert.throws(() => validateNative({...value, settings: {...value.settings, declarations: ['aigc', 'marketing']}}), /一项/);
}
console.log('native payload: existing topic range binding, duplicate-name rejection and verified declaration serialization passed');

// 官网明确绑定的名称话题使用数值0，范围照常提交；它不是现存平台身份，不进入challenges。
{
  const topics = [{id: '0', name: '20190701'}, {id: '111', name: '旅行'}, {id: '0', name: '新主题🙂'}];
  const value = draft({title: '标题🙂', description: '拍摄日期\n#20190701 #旅行 #新主题🙂', topics, mentions: []});
  const snapshot = structuredClone(value), common = nativeBuild(value).item.common;
  const extras = JSON.parse(common.text_extra).filter(item => item.type === 1);
  assert.deepEqual(extras.map(item => item.hashtag_id), [0, '111', 0], 'name-topic sentinel is a number; existing IDs remain exact strings');
  assert.deepEqual(JSON.parse(common.challenges), ['111']);
  assert.equal(common.hashtag_source, 'search/search/search');
  assert.equal(common.text, '标题🙂。' + value.description);
  for (const item of extras) {
    assert.equal(common.text.slice(item.start, item.end), '#' + item.hashtag_name);
    assert.equal(value.description.slice(item.caption_start, item.caption_end), '#' + item.hashtag_name);
  }
  assert.deepEqual(validateNative(value).topics, topics, 'distinct name topics sharing the official sentinel are separate choices');
  const namesOnly = {...value, topics: topics.filter(item => item.id === '0')};
  assert.deepEqual(validateNative(namesOnly, {operations: []}).topics, namesOnly.topics, 'explicit name topics do not require online topic search capability');
  assert.throws(() => validateNative(value, {operations: []}), error => error.code === 'UNSUPPORTED_FEATURE', 'positive identities keep their search-capability requirement');
  assert.deepEqual(value, snapshot);
  const unbound = nativeBuild({...value, topics: []}).item.common;
  assert.equal(unbound.text, common.text, 'unbound text is preserved without being silently promoted to a topic');
  assert.equal(JSON.parse(unbound.text_extra).filter(item => item.type === 1).length, 0);
  assert.equal(unbound.challenges, '[]');
  const onlyNamed = nativeBuild({...value, title: '', topics: [{id: '0', name: '20190701'}]}).item.common;
  assert.equal(onlyNamed.challenges, '[]');
  assert.equal(JSON.parse(onlyNamed.text_extra)[0].hashtag_id, 0);
  const video = buildNative({draft: {...value, kind: 'video', cover: null, assets: [{id: 'video-one', name: 'video.mp4', kind: 'video'}]},
    video: {vid: 'video-id', width: 1080, height: 1920, duration: 20}, cover}).item.common;
  assert.equal(video.caption, value.description);
  assert.equal(video.challenges, '["111"]');
  for (const item of JSON.parse(video.text_extra)) {
    assert.equal(video.text.slice(item.start, item.end), '#' + item.hashtag_name);
    assert.equal(video.caption.slice(item.caption_start, item.caption_end), '#' + item.hashtag_name);
  }
  for (const id of ['', undefined, null, 0, '00', '-1', 'name:20190701']) {
    assert.throws(() => validateNative({...value, topics: [{id, name: '20190701'}]}), /未经确认/);
  }
  for (const name of ['', ' ', '#20190701', '新\n话题', 'x'.repeat(201)]) {
    assert.throws(() => validateNative({...value, topics: [{id: '0', name}]}), error => error.code === 'INVALID_DRAFT');
  }
  assert.throws(() => validateNative({...value, topics: [{id: '0', name: '20190701'}, {id: '0', name: '20190701'}]}), /同一名称/);
  assert.throws(() => validateNative({...value, topics: [{id: '0', name: '20190701'}, {id: '123', name: '20190701'}]}), /同一名称/);
  assert.throws(() => validateNative({...value, topics: Array.from({length: 6}, (_, index) => ({id: '0', name: '主题' + index}))}), /最多添加 5/);
  for (const key of ['music', 'location', 'collection']) {
    assert.throws(() => validateNative({...value, [key]: {id: '0', name: '名称'}}), /未经确认/);
  }
  assert.throws(() => validateNative({...value, mentions: [{id: '0', name: '用户'}]}), /未经确认/);
  assert.throws(() => validateNative({...value, activities: [{id: '701', name: '活动', topic: {id: '0', name: '活动话题'}}]}), /未经确认/);
}
console.log('native name topics: numeric zero text_extra, positive-ID-only challenges, mixed identities, UTF-16 image/video ranges and no implicit binding passed');

// @ 与 # 都复用明确标记，同昵称不同用户按选择顺序绑定独立出现位置，不重复追加正文。
{
  const value = draft({title: '🙂标题', description: '🙂 @作者🙂，\n@同名 与 @同名 #旅行',
    topics: [{id: '111', name: '旅行'}], mentions: [{id: '201', name: '作者🙂'}, {id: '202', name: '同名'}, {id: '203', name: '同名'}]});
  const output = nativeBuild(value).item.common, extras = JSON.parse(output.text_extra).filter(item => item.type === 0);
  assert.equal(output.text, '🙂标题。' + value.description);
  assert.deepEqual(extras.map(item => item.user_id), ['201', '202', '203']);
  assert.deepEqual(extras.map(item => output.text.slice(item.start, item.end)), ['@作者🙂', '@同名', '@同名']);
  assert.notEqual(extras[1].start, extras[2].start);
  for (const item of extras) assert.equal(value.description.slice(item.caption_start, item.caption_end), output.text.slice(item.start, item.end));
  const incomplete = nativeBuild({...value, description: '@同名'}).item.common;
  assert.equal(incomplete.text, '🙂标题。@同名 #旅行 @作者🙂 @同名');
}

// 非 BMP 字母、汉字和组合音标属于正文，不是可拆分关联标记的边界。
for (const description of ['𠀀#旅行 @作者𠀀', '𐐀#旅行 @作者𐐀', '#旅行\u0301 @作者\u0301']) {
  const output = nativeBuild(draft({title: '', description, topics: [{id: '111', name: '旅行'}], mentions: [{id: '201', name: '作者'}]})).item.common;
  assert.equal(output.text, description + ' #旅行 @作者');
  for (const item of JSON.parse(output.text_extra)) assert.ok(item.start > description.length);
}
console.log('native associations: mention reuse, duplicate nicknames, Unicode code-point boundaries and UTF-16 ranges passed');

// 活动在编辑态关联真实话题，提交只保留一份 type1 范围，activity 使用话题 ID 而不是活动 ID。
{
  const activity = {id: '701', name: '官方摄影活动', topic: {id: '801', name: '摄影日常'}};
  const value = draft({title: '🙂', description: '前文 #摄影日常 后文', topics: [{id: '801', name: '摄影日常'}], activities: [activity], mentions: []});
  const snapshot = structuredClone(value), common = nativeBuild(value).item.common;
  assert.equal(common.text, '🙂。前文 #摄影日常 后文');
  assert.equal(common.activity, '["801"]'); assert.equal(common.challenges, '["801"]'); assert.equal(common.hashtag_source, 'recommend');
  const extras = JSON.parse(common.text_extra).filter(item => item.hashtag_id === '801');
  assert.equal(extras.length, 1); assert.equal(extras[0].type, 1);
  assert.equal(common.text.slice(extras[0].start, extras[0].end), '#摄影日常');
  assert.deepEqual(value, snapshot);
  const inferred = nativeBuild({...value, topics: []}).item.common;
  assert.equal(inferred.challenges, '["801"]', 'the activity topic remains part of the normalized payload even without a duplicate UI association');
  const sharedTopic = nativeBuild({...value, activities: [activity, {...activity, id: '702', name: '另一官方活动'}]}).item.common;
  assert.equal(sharedTopic.activity, '["801"]', 'activities sharing one real hashtag still submit one hashtag identity');
  assert.throws(() => nativeBuild({...value, topics: [{id: '801', name: '伪造名称'}]}), /身份不一致/);
  assert.throws(() => nativeBuild({...value, activities: [activity, activity]}), /重复选择/);
  assert.throws(() => nativeBuild({...value, activities: [{...activity, topic: {id: '802', name: '摄影日常'}}]}), /同一名称/);
  assert.throws(() => nativeBuild({...value, activities: [{...activity, topic: {id: 'invalid', name: '摄影日常'}}]}), /未经确认/);
  assert.throws(() => nativeBuild({...value, topics: Array.from({length: 5}, (_,index) => ({id: String(900 + index), name: '其他话题' + index}))}), /最多添加 5/);
  const video = buildNative({draft: {...value, kind: 'video', cover: null, assets: [{id: 'video-one', name: 'video.mp4', kind: 'video'}]}, video: {vid: 'video-id', width: 1080, height: 1920, duration: 20}, cover}).item.common;
  assert.equal(video.activity, '["801"]'); assert.equal(video.caption, '前文 #摄影日常 后文');
}
console.log('native activities payload: merged topic identity, UTF-16 range, type1 conversion, activity IDs, duplicates and official five-topic limit passed');

// 城市元数据仅用于恢复地点搜索；草稿中的附加字段不能替代当前平台核验结果。
{
  const location = {id: '404', name: '测试地点', cityCode: '440300', cityName: '深圳市', extra: '{"untrusted":true}', requiresNativeSelection: false};
  const value = draft({topics: [], mentions: [], location}), original = structuredClone(value);
  assert.deepEqual(validateNative(value).location, {id: '404', name: '测试地点', cityCode: '440300', cityName: '深圳市'});
  const output = nativeBuild(value, {location: {id: '404', name: '测试地点', extra: '{"verified":true}'}});
  assert.deepEqual(output.item.anchor, {poi_id: '404', poi_name: '测试地点', anchor_content: '{"verified":true}'});
  assert.equal(JSON.stringify(output).includes('440300'), false, 'city metadata is a query hint, not a publication field');
  assert.equal(JSON.stringify(output).includes('untrusted'), false);
  assert.deepEqual(value, original);
  assert.deepEqual(validateNative({...value, location: {id: '404', name: '测试地点'}}).location, {id: '404', name: '测试地点'}, 'older saved selections retain identity and can use an existing verified query record');
  for (const patch of [{cityCode: 440300}, {cityCode: '44030'}, {cityCode: 'https://invalid.test'}, {cityName: undefined}, {cityName: ''}, {cityName: '市'.repeat(51)}]) {
    assert.throws(() => validateNative({...value, location: {...location, ...patch}}), error => error.code === 'INVALID_DRAFT');
  }
  assert.throws(() => nativeBuild(value, {location: {id: '404', name: '测试地点', requiresNativeSelection: true}}), error => error.code === 'UNSUPPORTED_FEATURE');
  assert.throws(() => nativeBuild(value, {location: {id: '405', name: '测试地点'}}), error => error.code === 'PREPARATION_MISMATCH');
}
console.log('native location restoration: bounded city hints, immutable draft and verified platform-only publication metadata passed');

// App 原生插件允许独立图库封面；它只改变 poster，不能添加或重排正文图片。
for (const crop of [undefined, {x: 0.1, y: 0.2, width: 0.6, height: 0.7}]) {
  const value = draft({cover: {type: 'asset', assetId: 'independent-library-cover', ...(crop ? {crop} : {})}});
  const untouched = structuredClone(value);
  const normalized = validateNative(value);
  assert.deepEqual(normalized.cover, value.cover);
  const result = buildNative({draft: value, images: [image], cover: {uri: 'tos-image/independent-cover.jpg'}});
  assert.deepEqual(result.item.common.images, [{uri: image.uri, width: image.imageWidth, height: image.imageHeight}]);
  assert.equal(result.item.cover.upload_poster, 'tos-image/independent-cover.jpg');
  assert.deepEqual(value, untouched);
}
for (const assetId of ['https://example.test/cover.jpg', '/Users/private/cover.jpg', '../cover', '', null]) {
  assert.throws(() => validateNative(draft({cover: {type: 'asset', assetId}})), error => error.code === 'INVALID_DRAFT');
}
console.log('native publication payload: independent local cover leaves body image count, order and draft unchanged');
