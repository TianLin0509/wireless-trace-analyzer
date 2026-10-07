import * as S from '../store.js';
import { fmtInt, fmtBytes, fmt, fmtSec } from './fmt.js';

const ERR_TEXT = { 'TOO MANY COLUMNS': '字段数过多', 'MISSING COLUMNS': '字段数不足', 'UNQUOTED VALUE': '引号不匹配', 'INVALID UNICODE': '编码错误', CAST: '类型转换失败', 'LINE SIZE OVER MAXIMUM': '单行过长' };

export function QualityTab() {
  const src = S.sources.value;
  const sides = S.sides.value;
  const r = S.run.value;
  const list = ['A396', 'A537', 'A714', 'B396', 'B537', 'B714'].map((k) => src[k]).filter(Boolean);
  const rejected = list.reduce((n, s) => n + (s.quality?.rejectedRows || 0), 0);
  const nonNum = list.filter((s) => s.quality?.nonNumericCells);
  return (
    <div>
      {r?.errors?.length > 0 && (
        <div class="banner warn" style="display:block">
          <b>部分数据没有读成功：</b>
          <ul style="margin:4px 0 0">{r.errors.map((e) => <li>{e}</li>)}</ul>
        </div>
      )}
      {rejected > 0 && (
        <div class="banner warn">
          <span>共 {fmtInt(rejected)} 行因格式问题（字段数不符、引号不闭合等）未读入，明细见下表“坏行样例”。其余数据照常分析。</span>
          <span class="sp" />{!S.qualityAck.value && <button class="btn small" onClick={() => (S.qualityAck.value = true)}>知道了</button>}
        </div>
      )}
      {nonNum.length > 0 && (
        <div class="banner info" style="display:block">
          <b>数值列里有非数字文本，已按空值（NaN）处理：</b>
          <ul style="margin:4px 0 0">
            {nonNum.map((s) => (
              <li>{s.key}：{fmtInt(s.quality.nonNumericCells)} 个单元格，涉及 {fmtInt(s.quality.nonNumericRows)} 行{s.quality.nonNumericSample?.length ? `（如第 ${s.quality.nonNumericSample.slice(0, 5).join('、')} 条数据）` : ''}{s.quality.nonNumericColumns?.length ? `；列 ${s.quality.nonNumericColumns.join('、')}` : ''}</li>
            ))}
          </ul>
        </div>
      )}
      <div class="kgrid" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">
        {['A', 'B'].map((k) => sides[k] && (
          <div class="kcard" style="cursor:default">
            <div class="nm"><span>方案 {k} · 714 匹配率</span></div>
            <div class="vals num"><span class={'big ' + k}>{fmt(sides[k].matchRate, 2)}%</span></div>
            <div class="foot">537 锚点 {fmtInt(sides[k].anchorRows)} 行 · 未匹配 {fmtInt(sides[k].nanRows)} · 714 重复连接键 {fmtInt(sides[k].duplicate714Keys)} 组{sides[k].has714 ? '' : ' · 无 714 文件'}</div>
          </div>
        ))}
        <div class="kcard" style="cursor:default">
          <div class="nm"><span>坏行</span></div>
          <div class="vals num"><span class="big">{fmtInt(rejected)}</span></div>
          <div class="foot">{list.length} 个文件{rejected ? '' : '全部通过'}</div>
        </div>
        {r?.seconds && (
          <div class="kcard" style="cursor:default">
            <div class="nm"><span>读取耗时</span></div>
            <div class="vals num"><span class="big">{fmtSec(r.seconds)}</span></div>
            <div class="foot">{r.memory ? `引擎内存 ${fmtBytes(r.memory)}` : ''}</div>
          </div>
        )}
      </div>
      <div class="section">
        <div class="sh"><b>数据来源</b><span class="faint" style="font-size:12px">路径相对于所选文件夹；浏览器出于安全原因不提供磁盘绝对路径</span></div>
        <div style="overflow:auto">
          <table class="t">
            <thead><tr><th>方案</th><th>跟踪</th><th class="left">文件</th><th>大小</th><th>读入行数</th><th>坏行</th><th>读入字段</th><th class="left">说明</th></tr></thead>
            <tbody>
              {list.map((s) => (
                <tr>
                  <td class={s.side}>{s.side}</td>
                  <td>T{s.trace}</td>
                  <td class="left" title={s.relPath}>{s.relPath}</td>
                  <td class="num">{fmtBytes(s.size)}</td>
                  <td class="num">{fmtInt(s.quality?.acceptedRows ?? s.rows)}</td>
                  <td class={'num ' + (s.quality?.rejectedRows ? 'dn' : '')}>{fmtInt(s.quality?.rejectedRows || 0)}</td>
                  <td class="num">{s.trace === '396' ? `${s.users} 个用户` : `${s.selected?.length || 0} / ${s.columns?.length || 0}`}</td>
                  <td class="left faint">{[s.ignored ? `忽略 ${s.ignored} 个后续分片` : '', s.quality?.encodingNote].filter(Boolean).join('；')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {list.some((s) => s.quality?.samples?.length) && (
        <div class="section">
          <div class="sh"><b>坏行样例（每个文件最多 20 条）</b></div>
          <div style="overflow:auto;max-height:420px">
            <table class="t">
              <thead><tr><th>文件</th><th>行号</th><th class="left">原因</th><th class="left">原始内容</th></tr></thead>
              <tbody>
                {list.flatMap((s) => (s.quality?.samples || []).map((x) => (
                  <tr>
                    <td>{s.key}</td>
                    <td class="num">{x.line}</td>
                    <td class="left">{ERR_TEXT[x.error_type] || x.error_type}{x.issues > 1 ? `（${x.issues} 处）` : ''}<div class="faint" style="font-size:11px">{String(x.error_message || '').slice(0, 140)}</div></td>
                    <td class="left" style="font-family:var(--mono);font-size:11px;max-width:520px;overflow:hidden;text-overflow:ellipsis">{x.csv_line}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
