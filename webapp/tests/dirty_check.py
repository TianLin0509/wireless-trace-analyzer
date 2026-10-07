"""脏数据实测：坏行进入质量报告、表头空格、BOM/CRLF、数值列混入文本、引号内逗号、连接键大小写不同。
用法：python tests/dirty_check.py <url> <A目录> <B目录> <截图目录>（数据由 tools/make_dirty.py 生成）"""
import sys, json
from playwright.sync_api import sync_playwright

url, dir_a, dir_b, out = sys.argv[1:5]
CHECK = """async () => {
  const { S, db } = window.__trace;
  const a = S.sides.value.A, src = S.sources.value.A537;
  if (!a) return { status: S.run.value.status, errors: S.run.value.errors };
  const r = await db.query(`SELECT count(*) AS n, count("cw0SuMcs") AS mcs_nonnull, count(*) FILTER (WHERE "schType" LIKE '%特殊%') AS quoted FROM ${a.table}`);
  return { status: S.run.value.status, errors: S.run.value.errors, rejected: src.quality.rejectedRows,
           samples: src.quality.samples.map(x => [x.line, x.error_type]), hasMcs: a.columns.includes('cw0SuMcs'),
           mcsNumeric: a.numericColumns.includes('cw0SuMcs'), lateNumeric: a.numericColumns.includes('lateCol'),
           matchRate: Math.round(a.matchRate * 10) / 10, rows: r[0], sourceRows: src.quality.sourceRows };
}"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={"width": 1500, "height": 900})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(url + "?picker=input&debug")
    pg.wait_for_timeout(1500)
    for i, d in enumerate((dir_a, dir_b)):
        with pg.expect_file_chooser() as fc:
            pg.locator(".pick").nth(i).get_by_role("button", name="选择文件夹…").click()
        fc.value.set_files(d)
        pg.wait_for_timeout(1000)
    # 让“开头为空、后面才有数”的列参与汇总，验证全量复核会把它识别为数值列
    pg.evaluate("() => { const S = window.__trace.S; S.updateView({ columns537: [...S.view.value.columns537, 'lateCol'] }); }")
    pg.get_by_role("button", name="开始分析").click()
    pg.wait_for_function("() => /已就绪|失败/.test(document.querySelector('.prog')?.textContent || '')", timeout=300000)
    res = pg.evaluate(CHECK)
    pg.get_by_role("button", name="数据质量", exact=True).click()
    pg.wait_for_timeout(800)
    pg.screenshot(path=f"{out}/dirty-quality.png", full_page=True)
    print(json.dumps({**res, "pageErrors": errs}, ensure_ascii=False))
    b.close()
