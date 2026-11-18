// 只在本地读取目录层级；向 AI 提供末级名称或修图目录的直接父级名称，不发送完整路径。
export function directoryName(path) {
  return typeof path === 'string' ? path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || '' : '';
}

// 与图库默认“修图”关键词及导入子目录约定一致；其余明确编辑名称只作精确匹配。
function isEditingDirectory(name) {
  const normalized = name.normalize('NFKC').trim().toLowerCase();
  return normalized.includes('修图') || ['精修', '修片', '后期', 'edited', 'edits', 'retouched', 'retouch'].includes(normalized);
}

// 完整年月日必须是真实公历日期，不用当前年份补全，也不把无效日期自动滚到下一月。
function calendarDate(year, month, day) {
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1000 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) return '';
  return String(y) + String(m).padStart(2, '0') + String(d).padStart(2, '0');
}

// 解析目录名中唯一的完整拍照日期；支持连续数字、年/月/日文字及一致的 - . _ 分隔。
export function dateTag(name = '') {
  if (typeof name !== 'string') return '';
  const dates = new Set();
  const pattern = /(?<!\d)(?:(\d{4})(\d{2})(\d{2})|(\d{4})([-_.])(\d{1,2})\5(\d{1,2})|(\d{4})年(\d{1,2})月(\d{1,2})日?)(?!\d)/gu;
  for (const match of name.normalize('NFKC').matchAll(pattern)) {
    const value = match[1] ? calendarDate(match[1], match[2], match[3]) : match[4] ? calendarDate(match[4], match[6], match[7]) : calendarDate(match[8], match[9], match[10]);
    if (!value) return '';
    dates.add(value);
  }
  return dates.size === 1 ? '#' + [...dates][0] : '';
}

// 只对明确修图目录回退一层；普通目录或父级无日期时不继续搜索任意祖先。
export function directoryContext(path) {
  const parts = typeof path === 'string' ? path.replace(/\\/g, '/').split('/').filter(Boolean) : [];
  const leaf = parts.at(-1) || '';
  const name = isEditingDirectory(leaf) ? parts.at(-2) || '' : leaf;
  return {directoryName: name, dateTag: dateTag(name)};
}

// 图库 photoMetadata 原样保留 ImageIO 的扁平 EXIF 字段；只用原始拍摄时间，不用 TIFF/文件时间。
export function captureDateTag(photoMetadata) {
  if (typeof photoMetadata !== 'string') return '';
  try {
    const value = JSON.parse(photoMetadata)?.rawFields?.['{Exif}.DateTimeOriginal'];
    if (typeof value !== 'string') return '';
    const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/.exec(value.trim());
    if (!match || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) return '';
    const date = calendarDate(match[1], match[2], match[3]);
    // 日期属于照片拍摄地的日历，不按 OffsetTimeOriginal 或机器时区转换到另一天。
    return date ? '#' + date : '';
  } catch { return ''; }
}

// 只保留必要的目录线索与标签；shootDate 可能来自文件创建时间，不可当作原始拍摄证据。
export function photoContext(asset) {
  const context = directoryContext(asset?.directoryPath);
  return {...context, dateTag: captureDateTag(asset?.photoMetadata) || context.dateTag};
}

// 末尾日期只采用本地已解析的拍照日期；没有依据时移除模型猜测，保留无日期正文。
export function withDateTag(description, tag = '') {
  if (typeof tag !== 'string' || tag !== '' && (!/^#\d{8}$/.test(tag) || dateTag(tag) !== tag)) throw Error('拍照日期格式无效，请检查首图目录。');
  const text = description.trim().replace(/(?:\s*#(?:时间：#)?\d{8})+$/u, '').trimEnd();
  const result = tag ? text + '\n' + tag : text;
  if (result.length > 1000) throw Error('生成的描述过长，无法添加日期，请缩短提示词中的篇幅要求后重试。');
  return result;
}

// 固定首行话题与拍照日期由插件补齐；模型已写过的完整品牌话题只保留一次。
export function withPublicationTags(description, tag = '') {
  const body = withDateTag(description, '').replace(/(?<![\p{L}\p{N}\p{M}_#@\u200c\u200d])#有序图库(?![\p{L}\p{N}\p{M}_#@\u200c\u200d])/gu, '').trim();
  return withDateTag('#有序图库' + (body ? '\n' + body : ''), tag);
}
