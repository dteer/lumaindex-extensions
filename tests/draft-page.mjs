import assert from 'node:assert/strict';
import vm from 'node:vm';
import {requestCreatorContext, draftStorage, stagingPageBinding, draftPageBinding, renderImportStatus, restoreVideoDownload, verifyDraftRender} from '../browser/draft-page.js';

const origin = 'https://creator.douyin.com';
const stagingToken = '12345678-1234-4234-8234-123456789012';
const stagingURL = (kind = 'image', token = stagingToken) => `${origin}/creator-micro/content/post/${kind}?luma_import=${token}`;
globalThis.location = new URL(stagingURL());
globalThis.document = {documentElement: {dataset: {lumaStagingToken: stagingToken}}};
const values = new Map(), writes = [];
let rejectKey;
globalThis.localStorage = {
  getItem(key) { return values.get(key) ?? null; },
  setItem(key, value) {
    writes.push(key);
    if (key === rejectKey) throw new DOMException('internal quota details', 'QuotaExceededError');
    values.set(key, value);
  },
};
const account = '123456', imageKey = `publish_cache:${account}:image`, videoKey = `publish_form_cache:${account}`;
const image = {files: [{uploadFile: {uri: 'images/one'}}]}, raw = JSON.stringify(image);
const write = (patch = {}) => draftStorage('write', {account, kind: 'image', stagingToken, expectedExists: false, expected: '', raw, ...patch});
assert.equal(write().ok, true);
assert.equal(values.get(imageKey), raw);
assert.equal(JSON.parse(values.get(`luma_import_backup:${account}:image`)).raw, null);
assert.deepEqual(draftStorage('read', {account, kind: 'image', stagingToken}), {ok: true, raw});
assert.equal(write().ok, false);
assert.equal(values.get(imageKey), raw);
globalThis.location = new URL(stagingURL('video'));
assert.equal(draftStorage('write', {account, kind: 'video', stagingToken, expectedExists: false, expected: '', raw: '{"cache":{"longStatus":2}}'}).ok, true);
assert.equal(values.get(videoKey), '{"cache":{"longStatus":2}}');
assert.equal(values.get(imageKey), raw);
// 视频原生恢复后可能把槽清空为字符串 null；它与不存在的旧稿都可以安全替换并保留备份。
values.set(videoKey, 'null');
assert.equal(draftStorage('write', {account, kind: 'video', stagingToken, expectedExists: true, expected: 'null', raw: '{"cache":{"longStatus":2}}'}).ok, true);
assert.equal(JSON.parse(values.get(`luma_import_backup:${account}:video`)).raw, 'null');
globalThis.location = new URL(stagingURL());

// 旧稿在备份成功后才允许替换；配额失败不能报告写入成功，也不能删除旧草稿。
const replacement = JSON.stringify({files: [], title: 'new'});
for (const failedKey of [`luma_import_backup:${account}:image`, imageKey]) {
  rejectKey = failedKey;
  const result = write({expectedExists: true, expected: raw, raw: replacement});
  assert.equal(result.ok, false);
  assert.match(result.error, /存储空间不足/);
  assert.equal(values.get(imageKey), raw);
}
rejectKey = undefined;
assert.equal(write({expectedExists: true, expected: raw, raw: replacement}).ok, true);
assert.equal(JSON.parse(values.get(`luma_import_backup:${account}:image`)).raw, raw);

