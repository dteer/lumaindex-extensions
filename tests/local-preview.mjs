import assert from 'node:assert/strict';
import {localPreview} from '../browser/local-preview.js';

// Element 用真实父子关系模拟本地预览需要的 DOM；查询遍历子树，不按测试期望返回预置节点。
class Element {
 // constructor 创建尚未连接到页面的元素，保留属性、样式及监听器。
 constructor(tag) {
  this.tagName=tag.toUpperCase();this.style={};this.children=[];this.attributes={};
  this.listeners=new Map();this.parentElement=null;this.dataset={};this._text='';this.hidden=false;
 }
 // className 与 class 属性共享数据，保证复制原生行样式能被回读检查。
 get className(){return this.attributes.class||'';}
 set className(value){this.attributes.class=String(value);}
 // classList 暴露标准迭代和类名检查，不假定 CSS 构建哈希。
 get classList(){const values=this.className.split(/\s+/).filter(Boolean);return {contains:value=>values.includes(value),[Symbol.iterator]:()=>values[Symbol.iterator]()};}
 // textContent 聚合子元素文本；赋值时与真实 DOM 一样替换原内容。
 get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
 set textContent(value){for(const child of this.children)child.parentElement=null;this.children=[];this._text=String(value);}
 // nextSibling 按当前父节点子序列计算，覆盖封面行之后插入的场景。
 get nextSibling(){if(!this.parentElement)return null;const siblings=this.parentElement.children;return siblings[siblings.indexOf(this)+1]||null;}
 // isConnected 只把当前文档根下的节点视为可见页面的一部分。
 get isConnected(){for(let node=this;node;node=node.parentElement)if(node===globalThis.document?.documentElement)return true;return false;}
 // append/prepend/insertBefore 保留元素单一父节点和真实顺序。
 append(...children){for(const child of children){child.remove();child.parentElement=this;this.children.push(child);}}
 prepend(child){this.insertBefore(child,this.children[0]||null);}
 insertBefore(child,before){if(before!==null)assert.equal(before.parentElement,this);child.remove();child.parentElement=this;const index=before===null?this.children.length:this.children.indexOf(before);this.children.splice(index,0,child);return child;}
 // remove 只移除自身，子树仍归该节点，允许验证包装行是否完整脱离页面。
 remove(){if(this.parentElement){const parent=this.parentElement;parent.children=parent.children.filter(child=>child!==this);this.parentElement=null;}}
 // contains 检查任意深度后代，用于禁止面板进入作品描述区域。
 contains(other){return this===other||this.children.some(child=>child.contains(other));}
 // 属性操作模拟预览所需的标准 DOM 属性语义。
 setAttribute(key,value){this.attributes[key]=String(value);}
 getAttribute(key){return Object.hasOwn(this.attributes,key)?this.attributes[key]:null;}
 removeAttribute(key){delete this.attributes[key];if(key==='src')this.src='';}
 // addEventListener/removeEventListener 保留可触发的关闭和清理回调。
 addEventListener(type,handler){this.listeners.set(type,handler);}
 removeEventListener(type,handler){if(this.listeners.get(type)===handler)this.listeners.delete(type);}
 // matches 支持源码使用的标签、类及属性选择器，未知选择器直接报错，防止替身默默放行。
 matches(selector){return selector.split(',').some(part=>matchesSimple(this,part.trim()));}
 // closest 在真实祖先链搜索，包括元素自身。
 closest(selector){for(let node=this;node;node=node.parentElement)if(node.matches(selector))return node;return null;}
 // querySelectorAll 遍历后代，不包括查询根自身，与 DOM 的常规行为一致。
 querySelectorAll(selector){const result=[];for(const child of this.children){if(child.matches(selector))result.push(child);result.push(...child.querySelectorAll(selector));}return result;}
 // getClientRects 将祖先隐藏状态传播给子节点，确保隐藏表单不是有效候选。
 getClientRects(){if(!this.isConnected)return [];for(let node=this;node;node=node.parentElement)if(node.hidden||node.style.display==='none'||node.style.visibility==='hidden')return [];return [{width:600,height:100}];}
}

