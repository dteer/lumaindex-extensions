import assert from 'node:assert/strict';
import vm from 'node:vm';
import {listCollections, validateCollectionQuery} from '../browser/collection.js';

const origin = 'https://creator.douyin.com';
// collection 模拟真实列表结构，并附带不应跨边界传递的作者资料和签名资源地址。
function collection(patch = {}) {
  return {mix_id:'1001',mix_name:'山野记录',type:0,status:{status:2},statis:{updated_to_episode:3,play_vv:900},
    extra:'{"content_sub_type":0,"internal_metadata":"not-for-cache"}',is_charge_series:0,charge_episodes:null,charge_skus:null,
    author:{uid:'private-author-id',nickname:'private-author'},cover_url:{url_list:['https://cdn.example/image?signature=private-signature']},...patch};
}
// fixture 序列化执行真实注入函数，避免测试掩盖模块闭包依赖或改用网站私有请求器。
function fixture(data = {status_code:0,mix_list:[collection()],has_more:true,cursor:1687425766}, options = {}) {
  const calls = [], timeouts = [];
  const context = vm.createContext({URL,location:new URL(options.origin || origin),
    AbortSignal:{timeout(milliseconds) { timeouts.push(milliseconds); return 'abort-signal'; }},
    async fetch(url, init) {
      calls.push({url,init});
      assert.equal(url.origin, origin); assert.equal(url.pathname, '/web/api/mix/list/');
      assert.equal(init.method, 'GET'); assert.equal(init.credentials, 'include'); assert.equal(init.redirect, 'error');
      assert.equal(init.signal, 'abort-signal'); assert.equal(init.body, undefined); assert.equal(init.headers, undefined);
      assert.deepEqual([...url.searchParams.keys()].sort(), ['count','cursor','status']);
      assert.equal(url.searchParams.get('count'),'10'); assert.equal(url.searchParams.get('status'),'0,2');
      if (options.failure) throw Error(options.failure);
      return {ok:options.httpOK !== false,json:async()=>{if(options.invalidJSON) throw SyntaxError('internal JSON diagnostic');return data;}};
    },
  });
  const query = vm.runInContext(`(${listCollections.toString()})`,context);
  return {calls,timeouts,query:async params=>JSON.parse(JSON.stringify(await query(params)))};
}

assert.deepEqual(validateCollectionQuery({kind:'image'}),{kind:'image',cursor:'0'});
assert.deepEqual(validateCollectionQuery({kind:'video',cursor:'1687425766'}),{kind:'video',cursor:'1687425766'});
assert.deepEqual(validateCollectionQuery({kind:'image',cursor:'1'.repeat(30),count:99999,url:'https://evil.example'}),{kind:'image',cursor:'1'.repeat(30)});
for (const params of [undefined,null,[],{}, {kind:'other'}, {kind:'image',cursor:null}, {kind:'image',cursor:0},
  ...['','00','-1','1.5','1e3',' 1','../unsafe','1'.repeat(31)].map(cursor=>({kind:'image',cursor}))]) {
  assert.throws(()=>validateCollectionQuery(params),/合集查询参数无效/);
  const invalid = fixture(); assert.equal((await invalid.query(params)).ok,false); assert.equal(invalid.calls.length,0);
}

const expectedInfo = {mix_id:'1001',mix_name:'山野记录',type:0,statis:{updated_to_episode:3}};
const first = fixture(), page = await first.query({kind:'image',cursor:'0',count:99999,url:'https://evil.example',status:'all'});
assert.deepEqual(page,{ok:true,data:{items:[{id:'1001',title:'山野记录',order:4,info:expectedInfo}],nextCursor:'1687425766'}});
assert.equal(first.calls.length,1,'one query performs one paginated server request');
assert.equal(first.calls[0].url.searchParams.get('cursor'),'0'); assert.deepEqual(first.timeouts,[12000]);
assert.doesNotMatch(JSON.stringify(page),/private-author|signature|internal_metadata|play_vv/);
assert.equal(page.data.account,undefined,'account ownership is checked by the worker');

// 后续游标原样发送；没有下一页时不因平台仍返回一个历史 cursor 而继续请求。
const last = fixture({status_code:0,mix_list:[],has_more:false,cursor:1687425766});
assert.deepEqual(await last.query({kind:'video',cursor:'1687425766'}),{ok:true,data:{items:[],nextCursor:null}});
assert.equal(last.calls[0].url.searchParams.get('cursor'),'1687425766'); assert.equal(last.calls.length,1);
const largeCursor = '9007199254740993123';
const precise = fixture({status_code:0,mix_list:[],has_more:1,cursor:largeCursor});
assert.equal((await precise.query({kind:'image'})).data.nextCursor,largeCursor);
for (const cursor of [0,'0',undefined,null,-1,1.5,'01','-1','not-a-cursor','1'.repeat(31),Number.MAX_SAFE_INTEGER+1]) {
  const stalled = fixture({status_code:0,mix_list:[],has_more:true,cursor});
  const response = await stalled.query({kind:'image',cursor:'0'});
  assert.equal(response.ok,false); assert.match(response.error,/分页信息/); assert.equal(stalled.calls.length,1);
}

