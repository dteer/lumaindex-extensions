// 纯前端草稿模型：只保存素材身份和文字，不保存原图、视频、账号或上传凭据。
export const modes=['image','video'];
export const signature=draft=>JSON.stringify([draft.assetIDs,draft.title,draft.description,draft.settings]);
export function normalize(raw){
 const data={version:1,bindingID:typeof raw?.bindingID==='string'?raw.bindingID:crypto.randomUUID(),activeMode:'image',modes:{},handledTransfers:[]};
 if(raw?.version!==1)return data;
 data.activeMode=modes.includes(raw.activeMode)?raw.activeMode:'image';
 data.handledTransfers=Array.isArray(raw.handledTransfers)?raw.handledTransfers.filter(x=>typeof x==='string').slice(-50):[];
 for(const mode of modes){const d=raw.modes?.[mode];if(!d||!Array.isArray(d.assetIDs)||typeof d.title!=='string'||typeof d.description!=='string')continue;
  data.modes[mode]={assetIDs:[...new Set(d.assetIDs.filter(x=>typeof x==='string'))].slice(0,1000),settings:d.settings||{visibility:'public',download:'allow',publishTime:'now',scheduledAt:''},title:d.title.slice(0,20),description:d.description.slice(0,1000),savedSignature:typeof d.savedSignature==='string'?d.savedSignature:'',updatedAt:typeof d.updatedAt==='string'?d.updatedAt:''};
 }return data;
}
export class DraftStore{
 constructor(initial,write){this.data=normalize(initial);this.writer=write;this.pending=Promise.resolve();}
 // 所有写入按顺序执行；关闭等待最后一次确认，防止旧异步写覆盖新草稿。
 commit(){const snapshot=structuredClone(this.data);const task=this.pending.catch(()=>{}).then(()=>this.writer(snapshot));this.pending=task;return task;}
 update(mode,content){const previous=this.data.modes[mode];const next={assetIDs:[...content.assetIDs],settings:structuredClone(content.settings),title:content.title,description:content.description,savedSignature:previous?.savedSignature||'',updatedAt:previous?.updatedAt||''};
  if(previous&&signature(previous)===signature(next))return false;
  if(!previous&&!next.assetIDs.length&&!next.title&&!next.description)return false;
  next.updatedAt=new Date().toISOString();this.data.modes[mode]=next;return true;
 }
 dirty(){return modes.some(mode=>{const d=this.data.modes[mode];return d&&signature(d)!==d.savedSignature;});}
 async save(){const old=structuredClone(this.data);for(const mode of modes){const d=this.data.modes[mode];if(d)d.savedSignature=signature(d);}
  try{await this.commit();}catch(error){this.data=old;throw error;}
 }
 async remove(mode){const old=structuredClone(this.data);if(mode)delete this.data.modes[mode];else this.data.modes={};
  try{await this.commit();}catch(error){this.data=old;throw error;}
 }
 acceptTransfer(id){if(id)this.data.handledTransfers=[...this.data.handledTransfers.filter(x=>x!==id),id].slice(-50);}
}

// 原有素材顺序优先，新素材按带入顺序追加；相同素材 ID 只保留一份。
export function mergeDraftAssets(existing,incoming){
 const seen=new Set();
 return [...existing,...incoming].filter(asset=>{
  if(seen.has(asset.id))return false;
  seen.add(asset.id);return true;
 });
}
