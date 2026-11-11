// 根因诊断：速率拆解、受限类型、MCS 调整链与 OLLA、异常事件、时间轴取数。
// 只读合并表（537 锚点 + 714），不改表。缺字段时对应项返回 null，界面写明“缺少字段，未分析”。
//
// 速率拆解（恒等式，不是拟合）：
//   初传确认比特 / TTI = 调度尝试/TTI × 调度成功率 × RB/次 × 层数(按 RB 加权) × 每 RB 每层比特 × PDCCH 送达率 × 译码成功率
// 各因子之积严格等于左边（同一批行上求和）。A/B 对比时按对数分摊：第 i 个因子的贡献 = ln(fB/fA) / ln(RB/RA) × 总变化。
import { query } from './db.js';
import { qi } from './sql.js';
/** 714 iblerTarget 的定点倍数：10240 = 10%（样例注释）。 */
export const IBLER_SCALE = 102400;

const n = (c) => `TRY_CAST(${qi(c)} AS DOUBLE)`;
// 38.214 表 5.1.3.1-1（64QAM）每 RE 频谱效率，没有 TB 大小字段时用 MCS 查表近似
export const SE_64QAM = [0.2344, 0.3066, 0.377, 0.4902, 0.6016, 0.7402, 0.877, 1.0273, 1.1758, 1.3262, 1.3281, 1.4766, 1.6953,
  1.9141, 2.1602, 2.4063, 2.5703, 2.5664, 2.7305, 3.0293, 3.3223, 3.6094, 3.9023, 4.2129, 4.5234, 4.8164, 5.1152, 5.332, 5.5547];
// 256QAM 表（38.214 表 5.1.3.1-2），MCS 0..27
export const SE_256QAM = [0.2344, 0.377, 0.6016, 0.877, 1.1758, 1.4766, 1.6953, 1.9141, 2.1602, 2.4063, 2.5703, 2.7305, 3.0293,
  3.3223, 3.6094, 3.9023, 4.2129, 4.5234, 4.8164, 5.1152, 5.332, 5.5547, 5.8906, 6.2266, 6.5703, 6.9141, 7.1602, 7.4063];
export const RE_PER_RB = 132;

/**
 * 层数编码：真实 537 的 schRank 取 0–3（4 天线 UE、成功调度且 TB>0 的行里 52% 为 0），按“0 = 1 层”解释；
 * 文件里成功调度行的 schRank 最小值为 0 时判为从 0 起编（层数 = schRank + 1），否则层数 = schRank。
 */
export async function rankBase(side) {
  if (!side.columns.includes('schRank')) return 0;
  const cond = side.columns.includes('allocRbNum') ? `AND TRY_CAST("allocRbNum" AS DOUBLE) > 0` : '';
  const [r] = await query(`SELECT min(TRY_CAST("schRank" AS DOUBLE)) AS m FROM ${qi(side.table)} WHERE "schRank" IS NOT NULL ${cond}`);
  return r?.m === 0 ? 1 : 0;
}

/**
 * 714 独立统计（不经 537 连接）：714 每行是一次 HARQ 反馈事件，537 每行是一次调度事件，按同一时隙逐行配对其实配的是不同的 TB，
 * 真实数据里也只能配上一半左右。所以初传 BLER、DTX、OLLA 直接在 714 原表上按用户统计：
 * 初传 = retansNum0 = 0（有 trcItem 时再要求 trcItem = 0）；BLER = NACK ÷ (ACK + NACK)；DTX 率 = ack0 = 2 ÷ 全部反馈。
 * 用户归属：用 537 里 crnti → ambr 的对应（同一 crnti 取出现最多的 ambr）。
 */
