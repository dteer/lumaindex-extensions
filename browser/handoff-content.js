"use strict";
// 本机页面仅作为扩展接收入口，立即在同一标签页进入抖音，无需用户在入口页操作。
if(location.pathname==='/api/v1/plugins/com.lumaindex.douyin/files/handoff.html') {
  document.documentElement.dataset.lumaExtension='1';
  const status=document.getElementById('status');
  for(const element of document.body.children)element.hidden=true;
  if(status){status.hidden=false;status.textContent='正在进入抖音编辑页…';}
  try {
    const job=JSON.parse(decodeURIComponent(location.hash.slice(1)));
    chrome.runtime.sendMessage({op:'continue',job}).then(response=>{
      if(!response?.ok&&status)status.textContent=response?.error||'带入未完成，请从 App 重新打开。';
    }).catch(error=>{if(status)status.textContent=error.message;});
  }catch(error){if(status)status.textContent='交接数据无效，请从 App 重新打开。';}
}
