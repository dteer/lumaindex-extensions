import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {crc32,md5,signImageXRequest,uploadImage,uploadEndpoint,requestUploadJSON} from '../browser/image-upload.js';

// 签名样本由原 Python 实测工具独立产生，只包含虚构凭据，不读取 HAR 或真实登录信息。
const now=()=>new Date('2026-11-16T02:00:00Z'),random=()=>'abcdef123456';
const auth={AccessKeyID:'EXAMPLEKEY',SecretAccessKey:'example-secret',SessionToken:'example-session-token',ExpiredTime:'2026-11-16T03:00:00Z'};
const common={now:now(),nonce:random()};
const apply=await signImageXRequest(auth,'ApplyImageUpload',null,common);
assert.equal(apply.url,'https://imagex.bytedanceapi.com/?Action=ApplyImageUpload&ServiceId=jm8ajry58r&Version=2018-08-01&app_id=2906&s=abcdef123456&user_id=');
assert.equal(apply.headers.Authorization,'AWS4-HMAC-SHA256 Credential=EXAMPLEKEY/20261116/cn-north-1/imagex/aws4_request, SignedHeaders=x-amz-date;x-amz-security-token, Signature=140b3f70842b47dbe3b9444212a3a3593eb0dc7adcd906c28d4584679b7b0646');
const commit=await signImageXRequest(auth,'CommitImageUpload',{SessionKey:'example-session-key'},common);
assert.equal(commit.headers.Authorization,'AWS4-HMAC-SHA256 Credential=EXAMPLEKEY/20261116/cn-north-1/imagex/aws4_request, SignedHeaders=x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=77f03234e71da306d5f086f9af9dc3a20862af7f865ead49ef45c26da346fac7');
assert.equal(commit.body,'{"SessionKey":"example-session-key"}');
console.log('PASS ImageX Apply/Commit signatures match independent Python fixture');

assert.equal(crc32(new Uint8Array()),'00000000');
assert.equal(crc32(new TextEncoder().encode('123456789')),'cbf43926');
for(const size of [0,1,55,56,63,64,65,127,128,129,1000000]){
 const bytes=randomBytes(size);assert.equal(md5(bytes),createHash('md5').update(bytes).digest('hex'));
}
console.log('PASS CRC32 known vector and MD5 padding/multi-block vectors match native crypto');

const file=new File([new TextEncoder().encode('fixture image bytes')],'image.jpg',{type:'image/jpeg'});
const bytes=new Uint8Array(await file.arrayBuffer()),uri='tos-cn-i-jm8ajry58r/fixture-image';
// mockPipeline 只模拟公开协议响应，不提供页面 DOM、React 或任何上传组件。
function mockPipeline(change={}){
 const requests=[];
 const responses=[
  {Result:{UploadAddress:{UploadHosts:['upload.example.bytedancevod.com'],StoreInfos:[{StoreUri:uri,Auth:'example-storage-auth'}],SessionKey:'example-session-key'}}},
  {code:2000,data:{crc32:crc32(bytes)}},
  {Result:{Results:[{Uri:uri,UriStatus:2000}],PluginResult:[{ImageUri:uri,ImageMd5:md5(bytes),ImageWidth:100,ImageHeight:200,Orientation:{Width:100,Height:200}}]}}
 ];
 change.mutate?.(responses);
 const fetch=async(url,options)=>{
  const index=requests.length;requests.push({url,options});
  if(change.fail===index)throw Error('hidden response contains example-storage-auth');
  return {ok:change.httpError!==index,status:change.httpError===index?403:200,json:async()=>responses[index]};
 };
 return {requests,options:{fetch,now,random}};
}
const success=mockPipeline(),result=await uploadImage(file,auth,success.options);
assert.deepEqual(result,{uri,bytes:bytes.length,uploadFile:{imageUri:uri,imageMd5:md5(bytes),imageWidth:100,imageHeight:200,orientation:{width:100,height:200},uri,uriStatus:2000,key:'luma_fixture-image'}});
assert.equal(success.requests.length,3);
assert.equal(success.requests[1].url,'https://upload.example.bytedancevod.com/upload/v1/'+uri);
assert.deepEqual(success.requests[1].options.body,bytes);
assert.equal(success.requests[1].options.headers.Authorization,'example-storage-auth');
assert.equal(success.requests[1].options.headers['Content-CRC32'],crc32(bytes));
for(const request of success.requests){
 assert.equal(request.options.redirect,'error');assert.equal(request.options.credentials,'omit');assert.ok(request.options.signal instanceof AbortSignal);
 assert.ok(!JSON.stringify(request.options.headers).includes(auth.SecretAccessKey));
}
assert.ok(!JSON.stringify(result).includes('example-storage-auth'));
assert.ok(!JSON.stringify(result).includes(auth.SessionToken));
console.log('PASS independent binary upload verifies resource/CRC/MD5 and returns native draft metadata');

