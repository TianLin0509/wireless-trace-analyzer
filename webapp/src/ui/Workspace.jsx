import { useState, useEffect } from 'preact/hooks';
import * as S from '../store.js';
import { batchLabel } from '../engine/scan.js';
import { runProgress, startRun, cancelRun } from '../pipeline.js';
import { Logo } from './icons.jsx';
import { UserRail } from './UserRail.jsx';
import { SummaryTab } from './SummaryTab.jsx';
import { DetailTab } from './DetailTab.jsx';
import { ChartsTab } from './ChartsTab.jsx';
import { QualityTab } from './QualityTab.jsx';
import { ViewMenu } from './ViewMenu.jsx';
import { fmtSec, fmtBytes } from './fmt.js';

export function Workspace() {
  const [railOpen, setRailOpen] = useState(true);
  const tab = S.tab.value;
  const ready = S.ready.value;
  return (
    <div class="work">
      <TopBar onToggleRail={() => setRailOpen(!railOpen)} />
      <div class={'body' + (railOpen ? '' : ' rail-closed')}>
        <UserRail />
        <section class="main">
          <div class="tabs">
            {[['sum', '结论'], ['tbl', '明细'], ['cht', '图表'], ['qa', '数据质量']].map(([k, label]) => (
              <button class={tab === k ? 'on' : ''} onClick={() => (S.tab.value = k)}>{label}</button>
            ))}
            <span class="sp" />
            <QualityBadge />
          </div>
          <div class="content" id="content">
            {tab === 'sum' && <SummaryTab />}
            {tab === 'tbl' && (ready ? <DetailTab /> : <Waiting what="明细" />)}
            {tab === 'cht' && (ready ? <ChartsTab /> : <Waiting what="图表" />)}
            {tab === 'qa' && <QualityTab />}
          </div>
        </section>
      </div>
    </div>
  );
}

export function Waiting({ what }) {
  const r = S.run.value;
  if (r?.status === 'running') return <div class="empty">正在读取与合并数据，完成后自动显示{what}。<br /><span class="faint">T396 速率已在左侧先出结果。</span></div>;
  return <div class="empty">没有可用的合并数据。{r?.errors?.length ? '请到“数据质量”查看失败原因。' : ''}</div>;
}

function QualityBadge() {
  const src = Object.values(S.sources.value);
  const rejected = src.reduce((n, s) => n + (s.quality?.rejectedRows || 0), 0);
  if (!rejected || S.qualityAck.value) return null;
  return <button class="btn small" style="color:#7a4a00;border-color:#f1d7a4;background:#fffaf0;margin-right:6px" onClick={() => (S.tab.value = 'qa')}>⚠ 发现 {rejected} 条坏行已跳过 · 查看</button>;
}

function TopBar({ onToggleRail }) {
  const sel = S.selection.value;
  const [showSteps, setShowSteps] = useState(false);
  const r = S.run.value;
  const running = S.running.value;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => tick((x) => x + 1), 400);
    return () => clearInterval(t);
  }, [running]);
  const p = runProgress();
  const sides = S.sides.value;
  const statusText = !r ? '未开始'
    : running ? `读取中 ${(p * 100).toFixed(0)}%`
      : r.status === 'error' ? '失败'
        : r.status === 'cancelled' ? '已停止'
          : `已就绪 · ${[sides.A && `A ${sides.A.anchorRows.toLocaleString()}`, sides.B && `B ${sides.B.anchorRows.toLocaleString()}`].filter(Boolean).join(' / ')} 行`;
  const rerun = async () => {
    try { await startRun(); } catch (err) { S.showError('重新分析失败', err); }
  };
  const swap = () => {
    S.selection.value = { A: sel.B, B: sel.A };
    const d = S.dirs.A.value; S.dirs.A.value = S.dirs.B.value; S.dirs.B.value = d;
    rerun();
  };
  return (
    <div class="top">
      <button class="btn icon" title="显示 / 隐藏用户栏" onClick={onToggleRail}>☰</button>
      <div class="logo"><Logo /></div><span class="brand">Trace A/B</span>
      <div class="srcchip" title={sel.A?.contextLabel || ''}><span class="k a">A</span><span class="tx">{sel.A ? batchLabel(sel.A) : '未选择'}</span></div>
      <button class="btn icon" title="互换 A/B 并重新分析" disabled={running} onClick={swap}>⇄</button>
      <div class="srcchip" title={sel.B?.contextLabel || ''}><span class="k b">B</span><span class="tx">{sel.B ? batchLabel(sel.B) : '未选择'}</span></div>
      <button class="btn" onClick={() => { cancelRun(); S.page.value = 'start'; }}>更换数据</button>
      <span class="sp" />
      <div style="position:relative">
        <span class={'prog ' + (running ? 'running' : r?.status === 'error' ? 'error' : '')} onClick={() => setShowSteps(!showSteps)}>
          <i />{statusText}<span class="bar"><s style={{ width: `${(running ? p : 1) * 100}%` }} /></span>
        </span>
        {showSteps && r && (
          <>
            <div class="backdrop" onClick={() => setShowSteps(false)} />
            <div class="pop steps" style="right:0;top:36px">
              <div class="row" style="margin-bottom:6px"><b>读取进度</b><span class="sp" />{r.seconds && <span class="muted">共 {fmtSec(r.seconds)}{r.memory ? ` · 引擎内存 ${fmtBytes(r.memory)}` : ''}</span>}</div>
              {r.steps.map((s) => (
                <div class={'step ' + s.state}>
                  <span class="st" />
                  <div>
                    <div>{s.label}{s.file?.name && <span class="faint" style="font-size:11px"> · {s.file.name}</span>}</div>
                    {s.state === 'run' && <div class="minibar"><s style={{ width: `${(s.pct || 0) * 100}%` }} /></div>}
                    {s.error && <div class="dn" style="font-size:12px">{s.error}</div>}
                  </div>
                  <span class="faint" style="font-size:11px">{s.state === 'skip' ? '无文件' : s.elapsed ? fmtSec(s.elapsed) : s.state === 'wait' ? '等待' : ''}</span>
                </div>
              ))}
              <p class="faint" style="font-size:11px;margin:8px 0 0">读取进度按文件大小估算；计算全部在本机浏览器内完成。</p>
              {running && <button class="btn small" onClick={cancelRun}>停止</button>}
              {!running && r.status !== 'done' && <button class="btn small" onClick={rerun}>重新分析</button>}
            </div>
          </>
        )}
      </div>
      <ViewMenu />
    </div>
  );
}
