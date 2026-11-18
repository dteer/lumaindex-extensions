import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile, mkdir} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';

// 回归运行真实 index/studio/client/engine/resource 模块，只在宿主与平台网络边界提供合成响应。
const root = fileURLToPath(new URL('../app/', import.meta.url));
const output = fileURLToPath(new URL('../output/playwright/', import.meta.url));
const picture = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="850"><rect width="1200" height="850" fill="#b7c2c8"/><path d="M0 850 380 380 680 720 910 490 1200 850Z" fill="#687e88"/><circle cx="830" cy="220" r="90" fill="#e7e4d6"/></svg>';
// 独立页面导入生产控件，只替换查询边界，以确定性响应覆盖跨草稿缓存与慢分页竞态。
const resourceFixture = script => `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/studio-resources.css"><link rel="stylesheet" href="/studio-cities.css"><style>body{max-width:700px}.resource-options{max-height:120px;overflow:auto}.resource-option{height:40px}.resource-anchor{margin:16px 0}.resource-popover{position:static}[hidden]{display:none}</style><div class="description-editor"><textarea id="description" maxlength="1000"></textarea><div id="association-results" hidden></div></div><div id="topic-recommendations" hidden></div><button id="search-topics">topic</button><button id="search-mentions">mention</button><div class="resource-anchor"><button id="location-city">选择城市</button><div id="city-popover" hidden></div></div>` + ['collection', 'declaration', 'location'].map(kind => `<div class="resource-anchor"><button id="search-${kind}">${kind}</button><span id="${kind}-name"></span><div id="${kind}-popover" class="resource-popover" hidden></div></div>`).join('') + `<script type="module">
import {mountResourceControls} from '/studio-resources.js';
${script}
window.ready=true;
</script>`;
const paginationFixture = resourceFixture(`
window.calls=[];
const draft={id:'race-draft',kind:'image',assets:[],topics:[],mentions:[],settings:{declarations:[]}};
window.controls=mountResourceControls({current:()=>draft,supports:()=>true,safeURL:()=>'',identity:()=> 'fixed',blocked:()=>false,changed:()=>controls.render(),request:async(operation,params)=>{
  window.calls.push({operation,...params});
  if(params.cursor)return await new Promise(resolve=>{window.releaseOldPage=()=>resolve({items:[{id:'22',name:'OLD-QUERY-RESULT'}],nextCursor:null});});
  return params.query==='NEW'?{items:[{id:'99',name:'NEW-QUERY-RESULT'}],nextCursor:null}:{items:Array.from({length:10},(_,index)=>({id:String(index+1),name:'OLD '+index})),nextCursor:'10'};
}});controls.render();`);
const cacheFixture = resourceFixture(`
const emptyDraft=id=>({id,kind:'image',assets:[],topics:[],mentions:[],settings:{declarations:[]}});
window.fixture={draft:emptyDraft('first-draft'),account:'A',calls:[],failNext:'',malformedNext:'',offline:false};
window.controls=mountResourceControls({current:()=>fixture.draft,supports:()=>!fixture.offline,safeURL:()=>'',identity:()=>fixture.account+':'+fixture.draft.id,cacheScope:()=>fixture.account+':'+fixture.draft.kind,blocked:()=>false,changed:()=>controls.render(),request:async(operation,params)=>{
  fixture.calls.push({operation,account:fixture.account,...params});
  if(fixture.failNext===operation){fixture.failNext='';throw Error('合成网络故障，请重试。');}
  if(fixture.malformedNext===operation){fixture.malformedNext='';return {};}
  if(operation==='collections.list')return params.cursor?{items:[{id:fixture.account+'-next',name:'深海摄影 '+fixture.account,itemCount:2}],nextCursor:null}:{items:Array.from({length:10},(_,index)=>({id:fixture.account+'-'+index,name:'周末摄影 '+fixture.account+' '+index,itemCount:index})),nextCursor:'10'};
  if(operation==='declarations.list')return {items:[{id:'original',label:'作品由本人原创 '+fixture.account},{id:'repost',label:'内容为转载信息'},{id:'related',label:'内容为转载信息的补充说明'}],nextCursor:null};
  throw Error('Unexpected fixture operation: '+operation);
}});
window.setContext=({account=fixture.account,id=fixture.draft.id,kind=fixture.draft.kind})=>{fixture.account=account;fixture.draft=emptyDraft(id);fixture.draft.kind=kind;controls.render();};
controls.render();`);
const topicFixture = resourceFixture(`
window.fixture={draft:{id:'topic-draft',kind:'image',assets:[],description:'',topics:[],mentions:[],settings:{declarations:[]}},calls:[],online:true,mode:'empty'};
window.controls=mountResourceControls({current:()=>fixture.draft,supports:()=>fixture.online,safeURL:()=>'',identity:()=> 'topics',blocked:()=>false,changed:()=>controls.render(),request:async(operation,params)=>{
  fixture.calls.push({operation,...params});
  if(operation!=='topics.search')throw Error('Unexpected topic fixture operation: '+operation);
  if(!params.query)return {items:[],nextCursor:null};
  if(fixture.mode==='error')throw Error('合成在线查询失败，本地话题仍可添加。');
  if(fixture.mode==='existing')return {items:[{id:0,name:params.query,viewCount:0},{id:'existing-id',name:params.query,viewCount:125000}],nextCursor:null};
  if(fixture.mode==='names')return {items:[{id:0,name:'新话题甲',viewCount:0},{id:0,name:'新话题乙',viewCount:0}],nextCursor:null};
  return {items:[],nextCursor:null};
}});
document.getElementById('description').addEventListener('input',event=>{fixture.draft.description=event.target.value;});
controls.render();`);
await mkdir(output, {recursive: true});
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (['/resource-race.html', '/resource-cache.html', '/resource-topics.html'].includes(url.pathname)) { response.setHeader('Content-Type', 'text/html'); response.end(url.pathname === '/resource-race.html' ? paginationFixture : url.pathname === '/resource-topics.html' ? topicFixture : cacheFixture); return; }
  if (/^\/api\/v1\/assets\/fixture-(one|two)\//.test(url.pathname)) {
    response.setHeader('Content-Type', 'image/svg+xml'); response.end(picture); return;
  }
  if (/^\/api\/v1\/assets\/fixture-(one|two)$/.test(url.pathname)) {
    const id = url.pathname.split('/').at(-1);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({code: 0, data: {id, name: '海边测试图片.jpg', mediaType: 'image', sizeBytes: 1000}})); return;
  }
  const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
  try {
    response.setHeader('Content-Type', ({'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json'})[extname(file)] || 'application/octet-stream');
    response.end(await readFile(file));
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const browser = await chromium.launch({headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? {executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH} : {})});
try {
  const page = await browser.newPage({viewport: {width: 1290, height: 1000}});
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // 提供一秒静音 PCM，检查真实 audio.play 生命周期，不下载或播放外部音乐。
  const wav = Buffer.alloc(44 + 16000);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(16000, 40);
  await page.route('https://media.example.test/**', route => route.fulfill({status: 200, contentType: route.request().url().endsWith('.wav') ? 'audio/wav' : 'image/svg+xml', body: route.request().url().endsWith('.wav') ? wav : picture}));
  await page.addInitScript(({origin}) => {
    const profile = {id: 'profile-resources', accountId: '123', name: '摄影日志', browserSessionAvailable: true, hasCookies: true, expiresAt: new Date(Date.now() + 8 * 3600000).toISOString()};
    const runtime = {};
    window.__resourcesUI = {messages: [], requests: [], state: JSON.parse(sessionStorage.getItem('resources-ui-state') || '{}')};
    window.pluginContext = {nativeUIAvailable: true, browserEnvironment: {userAgent: 'SyntheticWebKit/1.0', languages: ['zh-CN', 'en-US']}, nativeCapabilities: {browserRequestsVersion: 1, persistentWebsiteSessionsVersion: 1, sessionLoginOptionsVersion: 1, networkHeadersVersion: 1, sessionVersion: 1, sessionProfilesVersion: 1, temporaryFilesVersion: 1, mediaSelectionVersion: 1}, apiBaseURL: origin + '/api/v1', frontendState: window.__resourcesUI.state, libraryID: 'resources-ui-fixture'};
    const status = () => ({browserSessionAvailable: true, hasCookies: true, activeProfileId: profile.id, accountId: profile.accountId, name: profile.name, expiresAt: profile.expiresAt});
    window.webkit = {messageHandlers: {pluginUI: {postMessage: async message => {
      window.__resourcesUI.messages.push(structuredClone(message));
      if (message.op === 'persist') {
        window.__resourcesUI.state = structuredClone(message.value);
        sessionStorage.setItem('resources-ui-state', JSON.stringify(message.value));
        return {ok: true};
      }
      if (message.op === 'session.status' || message.op === 'session.select' || message.op === 'session.identify') return {ok: true, data: status()};
      if (message.op === 'session.list') return {ok: true, data: {items: [profile], activeProfileId: profile.id, hasMore: false, nextOffset: null}};
      if (message.op === 'assets.select') return {ok: true, data: {cancelled: false, assetIDs: ['fixture-one', 'fixture-two']}};
      if (message.op === 'state.get') {
        // 合成已完成上传检查点使推荐走生产接口分支；测试不上传任何文件。
        const value = typeof message.keys === 'string' && message.keys.startsWith('studio-uploads:') ? {recommendationFrames: ['fixture-image-resource']} : runtime[message.keys];
        return {ok: true, data: message.keys ? {[message.keys]: value} : runtime};
      }
      if (message.op === 'state.set') { Object.assign(runtime, message.values); return {ok: true, data: {saved: true}}; }
      if (message.op !== 'browser.request') throw Error('Unexpected native resource operation: ' + message.op);
      const url = new URL(message.url);
      window.__resourcesUI.requests.push({url: message.url, headers: message.headers, credentials: message.credentials, method: message.method, queryAtRequest: document.querySelector('#search-query')?.value});
      let data;
      if (url.pathname === '/web/api/media/user/info/') data = {status_code: 0, user: {uid: '123', nickname: '摄影日志', avatar_thumb: {url_list: ['https://media.example.test/avatar.svg']}}};
      else if (url.pathname === '/web/api/mix/list/') data = {status_code: 0, mix_list: url.searchParams.get('cursor') === '0' ? [
        {mix_id: '1101', mix_name: '周末摄影', type: 0, status: {status: 0}, statis: {updated_to_episode: 4}, cover_url: {url_list: ['https://media.example.test/weekend.svg']}},
        {mix_id: '1102', mix_name: '城市漫游', type: 0, status: {status: 2}, statis: {updated_to_episode: 2}, cover_url: {url_list: ['https://media.example.test/city.svg']}},
      ] : [{mix_id: '1192', mix_name: '深海摄影', type: 0, status: {status: 0}, statis: {updated_to_episode: 7}, cover_url: {url_list: ['https://media.example.test/sea.svg']}}], has_more: url.searchParams.get('cursor') === '0' ? 1 : 0, cursor: '10'};
      else if (url.pathname === '/aweme/v3/user_declaration/suggestion/') data = {status_code: 0, data: {block_type: 0, options: [
        {choose_value: 'self_created', text: '作品由本人原创', show_type: 'plain'},
        {choose_value: 'ai_generated', text: '内容由 AI 生成', show_type: 'plain'},
        {choose_value: 'source_required', text: '来源于其他媒体', show_type: 'source_option'},
        {choose_value: 'repost', text: '内容为转载信息', show_type: 'plain'},
      ]}};
      else if (url.pathname === '/web/api/media/hashtag/rec/') data = {status_code: 0, challenge_list: [{cid: '2201', cha_name: '摄影日常', view_count: 125000}, {cid: '2203', cha_name: '海边散步', view_count: 32000}]};
      else if (url.pathname === '/aweme/v1/search/challengesug/') data = {status_code: 0, sug_list: [{cid: '2201', cha_name: '摄影日常', view_count: 125000}, {cid: '2202', cha_name: '摄影技巧', view_count: 21000}]};
      else if (url.pathname === '/web/api/media/music/category') data = {status_code: 0, categories: [{category_id: '1', category_name: '推荐', type: 'recommend'}]};
      else if (url.pathname === '/web/api/media/music/list') data = {status_code: 0, songs: [{music_id: '3301', music_name: '海边原声', music_author: '合成作者', duration: 45, cover_url: 'https://media.example.test/cover.svg', play_url: 'https://media.example.test/default.wav', user_count: 1234}], has_more: url.searchParams.get('cursor') === '0' ? 1 : 0, cursor: url.searchParams.get('cursor') === '0' ? '20' : '40'};
      else if (url.pathname === '/web/api/media/aweme/search/post/auth') data = {status_code: 0, signature: 'synthetic-ui-grant'};
      else if (url.hostname === 'tsearch.amemv.com' && url.pathname === '/openapi/aweme/v1/music/search/') data = {status_code: 0, music: [{id_str: '3302', title: '钢琴与海风', author: '合成音乐人', duration: 123, cover_thumb: {url_list: ['https://media.example.test/piano.svg']}, play_url: {url_list: ['https://media.example.test/piano.wav']}, user_count: 24600}], has_more: 0};
      else if (url.pathname === '/aweme/v1/life/video_api/search/poi/') data = {status_code: 0, poi_list: [{poi_id: '4401', poi_name: '世纪公园', address_info: {simple_addr: '上海市浦东新区'}, anchor_post_ext: {anchor_content: '{}'}}], has_more: false};
      else throw Error('Unexpected platform resource request: ' + url.pathname);
      return {ok: true, data: {status: 200, headers: {'content-type': 'application/json'}, body: JSON.stringify(data)}};
    }}}};
  }, {origin});

  // 使用当前账号显式检查会话，后续候选读取经过生产 client 与 engine 的账号核验。
  await page.goto(origin);
  await page.locator('#account-menu summary').click();
  await page.locator('#connect').click();
  await page.locator('#connection-label').filter({hasText: '摄影日志'}).waitFor();
  await page.locator('#choose-upload').click();
  await page.waitForFunction(() => document.body.dataset.phase === 'editing' && !document.body.classList.contains('busy'));
  assert.equal(await page.locator('#studio-gallery .studio-gallery-image').count(), 2);
  assert.equal(await page.locator('#studio-gallery').innerText(), '');
  assert.equal(await page.locator('#douyin-preview .studio-phone').count(), 1);
  assert.match(await page.locator('.studio-phone-identity').textContent(), /摄影日志/);
  await page.locator('#title').fill('海边摄影日常');

  // 合集读取每个分页一次，后续关键词在已读候选中筛选，封面与总数来自平台真实字段。
  const requestCount = pathname => page.evaluate(path => window.__resourcesUI.requests.filter(item => new URL(item.url).pathname === path).length, pathname);
  await page.locator('#search-collection').click();
  await page.locator('#collection-popover [role=option]').filter({hasText: '深海摄影'}).waitFor();
  assert.equal(await page.locator('#search-dialog').isVisible(), false);
  assert.equal(await requestCount('/web/api/mix/list/'), 2, 'the first display preloads two distinct collection pages');
  const weekend = page.locator('#collection-popover [role=option]').filter({hasText: '周末摄影'});
  assert.equal(await weekend.locator('.collection-count').textContent(), '共4个作品');
  assert.equal(await weekend.locator('.collection-cover img').getAttribute('src'), 'https://media.example.test/weekend.svg');
  await page.waitForFunction(() => [...document.querySelectorAll('#collection-popover img')].every(image => image.complete && image.naturalWidth > 0));
  await page.screenshot({path: output + 'studio-resources-collection.png'});
  await page.locator('#collection-popover input').fill('城市');
  await page.waitForFunction(() => document.querySelectorAll('#collection-popover [role=option]').length === 1);
  const cityCollection = page.locator('#collection-popover [role=option]');
  assert.match(await cityCollection.textContent(), /城市漫游/);
  assert.equal(await cityCollection.locator('.collection-count').textContent(), '共2个作品');
  await cityCollection.click();
  assert.equal(await page.locator('#collection-name').textContent(), '城市漫游');
  assert.equal(await page.locator('#collection-popover').isHidden(), true);
  // 首个缓存页没有匹配项时仍继续筛选下一页，不能显示假性的无结果或重新请求平台。
  await page.locator('#search-collection').click();
  await page.locator('#collection-popover input').fill('深海');
  await page.locator('#collection-popover [role=option]').filter({hasText: '深海摄影'}).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('#collection-popover [role=option]').length === 1);
  assert.equal(await page.locator('#collection-popover [role=option]').count(), 1);
  assert.equal(await requestCount('/web/api/mix/list/'), 2, 'reopening and filtering reuse both collection pages');
  await page.keyboard.press('Escape');

  // 声明取平台返回值；需要补充来源表单的项保持禁用，其余选择可保存。
  await page.locator('#search-declaration').click();
  await page.locator('#declaration-popover [role=option]').filter({hasText: '作品由本人原创'}).waitFor();
  assert.equal(await page.locator('#declaration-popover [role=option]').filter({hasText: '来源于其他媒体'}).isDisabled(), true);
  assert.equal(await page.locator('#declaration-popover [role=option]').filter({hasText: '内容为转载信息'}).count(), 0);
  await page.screenshot({path: output + 'studio-resources-declaration.png'});
  await page.locator('#declaration-popover [role=option]').filter({hasText: '作品由本人原创'}).click();
  assert.equal(await page.locator('#declaration-name').textContent(), '作品由本人原创');
  await page.locator('#search-declaration').click();
  await page.locator('#declaration-popover [role=option][aria-selected=true]').filter({hasText: '作品由本人原创'}).waitFor();
  assert.equal(await requestCount('/aweme/v3/user_declaration/suggestion/'), 1, 'reopening declarations reuses account options');
  await page.keyboard.press('Escape');

  // 在正文中间替换当前 #token，保留前后文本；再次编辑同一 token 不叠加名称或身份。
  const description = page.locator('#description');
  await description.fill('前文 #摄 后文');
  await description.evaluate(input => { input.focus(); input.setSelectionRange(5, 5); input.dispatchEvent(new Event('input', {bubbles: true})); });
  await page.locator('#association-results [role=option]').filter({hasText: '摄影日常'}).waitFor();
  await page.screenshot({path: output + 'studio-resources-topic.png'});
  await page.locator('#association-results [role=option]').filter({hasText: '摄影日常'}).click();
  assert.equal(await description.inputValue(), '前文 #摄影日常 后文', 'replacing a middle token preserves its existing separator exactly');
  await description.evaluate(input => { input.focus(); input.setSelectionRange(6, 6); input.dispatchEvent(new Event('input', {bubbles: true})); });
  await page.locator('#association-results [role=option]').filter({hasText: '摄影日常'}).click();
  assert.equal((await description.inputValue()).match(/#摄影日常/g).length, 1);
  assert.equal(await page.locator('#association-results').isHidden(), true);
  await page.locator('#topic-recommendations button').filter({hasText: '#摄影日常'}).click();
  assert.equal((await description.inputValue()).match(/#摄影日常/g).length, 1, 'recommended topics cannot duplicate an existing token');
  const topicDescription = await description.inputValue();
  // 正文末尾与旧尾随空格均不新增空格；推荐项插入后保持可见 token 的精确文本。
  await description.fill('末尾 #摄');
  await page.locator('#association-results [role=option]').filter({hasText: '摄影日常'}).click();
  assert.equal(await description.inputValue(), '末尾 #摄影日常');
  await description.fill('末尾 #摄  ');
  await description.evaluate(input => { input.setSelectionRange(5, 5); input.dispatchEvent(new Event('input', {bubbles: true})); });
  await page.locator('#association-results [role=option]').filter({hasText: '摄影日常'}).click();
  assert.equal(await description.inputValue(), '末尾 #摄影日常', 'resolving a trailing token removes only obsolete horizontal tail separators');
  await description.fill('末尾');
  await page.locator('#topic-recommendations button').filter({hasText: '#摄影日常'}).click();
  assert.equal(await description.inputValue(), '末尾 #摄影日常', 'recommended topics at EOF have one leading separator and no trailing space');
  await description.fill('甲'.repeat(1000));
  await page.locator('#topic-recommendations button').filter({hasText: '#海边散步'}).click();
  assert.equal((await description.inputValue()).length, 1000, 'full description stays intact when adding a recommendation');
  assert.match(await description.evaluate(input => input.validationMessage), /字数上限/);
  await description.fill(topicDescription);
  await page.locator('#topic-recommendations button').filter({hasText: '#摄影日常'}).click();
  await page.keyboard.press('Escape');

  // 音乐右侧抽屉先读取推荐，再走授权接口进行关键词搜索；试听不视为选中配乐。
  await page.locator('#search-music').click();
  await page.locator('#search-dialog.music-drawer[open] .search-row').filter({hasText: '海边原声'}).waitFor();
  const drawer = await page.locator('#search-dialog').boundingBox();
  assert.ok(Math.abs(drawer.x + drawer.width - 1290) < 2 && drawer.y === 0, 'music drawer must attach to the right edge');
  await page.locator('#search-query').fill('钢琴');
  assert.equal(await page.locator('#search-more').isHidden(), true, 'new keyword immediately invalidates the previous music page');
  await page.locator('#search-results').dispatchEvent('scroll');
  const song = page.locator('#search-results .search-row').filter({hasText: '钢琴与海风'});
  await song.waitFor();
  assert.match(await song.innerText(), /02:03/);
  assert.match(await song.innerText(), /2\.5万人使用/);
  await page.mouse.move(0, 0);
  await page.locator('#search-query').focus();
  const listen = song.getByRole('button', {name: '试听 钢琴与海风', exact: true});
  for (let count = 0; count < 4 && !(await listen.evaluate(button => document.activeElement === button)); count++) await page.keyboard.press('Tab');
  assert.equal(await listen.evaluate(button => document.activeElement === button), true, 'music rows remain reachable using the keyboard');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#music-player').paused);
  assert.match(await page.locator('#music-player').getAttribute('src'), /piano\.wav$/);
  assert.equal(await page.locator('#music-name').textContent(), '点击添加适合作品风格音乐');
  await page.screenshot({path: output + 'studio-resources-music.png'});
  await song.hover();
  await song.getByRole('button', {name: '使用', exact: true}).click();
  await page.locator('#search-dialog').waitFor({state: 'hidden'});
  await page.waitForFunction(() => document.querySelector('#music-player').paused);
  assert.equal(await page.locator('#music-name').textContent(), '钢琴与海风');

  // 地点必须先选城市，空城市和空关键词均不能发起平台 POI 查询。
  const poiCount = () => page.evaluate(() => window.__resourcesUI.requests.filter(item => new URL(item.url).pathname.endsWith('/search/poi/')).length);
  const beforePOI = await poiCount();
  await page.locator('#search-location').click();
  await page.locator('#location-popover').getByText('请先选择城市，再搜索具体地点。', {exact: true}).waitFor();
  assert.equal(await poiCount(), beforePOI);
  await page.locator('#location-city').click();
  await page.locator('#city-popover input').fill('上海');
  await page.locator('#city-popover [role=option]').filter({hasText: '上海市'}).waitFor();
  assert.equal(await page.locator('#city-popover [role=option]').count(), 1, 'city search filters the local table');
  assert.equal(await poiCount(), beforePOI, 'opening and searching cities never queries POI');
  await page.screenshot({path: output + 'studio-resources-city.png'});
  await page.locator('#city-popover [role=option]').filter({hasText: '上海市'}).click();
  assert.equal(await page.locator('#location-city').textContent(), '上海市');
  await page.locator('#location-popover').getByText('输入地点名称搜索', {exact: true}).waitFor();
  assert.equal(await poiCount(), beforePOI);
  await page.locator('#location-popover input').fill('世纪');
  await page.locator('#location-popover [role=option]').filter({hasText: '世纪公园'}).waitFor();
  await page.locator('#location-popover').scrollIntoViewIfNeeded();
  await page.screenshot({path: output + 'studio-resources-location.png'});
  await page.locator('#location-popover [role=option]').filter({hasText: '世纪公园'}).click();
  assert.equal(await page.locator('#location-name').textContent(), '世纪公园');
  const poi = await page.evaluate(() => window.__resourcesUI.requests.filter(item => new URL(item.url).pathname.endsWith('/search/poi/')).at(-1));
  assert.equal(new URL(poi.url).searchParams.get('selected_city_code'), '310100');
  assert.equal(new URL(poi.url).searchParams.get('selected_city_name'), '上海市');

  // 保存后完整重载工作台，验证新字段没有只停留在局部视图状态。
  await page.locator('#save-draft').click();
  const saved = await page.evaluate(() => window.__resourcesUI.state.drafts[0]);
  assert.equal(saved.collection.id, '1102');
  assert.deepEqual(saved.settings.declarations, ['self_created']);
  assert.deepEqual(saved.topics, [{id: '2201', name: '摄影日常'}]);
  assert.equal(saved.music.id, '3302');
  assert.equal(saved.location.id, '4401');
  assert.equal(saved.location.cityCode, '310100');
  assert.equal(saved.location.cityName, '上海市');
  // 短推荐页可以在输入前预加载；输入关键词后不得再启动该推荐分类的旧续页。
  assert.equal(await page.evaluate(() => window.__resourcesUI.requests.some(item => { const url = new URL(item.url); return url.pathname === '/web/api/media/music/list' && url.searchParams.get('cursor') === '20' && item.queryAtRequest === '钢琴'; })), false, 'music cannot request an obsolete page during keyword debounce');
  const musicRequest = await page.evaluate(() => window.__resourcesUI.requests.find(item => new URL(item.url).hostname === 'tsearch.amemv.com'));
  assert.equal(new URL(musicRequest.url).searchParams.get('keyword'), '钢琴');
  assert.equal(musicRequest.headers['agw-auth'], 'synthetic-ui-grant');
  assert.equal(await page.evaluate(() => window.__resourcesUI.requests.some(item => item.method === 'POST')), false, 'resource browsing never publishes');
  await page.locator('.settings-panel').screenshot({path: output + 'studio-resources-settings.png'});
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({path: output + 'studio-resources-integrated.png', fullPage: true});
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.phase === 'editing');
  assert.equal(await page.locator('#collection-name').textContent(), '城市漫游');
  assert.match(await page.locator('#declaration-name').textContent(), /已选声明/);
  assert.equal(await page.locator('#music-name').textContent(), '钢琴与海风');
  assert.equal(await page.locator('#location-name').textContent(), '世纪公园');
  await page.locator('#location-city').filter({hasText: '上海市'}).waitFor();
  assert.equal(await page.locator('#description').inputValue(), saved.description);
  await page.locator('#account-menu summary').click();
  await page.locator('#connect').click();
  await page.locator('#connection-label').filter({hasText: '摄影日志'}).waitFor();
  await page.locator('#search-declaration').click();
  await page.locator('#declaration-popover [role=option][aria-selected=true]').filter({hasText: '作品由本人原创'}).waitFor();
  await page.keyboard.press('Escape');
  await page.setViewportSize({width: 820, height: 900});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({path: output + 'studio-resources-narrow.png', fullPage: true});
  assert.deepEqual(errors, []);
  // 原缺陷：新关键词输入后 250ms 内滚动旧列表，使旧续页阻塞新关键词首屏请求。
  // 合集已采用本地筛选，这里用真实地点控件保留同一网络查询/游标竞态，并先选择城市。
  const race = await browser.newPage();
  race.on('pageerror', error => errors.push(error.message));
  await race.goto(origin + '/resource-race.html');
  await race.waitForFunction(() => window.ready);
  await race.locator('#location-city').click();
  await race.locator('#city-popover input').fill('上海');
  await race.locator('#city-popover [role=option]').filter({hasText: '上海市'}).click();
  assert.deepEqual(await race.evaluate(() => calls), [], 'choosing a city alone never starts a location query');
  await race.locator('#location-popover input').fill('OLD');
  await race.waitForFunction(() => document.querySelectorAll('#location-popover [role=option]').length === 10);
  assert.equal(await race.locator('#location-popover .resource-more').isVisible(), true);
  await race.locator('#location-popover input').fill('NEW');
  assert.equal(await race.locator('#location-popover .resource-more').isHidden(), true, 'new keyword immediately hides obsolete location pagination');
  await race.locator('#location-popover .resource-options').evaluate(list => { list.scrollTop = list.scrollHeight; list.dispatchEvent(new Event('scroll')); });
  await race.locator('#location-popover [role=option]').filter({hasText: 'NEW-QUERY-RESULT'}).waitFor();
  assert.deepEqual(await race.evaluate(() => calls.map(({operation, query, cursor, cityCode}) => ({operation, query, cursor: cursor ?? null, cityCode}))), [
    {operation: 'locations.search', query: 'OLD', cursor: null, cityCode: '310100'},
    {operation: 'locations.search', query: 'NEW', cursor: null, cityCode: '310100'},
  ]);
  assert.equal(await race.locator('#location-popover [role=option]').count(), 1);
  // 续页已经在途时，新搜索仍可完成；迟到的旧续页不能混入新关键词候选。
  await race.locator('#location-popover input').fill('OLD');
  await race.waitForFunction(() => document.querySelectorAll('#location-popover [role=option]').length === 10);
  await race.locator('#location-popover .resource-more').click();
  await race.waitForFunction(() => typeof window.releaseOldPage === 'function');
  await race.locator('#location-popover input').fill('NEW');
  await race.locator('#location-popover [role=option]').filter({hasText: 'NEW-QUERY-RESULT'}).waitFor();
  await race.evaluate(async () => { releaseOldPage(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  assert.equal(await race.locator('#location-popover [role=option]').count(), 1);
  assert.equal(await race.locator('#location-popover [role=option]').textContent(), 'NEW-QUERY-RESULT');
  assert.deepEqual(await race.evaluate(() => calls.slice(2).map(({query, cursor}) => ({query, cursor: cursor ?? null}))), [
    {query: 'OLD', cursor: null}, {query: 'OLD', cursor: '10'}, {query: 'NEW', cursor: null},
  ]);
  await race.close();

  // 选项缓存以账号与作品类型隔离；草稿切换可复用分页，但不能复用另一账号候选。
  const cache = await browser.newPage();
  cache.on('pageerror', error => errors.push(error.message));
  await cache.goto(origin + '/resource-cache.html');
  await cache.waitForFunction(() => window.ready);
  const fixtureCalls = operation => cache.evaluate(op => fixture.calls.filter(call => call.operation === op), operation);
  await cache.locator('#search-collection').click();
  await cache.waitForFunction(() => document.querySelectorAll('#collection-popover [role=option]').length === 10);
  await cache.locator('#collection-popover input').fill('深海');
  await cache.locator('#collection-popover [role=option]').filter({hasText: '深海摄影 A'}).waitFor();
  assert.equal((await fixtureCalls('collections.list')).length, 2, 'empty filtered first page still reads the next page');
  await cache.locator('#collection-popover input').fill('周末');
  await cache.waitForFunction(() => document.querySelectorAll('#collection-popover [role=option]').length === 10);
  await cache.locator('#collection-popover input').fill('深海');
  await cache.locator('#collection-popover [role=option]').filter({hasText: '深海摄影 A'}).waitFor();
  assert.deepEqual((await fixtureCalls('collections.list')).map(({query, cursor}) => ({query, cursor: cursor ?? null})), [{query: '', cursor: null}, {query: '', cursor: '10'}], 'both pages are cached and remote collection reads have no local filter');
  await cache.keyboard.press('Escape');
  await cache.locator('#search-declaration').click();
  await cache.locator('#declaration-popover [role=option]').filter({hasText: '作品由本人原创 A'}).waitFor();
  assert.equal(await cache.locator('#declaration-popover [role=option]').count(), 2, 'only the exact excluded declaration label is removed');
  await cache.locator('#declaration-popover [role=option]').filter({hasText: '内容为转载信息的补充说明'}).waitFor();
  await cache.evaluate(() => setContext({id: 'second-draft'}));
  await cache.locator('#search-collection').click();
  await cache.waitForFunction(() => document.querySelectorAll('#collection-popover [role=option]').length === 10);
  await cache.locator('#collection-popover input').fill('深海');
  await cache.locator('#collection-popover [role=option]').filter({hasText: '深海摄影 A'}).waitFor();
  assert.equal((await fixtureCalls('collections.list')).length, 2, 'another draft under the same account reuses all read pages');
  await cache.keyboard.press('Escape');
  await cache.locator('#search-declaration').click();
  await cache.locator('#declaration-popover [role=option]').filter({hasText: '作品由本人原创 A'}).waitFor();
  assert.equal((await fixtureCalls('declarations.list')).length, 1, 'declaration options are reused across drafts');
  await cache.evaluate(() => setContext({account: 'B'}));
  await cache.locator('#search-collection').click();
  await cache.locator('#collection-popover [role=option]').filter({hasText: '周末摄影 B 0'}).waitFor();
  assert.equal(await cache.locator('#collection-popover [role=option]').filter({hasText: '摄影 A'}).count(), 0);
  assert.equal((await fixtureCalls('collections.list')).length, 3, 'switching accounts requires a fresh collection read');
  await cache.keyboard.press('Escape');
  await cache.locator('#search-declaration').click();
  await cache.locator('#declaration-popover [role=option]').filter({hasText: '作品由本人原创 B'}).waitFor();
  assert.equal((await fixtureCalls('declarations.list')).length, 2, 'switching accounts requires fresh declarations');
  await cache.evaluate(() => { setContext({account: 'C'}); fixture.failNext = 'collections.list'; });
  await cache.locator('#search-collection').click();
  await cache.locator('#collection-popover .resource-retry').waitFor({state: 'visible'});
  assert.match(await cache.locator('#collection-popover .resource-message').textContent(), /合成网络故障/);
  await cache.locator('#collection-popover .resource-retry').click();
  await cache.locator('#collection-popover [role=option]').filter({hasText: '周末摄影 C 0'}).waitFor();
  assert.equal((await fixtureCalls('collections.list')).filter(call => call.account === 'C').length, 2, 'failed reads are evicted so explicit retry can request again');
  await cache.evaluate(() => { setContext({account: 'D'}); fixture.malformedNext = 'collections.list'; });
  await cache.locator('#search-collection').click();
  await cache.locator('#collection-popover .resource-retry').waitFor({state: 'visible'});
  assert.match(await cache.locator('#collection-popover .resource-message').textContent(), /结果不完整/);
  await cache.locator('#collection-popover .resource-retry').click();
  await cache.locator('#collection-popover [role=option]').filter({hasText: '周末摄影 D 0'}).waitFor();
  assert.equal((await fixtureCalls('collections.list')).filter(call => call.account === 'D').length, 2, 'invalid responses cannot poison the cache across retry');
  // 离线保留已选字段；本地清除有独立入口，不为了清空草稿重新检查账号或读取列表。
  const callsBeforeClear = await cache.evaluate(() => {
    fixture.offline = true;
    fixture.draft.collection = {id: 'saved-collection', name: '已保存合集'};
    fixture.draft.location = {id: 'saved-location', name: '已保存位置', cityCode: '330100', cityName: '杭州市'};
    controls.close(); controls.render();
    return fixture.calls.length;
  });
  assert.equal(await cache.locator('#collection-name').textContent(), '已保存合集');
  assert.equal(await cache.locator('#location-name').textContent(), '已保存位置');
  assert.equal(await cache.locator('#search-collection').isDisabled(), true);
  assert.equal(await cache.locator('#search-location').isDisabled(), true);
  await cache.getByRole('button', {name: '清除合集', exact: true}).click();
  assert.equal(await cache.evaluate(() => fixture.draft.collection), null);
  assert.equal(await cache.evaluate(() => fixture.draft.location.id), 'saved-location');
  await cache.getByRole('button', {name: '清除位置', exact: true}).click();
  assert.equal(await cache.evaluate(() => fixture.draft.location), null);
  assert.equal(await cache.evaluate(() => fixture.calls.length), callsBeforeClear);
  assert.equal(await cache.getByRole('button', {name: '清除合集', exact: true}).count(), 0);
  assert.equal(await cache.getByRole('button', {name: '清除位置', exact: true}).count(), 0);
  await cache.close();

  // 名称话题只在明确选择后绑定；离线与查询失败仍能编辑，多个0不会互相覆盖。
  const topics = await browser.newPage();
  topics.on('pageerror', error => errors.push(error.message));
  await topics.goto(origin + '/resource-topics.html');
  await topics.waitForFunction(() => window.ready);
  const topicDescriptionInput = topics.locator('#description');
  const topicOption = name => topics.getByRole('option', {name: '# ' + name, exact: true});
  const readTopics = () => topics.evaluate(() => structuredClone(fixture.draft.topics));
  await topicDescriptionInput.fill('日期 #20190701');
  await topicOption('20190701').waitFor();
  assert.deepEqual(await readTopics(), [], 'typing a new hashtag leaves it ordinary unbound text');
  assert.equal(await topicOption('20190701').locator('.topic-heat').textContent(), '', 'new topics have no fabricated popularity');
  await topicOption('20190701').click();
  assert.deepEqual(await readTopics(), [{id: '0', name: '20190701'}]);
  await topicDescriptionInput.fill('日期 #20190701 #20190702');
  await topicOption('20190702').click();
  assert.deepEqual(await readTopics(), [{id: '0', name: '20190701'}, {id: '0', name: '20190702'}]);
  await topicDescriptionInput.fill('日期 #20190701 #20190702 #20190701');
  await topicOption('20190701').click();
  assert.equal((await topicDescriptionInput.inputValue()).match(/#20190701/g).length, 1, 'selecting the same name does not duplicate its text');
  assert.deepEqual((await readTopics()).map(item => item.name).sort(), ['20190701', '20190702']);

  await topics.evaluate(() => { fixture.mode = 'existing'; });
  await topicDescriptionInput.fill('日期 #20190701 #20190702 #已有话题');
  await topics.waitForFunction(() => document.querySelector('#association-results .topic-heat')?.textContent === '12.5万');
  assert.equal(await topics.locator('#association-results [role=option]').count(), 1, 'an exact existing ID replaces the zero-ID candidate');
  await topics.locator('#association-results [role=option]').click();
  assert.equal((await readTopics()).find(item => item.name === '已有话题').id, 'existing-id');

  const offlineCalls = await topics.evaluate(() => { fixture.online = false; return fixture.calls.length; });
  await topicDescriptionInput.fill('日期 #20190701 #20190702 #已有话题 #离线新词');
  await topicOption('离线新词').click();
  assert.equal((await readTopics()).find(item => item.name === '离线新词').id, '0');
  await topicDescriptionInput.fill('日期 #20190701 #20190702 #已有话题 #离线新词 #已有话题');
  await topicOption('已有话题').click();
  assert.equal((await readTopics()).find(item => item.name === '已有话题').id, 'existing-id', 'offline local candidates never downgrade a bound existing ID');
  assert.equal(await topics.evaluate(() => fixture.calls.length), offlineCalls, 'offline name selection sends no requests');

  await topics.evaluate(() => { fixture.online = true; fixture.mode = 'error'; });
  await topicDescriptionInput.fill('日期 #20190701 #20190702 #已有话题 #离线新词 #查询失败新词');
  await topics.locator('#association-results .resource-message').filter({hasText: '合成在线查询失败'}).waitFor();
  const failedCalls = await topics.evaluate(() => fixture.calls.length);
  await topicOption('查询失败新词').click();
  assert.equal((await readTopics()).find(item => item.name === '查询失败新词').id, '0');
  assert.equal(await topics.evaluate(() => fixture.calls.length), failedCalls, 'selecting the local candidate does not retry the failed remote lookup');

  await topics.evaluate(() => { fixture.mode = 'names'; });
  await topicDescriptionInput.fill('多个候选 #新话题');
  await topicOption('新话题乙').waitFor();
  assert.equal(await topics.locator('#association-results [role=option]').count(), 3, 'remote numeric zero IDs are retained separately by name alongside the exact local keyword');
  await topicOption('新话题甲').click();
  await topicDescriptionInput.fill('#新话题甲 #新话题');
  await topicOption('新话题乙').waitFor();
  assert.equal(await topicOption('新话题甲').getAttribute('aria-selected'), 'true');
  assert.equal(await topicOption('新话题乙').getAttribute('aria-selected'), 'false', 'zero-ID selection state is matched by name');
  await topicOption('新话题乙').click();
  assert.deepEqual((await readTopics()).map(item => item.name).sort(), ['新话题乙', '新话题甲']);
  await topics.evaluate(() => { fixture.online = false; });
  await topicDescriptionInput.fill('#' + '长'.repeat(201));
  assert.equal(await topics.locator('#association-results [role=option]').count(), 0, 'overlong names cannot create a candidate that payload validation would reject');
  await topics.close();
  assert.deepEqual(errors, []);
  console.log('resource UI passed: real host integration, collection covers/counts, account/draft page cache, declaration filtering/retry, exact caret tokens, local named topics and existing-ID priority, offline/error selection, music keyword/preview, searchable city and persisted POI, stale-page races, screenshots, no publication');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