// 即便调用方遗漏检查，页面边界仍拒绝覆盖已发表或已定时提交的作品。
for (const kind of ['image', 'video']) {
  globalThis.location = new URL(stagingURL(kind));
  for (const field of ['reEditId', 'modifyId', 'modifyItemId', 'scheduleItemId', 'rawModifyItem', 'rawModifyInfo', 'rawScheduleInfo']) {
    const key = kind === 'image' ? imageKey : videoKey;
    const submitted = JSON.stringify(kind === 'image' ? {files: [], [field]: 'published'} : {cache: {[field]: 'published'}});
    const fresh = kind === 'image' ? raw : '{"cache":{"longStatus":2}}';
    values.set(key, submitted);
    const replaceSubmitted = draftStorage('write', {account, kind, stagingToken, expectedExists: true, expected: submitted, raw: fresh});
    assert.equal(replaceSubmitted.ok, false); assert.match(replaceSubmitted.error, /不能覆盖已提交作品/);
    assert.equal(values.get(key), submitted);
    values.delete(key);
    const importSubmitted = draftStorage('write', {account, kind, stagingToken, expectedExists: false, expected: '', raw: submitted});
    assert.equal(importSubmitted.ok, false); assert.match(importSubmitted.error, /不能覆盖已提交作品/);
    assert.equal(values.has(key), false);
  }
}
globalThis.location = new URL(stagingURL());
for (const invalid of ['null', '[]', '"string"', '{']) assert.equal(write({raw: invalid}).ok, false);
assert.equal(write({account: 123456}).ok, false);
assert.equal(draftStorage('write').ok, false);
globalThis.location = new URL(`${origin}/creator-micro/content/post/image?enter_from=draft`);
assert.equal(write().ok, false);
globalThis.location = new URL(`${origin}/creator-micro/content/upload`);
const writesBeforeUpload = writes.length;
assert.equal(write().ok, false);
assert.equal(write({stagingToken: undefined}).ok, false);
assert.equal(draftStorage('read', {account, kind: 'image'}).ok, false);
assert.equal(writes.length, writesBeforeUpload, 'ordinary upload entry must not save or back up drafts');
globalThis.location = new URL(stagingURL().replace(origin, 'https://example.com'));
assert.equal(write().ok, false);
globalThis.location = new URL(stagingURL());

// 创作者请求目标固定且不接受任意 URL；错误回执不得包含临时密钥或平台诊断正文。
const auth = {AccessKeyID: 'test-key', SecretAccessKey: 'test-secret', SessionToken: 'test-token', ExpiredTime: new Date(Date.now() + 60000).toISOString()};
let responseData = {status_code: 0, user: {uid: account}}, requested = [];
globalThis.fetch = async (url, options) => {
  requested.push(url);
  assert.equal(options.credentials, 'include');
  assert.equal(options.redirect, 'error');
  return {ok: true, json: async () => responseData};
};
assert.deepEqual(await requestCreatorContext('account'), {ok: true, account});
responseData = {status_code: 0, auth: JSON.stringify(auth)};
assert.deepEqual(await requestCreatorContext('auth'), {ok: true, auth});
responseData = {status_code: 0, encode: 1, duration: 2};
assert.deepEqual(await requestCreatorContext('video-status', 'vid-1'), {ok: true, data: responseData});
assert.equal(requested.at(-1), '/web/api/media/video/transend/?video_id=vid-1');
assert.deepEqual(await requestCreatorContext('video-enable', 'vid-1'), {ok:true,data:responseData});
assert.equal((await requestCreatorContext('video-enable', '../unsafe')).ok,false);
assert.equal(requested.at(-1), '/web/api/media/video/enable/?video_id=vid-1');
const requestCount = requested.length;
assert.equal((await requestCreatorContext('https://evil.example')).ok, false);
assert.equal((await requestCreatorContext('video-status', '../unsafe')).ok, false);
assert.equal(requested.length, requestCount);
responseData = {status_code: 1, message: 'internal secret'};
assert.equal((await requestCreatorContext('auth')).ok, false);
assert.doesNotMatch((await requestCreatorContext('account')).error, /internal secret/);
responseData = {status_code: 0, user: {uid: 123}};
assert.equal((await requestCreatorContext('account')).ok, false);
responseData = {status_code: 0, auth: JSON.stringify({...auth, ExpiredTime: '2000-01-01'})};
assert.equal((await requestCreatorContext('auth')).ok, false);

