// 同一 App 页面内的地点和合集查询共享连接，避免两个模块重新配对时相互断开。
const clients=new Map();

// browserBridge 按本机服务地址复用客户端；查询不会自动打开 Chrome，配对入口由用户主动点击。
export function browserBridge(baseURL){
 // 预览页面可能没有宿主上下文，初始化保持可用，查询时再提示从 App 打开。
 let endpoint='';
 try{if(typeof baseURL==='string')endpoint=new URL(baseURL).href.replace(/\/+$/,'');}catch{}
 if(!clients.has(endpoint))clients.set(endpoint,createClient(endpoint));
 return clients.get(endpoint);
}

// createClient 统一管理查询、取消及连接生命周期，Chrome 后台负责维持配对通道。
function createClient(baseURL){
 let socket,heartbeat,connected=false,lastSeen=0,connecting=null,connectionError='',relayURL='';
 const pending=new Map();
 const connectionHelp='尚未连接 Chrome。请按步骤操作：① 打开 Chrome，安装或启用“有序图库发布工作台（实验版）”扩展，并开启“启用 App 连接”；② 点击下方“连接 Chrome”，完成连接并登录抖音创作者中心；③ 回到此处点击刷新或重试。';
 // 连接失效时逐一清除查询定时器和取消监听，调用方保留各自的已有结果。
 const rejectAll=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error(connectionError||'浏览器连接已断开，请重试查询'));}pending.clear();};
 // ensureConnected 合并并发建连，地点和合集不会分别打开交接页。
 function ensureConnected(){
  if(connected&&socket?.readyState===WebSocket.OPEN)return Promise.resolve();
  if(connecting)return connecting;
  if(socket?.readyState===WebSocket.OPEN)return Promise.reject(Error(connectionHelp));
  // 本机桥接仅允许宿主固定 API 根路径，不能因错误上下文向外部站点建立连接。
  try{
   const source=new URL(baseURL);
   if(source.protocol!=='http:'||!['127.0.0.1','localhost'].includes(source.hostname)||source.pathname!=='/api/v1'||source.username||source.password||source.search||source.hash)throw Error();
  }catch{return Promise.reject(Error('请从 App 打开插件后重试查询。'));}
  const attempt=new Promise((resolve,reject)=>{
   socket?.close();clearInterval(heartbeat);rejectAll();connected=false;connectionError='';
   const channel=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
   const base=new URL(baseURL+'/plugins/com.lumaindex.douyin.studio/bridge/'+channel+'/');
   base.protocol=base.protocol==='https:'?'wss:':'ws:';
   const current=new WebSocket(base.href+'app');socket=current;
   const timeout=setTimeout(()=>{connectionError='连接 Chrome 超时，请确认 Chrome 已打开、扩展已启用且“启用 App 连接”已开启，然后重试。';reject(Error(connectionError));current.close();},12000);
   current.onopen=()=>{
    // 只准备配对入口，不在查询过程中抢焦点或打开浏览器。
    const relay=new URL('relay.html',location.href);relay.hash=channel;relayURL=relay.href;
    clearTimeout(timeout);reject(Error(connectionHelp));
   };
   current.onmessage=e=>{
    if(socket!==current)return;
    let m;try{m=JSON.parse(e.data);}catch{return;}
    if(!m||typeof m!=='object')return;
    lastSeen=Date.now();
    if(m.type==='connection-error'){connectionError=m.error;clearTimeout(timeout);reject(Error(connectionError));connected=false;rejectAll();current.close();return;}
    if(m.type==='ping')current.send(JSON.stringify({type:'pong'}));
    if(['ready','ping','pong'].includes(m.type)){connected=true;clearTimeout(timeout);resolve();return;}
    const p=pending.get(m.id);if(!p)return;clearTimeout(p.timer);pending.delete(m.id);
    m.ok?p.resolve(m.data):p.reject(Error(m.error||p.error));
   };
   current.onclose=()=>{clearTimeout(timeout);if(socket!==current)return;connected=false;clearInterval(heartbeat);rejectAll();reject(Error(connectionError||'无法连接 Chrome，请确认扩展已启用后重试查询。'));};
   heartbeat=setInterval(()=>{
    if(current.readyState===WebSocket.OPEN)current.send(JSON.stringify({type:'ping'}));
    if(connected&&Date.now()-lastSeen>45000){connected=false;rejectAll();current.close();}
   },20000);
  });
  connecting=attempt.finally(()=>{connecting=null;});return connecting;
 }
 window.addEventListener('pagehide',()=>{clearInterval(heartbeat);socket?.close();rejectAll();});
 // sendRequest 复用同一请求表，通过消息类型区分业务并分别返回超时或失败原因。
 async function sendRequest(type,label,params,signal,timeoutMs=18000){
   if(signal?.aborted)throw new DOMException('已取消','AbortError');
   await ensureConnected();
   return new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();
    const finish=(fn,value)=>{signal?.removeEventListener('abort',abort);fn(value);};
    const abort=()=>{const p=pending.get(id);if(p){clearTimeout(p.timer);pending.delete(id);finish(reject,new DOMException('已取消','AbortError'));}};
    if(signal?.aborted){reject(new DOMException('已取消','AbortError'));return;}
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{pending.delete(id);finish(reject,Error(label+'查询超时，请重试'));},timeoutMs);
    pending.set(id,{resolve:v=>finish(resolve,v),reject:e=>finish(reject,e),timer,error:label+'查询失败'});
    try{socket.send(JSON.stringify({id,type,params}));}
    catch{clearTimeout(timer);pending.delete(id);finish(reject,Error('浏览器连接已断开，请重试查询'));}
   });
 }
 return {
  // connectionURL 仅供用户点击的连接入口；读取不会触发导航。
  connectionURL(){return connected?'':relayURL;},
  // request 保持地点查询的既有接口，成功时直接返回 data。
  request(params,signal){return sendRequest('studio-location-search','地点',params,signal);},
  // queryCollections 查询当前抖音账号的一页合集；50 秒时限容纳后台查询前后的账号核对。
  queryCollections(params,signal){return sendRequest('studio-collection-list','合集',params,signal,50000);}
 };
}
