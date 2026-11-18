import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

// 独立挂载生产活动模块和合成只读平台，不登录真实账号，也不上传发布。
const root = fileURLToPath(new URL('../app/', import.meta.url));
const output = fileURLToPath(new URL('../output/playwright/', import.meta.url));
await mkdir(output, {recursive: true});
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="/studio.css"><link rel="stylesheet" href="/studio-activities.css"><style>body{padding:24px;background:white}#activities{max-width:850px;margin:0}</style><div id="activities"></div><script type="module">
import {mountActivities} from '/studio-activities.js';
window.fixture={scope:'account-a',draft:{id:'draft-a',kind:'image',description:'',topics:[],activities:[]},calls:[],changes:0,failCursor:null,failDetail:false,failResolve:false,holdResolve:false,badResolve:false,resolvePending:[],hold:false,pending:[],blocked:false,supported:true};
const item=index=>({id:String(index),name:index===1?'宝藏经验分享活动':index===2?'寡门门主脱单卡池':'官方活动'+index,topicName:'活动话题'+index,heat:index===2?419:index*12345,disabled:index===8,description:index===8?'该活动需要额外的官方选择':''});
const request=async(operation,params,options)=>{
  const scope=fixture.scope;fixture.calls.push({operation,params,scope});
  if(operation==='activities.resolve'){
    if(fixture.holdResolve)await new Promise(resolve=>fixture.resolvePending.push(resolve));
    if(fixture.failResolve)throw Error('活动话题暂未读取，原稿已保留，请重试。');
    const index=Number(params.id);
    return {...item(index),topic:{id:fixture.badResolve?7655295256916658000:index===1?'7655295256916658211':String(1000+index),name:'活动话题'+index}};
  }
  if(operation==='activities.detail'){
    if(fixture.failDetail)throw Error('活动详情暂未读取，请重试。');
    return{id:params.id,name:item(Number(params.id)).name,description:'官方活动说明\\n按规则发布作品。',topics:['活动话题'+params.id],startTime:'2026.11.01',endTime:'2026.12.01',rewardDescription:'优秀作品有机会获得平台推荐。'};
  }
  if(operation!=='activities.list')throw Error('Unexpected mutation');
  if(String(params.cursor)===fixture.failCursor)throw Error('活动分页读取失败，请重试。');
  if(fixture.hold)await new Promise(resolve=>fixture.pending.push(resolve));
  const first=params.cursor===undefined;
  return{items:scope==='account-b'?[{...item(21),name:'新账号活动'}]:first?Array.from({length:10},(_,i)=>item(i+1)):[item(10),item(11),item(12)],hasMore:scope!=='account-b'&&first,nextCursor:scope!=='account-b'&&first?'10':null};
};
window.activities=mountActivities({container:document.querySelector('#activities'),current:()=>fixture.draft,identity:()=>fixture.scope+':'+fixture.draft.id,cacheScope:()=>fixture.scope+':'+fixture.draft.kind,supports:()=>fixture.supported,blocked:()=>fixture.blocked,request,safeURL:url=>url,onChanged:()=>{fixture.changes++;activities.render();}});
activities.render();window.ready=true;
</script></html>`;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
  const file = resolve(root, '.' + url.pathname);
  if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
  try { response.setHeader('Content-Type', ({'.js': 'text/javascript', '.css': 'text/css'})[extname(file)] || 'application/octet-stream'); response.end(await readFile(file)); }
  catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
try {
  const page = await browser.newPage({viewport: {width: 1040, height: 700}}), errors = [], alerts = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { alerts.push(dialog.message()); await dialog.accept(); });
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => window.ready && document.querySelectorAll('.studio-activity-card').length === 10);
  assert.equal(await page.evaluate(() => fixture.calls.length), 1, 'first page does not fetch unseen pages');
  assert.equal(await page.locator('.studio-activity-card').nth(1).locator('.studio-activity-heat').textContent(), '热度：419');
  const first = page.locator('.studio-activity-card').first();
  await first.hover();
  await first.locator('.studio-activity-add').click();
  await page.waitForFunction(() => fixture.draft.activities.length === 1);
  assert.deepEqual(await page.evaluate(() => fixture.draft.activities), [{id:'1',name:'宝藏经验分享活动',topic:{id:'7655295256916658211',name:'活动话题1'}}]);
  assert.equal(await page.evaluate(() => fixture.draft.description), '#活动话题1');
  assert.equal(await first.getAttribute('class'), 'studio-activity-card is-selected');
  const beforeCancel = await page.evaluate(() => fixture.calls.length);
  await first.locator('.studio-activity-add').click();
  assert.equal(await page.evaluate(() => fixture.calls.length), beforeCancel, 'canceling activity is a local-only change');
  assert.equal(await page.evaluate(() => fixture.draft.activities.length), 0);
  assert.equal(await page.evaluate(() => fixture.draft.topics.length), 1, 'removing activity preserves ordinary topic');
  assert.equal(await page.evaluate(() => fixture.draft.description), '#活动话题1');
  await first.locator('.studio-activity-add').click();
  await page.waitForFunction(() => fixture.draft.activities.length === 1);
  assert.equal(await page.evaluate(() => fixture.draft.description), '#活动话题1', 're-adding does not duplicate topic or spaces');
  await page.screenshot({path: output + 'studio-activities.png'});

  // 添加失败与非法数字身份均不得留下半份选择；只读取详情解析，不根据列表补造话题 ID。
  await first.locator('.studio-activity-add').click();
  const unchanged = await page.evaluate(() => ({draft: JSON.stringify(fixture.draft), changes: fixture.changes}));
  await page.evaluate(() => { fixture.failResolve = true; });
  await first.locator('.studio-activity-add').click();
  await page.waitForFunction(() => !document.querySelector('.studio-activity-add').disabled);
  assert.match(alerts.at(-1), /原稿已保留/);
  assert.deepEqual(await page.evaluate(() => ({draft: JSON.stringify(fixture.draft), changes: fixture.changes})), unchanged);
  await page.evaluate(() => { fixture.failResolve = false; fixture.badResolve = true; });
  await first.locator('.studio-activity-add').click();
  await page.waitForFunction(() => !document.querySelector('.studio-activity-add').disabled);
  assert.match(alerts.at(-1), /话题身份无法确认/);
  assert.deepEqual(await page.evaluate(() => ({draft: JSON.stringify(fixture.draft), changes: fixture.changes})), unchanged);

  // 在途添加禁止重入，正文保持不动；准确字符串返回后才一次性保存活动、话题和标记。
  await page.evaluate(() => { fixture.badResolve = false; fixture.holdResolve = true; });
  await first.locator('.studio-activity-add').click();
  await page.waitForFunction(() => fixture.resolvePending.length === 1);
  assert.equal(await first.locator('.studio-activity-add').getAttribute('aria-busy'), 'true');
  assert.equal(await page.locator('.studio-activity-add:disabled').count(), 10);
  const pendingCalls = await page.evaluate(() => fixture.calls.filter(call => call.operation === 'activities.resolve').length);
  await page.evaluate(() => { document.querySelector('.studio-activity-add').onclick(); document.querySelectorAll('.studio-activity-add')[1].onclick(); });
  assert.equal(await page.evaluate(() => fixture.calls.filter(call => call.operation === 'activities.resolve').length), pendingCalls);
  assert.deepEqual(await page.evaluate(() => ({draft: JSON.stringify(fixture.draft), changes: fixture.changes})), unchanged);
  await page.evaluate(() => { fixture.holdResolve = false; for (const finish of fixture.resolvePending.splice(0)) finish(); });
  await page.waitForFunction(() => fixture.draft.activities.length === 1);
  assert.equal(await page.evaluate(() => fixture.draft.activities[0].topic.id), '7655295256916658211');
  assert.equal(await page.evaluate(() => fixture.changes), unchanged.changes + 1);

  // 传输忽略取消时，正文编辑、换草稿、换账号、关闭后的迟到解析都不能改稿或发出错误旧提示。
  for (const mode of ['edit', 'draft', 'account', 'close']) {
    await page.evaluate(() => {
      fixture.scope = 'account-a'; fixture.draft = {id: 'resolve-race', kind: 'image', description: '待确认原文', topics: [], activities: []};
      fixture.holdResolve = true; activities.render();
    });
    await page.waitForFunction(() => document.querySelectorAll('.studio-activity-card').length === 10 && !document.querySelector('.studio-activity-add').disabled);
    await first.hover(); await first.locator('.studio-activity-add').click();
    await page.waitForFunction(() => fixture.resolvePending.length === 1);
    const alertCount = alerts.length;
    await page.evaluate(mode => {
      if (mode === 'edit') fixture.draft.description = '用户刚输入的新正文';
      if (mode === 'draft') fixture.draft = {id: 'other-draft', kind: 'image', description: '另一个草稿', topics: [], activities: []};
      if (mode === 'account') fixture.scope = 'account-c';
      if (mode === 'close') activities.close(); else activities.render();
    }, mode);
    const beforeLate = await page.evaluate(() => ({draft: JSON.stringify(fixture.draft), changes: fixture.changes}));
    await page.evaluate(() => { fixture.holdResolve = false; for (const finish of fixture.resolvePending.splice(0)) finish(); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.deepEqual(await page.evaluate(() => ({draft: JSON.stringify(fixture.draft), changes: fixture.changes})), beforeLate, mode);
    assert.equal(alerts.length, alertCount, 'obsolete context must ignore both success and errors');
  }
  await page.evaluate(() => { fixture.scope = 'account-a'; fixture.draft = {id: 'draft-a', kind: 'image', description: '', topics: [], activities: []}; activities.render(); });
  await page.waitForFunction(() => document.querySelectorAll('.studio-activity-card').length === 10 && !document.querySelector('.studio-activity-add').disabled);

  // 详情从真实操作契约读取，不虚构外链；失败重试不重新加载列表。
  await page.evaluate(() => { fixture.failDetail = true; });
  await first.locator('.studio-activity-details').click();
  await page.locator('.studio-activity-dialog[open]').waitFor();
  await page.locator('.studio-activity-dialog').getByRole('button', {name:'重试',exact:true}).waitFor();
  await page.evaluate(() => { fixture.failDetail = false; });
  await page.locator('.studio-activity-dialog').getByRole('button', {name:'重试',exact:true}).click();
  await page.locator('.studio-activity-dialog-content').filter({hasText:'官方活动说明'}).waitFor();
  assert.match(await page.locator('.studio-activity-dialog-content').textContent(), /2026.11.01 — 2026.12.01/);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.studio-activity-dialog').isHidden(), true);

  // 话题上限和 UTF-16 正文字数都在变更前校验，失败保持原稿。
  await page.evaluate(() => { fixture.draft.activities=[];fixture.draft.description='原文';fixture.draft.topics=Array.from({length:5},(_,i)=>({id:'x'+i,name:'已有'+i}));activities.render(); });
  await first.hover(); await first.locator('.studio-activity-add').click();
  assert.match(alerts.at(-1), /最多添加 5/);
  assert.equal(await page.evaluate(() => fixture.draft.description), '原文');
  await page.evaluate(() => { fixture.draft.topics=[];fixture.draft.description='字'.repeat(999);activities.render(); });
  await first.hover(); await first.locator('.studio-activity-add').click();
  assert.match(alerts.at(-1), /字数上限/);
  assert.equal(await page.evaluate(() => fixture.draft.activities.length), 0);

  // 接近末尾时预加载下一页；失败保持十张和游标，滚动不自动重试。
  await page.evaluate(() => { fixture.failCursor='10';const list=document.querySelector('.studio-activities-list');list.scrollLeft=list.scrollWidth-list.clientWidth*1.5;list.dispatchEvent(new Event('scroll')); });
  await page.locator('.studio-activities-retry').waitFor();
  assert.equal(await page.locator('.studio-activity-card').count(), 10);
  assert.equal(await page.evaluate(() => {const n=document.querySelector('.studio-activities-list');return n.scrollWidth-n.clientWidth-n.scrollLeft>0;}), true, 'prefetch happens before the end');
  const failedCalls = await page.evaluate(() => fixture.calls.length);
  await page.evaluate(() => document.querySelector('.studio-activities-list').dispatchEvent(new Event('scroll')));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(await page.evaluate(() => fixture.calls.length), failedCalls);
  await page.evaluate(() => { fixture.failCursor=null; });
  await page.locator('.studio-activities-retry').click();
  await page.waitForFunction(() => document.querySelectorAll('.studio-activity-card').length === 12);
  assert.equal(await page.locator('.studio-activities-more').isHidden(), true);
  assert.equal(await page.locator('[data-activity-id="8"] .studio-activity-add').isDisabled(), true);

  // 同账号切草稿复用已读页，选择不会串入新草稿。
  const beforeSwitch = await page.evaluate(() => fixture.calls.length);
  await page.evaluate(() => { fixture.draft={id:'draft-b',kind:'image',description:'',topics:[],activities:[]};activities.render(); });
  await page.waitForFunction(() => document.querySelectorAll('.studio-activity-card').length === 10);
  assert.equal(await page.evaluate(() => fixture.calls.length), beforeSwitch);
  assert.equal(await page.locator('.studio-activity-card.is-selected').count(), 0);
  await page.evaluate(() => { const list=document.querySelector('.studio-activities-list');list.scrollLeft=list.scrollWidth;list.dispatchEvent(new Event('scroll')); });
  await page.waitForFunction(() => document.querySelectorAll('.studio-activity-card').length === 12);
  assert.equal(await page.evaluate(() => fixture.calls.length), beforeSwitch);

  // 账号改变使旧在途页失效，即使请求实现忽略 signal，也不会污染新账号。
  await page.evaluate(() => { fixture.scope='account-slow';fixture.hold=true;activities.render(); });
  await page.waitForFunction(() => fixture.pending.length === 1);
  await page.evaluate(() => { fixture.scope='account-b';fixture.hold=false;activities.render(); });
  await page.locator('.studio-activity-name').filter({hasText:'新账号活动'}).waitFor();
  await page.evaluate(() => { for(const resolve of fixture.pending.splice(0))resolve(); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(await page.locator('.studio-activity-card').count(), 1);
  assert.equal(await page.locator('.studio-activity-name').textContent(), '新账号活动');
  await page.setViewportSize({width: 360,height:600});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({path: output + 'studio-activities-narrow.png'});
  await page.evaluate(() => { activities.dispose(); activities.dispose(); });
  assert.equal(await page.locator('.studio-activity-dialog').count(), 0);
  assert.equal(await page.locator('#activities').textContent(), '');
  assert.deepEqual(errors, []);
  console.log('activities UI passed: real fields, nonduplicating topic, selection limits, details/retry, early pagination/cache, account fence, disabled activities and narrow layout');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
