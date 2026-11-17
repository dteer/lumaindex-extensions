// 从输入中提取明确出现的城市名；短名仅去掉“市”，不推断景点所属城市。
export function matchCity(text,cities){
 const matches=[];
 for(const city of cities){
  const aliases=[city.name];
  if(city.name.endsWith('市'))aliases.push(city.name.slice(0,-1));
  for(const alias of aliases){
   let start=text.indexOf(alias);
   while(start>=0){matches.push({city,start,end:start+alias.length});start=text.indexOf(alias,start+alias.length);}
  }
 }
 // 完整长名称优先，避免“海口市”与短名重复，或长城市名包含其他短城市名。
 const kept=matches.filter(m=>!matches.some(n=>n.start<=m.start&&n.end>=m.end&&n.end-n.start>m.end-m.start));
 const candidates=[...new Map(kept.map(m=>[m.city.code,m.city])).values()];
 if(candidates.length!==1)return {candidates,keyword:text.trim()};
 const selected=kept.find(m=>m.city.code===candidates[0].code);
 return {candidates,city:candidates[0],keyword:(text.slice(0,selected.start)+' '+text.slice(selected.end)).trim()};
}
