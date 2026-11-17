import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const browser = new URL('../browser/', import.meta.url);
const [contentSource, uiSource, html, manifest, rules] = await Promise.all([
  readFile(new URL('staging-content.js', browser), 'utf8'), readFile(new URL('staging.js', browser), 'utf8'),
  readFile(new URL('staging.html', browser), 'utf8'), readFile(new URL('manifest.json', browser), 'utf8').then(JSON.parse),
  readFile(new URL('staging-rules.json', browser), 'utf8').then(JSON.parse),
]);
const token = '12345678-1234-4234-8234-123456789012', creator = 'https://creator.douyin.com';
const stageURL = (kind = 'image') => `${creator}/creator-micro/content/post/${kind}?luma_import=${token}`;
const extension = 'chrome-extension://test-extension', local = 'http://127.0.0.1:54321';
const registration = manifest.content_scripts.find(entry => entry.js.includes('staging-content.js'));
assert.equal(registration.run_at, 'document_end');
assert.equal(registration.all_frames, undefined);
assert.notEqual(registration.world, 'MAIN');
assert.ok(manifest.permissions.includes('declarativeNetRequestWithHostAccess'));
assert.equal(manifest.declarative_net_request.rule_resources.find(entry => entry.path === 'staging-rules.json')?.enabled, true);
assert.equal(rules.length, 2);
const [rule] = rules;
assert.equal(rule.action.type, 'modifyHeaders');
assert.deepEqual(rule.condition.resourceTypes, ['main_frame']);
assert.equal(rule.condition.isUrlFilterCaseSensitive, true);
assert.deepEqual(rule.action.responseHeaders, [{header: 'Content-Security-Policy', operation: 'append', value: "script-src 'none'"}]);
const stagePattern = {test: value => rules.some(rule => new RegExp(rule.condition.regexFilter).test(value))};

