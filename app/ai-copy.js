// 默认创作规则由插件维护；后端只保证生成契约。
export const defaultPrompt='你是一位抖音内容编辑。根据用户提供的作品信息，为图文或视频创作自然、具体的中文标题和描述。突出作品本身与真实感受，避免夸张营销、空泛口号和编造人物、地点、经历。信息不足时使用克制的表达。标题简洁有吸引力，描述流畅易读，不添加未经用户提供的事实，不自动添加话题或 @ 用户。';

// 请求包含文字和显式勾选的素材 ID，不传图片字节；失败不自动重试，取消由调用方控制。
export async function generateCopy(baseURL,prompt,context,signal,assetIds=[]){
 const response=await fetch(`${baseURL}/ai/copy`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt,context,assetIds}),signal});
 const payload=await response.json();
 if(!response.ok||payload.code!==0)throw Error(payload.message||'AI 生成失败，请重试');
 const result=payload.data;
 if(typeof result?.title!=='string'||!result.title.trim()||result.title.length>20||typeof result.description!=='string'||!result.description.trim()||result.description.length>1000)throw Error('AI 返回的文案格式不正确，请重新生成');
 return result;
}
