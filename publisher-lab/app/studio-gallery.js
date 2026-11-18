import {createPreviewWheel, createNativePreviewWheel} from './preview-wheel.js';

/** 创建独立图库与手机预览使用的 DOM 节点，动态文案只写入 textContent。 */
function node(tag, className = '', text = '') {
  const result = document.createElement(tag);
  result.className = className;
  if (text) result.textContent = text;
  return result;
}

/** 返回纯展示图标；不把手机预览中的装饰图标伪装成可执行的发布动作。 */
function icon(name) {
  const paths = {
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    previous: '<path d="m15 5-7 7 7 7"/>',
    next: '<path d="m9 5 7 7-7 7"/>',
    search: '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/>',
    heart: '<path fill="currentColor" stroke="none" d="M12 21S1 14.3 1 7.6C1 1.7 8.4-.1 12 5c3.6-5.1 11-3.3 11 2.6C23 14.3 12 21 12 21Z"/>',
    comment: '<path fill="currentColor" stroke="none" d="M12 1C5.4 1 0 5.5 0 11s5.4 10 12 10h1l5 3v-4c3.6-1.7 6-5 6-9C24 5.5 18.6 1 12 1Z"/><g fill="#999" stroke="none"><circle cx="6" cy="11" r="1.5"/><circle cx="12" cy="11" r="1.5"/><circle cx="18" cy="11" r="1.5"/></g>',
    star: '<path fill="currentColor" stroke="none" d="m12 0 3.7 7.8 8.3 1.1-6 6 1.5 8.5L12 19.3l-7.5 4.1L6 15 0 8.9l8.3-1.1Z"/>',
    share: '<path fill="currentColor" stroke="none" d="M14 2v5C4 7 1 13 1 21c3-6 7-8 13-8v5l10-8Z"/>',
    music: '<path d="M10 17V4l9-2v13"/><ellipse cx="6.5" cy="18" rx="3.5" ry="3" fill="currentColor"/><ellipse cx="15.5" cy="16" rx="3.5" ry="3" fill="currentColor"/>',
    images: '<rect x="7" y="3" width="14" height="16" rx="2" fill="currentColor" stroke="none"/><path d="M3 7v13a2 2 0 0 0 2 2h12"/>',
    person: '<circle cx="12" cy="8" r="4" fill="currentColor" stroke="none"/><path fill="currentColor" stroke="none" d="M3 23v-3a9 9 0 0 1 18 0v3Z"/>',
  };
  const result = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  result.setAttribute('viewBox', '0 0 24 24');
  result.setAttribute('fill', 'none');
  result.setAttribute('stroke', 'currentColor');
  result.setAttribute('stroke-width', '1.8');
  result.setAttribute('stroke-linecap', 'round');
  result.setAttribute('stroke-linejoin', 'round');
  result.setAttribute('aria-hidden', 'true');
  // 图形数据全部来自本模块常量；素材名称、文案和 URL 不经过 innerHTML。
  result.innerHTML = paths[name] || '';
  return result;
}

/** 规范化宿主的预览数据；保留顺序，不修改传入的素材或草稿对象。 */
function normalizedAssets(assets) {
  return Array.isArray(assets) ? assets.map(asset => ({
    // id 是图库素材标识，用于跟踪当前查看对象，绝不作为排序依据。
    id: String(asset.id ?? ''),
    // url 由宿主提供图库预览/原片地址，模块不访问平台发布接口。
    url: typeof asset.url === 'string' ? asset.url : '',
    // alt 只用于无障碍说明，不在图片区域显示文件名。
    alt: typeof asset.alt === 'string' ? asset.alt : '',
    // kind 为 video 时使用真实视频控件，其余素材按图片展示。
    kind: asset.kind === 'video' ? 'video' : 'image',
  })) : [];
}

/** 把查看位置限制在现有素材范围内；空列表的位置固定为零。 */
function clampIndex(index, assets) {
  return Math.max(0, Math.min(assets.length - 1, Number.isFinite(index) ? Math.trunc(index) : 0));
}

/** 创建图片或原生视频节点，图片不添加播放按钮或文件名覆盖层。 */
function media(asset, className = '') {
  const result = node(asset.kind === 'video' ? 'video' : 'img', className);
  if (asset.url) result.src = asset.url;
  if (asset.kind === 'video') {
    result.controls = true;
    result.playsInline = true;
    result.preload = 'metadata';
    result.setAttribute('aria-label', asset.alt || '视频预览');
  } else {
    result.alt = asset.alt || '图片预览';
    result.draggable = false;
  }
  return result;
}