// contentFixture 使用正常完成解析的原文档；禁止中止加载、重开文档和 HTML 字符串注入。
function contentFixture(href, {empty = false, parsed = 'full'} = {}) {
  const events = [];
  const node = tag => ({
    tag, style: {}, children: [],
    set innerHTML(value) { throw Error('Never parse task data as HTML'); },
    set outerHTML(value) { throw Error('Never replace markup with a string'); },
    insertAdjacentHTML() { throw Error('Never inject HTML strings'); },
    dataset: new Proxy({}, {set(target, key, value) {
      events.push(['marker', key, value]); target[key] = value; return true;
    }}),
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; events.push(['replace', tag]); },
  });
  const old = node('old-native-content');
  const root = empty ? null : node('html');
  const parsedHead = node('head'), parsedBody = node('body');
  parsedBody.children.push(old);
  if (root && parsed === 'full') root.children = [parsedHead, parsedBody];
  const document = {
    documentElement: root, readyState: 'interactive',
    get body() { return this.documentElement?.children.find(child => child.tag === 'body') || null; },
    open() { throw Error('Keep the normal document lifecycle'); },
    write() { throw Error('Never write HTML strings'); },
    close() { throw Error('Never close and replace the document stream'); },
    createElement(tag) { assert.ok(['head','title','body','meta','iframe'].includes(tag)); events.push(['create', tag]); return node(tag); },
  };
  const context = vm.createContext({URL, location: new URL(href), document,
    window: {stop() { throw Error('Never interrupt the document paint lifecycle'); }},
    chrome: {runtime: {getURL(path) { return `${extension}/${path}`; }}},
  });
  const run = () => vm.runInContext(contentSource, context);
  return {events, document, old, run, parsedHead, parsedBody};
}
for (const kind of ['image', 'video']) for (const parsed of ['full', 'root-only']) {
  const page = contentFixture(stageURL(kind), {parsed}); page.run();
  assert.equal(stagePattern.test(stageURL(kind)), true);
  const root = page.document.documentElement, [head, body] = root.children, [frame] = body.children;
  assert.equal(root.dataset.lumaStagingToken, token);
  assert.equal(head.children[0].textContent, '发布作品 · 有序图库');
  assert.equal(page.document.body, body, 'the attached replacement body becomes document.body');
  assert.notEqual(head, page.parsedHead); assert.notEqual(body, page.parsedBody);
  assert.deepEqual(page.parsedBody.children, [page.old], 'never mount the iframe into the detached parsed body');
  assert.equal(frame.tag, 'iframe');
  assert.equal(frame.src, `${extension}/staging.html?token=${token}`);
  assert.equal(frame.id, 'luma-staging-frame');
  assert.equal(root.children.includes(page.old), false);
  assert.ok(page.events.findIndex(event => event[0] === 'marker') < page.events.findIndex(event => event[1] === 'iframe'));
  assert.equal(page.events.some(event => event[1] === 'script'), false);
}
const otherToken = token.replace('12345678', '87654321'), otherTask = contentFixture(stageURL().replace(token, otherToken));
otherTask.run();
assert.equal(stagePattern.test(stageURL().replace(token, otherToken)), true);
assert.equal(otherTask.document.documentElement.dataset.lumaStagingToken, otherToken);
const alphabeticToken = 'abcdef01-abcd-4abc-8abc-abcdef012345';
assert.equal(stagePattern.test(stageURL().replace(token, alphabeticToken)), true);
const invalidStageURLs = [
  `${creator}/creator-micro/content/post/image`, `${creator}/creator-micro/content/post/video?enter_from=draft`,
  `${creator}/creator-micro/content/upload?luma_import=${token}`, stageURL().replace('/image?', '/image/?'),
  stageURL().replace('/image?', '/other?'), stageURL().replace(creator, 'https://example.com'),
  stageURL().replace(creator, `${creator}:8443`), stageURL().replace('https://', 'https://user:pass@'),
  stageURL().replace(token, ''), stageURL().replace(token, token.replace('-4234-', '-1234-')),
  stageURL().replace(token, token.replace('-8234-', '-7234-')), stageURL().replace(token, 'not-a-token'),
  `${stageURL()}&luma_import=${token}`, `${stageURL()}&luma_import=`, `${stageURL()}&iid=123`,
  `${stageURL()}&type=new`, `${stageURL()}&extra=1`, `${stageURL()}&`, `${stageURL()}?`,
  stageURL().replace('luma_import', 'luma%5Fimport'), stageURL().replace(token, `%31${token.slice(1)}`),
  stageURL().replace(token, alphabeticToken.toUpperCase()),
];
for (const href of invalidStageURLs) {
  assert.equal(stagePattern.test(new URL(href).href), false, `CSP must not affect ${href}`);
  const page = contentFixture(href); page.run();
  assert.deepEqual(page.events, [], href);
  assert.deepEqual(page.document.documentElement.children, [page.parsedHead, page.parsedBody]);
  assert.deepEqual(page.parsedBody.children, [page.old]);
}
// Fragment 不会发送到服务器，DNR 无法据它区分请求；脚本仍必须拒绝带 fragment 的接管。
const fragment = contentFixture(`${stageURL()}#fragment`); fragment.run();
assert.deepEqual(fragment.events, []);
const wireURL = new URL(`${stageURL()}#fragment`); wireURL.hash = '';
assert.equal(stagePattern.test(wireURL.href), true);
const missingRoot = contentFixture(stageURL(), {empty: true}); missingRoot.run();
assert.deepEqual(missingRoot.events, []); assert.equal(missingRoot.document.documentElement, null);

// deferred 为网络、后台响应和文档离开提供可控的真实 Promise，不依赖实际时间或互联网。
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; }
const flush = async () => { for (let count = 0; count < 30; count++) await Promise.resolve(); };
const job = (count = 9, kind = 'image') => ({kind, title: '<img src=x onerror=bad()>', description: '<script>bad()</script>\n作品描述',
  assets: Array.from({length: count}, (_, index) => ({id: `asset_${index}`, name: `<素材 ${index}>.jpg`})),
  settings: {visibility: 'private', download: 'deny', publishTime: 'now', location: {cityName: '<城市>', name: '<位置>'}, collection: {id:'123',title:'<合集>',account:'456'}, coverIndex: 1, coverCrop: {x: 0.1, y: 0.2, width: 0.5, height: 0.5}}});

