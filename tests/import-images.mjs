import assert from 'node:assert/strict';
import {importImages} from '../browser/import-images.js';

// asset 为测试素材提供稳定业务身份与可改变的文件版本。
const asset = (id, revision = 'r1') => ({id, name: `${id}.jpg`, revision});
// uploaded 模拟已由服务端确认、可放入草稿的图片资源。
const uploaded = id => ({uri: `tos/${id}`, uriStatus: 2000, key: id, width: 1080, height: 1440});
// deferred 控制并发上传的完成顺序，不依赖计时器快慢。
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}
// tick 让已经排队的 Promise 和检查点完成一轮。
const tick = () => new Promise(resolve => setImmediate(resolve));

// harness 只替换外部 I/O；被测对象独立执行上传计划、并发收敛与资源复用。
function harness(items = [asset('a'), asset('b')]) {
  const calls = {reads: [], uploads: [], checkpoints: [], builds: [], auth: 0, crops: [], progress: []};
  const input = {job: {kind: 'image', assets: items.map(({id, name}) => ({id, name})), settings: {}}, account: 'account-1', origin: 'http://127.0.0.1:1234', base: {untouched: true}};
  const deps = {
    async resolveAssets(job) { return {assets: job.assets.map(source => structuredClone(items.find(item => item.id === source.id))), duplicates: 0}; },
    async prepareFile(job, origin, item) {
      calls.reads.push(item.id);
      return {assetID: item.id, revision: item.revision || null, file: new File(['image'], item.id, {type: 'image/jpeg'})};
    },
    async uploadImage(file, auth) {
      assert.equal(auth.SecretAccessKey, 'in-memory-only');
      calls.uploads.push(file.name);
      return {uploadFile: uploaded(file.name)};
    },
    async cropCoverFile(origin, id, crop) { calls.crops.push({id, crop}); return new File(['cover'], `cover-${id}`, {type: 'image/jpeg'}); },
    async buildImageDraft(value) { calls.builds.push(structuredClone(value)); return {saved: true, ...value}; },
    async checkpoint(records) { calls.checkpoints.push(structuredClone(records)); },
    async onProgress(value) { calls.progress.push(value); },
    async getAuth(account) { assert.equal(account, input.account); calls.auth++; return {SecretAccessKey: 'in-memory-only'}; }
  };
  return {input, deps, calls};
}

// 服务端完成顺序不改变稿件顺序；两条并发通道完成并持久化后才生成草稿。
{
  const h = harness([asset('a'), asset('b'), asset('c')]);
  const gates = new Map(), started = [], settled = [];
  let active = 0, peak = 0;
  h.deps.uploadImage = async file => {
    started.push(file.name); active++; peak = Math.max(peak, active);
    const gate = deferred(); gates.set(file.name, gate);
    await gate.promise; active--; settled.push(file.name);
    return {uploadFile: uploaded(file.name)};
  };
  const task = importImages(h.input, h.deps);
  await tick(); assert.deepEqual(started, ['a', 'b']); assert.equal(h.calls.builds.length, 0);
  gates.get('b').resolve(); await tick(); assert.deepEqual(started, ['a', 'b', 'c']);
  gates.get('c').resolve(); await tick(); assert.equal(h.calls.builds.length, 0);
  gates.get('a').resolve(); const result = await task;
  assert.equal(peak, 2); assert.deepEqual(settled, ['b', 'c', 'a']);
  assert.deepEqual(result.draft.files.map(file => file.uri), ['tos/a', 'tos/b', 'tos/c']);
  assert.equal(h.calls.checkpoints.length, 3); assert.equal(h.calls.checkpoints.at(-1).length, 3);
  assert.equal(result.stats.uploaded, 3); assert.equal(h.calls.auth, 1);
  assert.equal(JSON.stringify(result.records).includes('in-memory-only'), false);
}

// 一个文件失败后停止派发后续文件，等待另一在途文件保存成功再失败；重试只读取缺失资源。
{
  const h = harness([asset('a'), asset('b'), asset('c')]), gates = new Map(), started = [];
  h.deps.uploadImage = async file => {
    started.push(file.name);
    const gate = deferred(); gates.set(file.name, gate);
    await gate.promise;
    return {uploadFile: uploaded(file.name)};
  };
  let ended = false;
  const task = importImages(h.input, h.deps).then(() => assert.fail('must reject'), error => { ended = true; return error; });
  await tick(); gates.get('a').reject(Error('upload interrupted'));
  await tick(); assert.equal(ended, false); assert.deepEqual(started, ['a', 'b']);
  gates.get('b').resolve(); const error = await task;
  assert.match(error.message, /upload interrupted/); assert.equal(h.calls.builds.length, 0);
  assert.deepEqual(h.calls.checkpoints.at(-1).map(record => record.assetID), ['b']);
  const retry = harness([asset('a'), asset('b'), asset('c')]); retry.input.previous = h.calls.checkpoints.at(-1);
  const result = await importImages(retry.input, retry.deps);
  assert.deepEqual(retry.calls.reads, ['a', 'c']); assert.deepEqual(retry.calls.uploads, ['a', 'c']);
  assert.equal(result.stats.reused, 1); assert.equal(result.stats.uploaded, 2);
}

