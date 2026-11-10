import {localPreview} from './local-preview.js';
import {binaryStore} from './binary-store.js';
import {receiveBinary,clearBinary} from './binary-bridge.js';
const binaryTickets=new Map();
// 启动清理上次异常退出的过期临时文件，不触碰仍在交接的票据。
binaryStore('prune').catch(()=>{});
import {reconcileBrowserState} from './browser-state.js';
import {imageSync} from './image-sync.js';
import {planImages,pendingImageImports} from './sync-plan.js';
import {validate} from './protocol.js';
import {prepareFiles,resolveAssets} from './media.js';
import {inspectUpload,deliverImages,fillText,showStatus,inspectReceived,fillSettings,resetLinkedDraft,markLinkedDraft} from './page-actions.js';
const active=new Set();
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  handle(message,sender).then(reply).catch(error=>reply({ok:false,error:error.message}));return true;
});

async function execute(tabId,func,args=[]) {
  const results=await chrome.scripting.executeScript({target:{tabId},func,args,...((func===resetLinkedDraft||func===imageSync||func===localPreview||func===receiveBinary||func===clearBinary||func===deliverImages)?{world:'MAIN'}:{})});
  if(!results[0]?.result?.ok){const error=Error(results[0]?.result?.error||'页面未确认操作，请检查抖音标签页。');error.retryable=results[0]?.result?.retryable!==false;error.needsReset=results[0]?.result?.needsReset===true;error.stateChanged=results[0]?.result?.stateChanged===true;throw error;}
  return results[0].result;
}

