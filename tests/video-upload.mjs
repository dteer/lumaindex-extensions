import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {uploadVideo,signVideoRequest,videoChunks} from '../browser/video-upload.js';
import {crc32} from '../browser/image-upload.js';
import {MAX_FILE,MAX_VIDEO_FILE} from '../browser/protocol.js';

// 仅使用虚构授权，期望签名来自独立 Python HMAC 实现，测试不访问抖音或读取登录数据。
const auth={AccessKeyID:'EXAMPLEKEY',SecretAccessKey:'example-secret',SessionToken:'example-session-token',ExpiredTime:'2026-11-16T03:00:00Z'};
const clock={now:()=>new Date('2026-11-16T02:00:00Z'),random:()=>'abcdef123456'};
const apply=await signVideoRequest(auth,'ApplyUploadInner',{size:19},clock);
assert.ok(apply.headers.Authorization.endsWith('Signature=3eb1d91569e2bd9eaee88b6bc361f3414860500a37b930c38371e171501b756c'));
assert.equal(new URL(apply.url).origin,'https://vod.bytedanceapi.com');
const commit=await signVideoRequest(auth,'CommitUploadInner',{sessionKey:'example-session-key'},clock);
assert.ok(commit.headers.Authorization.endsWith('Signature=e872982f02899180e76ffa950b7cf85314dfb9c87c3cc9835ac5f54debf23453'));
assert.deepEqual(JSON.parse(commit.body),{SessionKey:'example-session-key',Functions:[{name:'GetMeta'},{name:'Snapshot',input:{SnapshotTime:0}}]});
console.log('PASS independent VOD signatures and fixed Apply/Commit contracts');

const MiB=1024*1024;
assert.equal(MAX_FILE,50*MiB);assert.equal(MAX_VIDEO_FILE,80*MiB);
assert.equal(new URL((await signVideoRequest(auth,'ApplyUploadInner',{size:MAX_VIDEO_FILE},clock)).url).searchParams.get('FileSize'),String(MAX_VIDEO_FILE));
await assert.rejects(signVideoRequest(auth,'ApplyUploadInner',{size:MAX_VIDEO_FILE+1},clock),/视频文件大小无效/);
const oversizedVideo=new File(['small fixture'],'large.mp4',{type:'video/mp4'});
Object.defineProperty(oversizedVideo,'size',{value:MAX_VIDEO_FILE+1});
let oversizedRequests=0;
await assert.rejects(uploadVideo(oversizedVideo,auth,{...clock,fetch:async()=>{oversizedRequests++;}}),/80 MiB/);
assert.equal(oversizedRequests,0);
assert.deepEqual(videoChunks(7*MiB),[{start:0,end:3*MiB},{start:3*MiB,end:6*MiB},{start:6*MiB,end:7*MiB}]);
assert.deepEqual(videoChunks(12*MiB,true),[{start:0,end:5*MiB},{start:5*MiB,end:12*MiB}]);

