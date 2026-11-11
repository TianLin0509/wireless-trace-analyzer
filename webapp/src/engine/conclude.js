// 诊断结论：把速率拆解、受限类型、链路判读、异常事件合成“每个用户一句话初判”。纯函数，可单测。
// 初判是规则线索，不是确认根因；每条都附证据，界面上可一键跳到对应页签核实。
import { FACTORS, logShare } from './diagnose.js';

export const CAUSES = {
  data: { label: '业务量不足（小包/截包）', hint: '缓存经常一次就发完，速率低主要因为没那么多数据，不是空口问题；全小区都这样时属于测试场景（小业务），不是故障', tab: 'rate' },
  sched: { label: '调度机会/资源不足', hint: '调度失败多或被调度的次数少：看 CCE、用户数与优先级', tab: 'rate' },
  optimistic: { label: 'CQI 偏乐观（OLLA 长期深负）', hint: 'OLLA 外环一直往下压：CQI 虚高或干扰没有体现在 CQI 里', tab: 'link' },
  fluct: { label: '信道波动大（BLER 超目标）', hint: 'OLLA 跟不上信道变化：移动、突发干扰', tab: 'evt' },
  pdcch: { label: 'PDCCH 漏检（DTX 多）', hint: 'UE 没收到调度：PDCCH 波束、聚合等级或覆盖', tab: 'evt' },
  mu: { label: 'MU 配对降阶', hint: '配对后 MCS 降得多：配对干扰', tab: 'link' },
  channel: { label: '信道质量差（MCS 低）', hint: '每 RB 每层比特低但 OLLA 正常：覆盖或干扰导致 SINR 低', tab: 'link' },
  rank: { label: '层数低', hint: '多流比例低：信道相关性高或 SINR 不足以支撑多流', tab: 'rate' },
  rb: { label: '分到的 RB 少', hint: '每次分到的 RB 比别人少：用户多、频域调度或业务量', tab: 'rate' },
};

// 2026-11-11 真实数据回测后收紧：事件要求每千次初传 ≥ 2 次；信道差门限 75%；数据受限用户不再由小包的后果（MCS 降阶、RB 少、层数低）推出别的初判
export const CONCLUDE_RULES = { weak: 0.85, channel: 0.75, data: 50, fail: 5, minTries: 100, evMin: 3, evRel: 2, evPerK: 2, common: 0.6 };

const med = (xs) => { const v = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };

/**
 * 单侧（单小区或 A/B 的某一侧）每个用户的初判。
 * rate: rateFactors 结果；lim: limitShares 结果；link: linkDiag 结果 + flags(Map user→[[标签, 说明]])；events: detectEvents 的 events；t396: {userId→{rate, share}}
 */
export function concludeUsers({ rate, lim, linkFlagsByUser, events, t396, ctrlFlagsByUser }, R = CONCLUDE_RULES) {
  const users = (rate?.users || []).filter((u) => u.tries >= R.minTries);
  const m = Object.fromEntries(FACTORS.map((f) => [f.id, med(users.map((u) => u.factors[f.id]))]));
  const evBy = new Map();
  for (const e of events || []) {
    if (!evBy.has(e.user)) evBy.set(e.user, {});
    evBy.get(e.user)[e.type] = (evBy.get(e.user)[e.type] || 0) + 1;
  }
  // 事件按“每千次初传的事件数”与用户中位比：同小区大家都有的，是信道/小区的普遍现象，不单独算到某个用户头上
  const evRate = (u, t) => ((evBy.get(u.user) || {})[t] || 0) / u.tries * 1000;
  const evMed = { nack: med(users.map((u) => evRate(u, 'nack'))), dtx: med(users.map((u) => evRate(u, 'dtx'))) };
  const evHigh = (u, t) => { const c = (evBy.get(u.user) || {})[t] || 0; return c >= R.evMin && evRate(u, t) >= R.evPerK && (!evMed[t] || evRate(u, t) >= R.evRel * evMed[t]); };
  const out = [];
  for (const u of users) {
    const ratio = Object.fromEntries(FACTORS.map((f) => [f.id, m[f.id] && u.factors[f.id] != null ? u.factors[f.id] / m[f.id] : null]));
    const l = lim?.users?.get?.(u.user) || null;
    const flags = (linkFlagsByUser?.get?.(u.user) || []).map(([t]) => t);
    const ev = evBy.get(u.user) || {};
    const causes = [];
    const add = (id, evidence, w) => causes.push({ id, ...CAUSES[id], evidence, weight: w });
    const dataLimited = l?.data != null && l.data >= R.data;
    if (dataLimited) add('data', `${l.data.toFixed(0)}% 的初传一次就把缓存发完`, 3 + l.data / 50);
    if (l?.fail != null && l.fail >= R.fail) add('sched', `调度失败 ${l.fail.toFixed(1)}%${l.topCode ? `（主要失败码 ${l.topCode}，DRX/GAP 类属正常机制）` : ''}`, 2 + l.fail / 10);
    if (flags.includes('OLLA 深负')) add('optimistic', 'OLLA 外环累计量比用户中位低 2 阶以上', 2.5);
    if (flags.includes('BLER 超目标') || evHigh(u, 'nack')) add('fluct', [flags.includes('BLER 超目标') && 'BLER 比目标高 5 点以上', ev.nack && `连续 NACK 事件 ${ev.nack} 次`].filter(Boolean).join('，'), 2 + (ev.nack || 0) / 10);
    if ((ratio.pdcch != null && ratio.pdcch < 0.97) || evHigh(u, 'dtx')) add('pdcch', [ratio.pdcch != null && `PDCCH 送达 ${(u.factors.pdcch * 100).toFixed(1)}%（中位 ${(m.pdcch * 100).toFixed(1)}%）`, ev.dtx && `连续 DTX 事件 ${ev.dtx} 次`].filter(Boolean).join('，'), 2 + (ev.dtx || 0) / 20);
    // 控制信道（650/941）：CCE 申请失败并进“调度不足”，聚合级别高并进“PDCCH 漏检”；原判没触发时单独成立
    for (const [tag, text] of ctrlFlagsByUser?.get?.(u.user) || []) {
      const id = tag.startsWith('CCE') ? 'sched' : 'pdcch';
      const c = causes.find((x) => x.id === id);
      if (c) c.evidence += `；${text}`;
      else add(id, text, tag === 'CCE 失败严重' ? 2.5 : 1.3);
    }
    if (flags.includes('MU 降阶大')) add('mu', 'MU MCS 比 SU 低 3 阶以上', 1.5);
    // 小包降阶和业务量不足是同一件事：已判数据受限时并进同一条证据，不另报
    if (flags.includes('小包降阶')) { const d = causes.find((c) => c.id === 'data'); if (d) d.evidence += '；MCS 主要在降阶步骤扣掉（小包降阶，正常机制）'; else add('data', '降阶步骤扣阶多（小包降阶）', 2.5); }
    // 数据受限时，每RB每层比特低（小包降阶）、层数低、RB 少都是小包的结果，不再单列成别的原因
    if (!dataLimited && ratio.eta != null && ratio.eta < R.channel && !flags.includes('OLLA 深负')) add('channel', `每RB每层比特为中位的 ${(ratio.eta * 100).toFixed(0)}%`, 1 + (1 - ratio.eta) * 3);
    if (!dataLimited && ratio.layers != null && ratio.layers < R.weak) add('rank', `层数为中位的 ${(ratio.layers * 100).toFixed(0)}%`, 1 + (1 - ratio.layers) * 2);
    if (!dataLimited && ratio.rb != null && ratio.rb < R.weak) add('rb', `RB/次为中位的 ${(ratio.rb * 100).toFixed(0)}%`, 1 + (1 - ratio.rb) * 2);
    causes.sort((a, b) => b.weight - a.weight);
    for (let i = causes.length - 1; i > 0; i--) if (causes.findIndex((c) => c.id === causes[i].id) < i) causes.splice(i, 1);
    const r = t396?.get?.(u.user);
    out.push({ user: u.user, tries: u.tries, ratio, causes, events: ev, rate: r?.rate ?? null, share: r?.share ?? null, flags });
  }
  // 先看对小区影响大的：有初判的在前，按 TTI 占比 × 短板程度排序
  const score = (x) => (x.causes.length ? 1 : 0) * 10 + (x.share || 0) / 10 + (x.causes[0]?.weight || 0);
  return out.sort((a, b) => score(b) - score(a));
}

