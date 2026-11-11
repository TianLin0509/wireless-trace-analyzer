const FIELDS = {
  cw0SuMcs: ['SU MCS', '', 'SU MCS（OLLA 与功率回退之后、速率匹配之前）'], tb0SchMcs: ['最终 MCS', '', '码字 0 最终调度 MCS；重传行为 28–31（256QAM 表保留给重传的编号）'],
  schRank: ['schRank', '', '调度层数编号：真实数据从 0 起编（0 = 1 层；实测每 RE 比特按 1:2:3:4 增长）'], allocRbNum: ['RB 数', 'RB', '分配的资源块数量'],
  bandCqiCw0: ['CQI', '', '码字 0 的宽带 CQI'], usrschpdschDrbData: ['调度业务量', '', '沿用 CSV 原始单位；截包判据为大于 0 且小于 500'],
  '714_ack0': ['ACK / NACK / DTX', '', '1 ACK、0 NACK、2 DTX（样例注释）。注意：记的是触发本次调度的上一次 HARQ 反馈（重传行带 0/2），不是本行传输的结果（实测）'],
  '714_compOlla_scaled': ['补偿 OLLA', '阶', '原始 compOlla ÷ 1024000；语义与单位待官方确认（样例未注释）'],
  estMcs0: ['CQI 估计 MCS', '阶', 'MCS 调整链第 1 步：由 CQI 估计的 MCS'],
  initAdjMcs0: ['OLLA 调整后 MCS', '阶', 'MCS 调整链第 2 步：叠加 OLLA 外环之后'],
  powerBackMcs0: ['功率回退后 MCS', '阶', 'MCS 调整链第 3 步：功率受限回退之后'],
  rateMtcMcs0: ['速率匹配后 MCS', '阶', 'MCS 调整链第 4 步：按本时隙可用 RE（速率匹配）调整之后'],
  reduceMcs0: ['降阶后 MCS', '阶', 'MCS 调整链第 5 步：降阶保护之后；初传时通常等于最终 MCS'],
  cw0Mcs: ['码字 0 MCS', '阶', '初传时与 tb0SchMcs 相同'],
  waitingData: ['待发数据', '字节', '调度前用户缓存里待发送的数据量；≤ 本次 TB 大小说明本次就能发完（数据受限）'],
  tb0TbByteLength: ['TB 大小', '字节', '码字 0 本次传输块大小'],
  esitimatedRb: ['估算需求 RB', 'RB', '按待发数据与 MCS 估算需要的 RB 数，封顶为全带宽'],
  schErrCode: ['调度错误码', '', '0x0 为成功，其他为失败原因码（十六进制）'],
  userNum: ['待调度用户数', '', '本 TTI 参与调度的用户数'],
  schSuccUserNum: ['调度成功用户数', '', '本 TTI 实际调度成功的用户数'],
  tb0ReTransTimes: ['重传次数', '', '0 = 初传；1 = 第一次重传'],
  tb0AckState: ['上次反馈', '', '触发本次调度的上一次 HARQ 反馈：初传行 1；重传行 0 = NACK、2 = DTX'],
  harqProcNo: ['HARQ 进程号', '', ''],
  mcsTable: ['MCS 表', '', '0 = 64QAM 表，1 = 256QAM 表（256QAM 表下 28–31 为重传专用编号）'],
  suOrMuFlag: ['SU / MU', '', 'SU 单用户、MU 多用户配对'],
  schType: ['调度类型', '', 'DRB 初传；HARQ_DRB 重传；DTX_DRB 因 DTX 重传；DCCH 信令'],
  '714_iblerTarget': ['初传 BLER 目标', '', '原始值 ÷ 102400 为比例（10240 = 10%）'],
  '714_retansNum0': ['反馈对应的传输次数', '', '714 每行是一次反馈：0 = 初传的反馈'],
  '714_mcsCwRankFlter0': ['CQI→MCS 滤波值', '阶', 'CQI 映射到 MCS 后的滤波值'],
  '714_mcsBfCwFlter0': ['滤波 + BF 内环 MCS', '阶', ''],
  '714_wbCqi4Bit0Type1': ['宽带 CQI（714）', '', '0–15'],
  '714_currAdjStep': ['OLLA 本次步长', '', '原始值 ÷ 1024000 为 MCS 阶；ACK 上调、NACK 下调，步长比决定 BLER 目标'],
  '714_mcsOffset0_scaled': ['OLLA 外环累计量', 'MCS 阶', '原始 mcsOffset[0] ÷ 1024000，单位为 MCS 阶（样例注释「外环累计量/1024000」）'],
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
