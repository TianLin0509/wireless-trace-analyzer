from __future__ import annotations

import math
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Optional

import duckdb
import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
from plotly.utils import PlotlyJSONEncoder
import json

from .config import (
    ANALYSIS_DUCKDB_MEMORY_LIMIT,
    BUILTIN_FILTER_COLUMNS,
    ID_LIKE_COLUMNS,
    MAX_CDF_POINTS,
    MAX_CHART_METRICS,
    MAX_CHART_POINTS,
    MAX_CHART_USERS,
    MAX_FILTER_UNIQUES,
    MAX_PAGE_SIZE,
)
from .state import SessionState, TASKS
from .utils import clean_scalar, quote_ident, quote_sql_text


COLOR_A = "#1d70b8"
COLOR_B = "#e26f3e"
COLOR_GRID = "#e3e8e4"


def _connect_read_only(session: SessionState) -> duckdb.DuckDBPyConnection:
    session.db_lock.acquire()
    try:
        connection = duckdb.connect(str(session.database_path), read_only=True)
        connection.execute(
            f"SET memory_limit = {quote_sql_text(ANALYSIS_DUCKDB_MEMORY_LIMIT)}"
        )
        connection.execute("SET threads = 2")
        return connection
    except Exception:
        session.db_lock.release()
        raise


def available_sides(session: SessionState) -> dict[str, dict[str, Any]]:
    return dict(session.manifest.get("merge", {}).get("sides") or {})


def side_table(session: SessionState, side: str) -> tuple[str, dict[str, Any]]:
    side = "B" if str(side).upper() == "B" else "A"
    metadata = available_sides(session).get(side)
    if not metadata:
        raise ValueError(f"方案 {side} 没有可用的 537 汇总表。")
    return str(metadata["table"]), metadata


def _filter_sql(
    filters: list[dict[str, Any]],
    allowed_columns: set[str],
    global_search: str = "",
) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    parameters: list[Any] = []
    for item in filters or []:
        column = str(item.get("column") or "")
        operator = str(item.get("op") or "eq")
        if column not in allowed_columns:
            continue
        identifier = quote_ident(column)
        value = item.get("value")
        if operator == "in":
            values = value if isinstance(value, list) else [value]
            values = [str(current) for current in values if str(current) != ""]
            if not values:
                continue
            placeholders = ",".join("?" for _ in values)
            clauses.append(f"CAST({identifier} AS VARCHAR) IN ({placeholders})")
            parameters.extend(values)
        elif operator == "contains":
            text = str(value or "").strip().lower()
            if text:
                clauses.append(
                    f"LOWER(COALESCE(CAST({identifier} AS VARCHAR), '')) LIKE ?"
                )
                parameters.append(f"%{text}%")
        elif operator in {"gt", "gte", "lt", "lte", "eq_num"}:
            token = {"gt": ">", "gte": ">=", "lt": "<", "lte": "<=", "eq_num": "="}[operator]
            clauses.append(f"TRY_CAST({identifier} AS DOUBLE) {token} ?")
            parameters.append(float(value))
        elif operator == "between":
            clauses.append(f"TRY_CAST({identifier} AS DOUBLE) BETWEEN ? AND ?")
            parameters.extend([float(value), float(item.get("value2"))])
        elif operator == "is_null":
            clauses.append(
                f"({identifier} IS NULL OR TRIM(CAST({identifier} AS VARCHAR)) = '' "
                f"OR LOWER(CAST({identifier} AS VARCHAR)) = 'nan')"
            )
        elif operator == "not_null":
            clauses.append(
                f"({identifier} IS NOT NULL AND TRIM(CAST({identifier} AS VARCHAR)) <> '' "
                f"AND LOWER(CAST({identifier} AS VARCHAR)) <> 'nan')"
            )
        else:
            clauses.append(f"CAST({identifier} AS VARCHAR) = ?")
            parameters.append(str(value))

    query = str(global_search or "").strip().lower()
    if query:
        searchable = [
            column
            for column in allowed_columns
            if not column.startswith("__")
        ][:40]
        if searchable:
            clauses.append(
                "("
                + " OR ".join(
                    f"LOWER(COALESCE(CAST({quote_ident(column)} AS VARCHAR), '')) LIKE ?"
                    for column in searchable
                )
                + ")"
            )
            parameters.extend([f"%{query}%"] * len(searchable))
    return (" AND ".join(clauses) if clauses else "TRUE"), parameters


