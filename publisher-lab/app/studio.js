import {studioClient as client} from './studio-client.js';
import {StudioStore, contentSignature, entityValue, newID, publicationDraft, topicKey} from './studio-state.js';
import {editCoverCrop} from './cover-crop.js';
import {createStudioAI} from './studio-ai.js';
import {mountStudioAIPanel} from './studio-ai-panel.js';
import {photoContext} from './ai-context.js';
import {selectLibraryAssets} from './library-selection.js';
import {mountStudioGallery, mountDouyinPreview} from './studio-gallery.js';
import {mountResourceControls} from './studio-resources.js';
import {mountMusicDrawer, mountMusicCategories} from './studio-music.js';
import {mountSavedMusicPreview} from './studio-saved-music.js';
import {mountDescriptionHighlight} from './studio-description.js';
import {mountActivities} from './studio-activities.js';
import {mountHotspot} from './studio-hotspot.js';
import {mountSettingHelp} from './studio-help.js';
import {mountPreparationProgress} from './studio-progress.js';
import {mountAccountSelector} from './studio-account-selector.js';

const $ = id => document.getElementById(id);
mountSettingHelp(document.querySelector('#download-label .setting-help'), {
  id: 'download-help-description',
  text: '允许：其他用户可以下载保存作品。\n不允许：关闭平台提供的下载保存入口。',
});
const operationNames = {
  'publication.prepare': '素材上传与检查', 'publication.publish': '最终发布', 'publication.status': '发布状态',
  'topics.search': '真实话题', 'users.search': '提及用户', 'music.search': '推荐音乐与搜索', 'music.categories': '音乐分类', 'music.select': '保存选曲资料', 'music.resolve': '恢复已选音乐', 'declarations.list': '自主声明',
  'activities.list': '官方活动', 'activities.detail': '活动详情', 'activities.resolve': '活动话题核验',
  'hotspots.search': '关联热点',
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
const musicCandidates = new Map(); // 本页候选在内存；已选音源由平台模块按账号和音乐 ID 单独保存在本机。
let musicPreviewMessageIdentity = ''; // 行内提示只属于当前草稿、账号与选曲，切换后清除。
const publicationLinks = new Map();
let session = {connected: false, account: null, capabilities: {operations: []}, profiles: [], activeProfileId: null};
let prepared = null;
let busy = false;
let busyKind = '';
let operationController = null;
let focusID = null;
let renderedDraftId = null;
let saving = false;
let saveTimer = null;
let noticeTimer = null;
let connecting = false;
const statusQueries = new Map(); // 发布状态只读查询按草稿独立管理，不锁住编辑器。
let searchState = null;
let searchController = null;
let searchGeneration = 0;
let searchOpening = false;
let cities = null;
let musicSearchTimer = null; // 关键词防抖仅属于当前音乐抽屉，切分类或关闭即取消。
let coverSelection = null; // 封面弹窗只保留当前草稿的暂选身份，确认前不修改作品。
const preparationProgress = mountPreparationProgress({items: $('activity-items'), progress: $('activity-progress'), current, assetDetails});
const accountSelector = mountAccountSelector($('account-select'));


// gallery 与 phone 共用查看索引；只改变预览焦点，不改变发布顺序。
const onMediaIndex = index => { focusID = current().assets[index]?.id || null; renderMedia(); renderPreview(); };
const gallery = mountStudioGallery($('studio-gallery'), {onIndexChange: onMediaIndex, onRemove: id => { void removeImage(id); }, onReorder: reorderImage});
const phone = mountDouyinPreview($('douyin-preview'), {onIndexChange: onMediaIndex});
const resources = mountResourceControls({
  current, supports, safeURL, cacheScope: () => `${session.activeProfileId || ''}:${session.account?.id || ''}:${current().kind}`, request: (...args) => client.request(...args),
  identity: () => `${current().id}:${session.activeProfileId || ''}:${session.account?.id || ''}`,
  blocked: () => busy || connecting,
  changed: () => { markChanged(); renderResources(); },
  selectCollection,
});

// hotspot 仅关联平台返回的热点词，选择和清除沿用草稿自动保存。
const hotspot = mountHotspot({container: $('studio-hotspot'), current, supports,
  identity: () => `${current().id}:${current().kind}:${session.activeProfileId || ''}:${session.account?.id || ''}`,
  blocked: () => busy || connecting, request: (...args) => client.request(...args),
  changed: () => { markChanged(); renderResources(); },
});

// descriptionHighlight 只为已绑定身份的正文标记绘制底色，保留原生输入与实际字符数。
const descriptionHighlight = mountDescriptionHighlight($('description'), {getEntities: () => [
  ...current().topics.map(item => ({...item, kind: 'topic'})),
  ...current().mentions.map(item => ({...item, kind: 'mention'})),
]});

// musicDrawer 以同一个音频元素管理试听与底部进度；只有“使用”才绑定作品配乐。
const musicDrawer = mountMusicDrawer({results: $('search-results'), footer: $('music-playback'), audio: $('music-player'), safeURL,
  onSelect: item => { void chooseResource(item); }, refreshPreview: refreshMusicPreview});
// 已选配乐重开后按点击恢复试听地址，名称和身份始终保留在原草稿中。
const savedMusicPreview = mountSavedMusicPreview({button: $('preview-music'), iconButton: $('preview-music-icon'), audio: $('music-player'),
  current: () => ({draftId: current().id, kind: current().kind, music: current().music, connected: session.connected,
    accountId: session.account?.id || '', profileId: session.activeProfileId || ''}),
  request: (...args) => client.request(...args), play: item => musicDrawer.play(item, {refreshOnFailure: false}),
  stop: () => musicDrawer.stop(), safeURL, blocked: () => busy || connecting, onError: message => musicPreviewNotice(message)});
// musicCategories 只渲染真实分类；每次点击由下方搜索编排切换独立分页，不影响当前试听。
const musicCategories = mountMusicCategories({container: $('music-tabs'), onSelect: item => {
  const state = searchState;
  if (state?.type !== 'music' || !ownsMusicSearch(state)) return;
  const selected = state.categories.find(value => value.id === item.id && value.type === item.type);
  if (!selected) return;
  state.category = selected; $('search-query').value = ''; clearTimeout(musicSearchTimer);
  activateMusicPage(state, '');
}, onRetry: () => { if (searchState?.type === 'music') void loadMusicCategories(searchState); }});

// activities 只关联平台活动与其真实话题；账号缓存不代替上传准备时的实时验证。
const activities = mountActivities({container: $('studio-activities'), current, supports, safeURL,
  identity: () => `${current().id}:${session.activeProfileId || ''}:${session.account?.id || ''}`,
  cacheScope: () => `${session.activeProfileId || ''}:${session.account?.id || ''}:${current().kind}`,
  request: (...args) => client.request(...args), blocked: () => busy || connecting,
  onChanged: () => { $('description').value = current().description; markChanged(); renderResources(); },
});

// aiAssistant 将模型分析和真实平台候选分开，应用前始终检查作品及账号身份。
const aiAssistant = createStudioAI({client, getCurrent: () => ({draftId: current().id,
  accountId: session.account?.id || '', profileId: session.activeProfileId || '', connected: session.connected, revision: contentSignature(current())})});
const aiPanel = mountStudioAIPanel({assistant: aiAssistant, current, preferences: () => store.data,
  baseURL: context.apiBaseURL, mediaURL, safeURL, assetDetail: id => assetDetails.get(id),
  savePreferences: value => {
    if (Object.hasOwn(value, 'aiContext')) current().aiContext = value.aiContext;
    if (Object.hasOwn(value, 'aiPrompt')) store.data.aiPrompt = value.aiPrompt;
    markChanged({content: false});
  }, apply: applyAIResult,
});

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

// supports 表示已接入的能力；账号离线不撤销本地编辑入口，实际联网操作单独报告错误。
function supports(operation) {
  if (operation === 'music.search' && current().kind === 'video') return false;
  if (session.capabilities?.byKind?.[current().kind]?.disabledOperations?.includes(operation)) return false;
  return Array.isArray(session.capabilities?.operations) && session.capabilities.operations.includes(operation);
}

// current 返回当前作品，所有编辑和提交都显式绑定这份草稿。
function current() { return store.current(); }

// currentAssetIDs 同时恢复正文与独立图库封面，封面不必属于正文图片。
function currentAssetIDs() {
  return [...new Set([...current().assets.map(asset => asset.id), ...(current().cover?.assetId ? [current().cover.assetId] : [])])];
}

// notice 以轻量反馈显示结果；普通提示自动收起，错误可手动关闭但不改动草稿或回执。
function notice(message = '', error = false) {
  clearTimeout(noticeTimer);
  $('page-notice').hidden = !message;
  $('page-notice-message').textContent = message;
  $('dismiss-page-notice').hidden = !error;
  $('page-notice').classList.toggle('error', error);
  $('page-notice').setAttribute('role', error ? 'alert' : 'status');
  if (message && !error) noticeTimer = setTimeout(() => { $('page-notice').hidden = true; fitWorkspace(); }, 6000);
  fitWorkspace();
}

// musicPreviewNotice 将试听反馈放在选曲旁，避免滚动至扩展信息时看不到页首错误。
function musicPreviewNotice(message = '') {
  const node = $('music-preview-message');
  node.textContent = message; node.hidden = !message;
  musicPreviewMessageIdentity = message ? JSON.stringify([musicSearchIdentity(), current().music?.id, current().music?.name]) : '';
  fitWorkspace();
}

// fitWorkspace 将高度交给 CSS 的视口两栏布局；提示变化不通过脚本重置滚动或预览位置。
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
    const row = element('div', 'draft-row'); row.dataset.draftId = draft.id;
    const button = element('button', 'draft-item');
    button.setAttribute('aria-current', String(draft.id === current().id));
    button.disabled = busy;
    const text = element('span', 'draft-text');
    text.append(element('strong', '', draft.name || draft.title || '未命名作品'));
    text.append(element('small', '', `${draft.kind === 'image' ? '图文' : '视频'} · ${draft.assets.length} 项${draft.receipt ? ' · ' + receiptTitles[draft.receipt.status] : ''}`));
    button.append(element('span', 'draft-icon', draft.kind === 'image' ? '▧' : '▷'), text);
    button.onclick = () => { void switchDraft(draft.id); };
    const remove = element('button', 'draft-delete', '删除'); remove.type = 'button'; remove.disabled = busy;
    remove.setAttribute('aria-label', '删除草稿：' + (draft.name || draft.title || '未命名作品'));
    remove.onclick = () => { void deleteDraft(draft.id); };
    row.append(button, remove); $('draft-list').append(row);
  }
}

