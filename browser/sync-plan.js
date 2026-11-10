// planImages 以 App 完整快照规划增量同步，只比较素材身份、版本和已确认资源，不读取图片字节。
export function planImages(desired,previous,current){
 const byAsset=new Map(previous.map(image=>[image.assetID,image]));
 const desiredIDs=new Set(desired.map(asset=>asset.id));
 const removed=new Set(),claimed=new Set(),keep=[],add=[];
 // 同一服务端 URI 可能出现在多个卡片中；删除必须保留卡片身份，不能按 URI 去重。
 const markRemoved=image=>{if(image)removed.add(image);};
 for(const old of previous){
  if(!desiredIDs.has(old.assetID)){
   for(const image of current)if(image.uri&&image.uri===old.uri)markRemoved(image);
  }
 }
 for(const asset of desired){
  const old=byAsset.get(asset.id);
  let match;
  if(old&&old.revision===asset.revision&&old.uri){
   const candidates=current.filter(image=>image.uri===old.uri&&!claimed.has(image)&&(!image.assetID||(image.assetID===asset.id&&image.revision===asset.revision)));
   // 页面内身份能区分重复 URI；导航后身份失效时，只接受唯一的服务端资源卡片。
   const identified=old.imageID?candidates.filter(image=>image.id===old.imageID):[];
   if(identified.length===1)match=identified[0];
   else if(candidates.length===1)match=candidates[0];
  }else if(old&&old.revision!==asset.revision){
   for(const image of current)if(image.uri&&image.uri===old.uri)markRemoved(image);
  }
  if(!match?.ready){
   // 投递时在页面 WeakMap 注册的 File 身份可以恢复未写入最终映射的成功上传。
   // 同一素材和版本的多次投递是明确的重复资源，保留第一张就绪卡片并移除其余项。
   match=current.find(image=>!claimed.has(image)&&image.assetID===asset.id&&image.revision===asset.revision&&image.uri&&image.ready);
  }
  if(match?.ready&&match.uri){
   claimed.add(match);
   removed.delete(match);
   keep.push({assetID:asset.id,revision:asset.revision,name:asset.uploadName,uri:match.uri,...(match.id?{imageID:match.id}:{})});
  }else add.push(asset);
 }
 // 包括上传失败且无 URI 的卡片；不能让这些卡片被空字符串合并后漏删。
 for(const image of current)if(!claimed.has(image))markRemoved(image);
 const removeImages=[...removed];
 // remove 保留旧调用契约；涉及卡片删除与数量计算的调用方必须使用 removeImages。
 return {remove:[...new Set(removeImages.map(image=>image.uri).filter(Boolean))],removeImages,keep,add};
}

// pendingImageImports 返回当前快照中尚未确认成功的已投递素材；超时不代表网页上传已停止，不能据此重发。
// ready 必须来自已校验 URI 的素材映射（例如 planImages.keep），不能用同名网页文件充当确认。
export function pendingImageImports(inflight,desired,ready){
 if(!Array.isArray(inflight?.files))return [];
 return inflight.files.filter(file=>
  desired.some(asset=>asset.id===file.assetID&&asset.revision===file.revision)&&
  !ready.some(asset=>asset.assetID===file.assetID&&asset.revision===file.revision)
 );
}
