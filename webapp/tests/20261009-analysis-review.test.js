import { describe, it, expect } from 'vitest';
import { compareT396 } from '../src/engine/t396.js';
import { buildCatalog, describeFile, selectTraceFile, restoreTraceChoices } from '../src/engine/scan.js';
import { groupFindings, findingFilters } from '../src/engine/single.js';
import { rateScopeLabel, missingFilterColumns } from '../src/engine/analysis-scope.js';
import { movingAverage, smoothingWindow } from '../src/engine/metrics.js';
import { buildReportHtml } from '../src/engine/report.js';

const agg = (userId, rate, time) => ({ userId, rate, sumTime: time, sumVol: rate * time });
const sum = (rows, key) => rows.reduce((n, r) => n + (r[key] || 0), 0);

describe('贡献加总与速率/占比拆分', () => {
  it('用户速率不变但占比改变，小区也会变化', () => {
    const c = compareT396([agg('1', 100, 90), agg('2', 10, 10)], [agg('1', 100, 10), agg('2', 10, 90)]);
    expect(c.cellRateA).toBe(91); expect(c.cellRateB).toBe(19);
    expect(sum(c.rows, 'rateContributionPt')).toBeCloseTo(0, 12);
    expect(sum(c.rows, 'shareContributionPt')).toBeCloseTo(c.diffPct, 12);
    expect(sum(c.rows, 'contributionPt')).toBeCloseTo(c.diffPct, 12);
  });
  it('占比相同但用户基准速率不同，不能用用户相对变化直接充当小区贡献', () => {
    const c = compareT396([agg('1', 100, 50), agg('2', 10, 50)], [agg('1', 90, 50), agg('2', 10, 50)]);
    expect(c.rows[0].impact).toBe(-5); // 保留旧排序分数，避免旧接口倒退
    expect(c.rows[0].contributionPt).toBeCloseTo(-1000 / 110);
    expect(sum(c.rows, 'shareContributionPt')).toBeCloseTo(0);
  });
  it('新增与消失用户也参与加总，归入占比变化', () => {
    const c = compareT396([agg('old', 80, 20), agg('common', 30, 10)], [agg('new', 50, 40), agg('common', 20, 5)]);
    expect(sum(c.rows, 'contributionPt')).toBeCloseTo(c.diffPct, 12);
    for (const id of ['old', 'new']) expect(c.rows.find((r) => r.userId === id).rateContributionPt).toBe(0);
  });
  it('两种贡献逐用户可核对，小区加总在多种权重下成立', () => {
    for (let k = 1; k <= 25; k++) {
      const c = compareT396([agg('1', 17 + k, k), agg('2', 91 - k, 30)], [agg('1', 52 - k, 50), agg('2', 23 + k, k * 2)]);
      for (const r of c.rows) expect(r.rateContributionPt + r.shareContributionPt).toBeCloseTo(r.contributionPt, 12);
      expect(sum(c.rows, 'contributionPt')).toBeCloseTo(c.diffPct, 12);
    }
  });
  it('单侧或 A 速率为零时不伪造可比较贡献', () => {
    expect(compareT396([agg('1', 10, 5)]).rows[0].contributionPt).toBeNull();
    expect(compareT396([agg('1', 0, 5)], [agg('1', 20, 5)]).rows[0].contributionPt).toBeNull();
  });
});

describe('范围、分片与异常定位', () => {
  it('列条件与搜索明确不作用于全批次速率', () => {
    expect(rateScopeLabel(['1'], { filters: [{ column: 'tti' }] })).toContain('未应用当前列筛选或搜索');
    expect(rateScopeLabel([], { search: 'x' })).toContain('T396 全批次');
    expect(missingFilterColumns([{ column: 'tti' }], { A: { columns: [] }, B: { columns: ['tti'] } })).toEqual(['A 缺少 tti']);
  });
  it('分片可更换并恢复，源目录的默认选择保持不变', () => {
    const file = (i, size) => describeFile({ relPath: `root/case/cell/ParseResult/Dest_T537_x_trace_${i}_20261007093000.csv`, size, lastModified: 1, ref: {} });
    const batch = buildCatalog([file(0, 100), file(1, 200)]).batches[0];
    const changed = selectTraceFile(batch, '537', file(1, 200).relPath);
    expect(changed.totalBytes).toBe(200); expect(changed.batchId).toBe(batch.batchId);
    expect(batch.traces['537'].selected.traceIndex).toBe(0);
    expect(restoreTraceChoices(batch, { '537': file(1, 200).relPath }).traces['537'].selected.traceIndex).toBe(1);
    expect(() => restoreTraceChoices(batch, { '537': 'missing.csv' })).toThrow('已不在');
  });
  it('合并同一用户的线索，保留规则；NACK 与 DTX 定位不同', () => {
    const groups = groupFindings([{ id: 'bler', users: ['1'], level: 'warn' }, { id: 'mcs', users: ['1', '2'], level: 'info' }], [{ user: '1', valid: 400, share: 10 }, { user: '2', valid: 250, share: 20 }]);
    expect(groups[0].user).toBe('1'); expect(groups[0].items).toHaveLength(2); expect(groups[0].metrics.valid).toBe(400);
    expect(findingFilters('bler', {})).toEqual([{ column: '714_ack0', op: 'eq_num', value: 0 }]);
    expect(findingFilters('dtx', {}).some((f) => f.op === 'not_null')).toBe(true);
    expect(findingFilters('lowrate', {})).toEqual([]);
  });
});

describe('本地报告与平滑', () => {
  const model = { mode: 'ab', version: '1.5.0', at: '2026-10-09', status: 'partial', rate: { a: 10, b: 8, diff: -20 }, rateScope: '全批次', comparison: null,
    sources: [{ side: 'A', trace: '537', path: '<img src=x onerror=alert(1)>', rows: 5 }], batches: [], users: ['<script>alert(1)</script>'], filters: [], search: '', cards: [], findings: [], userMetrics: [], charts: [], chartNotes: [], errors: ['<b>失败</b>'] };
  it('报告转义文件名、用户与错误，不加载外部资源', () => {
    const html = buildReportHtml(model);
    expect(html).toContain('&lt;script&gt;'); expect(html).toContain('&lt;img'); expect(html).toContain('未完整完成');
    expect(html).not.toContain('<script>'); expect(html).not.toMatch(/(?:src|href)=["']https?:/);
    expect(html).toContain("default-src 'none'");
  });
  it('图表只接受内嵌 PNG，拒绝外链图片', () => {
    const html = buildReportHtml({ ...model, charts: [{ title: '外链', image: 'https://x/a.png' }, { title: '内嵌', image: 'data:image/png;base64,YWJj' }] });
    expect(html).not.toContain('https://x'); expect(html).toContain('data:image/png;base64,YWJj');
  });
  it('窗口 1 保留采样值，实际窗口受采样点数限制', () => {
    expect(movingAverage([1, 9, 3], 1)).toEqual([1, 9, 3]);
    expect(movingAverage([1, 9, 3], 2)).toEqual([1, 5, 6]);
    expect(smoothingWindow(3, '20')).toBe(3); expect(smoothingWindow(120, 'auto')).toBe(2);
  });
});
