// 一键流水线：T396 先出结果 → 读取 537/714（只读需要的列）→ 自动合并。全程后台进行，界面随时可看已就绪的部分。
// 任务串行：新任务先让旧任务停下并等它真正结束，再清理旧表，避免两个任务交叉改写同名表和界面状态。
import { batch as signalBatch } from '@preact/signals';
import { ingestT396, ingestTable, ingestAux, dropTable, fixUserKey } from './engine/ingest.js';
import { sniffFile, SNIFF_BYTES } from './engine/csvsniff.js';
import { mergeSide } from './engine/merge.js';
import { stats714 } from './engine/diagnose.js';
import { statsCtrl, CTRL_650_COLUMNS, CTRL_941_COLUMNS } from './engine/ctrl.js';
import { DIAG_537_COLUMNS, DIAG_714_COLUMNS } from './engine/config.js';
import { compareT396 } from './engine/t396.js';
import { getFile, getHead, isHelperFile } from './engine/fs.js';
import { memoryUsage, unregisterFile } from './engine/db.js';
import { addRecent } from './persist.js';
import { batchLabel } from './engine/scan.js';
import * as S from './store.js';

const KEYS_537 = ['tti', 'ambr', 'usrId', 'crnti', 'HH:MM:SS', 'frm', 'slotNo', 'slotNum'];
const KEYS_714 = ['crnti', 'HH:MM:SS', 'frm', 'slotNum', 'slotNo'];
const SRC_TABLES = ['src_A537', 'src_A714', 'src_B537', 'src_B714', 'src_A650', 'src_A941', 'src_B650', 'src_B941'];
const AUX = { 650: { label: 'T650 CCE', columns: CTRL_650_COLUMNS }, 941: { label: 'T941 聚合级别', columns: CTRL_941_COLUMNS } };
let runSeq = 0;
let activeRun = Promise.resolve();
// 浏览器单线程引擎的经验吞吐（MB/s），每读完一个文件按实测更新，用于估算进度
let throughput = 45;

class Cancelled extends Error {}

export function sourceFiles(sel) {
  const out = {};
  for (const side of ['A', 'B']) {
    const b = sel[side];
    if (!b) continue;
    for (const id of ['396', '537', '714', '650', '941']) {
      const f = b.traces[id]?.selected;
      if (f) out[`${side}${id}`] = f;
    }
  }
  return out;
}

/** 完整分析。tablesOnly=true 时只重读 537/714 并重新合并（换汇总字段时用）。 */
export function startRun(opts = {}) {
  const prev = activeRun;
  const myRun = ++runSeq;
  // 通知旧任务停止（它会在下一个检查点退出）
  if (S.run.value?.status === 'running') S.run.value = { ...S.run.value, status: 'cancelled' };
  const p = prev.catch(() => {}).then(() => execute(myRun, opts));
  activeRun = p.catch(() => {});
  return p;
}

export function cancelRun() {
  runSeq++;
  if (S.run.value?.status === 'running') S.run.value = { ...S.run.value, status: 'cancelled' };
}

export function runProgress() {
  const r = S.run.value;
  if (!r) return 0;
  const w = r.steps.reduce((s, x) => s + x.weight, 0) || 1;
  return r.steps.reduce((s, x) => s + x.weight * (['done', 'skip', 'error'].includes(x.state) ? 1 : x.pct || 0), 0) / w;
}

