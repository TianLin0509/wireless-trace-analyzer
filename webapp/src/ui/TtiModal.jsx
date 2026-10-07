import * as S from '../store.js';
import { useAsync } from './hooks.js';
import { ttiPreview } from '../engine/query.js';

/** TTI 上下文：不受任何筛选影响，显示同一调度时刻的全部用户行。 */
export function TtiModal({ side, sideKey, tti, columns, onClose }) {
  const res = useAsync(() => ttiPreview(side, tti, columns), [tti, side.table]);
  const sel = new Set(S.users.value);
  const d = res.data;
  return (
    <div class="modal-wrap" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal">
        <header>
          <b>TTI {tti} · 方案 {sideKey}</b>
          {d && <span class="muted">共 {d.rows.length} 行 · {d.users.length} 个用户：{d.users.join('、')}</span>}
          <span class="sp" />
          <button class="btn" onClick={onClose}>关闭</button>
        </header>
        <div class="mbody">
          <p class="faint" style="margin:0 0 8px">此处读取完整合并表，不应用用户范围、列筛选或搜索；高亮行为当前选中的用户。</p>
          {res.loading && <div class="empty">加载中…</div>}
          {res.error && <div class="banner warn">{String(res.error.message || res.error)}</div>}
          {d && (
            <div class="tblwrap">
              <table class="t">
                <thead><tr>{d.columns.map((c) => <th>{c}</th>)}</tr></thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr>{d.columns.map((c) => <td style={sel.has(String(r.ambr)) ? 'background:#f1f8f5;font-weight:600' : ''}>{r[c] == null ? <span class="faint">NaN</span> : String(r[c])}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
