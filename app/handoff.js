'use strict';
try {
  const job=JSON.parse(decodeURIComponent(location.hash.slice(1)));
  if(job.version!==1 || !Array.isArray(job.assets) || !job.assets.length || job.assets.length>35 || typeof job.title!=='string'||typeof job.description!=='string')throw Error('交接数据无效，请从 App 重新带入');
  document.getElementById('summary').textContent=`本次 ${job.assets.length} 项素材：${job.assets.map(a=>a.name).join('、')}`;
  document.getElementById('title').value=job.title;document.getElementById('description').value=job.description;
  setTimeout(()=>{if(!document.documentElement.dataset.lumaExtension)document.getElementById('status').textContent='未检测到配套 Chrome 扩展。请安装扩展后刷新本页，或在已安装扩展的 Chrome 中打开此地址。';},1500);
}catch(error){document.getElementById('status').textContent=error.message;}
