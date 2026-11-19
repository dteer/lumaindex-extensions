import {topicKey} from './studio-state.js';

// contains 检查完整话题/提及，不能把短名称误当成更长标签。
function contains(text, token) {
  const boundary = character => !character || !/[\p{L}\p{N}\p{M}_#@]/u.test(character);
  let at = text.indexOf(token);
  while (at >= 0) {
    if (boundary(Array.from(text.slice(0, at)).at(-1)) && boundary(Array.from(text.slice(at + token.length))[0])) return true;
    at = text.indexOf(token, at + token.length);
  }
  return false;
}

// removeActivityTopic 只移除被用户明确取消的活动标签，不动其他普通话题。
function removeActivityTopic(text, name) {
  const token = '#' + name;
  const boundary = character => !character || !/[\p{L}\p{N}\p{M}_#@]/u.test(character);
  let start = text.indexOf(token);
  while (start >= 0) {
    if (boundary(Array.from(text.slice(0, start)).at(-1)) && boundary(Array.from(text.slice(start + token.length))[0])) {
      text = text.slice(0, start) + text.slice(start + token.length);
      start = text.indexOf(token, start);
    } else start = text.indexOf(token, start + token.length);
  }
  return text.trim();
}

// addTopic 保持首行品牌和末尾拍摄日期的位置，活动话题插在日期之前。
function addTopic(description, name) {
  if (contains(description, '#' + name)) return description;
  const date = description.match(/\n#\d{8}$/u)?.[0] || '';
  const body = date ? description.slice(0, -date.length) : description;
  return body + (body && !/\s$/u.test(body) ? '\n' : '') + '#' + name + date;
}

// buildAIApplication 先构造并校验一次应用快照；失败时不留下半份正文或资源选择。
export function buildAIApplication(draft, value, selection) {
  const next = structuredClone(draft);
  if (selection.copy) { next.title = value.title; next.description = value.description; }
  if (selection.activity) {
    next.activities = value.activity ? [{id: value.activity.id, name: value.activity.name, topic: {...value.activity.topic}}] : [];
    for (const activity of draft.activities) {
      if (next.activities.some(item => item.topic.name === activity.topic.name)) continue;
      next.description = removeActivityTopic(next.description, activity.topic.name);
      next.topics = next.topics.filter(item => item.name !== activity.topic.name);
    }
  }
  // 不勾选活动时仍保留原活动及其可见话题，不因换文案隐式取消参加。
  if (selection.copy || selection.activity) for (const activity of next.activities) next.description = addTopic(next.description, activity.topic.name);
  if (selection.copy) {
    next.topics = next.topics.filter(item => contains(next.description, '#' + item.name));
    next.mentions = next.mentions.filter(item => contains(next.description, '@' + item.name));
    for (const topic of value.topics || []) if (contains(next.description, '#' + topic.name) && !next.topics.some(item => item.name === topic.name)) next.topics.push({...topic});
  }
  if (selection.copy || selection.activity) for (const activity of next.activities) {
    next.topics = next.topics.filter(item => item.name !== activity.topic.name && item.id !== activity.topic.id);
    next.topics.push({...activity.topic});
  }
  if (selection.hotspot) next.hotspot = value.hotspot?.name || '';
  if (selection.location && value.location) {
    const {id, name, cityCode, cityName} = value.location;
    next.location = {id, name, cityCode, cityName};
  }
  if (selection.music && value.music) next.music = {id: value.music.id, name: value.music.name};
  if (selection.copy && next.title.length > 20) throw Error('标题最多 20 字，请先编辑 AI 文案。');
  if ((selection.copy || selection.activity) && next.description.length > 1000) throw Error('加入活动话题后正文超过 1000 字，请先缩短文案。');
  if ((selection.copy || selection.activity) && new Set([...next.topics.map(topicKey), ...next.activities.map(item => topicKey(item.topic))]).size > 5) throw Error('话题和官方活动合计最多添加 5 个，请先移除一个话题。');
  return next;
}
