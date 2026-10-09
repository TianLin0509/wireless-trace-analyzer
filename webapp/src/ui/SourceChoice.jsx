import * as S from '../store.js';
import { selectTraceFile } from '../engine/scan.js';
import { fmtBytes } from './fmt.js';

export function SourceChoice({ side, batch }) {
  if (!batch) return null;
  const traces = Object.entries(batch.traces);
  const all = traces.reduce((n, [, t]) => n + t.candidates.length, 0);
  const used = traces.filter(([, t]) => t.selected).length;
  return (
    <details class="source-choice">
      <summary>本次读取 {used} / {all} 个文件{all > used ? ` · 未使用 ${all - used} 个后续分片` : ''} · 展开核对或更改</summary>
      <p class="muted">默认每类跟踪使用 trace_0，其他分片不会自动拼接；独立更换文件后，请核对三类跟踪的时间覆盖。</p>
      {traces.map(([id, t]) => (
        <div class="trace-choice">
          <b>T{id}{!t.selected ? ' · 缺少文件' : ''}</b>
          {t.candidates.map((f) => <label>
            <input type="radio" name={`trace-${side}-${id}`} checked={t.selected?.relPath === f.relPath}
              onChange={() => { S.selection.value = { ...S.selection.value, [side]: selectTraceFile(batch, id, f.relPath) }; }} />
            <span>{f.name} · {fmtBytes(f.size)}</span>
          </label>)}
        </div>
      ))}
    </details>
  );
}
