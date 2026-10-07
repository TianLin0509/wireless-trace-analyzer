// 筛选条件的文字描述
const OPS = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq_num: '=', eq: '=' };

export function describeFilter(f) {
  const vals = Array.isArray(f.value) ? f.value : [f.value];
  switch (f.op) {
    case 'in': return `${f.column} ∈ ${vals.slice(0, 3).join(',')}${vals.length > 3 ? ` 等 ${vals.length} 个` : ''}`;
    case 'not_in': return `${f.column} ∉ ${vals.slice(0, 3).join(',')}${vals.length > 3 ? ` 等 ${vals.length} 个` : ''}`;
    case 'contains': return `${f.column} 包含“${f.value}”`;
    case 'between': return `${f.value} ≤ ${f.column} ≤ ${f.value2}`;
    case 'is_null': return `${f.column} 为空 / NaN`;
    case 'not_null': return `${f.column} 非空`;
    default: return `${f.column} ${OPS[f.op] || '='} ${f.value}`;
  }
}
