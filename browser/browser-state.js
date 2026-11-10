// reconcileBrowserState 记录浏览器实际资源与顺序；保留图库身份以便下次导入恢复缺失项。
export function reconcileBrowserState(saved,images,now=Date.now()){
 const before=saved.browser?.images||saved.assets.map((a,index)=>({uri:a.uri,index}));
 const ready=new Set(images.filter(x=>x.ready).map(x=>x.uri));
 const old=new Set(before.filter(x=>x.uri).map(x=>x.uri));
 const added=images.filter(x=>x.uri&&!old.has(x.uri)).map(x=>x.uri);
 const removed=before.filter(x=>x.uri&&!images.some(i=>i.uri===x.uri)).map(x=>x.uri);
 const order=images.map(x=>x.uri);
 const changed=JSON.stringify(before)!==JSON.stringify(images);
 const assets=saved.assets.map(a=>({...a,browserState:ready.has(a.uri)?'present':images.some(x=>x.uri===a.uri)?'uploading':'removed',browserIndex:images.findIndex(x=>x.uri===a.uri)}));
 // 保存最新快照和有限变化历史，不将浏览器删除写回 App 草稿。
 return {...saved,assets,browser:{images,updatedAt:now},changes:changed?[...(saved.changes||[]),{at:now,added,removed,order}].slice(-30):(saved.changes||[])};
}
