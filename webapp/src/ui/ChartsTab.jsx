import { useState, useMemo } from 'preact/hooks';
import * as S from '../store.js';
import { useAsync } from './hooks.js';
import { chartData, blerChart } from '../engine/stats.js';
import { Plot, COLORS, GRID } from './Plot.jsx';
import { fmt, fmtInt, fmtPct, fmtDelta } from './fmt.js';
import { describeFilter } from './filters.js';
import { MAX_CHART_METRICS, MAX_CHART_USERS } from '../engine/config.js';

const SKIP = new Set(['714_匹配状态', '714_来源行号']);

function rateOf(scopeKey, side) {
  const c = S.t396.value;
  if (!c) return null;
  if (scopeKey === '__cell__') return side === 'A' ? c.cellRateA : c.cellRateB;
  const r = c.rows.find((x) => x.userId === scopeKey);
  return r ? (side === 'A' ? r.rateA : r.rateB) : null;
}
const rateText = (key, side) => { const r = rateOf(key, side); return r == null ? '' : ` · Rate ${fmt(r, 2)}`; };

export function ChartsTab() {
  const sides = S.sides.value;
  const v = S.view.value;
  const filters = v.filters || [];
  const users = S.users.value;
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(null);

  const columns = useMemo(() => {
    const all = [...new Set(['A', 'B'].flatMap((k) => sides[k]?.visibleColumns || []))].filter((c) => !SKIP.has(c));
    const numeric = new Set(['A', 'B'].flatMap((k) => sides[k]?.numericColumns || []));
    return all.map((c) => ({ c, numeric: numeric.has(c), group: c.startsWith('714_') ? (c.endsWith('_scaled') ? '派生' : 'T714') : 'T537' }));
  }, [S.dataVersion.value]);
  const available = new Set(columns.map((x) => x.c));
  const metrics = v.chartMetrics.filter((m) => available.has(m));
  const scopes = users.length ? users.slice(0, MAX_CHART_USERS).map((u) => ({ key: u, label: `ambr ${u}`, users: [u] })) : [{ key: '__cell__', label: '小区全量', users: null }];

  const data = useAsync(async (isStale) => {
    if (!metrics.length) return null;
    setBusy({ p: 0, text: '准备中' });
    try {
      const res = await chartData(sides, { metrics, filters, search: v.search, scopes, isStale, onProgress: (p, text) => !isStale() && setBusy({ p, text }) });
      const bler = await blerChart(sides, filters, v.search, users);
      return { res, bler };
    } finally {
      if (!isStale()) setBusy(null);
    }
  }, [S.dataVersion.value, metrics.join('|'), JSON.stringify(filters), v.search, users.join('|')]);

  const toggleMetric = (c) => {
    const has = metrics.includes(c);
    if (!has && metrics.length >= MAX_CHART_METRICS) return S.showToast(`最多同时画 ${MAX_CHART_METRICS} 个字段。`);
    S.updateView({ chartMetrics: has ? metrics.filter((m) => m !== c) : [...metrics, c] });
  };
  const mode = v.chartMode || 'split';
  const noAmbr = users.length && ['A', 'B'].some((k) => sides[k] && !sides[k].columns.includes('ambr'));

  return (
    <div class="cgrid">
      <div class="mlist">
        <input class="input" placeholder="搜索字段" value={q} onInput={(e) => setQ(e.target.value)} />
        {['T537', 'T714', '派生'].map((g) => {
          const items = columns.filter((x) => x.group === g && (!q || x.c.toLowerCase().includes(q.toLowerCase())));
          if (!items.length) return null;
          return (
            <>
              <div class="g">{g}</div>
              {items.map((x) => (
                <div class={'it' + (metrics.includes(x.c) ? ' on' : '')} onClick={() => toggleMetric(x.c)} title={x.numeric ? '数值：序列 + CDF' : '类别：取值分布'}>
                  <span>{x.c}</span><span>{metrics.includes(x.c) ? '✓' : x.numeric ? '' : '类'}</span>
                </div>
              ))}
            </>
          );
        })}
      </div>
      <div style="min-width:0">
        <div class="row" style="margin-bottom:10px;flex-wrap:wrap">
          <span class="chip scope">{users.length ? `用户：${users.slice(0, 5).join('、')}${users.length > 5 ? ` 等 ${users.length} 个` : ''}` : '范围：小区全量'}</span>
          {filters.map((f) => <span class="chip">{describeFilter(f)}</span>)}
          {v.search && <span class="chip">搜索：{v.search}</span>}
          <span class="sp" />
          <div class="seg" title="分图：A、B 各一张，坐标范围一致；叠加：A、B 画在同一张图">
            <button class={mode === 'split' ? 'on' : ''} onClick={() => S.updateView({ chartMode: 'split' })}>分图</button>
            <button class={mode === 'overlay' ? 'on' : ''} onClick={() => S.updateView({ chartMode: 'overlay' })}>叠加</button>
          </div>
        </div>
        {users.length > MAX_CHART_USERS && <div class="banner warn">一次最多画 {MAX_CHART_USERS} 个用户，已取前 {MAX_CHART_USERS} 个。</div>}
        {noAmbr && <div class="banner warn">有一侧的 537 没有 ambr 列，无法按用户区分，该侧不参与按用户的图表。</div>}
        {!metrics.length && <div class="empty">在左侧选择要画的字段（最多 {MAX_CHART_METRICS} 个）。也可以在“明细”里点列名 →“按 TTI 画图”。</div>}
        {busy && <div class="banner info">正在生成图表：{busy.text}（{Math.round(busy.p * 100)}%）</div>}
        {data.error && <div class="banner warn">画图失败：{String(data.error.message || data.error)}</div>}
        {data.data?.res.map((m) => (m.numeric ? <NumericCards m={m} mode={mode} /> : <CategoryCard m={m} mode={mode} />))}
        {data.data?.bler && <BlerCard bler={data.data.bler} users={users} />}
      </div>
    </div>
  );
}

