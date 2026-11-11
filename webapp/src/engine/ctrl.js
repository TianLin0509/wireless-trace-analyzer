// 控制信道：T650（PDCCH CCE 申请）与 T941（PDCCH 聚合级别调整）的独立统计。
// 两表按 rnti 挂到 537 的用户上（同一 crnti 取出现最多的 ambr），不做逐 TTI 连接：
// 真实数据里两表的 TTI 计数和 537 差一个固定偏移，且 650 大半是上行申请，逐行连不上是正常现象。
import { query } from './db.js';
import { qi } from './sql.js';

export const CTRL_650_COLUMNS = ['rnti', 'usrId', 'schTypeBitmap', 'result', 'tracePos', 'initAggLvl', 'dlCceFailCnt', 'ulCceFailCnt', 'dciFormat', 'finalPdcchPower', 'rptTti'];
export const CTRL_941_COLUMNS = ['rnti', 'suAggLvl', 'continuousDlDtxNum', 'widebandCqi0', 'suSinr', 'sinrPdschOlla', 'rptTti'];

// 判读门限（界面原样显示）。CCE 失败率门限取常用体检经验值：> 1% 报警、> 5% 严重
export const CTRL_RULES = { cceWarn: 1, cceBad: 5, agg16Rel: 2, agg16Min: 30, minN: 50, minFail: 5 };

const n = (c) => qi(c);
// 系统消息（SIB/寻呼/RAR）的 RNTI 不算用户：≥ 65534 或 < 100
const userRnti = `TRY_CAST(__key_crnti AS BIGINT) BETWEEN 100 AND 65533`;

function userMap(src537) {
  const userCol = src537?.selected?.includes('ambr') ? 'ambr' : null;
  if (!userCol) return { sql: '', expr: `'小区'`, join: '' };
  return {
    sql: `map AS (SELECT __key_crnti AS k, CAST(${qi(userCol)} AS VARCHAR) AS u, count(*) AS c FROM ${qi(src537.table)} WHERE ${qi(userCol)} IS NOT NULL AND __key_crnti IS NOT NULL
      GROUP BY 1, 2 QUALIFY row_number() OVER (PARTITION BY k ORDER BY c DESC) = 1),`,
    expr: `coalesce(map.u, '未映射')`,
    join: 'LEFT JOIN map ON x.__key_crnti = map.k',
  };
}

// schTypeBitmap 真实写法是 “DL_DATA(32)” 这类文本，也可能直接是数字；取括号里的数当位图：DL_DCCH 16、DL_DATA 32、UL_DATA 64
const bitmap = (c) => `coalesce(TRY_CAST(regexp_extract(CAST(${n(c)} AS VARCHAR), '\\((\\d+)\\)', 1) AS BIGINT), CAST(TRY_CAST(CAST(${n(c)} AS VARCHAR) AS DOUBLE) AS BIGINT))`;
// 聚合级别：文本 “AGG_LVL_16(4)” 取 16（括号里是档位下标）；纯数字按级别本身（941 suAggLvl 真实取值 1/2/4/8/16）
const aggLevel = (c) => `coalesce(TRY_CAST(nullif(regexp_extract(CAST(${n(c)} AS VARCHAR), 'AGG_LVL_(\\d+)', 1), '') AS DOUBLE), TRY_CAST(CAST(${n(c)} AS VARCHAR) AS DOUBLE))`;

const hex = (v) => (v == null || !Number.isFinite(Number(v)) ? null : '0x' + Math.round(Number(v)).toString(16).toUpperCase());

