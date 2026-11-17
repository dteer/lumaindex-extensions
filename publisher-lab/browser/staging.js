// token 只标识本次准备页，完整任务与本机来源均由扩展后台按标签页验证后提供。
const token = new URL(location.href).searchParams.get('token');
// previewState 保存当前页面的缩略图和选中预览；离页时统一释放对象 URL，不保存素材副本。
const previewState = {job:null, origin:null, items:[], urls:new Set(), selected:0, coverIndex:0, disposed:false, controller:new AbortController(), liveProgress:0};
// StagingError 标识由本准备页定义、可直接展示的中文业务错误，内部浏览器异常不进入界面。
class StagingError extends Error {}
// element 访问扩展自有文档，不查询或调用抖音的前端组件。
function element(id) { return document.getElementById(id); }

// setProgress 只更新独立状态区域，错误不会替换或清空已展示的素材、文案和设置。
function setProgress(progress = {}) {
  const failed = progress.failed === true || progress.error === true || progress.state === 'failed';
  const complete = !failed && (progress.complete === true || progress.state === 'complete');
  element('progress-panel').classList.toggle('failed', failed);
  element('progress-panel').classList.toggle('complete', complete);
  element('progress-panel').setAttribute('role', failed ? 'alert' : 'status');
  element('progress-message').textContent = typeof progress.message === 'string' && progress.message ? progress.message : '正在准备作品…';
  element('progress-details').textContent = typeof progress.details === 'string' ? progress.details : '';
  element('progress-label').textContent = failed ? '未完成' : complete ? '已就绪' : '带入中';
}

// selectPreview 仅切换本地缩略图查看，不改变任务中的素材顺序或选择。
function selectPreview(index) {
  const item = previewState.items[index];
  if (!item || previewState.disposed) return;
  previewState.selected = index;
  for (const [position,entry] of previewState.items.entries()) entry.button.setAttribute('aria-pressed',String(position === index));
  element('preview-count').textContent = `${index + 1} / ${previewState.items.length}`;
  element('preview-filename').textContent = item.asset.name;
  const image = element('preview-image');
  image.hidden = !item.url;
  element('preview-placeholder').hidden = Boolean(item.url);
  if (item.url) { image.src = item.url; image.alt = item.asset.name; }
  else image.removeAttribute('src');
}

// scheduledText 按当前浏览器时区展示 App 已确定的发布时间，不重新计算或提交时间。
function scheduledText(settings) {
  if (settings.publishTime !== 'scheduled') return '立即发布';
  const date = new Date(settings.scheduledAt);
  if (!Number.isFinite(date.getTime())) return '定时发布 · 未填写有效时间';
  const pad = value => String(value).padStart(2,'0');
  const value = `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return `定时发布 · ${value}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
}

// validateContext 拒绝任意下载地址；页面只读取固定本机 API 下的素材预览，不请求原图。
function validateContext(context) {
  const job = context?.job;
  let origin;
  try { origin = new URL(context?.origin); } catch { throw new StagingError('无法确认本次素材来源，请从 App 重新带入。'); }
  if (!context?.ok || origin.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(origin.hostname) || origin.username || origin.password || context.origin !== origin.origin) throw new StagingError('无法确认本次素材来源，请从 App 重新带入。');
  if (!job || !['image','video'].includes(job.kind) || typeof job.title !== 'string' || typeof job.description !== 'string' || !Array.isArray(job.assets) || !job.assets.length || job.assets.length > (job.kind === 'video' ? 1 : 35) || job.assets.some(asset=>!asset || typeof asset.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(asset.id) || typeof asset.name !== 'string')) throw new StagingError('本次作品信息不完整，请从 App 重新带入。');
  return {job,origin:origin.origin};
}

