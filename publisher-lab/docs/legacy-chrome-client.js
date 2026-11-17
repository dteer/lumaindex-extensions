const PLUGIN_ID = 'com.lumaindex.douyin.studio';
const pending = new Map();
const listeners = new Set();
let socket, socketRoot = '', heartbeat, opening, openingRoot = '', connected = false, connectionURL = '', lastSeen = 0;

// apiRoot 只接受当前插件的本机业务入口，不转发至外部主机。
function apiRoot() {
  const value = window.pluginContext?.apiBaseURL || `${location.origin}/api/v1`;
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname.replace(/\/$/, '') !== '/api/v1' || url.search || url.hash || url.username || url.password) throw Error('请从有序图库打开实验工作台。');
  return url.href.replace(/\/$/, '');
}

// announce 通知真实通信状态，账号身份仍须单独通过 studio.session 核对。
function announce(value) { for (const listener of listeners) { try { listener(value); } catch {} } }

// rejectPending 只结束本地等待，不将远端发布请求误认为已经撤销。
function rejectPending(message = '连接已断开；若刚提交发布，请重新连接后查询结果，勿重复提交。') {
  for (const entry of pending.values()) entry.finish(false, Error(message));
}

// disconnected 保留当前配对地址以便手动恢复；绝不缓存或重发任何业务请求。
function disconnected(message) {
  connected = false;
  rejectPending(message);
  announce({connected: false, message, connectionURL});
}

// openChannel 显式准备配对通道，来源变化时只关闭旧通道，不继承旧来源的请求。
function openChannel() {
  const root = apiRoot();
  if (socketRoot === root && socket?.readyState === WebSocket.OPEN) return Promise.resolve();
  if (opening && openingRoot === root) return opening;
  if (socket && socketRoot !== root) {
    disconnected('当前 App 来源已变化，请重新连接；已有发布请在原来源查询结果。');
    try { socket.close(); } catch {}
  }
  openingRoot = root;
  const attempt = new Promise((resolve, reject) => {
    const channel = Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join('');
    const endpoint = new URL(`${root}/plugins/${PLUGIN_ID}/bridge/${channel}/app`);
    endpoint.protocol = 'ws:';
    const current = new WebSocket(endpoint.href);
    socket = current; socketRoot = root; connected = false;
    connectionURL = `${root}/plugins/${PLUGIN_ID}/files/relay.html#${channel}`;
    const timeout = setTimeout(() => {
      if (socket !== current) return;
      reject(Error('本机连接超时，请确认实验插件已安装并启用。'));
      try { current.close(); } catch {}
    }, 10000);
    current.onopen = () => {
      if (socket !== current) { try { current.close(); } catch {} return; }
      clearTimeout(timeout); clearInterval(heartbeat); lastSeen = Date.now();
      heartbeat = setInterval(() => {
        if (socket !== current || current.readyState !== WebSocket.OPEN) return;
        // 后台断开时本机 App WebSocket 仍可能保持打开，必须按对端回包识别失联。
        if (connected && Date.now() - lastSeen > 45000) disconnected('浏览器暂未回应，请检查实验扩展并重新连接；若刚发布，请先查询结果。');
        try { current.send(JSON.stringify({type: 'ping'})); } catch { disconnected('浏览器连接已中断，请重新连接；若刚发布，请先查询结果。'); }
      }, 20000);
      resolve();
    };
    current.onmessage = event => {
      if (socket !== current || current.readyState !== WebSocket.OPEN || typeof event.data !== 'string' || event.data.length > 65536) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (['ready', 'ping', 'pong'].includes(message.type)) {
        lastSeen = Date.now();
        if (message.type === 'ping') { try { current.send(JSON.stringify({type: 'pong'})); } catch { return; } }
        if (!connected) { connected = true; announce({connected: true, message: '浏览器已连接，正在核对账号'}); }
        return;
      }
      if (message.type === 'connection-error') {
        disconnected(typeof message.error === 'string' ? message.error : '浏览器连接已结束，请重新连接。');
        return;
      }
      if (typeof message.id !== 'string') return;
      const entry = pending.get(message.id);
      if (!entry) return;
      if (message.type === 'progress') { lastSeen = Date.now(); try { entry.onProgress?.(message.data); } catch {} return; }
      if ((message.type !== undefined && message.type !== 'result') || typeof message.ok !== 'boolean') return;
      lastSeen = Date.now();
      entry.finish(message.ok, message.ok ? message.data : Object.assign(Error(typeof message.error === 'string' ? message.error : '操作未完成，请重试。'), {code: message.code}));
    };
    current.onclose = () => {
      clearTimeout(timeout);
      if (socket !== current) return;
      clearInterval(heartbeat); connectionURL = '';
      disconnected('浏览器连接已断开，请重新连接；若刚提交发布，请查询结果，勿重复提交。');
      reject(Error('本机通道未连接，请重试。'));
    };
    current.onerror = () => {
      clearTimeout(timeout);
      if (socket !== current) return;
      clearInterval(heartbeat);
      disconnected('本机连接不可用，请确认有序图库正在运行。');
      reject(Error('本机连接不可用，请确认有序图库正在运行。'));
      try { current.close(); } catch {}
    };
  });
  const wrapped = attempt.finally(() => { if (opening === wrapped) { opening = null; openingRoot = ''; } });
  opening = wrapped;
  return wrapped;
}

