import {studioClient as client} from './studio-client.js';
import {StudioStore, contentSignature, entityValue, newID, publicationDraft} from './studio-state.js';
import {editCoverCrop} from './cover-crop.js';
import {generateCopy} from './ai-copy.js';
import {selectLibraryAssets} from './library-selection.js';

const $ = id => document.getElementById(id);
const operationNames = {
  'publication.prepare': '素材上传与检查', 'publication.publish': '最终发布', 'publication.status': '发布状态',
  'topics.search': '真实话题', 'users.search': '提及用户', 'music.search': '推荐音乐与链接',
  'locations.search': '城市与地点', 'collections.list': '普通合集', 'cover.upload': '图库图片封面', 'cover.frames': '视频帧封面',
};
const receiptTitles = {published: '作品已发布', scheduled: '已提交定时发布', processing: '平台正在处理', failed: '发布未完成', unknown: '发布结果待确认'};

// resolveContext 同时支持原生插件与已安装插件的本机 HTTP 预览，不向任意主机读取图库。
function resolveContext() {
  const context = {...(window.pluginContext || {})};
  if (!context.apiBaseURL && ['127.0.0.1', 'localhost'].includes(location.hostname) && location.protocol === 'http:') {
    const prefix = location.pathname.split('/plugins/')[0];
    if (prefix === '/api/v1') context.apiBaseURL = location.origin + prefix;
  }
  if (context.apiBaseURL) {
    try {
      const url = new URL(context.apiBaseURL);
      if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/api/v1' || url.username || url.password || url.search || url.hash) delete context.apiBaseURL;
    } catch { delete context.apiBaseURL; }
  }
  return context;
}

const context = resolveContext();
const storageKey = 'luma.douyin.studio.frontend:' + (context.libraryID || context.apiBaseURL || 'file-preview');
let initialState = context.frontendState;
let storageError = '';
if (!context.nativeUIAvailable) {
  try { initialState = JSON.parse(localStorage.getItem(storageKey) || '{}'); }
  catch { storageError = '本机草稿读取失败，重新保存前请确认当前内容。'; }
}
const store = new StudioStore(initialState, async value => {
  if (context.nativeUIAvailable) {
    if (!window.webkit?.messageHandlers?.pluginUI?.postMessage) throw Error('宿主保存接口不可用，请保持页面并重试。');
    const result = await window.webkit.messageHandlers.pluginUI.postMessage({op: 'persist', value});
    if (result?.ok === false || result?.error) throw Error(result.error || '宿主没有保存草稿。');
  } else {
    localStorage.setItem(storageKey, JSON.stringify(value));
  }
});
const assetDetails = new Map();
const transientMedia = new Map();
const resourcePreviews = new Map();
const publicationLinks = new Map();
let session = {connected: false, account: null, capabilities: {operations: []}};
let prepared = null;
let busy = false;
let busyKind = '';
let operationController = null;
let focusID = null;
let draggingID = null;
let previewKey = '';
let renderedDraftId = null;
let saving = false;
let saveTimer = null;
let noticeTimer = null;
let connecting = false;
let sessionRefreshing = null;
let searchState = null;
let searchController = null;
let searchGeneration = 0;
let searchOpening = false;
let cities = null;
let aiController = null;
let aiResult = null;

// element 通过 textContent 构造界面，不把账号、文件名或平台返回内容插入 HTML。
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

// safeURL 仅允许 HTTPS 平台资源和当前图库的本机 URL，拒绝脚本和带凭据地址。
function safeURL(value, allowBlob = false) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value, location.href);
    if (url.username || url.password) return '';
    if (allowBlob && url.protocol === 'blob:' && [...transientMedia.values()].some(item => item.url === url.href)) return url.href;
    if (url.protocol === 'https:') return url.href;
    if (context.apiBaseURL && url.origin === new URL(context.apiBaseURL).origin && url.protocol === 'http:') return url.href;
  } catch {}
  return '';
}

// supports 只接受独立执行模块确认的可用能力，不依据按钮存在或缓存猜测成功。
function supports(operation) {
  if (operation === 'music.search' && current().kind === 'video') return false;
  if (session.capabilities?.byKind?.[current().kind]?.disabledOperations?.includes(operation)) return false;
  return session.connected === true && Array.isArray(session.capabilities?.operations) && session.capabilities.operations.includes(operation);
}

// current 返回当前作品，所有编辑和提交都显式绑定这份草稿。
function current() { return store.current(); }

// currentAssetIDs 同时恢复正文与独立图库封面，封面不必属于正文图片。
function currentAssetIDs() {
  return [...new Set([...current().assets.map(asset => asset.id), ...(current().cover?.assetId ? [current().cover.assetId] : [])])];
}

// notice 以轻量反馈显示结果；普通提示自动收起，错误持续保留供用户处理。
function notice(message = '', error = false) {
  clearTimeout(noticeTimer);
  $('page-notice').hidden = !message;
  $('page-notice').textContent = message;
  $('page-notice').classList.toggle('error', error);
  $('page-notice').setAttribute('role', error ? 'alert' : 'status');
  if (message && !error) noticeTimer = setTimeout(() => { $('page-notice').hidden = true; fitWorkspace(); }, 6000);
  fitWorkspace();
}

// fitWorkspace 使用页面自然滚动，提示和抽屉不会截断表单或底部操作。
function fitWorkspace() {
  document.querySelector('.workspace').style.removeProperty('height');
}

// markChanged 废弃过期准备结果并保存恢复副本；不触发上传或联网发布。
function markChanged({content = true} = {}) {
  if (content) prepared = null;
  store.touch();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void saveDraft(false); }, 450);
  renderSaveState();
  renderDrafts();
  renderPreview();
  renderActions();
}

// saveDraft 等待持久化应答后显示成功，保留失败草稿供再次保存。
async function saveDraft(explicit = true) {
  clearTimeout(saveTimer);
  saving = true;
  renderSaveState();
  try {
    await store.commit();
    storageError = '';
    if (explicit) notice('草稿已保存至本机。');
    return true;
  } catch (error) {
    storageError = error.message || '草稿保存失败，请保持页面并重试。';
    if (explicit) notice(storageError, true);
    return false;
  } finally {
    saving = false;
    renderSaveState();
  }
}

// renderSaveState 显示写入中、未保存和确认保存后的真实状态。
function renderSaveState() {
  $('save-state').textContent = storageError ? '保存失败 · 点击保存重试' : saving ? '正在保存…' : store.savedRevision < store.revision ? '有未保存修改' : store.revision === 0 && !initialState?.drafts?.length ? '新草稿 · 等待编辑' : '已保存至本机';
  $('save-state').title = storageError;
  $('save-draft').disabled = saving || busy;
}

// renderDrafts 展示所有本机作品，不把其他草稿的上传/发布状态复用于当前作品。
function renderDrafts() {
  $('draft-list').replaceChildren();
  $('draft-total').textContent = store.data.drafts.length;
  for (const draft of store.data.drafts) {
    const button = element('button', 'draft-item');
    button.setAttribute('aria-current', String(draft.id === current().id));
    button.disabled = busy;
    const text = element('span', 'draft-text');
    text.append(element('strong', '', draft.name || draft.title || '未命名作品'));
    text.append(element('small', '', `${draft.kind === 'image' ? '图文' : '视频'} · ${draft.assets.length} 项${draft.receipt ? ' · ' + receiptTitles[draft.receipt.status] : ''}`));
    button.append(element('span', 'draft-icon', draft.kind === 'image' ? '▧' : '▷'), text);
    button.onclick = () => { void switchDraft(draft.id); };
    $('draft-list').append(button);
  }
}

// switchDraft 切换前保留现有修改；准备结果只在其所属草稿中有效。
async function switchDraft(id) {
  if (busy || id === current().id) return;
  if (!(await saveDraft(false))) { notice(storageError, true); return; }
  $('drafts-dialog').close();
  stopMusic();
  store.data.activeDraftId = id;
  prepared = null;
  focusID = null;
  store.touch();
  render();
  await hydrateAssets(currentAssetIDs());
  renderMedia();
  renderCover();
  renderPreview();
  void saveDraft(false);
}

// newDraft 只创建本机空白作品，达到上限时提示且保留所有草稿。
function newDraft(kind) {
  if (busy) return;
  try {
    store.add(kind);
    $('drafts-dialog').close();
    prepared = null;
    focusID = null;
    stopMusic();
    render();
    void saveDraft(false);
  } catch (error) { notice(error.message, true); }
}

