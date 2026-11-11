// 与旧版 config.py 对齐的默认字段与上限。

export const T396_REQUIRED = ['dlAmbr', 'dlThpVolRmvLastSlot', 'dlThpTimeRmvLastSlot'];

export const DEFAULT_537_COLUMNS = [
  'tti', 'crnti', 'HH:MM:SS', 'frm', 'slotNo', 'ambr', 'usrId', 'schType', 'suOrMuFlag', 'jtMode',
  'cw0SuMcs', 'tb0SchMcs', 'schRank', 'usrschpdschDrbData', 'allocRbNum', 'bandCqiCw0',
];

export const DEFAULT_714_COLUMNS = [
  'crnti', 'HH:MM:SS', 'frm', 'slotNum', 'ack0', 'retansNum0', 'isMuFlag', 'mcsOffset[0]', 'compOlla', 'suRank', 'rankRpt',
];

/** 诊断用字段：文件里有就自动读入（不必在汇总字段里勾选），供速率拆解、链路诊断、事件与时间轴使用。 */
export const DIAG_537_COLUMNS = [
  'schErrCode', 'userNum', 'schSuccUserNum', 'pairNum', 'esitimatedRb', 'waitingData', 'tb0TbByteLength', 'tb1TbByteLength',
  'tb0ReTransTimes', 'harqProcNo', 'estMcs0', 'cw0Mcs', 'initAdjMcs0', 'powerBackMcs0', 'rateMtcMcs0', 'reduceMcs0', 'suRank',
];
export const DIAG_714_COLUMNS = ['iblerTarget', 'ack1', 'harqNo', 'wbCqi4Bit0Type1', 'mcsBfCwFlter0', 'mcsCwRankFlter0', 'currAdjStep'];

export const DEFAULT_CHART_METRICS = ['cw0SuMcs', 'tb0SchMcs', 'schRank', 'usrschpdschDrbData'];

/** 已知必为数值的字段：即使文件开头一段全空，也按数值处理。 */
export const KNOWN_NUMERIC = new Set([
  'cw0SuMcs', 'tb0SchMcs', 'schRank', 'usrschpdschDrbData', 'allocRbNum', 'bandCqiCw0', 'jtMode',
  'ack0', 'retansNum0', 'isMuFlag', 'mcsOffset[0]', 'compOlla', 'suRank', 'rankRpt',
  'dlThpVolRmvLastSlot', 'dlThpTimeRmvLastSlot',
  'userNum', 'schSuccUserNum', 'pairNum', 'esitimatedRb', 'waitingData', 'tb0TbByteLength', 'tb1TbByteLength', 'tb0ReTransTimes',
  'harqProcNo', 'estMcs0', 'cw0Mcs', 'initAdjMcs0', 'powerBackMcs0', 'rateMtcMcs0', 'reduceMcs0', 'suRank',
  'iblerTarget', 'ack1', 'harqNo', 'wbCqi4Bit0Type1', 'mcsBfCwFlter0', 'mcsCwRankFlter0', 'currAdjStep',
]);

export const SCALE_714 = 1024000;
export const MAX_CHART_POINTS = 3000;
export const MAX_CHART_METRICS = 8;
export const MAX_CHART_USERS = 40;
export const MAX_FILTER_UNIQUES = 500;
export const MAX_REJECT_SAMPLES = 20;
export const TRUNCATED_LIMIT = 500;
