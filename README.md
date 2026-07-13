# 无线外场 Trace A/B 分析台

本工具的 CSV 读取、DuckDB 缓存、计算和页面服务都只在本机运行，源 CSV 不会上传到 GitHub。公司电脑不需要安装或运行 Git，浏览器登录 GitHub 后下载发布包即可。

## 首次部署：下载完整包

1. 在浏览器打开 [GitHub Releases](https://github.com/TianLin0509/wireless-trace-analyzer/releases/latest)。
2. 下载名称以 `-full.zip` 结尾的完整包。
3. 将 ZIP 完整解压到固定目录，例如 `C:\Users\你的用户名\wireless-trace-analyzer`。
4. 双击 `仅启动.cmd`。首次启动会建立专用 Python 环境并安装依赖，之后不会重复安装。

完整包只在首次部署、跨多个版本无法逐个打补丁，或本地文件已被人为修改时使用。

## 后续更新：只替换变更文件

1. 先关闭正在运行的分析台命令行窗口。
2. 双击 `打开更新下载页.cmd`，从 GitHub 下载与当前版本匹配、名称以 `-patch.zip` 结尾的增量包。例如当前为 `v0.16.4`，后续应选择文件名中含 `v0.16.4-to-v0.16.5` 的补丁。
3. 无需解压补丁。双击安装目录中的 `更新并启动.cmd`，在文件选择框中选中刚下载的补丁 ZIP。
4. 更新器会核对起止版本和每个文件的 SHA256，只备份并替换清单中的变化文件；未变化的程序文件、CSV 和缓存都不动。成功后自动启动新版本。

补丁版本不匹配、文件损坏或校验失败时会停止，不会盲目覆盖。若需要撤销最近一次更新，双击 `回退上一版.cmd`，它只恢复上次被更新的文件。

### 从旧版更新器过渡

如果本地仍是 `v0.16.1`，其中的 `更新并启动.cmd` 仍依赖 Git。下载 `v0.16.1-to-v0.16.2-patch.zip` 后先解压该补丁，再双击补丁目录中的 `安装此更新.cmd`。升级到 `v0.16.2` 后，后续补丁均可直接由安装目录中的 `更新并启动.cmd` 选择 ZIP 安装。

## 日常入口

- `仅启动.cmd`：不联网，直接启动当前版本。
- `打开更新下载页.cmd`：用默认浏览器打开 GitHub 最新发布页。
- `更新并启动.cmd`：选择已经下载的增量 ZIP，文件级更新后启动。
- `回退上一版.cmd`：恢复最近一次增量更新前的文件并启动。

默认地址为 `http://127.0.0.1:3004`。专用 Python 环境位于 `%LOCALAPPDATA%\WirelessTraceAnalyzer\venv`；只有 `requirements.txt` 发生变化时才同步依赖，不会修改系统 Python 或其他项目环境。

## v0.16.4 数据分析增强

- 读取数据与数据汇总页增加紧凑的质量摘要，直接展示数据量、字段规模、缓存占用、匹配率、缺失与重复连接键。
- 合并明细点击列名即可打开排序、筛选和统计窗口；数值列可一键按 TTI 升序画图。
- TTI 与 ambr 始终保留在合并结果中，避免用户精简感兴趣列后失去时间轴或用户级分析能力。
- 图表右下角支持拖动调整宽度和高度，并可一键恢复默认尺寸；移动端保留纵向高度调整。

## 数据与隐私

- CSV 路径由用户在页面中分别指定给方案 A/B。
- 缓存位于 `%USERPROFILE%\.wireless_trace_cache\v016`。
- 更新备份位于 `%LOCALAPPDATA%\WirelessTraceAnalyzer\offline-updates`。
- 完整包和增量包都不包含、读取或上传上述 CSV 与缓存目录。

## 开发与发布验证

```powershell
python -m pip install -r .\requirements-dev.txt
python -m pytest -q
node --check .\wireless_trace_viewer_app\static\app.js
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\test_offline_update.ps1
```

发布包由 `tools\build-release-packages.ps1` 生成。Git tag 触发的 GitHub Actions 会在测试通过后自动发布完整包、相邻版本增量包和 SHA256 清单。