export async function stats714(src537, src714) {
  if (!src537 || !src714) return null;
  const has = (c) => src714.selected.includes(c);
  if (!has('ack0')) return null;
  const a = n('ack0');
  const init = [has('retansNum0') ? `coalesce(${n('retansNum0')}, 0) = 0` : 'TRUE', has('trcItem') ? `coalesce(${n('trcItem')}, 0) = 0` : 'TRUE'].join(' AND ');
  const olla = has('mcsOffset[0]') ? `${n('mcsOffset[0]')} / ${1024000}` : null;
  const userCol = src537.selected.includes('ambr') ? 'ambr' : null;
  const map = userCol
    ? `map AS (SELECT __key_crnti AS k, CAST(${qi(userCol)} AS VARCHAR) AS u, count(*) AS c FROM ${qi(src537.table)} WHERE ${qi(userCol)} IS NOT NULL AND __key_crnti IS NOT NULL
        GROUP BY 1, 2 QUALIFY row_number() OVER (PARTITION BY k ORDER BY c DESC) = 1),`
    : '';
  const rows = await query(`WITH ${map} f AS (
      SELECT ${userCol ? `coalesce(map.u, '未映射')` : `'小区'`} AS __u, ${a} AS __a, (${init}) AS __i, ${olla || 'NULL'} AS __o,
        ${has('iblerTarget') ? n('iblerTarget') : 'NULL'} AS __g
      FROM ${qi(src714.table)} l ${userCol ? 'LEFT JOIN map ON l.__key_crnti = map.k' : ''})
    SELECT CASE WHEN grouping(__u) = 1 THEN '__cell__' ELSE __u END AS __g2, count(*) AS __n,
      count(*) FILTER (WHERE __i AND __a = 1) AS __ack, count(*) FILTER (WHERE __i AND __a = 0) AS __nack, count(*) FILTER (WHERE __a = 2) AS __dtx,
      avg(__o) AS __olla, quantile_cont(__o, 0.1) AS __olla10, avg(__g) / ${IBLER_SCALE} * 100 AS __target
    FROM f GROUP BY GROUPING SETS ((__u), ())`);
  const pack = (r) => {
    const ack = Number(r.__ack) || 0, nack = Number(r.__nack) || 0, nAll = Number(r.__n) || 0, dtx = Number(r.__dtx) || 0;
    return { n: nAll, ack, nack, dtxN: dtx, initFeedback: ack + nack, bler: ack + nack ? (nack / (ack + nack)) * 100 : null, dtx: nAll ? (dtx / nAll) * 100 : null, olla: r.__olla, olla10: r.__olla10, target: r.__target };
  };
  const byUser = new Map(rows.filter((r) => r.__g2 !== '__cell__').map((r) => [r.__g2, pack(r)]));
  const cellRow = rows.find((r) => r.__g2 === '__cell__');
  const unmapped = byUser.get('未映射')?.n || 0;
  return { cell: cellRow ? pack(cellRow) : null, byUser, unmappedShare: cellRow ? (unmapped / Number(cellRow.__n)) * 100 : null, rule: `714 原表：初传 = retansNum0 = 0${has('trcItem') ? ' 且 trcItem = 0' : ''}；BLER = NACK ÷ (ACK + NACK)；DTX = ack0 = 2 的反馈占比` };
}

/**
 * 概览 / 结论卡片的 BLER：没有列筛选与搜索时，用 714 独立统计（按用户范围汇总），和链路诊断页同一口径；
 * 有列筛选或搜索时 714 原表无法按 537 的条件筛，返回 null，调用方退回逐行连接口径。
 */
export function bler714For(side, filters, search) {
  const s = side?.stats714;
  if (!s || search || (filters || []).some((f) => !f.scope)) return null;
  const scope = (filters || []).find((f) => f.scope);
  const rows = scope ? scope.value.map((u) => s.byUser.get(String(u))).filter(Boolean) : [s.cell].filter(Boolean);
  if (!rows.length) return null;
  const ack = rows.reduce((x, r) => x + (r.ack || 0), 0), nack = rows.reduce((x, r) => x + (r.nack || 0), 0), dtx = rows.reduce((x, r) => x + (r.dtxN || 0), 0);
  if (!(ack + nack)) return null;
  return { value: (nack / (ack + nack)) * 100, p: nack / (ack + nack), n: ack + nack, dtx, source: '714' };
}

/** 只取初传的条件：真实 537 重传行的 tb0SchMcs 是 28–31（256QAM 表保留给重传的编号），混进均值会把 MCS 拉高。 */
export function initCond(columns) {
  return diagExprs(columns).init;
}

/** 速率拆解的因子定义（顺序即瀑布顺序）。 */
export const FACTORS = [
  { id: 'tries', label: '调度机会', unit: '次/千TTI', hint: '每 1000 个有调度记录的 TTI 里，该用户被调度（含失败）的初传次数；反映用户数、优先级与业务是否连续' },
  { id: 'okRate', label: '调度成功率', unit: '%', pct: true, hint: '调度未因 CCE/资源失败（schErrCode = 0）的比例' },
  { id: 'rb', label: 'RB/次', unit: 'RB', hint: '每次成功初传分到的 RB 数；低于需求说明资源受限' },
  { id: 'layers', label: '层数', unit: '层', hint: '按 RB 加权的调度层数（schRank）' },
  { id: 'eta', label: '每RB每层比特', unit: 'bit', hint: 'TB 比特 ÷ (RB × 层数)，反映 MCS 与可用 RE；无 TB 字段时按 MCS 查表估算' },
  { id: 'pdcch', label: 'PDCCH送达', unit: '%', pct: true, hint: '1 − DTX 占比：UE 没收到 PDCCH 时 HARQ 反馈为 DTX；有重传次数字段时 = 1 − DTX 引起的首次重传 ÷ 初传数' },
  { id: 'decode', label: '初传译码成功', unit: '%', pct: true, hint: '1 − 初传 BLER。有重传次数字段时 = 1 − 首次重传数 ÷ 初传数（真实 ACK 字段记的是上一次反馈，不能逐行配对）' },
];

