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
