import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {matchCity} from '../app/city-match.js';
const cities=JSON.parse(await readFile(new URL('../app/cities.json',import.meta.url)));
for(const text of ['杭州西湖','杭州市西湖']){
 const result=matchCity(text,cities);assert.equal(result.city.code,'330100');assert.equal(result.keyword,'西湖');
}
assert.equal(matchCity('北京故宫',cities).city.code,'110100');
assert.equal(matchCity('西湖',cities).candidates.length,0);
assert.equal(matchCity('故宫',cities).candidates.length,0);
assert.equal(matchCity('北京杭州',cities).candidates.length,2);
assert.equal(matchCity('杭州市',cities).keyword,'');
assert.equal(matchCity('海口市人民公园',cities).candidates.length,1);
console.log('PASS city extraction, full names, ambiguity and unknown landmarks');
