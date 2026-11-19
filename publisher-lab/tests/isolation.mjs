// 隔离回归只检查实际交付的 App 依赖闭包；不启动浏览器或请求网络。
import assert from 'node:assert/strict';
import {readFile, readdir, mkdtemp, mkdir, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {collectRuntimeFiles, runtimePlan, writeAppArtifacts} from '../build.mjs';
import {execFileSync} from 'node:child_process';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const {app, appFiles} = await runtimePlan(root);
assert.equal(app.id, 'com.lumaindex.douyin.studio');
assert.equal(app.name, '抖音发布工作台');
assert.equal(app.version, '0.1.0');

// 私有身份与 DOM 名称不能残留；宿主的公共 luma: 事件不在禁止范围内。
const forbidden = [
  /com\.lumaindex\.douyin(?!\.studio)[/'"`]/,
  /luma_import_backup/,
  /luma\.douyin\.frontend:/,
  /\bluma(?:Extension|HandoffSubmitted|StagingToken|DirectDraftMarker|DirectDraftURL)\b/,
  /['"]luma-(?:background-bridges|connection-enabled|import-status|staging-frame)['"]/,
];
for (const file of appFiles) {
  if (!/\.(js|json|html|css)$/.test(file)) continue;
  const source = await readFile(join(root, 'app', file), 'utf8');
  for (const pattern of forbidden) assert.ok(!pattern.test(source), `app/${file} 保留了旧私有身份：${pattern}`);
}
assert.ok(appFiles.includes('platform/studio-engine.js'), '隔离检查必须覆盖实际发布编排子目录');
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
  const plan = await runtimePlan(appOnlyFixture);
  assert.deepEqual(plan.appFiles, ['index.html', 'manifest.json']);
  const destination = join(appOnlyFixture, 'output');
  await writeAppArtifacts({projectRoot: appOnlyFixture, destination, plan});
  assert.deepEqual((await readdir(destination)).sort(), ['使用说明.md', '抖音发布工作台.luma-plugin.zip'].sort());
  const archived = execFileSync('/usr/bin/unzip', ['-Z1', join(destination, '抖音发布工作台.luma-plugin.zip')], {encoding: 'utf8'}).trim().split('\n').sort();
  assert.deepEqual(archived, ['index.html', 'manifest.json']);
  const actual = await runtimePlan(root);
  assert.equal(actual.appFiles.includes('relay.html'), false);
  assert.equal(actual.appFiles.some(file => file.startsWith('browser/')), false);
} finally { await rm(appOnlyFixture, {recursive: true, force: true}); }

console.log(`隔离验证通过：${appFiles.length} 个实际交付文件的身份与入口依赖边界、App 安装产物已确认；无需历史浏览器或原插件目录。`);
