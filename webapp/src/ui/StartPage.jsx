import { useEffect, useState } from 'preact/hooks';
import * as S from '../store.js';
import { pickDirectory, scanDirectoryHandle, scanFileList, supportsDirectoryHandle, ensurePermission, normalizePastedPath, lastSegment, directoryFromDrop } from '../engine/fs.js';
import { buildCatalog, defaultSelection, matchSameCellBatches, batchLabel } from '../engine/scan.js';
import { loadRoots, listRoots, findRoot, suggestRoot, saveRoot, forgetRoot, ensureRead, descend, ancestors } from '../engine/roots.js';
import { startRun } from '../pipeline.js';
import { pingHelper, scanPath, HELPER_DOWNLOAD } from '../engine/helper.js';
import { listAll, remove } from '../persist.js';
import { fmtBytes } from './fmt.js';
import { Logo } from './icons.jsx';

const PATH_KEY = (side) => `trace-path-${side}`;
export const savedPath = (side) => { try { return localStorage.getItem(PATH_KEY(side)) || ''; } catch { return ''; } };
const savePath = (side, p) => { try { localStorage.setItem(PATH_KEY(side), p); } catch { /* 无痕模式等 */ } };

// 本机助手是可选的高级方式：只有用户用 ?helper=1 打开过才启用，默认不去连本机（避免浏览器弹“访问本设备”的询问）
const HELPER_KEY = 'trace-helper';
function helperEnabled() {
  try {
    const q = new URLSearchParams(location.search).get('helper');
    if (q === '1') localStorage.setItem(HELPER_KEY, '1');
    if (q === '0') localStorage.removeItem(HELPER_KEY);
    return localStorage.getItem(HELPER_KEY) === '1';
  } catch { return false; }
}

/** picked：{ path }（本机助手按路径读取）、{ handle }（目录句柄）或 { fileList }（选择框）。fullPath：这个文件夹的完整路径（用于显示）。 */
async function loadSide(side, picked, fullPath = '') {
  S.dirs[side].value = { ...(S.dirs[side].value || {}), scanning: true };
  try {
    if (picked.path) {
      const res = await scanPath(picked.path);
      const catalog = buildCatalog(res.files);
      S.dirs[side].value = { rootName: res.rootName, handle: null, files: res.files, catalog, truncated: res.truncated, fullPath: res.fullPath, via: 'helper' };
      if (!res.files.length) S.showToast(`「${res.fullPath}」里没有找到 Dest_T396/T537/T714 的 CSV 文件，请检查路径。`, 6000);
      return catalog;
    }
    const res = picked.handle ? await scanDirectoryHandle(picked.handle) : scanFileList(picked.fileList);
    const catalog = buildCatalog(res.files);
    // 只有当路径的最后一级与实际读取的文件夹同名时，才把它当作这个文件夹的完整路径
    const matched = fullPath && lastSegment(fullPath).toLowerCase() === res.rootName.toLowerCase();
    S.dirs[side].value = { rootName: res.rootName, handle: picked.handle || null, files: res.files, catalog, truncated: res.truncated, fullPath: matched ? normalizePastedPath(fullPath) : '', via: 'picker' };
    if (!res.files.length) S.showToast(`「${res.rootName}」里没有找到 Dest_T396/T537/T714 的 CSV 文件，请检查路径。`, 6000);
    return catalog;
  } catch (err) {
    S.dirs[side].value = null;
    throw err;
  }
}

function applyDefault() {
  const a = S.dirs.A.value?.catalog, b = S.dirs.B.value?.catalog;
  const sel = defaultSelection(a, S.mode.value === 'single' ? null : b);
  S.selection.value = S.mode.value === 'single' ? { A: sel.A, B: S.selection.value.B } : sel;
}

