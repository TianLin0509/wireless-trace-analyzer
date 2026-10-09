// 已授权的总目录：浏览器不能按路径读盘，但用户在选择窗口里授权过一个总目录（如 \\100.100.97.83\cellDT）后，
// 网页拿到它的目录句柄，之后粘贴这个目录下的任何路径，都能沿着句柄逐级找到子目录直接读取，不再弹窗。
// 句柄与对应路径只存在本机浏览器（IndexedDB），不经过网络。
import { getKv, setKv } from '../persist.js';
import { normalizePastedPath } from './fs.js';

const KEY = 'authorized-roots';
let cache = null; // [{ path, handle, at }]

export async function loadRoots() {
  if (!cache) cache = (await getKv(KEY).catch(() => null)) || [];
  return cache;
}

export async function listRoots() {
  return [...(await loadRoots())].sort((a, b) => b.at - a.at);
}

export async function saveRoot(path, handle) {
  const p = normalizePastedPath(path);
  const roots = (await loadRoots()).filter((r) => r.path.toLowerCase() !== p.toLowerCase());
  roots.push({ path: p, handle, at: Date.now() });
  cache = roots;
  await setKv(KEY, roots).catch(() => {});
}

export async function forgetRoot(path) {
  cache = (await loadRoots()).filter((r) => r.path !== path);
  await setKv(KEY, cache).catch(() => {});
}

const splitPath = (p) => normalizePastedPath(p).split(/[\\/]/).filter(Boolean);

/** 找到包含该路径的已授权总目录（取最深的一个），返回 { root, rest: [剩余各级目录名] } 或 null。同步执行，便于在点击后立刻申请授权。 */
export function findRoot(path) {
  if (!cache) return null;
  const kind = (x) => (normalizePastedPath(x).startsWith('\\\\') ? 'unc' : 'local');
  const parts = splitPath(path);
  let best = null;
  for (const r of cache) {
    const rp = splitPath(r.path);
    if (kind(r.path) !== kind(path) || rp.length > parts.length) continue;
    if (rp.every((s, i) => s.toLowerCase() === parts[i].toLowerCase()) && (!best || rp.length > best.n)) best = { r, n: rp.length };
  }
  return best ? { root: best.r, rest: parts.slice(best.n) } : null;
}

/** 建议授权的总目录：网络路径取 \\服务器\共享；本地路径取盘符下第一级目录（盘符根目录浏览器不允许授权）。 */
export function suggestRoot(path) {
  const p = normalizePastedPath(path);
  if (p.startsWith('\\\\')) {
    const parts = p.slice(2).split('\\').filter(Boolean);
    return parts.length >= 2 ? `\\\\${parts[0]}\\${parts[1]}` : p;
  }
  const m = p.match(/^([a-zA-Z]:)\\([^\\]+)/);
  if (m) return `${m[1]}\\${m[2]}`;
  return p;
}

/** 句柄的读取授权：已授权直接返回；否则申请（需要在用户点击后尽快调用）。 */
export async function ensureRead(handle) {
  if (!handle?.queryPermission) return true;
  if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}

/** 仅查询，不自动触发授权弹窗。记住目录不等于权限永久有效。 */
export async function pathAccess(path) {
  if (!normalizePastedPath(path)) return { state: 'empty', text: '粘贴路径后解析；也可选择或拖入文件夹。' };
  await loadRoots();
  const hit = findRoot(path);
  if (!hit) return { state: 'first', text: '首次使用这个目录：解析时选择一次共享总目录。' };
  try {
    const permission = await hit.root.handle.queryPermission({ mode: 'read' });
    return permission === 'granted'
      ? { state: 'granted', text: `已授权 ${hit.root.path}：此路径可直接解析。` }
      : { state: 'renew', text: `已记住 ${hit.root.path}，需要重新授权。` };
  } catch {
    return { state: 'unavailable', text: '已记住的目录暂不可访问，请重新选择文件夹。' };
  }
}

/** 沿目录句柄逐级找子目录；名字大小写不一致时按不区分大小写再找一遍（Windows 习惯）。 */
export async function descend(handle, names) {
  let cur = handle;
  for (const name of names) {
    try {
      cur = await cur.getDirectoryHandle(name);
    } catch (err) {
      let hit = null;
      for await (const [n, h] of cur.entries()) {
        if (h.kind === 'directory' && n.toLowerCase() === name.toLowerCase()) { hit = h; break; }
      }
      if (!hit) throw new Error(`在「${cur.name}」下找不到文件夹「${name}」，请检查路径。`);
      cur = hit;
    }
  }
  return cur;
}

/** 路径的各级前缀（从浅到深），如 \\srv\share\a → [\\srv, \\srv\share, \\srv\share\a]；D:\x\y → [D:\, D:\x, D:\x\y]。 */
export function ancestors(path) {
  const p = normalizePastedPath(path);
  const unc = p.startsWith('\\\\');
  const posix = p.startsWith('/');
  const parts = splitPath(p);
  return parts.map((_, i) => {
    const seg = parts.slice(0, i + 1);
    if (unc) return '\\\\' + seg.join('\\');
    if (posix) return '/' + seg.join('/');
    return seg.length === 1 && /^[a-zA-Z]:$/.test(seg[0]) ? seg[0] + '\\' : seg.join('\\');
  });
}
