import { useState, useEffect } from 'preact/hooks';
import * as S from '../store.js';
import { useAsync, useDebounced } from './hooks.js';
import { queryRows, exportCsv } from '../engine/query.js';
import { ColumnMenu } from './ColumnMenu.jsx';
import { TtiModal } from './TtiModal.jsx';
import { FieldMenu } from './FieldMenu.jsx';
import { fmtInt, localDateTag } from './fmt.js';
import { describeFilter } from './filters.js';

export function orderedColumns(side, view) {
  if (!side) return [];
  const all = side.visibleColumns;
  const hidden = new Set(view.hiddenColumns || []);
  const order = (view.columnOrder || []).filter((c) => all.includes(c));
  const rest = all.filter((c) => !order.includes(c));
  return [...order, ...rest].filter((c) => !hidden.has(c));
}

const fmtCell = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isInteger(v) ? v : Math.abs(v) >= 1000 ? Math.round(v * 100) / 100 : Math.round(v * 10000) / 10000;
  return v;
};

export function DetailTab() {
  const sides = S.sides.value;
  const sideKey = sides[S.tableSide.value] ? S.tableSide.value : sides.A ? 'A' : 'B';
  const side = sides[sideKey];
  const v = S.view.value;
  const filters = S.effectiveFilters.value;
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(200);
  const [menu, setMenu] = useState(null); // {column, x, y}
  const [tti, setTti] = useState(null);
  const [fieldMenu, setFieldMenu] = useState(false);
  const [focus, setFocus] = useState(false);
  const [picked, setPicked] = useState([]);
  const [dragCol, setDragCol] = useState(null);
  const [overCol, setOverCol] = useState(null);
  const [searchText, setSearchText] = useState(v.search || '');
  const search = useDebounced(searchText, 450);
  useEffect(() => { if (search !== S.view.value.search) S.updateView({ search }); }, [search]);
  // 视图被整体替换（应用视图 / 恢复默认）时，输入框跟着更新，避免显示与实际查询不一致
  useEffect(() => { if ((v.search || '') !== searchText) setSearchText(v.search || ''); }, [v.search]);
  useEffect(() => setPage(1), [JSON.stringify(filters), v.search, sideKey, JSON.stringify(v.sort)]);
  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape') setFocus(false); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);

  const cols = orderedColumns(side, v);
  const res = useAsync(
    () => queryRows(side, { page, pageSize, filters, search: v.search, sort: v.sort, columns: cols }),
    [S.dataVersion.value, sideKey, page, pageSize, JSON.stringify(filters), v.search, JSON.stringify(v.sort), cols.join('|')],
  );

  const moveColumn = (from, to) => {
    if (!from || from === to) return;
    const list = cols.filter((c) => c !== from);
    const idx = to ? list.indexOf(to) : list.length;
    list.splice(idx < 0 ? list.length : idx, 0, from);
    S.updateView({ columnOrder: list });
  };
  const toFront = (c) => S.updateView({ columnOrder: [c, ...cols.filter((x) => x !== c)] });
  const removeFilter = (i) => S.updateView({ filters: v.filters.filter((_, j) => j !== i) });
  const exportNow = async () => {
    try {
      S.showToast('正在导出…');
      const blob = await exportCsv(side, { filters, search: v.search, columns: cols });
      const a = document.createElement('a');
      const sel = S.selection.value[sideKey];
      a.href = URL.createObjectURL(blob);
      a.download = `${localDateTag()}-trace-merge-${sideKey}-${(sel?.cellName || 'cell').replace(/[\\/:*?"<>|]/g, '_')}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (err) { S.showError('导出失败', err); }
  };
  const plotPicked = () => {
    S.updateView({ chartMetrics: [...new Set([...picked, ...v.chartMetrics])].slice(0, 8) });
    setPicked([]);
    S.tab.value = 'cht';
  };
  const filteredCols = new Set(filters.map((f) => f.column));
  const d = res.data;

  return (
    <div class={focus ? 'focus-mode' : ''}>
      <div class="tool">
        <div class="seg">
          {['A', 'B'].map((k) => <button class={sideKey === k ? 'on' : ''} disabled={!sides[k]} onClick={() => (S.tableSide.value = k)}>{k}</button>)}
        </div>
        <input class="input" style="width:200px" placeholder="搜索任意值…" value={searchText} onInput={(e) => setSearchText(e.target.value)} />
        {S.users.value.length > 0 && <span class="chip scope" title="来自左侧用户栏">ambr ∈ {S.users.value.slice(0, 4).join(',')}{S.users.value.length > 4 ? '…' : ''}<button onClick={() => (S.users.value = [])}>×</button></span>}
        {(v.filters || []).map((f, i) => <span class="chip">{describeFilter(f)}<button onClick={() => removeFilter(i)}>×</button></span>)}
        {(v.filters || []).length > 0 && <button class="btn text" onClick={() => S.updateView({ filters: [] })}>清空条件</button>}
        <span class="sp" />
        <div style="position:relative">
          <button class="btn" onClick={() => setFieldMenu(!fieldMenu)}>字段 {cols.length} ▾</button>
          {fieldMenu && <FieldMenu side={side} onClose={() => setFieldMenu(false)} />}
        </div>
        <button class="btn primary" disabled={!picked.length} onClick={plotPicked} title="Ctrl + 点击列名可多选">画已选列 ({picked.length})</button>
        <button class="btn" onClick={exportNow}>导出 CSV</button>
        <button class="btn" onClick={() => setFocus(!focus)} title="全屏明细（Esc 退出）">{focus ? '退出全屏' : '⛶ 全屏'}</button>
      </div>
      <div class="tblwrap" style={{ maxHeight: focus ? 'none' : 'calc(100vh - 210px)' }}>
        <table class="t grid">
          <thead>
            <tr>
              {cols.map((c) => (
                <th
                  class={(filteredCols.has(c) ? 'filtered ' : '') + (picked.includes(c) ? 'sel ' : '') + (overCol === c ? 'drag-over' : '')}
                  draggable
                  onDragStart={(e) => { setDragCol(c); e.dataTransfer.effectAllowed = 'move'; }}
                  onDragOver={(e) => { e.preventDefault(); setOverCol(c); }}
                  onDragLeave={() => setOverCol(null)}
                  onDrop={(e) => { e.preventDefault(); moveColumn(dragCol, c); setDragCol(null); setOverCol(null); }}
                  onClick={(e) => {
                    if (e.ctrlKey || e.metaKey) { setPicked(picked.includes(c) ? picked.filter((x) => x !== c) : [...picked, c]); return; }
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu({ column: c, x: Math.min(r.left, window.innerWidth - 340), y: r.bottom + 4 });
                  }}
                  title="点击：排序 / 筛选 / 统计 / 画图；拖动：调整顺序；Ctrl+点击：选中后画图"
                >
                  {c}
                  {v.sort?.column === c && <span class="ar">{v.sort.asc ? '▲' : '▼'}</span>}
                  {c.startsWith('714_') ? <span class="src">714</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d?.rows.map((row) => (
              <tr>
                {cols.map((c) => {
                  const val = fmtCell(row[c]);
                  if (c === 'tti') return <td class="tti" onClick={() => setTti(row[c])} title="查看这个 TTI 的全部用户（不受筛选影响）">{val}</td>;
                  const nan = val == null || val === 'NaN';
                  return <td class={(nan ? 'nan ' : '') + (picked.includes(c) ? 'sel' : '')}>{nan ? 'NaN' : val}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {res.loading && !d && <div class="empty">加载中…</div>}
        {d && !d.rows.length && <div class="empty">没有符合条件的行。</div>}
        {res.error && <div class="banner warn" style="margin:10px">查询失败：{String(res.error.message || res.error)}</div>}
      </div>
      {d && (
        <div class="pager">
          <span>方案 {sideKey} · 筛选后 <b>{fmtInt(d.filtered)}</b> / {fmtInt(d.total)} 行 · 第 {d.page} / {d.totalPages} 页</span>
          {res.loading && <span class="faint">刷新中…</span>}
          <span class="sp" />
          <select class="input" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))}>
            {[100, 200, 500, 1000].map((n) => <option value={n}>每页 {n}</option>)}
          </select>
          <button class="btn small" disabled={d.page <= 1} onClick={() => setPage(1)}>首页</button>
          <button class="btn small" disabled={d.page <= 1} onClick={() => setPage(d.page - 1)}>上一页</button>
          <button class="btn small" disabled={d.page >= d.totalPages} onClick={() => setPage(d.page + 1)}>下一页</button>
          <button class="btn small" disabled={d.page >= d.totalPages} onClick={() => setPage(d.totalPages)}>末页</button>
        </div>
      )}
      {menu && <ColumnMenu side={side} column={menu.column} x={menu.x} y={menu.y} onClose={() => setMenu(null)} onFront={() => { toFront(menu.column); setMenu(null); }} />}
      {tti != null && <TtiModal side={side} sideKey={sideKey} tti={tti} columns={cols} onClose={() => setTti(null)} />}
    </div>
  );
}
