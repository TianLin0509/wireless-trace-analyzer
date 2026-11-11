import { describe, it, expect } from 'vitest';
import { logShare, FACTORS, eventMatrix } from '../src/engine/diagnose.js';
import { linkFlags, linkRef } from '../src/ui/LinkTab.jsx';

const f = (o = {}) => ({ tries: 500, okRate: 0.98, rb: 60, layers: 1.6, eta: 500, pdcch: 0.99, decode: 0.9, ...o });

describe('速率拆解：对数分摊', () => {
  it('各因子贡献之和等于总变化', () => {
    const s = logShare(f(), f({ okRate: 0.9, rb: 66, eta: 450 }));
    const sum = s.parts.reduce((x, p) => x + p.contrib, 0);
    expect(sum).toBeCloseTo(s.total, 9);
    const prod = s.parts.reduce((x, p) => x * p.ratio, 1);
    expect(s.total).toBeCloseTo((prod - 1) * 100, 9);
  });
  it('只有一个因子变化时，贡献全归它', () => {
    const s = logShare(f(), f({ eta: 400 }));
    expect(s.parts.find((p) => p.id === 'eta').contrib).toBeCloseTo(-20, 9);
    for (const p of s.parts.filter((x) => x.id !== 'eta')) expect(Math.abs(p.contrib)).toBeLessThan(1e-9);
  });
  it('总变化为 0 但因子此消彼长时，按对数差显示', () => {
    const s = logShare(f(), f({ okRate: 0.98 * 0.9, rb: 60 / 0.9 }));
    expect(Math.abs(s.total)).toBeLessThan(1e-9);
    expect(s.parts.find((p) => p.id === 'okRate').contrib).toBeLessThan(0);
    expect(s.parts.find((p) => p.id === 'rb').contrib).toBeGreaterThan(0);
  });
  it('任一因子缺失或为 0 时不拆解', () => {
    expect(logShare(f(), f({ decode: null }))).toBeNull();
    expect(logShare(f({ rb: 0 }), f())).toBeNull();
    expect(FACTORS.length).toBe(7);
  });
});

describe('链路判读：绝对门限 + 相对用户中位', () => {
  const u = (id, o) => ({ user: id, n: 1000, bler: 10, target: 10, olla: -2, chain: [{ label: 'CQI 估计', value: 20 }, { label: '最终调度', value: 18 }], ...o });
  it('大家都偏负时不逐个标 OLLA 深负，只标比中位再低 2 阶的', () => {
    const users = [u('1', { olla: -5 }), u('2', { olla: -5.5 }), u('3', { olla: -6 }), u('4', { olla: -9 })];
    const ref = linkRef(users);
    const flagged = users.filter((x) => linkFlags(x, ref).some(([t]) => t === 'OLLA 深负')).map((x) => x.user);
    expect(flagged).toEqual(['4']);
  });
  it('BLER 比目标高 5 点以上才标；样本不足不标', () => {
    expect(linkFlags(u('1', { bler: 16 }), {}).map(([t]) => t)).toContain('BLER 超目标');
    expect(linkFlags(u('1', { bler: 14 }), {}).map(([t]) => t)).not.toContain('BLER 超目标');
    expect(linkFlags(u('1', { bler: 30, n: 50 }), {})).toEqual([]);
  });
});

describe('事件矩阵', () => {
  it('按用户汇总并按总数排序', () => {
    const m = eventMatrix([{ user: 'a', type: 'nack' }, { user: 'b', type: 'dtx' }, { user: 'b', type: 'dtx' }, { user: 'b', type: 'mcs' }]);
    expect(m[0]).toEqual({ user: 'b', total: 3, byType: { dtx: 2, mcs: 1 } });
    expect(m[1].user).toBe('a');
  });
});

import { concludeUsers, concludeAb } from '../src/engine/conclude.js';

