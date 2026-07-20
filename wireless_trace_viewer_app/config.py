from __future__ import annotations

import os
from pathlib import Path


APP_VERSION = "v0.19.0 Codex"
APP_TITLE = f"无线外场 Trace A/B 分析台 {APP_VERSION}"

HOST = os.environ.get("TRACE_HOST", "127.0.0.1")
PORT = int(os.environ.get("TRACE_PORT", "3004"))

CACHE_ROOT = Path(
    os.environ.get(
        "TRACE_V016_CACHE_DIR",
        str(Path.home() / ".wireless_trace_cache" / "v016"),
    )
).expanduser()

USER_DATA_ROOT = Path(
    os.environ.get(
        "TRACE_USER_DATA_DIR",
        str(Path.home() / ".wireless_trace_analyzer"),
    )
).expanduser()
MERGE_COLUMN_TEMPLATE_PATH = USER_DATA_ROOT / "merge-column-templates.json"
ANALYSIS_RECIPE_PATH = USER_DATA_ROOT / "analysis-recipes.json"

SHARED_SOURCE_CACHE_ROOT = CACHE_ROOT / "_shared_sources"
TASK_STATE_ROOT = CACHE_ROOT / "_tasks"
SHARED_SOURCE_CACHE_MAX_BYTES = int(
    float(os.environ.get("TRACE_SHARED_CACHE_MAX_GB", "20")) * 1024 ** 3
)
SHARED_SOURCE_CACHE_TTL_SECONDS = int(
    float(os.environ.get("TRACE_SHARED_CACHE_TTL_DAYS", "14")) * 86400
)

MAX_SCAN_FILES = 5000
MAX_READ_WORKERS = max(1, min(4, int(os.environ.get("TRACE_READ_WORKERS", "2"))))
READ_CHUNK_ROWS = max(5000, int(os.environ.get("TRACE_READ_CHUNK_ROWS", "50000")))
SOURCE_DUCKDB_MEMORY_LIMIT = os.environ.get("TRACE_SOURCE_DB_MEMORY", "768MB")
ANALYSIS_DUCKDB_MEMORY_LIMIT = os.environ.get("TRACE_ANALYSIS_DB_MEMORY", "2GB")
MIN_AVAILABLE_MEMORY_BYTES = int(
    float(os.environ.get("TRACE_MIN_AVAILABLE_GB", "1")) * 1024 ** 3
)
SESSION_IDLE_TTL_SECONDS = int(os.environ.get("TRACE_SESSION_TTL_SECONDS", "7200"))
TASK_DONE_TTL_SECONDS = int(os.environ.get("TRACE_TASK_TTL_SECONDS", "86400"))
TASK_MAX_ITEMS = 80
MAX_PAGE_SIZE = 2000
MAX_FILTER_UNIQUES = 500
MAX_CHART_METRICS = 8
MAX_CHART_USERS = max(1, int(os.environ.get("TRACE_MAX_CHART_USERS", "100")))
MAX_CHART_POINTS = 3000
MAX_CDF_POINTS = 1600
MAX_CSV_REJECT_SAMPLES = 20

T396_REQUIRED_COLUMNS = [
    "dlAmbr",
    "dlThpVolRmvLastSlot",
    "dlThpTimeRmvLastSlot",
]

DEFAULT_537_COLUMNS = [
    "tti",
    "crnti",
    "HH:MM:SS",
    "frm",
    "slotNo",
    "ambr",
    "usrId",
    "schType",
    "suOrMuFlag",
    "jtMode",
    "cw0SuMcs",
    "tb0SchMcs",
    "schRank",
    "usrschpdschDrbData",
    "allocRbNum",
    "bandCqiCw0",
]

DEFAULT_714_COLUMNS = [
    "crnti",
    "HH:MM:SS",
    "frm",
    "slotNum",
    "ack0",
    "retansNum0",
    "isMuFlag",
    "mcsOffset[0]",
    "compOlla",
    "suRank",
    "rankRpt",
]

BUILTIN_FILTER_COLUMNS = [
    "ambr",
    "schType",
    "suOrMuFlag",
    "jtMode",
    "714_匹配状态",
]

ID_LIKE_COLUMNS = {
    "tti",
    "crnti",
    "ambr",
    "usrId",
    "HH:MM:SS",
    "frm",
    "slotNo",
    "slotNum",
    "rptTti",
}
