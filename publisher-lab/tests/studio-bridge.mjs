import assert from 'node:assert/strict';
import {createStudioBridge} from '../browser/studio-bridge.js';
import {createStudioWorker} from '../browser/worker.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function memory() { const data = {}; return {data, fail: false, async get(key) { return {[key]: structuredClone(data[key])}; }, async set(value) { if (this.fail) throw Error('storage unavailable'); Object.assign(data, structuredClone(value)); }}; }
function clock() {
  let time = 0, id = 0; const work = new Map();
  return {now: () => time, work,
    setTimeout(fn, delay) { const key = ++id; work.set(key, {fn, at: time + delay}); return key; },
    clearTimeout(key) { work.delete(key); },
    setInterval(fn, delay) { const key = ++id; work.set(key, {fn, at: time + delay, every: delay}); return key; },
    clearInterval(key) { work.delete(key); },
    async advance(delta) { const end = time + delta; while (true) { const next = [...work].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; const [key, value] = next; time = value.at; if (value.every) value.at += value.every; else work.delete(key); value.fn(); await flush(); } time = end; await flush(); },
  };
}
function harness(dispatch = async () => ({done: true})) {
  const storage = memory(), preferences = memory(), timers = clock();
  class Socket {
    static OPEN = 1; static instances = [];
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; Socket.instances.push(this); }
    send(value) { if (this.readyState !== 1) throw Error('closed'); this.sent.push(JSON.parse(value)); }
    open() { this.readyState = 1; this.onopen?.(); }
    close(code = 1000) { this.readyState = 3; this.onclose?.({code}); }
    message(value) { return this.onmessage?.({data: typeof value === 'string' ? value : JSON.stringify(value)}); }
  }
  const bridge = createStudioBridge({storage, preferences, Socket, dispatch, now: timers.now, timers});
  return {bridge, storage, preferences, Socket, timers};
}
const origin = 'http://127.0.0.1:8765', channel = 'a'.repeat(64);

// 同通道的并发配对只打开一个 socket，不同本机来源分别绑定。
{
  const h = harness();
  const first = h.bridge.connect(origin, channel), second = h.bridge.connect(origin, channel);
  await flush(); assert.equal(h.Socket.instances.length, 1);
  h.Socket.instances[0].open();
  assert.equal((await first).ok, true); assert.equal((await second).ok, true);
  const other = h.bridge.connect('http://localhost:8765', channel); await flush();
  assert.equal(h.Socket.instances.length, 2); h.Socket.instances[1].open(); await other;
  assert.equal((await h.bridge.status()).length, 2);
  await assert.rejects(h.bridge.connect('https://example.com', channel), /配对地址/);
  await h.bridge.disconnect(origin); assert.equal((await h.bridge.status()).length, 1);
  assert.equal(h.Socket.instances[0].sent.at(-1).type, 'connection-error');
  await h.bridge.setEnabled(false); assert.equal((await h.bridge.status()).length, 0);
}

// 重复 transport ID 不再次 dispatch；请求内容变化必须拒绝，进度与最终结果分离。
{
  let calls = 0, release;
  const h = harness(async (_op, _params, context) => { calls++; context.progress({phase: 'uploading'}); await new Promise(resolve => { release = resolve; }); return {status: 'processing'}; });
  const connected = h.bridge.connect(origin, channel); await flush(); const socket = h.Socket.instances[0]; socket.open(); await connected;
  const request = {id: 'message-1', type: 'studio-request', operation: 'publication.publish', params: {preparationId: 'prepared-1'}};
  const running = socket.message(request); await flush();
  await socket.message(request); assert.equal(calls, 1);
  await socket.message({...request, params: {preparationId: 'prepared-2'}});
  assert.equal(socket.sent.at(-1).code, 'TRANSPORT_ID_REUSED');
  release(); await running;
  await socket.message(request); assert.equal(calls, 1); assert.equal(socket.sent.at(-1).data.status, 'processing');
  assert.ok(socket.sent.some(value => value.type === 'progress'));
  for (const value of ['{', 'null', '[]', JSON.stringify({...request, type: 'unknown'}), JSON.stringify({...request, id: '', params: {}})]) await socket.message(value);
  assert.equal(calls, 1);
  await h.bridge.disconnect(origin);
}

// 断线只重连通道，不重放发布；旧 socket 及被替换通道的迟到消息不能操作新连接。
{
  let calls = 0;
  const h = harness(async () => { calls++; return {done: true}; });
  const ready = h.bridge.connect(origin, channel); await flush(); const first = h.Socket.instances[0]; first.open(); await ready;
  const request = {id: 'message-publish', type: 'studio-request', operation: 'publication.publish', params: {}};
  await first.message(request); assert.equal(calls, 1);
  first.close(); await h.timers.advance(1000); assert.equal(h.Socket.instances.length, 2);
  const second = h.Socket.instances[1]; second.open(); await flush();
  assert.equal(calls, 1); assert.ok(second.sent.every(value => value.type === 'ready'));
  // 即使旧事件在关闭后迟到，也不能触发 dispatch。
  first.readyState = 1; await first.message({...request, id: 'late-message'}); assert.equal(calls, 1); first.readyState = 3;
  await second.message(request); assert.equal(calls, 1); assert.equal(second.sent.at(-1).ok, true);
  second.close(4001); await h.timers.advance(10000); assert.equal(h.Socket.instances.length, 2); assert.equal((await h.bridge.status()).length, 0);
}

// 永不回应的配对有明确超时；持久化失败不造成未处理拒绝或假成功。
{
  const h = harness();
  const waiting = h.bridge.connect(origin, channel); await flush(); await h.timers.advance(12000);
  assert.equal((await waiting).ok, false); await h.bridge.disconnect(origin);
  const failed = harness(); failed.storage.fail = true;
  const result = await failed.bridge.connect(origin, channel); await flush();
  assert.equal(result.ok, false); assert.match(result.error, /保存/); assert.equal(failed.Socket.instances.length, 0);
  const disabled = harness(); await disabled.bridge.isEnabled(); disabled.preferences.fail = true;
  await assert.rejects(disabled.bridge.setEnabled(false)); assert.equal(await disabled.bridge.isEnabled(), true);
}
// 扩展设置只能从本扩展 settings.html 发起，网页及其他扩展不能操作配对开关。
{
  const runtime = createStudioWorker({chromeAPI: {storage: {local: memory(), session: memory()}, runtime: {id: 'studio-extension', getURL: path => `chrome-extension://studio-extension/${path}`}}});
  await assert.rejects(runtime.handle({op: 'studio-bridge-enable', enabled: false}, {id: 'foreign-extension', url: 'chrome-extension://studio-extension/settings.html'}), /来源无效/);
  await assert.rejects(runtime.handle({op: 'studio-bridge-enable', enabled: false}, {id: 'studio-extension', url: 'https://creator.douyin.com/'}), /配置页面/);
  await assert.rejects(runtime.handle({op: 'studio-bridge-status'}, {id: 'studio-extension', url: 'chrome-extension://studio-extension/settings.html?spoof=true'}), /配置页面/);
}
console.log('bridge 回归通过：配对复用、来源及设置权限隔离、重复消息、重连不重发、旧连接隔离、超时及存储失败。');