// deleteDraft 只移除本机作品；不调用图库或平台删除，也不清除发布防重记录。
async function deleteDraft(id) {
  if (busy) return;
  const draft = store.data.drafts.find(item => item.id === id);
  if (!draft) return;
  const accepted = await confirmDialog({title: '删除这份本机草稿？', rows: [['草稿', draft.name || draft.title || '未命名作品']],
    message: '只删除工作台中的这份草稿，不删除图库素材或平台作品。' + (draft.receipt ? '此操作不会撤销已提交的作品，发布记录仍会保留。' : ''),
    submit: '删除草稿', danger: true});
  if (!accepted || busy || !store.data.drafts.includes(draft)) return;
  const index = store.data.drafts.indexOf(draft), wasCurrent = current() === draft, wasLast = store.data.drafts.length === 1;
  const previousPrepared = prepared, previousFocus = focusID;
  statusQueries.get(id)?.abort(); statusQueries.delete(id);
  store.remove(id);
  const replacement = current(), deletionRevision = store.revision;
  if (wasCurrent) { prepared = null; focusID = null; stopMusic(); render(); }
  else { renderDrafts(); renderSaveState(); }
  if (!(await saveDraft(false))) {
    // 写入失败只恢复被删目标；期间的新编辑和切稿不回滚。
    if (!store.data.drafts.some(item => item.id === id)) store.data.drafts.splice(Math.min(index, store.data.drafts.length), 0, draft);
    if (wasCurrent && store.revision === deletionRevision && current() === replacement) {
      if (wasLast) store.data.drafts = store.data.drafts.filter(item => item !== replacement);
      store.data.activeDraftId = id; prepared = previousPrepared; focusID = previousFocus;
      render();
    }
    store.revision++;
    renderDrafts(); renderSaveState();
    notice('删除未保存，草稿已保留。' + storageError, true);
    return;
  }
  notice('本机草稿已删除。');
  if (wasCurrent && current() === replacement) {
    await hydrateAssets(currentAssetIDs());
    if (current() === replacement) { renderMedia(); renderCover(); renderPreview(); }
  }
  renderActions();
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
      assetDetails.set(asset.id, {...asset, sizeBytes: data.sizeBytes, ...photoContext(data), error: ''});
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

// reorderImage 仅调整发布素材顺序，封面与当前预览继续跟随素材身份，保存失败保留编辑供重试。
async function reorderImage(sourceID, targetID) {
  if (busy || connecting || current().kind !== 'image') return;
  const draft = current(), from = draft.assets.findIndex(asset => asset.id === sourceID), to = draft.assets.findIndex(asset => asset.id === targetID);
  if (from < 0 || to < 0 || from === to) return;
  setBusy(true, 'editing');
  try {
    const [moving] = draft.assets.splice(from, 1);
    draft.assets.splice(to, 0, moving);
    markChanged(); renderMedia(); renderPreview();
    if (!(await saveDraft(false))) { notice(storageError, true); window.alert(storageError); }
  } finally { setBusy(false); render(); }
}

// removeImage 只移除本机草稿引用；保留图库文件，移除封面图片时同步清空封面与裁剪。
async function removeImage(id) {
  if (busy || connecting) return;
  const draft = current(), index = draft.assets.findIndex(asset => asset.id === id && asset.kind === 'image');
  if (index < 0) return;
  setBusy(true, 'editing');
  try {
    draft.assets.splice(index, 1);
    // 移出正文不删除图库图片；显式选定的封面继续作为独立图片保留。
    if (focusID === id) focusID = draft.assets[Math.min(index, draft.assets.length - 1)]?.id || null;
    markChanged(); renderMedia(); renderCover();
    if (!(await saveDraft(false))) {
      // 失败保留用户的编辑结果及未保存状态，重试只保存草稿，不重复移除其他图片。
      notice(storageError, true); window.alert(storageError);
    }
  } finally { setBusy(false); render(); }
}

// renderCoverSelection 使用独立圆形勾选按钮；点击缩略图只放大，不改变当前暂选封面。
function renderCoverSelection() {
  const grid = $('cover-picker-grid'); grid.replaceChildren();
  for (const [index, asset] of current().assets.entries()) {
    if (asset.kind !== 'image') continue;
    const selected = coverSelection?.assetId === asset.id;
    const card = element('div', 'cover-picker-card' + (selected ? ' is-selected' : ''));
    const preview = element('button', 'cover-picker-preview'); preview.type = 'button';
    preview.setAttribute('aria-label', `放大图片：${asset.name}`); preview.append(mediaImage(asset));
    preview.onclick = () => gallery.open(index);
    const toggle = element('button', 'cover-picker-select'); toggle.type = 'button';
    toggle.setAttribute('aria-label', `${selected ? '取消选择' : '选择素材'}：${asset.name}`);
    toggle.setAttribute('aria-pressed', String(selected));
    // 固定矢量图形与图库的 circle / checkmark.circle.fill 保持一致，不插入素材内容。
    toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle class="selection-circle" cx="12" cy="12" r="10.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path class="selection-check" d="m7 12 3.3 3.3L17 8.5" fill="none" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    toggle.onclick = () => {
      if (busy || !coverSelection || coverSelection.draftId !== current().id) return;
      coverSelection.assetId = selected ? null : asset.id;
      renderCoverSelection();
      [...grid.querySelectorAll('.cover-picker-select')][index]?.focus({preventScroll: true});
    };
    card.append(preview, toggle); grid.append(card);
  }
  $('cover-picker-confirm').disabled = !coverSelection?.assetId || busy;
}

