// 单小区分析：小区概览、逐用户指标、自动体检。只用一侧（A）的合并表与 T396 结果。
// 口径与 A/B 模式一致：BLER 剔除 ack0 非 0/1 的 DTX；截包 = 0 < usrschpdschDrbData < 500；Rate = Σvol / Σtime。
import { query } from './db.js';
import { qi } from './sql.js';
import { metricSummary, categoryCounts } from './stats.js';
import { TRUNCATED_LIMIT } from './config.js';
import { rankBase, initCond } from './diagnose.js';

const v = (c) => `TRY_CAST(${qi(c)} AS DOUBLE)`;
/** OLLA 指标优先用外环累计量 mcsOffset[0]（公司样例注释：外环累计量/1024000，单位 MCS 阶），没有再用 compOlla。 */
export const ollaColumn = (columns) => (columns.includes('714_mcsOffset0_scaled') ? '714_mcsOffset0_scaled' : columns.includes('714_compOlla_scaled') ? '714_compOlla_scaled' : null);
const SPARK = Array.from({ length: 41 }, (_, i) => i / 40);

/** 概览卡片定义：mean = 均值类（带分布），share = 占比类，cats = 类别构成。 */
export const OVERVIEW_CARDS = [
  { id: 'mcs', label: 'MCS 均值（cw0SuMcs，初传）', column: 'cw0SuMcs', kind: 'mean', digits: 2, initOnly: true },
  { id: 'tb0', label: '最终调度 MCS 均值（tb0SchMcs，初传）', column: 'tb0SchMcs', kind: 'mean', digits: 2, initOnly: true },
  { id: 'bler', label: 'BLER（剔除 DTX）', column: '714_ack0', kind: 'bler', unit: '%', digits: 2 },
  { id: 'rank2', label: '多流占比（≥ 2 层）', column: 'schRank', kind: 'share', test: (x, base = 0) => `${x} + ${base} >= 2`, unit: '%', digits: 1 },
  { id: 'trunc', label: `截包占比（0 < data < ${TRUNCATED_LIMIT}）`, column: 'usrschpdschDrbData', kind: 'share', test: (x) => `${x} > 0 AND ${x} < ${TRUNCATED_LIMIT}`, unit: '%', digits: 2 },
  { id: 'rb', label: 'RB 数均值（allocRbNum）', column: 'allocRbNum', kind: 'mean', digits: 1 },
  { id: 'cqi', label: 'CQI 均值（bandCqiCw0）', column: 'bandCqiCw0', kind: 'mean', digits: 2 },
  { id: 'olla', label: 'OLLA 外环累计量（mcsOffset÷1024000）', column: '714_mcsOffset0_scaled', kind: 'mean', unit: 'MCS 阶', digits: 2 },
  { id: 'offset', label: '补偿 OLLA（compOlla÷1024000）', column: '714_compOlla_scaled', kind: 'mean', unit: '阶', digits: 2 },
  { id: 'schType', label: 'schType 构成', column: 'schType', kind: 'cats' },
  { id: 'suOrMu', label: 'SU / MU 构成（suOrMuFlag）', column: 'suOrMuFlag', kind: 'cats' },
];

