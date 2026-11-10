// 仅监听编辑区变化；由后台重新读取真实图片组件，不从页面消息接受资源映射。
(()=>{
 if(globalThis.__lumaImageObserver)return;
 globalThis.__lumaImageObserver=true;
 let timer;
 // 合并一次操作触发的多次 DOM 更新，避免逐个节点唤醒后台。
 const schedule=()=>{clearTimeout(timer);timer=setTimeout(()=>chrome.runtime.sendMessage({op:'observeImages'}).catch(()=>{}),350);};
 const relevant=node=>node instanceof Element&&(node.matches('[class^="img-"]')||node.closest('[class^="img-"]')||node.querySelector('[class^="img-"]'));
 const observer=new MutationObserver(records=>{
  if(records.some(r=>relevant(r.target)||[...r.addedNodes,...r.removedNodes].some(relevant)))schedule();
 });
 observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src','style']});
 document.addEventListener('change',schedule,true);
 document.addEventListener('drop',schedule,true);
 schedule();
})();