export async function statsCtrl(src537, t650, t941) {
  if (!t650 && !t941) return null;
  const m = userMap(src537);
  const out = { cell: {}, byUser: new Map(), has650: !!t650, has941: !!t941 };
  const put = (u, k, v) => {
    if (u === '__cell__') Object.assign(out.cell, v);
    else out.byUser.set(u, { ...(out.byUser.get(u) || {}), ...v });
  };
  if (t650) {
    const has = (c) => t650.selected.includes(c);
    const bm = has('schTypeBitmap') ? bitmap('schTypeBitmap') : 'NULL';
    const ok = has('result') ? `coalesce(${n('result')}, 0) = 0` : 'TRUE';
    const alloc = has('tracePos') ? `upper(coalesce(CAST(${n('tracePos')} AS VARCHAR), '')) NOT LIKE '%RELEASE%'` : 'TRUE';
    const rows = await query(`WITH ${m.sql} x AS (
        SELECT *, ${bm} AS __bm, ${has('initAggLvl') ? aggLevel('initAggLvl') : 'NULL'} AS __agg, NOT (${ok}) AS __fail FROM ${qi(t650.table)} WHERE ${userRnti} AND ${alloc}),
      y AS (SELECT ${m.expr} AS __u, (__bm & 48) <> 0 AS __dl, (__bm & 64) <> 0 AS __ul, __agg, __fail, ${has('result') ? n('result') : 'NULL'} AS __r,
        ${has('ulCceFailCnt') ? n('ulCceFailCnt') : 'NULL'} AS __ulc, ${has('dlCceFailCnt') ? n('dlCceFailCnt') : 'NULL'} AS __dlc FROM x ${m.join})
      SELECT CASE WHEN grouping(__u) = 1 THEN '__cell__' ELSE __u END AS __g,
        count(*) FILTER (WHERE __dl) AS dlN, count(*) FILTER (WHERE __dl AND __fail) AS dlFail,
        count(*) FILTER (WHERE __ul) AS ulN, count(*) FILTER (WHERE __ul AND __fail) AS ulFail,
        avg(__agg) FILTER (WHERE __dl AND __agg > 0) AS dlAgg, avg(CASE WHEN __agg >= 16 THEN 100.0 ELSE 0 END) FILTER (WHERE __dl AND __agg > 0) AS dlAgg16,
        max(__ulc) AS ulCntMax, max(__dlc) AS dlCntMax, mode(__r) FILTER (WHERE __fail) AS topCode, count(*) AS n
      FROM y GROUP BY GROUPING SETS ((__u), ())`);
    for (const r of rows) {
      const dlN = Number(r.dlN) || 0, ulN = Number(r.ulN) || 0;
      put(r.__g, null, {
        n650: Number(r.n) || 0, dlN, ulN,
        dlFail: dlN ? (Number(r.dlFail) / dlN) * 100 : null, ulFail: ulN ? (Number(r.ulFail) / ulN) * 100 : null,
        dlAgg: r.dlAgg, dlAgg16: r.dlAgg16, ulCntMax: r.ulCntMax, dlCntMax: r.dlCntMax, topCode: hex(r.topCode),
      });
    }
  }
  if (t941) {
    const has = (c) => t941.selected.includes(c);
    if (has('suAggLvl')) {
      const dtx = has('continuousDlDtxNum') ? `coalesce(${n('continuousDlDtxNum')}, 0)` : '0';
      const rows = await query(`WITH ${m.sql} x AS (SELECT * FROM ${qi(t941.table)} WHERE ${userRnti}),
        y AS (SELECT ${m.expr} AS __u, ${aggLevel('suAggLvl')} AS __agg, ${dtx} AS __d, ${has('widebandCqi0') ? n('widebandCqi0') : 'NULL'} AS __cqi,
          ${has('suSinr') ? n('suSinr') : 'NULL'} AS __sinr FROM x ${m.join})
        SELECT CASE WHEN grouping(__u) = 1 THEN '__cell__' ELSE __u END AS __g, count(*) AS n,
          avg(__agg) FILTER (WHERE __agg > 0) AS agg, avg(CASE WHEN __agg >= 16 THEN 100.0 ELSE 0 END) FILTER (WHERE __agg > 0) AS agg16,
          avg(CASE WHEN __d > 0 THEN 100.0 ELSE 0 END) AS dtxShare, max(__d) AS dtxMax,
          avg(CASE WHEN __agg >= 16 THEN 100.0 ELSE 0 END) FILTER (WHERE __d > 0 AND __agg > 0) AS agg16Dtx,
          count(*) FILTER (WHERE __d > 0) AS dtxN, avg(__cqi) FILTER (WHERE __cqi > 0) AS cqi, median(__sinr) AS sinr
        FROM y GROUP BY GROUPING SETS ((__u), ())`);
      for (const r of rows) put(r.__g, null, { n941: Number(r.n) || 0, agg: r.agg, agg16: r.agg16, dtxShare: r.dtxShare, dtxMax: r.dtxMax, dtxN: Number(r.dtxN) || 0, agg16Dtx: r.agg16Dtx, cqi: r.cqi, sinr: r.sinr });
    }
  }
  const mapped = [...out.byUser.entries()].filter(([u]) => u !== '未映射');
  out.unmappedShare = out.cell.n650 ? ((out.byUser.get('未映射')?.n650 || 0) / out.cell.n650) * 100 : null;
  out.users = mapped.map(([user, v]) => ({ user, ...v }));
  return out;
}

/** 单个用户的控制信道判读：返回 [标签, 说明]。ref = 用户中位。 */
export function ctrlFlags(u, ref, R = CTRL_RULES) {
  const out = [];
  if (!u) return out;
  // 绝对门限（> 1%）+ 相对用户中位 2 倍；全小区都高时（> 5%）每个用户都标，汇总成小区共性
  // 失败次数也要够（真实数据里 2 次失败 / 83 次申请曾被误标）
  if (u.dlFail != null && u.dlN >= R.minN && (u.dlFail * u.dlN) / 100 >= R.minFail - 1e-9 && u.dlFail > R.cceWarn && (u.dlFail > R.cceBad || !ref?.dlFail || u.dlFail >= R.agg16Rel * ref.dlFail)) out.push([u.dlFail > R.cceBad ? 'CCE 失败严重' : 'CCE 失败', `下行 PDCCH CCE 申请失败 ${u.dlFail.toFixed(1)}%（${u.dlN} 次申请${u.topCode ? `，主要失败码 ${u.topCode}` : ''}）`]);
  if (u.agg16 != null && u.n941 >= R.minN && u.agg16 >= R.agg16Min && (!ref?.agg16 || u.agg16 >= R.agg16Rel * ref.agg16)) out.push(['聚合级别高', `PDCCH 聚合级别 16 占 ${u.agg16.toFixed(0)}%（用户中位 ${ref?.agg16 != null ? ref.agg16.toFixed(0) : '—'}%）：PDCCH 覆盖或干扰差，CCE 消耗大`]);
  return out;
}

const med = (xs) => { const v = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
export function ctrlRef(users) {
  return { agg16: med(users.map((u) => u.agg16)), dlFail: med(users.map((u) => u.dlFail)), agg: med(users.map((u) => u.agg)) };
}