// 真实授权新增的存储主机只按完整名称允许，不扩展到其他 snssdk.com 子域。
const snssdk = mockPipeline({mutate:r=>{r[0].Result.UploadAddress.UploadHosts[0]='tos-lf-x.snssdk.com';}});
assert.equal((await uploadImage(file,auth,snssdk.options)).uri,uri);
assert.equal(snssdk.requests[1].url,'https://tos-lf-x.snssdk.com/upload/v1/'+uri);
for(const host of ['evil.example','bytedancevod.com.evil.example','bytedancevod.com','https://upload.bytedancevod.com','upload.bytedancevod.com:443','upload.bytedancevod.com/path','upload.bytedancevod.com@evil.example','-bad.bytedancevod.com','bad-.bytedancevod.com',
 'tos-lf-x.snssdk.com.evil.example','evil.tos-lf-x.snssdk.com','tos-lf-x.snssdk.com@evil.example','tos-lf-x.snssdk.com:443','tos-lf-x.snssdk.com/path','other.snssdk.com','snssdk.com']){
 const pipeline=mockPipeline({mutate:r=>{r[0].Result.UploadAddress.UploadHosts[0]=host;}});
 await assert.rejects(uploadImage(file,auth,pipeline.options),/上传地址/);assert.equal(pipeline.requests.length,1);
}
for(const unsafe of ['../escape','path/../escape','//evil.example/file','part\\file','part%2ffile','part?query','part#fragment','part\nfile']){
 const pipeline=mockPipeline({mutate:r=>{r[0].Result.UploadAddress.StoreInfos[0].StoreUri=unsafe;}});
 await assert.rejects(uploadImage(file,auth,pipeline.options),/上传地址/);assert.equal(pipeline.requests.length,1);
}
console.log('PASS host/path allowlist refuses credential forwarding before binary request');

for(const [modify,message,count] of [
 [r=>{r[1].data.crc32='00000000';},/内容校验/,2],
 [r=>{r[1].code=0;},/内容校验/,2],
 [r=>{r[2].Result.Results[0].UriStatus=1000;},/尚未确认/,3],
 [r=>{r[2].Result.Results[0].Uri='another';},/尚未确认/,3],
 [r=>{r[2].Result.PluginResult[0].ImageMd5='wrong';},/校验不一致/,3],
 [r=>{r[2].Result.PluginResult[0].ImageUri='another';},/校验不一致/,3]
]){
 const pipeline=mockPipeline({mutate:modify});await assert.rejects(uploadImage(file,auth,pipeline.options),message);assert.equal(pipeline.requests.length,count);
}
for(const index of [0,1,2]){
 const pipeline=mockPipeline({fail:index});
 await assert.rejects(uploadImage(file,auth,pipeline.options),error=>{
  assert.equal(error.code,'UPLOAD_NETWORK_ERROR');assert.equal(error.stage,['apply','upload','commit'][index]);
  assert.ok(error.message.includes(['申请图片上传地址','图片数据上传','图片上传确认'][index]));
  assert.doesNotMatch(error.message+JSON.stringify(error),/example-storage-auth|https?:\/\/|example-secret/);
  return true;
 });
 assert.equal(pipeline.requests.length,index+1,'failed requests must not automatically retry');
}
for(const invalid of [{...auth,ExpiredTime:'2026-11-16T01:00:00Z'},{...auth,ExpiredTime:'invalid'},{...auth,SessionToken:'bad\nvalue'},{...auth,SecretAccessKey:''}]){
 const pipeline=mockPipeline();await assert.rejects(uploadImage(file,invalid,pipeline.options),/授权/);assert.equal(pipeline.requests.length,0);
}
const aborted=mockPipeline(),controller=new AbortController();controller.abort();
await assert.rejects(uploadImage(file,auth,{...aborted.options,signal:controller.signal}),/取消/);assert.equal(aborted.requests.length,0);
await assert.rejects(signImageXRequest(auth,'DeleteImage',null,common),/不支持/);
console.log('PASS failed/expired/cancelled uploads never commit or retry and never expose raw response');

assert.doesNotThrow(()=>uploadEndpoint({UploadHosts:['tos-lq-x.snssdk.com'],StoreInfos:[{StoreUri:'image/test',Auth:'test'}],SessionKey:'test'}));

assert.doesNotThrow(()=>uploadEndpoint({UploadHosts:['tos-d-x-hl.douyin.com'],StoreInfos:[{StoreUri:'video/test',Auth:'test'}],SessionKey:'test'},'video'));
assert.throws(()=>uploadEndpoint({UploadHosts:['creator.douyin.com'],StoreInfos:[{StoreUri:'video/test',Auth:'test'}],SessionKey:'test'},'video'));

