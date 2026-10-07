// 全局状态：用 signals 驱动界面。“用户范围”是全局的——左栏选中的用户同时作用于结论、明细和图表。
import { signal, computed } from '@preact/signals';
import { DEFAULT_537_COLUMNS, DEFAULT_714_COLUMNS, DEFAULT_CHART_METRICS } from './engine/config.js';
import { userScope } from './engine/query.js';

export const defaultView = () => ({
  id: null,
  name: '默认视图',
  columns537: [...DEFAULT_537_COLUMNS],
  columns714: [...DEFAULT_714_COLUMNS],
  columnOrder: [],
  hiddenColumns: [],
  filters: [],
  search: '',
  sort: null,
  chartMetrics: [...DEFAULT_CHART_METRICS],
  chartMode: 'split', // split 分图（默认） | overlay 叠加
});

export const page = signal('start'); // start | work | kpi
export const dirs = { A: signal(null), B: signal(null) }; // {rootName, handle?, files, catalog}
export const selection = signal({ A: null, B: null }); // 批次对象
export const run = signal(null); // 流水线状态
export const t396 = signal(null); // compareT396 结果
export const sides = signal({ A: null, B: null }); // 合并表元数据
export const sources = signal({}); // A396 / A537 ... 每个源的读取信息
export const loadedFields = signal(null); // 当前合并表实际读入的汇总字段 {columns537, columns714}
export const users = signal([]); // 全局用户范围（ambr）
export const view = signal(defaultView());
export const tab = signal('sum');
export const tableSide = signal('A');
export const dataVersion = signal(0);
export const toast = signal(null);
export const errorBox = signal(null);
export const kpiState = signal(null);
export const qualityAck = signal(false);

export const ready = computed(() => !!(sides.value.A || sides.value.B));
export const running = computed(() => run.value?.status === 'running');

/** 表格与图表实际使用的筛选 = 视图里的列筛选 + 全局用户范围。 */
export const effectiveFilters = computed(() => {
  const f = [...(view.value.filters || [])];
  if (users.value.length) f.push(userScope(users.value));
  return f;
});

export function showToast(text, ms = 2600) {
  const id = Date.now();
  toast.value = { text, id };
  setTimeout(() => { if (toast.value?.id === id) toast.value = null; }, ms);
}

/** 把技术错误翻译成“现象 + 原因 + 怎么办”。 */
export function showError(title, err, actions = []) {
  const msg = String(err?.message || err || '未知错误');
  const hints = [...actions];
  if (/NotAllowedError|permission/i.test(msg)) hints.push('浏览器没有拿到文件夹读取授权：点击“重新授权”或重新选择文件夹。');
  if (/NotFoundError|could not be found|requested file/i.test(msg)) hints.push('文件可能已被移动、删除或网络盘断开：确认文件仍在原位置后重新扫描。');
  if (/out of memory|memory|allocation/i.test(msg)) hints.push('浏览器内存不足：减少汇总字段，或关闭其他占内存的标签页后重试。');
  if (/缺少汇总连接字段|缺少字段/.test(msg)) hints.push('该文件表头与预期不符：检查是否选错了跟踪号或文件被截断。');
  errorBox.value = { title, message: msg, hints };
}

export function updateView(patch) {
  view.value = { ...view.value, ...patch };
}
