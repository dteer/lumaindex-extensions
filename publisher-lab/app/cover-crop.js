// 裁剪参数使用归一化坐标，预览与导出复用相同图片和区域，不修改图库原文件。
export function cropRect(width,height,aspect,zoom=1,x=.5,y=.5){
 const baseW=Math.min(width,height*aspect),w=baseW/zoom,h=w/aspect;
 return {x:(width-w)*x/width,y:(height-h)*y/height,width:w/width,height:h/height};
}
// 打开插件内裁剪器；比例沿用正文首图，与抖音原生封面画布一致。
export async function editCoverCrop({asset,first,baseURL,previous}){
 const dialog=document.createElement('dialog');dialog.className='cover-crop-dialog';
 dialog.innerHTML='<form method="dialog"><h2>裁剪封面</h2><p class="muted">拖动图片调整位置，双指捏合缩放。封面比例与正文首图一致。</p><canvas aria-label="封面裁剪预览"></canvas><p class="crop-error" role="alert"></p><div class="crop-actions"><button type="button" data-action="reset">重置</button><button value="cancel">取消</button><button type="button" class="primary" data-action="save" disabled>确认裁剪</button></div></form>';
 document.body.append(dialog);dialog.showModal();
 const canvas=dialog.querySelector('canvas'),ctx=canvas.getContext('2d'),save=dialog.querySelector('[data-action=save]');
 let image,aspect,zoom=1,x=.5,y=.5,drag,gestureZoom=null;
 const load=id=>new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(Error('封面图片读取失败，请关闭后重试。'));img.src=`${baseURL}/assets/${encodeURIComponent(id)}/preview?size=2048`;});
 // 所有交互仅改变草稿中的裁剪区域，确认之前不写入设置。
 function draw(){if(!image)return;const r=cropRect(image.naturalWidth,image.naturalHeight,aspect,zoom,x,y);ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,r.x*image.naturalWidth,r.y*image.naturalHeight,r.width*image.naturalWidth,r.height*image.naturalHeight,0,0,canvas.width,canvas.height);}
 const result=new Promise(resolve=>{
  dialog.addEventListener('close',()=>{dialog.remove();resolve(null);},{once:true});
  save.onclick=()=>{const crop=cropRect(image.naturalWidth,image.naturalHeight,aspect,zoom,x,y);resolve(crop);dialog.close();};
 });
 // 以手势中心为锚点缩放，防止图片在缩放时跳到其他位置。
 function zoomAt(value,clientX,clientY){
  if(!image)return;
  const bounds=canvas.getBoundingClientRect(),px=Math.max(0,Math.min(1,(clientX-bounds.left)/bounds.width)),py=Math.max(0,Math.min(1,(clientY-bounds.top)/bounds.height));
  const before=cropRect(image.naturalWidth,image.naturalHeight,aspect,zoom,x,y);
  zoom=Math.max(1,Math.min(4,value));
  const after=cropRect(image.naturalWidth,image.naturalHeight,aspect,zoom,x,y);
  x=after.width>=1?.5:Math.max(0,Math.min(1,(before.x+px*(before.width-after.width))/(1-after.width)));
  y=after.height>=1?.5:Math.max(0,Math.min(1,(before.y+py*(before.height-after.height))/(1-after.height)));
  drag=null;draw();
 }
 // WKWebView 使用原生 gesture 事件；Chrome 的触控板捏合以 Ctrl+wheel 传递。
 canvas.addEventListener('gesturestart',e=>{e.preventDefault();gestureZoom=zoom;drag=null;},{passive:false});
 canvas.addEventListener('gesturechange',e=>{e.preventDefault();if(gestureZoom!==null)zoomAt(gestureZoom*e.scale,e.clientX,e.clientY);},{passive:false});
 canvas.addEventListener('gestureend',e=>{e.preventDefault();gestureZoom=null;},{passive:false});
 canvas.addEventListener('wheel',e=>{e.preventDefault();if(gestureZoom!==null)return;const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?canvas.clientHeight:1);zoomAt(zoom*Math.exp(-Math.max(-100,Math.min(100,delta))*.01),e.clientX,e.clientY);},{passive:false});
 dialog.querySelector('[data-action=reset]').onclick=()=>{zoom=1;x=y=.5;gestureZoom=null;drag=null;draw();};
 canvas.onpointerdown=e=>{if(!image)return;drag={x:e.clientX,y:e.clientY,startX:x,startY:y};canvas.setPointerCapture(e.pointerId);};
 canvas.onpointermove=e=>{if(!drag)return;const r=cropRect(image.naturalWidth,image.naturalHeight,aspect,zoom,x,y),bounds=canvas.getBoundingClientRect();x=Math.max(0,Math.min(1,drag.startX-(e.clientX-drag.x)/bounds.width*r.width/Math.max(1-r.width,.0001)));y=Math.max(0,Math.min(1,drag.startY-(e.clientY-drag.y)/bounds.height*r.height/Math.max(1-r.height,.0001)));draw();};
 canvas.onpointerup=canvas.onpointercancel=()=>{drag=null;};
 try{
  const images=await Promise.all([load(asset.id),load(first.id)]);if(!dialog.isConnected)return result;
  image=images[0];aspect=images[1].naturalWidth/images[1].naturalHeight;
  canvas.width=Math.round(Math.min(560,400*aspect));canvas.height=Math.round(canvas.width/aspect);
  if(previous){const base=cropRect(image.naturalWidth,image.naturalHeight,aspect);zoom=Math.max(1,Math.min(4,base.width/previous.width));const r=cropRect(image.naturalWidth,image.naturalHeight,aspect,zoom);x=Math.max(0,Math.min(1,previous.x/Math.max(1-r.width,.0001)));y=Math.max(0,Math.min(1,previous.y/Math.max(1-r.height,.0001)));}
  draw();save.disabled=false;
 }catch(e){dialog.querySelector('.crop-error').textContent=e.message;}
 return result;
}
