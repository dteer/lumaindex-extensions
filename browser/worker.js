import {createBackgroundBridge} from './background-bridge.js';
import {searchLocations,validateLocationQuery} from './location.js';
import {listCollections,validateCollectionQuery} from './collection.js';
import {validate} from './protocol.js';
import {prepareFile,resolveAssets} from './media.js';
import {cropCoverFile} from './crop-file.js';
import {uploadImage} from './image-upload.js';
import {importImages} from './import-images.js';
import {buildImageDraft,buildVideoDraft,withDraftCollection} from './draft-model.js';
import {uploadVideo} from './video-upload.js';
import {importVideo} from './import-video.js';
import {requestCreatorContext,draftStorage,stagingPageBinding,draftPageBinding,renderImportStatus,restoreVideoDownload,verifyDraftRender} from './draft-page.js';

// active 锁定 App 草稿和抖音账号，避免同时覆盖账号的单槽原生缓存。
const active = new Set();
const backgroundBridge = createBackgroundBridge({storage:chrome.storage.session,preferences:chrome.storage.local,Socket:WebSocket,query:queryLocations,queryCollections});

// importErrorMessage 隐藏运行时异常和浏览器内部诊断，只把业务层的中文说明显示给用户。
function importErrorMessage(error) {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (['TypeError','ReferenceError','SyntaxError'].includes(error?.name) || message.length > 300 || !/[\u3400-\u9fff]/u.test(message)) return '带入暂未完成，请检查 Chrome 和抖音页面后重新带入。';
  return message;
}

// execute 始终使用扩展隔离世界，不访问网站运行时及其业务组件。
async function execute(tabId, func, args = []) {
  const [injection] = await chrome.scripting.executeScript({target:{tabId},world:'ISOLATED',injectImmediately:true,func,args});
  if (!injection?.result?.ok) throw Error(injection?.result?.error || '页面未确认操作，请检查抖音标签页。');
  return injection.result;
}

// queryLocations 直接查询真实地点，不修改现有编辑内容。
async function queryLocations(input) {
  const params = validateLocationQuery(input);
  const tabs = await chrome.tabs.query({url:'https://creator.douyin.com/*'});
  if (!tabs.length) throw Error('请先在 Chrome 打开已登录的抖音创作者中心。');
  return execute(tabs[0].id,searchLocations,[params]);
}

// queryCollections 按页读取当前账号的普通合集；前后核对账号，避免切换账号后混合候选。
async function queryCollections(input) {
  const params = validateCollectionQuery(input);
  const tabs = await chrome.tabs.query({url:'https://creator.douyin.com/*'});
  if (!tabs.length) throw Error('请先在 Chrome 打开已登录的抖音创作者中心。');
  const tabId = tabs[0].id;
  const {account} = await execute(tabId,requestCreatorContext,['account']);
  const result = await execute(tabId,listCollections,[params]);
  if ((await execute(tabId,requestCreatorContext,['account'])).account !== account) throw Error('抖音账号已切换，请重新读取合集。');
  // App 只需要列表显示数据；平台的原始合集对象仅在带入时由扩展重新查询。
  return {ok:true,data:{account,items:result.data.items.map(({id,title,order})=>({id,title,order})),nextCursor:result.data.nextCursor}};
}

// resolveCollection 在带入前重新确认账号归属、标题与当前集数，不接受 App 自造的合集附加数据。
async function resolveCollection(tabId, selected, account, kind) {
  if (!selected) return selected;
  if (selected.account !== account) throw Error('所选合集属于其他抖音账号，请在 App 重新读取并选择。');
  let cursor = '0';
  const visited = new Set();
  // 每页十条，按服务器游标顺序读取；重复游标或异常长列表必须显式失败，不能误认合集有效。
  for (let attempt = 0; attempt < 100; attempt++) {
    if (visited.has(cursor)) break;
    visited.add(cursor);
    const result = await execute(tabId,listCollections,[validateCollectionQuery({kind,cursor})]);
    const item = result.data.items.find(item=>item.id === selected.id);
    if (item) {
      if (item.title !== selected.title) throw Error('所选合集名称已变化，请在 App 重新读取并选择。');
      if ((await execute(tabId,requestCreatorContext,['account'])).account !== account) throw Error('抖音账号已切换，请重新读取合集。');
      return {...item,account};
    }
    if (result.data.nextCursor === null) throw Error('所选合集已不可用，请在 App 重新读取并选择。');
    cursor = result.data.nextCursor;
  }
  throw Error('合集列表未能完整核对，请重新读取并选择合集后带入。');
}