/** 识别可用字段，生成各子表达式。 */
export function diagExprs(columns, opts = {}) {
  const has = (c) => columns.includes(c);
  const rb0 = opts.rankBase || 0;
  const err = has('schErrCode')
    ? `(${qi('schErrCode')} IS NULL OR lower(trim(CAST(${qi('schErrCode')} AS VARCHAR))) IN ('0','0x0','0x00','0x0000','0.0',''))`
    : (has('allocRbNum') ? `(${n('allocRbNum')} > 0)` : 'TRUE');
  // 初传判定优先级：537 重传次数 → 537 调度类型（真实重传写作 DLSCH_TYPE_HARQ_DRB / DTX_DRB）→ 714 重传次数（只覆盖连接上的行，最后才用）
  const st = `upper(coalesce(CAST(${qi('schType')} AS VARCHAR), ''))`;
  const init = has('tb0ReTransTimes') ? `(coalesce(${n('tb0ReTransTimes')}, 0) = 0)`
    : has('schType') ? `(${st} NOT LIKE '%RETRAN%' AND ${st} NOT LIKE '%RETX%' AND ${st} NOT LIKE '%HARQ%' AND ${st} NOT LIKE '%DTX%')`
      : has('714_retansNum0') ? `(coalesce(${n('714_retansNum0')}, 0) = 0)` : 'TRUE';
  const rb = has('allocRbNum') ? `coalesce(${n('allocRbNum')}, 0)` : null;
  const layers = has('schRank') ? `greatest(coalesce(${n('schRank')}, 0) + ${rb0}, 1)` : '1';
  const mcs = has('tb0SchMcs') ? n('tb0SchMcs') : has('cw0SuMcs') ? n('cw0SuMcs') : null;
  let bits = null, bitsSource = null;
  if (has('tb0TbByteLength')) {
    bits = `(coalesce(${n('tb0TbByteLength')}, 0) + ${has('tb1TbByteLength') ? `coalesce(${n('tb1TbByteLength')}, 0)` : '0'}) * 8`;
    bitsSource = has('tb1TbByteLength') ? 'tb0TbByteLength + tb1TbByteLength' : 'tb0TbByteLength';
  } else if (rb && mcs) {
    const se = has('mcsTable')
      ? `CASE WHEN ${n('mcsTable')} = 1 THEN list_extract([${SE_256QAM.join(',')}], CAST(least(greatest(${mcs}, 0), 27) AS INTEGER) + 1) ELSE list_extract([${SE_64QAM.join(',')}], CAST(least(greatest(${mcs}, 0), 28) AS INTEGER) + 1) END`
      : `list_extract([${SE_64QAM.join(',')}], CAST(least(greatest(${mcs}, 0), 28) AS INTEGER) + 1)`;
    const re = has('actualRePerRb') ? `coalesce(${n('actualRePerRb')}, ${RE_PER_RB})` : RE_PER_RB;
    bits = `${rb} * ${re} * ${layers} * coalesce(${se}, 0)`;
    bitsSource = `MCS 查表估算（${has('tb0SchMcs') ? 'tb0SchMcs' : 'cw0SuMcs'} × ${has('mcsTable') ? '按 mcsTable 选 64/256QAM 表' : '64QAM 表'} × ${has('actualRePerRb') ? 'actualRePerRb' : RE_PER_RB + ' RE/RB'}）`;
  }
  // ACK：537 自带的 tb0AckState 优先（真实数据取值分布与 714 ack0 一致，且不受 537/714 连接丢行影响），没有再用 714 ack0
  const ack = has('tb0AckState') && has('714_ack0') ? `coalesce(${n('tb0AckState')}, ${n('714_ack0')})`
    : has('tb0AckState') ? n('tb0AckState') : has('714_ack0') ? n('714_ack0') : null;
  const ackSource = has('tb0AckState') ? '537 tb0AckState' + (has('714_ack0') ? '（缺失时用 714 ack0）' : '') : has('714_ack0') ? '714 ack0' : null;
  const user = has('ambr') ? `CAST(${qi('ambr')} AS VARCHAR)` : `'小区'`;
  // 首次重传：真实 537 的 ACK 字段是“上一次反馈”，所以初传 BLER = 首次重传数 / 初传数（DTX 引起的单独计）
  const retx1 = has('tb0ReTransTimes') ? `(${n('tb0ReTransTimes')} = 1)` : null;
  const dtxRow = `(${ack ? `coalesce(${ack} = 2, FALSE)` : 'FALSE'}${has('schType') ? ` OR upper(CAST(${qi('schType')} AS VARCHAR)) LIKE '%DTX%'` : ''})`;
  return { has, err, init, rb, layers, bits, bitsSource, ack, ackSource, retx1, dtxRow, rankBase: rb0, user, tti: has('tti') ? n('tti') : null };
}

/**
 * 速率拆解：按用户与小区汇总七个因子。返回 { cell, users, span, bitsSource, missing }。
 * where 应包含列筛选（不要放用户范围，用户表总是列全部用户）。
 */
