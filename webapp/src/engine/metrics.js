const FIELDS = {
  cw0SuMcs: ['SU MCS', '', 'SU MCS（OLLA 与功率回退之后、速率匹配之前）'], tb0SchMcs: ['最终 MCS', '', '码字 0 最终调度 MCS；重传行为 28–31（256QAM 表保留给重传的编号）'],
  schRank: ['schRank', '', '调度层数编号：真实数据从 0 起编（0 = 1 层；公司实测每 RE 比特按 1:2:3:4 增长）'], allocRbNum: ['RB 数', 'RB', '分配的资源块数量'],
  bandCqiCw0: ['CQI', '', '码字 0 的宽带 CQI'], usrschpdschDrbData: ['调度业务量', '', '沿用 CSV 原始单位；截包判据为大于 0 且小于 500'],
  '714_ack0': ['ACK / NACK / DTX', '', '1 ACK、0 NACK、2 DTX（公司样例注释）。注意：记的是触发本次调度的上一次 HARQ 反馈（重传行带 0/2），不是本行传输的结果（公司实测）'],
  '714_compOlla_scaled': ['补偿 OLLA', '阶', '原始 compOlla ÷ 1024000；语义与单位待官方确认（公司样例未注释）'],
  '714_mcsOffset0_scaled': ['OLLA 外环累计量', 'MCS 阶', '原始 mcsOffset[0] ÷ 1024000，单位为 MCS 阶（公司 T714 样例注释「外环累计量/1024000」）'],
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
