from __future__ import annotations

from pathlib import Path
from typing import Any

from .config import MAX_SCAN_FILES
from .utils import parse_trace_meta


SUPPORTED_TRACES = ("396", "537", "714")


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
                    "size": int(stat.st_size),
                    "mtime": float(stat.st_mtime),
                    "directory": str(path.parent),
                }
            )
        except OSError:
            continue
    return result


def build_catalog(files: list[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[str, dict[str, list[dict[str, Any]]]] = {}
    for file_meta in files:
        timestamp = str(file_meta.get("test_time_raw") or "unknown")
        trace_id = str(file_meta.get("trace_id") or "")
        grouped.setdefault(timestamp, {}).setdefault(trace_id, []).append(file_meta)

    batches: list[dict[str, Any]] = []
    for timestamp, trace_groups in grouped.items():
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
        batches.append(
            {
                "batch_id": timestamp,
                "test_time_raw": None if timestamp == "unknown" else timestamp,
                "test_time": first.get("test_time") or "未解析时间",
                "test_time_short": first.get("test_time_short") or "-",
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

    return {
        "files": files,
        "batches": batches,
        "batch_count": len(batches),
        "file_count": len(files),
        "default_selection": {"A": default_a, "B": default_b},
    }


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

    return {
        "mode": "dual-directory",
        "roots": root_payload,
        "side_catalogs": side_catalogs,
        "files": all_files,
        "file_count": sum(item["file_count"] for item in side_catalogs.values()),
        "batch_count": sum(item["batch_count"] for item in side_catalogs.values()),
        "default_selection": selection,
    }


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
