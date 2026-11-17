import assert from 'node:assert/strict';
import {importVideo} from '../browser/import-video.js';

// fixture 生成已上传但尚未确认转码的资源；模拟 VOD 和 transend 使用不同字段命名。
function fixture() {
  return {vid: 'video-1', uploadFile: {vid: 'video-1', name: 'movie.mp4', type: 'video/mp4', size: 128, duration: 0, width: 0, height: 0, uri: '', coverUri: ''}, videoMeta: {codec: 'h264'}};
}
// ready 是平台确认的最终媒体信息，尺寸允许接口按字符串返回。
const ready = {encode: 1, duration: 10.5, width: '1080', height: '1920', poster_uri: 'tos/poster', format: 'mp4', play_url: 'https://media.example/video-1.mp4'};
// harness 记录全部外部副作用，并以虚拟时间覆盖转码超时边界。
function harness() {
  let clock = 1000;
  const calls = {reads: 0, auth: 0, uploads: 0, enables: [], statuses: [], checkpoints: [], builds: [], waits: []};
  const input = {job: {kind: 'video', assets: [{id: 'a', name: 'movie.mp4'}], settings: {}}, account: 'account-1', origin: 'http://127.0.0.1:1234'};
  const deps = {
    async resolveAssets() { return {assets: [{id: 'a', name: 'movie.mp4', revision: 'r1'}]}; },
    async prepareFile(job, origin, asset) {
      calls.reads++;
      return {assetID: asset.id, revision: asset.revision, file: new File(['video'], 'movie.mp4', {type: 'video/mp4'})};
    },
    async getAuth(account) { assert.equal(account, input.account); calls.auth++; return {SecretAccessKey: 'memory-only'}; },
    async uploadVideo(file, auth) { assert.equal(auth.SecretAccessKey, 'memory-only'); calls.uploads++; return fixture(); },
    async enableVideo(vid) { calls.enables.push(vid); return {status_code: 0}; },
    async getVideoStatus(vid) { calls.statuses.push(vid); return structuredClone(ready); },
    async checkpoint(records) { calls.checkpoints.push(structuredClone(records)); },
    async buildVideoDraft(value) { calls.builds.push(structuredClone(value)); return {cache: value.video}; },
    now: () => clock,
    async wait(milliseconds) { calls.waits.push(milliseconds); clock += milliseconds; },
  };
  return {input, deps, calls};
}

// 先持久化上传资源，再查询转码并生成草稿；平台返回尺寸和封面覆盖未就绪的上传元数据。
{
  const h = harness();
  h.deps.getVideoStatus = async vid => {
    assert.equal(h.calls.checkpoints.length, 2); assert.equal(h.calls.checkpoints[0][0].ready, false);
    assert.equal(h.calls.checkpoints[0][0].enabled, false); assert.equal(h.calls.checkpoints[1][0].enabled, true);
    h.calls.statuses.push(vid); return h.calls.statuses.length === 1 ? {encode: 0, status_code: 0} : structuredClone(ready);
  };
  const result = await importVideo(h.input, h.deps);
  assert.equal(h.calls.reads, 1); assert.equal(h.calls.auth, 1); assert.equal(h.calls.uploads, 1);
  assert.equal(h.calls.checkpoints.length, 3); assert.equal(h.calls.checkpoints[2][0].ready, true);
  assert.deepEqual(h.calls.enables, ['video-1']);
  assert.deepEqual(h.calls.waits, [1000]); assert.deepEqual(h.calls.statuses, ['video-1', 'video-1']);
  assert.equal(result.draft.cache.width, 1080); assert.equal(result.draft.cache.height, 1920);
  assert.equal(result.draft.cache.coverUri, 'tos/poster'); assert.equal(result.draft.cache.duration, 10.5);
  assert.equal(JSON.stringify(result.records).includes('memory-only'), false);
}

// 查询失败不自动重传；下次用户主动带入从已保存 VID 继续等待转码。
{
  const h = harness(); h.deps.getVideoStatus = async () => { throw Error('network interrupted'); };
  await assert.rejects(importVideo(h.input, h.deps), /network interrupted/);
  assert.equal(h.calls.uploads, 1); assert.equal(h.calls.builds.length, 0); assert.equal(h.calls.checkpoints.length, 2);
  const retry = harness(); retry.input.previous = h.calls.checkpoints.at(-1);
  const result = await importVideo(retry.input, retry.deps);
  assert.equal(result.stats.reused, 1); assert.equal(retry.calls.reads, 0); assert.equal(retry.calls.auth, 0); assert.equal(retry.calls.uploads, 0);
  assert.equal(retry.calls.statuses.length, 1); assert.equal(result.records[0].ready, true);
  assert.equal(retry.calls.enables.length, 0);
  const repeat = harness(); repeat.input.previous = result.records;
  await importVideo(repeat.input, repeat.deps);
  assert.equal(repeat.calls.statuses.length, 0); assert.equal(repeat.calls.uploads, 0); assert.equal(repeat.calls.auth, 0);
  assert.equal(repeat.calls.enables.length, 0);
}

// 持续处理中在三分钟后结束，只查询用户已提交的一个视频，保留资源供稍后重试。
{
  const h = harness(); h.deps.getVideoStatus = async vid => { h.calls.statuses.push(vid); return {encode: 0, status_code: 0}; };
  await assert.rejects(importVideo(h.input, h.deps), /仍在抖音处理中/);
  assert.equal(h.calls.waits.reduce((sum, value) => sum + value, 0), 180000);
  assert.equal(h.calls.statuses.length, 180); assert.equal(h.calls.uploads, 1); assert.equal(h.calls.builds.length, 0);
  assert.equal(h.calls.checkpoints[0][0].ready, false);
}

