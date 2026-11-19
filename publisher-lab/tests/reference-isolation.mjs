// Historical Chrome isolation and parent-plugin baseline; optional reference suite only.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const original = dirname(root);
const baseline = JSON.parse(await readFile(join(root, 'tests/source-baseline.json'), 'utf8'));
let checked = 0;
for (const [relative, expected] of Object.entries(baseline)) {
  const content = await readFile(join(original, relative));
  assert.equal(createHash('sha256').update(content).digest('hex'), expected, `原插件文件发生变化：${relative}`);
  checked++;
}
const app = JSON.parse(await readFile(join(root, 'app/manifest.json'), 'utf8'));
const browser = JSON.parse(await readFile(join(root, 'browser/manifest.json'), 'utf8'));
assert.equal(app.id, 'com.lumaindex.douyin.studio');
assert.equal(browser.name, '有序图库发布工作台（实验版）');
assert.equal(app.version, '0.1.0');
assert.equal(browser.version, '0.1.0');
assert.equal(browser.key, undefined, '实验扩展不能复用固定扩展身份');
assert.equal(browser.declarative_net_request, undefined, '直接发布工作台不能注入旧草稿 CSP 规则');
assert.ok(browser.permissions.every(value => !value.startsWith('declarativeNetRequest')));
assert.deepEqual(browser.content_scripts.flatMap(value => value.js), ['relay-content.js']);
assert.ok(browser.content_scripts.every(value => value.matches.every(pattern => /^http:\/\/(127\.0\.0\.1|localhost)\//.test(pattern))));

// 旧插件的本机交接页面不允许触发实验版配对、DOM 修改或消息。
for (const filename of ['relay-content.js', 'handoff-content.js']) {
  let code;
  try { code = await readFile(join(root, 'browser', filename), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  const page = filename === 'relay-content.js' ? 'relay.html' : 'handoff.html';
  const url = new URL(`http://127.0.0.1:8765/api/v1/plugins/com.lumaindex.douyin/files/${page}`);
  let touched = false;
  const context = {location: url, URL};
  Object.defineProperty(context, 'document', {get() { touched = true; throw Error('访问了旧插件页面'); }});
  Object.defineProperty(context, 'chrome', {get() { touched = true; throw Error('向旧插件页面发送了消息'); }});
  vm.runInNewContext(code, context, {timeout: 1000, filename});
  assert.equal(touched, false, `${filename} 接管了旧插件页面`);
}

// 复制保留的 legacy 准备页必须拒绝旧标记，即使未来意外重新注册也不得接管。
let staging;
try { staging = await readFile(join(root, 'browser/staging-content.js'), 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (staging) {
  const url = new URL('https://creator.douyin.com/creator-micro/content/post/image?luma_import=10000000-0000-4000-8000-000000000001');
  const context = {location: url, URL};
  Object.defineProperty(context, 'document', {get() { throw Error('实验版接管了旧发布任务'); }});
  vm.runInNewContext(staging, context, {timeout: 1000, filename: 'staging-content.js'});
}

console.log(`reference isolation: ${checked} original files unchanged; historical browser identity and page isolation passed`);
