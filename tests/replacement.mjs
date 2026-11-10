import assert from 'node:assert/strict';
import {resetLinkedDraft,inspectUpload,deliverImages} from '../browser/page-actions.js';
// 模拟抖音确认回调创建不挂入 DOM 的文件控件，检查交付和原型恢复。
class Input {
  type='file'; multiple=true;
  click(){throw Error('must not open native picker');}
  dispatchEvent(event){assert.equal(event.type,'change');received=this.files;}
}
globalThis.HTMLInputElement=Input;
globalThis.DataTransfer=class {
  files=[];
  items={add:file=>this.files.push(file)};
};
let modal=false,received;
const clear={textContent:'清空并重新上传',click(){modal=true;}};
const confirm={textContent:'重新上传',click(){new Input().click();}};
globalThis.document={documentElement:{dataset:{lumaDraft:'draft'}},querySelectorAll(selector){
 if(selector==='button')return modal?[clear,confirm]:[clear];
 if(selector==='h5')return modal?[{textContent:'重新上传将清空已上传图片，是否重新上传？'}]:[];
 return [];
}};
const original=Input.prototype.click;
assert.equal((await resetLinkedDraft('wrong',[])).ok,false);
assert.equal(modal,false);
const result=await resetLinkedDraft('draft',[{name:'one.jpg',type:'image/jpeg',base64:'AQID'}]);
assert.equal(result.ok,true);
assert.equal(result.count,1);
assert.equal(received.length,1);
assert.equal(received[0].name,'one.jpg');
assert.equal(Input.prototype.click,original);
console.log('PASS detached input replacement, draft ownership guard, prototype restoration');


// 首次上传的检查通过后才恢复旧草稿，投递函数必须再次检查并在写入 input 前停止。
let buttons=[],cards=[];
const imageInput={accept:'image/*',multiple:true,disabled:false,events:[],dispatchEvent(event){this.events.push(event.type);}};
const editor={querySelectorAll(selector){
 if(selector==='button')return buttons;
 if(selector==='[class^="img-"]')return cards;
 if(selector==='input[type=file]')return [imageInput];
 return [];
}};
globalThis.document={querySelectorAll(selector){return selector==='*'?[{shadowRoot:editor}]:[];}};
assert.equal(inspectUpload('image').ok,true);
for(const marker of ['继续添加','清空并重新上传','card']){
 buttons=marker==='card'?[]:[{textContent:marker}];cards=marker==='card'?[{}]:[];
 const result=deliverImages([{name:'one.jpg',type:'image/jpeg',base64:'AQID'}],'image');
 assert.equal(result.ok,false);assert.equal(result.needsReset,true);assert.equal(result.stateChanged,true);assert.equal(result.retryable,false);
 assert.equal(imageInput.files,undefined);assert.deepEqual(imageInput.events,[]);
}
buttons=[];cards=[];
const emptyDelivery=deliverImages([{name:'one.jpg',type:'image/jpeg',base64:'AQID'}],'image');
assert.equal(emptyDelivery.ok,true);assert.equal(emptyDelivery.count,1);
assert.deepEqual(imageInput.events,['input','change']);
console.log('PASS delivery rechecks restored draft markers in shadow DOM before writing any files');

// 本次新增防护只约束图文入口，不改变原有视频文件投递。
cards=[{}];imageInput.accept='video/*';imageInput.multiple=false;imageInput.events=[];
const videoDelivery=deliverImages([{name:'one.mp4',type:'video/mp4',base64:'AQID'}],'video');
assert.equal(videoDelivery.ok,true);assert.deepEqual(imageInput.events,['input','change']);
console.log('PASS image draft race guard preserves the existing video upload path');
