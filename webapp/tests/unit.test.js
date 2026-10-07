import { describe, it, expect } from 'vitest';
import { parseTraceMeta, parseResultContext, describeFile, buildCatalog, matchSameCellBatches, defaultSelection } from '../src/engine/scan.js';
import { sniffText, splitCsvLine } from '../src/engine/csvsniff.js';
import { filterSql, userScope } from '../src/engine/query.js';
import { compareT396, scopeRate, regressionRadar } from '../src/engine/t396.js';
import { verdict } from '../src/engine/stats.js';

const f = (relPath, extra = {}) => describeFile({ relPath, size: 100, lastModified: 1, rootId: 'r', ref: {}, ...extra });

describe('文件名与目录解析', () => {
  it('识别跟踪号、末尾时间戳与 trace 序号', () => {
    const m = parseTraceMeta('Dest_T537_case_trace_1_20261007093000.csv');
    expect(m.traceId).toBe('537');
    expect(m.traceIndex).toBe(1);
    expect(m.testTimeRaw).toBe('20261007093000');
    expect(m.testTimeShort).toBe('10-07 09:30:00');
  });
  it('ParseResult 上一级是小区、再上一级是 Case', () => {
    const c = parseResultContext(['root', '基线_v3', 'Cell_3', 'ParseResult', 'x.csv']);
    expect(c.cellName).toBe('Cell_3');
    expect(c.caseName).toBe('基线_v3');
  });
  it('不认识的跟踪号被忽略', () => {
    expect(f('root/Dest_T999_x_20261007093000.csv')).toBeNull();
    expect(f('root/readme.csv')).toBeNull();
  });
});

describe('批次分组', () => {
  const files = [
    f('A/case1/Cell_1/ParseResult/Dest_T537_a_trace_1_20261007093000.csv'),
    f('A/case1/Cell_1/ParseResult/Dest_T537_a_trace_0_20261007093000.csv'),
    f('A/case1/Cell_1/ParseResult/Dest_T714_a_trace_0_20261007093000.csv'),
    f('A/case1/Cell_2/ParseResult/Dest_T537_a_trace_0_20261007093000.csv'),
  ];
  const cat = buildCatalog(files);
  it('同一时间戳不同小区分成不同批次', () => expect(cat.batches.length).toBe(2));
  it('多个分片时优先 trace_0', () => {
    const b = cat.batches.find((x) => x.cellName === 'Cell_1');
    expect(b.traces['537'].selected.name).toContain('trace_0');
    expect(b.ignoredFragments).toBe(1);
  });
});

describe('同小区匹配', () => {
  const A = buildCatalog([
    f('A/base/Cell_1/ParseResult/Dest_T396_x_trace_0_20261007093000.csv'),
    f('A/base/Cell_3/ParseResult/Dest_T396_x_trace_0_20261007093100.csv'),
  ]);
  const B = buildCatalog([
    f('B/new/Cell_3/ParseResult/Dest_T396_x_trace_0_20261007103100.csv', { rootId: 'b' }),
    f('B/new/Cell_9/ParseResult/Dest_T396_x_trace_0_20261007103200.csv', { rootId: 'b' }),
  ]);
  it('只配共同小区，不做笛卡尔积', () => {
    const m = matchSameCellBatches(A, B, {});
    expect(m.pairs.map((p) => p.cellName)).toEqual(['Cell_3']);
    expect(m.unmatchedA).toEqual(['Cell_1']);
    expect(m.unmatchedB).toEqual(['Cell_9']);
  });
  it('默认选择落在同小区', () => {
    const s = defaultSelection(A, B);
    expect(s.A.cellName).toBe('Cell_3');
    expect(s.B.cellName).toBe('Cell_3');
  });
  it('A/B 是同一个文件时不配对', () => {
    const same = buildCatalog([f('A/base/Cell_1/ParseResult/Dest_T396_x_trace_0_20261007093000.csv')]);
    expect(matchSameCellBatches(same, same, {}).pairs.length).toBe(0);
  });
});

