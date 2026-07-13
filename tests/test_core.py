from __future__ import annotations

from pathlib import Path

import pandas as pd

from wireless_trace_viewer_app.catalog import (
    build_catalog,
    build_dual_catalog,
    scan_csv_files,
    selected_sources,
)
from wireless_trace_viewer_app.engine import (
    run_ingest_task,
    run_merge_task,
)
from wireless_trace_viewer_app.queries import (
    column_profile,
    export_filtered_csv,
    filter_options,
    query_rows,
    run_plot_task,
)
from wireless_trace_viewer_app.state import SESSIONS, TASKS


def write_trace(root: Path, trace: str, timestamp: str, frame: pd.DataFrame, index: int = 0) -> Path:
    path = root / f"Dest_T{trace}_case_trace_{index}_{timestamp}.csv"
    frame.to_csv(path, index=False, encoding="utf-8-sig")
    return path


def make_fixture(root: Path) -> None:
    for timestamp, shift in [("20260710090000", 0), ("20260710100000", 2)]:
        frame_537 = pd.DataFrame(
            [
                {"tti": 1, "crnti": 1001, "HH:MM:SS": "09:00:00", "frm": 10, "slotNo": 1, "ambr": 5001, "schType": "DL", "suOrMuFlag": "SU", "jtMode": 0, "cw0SuMcs": 10 + shift, "tb0SchMcs": 11 + shift, "schRank": 1, "usrschpdschDrbData": 800},
                {"tti": 2, "crnti": 1002, "HH:MM:SS": "09:00:00", "frm": 10, "slotNo": 2, "ambr": 5002, "schType": "DL", "suOrMuFlag": "MU", "jtMode": 0, "cw0SuMcs": 15 + shift, "tb0SchMcs": 16 + shift, "schRank": 2, "usrschpdschDrbData": 1200},
                {"tti": 3, "crnti": 1003, "HH:MM:SS": "09:00:00", "frm": 10, "slotNo": 3, "ambr": 5003, "schType": "DL", "suOrMuFlag": "SU", "jtMode": 1, "cw0SuMcs": 20 + shift, "tb0SchMcs": 21 + shift, "schRank": 1, "usrschpdschDrbData": 1600},
            ]
        )
        frame_714 = pd.DataFrame(
            [
                {"crnti": 1001, "HH:MM:SS": "09:00:00", "frm": 10, "slotNum": 1, "ack0": 1, "retansNum0": 0, "isMuFlag": 0, "mcsOffset[0]": 1024000, "compOlla": 512000},
                {"crnti": 1002, "HH:MM:SS": "09:00:00", "frm": 10, "slotNum": 2, "ack0": 0, "retansNum0": 1, "isMuFlag": 1, "mcsOffset[0]": 2048000, "compOlla": 1024000},
                {"crnti": 1002, "HH:MM:SS": "09:00:00", "frm": 10, "slotNum": 2, "ack0": 1, "retansNum0": 1, "isMuFlag": 1, "mcsOffset[0]": 3072000, "compOlla": 2048000},
            ]
        )
        frame_396 = pd.DataFrame(
            [
                {"dlAmbr": 5001, "dlThpVolRmvLastSlot": 1000 + shift * 100, "dlThpTimeRmvLastSlot": 100},
                {"dlAmbr": 5002, "dlThpVolRmvLastSlot": 1800 + shift * 100, "dlThpTimeRmvLastSlot": 100},
            ]
        )
        write_trace(root, "537", timestamp, frame_537)
        write_trace(root, "714", timestamp, frame_714)
        write_trace(root, "396", timestamp, frame_396)

    # 同批 trace_1 是后续分片，目录选择必须仍优先 trace_0。
    write_trace(
        root,
        "537",
        "20260710090000",
        pd.DataFrame([{"crnti": 9999, "HH:MM:SS": "00:00:00", "frm": 0, "slotNo": 0}]),
        index=1,
    )


def test_dual_directory_catalog_keeps_same_timestamp_schemes_separate(tmp_path: Path) -> None:
    root_a = tmp_path / "scheme_a"
    root_b = tmp_path / "scheme_b"
    root_a.mkdir()
    root_b.mkdir()
    timestamp = "20260710110000"
    write_trace(root_a, "537", timestamp, pd.DataFrame([{"crnti": 1001}]))
    write_trace(root_b, "537", timestamp, pd.DataFrame([{"crnti": 2001}]))

    catalog = build_dual_catalog(
        {
            "A": scan_csv_files(root_a),
            "B": scan_csv_files(root_b),
        },
        {"A": root_a, "B": root_b},
    )

    assert catalog["default_selection"] == {"A": timestamp, "B": timestamp}
    sources = selected_sources(catalog, catalog["default_selection"])
    assert sources["A537"]["path"] != sources["B537"]["path"]
    assert sources["A537"]["scheme"] == "A"
    assert sources["B537"]["scheme"] == "B"


