'use strict';
// 交接页只检查封套并展示状态；任务字段及素材限制统一由 Chrome 扩展校验。
(() => {
  const status = document.getElementById('status'), help = document.getElementById('help');
  try {
    const job = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    if (!job || job.version !== 1 || typeof job.id !== 'string' || !job.id || !Array.isArray(job.assets)) throw Error();
    document.getElementById('summary').textContent = `本次带入 ${job.assets.length} 项素材`;
    // 扩展接管后不覆盖其进度或错误；未安装时只给出恢复指引，不再次提交任务。
    setTimeout(() => {
      if (document.documentElement.dataset.lumaExtension) return;
      status.textContent = '未检测到配套 Chrome 扩展。请在已安装并启用扩展的 Chrome 中带入。';
      help.hidden = false;
    }, 1500);
  } catch {
    status.textContent = '交接数据无效，请回到 App 重新带入。';
    help.hidden = false;
  }
})();
