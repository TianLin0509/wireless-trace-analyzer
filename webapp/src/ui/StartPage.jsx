import { useEffect, useState } from 'preact/hooks';
import * as S from '../store.js';
import { pickDirectory, scanDirectoryHandle, scanFileList, supportsDirectoryHandle, ensurePermission } from '../engine/fs.js';
import { buildCatalog, defaultSelection, matchSameCellBatches, batchLabel } from '../engine/scan.js';
import { startRun } from '../pipeline.js';
import { listAll, remove } from '../persist.js';
import { fmtBytes } from './fmt.js';
import { Logo } from './icons.jsx';

async function loadSide(side, picked) {
  S.dirs[side].value = { ...(S.dirs[side].value || {}), scanning: true };
  try {
    const res = picked.handle ? await scanDirectoryHandle(picked.handle) : scanFileList(picked.fileList);
    const catalog = buildCatalog(res.files);
    S.dirs[side].value = { rootName: res.rootName, handle: picked.handle || null, files: res.files, catalog, truncated: res.truncated };
    return catalog;
  } catch (err) {
    S.dirs[side].value = null;
    throw err;
  }
}

function applyDefault() {
  const a = S.dirs.A.value?.catalog, b = S.dirs.B.value?.catalog;
  S.selection.value = defaultSelection(a, b);
}

