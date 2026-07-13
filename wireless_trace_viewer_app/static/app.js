"use strict";

const state = {
  sessionId: "",
  catalog: null,
  ingest: null,
  schemas: {},
  merge: null,
  t396: null,
  t396ReadyTaskId: "",
  kpiMode: false,
  kpiGroups: [],
  kpiResult: null,
  selectedColumns: { "537": new Set(), "714": new Set() },
  availableUsers: [],
  selectedUsers: new Set(),
  userPickerDraft: new Set(),
  columnFilters: {},
  visibleColumns: new Set(),
  activeUser: "__ALL__",
  activeSide: "A",
  tablePage: 1,
  tableResult: null,
  sortColumn: "",
  sortAscending: true,
  figures: {},
  activeFigure: "",
  lastMetrics: [],
  activeStep: 1,
  sourceCollapsed: false,
  generation: 0,
  taskTokens: { ingest: 0, kpi: 0, merge: 0, plot: 0 },
  plotRenderToken: 0,
  columnMenu: { column: "", profile: null, selectedValues: new Set(), token: 0, search: "" },
};

const $ = (id) => document.getElementById(id);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const MAX_ANALYSIS_USERS = 20;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function formatNumber(value, digits = 3) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  return number.toLocaleString("zh-CN", { maximumFractionDigits: digits });
}

