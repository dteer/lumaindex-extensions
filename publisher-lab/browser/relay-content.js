// 连接页仅向后台提交一次配对信息；关闭页面不撤销后台连接。
if(location.pathname==='/api/v1/plugins/com.lumaindex.douyin.studio/files/relay.html'&&['127.0.0.1','localhost'].includes(location.hostname)&&location.protocol==='http:'){
 const status=document.getElementById('status'),channel=location.hash.slice(1);
 if(!/^[a-f0-9]{64}$/.test(channel))status.textContent='连接地址无效，请从 App 重新连接。';
 else chrome.runtime.sendMessage({op:'studio-connect-background',channel}).then(result=>{
  status.textContent=result?.ok?'实验版浏览器已连接，请回到 App 的抖音发布工作台。':result?.error||'连接未成功，请从 App 重试。';
  if(result?.ok)chrome.runtime.sendMessage({op:'studio-close-relay'}).catch(()=>{});
 }).catch(()=>status.textContent='扩展不可用，请启用或重新加载扩展后重试。');
}
