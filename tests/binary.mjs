import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {binaryStore} from '../browser/binary-store.js';
import {receiveBinary,clearBinary} from '../browser/binary-bridge.js';

// 模拟 IndexedDB 的事务排队、异步请求和回滚，以验证 take 不会先返回文件后才删除。
function makeDatabase(){
 const records=new Map(),queue=[];let running=false,failDelete=false,closed=0;
 const run=()=>{if(running||!queue.length)return;running=true;queue.shift()();};
 const database={
  close(){closed++;},
  transaction(){
   const tx={error:null},requests=[];let work,pending=0,ready=false,ended=false,completion;
   const schedule=()=>{
    clearImmediate(completion);
    if(!pending&&ready&&!ended)completion=setImmediate(()=>{ended=true;records.clear();for(const [key,value] of work)records.set(key,value);tx.oncomplete?.();running=false;run();});
   };
   const issue=action=>{
    const request={};pending++;
    const perform=()=>setImmediate(()=>{
     if(ended)return;
     try{request.result=action();request.onsuccess?.();pending--;schedule();}
     catch(error){ended=true;tx.error=error;tx.onabort?.();running=false;run();}
    });
    if(ready)perform();else requests.push(perform);
    return request;
   };
   const store={
    get:key=>issue(()=>structuredClone(work.get(key))),
    put:(value,key)=>issue(()=>work.set(key,structuredClone(value))),
    delete:key=>issue(()=>{if(failDelete){failDelete=false;throw Error('simulated abort');}work.delete(key);}),
    openCursor(){
     let keys,index=0,request;
     const advance=()=>{
      if(!keys)keys=[...work.keys()];
      if(index===keys.length)return null;
      const key=keys[index++];
      return {value:structuredClone(work.get(key)),delete:()=>store.delete(key),continue(){
       const next=issue(advance);next.onsuccess=()=>{request.result=next.result;request.onsuccess?.();};
      }};
     };
     request=issue(advance);return request;
    }
   };
   tx.objectStore=()=>store;
   queue.push(()=>{work=new Map(records);ready=true;for(const start of requests)start();schedule();});
   setImmediate(run);return tx;
  }
 };
 return {records,get closed(){return closed;},abortNextDelete(){failDelete=true;},open(){const request={};setImmediate(()=>{request.result=database;request.onsuccess?.();});return request;}};
}
const database=makeDatabase();globalThis.indexedDB=database;
const file=new File(['image bytes'],'photo.jpg',{type:'image/jpeg'});
const valid={files:[file],expires:Date.now()+60000};
database.records.set('expired',{files:[file],expires:Date.now()-1});
database.records.set('invalid',{files:[file]});
await binaryStore('put','active',valid);
assert.deepEqual([...database.records.keys()],['active'],'new transfer prunes only invalid/expired records');
const [first,second]=await Promise.all([binaryStore('take','active'),binaryStore('take','active')]);
assert.equal(first.files.length,1);assert.equal(second,undefined,'same ticket is consumed only once');
await binaryStore('put','rollback',valid);database.abortNextDelete();
await assert.rejects(binaryStore('take','rollback'),/simulated abort/);
assert.ok(database.records.has('rollback'),'aborted consume keeps the record and does not return files');
database.records.set('old',{files:[file],expires:Date.now()-1});
assert.equal(await binaryStore('take','old'),undefined);assert.equal(database.records.has('old'),false);
await binaryStore('prune');assert.ok(database.records.has('rollback'),'prune preserves other live transfers');
await binaryStore('delete','rollback');assert.equal(database.records.size,0);assert.equal(database.closed,8);
await assert.rejects(binaryStore('put','bad',{files:[file],expires:0}),/过期/);
await assert.rejects(binaryStore('typo','active'),/未知/);

