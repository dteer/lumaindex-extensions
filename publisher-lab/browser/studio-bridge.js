const PLUGIN_ID = 'com.lumaindex.douyin.studio';
const STORAGE_KEY = 'studio-v2-connections';
const MESSAGE_ID = /^[a-zA-Z0-9_-]{1,80}$/;

// createStudioBridge 管理插件专属连接；重连只恢复通信，不重发任何业务请求。
export function createStudioBridge({storage, preferences, Socket, dispatch, now = Date.now, timers = globalThis}) {
  const entries = new Map();
  let enabled = true, writes = Promise.resolve();

  // persist 保存无凭据的连接位置；始终安装拒绝处理，同时让显式操作仍能获知失败。
  function persist() {
    const value = [...entries.values()].map(({origin, channel}) => ({origin, channel}));
    writes = writes.catch(() => {}).then(() => storage.set({[STORAGE_KEY]: value}));
    writes.catch(() => {});
    return writes;
  }

  // send 只向当前仍属于本来源的连接发送，迟到结果不能串到新配对通道。
  function send(entry, value) {
    if (entries.get(entry.origin) !== entry || entry.socket?.readyState !== Socket.OPEN) return;
    try { entry.socket.send(JSON.stringify(value)); } catch {}
  }

  // settleWaiters 同一通道的并发配对共享结果，不关闭另一个尚在建立的连接。
  function settleWaiters(entry, result) {
    for (const waiter of entry.waiters) { timers.clearTimeout(waiter.timer); waiter.resolve(result); }
    entry.waiters.clear();
  }

  // waitForConnection 为一次显式配对提供有界等待，不把旧成功结果当成当前已连接。
  function waitForConnection(entry) {
    if (entry.socket?.readyState === Socket.OPEN) return Promise.resolve({ok: true});
    return new Promise(resolve => {
      const waiter = {resolve};
      waiter.timer = timers.setTimeout(() => {
        entry.waiters.delete(waiter);
        resolve({ok: false, error: '连接超时，请确认 App 插件仍打开，然后重新连接。'});
      }, 12000);
      entry.waiters.add(waiter);
    });
  }

  // stop 通知 App 失联并清理连接；已开始的业务不会被撤回，也不会在重连时重发。
  function stop(entry, message = '浏览器连接已结束，请重新连接；若刚提交发布，请查询结果。') {
    if (entries.get(entry.origin) !== entry) return;
    send(entry, {type: 'connection-error', error: message});
    entries.delete(entry.origin);
    timers.clearInterval(entry.heartbeat); timers.clearTimeout(entry.retry); timers.clearTimeout(entry.openTimeout);
    settleWaiters(entry, {ok: false, error: message});
    try { entry.socket?.close(); } catch {}
    persist();
  }

  // recover 只重建同一配对通道；不保留待发送请求队列。
  function recover(entry, socket, code) {
    if (entries.get(entry.origin) !== entry || entry.socket !== socket) return;
    timers.clearInterval(entry.heartbeat); timers.clearTimeout(entry.openTimeout);
    if (code === 4001 || ++entry.attempt > 8) { stop(entry); return; }
    timers.clearTimeout(entry.retry);
    entry.retry = timers.setTimeout(() => open(entry), Math.min(1000 * entry.attempt, 5000));
  }

  // remember 有限缓存已完成响应，重复 transport ID 只回放结果，不重复调用业务。
  function remember(entry, id, fingerprint, response) {
    entry.completed.set(id, {fingerprint, response, at: now()});
    while (entry.completed.size > 100) entry.completed.delete(entry.completed.keys().next().value);
  }

  // open 绑定固定 dispatch 并隔离旧 socket 事件；心跳无回包时主动恢复通信。
  function open(entry) {
    if (entries.get(entry.origin) !== entry || !enabled) return;
    let socket;
    try { socket = new Socket(entry.origin.replace(/^http:/, 'ws:') + `/api/v1/plugins/${PLUGIN_ID}/bridge/${entry.channel}/browser`); }
    catch { entry.socket = null; recover(entry, null); return; }
    entry.socket = socket;
    entry.openTimeout = timers.setTimeout(() => { if (entry.socket === socket && socket.readyState !== Socket.OPEN) { try { socket.close(); } catch {} } }, 10000);
    socket.onopen = () => {
      if (entries.get(entry.origin) !== entry || entry.socket !== socket) { try { socket.close(); } catch {} return; }
      timers.clearTimeout(entry.openTimeout);
      entry.attempt = 0; entry.lastSeen = now();
      send(entry, {type: 'ready'});
      settleWaiters(entry, {ok: true});
      timers.clearInterval(entry.heartbeat);
      entry.heartbeat = timers.setInterval(() => {
        if (now() - entry.lastSeen > 45000) { try { socket.close(); } catch {} return; }
        send(entry, {type: 'ping'});
      }, 20000);
    };
    socket.onmessage = async event => {
      if (entries.get(entry.origin) !== entry || entry.socket !== socket || socket.readyState !== Socket.OPEN || typeof event.data !== 'string' || event.data.length > 65536) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (['ping', 'pong'].includes(message.type)) { entry.lastSeen = now(); if (message.type === 'ping') send(entry, {type: 'pong'}); return; }
      if (message.type !== 'studio-request' || typeof message.id !== 'string' || !MESSAGE_ID.test(message.id) || typeof message.operation !== 'string' || message.operation.length > 80 || !message.params || typeof message.params !== 'object' || Array.isArray(message.params)) return;
      entry.lastSeen = now();
      const fingerprint = JSON.stringify([message.operation, message.params]);
      const inflight = entry.pending.get(message.id), completed = entry.completed.get(message.id);
      if (completed && now() - completed.at >= 30 * 60 * 1000) entry.completed.delete(message.id);
      const previous = inflight || entry.completed.get(message.id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) send(entry, {id: message.id, ok: false, error: '请求编号已用于不同内容，请重新操作。', code: 'TRANSPORT_ID_REUSED'});
        else if (!inflight) send(entry, previous.response);
        return;
      }
      if (entry.pending.size >= 8) { send(entry, {id: message.id, ok: false, error: '当前操作较多，请稍后重试。'}); return; }
      entry.pending.set(message.id, {fingerprint});
      let response;
      try {
        const data = await dispatch(message.operation, message.params, {origin: entry.origin, progress: data => send(entry, {id: message.id, type: 'progress', data})});
        response = {id: message.id, ok: true, data};
      } catch (error) {
        const text = typeof error?.message === 'string' && /[\u3400-\u9fff]/.test(error.message) && error.message.length < 350 ? error.message : '操作暂未完成，请检查抖音页面和网络后重试。';
        response = {id: message.id, ok: false, error: text, code: error.code};
      } finally { entry.pending.delete(message.id); }
      remember(entry, message.id, fingerprint, response);
      send(entry, response);
    };
    socket.onclose = event => recover(entry, socket, event.code);
    socket.onerror = () => { try { socket.close(); } catch {} };
  }

  // add 一个来源只有一个活动通道，相同通道的重复配对复用正在进行的连接。
  function add(origin, channel) {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || origin !== url.origin || !/^[a-f0-9]{64}$/.test(channel)) throw Error('实验插件配对地址无效。');
    const old = entries.get(origin);
    if (old?.channel === channel) return waitForConnection(old);
    if (old) stop(old);
    const entry = {origin, channel, attempt: 0, pending: new Map(), completed: new Map(), waiters: new Set()};
    entries.set(origin, entry);
    const result = waitForConnection(entry);
    // 保存失败时不给出成功连接，防止用户以为重启后仍会保留这次配对。
    persist().then(() => open(entry)).catch(() => stop(entry, '连接信息未能保存，请检查扩展存储后重试。'));
    return result;
  }

  const ready = preferences.get('studio-connection-enabled').then(value => {
    enabled = value['studio-connection-enabled'] !== false;
    return storage.get(STORAGE_KEY);
  }).then(value => {
    if (!enabled || !Array.isArray(value[STORAGE_KEY])) return;
    for (const item of value[STORAGE_KEY].slice(0, 8)) { try { add(item.origin, item.channel).catch(() => {}); } catch {} }
  }).catch(() => {});

  return {
    async connect(origin, channel) { await ready; if (!enabled) return {ok: false, error: '请在实验版扩展中开启 App 连接。'}; return add(origin, channel); },
    async isEnabled() { await ready; return enabled; },
    // setEnabled 成功持久化后才应用开关；失败保留原状态。
    async setEnabled(value) {
      await ready;
      const next = value === true;
      await preferences.set({'studio-connection-enabled': next});
      enabled = next;
      if (!enabled) for (const entry of [...entries.values()]) stop(entry, '实验版 Chrome 扩展已关闭 App 连接，请重新启用后连接。');
      await writes;
    },
    async status() { await ready; return [...entries.values()].map(entry => ({origin: entry.origin, state: entry.socket?.readyState === Socket.OPEN ? 'connected' : entry.attempt ? 'reconnecting' : 'connecting'})); },
    async disconnect(origin) { await ready; const entry = entries.get(origin); if (entry) stop(entry); await writes; },
  };
}