// renderContext 先同步呈现完整文字和素材占位，再异步读取缩略图；上传状态不阻塞作品信息显示。
function renderContext(context) {
  const {job,origin} = validateContext(context);
  previewState.job = job; previewState.origin = origin;
  const settings = job.settings || {}, image = job.kind === 'image';
  const index = Number.isInteger(settings.coverIndex) ? settings.coverIndex : 0;
  previewState.coverIndex = index >= 0 && index < job.assets.length ? index : 0;
  element('kind-label').textContent = image ? '发布图文' : '发布视频';
  element('work-title').value = job.title;
  element('work-description').value = job.description;
  element('title-count').textContent = `${job.title.length} / 20`;
  element('description-count').textContent = `${job.description.length} / 1000`;
  element('media-heading').textContent = image ? '图片内容' : '视频内容';
  element('media-count').textContent = image ? `${job.assets.length} 张图片` : '1 个视频';
  element('preview-title').textContent = job.title || '未填写标题';
  element('preview-description').textContent = job.description || '未填写作品描述';
  element('visibility').textContent = {public:'公开',friends:'好友可见',private:'仅自己可见'}[settings.visibility || 'public'] || '未设置';
  element('download').textContent = settings.download === 'deny' ? '不允许保存' : '允许保存';
  element('publish-time').textContent = scheduledText(settings);
  const place = settings.location;
  element('location').textContent = place?.name ? [place.cityName,place.name].filter(Boolean).join(' · ') : '未添加位置';
  element('collection').textContent = settings.collection?.title || '未加入合集';
  element('video-badge').hidden = image;
  element('cover-row').hidden = !image;
  if (image) {
    element('cover-name').textContent = job.assets[previewState.coverIndex].name;
    element('cover-note').textContent = settings.coverCrop ? '使用 App 中确认的裁剪' : '使用首张图片';
  }
  const grid = element('media-grid'); grid.replaceChildren();
  previewState.items = job.assets.map((asset,index)=>{
    const card = document.createElement('figure'), button = document.createElement('button');
    card.className = 'asset-card'; button.className = 'asset-button'; button.type = 'button';
    button.setAttribute('aria-label',`查看第 ${index+1} 项：${asset.name}`);
    const placeholder = document.createElement('span'); placeholder.className = 'asset-placeholder'; placeholder.textContent = '读取预览…';
    const thumbnail = document.createElement('img'); thumbnail.hidden = true; thumbnail.alt = asset.name; thumbnail.decoding = 'async';
    const number = document.createElement('span'); number.className = 'asset-number'; number.textContent = String(index+1);
    button.append(placeholder,thumbnail,number);
    if (image && index === previewState.coverIndex) { const badge = document.createElement('span'); badge.className = 'asset-cover'; badge.textContent = '封面'; button.append(badge); }
    const name = document.createElement('figcaption'); name.className = 'asset-name'; name.textContent = asset.name; name.title = asset.name;
    button.addEventListener('click',()=>selectPreview(index));
    card.append(button,name); grid.append(card);
    return {asset,button,placeholder,thumbnail,url:null};
  });
  element('loading').hidden = true; element('content').hidden = false;
  selectPreview(0);
}

// readPreview 限制预览响应为 4 MiB，并禁止重定向或发送凭据；失败不回退读取原图。
async function readPreview(asset) {
  const url = `${previewState.origin}/api/v1/assets/${encodeURIComponent(asset.id)}/preview?size=400`;
  const response = await fetch(url,{credentials:'omit',redirect:'error',signal:AbortSignal.any([previewState.controller.signal,AbortSignal.timeout(15000)])});
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const limit = 4*1024*1024;
  if (!response.ok || !response.body || !/^image\/(jpeg|png|webp|gif|avif)$/.test(mime || '') || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel(); throw Error('preview unavailable');
  }
  const reader = response.body.getReader(), parts = []; let size = 0;
  try {
    while (true) { const {value,done} = await reader.read(); if (done) break; size += value.length; if (size > limit) throw Error('preview too large'); parts.push(value); }
  } catch (error) { await reader.cancel(); throw error; }
  finally { reader.releaseLock(); }
  if (!size) throw Error('empty preview');
  return new Blob(parts,{type:mime});
}