async function execute(myRun, { tablesOnly = false, keepUsers = false } = {}) {
  if (myRun !== runSeq) return; // 排队期间又有更新的任务
  // 单小区模式只分析 A 侧；从 A/B 模式切过来时残留的 B 选择不参与
  const sel = S.mode.value === 'single' ? { A: S.selection.value.A, B: null } : S.selection.value;
  const files = sourceFiles(sel);
  if (!files.A537 && !files.B537 && !files.A396 && !files.B396) throw new Error('所选批次里没有 T396 / T537 文件。');
  if (sel.A && sel.B && files.A537 && files.B537 && files.A537.physicalKey === files.B537.physicalKey) {
    throw new Error('方案 A/B 指向同一个 T537 文件，无法形成对比。请在 B 侧换一个批次，或点“同小区一键匹配”。');
  }
  const view = S.view.value;
  const fields = { columns537: [...view.columns537], columns714: [...view.columns714] };
  const steps = [];
  const add = (id, label, weight, file) => steps.push({ id, label, weight, file, state: file ? 'wait' : 'skip', pct: 0 });
  if (!tablesOnly) {
    add('A396', `${S.sideLabel('A')} · T396 速率`, 0.4, files.A396);
    if (files.B396) add('B396', `${S.sideLabel('B')} · T396 速率`, 0.4, files.B396);
  }
  add('A537', `${S.sideLabel('A')} · T537 调度`, 3, files.A537);
  add('A714', `${S.sideLabel('A')} · T714 链路`, 1.5, files.A537 && files.A714);
  add('mergeA', `${S.sideLabel('A')} · 合并 537 ⟵ 714`, 0.4, files.A537 ? {} : null);
  for (const id of ['650', '941']) if (files.A537 && files[`A${id}`]) add(`A${id}`, `${S.sideLabel('A')} · ${AUX[id].label}`, 0.6, files[`A${id}`]);
  if (sel.B) {
    add('B537', `${S.sideLabel('B')} · T537 调度`, 3, files.B537);
    add('B714', `${S.sideLabel('B')} · T714 链路`, 1.5, files.B537 && files.B714);
    add('mergeB', `${S.sideLabel('B')} · 合并 537 ⟵ 714`, 0.4, files.B537 ? {} : null);
    for (const id of ['650', '941']) if (files.B537 && files[`B${id}`]) add(`B${id}`, `${S.sideLabel('B')} · ${AUX[id].label}`, 0.6, files[`B${id}`]);
  }
  const startedAt = Date.now();
  const alive = () => myRun === runSeq;
  const guard = () => { if (!alive()) throw new Cancelled(); };
  const setRun = (patch) => { if (alive()) S.run.value = { ...S.run.value, ...patch }; };
  const setStep = (id, patch) => { if (alive()) S.run.value = { ...S.run.value, steps: S.run.value.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)) }; };

  S.run.value = { id: myRun, status: 'running', steps, startedAt, tablesOnly };
  signalBatch(() => {
    if (!tablesOnly) {
      S.t396.value = null;
      S.sources.value = {};
      S.qualityAck.value = false;
      if (!keepUsers) S.users.value = [];
      S.diagnosis.value = null;
      S.timelineFocus.value = null;
      S.page.value = 'work';
    }
    S.sides.value = { A: null, B: null };
    S.loadedFields.value = null;
  });
  // 先释放旧的合并表与原表，降低峰值内存
  for (const t of ['merged_a', 'merged_b', ...SRC_TABLES]) await dropTable(t).catch(() => {});

  const timed = async (id, bytes, fn) => {
    const t0 = performance.now();
    const est = Math.max(0.5, bytes / 1024 / 1024 / throughput);
    setStep(id, { state: 'run', pct: 0 });
    const timer = setInterval(() => setStep(id, { pct: Math.min(0.95, (performance.now() - t0) / 1000 / est), elapsed: (performance.now() - t0) / 1000 }), 300);
    try {
      const out = await fn();
      const sec = (performance.now() - t0) / 1000;
      if (bytes > 20 * 1024 * 1024) throughput = Math.max(5, bytes / 1024 / 1024 / sec);
      setStep(id, { state: 'done', pct: 1, elapsed: sec });
      return out;
    } catch (err) {
      setStep(id, { state: 'error', error: String(err?.message || err), elapsed: (performance.now() - t0) / 1000 });
      throw err;
    } finally {
      clearInterval(timer);
    }
  };

  // 本机助手来源：先把文件从本机 / 网络盘读进浏览器（显示读取进度），再交给引擎
  const fetchFile = async (id, f) => {
    if (!isHelperFile(f)) return getFile(f);
    setStep(id, { state: 'run', pct: 0, note: '正在通过本机助手读取文件…' });
    const t0 = performance.now();
    try {
      const file = await getFile(f, (x) => setStep(id, { pct: x * 0.95, note: `正在通过本机助手读取文件 ${Math.round(x * 100)}%` }));
      setStep(id, { note: `经本机助手读取文件 ${((performance.now() - t0) / 1000).toFixed(1)} 秒` });
      return file;
    } catch (err) {
      setStep(id, { state: 'error', error: String(err?.message || err), note: '' });
      throw err;
    }
  };

  const srcMeta = tablesOnly ? { ...S.sources.value } : {};
  const record = (key, meta) => { srcMeta[key] = meta; if (alive()) S.sources.value = { ...srcMeta }; };
  const errors = [];
  try {
    // 1) T396 先出结果
    if (!tablesOnly) {
      const agg = {};
      for (const side of ['A', 'B']) {
        const key = `${side}396`;
        const f = files[key];
        if (!f) continue;
        try {
          const file = await fetchFile(key, f);
          const res = await timed(key, file.size / 4, () => ingestT396(key, file));
          await unregisterFile(key);
          agg[side] = res.aggregate;
          record(key, { key, trace: '396', side, name: f.name, relPath: f.relPath, size: file.size, rows: res.rows, users: res.aggregate.length, quality: res.quality, userNote: res.userNote });
        } catch (err) {
          errors.push(`${key}：${err.message || err}`);
        }
        guard();
      }
      if (agg.A || agg.B) S.t396.value = compareT396(agg.A || [], agg.B || []);
    }

    // 2) 预检全部 537/714（只读文件头，毫秒级）。一侧缺 714 时，用另一侧 714 的字段补出同名空列，保证 A/B 列集合一致
    const wantedFor = (id) => (id === '537' ? [...new Set([...KEYS_537, ...fields.columns537, ...DIAG_537_COLUMNS])] : [...new Set([...KEYS_714, ...fields.columns714, ...DIAG_714_COLUMNS])]);
    const pre = {};
    for (const side of ['A', 'B']) {
      for (const id of ['537', '714']) {
        const f = files[`${side}${id}`];
        if (!f) continue;
        try {
          // 只读文件开头做预检；整份文件到真正读入这一侧时才取，网络盘上不会一次拉下四个大文件
          pre[`${side}${id}`] = { sniff: await sniffFile(await getHead(f, SNIFF_BYTES)) };
        } catch (err) {
          errors.push(`${side}${id}：${err.message || err}`);
        }
      }
    }
    const fallback714 = (side) => {
      const p714 = pre[`${side}714`];
      if (!p714) return null;
      const cols = new Set(p714.sniff.columns);
      const selected = wantedFor('714').filter((c) => cols.has(c));
      return { selected, numericColumns: selected.filter((c) => p714.sniff.numericColumns.includes(c)) };
    };

    // 3) 逐侧“读入 → 合并 → 释放原表”，同一时刻最多只有一侧的原表在内存里
    const merged = { A: null, B: null };
    for (const side of ['A', 'B']) {
      const t = {};
      for (const id of ['537', '714']) {
        const key = `${side}${id}`;
        const f = files[key];
        if (!f || !pre[key]) continue;
        if (id === '714' && !t['537']) { setStep(key, { state: 'skip' }); continue; }
        try {
          const { sniff } = pre[key];
          const file = await fetchFile(key, f);
          const res = await timed(key, file.size, () => ingestTable(key, file, id, wantedFor(id), sniff));
          t[id] = res;
          if (id === '537') res.userNote = await fixUserKey(res).catch(() => null);
          record(key, { key, trace: id, side, name: f.name, relPath: f.relPath, size: file.size, rows: res.rows, columns: res.columns, selected: res.selected, numericColumns: res.numericColumns, quality: res.quality, ignored: (sel[side]?.traces[id]?.candidates.length || 1) - 1 });
        } catch (err) {
          errors.push(`${key}：${err.message || err}`);
        }
        guard();
      }
      if (t['537']) {
        try {
          merged[side] = await timed(`merge${side}`, 0, () => mergeSide(side, t['537'], t['714'] || null, t['714'] ? null : fallback714(side === 'A' ? 'B' : 'A')));
          // 原表释放前，在 714 原表上做独立统计（初传 BLER / DTX / OLLA），不受 537/714 逐行连接率影响
          if (merged[side]) merged[side].userNote = t['537'].userNote || null;
          if (merged[side] && t['714']) merged[side].stats714 = await stats714(t['537'], t['714']).catch(() => null);
          // 控制信道（650/941）：读入后按用户汇总，立即释放
          const aux = {};
          for (const id of ['650', '941']) {
            const key = `${side}${id}`, f = files[key];
            if (!f || !merged[side]) continue;
            try {
              const file = await fetchFile(key, f);
              aux[id] = await timed(key, file.size / 3, () => ingestAux(key, file, AUX[id].columns));
              record(key, { key, trace: id, side, name: f.name, relPath: f.relPath, size: file.size, rows: aux[id].rows, columns: aux[id].columns, selected: aux[id].selected, numericColumns: aux[id].numericColumns, quality: { rejectedRows: 0 }, ignored: 0 });
            } catch (err) {
              errors.push(`${key}：${err.message || err}`);
            }
            guard();
          }
          if (merged[side] && (aux['650'] || aux['941'])) merged[side].statsCtrl = await statsCtrl(t['537'], aux['650'], aux['941']).catch((err) => { errors.push(`控制信道 ${side}：${err.message || err}`); return null; });
          for (const id of ['650', '941']) { await dropTable(`src_${side}${id}`).catch(() => {}); await unregisterFile(`${side}${id}`).catch(() => {}); }
        } catch (err) {
          errors.push(`合并方案 ${side}：${err.message || err}`);
        }
      } else if (files[`${side}537`]) {
        setStep(`merge${side}`, { state: 'skip' });
      }
      await dropTable(`src_${side}537`);
      await dropTable(`src_${side}714`);
      // 原文件不再需要：从引擎里摘掉，浏览器可以回收读进来的文件缓存
      await unregisterFile(`${side}537`);
      await unregisterFile(`${side}714`);
      guard();
    }
    const mem = await memoryUsage();
    guard(); // 等内存统计的这段时间里也可能被取消
    const failedSides = ['A', 'B'].filter((k) => files[`${k}537`] && !merged[k]);
    signalBatch(() => {
      S.sides.value = merged;
      S.loadedFields.value = fields;
      S.dataVersion.value++;
      S.run.value = { ...S.run.value, status: errors.length ? 'partial' : 'done', errors, failedSides, finishedAt: Date.now(), memory: mem, seconds: (Date.now() - startedAt) / 1000 };
      if (!merged[S.tableSide.value]) S.tableSide.value = merged.A ? 'A' : 'B';
    });
    if (!tablesOnly) await rememberRecent();
  } catch (err) {
    if (err instanceof Cancelled) return;
    setRun({ status: 'error', errors: [...errors, String(err?.message || err)] });
    throw err;
  } finally {
    // 无论成功、失败还是被取消，原表都不保留
    for (const t of SRC_TABLES) await dropTable(t).catch(() => {});
  }
}

