import * as S from '../store.js';
import { useAsync } from './hooks.js';
import { cellOverview, cellBasics, userMetrics, joinRates, findings, groupFindings, findingFilters, checkCoverage, FINDING_RULES } from '../engine/single.js';
import { filterSql } from '../engine/query.js';
import { scopeRate } from '../engine/t396.js';
import { batchLabel } from '../engine/scan.js';
import { MAX_CHART_USERS, MAX_CHART_METRICS } from '../engine/config.js';
import { rateScopeLabel } from '../engine/analysis-scope.js';
import { ScopeNote } from './ScopeNote.jsx';
import { fmt, fmtInt } from './fmt.js';

function Spark({ cdf }) {
  if (!cdf?.x.length) return null;
  const lo = cdf.x[0], hi = cdf.x[cdf.x.length - 1];
  const d = cdf.x.map((x, i) => (i ? 'L' : 'M') + (((x - lo) / (hi - lo || 1)) * 240).toFixed(1) + ',' + (40 - cdf.y[i] * .4).toFixed(1)).join(' ');
  return <svg viewBox="-2 -2 244 44" width="100%" height="40" preserveAspectRatio="none" aria-label="分布（CDF）"><path d={d} fill="none" stroke="#2563eb" stroke-width="1.6" vector-effect="non-scaling-stroke" /></svg>;
}
const Bar = ({ value }) => <svg viewBox="0 0 240 14" width="100%" height="16" preserveAspectRatio="none"><rect x="0" y="2" width="240" height="10" rx="3" fill="#f1f3f5" /><rect x="0" y="2" width={Math.max(0, Math.min(100, value || 0) * 2.4)} height="10" rx="3" fill="#2563eb" /></svg>;
const PRIMARY = new Set(['mcs', 'bler', 'trunc']);