// mediaURL 根据图库身份读取预览；本机文件只使用当次选择产生的临时对象 URL。
function mediaURL(asset, size = 'thumbnail') {
  if (!asset) return '';
  if (asset.localOnly) return transientMedia.get(asset.id)?.url || '';
  if (!context.apiBaseURL) return '';
  const suffix = size === 'preview' ? 'preview?size=2048' : size;
  return `${context.apiBaseURL}/assets/${encodeURIComponent(asset.id)}/${suffix}`;
}

// mediaImage 创建失败可识别的缩略图，不读取原图作为静默降级。
function mediaImage(asset, size = 'thumbnail') {
  const image = element('img');
  image.alt = asset.name || '图片';
  image.loading = 'lazy';
  const url = mediaURL(asset, size);
  if (url) image.src = url;
  image.onerror = () => { image.replaceWith(element('span', 'helper', '预览不可用')); };
  return image;
}

// hydrateAssets 从图库查询实际素材类型与名称，失败会保留可见占位供用户处理。
async function hydrateAssets(ids) {
  if (!context.apiBaseURL) return [];
  const result = [];
  for (const id of [...new Set(ids)].slice(0, 100)) {
    if (id.startsWith('local:')) continue;
    try {
      const response = await fetch(`${context.apiBaseURL}/assets/${encodeURIComponent(id)}`, {signal: AbortSignal.timeout(15000)});
      const payload = await response.json();
      if (!response.ok || payload.code !== 0) throw Error(payload.message || '素材不可用');
      const data = payload.data;
      if (data.livePhoto?.imageAssetId && data.livePhoto.imageAssetId !== id) {
        const linked = await hydrateAssets([data.livePhoto.imageAssetId]);
        result.push(...linked);
        continue;
      }
      if (!['image', 'video'].includes(data.mediaType)) continue;
      const asset = {id: data.id || id, name: data.name || data.fileName || id, kind: data.mediaType};
      assetDetails.set(asset.id, {...asset, sizeBytes: data.sizeBytes, error: ''});
      result.push(asset);
    } catch (error) {
      assetDetails.set(id, {id, error: error.message || '素材读取失败'});
    }
  }
  return result;
}

// chooseLibrary 从原生来源网格确认素材，等待期间保持当前草稿和同一插件上下文。
async function chooseLibrary(target = 'media') {
  if (busy || connecting) return;
  setBusy(true, 'selecting');
  try {
    const result = await selectLibraryAssets({target, context, currentDraft: current,
      save: () => saveDraft(false),
      post: message => window.webkit?.messageHandlers?.pluginUI?.postMessage(message),
      resolveAssets: hydrateAssets, imageLimit: session.capabilities?.limits?.imageCount || 35});
    if (result.cancelled) return;
    if (result.draftId !== current().id) throw Error('作品已变化，所选素材未加入。请重新选择。');
    if (!result.assets.length) { notice('所选素材已在当前作品中，未重复添加。'); return; }
    if (result.target === 'cover') {
      const asset = result.assets[0];
      if (current().cover?.type === 'asset' && current().cover.assetId === asset.id) return;
      current().cover = {type: 'asset', assetId: asset.id, name: asset.name};
    } else {
      current().assets.push(...result.assets);
      focusID = result.assets[0].id;
    }
    markChanged();
    if (await saveDraft(false)) notice(result.target === 'cover' ? '封面已添加。' : `已添加 ${result.assets.length} 项素材。`);
    else notice(storageError, true);
  } catch (error) { notice(error.message || '素材选择未完成，请重试。', true); }
  finally { setBusy(false); render(); }
}

// importHost 按实际媒体类型导入；混合素材进入独立作品，不覆盖已有文案或草稿。
async function importHost({initial = false} = {}) {
  const incoming = Array.isArray(context.selectedAssetIDs) ? context.selectedAssetIDs : [];
  if (busy || !incoming.length || !context.apiBaseURL) return;
  const transferID = context.transferID;
  if (initial && transferID && store.data.handledTransfers.includes(transferID)) return;
  setBusy(true, 'reading');
  activity('正在读取本次带入素材…');
  try {
    const assets = await hydrateAssets(incoming);
    if (!assets.length) throw Error('没有可用的图片或视频，请在图库选择素材后重新带入。');
    const previousID = current().id;
    let firstID = null;
    for (const kind of ['image', 'video']) {
      const items = assets.filter(asset => asset.kind === kind);
      if (!items.length) continue;
      let target = current();
      if (target.kind !== kind || (initial && (target.assets.length || target.title || target.description))) target = store.add(kind);
      if (!firstID) firstID = target.id;
      const ids = new Set(target.assets.map(asset => asset.id));
      target.assets.push(...items.filter(asset => !ids.has(asset.id)));
      if (!target.title && /未命名/.test(target.name)) target.name = items[0].name.replace(/\.[^.]+$/, '').slice(0, 100);
    }
    store.data.activeDraftId = firstID || previousID;
    if (transferID) store.data.handledTransfers = [...store.data.handledTransfers.filter(id => id !== transferID), transferID].slice(-50);
    store.touch();
    prepared = null;
    activity(`已读取 ${assets.length} 项素材，尚未上传。`);
    await saveDraft(false);
    if (assets.length < incoming.length) notice('部分素材无法读取或不是图片/视频，请检查图库中的素材。');
  } catch (error) { notice(error.message, true); activity(error.message); }
  finally { setBusy(false); render(); }
}

// renderMedia 把素材顺序、移除和预览焦点分开，未加载资源始终显示真实问题。
function renderMedia() {
  const draft = current();
  if (!draft.assets.some(asset => asset.id === focusID)) focusID = draft.assets[0]?.id || null;
  $('media-count').textContent = `${draft.assets.length} / ${draft.kind === 'video' ? 1 : session.capabilities?.limits?.imageCount || 35}`;
  const editing = draft.assets.length > 0 || !!draft.title || !!draft.description || !!draft.receipt;
  document.body.dataset.phase = editing ? 'editing' : 'upload';
  document.body.dataset.kind = draft.kind;
  const video = draft.kind === 'video';
  $('upload-title').textContent = video ? '选择视频，开始发布作品' : '选择图片，开始发布图文';
  $('upload-button-label').textContent = video ? '选择图库视频' : '选择图库图片';
  $('spec-size-title').textContent = video ? '视频大小和格式' : '图片大小和格式';
  $('spec-size-description').textContent = video ? '当前插件支持 MP4、MOV、WebM，单个视频不超过 80 MiB。' : '支持 JPEG、PNG、WebP，每张图片不超过 50 MiB。';
  $('spec-quality-title').textContent = video ? '视频画质' : '图片数量';
  $('spec-quality-description').textContent = video ? '保留图库原始视频文件，上传后由平台完成转码。' : '每篇图文可添加 1–35 张图片，支持调整顺序和编辑封面。';
  $('spec-ratio-title').textContent = video ? '视频画幅' : '作品素材';
  $('spec-ratio-description').textContent = video ? '上传前可在右侧预览画面，并为视频选择图库图片封面。' : '选择图库内的原始素材，上传前可预览并核对作品内容。';
  $('media-heading').textContent = video ? '编辑视频' : '编辑图片';
  document.querySelector('.preview-heading strong').textContent = video ? '预览视频' : '预览图文';
  $('media-empty').hidden = editing;
  $('media-grid').replaceChildren();
  draft.assets.forEach((asset, index) => {
    const card = element('article', 'media-card' + (asset.id === focusID ? ' selected' : ''));
    const thumbnail = element('button', 'media-thumb');
    thumbnail.setAttribute('aria-label', `预览 ${asset.name}`);
    thumbnail.setAttribute('aria-pressed', String(asset.id === focusID));
    const failure = assetDetails.get(asset.id)?.error || (asset.localOnly && !transientMedia.has(asset.id) ? '本机预览需重新选择文件' : '');
    if (failure) thumbnail.append(element('span', 'helper', '素材不可用'));
    else if (asset.kind === 'image') thumbnail.append(mediaImage(asset));
    else thumbnail.append(element('span', 'video-symbol', '▷'));
    thumbnail.title = failure || asset.name;
    thumbnail.onclick = () => { focusID = asset.id; renderMedia(); renderPreview(); };
    const remove = element('button', 'remove', '×');
    remove.setAttribute('aria-label', `移除 ${asset.name}`);
    remove.onclick = () => {
      if (busy) return;
      draft.assets = draft.assets.filter(item => item.id !== asset.id);
      if (draft.cover?.assetId === asset.id) draft.cover = null;
      markChanged(); renderMedia(); renderCover();
    };
    card.append(thumbnail, element('span', 'media-index', index + 1), remove, element('span', 'asset-name', asset.name));
    card.draggable = draft.kind === 'image' && !busy;
    card.ondragstart = event => { draggingID = asset.id; card.classList.add('dragging'); event.dataTransfer.setData('text/plain', asset.id); event.dataTransfer.effectAllowed = 'move'; };
    card.ondragover = event => { if (draggingID) event.preventDefault(); };
    card.ondrop = event => {
      event.preventDefault();
      if (!draggingID || busy) return;
      const from = draft.assets.findIndex(item => item.id === draggingID);
      const to = draft.assets.findIndex(item => item.id === asset.id);
      if (from >= 0 && to >= 0 && from !== to) { const [moving] = draft.assets.splice(from, 1); draft.assets.splice(to, 0, moving); focusID = moving.id; markChanged(); renderMedia(); }
      draggingID = null;
    };
    card.ondragend = () => { draggingID = null; card.classList.remove('dragging'); };
    $('media-grid').append(card);
  });
  const index = draft.assets.findIndex(asset => asset.id === focusID);
  $('move-left').disabled = busy || index <= 0;
  $('move-right').disabled = busy || index < 0 || index >= draft.assets.length - 1;
  $('open-media-preview').disabled = !draft.assets.length;
  $('media-note').textContent = draft.assets.some(asset => asset.localOnly) ? '本机文件仅用于预览；发布素材需先加入图库。' : draft.kind === 'video' ? '每份视频作品保留一个视频' : '拖动调整顺序 · 单击预览';
  $('preview-file-label').hidden = !!context.nativeUIAvailable;
  $('import-host').hidden = !context.apiBaseURL || !context.selectedAssetIDs?.length;
  $('import-host').disabled = busy || !context.selectedAssetIDs?.length;
}