// renderCover 使用已下载缩略图显示裁剪区域，绝不为封面预览再次读取原图。
function renderCover(source) {
  const target = element('cover-preview'), crop = previewState.job.settings?.coverCrop;
  if (crop && ['x','y','width','height'].every(key=>Number.isFinite(crop[key])) && crop.x>=0 && crop.y>=0 && crop.width>0 && crop.height>0 && crop.x+crop.width<=1.000001 && crop.y+crop.height<=1.000001) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1,Math.round(source.naturalWidth*crop.width));
    canvas.height = Math.max(1,Math.round(source.naturalHeight*crop.height));
    canvas.getContext('2d').drawImage(source,source.naturalWidth*crop.x,source.naturalHeight*crop.y,source.naturalWidth*crop.width,source.naturalHeight*crop.height,0,0,canvas.width,canvas.height);
    target.replaceChildren(canvas);
  } else { const image = document.createElement('img'); image.src = source.src; image.alt = ''; target.replaceChildren(image); }
}

// loadPreviews 最多四个请求并发，每张失败独立保留名称占位；不会影响后台上传与其他图片展示。
async function loadPreviews() {
  let next = 0;
  async function readNext() {
    while (!previewState.disposed && next < previewState.items.length) {
      const index = next++, item = previewState.items[index];
      try {
        const blob = await readPreview(item.asset);
        if (previewState.disposed) return;
        const url = URL.createObjectURL(blob); previewState.urls.add(url);
        item.thumbnail.src = url;
        await item.thumbnail.decode();
        if (previewState.disposed) return;
        item.url = url; item.thumbnail.hidden = false; item.placeholder.hidden = true;
        if (previewState.selected === index) selectPreview(index);
        if (previewState.job.kind === 'image' && previewState.coverIndex === index) renderCover(item.thumbnail);
      } catch {
        if (previewState.disposed) return;
        item.placeholder.textContent = '预览暂不可用';
      }
    }
  }
  await Promise.allSettled(Array.from({length:Math.min(4,previewState.items.length)},()=>readNext()));
}

// cleanup 在离页时取消未完成的预览请求并释放全部对象 URL，防止下一份作品继承媒体缓存。
function cleanup() {
  previewState.disposed = true; previewState.controller.abort();
  for (const url of previewState.urls) URL.revokeObjectURL(url);
  previewState.urls.clear();
  chrome.runtime.onMessage.removeListener(receiveProgress);
}
// receiveProgress 仅接受扩展自身发送且 token 匹配的更新，不接受窗口 postMessage 或任意网站输入。
function receiveProgress(message,sender) {
  if (sender.id !== chrome.runtime.id || message?.op !== 'studio-staging-progress' || message.token !== token || previewState.disposed) return;
  previewState.liveProgress++; setProgress(message);
}
chrome.runtime.onMessage.addListener(receiveProgress);
window.addEventListener('pagehide',cleanup,{once:true});

// initialize 只请求本次任务一次；后台拒绝后保留错误，不自行创建上传或发布请求。
async function initialize() {
  try {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token || '')) throw new StagingError('此带入页面已失效，请从 App 重新带入。');
    let context;
    try { context = await chrome.runtime.sendMessage({op:'studio-staging-context',token}); }
    catch { throw new StagingError('发布页连接已中断，请从 App 重新带入。'); }
    if (previewState.disposed) return;
    if (!context?.ok) throw new StagingError('无法读取本次带入任务，请从 App 重试。');
    renderContext(context);
    if (!previewState.liveProgress) setProgress(context.progress || {message:'正在准备素材…',details:'完成后可以使用抖音原生控件继续编辑。'});
    await loadPreviews();
  } catch (error) {
    if (previewState.disposed) return;
    setProgress({failed:true,message:error instanceof StagingError ? error.message : '发布页连接已中断，请从 App 重新带入。',details:'已展示的内容会保留。请保持有序图库运行。'});
    element('loading').textContent = '暂时无法读取作品内容，请从 App 重新带入。';
  }
}
initialize();