export function StartPage() {
  const [filters, setFilters] = useState({ A: { caseKey: '', cellKey: '' }, B: { caseKey: '', cellKey: '' } });
  const [recents, setRecents] = useState([]);
  const [busy, setBusy] = useState(false);
  const refreshRecents = () => listAll('recents').then((r) => setRecents(r.sort((x, y) => y.at - x.at))).catch(() => {});
  useEffect(refreshRecents, []);

  const pick = async (side) => {
    try {
      const picked = await pickDirectory();
      await loadSide(side, picked);
      applyDefault();
    } catch (err) {
      if (err?.name !== 'AbortError') S.showError('读取文件夹失败', err);
    }
  };

  const sel = S.selection.value;
  const canStart = !!(sel.A || sel.B) && !busy;

  const start = async () => {
    setBusy(true);
    try { await startRun(); } catch (err) { S.showError('分析未能开始', err); }
    setBusy(false);
  };

  const match = () => {
    const a = S.dirs.A.value?.catalog, b = S.dirs.B.value?.catalog;
    if (!a || !b) return S.showToast('请先选择方案 A、B 两个文件夹。');
    const cell = filters.A.cellKey || filters.B.cellKey;
    const m = matchSameCellBatches(a, b, { caseA: filters.A.caseKey, caseB: filters.B.caseKey, cellKey: cell, maxPairs: 1 });
    if (!m.pairs.length) return S.showToast(cell ? '这个小区在另一侧没有可配对的批次。' : '两侧没有找到同名小区；请手动选择批次。');
    S.selection.value = { A: m.pairs[0].a, B: m.pairs[0].b };
    S.showToast(`已匹配：${m.pairs[0].label}`);
  };

  const swap = () => {
    const a = S.dirs.A.value, b = S.dirs.B.value;
    S.dirs.A.value = b; S.dirs.B.value = a;
    S.selection.value = { A: sel.B, B: sel.A };
    setFilters({ A: filters.B, B: filters.A });
  };

  const openRecent = async (r) => {
    setBusy(true);
    try {
      for (const side of ['A', 'B']) {
        const h = r.handles?.[side];
        if (!h) continue;
        if (!(await ensurePermission(h))) throw new Error(`没有获得方案 ${side} 文件夹（${h.name}）的读取授权。`);
        await loadSide(side, { handle: h });
      }
      const find = (side) => S.dirs[side].value?.catalog.batches.find((b) => b.batchId === r.batchIds?.[side]) || null;
      const next = { A: find('A'), B: find('B') };
      if (!next.A && !next.B) throw new Error('原来的批次已不在文件夹中（文件可能被移动或删除）。');
      S.selection.value = next;
      if (r.viewId) {
        const v = (await listAll('views')).find((x) => x.id === r.viewId);
        if (v) S.view.value = { ...S.defaultView(), ...v };
      }
      await startRun();
    } catch (err) {
      S.showError('恢复最近分析失败', err, ['可以重新选择文件夹后手动开始。']);
    }
    setBusy(false);
  };

  return (
    <div class="start">
      <div class="top">
        <div class="logo"><Logo /></div><span class="brand">Trace A/B 分析台</span><span class="ver">v{__APP_VERSION__}</span>
        <span class="sp" />
        <a class="muted" style="font-size:12px;margin-right:12px" href="/probe.html">环境检查</a>
        <span class="muted" style="font-size:12px">数据只在本机浏览器内处理，不上传</span>
      </div>
      <div class="inner">
        <div class="startcard">
          <div class="row" style="align-items:baseline"><b style="font-size:17px">新建 A/B 分析</b><span class="muted">选择两个方案的数据文件夹（可以是网络盘）；同一跟踪有多个分片时自动用 trace_0。</span></div>
          <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:12px;margin-top:14px;align-items:stretch">
            <SideCard side="A" filters={filters.A} setFilters={(f) => setFilters({ ...filters, A: f })} onPick={() => pick('A')} />
            <button class="btn" style="align-self:center" title="互换 A/B" onClick={swap}>⇄</button>
            <SideCard side="B" filters={filters.B} setFilters={(f) => setFilters({ ...filters, B: f })} onPick={() => pick('B')} />
          </div>
          <div class="row" style="margin-top:16px">
            <button class="btn" onClick={match} disabled={!S.dirs.A.value || !S.dirs.B.value}>同小区一键匹配</button>
            <span class="sp" />
            <button class="btn" disabled={!S.dirs.A.value || !S.dirs.B.value} onClick={() => (S.page.value = 'kpi')}>批量 KPI（多小区）</button>
            <button class="btn primary" disabled={!canStart} onClick={start}>{busy ? '正在准备…' : '开始分析'}</button>
          </div>
          {recents.length > 0 && (
            <div class="recent" style="margin-top:18px">
              <b>最近分析</b>
              {recents.map((r) => (
                <div class="rr">
                  <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{r.label}{r.viewName && r.viewName !== '默认视图' ? ` · 视图「${r.viewName}」` : ''}</span>
                  <span class="row" style="flex:none">
                    <span class="faint">{new Date(r.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                    {r.handles?.A || r.handles?.B ? <button class="btn small" disabled={busy} onClick={() => openRecent(r)}>一键恢复</button> : <span class="faint">需重新选文件夹</span>}
                    <button class="btn text danger" title="删除记录" onClick={() => remove('recents', r.id).then(refreshRecents)}>×</button>
                  </span>
                </div>
              ))}
            </div>
          )}
          <div class="envnote">
            {supportsDirectoryHandle()
              ? '浏览器会请求读取所选文件夹的权限（只读）。计算全部在本机完成：可以在页面加载后断开网络验证。'
              : '当前浏览器不支持记住文件夹授权，将用选择框方式读取，每次需重新选择文件夹。建议使用新版 Chrome 或 Edge。'}
          </div>
        </div>
      </div>
    </div>
  );
}

function SideCard({ side, filters, setFilters, onPick }) {
  const d = S.dirs[side].value;
  const sel = S.selection.value[side];
  const cat = d?.catalog;
  const cases = cat?.caseGroups || [];
  const caseObj = cases.find((c) => c.caseKey === filters.caseKey);
  const cells = filters.caseKey ? caseObj?.cells || [] : [...new Map(cases.flatMap((c) => c.cells).map((c) => [c.cellKey, c])).values()];
  const batches = (cat?.batches || []).filter((b) => (!filters.caseKey || b.caseKey === filters.caseKey) && (!filters.cellKey || b.cellKey === filters.cellKey));
  const k = side === 'A' ? 'a' : 'b';
  const setBatch = (id) => (S.selection.value = { ...S.selection.value, [side]: cat.batches.find((b) => b.batchId === id) || null });
  return (
    <div class={'pick' + (d?.catalog ? ' has' : '')}>
      <span class={'k ' + k}>{side}</span>
      <div class="body2">
        {!d?.catalog ? (
          <>
            <b>{d?.scanning ? '正在扫描…' : `选择方案 ${side} 文件夹`}</b>
            <span class="muted" style="font-size:12px">{side === 'A' ? '基准方案' : '对比方案，可留空只看单方案'}</span>
            <div><button class="btn" onClick={onPick} disabled={d?.scanning}>选择文件夹…</button></div>
          </>
        ) : (
          <>
            <div class="row"><b style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={d.rootName}>📁 {d.rootName}</b><span class="sp" /><button class="btn small" onClick={onPick}>更换</button></div>
            <span class="muted" style="font-size:12px">{cat.fileCount} 个跟踪文件 · {cat.batches.length} 个批次{cases.some((c) => c.caseKey) ? ` · ${cases.filter((c) => c.caseKey).length} 个 Case` : ''}{d.truncated ? ' · 文件过多已截断' : ''}</span>
            {cases.some((c) => c.caseKey) && (
              <div class="row">
                <select class="input" style="flex:1" value={filters.caseKey} onChange={(e) => setFilters({ caseKey: e.target.value, cellKey: '' })}>
                  <option value="">全部 Case</option>
                  {cases.map((c) => <option value={c.caseKey}>{c.caseName}（{c.batchCount}）</option>)}
                </select>
                <select class="input" style="flex:1" value={filters.cellKey} onChange={(e) => setFilters({ ...filters, cellKey: e.target.value })}>
                  <option value="">全部小区</option>
                  {cells.map((c) => <option value={c.cellKey}>{c.cellName}</option>)}
                </select>
              </div>
            )}
            <select class="input" value={sel?.batchId || ''} onChange={(e) => setBatch(e.target.value)}>
              <option value="">{side === 'B' ? '（不选 B，只看单方案）' : '选择批次'}</option>
              {batches.map((b) => (
                <option value={b.batchId}>{batchLabel(b)} · {b.availableTraces.map((t) => 'T' + t).join('/')} · {fmtBytes(b.totalBytes)}</option>
              ))}
            </select>
            {sel && <span class="faint" style="font-size:11px" title={sel.directory}>{sel.contextLabel || sel.directory}{sel.ignoredFragments ? ` · 忽略 ${sel.ignoredFragments} 个后续分片` : ''}</span>}
          </>
        )}
      </div>
    </div>
  );
}