// moveMedia 为键盘与不使用拖动的用户提供显式前移/后移。
function moveMedia(delta) {
  if (busy) return;
  const assets = current().assets;
  const index = assets.findIndex(asset => asset.id === focusID);
  if (index < 0 || index + delta < 0 || index + delta >= assets.length) return;
  const [asset] = assets.splice(index, 1);
  assets.splice(index + delta, 0, asset);
  markChanged(); renderMedia();
}

// renderPreview 只展示实际作品字段和已验证账号，不捏造昵称、点赞数或平台结果。
function renderPreview() {
  const draft = current();
  const asset = draft.assets.find(item => item.id === focusID) || draft.assets[0];
  const index = draft.assets.indexOf(asset);
  const key = `${draft.id}:${asset?.id || ''}:${asset?.kind || ''}:${assetDetails.get(asset?.id)?.error || ''}`;
  if (previewKey !== key) {
    previewKey = key;
    $('preview-stage').replaceChildren();
    const url = mediaURL(asset, asset?.kind === 'video' ? 'original' : 'preview');
    if (!asset || !url) $('preview-stage').append(element('div', 'preview-placeholder', asset ? '预览不可用，请重新选择素材' : '素材预览'));
    else if (assetDetails.get(asset.id)?.error) $('preview-stage').append(element('div', 'preview-placeholder', '素材暂不可用'));
    else if (asset.kind === 'image') $('preview-stage').append(mediaImage(asset, 'preview'));
    else {
      const video = element('video');
      video.src = url; video.controls = true; video.playsInline = true; video.preload = 'metadata';
      $('preview-stage').append(video);
    }
  }
  $('preview-position').textContent = `${asset ? index + 1 : 0} / ${draft.assets.length}`;
  $('preview-previous').disabled = !asset || index <= 0;
  $('preview-next').disabled = !asset || index >= draft.assets.length - 1;
  $('preview-title').textContent = draft.title;
  $('preview-description').textContent = draft.description;
  $('preview-tags').textContent = [...draft.topics.map(item => '#' + item.name), ...draft.mentions.map(item => '@' + item.name)].join('  ');
  $('preview-account-name').textContent = session.account?.name || '尚未验证发布账号';
  $('account-avatar').replaceChildren();
  const avatar = safeURL(session.account?.avatarURL);
  if (avatar) { const image = element('img'); image.src = avatar; image.alt = ''; $('account-avatar').append(image); }
  else $('account-avatar').textContent = '○';
  $('title-count').textContent = `${draft.title.length} / ${session.capabilities?.limits?.titleLength || 20}`;
  $('description-count').textContent = `${draft.description.length} / ${session.capabilities?.limits?.descriptionLength || 1000}`;
}

// stepPreview 只更改正在查看的素材，不改动发布顺序。
function stepPreview(delta) {
  const assets = current().assets;
  const index = assets.findIndex(asset => asset.id === focusID);
  const asset = assets[index + delta];
  if (asset) { focusID = asset.id; renderMedia(); renderPreview(); }
}

// openMediaPreview 在窄窗口中也提供完整素材查看，浏览不会更改作品顺序。
function openMediaPreview() {
  if (!current().assets.length) return;
  const dialog = element('dialog', 'media-preview-dialog');
  const heading = element('div', 'dialog-header');
  const title = element('h2', '', '素材预览');
  const close = element('button', '', '×'); close.setAttribute('aria-label', '关闭素材预览');
  close.onclick = () => dialog.close(); heading.append(title, close);
  const stage = element('div', 'expanded-media');
  const actions = element('div', 'preview-navigation');
  const previous = element('button', '', '← 上一张');
  const position = element('span');
  const next = element('button', '', '下一张 →');
  actions.append(previous, position, next);
  // draw 始终从当前顺序读取素材，离开图片时销毁播放器，避免后台播放。
  function draw() {
    const assets = current().assets;
    const asset = assets.find(item => item.id === focusID) || assets[0];
    const index = assets.indexOf(asset);
    stage.replaceChildren(); title.textContent = asset.name;
    if (asset.kind === 'image') stage.append(mediaImage(asset, 'preview'));
    else { const video = element('video'); video.src = mediaURL(asset, 'original'); video.controls = true; video.playsInline = true; stage.append(video); }
    position.textContent = `${index + 1} / ${assets.length}`;
    previous.disabled = index <= 0; next.disabled = index >= assets.length - 1;
  }
  previous.onclick = () => { stepPreview(-1); draw(); };
  next.onclick = () => { stepPreview(1); draw(); };
  dialog.onkeydown = event => {
    if (current().kind === 'image' && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); stepPreview(event.key === 'ArrowLeft' ? -1 : 1); draw(); }
  };
  dialog.append(heading, stage, actions);
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog); draw(); dialog.showModal(); close.focus();
}

// renderChips 保留真实资源 ID，删除关联不静默删改用户输入的正文。
function renderChips(key, prefix) {
  const container = $(key + '-chips');
  container.replaceChildren();
  for (const item of current()[key]) {
    const chip = element('span', 'chip');
    const button = element('button', '', '×');
    button.setAttribute('aria-label', `移除 ${item.name}`);
    button.disabled = busy;
    button.onclick = () => { current()[key] = current()[key].filter(value => value.id !== item.id); markChanged(); renderChips(key, prefix); };
    chip.append(element('span', '', prefix + item.name), button);
    container.append(chip);
  }
}

// renderCover 显示真实选图或帧，不把正文首图悄悄当作已提交封面。
function renderCover() {
  const draft = current();
  const cover = draft.cover;
  $('cover-preview').replaceChildren();
  let asset = cover?.assetId ? draft.assets.find(item => item.id === cover.assetId) || assetDetails.get(cover.assetId) : null;
  if (asset && !asset.error) $('cover-preview').append(mediaImage(asset));
  else if (cover && resourcePreviews.get('cover:' + cover.id)) {
    const image = element('img'); image.src = resourcePreviews.get('cover:' + cover.id); image.alt = cover.name || '封面'; $('cover-preview').append(image);
  } else $('cover-preview').append(element('span', '', cover?.type === 'frame' ? '视频帧' : '封面'));
  $('cover-name').textContent = cover?.name || asset?.name || (cover?.type === 'frame' ? `${((cover.timeMs || 0) / 1000).toFixed(2)} 秒视频帧` : '未指定封面');
  $('cover-note').textContent = cover ? '封面独立于正文素材顺序' : draft.kind === 'image' ? '选择一张图片作为作品封面' : '可选择图库图片；帧封面按连接能力开放';
  $('clear-cover').hidden = !cover;
  $('crop-cover').hidden = !cover?.assetId || !!asset?.localOnly || draft.kind !== 'image';
  $('choose-frame').hidden = draft.kind !== 'video' || !supports('cover.frames');
  $('choose-cover').disabled = busy || !context.apiBaseURL;
  $('crop-cover').disabled = busy;
}