// resolveLocation 重查真实地点补全 anchor；不信任跨页面传入的任意附加字段。
async function resolveLocation(tabId, selected) {
  if (!selected) return selected;
  let page = 1;
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await execute(tabId,searchLocations,[validateLocationQuery({cityCode:selected.cityCode,cityName:selected.cityName,keyword:selected.name,page})]);
    const item = result.data.items.find(item=>item.id === selected.id && item.name === selected.name);
    if (item) {
      if (item.requiresNativeSelection) throw Error('此地点需要在抖音确认附加选项，请清除 App 地点后带入，再在抖音选择。');
      return {...selected,extra:item.extra};
    }
    if (!Number.isInteger(result.data.nextPage) || result.data.nextPage <= page) break;
    page = result.data.nextPage;
  }
  throw Error('所选地点已不可用，请在 App 重新搜索并选择。');
}

// navigate 等指定导航真正提交，防止新草稿被旧编辑器的卸载保存覆盖。
async function navigate(tabId, url) {
  await chrome.tabs.update(tabId,{url,active:true});
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete' && tab.url === url) return;
    await new Promise(resolve=>setTimeout(resolve,400));
  }
  throw Error('抖音页面打开超时，请检查登录状态和网络。');
}

// verifyVisible 只重试只读展示检查，不重复上传、写入或触发发布。
async function verifyVisible(tabId, draft, kind, skipVideoDownload = false) {
  const deadline = Date.now() + 45000;
  let error;
  while (Date.now() < deadline) {
    try { return await execute(tabId,verifyDraftRender,[draft,kind,skipVideoDownload]); } catch (failure) { error = failure; }
    await new Promise(resolve=>setTimeout(resolve,750));
  }
  throw error || Error('草稿已保存，但原生界面尚未确认显示，请检查当前页面。');
}

// boundPage 只返回仍处于本草稿原生编辑页、DOM 标记和登录账号均吻合的标签页。
// 缺页、导航离开、换账号或扩展重启后绑定失效都视为不可复用，不能改动该用户页面。
async function boundPage(binding, account, kind) {
  if (!binding || binding.account !== account || !Number.isInteger(binding.tabId)) return null;
  try {
    const tab = await chrome.tabs.get(binding.tabId), url = new URL(tab.url);
    if (url.origin !== 'https://creator.douyin.com' || url.pathname !== `/creator-micro/content/post/${kind}` ||
        ['iid','mid','vid','draft_id','luma_import'].some(key=>url.searchParams.has(key)) || url.searchParams.get('type') === 'new') return null;
    if (!(await execute(binding.tabId,draftPageBinding,['check',{kind,marker:binding.marker}])).matches) return null;
    if ((await execute(binding.tabId,requestCreatorContext,['account'])).account !== account) return null;
    // 账号查询是异步操作，其间用户可能导航；操作旧页前再次确认 DOM 标记仍有效。
    return (await execute(binding.tabId,draftPageBinding,['check',{kind,marker:binding.marker}])).matches ? binding.tabId : null;
  } catch { return null; }
}