// 付费、会员、短剧及新合集不能被伪装成普通合集，审核中或已删除的条目也不能恢复。
const unsupported = [
  {type:13},{type:10},{type:1},{type:'0'},
  {status:{status:1}},{status:{status:3}},{status:{status:4}},{status:undefined},
  {is_charge_series:1},{is_charge_series:true},{is_charge_series:'1'},{charge_info:{spu_id:'paid'}},
  {charge_episodes:[1]},{charge_skus:[{sku_id:'paid'}]},
  {extra:'{"content_sub_type":1}'},{extra:'{"content_sub_type":3}'},{extra:'{"content_sub_type":"0"}'},
  {extra:'{'},{extra:'[]'},{extra:'null'},{extra:{content_sub_type:0}},
  {mix_id:123},{mix_id:'../unsafe'},{mix_id:'1'.repeat(31)},{mix_name:''},{mix_name:'   '},{mix_name:'字'.repeat(201)},
  {statis:undefined},{statis:{updated_to_episode:-1}},{statis:{updated_to_episode:1.5}},{statis:{updated_to_episode:'3'}},
  {statis:{updated_to_episode:Number.MAX_SAFE_INTEGER}},{total_episode:-1},{total_episode:'3'},
];
for (const patch of unsupported) {
  const filtered = fixture({status_code:0,mix_list:[collection(patch)],has_more:true,cursor:42});
  assert.deepEqual(await filtered.query({kind:'image'}),{ok:true,data:{items:[],nextCursor:'42'}},JSON.stringify(patch));
  assert.equal(filtered.calls.length,1,'filtering must preserve the server cursor rather than silently fetch more pages');
}
const ordinary = fixture({status_code:0,mix_list:[collection({extra:undefined,is_charge_series:undefined}),collection(),
  collection({mix_id:'1002',mix_name:'<img onerror=bad()>',status:{status:0},extra:'',is_charge_series:false,charge_info:{},statis:{updated_to_episode:0}})],has_more:0,cursor:0});
const allowed = await ordinary.query({kind:'image'});
assert.equal(allowed.data.items.length,2,'same-page duplicate IDs are returned only once');
assert.equal(allowed.data.items[1].title,'<img onerror=bad()>','titles remain plain text for the extension UI');
assert.equal(allowed.data.items[1].order,1); assert.equal(allowed.data.nextCursor,null);

// 图文选择下一集；视频遵循原生对 total_episode 的末集规则，且返回最小白名单 info。
const completedMix = collection({total_episode:3});
const image = fixture({status_code:0,mix_list:[completedMix],has_more:false});
const video = fixture({status_code:0,mix_list:[completedMix],has_more:false});
assert.equal((await image.query({kind:'image'})).data.items[0].order,4);
const videoItem = (await video.query({kind:'video'})).data.items[0];
assert.equal(videoItem.order,3); assert.deepEqual(videoItem.info,{...expectedInfo,total_episode:3});
videoItem.info.statis.updated_to_episode = 99;
assert.equal(completedMix.statis.updated_to_episode,3,'query result must not retain mutable response objects');
const zeroVideo = fixture({status_code:0,mix_list:[collection({statis:{updated_to_episode:0},total_episode:0})],has_more:false});
assert.deepEqual((await zeroVideo.query({kind:'video'})).data.items,[],'an unusable native episode zero is not offered');

// 错误仅返回可操作中文，不泄漏平台诊断或网络内部信息；错误来源页不得发出请求。
for (const [data,options] of [
  [{status_code:1,message:'internal credential detail'},{}],
  [{status_code:0,has_more:false},{}],
  [{status_code:0,mix_list:{},has_more:false},{}],
  [{status_code:0,mix_list:[],has_more:'false'},{}],
  [{status_code:0,mix_list:[],has_more:false},{httpOK:false}],
  [undefined,{invalidJSON:true}], [undefined,{failure:'internal credential detail'}],
]) {
  const failure = fixture(data,options), result = await failure.query({kind:'image'});
  assert.equal(result.ok,false); assert.doesNotMatch(result.error,/credential|internal|JSON|SQL/);
}
const foreign = fixture(undefined,{origin:'https://example.com'});
assert.equal((await foreign.query({kind:'image'})).ok,false); assert.equal(foreign.calls.length,0);

console.log('PASS isolated collection query, fixed paginated endpoint, ordinary/free filtering, safe cursors, minimal draft metadata and failures');
