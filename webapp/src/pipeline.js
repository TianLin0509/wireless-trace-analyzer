// 一键流水线：T396 先出结果 → 读取 537/714（只读需要的列）→ 自动合并。全程后台进行，界面随时可看已就绪的部分。
// 任务串行：新任务先让旧任务停下并等它真正结束，再清理旧表，避免两个任务交叉改写同名表和界面状态。
import { batch as signalBatch } from '@preact/signals';
import { ingestT396, ingestTable, dropTable } from './engine/ingest.js';
import { sniffFile } from './engine/csvsniff.js';
import { mergeSide } from './engine/merge.js';
import { compareT396 } from './engine/t396.js';
import { getFile } from './engine/fs.js';
import { memoryUsage } from './engine/db.js';
import { addRecent } from './persist.js';
import { batchLabel } from './engine/scan.js';
import * as S from './store.js';

const KEYS_537 = ['tti', 'ambr', 'crnti', 'HH:MM:SS', 'frm', 'slotNo', 'slotNum'];
const KEYS_714 = ['crnti', 'HH:MM:SS', 'frm', 'slotNum', 'slotNo'];
const SRC_TABLES = ['src_A537', 'src_A714', 'src_B537', 'src_B714'];
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
    for (const id of ['396', '537', '714']) {
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
  const sel = S.selection.value;
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
    add('A396', '方案 A · T396 速率', 0.4, files.A396);
    add('B396', '方案 B · T396 速率', 0.4, files.B396);
  }
  add('A537', '方案 A · T537 调度', 3, files.A537);
  add('A714', '方案 A · T714 链路', 1.5, files.A537 && files.A714);
  add('mergeA', '方案 A · 合并 537 ⟵ 714', 0.4, files.A537 ? {} : null);
  add('B537', '方案 B · T537 调度', 3, files.B537);
  add('B714', '方案 B · T714 链路', 1.5, files.B537 && files.B714);
  add('mergeB', '方案 B · 合并 537 ⟵ 714', 0.4, files.B537 ? {} : null);
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
          const file = await getFile(f);
          const res = await timed(key, file.size / 4, () => ingestT396(key, file));
          agg[side] = res.aggregate;
          record(key, { key, trace: '396', side, name: f.name, relPath: f.relPath, size: file.size, rows: res.rows, users: res.aggregate.length, quality: res.quality });
        } catch (err) {
          errors.push(`${key}：${err.message || err}`);
        }
        guard();
      }
      if (agg.A || agg.B) S.t396.value = compareT396(agg.A || [], agg.B || []);
    }

    // 2) 预检全部 537/714（只读文件头，毫秒级）。一侧缺 714 时，用另一侧 714 的字段补出同名空列，保证 A/B 列集合一致
    const wantedFor = (id) => (id === '537' ? [...new Set([...KEYS_537, ...fields.columns537])] : [...new Set([...KEYS_714, ...fields.columns714])]);
    const pre = {};
    for (const side of ['A', 'B']) {
      for (const id of ['537', '714']) {
        const f = files[`${side}${id}`];
        if (!f) continue;
        try {
          const file = await getFile(f);
          pre[`${side}${id}`] = { file, sniff: await sniffFile(file) };
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
          const { file, sniff } = pre[key];
          const res = await timed(key, file.size, () => ingestTable(key, file, id, wantedFor(id), sniff));
          t[id] = res;
          record(key, { key, trace: id, side, name: f.name, relPath: f.relPath, size: file.size, rows: res.rows, columns: res.columns, selected: res.selected, numericColumns: res.numericColumns, quality: res.quality, ignored: (sel[side]?.traces[id]?.candidates.length || 1) - 1 });
        } catch (err) {
          errors.push(`${key}：${err.message || err}`);
        }
        guard();
      }
      if (t['537']) {
        try {
          merged[side] = await timed(`merge${side}`, 0, () => mergeSide(side, t['537'], t['714'] || null, t['714'] ? null : fallback714(side === 'A' ? 'B' : 'A')));
        } catch (err) {
          errors.push(`合并方案 ${side}：${err.message || err}`);
        }
      } else if (files[`${side}537`]) {
        setStep(`merge${side}`, { state: 'skip' });
      }
      await dropTable(`src_${side}537`);
      await dropTable(`src_${side}714`);
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
  const sel = S.selection.value;
  const v = S.view.value;
  const entry = {
    signature: ['A', 'B'].map((s) => `${S.dirs[s].value?.rootName || ''}|${sel[s]?.batchId || ''}`).join('||'),
    label: `${sel.A ? batchLabel(sel.A) : '—'}  vs  ${sel.B ? batchLabel(sel.B) : '—'}`,
    roots: { A: S.dirs.A.value?.rootName || null, B: S.dirs.B.value?.rootName || null },
    handles: { A: S.dirs.A.value?.handle || null, B: S.dirs.B.value?.handle || null },
    batchIds: { A: sel.A?.batchId || null, B: sel.B?.batchId || null },
    viewId: v.id,
    viewName: v.name,
  };
  try { await addRecent(entry); } catch { /* 句柄不可序列化时（退回模式）忽略 */ }
}
