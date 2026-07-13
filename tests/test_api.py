from __future__ import annotations

import time
from pathlib import Path

from wireless_trace_viewer_app import create_app
from wireless_trace_viewer_app.state import TASKS

from .test_core import make_fixture


def wait_task(client, task_id: str, timeout: float = 20.0) -> dict:
    started = time.time()
    while time.time() - started < timeout:
        response = client.get(f"/api/task/status/{task_id}")
        assert response.status_code == 200
        payload = response.get_json()
        if payload["status"] in {"done", "error"}:
            return payload
        time.sleep(0.05)
    raise AssertionError("后端任务在测试超时前未结束")


def test_flask_api_async_workflow_and_diagnostics(tmp_path: Path) -> None:
    root_a = tmp_path / "scheme_a"
    root_b = tmp_path / "scheme_b"
    root_a.mkdir()
    root_b.mkdir()
    make_fixture(root_a)
    make_fixture(root_b)
    app = create_app()
    app.testing = True
    client = app.test_client()

    page = client.get("/")
    assert page.status_code == 200
    assert "Trace A/B 分析" in page.get_data(as_text=True)

    remote = client.get("/", environ_base={"REMOTE_ADDR": "192.0.2.10"})
    assert remote.status_code == 403
    assert "仅允许本机访问" in remote.get_json()["error"]

    scan = client.post(
        "/api/scan",
        json={"path_a": str(root_a), "path_b": str(root_b), "recursive": True},
    )
    assert scan.status_code == 200
    scan_data = scan.get_json()
    assert scan_data["catalog"]["mode"] == "dual-directory"
    assert scan_data["selection"]["A"] == scan_data["selection"]["B"]
    assert scan_data["catalog"]["side_catalogs"]["A"]["file_count"] == 7
    assert scan_data["catalog"]["side_catalogs"]["B"]["file_count"] == 7
    session_id = scan_data["session_id"]

    kpi_start = client.post(
        "/api/task/start",
        json={
            "action": "kpi396",
            "session_id": session_id,
            "groups": [
                {
                    "id": "api-kpi-1",
                    "label": "API 小区对比",
                    "a_batch_id": scan_data["selection"]["A"],
                    "b_batch_id": scan_data["selection"]["B"],
                }
            ],
        },
    )
    kpi_task = wait_task(client, kpi_start.get_json()["task_id"])
    assert kpi_task["status"] == "done", kpi_task
    assert kpi_task["result"]["phase"] == "kpi396"
    assert len(kpi_task["result"]["sources"]) == 2
    assert all(source["trace_id"] == "396" for source in kpi_task["result"]["sources"].values())

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
            "row_limit": 0,
        },
    )
    merge_task = wait_task(client, merge_start.get_json()["task_id"])
    assert merge_task["status"] == "done", merge_task

    options = client.post(f"/api/session/{session_id}/filter-options", json={})
    assert options.status_code == 200
    assert "5001" in options.get_json()["options"]["ambr"]

    query = client.post(
        f"/api/session/{session_id}/query",
        json={
            "side": "A",
            "page": 1,
            "page_size": 100,
            "filters": [{"column": "ambr", "op": "eq", "value": "5001"}],
        },
    )
    assert query.status_code == 200
    assert query.get_json()["filtered_rows"] == 1

    invalid = client.post(
        "/api/task/start",
        json={"action": "merge", "session_id": session_id, "columns_537": []},
    )
    assert invalid.status_code == 400
    invalid_data = invalid.get_json()
    assert invalid_data["diagnosis"]["reason"]
    assert invalid_data["diagnosis"]["actions"]

    memory = client.get(f"/api/memory/status?session_id={session_id}")
    assert memory.status_code == 200
    assert memory.get_json()["session_bytes"] > 0

    def hold_task(_task_id: str) -> dict:
        time.sleep(0.15)
        return {"held": True}

    hold_id = TASKS.start("hold", session_id, hold_task)
    blocked_clear = client.post(f"/api/session/{session_id}/clear", json={})
    assert blocked_clear.status_code == 400
    assert "任务运行" in blocked_clear.get_json()["error"]
    assert wait_task(client, hold_id)["status"] == "done"

    cleared = client.post(f"/api/session/{session_id}/clear", json={})
    assert cleared.status_code == 200
    assert cleared.get_json()["cleared"] is True
