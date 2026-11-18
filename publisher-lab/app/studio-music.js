/** 构造音乐抽屉节点，平台文案只通过 textContent 写入。 */
function node(tag, className = '', text = '') {
  const result = document.createElement(tag);
  result.className = className;
  if (text) result.textContent = text;
  return result;
}

/** 返回本地固定播放器图标，不把平台返回值作为 SVG 或 HTML 解析。 */
function icon(name) {
  const shapes = {
    play: '<path fill="currentColor" d="m8 4 13 8L8 20Z"/>',
    pause: '<rect fill="currentColor" x="5" y="4" width="5" height="16" rx="1.5"/><rect fill="currentColor" x="14" y="4" width="5" height="16" rx="1.5"/>',
    volume: '<path fill="currentColor" d="M3 8h4l6-5v18l-6-5H3Z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M17 7a7 7 0 0 1 0 10M20 4a11 11 0 0 1 0 16"/>',
    muted: '<path fill="currentColor" d="M3 8h4l6-5v18l-6-5H3Z"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="m17 9 5 6m0-6-5 6"/>',
    music: '<path fill="none" stroke="currentColor" stroke-width="2" d="M10 17V4l10-2v13"/><ellipse fill="currentColor" cx="6.5" cy="18" rx="3.5" ry="3"/><ellipse fill="currentColor" cx="16.5" cy="16" rx="3.5" ry="3"/>',
  };
  const result = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  result.setAttribute('viewBox', '0 0 24 24');
  result.setAttribute('aria-hidden', 'true');
  result.innerHTML = shapes[name] || '';
  return result;
}

/** 将真实秒数转为 mm:ss；未知时长显示占位，不借候选声明伪造已加载音频时长。 */
function clock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
}

/** 只格式化平台实际返回的使用人数，缺失、负数和非法数值不展示。 */
function usage(value) {
  if (!Number.isFinite(value) || value < 0) return '';
  return value >= 10000 ? `${(value / 10000).toFixed(1)}万人使用` : `${Math.floor(value)}人使用`;
}

/** 展示平台返回的音乐分类；横向箭头只滚动标签，只有选择标签才通知查询编排。 */
export function mountMusicCategories({container, onSelect, onRetry}) {
  const listeners = new AbortController(), buttons = new Map();
  let items = [], loading = false, disposed = false;
  const previous = node('button', 'studio-music-category-arrow', '‹'); previous.type = 'button'; previous.setAttribute('aria-label', '上一组音乐分类');
  const next = node('button', 'studio-music-category-arrow', '›'); next.type = 'button'; next.setAttribute('aria-label', '下一组音乐分类');
  const list = node('div', 'studio-music-category-list'); list.setAttribute('role', 'tablist'); list.setAttribute('aria-label', '音乐分类');
  const feedback = node('div', 'studio-music-category-feedback');
  const message = node('span'); message.setAttribute('role', 'status');
  const retry = node('button', 'studio-music-category-retry', '重试'); retry.type = 'button'; retry.onclick = () => onRetry?.();
  feedback.append(message, retry); container.replaceChildren(previous, list, next, feedback);
  container.classList.add('studio-music-categories');

  /** 复合身份保留不同类型下相同的 category_id，不能按 ID 单独合并平台分类。 */
  function key(item) { return `${item.type}:${item.id}`; }

  /** 依据真实可滚动距离启用箭头，窄窗和更多分类均不撑宽抽屉。 */
  function arrows() {
    if (disposed) return;
    previous.disabled = loading || list.scrollLeft <= 1;
    next.disabled = loading || list.scrollWidth - list.clientWidth - list.scrollLeft <= 1;
  }

  /** 保持焦点标签可见，滚动只发生在分类条内，不移动整个抽屉。 */
  function reveal(button) {
    const left = button.offsetLeft - list.offsetLeft;
    if (left < list.scrollLeft) list.scrollLeft = left;
    else if (left + button.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = left + button.offsetWidth - list.clientWidth;
    arrows();
  }

  previous.onclick = () => list.scrollBy({left: -list.clientWidth * .7, behavior: 'smooth'});
  next.onclick = () => list.scrollBy({left: list.clientWidth * .7, behavior: 'smooth'});
  list.addEventListener('scroll', arrows, {passive: true, signal: listeners.signal});
  const resize = new ResizeObserver(arrows); resize.observe(list);
  return {
    /** 分类名称来自真实目录；关键词搜索时暂不标记分类选中，但宿主保留原选择供清空搜索恢复。 */
    render({items: values = [], selected = null, searching = false, loading: pending = false, error = ''} = {}) {
      if (disposed) return;
      items = values; loading = pending;
      const keep = new Set();
      for (const [index, item] of items.entries()) {
        const identity = key(item); keep.add(identity);
        let button = buttons.get(identity);
        if (!button) {
          button = node('button', 'studio-music-category'); button.type = 'button'; button.setAttribute('role', 'tab'); button.dataset.categoryKey = identity;
          button.onclick = () => { if (!loading) { onSelect?.(item); reveal(button); } };
          button.onkeydown = event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || loading) return;
            event.preventDefault();
            const position = items.findIndex(value => key(value) === identity);
            const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (position + (event.key === 'ArrowLeft' ? -1 : 1) + items.length) % items.length;
            const value = items[nextIndex], target = buttons.get(key(value)); target.focus(); onSelect?.(value); reveal(target);
          };
          buttons.set(identity, button);
        }
        const active = !searching && selected && key(selected) === identity;
        button.textContent = item.name; button.title = item.name; button.disabled = loading;
        button.classList.toggle('active', !!active); button.setAttribute('aria-selected', String(!!active));
        button.tabIndex = active || (!selected && index === 0) || (searching && index === 0) ? 0 : -1;
        if (list.children[index] !== button) list.insertBefore(button, list.children[index] || null);
      }
      for (const [identity, button] of buttons) if (!keep.has(identity)) { button.remove(); buttons.delete(identity); }
      list.hidden = !items.length;
      feedback.hidden = !!items.length && !error;
      message.textContent = error || (loading ? '正在读取音乐分类…' : items.length ? '' : '暂无可用音乐分类');
      retry.hidden = !error; retry.disabled = loading;
      container.setAttribute('aria-busy', String(loading)); arrows();
    },
    /** 释放分类条监听，不影响共享播放器或草稿已选音乐。 */
    dispose() { if (disposed) return; disposed = true; listeners.abort(); resize.disconnect(); buttons.clear(); container.replaceChildren(); },
  };
}

