// 读取：T396 直接在 SQL 里聚合；T537/T714 只读选中的列（加连接键），坏行记入质量报告而不是静默丢弃。
import { query, exec, scalar, registerFile } from './db.js';
import { qi, qs, numExpr, textExpr, normUserExpr, normCrntiExpr } from './sql.js';
import { sniffFile } from './csvsniff.js';
import { T396_REQUIRED, MAX_REJECT_SAMPLES } from './config.js';

const KEY_CANDIDATES = {
  crnti: ['crnti'],
  time: ['HH:MM:SS', 'hh:mm:ss'],
  frm: ['frm'],
  slot537: ['slotNo', 'slotNum'],
  slot714: ['slotNum', 'slotNo'],
};

function findColumn(columns, candidates) {
  const lookup = new Map(columns.map((c) => [c.trim().toLowerCase(), c]));
  for (const c of candidates) if (lookup.has(c.toLowerCase())) return lookup.get(c.toLowerCase());
  return null;
}

export function resolveMergeKeys(columns, traceId) {
  const mapping = {
    crnti: findColumn(columns, KEY_CANDIDATES.crnti),
    time: findColumn(columns, KEY_CANDIDATES.time),
    frm: findColumn(columns, KEY_CANDIDATES.frm),
    slot: findColumn(columns, traceId === '537' ? KEY_CANDIDATES.slot537 : KEY_CANDIDATES.slot714),
  };
  const missing = Object.entries(mapping).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(`T${traceId} 缺少汇总连接字段：${missing.join('、')}。需要 crnti、HH:MM:SS、frm 和 slotNo/slotNum。`);
  }
  return mapping;
}

function readCsvSql(name, sniff, rejectKey) {
  const enc = sniff.encoding === 'utf-8' ? 'utf-8' : 'latin-1';
  return `read_csv(${qs(name)}, header=true, delim=${qs(sniff.delim)}, quote='"', escape='"', all_varchar=true,
    encoding=${qs(enc)}, store_rejects=true, rejects_table=${qs('rej_' + rejectKey)}, rejects_scan=${qs('rejscan_' + rejectKey)})`;
}

async function collectQuality(rejectKey, acceptedRows, sniff) {
  let rejected = 0;
  let samples = [];
  try {
    rejected = Number(await scalar(`SELECT count(DISTINCT line) FROM ${qi('rej_' + rejectKey)}`)) || 0;
    if (rejected) {
      // 同一行缺多列时会有多条记录：按行合并，只给一条样例
      samples = await query(`SELECT line, any_value(error_type) AS error_type,
          any_value(error_message) AS error_message, count(*) AS issues,
          string_agg(DISTINCT column_name, '、') AS columns, any_value(left(csv_line, 2000)) AS csv_line
        FROM ${qi('rej_' + rejectKey)} GROUP BY line ORDER BY line LIMIT ${MAX_REJECT_SAMPLES}`);
    }
  } catch {
    // 没有坏行时 DuckDB 可能不创建拒绝表
  }
  return {
    status: rejected ? 'warning' : 'clean',
    acceptedRows,
    rejectedRows: rejected,
    sourceRows: acceptedRows + rejected,
    samples,
    encodingNote: sniff.encoding === 'utf-8' ? '' : '文件不是 UTF-8（疑似 GBK），中文内容可能显示为乱码，数值不受影响。',
  };
}

async function dropRejects(rejectKey) {
  await exec(`DROP TABLE IF EXISTS ${qi('rej_' + rejectKey)}`).catch(() => {});
  await exec(`DROP TABLE IF EXISTS ${qi('rejscan_' + rejectKey)}`).catch(() => {});
}

/** T396：按 dlAmbr 聚合 Σvol、Σtime，Rate = Σvol / Σtime。一次扫描同时得到总行数。 */
export async function ingestT396(key, file) {
  const sniff = await sniffFile(file);
  const missing = T396_REQUIRED.filter((c) => !sniff.columns.includes(c));
  if (missing.length) throw new Error(`T396 缺少字段：${missing.join('、')}（文件 ${file.name}）`);
  const name = await registerFile(key, file);
  await dropRejects(key);
  try {
    const rows = await query(`
      SELECT user_id, coalesce(sum(vol), 0) AS sum_vol, coalesce(sum(t), 0) AS sum_time, count(*) AS rows
      FROM (
        SELECT ${normUserExpr(qi('dlAmbr'))} AS user_id, ${numExpr(qi('dlThpVolRmvLastSlot'))} AS vol, ${numExpr(qi('dlThpTimeRmvLastSlot'))} AS t
        FROM ${readCsvSql(name, sniff, key)}
      )
      GROUP BY user_id`);
    const total = rows.reduce((n, r) => n + (Number(r.rows) || 0), 0);
    const aggregate = rows
      .filter((r) => r.user_id !== null && r.user_id !== undefined)
      .map((r) => ({ userId: String(r.user_id), sumVol: r.sum_vol, sumTime: r.sum_time, rows: r.rows, rate: r.sum_time > 0 ? r.sum_vol / r.sum_time : null }))
      .sort((a, b) => b.sumTime - a.sumTime || a.userId.localeCompare(b.userId));
    const quality = await collectQuality(key, total, sniff);
    return { rows: total, columns: sniff.columns, aggregate, quality };
  } finally {
    await dropRejects(key);
  }
}

