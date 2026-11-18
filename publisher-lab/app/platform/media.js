import {throwIfCancelled, combineSignals} from './cancellation.js';
import {readBounded,imageType,videoType,MAX_FILE,MAX_VIDEO_FILE} from './protocol.js';

// resolveAssets 读取图库确认的静态组件和浏览图，按图库素材身份去重，保持首次出现顺序；不重复读取文件计算哈希。
export async function resolveAssets(job,origin,{signal}={}){
 throwIfCancelled(signal);
 const assets=[],ids=new Set();let duplicates=0;
 const resolved=await mapLimited(job.assets,4,async source=>{
  throwIfCancelled(signal);
  let asset=source;
  {
   const metadata=await fetch(`${origin}/api/v1/assets/${encodeURIComponent(source.id)}`,{credentials:'omit',redirect:'error',signal:combineSignals(signal,AbortSignal.timeout(15000))});
   const payload=await metadata.json();
   if(!metadata.ok||payload.code!==0)throw Error('读取素材信息失败，请检查图库。');
   asset={id:(job.kind!=='video'&&payload.data.livePhoto?.imageAssetId)||source.id,name:payload.data.name||source.name,sizeBytes:payload.data.sizeBytes,revision:JSON.stringify([payload.data.sizeBytes,payload.data.modifiedAt,payload.data.sha256||null])};
   if(asset.id!==source.id){
    const response=await fetch(`${origin}/api/v1/assets/${encodeURIComponent(asset.id)}`,{credentials:'omit',redirect:'error',signal:combineSignals(signal,AbortSignal.timeout(15000))});
    const detail=await response.json();if(!response.ok||detail.code!==0)throw Error('实况照片的静态图片不可用。');asset.name=detail.data.name;asset.sizeBytes=detail.data.sizeBytes;asset.revision=JSON.stringify([detail.data.sizeBytes,detail.data.modifiedAt,detail.data.sha256||null]);
   }
  }
  return asset;
 });
 for(const asset of resolved){
  if(ids.has(asset.id)){duplicates++;continue;}ids.add(asset.id);
  const original=job.kind==='video'||/\.(jpe?g|png|webp)$/i.test(asset.name);
  const extension=asset.name.split('.').pop().toLowerCase().replace('jpeg','jpg');
  asset.uploadName=job.kind==='video'?asset.name:asset.name.replace(/\.[^.]+$/,'')+'.'+(original?extension:'jpg');
  assets.push(asset);
 }
 return {assets,duplicates};
}

// prepareFile 只读取一个已解析素材，调用方在上传并保存检查点后释放它，再读取下一项。
// 图片仅受单张 50 MiB 限制；视频独立限制为 80 MiB，不累计图文批次字节数。
export async function prepareFile(job,origin,asset,{signal}={}){
 throwIfCancelled(signal);
 // displayName 仅保留文件名并清除控制字符，错误提示不暴露来源目录或底层请求地址。
 const displayName=(typeof asset?.name==='string'?asset.name.split(/[\\/]/).at(-1):'')
  .replace(/[\x00-\x1f\x7f]/g,'').slice(0,160)||'未命名素材';
 const video=job?.kind==='video';
 let phase='reading';
 try{
  const useOriginal=video||/\.(jpe?g|png|webp)$/i.test(asset.name);
  const variant=useOriginal?'original':'preview?size=2048';
  const response=await fetch(`${origin}/api/v1/assets/${encodeURIComponent(asset.id)}/${variant}`,{credentials:'omit',redirect:'error',signal:combineSignals(signal,AbortSignal.timeout(60000))});
  const bytes=await readBounded(response,video?MAX_VIDEO_FILE:MAX_FILE);
  phase='format';
  const type=video?videoType(bytes):imageType(bytes);
  if(!video&&!['image/jpeg','image/png','image/webp'].includes(type))throw Error();
  const extensions={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'};
  const name=video?displayName:displayName.replace(/\.[^.]+$/,'')+'.'+extensions[type];
  phase='preparing';
  return {assetID:asset.id,revision:asset.revision||null,name,type,size:bytes.length,file:new File([bytes],name,{type})};
 }catch(error){
  throwIfCancelled(signal);
  if(error?.code==='MEDIA_FILE_TOO_LARGE')throw Object.assign(Error(video
   ?`“${displayName}”超过单个视频 80 MiB 的限制，请压缩视频后重新带入。`
   :`“${displayName}”超过单张图片 50 MiB 的限制，请缩小图片后重新带入。`),{code:'MEDIA_FILE_TOO_LARGE'});
  if(phase==='format')throw Object.assign(Error(video
   ?`“${displayName}”的视频格式不可用，请转换为 MP4、MOV 或 WebM 后重新带入。`
   :`“${displayName}”的图片格式不可用，请转换为 JPEG、PNG 或 WebP 后重新带入。`),{code:'MEDIA_UNSUPPORTED_FORMAT'});
  if(['TimeoutError','AbortError'].includes(error?.name))throw Object.assign(Error(`读取“${displayName}”超时，请确认图库运行且素材来源在线后重新带入。`),{code:'MEDIA_READ_TIMEOUT'});
  throw Object.assign(Error(`无法读取“${displayName}”，请在图库检查素材是否可打开，并确认来源在线后重新带入。`),{code:'MEDIA_READ_FAILED'});
 }
}

// mapLimited 限制本机读取并发并保持输入顺序；失败后停止领取新素材，
// 等待在途读取结算再返回错误，避免调用方提前释放任务锁后仍有旧任务继续读取。
export async function mapLimited(items,limit,read){
 const result=new Array(items.length);let next=0,failed=false,failure;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
  while(!failed&&next<items.length){
   const index=next++;
   try{result[index]=await read(items[index]);}
   catch(error){if(!failed){failed=true;failure=error;}}
  }
 }));
 if(failed)throw failure;
 return result;
}