// uiFixture 执行完整初始化脚本；DOM 禁止 HTML 注入，网络只接受固定的本机缩略图接口。
function uiFixture(options = {}) {
  const nodes = new Map(), created = [], pageListeners = new Map(), messageListeners = new Set();
  const requests = [], messages = [], liveURLs = new Set(), revoked = [], canvasCalls = [];
  let nextURL = 0, active = 0, maximum = 0;
  class Node {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase(); this.children = []; this.attributes = {}; this.style = {}; this.events = new Map();
      this.hidden = false; this.value = ''; this.textContent = ''; this.naturalWidth = 800; this.naturalHeight = 600;
      const classes = new Set(); this.classList = {toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name)};
    }
    set innerHTML(value) { throw Error('Never parse task text as HTML'); }
    set outerHTML(value) { throw Error('Never replace markup with task text'); }
    insertAdjacentHTML() { throw Error('Never insert task HTML'); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { assert.equal(/^on/i.test(name), false); this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; if (name === 'src') delete this.src; }
    addEventListener(type, callback) { assert.equal(type, 'click'); this.events.set(type, callback); }
    click() { this.events.get('click')?.(); }
    decode() { return options.decodeFailure && this.src?.endsWith('/1') ? Promise.reject(Error('invalid image')) : Promise.resolve(); }
    getContext(type) { assert.equal(type, '2d'); return {drawImage: (...args) => canvasCalls.push(args)}; }
  }
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) nodes.set(match[1], new Node());
  nodes.get('content').hidden = true;
  class PreviewURL extends URL {
    static createObjectURL(blob) { assert.ok(blob instanceof Blob); const url = `blob:fixture/${++nextURL}`; liveURLs.add(url); return url; }
    static revokeObjectURL(url) { assert.ok(liveURLs.delete(url)); revoked.push(url); }
  }
  const contextValue = options.context || {ok: true, origin: local, job: job(options.count || 9, options.kind || 'image'), progress: {message: '后台最初进度'}};
  const contextGate = deferred();
  if (!options.deferContext) contextGate.resolve(contextValue);
  const context = vm.createContext({URL: PreviewURL, location: new URL(`${extension}/staging.html?token=${options.token ?? token}`), Blob, AbortController, AbortSignal,
    document: {
      getElementById(id) { assert.ok(nodes.has(id), `Unknown UI element ${id}`); return nodes.get(id); },
      createElement(tag) { assert.ok(['figure','button','span','img','figcaption','canvas'].includes(tag), tag); const element = new Node(tag); created.push(element); return element; },
    },
    window: {addEventListener(type, callback, opts) { assert.equal(type, 'pagehide'); assert.equal(opts.once, true); pageListeners.set(type, callback); }},
    chrome: {runtime: {id: 'test-extension',
      sendMessage(message) { assert.equal(message.op, 'staging-context'); messages.push(structuredClone(message)); return contextGate.promise; },
      onMessage: {addListener(callback) { messageListeners.add(callback); }, removeListener(callback) { assert.equal(messageListeners.delete(callback), true); }},
    }},
    fetch(url, settings) {
      const parsed = new URL(url);
      assert.equal(parsed.origin, contextValue.origin);
      assert.match(parsed.pathname, /^\/api\/v1\/assets\/asset_\d+\/preview$/);
      assert.equal(parsed.search, '?size=400'); assert.equal(settings.credentials, 'omit'); assert.equal(settings.redirect, 'error');
      // 读取缩略图之前，完整文案和所有素材占位就应已显示。
      assert.equal(nodes.get('content').hidden, false); assert.equal(nodes.get('work-title').value, contextValue.job.title);
      assert.equal(nodes.get('media-grid').children.length, contextValue.job.assets.length);
      const gate = deferred(), request = {url, settings, gate, released: false, canceled: false, ended: false};
      active++; maximum = Math.max(maximum, active); requests.push(request);
      const end = () => { if (!request.ended) { request.ended = true; active--; } };
      settings.signal.addEventListener('abort', () => { request.canceled = true; end(); gate.reject(new DOMException('Aborted', 'AbortError')); }, {once: true});
      request.release = (patch = {}) => {
        request.released = true; let consumed = false;
        const chunks = patch.chunks || [new Uint8Array([1, 2, 3])]; let index = 0;
        const cancel = async () => { request.canceled = true; end(); };
        gate.resolve({ok: patch.ok !== false, headers: {get(name) { return name === 'content-type' ? patch.mime || 'image/jpeg' : name === 'content-length' ? patch.length ?? null : null; }},
          body: {cancel, getReader() { assert.equal(consumed, false); consumed = true; return {
            async read() { if (index < chunks.length) return {value: chunks[index++], done: false}; end(); return {done: true}; },
            cancel, releaseLock() { request.unlocked = true; },
          }; }},
        });
      };
      return gate.promise;
    },
  });
  vm.runInContext(uiSource, context);
  const progress = (message, sender = {id: 'test-extension'}) => { for (const listener of messageListeners) listener(message, sender); };
  const finish = async (patch = {}) => {
    for (let round = 0; round < 20; round++) {
      await flush();
      const pending = requests.filter(request => !request.released && !request.ended);
      if (!pending.length) return;
      for (const request of pending) request.release(patch);
    }
    throw Error('Preview work did not settle');
  };
  return {contextValue, contextGate, nodes, created, requests, messages, liveURLs, revoked, canvasCalls, messageListeners, progress, finish,
    leave: () => pageListeners.get('pagehide')(), get active() { return active; }, get maximum() { return maximum; }};
}

