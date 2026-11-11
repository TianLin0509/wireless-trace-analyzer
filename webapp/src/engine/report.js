// 报告只在浏览器中生成；不发送文件、路径、统计或图片到服务器。
import * as S from '../store.js';
import { cellOverview, cellBasics, userMetrics, joinRates, findings, checkCoverage } from './single.js';
import { summaryCards } from './stats.js';
import { scopeRate } from './t396.js';
import { filterSql } from './query.js';
import { rateScopeLabel } from './analysis-scope.js';
import { batchLabel } from './scan.js';
import { toFullPath } from './fs.js';
import { describeFilter } from '../ui/filters.js';
import { loadPlotly } from '../ui/Plot.jsx';
import { sideEvidence } from '../ui/ConcludeTab.jsx';
import { concludeAb, commonCauses } from './conclude.js';
import { ctrlFlags, ctrlRef } from './ctrl.js';

export const escapeHtml = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = (x, digits = 2) => x == null || !Number.isFinite(Number(x)) ? '—' : Number(x).toLocaleString('zh-CN', { maximumFractionDigits: digits });
const table = (heads, rows) => `<div class="table-wrap"><table><thead><tr>${heads.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((x) => `<td>${escapeHtml(x)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
const safeImage = (url) => /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(url || '') ? url : null;

function distribution(a, b) {
  const items = [a?.cdf, b?.cdf].filter((c) => c?.x.length);
  if (!items.length) return '';
  const all = items.flatMap((c) => c.x).filter(Number.isFinite);
  const lo = Math.min(...all), hi = Math.max(...all);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return '';
  const path = (c, color) => !c?.x.length ? '' : `<path d="${c.x.map((x, i) => `${i ? 'L' : 'M'}${(24 + (x - lo) / (hi - lo || 1) * 270).toFixed(1)},${(92 - c.y[i] * .8).toFixed(1)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>`;
  return `<svg viewBox="0 0 320 120" role="img" aria-label="累计分布 CDF"><path d="M24,12V92H294" fill="none" stroke="#d2d2d7"/>${path(a?.cdf, '#2563eb')}${path(b?.cdf, '#f97316')}<text x="24" y="111">${escapeHtml(number(lo))}</text><text x="250" y="111">${escapeHtml(number(hi))}</text><text x="4" y="15">100%</text></svg>`;
}

function cardHtml(c) {
  const a = c.a || { value: c.value, n: c.n, cdf: c.cdf };
  const text = c.b ? `${number(a.value, c.digits)} → ${number(c.b.value, c.digits)}` : number(a.value, c.digits);
  const bars = c.kind === 'share' || c.kind === 'bler' ? [a, c.b].filter(Boolean).map((x, i) => `<div class="bar"><i style="width:${Math.max(0, Math.min(100, Number(x.value) || 0))}%;background:${i ? '#f97316' : '#2563eb'}"></i></div>`).join('') : '';
  return `<article class="card"><b>${escapeHtml(c.label)}</b><div class="value">${escapeHtml(text)} ${escapeHtml(c.unit || '')}</div>${distribution(a, c.b)}${bars}${c.cats ? table(['取值', '占比'], c.cats.map((x) => [x.value, number(x.share, 1) + '%'])) : ''}<p class="muted">样本 ${number(a.n, 0)}${c.b ? ' / ' + number(c.b.n, 0) : ''}${c.dtx != null ? ' · DTX 剔除 ' + number(c.dtx, 0) : ''}</p></article>`;
}

/** 诊断结论段：单小区为逐用户初判；A/B 为小区一句话 + 逐用户主因。规则线索，不是确认根因。 */
function diagnosisHtml(d, single) {
  if (!d) return '';
  const note = '<p class="muted">综合速率拆解（七因子恒等式）、受限类型、链路判读与异常事件的规则初判，是定位线索，不是确认根因；需在时间轴或其他跟踪号上核实。</p>';
  if (single) {
    const common = d.common?.length ? `<p>小区共性问题（≥ 60% 用户都有）：${escapeHtml(d.common.map((c) => `${c.label}（${c.users} 个用户）`).join('、'))}</p>` : '';
    const set = new Set((d.common || []).map((c) => c.id));
    return `<h2>诊断结论</h2>${note}${common}${table(['用户', '初传次数', '初判', '证据'], d.list.map((u) => { const own = u.causes.filter((c) => !set.has(c.id)); return [u.user, number(u.tries, 0), own.map((c) => c.label).join('、') || '—', own.slice(0, 2).map((c) => c.evidence).filter(Boolean).join('；') || '—']; }))}`;
  }
  const ab = d.ab;
  return `<h2>诊断结论</h2>${note}<div class="notice">${escapeHtml(ab.lines.join('；') || '样本不足，无法拆解')}</div>${table(['用户', '拆解变化', '主因', '主因贡献', 'B/A 比值'], ab.users.map((u) => [u.user, number(u.total, 1) + '%', u.main.label, number(u.main.contrib, 1) + ' 点', number(u.main.ratio, 3)]))}`;
}

/** 控制信道段（有 650/941 时）：每侧小区一行 + 有判读的用户。 */
function ctrlHtml(c) {
  if (!c || !Object.values(c).some(Boolean)) return '';
  const pct = (v, d = 1) => (v == null ? '—' : number(v, d) + '%');
  const rows = Object.entries(c).filter(([, x]) => x).map(([k, x]) => [k, pct(x.cell.dlFail, 2), pct(x.cell.ulFail, 2), number(x.cell.agg, 1), pct(x.cell.agg16, 0), pct(x.cell.dtxShare, 2), pct(x.cell.agg16Dtx, 0)]);
  const flagged = Object.entries(c).filter(([, x]) => x).flatMap(([k, x]) => { const ref = ctrlRef(x.users); return x.users.map((u) => [k, u, ctrlFlags(u, ref)]).filter(([, , f]) => f.length).map(([k2, u, f]) => [k2, u.user, f.map((y) => y[0]).join('、'), f.map((y) => y[1]).join('；')]); });
  return `<h2>控制信道（T650 / T941）</h2><p class="muted">650/941 原表按用户汇总（按 rnti 挂到 537 用户，剔除系统消息，只看 CCE 申请记录）。</p>${table(['方案', '下行 CCE 申请失败', '上行 CCE 申请失败', 'PDCCH 聚合级别', '聚合 16 占比', '连续 DTX 记录', '其中聚合 16'], rows)}${flagged.length ? table(['方案', '用户', '判读', '依据'], flagged) : '<p class="muted">没有用户触发控制信道判读。</p>'}`;
}

export function buildReportHtml(m) {
  const single = m.mode === 'single';
  const title = single ? '无线 Trace · 单小区分析报告' : '无线 Trace · A/B 分析报告';
  const rate = `${number(m.rate.a)}${single ? '' : ' → ' + number(m.rate.b)}${m.rate.diff != null && !single ? '（' + number(m.rate.diff) + '%）' : ''}`;
  const sources = m.sources.map((x) => [x.side, 'T' + x.trace, x.path, number(x.rows, 0), number(x.quality?.rejectedRows || 0, 0), x.ignored || 0]);
  const choices = m.batches.flatMap((b) => b.traces.map((t) => [b.side, 'T' + t.id, t.selected || '缺少文件', t.candidates.join('；') || '—']));
  const contributions = (m.comparison?.rows || []).map((r) => [r.userId, number(r.rateA), number(r.rateB), number(r.shareA, 1) + '%', number(r.shareB, 1) + '%', number(r.rateContributionPt) + ' pt', number(r.shareContributionPt) + ' pt', number(r.contributionPt) + ' pt']);
  const chartImages = (m.charts || []).map((c) => {
    const image = safeImage(c.image);
    return image ? `<figure><figcaption>${escapeHtml(c.title)}</figcaption><img alt="${escapeHtml(c.title)}" src="${image}"></figure>` : '';
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${title}</title><style>
  *{box-sizing:border-box}body{margin:0;background:#fafafa;color:#1d1d1f;font:14px/1.7 -apple-system,'Microsoft YaHei',system-ui,sans-serif}main{max-width:1280px;margin:32px auto;padding:0 20px}h1{font-size:27px}h2{font-size:19px;margin-top:30px}.muted{color:#6e6e73}.notice{padding:14px 18px;background:#eef6f2;border:1px solid #cfe6db;border-radius:12px}.warn{background:#fff8eb;border-color:#efd9ac}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.card,figure{padding:18px;background:#fff;border:1px solid #d2d2d7;border-radius:12px}.value{font-size:24px;font-weight:700;color:#2563eb}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;background:#fff}th,td{padding:8px 10px;border-bottom:1px solid #e5e7eb;text-align:left;white-space:nowrap}th{background:#f3f4f6}td:nth-child(3){white-space:normal;min-width:160px;overflow-wrap:anywhere}svg{display:block;width:100%;height:120px}svg text{font-size:10px;fill:#6e6e73}.bar{height:9px;background:#f1f3f5;border-radius:5px;margin:8px 0;overflow:hidden}.bar i{display:block;height:100%}figure{margin:12px 0}img{max-width:100%;height:auto}details{padding:12px 0}summary{cursor:pointer}li{margin:6px 0}@media print{body{background:#fff}main{margin:0}details{display:block}.table-wrap{overflow:visible}figure,.card{break-inside:avoid}}@media(max-width:600px){main{padding:0 12px;margin:16px auto}h1{font-size:22px}}
  </style></head><body><main><h1>${title}</h1><p class="muted">工具 v${escapeHtml(m.version)} · 导出时间 ${escapeHtml(m.at)} · 全部内容由本机浏览器生成，图片已内嵌，离线可读。</p>
  <div class="notice${m.status !== 'done' ? ' warn' : ''}"><b>${m.status === 'done' ? '分析已完成' : '分析未完整完成，以下结果需结合缺失数据判断'}</b><div>${escapeHtml(m.batches.map((b) => b.side + '：' + b.label).join('；'))}</div><div>Rate：${escapeHtml(rate)}</div><div>${escapeHtml(m.rateScope)}</div></div>
  <h2>分析范围与口径</h2><p>用户：${escapeHtml(m.users.length ? m.users.join('、') : '小区全部用户')}。列筛选：${escapeHtml(m.filters.join('；') || '无')}。搜索：${escapeHtml(m.search || '无')}。</p><p class="muted">T396 速率是业务量总和除以有效时间总和，覆盖所选用户的全批次记录。T537/T714 指标按当前用户、列筛选与搜索计算。BLER 剔除 DTX；714 指标只代表匹配上且有效的记录。MCS/OLLA 等变化为定位线索，不能单独证明根因。</p>
  <h2>关键指标与分布</h2><p class="muted">CDF 为累计分布；A / 本小区为蓝色，B 为橙色。占比条统一以 100% 为满格。</p><div class="grid">${m.cards.map(cardHtml).join('')}</div>
  ${single ? `<h2>单小区体检</h2><p>已检查：${escapeHtml(m.coverage?.available.join('、') || '无')}。未检查：${escapeHtml(m.coverage?.missing.join('、') || '无')}。样本不足的规则不代表通过。</p>${m.findings.length ? table(['线索', '用户', '规则'], m.findings.map((x) => [x.title, x.users.join('、'), x.rule])) : '<p>当前规则未检出明显异常；这不等于小区健康或所有指标通过。</p>'}<h2>逐用户指标</h2>${table(['用户', 'Rate（T396 全批次）', 'TTI 占比 %', '调度行数', '有效 ACK', 'MCS', 'BLER %', '截包 %', 'OLLA（MCS 阶）'], m.userMetrics.map((u) => [u.user, number(u.rate), number(u.share, 1), number(u.rows, 0), number(u.valid, 0), number(u.mcs), number(u.bler), number(u.trunc), number(u.olla)]))}` : `<h2>全批次速率变化贡献</h2><p>速率变化与占比变化采用两侧中点对称分摊；总贡献相加等于小区相对变化。新增或消失用户归入占比变化。贡献表覆盖全部用户，不受当前列筛选或搜索影响，属于数学分解，不代表因果。仅一侧有数据或 A 小区速率为零时显示“—”。</p>${table(['用户', 'Rate A', 'Rate B', '占比 A', '占比 B', '速率变化贡献', '占比变化贡献', '总贡献'], contributions)}`}
  ${diagnosisHtml(m.diagnosis, single)}
  ${ctrlHtml(m.ctrl)}
  <h2>导出时已显示的图表</h2>${chartImages || '<p class="muted">导出时未显示已生成的图表；上方已包含关键指标分布图。若需时序图，在图表页完成绘图后再次导出。</p>'}${m.chartNotes.length ? `<div class="notice warn">${m.chartNotes.map(escapeHtml).join('<br>')}</div>` : ''}
  <h2>数据来源与质量</h2>${table(['侧', '跟踪', '实际读取路径', '读取行数', '跳过坏行', '未使用后续分片'], sources)}<details><summary>逐文件质量详情</summary>${table(['文件', '质量记录'], m.sources.map((s) => [s.path, JSON.stringify(s.quality || {})]))}</details><h2>读取文件与候选分片</h2>${table(['侧', '跟踪', '本次选中', '扫描到的所有候选文件'], choices)}
  ${m.errors.length ? `<div class="notice warn"><b>未完成项与错误</b><ul>${m.errors.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>` : ''}<p class="muted">本报告保留来源路径与统计结果，请按实际接收对象决定是否分享。它不包含原始 CSV，也不执行脚本或网络请求。</p></main></body></html>`;
}

export async function collectReport() {
  const version = S.dataVersion.value;
  const view = structuredClone(S.view.value);
  const users = [...S.users.value];
  const filters = structuredClone(S.effectiveFilters.value);
  const sides = S.sides.value;
  const comparison = S.t396.value;
  const single = S.mode.value === 'single';
  const model = {
    mode: S.mode.value, version: __APP_VERSION__, at: new Date().toLocaleString('zh-CN'), status: S.run.value?.status,
    users, filters: (view.filters || []).map(describeFilter), search: view.search,
    rate: scopeRate(comparison, users), rateScope: rateScopeLabel(users, view), comparison,
    sources: Object.values(S.sources.value).map((s) => ({ ...s, path: toFullPath(S.dirs[s.side].value?.fullPath || '', s.relPath) })),
    batches: (single ? ['A'] : ['A', 'B']).filter((k) => S.selection.value[k]).map((k) => ({ side: single ? '本小区' : k, label: batchLabel(S.selection.value[k]), traces: Object.entries(S.selection.value[k].traces).map(([id, t]) => ({ id, selected: t.selected?.relPath, candidates: t.candidates.map((f) => f.relPath) })) })),
    errors: [...(S.run.value?.errors || [])], cards: [], findings: [], userMetrics: [], charts: [], chartNotes: [],
  };
  // 图像先截取，保证是点击导出时已显示的图，而不是随后换了条件的图。
  const plots = [...document.querySelectorAll('.chartcard .js-plotly-plot')];
  if (plots.length) {
    const plotly = await loadPlotly();
    for (const el of plots) {
      const title = el.closest('.chartcard').querySelector('h5')?.innerText || '图表';
      try {
        model.charts.push({ title, image: await plotly.toImage(el, { format: 'png', width: 1200, height: Math.max(320, el.clientHeight) }) });
      } catch (err) {
        model.chartNotes.push(`图表“${title}”未能导出：${err.message || err}。可在图表页重试，指标与质量记录已保留。`);
      }
    }
  }
  const stale = () => S.dataVersion.value !== version || S.mode.value !== model.mode || JSON.stringify(S.view.value) !== JSON.stringify(view) || JSON.stringify(S.users.value) !== JSON.stringify(users) || S.running.value;
  if (single && sides.A) {
    const overview = await cellOverview(sides.A, filterSql(filters, sides.A.columns, view.search), stale, { filters, search: view.search });
    if (overview) model.cards = [...overview.cards, { label: '714 匹配率', value: overview.matchRate, unit: '%', n: overview.rows, kind: 'share', digits: 1 }];
    const where = filterSql(view.filters, sides.A.columns, view.search);
    const cell = await cellBasics(sides.A, where);
    const list = joinRates(await userMetrics(sides.A, where), comparison);
    model.findings = findings({ ...cell, rate: comparison?.cellRateA ?? null }, list);
    model.userMetrics = users.length ? list.filter((u) => users.includes(u.user)) : list;
    model.coverage = checkCoverage(sides.A, comparison);
  } else if (Object.values(sides).some(Boolean)) {
    model.cards = await summaryCards(sides, filters, view.search, stale);
  }
  // 诊断结论：与“诊断结论”页签同一套计算
  try {
    if (single && sides.A) {
      const ev = await sideEvidence(sides.A, comparison?.rows, 'A');
      model.diagnosis = { list: ev.list, common: commonCauses(ev.list) };
    } else if (sides.A && sides.B) {
      const ea = await sideEvidence(sides.A, comparison?.rows, 'A');
      const eb = await sideEvidence(sides.B, comparison?.rows, 'B');
      model.diagnosis = { ab: concludeAb(ea.rate, eb.rate, ea.lim, eb.lim) };
    }
  } catch (err) {
    model.chartNotes.push(`诊断结论未能导出：${err.message || err}。其余结果已保留。`);
  }
  model.ctrl = { A: sides.A?.statsCtrl || null, ...(single ? {} : { B: sides.B?.statsCtrl || null }) };
  if (stale()) throw new Error('导出期间分析范围发生变化，本次未保存报告。请等统计更新完后再点导出。');
  return model;
}
