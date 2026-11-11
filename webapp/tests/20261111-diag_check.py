"""诊断页签实测（真实浏览器 + 场景数据）：单小区与 A/B 两种模式，走 速率拆解 / 链路诊断 / 异常事件 / 时间轴，
核对注入故障能被找出来，截图，并检查 1440×900 下内容区是否出现纵向滚动。
用法：python tests/20261111-diag_check.py <url> <场景根目录> <输出目录>
场景数据：python tools/gen_scenario_data.py <场景根目录>"""
import json, os, sys
from playwright.sync_api import sync_playwright

url, root, out = sys.argv[1:4]
os.makedirs(out, exist_ok=True)
WAIT = "() => /已就绪|失败|部分完成|已停止/.test(document.querySelector('.prog')?.textContent || '')"
A_DIR = os.path.join(root, "场景A")
B_DIR = os.path.join(root, "场景B")
checks, notes = {}, {}


def nk(d):
    """真实形态数据里 ambr 写成 19980000xx，归一回 50xx 便于对照标准答案。"""
    return {('50' + k[-2:] if k.startswith('1998000') else k): v for k, v in d.items()}


def scroll_info(pg):
    return pg.evaluate("() => { const c = document.querySelector('#content'); return { sh: c.scrollHeight, ch: c.clientHeight }; }")


def visit(pg, label, name, wait_sel, timeout=90000):
    pg.locator(".tabs button", has_text=label).click()
    pg.wait_for_selector(wait_sel, timeout=timeout)
    pg.wait_for_timeout(1200)
    pg.screenshot(path=f"{out}/{name}.png")
    s = scroll_info(pg)
    notes[f"{name} 内容高/可视高"] = f"{s['sh']}/{s['ch']}"
    return s