const preview = uiFixture(); await flush();
assert.deepEqual(preview.messages, [{op: 'staging-context', token}]);
assert.equal(preview.requests.length, 4); assert.equal(preview.maximum, 4);
assert.equal(preview.nodes.get('preview-title').textContent, preview.contextValue.job.title);
assert.equal(preview.nodes.get('preview-description').textContent, preview.contextValue.job.description);
assert.equal(preview.nodes.get('visibility').textContent, '仅自己可见');
assert.equal(preview.nodes.get('download').textContent, '不允许保存');
assert.equal(preview.nodes.get('location').textContent, '<城市> · <位置>');
assert.equal(preview.nodes.get('collection').textContent, '<合集>');
assert.equal(preview.nodes.get('cover-name').textContent, '<素材 1>.jpg');
const progressMessage = {op: 'staging-progress', token, message: '<img onerror=bad()>', details: '<错误正文>'};
preview.progress(progressMessage, {id: 'another-extension'});
preview.progress({...progressMessage, token: 'other'});
preview.progress({...progressMessage, op: 'window-message'});
assert.equal(preview.nodes.get('progress-message').textContent, '后台最初进度');
preview.progress(progressMessage);
assert.equal(preview.nodes.get('progress-message').textContent, progressMessage.message);
const firstCards = [...preview.nodes.get('media-grid').children];
preview.progress({...progressMessage, failed: true});
assert.equal(preview.nodes.get('progress-panel').classList.contains('failed'), true);
assert.equal(preview.nodes.get('progress-panel').attributes.role, 'alert');
assert.deepEqual(preview.nodes.get('media-grid').children, firstCards);
assert.equal(preview.nodes.get('content').hidden, false);
assert.equal(preview.nodes.get('work-title').value, preview.contextValue.job.title);
await preview.finish();
assert.equal(preview.requests.length, 9); assert.equal(new Set(preview.requests.map(request => request.url)).size, 9);
assert.equal(preview.maximum, 4); assert.equal(preview.active, 0); assert.equal(preview.canvasCalls.length, 1);
assert.equal(preview.liveURLs.size, 9);
firstCards[8].children[0].click();
assert.equal(preview.nodes.get('preview-count').textContent, '9 / 9');
assert.equal(preview.nodes.get('preview-filename').textContent, '<素材 8>.jpg');
assert.equal(preview.requests.length, 9, 'switching a preview must not fetch the asset again');
preview.leave();
assert.equal(preview.liveURLs.size, 0); assert.equal(preview.revoked.length, 9); assert.equal(preview.messageListeners.size, 0);

// 同任务较新进度先于 context 到达时，不应被旧快照覆盖；其他任务消息不能提前结束等待。
const pendingContext = uiFixture({deferContext: true, count: 1});
pendingContext.progress({...progressMessage, message: '正在上传 1/1'});
pendingContext.contextGate.resolve(pendingContext.contextValue); await flush();
assert.equal(pendingContext.nodes.get('progress-message').textContent, '正在上传 1/1');
await pendingContext.finish(); pendingContext.leave();