def query_rows(
    session: SessionState,
    side: str,
    page: int,
    page_size: int,
    filters: list[dict[str, Any]],
    global_search: str,
    sort_column: Optional[str],
    sort_ascending: bool,
    visible_columns: Optional[list[str]] = None,
) -> dict[str, Any]:
    table, metadata = side_table(session, side)
    columns = list(metadata.get("columns") or [])
    allowed = set(columns)
    where_sql, parameters = _filter_sql(filters, allowed, global_search)
    page_size = max(50, min(MAX_PAGE_SIZE, int(page_size or 200)))
    connection = _connect_read_only(session)
    try:
        total_rows = int(
            connection.execute(f"SELECT COUNT(*) FROM {quote_ident(table)}").fetchone()[0]
        )
        filtered_rows = int(
            connection.execute(
                f"SELECT COUNT(*) FROM {quote_ident(table)} WHERE {where_sql}",
                parameters,
            ).fetchone()[0]
        )
        total_pages = max(1, math.ceil(filtered_rows / page_size))
        page = max(1, min(int(page or 1), total_pages))
        offset = (page - 1) * page_size
        order_sql = "ORDER BY __source_row"
        if sort_column and sort_column in allowed:
            order_sql = f"ORDER BY {quote_ident(sort_column)} {'ASC' if sort_ascending else 'DESC'} NULLS LAST"
        elif "tti" in allowed:
            tti = quote_ident("tti")
            order_sql = (
                f"ORDER BY TRY_CAST({tti} AS DOUBLE) ASC NULLS LAST, "
                f"CAST({tti} AS VARCHAR) ASC, __source_row ASC"
            )
        requested_columns = [
            str(column)
            for column in (visible_columns or [])
            if str(column) in allowed
        ]
        output_columns = requested_columns or columns
        visible_sql = ", ".join(quote_ident(column) for column in output_columns)
        frame = connection.execute(
            f"SELECT {visible_sql} FROM {quote_ident(table)} "
            f"WHERE {where_sql} {order_sql} LIMIT {page_size} OFFSET {offset}",
            parameters,
        ).fetch_df()
        rows = [
            {str(key): clean_scalar(value) for key, value in row.items()}
            for row in frame.to_dict(orient="records")
        ]
        return {
            "side": side,
            "columns": output_columns,
            "rows": rows,
            "total_rows": total_rows,
            "filtered_rows": filtered_rows,
            "page": page,
            "page_size": page_size,
            "total_pages": total_pages,
        }
    finally:
        try:
            connection.close()
        finally:
            session.db_lock.release()


def filter_options(
    session: SessionState,
    column: Optional[str] = None,
    search: str = "",
) -> dict[str, Any]:
    sides = available_sides(session)
    if not sides:
        raise ValueError("汇总数据尚未生成。")
    requested = [column] if column else BUILTIN_FILTER_COLUMNS
    output: dict[str, list[str]] = {}
    connection = _connect_read_only(session)
    try:
        for name in requested:
            if not name:
                continue
            values: set[str] = set()
            for metadata in sides.values():
                if name not in set(metadata.get("columns") or []):
                    continue
                where = f"{quote_ident(name)} IS NOT NULL"
                params: list[Any] = []
                if search:
                    where += f" AND LOWER(CAST({quote_ident(name)} AS VARCHAR)) LIKE ?"
                    params.append(f"%{search.lower()}%")
                rows = connection.execute(
                    f"SELECT DISTINCT CAST({quote_ident(name)} AS VARCHAR) AS value "
                    f"FROM {quote_ident(metadata['table'])} WHERE {where} "
                    f"LIMIT {MAX_FILTER_UNIQUES}",
                    params,
                ).fetchall()
                values.update(str(row[0]) for row in rows if row[0] not in (None, ""))
            output[name] = sorted(values, key=_natural_sort_key)[:MAX_FILTER_UNIQUES]
        common_columns = list(session.manifest.get("merge", {}).get("common_columns") or [])
        return {"options": output, "filter_columns": common_columns}
    finally:
        try:
            connection.close()
        finally:
            session.db_lock.release()


def _natural_sort_key(value: str):
    try:
        return (0, float(value), "")
    except Exception:
        return (1, 0.0, value)


