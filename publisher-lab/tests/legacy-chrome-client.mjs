import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../docs/legacy-chrome-client.js', import.meta.url), 'utf8')).replace('export const studioClient =', 'globalThis.studioClient =');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function harness() {
  let time = 0, timerID = 0, requestID = 0; const timers = new Map(), events = new Map(), statuses = [];
  const timeout = (fn, delay, every) => { const id = ++timerID; timers.set(id, {fn, at: time + delay, every}); return id; };
  class Socket {
    static OPEN = 1; static instances = [];
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; Socket.instances.push(this); }
    send(value) { if (this.failSend) throw Error('send failed'); this.sent.push(JSON.parse(value)); }
    open() { this.readyState = 1; this.onopen?.(); }
    close() { this.readyState = 3; this.onclose?.(); }
    message(value) { this.onmessage?.({data: typeof value === 'string' ? value : JSON.stringify(value)}); }
  }
  const window = {pluginContext: {apiBaseURL: 'http://127.0.0.1:8765/api/v1'}, addEventListener(type, listener) { events.set(type, listener); }};
  const context = vm.createContext({window, location: {origin: 'http://127.0.0.1:8765'}, WebSocket: Socket, URL, TextEncoder, DOMException, Date: {now: () => time},
    crypto: {getRandomValues(bytes) { bytes.fill(++requestID); return bytes; }, randomUUID() { return 'request-' + (++requestID); }},
    setTimeout: (fn, delay) => timeout(fn, delay), clearTimeout: id => timers.delete(id), setInterval: (fn, delay) => timeout(fn, delay, delay), clearInterval: id => timers.delete(id),
  });
  vm.runInContext(source, context, {filename: 'studio-client.js'});
  const client = context.studioClient; client.onStatus(value => statuses.push(value));
  async function advance(delta) {
    const end = time + delta;
    while (true) { const next = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; const [id, value] = next; time = value.at; if (value.every) value.at += value.every; else timers.delete(id); value.fn(); await flush(); }
    time = end; await flush();
  }
  async function connect() { const result = client.connect(); const socket = Socket.instances.at(-1); socket.open(); const paired = await result; socket.message({type: 'ready'}); return {socket, paired}; }
  return {client, window, Socket, statuses, events, timers, advance, connect};
}

// 本机 socket 打开并不等于浏览器连接；消息类型错误和进度不能提前结束请求。
{
  const h = harness(), connection = h.client.connect(); const socket = h.Socket.instances[0]; socket.open();
  const pairing = await connection; assert.equal(pairing.connected, false); assert.match(pairing.connectionURL, /com\.lumaindex\.douyin\.studio/);
  await assert.rejects(h.client.request('studio.session'), /先连接/);
  socket.message({type: 'ready'}); assert.equal(h.statuses.at(-1).connected, true);
  let progress = 0, finished = false;
  const request = h.client.request('publication.prepare', {}, {onProgress() { progress++; throw Error('view failure'); }}).then(value => { finished = true; return value; });
  const id = socket.sent.at(-1).id;
  socket.message('null'); socket.message('[]'); socket.message({id, type: 'unknown', ok: true, data: {bad: true}});
  socket.message({id, type: 'progress', data: {phase: 'uploading'}}); await flush();
  assert.equal(finished, false); assert.equal(progress, 1);
  socket.message({id, ok: true, data: {preparationId: 'prepared'}}); assert.equal((await request).preparationId, 'prepared');
  h.events.get('pagehide')();
}

// 失联立即结束本地等待；显式重连只握手，不重发旧发布。
{
  const h = harness(), {socket} = await h.connect();
  const pending = h.client.request('publication.publish', {preparationId: 'p', requestId: 'same-request'});
  const rejection = assert.rejects(pending, /勿重复提交/); socket.close(); await rejection;
  const reconnect = h.client.connect(), next = h.Socket.instances.at(-1); next.open(); await reconnect; next.message({type: 'ready'});
  assert.equal(h.Socket.instances.flatMap(item => item.sent).filter(value => value.operation === 'publication.publish').length, 1);
  const waiting = h.client.request('studio.session'); const fail = assert.rejects(waiting, /已关闭/);
  next.message({type: 'connection-error', error: '实验扩展已关闭连接'}); await fail;
  assert.equal(h.statuses.at(-1).connected, false);
  const pairAgain = await h.client.connect(); assert.equal(pairAgain.connected, false); assert.match(pairAgain.connectionURL, /relay\.html#/);
  h.events.get('pagehide')();
}

// 心跳无回包时从“连接”降为离线；正常心跳期间发布响应超时也不会重试。
{
  const h = harness(), {socket} = await h.connect();
  const pending = h.client.request('publication.prepare'); const fail = assert.rejects(pending, /暂未回应/);
  await h.advance(60000); await fail; assert.equal(h.statuses.at(-1).connected, false);
  assert.equal(h.Socket.instances.length, 1);
  socket.message({type: 'ready'});
  const publication = h.client.request('publication.publish', {preparationId: 'p'}); const timeout = assert.rejects(publication, /尚未确认/);
  for (let i = 0; i < 6; i++) { socket.message({type: 'pong'}); await h.advance(20000); }
  await timeout;
  assert.equal(socket.sent.filter(value => value.operation === 'publication.publish').length, 1);
  h.events.get('pagehide')();
}

// 来源变化不能沿用旧通道；发送失败和取消清理等待，不发送补偿性请求。
{
  const h = harness(), {socket} = await h.connect();
  const request = h.client.request('studio.session'); const ended = assert.rejects(request, /来源已变化/);
  h.window.pluginContext.apiBaseURL = 'http://127.0.0.1:8766/api/v1';
  const connecting = h.client.connect(), next = h.Socket.instances.at(-1); next.open(); await connecting; await ended;
  assert.match(next.url, /8766/); next.message({type: 'ready'});
  next.failSend = true; await assert.rejects(h.client.request('publication.publish', {preparationId: 'p'}), /发送时中断/);
  next.failSend = false; next.message({type: 'ready'});
  const controller = new AbortController();
  const cancelled = h.client.request('publication.prepare', {}, {signal: controller.signal}); const rejected = assert.rejects(cancelled, error => error.name === 'AbortError'); controller.abort(); await rejected;
  const before = next.sent.length; const already = new AbortController(); already.abort();
  await assert.rejects(h.client.request('publication.publish', {}, {signal: already.signal}), error => error.name === 'AbortError');
  assert.equal(next.sent.length, before);
  h.events.get('pagehide')();
}
console.log('client 回归通过：配对状态、消息校验、断线与来源变化、心跳失联、响应超时、取消及不自动重发。');
