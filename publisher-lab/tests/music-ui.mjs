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
window.items=[
{id:'one',name:'【慌啥子嘛慢慢来】的原声',description:'Loki',duration:999,userCount:93000},
{id:'two',name:'@村口吴老二创作的原声',description:'村口吴老二',duration:30,userCount:1672000},
{id:'three',name:'慌啥子嘛（赵本山）（剪辑版）',description:'如水似冰',duration:29,userCount:701000},
{id:'four',name:'@。创作的原声',description:'.',duration:36,userCount:4855},
{id:'five',name:'Something to Hope For',description:'Phoebe Ryan',duration:60,userCount:46000},
{id:'six',name:'@Sen森屿美甲工厂店创作的原声',description:'Sen森屿美甲工厂店',duration:23,userCount:4},
{id:'seven',name:'人生路漫漫主题歌',description:'白小白',duration:26,userCount:30873000},
].map((item,index)=>({...item,thumbnailURL:location.origin+'/cover.svg?index='+index,previewURL:location.origin+'/song.wav?id='+item.id}));
window.drawer=mountMusicDrawer({results:document.querySelector('#search-results'),footer:document.querySelector('#music-playback'),audio:document.querySelector('#music-player'),safeURL:value=>{try{const url=new URL(value);return url.origin===location.origin?url.href:'';}catch{return '';}},onSelect:item=>{selected.push(item.id);drawer.render({items,selectedId:item.id});}});
drawer.render({items});document.querySelector('#search-dialog').showModal();document.querySelector('#close').onclick=()=>{drawer.stop();document.querySelector('#search-dialog').close();};window.ready=true;
</script></body></html>`;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
  if (url.pathname === '/song.wav') { response.setHeader('Content-Type', 'audio/wav'); response.end(wav); return; }
  if (url.pathname === '/bad.wav') { response.setHeader('Content-Type', 'audio/wav'); response.end('invalid audio fixture'); return; }
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
  await page.locator('.studio-music-playback-status').filter({hasText: '此音乐暂时无法试听'}).waitFor();
  assert.equal(await page.locator('.studio-music-row.is-playing').count(), 0);
  assert.equal(await page.locator('.studio-music-progress').isDisabled(), true);
  await page.evaluate(() => { drawer.stop(); });
  assert.equal(await page.locator('#music-player').evaluate(audio => audio.paused && !audio.hasAttribute('src')), true);
  assert.equal(await page.locator('#music-playback').isHidden(), true);
  assert.equal(await page.locator('#music-footnote').isVisible(), true);
  await page.evaluate(() => { drawer.dispose(); drawer.dispose(); });
  assert.equal(await page.locator('.studio-music-row').count(), 0);
  assert.equal(await page.locator('#music-playback').innerText(), '');
  assert.deepEqual(errors, []);
  console.log('music UI passed: reference rows, real audio metadata/play/pause, seek, volume, stable keyboard focus, select, narrow layout, playback errors and cleanup');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
