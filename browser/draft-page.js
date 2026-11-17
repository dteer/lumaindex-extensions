// requestCreatorContext 在隔离世界使用浏览器原生 fetch；不读取 Cookie，也不调用网站请求包装器。
// 临时上传密钥仅返回扩展后台内存，不写入 DOM、日志或任何存储。
export async function requestCreatorContext(operation, vid) {
  if (location.origin !== 'https://creator.douyin.com') return {ok:false,error:'请打开抖音创作者中心。'};
  if (['video-status','video-enable'].includes(operation) && !/^[a-zA-Z0-9_-]{1,100}$/.test(vid || '')) return {ok:false,error:'视频资源标识无效。'};
  const paths = {'video-enable':`/web/api/media/video/enable/?video_id=${encodeURIComponent(vid || '')}`, 'video-status':`/web/api/media/video/transend/?video_id=${encodeURIComponent(vid || '')}`, account:'/web/api/media/user/info/?device_platform=web', auth:'/web/api/media/upload/auth/v5/'};
  if (!Object.hasOwn(paths, operation)) return {ok:false,error:'未知的创作者请求。'};
  try {
    const response = await fetch(paths[operation], {credentials:'include',redirect:'error',signal:AbortSignal.timeout(15000)});
    const data = await response.json();
    if (!response.ok || data.status_code !== 0) return {ok:false,error:'抖音登录状态或上传授权不可用，请登录后重试。'};
    if (['video-status','video-enable'].includes(operation)) return {ok:true,data};
    if (operation === 'account') {
      const account = data.user?.uid;
      if (typeof account !== 'string' || !/^\d{1,30}$/.test(account)) return {ok:false,error:'无法确认当前抖音账号，请重新登录。'};
      return {ok:true,account};
    }
    const auth = JSON.parse(data.auth);
    if (!auth.AccessKeyID || !auth.SecretAccessKey || !auth.SessionToken || !(Date.parse(auth.ExpiredTime) > Date.now())) return {ok:false,error:'抖音上传授权已过期，请重试。'};
    return {ok:true,auth};
  } catch { return {ok:false,error:'无法连接抖音，请检查网络和登录状态后重试。'}; }
}

// stagingPageBinding 只读确认扩展准备页：必须是本次 UUID 对应的独占发布路由和 DOM 标记。
// 此函数会被序列化注入隔离世界，不依赖模块内其他函数，也不建立或修改绑定。
export function stagingPageBinding(token, kind) {
  if (!['image','video'].includes(kind) || typeof token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token)) return {ok:false,error:'发布准备页绑定信息无效。'};
  const url = new URL(location.href);
  const matches = !url.username && !url.password && url.href === `https://creator.douyin.com/creator-micro/content/post/${kind}?luma_import=${token}` &&
    document.documentElement?.dataset.lumaStagingToken === token;
  return {ok:true,matches};
}