// 原始任务来源和素材标识验证先于任何下载，失败时不给外部地址发送请求。
for (const invalidOrigin of ['https://evil.example', 'http://127.0.0.1:54321/path', 'http://user:pass@127.0.0.1:54321', 'http://127.0.0.1.evil.example', 'https://localhost:54321']) {
  const invalid = uiFixture({context: {ok: true, origin: invalidOrigin, job: job(1)}}); await flush();
  assert.equal(invalid.requests.length, 0); assert.equal(invalid.nodes.get('progress-panel').classList.contains('failed'), true); invalid.leave();
}
for (const brokenJob of [{...job(1), assets: []}, {...job(1), assets: [{id: '../unsafe', name: '素材'}]}, job(2, 'video'), job(36)]) {
  const invalid = uiFixture({context: {ok: true, origin: local, job: brokenJob}}); await flush();
  assert.equal(invalid.requests.length, 0); assert.equal(invalid.nodes.get('progress-panel').classList.contains('failed'), true); invalid.leave();
}
const expired = uiFixture({context: {ok: false, error: 'internal transport failure with secret'}}); await flush();
assert.equal(expired.requests.length, 0); assert.equal(expired.nodes.get('progress-panel').classList.contains('failed'), true);
assert.doesNotMatch(expired.nodes.get('progress-message').textContent, /internal|secret/); expired.leave();
const invalidToken = uiFixture({token: 'not-a-uuid'}); await flush();
assert.equal(invalidToken.messages.length, 0); assert.equal(invalidToken.requests.length, 0); invalidToken.leave();

// MIME、声明长度、流式实收长度以及图片解码失败均保留名称和内容，不能回退为原图下载。
for (const options of [
  {response: {mime: 'text/html'}}, {response: {length: 4 * 1024 * 1024 + 1}},
  {response: {chunks: [new Uint8Array(4 * 1024 * 1024), new Uint8Array([1])]}},
  {response: {chunks: []}}, {decodeFailure: true},
]) {
  const failed = uiFixture({count: 1, decodeFailure: options.decodeFailure}); await flush(); await failed.finish(options.response);
  const [button, name] = failed.nodes.get('media-grid').children[0].children;
  assert.equal(button.children[0].textContent, '预览暂不可用');
  assert.equal(name.textContent, '<素材 0>.jpg'); assert.equal(failed.requests.length, 1);
  assert.equal(failed.nodes.get('content').hidden, false); assert.equal(failed.nodes.get('work-description').value, failed.contextValue.job.description);
  if (options.response?.mime || options.response?.length || options.response?.chunks?.length > 1) assert.equal(failed.requests[0].canceled, true);
  failed.leave(); assert.equal(failed.liveURLs.size, 0);
}

// 离页取消在途请求，不再发起后续读取；后台迟到信息不能复活预览或覆盖新页面。
const abandoned = uiFixture(); await flush();
assert.equal(abandoned.requests.length, 4);
abandoned.requests[0].release(); await flush();
assert.equal(abandoned.liveURLs.size, 1);
const oldMessage = abandoned.nodes.get('progress-message').textContent, savedListener = [...abandoned.messageListeners][0];
abandoned.leave(); await flush();
assert.equal(abandoned.active, 0); assert.equal(abandoned.liveURLs.size, 0); assert.equal(abandoned.messageListeners.size, 0);
savedListener({...progressMessage, message: '迟到状态'}, {id: 'test-extension'});
assert.equal(abandoned.nodes.get('progress-message').textContent, oldMessage);
assert.equal(abandoned.requests.length, 5);
const leaveBeforeContext = uiFixture({deferContext: true}); leaveBeforeContext.leave();
leaveBeforeContext.contextGate.resolve(leaveBeforeContext.contextValue); await flush();
assert.equal(leaveBeforeContext.requests.length, 0); assert.equal(leaveBeforeContext.nodes.get('content').hidden, true);

console.log('PASS staging route interception, isolated safe preview/context, bounded thumbnail reads, failure preservation and cleanup');
