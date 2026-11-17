// throwIfCancelled 在读取和网络阶段之间停止任务；不代表已送达平台的写入被撤销。
export function throwIfCancelled(signal) {
  if (signal?.aborted) throw new DOMException('操作已停止；已送达平台的请求请核对结果。', 'AbortError');
}

// combineSignals 将用户取消与每次请求原有超时同时交给实际传输。
export function combineSignals(...values) {
  const signals = values.filter(Boolean);
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}

// cancellableWait 只用于视频状态轮询，取消后清除定时器，不再发起下一次查询。
export function cancellableWait(milliseconds, signal) {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new DOMException('操作已停止。', 'AbortError')); };
    signal?.addEventListener('abort', cancel, {once: true});
  });
}
