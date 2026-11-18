import {createNativeFetch} from './native-transport.js';
import {createStudioEngine, capabilities} from './platform/studio-engine.js';
import {createCreatorFetch} from './platform/browser-request.js';
import {CREATOR_ORIGIN as SESSION_ORIGIN, beginCreatorLogin} from './platform/session.js';
const MISSING_HOST = '当前 App 版本不支持此插件，请先更新 App 后重新打开工作台。';
const MISSING_PROFILES = '当前 App 尚未开放多账号能力，请更新 App 后添加或切换账号。';

// createStudioClient 使用宿主持久网页会话、页面请求和独立持久化，不依赖外部服务或浏览器扩展。
export function createStudioClient({context = () => window.pluginContext || {}, post = message => window.webkit?.messageHandlers?.pluginUI?.postMessage(message)} = {}) {
  const listeners = new Set();
  let latest = {connected: false, account: null, capabilities: {operations: []}, profiles: [], activeProfileId: null}, engine;
  let generation = 0, changing = false, activeWrites = 0, offlineProfileId = null;
  const queries = new Set();
  const writeOperations = new Set(['publication.prepare', 'publication.publish', 'cover.upload']);
  // 稳定网页环境和页面请求能力必须同时具备，旧宿主不得退回原生 HTTP。
  function available() {
    const capabilities = context().nativeCapabilities;
    return context().nativeUIAvailable === true && capabilities?.sessionVersion === 1 &&
      capabilities.sessionLoginOptionsVersion === 1 && capabilities.networkHeadersVersion === 1 &&
      capabilities.persistentWebsiteSessionsVersion === 1 && capabilities.browserRequestsVersion === 1;
  }
  function profilesAvailable() { return available() && context().nativeCapabilities?.sessionProfilesVersion === 1; }
  // failure 给异步会话竞态返回稳定本机码，不让迟到结果覆盖新账号。
  function failure(code, message) { return Object.assign(Error(message), {code}); }
  function requireCurrent(token) { if (token !== generation) throw failure('SESSION_CHANGED', '账号操作已变化，请检查当前账号后重试。'); }
  // call 统一解包原生业务回执；取消/权限拒绝/网络失败不会误报为成功。
  async function call(op, params = {}) {
    if (!available()) throw failure('HOST_CAPABILITY_UNAVAILABLE', MISSING_HOST);
    const response = await post({op, ...params});
    if (response?.ok !== true) {
      const code = response?.error?.code || 'HOST_REQUEST_FAILED';
      throw failure(code, code === 'SESSION_ACCOUNT_EXISTS' ? '此账号已添加，请在账号列表中选择它，再点击“重新登录当前账号”。' : response?.error?.message || 'App 未完成本次操作，请重试。');
    }
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
    if (!engine) engine = createStudioEngine({send: createCreatorFetch(createNativeFetch(call)),
      // 业务请求沿用选中档案；平台错误直接反馈，不在每次查询前额外联网检查账号。
      sessionStatus: profilesAvailable() ? () => call('session.status', {origin: SESSION_ORIGIN}) : undefined,
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
  // unverify 仅标记当前账号离线；保留已知身份、能力及编辑信息，交由用户处理会话问题。
  function unverify(message) {
    offlineProfileId = latest.activeProfileId;
    return announce({connected: false, message});
  }

  // catalogState 从本机档案恢复展示与可尝试的能力，不将此状态当作上传或发布的实时核验。
  function catalogState(catalog) {
    const active = catalog.profiles.find(item => item.id === catalog.activeProfileId);
    const known = typeof active?.accountId === 'string' && /^\d{1,30}$/.test(active.accountId);
    const connected = known && active.browserSessionAvailable && offlineProfileId !== active.id;
    return {...catalog, connected: !!connected, account: known ? {id: active.accountId, name: active.name} : null,
      capabilities: known ? capabilities() : {operations: []}, nativeAvailable: true, expiresAt: active?.expiresAt,
      message: known ? connected ? '' : '账号离线，请检查会话或重新登录；已保存的信息仍保留。' : '请选择已有账号或登录抖音。'};
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
        profiles.push({id: item.id, accountId: typeof item.accountId === 'string' ? item.accountId : null, name: typeof item.name === 'string' ? item.name : '', expiresAt: item.expiresAt, hasCookies: item.hasCookies === true, browserSessionAvailable: item.browserSessionAvailable === true});
      }
      if (!page.hasMore) return {profiles, activeProfileId};
      if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw Error('App 返回的账号分页位置无效，请重新检查会话。');
      offset = page.nextOffset;
    }
  }
  // check 读取当前档案后由平台核验身份，再用档案 CAS 保存公开身份；迟到核验不能改写新选择。
  async function check(token = ++generation, expectedProfileId, expectedAccountId) {
    if (!available()) return announce({connected: false, account: null, capabilities: {operations: []}, profiles: [], activeProfileId: null, nativeAvailable: false, message: MISSING_HOST});
    try {
      const session = await call('session.status', {origin: SESSION_ORIGIN});
      requireCurrent(token);
      if (expectedProfileId && session?.activeProfileId !== expectedProfileId) throw failure('SESSION_CHANGED', '当前账号与本次选择不一致，请重新选择账号。');
      // 检查同一账号不丢弃已有候选；宿主实际换了档案或账号才隔离旧结果。
      if (profilesAvailable() && (session.activeProfileId !== latest.activeProfileId || (session.accountId || null) !== (latest.account?.id || null))) engine?.invalidate();
      if (session?.browserSessionAvailable !== true || !session.activeProfileId) {
        const catalog = await profileCatalog(token);
        if (profilesAvailable() && catalog.activeProfileId !== session?.activeProfileId) throw failure('SESSION_CHANGED', '当前账号已变化，请重新检查会话。');
        offlineProfileId = catalog.activeProfileId;
        return announce({...catalogState(catalog), connected: false, message: catalog.activeProfileId ? '账号离线，请重新登录抖音；已保存的信息仍保留。' : '请先登录抖音，在官方登录窗口完成扫码或验证。'});
      }
      const verified = await dispatcher().dispatch('studio.session', {}, {origin: origin(), profileId: session.activeProfileId});
      requireCurrent(token);
      if (expectedAccountId && verified.account?.id !== expectedAccountId) throw failure('SESSION_IDENTITY_MISMATCH', '重新登录的账号与所选账号不一致，请返回原账号；其他账号请使用“添加账号”。');
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
      offlineProfileId = null;
      return announce({...verified, ...catalog, activeProfileId: selectedId, nativeAvailable: true, expiresAt: session.expiresAt, message: '已核对当前抖音账号。'});
    } catch (error) {
      requireCurrent(token);
      unverify(error.message);
      throw error;
    }
  }
  // change 串行处理账号操作，并阻止上传/提交进行中切换底层会话。
  async function change(action, {preserveCandidates = false} = {}) {
    if (changing || activeWrites) throw failure('SESSION_BUSY', '正在上传或提交作品，请等待结束后再管理账号。');
    changing = true;
    const token = ++generation;
    for (const controller of queries) controller.abort();
    if (!preserveCandidates) engine?.invalidate();
    try { return await action(token); }
    finally { changing = false; }
  }
  // restoreSelection 只恢复宿主选择；失败核验后不能借旧展示状态宣称已在线。
  async function restoreSelection(profileId, token) {
    if (profilesAvailable() && profileId) await call('session.select', {origin: SESSION_ORIGIN, profileId}).catch(() => {});
    requireCurrent(token);
    const catalog = await profileCatalog(token).catch(() => ({profiles: latest.profiles, activeProfileId: null}));
    announce(catalogState(catalog));
  }
  return {
    // connect 只读核验不能与登录或切换抢占；较早核验的迟到响应会被 generation 拒绝。
    async connect() {
      return change(token => check(token), {preserveCandidates: true});
    },
    // listAccounts 仅读宿主账号目录，刷新页面时不隐式登录或向平台发请求。
    async listAccounts() {
      if (!available()) return check();
      if (changing) throw failure('SESSION_BUSY', '账号操作尚未结束，请稍后读取账号列表。');
      const token = generation, catalog = await profileCatalog(token);
      requireCurrent(token);
      const active = catalog.profiles.find(item => item.id === catalog.activeProfileId);
      const changed = catalog.activeProfileId !== latest.activeProfileId || (active?.accountId || null) !== (latest.account?.id || null);
      if (changed) {
        // 外部换号与本页主动切换具有相同的结果归属；旧请求的错误也不能标记新账号离线。
        generation++;
        for (const controller of queries) controller.abort();
        engine?.invalidate();
      }
      return announce(catalogState(catalog));
    },
    // importSession 添加独立登录会话；用户取消时不提交新的原生会话或切换已选账号。
    async importSession() {
      return change(async token => {
        // 初始化列表可能尚未返回，回退目标必须取自宿主实际选择，不能只依赖界面缓存。
        const previous = profilesAvailable() ? await call('session.status', {origin: SESSION_ORIGIN}) : null;
        let previousId = previous ? previous.activeProfileId : latest.activeProfileId;
        requireCurrent(token);
        // 升级迁入的会话尚无平台身份，新登录会替换未识别的临时槽；先核验保存，防止丢失旧登录。
        if (previous?.browserSessionAvailable === true && !previous.accountId) {
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
        const imported = await beginCreatorLogin(call);
        requireCurrent(token);
        unverify('正在核对新登录的抖音账号…');
        try { return await check(token, profilesAvailable() ? imported?.activeProfileId : undefined); }
        catch (error) {
          // 核验失败只清理本次未识别的 API 候选，保留稳定待登录网页环境以便重试；其他账号不受影响。
          if (profilesAvailable() && imported?.activeProfileId && imported.activeProfileId !== previousId) {
            const current = await call('session.status', {origin: SESSION_ORIGIN}).catch(() => null);
            requireCurrent(token);
            if (current?.activeProfileId === imported.activeProfileId && !current.accountId) await call('session.clear', {origin: SESSION_ORIGIN, profileId: imported.activeProfileId, keepBrowserData: true}).catch(() => {});
          }
          await restoreSelection(previousId, token);
          throw error;
        }
      });
    },
    // reloginSession 只重登当前已保存身份，复用原网页容器；取消不会提交新的原生凭据或切换档案。
    async reloginSession() {
      if (!profilesAvailable()) throw failure('HOST_CAPABILITY_UNAVAILABLE', MISSING_PROFILES);
      const targetId = latest.activeProfileId;
      if (!targetId) throw failure('SESSION_PROFILE_REQUIRED', '请先选择需要重新登录的账号。');
      return change(async token => {
        const previous = await call('session.status', {origin: SESSION_ORIGIN});
        requireCurrent(token);
        if (previous?.activeProfileId !== targetId || !previous.accountId) throw failure('SESSION_CHANGED', '当前账号已变化，请重新选择需要登录的账号。');
        const imported = await beginCreatorLogin(call, {profileId: targetId});
        requireCurrent(token);
        unverify('正在核对重新登录的抖音账号…');
        try {
          if (!imported?.activeProfileId || imported.activeProfileId === targetId) throw failure('SESSION_CHANGED', '重新登录尚未准备完成，请返回原账号后重试。');
          const verified = await check(token, imported.activeProfileId, previous.accountId);
          if (verified.activeProfileId !== targetId || verified.account?.id !== previous.accountId) throw failure('SESSION_IDENTITY_MISMATCH', '重新登录的账号与所选账号不一致，请返回原账号；其他账号请使用“添加账号”。');
          return verified;
        } catch (error) {
          // 只丢弃尚未核验的 API 候选，显式保留其共享的原档案网页容器和旧 API 凭据。
          if (imported?.activeProfileId && imported.activeProfileId !== targetId) {
            const current = await call('session.status', {origin: SESSION_ORIGIN}).catch(() => null);
            requireCurrent(token);
            if (current?.activeProfileId === imported.activeProfileId && !current.accountId) await call('session.clear', {origin: SESSION_ORIGIN, profileId: imported.activeProfileId, keepBrowserData: true}).catch(() => {});
          }
          await restoreSelection(targetId, token);
          throw error;
        }
      });
    },
    // selectAccount 切换明确的本机档案；业务接口自行报告登录问题，不在切换时额外联网。
    async selectAccount(profileId) {
      if (!profilesAvailable()) throw failure('HOST_CAPABILITY_UNAVAILABLE', MISSING_PROFILES);
      if (typeof profileId !== 'string' || !profileId) throw Error('请选择一个已保存的抖音账号。');
      return change(async token => {
        const previousId = latest.activeProfileId;
        try {
          const selected = await call('session.select', {origin: SESSION_ORIGIN, profileId});
          requireCurrent(token);
          if (selected?.activeProfileId !== profileId) throw failure('SESSION_CHANGED', 'App 未选中指定账号，请重新选择。');
          const catalog = await profileCatalog(token);
          requireCurrent(token);
          if (catalog.activeProfileId !== profileId) throw failure('SESSION_CHANGED', '当前账号已变化，请重新选择账号。');
          return announce(catalogState(catalog));
        } catch (error) { await restoreSelection(previousId, token); throw error; }
      });
    },
    // clearSession 只移除当前档案；其他已登录账号、作品草稿和历史回执均保留。
    async clearSession() {
      return change(async token => {
        await call('session.clear', {origin: SESSION_ORIGIN});
        requireCurrent(token);
        unverify('当前账号已移除，本机草稿仍保留。');
        return announce(catalogState(await profileCatalog(token)));
      });
    },
    // request 上传/提交保持互斥；普通查询在换号时取消，迟到结果不能写到新账号。
    async request(operation, params = {}, options = {}) {
      if (options.signal?.aborted) throw new DOMException('已取消', 'AbortError');
      if (changing) throw failure('SESSION_BUSY', '正在切换或核对账号，请稍后重试。');
      if (operation === 'studio.session') return change(token => check(token), {preserveCandidates: true});
      if (!available()) throw failure('HOST_CAPABILITY_UNAVAILABLE', MISSING_HOST);
      if (!latest.account?.id) throw Error('请先选择已有账号或登录抖音。');
      const token = generation, expectedAccountId = latest.account.id, profileId = latest.activeProfileId;
      const writing = writeOperations.has(operation), controller = writing ? null : new AbortController();
      const cancel = () => controller?.abort();
      if (writing) activeWrites++;
      else { queries.add(controller); options.signal?.addEventListener('abort', cancel, {once: true}); }
      const signal = controller?.signal || options.signal;
      try {
        const result = await dispatcher().dispatch(operation, params, {origin: origin(), expectedAccountId, profileId, signal, progress: value => {
          if (!signal?.aborted) options.onProgress?.(value);
        }});
        if (operation !== 'publication.publish') requireCurrent(token);
        if (operation !== 'publication.publish' && signal?.aborted) throw new DOMException('已取消查询', 'AbortError');
        return result;
      } catch (error) {
        if (token === generation && ['ACCOUNT_CHANGED', 'SESSION_CHANGED', 'SESSION_EXPIRED'].includes(error.code)) unverify(error.message);
        throw error;
      } finally {
        if (writing) activeWrites--;
        else { queries.delete(controller); options.signal?.removeEventListener('abort', cancel); }
      }
    },
    // onStatus 返回解除订阅函数，避免页面销毁后继续刷新账号。
    onStatus(listener) { if (typeof listener !== 'function') throw new TypeError('状态监听必须是函数。'); listeners.add(listener); return () => listeners.delete(listener); },
  };
}

export const studioClient = createStudioClient();
