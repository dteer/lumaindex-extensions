import assert from 'node:assert/strict';
import {cropRect} from '../app/cover-crop.js';
for(const [w,h,a] of [[6000,4000,1.5],[4000,6000,1.5],[6000,4000,.75]]){
 for(const z of [1,2,4])for(const x of [0,.5,1])for(const y of [0,.5,1]){
  const r=cropRect(w,h,a,z,x,y);assert.ok(r.x>=0&&r.y>=0&&r.x+r.width<=1.000001&&r.y+r.height<=1.000001);assert.ok(Math.abs(r.width*w/(r.height*h)-a)<1e-9);
 }
}
console.log('PASS normalized crop bounds, source aspect, zoom and pan');
