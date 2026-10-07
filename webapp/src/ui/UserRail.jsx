import { useState } from 'preact/hooks';
import * as S from '../store.js';
import { fmt, fmtPct } from './fmt.js';

const sortModes = { impact: '按影响', share: '按占比', diff: '按变化', id: '按编号' };

export function UserRail() {
  const [q, setQ] = useState('');
  const [mode, setMode] = useState('impact');
  const cmp = S.t396.value;
  const selected = new Set(S.users.value);
  let rows = cmp?.rows || [];
  if (q) rows = rows.filter((r) => r.userId.includes(q.trim()));
  rows = [...rows].sort((a, b) => {
    if (mode === 'impact') return (a.impact ?? 0) - (b.impact ?? 0) || b.maxShare - a.maxShare;
    if (mode === 'share') return b.maxShare - a.maxShare;
    if (mode === 'diff') return (a.diffPct ?? 0) - (b.diffPct ?? 0);
    return a.userId.localeCompare(b.userId, 'zh', { numeric: true });
  });
  const toggle = (u) => {
    const next = new Set(selected);
    next.has(u) ? next.delete(u) : next.add(u);
    S.users.value = [...next];
  };
  const maxShare = Math.max(1, ...rows.map((r) => r.maxShare || 0));
  return (
    <aside class="rail">
      <div class="rh">
        <b>用户 · T396 速率</b>
        <select class="input" style="font-size:11px;padding:1px 4px" value={mode} onChange={(e) => setMode(e.target.value)}>
          {Object.entries(sortModes).map(([k, v]) => <option value={k}>{v}</option>)}
        </select>
      </div>
      <input class="input rsearch" placeholder="搜索 ambr" value={q} onInput={(e) => setQ(e.target.value)} />
      <div class="ulist">
        {!cmp && <div class="empty" style="padding:24px 14px">{S.running.value ? '正在计算 T396 速率…' : '没有 T396 数据'}</div>}
        {cmp && (
          <div class="urow cell" onClick={() => (S.users.value = [])} title="清空用户选择，回到小区全量">
            <span class={'cb' + (selected.size ? '' : ' on')} />
            <div><div class="id">小区汇总</div><div class="r num"><span class="A">{fmt(cmp.cellRateA, 2)}</span> → <span class="B">{fmt(cmp.cellRateB, 2)}</span></div></div>
            <div class={'d num ' + cls(cmp.diffPct)}>{fmtPct(cmp.diffPct)}</div>
          </div>
        )}
        {rows.map((r) => (
          <div class={'urow' + (selected.has(r.userId) ? ' sel' : '')} onClick={() => toggle(r.userId)} title={`TTI 占比 A ${fmt(r.shareA, 1)}% / B ${fmt(r.shareB, 1)}%；对小区速率拖累 ${fmt(r.impact, 2)} pt`}>
            <span class="cb" />
            <div>
              <div class="id">{r.userId}</div>
              <div class="r num"><span class="A">{fmt(r.rateA, 2)}</span> → <span class="B">{fmt(r.rateB, 2)}</span> · TTI {fmt(r.maxShare, 1)}%</div>
              <div class="sh"><s style={{ width: `${(r.maxShare / maxShare) * 100}%` }} /></div>
            </div>
            <div class={'d num ' + cls(r.diffPct)}>{fmtPct(r.diffPct)}</div>
          </div>
        ))}
      </div>
      <div class="rf">
        <span>{selected.size ? <>已选 <b>{selected.size}</b> 个用户</> : '范围：小区全部用户'}</span>
        {selected.size > 0 && <button class="btn text" onClick={() => (S.users.value = [])}>清空</button>}
      </div>
    </aside>
  );
}

const cls = (d) => (d == null || Math.abs(d) < 2 ? 'muted' : d < 0 ? 'dn' : 'up');
