import assert from 'node:assert/strict';
import {binaryStore} from '../browser/binary-store.js';

// 仅模拟 IndexedDB 请求/游标完成时序；原子回滚和真实 File 交接分别由 binary.mjs、浏览器实测覆盖。
const binaryData=new Map();
globalThis.indexedDB={open(){
 const request={};queueMicrotask(()=>{
  request.result={close(){},transaction(){
   const tx={};let pending=0,completion;
   const issue=action=>{
    clearImmediate(completion);pending++;const result={};
    queueMicrotask(()=>{result.result=action();result.onsuccess?.();pending--;if(!pending)completion=setImmediate(()=>tx.oncomplete?.());});
    return result;
   };
   const store={
    get:key=>issue(()=>binaryData.get(key)),
    put:(value,key)=>issue(()=>binaryData.set(key,value)),
    delete:key=>issue(()=>binaryData.delete(key)),
    openCursor(){
     const keys=[...binaryData.keys()];let offset=0,request;
     const advance=()=>{
      if(offset===keys.length)return null;
      const key=keys[offset++];
      return {value:binaryData.get(key),delete:()=>store.delete(key),continue(){const next=issue(advance);next.onsuccess=()=>{request.result=next.result;request.onsuccess?.();};}};
     };
     request=issue(advance);return request;
    },
   };
   tx.objectStore=()=>store;return tx;
  }};
  request.onsuccess();
 });return request;
}};

