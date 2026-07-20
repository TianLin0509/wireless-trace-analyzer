from __future__ import annotations

import json
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

from flask import Flask, Response, render_template, request, send_file
from plotly.offline import get_plotlyjs
from plotly.utils import PlotlyJSONEncoder

from .catalog import (
    build_catalog,
    build_dual_catalog,
    build_kpi_t396_plan,
    match_same_cell_batches,
    scan_csv_files,
    selected_sources,
)
from .config import APP_TITLE, APP_VERSION, MERGE_COLUMN_TEMPLATE_PATH
from .config import ANALYSIS_RECIPE_PATH
from .analysis_recipes import AnalysisRecipeStore
from .engine import SOURCE_CACHE, run_ingest_task, run_kpi396_task, run_merge_task
from .merge_templates import MergeColumnTemplateStore
from .queries import (
    column_profile,
    export_filtered_csv,
    filter_options,
    query_rows,
    run_plot_task,
    tti_preview,
)
from .state import SESSIONS, TASKS, SessionState, start_janitor
from .utils import get_memory_info, resolve_path


def json_response(payload: dict[str, Any], status: int = 200) -> Response:
    return Response(
        json.dumps(payload, ensure_ascii=False, cls=PlotlyJSONEncoder),
        status=status,
        mimetype="application/json; charset=utf-8",
    )


def diagnose_error(message: str) -> dict[str, Any]:
    text = str(message or "")
    lowered = text.lower()
    if "路径扫描失败" in text or "文件夹路径" in text:
        return {
            "reason": "方案目录无法访问，或目录中没有可识别的跟踪文件。",
            "actions": ["检查对应方案的文件夹路径是否完整", "确认网络盘已连接且当前账号有读取权限", "确认目录中包含 Dest_T396/T537/T714 CSV"],
        }
    if "相同源文件" in text:
        return {
            "reason": "方案 A/B 最终选择了同一个物理 CSV，无法形成有效对比。",
            "actions": ["检查 A/B 文件夹是否误填为同一路径", "在对应方案中改选其他测试批次", "使用 A/B 互换按钮后重新扫描"],
        }
    if "KPI" in text and "T396" in text:
        return {
            "reason": "KPI 对比组没有可用的 T396，或 A/B 误选为同一份 T396。",
            "actions": ["检查该组 A/B 批次是否包含 T396", "展开测试批次并核对 ParseResult 绝对路径", "删除空组或重新选择批次后再分析"],
        }
    if "缺少 t537" in lowered or "均缺少 t537" in lowered:
        return {
            "reason": "汇总必须以 T537 为锚点，但当前方案没有可用的 T537 文件。",
            "actions": ["返回文件选择，确认方案 A/B 对应时间下存在 T537", "重新扫描正确目录"],
        }
    if "连接键" in text or "合并字段" in text or "缺少字段" in text:
        return {
            "reason": "CSV 字段结构与预期不一致，无法建立 crnti + 时间 + frm + slot 合并键。",
            "actions": ["检查 537/714 是否属于同一套跟踪格式", "确认字段名没有被导出工具改写"],
        }
    if "out of memory" in lowered or "memory" in lowered or "内存" in text:
        return {
            "reason": "读取或计算时可用内存不足。原始数据仍在磁盘，没有损坏。",
            "actions": ["清理当前会话缓存后重试", "关闭其他占用内存的程序", "在汇总阶段限制 T537 行数"],
        }
    if "codec" in lowered or "encoding" in lowered or "csv" in lowered:
        return {
            "reason": "CSV 编码、分隔符或坏行导致读取失败。",
            "actions": ["确认文件可被 Excel 正常打开", "检查文件是否仍在写入", "将异常文件另存为 UTF-8 CSV 后重试"],
        }
    if "714" in text and ("匹配" in text or "crnti" in lowered):
        return {
            "reason": "T714 无法与 T537 建立有效的逐 TTI 关联，通常是批次选错或关键字段格式不同。",
            "actions": ["检查 A/B 时间批次是否正确", "确认 537/714 均优先选择同批 trace_0", "在汇总结果查看 714 匹配状态"],
        }
    if "不存在" in text or "not found" in lowered:
        return {
            "reason": "文件或分析会话已不存在，可能被移动、清理或已过期。",
            "actions": ["确认源文件仍在原路径", "重新扫描并开始分析"],
        }
    return {
        "reason": text or "后端任务未正常完成。",
        "actions": ["检查所选文件和字段", "清理当前会话缓存后重试", "保留错误详情用于定位"],
    }


