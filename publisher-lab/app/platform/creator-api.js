// createCreatorAPI 通过宿主原生请求执行固定业务协议，登录会话始终留在宿主。
// 不读取 Cookie、不调用网站私有组件，也不生成或绕过平台安全签名。
export function createCreatorAPI(send) {
return async function creatorRequest(operation, params = {}) {
  const origin = 'https://creator.douyin.com';
  const fetch = (value, options) => send(new URL(value, origin).href, options);
  const text = value => typeof value === 'string' ? value : '';
  const identifier = value => /^\d{1,30}$/.test(text(value));
  const mediaURL = value => { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : undefined; } catch { return undefined; } };
  let path, query = {}, method = 'GET', body;
  try {
    switch (operation) {
      case 'account': path = '/web/api/media/user/info/'; query.device_platform = 'web'; break;
      case 'auth': path = '/web/api/media/upload/auth/v5/'; break;
      case 'video-enable': case 'video-status':
        if (!/^[a-zA-Z0-9_-]{1,100}$/.test(params.vid || '')) throw Error('视频资源标识无效。');
        path = operation === 'video-enable' ? '/web/api/media/video/enable/' : '/web/api/media/video/transend/'; query.video_id = params.vid; break;
      case 'topics.search':
        if (!text(params.query).trim() || params.query.length > 100) throw Error('请输入 1–100 字的话题。');
        path = '/aweme/v1/search/challengesug/'; query = {keyword: params.query.trim(), source: 'challenge_create', aid: 2906}; break;
      case 'users.search':
        if (text(params.query).length > 100 || !/^\d{1,12}$/.test(String(params.cursor ?? '0'))) throw Error('用户搜索参数无效。');
        path = text(params.query).trim() ? '/web/api/v2/discover/search/' : '/web/api/v2/user/recent/contact/';
        if (text(params.query).trim()) query = {keyword: params.query.trim(), cursor: params.cursor || '0', scene: 1, search_source: 'publish_web', count: 10}; break;
      case 'music.categories': path = '/web/api/media/music/category'; break;
      case 'music.list':
        if (!/^\d{1,30}$/.test(String(params.category_id)) || !['recommend', 'rank', 'fav', 'category'].includes(params.type) || !/^\d{1,12}$/.test(String(params.cursor ?? '0')) || !/^[a-zA-Z0-9-]{1,100}$/.test(params.creation_id || '')) throw Error('音乐分类参数无效。');
        path = '/web/api/media/music/list'; query = {category_id: params.category_id, type: params.type, cursor: params.cursor || '0', count: 20, creation_id: params.creation_id}; break;
      case 'music.validate': {
        const url = new URL(params.query);
        if (url.origin !== 'https://v.douyin.com' || url.username || url.password || url.href.length > 500) throw Error('请粘贴抖音音乐分享链接。');
        path = '/web/api/media/music/validate/'; query.url = url.href; break;
      }
      case 'publication.status':
        if (!identifier(params.publicationId)) throw Error('作品标识无效。');
        path = '/web/api/media/item/info/'; query.item_id = params.publicationId; break;
      case 'publication.publish':
        if (!identifier(params.expectedAccountId) || !params.payload?.item?.common || JSON.stringify(params.payload).length > 50000) throw Error('发布快照无效，请重新准备。');
        // 就在提交前重新核对账号；不使用缓存的登录判断。
        {
          const check = await fetch('/web/api/media/user/info/?device_platform=web', {credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(15000)});
          const account = await check.json();
          if (!check.ok || account.status_code !== 0 || account.user?.uid !== params.expectedAccountId) return {ok: false, definiteFailure: true, error: '当前抖音账号已变化，发布未提交，请重新准备。'};
        }
        path = '/web/api/media/aweme/create_v2/'; query.read_aid = 2906; method = 'POST'; body = JSON.stringify(params.payload); break;
      default: throw Error('此能力尚未接入实验工作台。');
    }
    const url = new URL(path, origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetch(url, {method, credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(operation === 'publication.publish' ? 45000 : 15000), ...(body ? {headers: {'Content-Type': 'application/json'}, body} : {})});
    const data = await response.json();
    if (!response.ok || data?.status_code !== 0) return {ok: false, definiteFailure: operation === 'publication.publish' && typeof data?.status_code === 'number' && data.status_code !== 0, error: operation === 'publication.publish' ? '平台未接受本次发布，可能需要验证或补充发布设置。请在创作者中心核对；工作台不会自动重发。' : '抖音查询未成功，请检查登录状态、账号权限和网络后重试。'};
    if (operation === 'account') {
      if (!identifier(data.user?.uid)) throw Error('无法确认当前抖音账号，请重新登录。');
      return {ok: true, data: {id: data.user.uid, name: text(data.user.nickname).slice(0, 100) || `抖音账号 ${data.user.uid}`, avatarURL: mediaURL(data.user.avatar_thumb?.url_list?.[0])}};
    }
    if (operation === 'auth') {
      const auth = typeof data.auth === 'string' ? JSON.parse(data.auth) : null;
      if (!auth?.AccessKeyID || !auth.SecretAccessKey || !auth.SessionToken || !(Date.parse(auth.ExpiredTime) > Date.now())) throw Error('抖音上传授权不可用，请重试。');
      return {ok: true, auth};
    }
    if (['video-enable', 'video-status'].includes(operation)) return {ok: true, data};
    if (operation === 'topics.search') return {ok: true, data: {items: (data.sug_list || []).filter(x => identifier(x.cid) && text(x.cha_name)).map(x => ({id: x.cid, name: x.cha_name, description: text(x.entrance_desc).slice(0, 100)}))}};
    if (operation === 'users.search') return {ok: true, data: {items: (data.user_list || []).filter(x => identifier(x.uid) && text(x.nickname)).map(x => ({id: x.uid, name: x.nickname, description: text(x.unique_id) || text(x.short_id), thumbnailURL: mediaURL(x.avatar_thumb?.url_list?.[0])})), nextCursor: data.has_more && Number.isSafeInteger(Number(data.cursor)) ? String(Number(data.cursor) + 10) : null}};
    if (operation === 'music.categories') return {ok: true, data: {items: (data.categories || []).filter(x => /^\d{1,30}$/.test(String(x.category_id)) && ['recommend', 'rank', 'fav', 'category'].includes(x.type)).map(x => ({id: String(x.category_id), type: x.type, name: text(x.category_name) || text(x.name)}))}};
    if (operation === 'music.list' || operation === 'music.validate') {
      const songs = operation === 'music.list' ? data.songs : [data];
      if (!Array.isArray(songs)) throw Error('音乐列表格式已变化，请稍后重试。');
      return {ok: true, data: {items: songs.filter(x => identifier(x.music_id) && text(x.music_name)).map(x => ({id: x.music_id, name: x.music_name, description: text(x.music_author), duration: Number.isFinite(x.duration) ? x.duration : undefined, thumbnailURL: mediaURL(x.cover_url), previewURL: mediaURL(x.play_url)})), nextCursor: data.has_more && /^\d{1,12}$/.test(String(data.cursor)) ? String(data.cursor) : null}};
    }
    if (operation === 'publication.publish') {
      if (!identifier(data.item_id)) return {ok: false, error: '平台响应未包含可确认的作品标识，请查询创作者中心，勿重复提交。'};
      return {ok: true, data: {publicationId: data.item_id, status: 'processing', message: '平台已接受提交，审核和实际发布状态请在创作者中心确认。'}};
    }
    // 尚未验证状态枚举，只报告真实查询是否找到作品，不猜测“已发布”。
    if (operation === 'publication.status') return {ok: true, data: {publicationId: params.publicationId, status: 'processing', message: data.aweme ? '已查到作品记录；审核、可见性及定时状态请在创作者中心核对。' : '暂未查到完整作品记录，请稍后查询。'}};
  } catch (error) {
    return {ok: false, error: operation === 'publication.publish' ? '发布结果待确认，请核对创作者中心，勿重复提交。' : /[\u3400-\u9fff]/.test(error?.message || '') ? error.message : '查询超时或页面已变化，请检查抖音页面后重试。'};
  }
}

}
