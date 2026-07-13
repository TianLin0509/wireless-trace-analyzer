from __future__ import annotations

import csv
import ctypes
import json
import math
import re
from pathlib import Path
from typing import Any, Iterable, Optional

import numpy as np
import pandas as pd
from plotly.utils import PlotlyJSONEncoder


TRACE_RE = re.compile(r"Dest_T(?P<trace>\d{3,4})(?=_)", re.IGNORECASE)
TAIL_TS_RE = re.compile(r"_(?P<ts>\d{14})$")
ANY_TS_RE = re.compile(r"(?P<ts>20\d{12})")
TRACE_INDEX_RE = re.compile(r"(?:^|_)trace_(?P<index>\d+)(?:_|$)", re.IGNORECASE)


class _MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_ulong),
        ("dwMemoryLoad", ctypes.c_ulong),
        ("ullTotalPhys", ctypes.c_ulonglong),
        ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong),
        ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong),
        ("ullAvailVirtual", ctypes.c_ulonglong),
        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]


class _PROCESS_MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("cb", ctypes.c_ulong),
        ("PageFaultCount", ctypes.c_ulong),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


def get_memory_info() -> dict[str, Optional[int]]:
    total = available = rss = None
    try:
        status = _MEMORYSTATUSEX()
        status.dwLength = ctypes.sizeof(_MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            total = int(status.ullTotalPhys)
            available = int(status.ullAvailPhys)
    except Exception:
        pass
    try:
        counters = _PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(_PROCESS_MEMORY_COUNTERS)
        if ctypes.windll.psapi.GetProcessMemoryInfo(
            ctypes.c_void_p(-1), ctypes.byref(counters), counters.cb
        ):
            rss = int(counters.WorkingSetSize)
    except Exception:
        pass
    return {"sys_total": total, "sys_avail": available, "process_rss": rss}


def resolve_path(raw: str) -> Path:
    if not raw or not str(raw).strip():
        raise ValueError("路径为空。")
    return Path(str(raw).strip().strip('"')).expanduser().resolve()


def format_timestamp(raw: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    if not raw or len(raw) != 14 or not raw.isdigit():
        return None, None
    full = (
        f"{raw[0:4]}-{raw[4:6]}-{raw[6:8]} "
        f"{raw[8:10]}:{raw[10:12]}:{raw[12:14]}"
    )
    short = f"{raw[4:6]}-{raw[6:8]} {raw[8:10]}:{raw[10:12]}:{raw[12:14]}"
    return full, short


def parse_trace_meta(path: Path) -> dict[str, Any]:
    stem = path.stem
    trace_match = TRACE_RE.search(stem)
    trace_id = trace_match.group("trace") if trace_match else None
    ts_match = TAIL_TS_RE.search(stem)
    if ts_match:
        timestamp = ts_match.group("ts")
    else:
        all_matches = list(ANY_TS_RE.finditer(stem))
        timestamp = all_matches[-1].group("ts") if all_matches else None
    index_match = TRACE_INDEX_RE.search(stem)
    trace_index = int(index_match.group("index")) if index_match else 999999
    time_full, time_short = format_timestamp(timestamp)
    return {
        "trace_id": trace_id,
        "trace_label": f"T{trace_id}" if trace_id else "未识别",
        "trace_index": trace_index,
        "test_time_raw": timestamp,
        "test_time": time_full,
        "test_time_short": time_short,
        "name": path.name,
        "path": str(path),
    }


def normalize_user_id(value: Any) -> Optional[str]:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    text = str(value).strip()
    if not text or text.lower() in {"nan", "none", "null"}:
        return None
    try:
        numeric = float(text)
        if math.isfinite(numeric) and numeric.is_integer():
            return str(int(numeric))
    except Exception:
        pass
    return text


def normalize_crnti_id(value: Any) -> Optional[str]:
    normalized = normalize_user_id(value)
    if normalized is None:
        return None
    match = re.search(r"0x[0-9a-fA-F]+", normalized)
    if match:
        try:
            return str(int(match.group(0), 16))
        except Exception:
            pass
    return normalized


def normalize_series(series: pd.Series, fn=normalize_user_id) -> pd.Series:
    unique_map = {value: fn(value) for value in pd.unique(series.dropna())}
    return series.map(unique_map)


def quote_ident(name: str) -> str:
    return '"' + str(name).replace('"', '""') + '"'


def quote_sql_text(value: str | Path) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def clean_scalar(value: Any) -> Any:
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except Exception:
        pass
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        return float(value) if np.isfinite(value) else None
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, (int, float, bool, str)):
        return value
    return str(value)


def records_from_frame(frame: pd.DataFrame) -> list[dict[str, Any]]:
    return [
        {str(key): clean_scalar(value) for key, value in row.items()}
        for row in frame.to_dict(orient="records")
    ]


def json_dumps(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, cls=PlotlyJSONEncoder)


def detect_csv_format(path: Path) -> tuple[str, str]:
    with path.open("rb") as handle:
        sample_bytes = handle.read(1024 * 1024)
    encodings = ["utf-8-sig", "utf-8", "gb18030", "gbk", "latin1"]
    decoded = ""
    encoding = "utf-8-sig"
    for candidate in encodings:
        try:
            decoded = sample_bytes.decode(candidate)
            encoding = candidate
            break
        except UnicodeDecodeError:
            continue
    separator = ","
    try:
        separator = csv.Sniffer().sniff(decoded[:65536], delimiters=[",", ";", "\t", "|"]).delimiter
    except Exception:
        counts = {item: decoded.count(item) for item in [",", ";", "\t", "|"]}
        separator = max(counts, key=counts.get) if decoded else ","
    return encoding, separator


def estimate_total_rows(path: Path) -> int:
    size = max(1, path.stat().st_size)
    with path.open("rb") as handle:
        sample = handle.read(min(size, 4 * 1024 * 1024))
    lines = max(1, sample.count(b"\n"))
    estimated = int(size / max(len(sample), 1) * lines)
    return max(1, estimated - 1)


def infer_numeric_columns(frame: pd.DataFrame, id_like: Iterable[str]) -> list[str]:
    id_set = {str(item).lower() for item in id_like}
    numeric: list[str] = []
    for column in frame.columns:
        name = str(column)
        if name.startswith("__") or name.lower() in id_set:
            continue
        values = frame[column].dropna()
        if values.empty:
            continue
        converted = pd.to_numeric(values.head(5000), errors="coerce")
        if converted.notna().mean() >= 0.92:
            numeric.append(name)
    return numeric
