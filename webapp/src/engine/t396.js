// T396 A/B 对比与多组 KPI 回归雷达（口径与旧版 build_t396_comparison / build_kpi_regression_radar 一致）。

const cellRate = (agg) => {
  const vol = agg.reduce((s, r) => s + (r.sumVol || 0), 0);
  const time = agg.reduce((s, r) => s + (r.sumTime || 0), 0);
  return time > 0 ? vol / time : null;
};
const pct = (a, b) => (a != null && a !== 0 && b != null ? ((b - a) / a) * 100 : null);

export function compareT396(aggA = [], aggB = []) {
  const byA = new Map(aggA.map((r) => [r.userId, r]));
  const byB = new Map(aggB.map((r) => [r.userId, r]));
  const totalA = aggA.reduce((s, r) => s + (r.sumTime || 0), 0);
  const totalB = aggB.reduce((s, r) => s + (r.sumTime || 0), 0);
  const users = [...new Set([...byA.keys(), ...byB.keys()])];
  const rows = users.map((u) => {
    const a = byA.get(u), b = byB.get(u);
    const shareA = a && totalA > 0 ? (a.sumTime / totalA) * 100 : null;
    const shareB = b && totalB > 0 ? (b.sumTime / totalB) * 100 : null;
    const diff = pct(a?.rate, b?.rate);
    const share = Math.max(shareA || 0, shareB || 0);
    return {
      userId: u, rateA: a?.rate ?? null, rateB: b?.rate ?? null, diffPct: diff,
      sumVolA: a?.sumVol ?? 0, sumVolB: b?.sumVol ?? 0, sumTimeA: a?.sumTime ?? 0, sumTimeB: b?.sumTime ?? 0,
      shareA, shareB, maxShare: share,
      // 对小区速率的拖累（百分点）：用户 Rate 变化 × TTI 占比
      impact: diff != null ? (diff * share) / 100 : null,
    };
  });
  rows.sort((x, y) => y.maxShare - x.maxShare || x.userId.localeCompare(y.userId));
  const rateA = cellRate(aggA), rateB = cellRate(aggB);
  return { available: !!(aggA.length || aggB.length), cellRateA: rateA, cellRateB: rateB, diffPct: pct(rateA, rateB), totalTimeA: totalA, totalTimeB: totalB, rows };
}

/** 选中若干用户时的合计 Rate：Σvol / Σtime。 */
export function scopeRate(comparison, users) {
  if (!comparison) return { a: null, b: null, diff: null };
  if (!users?.length) return { a: comparison.cellRateA, b: comparison.cellRateB, diff: comparison.diffPct };
  const set = new Set(users);
  const sel = comparison.rows.filter((r) => set.has(r.userId));
  const sum = (k) => sel.reduce((s, r) => s + (r[k] || 0), 0);
  const a = sum('sumTimeA') > 0 ? sum('sumVolA') / sum('sumTimeA') : null;
  const b = sum('sumTimeB') > 0 ? sum('sumVolB') / sum('sumTimeB') : null;
  return { a, b, diff: pct(a, b) };
}

export function regressionRadar(groups) {
  const order = { critical: 0, warning: 1, watch: 2, insufficient: 3, flat: 4, improved: 5 };
  const ranked = groups.map((g) => {
    const c = g.comparison || {};
    const diff = c.diffPct ?? null;
    const ta = c.totalTimeA || 0, tb = c.totalTimeB || 0;
    const balance = Math.max(ta, tb) > 0 ? Math.min(ta, tb) / Math.max(ta, tb) : 0;
    const rows = c.rows || [];
    const comparable = rows.filter((r) => r.rateA != null && r.rateB != null);
    const overlap = comparable.length / Math.max(rows.length, 1);
    const evidence = balance * 0.6 + overlap * 0.4;
    const impacted = comparable
      .filter((r) => r.diffPct != null && r.diffPct < 0)
      .map((r) => ({ userId: r.userId, diffPct: r.diffPct, share: r.maxShare, impact: (Math.abs(r.diffPct) * r.maxShare) / 100 }))
      .sort((x, y) => y.impact - x.impact);
    const top = impacted[0]?.impact || 0;
    const decline = Math.max(0, -(diff || 0));
    const score = Math.min(100, Math.min(decline / 20, 1) * 70 + Math.min(top / 15, 1) * 20 + evidence * 10);
    let risk;
    if (diff == null) risk = 'insufficient';
    else if (diff <= -10 || score >= 70) risk = 'critical';
    else if (diff <= -5 || score >= 40) risk = 'warning';
    else if (diff < 0) risk = 'watch';
    else if (diff > 0) risk = 'improved';
    else risk = 'flat';
    return { ...g, diffPct: diff, score, risk, evidence: evidence >= 0.85 ? '高' : evidence >= 0.6 ? '中' : '低', topUsers: impacted.slice(0, 5) };
  });
  ranked.sort((x, y) => order[x.risk] - order[y.risk] || y.score - x.score || String(x.label).localeCompare(String(y.label)));
  return ranked;
}

export const RISK_TEXT = { critical: '严重回退', warning: '回退', watch: '轻微回退', insufficient: '数据不足', flat: '持平', improved: '改善' };