export async function rateFactors(side, where) {
  const e = diagExprs(side.columns, { rankBase: await rankBase(side) });
  const missing = [];
  if (!e.rb) missing.push('allocRbNum');
  if (!e.bits) missing.push('TB 大小或 MCS');
  if (!e.ack) missing.push('ACK（537 tb0AckState / 714 ack0）');
  if (!e.rb || !e.bits) return { cell: null, users: [], missing, bitsSource: e.bitsSource };
  const ackOk = e.ack ? `CASE WHEN __ack = 1 THEN __bits ELSE 0 END` : '__bits';
  const valid = e.ack ? `CASE WHEN __ack IS NOT NULL THEN __bits ELSE 0 END` : '__bits';
  const nonDtx = e.ack ? `CASE WHEN __ack IN (0, 1) THEN __bits ELSE 0 END` : '__bits';
  // 分母 = 有调度记录的 TTI 个数（真实 tti 计数会分段、跳变，max − min 不可靠）
  const [span] = await query(`SELECT ${e.tti ? `count(DISTINCT ${e.tti})` : 'count(*)'} AS __span FROM ${qi(side.table)} WHERE ${where}`);
  const rows = await query(`WITH b AS (
      SELECT ${e.user} AS __u, ${e.err} AS __ok, ${e.init} AS __init, ${e.rb} AS __rb, ${e.layers} AS __l,
        ${e.bits} AS __bits, ${e.ack || 'NULL'} AS __ack, ${e.retx1 || 'FALSE'} AS __r1, ${e.dtxRow} AS __dtxr
      FROM ${qi(side.table)} WHERE ${where})
    SELECT CASE WHEN grouping(__u) = 1 THEN '__cell__' ELSE __u END AS __g,
      count(*) FILTER (WHERE __init) AS __tries,
      count(*) FILTER (WHERE __init AND __ok) AS __okn,
      sum(__rb) FILTER (WHERE __init AND __ok) AS __rbs,
      sum(__rb * __l) FILTER (WHERE __init AND __ok) AS __rbl,
      sum(__bits) FILTER (WHERE __init AND __ok) AS __bits,
      sum(${valid}) FILTER (WHERE __init AND __ok) AS __vbits,
      sum(${nonDtx}) FILTER (WHERE __init AND __ok) AS __ndbits,
      sum(${ackOk}) FILTER (WHERE __init AND __ok) AS __abits,
      count(*) FILTER (WHERE __init AND __ok AND __ack IS NOT NULL) AS __matched,
      count(*) FILTER (WHERE __r1 AND __ok AND NOT __dtxr) AS __r1nack,
      count(*) FILTER (WHERE __r1 AND __ok AND __dtxr) AS __r1dtx
    FROM b GROUP BY GROUPING SETS ((__u), ())`);
  const viaRetx = !!e.retx1;
  const S = Number(span?.__span) || 1;
  const build = (r) => {
    const tries = Number(r.__tries) || 0, ok = Number(r.__okn) || 0, rbs = Number(r.__rbs) || 0, rbl = Number(r.__rbl) || 0;
    const bits = Number(r.__bits) || 0, vb = Number(r.__vbits) || 0, nd = Number(r.__ndbits) || 0, ab = Number(r.__abits) || 0;
    const f = {
      tries: (tries / S) * 1000,
      okRate: tries ? ok / tries : null,
      rb: ok ? rbs / ok : null,
      layers: rbs ? rbl / rbs : null,
      eta: rbl ? bits / rbl : null,
      pdcch: e.ack ? (vb ? nd / vb : null) : 1,
      decode: e.ack ? (nd ? ab / nd : null) : 1,
    };
    if (viaRetx && ok) {
      const d1 = Number(r.__r1dtx) || 0, n1 = Number(r.__r1nack) || 0;
      f.pdcch = Math.max(0, 1 - d1 / ok);
      f.decode = ok > d1 ? Math.max(0, 1 - n1 / (ok - d1)) : null;
    }
    // 每 TTI 初传确认比特 = 各因子之积（tries 换回每 TTI）
    const product = [f.tries / 1000, f.okRate, f.rb, f.layers, f.eta, f.pdcch, f.decode].reduce((p, x) => (p == null || x == null ? null : p * x), 1);
    return { user: r.__g, tries, ok, matched: Number(r.__matched) || 0, factors: f, bitsPerTti: product };
  };
  const all = rows.map(build);
  const cell = all.find((x) => x.user === '__cell__') || null;
  const users = all.filter((x) => x.user !== '__cell__').sort((a, b) => b.tries - a.tries);
  if (!e.ack && !viaRetx) missing.push('ACK 字段（PDCCH 送达与译码成功按 100% 计）');
  const blerSource = viaRetx ? '首次重传数 ÷ 初传数（tb0ReTransTimes = 1；DTX 引起的单独计）' : e.ackSource ? `逐行 ACK（${e.ackSource}）` : null;
  return { cell, users, span: S, bitsSource: e.bitsSource, ackSource: e.ackSource, blerSource, rankBase: e.rankBase, missing };
}

/** 对数分摊：A→B 的总变化按因子拆开，返回 [{id, ratio, contrib(百分点)}]，各项之和 = 总变化。 */
export function logShare(fa, fb) {
  if (!fa || !fb) return null;
  const ids = FACTORS.map((x) => x.id);
  const ratio = (id) => (fa[id] > 0 && fb[id] > 0 ? fb[id] / fa[id] : null);
  const parts = ids.map((id) => ({ id, ratio: ratio(id) }));
  if (parts.some((p) => p.ratio == null)) return null;
  const total = parts.reduce((p, x) => p * x.ratio, 1);
  const lnT = Math.log(total);
  const change = (total - 1) * 100;
  return {
    total: change,
    parts: parts.map((p) => ({ ...p, contrib: Math.abs(lnT) < 1e-9 ? Math.log(p.ratio) * 100 : (Math.log(p.ratio) / lnT) * change })),
  };
}

