from __future__ import annotations

import time
from pathlib import Path

import duckdb
import pandas as pd
import pytest

from wireless_trace_viewer_app import create_app
import wireless_trace_viewer_app.app as app_module
from wireless_trace_viewer_app.analysis_recipes import AnalysisRecipeStore
from wireless_trace_viewer_app.catalog import build_catalog, scan_csv_files, selected_sources
from wireless_trace_viewer_app.engine import (
    build_kpi_regression_radar,
    build_t396_comparison,
    run_ingest_task,
    run_merge_task,
)
from wireless_trace_viewer_app.source_cache import SharedSourceCache
from wireless_trace_viewer_app.state import SESSIONS, TaskManager

from .test_core import make_fixture, write_trace


def _wait_manager_task(manager: TaskManager, task_id: str, timeout: float = 5.0) -> dict:
    started = time.time()
    while time.time() - started < timeout:
        task = manager.get(task_id)
        if task["status"] in {"done", "error", "cancelled", "interrupted"}:
            return task
        time.sleep(0.02)
    raise AssertionError("任务在测试超时前未结束")


def test_csv_quality_reports_rejected_rows_without_silent_loss(
    tmp_path: Path, monkeypatch
) -> None:
    import wireless_trace_viewer_app.engine as engine

    source_cache = SharedSourceCache(tmp_path / "shared-cache", max_bytes=64 * 1024**2)
    monkeypatch.setattr(engine, "SOURCE_CACHE", source_cache)
    timestamp = "20260715100000"
    path = tmp_path / f"Dest_T537_case_trace_0_{timestamp}.csv"
    path.write_text(
        "tti,crnti,HH:MM:SS,frm,slotNo,ambr,cw0SuMcs\n"
        "1,1001,10:00:00,10,1,5001,12\n"
        "2,1002,10:00:00,10,2,5002,14,EXTRA\n"
        "3,1003,10:00:00,10,3,5003,16\n",
        encoding="utf-8-sig",
    )
    catalog = build_catalog(scan_csv_files(tmp_path))
    session = SESSIONS.create(tmp_path, catalog)
    try:
        result = run_ingest_task(
            session,
            "quality-test",
            selected_sources(catalog, catalog["default_selection"]),
        )
        quality = result["sources"]["A537"]["quality"]
        assert quality["accepted_rows"] == 2
        assert quality["rejected_rows"] == 1
        assert quality["source_rows"] == 3
        assert quality["status"] == "warning"
        reject = quality["reject_samples"][0]
        assert reject["line"] == 3
        assert reject["expected_fields"] == 7
        assert reject["actual_fields"] == 8
        assert reject["raw_text"].endswith(",EXTRA")
        assert reject["connection_key_status"] == "key_present_unverified"
        assert reject["connection_key_values"] == {
            "crnti": "1002",
            "time": "10:00:00",
            "frm": "10",
            "slot": "2",
        }
        assert result["csv_quality"]["gate_required"] is True
        assert result["csv_quality"]["rejected_rows"] == 1
    finally:
        SESSIONS.clear(session.session_id)


def test_cross_session_source_cache_reuses_ready_database(
    tmp_path: Path, monkeypatch
) -> None:
    import wireless_trace_viewer_app.engine as engine

    source_cache = SharedSourceCache(tmp_path / "shared-cache", max_bytes=64 * 1024**2)
    monkeypatch.setattr(engine, "SOURCE_CACHE", source_cache)
    source_path = write_trace(
        tmp_path,
        "537",
        "20260715110000",
        pd.DataFrame(
            [
                {
                    "tti": 1,
                    "crnti": 1001,
                    "HH:MM:SS": "11:00:00",
                    "frm": 10,
                    "slotNo": 1,
                    "ambr": 5001,
                    "cw0SuMcs": 12,
                }
            ]
        ),
    )
    catalog = build_catalog(scan_csv_files(tmp_path))
    sources = selected_sources(catalog, catalog["default_selection"])
    first = SESSIONS.create(tmp_path, catalog)
    second = SESSIONS.create(tmp_path, catalog)
    try:
        first_result = run_ingest_task(first, "cache-first", sources)
        second_result = run_ingest_task(second, "cache-second", sources)
        first_source = first_result["sources"]["A537"]
        second_source = second_result["sources"]["A537"]
        assert first_source["cache_hit"] is False
        assert second_source["cache_hit"] is True
        assert "首次读取" in first_source["cache_reason"]
        assert "指纹一致" in second_source["cache_reason"]
        assert second_source["fingerprint"] == first_source["fingerprint"]
        assert second_source["database_path"] == first_source["database_path"]
        assert Path(second_source["database_path"]).is_file()
        assert source_cache.snapshot()["item_count"] == 1
        source_path.write_text(
            source_path.read_text(encoding="utf-8-sig") + "2,1002,11:00:00,10,2,5002,14\n",
            encoding="utf-8-sig",
        )
        changed_fingerprint = source_cache.fingerprint(source_path, "537")
        assert changed_fingerprint != first_source["fingerprint"]
        assert "已变化" in source_cache.miss_reason(
            source_path, changed_fingerprint, "537"
        )
    finally:
        SESSIONS.clear(first.session_id)
        SESSIONS.clear(second.session_id)


