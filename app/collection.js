import {browserBridge} from './browser-bridge.js';

// validCollection 与带入协议保持同一身份边界，损坏草稿不能静默带入错误合集。
function validCollection(value){
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&['id','account'].every(key=>typeof value[key]==='string'&&/^\d{1,30}$/.test(value[key]))&&typeof value.title==='string'&&!!value.title.trim()&&value.title.length<=200;
}

// collectionError 校验本机草稿的合集身份与公开条件，不自动删除用户的已选合集。
export function collectionError(value,visibility,account=''){
 if(value==null)return '';
 if(visibility!=='public')return '合集仅支持公开作品，请改为公开或清除已选合集。';
 if(!validCollection(value))return '已选合集信息不完整，请重新选择或清除合集。';
 if(account&&value.account!==account)return '已选合集属于其他抖音账号，请重新选择或清除合集。';
 return '';
}

// collectionPicker 通过 Chrome 查询当前账号的普通合集，仅保存身份、标题与所属账号。
export function collectionPicker({baseURL,getValue,setValue,getVisibility,getKind,changed}){
 const $=id=>document.getElementById(id),picker=$('collection-picker'),open=$('collection-open'),clear=$('collection-clear'),panel=$('collection-panel'),list=$('collection-options'),status=$('collection-status');
 const bridge=browserBridge(baseURL);
 let controller,generation=0,items=[],next='0',loading=false,failure='',account='',listAccount='',accountChanged=false;
 const error=()=>collectionError(getValue(),getVisibility(),account);

 // cancel 使关闭、切换作品和修改可见性前发出的响应失效。
 function cancel(){controller?.abort();generation++;loading=false;}
 // close 关闭选择面板但不改变草稿中的合集。
 function close(){cancel();panel.hidden=true;open.setAttribute('aria-expanded','false');summary();}
 // summary 始终展示保存的标题；账号不符或不可公开时明确提示，不悄悄替换。
 function summary(){
  const value=getValue(),invalid=error();
  open.textContent=typeof value?.title==='string'&&value.title?value.title:'选择合集（可选）';
  open.title=typeof value?.title==='string'?value.title:'';
  open.disabled=getVisibility()!=='public';clear.hidden=value==null;
  status.dataset.error=String(!!invalid||!!failure);
  status.textContent=invalid||failure||(getVisibility()!=='public'?'合集仅支持公开作品，改为公开后可选择。':loading?'正在读取当前抖音账号的合集…':'通过 Chrome 读取当前账号的普通免费合集。');
 }
 // render 用于恢复草稿或切换作品，只重置查询，不改写保存的选择。
 function render(){close();items=[];next='0';failure='';listAccount='';accountChanged=false;list.replaceChildren();summary();}
 // draw 保留失败前已加载的页面；同名或同 ID 的不同账号合集不能视作原选择。
 function draw(){
  list.replaceChildren();
  const selected=getValue();
  for(const item of items){
   const button=document.createElement('button');button.type='button';button.className='collection-option';button.textContent=item.title;
   button.setAttribute('aria-pressed',String(selected?.id===item.id&&selected?.account===listAccount));
   button.disabled=getVisibility()!=='public'||accountChanged;
   button.onclick=()=>{
    if(getVisibility()!=='public'||accountChanged||!listAccount)return;
    setValue({id:item.id,title:item.title,account:listAccount});render();changed();
   };
   list.append(button);
  }
  if(loading||(!items.length&&!failure)){
   const empty=document.createElement('p');empty.className='collection-empty';empty.textContent=loading?'正在读取合集…':next===null?'当前账号暂无可选的普通合集':'本页暂无可选的普通合集';list.append(empty);
  }
  if(failure||(!loading&&next!==null)){
   const more=document.createElement('button');more.type='button';more.className='collection-more';more.textContent=accountChanged?'刷新合集':failure?'重试加载':'加载更多';
   more.onclick=()=>accountChanged?restart():load();list.append(more);
  }
  summary();
 }
 // load 每个游标只允许一个请求，成功后才推进游标，旧响应不能覆盖当前作品。
 async function load(){
  if(loading||next===null||panel.hidden||getVisibility()!=='public')return;
  const version=generation,cursor=next;controller=new AbortController();loading=true;failure='';draw();
  try{
   const page=await bridge.queryCollections({kind:getKind(),cursor},controller.signal);
   if(version!==generation)return;
   if(!page||typeof page.account!=='string'||!/^\d{1,30}$/.test(page.account)||!Array.isArray(page.items)||!(page.nextCursor===null||typeof page.nextCursor==='string'&&page.nextCursor&&page.nextCursor!==cursor))throw Error('合集数据不完整，请刷新后重试。');
   if(page.items.some(item=>!validCollection({...item,account:page.account})))throw Error('合集数据不完整，请刷新后重试。');
   account=page.account;
   if(listAccount&&listAccount!==account){accountChanged=true;throw Error('抖音账号已切换，请刷新合集后重新选择。');}
   listAccount=account;
   const known=new Set(items.map(item=>item.id));
   for(const {id,title} of page.items)if(!known.has(id)){items.push({id,title});known.add(id);}
   next=page.nextCursor;changed();
  }catch(cause){
   if(version!==generation||cause?.name==='AbortError')return;
   failure=cause?.message||'合集读取失败，请重试。';
  }finally{
   if(version===generation){loading=false;draw();if(accountChanged)changed();}
  }
 }
 // restart 显式刷新时从第一页查询，避免把不同账号的分页结果拼接起来。
 function restart(){cancel();items=[];next='0';failure='';listAccount='';accountChanged=false;load();}
 open.onclick=()=>{
  if(getVisibility()!=='public')return;
  if(!panel.hidden){close();return;}
  panel.hidden=false;open.setAttribute('aria-expanded','true');restart();
 };
 clear.onclick=()=>{setValue(null);render();changed();};
 $('collection-refresh').onclick=restart;
 // 接近列表末尾一个可视区域时预取；失败保留当前游标，只由用户重试。
 list.onscroll=()=>{if(list.scrollHeight-list.scrollTop-list.clientHeight<list.clientHeight&&!failure)load();};
 picker.addEventListener('keydown',event=>{if(event.key==='Escape'){close();open.focus();}});
 document.addEventListener('click',event=>{if(!picker.contains(event.target))close();});
 window.addEventListener('pagehide',close);
 return {render,error};
}
