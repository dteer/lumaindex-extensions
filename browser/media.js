import {readBounded,imageType,videoType,MAX_FILE,MAX_TOTAL} from './protocol.js';

// resolveAssets 读取图库确认的静态组件和浏览图，按图库素材身份去重，保持首次出现顺序；不重复读取文件计算哈希。
export async function resolveAssets(job,origin){
 const assets=[],ids=new Set();let duplicates=0;
 const resolved=await mapLimited(job.assets,4,async source=>{
  let asset=source;
  if(job.kind!=='video'){
   const metadata=await fetch(`${origin}/api/v1/assets/${encodeURIComponent(source.id)}`,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});
   const payload=await metadata.json();
   if(!metadata.ok||payload.code!==0)throw Error('读取素材信息失败，请检查图库。');
   asset={id:payload.data.livePhoto?.imageAssetId||source.id,name:payload.data.name||source.name,sizeBytes:payload.data.sizeBytes,revision:JSON.stringify([payload.data.sizeBytes,payload.data.modifiedAt,payload.data.sha256||null])};
   if(asset.id!==source.id){
    const response=await fetch(`${origin}/api/v1/assets/${encodeURIComponent(asset.id)}`,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(15000)});
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

// prepareFiles 只读取增量计划中需要上传的文件；已有资源不会再编码传输。
export async function prepareFiles(job,origin,resolved=null,binary=false){
 const resolution=resolved?{assets:resolved,duplicates:0}:await resolveAssets(job,origin);
 let total=0;
 const files=await mapLimited(resolution.assets,2,async asset=>{
  const video=job.kind==='video',useOriginal=video||/\.(jpe?g|png|webp)$/i.test(asset.name);
  const variant=useOriginal?'original':'preview?size=2048';
  const response=await fetch(`${origin}/api/v1/assets/${encodeURIComponent(asset.id)}/${variant}`,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(60000)});
  const bytes=await readBounded(response,video?MAX_TOTAL:MAX_FILE);
  const type=video?videoType(bytes):imageType(bytes);
  total+=bytes.length;
  if(total>MAX_TOTAL)throw Error('去重后的素材仍超过本次传输大小限制。');
  const extensions={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/bmp':'bmp','image/tif':'tif'};
  const name=video?asset.name:asset.name.replace(/\.[^.]+$/,'')+'.'+extensions[type];
  if(binary)return {assetID:asset.id,revision:asset.revision||null,name,type,size:bytes.length,file:new File([bytes],name,{type})};
  let encoded='';
  for(let offset=0;offset<bytes.length;offset+=32768)encoded+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
  return {assetID:asset.id,revision:asset.revision||null,name,type,base64:btoa(encoded)};
 });
 return {files,duplicates:resolution.duplicates};
}

// mapLimited 限制本机读取并发，按输入顺序返回，避免多图串行等待和无界内存占用。
export async function mapLimited(items,limit,read){
 const result=new Array(items.length);let next=0;
 await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
  while(next<items.length){const index=next++;result[index]=await read(items[index]);}
 }));
 return result;
}