describe('CSV 预检', () => {
  it('处理 BOM、引号内逗号、数值列识别（ID 类列不算数值）', () => {
    const s = sniffText('\ufefftti,ambr,cw0SuMcs,schType\r\n1,5001,10,"DL,x"\r\n2,5002,nan,SU\r\n3,5003,12,DL\r\n');
    expect(s.columns).toEqual(['tti', 'ambr', 'cw0SuMcs', 'schType']);
    expect(s.numericColumns).toEqual(['cw0SuMcs']);
    expect(splitCsvLine('a,"b,c",d', ',')).toEqual(['a', 'b,c', 'd']);
  });
  it('开头全空的未知列判为待定，已知数值列直接按数值', () => {
    const s = sniffText('tti,foo,compOlla\n1,,\n2,,\n');
    expect(s.undecidedColumns).toEqual(['foo']);
    expect(s.numericColumns).toEqual(['compOlla']);
  });
});

describe('筛选 SQL', () => {
  const cols = ['ambr', 'cw0SuMcs', 'schType'];
  it('转义单引号，忽略未知列', () => {
    const sql = filterSql([{ column: 'schType', op: 'in', value: ["D'L"] }, { column: 'nope', op: 'eq', value: 1 }], cols);
    expect(sql).toContain("'D''L'");
    expect(sql).not.toContain('nope');
  });
  it('数值条件拒绝非数字', () => {
    expect(() => filterSql([{ column: 'cw0SuMcs', op: 'gt', value: '1; DROP TABLE x' }], cols)).toThrow();
  });
  it('NaN 取值筛选对应空值', () => {
    expect(filterSql([{ column: 'ambr', op: 'in', value: ['NaN'] }], cols)).toContain('IS NULL');
  });
  it('用户范围在缺 ambr 的一侧返回空集，而不是被忽略', () => {
    expect(filterSql([userScope(['5001'])], ['cw0SuMcs'])).toBe('FALSE');
  });
  it('用户范围为空列表时也返回空集', () => {
    expect(filterSql([userScope([])], cols)).toBe('FALSE');
  });
  it('介于 / 包含 / 排除', () => {
    expect(filterSql([{ column: 'cw0SuMcs', op: 'between', value: 3, value2: 9 }], cols)).toContain('BETWEEN 3 AND 9');
    expect(filterSql([{ column: 'schType', op: 'contains', value: "D'L" }], cols)).toContain("LIKE '%d''l%'");
    expect(filterSql([{ column: 'schType', op: 'not_in', value: ['DL'] }], cols)).toMatch(/^NOT COALESCE\(/);
  });
  it('列名里的双引号被转义', () => {
    expect(filterSql([{ column: 'a"b', op: 'eq', value: 'x' }], ['a"b'])).toContain('"a""b"');
  });
  it('全局搜索覆盖全部列（不再只搜前 40 列）', () => {
    const many = Array.from({ length: 60 }, (_, i) => `c${i}`);
    expect(filterSql([], many, 'x')).toContain('"c59"');
  });
});

describe('T396 对比口径', () => {
  const A = [{ userId: '1', sumVol: 100, sumTime: 10, rows: 1, rate: 10 }, { userId: '2', sumVol: 300, sumTime: 30, rows: 1, rate: 10 }];
  const B = [{ userId: '1', sumVol: 90, sumTime: 10, rows: 1, rate: 9 }, { userId: '2', sumVol: 330, sumTime: 30, rows: 1, rate: 11 }];
  const c = compareT396(A, B);
  it('小区 Rate = Σvol / Σtime', () => {
    expect(c.cellRateA).toBe(10);
    expect(c.cellRateB).toBeCloseTo(10.5);
  });
  it('TTI 占比与拖累', () => {
    const u1 = c.rows.find((r) => r.userId === '1');
    expect(u1.shareA).toBe(25);
    expect(u1.impact).toBeCloseTo(-10 * 0.25);
  });
  it('所选用户合计 Rate', () => expect(scopeRate(c, ['1']).b).toBe(9));
  it('雷达：回退 10% 以上为严重', () => {
    const r = regressionRadar([{ id: 'x', label: 'x', comparison: { ...c, diffPct: -12 } }]);
    expect(r[0].risk).toBe('critical');
  });
});

describe('结论判定', () => {
  const def = { kind: 'mean', better: 'up', minDelta: 0.3 };
  it('样本不足', () => expect(verdict(def, { value: 1, n: 50, sd: 1 }, { value: 2, n: 50, sd: 1 }).level).toBe('low'));
  it('变化小于实用阈值为持平', () => expect(verdict(def, { value: 10, n: 1e5, sd: 1 }, { value: 10.1, n: 1e5, sd: 1 }).level).toBe('eq'));
  it('显著下降为回退', () => expect(verdict(def, { value: 10, n: 1e5, sd: 1 }, { value: 9, n: 1e5, sd: 1 }).level).toBe('bad'));
});
