# Trace A/B 分析台 · 网页版

线上地址：https://trace.lt-stockpartner.tech （环境探针：`/probe.html`）

无线外场 T396 / T537 / T714 的 A/B 对比分析。网页文件托管在阿里云，**所有读取与计算都在使用者本机浏览器内完成**：CSV 由浏览器直接从本机或网络盘读取，不上传、不缓存到服务器。页面加载完成后断开网络仍可使用。

## 数据不出本机的保证

- 服务器只提供静态文件，只允许 GET/HEAD，没有任何接收数据的接口。
- 响应头 CSP 的 `connect-src 'self'` 禁止页面向其他站点发送请求。
- 页面只向本站请求两类东西：程序文件，以及每 20 分钟一次、用来检查新版本的 `version.json`。
- 视图模板、最近分析记录保存在浏览器本机 IndexedDB。

## 结构

| 位置 | 职责 |
|---|---|
| `src/engine/scan.js` | 文件名与 ParseResult 目录解析、批次分组、trace_0 优先、同小区匹配（与旧版 catalog.py 一致） |
| `src/engine/fs.js` | 选择文件夹（目录句柄优先，webkitdirectory 兜底） |
| `src/engine/csvsniff.js` | 读文件头几 MB：编码、分隔符、表头、数值列；开头全空的列留待全量复核 |
| `src/engine/ingest.js` | T396 聚合；T537/T714 只读选中列 + 连接键；坏行进质量报告 |
| `src/engine/merge.js` | 537 锚点左连接 714（与旧版 merge_side 一致） |
| `src/engine/query.js` | 明细筛选 / 分页 / 列画像 / TTI 上下文 / 导出 |
| `src/engine/stats.js` | 结论卡片、用户分解、图表取数 |
| `src/engine/t396.js` | T396 A/B 对比与多小区回归雷达 |
| `src/engine/db.js` | DuckDB-WASM 单例与串行执行队列 |
| `src/pipeline.js` | 一键流水线：T396 → 537/714 → 合并；任务串行、失败与取消都清理临时表 |
| `src/store.js` | 全局状态；左栏用户选择是全局范围 |
| `src/persist.js` | 视图、最近分析（IndexedDB），旧版模板导入 |
| `src/ui/` | 起始页、工作台（结论 / 明细 / 图表 / 数据质量）、批量 KPI |

## 开发与验证

```powershell
npm install
npm run build                      # 产物在 dist/
python tools/serve_dist.py 5318    # 本地预览，响应头与线上一致
npx vitest run                     # 单元测试

python tools/gen_sample_data.py <数据目录>/sample --rows 60000                         # 中等规模样例
python tools/gen_sample_data.py <数据目录>/big --rows 500000 --wide 185 --wide714 80 --cells Cell_3 --no-split
python tools/make_dirty.py <数据目录>/sample <数据目录>/dirty                           # 注入格式问题

python tests/e2e_flow.py http://127.0.0.1:5318/ <A目录> <B目录> output/e2e     # 主流程
python tests/e2e_more.py ...                                                   # KPI/字段/筛选/导出/视图/缩放/单方案
python tests/dirty_check.py ...                                                # 坏行与格式异常
python tests/perf_big.py ...                                                   # 50 万行压力测试
python tests/parity_old.py <旧版仓库根目录> <A> <B> Cell_1 output/parity-old.json  # 旧版引擎基准
python tests/parity_web.py <url> <A> <B> Cell_1 output/parity-web.json          # 新版引擎结果
python tests/parity_compare.py output/parity-old.json output/parity-web.json
```

## 部署

部署脚本在本机（不入库，含服务器访问方式）：`deploy_trace_site.py <dist目录>`，`--rollback` 回到上一版。脚本只替换服务器上的站点目录，不重启 Caddy。用户刷新页面即可用上新版；页面开着时每 20 分钟检查一次新版本并提示刷新。
