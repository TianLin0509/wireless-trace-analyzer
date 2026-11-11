// 链路诊断：MCS 从 CQI 估计到最终调度一路被扣了多少阶；OLLA 外环是否收敛（BLER vs 目标）；SU/MU 的 MCS 差。
import { useMemo } from 'preact/hooks';
import * as S from '../store.js';
import { useAsync } from './hooks.js';
import { linkDiag } from '../engine/diagnose.js';
import { Plot, GRID, COLORS } from './Plot.jsx';
import { fmt, fmtInt } from './fmt.js';
import { usePager, useSide, diagWhere, diagDeps } from './diagCommon.jsx';

const PALETTE = ['#16a34a', '#dc2626', '#9333ea', '#0891b2', '#ca8a04', '#db2777'];
/** 链路判读规则（界面原样显示）。 */
export const LINK_RULES = { blerOver: 5, ollaLow: -3, ollaRel: 2, muGap: -3, chainLoss: 4, chainRel: 2, minN: 200 };

const loss = (x) => { const c = x?.chain || []; return c.length >= 2 && c[0].value != null && c[c.length - 1].value != null ? c[0].value - c[c.length - 1].value : null; };

const med = (xs) => { const v = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
/** 参照值用“用户中位数”：小区均值会被高 SINR、OLLA 顶到上限的大流量用户拉偏。 */
export function linkRef(users, R = LINK_RULES) {
  const ok = (users || []).filter((u) => u.n >= R.minN);
  return { olla: med(ok.map((u) => u.olla)), loss: med(ok.map((u) => loss(u))) };
}

/** 判读：绝对门限 + 相对用户中位（同小区里大家都偏的，是小区级现象，不单独标给某个用户）。 */
export function linkFlags(u, cell, R = LINK_RULES) {
  const out = [];
  if (u.n < R.minN) return out;
  if (u.bler != null && u.target != null && u.bler - u.target >= R.blerOver) out.push(['BLER 超目标', `初传 BLER ${fmt(u.bler, 1)}% 比目标 ${fmt(u.target, 1)}% 高 ≥ ${R.blerOver} 点：OLLA 没收敛（信道波动大/突发干扰）`]);
  if (u.olla != null && u.olla <= R.ollaLow && (cell?.olla == null || u.olla <= cell.olla - R.ollaRel)) out.push(['OLLA 深负', `外环累计量均值 ${fmt(u.olla, 1)} 阶，比用户中位 ${fmt(cell?.olla, 1)} 再低 ≥ ${R.ollaRel} 阶：CQI 长期偏乐观（CQI 虚高、干扰未体现在 CQI）`]);
  if (u.muMcs != null && u.suMcs != null && u.muShare >= 5 && u.muMcs - u.suMcs <= R.muGap) out.push(['MU 降阶大', `MU MCS 比 SU 低 ${fmt(u.suMcs - u.muMcs, 1)} 阶：配对干扰大`]);
  const lu = loss(u), lc = cell?.loss ?? null;
  // 找扣得最多的一步：集中在“降阶”这一步多为小包降阶（数据少时主动用更稳的 MCS），不是链路问题
  let worst = null;
  for (let i = 1; i < u.chain.length; i++) {
    const d = u.chain[i - 1].value != null && u.chain[i].value != null ? u.chain[i - 1].value - u.chain[i].value : null;
    if (d != null && (!worst || d > worst.d)) worst = { d, label: u.chain[i].label, column: u.chain[i].column };
  }
  if (worst && worst.column === 'reduceMcs0' && worst.d >= R.chainLoss) out.push(['小包降阶', `降阶这一步平均扣 ${fmt(worst.d, 1)} 阶：数据少时主动降 MCS，属正常机制`]);
  else if (lu != null && lu >= R.chainLoss && (lc == null || lu >= lc + R.chainRel)) out.push(['链路扣阶多', `从 ${u.chain[0].label} 到 ${u.chain[u.chain.length - 1].label} 共扣 ${fmt(lu, 1)} 阶（用户中位 ${fmt(lc, 1)}），扣得最多的是“${worst?.label}”`]);
  return out;
}

export function LinkTab() {
  const single = S.mode.value === 'single';
  const sides = S.sides.value;
  const users = S.users.value;
  const { key, side, seg } = useSide();
  const data = useAsync(async (stale) => {
    const out = {};
    for (const k of ['A', 'B']) {
      if (!sides[k]) continue;
      out[k] = await linkDiag(sides[k], diagWhere(sides[k]));
      if (stale()) return null;
    }
    return out;
  }, diagDeps());
  const d = data.data;
  const cur = d?.[key];
  const chart = useMemo(() => {
    if (!d) return null;
    const traces = [];
    const any = d.A || d.B;
    const x = any.cell?.chain.map((c) => c.label) || [];
    if (!x.length) return null;
    for (const k of ['A', 'B']) {
      if (!d[k]?.cell) continue;
      traces.push({ type: 'scatter', mode: 'lines+markers+text', x, y: d[k].cell.chain.map((c) => c.value), name: single ? '小区' : `方案 ${k} 小区`, line: { color: COLORS[k], width: 2.5 }, text: d[k].cell.chain.map((c) => fmt(c.value, 1)), textposition: 'top center', textfont: { size: 10, color: COLORS[k] } });
    }
    const pick = users.length ? users.slice(0, 6) : (cur?.users || []).filter((u) => linkFlags(u, linkRef(cur.users)).length).slice(0, 4).map((u) => u.user);
    pick.forEach((u, i) => {
      const r = cur?.users.find((x) => x.user === u);
      if (r) traces.push({ type: 'scatter', mode: 'lines+markers', x, y: r.chain.map((c) => c.value), name: `用户 ${u}${single ? '' : ` · ${key}`}`, line: { color: PALETTE[i % PALETTE.length], width: 1.5, dash: 'dot' } });
    });
    return { data: traces, layout: { margin: { l: 44, r: 12, t: 30, b: 40 }, yaxis: { gridcolor: GRID, title: { text: 'MCS 均值（阶）', font: { size: 10 } } }, legend: { orientation: 'h', y: 1.12, x: 0 } } };
  }, [d, key, users.join('|')]);
  const ref = linkRef(cur?.users);
  const rows = (cur?.users || []).map((u) => ({ ...u, flags: linkFlags(u, ref) })).sort((a, b) => b.flags.length - a.flags.length || b.n - a.n);
  const pg = usePager(rows, 8);
  const c = cur?.cell;
  return (
    <div class="diag">
      <div class="headline">
        <div><b>链路诊断 · MCS 一路扣了多少、OLLA 收没收敛</b>
          <div class="muted">MCS 调整链按 CQI 估计 → OLLA → 功率回退 → 速率匹配 → 降阶 → 最终调度的顺序画均值（只取成功初传）；OLLA 用外环累计量 mcsOffset[0]÷1024000（MCS 阶）。</div></div>
        {seg}
      </div>
      {data.loading && !d && <div class="muted">正在计算…</div>}
      {data.error && <div class="banner warn">计算失败：{String(data.error.message || data.error)}</div>}
      {d && <div class="diag-top">
        <div class="chartcard" style="margin:0">{chart ? <Plot data={chart.data} layout={chart.layout} height={290} /> : <div class="empty">537 里没有 MCS 调整链字段（estMcs0 / initAdjMcs0 / … / tb0SchMcs）。</div>}
          <div class="faint" style="font-size:11px" title={cur?.blerSource || ''}>虚线：{users.length ? '左侧所选用户' : '有判读结论的用户（最多 4 个）'}。BLER/DTX/OLLA 口径：{cur?.blerSource ? (cur.blerSource.startsWith('714') ? '714 原表独立统计（悬停看定义）' : cur.blerSource) : '—'}{cur?.unmapped714 > 5 ? `；${fmt(cur.unmapped714, 1)}% 的 714 记录找不到对应用户` : ''}</div></div>
        <div class="diag-side">
          {['A', 'B'].filter((k) => d[k]?.cell).map((k) => { const x = d[k].cell; return (
            <div class="kcard"><div class="nm"><span>{single ? '小区' : <span class={k}>方案 {k}</span>}</span><span class="faint">初传 {fmtInt(x.n)} 次</span></div>
              <div class="link-kv num">
                <span>初传 BLER</span><b>{fmt(x.bler, 2)}%</b><span>目标</span><b>{fmt(x.target, 1)}%</b>
                <span>OLLA 均值</span><b>{fmt(x.olla, 2)} 阶</b><span>OLLA P10</span><b>{fmt(x.olla10, 2)}</b>
                <span>DTX</span><b>{fmt(x.dtx, 2)}%</b><span>MU 占比</span><b>{fmt(x.muShare, 1)}%</b>
                <span>SU MCS</span><b>{fmt(x.suMcs, 2)}</b><span>MU MCS</span><b>{fmt(x.muMcs, 2)}</b>
              </div></div>); })}
          <div class="kcard"><div class="nm">判读规则</div><div class="foot" style="line-height:1.7">BLER − 目标 ≥ {LINK_RULES.blerOver} 点 · OLLA ≤ {LINK_RULES.ollaLow} 阶且比用户中位低 ≥ {LINK_RULES.ollaRel} · MU−SU ≤ {LINK_RULES.muGap} 阶 · 链路扣阶 ≥ {LINK_RULES.chainLoss} 且比用户中位多 ≥ {LINK_RULES.chainRel} · 初传 ≥ {LINK_RULES.minN} 次</div></div>
        </div>
      </div>}
      {cur && <div class="section">
        <div class="sh"><b>逐用户链路（{single ? '本小区' : `方案 ${key}`}）</b><span class="muted">有判读结论的用户排在前面；点一行看该用户时间轴</span></div>
        <div style="overflow-x:auto"><table class="t">
          <thead><tr><th class="left">用户</th><th>初传</th><th>CQI</th>{(c?.chain || []).map((x) => <th title={x.column}>{x.label}</th>)}<th>BLER</th><th>OLLA</th><th>DTX</th><th>MU%</th><th>SU/MU MCS</th><th class="left">判读</th></tr></thead>
          <tbody>{pg.rows.map((u) => (
            <tr class="click" onClick={() => { S.timelineFocus.value = { side: key, user: u.user, range: null }; S.tab.value = 'tl'; }}>
              <td class="left">{u.user}</td><td class="num">{fmtInt(u.n)}</td><td class="num">{fmt(u.cqi, 1)}</td>
              {u.chain.map((x) => <td class="num">{fmt(x.value, 1)}</td>)}
              <td class="num" style={u.bler != null && u.target != null && u.bler - u.target >= LINK_RULES.blerOver ? { background: 'rgba(220,38,38,.14)' } : {}}>{fmt(u.bler, 1)}%</td>
              <td class="num" style={u.olla != null && u.olla <= LINK_RULES.ollaLow ? { background: 'rgba(220,38,38,.14)' } : {}}>{fmt(u.olla, 1)}</td>
              <td class="num">{fmt(u.dtx, 1)}%</td><td class="num">{fmt(u.muShare, 0)}</td><td class="num">{fmt(u.suMcs, 1)} / {fmt(u.muMcs, 1)}</td>
              <td class="left">{u.flags.length ? u.flags.map(([t, why]) => <span class="tag bad" title={why} style="margin-right:4px">{t}</span>) : <span class="faint">—</span>}</td>
            </tr>))}</tbody>
        </table></div>
        <div style="padding:0 10px 8px">{pg.bar}</div>
      </div>}
    </div>
  );
}
