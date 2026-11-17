// publication-store 仅保存实验插件的发布快照及回执，不发起网络请求。
const STORAGE_KEY = 'luma-studio-publications-v1';
const PREPARATION_TTL = 30 * 60 * 1000;
const FINAL_STATUSES = new Set(['published', 'scheduled', 'processing', 'failed', 'unknown']);
// storageLocks 为同一存储对象串行化读改写，防止并发确认重复获得发送资格。
const storageLocks = new WeakMap();

// failure 使用稳定业务码和用户可操作的中文说明，不向页面泄露底层存储异常。
function failure(code, message) { return Object.assign(new Error(message), {code}); }

// copyJSON 创建独立的纯数据快照，拒绝函数、循环引用和不可序列化字段。
function copyJSON(value, label) {
  try {
    const text = JSON.stringify(value, (_key, item) => {
      if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' || (typeof item === 'number' && !Number.isFinite(item))) throw Error();
      return item;
    });
    if (text === undefined) throw Error();
    return JSON.parse(text);
  } catch { throw failure('INVALID_SNAPSHOT', `${label}无法保存，请重新准备作品。`); }
}

// rejectSecrets 拒绝凭据字段；JSON 字符串中的嵌套对象也执行相同校验。
function rejectSecrets(value, depth = 0) {
  if (depth > 60) throw failure('INVALID_SNAPSHOT', '发布数据结构过深，请重新准备作品。');
  if (typeof value === 'string') {
    if (/^\s*[\[{]/.test(value)) {
      let nested;
      try { nested = JSON.parse(value); } catch { return; }
      rejectSecrets(nested, depth + 1);
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/(cookie|upload[_-]?auth|secret|authorization|access[_-]?token|refresh[_-]?token|session[_-]?key|password)/i.test(key)) {
      throw failure('SENSITIVE_SNAPSHOT', '发布快照不能包含 Cookie、上传授权或密钥。');
    }
    rejectSecrets(item, depth + 1);
  }
}

// checkedOrigin 限定快照归属为规范的本机 App 源，端口变化视为不同来源。
function checkedOrigin(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && !url.username && !url.password && url.origin === value) return value;
  } catch {}
  throw failure('INVALID_ORIGIN', '无法确认本次 App 来源，请重新连接。');
}

// checkedID 限制内部索引键，避免原型键和任意路径进入存储索引。
function checkedID(value, label) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(value)) throw failure('INVALID_ID', `${label}无效，请重新准备作品。`);
  return value;
}

// accountID 兼容当前账号的字符串身份及展示对象，比较只使用稳定身份。
function accountID(account) {
  const value = typeof account === 'string' ? account : account?.id ?? account?.accountId ?? account?.account;
  if (typeof value !== 'string' || !value || value.length > 200) throw failure('INVALID_ACCOUNT', '无法确认抖音账号，请重新连接。');
  return value;
}

// metadata 返回可用于历史展示的字段，永不返回原始草稿或发布 payload。
function metadata(record) {
  return copyJSON({
    preparationId: record.preparationId,
    requestId: record.requestId || null,
    publicationId: record.result?.publicationId || null,
    account: record.account,
    summary: record.summary,
    status: record.status,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    submittedAt: record.submittedAt || null,
    finishedAt: record.finishedAt || null,
    message: record.result?.message || '',
  }, '发布记录');
}

// resultFor 对没有明确回执的尝试只返回 unknown，绝不推定发布成功或可重发。
function resultFor(record) {
  const result = record.result || {
    status: 'unknown',
    message: '发布请求已经开始，尚未收到明确回执。请核对抖音作品列表，勿重复提交。',
  };
  return copyJSON({...result, preparationId: record.preparationId, requestId: record.requestId, canPublish: false}, '发布结果');
}

