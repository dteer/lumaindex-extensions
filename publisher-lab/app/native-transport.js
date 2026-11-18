// CHUNK_BYTES 限制单次 WebKit 消息载荷；完整媒体不会被编码成一个超大 JSON。
const CHUNK_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 80 * 1024 * 1024;
// 浏览器标识、来源、凭据和传输控制由真实页面环境生成，插件只提交业务头。
const PROTECTED_HEADERS = new Set(['cookie', 'cookie2', 'set-cookie', 'host', 'connection', 'content-length', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'keep-alive', 'expect', 'accept-encoding', 'forwarded', 'via', 'user-agent', 'accept-language', 'origin', 'referer']);

// abortError 表明本机停止等待，不能作为远端写操作已撤销的证明。
function abortError() { return new DOMException('已停止等待；已提交的操作可能仍在执行', 'AbortError'); }

// bytesToBase64 只编码有界分片，避免大数组展开造成调用栈溢出。
function bytesToBase64(bytes) {
  const pieces = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return btoa(pieces.join(''));
}

// createNativeFetch 把插件协议需要的有限 fetch 语义适配到同一登录页面环境中的真实 fetch。
// 宿主负责最终的域名、方法、头部和会话隔离；浏览器执行 CORS 检查；没有原生 HTTP 或外部回退。
export function createNativeFetch(call, {uuid = () => crypto.randomUUID()} = {}) {
  return async function nativeFetch(input, options = {}) {
    const url = new URL(String(input));
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw Error('平台请求地址无效。');
    if (options.signal?.aborted) throw abortError();
    if (options.redirect && options.redirect !== 'error') throw Error('平台请求不允许自动跳转。');
    const {origin, contextURL, profileId} = options.browserContext || {};
    let context;
    try { context = new URL(contextURL); } catch { throw Error('请先选择并核对登录账号。'); }
    if (context.protocol !== 'https:' || context.origin !== origin || context.username || context.password || context.hash || typeof profileId !== 'string' || !profileId.trim() || profileId.length > 256) throw Error('请先选择并核对登录账号。');
    const requestId = uuid(), signal = options.signal;
    let bodyHandle = null, requesting = false;
    const headers = Object.fromEntries(new Headers(options.headers || {}).entries());
    // 浏览器头和连接控制由 WebKit 管理；业务请求头由调用方显式提供，最终受已安装权限限制。
    for (const name of Object.keys(headers)) if (PROTECTED_HEADERS.has(name) || ['sec-', 'proxy-', 'x-forwarded-', 'x-http-'].some(prefix => name.startsWith(prefix))) throw Error('这些请求头由浏览器生成，插件不能自行设置。');
    const request = {requestId, origin, contextURL: context.href, profileId, url: url.href, method: options.method || 'GET', headers, credentials: options.credentials === 'omit' ? 'omit' : 'session', responseType: 'text'};
    // cancel 仅结束正在执行的浏览器请求，不重发请求，也不把取消响应当业务回执。
    const cancel = () => { if (requesting) void call('session.cancel', {requestId}).catch(() => {}); };
    signal?.addEventListener('abort', cancel, {once: true});
    try {
      const body = options.body;
      if (typeof body === 'string') {
        if (new TextEncoder().encode(body).length > 1024 * 1024) throw Error('平台请求文字过大，请精简后重试。');
        // 与 fetch 保持一致：空字符串也有正文类型；显式头（包括空值及签名约定）不能被推断覆盖。
        if (!Object.hasOwn(headers, 'content-type')) headers['content-type'] = 'text/plain;charset=UTF-8';
        request.bodyText = body;
      } else if (body !== undefined && body !== null) {
        const blob = body instanceof Blob ? body : body instanceof ArrayBuffer ? new Blob([body]) : ArrayBuffer.isView(body) ? new Blob([new Uint8Array(body.buffer, body.byteOffset, body.byteLength)]) : null;
        if (!blob || !blob.size || blob.size > MAX_BODY_BYTES) throw Error('上传数据必须是 80 MiB 以内的二进制素材。');
        // Blob 仅沿用自身非空 MIME；原始字节没有可推断类型，不猜测 octet-stream 或 JSON。
        if (!Object.hasOwn(headers, 'content-type') && blob.type) headers['content-type'] = blob.type;
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
      const result = await call('browser.request', request);
      requesting = false;
      // 只有宿主明确确认消费了本次句柄，才免除重复清理；旧宿主或丢失回包仍走 finally。
      if (bodyHandle && result?.consumedBodyHandle === bodyHandle) bodyHandle = null;
      if (signal?.aborted) throw abortError();
      if (!Number.isInteger(result?.status) || result.status < 100 || result.status > 599 || typeof result.body !== 'string') throw Error('App 返回了无法确认的平台响应。');
      return new Response([204, 205, 304].includes(result.status) ? null : result.body, {status: result.status, headers: result.headers || {}});
    } finally {
      requesting = false;
      signal?.removeEventListener('abort', cancel);
      // 未获消费确认时释放未完成缓存；remove 幂等，覆盖中途失败和无法确认宿主消费的情况。
      if (bodyHandle) await call('body.remove', {handle: bodyHandle}).catch(() => {});
    }
  };
}
