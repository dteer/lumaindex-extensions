import assert from 'node:assert/strict';
import {imageSync} from '../browser/image-sync.js';

// fixture 每次提交重建组件 Fiber，但复用 DOM/File；DOM 与 host.return 刻意保留旧分支。
function fixture(initial,{delay=0}={}){
 const state={images:initial,previews:[],mutations:[],staleCalls:0,container:{current:null}};
 const elements=new Map();
 const makeProps=(image,index,stale=false)=>({
  index,imageFile:{...(image.file?{file:image.file}:{}),...(image.uri?{uploadFile:{uri:image.uri,uriStatus:image.ready?2000:0}}:{})},
  onChange(i){
   if(stale){state.staleCalls++;return;}
   state.mutations.push(['remove',i]);
   setTimeout(()=>{state.images.splice(i,1);commit();},delay);
  },
  onSwap(a,b){
   if(stale){state.staleCalls++;return;}
   state.mutations.push(['swap',a,b]);
   setTimeout(()=>{[state.images[a],state.images[b]]=[state.images[b],state.images[a]];commit();},delay);
  },
 });
 function commit(){
  const root={stateNode:state.container,child:null};let previous;
  for(const [index,image] of state.images.entries()){
   let element=elements.get(image.key);
   if(!element){
    const staleRoot={stateNode:state.container},staleCard={memoizedProps:makeProps({...image,uri:'stale-'+image.key},index,true),return:staleRoot};
    element={className:'img-test',__reactFiberTest:{return:staleCard},querySelectorAll(selector){
     const direct=image.directImages??[{complete:image.preview,naturalWidth:image.preview?10:0,src:'blob:'+image.key}];
     return selector===':scope > img'?direct:selector==='img'?[...direct,...(image.nestedImages||[])]:[];
    }};
    elements.set(image.key,element);
   }
   element.parentElement={className:'container-test',children:[element,...(image.siblings||[])]};
   const component={memoizedProps:makeProps(image,index),return:root};
   // React 允许共享子树仍保留旧 return；必须从遍历上下文读取当前祖先。
   component.child={stateNode:element,return:element.__reactFiberTest.return};
   if(previous)previous.sibling=component;else root.child=component;
   previous=component;
  }
  state.container.current=root;
 }
 commit();
 globalThis.document={documentElement:{dataset:{lumaDraft:'draft'}},querySelectorAll(selector){if(selector==='[class^="img-"]')return state.images.map(x=>elements.get(x.key));if(selector.includes('carousel-'))return state.previews;if(selector==='[class^="phone-container"],[class*=" phone-container"]')return state.phones||[];return [];}};
 state.commit=commit;
 return state;
}
// image 为每次上传保留唯一 File 身份；同名文件也必须独立同步。
function image(key,{uri=key,ready=true,preview=true,name=key+'.jpg',file=true}={}){
 return {key,uri,ready,preview,...(file?{file:{name,size:4}}:{})};
}
let state=fixture([image('one'),image('two',{ready:false,preview:false})]);
let first=await imageSync('snapshot');
assert.deepEqual(first.images.map(x=>x.uri),['one','two']);
assert.equal(first.images[0].localPreviewLoaded,true);
assert.equal(first.images[1].localPreviewLoaded,false);
assert.equal((await imageSync('local',{expected:2})).ok,true);
assert.equal((await imageSync('verify',{expected:2})).ok,false);
state.images[1].ready=true;state.commit();
assert.equal((await imageSync('verify',{expected:2})).ok,false);
state.previews=state.images.map(x=>({complete:true,naturalWidth:10,src:'https://example/'+x.uri}));
assert.equal((await imageSync('verify',{expected:2})).ok,true);
assert.deepEqual((await imageSync('snapshot')).images.map(x=>x.id),first.images.map(x=>x.id));
assert.equal((await imageSync('order',{uris:['two','one']})).ok,true);
assert.deepEqual(state.images.map(x=>x.uri),['two','one']);
assert.equal((await imageSync('remove',{draftKey:'wrong',uris:['one']})).ok,false);
assert.equal((await imageSync('remove',{draftKey:'draft',uris:['one']})).ok,true);
assert.deepEqual(state.images.map(x=>x.uri),['two']);
assert.equal(state.staleCalls,0);
console.log('PASS committed ancestor props despite stale DOM Fiber/return, stable File identity, preview gates and scoped delete');