def test_end_to_end_ingest_merge_query_plot_export(tmp_path: Path) -> None:
    make_fixture(tmp_path)
    files = scan_csv_files(tmp_path)
    catalog = build_catalog(files)
    assert catalog["file_count"] == 7
    assert catalog["default_selection"] == {
        "A": "20260710090000",
        "B": "20260710100000",
    }
    first_batch = next(batch for batch in catalog["batches"] if batch["batch_id"] == "20260710090000")
    assert first_batch["traces"]["537"]["selected"]["trace_index"] == 0

    session = SESSIONS.create(tmp_path, catalog)
    try:
        selection = catalog["default_selection"]
        session.update(selection=selection)
        sources = selected_sources(catalog, selection)
        ingest = run_ingest_task(session, "test-ingest", sources)
        assert ingest["phase"] == "read"
        assert ingest["sources"]["A537"]["rows"] == 3
        assert ingest["t396"]["cell_rate_b"] > ingest["t396"]["cell_rate_a"]
        assert TASKS.get("test-ingest")["files"]["A537"]["path"] == sources["A537"]["path"]

        merged = run_merge_task(
            session,
            "test-merge",
            # ambr is intentionally omitted: the merge engine must preserve the
            # analysis user key even when it is hidden from interested columns.
            selected_537=["tti", "crnti", "HH:MM:SS", "frm", "slotNo", "schType", "suOrMuFlag", "jtMode", "cw0SuMcs", "tb0SchMcs", "schRank", "usrschpdschDrbData"],
            selected_714=["crnti", "HH:MM:SS", "frm", "slotNum", "ack0", "retansNum0", "isMuFlag", "mcsOffset[0]", "compOlla"],
            row_limit=0,
        )
        assert merged["phase"] == "merged"
        assert merged["sides"]["A"]["anchor_rows"] == 3
        assert merged["sides"]["A"]["matched_rows"] == 2
        assert merged["sides"]["A"]["nan_rows"] == 1
        assert merged["sides"]["A"]["duplicate_714_keys"] == 1
        assert "714_mcsOffset0_scaled" in merged["numeric_columns"]

        page = query_rows(
            session,
            side="A",
            page=1,
            page_size=100,
            filters=[{"column": "ambr", "op": "eq", "value": "5001"}],
            global_search="",
            sort_column="tti",
            sort_ascending=True,
            visible_columns=[
                "tti",
                "ambr",
                "cw0SuMcs",
                "714_ack0",
                "714_匹配状态",
                "714_来源行号",
                "714_mcsOffset0_scaled",
            ],
        )
        assert page["filtered_rows"] == 1
        assert page["columns"] == [
            "tti",
            "ambr",
            "cw0SuMcs",
            "714_ack0",
            "714_匹配状态",
            "714_来源行号",
            "714_mcsOffset0_scaled",
        ]
        assert page["rows"][0]["714_匹配状态"] == "已匹配"
        assert page["rows"][0]["714_来源行号"] == 1
        assert page["rows"][0]["714_mcsOffset0_scaled"] == 1.0

        options = filter_options(session)
        assert options["options"]["ambr"] == ["5001", "5002", "5003"]
        assert set(options["options"]["714_匹配状态"]) == {"NaN", "已匹配"}

        profile = column_profile(
            session,
            side="A",
            column="ambr",
            filters=[
                {"column": "ambr", "op": "in", "value": ["5001"]},
                {"column": "schType", "op": "eq", "value": "DL"},
            ],
            global_search="",
            value_search="500",
        )
        # Excel-style values are computed under other columns' filters, while
        # the column's own active filter is excluded from the option list.
        assert profile["row_count"] == 3
        assert profile["distinct_count"] == 3
        assert [item["value"] for item in profile["values"]] == ["5001", "5002", "5003"]
        assert profile["is_identifier"] is True

        plots = run_plot_task(
            session,
            "test-plot",
            metrics=["cw0SuMcs", "714_ack0", "schType"],
            filters=[{"column": "ambr", "op": "eq", "value": "5001"}],
        )
        assert "cw0SuMcs · 序列" in plots["figures"]
        assert "cw0SuMcs · CDF" in plots["figures"]
        assert "schType · 频次" in plots["figures"]
        assert "BLER · 并列柱形图" in plots["figures"]

        export_path = export_filtered_csv(
            session,
            side="A",
            filters=[{"column": "ambr", "op": "eq", "value": "5001"}],
        )
        assert export_path.is_file()
        exported = pd.read_csv(export_path, encoding="utf-8-sig")
        assert len(exported) == 1
        assert str(exported.iloc[0]["ambr"]) in {"5001", "5001.0"}
    finally:
        SESSIONS.clear(session.session_id)


