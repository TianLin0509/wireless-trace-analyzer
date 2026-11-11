// 诊断结论：每个用户一句话初判 + 证据 + 跳转；A/B 时给小区一句话结论与 B 侧新出现的问题。
import { useState } from 'preact/hooks';
import * as S from '../store.js';
import { useAsync } from './hooks.js';
import { rateFactors, limitShares, linkDiag, detectEvents } from '../engine/diagnose.js';
import { concludeUsers, concludeAb, commonCauses, CAUSES, CONCLUDE_RULES } from '../engine/conclude.js';
import { linkFlags, linkRef } from './LinkTab.jsx';
import { fmt, fmtInt, fmtPct } from './fmt.js';
import { usePager, diagWhere, diagDeps } from './diagCommon.jsx';

const CAUSE_COLOR = { data: '#ea580c', sched: '#9333ea', optimistic: '#dc2626', fluct: '#dc2626', pdcch: '#6b7280', mu: '#0891b2', channel: '#b45309', rank: '#2563eb', rb: '#0e6b4e' };

async function sideEvidence(side, t396Rows, key) {
  const where = diagWhere(side);
  const [rate, lim, link, ev] = [await rateFactors(side, where), await limitShares(side, where), await linkDiag(side, where), await detectEvents(side, where)];
  const ref = linkRef(link.users);
  const flags = new Map(link.users.map((u) => [u.user, linkFlags(u, ref)]));
  const t396 = new Map((t396Rows || []).map((r) => [r.userId, { rate: key === 'A' ? r.rateA : r.rateB, share: key === 'A' ? r.shareA : r.shareB }]));
  return { rate, lim, link, events: ev.events, list: concludeUsers({ rate, lim, linkFlagsByUser: flags, events: ev.events, t396 }) };
}

function CauseTags({ causes, max = 3 }) {
  return causes.slice(0, max).map((c, i) => <span class="tag" style={{ color: CAUSE_COLOR[c.id], borderColor: CAUSE_COLOR[c.id] + '66', background: i === 0 ? CAUSE_COLOR[c.id] + '14' : '#fff', marginRight: '4px', fontWeight: i === 0 ? 600 : 400 }} title={c.hint}>{c.label}</span>);
}

const NOTE_KEY = 'trace-errcode-notes';
const loadNotes = () => { try { return JSON.parse(localStorage.getItem(NOTE_KEY) || '{}'); } catch { return {}; } };

/** 调度失败码 Top：码的含义各版本不同，由使用者在本机备注（只存在本浏览器）。 */
function ErrCodes({ codes }) {
  const [notes, setNotes] = useState(loadNotes);
  if (!codes?.length) return null;
  const edit = (code) => {
    const v = window.prompt(`给失败码 ${code} 写个备注（只保存在本浏览器）`, notes[code] || '');
    if (v == null) return;
    const next = { ...notes, [code]: v.trim() };
    if (!v.trim()) delete next[code];
    setNotes(next);
    try { localStorage.setItem(NOTE_KEY, JSON.stringify(next)); } catch { /* 无痕模式 */ }
  };
  return (
    <div class="kcard"><div class="nm">调度失败码 Top（点码写备注）</div>
      <div style="margin-top:4px">{codes.slice(0, 4).map((c) => (
        <div class="row" style="cursor:pointer" title="点击写备注" onClick={() => edit(c.code)}>
          <span class="num" style="font-family:var(--mono)">{c.code}</span><span class="muted" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{notes[c.code] || ''}</span><span class="sp" /><b class="num">{fmt(c.share, 2)}%</b>
        </div>))}</div></div>
  );
}

const goto = (user, tab, side) => {
  if (tab === 'tl') S.timelineFocus.value = { side, user, range: null };
  else S.users.value = [user];
  S.tab.value = tab;
};

export function ConcludeTab() {
  const single = S.mode.value === 'single';
  const sides = S.sides.value;
  const t396 = S.t396.value;
  const data = useAsync(async (stale) => {
    const out = {};
    for (const k of ['A', 'B']) {
      if (!sides[k]) continue;
      out[k] = await sideEvidence(sides[k], t396?.rows, k);
      if (stale()) return null;
    }
    return out;
  }, [...diagDeps(), t396]);
  const d = data.data;
  return (
    <div class="diag">
      <div class="headline">
        <div><b>诊断结论 · 每个用户一句话初判</b>
          <div class="muted">综合速率拆解、受限类型、链路判读与异常事件；这是规则线索，不是确认根因——每条都附证据，点按钮到对应页签核实。受列筛选与搜索影响。</div></div>
      </div>
      {data.loading && !d && <div class="muted">正在汇总证据（速率拆解、链路、事件）…</div>}
      {data.error && <div class="banner warn">汇总失败：{String(data.error.message || data.error)}</div>}
      {d && (single || !d.A || !d.B ? <SingleView d={d.A || d.B} sideKey={d.A ? 'A' : 'B'} /> : <AbView a={d.A} b={d.B} />)}
    </div>
  );
}