/** 受限类型：数据受限（本次就把缓存发完）/ RB 受限（分到的 RB 少于需求）/ 调度失败。按用户。 */
export async function limitShares(side, where) {
  const e = diagExprs(side.columns);
  const has = e.has;
  const tb = has('tb0TbByteLength') ? `(coalesce(${n('tb0TbByteLength')},0) + ${has('tb1TbByteLength') ? `coalesce(${n('tb1TbByteLength')},0)` : '0'})` : null;
  const dataLim = has('waitingData') && tb ? `${n('waitingData')} <= ${tb}`
    : has('usrschpdschDrbData') && tb ? `${n('usrschpdschDrbData')} < 0.9 * ${tb}` : null;
  const rbLim = has('esitimatedRb') && e.rb ? `${e.rb} < ${n('esitimatedRb')}` : null;
  if (!dataLim && !rbLim && !has('schErrCode')) return null;
  const rows = await query(`WITH b AS (SELECT ${e.user} AS __u, ${e.err} AS __ok, ${e.init} AS __init,
        ${dataLim ? `(${dataLim})` : 'NULL'} AS __dl, ${rbLim ? `(${rbLim})` : 'NULL'} AS __rl FROM ${qi(side.table)} WHERE ${where})
    SELECT CASE WHEN grouping(__u) = 1 THEN '__cell__' ELSE __u END AS __g, count(*) FILTER (WHERE __init) AS __n,
      avg(CASE WHEN __ok THEN 0.0 ELSE 1.0 END) FILTER (WHERE __init) * 100 AS __fail,
      avg(CASE WHEN __dl THEN 1.0 ELSE 0.0 END) FILTER (WHERE __init AND __ok AND __dl IS NOT NULL) * 100 AS __data,
      avg(CASE WHEN __rl THEN 1.0 ELSE 0.0 END) FILTER (WHERE __init AND __ok AND __rl IS NOT NULL) * 100 AS __rbl
    FROM b GROUP BY GROUPING SETS ((__u), ())`);
  const map = new Map(rows.map((r) => [r.__g, { n: Number(r.__n), fail: r.__fail, data: r.__data, rb: r.__rbl }]));
  // 失败码 Top：十六进制字段读入后是数值，显示时转回 0x 形式
  let topCodes = [];
  if (has('schErrCode')) {
    const codes = await query(`SELECT ${qi('schErrCode')} AS __c, count(*) AS __n FROM ${qi(side.table)} WHERE ${where} AND NOT ${e.err} GROUP BY 1 ORDER BY 2 DESC LIMIT 5`);
    const total = Number(map.get('__cell__')?.n) || 0;
    const per = await query(`SELECT __u, __c FROM (SELECT ${e.user} AS __u, ${qi('schErrCode')} AS __c, count(*) AS __n,
        row_number() OVER (PARTITION BY ${e.user} ORDER BY count(*) DESC) AS __k FROM ${qi(side.table)} WHERE ${where} AND NOT ${e.err} GROUP BY 1, 2) WHERE __k = 1`);
    const hexOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? '0x' + Math.round(v).toString(16) : String(v));
    for (const r of per) { const x = map.get(r.__u); if (x) x.topCode = hexOf(r.__c); }
    topCodes = codes.map((r) => {
      const v = r.__c;
      const hex = typeof v === 'number' && Number.isFinite(v) ? '0x' + Math.round(v).toString(16) : String(v);
      return { code: hex, n: Number(r.__n), share: total ? (Number(r.__n) / total) * 100 : null };
    });
  }
  return { cell: map.get('__cell__') || null, users: map, topCodes, rule: { data: dataLim ? (has('waitingData') ? '待发数据 waitingData ≤ 本次 TB 大小（本次就能发完缓存）' : '承载数据 < 90% TB 大小（有填充）') : null, rb: rbLim ? '分配 RB allocRbNum < 估算需求 esitimatedRb' : null } };
}

/** MCS 调整链：从 CQI 估计到最终调度 MCS 的每一步均值（只取成功初传）。顺序已用真实数据核对，可在此调整。 */
export const MCS_CHAIN = [
  ['estMcs0', 'CQI 估计'], ['initAdjMcs0', 'OLLA 调整后'], ['powerBackMcs0', '功率回退后'], ['rateMtcMcs0', '速率匹配后'],
  ['reduceMcs0', '降阶后（MU 等）'], ['tb0SchMcs', '最终调度'],
];

