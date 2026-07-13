from __future__ import annotations

from datetime import datetime
from pathlib import Path
import re
from typing import Any

from .config import MAX_SCAN_FILES
from .utils import parse_trace_meta


SUPPORTED_TRACES = ("396", "537", "714")


def parse_result_context(path: Path, root: Path) -> dict[str, Any]:
    """Return a readable ParseResult hierarchy and a stable grouping key."""
    parse_result = next(
        (parent for parent in path.parents if parent.name.casefold() == "parseresult"),
        None,
    )
    if parse_result is None:
        return {
            "context_key": "",
            "context_path": "",
            "context_label": "",
            "context_parts": [],
            "case_key": "",
            "case_name": "",
            "case_path": "",
            "cell_key": "",
            "cell_name": "",
            "cell_path": "",
        }

    scan_root = root.parent if root.is_file() else root
    try:
        relative = parse_result.relative_to(scan_root)
        parts = list(relative.parts) if str(relative) != "." else []
    except ValueError:
        parts = []
    if not parts:
        # When the user scans ParseResult itself, retain enough parents to show
        # the cell and round instead of rendering a meaningless '.'.
        parts = list(parse_result.parts[-3:])
    resolved = str(parse_result.resolve())
    cell_dir = parse_result.parent
    case_dir = cell_dir.parent
    cell_path = str(cell_dir.resolve())
    case_path = str(case_dir.resolve())
    return {
        "context_key": resolved.casefold(),
        "context_path": resolved,
        "context_label": " / ".join(parts),
        "context_parts": parts,
        "case_key": case_path.casefold(),
        "case_name": case_dir.name,
        "case_path": case_path,
        "cell_key": cell_dir.name.casefold(),
        "cell_name": cell_dir.name,
        "cell_path": cell_path,
    }


def scan_csv_files(root: Path, recursive: bool = True) -> list[dict[str, Any]]:
    if not root.exists():
        raise FileNotFoundError(f"路径不存在：{root}")
    if root.is_file():
        if root.suffix.lower() != ".csv":
            raise ValueError("当前路径是文件，但不是 CSV。")
        paths = [root]
    elif root.is_dir():
        pattern = "**/*.csv" if recursive else "*.csv"
        paths = sorted(root.glob(pattern), key=lambda item: str(item).lower())
    else:
        raise ValueError("路径既不是文件也不是目录。")

    result: list[dict[str, Any]] = []
    for path in paths[:MAX_SCAN_FILES]:
        try:
            meta = parse_trace_meta(path)
            stat = path.stat()
            if meta.get("trace_id") not in SUPPORTED_TRACES:
                continue
            result.append(
                {
                    **meta,
                    **parse_result_context(path, root),
                    "size": int(stat.st_size),
                    "mtime": float(stat.st_mtime),
                    "directory": str(path.parent),
                }
            )
        except OSError:
            continue
    return result


