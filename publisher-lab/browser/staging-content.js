'use strict';
// 仅本次带入标记所在的发布路由由扩展接管，普通抖音页面不受影响。
(() => {
  const page = new URL(location.href);
  const tokens = page.searchParams.getAll('luma_studio_import');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (page.origin !== 'https://creator.douyin.com' || page.username || page.password || page.hash || !/^\/creator-micro\/content\/post\/(image|video)$/.test(page.pathname) || page.searchParams.size !== 1 || tokens.length !== 1 || !uuid.test(tokens[0]) || page.href !== `${page.origin}${page.pathname}?luma_studio_import=${tokens[0]}`) return;

  // 静态 DNR 规则已为这个精确主文档追加 script-src 'none'，原生脚本不会初始化或保存缓存。
  // 保留浏览器正常的文档加载与绘制生命周期，在 document_end 替换为扩展自己的容器。
  const token = tokens[0];
  const root = document.documentElement;
  if (!root) return;
  const head = document.createElement('head'), title = document.createElement('title'), body = document.createElement('body');
  const viewport = document.createElement('meta'); viewport.name = 'viewport'; viewport.content = 'width=device-width,initial-scale=1';
  title.textContent = '发布作品 · 有序图库'; head.append(title,viewport); root.replaceChildren(head,body);
  root.lang = 'zh-CN';
  root.dataset.lumaStudioStagingToken = token;
  Object.assign(root.style, {height:'100%', margin:'0', background:'#f7f8fa'});
  Object.assign(body.style, {height:'100%', margin:'0', overflow:'hidden'});
  const frame = document.createElement('iframe');
  frame.id = 'luma-studio-staging-frame';
  frame.title = '有序图库发布准备页';
  frame.src = chrome.runtime.getURL('staging.html') + '?token=' + encodeURIComponent(token);
  Object.assign(frame.style, {display:'block', width:'100%', height:'100%', border:'0', position:'fixed', inset:'0', zIndex:'2147483647', background:'#f7f8fa'});
  body.append(frame);
})();