// renderResources 显示所选配乐、地点和合集的明确身份，试听 URL 仅存在本次内存。
function renderResources() {
  for (const [key, fallback] of [['music', '未添加'], ['location', '不添加位置'], ['collection', '不加入合集']]) {
    $(key + '-name').textContent = current()[key]?.name || fallback;
    $('clear-' + key).hidden = !current()[key];
  }
  $('preview-music').hidden = !current().music || !resourcePreviews.has('music:' + current().music.id);
  renderChips('topics', '#'); renderChips('mentions', '@'); renderCover();
}

// fillOptions 用横向单选组展示账号允许值，草稿仍保存原有设置字段。
function fillOptions(id, options, fallback) {
  const group = $(id), value = current().settings[id];
  const rows = Array.isArray(options) && options.length ? [...options] : [...fallback];
  if (!rows.some(option => option.value === value)) rows.push({value, label: '原设置当前不可用', disabled: true});
  group.replaceChildren();
  for (const option of rows) {
    const label = element('label');
    const radio = element('input'); radio.type = 'radio'; radio.name = id; radio.value = option.value;
    radio.checked = option.value === value; radio.disabled = busy || option.disabled === true;
    radio.onchange = () => { if (radio.checked && !busy) { current().settings[id] = radio.value; markChanged(); } };
    label.append(radio, document.createTextNode(option.label || option.value)); group.append(label);
  }
}

// renderSettings 不以默认选项推断远端能力；最后由平台准备结果校验可发布性。
function renderSettings() {
  fillOptions('visibility', session.capabilities?.options?.visibility, [{value: 'public', label: '公开'}, {value: 'friends', label: '好友可见'}, {value: 'private', label: '仅自己可见'}]);
  fillOptions('download', session.capabilities?.options?.download, [{value: 'allow', label: '允许'}, {value: 'deny', label: '不允许'}]);
  $('scheduled').checked = current().settings.publishTime === 'scheduled';
  $('immediate').checked = !$('scheduled').checked;
  $('scheduled-at').value = current().settings.scheduledAt;
  $('schedule-fields').hidden = !$('scheduled').checked;
  $('timezone').textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
  $('declarations').replaceChildren();
  const declarations = Array.isArray(session.capabilities?.declarations) ? session.capabilities.declarations : [];
  $('declarations').hidden = !declarations.length;
  for (const item of declarations) {
    if (!item.id || !item.label) continue;
    const label = element('label', 'declaration');
    const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = current().settings.declarations.includes(item.id); checkbox.disabled = busy;
    checkbox.onchange = () => {
      const values = new Set(current().settings.declarations);
      checkbox.checked ? values.add(item.id) : values.delete(item.id);
      current().settings.declarations = [...values]; markChanged();
    };
    label.append(checkbox, document.createTextNode(item.label + (item.required ? '（必选）' : '')));
    if (item.description) label.append(element('small', '', item.description));
    $('declarations').append(label);
  }
}

// validationIssue 只做本机可确定的校验，不替平台猜测账号权限或发布时间范围。
function validationIssue() {
  const draft = current();
  if (!session.connected) return '请先登录抖音并核对账号';
  if (!session.account?.id || !session.account?.name) return '尚未验证发布账号';
  if (!supports('publication.prepare')) return '当前连接尚未提供上传准备能力';
  if (!draft.assets.length) return '请先加入作品素材';
  if (draft.assets.some(asset => asset.localOnly)) return '预览文件需先加入图库，再带入作品';
  if (draft.assets.some(asset => asset.kind !== draft.kind)) return '请移除与作品类型不一致的素材';
  if (draft.kind === 'video' && draft.assets.length !== 1) return '视频作品需要且只能包含一个视频';
  if (draft.kind === 'image' && draft.assets.length > (session.capabilities?.limits?.imageCount || 35)) return '图片数量超过当前账号允许范围';
  if (draft.assets.some(asset => assetDetails.get(asset.id)?.error)) return '部分素材不可用，请重读或移除';
  if (draft.title.length > (session.capabilities?.limits?.titleLength || 20)) return '标题超过当前允许长度';
  if (draft.description.length > (session.capabilities?.limits?.descriptionLength || 1000)) return '描述超过当前允许长度';
  if (draft.settings.publishTime === 'scheduled') {
    const time = new Date(draft.settings.scheduledAt).getTime();
    if (!Number.isFinite(time) || time <= Date.now()) return '请选择未来的定时发布时间';
  }
  if (draft.collection && draft.settings.visibility !== 'public') return '加入普通合集的作品需要公开可见';
  if (draft.cover?.localOnly) return '封面文件需先加入图库';
  const missing = session.capabilities?.declarations?.find(item => item.required && !draft.settings.declarations.includes(item.id));
  if (missing) return `请确认「${missing.label}」`;
  if (['unknown', 'processing'].includes(draft.receipt?.status)) return '上次提交结果待确认，请先查询发布状态';
  if (['published', 'scheduled'].includes(draft.receipt?.status)) return '此作品已提交，可复制为新草稿继续创作';
  return '';
}

// preparationValid 必须同时匹配内容、账号、有效期和显式可发布标志。
function preparationValid() {
  return !!prepared && prepared.canPublish === true && prepared.draftId === current().id && prepared.signature === contentSignature(current()) && prepared.account?.id === session.account?.id && (!prepared.expiresAt || new Date(prepared.expiresAt).getTime() > Date.now());
}

// renderActions 独立区分保存、上传准备、最终发布和待确认回执。
function renderActions() {
  const issue = validationIssue();
  $('prepare').disabled = busy || !!issue;
  $('publish').disabled = busy || !!issue || !supports('publication.publish') || !preparationValid();
  $('publish').textContent = current().settings.publishTime === 'scheduled' ? '定时发布…' : '发布…';
  $('prepare').textContent = busyKind === 'prepare' ? '准备中…' : preparationValid() ? '重新检查' : '上传并检查';
  $('work-state').textContent = busy ? busyKind === 'publish' ? '正在提交发布' : busyKind === 'prepare' ? '正在上传并检查' : '正在处理' : current().receipt ? receiptTitles[current().receipt.status] : preparationValid() ? '已准备好，等待确认发布' : '编辑作品';
  $('validation-summary').textContent = issue || (preparationValid() ? `将以 ${prepared.account.name} 发布` : '上传并检查后，仍需你确认发布');
  $('save-draft').disabled = saving || busy;
  $('draft-name').disabled = busy;
  $('open-drafts').disabled = busy;
  $('choose-upload').disabled = busy || !context.apiBaseURL;
  $('add-library-media').disabled = busy || !context.apiBaseURL || current().assets.length >= (current().kind === 'video' ? 1 : 35);
  $('connect').disabled = connecting || busy;
  const nativeAvailable = context.nativeCapabilities?.sessionVersion === 1;
  $('import-session').disabled = connecting || busy || !nativeAvailable;
  $('import-session').textContent = session.connected ? '重新登录' : '登录抖音';
  $('clear-session').disabled = connecting || busy || !nativeAvailable;
  for (const id of ['new-image', 'new-video', 'duplicate', 'delete-draft', 'mode-image', 'mode-video']) $(id).disabled = busy;
  for (const node of document.querySelectorAll('[data-operation]')) {
    const supported = supports(node.dataset.operation);
    node.disabled = busy || !supported;
    node.title = supported ? '' : session.connected ? '当前版本尚未支持此能力' : '请先登录抖音并核对账号';
  }
  $('open-ai').disabled = busy || !context.apiBaseURL;
  $('refresh-publication').disabled = busy || !supports('publication.status');
  $('status-shortcut').disabled = busy || !supports('publication.status');
  $('status-shortcut').hidden = !current().receipt?.requestId;
  $('prepare').hidden = !!current().receipt?.requestId && current().receipt?.status !== 'failed';
}