// chooseCover 提供本次图片快捷选择及独立图库入口；没有正文图片时直接打开图库。
function chooseCover() {
  if (busy || connecting) return;
  if (current().kind !== 'image') return;
  if (!current().assets.some(asset => asset.kind === 'image')) { void chooseLibrary('cover'); return; }
  const cover = current().cover;
  coverSelection = {draftId: current().id, assetId: cover?.type === 'asset' && current().assets.some(asset => asset.id === cover.assetId) ? cover.assetId : null};
  renderCoverSelection(); $('cover-picker').showModal();
}

// confirmCoverSelection 只绑定仍在当前草稿中的图片；相同封面保留裁剪，换图时清除旧裁剪。
async function confirmCoverSelection() {
  if (busy || !coverSelection || coverSelection.draftId !== current().id) return;
  const asset = current().assets.find(item => item.id === coverSelection.assetId && item.kind === 'image');
  if (!asset) return;
  $('cover-picker').close(); coverSelection = null;
  if (current().cover?.type === 'asset' && current().cover.assetId === asset.id) return;
  setBusy(true, 'editing');
  try {
    current().cover = {type: 'asset', assetId: asset.id, name: asset.name, ...(asset.localOnly ? {localOnly: true} : {})};
    markChanged(); renderCover();
    if (!(await saveDraft(false))) { notice(storageError, true); window.alert(storageError); }
  } finally { setBusy(false); render(); }
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

// renderMedia 展示图片和独立移除入口，点击放大与滑动只更新查看焦点。
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
  $('spec-quality-description').textContent = video ? '保留图库原始视频文件，上传后由平台完成转码。' : '每篇图文可添加 1–35 张图片，点击图片可放大查看，可独立选择封面。';
  $('spec-ratio-title').textContent = video ? '视频画幅' : '作品素材';
  $('spec-ratio-description').textContent = video ? '上传前可在右侧预览画面；视频图片封面暂未接入。' : '选择图库内的原始素材，上传前可预览并核对作品内容。';
  $('media-heading').textContent = video ? '编辑视频' : '编辑图片';
  document.querySelector('.preview-heading strong').textContent = video ? '预览视频' : '预览图文';
  $('media-empty').hidden = editing;
  gallery.render({assets: previewAssets(), index: Math.max(0, draft.assets.findIndex(asset => asset.id === focusID)), disabled: busy || connecting, scope: draft.id});
  $('preview-file-label').hidden = !!context.nativeUIAvailable;
  $('import-host').hidden = !context.apiBaseURL || !context.selectedAssetIDs?.length;
  $('import-host').disabled = busy || !context.selectedAssetIDs?.length;
}

// previewAssets 只把已验证素材的可访问地址传入图片画廊，不传内部文件路径。
function previewAssets() {
  return current().assets.map(asset => ({id: asset.id, alt: asset.name, kind: asset.kind,
    url: assetDetails.get(asset.id)?.error ? '' : mediaURL(asset, asset.kind === 'video' ? 'original' : 'preview')}));
}

// renderPreview 使用当前账号和正文绘制抖音样式预览，未提供的互动数量不作模拟。
function renderPreview() {
  descriptionHighlight.render();
  const draft = current();
  phone.render({assets: previewAssets(), index: Math.max(0, draft.assets.findIndex(asset => asset.id === focusID)),
    accountName: session.account?.name || '尚未验证发布账号', avatarURL: safeURL(session.account?.avatarURL),
    title: draft.title, description: draft.description, musicName: draft.music?.name || ''});
  $('title-count').textContent = `${draft.title.length} / ${session.capabilities?.limits?.titleLength || 20}`;
  $('description-count').textContent = `${draft.description.length} / ${session.capabilities?.limits?.descriptionLength || 1000}`;
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
  $('cover-note').textContent = cover ? '封面独立于正文素材顺序' : draft.kind === 'image' ? '选择一张图片作为作品封面' : '图片封面暂未接入；帧封面按连接能力开放';
  $('clear-cover').hidden = !cover;
  $('crop-cover').hidden = !cover?.assetId || !!asset?.localOnly || draft.kind !== 'image';
  $('choose-frame').hidden = draft.kind !== 'video' || !supports('cover.frames');
  $('choose-cover').disabled = busy || connecting || draft.kind !== 'image';
  $('crop-cover').disabled = busy;
}

// renderResources 显示所选配乐、地点和合集的明确身份，试听 URL 仅存在本次内存。
function renderResources() {
  if (musicPreviewMessageIdentity && musicPreviewMessageIdentity !== JSON.stringify([musicSearchIdentity(), current().music?.id, current().music?.name])) musicPreviewNotice();
  $('music-name').textContent = current().music?.name || '点击添加适合作品风格音乐';
  $('clear-music').hidden = !current().music;
  savedMusicPreview.render();
  resources.render(); hotspot.render(); renderCover();
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
    radio.onchange = () => {
      if (!radio.checked || busy) return;
      if (id === 'visibility') { void changeVisibility(radio.value); return; }
      current().settings[id] = radio.value; markChanged();
    };
    radio.setAttribute('aria-label', option.label || option.value);
    const labelText = id === 'download' && ['allow', 'deny'].includes(option.value) ? (option.value === 'allow' ? '允许' : '不允许') : option.label || option.value;
    label.append(radio, document.createTextNode(labelText)); group.append(label);
  }
}

// collectionSettingsOwner 把异步确认绑定到发起草稿及账号，期间本地设置变化也不覆盖。
function collectionSettingsOwner() {
  const draft = current();
  const scope = () => JSON.stringify([current().id, current().kind, session.activeProfileId || '', session.account?.id || '', current().settings.visibility, current().collection]);
  const key = scope();
  return () => current() === draft && scope() === key && !busy;
}

// visibilityLabel 将本地可见范围值转成确认窗口和行内说明使用的名称。
function visibilityLabel(value) { return value === 'friends' ? '好友可见' : value === 'private' ? '仅自己可见' : '公开'; }

// restoreVisibility 保留现有单选节点及焦点，未确认前表单始终反映已保存的草稿值。
function restoreVisibility() {
  for (const radio of $('visibility').querySelectorAll('input')) radio.checked = radio.value === current().settings.visibility;
}

// commitCollectionSettings 一次更新相关字段，并沿用草稿保存与上传准备失效流程。
function commitCollectionSettings(collection, visibility) {
  current().collection = collection;
  current().settings.visibility = visibility;
  markChanged(); renderResources(); renderSettings();
}

// selectCollection 只在加入合集会改变隐私时确认；清除合集始终是本地编辑。
async function selectCollection(collection) {
  if (busy || connecting) return;
  const draft = current(), owns = collectionSettingsOwner();
  if (collection && draft.settings.visibility !== 'public') {
    const accepted = await confirmDialog({title: '设为公开并加入合集？',
      message: `合集作品需要公开可见。当前为“${visibilityLabel(draft.settings.visibility)}”，加入“${collection.name}”会同时改为公开，所有人都可以看到。`,
      submit: '设为公开并加入'});
    if (!owns()) return;
    if (!accepted) { $('search-collection').focus(); return; }
  }
  if (!owns()) return;
  commitCollectionSettings(collection, collection ? 'public' : draft.settings.visibility);
  $('search-collection').focus();
}

// changeVisibility 先还原浏览器的临时单选状态，确认后才同时移除不兼容的合集。
async function changeVisibility(visibility) {
  restoreVisibility();
  if (busy || visibility === current().settings.visibility) return;
  const draft = current(), owns = collectionSettingsOwner();
  if (draft.collection && visibility !== 'public') {
    const accepted = await confirmDialog({title: '移除合集并更改可见范围？',
      message: `合集作品需要公开可见。改为“${visibilityLabel(visibility)}”会同时移除合集“${draft.collection.name}”。`,
      submit: '移除合集并更改'});
    if (!owns()) return;
    if (!accepted) { $('visibility').querySelector('input:checked')?.focus(); return; }
  }
  if (!owns()) return;
  commitCollectionSettings(visibility === 'public' ? draft.collection : null, visibility);
  $('visibility').querySelector('input:checked')?.focus();
}

