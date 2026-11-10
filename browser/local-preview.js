// localPreview 独立显示浏览器已收到的本地文件，不修改抖音 React、uploadFile 或右侧服务端预览。
// show 使用本次二进制 ticket；update 只消费真实页面快照；clear 释放全部 object URL 和监听。
export function localPreview(operation,payload={}){
 const query=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>query(selector,e.shadowRoot))];
 const current=globalThis.__lumaLocalPreview;
 const metrics=state=>({count:state?.items.length||0,loaded:state?.loaded||0,firstPreviewMs:state?.firstPreviewMs??null});
 try{
  if(payload.draftKey&&document.documentElement.dataset.lumaDraft!==payload.draftKey)return {ok:false,error:'草稿关联已变化，本地预览未更新。'};
  if(operation==='clear'){const result=metrics(current);current?.destroy();return {ok:true,...result};}
  if(operation==='update'){
   if(!current)return {ok:true,visible:false};
   const images=Array.isArray(payload.images)?payload.images:[];
   let nativeLoaded=0,uploaded=0;
   for(const item of current.items){
    // 仅使用注册到真实 File 的素材身份与版本；恢复草稿或同名文件不能冒充本次本地接收的图片。
    const matches=images.filter(image=>image.assetID===item.assetID&&Object.hasOwn(image,'revision')&&image.revision===item.revision);
    const image=matches.length===1?matches[0]:null;
    if(image?.localPreviewLoaded)nativeLoaded++;
    if(image?.ready)uploaded++;
    item.status.textContent=image?.ready?'服务端已接收':payload.phase==='failed'?'同步未完成':image||payload.phase==='uploading'?'上传中':'等待上传';
    item.status.style.color=image?.ready?'#187650':payload.phase==='failed'?'#b24735':'#60646c';
   }
   current.summary.textContent=payload.phase==='failed'?'同步未完成，请检查抖音页面；本地缩略图不代表上传成功。':`本地已接收 ${current.items.length} 张 · 服务端已接收 ${uploaded} 张`;
   const result=metrics(current);
   // 原生左列表已经展示同一批文件时交还页面；无需等待服务端完成，右侧仍完全由抖音决定。
   if(nativeLoaded===current.items.length&&current.items.length){current.destroy();return {ok:true,visible:false,nativeReceived:true,...result};}
   return {ok:true,visible:true,...result};
  }
  if(operation!=='show')return {ok:false,error:'未知本地预览操作。'};
  const files=payload.files;
  if(!Array.isArray(files)||!files.length||files.length>35)return {ok:false,error:'本地预览图片数量无效。'};
  // 全部验证后再替换旧面板，读取失败不销毁上次失败现场。
  const entries=files.map(metadata=>{
   if(typeof metadata.assetID!=='string'||!metadata.assetID||!Object.hasOwn(metadata,'revision'))throw Error('本次图片身份已失效，请重新带入。');
   const file=globalThis.__lumaBinaryFiles?.get(metadata.ticket)?.[metadata.binaryIndex];
   if(!(file instanceof File)||!/^image\//.test(file.type))throw Error('本次图片文件已失效，请重新带入。');
   return {...metadata,file,name:file.name,size:file.size};
  });
  current?.destroy();
  const panel=document.createElement('section'),header=document.createElement('div'),title=document.createElement('strong'),close=document.createElement('button'),summary=document.createElement('div'),note=document.createElement('div'),grid=document.createElement('div');
  panel.id='lumaindex-local-preview';panel.setAttribute('aria-label','有序图库本地接收预览');
  Object.assign(panel.style,{boxSizing:'border-box',padding:'16px',marginBottom:'0',border:'1px solid #dce3ea',borderRadius:'8px',background:'#fff',color:'#252729',font:'13px/1.5 -apple-system, BlinkMacSystemFont, sans-serif'});
  Object.assign(header.style,{display:'flex',alignItems:'center',justifyContent:'space-between',gap:'12px',marginBottom:'4px'});
  title.textContent='有序图库 · 本地接收';Object.assign(title.style,{fontSize:'15px',fontWeight:'600'});
  close.type='button';close.textContent='×';close.setAttribute('aria-label','关闭本地接收预览');Object.assign(close.style,{border:'0',background:'transparent',fontSize:'22px',lineHeight:'24px',width:'28px',height:'28px',cursor:'pointer',color:'#60646c'});
  summary.setAttribute('role','status');summary.setAttribute('aria-live','polite');summary.textContent=`本地已接收 ${entries.length} 张 · 等待上传`;
  note.textContent='下方为本地缩略图，上传完成以抖音右侧预览为准。';Object.assign(note.style,{fontSize:'12px',color:'#737780',marginTop:'2px',marginBottom:'12px'});
  Object.assign(grid.style,{display:'grid',gridTemplateColumns:'repeat(auto-fill, minmax(86px, 1fr))',gap:'10px',maxHeight:'340px',overflowY:'auto'});
  const state={panel,row:null,summary,items:[],urls:[],loaded:0,firstPreviewMs:null,started:performance.now(),destroy:null,timer:null};
  // 关闭、离页、下一次导入及超时均归还 object URL；只清理自身，避免旧任务清除新面板。
  state.destroy=()=>{
   clearTimeout(state.timer);window.removeEventListener('pagehide',state.destroy);
   for(const item of state.items){item.image.onload=null;item.image.onerror=null;item.image.removeAttribute('src');}
   for(const url of state.urls)URL.revokeObjectURL(url);
   state.urls.length=0;panel.remove();state.row?.remove();
   if(globalThis.__lumaLocalPreview===state)delete globalThis.__lumaLocalPreview;
  };
  globalThis.__lumaLocalPreview=state;
  close.addEventListener('click',state.destroy);window.addEventListener('pagehide',state.destroy);
  // 后台异常退出不会永久持有本地大图；正常流程在原生左列表可见时提前释放。
  state.timer=setTimeout(state.destroy,10*60*1000);
  try{
   for(const entry of entries){
    const card=document.createElement('figure'),image=document.createElement('img'),name=document.createElement('figcaption'),status=document.createElement('div');
    Object.assign(card.style,{margin:'0',minWidth:'0'});Object.assign(image.style,{display:'block',width:'100%',height:'104px',objectFit:'cover',borderRadius:'4px',background:'#f3f4f5'});
    image.alt=entry.name;image.decoding='async';
    Object.assign(name.style,{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',fontSize:'11px',marginTop:'4px'});name.textContent=entry.name;name.title=entry.name;
    status.textContent='等待上传';Object.assign(status.style,{fontSize:'11px',color:'#60646c'});
    const item={assetID:entry.assetID,revision:entry.revision,name:entry.name,size:entry.size,image,status,loaded:false};state.items.push(item);
    image.onload=()=>{if(item.loaded)return;item.loaded=true;state.loaded++;state.firstPreviewMs??=Math.round(performance.now()-state.started);};
    image.onerror=()=>{status.textContent='本地预览不可用';};
    const url=URL.createObjectURL(entry.file);state.urls.push(url);image.src=url;
    card.append(image,name,status);grid.append(card);
   }
   header.append(title,close);panel.append(header,summary,note,grid);
   // 只接受可见的原生表单行。标题和正文的共同祖先是富文本编辑器，不能作为素材挂载点。
   const hasClassPrefix=(element,prefix)=>[...element.classList].some(value=>value.startsWith(prefix));
   const rows=query('div').filter(element=>{
    if(!element.getClientRects().length||element.children.length!==2)return false;
    const [label,content]=element.children;
    return ['编辑图片','封面设置'].includes(label.textContent.trim())&&hasClassPrefix(content,'content-child-');
   });
   const imageRows=rows.filter(row=>row.children[0].textContent.trim()==='编辑图片');
   const candidates=imageRows.length?imageRows:rows.filter(row=>row.children[0].textContent.trim()==='封面设置');
   if(candidates.length!==1)throw Error('无法确认独立图片区域，请等待抖音编辑页准备完成后重新带入。');
   const anchor=candidates[0];
   let form=null;
   for(let node=anchor.parentElement;node&&node!==document.body;node=node.parentElement){
    if(node.matches('[contenteditable],.editor-kit-root-container,[class^="editor-comp-"]'))throw Error('图片区域位于作品描述内，已停止挂载本地预览。');
    if(hasClassPrefix(node,'form-container-')){form=node;break;}
   }
   if(!form)throw Error('无法确认图片表单边界，请重新打开抖音编辑页。');
   // 与原生行共享标签列和内容列样式；面板仅放在自己的新行，保留标题、正文及右侧布局。
   const row=document.createElement('div'),label=document.createElement('div'),content=document.createElement('div');
   row.className=anchor.className;row.id='lumaindex-local-preview-row';
   label.className=anchor.children[0].className;label.textContent='带入图片';
   content.className=anchor.children[1].className;content.append(panel);row.append(label,content);state.row=row;
   anchor.parentElement.insertBefore(row,imageRows.length?anchor:anchor.nextSibling);
   const placement='image-row';
   return {ok:true,visible:true,placement,...metrics(state)};
  }catch(error){state.destroy();throw error;}
 }catch(error){return {ok:false,error:error.message||'本地预览未能显示，请检查抖音页面。'};}
}
