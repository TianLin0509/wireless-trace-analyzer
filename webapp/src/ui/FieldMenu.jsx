import { useState } from 'preact/hooks';
import * as S from '../store.js';
import { startRun } from '../pipeline.js';
import { DEFAULT_537_COLUMNS, DEFAULT_714_COLUMNS } from '../engine/config.js';

/** “字段”菜单：① 表格显示哪些列；② 汇总时从 537/714 读入哪些字段（改了需要重新读取合并，约十几秒）。 */
export function FieldMenu({ side, onClose }) {
  const [mode, setMode] = useState('show');
  return (
    <>
      <div class="backdrop" onClick={onClose} />
      <div class="pop" style="right:0;top:34px;width:420px">
        <div class="seg" style="margin-bottom:8px">
          <button class={mode === 'show' ? 'on' : ''} onClick={() => setMode('show')}>表格显示列</button>
          <button class={mode === 'merge' ? 'on' : ''} onClick={() => setMode('merge')}>汇总字段（537 / 714）</button>
        </div>
        {mode === 'show' ? <ShowColumns side={side} /> : <MergeColumns onClose={onClose} />}
      </div>
    </>
  );
}

function ShowColumns({ side }) {
  const v = S.view.value;
  const [q, setQ] = useState('');
  const hidden = new Set(v.hiddenColumns || []);
  const all = side.visibleColumns.filter((c) => !q || c.toLowerCase().includes(q.toLowerCase()));
  const toggle = (c) => {
    const n = new Set(hidden);
    n.has(c) ? n.delete(c) : n.add(c);
    S.updateView({ hiddenColumns: [...n] });
  };
  return (
    <div>
      <div class="row" style="margin-bottom:6px">
        <input class="input" style="flex:1" placeholder="搜索字段" value={q} onInput={(e) => setQ(e.target.value)} />
        <button class="btn small" onClick={() => S.updateView({ hiddenColumns: [] })}>全部显示</button>
        <button class="btn small" onClick={() => S.updateView({ columnOrder: [], hiddenColumns: [] })}>恢复默认顺序</button>
      </div>
      <div style="max-height:340px;overflow:auto;columns:2;font-size:12px">
        {all.map((c) => (
          <label style="display:flex;gap:6px;padding:2px 0;break-inside:avoid;cursor:pointer"><input type="checkbox" checked={!hidden.has(c)} onChange={() => toggle(c)} />{c}</label>
        ))}
      </div>
      <p class="faint" style="font-size:11px;margin:6px 0 0">列顺序：在表头直接拖动列名。显示列和顺序会随“视图”一起保存。</p>
    </div>
  );
}

function MergeColumns({ onClose }) {
  const v = S.view.value;
  const src = S.sources.value;
  const avail = (id) => [...new Set(['A', 'B'].flatMap((s) => src[`${s}${id}`]?.columns || []))];
  const [c537, set537] = useState(new Set(v.columns537));
  const [c714, set714] = useState(new Set(v.columns714));
  const [q, setQ] = useState('');
  const list = (title, cols, set, setter, defaults) => (
    <div style="flex:1;min-width:0">
      <div class="row" style="margin-bottom:4px">
        <b style="font-size:12px">{title}</b><span class="faint">{set.size} / {cols.length}</span><span class="sp" />
        <button class="btn text" onClick={() => setter(new Set(defaults))}>默认</button>
        <button class="btn text" onClick={() => setter(new Set(cols))}>全选</button>
      </div>
      <div style="max-height:300px;overflow:auto;font-size:12px;border:1px solid var(--line2);border-radius:8px;padding:4px 6px">
        {cols.filter((c) => !q || c.toLowerCase().includes(q.toLowerCase())).map((c) => (
          <label style="display:flex;gap:6px;padding:1px 0;cursor:pointer"><input type="checkbox" checked={set.has(c)} onChange={() => { const n = new Set(set); n.has(c) ? n.delete(c) : n.add(c); setter(n); }} />{c}</label>
        ))}
      </div>
    </div>
  );
  const apply = async () => {
    S.updateView({ columns537: [...c537], columns714: [...c714] });
    onClose();
    try {
      await startRun({ tablesOnly: true });
      S.showToast('已按新字段重新合并。');
    } catch (err) { S.showError('重新合并失败', err); }
  };
  return (
    <div>
      <input class="input" style="width:100%;margin-bottom:6px" placeholder="搜索字段" value={q} onInput={(e) => setQ(e.target.value)} />
      <div class="row" style="align-items:flex-start">
        {list('T537', avail('537'), c537, set537, DEFAULT_537_COLUMNS)}
        {list('T714', avail('714'), c714, set714, DEFAULT_714_COLUMNS)}
      </div>
      <p class="faint" style="font-size:11px">连接键（crnti、HH:MM:SS、frm、slot）和 tti、ambr 始终保留；714 字段在表中加“714_”前缀。只读选中的字段可以显著节省时间和内存。</p>
      <div class="row"><span class="sp" /><button class="btn primary" disabled={S.running.value} onClick={apply}>{S.running.value ? '正在读取，请稍候' : '应用并重新合并'}</button></div>
    </div>
  );
}
