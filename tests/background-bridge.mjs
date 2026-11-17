import assert from 'node:assert/strict';
import {createBackgroundBridge} from '../browser/background-bridge.js';
const timers=[],intervals=[];
const original={setTimeout,clearTimeout,setInterval,clearInterval};
globalThis.setTimeout=fn=>{timers.push(fn);return fn};
globalThis.clearTimeout=()=>{};
globalThis.setInterval=fn=>{intervals.push(fn);return fn};
globalThis.clearInterval=()=>{};
class Socket {
 static OPEN=1;
 static all=[];
 constructor(url){this.url=url;this.readyState=0;this.sent=[];Socket.all.push(this)}
 open(){this.readyState=1;this.onopen()}
 send(value){this.sent.push(JSON.parse(value))}
 close(){this.readyState=3;this.onclose?.({code:1000})}
}
const data={};
const storage={get:async key=>({[key]:data[key]}),set:async value=>Object.assign(data,structuredClone(value))};
try{
 const queried=[],collections=[],held=new Map();
 // 两种业务回调均可暂停，验证共享通道的去重与并发限制。
 const bridge=createBackgroundBridge({storage,Socket,query:async params=>{
  queried.push(params);
  if(params.keyword==='hold')return new Promise(resolve=>held.set('location',resolve));
  return {ok:true,data:params};
 },queryCollections:async params=>{
  collections.push(params);
  if(params.cursor?.startsWith('hold'))return new Promise(resolve=>held.set(params.cursor,resolve));
  if(params.cursor==='failure')throw Error('合集读取失败，请稍后重试');
  if(params.cursor==='unknown-failure')throw null;
  return {ok:true,data:{account:'account-1',items:[{id:params.cursor==='10'?'mix-2':'mix-1',title:'旅行',order:0}],nextCursor:params.cursor==='10'?null:'10'}};
 }});
 const pending=bridge.connect('http://127.0.0.1:1234','a'.repeat(64));
 await new Promise(resolve=>setImmediate(resolve));
 const first=Socket.all.at(-1);first.open();assert.equal((await pending).ok,true);
 assert.deepEqual(await bridge.status(),[{origin:'http://127.0.0.1:1234',state:'connected'}]);
 // 无页面生命周期输入，连接由后台独立持有，心跳与查询继续工作。
 intervals.at(-1)();assert.equal(first.sent.at(-1).type,'ping');
 await first.onmessage({data:JSON.stringify({id:'one',type:'location-search',params:{keyword:'西湖'}})});
 assert.equal(first.sent.at(-1).data.keyword,'西湖');
 // 合集首尾两页与当前账号原样回传，不占用地点查询的参数或响应契约。
 await first.onmessage({data:JSON.stringify({id:'collections-1',type:'collection-list',params:{kind:'image',cursor:'0'}})});
 assert.deepEqual(first.sent.at(-1),{id:'collections-1',ok:true,data:{account:'account-1',items:[{id:'mix-1',title:'旅行',order:0}],nextCursor:'10'}});
 await first.onmessage({data:JSON.stringify({id:'collections-2',type:'collection-list',params:{kind:'video',cursor:'10'}})});
 assert.equal(first.sent.at(-1).data.nextCursor,null);
 assert.deepEqual(collections,[{kind:'image',cursor:'0'},{kind:'video',cursor:'10'}]);
 assert.deepEqual(queried,[{keyword:'西湖'}]);
 const messagesBeforeInvalid=first.sent.length;
 await first.onmessage({data:JSON.stringify({id:'invalid',type:'unregistered-operation',params:{}})});
 await first.onmessage({data:'null'});
 await first.onmessage({data:JSON.stringify({id:5,type:'collection-list',params:{}})});
 assert.equal(first.sent.length,messagesBeforeInvalid);
 await first.onmessage({data:JSON.stringify({id:'collections-failure',type:'collection-list',params:{cursor:'failure'}})});
 assert.deepEqual(first.sent.at(-1),{id:'collections-failure',ok:false,error:'合集读取失败，请稍后重试'});
 await first.onmessage({data:JSON.stringify({id:'collections-unknown-failure',type:'collection-list',params:{cursor:'unknown-failure'}})});
 assert.equal(first.sent.at(-1).error,'合集查询失败');
 // 四个在途请求跨业务共享上限，同一 ID 不能跨类型重复执行。
 const inflight=[
  first.onmessage({data:JSON.stringify({id:'held-1',type:'collection-list',params:{cursor:'hold-1'}})}),
  first.onmessage({data:JSON.stringify({id:'held-2',type:'location-search',params:{keyword:'hold'}})}),
  first.onmessage({data:JSON.stringify({id:'held-3',type:'collection-list',params:{cursor:'hold-3'}})}),
  first.onmessage({data:JSON.stringify({id:'held-4',type:'collection-list',params:{cursor:'hold-4'}})})
 ];
 const collectionCount=collections.length,queryCount=queried.length;
 await first.onmessage({data:JSON.stringify({id:'held-1',type:'location-search',params:{keyword:'duplicate'}})});
 await first.onmessage({data:JSON.stringify({id:'held-5',type:'collection-list',params:{cursor:'10'}})});
 assert.equal(collections.length,collectionCount);assert.equal(queried.length,queryCount);
 for(const resolve of held.values())resolve({ok:true,data:{items:[]}});
 await Promise.all(inflight);held.clear();
 await first.onmessage({data:JSON.stringify({id:'held-5',type:'collection-list',params:{cursor:'10'}})});
 assert.equal(first.sent.at(-1).id,'held-5');
 // 重连前发起的晚到响应不得写入旧连接或新的连接。
 const stale=first.onmessage({data:JSON.stringify({id:'stale',type:'collection-list',params:{cursor:'hold-stale'}})});
 first.close();assert.equal((await bridge.status())[0].state,'reconnecting');assert.equal(timers.length,1);timers.shift()();
 const second=Socket.all.at(-1);second.open();assert.notEqual(second,first);
 assert.equal(second.sent[0].type,'ready');
 const oldMessageCount=first.sent.length;
 held.get('hold-stale')({ok:true,data:{items:[]}});await stale;
 assert.equal(first.sent.length,oldMessageCount);assert.equal(second.sent.length,1);
 await second.onmessage({data:JSON.stringify({id:'reconnected',type:'collection-list',params:{kind:'image',cursor:'10'}})});
 assert.equal(second.sent.at(-1).data.account,'account-1');
 await new Promise(resolve=>setImmediate(resolve));
 const restoredData=structuredClone(data);
 second.onclose({code:4001});await new Promise(resolve=>setImmediate(resolve));assert.equal(data['luma-background-bridges'].length,0);
 // 模拟后台重启：从 session storage 重新建立已配对通道。
 const restarted=createBackgroundBridge({storage:{get:async()=>restoredData,set:async()=>{}},Socket,query:async()=>({ok:true})});
 await new Promise(resolve=>setImmediate(resolve));
 const third=Socket.all.at(-1);third.open();assert.equal(third.url,first.url);
 // 旧调用方未传合集回调时给出明确原因，同时保留地点接口兼容。
 await third.onmessage({data:JSON.stringify({id:'unsupported',type:'collection-list',params:{kind:'image'}})});
 assert.equal(third.sent.at(-1).ok,false);assert.match(third.sent.at(-1).error,/不支持合集查询/);
 await third.onmessage({data:JSON.stringify({id:'compatible',type:'location-search',params:{keyword:'西湖'}})});
 assert.equal(third.sent.at(-1).ok,true);
 await restarted.disconnect('http://127.0.0.1:1234');assert.deepEqual(await restarted.status(),[]);assert.equal(third.readyState,3);
 await restarted.setEnabled(false);assert.equal(await restarted.isEnabled(),false);
 const denied=await restarted.connect('http://127.0.0.1:1234','b'.repeat(64));assert.equal(denied.ok,false);
 const disabledSocket=Socket.all.at(-1);disabledSocket.open();assert.equal(disabledSocket.sent[0].type,'connection-error');assert.deepEqual(await restarted.status(),[]);
 await restarted.setEnabled(true);assert.equal(await restarted.isEnabled(),true);
 console.log('PASS shared location/collection routing, pagination, concurrency, reconnect, worker restore and owner shutdown');
}finally{Object.assign(globalThis,original);}
