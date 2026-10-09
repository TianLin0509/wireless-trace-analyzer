/** T396 只有批次内逐用户聚合，不能冒充任意 T537 行条件下的速率。 */
export function rateScopeLabel(users = [], view = {}) {
  const userText = users.length ? `所选 ${users.length} 个用户` : '全部用户';
  const filtered = (view.filters || []).length || String(view.search || '').trim();
  return `T396 全批次 · ${userText}${filtered ? '；未应用当前列筛选或搜索' : ''}`;
}

export function missingFilterColumns(filters = [], sides = {}) {
  return Object.entries(sides).flatMap(([key, side]) => side
    ? filters.filter((f) => !f.scope && !side.columns.includes(f.column)).map((f) => `${key} 缺少 ${f.column}`)
    : []);
}