function formatBytes(value) {
  let number = Number(value || 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  while (number >= 1024 && index < units.length - 1) { number /= 1024; index += 1; }
  return `${number.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = label || "处理中...";
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

async function api(url, payload = null, options = {}) {
  const init = { method: payload === null ? "GET" : "POST", ...options };
  if (payload !== null) {
    init.headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    init.body = JSON.stringify(payload);
  }
  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    if (!response.ok) throw new Error(`请求失败：HTTP ${response.status}`);
    return response;
  }
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    const error = new Error(data.error || `请求失败：HTTP ${response.status}`);
    error.payload = data;
    throw error;
  }
  return data;
}

let toastTimer = 0;
function toast(message) {
  const box = $("toast");
  box.textContent = message;
  box.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => box.classList.add("hidden"), 2600);
}

function showError(error, title = "处理失败") {
  const payload = error?.payload || {};
  const diagnosis = payload.diagnosis || error?.diagnosis || { reason: error?.message || String(error), actions: [] };
  $("errorTitle").textContent = title;
  $("errorReason").textContent = diagnosis.reason || error?.message || "未知错误";
  $("errorActions").innerHTML = (diagnosis.actions || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  $("errorDetail").textContent = payload.detail || error?.detail || error?.message || String(error);
  $("errorPanel").classList.remove("hidden");
}

function hideError() { $("errorPanel").classList.add("hidden"); }

function setBadge(id, text, kind) {
  const badge = $(id);
  badge.textContent = text;
  badge.className = `status-badge ${kind}`;
}

function setProgress(prefix, task) {
  const pct = Math.max(0, Math.min(100, Number(task.pct || 0)));
  $(`${prefix}ProgressPct`).textContent = `${Math.round(pct)}%`;
  $(`${prefix}ProgressBar`).style.width = `${pct}%`;
  $(`${prefix}ProgressTitle`).textContent = task.title || "处理中";
  $(`${prefix}ProgressDetail`).textContent = task.detail || "";
}

function batchLabel(batch) {
  const traces = (batch.available_traces || []).map((trace) => `T${trace}`).join(" / ") || "无有效跟踪";
  const contextValue = batch.context_path || batch.context_label || "";
  const context = contextValue ? `${contextValue} · ` : "";
  return `${context}${batch.test_time_short || batch.test_time || "未解析时间"} · ${traces}`;
}

function catalogForSide(side) {
  return state.catalog?.side_catalogs?.[side] || state.catalog || { batches: [] };
}

function renderBatchSelect(select, selected, allowEmptyLabel, side) {
  const batches = catalogForSide(side).batches || [];
  select.innerHTML = `<option value="">${allowEmptyLabel}</option>` + batches.map((batch) => (
    `<option value="${escapeHtml(batch.batch_id)}" title="${escapeHtml(batchPathTitle(side, batch))}">${escapeHtml(batchLabel(batch))}</option>`
  )).join("");
  select.value = selected || "";
  updateBatchSelectTitle(side);
}

function selectedBatch(side, batchId) {
  return (catalogForSide(side).batches || []).find((batch) => String(batch.batch_id) === String(batchId));
}

function batchPathTitle(side, batch) {
  if (!batch) return catalogForSide(side).root || state.catalog?.roots?.[side] || "";
  const paths = [];
  if (batch.context_label) paths.push(`目录层级: ${batch.context_label}`);
  if (batch.context_path) paths.push(`ParseResult: ${batch.context_path}`);
  for (const trace of ["396", "537", "714"]) {
    const selected = batch.traces?.[trace]?.selected;
    if (selected?.path) paths.push(`T${trace}: ${selected.path}`);
  }
  return paths.join("\n");
}

function updateBatchSelectTitle(side) {
  const select = $(`scheme${side}`);
  if (!select) return;
  select.title = batchPathTitle(side, selectedBatch(side, select.value));
}

function renderSchemeScanStats(side) {
  const catalog = catalogForSide(side);
  const root = catalog.root || state.catalog?.roots?.[side] || "";
  const stats = $(`scheme${side}Stats`);
  const batchField = $(`schemeBatchField${side}`);
  const batchCount = Number(catalog.batch_count || 0);
  const fileCount = Number(catalog.file_count || 0);
  batchField.classList.toggle("hidden", batchCount === 0);
  stats.title = root;
  if (!root) {
    stats.textContent = "未指定目录";
  } else if (!fileCount) {
    stats.textContent = "未找到 T396 / T537 / T714 CSV";
  } else {
    const ignored = (catalog.batches || []).reduce((sum, batch) => sum + Number(batch.ignored_fragment_count || 0), 0);
    stats.textContent = `${fileCount} 个 CSV · ${batchCount} 个批次${ignored ? ` · 忽略 ${ignored} 个后续分片` : ""}`;
  }
}

function updateStartAvailability() {
  $("startBtn").disabled = !state.sessionId || (!$("schemeA").value && !$("schemeB").value);
}

function renderBatchSummary() {
  const values = { A: $("schemeA").value, B: $("schemeB").value };
  const parts = [];
  for (const side of ["A", "B"]) {
    updateBatchSelectTitle(side);
    const batch = selectedBatch(side, values[side]);
    if (!batch) {
      parts.push(`<span class="batch-pill"><b>方案 ${side}</b>：空</span>`);
      continue;
    }
    const context = batch.context_path || batch.context_label || "当前目录";
    parts.push(`<span class="batch-pill" title="${escapeHtml(batchPathTitle(side, batch))}"><span class="batch-context">方案 ${side} · ${escapeHtml(context)}</span><span class="batch-meta">${escapeHtml(batch.test_time_short || batch.test_time || "未解析时间")} · ${batch.available_count} 个跟踪</span></span>`);
  }
  $("batchSummary").innerHTML = parts.join("");
  $("batchSummary").classList.remove("hidden");
  updateStartAvailability();
}

function kpiGroupLabel(batchA, batchB, index) {
  const contextA = batchA?.context_label || "";
  const contextB = batchB?.context_label || "";
  const timeA = batchA?.test_time_short || batchA?.test_time || "";
  const timeB = batchB?.test_time_short || batchB?.test_time || "";
  if (contextA && contextA === contextB) {
    if (timeA && timeA === timeB) return `${contextA} · ${timeA}`;
    return `${contextA} · A ${timeA || "空"} / B ${timeB || "空"}`;
  }
  if (contextA || contextB) {
    const sideA = contextA ? `A ${contextA}${timeA ? ` · ${timeA}` : ""}` : "A 空";
    const sideB = contextB ? `B ${contextB}${timeB ? ` · ${timeB}` : ""}` : "B 空";
    return `${sideA} / ${sideB}`;
  }
  return `对比组 ${index}`;
}

function createKpiGroup(index, batchA = null, batchB = null) {
  return {
    id: `kpi-${Date.now()}-${index}-${Math.random().toString(16).slice(2, 8)}`,
    label: kpiGroupLabel(batchA, batchB, index),
    a_batch_id: batchA?.batch_id || "",
    b_batch_id: batchB?.batch_id || "",
  };
}

function kpiBatchOptions(side, selected) {
  const empty = `<option value="">方案 ${side} 留空</option>`;
  const options = (catalogForSide(side).batches || []).map((batch) => (
    `<option value="${escapeHtml(batch.batch_id)}" title="${escapeHtml(batchPathTitle(side, batch))}" ${String(selected || "") === String(batch.batch_id) ? "selected" : ""}>${escapeHtml(batchLabel(batch))}</option>`
  )).join("");
  return empty + options;
}

function renderKpiGroups() {
  const rows = state.kpiGroups || [];
  $("kpiGroupRows").innerHTML = rows.map((group) => `
    <div class="kpi-group-row" data-kpi-id="${escapeHtml(group.id)}">
      <label class="kpi-cell"><span>名称</span><input type="text" data-kpi-field="label" value="${escapeHtml(group.label)}" maxlength="80"></label>
      <label class="kpi-cell"><span>方案 A 批次</span><select data-kpi-field="a_batch_id">${kpiBatchOptions("A", group.a_batch_id)}</select></label>
      <label class="kpi-cell"><span>方案 B 批次</span><select data-kpi-field="b_batch_id">${kpiBatchOptions("B", group.b_batch_id)}</select></label>
      <button class="kpi-remove-btn" type="button" data-kpi-remove title="删除此对比组" aria-label="删除此对比组">×</button>
    </div>
  `).join("") || `<div class="empty-state small">点击“添加对比组”，或按目录顺序自动配对。</div>`;
  $("kpiGroupCount").textContent = `${rows.length} 组`;
  $("startKpiBtn").disabled = rows.length === 0;
}

function seedKpiGroups() {
  const batchA = selectedBatch("A", $("schemeA").value);
  const batchB = selectedBatch("B", $("schemeB").value);
  state.kpiGroups = (batchA || batchB) ? [createKpiGroup(1, batchA, batchB)] : [];
  renderKpiGroups();
}

function autoPairKpiGroups() {
  const batchesA = catalogForSide("A").batches || [];
  const batchesB = catalogForSide("B").batches || [];
  const count = Math.min(30, Math.max(batchesA.length, batchesB.length));
  state.kpiGroups = Array.from({ length: count }, (_, index) => createKpiGroup(index + 1, batchesA[index], batchesB[index]));
  renderKpiGroups();
  toast(`已按目录顺序生成 ${count} 组 KPI 对比。`);
}

function addKpiGroup() {
  if (state.kpiGroups.length >= 30) { toast("KPI 概览单次最多 30 组。"); return; }
  state.kpiGroups.push(createKpiGroup(state.kpiGroups.length + 1));
  renderKpiGroups();
}

function setKpiMode(active) {
  state.kpiMode = Boolean(active);
  $("kpiPanel").classList.toggle("hidden", !state.kpiMode);
  $("t396Panel").classList.toggle("hidden", state.kpiMode);
  $("kpiResults").classList.toggle("hidden", !state.kpiMode || !state.kpiResult);
  $("kpiModeBtn").classList.toggle("active", state.kpiMode);
  $("kpiModeBtn").textContent = state.kpiMode ? "退出 KPI 概览" : "KPI 概览模式";
  if (state.kpiMode) {
    if (!state.kpiGroups.length) seedKpiGroups();
    goStep(1);
  }
}

function kpiSideLabel(reference) {
  if (!reference) return "空";
  const context = reference.context_label || "当前目录";
  const time = reference.test_time_short || reference.test_time || "未解析时间";
  return `${context} · ${time}${reference.missing ? " · 缺少 T396" : ""}`;
}

function renderKpiResults() {
  const result = state.kpiResult;
  if (!result) { $("kpiResults").classList.add("hidden"); return; }
  const summary = result.summary || {};
  $("kpiStats").innerHTML = statItems([
    ["对比组", formatNumber(summary.group_count || 0, 0)],
    ["去重 T396", formatNumber(summary.source_count || 0, 0)],
    ["提升 / 下降", `${summary.improved || 0} / ${summary.declined || 0}`],
    ["平均差异", summary.average_diff_pct == null ? "-" : `${formatNumber(summary.average_diff_pct, 3)}%`],
  ]);
  const groups = result.groups || [];
  $("kpiSummaryTable").innerHTML = `<table><thead><tr><th>对比组</th><th>方案 A 批次</th><th>方案 B 批次</th><th>A 小区 Rate</th><th>B 小区 Rate</th><th>B-A 差异</th><th>A/B 用户</th></tr></thead><tbody>${groups.map((group) => {
    const comparison = group.comparison || {};
    const diff = Number(comparison.diff_pct);
    const cls = Number.isFinite(diff) ? (diff > 0 ? "rate-up" : diff < 0 ? "rate-down" : "") : "";
    return `<tr><td><b>${escapeHtml(group.label)}</b></td><td title="${escapeHtml(group.A?.context_path || group.A?.path || "")}">${escapeHtml(kpiSideLabel(group.A))}</td><td title="${escapeHtml(group.B?.context_path || group.B?.path || "")}">${escapeHtml(kpiSideLabel(group.B))}</td><td>${formatNumber(comparison.cell_rate_a, 6)}</td><td>${formatNumber(comparison.cell_rate_b, 6)}</td><td class="${cls}">${comparison.diff_pct == null ? "-" : `${formatNumber(comparison.diff_pct, 3)}%`}</td><td>${comparison.users_a || 0} / ${comparison.users_b || 0}</td></tr>`;
  }).join("")}</tbody></table>`;
  $("kpiUserDetails").innerHTML = groups.map((group) => {
    const comparison = group.comparison || {};
    const rows = comparison.rows || [];
    return `<details><summary><b>${escapeHtml(group.label)} · 用户级 Rate</b><span>${rows.length} 个用户</span></summary><div class="data-table-wrap"><table><thead><tr><th>ambr</th><th>Rate A</th><th>Rate B</th><th>B-A 差异</th><th>Time A</th><th>Time B</th></tr></thead><tbody>${rows.slice(0, 500).map((row) => {
      const diff = Number(row.diff_pct);
      const cls = Number.isFinite(diff) ? (diff > 0 ? "rate-up" : diff < 0 ? "rate-down" : "") : "";
      return `<tr><td class="mono">${escapeHtml(row.user_id)}</td><td>${formatNumber(row.rate_a, 6)}</td><td>${formatNumber(row.rate_b, 6)}</td><td class="${cls}">${row.diff_pct == null ? "-" : `${formatNumber(row.diff_pct, 3)}%`}</td><td>${formatNumber(row.sum_time_a, 3)}</td><td>${formatNumber(row.sum_time_b, 3)}</td></tr>`;
    }).join("")}</tbody></table></div></details>`;
  }).join("");
  $("kpiResults").classList.remove("hidden");
}

async function startKpiOverview() {
  if (!state.sessionId) { toast("请先扫描目录。"); return; }
  const groups = state.kpiGroups.map((group, index) => ({
    id: group.id,
    label: String(group.label || `对比组 ${index + 1}`).trim(),
    a_batch_id: group.a_batch_id || null,
    b_batch_id: group.b_batch_id || null,
  }));
  if (!groups.length || groups.some((group) => !group.a_batch_id && !group.b_batch_id)) {
    toast("每个 KPI 对比组至少选择一个 A 或 B 批次。");
    return;
  }
  hideError();
  setBusy($("startKpiBtn"), true, "分析中...");
  $("readEmpty").classList.add("hidden");
  $("readProgressArea").classList.remove("hidden");
  $("kpiResults").classList.add("hidden");
  setBadge("readStateBadge", "KPI 读取中", "running");
  setStepEnabled(2, false);
  setStepEnabled(3, false);
  state.ingest = null;
  state.kpiResult = null;
  state.t396ReadyTaskId = "";
  try {
    const start = await api("/api/task/start", { action: "kpi396", session_id: state.sessionId, groups });
    const result = await pollTask(start.task_id, "kpi", { progress: renderReadTask });
    state.ingest = result;
    state.kpiResult = result;
    setProgress("read", { pct: 100, title: "KPI 分析完成", detail: `${result.groups?.length || 0} 组 A/B 已完成 T396 对比。` });
    setBadge("readStateBadge", "KPI 完成", "ready");
    renderKpiResults();
    toast("多组 KPI 概览已生成；未读取 T537/T714。 ");
    pollMemoryStatus();
  } catch (error) {
    if (error.superseded) return;
    setBadge("readStateBadge", "KPI 失败", "error");
    showError(error, "KPI 概览失败");
  } finally {
    setBusy($("startKpiBtn"), false);
  }
}

async function scanDirectory() {
  const pathA = $("pathAInput").value.trim();
  const pathB = $("pathBInput").value.trim();
  if (!pathA && !pathB) { toast("请至少输入方案 A 或方案 B 的文件夹路径。"); return; }
  hideError();
  setBusy($("scanBtn"), true, "扫描中...");
  $("swapSchemesBtn").disabled = true;
  $("startBtn").disabled = true;
  $("scanMessage").textContent = "正在并行扫描方案 A / B 的 396、537、714 文件...";
  try {
    const data = await api("/api/scan", { path_a: pathA, path_b: pathB, recursive: $("recursiveInput").checked });
    state.generation += 1;
    Object.keys(state.taskTokens).forEach((key) => { state.taskTokens[key] += 1; });
    state.sessionId = data.session_id;
    state.catalog = data.catalog;
    state.ingest = null;
    state.schemas = {};
    state.merge = null;
    state.t396 = null;
    state.t396ReadyTaskId = "";
    state.kpiResult = null;
    state.kpiGroups = [];
    state.availableUsers = [];
    state.selectedUsers.clear();
    state.userPickerDraft.clear();
    state.activeUser = "__ALL__";
    state.columnFilters = {};
    state.visibleColumns = new Set();
    state.lastMetrics = [];
    state.figures = {};
    state.activeFigure = "";
    renderReadInsights();
    renderMergeInsights();
    renderAnalysisUserPicker();
    setAnalysisUserPickerOpen(false);
    renderBatchSelect($("schemeA"), data.selection?.A, "方案 A 留空", "A");
    renderBatchSelect($("schemeB"), data.selection?.B, "方案 B 留空", "B");
    renderSchemeScanStats("A");
    renderSchemeScanStats("B");
    $("toggleSourceBtn").classList.remove("hidden");
    $("kpiModeBtn").disabled = false;
    renderBatchSummary();
    seedKpiGroups();
    setKpiMode(false);
    const sideA = catalogForSide("A");
    const sideB = catalogForSide("B");
    $("scanMessage").textContent = `扫描完成：A ${sideA.file_count || 0} 个文件 / ${sideA.batch_count || 0} 个批次；B ${sideB.file_count || 0} 个文件 / ${sideB.batch_count || 0} 个批次。`;
    toast("A/B 目录扫描完成，已选择各目录中的最新批次。");
    pollMemoryStatus();
  } catch (error) {
    $("scanMessage").textContent = `扫描失败：${error.message}`;
    showError(error, "扫描失败");
  } finally {
    setBusy($("scanBtn"), false);
    $("swapSchemesBtn").disabled = false;
  }
}

async function swapSchemeDirectories() {
  const pathA = $("pathAInput").value;
  const pathB = $("pathBInput").value;
  if (!pathA.trim() && !pathB.trim()) { toast("A/B 路径均为空，无法互换。"); return; }
  $("pathAInput").value = pathB;
  $("pathBInput").value = pathA;
  toast("A/B 路径已互换，正在重新扫描。");
  await scanDirectory();
}

function toggleSource(force) {
  state.sourceCollapsed = typeof force === "boolean" ? force : !state.sourceCollapsed;
  $("sourceBody").classList.toggle("hidden", state.sourceCollapsed);
  $("sourceSection").classList.toggle("collapsed", state.sourceCollapsed);
  $("toggleSourceBtn").textContent = state.sourceCollapsed ? "展开" : "收起";
  $("toggleSourceBtn").setAttribute("aria-expanded", String(!state.sourceCollapsed));
}

function setStepEnabled(step, enabled) {
  const button = document.querySelector(`.step[data-step="${step}"]`);
  if (!button) return;
  button.disabled = !enabled;
  if (enabled && step < state.activeStep) button.classList.add("complete");
}

function goStep(step) {
  const button = document.querySelector(`.step[data-step="${step}"]`);
  if (!button || button.disabled) return;
  state.activeStep = step;
  $$(".step").forEach((item) => {
    const value = Number(item.dataset.step);
    item.classList.toggle("active", value === step);
    item.classList.toggle("complete", value < step && !item.disabled);
  });
  $$(".step-panel").forEach((panel) => panel.classList.remove("active"));
  $(`step${step}`).classList.add("active");
  window.setTimeout(() => $(`step${step}`).scrollIntoView({ behavior: "smooth", block: "start" }), 30);
  if (step === 3) window.setTimeout(resizeVisiblePlot, 50);
}

function renderReadTask(task) {
  setProgress("read", task);
  if (task.partial?.phase === "t396_ready" && state.t396ReadyTaskId !== task.task_id) {
    state.t396ReadyTaskId = task.task_id;
    state.t396 = task.partial.t396 || {};
    if (!state.kpiMode) renderT396();
    toast("T396 速率已生成，T537/T714 正在继续读取。");
  }
  const rows = Object.entries(task.files || {}).sort(([left], [right]) => left.localeCompare(right)).map(([key, file]) => {
    const pct = Math.max(0, Math.min(100, Number(file.pct || 0)));
    const status = file.status === "ready" ? "完成" : file.status === "error" ? "失败" : file.status === "reading" ? "读取中" : "排队";
    const side = file.side === "KPI" ? "KPI" : (file.side || key[0]);
    return `<tr><td title="${escapeHtml(file.path || file.name || "")}">${escapeHtml(file.name || key)}</td><td class="mono">${escapeHtml(side)} / T${escapeHtml(file.trace_id || key.slice(1))}</td><td><div class="mini-progress"><i style="width:${pct}%"></i></div></td><td class="mono">${formatNumber(file.rows || 0, 0)}</td><td>${status}</td></tr>`;
  }).join("");
  $("readFileRows").innerHTML = rows || `<tr><td colspan="5">正在建立任务...</td></tr>`;
}

async function pollTask(taskId, taskKind, handlers = {}) {
  const token = ++state.taskTokens[taskKind];
  const started = Date.now();
  while (token === state.taskTokens[taskKind]) {
    if (Date.now() - started > 2 * 60 * 60 * 1000) throw new Error("任务超过 2 小时，已停止前端等待。后端数据不会被删除。");
    const task = await api(`/api/task/status/${taskId}`);
    handlers.progress?.(task);
    if (task.status === "done") return task.result || {};
    if (task.status === "error") {
      const error = new Error(task.error || task.detail || "后端任务失败");
      error.payload = { diagnosis: task.diagnosis, detail: task.traceback, error: task.error };
      throw error;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 450));
  }
  const error = new Error("任务已被新的操作替换。");
  error.superseded = true;
  throw error;
}

async function startAnalysis() {
  if (!state.sessionId) { toast("请先扫描目录。"); return; }
  const selection = { A: $("schemeA").value || null, B: $("schemeB").value || null };
  if (!selection.A && !selection.B) { toast("方案 A/B 不能同时为空。"); return; }
  if (!state.catalog?.side_catalogs && selection.A && selection.A === selection.B) { toast("方案 A/B 不能选择同一个测试时间。"); return; }
  setKpiMode(false);
  hideError();
  setBusy($("startBtn"), true, "读取中...");
  $("readEmpty").classList.add("hidden");
  $("readProgressArea").classList.remove("hidden");
  setBadge("readStateBadge", "读取中", "running");
  setStepEnabled(2, false);
  setStepEnabled(3, false);
  state.ingest = null;
  state.merge = null;
  state.schemas = {};
  state.t396 = null;
  state.t396ReadyTaskId = "";
  state.kpiResult = null;
  state.selectedColumns = { "537": new Set(), "714": new Set() };
  renderReadInsights();
  renderMergeInsights();
  goStep(1);
  toggleSource(true);
  try {
    const start = await api("/api/task/start", { action: "ingest", session_id: state.sessionId, selection });
    const result = await pollTask(start.task_id, "ingest", { progress: renderReadTask });
    state.ingest = result;
    state.schemas = result.schemas || {};
    state.t396 = result.t396 || {};
    state.t396ReadyTaskId = start.task_id;
    setProgress("read", { pct: 100, title: "读取完成", detail: "全部可用跟踪已写入磁盘缓存。" });
    setBadge("readStateBadge", "读取完成", "ready");
    renderColumnConfig();
    renderT396();
    renderReadInsights();
    renderMergeInsights();
    setStepEnabled(2, true);
    goStep(2);
    toast("读取完成，请确认汇总字段。");
    pollMemoryStatus();
  } catch (error) {
    if (error.superseded) return;
    setBadge("readStateBadge", "读取失败", "error");
    showError(error, "数据读取失败");
  } finally {
    setBusy($("startBtn"), false);
  }
}

function selectedColumnCount(trace) {
  const schema = state.schemas?.[trace] || {};
  $(`count${trace}`).textContent = `${state.selectedColumns[trace].size} / ${(schema.columns || []).length}`;
}

function renderColumnList(trace) {
  const schema = state.schemas?.[trace] || {};
  const query = $(`search${trace}`).value.trim().toLowerCase();
  const columns = (schema.columns || []).filter((column) => !query || String(column).toLowerCase().includes(query));
  const box = $(`columns${trace}`);
  box.innerHTML = columns.map((column) => (
    `<label class="check-item" title="${escapeHtml(column)}"><input type="checkbox" data-trace="${trace}" data-column="${escapeHtml(column)}" ${state.selectedColumns[trace].has(column) ? "checked" : ""}><span>${escapeHtml(column)}</span></label>`
  )).join("") || `<p class="muted">没有匹配字段。</p>`;
  selectedColumnCount(trace);
}

function renderColumnConfig() {
  for (const trace of ["537", "714"]) {
    const defaults = state.schemas?.[trace]?.default_columns || [];
    state.selectedColumns[trace] = new Set(defaults);
    renderColumnList(trace);
  }
  renderMergeInsights();
}

function bulkColumns(trace, mode) {
  const schema = state.schemas?.[trace] || {};
  const values = mode === "default" ? (schema.default_columns || []) : mode === "all" ? (schema.columns || []) : [];
  state.selectedColumns[trace] = new Set(values);
  renderColumnList(trace);
  renderMergeInsights();
}

function statItems(items) {
  return items.map(([label, value, title = ""]) => `<div class="stat-item" title="${escapeHtml(title || value)}"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join("");
}

function briefItems(items) {
  return items.map(([label, value, title = ""]) => `<div class="brief-metric" title="${escapeHtml(title || value)}"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join("");
}

function sourceSide(sourceKey, source) {
  return String(source?.side || source?.scheme || sourceKey?.[0] || "").toUpperCase();
}

function sourceTrace(sourceKey, source) {
  return String(source?.trace_id || String(sourceKey || "").slice(1));
}

function renderReadInsights() {
  const sources = state.ingest?.sources || {};
  const entries = Object.entries(sources);
  const box = $("readInsights");
  if (!entries.length) { box.classList.add("hidden"); return; }
  const totalRows = entries.reduce((sum, [, source]) => sum + Number(source.rows || 0), 0);
  const csvBytes = entries.reduce((sum, [, source]) => sum + Number(source.size || 0), 0);
  const cacheBytes = entries.reduce((sum, [, source]) => sum + Number(source.database_bytes || 0), 0);
  const fields537 = Number(state.schemas?.["537"]?.columns?.length || 0);
  const fields714 = Number(state.schemas?.["714"]?.columns?.length || 0);
  $("readInsightMetrics").innerHTML = briefItems([
    ["已读取数据源", `${entries.length} 个`],
    ["累计数据行", formatNumber(totalRows, 0)],
    ["CSV / 磁盘缓存", `${formatBytes(csvBytes)} / ${formatBytes(cacheBytes)}`],
    ["字段规模", `T537 ${fields537} · T714 ${fields714}`],
  ]);

  const notes = [];
  for (const side of ["A", "B"]) {
    const sideEntries = entries.filter(([key, source]) => sourceSide(key, source) === side);
    if (!sideEntries.length) { notes.push(`方案 ${side} 为空`); continue; }
    const traces = new Set(sideEntries.map(([key, source]) => sourceTrace(key, source)));
    const missing = ["396", "537", "714"].filter((trace) => !traces.has(trace));
    notes.push(`方案 ${side} ${missing.length ? `缺少 T${missing.join(" / T")}` : "三类跟踪齐全"}`);
  }
  for (const trace of ["537", "714"]) {
    const columnsA = new Set(sources[`A${trace}`]?.columns || []);
    const columnsB = new Set(sources[`B${trace}`]?.columns || []);
    if (!columnsA.size || !columnsB.size) continue;
    const difference = new Set([...columnsA].filter((column) => !columnsB.has(column)).concat([...columnsB].filter((column) => !columnsA.has(column))));
    notes.push(`T${trace} A/B 字段${difference.size ? `相差 ${difference.size} 个` : "一致"}`);
  }
  const largest = entries.reduce((best, current) => Number(current[1].rows || 0) > Number(best?.[1]?.rows || -1) ? current : best, null);
  if (largest) notes.push(`最大数据源 ${largest[0]}：${formatNumber(largest[1].rows, 0)} 行`);
  $("readInsightNote").textContent = notes.join(" · ");
  box.classList.remove("hidden");
}

function renderMergeInsights() {
  const box = $("mergeInsights");
  const schema537 = state.schemas?.["537"] || {};
  if (!(schema537.columns || []).length) { box.classList.add("hidden"); return; }

  if (!state.merge) {
    const sources = state.ingest?.sources || {};
    const availableSides = ["A", "B"].filter((side) => sources[`${side}537`]);
    const rowScope = $("limitRowsCheck").checked
      ? `前 ${formatNumber(Math.max(1, Number($("rowLimitInput").value || 100000)), 0)} 行`
      : "全量";
    $("mergeInsightMetrics").innerHTML = briefItems([
      ["T537 已选字段", `${state.selectedColumns["537"].size} / ${(schema537.columns || []).length}`],
      ["T714 已选字段", `${state.selectedColumns["714"].size} / ${(state.schemas?.["714"]?.columns || []).length}`],
      ["T537 锚点范围", rowScope],
      ["可汇总方案", availableSides.length ? availableSides.join(" / ") : "无 T537"],
    ]);
    const missing714 = availableSides.filter((side) => !sources[`${side}714`]);
    $("mergeInsightNote").textContent = missing714.length
      ? `方案 ${missing714.join(" / ")} 缺少 T714，对应链路字段将标记为 NaN；tti、ambr 与连接键会自动保留。`
      : "tti、ambr 与连接键会自动保留；T714 字段添加 714_ 前缀，未匹配行标记为 NaN。";
    box.classList.remove("hidden");
    return;
  }

  const sides = state.merge.sides || {};
  const available = ["A", "B"].filter((side) => sides[side]);
  const totalNan = available.reduce((sum, side) => sum + Number(sides[side].nan_rows || 0), 0);
  const duplicateKeys = available.reduce((sum, side) => sum + Number(sides[side].duplicate_714_keys || 0), 0);
  const matchText = available.map((side) => `${side} ${formatNumber(sides[side].match_rate, 2)}%`).join(" · ") || "-";
  $("mergeInsightMetrics").innerHTML = briefItems([
    ["714 匹配率", matchText],
    ["未匹配锚点行", formatNumber(totalNan, 0)],
    ["重复连接键", formatNumber(duplicateKeys, 0)],
    ["输出 / 数值字段", `${(state.merge.common_columns || []).length} / ${(state.merge.numeric_columns || []).length}`],
  ]);
  const notes = [];
  for (const side of available) {
    const current = sides[side];
    if (!current.has_714) notes.push(`方案 ${side} 无 T714，链路字段均为 NaN`);
    else if (Number(current.nan_rows || 0) > 0) notes.push(`方案 ${side} 有 ${formatNumber(current.nan_rows, 0)} 行未匹配`);
    if (Number(current.duplicate_714_keys || 0) > 0) notes.push(`方案 ${side} 有 ${formatNumber(current.duplicate_714_keys, 0)} 组重复连接键，取原始首行`);
  }
  $("mergeInsightNote").textContent = notes.length ? notes.join(" · ") : "连接键唯一，当前 T714 数据已全部匹配。";
  box.classList.remove("hidden");
}

function renderT396() {
  const data = state.t396 || {};
  $("t396Stats").innerHTML = statItems([
    ["A 小区 Rate", formatNumber(data.cell_rate_a, 6)],
    ["B 小区 Rate", formatNumber(data.cell_rate_b, 6)],
    ["B-A 差异", data.diff_pct == null ? "-" : `${formatNumber(data.diff_pct, 3)}%`],
  ]);
  const rows = data.rows || [];
  if (!rows.length) {
    $("t396Table").innerHTML = `<div class="empty-state small">当前方案没有可用的 T396 聚合结果。</div>`;
    $("handoffUsersBtn").disabled = true;
    return;
  }
  $("t396Table").innerHTML = `<table><thead><tr><th></th><th>ambr</th><th>Rate A</th><th>Rate B</th><th>差异</th></tr></thead><tbody>${rows.slice(0, 500).map((row) => {
    const diff = Number(row.diff_pct);
    const cls = Number.isFinite(diff) ? (diff > 0 ? "rate-up" : diff < 0 ? "rate-down" : "") : "";
    return `<tr><td><input type="checkbox" class="t396-user-check" value="${escapeHtml(row.user_id)}"></td><td class="mono">${escapeHtml(row.user_id)}</td><td>${formatNumber(row.rate_a, 6)}</td><td>${formatNumber(row.rate_b, 6)}</td><td class="${cls}">${row.diff_pct == null ? "-" : `${formatNumber(row.diff_pct, 3)}%`}</td></tr>`;
  }).join("")}</tbody></table>`;
  $("handoffUsersBtn").disabled = true;
}

function handoffT396Users() {
  const users = $$(".t396-user-check:checked").map((item) => item.value);
  if (!users.length) { toast("请先勾选至少一个 T396 用户。"); return; }
  state.columnFilters.ambr = { column: "ambr", op: "in", value: users };
  state.selectedUsers = new Set(users.map(String));
  state.userPickerDraft = new Set(state.selectedUsers);
  state.activeUser = users[0];
  renderAnalysisUserPicker();
  renderUserTabs();
  if (state.merge) {
    goStep(3);
    showAnalysisTab("table");
    renderFilterChips();
    markPlotsStale();
    queryTable(1);
    toast(`已将 ${users.length} 个用户写入 ambr 列筛选。`);
  } else {
    toast(`已保存 ${users.length} 个用户；汇总完成后将直接带入分析。`);
  }
}

async function startMerge() {
  const columns537 = Array.from(state.selectedColumns["537"]);
  const columns714 = Array.from(state.selectedColumns["714"]);
  if (!columns537.length) { toast("请至少选择一个 T537 字段。"); return; }
  const rowLimit = $("limitRowsCheck").checked ? Math.max(1, Number($("rowLimitInput").value || 100000)) : 0;
  hideError();
  setBusy($("mergeBtn"), true, "合并中...");
  $("mergeProgress").classList.remove("hidden");
  setBadge("mergeStateBadge", "汇总中", "running");
  setStepEnabled(3, false);
  state.merge = null;
  renderMergeInsights();
  try {
    const start = await api("/api/task/start", {
      action: "merge", session_id: state.sessionId, columns_537: columns537, columns_714: columns714, row_limit: rowLimit,
    });
    const result = await pollTask(start.task_id, "merge", { progress: (task) => setProgress("merge", task) });
    state.merge = result;
    setProgress("merge", { pct: 100, title: "汇总完成", detail: "A/B 汇总表已写入 DuckDB。" });
    setBadge("mergeStateBadge", "汇总完成", "ready");
    renderMergeInsights();
    renderMergeStats();
    state.visibleColumns = new Set(defaultVisibleColumns());
    state.lastMetrics = (result.default_metrics || []).slice(0, 4);
    renderColumnVisibilityOptions();
    updateVisibleColumnCount();
    await loadAnalysisUsers();
    renderMetricOptions();
    renderUserTabs();
    renderFilterChips();
    setStepEnabled(3, true);
    goStep(3);
    showAnalysisTab("table");
    await queryTable(1);
    toast("数据汇总完成，点击列名即可排序、筛选或按 TTI 画图。");
    pollMemoryStatus();
  } catch (error) {
    if (error.superseded) return;
    setBadge("mergeStateBadge", "汇总失败", "error");
    showError(error, "数据汇总失败");
  } finally {
    setBusy($("mergeBtn"), false);
  }
}

function renderMergeStats() {
  const sides = state.merge?.sides || {};
  const a = sides.A || {};
  const b = sides.B || {};
  $("mergeStats").innerHTML = statItems([
    ["A 锚点行", formatNumber(a.anchor_rows, 0)],
    ["A 714 匹配", a.anchor_rows == null ? "-" : `${formatNumber(a.match_rate, 2)}%`],
    ["A 未匹配", formatNumber(a.nan_rows, 0)],
    ["B 锚点行", formatNumber(b.anchor_rows, 0)],
    ["B 714 匹配", b.anchor_rows == null ? "-" : `${formatNumber(b.match_rate, 2)}%`],
    ["B 未匹配", formatNumber(b.nan_rows, 0)],
  ]);
}

const operatorLabels = {
  eq: "=", eq_num: "=", contains: "包含", gt: ">", gte: "≥", lt: "<", lte: "≤",
  between: "区间", not_null: "非空", is_null: "为空", in: "取值",
};

function tableFilters() {
  return Object.values(state.columnFilters || {}).map((item) => ({ ...item }));
}

function plotFilters() {
  const filters = tableFilters();
  if (state.activeUser === "__ALL__") return filters;
  return filters.filter((item) => item.column !== "ambr").concat([
    { column: "ambr", op: "eq", value: state.activeUser },
  ]);
}

function syncUsersFromAmbrFilter() {
  const filter = state.columnFilters?.ambr;
  let users = [];
  if (filter?.op === "in" && Array.isArray(filter.value)) users = filter.value;
  else if (filter?.op === "eq" || filter?.op === "eq_num") users = [filter.value];
  state.selectedUsers = new Set(users.map(String).filter(Boolean).slice(0, MAX_ANALYSIS_USERS));
  state.userPickerDraft = new Set(state.selectedUsers);
  const sorted = sortedAnalysisUsers(state.selectedUsers);
  state.activeUser = sorted[0] || "__ALL__";
  renderAnalysisUserPicker();
}

function sortedAnalysisUsers(values = state.selectedUsers) {
  return Array.from(values || []).map(String).sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
}

async function loadAnalysisUsers() {
  if (!state.sessionId || !state.merge) {
    state.availableUsers = [];
    renderAnalysisUserPicker();
    return;
  }
  let data;
  try {
    data = await api(`/api/session/${state.sessionId}/filter-options`, { column: "ambr" });
  } catch (error) {
    state.availableUsers = [];
    renderAnalysisUserPicker();
    toast(`用户选项加载失败：${error.message}`);
    return;
  }
  state.availableUsers = Array.from(new Set((data.options?.ambr || []).map(String).filter(Boolean)));
  const valid = new Set(state.availableUsers);
  state.selectedUsers = new Set(sortedAnalysisUsers(state.selectedUsers).filter((user) => valid.has(user)).slice(0, MAX_ANALYSIS_USERS));
  state.userPickerDraft = new Set(state.selectedUsers);
  if (state.activeUser !== "__ALL__" && !state.selectedUsers.has(state.activeUser)) {
    state.activeUser = sortedAnalysisUsers()[0] || "__ALL__";
  }
  renderAnalysisUserPicker();
}

function filteredAnalysisUsers() {
  const query = ($("analysisUserSearch")?.value || "").trim().toLowerCase();
  return state.availableUsers.filter((user) => !query || user.toLowerCase().includes(query));
}

function renderAnalysisUserOptions() {
  const box = $("analysisUserOptions");
  if (!box) return;
  const users = filteredAnalysisUsers();
  box.innerHTML = users.map((user) => `<label class="analysis-user-option" title="ambr ${escapeHtml(user)}"><input type="checkbox" class="analysis-user-check" value="${escapeHtml(user)}" ${state.userPickerDraft.has(user) ? "checked" : ""}><span>${escapeHtml(user)}</span></label>`).join("") || `<p class="muted" style="padding:8px;">没有匹配的 ambr。</p>`;
  $("analysisUserDraftCount").textContent = `已选 ${state.userPickerDraft.size} / ${MAX_ANALYSIS_USERS}`;
}

function renderAnalysisUserPicker() {
  const button = $("analysisUserPickerBtn");
  if (!button) return;
  const count = state.selectedUsers.size;
  button.disabled = !state.merge || state.availableUsers.length === 0;
  $("analysisUserPickerLabel").textContent = !state.merge
    ? "等待数据汇总"
    : !state.availableUsers.length
      ? "汇总数据没有 ambr"
      : count
        ? `已选择 ${count} 个用户`
        : "选择分析用户（ambr）";
  renderAnalysisUserOptions();
}

function setAnalysisUserPickerOpen(open) {
  const menu = $("analysisUserPickerMenu");
  const button = $("analysisUserPickerBtn");
  if (!menu || !button || (open && button.disabled)) return;
  if (open) {
    state.userPickerDraft = new Set(state.selectedUsers);
    $("analysisUserSearch").value = "";
    renderAnalysisUserOptions();
  }
  menu.classList.toggle("hidden", !open);
  button.setAttribute("aria-expanded", String(open));
}

function selectVisibleAnalysisUsers() {
  const next = new Set(state.userPickerDraft);
  for (const user of filteredAnalysisUsers()) {
    if (next.size >= MAX_ANALYSIS_USERS) break;
    next.add(user);
  }
  state.userPickerDraft = next;
  renderAnalysisUserOptions();
  if (filteredAnalysisUsers().length > MAX_ANALYSIS_USERS) toast(`一次最多分析 ${MAX_ANALYSIS_USERS} 个用户。`);
}

async function applyAnalysisUsers() {
  state.selectedUsers = new Set(sortedAnalysisUsers(state.userPickerDraft).slice(0, MAX_ANALYSIS_USERS));
  const users = sortedAnalysisUsers();
  if (!users.includes(state.activeUser)) state.activeUser = users[0] || "__ALL__";
  renderAnalysisUserPicker();
  renderUserTabs();
  markPlotsStale();
  setAnalysisUserPickerOpen(false);
  toast(users.length ? `已选择 ${users.length} 个用户，当前显示 ambr ${state.activeUser}。` : "已切换为小区全量分析。");
  if (state.lastMetrics.length) await startPlot();
}

function renderUserTabs() {
  const users = sortedAnalysisUsers();
  if (state.activeUser !== "__ALL__" && !state.selectedUsers.has(state.activeUser)) state.activeUser = "__ALL__";
  const values = ["__ALL__", ...users];
  const html = values.map((user) => `<button type="button" data-user="${escapeHtml(user)}" class="${user === state.activeUser ? "active" : ""}">${user === "__ALL__" ? "小区全量" : `ambr ${escapeHtml(user)}`}</button>`).join("");
  for (const id of ["userTabs", "chartUserTabs"]) if ($(id)) $(id).innerHTML = html;
}

function filterText(item) {
  if (!item) return "";
  if (item.op === "in") {
    const values = Array.isArray(item.value) ? item.value.map(String) : [];
    const preview = values.slice(0, 3).join(", ");
    return `${item.column}：${preview}${values.length > 3 ? ` 等 ${values.length} 项` : ""}`;
  }
  if (item.op === "between") return `${item.column}：${item.value} ~ ${item.value2}`;
  if (["is_null", "not_null"].includes(item.op)) return `${item.column}：${operatorLabels[item.op]}`;
  return `${item.column} ${operatorLabels[item.op] || item.op} ${item.value ?? ""}`;
}

function renderFilterChips() {
  const filters = tableFilters();
  $("activeFilterChips").innerHTML = filters.length
    ? filters.map((item) => `<span class="filter-chip active-column">${escapeHtml(filterText(item))}<button type="button" data-filter-column="${escapeHtml(item.column)}" aria-label="清除 ${escapeHtml(item.column)} 筛选">×</button></span>`).join("")
    : `<span class="muted">点击任意列名进行排序、筛选或按 TTI 画图。</span>`;
  $("clearTableFiltersBtn").disabled = filters.length === 0 && !$("tableSearch").value.trim();
  if (state.tableResult) renderMergedTable(state.tableResult);
}

function markPlotsStale() {
  state.figures = {};
  state.activeFigure = "";
  state.plotRenderToken += 1;
  $("figureTabs").innerHTML = "";
  $("analysisPlot").innerHTML = `<div class="empty-state">条件已变化，选择字段后重新生成图表。</div>`;
  $("metricSummaryTable").innerHTML = `<div class="empty-state">条件已变化，重新生成图表后显示统计。</div>`;
}

async function removeColumnFilter(column) {
  delete state.columnFilters[column];
  renderFilterChips();
  markPlotsStale();
  await queryTable(1);
}

async function clearAllTableConditions() {
  state.columnFilters = {};
  $("tableSearch").value = "";
  state.sortColumn = "";
  state.sortAscending = true;
  renderFilterChips();
  markPlotsStale();
  closeColumnMenu();
  await queryTable(1);
}

function renderMetricOptions() {
  const query = $("metricSearch").value.trim().toLowerCase();
  const metrics = (state.merge?.common_columns || []).filter((metric) => !query || metric.toLowerCase().includes(query));
  $("metricOptions").innerHTML = metrics.map((metric) => `<label class="check-item" title="${escapeHtml(metric)}"><input type="checkbox" class="metric-check" value="${escapeHtml(metric)}" ${state.lastMetrics.includes(metric) ? "checked" : ""}><span>${escapeHtml(metric)}</span></label>`).join("") || `<p class="muted">没有可绘图字段。</p>`;
  updatePlotSelectionUi();
}

function updatePlotSelectionUi() {
  $("selectedMetricCount").textContent = String(state.lastMetrics.length);
  $("quickPlotBtn").disabled = state.lastMetrics.length === 0;
  if (state.tableResult) renderMergedTable(state.tableResult);
}

function togglePlotColumn(column, force) {
  const selected = state.lastMetrics.includes(column);
  const next = typeof force === "boolean" ? force : !selected;
  if (next && !selected) {
    if (state.lastMetrics.length >= 8) { toast("一次最多选择 8 个绘图字段。"); return; }
    state.lastMetrics.push(column);
  } else if (!next && selected) {
    state.lastMetrics = state.lastMetrics.filter((item) => item !== column);
  }
  renderMetricOptions();
}

function renderMetricSummary(rows) {
  if (!rows?.length) {
    $("metricSummaryTable").innerHTML = `<div class="empty-state">暂无统计结果。</div>`;
    return;
  }
  const sideSummary = (row, side) => row.kind === "类别"
    ? `样本 ${formatNumber(row[`${side}_count`], 0)} · 唯一值 ${formatNumber(row[`${side}_unique`], 0)} · Top ${row[`${side}_top`] ?? "-"} (${formatNumber(row[`${side}_top_ratio`], 2)}%)`
    : `样本 ${formatNumber(row[`${side}_count`], 0)} · 均值 ${formatNumber(row[`${side}_mean`], 4)} · P50 ${formatNumber(row[`${side}_p50`], 4)} · P90 ${formatNumber(row[`${side}_p90`], 4)}`;
  $("metricSummaryTable").innerHTML = `<table><thead><tr><th>字段</th><th>类型</th><th>方案 A</th><th>方案 B</th></tr></thead><tbody>${rows.map((row) => `<tr><td class="mono">${escapeHtml(row.metric ?? "-")}</td><td>${escapeHtml(row.kind ?? "-")}</td><td>${escapeHtml(sideSummary(row, "A"))}</td><td>${escapeHtml(sideSummary(row, "B"))}</td></tr>`).join("")}</tbody></table>`;
}

async function startPlot() {
  if (!state.merge) return;
  const metrics = state.lastMetrics.slice(0, 8);
  if (!metrics.length) { toast("请至少选择一个绘图指标。"); return; }
  state.lastMetrics = metrics;
  const generation = state.generation;
  hideError();
  setBusy($("plotBtn"), true, "生成中...");
  $("quickPlotBtn").disabled = true;
  $("plotProgress").classList.remove("hidden");
  try {
    const start = await api("/api/task/start", {
      action: "plot", session_id: state.sessionId, metrics, filters: plotFilters(),
      global_search: $("tableSearch").value.trim(),
    });
    const result = await pollTask(start.task_id, "plot", { progress: (task) => setProgress("plot", task) });
    if (generation !== state.generation) return;
    state.figures = result.figures || {};
    state.activeFigure = Object.keys(state.figures)[0] || "";
    renderFigureTabs();
    renderMetricSummary(result.summary_rows || []);
    const scopeLabel = state.activeUser !== "__ALL__"
      ? `ambr ${state.activeUser}`
      : "小区全量";
    setProgress("plot", { pct: 100, title: "图表已生成", detail: `当前对象：${scopeLabel}` });
    if ($("analysisCharts").classList.contains("active")) renderActiveFigure();
    toast("图表已更新。");
  } catch (error) {
    if (error.superseded) return;
    showError(error, "图表生成失败");
  } finally {
    setBusy($("plotBtn"), false);
    updatePlotSelectionUi();
  }
}

async function quickPlotFromTable() {
  if (!state.lastMetrics.length) { toast("请先在列菜单中加入绘图字段。"); return; }
  renderMetricOptions();
  showAnalysisTab("charts");
  await startPlot();
}

function renderFigureTabs() {
  const keys = Object.keys(state.figures);
  $("figureTabs").innerHTML = keys.map((key) => `<button type="button" data-figure="${escapeHtml(key)}" class="${key === state.activeFigure ? "active" : ""}">${escapeHtml(key)}</button>`).join("");
  if (!keys.length) $("analysisPlot").innerHTML = `<div class="empty-state">当前筛选没有可绘制数据。</div>`;
}

function renderActiveFigure() {
  if (!$("analysisCharts").classList.contains("active")) return;
  const figure = state.figures[state.activeFigure];
  if (!figure) return;
  const plot = $("analysisPlot");
  const figureKey = state.activeFigure;
  const renderToken = ++state.plotRenderToken;
  if (plot.classList.contains("js-plotly-plot")) Plotly.purge(plot);
  plot.innerHTML = "";
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    if (renderToken !== state.plotRenderToken || state.activeFigure !== figureKey || !$("analysisCharts").classList.contains("active")) return;
    const layout = typeof structuredClone === "function"
      ? structuredClone(figure.layout || {})
      : JSON.parse(JSON.stringify(figure.layout || {}));
    layout.autosize = true;
    delete layout.width;
    delete layout.height;
    if (window.matchMedia("(max-width: 820px)").matches) {
      layout.showlegend = false;
      const title = typeof layout.title === "string" ? { text: layout.title } : { ...(layout.title || {}) };
      title.font = { ...(title.font || {}), size: 15 };
      title.x = 0.5;
      title.xanchor = "center";
      layout.title = title;
      layout.annotations = (layout.annotations || []).map((annotation) => ({
        ...annotation,
        font: { ...(annotation.font || {}), size: 11 },
      }));
      layout.margin = { ...(layout.margin || {}), l: 48, r: 18, t: 78, b: 48 };
    }
    Plotly.newPlot(plot, figure.data || [], layout, {
      responsive: true,
      displaylogo: false,
      modeBarButtonsToRemove: ["lasso2d", "select2d"],
    }).then(() => Plotly.Plots.resize(plot));
  }));
}

function resizeVisiblePlot() {
  if ($("analysisCharts").classList.contains("active") && state.activeFigure && $("analysisPlot").data) {
    Plotly.Plots.resize($("analysisPlot"));
  }
}

function resetPlotSize() {
  const frame = $("plotResizeFrame");
  frame.style.removeProperty("width");
  frame.style.removeProperty("height");
  window.setTimeout(resizeVisiblePlot, 0);
}

let plotResizeState = null;
function beginPlotResize(event) {
  if (event.button !== 0) return;
  const frame = $("plotResizeFrame");
  const rect = frame.getBoundingClientRect();
  plotResizeState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    width: rect.width,
    height: rect.height,
  };
  event.currentTarget.setPointerCapture?.(event.pointerId);
  document.body.classList.add("plot-resizing");
  event.preventDefault();
}

function movePlotResize(event) {
  if (!plotResizeState || event.pointerId !== plotResizeState.pointerId) return;
  const frame = $("plotResizeFrame");
  const mobile = window.matchMedia("(max-width: 820px)").matches;
  if (!mobile) {
    const maxWidth = Math.max(280, frame.parentElement.getBoundingClientRect().width);
    const minWidth = Math.min(420, maxWidth);
    const width = Math.max(minWidth, Math.min(maxWidth, plotResizeState.width + event.clientX - plotResizeState.startX));
    frame.style.width = `${Math.round(width)}px`;
  }
  const height = Math.max(320, Math.min(1600, plotResizeState.height + event.clientY - plotResizeState.startY));
  frame.style.height = `${Math.round(height)}px`;
  resizeVisiblePlot();
  event.preventDefault();
}

function endPlotResize(event) {
  if (!plotResizeState || event.pointerId !== plotResizeState.pointerId) return;
  plotResizeState = null;
  document.body.classList.remove("plot-resizing");
  resizeVisiblePlot();
}

function showAnalysisTab(name) {
  $$("[data-analysis-tab]").forEach((button) => button.classList.toggle("active", button.dataset.analysisTab === name));
  for (const [tab, id] of [["overview", "analysisOverview"], ["charts", "analysisCharts"], ["table", "analysisTable"]]) {
    $(id).classList.toggle("active", tab === name);
  }
  if (name === "charts") window.setTimeout(() => { renderActiveFigure(); window.setTimeout(resizeVisiblePlot, 40); }, 20);
  else state.plotRenderToken += 1;
  if (name === "table") window.setTimeout(() => queryTable(state.tablePage), 20);
}

function mergedColumns() { return state.merge?.common_columns || []; }

function defaultVisibleColumns() {
  const available = new Set(mergedColumns());
  const preferred = [
    "tti", "crnti", "HH:MM:SS", "frm", "slotNo", "ambr", "usrId", "schType",
    "suOrMuFlag", "jtMode", "cw0SuMcs", "tb0SchMcs", "schRank",
    "usrschpdschDrbData", "allocRbNum", "bandCqiCw0", "714_匹配状态",
    "714_候选行数", "714_ack0", "714_retansNum0", "714_isMuFlag",
    "714_mcsOffset0_scaled", "714_compOlla_scaled",
  ];
  const result = preferred.filter((column) => available.has(column));
  return result.length ? result : mergedColumns().slice(0, 24);
}

function updateVisibleColumnCount() {
  $("visibleColumnCount").textContent = `${state.visibleColumns.size}/${mergedColumns().length}`;
}

function renderColumnVisibilityOptions() {
  const query = $("columnVisibilitySearch").value.trim().toLowerCase();
  const columns = mergedColumns().filter((column) => !query || column.toLowerCase().includes(query));
  $("visibleColumnOptions").innerHTML = columns.map((column) => `<label class="check-item" title="${escapeHtml(column)}"><input type="checkbox" class="visible-column-check" value="${escapeHtml(column)}" ${state.visibleColumns.has(column) ? "checked" : ""}><span>${escapeHtml(column)}</span></label>`).join("") || `<p class="muted">没有匹配字段。</p>`;
  updateVisibleColumnCount();
}

function setColumnVisibilityOpen(open) {
  $("columnVisibilityMenu").classList.toggle("hidden", !open);
  $("columnVisibilityBtn").setAttribute("aria-expanded", String(open));
  if (open) {
    closeColumnMenu();
    renderColumnVisibilityOptions();
    window.setTimeout(() => $("columnVisibilitySearch").focus(), 0);
  }
}

async function setVisibleColumns(columns) {
  const values = columns.filter((column) => mergedColumns().includes(column));
  if (!values.length) { toast("至少保留一个显示列。"); return; }
  state.visibleColumns = new Set(values);
  renderColumnVisibilityOptions();
  await queryTable(1);
}

function positionColumnMenu(anchor) {
  const menu = $("columnMenu");
  if (!anchor || menu.classList.contains("hidden")) return;
  const rect = anchor.isConnected ? anchor.getBoundingClientRect() : state.columnMenu.anchorRect;
  if (!rect) return;
  const width = menu.offsetWidth || 380;
  const height = menu.offsetHeight || 500;
  const left = Math.max(12, Math.min(window.innerWidth - width - 12, rect.right - width));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - 12) top = Math.max(12, rect.top - height - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function closeColumnMenu() {
  state.columnMenu.token += 1;
  state.columnMenu.column = "";
  state.columnMenu.profile = null;
  state.columnMenu.anchor = null;
  state.columnMenu.anchorRect = null;
  $("columnMenu").classList.add("hidden");
}

async function openColumnMenu(column, anchor) {
  setColumnVisibilityOpen(false);
  const active = state.columnFilters[column];
  state.columnMenu.column = column;
  state.columnMenu.profile = null;
  state.columnMenu.anchor = anchor;
  state.columnMenu.anchorRect = anchor.getBoundingClientRect();
  state.columnMenu.search = "";
  state.columnMenu.selectedValues = new Set(active?.op === "in" && Array.isArray(active.value) ? active.value.map(String) : []);
  const token = ++state.columnMenu.token;
  $("columnMenu").classList.remove("hidden");
  $("columnMenu").innerHTML = `<div class="column-menu-head"><div class="column-menu-title"><strong>${escapeHtml(column)}</strong><span>正在读取列信息</span></div><button type="button" class="column-menu-close" data-column-action="close" aria-label="关闭">×</button></div><div class="column-menu-loading">正在统计当前条件下的列信息...</div>`;
  positionColumnMenu(anchor);
  try {
    const profile = await api(`/api/session/${state.sessionId}/column-profile`, {
      side: state.activeSide,
      column,
      filters: tableFilters(),
      global_search: $("tableSearch").value.trim(),
      value_search: "",
    });
    if (token !== state.columnMenu.token || state.columnMenu.column !== column) return;
    state.columnMenu.profile = profile;
    renderColumnMenu();
  } catch (error) {
    if (token !== state.columnMenu.token) return;
    $("columnMenu").innerHTML = `<div class="column-menu-head"><div class="column-menu-title"><strong>${escapeHtml(column)}</strong><span>读取失败</span></div><button type="button" class="column-menu-close" data-column-action="close" aria-label="关闭">×</button></div><div class="column-menu-loading">${escapeHtml(error.message)}</div>`;
    positionColumnMenu(anchor);
  }
}

async function refreshColumnProfile(valueSearch) {
  const column = state.columnMenu.column;
  if (!column) return;
  const token = ++state.columnMenu.token;
  state.columnMenu.search = valueSearch;
  try {
    const profile = await api(`/api/session/${state.sessionId}/column-profile`, {
      side: state.activeSide,
      column,
      filters: tableFilters(),
      global_search: $("tableSearch").value.trim(),
      value_search: valueSearch,
    });
    if (token !== state.columnMenu.token || state.columnMenu.column !== column) return;
    state.columnMenu.profile = profile;
    renderColumnMenu(true);
  } catch (error) {
    showError(error, "列取值读取失败");
  }
}

function renderColumnMenu(refocusSearch = false) {
  const profile = state.columnMenu.profile;
  const column = state.columnMenu.column;
  if (!profile || !column) return;
  const isSelected = state.lastMetrics.includes(column);
  const canPlotByTti = Boolean(profile.is_numeric && column !== "tti" && mergedColumns().includes("tti"));
  const quickPlotTitle = canPlotByTti
    ? `按 TTI 升序绘制 ${column}`
    : profile.is_numeric
      ? "当前汇总结果缺少 tti，无法生成 TTI 序列"
      : "当前列不是数值字段，不能作为折线图纵轴";
  const stats = [
    ["当前行", formatNumber(profile.row_count, 0)],
    ["唯一值", formatNumber(profile.distinct_count, 0)],
    ["空值", formatNumber(profile.null_count, 0)],
  ];
  if (profile.is_numeric) stats.push(
    ["最小", formatNumber(profile.min, 4)],
    ["P50", formatNumber(profile.p50, 4)],
    ["最大", formatNumber(profile.max, 4)],
  );
  const values = profile.values || [];
  const valueRows = values.map((item) => `<label class="column-value-item" title="${escapeHtml(item.value)}"><input type="checkbox" class="column-value-check" value="${escapeHtml(item.value)}" ${state.columnMenu.selectedValues.has(String(item.value)) ? "checked" : ""}><span>${escapeHtml(item.value)}</span><small>${formatNumber(item.count, 0)}</small></label>`).join("") || `<p class="muted" style="padding:8px;">没有匹配取值。</p>`;
  const conditionHtml = profile.is_numeric
    ? `<div class="column-condition-row"><select id="columnNumericOperator" aria-label="数值条件"><option value="eq_num">等于</option><option value="gt">大于</option><option value="gte">大于等于</option><option value="lt">小于</option><option value="lte">小于等于</option></select><input id="columnConditionValue" type="number" step="any" placeholder="数值"><button type="button" data-column-action="apply-number">应用</button></div><div class="column-condition-row range"><input id="columnRangeMin" type="number" step="any" placeholder="最小值"><input id="columnRangeMax" type="number" step="any" placeholder="最大值"><button type="button" data-column-action="apply-range">区间</button></div>`
    : `<div class="column-condition-row"><select id="columnTextOperator" aria-label="文本条件"><option value="contains">包含</option><option value="eq">完全等于</option></select><input id="columnConditionValue" type="text" placeholder="输入文本"><button type="button" data-column-action="apply-text">应用</button></div>`;
  $("columnMenu").innerHTML = `
    <div class="column-menu-head"><div class="column-menu-title"><strong title="${escapeHtml(column)}">${escapeHtml(column)}</strong><span>${profile.is_identifier ? "标识字段" : profile.is_numeric ? "数值字段" : "类别字段"}</span></div><button type="button" class="column-menu-close" data-column-action="close" aria-label="关闭">×</button></div>
    <div class="column-profile-grid">${stats.map(([label, value]) => `<div class="column-profile-item"><span>${label}</span><b title="${escapeHtml(value)}">${escapeHtml(value)}</b></div>`).join("")}</div>
    <button type="button" class="column-quick-plot" data-column-action="plot-tti" title="${escapeHtml(quickPlotTitle)}" ${canPlotByTti ? "" : "disabled"}>按 TTI 升序画图</button>
    <div class="column-menu-section"><h4>排序与分析</h4><div class="column-action-grid"><button type="button" data-column-action="sort-asc">升序排列</button><button type="button" data-column-action="sort-desc">降序排列</button><button type="button" class="${isSelected ? "active" : ""}" data-column-action="toggle-plot">${isSelected ? "移出绘图" : "加入绘图"}</button><button type="button" data-column-action="hide">隐藏此列</button></div></div>
    <div class="column-menu-section"><h4>条件筛选</h4>${conditionHtml}<div class="column-action-grid"><button type="button" data-column-action="only-null">仅看空值</button><button type="button" data-column-action="not-null">排除空值</button></div></div>
    <div class="column-menu-section"><div class="column-value-head"><h4>按取值筛选</h4><div class="column-value-actions"><button type="button" data-column-action="select-visible-values">全选显示</button><button type="button" data-column-action="clear-values">清空选择</button></div></div><input id="columnValueSearch" class="small-input" type="search" value="${escapeHtml(state.columnMenu.search)}" placeholder="搜索当前列取值"><div class="column-value-list">${valueRows}</div>${profile.has_more ? `<p class="column-menu-hint">当前只加载前 500 个取值，请搜索缩小范围；筛选仍在完整数据上执行。</p>` : ""}<button type="button" class="primary-btn full-width" style="margin-top:7px;" data-column-action="apply-values">仅看选中值</button></div>
    <div class="column-menu-footer"><button type="button" data-column-action="clear-filter">清除此列条件</button><button type="button" data-column-action="close">完成</button></div>`;
  positionColumnMenu(state.columnMenu.anchor);
  if (refocusSearch) {
    const input = $("columnValueSearch");
    window.setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 0);
  }
}

async function applyColumnFilter(column, filter) {
  state.columnFilters[column] = { column, ...filter };
  if (column === "ambr") syncUsersFromAmbrFilter();
  renderUserTabs();
  renderFilterChips();
  markPlotsStale();
  closeColumnMenu();
  await queryTable(1);
}

async function handleColumnAction(action) {
  const column = state.columnMenu.column;
  if (!column) return;
  if (action === "close") { closeColumnMenu(); return; }
  if (action === "sort-asc" || action === "sort-desc") {
    state.sortColumn = column;
    state.sortAscending = action === "sort-asc";
    closeColumnMenu();
    await queryTable(1);
    return;
  }
  if (action === "plot-tti") {
    if (!state.columnMenu.profile?.is_numeric || column === "tti") { toast("请选择一个数值字段作为纵轴。"); return; }
    if (!mergedColumns().includes("tti")) { toast("当前汇总结果缺少 tti，请重新汇总。"); return; }
    state.lastMetrics = [column];
    renderMetricOptions();
    closeColumnMenu();
    showAnalysisTab("charts");
    await startPlot();
    return;
  }
  if (action === "toggle-plot") { togglePlotColumn(column); renderColumnMenu(); return; }
  if (action === "hide") {
    const next = Array.from(state.visibleColumns).filter((item) => item !== column);
    closeColumnMenu();
    await setVisibleColumns(next);
    return;
  }
  if (action === "clear-filter") { closeColumnMenu(); await removeColumnFilter(column); return; }
  if (action === "only-null") { await applyColumnFilter(column, { op: "is_null" }); return; }
  if (action === "not-null") { await applyColumnFilter(column, { op: "not_null" }); return; }
  if (action === "select-visible-values") {
    (state.columnMenu.profile?.values || []).forEach((item) => state.columnMenu.selectedValues.add(String(item.value)));
    renderColumnMenu();
    return;
  }
  if (action === "clear-values") { state.columnMenu.selectedValues.clear(); renderColumnMenu(); return; }
  if (action === "apply-values") {
    const values = Array.from(state.columnMenu.selectedValues);
    if (!values.length) { toast("请至少勾选一个取值，或使用“清除此列条件”。"); return; }
    await applyColumnFilter(column, { op: "in", value: values });
    return;
  }
  if (action === "apply-number") {
    const value = $("columnConditionValue").value.trim();
    if (value === "" || !Number.isFinite(Number(value))) { toast("请输入有效数值。"); return; }
    await applyColumnFilter(column, { op: $("columnNumericOperator").value, value });
    return;
  }
  if (action === "apply-range") {
    const value = $("columnRangeMin").value.trim(), value2 = $("columnRangeMax").value.trim();
    if (![value, value2].every((item) => item !== "" && Number.isFinite(Number(item)))) { toast("请输入完整的数值区间。"); return; }
    if (Number(value) > Number(value2)) { toast("最小值不能大于最大值。"); return; }
    await applyColumnFilter(column, { op: "between", value, value2 });
    return;
  }
  if (action === "apply-text") {
    const value = $("columnConditionValue").value.trim();
    if (!value) { toast("请输入筛选文本。"); return; }
    await applyColumnFilter(column, { op: $("columnTextOperator").value, value });
  }
}

function availableSides() { return Object.keys(state.merge?.sides || {}); }

async function queryTable(page = 1) {
  if (!state.merge) return;
  const sides = availableSides();
  if (!sides.length) return;
  if (!sides.includes(state.activeSide)) state.activeSide = sides[0];
  const generation = state.generation;
  const sessionId = state.sessionId;
  $$("[data-side]").forEach((button) => {
    const available = sides.includes(button.dataset.side);
    button.disabled = !available;
    button.classList.toggle("active", button.dataset.side === state.activeSide);
  });
  try {
    const data = await api(`/api/session/${sessionId}/query`, {
      side: state.activeSide,
      page,
      page_size: Number($("pageSize").value || 200),
      filters: tableFilters(),
      global_search: $("tableSearch").value.trim(),
      sort_column: state.sortColumn || null,
      sort_ascending: state.sortAscending,
      visible_columns: Array.from(state.visibleColumns),
    });
    if (generation !== state.generation || sessionId !== state.sessionId) return;
    state.tableResult = data;
    state.tablePage = data.page;
    renderMergedTable(data);
  } catch (error) {
    showError(error, "明细查询失败");
  }
}

function renderMergedTable(data) {
  const columns = data.columns || [];
  const rows = data.rows || [];
  const filters = state.columnFilters || {};
  $("mergedTable").innerHTML = `<table><thead><tr>${columns.map((column) => {
    const selected = state.lastMetrics.includes(column);
    const filtered = Boolean(filters[column]);
    const sortMark = state.sortColumn === column ? (state.sortAscending ? "↑" : "↓") : "";
    return `<th class="${selected ? "plot-selected" : ""} ${filtered ? "filtered" : ""}"><div class="column-head"><button type="button" class="column-label-button" data-column-menu="${escapeHtml(column)}" aria-haspopup="dialog" title="点击打开 ${escapeHtml(column)} 的排序、筛选与画图操作"><span class="column-name">${escapeHtml(column)}</span>${sortMark ? `<span class="sort-mark">${sortMark}</span>` : ""}</button></div></th>`;
  }).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td class="${state.lastMetrics.includes(column) ? "plot-column" : ""}">${escapeHtml(row[column] ?? "NaN")}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${Math.max(1, columns.length)}">当前条件没有匹配行。</td></tr>`}</tbody></table>`;
  $("tablePager").innerHTML = `<span>方案 ${escapeHtml(data.side)} · ${formatNumber(data.filtered_rows, 0)} / ${formatNumber(data.total_rows, 0)} 行 · 第 ${data.page} / ${data.total_pages} 页</span><div class="pager-buttons"><button type="button" data-page="1" ${data.page <= 1 ? "disabled" : ""}>首页</button><button type="button" data-page="${Math.max(1, data.page - 1)}" ${data.page <= 1 ? "disabled" : ""}>上一页</button><button type="button" data-page="${Math.min(data.total_pages, data.page + 1)}" ${data.page >= data.total_pages ? "disabled" : ""}>下一页</button><button type="button" data-page="${data.total_pages}" ${data.page >= data.total_pages ? "disabled" : ""}>末页</button></div>`;
}

async function exportCsv() {
  if (!state.merge) return;
  setBusy($("exportBtn"), true, "导出中...");
  try {
    const response = await fetch(`/api/session/${state.sessionId}/export`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        side: state.activeSide, filters: tableFilters(), global_search: $("tableSearch").value.trim(),
      }),
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || contentType.includes("application/json")) {
      const payload = await response.json();
      const error = new Error(payload.error || "导出失败"); error.payload = payload; throw error;
    }
    const blob = await response.blob();
    const disposition = response.headers.get("content-disposition") || "";
    const match = disposition.match(/filename\*?=(?:UTF-8''|\")?([^\";]+)/i);
    const filename = match ? decodeURIComponent(match[1].replace(/\"/g, "")) : `wireless_trace_merge_${state.activeSide}.csv`;
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
    URL.revokeObjectURL(href);
    toast(`方案 ${state.activeSide} 已导出。`);
  } catch (error) {
    showError(error, "CSV 导出失败");
  } finally {
    setBusy($("exportBtn"), false);
  }
}

async function pollMemoryStatus() {
  if (!state.sessionId) return;
  const generation = state.generation;
  const sessionId = state.sessionId;
  try {
    const data = await api(`/api/memory/status?session_id=${encodeURIComponent(sessionId)}`);
    if (generation !== state.generation || sessionId !== state.sessionId) return;
    $("cacheSummary").textContent = formatBytes(data.session_bytes || 0);
    $("memorySummary").textContent = `进程内存  ${formatBytes(data.process_rss)}\n系统可用  ${formatBytes(data.sys_avail)}\n会话磁盘  ${formatBytes(data.session_bytes)}`;
    $("cacheFiles").innerHTML = (data.sources || []).map((source) => `<div class="cache-row" title="${escapeHtml(source.path)}"><span class="cache-key">${escapeHtml(source.source_key)}</span><span class="cache-name">${escapeHtml(source.name || "-")}<br><small class="muted">${source.storage === "aggregate-only" ? "仅聚合" : "DuckDB 磁盘缓存"}</small></span><span class="cache-meta">${formatNumber(source.rows, 0)} 行<br>${formatBytes(source.database_bytes)}</span></div>`).join("") || `<p class="muted">暂无已读取文件。</p>`;
  } catch (_) {
    // 会话清理或服务重启时，下一次用户操作会给出完整提示。
  }
}

async function clearSessionCache() {
  if (!state.sessionId) return;
  if (!window.confirm("清理当前分析会话的 DuckDB 缓存与导出文件？源 CSV 不会被删除。")) return;
  try {
    await api(`/api/session/${state.sessionId}/clear`, {});
    state.generation += 1;
    Object.keys(state.taskTokens).forEach((key) => { state.taskTokens[key] += 1; });
    state.plotRenderToken += 1;
    state.sessionId = "";
    state.catalog = null;
    state.ingest = null;
    state.merge = null;
    state.t396 = null;
    state.t396ReadyTaskId = "";
    state.kpiMode = false;
    state.kpiGroups = [];
    state.kpiResult = null;
    state.schemas = {};
    state.columnFilters = {};
    state.visibleColumns = new Set();
    state.availableUsers = [];
    state.selectedUsers.clear();
    state.userPickerDraft.clear();
    state.activeUser = "__ALL__";
    state.lastMetrics = [];
    state.figures = {};
    renderReadInsights();
    renderMergeInsights();
    renderAnalysisUserPicker();
    renderUserTabs();
    setAnalysisUserPickerOpen(false);
    closeColumnMenu();
    setColumnVisibilityOpen(false);
    $("cacheSummary").textContent = "0 B";
    $("memorySummary").textContent = "当前会话已清理";
    $("cacheFiles").innerHTML = `<p class="muted">暂无已读取文件。</p>`;
    $("schemeBatchFieldA").classList.add("hidden");
    $("schemeBatchFieldB").classList.add("hidden");
    $("schemeA").innerHTML = "";
    $("schemeB").innerHTML = "";
    $("schemeAStats").textContent = $("pathAInput").value.trim() ? "等待重新扫描" : "允许留空";
    $("schemeBStats").textContent = $("pathBInput").value.trim() ? "等待重新扫描" : "允许留空";
    $("startBtn").disabled = true;
    $("kpiModeBtn").disabled = true;
    $("kpiGroupRows").innerHTML = "";
    $("kpiPanel").classList.add("hidden");
    $("kpiResults").classList.add("hidden");
    $("t396Panel").classList.remove("hidden");
    $("t396Table").innerHTML = `<div class="empty-state small">开始完整分析后，T396 结果会优先显示。</div>`;
    $("t396Stats").innerHTML = "";
    $("batchSummary").classList.add("hidden");
    $("scanMessage").textContent = "缓存已清理，请重新扫描方案 A/B 目录。";
    goStep(1);
    toast("当前会话缓存已清理。");
  } catch (error) {
    showError(error, "缓存清理失败");
  }
}

function bindEvents() {
  $("scanBtn").addEventListener("click", scanDirectory);
  for (const id of ["pathAInput", "pathBInput"]) {
    $(id).addEventListener("keydown", (event) => { if (event.key === "Enter") scanDirectory(); });
  }
  for (const id of ["schemeA", "schemeB"]) {
    $(id).addEventListener("change", () => {
      renderBatchSummary();
      if (!state.kpiMode && !state.kpiResult) seedKpiGroups();
    });
  }
  $("swapSchemesBtn").addEventListener("click", swapSchemeDirectories);
  $("startBtn").addEventListener("click", startAnalysis);
  $("kpiModeBtn").addEventListener("click", () => setKpiMode(!state.kpiMode));
  $("autoPairKpiBtn").addEventListener("click", autoPairKpiGroups);
  $("addKpiGroupBtn").addEventListener("click", addKpiGroup);
  $("startKpiBtn").addEventListener("click", startKpiOverview);
  $("kpiGroupRows").addEventListener("input", (event) => {
    const row = event.target.closest("[data-kpi-id]");
    const field = event.target.dataset.kpiField;
    if (!row || !field) return;
    const group = state.kpiGroups.find((item) => item.id === row.dataset.kpiId);
    if (group) group[field] = event.target.value;
  });
  $("kpiGroupRows").addEventListener("change", (event) => {
    const row = event.target.closest("[data-kpi-id]");
    const field = event.target.dataset.kpiField;
    if (!row || !field) return;
    const group = state.kpiGroups.find((item) => item.id === row.dataset.kpiId);
    if (group) group[field] = event.target.value;
  });
  $("kpiGroupRows").addEventListener("click", (event) => {
    const button = event.target.closest("[data-kpi-remove]");
    const row = event.target.closest("[data-kpi-id]");
    if (!button || !row) return;
    state.kpiGroups = state.kpiGroups.filter((item) => item.id !== row.dataset.kpiId);
    renderKpiGroups();
  });
  $("toggleSourceBtn").addEventListener("click", () => toggleSource());
  $$(".step").forEach((button) => button.addEventListener("click", () => goStep(Number(button.dataset.step))));
  for (const trace of ["537", "714"]) {
    $(`search${trace}`).addEventListener("input", () => renderColumnList(trace));
    $(`columns${trace}`).addEventListener("change", (event) => {
      const input = event.target.closest("input[data-column]");
      if (!input) return;
      if (input.checked) state.selectedColumns[trace].add(input.dataset.column); else state.selectedColumns[trace].delete(input.dataset.column);
      selectedColumnCount(trace);
      renderMergeInsights();
    });
  }
  $$('[data-bulk]').forEach((button) => button.addEventListener("click", () => {
    const [trace, mode] = button.dataset.bulk.split("-"); bulkColumns(trace, mode);
  }));
  $("limitRowsCheck").addEventListener("change", () => { $("rowLimitInput").disabled = !$("limitRowsCheck").checked; renderMergeInsights(); });
  $("rowLimitInput").addEventListener("input", renderMergeInsights);
  $("mergeBtn").addEventListener("click", startMerge);
  $("t396Table").addEventListener("change", () => { $("handoffUsersBtn").disabled = !document.querySelector(".t396-user-check:checked"); });
  $("handoffUsersBtn").addEventListener("click", handoffT396Users);
  $("analysisUserPickerBtn").addEventListener("click", (event) => {
    event.stopPropagation();
    setAnalysisUserPickerOpen($("analysisUserPickerMenu").classList.contains("hidden"));
  });
  $("analysisUserPickerMenu").addEventListener("click", (event) => event.stopPropagation());
  $("analysisUserSearch").addEventListener("input", renderAnalysisUserOptions);
  $("analysisUserOptions").addEventListener("change", (event) => {
    const input = event.target.closest(".analysis-user-check");
    if (!input) return;
    if (input.checked) {
      if (state.userPickerDraft.size >= MAX_ANALYSIS_USERS) {
        input.checked = false;
        toast(`一次最多分析 ${MAX_ANALYSIS_USERS} 个用户。`);
        return;
      }
      state.userPickerDraft.add(input.value);
    } else {
      state.userPickerDraft.delete(input.value);
    }
    renderAnalysisUserOptions();
  });
  $("selectVisibleUsersBtn").addEventListener("click", selectVisibleAnalysisUsers);
  $("clearAnalysisUsersBtn").addEventListener("click", () => { state.userPickerDraft.clear(); renderAnalysisUserOptions(); });
  $("applyAnalysisUsersBtn").addEventListener("click", applyAnalysisUsers);

  for (const id of ["userTabs", "chartUserTabs"]) {
    $(id).addEventListener("click", async (event) => {
      const button = event.target.closest("[data-user]"); if (!button) return;
      state.activeUser = button.dataset.user;
      renderUserTabs();
      markPlotsStale();
      if (state.lastMetrics.length) await startPlot();
    });
  }

  $("activeFilterChips").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-filter-column]");
    if (button) await removeColumnFilter(button.dataset.filterColumn);
  });
  $("clearTableFiltersBtn").addEventListener("click", clearAllTableConditions);
  $("metricSearch").addEventListener("input", renderMetricOptions);
  $("metricOptions").addEventListener("change", (event) => {
    const input = event.target.closest(".metric-check");
    if (input) togglePlotColumn(input.value, input.checked);
  });
  $("plotBtn").addEventListener("click", startPlot);
  $("quickPlotBtn").addEventListener("click", quickPlotFromTable);
  $("figureTabs").addEventListener("click", (event) => { const button = event.target.closest("[data-figure]"); if (!button) return; state.activeFigure = button.dataset.figure; renderFigureTabs(); renderActiveFigure(); });
  $$("[data-analysis-tab]").forEach((button) => button.addEventListener("click", () => showAnalysisTab(button.dataset.analysisTab)));
  $$("[data-side]").forEach((button) => button.addEventListener("click", () => {
    if (button.disabled) return;
    state.activeSide = button.dataset.side;
    closeColumnMenu();
    queryTable(1);
  }));
  let searchTimer = 0;
  $("tableSearch").addEventListener("input", () => {
    clearTimeout(searchTimer);
    renderFilterChips();
    markPlotsStale();
    searchTimer = window.setTimeout(() => queryTable(1), 450);
  });
  $("pageSize").addEventListener("change", () => queryTable(1));
  $("mergedTable").addEventListener("click", (event) => {
    const menuButton = event.target.closest("[data-column-menu]");
    if (menuButton) openColumnMenu(menuButton.dataset.columnMenu, menuButton);
  });
  $("mergedTable").addEventListener("scroll", closeColumnMenu, { passive: true });
  $("tablePager").addEventListener("click", (event) => { const button = event.target.closest("[data-page]"); if (button && !button.disabled) queryTable(Number(button.dataset.page)); });
  $("columnVisibilityBtn").addEventListener("click", (event) => {
    event.stopPropagation();
    setColumnVisibilityOpen($("columnVisibilityMenu").classList.contains("hidden"));
  });
  $("columnVisibilityMenu").addEventListener("click", (event) => event.stopPropagation());
  $("columnVisibilitySearch").addEventListener("input", renderColumnVisibilityOptions);
  $("visibleColumnOptions").addEventListener("change", async (event) => {
    const input = event.target.closest(".visible-column-check"); if (!input) return;
    const next = new Set(state.visibleColumns);
    if (input.checked) next.add(input.value); else next.delete(input.value);
    await setVisibleColumns(Array.from(next));
  });
  $("showAllColumnsBtn").addEventListener("click", () => setVisibleColumns(mergedColumns()));
  $("showDefaultColumnsBtn").addEventListener("click", () => setVisibleColumns(defaultVisibleColumns()));

  let columnValueSearchTimer = 0;
  $("columnMenu").addEventListener("click", async (event) => {
    event.stopPropagation();
    const button = event.target.closest("[data-column-action]");
    if (button) await handleColumnAction(button.dataset.columnAction);
  });
  $("columnMenu").addEventListener("change", (event) => {
    const input = event.target.closest(".column-value-check");
    if (!input) return;
    if (input.checked) state.columnMenu.selectedValues.add(input.value); else state.columnMenu.selectedValues.delete(input.value);
  });
  $("columnMenu").addEventListener("input", (event) => {
    if (event.target.id !== "columnValueSearch") return;
    clearTimeout(columnValueSearchTimer);
    columnValueSearchTimer = window.setTimeout(() => refreshColumnProfile(event.target.value.trim()), 320);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#columnVisibilityMenu, #columnVisibilityBtn")) setColumnVisibilityOpen(false);
    if (!event.target.closest("#columnMenu, [data-column-menu]")) closeColumnMenu();
    if (!event.target.closest("#analysisUserPicker")) setAnalysisUserPickerOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { closeColumnMenu(); setColumnVisibilityOpen(false); setAnalysisUserPickerOpen(false); }
  });
  $("exportBtn").addEventListener("click", exportCsv);
  $("resetPlotSizeBtn").addEventListener("click", resetPlotSize);
  $("plotResizeHandle").addEventListener("pointerdown", beginPlotResize);
  $("plotResizeHandle").addEventListener("pointermove", movePlotResize);
  $("plotResizeHandle").addEventListener("pointerup", endPlotResize);
  $("plotResizeHandle").addEventListener("pointercancel", endPlotResize);
  $("clearCacheBtn").addEventListener("click", clearSessionCache);
  $("closeErrorBtn").addEventListener("click", hideError);
  window.addEventListener("resize", resizeVisiblePlot, { passive: true });
  if (window.ResizeObserver) new ResizeObserver(() => resizeVisiblePlot()).observe($("analysisPlot"));
}

bindEvents();
setInterval(pollMemoryStatus, 10000);