describe('诊断结论：初判规则', () => {
  const mk = (user, o = {}) => ({ user, tries: 1000, factors: { tries: 500, okRate: 0.98, rb: 60, layers: 1.6, eta: 500, pdcch: 0.99, decode: 0.9, ...o } });
  const base = ['a', 'b', 'c', 'd'].map((u) => mk(u));
  it('数据受限过半 → 首要问题是业务量不足', () => {
    const lim = { users: new Map([['x', { data: 90, fail: 0, rb: 5 }]]) };
    const r = concludeUsers({ rate: { users: [...base, mk('x', { rb: 5 })] }, lim, linkFlagsByUser: new Map(), events: [] });
    expect(r.find((u) => u.user === 'x').causes[0].id).toBe('data');
  });
  it('OLLA 深负标签 → CQI 偏乐观；正常用户无初判', () => {
    const r = concludeUsers({ rate: { users: [...base, mk('y', { eta: 300 })] }, lim: null, linkFlagsByUser: new Map([['y', [['OLLA 深负', '']]]]), events: [] });
    const y = r.find((u) => u.user === 'y');
    expect(y.causes.map((c) => c.id)).toContain('optimistic');
    expect(y.causes.map((c) => c.id)).not.toContain('channel'); // OLLA 已解释，不再重复判“信道差”
    expect(r.find((u) => u.user === 'a').causes).toEqual([]);
    expect(r[0].user).toBe('y'); // 有问题的排前面
  });
  it('连续 DTX 事件 ≥ 3 → PDCCH 漏检', () => {
    const ev = [1, 2, 3].map(() => ({ user: 'z', type: 'dtx' }));
    const r = concludeUsers({ rate: { users: [...base, mk('z')] }, lim: null, linkFlagsByUser: new Map(), events: ev });
    expect(r.find((u) => u.user === 'z').causes.map((c) => c.id)).toContain('pdcch');
  });
  it('A/B：小区一句话给出拖累与抵消', () => {
    const A = { cell: mk('c'), users: [mk('u')] }, B = { cell: mk('c', { okRate: 0.9, rb: 65 }), users: [mk('u', { eta: 400 })] };
    const r = concludeAb({ cell: A.cell.factors && { factors: A.cell.factors }, users: A.users }, { cell: { factors: B.cell.factors }, users: B.users }, null, null);
    expect(r.lines[0]).toMatch(/拖累：调度成功率/);
    expect(r.lines[0]).toMatch(/抵消：RB\/次/);
    expect(r.users[0].main.id).toBe('eta');
  });
});

describe('真实数据回测后的规则（2026-11-11）', () => {
  const mk = (user, o = {}, tries = 4000) => ({ user, tries, factors: { tries: 50, okRate: 1, rb: 245, layers: 1.84, eta: 700, pdcch: 1, decode: 0.95, ...o } });
  const base = ['a', 'b', 'c', 'd', 'e'].map((u) => mk(u));
  it('数据受限用户：不再由小包后果推出 信道差 / 层数低 / RB 少', () => {
    const lim = { users: new Map([['x', { data: 95, fail: 0 }]]) };
    const r = concludeUsers({ rate: { users: [...base, mk('x', { eta: 200, layers: 1, rb: 17 })] }, lim, linkFlagsByUser: new Map(), events: [] });
    expect(r.find((u) => u.user === 'x').causes.map((c) => c.id)).toEqual(['data']);
  });
  it('事件稀疏（每千次初传不到 2 次）不判信道波动', () => {
    const ev = [1, 2, 3, 4, 5].map(() => ({ user: 'y', type: 'nack' })); // 5 次 / 4000 初传 = 1.25‰
    const r = concludeUsers({ rate: { users: [...base, mk('y')] }, lim: null, linkFlagsByUser: new Map(), events: ev });
    expect(r.find((u) => u.user === 'y').causes).toEqual([]);
  });
  it('信道差门限 75%：0.83× 中位不报，0.6× 中位报', () => {
    const r = concludeUsers({ rate: { users: [...base, mk('p', { eta: 582 }), mk('q', { eta: 420 })] }, lim: null, linkFlagsByUser: new Map(), events: [] });
    expect(r.find((u) => u.user === 'p').causes).toEqual([]);
    expect(r.find((u) => u.user === 'q').causes.map((c) => c.id)).toContain('channel');
  });
  it('扣阶集中在降阶一步 → 小包降阶，而不是链路扣阶多', () => {
    const chain = [['estMcs0', 22], ['initAdjMcs0', 22], ['powerBackMcs0', 22], ['rateMtcMcs0', 21.7], ['reduceMcs0', 7.1], ['tb0SchMcs', 7.1]].map(([column, value]) => ({ column, label: column, value }));
    const f = linkFlags({ user: 'z', n: 6000, chain, bler: 4, target: null }, { olla: null, loss: 0 }).map(([t]) => t);
    expect(f).toContain('小包降阶');
    expect(f).not.toContain('链路扣阶多');
  });
});

