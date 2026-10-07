"""端到端实测：真实浏览器 + 真实 CSV 文件夹，走 选文件夹 → 一键分析 → 结论 / 明细 / 图表 / 数据质量。
用法：python tests/e2e_flow.py <url> <A目录> <B目录> <截图目录>"""
import sys, time, json
from playwright.sync_api import sync_playwright

url, dir_a, dir_b, out = sys.argv[1:5]
errors = []
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={"width": 1600, "height": 960})
    pg.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
    pg.on("console", lambda m: errors.append("console: " + m.text) if m.type == "error" else None)
    pg.goto(url + ("&" if "?" in url else "?") + "picker=input&debug")
    pg.wait_for_timeout(1500)
    for i, d in enumerate((dir_a, dir_b)):
        with pg.expect_file_chooser() as fc:
            pg.locator(".pick").nth(i).get_by_role("button", name="选择文件夹…").click()
        fc.value.set_files(d)
        pg.wait_for_timeout(1500)
    pg.screenshot(path=f"{out}/e2e-01-start.png")
    t0 = time.time()
    pg.get_by_role("button", name="开始分析").click()
    pg.wait_for_selector(".urow .id", timeout=60000)
    t396 = time.time() - t0
    pg.wait_for_function("() => /已就绪|失败|部分完成|已停止/.test(document.querySelector('.prog')?.textContent || '')", timeout=600000)
    total = time.time() - t0
    pg.wait_for_timeout(2500)
    pg.wait_for_function("() => document.querySelectorAll('.kcard').length >= 6", timeout=60000)
    cards = pg.locator(".kcard").count()
    pg.screenshot(path=f"{out}/e2e-02-summary.png")
    print(json.dumps({"t396_seconds": round(t396, 1), "total_seconds": round(total, 1), "status": pg.inner_text(".prog")}, ensure_ascii=False))
    rows = pg.locator(".urow:not(.cell)")
    rows.nth(0).click(); rows.nth(1).click()
    pg.wait_for_timeout(2500)
    pg.screenshot(path=f"{out}/e2e-03-summary-users.png")
    pg.get_by_role("button", name="明细", exact=True).click()
    pg.wait_for_timeout(2500)
    pg.screenshot(path=f"{out}/e2e-04-table.png")
    pg.locator("th", has_text="cw0SuMcs").first.click()
    pg.wait_for_timeout(1500)
    pg.screenshot(path=f"{out}/e2e-05-colmenu.png")
    pg.get_by_role("button", name="升序").click()
    pg.wait_for_timeout(1500)
    pg.locator("td.tti").first.click()
    pg.wait_for_timeout(1500)
    pg.screenshot(path=f"{out}/e2e-06-tti.png")
    pg.get_by_role("button", name="关闭").first.click()
    pg.get_by_role("button", name="图表", exact=True).click()
    pg.wait_for_function("() => document.querySelectorAll('.chartcard .main-svg').length > 0", timeout=120000)
    pg.wait_for_timeout(2500)
    pg.screenshot(path=f"{out}/e2e-07-charts.png")
    pg.get_by_role("button", name="叠加", exact=True).click()
    pg.wait_for_timeout(2500)
    pg.screenshot(path=f"{out}/e2e-08-charts-overlay.png")
    pg.get_by_role("button", name="数据质量", exact=True).click()
    pg.wait_for_timeout(1000)
    pg.screenshot(path=f"{out}/e2e-09-quality.png")
    print("errors:", json.dumps(errors[:20], ensure_ascii=False))
    status = pg.inner_text(".prog")
    run_status = pg.evaluate("() => window.__trace.S.run.value.status")
    sides = pg.evaluate("() => Object.fromEntries(Object.entries(window.__trace.S.sides.value).map(([k, v]) => [k, v && v.anchorRows]))")
    b.close()
    assert run_status == "done", f"分析未完整成功：{run_status} / {status}"
    assert sides.get("A") and sides.get("B"), f"A/B 合并表不完整：{sides}"
    assert cards >= 6, f"结论卡片过少：{cards}"
    assert not errors, f"页面报错：{errors[:5]}"
    print("PASS e2e_flow")