with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: m.type == "error" and errs.append("console: " + m.text))
    pg.goto(url + ("&" if "?" in url else "?") + "picker=input&debug")
    pg.wait_for_timeout(1500)
    # ---------- 单小区：场景 A ----------
    pg.locator(".modetabs button", has_text="单小区分析").click()
    with pg.expect_file_chooser() as fc:
        pg.locator(".pick").first.get_by_role("button", name="选择文件夹…").click()
    fc.value.set_files(A_DIR)
    pg.wait_for_timeout(1500)
    pg.get_by_role("button", name="开始分析").click()
    pg.wait_for_function(WAIT, timeout=300000)
    pg.wait_for_timeout(1500)
    tabs = pg.locator(".tabs button").all_inner_texts()
    checks["单小区页签含 速率拆解/链路诊断/异常事件/时间轴"] = all(t in tabs for t in ["速率拆解", "链路诊断", "异常事件", "时间轴"])
    s = visit(pg, "诊断结论", "s0-conclude", ".concl-row", 180000)
    concl = nk(pg.evaluate("() => Object.fromEntries([...document.querySelectorAll('.concl-row')].map((r) => [r.querySelector('.concl-id b').textContent.trim(), [...r.querySelectorAll('.concl-body .tag')].map((t) => t.textContent)]))"))
    notes["诊断结论"] = concl
    checks["结论：5008 首要问题 = 业务量不足"] = (concl.get("5008") or [""])[0].startswith("业务量不足")
    checks["结论：5005 含 CQI 偏乐观"] = any("CQI 偏乐观" in t for t in concl.get("5005", []))
    checks["结论：5006 含 PDCCH 漏检"] = any("PDCCH 漏检" in t for t in concl.get("5006", []))
    checks["结论：5007 含 信道波动大"] = any("信道波动" in t for t in concl.get("5007", []))
    checks["结论：5004 / 5002（好用户）首要问题不是链路类"] = all(not any(k in (concl.get(u) or [""])[0] for k in ("CQI", "波动", "PDCCH")) for u in ("5004", "5002"))
    checks["诊断结论一屏"] = s["sh"] <= s["ch"] + 4
    s = visit(pg, "速率拆解", "s1-rate", ".factor-cards .kcard")
    rows = pg.evaluate("() => [...document.querySelectorAll('.diag .section tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim()))")
    si = head_idx = None
    head0 = pg.evaluate("() => [...document.querySelectorAll('.diag .section thead th')].map((th) => th.textContent.trim())")
    si = head0.index("短板")
    weak = nk({r[0]: r[si] for r in rows if len(r) > si})
    notes["速率拆解短板"] = weak
    pi = head0.index("PDCCH送达")
    pd_ = nk({r[0]: float(r[pi]) for r in rows if len(r) > pi and r[pi] not in ("—", "")})
    checks["5006 PDCCH 送达率最低（DTX 注入）"] = bool(pd_) and min(pd_, key=pd_.get) == "5006"
    head = pg.evaluate("() => [...document.querySelectorAll('.diag .section thead th')].map((th) => th.textContent.trim())")
    di = head.index("数据受限") if "数据受限" in head else None
    data_lim = nk({r[0]: r[di] for r in rows if di is not None and len(r) > di})
    notes["数据受限"] = data_lim
    checks["5005 CQI 虚高 → 短板含每RB每层比特或译码"] = any(k in weak.get("5005", "") for k in ("每RB每层比特", "初传译码成功"))
    checks["5008 小包 → 数据受限最高"] = bool(data_lim) and max(data_lim, key=lambda u: float(data_lim[u].rstrip('%') or 0)) == "5008"
    checks["速率拆解一屏（无纵向滚动）"] = s["sh"] <= s["ch"] + 4
    s = visit(pg, "链路诊断", "s2-link", ".diag .section tbody tr")
    flags = pg.evaluate("() => Object.fromEntries([...document.querySelectorAll('.diag .section tbody tr')].map((tr) => [tr.children[0].textContent.trim(), [...tr.querySelectorAll('.tag')].map((t) => t.textContent)]))")
    flags = nk(flags)
    notes["链路判读"] = flags
    checks["5005 OLLA 深负"] = "OLLA 深负" in flags.get("5005", [])
    bl = pg.evaluate("() => { const h = [...document.querySelectorAll('.diag .section thead th')].map((th) => th.textContent.trim()); const i = h.indexOf('BLER'); return Object.fromEntries([...document.querySelectorAll('.diag .section tbody tr')].map((tr) => [tr.children[0].textContent.trim(), parseFloat(tr.children[i].textContent)])); }")
    bl = nk(bl)
    notes["初传 BLER"] = bl
    checks["5007 快衰落 → 初传 BLER 最高"] = bool(bl) and max(bl, key=lambda k: bl[k] if bl[k] == bl[k] else -1) == "5007"
    checks["OLLA 深负只标少数用户（≤ 3 个）"] = sum("OLLA 深负" in v for v in flags.values()) <= 3
    checks["链路诊断一屏"] = s["sh"] <= s["ch"] + 4
    s = visit(pg, "异常事件", "s3-events", ".diag-top.evt, .diag .banner.info", 180000)
    mat = pg.evaluate("() => Object.fromEntries([...document.querySelectorAll('.diag-top.evt tbody tr')].map((tr) => [tr.children[0].textContent.trim(), [...tr.children].slice(1).map((td) => td.textContent.trim())]))")
    mat = nk(mat)
    notes["事件矩阵（NACK/DTX/失败/MCS/OLLA/合计）"] = mat
    checks["5006 有连续 DTX 事件"] = bool(mat.get("5006")) and mat["5006"][1] not in ("", "0")
    checks["异常事件一屏"] = s["sh"] <= s["ch"] + 4
    # 从事件跳时间轴
    pg.locator(".diag .section tbody tr button", has_text="看时间轴").first.click()
    pg.wait_for_selector(".diag .plotbox .main-svg", timeout=90000)
    pg.wait_for_timeout(1500)
    pg.screenshot(path=f"{out}/s4-timeline.png")
    s = scroll_info(pg)
    notes["s4-timeline 内容高/可视高"] = f"{s['sh']}/{s['ch']}"
    checks["事件 → 时间轴：显示事件来源横幅"] = pg.locator(".diag .banner.info", has_text="来自异常事件").count() == 1
    checks["时间轴一屏"] = s["sh"] <= s["ch"] + 4
    with pg.expect_download(timeout=120000) as dl:
        pg.get_by_role("button", name="导出报告").click()
    rep = open(dl.value.path(), encoding="utf-8").read()
    checks["单小区导出报告含诊断结论（业务量不足）"] = "<h2>诊断结论</h2>" in rep and "业务量不足" in rep
    # ---------- A/B：场景 A vs 场景 B ----------
    pg.goto(url + ("&" if "?" in url else "?") + "picker=input&debug")
    pg.wait_for_timeout(1500)
    pg.locator(".modetabs button", has_text="A/B").first.click()
    pg.wait_for_timeout(500)
    for i, d in enumerate([A_DIR, B_DIR]):
        with pg.expect_file_chooser() as fc:
            pg.locator(".pick").nth(i).get_by_role("button", name="选择文件夹…").click()
        fc.value.set_files(d)
        pg.wait_for_timeout(1200)
    pg.get_by_role("button", name="开始分析").click()
    pg.wait_for_function(WAIT, timeout=300000)
    pg.wait_for_timeout(1500)
    s = visit(pg, "诊断结论", "ab0-conclude", ".concl-row", 180000)
    cell_line = pg.inner_text(".concl-cell")
    notes["A/B 小区结论"] = cell_line
    checks["A/B 结论：小区一句话含 调度成功率"] = "调度成功率" in cell_line
    abc = nk(pg.evaluate("() => Object.fromEntries([...document.querySelectorAll('.concl-row')].map((r) => [r.querySelector('.concl-id b').textContent.trim(), r.querySelector('.concl-body').innerText]))"))
    notes["A/B 用户结论"] = abc
    checks["A/B 结论：5003 主因 每RB每层比特"] = "每RB每层比特" in abc.get("5003", "").splitlines()[0] if abc.get("5003") else False
    checks["A/B 诊断结论一屏"] = s["sh"] <= s["ch"] + 4
    s = visit(pg, "速率拆解", "ab1-rate", ".diag .section tbody tr")
    ab = pg.evaluate("() => [...document.querySelectorAll('.diag .section tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim()))")
    main = nk({r[0]: r[-1] for r in ab})
    notes["A/B 主因"] = main
    side_cards = pg.locator(".diag-side .kcard").all_inner_texts()
    notes["A/B 侧栏"] = side_cards
    checks["5003 干扰突发 → 主因是每RB每层比特（MCS）"] = main.get("5003") == "每RB每层比特"
    checks["小区主要变化来源含 调度成功率（CCE 失败升高）"] = any("调度成功率" in c for c in side_cards if "主要变化来源" in c)
    checks["A/B 速率拆解一屏"] = s["sh"] <= s["ch"] + 4
    s = visit(pg, "链路诊断", "ab2-link", ".diag .section tbody tr")
    checks["A/B 链路诊断一屏"] = s["sh"] <= s["ch"] + 4
    pg.locator(".diag .seg button", has_text="方案 B").click()
    pg.wait_for_timeout(1500)
    s = visit(pg, "异常事件", "ab3-events", ".diag-top.evt, .diag .banner.info", 180000)
    pg.locator(".diag .seg button", has_text="方案 B").click()
    pg.wait_for_timeout(4000)
    pg.screenshot(path=f"{out}/ab3-events-B.png")
    matB = pg.evaluate("() => Object.fromEntries([...document.querySelectorAll('.diag-top.evt tbody tr')].map((tr) => [tr.children[0].textContent.trim(), [...tr.children].slice(1).map((td) => td.textContent.trim())]))")
    matB = nk(matB)
    notes["B 事件矩阵"] = matB
    checks["B：5003 有连续 NACK 或 MCS 骤降事件"] = bool(matB.get("5003")) and (matB["5003"][0] not in ("", "0") or matB["5003"][3] not in ("", "0"))
    checks["B：出现连续调度失败事件"] = any(v[2] not in ("", "0") for v in matB.values())
    s = visit(pg, "时间轴", "ab4-timeline", ".diag .plotbox .main-svg")
    with pg.expect_download(timeout=120000) as dl:
        pg.get_by_role("button", name="导出报告").click()
    rep = open(dl.value.path(), encoding="utf-8").read()
    checks["A/B 导出报告含诊断结论（调度成功率）"] = "<h2>诊断结论</h2>" in rep and "调度成功率" in rep
    checks["页面无脚本错误"] = not errs
    notes["errors"] = errs[:10]
    b.close()

res = {"checks": checks, "notes": notes, "passed": sum(checks.values()), "total": len(checks)}
open(f"{out}/20261111-diag-check.json", "w", encoding="utf-8").write(json.dumps(res, ensure_ascii=False, indent=2))
for k, v in checks.items():
    print(("PASS " if v else "FAIL ") + k)
print(f"{res['passed']}/{res['total']}")
