import {creatorJSONOptions} from './browser-request.js';

// activityJSON 限制活动响应体积；精确身份必须来自详情字符串，不能把已舍入的列表数字转成身份。
function activityJSON(source) {
  if (typeof source !== 'string' || source.length > 4 * 1024 * 1024 || new TextEncoder().encode(source).byteLength > 4 * 1024 * 1024) throw Error('活动响应过大，请稍后重新读取。');
  return JSON.parse(source);
}

// createCreatorAPI 通过同一登录网页环境执行固定业务协议，登录会话始终留在宿主。
// 不读取 Cookie、不调用网站私有组件，也不生成或绕过平台安全签名。
export function createCreatorAPI(send) {
return async function creatorRequest(operation, params = {}) {
  const origin = 'https://creator.douyin.com';
  const fetch = async (value, options) => {
    const response = await send(new URL(value, origin).href, creatorJSONOptions(options));
    // 只根据明确的 HTTP 登录拒绝归类；未知平台业务码仍按原错误反馈，不推测账号失效。
    if ([401, 403].includes(response.status)) throw Object.assign(Error('当前抖音登录不可用，请在账号菜单中重新登录后重试。'), {code: 'SESSION_EXPIRED', definiteFailure: true});
    return response;
  };
  const text = value => typeof value === 'string' ? value : '';
  const identifier = value => /^\d{1,30}$/.test(text(value));
  // 收藏可返回 16 位字符串游标；它是平台位置令牌而非递增页码，数值形式只接受不会失真的安全整数。
  const musicCursor = value => typeof value === 'string' && /^\d{1,30}$/.test(value) ? value
    : Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  const mediaURL = value => { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : undefined; } catch { return undefined; } };
  let path, query = {}, method = 'GET', body, headers, credentials = 'include';
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
      case 'topics.recommend':
        if (typeof params.frames !== 'string' || !params.frames || params.frames.length > 20000 || /[\s?#\\]/u.test(params.frames) || params.frames.includes('://')) throw Error('推荐话题需要本次作品已上传的图片资源。');
        path = '/web/api/media/hashtag/rec/'; query.frames = params.frames; break;
      case 'activities.list':
        if (!['0', '1'].includes(String(params.cursor ?? '0')) || text(params.query).trim()) throw Error('活动目录暂不支持分页或远端筛选，请重新打开活动列表。');
        // 实机确认外部目录忽略 page/size 且没有续页字段；只请求一次并限制完整响应，不伪造分页。
        path = '/web/api/media/activity/get/'; query = {page: 1, size: 10, need_challenge: 1}; break;
      case 'activities.detail':
        if (!identifier(params.id)) throw Error('活动身份无效，请重新选择官方活动。');
        path = '/web/api/media/activity/detail/'; query.activity_id = params.id; break;
      case 'declarations.list':
        if (!['image', 'video'].includes(params.kind) || !/^[a-zA-Z0-9_-]{1,100}$/.test(params.draftId || '')) throw Error('请选择有效作品后读取自主声明。');
        path = '/aweme/v3/user_declaration/suggestion/';
        query = {scene: 'new_self_media_before_publish', creation_id: params.draftId, libra_token: 'douyin_pc',
          user_decl_judge_feats: JSON.stringify({has_ai_metadata: false, is_xing_tu_submit: false, has_marketing_poi: false, item_type: params.kind})};
        break;
      case 'users.search':
        if (text(params.query).length > 100 || !/^\d{1,12}$/.test(String(params.cursor ?? '0'))) throw Error('用户搜索参数无效。');
        path = text(params.query).trim() ? '/web/api/v2/discover/search/' : '/web/api/v2/user/recent/contact/';
        if (text(params.query).trim()) query = {keyword: params.query.trim(), cursor: params.cursor || '0', scene: 1, search_source: 'publish_web', count: 10}; break;
      case 'music.resolve':
        if (!identifier(params.id) || Object.keys(params).some(key => key !== 'id')) throw Error('请选择有效的音乐身份。');
        path = '/web/api/media/music/info/'; query.id = params.id; break;
      case 'music.categories': path = '/web/api/media/music/category'; break;
      case 'music.list':
        if (!/^\d{1,30}$/.test(String(params.category_id)) || !['recommend', 'rank', 'fav', 'category'].includes(params.type) || musicCursor(params.cursor ?? '0') === null || !/^[a-zA-Z0-9-]{1,100}$/.test(params.creation_id || '')) throw Error('音乐分类参数无效。');
        path = '/web/api/media/music/list'; query = {category_id: params.category_id, type: params.type, cursor: musicCursor(params.cursor ?? '0'), count: 20, creation_id: params.creation_id}; break;
      case 'music.search': {
        if (!text(params.query).trim() || params.query.length > 100 || !/^\d{1,12}$/.test(String(params.cursor ?? '0'))) throw Error('请输入 1–100 字的音乐关键词。');
        // 通过公开业务授权接口取得本次搜索授权；只发到固定搜索域，不持久化或记录。
        const authorization = await fetch('/web/api/media/aweme/search/post/auth', {credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(15000)});
        const grant = await authorization.json();
        if (!authorization.ok || grant?.status_code !== 0 || typeof grant.signature !== 'string' || !grant.signature || grant.signature.length > 16384) throw Error('音乐搜索授权未完成，请检查抖音登录状态后重试。');
        path = 'https://tsearch.amemv.com/openapi/aweme/v1/music/search/';
        query = {keyword: params.query.trim(), cursor: params.cursor || '0', count: 20, aid: 1128, search_source: 'normal_search'};
        headers = {'Agw-Auth': grant.signature, 'Openapi-Omit-Shark': '1'};
        credentials = 'omit';
        break;
      }
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
          if (!check.ok || account.status_code !== 0) return {ok: false, definiteFailure: true, error: '平台未能确认当前登录，发布未提交，请检查账号后重试。'};
          if (account.user?.uid !== params.expectedAccountId) return {ok: false, definiteFailure: true, code: 'ACCOUNT_CHANGED', error: '当前抖音账号已变化，发布未提交，请重新准备。'};
        }
        path = '/web/api/media/aweme/create_v2/'; query.read_aid = 2906; method = 'POST'; body = JSON.stringify(params.payload); break;
      default: throw Error('此能力尚未接入发布工作台。');
    }
    const url = new URL(path, origin);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await fetch(url, {method, credentials, redirect: 'error', ...(headers ? {headers} : {}), signal: AbortSignal.timeout(operation === 'publication.publish' ? 45000 : 15000), ...(body ? {headers: {'Content-Type': 'application/json'}, body} : {})});
    const data = operation.startsWith('activities.') ? activityJSON(await response.text()) : await response.json();
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
    if (operation === 'topics.search' || operation === 'topics.recommend') {
      const topics = operation === 'topics.search' ? data.sug_list : data.challenge_list;
      if (!Array.isArray(topics)) throw Error('话题列表格式已变化，请重新查询。');
      return {ok: true, data: {items: topics.filter(x => identifier(x.cid) && text(x.cha_name)).map(x => ({id: x.cid, name: x.cha_name,
        description: text(x.entrance_desc).slice(0, 100), viewCount: Number.isFinite(x.view_count) && x.view_count >= 0 ? x.view_count : undefined})), nextCursor: null}};
    }
    if (operation === 'activities.list') {
      if (!Array.isArray(data.activity_list) || data.activity_list.length > 200) throw Error('活动目录格式或数量已变化，请在创作者中心核对活动。');
      const ids = new Set(), items = [];
      for (const entry of data.activity_list) {
        // 列表 challenge_ids 在服务端已丢失精度；这里只展示话题名称，选择时再读详情取得准确字符串身份。
        if (!Array.isArray(entry?.challenge)) continue;
        const id = typeof entry?.activity_id === 'string' ? entry.activity_id : Number.isSafeInteger(entry?.activity_id) ? String(entry.activity_id) : '';
        const name = text(entry?.activity_name).trim(), topicName = text(entry?.challenge?.[0]).trim();
        if (!/^[1-9]\d{0,29}$/.test(id) || !name || name.length > 200 || !topicName || topicName.length > 200 || /[#\r\n]/u.test(topicName) || ids.has(id)) continue;
        ids.add(id);
        let thumbnailURL;
        try { const url = new URL(entry.cover_image); if (url.protocol === 'https:' && !url.username && !url.password) thumbnailURL = url.href; } catch {}
        const disabled = entry.activity_status !== 1 || !!entry.game_id;
        const description = entry.activity_status !== 1 ? '此活动当前未处于可参加状态，请在创作者中心核对。'
          : entry.game_id ? '此活动需要额外绑定游戏推广组件，请在创作者中心添加。' : '';
        items.push({id, name, topicName,
          heat: Number.isFinite(entry.hot_score) && entry.hot_score >= 0 ? entry.hot_score : undefined,
          thumbnailURL, startTime: text(entry.show_start_time).slice(0, 100), endTime: text(entry.show_end_time).slice(0, 100),
          disabled, description});
      }
      return {ok: true, data: {items, nextCursor: null, hasMore: false, message: ''}};
    }
    if (operation === 'activities.detail') {
      const info = data.activity_info;
      if (!info || !text(info.activity_name).trim() || info.activity_name.length > 200 || (info.activity_id !== undefined && String(info.activity_id) !== params.id) || !Array.isArray(data.topics) || data.topics.length > 50) throw Error('活动详情无法确认，请稍后重新读取。');
      // 配对前整体验证，禁止过滤后错位、数字转字符串或只取一部分身份；缺失时仍可查看说明，但不能选择发布。
      const paired = Array.isArray(data.topics_ids) && data.topics_ids.length === data.topics.length && data.topics.length > 0
        && data.topics.every(value => typeof value === 'string' && !!value.trim() && value.length <= 200 && !/[#\r\n]/u.test(value))
        && data.topics_ids.every(value => typeof value === 'string' && /^[1-9]\d{0,29}$/.test(value))
        && new Set(data.topics_ids).size === data.topics_ids.length;
      const topicChoices = paired ? data.topics.map((name, index) => ({id: data.topics_ids[index], name: name.trim()})) : [];
      let rewardDescription = '';
      if (typeof data.reward_rules === 'string') {
        try {
          const rules = JSON.parse(data.reward_rules);
          rewardDescription = typeof rules.text === 'string' ? rules.text : Array.isArray(rules.text) && rules.text.every(value => typeof value === 'string') ? rules.text.join('\n') : '';
        } catch {}
      }
      return {ok: true, data: {id: params.id, name: text(info.activity_name).slice(0, 200), description: text(data.activity_description).slice(0, 5000),
        topics: data.topics.filter(value => typeof value === 'string' && value.length <= 200), topicChoices,
        startTime: text(data.publish_start_time).slice(0, 100), endTime: text(data.publish_end_time).slice(0, 100), rewardDescription: rewardDescription.slice(0, 5000)}};
    }
    if (operation === 'declarations.list') {
      const options = data.data;
      if (!Array.isArray(options?.options) || ![0, 1, 2, 3].includes(options.block_type)) throw Error('自主声明选项无法确认，请重新读取后再发布。');
      const seen = new Set();
      const items = options.options.filter(item => item && typeof item.choose_value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(item.choose_value) && typeof item.text === 'string' && item.text.trim() && item.text.length <= 500 && !seen.has(item.choose_value) && seen.add(item.choose_value)).map(item => {
        const needsFields = ['source_option', 'location_and_date'].includes(item.show_type);
        return {id: item.choose_value, label: item.text, disabled: needsFields,
          description: needsFields ? '此声明需要补充来源或拍摄时间地点，当前工作台尚未接入补充表单。' : ''};
      });
      return {ok: true, data: {items, required: [1, 2].includes(options.block_type), nextCursor: null}};
    }
    if (operation === 'users.search') return {ok: true, data: {items: (data.user_list || []).filter(x => identifier(x.uid) && text(x.nickname)).map(x => {
      // 最近联系人和搜索共用平台展示字段；缺失粉丝数不补零，草稿仍只绑定 uid 与昵称。
      const handle = text(x.unique_id) || text(x.short_id);
      return {id: x.uid, name: x.nickname, description: handle, handle,
        followerCount: Number.isSafeInteger(x.follower_count) && x.follower_count >= 0 ? x.follower_count : null,
        thumbnailURL: mediaURL(x.avatar_thumb?.url_list?.[0])};
    }), nextCursor: data.has_more && Number.isSafeInteger(Number(data.cursor)) ? String(Number(data.cursor) + 10) : null}};
    // 官方详情按 id 返回基础身份，不返回音源或时长；这些字段不能猜测或由名称补齐。
    if (operation === 'music.resolve') {
      if (!identifier(data.music_id) || data.music_id !== params.id || !text(data.music_name).trim() || data.music_name.length > 200) throw Error('平台返回的音乐身份无法确认，已保留原配乐。');
      return {ok: true, data: {id: data.music_id, name: data.music_name, description: text(data.music_author), thumbnailURL: mediaURL(data.cover_url), previewURL: null}};
    }
    if (operation === 'music.categories') {
      if (!Array.isArray(data.categories) || data.categories.length > 100) throw Error('音乐分类格式或数量已变化，请重新读取。');
      const seen = new Set(), items = [];
      for (const entry of data.categories) {
        const id = typeof entry?.category_id === 'string' ? entry.category_id : Number.isSafeInteger(entry?.category_id) ? String(entry.category_id) : '';
        const name = (text(entry?.category_name) || text(entry?.name)).trim(), type = entry?.type;
        const key = `${type}:${id}`;
        if (!/^\d{1,30}$/.test(id) || !['recommend', 'rank', 'fav', 'category'].includes(type) || !name || name.length > 200 || seen.has(key)) continue;
        seen.add(key); items.push({id, type, name});
      }
      return {ok: true, data: {items}};
    }
    if (operation === 'music.list' || operation === 'music.validate') {
      const songs = operation === 'music.list' ? data.songs : [data];
      if (!Array.isArray(songs)) throw Error('音乐列表格式已变化，请稍后重试。');
      const nextCursor = data.has_more ? musicCursor(data.cursor) : null;
      if (operation === 'music.list' && data.has_more && (!nextCursor || nextCursor === musicCursor(params.cursor ?? '0'))) throw Error('音乐分页位置未更新，请稍后重试。');
      return {ok: true, data: {items: songs.filter(x => identifier(x.music_id) && text(x.music_name)).map(x => ({id: x.music_id, name: x.music_name, description: text(x.music_author), duration: Number.isFinite(x.duration) ? x.duration : undefined, thumbnailURL: mediaURL(x.cover_url), previewURL: mediaURL(x.play_url), userCount: Number.isFinite(x.user_count) && x.user_count >= 0 ? x.user_count : undefined})), nextCursor}};
    }
    if (operation === 'music.search') {
      if (!Array.isArray(data.music)) throw Error('音乐搜索结果格式已变化，请重试。');
      const nextCursor = data.has_more && /^\d{1,12}$/.test(String(data.cursor)) ? String(data.cursor) : null;
      if (data.has_more && (!nextCursor || nextCursor === String(params.cursor ?? '0'))) throw Error('音乐分页位置未更新，请稍后重试。');
      return {ok: true, data: {items: data.music.filter(item => identifier(item.id_str) && text(item.title)).map(item => ({id: item.id_str, name: item.title,
        description: text(item.author), duration: Number.isFinite(item.duration) ? item.duration : undefined,
        previewURL: mediaURL(item.play_url?.url_list?.[0]), thumbnailURL: mediaURL(item.cover_thumb?.url_list?.[0]),
        userCount: Number.isFinite(item.user_count) && item.user_count >= 0 ? item.user_count : undefined})), nextCursor}};
    }
    if (operation === 'publication.publish') {
      if (!identifier(data.item_id)) return {ok: false, error: '平台响应未包含可确认的作品标识，请查询创作者中心，勿重复提交。'};
      return {ok: true, data: {publicationId: data.item_id, status: 'processing', message: '平台已接受提交，审核和实际发布状态请在创作者中心确认。'}};
    }
    // 尚未验证状态枚举，只报告真实查询是否找到作品，不猜测“已发布”。
    if (operation === 'publication.status') return {ok: true, data: {publicationId: params.publicationId, status: 'processing', message: data.aweme ? '已查到作品记录；审核、可见性及定时状态请在创作者中心核对。' : '暂未查到完整作品记录，请稍后查询。'}};
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : undefined;
    return {ok: false, ...(code ? {code} : {}), ...(error?.definiteFailure === true ? {definiteFailure: true} : {}),
      error: operation === 'publication.publish' && error?.definiteFailure !== true ? '发布结果待确认，请核对创作者中心，勿重复提交。' : /[\u3400-\u9fff]/.test(error?.message || '') ? error.message : '查询超时或页面已变化，请检查抖音页面后重试。'};
  }
}

}
