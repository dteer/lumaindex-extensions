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
const locationAccountFixture = resourceFixture(`
window.fixture={account:'A',draft:{id:'city-draft',kind:'image',assets:[],topics:[{id:'saved-topic',name:'已存话题'}],mentions:[],hotspot:'已存热点',location:null,settings:{declarations:[]}},calls:[]};
window.controls=mountResourceControls({current:()=>fixture.draft,supports:()=>true,safeURL:()=>'',identity:()=>fixture.account+':'+fixture.draft.id,cacheScope:()=>fixture.account+':'+fixture.draft.kind,blocked:()=>false,changed:()=>controls.render(),request:async(operation,params,{signal})=>{
  fixture.calls.push({operation,account:fixture.account,...params,signal});
  if(operation!=='locations.search')throw Error('Unexpected city fixture operation: '+operation);
  if(fixture.account==='A')return new Promise(resolve=>{fixture.releaseOld=()=>resolve({items:[{id:'old-poi',name:'旧账号迟到地点'}],nextCursor:null});});
  return {items:[{id:fixture.account+'-poi',name:fixture.account+'的地点'}],nextCursor:null};
}});controls.render();`);
const topicFixture = resourceFixture(`
window.fixture={draft:{id:'topic-draft',kind:'image',assets:[],description:'',topics:[],mentions:[],settings:{declarations:[]}},account:'A',calls:[],online:true,mode:'empty',holdRecommendation:false};
window.controls=mountResourceControls({current:()=>fixture.draft,supports:()=>fixture.online,safeURL:()=>'',identity:()=>fixture.account+':'+fixture.draft.id,blocked:()=>false,changed:()=>controls.render(),request:async(operation,params)=>{
  fixture.calls.push({operation,...params});
  if(operation!=='topics.search')throw Error('Unexpected topic fixture operation: '+operation);
  if(!params.query)return fixture.holdRecommendation?new Promise(resolve=>{fixture.releaseRecommendation=items=>resolve({items,nextCursor:null});}):{items:[],nextCursor:null};
  if(fixture.mode==='error')throw Error('合成在线查询失败，本地话题仍可添加。');
  if(fixture.mode==='existing')return {items:[{id:0,name:params.query,viewCount:0},{id:'existing-id',name:params.query,viewCount:125000}],nextCursor:null};
  if(fixture.mode==='names')return {items:[{id:0,name:'新话题甲',viewCount:0},{id:0,name:'新话题乙',viewCount:0}],nextCursor:null};
  return {items:[],nextCursor:null};
}});
document.getElementById('description').addEventListener('input',event=>{fixture.draft.description=event.target.value;});
controls.render();`);
const hotspotFixture = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/studio-resources.css"><link rel="stylesheet" href="/studio-help.css"><div id="hotspot"></div><script type="module">
import {mountHotspot} from '/studio-hotspot.js';
window.fixture={scope:'account-a',draft:{id:'hotspot-a',kind:'image',assets:[{id:'asset-a'}],hotspot:'原来选中的热点'},calls:[],pending:[],pendingDefaults:[],offline:false,latest:0,clock:10000,holdDefault:false,failDefault:false};
window.controls=mountHotspot({container:document.querySelector('#hotspot'),current:()=>fixture.draft,identity:()=>fixture.scope+':'+fixture.draft.id,supports:()=>!fixture.offline,blocked:()=>false,changed:()=>controls.render(),now:()=>fixture.clock,request:async(operation,params,{signal})=>{
  fixture.calls.push({operation,...params,signal});
  if(params.query==='慢')return new Promise(resolve=>fixture.pending.push(()=>resolve({items:[{name:'旧账号迟到热点'}]})));
  if(params.query)return {items:[{name:'关键词热点'}]};
  const name='当前热点'+(++fixture.latest);
  const result=()=>{if(fixture.failDefault)throw Error('合成热点更新失败');return {items:[{name}]};};
  if(fixture.holdDefault)return new Promise((resolve,reject)=>fixture.pendingDefaults.push(()=>{try{resolve(result());}catch(error){reject(error);}}));
  return result();
}});controls.render();window.ready=true;</script>`;
await mkdir(output, {recursive: true});
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/resource-hotspot.html') { response.setHeader('Content-Type', 'text/html'); response.end(hotspotFixture); return; }
  if (url.pathname === '/resource-location-account.html') { response.setHeader('Content-Type', 'text/html'); response.end(locationAccountFixture); return; }
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
  await page.route('https://media.example.test/**', route => route.fulfill({status: route.request().url().endsWith('broken-avatar.svg') ? 404 : 200, contentType: route.request().url().endsWith('.wav') ? 'audio/wav' : 'image/svg+xml', body: route.request().url().endsWith('broken-avatar.svg') ? '' : route.request().url().endsWith('.wav') ? wav : picture}));
  await page.addInitScript(({origin}) => {
    const profile = {id: 'profile-resources', accountId: '123', name: '摄影日志', browserSessionAvailable: true, hasCookies: true, expiresAt: new Date(Date.now() + 8 * 3600000).toISOString()};
    const runtime = {};
    window.__resourcesUI = {messages: [], requests: [], framesAvailable:false, offline:false, state: JSON.parse(sessionStorage.getItem('resources-ui-state') || '{}')};
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
        const value = typeof message.keys === 'string' && message.keys.startsWith('studio-uploads:') && window.__resourcesUI.framesAvailable ? {recommendationFrames: ['fixture-image-resource']} : runtime[message.keys];
        return {ok: true, data: message.keys ? {[message.keys]: value} : runtime};
      }
      if (message.op === 'state.set') { Object.assign(runtime, message.values); return {ok: true, data: {saved: true}}; }
      if (message.op !== 'browser.request') throw Error('Unexpected native resource operation: ' + message.op);
      const url = new URL(message.url);
      window.__resourcesUI.requests.push({url: message.url, headers: message.headers, credentials: message.credentials, method: message.method, queryAtRequest: document.querySelector('#search-query')?.value});
      if(window.__resourcesUI.offline)throw Error('合成离线，已选内容保留');
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
      else if (url.pathname === '/aweme/v1/hotspot/search/') data = {status_code:0,sentences:[{word:'城市里的温暖瞬间',hot_value:125000,word_cover:{url_list:['https://media.example.test/hotspot.svg']}},{word:'城市漫步发现新风景',hot_value:0}]};
      else if (url.pathname === '/aweme/v1/hotspot/recommend/') data = {status_code:0,rec_sentences:[{word:'推荐的生活热点',hot_value:8900,word_cover:{url_list:['https://media.example.test/hotspot.svg']}}],all_sentences:[{word:'推荐的生活热点',hot_value:8900},{word:'另一个官方热点'}]};
      else if (url.pathname === '/web/api/v2/user/recent/contact/') data = {status_code: 0, user_list: [
        {uid:'5101',nickname:'摄影同学',follower_count:139,unique_id:'photo_test',short_id:'1001',avatar_thumb:{url_list:['https://media.example.test/contact.svg']}},
        {uid:'5102',nickname:'零粉丝新朋友',follower_count:0,short_id:'1002'},
        {uid:'5103',nickname:'山野拾光',follower_count:12000,unique_id:'mountain_light',avatar_thumb:{url_list:['https://media.example.test/broken-avatar.svg']}},
        {uid:'5104',nickname:'仅有昵称的朋友',avatar_thumb:{url_list:['javascript:alert(1)']}},
        ...Array.from({length:6},(_,i)=>({uid:String(5105+i),nickname:i===0?'拥有一个非常长昵称的朋友用于检查窄屏文字是否保持在当前行':'最近联系人'+i,follower_count:80+i,unique_id:'recent_contact_'+i})),
      ],has_more:0};
      else if (url.pathname === '/web/api/v2/discover/search/') data = {status_code: 0, user_list: url.searchParams.get('cursor') === '0'
        ? Array.from({length:10},(_,i)=>({uid:String(6101+i),nickname:'小伙伴'+i,follower_count:100+i,unique_id:'searched_friend_'+i,avatar_thumb:{url_list:['https://media.example.test/contact.svg']}}))
        : [{uid:'6110',nickname:'小伙伴9',follower_count:109,unique_id:'searched_friend_9'},{uid:'6111',nickname:'小伙伴下一页',follower_count:7,short_id:'7011'}], has_more:url.searchParams.get('cursor') === '0' ? 1 : 0, cursor:Number(url.searchParams.get('cursor'))};
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
  assert.equal(await page.locator('.preview-column').isVisible(), true, 'normal editing retains the publishing preview alongside material previews');
  assert.equal(await page.locator('.studio-phone-segment').count(), 2);
  await page.locator('#title').fill('海边摄影日常');

  // 合集读取每个分页一次，后续关键词在已读候选中筛选，封面与总数来自平台真实字段。
  const requestCount = pathname => page.evaluate(path => window.__resourcesUI.requests.filter(item => new URL(item.url).pathname === path).length, pathname);

  // 未上传也可直接读取当前热点；默认列表短期复用，搜索和选择不上传，也不改正文话题。
  const hotspotField = page.getByRole('button', {name:'关联热点',exact:true});
  const hotspotPopup = page.locator('#studio-hotspot .hotspot-popover'), hotspotInput = page.getByRole('searchbox', {name:'搜索热点词',exact:true});
  const beforeHotspot = await page.evaluate(() => ({requests:__resourcesUI.requests.length,description:document.querySelector('#description').value,topics:__resourcesUI.state.drafts[0].topics}));
  await hotspotField.click();
  await hotspotPopup.getByRole('option').filter({hasText:'推荐的生活热点'}).waitFor();
  assert.equal(await hotspotPopup.locator('.hotspot-heading').textContent(), '全部热点');
  assert.equal(await page.evaluate(() => __resourcesUI.requests.length), beforeHotspot.requests + 1, 'opening without uploaded frames reads the current platform list once');
  const initialHotspotList = await page.evaluate(() => __resourcesUI.requests.find(item => new URL(item.url).pathname === '/aweme/v1/hotspot/recommend/'));
  assert.equal(new URL(initialHotspotList.url).searchParams.get('zip_uri'), '');
  assert.equal(await hotspotPopup.locator('.hotspot-cover img').first().getAttribute('src'), 'https://media.example.test/hotspot.svg');
  await hotspotInput.fill('城市');
  await hotspotPopup.getByRole('option').filter({hasText:'城市里的温暖瞬间'}).waitFor();
  assert.equal(await hotspotPopup.locator('.hotspot-heat').first().textContent(), '12.5万 在看');
  assert.equal(await hotspotPopup.locator('.hotspot-heat').nth(1).textContent(), '0 在看');
  await hotspotPopup.scrollIntoViewIfNeeded();
  await page.screenshot({path:output+'studio-resources-hotspot.png'});
  await hotspotInput.press('ArrowDown'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => __resourcesUI.state.drafts[0].hotspot === '城市里的温暖瞬间');
  assert.deepEqual(await page.evaluate(() => ({description:document.querySelector('#description').value,topics:__resourcesUI.state.drafts[0].topics})), {description:beforeHotspot.description,topics:beforeHotspot.topics});
  assert.equal(await page.evaluate(() => typeof __resourcesUI.state.drafts[0].hotspot), 'string');
  const hotspotSearch = await page.evaluate(() => __resourcesUI.requests.find(item => new URL(item.url).pathname === '/aweme/v1/hotspot/search/'));
  assert.equal(new URL(hotspotSearch.url).searchParams.get('query'), '城市');
  assert.equal(new URL(hotspotSearch.url).searchParams.get('count'), '50');

  // 重开列表立即复用默认结果；手动刷新后有检查点时带真实图片 URI，不按原选词过滤。
  await page.evaluate(() => { __resourcesUI.framesAvailable=true; });
  await hotspotField.click();
  await hotspotPopup.getByRole('option').filter({hasText:'推荐的生活热点'}).waitFor();
  assert.equal(await hotspotPopup.getByRole('option').count(), 2, 'recommended and complete catalogs are deduplicated by name');
  assert.equal(await hotspotInput.inputValue(), '');
  const beforeManualHotspot = await requestCount('/aweme/v1/hotspot/recommend/');
  assert.equal(beforeManualHotspot, 1, 'reopening within five minutes reuses the default list');
  await page.getByRole('button', {name:'刷新热点',exact:true}).click();
  await page.waitForFunction(() => __resourcesUI.requests.filter(item => new URL(item.url).pathname === '/aweme/v1/hotspot/recommend/').length === 2);
  const hotspotRecommendation = await page.evaluate(() => __resourcesUI.requests.filter(item => new URL(item.url).pathname === '/aweme/v1/hotspot/recommend/').at(-1));
  assert.equal(new URL(hotspotRecommendation.url).searchParams.get('zip_uri'), 'fixture-image-resource');
  await page.setViewportSize({width:560,height:850});
  await hotspotPopup.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const hotspotLabelLayout = await page.locator('#studio-hotspot').evaluate(container => {
    const label = container.querySelector('.hotspot-label'), field = container.querySelector('.resource-select');
    const range = document.createRange(); range.selectNodeContents(label.firstChild);
    const labelBox = label.getBoundingClientRect(), fieldBox = field.getBoundingClientRect();
    return {lines:range.getClientRects().length, centerOffset:Math.abs(labelBox.y + labelBox.height / 2 - fieldBox.y - fieldBox.height / 2)};
  });
  assert.equal(hotspotLabelLayout.lines, 1, 'narrow hotspot label stays on one line');
  assert.ok(hotspotLabelLayout.centerOffset <= 1, 'narrow hotspot label aligns vertically with its field');
  await page.screenshot({path:output+'studio-resources-hotspot-narrow.png'});
  await page.evaluate(() => { __resourcesUI.offline=true; });
  await hotspotInput.fill('查询失败');
  await hotspotPopup.locator('.resource-retry').waitFor();
  assert.equal(await hotspotField.textContent(), '城市里的温暖瞬间');
  assert.equal(await page.evaluate(() => __resourcesUI.state.drafts[0].hotspot), '城市里的温暖瞬间');
  const beforeLocalClear = await page.evaluate(() => __resourcesUI.requests.length);
  await page.getByRole('button', {name:'清除关联热点',exact:true}).click();
  await page.waitForFunction(() => __resourcesUI.state.drafts[0].hotspot === '');
  assert.equal(await page.evaluate(() => __resourcesUI.requests.length), beforeLocalClear, 'clearing a saved hotspot is local even while offline');
  await page.evaluate(() => { __resourcesUI.offline=false; });
  const hotspotHelp = page.getByRole('button', {name:'关联热点说明',exact:true});
  await hotspotHelp.scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await hotspotHelp.hover();
  assert.equal(await page.locator('#hotspot-help-description').isVisible(), true);
  await page.mouse.move(4,4);
  assert.equal(await page.locator('#hotspot-help-description').isHidden(), true);
  assert.equal(await page.evaluate(() => __resourcesUI.requests.filter(item => new URL(item.url).pathname === '/web/api/media/user/info/').length), 1, 'hotspot controls add no account checks');
  assert.equal(await page.evaluate(() => __resourcesUI.requests.some(item => item.method !== 'GET')), false, 'hotspot browsing never uploads or publishes');
  await page.setViewportSize({width:1290,height:1000});

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

  // 好友候选经过真实 client/engine 映射：最近联系人、头像与双行信息，不为缺失字段补造数值。
  const accountChecksBeforeContacts = await requestCount('/web/api/media/user/info/');
  await description.fill('前文 ');
  await page.locator('#search-mentions').click();
  const contacts = page.locator('#association-results'), contactRows = contacts.getByRole('option');
  await page.waitForFunction(() => document.querySelectorAll('#association-results .mention-option').length === 10);
  assert.equal(await contacts.locator('.mention-heading').textContent(), '最近联系人');
  assert.equal(await contacts.locator('.mention-heading').isVisible(), true);
  assert.equal(await contactRows.nth(0).locator('.mention-name').textContent(), '摄影同学');
  assert.equal(await contactRows.nth(0).locator('.mention-followers').textContent(), '粉丝数 139');
  assert.equal(await contactRows.nth(0).locator('.mention-handle').textContent(), '抖音号 photo_test');
  assert.equal(await contactRows.nth(0).locator('img').getAttribute('src'), 'https://media.example.test/contact.svg');
  assert.equal(await contactRows.nth(1).locator('.mention-followers').textContent(), '粉丝数 0');
  assert.equal(await contactRows.nth(1).locator('.mention-handle').textContent(), '抖音号 1002');
  assert.equal(await contactRows.nth(1).locator('img').count(), 0);
  assert.equal(await contactRows.nth(2).locator('.mention-followers').textContent(), '粉丝数 1.2万');
  await contactRows.nth(2).locator('img').waitFor({state:'detached'});
  assert.equal(await contactRows.nth(3).locator('.mention-details, img').count(), 0, 'missing fields and unsafe avatars are not fabricated');
  assert.equal(await contacts.locator('.resource-options').evaluate(element => element.clientHeight <= 280 && element.scrollHeight > element.clientHeight), true);
  await page.screenshot({path: output + 'studio-resources-contacts.png'});
  await description.press('ArrowDown');
  assert.equal(await contactRows.nth(0).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('Enter');
  assert.equal(await description.inputValue(), '前文 @摄影同学');
  await page.waitForFunction(() => window.__resourcesUI.state.drafts?.some(draft => draft.mentions?.[0]?.id === '5101'));
  assert.deepEqual(await page.evaluate(() => window.__resourcesUI.state.drafts.find(draft => draft.id === window.__resourcesUI.state.activeDraftId).mentions), [{id:'5101',name:'摄影同学'}]);

  // 搜索保持同一候选选择逻辑，内部滚动继续分页，Enter/点击仍绑定字符串 uid。
  await description.fill('前文 @小 后文');
  await description.evaluate(input => { input.setSelectionRange(5, 5); input.dispatchEvent(new Event('input', {bubbles:true})); });
  await contactRows.filter({hasText:'小伙伴0'}).waitFor();
  assert.equal(await contacts.locator('.mention-heading').isHidden(), true);
  assert.equal(await contactRows.count(), 10);
  await contacts.locator('.resource-options').evaluate(element => { element.scrollTop=element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
  await contactRows.filter({hasText:'小伙伴下一页'}).waitFor();
  assert.equal(await contactRows.count(), 11, 'page overlap is deduplicated by uid');
  assert.equal(await requestCount('/web/api/v2/discover/search/'), 2);
  await contactRows.filter({hasText:'小伙伴下一页'}).click();
  assert.equal(await description.inputValue(), '前文 @小伙伴下一页 后文');
  await page.waitForFunction(() => window.__resourcesUI.state.drafts?.some(draft => draft.mentions?.[0]?.id === '6111'));
  assert.deepEqual(await page.evaluate(() => window.__resourcesUI.state.drafts.find(draft => draft.id === window.__resourcesUI.state.activeDraftId).mentions), [{id:'6111',name:'小伙伴下一页'}]);
  await description.fill('窄屏 @');
  await contacts.locator('.mention-heading').waitFor();
  await page.setViewportSize({width:560,height:850});
  await contactRows.filter({hasText:'摄影同学'}).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await contacts.evaluate(element => element.getBoundingClientRect().right <= innerWidth && element.scrollWidth <= element.clientWidth), true);
  await page.screenshot({path: output + 'studio-resources-contacts-narrow.png'});
  await page.keyboard.press('Escape');
  assert.equal(await contacts.isHidden(), true);
  assert.equal(await requestCount('/web/api/media/user/info/'), accountChecksBeforeContacts, 'contact display and selection add no account checks');
  await page.setViewportSize({width:1290,height:1000});
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

  // 城市筛选属于当前草稿：只选城市后换账号仍保留，但旧账号请求必须取消并丢弃迟到结果。
  const cityAccount = await browser.newPage();
  cityAccount.on('pageerror', error => errors.push(error.message));
  await cityAccount.goto(origin + '/resource-location-account.html');
  await cityAccount.waitForFunction(() => window.ready);
  await cityAccount.locator('#location-city').click();
  await cityAccount.locator('#city-popover input').fill('上海');
  await cityAccount.locator('#city-popover [role=option]').filter({hasText:'上海市'}).click();
  assert.equal(await cityAccount.locator('#location-city').textContent(), '上海市');
  assert.equal(await cityAccount.evaluate(() => fixture.draft.location), null, 'choosing only a city does not invent a saved POI');
  assert.equal(await cityAccount.evaluate(() => fixture.calls.length), 0);
  const cityOnlyDraft = await cityAccount.evaluate(() => JSON.stringify(fixture.draft));
  await cityAccount.locator('#location-popover input').fill('旧查询');
  await cityAccount.waitForFunction(() => typeof fixture.releaseOld === 'function');
  await cityAccount.evaluate(() => { fixture.account='B'; controls.render(); });
  assert.equal(await cityAccount.evaluate(() => fixture.calls[0].signal.aborted), true);
  assert.equal(await cityAccount.locator('#location-popover').isHidden(), true);
  assert.equal(await cityAccount.locator('#location-city').textContent(), '上海市', 'account switch retains the unsaved city filter');
  assert.equal(await cityAccount.evaluate(() => JSON.stringify(fixture.draft)), cityOnlyDraft, 'account switch preserves saved topics/hotspot and the absence of a POI');
  await cityAccount.locator('#search-location').click();
  await cityAccount.locator('#location-popover input').fill('新查询');
  await cityAccount.locator('#location-popover [role=option]').filter({hasText:'B的地点'}).waitFor();
  assert.deepEqual(await cityAccount.evaluate(() => fixture.calls.map(({account,query,cityCode,cityName}) => ({account,query,cityCode,cityName}))), [
    {account:'A',query:'旧查询',cityCode:'310100',cityName:'上海市'},
    {account:'B',query:'新查询',cityCode:'310100',cityName:'上海市'},
  ]);
  await cityAccount.evaluate(() => fixture.releaseOld());
  await cityAccount.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(await cityAccount.locator('#location-popover [role=option]').count(), 1);
  assert.equal(await cityAccount.locator('#location-popover [role=option]').textContent(), 'B的地点');
  await cityAccount.locator('#location-popover [role=option]').click();
  const selectedCityDraft = await cityAccount.evaluate(() => JSON.stringify(fixture.draft));
  await cityAccount.evaluate(() => { fixture.account='C'; controls.render(); });
  assert.equal(await cityAccount.evaluate(() => JSON.stringify(fixture.draft)), selectedCityDraft, 'a later account switch also preserves the selected location');
  assert.equal(await cityAccount.locator('#location-name').textContent(), 'B的地点');
  await cityAccount.evaluate(() => {
    fixture.previousDraft=fixture.draft;
    fixture.draft={id:'new-city-draft',kind:'image',assets:[],topics:[],mentions:[],hotspot:'',location:null,settings:{declarations:[]}};
    controls.render();
  });
  assert.equal(await cityAccount.locator('#location-city').textContent(), '选择城市', 'a different draft starts with its own empty city filter');
  await cityAccount.evaluate(() => { fixture.draft=fixture.previousDraft; controls.render(); });
  assert.equal(await cityAccount.locator('#location-city').textContent(), '上海市', 'returning to a draft restores the saved location city');
  assert.equal(await cityAccount.evaluate(() => JSON.stringify(fixture.draft)), selectedCityDraft);
  assert.equal(await cityAccount.evaluate(() => fixture.calls.length), 2, 'switching accounts/drafts itself never queries locations');
  await cityAccount.close();

  // 默认热点五分钟内直接复用；过期或手动刷新保留旧列表，关闭重开复用同一在途请求。
  const hotspotRace = await browser.newPage();
  hotspotRace.on('pageerror', error => errors.push(error.message));
  const openHotspots = () => hotspotRace.getByRole('button', {name:'关联热点',exact:true}).click();
  const hotspotSearchInput = hotspotRace.getByRole('searchbox', {name:'搜索热点词',exact:true});
  const hotspotRefresh = hotspotRace.getByRole('button', {name:'刷新热点',exact:true});
  const releaseDefaults = () => hotspotRace.evaluate(() => { for(const finish of fixture.pendingDefaults.splice(0))finish(); });
  await hotspotRace.goto(origin + '/resource-hotspot.html');
  await hotspotRace.waitForFunction(() => window.ready);
  await openHotspots();
  await hotspotRace.getByRole('option').filter({hasText:'当前热点1'}).waitFor();
  assert.equal(await hotspotRace.locator('.hotspot-heading').textContent(), '全部热点');
  assert.equal(await hotspotSearchInput.inputValue(), '', 'opening a saved selection does not search its old word');
  await hotspotSearchInput.fill('关键词');
  await hotspotRace.getByRole('option').filter({hasText:'关键词热点'}).waitFor();
  assert.equal(await hotspotRace.locator('.hotspot-heading').textContent(), '搜索结果');
  assert.equal(await hotspotRefresh.isHidden(), true);
  await hotspotSearchInput.fill('');
  await hotspotRace.getByRole('option').filter({hasText:'当前热点1'}).waitFor();
  await hotspotRace.keyboard.press('Escape'); await openHotspots();
  await hotspotRace.getByRole('option').filter({hasText:'当前热点1'}).waitFor();
  assert.deepEqual(await hotspotRace.evaluate(() => fixture.calls.map(call => call.query)), ['', '关键词']);

  await hotspotRace.evaluate(() => { fixture.holdDefault=true; fixture.failDefault=true; });
  await hotspotRefresh.click();
  assert.equal(await hotspotRace.getByRole('option').first().textContent(), '当前热点1', 'manual refresh leaves the last successful list available');
  assert.equal(await hotspotRefresh.isDisabled(), true);
  await releaseDefaults();
  await hotspotRace.locator('.resource-message').filter({hasText:'合成热点更新失败'}).waitFor();
  assert.equal(await hotspotRace.getByRole('option').first().textContent(), '当前热点1');
  await hotspotRace.evaluate(() => { fixture.failDefault=false; });
  await hotspotRace.getByRole('button', {name:'重试',exact:true}).click(); await releaseDefaults();
  await hotspotRace.getByRole('option').filter({hasText:'当前热点3'}).waitFor();
  assert.equal(await hotspotRace.evaluate(() => fixture.draft.hotspot), '原来选中的热点', 'updates never replace the saved selection');

  await hotspotRace.keyboard.press('Escape');
  await hotspotRace.evaluate(() => { fixture.clock += 5*60*1000; });
  await openHotspots();
  assert.equal(await hotspotRace.getByRole('option').first().textContent(), '当前热点3', 'expired list is visible while the new request is pending');
  await hotspotRace.locator('.resource-message').filter({hasText:'正在更新'}).waitFor();
  const pendingDefaultCount = await hotspotRace.evaluate(() => fixture.calls.length);
  await hotspotRace.keyboard.press('Escape'); await openHotspots();
  assert.equal(await hotspotRace.evaluate(() => fixture.calls.length), pendingDefaultCount, 'rapid reopen shares the pending default request');
  assert.equal(await hotspotRace.evaluate(() => fixture.calls.at(-1).signal.aborted), false, 'closing does not cancel a reusable default read');
  await releaseDefaults();
  await hotspotRace.getByRole('option').filter({hasText:'当前热点4'}).waitFor();

  // 明确失效会重读；关闭后返回的默认结果仍可缓存，下一次打开不再等待。
  await hotspotRace.evaluate(() => controls.invalidate());
  await hotspotRace.waitForFunction(() => fixture.pendingDefaults.length===1);
  await hotspotRace.keyboard.press('Escape'); await releaseDefaults();
  const closedDefaultCount = await hotspotRace.evaluate(() => fixture.calls.length);
  await openHotspots();
  await hotspotRace.getByRole('option').filter({hasText:'当前热点5'}).waitFor();
  assert.equal(await hotspotRace.evaluate(() => fixture.calls.length), closedDefaultCount);

  // 上传快照失效只影响默认列表，不能吞掉正在进行的关键词搜索。
  await hotspotSearchInput.fill('慢');
  await hotspotRace.waitForFunction(() => fixture.pending.length === 1);
  await hotspotRace.evaluate(() => { controls.invalidate(); for(const finish of fixture.pending.splice(0))finish(); });
  await hotspotRace.getByRole('option').filter({hasText:'旧账号迟到热点'}).waitFor();

  // 账号、草稿、素材范围改变均取消并清空默认缓存；不接收忽略取消的旧响应。
  for (const change of ['account','draft','assets']) {
    await hotspotRace.goto(origin + '/resource-hotspot.html'); await hotspotRace.waitForFunction(() => window.ready);
    await hotspotRace.evaluate(() => { fixture.holdDefault=true; }); await openHotspots();
    await hotspotRace.waitForFunction(() => fixture.pendingDefaults.length===1);
    await hotspotRace.evaluate(change => {
      if(change==='account')fixture.scope='account-b';
      if(change==='draft')fixture.draft={...fixture.draft,id:'hotspot-b'};
      if(change==='assets')fixture.draft.assets=[{id:'asset-b'}];
      controls.render();
    },change);
    assert.equal(await hotspotRace.evaluate(() => fixture.calls[0].signal.aborted), true);
    await releaseDefaults();
    await hotspotRace.evaluate(() => { fixture.holdDefault=false; }); await openHotspots();
    await hotspotRace.getByRole('option').filter({hasText:'当前热点2'}).waitFor();
    assert.equal(await hotspotRace.getByRole('option').filter({hasText:'当前热点1'}).count(), 0);
    assert.equal(await hotspotRace.evaluate(() => fixture.calls.length), 2);
  }
  // 即便调用方尚未来得及 render，旧范围的缓存与 Promise 也不能被新范围复用。
  await hotspotRace.goto(origin + '/resource-hotspot.html'); await hotspotRace.waitForFunction(() => window.ready);
  await hotspotRace.evaluate(() => { fixture.holdDefault=true; }); await openHotspots();
  await hotspotRace.keyboard.press('Escape');
  await hotspotRace.evaluate(() => { fixture.scope='account-b'; }); await openHotspots();
  assert.equal(await hotspotRace.evaluate(() => fixture.calls.length), 2);
  assert.equal(await hotspotRace.evaluate(() => fixture.calls[0].signal.aborted), true);
  await releaseDefaults();
  await hotspotRace.getByRole('option').filter({hasText:'当前热点2'}).waitFor();

  await hotspotSearchInput.fill('慢'); await hotspotRace.waitForFunction(() => fixture.pending.length === 1);
  await hotspotRace.keyboard.press('Escape');
  assert.equal(await hotspotRace.evaluate(() => fixture.calls.at(-1).signal.aborted), true, 'keyword searches still cancel when closed');
  await hotspotRace.evaluate(() => { for(const finish of fixture.pending.splice(0))finish(); });
  const offlineHotspotCalls = await hotspotRace.evaluate(() => { fixture.offline=true; controls.render(); return fixture.calls.length; });
  assert.equal(await hotspotRace.getByRole('button', {name:'关联热点',exact:true}).isDisabled(), true);
  await hotspotRace.getByRole('button', {name:'清除关联热点',exact:true}).click();
  assert.equal(await hotspotRace.evaluate(() => fixture.draft.hotspot), '');
  assert.equal(await hotspotRace.evaluate(() => fixture.calls.length), offlineHotspotCalls);
  await hotspotRace.evaluate(() => { fixture.offline=false; fixture.holdDefault=true; controls.render(); controls.invalidate(); });
  await openHotspots(); await hotspotRace.waitForFunction(() => fixture.pendingDefaults.length===1);
  await hotspotRace.evaluate(() => controls.dispose());
  assert.equal(await hotspotRace.evaluate(() => fixture.calls.at(-1).signal.aborted), true, 'dispose cancels the default background request');
  await releaseDefaults();
  assert.equal(await hotspotRace.locator('#hotspot').textContent(), '');
  await hotspotRace.close();

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
  // 第一次点击添加话题同时聚焦正文；推荐栏和空词候选共用同一个在途请求。
  await topics.evaluate(() => { fixture.holdRecommendation = true; });
  await topics.locator('#search-topics').click();
  await topics.waitForFunction(() => typeof fixture.releaseRecommendation === 'function');
  assert.equal(await topics.evaluate(() => fixture.calls.filter(call => !call.query).length), 1, 'focus and empty topic dropdown share one request');
  await topics.evaluate(() => fixture.releaseRecommendation([{id:'first-recommendation',name:'推荐话题'}]));
  await topicOption('推荐话题').waitFor();
  await topics.locator('#topic-recommendations button').filter({hasText:'#推荐话题'}).waitFor();
  await topics.keyboard.press('Escape');
  await topics.locator('#search-topics').click();
  await topicOption('推荐话题').waitFor();
  assert.equal(await topics.evaluate(() => fixture.calls.filter(call => !call.query).length), 1, 'reopening reuses the completed recommendation page');
  // 即便传输忽略取消，旧账号的共享请求也不能回写新账号的推荐栏或候选。
  await topics.keyboard.press('Escape');
  await topics.evaluate(() => { controls.invalidateRecommendations(); delete fixture.releaseRecommendation; });
  await topics.locator('#search-topics').click();
  await topics.waitForFunction(() => typeof fixture.releaseRecommendation === 'function');
  await topics.evaluate(() => { fixture.account = 'B'; controls.render(); fixture.releaseRecommendation([{id:'stale',name:'旧账号推荐'}]); fixture.holdRecommendation = false; });
  await topics.locator('#search-topics').click();
  await topics.locator('#association-results .resource-message').filter({hasText:'没有找到匹配结果'}).waitFor();
  assert.equal(await topics.getByText('旧账号推荐', {exact:false}).count(), 0, 'late shared recommendation does not cross accounts');
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
