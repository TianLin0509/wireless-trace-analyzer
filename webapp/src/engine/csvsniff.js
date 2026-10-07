// CSV 预检：只读文件开头几 MB，用纯 JS 识别编码、分隔符、表头与数值列（实测几毫秒，比走 DuckDB 快 4~6 倍）。
// 开头一段全空的列判为“待定”，入库后再用全量数据复核（见 ingest.js）。
import { KNOWN_NUMERIC } from './config.js';

export const ID_LIKE_COLUMNS = new Set(['tti', 'crnti', 'ambr', 'usrId', 'HH:MM:SS', 'frm', 'slotNo', 'slotNum', 'rptTti']);
const SNIFF_BYTES = 4 * 1024 * 1024;

export function splitCsvLine(line, delim) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export function sniffText(text) {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = clean.split(/\r?\n/);
  // 最后一行可能被截断，丢掉
  if (lines.length > 1) lines.pop();
  const header = lines[0] || '';
  const counts = [',', ';', '\t', '|'].map((d) => [d, splitCsvLine(header, d).length]);
  const delim = counts.sort((a, b) => b[1] - a[1])[0][0];
  // DuckDB 读表头时也会去掉首尾空格，两边口径一致
  const columns = splitCsvLine(header, delim).map((c) => c.trim());
  const sample = lines.slice(1, 8001).filter((l) => l.length).map((l) => splitCsvLine(l, delim));
  const numeric = [];
  const undecided = [];
  columns.forEach((col, idx) => {
    if (!col || ID_LIKE_COLUMNS.has(col)) return;
    let valid = 0, num = 0;
    for (const row of sample) {
      const v = (row[idx] ?? '').trim();
      if (!v || v.toLowerCase() === 'nan') continue;
      valid++;
      if (Number.isFinite(Number(v))) num++;
    }
    if (KNOWN_NUMERIC.has(col) || (valid && num / valid >= 0.92)) numeric.push(col);
    else if (!valid) undecided.push(col);
  });
  const widths = sample.slice(0, 200).map((r) => r.length);
  const ragged = widths.filter((w) => w !== columns.length).length;
  return { delim, columns, numericColumns: numeric, undecidedColumns: undecided, sampleRows: sample.length, raggedInSample: ragged };
}

export async function sniffFile(file) {
  const bytes = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  let encoding = 'utf-8';
  let text;
  try {
    // 截断处可能切到多字节字符中间：只解码到最后一个换行
    const cut = bytes.lastIndexOf(10);
    text = new TextDecoder('utf-8', { fatal: true }).decode(cut > 0 ? bytes.subarray(0, cut + 1) : bytes);
  } catch {
    // 非 UTF-8（多为 GBK）：DuckDB 按 latin-1 逐字节读取，这里也按 latin-1 解码表头，保证两边列名一致
    encoding = 'latin-1';
    let t = '';
    for (let i = 0; i < bytes.length; i += 8192) t += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    text = t;
  }
  const info = sniffText(text);
  const sampleBytes = Math.max(1, Math.min(bytes.length, file.size));
  let nl = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) nl++;
  const estimatedRows = Math.max(1, Math.round((file.size / sampleBytes) * Math.max(1, nl)) - 1);
  return { ...info, encoding, estimatedRows };
}
