// 隔离回归只执行本地代码和读取原目录哈希；不启动 Chrome 或请求网络。
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile, readdir, mkdtemp, mkdir, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {collectRuntimeFiles, runtimePlan, writeAppArtifacts} from '../build.mjs';
import {execFileSync} from 'node:child_process';
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
assert.equal(app.name, '抖音发布工作台');
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

// 私有身份与 DOM 名称不能残留；宿主的公共 luma: 事件不在禁止范围内。
const forbidden = [
  /com\.lumaindex\.douyin(?!\.studio)[/'"`]/,
  /luma_import_backup/,
  /luma\.douyin\.frontend:/,
  /\bluma(?:Extension|HandoffSubmitted|StagingToken|DirectDraftMarker|DirectDraftURL)\b/,
  /['"]luma-(?:background-bridges|connection-enabled|import-status|staging-frame)['"]/,
];
for (const section of ['app', 'browser']) {
  for (const file of await readdir(join(root, section), {withFileTypes: true})) {
    if (!file.isFile() || !/\.(js|json|html|css)$/.test(file.name)) continue;
    const source = await readFile(join(root, section, file.name), 'utf8');
    for (const pattern of forbidden) assert.ok(!pattern.test(source), `${section}/${file.name} 保留了旧私有身份：${pattern}`);
  }
}
// 打包只跟随入口依赖，未引用旧脚本、测试、凭据和第三方依赖不会被顺手复制。
const fixture = await mkdtemp(join(tmpdir(), 'publisher-lab-package-test-'));
try {
  await mkdir(join(fixture, 'lib'));
  await mkdir(join(fixture, 'tests'));
  await mkdir(join(fixture, 'node_modules'));
  await writeFile(join(fixture, 'index.html'), '<link href="style.css"><script type="module" src="main.js?v=1"></script>');
  await writeFile(join(fixture, 'main.js'), "import {helper} from './lib/helper.js';\nconst data=new URL('./data.json',import.meta.url);\nfetch('/api/v1/assets');");
  await writeFile(join(fixture, 'lib/helper.js'), 'export const helper = true;');
  await writeFile(join(fixture, 'style.css'), 'body { background: url("data:image/png;base64,AA=="); }');
  await writeFile(join(fixture, 'data.json'), '{}');
  await writeFile(join(fixture, 'handoff-content.js'), 'throw Error("old runtime")');
  await writeFile(join(fixture, 'tests/private.json'), '{}');
  await writeFile(join(fixture, 'node_modules/dependency.js'), 'export default 1;');
  await writeFile(join(fixture, 'package.json'), '{}');
  await writeFile(join(fixture, '.credentials.json'), '{}');
  assert.deepEqual(await collectRuntimeFiles(fixture, ['index.html']), ['data.json', 'index.html', 'lib/helper.js', 'main.js', 'style.css']);
  await assert.rejects(collectRuntimeFiles(fixture, ['handoff-content.js'], ['handoff-content.js']), /旧接管模块/);
  for (const file of ['tests/private.json', 'node_modules/dependency.js', 'package.json', '.credentials.json']) {
    await assert.rejects(collectRuntimeFiles(fixture, [file]), /非运行目录/);
  }
  await assert.rejects(collectRuntimeFiles(fixture, ['../outside.js']), /越出插件目录/);
  await symlink(join(fixture, 'main.js'), join(fixture, 'linked.js'));
  await assert.rejects(collectRuntimeFiles(fixture, ['linked.js']), /符号链接/);
} finally { await rm(fixture, {recursive: true, force: true}); }

// AppOnly 打包无需浏览器目录，并且实际产物只能是 App 安装包与说明。
const appOnlyFixture = await mkdtemp(join(tmpdir(), 'publisher-lab-apponly-test-'));
try {
  await mkdir(join(appOnlyFixture, 'app'));
  await writeFile(join(appOnlyFixture, 'app/manifest.json'), JSON.stringify({id: 'com.lumaindex.douyin.studio', name: '抖音发布工作台', version: '0.1.0', entry: 'index.html'}));
  await writeFile(join(appOnlyFixture, 'app/index.html'), '<p>界面预览</p>');
  await writeFile(join(appOnlyFixture, 'app/relay.html'), '<p>旧配对页不得打包</p>');
  await writeFile(join(appOnlyFixture, 'README.md'), '执行层未接入');
  const plan = await runtimePlan(appOnlyFixture, {includeBrowser: false});
  assert.deepEqual(plan.appFiles, ['index.html', 'manifest.json']);
  assert.deepEqual(plan.browserFiles, []);
  const destination = join(appOnlyFixture, 'output');
  await writeAppArtifacts({projectRoot: appOnlyFixture, destination, plan});
  assert.deepEqual((await readdir(destination)).sort(), ['使用说明.md', '抖音发布工作台.luma-plugin.zip'].sort());
  const archived = execFileSync('/usr/bin/unzip', ['-Z1', join(destination, '抖音发布工作台.luma-plugin.zip')], {encoding: 'utf8'}).trim().split('\n').sort();
  assert.deepEqual(archived, ['index.html', 'manifest.json']);
  const actual = await runtimePlan(root, {includeBrowser: false});
  assert.equal(actual.appFiles.includes('relay.html'), false);
  assert.equal(actual.appFiles.some(file => file.startsWith('browser/')), false);
} finally { await rm(appOnlyFixture, {recursive: true, force: true}); }

console.log(`隔离验证通过：原插件 ${checked} 个运行文件未变；工作台身份、旧页面拒绝、参考代码无原生页面注入；AppOnly 实际产物及入口依赖边界已确认。`);