// draftStorage 只在由扩展 CSP 隔离原生脚本的本次准备页读写缓存，防止原生编辑器卸载时覆盖新草稿。
// 写入使用原始字符串比较；冲突、备份失败和回读失败均不能报告导入完成。
export function draftStorage(operation, payload) {
  try {
    if (!payload || typeof payload.account !== 'string' || !/^\d{1,30}$/.test(payload.account) || !['image','video'].includes(payload.kind)) throw Error('草稿账号或类型无效。');
    // 注入时函数没有模块闭包，因此独立核对与内容脚本、CSP 规则一致的规范 URL；普通上传入口没有写入通道。
    const token = payload.stagingToken;
    const url = new URL(location.href);
    const safePage = typeof token === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(token) &&
      !url.username && !url.password && url.href === `https://creator.douyin.com/creator-micro/content/post/${payload.kind}?luma_import=${token}` &&
      document.documentElement?.dataset.lumaStagingToken === token;
    if (!safePage) throw Error('发布准备页面已变化，请重新带入。');
    const key = payload.kind === 'video' ? `publish_form_cache:${payload.account}` : `publish_cache:${payload.account}:image`;
    if (operation === 'read') return {ok:true,raw:localStorage.getItem(key)};
    // Chrome 注入参数可能省略 null，使用显式存在标志与字符串传输 CAS 快照，不接受旧的空值契约。
    if (operation !== 'write' || typeof payload.raw !== 'string' || typeof payload.expectedExists !== 'boolean' ||
        typeof payload.expected !== 'string' || (!payload.expectedExists && payload.expected !== '')) throw Error('草稿写入数据无效。');
    const expectedRaw = payload.expectedExists ? payload.expected : null;
    if (localStorage.getItem(key) !== expectedRaw) throw Error('抖音草稿已在其他页面变化，请重新带入。');
    const draft = JSON.parse(payload.raw), previous = expectedRaw === null ? null : JSON.parse(expectedRaw);
    // 图文和视频使用不同的作品标识；同时校验待写入内容与被替换缓存，不能抹掉已提交作品身份。
    for (const value of [draft, previous]) {
      if (value === null) continue;
      if (typeof value !== 'object' || Array.isArray(value)) throw Error('抖音草稿格式已变化，请更新扩展。');
      const body = payload.kind === 'video' ? value.cache : value;
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('抖音草稿格式已变化，请更新扩展。');
      if (['reEditId','modifyId','modifyItemId','scheduleItemId','rawModifyItem','rawModifyInfo','rawScheduleInfo'].some(key=>body[key])) throw Error('不能覆盖已提交作品的编辑草稿。');
    }
    if (!draft || (payload.kind === 'image' && !Array.isArray(draft.files))) throw Error('抖音草稿格式已变化，请更新扩展。');
    // 固定一个备份槽，保留最近被替换的原生草稿；不无限累积用户内容。
    localStorage.setItem(`luma_import_backup:${payload.account}:${payload.kind}`, JSON.stringify({raw:expectedRaw,at:Date.now()}));
    localStorage.setItem(key, payload.raw);
    if (localStorage.getItem(key) !== payload.raw) throw Error('草稿未完整保存，请重新带入。');
    return {ok:true};
  } catch (error) {
    const message = error?.name === 'QuotaExceededError' ? '浏览器存储空间不足，草稿未完成保存，请释放空间后重试。'
      : error?.name === 'SecurityError' ? '浏览器不允许保存抖音草稿，请检查网站存储权限。'
      : error instanceof SyntaxError ? '抖音草稿格式已变化，请更新扩展。' : error.message;
    return {ok:false,error:message};
  }
}

// draftPageBinding 只用 DOM 标记识别本扩展恢复的页面，不读取网站状态或业务组件。
// 标记随任何导航失效（包含 SPA 导航和进入往返缓存），人工修改原生控件不会使其失效。
export function draftPageBinding(operation, payload) {
  const {kind, marker} = payload || {};
  if (!['image','video'].includes(kind) || typeof marker !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(marker)) return {ok:false,error:'编辑页绑定信息无效。'};
  const url = new URL(location.href);
  const validPage = url.origin === 'https://creator.douyin.com' && url.pathname === `/creator-micro/content/post/${kind}` &&
    !['iid','mid','vid','draft_id','luma_import'].some(key=>url.searchParams.has(key)) && url.searchParams.get('type') !== 'new';
  const dataset = document.documentElement.dataset;
  if (operation === 'check') return {ok:true,matches:validPage && dataset.lumaDirectDraftMarker === marker && dataset.lumaDirectDraftURL === url.href};
  if (operation !== 'mark' || !validPage) return {ok:false,error:'编辑页面已变化，无法绑定当前草稿。'};
  // Chrome 116+ 支持 Navigation API；缺少事件能力时不保留可被 SPA 导航误复用的标记。
  if (!globalThis.navigation?.addEventListener) return {ok:false,error:'浏览器无法记录编辑页导航，请更新 Chrome 后重新带入。'};
  dataset.lumaDirectDraftMarker = marker;
  dataset.lumaDirectDraftURL = url.href;
  const clear = () => {
    if (dataset.lumaDirectDraftMarker !== marker) return;
    delete dataset.lumaDirectDraftMarker;
    delete dataset.lumaDirectDraftURL;
  };
  globalThis.navigation.addEventListener('navigate',clear,{once:true});
  globalThis.addEventListener('pagehide',clear,{once:true});
  return {ok:true};
}