// pipeline 验证 URL、分片 CRC 与合并清单，服务端 MD5 由 Node 原生加密库独立计算。
function pipeline(size=19,{gateway=false,failPhase,wrongHash=false,host='upload.example.bytedancevod.com'}={}){
 const bytes=new Uint8Array(size);for(let i=0;i<size;i++)bytes[i]=(i*7)%256;
 const file=new File([bytes],'video.mp4',{type:'video/mp4'}),uri='tos-cn-v-fixture/video',requests=[],transfers=[];
 const fetch=async(url,init)=>{
  const parsed=new URL(url),phase=parsed.searchParams.get('Action')||parsed.searchParams.get('phase')||'direct';
  requests.push({phase,url,init});assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
  if(phase===failPhase)throw Error('private example-storage-auth response');
  let data;
  if(phase==='ApplyUploadInner'){
   assert.equal(parsed.searchParams.get('FileSize'),String(size));
   data={Result:{InnerUploadAddress:{UploadNodes:[{UploadHost:host,SessionKey:'example-session-key',UploadHeader:gateway?[{Key:'X-Storage-Mode',Value:'gateway'}]:{},StoreInfos:[{StoreUri:uri,Auth:'example-storage-auth'}]}]}}};
  }else if(phase==='init'){
   assert.equal(init.headers['x-storage-mode'],'gateway');data={code:2000,data:{uploadid:'gateway-session-id'}};
  }else if(phase==='direct'||phase==='transfer'){
   assert.equal(parsed.hostname,'upload.example.bytedancevod.com');assert.equal(init.headers.Authorization,'example-storage-auth');
   assert.equal(init.headers['Content-CRC32'],crc32(init.body));
   if(phase==='transfer'){
    const offset=Number(parsed.searchParams.get('part_offset'));
    assert.deepEqual(init.body,bytes.subarray(offset,offset+init.body.length));
    assert.equal(parsed.searchParams.get('part_number'),String(transfers.length+1));
    if(gateway)assert.equal(parsed.searchParams.get('uploadid'),'gateway-session-id');
   }else assert.deepEqual(init.body,bytes);
   transfers.push(init.headers['Content-CRC32']);data={code:2000};
  }else if(phase==='finish'){
   assert.equal(init.body,transfers.map((crc,i)=>(i+1)+':'+crc).join(','));data={code:2000,data:{key:uri}};
  }else if(phase==='CommitUploadInner'){
   assert.equal(JSON.parse(init.body).SessionKey,'example-session-key');
   data={Result:{Results:[{Vid:'fixture-vid',PosterUri:'poster/fixture',VideoMeta:{Uri:uri,Md5:wrongHash?'wrong':createHash('md5').update(bytes).digest('hex'),Size:size,Duration:8,Width:1920,Height:1080,Format:'mp4'}}]}};
  }else throw Error('unexpected phase');
  return {ok:true,json:async()=>data};
 };
 return {file,requests,transfers,options:{fetch,...clock}};
}
const direct=pipeline(),uploaded=await uploadVideo(direct.file,auth,direct.options);
assert.deepEqual(direct.requests.map(r=>r.phase),['ApplyUploadInner','direct','CommitUploadInner']);
assert.equal(uploaded.vid,'fixture-vid');assert.equal(uploaded.uploadFile.coverUri,'poster/fixture');assert.equal(uploaded.uploadFile.type,'video/mp4');assert.equal(uploaded.videoMeta.duration,8);assert.equal(uploaded.bytes,19);
assert.ok(!JSON.stringify(uploaded).includes('example-'));
const gatewayDirect=pipeline(19,{gateway:true});await uploadVideo(gatewayDirect.file,auth,gatewayDirect.options);
assert.deepEqual(gatewayDirect.requests.map(r=>r.phase),['ApplyUploadInner','init','direct','CommitUploadInner']);
const multipart=pipeline(4*MiB+13);await uploadVideo(multipart.file,auth,multipart.options);
assert.deepEqual(multipart.requests.map(r=>r.phase),['ApplyUploadInner','transfer','transfer','finish','CommitUploadInner']);
const gateway=pipeline(12*MiB,{gateway:true});await uploadVideo(gateway.file,auth,gateway.options);
assert.deepEqual(gateway.requests.map(r=>r.phase),['ApplyUploadInner','init','transfer','transfer','finish','CommitUploadInner']);
console.log('PASS video direct/ordinary multipart/gateway multipart with exact CRC merge manifest');

for(const phase of ['ApplyUploadInner','init','transfer','finish','CommitUploadInner']){
 const failing=pipeline(4*MiB,{gateway:true,failPhase:phase});
 await assert.rejects(uploadVideo(failing.file,auth,failing.options),error=>/视频上传请求失败/.test(error.message)&&!error.message.includes('example-storage-auth'));
 assert.equal(failing.requests.at(-1).phase,phase);assert.equal(failing.requests.filter(r=>r.phase===phase).length,1);
}
const badMD5=pipeline(19,{wrongHash:true});await assert.rejects(uploadVideo(badMD5.file,auth,badMD5.options),/校验不一致/);
const badHost=pipeline(19,{host:'bytedancevod.com.evil.example'});await assert.rejects(uploadVideo(badHost.file,auth,badHost.options),/上传地址/);assert.equal(badHost.requests.length,1);
const cancelled=pipeline(),abort=new AbortController();abort.abort();await assert.rejects(uploadVideo(cancelled.file,auth,{...cancelled.options,signal:abort.signal}),/取消/);assert.equal(cancelled.requests.length,0);
console.log('PASS video failures never advance/auto-retry and hide credentials, unsafe hosts and cancellation');
