import assert from 'node:assert/strict';
globalThis.window={addEventListener(){}};
globalThis.location={href:'http://127.0.0.1:1234/api/v1/plugins/com.lumaindex.douyin/files/index.html'};
globalThis.document={createElement(){throw Error('query must not create/click navigation elements');}};
const timers=[];
globalThis.setInterval=()=>0;
globalThis.clearInterval=()=>{};
class Socket {
 static OPEN=1;
 constructor(){this.readyState=1;Socket.last=this;queueMicrotask(()=>this.onopen());}
 close(){this.readyState=3;this.onclose?.();}
 send(raw){const m=JSON.parse(raw);if(m.id)queueMicrotask(()=>this.onmessage({data:JSON.stringify({id:m.id,ok:true,data:{items:[],account:'1',nextCursor:null}})}));}
}
globalThis.WebSocket=Socket;
const {browserBridge}=await import('../app/browser-bridge.js');
const bridge=browserBridge('http://127.0.0.1:1234/api/v1');
await assert.rejects(bridge.queryCollections({}),/请按步骤操作/);
assert.match(bridge.connectionURL(),/relay.html#/);
const first=Socket.last;
await assert.rejects(bridge.queryCollections({}),/请按步骤操作/);
assert.equal(Socket.last,first);
first.onmessage({data:JSON.stringify({type:'ready'})});
assert.equal(bridge.connectionURL(),'');
assert.deepEqual((await bridge.queryCollections({})).items,[]);
first.close();
console.log('PASS disconnected queries never navigate, explicit pairing URL and connected retry');
