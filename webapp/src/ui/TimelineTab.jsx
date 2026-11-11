// 时间轴：同一用户的 MCS / RB / 层数 / ACK / OLLA / 待发数据按 TTI 对齐成泳道，像逻辑分析仪一样看因果先后。
// 放大后自动按新范围重新取数（不只是放大抽样点），事件区间用浅色底标出。
import { useState, useMemo, useEffect } from 'preact/hooks';
import * as S from '../store.js';
import { useAsync } from './hooks.js';
import { timelineData, userSpan, detectEvents, EVENT_TYPES } from '../engine/diagnose.js';
import { Plot, GRID, COLORS } from './Plot.jsx';
import { fmtInt } from './fmt.js';
import { useSide, diagWhere, diagDeps } from './diagCommon.jsx';
import { metricInfo } from '../engine/metrics.js';

const LANES = [
  { id: 'mcs', label: 'MCS', items: [['tb0SchMcs', '最终 MCS', '#2563eb'], ['estMcs0', 'CQI 估计 MCS', '#94a3b8']] },
  { id: 'rb', label: 'RB', items: [['allocRbNum', '分配 RB', '#0e6b4e'], ['esitimatedRb', '估算需求 RB', '#a3a3a3']] },
  { id: 'rank', label: '层数', items: [['schRank', '调度层数', '#9333ea']] },
  { id: 'ack', label: '上次反馈', items: [['tb0AckState', '触发本次调度的反馈', null], ['714_ack0', '714 ack0', null]] },
  { id: 'olla', label: 'OLLA', items: [['714_mcsOffset0_scaled', 'OLLA 外环累计量（阶）', '#0891b2'], ['714_compOlla_scaled', '补偿 OLLA（阶）', '#67e8f9']] },
  { id: 'buf', label: '数据(字节)', items: [['waitingData', '待发数据', '#ea580c'], ['usrschpdschDrbData', '本次承载', '#fdba74']] },
];