// renderCollectionVisibility 对旧冲突仅说明原因，由用户明确选择保留隐私或保留合集。
function renderCollectionVisibility() {
  const draft = current(), conflict = !!draft.collection && draft.settings.visibility !== 'public';
  $('visibility-collection-note').hidden = !draft.collection || conflict;
  $('visibility-collection-conflict').hidden = !conflict;
  $('visibility-collection-reason').textContent = conflict ? `合集“${draft.collection.name}”需要公开可见，当前为“${visibilityLabel(draft.settings.visibility)}”。请选择一种处理方式，原设置暂时保留。` : '';
  $('visibility-conflict-public').disabled = busy;
  $('visibility-conflict-remove').disabled = busy;
}

// renderSettings 不以默认选项推断远端能力；最后由平台准备结果校验可发布性。
function renderSettings() {
  fillOptions('visibility', session.capabilities?.options?.visibility, [{value: 'public', label: '公开'}, {value: 'friends', label: '好友可见'}, {value: 'private', label: '仅自己可见'}]);
  fillOptions('download', session.capabilities?.options?.download, [{value: 'allow', label: '允许'}, {value: 'deny', label: '不允许'}]);
  renderCollectionVisibility();
  $('scheduled').checked = current().settings.publishTime === 'scheduled';
  $('immediate').checked = !$('scheduled').checked;
  $('scheduled-at').value = current().settings.scheduledAt;
  $('schedule-fields').hidden = !$('scheduled').checked;
  $('timezone').textContent = $('scheduled').checked ? Intl.DateTimeFormat().resolvedOptions().timeZone : '';

}

