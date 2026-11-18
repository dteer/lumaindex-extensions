import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

// 独立回归使用生产音乐模块和真实 audio，仅用本地静音 WAV 与合成封面代替平台资源。
const root = fileURLToPath(new URL('../app/', import.meta.url));
const output = fileURLToPath(new URL('../output/playwright/', import.meta.url));
await mkdir(output, {recursive: true});
const wav = Buffer.alloc(44 + 8000 * 2 * 30);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/studio.css"><link rel="stylesheet" href="/studio-resources.css"><link rel="stylesheet" href="/studio-music.css"><style>body{background:#ddd}#search-dialog #search-results{margin-top:18px}#search-results{overflow:auto}</style></head><body><dialog id="search-dialog" class="music-drawer"><div class="dialog-header"><h2>选择音乐</h2><button id="close" aria-label="关闭音乐">×</button></div><form class="search-bar"><input id="search-query" placeholder="搜索音乐"></form><div class="music-tabs"><span class="active">推荐</span></div><div id="search-results" class="search-results"></div><div id="music-playback" hidden></div><p id="music-footnote" class="music-footnote">音乐封面以发布后播放页面展示为准</p></dialog><audio id="music-player" hidden></audio><script type="module">
import {mountMusicDrawer} from '/studio-music.js';
window.selected=[];
window.selectHandler=item=>{selected.push(item.id);drawer.render({items,selectedId:item.id});};
window.refreshRequests=[];
window.refreshHandler=async item=>item;
window.items=[
{id:'one',name:'【慌啥子嘛慢慢来】的原声',description:'Loki',duration:999,userCount:93000},
{id:'two',name:'@村口吴老二创作的原声',description:'村口吴老二',duration:30,userCount:1672000},
{id:'three',name:'慌啥子嘛（赵本山）（剪辑版）',description:'如水似冰',duration:29,userCount:701000},
{id:'four',name:'@。创作的原声',description:'.',duration:36,userCount:4855},
{id:'five',name:'Something to Hope For',description:'Phoebe Ryan',duration:60,userCount:46000},
{id:'six',name:'@Sen森屿美甲工厂店创作的原声',description:'Sen森屿美甲工厂店',duration:23,userCount:4},
{id:'seven',name:'人生路漫漫主题歌',description:'白小白',duration:26,userCount:30873000},
].map((item,index)=>({...item,thumbnailURL:location.origin+'/cover.svg?index='+index,previewURL:location.origin+'/song.wav?id='+item.id}));
window.drawer=mountMusicDrawer({results:document.querySelector('#search-results'),footer:document.querySelector('#music-playback'),audio:document.querySelector('#music-player'),safeURL:value=>{try{const url=new URL(value);return url.origin===location.origin?url.href:'';}catch{return '';}},onSelect:item=>selectHandler(item),refreshPreview:(item,{signal})=>{const request={id:item.id,aborted:false};refreshRequests.push(request);signal.addEventListener('abort',()=>{request.aborted=true;},{once:true});return refreshHandler(item,{signal});}});
drawer.render({items});document.querySelector('#search-dialog').showModal();document.querySelector('#close').onclick=()=>{drawer.stop();document.querySelector('#search-dialog').close();};window.ready=true;
</script></body></html>`;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
  if (url.pathname === '/song.wav') { response.setHeader('Content-Type', 'audio/wav'); response.end(wav); return; }
  if (['/bad.wav', '/failed.wav'].includes(url.pathname)) { response.setHeader('Content-Type', 'audio/wav'); response.end('invalid audio fixture'); return; }
  if (url.pathname === '/cover.svg') {
    const colors = ['#ecae7d', '#91a0a5', '#b8c991', '#ead0ca', '#96919d', '#b99182', '#aac6d4'];
    response.setHeader('Content-Type', 'image/svg+xml'); response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="${colors[Number(url.searchParams.get('index'))] || colors[0]}"/><circle cx="83" cy="32" r="18" fill="#fff9"/><path d="M0 120 40 40 85 98 120 67v53Z" fill="#0003"/></svg>`); return;
  }
  const file = resolve(root, '.' + url.pathname);
  if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
  try { response.setHeader('Content-Type', ({'.js': 'text/javascript', '.css': 'text/css'})[extname(file)] || 'application/octet-stream'); response.end(await readFile(file)); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
try {
  const page = await browser.newPage({viewport: {width: 980, height: 1030}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let releaseAudio;
  // 延迟音频响应，确认加载前不出现假进度或播放动效。
  await page.route('**/song.wav?id=one', async route => { await new Promise(resolve => { releaseAudio = resolve; }); await route.fulfill({status: 200, headers: {'Accept-Ranges': 'bytes', 'Content-Length': String(wav.length)}, contentType: 'audio/wav', body: wav}); });
  await page.goto(origin);
  await page.waitForFunction(() => window.ready);
  assert.equal(await page.locator('.studio-music-row').count(), 7);
  assert.equal(await page.locator('#music-playback').isHidden(), true);
  const first = page.locator('.studio-music-row[data-music-id=one]');
  await first.locator('.studio-music-listen').click();
  await page.waitForFunction(() => !document.querySelector('#music-playback').hidden);
  assert.equal(await first.evaluate(row => row.classList.contains('is-playing')), false);
  assert.equal(await page.locator('.studio-music-progress').isDisabled(), true);
  assert.match(await page.locator('.studio-music-time').textContent(), /--:--/);
  assert.equal(await page.locator('#music-footnote').isHidden(), true);
  while (!releaseAudio) await new Promise(resolve => setTimeout(resolve, 5));
  releaseAudio();
  await page.waitForFunction(() => document.querySelector('.studio-music-row').classList.contains('is-playing'));
  assert.equal(await page.locator('#music-player').evaluate(audio => audio.duration), 30, 'footer duration must use actual metadata, not candidate 999 seconds');
  assert.match(await page.locator('.studio-music-time').textContent(), /00:30$/);
  assert.equal(await page.locator('.studio-music-progress').isDisabled(), false);
  assert.equal(await first.locator('.studio-music-usage').isVisible(), true);
  assert.equal(await first.locator('.studio-music-use').isVisible(), true);
  assert.equal(await first.locator('.studio-music-name').evaluate(element => getComputedStyle(element).color), 'rgb(86, 132, 255)');
  await page.locator('.studio-music-progress').evaluate(input => { input.value = '135'; input.dispatchEvent(new Event('input', {bubbles: true})); });
  assert.ok(await page.locator('#music-player').evaluate(audio => audio.currentTime >= 4 && audio.currentTime < 5));
  await page.screenshot({path: output + 'studio-music-reference.png'});
  await first.locator('.studio-music-listen').click();
  assert.equal(await page.locator('#music-player').evaluate(audio => audio.paused), true);
  assert.equal(await first.evaluate(row => row.classList.contains('is-playing')), false);
  assert.equal(await first.locator('.studio-music-equalizer').isVisible(), false);
  await page.getByRole('button', {name: '播放试听', exact: true}).click();
  await page.waitForFunction(() => !document.querySelector('#music-player').paused);
  await first.locator('.studio-music-use').click();
  assert.deepEqual(await page.evaluate(() => selected), ['one']);
  assert.equal(await first.locator('.studio-music-use').textContent(), '已使用');
  assert.equal(await first.locator('.studio-music-use').isDisabled(), true);
  assert.ok(await page.locator('#music-player').evaluate(audio => audio.currentTime >= 4), 'choosing music must not restart playback');
  await page.getByRole('button', {name: '静音', exact: true}).click();
  assert.equal(await page.locator('#music-player').evaluate(audio => audio.muted), true);
  await page.getByRole('button', {name: '取消静音', exact: true}).click();
  assert.equal(await page.locator('#music-player').evaluate(audio => audio.muted), false);
  await page.locator('.studio-music-volume').evaluate(input => { input.value = '.35'; input.dispatchEvent(new Event('input', {bubbles: true})); });
  assert.equal(await page.locator('#music-player').evaluate(audio => audio.volume), .35);
  const second = page.locator('.studio-music-row[data-music-id=two]');
  await second.locator('.studio-music-listen').focus();
  await page.evaluate(() => drawer.render({items, selectedId: 'one'}));
  assert.equal(await second.locator('.studio-music-listen').evaluate(button => document.activeElement === button), true, 're-render must preserve keyboard focus');
  await page.keyboard.press('Space');
  await page.waitForFunction(() => document.querySelector('[data-music-id=two]').classList.contains('is-playing'));
  assert.match(await page.locator('.studio-music-player-heading').textContent(), /村口吴老二/);
  assert.equal(await second.locator('.studio-music-usage').isVisible(), true);
  await page.keyboard.press('Tab');
  assert.equal(await second.locator('.studio-music-use').evaluate(button => document.activeElement === button), true);
  await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => selected), ['one', 'two']);
  await page.setViewportSize({width: 420, height: 850});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.locator('#search-dialog').evaluate(dialog => dialog.scrollWidth > dialog.clientWidth), false, 'music drawer must not overflow on narrow windows');
  await page.screenshot({path: output + 'studio-music-narrow.png'});
  await page.evaluate(() => drawer.play({...items[0], id: 'broken', previewURL: location.origin + '/bad.wav'}));
  await page.locator('.studio-music-playback-status').filter({hasText: /试听音频暂时无法播放|暂时无法试听/}).waitFor();
  assert.equal(await page.locator('.studio-music-row.is-playing').count(), 0);
  assert.equal(await page.locator('.studio-music-progress').isDisabled(), true);
  // 真实 WebKit 的媒体 error 可以与 paused=false 并存；Chromium 只模拟该状态位，错误与恢复音频均真实加载。
  assert.equal(await page.locator('#music-player').evaluate(audio => !!audio.error), true);
  await page.route('**/bad.wav', route => route.fulfill({status: 200, contentType: 'audio/wav', body: wav}));
  const retry = await page.evaluate(() => {
    const audio = document.querySelector('#music-player');
    Object.defineProperty(audio, 'paused', {configurable: true, get: () => false});
    try { return drawer.play({...items[0], id: 'broken', previewURL: location.origin + '/bad.wav'}); }
    finally { delete audio.paused; }
  });
  assert.equal(retry?.ok, true, 'same URL with a media error must reload and play on the first retry');
  await page.waitForFunction(() => !document.querySelector('#music-player').paused && !document.querySelector('#music-player').error && document.querySelector('#music-player').readyState >= 2);
  assert.equal(await page.locator('.studio-music-playback-status').isHidden(), true);
  const endedAudio = Buffer.from(wav.subarray(0, 44 + 8000 * 2));
  endedAudio.writeUInt32LE(endedAudio.length - 8, 4); endedAudio.writeUInt32LE(endedAudio.length - 44, 40);
  await page.route('**/ended.wav', route => route.fulfill({status: 200, contentType: 'audio/wav', body: endedAudio}));
  await page.evaluate(() => drawer.play({...items[0], id: 'ended', previewURL: location.origin + '/ended.wav'}));
  await page.waitForFunction(() => document.querySelector('#music-player').ended);
  const replay = await page.evaluate(() => {
    const audio = document.querySelector('#music-player');
    Object.defineProperty(audio, 'paused', {configurable: true, get: () => false});
    try { return drawer.play({...items[0], id: 'ended', previewURL: location.origin + '/ended.wav'}); }
    finally { delete audio.paused; }
  });
  assert.equal(replay?.ok, true, 'ended audio must restart even when paused=false');
  assert.ok(await page.locator('#music-player').evaluate(audio => audio.currentTime < 2 && !audio.ended));

  // 首播不请求恢复；媒体失败后仅下一次用户点击按相同身份取得新音源。
  await page.evaluate(() => {
    drawer.stop(); refreshRequests.length = 0;
    window.retryItem = {...items[0], id: 'refresh-source', previewURL: location.origin + '/failed.wav?case=refresh'};
    refreshHandler = async item => ({...item, previewURL: location.origin + '/song.wav?id=refreshed'});
    drawer.render({items: [retryItem, ...items]});
  });
  const refreshRow = page.locator('[data-music-id="refresh-source"] .studio-music-listen');
  await refreshRow.click();
  await page.waitForFunction(() => !!document.querySelector('#music-player').error);
  assert.equal(await page.evaluate(() => refreshRequests.length), 0);
  await refreshRow.click();
  await page.waitForFunction(() => document.querySelector('#music-player').currentSrc.endsWith('id=refreshed') && document.querySelector('#music-player').readyState >= 2 && !document.querySelector('#music-player').paused);
  assert.deepEqual(await page.evaluate(() => refreshRequests.map(item => item.id)), ['refresh-source']);
  assert.deepEqual(await page.evaluate(() => selected), ['one', 'two'], 'retry never applies music to the work');
  await refreshRow.click();
  assert.equal(await page.locator('#music-player').evaluate(audio => audio.paused), true);
  assert.equal(await page.evaluate(() => refreshRequests.length), 1, 'pause must not refresh the source');

  // 平台返回相同 URL 时仍允许这一次手动重载，短暂网络错误不要求地址必然变化。
  await page.evaluate(() => {
    refreshHandler = async item => item;
    window.sameRetry = {...items[0], id: 'same-source', previewURL: location.origin + '/failed.wav?case=same'};
    return drawer.play(sameRetry);
  });
  await page.route('**/failed.wav?case=same', route => route.fulfill({status: 200, contentType: 'audio/wav', body: wav}));
  assert.equal((await page.evaluate(() => drawer.play(sameRetry))).ok, true);
  assert.equal(await page.evaluate(() => refreshRequests.length), 2);

  // 刷新失败、缺音源、错误歌曲均明确反馈；不会自动循环查询或清除已选配乐。
  for (const mode of ['missing', 'mismatch', 'error']) {
    const result = await page.evaluate(async mode => {
      window.failedRetry = {...items[0], id: 'failed-' + mode, previewURL: location.origin + '/failed.wav?case=' + mode};
      await drawer.play(failedRetry);
      refreshHandler = async item => {
        if (mode === 'error') throw Error('平台音源暂时不可用，请稍后重试。');
        return {...item, ...(mode === 'missing' ? {previewURL: null} : {id: 'another-song'})};
      };
      const before = refreshRequests.length;
      const result = await drawer.play(failedRetry);
      return {result, requests: refreshRequests.length - before};
    }, mode);
    assert.equal(result.result.code, 'PLAYBACK_SOURCE_FAILED');
    assert.equal(result.requests, 1);
    assert.equal(await page.locator('.studio-music-playback-status').isVisible(), true);
    assert.equal(await page.locator('.studio-music-row.is-playing').count(), 0);
  }

  // 已选配乐的调用方自行恢复音源时可明确跳过抽屉刷新；新 URL 同样无需重复查询。
  const bypass = await page.evaluate(async () => {
    const before = refreshRequests.length;
    await drawer.play(failedRetry, {refreshOnFailure: false});
    const result = await drawer.play({...failedRetry, previewURL: location.origin + '/song.wav?id=caller-refreshed'});
    return {result, requests: refreshRequests.length - before};
  });
  assert.equal(bypass.result.ok, true);
  assert.equal(bypass.requests, 0);

  // 用户手势限制只提示再点，不能当作失效音源重新查询。
  const gesture = await page.evaluate(async () => {
    const audio = document.querySelector('#music-player'), original = audio.play;
    const item = {...items[0], id: 'gesture', previewURL: location.origin + '/song.wav?id=gesture'};
    const before = refreshRequests.length;
    audio.play = () => Promise.reject(new DOMException('gesture required', 'NotAllowedError'));
    try { const first = await drawer.play(item); const second = await drawer.play(item); return {first, second, requests: refreshRequests.length - before}; }
    finally { audio.play = original; }
  });
  assert.equal(gesture.first.code, 'PLAYBACK_GESTURE_REQUIRED');
  assert.equal(gesture.second.code, 'PLAYBACK_GESTURE_REQUIRED');
  assert.equal(gesture.requests, 0);

  // 延迟恢复期间禁止重复；切曲、关闭与销毁都会 abort，迟到的结果不得复活旧曲。
  for (const action of ['switch', 'stop', 'dispose']) {
    await page.evaluate(async action => {
      window.delayedItem = {...items[0], id: 'delayed-' + action, previewURL: location.origin + '/failed.wav?case=delayed-' + action};
      await drawer.play(delayedItem);
      refreshHandler = item => new Promise(resolve => { window.releaseRefresh = () => resolve({...item, previewURL: location.origin + '/song.wav?id=too-late'}); });
      window.pendingRefresh = drawer.play(delayedItem);
    }, action);
    assert.match(await page.locator('.studio-music-playback-status').textContent(), /正在重新获取/);
    assert.equal(await page.getByRole('button', {name: '播放试听', exact: true}).isDisabled(), true);
    const duplicate = await page.evaluate(() => drawer.play(delayedItem));
    assert.equal(duplicate.code, 'PLAYBACK_PENDING');
    const cancelled = await page.evaluate(async action => {
      const before = refreshRequests.length;
      if (action === 'switch') await drawer.play({...items[1], previewURL: location.origin + '/song.wav?id=switched'});
      else if (action === 'stop') drawer.stop();
      else drawer.dispose();
      releaseRefresh();
      return {result: await pendingRefresh, aborted: refreshRequests.at(-1).aborted, requests: refreshRequests.length - before};
    }, action);
    assert.equal(cancelled.result.code, 'PLAYBACK_CANCELLED');
    assert.equal(cancelled.aborted, true);
    assert.equal(cancelled.requests, 0);
    assert.equal(await page.locator('#music-player').evaluate(audio => audio.currentSrc.endsWith('id=too-late')), false);
  }
  await page.evaluate(() => { drawer.stop(); });
  assert.equal(await page.locator('#music-player').evaluate(audio => audio.paused && !audio.hasAttribute('src')), true);
  assert.equal(await page.locator('#music-playback').isHidden(), true);
  assert.equal(await page.locator('#music-footnote').isVisible(), true);
  await page.evaluate(() => { drawer.dispose(); drawer.dispose(); });
  assert.equal(await page.locator('.studio-music-row').count(), 0);
  assert.equal(await page.locator('#music-playback').innerText(), '');

  // 保存状态由宿主明确回传；真实点击不能重复提交，试听、滚动和关闭继续可用。
  const selectionPage = await browser.newPage({viewport: {width: 980, height: 560}});
  selectionPage.on('pageerror', error => errors.push(error.message));
  await selectionPage.goto(origin);
  await selectionPage.waitForFunction(() => window.ready);
  await selectionPage.evaluate(() => {
    window.selectionCalls = []; window.selectionClicks = []; window.selectedMusic = 'one';
    document.addEventListener('click', event => {
      if (event.target.closest('.studio-music-use')) selectionClicks.push(event.isTrusted);
    }, {capture: true});
    selectHandler = item => {
      selectionCalls.push(item.id);
      drawer.render({items, selectedId: selectedMusic, selectingId: item.id});
      window.finishSelection = success => {
        if (success) selectedMusic = item.id;
        drawer.render({items, selectedId: selectedMusic});
      };
    };
    drawer.render({items, selectedId: selectedMusic});
  });
  const savingRow = selectionPage.locator('[data-music-id=two]');
  const otherRow = selectionPage.locator('[data-music-id=three]');
  await savingRow.hover();
  await savingRow.locator('.studio-music-use').click();
  assert.deepEqual(await selectionPage.evaluate(() => selectionClicks), [true]);
  assert.equal(await savingRow.locator('.studio-music-use').textContent(), '保存中…');
  assert.equal(await savingRow.locator('.studio-music-use').getAttribute('aria-busy'), 'true');
  assert.equal(await selectionPage.locator('.studio-music-use:disabled').count(), 7);
  assert.equal(await selectionPage.locator('[data-music-id=one] .studio-music-use').textContent(), '已使用');
  await savingRow.locator('.studio-music-use').click({force: true});
  await otherRow.hover();
  await otherRow.locator('.studio-music-use').click({force: true});
  assert.deepEqual(await selectionPage.evaluate(() => selectionCalls), ['two'], 'disabled buttons must reject duplicate and alternate selections');
  await selectionPage.locator('#search-query').focus();
  await selectionPage.locator('.dialog-header').hover();
  assert.equal(await savingRow.locator('.studio-music-use').isVisible(), true, 'saving remains visible without hover, focus or playback');
  await otherRow.locator('.studio-music-listen').click();
  await selectionPage.waitForFunction(() => document.querySelector('[data-music-id=three]').classList.contains('is-playing') && document.querySelector('#music-player').currentTime > .1);
  assert.equal(await savingRow.locator('.studio-music-use').textContent(), '保存中…', 'real playback events must preserve the pending label');
  assert.equal(await savingRow.locator('.studio-music-use').getAttribute('aria-busy'), 'true');
  assert.equal(await selectionPage.locator('.studio-music-use:disabled').count(), 7);
  await selectionPage.getByRole('button', {name: '暂停试听', exact: true}).click();
  assert.equal(await selectionPage.locator('#music-player').evaluate(audio => audio.paused), true);
  await selectionPage.locator('#search-results').hover();
  await selectionPage.mouse.wheel(0, 500);
  await selectionPage.waitForFunction(() => document.querySelector('#search-results').scrollTop > 0);
  await selectionPage.evaluate(() => finishSelection(false));
  assert.equal(await savingRow.locator('.studio-music-use').getAttribute('aria-busy'), 'false');
  assert.equal(await savingRow.locator('.studio-music-use').textContent(), '使用');
  assert.equal(await selectionPage.locator('.studio-music-use:disabled').count(), 1, 'failed saving preserves the previous selection and unlocks the rest');
  await savingRow.hover();
  await savingRow.locator('.studio-music-use').click();
  await selectionPage.evaluate(() => finishSelection(true));
  assert.equal(await savingRow.locator('.studio-music-use').textContent(), '已使用');
  assert.equal(await savingRow.locator('.studio-music-use').getAttribute('aria-busy'), 'false');
  assert.equal(await selectionPage.locator('[data-music-id=one] .studio-music-use').isDisabled(), false);
  await otherRow.hover();
  await otherRow.locator('.studio-music-use').click();
  await selectionPage.getByRole('button', {name: '关闭音乐', exact: true}).click();
  assert.equal(await selectionPage.locator('#search-dialog').evaluate(dialog => dialog.open), false, 'pending selection must not trap the dialog');
  assert.deepEqual(await selectionPage.evaluate(() => selectionCalls), ['two', 'two', 'three']);
  await selectionPage.close();
  assert.deepEqual(errors, []);
  console.log('music UI passed: real audio, source refresh, selection pending state, duplicate prevention, independent playback/scroll/close and cleanup');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