export function TimelineTab() {
  const single = S.mode.value === 'single';
  const sides = S.sides.value;
  const focus = S.timelineFocus.value;
  const { key: segKey } = useSide();
  const key = focus?.side && sides[focus.side] ? focus.side : segKey;
  const side = sides[key];
  const users = useAsync(async () => {
    if (!side?.columns.includes('ambr')) return [];
    const { query } = await import('../engine/db.js');
    const rows = await query(`SELECT CAST("ambr" AS VARCHAR) AS u, count(*) AS n FROM "${side.table}" WHERE "ambr" IS NOT NULL GROUP BY u ORDER BY n DESC LIMIT 300`);
    return rows.map((r) => ({ user: r.u, n: Number(r.n) }));
  }, [S.dataVersion.value, key]);
  const user = focus?.user || S.users.value[0] || users.data?.[0]?.user || null;
  const [range, setRange] = useState(focus?.range || null);
  useEffect(() => { setRange(focus?.range || null); }, [focus]);
  const setUser = (u) => { S.timelineFocus.value = { side: key, user: u, range: null }; };
  const span = useAsync(async () => (side && user ? userSpan(side, diagWhere(side), user) : null), [...diagDeps(), key, user]);
  const tl = useAsync(async () => (side && user ? timelineData(side, diagWhere(side), user, range) : null), [...diagDeps(), key, user, JSON.stringify(range)]);
  const evs = useAsync(async () => (side ? (await detectEvents(side, diagWhere(side))).events : []), [...diagDeps(), key]);
  const myEvents = (evs.data || []).filter((e) => e.user === user).sort((a, b) => a.t0 - b.t0);
  const plot = useMemo(() => buildPlot(tl.data, myEvents), [tl.data, evs.data, user]);
  const onRelayout = (ev) => {
    if (ev['xaxis.range[0]'] != null) setRange([Math.floor(ev['xaxis.range[0]']), Math.ceil(ev['xaxis.range[1]'])]);
    else if (ev['xaxis.autorange']) setRange(null);
  };
  const jump = (dir) => {
    const mid = range ? (range[0] + range[1]) / 2 : -Infinity;
    const list = dir > 0 ? myEvents.filter((e) => e.t0 > mid + 1) : [...myEvents].reverse().filter((e) => e.t1 < mid - 1);
    const e = list[0];
    if (!e) return S.showToast(dir > 0 ? '后面没有该用户的事件了。' : '前面没有该用户的事件了。');
    const pad = Math.max(200, Math.round((e.t1 - e.t0) * 0.5));
    setRange([e.t0 - pad, e.t1 + pad]);
  };
  const toDetail = () => {
    const v = S.view.value;
    const r = range || (span.data ? [span.data.lo, span.data.hi] : null);
    if (r) S.updateView({ filters: [...(v.filters || []).filter((f) => f.column !== 'tti'), { column: 'tti', op: 'between', value: Math.ceil(r[0]), value2: Math.floor(r[1]) }] });
    if (user) S.users.value = [user];
    S.tableSide.value = key;
    S.tab.value = 'tbl';
  };
  return (
    <div class="diag">
      <div class="row tl-bar" style="margin-bottom:8px;flex-wrap:wrap">
        <b>时间轴</b>
        {!single && <div class="seg">{['A', 'B'].map((x) => <button class={key === x ? 'on' : ''} disabled={!sides[x]} onClick={() => { S.timelineFocus.value = { side: x, user, range: null }; }}><span class={x}>方案 {x}</span></button>)}</div>}
        <label class="muted">用户 <select class="input" value={user || ''} onChange={(e) => setUser(e.target.value)}>{(users.data || []).map((u) => <option value={u.user}>{u.user}（{fmtInt(u.n)} 行）</option>)}</select></label>
        <span class="chip scope">TTI {range ? `${fmtInt(range[0])} – ${fmtInt(range[1])}` : span.data ? `${fmtInt(span.data.lo)} – ${fmtInt(span.data.hi)}（全程）` : '—'}</span>
        {tl.data && <span class="faint">{tl.data.stride > 1 ? `共 ${fmtInt(tl.data.total)} 行，每 ${tl.data.stride} 行取 1 个点；框选放大会重新取数` : `共 ${fmtInt(tl.data.total)} 行，全部显示`}</span>}
        <span class="sp" />
        <button class="btn small" onClick={() => jump(-1)} disabled={!myEvents.length}>◀ 上一事件</button>
        <button class="btn small" onClick={() => jump(1)} disabled={!myEvents.length}>下一事件 ▶</button>
        <button class="btn small" onClick={() => setRange(null)} disabled={!range}>全程</button>
        <button class="btn small primary" onClick={toDetail}>在明细中看这段</button>
      </div>
      {focus?.event && <div class="banner info"><span style={{ color: EVENT_TYPES[focus.event.type].color }}>●</span> 来自异常事件：{EVENT_TYPES[focus.event.type].label} · TTI {fmtInt(focus.event.t0)} – {fmtInt(focus.event.t1)} · {focus.event.detail}<span class="sp" /><span class="faint">{EVENT_TYPES[focus.event.type].hint}</span></div>}
      {myEvents.length > 0 && <div class="faint" style="font-size:11px;margin-bottom:4px">该用户共 {myEvents.length} 个事件（浅色底标出）：{Object.entries(myEvents.reduce((m, e) => ((m[e.type] = (m[e.type] || 0) + 1), m), {})).map(([t, c]) => `${EVENT_TYPES[t].label} ${c}`).join('，')}</div>}
      {!side && <div class="empty">没有可用的合并数据。</div>}
      {tl.error && <div class="banner warn">取数失败：{String(tl.error.message || tl.error)}</div>}
      {plot && <div class="chartcard" style="padding:6px 8px"><Plot data={plot.data} layout={plot.layout} height={plot.height} onRelayout={onRelayout} /></div>}
      {tl.loading && !plot && <div class="muted">正在取数…</div>}
    </div>
  );
}