async function handle(message,sender) {
  if(message.op==='claimBinary'){
   const allowed=binaryTickets.get(message.ticket);
   if(sender.id!==chrome.runtime.id||sender.url?.split('#')[0]!==chrome.runtime.getURL('binary-frame.html')||!allowed||allowed.tabId!==sender.tab?.id||allowed.expires<Date.now()||sender.url?.split('#')[1]!==message.ticket||!sender.tab?.url?.startsWith('https://creator.douyin.com/creator-micro/content/post/image'))return {ok:false};
   binaryTickets.delete(message.ticket);return {ok:true};
  }
  if(sender.id!==chrome.runtime.id||sender.frameId!==0)throw Error('只接收交接页面的主窗口请求。');
  if(message.op==='observeImages')return await observeImages(sender);
  const {op,job,kind,origin}=validate(message,sender.url);
  // 每次带入独占原交接标签页，不依赖用户关闭其他抖音页面；重复带入只替换本草稿关联页面。
  let tab=op==='continue'?sender.tab:(await chrome.tabs.query({url:'https://creator.douyin.com/*'})).find(tab=>new URL(tab.url).pathname===`/creator-micro/content/post/${kind}`);
  if(!tab?.id)throw Error('未找到抖音编辑页面，请从 App 重新带入。');
  const bindingKey=job.draftKey?`draft:${job.draftKey}`:null;
  let reuse=false;
  if(op==='continue'&&bindingKey){
    const saved=(await chrome.storage.session.get(bindingKey))[bindingKey]||(await chrome.storage.local.get(bindingKey))[bindingKey];
    if(saved?.tabId){try{const candidate=await chrome.tabs.get(saved.tabId);if(candidate.url?.startsWith(`https://creator.douyin.com/creator-micro/content/post/${kind}`)){await execute(candidate.id,markLinkedDraft,[job.draftKey,true]);tab=candidate;reuse=true;}}catch{}}
  }
  const lock=bindingKey||`tab:${tab.id}`;
  if(active.has(lock))throw Error('当前抖音页面正在处理另一个任务，请等待完成。');
  active.add(lock);
  try {
    if(op==='fill')return await execute(tab.id,fillText,[job.title,job.description,reuse]);
    const key=`job:${origin}:${job.id}`;
    const previous=(await chrome.storage.session.get(key))[key];
    if(previous)throw Error('本任务已交接或结果待确认，已阻止重复上传。请先检查抖音页面，需要重新上传时从 App 再次带入。');
    if(op==='continue'&&!reuse) {
      await chrome.tabs.update(tab.id,{url:`https://creator.douyin.com/creator-micro/content/post/${kind}?enter_from=publish_page&media_type=${kind}&type=new`,active:true});
    }
    // 等导航真正提交，避免脚本注入落在即将销毁的本机文档上。
    if(op==='continue'&&!reuse)await waitForNavigation(tab.id);
    if(reuse)await chrome.tabs.update(tab.id,{active:true});
    if(op==='continue'&&bindingKey){await execute(tab.id,markLinkedDraft,[job.draftKey]);await chrome.storage.session.set({[bindingKey]:{tabId:tab.id}});await chrome.storage.local.set({[bindingKey]:{tabId:tab.id}});}
    if(op==='continue'&&kind==='image')return await syncImages(tab,job,origin,key,bindingKey,reuse,sender);
    let preflight,replace=false;
    try{preflight=await waitForPage(tab.id,inspectUpload,[kind],30000);}catch(error){
      if(!error.needsReset||op!=='continue'||!job.draftKey)throw error;
      replace=true;
    }
    await execute(tab.id,showStatus,['正在从有序图库读取素材…']);
    if(!replace&&job.assets.length>1&&!preflight.multiple)throw Error('当前上传控件不支持多图，请切换到图文上传。');
    // 文案先填入；素材准备成功前不修改旧图片，避免读取失败造成草稿丢图。
    if(op==='continue')await waitForPage(tab.id,fillText,[job.title,job.description,reuse||replace],30000);
    if(op==='continue')await waitForPage(tab.id,fillSettings,[job.settings],15000);
    const {files,duplicates}=await prepareFiles(job,origin);
    await chrome.storage.session.set({[key]:'pending'});
    const result=replace
      ?await execute(tab.id,resetLinkedDraft,[job.draftKey,files])
      :await execute(tab.id,deliverImages,[files,kind]);
    await execute(tab.id,showStatus,[`正在等待抖音接收 ${files.length} 项素材…`]);
    await waitForPage(tab.id,inspectReceived,[files.length,kind],90000);
    await chrome.storage.session.set({[key]:'received'});
    if(op==='continue') {
      await waitForPage(tab.id,fillText,[job.title,job.description,reuse],90000);
      // 再次确认数量与文案，避免上传后编辑器重建导致填写丢失。
      await new Promise(resolve=>setTimeout(resolve,1000));
      await execute(tab.id,inspectReceived,[files.length,kind]);
      await execute(tab.id,fillText,[job.title,job.description,reuse]);
      await execute(tab.id,fillSettings,[job.settings]);
      await chrome.storage.session.set({[key]:'verified'});
      await execute(tab.id,showStatus,[`已确认 ${files.length} 项素材${duplicates?`（已去重 ${duplicates} 项）`:""}，文案与发布设置已填写。请核对后手动发布。`,true]);
    }
    if(reuse&&sender.tab.id!==tab.id)await chrome.tabs.remove(sender.tab.id);
    return {ok:true,message:`已将 ${result.count} 项素材交给抖音网页上传。请在抖音编辑页核对素材和文案。这不代表上传完成或发布成功。`};
  }catch(error){
    if(op==='continue')try{await execute(tab.id,showStatus,[`带入未完成：${error.message} 请检查当前页面，勿重复上传。`]);}catch{}
    throw error;
  }finally{active.delete(lock);}
}

// 页面导航和异步编辑器加载有延迟；只重试只读检查或幂等文案填入，不重发文件。
async function waitForPage(tabId,func,args,timeout) {
  const deadline=Date.now()+timeout;let lastError;
  while(Date.now()<deadline){
    try{return await execute(tabId,func,args);}catch(error){if(error.retryable===false)throw error;lastError=error;}
    await new Promise(resolve=>setTimeout(resolve,750));
  }
  throw lastError||Error('抖音页面尚未准备好，请确认已登录。');
}

