"""粘贴路径实测（本机助手未运行时的退路）：粘贴路径 → 点“打开” → 出现助手设置说明 → 点“这次先用选择窗口” → 路径进剪贴板、出现操作提示 → 在选择窗口里选中该文件夹 →
页面显示完整路径、数据质量页显示文件完整路径；粘贴与实际选择不一致时给出提醒。
（浏览器原生选择窗口无法自动化，测试里用 ?picker=input 兜底选择框代替“在窗口里粘贴回车”这一步。）
用法：python tests/paste_check.py <url> <A目录> <B目录> <截图目录>"""
import os, sys, json
from playwright.sync_api import sync_playwright

url, dir_a, dir_b, out = sys.argv[1:5]
abs_a = os.path.abspath(dir_a).replace("/", "\\")
abs_b = os.path.abspath(dir_b).replace("/", "\\")
WAIT = "() => /已就绪|失败|部分完成|已停止/.test(document.querySelector('.prog')?.textContent || '')"
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    origin = url.split("/", 3)[:3]
    ctx = b.new_context(viewport={"width": 1500, "height": 900}, permissions=["clipboard-read", "clipboard-write"])
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(url + "?picker=input&debug")
    pg.wait_for_timeout(1500)
    log = {}
    # A：粘贴正确路径（带引号和末尾斜杠，模拟从资源管理器“复制为路径”）
    box_a = pg.locator(".pick").nth(0).locator("input.input").first
    box_a.fill(f'"{abs_a}\\"')
    pg.locator(".pick").nth(0).get_by_role("button", name="打开").click()
    pg.wait_for_selector(".helpersetup", timeout=10000)  # 助手未运行：先给设置说明
    log["setup_shown"] = True
    with pg.expect_file_chooser() as fc:
        pg.get_by_role("button", name="这次先用选择窗口（在窗口里 Ctrl+V 路径）").click()
    pg.wait_for_timeout(300)
    log["hint_visible"] = pg.locator(".pastehint").count() == 1
    log["clipboard"] = pg.evaluate("() => navigator.clipboard.readText()")
    pg.screenshot(path=f"{out}/paste-01-hint.png")
    fc.value.set_files(dir_a)
    pg.wait_for_timeout(1500)
    log["hint_gone"] = pg.locator(".pastehint").count() == 0
    log["fullPath_A"] = pg.evaluate("() => window.__trace.S.dirs.A.value.fullPath")
    # B：粘贴的路径与实际选择不一致 → 提醒
    box_b = pg.locator(".pick").nth(1).locator("input.input").first
    box_b.fill(abs_a)  # 故意粘 A 的路径，却选 B 文件夹
    pg.locator(".pick").nth(1).get_by_role("button", name="打开").click()
    pg.wait_for_selector(".helpersetup", timeout=10000)
    with pg.expect_file_chooser() as fc:
        pg.get_by_role("button", name="这次先用选择窗口（在窗口里 Ctrl+V 路径）").click()
    fc.value.set_files(dir_b)
    pg.wait_for_timeout(1200)
    log["mismatch_toast"] = pg.locator(".toast", has_text="实际选中的是").count() == 1
    log["fullPath_B"] = pg.evaluate("() => window.__trace.S.dirs.B.value.fullPath")
    pg.screenshot(path=f"{out}/paste-02-start.png")
    # 刷新后路径框记住上次粘贴的路径
    pg.reload(); pg.wait_for_timeout(1500)
    log["remembered"] = pg.locator(".pick").nth(0).locator("input.input").first.input_value()
    # 再走一遍并分析，看数据质量页的完整路径
    box_a = pg.locator(".pick").nth(0).locator("input.input").first
    pg.locator(".pick").nth(0).get_by_role("button", name="打开").click()
    pg.wait_for_selector(".helpersetup", timeout=10000)
    with pg.expect_file_chooser() as fc:
        pg.get_by_role("button", name="这次先用选择窗口（在窗口里 Ctrl+V 路径）").click()
    fc.value.set_files(dir_a)
    pg.wait_for_timeout(1000)
    with pg.expect_file_chooser() as fc:
        pg.locator(".pick").nth(1).get_by_role("button", name="选择文件夹…").click()
    fc.value.set_files(dir_b)
    pg.wait_for_timeout(1000)
    pg.get_by_role("button", name="开始分析").click()
    pg.wait_for_function(WAIT, timeout=300000)
    pg.get_by_role("button", name="数据质量", exact=True).click()
    pg.wait_for_timeout(800)
    first_a = pg.locator("td.left", has_text="T537").first.inner_text() if False else pg.locator("tbody tr").nth(1).locator("td").nth(2).inner_text()
    log["quality_path_A537"] = first_a
    pg.screenshot(path=f"{out}/paste-03-quality.png")
    log["errors"] = errs[:5]
    print(json.dumps(log, ensure_ascii=False, indent=1))
    b.close()

checks = {
    "助手未运行时先给设置说明": log["setup_shown"],
    "点打开后出现操作提示": log["hint_visible"],
    "路径已放进剪贴板（去掉引号和末尾斜杠）": log["clipboard"] == abs_a,
    "选完后提示消失": log["hint_gone"],
    "A 记下完整路径": log["fullPath_A"] == abs_a,
    "粘贴与选择不一致时提醒": log["mismatch_toast"],
    "不一致时不冒用错误路径": log["fullPath_B"] == "",
    "刷新后记住上次粘贴的路径": log["remembered"] == abs_a,
    "数据质量页显示文件完整路径": log["quality_path_A537"].startswith(abs_a + "\\") and log["quality_path_A537"].endswith(".csv"),
    "页面无报错": not log["errors"],
}
failed = [k for k, ok in checks.items() if not ok]
assert not failed, f"未通过：{failed}"
print(f"PASS paste_check（{len(checks)} 项）")