def test_task_manager_cancel_and_terminal_state_survive_reload(tmp_path: Path) -> None:
    manager = TaskManager(storage_root=tmp_path / "tasks")

    def worker(task_id: str) -> dict:
        for index in range(100):
            time.sleep(0.01)
            manager.raise_if_cancelled(task_id)
            manager.update(task_id, pct=index)
        return {"unexpected": True}

    task_id = manager.start(
        "ingest",
        "session-1",
        worker,
        request_payload={"action": "ingest", "selection": {"A": "batch-a"}},
    )
    assert manager.cancel(task_id) is True
    cancelled = _wait_manager_task(manager, task_id)
    assert cancelled["status"] == "cancelled"
    assert cancelled["request"]["selection"]["A"] == "batch-a"

    reloaded = TaskManager(storage_root=tmp_path / "tasks")
    restored = reloaded.get(task_id)
    assert restored["status"] == "cancelled"
    assert restored["restartable"] is True


def test_task_api_cancel_retry_and_recent_history(
    tmp_path: Path, monkeypatch
) -> None:
    manager = TaskManager(storage_root=tmp_path / "task-api")
    monkeypatch.setattr(app_module, "TASKS", manager)
    catalog = build_catalog([])
    session = SESSIONS.create(tmp_path, catalog)
    app = create_app()
    app.testing = True
    client = app.test_client()
    try:
        def cancellable(task_id: str) -> dict:
            while True:
                time.sleep(0.01)
                manager.raise_if_cancelled(task_id)

        cancel_id = manager.start(
            "plot",
            session.session_id,
            cancellable,
            request_payload={
                "action": "plot",
                "session_id": session.session_id,
                "metrics": ["cw0SuMcs"],
            },
        )
        cancelled_response = client.post(f"/api/task/{cancel_id}/cancel")
        assert cancelled_response.status_code == 200
        assert cancelled_response.get_json()["cancel_requested"] is True
        assert _wait_manager_task(manager, cancel_id)["status"] == "cancelled"

        failed_id = manager.start(
            "plot",
            session.session_id,
            lambda _task_id: (_ for _ in ()).throw(RuntimeError("expected failure")),
            request_payload={
                "action": "plot",
                "session_id": session.session_id,
                "metrics": ["cw0SuMcs"],
                "filters": [],
                "user_values": [],
            },
        )
        assert _wait_manager_task(manager, failed_id)["status"] == "error"
        retried = client.post(f"/api/task/{failed_id}/retry")
        assert retried.status_code == 200
        retry_payload = retried.get_json()
        assert retry_payload["retried_from"] == failed_id
        assert retry_payload["task_id"] != failed_id

        recent = client.get(f"/api/session/{session.session_id}/tasks")
        assert recent.status_code == 200
        recent_ids = {task["task_id"] for task in recent.get_json()["tasks"]}
        assert {cancel_id, failed_id, retry_payload["task_id"]} <= recent_ids
    finally:
        SESSIONS.clear(session.session_id)


def test_failed_remerge_keeps_previous_ready_tables_atomically(
    tmp_path: Path, monkeypatch
) -> None:
    import wireless_trace_viewer_app.engine as engine

    make_fixture(tmp_path)
    catalog = build_catalog(scan_csv_files(tmp_path))
    selection = catalog["default_selection"]
    session = SESSIONS.create(tmp_path, catalog)
    session.update(selection=selection)
    selected_537 = [
        "tti", "crnti", "HH:MM:SS", "frm", "slotNo", "ambr", "cw0SuMcs"
    ]
    selected_714 = ["ack0"]
    try:
        run_ingest_task(
            session,
            "atomic-ingest",
            selected_sources(catalog, selection),
        )
        first = run_merge_task(
            session,
            "atomic-first",
            selected_537,
            selected_714,
            row_limit=0,
        )
        assert first["sides"]["A"]["anchor_rows"] == 3

        original_merge_side = engine.merge_side

        def fail_on_b(*args, **kwargs):
            side = str(args[2])
            if side == "B":
                raise RuntimeError("simulated B merge failure")
            return original_merge_side(*args, **kwargs)

        monkeypatch.setattr(engine, "merge_side", fail_on_b)
        with pytest.raises(RuntimeError, match="simulated B merge failure"):
            run_merge_task(
                session,
                "atomic-second",
                selected_537,
                selected_714,
                row_limit=1,
            )

        connection = duckdb.connect(str(session.database_path), read_only=True)
        try:
            tables = {str(row[0]) for row in connection.execute("SHOW TABLES").fetchall()}
            assert "merged_a" in tables and "merged_b" in tables
            assert not any("__build_" in table for table in tables)
            assert connection.execute("SELECT COUNT(*) FROM merged_a").fetchone()[0] == 3
            assert connection.execute("SELECT COUNT(*) FROM merged_b").fetchone()[0] == 3
        finally:
            connection.close()
    finally:
        SESSIONS.clear(session.session_id)


