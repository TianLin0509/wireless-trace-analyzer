// 与旧版 config.py 对齐的默认字段与上限。

export const T396_REQUIRED = ['dlAmbr', 'dlThpVolRmvLastSlot', 'dlThpTimeRmvLastSlot'];

export const DEFAULT_537_COLUMNS = [
  'tti', 'crnti', 'HH:MM:SS', 'frm', 'slotNo', 'ambr', 'usrId', 'schType', 'suOrMuFlag', 'jtMode',
  'cw0SuMcs', 'tb0SchMcs', 'schRank', 'usrschpdschDrbData', 'allocRbNum', 'bandCqiCw0',
];

export const DEFAULT_714_COLUMNS = [
  'crnti', 'HH:MM:SS', 'frm', 'slotNum', 'ack0', 'retansNum0', 'isMuFlag', 'mcsOffset[0]', 'compOlla', 'suRank', 'rankRpt',
];

export const DEFAULT_CHART_METRICS = ['cw0SuMcs', 'tb0SchMcs', 'schRank', 'usrschpdschDrbData'];

/** 已知必为数值的字段：即使文件开头一段全空，也按数值处理。 */
export const KNOWN_NUMERIC = new Set([
  'cw0SuMcs', 'tb0SchMcs', 'schRank', 'usrschpdschDrbData', 'allocRbNum', 'bandCqiCw0', 'jtMode',
  'ack0', 'retansNum0', 'isMuFlag', 'mcsOffset[0]', 'compOlla', 'suRank', 'rankRpt',
  'dlThpVolRmvLastSlot', 'dlThpTimeRmvLastSlot',
]);

export const SCALE_714 = 1024000;
export const MAX_CHART_POINTS = 3000;
export const MAX_CHART_METRICS = 8;
export const MAX_CHART_USERS = 40;
export const MAX_FILTER_UNIQUES = 500;
export const MAX_REJECT_SAMPLES = 20;
export const TRUNCATED_LIMIT = 500;
