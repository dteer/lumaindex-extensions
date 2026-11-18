import {createNativeFetch} from './native-transport.js';
import {createStudioEngine} from './platform/studio-engine.js';

const SESSION_ORIGIN = 'https://creator.douyin.com';
const MISSING_HOST = '当前 App 尚未开放插件会话能力，请更新 App 后重新打开工作台。';
const MISSING_PROFILES = '当前 App 尚未开放多账号能力，请更新 App 后添加或切换账号。';

// createStudioClient 使用宿主原生会话、受限请求和独立持久化，不依赖外部服务或浏览器扩展。
export function createStudioClient({context = () => window.pluginContext || {}, post = message => window.webkit?.messageHandlers?.pluginUI?.postMessage(message)} = {}) {
  const listeners = new Set();
  let latest = {connected: false, account: null, capabilities: {operations: []}, profiles: [], activeProfileId: null}, engine;
  let generation = 0, changing = false, activeRequests = 0;
  // available 和 profilesAvailable 只认可宿主声明的版本；旧宿主仍可使用原单账号入口。
  function available() { return context().nativeCapabilities?.sessionVersion === 1 && context().nativeUIAvailable === true; }
  function profilesAvailable() { return available() && context().nativeCapabilities?.sessionProfilesVersion === 1; }
  // failure 给异步会话竞态返回稳定本机码，不让迟到结果覆盖新账号。
  function failure(code, message) { return Object.assign(Error(message), {code}); }
  function requireCurrent(token) { if (token !== generation) throw failure('SESSION_CHANGED', '账号操作已变化，请检查当前账号后重试。'); }
  // call 统一解包原生业务回执；取消/权限拒绝/网络失败不会误报为成功。
  async function call(op, params = {}) {
    if (!available()) throw failure('HOST_CAPABILITY_UNAVAILABLE', MISSING_HOST);
    const response = await post({op, ...params});
    if (response?.ok !== true) throw failure(response?.error?.code || 'HOST_REQUEST_FAILED', response?.error?.message || 'App 未完成本次操作，请重试。');
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
    if (!engine) engine = createStudioEngine({send: createNativeFetch(call),
      // 资源读取只复用近期平台核验；本机档案检查负责立即识别切换与到期，旧宿主仍走实时核验。
      sessionStatus: () => profilesAvailable() ? call('session.status', {origin: SESSION_ORIGIN}) : null,
      storage: {
      get: keys => call('state.get', keys === undefined ? {} : {keys}),
      set: values => call('state.set', {values}),
    }});
    return engine;
  }
  // announce 始终保留账号目录；列表记录不代表平台已核验，也不能授予发布资格。
  function announce(value) {
    latest = {...latest, ...value, profilesAvailable: profilesAvailable()};
    for (const listener of listeners) { try { listener(latest); } catch {} }
    return latest;
  }
  // unverify 在更换会话前清理原账号可发布状态和临时候选，保留作品与账号目录。
  function unverify(message) {
    engine?.invalidate();
    return announce({connected: false, account: null, capabilities: {operations: []}, message});
  }
  // profileCatalog 按宿主十条分页读取小型账号目录，供原生下拉完整展示；不请求平台或读取登录材料。
  async function profileCatalog(token) {
    if (!profilesAvailable()) return {profiles: [], activeProfileId: null};
    const profiles = [], seen = new Set();
    let offset = 0, activeProfileId;
    for (;;) {
      const page = await call('session.list', {origin: SESSION_ORIGIN, offset, limit: 10});
      requireCurrent(token);
      if (!Array.isArray(page?.items) || (page.activeProfileId !== null && typeof page.activeProfileId !== 'string') || typeof page.hasMore !== 'boolean') throw Error('App 返回的账号列表无法确认，请重新检查会话。');
      if (offset && activeProfileId !== page.activeProfileId) throw failure('SESSION_CHANGED', '当前账号已变化，请重新读取账号列表。');
      activeProfileId = page.activeProfileId;
      for (const item of page.items) {
        if (!item || typeof item.id !== 'string' || !item.id || seen.has(item.id)) continue;
        seen.add(item.id);
        profiles.push({id: item.id, accountId: typeof item.accountId === 'string' ? item.accountId : null, name: typeof item.name === 'string' ? item.name : '', expiresAt: item.expiresAt, hasCookies: item.hasCookies === true});
      }
      if (!page.hasMore) return {profiles, activeProfileId};
      if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw Error('App 返回的账号分页位置无效，请重新检查会话。');
      offset = page.nextOffset;
    }
  }
  // check 读取当前档案后由平台核验身份，再用档案 CAS 保存公开身份；迟到核验不能改写新选择。
  async function check(token = ++generation, expectedProfileId) {
    if (!available()) return announce({connected: false, account: null, capabilities: {operations: []}, profiles: [], activeProfileId: null, nativeAvailable: false, message: MISSING_HOST});
    try {
      const session = await call('session.status', {origin: SESSION_ORIGIN});
      requireCurrent(token);
      if (expectedProfileId && session?.activeProfileId !== expectedProfileId) throw failure('SESSION_CHANGED', '当前账号与本次选择不一致，请重新选择账号。');
      if (session?.hasCookies !== true) {
        const catalog = await profileCatalog(token);
        if (profilesAvailable() && catalog.activeProfileId !== session?.activeProfileId) throw failure('SESSION_CHANGED', '当前账号已变化，请重新检查会话。');
        return announce({connected: false, account: null, capabilities: {operations: []}, ...catalog, nativeAvailable: true, expiresAt: session?.expiresAt, message: catalog.activeProfileId ? '此账号会话已过期，请重新登录抖音。' : '请先登录抖音，在官方登录窗口完成扫码或验证。'});
      }
      const verified = await dispatcher().dispatch('studio.session', {}, {origin: origin()});
      requireCurrent(token);
      let selectedId = session.activeProfileId;
      if (profilesAvailable()) {
        if (!selectedId || session.accountId && session.accountId !== verified.account?.id) throw failure('SESSION_IDENTITY_MISMATCH', '实际抖音账号与所选账号不一致，请重新登录。');
        const identified = await call('session.identify', {origin: SESSION_ORIGIN, profileId: selectedId, accountId: verified.account.id, name: verified.account.name});
        requireCurrent(token);
        if (!identified?.activeProfileId || identified.accountId !== verified.account.id) throw failure('SESSION_IDENTITY_MISMATCH', 'App 未确认本次账号身份，请重新检查会话。');
        selectedId = identified.activeProfileId;
      }
      const catalog = await profileCatalog(token);
      if (profilesAvailable() && (catalog.activeProfileId !== selectedId || catalog.profiles.find(item => item.id === selectedId)?.accountId !== verified.account.id)) throw failure('SESSION_CHANGED', '当前账号已变化，请重新检查会话。');
      return announce({...verified, ...catalog, nativeAvailable: true, expiresAt: session.expiresAt, message: '已核对当前抖音账号。平台最终发布仍需实机验证。'});
    } catch (error) {
      requireCurrent(token);
      unverify(error.message);
      throw error;
    }
  }
  // change 串行处理账号操作，并阻止上传/提交进行中切换底层会话。
  async function change(action) {
    if (changing || activeRequests) throw failure('SESSION_BUSY', '当前操作尚未结束，请等待后再切换或管理账号。');
    changing = true;
    const token = ++generation;
    try { return await action(token); }
    finally { changing = false; }
  }
  // restoreSelection 只恢复宿主选择；失败核验后不能借旧展示状态宣称已在线。
  async function restoreSelection(profileId, token) {
    if (profilesAvailable() && profileId) await call('session.select', {origin: SESSION_ORIGIN, profileId}).catch(() => {});
    requireCurrent(token);
    const catalog = await profileCatalog(token).catch(() => ({profiles: latest.profiles, activeProfileId: null}));
    announce({connected: false, account: null, capabilities: {operations: []}, ...catalog});
  }
  return {
    // connect 只读核验不能与登录或切换抢占；较早核验的迟到响应会被 generation 拒绝。
    async connect() {
      if (changing) throw failure('SESSION_BUSY', '账号操作尚未结束，请稍后检查会话。');
      return check();
    },
    // listAccounts 仅读宿主账号目录，刷新页面时不隐式登录或向平台发请求。
    async listAccounts() {
      if (changing) throw failure('SESSION_BUSY', '账号操作尚未结束，请稍后读取账号列表。');
      const token = generation, catalog = await profileCatalog(token);
      requireCurrent(token);
      const active = catalog.profiles.find(item => item.id === catalog.activeProfileId);
      const changed = catalog.activeProfileId !== latest.activeProfileId || profilesAvailable() && latest.connected && (!active?.hasCookies || active.accountId !== latest.account?.id);
      if (changed) engine?.invalidate();
      return announce({...catalog, ...(changed ? {connected: false, account: null, capabilities: {operations: []}} : {})});
    },
    // importSession 添加独立登录会话；用户取消时原账号与已核验状态完全保留。
    async importSession() {
      return change(async token => {
        // 初始化列表可能尚未返回，回退目标必须取自宿主实际选择，不能只依赖界面缓存。
        const previous = profilesAvailable() ? await call('session.status', {origin: SESSION_ORIGIN}) : null;
        let previousId = previous ? previous.activeProfileId : latest.activeProfileId;
        requireCurrent(token);
        // 升级迁入的会话尚无平台身份，新登录会替换未识别的临时槽；先核验保存，防止丢失旧登录。
        if (previous?.hasCookies === true && !previous.accountId) {
          try {
            const preserved = await check(token, previousId);
            if (!preserved.connected) throw Error('旧会话尚未完成核验');
            previousId = preserved.activeProfileId;
          } catch {
            requireCurrent(token);
            const error = failure('SESSION_IDENTIFICATION_REQUIRED', '已有登录会话尚未确认，已为你保留。请先点击“检查会话”；确认不再使用时，移除当前账号后重新登录。');
            announce({message: error.message});
            throw error;
          }
        }
        const imported = await call('session.login', {origin: SESSION_ORIGIN});
        requireCurrent(token);
        unverify('正在核对新登录的抖音账号…');
        try { return await check(token, profilesAvailable() ? imported?.activeProfileId : undefined); }
        catch (error) {
          // 核验失败只清理本次尚未识别的临时会话，已经保存的其他账号不能被连带删除。
          if (profilesAvailable() && imported?.activeProfileId && imported.activeProfileId !== previousId) {
            const current = await call('session.status', {origin: SESSION_ORIGIN}).catch(() => null);
            requireCurrent(token);
            if (current?.activeProfileId === imported.activeProfileId && !current.accountId) await call('session.clear', {origin: SESSION_ORIGIN, profileId: imported.activeProfileId}).catch(() => {});
          }
          await restoreSelection(previousId, token);
          throw error;
        }
      });
    },
    // selectAccount 先撤销原账号发布资格，再切换并核验；过期档案保留选择并提示重新登录。
    async selectAccount(profileId) {
      if (!profilesAvailable()) throw failure('HOST_CAPABILITY_UNAVAILABLE', MISSING_PROFILES);
      if (typeof profileId !== 'string' || !profileId) throw Error('请选择一个已保存的抖音账号。');
      return change(async token => {
        const previousId = latest.activeProfileId;
        unverify('正在切换并核对抖音账号…');
        try {
          const selected = await call('session.select', {origin: SESSION_ORIGIN, profileId});
          requireCurrent(token);
          if (selected?.activeProfileId !== profileId) throw failure('SESSION_CHANGED', 'App 未选中指定账号，请重新选择。');
          return await check(token, profileId);
        } catch (error) { await restoreSelection(previousId, token); throw error; }
      });
    },
    // clearSession 只移除当前档案；其他已登录账号、作品草稿和历史回执均保留。
    async clearSession() {
      return change(async token => {
        await call('session.clear', {origin: SESSION_ORIGIN});
        requireCurrent(token);
        unverify('当前账号已移除，本机草稿仍保留。');
        return announce({...await profileCatalog(token), nativeAvailable: true});
      });
    },
    // request 业务进行中不允许更换底层账号；最终发布继续收取回执，不声称平台已撤销。
    async request(operation, params = {}, options = {}) {
      if (options.signal?.aborted) throw new DOMException('已取消', 'AbortError');
      if (changing) throw failure('SESSION_BUSY', '正在切换或核对账号，请稍后重试。');
      if (operation === 'studio.session') return check();
      if (!available()) throw failure('HOST_CAPABILITY_UNAVAILABLE', MISSING_HOST);
      if (!latest.connected || !latest.account?.id) throw Error('请先登录抖音并核对账号。');
      const token = generation, expectedAccountId = latest.account.id;
      activeRequests++;
      try {
        const result = await dispatcher().dispatch(operation, params, {origin: origin(), expectedAccountId, signal: options.signal, progress: value => {
          if (!options.signal?.aborted) options.onProgress?.(value);
        }});
        if (operation !== 'publication.publish') requireCurrent(token);
        if (operation !== 'publication.publish' && options.signal?.aborted) throw new DOMException('已停止等待；已提交的操作可能仍在执行', 'AbortError');
        return result;
      } catch (error) {
        if (token === generation && ['ACCOUNT_CHANGED', 'SESSION_CHANGED', 'SESSION_EXPIRED'].includes(error.code)) unverify(error.message);
        throw error;
      } finally { activeRequests--; }
    },
    // onStatus 返回解除订阅函数，避免页面销毁后继续刷新账号。
    onStatus(listener) { if (typeof listener !== 'function') throw new TypeError('状态监听必须是函数。'); listeners.add(listener); return () => listeners.delete(listener); },
  };
}

export const studioClient = createStudioClient();