def test_a_only_without_714_keeps_anchor_rows_and_nan(tmp_path: Path) -> None:
    timestamp = "20260710110000"
    frame_537 = pd.DataFrame(
        [
            {"tti": 1, "crnti": 2001, "HH:MM:SS": "11:00:00", "frm": 20, "slotNo": 1, "ambr": 6001, "cw0SuMcs": 8, "label": "=2+2"},
            {"tti": 2, "crnti": 2002, "HH:MM:SS": "11:00:00", "frm": 20, "slotNo": 2, "ambr": 6002, "cw0SuMcs": 12, "label": "normal"},
            {"tti": 3, "crnti": 2003, "HH:MM:SS": "11:00:00", "frm": 20, "slotNo": 3, "ambr": 6003, "cw0SuMcs": 16, "label": "normal"},
        ]
    )
    write_trace(tmp_path, "537", timestamp, frame_537)
    catalog = build_catalog(scan_csv_files(tmp_path))
    session = SESSIONS.create(tmp_path, catalog)
    try:
        selection = catalog["default_selection"]
        session.update(selection=selection)
        ingest = run_ingest_task(session, "a-only-ingest", selected_sources(catalog, selection))
        assert set(ingest["sources"]) == {"A537"}
        merged = run_merge_task(
            session,
            "a-only-merge",
            selected_537=["tti", "crnti", "HH:MM:SS", "frm", "slotNo", "ambr", "cw0SuMcs", "label"],
            selected_714=["ack0"],
            row_limit=2,
        )
        assert set(merged["sides"]) == {"A"}
        assert merged["sides"]["A"]["anchor_rows"] == 2
        assert merged["sides"]["A"]["matched_rows"] == 0
        page = query_rows(session, "A", 1, 100, [], "", None, True)
        assert len(page["rows"]) == 2
        assert all(row["714_匹配状态"] == "NaN" for row in page["rows"])
        assert "714_ack0" not in page["columns"]
        export_path = export_filtered_csv(session, "A", [])
        exported = pd.read_csv(export_path, encoding="utf-8-sig", dtype=str)
        assert exported.iloc[0]["label"] == "'=2+2"
    finally:
        SESSIONS.clear(session.session_id)


def test_numeric_inference_uses_later_chunks(tmp_path: Path, monkeypatch) -> None:
    import wireless_trace_viewer_app.engine as engine

    monkeypatch.setattr(engine, "READ_CHUNK_ROWS", 2)
    timestamp = "20260710120000"
    frame = pd.DataFrame(
        [
            {"crnti": 3001, "HH:MM:SS": "12:00:00", "frm": 1, "slotNo": 1, "ambr": 7001, "lateMetric": None},
            {"crnti": 3002, "HH:MM:SS": "12:00:00", "frm": 1, "slotNo": 2, "ambr": 7002, "lateMetric": None},
            {"crnti": 3003, "HH:MM:SS": "12:00:00", "frm": 1, "slotNo": 3, "ambr": 7003, "lateMetric": 12.5},
            {"crnti": 3004, "HH:MM:SS": "12:00:00", "frm": 1, "slotNo": 4, "ambr": 7004, "lateMetric": 18.5},
        ]
    )
    write_trace(tmp_path, "537", timestamp, frame)
    catalog = build_catalog(scan_csv_files(tmp_path))
    session = SESSIONS.create(tmp_path, catalog)
    try:
        selection = catalog["default_selection"]
        session.update(selection=selection)
        ingest = run_ingest_task(session, "late-numeric", selected_sources(catalog, selection))
        assert "lateMetric" in ingest["sources"]["A537"]["numeric_columns"]
    finally:
        SESSIONS.clear(session.session_id)
