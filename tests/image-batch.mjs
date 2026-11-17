import assert from 'node:assert/strict';
import {prepareFile, resolveAssets} from '../browser/media.js';
import {importImages} from '../browser/import-images.js';
import {buildImageDraft} from '../browser/draft-model.js';
import {MAX_FILE, MAX_VIDEO_FILE} from '../browser/protocol.js';

const MiB = 1024 * 1024, origin = 'http://127.0.0.1:54321', account = '123456';
const zeros = new Uint8Array(MiB), originalFetch = globalThis.fetch;
const tick = () => new Promise(resolve => setImmediate(resolve));

// deferred 将读取、上传与持久化分别停在真实异步边界，不依赖机器运行速度。
function deferred() {
  let resolvePromise, rejectPromise, settled = false;
  const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
  return {promise, get settled() { return settled; }, resolve(value) { settled = true; resolvePromise(value); }, reject(error) { settled = true; rejectPromise(error); }};
}

// streamedFile 生成指定真实字节数的可读流；每段最多 1 MiB，记录头拒绝、流取消和锁释放。
function streamedFile({size, kind = 'image', length = size, gate = null}) {
  let offset = 0;
  const state = {reads: 0, bytes: 0, canceled: false, unlocked: false, readerCreated: false};
  const response = {ok: true, status: 200, headers: {get(name) { return name === 'content-length' && length !== null ? String(length) : null; }},
    body: {
      async cancel() { state.canceled = true; },
      getReader() {
        assert.equal(state.readerCreated, false); state.readerCreated = true;
        return {
          async read() {
            state.reads++;
            if (!offset && gate) await gate.promise;
            if (offset === size) return {done: true};
            const count = Math.min(MiB, size - offset);
            let value = zeros.subarray(0, count);
            if (offset === 0) {
              value = new Uint8Array(count);
              if (kind === 'image') value.set([255, 216, 255]);
              else value.set([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
            }
            offset += count; state.bytes += count; return {done: false, value};
          },
          async cancel() { state.canceled = true; },
          releaseLock() { state.unlocked = true; },
        };
      },
    },
  };
  return {response, state};
}

// assertJSONRecords 保证检查点只保存资源契约，不把 File、二进制或上传凭据留在持久化记录。
function assertJSONRecords(value) {
  assert.equal(value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value), false);
  if (value && typeof value === 'object') for (const child of Object.values(value)) assertJSONRecords(child);
}

// batch 使用真实素材解析、单文件读取、上传编排和草稿构造，只替换网络与持久化 I/O。
function batch(count = 17, previous = []) {
  const assets = Array.from({length: count}, (_, index) => ({id: `a${String(index).padStart(2, '0')}`, name: `a${String(index).padStart(2, '0')}.jpg`}));
  const job = {kind: 'image', title: '十七张图片', description: '超过旧总量限制的正常图文', assets,
    settings: {visibility: 'private', download: 'deny', publishTime: 'now'}};
  const metadata = [], reads = [], uploads = [], checkpoints = [], commits = [], builds = [], retained = new Map();
  const readGates = new Map(), uploadGates = new Map();
  let retainedPeak = 0, retainedBytesPeak = 0, authCalls = 0, finished = false;
  globalThis.fetch = async (url, options) => {
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    const parsed = new URL(url);
    assert.equal(parsed.origin, origin);
    const match = /^\/api\/v1\/assets\/(a\d{2})(\/original)?$/.exec(parsed.pathname);
    assert.ok(match, `Unexpected asset request ${url}`); assert.equal(parsed.search, '');
    const asset = assets.find(item => item.id === match[1]); assert.ok(asset);
    if (!match[2]) {
      metadata.push(asset.id);
      return {ok: true, json: async () => ({code: 0, data: {name: asset.name, sizeBytes: 6 * MiB, modifiedAt: '2026-11-16T00:00:00Z'}})};
    }
    assert.equal(readGates.has(asset.id), false, 'read each original at most once in this attempt');
    const gate = deferred(), stream = streamedFile({size: 6 * MiB, gate});
    readGates.set(asset.id, gate); reads.push({id: asset.id, state: stream.state}); return stream.response;
  };
  const dependencies = {
    resolveAssets,
    async prepareFile(job, localOrigin, asset) {
      const prepared = await prepareFile(job, localOrigin, asset);
      assert.equal(prepared.assetID, asset.id); assert.equal(prepared.revision, asset.revision);
      assert.equal(prepared.size, 6 * MiB); assert.equal(prepared.file.size, prepared.size); assert.equal(prepared.type, 'image/jpeg');
      retained.set(asset.id, prepared.file);
      retainedPeak = Math.max(retainedPeak, retained.size);
      retainedBytesPeak = Math.max(retainedBytesPeak, [...retained.values()].reduce((sum, file) => sum + file.size, 0));
      assert.ok(retained.size <= 2, 'no more than two file payloads may wait for upload/checkpoint');
      return prepared;
    },
    async uploadImage(file, auth) {
      assert.equal(auth.SecretAccessKey, 'in-memory-only');
      const id = file.name.replace(/\.jpg$/, '');
      assert.equal(retained.get(id), file);
      assert.deepEqual([...new Uint8Array(await file.slice(0, 3).arrayBuffer())], [255, 216, 255]);
      assert.equal(file.size, 6 * MiB);
      const gate = deferred(); uploadGates.set(id, gate); uploads.push(id);
      await gate.promise;
      return {uploadFile: {uri: `tos/${id}`, uriStatus: 2000, imageWidth: 1080, imageHeight: 1440}};
    },
    async checkpoint(records) {
      assertJSONRecords(records); assert.equal(JSON.stringify(records).includes('in-memory-only'), false);
      const gate = deferred(), snapshot = structuredClone(records);
      checkpoints.push({snapshot, gate}); await gate.promise;
      commits.push(snapshot);
      // 文件负载至少保留至上传和对应持久化都完成，不能在上传返回前计作已释放。
      for (const record of snapshot) retained.delete(record.assetID);
    },
    async buildImageDraft(value) { builds.push(value.files.map(file => file.uri)); return buildImageDraft(value); },
    async cropCoverFile() { assert.fail('No separate cover was requested'); },
    async getAuth() { authCalls++; return {SecretAccessKey: 'in-memory-only'}; },
  };
  const task = importImages({job, account, origin, previous}, dependencies);
  task.then(() => { finished = true; }, () => { finished = true; });
  // finish 逐步放行现有工作，让每次完整流水线完成后才出现的新工作继续推进。
  async function finish() {
    for (let round = 0; round < 100 && !finished; round++) {
      for (const gate of [...readGates.values(), ...uploadGates.values(), ...checkpoints.map(item => item.gate)]) if (!gate.settled) gate.resolve();
      await tick();
    }
    assert.equal(finished, true, 'all dispatched work must settle');
    return task;
  }
  return {task, finish, metadata, reads, uploads, checkpoints, commits, builds, retained, readGates, uploadGates,
    get finished() { return finished; }, get retainedPeak() { return retainedPeak; }, get retainedBytesPeak() { return retainedBytesPeak; }, get authCalls() { return authCalls; }};
}

try {
  // 17×6 MiB 必须成功；第二条通道读取未完成和第一条通道上传/检查点未完成时都不能预读第三张。
  const many = batch(); await tick();
  assert.equal(many.metadata.length, 17);
  assert.deepEqual(many.reads.map(item => item.id), ['a00', 'a01']); assert.deepEqual(many.uploads, []);
  many.readGates.get('a00').resolve(); await tick();
  assert.deepEqual(many.uploads, ['a00']); assert.equal(many.reads.length, 2);
  many.readGates.get('a01').resolve(); await tick();
  assert.deepEqual(many.uploads, ['a00', 'a01']); assert.equal(many.reads.length, 2); assert.equal(many.retained.size, 2);
  many.uploadGates.get('a00').resolve(); await tick();
  assert.equal(many.checkpoints.length, 1); assert.equal(many.reads.length, 2); assert.equal(many.retained.size, 2);
  many.checkpoints[0].gate.resolve(); await tick();
  assert.deepEqual(many.reads.map(item => item.id), ['a00', 'a01', 'a02']);
  many.readGates.get('a02').resolve(); await tick();
  assert.equal(many.retained.size, 2); assert.equal(many.reads.length, 3);
  const result = await many.finish();
  assert.equal(many.reads.reduce((sum, item) => sum + item.state.bytes, 0), 102 * MiB);
  assert.equal(many.reads.length, 17); assert.equal(many.uploads.length, 17); assert.equal(many.commits.length, 17);
  assert.equal(many.retainedPeak, 2); assert.equal(many.retainedBytesPeak, 12 * MiB); assert.equal(many.retained.size, 0);
  assert.equal(many.authCalls, 1); assert.equal(result.stats.uploaded, 17); assert.equal(result.records.length, 17);
  assert.deepEqual(result.draft.files.map(item => item.uploadFile.uri), Array.from({length: 17}, (_, index) => `tos/a${String(index).padStart(2, '0')}`));
  assert.equal(many.builds.length, 1); assert.ok(many.reads.every(item => item.state.unlocked && !item.state.canceled));

  // 第二张读取失败仍等待第一张在途上传和检查点；失败后第三张及后续原图不读取。
  const failedRead = batch(4); await tick();
  failedRead.readGates.get('a00').resolve(); await tick(); assert.deepEqual(failedRead.uploads, ['a00']);
  failedRead.readGates.get('a01').reject(Error('synthetic disk failure')); await tick();
  assert.equal(failedRead.finished, false); assert.equal(failedRead.reads.length, 2); assert.equal(failedRead.checkpoints.length, 0);
  failedRead.uploadGates.get('a00').resolve(); await tick();
  assert.equal(failedRead.finished, false); assert.equal(failedRead.checkpoints.length, 1); assert.equal(failedRead.reads.length, 2);
  failedRead.checkpoints[0].gate.resolve();
  await assert.rejects(failedRead.task, /a01\.jpg/);
  assert.equal(failedRead.builds.length, 0); assert.equal(failedRead.retained.size, 0);
  assert.deepEqual(failedRead.commits.at(-1).map(record => record.assetID), ['a00']);
  assert.equal(failedRead.reads[1].state.canceled, true); assert.equal(failedRead.reads[1].state.unlocked, true);
  const retry = batch(4, failedRead.commits.at(-1)); const recovered = await retry.finish();
  assert.deepEqual(retry.reads.map(item => item.id), ['a01', 'a02', 'a03']);
  assert.equal(recovered.stats.reused, 1); assert.equal(recovered.stats.uploaded, 3);

  // 上传错误也须收敛在途成功项，不能在报错后继续读取队列里的图片。
  const failedUpload = batch(4); await tick();
  failedUpload.readGates.get('a00').resolve(); failedUpload.readGates.get('a01').resolve(); await tick();
  failedUpload.uploadGates.get('a00').reject(Error('upload failed')); await tick();
  assert.equal(failedUpload.finished, false); assert.equal(failedUpload.reads.length, 2);
  failedUpload.uploadGates.get('a01').resolve(); await tick();
  assert.equal(failedUpload.finished, false); assert.equal(failedUpload.checkpoints.length, 1);
  failedUpload.checkpoints[0].gate.resolve(); await assert.rejects(failedUpload.task, /upload failed/);
  assert.deepEqual(failedUpload.commits.at(-1).map(record => record.assetID), ['a01']);
  assert.equal(failedUpload.reads.length, 2); assert.equal(failedUpload.builds.length, 0);

  // 图片只有单张 50 MiB 上限，视频仍是单文件 80 MiB；头声明与流实收都要执行同一上限。
  assert.equal(MAX_FILE, 50 * MiB); assert.equal(MAX_VIDEO_FILE, 80 * MiB);
  for (const [kind, limit, name, type] of [['image', MAX_FILE, 'boundary.jpg', 'image/jpeg'], ['video', MAX_VIDEO_FILE, 'boundary.mp4', 'video/mp4']]) {
    const asset = {id: 'boundary', name, revision: 'boundary-v1'};
    const exact = streamedFile({size: limit, kind});
    globalThis.fetch = async () => exact.response;
    const prepared = await prepareFile({kind}, origin, asset);
    assert.equal(prepared.file.size, limit); assert.equal(prepared.size, limit); assert.equal(prepared.type, type);
    assert.equal(exact.state.canceled, false); assert.equal(exact.state.unlocked, true);
    for (const source of ['length', 'stream']) {
      const exceeded = streamedFile({size: limit + 1, kind, length: source === 'length' ? limit + 1 : null});
      globalThis.fetch = async () => exceeded.response;
      await assert.rejects(prepareFile({kind}, origin, asset), error => {
        assert.equal(error.code, 'MEDIA_FILE_TOO_LARGE'); assert.ok(error.message.includes(name));
        assert.match(error.message, kind === 'image' ? /50\s*MiB/ : /80\s*MiB/); return true;
      });
      assert.equal(exceeded.state.canceled, true);
      assert.equal(exceeded.state.readerCreated, source === 'stream');
      assert.equal(exceeded.state.unlocked, source === 'stream');
      assert.equal(exceeded.state.bytes, source === 'length' ? 0 : limit + 1);
    }
  }
} finally {
  globalThis.fetch = originalFetch;
}

console.log('PASS 17 images / 102 MiB, two complete file pipelines, settled partial failures/reuse, and independent 50 MiB image / 80 MiB video limits');
