import {MAX_FILE} from './protocol.js';

// IMAGE_X_ORIGIN 是已核对的图片上传服务；签名请求不得接受调用方指定的地址。
const IMAGE_X_ORIGIN='https://imagex.bytedanceapi.com';
// encoder 仅用于协议文本与签名；图片字节始终按二进制上传。
const encoder=new TextEncoder();
// CRC_TABLE 缓存 IEEE CRC32 的查表项，与已验证上传接口的 Content-CRC32 一致。
const CRC_TABLE=Uint32Array.from({length:256},(_,value)=>{
 for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);
 return value>>>0;
});
// MD5_SHIFTS 和 MD5_CONSTANTS 定义图片内容完整性校验，不用于凭据签名。
const MD5_SHIFTS=[7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21];
const MD5_CONSTANTS=Uint32Array.from({length:64},(_,i)=>Math.floor(Math.abs(Math.sin(i+1))*4294967296));

// hex 将摘要字节序列化成小写十六进制，不输出原始输入。
function hex(bytes){return [...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,'0')).join('');}
// sha256 计算 AWS4 请求规范所用的 SHA-256 摘要。
async function sha256(value){return hex(await crypto.subtle.digest('SHA-256',typeof value==='string'?encoder.encode(value):value));}
// hmac 为 AWS4 派生短期密钥；CryptoKey 不允许导出且不持久化。
async function hmac(key,value){
 const imported=await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return new Uint8Array(await crypto.subtle.sign('HMAC',imported,encoder.encode(value)));
}
// crc32 计算与 ImageX 原始文件上传响应比较的八位校验和。
export function crc32(bytes){
 let result=0xffffffff;
 for(const byte of bytes)result=CRC_TABLE[(result^byte)&255]^(result>>>8);
 return ((result^0xffffffff)>>>0).toString(16).padStart(8,'0');
}
// md5 仅核对服务端 ImageMd5，防止成功响应属于另一份文件；签名仍使用 SHA-256。
export function md5(bytes){
 const padded=new Uint8Array(Math.ceil((bytes.length+9)/64)*64);padded.set(bytes);padded[bytes.length]=128;
 const view=new DataView(padded.buffer),bits=BigInt(bytes.length)*8n;
 view.setUint32(padded.length-8,Number(bits&0xffffffffn),true);view.setUint32(padded.length-4,Number(bits>>32n),true);
 let a0=0x67452301,b0=0xefcdab89,c0=0x98badcfe,d0=0x10325476;
 for(let offset=0;offset<padded.length;offset+=64){
  let a=a0,b=b0,c=c0,d=d0;
  for(let index=0;index<64;index++){
   let f,g;
   if(index<16){f=(b&c)|(~b&d);g=index;}
   else if(index<32){f=(d&b)|(~d&c);g=(5*index+1)%16;}
   else if(index<48){f=b^c^d;g=(3*index+5)%16;}
   else{f=c^(b|~d);g=(7*index)%16;}
   const sum=(a+f+MD5_CONSTANTS[index]+view.getUint32(offset+g*4,true))>>>0,shift=MD5_SHIFTS[Math.floor(index/16)*4+index%4];
   a=d;d=c;c=b;b=(b+((sum<<shift)|(sum>>>(32-shift))))>>>0;
  }
  a0=(a0+a)>>>0;b0=(b0+b)>>>0;c0=(c0+c)>>>0;d0=(d0+d)>>>0;
 }
 const result=new DataView(new ArrayBuffer(16));[a0,b0,c0,d0].forEach((value,index)=>result.setUint32(index*4,value,true));
 return hex(result.buffer);
}

// validateAuth 拒绝缺失、过期或含换行的临时凭据；不接受 Cookie 或持久凭据替代。
function validateAuth(auth,now){
 if(!(now instanceof Date)||!Number.isFinite(now.getTime())||!auth||!['AccessKeyID','SecretAccessKey','SessionToken'].every(key=>typeof auth[key]==='string'&&auth[key].length>0&&!/[\r\n]/.test(auth[key]))||!Number.isFinite(Date.parse(auth.ExpiredTime))||Date.parse(auth.ExpiredTime)<=now.getTime())throw Error('图片上传授权已过期或无效，请重新同步。');
}
// encodeQuery 使用 RFC3986 编码，保持与已验证 Python 签名请求逐字节一致。
function encodeQuery(value){return encodeURIComponent(value).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());}
// signImageXRequest 只签发申请和确认上传两个固定动作；返回值只供当前请求使用，不得记录或存储。
export async function signImageXRequest(auth,action,body=null,{now=new Date(),nonce=crypto.randomUUID().replaceAll('-','').slice(0,12)}={}){
 if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw Error('图片上传时间无效。');
 validateAuth(auth,now);
 if(!['ApplyImageUpload','CommitImageUpload'].includes(action))throw Error('不支持此图片上传操作。');
 if(action==='ApplyImageUpload'&&body!==null||action==='CommitImageUpload'&&(!body||typeof body.SessionKey!=='string'||!body.SessionKey||Object.keys(body).length!==1))throw Error('图片上传会话无效，请重新同步。');
 if(!/^[a-f0-9]{12}$/.test(nonce))throw Error('图片上传请求标识无效。');
 const params={Action:action,Version:'2018-08-01',ServiceId:'jm8ajry58r',app_id:'2906',user_id:''};
 if(action==='ApplyImageUpload')params.s=nonce;
 return await signMediaRequest(auth,'imagex',params,body,{now});
}

