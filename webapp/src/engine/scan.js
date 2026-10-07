// 文件夹扫描与批次分类：与旧版 catalog.py 的口径保持一致（trace_0 优先、ParseResult 上两级为 小区 / Case、同小区一键匹配）。
// 纯函数部分不依赖浏览器，可在 Node 下单测。

export const SUPPORTED_TRACES = ['396', '537', '714'];
const TRACE_RE = /Dest_T(\d{3,4})(?=_)/i;
const TAIL_TS_RE = /_(\d{14})$/;
const ANY_TS_RE = /(20\d{12})/g;
const TRACE_INDEX_RE = /(?:^|_)trace_(\d+)(?:_|$)/i;
export const MAX_SCAN_FILES = 5000;

export function formatTimestamp(raw) {
  if (!raw || !/^\d{14}$/.test(raw)) return { full: null, short: null };
  const p = (a, b) => raw.slice(a, b);
  return {
    full: `${p(0, 4)}-${p(4, 6)}-${p(6, 8)} ${p(8, 10)}:${p(10, 12)}:${p(12, 14)}`,
    short: `${p(4, 6)}-${p(6, 8)} ${p(8, 10)}:${p(10, 12)}:${p(12, 14)}`,
  };
}

export function parseTraceMeta(name) {
  const stem = name.replace(/\.[^.]+$/, '');
  const traceMatch = stem.match(TRACE_RE);
  const traceId = traceMatch ? traceMatch[1] : null;
  let ts = (stem.match(TAIL_TS_RE) || [])[1] || null;
  if (!ts) {
    const all = [...stem.matchAll(ANY_TS_RE)];
    ts = all.length ? all[all.length - 1][1] : null;
  }
  const idx = stem.match(TRACE_INDEX_RE);
  const t = formatTimestamp(ts);
  return {
    traceId,
    traceIndex: idx ? Number(idx[1]) : 999999,
    testTimeRaw: ts,
    testTime: t.full,
    testTimeShort: t.short,
    name,
  };
}

/** parts: [根目录名, ..., 文件名]。返回 ParseResult 层级上下文。 */
export function parseResultContext(parts) {
  const dirs = parts.slice(0, -1);
  const pr = dirs.findIndex((d) => d.toLowerCase() === 'parseresult');
  if (pr < 0) {
    return { contextKey: '', contextLabel: '', contextParts: [], caseKey: '', caseName: '', cellKey: '', cellName: '' };
  }
  const ctx = dirs.slice(0, pr + 1);
  const cellName = pr >= 1 ? dirs[pr - 1] : '';
  const caseName = pr >= 2 ? dirs[pr - 2] : '';
  const contextPath = ctx.join('/');
  return {
    contextKey: contextPath.toLowerCase(),
    contextLabel: ctx.join(' / '),
    contextParts: ctx,
    caseKey: dirs.slice(0, Math.max(0, pr - 1)).join('/').toLowerCase(),
    caseName,
    cellKey: cellName.toLowerCase(),
    cellName,
  };
}

/** 把一个原始条目（来自目录句柄或 webkitdirectory）变成目录项；不支持的跟踪号返回 null。 */
export function describeFile(entry) {
  const parts = entry.relPath.split('/').filter(Boolean);
  const name = parts[parts.length - 1];
  if (!/\.csv$/i.test(name)) return null;
  const meta = parseTraceMeta(name);
  if (!SUPPORTED_TRACES.includes(meta.traceId)) return null;
  return {
    ...meta,
    ...parseResultContext(parts),
    relPath: entry.relPath,
    directory: parts.slice(0, -1).join('/'),
    size: entry.size,
    lastModified: entry.lastModified,
    physicalKey: `${entry.rootId || ''}|${entry.relPath}|${entry.size}|${entry.lastModified}`.toLowerCase(),
    ref: entry.ref, // { file } 或 { handle }，由浏览器层使用
  };
}

const naturalKey = (value) =>
  String(value || '')
    .split(/(\d+)/)
    .filter((p) => p !== '')
    .map((p) => (/^\d+$/.test(p) ? [0, Number(p), ''] : [1, 0, p.toLowerCase()]));

