// openStore 只暂存本次文件交接；数据库关闭后不持有文件句柄。
function openStore(){
 return new Promise((resolve,reject)=>{
  const request=indexedDB.open('luma-transfer',1);
  request.onupgradeneeded=()=>request.result.createObjectStore('files');
  request.onsuccess=()=>{const db=request.result;db.onversionchange=()=>db.close();resolve(db);};
  request.onerror=()=>reject(request.error||Error('图片暂存不可用'));
 });
}

// binaryStore 在事务提交后返回；take 原子取走已授权文件，put/prune 清理异常退出遗留的过期数据。
// get 只用于诊断，不能用于交接；过期或缺少有效期限的数据不会返回给调用方。
export async function binaryStore(mode,key,value){
 if(!['get','put','take','delete','prune'].includes(mode))throw Error('未知图片暂存操作');
 if(mode==='put'&&(!Array.isArray(value?.files)||!Number.isFinite(value.expires)||value.expires<=Date.now()))throw Error('图片暂存已过期');
 const db=await openStore();
 try{return await new Promise((resolve,reject)=>{
  const tx=db.transaction('files',mode==='get'?'readonly':'readwrite'),store=tx.objectStore('files');
  let result;
  tx.oncomplete=()=>resolve(result);
  tx.onerror=()=>reject(tx.error||Error('图片暂存失败'));
  tx.onabort=()=>reject(tx.error||Error('图片暂存失败'));
  if(mode==='get'||mode==='take'){
   const request=store.get(key);
   request.onsuccess=()=>{
    const stored=request.result;
    if(stored&&Number.isFinite(stored.expires)&&stored.expires>Date.now())result=stored;
    // 只允许通过后台授权的 frame 调用 take；删除与读取共用事务，重放不能再次获取文件。
    if(mode==='take')store.delete(key);
   };
  }else if(mode==='delete')store.delete(key);
  else{
   // 新传输或后台启动时清理过期数据；游标只删除过期记录，不清除其他并行标签页的文件。
   const request=store.openCursor();
   request.onsuccess=()=>{
    const cursor=request.result;
    if(!cursor){if(mode==='put')store.put(value,key);return;}
    if(!Number.isFinite(cursor.value?.expires)||cursor.value.expires<=Date.now())cursor.delete();
    cursor.continue();
   };
  }
 });}finally{db.close();}
}