// request 超时或断线只拒绝本次等待；重连后用户必须显式查询状态，不自动重发发布。
async function request(operation, params = {}, options = {}) {
  if (options.signal?.aborted) throw new DOMException('已取消', 'AbortError');
  if (!connected || socket?.readyState !== WebSocket.OPEN) throw Error('请先连接实验版 Chrome 扩展。');
  if (typeof operation !== 'string' || !operation || operation.length > 80 || !params || typeof params !== 'object' || Array.isArray(params)) throw Error('操作参数无效。');
  const id = crypto.randomUUID();
  const encoded = JSON.stringify({id, type: 'studio-request', operation, params});
  if (new TextEncoder().encode(encoded).length > 60000) throw Error('作品描述或选择信息过多，请精简后重试。');
  return new Promise((resolve, reject) => {
    const timeoutMs = operation === 'publication.prepare' ? 30 * 60 * 1000 : operation === 'publication.publish' ? 120000 : 45000;
    const timer = setTimeout(() => finish(false, Error(operation === 'publication.publish' ? '提交结果尚未确认，请查询发布状态，勿重复发布。' : '操作超时，请检查连接后重试。')), timeoutMs);
    const abort = () => finish(false, new DOMException('已停止等待；已提交的操作可能仍在执行', 'AbortError'));
    // finish 清理计时器与取消监听，取消本地等待不发出远端取消或再次提交。
    function finish(ok, value) {
      if (!pending.has(id)) return;
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort); pending.delete(id);
      ok ? resolve(value) : reject(value);
    }
    pending.set(id, {finish, onProgress: options.onProgress});
    options.signal?.addEventListener('abort', abort, {once: true});
    if (options.signal?.aborted) { abort(); return; }
    try { socket.send(encoded); }
    catch {
      finish(false, Error('连接在发送时中断；若刚提交发布，请查询状态，勿重复提交。'));
      disconnected('浏览器连接已中断，请重新连接；已有发布请先查询结果。');
    }
  });
}

export const studioClient = {
  // connect 首次返回配对地址；收到浏览器回应后才请求真实账号，不自动打开网页。
  async connect() {
    await openChannel();
    if (connected) return request('studio.session');
    return {connected: false, connectionURL, message: '本机已就绪，请打开下方链接连接实验版 Chrome 扩展。'};
  },
  request,
  onStatus(listener) { listeners.add(listener); return () => listeners.delete(listener); },
};

window.addEventListener('pagehide', () => { clearInterval(heartbeat); try { socket?.close(); } catch {} rejectPending(); });
