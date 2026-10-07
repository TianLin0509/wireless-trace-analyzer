"""新版浏览器引擎在同一数据上的结果。用法：python tests/parity_web.py <url> <A目录> <B目录> <小区名> <输出json>"""
import sys, json
from playwright.sync_api import sync_playwright

url, dir_a, dir_b, cell, out = sys.argv[1:6]
JS = """async () => {
  const { S, stats, q } = window.__trace;
  const t = S.t396.value; const sides = S.sides.value;
  const res = { t396: { cellA: t.cellRateA, cellB: t.cellRateB, users: Object.fromEntries(t.rows.map(r => [r.userId, [r.rateA, r.rateB, r.shareA, r.shareB]])) }, merge: {}, metrics: {}, bler: {} };
  for (const s of ['A','B']) {
    const m = sides[s];
    res.merge[s] = { anchor_rows: m.anchorRows, matched_rows: m.matchedRows, duplicate_714_keys: m.duplicate714Keys };
    res.metrics[s] = {};
    for (const k of ['cw0SuMcs','usrschpdschDrbData','714_compOlla_scaled']) {
      const x = await stats.metricSummary(m, k, 'TRUE');
      res.metrics[s][k] = { count: x.count, mean: x.mean, p50: x.p50, p90: x.p90, min: x.min, max: x.max };
    }
    const x = await stats.metricSummary(m, 'cw0SuMcs', q.filterSql([q.userScope(['5003'])], m.columns, ''));
    res.metrics[s]['cw0SuMcs@5003'] = { count: x.count, mean: x.mean, p50: x.p50, p90: x.p90 };
    res.bler[s] = Object.fromEntries((await stats.blerByUser(m, 'TRUE')).map(r => [r.user, r.bler]));
  }
  return res;
}"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={"width": 1500, "height": 900})
    pg.goto(url + "?picker=input&debug")
    pg.wait_for_timeout(1500)
    for i, d in enumerate((dir_a, dir_b)):
        with pg.expect_file_chooser() as fc:
            pg.locator(".pick").nth(i).get_by_role("button", name="选择文件夹…").click()
        fc.value.set_files(d)
        pg.wait_for_timeout(1200)
    for i in range(2):
        sel = pg.locator(".pick").nth(i).locator("select").last
        sel.select_option(sel.locator("option", has_text=cell).first.get_attribute("value"))
    pg.get_by_role("button", name="开始分析").click()
    pg.wait_for_function("() => /已就绪|失败/.test(document.querySelector('.prog')?.textContent || '')", timeout=600000)
    res = pg.evaluate(JS)
    json.dump(res, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("ok", out)
    b.close()