def build_catalog(files: list[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[tuple[str, str], dict[str, list[dict[str, Any]]]] = {}
    for file_meta in files:
        timestamp = str(file_meta.get("test_time_raw") or "unknown")
        context_key = str(file_meta.get("context_key") or "")
        trace_id = str(file_meta.get("trace_id") or "")
        grouped.setdefault((context_key, timestamp), {}).setdefault(trace_id, []).append(file_meta)

    batches: list[dict[str, Any]] = []
    for (context_key, timestamp), trace_groups in grouped.items():
        trace_payload: dict[str, Any] = {}
        ignored_count = 0
        for trace_id in SUPPORTED_TRACES:
            candidates = sorted(
                trace_groups.get(trace_id, []),
                key=lambda item: (
                    int(item.get("trace_index", 999999)),
                    str(item.get("name", "")).lower(),
                ),
            )
            selected = candidates[0] if candidates else None
            ignored_count += max(0, len(candidates) - 1)
            trace_payload[trace_id] = {
                "selected": selected,
                "candidates": candidates,
                "candidate_count": len(candidates),
            }
        first = next(
            (
                item["selected"]
                for item in trace_payload.values()
                if item.get("selected")
            ),
            {},
        )
        available = [trace for trace in SUPPORTED_TRACES if trace_payload[trace]["selected"]]
        context_path = str(first.get("context_path") or "")
        batch_id = timestamp if not context_key else f"{context_path}::{timestamp}"
        batches.append(
            {
                "batch_id": batch_id,
                "test_time_raw": None if timestamp == "unknown" else timestamp,
                "test_time": first.get("test_time") or "未解析时间",
                "test_time_short": first.get("test_time_short") or "-",
                "context_path": context_path,
                "context_label": first.get("context_label") or "",
                "context_parts": first.get("context_parts") or [],
                "case_key": first.get("case_key") or "",
                "case_name": first.get("case_name") or "",
                "case_path": first.get("case_path") or "",
                "cell_key": first.get("cell_key") or "",
                "cell_name": first.get("cell_name") or "",
                "cell_path": first.get("cell_path") or "",
                "traces": trace_payload,
                "available_traces": available,
                "available_count": len(available),
                "ignored_fragment_count": ignored_count,
                "total_bytes": sum(
                    int(trace_payload[trace]["selected"].get("size", 0))
                    for trace in SUPPORTED_TRACES
                    if trace_payload[trace]["selected"]
                ),
            }
        )

    batches.sort(
        key=lambda batch: (
            batch.get("test_time_raw") is not None,
            str(batch.get("test_time_raw") or ""),
            str(batch.get("context_label") or ""),
        ),
        reverse=True,
    )
    known = [batch for batch in batches if batch.get("test_time_raw")]
    if len(known) >= 2:
        newest_two = sorted(known[:2], key=lambda item: str(item["test_time_raw"]))
        default_a = newest_two[0]["batch_id"]
        default_b = newest_two[1]["batch_id"]
    elif len(known) == 1:
        default_a = known[0]["batch_id"]
        default_b = None
    elif batches:
        default_a = batches[0]["batch_id"]
        default_b = None
    else:
        default_a = default_b = None

    case_map: dict[str, dict[str, Any]] = {}
    for batch in batches:
        case_key = str(batch.get("case_key") or "__unclassified__")
        case_entry = case_map.setdefault(
            case_key,
            {
                "case_key": "" if case_key == "__unclassified__" else case_key,
                "case_name": batch.get("case_name") or "未分类",
                "case_path": batch.get("case_path") or "",
                "batch_count": 0,
                "cells": {},
            },
        )
        case_entry["batch_count"] += 1
        cell_key = str(batch.get("cell_key") or "__unclassified__")
        cell_entry = case_entry["cells"].setdefault(
            cell_key,
            {
                "cell_key": "" if cell_key == "__unclassified__" else cell_key,
                "cell_name": batch.get("cell_name") or "未分类",
                "cell_path": batch.get("cell_path") or "",
                "batch_count": 0,
            },
        )
        cell_entry["batch_count"] += 1

    case_groups: list[dict[str, Any]] = []
    for entry in case_map.values():
        cells = sorted(
            entry.pop("cells").values(),
            key=lambda item: _natural_key(str(item.get("cell_name") or "")),
        )
        case_groups.append({**entry, "cell_count": len(cells), "cells": cells})
    case_groups.sort(key=lambda item: _natural_key(str(item.get("case_name") or "")))

    return {
        "files": files,
        "batches": batches,
        "batch_count": len(batches),
        "file_count": len(files),
        "case_groups": case_groups,
        "case_count": len([group for group in case_groups if group.get("case_key")]),
        "cell_count": len(
            {
                str(batch.get("cell_key"))
                for batch in batches
                if batch.get("cell_key")
            }
        ),
        "default_selection": {"A": default_a, "B": default_b},
    }


def _natural_key(value: str) -> tuple[Any, ...]:
    return tuple(
        int(part) if part.isdigit() else part.casefold()
        for part in re.split(r"(\d+)", value)
        if part != ""
    )


def _batch_epoch(batch: dict[str, Any]) -> float | None:
    raw = str(batch.get("test_time_raw") or "")
    try:
        return datetime.strptime(raw, "%Y%m%d%H%M%S").timestamp()
    except (TypeError, ValueError):
        return None


def _batch_source_paths(batch: dict[str, Any], required_trace: str | None) -> set[str]:
    trace_ids = (required_trace,) if required_trace else SUPPORTED_TRACES
    return {
        str(Path(str(selected["path"])).resolve()).casefold()
        for trace_id in trace_ids
        if (selected := batch.get("traces", {}).get(trace_id, {}).get("selected"))
        and selected.get("path")
    }


def _public_batch_reference(batch: dict[str, Any]) -> dict[str, Any]:
    return {
        key: batch.get(key)
        for key in (
            "batch_id",
            "test_time_raw",
            "test_time",
            "test_time_short",
            "context_label",
            "context_path",
            "case_key",
            "case_name",
            "case_path",
            "cell_key",
            "cell_name",
            "cell_path",
            "available_traces",
        )
    }


def _best_batch_pair(
    candidates_a: list[dict[str, Any]],
    candidates_b: list[dict[str, Any]],
    required_trace: str | None,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    ranked: list[tuple[tuple[Any, ...], dict[str, Any], dict[str, Any]]] = []
    for batch_a in candidates_a:
        paths_a = _batch_source_paths(batch_a, required_trace)
        for batch_b in candidates_b:
            paths_b = _batch_source_paths(batch_b, required_trace)
            if paths_a and paths_b and paths_a.intersection(paths_b):
                continue
            epoch_a = _batch_epoch(batch_a)
            epoch_b = _batch_epoch(batch_b)
            exact_time = bool(
                batch_a.get("test_time_raw")
                and batch_a.get("test_time_raw") == batch_b.get("test_time_raw")
            )
            gap = abs(epoch_a - epoch_b) if epoch_a is not None and epoch_b is not None else float("inf")
            newest = max(epoch_a or 0.0, epoch_b or 0.0)
            different_case = str(batch_a.get("case_name") or "").casefold() != str(
                batch_b.get("case_name") or ""
            ).casefold()
            score = (
                0 if different_case else 1,
                0 if exact_time else 1,
                gap,
                -newest,
                str(batch_a.get("batch_id") or ""),
                str(batch_b.get("batch_id") or ""),
            )
            ranked.append((score, batch_a, batch_b))
    if not ranked:
        return None
    _, batch_a, batch_b = min(ranked, key=lambda item: item[0])
    return batch_a, batch_b


def match_same_cell_batches(
    catalog: dict[str, Any],
    *,
    case_a: str = "",
    case_b: str = "",
    cell_key: str = "",
    required_trace: str | None = None,
    max_pairs: int = 30,
) -> dict[str, Any]:
    """Build one deterministic A/B pair per common cell, never a cartesian product."""
    if required_trace and required_trace not in SUPPORTED_TRACES:
        raise ValueError(f"不支持按 T{required_trace} 匹配。")
    max_pairs = max(1, min(100, int(max_pairs or 30)))
    side_catalogs = catalog.get("side_catalogs") or {"A": catalog, "B": catalog}

    def eligible(side: str, case_key: str) -> list[dict[str, Any]]:
        batches = side_catalogs.get(side, {}).get("batches", [])
        return [
            batch
            for batch in batches
            if batch.get("cell_key")
            and (not case_key or str(batch.get("case_key")) == str(case_key))
            and (not cell_key or str(batch.get("cell_key")) == str(cell_key))
            and (
                not required_trace
                or batch.get("traces", {}).get(required_trace, {}).get("selected")
            )
        ]

    batches_a = eligible("A", case_a)
    batches_b = eligible("B", case_b)

    def group_by_cell(batches: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
        grouped: dict[str, list[dict[str, Any]]] = {}
        for batch in batches:
            grouped.setdefault(str(batch["cell_key"]), []).append(batch)
        return grouped

    by_cell_a = group_by_cell(batches_a)
    by_cell_b = group_by_cell(batches_b)
    common_keys = sorted(
        by_cell_a.keys() & by_cell_b.keys(),
        key=lambda key: _natural_key(
            str((by_cell_a.get(key) or by_cell_b[key])[0].get("cell_name") or key)
        ),
    )
    pairs: list[dict[str, Any]] = []
    skipped_cells: list[str] = []
    for key in common_keys:
        best = _best_batch_pair(by_cell_a[key], by_cell_b[key], required_trace)
        if best is None:
            skipped_cells.append(str(by_cell_a[key][0].get("cell_name") or key))
            continue
        batch_a, batch_b = best
        cell_name = str(batch_a.get("cell_name") or batch_b.get("cell_name") or key)
        case_name_a = str(batch_a.get("case_name") or "方案 A")
        case_name_b = str(batch_b.get("case_name") or "方案 B")
        pairs.append(
            {
                "cell_key": key,
                "cell_name": cell_name,
                "label": f"{cell_name} · {case_name_a} vs {case_name_b}",
                "a_batch_id": batch_a.get("batch_id"),
                "b_batch_id": batch_b.get("batch_id"),
                "A": _public_batch_reference(batch_a),
                "B": _public_batch_reference(batch_b),
            }
        )

    unmatched_a = sorted(
        {
            str(items[0].get("cell_name") or key)
            for key, items in by_cell_a.items()
            if key not in by_cell_b
        },
        key=_natural_key,
    )
    unmatched_b = sorted(
        {
            str(items[0].get("cell_name") or key)
            for key, items in by_cell_b.items()
            if key not in by_cell_a
        },
        key=_natural_key,
    )
    return {
        "pairs": pairs[:max_pairs],
        "common_cell_count": len(pairs),
        "truncated": len(pairs) > max_pairs,
        "unmatched_a": unmatched_a,
        "unmatched_b": unmatched_b,
        "skipped_cells": skipped_cells,
        "case_a": case_a or None,
        "case_b": case_b or None,
        "required_trace": required_trace,
    }


def build_kpi_t396_plan(
    catalog: dict[str, Any],
    groups: list[dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    """Resolve multi-group KPI selections and de-duplicate physical T396 files."""
    if not groups:
        raise ValueError("KPI 概览至少需要一组 A/B 配置。")
    if len(groups) > 30:
        raise ValueError("KPI 概览单次最多配置 30 组 A/B。")

    sources: dict[str, dict[str, Any]] = {}
    source_key_by_path: dict[str, str] = {}
    resolved_groups: list[dict[str, Any]] = []

    def resolve_side(side: str, raw_batch_id: Any) -> dict[str, Any] | None:
        batch_id = str(raw_batch_id or "").strip()
        if not batch_id:
            return None
        side_catalog = (catalog.get("side_catalogs") or {}).get(side) or catalog
        batch = next(
            (
                item
                for item in side_catalog.get("batches", [])
                if str(item.get("batch_id")) == batch_id
            ),
            None,
        )
        if batch is None:
            raise ValueError(f"KPI 方案 {side} 的测试批次已不在扫描结果中。")
        selected = batch.get("traces", {}).get("396", {}).get("selected")
        reference = {
            "batch_id": batch_id,
            "test_time": batch.get("test_time"),
            "test_time_short": batch.get("test_time_short"),
            "context_label": batch.get("context_label") or "",
            "context_path": batch.get("context_path") or "",
            "case_key": batch.get("case_key") or "",
            "case_name": batch.get("case_name") or "",
            "case_path": batch.get("case_path") or "",
            "cell_key": batch.get("cell_key") or "",
            "cell_name": batch.get("cell_name") or "",
            "cell_path": batch.get("cell_path") or "",
            "source_key": None,
            "path": selected.get("path") if selected else None,
            "missing": selected is None,
        }
        if selected is None:
            return reference
        physical_path = str(Path(str(selected["path"])).resolve()).casefold()
        source_key = source_key_by_path.get(physical_path)
        if source_key is None:
            source_key = f"KPI{len(source_key_by_path) + 1:03d}"
            source_key_by_path[physical_path] = source_key
            sources[source_key] = {
                **selected,
                "side": "KPI",
                "trace_id": "396",
                "source_key": source_key,
            }
        reference["source_key"] = source_key
        return reference

    for index, group in enumerate(groups, start=1):
        group_id = str(group.get("id") or f"group-{index}")
        label = str(group.get("label") or f"对比组 {index}").strip() or f"对比组 {index}"
        side_a = resolve_side("A", group.get("a_batch_id"))
        side_b = resolve_side("B", group.get("b_batch_id"))
        available_keys = [
            side.get("source_key")
            for side in (side_a, side_b)
            if side and side.get("source_key")
        ]
        if not available_keys:
            raise ValueError(f"{label} 没有可读取的 T396 文件。")
        if side_a and side_b and side_a.get("path") and side_a.get("path") == side_b.get("path"):
            raise ValueError(f"{label} 的 A/B 指向同一个 T396 文件。")
        resolved_groups.append(
            {
                "id": group_id,
                "label": label,
                "A": side_a,
                "B": side_b,
            }
        )
    return sources, resolved_groups


def build_dual_catalog(
    files_by_side: dict[str, list[dict[str, Any]]],
    roots: dict[str, Path | None],
) -> dict[str, Any]:
    """Build independent catalogs for explicit scheme A/B directories."""
    side_catalogs: dict[str, dict[str, Any]] = {}
    all_files: list[dict[str, Any]] = []
    selection: dict[str, str | None] = {"A": None, "B": None}
    root_payload: dict[str, str | None] = {}

    for side in ("A", "B"):
        side_files = [
            {**item, "scheme": side} for item in files_by_side.get(side, [])
        ]
        catalog = build_catalog(side_files)
        root = roots.get(side)
        catalog["root"] = str(root) if root is not None else None
        side_catalogs[side] = catalog
        root_payload[side] = catalog["root"]
        all_files.extend(side_files)
        if catalog["batches"]:
            selection[side] = str(catalog["batches"][0]["batch_id"])

    payload = {
        "mode": "dual-directory",
        "roots": root_payload,
        "side_catalogs": side_catalogs,
        "files": all_files,
        "file_count": sum(item["file_count"] for item in side_catalogs.values()),
        "batch_count": sum(item["batch_count"] for item in side_catalogs.values()),
        "default_selection": selection,
    }
    default_match = match_same_cell_batches(payload, max_pairs=1)
    if default_match["pairs"]:
        pair = default_match["pairs"][0]
        selection["A"] = str(pair["a_batch_id"])
        selection["B"] = str(pair["b_batch_id"])
        payload["default_match"] = pair
    else:
        payload["default_match"] = None
    return payload


def selected_sources(
    catalog: dict[str, Any], selection: dict[str, str | None]
) -> dict[str, dict[str, Any]]:
    sources: dict[str, dict[str, Any]] = {}
    for side in ("A", "B"):
        side_catalog = (catalog.get("side_catalogs") or {}).get(side) or catalog
        batches = {
            str(batch.get("batch_id")): batch
            for batch in side_catalog.get("batches", [])
        }
        batch_id = selection.get(side)
        if not batch_id:
            continue
        batch = batches.get(str(batch_id))
        if batch is None:
            raise ValueError(f"方案 {side} 的测试时间不在当前扫描结果中。")
        for trace_id in SUPPORTED_TRACES:
            selected = batch["traces"][trace_id].get("selected")
            if selected:
                key = f"{side}{trace_id}"
                sources[key] = {
                    **selected,
                    "side": side,
                    "trace_id": trace_id,
                    "source_key": key,
                    "batch_id": batch_id,
                }
    return sources