// 准备页函数以 Chrome executeScript 相同的序列化方式执行，不能依赖模块闭包，也不能修改 DOM 绑定。
function stagingFixture({kind = 'image', href = stagingURL(kind), token = stagingToken} = {}) {
  const stored = new Map(), changes = [];
  const context = vm.createContext({
    URL, location: new URL(href), document: {documentElement: {dataset: Object.freeze({lumaStagingToken: token})}},
    localStorage: {
      getItem(key) { return stored.get(key) ?? null; },
      setItem(key, value) { changes.push(key); stored.set(key, value); },
    },
  });
  vm.runInContext(`globalThis.binding = (${stagingPageBinding.toString()}); globalThis.storage = (${draftStorage.toString()});`, context);
  return {context, stored, changes};
}
for (const kind of ['image', 'video']) {
  const {context, stored, changes} = stagingFixture({kind});
  assert.equal(context.binding(stagingToken, kind).matches, true);
  const payload = {account, kind, stagingToken};
  const key = kind === 'image' ? imageKey : videoKey;
  const content = kind === 'image' ? raw : '{"cache":{"longStatus":2}}';
  assert.equal(context.storage('read', payload).raw, null);
  // 缺缓存必须显式传 false 与空字符串；旧 null 契约及被 Chrome 省略后的缺失参数均不能回退。
  for (const expected of [
    {}, {expected:null}, {expected:''}, {expected:content},
    {expectedExists:false}, {expectedExists:false,expected:null}, {expectedExists:false,expected:content},
    {expectedExists:true}, {expectedExists:true,expected:null}, {expectedExists:0,expected:''},
  ]) {
    const result = context.storage('write', {...payload, raw:content, ...expected});
    assert.equal(result.ok,false);assert.match(result.error,/草稿写入数据无效/);assert.equal(changes.length,0);
  }
  const transmitted = JSON.parse(JSON.stringify({...payload,raw:content,expectedExists:false,expected:''},(key,value)=>value === null ? undefined : value));
  assert.equal(context.storage('write', transmitted).ok, true);
  assert.equal(stored.get(key), content);
  assert.deepEqual(changes, [`luma_import_backup:${account}:${kind}`, key]);
  assert.equal(JSON.parse(stored.get(`luma_import_backup:${account}:${kind}`)).raw,null);
  assert.equal(context.storage('read', payload).raw, content);
  // 准备页仍遵循原草稿比较与备份契约，不因插件自身渲染而放宽冲突检查。
  assert.equal(context.storage('write', {...payload, raw: content, expectedExists: false, expected: ''}).ok, false);
  assert.equal(context.storage('write', {...payload, raw: content, expectedExists: true, expected: content+' '}).ok, false);
  assert.equal(changes.length, 2);
  assert.equal(context.storage('read', {account, kind}).ok, false);
  assert.equal(context.storage('read', {...payload, kind: kind === 'image' ? 'video' : 'image'}).ok, false);
}
for (const token of [undefined, null, '', 'short', stagingToken.replace('-4234-', '-1234-'), stagingToken.replace('-8234-', '-7234-'), `${stagingToken}0`, 'ABCDEF01-abcd-4abc-8abc-abcdef012345']) {
  const {context, changes} = stagingFixture();
  assert.equal(context.binding(token, 'image').ok, false);
  assert.equal(context.storage('write', {account, kind: 'image', stagingToken: token, raw, expectedExists: false, expected: ''}).ok, false);
  assert.equal(changes.length, 0);
}
for (const fixture of [
  {href: stagingURL().replace(origin, 'https://example.com')},
  {href: stagingURL().replace(origin, `${origin}:8443`)},
  {href: stagingURL().replace('https://', 'https://user:pass@')},
  {href: stagingURL('video')},
  {href: `${origin}/creator-micro/content/upload?luma_import=${stagingToken}`},
  {href: `${origin}/creator-micro/content/post/image`},
  {href: `${stagingURL()}&luma_import=${stagingToken}`},
  {href: `${stagingURL()}&luma_import=other`},
  {href: `${stagingURL()}&iid=published`},
  {href: `${stagingURL()}&type=new`},
  {href: `${stagingURL()}&enter_from=draft`},
  {href: `${stagingURL()}#changed`},
  {href: `${stagingURL()}&`},
  {href: stagingURL().replace('luma_import', 'luma%5Fimport')},
  {href: stagingURL().replace(stagingToken, `%31${stagingToken.slice(1)}`)},
  {token: undefined, href: stagingURL('image', stagingToken.replace('12345678', '87654321'))},
  {token: 'another-token'},
  {token: ''},
]) {
  const {context, changes} = stagingFixture(fixture);
  assert.equal(context.binding(stagingToken, 'image').matches, false, JSON.stringify(fixture));
  const payload = {account, kind: 'image', stagingToken};
  assert.equal(context.storage('read', payload).ok, false);
  assert.equal(context.storage('write', {...payload, raw, expectedExists: false, expected: ''}).ok, false);
  assert.equal(changes.length, 0);
}
const navigationDuringImport = stagingFixture();
assert.equal(navigationDuringImport.context.binding(stagingToken, 'image').matches, true);
navigationDuringImport.context.location = new URL(`${origin}/creator-micro/content/upload`);
assert.equal(navigationDuringImport.context.binding(stagingToken, 'image').matches, false);
assert.equal(navigationDuringImport.context.storage('write', {account, kind: 'image', stagingToken, raw, expectedExists: false, expected: ''}).ok, false);
assert.equal(navigationDuringImport.changes.length, 0);

