// 设置说明随悬停或键盘聚焦显示；不读取或修改草稿，也不调用宿主或网络。
let nextHelpID = 0;

// mountSettingHelp 兼容原来的 span；返回真实按钮和销毁入口，便于页面初始化与卸载。
export function mountSettingHelp(trigger, {text, id} = {}) {
  const document = trigger.ownerDocument, window = document.defaultView;
  let button = trigger;
  if (trigger.tagName !== 'BUTTON') {
    button = document.createElement('button');
    button.className = trigger.className;
    if (trigger.id) button.id = trigger.id;
    button.textContent = trigger.textContent || '?';
    for (const name of ['aria-label', 'aria-describedby']) if (trigger.hasAttribute(name)) button.setAttribute(name, trigger.getAttribute(name));
    trigger.replaceWith(button);
  }
  button.type = 'button';
  button.classList.add('setting-help');
  button.removeAttribute('title');
  if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', '设置说明');
  const tooltip = document.createElement('div');
  tooltip.id = id || `setting-help-${++nextHelpID}`;
  tooltip.className = 'setting-help-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.textContent = String(text || '');
  tooltip.hidden = true;
  document.body.append(tooltip);
  const previousDescription = button.getAttribute('aria-describedby');
  button.setAttribute('aria-describedby', [previousDescription, tooltip.id].filter(Boolean).join(' '));
  const listeners = new AbortController();
  let pointer = null;

  // 先测量浮层，再约束到视口内；固定定位不改变设置行和选项的位置。
  function show() {
    tooltip.style.visibility = 'hidden';
    tooltip.hidden = false;
    const anchor = button.getBoundingClientRect(), bounds = tooltip.getBoundingClientRect();
    const margin = 12, gap = 8;
    const left = Math.max(margin, Math.min(anchor.left + anchor.width / 2 - bounds.width / 2, window.innerWidth - bounds.width - margin));
    const preferredTop = anchor.bottom + gap + bounds.height <= window.innerHeight - margin ? anchor.bottom + gap : anchor.top - gap - bounds.height;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(margin, Math.min(preferredTop, window.innerHeight - bounds.height - margin))}px`;
    tooltip.style.visibility = '';
  }

  // 离开问号或页面立即关闭；触摸释放前清状态，避免 lostpointercapture 重入。
  function close() {
    const released = pointer;
    pointer = null;
    tooltip.hidden = true;
    if (released !== null && button.hasPointerCapture?.(released)) button.releasePointerCapture(released);
  }

  // 所有监听同生命周期移除，避免反复挂载积累页面级事件。
  function listen(target, type, handler, capture = false) { target.addEventListener(type, handler, {capture, signal: listeners.signal}); }
  listen(button, 'pointerenter', event => { if (event.pointerType !== 'touch') show(); });
  listen(button, 'pointerleave', event => { if (event.pointerType !== 'touch') close(); });
  listen(button, 'focus', show);
  listen(button, 'pointerdown', event => {
    if (event.pointerType !== 'touch' || event.button !== 0 || event.isPrimary === false || pointer !== null) return;
    event.preventDefault(); // 触摸松开后不通过兼容鼠标事件重新聚焦并留下浮层。
    pointer = event.pointerId;
    button.setPointerCapture?.(pointer);
    show();
  });
  for (const type of ['pointerup', 'pointercancel']) listen(window, type, event => { if (event.pointerId === pointer) close(); }, true);
  listen(button, 'lostpointercapture', close);
  listen(button, 'keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if ([' ', 'Enter'].includes(event.key)) event.preventDefault();
  });
  listen(button, 'click', event => { event.preventDefault(); event.stopPropagation(); });
  listen(button, 'contextmenu', event => event.preventDefault());
  for (const [target, type, capture] of [[button, 'blur'], [window, 'blur'], [window, 'scroll', true], [window, 'resize'], [window, 'pagehide']]) listen(target, type, close, capture);
  listen(document, 'visibilitychange', () => { if (document.hidden) close(); });

  // destroy 不恢复旧 span；保留语义按钮，移除本次描述与全局监听。
  function destroy() {
    close(); listeners.abort(); tooltip.remove();
    if (previousDescription === null) button.removeAttribute('aria-describedby');
    else button.setAttribute('aria-describedby', previousDescription);
  }
  return {button, close, destroy};
}
