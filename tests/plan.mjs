import assert from 'node:assert/strict';
import {planImages,pendingImageImports} from '../browser/sync-plan.js';
const a={id:'a',revision:'1',uploadName:'a.jpg',sizeBytes:10},b={id:'b',revision:'1',uploadName:'b.jpg',sizeBytes:20};
const current=[{id:'page-a',uri:'ra',name:'a.jpg',size:10,ready:true},{id:'page-b',uri:'rb',name:'b.jpg',size:20,ready:true},{id:'page-web',uri:'web',name:'manual.jpg',size:30,ready:true}];
// 浏览器手工新增的同名同大小图片没有图库身份，必须当成额外图片移除。
let p=planImages([a,b],[],current);assert.equal(p.add.length,2);assert.equal(p.keep.length,0);assert.deepEqual(p.removeImages,current);
const prior=[{assetID:'a',revision:'1',name:'a.jpg',uri:'ra',imageID:'page-a'},{assetID:'b',revision:'1',name:'b.jpg',uri:'rb',imageID:'page-b'}];
p=planImages([a,b],prior,current);assert.equal(p.add.length,0);assert.equal(p.keep.length,2);assert.deepEqual(p.remove,['web']);assert.deepEqual(p.removeImages,[current[2]]);
p=planImages([a],prior,current);assert.deepEqual(p.remove,['rb','web']);assert.equal(p.keep[0].uri,'ra');assert.equal(p.keep[0].imageID,'page-a');
p=planImages([{...a,revision:'2'}],prior,current);assert.equal(p.add.length,1);assert.deepEqual(p.remove,['rb','ra','web']);
p=planImages([a],[],[...current,{...current[0],id:'page-collision',uri:'duplicate'}]);assert.equal(p.keep.length,0);

// 两个上传失败卡片没有 URI，仍须各自移除，不影响其它可复用资源。
const failed=[{id:'failed-1',uri:'',ready:false,name:'bad.jpg',size:5},{id:'failed-2',uri:'',ready:false,name:'bad.jpg',size:5}];
p=planImages([a,b],prior,[...current,...failed]);
assert.deepEqual(p.removeImages.map(image=>image.id),['page-web','failed-1','failed-2']);
assert.equal(p.keep.length,2);assert.equal(p.add.length,0);

// 同一 URI 的额外卡片按页面身份删除；不将一次保留误算成保留全部重复项。
const duplicate={...current[0],id:'duplicate-a'};
p=planImages([a],prior,[current[0],duplicate]);
assert.equal(p.keep.length,1);assert.equal(p.keep[0].imageID,'page-a');assert.deepEqual(p.removeImages,[duplicate]);
// 无法唯一定位旧卡片时不猜测；两个重复项都进入删除计划并重新上传一张。
p=planImages([a],[{...prior[0],imageID:undefined}],[current[0],duplicate]);
assert.equal(p.keep.length,0);assert.equal(p.add.length,1);assert.equal(p.removeImages.length,2);