/** 接管音乐结果与底部播放器；查询、分页与作品保存继续由宿主编排。 */
export function mountMusicDrawer({results, footer, audio, safeURL, onSelect}) {
  const rows = new Map();
  const listeners = new AbortController();
  let current = null, selectedId = '', generation = 0, disposed = false, buffering = false;
  let lastVolume = audio.volume > 0 ? audio.volume : 1;
  let failure = '';
  footer.classList.add('studio-music-playback');
  footer.hidden = true;
  audio.hidden = true;
  audio.controls = false;
  audio.preload = 'metadata';
  const player = node('div', 'studio-music-player');
  const coverButton = node('button', 'studio-music-player-cover');
  coverButton.type = 'button';
  const cover = node('span', 'studio-music-cover-art');
  const coverControl = node('span', 'studio-music-cover-control');
  coverButton.append(cover, coverControl);
  const information = node('div', 'studio-music-player-information');
  const heading = node('div', 'studio-music-player-heading');
  const title = node('strong');
  const author = node('span');
  heading.append(title, author);
  const progressRow = node('div', 'studio-music-progress-row');
  const progress = node('input', 'studio-music-progress');
  progress.type = 'range'; progress.min = '0'; progress.max = '1000'; progress.step = '1'; progress.value = '0';
  progress.setAttribute('aria-label', '试听进度');
  const time = node('span', 'studio-music-time');
  progressRow.append(progress, time);
  information.append(heading, progressRow);
  const volumeControl = node('div', 'studio-music-volume-control');
  const mute = node('button', 'studio-music-mute');
  mute.type = 'button';
  const volumePanel = node('div', 'studio-music-volume-panel');
  const volume = node('input', 'studio-music-volume');
  volume.type = 'range'; volume.min = '0'; volume.max = '1'; volume.step = '.01';
  volume.setAttribute('aria-label', '试听音量');
  volumePanel.append(volume);
  volumeControl.append(mute, volumePanel);
  const status = node('p', 'studio-music-playback-status');
  status.setAttribute('role', 'status'); status.hidden = true;
  player.append(coverButton, information, volumeControl);
  footer.replaceChildren(player, status);

  /** 只接收安全地址与展示字段；保留候选身份供点击使用时交回宿主。 */
  function candidate(item) {
    return {
      // source 保留调用方候选，仅点击使用时原样交回，不改写草稿或发布状态。
      source: item,
      // id 是平台音乐身份；同一身份与试听 URL 共同决定是否复用当前音轨。
      id: String(item?.id || ''),
      // name 与 author 用于列表和播放器文案，不解析 HTML。
      name: typeof item?.name === 'string' ? item.name : '',
      author: typeof item?.description === 'string' ? item.description : '',
      // duration 仅展示候选声明时长；播放器实际时长始终从 audio.duration 读取。
      duration: item?.duration,
      // image 与 url 必须先经过宿主提供的地址校验函数。
      image: safeURL(item?.thumbnailURL) || '',
      url: safeURL(item?.previewURL) || '',
      // userCount 仅接受原始数字，避免将缺省值转换成虚构使用人数。
      userCount: item?.userCount,
    };
  }

  /** 设置封面，缺少图片时使用中性音乐图标，不生成虚构专辑图。 */
  function artwork(container, value) {
    if (container.dataset.url === value) return;
    container.dataset.url = value;
    container.replaceChildren();
    if (value) {
      const image = node('img'); image.src = value; image.alt = ''; image.loading = 'lazy';
      container.append(image);
    } else container.append(icon('music'));
  }

  /** 仅依据当前媒体真实状态显示播放动效；正在缓冲或失败时不显示为播放中。 */
  function playing() {
    return !!current && !audio.paused && !audio.ended && !buffering && !failure && audio.readyState >= 2;
  }

  /** 同步音量与静音图标，恢复静音时使用上次非零音量。 */
  function updateVolume() {
    const silent = audio.muted || audio.volume === 0;
    mute.replaceChildren(icon(silent ? 'muted' : 'volume'));
    mute.setAttribute('aria-label', silent ? '取消静音' : '静音');
    mute.setAttribute('aria-pressed', String(silent));
    volume.value = String(audio.muted ? 0 : audio.volume);
  }

  /** 从已加载媒体更新进度、时长和行状态，不用定时器假造播放进度。 */
  function updatePlayback() {
    if (disposed) return;
    const isPlaying = playing();
    for (const row of rows.values()) row.sync();
    if (!current) { footer.hidden = true; return; }
    footer.hidden = false;
    title.textContent = current.name; title.title = current.name;
    author.textContent = current.author; author.title = current.author;
    artwork(cover, current.image);
    coverControl.replaceChildren(icon(isPlaying ? 'pause' : 'play'));
    coverButton.setAttribute('aria-label', isPlaying ? '暂停试听' : '播放试听');
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null;
    const position = Number.isFinite(audio.currentTime) ? Math.max(0, audio.currentTime) : 0;
    progress.disabled = duration === null || !audio.seekable.length || audio.seekable.end(audio.seekable.length - 1) <= 0 || !!failure;
    progress.value = String(duration ? Math.round(Math.min(1, position / duration) * 1000) : 0);
    progress.style.setProperty('--music-progress', progress.value / 10 + '%');
    progress.setAttribute('aria-valuetext', `${clock(position)} / ${clock(duration)}`);
    time.textContent = `${clock(position)} / ${clock(duration)}`;
    status.textContent = failure;
    status.hidden = !failure;
    updateVolume();
  }

  /** 开始或切换真实音轨；迟到的旧 play() 拒绝不能覆盖新曲目的状态。 */
  async function play(item) {
    if (disposed) return;
    const value = candidate(item);
    if (!value.url) return;
    const token = ++generation;
    const same = current?.id === value.id && current?.url === value.url;
    if (same && !audio.paused) { audio.pause(); buffering = false; updatePlayback(); return; }
    failure = '';
    if (!same) {
      audio.pause();
      current = value;
      buffering = true;
      audio.src = value.url;
      audio.load();
    } else {
      current = value;
      if (audio.error) { buffering = true; audio.load(); }
      if (audio.ended) audio.currentTime = 0;
    }
    updatePlayback();
    try {
      await audio.play();
      if (token === generation && !disposed) updatePlayback();
      return token === generation && !disposed ? {ok: true} : {ok: false, code: 'PLAYBACK_CANCELLED'};
    } catch (error) {
      if (token !== generation || disposed) return {ok: false, code: 'PLAYBACK_CANCELLED'};
      buffering = false;
      const needsGesture = error?.name === 'NotAllowedError';
      failure = needsGesture ? '已取得试听音频，请再次点击播放。' : '此音乐暂时无法试听，请重试。';
      updatePlayback();
      return {ok: false, code: needsGesture ? 'PLAYBACK_GESTURE_REQUIRED' : 'PLAYBACK_FAILED'};
    }
  }

  /** 为一项候选创建可键盘试听的整行；使用按钮与试听事件彼此独立。 */
  function makeRow(value) {
    let item = value;
    const row = node('div', 'search-row studio-music-row');
    const listen = node('button', 'studio-music-listen'); listen.type = 'button';
    const image = node('span', 'studio-music-row-cover');
    const text = node('span', 'studio-music-row-text');
    const nameLine = node('span', 'studio-music-name-line');
    const name = node('strong', 'studio-music-name');
    const equalizer = node('span', 'studio-music-equalizer'); equalizer.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < 3; index++) equalizer.append(node('i'));
    nameLine.append(name, equalizer);
    const detail = node('small', 'studio-music-detail');
    text.append(nameLine, detail); listen.append(image, text);
    const count = node('span', 'studio-music-usage');
    const use = node('button', 'studio-music-use', '使用'); use.type = 'button';
    row.append(listen, count, use);
    // 点击行的空白或使用人数也试听；“使用”始终阻止冒泡，绝不隐式播放或发布。
    row.onclick = event => { if (!event.target.closest('.studio-music-use')) void play(item.source); };
    use.onclick = event => { event.stopPropagation(); if (!use.disabled) onSelect?.(item.source); };

    /** 根据实际音轨状态更新本行；暂停后保留曲目焦点但停止均衡器动画。 */
    function sync() {
      const active = current?.id === item.id && current?.url === item.url;
      const running = active && playing();
      row.classList.toggle('is-current', active);
      row.classList.toggle('is-playing', running);
      row.classList.toggle('is-selected', selectedId === item.id);
      listen.setAttribute('aria-label', `${running ? '暂停' : '试听'} ${item.name}`);
      listen.setAttribute('aria-pressed', String(running));
      listen.disabled = !item.url;
      use.textContent = selectedId === item.id ? '已使用' : '使用';
      use.disabled = selectedId === item.id;
    }

    /** 列表分页或选中状态变化时复用原行，避免夺走键盘焦点。 */
    function update(next) {
      item = next;
      row.dataset.musicId = item.id;
      artwork(image, item.image);
      name.textContent = item.name; name.title = item.name;
      detail.textContent = [item.author, Number.isFinite(item.duration) && item.duration >= 0 ? clock(item.duration) : ''].filter(Boolean).join(' · ');
      count.textContent = usage(item.userCount);
      sync();
    }
    update(value);
    return {element: row, sync, update};
  }

  coverButton.onclick = () => { if (current) void play(current.source); };
  progress.oninput = () => {
    if (!current || progress.disabled || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration, Number(progress.value) / 1000 * audio.duration));
    updatePlayback();
  };
  mute.onclick = () => {
    if (audio.muted || audio.volume === 0) { audio.muted = false; audio.volume = lastVolume || 1; }
    else { lastVolume = audio.volume; audio.muted = true; }
    updateVolume();
  };
  volume.oninput = () => {
    audio.volume = Math.max(0, Math.min(1, Number(volume.value)));
    audio.muted = false;
    if (audio.volume > 0) lastVolume = audio.volume;
    updateVolume();
  };
  // 媒体事件是播放器唯一状态来源；切曲、暂停、拖动与网络错误均使用相同同步入口。
  for (const event of ['play', 'pause', 'timeupdate', 'loadedmetadata', 'durationchange', 'progress', 'canplay', 'ended', 'seeked', 'volumechange']) audio.addEventListener(event, updatePlayback, {signal: listeners.signal});
  audio.addEventListener('waiting', () => { buffering = true; updatePlayback(); }, {signal: listeners.signal});
  audio.addEventListener('playing', () => { buffering = false; failure = ''; updatePlayback(); }, {signal: listeners.signal});
  audio.addEventListener('error', () => { if (current && audio.error) { buffering = false; failure = '此音乐暂时无法试听，请重试。'; updatePlayback(); } }, {signal: listeners.signal});

  /** 停止试听并释放音源；隐藏底栏且撤销未完成 play() 的错误回调。 */
  function stop() {
    generation++;
    current = null; failure = ''; buffering = false;
    audio.pause(); audio.removeAttribute('src'); audio.load();
    updatePlayback();
  }

  return {
    /** 渲染查询候选并保留同一音轨进度；selectedId 只表示宿主已选配乐。 */
    render({items = [], selectedId: nextSelectedId = ''} = {}) {
      if (disposed) return;
      selectedId = String(nextSelectedId || '');
      const keep = new Set();
      let position = 0;
      for (const source of items) {
        const item = candidate(source);
        if (!item.id || keep.has(item.id)) continue;
        keep.add(item.id);
        const row = rows.get(item.id) || makeRow(item);
        rows.set(item.id, row); row.update(item);
        // 未改变的查询结果保持 DOM 原位，避免分页 render 让键盘焦点离开当前按钮。
        if (results.children[position] !== row.element) results.insertBefore(row.element, results.children[position] || null);
        position++;
      }
      for (const [id, row] of rows) if (!keep.has(id)) { row.element.remove(); rows.delete(id); }
      updatePlayback();
    },
    play,
    stop,
    /** 卸载音轨和事件监听，不清除宿主已保存的音乐选择。 */
    dispose() {
      if (disposed) return;
      stop(); disposed = true; listeners.abort();
      for (const row of rows.values()) row.element.remove();
      rows.clear(); footer.replaceChildren(); footer.hidden = true;
    },
  };
}
