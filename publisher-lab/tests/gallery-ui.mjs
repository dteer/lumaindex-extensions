import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

// 此回归仅挂载生产图库模块，不连接平台账号、原生桥接或发布接口。
const app = fileURLToPath(new URL('../app/', import.meta.url));
const output = fileURLToPath(new URL('../output/playwright/', import.meta.url));
await mkdir(output, {recursive: true});
const fixture = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/studio.css"><link rel="stylesheet" href="/studio-gallery.css"><style>body{padding:40px}.fixture{display:grid;grid-template-columns:640px 240px;gap:40px;align-items:start;max-width:100%}#gallery{min-width:0}#preview{width:240px}@media(max-width:800px){.fixture{grid-template-columns:minmax(0,1fr)}body{padding:12px}}</style></head><body><div class="fixture"><div id="gallery"></div><div id="preview"></div></div><script type="module">
import {mountStudioGallery,mountDouyinPreview} from '/studio-gallery.js';
const svg=(color,width,height)=>'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'"><rect width="100%" height="100%" fill="'+color+'"/><circle cx="50%" cy="45%" r="12%" fill="#ffffff70"/><path d="M0 '+height+' '+width*.4+' '+height*.4+' '+width+' '+height+'Z" fill="#0003"/></svg>');
window.assets=Object.freeze([{id:'landscape',url:svg('#a7b4b8',1200,850),alt:'海边图片.jpg',kind:'image'},{id:'portrait',url:svg('#879c8f',850,1200),alt:'树林图片.jpg',kind:'image'},{id:'square',url:svg('#c6aaa3',900,900),alt:'建筑图片.jpg',kind:'image'}].map(Object.freeze));
window.changes=[];window.reorders=[];window.currentIndex=0;
// 同步两处预览时 render 不应反向产生新的位置变化回调。
function changed(index){window.changes.push(index);window.currentIndex=index;window.renderAll();}
// 合成宿主通过素材身份保留预览焦点；画廊只报告排序意图，不自行改动传入列表。
function reorder(from,to){window.reorders.push([from,to]);const currentID=window.assets[window.currentIndex]?.id;const values=[...window.assets];const source=values.findIndex(asset=>asset.id===from),target=values.findIndex(asset=>asset.id===to);const [moving]=values.splice(source,1);values.splice(target,0,moving);window.assets=values;window.currentIndex=values.findIndex(asset=>asset.id===currentID);window.renderAll();}
window.gallery=mountStudioGallery(document.querySelector('#gallery'),{onIndexChange:changed,onReorder:reorder});
window.preview=mountDouyinPreview(document.querySelector('#preview'),{onIndexChange:changed});
window.renderAll=()=>{const value={assets:window.assets,index:window.currentIndex,accountName:'摄影日志',title:'#话题',description:'海风与远处的船',musicName:'摄影日志创作的原声'};window.gallery.render(value);window.preview.render(value);};window.renderAll();window.ready=true;
</script></body></html>`;
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(fixture); return; }
  if (!['/studio-gallery.js', '/studio-gallery.css', '/studio.css', '/preview-wheel.js'].includes(pathname)) { response.writeHead(404).end(); return; }
  try {
    response.setHeader('Content-Type', pathname.endsWith('.js') ? 'text/javascript' : 'text/css');
    response.end(await readFile(app + pathname));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
try {
  const page = await browser.newPage({viewport: {width: 1080, height: 900}, hasTouch: true});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => window.ready);
  assert.equal(await page.locator('.studio-gallery-image').count(), 3);
  assert.equal(await page.locator('#gallery').innerText(), '', 'the editor image area must contain images only');
  assert.deepEqual(await page.evaluate(() => changes), [], 'render cannot trigger user-navigation callbacks');
  assert.equal(await page.locator('.studio-phone').getAttribute('aria-label'), '抖音手机预览');
  const progress = page.getByRole('tablist', {name: '图片浏览进度'});
  const segments = progress.getByRole('tab');
  const activeSegment = () => progress.getByRole('tab', {selected: true});
  assert.equal(await segments.count(), 3);
  assert.equal(await activeSegment().getAttribute('aria-label'), '查看第 1 张，共 3 张');
  assert.equal(await page.getByRole('slider').count(), 0, 'each image gets a discrete line, not a continuous range');
  // 同原助手一样，网页滚轮按主轴切换；事件位置用于模拟 WebKit 捕获阶段的原生路由。
  async function wheelAt(locator, values) {
    const bounds = await locator.boundingBox();
    await locator.dispatchEvent('wheel', {clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2, ...values});
  }
  async function nativeWheelAt(locator, values) {
    const bounds = await locator.boundingBox();
    await page.evaluate(input => window.dispatchEvent(new CustomEvent('luma:scroll', {detail: input})),
      {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, deltaX: 0, deltaY: 0, phased: true, ...values});
  }
  for (const text of ['直播', '同城', '关注', '推荐', '赞', '评论', '收藏', '分享', '首页', '朋友', '+', '消息', '我']) {
    assert.ok((await page.locator('.studio-phone').innerText()).includes(text), `reference phone element missing: ${text}`);
  }
  await page.screenshot({path: output + 'studio-gallery-reference.png'});
  await page.locator('.studio-gallery-image').nth(1).click();
  assert.equal(await page.locator('.studio-gallery-lightbox').evaluate(el => el.open), true);
  assert.equal(await page.locator('.studio-gallery-lightbox-surface .is-current img').getAttribute('alt'), '树林图片.jpg');
  assert.deepEqual(await page.evaluate(() => changes), [1]);
  assert.equal(await activeSegment().getAttribute('data-asset-index'), '1', 'lightbox navigation updates phone progress without a second callback');
  assert.equal(await page.locator('.studio-gallery-lightbox').innerText(), '', 'lightbox must have no filename or index labels');
  assert.equal(await page.locator('.studio-gallery-lightbox .is-current img').evaluate(el => getComputedStyle(el).objectFit), 'contain');
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => currentIndex), 2);
  assert.equal(await page.getByRole('button', {name: '下一张', exact: true}).isDisabled(), true);
  await page.keyboard.press('ArrowRight');
  assert.deepEqual(await page.evaluate(() => changes), [1, 2], 'clamped boundary cannot emit another change');
  await page.keyboard.press('ArrowLeft');
  await page.screenshot({path: output + 'studio-gallery-lightbox.png'});
  const surface = page.locator('.studio-gallery-lightbox-surface');
  await wheelAt(surface, {deltaX: 0, deltaY: 120, ctrlKey: true});
  assert.equal(await page.evaluate(() => currentIndex), 1, 'pinch zoom must not navigate images');
  await wheelAt(surface, {deltaX: 0, deltaY: -70});
  assert.equal(await page.evaluate(() => currentIndex), 0);
  await wheelAt(surface, {deltaX: 150, deltaY: 2});
  assert.equal(await page.evaluate(() => currentIndex), 0, 'one continuous trackpad gesture navigates once');
  await page.waitForTimeout(220);
  await wheelAt(surface, {deltaX: 60, deltaY: 2});
  assert.equal(await page.evaluate(() => currentIndex), 1);
  const box = await surface.boundingBox();
  const touch = await page.context().newCDPSession(page);
  await touch.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x: box.x + box.width * .7, y: box.y + box.height / 2}]});
  await touch.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: box.x + box.width * .3, y: box.y + box.height / 2}]});
  const dragPosition = await surface.evaluate(el => new DOMMatrix(getComputedStyle(el.querySelector('.studio-preview-track')).transform).m41 / el.clientWidth);
  assert.ok(dragPosition < -1 && dragPosition > -2, 'image track follows the touch before release');
  await touch.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
  assert.equal(await page.evaluate(() => currentIndex), 2, 'touch swipe advances one image');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.studio-gallery-lightbox').evaluate(el => el.open), false);
  assert.equal(await page.evaluate(() => document.documentElement.style.overflow), '');
  assert.equal(await page.locator('.studio-gallery-lightbox video').count(), 0);
  await page.locator('.studio-phone-stage').focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => currentIndex), 1, 'phone keyboard navigation synchronizes editor selection');
  await wheelAt(page.locator('.studio-phone-stage'), {deltaX: -70, deltaY: 0});
  assert.equal(await page.evaluate(() => currentIndex), 0, 'phone trackpad navigation synchronizes editor selection');
  // 分段按钮与段条拖动都改变同一查看索引；宿主回显不重建正在操作的段按钮。
  const progressBox = await progress.boundingBox();
  await segments.nth(2).click();
  assert.equal(await page.evaluate(() => currentIndex), 2);
  assert.equal(await page.locator('.studio-phone-stage .is-current img').getAttribute('alt'), '建筑图片.jpg');
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => currentIndex), 0);
  const beforeBoundary = await page.evaluate(() => changes.length);
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => changes.length), beforeBoundary, 'segment boundary does not emit duplicate navigation');
  await page.mouse.move(progressBox.x + 2, progressBox.y + progressBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(progressBox.x + progressBox.width - 2, progressBox.y + progressBox.height / 2, {steps: 5});
  await page.mouse.up();
  assert.equal(await page.evaluate(() => currentIndex), 2, 'dragging stays connected to the current preview');
  await activeSegment().focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.evaluate(() => currentIndex), 1);
  const barBounds = await segments.first().boundingBox();
  const navBounds = await page.locator('.studio-phone-bottom').boundingBox();
  const captionBounds = await page.locator('.studio-phone-caption').boundingBox();
  assert.ok(Math.abs(barBounds.y + barBounds.height / 2 - navBounds.y) < 1, 'progress aligns with the top of the bottom navigation');
  assert.ok(captionBounds.y + captionBounds.height < barBounds.y + barBounds.height / 2 - 1, 'segment lines cannot cover the music caption');
  await activeSegment().blur();
  await page.mouse.move(10, 10);
  await page.locator('.studio-phone-stage .studio-preview-track').evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished.catch(() => {}))); });
  assert.equal(await page.locator('.studio-phone-stage').evaluate(el => Math.abs(new DOMMatrix(getComputedStyle(el.querySelector('.studio-preview-track')).transform).m41 + el.clientWidth) < .1), true, 'settled track centers the selected photo without adjacent strips');
  await page.locator('.studio-phone').screenshot({path: output + 'studio-phone-progress.png', animations: 'disabled'});
  const beforeRender = await page.evaluate(() => changes.length);
  await page.evaluate(() => preview.render({assets: [assets[0]], index: 99}));
  assert.equal(await segments.count(), 1);
  assert.equal(await activeSegment().getAttribute('aria-label'), '查看第 1 张，共 1 张');
  assert.equal(await activeSegment().evaluate(el => getComputedStyle(el, '::before').backgroundColor), 'rgb(255, 255, 255)');
  await page.evaluate(() => preview.render({assets: []}));
  assert.equal(await page.locator('.studio-phone-progress').isHidden(), true);
  assert.equal(await page.evaluate(() => changes.length), beforeRender, 'empty and clamped renders do not change the draft selection');
  await page.evaluate(() => renderAll());
  assert.deepEqual(await page.evaluate(() => assets.map(asset => asset.id)), ['landscape', 'portrait', 'square'], 'viewing cannot mutate source ordering');
  // 原生阶段与原助手一致：一次手势只翻一页，惯性不翻页，下一次 began 无需冷却等待。
  const phoneStage = page.locator('.studio-phone-stage');
  await page.evaluate(() => { window.pluginContext = {nativeScrollPhases: true}; currentIndex = 0; renderAll(); });
  await nativeWheelAt(phoneStage, {deltaY: 6, began: true});
  assert.equal(await page.evaluate(() => currentIndex), 0);
  await nativeWheelAt(phoneStage, {deltaY: 5});
  assert.equal(await page.evaluate(() => currentIndex), 1);
  await nativeWheelAt(phoneStage, {deltaY: 200});
  await nativeWheelAt(phoneStage, {ended: true});
  await nativeWheelAt(phoneStage, {deltaY: 500, momentum: true});
  assert.equal(await page.evaluate(() => currentIndex), 1, 'native drag and inertia do not advance repeatedly');
  await nativeWheelAt(phoneStage, {deltaY: 20, began: true});
  assert.equal(await page.evaluate(() => currentIndex), 2, 'next native gesture unlocks immediately');
  await nativeWheelAt(phoneStage, {deltaY: -20, began: true});
  assert.equal(await page.evaluate(() => currentIndex), 1);
  await wheelAt(phoneStage, {deltaX: -200, deltaY: 0});
  assert.equal(await page.evaluate(() => currentIndex), 1, 'DOM wheel cannot double-fire native phases');
  await nativeWheelAt(phoneStage, {deltaY: 20, began: true, x: 1, y: 1});
  await nativeWheelAt(phoneStage, {deltaY: 80});
  assert.equal(await page.evaluate(() => currentIndex), 1, 'a gesture consumed outside cannot continue inside as a new swipe');
  await nativeWheelAt(phoneStage, {deltaY: -1, phased: false});
  assert.equal(await page.evaluate(() => currentIndex), 0, 'discrete native mouse wheel responds to each event');
  await nativeWheelAt(phoneStage, {deltaY: 1, phased: false});
  assert.equal(await page.evaluate(() => currentIndex), 1);
  await page.locator('.studio-gallery-image').nth(1).click();
  const beforeModalNative = await page.evaluate(() => changes.length);
  await nativeWheelAt(surface, {deltaX: 20, began: true});
  assert.equal(await page.evaluate(() => currentIndex), 2);
  assert.equal(await page.evaluate(() => changes.length), beforeModalNative + 1, 'modal surface handles native input once, hidden phone cannot also navigate');
  await page.keyboard.press('Escape');
  await page.evaluate(() => { window.pluginContext.nativeScrollPhases = false; currentIndex = 0; renderAll(); });
  const phoneBox = await phoneStage.boundingBox();
  await page.mouse.move(phoneBox.x + phoneBox.width * .8, phoneBox.y + phoneBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(phoneBox.x + phoneBox.width * .2, phoneBox.y + phoneBox.height / 2, {steps: 5});
  await page.mouse.up();
  assert.equal(await page.evaluate(() => currentIndex), 1, 'mouse drag uses the same one-page swipe semantics');
  await page.emulateMedia({reducedMotion: 'reduce'});
  await segments.nth(2).click();
  assert.equal(await phoneStage.evaluate(el => el.querySelector('.studio-preview-track').getAnimations().length), 0, 'reduced-motion disables track animation');
  await page.emulateMedia({reducedMotion: 'no-preference'});
  const beforeMany = await page.evaluate(() => changes.length);
  await page.evaluate(() => preview.render({assets: Array.from({length: 35}, (_, i) => ({...assets[i % 3], id: 'many-' + i})), index: 34}));
  assert.equal(await segments.count(), 35, 'each photo retains its own segment even at the supported limit');
  assert.equal(await phoneStage.locator('img').count(), 2, 'only current and neighboring full-size images stay mounted');
  assert.equal(await page.evaluate(() => changes.length), beforeMany);
  await page.evaluate(() => renderAll());
  // 真鼠标拖放调整顺序，保留预览图片而更新分段位置；结束后不会误开放大层。
  await page.locator('.studio-gallery-image').nth(0).dragTo(page.locator('.studio-gallery-image').nth(2));
  assert.deepEqual(await page.evaluate(() => assets.map(asset => asset.id)), ['portrait', 'square', 'landscape']);
  assert.deepEqual(await page.evaluate(() => reorders), [['landscape', 'square']]);
  assert.equal(await activeSegment().getAttribute('data-asset-index'), '1');
  assert.equal(await phoneStage.locator('.is-current img').getAttribute('alt'), '建筑图片.jpg');
  assert.equal(await page.locator('.studio-gallery-lightbox').evaluate(el => el.open), false);
  await page.locator('.studio-gallery-image').nth(1).focus();
  await page.keyboard.press('Alt+ArrowLeft');
  assert.deepEqual(await page.evaluate(() => assets.map(asset => asset.id)), ['square', 'portrait', 'landscape']);
  assert.equal(await activeSegment().getAttribute('data-asset-index'), '0');
  assert.match(await page.locator(':focus').getAttribute('aria-label'), /建筑图片/);
  await page.keyboard.press('Alt+ArrowLeft');
  assert.equal(await page.evaluate(() => reorders.length), 2, 'keyboard boundary does not save a redundant reorder');
  // 外部伪造 MIME、拖出、同一图片落点和编辑锁均不形成排序。
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await transfer.evaluate(data => data.setData('application/x-luma-studio-image', 'square'));
  await page.locator('.studio-gallery-image').nth(1).dispatchEvent('drop', {dataTransfer: transfer});
  assert.equal(await page.evaluate(() => reorders.length), 2, 'external data cannot grant internal drag state');
  await page.locator('.studio-gallery-image').nth(0).dispatchEvent('dragstart', {dataTransfer: transfer});
  await page.locator('.studio-gallery-image').nth(1).dispatchEvent('dragover', {dataTransfer: transfer});
  assert.equal(await page.locator('.studio-gallery-card.drop-after').count(), 1);
  await page.locator('.studio-gallery-image').nth(0).dispatchEvent('dragend', {dataTransfer: transfer});
  assert.equal(await page.locator('.is-dragging, .drop-before, .drop-after').count(), 0);
  assert.equal(await page.evaluate(() => reorders.length), 2, 'cancelled drag never mutates order');
  await page.locator('.studio-gallery-image').nth(0).dispatchEvent('dragstart', {dataTransfer: transfer});
  await page.locator('.studio-gallery-image').nth(0).dispatchEvent('drop', {dataTransfer: transfer});
  assert.equal(await page.evaluate(() => reorders.length), 2, 'dropping on the source is a no-op');
  await page.locator('.studio-gallery-image').nth(0).dispatchEvent('dragstart', {dataTransfer: transfer});
  await page.evaluate(() => gallery.render({assets, index: currentIndex, disabled: true}));
  assert.equal(await page.locator('.studio-gallery-image[draggable=true]').count(), 0);
  await page.locator('.studio-gallery-image').nth(1).dispatchEvent('drop', {dataTransfer: transfer});
  assert.equal(await page.evaluate(() => reorders.length), 2, 'busy rendering cancels the in-flight drag');
  await page.evaluate(() => renderAll());
  await page.locator('.studio-gallery-image').nth(0).dispatchEvent('dragstart', {dataTransfer: transfer});
  await page.evaluate(() => gallery.render({assets, index: currentIndex, scope: 'another-draft'}));
  await page.locator('.studio-gallery-image').nth(1).dispatchEvent('drop', {dataTransfer: transfer});
  assert.equal(await page.evaluate(() => reorders.length), 2, 'same photos in another draft cannot receive an old drag');
  await page.evaluate(() => renderAll());
  await page.locator('.studio-gallery-image').nth(0).click();
  await page.keyboard.press('ArrowRight');
  assert.equal(await surface.locator('.is-current img').getAttribute('alt'), '树林图片.jpg', 'lightbox follows the reordered sequence');
  await page.keyboard.press('Escape');
  await page.setViewportSize({width: 420, height: 900});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({path: output + 'studio-gallery-narrow.png'});
  await page.evaluate(() => { window.assets = [{id: 'video', kind: 'video', url: ''}]; window.renderAll(); });
  assert.equal(await page.locator('.studio-gallery-video').evaluate(el => el.controls), true);
  assert.equal(await page.locator('.studio-phone-stage video').evaluate(el => el.controls), true);
  assert.equal(await page.locator('.studio-phone-kind').isHidden(), true);
  assert.equal(await page.locator('.studio-phone-progress').isHidden(), true, 'video retains its real native playback controls');
  await page.evaluate(() => { gallery.dispose(); preview.dispose(); gallery.dispose(); preview.dispose(); });
  assert.equal(await page.locator('.studio-gallery-lightbox, .studio-phone, .studio-gallery-grid').count(), 0);
  assert.deepEqual(errors, []);
  console.log('gallery UI passed: images only, segmented lines, original native gesture phases, animated track, synchronized keyboard/touch/drag navigation, segment placement, single/empty media, contain, reference phone, native video, cleanup');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
