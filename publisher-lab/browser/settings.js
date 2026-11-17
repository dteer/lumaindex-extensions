const list=document.querySelector('#connections'),error=document.querySelector('#error'),refresh=document.querySelector('#refresh');
const enabled=document.querySelector('#enabled');
let busy=false;
// 状态读取不创建连接；关闭弹窗或配置页不会改变后台连接。
async function update(op='studio-bridge-status',origin){
 if(busy)return;
 busy=true;refresh.disabled=true;
 try{
  const result=await chrome.runtime.sendMessage({op,origin,enabled:enabled.checked});
  if(!result?.ok)throw Error(result?.error||'暂时无法读取状态，请刷新重试');
  error.textContent='';enabled.checked=result.enabled;list.replaceChildren();
  if(!result.connections.length){const empty=document.createElement('p');empty.textContent=result.enabled?'请在 App 的实验工作台点击“连接浏览器”':'App 连接已关闭';list.append(empty);}
  for(const connection of result.connections){
   const row=document.createElement('div');row.className='connection';
   const status=document.createElement('div');status.className='status '+connection.state;status.textContent={connected:'● 已连接',connecting:'● 正在连接',reconnecting:'● 正在重连'}[connection.state]||'未连接';
   const address=document.createElement('div');address.className='address';address.textContent=connection.origin;
   const disconnect=document.createElement('button');disconnect.className='disconnect';disconnect.textContent='断开连接';
   // 点击后禁用当前按钮，避免重复提交；失败保留当前连接信息。
   disconnect.onclick=async()=>{disconnect.disabled=true;await update('studio-bridge-disconnect',connection.origin);disconnect.disabled=false;};
   row.append(status,address,disconnect);list.append(row);
  }
 }catch(e){error.textContent=e.message||'暂时无法读取状态，请刷新重试';}
 finally{busy=false;refresh.disabled=false;}
}
enabled.onchange=()=>update('studio-bridge-enable');
refresh.onclick=()=>update();
update();
// 只在配置界面可见时更新展示，不承担心跳或连接恢复职责。
setInterval(()=>{if(!document.hidden)update();},2000);
