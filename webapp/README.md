# Trace A/B 分析台 · 网页版

## v1.5.0 · 2026-10-09

- 保留单小区 / A/B 两种模式、默认分图、trace_0 默认选择及数据本地处理。
- A/B 贡献改为可加总的速率变化贡献与占比变化贡献，用两侧中点对称分摊；全用户总贡献等于小区相对变化。旧的 `impact` 仅保留为兼容旧版的排序分数，页面不再把它叫“小区拖累”。数学贡献不代表因果。
- T396 只有批次内逐用户聚合，无法应用任意 T537 行条件。速率卡、用户页、图表及导出报告明确区分全批次速率和筛选后的其他指标。
- 路径旁显示首次授权、权限有效、需重新授权或选择窗口退路；不承诺授权永久有效。展开文件清单可核对并更换每类跟踪的文件，默认不拼接后续分片；最近分析保留实际选中的分片。
- 单小区关键指标与按用户合并的体检线索前移。每条规则可定位候选明细，返回时恢复原筛选。缺字段或样本不足不显示为“健康”。
- 图表字段补中文解释与单位；叠加用户可选不平滑 / 5 点 / 20 点 / 自动窗口，每条曲线标实际点数。曲线按固定间隔抽样，点采样点可查看其 TTI 上下文，框选 TTI 可带到明细。
- “导出报告”在本机生成自包含 HTML：包含范围、统计口径、指标分布、贡献或用户表、质量记录、来源与分片清单；图表页导出时内嵌已显示的时序 / CDF 图片。图表导出失败会保留其余结果，并在报告中写明原因。报告无脚本、无外部请求，断网可读。
- 修复手机收起用户栏后内容区被零宽网格挤窄的问题：旧版桌面规则 `0 1fr` 在手机隐藏用户栏后仍生效，内容落进第一列。手机明确使用单列，新增实际内容宽度与真实截图检查，防止仅检查“无横向溢出”漏报。

新回归：`tests/20261009-analysis-review.test.js` 覆盖贡献、范围、分片、规则、平滑与报告转义；`tests/20261009-improvements_check.py` 走真实页面操作、下载并断网打开报告、检查手机内容宽度。已有引擎统计口径对照继续保留。

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
