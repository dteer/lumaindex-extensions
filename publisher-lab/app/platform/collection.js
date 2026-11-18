// validateCollectionQuery 校验合集类型和平台数字游标；每页固定十条，不接收外部 URL 或任意分页大小。
export function validateCollectionQuery(params) {
  const cursor = params?.cursor === undefined ? '0' : params.cursor;
  if (!params || Array.isArray(params) || !['image','video'].includes(params.kind) ||
      typeof cursor !== 'string' || !/^(0|[1-9]\d{0,29})$/.test(cursor)) throw Error('合集查询参数无效，请重新打开合集列表。');
  return {kind:params.kind,cursor};
}

// listCollections 由插件通过宿主原生会话直接读取一页普通免费合集，不调用平台请求包装器或组件。
// 本函数独立校验参数；账号前后核验由调用方 完成。
export async function listCollections(params, send) {
  const fetch = (value, options) => send(new URL(value, 'https://creator.douyin.com').href, options);
  const cursor = params?.cursor === undefined ? '0' : params.cursor;
  if (!params || Array.isArray(params) || !['image','video'].includes(params.kind) ||
      typeof cursor !== 'string' || !/^(0|[1-9]\d{0,29})$/.test(cursor)) return {ok:false,error:'合集查询参数无效，请重新打开合集列表。'};
  try {
    const url = new URL('/web/api/mix/list/','https://creator.douyin.com');
    // 发布页 imageCollection 使用 status=0,2；以服务器游标分页，不预取全量后切片。
    url.searchParams.set('status','0,2'); url.searchParams.set('count','10'); url.searchParams.set('cursor',cursor);
    const response = await fetch(url,{method:'GET',credentials:'include',redirect:'error',signal:AbortSignal.timeout(12000)});
    const data = await response.json();
    if (!response.ok || data?.status_code !== 0 || !Array.isArray(data.mix_list) || ![false,true,0,1].includes(data.has_more)) {
      return {ok:false,error:'合集查询失败，请检查抖音登录状态后重试。'};
    }
    let nextCursor = null;
    if (data.has_more) {
      // 游标可能是数字时间戳或数字字符串，禁止把不精确的 JavaScript 大整数继续发送。
      nextCursor = typeof data.cursor === 'string' ? data.cursor : Number.isSafeInteger(data.cursor) && data.cursor >= 0 ? String(data.cursor) : '';
      if (!/^(0|[1-9]\d{0,29})$/.test(nextCursor) || nextCursor === cursor) return {ok:false,error:'合集分页信息未更新，请稍后重新查询。'};
    }
    const items = [], ids = new Set();
    for (const item of data.mix_list) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || item.type !== 0 ||
          ![0,2].includes(item.status?.status) || typeof item.mix_id !== 'string' || !/^\d{1,30}$/.test(item.mix_id) ||
          typeof item.mix_name !== 'string' || !item.mix_name.trim() || item.mix_name.length > 200 || ids.has(item.mix_id)) continue;
      // 付费、会员、短剧和 content_sub_type 标识的新合集有额外原生配置，只返回已确认的普通免费合集。
      if ((item.is_charge_series != null && ![0,false].includes(item.is_charge_series)) ||
          (item.charge_info && Object.keys(item.charge_info).length) || item.charge_episodes?.length || item.charge_skus?.length) continue;
      let extra = {};
      if (item.extra !== undefined && item.extra !== null && item.extra !== '') {
        if (typeof item.extra !== 'string') continue;
        try { extra = JSON.parse(item.extra); } catch { continue; }
        if (!extra || typeof extra !== 'object' || Array.isArray(extra)) continue;
      }
      if (extra.content_sub_type !== undefined && extra.content_sub_type !== 0) continue;
      const count = item.statis?.updated_to_episode;
      if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(count + 1)) continue;
      if (item.total_episode !== undefined && (!Number.isSafeInteger(item.total_episode) || item.total_episode < 0)) continue;
      // 图文下拉选择下一集；视频原生在已有集数等于总集数时保留末集，其余选择下一集。
      const order = params.kind === 'video' && item.total_episode === count ? count : count + 1;
      if (order < 1) continue;
      // 原生回显仅需要这些字段，不向 App 或缓存转交作者资料、签名封面 URL、额外信息和收费配置。
      const info = {mix_id:item.mix_id,mix_name:item.mix_name,type:0,statis:{updated_to_episode:count}};
      if (item.total_episode !== undefined) info.total_episode = item.total_episode;
      // 原生下拉的“共 N 个作品”使用原始 updated_to_episode；不可把下一集 order 当作作品数。
      // 封面仅用于本次列表展示，不进入最小发布身份 info 或草稿。
      let thumbnailURL;
      try {
        const cover = new URL(item.cover_url?.url_list?.[0]);
        if (cover.protocol === 'https:' && !cover.username && !cover.password) thumbnailURL = cover.href;
      } catch {}
      items.push({id:item.mix_id,title:item.mix_name,order,itemCount:count,thumbnailURL,info}); ids.add(item.mix_id);
    }
    return {ok:true,data:{items,nextCursor}};
  } catch {
    return {ok:false,error:'无法读取抖音合集，请检查网络和登录状态后重试。'};
  }
}