def test_analysis_recipe_api_persists_complete_workspace(tmp_path: Path) -> None:
    store = AnalysisRecipeStore(tmp_path / "analysis-recipes.json")
    app = create_app(recipe_store=store)
    app.testing = True
    client = app.test_client()
    recipe_payload = {
        "name": "城区下行回归",
        "workspace": {
            "paths": {"A": "D:\\trace\\baseline", "B": "D:\\trace\\candidate"},
            "recursive": True,
            "selection": {"A": "batch-a", "B": "batch-b"},
            "source_refs": {
                "A537": {
                    "path": "D:\\trace\\baseline\\Dest_T537.csv",
                    "name": "Dest_T537.csv",
                    "fingerprint": "abc123",
                }
            },
            "columns": {"537": ["tti", "ambr", "cw0SuMcs"], "714": ["ack0"]},
            "row_limit": 0,
            "analysis": {
                "filters": [{"column": "schType", "op": "eq", "value": "DL"}],
                "users": ["5001", "5002"],
                "metrics": ["cw0SuMcs", "714_ack0"],
                "visible_columns": ["tti", "ambr", "cw0SuMcs", "714_ack0"],
                "pinned_columns": ["714_ack0", "cw0SuMcs"],
                "sort_column": "tti",
                "sort_ascending": True,
                "active_side": "A",
                "plot_size": {"width": 1200, "height": 720},
            },
        },
    }
    created = client.post("/api/analysis-recipes", json=recipe_payload)
    assert created.status_code == 201
    recipe = created.get_json()["recipe"]
    assert recipe["workspace"]["analysis"]["users"] == ["5001", "5002"]
    assert recipe["workspace"]["analysis"]["pinned_columns"] == ["714_ack0", "cw0SuMcs"]
    assert recipe["workspace"]["columns"]["537"][-1] == "cw0SuMcs"
    assert recipe["workspace"]["source_refs"]["A537"]["fingerprint"] == "abc123"

    listed = client.get("/api/analysis-recipes").get_json()
    assert listed["storage_path"] == str(store.path)
    assert [item["name"] for item in listed["recipes"]] == ["城区下行回归"]

    updated = client.post(
        f"/api/analysis-recipes/{recipe['id']}",
        json={"name": "城区下行回归 v2"},
    )
    assert updated.status_code == 200
    assert updated.get_json()["recipe"]["name"] == "城区下行回归 v2"

    deleted = client.delete(f"/api/analysis-recipes/{recipe['id']}")
    assert deleted.status_code == 200
    assert AnalysisRecipeStore(store.path).list_recipes() == []


def test_kpi_regression_radar_prioritizes_declines_and_impacted_users() -> None:
    def comparison(
        rates_a: list[tuple[str, float, float]],
        rates_b: list[tuple[str, float, float]],
    ) -> dict:
        return build_t396_comparison(
            [
                {
                    "user_id": user,
                    "sum_vol": rate * sample_time,
                    "sum_time": sample_time,
                    "rate": rate,
                    "rows": int(sample_time),
                }
                for user, rate, sample_time in rates_a
            ],
            [
                {
                    "user_id": user,
                    "sum_vol": rate * sample_time,
                    "sum_time": sample_time,
                    "rate": rate,
                    "rows": int(sample_time),
                }
                for user, rate, sample_time in rates_b
            ],
        )

    groups = [
        {
            "id": "improved",
            "label": "小区提升",
            "comparison": comparison(
                [("5001", 10, 1000)],
                [("5001", 12, 1000)],
            ),
        },
        {
            "id": "declined",
            "label": "小区回退",
            "comparison": comparison(
                [("6001", 20, 780), ("6002", 10, 420)],
                [("6001", 14, 748), ("6002", 9.5, 352)],
            ),
        },
    ]
    radar = build_kpi_regression_radar(groups)
    assert radar["ranked_groups"][0]["id"] == "declined"
    assert radar["ranked_groups"][0]["risk_level"] == "critical"
    assert radar["ranked_groups"][0]["top_regression_users"][0]["user_id"] == "6001"
    assert radar["ranked_groups"][0]["evidence_grade"] in {"高", "中"}
    assert radar["critical_count"] == 1
    assert radar["improved_count"] == 1
