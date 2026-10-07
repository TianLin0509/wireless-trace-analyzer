import { useState, useMemo } from 'preact/hooks';
import * as S from '../store.js';
import { matchSameCellBatches, batchLabel } from '../engine/scan.js';
import { ingestT396 } from '../engine/ingest.js';
import { unregisterFile } from '../engine/db.js';
import { compareT396, regressionRadar, RISK_TEXT } from '../engine/t396.js';
import { getFile } from '../engine/fs.js';
import { startRun } from '../pipeline.js';
import { Logo } from './icons.jsx';
import { fmt, fmtPct } from './fmt.js';

const riskClass = { critical: 'bad', warning: 'bad', watch: 'warn', insufficient: '', flat: '', improved: 'good' };

/** 批量 KPI：两侧同名小区自动配对，只读 T396，按回归严重程度排序；点任一组进入单小区深挖。 */
export function KpiPage() {
  const a = S.dirs.A.value?.catalog, b = S.dirs.B.value?.catalog;
  const [caseA, setCaseA] = useState('');
  const [caseB, setCaseB] = useState('');
  const plan = useMemo(() => (a && b ? matchSameCellBatches(a, b, { caseA, caseB, requiredTrace: '396', maxPairs: 30 }) : null), [a, b, caseA, caseB]);
  const st = S.kpiState.value;
  const [progress, setProgress] = useState(null);

  const run = async () => {
    const cache = new Map();
    const groups = [];
    let i = 0;
    for (const p of plan.pairs) {
      i++;
      setProgress({ i, n: plan.pairs.length, label: p.cellName });
      const agg = {};
      for (const [side, batch] of [['A', p.a], ['B', p.b]]) {
        const f = batch.traces['396'].selected;
        if (!cache.has(f.physicalKey)) {
          const key = `K${cache.size}`;
          try {
            const file = await getFile(f);
            cache.set(f.physicalKey, (await ingestT396(key, file)).aggregate);
          } catch {
            cache.set(f.physicalKey, null);
          } finally {
            await unregisterFile(key); // T396 已聚合成小表，原文件不必再挂在引擎里
          }
        }
        agg[side] = cache.get(f.physicalKey);
      }
      groups.push({ id: p.cellKey, label: p.label, cellName: p.cellName, a: p.a, b: p.b, comparison: agg.A && agg.B ? compareT396(agg.A, agg.B) : null });
    }
    setProgress(null);
    S.kpiState.value = { ranked: regressionRadar(groups) };
  };

  const dive = async (g) => {
    S.selection.value = { A: g.a, B: g.b };
    S.users.value = g.topUsers.slice(0, 3).map((u) => u.userId);
    try { await startRun({ keepUsers: true }); } catch (err) { S.showError('进入详细分析失败', err); }
  };

  const ranked = st?.ranked || [];
  return (
    <div class="start">
      <div class="top">
        <div class="logo"><Logo /></div><span class="brand">批量 KPI · 多小区 T396 对比</span>
        <span class="sp" />
        <button class="btn" onClick={() => (S.page.value = 'start')}>返回</button>
      </div>
      <div class="inner" style="width:min(1180px,96vw)">
        <div class="startcard">
          <div class="row" style="flex-wrap:wrap">
            <span class="k a">A</span>
            <select class="input" value={caseA} onChange={(e) => setCaseA(e.target.value)}><option value="">全部 Case</option>{a?.caseGroups.filter((c) => c.caseKey).map((c) => <option value={c.caseKey}>{c.caseName}</option>)}</select>
            <span class="k b">B</span>
            <select class="input" value={caseB} onChange={(e) => setCaseB(e.target.value)}><option value="">全部 Case</option>{b?.caseGroups.filter((c) => c.caseKey).map((c) => <option value={c.caseKey}>{c.caseName}</option>)}</select>
            <span class="muted">按同名小区自动配对：{plan?.pairs.length || 0} 组{plan?.truncated ? '（最多 30 组）' : ''}{plan?.unmatchedA.length ? ` · A 独有 ${plan.unmatchedA.length} 个小区` : ''}{plan?.unmatchedB.length ? ` · B 独有 ${plan.unmatchedB.length}` : ''}</span>
            <span class="sp" />
            <button class="btn primary" disabled={!plan?.pairs.length || !!progress} onClick={run}>{progress ? `读取中 ${progress.i}/${progress.n} · ${progress.label}` : '开始 KPI 对比'}</button>
          </div>
          {!ranked.length && plan?.pairs.length > 0 && (
            <table class="t" style="margin-top:12px">
              <thead><tr><th class="left">小区</th><th class="left">方案 A 批次</th><th class="left">方案 B 批次</th></tr></thead>
              <tbody>{plan.pairs.map((p) => <tr><td class="left">{p.cellName}</td><td class="left">{batchLabel(p.a)}</td><td class="left">{batchLabel(p.b)}</td></tr>)}</tbody>
            </table>
          )}
          {!plan?.pairs.length && <div class="empty">两侧没有找到同名小区（小区名取自 ParseResult 的上一级目录）。</div>}
          {ranked.length > 0 && (
            <>
              <p class="faint" style="font-size:12px">排序：先按风险等级，再按优先级分（小区 Rate 回退 70% + 主影响用户 20% + 证据完整度 10%）。证据等级只反映 A/B 时长平衡与用户重合度，不代表统计显著性。</p>
              <div style="overflow:auto">
                <table class="t">
                  <thead><tr><th class="left">小区</th><th>风险</th><th>Rate A → B</th><th>变化</th><th>优先级</th><th>证据</th><th class="left">主要回退用户（变化 · TTI 占比）</th><th /></tr></thead>
                  <tbody>
                    {ranked.map((g) => (
                      <tr>
                        <td class="left"><b>{g.cellName}</b><div class="faint" style="font-size:11px">{g.label}</div></td>
                        <td><span class={'tag ' + riskClass[g.risk]}>{RISK_TEXT[g.risk]}</span></td>
                        <td class="num"><span class="A">{fmt(g.comparison?.cellRateA, 2)}</span> → <span class="B">{fmt(g.comparison?.cellRateB, 2)}</span></td>
                        <td class={'num ' + (g.diffPct < 0 ? 'dn' : 'up')}>{fmtPct(g.diffPct)}</td>
                        <td class="num">{g.score.toFixed(0)}</td>
                        <td>{g.evidence}</td>
                        <td class="left">{g.topUsers.slice(0, 3).map((u) => `${u.userId}（${fmtPct(u.diffPct)} · ${fmt(u.share, 0)}%）`).join('，') || '—'}</td>
                        <td><button class="btn small primary" onClick={() => dive(g)}>深挖</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