export async function linkDiag(side, where) {
  const e = diagExprs(side.columns, { rankBase: await rankBase(side) });
  const has = e.has;
  const chain = MCS_CHAIN.filter(([c]) => has(c));
  const target = has('714_iblerTarget') ? `avg(${n('714_iblerTarget')}) FILTER (WHERE __i) / ${IBLER_SCALE} * 100` : 'NULL';
  const ollaCol = has('714_mcsOffset0_scaled') ? '714_mcsOffset0_scaled' : has('714_compOlla_scaled') ? '714_compOlla_scaled' : null;
  const sel = [
    'count(*) FILTER (WHERE __i) AS __n',
    ...chain.map(([c], i) => `avg(${n(c)}) FILTER (WHERE __i) AS __c${i}`),
    ollaCol ? `avg(${n(ollaCol)}) FILTER (WHERE __i) AS __olla, quantile_cont(${n(ollaCol)}, 0.1) FILTER (WHERE __i) AS __olla10, min(${n(ollaCol)}) FILTER (WHERE __i) AS __ollaMin` : 'NULL AS __olla, NULL AS __olla10, NULL AS __ollaMin',
    e.retx1 ? `count(*) FILTER (WHERE __r1 AND NOT __dtxr) * 100.0 / nullif(count(*) FILTER (WHERE __i) - count(*) FILTER (WHERE __r1 AND __dtxr), 0) AS __bler, count(*) FILTER (WHERE __r1 AND __dtxr) * 100.0 / nullif(count(*) FILTER (WHERE __i), 0) AS __dtx`
      : e.ack ? `(1 - avg(CASE WHEN ${e.ack} = 1 THEN 1.0 WHEN ${e.ack} = 0 THEN 0.0 END) FILTER (WHERE __i)) * 100 AS __bler, avg(CASE WHEN ${e.ack} IS NULL THEN NULL WHEN ${e.ack} NOT IN (0,1) THEN 1.0 ELSE 0.0 END) FILTER (WHERE __i) * 100 AS __dtx` : 'NULL AS __bler, NULL AS __dtx',
    `${target} AS __target`,
    has('suOrMuFlag') && has('tb0SchMcs') ? `avg(${n('tb0SchMcs')}) FILTER (WHERE __i AND upper(CAST(${qi('suOrMuFlag')} AS VARCHAR)) LIKE '%MU%') AS __muMcs, avg(${n('tb0SchMcs')}) FILTER (WHERE __i AND upper(CAST(${qi('suOrMuFlag')} AS VARCHAR)) NOT LIKE '%MU%') AS __suMcs, avg(CASE WHEN upper(CAST(${qi('suOrMuFlag')} AS VARCHAR)) LIKE '%MU%' THEN 100.0 ELSE 0 END) FILTER (WHERE __i) AS __muShare` : 'NULL AS __muMcs, NULL AS __suMcs, NULL AS __muShare',
    has('bandCqiCw0') ? `avg(${n('bandCqiCw0')}) FILTER (WHERE __i) AS __cqi` : 'NULL AS __cqi',
  ];
  const rows = await query(`SELECT CASE WHEN grouping(__u) = 1 THEN '__cell__' ELSE __u END AS __g, ${sel.join(', ')}
    FROM (SELECT *, ${e.user} AS __u, (${e.init}) AS __i, ${e.retx1 || 'FALSE'} AS __r1, ${e.dtxRow} AS __dtxr FROM ${qi(side.table)} WHERE ${where} AND ${e.err}) GROUP BY GROUPING SETS ((__u), ())`);
  const pack = (r) => ({
    user: r.__g, n: Number(r.__n),
    chain: chain.map(([c, label], i) => ({ column: c, label, value: r[`__c${i}`] })),
    olla: r.__olla, olla10: r.__olla10, ollaMin: r.__ollaMin, bler: r.__bler, dtx: r.__dtx, target: r.__target,
    muMcs: r.__muMcs, suMcs: r.__suMcs, muShare: r.__muShare, cqi: r.__cqi,
  });
  const s714 = side.stats714;
  const all = rows.map(pack).map((x) => {
    const st = s714 ? (x.user === '__cell__' ? s714.cell : s714.byUser.get(x.user)) : null;
    if (!st) return x;
    // 714 独立统计优先：BLER / DTX 按反馈事件算，OLLA 按全部 714 记录算（不受 537/714 连接率影响）
    return { ...x, bler: st.bler ?? x.bler, dtx: st.dtx ?? x.dtx, olla: st.olla ?? x.olla, olla10: st.olla10 ?? x.olla10, target: st.target ?? x.target, blerN: st.initFeedback };
  });
  const blerSource = s714?.cell ? s714.rule : e.retx1 ? '537：首次重传数 ÷ 初传数' : e.ack ? '逐行 ACK' : null;
  return { cell: all.find((x) => x.user === '__cell__') || null, users: all.filter((x) => x.user !== '__cell__').sort((a, b) => b.n - a.n), chainColumns: chain.map(([c]) => c), ollaColumn: ollaCol, blerSource, unmapped714: s714?.unmappedShare ?? null };
}

/** 异常事件规则（阈值界面原样显示）。 */
export const EVENT_RULES = {
  nackRun: 4,      // 同一用户连续 ≥ 4 行都是 NACK 引起的重传（无重传次数字段时：连续 ack=0）
  dtxRun: 3,       // 连续 DTX ≥ 3 次
  failRun: 4,      // 连续调度失败 ≥ 4 次
  mcsDrop: 6,      // 最终 MCS 比该用户前 20 次调度的均值低 ≥ 6 阶
  mcsDropRun: 10,  // 且持续 ≥ 10 次调度
  ollaDrop: 3,     // OLLA 外环累计量比该用户前 200 次的均值低 ≥ 3 阶，持续 ≥ 50 次
  ollaRun: 50,
};

