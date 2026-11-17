import assert from 'node:assert/strict';
import {validateLocationQuery,searchLocations} from '../browser/location.js';
const params={cityCode:'330100',cityName:'杭州市',keyword:' 西湖 ',page:1};
assert.equal(validateLocationQuery(params).keyword,'西湖');
for(const patch of [{cityCode:'../abc'},{keyword:''},{page:0},{page:101},{cityName:''}]){
 assert.throws(()=>validateLocationQuery({...params,...patch}));
}
globalThis.location={origin:'https://creator.douyin.com'};
globalThis.fetch=async(url,options)=>{
 assert.equal(url.origin,'https://creator.douyin.com');
 assert.equal(url.pathname,'/aweme/v1/life/video_api/search/poi/');
 assert.equal(url.searchParams.get('selected_city_code'),'330100');
 assert.equal(url.searchParams.get('count'),'10');
 assert.equal(options.credentials,'include');
 return {ok:true,json:async()=>({status_code:0,poi_list:[{poi_id:'123',poi_name:'西湖',address_info:{simple_addr:'杭州'}}],has_more:1,page:2})};
};
assert.deepEqual(await searchLocations(params),{ok:true,data:{items:[{id:'123',name:'西湖',address:'杭州',extra:'{}',requiresNativeSelection:false}],nextPage:2}});
globalThis.fetch=async()=>({ok:true,json:async()=>({status_code:1001})});
assert.equal((await searchLocations(params)).ok,false);
globalThis.location.origin='https://example.com';
assert.equal((await searchLocations(params)).ok,false);
console.log('PASS location query validation, fixed origin, city parameters, pagination and failures');
