import {MAX_VIDEO_FILE} from './protocol.js';
import {crc32,md5,signMediaRequest,uploadEndpoint,requestUploadJSON} from './image-upload.js';

// DIRECT_LIMIT 与已核对 SDK 一致：不超过 3 MiB 时走整文件上传，其余使用分片。
const DIRECT_LIMIT=3*1024*1024;
// VIDEO_FUNCTIONS 仅请求视频元信息与首帧，不创建或发布作品。
const VIDEO_FUNCTIONS=[{name:'GetMeta'},{name:'Snapshot',input:{SnapshotTime:0}}];

// signVideoRequest 只生成 VOD 的申请/确认协议，不接受调用方指定上传服务主机。
export async function signVideoRequest(auth,action,{size,sessionKey}={},options={}){
 const params={Action:action,Version:'2020-11-19',SpaceName:'aweme',app_id:'2906',user_id:''};
 let body=null;
 if(action==='ApplyUploadInner'){
  if(!Number.isSafeInteger(size)||size<1||size>MAX_VIDEO_FILE)throw Error('视频文件大小无效。');
  const nonce=options.random?options.random():crypto.randomUUID().replaceAll('-','').slice(0,12);
  if(typeof nonce!=='string'||!/^[a-z0-9]{1,64}$/.test(nonce))throw Error('视频上传请求标识无效。');
  Object.assign(params,{FileType:'video',IsInner:1,FileSize:size,s:nonce});
 }else if(action==='CommitUploadInner'){
  if(typeof sessionKey!=='string'||!sessionKey)throw Error('视频上传会话无效。');
  body={SessionKey:sessionKey,Functions:VIDEO_FUNCTIONS};
 }else throw Error('不支持此视频上传操作。');
 return await signMediaRequest(auth,'vod',params,body,{now:options.now?options.now():new Date()});
}