export function naturalCompare(a, b) {
  const ka = naturalKey(a), kb = naturalKey(b);
  for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
    const [ta, na, sa] = ka[i], [tb, nb, sb] = kb[i];
    if (ta !== tb) return ta - tb;
    if (na !== nb) return na - nb;
    if (sa !== sb) return sa < sb ? -1 : 1;
  }
  return ka.length - kb.length;
}

export function buildCatalog(files) {
  const grouped = new Map();
  for (const f of files) {
    const ts = f.testTimeRaw || 'unknown';
    const key = `${f.contextKey}\u0000${ts}`;
    if (!grouped.has(key)) grouped.set(key, { contextKey: f.contextKey, ts, traces: {} });
    const g = grouped.get(key);
    (g.traces[f.traceId] ||= []).push(f);
  }
  const batches = [];
  for (const g of grouped.values()) {
    const traces = {};
    let ignored = 0;
    for (const id of SUPPORTED_TRACES) {
      const cands = (g.traces[id] || []).slice().sort((a, b) => a.traceIndex - b.traceIndex || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      ignored += Math.max(0, cands.length - 1);
      traces[id] = { selected: cands[0] || null, candidates: cands };
    }
    const first = SUPPORTED_TRACES.map((id) => traces[id].selected).find(Boolean) || {};
    const available = SUPPORTED_TRACES.filter((id) => traces[id].selected);
    batches.push({
      batchId: g.contextKey ? `${first.contextLabel}::${g.ts}` : g.ts,
      testTimeRaw: g.ts === 'unknown' ? null : g.ts,
      testTime: first.testTime || '未解析时间',
      testTimeShort: first.testTimeShort || '-',
      contextLabel: first.contextLabel || '',
      contextParts: first.contextParts || [],
      caseKey: first.caseKey || '',
      caseName: first.caseName || '',
      cellKey: first.cellKey || '',
      cellName: first.cellName || '',
      directory: first.directory || '',
      traces,
      availableTraces: available,
      ignoredFragments: ignored,
      totalBytes: available.reduce((s, id) => s + (traces[id].selected.size || 0), 0),
    });
  }
  batches.sort((a, b) => {
    const ka = [a.testTimeRaw ? 1 : 0, a.testTimeRaw || '', a.contextLabel];
    const kb = [b.testTimeRaw ? 1 : 0, b.testTimeRaw || '', b.contextLabel];
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? 1 : -1;
    return 0;
  });
  const cases = new Map();
  for (const b of batches) {
    const ck = b.caseKey || '__none__';
    if (!cases.has(ck)) cases.set(ck, { caseKey: b.caseKey, caseName: b.caseName || '未分类', batchCount: 0, cells: new Map() });
    const c = cases.get(ck);
    c.batchCount++;
    const lk = b.cellKey || '__none__';
    if (!c.cells.has(lk)) c.cells.set(lk, { cellKey: b.cellKey, cellName: b.cellName || '未分类', batchCount: 0 });
    c.cells.get(lk).batchCount++;
  }
  const caseGroups = [...cases.values()]
    .map((c) => ({ ...c, cells: [...c.cells.values()].sort((x, y) => naturalCompare(x.cellName, y.cellName)) }))
    .sort((x, y) => naturalCompare(x.caseName, y.caseName));
  return { files, batches, caseGroups, fileCount: files.length };
}

const batchEpoch = (b) => {
  const r = b.testTimeRaw;
  if (!r) return null;
  return Date.UTC(+r.slice(0, 4), +r.slice(4, 6) - 1, +r.slice(6, 8), +r.slice(8, 10), +r.slice(10, 12), +r.slice(12, 14)) / 1000;
};

const batchPhysical = (b, requiredTrace) =>
  new Set((requiredTrace ? [requiredTrace] : SUPPORTED_TRACES).map((id) => b.traces[id]?.selected?.physicalKey).filter(Boolean));

export function bestBatchPair(candA, candB, requiredTrace) {
  let best = null;
  for (const a of candA) {
    const pa = batchPhysical(a, requiredTrace);
    for (const b of candB) {
      const pb = batchPhysical(b, requiredTrace);
      if ([...pa].some((k) => pb.has(k))) continue;
      const ea = batchEpoch(a), eb = batchEpoch(b);
      const exact = !!a.testTimeRaw && a.testTimeRaw === b.testTimeRaw;
      const gap = ea != null && eb != null ? Math.abs(ea - eb) : Infinity;
      const newest = Math.max(ea || 0, eb || 0);
      const diffCase = (a.caseName || '').toLowerCase() !== (b.caseName || '').toLowerCase();
      const score = [diffCase ? 0 : 1, exact ? 0 : 1, gap, -newest, a.batchId, b.batchId];
      if (!best || compareScore(score, best.score) < 0) best = { score, a, b };
    }
  }
  return best ? [best.a, best.b] : null;
}

function compareScore(x, y) {
  for (let i = 0; i < x.length; i++) {
    if (x[i] === y[i]) continue;
    return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** 每个共同小区只产生一组 A/B，不做笛卡尔积。 */
export function matchSameCellBatches(catalogA, catalogB, { caseA = '', caseB = '', cellKey = '', requiredTrace = null, maxPairs = 30 } = {}) {
  const eligible = (cat, caseKey) =>
    (cat?.batches || []).filter(
      (b) => b.cellKey && (!caseKey || b.caseKey === caseKey) && (!cellKey || b.cellKey === cellKey) && (!requiredTrace || b.traces[requiredTrace]?.selected),
    );
  const group = (list) => list.reduce((m, b) => ((m[b.cellKey] ||= []).push(b), m), {});
  const ga = group(eligible(catalogA, caseA));
  const gb = group(eligible(catalogB, caseB));
  const common = Object.keys(ga).filter((k) => gb[k]).sort((x, y) => naturalCompare(ga[x][0].cellName, ga[y][0].cellName));
  const pairs = [];
  const skipped = [];
  for (const k of common) {
    const best = bestBatchPair(ga[k], gb[k], requiredTrace);
    if (!best) { skipped.push(ga[k][0].cellName); continue; }
    const [a, b] = best;
    pairs.push({ cellKey: k, cellName: a.cellName || b.cellName, label: `${a.cellName} · ${a.caseName || '方案 A'} vs ${b.caseName || '方案 B'}`, a, b });
  }
  return {
    pairs: pairs.slice(0, maxPairs),
    truncated: pairs.length > maxPairs,
    unmatchedA: Object.keys(ga).filter((k) => !gb[k]).map((k) => ga[k][0].cellName).sort(naturalCompare),
    unmatchedB: Object.keys(gb).filter((k) => !ga[k]).map((k) => gb[k][0].cellName).sort(naturalCompare),
    skipped,
  };
}

/** 默认选择：先各取最新批次，再尽量换成“同小区”的一组。 */
export function defaultSelection(catalogA, catalogB) {
  const sel = { A: catalogA?.batches?.[0] || null, B: catalogB?.batches?.[0] || null };
  if (catalogA && catalogB) {
    const m = matchSameCellBatches(catalogA, catalogB, { maxPairs: 1 });
    if (m.pairs.length) { sel.A = m.pairs[0].a; sel.B = m.pairs[0].b; }
    else if (sel.A && sel.B && batchPhysical(sel.A).size && [...batchPhysical(sel.A)].some((k) => batchPhysical(sel.B).has(k))) {
      // A/B 指向同一个文件夹时，B 选另一个批次
      sel.B = catalogB.batches.find((b) => ![...batchPhysical(b)].some((k) => batchPhysical(sel.A).has(k))) || null;
    }
  }
  return sel;
}

export function batchLabel(b) {
  if (!b) return '未选择';
  const place = [b.caseName, b.cellName].filter(Boolean).join(' · ');
  return `${place || b.directory || '当前目录'} · ${b.testTimeShort}`;
}
