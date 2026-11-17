import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {DraftStore} from '../app/drafts.js';

const source=await readFile(new URL('../app/collection.js',import.meta.url),'utf8');
const app=await readFile(new URL('../app/app.js',import.meta.url),'utf8');
const html=await readFile(new URL('../app/index.html',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const plain=value=>JSON.parse(JSON.stringify(value));

// Element 仅模拟选择面板需要的 DOM，并禁止用 HTML 拼接合集标题。
class Element{
 constructor(){this.children=[];this.hidden=false;this.disabled=false;this.dataset={};this.attributes={};this.events={};this.textContent='';this.scrollHeight=800;this.scrollTop=0;this.clientHeight=200;}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this.children=children;}
 setAttribute(name,value){this.attributes[name]=String(value);}
 removeAttribute(name){delete this.attributes[name];}
 addEventListener(name,callback){this.events[name]=callback;}
 contains(target){return target===this||this.children.some(child=>child.contains(target));}
 focus(){this.focused=true;}
 set innerHTML(_value){assert.fail('Collection text must never be interpreted as HTML');}
}

// harness 保留真实组件的查询、异步失效和事件处理，只替换 DOM 与 Chrome 传输。
function harness(initial=null){
 const ids=['collection-picker','collection-open','collection-clear','collection-panel','collection-options','collection-status','collection-refresh'];
 const nodes=Object.fromEntries(ids.map(id=>[id,new Element()]));
 nodes['collection-panel'].hidden=true;
 nodes['collection-picker'].append(...ids.filter(id=>id!=='collection-picker').map(id=>nodes[id]));
 const requests=[],docEvents={},windowEvents={};
 const state={value:initial,visibility:'public',kind:'image',changes:0};
 const context=vm.createContext({
  AbortController,Error,Set,
  document:{getElementById:id=>nodes[id],createElement:()=>new Element(),addEventListener:(name,fn)=>docEvents[name]=fn},
  window:{addEventListener:(name,fn)=>windowEvents[name]=fn},
  browserBridge:()=>({queryCollections(params,signal){return new Promise((resolve,reject)=>requests.push({params:plain(params),signal,resolve,reject}));}}),
 });
 vm.runInContext(source.replace(/^import[^\n]+\n/,'').replaceAll('export function','function')+'\nglobalThis.factory=collectionPicker;globalThis.validate=collectionError;',context);
 const ui=context.factory({baseURL:'http://127.0.0.1:1234/api/v1',getValue:()=>state.value,setValue:value=>state.value=value,getVisibility:()=>state.visibility,getKind:()=>state.kind,changed:()=>state.changes++});
 ui.render();
 const options=()=>nodes['collection-options'].children.filter(child=>child.className==='collection-option');
 return {nodes,requests,state,ui,docEvents,windowEvents,options,validate:context.validate,open:()=>nodes['collection-open'].onclick(),more:()=>nodes['collection-options'].children.find(child=>child.className==='collection-more')?.onclick()};
}

// 初始草稿只显示已存标题；首次展开才连接 Chrome，选择使用返回账号身份。
{
 const h=harness();assert.equal(h.requests.length,0);assert.equal(h.nodes['collection-clear'].hidden,true);
 h.open();assert.deepEqual(h.requests[0].params,{kind:'image',cursor:'0'});assert.equal(h.nodes['collection-panel'].hidden,false);
 h.requests[0].resolve({account:'12345',items:[{id:'100',title:'<img onerror="bad">'}],nextCursor:null});await tick();
 assert.equal(h.options()[0].textContent,'<img onerror="bad">');assert.equal(h.options()[0].children.length,0);
 h.options()[0].onclick();assert.deepEqual(plain(h.state.value),{id:'100',title:'<img onerror="bad">',account:'12345'});
 assert.equal(h.nodes['collection-panel'].hidden,true);assert.equal(h.nodes['collection-clear'].hidden,false);assert.equal(h.ui.error(),'');
 h.nodes['collection-clear'].onclick();assert.equal(h.state.value,null);assert.equal(h.nodes['collection-clear'].hidden,true);
}

// 分页预取只发一个在途请求；失败不清空已加载页、不推进游标，重试只重做该页。
{
 const h=harness();h.open();h.requests[0].resolve({account:'111',items:[{id:'1',title:'第一集'},{id:'1',title:'重复'}],nextCursor:'10'});await tick();
 assert.equal(h.options().length,1);
 const list=h.nodes['collection-options'];list.scrollTop=401;list.onscroll();list.onscroll();
 assert.equal(h.requests.length,2);assert.equal(h.requests[1].params.cursor,'10');
 h.requests[1].reject(Error('连接已断开，请重试'));await tick();assert.equal(h.options().length,1);assert.match(h.nodes['collection-status'].textContent,/连接已断开/);
 list.onscroll();assert.equal(h.requests.length,2);h.more();assert.equal(h.requests[2].params.cursor,'10');
 h.requests[2].resolve({account:'111',items:[{id:'1',title:'重复'},{id:'2',title:'第二集'}],nextCursor:null});await tick();
 assert.deepEqual(h.options().map(item=>item.textContent),['第一集','第二集']);list.onscroll();assert.equal(h.requests.length,3);
}

// 普通合集过滤后为空的中间页仍可继续，空末页不提供无效翻页。
{
 const h=harness();h.open();h.requests[0].resolve({account:'111',items:[],nextCursor:'10'});await tick();
 assert.match(h.nodes['collection-options'].children[0].textContent,/本页暂无/);h.more();assert.equal(h.requests[1].params.cursor,'10');
 h.requests[1].resolve({account:'111',items:[],nextCursor:null});await tick();assert.match(h.nodes['collection-options'].children[0].textContent,/当前账号暂无/);assert.equal(h.more(),undefined);
}

// 模式切换、面板关闭和离开页面都会取消旧请求；迟到响应不得修改新作品。
{
 const h=harness({id:'101',title:'图文合集',account:'111'});h.open();h.state.kind='video';h.state.value={id:'102',title:'视频合集',account:'222'};h.ui.render();
 assert.equal(h.requests[0].signal.aborted,true);h.requests[0].resolve({account:'111',items:[{id:'103',title:'旧结果'}],nextCursor:null});await tick();
 assert.equal(h.options().length,0);assert.equal(h.nodes['collection-open'].textContent,'视频合集');assert.equal(h.state.changes,0);
 h.open();assert.equal(h.requests[1].params.kind,'video');h.docEvents.click({target:new Element()});assert.equal(h.requests[1].signal.aborted,true);
 h.open();h.windowEvents.pagehide();assert.equal(h.requests[2].signal.aborted,true);
}

// 非公开禁止选择，但保存的合集可清除；改回公开不丢失身份，非法恢复数据阻止带入。
{
 const saved={id:'100',title:'已保存',account:'111'},h=harness(saved);
 h.state.visibility='private';h.ui.render();assert.equal(h.nodes['collection-open'].disabled,true);assert.equal(h.nodes['collection-clear'].hidden,false);assert.match(h.ui.error(),/改为公开或清除/);
 h.open();assert.equal(h.requests.length,0);assert.equal(h.state.value,saved);
 h.state.visibility='public';h.ui.render();assert.equal(h.ui.error(),'');assert.equal(h.nodes['collection-open'].disabled,false);
 h.state.visibility='friends';h.ui.render();h.nodes['collection-clear'].onclick();assert.equal(h.state.value,null);assert.equal(h.ui.error(),'');assert.match(h.nodes['collection-status'].textContent,/仅支持公开/);
 for(const value of [{id:'1',title:'缺账号'},'',{id:'',title:'标题',account:'111'},{id:'1',title:'',account:'111'},{id:'abc',title:'标题',account:'111'},{id:'1',title:'标题',account:'a1'},{id:'1'.repeat(31),title:'标题',account:'111'},{id:'1',title:'标题'.repeat(101),account:'111'}])assert.match(h.validate(value,'public'),/信息不完整/);
}

// 同 ID 不同账号不标为已选；翻页账号变化保留旧页但禁选，显式刷新才从零读新账号。
{
 const h=harness({id:'1',title:'旧账号合集',account:'111'});h.open();
 h.requests[0].resolve({account:'222',items:[{id:'1',title:'新账号合集'}],nextCursor:'10'});await tick();
 assert.equal(h.options()[0].attributes['aria-pressed'],'false');assert.match(h.ui.error(),/其他抖音账号/);
 h.more();h.requests[1].resolve({account:'333',items:[{id:'2',title:'第三账号合集'}],nextCursor:null});await tick();
 assert.equal(h.options().length,1);assert.equal(h.options()[0].disabled,true);h.options()[0].onclick();assert.equal(h.state.value.account,'111');
 h.more();assert.equal(h.requests[2].params.cursor,'0');h.requests[2].resolve({account:'333',items:[{id:'2',title:'第三账号合集'}],nextCursor:null});await tick();
 h.options()[0].onclick();assert.deepEqual(plain(h.state.value),{id:'2',title:'第三账号合集',account:'333'});assert.equal(h.ui.error(),'');
}

// 缺账号、循环游标或无身份条目不可成为可选项，查询失败不会覆写已选合集。
for(const page of [{items:[],nextCursor:null},{account:'abc',items:[],nextCursor:null},{account:'111',items:[],nextCursor:'0'},{account:'111',items:[{id:'1'}],nextCursor:null},{account:'111',items:[{id:'2',title:'长'.repeat(201)}],nextCursor:null}]){
 const saved={id:'104',title:'原合集',account:'98765'},h=harness(saved);h.open();h.requests[0].resolve(page);await tick();
 assert.equal(h.state.value,saved);assert.equal(h.options().length,0);assert.match(h.nodes['collection-status'].textContent,/数据不完整/);
}

// 草稿序列化、设置捕获和交接 URL 使用实际 App 代码，公开/视频切换不丢合集身份。
{
 Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
 const collection={id:'321',title:'摄影记录',account:'123456'},content={assetIDs:['asset'],title:'标题',description:'描述',settings:{visibility:'public',download:'allow',publishTime:'now',scheduledAt:'',collection}};
 let saved;const store=new DraftStore(null,async value=>saved=value);store.update('image',content);store.update('video',{...content,settings:{...content.settings,collection:{...collection,id:'654'}}});await store.save();
 const restored=new DraftStore(JSON.parse(JSON.stringify(saved)),async()=>{});
 assert.deepEqual(restored.data.modes.image.settings.collection,collection);assert.equal(restored.data.modes.video.settings.collection.id,'654');
 const h=harness(collection),nodes={'scheduled-at':{value:''},'settings-error':new Element(),continue:new Element(),title:{value:'标题'},description:{value:'描述'}};
 const state=vm.createContext({settings:{image:structuredClone(content.settings)},mode:'image',collectionUI:h.ui,loading:false,store:restored,current:()=>[{id:'asset',name:'照片.jpg'}],crypto:webcrypto,URL,location:{href:'http://127.0.0.1:1234/api/v1/plugins/com.lumaindex.douyin/files/index.html'},$:id=>nodes[id],document:{querySelector:selector=>({value:selector.includes('visibility')?'public':selector.includes('download')?'allow':'now'})}});
 vm.runInContext(app.slice(app.indexOf('function captureSettings(){'),app.indexOf('function showSettings(){'))+app.slice(app.indexOf('function settingsError(){'),app.indexOf('function contentFor(kind)'))+app.slice(app.indexOf('function updateLink(){'),app.indexOf('// 缩略图不支持时回退到原图')),state);
 vm.runInContext('captureSettings();updateLink();',state);
 let job=JSON.parse(decodeURIComponent(new URL(nodes.continue.href).hash.slice(1)));assert.deepEqual(job.settings.collection,collection);
 h.state.visibility='private';vm.runInContext('updateLink();',state);assert.equal(nodes.continue.attributes['aria-disabled'],'true');assert.match(nodes['settings-error'].textContent,/合集仅支持公开/);
 h.state.visibility='public';h.state.value=restored.data.modes.video.settings.collection;state.settings.video=structuredClone(restored.data.modes.video.settings);state.mode='video';vm.runInContext('captureSettings();updateLink();',state);
 job=JSON.parse(decodeURIComponent(new URL(nodes.continue.href).hash.slice(1)));assert.equal(job.kind,'video');assert.equal(job.settings.collection.id,'654');
 h.state.value=null;state.settings.video.collection=null;vm.runInContext('captureSettings();updateLink();',state);job=JSON.parse(decodeURIComponent(new URL(nodes.continue.href).hash.slice(1)));assert.equal(job.settings.collection,null);
 assert.ok(html.includes('id="collection-options"'));assert.ok(app.includes('collectionUI.render()'));assert.ok(app.includes('getKind:()=>mode'));
}

console.log('PASS App collection selection, paginated prefetch/retry, stale request cancellation, account isolation, public-only validation, draft restore and handoff settings');
