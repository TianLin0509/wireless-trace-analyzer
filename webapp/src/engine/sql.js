// SQL 片段工具：标识符/字符串转义与归一化表达式。所有拼接到 SQL 的名字都必须经过这里。

export const qi = (name) => '"' + String(name).replace(/"/g, '""') + '"';
export const qs = (text) => "'" + String(text).replace(/'/g, "''") + "'";

/** 与旧版 normalize_user_id 一致：整数形式的数值统一成整数字符串，空值/nan 视为 NULL。 */
export function normUserExpr(column) {
  const v = `NULLIF(TRIM(CAST(${column} AS VARCHAR)), '')`;
  const d = `TRY_CAST(${v} AS DOUBLE)`;
  return `(CASE WHEN ${v} IS NULL OR LOWER(${v}) IN ('nan','none','null') THEN NULL
    WHEN ${d} IS NOT NULL AND isfinite(${d}) AND ${d} = floor(${d}) AND abs(${d}) < 9e15 THEN CAST(CAST(${d} AS BIGINT) AS VARCHAR)
    ELSE ${v} END)`;
}

/** 与旧版 normalize_crnti_id 一致：含 0x 十六进制的值先转十进制。 */
export function normCrntiExpr(column) {
  const v = `NULLIF(TRIM(CAST(${column} AS VARCHAR)), '')`;
  const hex = `regexp_extract(${v}, '0x[0-9a-fA-F]+')`;
  return `(CASE WHEN ${v} IS NOT NULL AND ${hex} <> '' AND TRY_CAST(${hex} AS BIGINT) IS NOT NULL
    THEN CAST(TRY_CAST(${hex} AS BIGINT) AS VARCHAR) ELSE ${normUserExpr(column)} END)`;
}

/** 数值列：空串/nan 为 NULL，其余 TRY_CAST 成 DOUBLE。 */
export function numExpr(column) {
  const d = `TRY_CAST(NULLIF(TRIM(${column}), '') AS DOUBLE)`;
  return `(CASE WHEN isnan(${d}) THEN NULL ELSE ${d} END)`;
}

export const textExpr = (column) => `NULLIF(TRIM(${column}), '')`;
