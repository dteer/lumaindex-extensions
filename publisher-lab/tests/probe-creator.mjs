// 人工调试只读探针：不在发布包中，不允许上传授权、上传或发布操作。
import {execFileSync} from 'node:child_process';
import {creatorRequest} from '../browser/creator-api.js';
const allowed = new Set(['account', 'topics.search', 'users.search', 'music.categories', 'music.list', 'music.validate']);
const operation = process.argv[2], params = JSON.parse(process.argv[3] || '{}');
if (!allowed.has(operation)) throw Error('Only explicitly allowlisted read operations are supported');
const key = `__lumaStudioProbe${Date.now()}_${Math.random().toString(36).slice(2)}`;
// runScript 只选择已打开的创作者中心标签页，避免误读其他标签页。
function runScript(source) {
  const script = `tell application "Google Chrome"
repeat with w in windows
repeat with t in tabs of w
if URL of t starts with "https://creator.douyin.com/" then return execute t javascript ${JSON.stringify(source)}
end repeat
end repeat
return "NO_CREATOR_TAB"
end tell`;
  return execFileSync('/usr/bin/osascript', ['-e', script], {encoding: 'utf8', timeout: 20000}).trim();
}
const start = runScript(`window[${JSON.stringify(key)}]={pending:true}; (${creatorRequest.toString()})(${JSON.stringify(operation)},${JSON.stringify(params)}).then(value=>window[${JSON.stringify(key)}]=value); 'STARTED'`);
if (start !== 'STARTED') throw Error(start);
try {
  for (let attempt = 0; attempt < 80; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const value = runScript(`JSON.stringify(window[${JSON.stringify(key)}])`);
    const result = JSON.parse(value);
    if (!result.pending) { console.log(JSON.stringify(result)); break; }
    if (attempt === 79) throw Error('Read probe timed out');
  }
} finally { runScript(`delete window[${JSON.stringify(key)}]; 'CLEARED'`); }
