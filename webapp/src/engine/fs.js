// 本机文件夹访问：优先用目录句柄（可记住授权、下次一键恢复）；不支持时退回 webkitdirectory 选择框。
// 文件只在浏览器内存中按需读取，不会离开本机。
import { describeFile, MAX_SCAN_FILES } from './scan.js';
import { helperFile, helperHead } from './helper.js';

export const supportsDirectoryHandle = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window && !new URLSearchParams(location.search).has('picker');

let rootSeq = 0;

async function walk(dir, prefix, out, depth) {
  for await (const [name, handle] of dir.entries()) {
    if (out.length >= MAX_SCAN_FILES) return;
    if (handle.kind === 'file') {
      if (!/\.csv$/i.test(name) || !/Dest_T\d{3,4}_/i.test(name)) continue;
      out.push({ relPath: `${prefix}/${name}`, handle });
    } else if (handle.kind === 'directory' && depth < 12) {
      await walk(handle, `${prefix}/${name}`, out, depth + 1);
    }
  }
}

/** 扫描一个目录句柄，返回已识别的 T396/537/714 文件描述。 */
export async function scanDirectoryHandle(dirHandle, onProgress) {
  const raw = [];
  await walk(dirHandle, dirHandle.name, raw, 0);
  const rootId = `${dirHandle.name}#h`;
  const files = [];
  for (let i = 0; i < raw.length; i++) {
    const file = await raw[i].handle.getFile();
    const d = describeFile({ relPath: raw[i].relPath, size: file.size, lastModified: file.lastModified, rootId, ref: { handle: raw[i].handle, file } });
    if (d) files.push(d);
    if (i % 20 === 0) onProgress?.(i / raw.length);
  }
  return { rootName: dirHandle.name, files, truncated: raw.length >= MAX_SCAN_FILES };
}

export async function pickDirectory() {
  if (supportsDirectoryHandle()) {
    const handle = await window.showDirectoryPicker({ id: 'trace-data', mode: 'read' });
    return { handle };
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.webkitdirectory = true;
  input.multiple = true;
  input.style.display = 'none';
  document.body.appendChild(input);
  const files = await new Promise((resolve, reject) => {
    input.onchange = () => resolve([...input.files]);
    input.oncancel = () => reject(new DOMException('cancelled', 'AbortError'));
    input.click();
  });
  input.remove();
  if (!files.length) throw new DOMException('cancelled', 'AbortError');
  return { fileList: files };
}

export function scanFileList(fileList) {
  const rootName = (fileList[0]?.webkitRelativePath || '').split('/')[0] || '所选文件夹';
  const rootId = `${rootName}#i${++rootSeq}`;
  const files = [];
  for (const f of fileList.slice(0, MAX_SCAN_FILES)) {
    const d = describeFile({ relPath: f.webkitRelativePath || f.name, size: f.size, lastModified: f.lastModified, rootId, ref: { file: f } });
    if (d) files.push(d);
  }
  return { rootName, files, truncated: fileList.length > MAX_SCAN_FILES };
}

/** 取得可读的 File；目录句柄来源时重新 getFile，保证读到磁盘上的最新内容；本机助手来源时整份读入（onProgress 0..1）。 */
export async function getFile(desc, onProgress) {
  if (desc.ref?.helper) return helperFile(desc, onProgress);
  if (desc.ref?.handle) return desc.ref.handle.getFile();
  return desc.ref.file;
}

/** 只为预检表头取文件开头：本机助手来源时只传前 bytes 字节，其他来源直接给 File。 */
export async function getHead(desc, bytes) {
  if (desc.ref?.helper) return helperHead(desc, bytes);
  return getFile(desc);
}

export const isHelperFile = (desc) => !!desc?.ref?.helper;

export async function ensurePermission(handle) {
  if (!handle?.queryPermission) return true;
  if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}

/** 规范化用户粘贴的路径：去引号、统一反斜杠、去掉末尾斜杠。 */
export function normalizePastedPath(text) {
  let p = String(text || '').trim().replace(/^["']+|["']+$/g, '').trim();
  if (!p) return '';
  // Linux / macOS 路径（以单个 / 开头）保持原样，只去掉末尾斜杠
  if (p.startsWith('/') && !p.startsWith('//')) return p.replace(/\/+$/, '') || '/';
  p = p.replace(/\//g, '\\').replace(/\\+$/, '');
  if (/^[a-zA-Z]:$/.test(p)) p += '\\';
  return p;
}

/** 路径的最后一级目录名，用来核对用户在弹窗里选中的是不是粘贴的那个文件夹。 */
export const lastSegment = (p) => normalizePastedPath(p).split(/[\\/]/).filter(Boolean).pop() || '';

/** 把“所选文件夹内的相对路径”拼成用户能认的完整路径（浏览器本身拿不到绝对路径，只能用粘贴的路径补上）。 */
export function toFullPath(basePath, relPath) {
  if (!basePath) return relPath;
  const base = normalizePastedPath(basePath);
  const sep = base.startsWith('/') ? '/' : '\\';
  const rest = String(relPath || '').split('/').slice(1).join(sep);
  return rest ? `${base}${base.endsWith(sep) ? '' : sep}${rest}` : base;
}

/** 从拖放事件里取出文件夹句柄（Chrome / Edge 支持）。 */
export async function directoryFromDrop(dataTransfer) {
  for (const item of dataTransfer?.items || []) {
    if (item.kind !== 'file' || !item.getAsFileSystemHandle) continue;
    const h = await item.getAsFileSystemHandle();
    if (h?.kind === 'directory') return h;
  }
  return null;
}