// renderReceipt 仅将明确的 published 状态称为已发布，处理中和网络未知保持独立。
function renderReceipt() {
  const receipt = current().receipt;
  $('receipt-panel').hidden = !receipt;
  if (!receipt) return;
  $('receipt-title').textContent = receiptTitles[receipt.status];
  $('receipt-message').textContent = receipt.message || ({published: '平台已确认发布成功。', scheduled: '平台已接受定时发布，请在预定时间后核对作品。', processing: '平台仍在处理，可稍后查询状态。', failed: '平台返回失败，请检查说明后重新准备。', unknown: '暂时无法确认平台是否收到提交，请先查询，避免重复发布。'})[receipt.status];
  $('receipt-id').textContent = receipt.publicationId ? `作品编号 ${receipt.publicationId}` : `请求编号 ${receipt.requestId}`;
  const url = safeURL(publicationLinks.get(receipt.requestId));
  $('publication-link').hidden = !url;
  if (url) $('publication-link').href = url;
  else $('publication-link').removeAttribute('href');
  $('refresh-publication').hidden = !receipt.requestId;
}

// renderConnection 成功只更新账号状态，未登录及失败保留明确反馈，避免编辑页叠加成功横幅。
function renderConnection(message = '', {error = false} = {}) {
  $('connection-dot').classList.toggle('online', session.connected && !!session.account?.id);
  $('connection-dot').classList.toggle('error', session.connected && !session.account?.id);
  $('connection-label').textContent = connecting ? '正在检查…' : session.connected ? session.account?.name || '接口已接入 · 账号未验证' : context.nativeCapabilities?.sessionVersion === 1 ? '尚未验证账号' : '请更新 App';
  $('connect').textContent = '检查会话';
  $('connection-banner').hidden = !message || (!error && session.connected && !!session.account?.id);
  $('connection-banner').classList.toggle('error', error);
  $('connection-banner').setAttribute('role', error ? 'alert' : 'status');
  $('connection-message').textContent = message;
  $('capability-list').replaceChildren();
  for (const [operation, name] of Object.entries(operationNames)) {
    const row = element('div', 'capability-row');
    row.append(element('span', '', name), element('span', supports(operation) ? 'available' : '', supports(operation) ? '可用' : '未就绪'));
    $('capability-list').append(row);
  }
  fitWorkspace(); renderPreview(); renderActions();
}

// acceptSession 更新已验证会话，换号后使所有上传准备失效。
function acceptSession(value = {}) {
  const previousAccount = session.account?.id;
  if (typeof value.connected === 'boolean') session.connected = value.connected;
  if (Object.hasOwn(value, 'account')) session.account = value.account?.id ? {...value.account, id: String(value.account.id), name: String(value.account.name || '')} : null;
  if (value.capabilities) session.capabilities = value.capabilities;
  if (Object.hasOwn(value, 'expiresAt')) session.expiresAt = value.expiresAt;
  if (!session.connected) { session.account = null; session.capabilities = {operations: []}; }
  if (previousAccount !== session.account?.id) prepared = null;
  renderSettings(); renderResources(); renderConnection(value.message || '');
}

// refreshSession 合并状态事件触发的只读刷新，不创建自动发布或周期查询。
async function refreshSession() {
  if (sessionRefreshing) return sessionRefreshing;
  sessionRefreshing = client.request('studio.session', {kind: current().kind}).then(acceptSession).catch(error => {
    renderConnection(error.message || '账号信息读取失败，请刷新连接。', {error: true});
  }).finally(() => { sessionRefreshing = null; });
  return sessionRefreshing;
}

// checkInterface 只响应明确的检查、登录或清除动作，用户在官方窗口完成登录。
async function checkInterface(action = 'check') {
  if (connecting || busy) return;
  connecting = true; renderConnection();
  try {
    const result = await (action === 'import' ? client.importSession() : action === 'clear' ? client.clearSession() : client.connect());
    acceptSession(result || {});
    if (result?.connected && (!result.account || !result.capabilities)) await refreshSession();
    if ($('account-menu')) $('account-menu').open = false;
  } catch (error) { renderConnection(error.message || '会话操作未完成，请检查后重试。', {error: true}); }
  finally { connecting = false; renderActions(); $('connect').disabled = busy; $('connection-label').textContent = session.connected ? session.account?.name || '接口已接入 · 账号未验证' : context.nativeCapabilities?.sessionVersion === 1 ? '尚未验证账号' : '请更新 App'; }
}

// setBusy 锁定作品内容与草稿切换，防止上传期间生成混合内容快照。
function setBusy(value, kind = '') {
  busy = value; busyKind = value ? kind : '';
  document.body.classList.toggle('busy', value);
  for (const panel of document.querySelectorAll('.editor-scroll > section')) if (panel.id !== 'activity-panel') panel.inert = value;
  document.querySelector('.draft-sidebar').inert = value;
  $('cancel-operation').hidden = !value || !operationController || kind === 'publish';
  renderActions();
}

// activity 只有收到明确进度时显示数值，不根据时间伪造百分比。
function activity(message, progress) {
  $('activity-panel').hidden = false;
  $('activity-message').textContent = message || '正在处理…';
  const percent = Number.isFinite(progress?.percent) ? progress.percent : Number.isFinite(progress?.completed) && Number.isFinite(progress?.total) && progress.total > 0 ? progress.completed / progress.total * 100 : null;
  $('activity-progress').hidden = percent === null;
  if (percent !== null) $('activity-progress').value = Math.max(0, Math.min(100, percent));
  if (progress?.assetId) {
    const asset = current().assets.find(item => item.id === progress.assetId);
    const row = element('div', '', `${asset?.name || '素材'} · ${progress.message || progress.phase || '处理中'}`);
    $('activity-items').prepend(row);
    while ($('activity-items').children.length > 20) $('activity-items').lastChild.remove();
  }
}

// preparePublication 上传不可变作品快照，只有明确 canPublish 才开放最终确认。
async function preparePublication() {
  if (busy) return;
  const issue = validationIssue();
  if (issue) { notice(issue, true); return; }
  setBusy(true, 'prepare');
  if (!(await saveDraft(false))) { notice(storageError, true); setBusy(false); return; }
  const draftId = current().id;
  const signature = contentSignature(current());
  const accountId = session.account.id;
  prepared = null;
  operationController = new AbortController();
  setBusy(true, 'prepare');
  $('activity-items').replaceChildren();
  activity('正在上传素材并核对作品，完成后仍需确认发布。');
  notice();
  try {
    const result = await client.request('publication.prepare', {draft: publicationDraft(current()), requestId: newID()}, {
      signal: operationController.signal, onProgress: value => activity(value.message || value.phase || '正在准备…', value),
    });
    if (draftId !== current().id || signature !== contentSignature(current()) || session.account?.id !== accountId) throw Error('作品或账号已变化，请重新上传检查。');
    if (!result?.preparationId || result.canPublish !== true || result.account?.id !== accountId) {
      const issues = Array.isArray(result?.issues) ? result.issues.filter(item => typeof item === 'string').join('；') : '';
      throw Error(issues || '上传准备尚未完成，请检查账号及作品后重试。');
    }
    prepared = {...result, draftId, signature};
    activity('素材与作品检查完成。请核对账号，再点击发布。');
    notice('准备完成，尚未发布。');
  } catch (error) {
    const message = error.name === 'AbortError' ? '已停止等待准备结果。已完成的上传以执行模块任务记录为准，尚未发布。' : error.message || '准备失败，请重试。';
    activity(message); notice(message, true);
  } finally { operationController = null; setBusy(false); render(); }
}

