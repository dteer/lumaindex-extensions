// 在目标页面隔离执行，仅操作上传控件；绝不查找或点击发布按钮。
export function inspectUpload(kind='image') {
  // 抖音微前端将编辑器放在开放 Shadow DOM 内，递归查询实际页面控件。
  const query=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>query(selector,e.shadowRoot))];

  if(query('button').some(e=>e.textContent.trim()==='清空并重新上传'))return {ok:false,retryable:false,needsReset:true,error:'当前编辑页已有素材，请从 App 同步到关联页面；不要在旧交接页重复刷新。'};
  let inputs=query('input[type=file]').filter(input=>(kind==='video'?/video|\.mp4|\.mov|\.webm/i:/image|\.png|\.jpg|\.jpeg/i).test(input.accept));
  // 图文编辑页同时存在单图封面控件，优先使用多图正文控件。
  if(kind==='image'&&inputs.some(input=>input.multiple))inputs=inputs.filter(input=>input.multiple);
  const drop=query('div').filter(e=>e.textContent.trim()==='点击上传'&&e.parentElement.textContent.includes(kind==='image'?'图片文件':'视频'));
  if(inputs.length===0&&drop.length===1)return {ok:true,multiple:kind==='image',drop:true};
  if(inputs.length!==1)return {ok:false,error:'未找到唯一对应类型的上传控件。请在抖音选择对应的图文或视频上传页面，再重试。'};
  if(inputs[0].disabled)return {ok:false,error:'对应类型的上传控件暂不可用，请等待页面准备完成。'};
  return {ok:true,multiple:inputs[0].multiple};
}

// 文件在内存重建后一次性发出 change，上传由抖音网页自身完成。
export function deliverImages(files,kind='image') {
  // 抖音微前端将编辑器放在开放 Shadow DOM 内，递归查询实际页面控件。
  const query=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>query(selector,e.shadowRoot))];

  // inspectUpload 与文件投递是两次注入，期间可能恢复草稿；在本次同步调用内最后复核，禁止误走整批上传入口。
  if(kind==='image'&&(query('button').some(e=>['继续添加','清空并重新上传'].includes(e.textContent.trim()))||query('[class^="img-"]').length))return {ok:false,retryable:false,needsReset:true,stateChanged:true,error:'编辑页图片已变化，请重新同步。'};

  let inputs=query('input[type=file]').filter(input=>(kind==='video'?/video|\.mp4|\.mov|\.webm/i:/image|\.png|\.jpg|\.jpeg/i).test(input.accept));
  // 图文编辑页同时存在单图封面控件，优先使用多图正文控件。
  if(kind==='image'&&inputs.some(input=>input.multiple))inputs=inputs.filter(input=>input.multiple);
  const drop=query('div').filter(e=>e.textContent.trim()==='点击上传'&&e.parentElement.textContent.includes(kind==='image'?'图片文件':'视频'));
  if((inputs.length!==1||inputs[0].disabled)&&!(inputs.length===0&&drop.length===1))return {ok:false,error:'对应类型的上传页面已变化，请重新检查。'};
  const input=inputs[0];
  if(files.length>1&&input&&!input.multiple)return {ok:false,error:'当前控件不支持多图，请切换到图文上传。'};
  // 按字节写入，避免 Uint8Array.from 对大字符串创建迭代中间对象。
  const decode=value=>{const binary=atob(value),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return bytes;};
  const transfer=new DataTransfer();
  for(const file of files)transfer.items.add(file.ticket?globalThis.__lumaBinaryFiles?.get(file.ticket)?.[file.binaryIndex]:new File([decode(file.base64)],file.name,{type:file.type}));
  if(!input){
    // 新版图文页使用拖入事件和系统文件选择器，不常驻 input[type=file]。
    for(const type of ['dragenter','dragover','drop'])drop[0].dispatchEvent(new DragEvent(type,{bubbles:true,composed:true,cancelable:true,dataTransfer:transfer}));
    return {ok:true,count:transfer.files.length};
  }
  input.files=transfer.files;
  input.dispatchEvent(new Event('input',{bubbles:true}));
  input.dispatchEvent(new Event('change',{bubbles:true}));
  return {ok:true,count:transfer.files.length};
}

