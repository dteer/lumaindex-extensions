const phaseLabels = {
  reading: '正在读取', cropping: '正在裁剪', uploading: '正在上传', processing: '正在等待转码',
  uploaded: '上传完成', reused: '已复用上传结果', ready: '视频已就绪', failed: '处理失败', completed: '已完成',
  cancelled: '已停止等待', stopped: '准备已停止',
};
const finishedPhases = new Set(['uploaded', 'reused', 'ready', 'failed', 'completed', 'cancelled', 'stopped']);

// mountPreparationProgress 按用途与素材身份维护单行，不把正文上传计数解释为整次准备进度。
export function mountPreparationProgress({items, progress, current, assetDetails}) {
  const rows = new Map();
  let finished = false;
  items.setAttribute('role', 'list');
  items.setAttribute('aria-label', '素材准备进度');

  // describe 优先使用执行模块的名称；独立封面也能从封面选择或图库详情恢复名称。
  function describe(value, id) {
    const draft = current(), asset = draft.assets.find(item => item.id === id);
    const role = ['image', 'cover', 'video'].includes(value.role) ? value.role
      : value.phase === 'cover' || (!asset && draft.cover?.assetId === id) ? 'cover' : asset?.kind === 'video' ? 'video' : 'image';
    const name = value.assetName || (role === 'cover' && draft.cover?.assetId === id ? draft.cover.name : '')
      || assetDetails.get(id)?.name || asset?.name || '未命名素材';
    return {role, name, label: role === 'cover' ? '封面' : role === 'video' ? '视频' : '正文图片'};
  }

  // paint 只用文本节点更新当前行，已完成或失败的状态不沿用“正在上传”等旧提示。
  function paint(row, phase, message = '') {
    row.phase = phase;
    row.node.dataset.phase = phase;
    row.status.textContent = phase === 'failed' && message ? message : phaseLabels[phase] || message || '正在处理';
  }

  // update 资产事件只改变相应行；只有明确标注 overall 的数值才用于顶部总进度条。
  function update(value) {
    const id = value?.assetId || value?.assetID;
    const overall = !id && value?.scope === 'overall';
    const percent = overall && Number.isFinite(value.percent) ? value.percent
      : overall && Number.isFinite(value.completed) && Number.isFinite(value.total) && value.total > 0 ? value.completed / value.total * 100 : null;
    progress.hidden = percent === null || finished;
    if (percent !== null) progress.value = Math.max(0, Math.min(100, percent));
    if (!id || finished) return;
    const description = describe(value, id), key = JSON.stringify([description.role, id]);
    let row = rows.get(key);
    if (!row) {
      const node = document.createElement('div'), name = document.createElement('span'), status = document.createElement('span');
      node.className = 'preparation-progress-row'; node.setAttribute('role', 'listitem');
      node.dataset.assetId = id; node.dataset.role = description.role;
      name.className = 'preparation-progress-name'; status.className = 'preparation-progress-status';
      node.append(name, status); items.append(node);
      row = {node, name, status, phase: ''}; rows.set(key, row);
    }
    row.name.textContent = `${description.label} · ${description.name}`;
    paint(row, value.phase || '', value.message);
  }

  // finish 保留各素材的成功/失败事实，只结束仍在进行中的行，避免失败或取消覆盖成功上传。
  function finish(outcome) {
    finished = true; progress.hidden = true;
    for (const row of rows.values()) {
      if (!finishedPhases.has(row.phase)) paint(row, outcome === 'completed' ? 'completed' : outcome === 'cancelled' ? 'cancelled' : 'stopped');
    }
  }

  // reset 仅在新一轮准备或切换草稿时清理，普通表单渲染不丢失本轮结果。
  function reset() { rows.clear(); items.replaceChildren(); progress.hidden = true; progress.value = 0; finished = false; }

  return {update, finish, reset};
}