def column_profile(
    session: SessionState,
    side: str,
    column: str,
    filters: list[dict[str, Any]],
    global_search: str = "",
    value_search: str = "",
) -> dict[str, Any]:
    """Return an Excel-style lightweight profile for one merged column.

    The column's own filter is deliberately removed while computing candidate
    values. Other active column filters and the global search remain in force,
    matching spreadsheet filter-menu behavior without loading the table into
    the browser.
    """

    table, metadata = side_table(session, side)
    columns = list(metadata.get("columns") or [])
    allowed = set(columns)
    if column not in allowed:
        raise ValueError(f"字段不存在或当前方案不可用：{column}")
    other_filters = [
        item for item in (filters or []) if str(item.get("column") or "") != column
    ]
    where_sql, parameters = _filter_sql(other_filters, allowed, global_search)
    identifier = quote_ident(column)
    nullish_sql = (
        f"({identifier} IS NULL OR TRIM(CAST({identifier} AS VARCHAR)) = '' "
        f"OR LOWER(CAST({identifier} AS VARCHAR)) = 'nan')"
    )
    numeric_columns = set(metadata.get("numeric_columns") or [])
    is_numeric = column in numeric_columns
    connection = _connect_read_only(session)
    try:
        base_row = connection.execute(
            f"""
            SELECT COUNT(*) AS row_count,
                   SUM(CASE WHEN {nullish_sql} THEN 1 ELSE 0 END) AS null_count,
                   COUNT(DISTINCT CASE WHEN NOT {nullish_sql}
                         THEN CAST({identifier} AS VARCHAR) END) AS distinct_count
            FROM {quote_ident(table)}
            WHERE {where_sql}
            """,
            parameters,
        ).fetchone()
        row_count = int(base_row[0] or 0)
        null_count = int(base_row[1] or 0)
        distinct_count = int(base_row[2] or 0)
        stats: dict[str, Any] = {}
        if is_numeric:
            stat_row = connection.execute(
                f"""
                SELECT COUNT(v), AVG(v), MIN(v), QUANTILE_CONT(v, 0.5),
                       QUANTILE_CONT(v, 0.9), MAX(v)
                FROM (
                    SELECT TRY_CAST({identifier} AS DOUBLE) AS v
                    FROM {quote_ident(table)}
                    WHERE {where_sql}
                )
                WHERE v IS NOT NULL
                """,
                parameters,
            ).fetchone()
            stats = {
                "numeric_count": int(stat_row[0] or 0),
                "mean": clean_scalar(stat_row[1]),
                "min": clean_scalar(stat_row[2]),
                "p50": clean_scalar(stat_row[3]),
                "p90": clean_scalar(stat_row[4]),
                "max": clean_scalar(stat_row[5]),
            }

        value_where = where_sql + f" AND NOT {nullish_sql}"
        value_parameters = list(parameters)
        search_text = str(value_search or "").strip().lower()
        if search_text:
            value_where += f" AND LOWER(CAST({identifier} AS VARCHAR)) LIKE ?"
            value_parameters.append(f"%{search_text}%")
        value_rows = connection.execute(
            f"""
            SELECT CAST({identifier} AS VARCHAR) AS value, COUNT(*) AS value_count
            FROM {quote_ident(table)}
            WHERE {value_where}
            GROUP BY value
            ORDER BY value_count DESC, value ASC
            LIMIT {MAX_FILTER_UNIQUES + 1}
            """,
            value_parameters,
        ).fetchall()
        has_more = len(value_rows) > MAX_FILTER_UNIQUES
        values = [
            {"value": str(row[0]), "count": int(row[1] or 0)}
            for row in value_rows[:MAX_FILTER_UNIQUES]
        ]
        return {
            "column": column,
            "side": side,
            "is_numeric": is_numeric,
            "is_identifier": column in ID_LIKE_COLUMNS,
            "row_count": row_count,
            "valid_count": row_count - null_count,
            "null_count": null_count,
            "distinct_count": distinct_count,
            "values": values,
            "has_more": has_more,
            **stats,
        }
    finally:
        try:
            connection.close()
        finally:
            session.db_lock.release()


def _side_where(
    session: SessionState,
    side: str,
    filters: list[dict[str, Any]],
    global_search: str = "",
) -> tuple[str, dict[str, Any], str, list[Any]]:
    table, metadata = side_table(session, side)
    where_sql, parameters = _filter_sql(
        filters, set(metadata.get("columns") or []), global_search
    )
    return table, metadata, where_sql, parameters


def _metric_stats(
    connection: duckdb.DuckDBPyConnection,
    table: str,
    metric: str,
    where_sql: str,
    parameters: list[Any],
) -> dict[str, Any]:
    identifier = quote_ident(metric)
    row = connection.execute(
        f"""
        SELECT COUNT(v), AVG(v), MIN(v),
               QUANTILE_CONT(v, 0.5), QUANTILE_CONT(v, 0.9), MAX(v)
        FROM (
            SELECT TRY_CAST({identifier} AS DOUBLE) AS v
            FROM {quote_ident(table)}
            WHERE {where_sql}
        ) WHERE v IS NOT NULL
        """,
        parameters,
    ).fetchone()
    return {
        "count": int(row[0] or 0),
        "mean": clean_scalar(row[1]),
        "min": clean_scalar(row[2]),
        "p50": clean_scalar(row[3]),
        "p90": clean_scalar(row[4]),
        "max": clean_scalar(row[5]),
    }


def _category_stats(
    connection: duckdb.DuckDBPyConnection,
    table: str,
    column: str,
    where_sql: str,
    parameters: list[Any],
) -> dict[str, Any]:
    identifier = quote_ident(column)
    row = connection.execute(
        f"""
        WITH values_only AS (
            SELECT NULLIF(TRIM(CAST({identifier} AS VARCHAR)), '') AS value
            FROM {quote_ident(table)}
            WHERE {where_sql}
        ), counts AS (
            SELECT value, COUNT(*) AS n
            FROM values_only
            WHERE value IS NOT NULL AND LOWER(value) <> 'nan'
            GROUP BY value
        )
        SELECT (SELECT COUNT(value) FROM values_only
                WHERE value IS NOT NULL AND LOWER(value) <> 'nan'),
               COUNT(*),
               FIRST(value ORDER BY n DESC, value ASC),
               MAX(n)
        FROM counts
        """,
        parameters,
    ).fetchone()
    valid_count = int(row[0] or 0)
    top_count = int(row[3] or 0)
    return {
        "count": valid_count,
        "unique": int(row[1] or 0),
        "top": clean_scalar(row[2]),
        "top_count": top_count,
        "top_ratio": (top_count / valid_count * 100.0) if valid_count else None,
    }


