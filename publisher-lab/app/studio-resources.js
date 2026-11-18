import {mountCityPicker} from './studio-cities.js';

// node 构造只含文本的控件，平台名称与说明不得作为 HTML 插入。
function node(tag, className = '', text) {
  const value = document.createElement(tag);
  value.className = className;
  if (text !== undefined) value.textContent = String(text);
  return value;
}

// heat 使用平台返回的真实热度，不为缺失数据生成展示数值。
function heat(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return '';
  return count >= 1e8 ? `${(count / 1e8).toFixed(1)}亿` : count >= 1e4 ? `${(count / 1e4).toFixed(1)}万` : String(count);
}

// tokenIndex 与发布正文使用相同的完整词边界，避免把 #摄影 误认为 #摄影技巧。
function tokenIndex(text, token) {
  const boundary = character => !character || !/[\p{L}\p{M}\p{N}_#@]/u.test(character);
  let index = text.indexOf(token);
  while (index >= 0) {
    if (boundary(Array.from(text.slice(0, index)).at(-1)) && boundary(Array.from(text.slice(index + token.length))[0])) return index;
    index = text.indexOf(token, index + token.length);
  }
  return -1;
}

// sameResource 新话题共用 ID 0，按名称区分；已有话题的同名候选也只绑定一次。
function sameResource(kind, left, right) {
  if (kind === 'topics') {
    if (left.name === right.name) return true;
    if (String(left.id) === '0' || String(right.id) === '0') return false;
  }
  return String(left.id) === String(right.id);
}

// mountResourceControls 维护当前账号/草稿的下拉查询、话题联想和声明选择；不上传或发布素材。
export function mountResourceControls({current, supports, safeURL, request, identity, cacheScope = identity, blocked, changed, selectCollection}) {
  const $ = id => document.getElementById(id);
  let contextKey = identity(), cachedScope = cacheScope(), active = null, timer = null, cityCode = '', cityName = '';
  let cityPicker = null;
  const queryCache = new Map(); // 当前账号的合集分页和声明选项；只在内存保存，失败不缓存。
  let declarationItems = [], recommendationItems = [], recommendationKey = '', associationRange = null;
  let recommendationController = null;
  const description = $('description');
  const clearButtons = new Map();
  // 清除只编辑本机草稿，独立于读取平台选项的账号状态。
  for (const [kind, label] of [['collection', '合集'], ['location', '位置']]) {
    const field = $('search-' + kind), wrapper = node('div', 'resource-field-control');
    const button = node('button', 'resource-clear', '×'); button.type = 'button';
    button.setAttribute('aria-label', '清除' + label); button.title = '清除' + label;
    button.onclick = () => select(kind, {id: ''});
    field.before(wrapper); wrapper.append(field, button); clearButtons.set(kind, button);
  }

  // close 取消当前选择器请求；已选资源与用户正文保持不变。
  function close() {
    clearTimeout(timer); cityPicker?.close();
    active?.controller?.abort();
    active = null;
    for (const kind of ['collection', 'declaration', 'location']) {
      $(kind + '-popover').hidden = true;
      $('search-' + kind).setAttribute('aria-expanded', 'false');
    }
    $('association-results').hidden = true;
  }

  // select 将话题名称或平台资源身份绑定作品；话题与好友在光标位置替换完整 token。
  function select(kind, item) {
    if (blocked() || !item || item.disabled) return;
    if (kind === 'topics' || kind === 'mentions') {
      // 离线候选不能把已经绑定的真实同名话题降级为新话题。
      if (kind === 'topics' && String(item.id) === '0') item = current().topics.find(value => value.name === item.name && String(value.id) !== '0') || item;
      const prefix = kind === 'topics' ? '#' : '@';
      const range = associationRange?.kind === kind ? associationRange : {start: description.selectionStart, end: description.selectionEnd};
      const text = description.value;
      const token = prefix + item.name;
      const withoutFragment = text.slice(0, range.start) + text.slice(range.end);
      const existing = tokenIndex(withoutFragment, token);
      const leading = range.start > 0 && !/\s/.test(text[range.start - 1]) ? ' ' : '';
      // 已有分隔符原样保留，仅在紧邻后文时补空格；末尾不额外插入字符影响字数。
      const remainder = text.slice(range.end);
      const tail = associationRange?.kind === kind && /^[\t ]*$/.test(remainder) ? '' : remainder;
      const trailing = tail && !/^[\s\p{P}]/u.test(tail) ? ' ' : '';
      const next = existing >= 0 ? withoutFragment : text.slice(0, range.start) + leading + token + trailing + tail;
      if (next.length > description.maxLength) { description.setCustomValidity('正文已到字数上限，请删减后再添加。'); description.reportValidity(); return; }
      description.setCustomValidity('');
      description.value = current().description = next;
      const caret = existing >= 0 ? existing + token.length : range.start + leading.length + token.length;
      current()[kind] = current()[kind].filter(value => !sameResource(kind, value, item) && value.name !== item.name);
      current()[kind].push({id: String(item.id), name: item.name});
      close(); associationRange = null; changed();
      description.focus(); description.setSelectionRange(caret, caret);
      return;
    }
    if (kind === 'collection' && selectCollection) {
      close(); void selectCollection(item.id ? {id: String(item.id), name: item.name} : null);
      return;
    }
    if (kind === 'declaration') current().settings.declarations = item.id ? [String(item.id)] : [];
    else current()[kind] = item.id ? {id: String(item.id), name: item.name, ...(kind === 'location' ? {cityCode, cityName} : {})} : null;
    close(); changed();
  }

  // topicCandidates 为没有精确同名结果的关键词提供本地新话题，已有真实 ID 优先。
  function topicCandidates(state) {
    if (state.kind !== 'topics' || !state.query || state.query.length > 200 || /[#\u0000-\u001f\u007f]/u.test(state.query)) return state.items;
    const items = [...state.items], bound = current().topics.find(item => item.name === state.query);
    const exact = items.findIndex(item => item.name === state.query);
    if (exact < 0) items.unshift(bound || {id: '0', name: state.query, viewCount: 0});
    else if (String(items[exact].id) === '0' && bound && String(bound.id) !== '0') items[exact] = bound;
    return items;
  }

  // renderItems 追加分页结果后更新下拉，未知枚举保持禁用并展示平台约束。
  function renderItems(state) {
    state.list.replaceChildren();
    if (state.kind === 'collection' || state.kind === 'location' || (state.kind === 'declaration' && !state.required)) {
      const clear = node('button', 'resource-option', state.kind === 'collection' ? '不选择合集' : state.kind === 'location' ? '不添加位置' : '不添加声明');
      clear.type = 'button';
      if (state.kind === 'collection') {
        clear.classList.add('collection-none'); clear.setAttribute('aria-selected', String(!current().collection));
        clear.replaceChildren(node('span', 'collection-check', current().collection ? '' : '✓'), node('span', 'resource-option-label', '不选择合集'));
      }
      clear.onclick = () => select(state.kind, {id: ''}); state.list.append(clear);
    }
    for (const item of topicCandidates(state)) {
      const button = node('button', 'resource-option'); button.type = 'button';
      button.setAttribute('role', 'option'); button.disabled = !!item.disabled;
      const selected = state.kind === 'declaration' ? current().settings.declarations.includes(item.id) : ['topics', 'mentions'].includes(state.kind) ? current()[state.kind].some(value => sameResource(state.kind, value, item)) : current()[state.kind]?.id === item.id;
      button.setAttribute('aria-selected', String(selected));
      const label = node('span', 'resource-option-label', (state.kind === 'topics' ? '#  ' : state.kind === 'mentions' ? '@  ' : '') + (item.name || item.label));
      if (item.description && item.description !== item.address && !['topics', 'mentions', 'collection'].includes(state.kind)) label.append(node('small', '', item.description));
      if (item.address) label.append(node('small', '', item.address));
      if (state.kind === 'collection') {
        button.classList.add('collection-option');
        const cover = node('span', 'collection-cover');
        const url = safeURL(item.thumbnailURL);
        if (url) { const image = node('img'); image.src = url; image.alt = ''; image.loading = 'lazy'; cover.append(image); }
        const count = Number.isSafeInteger(item.itemCount) && item.itemCount >= 0 ? `共${item.itemCount}个作品` : '';
        button.append(node('span', 'collection-check', selected ? '✓' : ''), cover, label, node('span', 'collection-count', count));
      } else button.append(label);
      if (state.kind === 'topics') button.append(node('span', 'topic-heat', heat(item.viewCount)));
      else if (selected && state.kind !== 'collection') button.append(node('span', 'resource-selected', '✓'));
      button.onclick = () => select(state.kind, item);
      state.list.append(button);
    }
  }

  // queryOptions 缓存账号内同一合集分页/声明；搜索仅筛选已读页面，换词不重复访问平台。
  async function queryOptions(operation, params, signal) {
    if (!['collections.list', 'declarations.list'].includes(operation)) return request(operation, params, {signal});
    const scope = cacheScope();
    const key = `${scope}:${operation}:${params.cursor ?? 'first'}`;
    let pending = queryCache.get(key);
    if (!pending) {
      // 只读选项请求即使收起下拉也完成缓存；界面通过自身 generation 拒绝迟到展示。
      pending = request(operation, {...params, query: ''}).then(result => {
        if (!Array.isArray(result?.items)) throw Error('结果不完整，请重试。');
        return result;
      });
      queryCache.set(key, pending);
      pending.catch(() => { if (queryCache.get(key) === pending) queryCache.delete(key); });
    }
    const result = await pending;
    const query = String(params.query || '').trim().toLocaleLowerCase();
    return {...result, items: result.items.filter(item => operation === 'declarations.list'
      ? (item.label || item.name || '').trim() !== '内容为转载信息'
      : !query || String(item.name || '').toLocaleLowerCase().includes(query))};
  }

  // load 在固定游标仅保留一个请求，失败保留旧列表和位置，允许原位重试。
  async function load(state, more = false) {
    if (active !== state || state.loading || blocked()) return;
    const key = identity(), generation = ++state.generation;
    state.controller?.abort(); state.controller = new AbortController(); state.loading = true;
    state.failed = false; state.retry.hidden = true; state.more.hidden = true; state.message.textContent = '正在读取…';
    const query = state.input?.value.trim() || '';
    if (!more) { state.query = query; state.cursor = null; state.hasMore = false; state.items = []; renderItems(state); }
    try {
      if (state.kind === 'topics' && !supports(state.operation)) {
        state.message.textContent = state.query ? '当前无法读取在线话题，可直接添加输入的话题。' : '输入话题名称即可添加。';
        return;
      }
      const params = {kind: current().kind, draftId: current().id, query: state.query, cursor: more ? state.cursor : undefined};
      if (state.kind === 'location') {
        if (!cityCode) throw Error('请先选择城市，再搜索具体地点。');
        if (!state.query) { state.message.textContent = '输入地点名称搜索'; return; }
        Object.assign(params, {cityCode, cityName});
      }
      const result = await queryOptions(state.operation, params, state.controller.signal);
      if (active !== state || key !== identity() || state.generation !== generation) return;
      if (!Array.isArray(result.items)) throw Error('结果不完整，请重试。');
      for (const entry of result.items) {
        const item = {...entry, id: String(entry.id ?? ''), name: entry.name || entry.label};
        if (!item.id || !item.name) continue;
        const existing = state.items.findIndex(value => sameResource(state.kind, value, item));
        if (existing < 0) state.items.push(item);
        else if (state.kind === 'topics' && state.items[existing].id === '0' && item.id !== '0') state.items[existing] = item;
      }
      state.cursor = result.nextCursor ?? null;
      state.hasMore = result.hasMore !== false && state.cursor !== null && state.cursor !== '';
      if (state.hasMore && String(state.cursor) === String(params.cursor)) throw Error('列表分页位置未更新，请重新打开后重试。');
      state.required = result.required === true;
      if (state.kind === 'declaration') { declarationItems = state.items; render(); }
      state.message.textContent = result.message || (topicCandidates(state).length ? '' : '没有找到匹配结果');
      renderItems(state);
    } catch (error) {
      if (active !== state || key !== identity() || state.generation !== generation || error.name === 'AbortError') return;
      state.message.textContent = error.message || '读取失败，请重试。';
      state.failed = true; state.retry.hidden = false; state.retry.onclick = () => { void load(state, more); };
    } finally {
      if (active === state && state.generation === generation) {
        state.loading = false; state.more.hidden = !state.hasMore || state.failed;
        // 筛选后的空页仍保留下一游标；首屏不足时继续逐页请求直到填满或结束。
        if (state.hasMore && !state.failed && state.list.scrollHeight <= state.list.clientHeight) queueMicrotask(() => { void load(state, true); });
      }
    }
  }

  // searchChanged 先撤销旧查询，防止慢响应覆盖用户较新的关键词。
  function searchChanged(state) {
    clearTimeout(timer); state.controller?.abort(); state.generation++; state.loading = false;
    // 新关键词立即废弃旧分页，避免防抖期间旧续页抢先占用 loading。
    state.hasMore = false; state.cursor = null; state.more.hidden = true; state.retry.hidden = true;
    if (state.kind === 'topics') { state.query = state.input.value.trim(); state.items = []; renderItems(state); }
    timer = setTimeout(() => { void load(state); }, 250);
  }

  // open 创建贴近字段的搜索下拉，不把合集选择变成独立弹窗。
  function open(kind, query = '') {
    const operations = {collection: 'collections.list', declaration: 'declarations.list', location: 'locations.search', topics: 'topics.search', mentions: 'users.search'};
    if (blocked() || (kind !== 'topics' && !supports(operations[kind]))) return;
    close();
    const associations = kind === 'topics' || kind === 'mentions';
    const container = associations ? $('association-results') : $(kind + '-popover');
    container.replaceChildren(); container.hidden = false;
    const state = {kind, operation: operations[kind], container, items: [], generation: 0, loading: false, cursor: null, hasMore: false};
    active = state;
    if (!associations && kind !== 'declaration') {
      state.input = node('input', 'resource-search'); state.input.type = 'search'; state.input.autocomplete = 'off';
      state.input.placeholder = kind === 'collection' ? '搜索合集' : '输入地点名称'; state.input.setAttribute('aria-label', state.input.placeholder);
      state.input.value = query; state.input.oninput = () => searchChanged(state); container.append(state.input);
    } else state.input = {value: query};
    state.list = node('div', 'resource-options'); state.list.setAttribute('role', 'listbox');
    state.message = node('p', 'resource-message'); state.message.setAttribute('role', 'status');
    state.retry = node('button', 'resource-retry', '重试'); state.retry.hidden = true;
    state.more = node('button', 'resource-more', '加载更多'); state.more.hidden = true; state.more.onclick = () => { void load(state, true); };
    container.append(state.list, state.message, state.retry, state.more);
    // 用剩余距离提前加载下一页；错误后等显式重试，避免滚动触发重试风暴。
    state.list.onscroll = () => {
      const list = state.list;
      if (state.hasMore && !state.failed && list.scrollHeight - list.scrollTop - list.clientHeight < list.clientHeight) void load(state, true);
    };
    if (!associations) { $('search-' + kind).setAttribute('aria-expanded', 'true'); state.input.focus?.(); }
    void load(state);
  }

  // tokenAtCaret 识别当前正在输入的 # 或 @ 片段，选项只替换该片段。
  function tokenAtCaret() {
    if (description.selectionStart !== description.selectionEnd) return null;
    const caret = description.selectionStart;
    const before = description.value.slice(0, caret);
    const match = /(?:^|[\s])([#@])([^\s#@]*)$/u.exec(before);
    if (!match) return null;
    const tail = description.value.slice(caret).match(/^[^\s#@]*/u)?.[0] || '';
    return {kind: match[1] === '#' ? 'topics' : 'mentions', start: caret - match[2].length - 1, end: caret + tail.length, query: match[2]};
  }

  // suggest 跟随正文光标请求联想；普通输入不会打开空白浮层。
  function suggest() {
    const token = tokenAtCaret(); associationRange = token;
    if (!token) { if (['topics', 'mentions'].includes(active?.kind)) close(); return; }
    if (active?.kind === token.kind) { active.input.value = token.query; searchChanged(active); }
    else open(token.kind, token.query);
  }

  // insertMarker 把新增话题/好友锚定到当前正文光标，与抖音输入交互一致。
  function insertMarker(kind) {
    if (blocked()) return;
    description.focus();
    const old = tokenAtCaret();
    if (old?.kind === kind) { suggest(); return; }
    const start = description.selectionStart, end = description.selectionEnd;
    const prefix = (start > 0 && !/\s/.test(description.value[start - 1]) ? ' ' : '') + (kind === 'topics' ? '#' : '@');
    const next = description.value.slice(0, start) + prefix + description.value.slice(end);
    if (next.length > description.maxLength) return;
    current().description = description.value = next;
    description.setSelectionRange(start + prefix.length, start + prefix.length); changed(); suggest();
  }

  // recommendations 按用户聚焦动作读取一次当前素材推荐；上传前不伪造推荐词。
  async function recommendations() {
    const key = identity() + ':' + current().assets.map(asset => asset.id).join(',');
    if (!supports('topics.search') || recommendationKey === key) return;
    recommendationKey = key; recommendationController?.abort(); recommendationController = new AbortController();
    try {
      const result = await request('topics.search', {query: '', kind: current().kind, draftId: current().id}, {signal: recommendationController.signal});
      if (recommendationKey !== key || !key.startsWith(identity() + ':')) return;
      recommendationItems = Array.isArray(result.items) ? result.items : []; drawRecommendations();
    } catch { if (recommendationKey === key) recommendationKey = ''; }
  }

  // drawRecommendations 首行展示六项，其余经展开可选，推荐来源仅为平台响应。
  function drawRecommendations(expanded = false) {
    const list = $('topic-recommendations'); list.replaceChildren(); list.hidden = !recommendationItems.length;
    if (!recommendationItems.length) return;
    list.append(node('span', '', '推荐'));
    for (const item of recommendationItems.slice(0, expanded ? undefined : 6)) {
      const button = node('button', '', '#' + item.name);
      button.onclick = () => { associationRange = null; select('topics', item); };
      list.append(button);
    }
    if (!expanded && recommendationItems.length > 6) { const more = node('button', '', '+' + (recommendationItems.length - 6)); more.onclick = () => drawRecommendations(true); list.append(more); }
  }

  // render 恢复字段文案；切换账号/草稿会使候选与在途请求失效。
  function render() {
    if (cacheScope() !== cachedScope) { queryCache.clear(); cachedScope = cacheScope(); declarationItems = []; }
    if (identity() !== contextKey) {
      close(); recommendationController?.abort(); recommendationKey = ''; recommendationItems = []; associationRange = null;
      contextKey = identity(); cityCode = current().location?.cityCode || ''; cityName = current().location?.cityName || ''; drawRecommendations();
    }
    $('collection-name').textContent = current().collection?.name || '不选择合集';
    $('location-name').textContent = current().location?.name || '输入相关位置';
    cityCode = current().location?.cityCode || cityCode;
    cityName = current().location?.cityName || cityName;
    cityPicker?.render(cityCode);
    const selected = current().settings.declarations;
    $('declaration-name').textContent = selected.length ? selected.map(id => declarationItems.find(item => item.id === id)?.label || '已选声明（点击核对）').join('、') : '请选择自主声明';
    for (const [kind, operation] of Object.entries({collection: 'collections.list', declaration: 'declarations.list', location: 'locations.search'})) $('search-' + kind).disabled = blocked() || !supports(operation);
    for (const [kind, button] of clearButtons) { button.hidden = !current()[kind]; button.disabled = blocked(); }
  }

  for (const kind of ['collection', 'declaration', 'location']) $('search-' + kind).onclick = () => active?.kind === kind ? close() : open(kind);
  $('search-topics').onclick = () => insertMarker('topics'); $('search-mentions').onclick = () => insertMarker('mentions');
  // synchronizeDescription 供输入与 AI 整段替换共用，删除标记后同步解除真实资源关联。
  function synchronizeDescription(text = description.value) {
    description.setCustomValidity('');
    for (const [kind, prefix] of [['topics', '#'], ['mentions', '@']]) {
      current()[kind] = current()[kind].filter(item => tokenIndex(text, prefix + item.name) >= 0);
    }
    // 活动使用同一可见话题作为发布关联，删除正文标记后不能留下隐式参加状态。
    current().activities = (current().activities || []).filter(item => tokenIndex(text, '#' + item.topic.name) >= 0);
  }
  description.addEventListener('input', () => { synchronizeDescription(); suggest(); });
  description.addEventListener('click', suggest);
  description.addEventListener('focus', () => { void recommendations(); });
  description.addEventListener('keydown', event => {
    if (event.key === 'Escape') close();
    if (event.key === 'ArrowDown' && ['topics', 'mentions'].includes(active?.kind)) { const first = active.list.querySelector('button:not(:disabled)'); if (first) { event.preventDefault(); first.focus(); } }
  });
  document.addEventListener('pointerdown', event => {
    if (active && !active.container.contains(event.target) && !event.target.closest('.resource-anchor, .description-editor, #topic-recommendations, #city-popover')) close();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  cityPicker = mountCityPicker({button: $('location-city'), popover: $('city-popover'), onOpen: close,
    onSelect: city => {
      if (blocked()) return;
      cityCode = city.code; cityName = city.name;
      if (current().location?.cityCode !== cityCode) current().location = null;
      close(); changed(); if (cityCode) open('location');
    }});
  return {render, close, synchronizeDescription, invalidateRecommendations: () => { recommendationKey = ''; }};
}