export const EVENT_TYPES = {
  nack: { label: '连续 NACK', color: '#dc2626', hint: '连续多次因 NACK 重传：信道突变、干扰突发或 MCS 过激' },
  dtx: { label: '连续 DTX', color: '#6b7280', hint: 'UE 连续没收到 PDCCH：PDCCH 波束/聚合等级/覆盖问题' },
  fail: { label: '连续调度失败', color: '#9333ea', hint: 'schErrCode ≠ 0 成串：CCE 不足、资源冲突' },
  mcs: { label: 'MCS 骤降', color: '#ea580c', hint: '最终 MCS 较近期均值骤降并持续：CQI 下降、OLLA 回退或 MU 降阶' },
  olla: { label: 'OLLA 下探', color: '#0891b2', hint: 'OLLA 较近期均值明显变负并持续：BLER 超目标，链路估计偏乐观' },
};

/** 异常事件：按用户、按 TTI 顺序找连续段（gaps-and-islands），返回事件表。 */
export async function detectEvents(side, where, R = EVENT_RULES, limit = 400) {
  const e = diagExprs(side.columns);
  const has = e.has;
  if (!e.tti) return { events: [], missing: ['tti'] };
  const flags = [];
  // 真实 537 的 ACK 字段是“触发本次调度的上一次反馈”：重传行带 0（NACK）或 2（DTX）。连续 NACK = 该用户连续多行都是 NACK 引起的重传
  if (e.retx1) {
    flags.push(['nack', `${e.err} AND coalesce(${n('tb0ReTransTimes')}, 0) >= 1 AND NOT ${e.dtxRow}`, R.nackRun]);
    flags.push(['dtx', `${e.err} AND ${e.dtxRow}`, R.dtxRun]);
  } else if (e.ack) {
    flags.push(['nack', `${e.init} AND ${e.err} AND ${e.ack} = 0`, R.nackRun]);
    flags.push(['dtx', `${e.err} AND ${e.ack} IS NOT NULL AND ${e.ack} NOT IN (0, 1)`, R.dtxRun]);
  }
  if (has('schErrCode')) flags.push(['fail', `NOT ${e.err}`, R.failRun]);
  const mcsCol = has('tb0SchMcs') ? n('tb0SchMcs') : has('cw0SuMcs') ? n('cw0SuMcs') : null;
  const out = [];
  const base = `SELECT ${e.user} AS __u, ${e.tti} AS __t, __source_row AS __r, * EXCLUDE (__source_row) FROM ${qi(side.table)} WHERE ${where}`;
  for (const [type, cond, minLen] of flags) {
    const rows = await query(`WITH b AS (SELECT __u, __t, (${cond}) AS __f FROM (${base})),
      g AS (SELECT __u, __t, __f, row_number() OVER (PARTITION BY __u ORDER BY __t) - row_number() OVER (PARTITION BY __u, __f ORDER BY __t) AS __grp FROM b)
      SELECT __u, min(__t) AS __t0, max(__t) AS __t1, count(*) AS __len FROM g WHERE __f GROUP BY __u, __grp HAVING count(*) >= ${minLen}
      ORDER BY __len DESC LIMIT ${limit}`);
    for (const r of rows) out.push({ type, user: r.__u, t0: r.__t0, t1: r.__t1, len: Number(r.__len), detail: `${r.__len} 次` });
  }
  if (mcsCol) {
    const rows = await query(`WITH b AS (SELECT __u, __t, ${mcsCol} AS __m FROM (${base}) WHERE ${e.err} AND ${e.init} AND ${mcsCol} IS NOT NULL),
      w AS (SELECT __u, __t, __m, avg(__m) OVER (PARTITION BY __u ORDER BY __t ROWS BETWEEN 20 PRECEDING AND 1 PRECEDING) AS __ref FROM b),
      f AS (SELECT *, (__ref - __m >= ${R.mcsDrop}) AS __f FROM w WHERE __ref IS NOT NULL),
      g AS (SELECT *, row_number() OVER (PARTITION BY __u ORDER BY __t) - row_number() OVER (PARTITION BY __u, __f ORDER BY __t) AS __grp FROM f)
      SELECT __u, min(__t) AS __t0, max(__t) AS __t1, count(*) AS __len, avg(__ref) AS __ref, avg(__m) AS __m FROM g WHERE __f
      GROUP BY __u, __grp HAVING count(*) >= ${R.mcsDropRun} ORDER BY __len DESC LIMIT ${limit}`);
    for (const r of rows) out.push({ type: 'mcs', user: r.__u, t0: r.__t0, t1: r.__t1, len: Number(r.__len), detail: `MCS ${r.__ref.toFixed(1)} → ${r.__m.toFixed(1)}` });
  }
  const ollaEv = has('714_mcsOffset0_scaled') ? '714_mcsOffset0_scaled' : has('714_compOlla_scaled') ? '714_compOlla_scaled' : null;
  if (ollaEv) {
    const o = n(ollaEv);
    const rows = await query(`WITH b AS (SELECT __u, __t, ${o} AS __o FROM (${base}) WHERE ${o} IS NOT NULL),
      w AS (SELECT __u, __t, __o, avg(__o) OVER (PARTITION BY __u ORDER BY __t ROWS BETWEEN 200 PRECEDING AND 1 PRECEDING) AS __ref,
        count(*) OVER (PARTITION BY __u ORDER BY __t ROWS BETWEEN 200 PRECEDING AND 1 PRECEDING) AS __k FROM b),
      f AS (SELECT *, (__ref - __o >= ${R.ollaDrop}) AS __f FROM w WHERE __k >= 50),
      g AS (SELECT *, row_number() OVER (PARTITION BY __u ORDER BY __t) - row_number() OVER (PARTITION BY __u, __f ORDER BY __t) AS __grp FROM f)
      SELECT __u, min(__t) AS __t0, max(__t) AS __t1, count(*) AS __len, avg(__ref) AS __ref, min(__o) AS __min FROM g WHERE __f
      GROUP BY __u, __grp HAVING count(*) >= ${R.ollaRun} ORDER BY __len DESC LIMIT ${limit}`);
    for (const r of rows) out.push({ type: 'olla', user: r.__u, t0: r.__t0, t1: r.__t1, len: Number(r.__len), detail: `OLLA ${r.__ref.toFixed(1)} → 最低 ${r.__min.toFixed(1)} 阶` });
  }
  out.sort((a, b) => b.len - a.len);
  return { events: out, missing: [] };
}

