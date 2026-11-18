import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

// 使用生产入口和同一生产播放器，模拟平台回复；真实本地 WAV 验证恢复草稿后的播放与失效重查。
const root = fileURLToPath(new URL('../app/', import.meta.url));
const wav = Buffer.alloc(44 + 8000 * 2 * 30);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/studio.css"><link rel="stylesheet" href="/studio-resources.css"><link rel="stylesheet" href="/studio-music.css"><div class="music-field"><button id="icon" class="music-field-icon"></button><span>日落黄昏（吉他曲）</span><button id="listen">试听</button></div><div id="results"></div><div id="footer"></div><p id="notice"></p><audio id="audio"></audio><script type="module">
import {mountSavedMusicPreview} from '/studio-saved-music.js';
import {mountMusicDrawer} from '/studio-music.js';
const $=id=>document.getElementById(id);
window.state={draftId:'draft-1',kind:'image',profileId:'profile-1',accountId:'account-1',connected:true,music:{id:'song-1',name:'日落黄昏（吉他曲）'}};
window.calls=[];window.errors=[];window.waiting=[];window.mode='normal';window.clickPhase=false;window.playCalls=[];
const audio=$('audio'), originalPlay=audio.play.bind(audio);
audio.play=()=>{window.playCalls.push(window.clickPhase);if(window.mode==='gesture'){window.mode='normal';return Promise.reject(new DOMException('Needs gesture','NotAllowedError'));}return originalPlay();};
const safeURL=value=>{try {const url=new URL(value);return url.origin===location.origin?url.href:'';}catch{return '';}};
window.drawer=mountMusicDrawer({results:$('results'),footer:$('footer'),audio,safeURL,onSelect:()=>{throw Error('Preview must never replace selected music');}});
window.preview=mountSavedMusicPreview({button:$('listen'),iconButton:$('icon'),audio,current:()=>window.state,
 ensureSession:async()=>{window.state.connected=true;window.state.accountId='account-1';},
 request:async(op,params,{signal})=>{
  const entry={op,...params,signal};window.calls.push(entry);
  if(window.mode==='hold') await new Promise(resolve=>window.waiting.push(resolve));
  const item={...window.state.music,previewURL:location.origin+(window.mode==='expired'&&window.calls.length===1?'/bad.wav':'/song.wav')};
  if(window.mode==='missing') return {items:[{...item,id:'different-song'}],nextCursor:null};
  if(window.mode==='cycle') return {items:[],nextCursor:'0'};
  if(window.mode==='bounded') return {items:[],nextCursor:String(Number(params.cursor)+1)};
  if(window.mode==='pages'&&params.cursor==='0') return {items:[{...item,id:'different-song'},{...item,name:item.name.slice(0,100)}],nextCursor:'20'};
  return {items:[item],nextCursor:null};
 },play:item=>drawer.play(item),stop:()=>drawer.stop(),safeURL,onError:message=>{window.errors.push(message);$('notice').textContent=message;}});