// 页面就绪后自动填写；不覆盖已有不同文案，不依赖草稿缓存私有结构。
export async function fillText(title,description,replace=false) {
  // 抖音微前端将编辑器放在开放 Shadow DOM 内，递归查询实际页面控件。
  const query=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>query(selector,e.shadowRoot))];

  const titleFields=query('input,textarea').filter(e=>/标题/.test(e.getAttribute('placeholder')||''));
  const descriptionFields=query('textarea,[contenteditable=true]').filter(e=>e.matches('[data-slate-editor=true].editor-comp-publish')||/描述|作品介绍/.test([e.getAttribute('placeholder'),e.getAttribute('data-placeholder'),e.getAttribute('aria-label')].filter(Boolean).join(' ')));
  // Slate 的占位节点和零宽字符不是用户文案，比较前剔除。
  const read=field=>{if(!field.isContentEditable)return field.value;const copy=field.cloneNode(true);copy.querySelectorAll('[data-slate-placeholder],[data-placeholder=true]').forEach(e=>e.remove());return copy.textContent.replace(/[\u200b\ufeff]/g,'').trim();};
  const targets=[[title,titleFields,'标题'],[description,descriptionFields,'描述']].filter(([value])=>replace||value.length);
  // 先验证全部字段，避免一部分写入后才发现另一个字段不适用。
  for(const [value,fields,label] of targets) {
    if(fields.length!==1)return {ok:false,error:`无法唯一识别${label}输入框，请从 App 复制文案手动填写。`};
    const current=read(fields[0]);
    if(!replace&&current.replace(/[\u200b\ufeff]/g,'').trim()&&current!== (fields[0].isContentEditable?value.replace(/[\u200b\ufeff]/g,'').trim():value))return {ok:false,error:`抖音已有不同${label}，为保留现有内容，请手动调整。`};
  }
  for(const [value,[field]] of targets) {
    if(field.isContentEditable){
      if(read(field)===value.replace(/[\u200b\ufeff]/g,'').trim())continue;
      field.focus();const range=document.createRange();range.selectNodeContents(field);
      const selection=field.getRootNode().getSelection?.()||window.getSelection();selection.removeAllRanges();selection.addRange(range);
      if(!document.execCommand(value?'insertText':'delete',false,value))return {ok:false,error:'描述编辑器未接收文案，请手动填写。'};
    }
    else {
      const prototype=field instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype,'value').set.call(field,value);
    }
    field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));
  }
  // 让受控输入框完成一次异步更新后回读，不能把发出事件当作填写成功。
  await new Promise(resolve=>setTimeout(resolve,350));
  for(const [value,[field],label] of targets){
    if(!field.isConnected||read(field)!==(field.isContentEditable?value.replace(/[\u200b\ufeff]/g,'').trim():value))return {ok:false,error:`${label}尚未被编辑器保存，正在等待页面稳定。`};
  }
  return {ok:true,message:'标题和描述已回读确认。'};
}

// 在抖音页面显示传输结果，避免为了反馈再打开中转页；不操作发布按钮。
export function showStatus(message,autoClose=false) {
  let banner=document.getElementById('lumaindex-transfer-status');
  if(!banner){
    banner=document.createElement('div');banner.id='lumaindex-transfer-status';banner.setAttribute('role','status');
    Object.assign(banner.style,{position:'fixed',bottom:'24px',left:'24px',zIndex:'2147483647',maxWidth:'min(440px, calc(100vw - 48px))',padding:'14px 16px',display:'flex',alignItems:'flex-start',gap:'12px',boxSizing:'border-box',lineHeight:'1.6',background:'#eef5ff',color:'#19385c',border:'1px solid #b7d3ff',borderRadius:'10px',fontSize:'14px',boxShadow:'0 3px 16px #0002'});
    document.body.append(banner);
  }
  clearTimeout(banner.lumaCloseTimer);banner.replaceChildren();
  const text=document.createElement('span');text.textContent=message;Object.assign(text.style,{flex:'1 1 auto',minWidth:'0',overflowWrap:'anywhere'});
  const close=document.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label','关闭带入提示');
  Object.assign(close.style,{border:'0',background:'transparent',color:'inherit',fontSize:'20px',cursor:'pointer',margin:'0',padding:'0',flex:'0 0 24px',width:'24px',height:'24px',lineHeight:'24px',display:'inline-flex',alignItems:'center',justifyContent:'center',alignSelf:'flex-start'});
  close.onclick=()=>{clearTimeout(banner.lumaCloseTimer);banner.remove();};banner.append(text,close);
  if(autoClose)banner.lumaCloseTimer=setTimeout(()=>banner.remove(),6000);
  return {ok:true};
}

// inspectReceived 只读核对抖音正文图片计数，避免将投递数误报为接收数。
export function inspectReceived(expected,kind='image') {
  const query=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>query(selector,e.shadowRoot))];
  if(kind!=='image')return {ok:true};
  const counts=query('div,span,p').map(e=>e.textContent.trim().match(/^已添加\s*(\d+)\s*张图片(?:继续添加)?$/)).filter(Boolean).map(m=>Number(m[1]));
  const unique=[...new Set(counts)];
  const count=unique.length===1?unique[0]:0;
  return count===expected?{ok:true,count}:{ok:false,error:`抖音当前确认 ${count} 张图片，本次应为 ${expected} 张；请检查上传状态。`};
}