function SingleView({ d, sideKey }) {
  const common = commonCauses(d.list);
  const cset = new Set(common.map((c) => c.id));
  const list = d.list.map((u) => ({ ...u, own: u.causes.filter((c) => !cset.has(c.id)) }));
  const pg = usePager(list, 7);
  const counts = {};
  for (const u of list) for (const c of u.own.slice(0, 1)) counts[c.id] = (counts[c.id] || 0) + 1;
  const clean = list.filter((u) => !u.own.length).length;
  const c = d.link.cell;
  return (
    <div class="diag-top">
      <div class="section" style="margin:0">
        <div class="sh"><b>用户初判（有问题的在前）</b><span class="muted">初传 ≥ {CONCLUDE_RULES.minTries} 次的用户 · 共 {d.list.length} 个</span></div>
        <div class="concl-list">
          {pg.rows.map((u) => (
            <div class="concl-row">
              <div class="concl-id"><b>{u.user}</b><div class="faint num" title="T396 Rate = Σ字节 ÷ Σ微秒；× 8 ≈ Mbps">{u.rate != null ? `Rate ${fmt(u.rate, 2)}（≈${fmt(u.rate * 8, 1)} Mbps） · ` : ''}{u.share != null ? `TTI ${fmt(u.share, 1)}%` : `初传 ${fmtInt(u.tries)}`}</div></div>
              <div class="concl-body">
                {u.own.length ? <><div><CauseTags causes={u.own} /></div><div class="muted" style="font-size:12px">{u.own.slice(0, 2).map((x) => x.evidence).filter(Boolean).join('；')}</div></>
                  : <span class="faint">{u.causes.length ? '只有小区共性问题（见右侧）' : '未触发任何规则'}</span>}
              </div>
              <div class="concl-act">
                {u.own[0] && <button class="btn small" onClick={() => goto(u.user, u.own[0].tab, sideKey)}>看证据</button>}
                <button class="btn small" onClick={() => goto(u.user, 'tl', sideKey)}>时间轴</button>
              </div>
            </div>
          ))}
        </div>
        <div style="padding:0 10px 8px">{pg.bar}</div>
      </div>
      <div class="diag-side">
        {common.length > 0 && <div class="kcard"><div class="nm">小区共性问题（≥ {Math.round(CONCLUDE_RULES.common * 100)}% 用户都有）</div><div style="margin-top:4px">{common.map((c) => <div class="row" title={c.hint}><span style={{ color: CAUSE_COLOR[c.id] }}>●</span><span>{c.label}</span><span class="sp" /><b>{c.users}/{d.list.length}</b></div>)}</div></div>}
        <div class="kcard"><div class="nm">本小区用户的首要问题分布（不含共性）</div>
          <div style="margin-top:6px">{Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([id, n]) => <div class="row"><span style={{ color: CAUSE_COLOR[id] }}>●</span><span>{CAUSES[id].label}</span><span class="sp" /><b>{n}</b></div>)}
            <div class="row"><span class="faint">●</span><span class="muted">未触发规则</span><span class="sp" /><b>{clean}</b></div></div></div>
        {c && <div class="kcard"><div class="nm">小区链路底数</div><div class="link-kv num">
          <span>初传 BLER</span><b>{fmt(c.bler, 2)}%</b><span>目标</span><b>{fmt(c.target, 1)}%</b>
          <span>DTX</span><b>{fmt(c.dtx, 2)}%</b><span>OLLA</span><b>{fmt(c.olla, 2)} 阶</b>
          <span>调度失败</span><b>{fmt(d.lim?.cell?.fail, 2)}%</b><span>数据受限</span><b>{fmt(d.lim?.cell?.data, 1)}%</b>
        </div><div class="foot">BLER 口径：{d.rate.blerSource || '—'}</div></div>}
        <ErrCodes codes={d.lim?.topCodes} />
        <div class="kcard"><div class="nm">初判规则</div><div class="foot" style="line-height:1.7">
          数据受限 ≥ {CONCLUDE_RULES.data}% → 业务量不足；调度失败 ≥ {CONCLUDE_RULES.fail}% → 调度不足；OLLA 深负 → CQI 偏乐观；BLER 超目标或连续 NACK ≥ 3 次 → 信道波动；PDCCH 送达 &lt; 中位 97% 或连续 DTX ≥ 3 次 → PDCCH 漏检；因子低于中位 {Math.round(CONCLUDE_RULES.weak * 100)}% → 对应短板。</div></div>
      </div>
    </div>
  );
}