async function rememberRecent() {
  const single = S.mode.value === 'single';
  const sel = single ? { A: S.selection.value.A, B: null } : S.selection.value;
  const v = S.view.value;
  const entry = {
    signature: `${single ? 'single' : 'ab'}::` + ['A', 'B'].map((s) => `${S.dirs[s].value?.rootName || ''}|${sel[s]?.batchId || ''}`).join('||'),
    label: single ? (sel.A ? batchLabel(sel.A) : '—') : `${sel.A ? batchLabel(sel.A) : '—'}  vs  ${sel.B ? batchLabel(sel.B) : '—'}`,
    mode: single ? 'single' : 'ab',
    roots: { A: S.dirs.A.value?.rootName || null, B: S.dirs.B.value?.rootName || null },
    paths: { A: S.dirs.A.value?.fullPath || '', B: single ? '' : S.dirs.B.value?.fullPath || '' },
    handles: { A: S.dirs.A.value?.handle || null, B: single ? null : S.dirs.B.value?.handle || null },
    via: { A: S.dirs.A.value?.via || null, B: single ? null : S.dirs.B.value?.via || null },
    batchIds: { A: sel.A?.batchId || null, B: sel.B?.batchId || null },
    traceChoices: Object.fromEntries(['A', 'B'].map((side) => [side, Object.fromEntries(Object.entries(sel[side]?.traces || {}).filter(([, t]) => t.selected).map(([id, t]) => [id, t.selected.relPath]))])),
    viewId: v.id,
    viewName: v.name,
  };
  try { await addRecent(entry); } catch { /* 句柄不可序列化时（退回模式）忽略 */ }
}
