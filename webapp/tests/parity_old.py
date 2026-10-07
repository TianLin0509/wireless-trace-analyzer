"""旧版 Python 引擎在同一数据上的结果（作为对照基准）。
用法：python tests/parity_old.py <旧版仓库根目录> <A目录> <B目录> <小区名> <输出json>"""
import os, sys, json, tempfile
from pathlib import Path

repo, dir_a, dir_b, cell, out = sys.argv[1:6]
tmp = tempfile.mkdtemp(prefix="parity-old-")
os.environ["TRACE_V016_CACHE_DIR"] = tmp + "/cache"
os.environ["TRACE_USER_DATA_DIR"] = tmp + "/user"
sys.path.insert(0, repo)
from wireless_trace_viewer_app.catalog import scan_csv_files, build_dual_catalog, selected_sources  # noqa: E402
from wireless_trace_viewer_app.engine import run_ingest_task, run_merge_task  # noqa: E402
from wireless_trace_viewer_app.state import SESSIONS  # noqa: E402
from wireless_trace_viewer_app import queries  # noqa: E402
from wireless_trace_viewer_app.config import DEFAULT_537_COLUMNS, DEFAULT_714_COLUMNS  # noqa: E402

roots = {"A": Path(dir_a), "B": Path(dir_b)}
cat = build_dual_catalog({s: scan_csv_files(roots[s]) for s in "AB"}, roots)
sel = {s: next(b["batch_id"] for b in cat["side_catalogs"][s]["batches"] if b["cell_name"] == cell) for s in "AB"}
session = SESSIONS.create(roots["A"], cat, roots=roots)
session.update(selection=sel)
run_ingest_task(session, "p-ingest", selected_sources(cat, sel))
run_merge_task(session, "p-merge", selected_537=list(DEFAULT_537_COLUMNS), selected_714=list(DEFAULT_714_COLUMNS), row_limit=0)
t = session.manifest["t396"]
res = {"t396": {"cellA": t["cell_rate_a"], "cellB": t["cell_rate_b"],
                "users": {r["user_id"]: [r["rate_a"], r["rate_b"], r["time_share_a"], r["time_share_b"]] for r in t["rows"]}}}
sides = queries.available_sides(session)
res["merge"] = {s: {k: sides[s][k] for k in ("anchor_rows", "matched_rows", "duplicate_714_keys")} for s in sides}
con = queries._connect_read_only(session)
try:
    for s in sides:
        table = sides[s]["table"]
        for m in ("cw0SuMcs", "usrschpdschDrbData", "714_compOlla_scaled"):
            st = queries._metric_stats(con, table, m, "TRUE", [])
            res.setdefault("metrics", {}).setdefault(s, {})[m] = {k: st[k] for k in ("count", "mean", "p50", "p90", "min", "max")}
        st = queries._metric_stats(con, table, "cw0SuMcs", 'CAST("ambr" AS VARCHAR) = ?', ["5003"])
        res["metrics"][s]["cw0SuMcs@5003"] = {k: st[k] for k in ("count", "mean", "p50", "p90")}
        res.setdefault("bler", {})[s] = queries._bler_data(con, table, sides[s], "TRUE", [])
finally:
    con.close()
    session.db_lock.release()
json.dump(res, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print("ok", out)
