// 统计与画图取数：结论卡片、用户分解、图表数据。图形由前端绘制，这里只返回数据点与统计量。
// 长循环接受 isStale：界面已经换了条件时提前结束，不让过期查询堵住单连接队列。
import { query } from './db.js';
import { qi } from './sql.js';
import { filterSql, userScope } from './query.js';
import { MAX_CHART_POINTS, TRUNCATED_LIMIT } from './config.js';

const QUANTS = Array.from({ length: 101 }, (_, i) => i / 100);
const SPARK_QUANTS = Array.from({ length: 41 }, (_, i) => i / 40);

export class StaleError extends Error {
  constructor() { super('stale'); this.stale = true; }
}
const check = (isStale) => { if (isStale?.()) throw new StaleError(); };

const v = (metric) => `TRY_CAST(${qi(metric)} AS DOUBLE)`;

export async function metricSummary(side, metric, where, quants = QUANTS) {
  const [r] = await query(`SELECT count(x) AS count, avg(x) AS mean, stddev_samp(x) AS sd, min(x) AS min,
      quantile_cont(x, 0.5) AS p50, quantile_cont(x, 0.9) AS p90, max(x) AS max,
      quantile_cont(x, [${quants.join(',')}]) AS q
    FROM (SELECT ${v(metric)} AS x FROM ${qi(side.table)} WHERE ${where}) WHERE x IS NOT NULL AND NOT isnan(x)`);
  const q = r.q ? Array.from(r.q) : [];
  return { count: r.count, mean: r.mean, sd: r.sd, min: r.min, p50: r.p50, p90: r.p90, max: r.max, cdf: q.length ? { x: q, y: quants.map((p) => p * 100) } : null };
}

export async function sequencePoints(side, metric, where, count) {
  const stride = Math.max(1, Math.ceil(Math.max(count, 1) / MAX_CHART_POINTS));
  const hasTti = side.columns.includes('tti');
  const xExpr = hasTti ? `TRY_CAST("tti" AS DOUBLE)` : '__source_row';
  const rows = await query(`WITH o AS (
      SELECT ${xExpr} AS x, ${v(metric)} AS y, ROW_NUMBER() OVER (ORDER BY ${xExpr}, __source_row) AS k
      FROM ${qi(side.table)} WHERE ${where} AND ${v(metric)} IS NOT NULL AND ${xExpr} IS NOT NULL)
    SELECT x, y FROM o WHERE ((k - 1) % ${stride}) = 0 ORDER BY k LIMIT ${MAX_CHART_POINTS}`);
  return { x: rows.map((r) => r.x), y: rows.map((r) => r.y), xTitle: hasTti ? 'TTI' : '行序号', stride };
}

/** 类别频次：取前 limit 类，分母用该范围的总行数（不是前几类之和），其余合并为“其他”。 */
export async function categoryCounts(side, column, where, limit = 24) {
  const id = qi(column);
  const label = `CASE WHEN ${id} IS NULL OR TRIM(CAST(${id} AS VARCHAR)) = '' OR LOWER(CAST(${id} AS VARCHAR)) = 'nan' THEN 'NaN' ELSE CAST(${id} AS VARCHAR) END`;
  const rows = await query(`SELECT ${label} AS value, count(*) AS n FROM ${qi(side.table)} WHERE ${where} GROUP BY value ORDER BY n DESC, value LIMIT ${limit + 1}`);
  const [{ total }] = await query(`SELECT count(*) AS total FROM ${qi(side.table)} WHERE ${where}`);
  const top = rows.slice(0, limit);
  const shown = top.reduce((s, r) => s + r.n, 0);
  const values = top.map((r) => r.value);
  const counts = top.map((r) => r.n);
  if (total > shown) { values.push('其他'); counts.push(total - shown); }
  return { values, counts, total };
}

/** BLER：剔除 ack0 不为 0/1 的 DTX 后，BLER = 1 - mean(ack0)。按用户分组。 */
export async function blerByUser(side, where) {
  if (!side.columns.includes('714_ack0')) return null;
  const user = side.columns.includes('ambr') ? 'CAST(ambr AS VARCHAR)' : `'小区'`;
  const rows = await query(`SELECT ${user} AS u, count(*) FILTER (WHERE ack IN (0,1)) AS valid, count(*) FILTER (WHERE ack IS NOT NULL AND ack NOT IN (0,1)) AS dtx,
      1.0 - avg(ack) FILTER (WHERE ack IN (0,1)) AS bler
    FROM (SELECT *, TRY_CAST("714_ack0" AS DOUBLE) AS ack FROM ${qi(side.table)} WHERE ${where}) GROUP BY u ORDER BY valid DESC`);
  return rows.filter((r) => r.bler != null).map((r) => ({ user: r.u, valid: r.valid, dtx: r.dtx, bler: r.bler * 100 }));
}

