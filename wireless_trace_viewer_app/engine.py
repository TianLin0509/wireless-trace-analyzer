from __future__ import annotations

import math
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Optional

import duckdb
import numpy as np
import pandas as pd

from .config import (
    ANALYSIS_DUCKDB_MEMORY_LIMIT,
    DEFAULT_537_COLUMNS,
    DEFAULT_714_COLUMNS,
    ID_LIKE_COLUMNS,
    MAX_READ_WORKERS,
    MIN_AVAILABLE_MEMORY_BYTES,
    READ_CHUNK_ROWS,
    SOURCE_DUCKDB_MEMORY_LIMIT,
    T396_REQUIRED_COLUMNS,
)
from .state import SessionState, TASKS
from .utils import (
    detect_csv_format,
    estimate_total_rows,
    get_memory_info,
    infer_numeric_columns,
    normalize_crnti_id,
    normalize_series,
    normalize_user_id,
    quote_ident,
    quote_sql_text,
)


SCALE_714 = 1024000.0
KEY_INTERNAL_COLUMNS = ["__key_crnti", "__key_time", "__key_frm", "__key_slot"]


def find_column(columns: list[str], candidates: list[str]) -> Optional[str]:
    lookup = {str(column).strip().lower(): str(column) for column in columns}
    for candidate in candidates:
        found = lookup.get(candidate.lower())
        if found:
            return found
    return None


def resolve_merge_keys(columns: list[str], trace_id: str) -> dict[str, str]:
    mapping = {
        "crnti": find_column(columns, ["crnti"]),
        "time": find_column(columns, ["HH:MM:SS", "hh:mm:ss"]),
        "frm": find_column(columns, ["frm"]),
        "slot": find_column(
            columns,
            ["slotNo", "slotNum"] if trace_id == "537" else ["slotNum", "slotNo"],
        ),
    }
    missing = [name for name, value in mapping.items() if value is None]
    if missing:
        raise ValueError(
            f"T{trace_id} 缺少汇总连接字段：{', '.join(missing)}。"
            "需要 crnti、HH:MM:SS、frm 和 slotNo/slotNum。"
        )
    return {key: str(value) for key, value in mapping.items() if value is not None}


def add_internal_columns(
    frame: pd.DataFrame,
    trace_id: str,
    row_start: int,
) -> tuple[pd.DataFrame, dict[str, str]]:
    frame.columns = [str(column).strip() for column in frame.columns]
    frame.insert(0, "__source_row", np.arange(row_start, row_start + len(frame), dtype=np.int64))
    key_mapping: dict[str, str] = {}
    if trace_id in {"537", "714"}:
        key_mapping = resolve_merge_keys([str(column) for column in frame.columns], trace_id)
        frame["__key_crnti"] = normalize_series(frame[key_mapping["crnti"]], normalize_crnti_id)
        frame["__key_time"] = frame[key_mapping["time"]].where(
            frame[key_mapping["time"]].notna(), None
        ).map(lambda value: str(value).strip() if value is not None else None)
        frame["__key_frm"] = normalize_series(frame[key_mapping["frm"]])
        frame["__key_slot"] = normalize_series(frame[key_mapping["slot"]])
    return frame, key_mapping


class ProgressAggregator:
    def __init__(self, task_id: str, sources: dict[str, dict[str, Any]]) -> None:
        self.task_id = task_id
        self.weights = {
            key: max(1, int(source.get("size", 1))) for key, source in sources.items()
        }
        self.progress = {key: 0.0 for key in sources}
        self.lock = threading.Lock()

    def update(
        self,
        source_key: str,
        pct: float,
        rows: int,
        status: str,
        detail: str,
    ) -> None:
        with self.lock:
            self.progress[source_key] = max(0.0, min(100.0, float(pct)))
            total_weight = sum(self.weights.values())
            weighted = sum(
                self.weights[key] * self.progress.get(key, 0.0)
                for key in self.weights
            ) / max(total_weight, 1)
        TASKS.update_file(
            self.task_id,
            source_key,
            pct=round(float(pct), 2),
            rows=int(rows),
            status=status,
            detail=detail,
        )
        TASKS.update(
            self.task_id,
            pct=round(weighted * 0.88, 2),
            title="全量读取并建立磁盘缓存",
            detail=detail,
        )


