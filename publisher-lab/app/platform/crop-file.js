import {throwIfCancelled, combineSignals} from './cancellation.js';
import {readBounded,MAX_FILE} from './protocol.js';
// 只读取已校验的图库素材预览，按 App 确认的区域输出独立 JPEG，不更改正文文件。
export async function cropCoverFile(origin,assetID,crop,{signal}={}){
 throwIfCancelled(signal);
 const response=await fetch(`${origin}/api/v1/assets/${encodeURIComponent(assetID)}/preview?size=2048`,{credentials:'omit',redirect:'error',signal:combineSignals(signal,AbortSignal.timeout(30000))});
 const bytes=await readBounded(response,MAX_FILE),bitmap=await createImageBitmap(new Blob([bytes]));
 try{
  // 抖音拒绝分辨率过低的封面；保持比例，将短边输出为至少 1080 像素。
  const sourceWidth=bitmap.width*crop.width,sourceHeight=bitmap.height*crop.height,scale=Math.max(1,1080/Math.min(sourceWidth,sourceHeight));
  const width=Math.round(sourceWidth*scale),height=Math.round(sourceHeight*scale);
  if(width>4096||height>4096)throw Error('封面比例过长，请调整图片后重新裁剪。');
  const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d');
  ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);
  ctx.drawImage(bitmap,crop.x*bitmap.width,crop.y*bitmap.height,crop.width*bitmap.width,crop.height*bitmap.height,0,0,width,height);
  const blob=await canvas.convertToBlob({type:'image/jpeg',quality:.93});
  throwIfCancelled(signal);
  return new File([blob],'封面.jpg',{type:'image/jpeg'});
 }finally{bitmap.close();}
}
