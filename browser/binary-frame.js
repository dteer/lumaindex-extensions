import {binaryStore} from './binary-store.js';
// 只有后台授权的标签页能取走一次性文件集；授权失败时不触碰存储，避免其他页面销毁有效任务。
const ticket=location.hash.slice(1);
try{
 if(parent===window||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ticket))throw Error('文件交接地址无效');
 const result=await chrome.runtime.sendMessage({op:'claimBinary',ticket});
 if(!result?.ok)throw Error('文件交接授权已失效');
 // 已授权后原子取出并删除；即便后台随后退出，文件也不会长期留在 IndexedDB。
 const stored=await binaryStore('take',ticket);
 if(!stored||stored.expires<=Date.now())throw Error('文件交接已过期');
 parent.postMessage({type:'luma-binary',ticket,files:stored.files},'https://creator.douyin.com');
}catch{parent.postMessage({type:'luma-binary',ticket,error:'读取本次图片失败，请重新带入。'},'https://creator.douyin.com');}
