"""单小区分析实测（真实浏览器 + 真实 CSV）：
选“单小区分析” → 选文件夹 → 开始分析 → 概览 / 自动体检 / 用户表 / 叠加用户图表 / 明细 / 数据质量；
概览数值与 A/B 模式同一批次的 A 侧一致，并与 pandas 直接读 CSV 的结果一致；最近分析按模式分开。
用法：python tests/single_check.py <url> <数据目录> <截图目录>"""
import json, os, sys
import pandas as pd
from playwright.sync_api import sync_playwright

url, data_dir, out = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
WAIT = "() => /已就绪|失败|部分完成|已停止/.test(document.querySelector('.prog')?.textContent || '')"
checks = {}
with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": 1500, "height": 950}, accept_downloads=True)
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(url + ("&" if "?" in url else "?") + "picker=input&debug")
    pg.wait_for_timeout(1500)
    pg.locator(".modetabs button", has_text="单小区分析").click()
    checks["切到单小区模式只剩一个文件夹卡片"] = pg.locator(".pick").count() == 1 and pg.get_by_role("button", name="同小区一键匹配").count() == 0
    with pg.expect_file_chooser() as fc:
        pg.locator(".pick").first.get_by_role("button", name="选择文件夹…").click()
    fc.value.set_files(data_dir)
    pg.wait_for_timeout(1500)
    batch = pg.evaluate("() => { const b = window.__trace.S.selection.value.A; return { id: b.batchId, f537: b.traces['537']?.selected.relPath, cell: b.cellName }; }")
    pg.screenshot(path=f"{out}/single-01-start.png")
    pg.get_by_role("button", name="开始分析").click()
    pg.wait_for_function(WAIT, timeout=300000)
    pg.wait_for_function("() => document.querySelectorAll('.kcard').length >= 8", timeout=60000)
    pg.wait_for_timeout(2500)
    run = pg.evaluate("() => { const r = window.__trace.S.run.value; return { status: r.status, steps: r.steps.map((s) => s.id) }; }")
    checks["只读一侧数据（无 B 步骤）"] = run["status"] == "done" and not any(s.startswith("B") or s == "mergeB" for s in run["steps"])
    tabs = pg.locator(".tabs button").all_inner_texts()
    checks["标签页：概览/用户/明细/图表/数据质量"] = tabs[:5] == ["概览", "用户", "明细", "图表", "数据质量"]
    checks["顶栏不出现 A/B"] = pg.locator(".top .k.b").count() == 0 and "单小区分析" in pg.inner_text(".top")
    cards = {pg.locator(".kcard .nm span").nth(i).inner_text(): pg.locator(".kcard").nth(i).locator(".big").first.inner_text() if pg.locator(".kcard").nth(i).locator(".big").count() else "" for i in range(pg.locator(".kcard").count())}
    checks["概览卡片 ≥ 8 张（含 MCS、BLER、截包、Rank2、构成）"] = len(cards) >= 8 and any("MCS 均值" in k for k in cards) and any("BLER" in k for k in cards)
    pg.wait_for_selector(".section .finding, .section .banner.info", timeout=60000)
    n_find = pg.locator(".finding").count()
    checks["自动体检有输出（发现项或“没有异常”）"] = n_find > 0 or pg.locator(".banner.info", has_text="没有发现明显异常").count() == 1
    pg.screenshot(path=f"{out}/single-02-overview.png", full_page=True)

    # 与 pandas 直接读 CSV 对照：MCS 均值
    f537 = os.path.join(os.path.dirname(os.path.abspath(data_dir)), *batch["f537"].split("/"))
    raw = pd.read_csv(f537, low_memory=False)
    mcs_pd = pd.to_numeric(raw["cw0SuMcs"], errors="coerce").mean()
    mcs_web = float([v for k, v in cards.items() if "MCS 均值" in k][0].replace(",", ""))
    checks[f"MCS 均值与 pandas 一致（{mcs_web} vs {mcs_pd:.2f}）"] = abs(mcs_web - mcs_pd) < 0.01

    # 用户表
    pg.locator(".tabs button", has_text="用户").click()
    pg.wait_for_selector(".utable tbody tr", timeout=60000)
    n_users = pg.locator(".utable tbody tr").count()
    t396_users = pg.evaluate("() => window.__trace.S.t396.value?.rows.length || 0")
    checks[f"用户表行数 ≥ T396 用户数（{n_users} / {t396_users}）"] = n_users >= t396_users > 0
    pg.locator(".utable th", has_text="BLER").click()
    pg.wait_for_timeout(300)
    pg.locator(".utable th", has_text="BLER").click()  # 第二次：升序
    pg.wait_for_timeout(300)
    vals = [t for t in pg.locator(".utable tbody tr td:nth-child(9)").all_inner_texts()[:20]]
    for i in range(3):
        pg.locator(".utable tbody tr").nth(i).click()
    sel = pg.evaluate("() => window.__trace.S.users.value")
    checks["点行选中用户（3 个）"] = len(sel) == 3
    with pg.expect_download() as dl:
        pg.get_by_role("button", name="导出 CSV").click()
    exported = open(dl.value.path(), encoding="utf-8-sig").read().splitlines()
    checks["用户表可导出 CSV（行数一致）"] = len(exported) == n_users + 1
    pg.screenshot(path=f"{out}/single-03-users.png")

    # 图表：叠加用户 → 一张图里 3 条线
    pg.get_by_role("button", name="看所选用户图表").click()
    pg.wait_for_function("() => document.querySelectorAll('.chartcard .main-svg').length > 0", timeout=120000)
    pg.get_by_role("button", name="叠加用户").click()
    pg.wait_for_timeout(3000)
    traces = pg.evaluate("() => { const g = document.querySelector('.chartcard .js-plotly-plot'); return g ? g.data.length : 0; }")
    checks[f"叠加用户：第一张图 {traces} 条曲线（应为 3）"] = traces == 3
    pg.screenshot(path=f"{out}/single-04-overlay.png")
    pg.get_by_role("button", name="分图").click()
    pg.wait_for_timeout(2500)

    # 明细：无 A/B 切换
    pg.locator(".tabs button", has_text="明细").click()
    pg.wait_for_timeout(2000)
    checks["明细无 A/B 切换且显示“本小区”"] = pg.locator(".tool .seg button", has_text="B").count() == 0 and "本小区" in pg.inner_text(".content")
    pg.locator(".tabs button", has_text="数据质量").click()
    pg.wait_for_timeout(800)
    checks["数据质量页显示“本小区”"] = "本小区 · 714 匹配率" in pg.inner_text(".content")

    # 与 A/B 模式同一批次的 A 侧对照（引擎已与旧版逐项对照过）
    ab = pg.evaluate("""async () => {
      const S = window.__trace.S;
      return { users: S.t396.value.rows.length, rate: S.t396.value.cellRateA, rows: S.sides.value.A.anchorRows };
    }""")
    pg.get_by_role("button", name="更换数据").click()
    pg.wait_for_timeout(800)
    checks["最近分析里出现这次单小区分析"] = pg.locator(".recent .rr").count() >= 1 and "最近的单小区分析" in pg.inner_text(".recent")
    pg.locator(".modetabs button", has_text="A/B 对比").click()
    pg.wait_for_timeout(500)
    ab_recent = pg.locator(".recent").count() and pg.inner_text(".recent") or ""
    checks["A/B 页不混入单小区记录"] = batch["cell"] not in ab_recent or "vs" in ab_recent
    pg.evaluate(f"() => {{ const S = window.__trace.S; const b = S.dirs.A.value.catalog.batches.find((x) => x.batchId === {json.dumps(batch['id'])}); S.selection.value = {{ A: b, B: null }}; }}")
    pg.get_by_role("button", name="开始分析").click()
    pg.wait_for_function(WAIT, timeout=300000)
    pg.wait_for_timeout(1500)
    ab2 = pg.evaluate("() => { const S = window.__trace.S; return { users: S.t396.value.rows.length, rate: S.t396.value.cellRateA, rows: S.sides.value.A.anchorRows }; }")
    checks["单小区与 A/B 模式同批次 A 侧一致（用户数/小区 Rate/行数）"] = ab == ab2
    checks["页面无报错"] = not errs
    print(json.dumps({"cards": cards, "findings": n_find, "users": n_users, "single": ab, "ab": ab2, "errors": errs[:5]}, ensure_ascii=False, indent=1))
    b.close()

for k, ok in checks.items():
    print(("PASS " if ok else "FAIL ") + k)
failed = [k for k, ok in checks.items() if not ok]
assert not failed, f"未通过：{failed}"
print(f"PASS single_check（{len(checks)} 项）")
