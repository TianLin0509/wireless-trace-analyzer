"""“授权一次总目录，之后粘贴即解析”实测（真实浏览器）。
系统选择窗口无法自动化：测试里把 window.showDirectoryPicker 换成返回浏览器私有文件系统（OPFS）中一个名为 cellDT 的目录，
目录里放真实的测试 CSV，模拟网络盘 \\\\100.100.97.83\\cellDT。其余逻辑（找总目录、逐级找子目录、授权记忆、扫描、分析）全部是真实代码。
用法：python tests/roots_check.py <url> <数据根目录（内含 方案A/方案B）> <截图目录>"""
import json, os, sys
from playwright.sync_api import sync_playwright

url, data_root, out = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
ROOT = "\\\\100.100.97.83\\cellDT"
WAIT = "() => /已就绪|失败|部分完成|已停止/.test(document.querySelector('.prog')?.textContent || '')"
STUB = """
window.__pickCalls = 0;
window.showDirectoryPicker = async () => {
  window.__pickCalls++;
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('cellDT', { create: true });
};
"""
checks = {}
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": 1500, "height": 950}, permissions=["clipboard-read", "clipboard-write"])
    ctx.add_init_script(STUB)
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    sep = "&" if "?" in url else "?"
    pg.goto(url + sep + "debug")
    pg.wait_for_timeout(1500)

    # 准备“网络盘”：把测试数据复制进 OPFS 的 cellDT 目录
    pg.evaluate("() => { const i = document.createElement('input'); i.type = 'file'; i.webkitdirectory = true; i.multiple = true; i.id = '__seed'; document.body.appendChild(i); }")
    pg.set_input_files("#__seed", data_root)
    copied = pg.evaluate("""async () => {
      const files = [...document.getElementById('__seed').files];
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('cellDT', { create: true });
      for (const f of files) {
        const parts = f.webkitRelativePath.split('/').slice(1);
        let d = root;
        for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
        const w = await (await d.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
        await w.write(f); await w.close();
      }
      return files.length;
    }""")

    def box(i):
        return pg.locator(".pick").nth(i).locator("input.input").first

    def calls():
        return pg.evaluate("() => window.__pickCalls")

    # 1) A/B 模式：A 首次需授权一次
    pg.locator(".modetabs button", has_text="A/B 对比").click()
    box(0).fill(f'"{ROOT}\\方案A\\"')
    pg.locator(".pick").nth(0).get_by_role("button", name="解析").click()
    pg.wait_for_function("() => window.__trace.S.dirs.A.value?.catalog", timeout=60000)
    checks["首次解析：弹一次选择窗口授权总目录"] = calls() == 1
    checks["剪贴板里是总目录路径（方便在窗口里粘贴）"] = pg.evaluate("() => navigator.clipboard.readText()") == ROOT
    checks["A 显示完整路径"] = pg.evaluate("() => window.__trace.S.dirs.A.value.fullPath") == f"{ROOT}\\方案A"
    # 2) B 在同一总目录下：直接解析，不再弹窗
    box(1).fill(f"{ROOT}\\方案B")
    box(1).press("Enter")
    pg.wait_for_function("() => window.__trace.S.dirs.B.value?.catalog", timeout=60000)
    checks["B 同一总目录：直接解析，不再弹窗"] = calls() == 1
    checks["已授权列表显示总目录"] = ROOT in pg.inner_text(".envnote")
    pg.screenshot(path=f"{out}/roots-01-ab.png")
    pg.get_by_role("button", name="开始分析").click()
    pg.wait_for_function(WAIT, timeout=300000)
    pg.wait_for_timeout(1500)
    ab = pg.evaluate("() => { const S = window.__trace.S; return { status: S.run.value.status, src: Object.fromEntries(Object.entries(S.sources.value).map(([k, v]) => [k, v.rows])) }; }")
    checks["A/B 分析完成"] = ab["status"] == "done" and len(ab["src"]) >= 4

    # 3) 刷新页面后：授权已记住，单小区模式粘贴路径、直接点“开始分析”（不点解析）即可
    pg.goto(url + sep + "debug")
    pg.wait_for_timeout(1500)
    pg.locator(".modetabs button", has_text="单小区分析").click()
    box(0).fill(f"{ROOT}\\方案b")  # 大小写不同也能找到
    pg.get_by_role("button", name="开始分析").click()
    pg.wait_for_function(WAIT, timeout=300000)
    pg.wait_for_timeout(1500)
    single = pg.evaluate("() => { const S = window.__trace.S; return { status: S.run.value.status, rows: S.sources.value.A537?.rows, path: S.dirs.A.value.fullPath }; }")
    checks["刷新后不再弹窗（授权已记住）"] = calls() == 0
    checks["只粘路径、直接点“开始分析”即可（自动解析）"] = single["status"] == "done"
    checks["路径大小写不同也能找到"] = single["path"].lower() == f"{ROOT}\\方案B".lower()
    checks["单小区读到的是方案 B 的数据"] = single["rows"] == ab["src"].get("B537")

    # 4) 路径写错：给出明确提示，不弹窗
    pg.get_by_role("button", name="更换数据").click()
    pg.wait_for_timeout(500)
    box(0).fill(f"{ROOT}\\不存在的目录")
    pg.locator(".pick").nth(0).get_by_role("button", name="解析").click()
    pg.wait_for_selector(".errbox", timeout=10000)
    checks["路径写错时提示“找不到文件夹”"] = "找不到文件夹" in pg.inner_text(".errbox") and calls() == 0
    pg.screenshot(path=f"{out}/roots-02-error.png")
    pg.locator(".errbox").get_by_role("button", name="关闭").click()

    # 5) 另一个总目录：需要再授权一次
    box(0).fill("\\\\10.0.0.1\\other\\x")
    pg.locator(".pick").nth(0).get_by_role("button", name="解析").click()
    pg.wait_for_timeout(1500)
    checks["不同的总目录才会再弹窗"] = calls() == 1
    checks["页面无报错"] = not errs
    print(json.dumps({"copied_files": copied, "ab": ab, "single": single, "errors": errs[:5]}, ensure_ascii=False, indent=1))
    b.close()

for k, ok in checks.items():
    print(("PASS " if ok else "FAIL ") + k)
failed = [k for k, ok in checks.items() if not ok]
assert not failed, f"未通过：{failed}"
print(f"PASS roots_check（{len(checks)} 项）")
