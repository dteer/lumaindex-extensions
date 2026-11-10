'use strict';
import {DraftStore,signature,mergeDraftAssets} from './drafts.js';
const context=window.pluginContext,$=id=>document.getElementById(id);
let selected=[],loading=false,loadError=null,mode='image',focusedID=null,draggedID=null,previewKey='',previewAssetID=null,previewIndex=0,previewAnimation=null;
const current=()=>selected.filter(a=>a.kind===mode);
const focused=()=>current().find(a=>a.id===focusedID)||current()[0];
let ready=false,operationBusy=false,storageFailure=false;
const texts={image:{title:'',description:''},video:{title:'',description:''}};
const fallbackKey='luma.douyin.frontend:'+ (context?.libraryID||context?.apiBaseURL||'preview');
let initial=context?.frontendState;
try{if(!context?.nativeUIAvailable)initial=JSON.parse(localStorage.getItem(fallbackKey)||'{}');}catch{storageFailure=true;}
const store=new DraftStore(initial,async value=>{
 if(context?.nativeUIAvailable){await window.webkit.messageHandlers.pluginUI.postMessage({op:'persist',value});}
 else localStorage.setItem(fallbackKey,JSON.stringify(value));
});
// 各发布类型独立保存发布设置，日期为本机时区输入，传输时附带时区偏移。
const defaultSettings=()=>({visibility:'public',download:'allow',publishTime:'now',scheduledAt:''});
const settings={image:defaultSettings(),video:defaultSettings()};
function captureSettings(){settings[mode]={visibility:document.querySelector('[name=visibility]:checked').value,download:document.querySelector('[name=download]:checked').value,publishTime:document.querySelector('[name=publishTime]:checked').value,scheduledAt:$('scheduled-at').value};}
function showSettings(){const value=settings[mode];for(const name of ['visibility','download','publishTime'])for(const field of document.querySelectorAll(`[name=${name}]`))field.checked=field.value===value[name];$('scheduled-at').value=value.scheduledAt||'';$('schedule-field').hidden=value.publishTime!=='scheduled';$('schedule-zone').textContent=Intl.DateTimeFormat().resolvedOptions().timeZone;}
function settingsError(){const value=settings[mode];if(value.publishTime!=='scheduled')return '';const time=new Date(value.scheduledAt).getTime(),delta=time-Date.now();return !Number.isFinite(time)||delta<2*3600000||delta>14*86400000?'请选择 2 小时后至 14 天内的发布时间。':'';}
function contentFor(kind){return {assetIDs:selected.filter(a=>a.kind===kind).map(a=>a.id),...texts[kind],settings:settings[kind]};}
function captureText(){captureSettings();texts[mode]={title:$('title').value,description:$('description').value};}
function showText(){ showSettings();$('title').value=texts[mode].title;$('description').value=texts[mode].description; }
function draftStatus(){
 document.querySelector('.editor').inert=operationBusy;
 for(const k of ['image','video'])$(k+'-mode').disabled=loading||operationBusy;
 $('draft-status').textContent=storageFailure?'草稿未保存，请保持页面并重试':store.dirty()?'编辑中 · 已保留恢复副本':'草稿已暂存至本机';
 if(!Object.keys(store.data.modes).length&&!storageFailure)$('draft-status').textContent='暂无草稿';
 $('save-draft').disabled=loading||operationBusy||!Object.keys(store.data.modes).length;
 $('delete-draft').disabled=loading||operationBusy||!store.data.modes[mode];
 $('close-page').disabled=loading||operationBusy;
}
function checkpoint(){
 if(!ready||loading||operationBusy)return;
 captureText();let changed=false;
 for(const kind of ['image','video'])changed=store.update(kind,contentFor(kind))||changed;
 if(store.data.activeMode!==mode){store.data.activeMode=mode;changed=true;}
 if(changed){$('draft-status').textContent='正在保留恢复副本…';store.commit().then(()=>{storageFailure=false;draftStatus();}).catch(()=>{storageFailure=true;draftStatus();});}
 else draftStatus();
}
function decide(title,message,choices){
 return new Promise(resolve=>{
  const dialog=$('decision');$('decision-title').textContent=title;$('decision-message').textContent=message;$('decision-actions').replaceChildren();
  const finish=value=>{dialog.close();resolve(value);};
  dialog.oncancel=event=>{event.preventDefault();finish('cancel');};
  for(const [value,label,style] of choices){const button=document.createElement('button');button.textContent=label;button.className=style||'';button.onclick=()=>finish(value);$('decision-actions').append(button);}
  dialog.showModal();
 });
}
async function closeHost(host=false){
 await store.pending;
 if(context?.nativeUIAvailable)await window.webkit.messageHandlers.pluginUI.postMessage({op:'close',host});
 else {ready=false;for(const child of document.body.children)child.hidden=true;const message=document.createElement('p');message.textContent='页面已关闭。可以关闭此标签页，重新打开会恢复保留的草稿。';message.style.padding='24px';document.body.append(message);}
}
async function requestClose(host=false){
 if(operationBusy||loading||$('decision').open)return;
 checkpoint();let choice='save';
 if(store.dirty()||storageFailure)choice=await decide('关闭发布页面？','可暂存当前图库的图文和视频草稿，下次继续编辑。选择不保留会删除这两份草稿。',[['cancel','取消'],['discard','不保留并关闭','danger'],['save','暂存并关闭','primary']]);
 if(choice==='cancel')return;
 operationBusy=true;draftStatus();
 try{if(choice==='discard')await store.remove();else await store.save();await closeHost(host);}
 catch{storageFailure=true;operationBusy=false;draftStatus();}
}
window.addEventListener('luma:close-request',event=>{event.preventDefault();requestClose(true);});

