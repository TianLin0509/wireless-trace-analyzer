"""大数据压力实测：记录各阶段耗时与测试浏览器进程合计峰值内存。
用法：python tests/perf_big.py <url> <A目录> <B目录> <输出目录>"""
import sys, time, json, threading
import psutil
from playwright.sync_api import sync_playwright

url, dir_a, dir_b, out = sys.argv[1:5]
peak = {"mem": 0}
stop = threading.Event()


def browser_mem():
    total = 0
    for p in psutil.process_iter(["exe", "memory_info"]):
        try:
            if p.info["exe"] and "ms-playwright" in p.info["exe"].lower():
                total += p.info["memory_info"].private
        except Exception:
            pass
    return total


def watch():
    while not stop.wait(0.2):
        peak["mem"] = max(peak["mem"], browser_mem())


with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={"width": 1600, "height": 960})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(url + "?picker=input")
    pg.wait_for_timeout(2000)
    for i, d in enumerate((dir_a, dir_b)):
        with pg.expect_file_chooser() as fc:
            pg.locator(".pick").nth(i).get_by_role("button", name="选择文件夹…").click()
        fc.value.set_files(d)
        pg.wait_for_timeout(1000)
    base = browser_mem()
    threading.Thread(target=watch, daemon=True).start()
    t0 = time.time()
    pg.get_by_role("button", name="开始分析").click()
    pg.wait_for_selector(".urow .id", timeout=120000)
    t396 = time.time() - t0
    pg.wait_for_function("() => /已就绪|失败/.test(document.querySelector('.prog')?.textContent || '')", timeout=1200000)
    t_ready = time.time() - t0
    pg.wait_for_function("() => document.querySelectorAll('.kcard').length >= 6", timeout=120000)
    t_cards = time.time() - t0
    pg.screenshot(path=f"{out}/perf-summary.png")
    pg.get_by_role("button", name="明细", exact=True).click()
    t1 = time.time(); pg.wait_for_selector("td.tti", timeout=120000); t_table = time.time() - t1
    pg.locator(".urow:not(.cell)").first.click()
    t1 = time.time(); pg.wait_for_timeout(300)
    pg.wait_for_function("() => !document.querySelector('.pager')?.textContent.includes('刷新中')", timeout=120000)
    t_filter = time.time() - t1
    pg.get_by_role("button", name="图表", exact=True).click()
    t1 = time.time(); pg.wait_for_function("() => document.querySelectorAll('.chartcard .main-svg').length >= 4", timeout=300000)
    t_chart = time.time() - t1
    pg.screenshot(path=f"{out}/perf-charts.png")
    stop.set()
    print(json.dumps({"t396": round(t396, 1), "ready": round(t_ready, 1), "cards": round(t_cards, 1),
                      "table_first_page": round(t_table, 2), "filter_one_user": round(t_filter, 2), "charts_4_metrics": round(t_chart, 1),
                      "browser_mem_peak_mb": round(peak["mem"] / 2**20), "browser_mem_before_mb": round(base / 2**20),
                      "status": pg.inner_text(".prog"), "errors": errs[:5]}, ensure_ascii=False))
    b.close()