// 标签绑定只使用自身 DOM dataset；人工编辑不清标记，任何导航（含 SPA 和往返缓存）都清除。
const pageURL = `${origin}/creator-micro/content/post/image?enter_from=draft`;
const marker = '12345678-1234-1234-1234-123456789012';
globalThis.location = new URL(pageURL);
globalThis.document = {documentElement: {dataset: {}}};
let navigationCallbacks = [], pageCallbacks = [];
globalThis.navigation = {addEventListener(event, callback, options) { assert.equal(event, 'navigate'); assert.equal(options.once, true); navigationCallbacks.push(callback); }};
globalThis.addEventListener = (event, callback, options) => { assert.equal(event, 'pagehide'); assert.equal(options.once, true); pageCallbacks.push(callback); };
const binding = {kind: 'image', marker};
assert.equal(draftPageBinding('check', binding).matches, false);
assert.equal(draftPageBinding('mark', binding).ok, true);
assert.equal(draftPageBinding('check', binding).matches, true);
assert.equal(draftPageBinding('check', {...binding, marker: `${marker}0`}).matches, false);
assert.equal(draftPageBinding('check', {...binding, kind: 'video'}).matches, false);
location.search = '?enter_from=other';
assert.equal(draftPageBinding('check', binding).matches, false);
globalThis.location = new URL(pageURL);
navigationCallbacks.splice(0).forEach(callback => callback());
assert.equal(draftPageBinding('check', binding).matches, false);
assert.equal(draftPageBinding('mark', binding).ok, true);
pageCallbacks.splice(0).forEach(callback => callback());
assert.equal(draftPageBinding('check', binding).matches, false);
for (const suffix of ['&iid=published', '&mid=published', '&vid=published', '&draft_id=other', '&type=new', `&luma_import=${stagingToken}`, '&luma_import=']) {
  globalThis.location = new URL(pageURL + suffix);
  assert.equal(draftPageBinding('mark', binding).ok, false);
  document.documentElement.dataset.lumaDirectDraftURL = location.href;
  document.documentElement.dataset.lumaDirectDraftMarker = marker;
  assert.equal(draftPageBinding('check', binding).matches, false);
}
// 即使残留原生绑定标记也不能在准备页触发视频控件事件，未触碰任何表单前就要终止。
for (const token of [stagingToken, '']) {
  globalThis.location = new URL(stagingURL('video', token));
  document.documentElement.dataset.lumaDirectDraftMarker = marker;
  document.documentElement.dataset.lumaDirectDraftURL = location.href;
  document.querySelectorAll = () => { throw Error('Must not inspect native controls on a staging page'); };
  assert.equal((await restoreVideoDownload(marker)).ok, false);
}
globalThis.location = new URL(pageURL);
assert.equal(draftPageBinding('mark', {...binding, marker: 'short'}).ok, false);
const nativeNavigation = globalThis.navigation;
delete globalThis.navigation;
assert.equal(draftPageBinding('mark', binding).ok, false);
globalThis.navigation = nativeNavigation;