function subplotGrid(rows, cols, titles, opts = {}) {
  const layout = { grid: { rows, columns: cols, pattern: 'independent', ygap: 0.28, xgap: 0.08 }, annotations: [], showlegend: cols === 1 };
  titles.forEach((t, i) => {
    const n = i === 0 ? '' : i + 1;
    layout[`xaxis${n}`] = { gridcolor: GRID, zeroline: false, title: { text: opts.xTitle || '', font: { size: 10 } }, ...(opts.x || {}) };
    layout[`yaxis${n}`] = { gridcolor: GRID, zeroline: false, ...(opts.y || {}) };
    layout.annotations.push({ text: t, xref: `x${n} domain`, yref: `y${n} domain`, x: 0.5, y: 1.0, yanchor: 'bottom', showarrow: false, font: { size: 12 } });
  });
  return layout;
}

function rangeOf(values, pad = 0.04) {
  const xs = values.filter((x) => x != null && Number.isFinite(x));
  if (!xs.length) return undefined;
  let lo = Infinity, hi = -Infinity;
  for (const x of xs) { if (x < lo) lo = x; if (x > hi) hi = x; }
  if (lo === hi) { lo -= 1; hi += 1; }
  const d = (hi - lo) * pad;
  return [lo - d, hi + d];
}

const overlayTitle = (r) => {
  const ra = rateOf(r.key, 'A'), rb = rateOf(r.key, 'B');
  return ra == null && rb == null ? r.label : `${r.label} · Rate ${fmt(ra, 2)} → ${fmt(rb, 2)}`;
};

