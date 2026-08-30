const $ = (selector) => document.querySelector(selector);
const canvas = $('#patternCanvas');
const ctx = canvas.getContext('2d');
const sourceCanvas = document.createElement('canvas');
const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
let image = null, fileBaseName = '我的拼豆图纸', pixels = [], palette = [], ratioLocked = true, aspectRatio = 1, zoom = 1;

const namedColors = [
  ['樱桃红','#c84643'],['珊瑚橙','#ed6b4a'],['蜜桃','#f39a74'],['柠檬黄','#f2cb5d'],['焦糖','#bb8244'],['奶油','#f4e6be'],['草地绿','#73a970'],['薄荷绿','#95c9a2'],['湖水蓝','#54a6b9'],['天空蓝','#68a2cc'],['深海蓝','#42678d'],['薰衣草','#9a8ac1'],['葡萄紫','#715183'],['樱花粉','#eaa1b1'],['玫瑰粉','#ce6e8c'],['可可棕','#805946'],['浅咖','#b28b72'],['暖灰','#b3aea4'],['深灰','#666764'],['黑曜石','#292b2c'],['纯白','#f8f7f2']
];

function rgbToLab(r,g,b){
  let [x,y,z]=[r/255,g/255,b/255].map(v=>v>.04045?((v+.055)/1.055)**2.4:v/12.92);
  [x,y,z]=[(x*.4124+y*.3576+z*.1805)/.95047,(x*.2126+y*.7152+z*.0722), (x*.0193+y*.1192+z*.9505)/1.08883];
  [x,y,z]=[x,y,z].map(v=>v>.008856?v**(1/3):7.787*v+16/116); return [116*y-16,500*(x-y),200*(y-z)];
}
function labDistance(a,b){return Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);}
function hexRgb(hex){return [parseInt(hex.slice(1,3),16),parseInt(hex.slice(3,5),16),parseInt(hex.slice(5,7),16)];}
function nearestNamedColor(hex){ const lab=rgbToLab(...hexRgb(hex)); return namedColors.reduce((best,item)=>labDistance(lab,rgbToLab(...hexRgb(item[1])))<best.d?{...item,d:labDistance(lab,rgbToLab(...hexRgb(item[1])))}:best,{d:Infinity})[0]; }

