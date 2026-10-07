import * as S from '../store.js';
import { useAsync } from './hooks.js';
import { summaryCards, userBreakdown, matchStats } from '../engine/stats.js';
import { filterSql } from '../engine/query.js';
import { scopeRate } from '../engine/t396.js';
import { fmt, fmtPct, fmtInt, fmtDelta } from './fmt.js';

function Spark({ a, b }) {
  if (!a?.cdf && !b?.cdf) return null;
  const xs = [...(a?.cdf?.x || []), ...(b?.cdf?.x || [])];
  const lo = Math.min(...xs), hi = Math.max(...xs);
  const w = 240, h = 40;
  const path = (c) => c ? c.x.map((x, i) => `${i ? 'L' : 'M'}${(((x - lo) / (hi - lo || 1)) * w).toFixed(1)},${(h - (c.y[i] / 100) * h).toFixed(1)}`).join(' ') : '';
  return (
    <svg viewBox={`-2 -2 ${w + 4} ${h + 4}`} width="100%" height="44" preserveAspectRatio="none" aria-label="A/B 分布对比">
      <path d={path(a?.cdf)} fill="none" stroke="#2563eb" stroke-width="1.6" vector-effect="non-scaling-stroke" />
      <path d={path(b?.cdf)} fill="none" stroke="#f97316" stroke-width="1.6" vector-effect="non-scaling-stroke" />
    </svg>
  );
}

function ShareBars({ a, b }) {
  // 以两者较大值的 1.25 倍为满格，让几个百分点的差异也看得出来
  const top = Math.max(a?.value || 0, b?.value || 0) * 1.25 || 1;
  const w = (x) => Math.max(1.5, ((x?.value || 0) / top) * 240);
  return (
    <svg viewBox="0 0 240 40" width="100%" height="44" preserveAspectRatio="none">
      <rect x="0" y="6" width="240" height="11" rx="3" fill="#f1f3f5" />
      <rect x="0" y="23" width="240" height="11" rx="3" fill="#f1f3f5" />
      <rect x="0" y="6" width={w(a)} height="11" rx="3" fill="#2563eb" />
      <rect x="0" y="23" width={w(b)} height="11" rx="3" fill="#f97316" />
    </svg>
  );
}

const verdictTag = (v) => <span class={'tag ' + (v.level === 'na' ? '' : v.level)} title={v.z != null ? `近似 z = ${v.z.toFixed(1)}（TTI 样本有自相关，仅作参考）` : ''}>{v.text}</span>;

