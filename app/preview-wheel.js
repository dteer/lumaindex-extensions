// 原生触控板阶段精确界定一次手势，不用冷却时间猜测下一次手势。
export function createNativePreviewWheel(){
 let total=0,stepped=false,active=false;
 return event=>{
  if(event.momentum)return 0;
  if(event.began){total=0;stepped=false;active=true;}
  if(event.ended){active=false;return 0;}
  const delta=Math.abs(event.deltaX)>Math.abs(event.deltaY)?event.deltaX:event.deltaY;
  if(!Number.isFinite(delta)||delta===0)return 0;
  // 普通鼠标滚轮没有手势阶段，每个离散滚动事件可立即切一张。
  if(!event.phased)return Math.sign(delta);
  if(!active||stepped)return 0;
  if(Math.sign(delta)!==Math.sign(total))total=0;
  total+=delta;
  if(Math.abs(total)<10)return 0;
  stepped=true;return Math.sign(total);
 };
}

// 非原生宿主只能按事件间隙分组；macOS App 使用上面的原生阶段处理。
export function createPreviewWheel(){
 let total=0,lastEvent=-Infinity,stepped=false;
 return (pixels,now)=>{
  if(!Number.isFinite(pixels)||pixels===0)return 0;
  if(now-lastEvent>180){total=0;stepped=false;}
  lastEvent=now;
  if(stepped)return 0;
  if(Math.sign(total)!==Math.sign(pixels))total=0;
  total+=pixels;
  if(Math.abs(total)<35)return 0;
  stepped=true;return Math.sign(total);
 };
}