// createPublicationStore 注入 Chrome storage、时钟与 ID 工厂；调用者负责选择持久层。
export function createPublicationStore({storage, now = Date.now, uuid = () => crypto.randomUUID()}) {
  if (!storage || typeof storage.get !== 'function' || typeof storage.set !== 'function') throw Error('缺少发布状态存储。');
  const owner = checkedID(uuid(), '会话身份');

  // locked 在整个读改写和持久化完成期间持有本进程锁；失败不阻塞后续检查。
  function locked(operation) {
    const previous = storageLocks.get(storage) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    storageLocks.set(storage, current.catch(() => {}));
    return current;
  }

  // save 成功返回之前不授予网络发送资格；存储失败必须停止发布。
  async function save(state) {
    try { await storage.set({[STORAGE_KEY]: copyJSON(state, '发布状态')}); }
    catch { throw failure('STORAGE_WRITE_FAILED', '发布状态未能保存，操作已停止。请检查扩展存储后重试。'); }
  }

  // load 恢复旧进程未完成的提交为 unknown，保留防重索引，禁止自动重新发送。
  async function load() {
    let stored;
    try { stored = (await storage.get(STORAGE_KEY))[STORAGE_KEY]; }
    catch { throw failure('STORAGE_READ_FAILED', '暂时无法读取发布状态，请稍后重试。'); }
    const state = stored === undefined ? {version: 1, preparations: {}, requestIndex: {}} : copyJSON(stored, '发布状态');
    if (!state || typeof state !== 'object' || state.version !== 1 || !state.preparations || typeof state.preparations !== 'object' || Array.isArray(state.preparations) || !state.requestIndex || typeof state.requestIndex !== 'object' || Array.isArray(state.requestIndex)) throw failure('INVALID_STORE', '发布状态无法识别，请保留数据并检查扩展。');
    let recovered = false;
    for (const record of Object.values(state.preparations)) {
      if (record.status === 'submitting' && record.owner !== owner) {
        record.status = 'unknown';
        record.finishedAt = now();
        record.result = {status: 'unknown', message: '发布期间连接已中断，无法确认结果。请先核对抖音作品列表，勿重复提交。'};
        recovered = true;
      }
    }
    if (recovered) await save(state);
    return state;
  }

  // requireRecord 先核对来源和账号，再返回快照，不能借失败提示跨来源读取数据。
  function requireRecord(state, id, origin, expectedAccountId) {
    checkedID(id, '准备记录'); checkedOrigin(origin);
    const record = Object.hasOwn(state.preparations, id) ? state.preparations[id] : null;
    if (!record || record.origin !== origin) throw failure('PREPARATION_NOT_FOUND', '未找到本次准备记录，请从当前 App 重新准备。');
    if (record.accountId !== accountID(expectedAccountId)) throw failure('ACCOUNT_CHANGED', '抖音账号已变化，请使用当前账号重新准备作品。');
    return record;
  }

  // requireFresh 只校验尚未尝试的快照；已尝试记录即使过期也必须保留防重结果。
  function requireFresh(record) {
    if (record.status !== 'prepared') throw failure('ALREADY_ATTEMPTED', '本次作品已尝试发布，请先查看发布结果。');
    if (record.expiresAt <= now()) throw failure('PREPARATION_EXPIRED', '准备记录已超过 30 分钟，请重新准备并核对作品。');
  }

  return {
    // prepare 保存与调用者脱离引用的完整快照；后续编辑草稿不会改变已确认内容。
    prepare(input) {
      return locked(async () => {
        const origin = checkedOrigin(input?.origin), id = checkedID(uuid(), '准备记录');
        const account = copyJSON(input.account, '账号'), identity = accountID(account);
        const draft = copyJSON(input.draft, '作品草稿'), payload = copyJSON(input.payload, '发布数据'), summary = copyJSON(input.summary, '作品摘要');
        rejectSecrets({account, draft, payload, summary});
        const state = await load();
        if (Object.hasOwn(state.preparations, id)) throw failure('ID_CONFLICT', '准备记录身份冲突，请重新准备。');
        const createdAt = now(), expiresAt = createdAt + PREPARATION_TTL;
        state.preparations[id] = {preparationId: id, account, accountId: identity, draft, payload, summary, origin, status: 'prepared', createdAt, expiresAt, requestId: null, owner: null, result: null};
        await save(state);
        return copyJSON({preparationId: id, account, summary, canPublish: true, expiresAt}, '准备结果');
      });
    },

    // getPrepared 供发送前核对完整不可变内容，过期、账号变化或已有尝试均拒绝。
    getPrepared(id, origin, expectedAccountId) {
      return locked(async () => {
        const record = requireRecord(await load(), id, origin, expectedAccountId);
        requireFresh(record);
        return copyJSON(record, '准备记录');
      });
    },

    // beginSubmit 先持久化 submitting 和幂等索引，只有 duplicate:false 允许一次网络发送。
    beginSubmit({preparationId, requestId, origin, expectedAccountId, confirmed}) {
      return locked(async () => {
        if (confirmed !== true) throw failure('CONFIRMATION_REQUIRED', '请核对作品并明确确认发布。');
        checkedID(requestId, '发布请求'); checkedOrigin(origin);
        const state = await load();
        const indexed = Object.hasOwn(state.requestIndex, requestId) ? state.requestIndex[requestId] : null;
        if (indexed && indexed !== preparationId) throw failure('REQUEST_ID_REUSED', '该发布请求已用于另一份作品，请重新准备。');
        const record = requireRecord(state, preparationId, origin, expectedAccountId);
        if (record.status !== 'prepared') {
          // 不同请求 ID 也绑定同一尝试，后续状态查询及跨作品重用检查保持一致。
          if (!indexed) { state.requestIndex[requestId] = preparationId; await save(state); }
          return {duplicate: true, result: resultFor(record)};
        }
        requireFresh(record);
        record.status = 'submitting'; record.requestId = requestId; record.submittedAt = now(); record.owner = owner;
        state.requestIndex[requestId] = preparationId;
        await save(state);
        return {duplicate: false, ...copyJSON(record, '发布快照')};
      });
    },

    // finish 仅记录已经开始的尝试；终态不被迟到的冲突回执覆盖。
    finish(preparationId, result) {
      return locked(async () => {
        checkedID(preparationId, '准备记录');
        const actual = copyJSON(result, '发布结果');
        if (!actual || typeof actual !== 'object' || Array.isArray(actual) || !FINAL_STATUSES.has(actual.status)) throw failure('INVALID_RESULT', '发布结果状态无效，请检查作品列表。');
        rejectSecrets(actual);
        const state = await load(), record = Object.hasOwn(state.preparations, preparationId) ? state.preparations[preparationId] : null;
        if (!record || record.status === 'prepared') throw failure('NOT_SUBMITTED', '本次作品尚未开始发布，不能记录发布结果。');
        if (['published', 'scheduled', 'failed'].includes(record.status)) {
          if (JSON.stringify(record.result) !== JSON.stringify(actual)) throw failure('RESULT_CONFLICT', '已有明确发布结果，无法被不同回执覆盖。');
          return resultFor(record);
        }
        record.status = actual.status; record.result = actual; record.finishedAt = now();
        await save(state);
        return resultFor(record);
      });
    },

    // findStatus 按当前来源内的请求或平台作品 ID 查询，未找到返回 null。
    findStatus({requestId, publicationId, origin}) {
      return locked(async () => {
        checkedOrigin(origin);
        if (!requestId && !publicationId) throw failure('INVALID_ID', '请选择需要查看的发布记录。');
        if (requestId) checkedID(requestId, '发布请求');
        if (publicationId && (typeof publicationId !== 'string' || publicationId.length > 200)) throw failure('INVALID_ID', '作品身份无效。');
        const state = await load();
        const id = requestId && Object.hasOwn(state.requestIndex, requestId) ? state.requestIndex[requestId] : null;
        const record = requestId ? (id ? state.preparations[id] : null) : Object.values(state.preparations).find(item => item.origin === origin && item.result?.publicationId === publicationId);
        if (!record || record.origin !== origin || (publicationId && record.result?.publicationId !== publicationId)) return null;
        return resultFor(record);
      });
    },

    // listHistory 只返回当前来源的展示元数据，完整 payload 与草稿不能经历史接口读出。
    listHistory(origin) {
      return locked(async () => {
        checkedOrigin(origin);
        return Object.values((await load()).preparations).filter(record => record.origin === origin).sort((a, b) => b.createdAt - a.createdAt || a.preparationId.localeCompare(b.preparationId)).map(metadata);
      });
    },
  };
}
