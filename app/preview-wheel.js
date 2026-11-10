// 累积细小滚动；同向切换限制频率，反向手势无需等待惯性结束。
export function createPreviewWheel(){
 let total=0,lastEvent=-Infinity,lastStep=-Infinity,direction=0;
 return (pixels,now)=>{
  if(!Number.isFinite(pixels)||pixels===0)return 0;
  const nextDirection=Math.sign(pixels),reversed=direction!==0&&nextDirection!==direction;
  if(now-lastEvent>160||reversed)total=0;
  if(reversed)lastStep=-Infinity;
  direction=nextDirection;lastEvent=now;
  // 忽略惯性尾部的极小位移，冷却期间不积攒下一次翻页。
  if(Math.abs(pixels)<1.5||now-lastStep<360)return 0;
  total+=pixels;
  if(Math.abs(total)<35)return 0;
  total=0;lastStep=now;return direction;
 };
}