import { diagExprs } from '../src/engine/diagnose.js';

describe('2026-11-11 真实回测第 6 轮修正', () => {
  const mk = (user, o = {}) => ({ user, tries: 1000, factors: { tries: 500, okRate: 0.98, rb: 60, layers: 1.6, eta: 500, pdcch: 0.99, decode: 0.9, ...o } });
  const base = ['a', 'b', 'c', 'd'].map((u) => mk(u));
  it('小包降阶并进业务量不足，不重复成两条', () => {
    const lim = { users: new Map([['x', { data: 90, fail: 0 }]]) };
    const r = concludeUsers({ rate: { users: [...base, mk('x', { eta: 200 })] }, lim, linkFlagsByUser: new Map([['x', [['小包降阶', '']]]]), events: [] });
    const c = r.find((u) => u.user === 'x').causes;
    expect(c.map((x) => x.id)).toEqual(['data']);
    expect(c[0].evidence).toContain('小包降阶');
  });
  it('有调度类型时，DTX/HARQ 类型行不算初传（真实数据里 DTX 重传次数不一定加 1）', () => {
    const e = diagExprs(['tb0ReTransTimes', 'schType', 'tb0AckState']);
    expect(e.init).toContain('DTX');
    expect(e.dtx1).toContain('DTX');
  });
});

import { ctrlFlags, ctrlRef } from '../src/engine/ctrl.js';

describe('控制信道判读（650/941）', () => {
  const base = (o = {}) => ({ dlN: 5000, dlFail: 0.5, n941: 2000, agg16: 2, ...o });
  it('全小区均匀 2% 的 CCE 失败不标到单个用户（只在小区卡片）', () => {
    const us = ['a', 'b', 'c', 'd'].map(() => base({ dlFail: 2 }));
    expect(ctrlFlags(us[0], ctrlRef(us))).toEqual([]);
  });
  it('某用户 CCE 失败是中位 2 倍以上 → CCE 失败；全小区 > 5% → 每人都标严重', () => {
    const us = [base(), base(), base(), base({ dlFail: 3 })];
    expect(ctrlFlags(us[3], ctrlRef(us)).map((x) => x[0])).toEqual(['CCE 失败']);
    const bad = ['a', 'b', 'c'].map(() => base({ dlFail: 9 }));
    expect(ctrlFlags(bad[0], ctrlRef(bad))[0][0]).toBe('CCE 失败严重');
  });
  it('聚合 16 占比 ≥ 30% 且 ≥ 中位 2 倍 → 聚合级别高；样本不足不判', () => {
    const us = [base(), base(), base(), base({ agg16: 45 })];
    expect(ctrlFlags(us[3], ctrlRef(us)).map((x) => x[0])).toContain('聚合级别高');
    expect(ctrlFlags({ ...us[3], n941: 10 }, ctrlRef(us))).toEqual([]);
  });
  it('控制信道证据并进诊断结论：已有 PDCCH 漏检时追加证据，没有时单独成立', () => {
    const mk = (user, o = {}) => ({ user, tries: 1000, factors: { tries: 500, okRate: 0.98, rb: 60, layers: 1.6, eta: 500, pdcch: 0.99, decode: 0.9, ...o } });
    const users = ['a', 'b', 'c', 'd', 'x'].map((u) => mk(u));
    const r = concludeUsers({ rate: { users }, lim: null, linkFlagsByUser: new Map(), events: [], ctrlFlagsByUser: new Map([['x', [['聚合级别高', 'PDCCH 聚合级别 16 占 45%']]]]) });
    const c = r.find((u) => u.user === 'x').causes;
    expect(c[0].id).toBe('pdcch');
    expect(c[0].evidence).toContain('聚合级别 16');
  });
});

describe('控制信道：小样本不判', () => {
  it('2 次失败 / 83 次申请（2.4%）不标 CCE 失败', () => {
    const us = [{ dlN: 5000, dlFail: 0.2 }, { dlN: 5000, dlFail: 0.3 }, { dlN: 83, dlFail: 2.41 }];
    expect(ctrlFlags(us[2], ctrlRef(us))).toEqual([]);
  });
});
