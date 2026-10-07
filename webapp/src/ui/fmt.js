// 数字格式化
export const fmt = (v, d = 2) => {
  if (v == null || Number.isNaN(v)) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (Math.abs(n) >= 1e6) return n.toExponential(2);
  return n.toLocaleString('zh-CN', { maximumFractionDigits: d, minimumFractionDigits: 0 });
};
export const fmtInt = (v) => (v == null ? '—' : Number(v).toLocaleString('zh-CN'));
export const fmtPct = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`);
export const fmtDelta = (v, d = 2, unit = '') => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}${unit}`);
export const fmtBytes = (b) => {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
export const fmtSec = (s) => (s == null ? '' : s < 60 ? `${s.toFixed(1)} 秒` : `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒`);
export const localDateTag = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