function setImage(file) {
  if (!file || !file.type.startsWith('image/')) return showToast('请选择一张图片文件');
  const reader = new FileReader(); reader.onload = e => { image = new Image(); image.onload = () => { fileBaseName = file.name.replace(/\.[^.]+$/, '') || '我的拼豆图纸'; aspectRatio = image.width / image.height; $('#sourcePreview').src = e.target.result; $('#fileName').textContent = file.name; setLongestEdge(selectedSize()); $('#emptyState').classList.add('hidden'); $('#workspace').classList.remove('hidden'); generate(); }; image.src=e.target.result; }; reader.readAsDataURL(file);
}
function selectedSize(){ return {small:30,medium:50,large:80}[document.querySelector('.size-option.selected').dataset.size]; }
function setLongestEdge(longestEdge){
  if (aspectRatio >= 1) { $('#gridWidth').value = longestEdge; $('#gridHeight').value = Math.max(5, Math.round(longestEdge / aspectRatio)); }
  else { $('#gridHeight').value = longestEdge; $('#gridWidth').value = Math.max(5, Math.round(longestEdge * aspectRatio)); }
}
function fitSource(w,h){
  sourceCanvas.width=w; sourceCanvas.height=h;
  // 用“完整放入 + 安全边距”而不是裁切：贴边的原图主体也不会显得越出画板。
  sourceCtx.fillStyle='#ffffff'; sourceCtx.fillRect(0,0,w,h);
  const inset=Math.min(Math.floor(Math.min(w,h)/2)-1,Math.max(2,Math.round(Math.min(w,h)*.03)));
  const availableW=w-inset*2,availableH=h-inset*2;
  const scale=Math.min(availableW/image.width,availableH/image.height), drawW=image.width*scale, drawH=image.height*scale;
  sourceCtx.drawImage(image,(w-drawW)/2,(h-drawH)/2,drawW,drawH);
}
function buildPalette(data, count){
  // 先把相近颜色合并为色块，再按“出现频率 × 色彩差异”选种子。
  // 这样大面积的白色背景只占一个色位，不会挤掉 Logo 里的红、蓝等关键颜色。
  const buckets=new Map(); let lightPixels=0;
  for(let i=0;i<data.length;i+=12){
    if(data[i+3]<129)continue; const r=data[i],g=data[i+1],b=data[i+2];
    if(r>238&&g>238&&b>238){lightPixels++;continue;}
    const key=`${r>>4},${g>>4},${b>>4}`,item=buckets.get(key)||{sum:[0,0,0],n:0};
    item.sum[0]+=r;item.sum[1]+=g;item.sum[2]+=b;item.n++;buckets.set(key,item);
  }
  const colors=[...buckets.values()].map(item=>({rgb:item.sum.map(v=>v/item.n),n:item.n}));
  if(!colors.length)return ['#ffffff'];
  const centers=lightPixels?[[255,255,255]]:[]; const needed=Math.max(1,count-centers.length);
  const sqDist=(a,b)=>(a[0]-b[0])**2+(a[1]-b[1])**2+(a[2]-b[2])**2;
  while(centers.length<(lightPixels?count:needed)&&centers.length<colors.length+(lightPixels?1:0)){
    let winner=null,bestScore=-1; for(const color of colors){const nearest=centers.length?Math.min(...centers.map(c=>sqDist(color.rgb,c))):1;const score=color.n*nearest;if(score>bestScore){bestScore=score;winner=color}}
    if(!winner)break; centers.push([...winner.rgb]);
  }
  // 用带权重的 k-means 收敛到真实颜色；每个色块按出现次数参与计算。
  for(let iter=0;iter<10;iter++){const groups=centers.map(()=>({sum:[0,0,0],n:0}));for(const color of colors){let best=0,distance=Infinity;centers.forEach((center,i)=>{const d=sqDist(color.rgb,center);if(d<distance){distance=d;best=i}});const group=groups[best];group.n+=color.n;group.sum[0]+=color.rgb[0]*color.n;group.sum[1]+=color.rgb[1]*color.n;group.sum[2]+=color.rgb[2]*color.n}groups.forEach((group,i)=>{if(group.n&&!(lightPixels&&i===0))centers[i]=group.sum.map(v=>Math.round(v/group.n))})}
  return centers.map(c=>'#'+c.map(v=>Math.round(v).toString(16).padStart(2,'0')).join(''));
}
function generate(){
  if(!image)return; let w=clamp(+$('#gridWidth').value,5,500),h=clamp(+$('#gridHeight').value,5,500); $('#gridWidth').value=w;$('#gridHeight').value=h; fitSource(w,h); const data=sourceCtx.getImageData(0,0,w,h).data;
  palette=buildPalette(data,+$('#colorCount').value); pixels=[];
  for(let i=0;i<data.length;i+=4){if(data[i+3]<129){pixels.push(-1);continue}const p=[data[i],data[i+1],data[i+2]],idx=palette.reduce((best,hex,n)=>{const c=hexRgb(hex),d=(p[0]-c[0])**2+(p[1]-c[1])**2+(p[2]-c[2])**2;return d<best.d?{n,d}:best},{n:0,d:Infinity}).n;pixels.push(idx)} render(); updateMaterials(); updateInfo();
}
function clamp(n,min,max){return Math.min(max,Math.max(min,Number.isFinite(n)?n:min));}
function render(){ const w=+$('#gridWidth').value,h=+$('#gridHeight').value; const scale=Math.max(5,Math.floor(900/Math.max(w,h)));canvas.width=w*scale;canvas.height=h*scale;ctx.imageSmoothingEnabled=false;ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height); const lines=$('#gridLines').checked,numbers=$('#numbers').checked; pixels.forEach((idx,i)=>{const x=(i%w)*scale,y=Math.floor(i/w)*scale;if(idx>=0){ctx.fillStyle=palette[idx];ctx.fillRect(x,y,scale,scale);if(numbers&&scale>=13){ctx.fillStyle=contrast(palette[idx]);ctx.font=`${Math.max(7,Math.floor(scale*.42))}px ${getComputedStyle(document.documentElement).getPropertyValue('--mono')}`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(idx+1,x+scale/2,y+scale/2+1)}}if(lines){ctx.strokeStyle=idx<0?'#d7d0c5':'#fff8';ctx.lineWidth=Math.max(.5,scale*.025);ctx.strokeRect(x,y,scale,scale)}}); canvas.style.width=`${Math.min(100,zoom*100)}%`;canvas.style.height='auto'; }
function contrast(hex){const [r,g,b]=hexRgb(hex);return (r*299+g*587+b*114)/1000>145?'#242320':'#fff';}
function updateMaterials(){const counts=palette.map((_,i)=>pixels.filter(x=>x===i).length);const list=$('#paletteList');list.innerHTML=''; palette.map((hex,i)=>({hex,i,n:counts[i]})).filter(x=>x.n).sort((a,b)=>b.n-a.n).forEach(({hex,i,n})=>{const li=document.createElement('li');li.innerHTML=`<span class="swatch" style="background:${hex}"></span><span><b>${i+1}. ${nearestNamedColor(hex)}</b><span class="color-name">${hex.toUpperCase()}</span></span><span class="count">${n} 颗</span>`;list.appendChild(li)});$('#totalBeads').textContent=`${counts.reduce((sum,n)=>sum+n,0).toLocaleString()} 颗`;}
function updateInfo(){const w=+$('#gridWidth').value,h=+$('#gridHeight').value;$('#physicalSize').textContent=`${(w*.5).toFixed(w%2?'.1f':'0')} × ${(h*.5).toFixed(h%2?'.1f':'0')} cm`;$('#colorValue').textContent=`${$('#colorCount').value} 色`;$('#patternTitle').textContent=fileBaseName;const bx=Math.ceil(w/29),by=Math.ceil(h/29);$('#boardEstimate').textContent=`${bx*by} 块（${bx} × ${by}）`;}
function tileDataUrl(startX,startY){
  const w=+$('#gridWidth').value,h=+$('#gridHeight').value,cols=Math.min(25,w-startX),rows=Math.min(25,h-startY),scale=18;
  const page=document.createElement('canvas'),pctx=page.getContext('2d');page.width=cols*scale;page.height=rows*scale;pctx.fillStyle='#fff';pctx.fillRect(0,0,page.width,page.height);
  for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){const idx=pixels[(startY+y)*w+startX+x],px=x*scale,py=y*scale;if(idx>=0){pctx.fillStyle=palette[idx];pctx.fillRect(px,py,scale,scale);pctx.fillStyle=contrast(palette[idx]);pctx.font='8px monospace';pctx.textAlign='center';pctx.textBaseline='middle';pctx.fillText(idx+1,px+scale/2,py+scale/2+1)}pctx.strokeStyle=idx<0?'#d7d0c5':'#ffffff';pctx.strokeRect(px,py,scale,scale)}
  return page.toDataURL('image/png');
}
function printTiledPattern(){
  const w=+$('#gridWidth').value,h=+$('#gridHeight').value,pages=[];for(let y=0;y<h;y+=25)for(let x=0;x<w;x+=25)pages.push({x,y,url:tileDataUrl(x,y)});
  const colors=palette.map((hex,i)=>({hex,i,n:pixels.filter(x=>x===i).length})).filter(x=>x.n).sort((a,b)=>b.n-a.n);
  const safe=fileBaseName.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const win=window.open('','_blank');if(!win){showToast('浏览器拦截了打印窗口，请允许弹出窗口');return}win.document.write(`<!doctype html><title>${safe} · 拼豆图纸</title><style>@page{size:A4;margin:12mm}body{font-family:Arial,"Noto Sans SC",sans-serif;color:#222}.cover,.page{break-after:page}.page{display:grid;place-items:center;min-height:260mm}.page h2{width:100%;font-size:14px}.page img{max-width:174mm;max-height:240mm;image-rendering:pixelated;border:1px solid #aaa}.key{columns:2;list-style:none;padding:0}.key li{margin:6px 0;font-size:12px}.sw{display:inline-block;width:12px;height:12px;border-radius:50%;vertical-align:-1px;margin-right:6px;border:1px solid #999}</style><section class="cover"><h1>${safe}</h1><p>图纸：${w} × ${h} 格 · 共 ${pixels.filter(x=>x>=0).length.toLocaleString()} 颗 · 每页 25 × 25 格</p><h2>材料清单</h2><ul class="key">${colors.map(c=>`<li><i class="sw" style="background:${c.hex}"></i>${c.i+1}. ${nearestNamedColor(c.hex)}　${c.n} 颗</li>`).join('')}</ul></section>${pages.map((p,i)=>`<section class="page"><h2>第 ${i+1} 页 · 列 ${p.x+1}–${Math.min(p.x+25,w)}，行 ${p.y+1}–${Math.min(p.y+25,h)}</h2><img src="${p.url}" /></section>`).join('')}<script>onload=()=>print()</script>`);win.document.close();}
