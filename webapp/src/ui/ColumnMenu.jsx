import { useState, useEffect } from 'preact/hooks';
import * as S from '../store.js';
import { useAsync, useDebounced } from './hooks.js';
import { columnProfile } from '../engine/query.js';
import { fmt, fmtInt } from './fmt.js';

/** 列菜单：排序、移到最左、按 TTI 画图、统计、按取值筛选（类 Excel）、数值条件。 */
export function ColumnMenu({ side, column, x, y, onClose, onFront }) {
  const v = S.view.value;
  const [valueSearch, setValueSearch] = useState('');
  const vs = useDebounced(valueSearch, 300);
  const prof = useAsync(() => columnProfile(side, column, { filters: S.effectiveFilters.value, search: v.search, valueSearch: vs }), [column, vs, side.table, S.dataVersion.value]);
  const existing = (v.filters || []).find((f) => f.column === column && (f.op === 'in' || f.op === 'not_in'));
  const [checked, setChecked] = useState(null);
  useEffect(() => {
    if (prof.data && checked === null) {
      const all = prof.data.values.map((x) => x.value);
      setChecked(new Set(existing ? (existing.op === 'in' ? existing.value.map(String) : all.filter((a) => !existing.value.includes(a))) : all));
    }
  }, [prof.data]);
  const cond = (v.filters || []).find((f) => f.column === column && !['in', 'not_in'].includes(f.op));
  const [op, setOp] = useState(cond?.op || 'gte');
  const [a, setA] = useState(cond?.value ?? '');
  const [b, setB] = useState(cond?.value2 ?? '');

  const setFilters = (next) => { S.updateView({ filters: next }); onClose(); };
  const others = (v.filters || []).filter((f) => f.column !== column);
  const applyValues = () => {
    const vals = [...checked];
    if (!vals.length) return S.showToast('至少勾选一个取值。');
    const all = prof.data.values.map((x) => x.value);
    if (!prof.data.hasMore && !vs && vals.length === all.length) return setFilters([...others, ...(cond ? [cond] : [])]);
    setFilters([...others, ...(cond ? [cond] : []), { column, op: 'in', value: vals }]);
  };
  const applyCond = () => {
    if (op === 'is_null' || op === 'not_null') return setFilters([...others, ...(existing ? [existing] : []), { column, op }]);
    if (a === '' || !Number.isFinite(Number(a)) || (op === 'between' && (b === '' || !Number.isFinite(Number(b))))) return S.showToast('请输入有效数字。');
    setFilters([...others, ...(existing ? [existing] : []), { column, op, value: Number(a), ...(op === 'between' ? { value2: Number(b) } : {}) }]);
  };
  const sortBy = (asc) => { S.updateView({ sort: asc == null ? null : { column, asc } }); onClose(); };
  const plot = () => {
    S.updateView({ chartMetrics: [column, ...v.chartMetrics.filter((m) => m !== column)].slice(0, 8) });
    S.tab.value = 'cht';
    onClose();
  };
  const p = prof.data;
  const top = Math.min(y, window.innerHeight - 200);
  return (
    <>
      <div class="backdrop" onClick={onClose} />
      <div class="pop colmenu" style={{ left: `${Math.max(8, x)}px`, top: `${top}px`, position: 'fixed' }}>
        <div class="row"><b style="overflow:hidden;text-overflow:ellipsis">{column}</b><span class="sp" /><button class="btn text" onClick={onClose}>×</button></div>
        <div class="row" style="flex-wrap:wrap;margin-top:6px">
          <button class="btn small" onClick={() => sortBy(true)}>升序</button>
          <button class="btn small" onClick={() => sortBy(false)}>降序</button>
          {v.sort?.column === column && <button class="btn small" onClick={() => sortBy(null)}>取消排序</button>}
          <button class="btn small" onClick={onFront}>移到最左</button>
          {p?.isNumeric && <button class="btn small primary" onClick={plot}>按 TTI 画图</button>}
        </div>
        {!p && prof.loading && <p class="faint">统计中…</p>}
        {prof.error && <p class="dn">{String(prof.error.message || prof.error)}</p>}
        {p && (
          <>
            <h4>统计（当前筛选下）</h4>
            <div class="statgrid num">
              <span>行数 <b>{fmtInt(p.rowCount)}</b></span><span>空 / NaN <b>{fmtInt(p.nullCount)}</b></span><span>不同取值 <b>{fmtInt(p.distinctCount)}</b></span>
              {p.stats && <>
                <span>均值 <b>{fmt(p.stats.mean, 3)}</b></span><span>P50 <b>{fmt(p.stats.p50, 3)}</b></span><span>P90 <b>{fmt(p.stats.p90, 3)}</b></span>
                <span>最小 <b>{fmt(p.stats.min, 3)}</b></span><span>最大 <b>{fmt(p.stats.max, 3)}</b></span>
              </>}
            </div>
            {p.isNumeric && (
              <>
                <h4>数值条件</h4>
                <div class="row">
                  <select class="input" value={op} onChange={(e) => setOp(e.target.value)}>
                    <option value="gte">≥</option><option value="gt">&gt;</option><option value="lte">≤</option><option value="lt">&lt;</option>
                    <option value="eq_num">=</option><option value="between">介于</option><option value="is_null">为空/NaN</option><option value="not_null">非空</option>
                  </select>
                  {!['is_null', 'not_null'].includes(op) && <input class="input" style="width:80px" value={a} onInput={(e) => setA(e.target.value)} />}
                  {op === 'between' && <input class="input" style="width:80px" value={b} onInput={(e) => setB(e.target.value)} />}
                  <button class="btn small primary" onClick={applyCond}>应用</button>
                </div>
              </>
            )}
            <h4>按取值筛选</h4>
            <input class="input" style="width:100%;margin-bottom:6px" placeholder="搜索取值" value={valueSearch} onInput={(e) => { setValueSearch(e.target.value); setChecked(null); }} />
            <div class="row" style="margin-bottom:4px">
              <button class="btn text" onClick={() => setChecked(new Set(p.values.map((x) => x.value)))}>全选</button>
              <button class="btn text" onClick={() => setChecked(new Set())}>清空</button>
              <span class="sp" /><span class="faint" style="font-size:11px">{p.hasMore ? '只显示前 500 个，可搜索' : `${p.values.length} 个取值`}</span>
            </div>
            <div class="vals">
              {p.values.map((x) => (
                <label class="v">
                  <input type="checkbox" checked={checked?.has(x.value)} onChange={() => { const n = new Set(checked); n.has(x.value) ? n.delete(x.value) : n.add(x.value); setChecked(n); }} />
                  <span>{x.value}</span><span class="n">{fmtInt(x.count)}</span>
                </label>
              ))}
            </div>
            <div class="row" style="margin-top:8px">
              {(existing || cond) && <button class="btn small" onClick={() => setFilters(others)}>清除本列筛选</button>}
              <span class="sp" />
              <button class="btn small primary" onClick={applyValues}>仅看勾选值</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
