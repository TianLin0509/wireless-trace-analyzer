// 合并明细查询：筛选、分页、排序、列画像、TTI 上下文、导出。只把当前页数据交给界面。
import { query, scalar, copyOut } from './db.js';
import { qi, qs } from './sql.js';
import { MAX_FILTER_UNIQUES } from './config.js';

const num = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`不是有效数字：${v}`);
  return String(n);
};

/**
 * filters: [{column, op, value, value2, scope}]
 * op: in | not_in | contains | gt | gte | lt | lte | eq_num | between | is_null | not_null | eq
 * scope=true 表示“用户范围”条件：本侧缺这一列时返回空集，而不是悄悄忽略（否则 A/B 口径不一致）。
 */
export function filterSql(filters, allowedColumns, globalSearch = '') {
  const allowed = new Set(allowedColumns);
  const clauses = [];
  for (const f of filters || []) {
    if (!allowed.has(f.column)) {
      if (f.scope) clauses.push('FALSE');
      continue;
    }
    const id = qi(f.column);
    const asText = `CAST(${id} AS VARCHAR)`;
    switch (f.op) {
      case 'in':
      case 'not_in': {
        const vals = (Array.isArray(f.value) ? f.value : [f.value]).map(String).filter((v) => v !== '');
        if (!vals.length) {
          if (f.scope) clauses.push('FALSE');
          continue;
        }
        const hasNan = vals.includes('NaN');
        const real = vals.filter((v) => v !== 'NaN');
        const parts = [];
        if (real.length) parts.push(`${asText} IN (${real.map(qs).join(',')})`);
        if (hasNan) parts.push(`(${id} IS NULL OR LOWER(${asText}) = 'nan')`);
        const expr = `(${parts.join(' OR ')})`;
        clauses.push(f.op === 'in' ? expr : `NOT COALESCE(${expr}, FALSE)`);
        break;
      }
      case 'contains': {
        const t = String(f.value || '').trim().toLowerCase();
        if (t) clauses.push(`LOWER(COALESCE(${asText}, '')) LIKE ${qs('%' + t + '%')}`);
        break;
      }
      case 'gt': case 'gte': case 'lt': case 'lte': case 'eq_num': {
        const token = { gt: '>', gte: '>=', lt: '<', lte: '<=', eq_num: '=' }[f.op];
        clauses.push(`TRY_CAST(${id} AS DOUBLE) ${token} ${num(f.value)}`);
        break;
      }
      case 'between':
        clauses.push(`TRY_CAST(${id} AS DOUBLE) BETWEEN ${num(f.value)} AND ${num(f.value2)}`);
        break;
      case 'is_null':
        clauses.push(`(${id} IS NULL OR TRIM(${asText}) = '' OR LOWER(${asText}) = 'nan')`);
        break;
      case 'not_null':
        clauses.push(`(${id} IS NOT NULL AND TRIM(${asText}) <> '' AND LOWER(${asText}) <> 'nan')`);
        break;
      default:
        clauses.push(`${asText} = ${qs(f.value)}`);
    }
  }
  const q = String(globalSearch || '').trim().toLowerCase();
  if (q) {
    const searchable = [...allowed].filter((c) => !c.startsWith('__'));
    if (searchable.length) {
      const like = qs('%' + q + '%');
      clauses.push('(' + searchable.map((c) => `LOWER(COALESCE(CAST(${qi(c)} AS VARCHAR), '')) LIKE ${like}`).join(' OR ') + ')');
    }
  }
  return clauses.length ? clauses.join(' AND ') : 'TRUE';
}

/** 用户范围（左侧栏选择）转成一条筛选。 */
export const userScope = (users) => ({ column: 'ambr', op: 'in', value: users, scope: true });

const ttiOrder = (allowed) =>
  allowed.has('tti') ? `ORDER BY TRY_CAST("tti" AS DOUBLE) ASC NULLS LAST, CAST("tti" AS VARCHAR) ASC, __source_row ASC` : 'ORDER BY __source_row';

export async function queryRows(side, { page = 1, pageSize = 200, filters = [], search = '', sort = null, columns = null }) {
  const allowed = new Set(side.columns);
  const where = filterSql(filters, side.columns, search);
  const [{ __total: total, __filtered: filtered }] = await query(`SELECT (SELECT count(*) FROM ${qi(side.table)}) AS __total, count(*) AS __filtered FROM ${qi(side.table)} WHERE ${where}`);
  const totalPages = Math.max(1, Math.ceil(filtered / pageSize));
  const p = Math.max(1, Math.min(page, totalPages));
  let order = ttiOrder(allowed);
  if (sort && allowed.has(sort.column)) {
    const isNum = side.numericColumns.includes(sort.column) || ['tti', 'frm', 'slotNo', 'slotNum'].includes(sort.column);
    const expr = isNum ? `TRY_CAST(${qi(sort.column)} AS DOUBLE)` : qi(sort.column);
    order = `ORDER BY ${expr} ${sort.asc ? 'ASC' : 'DESC'} NULLS LAST, __source_row`;
  }
  const out = (columns || side.visibleColumns).filter((c) => allowed.has(c));
  const rows = await query(`SELECT ${out.map(qi).join(', ')} FROM ${qi(side.table)} WHERE ${where} ${order} LIMIT ${pageSize} OFFSET ${(p - 1) * pageSize}`);
  return { rows, columns: out, total, filtered, page: p, totalPages, pageSize };
}