/** T537 / T714：只把选中字段与连接键读入内存表 src_<key>。 */
export async function ingestTable(key, file, traceId, wantedColumns, sniffed) {
  const sniff = sniffed || (await sniffFile(file));
  if (!sniff.columns.length) throw new Error(`CSV 为空或无法识别表头：${file.name}`);
  const keys = resolveMergeKeys(sniff.columns, traceId);
  const name = await registerFile(key, file);
  await dropRejects(key);
  const available = new Set(sniff.columns);
  const numeric = new Set(sniff.numericColumns);
  const selected = [];
  // 连接键按文件里的实际写法（大小写）加入
  for (const c of [...Object.values(keys), ...wantedColumns]) if (available.has(c) && !selected.includes(c)) selected.push(c);
  const numSelected = selected.filter((c) => numeric.has(c));
  // 数值列里出现的非数字文本（如 N/A）会按空值处理：逐行计数，写进质量报告，不悄悄丢掉
  const badExpr = numSelected.length
    ? numSelected.map((c) => `(CASE WHEN NULLIF(TRIM(${qi(c)}), '') IS NOT NULL AND LOWER(TRIM(${qi(c)})) <> 'nan' AND TRY_CAST(TRIM(${qi(c)}) AS DOUBLE) IS NULL THEN 1 ELSE 0 END)`).join(' + ')
    : '0';
  const parts = [
    'row_number() OVER () AS __source_row',
    `${normCrntiExpr(qi(keys.crnti))} AS __key_crnti`,
    `${textExpr(qi(keys.time))} AS __key_time`,
    `${normUserExpr(qi(keys.frm))} AS __key_frm`,
    `${normUserExpr(qi(keys.slot))} AS __key_slot`,
    ...selected.map((c) => `${numeric.has(c) ? numExpr(qi(c)) : textExpr(qi(c))} AS ${qi(c)}`),
    `(${badExpr})::INTEGER AS __bad_num`,
  ];
  const table = `src_${key}`;
  let quality;
  try {
    await exec(`CREATE OR REPLACE TABLE ${qi(table)} AS SELECT ${parts.join(', ')} FROM ${readCsvSql(name, sniff, key)}`);
    const rows = Number(await scalar(`SELECT count(*) FROM ${qi(table)}`)) || 0;
    if (!rows) throw new Error(`CSV 没有可用数据行：${file.name}`);
    const [bad] = await query(`SELECT coalesce(sum(__bad_num), 0)::BIGINT AS cells, count(*) FILTER (WHERE __bad_num > 0) AS nrows,
      list(__source_row ORDER BY __source_row) FILTER (WHERE __bad_num > 0) AS sample FROM ${qi(table)}`);
    let badCells = bad.cells;
    const badColumns = [];
    // 文件开头一段全空、无法判断类型的列，用全量数据复核：92% 以上可转数字就改成数值列（与旧版阈值一致）
    for (const c of selected.filter((x) => sniff.undecidedColumns?.includes(x))) {
      const [r] = await query(`SELECT count(${qi(c)}) AS n, count(TRY_CAST(${qi(c)} AS DOUBLE)) AS k FROM ${qi(table)} WHERE lower(${qi(c)}) <> 'nan'`);
      if (r.n && r.k / r.n >= 0.92) {
        await exec(`ALTER TABLE ${qi(table)} ALTER ${qi(c)} TYPE DOUBLE USING ${numExpr(qi(c))}`);
        numeric.add(c);
        if (r.n > r.k) { badCells += r.n - r.k; badColumns.push(c); }
      }
    }
    await exec(`ALTER TABLE ${qi(table)} DROP COLUMN __bad_num`);
    quality = await collectQuality(key, rows, sniff);
    quality.nonNumericCells = badCells;
    quality.nonNumericRows = bad.nrows;
    quality.nonNumericSample = (bad.sample ? Array.from(bad.sample) : []).slice(0, 10);
    quality.nonNumericColumns = badColumns;
    quality.rowsInTable = rows;
  } finally {
    await dropRejects(key);
  }
  return {
    table,
    rows: quality.rowsInTable,
    columns: sniff.columns,
    selected,
    numericColumns: selected.filter((c) => numeric.has(c)),
    keyMapping: keys,
    quality,
  };
}

export async function dropTable(table) {
  await exec(`DROP TABLE IF EXISTS ${qi(table)}`);
}