def _read_chunks(path: Path, encoding: str, separator: str):
    return pd.read_csv(
        path,
        encoding=encoding,
        sep=separator,
        engine="c",
        chunksize=READ_CHUNK_ROWS,
        dtype=str,
        keep_default_na=True,
        on_bad_lines="skip",
        low_memory=False,
        encoding_errors="replace",
    )


def _clear_duckdb_files(database_path: Path) -> None:
    database_path.parent.mkdir(parents=True, exist_ok=True)
    for candidate in database_path.parent.glob(database_path.name + "*"):
        if candidate.is_file():
            candidate.unlink()


def ingest_table_source(
    session: SessionState,
    task_id: str,
    source_key: str,
    source: dict[str, Any],
    progress: ProgressAggregator,
) -> dict[str, Any]:
    path = Path(source["path"])
    trace_id = str(source["trace_id"])
    encoding, separator = detect_csv_format(path)
    estimated_rows = estimate_total_rows(path)
    database_path = session.source_database_path(source_key)
    _clear_duckdb_files(database_path)
    session.update_source(
        source_key,
        **source,
        status="reading",
        rows=0,
        estimated_rows=estimated_rows,
        database_path=str(database_path),
        encoding=encoding,
        separator=separator,
    )

    connection = duckdb.connect(str(database_path))
    temp_directory = session.directory / "tmp" / source_key
    temp_directory.mkdir(parents=True, exist_ok=True)
    connection.execute(
        f"SET memory_limit = {quote_sql_text(SOURCE_DUCKDB_MEMORY_LIMIT)}"
    )
    connection.execute(f"SET temp_directory = {quote_sql_text(temp_directory)}")
    connection.execute("SET threads = 2")
    connection.execute("SET preserve_insertion_order = true")
    rows = 0
    columns: list[str] = []
    numeric_seen: set[str] = set()
    key_mapping: dict[str, str] = {}
    try:
        for chunk_index, raw_chunk in enumerate(_read_chunks(path, encoding, separator)):
            if raw_chunk.empty and chunk_index == 0:
                raise ValueError(f"CSV 为空：{path.name}")
            chunk, current_mapping = add_internal_columns(raw_chunk, trace_id, rows + 1)
            if chunk_index == 0:
                columns = [str(column) for column in raw_chunk.columns]
                key_mapping = current_mapping
            numeric_seen.update(infer_numeric_columns(raw_chunk, ID_LIKE_COLUMNS))
            rows += int(len(chunk))
            connection.register("chunk_frame", chunk)
            if chunk_index == 0:
                connection.execute("CREATE TABLE data AS SELECT * FROM chunk_frame")
            else:
                connection.execute("INSERT INTO data BY NAME SELECT * FROM chunk_frame")
            connection.unregister("chunk_frame")
            pct = min(99.0, rows / max(estimated_rows, 1) * 100.0)
            progress.update(
                source_key,
                pct,
                rows,
                "reading",
                f"{source_key} 已读取 {rows:,} 行（约 {pct:.1f}%）· {path.name}",
            )
        connection.execute("CHECKPOINT")
    finally:
        connection.close()

    database_bytes = sum(
        item.stat().st_size
        for item in database_path.parent.glob(database_path.name + "*")
        if item.is_file()
    )
    numeric_columns = [column for column in columns if column in numeric_seen]
    result = {
        **source,
        "status": "ready",
        "rows": rows,
        "estimated_rows": estimated_rows,
        "database_path": str(database_path),
        "database_bytes": database_bytes,
        "encoding": encoding,
        "separator": separator,
        "columns": columns,
        "numeric_columns": numeric_columns,
        "key_mapping": key_mapping,
    }
    session.update_source(source_key, **result)
    progress.update(
        source_key,
        100,
        rows,
        "ready",
        f"{source_key} 读取完成：{rows:,} 行 · {path.name}",
    )
    return result


