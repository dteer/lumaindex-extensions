// 仅提取首图当前所在目录的末级名称，不向模型发送完整本地路径。
export function directoryName(path){return typeof path==='string'?path.replace(/\\/g,'/').split('/').filter(Boolean).at(-1)||'':'';}
// 使用本机当天日期，避免 UTC 跨日导致日期偏移。
export function dateTag(date=new Date()){return '#'+date.getFullYear()+String(date.getMonth()+1).padStart(2,'0')+String(date.getDate()).padStart(2,'0');}
// 日期由本地确定性追加；去除模型重复生成的末尾日期，不截断正文。
export function withDateTag(description,tag){
 const text=description.trim().replace(/(?:\s*#(?:时间：#)?\d{8})+$/u,'').trimEnd();
 const result=text+'\n'+tag;
 if(result.length>1000)throw Error('生成的描述过长，无法添加日期，请缩短提示词中的篇幅要求后重试。');
 return result;
}
