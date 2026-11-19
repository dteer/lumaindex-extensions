import {mountSettingHelp} from './studio-help.js';

function node(tag, className = '', text) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

// 热点按官网的词语字符串关联，不写入正文话题，也不因选择额外查询账号。
export function mountHotspot({container, current, identity, supports, blocked, request, changed}) {
  const listeners = new AbortController();
  let context = identity(), active = false, generation = 0, timer, controller, disposed = false;
  const label = node('span', 'hotspot-label', '关联热点');
  const question = node('button', '', '?'); question.setAttribute('aria-label', '关联热点说明'); label.append(question);
  const help = mountSettingHelp(question, {id: 'hotspot-help-description', text: '选择与作品内容相关的热点词，申请关联该热点。是否关联生效由平台判断，与热点不相关的作品不会生效。'});
  const anchor = node('div', 'resource-anchor');
  const field = node('div', 'resource-field-control');
  const button = node('button', 'resource-select field-action'); button.type = 'button';
  button.setAttribute('aria-label', '关联热点'); button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
  const selected = node('span'); button.append(selected);
  const clear = node('button', 'resource-clear', '×'); clear.type = 'button'; clear.setAttribute('aria-label', '清除关联热点');
  field.append(button, clear);
  const popup = node('div', 'resource-popover hotspot-popover'); popup.hidden = true;
  const input = node('input', 'resource-search'); input.type = 'search'; input.maxLength = 500;
  input.placeholder = '输入热点词搜索'; input.setAttribute('aria-label', '搜索热点词');
  const list = node('div', 'resource-options'); list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', '热点候选');
  const message = node('p', 'resource-message'); message.setAttribute('role', 'status');
  const retry = node('button', 'resource-retry', '重试'); retry.type = 'button'; retry.hidden = true;
  popup.append(input, list, message, retry); anchor.append(field, popup); container.replaceChildren(label, anchor);
  container.classList.add('resource-row', 'hotspot-field-row');

  function close() {
    active = false; generation++; clearTimeout(timer); controller?.abort(); controller = null;
    popup.hidden = true; button.setAttribute('aria-expanded', 'false');
  }
  function owns(version, key) { return !disposed && active && generation === version && identity() === key; }
  function choose(name, key) {
    if (blocked() || identity() !== key) return;
    current().hotspot = name; close(); changed(); render(); button.focus();
  }
  function draw(items, key) {
    list.replaceChildren();
    for (const item of items) {
      if (typeof item.name !== 'string' || !item.name) continue;
      const option = node('button', 'resource-option'); option.type = 'button'; option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(current().hotspot === item.name));
      option.append(node('span', 'resource-option-label', item.name));
      if (typeof item.heat === 'number' && Number.isFinite(item.heat) && item.heat >= 0) {
        const heat = item.heat >= 1e8 ? `${Number((item.heat / 1e8).toFixed(1))}亿` : item.heat >= 1e4 ? `${Number((item.heat / 1e4).toFixed(1))}万` : String(item.heat);
        option.append(node('span', 'hotspot-heat', `${heat} 在看`));
      }
      option.onclick = () => choose(item.name, key); list.append(option);
    }
  }
  async function load() {
    if (!active || disposed || blocked()) return;
    const version = ++generation, key = identity(); controller?.abort(); controller = new AbortController();
    retry.hidden = true; list.replaceChildren(); message.textContent = '正在读取…';
    try {
      const result = await request('hotspots.search', {query: input.value.trim(), kind: current().kind, draftId: current().id}, {signal: controller.signal});
      if (!owns(version, key)) return;
      if (!Array.isArray(result?.items)) throw Error('热点列表读取失败，请重试。');
      draw(result.items, key);
      message.textContent = result.message || (result.items.length ? '' : input.value.trim() ? '未找到相关热点，请换一个词搜索。' : '输入热点词搜索');
    } catch (error) {
      if (!owns(version, key) || error.name === 'AbortError') return;
      message.textContent = error.message || '热点读取失败，请重试。'; retry.hidden = false;
    }
  }
  function render() {
    if (disposed) return;
    if (context !== identity()) { close(); context = identity(); }
    if (blocked() && active) close();
    selected.textContent = current().hotspot || '点击输入热点词';
    button.disabled = blocked() || !supports('hotspots.search');
    clear.hidden = !current().hotspot; clear.disabled = blocked();
  }
  function listen(target, type, handler) { target.addEventListener(type, handler, {signal: listeners.signal}); }
  listen(button, 'click', () => {
    if (active) { close(); return; }
    if (blocked() || !supports('hotspots.search')) return;
    active = true; input.value = ''; popup.hidden = false; button.setAttribute('aria-expanded', 'true'); input.focus(); void load();
  });
  listen(clear, 'click', () => choose('', identity()));
  listen(input, 'input', () => {
    clearTimeout(timer); controller?.abort(); generation++;
    list.replaceChildren(); retry.hidden = true; message.textContent = '正在搜索…';
    timer = setTimeout(() => { void load(); }, 250);
  });
  listen(retry, 'click', () => { void load(); });
  listen(popup, 'keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const options = [...list.querySelectorAll('button')]; if (!options.length) return;
    const index = options.indexOf(document.activeElement);
    const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    event.preventDefault(); options[next].focus();
  });
  listen(document, 'pointerdown', event => { if (active && !container.contains(event.target)) close(); });
  listen(document, 'keydown', event => { if (active && event.key === 'Escape') { event.preventDefault(); close(); button.focus(); } });
  return {render, close, dispose() { if (disposed) return; close(); disposed = true; listeners.abort(); help.destroy(); container.replaceChildren(); }};
}