def ingest_t396_source(
    session: SessionState,
    task_id: str,
    source_key: str,
    source: dict[str, Any],
    progress: ProgressAggregator,
) -> dict[str, Any]:
    path = Path(source["path"])
    encoding, separator = detect_csv_format(path)
    estimated_rows = estimate_total_rows(path)
    session.update_source(
        source_key,
        **source,
        status="reading",
        rows=0,
        estimated_rows=estimated_rows,
        encoding=encoding,
        separator=separator,
        storage="aggregate-only",
    )
    totals: dict[str, dict[str, float]] = {}
    rows = 0
    columns: list[str] = []
    for chunk_index, chunk in enumerate(_read_chunks(path, encoding, separator)):
        chunk.columns = [str(column).strip() for column in chunk.columns]
        if chunk_index == 0:
            columns = list(map(str, chunk.columns))
            missing = [column for column in T396_REQUIRED_COLUMNS if column not in chunk.columns]
            if missing:
                raise ValueError(f"T396 缺少字段：{', '.join(missing)}")
        rows += int(len(chunk))
        work = chunk[T396_REQUIRED_COLUMNS].copy()
        work["user_id"] = normalize_series(work["dlAmbr"])
        work["vol"] = pd.to_numeric(work["dlThpVolRmvLastSlot"], errors="coerce")
        work["time"] = pd.to_numeric(work["dlThpTimeRmvLastSlot"], errors="coerce")
        work = work[work["user_id"].notna()]
        grouped = work.groupby("user_id", dropna=False).agg(
            sum_vol=("vol", "sum"),
            sum_time=("time", "sum"),
            rows=("user_id", "size"),
        )
        for user_id, values in grouped.iterrows():
            current = totals.setdefault(
                str(user_id), {"sum_vol": 0.0, "sum_time": 0.0, "rows": 0.0}
            )
            current["sum_vol"] += (
                float(values["sum_vol"]) if pd.notna(values["sum_vol"]) else 0.0
            )
            current["sum_time"] += (
                float(values["sum_time"]) if pd.notna(values["sum_time"]) else 0.0
            )
            current["rows"] += (
                float(values["rows"]) if pd.notna(values["rows"]) else 0.0
            )
        pct = min(99.0, rows / max(estimated_rows, 1) * 100.0)
        progress.update(
            source_key,
            pct,
            rows,
            "reading",
            f"{source_key} 已聚合 {rows:,} 行（约 {pct:.1f}%）· {path.name}",
        )

    aggregate_rows = []
    for user_id, values in totals.items():
        sum_time = float(values["sum_time"])
        rate = float(values["sum_vol"]) / sum_time if sum_time > 0 else None
        aggregate_rows.append(
            {
                "user_id": user_id,
                "sum_vol": float(values["sum_vol"]),
                "sum_time": sum_time,
                "rows": int(values["rows"]),
                "rate": rate,
            }
        )
    aggregate_rows.sort(key=lambda row: (-row["sum_time"], row["user_id"]))
    result = {
        **source,
        "status": "ready",
        "rows": rows,
        "estimated_rows": estimated_rows,
        "columns": columns,
        "numeric_columns": [],
        "storage": "aggregate-only",
        "aggregate_rows": aggregate_rows,
    }
    session.update_source(source_key, **result)
    progress.update(
        source_key,
        100,
        rows,
        "ready",
        f"{source_key} 聚合完成：{rows:,} 行 · {len(aggregate_rows)} 个用户",
    )
    return result