export async function cellOverview(side, where, isStale) {
  const has = (c) => side.columns.includes(c);
  const rbase = await rankBase(side);
  const [base] = await query(`SELECT count(*) AS __n,
      ${has('ambr') ? `count(DISTINCT "ambr")` : 'NULL'} AS __users,
      ${has('tti') ? `min(${v('tti')}) AS __tti0, max(${v('tti')})` : 'NULL AS __tti0, NULL'} AS __tti1,
      ${has('HH:MM:SS') ? `min(CAST("HH:MM:SS" AS VARCHAR)) AS __t0, max(CAST("HH:MM:SS" AS VARCHAR))` : 'NULL AS __t0, NULL'} AS __t1,
      count(*) FILTER (WHERE "714_匹配状态" = '已匹配') AS __matched
    FROM ${qi(side.table)} WHERE ${where}`);
  const cards = [];
  for (const def of OVERVIEW_CARDS) {
    if (isStale?.()) return null;
    if (!has(def.column)) continue;
    const x = v(def.column);
    if (def.kind === 'mean') {
      const s = await metricSummary(side, def.column, def.initOnly ? `${where} AND ${initCond(side.columns)}` : where, SPARK);
      cards.push({ ...def, test: undefined, value: s.mean, n: s.count, p50: s.p50, p90: s.p90, min: s.min, max: s.max, cdf: s.cdf });
    } else if (def.kind === 'bler') {
      const [r] = await query(`SELECT count(*) FILTER (WHERE ${x} IN (0,1)) AS __valid, count(*) FILTER (WHERE ${x} IS NOT NULL AND ${x} NOT IN (0,1)) AS __dtx,
          1.0 - avg(${x}) FILTER (WHERE ${x} IN (0,1)) AS __p FROM ${qi(side.table)} WHERE ${where}`);
      cards.push({ ...def, value: r.__p == null ? null : r.__p * 100, n: r.__valid, dtx: r.__dtx });
    } else if (def.kind === 'share') {
      const [r] = await query(`SELECT count(${x}) AS __n, avg(CASE WHEN ${def.test(x, rbase)} THEN 1.0 WHEN ${x} IS NOT NULL THEN 0.0 END) AS __p FROM ${qi(side.table)} WHERE ${where}`);
      cards.push({ ...def, test: undefined, value: r.__p == null ? null : r.__p * 100, n: r.__n, ...(def.id === 'rank2' ? { label: `多流占比（≥ 2 层；schRank ${rbase ? '从 0 起编' : '从 1 起编'}）` } : {}) });
    } else {
      const c = await categoryCounts(side, def.column, where, 4);
      cards.push({ ...def, cats: c.values.map((val, i) => ({ value: val, share: c.total ? (c.counts[i] / c.total) * 100 : 0 })), n: c.total });
    }
  }
  return {
    rows: base.__n, users: base.__users, tti: [base.__tti0, base.__tti1], time: [base.__t0, base.__t1],
    matchRate: base.__n ? (base.__matched / base.__n) * 100 : null, cards,
  };
}

/** 体检用的小区整体值（一次查询）：MCS 均值、BLER、截包占比、OLLA 均值、714 匹配率。 */
export async function cellBasics(side, where) {
  const has = (c) => side.columns.includes(c);
  const a = v('714_ack0'), d = v('usrschpdschDrbData');
  const [r] = await query(`SELECT count(*) AS __n, count(*) FILTER (WHERE "714_匹配状态" = '已匹配') AS __m,
      ${has('cw0SuMcs') ? `avg(${v('cw0SuMcs')})` : 'NULL'} AS __mcs,
      ${has('714_ack0') ? `(1.0 - avg(${a}) FILTER (WHERE ${a} IN (0,1))) * 100` : 'NULL'} AS __bler,
      ${has('usrschpdschDrbData') ? `avg(CASE WHEN ${d} > 0 AND ${d} < ${TRUNCATED_LIMIT} THEN 1.0 WHEN ${d} IS NOT NULL THEN 0.0 END) * 100` : 'NULL'} AS __trunc,
      ${ollaColumn(side.columns) ? `avg(${v(ollaColumn(side.columns))})` : 'NULL'} AS __olla
    FROM ${qi(side.table)} WHERE ${where}`);
  return { mcs: r.__mcs, bler: r.__bler, trunc: r.__trunc, olla: r.__olla, ollaColumn: ollaColumn(side.columns), matchRate: r.__n ? (r.__m / r.__n) * 100 : null };
}

/** 逐用户指标（按 ambr 分组）。where 不含用户范围：表里总是列出全部用户。 */
export async function userMetrics(side, where) {
  const has = (c) => side.columns.includes(c);
  const base = await rankBase(side);
  if (!has('ambr')) return [];
  const sel = ['CAST("ambr" AS VARCHAR) AS __u', 'count(*) AS __n'];
  if (has('cw0SuMcs')) sel.push(`avg(${v('cw0SuMcs')}) AS __mcs`);
  if (has('tb0SchMcs')) sel.push(`avg(${v('tb0SchMcs')}) AS __tb0`);
  if (has('schRank')) sel.push(`avg(CASE WHEN ${v('schRank')} + ${base} >= 2 THEN 1.0 WHEN ${v('schRank')} IS NOT NULL THEN 0.0 END) * 100 AS __rank2`);
  if (has('usrschpdschDrbData')) sel.push(`avg(CASE WHEN ${v('usrschpdschDrbData')} > 0 AND ${v('usrschpdschDrbData')} < ${TRUNCATED_LIMIT} THEN 1.0 WHEN ${v('usrschpdschDrbData')} IS NOT NULL THEN 0.0 END) * 100 AS __trunc`);
  if (has('714_ack0')) {
    const a = v('714_ack0');
    sel.push(`(1.0 - avg(${a}) FILTER (WHERE ${a} IN (0,1))) * 100 AS __bler`, `count(*) FILTER (WHERE ${a} IN (0,1)) AS __valid`, `count(*) FILTER (WHERE ${a} IS NOT NULL AND ${a} NOT IN (0,1)) AS __dtx`);
  }
  if (ollaColumn(side.columns)) sel.push(`avg(${v(ollaColumn(side.columns))}) AS __olla`);
  if (has('allocRbNum')) sel.push(`avg(${v('allocRbNum')}) AS __rb`);
  if (has('bandCqiCw0')) sel.push(`avg(${v('bandCqiCw0')}) AS __cqi`);
  const rows = await query(`SELECT ${sel.join(', ')} FROM ${qi(side.table)} WHERE ${where} AND "ambr" IS NOT NULL GROUP BY __u ORDER BY __n DESC`);
  return rows.map((r) => ({
    user: String(r.__u), rows: r.__n, mcs: r.__mcs ?? null, tb0: r.__tb0 ?? null, rank2: r.__rank2 ?? null, trunc: r.__trunc ?? null,
    bler: r.__bler ?? null, valid: r.__valid ?? 0, dtx: r.__dtx ?? 0, olla: r.__olla ?? null, rb: r.__rb ?? null, cqi: r.__cqi ?? null,
  }));
}

