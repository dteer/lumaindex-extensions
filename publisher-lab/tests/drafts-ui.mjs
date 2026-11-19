import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

// 真实页面与草稿存储，client边界仅提供可控合成准备/回执；不接触用户草稿或真实上传发布。
const root = fileURLToPath(new URL('../app/', import.meta.url));
const output = fileURLToPath(new URL('../output/playwright/', import.meta.url));
await mkdir(output, {recursive: true});
const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#b7c2c8"/></svg>';
const wav = Buffer.alloc(44 + 16000);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);
const client = `
const fixture = window.fixture;
export const studioClient = {
  onStatus(callback) { fixture.status = callback; },
  async listAccounts() { return fixture.session; },
  request(operation, params, options = {}) {
    fixture.calls.push({operation, params: structuredClone(params)});
    if (!['publication.prepare','publication.publish','publication.status'].includes(operation)) throw Error('Unexpected synthetic request: '+operation);
    return new Promise((resolve,reject) => {
      fixture.pending[operation] = {resolve,reject};
      options.signal?.addEventListener('abort', () => { fixture.cancelled.push(operation); reject(new DOMException('Synthetic cancellation','AbortError')); }, {once:true});
    });
  },
};`;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/studio-client.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(client); return; }
  if (url.pathname === '/silence.wav') { response.setHeader('Content-Type', 'audio/wav'); response.end(wav); return; }
  if (url.pathname.startsWith('/api/v1/assets/')) {
    const parts = url.pathname.split('/'), id = parts[4];
    response.setHeader('Content-Type', parts.length > 5 ? 'image/svg+xml' : 'application/json');
    response.end(parts.length > 5 ? picture : JSON.stringify({code: 0, data: {id, name: id + '.jpg', mediaType: 'image', sizeBytes: 1000}})); return;
  }
  const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
  try { response.setHeader('Content-Type', ({'.js':'text/javascript','.css':'text/css','.html':'text/html','.json':'application/json'})[extname(file)] || 'application/octet-stream'); response.end(await readFile(file)); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
const errors = [], external = [];
async function openFixture() {
  const page = await browser.newPage({viewport: {width: 1280, height: 950}});
  page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    external.push(route.request().url()); return route.abort();
  });
  await page.addInitScript(({origin}) => {
    const draft = (id, status) => ({id, name: '合成草稿 ' + id.toUpperCase(), kind: 'image', title: '作品 ' + id,
      description: '保留中的正文 ' + id, assets: [{id:'asset-'+id,name:'图片 '+id,kind:'image'}], topics: [], mentions: [], activities: [],
      cover:{type:'asset',assetId:'asset-'+id}, settings:{visibility:'public',download:'allow',publishTime:'now',scheduledAt:'',declarations:[]},
      updatedAt:'2026-11-18T00:00:00Z', receipt:status ? {status,requestId:'request-'+id,publicationId:status === 'processing'?'123456':'',message:'原有提交记录',updatedAt:'2026-11-18T00:00:00Z'} : null});
    const state = {version:2,activeDraftId:'a',drafts:[draft('a'),draft('b','unknown'),draft('c','processing'),draft('d')]};
    window.fixture = {state:structuredClone(state), messages:[], calls:[], pending:{}, cancelled:[], failPersist:false,
      publicationRecords:{requests:{'request-b':{status:'unknown'},'request-c':{status:'processing',publicationId:'123456'}}},
      session:{connected:true,activeProfileId:'synthetic-profile',account:{id:'synthetic-account',name:'合成草稿账号'},profiles:[],
        capabilities:{operations:['publication.prepare','publication.publish','publication.status'],limits:{imageCount:35}}}};
    window.pluginContext = {nativeUIAvailable:true,nativeCapabilities:{sessionProfilesVersion:1},apiBaseURL:origin+'/api/v1',
      frontendState:state,libraryID:'draft-delete-fixture'};
    window.webkit={messageHandlers:{pluginUI:{postMessage:async message=>{
      fixture.messages.push(structuredClone(message));
      if(message.op!=='persist')throw Error('Draft deletion must only persist frontend state: '+message.op);
      if(fixture.failPersist){fixture.failPersist=false;throw Error('合成保存失败');}
      fixture.state=structuredClone(message.value);return {ok:true};
    }}}};
  }, {origin});
  await page.goto(origin);
  await page.waitForFunction(() => document.body.dataset.phase === 'editing' && !document.querySelector('#prepare').disabled);
  return page;
}
const row = (page, id) => page.locator('.draft-row[data-draft-id="'+id+'"]');
const state = page => page.evaluate(() => structuredClone(fixture.state));
const count = page => page.evaluate(() => fixture.messages.length);
async function drawer(page) { if (!await page.locator('#drafts-dialog').isVisible()) await page.locator('#open-drafts').click(); }
async function remove(page, id) { await drawer(page); await row(page,id).locator('.draft-delete').click(); await page.locator('#confirm-dialog[open]').waitFor(); }
async function settle(page) { await page.waitForFunction(() => document.querySelector('#save-state').textContent === '已保存至本机'); }
async function prepared(page) {
  await page.locator('#prepare').click(); await page.waitForFunction(() => !!fixture.pending['publication.prepare']);
  await page.evaluate(() => fixture.pending['publication.prepare'].resolve({preparationId:'synthetic-preparation',canPublish:true,account:fixture.session.account}));
  await page.waitForFunction(() => !document.body.classList.contains('busy') && !document.querySelector('#publish').disabled);
}
try {
  const page = await openFixture();
  await prepared(page);
  const original = await state(page), records = await page.evaluate(() => structuredClone(fixture.publicationRecords));
  await drawer(page);
  assert.equal(await page.locator('.draft-delete').count(), 4);
  for (const width of [1280,560]) {
    await page.setViewportSize({width,height:950});
    const bounds = await page.locator('#drafts-dialog').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x+bounds.width <= width+1);
    assert.equal(await page.locator('#draft-list').evaluate(node => node.scrollWidth > node.clientWidth), false);
    await page.screenshot({path:output+'studio-drafts-delete-'+width+'.png'});
  }
  await page.setViewportSize({width:1280,height:950});
  for (const cancel of ['button','escape']) {
    const before = await count(page);
    await remove(page,'b');
    assert.match(await page.locator('#confirm-content').textContent(), /不会撤销已提交的作品/);
    assert.match(await page.locator('#confirm-content').textContent(), /发布记录仍会保留/);
    assert.equal(await page.locator('#confirm-cancel').evaluate(node => node === document.activeElement), true);
    if(cancel==='button')await page.locator('#confirm-cancel').click(); else await page.keyboard.press('Escape');
    assert.deepEqual(await state(page),original); assert.equal(await count(page),before);
  }
  // 非当前草稿删除不能清空当前准备结果、改变编辑时间/光标，或停止已有播放。
  await page.evaluate(async () => {
    const input=document.querySelector('#description');input.setSelectionRange(2,4);
    const audio=document.querySelector('#music-player');audio.src='/silence.wav';audio.loop=true;await audio.play();
  });
  await remove(page,'b'); await page.locator('#confirm-submit').click();
  await page.waitForFunction(() => !fixture.state.drafts.some(item => item.id==='b')); await settle(page);
  assert.deepEqual((await state(page)).drafts.find(item=>item.id==='a'),original.drafts[0]);
  assert.equal((await state(page)).activeDraftId,'a'); assert.equal(await page.locator('#publish').isEnabled(),true);
  assert.deepEqual(await page.locator('#description').evaluate(node => [node.value,node.selectionStart,node.selectionEnd]),[original.drafts[0].description,2,4]);
  assert.equal(await page.locator('#music-player').evaluate(audio=>audio.paused),false);
  assert.deepEqual(await page.evaluate(() => fixture.publicationRecords),records);
  // 保存失败仍保留目标；processing和unknown一样允许显式删除。
  await page.evaluate(() => {fixture.failPersist=true;});
  await remove(page,'c');await page.locator('#confirm-submit').click();
  await page.locator('#page-notice').filter({hasText:'删除未保存，草稿已保留'}).waitFor();
  assert.equal(await row(page,'c').count(),1);
  assert.equal((await state(page)).drafts.some(item=>item.id==='c'),true);
  assert.equal(await page.locator('#publish').isEnabled(),true);
  await remove(page,'c');await page.locator('#confirm-submit').click();
  await page.waitForFunction(() => !fixture.state.drafts.some(item=>item.id==='c'));await settle(page);
  assert.deepEqual((await state(page)).drafts.find(item=>item.id==='a'),original.drafts[0]);
  // 删除当前草稿切到其余草稿，最后一份删除后保留一个新的空白入口。
  await remove(page,'a');await page.locator('#confirm-submit').click();
  await page.waitForFunction(() => fixture.state.activeDraftId==='d');await settle(page);
  assert.equal(await page.locator('#description').inputValue(),original.drafts[3].description);
  assert.equal(await row(page,'d').locator('.draft-item').getAttribute('aria-current'),'true');
  assert.equal(await page.locator('#publish').isDisabled(),true);
  await page.evaluate(() => {fixture.failPersist=true;});
  await remove(page,'d');await page.locator('#confirm-submit').click();
  await page.locator('#page-notice').filter({hasText:'删除未保存，草稿已保留'}).waitFor();
  assert.equal(await page.locator('.draft-row').count(),1);assert.equal(await row(page,'d').count(),1);
  assert.equal(await page.locator('#description').inputValue(),original.drafts[3].description);
  await remove(page,'d');await page.locator('#confirm-submit').click();
  await page.waitForFunction(() => fixture.state.drafts.length===1 && !['a','b','c','d'].includes(fixture.state.activeDraftId));await settle(page);
  const empty=(await state(page)).drafts[0];assert.equal(empty.title,'');assert.deepEqual(empty.assets,[]);assert.equal(empty.receipt,null);
  assert.deepEqual(await page.evaluate(() => fixture.publicationRecords),records);

  // 上传准备和发布期间，列表及原有删除入口都遵守同一必要锁。
  const busy = await openFixture();
  await busy.locator('#prepare').click();await busy.waitForFunction(()=>!!fixture.pending['publication.prepare']);
  assert.equal(await busy.locator('#delete-draft').isDisabled(),true);
  assert.equal(await busy.locator('.draft-delete:disabled').count(),4);
  assert.equal(await busy.locator('.draft-item:disabled').count(),4, 'preparation locks existing draft buttons without rebuilding rows');
  await row(busy,'b').locator('.draft-delete').evaluate(button=>button.click());
  assert.equal(await busy.locator('#confirm-dialog').isVisible(),false);
  await busy.evaluate(()=>fixture.pending['publication.prepare'].resolve({preparationId:'synthetic-preparation',canPublish:true,account:fixture.session.account}));
  await busy.waitForFunction(()=>!document.body.classList.contains('busy'));
  assert.equal(await busy.locator('.draft-item:disabled').count(),0, 'draft buttons unlock after preparation');
  await busy.locator('#publish').click();await busy.locator('#confirm-content input[type=checkbox]').check();await busy.locator('#confirm-submit').click();
  await busy.waitForFunction(()=>!!fixture.pending['publication.publish']);
  assert.equal(await busy.locator('.draft-delete:disabled').count(),4);
  await busy.locator('#delete-draft').evaluate(button=>button.click());
  assert.equal(await busy.locator('#confirm-dialog').isVisible(),false);
  assert.equal((await state(busy)).drafts.length,4);
  await busy.evaluate(()=>fixture.pending['publication.publish'].resolve({status:'processing',publicationId:'synthetic-published',message:'合成回执'}));
  await busy.waitForFunction(()=>!document.body.classList.contains('busy'));
  // 状态查询可独立取消；删除原稿后迟到回执不得使它复活。
  await busy.locator('#status-shortcut').click();await busy.waitForFunction(()=>!!fixture.pending['publication.status']);
  await remove(busy,'a');await busy.locator('#confirm-submit').click();
  await busy.waitForFunction(()=>!fixture.state.drafts.some(item=>item.id==='a'));await settle(busy);
  assert.equal(await busy.evaluate(()=>fixture.cancelled.includes('publication.status')),true);
  await busy.evaluate(()=>fixture.pending['publication.status'].resolve({status:'processing',publicationId:'late-result'}));
  await busy.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal((await state(busy)).drafts.some(item=>item.id==='a'),false);
  for(const candidate of [page,busy])assert.equal(await candidate.evaluate(()=>fixture.messages.some(item=>item.op!=='persist')),false);
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  console.log('drafts UI passed: per-row delete, cancel/Escape, unknown/processing receipts, active/last draft, failure restoration, unaffected editor/prepared/audio, busy lock, late query cancellation, 1280/560 layouts and local-only writes');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