/** 在替换或卸载媒体前终止视频播放，避免关闭预览后仍保留音轨。 */
function clearMedia(container) {
  for (const video of container.querySelectorAll('video')) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  container.replaceChildren();
}

/** 固定图片轨道只移动父层，预载当前与相邻图片；视频继续保留真正的原生播放状态。 */
function createMediaViewport(surface) {
  let assets = [], index = 0, signature = '', track = null, animation = null, position = 0;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  /** 连续输入从当前呈现位置接续，避免中断前一动画时先跳回旧页。 */
  function move(next, animated = true) {
    if (!track) return;
    const from = getComputedStyle(track).transform;
    animation?.cancel(); animation = null; position = next;
    const transform = `translate3d(${-next * 100}%,0,0)`;
    track.style.transform = transform;
    if (animated && !reducedMotion.matches) {
      const running = track.animate([{transform: from === 'none' ? 'translate3d(0,0,0)' : from}, {transform}],
        {duration: 360, easing: 'cubic-bezier(.2,.75,.25,1)'});
      animation = running;
      running.onfinish = () => { if (animation === running) animation = null; };
    }
  }

  /** 结束轨道与媒体资源，旧动画不能影响下一批素材。 */
  function clear() {
    animation?.cancel(); animation = null; track = null; signature = ''; position = 0;
    clearMedia(surface);
  }

  const resize = new ResizeObserver(() => { if (track) move(index, false); }); resize.observe(surface);
  return {
    /** 同一素材集合保留轨道及相邻节点，宿主回显同一索引不重启动画或视频。 */
    render(nextAssets, nextIndex) {
      const changedIndex = index !== nextIndex;
      assets = nextAssets; index = nextIndex;
      const asset = assets[index], images = assets.length > 0 && assets.every(value => value.kind === 'image');
      const key = images ? JSON.stringify(assets.map(value => [value.id, value.url, value.alt])) : JSON.stringify(asset ? [asset.id, asset.url, asset.kind] : []);
      const changedAssets = signature !== key;
      if (changedAssets) {
        clear(); signature = key;
        if (images) {
          track = node('div', 'studio-preview-track');
          for (const value of assets) {
            const slide = node('div', 'studio-preview-slide'); slide.setAttribute('aria-label', value.alt || '图片预览'); track.append(slide);
          }
          surface.append(track); move(index, false);
        } else if (asset) surface.append(media(asset));
      }
      if (!track) return;
      for (const [slideIndex, value] of assets.entries()) {
        const slide = track.children[slideIndex];
        slide.setAttribute('aria-hidden', String(slideIndex !== index));
        slide.classList.toggle('is-current', slideIndex === index);
        if (Math.abs(slideIndex - index) <= 1) {
          if (!slide.childNodes.length) { const image = media(value); image.decoding = 'async'; slide.append(image); }
        } else slide.replaceChildren();
      }
      if (!changedAssets && changedIndex) move(index);
    },
    /** 指针拖拽跟随手指，在首尾约束轨道，不露出未定义的相邻页。 */
    drag(pixels) {
      if (!track || !surface.clientWidth) return;
      move(Math.max(0, Math.min(assets.length - 1, index - pixels / surface.clientWidth)), false);
    },
    /** 未达到翻页阈值或边界手势时回到当前页；已开始的成功翻页动画保持原进度。 */
    settle() { if (track && position !== index) move(index); },
    clear,
    /** 卸载时结束尺寸监听和媒体资源，避免隐藏预览保留音轨。 */
    dispose() { resize.disconnect(); clear(); },
  };
}

