/** 创建城市选择节点，城市名称仅作为文字写入。 */
function node(tag, className = '', text = '') {
  const element = document.createElement(tag);
  element.className = className;
  if (text) element.textContent = text;
  return element;
}

/** 挂载受视口约束的网页城市选择器；城市来源为插件本地静态表，不请求位置权限或平台接口。 */
export function mountCityPicker({button, popover, onSelect, onOpen}) {
  const listeners = new AbortController();
  const identifier = popover.id || `studio-city-${crypto.randomUUID()}`;
  let cities = [], filtered = [], selectedCode = '', highlighted = -1;
  let opened = false, loading = false, failed = false, disposed = false;
  let requestController = null, frame = null;
  const originalParent = popover.parentNode;
  const originalNext = popover.nextSibling;
  popover.id = identifier;
  popover.classList.add('studio-city-popover');
  popover.hidden = true;
  // 门户避免父卡片的 overflow 裁掉候选；固定位置始终相对实际可视窗口计算。
  document.body.append(popover);
  button.classList.add('studio-city-button');
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', identifier);
  const searchWrap = node('div', 'studio-city-search-wrap');
  const search = node('input', 'studio-city-search');
  search.type = 'search'; search.placeholder = '搜索城市'; search.autocomplete = 'off';
  search.setAttribute('aria-label', '搜索城市'); search.setAttribute('role', 'combobox');
  search.setAttribute('aria-autocomplete', 'list'); search.setAttribute('aria-controls', identifier + '-list');
  const list = node('div', 'studio-city-list');
  list.id = identifier + '-list'; list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', '城市');
  const message = node('p', 'studio-city-message'); message.setAttribute('role', 'status');
  const retry = node('button', 'studio-city-retry', '重新读取'); retry.type = 'button'; retry.hidden = true;
  searchWrap.append(search); popover.replaceChildren(searchWrap, list, message, retry);

  /** 回显已保存的城市代码；未知代码不推测名称，等待用户重新选择。 */
  function updateLabel() {
    const selected = cities.find(city => city.code === selectedCode);
    button.textContent = selected?.name || (selectedCode && cities.length ? '重新选择城市' : '选择城市');
    button.title = selected?.name || '';
  }

  /** 将弹层限制在可视窗口内，空间不足时向上展开；极矮窗口允许覆盖按钮以保持搜索可用。 */
  function position() {
    frame = null;
    if (!opened || disposed) return;
    const visual = window.visualViewport;
    const leftEdge = visual?.offsetLeft || 0, topEdge = visual?.offsetTop || 0;
    const viewportWidth = visual?.width || window.innerWidth;
    const viewportHeight = visual?.height || window.innerHeight;
    const inset = 8, gap = 6;
    const bounds = button.getBoundingClientRect();
    const width = Math.max(0, Math.min(232, viewportWidth - inset * 2));
    const below = topEdge + viewportHeight - bounds.bottom - gap - inset;
    const above = bounds.top - topEdge - gap - inset;
    const upward = below < 220 && above > below;
    let available = Math.max(0, upward ? above : below);
    const overlay = available < 110;
    if (overlay) available = Math.max(0, viewportHeight - inset * 2);
    popover.style.width = width + 'px';
    popover.style.maxHeight = Math.min(280, available) + 'px';
    popover.style.left = Math.max(leftEdge + inset, Math.min(bounds.left, leftEdge + viewportWidth - width - inset)) + 'px';
    // 先应用高度约束再测量，空结果、加载失败与完整列表均按实际高度定位。
    const height = popover.getBoundingClientRect().height;
    const top = overlay ? topEdge + inset : upward ? bounds.top - gap - height : bounds.bottom + gap;
    popover.style.top = Math.max(topEdge + inset, Math.min(top, topEdge + viewportHeight - height - inset)) + 'px';
    popover.dataset.direction = upward ? 'up' : 'down';
  }

  /** 合并滚动与窗口变化的布局请求，不在每条滚动事件中同步强制重排。 */
  function schedulePosition() {
    if (opened && frame === null) frame = requestAnimationFrame(position);
  }

  /** 同步光标候选和 aria-activedescendant，同时滚动内部列表而不移动主页面。 */
  function highlight(index, reveal = false) {
    highlighted = filtered.length ? Math.max(0, Math.min(filtered.length - 1, index)) : -1;
    for (let position = 0; position < list.children.length; position++) list.children[position].classList.toggle('is-highlighted', position === highlighted);
    const option = list.children[highlighted];
    if (!option) { search.removeAttribute('aria-activedescendant'); return; }
    search.setAttribute('aria-activedescendant', option.id);
    if (reveal) {
      const top = option.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + option.offsetHeight - list.clientHeight;
    }
  }

  /** 关闭弹层并取消布局工作；外部 close 不抢回用户已经转移的焦点。 */
  function close(restoreFocus = false) {
    opened = false; popover.hidden = true;
    button.setAttribute('aria-expanded', 'false'); search.setAttribute('aria-expanded', 'false');
    if (frame !== null) { cancelAnimationFrame(frame); frame = null; }
    if (restoreFocus && button.isConnected) button.focus({preventScroll: true});
  }

  /** 只在用户确认候选时回调，回显与重新载入静态表不会改变宿主选中的地点。 */
  function select(city) {
    if (disposed || button.disabled || !city) return;
    selectedCode = city.code; updateLabel(); close(true);
    onSelect?.({code: city.code, name: city.name});
  }

  /** 按城市文字或代码筛选现有静态表，保持原表顺序，不构造省份层级。 */
  function draw() {
    const query = search.value.normalize('NFKC').trim().toLocaleLowerCase();
    filtered = cities.filter(city => !query || city.name.toLocaleLowerCase().includes(query) || city.code.includes(query));
    list.replaceChildren();
    for (const city of filtered) {
      const option = node('button', 'studio-city-option', city.name);
      option.type = 'button'; option.tabIndex = -1; option.id = identifier + '-option-' + city.code;
      option.setAttribute('role', 'option'); option.setAttribute('aria-selected', String(city.code === selectedCode));
      // 鼠标按下保持组合框焦点，选择后统一由 select 恢复字段焦点。
      option.onpointerdown = event => event.preventDefault();
      option.onclick = () => select(city);
      list.append(option);
    }
    message.textContent = loading ? '正在读取城市…' : failed ? '城市列表读取失败，请重试。' : filtered.length ? '' : '没有找到匹配城市';
    message.hidden = !message.textContent;
    retry.hidden = !failed;
    list.hidden = !filtered.length;
    const selectedIndex = filtered.findIndex(city => city.code === selectedCode);
    highlight(query ? 0 : Math.max(0, selectedIndex));
    if (opened) { position(); highlight(highlighted, true); }
  }

  /** 读取本地城市表；中途卸载或重试使旧响应失效，失败提供原位重试。 */
  async function load() {
    if (loading || disposed) return;
    const restoreSearchFocus = document.activeElement === retry;
    loading = true; failed = false;
    requestController?.abort(); requestController = new AbortController();
    const controller = requestController;
    draw();
    try {
      const response = await fetch(new URL('./cities.json', import.meta.url), {signal: controller.signal});
      if (!response.ok) throw Error('city-data-unavailable');
      const values = await response.json();
      if (!Array.isArray(values)) throw Error('city-data-invalid');
      const seen = new Set();
      const next = values.filter(city => typeof city?.code === 'string' && /^\d{6}$/.test(city.code) && typeof city.name === 'string' && city.name.trim() && city.name.length <= 50 && !seen.has(city.code) && seen.add(city.code)).map(city => ({code: city.code, name: city.name}));
      if (!next.length) throw Error('city-data-empty');
      if (disposed || requestController !== controller) return;
      cities = next; updateLabel();
    } catch (error) {
      if (disposed || requestController !== controller || error.name === 'AbortError') return;
      failed = true;
    } finally {
      if (!disposed && requestController === controller) { loading = false; draw(); if (opened && restoreSearchFocus) search.focus({preventScroll: true}); }
    }
  }

  /** 打开时先关闭宿主其他下拉，再重置搜索并把输入焦点留在网页弹层中。 */
  function open() {
    if (disposed || button.disabled || opened) return;
    onOpen?.();
    opened = true; popover.hidden = false; search.value = '';
    button.setAttribute('aria-expanded', 'true'); search.setAttribute('aria-expanded', 'true');
    draw(); search.focus({preventScroll: true});
  }

  button.addEventListener('click', () => { if (opened) close(); else open(); }, {signal: listeners.signal});
  button.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(); highlight(event.key === 'ArrowUp' ? filtered.length - 1 : Math.max(0, highlighted), true); }
  }, {signal: listeners.signal});
  search.addEventListener('input', draw, {signal: listeners.signal});
  popover.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') {
      // 加载失败时允许从搜索框 Tab 到重试按钮；离开组合框时才收起。
      const withinRetry = !retry.hidden && ((!event.shiftKey && event.target === search) || (event.shiftKey && event.target === retry));
      if (!withinRetry) close(true);
    }
    else if (event.target === search && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const next = highlighted + (event.key === 'ArrowDown' ? 1 : -1);
      highlight(next < 0 ? filtered.length - 1 : next >= filtered.length ? 0 : next, true);
    } else if (event.target === search && event.key === 'Enter') { event.preventDefault(); select(filtered[highlighted]); }
  }, {signal: listeners.signal});
  document.addEventListener('pointerdown', event => { if (opened && !popover.contains(event.target) && !button.contains(event.target)) close(); }, {signal: listeners.signal});
  window.addEventListener('resize', schedulePosition, {signal: listeners.signal});
  window.addEventListener('scroll', schedulePosition, {signal: listeners.signal, capture: true});
  window.visualViewport?.addEventListener('resize', schedulePosition, {signal: listeners.signal});
  window.visualViewport?.addEventListener('scroll', schedulePosition, {signal: listeners.signal});
  retry.onclick = () => { void load(); };
  void load();

  return {
    /** 回显草稿保存的城市代码，不触发 onSelect 或平台地点查询。 */
    render(code = '') {
      if (disposed) return;
      selectedCode = typeof code === 'string' ? code : '';
      updateLabel();
      if (opened) draw();
    },
    close,
    /** 释放静态表请求与全局监听，将外部提供的弹层归还原位置。 */
    dispose() {
      if (disposed) return;
      close(); disposed = true; requestController?.abort(); listeners.abort();
      popover.replaceChildren();
      if (originalParent) originalParent.insertBefore(popover, originalNext?.parentNode === originalParent ? originalNext : null);
      button.removeAttribute('aria-controls'); button.removeAttribute('aria-expanded'); button.removeAttribute('aria-haspopup');
    },
  };
}