// 等新页面完成加载后再注入，使用浏览器状态而非固定加载延时。
async function waitForNavigation(tabId) {
  const deadline=Date.now()+90000;
  while(Date.now()<deadline){
    const tab=await chrome.tabs.get(tabId);
    if(tab.status==='complete'&&tab.url?.startsWith('https://creator.douyin.com/'))return;
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw Error('抖音页面加载超时，请确认网络和登录状态。');
}

// syncImages 以 App 快照增量更新；本地接收与服务端预览分别计时。
async function syncImages(tab,job,origin,key,bindingKey,reuse,sender){
 const started=performance.now(),stages=[];
 // 仅保存耗时与阶段，不保存文件内容、URL 或文案；失败阶段也保留诊断。
 const timed=async(stage,run)=>{const start=performance.now();try{return await run();}finally{stages.push({stage,ms:Math.round(performance.now()-start)});await chrome.storage.local.set({'lastImageTiming':{stages,totalMs:Math.round(performance.now()-started)}});}};
 const recordKey=`images:${bindingKey}`;
 const saved=(await chrome.storage.local.get(recordKey))[recordKey];
 let previous=saved?.assets||[];
 await execute(tab.id,showStatus,['正在核对图片映射…']);
 const {assets}=await timed('metadata',()=>resolveAssets(job,origin));
 const expected=assets.length;
 if(expected>35)throw Error('图片超过 35 张，请先调整素材。');
 let pageDocumentID,batchFailed=false;
 const readState=async()=>{
  const snapshot=await waitForPage(tab.id,imageSync,['snapshot',{draftKey:job.draftKey}],15000);
  pageDocumentID=snapshot.documentID;batchFailed=snapshot.batchFailed===true;
  const images=snapshot.images;
  const preview=await execute(tab.id,localPreview,['update',{draftKey:job.draftKey,images,phase:'uploading'}]);
  if(preview.firstPreviewMs!=null){await chrome.storage.local.set({lastLocalPreviewTiming:preview});}
  return images;
 };
 // 每次真实投递的 File 带有素材身份；先保存已经成功的资源，后续文案或预览失败也不会丢失映射。
 const checkpoint=async images=>{
  const ready=planImages(assets,previous,images).keep;
  previous=[...previous.filter(old=>!ready.some(a=>a.assetID===old.assetID)),...ready];
  await chrome.storage.local.set({[recordKey]:{...saved,assets:previous,browser:{images,updatedAt:Date.now()},updatedAt:Date.now()}});
 };
 let current=await readState(),plan;
 const inflightKey=`${recordKey}:inflight`,inflight=(await chrome.storage.local.get(inflightKey))[inflightKey];
 // 后台重启不会取消网页上传。尚在处理的已投递文件不再次发送，完成后可从 File 身份恢复映射。
 const sameDocument=inflight&&(!inflight.documentID||inflight.documentID===pageDocumentID);
 if(sameDocument&&batchFailed)throw Error('抖音整批上传失败，请先在网页点击重新上传，完成后再同步。');
 const unfinished=sameDocument?{...inflight,files:inflight.files.filter(f=>!current.some(i=>i.assetID===f.assetID&&i.revision===f.revision&&i.failed))}:null;
 if(pendingImageImports(unfinished,assets,planImages(assets,previous,current).keep).length)throw Error('上次图片仍由抖音网页处理，请等待上传结束后重新同步；上传失败时可使用网页的重试操作。');
 const prepared=new Map();
 // 准备文件期间旧草稿可能恢复。重算计划只读缺失文件，不重发已经交给网页的文件。
 for(let attempt=0;attempt<4;attempt++){
  await checkpoint(current);
  plan=planImages(assets,previous,current);
  const missing=plan.add.filter(a=>!prepared.has(a.id));
  const batch=await timed('localRead',()=>prepareFiles(job,origin,missing,true));
  for(const file of batch.files)prepared.set(file.assetID,file);
  const latest=await readState();
  if(JSON.stringify(latest)===JSON.stringify(current))break;
  current=latest;
  if(attempt===3)throw Error('网页图片仍在变化，请等待当前操作完成后重新同步。');
 }
 await timed('initialText',()=>execute(tab.id,fillText,[job.title,job.description,true]).catch(()=>null));
 current=await readState();await checkpoint(current);plan=planImages(assets,previous,current);
 for(const asset of plan.add)if(!prepared.has(asset.id)){
  const batch=await timed('additionalLocalRead',()=>prepareFiles(job,origin,[asset],true));
  prepared.set(asset.id,batch.files[0]);
 }
 let files=plan.add.map(a=>prepared.get(a.id));
 await chrome.storage.session.set({[key]:'pending'});
 const appendFirst=current.length>0&&plan.keep.length===0&&files.length>0&&current.length+files.length<=35;
 const replaceAll=current.length>0&&plan.keep.length===0&&files.length>0&&!appendFirst;
 await execute(tab.id,imageSync,['startTiming']);
 let ordered,finalState,initialUpload=false;
 try{
  if(plan.removeImages.length&&!replaceAll&&!appendFirst)await timed('removeOld',()=>execute(tab.id,imageSync,['remove',{draftKey:job.draftKey,targets:plan.removeImages}]));
  if(files.length){
   const ticket=crypto.randomUUID(),expires=Date.now()+60000;
   try{
    await binaryStore('put',ticket,{files:files.map(f=>f.file),expires});
    binaryTickets.set(ticket,{tabId:tab.id,expires});
    await timed('binaryBridge',()=>execute(tab.id,receiveBinary,[chrome.runtime.getURL('binary-frame.html'),ticket]));
    files=files.map(({file,...metadata},binaryIndex)=>({...metadata,ticket,binaryIndex}));
    await execute(tab.id,imageSync,['register',{draftKey:job.draftKey,files}]);
    await waitForPage(tab.id,localPreview,['show',{draftKey:job.draftKey,files}],15000);
    await execute(tab.id,showStatus,[`正在上传 ${files.length} 张新增图片；左侧显示本地缩略图，右侧等待服务端预览。`]);
    const beforeDelivery=await readState();
    const retained=current.filter(x=>appendFirst||replaceAll||!plan.removeImages.some(r=>r.id===x.id));
    if(beforeDelivery.length!==retained.length||beforeDelivery.some((x,i)=>x.id!==retained[i].id))throw Error('草稿恢复或网页操作改变了图片列表，请重新同步。');
    initialUpload=replaceAll||beforeDelivery.length===0;
    await chrome.storage.local.set({[inflightKey]:{documentID:pageDocumentID,startedAt:Date.now(),files:files.map(({assetID,revision})=>({assetID,revision}))}});
    if(replaceAll)await timed('deliverFiles',()=>execute(tab.id,resetLinkedDraft,[job.draftKey,files]));
    else if(beforeDelivery.length)await timed('deliverFiles',()=>execute(tab.id,imageSync,['append',{draftKey:job.draftKey,files,expectedIDs:beforeDelivery.map(x=>x.id)}]));
    else {await waitForPage(tab.id,inspectUpload,['image'],15000);await timed('deliverFiles',()=>execute(tab.id,deliverImages,[files,'image']));}
   }finally{
    binaryTickets.delete(ticket);await binaryStore('delete',ticket);
    await execute(tab.id,clearBinary,[ticket]).catch(()=>{});
   }
  }
  // 先确认新增卡片已进入本地列表再删除旧图，保留编辑模式，不等待服务端上传。
  if(appendFirst)await timed('appendReception',()=>waitForPage(tab.id,imageSync,['local',{expected:current.length+files.length}],30000));
  if(appendFirst&&plan.removeImages.length)await timed('removeOld',()=>execute(tab.id,imageSync,['remove',{draftKey:job.draftKey,targets:plan.removeImages}]));
  if(!initialUpload)await timed('leftListReception',()=>waitForPage(tab.id,imageSync,['local',{expected}],30000));
  // 上传过程中逐次检查点保存成功映射，失败重试不会重复提交已成功的文件。
  await timed('serverUpload',async()=>{
   const deadline=Date.now()+180000;let last='';
   while(Date.now()<deadline){
    const images=await readState();
    if(batchFailed)throw Error('抖音整批上传失败，请先在网页点击重新上传，完成后再同步。');
    if(images.some(x=>x.failed))throw Error('有图片上传失败，请在网页重试失败项，或从 App 重新同步。');
    const signature=JSON.stringify(images.map(x=>[x.id,x.uri,x.ready]));
    if(signature!==last){last=signature;await checkpoint(images);}
    if(images.length!==expected&&!(initialUpload&&images.length===0))throw Error('网页图片数量已变化，请重新同步。');
    if(images.length===expected&&images.every(x=>x.ready))return;
    await new Promise(resolve=>setTimeout(resolve,750));
   }
   throw Error('仍有图片未上传成功，请检查网页上传状态后重新同步。');
  });
  const received=await readState();
  await checkpoint(received);
  ordered=assets.map(a=>previous.find(x=>x.assetID===a.id&&x.revision===a.revision&&received.some(i=>i.uri===x.uri)));
  if(ordered.some(x=>!x))throw Error('素材映射尚未完成。');
  await execute(tab.id,imageSync,['order',{draftKey:job.draftKey,uris:ordered.map(x=>x.uri)}]);
  finalState=await timed('rightPreview',()=>waitForPage(tab.id,imageSync,['verify',{expected}],30000));
  // 右侧预览等待期间原生左图也可能完成加载；最终回读后及时移除临时行，避免重复展示。
  await execute(tab.id,localPreview,['update',{draftKey:job.draftKey,images:finalState.images,phase:'uploading'}]);
  await chrome.storage.local.set({[inflightKey]:null});
 }catch(error){
  await execute(tab.id,localPreview,['update',{draftKey:job.draftKey,phase:'failed'}]).catch(()=>{});
  throw error;
 }finally{
  const timeline=await execute(tab.id,imageSync,['timing']).catch(()=>null);
  if(timeline)await chrome.storage.local.set({lastImageTimeline:timeline.timeline});
  const snapshot=await execute(tab.id,imageSync,['snapshot',{draftKey:job.draftKey}]).catch(()=>null);
  if(snapshot)await checkpoint(snapshot.images);
 }
 await execute(tab.id,fillText,[job.title,job.description,true]);
 await execute(tab.id,fillSettings,[job.settings]);
 await chrome.storage.local.set({[recordKey]:{assets:ordered,browser:{images:finalState.images,updatedAt:Date.now()},updatedAt:Date.now()}});
 await chrome.scripting.executeScript({target:{tabId:tab.id},files:['browser-observer.js']});
 await chrome.storage.session.set({[key]:'verified'});
 await execute(tab.id,showStatus,[`已上传并确认右侧预览：新增 ${files.length} 张、复用 ${plan.keep.length} 张、移除 ${plan.removeImages.length} 张。请核对后手动发布。`,true]);
 if(reuse&&sender.tab.id!==tab.id)await chrome.tabs.remove(sender.tab.id);
 return {ok:true,message:'图片服务端资源与右侧预览已确认。'};
}

// observeImages 只接受绑定的抖音主页面；同步任务持锁时忽略中间变化，避免覆盖最终映射。
async function observeImages(sender){
 if(!sender.tab?.id||!sender.url||new URL(sender.url).origin!=='https://creator.douyin.com'||new URL(sender.url).pathname!=='/creator-micro/content/post/image')return {ok:false};
 const bindings={...await chrome.storage.local.get(null),...await chrome.storage.session.get(null)};
 const binding=Object.entries(bindings).find(([key,value])=>key.startsWith('draft:')&&value?.tabId===sender.tab.id);
 if(!binding||active.has(binding[0]))return {ok:true};
 const [bindingKey]=binding,recordKey=`images:${bindingKey}`;
 active.add(bindingKey);
 try{
  const saved=(await chrome.storage.local.get(recordKey))[recordKey];
  if(!saved)return {ok:true};
  await execute(sender.tab.id,markLinkedDraft,[bindingKey.slice(6),true]);
  const {images}=await execute(sender.tab.id,imageSync,['snapshot',{draftKey:bindingKey.slice(6)}]);
  if(JSON.stringify(saved.browser?.images)===JSON.stringify(images))return {ok:true};
  await chrome.storage.local.set({[recordKey]:reconcileBrowserState(saved,images)});
  return {ok:true};
 }finally{active.delete(bindingKey);}
}