// confirmDialog 使用独立弹窗，最终发布默认未勾选且默认焦点为取消。
function confirmDialog({title, message, rows = [], submit = '确认', requireCheck = false, danger = false}) {
  if ($('confirm-dialog').open) return Promise.resolve(false);
  $('confirm-title').textContent = title;
  $('confirm-content').replaceChildren(element('p', '', message));
  if (rows.length) {
    const summary = element('dl', 'confirmation-summary');
    for (const [label, value] of rows) summary.append(element('dt', '', label), element('dd', '', value));
    $('confirm-content').append(summary);
  }
  $('confirm-submit').textContent = submit;
  $('confirm-submit').classList.toggle('subtle-danger', danger);
  $('confirm-submit').disabled = requireCheck;
  if (requireCheck) {
    const label = element('label', 'confirm-check');
    const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = false;
    checkbox.onchange = () => { $('confirm-submit').disabled = !checkbox.checked; };
    label.append(checkbox, document.createTextNode('我已核对本次账号、素材和设置，确认提交这份作品。'));
    $('confirm-content').append(label);
  }
  return new Promise(resolve => {
    const dialog = $('confirm-dialog');
    let settled = false;
    const finish = value => { if (settled) return; settled = true; dialog.close(); resolve(value); };
    $('confirm-cancel').onclick = () => finish(false);
    $('confirm-submit').onclick = () => finish(true);
    dialog.oncancel = event => { event.preventDefault(); finish(false); };
    dialog.onclose = () => finish(false);
    dialog.showModal(); $('confirm-cancel').focus();
  });
}

// publishPublication 只有二次确认后才调用不可逆发布；网络失败保留同一请求身份供查询。
async function publishPublication() {
  if (busy || validationIssue() || !preparationValid() || !supports('publication.publish')) return;
  const snapshot = prepared;
  const draft = current();
  const accepted = await confirmDialog({
    title: draft.settings.publishTime === 'scheduled' ? '确认定时发布这份作品？' : '确认发布这份作品？',
    message: '确认后会以已验证的抖音账号提交作品。',
    rows: [['发布账号', `${snapshot.account.name}（${snapshot.account.id}）`], ['作品标题', draft.title || '未填写标题'], ['作品类型', `${draft.kind === 'image' ? '图文' : '视频'} · ${draft.assets.length} 项素材`], ['可见范围', $('visibility').selectedOptions[0]?.textContent || draft.settings.visibility], ['发布时间', draft.settings.publishTime === 'scheduled' ? draft.settings.scheduledAt.replace('T', ' ') + ' · ' + Intl.DateTimeFormat().resolvedOptions().timeZone : '立即发布']],
    submit: draft.settings.publishTime === 'scheduled' ? '确认定时发布' : '确认发布', requireCheck: true,
  });
  if (!accepted) return;
  if (busy || snapshot !== prepared || !preparationValid() || validationIssue()) { notice('作品、账号或准备状态已变化，请重新检查。', true); return; }
  setBusy(true, 'publish');
  const requestId = newID();
  draft.receipt = {requestId, publicationId: '', status: 'unknown', message: '正在提交，请勿重复发布。', updatedAt: new Date().toISOString()};
  store.touch();
  // 先保存请求身份；本机无法记录时不发送不可逆发布请求。
  if (!(await saveDraft(false))) { draft.receipt = null; notice('无法保存发布请求记录，本次尚未提交。请先保存草稿。', true); setBusy(false); return; }
  setBusy(true, 'publish');
  activity('正在提交发布，请等待平台返回结果。');
  try {
    const result = await client.request('publication.publish', {preparationId: snapshot.preparationId, requestId, expectedAccountId: snapshot.account.id, confirmed: true}, {onProgress: value => activity(value.message || '平台正在处理…', value)});
    applyReceipt(result, requestId);
  } catch (error) {
    draft.receipt = {...draft.receipt, status: 'unknown', message: error.message || '未收到平台回执，请先查询发布状态。', updatedAt: new Date().toISOString()};
    activity('发布结果未确认，请查询状态，避免重复提交。');
    notice(draft.receipt.message, true);
  } finally {
    prepared = null; store.touch(); await saveDraft(false); setBusy(false); renderReceipt(); renderDrafts(); renderActions();
  }
}

// applyReceipt 只接受约定的终态；缺失或未知状态绝不按发布成功处理。
function applyReceipt(result, requestId) {
  const status = Object.hasOwn(receiptTitles, result?.status) ? result.status : 'unknown';
  current().receipt = {
    requestId, status, publicationId: typeof result?.publicationId === 'string' ? result.publicationId : current().receipt?.publicationId || '',
    message: typeof result?.message === 'string' ? result.message : '', updatedAt: new Date().toISOString(),
  };
  const url = safeURL(result?.url);
  if (url) publicationLinks.set(requestId, url);
  activity(receiptTitles[status] + (result?.message ? '：' + result.message : ''));
  notice(status === 'published' ? '平台已确认作品发布成功。' : status === 'scheduled' ? '平台已接受定时发布。' : status === 'processing' ? '平台正在处理，请稍后查询状态。' : result?.message || '发布结果尚未确认，请查询状态。', ['failed', 'unknown'].includes(status));
}

// refreshPublication 仅查询已有提交，绝不自动重新上传或重新发布。
async function refreshPublication() {
  const receipt = current().receipt;
  if (!receipt?.requestId || busy || !supports('publication.status')) return;
  setBusy(true, 'status');
  try {
    const result = await client.request('publication.status', {publicationId: receipt.publicationId || undefined, requestId: receipt.requestId});
    applyReceipt(result, receipt.requestId); store.touch(); await saveDraft(false);
  } catch (error) { notice(error.message || '状态查询失败，原提交记录已保留。', true); }
  finally { setBusy(false); renderReceipt(); renderDrafts(); renderActions(); }
}

// openSearch 为真实资源查询提供统一可取消弹窗，搜索结果不会自动应用。
async function openSearch(type) {
  if (busy || searchOpening || $('search-dialog').open) return;
  const configurations = {
    topics: {operation: 'topics.search', title: '添加话题', placeholder: '搜索话题'},
    mentions: {operation: 'users.search', title: '提及用户', placeholder: '搜索用户昵称'},
    music: {operation: 'music.search', title: '音乐库', placeholder: '粘贴 https://v.douyin.com/… 音乐链接'},
    location: {operation: 'locations.search', title: '选择位置', placeholder: '输入具体地点名称'},
    collection: {operation: 'collections.list', title: '选择普通合集', placeholder: '筛选合集名称'},
    frame: {operation: 'cover.frames', title: '选择视频帧', placeholder: ''},
  };
  const configuration = configurations[type];
  if (!configuration || (configuration.operation && !supports(configuration.operation))) return;
  searchOpening = true;
  searchController?.abort(); searchGeneration += 1;
  searchState = {...configuration, type, draftId: current().id, items: [], cursor: null, hasMore: false, loading: false, query: ''};
  $('search-heading').textContent = configuration.title;
  $('search-query').value = '';
  $('search-query').placeholder = configuration.placeholder;
  $('search-results').replaceChildren(); $('search-message').textContent = type === 'music' ? '当前支持推荐音乐或抖音音乐链接，暂不支持关键词搜索。' : '';
  $('run-search').textContent = type === 'music' ? '读取' : '搜索';
  $('search-more').hidden = true;
  $('search-form').hidden = type === 'frame';
  $('search-query').disabled = false;
  $('search-dialog').querySelector('.city-selector')?.remove();
  if (type === 'location') {
    const label = element('label', 'city-selector field-label', '先选择城市');
    const select = element('select'); select.id = 'search-city';
    const placeholder = element('option', '', '请选择城市'); placeholder.value = ''; select.append(placeholder);
    label.append(select); $('search-form').before(label);
    try {
      if (!cities) { const response = await fetch(new URL('./cities.json', import.meta.url)); if (!response.ok) throw Error(); cities = await response.json(); }
      for (const city of cities) { const option = element('option', '', city.name); option.value = city.code; select.append(option); }
    } catch { $('search-message').textContent = '城市列表读取失败，请重新打开插件。'; }
  }
  searchOpening = false;
  $('search-dialog').showModal(); $('search-query').focus();
  if (['collection', 'frame', 'music'].includes(type)) await runSearch(false);
}

