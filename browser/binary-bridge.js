// receiveBinary 使用结构化克隆交接 File，不经过 Chrome JSON 消息或 Base64。
export async function receiveBinary(url,ticket){
 return await new Promise(resolve=>{
  const frame=document.createElement('iframe');frame.hidden=true;
  let settled=false;
  const expected=new URL(url);
  // chrome-extension 是特殊协议，按扩展主机验证消息来源，不依赖 URL.origin 对特殊协议的实现。
  if(expected.protocol!=='chrome-extension:'||expected.pathname!=='/binary-frame.html')return resolve({ok:false,error:'二进制文件交接地址无效。'});
  const origin=`${expected.protocol}//${expected.host}`;
  frame.src=url+'#'+ticket;
  // 所有退出路径都移除监听和 iframe；settled 防止超时、卸载与消息同时完成。
  const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);window.removeEventListener('message',receive);window.removeEventListener('pagehide',unload);frame.remove();resolve(result);};
  const unload=()=>finish({ok:false,error:'页面已离开，文件交接已停止。'});
  const receive=event=>{
   if(event.source!==frame.contentWindow||event.origin!==origin||event.data?.type!=='luma-binary'||event.data.ticket!==ticket)return;
   if(event.data.error){finish({ok:false,error:'读取本次图片失败，请重新带入。'});return;}
   if(!Array.isArray(event.data.files)||!event.data.files.length||event.data.files.some(f=>!(f instanceof File))){finish({ok:false,error:'二进制文件交接格式无效。'});return;}
   globalThis.__lumaBinaryFiles??=new Map();globalThis.__lumaBinaryTimers??=new Map();
   clearTimeout(globalThis.__lumaBinaryTimers.get(ticket));
   globalThis.__lumaBinaryFiles.set(ticket,event.data.files);
   // worker 中断时也释放页面里的大文件引用；网页上传组件已接收的 File 不受此缓存清理影响。
   const expiry=setTimeout(()=>{globalThis.__lumaBinaryFiles?.delete(ticket);globalThis.__lumaBinaryTimers?.delete(ticket);},60000);
   globalThis.__lumaBinaryTimers.set(ticket,expiry);
   finish({ok:true});
  };
  const timer=setTimeout(()=>finish({ok:false,error:'浏览器未完成二进制文件交接。'}),15000);
  window.addEventListener('message',receive);window.addEventListener('pagehide',unload);
  try{document.documentElement.append(frame);}catch{finish({ok:false,error:'无法建立本次文件交接，请重新带入。'});}
 });
}
// clearBinary 释放页面内本次任务的文件引用，不影响网页已经接收的 File。
export function clearBinary(ticket){
 clearTimeout(globalThis.__lumaBinaryTimers?.get(ticket));globalThis.__lumaBinaryTimers?.delete(ticket);
 globalThis.__lumaBinaryFiles?.delete(ticket);return {ok:true};
}
