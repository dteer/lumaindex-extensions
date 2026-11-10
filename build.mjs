// 开发时打包；安装后全部由 HTML/CSS/JS 运行，不需要本脚本或 Node。
import {mkdir,copyFile,cp,readdir,rm} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=dirname(fileURLToPath(import.meta.url));
const output=resolve(process.argv[2]||join(root,'dist'));
await mkdir(output,{recursive:true});
const archive=join(output,'抖音发布助手.luma-plugin.zip');
await rm(archive,{force:true});
execFileSync('/usr/bin/zip',['-q',archive,...(await readdir(join(root,'app'),{withFileTypes:true})).filter(entry=>entry.isFile()).map(entry=>entry.name)],{cwd:join(root,'app')});
await cp(join(root,'browser'),join(output,'Chrome扩展'),{recursive:true});
await copyFile(join(root,'README.md'),join(output,'使用说明.md'));
console.log(output);
