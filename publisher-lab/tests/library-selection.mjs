import assert from 'node:assert/strict';
import {selectLibraryAssets} from '../app/library-selection.js';

// fixture 模拟宿主确认回执和已有草稿；没有真正导航或读取用户素材。
function fixture(overrides = {}) {
  const calls = [];
  let draft = {id: 'draft-1', kind: 'image', title: '保留标题', assets: [{id: 'existing', kind: 'image', name: '已有.jpg'}], cover: {type: 'asset', assetId: 'existing'}};
  const options = {context: {nativeUIAvailable: true, nativeCapabilities: {mediaSelectionVersion: 1}}, currentDraft: () => draft,
    save: async () => { calls.push('save'); return true; },
    post: async message => { calls.push(message); return {ok: true, data: {cancelled: false, assetIDs: ['image-2', 'image-2']}}; },
    resolveAssets: async ids => { calls.push({resolve: ids}); return ids.map(id => ({id, kind: 'image', name: id + '.jpg'})); }, ...overrides};
  return {calls, options, draft: () => draft, replace: value => { draft = value; }};
}
{
  const h = fixture(), before = structuredClone(h.draft());
  const result = await selectLibraryAssets(h.options);
  assert.deepEqual(h.calls.slice(0, 2), ['save', {op: 'assets.select', kind: 'image', maximumCount: 34, excludeAssetIDs: ['existing']}]);
  assert.equal(result.target, 'media'); assert.equal(result.draftId, 'draft-1');
  assert.deepEqual(result.assets, [{id: 'image-2', kind: 'image', name: 'image-2.jpg'}]);
  assert.deepEqual(h.draft(), before, 'only UI applies a validated result');
}
{
  const h = fixture({post: async message => ({ok: true, data: {cancelled: false, assetIDs: ['existing']}})});
  const result = await selectLibraryAssets({...h.options, target: 'cover'});
  assert.equal(result.target, 'cover'); assert.equal(result.assets[0].id, 'existing');
  assert.equal(h.draft().assets.length, 1, 'cover selection is not a body append');
}
{
  const h = fixture({post: async () => ({ok: true, data: {cancelled: true, assetIDs: []}})}), before = structuredClone(h.draft());
  assert.equal((await selectLibraryAssets(h.options)).cancelled, true);
  assert.deepEqual(h.draft(), before); assert.equal(h.calls.some(call => call.resolve), false);
}
{
  const h = fixture({save: async () => false});
  await assert.rejects(selectLibraryAssets(h.options), error => error.code === 'MEDIA_SELECTION_SAVE_FAILED');
  assert.equal(h.calls.length, 0, 'failed save cannot navigate or resolve assets');
  const old = fixture({context: {nativeUIAvailable: true, nativeCapabilities: {}}});
  await assert.rejects(selectLibraryAssets(old.options), error => error.code === 'MEDIA_SELECTION_UNAVAILABLE');
  assert.equal(old.calls.length, 0, 'old hosts receive an update error with no fallback');
}
{
  const h = fixture();
  h.options.post = async () => { h.replace({...h.draft(), id: 'other-draft'}); return {ok: true, data: {cancelled: false, assetIDs: ['image-2']}}; };
  await assert.rejects(selectLibraryAssets(h.options), error => error.code === 'MEDIA_SELECTION_STALE');
  assert.equal(h.calls.some(call => call.resolve), false);
}
{
  const h = fixture({resolveAssets: async ids => ids.map(id => ({id, kind: 'video', name: 'wrong.mp4'}))}), before = structuredClone(h.draft());
  await assert.rejects(selectLibraryAssets(h.options), error => error.code === 'MEDIA_SELECTION_INVALID');
  assert.deepEqual(h.draft(), before);
  h.options.resolveAssets = async () => [];
  await assert.rejects(selectLibraryAssets(h.options), error => error.code === 'MEDIA_SELECTION_INVALID');
}
{
  const h = fixture(); h.draft().kind = 'video';
  await assert.rejects(selectLibraryAssets(h.options), error => error.code === 'MEDIA_SELECTION_FULL');
  assert.equal(h.calls.length, 0);
  h.draft().assets = [];
  h.options.post = async message => { assert.equal(message.maximumCount, 1); assert.equal(message.kind, 'video'); return {ok: true, data: {cancelled: false, assetIDs: ['a', 'b']}}; };
  await assert.rejects(selectLibraryAssets(h.options), error => error.code === 'MEDIA_SELECTION_FULL');
}
console.log('library selection: save before navigation, target/account-independent draft binding, cancel preservation, deduplication, capacity, type checks and old-host rejection passed');