// validationIssue 只做本机可确定的校验，不替平台猜测账号权限或发布时间范围。
function validationIssue() {
  const draft = current();
  if (!session.account?.id) return '请先选择发布账号';
  if (!supports('publication.prepare')) return '当前连接尚未提供上传准备能力';
  if (!draft.assets.length) return '请先加入作品素材';
  if (draft.assets.some(asset => asset.localOnly)) return '预览文件需先加入图库，再带入作品';
  if (draft.assets.some(asset => asset.kind !== draft.kind)) return '请移除与作品类型不一致的素材';
  if (draft.kind === 'video' && draft.assets.length !== 1) return '视频作品需要且只能包含一个视频';
  if (draft.kind === 'image' && draft.assets.length > (session.capabilities?.limits?.imageCount || 35)) return '图片数量超过当前账号允许范围';
  if (draft.assets.some(asset => assetDetails.get(asset.id)?.error)) return '部分素材不可用，请重读或移除';
  if (draft.title.length > (session.capabilities?.limits?.titleLength || 20)) return '标题超过当前允许长度';
  if (draft.description.length > (session.capabilities?.limits?.descriptionLength || 1000)) return '描述超过当前允许长度';
  if (new Set([...draft.topics.map(topicKey), ...draft.activities.map(item => topicKey(item.topic))]).size > 5) return '话题和官方活动合计最多添加 5 个';
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
  savedMusicPreview.render();
  const issue = validationIssue();
  $('prepare').disabled = busy || connecting || !!issue;
  $('publish').disabled = busy || connecting || !!issue || !supports('publication.publish') || !preparationValid();
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
  const multipleAccounts = context.nativeCapabilities?.sessionProfilesVersion === 1;
  $('account-select').disabled = connecting || busy || !multipleAccounts || !session.profiles.length;
  accountSelector.render();
  $('import-session').disabled = connecting || busy || !nativeAvailable;
  $('import-session').textContent = multipleAccounts && session.profiles.length ? '添加账号' : '登录抖音';
  const canRelogin = multipleAccounts && session.profiles.some(profile => profile.id === session.activeProfileId);
  $('relogin-session').hidden = !canRelogin;
  $('relogin-session').disabled = connecting || busy || !nativeAvailable || !canRelogin;
  $('clear-session').disabled = connecting || busy || !nativeAvailable || (!session.activeProfileId && !session.connected);
  for (const id of ['new-image', 'new-video', 'duplicate', 'delete-draft', 'mode-image', 'mode-video']) $(id).disabled = busy;
  for (const node of document.querySelectorAll('.draft-item, .draft-delete')) node.disabled = busy;
  for (const node of document.querySelectorAll('[data-operation]')) {
    const supported = node.dataset.operation === 'topics.search' || supports(node.dataset.operation);
    node.disabled = busy || !supported;
    node.title = supported ? '' : session.connected ? '当前版本尚未支持此能力' : '请先登录抖音并核对账号';
  }
  $('open-ai').disabled = busy || !context.apiBaseURL;
  const queryingStatus = statusQueries.has(current().id);
  $('refresh-publication').disabled = busy || queryingStatus || !supports('publication.status');
  $('status-shortcut').disabled = busy || queryingStatus || !supports('publication.status');
  $('refresh-publication').textContent = $('status-shortcut').textContent = queryingStatus ? '查询中…' : '查询状态';
  $('status-shortcut').hidden = !current().receipt?.requestId;
  $('prepare').hidden = !!current().receipt?.requestId && current().receipt?.status !== 'failed';
  activities.render(); hotspot.render();
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
  renderAccounts();
  $('connection-dot').classList.toggle('online', session.connected && !!session.account?.id);
  $('connection-dot').classList.toggle('error', session.connected && !session.account?.id);
  $('connection-label').textContent = connecting ? '正在处理账号…' : session.account?.id ? `${session.account.name || '已选账号'}${session.connected ? '' : ' · 离线'}` : context.nativeCapabilities?.sessionVersion === 1 ? '请选择账号' : '请更新 App';
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

// renderAccounts 只展示宿主保存的账号名称；存在历史档案不代表会话仍有效，选中后仍须平台核验。
function renderAccounts() {
  const select = $('account-select');
  select.replaceChildren();
  const placeholder = element('option', '', context.nativeCapabilities?.sessionProfilesVersion !== 1 ? '更新 App 后可切换账号' : session.profiles.length ? '选择已登录账号' : '暂无已登录账号');
  placeholder.value = ''; placeholder.disabled = true; select.append(placeholder);
  for (const profile of session.profiles) {
    const sameName = session.profiles.some(item => item.id !== profile.id && item.name === profile.name);
    const identity = sameName && profile.accountId ? ` · …${profile.accountId.slice(-4)}` : '';
    const option = element('option', '', profile.name + identity + (profile.browserSessionAvailable ? '' : ' · 需重新登录'));
    option.value = profile.id; select.append(option);
  }
  select.value = session.activeProfileId || '';
}

// acceptSession 更新已验证会话，换号后使所有上传准备失效。
function acceptSession(value = {}) {
  const previousAccount = session.account?.id;
  const previousProfile = session.activeProfileId;
  if (typeof value.connected === 'boolean') session.connected = value.connected;
  if (Object.hasOwn(value, 'account')) session.account = value.account?.id ? {...value.account, id: String(value.account.id), name: String(value.account.name || '')} : null;
  if (value.capabilities) session.capabilities = value.capabilities;
  if (Object.hasOwn(value, 'expiresAt')) session.expiresAt = value.expiresAt;
  if (Array.isArray(value.profiles)) session.profiles = value.profiles.filter(profile => typeof profile?.id === 'string' && typeof profile.name === 'string');
  if (Object.hasOwn(value, 'activeProfileId')) session.activeProfileId = value.activeProfileId || null;
  if (previousAccount !== session.account?.id || previousProfile !== session.activeProfileId) {
    prepared = null;
    if (searchState?.type === 'music' && $('search-dialog').open) $('search-dialog').close();
  }
  aiPanel.sync();
  activities.render(); hotspot.render();
  renderSettings(); renderResources(); renderConnection(value.message || '');
}

// checkInterface 只响应明确的检查、登录或清除动作，用户在官方窗口完成登录。
async function checkInterface(action = 'check', profileId = null) {
  if (connecting || busy) return;
  connecting = true; renderConnection();
  try {
    const result = await (action === 'import' ? client.importSession() : action === 'relogin' ? client.reloginSession() : action === 'clear' ? client.clearSession() : action === 'select' ? client.selectAccount(profileId) : client.connect());
    if (action !== 'check') prepared = null;
    acceptSession(result || {});
    if ($('account-menu')) $('account-menu').open = false;
  } catch (error) { renderConnection(error.message || '会话操作未完成，请检查后重试。', {error: true}); }
  finally { connecting = false; renderActions(); $('connect').disabled = busy; $('connection-label').textContent = session.account?.id ? `${session.account.name || '已选账号'}${session.connected ? '' : ' · 离线'}` : context.nativeCapabilities?.sessionVersion === 1 ? '请选择账号' : '请更新 App'; }
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

// activity 展示本次总体说明，素材阶段由进度控件原位更新，不堆叠成重复上传记录。
function activity(message, progress) {
  $('activity-panel').hidden = false;
  $('activity-message').textContent = message || '正在处理…';
  preparationProgress.update(progress);
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
  preparationProgress.reset();
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
    resources.invalidateRecommendations();
    preparationProgress.finish('completed');
    activity('素材与作品检查完成。请核对账号，再点击发布。');
    notice('准备完成，尚未发布。');
  } catch (error) {
    const message = error.name === 'AbortError' ? '已停止等待准备结果。已完成的上传以执行模块任务记录为准，尚未发布。' : error.message || '准备失败，请重试。';
    preparationProgress.finish(error.name === 'AbortError' ? 'cancelled' : 'failed');
    activity(message); notice(message, true);
    // 提交检查失败保留草稿并使用宿主原生提示；用户主动取消无需再次弹窗。
    if (error.name !== 'AbortError') window.alert(message);
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
    rows: [['发布账号', `${snapshot.account.name}（${snapshot.account.id}）`], ['作品标题', draft.title || '未填写标题'], ['作品类型', `${draft.kind === 'image' ? '图文' : '视频'} · ${draft.assets.length} 项素材`], ['可见范围', $('visibility').querySelector('input:checked')?.getAttribute('aria-label') || draft.settings.visibility], ['发布时间', draft.settings.publishTime === 'scheduled' ? draft.settings.scheduledAt.replace('T', ' ') + ' · ' + Intl.DateTimeFormat().resolvedOptions().timeZone : '立即发布']],
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
function applyReceipt(result, requestId, draft = current()) {
  const status = Object.hasOwn(receiptTitles, result?.status) ? result.status : 'unknown';
  draft.receipt = {
    requestId, status, publicationId: typeof result?.publicationId === 'string' ? result.publicationId : draft.receipt?.publicationId || '',
    message: typeof result?.message === 'string' ? result.message : '', updatedAt: new Date().toISOString(),
  };
  const url = safeURL(result?.url);
  if (url) publicationLinks.set(requestId, url);
  if (draft.id !== current().id) return;
  activity(receiptTitles[status] + (result?.message ? '：' + result.message : ''));
  notice(status === 'published' ? '平台已确认作品发布成功。' : status === 'scheduled' ? '平台已接受定时发布。' : status === 'processing' ? '平台正在处理，请稍后查询状态。' : result?.message || '发布结果尚未确认，请查询状态。', ['failed', 'unknown'].includes(status));
}

// refreshPublication 仅查询已有提交，绝不自动重新上传或重新发布。
async function refreshPublication() {
  const draft = current(), receipt = draft.receipt;
  if (!receipt?.requestId || busy || statusQueries.has(draft.id) || !supports('publication.status')) return;
  const controller = new AbortController();
  statusQueries.set(draft.id, controller); renderActions();
  try {
    const result = await client.request('publication.status', {publicationId: receipt.publicationId || undefined, requestId: receipt.requestId}, {signal: controller.signal});
    if (controller.signal.aborted || !store.data.drafts.includes(draft) || draft.receipt !== receipt) return;
    applyReceipt(result, receipt.requestId, draft); store.touch(draft); await saveDraft(false);
  } catch (error) {
    if (!controller.signal.aborted && current().id === draft.id) notice(error.message || '状态查询失败，原提交记录已保留。', true);
  } finally { statusQueries.delete(draft.id); renderReceipt(); renderDrafts(); renderActions(); }
}

// musicSearchIdentity 将分类和结果绑定当前作品类型及账号，避免关闭/切换后的迟到页面混入。
function musicSearchIdentity() { return JSON.stringify([current().id, current().kind, session.account?.id || '', session.activeProfileId || '']); }

// ownsMusicSearch 同时检查抽屉实例和会话身份，不把旧分类查询当作新账号的目录。
function ownsMusicSearch(state) { return searchState === state && $('search-dialog').open && state.identity === musicSearchIdentity(); }

// 试听失败后仅由用户再次点击触发：刷新同一音乐 ID 的音源，不应用或替换作品配乐。
async function refreshMusicPreview(item, {signal} = {}) {
  const state = searchState;
  const requireCurrent = () => {
    if (signal?.aborted || state?.type !== 'music' || !ownsMusicSearch(state)) throw new DOMException('已取消旧音乐试听', 'AbortError');
  };
  requireCurrent();
  const fresh = await client.request('music.resolve', {id: String(item.id), refreshSource: true}, {signal});
  requireCurrent();
  if (fresh?.id !== String(item.id)) throw Error('返回的音乐与当前曲目不一致，请重新读取音乐列表。');
  const previewURL = safeURL(fresh.previewURL);
  if (!previewURL) throw Error('这首音乐暂时没有可用音源，请稍后重试或选择其他音乐。');
  const updated = {...item, ...fresh, previewURL};
  const replace = values => values.map(value => value.id === updated.id ? {...value, ...updated} : value);
  state.items = replace(state.items);
  for (const page of state.musicPages.values()) page.items = replace(page.items);
  musicCandidates.set(updated.id, updated);
  resourcePreviews.set('music:' + updated.id, previewURL);
  return updated;
}

// musicPageKey 按关键词或真实分类复合身份隔离分页，同 ID 的 recommend/rank 不共用游标。
function musicPageKey(state, query) { return query ? 'query:' + query : state.category ? `category:${state.category.type}:${state.category.id}` : 'category:pending'; }

// rememberMusicPage 只保留本抽屉的成功内容或可重试错误，取消中的未完成首页不作为缓存命中。
function rememberMusicPage(state) {
  if (!state.musicPageKey || (!state.loaded && !state.failed && !state.items.length)) return;
  state.musicPages.set(state.musicPageKey, {items: [...state.items], cursor: state.cursor, hasMore: state.hasMore, query: state.query,
    failed: !!state.failed, retryMore: state.retryMore, loaded: !!state.loaded, message: state.message || '', scrollTop: $('search-results').scrollTop});
  while (state.musicPages.size > 30) state.musicPages.delete(state.musicPages.keys().next().value);
}

// renderMusicSearch 恢复当前页状态和分类高亮；列表换页不会停止已有试听音轨。
function renderMusicSearch(state) {
  if (!ownsMusicSearch(state)) return;
  musicCategories.render({items: state.categories, selected: state.category, searching: !!$('search-query').value.trim(), loading: state.categoriesLoading, error: state.categoriesError});
  renderSearchMessage(state);
  $('run-search').disabled = !!state.loading;
  $('search-more').disabled = !!state.loading;
  $('search-more').hidden = !state.hasMore && !state.failed;
  $('search-more').textContent = state.failed ? '重试' : '加载更多';
  drawSearchResults();
}

// renderSearchMessage 分开保留列表加载和选曲保存反馈，后台续页不会清掉正在保存或失败提示。
function renderSearchMessage(state, message = state.message || '') {
  state.message = message;
  if (searchState === state) $('search-message').textContent = state.selecting ? '正在保存配乐…' : state.selectionError || message;
}

// activateMusicPage 切分类/关键词时取消旧查询并恢复该页独立游标，未读页才发新请求。
function activateMusicPage(state, query, {load = true} = {}) {
  if (!ownsMusicSearch(state)) return;
  const key = musicPageKey(state, query);
  if (state.musicPageKey !== key) {
    rememberMusicPage(state);
    searchController?.abort(); searchGeneration += 1;
    const saved = state.musicPages.get(key);
    Object.assign(state, saved || {items: [], cursor: null, hasMore: false, failed: false, retryMore: false, loaded: false, message: ''});
    state.musicPageKey = key; state.query = query; state.loading = false;
    renderMusicSearch(state); $('search-results').scrollTop = saved?.scrollTop || 0;
  } else renderMusicSearch(state);
  if (load && !state.loaded && !state.failed && !state.loading && (query || state.category)) void runSearch(false);
}

// preloadMusicPage 在布局完成后按剩余高度串行续页；短页和过滤空页不依赖用户先滚动。
function preloadMusicPage(state, generation) {
  requestAnimationFrame(() => {
    if (generation !== searchGeneration || !ownsMusicSearch(state) || state.loading || state.failed || !state.hasMore) return;
    const list = $('search-results');
    if (list.clientHeight > 0 && list.scrollHeight - list.scrollTop - list.clientHeight < list.clientHeight) void runSearch(true);
  });
}

// loadMusicCategories 仅读取真实目录，默认首个推荐类；失败只重试分类，不伪造固定标签。
async function loadMusicCategories(state) {
  if (!ownsMusicSearch(state) || state.categoriesLoading) return;
  state.categoryController?.abort(); state.categoryController = new AbortController();
  const controller = state.categoryController;
  state.categoriesLoading = true; state.categoriesError = ''; renderMusicSearch(state);
  try {
    const result = await client.request('music.categories', {kind: current().kind}, {signal: controller.signal});
    if (!ownsMusicSearch(state) || state.categoryController !== controller || controller.signal.aborted) return;
    if (!Array.isArray(result?.items)) throw Error('音乐分类读取不完整，请重试。');
    const seen = new Set();
    state.categories = result.items.filter(item => {
      const key = `${item?.type}:${item?.id}`;
      return item && typeof item.id === 'string' && /^\d{1,30}$/.test(item.id) && ['recommend', 'rank', 'fav', 'category'].includes(item.type)
        && typeof item.name === 'string' && item.name.trim() && !seen.has(key) && seen.add(key);
    });
    state.category = state.categories.find(item => item.id === state.category?.id && item.type === state.category?.type)
      || state.categories.find(item => item.type === 'recommend') || state.categories[0] || null;
    if (!$('search-query').value.trim()) state.message = state.category ? '' : '当前账号没有可用的音乐分类，可以输入关键词搜索音乐。';
  } catch (error) {
    if (!ownsMusicSearch(state) || controller.signal.aborted) return;
    state.categoriesError = error.message || '音乐分类读取失败，请重试。';
    if (!$('search-query').value.trim()) state.message = state.categoriesError;
  } finally {
    if (ownsMusicSearch(state) && state.categoryController === controller) {
      state.categoriesLoading = false; renderMusicSearch(state);
      if (!state.categoriesError) activateMusicPage(state, $('search-query').value.trim());
    }
  }
}

// openSearch 为真实资源查询提供统一可取消弹窗，搜索结果不会自动应用。
async function openSearch(type) {
  if (busy || searchOpening || $('search-dialog').open) return;
  const configurations = {
    topics: {operation: 'topics.search', title: '添加话题', placeholder: '搜索话题'},
    mentions: {operation: 'users.search', title: '提及用户', placeholder: '搜索用户昵称'},
    music: {operation: 'music.search', title: '选择音乐', placeholder: '搜索音乐'},
    location: {operation: 'locations.search', title: '选择位置', placeholder: '输入具体地点名称'},
    collection: {operation: 'collections.list', title: '选择普通合集', placeholder: '筛选合集名称'},
    frame: {operation: 'cover.frames', title: '选择视频帧', placeholder: ''},
  };
  const configuration = configurations[type];
  if (!configuration || (configuration.operation && !supports(configuration.operation))) return;
  searchOpening = true;
  searchController?.abort(); searchGeneration += 1;
  searchState = {...configuration, type, draftId: current().id, items: [], cursor: null, hasMore: false, loading: false, query: ''};
  if (type === 'music') Object.assign(searchState, {identity: musicSearchIdentity(), categories: [], category: null, categoriesLoading: false,
    categoriesError: '', categoryController: null, musicPages: new Map(), musicPageKey: null, loaded: false, message: ''});
  $('search-heading').textContent = configuration.title;
  $('search-query').value = '';
  $('search-query').placeholder = configuration.placeholder;
  $('search-results').replaceChildren(); $('search-message').textContent = '';
  $('search-dialog').classList.toggle('music-drawer', type === 'music');
  $('music-tabs').hidden = $('music-footnote').hidden = type !== 'music';
  $('run-search').textContent = '搜索';
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
  if (type === 'music') await loadMusicCategories(searchState);
  else if (['collection', 'frame'].includes(type)) await runSearch(false);
}

// runSearch 保留分页失败之前的结果，取消或换草稿后忽略旧响应。
async function runSearch(more = false) {
  const state = searchState;
  if (!state || state.loading || current().id !== state.draftId) return;
  const query = $('search-query').value.trim();
  if (state.type === 'music') {
    if (!ownsMusicSearch(state)) return;
    if (!more && state.musicPageKey !== musicPageKey(state, query)) { activateMusicPage(state, query); return; }
    if (!query && !state.category) return;
  }
  if (!more && !query && !['collection', 'frame', 'music'].includes(state.type)) { $('search-message').textContent = '请输入搜索关键词。'; return; }
  let city = null;
  if (state.type === 'location') {
    city = cities?.find(item => item.code === $('search-city')?.value);
    if (!city) { $('search-message').textContent = '请先选择城市，再搜索地点。'; return; }
  }
  const generation = ++searchGeneration;
  searchController?.abort(); searchController = new AbortController();
  if (!more) { state.items = []; state.cursor = null; state.hasMore = false; state.query = query; }
  state.failed = false; state.retryMore = more; state.loading = true; $('run-search').disabled = true; $('search-more').disabled = true;
  renderSearchMessage(state, '正在读取…');
  try {
    const params = {query: state.query, cursor: more ? state.cursor : undefined, kind: current().kind};
    if (state.type === 'music' && !state.query) Object.assign(params, {categoryId: state.category.id, type: state.category.type});
    if (city) Object.assign(params, {cityCode: city.code, cityName: city.name});
    if (state.type === 'frame') params.assetId = current().assets[0]?.id;
    const result = await client.request(state.operation, params, {signal: searchController.signal});
    if (generation !== searchGeneration || searchState !== state || !$( 'search-dialog').open || state.type === 'music' && !ownsMusicSearch(state)) return;
    if (!Array.isArray(result?.items)) throw Error('返回结果格式不完整，请重试。');
    const nextCursor = result.nextCursor ?? result.cursor ?? null;
    if (state.type === 'music' && more && (result.hasMore === true || result.nextCursor != null) && String(nextCursor) === String(state.cursor)) throw Error('音乐分页位置未更新，请重试当前页。');
    for (const item of result.items) {
      if (!item?.id || typeof item.name !== 'string') continue;
      const next = {...item, id: String(item.id)};
      if (city) Object.assign(next, {cityCode: city.code, cityName: city.name});
      if (!state.items.some(existing => existing.id === next.id)) state.items.push(next);
    }
    state.cursor = nextCursor;
    state.hasMore = result.hasMore === true || (result.nextCursor !== undefined && result.nextCursor !== null && result.nextCursor !== '');
    if (state.hasMore && state.cursor === null) state.hasMore = false;
    renderSearchMessage(state, state.items.length ? (state.type === 'music' ? '' : `已显示 ${state.items.length} 项，选择后加入当前作品。`) : '没有找到匹配结果。');
    state.loaded = true;
    drawSearchResults();
  } catch (error) {
    if (generation !== searchGeneration || error.name === 'AbortError') return;
    state.failed = true; renderSearchMessage(state, error.message || '读取失败，请重试。');
  } finally {
    if (generation === searchGeneration) {
      state.loading = false; $('run-search').disabled = false; $('search-more').disabled = false; $('search-more').hidden = !state.hasMore && !state.failed; $('search-more').textContent = state.failed ? '重试' : '加载更多';
      if (state.type === 'music') { rememberMusicPage(state); if (!state.failed) preloadMusicPage(state, generation); }
    }
  }
}

// drawSearchResults 每行展示真实名称与可选试听，不制造不存在的搜索资源。
function drawSearchResults() {
  const state = searchState;
  if (!state) return;
  if (state.type === 'music') {
    for (const item of state.items) {
      musicCandidates.set(item.id, item);
      const preview = safeURL(item.previewURL);
      if (preview) resourcePreviews.set('music:' + item.id, preview);
    }
    musicDrawer.render({items: state.items, selectedId: current().music?.id || '', selectingId: state.selectingId || ''});
    return;
  }
  $('search-results').replaceChildren();
  for (const item of state.items) {
    const selected = ['topics', 'mentions'].includes(state.type) ? current()[state.type].some(value => state.type === 'topics' ? topicKey(value) === topicKey(item) : value.id === item.id) : current()[state.type]?.id === item.id;
    const row = element('div', 'search-row' + (selected ? ' selected' : ''));
    if (state.type === 'music') { row.tabIndex = 0; row.setAttribute('aria-label', item.name); }
    const url = safeURL(item.thumbnailURL);
    if (url) { const image = element('img'); image.src = url; image.alt = ''; image.loading = 'lazy'; row.append(image); }
    const text = element('div', 'search-result-text'); text.append(element('strong', '', item.name));
    const detail = state.type === 'music' ? [item.description, Number.isFinite(item.duration) ? `${Math.floor(item.duration / 60).toString().padStart(2, '0')}:${Math.floor(item.duration % 60).toString().padStart(2, '0')}` : ''].filter(Boolean).join(' · ') : item.description || item.address || item.subtitle || '';
    if (detail) text.append(element('small', '', detail));
    const actions = element('div', 'search-result-actions');
    const preview = safeURL(item.previewURL);
    if (state.type === 'music' && preview) {
      resourcePreviews.set('music:' + item.id, preview);
      const button = element('button', '', '试听'); button.onclick = () => playMusic(preview); actions.append(button);
    }
    const button = element('button', '', selected ? '已添加' : '选择'); button.disabled = selected;
    button.onclick = () => { void chooseResource(item); }; actions.append(button);
    if (state.type === 'music') {
      const count = Number(item.userCount);
      const label = Number.isFinite(count) && count > 0 ? (count >= 10000 ? `${(count / 10000).toFixed(1)}万人使用` : `${count}人使用`) : '';
      const usage = element('span', 'music-usage', label);
      row.append(text, usage, actions);
    } else row.append(text, actions);
    $('search-results').append(row);
  }
}

// rememberSelectedMusic 只提交候选 ID，音源与时长由平台模块从已核验结果保存；保留其他草稿引用。
async function rememberSelectedMusic(item, {signal} = {}) {
  const identity = musicSearchIdentity();
  const requireCurrent = () => {
    if (signal?.aborted) throw new DOMException('已取消选曲', 'AbortError');
    if (identity !== musicSearchIdentity()) throw Error('作品或账号已变化，本次配乐未应用。');
  };
  // 复用在途保存，只在仍有未保存修改或失败时落盘；引用清理不得领先磁盘草稿。
  await store.pending.catch(() => {});
  requireCurrent();
  if ((store.savedRevision < store.revision || storageError) && !(await saveDraft(false))) throw Error('草稿保存失败，原配乐已保留，请保存成功后重试。');
  requireCurrent();
  const keepIds = [...new Set([...store.data.drafts.map(draft => draft.music?.id).filter(Boolean), item.id])];
  const selected = await client.request('music.select', {id: item.id, keepIds}, {signal});
  requireCurrent();
  if (selected?.id !== item.id) throw Error('保存的音乐与所选歌曲不一致，原配乐已保留。');
  return {...item, ...selected};
}

// chooseResource 仅在用户点选后持久化身份；地点保留显式城市，封面文件不进入本机 JSON。
async function chooseResource(item) {
  const state = searchState;
  if (!state || state.draftId !== current().id || busy || state.selecting) return;
  if (state.type === 'music') {
    if (!ownsMusicSearch(state)) return;
    state.selecting = true; state.selectingId = item.id; state.selectionError = '';
    state.selectionController = new AbortController();
    renderSearchMessage(state); drawSearchResults();
    try {
      item = await rememberSelectedMusic(item, {signal: state.selectionController.signal});
      if (!ownsMusicSearch(state)) return;
    } catch (error) {
      if (ownsMusicSearch(state) && error.name !== 'AbortError') state.selectionError = error.message || '音乐资料未保存，请重试。';
      return;
    } finally {
      state.selecting = false; state.selectingId = ''; state.selectionController = null;
      if (ownsMusicSearch(state)) { renderSearchMessage(state); drawSearchResults(); }
    }
  }
  if (['topics', 'mentions'].includes(state.type)) {
    const value = entityValue(item);
    if (!value) return;
    if (!current()[state.type].some(existing => state.type === 'topics' ? topicKey(existing) === topicKey(value) : existing.id === value.id)) current()[state.type].push(value);
  } else if (state.type === 'frame') {
    if (!Number.isFinite(item.timeMs)) { $('search-message').textContent = '这项结果缺少有效的视频时间，无法选为封面。'; return; }
    current().cover = {type: 'frame', assetId: current().assets[0].id, id: item.id, timeMs: item.timeMs, name: item.name};
    const url = safeURL(item.thumbnailURL); if (url) resourcePreviews.set('cover:' + item.id, url);
  } else {
    current()[state.type] = entityValue(item);
    if (state.type === 'location' && item.cityCode) Object.assign(current().location, {cityCode: item.cityCode, cityName: item.cityName});
  }
  markChanged(); renderResources(); drawSearchResults();
  if (!['topics', 'mentions'].includes(state.type)) {
    if (state.type === 'music') {
      const identity = musicSearchIdentity();
      // close 的既有处理先停止抽屉试听，之后才给当前选曲保存内存音源，避免立即被清掉。
      $('search-dialog').addEventListener('close', () => {
        if (musicSearchIdentity() === identity) savedMusicPreview.prime(item);
      }, {once: true});
    }
    $('search-dialog').close();
  }
}

// stopMusic 在草稿切换时停止试听，不把试听当作作品已配乐成功。
function stopMusic() { savedMusicPreview.reset(); musicDrawer.stop(); }

// playMusic 复用实际歌曲元数据与试听地址，播放器状态由音频事件驱动。
function playMusic(url) {
  const source = safeURL(url);
  if (!source) return;
  const item = musicCandidates.get(current().music?.id) || {...current().music, previewURL: source};
  musicDrawer.play(item);
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
  aiPanel.sync();
  activities.render(); hotspot.render();
  const draft = current();
  if (renderedDraftId !== draft.id) {
    if (searchState?.type === 'music' && $('search-dialog').open) $('search-dialog').close();
    if (renderedDraftId !== null) notice();
    $('activity-panel').hidden = true;
    preparationProgress.reset();
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

// applyAIResult 只应用用户勾选的建议；未勾选位置和音乐保留手动选择，草稿变化则拒绝旧结果。
async function applyAIResult(value, selection) {
  if (busy || !aiAssistant.isCurrent(value)) throw Error('作品内容或账号已变化，请重新生成建议。');
  const replacements = [];
  if (selection.copy && (current().title || current().description)) replacements.push('标题和描述');
  if (selection.location && value.location && current().location) replacements.push('位置');
  if (selection.music && value.music && current().music) replacements.push('背景音乐');
  if (replacements.length && !(await confirmDialog({title: '应用 AI 建议？', message: `将替换当前${replacements.join('、')}。`, submit: '应用所选'}))) return false;
  if (busy || !aiAssistant.isCurrent(value)) throw Error('作品内容或账号已变化，本次建议未应用。');
  const selectedMusic = selection.music && value.music ? await rememberSelectedMusic(value.music) : null;
  if (busy || !aiAssistant.isCurrent(value)) throw Error('作品内容或账号已变化，本次建议未应用。');
  if (selection.copy) {
    current().title = value.title; current().description = value.description;
    resources.synchronizeDescription(value.description);
    // 绑定编排器确定的品牌和拍照日期；已手选的同名平台话题保留原 ID，无需再搜索。
    for (const topic of value.topics || []) {
      if (!current().topics.some(existing => existing.name === topic.name)) current().topics.push({...topic});
    }
  }
  if (selection.location && value.location) {
    const {id, name, cityCode, cityName} = value.location;
    current().location = {id, name, cityCode, cityName};
  }
  if (selection.music && value.music) {
    const item = selectedMusic;
    current().music = entityValue(item);
    musicCandidates.set(item.id, {...item, description: item.author});
    const source = safeURL(item.previewURL);
    if (source) resourcePreviews.set('music:' + item.id, source);
    stopMusic();
    savedMusicPreview.prime(item);
  }
  markChanged(); render(); return true;
}

// closeHost 等待本机保存确认；待发布请求不会被关闭动作自动取消或重发。
async function closeHost(host = true) {
  if (busy) { notice('当前操作尚未结束，请等待结果后关闭。'); return; }
  for (const controller of statusQueries.values()) controller.abort();
  if (!(await saveDraft(false))) { notice('草稿保存失败，页面已保留。请保存成功后再关闭。', true); return; }
  if (context.nativeUIAvailable) await window.webkit.messageHandlers.pluginUI.postMessage({op: 'close', host});
}

// bindEvents 集中绑定界面操作，所有最终提交入口都经过 publishPublication 的二次确认。
function bindEvents() {
  // 关闭仅清理当前通知；后续操作仍可显示新错误，发布防重状态由原回执控制。
  $('dismiss-page-notice').onclick = () => notice();
  // 账号工具收于同一菜单；点击空白或 Escape 只收起菜单，不触发登录或清除。
  const accountMenu = $('account-menu');
  document.addEventListener('pointerdown', event => { if (accountMenu?.open && !accountMenu.contains(event.target)) accountMenu.open = false; });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && accountMenu?.open) { accountMenu.open = false; accountMenu.querySelector('summary')?.focus(); } });
  const statusButton = element('button', '', '查询状态'); statusButton.id = 'status-shortcut'; statusButton.hidden = true;
  $('prepare').before(statusButton);
  $('open-drafts').onclick = () => { if (!busy) $('drafts-dialog').showModal(); };
  $('close-drafts').onclick = () => $('drafts-dialog').close();
  $('choose-upload').onclick = $('add-library-media').onclick = () => { void chooseLibrary('media'); };
  $('connect').onclick = () => { void checkInterface(); };
  $('import-session').onclick = () => { void checkInterface('import'); };
  $('relogin-session').onclick = () => { void checkInterface('relogin'); };
  $('clear-session').onclick = () => { void checkInterface('clear'); };
  $('account-select').onchange = event => { if (event.target.value) void checkInterface('select', event.target.value); };
  $('new-image').onclick = () => newDraft('image'); $('new-video').onclick = () => newDraft('video');
  $('mode-image').onclick = () => { void changeKind('image'); }; $('mode-video').onclick = () => { void changeKind('video'); };
  $('save-draft').onclick = () => { void saveDraft(); };
  $('prepare').onclick = () => { void preparePublication(); }; $('publish').onclick = () => { void publishPublication(); };
  $('refresh-publication').onclick = () => { void refreshPublication(); };
  $('status-shortcut').onclick = () => { void refreshPublication(); };
  $('draft-name').oninput = () => { current().name = $('draft-name').value; markChanged({content: false}); };
  for (const id of ['title', 'description']) $(id).oninput = () => { current()[id] = $(id).value; markChanged(); };
  $('immediate').onchange = $('scheduled').onchange = () => { current().settings.publishTime = $('scheduled').checked ? 'scheduled' : 'now'; renderSettings(); markChanged(); };
  $('scheduled-at').onchange = () => { current().settings.scheduledAt = $('scheduled-at').value; markChanged(); };
  $('visibility-conflict-public').onclick = () => {
    if (!busy && current().collection && current().settings.visibility !== 'public') commitCollectionSettings(current().collection, 'public');
  };
  $('visibility-conflict-remove').onclick = () => {
    if (!busy && current().collection && current().settings.visibility !== 'public') commitCollectionSettings(null, current().settings.visibility);
  };
  $('import-host').onclick = () => { void chooseLibrary('media'); };
  $('preview-files').onchange = event => { void previewFiles(event.target.files || []); event.target.value = ''; };
  $('duplicate').onclick = () => { try { store.copy(); prepared = null; focusID = null; render(); void saveDraft(false); } catch (error) { notice(error.message, true); } };
  $('delete-draft').onclick = () => { void deleteDraft(current().id); };
  for (const type of ['music']) $('search-' + type).onclick = () => { void openSearch(type); };
  for (const type of ['music']) $('clear-' + type).onclick = () => { current()[type] = null; if (type === 'music') stopMusic(); markChanged(); renderResources(); };
  $('choose-cover').onclick = chooseCover;
  $('cover-picker-library').onclick = () => { $('cover-picker').close(); void chooseLibrary('cover'); };
  $('cover-picker-close').onclick = $('cover-picker-cancel').onclick = () => $('cover-picker').close();
  $('cover-picker').onclose = () => { if (!$('cover-picker').open) coverSelection = null; };
  $('cover-picker-confirm').onclick = () => { void confirmCoverSelection(); };
  $('choose-frame').onclick = () => { void openSearch('frame'); };
  $('crop-cover').onclick = () => { void cropCover(); };
  $('clear-cover').onclick = () => { current().cover = null; markChanged(); renderCover(); };
  for (const id of ['preview-music', 'preview-music-icon']) $(id).addEventListener('click', () => musicPreviewNotice(), {capture: true});
  $('music-player').addEventListener('playing', () => musicPreviewNotice());
  $('search-form').onsubmit = event => { event.preventDefault(); void runSearch(false); };
  $('search-query').oninput = () => {
    const state = searchState;
    if (state?.type !== 'music') return;
    clearTimeout(musicSearchTimer);
    activateMusicPage(state, $('search-query').value.trim(), {load: false});
    musicSearchTimer = setTimeout(() => { if (ownsMusicSearch(state) && !state.loaded && !state.failed) void runSearch(false); }, 300);
  };
  $('search-results').onscroll = event => { const node = event.currentTarget; if (searchState?.hasMore && !searchState.loading && !searchState.failed && node.scrollHeight - node.scrollTop - node.clientHeight < node.clientHeight) void runSearch(true); };
  $('search-more').onclick = () => { void runSearch(searchState?.failed ? searchState.retryMore : true); };
  $('search-close').onclick = $('search-done').onclick = () => $('search-dialog').close();
  $('search-dialog').onclose = () => { clearTimeout(musicSearchTimer); searchController?.abort(); searchState?.categoryController?.abort(); searchState?.selectionController?.abort(); searchGeneration += 1; if (searchState?.type === 'music') stopMusic(); searchState = null; };
  $('cancel-operation').onclick = () => operationController?.abort();
  $('open-ai').onclick = () => aiPanel.open();
  window.addEventListener('resize', fitWorkspace);
  window.addEventListener('pagehide', () => accountSelector.dispose());
  window.addEventListener('luma:close-request', event => { event.preventDefault(); void closeHost(true); });
  window.addEventListener('beforeunload', event => { if (busy || storageError || store.savedRevision < store.revision) { event.preventDefault(); event.returnValue = ''; } });
  window.addEventListener('pagehide', () => { for (const controller of statusQueries.values()) controller.abort(); savedMusicPreview.dispose(); musicDrawer.dispose(); aiPanel.dispose(); activities.dispose(); hotspot.dispose(); musicCategories.dispose(); clearTimeout(musicSearchTimer); searchState?.categoryController?.abort(); searchState?.selectionController?.abort(); searchController?.abort(); for (const value of transientMedia.values()) URL.revokeObjectURL(value.url); });
}

// start 加载当前草稿与素材，不在初始化时启动执行模块或发送平台请求。
async function start() {
  bindEvents(); render(); renderConnection();
  // v1 关联文案迁入正文后先落盘，失败沿用草稿保存错误与重试机制。
  if (store.revision > store.savedRevision) await saveDraft(false);
  client.onStatus(value => acceptSession(value || {}));
  // 账号展示从本机档案恢复，不附带平台身份查询或自动登录；各资源按页面需要加载。
  if (context.nativeCapabilities?.sessionProfilesVersion === 1) {
    try { acceptSession(await client.listAccounts()); }
    catch (error) { renderConnection(error.message || '已登录账号读取失败，请检查会话。', {error: true}); }
  }
  await hydrateAssets(currentAssetIDs());
  render();
  if (storageError) notice(storageError, true);
  if (context.selectedAssetIDs?.length) await importHost({initial: true});
}

void start().catch(error => notice(error.message || '工作台初始化失败，请重新打开。', true));