/** 用户没被调度的时段不连线：相邻两点的 TTI 间隔超过常见间隔 10 倍（且 > 20）时插入断点。 */
export function breakGaps(x, ys) {
  const dif = [];
  for (let i = 1; i < x.length; i++) dif.push(x[i] - x[i - 1]);
  const sorted = [...dif].sort((a, b) => a - b);
  const typical = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 1;
  const lim = Math.max(20, typical * 10);
  const X = [], Y = ys.map(() => []);
  for (let i = 0; i < x.length; i++) {
    if (i && x[i] - x[i - 1] > lim) { X.push(null); Y.forEach((y) => y.push(null)); }
    X.push(x[i]); ys.forEach((y, k) => Y[k].push(y[i]));
  }
  return { x: X, ys: Y };
}

function buildPlot(d, events) {
  if (!d || !d.tti.length) return null;
  const lanes0 = LANES.map((l) => ({ ...l, items: l.items.filter(([c]) => d.series[c]) })).filter((l) => l.items.length);
  // ACK 泳道：537 自带的 tb0AckState 有就只画它（714 只连上一半左右的行）
  const lanes = lanes0.map((l) => (l.id === 'ack' && l.items.length > 1 ? { ...l, items: l.items.slice(0, 1) } : l));
  const cols = [...new Set(lanes.flatMap((l) => l.items.map(([c]) => c)))];
  const g = breakGaps(d.tti, cols.map((c) => d.series[c]));
  d = { ...d, tti: g.x, series: Object.fromEntries(cols.map((c, k) => [c, g.ys[k]])) };
  if (!lanes.length) return null;
  const gap = 0.025, h = (1 - gap * (lanes.length - 1)) / lanes.length;
  const layout = { margin: { l: 70, r: 14, t: 26, b: 34 }, showlegend: true, legend: { orientation: 'h', x: 0, y: 1.04, font: { size: 10 } }, hovermode: 'x', xaxis: { gridcolor: GRID, title: { text: 'TTI', font: { size: 10 } }, anchor: `y${lanes.length}` }, shapes: [], annotations: [] };
  const data = [];
  lanes.forEach((l, i) => {
    const n = i + 1, ax = n === 1 ? '' : n;
    const top = 1 - i * (h + gap);
    layout[`yaxis${ax}`] = { domain: [top - h, top], gridcolor: GRID, zeroline: false, title: { text: l.label, font: { size: 10 } }, ...(l.id === 'ack' ? { tickvals: [0, 1, 2], ticktext: ['NACK', 'ACK', 'DTX'], range: [-0.5, 2.5] } : {}), ...(l.id === 'buf' ? { type: 'log' } : {}) };
    for (const [c, name, color] of l.items) {
      const y = d.series[c];
      if (l.id === 'ack') {
        const col = y.map((v) => (v === 1 ? '#16a34a' : v === 0 ? '#dc2626' : v == null ? 'rgba(0,0,0,0)' : '#6b7280'));
        data.push({ type: 'scatter', mode: 'markers', x: d.tti, y, name: 'ACK / NACK / DTX', marker: { color: col, size: 4 }, xaxis: 'x', yaxis: `y${ax}`, hovertemplate: 'TTI %{x}<br>ack0 %{y}<extra></extra>' });
      } else {
        const yy = l.id === 'buf' ? y.map((v) => (v > 0 ? v : null)) : y;
        data.push({ type: 'scatter', mode: d.stride > 1 || d.tti.length > 600 ? 'lines' : 'lines+markers', x: d.tti, y: yy, name, line: { color, width: 1.2, shape: 'hv' }, marker: { size: 3 }, xaxis: 'x', yaxis: `y${ax}`, hovertemplate: `TTI %{x}<br>${metricInfo(c).label} %{y}<extra></extra>`, connectgaps: false });
      }
    }
  });
  const real = d.tti.filter((t) => t != null);
  const lo = real[0], hi = real[real.length - 1];
  for (const e of events) {
    if (e.t1 < lo || e.t0 > hi) continue;
    layout.shapes.push({ type: 'rect', xref: 'x', yref: 'paper', x0: e.t0, x1: Math.max(e.t1, e.t0 + 1), y0: 0, y1: 1, fillcolor: EVENT_TYPES[e.type].color, opacity: 0.1, line: { width: 0 } });
  }
  return { data, layout, height: Math.max(420, Math.min(640, 96 * lanes.length + 70)) };
}