for(const id of ['listen','icon']) { const handler=$(id).onclick; $(id).onclick=event=>{window.clickPhase=true;try{return handler(event);}finally{window.clickPhase=false;}}; }
preview.render();window.ready=true;
</script>`;
const server = createServer(async (request,response)=>{
  const url=new URL(request.url,'http://localhost');
  if(url.pathname==='/'){response.setHeader('Content-Type','text/html');response.end(html);return;}
  if(url.pathname==='/song.wav'){response.setHeader('Content-Type','audio/wav');response.end(wav);return;}
  if(url.pathname==='/bad.wav'){response.setHeader('Content-Type','audio/wav');response.end('expired audio fixture');return;}
  const file=resolve(root,'.'+url.pathname);
  if(!file.startsWith(root)){response.writeHead(403).end();return;}
  try{response.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css'})[extname(file)]||'application/octet-stream');response.end(await readFile(file));}catch{response.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{})});
try {
 const page=await browser.newPage(), pageErrors=[];
 page.on('pageerror',error=>pageErrors.push(error.message));
 const reset=async()=>{await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>window.ready);};
 const playing=async()=>page.waitForFunction(()=>!document.getElementById('audio').paused&&document.getElementById('audio').readyState>=2);
 await reset();
 assert.equal(await page.locator('#listen').isVisible(),true);
 assert.equal(await page.locator('#icon').isEnabled(),true);
 assert.equal(await page.evaluate(()=>calls.length),0,'restore/render must not query music before user action');
 await page.locator('#icon').click();await playing();
 assert.equal(await page.evaluate(()=>calls.length),1);
 assert.equal(await page.locator('#listen').textContent(),'暂停');
 assert.deepEqual(await page.evaluate(()=>state.music),{id:'song-1',name:'日落黄昏（吉他曲）'});
 await page.locator('#listen').click();assert.equal(await page.locator('#audio').evaluate(audio=>audio.paused),true);
 await page.locator('#icon').click();await playing();assert.equal(await page.evaluate(()=>calls.length),1,'pause/resume reuses only the current in-memory URL');
 await reset();
 assert.equal(await page.evaluate(()=>calls.length),0);await page.locator('#listen').click();await playing();assert.equal(await page.evaluate(()=>calls.length),1,'reopening resolves a fresh preview URL');

 // 同名异曲、同 ID 截断名称均不能命中；搜索只发送最多 100 字，身份核对使用完整名称。
 await reset();await page.evaluate(()=>{mode='pages';state.music.name='长'.repeat(105);preview.render();});
 await page.locator('#listen').click();await playing();
 assert.deepEqual(await page.evaluate(()=>calls.map(call=>call.cursor)),['0','20']);
 assert.equal(await page.evaluate(()=>calls[0].query.length),100);
 assert.equal(await page.evaluate(()=>state.music.name.length),105);
 for(const scenario of ['missing','cycle','bounded']) {
  await reset();await page.evaluate(value=>{mode=value;},scenario);await page.locator('#listen').click();
  await page.waitForFunction(()=>errors.length>0);
  assert.equal(await page.evaluate(()=>playCalls.length),0);
  assert.equal(await page.evaluate(()=>calls.length),scenario==='bounded'?5:1);
  assert.equal(await page.evaluate(()=>state.music.id),'song-1');
 }

 // 请求不理会取消信号时，也不能在换账号、换稿或换歌以后开始播放旧回复。
 for(const change of ['account','profile','draft','music','clear','reset']) {
  await reset();await page.evaluate(()=>{mode='hold';});await page.locator('#listen').click();
  await page.waitForFunction(()=>waiting.length===1);
  await page.evaluate(change=>{
   if(change==='account')state.accountId='account-2';
   if(change==='profile')state.profileId='profile-2';
   if(change==='draft')state.draftId='draft-2';
   if(change==='music')state.music={id:'song-2',name:'新配乐'};
   if(change==='clear')state.music=null;
   if(change==='reset')preview.reset();else preview.render();
   waiting.splice(0).forEach(resolve=>resolve());
  },change);
  await page.waitForFunction(()=>!document.getElementById('listen').disabled);
  assert.equal(await page.evaluate(()=>calls[0].signal.aborted),true);
  assert.equal(await page.evaluate(()=>playCalls.length),0);
  assert.deepEqual(await page.evaluate(()=>errors),[]);
 }

 // 过期媒体失败后由再次点击重新解析；不会替换作品音乐，也不会自动无限重试。
 await reset();await page.evaluate(()=>{mode='expired';});await page.locator('#listen').click();
 await page.waitForFunction(()=>errors.length>0&&!document.getElementById('listen').disabled);
 assert.equal(await page.evaluate(()=>calls.length),1);
 await page.locator('#listen').click();await playing();
 assert.equal(await page.evaluate(()=>calls.length),2);
 assert.deepEqual(await page.evaluate(()=>state.music),{id:'song-1',name:'日落黄昏（吉他曲）'});

 // WKWebView 可能阻止异步恢复后的首次 play；保留有效 URL，第二次真实点击同步 play。
 await reset();await page.evaluate(()=>{mode='gesture';});await page.locator('#listen').click();
 await page.waitForFunction(()=>errors.some(text=>text.includes('再次点击播放')));
 assert.equal(await page.evaluate(()=>calls.length),1);
 await page.locator('#listen').click();await playing();
 assert.equal(await page.evaluate(()=>calls.length),1,'NotAllowedError must not be treated as expired URL');
 assert.deepEqual(await page.evaluate(()=>playCalls),[false,true],'cached retry must reach audio.play in the click stack');
 await page.evaluate(()=>{state.accountId='account-2';preview.render();});
 assert.equal(await page.locator('#audio').evaluate(audio=>audio.paused&&!audio.hasAttribute('src')),true);
 await page.evaluate(()=>{preview.dispose();drawer.dispose();});
 assert.deepEqual(pageErrors,[]);
 console.log('saved music UI passed: restored entry, strict paged identity lookup, real playback/pause, fresh URLs, bounded lookup, account/draft/selection cancellation, expired media retry and gesture-safe retry');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