function AbView({ a, b }) {
  const ab = concludeAb(a.rate, b.rate, a.lim, b.lim);
  const t396 = S.t396.value;
  const cell396 = t396?.cellRateA && t396?.cellRateB ? (t396.cellRateB / t396.cellRateA - 1) * 100 : null;
  const aBy = new Map(a.list.map((u) => [u.user, u]));
  const bBy = new Map(b.list.map((u) => [u.user, u]));
  // B 侧新出现、且 ≥ 60% 用户都有的初判 → 小区级变化，放到小区那一行
  const newCnt = {};
  for (const u of ab.users) {
    const ca = new Set((aBy.get(u.user)?.causes || []).map((c) => c.id));
    for (const c of bBy.get(u.user)?.causes || []) if (!ca.has(c.id)) newCnt[c.id] = (newCnt[c.id] || 0) + 1;
  }
  const cellNew = Object.entries(newCnt).filter(([, n]) => ab.users.length >= 4 && n / ab.users.length >= CONCLUDE_RULES.common).map(([id]) => id);
  const rows = ab.users.map((u) => {
    const ca = new Set((aBy.get(u.user)?.causes || []).map((c) => c.id));
    const nb = (bBy.get(u.user)?.causes || []).filter((c) => !ca.has(c.id) && !cellNew.includes(c.id));
    const gone = (aBy.get(u.user)?.causes || []).filter((c) => !(bBy.get(u.user)?.causes || []).some((x) => x.id === c.id));
    const ea = aBy.get(u.user)?.events || {}, eb = bBy.get(u.user)?.events || {};
    return { ...u, newCauses: nb, gone, ea, eb };
  });
  const pg = usePager(rows, 7);
  return (
    <>
      <div class="banner info concl-cell"><b>小区</b><span>T396 Rate {fmtPct(cell396)}；{ab.lines.join('；') || '样本不足，无法拆解'}。{cellNew.length > 0 && <> B 侧普遍新出现：<b>{cellNew.map((id) => CAUSES[id].label).join('、')}</b>（{cellNew.map((id) => `${newCnt[id]}/${ab.users.length} 个用户`).join('、')}）。</>}</span></div>
      <div class="section">
        <div class="sh"><b>变化最大的用户（按 |变化| × 样本量排序）</b><span class="muted">“B 新出现”= B 侧触发、A 侧没有的初判；“B 已消失”反之</span></div>
        <div class="concl-list">
          {pg.rows.map((u) => (
            <div class="concl-row">
              <div class="concl-id"><b>{u.user}</b><div class={'num ' + (u.total < 0 ? 'dn' : 'up')}>{fmtPct(u.total)}</div></div>
              <div class="concl-body">
                <div>主因：<b class={u.main.contrib < 0 ? 'dn' : 'up'}>{u.main.label} {u.main.contrib >= 0 ? '+' : ''}{u.main.contrib.toFixed(1)} 点</b><span class="muted">（B/A = {fmt(u.main.ratio, 3)}）</span></div>
                <div style="margin-top:3px">{u.newCauses.length ? <><span class="muted" style="font-size:12px">B 新出现：</span><CauseTags causes={u.newCauses} /></> : null}{u.gone.length ? <span class="muted" style="font-size:12px">B 已消失：{u.gone.map((c) => c.label).join('、')}</span> : null}{!u.newCauses.length && !u.gone.length && <span class="faint" style="font-size:12px">两侧初判相同</span>}</div>
                {(u.ea.nack || u.eb.nack || u.ea.dtx || u.eb.dtx || u.ea.fail || u.eb.fail) ? <div class="faint" style="font-size:12px">事件 A → B：连续 NACK {u.ea.nack || 0} → {u.eb.nack || 0}，连续 DTX {u.ea.dtx || 0} → {u.eb.dtx || 0}，连续调度失败 {u.ea.fail || 0} → {u.eb.fail || 0}</div> : null}
              </div>
              <div class="concl-act">
                <button class="btn small" onClick={() => goto(u.user, 'rate', 'B')}>看拆解</button>
                <button class="btn small" onClick={() => goto(u.user, 'tl', 'B')}>B 时间轴</button>
              </div>
            </div>
          ))}
        </div>
        <div style="padding:0 10px 8px">{pg.bar}</div>
      </div>
    </>
  );
}