// runSearch 保留分页失败之前的结果，取消或换草稿后忽略旧响应。
async function runSearch(more = false) {
  const state = searchState;
  if (!state || state.loading || current().id !== state.draftId) return;
  const query = $('search-query').value.trim();
  if (!more && !query && !['collection', 'frame', 'music'].includes(state.type)) { $('search-message').textContent = '请输入搜索关键词。'; return; }
  if (state.type === 'music' && query && !/^https:\/\/v\.douyin\.com\/[^\s]+$/i.test(query)) { $('search-message').textContent = '请粘贴抖音音乐短链接，或清空输入读取推荐音乐。当前不支持关键词搜索。'; return; }
  let city = null;
  if (state.type === 'location') {
    city = cities?.find(item => item.code === $('search-city')?.value);
    if (!city) { $('search-message').textContent = '请先选择城市，再搜索地点。'; return; }
  }
  const generation = ++searchGeneration;
  searchController?.abort(); searchController = new AbortController();
  if (!more) { state.items = []; state.cursor = null; state.hasMore = false; state.query = query; }
  state.loading = true; $('run-search').disabled = true; $('search-more').disabled = true;
  $('search-message').textContent = '正在读取…';
  try {
    const params = {query: state.query, cursor: more ? state.cursor : undefined, kind: current().kind};
    if (city) Object.assign(params, {cityCode: city.code, cityName: city.name});
    if (state.type === 'frame') params.assetId = current().assets[0]?.id;
    const result = await client.request(state.operation, params, {signal: searchController.signal});
    if (generation !== searchGeneration || searchState !== state || !$( 'search-dialog').open) return;
    if (!Array.isArray(result?.items)) throw Error('返回结果格式不完整，请重试。');
    for (const item of result.items) {
      if (!item?.id || typeof item.name !== 'string') continue;
      const next = {...item, id: String(item.id)};
      if (city) Object.assign(next, {cityCode: city.code, cityName: city.name});
      if (!state.items.some(existing => existing.id === next.id)) state.items.push(next);
    }
    state.cursor = result.nextCursor ?? result.cursor ?? null;
    state.hasMore = result.hasMore === true || (result.nextCursor !== undefined && result.nextCursor !== null && result.nextCursor !== '');
    if (state.hasMore && state.cursor === null) state.hasMore = false;
    $('search-message').textContent = state.items.length ? `已显示 ${state.items.length} 项，选择后加入当前作品。${state.type === 'music' ? ' 当前支持推荐音乐与音乐链接。' : ''}` : '没有找到匹配结果。';
    drawSearchResults();
  } catch (error) {
    if (generation !== searchGeneration || error.name === 'AbortError') return;
    $('search-message').textContent = error.message || '读取失败，请重试。';
  } finally {
    if (generation === searchGeneration) { state.loading = false; $('run-search').disabled = false; $('search-more').disabled = false; $('search-more').hidden = !state.hasMore; }
  }
}

// drawSearchResults 每行展示真实名称与可选试听，不制造不存在的搜索资源。
function drawSearchResults() {
  const state = searchState;
  if (!state) return;
  $('search-results').replaceChildren();
  for (const item of state.items) {
    const selected = ['topics', 'mentions'].includes(state.type) ? current()[state.type].some(value => value.id === item.id) : current()[state.type]?.id === item.id;
    const row = element('div', 'search-row' + (selected ? ' selected' : ''));
    const url = safeURL(item.thumbnailURL);
    if (url) { const image = element('img'); image.src = url; image.alt = ''; image.loading = 'lazy'; row.append(image); }
    const text = element('div', 'search-result-text'); text.append(element('strong', '', item.name));
    const detail = item.description || item.address || item.subtitle || '';
    if (detail) text.append(element('small', '', detail));
    const actions = element('div', 'search-result-actions');
    const preview = safeURL(item.previewURL);
    if (state.type === 'music' && preview) {
      resourcePreviews.set('music:' + item.id, preview);
      const button = element('button', '', '试听'); button.onclick = () => playMusic(preview); actions.append(button);
    }
    const button = element('button', '', selected ? '已添加' : '选择'); button.disabled = selected;
    button.onclick = () => { void chooseResource(item); }; actions.append(button);
    row.append(text, actions); $('search-results').append(row);
  }
}

// chooseResource 仅在用户点选后持久化身份；地点保留显式城市，封面文件不进入本机 JSON。
async function chooseResource(item) {
  const state = searchState;
  if (!state || state.draftId !== current().id || busy) return;
  if (['topics', 'mentions'].includes(state.type)) {
    const value = entityValue(item);
    if (!value) return;
    if (!current()[state.type].some(existing => existing.id === value.id)) current()[state.type].push(value);
  } else if (state.type === 'frame') {
    if (!Number.isFinite(item.timeMs)) { $('search-message').textContent = '这项结果缺少有效的视频时间，无法选为封面。'; return; }
    current().cover = {type: 'frame', assetId: current().assets[0].id, id: item.id, timeMs: item.timeMs, name: item.name};
    const url = safeURL(item.thumbnailURL); if (url) resourcePreviews.set('cover:' + item.id, url);
  } else {
    current()[state.type] = entityValue(item);
    if (state.type === 'location' && item.cityCode) Object.assign(current().location, {cityCode: item.cityCode, cityName: item.cityName});
  }
  markChanged(); renderResources(); drawSearchResults();
  if (!['topics', 'mentions'].includes(state.type)) $('search-dialog').close();
}

// stopMusic 在草稿切换时停止试听，不把试听当作作品已配乐成功。
function stopMusic() { $('music-player').pause(); $('music-player').hidden = true; $('music-player').removeAttribute('src'); }

// playMusic 只播放平台返回的 HTTPS 试听地址，失败提示且不更改作品。
function playMusic(url) {
  const source = safeURL(url);
  if (!source) return;
  if ($('music-player').src === source && !$('music-player').paused) { $('music-player').pause(); return; }
  $('music-player').src = source; $('music-player').hidden = false;
  $('music-player').play().catch(() => notice('配乐试听未能开始，可点击播放器重试。'));
}

// cropCover 复用本地图库裁剪器，确认后只保存归一化区域。
async function cropCover() {
  const draft = current();
  const asset = draft.assets.find(item => item.id === draft.cover?.assetId) || assetDetails.get(draft.cover?.assetId);
  const first = draft.assets.find(item => item.kind === 'image');
  if (!asset || !first || busy || !context.apiBaseURL) return;
  const draftId = draft.id;
  const crop = await editCoverCrop({asset, first, baseURL: context.apiBaseURL, previous: draft.cover?.crop});
  if (crop && current().id === draftId && draft.cover?.assetId === asset.id) { draft.cover.crop = crop; markChanged(); renderCover(); }
}

// render 绑定当前草稿的完整表单；普通打字仅刷新相关区域避免丢失光标。
function render() {
  const draft = current();
  if (renderedDraftId !== draft.id) {
    if (renderedDraftId !== null) notice();
    $('activity-panel').hidden = true;
    $('activity-items').replaceChildren();
    renderedDraftId = draft.id;
  }
  $('draft-name').value = draft.name;
  $('title').value = draft.title; $('description').value = draft.description;
  $('title').maxLength = session.capabilities?.limits?.titleLength || 20;
  $('description').maxLength = session.capabilities?.limits?.descriptionLength || 1000;
  $('mode-image').setAttribute('aria-selected', String(draft.kind === 'image'));
  $('mode-video').setAttribute('aria-selected', String(draft.kind === 'video'));
  renderDrafts(); renderMedia(); renderResources(); renderSettings(); renderPreview(); renderReceipt(); renderActions(); renderSaveState();
}

// changeKind 非空作品切换类型时创建新草稿，避免丢失或混合媒体。
async function changeKind(kind) {
  if (busy || current().kind === kind) return;
  if (current().assets.length || current().title || current().description) {
    const yes = await confirmDialog({title: '新建另一种作品？', message: '当前作品会继续保留。新建独立草稿后，可准备另一种类型。', submit: '新建' + (kind === 'image' ? '图文' : '视频')});
    if (yes) newDraft(kind);
  } else { current().kind = kind; current().name = kind === 'image' ? '未命名图文' : '未命名视频'; markChanged(); render(); }
}

// previewFiles 仅在非原生预览里创建临时媒体，发布校验拒绝这些未登记文件。
async function previewFiles(files) {
  if (busy) return;
  const matching = [...files].filter(file => file.type.startsWith(current().kind === 'image' ? 'image/' : 'video/'));
  for (const file of matching.slice(0, 100 - current().assets.length)) {
    const id = 'local:' + newID();
    transientMedia.set(id, {url: URL.createObjectURL(file)});
    current().assets.push({id, name: file.name, kind: current().kind, localOnly: true});
  }
  markChanged(); renderMedia(); renderPreview();
  notice('本机文件已用于编辑预览。要上传发布，请先把这些文件加入图库，再从插件菜单带入。');
}

