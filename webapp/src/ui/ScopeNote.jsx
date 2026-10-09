import * as S from '../store.js';
import { rateScopeLabel, missingFilterColumns } from '../engine/analysis-scope.js';
import { describeFilter } from './filters.js';

export function ScopeNote({ allUsers = false }) {
  const v = S.view.value;
  const missing = missingFilterColumns(v.filters, S.sides.value);
  const changed = (v.filters || []).length || v.search;
  return (
    <div class="scope-note">
      <div><b>速率范围：</b>{rateScopeLabel(allUsers ? [] : S.users.value, v)}。{allUsers ? '用户表列出全部用户，其他指标按当前列筛选及搜索计算；点行选择影响概览、明细与图表。' : '指标与明细按当前用户、列筛选及搜索计算。'}</div>
      {changed && <div><b>当前条件：</b>{(v.filters || []).map(describeFilter).join('；')}{v.search ? `；搜索“${v.search}”` : ''} <button class="btn text small" onClick={() => { S.updateView({ filters: [], search: '' }); S.diagnosis.value = null; }}>清除列筛选与搜索</button></div>}
      {!!missing.length && <div class="dn">{missing.join('；')}：对应侧无法应用这些条件，请避免把两侧当作相同筛选范围。</div>}
    </div>
  );
}
