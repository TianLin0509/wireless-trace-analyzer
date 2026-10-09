import { useState } from 'preact/hooks';
import * as S from '../store.js';
import { collectReport, buildReportHtml } from '../engine/report.js';

export function ReportButton() {
  const [busy, setBusy] = useState(false);
  const exportReport = async () => {
    setBusy(true);
    try {
      const model = await collectReport();
      const blob = new Blob(['\ufeff' + buildReportHtml(model)], { type: 'text/html;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const now = new Date();
      const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((x) => String(x).padStart(2, '0')).join('');
      const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map((x) => String(x).padStart(2, '0')).join('');
      a.href = url; a.download = `${date}-无线Trace-${model.mode === 'single' ? '单小区' : 'AB对比'}-${time}.html`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      S.showToast(model.chartNotes.length ? '报告已保存在本机；有图表未导出，原因已写进报告。' : '报告已保存在本机，离线可打开。', 5000);
    } catch (err) { S.showError('报告导出失败', err); }
    finally { setBusy(false); }
  };
  return <button class="btn" disabled={busy || S.running.value || (!S.ready.value && !S.t396.value)} onClick={exportReport}>{busy ? '正在生成本地报告…' : '导出报告'}</button>;
}
