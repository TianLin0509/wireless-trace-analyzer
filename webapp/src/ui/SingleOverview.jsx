// 单小区 · 概览：这个小区整体怎么样（关键指标与分布）+ 自动体检（哪些用户值得看）。
import * as S from '../store.js';
import { useAsync } from './hooks.js';
import { cellOverview, cellBasics, userMetrics, joinRates, findings, FINDING_RULES } from '../engine/single.js';
import { filterSql } from '../engine/query.js';
import { scopeRate } from '../engine/t396.js';
import { batchLabel } from '../engine/scan.js';
import { fmt, fmtInt } from './fmt.js';

function Spark({ cdf }) {
  if (!cdf) return null;
  const lo = cdf.x[0], hi = cdf.x[cdf.x.length - 1];
  const w = 240, h = 40;
  const d = cdf.x.map((x, i) => `${i ? 'L' : 'M'}${(((x - lo) / (hi - lo || 1)) * w).toFixed(1)},${(h - (cdf.y[i] / 100) * h).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`-2 -2 ${w + 4} ${h + 4}`} width="100%" height="40" preserveAspectRatio="none" aria-label="分布（CDF）">
      <path d={d} fill="none" stroke="#2563eb" stroke-width="1.6" vector-effect="non-scaling-stroke" />
    </svg>
  );
}

const Bar = ({ value }) => (
  <svg viewBox="0 0 240 14" width="100%" height="16" preserveAspectRatio="none">
    <rect x="0" y="2" width="240" height="10" rx="3" fill="#f1f3f5" />
    <rect x="0" y="2" width={Math.max(1.5, Math.min(100, value || 0) * 2.4)} height="10" rx="3" fill="#2563eb" />
  </svg>
);

export function SingleOverview() {
  const sideA = S.sides.value.A;
  const v = S.view.value;
  const filters = S.effectiveFilters.value;
  const users = S.users.value;
  const ready = S.ready.value;
  const t396 = S.t396.value;
  const sel = S.selection.value.A;
  const key = [S.dataVersion.value, JSON.stringify(filters), v.search, ready];
  const ov = useAsync((isStale) => (ready && sideA ? cellOverview(sideA, filterSql(filters, sideA.columns, v.search), isStale) : null), key);
  // 体检：总是基于小区全部用户（只受表格筛选影响，不受左侧用户选择影响）
  const tableFilters = v.filters || [];
  const check = useAsync(async () => {
    if (!ready || !sideA) return null;
    const where = filterSql(tableFilters, sideA.columns, v.search);
    const cell = await cellBasics(sideA, where);
    const list = await userMetrics(sideA, where);
    return findings({ ...cell, rate: t396?.cellRateA ?? null }, joinRates(list, t396));
  }, [S.dataVersion.value, JSON.stringify(tableFilters), v.search, ready, t396]);

  const rate = scopeRate(t396, users).a;
  const o = ov.data;
  const goChart = (metric, list) => {
    if (list) S.users.value = list.slice(0, 12);
    if (metric) S.updateView({ chartMetrics: [metric, ...v.chartMetrics.filter((m) => m !== metric)].slice(0, 8) });
    S.tab.value = 'cht';
  };
  const scopeText = users.length ? `已选 ${users.length} 个用户：${users.slice(0, 6).join('、')}${users.length > 6 ? '…' : ''}` : '小区全部用户';

  return (
    <div>
      <div class="headline">
        <div>
          <b>{sel ? batchLabel(sel) : '本小区'}{o ? ` · ${fmtInt(o.rows)} 行调度 · ${fmtInt(o.users)} 个用户` : ''}{o?.time?.[0] ? ` · ${o.time[0]} – ${o.time[1]}` : ''}</b>
          <div class="muted" style="font-size:12px">范围：{scopeText} · 表格筛选 {(v.filters || []).length ? `${v.filters.length} 项` : '无'}{v.search ? ` · 搜索“${v.search}”` : ''}{o?.tti?.[0] != null ? ` · TTI ${fmtInt(o.tti[0])} – ${fmtInt(o.tti[1])}` : ''}</div>
        </div>
        <span class="faint" style="font-size:12px;white-space:nowrap">点卡片 → 看该指标的时序与分布</span>
      </div>
      <div class="kgrid">
        {t396 && (
          <div class="kcard" onClick={() => (S.tab.value = 'usr')}>
            <div class="nm"><span>{users.length ? '所选用户 Rate（T396）' : '小区 Rate（T396）'}</span></div>
            <div class="vals num"><span class="big A">{fmt(rate, 2)}</span></div>
            <div class="foot">Rate = Σ dlThpVolRmvLastSlot / Σ dlThpTimeRmvLastSlot · {t396.rows.length} 个用户</div>
          </div>
        )}
        {!o && ov.loading && [1, 2, 3, 4, 5, 6].map(() => <div class="kcard skeleton" style="height:118px" />)}
        {o?.cards.map((c) => (
          <div class="kcard" onClick={() => goChart(c.column)}>
            <div class="nm"><span>{c.label}</span></div>
            {c.kind === 'cats' ? (
              <div class="cats">{c.cats.map((x) => <div class="catrow"><span>{x.value}</span><Bar value={x.share} /><span class="num">{fmt(x.share, 1)}%</span></div>)}</div>
            ) : (
              <>
                <div class="vals num"><span class="big A">{fmt(c.value, c.digits)}</span><span class="muted" style="font-size:11px">{c.unit}</span></div>
                {c.kind === 'mean' ? <Spark cdf={c.cdf} /> : <Bar value={c.value} />}
              </>
            )}
            <div class="foot">
              {c.kind === 'mean' ? `P50 ${fmt(c.p50, 2)} · P90 ${fmt(c.p90, 2)} · 样本 ${fmtInt(c.n)}` : c.kind === 'bler' ? `有效样本 ${fmtInt(c.n)} · DTX 剔除 ${fmtInt(c.dtx)}` : `样本 ${fmtInt(c.n)}`}
            </div>
          </div>
        ))}
        {o && (
          <div class="kcard" onClick={() => (S.tab.value = 'qa')}>
            <div class="nm"><span>714 匹配率</span><span class="tag">数据质量</span></div>
            <div class="vals num"><span class="big A">{fmt(o.matchRate, 1)}%</span></div>
            <div class="foot">537 每行按 crnti + 时间 + 帧 + 时隙匹配 714</div>
          </div>
        )}
      </div>
      {ov.error && <div class="banner warn" style="margin-top:10px">统计失败：{String(ov.error.message || ov.error)}</div>}
      <div class="section">
        <div class="sh"><b>自动体检</b><span class="faint" style="font-size:12px">按固定规则找出值得看的用户（针对小区全部用户；阈值见每条说明）。点“看图表”会选中这些用户。</span></div>
        {check.loading && !check.data && <div class="faint">正在体检…</div>}
        {check.data && !check.data.length && <div class="banner info">没有发现明显异常的用户（规则：BLER、速率×占比、截包、MCS、OLLA、DTX，样本 ≥ {FINDING_RULES.minRows}）。</div>}
        <div class="findings">
          {check.data?.map((f) => (
            <div class={'finding ' + f.level}>
              <div class="row" style="align-items:baseline">
                <b>{f.level === 'warn' ? '⚠ ' : 'ℹ '}{f.title}{f.users.length ? `（${f.users.length} 个）` : ''}</b>
                <span class="sp" />
                {f.quality ? <button class="btn small" onClick={() => (S.tab.value = 'qa')}>看数据质量</button> : (
                  <>
                    <button class="btn small" onClick={() => goChart(f.metric, f.users)}>看图表</button>
                    <button class="btn small" onClick={() => { S.users.value = f.users.slice(0, 40); S.tab.value = 'usr'; }}>看用户表</button>
                  </>
                )}
              </div>
              {f.detail.length > 0 && <div class="num" style="font-size:13px;margin-top:2px">{f.detail.join('；')}{f.more ? `；另有 ${f.more} 个` : ''}</div>}
              <div class="faint" style="font-size:11px;margin-top:2px">规则：{f.rule}</div>
            </div>
          ))}
        </div>
        {check.error && <div class="banner warn">体检失败：{String(check.error.message || check.error)}</div>}
      </div>
    </div>
  );
}
