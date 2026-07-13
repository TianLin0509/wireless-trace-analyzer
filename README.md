# 无线外场 Trace A/B 分析台

本项目通过私有 GitHub 仓库增量更新，但所有 CSV 读取、DuckDB 缓存、计算和页面服务都只在本机运行。源 CSV 不会上传到 GitHub。

## 日常使用

首次安装后，项目固定放在 `C:\Users\lintian\wireless-trace-analyzer`。

- 双击 `仅启动.cmd`：不联网更新，直接启动当前本地版本。
- 双击 `更新并启动.cmd`：从 GitHub 仅拉取变化文件，然后启动。
- 双击 `回退上一版.cmd`：回退到上次更新前的提交，然后启动。

默认地址为 `http://127.0.0.1:3004`。启动脚本会在 `%LOCALAPPDATA%\WirelessTraceAnalyzer\venv` 自动建立专用 Python 环境；只有 `requirements.txt` 变化时才会重新同步依赖，不会修改系统 Python 或其他项目环境。

## 数据与隐私

- CSV 路径由用户在页面中分别指定给方案 A/B。
- 缓存位于 `%USERPROFILE%\.wireless_trace_cache\v016`。
- 更新状态位于 `%LOCALAPPDATA%\WirelessTraceAnalyzer`。
- 上述目录均不在 Git 仓库中，`git pull` 不会修改或上传它们。

## 开发验证

```powershell
python -m pip install -r .\requirements-dev.txt
python -m pytest -q
node --check .\wireless_trace_viewer_app\static\app.js
```
