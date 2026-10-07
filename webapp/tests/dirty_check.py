"""异常数据实测（数据由 tools/make_dirty.py 生成）。
场景 1：方案 A 的 T537 含坏行、表头空格、小写连接键、BOM/CRLF、N/A、引号内逗号、开头为空的数值列。
场景 2：方案 B 的 T537 缺连接键 → 页面必须显示“部分完成”和警示横幅，而不是“已就绪”。
用法：python tests/dirty_check.py <url> <异常数据根目录> <截图目录>"""
import os, sys, json
from playwright.sync_api import sync_playwright

url, root, out = sys.argv[1:4]
expected_lines = int(open(os.path.join(root, "expected.txt"), encoding="utf-8").read())
WAIT = "() => /已就绪|失败|部分完成|已停止/.test(document.querySelector('.prog')?.textContent || '')"
CHECK = """async () => {
  const { S, db } = window.__trace;
  const a = S.sides.value.A, src = S.sources.value.A537;
  if (!a) return { status: S.run.value.status, errors: S.run.value.errors };
  const r = await db.query(`SELECT count(*) AS n, count("cw0SuMcs") AS mcs_nonnull, count(*) FILTER (WHERE "schType" LIKE '%特殊%') AS quoted FROM ${a.table}`);
  return { status: S.run.value.status, errors: S.run.value.errors, rejected: src.quality.rejectedRows,
           samples: src.quality.samples.map(x => [x.line, x.error_type]), hasMcs: a.columns.includes('cw0SuMcs'),
           mcsNumeric: a.numericColumns.includes('cw0SuMcs'), lateNumeric: a.numericColumns.includes('lateCol'),
           nonNumericCells: src.quality.nonNumericCells, matchRate: Math.round(a.matchRate * 10) / 10, rows: r[0] };
}"""


def run(pg, dir_a, dir_b, extra_cols=False):
    pg.goto(url + "?picker=input&debug")
    pg.wait_for_timeout(1500)
    for i, d in enumerate((dir_a, dir_b)):
        with pg.expect_file_chooser() as fc:
            pg.locator(".pick").nth(i).get_by_role("button", name="选择文件夹…").click()
        fc.value.set_files(d)
        pg.wait_for_timeout(1000)
    if extra_cols:
        # 让“开头为空、后面才有数”的列参与汇总，验证全量复核会把它识别为数值列
        pg.evaluate("() => { const S = window.__trace.S; S.updateView({ columns537: [...S.view.value.columns537, 'lateCol'] }); }")
    pg.get_by_role("button", name="开始分析").click()
    pg.wait_for_function(WAIT, timeout=300000)
    pg.wait_for_timeout(800)


with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={"width": 1500, "height": 900})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    # 场景 1
    run(pg, os.path.join(root, "方案A"), os.path.join(root, "方案B"), extra_cols=True)
    res = pg.evaluate(CHECK)
    pg.get_by_role("button", name="数据质量", exact=True).click()
    pg.wait_for_timeout(800)
    pg.screenshot(path=f"{out}/dirty-quality.png", full_page=True)
    quality_text = pg.inner_text("#content")
    # 场景 2
    run(pg, os.path.join(root, "方案A"), os.path.join(root, "方案B_缺连接键"))
    partial = {
        "status": pg.evaluate("() => window.__trace.S.run.value.status"),
        "failedSides": pg.evaluate("() => window.__trace.S.run.value.failedSides"),
        "prog": pg.inner_text(".prog"),
        "banner": pg.locator(".banner.warn", has_text="对比不完整").count(),
    }
    pg.screenshot(path=f"{out}/dirty-partial.png")
    print(json.dumps({**res, "partial": partial, "pageErrors": errs}, ensure_ascii=False))
    b.close()

rows = res.get("rows", {})
checks = {
    "分析完成": res.get("status") == "done" and not res.get("errors"),
    "两条坏行被拦截": res.get("rejected") == 2 and [s[0] for s in res.get("samples", [])] == [6, 10],
    "其余行照常读入（独立核对文件行数）": rows.get("n") == expected_lines - 2,
    "表头空格不影响列名": res.get("hasMcs") and res.get("mcsNumeric"),
    "数值列中的文本记为空": rows.get("mcs_nonnull") == rows.get("n", 0) - 1,
    "非数字文本进入质量报告": res.get("nonNumericCells") == 1 and "非数字文本" in quality_text,
    "引号内逗号保留": rows.get("quoted") == 1,
    "小写连接键仍能匹配": (res.get("matchRate") or 0) > 90,
    "开头为空的列复核为数值": res.get("lateNumeric"),
    "一侧失败时显示部分完成": partial["status"] == "partial" and partial["failedSides"] == ["B"] and "部分完成" in partial["prog"],
    "一侧失败时有警示横幅": partial["banner"] == 1,
    "页面无报错": not errs,
}
failed = [k for k, ok in checks.items() if not ok]
assert not failed, f"未通过：{failed}"
print(f"PASS dirty_check（{len(checks)} 项）")
