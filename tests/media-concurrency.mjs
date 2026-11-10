import assert from 'node:assert/strict';
import {mapLimited} from '../browser/media.js';
let active=0,peak=0;
const result=await mapLimited([3,1,2,0],2,async n=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,n*5));active--;return n;});
assert.deepEqual(result,[3,1,2,0]);assert.equal(peak,2);
await assert.rejects(mapLimited([1],2,async()=>{throw Error('read failed');}),/read failed/);
console.log('PASS bounded concurrent read, order and failure propagation');