// generateAICopy 只发送用户输入文字到现有 AI 服务，不自动发送图片或替换文案。
async function generateAICopy() {
  if (aiController || busy || !context.apiBaseURL) return;
  if (!$('ai-context').value.trim()) { $('ai-status').textContent = '请先填写作品信息。'; return; }
  aiController = new AbortController(); aiResult = null;
  const draftId = current().id;
  $('ai-generate').disabled = true; $('ai-apply').disabled = true; $('ai-result').hidden = true;
  $('ai-status').textContent = '正在生成，只发送当前文字信息…';
  const timeout = setTimeout(() => aiController?.abort(), 185000);
  try {
    const value = await generateCopy(context.apiBaseURL, $('ai-prompt').value, JSON.stringify({type: current().kind === 'image' ? '图文' : '视频', work: $('ai-context').value}), aiController.signal, []);
    aiResult = {...value, draftId};
    $('ai-result-title').textContent = value.title; $('ai-result-description').textContent = value.description; $('ai-result').hidden = false;
    $('ai-status').textContent = '生成完成，检查后应用。'; $('ai-apply').disabled = false;
  } catch (error) { $('ai-status').textContent = aiController?.signal.aborted ? '生成已取消或超时。' : error.message; }
  finally { clearTimeout(timeout); aiController = null; $('ai-generate').disabled = false; }
}

// closeHost 等待本机保存确认；待发布请求不会被关闭动作自动取消或重发。
async function closeHost(host = true) {
  if (busy) { notice('当前操作尚未结束，请等待结果后关闭。'); return; }
  if (!(await saveDraft(false))) { notice('草稿保存失败，页面已保留。请保存成功后再关闭。', true); return; }
  if (context.nativeUIAvailable) await window.webkit.messageHandlers.pluginUI.postMessage({op: 'close', host});
}

// bindEvents 集中绑定界面操作，所有最终提交入口都经过 publishPublication 的二次确认。
function bindEvents() {
  // 账号工具收于同一菜单；点击空白或 Escape 只收起菜单，不触发登录或清除。
  const accountMenu = $('account-menu');
  document.addEventListener('pointerdown', event => { if (accountMenu?.open && !accountMenu.contains(event.target)) accountMenu.open = false; });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && accountMenu?.open) { accountMenu.open = false; accountMenu.querySelector('summary')?.focus(); } });
  const previewButton = element('button', '', '放大预览'); previewButton.id = 'open-media-preview';
  document.querySelector('.media-tools > div').prepend(previewButton);
  const statusButton = element('button', '', '查询状态'); statusButton.id = 'status-shortcut'; statusButton.hidden = true;
  $('prepare').before(statusButton);
  $('open-drafts').onclick = () => { if (!busy) $('drafts-dialog').showModal(); };
  $('close-drafts').onclick = () => $('drafts-dialog').close();
  $('choose-upload').onclick = $('add-library-media').onclick = () => { void chooseLibrary('media'); };
  $('connect').onclick = () => { void checkInterface(); };
  $('import-session').onclick = () => { void checkInterface('import'); };
  $('clear-session').onclick = () => { void checkInterface('clear'); };
  $('new-image').onclick = () => newDraft('image'); $('new-video').onclick = () => newDraft('video');
  $('mode-image').onclick = () => { void changeKind('image'); }; $('mode-video').onclick = () => { void changeKind('video'); };
  $('save-draft').onclick = () => { void saveDraft(); };
  $('prepare').onclick = () => { void preparePublication(); }; $('publish').onclick = () => { void publishPublication(); };
  $('refresh-publication').onclick = () => { void refreshPublication(); };
  $('status-shortcut').onclick = () => { void refreshPublication(); };
  $('open-media-preview').onclick = openMediaPreview;
  $('draft-name').oninput = () => { current().name = $('draft-name').value; markChanged({content: false}); };
  for (const id of ['title', 'description']) $(id).oninput = () => { current()[id] = $(id).value; markChanged(); };
  $('immediate').onchange = $('scheduled').onchange = () => { current().settings.publishTime = $('scheduled').checked ? 'scheduled' : 'now'; $('schedule-fields').hidden = !$('scheduled').checked; markChanged(); };
  $('scheduled-at').onchange = () => { current().settings.scheduledAt = $('scheduled-at').value; markChanged(); };
  $('import-host').onclick = () => { void chooseLibrary('media'); };
  $('preview-files').onchange = event => { void previewFiles(event.target.files || []); event.target.value = ''; };
  $('move-left').onclick = () => moveMedia(-1); $('move-right').onclick = () => moveMedia(1);
  $('preview-previous').onclick = () => stepPreview(-1); $('preview-next').onclick = () => stepPreview(1);
  $('preview-stage').onkeydown = event => { if (current().kind !== 'image') return; if (event.key === 'ArrowLeft') { event.preventDefault(); stepPreview(-1); } if (event.key === 'ArrowRight') { event.preventDefault(); stepPreview(1); } };
  $('duplicate').onclick = () => { try { store.copy(); prepared = null; focusID = null; render(); void saveDraft(false); } catch (error) { notice(error.message, true); } };
  $('delete-draft').onclick = async () => {
    const id = current().id;
    if (await confirmDialog({title: '删除当前本机草稿？', message: '只删除工作台中的这份草稿，不删除图库素材，也不删除已经发布的作品。', submit: '删除草稿', danger: true})) {
      store.remove(id); prepared = null; focusID = null; stopMusic(); render(); await saveDraft(false);
    }
  };
  for (const type of ['topics', 'mentions', 'music', 'location', 'collection']) $('search-' + type).onclick = () => { void openSearch(type); };
  for (const type of ['music', 'location', 'collection']) $('clear-' + type).onclick = () => { current()[type] = null; if (type === 'music') stopMusic(); markChanged(); renderResources(); };
  $('choose-cover').onclick = () => { void chooseLibrary('cover'); };
  $('choose-frame').onclick = () => { void openSearch('frame'); };
  $('crop-cover').onclick = () => { void cropCover(); };
  $('clear-cover').onclick = () => { current().cover = null; markChanged(); renderCover(); };
  $('preview-music').onclick = () => playMusic(resourcePreviews.get('music:' + current().music?.id));
  $('search-form').onsubmit = event => { event.preventDefault(); void runSearch(false); };
  $('search-more').onclick = () => { void runSearch(true); };
  $('search-close').onclick = $('search-done').onclick = () => $('search-dialog').close();
  $('search-dialog').onclose = () => { searchController?.abort(); searchGeneration += 1; if (searchState?.type === 'music') stopMusic(); searchState = null; };
  $('cancel-operation').onclick = () => operationController?.abort();
  $('open-ai').onclick = () => { aiResult = null; $('ai-result').hidden = true; $('ai-apply').disabled = true; $('ai-dialog').showModal(); };
  $('ai-close').onclick = () => $('ai-dialog').close(); $('ai-dialog').onclose = () => aiController?.abort();
  $('ai-generate').onclick = () => { void generateAICopy(); };
  $('ai-apply').onclick = async () => {
    if (!aiResult || aiResult.draftId !== current().id) return;
    if ((current().title || current().description) && !(await confirmDialog({title: '替换当前文案？', message: '将使用本次 AI 结果替换标题和描述；素材与发布设置保持当前值。', submit: '应用文案'}))) return;
    current().title = aiResult.title; current().description = aiResult.description; markChanged(); $('ai-dialog').close(); render();
  };
  window.addEventListener('resize', fitWorkspace);
  window.addEventListener('luma:close-request', event => { event.preventDefault(); void closeHost(true); });
  window.addEventListener('beforeunload', event => { if (busy || storageError || store.savedRevision < store.revision) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => { aiController?.abort(); searchController?.abort(); for (const value of transientMedia.values()) URL.revokeObjectURL(value.url); });
}

// start 加载当前草稿与素材，不在初始化时启动执行模块或发送平台请求。
async function start() {
  bindEvents(); render(); renderConnection();
  client.onStatus(value => {
    const hadFullSession = !!value?.account && !!value?.capabilities;
    acceptSession(value || {});
    if (value?.connected && !hadFullSession) void refreshSession();
  });
  await hydrateAssets(currentAssetIDs());
  render();
  if (storageError) notice(storageError, true);
  if (context.selectedAssetIDs?.length) await importHost({initial: true});
}

void start().catch(error => notice(error.message || '工作台初始化失败，请重新打开。', true));
