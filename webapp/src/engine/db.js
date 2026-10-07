// DuckDB-WASM 单例：单线程 eh 版 + 浏览器文件句柄（实测最省内存，文件边读边解析）。
// 所有操作（SQL、注册/释放文件）都经过同一个串行队列，避免并发互相干扰。
import * as duckdb from '@duckdb/duckdb-wasm';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import mvpWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';

let dbPromise = null;
let db = null;
let conn = null;
let queue = Promise.resolve();

const abs = (u) => new URL(u, location.href).href;

export async function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const bundle = await duckdb.selectBundle({
        mvp: { mainModule: abs(mvpWasm), mainWorker: abs(mvpWorker) },
        eh: { mainModule: abs(ehWasm), mainWorker: abs(ehWorker) },
      });
      const worker = new Worker(bundle.mainWorker);
      const instance = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('计算引擎加载超时（60 秒）。请检查网络后刷新页面。')), 60000));
      try {
        await Promise.race([instance.instantiate(bundle.mainModule, bundle.pthreadWorker), timeout]);
      } catch (err) {
        worker.terminate(); // 超时或失败时释放这次的后台线程，重试会新建
        throw err;
      }
      await instance.open({ query: { castBigIntToDouble: true } });
      conn = await instance.connect();
      await conn.query('SET preserve_insertion_order = true');
      db = instance;
      return instance;
    })();
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

/** 把一个操作排进串行队列；前一个失败不会卡住后面的。 */
function serial(fn) {
  const run = queue.then(async () => { await getDb(); return fn(); });
  queue = run.catch(() => {});
  return run;
}

const registered = new Map();

/** 注册一个本地 File，返回 DuckDB 中可读的虚拟文件名。同一 key 重复注册同一文件时直接复用。 */
export function registerFile(key, file) {
  return serial(async () => {
    const name = `${key}.csv`;
    const prev = registered.get(name);
    if (prev === file) return name;
    if (prev) await db.dropFile(name).catch(() => {});
    await db.registerFileHandle(name, file, duckdb.DuckDBDataProtocol.BROWSER_FILEREADER, true);
    registered.set(name, file);
    return name;
  });
}

export function unregisterFile(key) {
  return serial(async () => {
    const name = `${key}.csv`;
    if (!registered.has(name)) return;
    registered.delete(name);
    await db.dropFile(name).catch(() => {});
  });
}

function convert(value) {
  if (typeof value === 'bigint') return Number(value);
  // 128 位整数（DuckDB 对整数求和的结果类型）在 Arrow 里是 4 个 32 位字：按小端拼回普通数字，防止漏加类型转换时显示成数组
  if (value instanceof Uint32Array && value.length === 4) {
    const neg = value[3] & 0x80000000;
    const w = neg ? Array.from(value, (x) => ~x >>> 0) : Array.from(value);
    const n = w[0] + w[1] * 2 ** 32 + w[2] * 2 ** 64 + w[3] * 2 ** 96;
    return neg ? -(n + 1) : n;
  }
  if (value instanceof Date) return value.toISOString();
  return value;
}

/** 串行执行 SQL（单连接），返回普通对象数组。 */
export function query(sql) {
  return serial(async () => {
    const table = await conn.query(sql);
    const fields = table.schema.fields.map((f) => f.name);
    const out = new Array(table.numRows);
    const cols = fields.map((f) => table.getChild(f));
    for (let i = 0; i < table.numRows; i++) {
      const row = {};
      for (let j = 0; j < fields.length; j++) row[fields[j]] = convert(cols[j].get(i));
      out[i] = row;
    }
    return out;
  });
}

export async function exec(sql) {
  await query(sql);
}

export async function scalar(sql) {
  const rows = await query(sql);
  if (!rows.length) return null;
  return Object.values(rows[0])[0];
}

/** 把一条 COPY 语句写出的虚拟文件取回为 Uint8Array；无论成败都清理虚拟文件。 */
export function copyOut(sql, fileName) {
  return serial(async () => {
    try {
      await conn.query(sql);
      return await db.copyFileToBuffer(fileName);
    } finally {
      await db.dropFile(fileName).catch(() => {});
    }
  });
}

export async function memoryUsage() {
  try {
    return Number(await scalar('SELECT sum(memory_usage_bytes)::DOUBLE FROM duckdb_memory()')) || 0;
  } catch {
    return 0;
  }
}

export async function listTables() {
  return (await query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'")).map((r) => r.table_name);
}

export const engineVersion = () => scalar('SELECT version()');
