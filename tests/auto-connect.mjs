import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {browserBridge} from '../app/browser-bridge.js';

const original={setTimeout,clearTimeout,setInterval,clearInterval,location:globalThis.location,window:globalThis.window,document:globalThis.document,WebSocket:globalThis.WebSocket};
const cryptoDescriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
const timers=new Set(),intervals=new Set(),events=new Map();
Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
globalThis.location={href:'http://127.0.0.1:1234/api/v1/plugins/com.lumaindex.douyin/files/index.html'};
globalThis.window={addEventListener(name,callback){events.set(name,callback);}};
let opened=0;
globalThis.document={body:{append(){}},createElement(){return {click(){opened++;queueMicrotask(()=>Socket.all.at(-1).receive({type:'ready'}));},remove(){}};}};
globalThis.setTimeout=(fn,ms)=>{const timer={fn,ms};timers.add(timer);return timer;};
globalThis.clearTimeout=timer=>timers.delete(timer);
globalThis.setInterval=fn=>{intervals.add(fn);return fn;};
globalThis.clearInterval=fn=>intervals.delete(fn);

// Socket 模拟同一连接上的地点和合集响应，hold 游标留给取消与超时回归手动完成。
class Socket{
 static OPEN=1;static all=[];
 // constructor 异步发出连接成功事件，模拟调用方先注册监听的真实顺序。
 constructor(url){this.url=url;this.readyState=1;this.sent=[];Socket.all.push(this);queueMicrotask(()=>this.onopen());}
 // receive 以真实消息事件形状将响应回传给共享客户端。
 receive(value){this.onmessage({data:JSON.stringify(value)});}
 // send 记录业务参数并按请求类型生成独立结果，不为分页重新建立连接。
 send(raw){
  const data=JSON.parse(raw);this.sent.push(data);
  if(data.type==='location-search'&&data.params.keyword!=='hold')queueMicrotask(()=>this.receive({id:data.id,ok:true,data:{items:[{name:data.params.keyword}]}}));
  if(data.type!=='collection-list'||data.params.cursor==='hold')return;
  const response=data.params.cursor==='failure'?{ok:false,error:'账号已切换，请刷新合集'}
   :data.params.cursor==='missing-error'?{ok:false}
   :{ok:true,data:{account:'account-1',items:[{id:data.params.cursor==='10'?'mix-2':'mix-1',title:'旅行'}],nextCursor:data.params.cursor==='10'?null:'10'}};
  queueMicrotask(()=>this.receive({id:data.id,...response}));
 }
 // close 触发本地关闭事件，验证所有业务请求共同收敛到断开状态。
 close(){this.readyState=3;this.onclose?.();}
}
globalThis.WebSocket=Socket;
try{
 // 普通浏览器预览没有 App 上下文时仍能初始化，只有实际查询才给出打开指引。
 for(const baseURL of [undefined,'invalid-url','https://external.example/api/v1','http://user:password@127.0.0.1:1234/api/v1','http://127.0.0.1:1234/not-api']){
  const preview=browserBridge(baseURL);
  await assert.rejects(preview.queryCollections({kind:'image'}),/请从 App 打开插件/);
  await assert.rejects(preview.request({keyword:'西湖'}),/请从 App 打开插件/);
 }
 assert.equal(Socket.all.length,0);assert.equal(opened,0);
 const bridge=browserBridge('http://127.0.0.1:1234/api/v1');
 const collectionBridge=browserBridge('http://127.0.0.1:1234/api/v1/');
 assert.equal(collectionBridge,bridge);assert.equal(opened,0);
 // 首次查询只显示指引，用户完成配对后共用连接。
 await assert.rejects(bridge.request({keyword:'西湖'}),/请按步骤操作/);
 assert.equal(opened,0);
 Socket.all[0].receive({type:'ready'});
 const [result,collectionPage]=await Promise.all([
  bridge.request({keyword:'西湖'}),
  collectionBridge.queryCollections({kind:'image',cursor:'0'})
 ]);
 assert.equal(result.items[0].name,'西湖');assert.equal(opened,0);assert.equal(Socket.all.length,1);assert.equal(intervals.size,1);assert.equal(events.size,1);
 assert.deepEqual(collectionPage,{account:'account-1',items:[{id:'mix-1',title:'旅行'}],nextCursor:'10'});
 const next=await collectionBridge.queryCollections({kind:'video',cursor:collectionPage.nextCursor});
 assert.equal(next.items[0].id,'mix-2');assert.equal(next.nextCursor,null);
 assert.deepEqual(Socket.all[0].sent.at(-1).params,{kind:'video',cursor:'10'});
 await bridge.request({keyword:'故宫'});assert.equal(opened,0);
 await assert.rejects(collectionBridge.queryCollections({kind:'image',cursor:'failure'}),/账号已切换/);
 await assert.rejects(collectionBridge.queryCollections({kind:'image',cursor:'missing-error'}),/合集查询失败/);
 // 已取消或在途取消均不影响其他业务，晚到的合集响应不能恢复已取消请求。
 const preAborted=new AbortController();preAborted.abort();
 const sentBeforeAbort=Socket.all[0].sent.length;
 await assert.rejects(bridge.request({},preAborted.signal),{name:'AbortError'});
 await assert.rejects(collectionBridge.queryCollections({kind:'image'},preAborted.signal),{name:'AbortError'});
 assert.equal(Socket.all[0].sent.length,sentBeforeAbort);
 const abort=new AbortController();
 const cancelled=collectionBridge.queryCollections({kind:'image',cursor:'hold'},abort.signal);
 await new Promise(resolve=>setImmediate(resolve));
 const cancelledID=Socket.all[0].sent.at(-1).id;abort.abort();
 await assert.rejects(cancelled,{name:'AbortError'});assert.equal(timers.size,0);
 Socket.all[0].receive({id:cancelledID,ok:true,data:{items:[{id:'late'}]}});
 assert.equal((await bridge.request({keyword:'西湖'})).items[0].name,'西湖');
 // 合集需要前后核对账号，其 50 秒上限不能沿用地点的 18 秒时限。
 const timedOut=collectionBridge.queryCollections({kind:'image',cursor:'hold'});
 await new Promise(resolve=>setImmediate(resolve));
 const timer=[...timers][0];assert.equal(timer.ms,50000);timers.delete(timer);timer.fn();
 await assert.rejects(timedOut,/合集查询超时/);assert.equal(timers.size,0);
 const locationTimeout=bridge.request({keyword:'hold'});
 await new Promise(resolve=>setImmediate(resolve));
 const locationTimer=[...timers][0];assert.equal(locationTimer.ms,18000);timers.delete(locationTimer);locationTimer.fn();
 await assert.rejects(locationTimeout,/地点查询超时/);
 // 发送失败立即清理请求；之后的正常请求继续复用原有连接。
 const current=Socket.all[0],send=current.send;
 current.send=()=>{throw Error('internal transport details');};
 await assert.rejects(collectionBridge.queryCollections({kind:'image'}),/浏览器连接已断开/);
 assert.equal(timers.size,0);current.send=send;
 assert.equal((await bridge.request({keyword:'故宫'})).items[0].name,'故宫');
 // 扩展关闭连接时，合集请求得到相同的设置指引，下一次查询只重新配对一次。
 const disconnected=collectionBridge.queryCollections({kind:'image',cursor:'hold'});
 await new Promise(resolve=>setImmediate(resolve));
 current.receive({type:'connection-error',error:'连接已关闭'});
 await assert.rejects(disconnected,/连接已关闭/);assert.equal(current.readyState,3);assert.equal(timers.size,0);assert.equal(intervals.size,0);
 await assert.rejects(bridge.request({keyword:'重连'}),/请按步骤操作/);
 Socket.all[1].receive({type:'ready'});
 await Promise.all([bridge.request({keyword:'重连'}),collectionBridge.queryCollections({kind:'video',cursor:'0'})]);
 assert.equal(opened,0);assert.equal(Socket.all.length,2);assert.equal(intervals.size,1);
 const closedPage=collectionBridge.queryCollections({kind:'image',cursor:'hold'});
 await new Promise(resolve=>setImmediate(resolve));
 events.get('pagehide')();await assert.rejects(closedPage,/浏览器连接已断开/);
 assert.equal(Socket.all[1].readyState,3);assert.equal(intervals.size,0);assert.equal(timers.size,0);
 console.log('PASS shared lazy connection, location/collection pagination, cancellation, timeout, disable and reconnect');
}finally{
 Object.assign(globalThis,original);
 if(cryptoDescriptor)Object.defineProperty(globalThis,'crypto',cryptoDescriptor);else delete globalThis.crypto;
}