/** 沿用原助手的主轴滚轮与原生阶段语义；触屏/鼠标拖拽只提交一页，不修改素材顺序。 */
function bindNavigation(surface, step, {enabled = () => true, keyboardTarget = surface, onDrag, onDragEnd} = {}) {
  let pointer = null;
  const controller = new AbortController(), options = {signal: controller.signal};
  const wheel = createPreviewWheel(), nativeWheel = createNativePreviewWheel();

  /** 模态框只有最上层可接收翻图；普通手机预览在任意模态框打开时暂停输入。 */
  function active() {
    const dialogs = [...document.querySelectorAll('dialog[open]')];
    const owner = surface.closest('dialog');
    return enabled() && (owner ? dialogs.at(-1) === owner : dialogs.length === 0);
  }

  /** 根据真实指针位置路由原生输入，避免 WebKit 把滚轮交给外层时漏掉手势。 */
  function inside(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const bounds = surface.getBoundingClientRect();
    return x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom;
  }

  /** 取消指针只回到当前页，不因离开视图或系统取消而意外翻图。 */
  function cancelPointer() { if (pointer) { pointer = null; surface.classList.remove('is-dragging'); onDragEnd?.(); } }

  keyboardTarget.addEventListener('keydown', event => {
    if (!active() || event.target.closest('video, input, textarea, [contenteditable=true]')) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); step(event.key === 'ArrowLeft' ? -1 : 1);
  }, options);
  surface.addEventListener('pointerdown', event => {
    if (!active() || event.target.closest('video, button, a') || !event.isPrimary || event.button !== 0) return;
    pointer = {id: event.pointerId, x: event.clientX, y: event.clientY, horizontal: false};
    surface.setPointerCapture?.(event.pointerId);
  }, options);
  surface.addEventListener('pointermove', event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    if (!active()) { cancelPointer(); return; }
    const x = event.clientX - pointer.x, y = event.clientY - pointer.y;
    if (!pointer.horizontal && Math.abs(x) > 5 && Math.abs(x) > Math.abs(y) * 1.3) pointer.horizontal = true;
    if (pointer.horizontal) { event.preventDefault(); surface.classList.add('is-dragging'); onDrag?.(x); }
  }, options);
  surface.addEventListener('pointerup', event => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const x = event.clientX - pointer.x, y = event.clientY - pointer.y;
    pointer = null; surface.classList.remove('is-dragging');
    if (active() && Math.abs(x) >= 40 && Math.abs(x) > Math.abs(y) * 1.3) step(x < 0 ? 1 : -1);
    onDragEnd?.();
  }, options);
  surface.addEventListener('pointercancel', cancelPointer, options);
  surface.addEventListener('lostpointercapture', cancelPointer, options);
  window.addEventListener('luma:scroll', event => {
    if (!window.pluginContext?.nativeScrollPhases) return;
    const input = event.detail;
    if (!input || !Number.isFinite(input.deltaX) || !Number.isFinite(input.deltaY)) return;
    // 区外输入也推进原生阶段，进入预览的惯性或半程手势不能误判为新一轮翻图。
    const direction = nativeWheel(input);
    if (!active() || input.control || !inside(input.x, input.y)) return;
    if (direction) step(direction);
  }, options);
  document.addEventListener('wheel', event => {
    if (!active() || event.ctrlKey || !inside(event.clientX, event.clientY) || event.target.closest('video')) return;
    event.preventDefault();
    if (window.pluginContext?.nativeScrollPhases) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const pixels = delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.clientHeight : 1);
    const direction = wheel(pixels, performance.now());
    if (direction) step(direction);
  }, {...options, passive: false, capture: true});
  return () => { controller.abort(); cancelPointer(); };
}