export function SingleOverview() {
  const side = S.sides.value.A;
  const v = S.view.value;
  const users = S.users.value;
  const ready = S.ready.value;
  const t396 = S.t396.value;
  const sel = S.selection.value.A;
  const ov = useAsync((stale) => ready && side ? cellOverview(side, filterSql(S.effectiveFilters.value, side.columns, v.search), stale) : null,
    [S.dataVersion.value, JSON.stringify(S.effectiveFilters.value), v.search, ready]);
  const check = useAsync(async (stale) => {
    if (!ready || !side) return null;
    const where = filterSql(v.filters, side.columns, v.search);
    const cell = await cellBasics(side, where);
    if (stale()) return null;
    const list = joinRates(await userMetrics(side, where), t396);
    const items = findings({ ...cell, rate: t396?.cellRateA ?? null }, list);
    return { cell, list, items, groups: groupFindings(items, list), coverage: checkCoverage(side, t396) };
  }, [S.dataVersion.value, JSON.stringify(v.filters), v.search, ready, t396]);
  const o = ov.data, c = check.data;
  const goChart = (metrics, selected) => {
    if (selected) S.users.value = selected;
    const next = [...new Set([...metrics.filter(Boolean), ...v.chartMetrics])];
    S.updateView({ chartMetrics: next.slice(0, MAX_CHART_METRICS) });
    if (selected?.length > MAX_CHART_USERS) S.showToast('已选全部用户；图表每次最多画 ' + MAX_CHART_USERS + ' 个，页面会显示数量。', 5000);
    S.tab.value = 'cht';
  };
  const inspect = (g, item) => {
    const event = findingFilters(item.id, c.cell);
    S.users.value = [g.user];
    S.tableSide.value = 'A';
    S.updateView({ filters: [...v.filters, ...event] });
    S.diagnosis.value = { user: g.user, title: item.title, baseFilters: [...v.filters], baseSearch: v.search, note: event.length ? '当前显示符合线索条件的候选行，仍需结合 TTI 上下文核实。' : 'T396 是全批次聚合值，不能映射到单个调度时刻；先查看该用户的调度明细。' };
    S.tab.value = 'tbl';
  };
  const metricCard = (card) => <div class="kcard" onClick={() => goChart([card.column])}>
    <div class="nm"><span>{card.label}</span></div>
    {card.kind === 'cats' ? <div class="cats">{card.cats.map((x) => <div class="catrow"><span>{x.value}</span><Bar value={x.share} /><span class="num">{fmt(x.share, 1)}%</span></div>)}</div> : <><div class="vals num"><span class="big A">{fmt(card.value, card.digits)}</span><span class="muted">{card.unit}</span></div>{card.kind === 'mean' ? <Spark cdf={card.cdf} /> : <Bar value={card.value} />}</>}
    <div class="foot">{card.kind === 'mean' ? 'P50 ' + fmt(card.p50, 2) + ' · P90 ' + fmt(card.p90, 2) + ' · 样本 ' + fmtInt(card.n) : card.kind === 'bler' ? '有效样本 ' + fmtInt(card.n) + ' · DTX 剔除 ' + fmtInt(card.dtx) : '样本 ' + fmtInt(card.n)}</div>
  </div>;
  const groupCard = (g) => <div class="finding user-finding">
    <div class="row"><b>用户 {g.user}</b><span class="tag warn">{g.items.length} 条线索</span><span class="sp" /><button class="btn small primary" onClick={() => { S.diagnosis.value = { user: g.user, title: g.items.map((i) => i.title).join('；'), baseFilters: [...v.filters], baseSearch: v.search, note: '以下为规则线索，并非已确认根因。点采样点可查看代表 TTI；框选区间可带到明细。' }; goChart(g.items.map((i) => i.metric), [g.user]); }}>看相关图表</button></div>
    <div class="muted num">调度 {fmtInt(g.metrics.rows)} 行 · 有效 ACK {fmtInt(g.metrics.valid)} · T396 占比 {fmt(g.metrics.share, 1)}% · Rate {fmt(g.metrics.rate, 2)}</div>
    {g.items.map((item) => <div class="finding-line"><div class="row"><span>{item.title}</span><span class="sp" /><button class="btn text small" onClick={() => inspect(g, item)}>定位{item.id === 'lowrate' ? '调度明细' : '候选行'}</button></div><div class="muted">{item.detail.find((x) => x.startsWith(g.user + '：')) || ''} · 规则：{item.rule}</div></div>)}
  </div>;
  return <div>
    <div class="headline"><div><b>{sel ? batchLabel(sel) : '本小区'}{o ? ' · ' + fmtInt(o.rows) + ' 行调度 · ' + fmtInt(o.users) + ' 个用户' : ''}{o?.time?.[0] ? ' · ' + o.time[0] + ' – ' + o.time[1] : ''}</b><div class="muted">范围：{users.length ? '已选 ' + users.length + ' 个用户：' + users.join('、') : '小区全部用户'}{o?.tti?.[0] != null ? ' · TTI ' + fmtInt(o.tti[0]) + ' – ' + fmtInt(o.tti[1]) : ''}</div></div><span class="muted">点卡片查看时序与分布</span></div>
    <ScopeNote />
    <div class="kgrid primary-metrics">
      {t396 && <div class="kcard" onClick={() => (S.tab.value = 'usr')}><div class="nm"><span>{users.length ? '所选用户 Rate（T396）' : '小区 Rate（T396）'}</span></div><div class="vals num"><span class="big A">{fmt(scopeRate(t396, users).a, 2)}</span></div><div class="foot">Rate = Σ dlThpVolRmvLastSlot / Σ dlThpTimeRmvLastSlot</div><div class="foot">{rateScopeLabel(users, v)}</div></div>}
      {!o && ov.loading && [1,2,3,4].map(() => <div class="kcard skeleton" style="height:118px" />)}
      {o?.cards.filter((x) => PRIMARY.has(x.id)).map(metricCard)}
      {o && <div class="kcard" onClick={() => (S.tab.value = 'qa')}><div class="nm"><span>714 匹配率</span><span class="tag">数据质量</span></div><div class="vals num"><span class="big A">{fmt(o.matchRate, 1)}%</span></div><div class="foot">BLER、OLLA 只代表匹配上且有效的记录。</div></div>}
    </div>
    {ov.error && <div class="banner warn">统计失败：{String(ov.error.message || ov.error)}</div>}
    <div class="section health-section">
      <div class="sh"><b>自动体检 · 最值得检查的用户</b><span class="muted">按用户合并线索；体检覆盖全部用户，受当前列筛选与搜索影响。</span></div>
      {check.loading && <div class="muted">正在更新体检…</div>}
      {!check.loading && c && <>
        <div class="check-coverage">已检查：{c.coverage.available.join('、') || '无可用指标'} · 各规则按有效样本判断，最低 {FINDING_RULES.minRows} 条。{c.coverage.missing.length > 0 && <span class="dn">缺少数据，未检查：{c.coverage.missing.join('、')}。</span>}</div>
        {!c.groups.length && <div class="banner info">当前规则未检出明显异常的用户；样本不足或缺少字段的规则不代表已通过。请结合数据质量与业务场景判断。</div>}
        <div class="findings">{c.groups.slice(0, 4).map(groupCard)}</div>
        {c.groups.length > 4 && <details class="more-findings"><summary>另有 {c.groups.length - 4} 个用户，展开查看全部线索</summary>{c.groups.slice(4).map(groupCard)}</details>}
        {c.items.filter((x) => x.quality).map((x) => <div class="banner warn"><b>{x.title}</b><span>{x.rule}</span><button class="btn small" onClick={() => (S.tab.value = 'qa')}>看数据质量</button></div>)}
        <details class="rule-findings"><summary>按规则查看原始体检结果与阈值</summary>{c.items.filter((x) => !x.quality).map((x) => <div class="finding"><div class="row"><b>{x.title}（{x.users.length} 个）</b><span class="sp" /><button class="btn small" onClick={() => goChart([x.metric], x.users)}>看图表</button><button class="btn small" onClick={() => { S.users.value = x.users; S.tab.value = 'usr'; }}>看用户表</button></div><div class="muted">规则：{x.rule}</div></div>)}</details>
      </>}
      {check.error && <div class="banner warn">体检失败：{String(check.error.message || check.error)}</div>}
    </div>
    <div class="section"><div class="sh"><b>其他指标与分布</b><span class="muted">与上方指标使用相同的用户、列筛选与搜索范围。</span></div><div class="kgrid">{o?.cards.filter((x) => !PRIMARY.has(x.id)).map(metricCard)}</div></div>
  </div>;
}