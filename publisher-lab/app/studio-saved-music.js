// 已保存音乐只保留身份；试听地址按用户点击从当前账号重新查询，不写入草稿或持久存储。
const MAX_LOOKUP_PAGES = 5;

/** 挂载已选音乐的播放入口；查询与音频使用同一账号/草稿绑定，切换后旧回复不得开始播放。 */
export function mountSavedMusicPreview({button, iconButton, audio, current, ensureSession, request, play, stop, safeURL, blocked, onError}) {
  const listeners = new AbortController();
  let pending = null, cached = null, disposed = false;

  /** 选择身份包含草稿与账号；资源名称参与绑定，避免同 ID 的旧名称或旧账号音源回流。 */
  function key(value) { return JSON.stringify([value.draftId, value.kind, value.profileId, value.accountId, value.music?.id, value.music?.name]); }
  function selection(value) { return JSON.stringify([value.draftId, value.kind, value.music?.id, value.music?.name]); }
  /** 会话核验阶段只允许从未核验身份进入同一档案；已知账号或选曲变化直接取消。 */
  function owns(job) {
    const value = current();
    return !disposed && pending === job && !job.controller.signal.aborted && selection(value) === job.selection &&
      (!job.profileId || value.profileId === job.profileId) && (!job.accountId || value.accountId === job.accountId);
  }
  function requireCurrent(job) { if (!owns(job)) throw new DOMException('已取消旧音乐试听', 'AbortError'); }
  /** 只判断当前选曲的真实音频状态；抽屉正在试听另一首时不会把已选音乐显示为播放中。 */
  function playing() { return !!cached && audio.src === cached.item.previewURL && !audio.paused && !audio.ended && !audio.error; }

  /** 清理当前试听查询及地址；不改变作品配乐，也不发起新的查询。 */
  function reset({stopAudio = true} = {}) {
    const previous = cached;
    pending?.controller.abort(); pending = null; cached = null;
    if (stopAudio && previous && audio.src === previous.item.previewURL) stop();
  }

  /** 根据现有选择和真实播放事件回显，不因重绘自动联网。 */
  function render() {
    if (disposed) return;
    const value = current(), identity = key(value);
    if (pending && !owns(pending)) reset();
    if (cached && cached.key !== identity) reset();
    const hasMusic = value.kind === 'image' && !!value.music?.id;
    const isPlaying = hasMusic && playing();
    button.hidden = !hasMusic;
    button.textContent = pending ? '加载中…' : isPlaying ? '暂停' : '试听';
    button.disabled = !!pending || !!blocked?.();
    iconButton.disabled = !hasMusic || !!pending || !!blocked?.();
    iconButton.textContent = pending ? '…' : isPlaying ? 'Ⅱ' : hasMusic ? '▶' : '♫';
    iconButton.classList.toggle('can-play', hasMusic);
    const label = pending ? '正在读取已选音乐' : `${isPlaying ? '暂停' : '试听'}已选音乐${hasMusic ? '：' + value.music.name : ''}`;
    iconButton.setAttribute('aria-label', label);
    iconButton.setAttribute('aria-pressed', String(!!isPlaying));
    button.setAttribute('aria-pressed', String(!!isPlaying));
  }

  /** 搜索最多五页；名称仅作线索，完整名称和 ID 必须同时一致，不选择近似歌曲。 */
  async function resolve(job, music) {
    const seen = new Set(); let cursor = '0';
    for (let page = 0; page < MAX_LOOKUP_PAGES; page++) {
      requireCurrent(job);
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const result = await request('music.search', {query: music.name.slice(0, 100), cursor, kind: 'image'}, {signal: job.controller.signal});
      requireCurrent(job);
      const item = result?.items?.find(value => value.id === music.id && value.name === music.name);
      if (item) {
        const previewURL = safeURL(item.previewURL);
        if (!previewURL) throw Error('这首音乐暂未提供试听音频，请稍后重试。');
        return {...item, previewURL};
      }
      if (typeof result?.nextCursor !== 'string' || !/^\d{1,12}$/.test(result.nextCursor)) break;
      cursor = result.nextCursor;
    }
    throw Error(`未找到「${music.name}」的可用试听音频，已保留原配乐，请稍后重试。`);
  }

  /** 播放只在明确点击后开始；媒体策略阻止时保留地址，下一次点击同步 play，不重复查询。 */
  async function toggle() {
    if (disposed || pending || blocked?.()) return;
    const value = current();
    if (value.kind !== 'image' || !value.music?.id) return;
    if (cached?.key === key(value)) {
      const active = cached;
      const result = await play(active.item); // 在第一次 await 之前进入 audio.play，保留本次用户激活。
      // play 的 Promise 也可能晚于换稿/换号或另一次试听；旧结果不能更新新入口。
      if (disposed || cached !== active || active.key !== key(current())) return;
      if (result?.code === 'PLAYBACK_GESTURE_REQUIRED') onError?.('已取得试听音频，请再次点击播放。');
      else if (result?.ok === false && result.code !== 'PLAYBACK_CANCELLED') { cached = null; onError?.('音乐试听失败，请点击试听重新获取音频。'); }
      render(); return;
    }
    const job = {selection: selection(value), profileId: value.profileId, accountId: value.accountId, controller: new AbortController()};
    pending = job; render();
    try {
      if (!value.connected) await ensureSession();
      requireCurrent(job);
      const verified = current();
      if (!verified.connected || !verified.accountId) throw Error('请先登录抖音并核对账号，再试听已选音乐。');
      job.profileId = verified.profileId; job.accountId = verified.accountId;
      const item = await resolve(job, value.music);
      requireCurrent(job);
      cached = {key: key(verified), item};
      const result = await play(item);
      requireCurrent(job);
      if (result?.code === 'PLAYBACK_GESTURE_REQUIRED') onError?.('已取得试听音频，请再次点击播放。');
      else if (result?.ok === false && result.code !== 'PLAYBACK_CANCELLED' && cached) { cached = null; onError?.('音乐试听失败，请点击试听重新获取音频。'); }
    } catch (error) {
      if (owns(job) && error.name !== 'AbortError') onError?.(error.message || '音乐试听未完成，请重试。');
    } finally { if (pending === job) pending = null; render(); }
  }

  button.onclick = iconButton.onclick = () => { void toggle(); };
  for (const name of ['play', 'pause', 'playing', 'ended', 'loadedmetadata', 'emptied']) audio.addEventListener(name, render, {signal: listeners.signal});
  audio.addEventListener('error', () => {
    if (cached && audio.src === cached.item.previewURL && audio.error) {
      cached = null; onError?.('音乐试听失败，请点击试听重新获取音频。');
    }
    render();
  }, {signal: listeners.signal});
  return {
    render, toggle,
    /** 主页面切换草稿、账号或清除配乐时同步撤销迟到查询。 */
    reset() { reset(); render(); },
    /** 页面卸载时释放查询与媒体监听；已保存配乐不受影响。 */
    dispose() { if (disposed) return; reset(); disposed = true; listeners.abort(); button.onclick = iconButton.onclick = null; },
  };
}