// 账号、素材身份和文件版本任一变化都禁止复用旧 VID；缺失版本时在上传前失败。
{
  const first = harness(), result = await importVideo(first.input, first.deps);
  const account = harness(); account.input.account = 'account-2'; account.input.previous = result.records;
  const next = await importVideo(account.input, account.deps);
  assert.equal(account.calls.uploads, 1); assert.equal(next.records.length, 2);
  const changed = harness(); changed.input.previous = result.records;
  changed.deps.resolveAssets = async () => ({assets: [{id: 'a', revision: 'r2'}]});
  await importVideo(changed.input, changed.deps); assert.equal(changed.calls.uploads, 1);
  const identity = harness(); identity.input.previous = result.records;
  identity.deps.resolveAssets = async () => ({assets: [{id: 'different', revision: 'r1'}]});
  await importVideo(identity.input, identity.deps); assert.equal(identity.calls.uploads, 1);
  const unknown = harness(); unknown.deps.resolveAssets = async () => ({assets: [{id: 'a'}]});
  await assert.rejects(importVideo(unknown.input, unknown.deps), /文件版本/); assert.equal(unknown.calls.uploads, 0);
}

// 未知上传结果不会轮询或写草稿；未知转码状态与不完整最终信息保留已上传资源。
{
  const upload = harness(); upload.deps.uploadVideo = async () => ({vid: 'one', uploadFile: {vid: 'other'}});
  await assert.rejects(importVideo(upload.input, upload.deps), /未确认视频资源/);
  assert.equal(upload.calls.checkpoints.length, 0); assert.equal(upload.calls.statuses.length, 0);
  for (const status of [{}, {encode: '0'}, {encode: -1}, {encode: 2}, {...ready, poster_uri: ''}, {...ready, duration: 0}, {...ready, width: 'unknown'}, {...ready, play_url: ''}, {...ready, play_url: 'javascript:alert(1)'}, {...ready, format: undefined}]) {
    const h = harness(); h.deps.getVideoStatus = async () => status;
    await assert.rejects(importVideo(h.input, h.deps));
    assert.equal(h.calls.checkpoints.length, 2); assert.equal(h.calls.builds.length, 0); assert.equal(h.calls.uploads, 1);
  }
}

// 本地读取失败不上传，检查点失败不继续查询，草稿生成失败不丢失已完成转码资源。
{
  const read = harness(); read.deps.prepareFile = async () => { throw Error('missing file'); };
  await assert.rejects(importVideo(read.input, read.deps), /missing file/); assert.equal(read.calls.auth, 0);
  const changed = harness(); changed.deps.prepareFile = async () => ({assetID: 'a', revision: 'changed', file: new File(['changed'], 'movie.mp4')});
  await assert.rejects(importVideo(changed.input, changed.deps), /版本已变化/); assert.equal(changed.calls.auth, 0); assert.equal(changed.calls.uploads, 0);
  const save = harness(); save.deps.checkpoint = async () => { throw Error('storage failed'); };
  await assert.rejects(importVideo(save.input, save.deps), /storage failed/); assert.equal(save.calls.statuses.length, 0);
  assert.equal(save.calls.enables.length, 0);
  const draft = harness(); draft.deps.buildVideoDraft = async () => { throw Error('invalid draft'); };
  draft.deps.onProgress = async () => { throw Error('panel closed'); };
  await assert.rejects(importVideo(draft.input, draft.deps), /invalid draft/); assert.equal(draft.calls.checkpoints.at(-1)[0].ready, true);
}

// 真实 encode=0 是处理中；即使 Commit 已含完整元数据也不能提前生成草稿。
{
  const h = harness();
  h.deps.uploadVideo = async () => {h.calls.uploads++;const result=fixture();Object.assign(result.uploadFile,{duration:5,width:1280,height:720,coverUri:'tos/first-frame'});return result;};
  h.deps.getVideoStatus = async () => ({status_code:0,encode:0});
  await assert.rejects(importVideo(h.input,h.deps), /仍在抖音处理中/);
  assert.equal(h.calls.builds.length,0);assert.equal(h.calls.uploads,1);assert.equal(h.calls.checkpoints.at(-1)[0].ready,false);
}

// enable 失败仅留下已上传资源；用户重试可继续 enable，成功检查点后不会重复 enable 或上传。
{
  const h = harness(); h.deps.enableVideo = async vid => { h.calls.enables.push(vid); throw Error('enable failed'); };
  await assert.rejects(importVideo(h.input, h.deps), /enable failed/);
  assert.equal(h.calls.statuses.length, 0); assert.equal(h.calls.checkpoints.length, 1);
  assert.equal(h.calls.checkpoints[0][0].enabled, false);
  const retry = harness(); retry.input.previous = h.calls.checkpoints[0];
  await importVideo(retry.input, retry.deps);
  assert.equal(retry.calls.uploads, 0); assert.deepEqual(retry.calls.enables, ['video-1']);
}

// 缺少 transend 证明的 ready 标记不能跳过实际处理确认，但 VID 仍复用以避免重复上传。
{
  const h = harness();
  h.input.previous = [{account: h.input.account, kind: 'video', assetID: 'a', revision: 'r1', uploadFile: {...fixture().uploadFile, duration: 5, width: 1280, height: 720, coverUri: 'old'}, ready: true}];
  const result = await importVideo(h.input, h.deps);
  assert.equal(h.calls.uploads, 0); assert.equal(h.calls.statuses.length, 1); assert.deepEqual(h.calls.enables, ['video-1']);
  assert.equal(result.records[0].transcode.encode, 1); assert.equal(result.draft.cache.coverUri, ready.poster_uri);
}

console.log('PASS video enable/checkpoint, encode-zero pending, complete transend proof, account/revision reuse, bounded wait and no duplicate upload');