// 两次删除之间必须等提交：否则第二个旧索引会移除错误图片。
state=fixture([image('a'),image('b'),image('c'),image('d')],{delay:220});
first=await imageSync('snapshot');
assert.equal((await imageSync('remove',{targets:[first.images[0],first.images[2]]})).ok,true);
assert.deepEqual(state.images.map(x=>x.uri),['b','d']);
assert.deepEqual(state.mutations,[['remove',0],['remove',1]]);
assert.equal(state.staleCalls,0);
state=fixture([image('a'),image('b'),image('c'),image('d')],{delay:220});
assert.equal((await imageSync('order',{uris:['d','c','b','a']})).ok,true);
assert.deepEqual(state.images.map(x=>x.uri),['d','c','b','a']);
assert.equal(state.staleCalls,0);
console.log('PASS asynchronous React commits complete before subsequent delete/reorder');

// 缺 URI 的上传失败项不能按空 URI/同名文件猜测，但可按快照身份精确删除。
state=fixture([image('failed-a',{uri:'',ready:false,name:'same.jpg'}),image('failed-b',{uri:'',ready:false,name:'same.jpg'}),image('ok')]);
first=await imageSync('snapshot');
assert.notEqual(first.images[0].id,first.images[1].id);
assert.equal((await imageSync('remove',{uris:['']})).ok,false);
assert.equal((await imageSync('remove',{targets:[{...first.images[0],uri:'wrong'}]})).ok,false);
assert.equal(state.mutations.length,0);
assert.equal((await imageSync('remove',{targets:[first.images[1]]})).ok,true);
assert.deepEqual(state.images.map(x=>x.key),['failed-a','ok']);
assert.equal((await imageSync('remove',{targets:[first.images[0]]})).ok,true);
assert.deepEqual(state.images.map(x=>x.key),['ok']);
state=fixture([image('a',{uri:'same'}),image('b',{uri:'same'})]);
first=await imageSync('snapshot');
assert.equal((await imageSync('remove',{uris:['same']})).ok,false);
assert.equal((await imageSync('remove',{targets:[first.images[1]]})).ok,true);
assert.deepEqual(state.images.map(x=>x.key),['a']);
console.log('PASS exact identity deletion for failed uploads, duplicate filenames and duplicate URIs');

// 未找到当前提交节点时必须停止，不调用旧树中看似可用的回调。
state=fixture([image('a')]);
state.container.current={stateNode:state.container};
const unavailable=await imageSync('remove',{uris:['stale-a']});
assert.equal(unavailable.ok,false);
assert.equal(unavailable.retryable,true);
assert.equal(state.staleCalls,0);
assert.equal(state.mutations.length,0);
console.log('PASS detached/uncommitted host is retryable and never falls back to stale callbacks');

// 左侧缩略图加载与服务端完成分开计时；本地已显示且服务端仍在上传是合法中间态。
state=fixture([image('pending',{ready:false,preview:false})]);
assert.equal((await imageSync('startTiming')).ok,true);
state.images[0].preview=true;
await new Promise(resolve=>setTimeout(resolve,130));
let timeline=(await imageSync('timing')).timeline;
assert.equal(timeline[0].localPreviewLoaded,0);
assert.ok(timeline.some(x=>x.localPreviewLoaded===1&&x.ready===0));
console.log('PASS local thumbnail timing is independent of server readiness');

// 真实 File 的注册身份能跨上传状态提交保留；同名、同大小的浏览器文件不能冒领。
state=fixture([image('registered',{ready:false}),image('unrelated',{name:'registered.jpg'})]);
globalThis.__lumaBinaryFiles=new Map([['ticket',[state.images[0].file]]]);
assert.equal((await imageSync('register',{files:[{ticket:'ticket',binaryIndex:0,assetID:'asset-a',revision:'v1'},{ticket:'expired',binaryIndex:0,assetID:'asset-b',revision:'v2'}]})).ok,false);
assert.equal((await imageSync('snapshot')).images[0].assetID,undefined);
assert.equal((await imageSync('register',{files:[{ticket:'ticket',binaryIndex:0,assetID:'asset-a',revision:'v1'}]})).ok,true);
state.images[0].ready=true;state.commit();
globalThis.__lumaBinaryFiles.delete('ticket');
first=await imageSync('snapshot');
assert.equal(first.images[0].assetID,'asset-a');
assert.equal(first.images[0].revision,'v1');
assert.equal(first.images[1].assetID,undefined);
console.log('PASS File registration survives upload/bridge cleanup without matching unrelated files by name');

