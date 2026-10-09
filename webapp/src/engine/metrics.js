const FIELDS = {
  cw0SuMcs: ['MCS', '', '调度使用的 MCS'], tb0SchMcs: ['tb0 MCS', '', '码字 0 的调度 MCS'],
  schRank: ['Rank', '', '调度传输层数'], allocRbNum: ['RB 数', 'RB', '分配的资源块数量'],
  bandCqiCw0: ['CQI', '', '码字 0 的宽带 CQI'], usrschpdschDrbData: ['调度业务量', '', '沿用 CSV 原始单位；截包判据为大于 0 且小于 500'],
  '714_ack0': ['ACK / NACK / DTX', '', '1 为 ACK、0 为 NACK，其余有效值按 DTX 处理'],
  '714_compOlla_scaled': ['OLLA', 'dB', '原始 compOlla 除以 1024000'],
  '714_mcsOffset0_scaled': ['MCS offset', '', '原始 mcsOffset0 除以 1024000'],
};
export function metricInfo(column) {
  const [label, unit, explanation] = FIELDS[column] || [column, '', 'CSV 原始字段；未配置单位'];
  return { label, unit, explanation, title: label === column ? column : `${label}（${column}）` };
}
export function smoothingWindow(length, setting = 'auto') {
  return setting === 'auto' ? Math.max(1, Math.round(length / 60)) : Math.max(1, Math.min(length || 1, Number(setting) || 1));
}
export function movingAverage(values, window) {
  let sum = 0;
  return values.map((x, i) => {
    sum += x;
    if (i >= window) sum -= values[i - window];
    return sum / Math.min(i + 1, window);
  });
}
