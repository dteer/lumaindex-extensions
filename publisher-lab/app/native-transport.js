// CHUNK_BYTES 限制单次 WebKit 消息载荷；完整媒体不会被编码成一个超大 JSON。
const CHUNK_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 80 * 1024 * 1024;

// abortError 表明本机停止等待，不能作为远端写操作已撤销的证明。
function abortError() { return new DOMException('已停止等待；已提交的操作可能仍在执行', 'AbortError'); }

// bytesToBase64 只编码有界分片，避免大数组展开造成调用栈溢出。
function bytesToBase64(bytes) {
  const pieces = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return btoa(pieces.join(''));
}

// createNativeFetch 把插件协议需要的有限 fetch 语义适配到原生会话请求。
// 宿主负责最终的域名、方法、头部和会话隔离；此处没有 Chrome、代理服务器或外部回退。
export function createNativeFetch(call, {uuid = () => crypto.randomUUID()} = {}) {
  return async function nativeFetch(input, options = {}) {
    const url = new URL(String(input));
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Error('平台请求地址无效。');
    if (options.signal?.aborted) throw abortError();
    if (options.redirect && options.redirect !== 'error') throw Error('平台请求不允许自动跳转。');
    const requestId = uuid(), signal = options.signal;
    let bodyHandle = null, requesting = false;
    const headers = Object.fromEntries(new Headers(options.headers || {}).entries());
    for (const name of Object.keys(headers)) if (['cookie', 'host', 'origin', 'referer', 'proxy-authorization'].includes(name)) throw Error('会话和请求来源由 App 管理，插件不能自行设置。');
    const request = {requestId, url: url.href, method: options.method || 'GET', headers, credentials: options.credentials === 'omit' ? 'omit' : 'session', responseType: 'text'};
    // cancel 仅结束正在执行的原生传输，不重发请求，也不把取消响应当业务回执。
    const cancel = () => { if (requesting) void call('session.cancel', {requestId}).catch(() => {}); };
    signal?.addEventListener('abort', cancel, {once: true});
    try {
      const body = options.body;
      if (typeof body === 'string') {
        if (new TextEncoder().encode(body).length > 1024 * 1024) throw Error('平台请求文字过大，请精简后重试。');
        request.bodyText = body;
      } else if (body !== undefined && body !== null) {
        const blob = body instanceof Blob ? body : body instanceof ArrayBuffer ? new Blob([body]) : ArrayBuffer.isView(body) ? new Blob([new Uint8Array(body.buffer, body.byteOffset, body.byteLength)]) : null;
        if (!blob || !blob.size || blob.size > MAX_BODY_BYTES) throw Error('上传数据必须是 80 MiB 以内的二进制素材。');
        const opened = await call('body.begin', {size: blob.size});
        if (typeof opened?.handle !== 'string' || !opened.handle) throw Error('App 未能准备上传缓存，请重试。');
        bodyHandle = opened.handle;
        for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
          if (signal?.aborted) throw abortError();
          const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
          const appended = await call('body.append', {handle: bodyHandle, offset, base64: bytesToBase64(bytes)});
          if (appended?.received !== offset + bytes.length) throw Error('App 上传缓存未完整写入，已停止发送。');
        }
        if (signal?.aborted) throw abortError();
        await call('body.finish', {handle: bodyHandle});
        request.bodyHandle = bodyHandle;
      }
      if (signal?.aborted) throw abortError();
      requesting = true;
      const result = await call('session.request', request);
      requesting = false;
      if (signal?.aborted) throw abortError();
      if (!Number.isInteger(result?.status) || result.status < 100 || result.status > 599 || typeof result.body !== 'string') throw Error('App 返回了无法确认的平台响应。');
      return new Response([204, 205, 304].includes(result.status) ? null : result.body, {status: result.status, headers: result.headers || {}});
    } finally {
      requesting = false;
      signal?.removeEventListener('abort', cancel);
      // request 消耗句柄后 remove 可以幂等结束；中途出错时也释放未完成缓存。
      if (bodyHandle) await call('body.remove', {handle: bodyHandle}).catch(() => {});
    }
  };
}