export function StartPage() {
  const mode = S.mode.value;
  const single = mode === 'single';
  const [filters, setFilters] = useState({ A: { caseKey: '', cellKey: '' }, B: { caseKey: '', cellKey: '' } });
  const [paths, setPaths] = useState({ A: savedPath('A'), B: savedPath('B') });
  const [recents, setRecents] = useState([]);
  const [roots, setRoots] = useState([]);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState(null); // 弹出选择窗口期间的操作提示
  const useHelper = helperEnabled();
  const [helper, setHelper] = useState(undefined); // 本机助手：undefined 未检测 / null 未运行 / { version }
  const [setup, setSetup] = useState(null);
  const refreshRecents = () => listAll('recents').then((r) => setRecents(r.sort((x, y) => y.at - x.at))).catch(() => {});
  const refreshRoots = () => listRoots().then(setRoots).catch(() => {});
  useEffect(() => {
    refreshRecents();
    loadRoots().then(refreshRoots);
    if (useHelper) pingHelper().then(setHelper);
  }, []);
  const setPath = (side, p) => setPaths((x) => ({ ...x, [side]: p }));

  /** 弹出选择窗口；pastedPath 有值时先把要选的路径放进剪贴板，用户在窗口里 Ctrl+V 即可定位。 */
  const pick = async (side, pastedPath = '') => {
    const path = normalizePastedPath(pastedPath);
    try {
      if (path) {
        await navigator.clipboard?.writeText(path).catch(() => {});
        setHint({ side, path, copied: path });
      }
      const picked = await pickDirectory();
      setHint(null);
      const name = picked.handle?.name || (picked.fileList?.[0]?.webkitRelativePath || '').split('/')[0];
      await loadSide(side, picked, path);
      if (path && name && lastSegment(path).toLowerCase() !== name.toLowerCase()) {
        S.showToast(`注意：粘贴的是「${lastSegment(path)}」，实际选中的是「${name}」。如果选错了，点“更换”重选。`, 6000);
      }
      applyDefault();
    } catch (err) {
      setHint(null);
      if (err?.name !== 'AbortError') S.showError('读取文件夹失败', err);
    }
  };

  /**
   * 粘贴路径 → 解析。浏览器不能按路径读盘，做法是：这个路径所在的总目录（如 \\服务器\cellDT）只需在选择窗口里授权一次，
   * 之后该目录下的任何路径都沿已授权的目录句柄直接找到，不再弹窗。
   */
  const resolvePath = async (side, raw) => {
    const path = normalizePastedPath(raw);
    if (!path) return false;
    savePath(side, path);
    setPath(side, path);
    try {
      if (useHelper) {
        const h = await pingHelper();
        setHelper(h);
        if (!h) { setSetup({ side, path }); return false; }
        setSetup(null);
        await loadSide(side, { path });
        applyDefault();
        return true;
      }
      if (!supportsDirectoryHandle()) { await pick(side, path); return !!S.dirs[side].value?.catalog; }
      await loadRoots();
      const hit = findRoot(path);
      if (hit) {
        if (!(await ensureRead(hit.root.handle))) throw new Error(`浏览器没有给「${hit.root.path}」读取授权。点“解析”时浏览器询问是否允许，请选“允许”。`);
        const dir = await descend(hit.root.handle, hit.rest);
        await loadSide(side, { handle: dir }, path);
        applyDefault();
        return true;
      }
      // 首次：授权这个路径所在的总目录（只需一次）
      const root = suggestRoot(path);
      await navigator.clipboard?.writeText(root).catch(() => {});
      setHint({ side, path, copied: root, first: true });
      let handle;
      try {
        handle = await window.showDirectoryPicker({ id: 'trace-root', mode: 'read' });
      } finally {
        setHint(null);
      }
      // 选中的文件夹是路径里的哪一级：优先认总目录，其次按名称在路径各级里找
      const name = handle.name.toLowerCase();
      const levels = ancestors(path);
      const base = lastSegment(root).toLowerCase() === name ? root : [...levels].reverse().find((a) => lastSegment(a).toLowerCase() === name);
      if (!base) {
        S.showToast(`注意：路径里没有「${handle.name}」这一级，已直接读取所选文件夹，但不会记住授权。`, 6000);
        await loadSide(side, { handle });
        applyDefault();
        return true;
      }
      await saveRoot(base, handle);
      refreshRoots();
      const again = findRoot(path);
      const dir = await descend(handle, again.rest);
      await loadSide(side, { handle: dir }, path);
      applyDefault();
      S.showToast(`已授权「${base}」：以后这个目录下的路径粘贴后直接解析。`, 5000);
      return true;
    } catch (err) {
      setHint(null);
      if (err?.name === 'AbortError') return false;
      if (err?.name === 'SecurityError') { S.showToast(`方案 ${side} 需要先点一下它的“解析”按钮完成授权。`, 5000); return false; }
      S.showError(`解析路径失败：${path}`, err, ['确认路径能在资源管理器里打开（网络盘需要先登录过）。']);
      return false;
    }
  };

  /** 从资源管理器把文件夹直接拖进来。 */
  const drop = async (side, e) => {
    e.preventDefault();
    try {
      const handle = await directoryFromDrop(e.dataTransfer);
      if (!handle) return S.showToast('请拖入一个文件夹（不是单个文件）。');
      await loadSide(side, { handle });
      applyDefault();
    } catch (err) {
      S.showError('读取拖入的文件夹失败', err);
    }
  };

  /** A/B 两个方案在同一个大目录下时，B 直接沿用 A 的文件夹，自动配同小区的另一个批次。 */
  const sameAsA = () => {
    const a = S.dirs.A.value;
    if (!a?.catalog) return;
    S.dirs.B.value = { ...a };
    if (a.fullPath) { savePath('B', a.fullPath); setPath('B', a.fullPath); }
    applyDefault();
    if (!S.selection.value.B) S.showToast('这个文件夹里只找到一个批次，B 侧请另选文件夹。', 5000);
  };

  const sel = S.selection.value;
  const sidesUsed = single ? ['A'] : ['A', 'B'];
  // 框里有路径但还没解析（或换了路径）的一侧，点“开始分析”时先自动解析
  const pending = (side) => {
    const p = normalizePastedPath(paths[side]);
    const d = S.dirs[side].value;
    return p && (!d?.catalog || (d.fullPath && d.fullPath.toLowerCase() !== p.toLowerCase()));
  };
  const canStart = !busy && (single ? !!sel.A || pending('A') : !!(sel.A || sel.B) || sidesUsed.some(pending));

  const start = async () => {
    setBusy(true);
    try {
      for (const side of sidesUsed) {
        if (pending(side) && !(await resolvePath(side, paths[side]))) { setBusy(false); return; }
      }
      const s = S.selection.value;
      if (single ? !s.A : !(s.A || s.B)) { setBusy(false); return S.showToast('没有可分析的批次：请检查路径下是否有 Dest_T537 / T396 文件。'); }
      await startRun();
    } catch (err) { S.showError('分析未能开始', err); }
    setBusy(false);
  };

  const match = () => {
    const a = S.dirs.A.value?.catalog, b = S.dirs.B.value?.catalog;
    if (!a || !b) return S.showToast('请先解析方案 A、B 两个文件夹。');
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
    setPaths({ A: paths.B, B: paths.A });
  };

  const openRecent = async (r) => {
    setBusy(true);
    try {
      S.setMode(r.mode === 'single' ? 'single' : 'ab');
      const sides = r.mode === 'single' ? ['A'] : ['A', 'B'];
      const viaHelper = (side) => r.via?.[side] === 'helper' && r.paths?.[side];
      if (sides.some(viaHelper)) {
        const h = await pingHelper();
        setHelper(h);
        if (!h) {
          const side = viaHelper('A') ? 'A' : 'B';
          setBusy(false);
          return setSetup({ side, path: r.paths[side] });
        }
      }
      for (const side of sides) {
        const h = r.handles?.[side];
        if (!viaHelper(side) && h && !(await ensurePermission(h))) throw new Error(`没有获得${r.mode === 'single' ? '' : `方案 ${side} `}文件夹（${h.name}）的读取授权。`);
      }
      for (const side of sides) {
        const h = r.handles?.[side];
        if (viaHelper(side)) await loadSide(side, { path: r.paths[side] });
        else if (h) await loadSide(side, { handle: h }, r.paths?.[side] || '');
      }
      const find = (side) => S.dirs[side].value?.catalog.batches.find((b) => b.batchId === r.batchIds?.[side]) || null;
      const next = { A: find('A'), B: r.mode === 'single' ? S.selection.value.B : find('B') };
      if (!next.A && !next.B) throw new Error('原来的批次已不在文件夹中（文件可能被移动或删除）。');
      S.selection.value = next;
      if (r.viewId) {
        const v = (await listAll('views')).find((x) => x.id === r.viewId);
        if (v) S.view.value = { ...S.defaultView(), ...v };
      }
      await startRun();
    } catch (err) {
      S.showError('恢复最近分析失败', err, ['可以重新解析路径后手动开始。']);
    }
    setBusy(false);
  };

  const shown = recents.filter((r) => (r.mode === 'single' ? 'single' : 'ab') === mode);
  const card = (side) => (
    <SideCard side={side} single={single} filters={filters[side]} setFilters={(f) => setFilters({ ...filters, [side]: f })}
      path={paths[side]} setPath={(p) => setPath(side, p)} onResolve={(p) => resolvePath(side, p)} onPick={() => pick(side)}
      onDrop={(e) => drop(side, e)} onSameAsA={side === 'B' ? sameAsA : null} />
  );

  return (
    <div class="start">
      <div class="top">
        <div class="logo"><Logo /></div><span class="brand">无线 Trace 分析台</span><span class="ver">v{__APP_VERSION__}</span>
        <span class="sp" />
        {useHelper && <HelperChip helper={helper} onClick={() => setSetup(setup ? null : { side: 'A', path: '' })} />}
        <a class="muted" style="font-size:12px;margin-right:12px" href="/probe.html">环境检查</a>
        <span class="muted" style="font-size:12px">数据只在本机浏览器内处理，不上传</span>
      </div>
      {hint && (
        <div class="pastehint">
          {hint.first
            ? <><b>首次使用这个目录，需要授权一次（以后不用）。</b>已复制 <code>{hint.copied}</code>。在弹出的窗口里：点顶部地址栏 → <kbd>Ctrl</kbd>+<kbd>V</kbd> → <kbd>回车</kbd> → 点“选择文件夹”；浏览器问是否允许时点“允许”（有“每次访问时都允许”就选它）。</>
            : <><b>路径已复制。</b>在弹出的窗口里：点一下顶部地址栏（或底部“文件夹”输入框）→ <kbd>Ctrl</kbd>+<kbd>V</kbd> → <kbd>回车</kbd> → 点“选择文件夹”。</>}
          <div class="faint" style="font-size:12px;margin-top:2px">{single ? '' : `方案 ${hint.side}：`}{hint.path}</div>
        </div>
      )}
      <div class="inner">
        <div class="modetabs">
          <button class={single ? 'on' : ''} onClick={() => S.setMode('single')}>
            <b>单小区分析</b><span>看一个小区自己的数据：概览、逐用户指标、自动体检、时序与分布</span>
          </button>
          <button class={single ? '' : 'on'} onClick={() => S.setMode('ab')}>
            <b>A/B 对比</b><span>两个方案（同一小区）对比：速率变化、谁拖累了小区、指标回退</span>
          </button>
        </div>
        {setup && (
          <HelperSetup helper={helper} setup={setup} onClose={() => setSetup(null)}
            onRetry={() => (setup.path ? resolvePath(setup.side, setup.path) : pingHelper().then(setHelper))} />
        )}
        <div class="startcard">
          {single ? (
            <>
              <div class="row" style="align-items:baseline"><b style="font-size:17px">新建单小区分析</b><span class="muted">粘贴数据所在的文件夹路径（可以是网络盘），点“解析”，选好小区批次后开始分析。</span></div>
              <div style="margin-top:14px">{card('A')}</div>
            </>
          ) : (
            <>
              <div class="row" style="align-items:baseline"><b style="font-size:17px">新建 A/B 对比</b><span class="muted">粘贴两个方案的数据文件夹路径（可以是网络盘）；同一跟踪有多个分片时自动用 trace_0。</span></div>
              <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:12px;margin-top:14px;align-items:stretch">
                {card('A')}
                <button class="btn" style="align-self:center" title="互换 A/B" onClick={swap}>⇄</button>
                {card('B')}
              </div>
            </>
          )}
          <div class="row" style="margin-top:16px">
            {!single && <button class="btn" onClick={match} disabled={!S.dirs.A.value || !S.dirs.B.value}>同小区一键匹配</button>}
            <span class="sp" />
            {!single && <button class="btn" disabled={!S.dirs.A.value || !S.dirs.B.value} onClick={() => (S.page.value = 'kpi')}>批量 KPI（多小区）</button>}
            <button class="btn primary" disabled={!canStart} onClick={start}>{busy ? '正在准备…' : '开始分析'}</button>
          </div>
          {shown.length > 0 && (
            <div class="recent" style="margin-top:18px">
              <b>最近{single ? '的单小区分析' : '的 A/B 对比'}</b>
              {shown.map((r) => (
                <div class="rr">
                  <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{r.label}{r.viewName && r.viewName !== '默认视图' ? ` · 视图「${r.viewName}」` : ''}</span>
                  <span class="row" style="flex:none">
                    <span class="faint">{new Date(r.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                    {r.handles?.A || r.handles?.B || (r.via?.A === 'helper' && r.paths?.A) || (r.via?.B === 'helper' && r.paths?.B) ? <button class="btn small" disabled={busy} onClick={() => openRecent(r)}>一键恢复</button> : <span class="faint">需重新解析路径</span>}
                    <button class="btn text danger" title="删除记录" onClick={() => remove('recents', r.id).then(refreshRecents)}>×</button>
                  </span>
                </div>
              ))}
            </div>
          )}
          <div class="envnote">
            {supportsDirectoryHandle() ? (
              <>
                粘贴路径即可解析：每个总目录（如 <code>\\服务器\共享</code>）只在第一次需要在窗口里授权一次，之后它下面的任何路径直接解析。计算全部在本机浏览器内完成，数据不上传。
                {roots.length > 0 && (
                  <div style="margin-top:6px">已授权：{roots.map((r) => (
                    <span class="chip" style="margin:2px 4px 0 0">{r.path}<button title="取消授权" onClick={() => forgetRoot(r.path).then(refreshRoots)}>×</button></span>
                  ))}</div>
                )}
              </>
            ) : '当前浏览器不支持记住文件夹授权，每次需在选择窗口里选文件夹。建议使用新版 Chrome 或 Edge。'}
          </div>
        </div>
      </div>
    </div>
  );
}

function PathBox({ side, path, setPath, onResolve, busy }) {
  const go = () => {
    const p = normalizePastedPath(path);
    if (!p || busy) return;
    onResolve(p);
  };
  return (
    <div class="row" style="gap:6px">
      <input class="input" style="flex:1;min-width:0;font-family:var(--mono);font-size:12px" placeholder="粘贴文件夹路径，如 \\100.100.97.83\cellDT\基线_v3"
        value={path} onInput={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()}
        aria-label={`方案 ${side} 文件夹路径`} title="粘贴路径后回车或点“解析”：列出这个文件夹里的小区批次" />
      <button class="btn" disabled={!String(path || '').trim() || busy} onClick={go}>解析</button>
    </div>
  );
}

function SideCard({ side, single, filters, setFilters, path, setPath, onResolve, onPick, onDrop, onSameAsA }) {
  const [over, setOver] = useState(false);
  const d = S.dirs[side].value;
  const sel = S.selection.value[side];
  const cat = d?.catalog;
  const cases = cat?.caseGroups || [];
  const caseObj = cases.find((c) => c.caseKey === filters.caseKey);
  const cells = filters.caseKey ? caseObj?.cells || [] : [...new Map(cases.flatMap((c) => c.cells).map((c) => [c.cellKey, c])).values()];
  const batches = (cat?.batches || []).filter((b) => (!filters.caseKey || b.caseKey === filters.caseKey) && (!filters.cellKey || b.cellKey === filters.cellKey));
  const k = side === 'A' ? 'a' : 'b';
  const setBatch = (id) => (S.selection.value = { ...S.selection.value, [side]: cat.batches.find((b) => b.batchId === id) || null });
  const title = single ? '数据文件夹' : `方案 ${side} 文件夹`;
  return (
    <div class={'pick' + (d?.catalog ? ' has' : '') + (over ? ' dragover' : '') + (single ? ' single' : '')}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { setOver(false); onDrop(e); }}>
      {!single && <span class={'k ' + k}>{side}</span>}
      <div class="body2">
        {!d?.catalog ? (
          <>
            <b>{d?.scanning ? '正在扫描文件夹…（网络盘可能要几秒）' : title}</b>
            {!single && <span class="muted" style="font-size:12px">{side === 'A' ? '基准方案' : '对比方案'}</span>}
            <PathBox side={side} path={path} setPath={setPath} onResolve={onResolve} busy={d?.scanning} />
            <div class="row" style="gap:6px"><button class="btn" onClick={onPick} disabled={d?.scanning}>选择文件夹…</button>{onSameAsA && S.dirs.A.value?.catalog ? <button class="btn" onClick={onSameAsA} title="A/B 在同一个目录下时用：自动配同小区的另一个批次">与 A 同一文件夹</button> : <span class="faint" style="font-size:12px">或从资源管理器把文件夹拖到这里</span>}</div>
          </>
        ) : (
          <>
            <div class="row"><b style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={d.fullPath || d.rootName}>📁 {d.rootName}</b><span class="sp" /><button class="btn small" onClick={onPick}>选择其他文件夹</button></div>
            {d.fullPath && <span class="faint" style="font-size:11px;font-family:var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title={d.fullPath}>{d.fullPath}</span>}
            <PathBox side={side} path={path} setPath={setPath} onResolve={onResolve} busy={d?.scanning} />
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
            <select class="input" value={sel?.batchId || ''} onChange={(e) => setBatch(e.target.value)} aria-label={single ? '小区批次' : `方案 ${side} 批次`}>
              <option value="">{side === 'B' ? '（不选 B）' : single ? '选择要分析的小区批次' : '选择批次'}</option>
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

function HelperChip({ helper, onClick }) {
  if (helper === undefined) return null;
  return (
    <button class={'helperchip' + (helper ? ' on' : '')} onClick={onClick} title={helper ? '本机助手在运行：粘贴路径不经授权直接读取' : '本机助手未运行（点击查看说明）'}>
      <i />{helper ? `本机助手 v${helper.version}` : '本机助手未运行'}
    </button>
  );
}

/** 高级：本机助手（需用 ?helper=1 启用）。默认流程不需要它。 */
function HelperSetup({ helper, setup, onClose, onRetry }) {
  const [busy, setBusy] = useState(false);
  const retry = async () => { setBusy(true); await onRetry(); setBusy(false); };
  return (
    <div class="startcard helpersetup">
      <div class="row" style="align-items:baseline">
        <b style="font-size:16px">{helper ? '本机助手已在运行' : '本机助手未运行（高级功能，可不用）'}</b>
        <span class="sp" /><button class="btn text" onClick={onClose} title="关闭">×</button>
      </div>
      {setup.path && <div class="faint" style="font-size:12px;font-family:var(--mono);margin-top:4px">{setup.path}</div>}
      {!helper && (
        <ol class="steps2">
          <li><a class="btn small" href={HELPER_DOWNLOAD} download="trace_helper.py">下载 trace_helper.py</a>，双击运行（需要 Python 3），窗口里输入 <kbd>Y</kbd> 回车设为开机自启。</li>
          <li>回到这里点“已启动，重试”。不想用助手：打开 <code>?helper=0</code> 即可关闭，粘贴路径改走“授权一次总目录”的默认方式。</li>
        </ol>
      )}
      <div class="row" style="margin-top:10px">
        <button class="btn primary" disabled={busy} onClick={retry}>{busy ? '正在连接…' : helper ? '好的' : '已启动，重试'}</button>
      </div>
    </div>
  );
}