// signMediaRequest 共用 ImageX/VOD 的 AWS4 实现；服务和动作共同决定固定主机，不允许签名任意地址。
export async function signMediaRequest(auth,service,params,body=null,{now=new Date()}={}){
 validateAuth(auth,now);
 const permitted={imagex:['ApplyImageUpload','CommitImageUpload'],vod:['ApplyUploadInner','CommitUploadInner']};
 if(!permitted[service]?.includes(params?.Action))throw Error('不支持此素材上传操作。');
 const query=Object.keys(params).sort().map(key=>encodeQuery(key)+'='+encodeQuery(String(params[key]))).join('&');
 const payload=body===null?'':JSON.stringify(body),method=body===null?'GET':'POST',stamp=now.toISOString().replace(/[:-]|\.\d{3}/g,'');
 const headers={'x-amz-date':stamp,'x-amz-security-token':auth.SessionToken};
 const digest=await sha256(payload);if(body!==null)headers['x-amz-content-sha256']=digest;
 const names=Object.keys(headers).sort(),signed=names.join(';'),canonicalHeaders=names.map(key=>key+':'+headers[key].trim()+'\n').join('');
 const canonical=[method,'/',query,canonicalHeaders,signed,digest].join('\n'),scope=stamp.slice(0,8)+'/cn-north-1/'+service+'/aws4_request';
 const toSign=['AWS4-HMAC-SHA256',stamp,scope,await sha256(canonical)].join('\n');
 let key=encoder.encode('AWS4'+auth.SecretAccessKey);
 for(const value of [stamp.slice(0,8),'cn-north-1',service,'aws4_request'])key=await hmac(key,value);
 headers.Authorization=`AWS4-HMAC-SHA256 Credential=${auth.AccessKeyID}/${scope}, SignedHeaders=${signed}, Signature=${hex(await hmac(key,toSign))}`;
 if(body!==null)headers['Content-Type']='application/json';
 const origin=service==='imagex'?IMAGE_X_ORIGIN:'https://vod.bytedanceapi.com';
 return {url:origin+'/?'+query,method,headers,...(body===null?{}:{body:payload})};
}