// renderImportStatus 仅渲染扩展自己的隔离面板，不改变网站组件、输入事件或控件原型。
export function renderImportStatus(message, details = '') {
  let host = document.getElementById('luma-import-status');
  if (!host) {
    host = document.createElement('aside'); host.id = 'luma-import-status';
    Object.assign(host.style,{position:'fixed',bottom:'24px',left:'24px',zIndex:'2147483647'});
    const shadow = host.attachShadow({mode:'open'});
    const style = document.createElement('style');
    style.textContent = ':host{all:initial}.panel{box-sizing:border-box;width:min(400px,calc(100vw - 48px));padding:16px 18px;border:1px solid #b7d3ff;border-radius:12px;background:#f4f8ff;color:#19385c;box-shadow:0 4px 24px #0002;font:14px/1.6 -apple-system,BlinkMacSystemFont,sans-serif}.heading{font-weight:600;padding-right:24px}p{margin:8px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}button{position:absolute;right:12px;top:12px;border:0;background:transparent;color:inherit;cursor:pointer;font:20px/1 sans-serif}';
    const panel = document.createElement('div'); panel.className = 'panel'; panel.setAttribute('role','status');
    const heading = document.createElement('div'); heading.className = 'heading'; heading.textContent = '有序图库 · 带入抖音';
    const status = document.createElement('p'); status.id = 'status';
    const info = document.createElement('p'); info.id = 'details';
    const close = document.createElement('button'); close.textContent = '×'; close.setAttribute('aria-label','关闭带入提示');
    close.onclick = () => host.remove();
    panel.append(heading,status,info,close); shadow.append(style,panel); document.documentElement.append(host);
  }
  host.shadowRoot.getElementById('status').textContent = message;
  host.shadowRoot.getElementById('details').textContent = details;
  return {ok:true};
}

