from __future__ import annotations

from pathlib import Path

import pandas as pd

from wireless_trace_viewer_app.catalog import (
    build_catalog,
    build_dual_catalog,
    build_kpi_t396_plan,
    match_same_cell_batches,
    scan_csv_files,
    selected_sources,
)
from wireless_trace_viewer_app.engine import (
    run_kpi396_task,
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
                {"tti": 3, "crnti": 1003, "HH:MM:SS": "09:00:00", "frm": 10, "slotNo": 3, "ambr": 5003, "schType": "DL", "suOrMuFlag": "SU", "jtMode": 1, "cw0SuMcs": 20 + shift, "tb0SchMcs": 21 + shift, "schRank": 1, "usrschpdschDrbData": 1600},
                {"tti": 1, "crnti": 1001, "HH:MM:SS": "09:00:00", "frm": 10, "slotNo": 1, "ambr": 5001, "schType": "DL", "suOrMuFlag": "SU", "jtMode": 0, "cw0SuMcs": 10 + shift, "tb0SchMcs": 11 + shift, "schRank": 1, "usrschpdschDrbData": 800},
                {"tti": 2, "crnti": 1002, "HH:MM:SS": "09:00:00", "frm": 10, "slotNo": 2, "ambr": 5002, "schType": "DL", "suOrMuFlag": "MU", "jtMode": 0, "cw0SuMcs": 15 + shift, "tb0SchMcs": 16 + shift, "schRank": 2, "usrschpdschDrbData": 1200},
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


def test_parse_result_parent_context_is_visible_and_separates_batches(tmp_path: Path) -> None:
    timestamp = "20260710110000"
    first = tmp_path / "Case_DL_Throughput" / "Cell_001" / "ParseResult"
    second = tmp_path / "Case_DL_Latency" / "Cell_002" / "ParseResult"
    first.mkdir(parents=True)
    second.mkdir(parents=True)
    frame = pd.DataFrame(
        [{"dlAmbr": 5001, "dlThpVolRmvLastSlot": 1000, "dlThpTimeRmvLastSlot": 100}]
    )
    write_trace(first, "396", timestamp, frame)
    write_trace(second, "396", timestamp, frame)

    catalog = build_catalog(scan_csv_files(tmp_path))

    assert catalog["batch_count"] == 2
    assert {tuple(batch["context_parts"]) for batch in catalog["batches"]} == {
        ("Case_DL_Throughput", "Cell_001", "ParseResult"),
        ("Case_DL_Latency", "Cell_002", "ParseResult"),
    }
    assert all(batch["batch_id"] != timestamp for batch in catalog["batches"])
    assert all(batch["context_path"].endswith("ParseResult") for batch in catalog["batches"])
    assert all("Cell_" in batch["context_label"] for batch in catalog["batches"])
    assert {batch["case_name"] for batch in catalog["batches"]} == {
        "Case_DL_Throughput",
        "Case_DL_Latency",
    }
    assert {batch["cell_name"] for batch in catalog["batches"]} == {"Cell_001", "Cell_002"}
    assert {group["case_name"] for group in catalog["case_groups"]} == {
        "Case_DL_Throughput",
        "Case_DL_Latency",
    }


def test_same_cell_matcher_pairs_selected_cases_without_cartesian_product(tmp_path: Path) -> None:
    root_a = tmp_path / "scheme_a"
    root_b = tmp_path / "scheme_b"
    frame = pd.DataFrame(
        [{"dlAmbr": 5001, "dlThpVolRmvLastSlot": 1000, "dlThpTimeRmvLastSlot": 100}]
    )

    def add(root: Path, case: str, cell: str, timestamp: str, trace: str = "396") -> None:
        target = root / case / cell / "ParseResult"
        target.mkdir(parents=True, exist_ok=True)
        write_trace(target, trace, timestamp, frame)

    # Cell_001 has two timestamps on each side. The newest exact timestamp
    # should win; Cell_002/003 are not common and must not form cross-cell pairs.
    add(root_a, "Case_A", "Cell_001", "20260710100000")
    add(root_a, "Case_A", "Cell_001", "20260710110000")
    add(root_a, "Case_A", "Cell_002", "20260710110000")
    add(root_b, "Case_B", "Cell_001", "20260710103000")
    add(root_b, "Case_B", "Cell_001", "20260710110000")
    add(root_b, "Case_B", "Cell_003", "20260710110000")

    catalog = build_dual_catalog(
        {"A": scan_csv_files(root_a), "B": scan_csv_files(root_b)},
        {"A": root_a, "B": root_b},
    )
    case_a = catalog["side_catalogs"]["A"]["case_groups"][0]["case_key"]
    case_b = catalog["side_catalogs"]["B"]["case_groups"][0]["case_key"]
    default_a = next(
        batch
        for batch in catalog["side_catalogs"]["A"]["batches"]
        if batch["batch_id"] == catalog["default_selection"]["A"]
    )
    default_b = next(
        batch
        for batch in catalog["side_catalogs"]["B"]["batches"]
        if batch["batch_id"] == catalog["default_selection"]["B"]
    )
    assert default_a["cell_name"] == default_b["cell_name"] == "Cell_001"

    result = match_same_cell_batches(
        catalog,
        case_a=case_a,
        case_b=case_b,
        required_trace="396",
        max_pairs=30,
    )

    assert result["common_cell_count"] == 1
    assert result["unmatched_a"] == ["Cell_002"]
    assert result["unmatched_b"] == ["Cell_003"]
    assert len(result["pairs"]) == 1
    pair = result["pairs"][0]
    assert pair["cell_name"] == "Cell_001"
    assert pair["A"]["case_name"] == "Case_A"
    assert pair["B"]["case_name"] == "Case_B"
    assert pair["A"]["test_time_raw"] == "20260710110000"
    assert pair["B"]["test_time_raw"] == "20260710110000"
    assert pair["a_batch_id"] != pair["b_batch_id"]


def test_kpi396_multiple_groups_only_reads_t396(tmp_path: Path) -> None:
    root_a = tmp_path / "scheme_a"
    root_b = tmp_path / "scheme_b"
    root_a.mkdir()
    root_b.mkdir()
    timestamps = ["20260710110000", "20260710120000"]
    rates = {
        timestamps[0]: (10.0, 12.0),
        timestamps[1]: (20.0, 18.0),
    }
    for timestamp, (rate_a, rate_b) in rates.items():
        for root, rate in [(root_a, rate_a), (root_b, rate_b)]:
            write_trace(
                root,
                "396",
                timestamp,
                pd.DataFrame(
                    [
                        {
                            "dlAmbr": 5001,
                            "dlThpVolRmvLastSlot": rate * 100,
                            "dlThpTimeRmvLastSlot": 100,
                        }
                    ]
                ),
            )
    catalog = build_dual_catalog(
        {"A": scan_csv_files(root_a), "B": scan_csv_files(root_b)},
        {"A": root_a, "B": root_b},
    )
    groups = [
        {"id": "cell-1", "label": "小区 1", "a_batch_id": timestamps[0], "b_batch_id": timestamps[0]},
        {"id": "cell-2", "label": "小区 2", "a_batch_id": timestamps[1], "b_batch_id": timestamps[1]},
    ]
    sources, resolved = build_kpi_t396_plan(catalog, groups)

    assert len(sources) == 4
    assert all(source["trace_id"] == "396" for source in sources.values())
    assert len(resolved) == 2

    session = SESSIONS.create(tmp_path, catalog, roots={"A": root_a, "B": root_b})
    try:
        result = run_kpi396_task(session, "test-kpi396", sources, resolved)
        assert result["phase"] == "kpi396"
        assert len(result["groups"]) == 2
        assert result["summary"]["improved"] == 1
        assert result["summary"]["declined"] == 1
        assert result["groups"][0]["comparison"]["diff_pct"] == 20.0
        assert result["groups"][1]["comparison"]["diff_pct"] == -10.0
    finally:
        SESSIONS.clear(session.session_id)


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
        assert TASKS.get("test-ingest")["partial"]["phase"] == "t396_ready"
        assert TASKS.get("test-ingest")["partial"]["t396"]["available"] is True

        merged = run_merge_task(
            session,
            "test-merge",
            # tti/ambr are intentionally omitted: the merge engine must retain
            # the time axis and analysis user key for downstream charts.
            selected_537=["crnti", "HH:MM:SS", "frm", "slotNo", "schType", "suOrMuFlag", "jtMode", "cw0SuMcs", "tb0SchMcs", "schRank", "usrschpdschDrbData"],
            selected_714=["crnti", "HH:MM:SS", "frm", "slotNum", "ack0", "retansNum0", "isMuFlag", "mcsOffset[0]", "compOlla"],
            row_limit=0,
        )
        assert merged["phase"] == "merged"
        assert merged["sides"]["A"]["anchor_rows"] == 3
        assert merged["sides"]["A"]["matched_rows"] == 2
        assert merged["sides"]["A"]["nan_rows"] == 1
        assert merged["sides"]["A"]["duplicate_714_keys"] == 1
        assert "tti" in merged["common_columns"]
        assert "ambr" in merged["common_columns"]
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
            filters=[],
        )
        assert "cw0SuMcs · 序列" in plots["figures"]
        assert "cw0SuMcs · CDF" in plots["figures"]
        assert "schType · 频次" in plots["figures"]
        assert "BLER · 并列柱形图" in plots["figures"]
        sequence = plots["figures"]["cw0SuMcs · 序列"]
        assert sequence["data"][0]["x"] == [1.0, 2.0, 3.0]
        assert sequence["data"][0]["y"] == [10.0, 15.0, 20.0]
        assert sequence["layout"]["xaxis"]["title"]["text"] == "TTI"

        multi_user_plots = run_plot_task(
            session,
            "test-plot-multi-user",
            metrics=["cw0SuMcs", "schType"],
            filters=[{"column": "schType", "op": "eq", "value": "DL"}],
            user_values=["5001", "5002"],
        )
        multi_sequence = multi_user_plots["figures"]["cw0SuMcs · 序列"]
        assert len(multi_sequence["data"]) == 4
        assert [item["text"] for item in multi_sequence["layout"]["annotations"]] == [
            "ambr 5001 · 方案 A",
            "ambr 5001 · 方案 B",
            "ambr 5002 · 方案 A",
            "ambr 5002 · 方案 B",
        ]
        assert multi_sequence["layout"]["xaxis3"]["title"]["text"] == "TTI"
        assert multi_sequence["layout"]["height"] > 520
        multi_frequency = multi_user_plots["figures"]["schType · 频次"]
        assert len(multi_frequency["data"]) == 4
        assert {row["scope"] for row in multi_user_plots["summary_rows"]} == {
            "ambr 5001",
            "ambr 5002",
        }
        assert multi_user_plots["user_values"] == ["5001", "5002"]

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
