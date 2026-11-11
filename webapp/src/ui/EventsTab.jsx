// 异常事件：连续 NACK / 连续 DTX / 连续调度失败 / MCS 骤降 / OLLA 下探，按用户 × 类型汇总，点事件跳到时间轴。
import { useState } from 'preact/hooks';
import * as S from '../store.js';
import { useAsync } from './hooks.js';
import { detectEvents, eventMatrix, EVENT_TYPES, EVENT_RULES } from '../engine/diagnose.js';
import { fmtInt } from './fmt.js';
import { usePager, useSide, diagWhere, diagDeps } from './diagCommon.jsx';

const TYPES = Object.keys(EVENT_TYPES);

export function EventsTab() {
  const single = S.mode.value === 'single';
  const { key, side, seg } = useSide();
  const [type, setType] = useState(null);
  const [user, setUser] = useState(null);
  const data = useAsync(async () => (side ? detectEvents(side, diagWhere(side)) : null), [...diagDeps(), key]);
  const ev = data.data?.events || [];
  const matrix = eventMatrix(ev);
  const list = ev.filter((e) => (!type || e.type === type) && (!user || e.user === user)).sort((a, b) => a.user.localeCompare(b.user, 'zh', { numeric: true }) || a.t0 - b.t0);
  const pg = usePager(list, 7);
  const mx = Math.max(1, ...matrix.flatMap((m) => TYPES.map((t) => m.byType[t] || 0)));
  const R = EVENT_RULES;
  const open = (e) => {
    const pad = Math.max(200, Math.round((e.t1 - e.t0) * 0.5));
    S.timelineFocus.value = { side: key, user: e.user, range: [e.t0 - pad, e.t1 + pad], event: e };
    S.tab.value = 'tl';
  };
  return (
    <div class="diag">
      <div class="headline">
        <div><b>异常事件 · 问题发生在什么时刻</b>
          <div class="muted">规则：连续初传 NACK ≥ {R.nackRun} 次；连续 DTX ≥ {R.dtxRun} 次；连续调度失败 ≥ {R.failRun} 次；最终 MCS 比前 20 次均值低 ≥ {R.mcsDrop} 阶且持续 ≥ {R.mcsDropRun} 次；OLLA 外环累计量比前 200 次均值低 ≥ {R.ollaDrop} 阶且持续 ≥ {R.ollaRun} 次。受列筛选与搜索影响。</div></div>
        {seg}
      </div>
      {data.loading && <div class="muted">正在扫描事件…</div>}
      {data.error && <div class="banner warn">扫描失败：{String(data.error.message || data.error)}</div>}
      {data.data && !ev.length && <div class="banner info">当前规则下没有检出连续异常事件。</div>}
      {ev.length > 0 && <div class="diag-top evt">
        <div class="section" style="margin:0">
          <div class="sh"><b>用户 × 事件类型（{single ? '本小区' : `方案 ${key}`}，共 {ev.length} 个事件）</b><span class="muted">点格子筛选下方列表</span></div>
          <div style="overflow:auto;max-height:300px"><table class="t">
            <thead><tr><th class="left">用户</th>{TYPES.map((t) => <th title={EVENT_TYPES[t].hint}><span style={{ color: EVENT_TYPES[t].color }}>●</span> {EVENT_TYPES[t].label}</th>)}<th>合计</th></tr></thead>
            <tbody>{matrix.slice(0, 9).map((m) => (
              <tr><td class={'left click' + (user === m.user ? ' on' : '')} onClick={() => { setUser(user === m.user ? null : m.user); setType(null); pg.reset(); }}>{m.user}</td>
                {TYPES.map((t) => { const c = m.byType[t] || 0; return <td class="num click" style={c ? { background: `rgba(220,38,38,${(0.08 + 0.32 * c / mx).toFixed(2)})` } : {}} onClick={() => { setUser(m.user); setType(t); pg.reset(); }}>{c || ''}</td>; })}
                <td class="num"><b>{m.total}</b></td></tr>))}</tbody>
          </table></div>
          {matrix.length > 9 && <div class="faint" style="padding:4px 10px">另有 {matrix.length - 9} 个用户有事件，见下方列表。</div>}
        </div>
        <div class="diag-side">
          {TYPES.map((t) => { const n = ev.filter((e) => e.type === t).length; return (
            <div class={'kcard' + (type === t ? ' on' : '')} onClick={() => { setType(type === t ? null : t); pg.reset(); }}>
              <div class="nm"><span><span style={{ color: EVENT_TYPES[t].color }}>●</span> {EVENT_TYPES[t].label}</span><b>{n}</b></div>
              <div class="foot">{EVENT_TYPES[t].hint}</div></div>); })}
        </div>
      </div>}
      {ev.length > 0 && <div class="section">
        <div class="sh"><b>事件列表{user ? ` · 用户 ${user}` : ''}{type ? ` · ${EVENT_TYPES[type].label}` : ''}</b><span class="sp" />{(user || type) && <button class="btn small" onClick={() => { setUser(null); setType(null); }}>清除筛选</button>}</div>
        <table class="t">
          <thead><tr><th class="left">类型</th><th class="left">用户</th><th>起始 TTI</th><th>结束 TTI</th><th>持续（调度次数）</th><th class="left">说明</th><th></th></tr></thead>
          <tbody>{pg.rows.map((e) => (
            <tr><td class="left"><span style={{ color: EVENT_TYPES[e.type].color }}>●</span> {EVENT_TYPES[e.type].label}</td><td class="left">{e.user}</td>
              <td class="num">{fmtInt(e.t0)}</td><td class="num">{fmtInt(e.t1)}</td><td class="num">{e.len}</td><td class="left">{e.detail}</td>
              <td><button class="btn small primary" onClick={() => open(e)}>看时间轴</button></td></tr>))}</tbody>
        </table>
        <div style="padding:0 10px 8px">{pg.bar}</div>
      </div>}
    </div>
  );
}