// 文件准备期间恢复草稿/用户改序后必须拒绝追加，不能先投递再发现状态变化。
const expectedIDs=first.images.map(x=>x.id);
state.images.reverse();state.commit();
const changed=await imageSync('append',{expectedIDs,files:[]});
assert.equal(changed.ok,false);
assert.equal(changed.stateChanged,true);
assert.equal(state.mutations.length,0);
console.log('PASS append refuses stale image snapshot before touching the upload input');

// Chrome 的重复投递可以共享同一 File 对象，但每次上传获得不同 URI，必须按资源卡片分别删除。
const sharedFile={name:'shared.jpg',size:4};
state=fixture([{...image('copy-a'),file:sharedFile},{...image('copy-b'),file:sharedFile},image('other')]);
first=await imageSync('snapshot');
assert.notEqual(first.images[0].id,first.images[1].id);
assert.equal((await imageSync('remove',{targets:[first.images[1]]})).ok,true);
assert.deepEqual(state.images.map(x=>x.key),['copy-a','other']);
assert.equal((await imageSync('remove',{targets:[first.images[0]]})).ok,true);
assert.deepEqual(state.images.map(x=>x.key),['other']);
console.log('PASS shared File uploads retain distinct card identities by server URI');

// 重试图标已加载不代表本地照片出现；仅统计卡片直接子缩略图，拒绝 SVG/data 占位图。
const loadedIcon={complete:true,naturalWidth:24,src:'data:image/svg+xml;base64,PHN2Zy8+'};
const loadedRaster={complete:true,naturalWidth:100,src:'blob:actual-photo'};
state=fixture([
 {...image('nested-icon',{ready:false}),directImages:[],nestedImages:[loadedRaster]},
 {...image('svg-icon',{ready:false}),directImages:[loadedIcon]},
 {...image('external-svg',{ready:false}),directImages:[{...loadedIcon,src:'https://example/retry.svg?v=1'}]},
 {...image('photo',{ready:false}),directImages:[loadedRaster],nestedImages:[loadedIcon]},
]);
assert.deepEqual((await imageSync('snapshot')).images.map(x=>x.localPreviewLoaded),[false,false,false,true]);
console.log('PASS nested icons and SVG placeholders never count as loaded local thumbnails');


// 页面身份跨快照与 React 提交保持不变；它不替换或改变具体图片的身份。
state=fixture([image('document-image')]);
first=await imageSync('snapshot');
assert.match(first.documentID,/^[0-9a-f-]{36}$/i);
state.commit();
let second=await imageSync('snapshot');
assert.equal(second.documentID,first.documentID);assert.equal(second.images[0].id,first.images[0].id);
console.log('PASS document identity is stable across snapshots and React commits');

// 单卡明确失败只来自自身直接重试浮层，不读取旁边的失败卡片或嵌套工具图标。
const retry={className:'reload-test',children:[{tagName:'IMG'}]};
const failedOverlay={className:'upload-test upload-opacity-test',children:[retry]};
state=fixture([
 {...image('failed',{uri:'',ready:false}),siblings:[failedOverlay]},
 {...image('uploading',{uri:'',ready:false}),siblings:[{className:'upload-test',children:[retry]}]},
 {...image('nested',{uri:'',ready:false}),siblings:[{className:'wrapper',children:[failedOverlay]}]},
 image('neighbor'),
]);
assert.deepEqual((await imageSync('snapshot')).images.map(x=>x.failed),[true,false,false,false]);
console.log('PASS explicit upload failure is scoped to the exact card retry overlay');

// 首次上传可能尚无卡片；仅手机预览区域明确的整批上传失败提示允许标记 batchFailed。
state=fixture([]);
assert.equal((await imageSync('snapshot')).batchFailed,false);
state.phones=[{querySelectorAll(){return [{textContent:'上传中'}];}}];
assert.equal((await imageSync('snapshot')).batchFailed,false);
state.phones=[{querySelectorAll(selector){assert.equal(selector,'[class^="upload-error-"],[class*=" upload-error-"]');return [{textContent:'上传失败，重新上传'}];}}];
assert.equal((await imageSync('snapshot')).batchFailed,true);
assert.deepEqual((await imageSync('snapshot')).images,[]);
console.log('PASS batch upload failure can be observed before any native cards exist');