def _category_counts(
    connection: duckdb.DuckDBPyConnection,
    table: str,
    column: str,
    where_sql: str,
    parameters: list[Any],
    limit: int = 24,
) -> list[tuple[str, int]]:
    identifier = quote_ident(column)
    rows = connection.execute(
        f"""
        SELECT CASE
                   WHEN {identifier} IS NULL
                     OR TRIM(CAST({identifier} AS VARCHAR)) = ''
                     OR LOWER(CAST({identifier} AS VARCHAR)) = 'nan'
                   THEN 'NaN'
                   ELSE CAST({identifier} AS VARCHAR)
               END AS value,
               COUNT(*) AS n
        FROM {quote_ident(table)}
        WHERE {where_sql}
        GROUP BY value
        ORDER BY n DESC, value ASC
        LIMIT {max(1, int(limit))}
        """,
        parameters,
    ).fetchall()
    return [(str(row[0]), int(row[1] or 0)) for row in rows]


def _sequence_points(
    connection: duckdb.DuckDBPyConnection,
    table: str,
    metric: str,
    where_sql: str,
    parameters: list[Any],
    count: int,
    tti_column: Optional[str] = None,
) -> dict[str, Any]:
    stride = max(1, math.ceil(max(count, 1) / MAX_CHART_POINTS))
    identifier = quote_ident(metric)
    if tti_column:
        tti_identifier = quote_ident(tti_column)
        rows = connection.execute(
            f"""
            WITH ordered AS (
                SELECT TRY_CAST({tti_identifier} AS DOUBLE) AS x,
                       TRY_CAST({identifier} AS DOUBLE) AS y,
                       ROW_NUMBER() OVER (
                           ORDER BY TRY_CAST({tti_identifier} AS DOUBLE), __source_row
                       ) AS sequence_no
                FROM {quote_ident(table)}
                WHERE {where_sql}
                  AND TRY_CAST({identifier} AS DOUBLE) IS NOT NULL
                  AND TRY_CAST({tti_identifier} AS DOUBLE) IS NOT NULL
            )
            SELECT x, y
            FROM ordered
            WHERE ((sequence_no - 1) % {stride}) = 0
            ORDER BY sequence_no
            LIMIT {MAX_CHART_POINTS}
            """,
            parameters,
        ).fetchall()
        if rows:
            return {
                "x": [float(row[0]) for row in rows],
                "y": [float(row[1]) for row in rows],
                "x_title": "TTI",
            }

    rows = connection.execute(
        f"""
        SELECT TRY_CAST({identifier} AS DOUBLE) AS value
        FROM {quote_ident(table)}
        WHERE {where_sql}
          AND TRY_CAST({identifier} AS DOUBLE) IS NOT NULL
          AND ((__source_row - 1) % {stride}) = 0
        ORDER BY __source_row
        LIMIT {MAX_CHART_POINTS}
        """,
        parameters,
    ).fetchall()
    y_values = [float(row[0]) for row in rows]
    return {
        "x": list(range(1, len(y_values) + 1)),
        "y": y_values,
        "x_title": "采样序号",
    }


def _cdf_values(
    connection: duckdb.DuckDBPyConnection,
    table: str,
    metric: str,
    where_sql: str,
    parameters: list[Any],
    count: int,
) -> tuple[list[float], list[float]]:
    if count <= 0:
        return [], []
    buckets = max(1, min(MAX_CDF_POINTS, count))
    identifier = quote_ident(metric)
    rows = connection.execute(
        f"""
        WITH values_only AS (
            SELECT TRY_CAST({identifier} AS DOUBLE) AS value
            FROM {quote_ident(table)}
            WHERE {where_sql}
              AND TRY_CAST({identifier} AS DOUBLE) IS NOT NULL
        ), bucketed AS (
            SELECT value, NTILE({buckets}) OVER (ORDER BY value) AS bucket
            FROM values_only
        )
        SELECT AVG(value) AS x, MAX(bucket) * 100.0 / {buckets} AS y
        FROM bucketed
        GROUP BY bucket
        ORDER BY bucket
        """,
        parameters,
    ).fetchall()
    return [float(row[0]) for row in rows], [float(row[1]) for row in rows]


