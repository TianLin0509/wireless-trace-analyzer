from __future__ import annotations

import time
from pathlib import Path

from wireless_trace_viewer_app import create_app
from wireless_trace_viewer_app.merge_templates import MergeColumnTemplateStore
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


def test_match_batches_api_pairs_same_cell_across_cases(tmp_path: Path) -> None:
    root_a = tmp_path / "scheme_a"
    root_b = tmp_path / "scheme_b"
    for target in (
        root_a / "Case_A" / "Cell_001" / "ParseResult",
        root_a / "Case_A" / "Cell_002" / "ParseResult",
        root_b / "Case_B" / "Cell_001" / "ParseResult",
        root_b / "Case_B" / "Cell_003" / "ParseResult",
    ):
        target.mkdir(parents=True)
        make_fixture(target)

    app = create_app()
    app.testing = True
    client = app.test_client()
    scan = client.post(
        "/api/scan",
        json={"path_a": str(root_a), "path_b": str(root_b), "recursive": True},
    )
    assert scan.status_code == 200
    payload = scan.get_json()
    catalog = payload["catalog"]
    case_a = catalog["side_catalogs"]["A"]["case_groups"][0]["case_key"]
    case_b = catalog["side_catalogs"]["B"]["case_groups"][0]["case_key"]

    matched = client.post(
        f"/api/session/{payload['session_id']}/match-batches",
        json={
            "case_a": case_a,
            "case_b": case_b,
            "required_trace": "396",
            "max_pairs": 30,
        },
    )
    assert matched.status_code == 200
    result = matched.get_json()
    assert result["common_cell_count"] == 1
    assert [pair["cell_name"] for pair in result["pairs"]] == ["Cell_001"]
    assert result["unmatched_a"] == ["Cell_002"]
    assert result["unmatched_b"] == ["Cell_003"]

    cleared = client.post(f"/api/session/{payload['session_id']}/clear", json={})
    assert cleared.status_code == 200


def test_merge_column_template_api_persists_and_manages_templates(tmp_path: Path) -> None:
    template_path = tmp_path / "merge-column-templates.json"
    store = MergeColumnTemplateStore(template_path)
    app = create_app(template_store=store)
    app.testing = True
    client = app.test_client()

    empty = client.get("/api/merge-column-templates")
    assert empty.status_code == 200
    assert empty.get_json()["templates"] == []
    assert empty.get_json()["storage_path"] == str(template_path)

    created = client.post(
        "/api/merge-column-templates",
        json={
            "name": "MCS 常用字段",
            "columns_537": ["tti", "ambr", "cw0SuMcs", "tti"],
            "columns_714": ["ack0", "mcsOffset[0]", "ack0"],
        },
    )
    assert created.status_code == 201
    template = created.get_json()["template"]
    template_id = template["id"]
    assert template["columns_537"] == ["tti", "ambr", "cw0SuMcs"]
    assert template["columns_714"] == ["ack0", "mcsOffset[0]"]

    duplicate = client.post(
        "/api/merge-column-templates",
        json={
            "name": "mcs 常用字段",
            "columns_537": ["tti"],
            "columns_714": [],
        },
    )
    assert duplicate.status_code == 400
    assert "已存在" in duplicate.get_json()["error"]

    overwritten = client.post(
        f"/api/merge-column-templates/{template_id}",
        json={
            "columns_537": ["tti", "ambr", "tb0SchMcs"],
            "columns_714": ["ack0", "compOlla"],
        },
    )
    assert overwritten.status_code == 200
    assert overwritten.get_json()["template"]["columns_537"][-1] == "tb0SchMcs"

    renamed = client.post(
        f"/api/merge-column-templates/{template_id}",
        json={"name": "BLER 与 MCS"},
    )
    assert renamed.status_code == 200
    assert renamed.get_json()["template"]["name"] == "BLER 与 MCS"

    reloaded = MergeColumnTemplateStore(template_path).list_templates()
    assert len(reloaded) == 1
    assert reloaded[0]["name"] == "BLER 与 MCS"
    assert reloaded[0]["columns_714"] == ["ack0", "compOlla"]

    deleted = client.delete(f"/api/merge-column-templates/{template_id}")
    assert deleted.status_code == 200
    assert deleted.get_json()["deleted"] is True
    assert MergeColumnTemplateStore(template_path).list_templates() == []