let listener,sequence=0,page;
const local={},session={},calls=[],reads=[],marked=new Map(),binaryFiles=new Map(),registered=new WeakMap();
const storage=values=>({
 async get(key){return structuredClone(key===null?values:{[key]:values[key]});},
 async set(value){Object.assign(values,structuredClone(value));},
});
const url='https://creator.douyin.com/creator-micro/content/post/image';
const ok=result=>[{result:{ok:true,...result}}];
const failure=error=>[{result:{ok:false,retryable:false,error}}];
const snapshot=()=>page.images.map((image,index)=>({id:image.id,index,name:image.file?.name||'',size:image.file?.size||0,uri:image.uri,ready:image.ready,localPreviewLoaded:true,...registered.get(image.file)}));
// 页面替身保留 File 对象和注册身份，模拟新增、删除、排序及传输完成，绝不按文件名代替素材ID。
function upload(files,append){
 assert.equal(page.preview?.visible,true,'local preview must be shown before native upload');
 const incoming=files.map(metadata=>{
  const file=binaryFiles.get(metadata.ticket)?.[metadata.binaryIndex];
  assert.ok(file,'upload must consume a bridged File');
  assert.equal(registered.get(file)?.assetID,metadata.assetID,'upload must register identity before delivery');
  const serial=++sequence;
  return {id:'card-'+serial,file,uri:'server-'+metadata.assetID+'-'+serial,ready:true};
 });
 if(append)page.images.push(...incoming);else {
  assert.equal(page.images.length,0,'initial upload must not overwrite restored images');
  if(page.deferNative)page.pendingNative=incoming;else page.images=incoming;
 }
 page.uploads.push(files.map(x=>x.assetID));
}
function request(message,sender){return new Promise(resolve=>listener(message,sender,resolve));}
globalThis.chrome={
 runtime:{id:'test',getURL:path=>'chrome-extension://test/'+path,onMessage:{addListener(fn){listener=fn;}}},
 tabs:{get:async id=>({id,status:'complete',url}),update:async(id,value)=>calls.push(['navigate',id,value]),remove:async id=>calls.push(['close',id]),query:async()=>{throw Error('unrelated tab lookup');}},
 storage:{session:storage(session),local:storage(local)},
 scripting:{async executeScript({target,func,args=[]}){
  if(!func)return ok();
  calls.push([func.name,target.tabId,args]);
  if(func.name==='markLinkedDraft'){
   if(args[1])return marked.get(target.tabId)===args[0]?ok():failure('draft association changed');
   marked.set(target.tabId,args[0]);return ok();
  }
  if(func.name==='receiveBinary'){
   const [frameURL,ticket]=args;
   const claim=await request({op:'claimBinary',ticket},{id:'test',frameId:1,url:frameURL+'#'+ticket,tab:{id:target.tabId,url}});
   assert.equal(claim.ok,true,'binary frame must receive one-time authorization');
   const value=await binaryStore('take',ticket);assert.ok(value?.files);
   binaryFiles.set(ticket,value.files);return ok();
  }
  if(func.name==='clearBinary'){binaryFiles.delete(args[0]);return ok();}
  if(func.name==='localPreview'){
   const [op,payload={}]=args;
   if(op==='show'){
    for(const file of payload.files)assert.ok(binaryFiles.get(file.ticket)?.[file.binaryIndex],'local panel uses already received binary files');
    page.preview={visible:true,count:payload.files.length,loaded:payload.files.length,firstPreviewMs:5,items:payload.files.map(({assetID,revision})=>({assetID,revision}))};
   }else if(op==='update'){
    if(!page.preview)return ok({visible:false});
    const nativeCount=payload.images?.length||0;
    page.previewUpdates.push({nativeCount,visible:page.preview.visible,phase:payload.phase});
    if(page.preview.items.every(item=>payload.images?.some(image=>image.assetID===item.assetID&&image.revision===item.revision&&image.localPreviewLoaded)))page.preview.visible=false;
   }else throw Error('unexpected local preview operation '+op);
   return ok(page.preview);
  }
  if(func.name==='deliverImages'){upload(args[0],false);return ok();}
  if(func.name==='fillText'){
   page.textCalls++;
   if(page.failFinalText&&page.textCalls===2)return failure('模拟最终文案填写失败');
   return ok();
  }
  if(func.name==='imageSync'){
   const [op,payload={}]=args;
   if(op==='snapshot'&&page.pendingNative){
    if(page.nativeSnapshotWait>0){page.nativeSnapshotWait--;page.zeroNativeSamples++;}
    else {page.images=page.pendingNative;page.pendingNative=null;}
   }
   if(op==='register'){
    for(const metadata of payload.files){
     const file=binaryFiles.get(metadata.ticket)?.[metadata.binaryIndex];assert.ok(file);
     registered.set(file,{assetID:metadata.assetID,revision:metadata.revision});
    }
   }else if(op==='append'){
    assert.deepEqual(snapshot().map(x=>x.id),payload.expectedIDs,'append checks the final page snapshot');
    upload(payload.files,true);
   }else if(op==='remove'){
    assert.ok(Array.isArray(payload.targets),'worker must delete by exact card targets');
    for(const target of payload.targets){
     const matches=page.images.filter(x=>x.id===target.id&&(!target.uri||x.uri===target.uri));
     assert.equal(matches.length,1,'delete must uniquely identify a current card');
     page.images.splice(page.images.indexOf(matches[0]),1);page.removed.push(target);
    }
   }else if(op==='order'){
    assert.equal(payload.uris.length,page.images.length);
    page.images=payload.uris.map(uri=>{const matches=page.images.filter(x=>x.uri===uri);assert.equal(matches.length,1);return matches[0];});
   }else if(op==='local'||op==='verify'){
    if(page.images.length!==payload.expected)return failure('incorrect image count');
    if(op==='verify'&&page.images.some(x=>!x.ready))return failure('server not ready');
   }else if(op==='timing')return ok({timeline:[]});
   else assert.ok(['snapshot','startTiming'].includes(op),'unexpected image operation '+op);
   return ok({images:snapshot(),...(op==='snapshot'?{documentID:'test-page',batchFailed:false}:{})});
  }
  return ok({multiple:true});
 }},
};
const revision=JSON.stringify([4,'today',null]);
let restoreDuringRead;
globalThis.fetch=async address=>{
 const path=new URL(address).pathname,assetID=path.split('/')[4];
 if(path.endsWith('/original')){
  reads.push(assetID);
  if(restoreDuringRead){const restore=restoreDuringRead;restoreDuringRead=null;restore();}
  return new Response(new Uint8Array([255,216,255,1]));
 }
 return Response.json({code:0,data:{name:assetID+'.jpg',sizeBytes:4,modifiedAt:'today'}});
};
await import('../browser/worker.js');
const sender=id=>({id:'test',frameId:0,tab:{id},url:'http://127.0.0.1:58717/api/v1/plugins/com.lumaindex.douyin/files/handoff.html'});
const job=(draftKey,id,ids=['a','b'])=>({version:1,id,draftKey,kind:'image',title:'test',description:'test',assets:ids.map(id=>({id,name:id+'.jpg'}))});
const run=(job,id)=>request({op:'continue',job},sender(id));
const fresh=()=>{page={images:[],uploads:[],removed:[],textCalls:0,previewUpdates:[],zeroNativeSamples:0};return page;};
const browserImage=(name,{uri='browser-'+name,ready=true}={})=>({id:'browser-card-'+(++sequence),file:new File([new Uint8Array([255,216,255,1])],name+'.jpg'),uri,ready});