/** 把 T396 的速率与 TTI 占比并入逐用户指标。 */
export function joinRates(users, t396) {
  const byUser = new Map((t396?.rows || []).map((r) => [r.userId, r]));
  const out = users.map((u) => ({ ...u, rate: byUser.get(u.user)?.rateA ?? null, share: byUser.get(u.user)?.shareA ?? null }));
  // 只在 T396 里出现、537 里没有调度记录的用户也列出来
  for (const [id, r] of byUser) if (!users.some((u) => u.user === id)) out.push({ user: id, rows: 0, rate: r.rateA, share: r.shareA });
  return out;
}

/** 同一用户的线索合并展示，仍保留每条规则和有效样本，不推断根因。 */
export function groupFindings(items, users) {
  const metrics = new Map(users.map((u) => [u.user, u]));
  const groups = new Map();
  for (const item of items) for (const id of item.users) {
    if (!groups.has(id)) groups.set(id, { user: id, metrics: metrics.get(id) || {}, items: [] });
    groups.get(id).items.push(item);
  }
  return [...groups.values()].sort((a, b) => {
    const score = (g) => g.items.reduce((n, i) => n + (i.level === 'warn' ? 2 : 1), 0);
    return score(b) - score(a) || (b.metrics.share || 0) - (a.metrics.share || 0) || a.user.localeCompare(b.user, 'zh', { numeric: true });
  });
}

/** 指标平均值触发规则后，下面的条件仅定位候选行，不能当成已确认根因。 */
export function findingFilters(id, cell, R = FINDING_RULES) {
  const condition = (column, op, value) => ({ column, op, value });
  switch (id) {
    case 'bler': return [condition('714_ack0', 'eq_num', 0)];
    case 'trunc': return [condition('usrschpdschDrbData', 'gt', 0), condition('usrschpdschDrbData', 'lt', TRUNCATED_LIMIT)];
    case 'mcs': return [condition('cw0SuMcs', 'lte', cell.mcs - R.mcsDrop)];
    case 'olla': return [condition(cell.ollaColumn || '714_mcsOffset0_scaled', 'lte', cell.olla - R.ollaDrop)];
    case 'dtx': return [condition('714_ack0', 'not_null'), condition('714_ack0', 'not_in', [0, 1])];
    default: return []; // T396 聚合速率无法映射到单个 T537 时刻
  }
}

export function checkCoverage(side, t396) {
  const definitions = [
    ['BLER', '714_ack0'], ['截包', 'usrschpdschDrbData'], ['MCS', 'cw0SuMcs'],
    ['OLLA', ollaColumn(side.columns) || '714_mcsOffset0_scaled'], ['DTX', '714_ack0'],
  ];
  const available = definitions.filter(([, c]) => side.columns.includes(c)).map(([n]) => n);
  const missing = definitions.filter(([, c]) => !side.columns.includes(c)).map(([n]) => n);
  (t396?.cellRateA != null ? available : missing).push('速率×占比');
  return { available, missing };
}

export const FINDING_RULES = {
  minRows: 200,
  blerAbs: 10, blerRel: 2,
  lowRate: 0.5, lowRateShare: 5,
  truncAbs: 5, truncRel: 2,
  ollaDrop: 2,
  mcsDrop: 5,
  dtxShare: 10,
  matchRate: 90,
};

/**
 * 自动体检：按透明规则找出值得看的用户（阈值写在 FINDING_RULES 里，界面上原样显示）。
 * cell：小区整体（mcs / bler / trunc / olla / rate / matchRate）；users：joinRates 的结果。
 */