def build_t396_comparison(
    aggregate_a: list[dict[str, Any]], aggregate_b: list[dict[str, Any]]
) -> dict[str, Any]:
    by_a = {str(row["user_id"]): row for row in aggregate_a}
    by_b = {str(row["user_id"]): row for row in aggregate_b}
    users = sorted(
        set(by_a) | set(by_b),
        key=lambda value: (
            -(float(by_a.get(value, {}).get("sum_time", 0)) + float(by_b.get(value, {}).get("sum_time", 0))),
            value,
        ),
    )
    rows: list[dict[str, Any]] = []
    for user in users:
        rate_a = by_a.get(user, {}).get("rate")
        rate_b = by_b.get(user, {}).get("rate")
        diff_pct = (
            (float(rate_b) - float(rate_a)) / float(rate_a) * 100
            if rate_a not in (None, 0) and rate_b is not None
            else None
        )
        rows.append(
            {
                "user_id": user,
                "rate_a": rate_a,
                "rate_b": rate_b,
                "diff_pct": diff_pct,
                "sum_time_a": by_a.get(user, {}).get("sum_time"),
                "sum_time_b": by_b.get(user, {}).get("sum_time"),
            }
        )

    def cell_rate(items: list[dict[str, Any]]) -> Optional[float]:
        total_vol = sum(float(row.get("sum_vol") or 0) for row in items)
        total_time = sum(float(row.get("sum_time") or 0) for row in items)
        return total_vol / total_time if total_time > 0 else None

    rate_a = cell_rate(aggregate_a)
    rate_b = cell_rate(aggregate_b)
    diff_pct = (
        (float(rate_b) - float(rate_a)) / float(rate_a) * 100
        if rate_a not in (None, 0) and rate_b is not None
        else None
    )
    return {
        "available": bool(aggregate_a or aggregate_b),
        "cell_rate_a": rate_a,
        "cell_rate_b": rate_b,
        "diff_pct": diff_pct,
        "users_a": len(aggregate_a),
        "users_b": len(aggregate_b),
        "rows": rows,
    }


