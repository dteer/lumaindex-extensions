/** 创建仅供视觉背景使用的镜像节点，不参与正文输入或无障碍阅读。 */
function node(className) {
  const result = document.createElement('div');
  result.className = className;
  return result;
}

/** 返回边界前的完整 Unicode 码点，避免把代理对的半个字符误认为分隔符。 */
function previousCharacter(text, index) {
  if (!index) return '';
  const last = text.charCodeAt(index - 1);
  return last >= 0xdc00 && last <= 0xdfff && index > 1 ? text.slice(index - 2, index) : text[index - 1];
}

/** 词边界允许空白和标点；组合音标、连接符及 emoji 修饰符仍属于同一字符。 */
function boundary(character) {
  return !character || !/[\p{L}\p{N}\p{M}\p{Emoji_Modifier}_#@\u200c\u200d]/u.test(character);
}

/** 查找已选择实体的完整 token，同名身份合并显示，重叠时保留最长的完整实体。 */
function selectedRanges(text, entities) {
  const candidates = new Map();
  for (const entity of Array.isArray(entities) ? entities : []) {
    if (!['topic', 'mention'].includes(entity?.kind) || !entity.id || typeof entity.name !== 'string' || !entity.name || /[\r\n]/u.test(entity.name)) continue;
    const token = (entity.kind === 'topic' ? '#' : '@') + entity.name;
    if (!candidates.has(token)) candidates.set(token, {token, kind: entity.kind, id: String(entity.id)});
  }
  // 分词只用于避免高亮截断组合字符/emoji；绝不归一化或修改用户正文。
  const graphemes = new Set([text.length]);
  for (const part of new Intl.Segmenter(undefined, {granularity: 'grapheme'}).segment(text)) graphemes.add(part.index);
  const ranges = [];
  for (const entity of candidates.values()) {
    let start = text.indexOf(entity.token);
    while (start >= 0) {
      const end = start + entity.token.length;
      const after = end < text.length ? String.fromCodePoint(text.codePointAt(end)) : '';
      if (graphemes.has(start) && graphemes.has(end) && boundary(previousCharacter(text, start)) && boundary(after)) ranges.push({...entity, start, end});
      start = text.indexOf(entity.token, start + entity.token.length);
    }
  }
  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  let end = -1;
  return ranges.filter(range => { if (range.start < end) return false; end = range.end; return true; });
}

/** 记录输入框的交互位置，仅用于包装/卸载发生 DOM 移动时恢复原生状态。 */
function inputState(textarea) {
  return {focused: document.activeElement === textarea, start: textarea.selectionStart, end: textarea.selectionEnd, direction: textarea.selectionDirection, top: textarea.scrollTop, left: textarea.scrollLeft};
}

/** DOM 包装后恢复原选区与滚动，不写入正文，也不派发输入事件。 */
function restoreInputState(textarea, state) {
  if (state.focused) textarea.focus({preventScroll: true});
  textarea.setSelectionRange(state.start, state.end, state.direction);
  textarea.scrollTop = state.top; textarea.scrollLeft = state.left;
}

/** 为原生 textarea 添加实体背景镜像；原生控件继续负责文字、光标、输入法、选区和无障碍。 */
export function mountDescriptionHighlight(textarea, {getEntities = () => []} = {}) {
  const originalParent = textarea.parentNode;
  const initialInputState = inputState(textarea);
  const wrapper = node('studio-description-highlight');
  const viewport = node('studio-description-highlight-viewport');
  const content = node('studio-description-highlight-content');
  const listeners = new AbortController();
  let disposed = false, queued = false, signature = '';
  const background = getComputedStyle(textarea).backgroundColor;
  wrapper.style.backgroundColor = background;
  viewport.setAttribute('aria-hidden', 'true');
  viewport.inert = true;
  viewport.append(content);
  originalParent.insertBefore(wrapper, textarea);
  wrapper.append(viewport, textarea);
  textarea.classList.add('studio-description-highlight-input');
  restoreInputState(textarea, initialInputState);

  /** 复制影响原生折行的实际排版参数，排除滚动条后用相同内容宽度绘制背景。 */
  function syncMetrics() {
    if (disposed) return;
    const style = getComputedStyle(textarea);
    for (const property of ['font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant', 'font-kerning', 'font-feature-settings', 'font-variation-settings', 'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-indent', 'text-transform', 'direction', 'unicode-bidi', 'tab-size', 'word-break', 'overflow-wrap', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left']) content.style.setProperty(property, style.getPropertyValue(property));
    content.style.whiteSpace = textarea.wrap === 'off' ? 'pre' : 'pre-wrap';
    viewport.style.left = textarea.offsetLeft + textarea.clientLeft + 'px';
    viewport.style.top = textarea.offsetTop + textarea.clientTop + 'px';
    viewport.style.width = textarea.clientWidth + 'px';
    viewport.style.height = textarea.clientHeight + 'px';
    content.style.width = textarea.clientWidth + 'px';
    content.style.minHeight = textarea.clientHeight + 'px';
    syncScroll();
  }

  /** 同步原生滚动偏移，不反向写入 textarea 的滚动、选区或当前输入值。 */
  function syncScroll() {
    if (!disposed) content.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
  }

  /** 更新完整实体背景；只读 value 和选择身份，既不触发 input 也不修改正文字符数。 */
  function render() {
    if (disposed) return;
    const value = textarea.value;
    const ranges = selectedRanges(value, getEntities());
    const nextSignature = JSON.stringify([value, ranges]);
    if (signature !== nextSignature) {
      signature = nextSignature;
      const fragment = document.createDocumentFragment();
      let cursor = 0;
      for (const range of ranges) {
        fragment.append(document.createTextNode(value.slice(cursor, range.start)));
        const mark = document.createElement('mark');
        mark.className = 'studio-description-entity';
        mark.dataset.kind = range.kind; mark.dataset.entityId = range.id;
        mark.textContent = value.slice(range.start, range.end);
        fragment.append(mark); cursor = range.end;
      }
      fragment.append(document.createTextNode(value.slice(cursor)));
      // 零宽末尾占位只存在于 aria-hidden 镜像，保留原生末尾换行的空行高度。
      const tail = document.createElement('span'); tail.className = 'studio-description-highlight-tail'; tail.textContent = '\u200b';
      fragment.append(tail); content.replaceChildren(fragment);
    }
    syncMetrics();
  }

  /** 等当前 input 监听完成实体关联更新后刷新一次，不干扰中文输入法合成事件。 */
  function queueRender() {
    if (queued || disposed) return;
    queued = true;
    queueMicrotask(() => { queued = false; render(); });
  }

  textarea.addEventListener('input', queueRender, {signal: listeners.signal});
  textarea.addEventListener('compositionend', queueRender, {signal: listeners.signal});
  textarea.addEventListener('scroll', syncScroll, {signal: listeners.signal, passive: true});
  window.addEventListener('resize', syncMetrics, {signal: listeners.signal});
  const resize = new ResizeObserver(syncMetrics);
  resize.observe(textarea); resize.observe(wrapper);
  const attributes = new MutationObserver(queueRender);
  attributes.observe(textarea, {attributes: true, attributeFilter: ['class', 'style', 'wrap', 'rows', 'cols', 'dir']});
  document.fonts?.addEventListener('loadingdone', syncMetrics, {signal: listeners.signal});
  render();

  return {
    render,
    /** 移除镜像和监听，把原生输入框放回原位置；文字、选区和输入框属性均保持原样。 */
    dispose() {
      if (disposed) return;
      const finalInputState = inputState(textarea);
      disposed = true; listeners.abort(); resize.disconnect(); attributes.disconnect();
      textarea.classList.remove('studio-description-highlight-input');
      if (wrapper.parentNode) wrapper.parentNode.insertBefore(textarea, wrapper);
      wrapper.remove();
      restoreInputState(textarea, finalInputState);
    },
  };
}
