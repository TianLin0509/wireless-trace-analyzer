from __future__ import annotations

from pathlib import Path

import pandas as pd

from wireless_trace_viewer_app import create_app

from .test_api import wait_task
from .test_core import write_trace


def make_same_tti_fixture(root: Path) -> None:
    timestamp = "20260717100000"
    frame_537 = pd.DataFrame(
        [
            {
                "tti": 100,
                "crnti": 1001,
                "HH:MM:SS": "10:00:00",
                "frm": 20,
                "slotNo": 1,
                "ambr": 5001,
                "usrId": 1,
                "schType": "DL",
                "cw0SuMcs": 8,
            },
            {
                "tti": 100,
                "crnti": 1002,
                "HH:MM:SS": "10:00:00",
                "frm": 20,
                "slotNo": 1,
                "ambr": 5002,
                "usrId": 2,
                "schType": "DL",
                "cw0SuMcs": 24,
            },
            {
                "tti": 101,
                "crnti": 1003,
                "HH:MM:SS": "10:00:00",
                "frm": 20,
                "slotNo": 2,
                "ambr": 5003,
                "usrId": 3,
                "schType": "DL",
                "cw0SuMcs": 16,
            },
        ]
    )
    frame_714 = pd.DataFrame(
        [
            {
                "crnti": 1001,
                "HH:MM:SS": "10:00:00",
                "frm": 20,
                "slotNum": 1,
                "ack0": 0,
            },
            {
                "crnti": 1002,
                "HH:MM:SS": "10:00:00",
                "frm": 20,
                "slotNum": 1,
                "ack0": 1,
            },
            {
                "crnti": 1003,
                "HH:MM:SS": "10:00:00",
                "frm": 20,
                "slotNum": 2,
                "ack0": 1,
            },
        ]
    )
    write_trace(root, "537", timestamp, frame_537)
    write_trace(root, "714", timestamp, frame_714)


def test_full_merge_forces_all_537_rows_and_tti_preview_ignores_filters(
    tmp_path: Path,
) -> None:
    make_same_tti_fixture(tmp_path)
    app = create_app()
    app.testing = True
    client = app.test_client()

    scan = client.post(
        "/api/scan",
        json={"path_a": str(tmp_path), "path_b": "", "recursive": True},
    )
    assert scan.status_code == 200
    scan_data = scan.get_json()
    session_id = scan_data["session_id"]

    try:
        ingest_start = client.post(
            "/api/task/start",
            json={
                "action": "ingest",
                "session_id": session_id,
                "selection": scan_data["selection"],
            },
        )
        ingest_task = wait_task(client, ingest_start.get_json()["task_id"])
        assert ingest_task["status"] == "done", ingest_task
        schemas = ingest_task["result"]["schemas"]

        merge_start = client.post(
            "/api/task/start",
            json={
                "action": "merge",
                "session_id": session_id,
                "columns_537": schemas["537"]["default_columns"],
                "columns_714": schemas["714"]["default_columns"],
                # A stale sampling value must never weaken the explicit full mode.
                "row_limit": 1,
                "merge_all_rows": True,
            },
        )
        merge_task = wait_task(client, merge_start.get_json()["task_id"])
        assert merge_task["status"] == "done", merge_task
        assert merge_task["result"]["row_limit"] == 0
        assert merge_task["result"]["merge_mode"] == "full"
        assert merge_task["result"]["sides"]["A"]["anchor_rows"] == 3

        filtered = client.post(
            f"/api/session/{session_id}/query",
            json={
                "side": "A",
                "page": 1,
                "page_size": 100,
                "filters": [{"column": "ambr", "op": "eq", "value": "5001"}],
                "visible_columns": ["tti", "ambr", "cw0SuMcs"],
            },
        )
        assert filtered.status_code == 200
        assert filtered.get_json()["filtered_rows"] == 1

        preview = client.post(
            f"/api/session/{session_id}/tti-preview",
            json={
                "side": "A",
                "tti": "100",
                "visible_columns": ["cw0SuMcs"],
            },
        )
        assert preview.status_code == 200
        payload = preview.get_json()
        assert payload["filters_ignored"] is True
        assert payload["row_count"] == 2
        assert payload["user_count"] == 2
        assert payload["columns"][:3] == ["tti", "crnti", "HH:MM:SS"]
        assert {str(row["ambr"]) for row in payload["rows"]} == {"5001", "5002"}
        assert {int(row["cw0SuMcs"]) for row in payload["rows"]} == {8, 24}
    finally:
        client.post(f"/api/session/{session_id}/clear", json={})