def run_ingest_task(
    session: SessionState,
    task_id: str,
    sources: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    if not sources:
        raise ValueError("方案 A/B 均为空，没有可读取的文件。")
    available = get_memory_info().get("sys_avail")
    if available is not None and available < MIN_AVAILABLE_MEMORY_BYTES:
        raise MemoryError(
            f"系统可用内存仅 {available / 1024 ** 3:.2f} GB，低于读取安全线。"
            "请先关闭其他高内存程序或清理旧会话缓存。"
        )
    progress = ProgressAggregator(task_id, sources)
    for source_key, source in sources.items():
        TASKS.update_file(
            task_id,
            source_key,
            status="queued",
            pct=0,
            rows=0,
            name=source.get("name"),
            path=source.get("path"),
            size=source.get("size"),
            trace_id=source.get("trace_id"),
            side=source.get("side"),
        )
    results: dict[str, dict[str, Any]] = {}
    errors: list[Exception] = []
    with ThreadPoolExecutor(max_workers=min(MAX_READ_WORKERS, len(sources))) as pool:
        futures = {}
        for source_key, source in sources.items():
            worker = ingest_t396_source if source.get("trace_id") == "396" else ingest_table_source
            future = pool.submit(session_worker_guard, worker, session, task_id, source_key, source, progress)
            futures[future] = source_key
        for future in as_completed(futures):
            source_key = futures[future]
            try:
                results[source_key] = future.result()
            except Exception as exc:
                TASKS.update_file(task_id, source_key, status="error", detail=str(exc))
                errors.append(exc)
    if errors:
        raise errors[0]

    TASKS.update(task_id, pct=91, title="整理字段与 T396 结果", detail="读取完成，正在生成字段清单与速率对比。")
    aggregate_a = results.get("A396", {}).get("aggregate_rows", [])
    aggregate_b = results.get("B396", {}).get("aggregate_rows", [])
    comparison = build_t396_comparison(aggregate_a, aggregate_b)
    schemas: dict[str, Any] = {}
    for trace_id in ("537", "714"):
        side_sources = [
            result for key, result in results.items() if key.endswith(trace_id)
        ]
        columns: list[str] = []
        numeric: list[str] = []
        for result in side_sources:
            for column in result.get("columns", []):
                if column not in columns:
                    columns.append(column)
            for column in result.get("numeric_columns", []):
                if column not in numeric:
                    numeric.append(column)
        defaults = [
            column
            for column in (DEFAULT_537_COLUMNS if trace_id == "537" else DEFAULT_714_COLUMNS)
            if column in columns
        ]
        schemas[trace_id] = {
            "columns": columns,
            "numeric_columns": numeric,
            "default_columns": defaults,
        }

    session.update(
        phase="read",
        selection=session.manifest.get("selection", {}),
        schemas=schemas,
        t396=comparison,
    )
    return {
        "session_id": session.session_id,
        "phase": "read",
        "sources": {key: _public_source(result) for key, result in results.items()},
        "schemas": schemas,
        "t396": comparison,
    }


def session_worker_guard(worker, *args):
    return worker(*args)


def _public_source(source: dict[str, Any]) -> dict[str, Any]:
    return {
        key: value
        for key, value in source.items()
        if key not in {"aggregate_rows"}
    }


def _cast_expression(
    alias: str,
    column: str,
    output_name: str,
    numeric_columns: set[str],
) -> str:
    source = f"{alias}.{quote_ident(column)}"
    output = quote_ident(output_name)
    if column in numeric_columns:
        return f"TRY_CAST(NULLIF({source}, '') AS DOUBLE) AS {output}"
    return f"NULLIF({source}, '') AS {output}"


def _null_expression(output_name: str, numeric: bool) -> str:
    sql_type = "DOUBLE" if numeric else "VARCHAR"
    return f"CAST(NULL AS {sql_type}) AS {quote_ident(output_name)}"


def _attach(connection: duckdb.DuckDBPyConnection, path: Path, alias: str) -> None:
    connection.execute(
        f"ATTACH {quote_sql_text(path)} AS {quote_ident(alias)} (READ_ONLY)"
    )


def merge_side(
    connection: duckdb.DuckDBPyConnection,
    session: SessionState,
    side: str,
    selected_537: list[str],
    selected_714: list[str],
    row_limit: int,
) -> Optional[dict[str, Any]]:
    source_537 = session.manifest.get("sources", {}).get(f"{side}537")
    source_714 = session.manifest.get("sources", {}).get(f"{side}714")
    table_name = f"merged_{side.lower()}"
    connection.execute(f"DROP TABLE IF EXISTS {quote_ident(table_name)}")
    if not source_537 or source_537.get("status") != "ready":
        return None

    alias_537 = f"src_{side.lower()}537"
    _attach(connection, Path(source_537["database_path"]), alias_537)
    if source_714 and source_714.get("status") == "ready":
        alias_714 = f"src_{side.lower()}714"
        _attach(connection, Path(source_714["database_path"]), alias_714)
    else:
        alias_714 = None

    columns_537 = list(source_537.get("columns") or [])
    columns_714 = list(source_714.get("columns") or []) if source_714 else []
    numeric_537 = set(source_537.get("numeric_columns") or [])
    numeric_714 = set(source_714.get("numeric_columns") or []) if source_714 else set()
    selected_537 = [column for column in selected_537 if column in columns_537]
    known_714_columns = set(
        session.manifest.get("schemas", {}).get("714", {}).get("columns", [])
    )
    allowed_714_columns = set(columns_714) | known_714_columns
    selected_714 = [
        column for column in selected_714 if column in allowed_714_columns
    ]
    key_mapping_537 = source_537.get("key_mapping") or {}
    for key_column in key_mapping_537.values():
        if key_column in columns_537 and key_column not in selected_537:
            selected_537.insert(0, key_column)
    # TTI and ambr are downstream analysis axes. Keep them even when they are
    # hidden from the interested-column list so quick plots remain available
    # without forcing another full merge.
    for analysis_column in ("tti", "ambr"):
        if analysis_column in columns_537 and analysis_column not in selected_537:
            selected_537.append(analysis_column)

    anchor_select = ["a.__source_row", *[f"a.{quote_ident(column)}" for column in KEY_INTERNAL_COLUMNS]]
    anchor_select.extend(
        _cast_expression("a", column, column, numeric_537)
        for column in selected_537
    )
    anchor_limit = f"WHERE a.__source_row <= {int(row_limit)}" if row_limit > 0 else ""

    if alias_714:
        link_select = [
            *[f"l.{quote_ident(column)}" for column in KEY_INTERNAL_COLUMNS],
            "l.__source_row",
        ]
        link_select.extend(
            _cast_expression("l", column, f"714_{column}", numeric_714)
            for column in selected_714
        )
        partition = ", ".join(quote_ident(column) for column in KEY_INTERNAL_COLUMNS)
        output_714 = [f"link.{quote_ident(f'714_{column}')}" for column in selected_714]
        select_714_sql = ",\n                    ".join(output_714)
        if select_714_sql:
            select_714_sql = ",\n                    " + select_714_sql
        create_sql = f"""
            CREATE TABLE {quote_ident(table_name)} AS
            WITH anchor AS (
                SELECT {', '.join(anchor_select)}
                FROM {quote_ident(alias_537)}.data a
                {anchor_limit}
            ),
            link_ranked AS (
                SELECT {', '.join(link_select)},
                       COUNT(*) OVER (PARTITION BY {partition}) AS __candidate_rows,
                       ROW_NUMBER() OVER (PARTITION BY {partition} ORDER BY l.__source_row) AS __rank
                FROM {quote_ident(alias_714)}.data l
                WHERE l.__key_crnti IS NOT NULL
                  AND l.__key_time IS NOT NULL
                  AND l.__key_frm IS NOT NULL
                  AND l.__key_slot IS NOT NULL
            ),
            link AS (SELECT * FROM link_ranked WHERE __rank = 1)
            SELECT anchor.*,
                   CASE WHEN link.__source_row IS NULL THEN 'NaN' ELSE '已匹配' END AS "714_匹配状态",
                   COALESCE(link.__candidate_rows, 0) AS "714_候选行数",
                   link.__source_row AS "714_来源行号"
                   {select_714_sql}
            FROM anchor
            LEFT JOIN link
              ON anchor.__key_crnti = link.__key_crnti
             AND anchor.__key_time = link.__key_time
             AND anchor.__key_frm = link.__key_frm
             AND anchor.__key_slot = link.__key_slot
            ORDER BY anchor.__source_row
        """
        connection.execute(create_sql)
        duplicate_keys = int(
            connection.execute(
                f"""
                SELECT COUNT(*) FROM (
                    SELECT {partition}, COUNT(*) AS n
                    FROM {quote_ident(alias_714)}.data
                    WHERE __key_crnti IS NOT NULL AND __key_time IS NOT NULL
                      AND __key_frm IS NOT NULL AND __key_slot IS NOT NULL
                    GROUP BY {partition}
                    HAVING COUNT(*) > 1
                )
                """
            ).fetchone()[0]
        )
    else:
        null_columns = [
            _null_expression(f"714_{column}", column in numeric_714)
            for column in selected_714
        ]
        null_sql = ",\n                   ".join(null_columns)
        if null_sql:
            null_sql = ",\n                   " + null_sql
        connection.execute(
            f"""
            CREATE TABLE {quote_ident(table_name)} AS
            WITH anchor AS (
                SELECT {', '.join(anchor_select)}
                FROM {quote_ident(alias_537)}.data a
                {anchor_limit}
            )
            SELECT anchor.*,
                   'NaN' AS "714_匹配状态",
                   0::BIGINT AS "714_候选行数",
                   NULL::BIGINT AS "714_来源行号"
                   {null_sql}
            FROM anchor
            ORDER BY anchor.__source_row
            """
        )
        duplicate_keys = 0

    for source_name, output_name in (
        ("mcsOffset[0]", "714_mcsOffset0_scaled"),
        ("compOlla", "714_compOlla_scaled"),
    ):
        prefixed = f"714_{source_name}"
        table_columns = {
            row[1]
            for row in connection.execute(
                f"PRAGMA table_info({quote_sql_text(table_name)})"
            ).fetchall()
        }
        if prefixed in table_columns:
            connection.execute(
                f"ALTER TABLE {quote_ident(table_name)} ADD COLUMN {quote_ident(output_name)} DOUBLE"
            )
            connection.execute(
                f"UPDATE {quote_ident(table_name)} SET {quote_ident(output_name)} = "
                f"TRY_CAST({quote_ident(prefixed)} AS DOUBLE) / {SCALE_714}"
            )

    anchor_rows, matched_rows = connection.execute(
        f"SELECT COUNT(*), COUNT(*) FILTER (WHERE {quote_ident('714_匹配状态')} = '已匹配') "
        f"FROM {quote_ident(table_name)}"
    ).fetchone()
    return {
        "side": side,
        "table": table_name,
        "anchor_rows": int(anchor_rows),
        "matched_rows": int(matched_rows),
        "nan_rows": int(anchor_rows - matched_rows),
        "match_rate": float(matched_rows / anchor_rows * 100) if anchor_rows else 0.0,
        "duplicate_714_keys": duplicate_keys,
        "has_714": bool(alias_714),
    }


def run_merge_task(
    session: SessionState,
    task_id: str,
    selected_537: list[str],
    selected_714: list[str],
    row_limit: int,
) -> dict[str, Any]:
    with session.db_lock:
        return _run_merge_task_locked(
            session, task_id, selected_537, selected_714, row_limit
        )


def _run_merge_task_locked(
    session: SessionState,
    task_id: str,
    selected_537: list[str],
    selected_714: list[str],
    row_limit: int,
) -> dict[str, Any]:
    TASKS.update(task_id, pct=5, title="准备汇总", detail="正在检查连接字段与选择列。")
    session.database_path.parent.mkdir(parents=True, exist_ok=True)
    connection = duckdb.connect(str(session.database_path))
    temp_directory = session.directory / "tmp" / "analysis"
    temp_directory.mkdir(parents=True, exist_ok=True)
    connection.execute(
        f"SET memory_limit = {quote_sql_text(ANALYSIS_DUCKDB_MEMORY_LIMIT)}"
    )
    connection.execute(f"SET temp_directory = {quote_sql_text(temp_directory)}")
    connection.execute("SET threads = 2")
    try:
        TASKS.update(task_id, pct=18, detail="正在生成方案 A 汇总表。")
        stats_a = merge_side(
            connection, session, "A", selected_537, selected_714, int(row_limit or 0)
        )
        TASKS.update(task_id, pct=57, detail="正在生成方案 B 汇总表。")
        stats_b = merge_side(
            connection, session, "B", selected_537, selected_714, int(row_limit or 0)
        )
        if stats_a is None and stats_b is None:
            raise ValueError("方案 A/B 均缺少 T537，无法建立汇总数据集。")
        TASKS.update(task_id, pct=88, detail="正在整理字段类型与可绘图指标。")
        sides: dict[str, Any] = {}
        common_columns: Optional[set[str]] = None
        common_numeric: Optional[set[str]] = None
        for side, stats in (("A", stats_a), ("B", stats_b)):
            if stats is None:
                continue
            info = connection.execute(
                f"PRAGMA table_info({quote_sql_text(stats['table'])})"
            ).fetchall()
            columns = [row[1] for row in info if not str(row[1]).startswith("__")]
            numeric = [
                row[1]
                for row in info
                if not str(row[1]).startswith("__")
                and any(token in str(row[2]).upper() for token in ("INT", "DOUBLE", "FLOAT", "DECIMAL", "REAL"))
                and row[1] not in {"714_候选行数", "714_来源行号"}
            ]
            sides[side] = {**stats, "columns": columns, "numeric_columns": numeric}
            common_columns = set(columns) if common_columns is None else common_columns & set(columns)
            common_numeric = set(numeric) if common_numeric is None else common_numeric & set(numeric)
        ordered_common = [
            column
            for column in (sides.get("A") or sides.get("B"))["columns"]
            if column in (common_columns or set())
        ]
        ordered_numeric = [
            column
            for column in (sides.get("A") or sides.get("B"))["numeric_columns"]
            if column in (common_numeric or set())
        ]
        default_metrics = [
            column
            for column in [
                "cw0SuMcs",
                "tb0SchMcs",
                "schRank",
                "usrschpdschDrbData",
                "714_mcsOffset0_scaled",
                "714_compOlla_scaled",
                "714_ack0",
            ]
            if column in ordered_numeric
        ]
        merge_manifest = {
            "row_limit": int(row_limit or 0),
            "selected_537": selected_537,
            "selected_714": selected_714,
            "sides": sides,
            "common_columns": ordered_common,
            "numeric_columns": ordered_numeric,
            "default_metrics": default_metrics,
        }
        session.update(phase="merged", merge=merge_manifest)
        return {
            "session_id": session.session_id,
            "phase": "merged",
            **merge_manifest,
            "t396": session.manifest.get("t396", {}),
        }
    finally:
        connection.close()