// HTTP 拒绝必须保留安全状态码和具体阶段，但不读取或拼接原始错误正文。
for(const index of [0,1,2]){
 const pipeline=mockPipeline({httpError:index});
 await assert.rejects(uploadImage(file,auth,pipeline.options),error=>{
  assert.equal(error.code,'UPLOAD_HTTP_ERROR');assert.equal(error.status,403);assert.equal(error.stage,['apply','upload','commit'][index]);
  assert.match(error.message,/HTTP 403/);assert.doesNotMatch(error.message+JSON.stringify(error),/example-storage-auth|https?:\/\/|example-secret/);
  return true;
 });
 assert.equal(pipeline.requests.length,index+1);
}
const request={url:'https://upload.example.bytedancevod.com/private?credential=hidden',method:'POST',headers:{Authorization:'hidden-auth'}};
for(const response of [
 {ok:true,json:async()=>{throw SyntaxError('hidden-auth raw response');}},
 {ok:true,json:async()=>null},
 {ok:true,json:async()=>['hidden-auth']},
 {ok:true,json:async()=>({ResponseMetadata:{Error:{Message:'hidden-auth raw response'}}})},
]){
 let calls=0;
 await assert.rejects(requestUploadJSON(request,{stage:'commit',fetch:async()=>{calls++;return response;}}),error=>{
  assert.ok(['UPLOAD_INVALID_RESPONSE','UPLOAD_REJECTED'].includes(error.code));assert.equal(error.stage,'commit');
  assert.match(error.message,/图片上传确认/);assert.doesNotMatch(error.message+JSON.stringify(error),/hidden-auth|credential|https?:\/\/|raw response/);
  return true;
 });
 assert.equal(calls,1);
}

// 注入可控 AbortSignal 覆盖真实网络等待，不让测试实际休眠五分钟。
const realTimeout=AbortSignal.timeout,delays=[],timeoutControllers=[];
AbortSignal.timeout=milliseconds=>{delays.push(milliseconds);const controller=new AbortController();timeoutControllers.push(controller);return controller.signal;};
try{
 const complete=mockPipeline();await uploadImage(file,auth,complete.options);
 assert.deepEqual(delays,[60000,300000,60000]);
 for(const index of [0,1,2]){
  delays.length=0;timeoutControllers.length=0;
  const pipeline=mockPipeline(),send=pipeline.options.fetch;
  pipeline.options.fetch=async(url,options)=>{
   const response=await send(url,options);
   if(pipeline.requests.length-1!==index)return response;
   return new Promise((resolve,reject)=>{
    options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});
    queueMicrotask(()=>timeoutControllers.at(-1).abort(new DOMException('hidden-auth timeout URL','TimeoutError')));
   });
  };
  await assert.rejects(uploadImage(file,auth,pipeline.options),error=>{
   assert.equal(error.code,'UPLOAD_TIMEOUT');assert.equal(error.stage,['apply','upload','commit'][index]);
   assert.match(error.message,index===1?/300 秒/:/60 秒/);
   assert.doesNotMatch(error.message+JSON.stringify(error),/hidden-auth|https?:\/\/|timeout URL/);
   return true;
  });
  assert.equal(pipeline.requests.length,index+1,'timeouts must never automatically resend an unknown upload');
  assert.deepEqual(delays,[60000,300000,60000].slice(0,index+1));
 }

 // 响应体读取超时也须归为超时，不能误报 JSON 格式错误。
 await assert.rejects(requestUploadJSON(request,{stage:'commit',fetch:async()=>({ok:true,json:async()=>{
  timeoutControllers.at(-1).abort(new DOMException('hidden body details','TimeoutError'));throw Error('hidden body details');
 }})}),error=>error.code==='UPLOAD_TIMEOUT'&&error.stage==='commit');

 // 主动取消与超时保持不同诊断；默认视频调用仍使用原来的 60 秒和通用阶段。
 const cancelled=new AbortController();
 await assert.rejects(requestUploadJSON(request,{stage:'upload',signal:cancelled.signal,fetch:async()=>{
  cancelled.abort();throw Error('hidden cancellation details');
 }}),error=>error.code==='UPLOAD_CANCELLED'&&error.stage==='upload');
 delays.length=0;
 await assert.rejects(requestUploadJSON(request,{kind:'video',fetch:async()=>{throw Error('hidden video details');}}),error=>error.code==='UPLOAD_NETWORK_ERROR'&&error.stage==='request'&&/视频上传请求失败/.test(error.message));
 assert.deepEqual(delays,[60000]);
 for(const timeoutMs of [0,-1,NaN,Infinity,300001]){
  let called=false;
  await assert.rejects(requestUploadJSON(request,{timeoutMs,fetch:async()=>{called=true;}}),error=>error.code==='UPLOAD_INVALID_TIMEOUT');
  assert.equal(called,false);
 }
}finally{AbortSignal.timeout=realTimeout;}
console.log('PASS safe per-stage HTTP/network/response/timeout diagnosis, five-minute image binary bound, sixty-second metadata bounds and no automatic retries');