// 同文件名、不同账号或版本都不能认领旧资源；全量复用不获取上传凭据、不读取文件。
{
  const h = harness(), first = await importImages(h.input, h.deps);
  const repeat = harness(); repeat.input.previous = first.records;
  const reused = await importImages(repeat.input, repeat.deps);
  assert.equal(repeat.calls.auth, 0); assert.deepEqual(repeat.calls.reads, []); assert.equal(reused.stats.reused, 2);
  const changed = harness([asset('a', 'r2'), asset('b')]); changed.input.previous = first.records;
  await importImages(changed.input, changed.deps); assert.deepEqual(changed.calls.uploads, ['a']);
  const account = harness(); account.input.account = 'account-2'; account.input.previous = first.records;
  const other = await importImages(account.input, account.deps);
  assert.equal(other.stats.uploaded, 2); assert.equal(other.records.filter(record => record.account === 'account-1').length, 2);
  const unknown = harness([asset('a', '')]); unknown.input.previous = [{account: 'account-1', kind: 'image', assetID: 'a', revision: '', uploadFile: uploaded('old')}];
  await importImages(unknown.input, unknown.deps); assert.deepEqual(unknown.calls.uploads, ['a']);
}

// 封面按真实静态素材身份、版本及裁剪参数复用，不以正文索引或裁剪对象键顺序判断。
{
  const h = harness(), crop = {x: 0, y: 0, width: 1, height: 0.75};
  h.input.job.settings = {coverIndex: 1, coverCrop: crop};
  const first = await importImages(h.input, h.deps);
  assert.deepEqual(h.calls.crops, [{id: 'b', crop}]); assert.equal(first.draft.cover.uri, 'tos/cover-b');
  assert.equal(first.stats.coverUploaded, 1); assert.equal(h.calls.auth, 1);
  const repeat = harness(); repeat.input.previous = first.records;
  repeat.input.job.settings = {coverIndex: 1, coverCrop: {height: 0.75, width: 1, y: 0, x: 0}};
  const same = await importImages(repeat.input, repeat.deps);
  assert.equal(same.stats.coverReused, 1); assert.equal(repeat.calls.auth, 0); assert.deepEqual(repeat.calls.crops, []);
  const changed = harness(); changed.input.previous = first.records;
  changed.input.job.settings = {coverIndex: 1, coverCrop: {...crop, height: 0.5}};
  const next = await importImages(changed.input, changed.deps);
  assert.deepEqual(changed.calls.uploads, ['cover-b']); assert.equal(next.stats.coverUploaded, 1); assert.equal(next.stats.reused, 2);
  const live = harness([asset('still')]); live.input.job.assets = [{id: 'live', name: 'live.jpg'}, {id: 'still', name: 'still.jpg'}];
  live.input.job.settings = {coverIndex: 0, coverCrop: crop};
  live.deps.resolveAssets = async job => ({assets: [asset('still')], duplicates: job.assets.length - 1});
  const result = await importImages(live.input, live.deps);
  assert.equal(result.stats.duplicates, 1); assert.equal(result.draft.files.length, 1); assert.equal(live.calls.crops[0].id, 'still');
}

// 检查点串行提交，避免较早快照迟到而覆盖较新的成功记录。
{
  const h = harness(), gates = [], snapshots = [];
  let persisting = 0, peak = 0;
  h.deps.checkpoint = async records => {
    persisting++; peak = Math.max(peak, persisting); snapshots.push(records);
    const gate = deferred(); gates.push(gate); await gate.promise; persisting--;
  };
  const task = importImages(h.input, h.deps);
  await tick(); assert.equal(gates.length, 1); assert.equal(h.calls.builds.length, 0);
  gates[0].resolve(); await tick(); assert.equal(gates.length, 2); assert.equal(h.calls.builds.length, 0);
  gates[1].resolve(); await task; assert.equal(peak, 1); assert.deepEqual(snapshots.map(value => value.length), [1, 2]);
}

// 单次持久化失败不会丢弃其他在途上传，仍保存后续完整快照后报告失败。
{
  const h = harness(), snapshots = [];
  h.deps.checkpoint = async records => { snapshots.push(records); if (snapshots.length === 1) throw Error('storage failed'); };
  await assert.rejects(importImages(h.input, h.deps), /storage failed/);
  assert.equal(snapshots.length, 2); assert.equal(snapshots[1].length, 2); assert.equal(h.calls.builds.length, 0);
}

// 首批读取全部失败不发出上传；不完整上传响应不能写入成功记录或草稿。
{
  const h = harness(); h.deps.prepareFile = async () => { throw Error('file missing'); };
  await assert.rejects(importImages(h.input, h.deps), /file missing/);
  assert.equal(h.calls.uploads.length, 0); assert.equal(h.calls.auth, 0); assert.equal(h.calls.checkpoints.length, 0);
  const invalid = harness([asset('a')]); invalid.deps.uploadImage = async () => ({uploadFile: {uri: 'pending', uriStatus: 1000}});
  await assert.rejects(importImages(invalid.input, invalid.deps), /未返回已完成/);
  assert.equal(invalid.calls.builds.length, 0); assert.equal(invalid.calls.checkpoints.length, 0);
  const revision = harness([asset('a')]); revision.deps.prepareFile = async () => ({assetID: 'a', revision: 'changed', file: new File(['x'], 'a')});
  await assert.rejects(importImages(revision.input, revision.deps), /版本已变化/); assert.equal(revision.calls.uploads.length, 0);
}

// 展示失败不影响上传真实性；最终草稿校验失败时，已成功资源仍可供下次带入复用。
{
  const h = harness(); h.deps.onProgress = async () => { throw Error('panel closed'); };
  h.deps.buildImageDraft = async () => { throw Error('draft invalid'); };
  await assert.rejects(importImages(h.input, h.deps), /draft invalid/);
  assert.equal(h.calls.checkpoints.at(-1).length, 2); assert.equal(h.calls.uploads.length, 2);
}

console.log('PASS extension-owned image import, account/version reuse, two-upload limit, settled failures, serialized checkpoints, isolated cover and atomic draft staging');
