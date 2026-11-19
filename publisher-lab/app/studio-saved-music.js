// 草稿只保留音乐身份；点击时从当前账号恢复音源，独立持久记录由平台模块管理。

/** 挂载已选音乐的播放入口；查询与音频使用同一账号/草稿绑定，切换后旧回复不得开始播放。 */
export function mountSavedMusicPreview({button, iconButton, audio, current, request, play, stop, safeURL, blocked, onError}) {
  const listeners = new AbortController();
  let pending = null, cached = null, invalidatedSession = null, refreshSource = false, disposed = false;

  /** 选择身份包含草稿、账号和音乐 ID；平台改名不改变歌曲身份。 */
  function key(value) { return JSON.stringify([value.draftId, value.kind, value.profileId, value.accountId, value.music?.id]); }
  function selection(value) { return JSON.stringify([value.draftId, value.kind, value.music?.id]); }
  function sameTarget(job, value) { return selection(value) === job.selection && (!job.profileId || value.profileId === job.profileId); }
  /** 只接收当前档案与选曲的回执；离线提示本身不代表切换了账号。 */
  function owns(job) {
    const value = current();
    return !disposed && pending === job && !job.controller.signal.aborted && selection(value) === job.selection &&
      (!job.profileId || value.profileId === job.profileId) && (!job.accountId || value.accountId === job.accountId);
  }
  function requireCurrent(job) { if (!owns(job)) throw new DOMException('已取消旧音乐试听', 'AbortError'); }
  /** 只判断当前选曲的真实音频状态；抽屉正在试听另一首时不会把已选音乐显示为播放中。 */
  function playing() { return !!cached && audio.src === cached.item.previewURL && !audio.paused && !audio.ended && !audio.error; }

  /** 清理当前试听查询及地址；不改变作品配乐，也不发起新的查询。 */
  function reset({stopAudio = true, abortPending = true} = {}) {
    const previous = cached;
    if (abortPending) pending?.controller.abort();
    pending = null; cached = null; invalidatedSession = null; refreshSource = false;
    if (stopAudio && previous && audio.src === previous.item.previewURL) stop();
  }

  /** 根据现有选择和真实播放事件回显，不因重绘自动联网。 */
  function render() {
    if (disposed) return;
    const value = current(), identity = key(value);
    if (invalidatedSession && !sameTarget(invalidatedSession, value)) invalidatedSession = null;
    if (pending && !owns(pending)) {
      const job = pending;
      // 同一选曲因本次请求失去账号核验时仍停止后续播放，但保留该请求的错误反馈资格。
      const lostVerification = sameTarget(job, value) && job.accountId && !value.connected && !value.accountId;
      // 保留真实会话错误；主动 abort 会让完整 client/engine 链先把它改写成 AbortError。
      reset({abortPending: !lostVerification});
      if (lostVerification) invalidatedSession = job;
    }
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

  /** 恢复只按平台音乐 ID 查询，名称只是展示；不以名称搜索结果猜测同一首音乐。 */
  async function resolve(job, music) {
    if (typeof music.id !== 'string' || !/^\d{1,30}$/.test(music.id)) throw Error('已选音乐身份无效，请重新选择。');
    requireCurrent(job);
    const item = await request('music.resolve', {id: music.id, ...(refreshSource ? {refreshSource: true} : {})}, {signal: job.controller.signal});
    requireCurrent(job);
    if (!item || item.id !== music.id) throw Error('平台返回的音乐与所选歌曲不一致，已保留原配乐。');
    const previewURL = safeURL(item.previewURL);
    if (!previewURL) throw Error('未能恢复这首音乐的试听音频，已保留原配乐，请重新选择该音乐后重试。');
    refreshSource = false;
    return {...music, ...item, previewURL};
  }

  /** 播放只在明确点击后开始；媒体策略阻止时保留地址，下一次点击同步 play，不重复查询。 */
  async function toggle() {
    if (disposed || pending || blocked?.()) return;
    const value = current();
    invalidatedSession = null;
    if (value.kind !== 'image' || !value.music?.id) return;
    if (cached?.key === key(value)) {
      const active = cached;
      const result = await play(active.item); // 在第一次 await 之前进入 audio.play，保留本次用户激活。
      // play 的 Promise 也可能晚于换稿/换号或另一次试听；旧结果不能更新新入口。
      if (disposed || cached !== active || active.key !== key(current())) return;
      if (result?.code === 'PLAYBACK_GESTURE_REQUIRED') onError?.('已取得试听音频，请再次点击播放。');
      else if (result?.ok === false && result.code !== 'PLAYBACK_CANCELLED') { cached = null; refreshSource = true; onError?.('音乐试听失败，请点击试听重新获取音频。'); }
      render(); return;
    }
    const job = {selection: selection(value), profileId: value.profileId, accountId: value.accountId, controller: new AbortController()};
    pending = job; render();
    try {
      requireCurrent(job);
      const verified = current();
      if (!verified.accountId || !verified.profileId) throw Error('请先选择已保存的抖音账号，再试听已选音乐。');
      job.profileId = verified.profileId; job.accountId = verified.accountId;
      const item = await resolve(job, value.music);
      requireCurrent(job);
      cached = {key: key(verified), item};
      const result = await play(item);
      requireCurrent(job);
      if (result?.code === 'PLAYBACK_GESTURE_REQUIRED') onError?.('已取得试听音频，请再次点击播放。');
      else if (result?.ok === false && result.code !== 'PLAYBACK_CANCELLED' && cached) { cached = null; refreshSource = true; onError?.('音乐试听失败，请点击试听重新获取音频。'); }
    } catch (error) {
      const value = current();
      const sessionFailed = invalidatedSession === job && sameTarget(job, value) && !value.connected && !value.accountId;
      if (sessionFailed) onError?.(error.name === 'AbortError' ? '当前账号需要重新登录后再试听。' : error.message || '当前账号需要重新登录后再试听。');
      else if (owns(job) && error.name !== 'AbortError') onError?.(error.message || '音乐试听未完成，请重试。');
    } finally {
      if (pending === job) pending = null;
      if (invalidatedSession === job) invalidatedSession = null;
      render();
    }
  }

  button.onclick = iconButton.onclick = () => { void toggle(); };
  for (const name of ['play', 'pause', 'playing', 'ended', 'loadedmetadata', 'emptied']) audio.addEventListener(name, render, {signal: listeners.signal});
  audio.addEventListener('error', () => {
    if (cached && audio.src === cached.item.previewURL && audio.error) {
      cached = null; refreshSource = true; onError?.('音乐试听失败，请点击试听重新获取音频。');
    }
    render();
  }, {signal: listeners.signal});
  return {
    render, toggle,
    /** 采用本页刚核验并选中的候选；只保存在当前完整身份下，点击前不查询或播放。 */
    prime(item) {
      const value = current(), previewURL = safeURL(item?.previewURL);
      if (disposed || !value.accountId || !value.profileId || value.kind !== 'image' ||
          !value.music?.id || item?.id !== value.music.id || typeof item.name !== 'string' || !item.name || !previewURL) return false;
      reset();
      cached = {key: key(value), item: {...item, previewURL}};
      render();
      return true;
    },
    /** 主页面切换草稿、账号或清除配乐时同步撤销迟到查询。 */
    reset() { reset(); render(); },
    /** 页面卸载时释放查询与媒体监听；已保存配乐不受影响。 */
    dispose() { if (disposed) return; reset(); disposed = true; listeners.abort(); button.onclick = iconButton.onclick = null; },
  };
}