// restoreVideoDownload 是用户授权的唯一原生控件例外：普通视频页会重置草稿中的禁止保存值。
// 只在本次绑定页通过标准 click 选择禁止保存；不改 checked、不访问组件回调，交接结束即停止。
export async function restoreVideoDownload(marker) {
  const deadline = Date.now() + 30000, listeners = new Map();
  let interrupted = false, stableSince = null, previousGroup, clicks = 0, lastClick = -Infinity;
  const query = (selector, root = document) => [...root.querySelectorAll(selector), ...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot && e.id !== 'luma-import-status').flatMap(e=>query(selector,e.shadowRoot))];
  const visible = element => {
    const style = getComputedStyle(element);
    return !element.hidden && element.getClientRects().length > 0 && style.display !== 'none' && !['hidden','collapse'].includes(style.visibility);
  };
  const disabled = element => element.disabled || element.getAttribute('aria-disabled') === 'true' || [...element.classList].some(name=>/^disabled(?:-|$)/.test(name));
  // 只把真实指针、键盘和点击视为人工接管；程序 click 的默认激活也会产生可信 change，不能监听它。
  const onManualInput = event => { if (event.isTrusted) interrupted = true; };
  try {
    while (Date.now() < deadline) {
      const url = new URL(location.href), dataset = document.documentElement.dataset;
      if (typeof marker !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(marker) ||
          url.origin !== 'https://creator.douyin.com' || url.pathname !== '/creator-micro/content/post/video' ||
          ['iid','mid','vid','draft_id','luma_import'].some(key=>url.searchParams.has(key)) || url.searchParams.get('type') === 'new' ||
          dataset.lumaDirectDraftMarker !== marker || dataset.lumaDirectDraftURL !== url.href) return {ok:false,error:'编辑页面已变化，视频保存权限未自动调整。'};
      if (interrupted) return {ok:false,error:'你已手动调整视频保存权限，自动设置已停止，请核对当前选择。'};
      const groups = query('[class^="download-content-"],[class*=" download-content-"]').filter(visible);
      const group = groups.length === 1 ? groups[0] : null;
      if (group && !listeners.has(group)) {
        for (const type of ['pointerdown','keydown','click']) group.addEventListener(type,onManualInput,true);
        listeners.set(group,true);
      }
      if (group !== previousGroup) { stableSince = null; previousGroup = group; }
      const fields = label => group ? [...group.querySelectorAll('label')].filter(visible).filter(e=>e.textContent.trim() === label) : [];
      const denyLabels = fields('不允许'), allowLabels = fields('允许');
      const denyLabel = denyLabels.length === 1 ? denyLabels[0] : null, allowLabel = allowLabels.length === 1 ? allowLabels[0] : null;
      // 当前平台的单选外观实际是受控 checkbox；值、标签和同组对应关系都必须一致。
      const deny = denyLabel?.querySelector('input[type="checkbox"][value="0"]'), allow = allowLabel?.querySelector('input[type="checkbox"][value="1"]');
      if (deny && allow && visible(deny) && visible(allow)) {
        if ([group,denyLabel,allowLabel,deny,allow].some(disabled)) return {ok:false,error:'抖音当前不允许调整视频保存权限，请检查原生页面的说明。'};
        const selected = deny.checked === true && denyLabel.getAttribute('data-checked') === 'true' && allow.checked === false && allowLabel.getAttribute('data-checked') === 'false';
        const unselected = deny.checked === false && denyLabel.getAttribute('data-checked') === 'false' && allow.checked === true && allowLabel.getAttribute('data-checked') === 'true';
        if (selected) {
          stableSince ??= Date.now();
          if (Date.now() - stableSince >= 2500) return {ok:true};
        } else {
          stableSince = null;
          // 原生异步初始化可能再次覆盖；有限重试且留出受控状态提交时间，不能持续争抢人工设置。
          if (unselected && Date.now() - lastClick >= 1000) {
            if (clicks >= 3) return {ok:false,error:'抖音反复重置视频保存权限，自动设置未完成，请在原生界面核对“不允许”。'};
            deny.click(); clicks++; lastClick = Date.now();
          }
        }
      } else stableSince = null;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    return {ok:false,error:'未能确认视频“禁止保存”设置，请在原生界面核对“不允许”。'};
  } finally {
    for (const group of listeners.keys()) for (const type of ['pointerdown','keydown','click']) group.removeEventListener(type,onManualInput,true);
  }
}