/** 挂载纯媒体网格及独立放大预览；render 不触发 onIndexChange，避免双预览同步回环。 */
export function mountStudioGallery(container, {onIndexChange, onOpen, onRemove, onReorder} = {}) {
  const grid = node('div', 'studio-gallery-grid');
  const dialog = node('dialog', 'studio-gallery-lightbox');
  dialog.setAttribute('aria-label', '素材放大预览');
  const surface = node('div', 'studio-gallery-lightbox-surface');
  surface.tabIndex = 0;
  const close = node('button', 'studio-gallery-close');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭预览');
  close.append(icon('close'));
  const previous = node('button', 'studio-gallery-previous');
  previous.type = 'button';
  previous.setAttribute('aria-label', '上一张');
  previous.append(icon('previous'));
  const next = node('button', 'studio-gallery-next');
  next.type = 'button';
  next.setAttribute('aria-label', '下一张');
  next.append(icon('next'));
  dialog.append(surface, close, previous, next);
  container.replaceChildren(grid);
  document.body.append(dialog);
  let assets = [], index = 0, gridKey = '', disposed = false, editingDisabled = false;
  let dragging = null, suppressClick = false; // 拖动只暂存本画廊身份；落点确认前不修改素材顺序。
  const viewport = createMediaViewport(surface);
  let returnFocus = null, previousOverflow = '';

  /** 只有可编辑的纯图片作品可以排序，视频与在途提交保持原有交互。 */
  function canReorder() { return !disposed && !editingDisabled && !!onReorder && assets.length > 1 && assets.every(asset => asset.kind === 'image'); }

  /** 清除拖动提示；取消、拖到外部或宿主切换作品均不会写入草稿。 */
  function clearDrag() {
    dragging = null;
    for (const card of grid.children) card.classList.remove('is-dragging', 'drop-before', 'drop-after');
  }

  /** 只接受本画廊启动的拖动，不读取外部拖放数据，也不因伪造 MIME 身份修改作品。 */
  function dropTarget(event) {
    if (!canReorder() || !dragging || dragging.key !== gridKey) return null;
    const card = event.target.closest('.studio-gallery-card');
    return card?.parentElement === grid && card.dataset.assetId !== dragging.id ? card : null;
  }

  /** 显示即将插入的边缘：向后拖放到目标之后，向前拖放到目标之前。 */
  grid.ondragover = event => {
    const target = dropTarget(event);
    for (const card of grid.children) card.classList.remove('drop-before', 'drop-after');
    if (!target) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
    const from = assets.findIndex(asset => asset.id === dragging.id), to = assets.findIndex(asset => asset.id === target.dataset.assetId);
    target.classList.add(from < to ? 'drop-after' : 'drop-before');
  };
  grid.ondragleave = event => {
    if (event.relatedTarget && grid.contains(event.relatedTarget)) return;
    for (const card of grid.children) card.classList.remove('drop-before', 'drop-after');
  };
  grid.ondrop = event => {
    const target = dropTarget(event);
    if (!target) { clearDrag(); return; }
    event.preventDefault(); event.stopPropagation();
    const sourceID = dragging.id, targetID = target.dataset.assetId;
    clearDrag(); onReorder(sourceID, targetID);
  };
  grid.ondragend = clearDrag;

  /** 刷新已打开的媒体；同一素材不重建节点，从而保留视频播放进度。 */
  function updateLightbox() {
    const asset = assets[index];
    if (!asset || !dialog.open) return;
    viewport.render(assets, index);
    previous.hidden = assets.length < 2;
    next.hidden = assets.length < 2;
    previous.disabled = index === 0;
    next.disabled = index === assets.length - 1;
  }

  /** 仅改变查看位置，不更改素材顺序；回调允许宿主同步选中素材与手机预览。 */
  function select(nextIndex) {
    const selected = clampIndex(nextIndex, assets);
    if (selected === index) return;
    index = selected;
    updateLightbox();
    onIndexChange?.(index);
  }

  /** 显示原生模态对话框并锁住背景滚动，关闭后恢复原位置与焦点。 */
  function open(nextIndex) {
    if (disposed || !assets.length) return;
    select(nextIndex);
    if (!dialog.open) {
      returnFocus = document.activeElement;
      previousOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      dialog.showModal();
    }
    updateLightbox();
    surface.focus({preventScroll: true});
    onOpen?.(index);
  }

  /** 恢复模态框外滚动和焦点，并立即停止已关闭的音视频。 */
  function finishClose() {
    viewport.clear();
    document.documentElement.style.overflow = previousOverflow;
    if (returnFocus?.isConnected) returnFocus.focus({preventScroll: true});
    returnFocus = null;
  }

  /** 同步收回模态资源，避免原生 close 事件排队期间立即重开时清掉新图片。 */
  function closeLightbox() {
    if (!dialog.open) return;
    dialog.close();
    finishClose();
  }

  close.onclick = closeLightbox;
  previous.onclick = () => select(index - 1);
  next.onclick = () => select(index + 1);
  dialog.oncancel = event => { event.preventDefault(); closeLightbox(); };
  const stopNavigation = bindNavigation(surface, offset => select(index + offset), {
    keyboardTarget: dialog, enabled: () => dialog.open && assets.length > 1 && assets[index]?.kind === 'image',
    onDrag: pixels => viewport.drag(pixels), onDragEnd: () => viewport.settle(),
  });

  return {
    /** 供封面选择复用同一放大层；只查看当前图片，不更改封面或素材顺序。 */
    open,
    /** 接收素材与查看位置；移除按钮独立于预览按钮，提交期间禁止重复移除。 */
    render({assets: nextAssets = [], index: nextIndex = index, disabled = false, scope = ''} = {}) {
      if (disposed) return;
      editingDisabled = disabled;
      assets = normalizedAssets(nextAssets);
      index = clampIndex(nextIndex, assets);
      const key = JSON.stringify([scope, assets]);
      if (disabled || key !== gridKey) clearDrag();
      if (key !== gridKey) {
        gridKey = key;
        clearMedia(grid);
        assets.forEach((asset, assetIndex) => {
          if (asset.kind === 'video') {
            const video = media(asset, 'studio-gallery-video');
            grid.append(video);
            return;
          }
          const button = node('button', 'studio-gallery-image');
          button.type = 'button';
          button.setAttribute('aria-label', asset.alt ? `查看图片：${asset.alt}` : '查看图片');
          const image = media(asset);
          image.loading = 'lazy';
          button.append(image);
          // 原生拖动释放后的 click 不得误开放大层；下一次真实按下或键盘操作恢复正常预览。
          button.onpointerdown = () => { suppressClick = false; };
          button.onclick = event => { if (suppressClick) { event.preventDefault(); return; } open(assetIndex); };
          const card = node('div', 'studio-gallery-card');
          card.dataset.assetId = asset.id;
          button.ondragstart = event => {
            if (!canReorder() || !event.dataTransfer) { event.preventDefault(); return; }
            clearDrag(); suppressClick = true;
            dragging = {id: asset.id, key: gridKey};
            event.dataTransfer.setData('application/x-luma-studio-image', asset.id);
            event.dataTransfer.effectAllowed = 'move'; card.classList.add('is-dragging');
          };
          // 键盘排序不增加额外视觉按钮；边界无操作，焦点跟随正在调整的同一素材。
          button.onkeydown = async event => {
            suppressClick = false;
            if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key) || !canReorder()) return;
            event.preventDefault(); event.stopPropagation();
            const at = assets.findIndex(value => value.id === asset.id), target = assets[at + (event.key === 'ArrowLeft' ? -1 : 1)];
            if (target) {
              await onReorder(asset.id, target.id);
              if (canReorder()) [...grid.querySelectorAll('.studio-gallery-card')].find(value => value.dataset.assetId === asset.id)?.querySelector('.studio-gallery-image')?.focus({preventScroll: true});
            }
          };
          if (onReorder) {
            button.title = '拖拽调整顺序，单击放大；Option + 左右方向键调整顺序';
            button.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight');
          }
          card.append(button);
          if (onRemove) {
            const remove = node('button', 'studio-gallery-remove');
            remove.type = 'button'; remove.setAttribute('aria-label', `移除图片：${asset.alt || '图片'}`);
            remove.title = '从当前作品移除'; remove.append(icon('close'));
            // 独立按钮只通知宿主移除草稿引用，不触发放大，也不删除图库原文件。
            remove.onclick = event => { event.stopPropagation(); if (!remove.disabled) onRemove(asset.id); };
            card.append(remove);
          }
          grid.append(card);
        });
      }
      for (const button of grid.querySelectorAll('.studio-gallery-image')) button.draggable = canReorder();
      for (const remove of grid.querySelectorAll('.studio-gallery-remove')) remove.disabled = disabled;
      if (!assets.length && dialog.open) closeLightbox();
      else updateLightbox();
    },
    /** 释放手势、模态框和视频资源；重复卸载不产生额外回调。 */
    dispose() {
      if (disposed) return;
      disposed = true;
      clearDrag(); grid.ondragover = grid.ondragleave = grid.ondrop = grid.ondragend = null;
      stopNavigation();
      closeLightbox();
      dialog.oncancel = null;
      clearMedia(grid);
      viewport.dispose();
      grid.remove();
      dialog.remove();
    },
  };
}