/** 按用户一次性算出伴随指标，供“最值得看的用户”表使用。 */
export async function userBreakdown(side, where) {
  const has = (c) => side.columns.includes(c);
  if (!has('ambr')) return [];
  const sel = ['CAST(ambr AS VARCHAR) AS u', 'count(*) AS n'];
  if (has('cw0SuMcs')) sel.push(`avg(${v('cw0SuMcs')}) AS mcs`, `quantile_cont(${v('cw0SuMcs')}, 0.5) AS mcs_p50`);
  if (has('schRank')) sel.push(`avg(CASE WHEN ${v('schRank')} = 2 THEN 1.0 WHEN ${v('schRank')} IS NOT NULL THEN 0.0 END) AS rank2`);
  if (has('usrschpdschDrbData')) sel.push(`avg(CASE WHEN ${v('usrschpdschDrbData')} > 0 AND ${v('usrschpdschDrbData')} < ${TRUNCATED_LIMIT} THEN 1.0 WHEN ${v('usrschpdschDrbData')} IS NOT NULL THEN 0.0 END) AS trunc`);
  if (has('714_ack0')) sel.push(`1.0 - avg(${v('714_ack0')}) FILTER (WHERE ${v('714_ack0')} IN (0,1)) AS bler`);
  if (has('714_compOlla_scaled')) sel.push(`avg(${v('714_compOlla_scaled')}) AS olla`);
  return query(`SELECT ${sel.join(', ')} FROM ${qi(side.table)} WHERE ${where} AND ambr IS NOT NULL GROUP BY u`);
}

// ---------- 结论卡片 ----------

const CARD_DEFS = [
  { id: 'mcs', label: 'cw0SuMcs 均值', column: 'cw0SuMcs', kind: 'mean', better: 'up', unit: '', digits: 2, minDelta: 0.3, chart: 'cw0SuMcs' },
  { id: 'bler', label: 'BLER（714 ack0，剔除 DTX）', column: '714_ack0', kind: 'bler', better: 'down', unit: '%', digits: 2, minDelta: 0.5, chart: '714_ack0' },
  { id: 'rank2', label: 'schRank = 2 占比', column: 'schRank', kind: 'share', test: (x) => `${x} = 2`, better: 'up', unit: '%', digits: 1, minDelta: 1, chart: 'schRank' },
  { id: 'trunc', label: `截包占比（0 < data < ${TRUNCATED_LIMIT}）`, column: 'usrschpdschDrbData', kind: 'share', test: (x) => `${x} > 0 AND ${x} < ${TRUNCATED_LIMIT}`, better: 'down', unit: '%', digits: 2, minDelta: 0.5, chart: 'usrschpdschDrbData' },
  { id: 'olla', label: 'compOlla 均值（÷1024000）', column: '714_compOlla_scaled', kind: 'mean', better: null, unit: 'dB', digits: 2, minDelta: 0.2, chart: '714_compOlla_scaled' },
  { id: 'tb0', label: 'tb0SchMcs 均值', column: 'tb0SchMcs', kind: 'mean', better: 'up', unit: '', digits: 2, minDelta: 0.3, chart: 'tb0SchMcs' },
];

async function cardSide(side, def, where) {
  if (!side || !side.columns.includes(def.column)) return null;
  const x = v(def.column);
  if (def.kind === 'mean') {
    const s = await metricSummary(side, def.column, where, SPARK_QUANTS);
    return { value: s.mean, n: s.count, sd: s.sd, cdf: s.cdf };
  }
  if (def.kind === 'bler') {
    const [r] = await query(`SELECT count(*) FILTER (WHERE ${x} IN (0,1)) AS n, 1.0 - avg(${x}) FILTER (WHERE ${x} IN (0,1)) AS p FROM ${qi(side.table)} WHERE ${where}`);
    return { value: r.p == null ? null : r.p * 100, n: r.n, p: r.p };
  }
  const [r] = await query(`SELECT count(${x}) AS n, avg(CASE WHEN ${def.test(x)} THEN 1.0 WHEN ${x} IS NOT NULL THEN 0.0 END) AS p FROM ${qi(side.table)} WHERE ${where}`);
  return { value: r.p == null ? null : r.p * 100, n: r.n, p: r.p };
}