/** 事件按用户 × 类型计数（用于热力表）。 */
export function eventMatrix(events) {
  const m = new Map();
  for (const ev of events) {
    if (!m.has(ev.user)) m.set(ev.user, { user: ev.user, total: 0, byType: {} });
    const x = m.get(ev.user);
    x.total += 1;
    x.byType[ev.type] = (x.byType[ev.type] || 0) + 1;
  }
  return [...m.values()].sort((a, b) => b.total - a.total);
}

/** 时间轴泳道取数：一个用户、一段 TTI，最多 maxPoints 个调度点（超出则等间隔抽取）。 */
export const LANES = [
  { id: 'mcs', label: 'MCS', columns: ['tb0SchMcs', 'estMcs0', 'cw0SuMcs'] },
  { id: 'rb', label: 'RB', columns: ['allocRbNum', 'esitimatedRb'] },
  { id: 'rank', label: '层数', columns: ['schRank'] },
  { id: 'ack', label: 'ACK', columns: ['tb0AckState', '714_ack0'] },
  { id: 'olla', label: 'OLLA 阶', columns: ['714_mcsOffset0_scaled', '714_compOlla_scaled'] },
  { id: 'buf', label: '待发数据', columns: ['waitingData', 'usrschpdschDrbData'] },
];

export async function timelineData(side, where, user, range, maxPoints = 4000) {
  const e = diagExprs(side.columns);
  if (!e.tti) return null;
  const cols = [...new Set(LANES.flatMap((l) => l.columns))].filter((c) => side.columns.includes(c));
  const extra = ['schErrCode', 'suOrMuFlag', 'tb0ReTransTimes'].filter((c) => side.columns.includes(c));
  const conds = [where];
  if (user && side.columns.includes('ambr')) conds.push(`${e.user} = '${String(user).replace(/'/g, "''")}'`);
  if (range) conds.push(`${e.tti} BETWEEN ${Number(range[0])} AND ${Number(range[1])}`);
  const w = conds.join(' AND ');
  const [{ __c: total }] = await query(`SELECT count(*) AS __c FROM ${qi(side.table)} WHERE ${w}`);
  const base = await rankBase(side);
  const stride = Math.max(1, Math.ceil(Number(total) / maxPoints));
  const rows = await query(`WITH o AS (SELECT ${e.tti} AS __t, ${cols.map((c) => `${n(c)} AS ${qi(c)}`).concat(extra.map((c) => `CAST(${qi(c)} AS VARCHAR) AS ${qi(c)}`)).join(', ')},
      row_number() OVER (ORDER BY ${e.tti}, __source_row) AS __k FROM ${qi(side.table)} WHERE ${w})
    SELECT * FROM o WHERE ((__k - 1) % ${stride}) = 0 ORDER BY __k LIMIT ${maxPoints}`);
  const col = (c) => rows.map((r) => (r[c] == null ? null : c === 'schRank' ? r[c] + base : r[c]));
  return { tti: col('__t'), series: Object.fromEntries([...cols, ...extra].map((c) => [c, col(c)])), total: Number(total), stride, columns: cols };
}

/** 用户的 TTI 范围（时间轴默认窗口）。 */
export async function userSpan(side, where, user) {
  const e = diagExprs(side.columns);
  if (!e.tti) return null;
  const cond = user && side.columns.includes('ambr') ? ` AND ${e.user} = '${String(user).replace(/'/g, "''")}'` : '';
  const [r] = await query(`SELECT min(${e.tti}) AS lo, max(${e.tti}) AS hi, count(*) AS n FROM ${qi(side.table)} WHERE ${where}${cond}`);
  return r?.lo == null ? null : { lo: r.lo, hi: r.hi, n: Number(r.n) };
}
