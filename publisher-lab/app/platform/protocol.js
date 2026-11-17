// 插件本地媒体读取限额，不包含浏览器交接协议。
export const MAX_FILE=50*1024*1024;
export const MAX_VIDEO_FILE=80*1024*1024;

// 识别文件签名而非信任名称，防止将其他文件伪装成图片传给网页。
export function imageType(bytes) {
  if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  if(bytes.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))return 'image/png';
  if(bytes.length>=12&&String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP')return 'image/webp';
  if(bytes.length>=26&&bytes[0]===0x42&&bytes[1]===0x4d)return 'image/bmp';
  // 发布页 accept 使用 image/tif；识别 TIFF 大小端签名，不依赖扩展名。
  if(bytes.length>=8&&((bytes[0]===0x49&&bytes[1]===0x49&&bytes[2]===42&&bytes[3]===0)||(bytes[0]===0x4d&&bytes[1]===0x4d&&bytes[2]===0&&bytes[3]===42)))return 'image/tif';
  throw Error('原文件不是支持的图片格式，请先转换。');
}

// 流式限额读取，原图过大时立即取消，不等完整文件进入内存。
export async function readBounded(response,limit) {
  if(!response.ok||!response.body)throw Error(`原图读取失败（HTTP ${response.status}），请检查 App 和来源文件。`);
  // 超限使用稳定代码交由调用方补充文件名和场景上限，不依赖匹配提示文案。
  const tooLarge=()=>Object.assign(Error('素材超过单个文件大小限制。'),{code:'MEDIA_FILE_TOO_LARGE'});
  if(Number(response.headers.get('content-length'))>limit){try{await response.body.cancel();}catch{}throw tooLarge();}
  const reader=response.body.getReader(),parts=[];let size=0;
  try {
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw tooLarge();parts.push(value);}
  }catch(error){try{await reader.cancel();}catch{}throw error;}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
}

// 视频仅识别支持的容器，不在插件中转码；实际编码兼容性由浏览器/抖音判定。
export function videoType(bytes){
 if(bytes.length>=12&&String.fromCharCode(...bytes.slice(4,8))==='ftyp'){
  const brand=String.fromCharCode(...bytes.slice(8,12));
  if(brand==='qt  ')return 'video/quicktime';
  if(['isom','iso2','iso4','iso5','iso6','mp41','mp42','avc1','M4V ','MSNV','dash'].includes(brand))return 'video/mp4';
 }
 if(bytes.length>=4&&[0x1a,0x45,0xdf,0xa3].every((v,i)=>bytes[i]===v))return 'video/webm';
 throw Error('不是支持的视频容器，请先转换成 MP4、MOV 或 WebM。');
}