// fillSettings 将 App 发布选择映射到页面公开控件并回读，不触碰最终发布按钮。
export async function fillSettings(settings){
 if(!settings)return {ok:true};
 const query=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>query(selector,e.shadowRoot))];
 const labels=[{public:'公开',friends:'好友可见',private:'仅自己可见'}[settings.visibility],settings.download==='allow'?'允许':'不允许',settings.publishTime==='scheduled'?'定时发布':'立即发布'];
 const checked=[];
 for(const text of labels){
  const fields=query('label').filter(e=>e.textContent.trim()===text).map(e=>e.querySelector('input[type=checkbox],input[type=radio]')).filter(Boolean);
  if(fields.length!==1||fields[0].disabled)return {ok:false,error:`无法设置“${text}”，请检查抖音发布设置。`};
  const field=fields[0];if(!field.checked)field.click();checked.push(field);
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 let expected='';
 if(settings.publishTime==='scheduled'){
  const fields=query('input').filter(e=>e.placeholder==='日期和时间');
  if(fields.length!==1)return {ok:false,error:'未找到定时发布的日期时间输入框。'};
  const date=new Date(settings.scheduledAt),pad=n=>String(n).padStart(2,'0');
  expected=`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const field=fields[0];field.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,expected);
  field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new Event('change',{bubbles:true}));
  field.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));field.blur();
 }
 await new Promise(resolve=>setTimeout(resolve,350));
 if(checked.some(field=>!field.isConnected||!field.checked))return {ok:false,error:'发布选项尚未被抖音保存，请核对页面。'};
 if(expected&&query('input').find(e=>e.placeholder==='日期和时间')?.value!==expected)return {ok:false,error:'定时发布时间未被抖音接收，请检查时间范围。'};
 return {ok:true};
}

// resetLinkedDraft 仅重置具有本草稿标记的页面，按 App 快照重新上传，不触碰其他编辑页。
export async function resetLinkedDraft(draftKey,files){
 if(document.documentElement.dataset.lumaDraft!==draftKey)return {ok:false,error:'关联页面已变化，请重新从 App 带入。'};
 const query=(selector,root=document)=>[...root.querySelectorAll(selector),...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot).flatMap(e=>query(selector,e.shadowRoot))];
 const buttons=query('button').filter(e=>e.textContent.trim()==='清空并重新上传');
 if(buttons.length!==1)return {ok:false,retryable:false,error:'无法定位关联页面的替换上传操作。'};
 // 直接写字节避免大字符串迭代分配。
 const decode=value=>{const binary=atob(value),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);return bytes;};
 const transfer=new DataTransfer();
 for(const file of files)transfer.items.add(file.ticket?globalThis.__lumaBinaryFiles?.get(file.ticket)?.[file.binaryIndex]:new File([decode(file.base64)],file.name,{type:file.type}));
 buttons[0].click();
 for(let attempt=0;attempt<50;attempt++){
  await new Promise(resolve=>setTimeout(resolve,100));
  const title=query('h5').some(e=>e.textContent.trim()==='重新上传将清空已上传图片，是否重新上传？');
  const confirm=query('button').filter(e=>e.textContent.trim()==='重新上传');
  if(!title||confirm.length!==1)continue;
  // 抖音在确认回调内创建脱离 DOM 的 file input。仅在本次确认期间接管其
  // click，把用户已选素材交给原 change 处理器，随后立即恢复原型。
  const original=HTMLInputElement.prototype.click;
  let delivered=false;
  const replacement=function(){
   if(this.type!=='file')return original.call(this);
   if(delivered)return;
   if(!this.multiple&&files.length>1)throw Error('替换上传控件不支持多张图片。');
   this.files=transfer.files;
   delivered=true;
   HTMLInputElement.prototype.click=original;
   this.dispatchEvent(new Event('change',{bubbles:true}));
  };
  try{
   HTMLInputElement.prototype.click=replacement;
   confirm[0].click();
   for(let wait=0;wait<20&&!delivered;wait++)await new Promise(resolve=>setTimeout(resolve,100));
   return delivered?{ok:true,count:files.length}:{ok:false,retryable:false,error:'抖音替换上传控件已变化，请检查当前图片。'};
  }finally{
   if(HTMLInputElement.prototype.click===replacement)HTMLInputElement.prototype.click=original;
  }
 }
 return {ok:false,retryable:false,error:'未找到图片重传确认框，请检查抖音页面。'};
}

// markLinkedDraft 在当前文档标记绑定身份；导航到另一份稿件后标记自然失效。
export function markLinkedDraft(draftKey,check=false){
 if(check)return {ok:document.documentElement.dataset.lumaDraft===draftKey};
 document.documentElement.dataset.lumaDraft=draftKey;return {ok:true};
}
