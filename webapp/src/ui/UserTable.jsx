// 单小区 · 用户：每个用户一行的指标表。点表头排序；点行选中用户（全局范围，作用于概览、明细、图表）；明显差于小区整体的格子标红。
import { useState } from 'preact/hooks';
import * as S from '../store.js';
import { useAsync } from './hooks.js';
import { userMetrics, cellBasics, joinRates } from '../engine/single.js';
import { filterSql } from '../engine/query.js';
import { fmt, fmtInt, localDateTag } from './fmt.js';

const COLS = [
  { k: 'user', label: '用户（ambr）', left: true },
  { k: 'rate', label: 'Rate（T396）', d: 2, tip: 'Σvol / Σtime', worse: (x, c, u) => c.rate != null && x < c.rate * 0.5 && (u.share || 0) >= 5 },
  { k: 'share', label: 'TTI 占比 %', d: 1 },
  { k: 'rows', label: '调度行数', int: true },
  { k: 'mcs', label: 'MCS 均值', d: 2, worse: (x, c) => c.mcs != null && x <= c.mcs - 5 },
  { k: 'tb0', label: 'tb0 MCS', d: 2 },
  { k: 'rank2', label: 'Rank2 %', d: 1 },
  { k: 'bler', label: 'BLER %', d: 2, worse: (x, c) => c.bler != null && x >= Math.max(10, c.bler * 2) },
  { k: 'dtx', label: 'DTX 行', int: true },
  { k: 'trunc', label: '截包 %', d: 2, worse: (x, c) => c.trunc != null && x >= Math.max(5, c.trunc * 2) },
  { k: 'olla', label: 'OLLA dB', d: 2, worse: (x, c) => c.olla != null && x <= c.olla - 2 },
  { k: 'rb', label: 'RB 均值', d: 1 },
  { k: 'cqi', label: 'CQI 均值', d: 2 },
];

export function UserTable() {
  const side = S.sides.value.A;
  const v = S.view.value;
  const t396 = S.t396.value;
  const ready = S.ready.value;
  const [sort, setSort] = useState({ k: 'share', desc: true });
  const [q, setQ] = useState('');
  const tableFilters = v.filters || [];
  const res = useAsync(async () => {
    if (!ready || !side) return null;
    const where = filterSql(tableFilters, side.columns, v.search);
    const cell = await cellBasics(side, where);
    const list = joinRates(await userMetrics(side, where), t396);
    return { cell: { ...cell, rate: t396?.cellRateA ?? null }, list };
  }, [S.dataVersion.value, JSON.stringify(tableFilters), v.search, ready, t396]);
  const selected = new Set(S.users.value);
  const d = res.data;
  const present = d ? COLS.filter((c) => c.k === 'user' || d.list.some((u) => u[c.k] != null)) : COLS;
  let rows = d ? d.list.filter((u) => !q || u.user.includes(q.trim())) : [];
  rows = [...rows].sort((a, b) => {
    const x = a[sort.k], y = b[sort.k];
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    const r = sort.k === 'user' ? String(x).localeCompare(String(y), 'zh', { numeric: true }) : x - y;
    return sort.desc ? -r : r;
  });
  const toggle = (u) => {
    const next = new Set(selected);
    next.has(u) ? next.delete(u) : next.add(u);
    S.users.value = [...next];
  };
  const exportCsv = () => {
    const head = present.map((c) => c.label);
    const lines = [head, ...rows.map((u) => present.map((c) => (u[c.k] == null ? '' : c.k === 'user' ? u.user : c.int ? u[c.k] : Number(u[c.k]).toFixed(c.d))))]
      .map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(','));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${localDateTag()}-单小区用户指标.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const cell = d?.cell || {};
  return (
    <div>
      <div class="tool">
        <input class="input" style="width:180px" placeholder="搜索 ambr" value={q} onInput={(e) => setQ(e.target.value)} />
        <span class="muted" style="font-size:12px">{d ? `${rows.length} 个用户` : ''}{selected.size ? ` · 已选 ${selected.size} 个` : ''} · 点行选中用户，点表头排序；<span class="dn">红色</span> = 明显差于小区整体（规则同自动体检）</span>
        <span class="sp" />
        {selected.size > 0 && <>
          <button class="btn" onClick={() => (S.tab.value = 'cht')}>看所选用户图表</button>
          <button class="btn" onClick={() => (S.tab.value = 'tbl')}>看所选用户明细</button>
          <button class="btn text" onClick={() => (S.users.value = [])}>清空选择</button>
        </>}
        <button class="btn" disabled={!rows.length} onClick={exportCsv}>导出 CSV</button>
      </div>
      {res.loading && !d && <div class="empty">正在按用户统计…</div>}
      {res.error && <div class="banner warn">统计失败：{String(res.error.message || res.error)}</div>}
      {d && (
        <div style="overflow:auto">
          <table class="t utable">
            <thead>
              <tr>{present.map((c) => (
                <th class={c.left ? 'left' : ''} title={c.tip || ''} onClick={() => setSort({ k: c.k, desc: sort.k === c.k ? !sort.desc : c.k !== 'user' })} style="cursor:pointer;white-space:nowrap">
                  {c.label}{sort.k === c.k ? (sort.desc ? ' ↓' : ' ↑') : ''}
                </th>
              ))}</tr>
              <tr class="cellrow">{present.map((c) => (
                <td class={c.left ? 'left' : 'num'}>{c.k === 'user' ? '小区整体' : c.k === 'share' ? '100' : cell[c.k] != null ? fmt(cell[c.k], c.d) : ''}</td>
              ))}</tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr class={selected.has(u.user) ? 'sel' : ''} onClick={() => toggle(u.user)} style="cursor:pointer">
                  {present.map((c) => {
                    const x = u[c.k];
                    if (c.k === 'user') return <td class="left"><span class={'cb' + (selected.has(u.user) ? ' on' : '')} /> <b>{u.user}</b></td>;
                    const bad = x != null && c.worse && (c.k === 'rate' || (c.k === 'bler' ? (u.valid || 0) >= 200 : (u.rows || 0) >= 200)) && c.worse(x, cell, u);
                    return <td class={'num' + (bad ? ' dn bad' : '')}>{x == null ? '—' : c.int ? fmtInt(x) : fmt(x, c.d)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