// importJob 扩展自行准备整份草稿，再一次性写入并交回原生界面人工编辑。
async function importJob(message, sender) {
  const {op,job,kind,origin} = validate(message,sender.url);
  if (op !== 'continue') throw Error('请从 App 使用“带入抖音编辑页”提交完整草稿。');
  if (!sender.tab?.id) throw Error('交接标签页不可用，请从 App 重新带入。');
  const receiptKey = `handoff:${origin}:${job.id}`;
  const receipt = (await chrome.storage.session.get(receiptKey))[receiptKey];
  if (receipt) throw Error('本次任务已写入或结果待确认，请检查抖音页面；要替换当前内容，请从 App 再次带入。');
  const handoffTabId = sender.tab.id, draftLock = `draft:${origin}:${job.draftKey || job.id}`;
  const bindingKey = `direct-page:${origin}:${job.draftKey || job.id}`;
  const stagingToken = crypto.randomUUID(), stagingKey = `staging:${stagingToken}`;
  const stagingDraftKey = `staging-draft:${origin}:${job.draftKey || job.id}`;
  const stagingURL = `https://creator.douyin.com/creator-micro/content/post/${kind}?luma_import=${stagingToken}`;
  let tabId = handoffTabId, closeHandoff = false, staging = true;
  if (active.has(draftLock)) throw Error('该草稿正在带入，请等待完成。');
  active.add(draftLock);
  let accountLock;
  // 长二进制请求期间维持 MV3 生命周期，任务结束立即停止，不增加常驻轮询。
  const heartbeat = setInterval(()=>chrome.runtime.getPlatformInfo().catch(()=>{}),20000);
  // 发布准备页使用扩展自有完整预览；平台编辑器只在全部资源就绪后加载。
  const staged = {token:stagingToken,tabId,job:{...job,kind},origin,lock:draftLock,progress:{message:'正在准备发布内容…',details:job.title}};
  const ensureStaging = async () => {
    if (!(await execute(tabId,stagingPageBinding,[stagingToken,kind])).matches) throw Error('发布页面已变化，带入已停止；请从 App 重新带入。');
  };
  const status = async (message,details='',failed=false) => {
    if (!staging) return execute(tabId,renderImportStatus,[message,details]);
    await ensureStaging();
    staged.progress = {message,details,failed};
    await chrome.storage.session.set({[stagingKey]:staged});
    // 页面尚未注册监听时仍可从 context 读取最新进度，不因显示时序中断上传。
    try { await chrome.runtime.sendMessage({op:'staging-progress',token:stagingToken,...staged.progress}); } catch {}
  };
  try {
    const previousStaging = (await chrome.storage.session.get(stagingDraftKey))[stagingDraftKey];
    if (typeof previousStaging === 'string') await chrome.storage.session.remove(`staging:${previousStaging}`);
    await chrome.storage.session.set({[stagingKey]:staged,[stagingDraftKey]:stagingToken});
    await navigate(tabId,stagingURL);
    await ensureStaging();
    const {account} = await execute(tabId,requestCreatorContext,['account']);
    accountLock = `account:${account}`;
    if (active.has(accountLock)) { accountLock = undefined; throw Error('此抖音账号正在处理另一份任务，请等待完成。'); }
    active.add(accountLock);
    const binding = (await chrome.storage.session.get(bindingKey))[bindingKey];
    const existingTabId = await boundPage(binding,account,kind);
    if (existingTabId !== null && existingTabId !== handoffTabId) {
      tabId = existingTabId;
      staged.tabId = tabId;
      await chrome.storage.session.set({[stagingKey]:staged});
      await navigate(tabId,stagingURL);
      await ensureStaging();
      if ((await execute(tabId,requestCreatorContext,['account'])).account !== account) throw Error('抖音账号已切换，请重新带入。');
    }
    const key = `direct-import:${account}:${origin}:${job.draftKey || job.id}`;
    const saved = (await chrome.storage.local.get(key))[key];
    const original = await execute(tabId,draftStorage,['read',{account,kind,stagingToken}]);
    if (!(original.raw === null || typeof original.raw === 'string')) throw Error('无法确认原生草稿，请重新打开发布页后带入。');
    // App 提供完整快照；不继承单槽缓存中另一份作品的配乐、位置或作品身份。
    if (original.raw) {
      let old;
      try { old = JSON.parse(original.raw); } catch { throw Error('原生草稿格式异常，请先在抖音处理现有草稿。'); }
      if (['reEditId','modifyId','modifyItemId','scheduleItemId','rawModifyItem','rawModifyInfo','rawScheduleInfo'].some(field=>old?.[field] || old?.cache?.[field])) throw Error('当前缓存属于已发表作品的编辑稿，请先在抖音完成该编辑。');
    }
    await status('正在准备素材和发布信息…',job.title);
    const currentJob = structuredClone(job);
    if (currentJob.settings && Object.hasOwn(currentJob.settings,'location')) currentJob.settings.location = await resolveLocation(tabId,currentJob.settings.location);
    if (currentJob.settings && Object.hasOwn(currentJob.settings,'collection')) currentJob.settings.collection = await resolveCollection(tabId,currentJob.settings.collection,account,kind);
    const checkpoint = records => chrome.storage.local.set({[key]:{records,updatedAt:Date.now()}});
    const getAuth = async () => {
      await ensureStaging();
      if ((await execute(tabId,requestCreatorContext,['account'])).account !== account) throw Error('抖音账号已切换，请重新带入。');
      return (await execute(tabId,requestCreatorContext,['auth'])).auth;
    };
    const onProgress = state => status({resolving:'正在核对素材…',reading:`正在读取待上传素材，已完成：${state.completed}/${state.total}`,uploading:`扩展正在上传素材：${state.completed}/${state.total}`,cover:'扩展正在上传封面…',processing:'视频已上传，正在等待抖音处理…',staging:'素材已就绪，正在生成原生草稿…'}[state.phase] || '正在带入…',job.title);
    const dependencies = {resolveAssets,prepareFile,uploadImage,cropCoverFile,buildImageDraft,checkpoint,onProgress,getAuth};
    const input = {job:currentJob,account,origin,previous:saved?.records || [],base:null};
    const result = kind === 'image' ? await importImages(input,dependencies) : await importVideo(input,{
      ...dependencies,uploadVideo,buildVideoDraft,
      enableVideo:async vid=>execute(tabId,requestCreatorContext,['video-enable',vid]),
      getVideoStatus:async vid=>(await execute(tabId,requestCreatorContext,['video-status',vid])).data,
    });
    // 上传期间账号和草稿可能在其他页面变化；两者提交前都必须再次校验。
    await ensureStaging();
    if ((await execute(tabId,requestCreatorContext,['account'])).account !== account) throw Error('抖音账号已切换，草稿未写入，请重新带入。');
    // 大批上传期间合集可能新增集数、改名或删除；写缓存前再查询一次，保留已成功上传的素材供失败重试。
    if (currentJob.settings?.collection) {
      const latestCollection = await resolveCollection(tabId,currentJob.settings.collection,account,kind);
      result.draft = withDraftCollection(result.draft,latestCollection,kind);
      await ensureStaging();
    }
    await chrome.storage.session.set({[receiptKey]:{state:'installing',tabId}});
    await execute(tabId,draftStorage,['write',{account,kind,stagingToken,expectedExists:original.raw !== null,expected:original.raw ?? '',raw:JSON.stringify(result.draft)}]);
    await chrome.storage.session.set({[receiptKey]:{state:'installed',tabId}});
    await navigate(tabId,`https://creator.douyin.com/creator-micro/content/post/${kind}?enter_from=draft`);
    staging = false;
    await chrome.storage.session.remove([stagingKey,stagingDraftKey]);
    // 先绑定再检查展示：原生恢复较慢或部分字段回读失败时，下次仍可在同一页继续带入。
    const marker = crypto.randomUUID();
    await execute(tabId,draftPageBinding,['mark',{kind,marker}]);
    await chrome.storage.session.set({[bindingKey]:{tabId,account,marker}});
    await status('数据已写入，正在确认原生页面显示…');
    if (kind === 'video' && result.draft.cache.download === 0) {
      // 先等素材与其余设置就绪，再执行用户批准的唯一原生控件操作，最后仍完整只读核验。
      await verifyVisible(tabId,result.draft,kind,true);
      if ((await execute(tabId,requestCreatorContext,['account'])).account !== account) throw Error('抖音账号已切换，视频保存权限未自动调整。');
      await status('正在设置视频“禁止保存”并确认结果…');
      await execute(tabId,restoreVideoDownload,[marker]);
    }
    await verifyVisible(tabId,result.draft,kind);
    await status('素材和发布信息已带入。可以使用页面原生控件继续修改，核对后手动发布。');
    closeHandoff = true;
    return {ok:true,message:'原生草稿已恢复，可以继续编辑。'};
  } catch (error) {
    try {
      await status(`带入未完成：${importErrorMessage(error)}`,'成功上传的素材已保留记录；再次从 App 带入时会复用。',true);
      closeHandoff = true;
    } catch {}
    throw error;
  } finally {
    clearInterval(heartbeat); active.delete(draftLock);
    if (accountLock) active.delete(accountLock);
    // 仅关闭这次新建且仍停在本任务准备页的交接页；被用户自行导航的页面必须保留。
    if (closeHandoff && tabId !== handoffTabId) {
      try { if ((await chrome.tabs.get(handoffTabId)).url === stagingURL) await chrome.tabs.remove(handoffTabId); } catch {}
    }
  }
}

