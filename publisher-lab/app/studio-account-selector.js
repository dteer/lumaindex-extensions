// mountAccountSelector 用网页列表展示已有 select 状态；账号切换仍交给原 change 处理器。
export function mountAccountSelector(select, {menu = select.closest('details')} = {}) {
  const document = select.ownerDocument, listeners = new AbortController();
  const wrapper = document.createElement('div'); wrapper.className = 'account-selector';
  const button = document.createElement('button'); button.type = 'button'; button.id = select.id + '-button'; button.className = 'account-selector-button';
  button.setAttribute('role', 'combobox'); button.setAttribute('aria-label', select.getAttribute('aria-label') || '切换账号');
  button.setAttribute('aria-haspopup', 'listbox'); button.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span'); label.className = 'account-selector-value';
  const chevron = document.createElement('span'); chevron.className = 'account-selector-chevron'; chevron.setAttribute('aria-hidden', 'true');
  button.append(label, chevron);
  const list = document.createElement('div'); list.id = select.id + '-listbox'; list.className = 'account-selector-list';
  list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', '已登录账号'); list.hidden = true;
  button.setAttribute('aria-controls', list.id);
  select.hidden = true; select.tabIndex = -1; select.setAttribute('aria-hidden', 'true');
  select.after(wrapper); wrapper.append(button, list);
  let options = [], activeIndex = -1, signature = '';

  // close 只收起候选；Escape 和确认返回账号框，外部点击/Tab 保留目标焦点。
  function close({focus = false} = {}) {
    list.hidden = true; button.setAttribute('aria-expanded', 'false'); button.removeAttribute('aria-activedescendant');
    if (focus && !button.disabled) button.focus();
  }

  // activate 维护键盘当前项，与已选账号的勾号分开，不在移动时切换会话。
  function activate(index, scroll = true) {
    activeIndex = index;
    for (const [position, option] of options.entries()) option.node.classList.toggle('is-active', position === index);
    const active = options[index];
    if (active && !list.hidden) {
      button.setAttribute('aria-activedescendant', active.node.id);
      if (scroll) active.node.scrollIntoView({block: 'nearest'});
    } else button.removeAttribute('aria-activedescendant');
  }

  // choose 仅对不同的有效档案发送原 change 事件，不附加身份请求或改变隔离规则。
  function choose(index) {
    const option = options[index];
    if (button.disabled || !option || option.disabled) return;
    const changed = select.value !== option.value;
    close({focus: true});
    if (!changed) return;
    select.value = option.value; render();
    select.dispatchEvent(new Event('change', {bubbles: true}));
  }

  // render 从原 select 同步名称、选中项和禁用状态，普通页面重绘不重置键盘当前项。
  function render() {
    button.disabled = select.disabled;
    const selected = select.selectedOptions[0];
    label.textContent = selected?.textContent || select.options[0]?.textContent || '暂无已登录账号';
    button.title = label.textContent;
    const values = [...select.options].filter(option => option.value).map(option => ({value: option.value, label: option.textContent, disabled: option.disabled}));
    const nextSignature = JSON.stringify(values);
    if (nextSignature !== signature) {
      const activeValue = options[activeIndex]?.value;
      signature = nextSignature; list.replaceChildren();
      options = values.map((option, index) => {
        const node = document.createElement('div'); node.id = list.id + '-' + index; node.className = 'account-selector-option';
        node.setAttribute('role', 'option'); node.setAttribute('aria-disabled', String(option.disabled)); node.dataset.value = option.value;
        const check = document.createElement('span'); check.className = 'account-selector-check'; check.textContent = '✓'; check.setAttribute('aria-hidden', 'true');
        const name = document.createElement('span'); name.className = 'account-selector-name'; name.textContent = option.label; node.title = option.label;
        node.append(check, name); list.append(node);
        node.addEventListener('pointerdown', event => event.preventDefault());
        node.addEventListener('pointermove', () => { if (!option.disabled) activate(index, false); });
        node.addEventListener('click', () => choose(index));
        return {...option, node};
      });
      activeIndex = options.findIndex(option => option.value === activeValue && !option.disabled);
    }
    for (const option of options) option.node.setAttribute('aria-selected', String(option.value === select.value));
    if (button.disabled || !options.some(option => !option.disabled)) close();
    else if (!list.hidden) activate(activeIndex >= 0 ? activeIndex : options.findIndex(option => option.value === select.value && !option.disabled));
  }

  // open 将候选放在账号框下方，初始焦点跟随当前账号；没有当前项时从首尾开始。
  function open(last = false) {
    render();
    if (button.disabled || !options.some(option => !option.disabled)) return;
    list.hidden = false; button.setAttribute('aria-expanded', 'true');
    const selected = options.findIndex(option => option.value === select.value && !option.disabled);
    activate(selected >= 0 ? selected : last ? options.findLastIndex(option => !option.disabled) : options.findIndex(option => !option.disabled));
  }

  // move 在可用选项之间移动，仅 Enter/空格或点击确认后才提交。
  function move(step) {
    for (let offset = 1; offset <= options.length; offset += 1) {
      const index = (activeIndex + step * offset + options.length) % options.length;
      if (!options[index].disabled) { activate(index); return; }
    }
  }

  // listen 让页面级监听随控件销毁统一移除。
  function listen(target, type, handler) { target?.addEventListener(type, handler, {signal: listeners.signal}); }
  listen(button, 'click', () => list.hidden ? open() : close());
  listen(button, 'keydown', event => {
    if (event.key === 'Escape' && !list.hidden) { event.preventDefault(); event.stopPropagation(); close({focus: true}); return; }
    if (event.key === 'Tab') { close(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (list.hidden) { open(event.key === 'ArrowUp' || event.key === 'End'); return; }
    if (event.key === 'Enter' || event.key === ' ') choose(activeIndex);
    else if (event.key === 'Home') activate(options.findIndex(option => !option.disabled));
    else if (event.key === 'End') activate(options.findLastIndex(option => !option.disabled));
    else move(event.key === 'ArrowDown' ? 1 : -1);
  });
  listen(select, 'change', render);
  listen(document, 'pointerdown', event => { if (!wrapper.contains(event.target)) close(); });
  listen(wrapper, 'focusout', event => { if (!wrapper.contains(event.relatedTarget)) close(); });
  listen(menu, 'toggle', () => { if (!menu.open) close(); });
  render();
  return {render, close, dispose: () => { close(); listeners.abort(); }};
}