// 极小 DOM 夹具只提供公开字段；访问私有属性、点击控件或派发事件都会失败。
function input(value, placeholder = '') {
  return {value, placeholder, getClientRects() { return this.collapsed ? [] : [1]; }, getAttribute(name) { return name === 'placeholder' ? placeholder : ''; }, click() { throw Error('must not click'); }, dispatchEvent() { throw Error('must not dispatch'); }};
}
function description(value) {
  return {...input(value, '作品描述'), matches() { return false; }, isContentEditable: false, cloneNode() { return {querySelectorAll() { return []; }}; }};
}
function picture(uri, cloned = false) {
  return {src: `${origin}/${uri}~tplv.jpg`, complete: true, naturalWidth: 10, tagName: 'IMG', closest() { return cloned ? {} : null; }};
}
let title = input('标题', '填写标题'), text = description('描述'), images = [picture('images/one'), picture('images/two')];
let cover = picture('images/cover'), count = {textContent: '已添加 2 张图片'};
let video = {readyState: 1, videoWidth: 960, videoHeight: 540, duration: 12, poster: '', getClientRects() { return [1]; }};
globalThis.getComputedStyle = element => element.style || {display: 'block', visibility: 'visible'};
let selectedLocation = input('公园');
const setting = label => ({...input(''), textContent: label, checked: {...input(''), checked: true}, querySelector() { return this.checked; }});
let fields = ['公开', '允许', '立即发布'].map(setting);
let extraTitles = [], extraDescriptions = [], extraInputs = [], extraLocations = [];
let collectionNames = [], collectionOrders = [];
globalThis.document = {
  querySelectorAll(selector) {
    const entries = {
      'input,textarea': [title, ...extraTitles], 'textarea,[contenteditable=true]': [text, ...extraDescriptions], 'div,span,p': [count],
      '[class^="carousel-"] img': images, '[class^="mycard-"] img,[class^="mycard-"] [class^="cover-"]': [cover],
      '[class*="select-collection-"] [class*="selected-item-title-"]': collectionNames,
      '[class*="select-collection-"] .semi-select-selection-text': collectionNames,
      '[class*="mix-sel-wrap-"] [class*="sel-area-"] .semi-select-selection-text': collectionNames,
      '[class*="sel-order-"] .semi-select-selection-text': collectionOrders,
      label: fields, input: [title, selectedLocation, ...extraInputs], 'input,.semi-select-selection-text': [selectedLocation, ...extraLocations], video: [video], '*': [],
    };
    assert.ok(Object.hasOwn(entries, selector), selector);
    return entries[selector];
  },
};
location.pathname = '/creator-micro/content/post/image';
const draft = {title: '标题', text: '描述', files: [{uploadFile: {uri: 'images/one'}}, {uploadFile: {uri: 'images/two'}}], coverInfo: {upload_uri: 'images/cover'}, visibilityType: 0, download: 1, scheduleTime: -1, anchor: {id: '12', payload: '公园'}};
assert.equal(verifyDraftRender(draft).ok, true);
location.search = `?luma_import=${stagingToken}`;
assert.equal(verifyDraftRender(draft).ok, false);
location.search = '?enter_from=draft';

