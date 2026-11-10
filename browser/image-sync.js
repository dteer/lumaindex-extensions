// imageSync 在已绑定编辑文档内适配抖音图片组件；结构不符即停止，不猜测删除位置。
export async function imageSync(operation,payload={}){
 const query=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>query(selector,e.shadowRoot))];
 const pause=()=>new Promise(resolve=>setTimeout(resolve,100));
 // 文档身份只随页面 JavaScript 上下文重建而变化，用于隔离旧文档留下的在途上传。
 const documentID=globalThis.__lumaImageDocumentID??=crypto.randomUUID();
 // 页面内文件身份不依赖文件名或上传结果，失败项在没有 URI 时也能被精确移除。
 const identities=globalThis.__lumaImageIdentities??=new WeakMap();
 const assetIdentities=globalThis.__lumaAssetIdentity??=new WeakMap();
 const identity=image=>{
  const object=image.file||image;
  if(!image.file&&image.uploadFile?.uri)return `uri:${image.uploadFile.uri}`;
  if(!identities.has(object))identities.set(object,crypto.randomUUID());
  // 同一 File 可被网页重复接收并产生不同服务端资源，URI 是卡片身份的一部分。
  return `local:${identities.get(object)}${image.uploadFile?.uri?`:${image.uploadFile.uri}`:''}`;
 };
 const updating=()=>Object.assign(Error('图片组件正在更新，请稍后重新同步。'),{retryable:true});
 const isCard=p=>p?.imageFile&&Number.isInteger(p.index)&&typeof p.onChange==='function'&&typeof p.onSwap==='function';
 // DOM 上的 Fiber 与 return 链都可能属于旧分支；仅用它定位根，祖先 props 必须由已提交树遍历携带。
 const cards=()=>{
  const elements=query('[class^="img-"]'),roots=new Set(),hosts=new Map();
  for(const el of elements){
   const host=el[Object.keys(el).find(k=>k.startsWith('__reactFiber'))];
   let root=host;while(root?.return)root=root.return;
   if(root?.stateNode?.current)roots.add(root.stateNode.current);
  }
  const targets=new Set(elements);
  for(const root of roots){
   const stack=[{node:root,props:null}];
   while(stack.length){
    const {node,props:ancestor}=stack.pop(),props=isCard(node.memoizedProps)?node.memoizedProps:ancestor;
    if(targets.has(node.stateNode)&&props)hosts.set(node.stateNode,{props,element:node.stateNode,id:identity(props.imageFile)});
    for(let child=node.child;child;child=child.sibling)stack.push({node:child,props});
   }
  }
  const result=elements.map(el=>hosts.get(el));
  if(result.some(x=>!x))throw updating();
  result.sort((a,b)=>a.props.index-b.props.index);
  // 索引不连续说明 DOM 与提交状态不同步，不能把当前位置当成可删除的图片。
  if(result.some((x,index)=>x.props.index!==index))throw updating();
  return result;
 };
 // CSS 背景没有 complete 状态；使用浏览器图片缓存的加载结果独立观测左侧缩略图。
 const previewLoaded=element=>{
  // 正文缩略图是卡片的直接子 img；后代重试/删除图标及 SVG 占位图不代表照片已显示。
  const isThumbnailSource=value=>Boolean(value)&&!/^data:image\/svg\+xml(?:[;,]|$)/i.test(value)&&!/[.]svg(?:[?#]|$)/i.test(value);
  const images=[...(element.querySelectorAll?.(':scope > img')||[])];
  if(images.some(img=>isThumbnailSource((img.currentSrc||img.src||'').trim())&&img.complete&&img.naturalWidth>0))return true;
  if(typeof getComputedStyle!=='function'||typeof Image!=='function')return false;
  const background=getComputedStyle(element).backgroundImage||'';
  const match=/url\(["']?(.*?)["']?\)/.exec(background);
  if(!match)return false;
  const url=match[1].trim();
  if(!isThumbnailSource(url))return false;
  const cache=globalThis.__lumaPreviewLoads??=new Map();
  if(!cache.has(url)){
   const state={loaded:false},probe=new Image();cache.set(url,state);
   probe.onload=()=>{state.loaded=probe.naturalWidth>0;};
   probe.src=url;
   state.loaded=probe.complete&&probe.naturalWidth>0;
   if(cache.size>100)cache.delete(cache.keys().next().value);
  }
  return cache.get(url)?.loaded===true;
 };
 // 上传失败的重试浮层是本卡片容器的直接子节点；不能读取相邻卡片或全页的错误图标。
 const classes=element=>(typeof element?.className==='string'?element.className:'').split(/\s+/);
 const uploadFailed=element=>{
  const container=element.parentElement,children=[...(container?.children||[])];
  if(!classes(container).some(name=>name.startsWith('container-'))||children.filter(child=>classes(child).some(name=>name.startsWith('img-'))).length!==1)return false;
  return children.some(sibling=>sibling!==element&&classes(sibling).some(name=>/^upload-(?!opacity-)/.test(name))&&classes(sibling).some(name=>name.startsWith('upload-opacity-'))&&[...(sibling.children||[])].some(child=>classes(child).some(name=>name.startsWith('reload-'))&&[...(child.children||[])].some(icon=>icon.tagName==='IMG')));
 };
 // 首次整批入口失败发生在右侧手机上传区域，此时左侧可能尚无任何卡片。
 const batchFailed=()=>query('[class^="phone-container"],[class*=" phone-container"]').some(phone=>[...phone.querySelectorAll('[class^="upload-error-"],[class*=" upload-error-"]')].some(error=>{
  const text=error.textContent?.replace(/\s/g,'')||'';
  return text.includes('上传失败')&&text.includes('重新上传');
 }));
 const snapshot=()=>cards().map(({props:p,element,id})=>{
  const u=p.imageFile.uploadFile,asset=assetIdentities.get(p.imageFile.file);
  return {id,index:p.index,name:p.imageFile.file?.name||'',size:p.imageFile.file?.size||0,uri:u?.uri||'',ready:u?.uriStatus===2000&&Boolean(u?.uri),localPreviewLoaded:previewLoaded(element),failed:uploadFailed(element),...(asset?{assetID:asset.assetID,revision:asset.revision}:{})};
 });
 // 只等待已提交树达到预期，不重复发送删除或交换动作，避免 React 延迟提交时操作下一张。
 const waitCommitted=async(test,message)=>{
  for(let i=0;i<30;i++){
   try{if(test(snapshot()))return;}catch(error){if(!error.retryable)throw error;}
   await pause();
  }
  throw Error(message);
 };
 try{
  if(payload.draftKey&&document.documentElement.dataset.lumaDraft!==payload.draftKey)throw Error('草稿关联已变化，请重新带入。');
  if(operation==='register'){
   // 只有当前二进制票据中的真实 File 能注册图库身份，后续从组件保留的同一对象恢复映射。
   if(!Array.isArray(payload.files))throw Error('缺少待接收的图片身份，请重新带入。');
   const registrations=payload.files.map(metadata=>{
    const file=globalThis.__lumaBinaryFiles?.get(metadata.ticket)?.[metadata.binaryIndex];
    if(!file||!Number.isInteger(metadata.binaryIndex)||typeof metadata.assetID!=='string'||!metadata.assetID||!Object.hasOwn(metadata,'revision'))throw Error('图片身份已失效，请重新带入。');
    return {file,assetID:metadata.assetID,revision:metadata.revision};
   });
   for(const {file,assetID,revision} of registrations)assetIdentities.set(file,{assetID,revision});
   return {ok:true,count:registrations.length};
  }
  if(operation==='startTiming'){
   clearInterval(globalThis.__lumaTimingTimer);
   const start=performance.now();globalThis.__lumaImageTiming=[];let last='';
   const record=()=>{
    try{
     const images=snapshot(),state=JSON.stringify(images.map(x=>({id:x.id,ready:x.ready,localPreviewLoaded:x.localPreviewLoaded})));
     if(state!==last){last=state;globalThis.__lumaImageTiming.push({ms:Math.round(performance.now()-start),count:images.length,ready:images.filter(x=>x.ready).length,localPreviewLoaded:images.filter(x=>x.localPreviewLoaded).length});}
    }catch(error){if(!error.retryable)clearInterval(globalThis.__lumaTimingTimer);}
    if(performance.now()-start>180000)clearInterval(globalThis.__lumaTimingTimer);
   };
   record();globalThis.__lumaTimingTimer=setInterval(record,100);
   return {ok:true};
  }
  if(operation==='timing'){clearInterval(globalThis.__lumaTimingTimer);return {ok:true,timeline:globalThis.__lumaImageTiming||[]};}
  if(operation==='snapshot')return {ok:true,documentID,batchFailed:batchFailed(),images:snapshot()};
  if(operation==='remove'){
   const targets=payload.targets||payload.uris?.map(uri=>({uri}));
   if(!Array.isArray(targets))throw Error('缺少待移除图片，请重新同步。');
   for(const target of targets){
    const before=cards();
    const matches=before.filter(({props,id})=>target.id?id===target.id&&(!target.uri||props.imageFile.uploadFile?.uri===target.uri):Boolean(target.uri)&&props.imageFile.uploadFile?.uri===target.uri);
    if(matches.length!==1)throw Error('待移除图片已变化，请重新同步。');
    const {props,id}=matches[0];
    if(target.uri&&props.imageFile.uploadFile?.uri!==target.uri)throw Error('待移除图片已变化，请重新同步。');
    props.onChange(props.index);
    await waitCommitted(images=>images.length===before.length-1&&!images.some(x=>x.id===id),'抖音尚未移除旧图片。');
   }
   return {ok:true};
  }
  if(operation==='append'){
   if(payload.expectedIDs){
    const actual=snapshot().map(image=>image.id);
    if(!Array.isArray(payload.expectedIDs)||actual.length!==payload.expectedIDs.length||actual.some((id,index)=>id!==payload.expectedIDs[index]))return {ok:false,stateChanged:true,retryable:false,error:'编辑页图片已变化，请重新同步。'};
   }
   const button=query('button').filter(e=>e.textContent.trim()==='继续添加');
   if(button.length!==1)throw Error('未找到继续添加图片按钮。');
   // 按字节写入，避免 Uint8Array.from 对大字符串创建迭代中间对象。
   const decode=value=>{const binary=atob(value),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return bytes;};
   const transfer=new DataTransfer();
   for(const f of payload.files)transfer.items.add(f.ticket?globalThis.__lumaBinaryFiles?.get(f.ticket)?.[f.binaryIndex]:new File([decode(f.base64)],f.name,{type:f.type}));
   const original=HTMLInputElement.prototype.click;let delivered=false;
   const replacement=function(){
    if(this.type!=='file')return original.call(this);
    this.files=transfer.files;delivered=true;HTMLInputElement.prototype.click=original;
    this.dispatchEvent(new Event('change',{bubbles:true}));
   };
   try{HTMLInputElement.prototype.click=replacement;button[0].click();for(let i=0;i<20&&!delivered;i++)await pause();}
   finally{if(HTMLInputElement.prototype.click===replacement)HTMLInputElement.prototype.click=original;}
   if(!delivered)throw Error('网页未接收新增图片。');
   return {ok:true};
  }
  if(operation==='local'){
   const images=snapshot();
   return images.length===payload.expected?{ok:true,images}:{ok:false,error:'正在等待左侧素材列表接收文件。'};
  }
  if(operation==='verify'||operation==='server'){
   const images=snapshot();
   if(images.length!==payload.expected||images.some(x=>!x.ready))return {ok:false,error:`正在上传到抖音：${images.filter(x=>x.ready).length}/${payload.expected} 张。`};
   if(operation==='server')return {ok:true,images};
   const previews=query('[class^="carousel-"] img').filter(img=>img.complete&&img.naturalWidth>0).map(img=>img.currentSrc||img.src);
   if(images.some(x=>!previews.some(src=>src.includes(x.uri))))return {ok:false,error:'图片已上传，正在等待右侧预览更新。'};
   return {ok:true,images};
  }
  if(operation==='order'){
   if(!Array.isArray(payload.uris)||payload.uris.some(uri=>!uri)||new Set(payload.uris).size!==payload.uris.length)throw Error('排序图片已变化，请重新同步。');
   for(let index=0;index<payload.uris.length;index++){
    const list=cards(),matches=list.filter(({props})=>props.imageFile.uploadFile?.uri===payload.uris[index]);
    if(list.length!==payload.uris.length||matches.length!==1)throw Error('排序图片已变化，请重新同步。');
    const from=matches[0].props;
    if(from.index!==index){
     from.onSwap(from.index,index);
     await waitCommitted(images=>images.length===payload.uris.length&&payload.uris.slice(0,index+1).every((uri,i)=>images[i].uri===uri),'图片顺序尚未同步，请检查页面。');
    }
   }
   const actual=snapshot().map(x=>x.uri);
   if(actual.length!==payload.uris.length||actual.some((uri,i)=>uri!==payload.uris[i]))throw Error('图片顺序尚未同步，请检查页面。');
   return {ok:true};
  }
  throw Error('未知图片同步操作。');
 }catch(error){return {ok:false,retryable:error.retryable===true,error:error.message};}
}