fresh();
assert.equal((await run(job('simple','one'),77)).ok,true);
const originalA=page.images[0].uri;
// 旧草稿额外图片和未获 URI 的失败项都必须移除；不能先等失败项上传成功。
page.images.push(browserImage('stale'),browserImage('failed',{uri:'',ready:false}));
assert.equal((await run(job('simple','two',['a']),88)).ok,true);
assert.deepEqual(page.uploads,[['a','b']]);
assert.deepEqual(page.images.map(x=>x.uri),[originalA]);
assert.ok(page.removed.some(x=>!x.uri),'failed card without URI is deleted by its card ID');
assert.ok(calls.some(c=>c[0]==='close'&&c[1]===88));
assert.equal((await run(job('simple','three',['a']),99)).ok,true);
assert.deepEqual(page.uploads,[['a','b']]);
assert.deepEqual(page.images.map(x=>x.uri),[originalA]);
assert.equal(binaryData.size,0);assert.equal(binaryFiles.size,0);
console.log('PASS 2-to-1 sync and repeated import reuse resources while deleting restored/failed cards');

fresh();page.failFinalText=true;
const failed=await run(job('text-failure','text-one'),100);
assert.equal(failed.ok,false);assert.match(failed.error,/最终文案/);
assert.equal(local['images:draft:text-failure'].assets.length,2,'ready URI mappings checkpoint before final text');
const uris=page.images.map(x=>x.uri),readsBeforeRetry=reads.length;
page.failFinalText=false;
assert.equal((await run(job('text-failure','text-two'),101)).ok,true);
assert.deepEqual(page.uploads,[['a','b']]);
assert.deepEqual(page.images.map(x=>x.uri),uris);
assert.equal(reads.length,readsBeforeRetry,'retry must not read already uploaded files');
console.log('PASS successful uploads survive final text failure and retry without re-reading/reupload');

// 模拟准备文件时才恢复旧草稿：重新规划保留 a，只追加 b，并清理无 URI 的旧失败项。
fresh();
const restored=browserImage('a',{uri:'restored-a'}),failedOld=browserImage('failed-old',{uri:'',ready:false});
local['images:draft:restoring']={assets:[{assetID:'a',revision,name:'a.jpg',uri:restored.uri}],browser:{images:[]}};
restoreDuringRead=()=>{page.images=[restored,failedOld];};
const restoreReadStart=reads.length;
assert.equal((await run(job('restoring','restore-one'),200)).ok,true);
assert.deepEqual(page.uploads,[['b']],'restored a must not be delivered again');
assert.deepEqual(page.images.map(x=>x.uri),['restored-a',page.images[1].uri]);
assert.equal(page.removed.length,1);assert.equal(page.removed[0].id,failedOld.id);
assert.deepEqual(reads.slice(restoreReadStart).sort(),['a','b'],'replanning uses already prepared bytes without a second read');
assert.ok(calls.some(c=>c[0]==='imageSync'&&c[2][0]==='append'&&c[2][1].files.length===1));
assert.equal(binaryData.size,0);assert.equal(binaryFiles.size,0);
console.log('PASS draft restoration during file preparation replans and uses continue-add with correct count/order');

// 即便持久化映射缺失，已注册 File 身份也可恢复上传结果，不依赖文件名/大小猜测。
local['images:draft:restoring'].assets=local['images:draft:restoring'].assets.filter(x=>x.assetID==='a');
page.images[1].file=new File([new Uint8Array([255,216,255,1])],'different-name.jpg');
registered.set(page.images[1].file,{assetID:'b',revision});
const recoveredReads=reads.length;
assert.equal((await run(job('restoring','restore-two'),201)).ok,true);
assert.deepEqual(page.uploads,[['b']]);
assert.equal(reads.length,recoveredReads);
assert.deepEqual(local['images:draft:restoring'].assets.map(x=>x.assetID),['a','b']);
console.log('PASS registered File identity restores resource mappings without duplicate upload');