// 模拟网页消息与定时器；错误来源、窗口或 ticket 不能写入页面文件缓存。
const realSetTimeout=globalThis.setTimeout,realClearTimeout=globalThis.clearTimeout;
let timers,listeners,frame,appendFails;
function browser(){
 timers=new Map();listeners=new Map();frame=null;appendFails=false;let sequence=0;
 globalThis.setTimeout=(run,ms)=>{timers.set(++sequence,{run,ms});return sequence;};
 globalThis.clearTimeout=id=>timers.delete(id);
 globalThis.window={addEventListener:(type,run)=>listeners.set(type,run),removeEventListener:(type,run)=>{if(listeners.get(type)===run)listeners.delete(type);}};
 globalThis.document={createElement(){frame={contentWindow:{},removed:false,remove(){this.removed=true;}};return frame;},documentElement:{append(){if(appendFails)throw Error('detached');}}};
}
const url='chrome-extension://ljpbhfcmnhmeeighohcogpljbnaegggl/binary-frame.html';
const ticket='12345678-1234-1234-1234-123456789012',origin='chrome-extension://ljpbhfcmnhmeeighohcogpljbnaegggl';
function message(overrides={}){listeners.get('message')?.({source:frame.contentWindow,origin,data:{type:'luma-binary',ticket,files:[file]},...overrides});}
browser();let result=receiveBinary(url,ticket);
message({origin:'https://creator.douyin.com'});message({source:{}});message({data:{type:'luma-binary',ticket:'wrong',files:[file]}});
assert.equal(globalThis.__lumaBinaryFiles?.has(ticket)||false,false);assert.equal(frame.removed,false);
message();assert.deepEqual(await result,{ok:true});assert.equal(globalThis.__lumaBinaryFiles.get(ticket)[0],file);
assert.equal(listeners.size,0);assert.equal(frame.removed,true);
assert.equal([...timers.values()][0].ms,60000);
[...timers.values()][0].run();assert.equal(globalThis.__lumaBinaryFiles.has(ticket),false,'orphaned page files expire');
browser();result=receiveBinary(url,ticket);message();await result;clearBinary(ticket);
assert.equal(timers.size,0);assert.equal(globalThis.__lumaBinaryFiles.has(ticket),false);
browser();result=receiveBinary(url,ticket);message({data:{type:'luma-binary',ticket,files:[{}]}});
assert.equal((await result).ok,false);assert.equal(listeners.size,0);assert.equal(timers.size,0);
browser();result=receiveBinary(url,ticket);listeners.get('pagehide')();assert.equal((await result).ok,false);assert.equal(frame.removed,true);
browser();result=receiveBinary(url,ticket);[...timers.values()][0].run();assert.equal((await result).ok,false);assert.equal(listeners.size,0);
browser();appendFails=true;assert.equal((await receiveBinary(url,ticket)).ok,false);assert.equal(timers.size,0);
assert.equal((await receiveBinary('https://example.com/binary-frame.html',ticket)).ok,false);
globalThis.setTimeout=realSetTimeout;globalThis.clearTimeout=realClearTimeout;

// 加载真实 frame 代码，只替换存储导入，验证后台授权在读取之前且始终固定接收站点。
const source=(await readFile(new URL('../browser/binary-frame.js',import.meta.url),'utf8')).replace("import {binaryStore} from './binary-store.js';","const binaryStore=globalThis.frameStore;");
let attempt=0;
async function runFrame(authorized,stored){
 const calls=[];globalThis.location={hash:'#'+ticket};globalThis.window={};
 globalThis.chrome={runtime:{async sendMessage(message){calls.push(['claim',message]);return {ok:authorized};}}};
 globalThis.frameStore=async(...args)=>{calls.push(['store',...args]);return stored;};
 globalThis.parent={postMessage(...args){calls.push(['post',...args]);}};
 await import('data:text/javascript;base64,'+Buffer.from(source+'\n// '+attempt++).toString('base64'));
 return calls;
}
let calls=await runFrame(false,valid);
assert.deepEqual(calls.map(x=>x[0]),['claim','post']);assert.ok(calls[1][1].error);
calls=await runFrame(true,valid);assert.deepEqual(calls.map(x=>x[0]),['claim','store','post']);
assert.deepEqual(calls[1],['store','take',ticket]);assert.equal(calls[2][2],'https://creator.douyin.com');assert.equal(calls[2][1].files,valid.files);
calls=await runFrame(true,undefined);assert.ok(calls[2][1].error);
console.log('PASS binary authorization ordering, atomic consume/rollback, expiry cleanup, source validation and bridge teardown');
