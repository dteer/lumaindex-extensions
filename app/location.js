import {matchCity} from './city-match.js';
import {browserBridge} from './browser-bridge.js';
// 地点选择只保存城市和真实 POI 身份，查询失败不产生虚假的可选地点。
export function locationPicker({baseURL,getValue,setValue,getQuery=()=>'',setQuery=()=>{},changed}){
 const $=id=>document.getElementById(id),city=$('location-city'),query=$('location-query'),citiesBox=$('city-options'),box=$('location-options'),status=$('location-status');
 const bridge=browserBridge(baseURL);
 let cities=[],timer,controller,generation=0,next=1,loading=false,items=[],failed=false,confirmedQuery=null;
 const citiesReady=fetch(new URL('./cities.json',import.meta.url)).then(r=>r.json()).then(v=>cities=v).catch(()=>status.textContent='城市列表读取失败，请重新打开插件。');
 const close=()=>{citiesBox.hidden=true;box.hidden=true;};
 // 切换模式、城市或查询词时取消旧请求，防止旧结果覆盖新草稿。
 function cancel(){clearTimeout(timer);controller?.abort();generation++;loading=false;}
 function render(){cancel();items=[];next=1;failed=false;const v=getValue();city.value=v?.cityName||'';query.value=v?.name||getQuery();query.disabled=false;confirmedQuery=null;close();status.textContent='';}
 function cityOptions(){
  citiesBox.replaceChildren();citiesBox.hidden=false;box.hidden=true;
  for(const c of cities.filter(x=>x.name.includes(city.value.trim()))){
   const b=document.createElement('button');b.type='button';b.textContent=c.name;
   b.onclick=()=>{const text=query.value;cancel();setValue({cityCode:c.code,cityName:c.name});render();query.value=text;confirmedQuery=text;query.focus();changed();load();};citiesBox.append(b);
  }
 }
 city.onfocus=()=>{city.select();cityOptions();};city.oninput=cityOptions;
 city.onkeydown=e=>{if(e.key==='Escape'){close();city.value=getValue()?.cityName||'';}};
 function draw(){
  box.replaceChildren();box.hidden=false;
  for(const item of items){const b=document.createElement('button');b.type='button';b.textContent=item.name;const a=document.createElement('small');a.textContent=item.address;b.append(a);
   b.onclick=()=>{setValue({...getValue(),...item});render();changed();};box.append(b);}
  if(loading||(!items.length&&!failed)){const p=document.createElement('div');p.className='location-empty';p.textContent=loading?'正在搜索…':'未找到相关位置';box.append(p);}
  if(failed){const b=document.createElement('button');b.textContent='重试搜索';b.onclick=()=>load();box.append(b);}
 }
 async function load(){
  if(loading||next===null)return;
  const before=generation;await citiesReady;if(before!==generation||loading)return;
  let v=getValue(),keyword=query.value.trim();if(!keyword)return;
  // 用户手动选择城市后尊重该选择；只有再次修改地点输入才重新识别。
  if(confirmedQuery!==query.value){
   const match=matchCity(keyword,cities);
   if(match.candidates.length>1){status.textContent='输入包含多个城市，请先选择要搜索的城市。';close();return;}
   if(match.city){
    keyword=match.keyword;
    if(v?.cityCode!==match.city.code){v={cityCode:match.city.code,cityName:match.city.name};setValue(v);city.value=v.cityName;changed();}
   }
  }
  if(!v?.cityCode){status.textContent='未识别到城市，请选择城市，或输入“杭州西湖”这样的城市和地点名称。';close();return;}
  if(!keyword){status.textContent='已识别城市，请继续输入地点名称。';close();return;}
  const version=generation;loading=true;failed=false;controller=new AbortController();draw();
  try{
   const page=await bridge.request({cityCode:v.cityCode,cityName:v.cityName,keyword,page:next},controller.signal);
   if(version!==generation)return;
   items.push(...page.items.filter(x=>!items.some(y=>y.id===x.id)));next=page.nextPage??null;status.textContent='';
  }catch(e){if(version!==generation||e.name==='AbortError')return;failed=true;status.textContent=e.message;const url=bridge.connectionURL?.();if(url){const link=document.createElement('a');link.href=url;link.target='_blank';link.rel='noopener';link.textContent=' 连接 Chrome（手动打开）';status.append(link);}}
  finally{if(version===generation){loading=false;draw();}}
 }
 query.oninput=()=>{setQuery(query.value);cancel();const v=getValue();confirmedQuery=null;setValue(v?.cityCode?{cityCode:v.cityCode,cityName:v.cityName}:null);changed();items=[];next=1;failed=false;status.textContent='';close();timer=setTimeout(load,400);};
 query.onfocus=()=>{if(items.length)draw();};
 query.onkeydown=e=>{if(e.key==='Escape')close();if(e.key==='Enter'){e.preventDefault();clearTimeout(timer);load();}};
 box.onscroll=()=>{if(box.scrollHeight-box.scrollTop-box.clientHeight<box.clientHeight&&!failed)load();};
 $('location-clear').onclick=()=>{setQuery('');setValue(null);render();changed();};
 document.addEventListener('click',e=>{if(!$('location-picker').contains(e.target)){close();city.value=getValue()?.cityName||'';}});
 // 目录名仅作为查询词，真实 POI 由用户从查询结果确认。
 function seed(value){cancel();setValue(null);setQuery(value);render();query.value=value;changed();load();}
 return {render,seed};
}
