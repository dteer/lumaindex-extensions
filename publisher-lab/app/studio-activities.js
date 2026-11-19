import {topicKey} from './studio-state.js';
import {mountSettingHelp} from './studio-help.js';

/** 构造纯文本活动控件，平台标题和详情不作为 HTML 执行。 */
function node(tag, className = '', text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

/** 只展示平台给出的热度，未知值不补造零或推荐数据。 */
function heat(value) {
  const count = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(count) || count < 0) return '';
  return count >= 1e8 ? `${Number((count / 1e8).toFixed(1))}亿` : count >= 1e4 ? `${Number((count / 1e4).toFixed(1))}万` : String(count);
}

/** 查找完整话题，避免把“#摄影”误判为已经存在的“#摄影技巧”。 */
function containsTopic(text, name) {
  const token = '#' + name;
  const boundary = character => !character || !/[\p{L}\p{M}\p{N}_#@]/u.test(character);
  let start = text.indexOf(token);
  while (start >= 0) {
    if (boundary(Array.from(text.slice(0, start)).at(-1)) && boundary(Array.from(text.slice(start + token.length))[0])) return true;
    start = text.indexOf(token, start + token.length);
  }
  return false;
}

/** 挂载官方活动卡片；只读取平台列表和编辑本地草稿，添加活动不会上传或发布。 */
export function mountActivities({container, current, identity, cacheScope = identity, supports, blocked = () => false, request, safeURL, onChanged}) {
  const listeners = new AbortController();
  const pages = new Map(); // 仅当前账号/作品类型的成功页与在途页，不写入草稿或本机存储。
  let scope = '', contextKey = '', generation = 0, disposed = false, state = null;
  let preloadFrame = null, detailController = null;
  let selectionTask = null; // 同时只解析一次添加；草稿/账号失效后不得采用迟到的准确话题。
  const detailDialog = node('dialog', 'studio-activity-dialog');
  detailDialog.setAttribute('aria-label', '活动详情');
  document.body.append(detailDialog);
  container.classList.add('studio-activities');
  const label = node('div', 'studio-activities-label', '官方活动');
  const help = node('button', 'studio-activities-help', '?');
  help.setAttribute('aria-label', '官方活动说明');
  label.append(help);
  const body = node('div', 'studio-activities-body');
  const list = node('div', 'studio-activities-list');
  list.setAttribute('role', 'list'); list.setAttribute('aria-label', '官方活动'); list.tabIndex = 0;
  const status = node('p', 'studio-activities-status'); status.setAttribute('role', 'status');
  const actions = node('div', 'studio-activities-pagination');
  const retry = node('button', 'studio-activities-retry', '重试'); retry.type = 'button'; retry.hidden = true;
  const more = node('button', 'studio-activities-more', '加载更多活动'); more.type = 'button'; more.hidden = true;
  const refresh = node('button', 'studio-activities-refresh', '刷新'); refresh.type = 'button'; refresh.setAttribute('aria-label', '刷新官方活动');
  actions.append(retry, more, refresh); body.append(list, status, actions); container.replaceChildren(label, body);
  const helpControl = mountSettingHelp(help, {text: '添加活动时会在作品描述中加入对应话题，发布前仍需确认。'});

  /** 取消当前账号的所有在途页；旧页面即使忽略取消也不能进入下一账号的缓存。 */
  function clearPages() {
    for (const page of pages.values()) page.controller.abort();
    pages.clear();
  }

  /** 检查当前视图所有权，切草稿、切账号或卸载后不采用迟到结果。 */
  function owns(view) {
    return !disposed && state === view && view.generation === generation && view.identity === identity() && view.scope === cacheScope();
  }

  /** 同一账号和游标只发一次读取，失败从缓存移除以允许显式重试。 */
  function pageFor(view, cursor) {
    const key = JSON.stringify([view.scope, view.kind, cursor ?? null]);
    let page = pages.get(key);
    if (!page) {
      const controller = new AbortController();
      page = {controller, promise: null};
      page.promise = Promise.resolve().then(() => request('activities.list', {kind: view.kind, cursor: cursor ?? undefined}, {signal: controller.signal})).then(result => {
        if (!Array.isArray(result?.items)) throw Error('活动列表不完整，请重试。');
        const next = result.nextCursor ?? null;
        const hasMore = result.hasMore === true;
        if (hasMore && (next === null || next === '' || String(next) === String(cursor))) throw Error('活动分页位置未更新，请重试。');
        return {...result, nextCursor: next, hasMore};
      }).catch(error => {
        if (pages.get(key) === page) pages.delete(key);
        throw error;
      });
      pages.set(key, page);
    }
    return page.promise;
  }

  /** 列表只用于展示活动身份；列表话题数字可能已被平台舍入，不能据此绑定发布话题。 */
  function validItem(item) {
    return item && typeof item.id === 'string' && /^\d{1,30}$/.test(item.id) && typeof item.name === 'string' && item.name.trim() && item.name.length <= 200;
  }

  /** 添加只采用 resolve 已核对的字符串话题身份，绝不从列表名称或数字重建 ID。 */
  function validResolved(item) {
    return validItem(item) && !item.disabled && typeof item.topic?.id === 'string' && /^\d{1,30}$/.test(item.topic.id)
      && typeof item.topic.name === 'string' && item.topic.name.trim() && item.topic.name.length <= 200 && !/[#\r\n]/u.test(item.topic.name);
  }

  /** 添加只会改正文、话题和活动；等待时这些字段被手动编辑就取消旧结果，不能覆盖编辑。 */
  function selectionSignature(draft) { return JSON.stringify([draft.description, draft.topics, draft.activities]); }

  /** 撤销本次添加的所有权；实际传输即使忽略取消，也不能回写新草稿。 */
  function cancelSelection() { selectionTask?.controller.abort(); selectionTask = null; }

  /** 点击添加才解析准确话题，成功后原子更新本地字段；取消活动无需请求并保留普通话题。 */
  async function toggle(item, view) {
    if (!owns(view) || blocked() || selectionTask || !supports('activities.list') || !validItem(item)) return;
    const draft = current();
    const activities = Array.isArray(draft.activities) ? draft.activities : [];
    const selected = activities.some(value => value.id === item.id);
    if (selected) {
      draft.activities = activities.filter(value => value.id !== item.id);
      view.selectionMessage = ''; draw(view); onChanged?.(); return;
    }
    if (item.disabled || !supports('activities.resolve')) return;
    const task = {controller: new AbortController(), view, id: item.id, draft, signature: selectionSignature(draft)};
    selectionTask = task; view.selectionMessage = ''; draw(view);
    try {
      const resolved = await request('activities.resolve', {id: item.id}, {signal: task.controller.signal});
      if (selectionTask !== task || !owns(view) || task.controller.signal.aborted || current() !== draft) return;
      if (blocked() || selectionSignature(draft) !== task.signature) throw Error('正文或话题已变化，本次未添加活动，请重新点击添加。');
      if (!validResolved(resolved) || resolved.id !== item.id) throw Error('活动话题身份无法确认，本次未添加，请重试。');
      const topicIDs = new Set([...(draft.topics || []).filter(value => value.name !== resolved.topic.name).map(topicKey), ...activities.map(value => topicKey(value.topic))]);
      topicIDs.add(topicKey(resolved.topic));
      if (topicIDs.size > 5) throw Error('话题和官方活动合计最多添加 5 个，请先移除一个话题。');
      const description = String(draft.description || '');
      const text = containsTopic(description, resolved.topic.name) ? description : description + (description && !/\s$/u.test(description) ? ' ' : '') + '#' + resolved.topic.name;
      if (text.length > 1000) throw Error('正文已到字数上限，请删减后再添加活动。');
      const topics = (Array.isArray(draft.topics) ? draft.topics : []).filter(value => value.id !== resolved.topic.id && value.name !== resolved.topic.name);
      topics.push({id: resolved.topic.id, name: resolved.topic.name});
      const chosen = {id: resolved.id, name: resolved.name, topic: {id: resolved.topic.id, name: resolved.topic.name}};
      // 所有异步和约束检查通过后才赋值，不留下半份活动选择或隐式正文变更。
      draft.description = text;
      draft.topics = topics;
      draft.activities = [...activities, chosen];
      view.items = view.items.map(value => value.id === resolved.id ? {...value, ...resolved} : value);
      selectionTask = null; draw(view); onChanged?.();
    } catch (error) {
      if (selectionTask !== task || !owns(view) || task.controller.signal.aborted || current() !== draft) return;
      view.selectionMessage = typeof error.message === 'string' && /[\u3400-\u9fff]/u.test(error.message) && error.message.length < 350 ? error.message : '活动话题读取失败，原稿已保留，请重试。';
      window.alert(view.selectionMessage);
    } finally {
      if (selectionTask === task) { selectionTask = null; if (owns(view)) draw(view); }
    }
  }

  /** 按当前选中状态画单行横向卡片，图片和平台链接缺失时不生成虚构补位信息。 */
  function draw(view) {
    if (!owns(view)) return;
    const offset = list.scrollLeft;
    const focusedID = document.activeElement?.closest('.studio-activity-card')?.dataset.activityId;
    const focusedClass = document.activeElement?.classList.contains('studio-activity-details') ? '.studio-activity-details' : '.studio-activity-add';
    const selection = Array.isArray(current().activities) ? current().activities : [];
    // 保存的选择可能不在首屏，仍提供解除入口；只用已保存身份，不发明热度与详情链接。
    const items = [...selection.filter(item => validItem(item) && !view.items.some(value => value.id === item.id)), ...view.items];
    list.replaceChildren();
    for (const item of items) {
      const selected = selection.some(value => value.id === item.id);
      const card = node('article', 'studio-activity-card'); card.setAttribute('role', 'listitem'); card.dataset.activityId = item.id;
      card.classList.toggle('is-selected', selected);
      const title = node('div', 'studio-activity-title');
      const icon = node('span', 'studio-activity-icon', '♪'); icon.setAttribute('aria-hidden', 'true');
      const name = node('span', 'studio-activity-name', item.name); name.title = item.name;
      title.append(icon, name);
      const footer = node('div', 'studio-activity-footer');
      const count = heat(item.heat);
      const popularity = node('span', 'studio-activity-heat', count ? '热度：' + count : '');
      const controls = node('div', 'studio-activity-actions');
      const pending = selectionTask?.view === view && selectionTask.id === item.id;
      const add = node('button', 'studio-activity-add'); add.type = 'button'; add.disabled = blocked() || !!selectionTask || (!selected && (!!item.disabled || !supports('activities.resolve')));
      add.setAttribute('aria-busy', String(pending));
      if (item.disabled && item.description) card.title = item.description;
      add.setAttribute('aria-pressed', String(selected)); add.setAttribute('aria-label', `${selected ? '取消活动' : '添加活动'} ${item.name}`);
      const mark = node('span', 'studio-activity-add-icon', selected ? '✓' : '+'); mark.setAttribute('aria-hidden', 'true');
      add.append(mark, document.createTextNode(pending ? '正在添加' : selected ? '已添加' : '添加'));
      add.onclick = () => { void toggle(item, view); }; controls.append(add);
      const details = node('button', 'studio-activity-details', '活动详情'); details.type = 'button';
      details.disabled = blocked(); details.onclick = () => { void showDetails(item, view); }; controls.append(details);
      footer.append(popularity, controls); card.append(title, footer); list.append(card);
    }
    list.scrollLeft = offset;
    if (focusedID) [...list.children].find(card => card.dataset.activityId === focusedID)?.querySelector(focusedClass)?.focus({preventScroll: true});
    list.hidden = !items.length;
    status.textContent = selectionTask?.view === view ? '正在确认活动话题…' : view.selectionMessage || view.error || (view.loading ? (view.refreshing ? '正在刷新官方活动…' : '正在读取官方活动…') : view.message || (items.length ? '' : '暂无可参加的官方活动'));
    status.hidden = !status.textContent;
    retry.hidden = !view.error; retry.disabled = blocked() || view.loading || !!selectionTask;
    more.hidden = !view.hasMore || view.loading || !!view.error; more.disabled = blocked() || !!selectionTask;
    refresh.disabled = blocked() || view.loading || !!selectionTask;
    refresh.textContent = view.refreshing ? '刷新中…' : '刷新';
    refresh.setAttribute('aria-label', view.refreshing ? '刷新中' : '刷新官方活动');
    refresh.setAttribute('aria-busy', String(!!view.refreshing));
    actions.hidden = false;
  }

  /** 手动刷新仅在成功后替换首屏；分页或刷新失败都保留已有卡片、游标和草稿。 */
  async function load(view, replace = false) {
    if (!owns(view) || view.loading || blocked() || selectionTask || !supports('activities.list') || (!replace && view.loaded && !view.hasMore)) return;
    const cursor = replace || !view.loaded ? null : view.cursor;
    if (replace) clearPages();
    view.loading = true; view.refreshing = replace; view.failedRefresh = false; view.error = ''; view.selectionMessage = ''; draw(view);
    try {
      const result = await pageFor(view, cursor);
      if (!owns(view)) return;
      const fresh = result.items.filter(validItem);
      if (replace) view.items = [];
      for (const item of fresh) if (!view.items.some(value => value.id === item.id)) view.items.push(item);
      view.cursor = result.nextCursor; view.hasMore = result.hasMore; view.loaded = true; view.message = result.message || '';
      if (replace) list.scrollLeft = 0;
    } catch (error) {
      if (!owns(view) || error.name === 'AbortError') return;
      view.failedRefresh = replace;
      view.error = typeof error.message === 'string' && /[\u3400-\u9fff]/u.test(error.message) && error.message.length < 350 ? error.message : '官方活动读取失败，请重试。';
    } finally {
      if (owns(view)) { view.loading = false; view.refreshing = false; draw(view); schedulePreload(); }
    }
  }

  /** 以剩余滚动距离提前加载一页；失败后只由重试按钮恢复，不触底循环重试。 */
  function preload() {
    preloadFrame = null;
    const view = state;
    if (!view || !owns(view) || !view.loaded || !view.hasMore || view.loading || view.error || !list.clientWidth) return;
    if (list.scrollWidth - list.scrollLeft - list.clientWidth < list.clientWidth) void load(view);
  }

  /** 合并尺寸和滚动触发的预加载检查，避免单帧重复查询同一游标。 */
  function schedulePreload() {
    if (!disposed && preloadFrame === null) preloadFrame = requestAnimationFrame(preload);
  }

  /** 关闭详情只取消详情读取，列表分页与用户选择保持不变。 */
  function closeDetails() {
    detailController?.abort(); detailController = null;
    if (detailDialog.open) detailDialog.close();
  }

  /** 显示官方详情的纯文本字段，重试仅重做本次详情，不影响活动列表。 */
  async function showDetails(item, view) {
    if (!owns(view) || blocked()) return;
    detailController?.abort();
    const controller = new AbortController(); detailController = controller;
    const heading = node('div', 'studio-activity-dialog-heading');
    const title = node('h2', '', item.name);
    const dismiss = node('button', 'studio-activity-dialog-close', '×'); dismiss.type = 'button'; dismiss.setAttribute('aria-label', '关闭活动详情'); dismiss.onclick = closeDetails;
    heading.append(title, dismiss);
    const content = node('div', 'studio-activity-dialog-content');
    const loading = node('p', 'studio-activities-status', '正在读取活动详情…'); loading.setAttribute('role', 'status');
    content.append(loading); detailDialog.replaceChildren(heading, content);
    if (!detailDialog.open) detailDialog.showModal();
    try {
      const value = await request('activities.detail', {id: item.id}, {signal: controller.signal});
      if (!owns(view) || detailController !== controller || controller.signal.aborted || !detailDialog.open) return;
      if (!value || value.id !== item.id) throw Error('活动详情无法确认，请重试。');
      title.textContent = value.name || item.name;
      content.replaceChildren();
      if (value.description) content.append(node('p', '', value.description));
      if (Array.isArray(value.topics) && value.topics.length) content.append(node('p', 'studio-activity-detail-topics', value.topics.map(name => '#' + String(name).replace(/^#/, '')).join(' ')));
      const dates = [value.startTime, value.endTime].map(value => typeof value === 'string' ? value : '');
      if (dates.some(Boolean)) content.append(node('p', 'studio-activities-status', `活动时间：${dates[0] || '未提供'} — ${dates[1] || '未提供'}`));
      if (value.rewardDescription) { content.append(node('h3', '', '活动奖励'), node('p', '', value.rewardDescription)); }
      if (!content.children.length) content.append(node('p', 'studio-activities-status', '平台暂未提供更多活动说明。'));
    } catch (error) {
      if (!owns(view) || detailController !== controller || controller.signal.aborted || !detailDialog.open) return;
      const message = typeof error.message === 'string' && /[\u3400-\u9fff]/u.test(error.message) && error.message.length < 350 ? error.message : '活动详情读取失败，请重试。';
      const retryDetail = node('button', '', '重试'); retryDetail.type = 'button'; retryDetail.onclick = () => { void showDetails(item, view); };
      content.replaceChildren(node('p', 'studio-activities-status', message), retryDetail);
    }
  }

  /** 清除视图所有权但保留同账号已读取页；下一次 render 再绑定当前草稿。 */
  function close() {
    if (state?.refreshing) clearPages();
    generation++; contextKey = ''; state = null;
    cancelSelection();
    detailController?.abort(); detailController = null;
    if (detailDialog.open) detailDialog.close();
    if (preloadFrame !== null) cancelAnimationFrame(preloadFrame);
    preloadFrame = null;
  }

  /** 回显当前作品的活动；支持范围或身份变化才创建新的列表视图。 */
  function render() {
    if (disposed) return;
    if (selectionTask && (current() !== selectionTask.draft || selectionSignature(current()) !== selectionTask.signature)) cancelSelection();
    const nextScope = cacheScope();
    if (scope !== nextScope) { clearPages(); scope = nextScope; close(); }
    if (!supports('activities.list')) {
      close(); list.replaceChildren(); list.hidden = true; actions.hidden = true;
      status.hidden = false; status.textContent = '登录并检查账号后，可选择官方活动。'; return;
    }
    const key = JSON.stringify([identity(), nextScope, current().kind]);
    if (contextKey !== key || !state) {
      close(); contextKey = key;
      state = {identity: identity(), scope: nextScope, kind: current().kind, generation,
        items: [], cursor: null, hasMore: false, loaded: false, loading: false, refreshing: false, failedRefresh: false, error: '', message: ''};
      list.scrollLeft = 0;
    }
    draw(state);
    if (!state.loaded && !state.loading && !state.error) void load(state);
    else schedulePreload();
  }

  detailDialog.addEventListener('close', () => { if (!detailDialog.open) { detailController?.abort(); detailController = null; } }, {signal: listeners.signal});
  detailDialog.addEventListener('cancel', closeDetails, {signal: listeners.signal});
  list.addEventListener('scroll', schedulePreload, {signal: listeners.signal, passive: true});
  list.addEventListener('keydown', event => {
    if (event.target !== list || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); list.scrollBy({left: (event.key === 'ArrowLeft' ? -1 : 1) * list.clientWidth * 0.8, behavior: 'smooth'});
  }, {signal: listeners.signal});
  retry.addEventListener('click', () => { if (state) void load(state, state.failedRefresh); }, {signal: listeners.signal});
  more.addEventListener('click', () => { if (state) void load(state); }, {signal: listeners.signal});
  refresh.addEventListener('click', () => { if (state) void load(state, true); }, {signal: listeners.signal});
  const resize = new ResizeObserver(schedulePreload); resize.observe(list);
  return {
    render, close,
    /** 卸载时取消所有只读请求与监听，不清除用户选择或草稿正文。 */
    dispose() {
      if (disposed) return;
      close(); disposed = true; clearPages(); listeners.abort(); resize.disconnect(); helpControl.destroy(); detailDialog.remove(); container.replaceChildren();
    },
  };
}