// 无可复用资源时先追加进入已有编辑器，再清理旧卡片，不能清空后误走整批上传入口。
fresh();page.images=[browserImage('unrelated'),browserImage('old-failure',{uri:'',ready:false})];
const replaceStart=calls.length;
assert.equal((await run(job('append-first','append-first-one'),300)).ok,true);
assert.deepEqual(page.uploads,[['a','b']]);
assert.equal(page.images.length,2);assert.equal(page.removed.length,2);
const operations=calls.slice(replaceStart).filter(c=>c[0]==='imageSync').map(c=>c[2][0]);
assert.ok(operations.indexOf('append')<operations.indexOf('remove'));
assert.ok(operations.indexOf('local')<operations.indexOf('remove'),'confirm local reception before clearing old cards');
assert.equal(binaryData.size,0);assert.equal(binaryFiles.size,0);
console.log('PASS replacing all images appends and confirms local reception before removing old cards');


// 首次整批上传期间原生卡片仍为零；本地面板先可见，等服务端完成后才出现原生图片。
fresh();page.deferNative=true;page.nativeSnapshotWait=2;
const initialCallStart=calls.length;
assert.equal((await run(job('initial-pending','initial-pending-one'),400)).ok,true);
assert.equal(page.zeroNativeSamples,2,'server wait must tolerate multiple empty native snapshots');
assert.ok(page.previewUpdates.some(x=>x.visible&&x.nativeCount===0&&x.phase==='uploading'),'local panel remains visible before native cards exist');
assert.deepEqual(page.uploads,[['a','b']]);assert.equal(page.images.length,2);
assert.equal(page.preview.visible,false,'panel yields only after native thumbnails are loaded');
assert.ok(!calls.slice(initialCallStart).some(c=>c[0]==='imageSync'&&c[2][0]==='local'),'first upload must not require native local cards before server completion');
assert.equal(local.lastLocalPreviewTiming.firstPreviewMs,5);
assert.equal(local['images:draft:initial-pending:inflight'],null);
console.log('PASS initial upload tolerates zero native cards while independent local thumbnails are visible');

// 新 worker 没有内存锁；持久化 inflight 仍须阻止再次读取或投递正在由原网页处理的文件。
fresh();
const inflightKey='images:draft:worker-restart:inflight';
local['draft:worker-restart']={tabId:500};marked.set(500,'worker-restart');
local['images:draft:worker-restart']={assets:[],browser:{images:[]}};
local[inflightKey]={startedAt:Date.now(),files:[{assetID:'a',revision},{assetID:'b',revision}]};
const inflightBefore=structuredClone(local[inflightKey]),restartReadStart=reads.length,restartCallStart=calls.length;
await import('../browser/worker.js?restart-inflight-regression');
const restartResult=await run(job('worker-restart','restart-one'),501);
assert.equal(restartResult.ok,false);assert.match(restartResult.error,/上次图片仍由抖音网页处理/);
assert.equal(reads.length,restartReadStart,'fresh worker must not re-read inflight file bytes');
assert.deepEqual(page.uploads,[]);assert.equal(page.textCalls,0);
assert.deepEqual(local[inflightKey],inflightBefore);
assert.ok(!calls.slice(restartCallStart).some(c=>c[0]==='receiveBinary'||c[0]==='deliverImages'||(c[0]==='imageSync'&&['append','register','remove'].includes(c[2][0]))),'fresh worker must not send or mutate pending native images');
// 原网页上传结束后，只读真实 File 身份即可解除保护并确认映射，不需要重新发送。
page.images=['a','b'].map(assetID=>{const image=browserImage(assetID);registered.set(image.file,{assetID,revision});return image;});
assert.equal((await run(job('worker-restart','restart-two'),502)).ok,true);
assert.equal(reads.length,restartReadStart);assert.deepEqual(page.uploads,[]);
assert.equal(local[inflightKey],null);assert.equal(local['images:draft:worker-restart'].assets.length,2);
console.log('PASS restarted worker preserves inflight uploads and resumes verification without reading or resending');