// verifyDraftRender 只读核对恢复后的可见原生界面；缓存存在不能替代实际展示成功。
// skipVideoDownload 仅用于唯一控件例外之前的就绪检查，交接完成必须再次执行完整检查。
export function verifyDraftRender(source, kind = 'image', skipVideoDownload = false) {
  if (location.origin !== 'https://creator.douyin.com' || !['image','video'].includes(kind) || location.pathname !== `/creator-micro/content/post/${kind}` || new URL(location.href).searchParams.has('luma_import')) return {ok:false,error:'发布页面已变化，无法确认草稿展示。'};
  const draft = kind === 'video' ? {...source.cache,title:source.cache.itemTitle,text:source.cache.textResult.text,anchor:{id:source.cache.anchorId,payload:source.cache.anchorPayload}} : source;
  // 开放 Shadow DOM 是抖音微前端实际挂载位置，不读取 React 或 Slate 内部对象。
  const query = (selector, root = document) => [...root.querySelectorAll(selector), ...[...root.querySelectorAll('*')].filter(e=>e.shadowRoot && e.id !== 'luma-import-status').flatMap(e=>query(selector,e.shadowRoot))];
  // 原生视频页同时挂载隐藏的付费表单，不能把它的标题/描述和设置副本计入当前展示。
  const visible = element => {
    const style = getComputedStyle(element);
    return !element.hidden && element.getClientRects().length > 0 && style.display !== 'none' && !['hidden','collapse'].includes(style.visibility);
  };
  const titles = query('input,textarea').filter(visible).filter(e=>/标题/.test(e.getAttribute('placeholder') || ''));
  const descriptions = query('textarea,[contenteditable=true]').filter(visible).filter(e=>e.matches('[data-slate-editor=true].editor-comp-publish') || /描述|作品介绍/.test([e.getAttribute('placeholder'),e.getAttribute('data-placeholder'),e.getAttribute('aria-label')].filter(Boolean).join(' ')));
  if (titles.length !== 1 || titles[0].value !== draft.title || descriptions.length !== 1) return {ok:false,error:'正在等待原生标题和描述恢复。'};
  const copy = descriptions[0].cloneNode(true);
  copy.querySelectorAll('[data-slate-placeholder],[data-placeholder=true]').forEach(e=>e.remove());
  // 原生编辑器每个行容器独立显示，整体 textContent 会丢失换行；空行也必须按 DOM 顺序保留。
  const lines = descriptions[0].isContentEditable ? [...copy.querySelectorAll('[data-line-wrapper=true]')] : [];
  const text = descriptions[0].isContentEditable ? (lines.length ? lines.map(line=>line.textContent || '').join('\n') : copy.textContent) : descriptions[0].value;
  const normalizeText = value => (value || '').replace(/\r\n/g,'\n').replace(/[\u200b\ufeff]/g,'').trim();
  if (normalizeText(text) !== normalizeText(draft.text)) return {ok:false,error:'原生描述尚未恢复，请检查编辑页。'};
  // CDN 模板后缀属于资源展示格式；按完整 URI 路径边界比较，不能把相似前缀当成同一素材。
  const matchesURI = (url, uri) => {
    try {
      const path = decodeURIComponent(new URL(url,location.origin).pathname);
      return path.endsWith(`/${uri}`) || path.includes(`/${uri}~`);
    } catch { return false; }
  };
  if (kind === 'image') {
    const count = query('div,span,p').map(e=>e.textContent.trim().match(/^已添加\s*(\d+)\s*张图片(?:继续添加)?$/)).filter(Boolean).map(m=>Number(m[1]));
    if (!count.includes(draft.files.length)) return {ok:false,error:'原生图片数量尚未恢复，请检查编辑页。'};
    // Slick 的循环克隆图不参与顺序核对；只比较原始幻灯片，防止旧列表数量相同就误报成功。
    const images = query('[class^="carousel-"] img').filter(e=>!e.closest('.slick-cloned') && e.complete && e.naturalWidth > 0);
    if (images.length !== draft.files.length || draft.files.some((file,index)=>!matchesURI(images[index].currentSrc || images[index].src,file.uploadFile.uri))) return {ok:false,error:'图片已上传，正在等待原生预览和顺序恢复。'};
    // 封面使用 MediaBackground，可能渲染 img 或 CSS 背景；必须指向本次封面资源。
    const coverURI = draft.coverInfo?.upload_uri || draft.coverInfo?.uri;
    if (coverURI) {
      const covers = query('[class^="mycard-"] img,[class^="mycard-"] [class^="cover-"]');
      const coverShown = covers.some(element=>{
        if (element.tagName === 'IMG') return element.complete && element.naturalWidth > 0 && matchesURI(element.currentSrc || element.src,coverURI);
        const background = getComputedStyle(element).backgroundImage;
        const url = /^url\(["']?(.*?)["']?\)$/.exec(background || '')?.[1];
        return Boolean(url && matchesURI(url,coverURI));
      });
      if (!coverShown) return {ok:false,error:'原生封面尚未恢复，请核对页面。'};
    }
  } else {
    const expected = draft.longFileInfo;
    const videos = query('video').filter(visible);
    // 原生播放器可能使用转码 CDN 或 Blob，DOM 不保证包含 VID；核对可见播放元数据及可用的 poster。
    // 预览可能降低分辨率，比较长宽比和时长，不能要求预览尺寸等于原视频尺寸。
    const player = videos.length === 1 ? videos[0] : null;
    if (!player || !expected || player.readyState < 1 || !Number.isFinite(player.duration) ||
        !(player.videoWidth > 0 && player.videoHeight > 0) ||
        Math.abs(player.duration - expected.duration) > Math.max(1,expected.duration * 0.01) ||
        Math.abs((player.videoWidth / player.videoHeight) / (expected.width / expected.height) - 1) > 0.03 ||
        (player.poster && !matchesURI(player.poster,expected.coverUri))) return {ok:false,error:'视频已上传，正在等待原生预览和视频信息恢复。'};
  }
  const settings = [[{0:'公开',2:'好友可见',1:'仅自己可见'}[draft.visibilityType]], [draft.download === 1?'允许':'不允许'], [draft.scheduleTime === -1?'立即发布':'定时发布']];
  for (const [label] of settings) {
    if (skipVideoDownload === true && kind === 'video' && draft.download === 0 && label === '不允许') continue;
    const fields = query('label').filter(visible).filter(e=>e.textContent.trim() === label).map(e=>e.querySelector('input[type=checkbox],input[type=radio]')).filter(Boolean).filter(visible);
    if (fields.length !== 1 || !fields[0].checked) return {ok:false,error:`原生发布设置“${label}”尚未恢复，请核对页面。`};
  }
  if (draft.scheduleTime !== -1 && !query('input').filter(visible).some(e=>e.placeholder === '日期和时间' && e.value === draft.scheduleTime)) return {ok:false,error:'原生定时时间尚未恢复。'};
  if (draft.anchor?.id && !query('input,.semi-select-selection-text').filter(visible).some(e=>(e.value || e.textContent || '').trim() === draft.anchor.payload)) return {ok:false,error:'原生位置尚未恢复，请核对页面。'};
  const collection = kind === 'video' ? (draft.mixId ? {title:draft.mixInfo?.mix_name,order:draft.mixOrder} : null)
    : (draft.collectionInfo?.mix_id ? {title:draft.collectionInfo.mix_name,order:draft.collectionInfo.mix_order} : null);
  if (collection) {
    // 合集名和集数必须来自原生合集控件；正文、预览或隐藏付费表单中的同名文字不能作为成功证据。
    const selector = kind === 'video' ? '[class*="select-collection-"] [class*="selected-item-title-"]'
      : '[class*="mix-sel-wrap-"] [class*="sel-area-"] .semi-select-selection-text';
    const names = query(selector).filter(visible).filter(element=>!element.closest('[class*="sel-order-"],[class*="select-mix-type-"]'));
    const orders = query('[class*="sel-order-"] .semi-select-selection-text').filter(visible);
    if (names.filter(element=>element.textContent.trim() === collection.title).length !== 1 ||
        orders.filter(element=>element.textContent.replace(/\s/g,'') === `第${collection.order}集`).length !== 1) {
      return {ok:false,error:'原生合集或集数尚未恢复，请核对发布页。'};
    }
  }
  const cleared = kind === 'video' ? Object.hasOwn(draft,'mixId') && draft.mixId === null
    : Object.hasOwn(draft,'collectionInfo') && draft.collectionInfo === null;
  if (cleared) {
    const selector = kind === 'video' ? '[class*="select-collection-"] .semi-select-selection-text'
      : '[class*="mix-sel-wrap-"] [class*="sel-area-"] .semi-select-selection-text';
    const fields = query(selector).filter(visible).filter(element=>!element.closest('[class*="sel-order-"],[class*="select-mix-type-"]'));
    const orders = query('[class*="sel-order-"] .semi-select-selection-text').filter(visible);
    // 没有合集权限时平台不渲染这一栏；若有控件，必须明确显示空选择，且不能残留集数。
    const emptyLabels = kind === 'video' ? ['请选择合集','不选择合集'] : ['不选择合集'];
    if (orders.length || (fields.length && (fields.length !== 1 || !emptyLabels.includes(fields[0].textContent.trim())))) {
      return {ok:false,error:'原生合集尚未清除，请核对发布页。'};
    }
  }
  return {ok:true};
}