/** 挂载与官方手机预览结构一致的展示框；装饰操作不联网、不产生虚构互动数据。 */
export function mountDouyinPreview(container, {onIndexChange} = {}) {
  const phone = node('div', 'studio-phone');
  phone.setAttribute('aria-label', '抖音手机预览');
  const notch = node('div', 'studio-phone-notch');
  notch.setAttribute('aria-hidden', 'true');
  notch.append(node('span', 'studio-phone-speaker'), node('span', 'studio-phone-camera'));
  const top = node('div', 'studio-phone-top');
  top.setAttribute('aria-hidden', 'true');
  for (const label of ['直播', '同城', '关注', '推荐']) top.append(node('span', label === '推荐' ? 'active' : '', label));
  top.append(icon('search'));
  const stage = node('div', 'studio-phone-stage');
  stage.tabIndex = 0;
  stage.setAttribute('aria-label', '左右滑动查看图片');
  const rail = node('div', 'studio-phone-actions');
  rail.setAttribute('aria-hidden', 'true');
  const avatar = node('div', 'studio-phone-avatar');
  const avatarPicture = node('div', 'studio-phone-avatar-picture');
  avatar.append(avatarPicture, node('span', 'studio-phone-follow', '+'));
  rail.append(avatar);
  for (const [name, label] of [['heart', '赞'], ['comment', '评论'], ['star', '收藏'], ['share', '分享']]) {
    const action = node('div', 'studio-phone-action');
    action.append(icon(name), node('span', '', label));
    rail.append(action);
  }
  const record = node('div', 'studio-phone-record');
  record.append(node('span', '', '♪'));
  rail.append(record);
  const caption = node('div', 'studio-phone-caption');
  const identity = node('div', 'studio-phone-identity');
  const account = node('strong');
  const kind = node('span', 'studio-phone-kind');
  kind.append(icon('images'), node('span', '', '图文'));
  identity.append(account, kind);
  const title = node('div', 'studio-phone-title');
  const description = node('div', 'studio-phone-description');
  const music = node('div', 'studio-phone-music');
  const musicText = node('span');
  music.append(icon('music'), musicText);
  caption.append(identity, title, description, music);
  const bottom = node('div', 'studio-phone-bottom');
  bottom.setAttribute('aria-hidden', 'true');
  for (const label of ['首页', '朋友', '+', '消息', '我']) bottom.append(node('span', label === '+' ? 'studio-phone-publish' : label === '首页' ? 'active' : '', label));
  const progress = node('div', 'studio-phone-progress');
  progress.setAttribute('role', 'tablist'); progress.setAttribute('aria-label', '图片浏览进度');
  const announcement = node('span', 'studio-preview-announcement');
  announcement.setAttribute('role', 'status'); announcement.setAttribute('aria-live', 'polite');
  stage.id = 'studio-phone-media-' + crypto.randomUUID();
  phone.append(stage, notch, top, rail, caption, bottom, progress, announcement);
  container.replaceChildren(phone);
  let assets = [], index = 0, avatarKey = '', disposed = false, segmentKey = '';
  let progressPointer = null;
  const viewport = createMediaViewport(stage), listeners = new AbortController();

  /** 一张图对应一条横线，只有当前图高亮；按钮数量随素材变化，回显索引不重建控件。 */
  function updateSegments() {
    const images = assets.map((asset, assetIndex) => ({asset, assetIndex})).filter(value => value.asset.kind === 'image');
    const key = JSON.stringify(images.map(value => [value.asset.id, value.assetIndex]));
    if (key !== segmentKey) {
      segmentKey = key; progress.replaceChildren();
      for (const [imageIndex, value] of images.entries()) {
        const button = node('button', 'studio-phone-segment'); button.type = 'button';
        button.id = stage.id + '-segment-' + imageIndex;
        button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', stage.id);
        button.setAttribute('aria-label', `查看第 ${imageIndex + 1} 张，共 ${images.length} 张`);
        button.dataset.assetIndex = String(value.assetIndex);
        button.onclick = () => select(value.assetIndex);
        progress.append(button);
      }
    }
    const selectedImage = images.findIndex(value => value.assetIndex === index);
    progress.hidden = !assets[index] || assets[index].kind === 'video';
    for (const button of progress.children) {
      const current = Number(button.dataset.assetIndex) === index;
      button.classList.toggle('is-current', current); button.setAttribute('aria-selected', String(current));
      button.tabIndex = current ? 0 : -1;
    }
    const selected = progress.querySelector('[aria-selected="true"]');
    if (!progress.hidden && selected) { stage.setAttribute('role', 'tabpanel'); stage.setAttribute('aria-labelledby', selected.id); }
    else { stage.removeAttribute('role'); stage.removeAttribute('aria-labelledby'); }
    progress.style.setProperty('--segment-gap', images.length > 15 ? '1px' : '3px');
    announcement.textContent = selectedImage >= 0 ? `第 ${selectedImage + 1} 张，共 ${images.length} 张` : '';
  }

  /** 在固定手机视口内替换媒体，完整展示图片比例并保留同一视频的播放状态。 */
  function updateMedia() {
    const asset = assets[index];
    viewport.render(assets, index);
    kind.hidden = asset?.kind === 'video';
    phone.classList.toggle('has-video', asset?.kind === 'video');
    updateSegments();
  }

  /** 用户翻图或拖动横条只改变查看位置；宿主 render 同步不反向通知或修改素材顺序。 */
  function select(nextIndex) {
    if (disposed) return;
    const selected = clampIndex(nextIndex, assets);
    if (selected === index) return;
    index = selected;
    updateMedia();
    onIndexChange?.(index);
  }
  /** 段条支持拖动滑过多段；只选择真实图片，不产生连续的虚拟进度。 */
  function selectSegmentAt(x) {
    const buttons = [...progress.children], bounds = progress.getBoundingClientRect();
    if (!buttons.length || !bounds.width) return;
    const offset = Math.max(0, Math.min(buttons.length - 1, Math.floor((x - bounds.left) / bounds.width * buttons.length)));
    select(Number(buttons[offset].dataset.assetIndex));
  }
  progress.addEventListener('pointerdown', event => {
    if (event.button !== 0 || !event.isPrimary || progress.hidden) return;
    progressPointer = {id: event.pointerId, x: event.clientX, dragged: false};
    progress.setPointerCapture?.(event.pointerId);
    selectSegmentAt(event.clientX);
  }, {signal: listeners.signal});
  progress.addEventListener('pointermove', event => {
    if (!progressPointer || progressPointer.id !== event.pointerId) return;
    if (Math.abs(event.clientX - progressPointer.x) > 3) progressPointer.dragged = true;
    if (progressPointer.dragged) { event.preventDefault(); selectSegmentAt(event.clientX); }
  }, {signal: listeners.signal});
  progress.addEventListener('pointerup', event => {
    if (!progressPointer || progressPointer.id !== event.pointerId) return;
    selectSegmentAt(event.clientX);
    const selected = progress.querySelector('[aria-selected="true"]');
    progressPointer = null; selected?.focus({preventScroll: true});
  }, {signal: listeners.signal});
  progress.addEventListener('pointercancel', () => { progressPointer = null; }, {signal: listeners.signal});
  progress.addEventListener('lostpointercapture', () => { progressPointer = null; }, {signal: listeners.signal});
  progress.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const buttons = [...progress.children], selected = buttons.findIndex(button => Number(button.dataset.assetIndex) === index);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, selected + (event.key === 'ArrowLeft' ? -1 : 1)));
    if (buttons[next]) { select(Number(buttons[next].dataset.assetIndex)); buttons[next].focus({preventScroll: true}); }
  }, {signal: listeners.signal});
  const stopNavigation = bindNavigation(stage, offset => select(index + offset), {
    enabled: () => assets.length > 1 && assets[index]?.kind === 'image',
    onDrag: pixels => viewport.drag(pixels), onDragEnd: () => viewport.settle(),
  });

  return {
    /** 更新预览素材、已验证账号与草稿文案；缺省账号使用明确占位，不伪造身份。 */
    render({assets: nextAssets = [], index: nextIndex = index, accountName = '', avatarURL = '', title: nextTitle = '', description: nextDescription = '', musicName = ''} = {}) {
      if (disposed) return;
      assets = normalizedAssets(nextAssets);
      index = clampIndex(nextIndex, assets);
      updateMedia();
      account.textContent = accountName ? '@' + String(accountName).replace(/^@/, '') : '@发布账号';
      title.textContent = nextTitle;
      title.hidden = !nextTitle;
      description.textContent = nextDescription;
      description.hidden = !nextDescription;
      musicText.textContent = musicName || (accountName ? `${String(accountName).replace(/^@/, '')}创作的原声` : '原创音乐');
      if (avatarKey !== avatarURL || !avatarPicture.childNodes.length) {
        avatarKey = avatarURL;
        avatarPicture.replaceChildren();
        if (avatarURL) {
          const image = node('img');
          image.src = avatarURL;
          image.alt = '';
          avatarPicture.append(image);
        } else avatarPicture.append(icon('person'));
      }
    },
    /** 释放手机预览手势和视频资源，不改变宿主选中素材或草稿顺序。 */
    dispose() {
      if (disposed) return;
      disposed = true;
      stopNavigation();
      listeners.abort(); progressPointer = null; viewport.dispose();
      phone.remove();
    },
  };
}
