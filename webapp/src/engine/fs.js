// 本机文件夹访问：优先用目录句柄（可记住授权、下次一键恢复）；不支持时退回 webkitdirectory 选择框。
// 文件只在浏览器内存中按需读取，不会离开本机。
import { describeFile, MAX_SCAN_FILES } from './scan.js';

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

/** 取得可读的 File；目录句柄来源时重新 getFile，保证读到磁盘上的最新内容。 */
export async function getFile(desc) {
  if (desc.ref?.handle) return desc.ref.handle.getFile();
  return desc.ref.file;
}

export async function ensurePermission(handle) {
  if (!handle?.queryPermission) return true;
  if ((await handle.queryPermission({ mode: 'read' })) === 'granted') return true;
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}
