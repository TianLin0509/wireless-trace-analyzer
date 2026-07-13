from __future__ import annotations

import gc
import json
import os
import tempfile
import threading
import time
from pathlib import Path

import numpy as np
import pandas as pd

from wireless_trace_viewer_app.catalog import build_catalog, scan_csv_files, selected_sources
from wireless_trace_viewer_app.engine import run_ingest_task, run_merge_task
from wireless_trace_viewer_app.state import SESSIONS
from wireless_trace_viewer_app.utils import get_memory_info


def write_large_pair(root: Path, timestamp: str, rows: int, shift: int) -> None:
    chunk_size = 50_000
    paths = {
        "537": root / f"Dest_T537_bench_trace_0_{timestamp}.csv",
        "714": root / f"Dest_T714_bench_trace_0_{timestamp}.csv",
    }
    for start in range(0, rows, chunk_size):
        end = min(rows, start + chunk_size)
        index = np.arange(start, end, dtype=np.int64)
        common = {
            "crnti": 1000 + index % 1000,
            "HH:MM:SS": np.where(index % 2 == 0, "10:00:00", "10:00:01"),
            "frm": (index // 20) % 1024,
        }
        frame_537 = pd.DataFrame(
            {
                "tti": index,
                **common,
                "slotNo": index % 20,
                "ambr": 5000 + index % 1000,
                "schType": "DL",
                "suOrMuFlag": np.where(index % 3 == 0, "MU", "SU"),
                "jtMode": index % 2,
                "cw0SuMcs": 8 + (index + shift) % 20,
                "tb0SchMcs": 9 + (index + shift) % 20,
                "schRank": 1 + index % 2,
                "usrschpdschDrbData": 400 + index % 3000,
            }
        )
        frame_714 = pd.DataFrame(
            {
                **common,
                "slotNum": index % 20,
                "ack0": np.where(index % 10 == 0, 0, 1),
                "retansNum0": index % 3,
                "isMuFlag": index % 2,
                "mcsOffset[0]": ((index % 7) - 3) * 1024000,
                "compOlla": ((index % 9) - 4) * 512000,
            }
        )
        mode = "w" if start == 0 else "a"
        header = start == 0
        frame_537.to_csv(paths["537"], mode=mode, header=header, index=False, encoding="utf-8-sig" if start == 0 else "utf-8")
        frame_714.to_csv(paths["714"], mode=mode, header=header, index=False, encoding="utf-8-sig" if start == 0 else "utf-8")


def main() -> None:
    rows = int(os.environ.get("TRACE_BENCH_ROWS", "100000"))
    with tempfile.TemporaryDirectory(prefix="trace-v016-bench-") as directory:
        root = Path(directory)
        write_large_pair(root, "20260710100000", rows, 0)
        write_large_pair(root, "20260710110000", rows, 2)
        gc.collect()
        baseline = int(get_memory_info().get("process_rss") or 0)
        peak = baseline
        stop = threading.Event()

        def monitor() -> None:
            nonlocal peak
            while not stop.wait(0.05):
                peak = max(peak, int(get_memory_info().get("process_rss") or 0))

        thread = threading.Thread(target=monitor, daemon=True)
        thread.start()
        catalog = build_catalog(scan_csv_files(root))
        session = SESSIONS.create(root, catalog)
        started = time.perf_counter()
        try:
            selection = catalog["default_selection"]
            session.update(selection=selection)
            ingest = run_ingest_task(session, "bench-ingest", selected_sources(catalog, selection))
            merged = run_merge_task(
                session,
                "bench-merge",
                selected_537=ingest["schemas"]["537"]["default_columns"],
                selected_714=ingest["schemas"]["714"]["default_columns"],
                row_limit=0,
            )
            elapsed = time.perf_counter() - started
            disk_bytes = sum(path.stat().st_size for path in session.directory.rglob("*") if path.is_file())
            print(
                json.dumps(
                    {
                        "rows_per_side": rows,
                        "source_rows_total": rows * 4,
                        "elapsed_seconds": round(elapsed, 3),
                        "peak_rss_delta_mb": round(max(0, peak - baseline) / 1024 ** 2, 1),
                        "session_disk_mb": round(disk_bytes / 1024 ** 2, 1),
                        "A_match_rate": merged["sides"]["A"]["match_rate"],
                        "B_match_rate": merged["sides"]["B"]["match_rate"],
                    },
                    ensure_ascii=False,
                )
            )
        finally:
            stop.set()
            thread.join(timeout=1)
            SESSIONS.clear(session.session_id)


if __name__ == "__main__":
    main()
