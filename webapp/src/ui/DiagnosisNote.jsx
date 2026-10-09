import * as S from '../store.js';

export function DiagnosisNote() {
  const d = S.diagnosis.value;
  if (!d || !S.users.value.includes(d.user)) return null;
  return <div class="banner info diagnosis-note"><div><b>正在检查用户 {d.user}：{d.title}</b><div>{d.note}</div></div><span class="sp" /><button class="btn small" onClick={() => {
    S.updateView({ filters: d.baseFilters, search: d.baseSearch });
    S.users.value = []; S.diagnosis.value = null; S.tab.value = 'sum';
  }}>返回体检范围</button></div>;
}
