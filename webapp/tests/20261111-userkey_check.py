"""用户键自动判定实测：537 ambr / T396 dlAmbr 是多用户共用的签约速率时，工具应改用 usrId / susrId 区分用户。
数据：把场景 A 的 ambr、dlAmbr 改成 4 个共用值（8 个用户）。
用法：python tests/20261111-userkey_check.py <url> <数据目录（含 场景A）> <输出目录>"""
import json, os, sys
from playwright.sync_api import sync_playwright

url, root, out = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
WAIT = "() => /已就绪|失败|部分完成|已停止/.test(document.querySelector('.prog')?.textContent || '')"
checks, notes = {}, {}
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(url + ("&" if "?" in url else "?") + "picker=input&debug")
    pg.wait_for_timeout(1500)
    pg.locator(".modetabs button", has_text="单小区分析").click()
    with pg.expect_file_chooser() as fc:
        pg.locator(".pick").first.get_by_role("button", name="选择文件夹…").click()
    fc.value.set_files(os.path.join(root, "场景A"))
    pg.wait_for_timeout(1500)
    pg.get_by_role("button", name="开始分析").click()
    pg.wait_for_function(WAIT, timeout=300000)
    pg.wait_for_timeout(1500)
    badge = pg.locator(".tabs .tag.chg")
    checks["页签栏出现“用户按 usrId 区分”"] = badge.count() == 1
    notes["说明"] = badge.get_attribute("title") if badge.count() else None
    pg.locator(".tabs button", has_text="诊断结论").click()
    pg.wait_for_selector(".concl-row", timeout=180000)
    pg.wait_for_timeout(1000)
    ids = pg.evaluate("() => [...document.querySelectorAll('.concl-row .concl-id b')].map((x) => x.textContent.trim())")
    notes["诊断结论用户"] = ids
    checks["诊断结论按 8 个真实用户列出（不是 4 个 ambr 分组）"] = len(ids) >= 8 or pg.locator(".pager").count() > 0
    pg.screenshot(path=f"{out}/userkey-conclude.png")
    pg.locator(".tabs button", has_text="控制信道").click()
    pg.wait_for_selector(".diag.ctrl tbody tr", timeout=60000)
    crow = pg.evaluate("() => Object.fromEntries([...document.querySelectorAll('.diag.ctrl tbody tr')].map((tr) => [tr.children[0].textContent.trim(), tr.lastElementChild.textContent.trim()]))")
    notes["控制信道"] = crow
    checks["控制信道按 usrId：106（= 5006）判聚合级别高"] = "聚合级别高" in crow.get("106", "")
    rail = pg.evaluate("() => [...document.querySelectorAll('.rail .u b, .rail .item b')].map((x) => x.textContent.trim())")
    notes["左栏用户"] = rail[:12]
    rates = pg.evaluate("() => document.querySelector('.rail')?.innerText || ''")
    checks["T396 速率按 susrId 挂上（左栏有 106 且带 Rate）"] = "106" in rates and "Rate" in rates
    checks["页面无脚本错误"] = not errs
    notes["errors"] = errs[:5]
    b.close()
ok = sum(bool(v) for v in checks.values())
for k, v in checks.items():
    print(("PASS " if v else "FAIL ") + k)
print(f"{ok}/{len(checks)}")
json.dump({"checks": checks, "notes": notes}, open(f"{out}/20261111-userkey-check.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
sys.exit(0 if ok == len(checks) else 1)