// 原生多行描述采用独立行容器，整体 textContent 不含行间换行；读取时须保留中间空行。
let renderedLines = ['第一行\u200b', '\u200b', '第三行\ufeff'];
const plainDescription = text;
text = {...description(''), isContentEditable: true, cloneNode() {
  return {
    textContent: renderedLines.join(''),
    querySelectorAll(selector) {
      if (selector === '[data-line-wrapper=true]') return renderedLines.map(textContent => ({textContent}));
      assert.equal(selector, '[data-slate-placeholder],[data-placeholder=true]'); return [];
    },
  };
}};
const multilineDraft = {...draft, text: '第一行\r\n\r\n第三行'};
assert.equal(verifyDraftRender(multilineDraft).ok, true);
assert.equal(verifyDraftRender({...multilineDraft, text: '第一行\n第三行'}).ok, false, 'missing blank lines must not compare equal');
assert.equal(verifyDraftRender({...multilineDraft, text: '第一行\n\n错误描述'}).ok, false);
renderedLines = ['第一行\r\n第二行', '', '第三行'];
assert.equal(verifyDraftRender({...multilineDraft, text: '第一行\n第二行\n\n第三行'}).ok, true);
// 其他可编辑控件没有行容器时仍按公开 textContent 回读，textarea 也统一 CRLF。
text = {...description(''), isContentEditable: true, cloneNode() { return {textContent: '第一行\r\n第二行', querySelectorAll() { return []; }}; }};
assert.equal(verifyDraftRender({...draft, text: '第一行\n第二行'}).ok, true);
text = description('第一行\r\n第二行');
assert.equal(verifyDraftRender({...draft, text: '第一行\n第二行'}).ok, true);
text = plainDescription;
// 隐藏的付费标题、描述和设置副本不会破坏展示确认，也不能替代错误的可见内容。
extraTitles = [{...input('', '请输入付费场景下的视频标题'), collapsed: true}];
extraDescriptions = [{...description('隐藏描述'), style: {visibility: 'hidden'}}];
fields.push({...setting('公开'), style: {display: 'none'}});
assert.equal(verifyDraftRender(draft).ok, true);
extraTitles[0].collapsed = false; assert.equal(verifyDraftRender(draft).ok, false); extraTitles[0].collapsed = true;
extraDescriptions[0].style = {}; assert.equal(verifyDraftRender(draft).ok, false); extraDescriptions[0].style = {visibility: 'hidden'};
for (const hiddenField of [title, text, fields[0], fields[0].checked]) {
  hiddenField.collapsed = true; assert.equal(verifyDraftRender(draft).ok, false); hiddenField.collapsed = false;
  hiddenField.style = {visibility: 'hidden'}; assert.equal(verifyDraftRender(draft).ok, false); delete hiddenField.style;
}
extraLocations = [{...input('公园'), style: {display: 'none'}}];
selectedLocation.value = '错误位置'; assert.equal(verifyDraftRender(draft).ok, false); selectedLocation.value = '公园';
fields[2].textContent = '定时发布';
const scheduled = {...draft, scheduleTime: '2030-01-01 08:00'};
extraInputs = [{...input(scheduled.scheduleTime, '日期和时间'), collapsed: true}];
assert.equal(verifyDraftRender(scheduled).ok, false);
extraInputs[0].collapsed = false; assert.equal(verifyDraftRender(scheduled).ok, true);
fields[2].textContent = '立即发布'; extraInputs = [];
title.value = '旧标题'; assert.equal(verifyDraftRender(draft).ok, false); title.value = draft.title;
text.value = '旧描述'; assert.equal(verifyDraftRender(draft).ok, false); text.value = draft.text;
count.textContent = '已添加 1 张图片'; assert.equal(verifyDraftRender(draft).ok, false); count.textContent = '已添加 2 张图片';
images.reverse(); assert.equal(verifyDraftRender(draft).ok, false); images.reverse();
images[0].naturalWidth = 0; assert.equal(verifyDraftRender(draft).ok, false); images[0].naturalWidth = 10;
images[0].src = `${origin}/images/one-extra~tplv.jpg`; assert.equal(verifyDraftRender(draft).ok, false); images[0] = picture('images/one');
images.unshift(picture('images/two', true)); assert.equal(verifyDraftRender(draft).ok, true); images.shift();
cover = picture('old-cover'); assert.equal(verifyDraftRender(draft).ok, false); cover = picture('images/cover');
fields[0].checked.checked = false; assert.equal(verifyDraftRender(draft).ok, false); fields[0].checked.checked = true;
selectedLocation.value = '旧地点'; assert.equal(verifyDraftRender(draft).ok, false); selectedLocation.value = '公园';
location.pathname = '/creator-micro/content/upload'; assert.equal(verifyDraftRender(draft).ok, false);
location.pathname = '/creator-micro/content/post/video';
const videoDraft = {cache: {itemTitle: draft.title, textResult: {text: draft.text}, longFileInfo: {width: 1920, height: 1080, duration: 12, coverUri: 'video/cover'}, visibilityType: 0, download: 1, scheduleTime: -1, anchorId: '12', anchorPayload: '公园'}};
assert.equal(verifyDraftRender(videoDraft, 'video').ok, true);
location.search = `?luma_import=${stagingToken}`;
assert.equal(verifyDraftRender(videoDraft, 'video').ok, false);
location.search = '?enter_from=draft';
video.readyState = 0; assert.equal(verifyDraftRender(videoDraft, 'video').ok, false); video.readyState = 1;
video.hidden = true; assert.equal(verifyDraftRender(videoDraft, 'video').ok, false); video.hidden = false;
video.duration = 30; assert.equal(verifyDraftRender(videoDraft, 'video').ok, false); video.duration = 12;
video.videoHeight = 960; assert.equal(verifyDraftRender(videoDraft, 'video').ok, false); video.videoHeight = 540;
video.poster = `${origin}/video/other~tplv.jpg`; assert.equal(verifyDraftRender(videoDraft, 'video').ok, false);
video.poster = `${origin}/video/cover~tplv.jpg`; assert.equal(verifyDraftRender(videoDraft, 'video').ok, true);

