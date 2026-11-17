export const HANDOFF_PATH='/api/v1/plugins/com.lumaindex.douyin/files/handoff.html';
// MAX_FILE 限制单张上传图片为 50 MiB，图文批次不设累计字节上限。
export const MAX_FILE=50*1024*1024;
// MAX_VIDEO_FILE 只限制单个视频为 80 MiB，不用于图文批次大小判断。
export const MAX_VIDEO_FILE=80*1024*1024;

// 只允许本机安装的这一插件交接页发起，不接受网页提供任意下载 URL。
export function validate(message,senderURL) {
  const source=new URL(senderURL);
  if(source.protocol!=='http:'||!['127.0.0.1','localhost'].includes(source.hostname)||source.pathname!==HANDOFF_PATH||source.username||source.password)throw Error('交接来源不匹配，请从 App 打开插件。');
  const {op,job}=message||{};
  if(op!=='continue'||job?.version!==1||typeof job.id!=='string'||! /^[a-zA-Z0-9-]{1,80}$/.test(job.id))throw Error('交接任务无效。');
  if(typeof job.title!=='string'||job.title.length>20||/[\r\n]/.test(job.title)||typeof job.description!=='string'||job.description.length>1000)throw Error('标题或描述格式无效。');
  if(job.settings){
    const s=job.settings;
    if(s.location!==undefined&&s.location!==null&&(!/^[0-9]{6}$/.test(s.location.cityCode)||typeof s.location.cityName!=='string'||s.location.cityName.length>100||!/^\d{1,30}$/.test(s.location.id)||typeof s.location.name!=='string'||!s.location.name||s.location.name.length>200))throw Error('位置无效，请重新选择城市和地点。');
    if(s.collection!==undefined&&s.collection!==null){
      const c=s.collection;
      if(typeof c!=='object'||Array.isArray(c)||typeof c.id!=='string'||!/^\d{1,30}$/.test(c.id)||typeof c.title!=='string'||!c.title.trim()||c.title.length>200||typeof c.account!=='string'||!/^\d{1,30}$/.test(c.account))throw Error('合集无效，请重新读取并选择当前抖音账号的合集。');
      if(s.visibility!=='public')throw Error('加入合集的作品需要公开可见，请调整可见范围或清除合集。');
    }
    if(!['public','friends','private'].includes(s.visibility)||!['allow','deny'].includes(s.download)||!['now','scheduled'].includes(s.publishTime))throw Error('发布设置无效。');
    if(s.publishTime==='scheduled'){const delta=Date.parse(s.scheduledAt)-Date.now();if(!Number.isFinite(delta)||delta<2*3600000||delta>14*86400000)throw Error('请选择 2 小时后至 14 天内的发布时间。');}
  }
  if(job.draftKey!==undefined&&(typeof job.draftKey!=='string'||!job.draftKey||job.draftKey.length>500))throw Error('草稿标识无效。');
  const kind=job.kind??'image';
  if(!['image','video'].includes(kind))throw Error('发布类型无效。');
  if(!Array.isArray(job.assets)||!job.assets.length||job.assets.length>(kind==='video'?1:35))throw Error('请选择 1–35 张图片或单个视频。');
  if(job.settings?.coverIndex!==undefined&&(kind!=='image'||!Number.isInteger(job.settings.coverIndex)||job.settings.coverIndex<0||job.settings.coverIndex>=job.assets.length))throw Error('封面选择无效，请重新选择。');
  const crop=job.settings?.coverCrop;
  if(job.settings?.coverIndex!==undefined&&!crop)throw Error('请先在抖音发布助手中确认封面裁剪。');
  if(crop&&(job.settings.coverIndex===undefined||!['x','y','width','height'].every(k=>typeof crop[k]==='number'&&Number.isFinite(crop[k]))||crop.x<0||crop.y<0||crop.width<=0||crop.height<=0||crop.x+crop.width>1.000001||crop.y+crop.height>1.000001))throw Error('封面裁剪区域无效，请重新裁剪。');
  const ids=new Set();
  for(const asset of job.assets) {
    if(typeof asset.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(asset.id))throw Error('素材身份无效或重复。');
    if(typeof asset.name!=='string'||asset.name.length>255||/[\/\\\x00-\x1f]/.test(asset.name)||!(kind==='video'?/\.(mp4|mov|webm)$/i:/\.(jpe?g|png|webp|bmp|tiff?|heic|heif|avif|cr2|cr3|nef|nrw|arw|srf|sr2|dng|raf|orf|rw2|pef|srw|raw)$/i).test(asset.name))throw Error('文件格式与发布类型不匹配。');
    ids.add(asset.id);
  }
  return {op,job,kind,origin:source.origin};
}

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