def error_response(error: Exception, status: int = 400) -> Response:
    message = str(error)
    return json_response(
        {
            "ok": False,
            "error": message,
            "diagnosis": diagnose_error(message),
            "detail": traceback.format_exc(),
        },
        status=status,
    )


def request_data() -> dict[str, Any]:
    return request.get_json(silent=True) or {}


def require_session(data: dict[str, Any] | None = None) -> SessionState:
    payload = data if data is not None else request_data()
    session_id = str(payload.get("session_id") or request.args.get("session_id") or "")
    return SESSIONS.get(session_id)


def directory_bytes(path: Path) -> int:
    total = 0
    if not path.exists():
        return total
    for item in path.rglob("*"):
        try:
            if item.is_file():
                total += item.stat().st_size
        except OSError:
            continue
    return total


def public_sources(session: SessionState) -> list[dict[str, Any]]:
    rows = []
    for source_key, source in session.manifest.get("sources", {}).items():
        rows.append(
            {
                "source_key": source_key,
                "name": source.get("name"),
                "side": source.get("side"),
                "trace_id": source.get("trace_id"),
                "rows": source.get("rows", 0),
                "status": source.get("status", "queued"),
                "database_bytes": source.get("database_bytes", 0),
                "storage": source.get("storage", "duckdb"),
                "path": source.get("path"),
                "cache_hit": bool(source.get("cache_hit")),
                "cache_reason": source.get("cache_reason"),
                "fingerprint": source.get("fingerprint"),
                "quality": source.get("quality") or {},
            }
        )
    return sorted(rows, key=lambda row: str(row["source_key"]))