/** 共性问题：≥ 60% 的用户（至少 4 个）都触发的初判，归为小区级，在用户行里不再重复强调。 */
export function commonCauses(list, R = CONCLUDE_RULES) {
  if ((list?.length || 0) < 4) return [];
  const cnt = {};
  for (const u of list) for (const c of u.causes) cnt[c.id] = (cnt[c.id] || 0) + 1;
  return Object.entries(cnt).filter(([, n]) => n / list.length >= R.common).map(([id, n]) => ({ id, ...CAUSES[id], users: n }));
}

/** A/B：小区与逐用户的一句话结论（主要变化因子 + 佐证）。 */
export function concludeAb(rateA, rateB, limA, limB) {
  const name = (id) => FACTORS.find((f) => f.id === id)?.label || id;
  const cellShare = logShare(rateA?.cell?.factors, rateB?.cell?.factors);
  const lines = [];
  if (cellShare) {
    const parts = [...cellShare.parts].sort((p, q) => Math.abs(q.contrib) - Math.abs(p.contrib));
    const neg = parts.filter((p) => p.contrib <= -0.5), pos = parts.filter((p) => p.contrib >= 0.5);
    let text = `拆解口径下 B 相对 A ${cellShare.total >= 0 ? '+' : ''}${cellShare.total.toFixed(1)}%`;
    if (neg.length) text += `；拖累：${neg.slice(0, 3).map((p) => `${name(p.id)} ${p.contrib.toFixed(1)} 点`).join('、')}`;
    if (pos.length) text += `；抵消：${pos.slice(0, 2).map((p) => `${name(p.id)} +${p.contrib.toFixed(1)} 点`).join('、')}`;
    lines.push(text);
    if (limA?.cell?.fail != null && limB?.cell?.fail != null && Math.abs(limB.cell.fail - limA.cell.fail) >= 1) lines.push(`调度失败 ${limA.cell.fail.toFixed(1)}% → ${limB.cell.fail.toFixed(1)}%`);
  }
  const ua = new Map((rateA?.users || []).map((u) => [u.user, u]));
  const users = [];
  for (const y of rateB?.users || []) {
    const x = ua.get(y.user);
    if (!x || x.tries < 100 || y.tries < 100) continue;
    const s = logShare(x.factors, y.factors);
    if (!s) continue;
    const main = [...s.parts].sort((p, q) => Math.abs(q.contrib) - Math.abs(p.contrib))[0];
    users.push({ user: y.user, total: s.total, main: { id: main.id, label: name(main.id), contrib: main.contrib, ratio: main.ratio }, parts: s.parts, weight: Math.abs(s.total) * Math.sqrt(x.tries) });
  }
  users.sort((a, b) => b.weight - a.weight);
  return { cell: cellShare, lines, users };
}
