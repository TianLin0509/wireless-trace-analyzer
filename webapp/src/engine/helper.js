// 本机助手：一个只监听 127.0.0.1 的小程序（public/helper/trace_helper.py），让网页能按粘贴的路径直接读本机 / 网络盘上的 Trace。
// 浏览器本身不允许网页按路径读文件；数据由助手在本机传给浏览器，不经过任何外部服务器。
import { describeFile } from './scan.js';

export const HELPER_URL = 'http://127.0.0.1:17861';
export const HELPER_DOWNLOAD = '/helper/trace_helper.py';

const opts = (extra = {}) => ({ cache: 'no-store', targetAddressSpace: 'loopback', ...extra });

async function failText(res) {
  try { return (await res.json()).error || `HTTP ${res.status}`; } catch { return `HTTP ${res.status}`; }
}

/** 助手在运行时返回 { version }，否则 null（未启动、被浏览器拦截或超时）。 */
export async function pingHelper(timeoutMs = 1500) {
  try {
    const res = await fetch(`${HELPER_URL}/ping`, opts({ signal: AbortSignal.timeout(timeoutMs) }));
    if (!res.ok) return null;
    const j = await res.json();
    return j?.name === 'trace-helper' ? j : null;
  } catch {
    return null;
  }
}

/** 让助手扫描粘贴的文件夹，结果格式与“选择文件夹”一致。 */
export async function scanPath(path) {
  let res;
  try {
    res = await fetch(`${HELPER_URL}/scan?path=${encodeURIComponent(path)}`, opts());
  } catch {
    throw new Error('连不上本机助手（可能已关闭）。请重新运行 trace_helper.py 后再试。');
  }
  if (!res.ok) throw new Error(await failText(res));
  const j = await res.json();
  const rootId = `${j.root}#p`;
  const files = [];
  for (const f of j.files) {
    const d = describeFile({ relPath: f.rel, size: f.size, lastModified: f.mtime, rootId, ref: { helper: { root: j.root, rel: f.rel } } });
    if (d) files.push(d);
  }
  return { rootName: j.rootName, files, truncated: j.truncated, fullPath: j.root, seconds: j.seconds };
}

const fileUrl = (h) => `${HELPER_URL}/file?root=${encodeURIComponent(h.root)}&rel=${encodeURIComponent(h.rel)}`;

/** 只取文件开头一段（预检表头用），返回一个能 slice、带真实 size 的对象。 */
export async function helperHead(desc, bytes) {
  const res = await fetch(fileUrl(desc.ref.helper), opts({ headers: { Range: `bytes=0-${bytes - 1}` } }));
  if (!res.ok) throw new Error(`读取 ${desc.name} 失败：${await failText(res)}`);
  const blob = await res.blob();
  const size = Number(res.headers.get('X-File-Size')) || desc.size;
  return { name: desc.name, size, slice: (a, b) => blob.slice(a, b) };
}

/** 读取整个文件（网络盘上可能需要一些时间），onProgress(0..1)。数据直接进浏览器的文件缓存，不占页面内存。 */
export async function helperFile(desc, onProgress) {
  const res = await fetch(fileUrl(desc.ref.helper), opts());
  if (!res.ok) throw new Error(`读取 ${desc.name} 失败：${await failText(res)}`);
  const total = Number(res.headers.get('Content-Length')) || desc.size || 0;
  let blob;
  if (res.body && onProgress && total) {
    const [a, b] = res.body.tee();
    const counting = (async () => {
      const reader = b.getReader();
      let got = 0, last = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.byteLength;
        if (got - last > 4 * 1024 * 1024) { last = got; onProgress(Math.min(1, got / total)); }
      }
    })();
    [blob] = await Promise.all([new Response(a).blob(), counting]);
  } else {
    blob = await res.blob();
  }
  if (total && blob.size !== total) throw new Error(`读取 ${desc.name} 不完整（${blob.size}/${total} 字节），网络盘可能断开了，请重试。`);
  onProgress?.(1);
  return new File([blob], desc.name, { lastModified: desc.lastModified });
}