/** 列菜单：类 Excel 取值清单 + 数值统计。计算候选值时去掉本列自己的筛选。 */
export async function columnProfile(side, column, { filters = [], search = '', valueSearch = '' }) {
  if (!side.columns.includes(column)) throw new Error(`字段不存在：${column}`);
  const others = (filters || []).filter((f) => f.column !== column || f.scope);
  const where = filterSql(others, side.columns, search);
  const id = qi(column);
  const nullish = `(${id} IS NULL OR TRIM(CAST(${id} AS VARCHAR)) = '' OR LOWER(CAST(${id} AS VARCHAR)) = 'nan')`;
  const isNumeric = side.numericColumns.includes(column);
  const [base] = await query(`SELECT count(*) AS __n, sum(CASE WHEN ${nullish} THEN 1 ELSE 0 END)::BIGINT AS __nulls,
    count(DISTINCT CASE WHEN NOT ${nullish} THEN CAST(${id} AS VARCHAR) END) AS __distinct FROM ${qi(side.table)} WHERE ${where}`);
  let stats = null;
  if (isNumeric) {
    [stats] = await query(`SELECT count(__v) AS count, avg(__v) AS mean, min(__v) AS min, quantile_cont(__v, 0.5) AS p50, quantile_cont(__v, 0.9) AS p90, max(__v) AS max
      FROM (SELECT TRY_CAST(${id} AS DOUBLE) AS __v FROM ${qi(side.table)} WHERE ${where}) WHERE __v IS NOT NULL`);
  }
  const vs = String(valueSearch || '').trim().toLowerCase();
  const values = await query(`SELECT CAST(${id} AS VARCHAR) AS __value, count(*) AS __n FROM ${qi(side.table)}
    WHERE ${where} AND NOT ${nullish} ${vs ? `AND LOWER(CAST(${id} AS VARCHAR)) LIKE ${qs('%' + vs + '%')}` : ''}
    GROUP BY __value ORDER BY ${isNumeric ? 'TRY_CAST(__value AS DOUBLE)' : '__n DESC, __value'} LIMIT ${MAX_FILTER_UNIQUES + 1}`);
  return {
    column, isNumeric,
    rowCount: base.__n, nullCount: base.__nulls || 0, distinctCount: base.__distinct,
    values: values.slice(0, MAX_FILTER_UNIQUES).map((r) => ({ value: r.__value, count: r.__n })),
    hasMore: values.length > MAX_FILTER_UNIQUES,
    stats,
  };
}

const TTI_CONTEXT = ['tti', 'crnti', 'HH:MM:SS', 'frm', 'slotNo', 'ambr', 'usrId', 'schType', 'suOrMuFlag', 'jtMode', '714_匹配状态'];

/** 某个 TTI 的全部行：刻意不应用任何筛选，用来看同一调度时刻还有谁。 */
export async function ttiPreview(side, ttiValue, visibleColumns = []) {
  if (!side.columns.includes('tti')) throw new Error('当前汇总结果缺少 tti。');
  const v = String(ttiValue ?? '').trim();
  const byLower = new Map(side.columns.map((c) => [c.toLowerCase(), c]));
  const cols = [];
  for (const want of [...TTI_CONTEXT, ...visibleColumns]) {
    const c = byLower.get(String(want).toLowerCase());
    if (c && !c.startsWith('__') && !cols.includes(c)) cols.push(c);
  }
  const n = Number(v);
  const where = Number.isFinite(n)
    ? `(CAST("tti" AS VARCHAR) = ${qs(v)} OR TRY_CAST("tti" AS DOUBLE) = ${n})`
    : `CAST("tti" AS VARCHAR) = ${qs(v)}`;
  const rows = await query(`SELECT ${cols.map(qi).join(', ')} FROM ${qi(side.table)} WHERE ${where} ORDER BY __source_row LIMIT 500`);
  const users = [...new Set(rows.map((r) => r.ambr).filter((x) => x != null && x !== ''))].map(String);
  return { tti: v, columns: cols, rows, users };
}

/** 导出筛选后的明细（带 BOM，Excel 可直接打开；文本列防公式注入）。 */
export async function exportCsv(side, { filters = [], search = '', columns = null }) {
  const allowed = new Set(side.columns);
  const where = filterSql(filters, side.columns, search);
  const out = (columns || side.visibleColumns).filter((c) => allowed.has(c));
  const numeric = new Set(side.numericColumns);
  const select = out.map((c) => numeric.has(c) ? qi(c)
    : `CASE WHEN ${qi(c)} IS NULL THEN NULL WHEN LEFT(CAST(${qi(c)} AS VARCHAR), 1) IN ('=', '+', '-', '@', chr(9), chr(13)) THEN '''' || CAST(${qi(c)} AS VARCHAR) ELSE CAST(${qi(c)} AS VARCHAR) END AS ${qi(c)}`);
  const fname = `export_${side.side}_${Date.now()}.csv`;
  const buf = await copyOut(`COPY (SELECT ${select.join(', ')} FROM ${qi(side.table)} WHERE ${where} ${ttiOrder(allowed)}) TO ${qs(fname)} (HEADER, DELIMITER ',')`, fname);
  return new Blob([new Uint8Array([0xef, 0xbb, 0xbf]), buf], { type: 'text/csv;charset=utf-8' });
}

export async function countRows(side, filters, search) {
  return Number(await scalar(`SELECT count(*) FROM ${qi(side.table)} WHERE ${filterSql(filters, side.columns, search)}`)) || 0;
}