export function SummaryTab() {
  const cmp = S.t396.value;
  const sides = S.sides.value;
  const filters = S.effectiveFilters.value;
  const v = S.view.value;
  const users = S.users.value;
  const ready = S.ready.value;
  const key = [S.dataVersion.value, JSON.stringify(filters), v.search, ready];
  const cards = useAsync((isStale) => (ready ? summaryCards(sides, filters, v.search, isStale) : null), key);
  const match = useAsync(() => (ready ? matchStats(sides, filters, v.search) : null), key);
  const rate = scopeRate(cmp, users);
  const scopeText = users.length ? `已选 ${users.length} 个用户：${users.slice(0, 6).join('、')}${users.length > 6 ? '…' : ''}` : '小区全部用户';
  const tableFilters = (v.filters || []).length;

  const goChart = (metric) => {
    S.updateView({ chartMetrics: [metric, ...v.chartMetrics.filter((m) => m !== metric)].slice(0, 8) });
    S.tab.value = 'cht';
  };

  return (
    <div>
      <div class="headline">
        <div>
          <b>{headline(cmp, rate, users)}</b>
          <div class="muted" style="font-size:12px">范围：{scopeText} · 表格筛选 {tableFilters ? `${tableFilters} 项` : '无'}{v.search ? ` · 搜索“${v.search}”` : ''}</div>
        </div>
        <span class="faint" style="font-size:12px;white-space:nowrap">点卡片 → 跳到对应图表</span>
      </div>
      <div class="kgrid">
        {cmp && (
          <div class="kcard" onClick={() => (S.tab.value = 'qa')}>
            <div class="nm"><span>{users.length ? '所选用户 Rate（T396）' : '小区 Rate（T396）'}</span>{rate.diff == null ? null : <span class={'tag ' + (rate.diff <= -2 ? 'bad' : rate.diff >= 2 ? 'good' : '')}>{rate.diff <= -2 ? '回退' : rate.diff >= 2 ? '改善' : '持平'}</span>}</div>
            <div class="vals num"><span class="big A">{fmt(rate.a, 2)}</span><span class="muted">→</span><span class="big B">{fmt(rate.b, 2)}</span><span class={'delta ' + (rate.diff < 0 ? 'dn' : 'up')}>{fmtPct(rate.diff)}</span></div>
            <div class="foot">Rate = Σ dlThpVolRmvLastSlot / Σ dlThpTimeRmvLastSlot</div>
          </div>
        )}
        {!ready && S.running.value && [1, 2, 3, 4, 5].map(() => <div class="kcard skeleton" style="height:118px" />)}
        {cards.data?.map((c) => (
          <div class="kcard" onClick={() => goChart(c.chart)}>
            <div class="nm"><span>{c.label}</span>{verdictTag(c.verdict)}</div>
            <div class="vals num">
              <span class="big A">{fmt(c.a?.value, c.digits)}</span><span class="muted">→</span><span class="big B">{fmt(c.b?.value, c.digits)}</span>
              <span class="muted" style="font-size:11px">{c.unit}</span>
              <span class={'delta ' + (c.verdict.level === 'bad' ? 'dn' : c.verdict.level === 'good' ? 'up' : 'muted')}>{c.a?.value != null && c.b?.value != null ? fmtDelta(c.b.value - c.a.value, c.digits, c.unit === '%' ? ' pt' : '') : ''}</span>
            </div>
            {c.kind === 'mean' ? <Spark a={c.a} b={c.b} /> : <ShareBars a={c.a} b={c.b} />}
            <div class="foot">样本 {fmtInt(c.a?.n)} / {fmtInt(c.b?.n)}</div>
          </div>
        ))}
        {match.data && Object.keys(match.data).length > 0 && (
          <div class="kcard" onClick={() => (S.tab.value = 'qa')}>
            <div class="nm"><span>714 匹配率</span><span class="tag">数据质量</span></div>
            <div class="vals num"><span class="big A">{fmt(match.data.A?.rate, 1)}%</span><span class="muted">/</span><span class="big B">{fmt(match.data.B?.rate, 1)}%</span></div>
            <div class="foot">未匹配 {fmtInt(match.data.A ? match.data.A.n - match.data.A.matched : null)} / {fmtInt(match.data.B ? match.data.B.n - match.data.B.matched : null)} 行（流控缺行属正常现象）</div>
          </div>
        )}
      </div>
      {cards.error && <div class="banner warn" style="margin-top:10px">统计失败：{String(cards.error.message || cards.error)}</div>}
      <ImpactTable />
    </div>
  );
}

function headline(cmp, rate, users) {
  if (!cmp || rate.diff == null) return 'B 相对 A 的差异概览';
  const who = users.length ? '所选用户速率' : '小区速率';
  const base = `B 相对 A：${who} ${fmtPct(rate.diff)}`;
  if (users.length) return base;
  const drag = cmp.rows.filter((r) => r.impact != null && r.impact <= -0.5).sort((a, b) => a.impact - b.impact).slice(0, 3);
  const lift = cmp.rows.filter((r) => r.impact != null && r.impact >= 0.5).sort((a, b) => b.impact - a.impact).slice(0, 3);
  if (rate.diff < 0 && drag.length) return `${base}，主要来自 ${drag.map((r) => r.userId).join('、')}`;
  if (rate.diff > 0 && lift.length) return `${base}，主要来自 ${lift.map((r) => r.userId).join('、')}`;
  return base;
}

