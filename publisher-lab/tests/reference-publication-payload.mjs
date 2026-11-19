// Historical Chrome payload contract; run with npm run test:reference.
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
