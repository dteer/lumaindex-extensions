// 创作者中心的公开浏览器请求配置由平台插件维护，宿主不推导平台头部。
export const CREATOR_ORIGIN = 'https://creator.douyin.com';
// CREATOR_REFERRER 是已实测的公开上传入口；不读取本机页面、素材路径、草稿或账号字段。
export const CREATOR_REFERRER = CREATOR_ORIGIN + '/creator-micro/content/upload?default-tab=3';
// CREATOR_JSON_ACCEPT 沿用创作者中心业务 JSON 查询的实际 Accept，不能套用到音频或本机素材请求。
export const CREATOR_JSON_ACCEPT = 'application/json, text/plain, */*';
// 平台插件选择页面入口与本次账号；UA、Cookie、Origin、Referer 和 Sec-* 由该页面的 WebKit 生成。
// profileId 必须来自单次 dispatch 的固定上下文，不能临时读取界面当前选择。
export function createCreatorFetch(send) {
  return function creatorFetch(input, {profileId, ...options} = {}) {
    return send(input, {...options, browserContext: {origin: CREATOR_ORIGIN, contextURL: CREATOR_REFERRER, profileId}});
  };
}

// creatorJSONOptions 仅补齐业务查询缺省 Accept；显式类型、签名和业务头按 Headers 语义保留。
export function creatorJSONOptions(options = {}) {
  const headers = new Headers(options.headers);
  if (!headers.has('accept')) headers.set('accept', CREATOR_JSON_ACCEPT);
  return {...options, headers: Object.fromEntries(headers)};
}
