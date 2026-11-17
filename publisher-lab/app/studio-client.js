import {createNativeFetch} from './native-transport.js';
import {createStudioEngine} from './platform/studio-engine.js';

const SESSION_ORIGIN = 'https://creator.douyin.com';
const MISSING_HOST = '当前 App 尚未开放插件会话能力，请更新 App 后重新打开工作台。';

// createStudioClient 使用宿主原生会话、受限请求和独立持久化，不依赖外部服务或浏览器扩展。
export function createStudioClient({context = () => window.pluginContext || {}, post = message => window.webkit?.messageHandlers?.pluginUI?.postMessage(message)} = {}) {
  const listeners = new Set();
  let latest = {connected: false, account: null, capabilities: {operations: []}}, engine;
  // available 只认可宿主声明的能力版本，不根据某个方法名存在就猜测接口可用。
  function available() { return context().nativeCapabilities?.sessionVersion === 1 && context().nativeUIAvailable === true; }
  // call 统一解包原生业务回执；取消/权限拒绝/网络失败不会误报为成功。
  async function call(op, params = {}) {
    if (!available()) throw Object.assign(Error(MISSING_HOST), {code: 'HOST_CAPABILITY_UNAVAILABLE'});
    const response = await post({op, ...params});
    if (response?.ok !== true) throw Object.assign(Error(response?.error?.message || 'App 未完成本次操作，请重试。'), {code: response?.error?.code || 'HOST_REQUEST_FAILED'});
    return response.data;
  }
  // origin 从图库启动上下文取得素材来源，禁止转到外部地址读取本机资产。
  function origin() {
    const url = new URL(context().apiBaseURL);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname.replace(/\/$/, '') !== '/api/v1' || url.username || url.password || url.search || url.hash) throw Error('请从有序图库打开工作台。');
    return url.origin;
  }
  // dispatcher 将所有发布编排留在此插件内；宿主只执行通用能力。
  function dispatcher() {
    if (!engine) engine = createStudioEngine({send: createNativeFetch(call), storage: {
      get: keys => call('state.get', keys === undefined ? {} : {keys}),
      set: values => call('state.set', {values}),
    }});
    return engine;
  }
  // announce 不持久化会话材料，只将已核验的公开账号和能力交给界面。
  function announce(value) {
    latest = value;
    for (const listener of listeners) { try { listener(value); } catch {} }
    return value;
  }
  // check 读取宿主会话后，再由平台用户接口确认真实身份。
  async function check() {
    if (!available()) return announce({connected: false, account: null, capabilities: {operations: []}, nativeAvailable: false, message: MISSING_HOST});
    const session = await call('session.status', {origin: SESSION_ORIGIN});
    if (session?.hasCookies !== true) return announce({connected: false, account: null, capabilities: {operations: []}, nativeAvailable: true, message: '请先登录抖音，在官方登录窗口完成扫码或验证。'});
    try {
      const verified = await dispatcher().dispatch('studio.session', {}, {origin: origin()});
      return announce({...verified, nativeAvailable: true, expiresAt: session.expiresAt, message: '已核对当前抖音账号。平台最终发布仍需实机验证。'});
    } catch (error) {
      announce({connected: false, account: null, capabilities: {operations: []}, nativeAvailable: true, message: error.message});
      throw error;
    }
  }
  return {
    connect: check,
    // importSession 仅由用户按钮触发原生官方登录窗口，JS 不接收或处理 Cookie。
    async importSession() {
      await call('session.login', {origin: SESSION_ORIGIN});
      dispatcher().invalidate();
      return check();
    },
    // clearSession 清理本插件临时身份；本机作品草稿和历史回执保留。
    async clearSession() {
      await call('session.clear', {origin: SESSION_ORIGIN});
      engine?.invalidate();
      return announce({connected: false, account: null, capabilities: {operations: []}, nativeAvailable: true, message: '临时会话已清除，本机草稿仍保留。'});
    },
    // request 将准备/查询取消传到真实传输；最终发布开始后继续收取回执，不声称平台已撤销。
    async request(operation, params = {}, options = {}) {
      if (options.signal?.aborted) throw new DOMException('已取消', 'AbortError');
      if (operation === 'studio.session') return check();
      if (!available()) throw Object.assign(Error(MISSING_HOST), {code: 'HOST_CAPABILITY_UNAVAILABLE'});
      if (!latest.connected || !latest.account?.id) throw Error('请先登录抖音并核对账号。');
      const result = await dispatcher().dispatch(operation, params, {origin: origin(), signal: options.signal, progress: value => {
        if (!options.signal?.aborted) options.onProgress?.(value);
      }});
      if (operation !== 'publication.publish' && options.signal?.aborted) throw new DOMException('已停止等待；已提交的操作可能仍在执行', 'AbortError');
      return result;
    },
    // onStatus 返回解除订阅函数，避免页面销毁后继续刷新账号。
    onStatus(listener) { if (typeof listener !== 'function') throw new TypeError('状态监听必须是函数。'); listeners.add(listener); return () => listeners.delete(listener); },
  };
}

export const studioClient = createStudioClient();
