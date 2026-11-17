// 浏览器后台拥有连接生命周期；交接页只提交一次地址，不保存 WebSocket。
export function createBackgroundBridge({storage,Socket,query,queryCollections,preferences=storage}){
 const key='luma-background-bridges',entries=new Map();
 // 两类只读查询使用同一通道和并发上限；具体参数校验与抖音请求由各自回调承担。
 const queries=new Map([
  ['location-search',{run:query,label:'地点'}],
  ['collection-list',{run:queryCollections,label:'合集'}]
 ]);
 let writes=Promise.resolve(),enabled=true;
 const preferenceReady=preferences.get('luma-connection-enabled').then(v=>{enabled=v['luma-connection-enabled']!==false;});
 const persist=()=>{
  const value=[...entries.values()].map(e=>({origin:e.origin,channel:e.channel}));
  writes=writes.catch(()=>{}).then(()=>storage.set({[key]:value}));
  return writes;
 };
 function stop(e){
  if(entries.get(e.origin)!==e)return;
  entries.delete(e.origin);e.resolve?.({ok:false,error:'连接已结束，请重新连接'});e.resolve=null;clearInterval(e.heartbeat);clearTimeout(e.retry);
  e.socket?.close();persist();
 }
 function open(e){
  if(entries.get(e.origin)!==e)return;
  const socket=new Socket(e.origin.replace(/^http:/,'ws:')+'/api/v1/plugins/com.lumaindex.douyin/bridge/'+e.channel+'/browser');
  e.socket=socket;
  socket.onopen=()=>{
   if(entries.get(e.origin)!==e){socket.close();return;}
   e.attempt=0;
   socket.send(JSON.stringify({type:'ready'}));
   e.resolve?.({ok:true});e.resolve=null;
   clearInterval(e.heartbeat);
   // Chrome 116 起 WebSocket 消息刷新后台活跃时间，20 秒心跳不依赖任何标签页。
   e.heartbeat=setInterval(()=>{if(socket.readyState===Socket.OPEN)socket.send(JSON.stringify({type:'ping'}));},20000);
  };
  socket.onmessage=async event=>{
   if(e.socket!==socket||entries.get(e.origin)!==e)return;
   let m;try{m=JSON.parse(event.data);}catch{return;}
   if(!m||typeof m!=='object')return;
   if(m.type==='ping'){socket.send(JSON.stringify({type:'pong'}));return;}
   const operation=queries.get(m.type);
   if(!operation||typeof m.id!=='string'||m.id.length>100||e.pending.has(m.id)||e.pending.size>=4)return;
   e.pending.add(m.id);
   try{
    const result=typeof operation.run==='function'
     ?await operation.run(m.params)
     :{ok:false,error:'当前 Chrome 扩展不支持'+operation.label+'查询，请更新扩展后重试。'};
    if(e.socket===socket&&socket.readyState===Socket.OPEN)socket.send(JSON.stringify({id:m.id,...result}));
   }catch(error){
    if(e.socket===socket&&socket.readyState===Socket.OPEN)socket.send(JSON.stringify({id:m.id,ok:false,error:error?.message||operation.label+'查询失败'}));
   }finally{e.pending.delete(m.id);}
  };
  socket.onclose=event=>{
   if(e.socket!==socket||entries.get(e.origin)!==e)return;
   clearInterval(e.heartbeat);
   if(event.code===4001){e.resolve?.({ok:false,error:'App 页面已关闭，请重新打开插件'});stop(e);return;}
   if(++e.attempt>8){e.resolve?.({ok:false,error:'无法连接 App，请重新连接'});stop(e);return;}
   e.retry=setTimeout(()=>open(e),Math.min(1000*e.attempt,5000));
  };
 }
 function add(origin,channel){
  const old=entries.get(origin);
  if(old?.channel===channel&&old.socket?.readyState===Socket.OPEN)return Promise.resolve({ok:true});
  if(old)stop(old);
  const e={origin,channel,attempt:0,pending:new Set()};
  entries.set(origin,e);persist();
  const promise=new Promise(resolve=>e.resolve=resolve);
  open(e);return promise;
 }
 const restored=preferenceReady.then(()=>storage.get(key)).then(data=>{
  if(!enabled)return;
  for(const item of (data[key]||[]).slice(0,8)){
   try{const u=new URL(item.origin);if(u.protocol!=='http:'||!['127.0.0.1','localhost'].includes(u.hostname)||u.origin!==item.origin||!/^[a-f0-9]{64}$/.test(item.channel))continue;}catch{continue;}
   add(item.origin,item.channel);
  }
 }).catch(()=>{});
 return {
  async connect(origin,channel){
   await restored;
   if(!enabled){
    // 回传禁用原因给本次查询，不保留连接或启动重连。
    const socket=new Socket(origin.replace(/^http:/,'ws:')+'/api/v1/plugins/com.lumaindex.douyin/bridge/'+channel+'/browser');
    const timer=setTimeout(()=>socket.close(),5000);
    socket.onopen=()=>{socket.send(JSON.stringify({type:'connection-error',error:'请先在 Chrome 扩展中开启“启用 App 连接”，然后重试查询。'}));clearTimeout(timer);socket.close();};
    return {ok:false,error:'App 连接已关闭，请在扩展配置中启用。'};
   }
   return add(origin,channel);
  },
  async isEnabled(){await restored;return enabled;},
  async setEnabled(value){
   await restored;enabled=value===true;await preferences.set({'luma-connection-enabled':enabled});
   if(!enabled){for(const e of [...entries.values()]){
    if(e.socket?.readyState===Socket.OPEN)e.socket.send(JSON.stringify({type:'connection-error',error:'Chrome 扩展已关闭 App 连接，请开启后重试查询。'}));
    stop(e);
   }await writes;}
  },
  // 配置页只读取公开状态，不暴露配对令牌；连接生命周期仍由后台持有。
  async status(){await restored;return [...entries.values()].map(e=>({origin:e.origin,state:e.socket?.readyState===Socket.OPEN?'connected':e.attempt?'reconnecting':'connecting'}));},
  // 用户主动断开时清除恢复记录，避免后台再次自动连接。
  async disconnect(origin){await restored;const e=entries.get(origin);if(e)stop(e);await writes;}
 };
}
