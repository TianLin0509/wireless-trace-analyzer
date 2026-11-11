// 诊断页签共用的小部件：分页、热力单元格、A/B 侧切换、缺字段提示。
import { useState } from 'preact/hooks';
import * as S from '../store.js';
import { filterSql } from '../engine/query.js';

export const PAGE = 10;

export function usePager(list, size = PAGE) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil((list?.length || 0) / size));
  const p = Math.min(page, pages - 1);
  const rows = (list || []).slice(p * size, p * size + size);
  const bar = pages > 1 ? (
    <div class="row pager" style="justify-content:flex-end;margin-top:6px">
      <span class="muted">第 {p + 1} / {pages} 页 · 共 {list.length} 项</span>
      <button class="btn small" disabled={p === 0} onClick={() => setPage(p - 1)}>上一页</button>
      <button class="btn small" disabled={p >= pages - 1} onClick={() => setPage(p + 1)}>下一页</button>
    </div>
  ) : null;
  return { rows, bar, reset: () => setPage(0) };
}

/** 比值 r（相对参照）着色：<1 偏红、>1 偏绿；越偏越深。 */
export function heatStyle(r, strong = 0.5) {
  if (r == null || !Number.isFinite(r)) return {};
  const d = Math.max(-1, Math.min(1, (r - 1) / strong));
  if (Math.abs(d) < 0.08) return {};
  return d < 0 ? { background: `rgba(220,38,38,${(-d * 0.28).toFixed(3)})` } : { background: `rgba(22,163,74,${(d * 0.2).toFixed(3)})` };
}

/** 百分点贡献着色（负 = 拖累）。 */
export function contribStyle(pp, scale = 5) {
  if (pp == null || !Number.isFinite(pp)) return {};
  const d = Math.max(-1, Math.min(1, pp / scale));
  if (Math.abs(d) < 0.06) return {};
  return d < 0 ? { background: `rgba(220,38,38,${(-d * 0.3).toFixed(3)})` } : { background: `rgba(22,163,74,${(d * 0.22).toFixed(3)})` };
}

/** A/B 模式下切换看哪一侧；单小区固定 A。 */
export function useSide() {
  const single = S.mode.value === 'single';
  const sides = S.sides.value;
  const [k, setK] = useState(sides.A ? 'A' : 'B');
  const key = single ? 'A' : (sides[k] ? k : sides.A ? 'A' : 'B');
  const seg = single ? null : (
    <div class="seg" title="选择查看哪个方案">
      {['A', 'B'].map((x) => <button class={key === x ? 'on' : ''} disabled={!sides[x]} onClick={() => setK(x)}><span class={x}>方案 {x}</span></button>)}
    </div>
  );
  return { key, side: sides[key], seg };
}

/** 诊断页签统一的筛选口径：列筛选 + 搜索；用户范围由各页自己处理（表格列全部用户）。 */
export const diagWhere = (side) => filterSql(S.view.value.filters || [], side.columns, S.view.value.search);
export const diagDeps = () => [S.dataVersion.value, JSON.stringify(S.view.value.filters), S.view.value.search];

export function Missing({ list }) {
  if (!list?.length) return null;
  return <div class="banner warn">缺少字段，相关项未分析：{list.join('、')}。请确认 537/714 文件包含这些列。</div>;
}

export const userLabel = (u) => (u === '__cell__' ? '小区' : u);