function showToast(message){const el=$('#toast');el.textContent=message;el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2200)}

$('#fileInput').addEventListener('change',e=>setImage(e.target.files[0]));$('#newImage').onclick=()=>$('#fileInput').click();$('#cropButton').onclick=()=>showToast('图纸会自动居中裁切为当前比例');$('#generate').onclick=generate;
['dragenter','dragover'].forEach(type=>$('#dropZone').addEventListener(type,e=>{e.preventDefault();$('#dropZone').classList.add('dragging')}));['dragleave','drop'].forEach(type=>$('#dropZone').addEventListener(type,e=>{e.preventDefault();$('#dropZone').classList.remove('dragging')}));$('#dropZone').addEventListener('drop',e=>setImage(e.dataTransfer.files[0]));$('#dropZone').addEventListener('click',()=>$('#fileInput').click());$('#dropZone').addEventListener('keydown',e=>{if(e.key==='Enter')$('#fileInput').click()});
document.querySelectorAll('.size-option').forEach(b=>b.onclick=()=>{document.querySelector('.size-option.selected').classList.remove('selected');b.classList.add('selected');setLongestEdge(selectedSize());generate()}); $('#colorCount').oninput=()=>{updateInfo();generate()}; $('#gridLines').onchange=render;$('#numbers').onchange=render;
$('#gridWidth').onchange=e=>{if(ratioLocked)$('#gridHeight').value=Math.max(5,Math.round(e.target.value/aspectRatio));generate()};$('#gridHeight').onchange=e=>{if(ratioLocked)$('#gridWidth').value=Math.max(5,Math.round(e.target.value*aspectRatio));generate()};$('#lockRatio').onclick=()=>{ratioLocked=!ratioLocked;$('#lockRatio').classList.toggle('active',ratioLocked);showToast(ratioLocked?'已锁定原图比例':'已解除比例锁定')};$('#lockRatio').classList.add('active');
$('#zoomIn').onclick=()=>{zoom=Math.min(1.5,zoom+.1);$('#zoomPercent').textContent=`${Math.round(zoom*100)}%`;render()};$('#zoomOut').onclick=()=>{zoom=Math.max(.5,zoom-.1);$('#zoomPercent').textContent=`${Math.round(zoom*100)}%`;render()};$('#downloadPng').onclick=()=>{const link=document.createElement('a');link.download=`${fileBaseName}-拼豆图纸.png`;link.href=canvas.toDataURL('image/png');link.click();showToast('图纸已下载')};$('#printPattern').onclick=printTiledPattern;
