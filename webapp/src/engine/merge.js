// 合并：以 T537 每一行为锚点，按 crnti + HH:MM:SS + frm + slot 精确左连接 T714。
// 714 同一连接键有多行时取文件中最靠前的一行，并记录候选行数；未匹配行标记 NaN。与旧版 merge_side 口径一致。
import { exec, query, scalar } from './db.js';
import { qi } from './sql.js';
import { SCALE_714 } from './config.js';

const KEYS = ['__key_crnti', '__key_time', '__key_frm', '__key_slot'];

/**
 * src714 缺失时，fallback714（另一侧的 714 元数据）用来补出同样的“714_”空列，保证 A/B 列集合一致。
 */
export async function mergeSide(side, src537, src714, fallback714 = null) {
  const table = `merged_${side.toLowerCase()}`;
  await exec(`DROP TABLE IF EXISTS ${qi(table)}`);
  if (!src537) return null;
  const cols537 = [...src537.selected];
  const anchorSelect = ['a.__source_row', ...KEYS.map((k) => `a.${k}`), ...cols537.map((c) => `a.${qi(c)}`)];
  const meta714 = src714 || fallback714;
  const cols714 = meta714 ? [...meta714.selected] : [];
  const num714 = new Set(meta714 ? meta714.numericColumns : []);
  let duplicateKeys = 0;
  const partition = KEYS.join(', ');
  if (src714) {
    const out714 = cols714.map((c) => `link.${qi('714_' + c)}`);
    // 先在只有“连接键 + 行号”的窄表上排序去重，再按行号取回所需列，避免窗口函数拖着整张宽表
    await exec(`
      CREATE TABLE ${qi(table)} AS
      WITH anchor AS (SELECT ${anchorSelect.join(', ')} FROM ${qi(src537.table)} a),
      link_keys AS (
        SELECT ${KEYS.map((k) => `l.${k}`).join(', ')}, l.__source_row AS __src,
          COUNT(*) OVER (PARTITION BY ${partition}) AS __candidate_rows,
          ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY l.__source_row) AS __rank
        FROM ${qi(src714.table)} l
        WHERE ${KEYS.map((k) => `l.${k} IS NOT NULL`).join(' AND ')}
      ),
      link AS (
        SELECT ${KEYS.map((k) => `lk.${k}`).join(', ')}, lk.__candidate_rows, l.__source_row,
          ${cols714.map((c) => `l.${qi(c)} AS ${qi('714_' + c)}`).concat(['NULL AS __pad']).join(', ')}
        FROM link_keys lk JOIN ${qi(src714.table)} l ON l.__source_row = lk.__src
        WHERE lk.__rank = 1
      )
      SELECT anchor.*,
        CASE WHEN link.__source_row IS NULL THEN 'NaN' ELSE '已匹配' END AS "714_匹配状态",
        COALESCE(link.__candidate_rows, 0) AS "714_候选行数",
        link.__source_row AS "714_来源行号"
        ${out714.length ? ',' + out714.join(', ') : ''}
      FROM anchor LEFT JOIN link
        ON ${KEYS.map((k) => `anchor.${k} = link.${k}`).join(' AND ')}
      ORDER BY anchor.__source_row`);
    duplicateKeys = Number(await scalar(`SELECT count(*) FROM (SELECT ${partition} FROM ${qi(src714.table)}
      WHERE ${KEYS.map((k) => `${k} IS NOT NULL`).join(' AND ')} GROUP BY ${partition} HAVING count(*) > 1)`)) || 0;
  } else {
    const nulls = cols714.map((c) => `CAST(NULL AS ${num714.has(c) ? 'DOUBLE' : 'VARCHAR'}) AS ${qi('714_' + c)}`);
    await exec(`CREATE TABLE ${qi(table)} AS
      SELECT ${anchorSelect.join(', ')}, 'NaN' AS "714_匹配状态", 0::BIGINT AS "714_候选行数", NULL::BIGINT AS "714_来源行号"
        ${nulls.length ? ',' + nulls.join(', ') : ''}
      FROM ${qi(src537.table)} a ORDER BY a.__source_row`);
  }
  const extraNumeric = [];
  for (const [srcName, outName] of [['mcsOffset[0]', '714_mcsOffset0_scaled'], ['compOlla', '714_compOlla_scaled']]) {
    if (cols714.includes(srcName) && num714.has(srcName)) {
      await exec(`ALTER TABLE ${qi(table)} ADD COLUMN ${qi(outName)} DOUBLE`);
      await exec(`UPDATE ${qi(table)} SET ${qi(outName)} = ${qi('714_' + srcName)} / ${SCALE_714}`);
      extraNumeric.push(outName);
    }
  }
  const [{ n, matched }] = await query(`SELECT count(*) AS n, count(*) FILTER (WHERE "714_匹配状态" = '已匹配') AS matched FROM ${qi(table)}`);
  const info = await query(`SELECT column_name FROM information_schema.columns WHERE table_name = '${table}' ORDER BY ordinal_position`);
  const columns = info.map((r) => r.column_name);
  const numericColumns = [
    ...src537.numericColumns,
    ...cols714.filter((c) => num714.has(c)).map((c) => '714_' + c),
    ...extraNumeric,
    '714_候选行数',
  ];
  return {
    side,
    table,
    columns,
    visibleColumns: columns.filter((c) => !c.startsWith('__')),
    numericColumns,
    anchorRows: n,
    matchedRows: matched,
    nanRows: n - matched,
    matchRate: n ? (matched / n) * 100 : 0,
    duplicate714Keys: duplicateKeys,
    has714: !!src714,
  };
}
