import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const pageScript = await readFile(new URL('../app/handoff.js', import.meta.url), 'utf8');
const contentScript = await readFile(new URL('../browser/handoff-content.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../app/handoff.html', import.meta.url), 'utf8');
const job = {version: 1, id: 'job-one', kind: 'image', assets: [{id: 'a', name: 'photo.jpg'}], title: '作品', description: '作品描述'};
// tick 等待扩展消息回执完成，不使用真实页面导航或网络。
const tick = () => new Promise(resolve => setImmediate(resolve));

// harness 让普通页面与隔离内容脚本共享 DOM；两者只通过状态标记协作。
function harness(value = job) {
  const nodes = {summary: {textContent: ''}, status: {textContent: '正在检查 Chrome 扩展…'}, help: {hidden: true}};
  const calls = [], timers = [], children = [{hidden: false}, {hidden: false}];
  const context = vm.createContext({
    location: {protocol: 'http:', hostname: '127.0.0.1', pathname: '/api/v1/plugins/com.lumaindex.douyin/files/handoff.html', hash: '#' + encodeURIComponent(JSON.stringify(value))},
    document: {documentElement: {dataset: {}}, getElementById: id => nodes[id], body: {children}},
    chrome: {runtime: {async sendMessage(message) { calls.push(JSON.parse(JSON.stringify(message))); return {ok: true}; }}},
    setTimeout(callback, milliseconds) { timers.push({callback, milliseconds}); },
  });
  return {nodes, calls, timers, children, context, page: () => vm.runInContext(pageScript, context), extension: () => vm.runInContext(contentScript, context)};
}

// 新交接页不存在不可用的分步上传按钮或可误认为需要手动填写的旧表单。
assert.equal(/id="(?:upload|fill|title|description)"/.test(html), false);
assert.equal(/<button|<input|<textarea/.test(html), false);
assert.ok(html.includes('id="status" role="status" aria-live="polite"'));
assert.ok(html.includes('id="help" hidden'));
assert.equal(html.includes('本页不会自动上传'), false);

// 正常交接仅提交一次完整任务，页面检测计时器不覆盖扩展状态，不隐藏整个页面。
{
  const h = harness(); h.page(); h.extension(); await tick();
  assert.deepEqual(h.calls, [{op: 'continue', job}]);
  assert.equal(h.nodes.summary.textContent, '本次带入 1 项素材');
  assert.match(h.nodes.status.textContent, /草稿已带入/); assert.equal(h.nodes.help.hidden, true);
  assert.ok(h.children.every(child => !child.hidden));
  h.timers[0].callback(); assert.match(h.nodes.status.textContent, /草稿已带入/);
  h.extension(); await tick(); assert.equal(h.calls.length, 1);
}

// 扩展先于页面脚本运行时，页面也不能覆盖其结果。
{
  const h = harness(); h.extension(); await tick(); h.page(); h.timers[0].callback();
  assert.equal(h.calls.length, 1); assert.match(h.nodes.status.textContent, /草稿已带入/);
}

// 未安装扩展时展示可操作指引，不启动上传或定时重试。
{
  const h = harness(); h.page();
  assert.equal(h.timers.length, 1); assert.equal(h.timers[0].milliseconds, 1500);
  h.timers[0].callback(); assert.match(h.nodes.status.textContent, /未检测到/);
  assert.equal(h.nodes.help.hidden, false); assert.equal(h.calls.length, 0);
}

// 非法 hash 与协议封套在发送前停止；错误不被“未安装扩展”提示覆盖。
for (const value of [null, {}, {...job, version: 2}, {...job, id: ''}, {...job, assets: null}]) {
  const h = harness(value); h.page(); h.extension(); await tick();
  assert.match(h.nodes.status.textContent, /交接数据无效/);
  assert.equal(h.nodes.help.hidden, false); assert.equal(h.calls.length, 0); assert.equal(h.timers.length, 0);
}
for (const hash of ['', '#%E0%A4%A', '#%7Bbroken']) {
  const h = harness(); h.context.location.hash = hash; h.page(); h.extension(); await tick();
  assert.match(h.nodes.status.textContent, /交接数据无效/); assert.equal(h.calls.length, 0);
}

// 业务字段由后台统一校验；交接页只解析协议，不维护第二套素材数量或标题规则。
{
  const h = harness({...job, assets: [], title: 'x'.repeat(21)});
  h.context.chrome.runtime.sendMessage = async message => { h.calls.push(message); return {ok: false, error: '请选择素材后重新带入。'}; };
  h.page(); h.extension(); await tick();
  assert.equal(h.calls.length, 1); assert.equal(h.nodes.status.textContent, '请选择素材后重新带入。');
  assert.equal(h.nodes.help.hidden, false); h.timers[0].callback();
  assert.equal(h.nodes.status.textContent, '请选择素材后重新带入。');
}

// 内容脚本仅接受指定本机交接路径，不在其他网站或连接页发起导入。
for (const patch of [{hostname: 'example.com'}, {protocol: 'https:'}, {pathname: '/api/v1/plugins/com.lumaindex.douyin/files/relay.html'}]) {
  const h = harness(); Object.assign(h.context.location, patch); h.extension(); await tick();
  assert.equal(h.calls.length, 0); assert.equal(h.context.document.documentElement.dataset.lumaExtension, undefined);
}

// 后台拒绝、断开与同步调用失败都有明确指引，且不把原始 Chrome 异常展示或自动重发。
for (const behavior of [
  async () => ({ok: false}),
  async () => { throw Error('internal chrome.extension stack'); },
  () => { throw Error('internal chrome.extension stack'); },
]) {
  const h = harness(); h.context.chrome.runtime.sendMessage = message => { h.calls.push(message); return behavior(); };
  h.extension(); await tick();
  assert.equal(h.nodes.help.hidden, false); assert.match(h.nodes.status.textContent, /从 App 重新带入/);
  assert.equal(h.nodes.status.textContent.includes('internal'), false);
  h.extension(); await tick(); assert.equal(h.calls.length, 1);
}

console.log('PASS automatic handoff, shared status, single submission, missing-extension guidance, hash envelope validation and safe failure messages');