// 页面重建后稳定 URI 仍能复用，新的页面身份被写回映射。
p=planImages([a],prior,[{...current[0],id:'new-document-a'}]);
assert.equal(p.keep[0].imageID,'new-document-a');assert.equal(p.add.length,0);
// 旧映射的资源丢失、文件版本变化时，即使同名同大小也不得认领网页其它图片。
p=planImages([a],prior,[{...current[0],id:'replacement',uri:'replacement-uri'}]);assert.equal(p.keep.length,0);assert.equal(p.add.length,1);
p=planImages([{...a,revision:'2'}],prior,[current[0]]);assert.equal(p.keep.length,0);assert.equal(p.add.length,1);
// App 排序决定保留项顺序；浏览器顺序不反向改变 App。
p=planImages([b,a],prior,current);assert.deepEqual(p.keep.map(image=>image.assetID),['b','a']);
// 未就绪或空 URI 不会被当作成功映射。
p=planImages([a],[],[{...current[0],uri:'',ready:true}]);assert.equal(p.keep.length,0);assert.equal(p.add.length,1);assert.equal(p.removeImages.length,1);
// 同一当前卡片不会分配给两个 App 素材。
p=planImages([a,{...a,id:'another-asset'}],[],[{...current[0],assetID:'a',revision:'1'}]);assert.equal(p.keep.length,1);assert.equal(p.add.length,1);
// 上传成功但最终映射保存失败，靠实际投递 File 注册的素材身份和版本恢复，允许名称和大小已转换。
const recovered={id:'recovered-a',assetID:'a',revision:'1',uri:'new-server-uri',name:'converted.jpg',size:7,ready:true};
p=planImages([a],prior,[recovered]);assert.equal(p.add.length,0);assert.equal(p.keep[0].uri,'new-server-uri');assert.equal(p.keep[0].imageID,'recovered-a');
// 更新版本已投递成功而旧持久化映射仍是上一版，也不重复上传。
p=planImages([{...a,revision:'2'}],prior,[current[0],{...recovered,revision:'2'}]);assert.equal(p.add.length,0);assert.deepEqual(p.removeImages,[current[0]]);
// 多次失败尝试留下同一素材和版本的已知重复卡片，按当前顺序保留一张，其余精确移除。
const recoveredDuplicate={...recovered,id:'recovered-a-2',uri:'another-server-uri'};
p=planImages([a],prior,[recovered,recoveredDuplicate]);assert.equal(p.keep.length,1);assert.equal(p.add.length,0);assert.deepEqual(p.removeImages,[recoveredDuplicate]);
// 身份或版本不符，即使文件名大小相同也不能认领。
p=planImages([a],[],[{...current[0],assetID:'different-asset',revision:'1'}]);assert.equal(p.keep.length,0);assert.equal(p.add.length,1);
p=planImages([a],[],[{...current[0],assetID:'a',revision:'old-version'}]);assert.equal(p.keep.length,0);assert.equal(p.add.length,1);
// 标记的 File 尚未完成上传不能充当已成功资源。
p=planImages([a],prior,[{...recovered,ready:false}]);assert.equal(p.keep.length,0);assert.equal(p.add.length,1);
// Worker 重启或交接中断后，成功映射未确认前保留投递保护，超时不意味着网页上传已停止。
const submitted=[{assetID:'a',revision:'1',name:'a.jpg'},{assetID:'b',revision:'1',name:'b.jpg'}];
const inflight={startedAt:1000,files:submitted};
assert.deepEqual(pendingImageImports(inflight,[a,b],[]),submitted);
assert.deepEqual(pendingImageImports(inflight,[a,b],[prior[0]]),[submitted[1]]);
assert.deepEqual(pendingImageImports(inflight,[a,b],prior),[]);
// 即便任务很早开始或开始时间缺失，匹配当前版本且未确认成功的投递仍受保护。
assert.deepEqual(pendingImageImports({...inflight,startedAt:0},[a,b],[]),submitted);
assert.deepEqual(pendingImageImports({files:submitted},[a,b],[]),submitted);
// App 已删除或更新版本的素材不阻塞新快照；不存在投递记录时允许正常规划。
assert.deepEqual(pendingImageImports(inflight,[{...a,revision:'2'}],[]),[]);
assert.deepEqual(pendingImageImports(inflight,[b],[]),[submitted[1]]);
assert.deepEqual(pendingImageImports(undefined,[a,b],[]),[]);
assert.deepEqual(pendingImageImports({startedAt:1000},[a,b],[]),[]);
// 同名成功资源不具有素材身份，不能消除在途保护。
assert.deepEqual(pendingImageImports(inflight,[a,b],current),submitted);
console.log('PASS strict resource identity, failed-run recovery, persistent in-flight retry guard, missing-URI cleanup, duplicate-URI removal, authoritative order, revision protection');