function ImpactTable() {
  const cmp = S.t396.value;
  const sides = S.sides.value;
  const v = S.view.value;
  const ready = S.ready.value;
  const tableFilters = v.filters || [];
  const breakdown = useAsync(async (isStale) => {
    if (!ready) return null;
    const out = {};
    for (const k of ['A', 'B']) {
      const s = sides[k];
      if (!s || isStale()) continue;
      const rows = await userBreakdown(s, filterSql(tableFilters, s.columns, v.search));
      out[k] = new Map(rows.map((r) => [String(r.__u), r]));
    }
    return out;
  }, [S.dataVersion.value, JSON.stringify(tableFilters), v.search, ready]);
  if (!cmp) return null;
  const rows = cmp.rows.filter((r) => r.impact != null).sort((a, b) => a.impact - b.impact).slice(0, 8);
  const bd = breakdown.data;
  const companion = (u) => {
    if (!bd?.A || !bd?.B) return '';
    const a = bd.A.get(u), b = bd.B.get(u);
    if (!a || !b) return '';
    const parts = [];
    if (a.__bler != null && b.__bler != null && Math.abs(b.__bler - a.__bler) * 100 >= 1) parts.push(`BLER ${fmt(a.__bler * 100, 1)}%→${fmt(b.__bler * 100, 1)}%`);
    if (a.__mcs != null && b.__mcs != null && Math.abs(b.__mcs - a.__mcs) >= 0.5) parts.push(`MCS 均值 ${fmtDelta(b.__mcs - a.__mcs, 1)}`);
    if (a.__rank2 != null && b.__rank2 != null && Math.abs(b.__rank2 - a.__rank2) * 100 >= 3) parts.push(`Rank2 ${fmt(a.__rank2 * 100, 0)}%→${fmt(b.__rank2 * 100, 0)}%`);
    if (a.__trunc != null && b.__trunc != null && Math.abs(b.__trunc - a.__trunc) * 100 >= 1) parts.push(`截包 ${fmt(a.__trunc * 100, 1)}%→${fmt(b.__trunc * 100, 1)}%`);
    return parts.join('，') || '无明显伴随变化';
  };
  const focus = (u, chart) => {
    S.users.value = [u];
    S.tab.value = chart ? 'cht' : 'tbl';
  };
  return (
    <div class="section">
      <div class="sh"><b>最值得看的用户</b><span class="faint" style="font-size:12px">排序 = Rate 变化 × TTI 占比（对小区总速率的拖累，单位：百分点）</span></div>
      <div style="overflow:auto">
        <table class="t">
          <thead><tr><th class="left">用户</th><th>Rate A → B</th><th>变化</th><th>TTI 占比 A / B</th><th>对小区的拖累</th><th class="left">伴随变化（同一表格筛选下）</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr>
                <td class="left"><b>{r.userId}</b></td>
                <td class="num"><span class="A">{fmt(r.rateA, 2)}</span> → <span class="B">{fmt(r.rateB, 2)}</span></td>
                <td class={'num ' + (r.diffPct < 0 ? 'dn' : 'up')}>{fmtPct(r.diffPct)}</td>
                <td class="num">{fmt(r.shareA, 1)}% / {fmt(r.shareB, 1)}%</td>
                <td class={'num ' + (r.impact < 0 ? 'dn' : 'up')}>{fmtDelta(r.impact, 2, ' pt')}</td>
                <td class="left">{breakdown.loading ? <span class="faint">计算中…</span> : companion(r.userId)}</td>
                <td><button class="btn small" onClick={() => focus(r.userId, true)}>看图表</button> <button class="btn small" onClick={() => focus(r.userId, false)}>看明细</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