def create_app(
    template_store: MergeColumnTemplateStore | None = None,
    recipe_store: AnalysisRecipeStore | None = None,
) -> Flask:
    application = Flask(__name__, template_folder="templates", static_folder="static")
    application.config["JSON_AS_ASCII"] = False
    merge_template_store = template_store or MergeColumnTemplateStore(
        MERGE_COLUMN_TEMPLATE_PATH
    )
    analysis_recipe_store = recipe_store or AnalysisRecipeStore(ANALYSIS_RECIPE_PATH)
    start_janitor()

    @application.before_request
    def enforce_local_access():
        remote = str(request.remote_addr or "")
        if remote and remote not in {"127.0.0.1", "::1", "::ffff:127.0.0.1"}:
            return json_response(
                {
                    "ok": False,
                    "error": "此分析台仅允许本机访问。",
                    "diagnosis": {
                        "reason": "请求来自非本机地址，已拒绝访问本机 CSV 与缓存。",
                        "actions": ["请在运行分析台的电脑上使用 127.0.0.1 访问"],
                    },
                },
                status=403,
            )
        return None

    @application.get("/")
    def index():
        return render_template(
            "index.html",
            title=APP_TITLE,
            version=APP_VERSION,
        )

    @application.get("/plotly.js")
    def plotly_js():
        return Response(get_plotlyjs(), mimetype="application/javascript; charset=utf-8")

    @application.get("/api/merge-column-templates")
    def api_merge_column_templates():
        try:
            return json_response(
                {
                    "ok": True,
                    "templates": merge_template_store.list_templates(),
                    "storage_path": str(merge_template_store.path),
                }
            )
        except Exception as exc:
            return error_response(exc)

    @application.post("/api/merge-column-templates")
    def api_create_merge_column_template():
        try:
            data = request_data()
            template = merge_template_store.create_template(
                name=data.get("name"),
                columns_537=data.get("columns_537"),
                columns_714=data.get("columns_714"),
            )
            return json_response({"ok": True, "template": template}, status=201)
        except Exception as exc:
            return error_response(exc)

    @application.post("/api/merge-column-templates/<template_id>")
    def api_update_merge_column_template(template_id: str):
        try:
            template = merge_template_store.update_template(template_id, request_data())
            return json_response({"ok": True, "template": template})
        except Exception as exc:
            return error_response(exc, status=404 if isinstance(exc, KeyError) else 400)

    @application.delete("/api/merge-column-templates/<template_id>")
    def api_delete_merge_column_template(template_id: str):
        try:
            deleted = merge_template_store.delete_template(template_id)
            return json_response({"ok": True, "deleted": deleted})
        except Exception as exc:
            return error_response(exc, status=404 if isinstance(exc, KeyError) else 400)

    @application.get("/api/analysis-recipes")
    def api_analysis_recipes():
        try:
            return json_response(
                {
                    "ok": True,
                    "recipes": analysis_recipe_store.list_recipes(),
                    "storage_path": str(analysis_recipe_store.path),
                }
            )
        except Exception as exc:
            return error_response(exc)

    @application.post("/api/analysis-recipes")
    def api_create_analysis_recipe():
        try:
            data = request_data()
            recipe = analysis_recipe_store.create_recipe(
                data.get("name"), data.get("workspace")
            )
            return json_response({"ok": True, "recipe": recipe}, status=201)
        except Exception as exc:
            return error_response(exc)

    @application.post("/api/analysis-recipes/<recipe_id>")
    def api_update_analysis_recipe(recipe_id: str):
        try:
            recipe = analysis_recipe_store.update_recipe(recipe_id, request_data())
            return json_response({"ok": True, "recipe": recipe})
        except Exception as exc:
            return error_response(exc, status=404 if isinstance(exc, KeyError) else 400)

    @application.delete("/api/analysis-recipes/<recipe_id>")
    def api_delete_analysis_recipe(recipe_id: str):
        try:
            deleted = analysis_recipe_store.delete_recipe(recipe_id)
            return json_response({"ok": True, "deleted": deleted})
        except Exception as exc:
            return error_response(exc, status=404 if isinstance(exc, KeyError) else 400)

    @application.post("/api/scan")
    def api_scan():
        try:
            data = request_data()
            recursive = bool(data.get("recursive", True))
            dual_request = "path_a" in data or "path_b" in data
            if dual_request:
                raw_paths = {
                    "A": str(data.get("path_a") or "").strip(),
                    "B": str(data.get("path_b") or "").strip(),
                }
                if not any(raw_paths.values()):
                    raise ValueError("方案 A/B 文件夹路径不能同时为空。")

                def scan_side(side: str) -> tuple[Path | None, list[dict[str, Any]]]:
                    raw = raw_paths[side]
                    if not raw:
                        return None, []
                    try:
                        side_root = resolve_path(raw)
                        return side_root, scan_csv_files(side_root, recursive=recursive)
                    except Exception as exc:
                        raise ValueError(f"方案 {side} 路径扫描失败：{exc}") from exc

                with ThreadPoolExecutor(max_workers=2) as executor:
                    futures = {
                        side: executor.submit(scan_side, side) for side in ("A", "B")
                    }
                    scanned = {side: futures[side].result() for side in ("A", "B")}
                roots = {side: scanned[side][0] for side in ("A", "B")}
                files_by_side = {side: scanned[side][1] for side in ("A", "B")}
                catalog = build_dual_catalog(files_by_side, roots)
                if catalog["file_count"] == 0:
                    raise ValueError("两个方案目录中均未找到 T396/T537/T714 CSV 文件。")
                root = roots["A"] or roots["B"]
                assert root is not None
                session = SESSIONS.create(root, catalog, roots=roots)
            else:
                root = resolve_path(str(data.get("path") or ""))
                files = scan_csv_files(root, recursive=recursive)
                catalog = build_catalog(files)
                session = SESSIONS.create(root, catalog)
            session.update(selection=catalog.get("default_selection", {}))
            return json_response(
                {
                    "ok": True,
                    "session_id": session.session_id,
                    "catalog": catalog,
                    "selection": catalog.get("default_selection", {}),
                }
            )
        except Exception as exc:
            return error_response(exc)

    def prepare_task(
        data: dict[str, Any],
    ) -> tuple[str, SessionState, Callable[[str], dict[str, Any]], dict[str, Any]]:
        session = require_session(data)
        action = str(data.get("action") or "")
        worker: Callable[[str], dict[str, Any]]
        request_payload = json.loads(json.dumps(data, ensure_ascii=False))
        request_payload["session_id"] = session.session_id
        if action == "ingest":
            selection = data.get("selection") or session.manifest.get("selection") or {}
            selection = {"A": selection.get("A") or None, "B": selection.get("B") or None}
            catalog = session.manifest.get("catalog", {})
            if (
                not catalog.get("side_catalogs")
                and selection["A"]
                and selection["A"] == selection["B"]
            ):
                raise ValueError("方案 A 与方案 B 不能选择同一个测试时间。")
            sources = selected_sources(catalog, selection)
            if not sources:
                raise ValueError("方案 A/B 均为空，没有可读取的文件。")
            duplicate_traces = [
                trace_id
                for trace_id in ("396", "537", "714")
                if sources.get(f"A{trace_id}")
                and sources.get(f"B{trace_id}")
                and sources[f"A{trace_id}"].get("path")
                == sources[f"B{trace_id}"].get("path")
            ]
            if duplicate_traces:
                traces = "、".join(f"T{trace_id}" for trace_id in duplicate_traces)
                raise ValueError(
                    f"方案 A/B 指向了相同源文件：{traces}。请调整目录或测试批次。"
                )
            request_payload["selection"] = selection
            session.update(selection=selection, sources={}, phase="reading")
            worker = lambda task_id: run_ingest_task(session, task_id, sources)
        elif action == "kpi396":
            groups = data.get("groups") or []
            if not isinstance(groups, list):
                raise ValueError("KPI 多组配置格式无效。")
            catalog = session.manifest.get("catalog", {})
            sources, resolved_groups = build_kpi_t396_plan(catalog, groups)
            session.update(sources={}, phase="reading_kpi", kpi396={})
            worker = lambda task_id: run_kpi396_task(
                session,
                task_id,
                sources,
                resolved_groups,
            )
        elif action == "merge":
            columns_537 = [str(value) for value in (data.get("columns_537") or [])]
            columns_714 = [str(value) for value in (data.get("columns_714") or [])]
            merge_all_rows = bool(data.get("merge_all_rows", False))
            row_limit = 0 if merge_all_rows else max(0, int(data.get("row_limit") or 0))
            if not columns_537:
                raise ValueError("请至少选择一个 T537 字段。连接键会自动保留。")
            request_payload["merge_all_rows"] = merge_all_rows
            request_payload["row_limit"] = row_limit
            session.update(phase="merging")
            worker = lambda task_id: run_merge_task(
                session, task_id, columns_537, columns_714, row_limit
            )
        elif action == "plot":
            metrics = [str(value) for value in (data.get("metrics") or [])]
            filters = data.get("filters") or []
            global_search = str(data.get("global_search") or "")
            user_values = data.get("user_values") or []
            worker = lambda task_id: run_plot_task(
                session, task_id, metrics, filters, global_search, user_values
            )
        else:
            raise ValueError(f"未知任务类型：{action or '空'}")
        return action, session, worker, request_payload

    def start_prepared_task(data: dict[str, Any]) -> str:
        action, session, worker, request_payload = prepare_task(data)
        return TASKS.start(
            action,
            session.session_id,
            worker,
            request_payload=request_payload,
        )

    @application.post("/api/task/start")
    def api_task_start():
        try:
            return json_response(
                {"ok": True, "task_id": start_prepared_task(request_data())}
            )
        except Exception as exc:
            return error_response(exc)

    @application.post("/api/session/<session_id>/match-batches")
    def api_match_batches(session_id: str):
        try:
            session = SESSIONS.get(session_id)
            data = request_data()
            result = match_same_cell_batches(
                session.manifest.get("catalog", {}),
                case_a=str(data.get("case_a") or ""),
                case_b=str(data.get("case_b") or ""),
                cell_key=str(data.get("cell_key") or ""),
                required_trace=str(data.get("required_trace") or "") or None,
                max_pairs=int(data.get("max_pairs") or 30),
            )
            return json_response({"ok": True, **result})
        except Exception as exc:
            return error_response(exc)

    @application.route("/api/task/status/<task_id>", methods=["GET", "POST"])
    def api_task_status(task_id: str):
        try:
            payload = TASKS.get(task_id)
            payload["ok"] = True
            if payload.get("status") == "error":
                payload["diagnosis"] = diagnose_error(str(payload.get("error") or ""))
            return json_response(payload)
        except Exception as exc:
            return error_response(exc, status=404)

    @application.post("/api/task/<task_id>/cancel")
    def api_task_cancel(task_id: str):
        try:
            cancelled = TASKS.cancel(task_id)
            return json_response({"ok": True, "cancel_requested": cancelled})
        except Exception as exc:
            return error_response(exc, status=404 if isinstance(exc, KeyError) else 400)

    @application.post("/api/task/<task_id>/retry")
    def api_task_retry(task_id: str):
        try:
            previous = TASKS.get(task_id)
            request_payload = previous.get("request") or {}
            if not previous.get("restartable") or not request_payload:
                raise ValueError("该任务没有可重试的请求配置。")
            if previous.get("status") in {"queued", "running", "cancelling"}:
                raise ValueError("任务仍在运行，不能重复启动。")
            new_task_id = start_prepared_task(dict(request_payload))
            return json_response(
                {"ok": True, "task_id": new_task_id, "retried_from": task_id}
            )
        except Exception as exc:
            return error_response(exc, status=404 if isinstance(exc, KeyError) else 400)

    @application.get("/api/session/<session_id>/tasks")
    def api_session_tasks(session_id: str):
        try:
            SESSIONS.get(session_id)
            return json_response(
                {"ok": True, "tasks": TASKS.list_recent(session_id=session_id)}
            )
        except Exception as exc:
            return error_response(exc, status=404)

    @application.route("/api/session/<session_id>/status", methods=["GET", "POST"])
    def api_session_status(session_id: str):
        try:
            session = SESSIONS.get(session_id)
            return json_response({"ok": True, "session": session.snapshot()})
        except Exception as exc:
            return error_response(exc, status=404)

    @application.post("/api/session/<session_id>/heartbeat")
    def api_session_heartbeat(session_id: str):
        try:
            session = SESSIONS.get(session_id)
            return json_response({"ok": True, "phase": session.manifest.get("phase")})
        except Exception as exc:
            return error_response(exc, status=404)

    @application.post("/api/session/<session_id>/filter-options")
    def api_filter_options(session_id: str):
        try:
            session = SESSIONS.get(session_id)
            data = request_data()
            result = filter_options(
                session,
                column=str(data.get("column") or "") or None,
                search=str(data.get("search") or ""),
            )
            return json_response({"ok": True, **result})
        except Exception as exc:
            return error_response(exc)

    @application.post("/api/session/<session_id>/column-profile")
    def api_column_profile(session_id: str):
        try:
            session = SESSIONS.get(session_id)
            data = request_data()
            result = column_profile(
                session,
                side=str(data.get("side") or "A"),
                column=str(data.get("column") or ""),
                filters=data.get("filters") or [],
                global_search=str(data.get("global_search") or ""),
                value_search=str(data.get("value_search") or ""),
            )
            return json_response({"ok": True, **result})
        except Exception as exc:
            return error_response(exc)

    @application.post("/api/session/<session_id>/query")
    def api_query(session_id: str):
        try:
            session = SESSIONS.get(session_id)
            data = request_data()
            result = query_rows(
                session,
                side=str(data.get("side") or "A"),
                page=int(data.get("page") or 1),
                page_size=int(data.get("page_size") or 200),
                filters=data.get("filters") or [],
                global_search=str(data.get("global_search") or ""),
                sort_column=str(data.get("sort_column") or "") or None,
                sort_ascending=bool(data.get("sort_ascending", True)),
                visible_columns=data.get("visible_columns") or None,
            )
            return json_response({"ok": True, **result})
        except Exception as exc:
            return error_response(exc)

    @application.post("/api/session/<session_id>/tti-preview")
    def api_tti_preview(session_id: str):
        try:
            session = SESSIONS.get(session_id)
            data = request_data()
            result = tti_preview(
                session,
                side=str(data.get("side") or "A"),
                tti_value=data.get("tti"),
                visible_columns=data.get("visible_columns") or None,
            )
            return json_response({"ok": True, **result})
        except Exception as exc:
            return error_response(exc)

    @application.post("/api/session/<session_id>/export")
    def api_export(session_id: str):
        try:
            session = SESSIONS.get(session_id)
            data = request_data()
            path = export_filtered_csv(
                session,
                side=str(data.get("side") or "A"),
                filters=data.get("filters") or [],
                global_search=str(data.get("global_search") or ""),
            )
            return send_file(path, as_attachment=True, download_name=path.name)
        except Exception as exc:
            return error_response(exc)

    @application.post("/api/session/<session_id>/clear")
    def api_session_clear(session_id: str):
        try:
            if TASKS.has_active_for_session(session_id):
                raise ValueError("当前会话仍有任务运行，完成或失败后才能清理缓存。")
            cleared = SESSIONS.clear(session_id)
            return json_response({"ok": True, "cleared": cleared})
        except Exception as exc:
            return error_response(exc)

    @application.route("/api/memory/status", methods=["GET", "POST"])
    def api_memory_status():
        try:
            data = request_data() if request.method == "POST" else {}
            session_id = str(data.get("session_id") or request.args.get("session_id") or "")
            session = SESSIONS.get(session_id) if session_id else None
            memory = get_memory_info()
            return json_response(
                {
                    "ok": True,
                    **memory,
                    "session_bytes": directory_bytes(session.directory) if session else 0,
                    "sources": public_sources(session) if session else [],
                    "shared_cache": SOURCE_CACHE.snapshot(),
                }
            )
        except Exception as exc:
            return error_response(exc)

    @application.post("/api/cache/shared/clear")
    def api_shared_cache_clear():
        try:
            if any(
                TASKS.has_active_for_session(str(snapshot.get("session_id") or ""))
                for snapshot in SESSIONS.list_snapshots()
            ):
                raise ValueError("仍有读取任务运行，暂不能清理共享源缓存。")
            return json_response({"ok": True, "cleared_items": SOURCE_CACHE.clear()})
        except Exception as exc:
            return error_response(exc)

    return application
