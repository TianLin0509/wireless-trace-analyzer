"""离线实测（需 https 线上地址，Service Worker 才会启用）：在线打开一次 → 断网 → 刷新 → 完整分析并出图。
用法：python tests/offline_check.py <https 地址> <A目录> <B目录> <截图目录>"""
import sys, json
from playwright.sync_api import sync_playwright

url, dir_a, dir_b, out = sys.argv[1:5]
WAIT = "() => /已就绪|失败|部分完成|已停止/.test(document.querySelector('.prog')?.textContent || '')"
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": 1500, "height": 900})
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(url + "?picker=input&debug")
    # 等 Service Worker 接管并完成预缓存
    pg.wait_for_function("() => navigator.serviceWorker && navigator.serviceWorker.controller", timeout=120000)
    cached = pg.evaluate("""async () => {
      for (let i = 0; i < 240; i++) {
        const keys = await caches.keys();
        const c = keys.length ? await caches.open(keys[0]) : null;
        const n = c ? (await c.keys()).length : 0;
        if (n >= 7) return { keys, n };
        await new Promise((r) => setTimeout(r, 500));
      }
      return { keys: await caches.keys(), n: -1 };
    }""")
    ctx.set_offline(True)
    pg.reload()
    pg.wait_for_selector(".pick", timeout=30000)
    for i, d in enumerate((dir_a, dir_b)):
        with pg.expect_file_chooser() as fc:
            pg.locator(".pick").nth(i).get_by_role("button", name="选择文件夹…").click()
        fc.value.set_files(d)
        pg.wait_for_timeout(1000)
    pg.get_by_role("button", name="开始分析").click()
    pg.wait_for_function(WAIT, timeout=300000)
    status = pg.evaluate("() => window.__trace.S.run.value.status")
    pg.get_by_role("button", name="图表", exact=True).click()
    pg.wait_for_function("() => document.querySelectorAll('.chartcard .main-svg').length > 0", timeout=60000)
    pg.wait_for_timeout(1000)
    pg.screenshot(path=f"{out}/offline-charts.png")
    print(json.dumps({"cache": cached, "status_offline": status, "errors": errs[:5]}, ensure_ascii=False))
    b.close()
assert cached["n"] >= 7, f"预缓存未完成：{cached}"
assert status == "done", f"断网后分析未完成：{status}"
assert not errs, errs[:3]
print("PASS offline_check（断网后可完整分析并出图）")