// uploadEndpoint 验证服务端返回的存储位置，防止将临时上传授权转发给任意主机或路径。
export function uploadEndpoint(address,kind='image'){
 const host=address?.UploadHosts?.[0],store=address?.StoreInfos?.[0],uri=store?.StoreUri;
 if(typeof host!=='string'||host.length>253||(!/^tos-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:snssdk|douyin)\.com$/.test(host)&&!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+bytedancevod\.com$/.test(host))||typeof uri!=='string'||!uri||uri.split('/').some(part=>!part||part==='.'||part==='..')||/[\\\x00-\x1f\x7f?#%]/.test(uri)||typeof store.Auth!=='string'||!store.Auth||/[\r\n]/.test(store.Auth)||typeof address.SessionKey!=='string'||!address.SessionKey)throw Error((kind==='video'?'视频':'图片')+'上传地址未通过校验，请重新同步。');
 return {url:'https://'+host+'/upload/v1/'+uri.split('/').map(encodeQuery).join('/'),uri,authorization:store.Auth,sessionKey:address.SessionKey};
}
// UploadRequestError 只携带可公开的阶段、稳定诊断码及 HTTP 状态，不保存地址、凭据或原始错误。
class UploadRequestError extends Error {
 // constructor 生成受控说明；code 区分原因，stage 区分申请、发送和确认，status 仅在有合法 HTTP 码时存在。
 constructor(code,stage,message,status){
  super(message);
  this.name='UploadRequestError';
  this.code=code;
  this.stage=stage;
  if(status!==undefined)this.status=status;
 }
}

// requestUploadJSON 拒绝重定向、登录 Cookie 和原始服务端错误外泄；不自动重试有副作用的上传动作。
// 默认请求仍为 60 秒，图片二进制发送可显式延长，所有请求最多 5 分钟；视频调用方保持原默认行为。
export async function requestUploadJSON(request,{fetch:send=globalThis.fetch,signal,kind='image',stage='request',timeoutMs=60000}={}){
 const label=kind==='video'?'视频':'图片';
 stage=['apply','upload','commit'].includes(stage)?stage:'request';
 const phase={apply:`申请${label}上传地址`,upload:`${label}数据上传`,commit:`${label}上传确认`,request:`${label}上传请求`}[stage];
 const failure=(code,message,status)=>new UploadRequestError(code,stage,message,status);
 if(signal?.aborted)throw failure('UPLOAD_CANCELLED',phase+'已取消。');
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>300000)throw failure('UPLOAD_INVALID_TIMEOUT','上传等待时间设置无效，请更新扩展。');
 const timeout=AbortSignal.timeout(timeoutMs);
 try{
  const {url,...init}=request,response=await send(url,{...init,credentials:'omit',redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout});
  if(!response||typeof response.ok!=='boolean'||typeof response.json!=='function')throw failure('UPLOAD_INVALID_RESPONSE',phase+'响应格式无效，请稍后重新带入。');
  if(!response.ok){
   const status=Number.isInteger(response.status)&&response.status>=100&&response.status<=599?response.status:undefined;
   throw failure('UPLOAD_HTTP_ERROR',`${phase}被服务端拒绝${status===undefined?'':`（HTTP ${status}）`}，请稍后重新带入。`,status);
  }
  let data;
  try{data=await response.json();}
  catch(error){
   if(signal?.aborted||timeout.aborted)throw error;
   throw failure('UPLOAD_INVALID_RESPONSE',phase+'响应格式无效，请稍后重新带入。');
  }
  if(!data||typeof data!=='object'||Array.isArray(data))throw failure('UPLOAD_INVALID_RESPONSE',phase+'响应格式无效，请稍后重新带入。');
  if(data.ResponseMetadata?.Error)throw failure('UPLOAD_REJECTED',phase+'未获服务端确认，请重新带入。');
  return data;
 }catch(error){
  if(signal?.aborted)throw failure('UPLOAD_CANCELLED',phase+'已取消。');
  if(timeout.aborted)throw failure('UPLOAD_TIMEOUT',`${phase}超时（${Math.ceil(timeoutMs/1000)} 秒），请检查网络后重新带入。`);
  if(error instanceof UploadRequestError)throw error;
  throw failure('UPLOAD_NETWORK_ERROR',phase+'失败，网络连接中断或不可用，请重新带入。');
 }
}
// uploadImage 独立完成申请、二进制上传与提交确认；仅返回可用于原生草稿的图片元数据，不调用发布页代码。
export async function uploadImage(file,auth,options={}){
 if(!(file instanceof Blob)||!/^image\/(jpeg|png|webp)$/.test(file.type)||!file.size||file.size>MAX_FILE)throw Error('请选择大小不超过 50 MiB 的 JPEG、PNG 或 WebP 图片。');
 if(options.signal?.aborted)throw Error('图片上传已取消。');
 const now=()=>options.now?options.now():new Date();
 validateAuth(auth,now());
 const bytes=new Uint8Array(await file.arrayBuffer()),checksum=crc32(bytes),fingerprint=md5(bytes);
 // 每一步单独签名，避免并行上传复用日期或请求体签名。
 const imagex=async(action,body=null)=>{
  const request=await signImageXRequest(auth,action,body,{now:now(),...(options.random?{nonce:options.random()}: {})});
  return (await requestUploadJSON(request,{...options,stage:action==='ApplyImageUpload'?'apply':'commit',timeoutMs:60000})).Result;
 };
 const applied=await imagex('ApplyImageUpload'),target=uploadEndpoint(applied?.UploadAddress);
 const uploaded=await requestUploadJSON({url:target.url,method:'POST',body:bytes,headers:{Authorization:target.authorization,'Content-Type':'application/octet-stream','Content-CRC32':checksum,'Content-Disposition':'attachment; filename="image"','X-Storage-U':''}},{...options,stage:'upload',timeoutMs:300000});
 if(uploaded.code!==2000||typeof uploaded.data?.crc32!=='string'||uploaded.data.crc32.toLowerCase()!==checksum)throw Error('图片上传内容校验失败，请重新同步。');
 const committed=await imagex('CommitImageUpload',{SessionKey:target.sessionKey});
 if(!Array.isArray(committed?.Results)||committed.Results.filter(result=>result.Uri===target.uri&&result.UriStatus===2000).length!==1)throw Error('抖音尚未确认图片上传，请重新同步。');
 const metadata=Array.isArray(committed.PluginResult)?committed.PluginResult.filter(item=>item.ImageUri===target.uri):[];
 if(metadata.length!==1||typeof metadata[0].ImageMd5!=='string'||metadata[0].ImageMd5.toLowerCase()!==fingerprint)throw Error('远端图片与本地文件校验不一致，请重新同步。');
 // 原生草稿采用首字母小写的元数据键，orientation 子对象也按同一规则转换。
 const lowerKeys=value=>Object.fromEntries(Object.entries(value||{}).map(([key,value])=>[key[0].toLowerCase()+key.slice(1),value]));
 const uploadFile={...lowerKeys(metadata[0]),orientation:lowerKeys(metadata[0].Orientation),uri:target.uri,uriStatus:2000,key:'luma_studio_'+target.uri.split('/').at(-1)};
 return {uri:target.uri,bytes:bytes.length,uploadFile};
}
