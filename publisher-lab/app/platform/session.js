import {CREATOR_ORIGIN} from './browser-request.js';

export {CREATOR_ORIGIN};
// CREATOR_LOGIN_URL 由平台适配器选择公开登录入口；宿主只提供已授权同源网页容器。
export const CREATOR_LOGIN_URL = CREATOR_ORIGIN + '/';

// beginCreatorLogin 明确新增或复用指定档案的持久网页登录环境，使用真实 WebKit 默认 UA；结果仍须平台账号核验。
export function beginCreatorLogin(call, {profileId} = {}) {
  if (profileId !== undefined && (typeof profileId !== 'string' || !profileId)) throw Error('请选择一个已保存的抖音账号。');
  return call('session.login', {origin: CREATOR_ORIGIN, url: CREATOR_LOGIN_URL, ...(profileId === undefined ? {} : {profileId})});
}