def _figure_payload(figure: go.Figure) -> dict[str, Any]:
    figure.update_layout(
        template="plotly_white",
        font={
            "family": '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",Arial,sans-serif',
            "size": 12,
            "color": "#18231e",
        },
        paper_bgcolor="#ffffff",
        plot_bgcolor="#ffffff",
        margin={"l": 58, "r": 24, "t": 72, "b": 52},
        legend={"orientation": "h", "y": 1.06, "x": 1, "xanchor": "right"},
    )
    figure.update_xaxes(gridcolor=COLOR_GRID, zeroline=False)
    figure.update_yaxes(gridcolor=COLOR_GRID, zeroline=False)
    return json.loads(json.dumps(figure, cls=PlotlyJSONEncoder))


def _format_t396_rate(value: Any) -> str:
    try:
        rate = float(value)
    except (TypeError, ValueError):
        return "-"
    if not math.isfinite(rate):
        return "-"
    return f"{rate:.6g}"


def _scope_subplot_title(scope: dict[str, Any], side: str) -> str:
    rate = _format_t396_rate((scope.get("rates") or {}).get(side))
    return f"{scope['label']} · 方案 {side}<br>T396 Rate {rate}"


def _split_sequence_figure(
    metric: str,
    scope_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    present = [
        side
        for side in ("A", "B")
        if any(side in row.get("values", {}) for row in scope_rows)
    ]
    row_count = max(1, len(scope_rows))
    figure = make_subplots(
        rows=row_count,
        cols=max(1, len(present)),
        horizontal_spacing=0.09,
        vertical_spacing=min(0.12, 0.5 / row_count),
        subplot_titles=[
            _scope_subplot_title(row, side)
            for row in scope_rows
            for side in present
        ],
    )
    colors = {"A": COLOR_A, "B": COLOR_B}
    for row_index, scope in enumerate(scope_rows, start=1):
        values = scope.get("values", {})
        for column_index, side in enumerate(present, start=1):
            side_values = values.get(side, {})
            x_values = side_values.get("x") or []
            y_values = side_values.get("y") or []
            x_title = str(side_values.get("x_title") or "采样序号")
            hover_x = "TTI" if x_title == "TTI" else "样本"
            rate = _format_t396_rate((scope.get("rates") or {}).get(side))
            figure.add_trace(
                go.Scatter(
                    x=x_values,
                    y=y_values,
                    mode="lines",
                    name=f"方案 {side}",
                    legendgroup=side,
                    showlegend=row_index == 1,
                    line={"color": colors[side], "width": 1.8},
                    hovertemplate=(
                        f"{scope['label']}<br>{hover_x}=%{{x}}<br>"
                        f"{metric}=%{{y}}<br>T396 Rate={rate}<extra></extra>"
                    ),
                ),
                row=row_index,
                col=column_index,
            )
            figure.update_xaxes(
                title_text=x_title, row=row_index, col=column_index
            )
            figure.update_yaxes(
                title_text=metric, row=row_index, col=column_index
            )
    uses_tti = any(
        str(item.get("x_title")) == "TTI"
        for row in scope_rows
        for item in row.get("values", {}).values()
    )
    figure.update_layout(
        title=f"{metric} · A/B {'TTI 升序' if uses_tti else '样本'}序列",
        height=max(520, 300 * row_count + 130),
    )
    return _figure_payload(figure)


def _split_cdf_figure(
    metric: str,
    scope_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    present = [
        side
        for side in ("A", "B")
        if any(side in row.get("values", {}) for row in scope_rows)
    ]
    row_count = max(1, len(scope_rows))
    figure = make_subplots(
        rows=row_count,
        cols=max(1, len(present)),
        horizontal_spacing=0.09,
        vertical_spacing=min(0.12, 0.5 / row_count),
        subplot_titles=[
            _scope_subplot_title(row, side)
            for row in scope_rows
            for side in present
        ],
    )
    colors = {"A": COLOR_A, "B": COLOR_B}
    for row_index, scope in enumerate(scope_rows, start=1):
        cdfs = scope.get("values", {})
        for column_index, side in enumerate(present, start=1):
            x_values, y_values = cdfs.get(side, ([], []))
            rate = _format_t396_rate((scope.get("rates") or {}).get(side))
            figure.add_trace(
                go.Scatter(
                    x=x_values,
                    y=y_values,
                    mode="lines",
                    name=f"方案 {side}",
                    legendgroup=side,
                    showlegend=row_index == 1,
                    line={"color": colors[side], "width": 2},
                    hovertemplate=(
                        f"{scope['label']}<br>值=%{{x}}<br>"
                        f"CDF=%{{y:.2f}}%<br>T396 Rate={rate}<extra></extra>"
                    ),
                ),
                row=row_index,
                col=column_index,
            )
            figure.update_xaxes(
                title_text=metric, row=row_index, col=column_index
            )
            figure.update_yaxes(
                title_text="CDF (%)", row=row_index, col=column_index
            )
    figure.update_layout(
        title=f"{metric} · A/B CDF",
        height=max(520, 300 * row_count + 130),
    )
    return _figure_payload(figure)


def _category_frequency_figure(
    column: str,
    scope_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    present = [
        side
        for side in ("A", "B")
        if any(side in row.get("values", {}) for row in scope_rows)
    ]
    row_count = max(1, len(scope_rows))
    figure = make_subplots(
        rows=row_count,
        cols=max(1, len(present)),
        horizontal_spacing=0.09,
        vertical_spacing=min(0.12, 0.5 / row_count),
        subplot_titles=[
            _scope_subplot_title(row, side)
            for row in scope_rows
            for side in present
        ],
    )
    colors = {"A": COLOR_A, "B": COLOR_B}
    for row_index, scope in enumerate(scope_rows, start=1):
        counts = scope.get("values", {})
        for column_index, side in enumerate(present, start=1):
            rows = counts.get(side, [])
            rate = _format_t396_rate((scope.get("rates") or {}).get(side))
            figure.add_trace(
                go.Bar(
                    x=[value for value, _ in rows],
                    y=[count for _, count in rows],
                    name=f"方案 {side}",
                    legendgroup=side,
                    showlegend=row_index == 1,
                    marker_color=colors[side],
                    hovertemplate=(
                        f"{scope['label']}<br>取值=%{{x}}<br>"
                        f"行数=%{{y}}<br>T396 Rate={rate}<extra></extra>"
                    ),
                ),
                row=row_index,
                col=column_index,
            )
            figure.update_xaxes(
                title_text=column,
                tickangle=30,
                automargin=True,
                row=row_index,
                col=column_index,
            )
            figure.update_yaxes(
                title_text="行数", row=row_index, col=column_index
            )
    figure.update_layout(
        title=f"{column} · A/B 频次分布",
        height=max(500, 300 * row_count + 130),
    )
    return _figure_payload(figure)


def _bler_data(
    connection: duckdb.DuckDBPyConnection,
    table: str,
    metadata: dict[str, Any],
    where_sql: str,
    parameters: list[Any],
) -> dict[str, float]:
    columns = set(metadata.get("columns") or [])
    if "714_ack0" not in columns:
        return {}
    user_column = "ambr" if "ambr" in columns else None
    group_select = quote_ident(user_column) if user_column else "'小区'"
    group_by = f"GROUP BY {quote_ident(user_column)}" if user_column else ""
    rows = connection.execute(
        f"""
        SELECT CAST({group_select} AS VARCHAR) AS user_id,
               COUNT(*) FILTER (WHERE ack IN (0, 1)) AS valid_rows,
               1.0 - AVG(ack) FILTER (WHERE ack IN (0, 1)) AS bler
        FROM (
            SELECT *, TRY_CAST({quote_ident('714_ack0')} AS DOUBLE) AS ack
            FROM {quote_ident(table)}
            WHERE {where_sql}
        )
        {group_by}
        ORDER BY valid_rows DESC
        """,
        parameters,
    ).fetchall()
    return {
        str(row[0] or "小区"): float(row[2]) * 100
        for row in rows
        if row[2] is not None
    }


def _bler_figure(
    values: dict[str, dict[str, float]],
    rate_lookup: dict[str, dict[str, Any]],
) -> Optional[dict[str, Any]]:
    if not values:
        return None
    users: list[str] = []
    for side in ("A", "B"):
        for user in values.get(side, {}):
            if user not in users:
                users.append(user)
    figure = go.Figure()
    for side, color in (("A", COLOR_A), ("B", COLOR_B)):
        if side not in values:
            continue
        rates = [
            _format_t396_rate(rate_lookup.get(side, {}).get(user)) for user in users
        ]
        figure.add_trace(
            go.Bar(
                x=users,
                y=[values[side].get(user) for user in users],
                name=f"方案 {side}",
                marker_color=color,
                text=[f"Rate {rate}" for rate in rates],
                textposition="outside",
                cliponaxis=False,
                customdata=rates,
                hovertemplate=(
                    "用户=%{x}<br>BLER=%{y:.3f}%<br>"
                    "T396 Rate=%{customdata}<extra></extra>"
                ),
            )
        )
    figure.update_layout(
        title="BLER / 误码率 A/B 对比",
        barmode="group",
        xaxis_title="用户 ambr",
        yaxis_title="BLER (%)",
        height=480,
    )
    return _figure_payload(figure)


def _normalize_plot_users(user_values: Optional[list[Any]]) -> list[str]:
    users: list[str] = []
    seen: set[str] = set()
    for value in user_values or []:
        user = str(value).strip()
        if not user or user in seen:
            continue
        seen.add(user)
        users.append(user)
    if len(users) > MAX_CHART_USERS:
        raise ValueError(
            f"一次最多分析 {MAX_CHART_USERS} 个用户；请先在合并明细中缩小用户范围。"
        )
    return users


def _t396_rate_lookup(session: SessionState) -> dict[str, dict[str, Any]]:
    comparison = session.manifest.get("t396") or {}
    lookup: dict[str, dict[str, Any]] = {"A": {}, "B": {}}
    for side in ("A", "B"):
        lookup[side]["__CELL__"] = comparison.get(f"cell_rate_{side.lower()}")
    for row in comparison.get("rows") or []:
        user = str(row.get("user_id") or "").strip()
        if not user:
            continue
        lookup["A"][user] = row.get("rate_a")
        lookup["B"][user] = row.get("rate_b")
    return lookup


def run_plot_task(
    session: SessionState,
    task_id: str,
    metrics: list[str],
    filters: list[dict[str, Any]],
    global_search: str = "",
    user_values: Optional[list[Any]] = None,
) -> dict[str, Any]:
    merge_manifest = session.manifest.get("merge", {})
    allowed = set(merge_manifest.get("common_columns") or [])
    numeric_columns = set(merge_manifest.get("numeric_columns") or [])
    selected: list[str] = []
    for metric in metrics:
        if metric in allowed and metric not in selected:
            selected.append(metric)
    if not selected:
        raise ValueError("请至少选择一个可绘图数值字段。")
    if len(selected) > MAX_CHART_METRICS:
        raise ValueError(f"一次最多选择 {MAX_CHART_METRICS} 个画图字段。")

    users = _normalize_plot_users(user_values)
    rate_lookup = _t396_rate_lookup(session)
    scopes = (
        [{"label": f"ambr {user}", "user": user} for user in users]
        if users
        else [{"label": "小区全量", "user": None}]
    )

    connection = _connect_read_only(session)
    figures: dict[str, Any] = {}
    summary_rows: list[dict[str, Any]] = []
    bler_by_side: dict[str, dict[str, float]] = {}
    try:
        scope_contexts: list[dict[str, Any]] = []
        for scope in scopes:
            side_context: dict[
                str, tuple[str, dict[str, Any], str, list[Any]]
            ] = {}
            for side in available_sides(session):
                scope_filters = list(filters or [])
                if scope["user"] is not None:
                    _, metadata = side_table(session, side)
                    if "ambr" not in set(metadata.get("columns") or []):
                        continue
                    scope_filters.append(
                        {"column": "ambr", "op": "eq", "value": scope["user"]}
                    )
                side_context[side] = _side_where(
                    session, side, scope_filters, global_search=global_search
                )
            rate_key = scope["user"] if scope["user"] is not None else "__CELL__"
            scope_contexts.append(
                {
                    **scope,
                    "sides": side_context,
                    "rates": {
                        side: rate_lookup.get(side, {}).get(str(rate_key))
                        for side in side_context
                    },
                }
            )

        total_steps = max(1, len(selected) * len(scope_contexts))
        completed_steps = 0
        for index, metric in enumerate(selected, start=1):
            is_numeric_metric = metric in numeric_columns and metric not in ID_LIKE_COLUMNS
            if is_numeric_metric:
                sequence_rows: list[dict[str, Any]] = []
                cdf_rows: list[dict[str, Any]] = []
                for scope in scope_contexts:
                    completed_steps += 1
                    TASKS.update(
                        task_id,
                        pct=8 + completed_steps / total_steps * 78,
                        title="生成多用户 A/B 图表",
                        detail=(
                            f"正在生成 {scope['label']} · {metric} "
                            f"（{completed_steps}/{total_steps}）。"
                        ),
                    )
                    row = {
                        "scope": scope["label"],
                        "metric": metric,
                        "kind": "数值",
                    }
                    sequences: dict[str, dict[str, Any]] = {}
                    cdfs: dict[str, tuple[list[float], list[float]]] = {}
                    metric_stats: dict[str, dict[str, Any]] = {}
                    for side, (
                        table,
                        metadata,
                        where_sql,
                        parameters,
                    ) in scope["sides"].items():
                        if metric not in set(metadata.get("numeric_columns") or []):
                            continue
                        stats = _metric_stats(
                            connection, table, metric, where_sql, parameters
                        )
                        metric_stats[side] = stats
                        sequences[side] = _sequence_points(
                            connection,
                            table,
                            metric,
                            where_sql,
                            parameters,
                            int(stats["count"]),
                            tti_column=(
                                "tti"
                                if "tti" in set(metadata.get("columns") or [])
                                else None
                            ),
                        )
                        cdfs[side] = _cdf_values(
                            connection,
                            table,
                            metric,
                            where_sql,
                            parameters,
                            int(stats["count"]),
                        )
                    sequence_rows.append(
                        {
                            "label": scope["label"],
                            "values": sequences,
                            "rates": scope["rates"],
                        }
                    )
                    cdf_rows.append(
                        {
                            "label": scope["label"],
                            "values": cdfs,
                            "rates": scope["rates"],
                        }
                    )
                    for side in ("A", "B"):
                        for key, value in metric_stats.get(side, {}).items():
                            row[f"{side}_{key}"] = value
                    summary_rows.append(row)
                figures[f"{metric} · 序列"] = _split_sequence_figure(
                    metric, sequence_rows
                )
                figures[f"{metric} · CDF"] = _split_cdf_figure(metric, cdf_rows)
            else:
                category_rows: list[dict[str, Any]] = []
                for scope in scope_contexts:
                    completed_steps += 1
                    TASKS.update(
                        task_id,
                        pct=8 + completed_steps / total_steps * 78,
                        title="生成多用户 A/B 图表",
                        detail=(
                            f"正在生成 {scope['label']} · {metric} "
                            f"（{completed_steps}/{total_steps}）。"
                        ),
                    )
                    row = {
                        "scope": scope["label"],
                        "metric": metric,
                        "kind": "类别",
                    }
                    category_counts: dict[str, list[tuple[str, int]]] = {}
                    category_stats: dict[str, dict[str, Any]] = {}
                    for side, (
                        table,
                        metadata,
                        where_sql,
                        parameters,
                    ) in scope["sides"].items():
                        if metric not in set(metadata.get("columns") or []):
                            continue
                        category_stats[side] = _category_stats(
                            connection, table, metric, where_sql, parameters
                        )
                        category_counts[side] = _category_counts(
                            connection, table, metric, where_sql, parameters
                        )
                    category_rows.append(
                        {
                            "label": scope["label"],
                            "values": category_counts,
                            "rates": scope["rates"],
                        }
                    )
                    for side in ("A", "B"):
                        for key, value in category_stats.get(side, {}).items():
                            row[f"{side}_{key}"] = value
                    summary_rows.append(row)
                figures[f"{metric} · 频次"] = _category_frequency_figure(
                    metric, category_rows
                )

        for scope in scope_contexts:
            for side, (table, metadata, where_sql, parameters) in scope[
                "sides"
            ].items():
                data = _bler_data(
                    connection, table, metadata, where_sql, parameters
                )
                if data:
                    bler_by_side.setdefault(side, {}).update(data)
        bler_figure = _bler_figure(bler_by_side, rate_lookup)
        if bler_figure:
            figures["BLER · 并列柱形图"] = bler_figure
        return {
            "figures": figures,
            "summary_rows": summary_rows,
            "bler": bler_by_side,
            "user_values": users,
            "scopes": [scope["label"] for scope in scopes],
        }
    finally:
        try:
            connection.close()
        finally:
            session.db_lock.release()


def _export_select_expression(column: str, numeric_columns: set[str]) -> str:
    identifier = quote_ident(column)
    if column in numeric_columns:
        return identifier
    return (
        f"CASE WHEN {identifier} IS NULL THEN NULL "
        f"WHEN LEFT(CAST({identifier} AS VARCHAR), 1) IN ('=', '+', '-', '@') "
        f"THEN '''' || CAST({identifier} AS VARCHAR) "
        f"ELSE CAST({identifier} AS VARCHAR) END AS {identifier}"
    )


def export_filtered_csv(
    session: SessionState,
    side: str,
    filters: list[dict[str, Any]],
    global_search: str = "",
) -> Path:
    table, metadata = side_table(session, side)
    columns = list(metadata.get("columns") or [])
    where_sql, parameters = _filter_sql(filters, set(columns), global_search)
    export_dir = session.directory / "exports"
    export_dir.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex[:10]
    raw_path = export_dir / f"merge_{side}_{token}.raw.csv"
    final_path = export_dir / f"wireless_trace_merge_{side}_{time.strftime('%Y%m%d_%H%M%S')}.csv"
    numeric_columns = set(metadata.get("numeric_columns") or [])
    select_sql = ", ".join(
        _export_select_expression(column, numeric_columns) for column in columns
    )
    order_sql = ""
    if "tti" in columns:
        tti = quote_ident("tti")
        order_sql = (
            f" ORDER BY TRY_CAST({tti} AS DOUBLE) ASC NULLS LAST, "
            f"CAST({tti} AS VARCHAR) ASC, __source_row ASC"
        )
    connection = _connect_read_only(session)
    try:
        # COPY does not support bound parameters, so create a temporary filtered table using them.
        connection.execute("DROP TABLE IF EXISTS temp.export_rows")
        connection.execute(
            f"CREATE TEMP TABLE export_rows AS SELECT {select_sql} "
            f"FROM {quote_ident(table)} WHERE {where_sql}{order_sql}",
            parameters,
        )
        connection.execute(
            f"COPY export_rows TO {quote_sql_text(raw_path)} (HEADER, DELIMITER ',')"
        )
    finally:
        try:
            connection.close()
        finally:
            session.db_lock.release()
    with final_path.open("wb") as destination, raw_path.open("rb") as source:
        destination.write(b"\xef\xbb\xbf")
        shutil.copyfileobj(source, destination, length=1024 * 1024)
    raw_path.unlink(missing_ok=True)
    return final_path