// handle 分别验证扩展配置、本机配对及带入任务来源，不接受任意地址或网页执行指令。
async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id) throw Error('请求来源无效。');
  if (message?.op === 'staging-context') {
    // 只向绑定标签页内的扩展自有 iframe 返回当前任务，不允许网页或独立扩展标签页索取其他草稿。
    const token = message.token;
    if (typeof token !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(token) ||
        sender.url !== chrome.runtime.getURL(`staging.html?token=${token}`) || !sender.tab?.id || !(sender.frameId > 0)) throw Error('发布准备页面无效，请从 App 重新带入。');
    const staged = (await chrome.storage.session.get(`staging:${token}`))[`staging:${token}`];
    if (!staged || staged.tabId !== sender.tab.id || !(await execute(sender.tab.id,stagingPageBinding,[token,staged.job.kind || 'image'])).matches) throw Error('本次带入已结束或页面已变化，请从 App 重新带入。');
    const progress = !active.has(staged.lock) && !staged.progress.failed
      ? {message:'带入连接已中断，请从 App 重新带入。',details:'已成功上传的素材会继续复用。',failed:true} : staged.progress;
    return {ok:true,job:staged.job,origin:staged.origin,progress};
  }
  if (['bridge-status','bridge-disconnect','bridge-enable'].includes(message?.op)) {
    if (sender.url !== chrome.runtime.getURL('settings.html')) throw Error('请在扩展配置中管理连接。');
    if (message.op === 'bridge-disconnect') await backgroundBridge.disconnect(message.origin);
    if (message.op === 'bridge-enable') await backgroundBridge.setEnabled(message.enabled);
    return {ok:true,enabled:await backgroundBridge.isEnabled(),connections:await backgroundBridge.status()};
  }
  if (sender.frameId !== 0) throw Error('只接收交接页面主窗口的请求。');
  if (['connect-background','close-relay'].includes(message?.op)) {
    const source = new URL(sender.url);
    if (source.protocol !== 'http:' || !['127.0.0.1','localhost'].includes(source.hostname) || source.pathname !== '/api/v1/plugins/com.lumaindex.douyin/files/relay.html') throw Error('无效连接页。');
    if (message.op === 'close-relay') { if (sender.tab?.id) await chrome.tabs.remove(sender.tab.id); return {ok:true}; }
    if (!/^[a-f0-9]{64}$/.test(message.channel) || source.hash.slice(1) !== message.channel) throw Error('请从 App 连接浏览器。');
    return backgroundBridge.connect(source.origin,message.channel);
  }
  return importJob(message,sender);
}

// 消息回执不包含临时授权和平台原始响应。
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  handle(message,sender).then(reply).catch(error=>reply({ok:false,error:importErrorMessage(error)}));
  return true;
});