function updateLink(){
 const error=settingsError();$('settings-error').textContent=error;
 const items=current(),allowed=!error&&!loading&&items.length>0&&items.length<=(mode==='video'?1:35)&&items.every(a=>!a.error);
 $('continue').setAttribute('aria-disabled',String(!allowed));$('continue').tabIndex=allowed?0:-1;
 if(!allowed){$('continue').removeAttribute('href');return;}
 const job={version:1,draftKey:store.data.bindingID+':'+mode,kind:mode,id:crypto.randomUUID(),assets:items.map(a=>({id:a.id,name:a.name})),title:$('title').value,description:$('description').value,settings:{...settings[mode],scheduledAt:settings[mode].publishTime==='scheduled'&&!error?new Date(settings[mode].scheduledAt).toISOString():''}};
 $('continue').href=new URL('handoff.html',location.href).href+'#'+encodeURIComponent(JSON.stringify(job));
}
// 缩略图不支持时回退到原图；不改变素材格式或写回图库。
function imageFor(asset){
 const img=document.createElement('img');img.alt=asset.name;img.loading='lazy';
 img.src=`${context.apiBaseURL}/assets/${encodeURIComponent(asset.id)}/thumbnail`;
 img.onerror=()=>{if(img.dataset.original){const error=document.createElement('span');error.className='broken';error.textContent='预览暂不可用';img.replaceWith(error);return;}img.dataset.original='1';img.src=`${context.apiBaseURL}/assets/${encodeURIComponent(asset.id)}/original`;};
 return img;
}
// previewImages 缓存已解码的浏览图，最多保留当前和相邻图片，避免原图解码阻塞动画。
const previewImages=new Map();
function preparePreview(asset){
 if(!previewImages.has(asset.id)){
  const image=new Image();image.alt=asset.name;image.decoding='async';image.src=`${context.apiBaseURL}/assets/${encodeURIComponent(asset.id)}/preview?size=2048`;
  previewImages.set(asset.id,{image,ready:image.decode().then(()=>image)});
  previewImages.get(asset.id).ready.catch(()=>{});
 }
 return previewImages.get(asset.id);
}
// 图片固定在同一轨道内，只移动父层；连续输入从当前呈现位置接续。
let previewTrack=null,trackSignature='',trackAnimation=null,trackPosition=0,wheelTimer=null,wheelStart=0;
function moveTrack(position,animated=true){
 if(!previewTrack)return;
 const width=$('preview-media').clientWidth||1;
 const from=getComputedStyle(previewTrack).transform;
 trackAnimation?.cancel();trackAnimation=null;trackPosition=position;
 const to=`translate3d(${-position*width}px,0,0)`;previewTrack.style.transform=to;
 if(animated&&!matchMedia('(prefers-reduced-motion: reduce)').matches){
  trackAnimation=previewTrack.animate([{transform:from==='none'?'translate3d(0,0,0)':from},{transform:to}],{duration:360,easing:'cubic-bezier(.2,.75,.25,1)'});
  trackAnimation.onfinish=()=>{trackAnimation=null;};
 }
}
function renderPreview(){
 const items=current(),asset=focused(),index=items.indexOf(asset),key=asset?asset.id+':'+mode:'';
 const signature=mode+':'+items.map(item=>item.id).join(',');
 const media=$('preview-media');
 if(mode==='image'&&asset){
  if(signature!==trackSignature){
   clearTimeout(wheelTimer);wheelTimer=null;trackAnimation?.cancel();trackAnimation=null;
   previewTrack=document.createElement('div');previewTrack.className='preview-track';
   for(const item of items){const slide=document.createElement('div');slide.className='preview-slide';slide.setAttribute('aria-label',item.name);previewTrack.append(slide);}
   media.replaceChildren(previewTrack);trackSignature=signature;moveTrack(Math.max(0,index),false);
  }
  // 只预解码当前与相邻图片，离开相邻范围后保留轨道容器并释放图片内存。
  for(const [i,item] of items.entries()){
   const slide=previewTrack.children[i];slide.setAttribute('aria-hidden',String(i!==index));
   if(Math.abs(i-index)<=1){preparePreview(item).ready.then(image=>{if(previewTrack?.children[i]===slide&&!slide.contains(image))slide.replaceChildren(image);}).catch(()=>{slide.textContent='浏览图暂不可用';});}
   else {slide.replaceChildren();previewImages.delete(item.id);}
  }
  if(key!==previewKey&&!wheelTimer)moveTrack(index,true);
 }else if(key!==previewKey||signature!==trackSignature){
  trackAnimation?.cancel();trackAnimation=null;previewTrack=null;trackSignature=signature;media.replaceChildren();
  if(mode==='video'&&asset&&!asset.error){const video=document.createElement('video');video.src=`${context.apiBaseURL}/assets/${encodeURIComponent(asset.id)}/original`;video.controls=true;video.preload='metadata';video.playsInline=true;media.append(video);}
  else media.textContent=asset?.error||'素材预览';
 }
 previewKey=key;previewIndex=index;
 document.querySelector('.phone').classList.toggle('is-video',mode==='video');
 $('feed-page').textContent=items.length?(index+1)+'/'+items.length:'0/0';
 $('feed-dots').replaceChildren();items.slice(0,35).forEach((_,i)=>{const dot=document.createElement('i');dot.className=i===index?'current':'';$('feed-dots').append(dot);});
 // 标题与描述按照发布页合并呈现，空字段不添加虚构占位文案。
 const title=$('title').value,description=$('description').value;
 $('preview-title').textContent=title+(title&&description?'。':'');
 // 话题为描述中的真实文本；高亮只呈现其范围，不伪造抖音的话题关联。
 const parts=description.split(/(#[^\s#，。！？,!?]+)/gu);
 $('preview-description').replaceChildren(...parts.map(text=>{const element=document.createElement(text.startsWith('#')?'strong':'span');element.textContent=text;return element;}));
 $('feed-page').hidden=mode==='video'||items.length<2;
 $('feed-dots').hidden=mode==='video'||items.length<2;
 $('title-count').textContent=`${$('title').value.length} / 20`;$('description-count').textContent=`${$('description').value.length} / 1000`;
}
function move(delta,first=false){
 const items=current(),asset=focused(),index=items.indexOf(asset),target=first?0:index+delta;
 if(!asset||target<0||target>=items.length)return;
 const from=selected.indexOf(asset),to=selected.indexOf(items[target]);selected.splice(from,1);selected.splice(to,0,asset);render();
}
function render(){
 const items=current(),asset=focused();focusedID=asset?.id??null;
 $('image-mode').setAttribute('aria-selected',String(mode==='image'));$('video-mode').setAttribute('aria-selected',String(mode==='video'));
 $('media-heading').firstChild.textContent=mode==='image'?'图片内容 ':'视频内容 ';
 $('media-count').textContent=`${items.length} / ${mode==='image'?35:1}`;
 $('empty').hidden=items.length>0;$('empty-title').textContent=mode==='image'?'带入图片，开始创作':'带入视频，开始创作';
 $('grid').className=mode==='video'?'grid video-grid':'grid';$('grid').replaceChildren();
 items.forEach((item,index)=>{
  const card=document.createElement('article');card.className=`media-card ${item.id===focusedID?'active':''} ${item.error?'error':''} ${mode==='video'?'video-tile':''}`;
  const thumb=document.createElement('button');thumb.className='thumb';thumb.setAttribute('aria-label',`预览 ${item.name}`);thumb.setAttribute('aria-pressed',String(item.id===focusedID));thumb.disabled=loading;
  if(!item.error&&mode==='image')thumb.append(imageFor(item));
  else {const icon=document.createElement('span');icon.className=item.error?'broken':'video-symbol';icon.textContent=item.error||'▷';thumb.append(icon);}
  thumb.onclick=()=>{focusedID=item.id;for(const element of $('grid').children){const active=element===card;element.classList.toggle('active',active);element.querySelector('.thumb').setAttribute('aria-pressed',String(active));}renderPreview();};
  thumb.ondblclick=()=>{if(mode==='image'&&!item.error)openLightbox(item.id);};thumb.title='单击预览，双击放大';card.append(thumb);
  if(mode==='image'&&index===0){const badge=document.createElement('span');badge.className='first-tag';badge.textContent='首图';card.append(badge);}
  const remove=document.createElement('button');remove.className='remove';remove.textContent='×';remove.title='移除';remove.setAttribute('aria-label',`移除 ${item.name}`);remove.disabled=loading;remove.onclick=()=>{selected=selected.filter(a=>a.id!==item.id);render();};card.append(remove);
  const name=document.createElement('div');name.className='file-name';name.textContent=item.name;name.title=item.name;card.append(name);
  card.draggable=!loading&&mode==='image';
  card.ondragstart=event=>{draggedID=item.id;event.dataTransfer.setData('text/plain',item.id);event.dataTransfer.effectAllowed='move';};
  card.ondragover=event=>{if(draggedID)event.preventDefault();};
  card.ondrop=event=>{event.preventDefault();const from=selected.findIndex(a=>a.id===draggedID),to=selected.indexOf(item);if(from>=0&&to>=0){const [moving]=selected.splice(from,1);selected.splice(to,0,moving);focusedID=moving.id;render();}draggedID=null;};
  card.ondragend=()=>{draggedID=null;};$('grid').append(card);
 });
 const index=items.indexOf(asset);
 const issue=loadError||(items.some(a=>a.error)?'请移除不可用素材，或重新带入。':items.length>(mode==='video'?1:35)?(mode==='video'?'请保留一个视频后继续。':'单次最多支持 35 张图片。'):null);
 $('status').dataset.error=String(!!issue);$('status').textContent=issue||(loading?'正在读取素材…':!items.length?'从来源或集合选择素材后带入':`已准备 ${items.length} ${mode==='video'?'个视频':'张图片'} · 尚未上传`);
 renderPreview();updateLink();checkpoint();
}
async function readAssets(ids,assumedMode='image'){
 const result=[];
 for(const id of [...new Set(ids)]){
  try{
   const response=await fetch(`${context.apiBaseURL}/assets/${encodeURIComponent(id)}`,{signal:AbortSignal.timeout(15000)}),payload=await response.json();
   if(!response.ok||payload.code!==0)throw Error(payload.message||'素材不可用');
   let a=payload.data;
   // 实况视频成员统一映射为后端提供的静态照片组件。
   if(a.livePhoto?.imageAssetId&&a.livePhoto.imageAssetId!==id){
    const response=await fetch(`${context.apiBaseURL}/assets/${encodeURIComponent(a.livePhoto.imageAssetId)}`,{signal:AbortSignal.timeout(15000)}),detail=await response.json();
    if(!response.ok||detail.code!==0)throw Error('实况照片的静态图片不可用');a=detail.data;
   }
   const resolvedID=a.id||id,name=a.name||id,kind=a.mediaType==='video'?'video':'image';
   const valid=kind==='video'?/\.(mp4|mov|webm)$/i.test(name):/\.(jpe?g|png|webp|bmp|tiff?|heic|heif|avif|cr2|cr3|nef|nrw|arw|srf|sr2|dng|raf|orf|rw2|pef|srw|raw)$/i.test(name);
   // 所有带入与草稿恢复共用此入口，不支持的格式直接跳过，不占素材数量。
   if(!valid)continue;
   if(!result.some(item=>item.id===resolvedID))result.push({id:resolvedID,name,kind,error:kind==='video'&&a.sizeBytes>80*1024*1024?'视频超过传输限制':null});
  }catch(error){result.push({id,name:id,kind:assumedMode,error:error.message});}
 }return result;
}
async function restore(){
 selected=[];for(const kind of ['image','video']){const d=store.data.modes[kind];settings[kind]={...defaultSettings(),...d?.settings};texts[kind]={title:d?.title||'',description:d?.description||''};if(d)selected.push(...await readAssets(d.assetIDs,kind));}
 mode=store.data.activeMode;focusedID=null;showText();
}
async function load(){
 if(loading)return;loading=true;ready=false;loadError=null;$('retry').disabled=true;render();
 try{
  if(!context?.apiBaseURL)throw Error('请在有序图库 App 中打开插件。');
  await restore();
  const incoming=context.selectedAssetIDs||[],request=context.transferID;
  const shouldImport=incoming.length&&((request&&!store.data.handledTransfers.includes(request))||!Object.keys(store.data.modes).length&&!request);
  if(shouldImport){
   const assets=await readAssets(incoming),kinds=[...new Set(assets.map(a=>a.kind))];
   const conflict=kinds.some(k=>store.data.modes[k]);let choice='replace';
   if(conflict){render();choice=await decide('已有暂存草稿','继续旧草稿会保留原文案和素材顺序，追加本次带入的素材，并按素材 ID 去重。覆盖会替换对应模式的素材和文案；另一种模式的草稿保留。',[['cancel','取消'],['keep','继续旧草稿'],['replace','覆盖旧草稿','primary']]);}
   if(choice==='cancel'){await closeHost();return;}
   if(choice==='replace'&&kinds.length){
    for(const k of kinds){selected=selected.filter(a=>a.kind!==k).concat(assets.filter(a=>a.kind===k));texts[k]={title:'',description:''};settings[k]=defaultSettings();delete store.data.modes[k];store.update(k,contentFor(k));}
    mode=kinds.includes('image')?'image':'video';store.data.activeMode=mode;showText();
   }
   if(choice==='keep'){
    selected=mergeDraftAssets(selected,assets);
    for(const k of kinds)store.update(k,contentFor(k));
    mode=kinds.includes('image')?'image':'video';store.data.activeMode=mode;
    focusedID=null;showText();
   }
   store.acceptTransfer(request);await store.commit();
  }
  ready=true;
 }catch(error){loadError=error.message;}
 finally{loading=false;$('retry').disabled=false;render();draftStatus();}
}
async function resetIncoming(){
 if(loading||operationBusy)return;
 const choice=await decide('还原带入素材？','当前模式将恢复本次带入的素材与顺序，已填写的文案会保留。',[['cancel','取消'],['reset','还原','primary']]);if(choice!=='reset')return;
 loading=true;render();try{const assets=await readAssets(context.selectedAssetIDs||[]);selected=selected.filter(a=>a.kind!==mode).concat(assets.filter(a=>a.kind===mode));}finally{loading=false;render();}
}
for(const kind of ['image','video'])$(kind+'-mode').onclick=()=>{if(loading||operationBusy)return;captureText();checkpoint();mode=kind;focusedID=null;showText();render();};
$('retry').onclick=resetIncoming;for(const name of ['title','description'])$(name).oninput=()=>{renderPreview();updateLink();checkpoint();};
// 每次明确点击带入时生成新任务；旧交接页重载仍由扩展按旧任务 ID 防重。
let lastHandoff=-Infinity;
$('continue').onclick=event=>{if(performance.now()-lastHandoff<1200){event.preventDefault();return;}if(settingsError()||$('continue').getAttribute('aria-disabled')==='true'){event.preventDefault();updateLink();return;}lastHandoff=performance.now();
 // 本次默认导航使用点击前已准备好的 href；导航事件结束后才准备下一次任务，避免 WebKit 首次激活时目标变化。
 setTimeout(updateLink,0);};
$('close-page').onclick=()=>requestClose(false);
$('save-draft').onclick=async()=>{if(operationBusy)return;checkpoint();operationBusy=true;draftStatus();try{await store.save();storageFailure=false;}catch{storageFailure=true;}finally{operationBusy=false;draftStatus();}};
$('delete-draft').onclick=async()=>{
 const choice=await decide('删除当前草稿？','只删除当前发布模式的本机草稿，不删除图库素材，也不影响另一种模式。',[['cancel','取消'],['delete','删除草稿','danger']]);if(choice!=='delete')return;
 operationBusy=true;draftStatus();try{await store.remove(mode);selected=selected.filter(a=>a.kind!==mode);texts[mode]={title:'',description:''};settings[mode]=defaultSettings();showText();storageFailure=false;}catch{storageFailure=true;}finally{operationBusy=false;render();draftStatus();}
};load();

// 预览切换只改变焦点，不改变发布顺序；视频模式保留原生播放交互。
function stepPreview(direction){
 if(mode!=='image'||loading||operationBusy||$('decision').open)return;
 const items=current(),index=items.indexOf(focused()),next=items[index+direction];
 if(next){
  focusedID=next.id;renderPreview();
  const activeIndex=items.indexOf(next);
  for(const [i,card] of [...$('grid').children].entries()){
   card.classList.toggle('active',i===activeIndex);
   card.querySelector('.thumb')?.setAttribute('aria-pressed',String(i===activeIndex));
  }

 }
}
const previewStage=document.querySelector('.feed-stage');

// WebKit 内嵌页可能把滚动继续交给外层容器；在捕获阶段按指针位置路由。
// 悬停时激活预览，但不打断标题、描述等输入框的编辑。
previewStage.addEventListener('pointerenter',()=>{
 const active=document.activeElement;
 if(mode==='image'&&!$('decision').open&&!active?.matches('input,textarea,[contenteditable=true]')){
  previewStage.focus({preventScroll:true});
 }
});
document.addEventListener('wheel',event=>{
 const bounds=previewStage.getBoundingClientRect();
 if(event.clientX<bounds.left||event.clientX>=bounds.right||event.clientY<bounds.top||event.clientY>=bounds.bottom)return;
 if(mode!=='image'||current().length<2||event.ctrlKey||loading||operationBusy||$('decision').open)return;
 event.preventDefault();
 const delta=Math.abs(event.deltaX)>Math.abs(event.deltaY)?event.deltaX:event.deltaY;
 const pixels=delta*(event.deltaMode===1?16:event.deltaMode===2?previewStage.clientHeight:1);
 if(!previewTrack||$('lightbox').open)return;
 if(!wheelTimer){
  wheelStart=current().indexOf(focused());
  const matrix=new DOMMatrixReadOnly(getComputedStyle(previewTrack).transform);trackPosition=-matrix.m41/(bounds.width||1);
 }
 clearTimeout(wheelTimer);
 moveTrack(Math.max(0,Math.min(current().length-1,trackPosition+pixels/(bounds.width||1))),false);
 wheelTimer=setTimeout(()=>{
  wheelTimer=null;
  const delta=trackPosition-wheelStart;
  const target=Math.max(0,Math.min(current().length-1,Math.abs(delta)>.12?wheelStart+Math.sign(delta):wheelStart));
  stepPreview(target-current().indexOf(focused()));moveTrack(target,true);
 },110);
},{passive:false,capture:true});
previewStage.addEventListener('keydown',event=>{
 if(mode==='image'&&(event.key==='ArrowLeft'||event.key==='ArrowRight')){
  event.preventDefault();stepPreview(event.key==='ArrowRight'?1:-1);
 }
});

// 在当前位置插入真实话题文本，沿用描述字数、草稿保存及带入流程。
$('add-topic').onclick=()=>{const field=$('description');field.focus();if(field.value.length>=1000)return;const start=field.selectionStart,end=field.selectionEnd;field.setRangeText('#',start,end,'end');field.dispatchEvent(new Event('input',{bubbles:true}));};

for(const field of document.querySelectorAll('.publish-panel input'))field.addEventListener('change',()=>{captureSettings();showSettings();updateLink();checkpoint();});

// 放大查看仅维护弹窗焦点，不改变素材顺序、选择或发布内容。
let lightboxID=null;
function renderLightbox(){
 const items=current(),index=items.findIndex(item=>item.id===lightboxID),asset=items[index];if(!asset)return;
 $('lightbox-title').textContent=`${asset.name} · ${index+1}/${items.length}`;
 const image=new Image();image.alt=asset.name;image.src=`${context.apiBaseURL}/assets/${encodeURIComponent(asset.id)}/preview?size=2048`;
 image.onerror=()=>{if(lightboxID===asset.id)$('lightbox-media').textContent='浏览图暂不可用';};
 $('lightbox-media').replaceChildren(image);$('lightbox-prev').disabled=index<=0;$('lightbox-next').disabled=index>=items.length-1;
}
function openLightbox(id){lightboxID=id;renderLightbox();if(!$('lightbox').open)$('lightbox').showModal();$('lightbox-close').focus();}
function moveLightbox(delta){const items=current(),index=items.findIndex(item=>item.id===lightboxID);if(items[index+delta]){lightboxID=items[index+delta].id;renderLightbox();}}
$('lightbox-close').onclick=()=>$('lightbox').close();
$('lightbox-prev').onclick=()=>moveLightbox(-1);$('lightbox-next').onclick=()=>moveLightbox(1);
$('lightbox').addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();moveLightbox(event.key==='ArrowLeft'?-1:1);}});
$('lightbox').addEventListener('click',event=>{if(event.target===$('lightbox')){const rect=$('lightbox').getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)$('lightbox').close();}});

// 窗口尺寸变化时重新对齐轨道，防止停靠位置留下前一张的窄条。
new ResizeObserver(()=>{if(previewTrack&&!wheelTimer)moveTrack(Math.max(0,current().indexOf(focused())),false);}).observe($('preview-media'));
