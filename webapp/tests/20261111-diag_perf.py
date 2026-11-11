"""诊断页签大数据耗时：单小区 / A/B 各读一遍，逐个点开诊断页签，记录从点击到内容出现的秒数与引擎内存。
用法：python tests/20261111-diag_perf.py <url> <场景根目录> <输出目录>"""
import json, os, sys, time
from playwright.sync_api import sync_playwright

url, root, out = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
WAIT = "() => /已就绪|失败|部分完成|已停止/.test(document.querySelector('.prog')?.textContent || '')"
TABS = [("诊断结论", ".concl-row"), ("速率拆解", ".diag .section tbody tr"), ("链路诊断", ".diag .section tbody tr"),
        ("异常事件", ".diag-top.evt, .diag .banner.info"), ("时间轴", ".diag .plotbox .main-svg")]
res = {}
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_context(viewport={"width": 1440, "height": 900}).new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    for mode, dirs in [("单小区", [os.path.join(root, "场景A")]), ("A/B", [os.path.join(root, "场景A"), os.path.join(root, "场景B")])]:
        pg.goto(url + ("&" if "?" in url else "?") + "picker=input&debug")
        pg.wait_for_timeout(1500)
        pg.locator(".modetabs button", has_text="单小区分析" if mode == "单小区" else "A/B").first.click()
        for i, d in enumerate(dirs):
            with pg.expect_file_chooser() as fc:
                pg.locator(".pick").nth(i).get_by_role("button", name="选择文件夹…").click()
            fc.value.set_files(d)
            pg.wait_for_timeout(1200)
        t0 = time.time()
        pg.get_by_role("button", name="开始分析").click()
        pg.wait_for_function(WAIT, timeout=900000)
        res[f"{mode} 读取+合并 秒"] = round(time.time() - t0, 1)
        for label, sel in TABS:
            t0 = time.time()
            pg.locator(".tabs button", has_text=label).click()
            pg.wait_for_selector(sel, timeout=900000)
            res[f"{mode} {label} 秒"] = round(time.time() - t0, 1)
        res[f"{mode} 引擎内存"] = pg.evaluate("() => window.__trace?.S.run.value?.memory || null")
    res["errors"] = errs[:5]
    b.close()
open(f"{out}/20261111-diag-perf.json", "w", encoding="utf-8").write(json.dumps(res, ensure_ascii=False, indent=1))
print(json.dumps(res, ensure_ascii=False, indent=1))
