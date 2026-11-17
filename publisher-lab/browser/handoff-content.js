'use strict';
// 本机交接页自动提交一次完整任务；不提供旧的分步上传入口，也不操作网站组件。
(() => {
  if (location.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(location.hostname) ||
      location.pathname !== '/api/v1/plugins/com.lumaindex.douyin.studio/files/handoff.html') return;
  const state = document.documentElement.dataset;
  state.lumaStudioExtension = '1';
  if (state.lumaStudioHandoffSubmitted) return;
  state.lumaStudioHandoffSubmitted = '1';
  const status = document.getElementById('status'), help = document.getElementById('help');
  // fail 使用用户可操作的提示，不暴露 Chrome 内部异常，也不自动重发结果未知的任务。
  function fail(message) {
    if (status) status.textContent = message;
    if (help) help.hidden = false;
  }
  let job;
  try {
    job = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    if (!job || job.version !== 1 || typeof job.id !== 'string' || !job.id || !Array.isArray(job.assets)) throw Error();
  } catch {
    fail('交接数据无效，请回到 App 重新带入。');
    return;
  }
  if (status) status.textContent = '正在自动进入抖音并准备素材…';
  if (help) help.hidden = true;
  try {
    chrome.runtime.sendMessage({op:'studio-continue', job}).then(response => {
      if (!response?.ok) fail(typeof response?.error === 'string' && response.error ? response.error : '带入未完成，请先检查抖音页面，再从 App 重新带入。');
      else if (status) status.textContent = '草稿已带入抖音，可以继续编辑并手动发布。';
    }).catch(() => fail('浏览器交接已中断，请先检查抖音页面，再从 App 重新带入。'));
  } catch {
    fail('Chrome 扩展暂不可用，请重新启用扩展，再从 App 重新带入。');
  }
})();
