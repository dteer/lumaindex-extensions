import assert from 'node:assert/strict';
import {createNativePreviewWheel} from '../app/preview-wheel.js';
const wheel=createNativePreviewWheel();
const send=(delta,flags={})=>wheel({deltaX:0,deltaY:delta,phased:true,...flags});
assert.equal(send(5,{began:true}),0);
assert.equal(send(8),1);
for(let i=0;i<200;i++)assert.equal(send(40),0);
assert.equal(send(0,{ended:true}),0);
for(let i=0;i<200;i++)assert.equal(send(40,{momentum:true}),0);
// 下一次 began 即刻解锁，没有时钟或等待条件。
assert.equal(send(40,{began:true}),1);
assert.equal(send(-40),0);
assert.equal(send(-40,{began:true}),-1);
assert.equal(send(0,{ended:true}),0);
assert.equal(send(40),0);
assert.equal(send(3,{phased:false}),1);
assert.equal(send(3,{phased:false}),1);
assert.equal(send(-3,{phased:false}),-1);
console.log('PASS one step per native gesture, long drag, momentum, immediate next gesture, reversal, discrete wheel');
