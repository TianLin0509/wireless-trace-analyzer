// 本机持久化（浏览器 IndexedDB）：视图模板、最近分析、文件夹授权句柄。不经过任何网络。

const DB_NAME = 'trace-ab';
const STORES = ['views', 'recents', 'kv'];
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

export const listAll = async (store) => (await tx(store, 'readonly', (s) => s.getAll())) || [];
export const put = (store, value) => tx(store, 'readwrite', (s) => s.put(value));
export const remove = (store, id) => tx(store, 'readwrite', (s) => s.delete(id));
export const getKv = async (id) => (await tx('kv', 'readonly', (s) => s.get(id)))?.value;
export const setKv = (id, value) => tx('kv', 'readwrite', (s) => s.put({ id, value }));

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/** 视图 = 汇总字段 + 列顺序 + 表格筛选 + 图表字段；名称唯一。 */
export async function saveView(view) {
  const all = await listAll('views');
  const name = String(view.name || '').trim();
  if (!name) throw new Error('视图名称不能为空。');
  if (name.length > 60) throw new Error('视图名称不能超过 60 个字符。');
  if (all.some((v) => v.name === name && v.id !== view.id)) throw new Error(`已存在同名视图：${name}`);
  const record = { ...view, name, id: view.id || uid(), updatedAt: Date.now() };
  await put('views', record);
  return record;
}

const MAX_RECENTS = 12;
export async function addRecent(entry) {
  const all = (await listAll('recents')).sort((a, b) => b.at - a.at);
  const same = all.find((r) => r.signature === entry.signature);
  const record = { ...entry, id: same?.id || uid(), at: Date.now() };
  await put('recents', record);
  for (const old of all.filter((r) => r.id !== record.id).slice(MAX_RECENTS - 1)) await remove('recents', old.id);
  return record;
}

/** 导入旧版本机模板 JSON（merge-column-templates / table-layout-templates / analysis-recipes）。 */
export function convertLegacyTemplates(json) {
  const items = Array.isArray(json) ? json : json.templates || json.recipes || json.items || [];
  const views = [];
  for (const t of items) {
    const name = t.name || t.title;
    if (!name) continue;
    const ws = t.workspace || {};
    const an = ws.analysis || {};
    views.push({
      name: `${name}（旧版导入）`,
      columns537: t.columns_537 || ws.columns?.['537'] || [],
      columns714: t.columns_714 || ws.columns?.['714'] || [],
      columnOrder: t.columns || an.column_order || an.visible_columns || [],
      chartMetrics: an.metrics || [],
      filters: an.filters || [],
      search: an.global_search || '',
    });
  }
  return views;
}
