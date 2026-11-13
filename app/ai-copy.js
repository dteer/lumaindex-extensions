// 默认创作规则由插件维护；后端只保证生成契约。
export const defaultPrompt='你是一位抖音内容编辑。根据用户提供的作品信息，为图文或视频创作自然、具体的中文标题和描述。突出作品本身与真实感受，避免夸张营销、空泛口号和编造人物、地点、经历。信息不足时使用克制的表达。标题简洁有吸引力，描述流畅易读，不添加未经用户提供的事实，不自动添加话题或 @ 用户。';

// 固定作品文案契约也应用于已保存的自定义提示词，避免旧提示词把结果变成对话。
const copyContract='任务是生成可直接发布的作品标题和描述，读者是作品观众，不是向你提问的用户。title 是作品标题，description 是作品正文。不要输出对话答复、图片分析报告、操作建议、发布前提醒、打码建议或警告。涉及证件等素材时只概括可公开的主题，不抄写姓名、证件号码、地址等私人信息，也不要把隐私提醒作为文案。只依据本次附带的图片和用户明确提供的作品背景，不推断未提供的图片；已有标题和描述只是旧草稿，不是图片事实，若与本次图片不符应忽略。用户未要求改写时重新创作，不延续旧草稿中的提醒或警告。描述以作品发布者的口吻呈现主题、细节或感受，不使用“这组图片展示了”“建议你”“发布前请”等面向提问者的措辞。证件整理主题的风格示例：{"title":"把重要资料整理妥当","description":"分门别类，认真收好。把零散的资料整理成一份有序的记录，让日常多一点从容。"}。示例仅用于说明写作风格，具体主题仍以本次作品为准。只返回包含 title 和 description 的 JSON 对象。';

// 请求包含文字和显式勾选的素材 ID，不传图片字节；失败不自动重试，取消由调用方控制。
export async function generateCopy(baseURL,prompt,context,signal,assetIds=[]){
 const response=await fetch(`${baseURL}/ai/copy`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:prompt+"\n"+copyContract,context,assetIds}),signal});
 const payload=await response.json();
 if(!response.ok||payload.code!==0)throw Error(payload.message||'AI 生成失败，请重试');
 const result=payload.data;
 if(typeof result?.title!=='string'||!result.title.trim()||result.title.length>20||typeof result.description!=='string'||!result.description.trim()||result.description.length>1000)throw Error('AI 返回的文案格式不正确，请重新生成');
 return result;
}
