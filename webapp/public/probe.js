let speed=null;const caps=[];const row=(k,v,cls)=>caps.push(`<tr><td>${k}</td><td class="${cls||''}">${v}</td></tr>`);
const ua=navigator.userAgent;const m=ua.match(/(Edg|Chrome)\/(\d+)/);const ver=m?+m[2]:0;
row('浏览器',m?`${m[1]==='Edg'?'Edge':'Chrome'} ${ver}`:ua.slice(0,80),ver>=110?'ok':'bad');
const hasDir='showDirectoryPicker' in window;row('选择文件夹（File System Access）',hasDir?'支持':'不支持（将退回上传框方式，仍在本机读取）',hasDir?'ok':'warn');
const hasWasm=typeof WebAssembly==='object';row('WebAssembly（计算引擎）',hasWasm?'支持':'不支持',hasWasm?'ok':'bad');
let simd=false;try{simd=WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11]))}catch(e){}
row('WASM SIMD（加速）',simd?'支持':'不支持',simd?'ok':'warn');
const hasOpfs=!!(navigator.storage&&navigator.storage.getDirectory);row('浏览器本地私有存储（OPFS）',hasOpfs?'支持':'不支持',hasOpfs?'ok':'warn');
row('设备内存（浏览器报告，上限 8GB）',navigator.deviceMemory?navigator.deviceMemory+' GB':'未知',(navigator.deviceMemory||8)>=8?'ok':'warn');
row('CPU 逻辑核数',navigator.hardwareConcurrency||'未知','');
row('页面来源',location.protocol+'//'+location.host,location.protocol==='https:'?'ok':'warn');
if(navigator.storage&&navigator.storage.estimate){navigator.storage.estimate().then(e=>{row('可用浏览器存储配额',(e.quota/1024**3).toFixed(1)+' GB',e.quota>5*1024**3?'ok':'warn');render()})}
function render(){document.getElementById('caps').innerHTML=caps.join('');verdict()}
render();
function verdict(){const v=document.getElementById('verdict');
 if(!hasWasm||ver<110&&m){v.className='verdict bad';v.textContent='浏览器版本过旧或不支持 WebAssembly，需要升级 Chrome / Edge。';return}
 if(speed===null){v.className='verdict';v.textContent='浏览器能力满足要求，请完成第 2 步测速。';return}
 v.className='verdict '+(speed>=40?'ok':'warn');v.textContent=speed>=40?`可以使用新版：本机读取速度 ${speed.toFixed(0)} MB/s。`:`可以使用，但读取较慢（${speed.toFixed(0)} MB/s），大文件可能要等一两分钟。`}
async function walk(dir,out,path,depth){for await(const [name,h] of dir.entries()){if(h.kind==='file'&&/\.csv$/i.test(name))out.push({h,path:path+name});else if(h.kind==='directory'&&depth<8)await walk(h,out,path+name+'/',depth+1);if(out.length>5000)return}}
async function measure(file,onp){const t0=performance.now();let n=0,lines=0;const r=file.stream().getReader();for(;;){const {done,value}=await r.read();if(done)break;n+=value.length;for(let i=0;i<value.length;i++)if(value[i]===10)lines++;onp(n/file.size)}return {sec:(performance.now()-t0)/1000,lines}}
document.getElementById('pick').onclick=async()=>{const res=document.getElementById('pickRes');let files=[];
 try{if(hasDir){const d=await showDirectoryPicker();res.innerHTML='正在扫描…';await walk(d,files,d.name+'/',0)}else{const inp=document.createElement('input');inp.type='file';inp.webkitdirectory=true;await new Promise(ok=>{inp.onchange=ok;inp.click()});files=[...inp.files].filter(f=>/\.csv$/i.test(f.name)).map(f=>({file:f,path:f.webkitRelativePath}))}}catch(e){res.innerHTML=`<span class="bad">未选择或无权限：${e.message}</span>`;return}
 const traced=files.filter(f=>/Dest_T(396|537|714)_/i.test(f.path));
 if(!files.length){res.innerHTML='<span class="bad">没有找到 CSV 文件。</span>';return}
 for(const f of files)if(!f.file)f.file=await f.h.getFile();
 const big=files.sort((a,b)=>b.file.size-a.file.size)[0];
 res.innerHTML=`找到 ${files.length} 个 CSV（其中 T396/537/714 共 ${traced.length} 个）。正在读取最大的文件 <b>${big.path}</b>（${(big.file.size/1024**2).toFixed(0)} MB）…<div class="bar"><i id="pb"></i></div>`;
 const head=await big.file.slice(0,65536).text();const cols=(head.split(/\r?\n/)[0]||'').split(',').length;
 const r=await measure(big.file,p=>document.getElementById('pb').style.width=(p*100).toFixed(1)+'%');
 speed=big.file.size/1024**2/r.sec;
 res.innerHTML+=`<table><tr><td>文件</td><td>${big.path}</td></tr><tr><td>大小 / 行数 / 列数</td><td>${(big.file.size/1024**2).toFixed(0)} MB / ${r.lines.toLocaleString()} 行 / ${cols} 列</td></tr><tr><td>纯读取耗时</td><td class="ok">${r.sec.toFixed(1)} 秒（${speed.toFixed(0)} MB/s）</td></tr></table><p class="note">这只测“把文件从磁盘或网络盘读进浏览器”的速度；正式分析还要解析和计算，实测约再多 2–3 倍时间。</p>`;
 verdict()};