// 校正前只允许暂缓视频的禁止保存项；标题、其他设置和最终完整回读均不能放宽。
const deniedVideoDraft = {cache: {...videoDraft.cache, download: 0}};
assert.equal(verifyDraftRender(deniedVideoDraft, 'video').ok, false);
assert.equal(verifyDraftRender(deniedVideoDraft, 'video', true).ok, true);
text.value = '未恢复'; assert.equal(verifyDraftRender(deniedVideoDraft, 'video', true).ok, false); text.value = draft.text;
fields[0].checked.checked = false; assert.equal(verifyDraftRender(deniedVideoDraft, 'video', true).ok, false); fields[0].checked.checked = true;
fields[1].checked.checked = false;
assert.equal(verifyDraftRender(videoDraft, 'video', true).ok, false);
fields[1].textContent = '不允许'; fields[1].checked.checked = true;
assert.equal(verifyDraftRender(deniedVideoDraft, 'video').ok, true);
location.pathname = '/creator-micro/content/post/image'; fields[1].checked.checked = false;
assert.equal(verifyDraftRender({...draft, download: 0}, 'image', true).ok, false);

// 只在合集控件中核对名称和集数，隐藏或错误文字不能替代实际选择。
fields[1].textContent = '允许'; fields[1].checked.checked = true;
const collectionName = {...input(''),textContent:'旅行',closest(){return null;}};
const collectionOrder = {...input(''),textContent:'第 4 集'};
for (const kind of ['image','video']) {
  location.pathname = `/creator-micro/content/post/${kind}`;
  const source = kind === 'image' ? {...draft,collectionInfo:{mix_id:'123',mix_name:'旅行',mix_order:4}}
    : {...videoDraft,cache:{...videoDraft.cache,mixId:'123',mixInfo:{mix_name:'旅行'},mixOrder:4}};
  collectionNames = [collectionName]; collectionOrders = [collectionOrder];
  assert.equal(verifyDraftRender(source,kind).ok,true);
  collectionName.textContent = '旧合集'; assert.equal(verifyDraftRender(source,kind).ok,false); collectionName.textContent = '旅行';
  collectionName.hidden = true; assert.equal(verifyDraftRender(source,kind).ok,false); collectionName.hidden = false;
  collectionOrder.textContent = '第5集'; assert.equal(verifyDraftRender(source,kind).ok,false); collectionOrder.textContent = '第4集';
  collectionOrders = []; assert.equal(verifyDraftRender(source,kind).ok,false);
}
console.log('PASS visible native collection title and episode readback for image/video without component events');

// 明确清除时残留的名称或集数都失败；无合集权限且不渲染整栏的账号允许不选合集。
for (const kind of ['image','video']) {
  location.pathname = `/creator-micro/content/post/${kind}`;
  const source = kind === 'image' ? {...draft,collectionInfo:null} : {...videoDraft,cache:{...videoDraft.cache,mixId:null}};
  collectionNames = [collectionName]; collectionOrders = [];
  collectionName.textContent = kind === 'image' ? '不选择合集' : '请选择合集';
  assert.equal(verifyDraftRender(source,kind).ok,true);
  collectionOrders = [collectionOrder]; assert.equal(verifyDraftRender(source,kind).ok,false); collectionOrders = [];
  collectionName.textContent = '旧合集'; assert.equal(verifyDraftRender(source,kind).ok,false);
  collectionNames = []; assert.equal(verifyDraftRender(source,kind).ok,true);
}

// 扩展状态面板只使用自身 Shadow DOM 和 textContent，不把文案解析成 HTML。
class Node {
  constructor(tagName) { this.tagName = tagName; this.children = []; this.style = {}; }
  setAttribute() {}
  append(...nodes) { this.children.push(...nodes); }
  attachShadow() { this.shadowRoot = new Node('shadow'); return this.shadowRoot; }
  getElementById(id) { if (this.id === id) return this; return this.children.map(child => child.getElementById(id)).find(Boolean); }
}
const root = new Node('root');
globalThis.document = {documentElement: root, createElement: name => new Node(name), getElementById: id => root.getElementById(id)};
assert.equal(renderImportStatus('<img onerror=bad()>').ok, true);
assert.equal(root.children.length, 1);
assert.equal(root.children[0].shadowRoot.getElementById('status').textContent, '<img onerror=bad()>');
renderImportStatus('已上传', '说明');
assert.equal(root.children.length, 1);
assert.equal(root.children[0].shadowRoot.getElementById('status').textContent, '已上传');
console.log('PASS isolated draft storage CAS/backup/quota guards, fixed creator requests, native visible readback and extension-only status panel');