function NumericCards({ m, mode }) {
  const rows = m.scopes;
  const [zoom, setZoom] = useState(null);
  const present = ['A', 'B'].filter((k) => rows.some((r) => r.sides[k]));
  const cols = mode === 'split' ? Math.max(1, present.length) : 1;
  // 序列：分图时 A、B 共用同一纵轴范围
  const seq = useMemo(() => {
    const data = [], titles = [];
    let idx = 0;
    const yr = rangeOf(rows.flatMap((r) => present.flatMap((k) => r.sides[k]?.seq.y || [])));
    rows.forEach((r) => {
      if (mode === 'split') {
        present.forEach((k) => {
          idx++;
          const s = r.sides[k];
          data.push({ type: 'scatter', mode: 'lines', x: s?.seq.x || [], y: s?.seq.y || [], name: `方案 ${k}`, line: { color: COLORS[k], width: 1 }, xaxis: `x${idx === 1 ? '' : idx}`, yaxis: `y${idx === 1 ? '' : idx}`, hovertemplate: `TTI %{x}<br>${m.metric} %{y}<extra>方案 ${k}</extra>` });
          titles.push(`${r.label} · 方案 ${k}${rateText(r.key, k)}`);
        });
      } else {
        idx++;
        present.forEach((k) => {
          const s = r.sides[k];
          data.push({ type: 'scatter', mode: 'lines', x: (s?.seq.y || []).map((_, i) => i + 1), y: s?.seq.y || [], name: `方案 ${k}`, legendgroup: k, showlegend: idx === 1, line: { color: COLORS[k], width: 1 }, opacity: 0.85, xaxis: `x${idx === 1 ? '' : idx}`, yaxis: `y${idx === 1 ? '' : idx}` });
        });
        titles.push(overlayTitle(r));
      }
    });
    const layout = subplotGrid(rows.length, cols, titles, { xTitle: mode === 'split' ? 'TTI（升序）' : '采样序号（各自按 TTI 升序）', y: { range: yr } });
    return { data, layout };
  }, [m, mode]);
  // CDF：分图时 A、B 共用同一横轴范围
  const cdf = useMemo(() => {
    const data = [], titles = [];
    let idx = 0;
    const xr = rangeOf(rows.flatMap((r) => present.flatMap((k) => r.sides[k]?.stats.cdf?.x || [])), 0.02);
    rows.forEach((r) => {
      const panels = mode === 'split' ? present.map((k) => [k]) : [present];
      panels.forEach((ks) => {
        idx++;
        ks.forEach((k) => {
          const c = r.sides[k]?.stats.cdf;
          data.push({ type: 'scatter', mode: 'lines', line: { shape: 'hv', color: COLORS[k], width: 1.8 }, x: c?.x || [], y: c?.y || [], name: `方案 ${k}`, legendgroup: k, showlegend: mode !== 'split' && idx === 1, xaxis: `x${idx === 1 ? '' : idx}`, yaxis: `y${idx === 1 ? '' : idx}`, hovertemplate: `${m.metric} %{x}<br>累计 %{y:.0f}%<extra>方案 ${k}</extra>` });
        });
        titles.push(mode === 'split' ? `${r.label} · 方案 ${ks[0]}${rateText(r.key, ks[0])}` : overlayTitle(r));
      });
    });
    const layout = subplotGrid(rows.length, cols, titles, { xTitle: m.metric, x: { range: xr }, y: { range: [0, 101], ticksuffix: '%' } });
    return { data, layout };
  }, [m, mode]);
  const h = Math.max(300, rows.length * 250 + 60);
  const onRelayout = (ev) => {
    const key = Object.keys(ev).find((k) => /^xaxis\d*\.range\[0\]$/.test(k));
    if (!key) { if (Object.keys(ev).some((k) => k.endsWith('autorange'))) setZoom(null); return; }
    const ax = key.split('.')[0];
    const n = ax === 'xaxis' ? 1 : Number(ax.slice(5));
    const side = present[(n - 1) % present.length];
    setZoom({ side, lo: ev[`${ax}.range[0]`], hi: ev[`${ax}.range[1]`] });
  };
  const applyZoom = () => {
    const v = S.view.value;
    S.updateView({ filters: [...(v.filters || []).filter((f) => f.column !== 'tti'), { column: 'tti', op: 'between', value: Math.ceil(zoom.lo), value2: Math.floor(zoom.hi) }] });
    S.tableSide.value = zoom.side;
    S.tab.value = 'tbl';
  };
  return (
    <>
      <div class="chartcard">
        <h5><span>{m.metric} · 序列</span><span class="faint" style="font-weight:400;font-size:11px">{mode === 'split' ? 'A、B 纵轴范围一致 · 框选放大一段 TTI 可带到明细' : 'A、B 叠加'} · 每条最多 3000 点 · 拖右下角调大小</span></h5>
        {zoom && (
          <div class="banner info" style="margin:4px 0">
            <span>已放大到 方案 {zoom.side} 的 TTI {Math.ceil(zoom.lo)} – {Math.floor(zoom.hi)}</span><span class="sp" />
            <button class="btn small primary" onClick={applyZoom}>在明细中只看这段 TTI</button>
            <button class="btn small" onClick={() => setZoom(null)}>忽略</button>
          </div>
        )}
        <Plot data={seq.data} layout={seq.layout} height={h} onRelayout={mode === 'split' ? onRelayout : undefined} />
        <StatTable m={m} />
      </div>
      <div class="chartcard">
        <h5><span>{m.metric} · CDF</span><span class="faint" style="font-weight:400;font-size:11px">{mode === 'split' ? 'A、B 横轴范围一致' : 'A、B 叠加'}</span></h5>
        <Plot data={cdf.data} layout={cdf.layout} height={h} />
      </div>
    </>
  );
}

