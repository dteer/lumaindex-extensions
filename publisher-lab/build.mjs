// build 只交付 App 插件及其原生接口适配代码，不生成浏览器扩展或独立服务。
import {cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, extname, join, relative, resolve, sep} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

const root = dirname(fileURLToPath(import.meta.url));
const output = join(homedir(), 'Desktop', 'app', '抖音发布工作台实验版');
const markerName = '.publisher-lab-artifacts.json';
const allowedExtensions = new Set(['.js', '.json', '.html', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.woff', '.woff2']);
const blockedDirectories = new Set(['tests', 'docs', 'node_modules', 'codex-service', 'captures', 'logs']);
// oldEntries 只用于阻止旧自动接管与原生草稿写入进入交付；源码可暂留供只读比对。
const oldEntries = {
  app: ['app.js', 'handoff.html', 'handoff.js', 'relay.html', 'browser-bridge.js'],
  browser: ['handoff-content.js', 'background-bridge.js', 'staging-content.js', 'staging.js', 'staging.html', 'staging.css', 'staging-rules.json', 'draft-page.js'],
};

// references 提取本项目使用的静态模块、页面和样式资源引用；动态 API 地址不作为文件复制。
function references(source, extension) {
  const refs = [];
  const collect = pattern => { for (const match of source.matchAll(pattern)) refs.push(match[1]); };
  if (extension === '.js') {
    collect(/^\s*(?:import|export)\s+[^;]*?\sfrom\s*['"]([^'"]+)['"]/gm);
    collect(/^\s*import\s*['"]([^'"]+)['"]/gm);
    collect(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
    collect(/\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g);
    collect(/\b(?:getURL|fetch)\s*\(\s*['"]([^'"]+)['"]/g);
  } else if (extension === '.html') {
    collect(/\b(?:src|href)\s*=\s*['"]([^'"]+)['"]/gi);
  } else if (extension === '.css') {
    collect(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/gi);
    collect(/@import\s+['"]([^'"]+)['"]/gi);
  }
  return refs;
}

// collectRuntimeFiles 从明确入口计算依赖闭包，未引用的源码、测试、文档和依赖不会进入包。
export async function collectRuntimeFiles(directory, entries, blocked = []) {
  const base = resolve(directory), queue = [...entries], found = new Set(), denied = new Set(blocked);
  while (queue.length) {
    const candidate = queue.shift();
    if (!candidate || /^[a-z][a-z\d+.-]*:/i.test(candidate) || candidate.startsWith('//') || candidate.startsWith('#')) continue;
    const name = candidate.split(/[?#]/, 1)[0];
    const absolute = resolve(base, name), file = relative(base, absolute).split(sep).join('/');
    if (!file || file.startsWith('../') || file === '..' || name.startsWith('/')) throw Error(`运行资源越出插件目录：${name}`);
    if (found.has(file)) continue;
    if (denied.has(file)) throw Error(`实验版仍引用旧接管模块，请完成新流程接入后打包：${file}`);
    if (file.split('/').some(part => part.startsWith('.') || blockedDirectories.has(part)) || ['package.json', 'package-lock.json'].includes(file)) throw Error(`非运行目录不能进入安装包：${file}`);
    if (!allowedExtensions.has(extname(file).toLowerCase())) throw Error(`不支持的运行资源：${file}`);
    let cursor = base;
    for (const part of file.split('/')) {
      cursor = join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink()) throw Error(`运行资源不得使用符号链接：${file}`);
    }
    if (!(await lstat(absolute)).isFile()) throw Error(`运行资源不是文件：${file}`);
    found.add(file);
    const extension = extname(file).toLowerCase();
    if (!['.js', '.html', '.css'].includes(extension)) continue;
    for (const reference of references(await readFile(absolute, 'utf8'), extension)) {
      // 根路径属于运行时本机或抖音 API；网络资源不会被下载或打进包。
      if (!reference || reference.startsWith('/') || reference.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(reference)) continue;
      queue.push(join(dirname(file), reference));
    }
  }
  return [...found].sort();
}

// runtimePlan 默认可分析浏览器参考依赖；AppOnly 构建完全不读取浏览器入口。
export async function runtimePlan(projectRoot = root, {includeBrowser = true} = {}) {
  const app = JSON.parse(await readFile(join(projectRoot, 'app/manifest.json'), 'utf8'));
  if (app.id !== 'com.lumaindex.douyin.studio') throw Error('实验版身份校验失败，已停止打包。');
  const plan = {app, appFiles: await collectRuntimeFiles(join(projectRoot, 'app'), ['manifest.json', app.entry], oldEntries.app), browser: null, browserFiles: []};
  if (!includeBrowser) return plan;
  const browser = JSON.parse(await readFile(join(projectRoot, 'browser/manifest.json'), 'utf8'));
  if (!browser.name.includes('实验版')) throw Error('浏览器参考代码身份校验失败。');
  if (browser.declarative_net_request || browser.permissions?.some(value => value.startsWith('declarativeNetRequest')) || browser.content_scripts?.some(value => value.matches?.some(pattern => !/^http:\/\/(127\.0\.0\.1|localhost)\//.test(pattern)))) throw Error('实验参考模块不能注册原生页面接管或旧草稿规则。');
  const browserEntries = ['manifest.json', browser.background?.service_worker, browser.action?.default_popup, browser.options_ui?.page];
  for (const script of browser.content_scripts || []) browserEntries.push(...(script.js || []), ...(script.css || []));
  for (const icons of [browser.icons, browser.action?.default_icon]) if (icons) browserEntries.push(...(typeof icons === 'string' ? [icons] : Object.values(icons)));
  plan.browser = browser;
  plan.browserFiles = await collectRuntimeFiles(join(projectRoot, 'browser'), browserEntries.filter(Boolean), oldEntries.browser);
  return plan;
}

// copyFiles 只复制已经验证的依赖列表，不递归扫描源码目录。
async function copyFiles(source, destination, files) {
  for (const file of files) {
    const target = join(destination, file);
    await mkdir(dirname(target), {recursive: true});
    await cp(join(source, file), target);
  }
}

// writeAppArtifacts 只生成 App 安装包与使用说明，临时文件在归档完成后清理。
export async function writeAppArtifacts({projectRoot = root, destination, plan}) {
  await mkdir(destination, {recursive: true});
  const temporary = await mkdtemp(join(destination, '.app-only-package-'));
  try {
    await copyFiles(join(projectRoot, 'app'), temporary, plan.appFiles);
    const archive = join(destination, '抖音发布工作台实验版.luma-plugin.zip');
    execFileSync('/usr/bin/zip', ['-q', archive, ...plan.appFiles], {cwd: temporary});
    await cp(join(projectRoot, 'README.md'), join(destination, '使用说明.md'));
  } finally { await rm(temporary, {recursive: true, force: true}); }
}

// build 在独立临时目录完成所有打包，成功后才替换带本项目标识的旧实验版产物。
async function build() {
  if (process.argv.length > 2) throw Error('此构建固定输出至 ~/Desktop/app/抖音发布工作台实验版，不接受覆盖其他目录。');
  const plan = await runtimePlan(root, {includeBrowser: false});
  await mkdir(dirname(output), {recursive: true});
  let existing = false;
  try {
    const stat = await lstat(output);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('实验版交付位置不是独立目录，已停止打包。');
    const marker = JSON.parse(await readFile(join(output, markerName), 'utf8'));
    if (marker.pluginId !== plan.app.id || marker.output !== output) throw Error('交付目录不属于本实验插件，已停止打包。');
    existing = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { await lstat(output); throw Error('交付目录已存在且缺少实验版标识，已停止打包。'); }
    catch (check) { if (check.code !== 'ENOENT') throw check; }
  }
  const temporary = await mkdtemp(join(dirname(output), '.publisher-lab-build-'));
  const staging = join(temporary, 'artifacts'), previous = join(temporary, 'previous');
  let preservePrevious = false;
  try {
    await mkdir(staging);
    await writeAppArtifacts({destination: staging, plan});
    await writeFile(join(staging, markerName), JSON.stringify({pluginId: plan.app.id, version: plan.app.version, 'app-only': true, output, builtAt: new Date().toISOString(), appFiles: plan.appFiles}, null, 2) + '\n');
    if (existing) await rename(output, previous);
    try { await rename(staging, output); }
    catch (error) {
      if (existing) {
        try { await rename(previous, output); }
        catch { preservePrevious = true; throw Error(`替换失败，旧实验版保留于：${previous}`); }
      }
      throw error;
    }
    console.log(`实验版构建完成：${output}\nAppOnly：${plan.appFiles.length} 个插件运行文件；使用 App 宿主会话与请求能力。`);
  } finally {
    if (!preservePrevious) await rm(temporary, {recursive: true, force: true});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build();