export function findings(cell, users, R = FINDING_RULES) {
  const out = [];
  const enough = (u) => (u.rows || 0) >= R.minRows;
  const add = (id, level, title, rule, list, metric, fmtUser) => {
    if (list.length) out.push({ id, level, title, rule, users: list.map((u) => u.user), detail: list.slice(0, 6).map(fmtUser), more: Math.max(0, list.length - 6), metric });
  };
  const f1 = (x) => (x == null ? '—' : x.toFixed(1));
  if (cell.bler != null) {
    const th = Math.max(R.blerAbs, cell.bler * R.blerRel);
    add('bler', 'warn', 'BLER 偏高的用户', `有效样本 ≥ ${R.minRows} 且 BLER ≥ max(${R.blerAbs}%, 小区 ${f1(cell.bler)}% × ${R.blerRel}) = ${f1(th)}%`,
      users.filter((u) => u.bler != null && (u.valid || 0) >= R.minRows && u.bler >= th).sort((a, b) => b.bler - a.bler), '714_ack0', (u) => `${u.user}：${f1(u.bler)}%`);
  }
  if (cell.rate != null) {
    add('lowrate', 'warn', '速率低且占用 TTI 多（优先检查）', `T396 速率 < 小区 ${f1(cell.rate)} × ${R.lowRate}，且 TTI 占比 ≥ ${R.lowRateShare}%`,
      users.filter((u) => u.rate != null && u.share != null && u.rate < cell.rate * R.lowRate && u.share >= R.lowRateShare).sort((a, b) => b.share - a.share), 'cw0SuMcs',
      (u) => `${u.user}：Rate ${u.rate.toFixed(2)} · 占比 ${f1(u.share)}%`);
  }
  if (cell.trunc != null) {
    const th = Math.max(R.truncAbs, cell.trunc * R.truncRel);
    add('trunc', 'warn', '截包偏多的用户', `调度行数 ≥ ${R.minRows} 且截包占比 ≥ max(${R.truncAbs}%, 小区 ${f1(cell.trunc)}% × ${R.truncRel}) = ${f1(th)}%`,
      users.filter((u) => enough(u) && u.trunc != null && u.trunc >= th).sort((a, b) => b.trunc - a.trunc), 'usrschpdschDrbData', (u) => `${u.user}：${f1(u.trunc)}%`);
  }
  if (cell.mcs != null) {
    add('mcs', 'info', 'MCS 明显偏低的用户', `调度行数 ≥ ${R.minRows} 且 MCS 均值 ≤ 小区 ${f1(cell.mcs)} − ${R.mcsDrop}`,
      users.filter((u) => enough(u) && u.mcs != null && u.mcs <= cell.mcs - R.mcsDrop).sort((a, b) => a.mcs - b.mcs), 'cw0SuMcs', (u) => `${u.user}：${f1(u.mcs)}`);
  }
  if (cell.olla != null) {
    add('olla', 'info', 'OLLA 明显偏负的用户', `调度行数 ≥ ${R.minRows} 且 OLLA 均值 ≤ 小区 ${f1(cell.olla)} − ${R.ollaDrop} 阶`,
      users.filter((u) => enough(u) && u.olla != null && u.olla <= cell.olla - R.ollaDrop).sort((a, b) => a.olla - b.olla), cell.ollaColumn || '714_mcsOffset0_scaled', (u) => `${u.user}：${f1(u.olla)} 阶`);
  }
  add('dtx', 'info', 'DTX 偏多的用户', `ack0 记录 ≥ ${R.minRows} 且 DTX（ack0 非 0/1）占比 ≥ ${R.dtxShare}%`,
    users.filter((u) => (u.valid || 0) + (u.dtx || 0) >= R.minRows && (u.dtx / ((u.valid || 0) + u.dtx)) * 100 >= R.dtxShare)
      .sort((a, b) => b.dtx / (b.valid + b.dtx) - a.dtx / (a.valid + a.dtx)), '714_ack0', (u) => `${u.user}：${f1((u.dtx / (u.valid + u.dtx)) * 100)}%`);
  if (cell.matchRate != null && cell.matchRate < R.matchRate) {
    out.push({ id: 'match', level: 'info', title: `537 与 714 匹配率只有 ${f1(cell.matchRate)}%`, rule: `低于 ${R.matchRate}% 时，BLER、OLLA 等 714 指标只代表匹配上的部分`, users: [], detail: [], more: 0, metric: null, quality: true });
  }
  return out;
}