/**
 * 判定：样本 < 200 为“样本不足”；变化小于实用阈值或近似 z < 3 为“持平”；否则按指标方向判回退/改善。
 * TTI 样本存在自相关，z 值只作排序护栏，不当作严格显著性。
 */
export function verdict(def, a, b) {
  if (!a || !b || a.value == null || b.value == null) return { level: 'na', text: '缺数据' };
  if (Math.min(a.n, b.n) < 200) return { level: 'low', text: '样本不足' };
  const delta = b.value - a.value;
  let z;
  if (def.kind === 'mean') {
    const se = Math.sqrt((a.sd ** 2) / a.n + (b.sd ** 2) / b.n) || 1e-9;
    z = delta / se;
  } else {
    const p = (a.p * a.n + b.p * b.n) / (a.n + b.n);
    const se = Math.sqrt(p * (1 - p) * (1 / a.n + 1 / b.n)) || 1e-9;
    z = (b.p - a.p) / se;
  }
  if (Math.abs(delta) < def.minDelta || Math.abs(z) < 3) return { level: 'eq', text: '持平', z };
  if (!def.better) return { level: 'chg', text: delta > 0 ? '升高' : '降低', z };
  const good = def.better === 'up' ? delta > 0 : delta < 0;
  return { level: good ? 'good' : 'bad', text: good ? '改善' : '回退', z };
}

export async function summaryCards(sides, filters, search, isStale) {
  const out = [];
  for (const def of CARD_DEFS) {
    check(isStale);
    const where = (s) => (s ? filterSql(filters, s.columns, search) : 'TRUE');
    const a = await cardSide(sides.A, def, where(sides.A));
    const b = await cardSide(sides.B, def, where(sides.B));
    if (!a && !b) continue;
    out.push({ ...def, test: undefined, a, b, verdict: verdict(def, a, b) });
  }
  return out;
}

export async function matchStats(sides, filters, search) {
  const out = {};
  for (const k of ['A', 'B']) {
    const s = sides[k];
    if (!s) continue;
    const [r] = await query(`SELECT count(*) AS n, count(*) FILTER (WHERE "714_匹配状态" = '已匹配') AS m FROM ${qi(s.table)} WHERE ${filterSql(filters, s.columns, search)}`);
    out[k] = { n: r.n, matched: r.m, rate: r.n ? (r.m / r.n) * 100 : null };
  }
  return out;
}

// ---------- 图表 ----------

/**
 * scopes: [{key, label, users: [..] | null}]；返回每个指标 × 范围 × 方案 的数据。
 */
export async function chartData(sides, { metrics, filters, search, scopes, onProgress, isStale }) {
  const result = [];
  const total = metrics.length * scopes.length;
  let done = 0;
  for (const metric of metrics) {
    const numeric = ['A', 'B'].some((k) => sides[k]?.numericColumns.includes(metric));
    const entry = { metric, numeric, scopes: [] };
    for (const scope of scopes) {
      const row = { key: scope.key, label: scope.label, sides: {} };
      for (const k of ['A', 'B']) {
        check(isStale);
        const s = sides[k];
        if (!s || !s.columns.includes(metric)) continue;
        if (scope.users && !s.columns.includes('ambr')) continue; // 本侧无法按用户区分，宁可不画也不混入全小区数据
        const f = scope.users ? [...filters, userScope(scope.users)] : filters;
        const where = filterSql(f, s.columns, search);
        if (numeric) {
          const stats = await metricSummary(s, metric, where);
          const seq = stats.count ? await sequencePoints(s, metric, where, stats.count) : { x: [], y: [] };
          row.sides[k] = { stats, seq };
        } else {
          row.sides[k] = { cats: await categoryCounts(s, metric, where) };
        }
      }
      entry.scopes.push(row);
      done++;
      onProgress?.(done / total, `${metric} · ${scope.label}`);
    }
    result.push(entry);
  }
  return result;
}

export async function blerChart(sides, filters, search, users) {
  const out = {};
  for (const k of ['A', 'B']) {
    const s = sides[k];
    if (!s) continue;
    const f = users?.length ? [...filters, userScope(users)] : filters;
    const rows = await blerByUser(s, filterSql(f, s.columns, search));
    if (rows) out[k] = rows;
  }
  return Object.keys(out).length ? out : null;
}
