// 控制信道：T650（PDCCH CCE 申请）+ T941（PDCCH 聚合级别调整），按用户汇总。
// 回答两个问题：调度失败里有多少是 CCE 不够；DTX 多的用户 PDCCH 是否被迫抬高聚合级别。
import * as S from '../store.js';
import { ctrlFlags, ctrlRef, CTRL_RULES } from '../engine/ctrl.js';
import { fmt, fmtInt } from './fmt.js';
import { usePager, heatStyle, useSide } from './diagCommon.jsx';

const pct = (v, d = 1) => (v == null ? '—' : `${fmt(v, d)}%`);

export function CtrlTab() {
  const { key, side, seg } = useSide();
  const c = side?.statsCtrl;
  const users = (c?.users || []).slice().sort((a, b) => (b.n650 || b.n941 || 0) - (a.n650 || a.n941 || 0));
  const ref = ctrlRef(users);
  const rows = users.map((u) => ({ ...u, flags: ctrlFlags(u, ref) }));
  const pg = usePager(rows, 12);
  if (!c) {
    return (
      <div class="diag section" style="padding:14px">
        <div class="sh"><b>控制信道（T650 CCE 申请 · T941 聚合级别）</b>{seg}</div>
        <p class="muted">方案 {key} 的批次里没有 Dest_T650 / Dest_T941 文件。采集 cellDT 时勾上这两个跟踪号（与 537 同一批），这里就会给出：下行 CCE 申请失败率、PDCCH 聚合级别分布、连续 DTX 与聚合级别的关系，并补进“诊断结论”的调度不足与 PDCCH 漏检证据。</p>
      </div>
    );
  }
  const cell = c.cell || {};
  const hot = (v, m) => (v == null || !m ? {} : heatStyle(m / v, 0.6)); // 越高越差：取倒数着色
  return (
    <div class="diag ctrl">
      <div class="sh" style="margin-bottom:6px"><b>控制信道 · CCE 够不够、PDCCH 送不送得到</b><span class="muted">650/941 原表独立统计，按 rnti 挂到 537 用户；不受列筛选影响；已剔除系统消息（SIB/寻呼/RAR）</span>{seg}</div>
      <div class="kgrid factor-cards">
        <div class="kcard" title="650：tracePos 为申请（非释放）、schTypeBitmap 含 DL_DATA/DL_DCCH 的记录里 result ≠ 0 的比例"><div class="nm">下行 CCE 申请失败</div><div class="vals num"><span class="big A">{pct(cell.dlFail, 2)}</span></div><div class="foot">{fmtInt(cell.dlN)} 次申请 · 门限 &gt;{CTRL_RULES.cceWarn}% 报警 / &gt;{CTRL_RULES.cceBad}% 严重</div></div>
        <div class="kcard" title="同上，schTypeBitmap 含 UL_DATA：上行授权的 PDCCH 申请"><div class="nm">上行 CCE 申请失败</div><div class="vals num"><span class="big A">{pct(cell.ulFail, 2)}</span></div><div class="foot">{fmtInt(cell.ulN)} 次申请 · 单次最多重试失败 {fmtInt(cell.ulCntMax)} 次</div></div>
        <div class="kcard" title="650 下行申请的初始聚合级别（initAggLvl）"><div class="nm">下行初始聚合级别</div><div class="vals num"><span class="big A">{fmt(cell.dlAgg, 1)}</span></div><div class="foot">聚合 16 占 {pct(cell.dlAgg16, 0)}</div></div>
        <div class="kcard" title="941 suAggLvl：PDCCH 聚合级别调整后的结果"><div class="nm">PDCCH 聚合级别（941）</div><div class="vals num"><span class="big A">{fmt(cell.agg, 1)}</span></div><div class="foot">聚合 16 占 {pct(cell.agg16, 0)} · 用户中位 {pct(ref.agg16, 0)}</div></div>
        <div class="kcard" title="941 continuousDlDtxNum > 0 的记录占比；以及这些记录里聚合级别 16 的占比（与全体对比，看 DTX 后是否抬聚合级别）"><div class="nm">连续 DTX 记录</div><div class="vals num"><span class="big A">{pct(cell.dtxShare, 2)}</span></div><div class="foot">最长 {fmtInt(cell.dtxMax)} 次 · 其中聚合 16 占 {pct(cell.agg16Dtx, 0)}（全体 {pct(cell.agg16, 0)}）</div></div>
        <div class="kcard" title="941 widebandCqi0 均值"><div class="nm">宽带 CQI（941）</div><div class="vals num"><span class="big A">{fmt(cell.cqi, 1)}</span></div><div class="foot">{c.unmappedShare > 5 ? `${fmt(c.unmappedShare, 1)}% 的 650 记录找不到 537 用户` : '650/941 记录都已挂到用户'}</div></div>
      </div>
      <div class="section">
        <div class="sh"><b>逐用户（红 = 比用户中位差）</b><span class="muted">点一行：只看该用户并转到诊断结论</span></div>
        <div style="overflow-x:auto">
          <table class="t">
            <thead><tr><th class="left">用户</th><th title="650 下行 CCE 申请次数">下行申请</th><th>下行失败</th><th>上行失败</th><th title="650 ulCceFailCnt 最大值：一次上行授权连续失败的次数">上行连失败最多</th><th title="650 initAggLvl 均值（下行）">初始聚合</th><th title="941 suAggLvl 均值">聚合级别</th><th>聚合 16 占比</th><th title="941 continuousDlDtxNum > 0 的记录占比">连续 DTX</th><th>最长</th><th>CQI</th><th class="left">主要失败码</th><th class="left">判读</th></tr></thead>
            <tbody>
              {pg.rows.map((u) => (
                <tr class="click" onClick={() => { S.users.value = [u.user]; S.tab.value = 'dx'; }}>
                  <td class="left">{u.user}</td>
                  <td class="num">{fmtInt(u.dlN)}</td>
                  <td class="num" style={u.dlFail > CTRL_RULES.cceWarn ? { background: 'rgba(147,51,234,.14)' } : {}}>{pct(u.dlFail, 2)}</td>
                  <td class="num" style={u.ulFail > CTRL_RULES.cceWarn ? { background: 'rgba(147,51,234,.10)' } : {}}>{pct(u.ulFail, 2)}</td>
                  <td class="num">{fmtInt(u.ulCntMax)}</td>
                  <td class="num" style={hot(u.dlAgg, ref.agg)}>{fmt(u.dlAgg, 1)}</td>
                  <td class="num" style={hot(u.agg, ref.agg)}>{fmt(u.agg, 1)}</td>
                  <td class="num" style={hot(u.agg16, ref.agg16)}>{pct(u.agg16, 0)}</td>
                  <td class="num">{pct(u.dtxShare, 2)}</td>
                  <td class="num">{fmtInt(u.dtxMax)}</td>
                  <td class="num">{fmt(u.cqi, 1)}</td>
                  <td class="left">{u.topCode || <span class="faint">—</span>}</td>
                  <td class="left">{u.flags.length ? u.flags.map(([t, d]) => <span class={'tag ' + (t.startsWith('CCE') ? 'bad' : 'warn')} style="margin-right:3px" title={d}>{t}</span>) : <span class="faint">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style="padding:0 10px 8px">{pg.bar}</div>
      </div>
      <div class="muted foot-note">判读规则：下行 CCE 申请失败 &gt; {CTRL_RULES.cceWarn}% 且（&gt; {CTRL_RULES.cceBad}% 或 ≥ 用户中位 {CTRL_RULES.agg16Rel} 倍）→ 并进“调度不足”（全小区都高时归为共性问题）；聚合 16 占比 ≥ {CTRL_RULES.agg16Min}% 且 ≥ 用户中位 {CTRL_RULES.agg16Rel} 倍 → 并进“PDCCH 漏检”（覆盖/干扰差，CCE 消耗大）。申请或记录少于 {CTRL_RULES.minN} 条、或 CCE 失败少于 {CTRL_RULES.minFail} 次的用户不判。连续 DTX 记录里聚合 16 明显多于全体，说明 DTX 后系统在抬聚合级别补救。</div>
    </div>
  );
}
