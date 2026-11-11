// 速率拆解：把“初传确认比特 / TTI”拆成七个因子之积，A/B 对比时按对数分摊到各因子；单小区时看每个用户哪一项是短板。
import { useState, useMemo } from 'preact/hooks';
import * as S from '../store.js';
import { useAsync } from './hooks.js';
import { rateFactors, limitShares, logShare, FACTORS } from '../engine/diagnose.js';
import { Plot, GRID, COLORS } from './Plot.jsx';
import { fmt, fmtInt, fmtPct } from './fmt.js';
import { usePager, heatStyle, contribStyle, diagWhere, diagDeps, Missing } from './diagCommon.jsx';

const fv = (f, x) => (x == null ? '—' : f.pct ? fmt(x * 100, 1) : fmt(x, f.id === 'layers' ? 2 : 1));
const median = (xs) => { const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const MIN_TRIES = 100;

export function RateTab() {
  const single = S.mode.value === 'single';
  const sides = S.sides.value;
  const data = useAsync(async (stale) => {
    const out = {};
    for (const k of ['A', 'B']) {
      const side = sides[k];
      if (!side) continue;
      const where = diagWhere(side);
      out[k] = { f: await rateFactors(side, where), lim: await limitShares(side, where) };
      if (stale()) return null;
    }
    return out;
  }, diagDeps());
  const d = data.data;
  return (
    <div class="diag">
      <div class="headline">
        <div>
          <b>速率拆解 · 速率差在哪一环</b>
          <div class="muted">初传确认比特/TTI = 调度机会 × 调度成功率 × RB/次 × 层数 × 每RB每层比特 × PDCCH送达 × 初传译码成功（恒等式，各因子之积严格等于左边）</div>
        </div>
        {d?.A?.f.bitsSource && <span class="tag" title="TB 比特来源">比特来源：{d.A.f.bitsSource}</span>}
      </div>
      {data.loading && !d && <div class="muted">正在计算…</div>}
      {data.error && <div class="banner warn">计算失败：{String(data.error.message || data.error)}</div>}
      {d && <Missing list={(d.A || d.B)?.f.missing} />}
      {d && (single || !d.B || !d.A ? <SingleView d={d[d.A ? 'A' : 'B']} /> : <AbView a={d.A} b={d.B} />)}
    </div>
  );
}

/** 瀑布图：A 的值 → 各因子贡献 → B 的值（百分比，A = 100）。 */
function Waterfall({ share, title }) {
  const plot = useMemo(() => {
    if (!share) return null;
    const x = ['方案 A', ...FACTORS.map((f) => f.label), '方案 B'];
    let level = 100;
    const base = [0], y = [100], color = [COLORS.A], text = ['100'];
    for (const p of share.parts) {
      const v = p.contrib;
      base.push(v >= 0 ? level : level + v);
      y.push(Math.abs(v));
      color.push(v >= 0 ? '#16a34a' : '#dc2626');
      text.push(`${v >= 0 ? '+' : ''}${v.toFixed(1)}`);
      level += v;
    }
    base.push(0); y.push(level); color.push(COLORS.B); text.push(level.toFixed(1));
    const lo = Math.min(...base.slice(1, -1), level, 100) - 6;
    return {
      data: [{ type: 'bar', x, y, base, marker: { color }, text, textposition: 'outside', cliponaxis: false, hovertemplate: '%{x}<br>%{text}<extra></extra>' }],
      layout: { margin: { l: 44, r: 10, t: 28, b: 54 }, showlegend: false, yaxis: { gridcolor: GRID, range: [Math.max(0, lo), Math.max(...base.map((b, i) => b + y[i])) + 8], title: { text: 'A = 100', font: { size: 10 } } }, xaxis: { tickfont: { size: 11 } }, title: { text: title, font: { size: 12 }, x: 0.01 } },
    };
  }, [share, title]);
  if (!plot) return <div class="empty">样本不足或缺少字段，无法拆解。</div>;
  return <Plot data={plot.data} layout={plot.layout} height={250} />;
}

function AbView({ a, b }) {
  const t396 = S.t396.value;
  const [focus, setFocus] = useState(null);
  const ua = new Map(a.f.users.map((u) => [u.user, u]));
  const ub = new Map(b.f.users.map((u) => [u.user, u]));
  const rate396 = new Map((t396?.rows || []).map((r) => [r.userId, r]));
  const rows = [...new Set([...ua.keys(), ...ub.keys()])].map((u) => {
    const x = ua.get(u), y = ub.get(u);
    const share = x && y && x.tries >= MIN_TRIES && y.tries >= MIN_TRIES ? logShare(x.factors, y.factors) : null;
    const r = rate396.get(u);
    const main = share ? [...share.parts].sort((p, q) => Math.abs(q.contrib) - Math.abs(p.contrib))[0] : null;
    return { user: u, a: x, b: y, share, rateA: r?.rateA, rateB: r?.rateB, d396: r?.rateA && r?.rateB ? (r.rateB / r.rateA - 1) * 100 : null, main };
  }).sort((p, q) => Math.abs(q.share?.total || 0) * (q.a?.tries || 0) - Math.abs(p.share?.total || 0) * (p.a?.tries || 0));
  const cellShare = logShare(a.f.cell?.factors, b.f.cell?.factors);
  const cell396 = t396?.cellRateA && t396?.cellRateB ? (t396.cellRateB / t396.cellRateA - 1) * 100 : null;
  const cur = focus ? rows.find((r) => r.user === focus) : null;
  const pg = usePager(rows, 7);
  const top = cellShare ? [...cellShare.parts].sort((p, q) => Math.abs(q.contrib) - Math.abs(p.contrib)).slice(0, 2) : [];
  const name = (id) => FACTORS.find((f) => f.id === id).label;
  return (
    <>
      <div class="diag-top">
        <div class="chartcard" style="margin:0">
          <Waterfall share={cur?.share || cellShare} title={cur ? `用户 ${cur.user}：A → B 各因子贡献（百分点）` : '小区：A → B 各因子贡献（百分点）'} />
          {cur && <button class="btn small" onClick={() => setFocus(null)}>回到小区</button>}
        </div>
        <div class="diag-side">
          <div class="kcard"><div class="link-kv num" style="grid-template-columns:1fr 1fr;gap:0 12px"><span>拆解变化（初传确认比特）</span><span>T396 Rate 变化</span><b class="big" style="font-size:20px">{fmtPct(cellShare?.total)}</b><b class="big" style="font-size:20px">{fmtPct(cell396)}</b></div><div class="foot">左 = 各因子贡献之和；两者之差来自重传成功、空闲时长与统计窗口</div></div>
          <LimitCard lims={{ A: a.lim, B: b.lim }} />
          {top.length > 0 && <div class="kcard"><div class="nm">主要变化来源</div><div style="margin-top:4px">{top.map((p) => <div class="row"><span>{name(p.id)}</span><span class="sp" /><b class={p.contrib < 0 ? 'dn' : 'up'}>{p.contrib >= 0 ? '+' : ''}{p.contrib.toFixed(1)} 点</b></div>)}</div><div class="foot">比值 B/A：{top.map((p) => `${name(p.id)} ${fmt(p.ratio, 3)}`).join('；')}</div></div>}
        </div>
      </div>
      <div class="section">
        <div class="sh"><b>逐用户拆解（点一行看该用户的瀑布）</b><span class="muted">单元格 = 该因子对 A→B 变化的贡献（百分点），红为拖累；两侧初传次数都 ≥ {MIN_TRIES} 才拆解</span></div>
        <div style="overflow-x:auto">
          <table class="t">
            <thead><tr><th class="left">用户</th><th>初传次数 A / B</th><th>T396 Rate A → B</th><th>T396 变化</th><th>拆解变化</th>{FACTORS.map((f) => <th title={f.hint}>{f.label}</th>)}<th>主因</th></tr></thead>
            <tbody>
              {pg.rows.map((r) => (
                <tr class={'click' + (focus === r.user ? ' on' : '')} onClick={() => setFocus(r.user)}>
                  <td class="left">{r.user}</td>
                  <td class="num">{fmtInt(r.a?.tries)} / {fmtInt(r.b?.tries)}</td>
                  <td class="num">{fmt(r.rateA, 2)} → {fmt(r.rateB, 2)}</td>
                  <td class="num">{fmtPct(r.d396)}</td>
                  <td class="num"><b>{fmtPct(r.share?.total)}</b></td>
                  {FACTORS.map((f) => { const p = r.share?.parts.find((x) => x.id === f.id); return <td class="num" style={contribStyle(p?.contrib)}>{p ? `${p.contrib >= 0 ? '+' : ''}${p.contrib.toFixed(1)}` : '—'}</td>; })}
                  <td>{r.main && Math.abs(r.main.contrib) >= 1 ? <span class={'tag ' + (r.main.contrib < 0 ? 'bad' : 'good')}>{name(r.main.id)}</span> : <span class="faint">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style="padding:0 10px 8px">{pg.bar}</div>
      </div>
    </>
  );
}

function SingleView({ d }) {
  const t396 = S.t396.value;
  const f = d.f;
  const ok = f.users.filter((u) => u.tries >= MIN_TRIES);
  const med = Object.fromEntries(FACTORS.map((x) => [x.id, median(ok.map((u) => u.factors[x.id]))]));
  const rate = new Map((t396?.rows || []).map((r) => [r.userId, r]));
  const rows = f.users.map((u) => {
    const ratios = FACTORS.map((x) => (u.tries >= MIN_TRIES && med[x.id] ? u.factors[x.id] / med[x.id] : null));
    // 短板：除调度机会外，比用户中位低 10% 以上的因子，按对速率的对数影响从大到小取前两个
    const weak = ratios.map((r, i) => ({ r, i })).filter((x) => x.r != null && x.r < 0.9 && FACTORS[x.i].id !== 'tries').sort((a, b) => a.r - b.r).slice(0, 2).map((x) => x.i);
    return { ...u, ratios, weak, rate: rate.get(u.user)?.rateA, share: rate.get(u.user)?.shareA };
  });
  const pg = usePager(rows, 10);
  const lim = d.lim;
  return (
    <>
      <div class="kgrid factor-cards">
        {FACTORS.map((x) => <div class="kcard" title={x.hint}><div class="nm"><span>{x.label}</span><span class="faint">{x.pct ? '%' : x.unit}</span></div><div class="vals num"><span class="big A">{fv(x, f.cell?.factors[x.id])}</span></div><div class="foot">用户中位 {fv(x, med[x.id])}</div></div>)}
      </div>
      <div class="section">
        <div class="sh"><b>逐用户因子（与用户中位数比，红 = 偏低）</b><span class="muted">“短板”= 除调度机会外比中位低 10% 以上的因子，最多两项、最低的在前；初传 ≥ {MIN_TRIES} 次的用户参与比较</span></div>
        <div style="overflow-x:auto">
          <table class="t">
            <thead><tr><th class="left">用户</th><th>T396 Rate</th><th>TTI 占比</th><th>初传次数</th>{FACTORS.map((x) => <th title={x.hint}>{x.label}</th>)}<th>短板</th>{lim && <><th title={lim.rule.data || ''}>数据受限</th><th title={lim.rule.rb || ''}>RB 不足</th><th>调度失败</th></>}</tr></thead>
            <tbody>
              {pg.rows.map((u) => {
                const l = lim?.users.get(u.user);
                return (
                  <tr class="click" onClick={() => { S.users.value = [u.user]; S.tab.value = 'link'; }} title="点击：只看该用户并转到链路诊断">
                    <td class="left">{u.user}</td><td class="num">{fmt(u.rate, 2)}</td><td class="num">{fmt(u.share, 1)}%</td><td class="num">{fmtInt(u.tries)}</td>
                    {FACTORS.map((x, i) => <td class="num" style={heatStyle(u.ratios[i])}>{fv(x, u.factors[x.id])}</td>)}
                    <td class="left">{u.weak.length ? u.weak.map((i) => <span class="tag bad" style="margin-right:3px" title={`为用户中位的 ${fmt(u.ratios[i] * 100, 0)}%`}>{FACTORS[i].label}</span>) : <span class="faint">—</span>}</td>
                    {lim && <><td class="num" style={l?.data > 50 ? { background: 'rgba(234,88,12,.15)' } : {}}>{fmt(l?.data, 1)}%</td><td class="num" style={l?.rb > 30 ? { background: 'rgba(220,38,38,.12)' } : {}}>{fmt(l?.rb, 1)}%</td><td class="num" style={l?.fail > 5 ? { background: 'rgba(147,51,234,.12)' } : {}}>{fmt(l?.fail, 1)}%</td></>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style="padding:0 10px 8px">{pg.bar}</div>
      </div>
      <div class="muted foot-note">读法：数据受限高 → 业务本身没那么多数据（小包/截包），速率低不代表空口差；RB 不足（满缓存用户天然接近 100%）或调度失败高 → 资源/调度问题；每RB每层比特低 → MCS 低（信道或 OLLA）；译码成功低 → BLER 高；PDCCH 送达低 → DTX。</div>
    </>
  );
}

function LimitCard({ lims }) {
  if (!lims.A && !lims.B) return null;
  const rule = (lims.A || lims.B).rule;
  const v = (k, f, d) => fmt(lims[k]?.cell?.[f], d);
  return (
    <div class="kcard" title={[rule.data && `数据受限：${rule.data}`, rule.rb && `RB 不足：${rule.rb}`].filter(Boolean).join('；')}>
      <div class="nm">受限类型（小区，A → B）</div>
      <div class="link-kv num" style="grid-template-columns:auto 1fr">
        <span>调度失败</span><b>{v('A', 'fail', 2)}% → {v('B', 'fail', 2)}%</b>
        <span>数据受限</span><b>{v('A', 'data', 1)}% → {v('B', 'data', 1)}%</b>
        <span>RB 不足</span><b>{v('A', 'rb', 1)}% → {v('B', 'rb', 1)}%</b>
      </div>
    </div>
  );
}