// videoChunks 将视频按 SDK 已核对的普通/网关分片规则划分，网关尾片不足 5 MiB 时并入上一片。
export function videoChunks(size,gateway=false){
 const chunk=gateway?5*1024*1024:DIRECT_LIMIT,result=[];
 for(let start=0;start<size;){
  let end=Math.min(size,start+chunk);if(gateway&&size-end<chunk)end=size;
  result.push({start,end});start=end;
 }
 return result;
}
// storageHeaders 接收申请上传响应中的存储扩展头，只允许 X- 前缀，不覆盖授权、CRC 或 HTTP 路由。
function storageHeaders(value){
 const entries=Array.isArray(value)?value.map(item=>[item?.Key,item?.Value]):Object.entries(value||{}),headers={};
 for(const [key,raw] of entries){
  if(typeof key!=='string'||!/^x-[a-z0-9-]+$/i.test(key)||typeof raw!=='string'||/[\r\n]/.test(raw)||key.toLowerCase().startsWith('x-amz-'))throw Error('视频存储请求头未通过校验，请重新同步。');
  headers[key.toLowerCase()]=raw;
 }
 return headers;
}
// lowerMetadata 只转换 VOD 返回的 JSON 键，独立于页面的元信息适配函数。
function lowerMetadata(value){
 if(Array.isArray(value))return value.map(lowerMetadata);
 if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).filter(([key])=>key).map(([key,item])=>[key[0].toLowerCase()+key.slice(1),lowerMetadata(item)]));
}
// uploadVideo 使用独立 VOD 请求上传并校验视频；成功仅代表素材已接收，抖音转码就绪仍需调用方检查 transend。
export async function uploadVideo(file,auth,options={}){
 if(!(file instanceof Blob)||!/^video\/(mp4|quicktime|webm)$/.test(file.type)||file.size<1||file.size>MAX_VIDEO_FILE)throw Error('请选择大小不超过 80 MiB 的 MP4、MOV 或 WebM 视频。');
 if(options.signal?.aborted)throw Error('视频上传已取消。');
 const network={...options,kind:'video'},bytes=new Uint8Array(await file.arrayBuffer()),fingerprint=md5(bytes);
 // VOD 签名凭据仅由此调用持有，不进入上传结果或持久化检查点。
 const vod=async(action,values)=>{
  const request=await signVideoRequest(auth,action,values,options);
  return (await requestUploadJSON(request,network)).Result;
 };
 const applied=await vod('ApplyUploadInner',{size:file.size}),node=applied?.InnerUploadAddress?.UploadNodes?.[0];
 const target=uploadEndpoint({UploadHosts:[node?.UploadHost],StoreInfos:node?.StoreInfos,SessionKey:node?.SessionKey},'video');
 const extra=storageHeaders(node?.UploadHeader),gateway=Object.hasOwn(extra,'x-storage-mode')||Object.hasOwn(extra,'x-upload-storage-mode');
 const headers={...extra,Authorization:target.authorization,'X-Storage-U':''};
 let uploadID=node.StoreInfos[0].UploadID;
 // SDK 收到网关存储头后先初始化会话，包括小文件整传；初始化不创建作品。
 if(gateway){
  const initialized=await requestUploadJSON({url:target.url+'?uploadmode=part&phase=init',method:'POST',headers},network);
  if(initialized.code!==2000||typeof initialized.data?.uploadid!=='string'||!initialized.data.uploadid)throw Error('视频分片会话未建立，请重新同步。');
  uploadID=initialized.data.uploadid;
 }
 // 每片只发送一次；没有完整确认时不执行合并或 Commit，避免将部分传输报成成功。
 const transfer=async(url,part)=>{
  const checksum=crc32(part),response=await requestUploadJSON({url,method:'POST',headers:{...headers,'Content-Type':'application/octet-stream','Content-CRC32':checksum},body:part},network);
  if(response.code!==2000||response.data?.crc32!==undefined&&(typeof response.data.crc32!=='string'||response.data.crc32.toLowerCase()!==checksum))throw Error('视频上传内容校验失败，请重新同步。');
  return checksum;
 };
 if(file.size<=DIRECT_LIMIT){
  await transfer(target.url,bytes);
 }else{
  if(!uploadID)uploadID=crypto.randomUUID();
  if(typeof uploadID!=='string'||!uploadID||uploadID.length>256||/[\x00-\x1f\x7f]/.test(uploadID))throw Error('视频分片会话无效，请重新同步。');
  const checksums=[],parts=videoChunks(file.size,gateway);
  for(const [index,part] of parts.entries()){
   const query=new URLSearchParams({uploadid:uploadID,part_number:String(index+1),phase:'transfer',part_offset:String(part.start)});
   const checksum=await transfer(target.url+'?'+query,bytes.subarray(part.start,part.end));
   checksums.push((index+1)+':'+checksum);
  }
  const query=new URLSearchParams({uploadmode:'part',phase:'finish',uploadid:uploadID});
  const merged=await requestUploadJSON({url:target.url+'?'+query,method:'POST',headers,body:checksums.join(',')},network);
  if(merged.code!==2000||!merged.data?.key)throw Error('视频分片尚未合并成功，请重新同步。');
 }
 const committed=await vod('CommitUploadInner',{sessionKey:target.sessionKey});
 if(!Array.isArray(committed?.Results)||committed.Results.length!==1)throw Error('抖音尚未确认视频上传，请重新同步。');
 const result=lowerMetadata(committed.Results[0]),meta=result.videoMeta;
 if(typeof result.vid!=='string'||!result.vid||!meta||typeof meta.md5!=='string'||meta.md5.toLowerCase()!==fingerprint)throw Error('远端视频与本地文件校验不一致，请重新同步。');
 // 仅投递无凭据的元信息；转码前 duration/width/height/coverUri 可能尚未齐全，不能伪造就绪状态。
 const uploadFile={vid:result.vid,duration:meta.duration,height:meta.height,width:meta.width,md5:meta.md5,coverUri:result.posterUri,uri:meta.uri,type:file.type,name:file.name||'视频',size:file.size};
 return {vid:result.vid,bytes:file.size,uploadFile,videoMeta:meta};
}
