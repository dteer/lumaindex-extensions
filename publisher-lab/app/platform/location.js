// searchLocations 由插件通过宿主原生会话直接查询地点；登录会话由宿主携带，不调用页面组件。
export async function searchLocations(params, send){
 const origin='https://creator.douyin.com';const fetch=(value,options)=>send(new URL(value,origin).href,options);
 try{
  const url=new URL('/aweme/v1/life/video_api/search/poi/',origin);
  const values={count:10,from_webapp:1,get_current_loc:1,is_image_album_style:1,keywords:params.keyword,search_type:0,poi_anchor_tab:2,page:params.page,poi_mode:2,load_interest_city_type:1,selected_city_code:params.cityCode,selected_city_name:params.cityName,aid:1128};
  for(const [k,v] of Object.entries(values))url.searchParams.set(k,v);
  const response=await fetch(url,{credentials:'include',redirect:'error',signal:AbortSignal.timeout(12000)}),data=await response.json();
  if(!response.ok||data.status_code!==0)return {ok:false,error:'地点查询失败，请检查抖音登录状态后重试'};
  return {ok:true,data:{items:(data.poi_list||[]).map(x=>({id:x.poi_id,name:x.poi_name,address:x.address_info?.simple_addr||'',extra:JSON.stringify({...JSON.parse(x.anchor_post_ext?.anchor_content||'{}'),...(typeof x.is_commerce_intention==='boolean'?{is_commerce_intention:x.is_commerce_intention}:{})}),requiresNativeSelection:Boolean(x.trigger_key_user_block)})),nextPage:data.has_more?data.page:null}};
 }catch{return {ok:false,error:'地点查询超时或网络不可用，请重试'};}
}

// 校验所有跨页面参数，查询目标固定为抖音接口，不接受任意 URL 或脚本。
export function validateLocationQuery(p){
 if(!p||!/^\d{6}$/.test(p.cityCode)||typeof p.cityName!=='string'||!p.cityName||p.cityName.length>50||typeof p.keyword!=='string'||!p.keyword.trim()||p.keyword.length>100||!Number.isInteger(p.page)||p.page<1||p.page>100)throw Error('请选择城市并输入有效地点名称');
 return {cityCode:p.cityCode,cityName:p.cityName,keyword:p.keyword.trim(),page:p.page};
}