// matchesSimple 实现本用例涉及的选择器片段；保留属性值中的空格。
function matchesSimple(element,selector){
 if(selector==='*')return true;
 const attributes=[...selector.matchAll(/\[([\w-]+)(?:(\^=|\*=|~=|=)["']?([^\]"']*)["']?)?\]/g)];
 let base=selector.replace(/\[[^\]]+\]/g,'');
 const tag=base.match(/^[a-zA-Z][\w-]*/)?.[0];
 if(tag){if(element.tagName!==tag.toUpperCase())return false;base=base.slice(tag.length);}
 for(const match of base.matchAll(/([.#])([\w-]+)/g)){
  if(match[1]==='.'&&!element.classList.contains(match[2]))return false;
  if(match[1]==='#'&&element.id!==match[2])return false;
 }
 assert.equal(base.replace(/([.#])[\w-]+/g,''),'',`unsupported selector ${selector}`);
 for(const [,key,operator,value] of attributes){
  const actual=element.getAttribute(key);if(actual===null)return false;
  if(operator==='='&&actual!==value)return false;
  if(operator==='^='&&!actual.startsWith(value))return false;
  if(operator==='*='&&!actual.includes(value))return false;
  if(operator==='~='&&!actual.split(/\s+/).includes(value))return false;
 }
 return true;
}

const pageListeners=new Map(),timers=new Map(),created=[],revoked=[];let sequence=0;
const originalTimeout=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
const originalCreate=URL.createObjectURL,originalRevoke=URL.revokeObjectURL;
globalThis.setTimeout=(run,ms)=>{timers.set(++sequence,{run,ms});return sequence;};globalThis.clearTimeout=id=>timers.delete(id);
URL.createObjectURL=file=>{assert.ok(file instanceof File);const url='blob:test-'+created.length;created.push(url);return url;};URL.revokeObjectURL=url=>revoked.push(url);
globalThis.window={addEventListener:(type,fn)=>pageListeners.set(type,fn),removeEventListener:(type,fn)=>{if(pageListeners.get(type)===fn)pageListeners.delete(type);}};

// makeElement 创建 fixture 节点，模拟网站带哈希的 CSS 类名。
function makeElement(tag,className='',text=''){const element=new Element(tag);element.className=className;if(text)element.textContent=text;return element;}
// makeRow 创建原生表单的一行：独立标签列与 content-child 内容列。
function makeRow(text){const row=makeElement('div','form-item-Q native-row');row.append(makeElement('div','field-label-L',text),makeElement('div','content-child-K content-column'));return row;}
// page 保留截图中的编辑器嵌套，标题和正文最近共同祖先特意不是整个左列。
function page({native=false,phone=true}={}){
 assert.equal(globalThis.__lumaLocalPreview,undefined,'previous panel must be cleared before changing fixture');
 const html=makeElement('html'),body=makeElement('body'),shell=makeElement('main','page-shell-X');html.dataset.lumaDraft='draft';html.append(body);body.append(shell);
 const form=makeElement('form','form-container-X'),group=makeElement('section','basic-group-X'),rows=makeElement('div','form-rows-X');shell.append(form);form.append(group);group.append(rows);
 const descriptionGroup=makeElement('div','description-group-X'),descriptionRow=makeRow('作品描述');rows.append(descriptionGroup);descriptionGroup.append(descriptionRow);
 const composer=makeElement('div','editor-comp-Y'),editorKit=makeElement('div','editor-kit-root-container');descriptionRow.children[1].append(composer);composer.append(editorKit);
 const title=makeElement('input'),description=makeElement('div','editor-comp-publish'),toolbar=makeElement('div','editor-toolbar-Z');
 title.setAttribute('placeholder','添加作品标题');description.setAttribute('contenteditable','true');description.setAttribute('data-slate-editor','true');description.textContent='保留原作品描述';
 toolbar.append(makeElement('span','','#添加话题'),makeElement('span','','@好友'),makeElement('span','','6 / 1000'));editorKit.append(title,description,toolbar);
 const activity=makeRow('官方活动'),cover=makeRow('封面设置'),image=native?makeRow('编辑图片'):null,collection=makeRow('添加合集');rows.append(activity,cover);cover.children[1].append(makeElement('button','','编辑封面'));
 if(image){image.setAttribute('name','edit_image');rows.append(image);image.children[1].append(makeElement('div','native-image-list'));}rows.append(collection);
 const phoneContainer=makeElement('aside','phone-container-E');phoneContainer.append(makeElement('div','phone-screen-S','原生右侧预览'));if(phone)shell.append(phoneContainer);
 globalThis.document={body,documentElement:html,createElement:tag=>new Element(tag),querySelectorAll:selector=>html.querySelectorAll(selector)};
 return {html,body,shell,form,group,rows,descriptionGroup,descriptionRow,composer,editorKit,title,description,toolbar,activity,cover,image,collection,phone:phoneContainer};
}

// assertUnchanged 确认作品描述内部的节点和顺序、右侧预览均未被挂载或改写。
function assertUnchanged(fixture){
 const {editorKit,title,description,toolbar,descriptionRow,descriptionGroup,phone}=fixture;
 assert.deepEqual(editorKit.children,[title,description,toolbar]);assert.equal(description.textContent,'保留原作品描述');assert.equal(toolbar.textContent,'#添加话题@好友6 / 1000');
 const panel=globalThis.__lumaLocalPreview?.panel;
 if(panel){assert.equal(descriptionGroup.contains(panel),false);assert.equal(descriptionRow.contains(panel),false);assert.equal(phone.contains(panel),false);}
 assert.equal(phone.textContent,'原生右侧预览');
}
// assertMounted 检查新行只使用原生列样式，不进入原有内容列，也不采用固定定位。
function assertMounted(fixture,result,anchor=fixture.image||fixture.cover){
 assert.equal(result.ok,true,result.error);assert.equal(result.placement,'image-row');
 const state=globalThis.__lumaLocalPreview,row=state.row;
 assert.equal(row.id,'lumaindex-local-preview-row');assert.equal(row.parentElement,fixture.rows);assert.equal(row.className,anchor.className);
 assert.equal(row.children.length,2);assert.equal(row.children[0].className,anchor.children[0].className);assert.equal(row.children[0].textContent,'带入图片');
 assert.equal(row.children[1].className,anchor.children[1].className);assert.equal(state.panel.parentElement,row.children[1]);assert.equal(anchor.contains(state.panel),false);
 assert.equal(state.panel.style.position,undefined);assert.equal(row.style.position,undefined);assertUnchanged(fixture);
 return state;
}
// assertClean 验证包装行、面板、所有 object URL、兜底计时器及离页监听一并回收。
function assertClean(state){
 assert.equal(globalThis.__lumaLocalPreview,undefined);if(state){assert.equal(state.panel.isConnected,false);assert.equal(state.row?.isConnected||false,false);assert.equal(state.panel.parentElement,null);assert.equal(state.row?.parentElement||null,null);}
 assert.equal(timers.size,0);assert.equal(pageListeners.size,0);assert.equal(new Set(revoked).size,revoked.length,'each object URL must be revoked once');assert.deepEqual(new Set(revoked),new Set(created));
 assert.equal(document.querySelectorAll('#lumaindex-local-preview-row').length,0);assert.equal(document.querySelectorAll('#lumaindex-local-preview').length,0);
}
// rejectLayout 确认未知结构不回退到编辑器、全页或浮层，并回收已创建的文件预览资源。
function rejectLayout(fixture,files){const result=localPreview('show',{draftKey:'draft',files});assert.equal(result.ok,false);assertClean();assertUnchanged(fixture);assert.equal(fixture.body.children.length,1,'no body overlay may be added');}

const fileA=new File(['a'],'same.jpg',{type:'image/jpeg'}),fileB=new File(['b'],'same.jpg',{type:'image/jpeg'});
globalThis.__lumaBinaryFiles=new Map([['ticket',[fileA,fileB]]]);
const files=[{ticket:'ticket',binaryIndex:0,assetID:'a',revision:'1'},{ticket:'ticket',binaryIndex:1,assetID:'b',revision:'2'}];
try{
 // 首次没有原生编辑图片行时，只能紧接封面行插入，不能使用 editorKit 共同祖先。
 let fixture=page(),result=localPreview('show',{draftKey:'draft',files}),state=assertMounted(fixture,result);
 assert.deepEqual(fixture.rows.children,[fixture.descriptionGroup,fixture.activity,fixture.cover,state.row,fixture.collection]);
 assert.equal(state.items[0].status.textContent,'等待上传');assert.equal(state.summary.textContent,'本地已接收 2 张 · 等待上传');
 state.items[0].image.onload();state.items[0].image.onload();result=localPreview('update',{phase:'uploading'});
 assert.equal(result.loaded,1);assert.equal(typeof result.firstPreviewMs,'number');assert.equal(state.items[0].status.textContent,'上传中');
 const uploaded=Object.freeze({assetID:'a',revision:'1',name:'same.jpg',size:1,ready:true,localPreviewLoaded:false});
 localPreview('update',{images:[uploaded]});assert.equal(state.items[0].status.textContent,'服务端已接收');assert.equal(globalThis.__lumaLocalPreview,state,'server success without native preview keeps local preview');
 result=localPreview('update',{images:[{...uploaded,revision:'old',localPreviewLoaded:true}]});assert.equal(result.visible,true,'old revision cannot clear current preview');
 result=localPreview('update',{images:[{name:'same.jpg',size:1,ready:true,localPreviewLoaded:true}]});assert.equal(result.visible,true,'name and size cannot claim registered identity');
 localPreview('update',{phase:'failed'});assert.equal(state.items[0].status.textContent,'同步未完成');assert.match(state.summary.textContent,/不代表上传成功/);
 result=localPreview('show',{draftKey:'other',files});assert.equal(result.ok,false);assert.equal(globalThis.__lumaLocalPreview,state);
 result=localPreview('show',{files:[{ticket:'expired',binaryIndex:0,assetID:'a',revision:'1'}]});assert.equal(result.ok,false);assert.equal(globalThis.__lumaLocalPreview,state,'invalid file replacement preserves previous panel');
 result=localPreview('update',{images:[{...uploaded,localPreviewLoaded:true},{assetID:'b',revision:'2',localPreviewLoaded:true,ready:false}]});
 assert.equal(result.nativeReceived,true);assert.equal(result.visible,false);assertClean(state);assertUnchanged(fixture);
 console.log('PASS first-upload preview is a sibling after cover; description editor, toolbar and right preview stay unchanged');

 // 原生图片区已经出现时，新行必须排在它之前，不能嵌入该行的内容容器。
 fixture=page({native:true});result=localPreview('show',{files});state=assertMounted(fixture,result);
 assert.deepEqual(fixture.rows.children,[fixture.descriptionGroup,fixture.activity,fixture.cover,state.row,fixture.image,fixture.collection]);
 const old=state;result=localPreview('show',{files:files.slice(0,1)});state=assertMounted(fixture,result);assert.equal(old.row.parentElement,null);assert.equal(old.panel.parentElement,null);
 assert.equal(document.querySelectorAll('#lumaindex-local-preview-row').length,1,'replacement must not leave an empty wrapper');
 result=localPreview('update',{images:[{assetID:'a',name:'same.jpg',size:1,ready:true,localPreviewLoaded:true}]});assert.equal(result.visible,true,'missing revision cannot claim a file');
 state.panel.children[0].children[1].listeners.get('click')();assertClean(state);assertUnchanged(fixture);
 console.log('PASS native-image preview uses its own sibling row; replacing or closing removes the complete wrapper');

 // 右侧尚未恢复、存在隐藏旧表单或多层外壳，都不能改变已识别左侧行的边界。
 fixture=page({phone:false});const hidden=makeElement('form','form-container-old');hidden.hidden=true;hidden.append(makeRow('封面设置'),makeRow('编辑图片'));fixture.shell.prepend(hidden);
 result=localPreview('show',{files});state=assertMounted(fixture,result);localPreview('clear');assertClean(state);
 fixture=page({native:true});fixture.rows.append(makeRow('封面设置'));result=localPreview('show',{files});state=assertMounted(fixture,result);localPreview('clear');assertClean(state);
 console.log('PASS hidden stale forms are ignored and one native image row takes precedence over cover rows');

 // 不认识或有歧义的布局必须失败，不能再用 fixed/body 浮层掩盖适配失败。
 fixture=page();fixture.cover.remove();rejectLayout(fixture,files);
 fixture=page();fixture.rows.append(makeRow('封面设置'));rejectLayout(fixture,files);
 fixture=page({native:true});fixture.rows.append(makeRow('编辑图片'));rejectLayout(fixture,files);
 fixture=page();fixture.form.className='unrecognized-form';rejectLayout(fixture,files);
 fixture=page();fixture.cover.children[1].className='unrecognized-content';rejectLayout(fixture,files);
 fixture=page();fixture.cover.hidden=true;rejectLayout(fixture,files);
 for(const kind of ['contenteditable','editor-kit-root-container','editor-comp-preview']){
  fixture=page();fixture.cover.remove();const fake=makeRow('封面设置'),wrapper=makeElement('div');
  if(kind==='contenteditable')wrapper.setAttribute('contenteditable','false');else wrapper.className=kind;
  fixture.rows.append(wrapper);wrapper.append(fake);rejectLayout(fixture,files);
 }
 console.log('PASS unknown, ambiguous, hidden and editor-contained row candidates cannot mount a panel or overlay');

 // 离页和兜底期限应连包装行一起释放，保留失败现场不意味着永久持有本地文件。
 fixture=page();localPreview('show',{files});state=globalThis.__lumaLocalPreview;pageListeners.get('pagehide')();assertClean(state);
 fixture=page();localPreview('show',{files});state=globalThis.__lumaLocalPreview;const expiry=[...timers.values()][0];assert.equal(expiry.ms,600000);expiry.run();assertClean(state);
 assert.equal(localPreview('show',{files:Array(36).fill(files[0])}).ok,false);assert.equal(localPreview('update').visible,false);
 assert.equal(localPreview('show',{files:[{ticket:'ticket',binaryIndex:0}]}).ok,false,'local preview requires registered identity and revision');
 console.log('PASS local-file identity, independent upload status, complete wrapper cleanup and object URL lifecycle');
}finally{
 globalThis.__lumaLocalPreview?.destroy();URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;globalThis.setTimeout=originalTimeout;globalThis.clearTimeout=originalClear;
}