function StatTable({ m }) {
  return (
    <div class="statline" style="overflow:auto">
      <table class="t">
        <thead><tr><th class="left">范围</th><th>样本 A / B</th><th>均值 A / B</th><th>B−A</th><th>差异</th><th>P50 A / B</th><th>P90 A / B</th><th>最小 A / B</th><th>最大 A / B</th></tr></thead>
        <tbody>
          {m.scopes.map((r) => {
            const a = r.sides.A?.stats, b = r.sides.B?.stats;
            const d = a?.mean != null && b?.mean != null ? b.mean - a.mean : null;
            return (
              <tr>
                <td class="left">{r.label}</td>
                <td class="num">{fmtInt(a?.count)} / {fmtInt(b?.count)}</td>
                <td class="num"><span class="A">{fmt(a?.mean, 3)}</span> / <span class="B">{fmt(b?.mean, 3)}</span></td>
                <td class="num">{fmtDelta(d, 3)}</td>
                <td class="num">{fmtPct(d != null && a.mean ? (d / Math.abs(a.mean)) * 100 : null)}</td>
                <td class="num">{fmt(a?.p50, 3)} / {fmt(b?.p50, 3)}</td>
                <td class="num">{fmt(a?.p90, 3)} / {fmt(b?.p90, 3)}</td>
                <td class="num">{fmt(a?.min, 3)} / {fmt(b?.min, 3)}</td>
                <td class="num">{fmt(a?.max, 3)} / {fmt(b?.max, 3)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CategoryCard({ m, mode }) {
  const rows = m.scopes;
  const present = ['A', 'B'].filter((k) => rows.some((r) => r.sides[k]));
  const { data, layout } = useMemo(() => {
    const data = [], titles = [];
    let idx = 0;
    rows.forEach((r) => {
      const cats = [...new Set(present.flatMap((k) => r.sides[k]?.cats.values || []))];
      const panels = mode === 'split' ? present.map((k) => [k]) : [present];
      panels.forEach((ks) => {
        idx++;
        ks.forEach((k) => {
          const c = r.sides[k]?.cats;
          const map = new Map((c?.values || []).map((v, i) => [v, c.counts[i]]));
          data.push({ type: 'bar', x: cats, y: cats.map((v) => ((map.get(v) || 0) / (c?.total || 1)) * 100), customdata: cats.map((v) => map.get(v) || 0), name: `方案 ${k}`, legendgroup: k, showlegend: mode !== 'split' && idx === 1, marker: { color: COLORS[k] }, xaxis: `x${idx === 1 ? '' : idx}`, yaxis: `y${idx === 1 ? '' : idx}`, hovertemplate: `%{x}<br>占比 %{y:.1f}%<br>行数 %{customdata}<extra>方案 ${k}</extra>` });
        });
        titles.push(mode === 'split' ? `${r.label} · 方案 ${ks[0]}${rateText(r.key, ks[0])}` : overlayTitle(r));
      });
    });
    const layout = { ...subplotGrid(rows.length, mode === 'split' ? Math.max(1, present.length) : 1, titles, { x: { type: 'category' }, y: { ticksuffix: '%', range: [0, 100] } }), barmode: 'group' };
    return { data, layout };
  }, [m, mode]);
  return (
    <div class="chartcard">
      <h5><span>{m.metric} · 取值分布</span><span class="faint" style="font-weight:400;font-size:11px">按行数占比（分母为该范围全部行），便于 A/B 样本量不同时对比；超过 24 类时其余合并为“其他”</span></h5>
      <Plot data={data} layout={layout} height={Math.max(300, rows.length * 240 + 60)} />
    </div>
  );
}

function BlerCard({ bler, users }) {
  const all = [...new Set(['A', 'B'].flatMap((k) => (bler[k] || []).map((r) => r.user)))];
  const list = users.length ? all.filter((u) => users.includes(u)) : all.slice(0, 20);
  const data = ['A', 'B'].filter((k) => bler[k]).map((k) => {
    const map = new Map(bler[k].map((r) => [r.user, r]));
    return {
      type: 'bar', name: `方案 ${k}`, marker: { color: COLORS[k] }, x: list, y: list.map((u) => map.get(u)?.bler ?? null),
      text: list.map((u) => (map.get(u) ? `${map.get(u).bler.toFixed(1)}%` : '')), textposition: 'outside', cliponaxis: false,
      customdata: list.map((u) => [map.get(u)?.valid || 0, map.get(u)?.dtx || 0, fmt(rateOf(u, k), 2)]),
      hovertemplate: `用户 %{x}<br>BLER %{y:.2f}%<br>有效样本 %{customdata[0]} · DTX 剔除 %{customdata[1]}<br>T396 Rate %{customdata[2]}<extra>方案 ${k}</extra>`,
    };
  });
  const layout = { barmode: 'group', xaxis: { type: 'category', title: { text: '用户 ambr', font: { size: 10 } } }, yaxis: { ticksuffix: '%', gridcolor: GRID, rangemode: 'tozero' } };
  return (
    <div class="chartcard">
      <h5><span>BLER · 按用户 A/B 对比</span><span class="faint" style="font-weight:400;font-size:11px">剔除 ack0 非 0/1 的 DTX 后计算；{users.length ? '所选用户' : '样本最多的 20 个用户'}</span></h5>
      <Plot data={data} layout={layout} height={340} />
    </div>
  );
}
