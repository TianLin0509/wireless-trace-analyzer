"""本机助手实测：
1) 助手安全边界（直接发 HTTP 请求）：拒绝外站 Origin、伪造 Host、跳出目录、非 Trace 文件；支持分段读取。
2) 真实浏览器：粘贴路径 → 回车 → 不弹任何窗口直接扫描 → 分析，结果与“选择文件夹”方式逐项一致；
   数据质量页显示完整路径；最近分析一键恢复（走助手）；助手未运行时给出设置说明且可下载助手。
用法：python tests/helper_check.py <url> <A目录> <B目录> <截图目录>"""
import json, os, subprocess, sys, time, urllib.parse, urllib.request, urllib.error
from playwright.sync_api import sync_playwright

url, dir_a, dir_b, out = sys.argv[1:5]
os.makedirs(out, exist_ok=True)
abs_a, abs_b = os.path.abspath(dir_a), os.path.abspath(dir_b)
HELPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "helper", "trace_helper.py")
BASE = "http://127.0.0.1:17861"
SITE = "https://trace.lt-stockpartner.tech"
WAIT = "() => /已就绪|失败|部分完成|已停止/.test(document.querySelector('.prog')?.textContent || '')"
checks = {}


def start_helper():
    p = subprocess.Popen([sys.executable, HELPER, "--no-prompt"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    for _ in range(50):
        try:
            urllib.request.urlopen(BASE + "/ping", timeout=1)
            return p
        except Exception:
            time.sleep(0.1)
    p.kill()
    raise SystemExit("助手没能启动：" + p.stdout.read().decode("utf-8", "replace"))


def req(path, headers=None, method="GET"):
    r = urllib.request.Request(BASE + path, headers=headers or {}, method=method)
    try:
        with urllib.request.urlopen(r, timeout=30) as res:
            return res.status, dict(res.headers), res.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


q = urllib.parse.quote
helper = start_helper()
try:
    # ---------- 1) 安全边界 ----------
    st, _, body = req(f"/scan?path={q(abs_a)}", {"Origin": SITE})
    scan = json.loads(body)
    checks["站点来源可扫描，找到 Trace 文件"] = st == 200 and len(scan["files"]) > 0 and scan["root"] == abs_a
    one = scan["files"][0]["rel"]
    checks["外站 Origin 被拒绝"] = req(f"/scan?path={q(abs_a)}", {"Origin": "https://evil.example"})[0] == 403
    checks["没有 Origin 的扫描被拒绝"] = req(f"/scan?path={q(abs_a)}")[0] == 403
    checks["伪造 Host（DNS 重绑定）被拒绝"] = req(f"/scan?path={q(abs_a)}", {"Origin": SITE, "Host": "evil.example:17861"})[0] == 403
    root_name = os.path.basename(abs_a)
    checks["跳出目录（..）被拒绝"] = req(f"/file?root={q(abs_a)}&rel={q(root_name + '/../方案B/x/Dest_T537_a.csv')}", {"Origin": SITE})[0] == 403
    checks["非 Trace 文件被拒绝"] = req(f"/file?root={q(abs_a)}&rel={q(root_name + '/readme.txt')}", {"Origin": SITE})[0] == 403
    st, h, body = req(f"/file?root={q(abs_a)}&rel={q(one)}", {"Origin": SITE, "Range": "bytes=0-99"})
    real = os.path.join(os.path.dirname(abs_a), *one.split("/"))
    checks["分段读取正确（206 + 前 100 字节一致）"] = st == 206 and body == open(real, "rb").read(100) and h.get("Access-Control-Allow-Origin") == SITE
    st, h, _ = req(f"/file?root={q(abs_a)}&rel={q(one)}", {"Origin": SITE, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "range"}, "OPTIONS")
    checks["预检放行本站且声明本机访问"] = st == 204 and h.get("Access-Control-Allow-Private-Network") == "true"
    checks["不存在的路径给出中文提示"] = "找不到这个文件夹" in json.loads(req(f"/scan?path={q(abs_a + '_不存在')}", {"Origin": SITE})[2])["error"]

    # ---------- 2) 浏览器端到端 ----------
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(viewport={"width": 1500, "height": 900}, accept_downloads=True)
        pg = ctx.new_page()
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)))
        sep = "&" if "?" in url else "?"

        def result():
            return pg.evaluate("""() => {
              const S = window.__trace.S;
              const src = Object.fromEntries(Object.entries(S.sources.value).map(([k, v]) => [k, { rows: v.rows, cols: (v.columns || []).length, users: v.users ?? null }]));
              return { status: S.run.value.status, src, cards: [...document.querySelectorAll('.kcard')].map((c) => c.innerText.replace(/\\s+/g, ' ')).slice(0, 12) };
            }""")

        def analyse():
            pg.get_by_role("button", name="开始分析").click()
            pg.wait_for_function(WAIT, timeout=300000)
            pg.wait_for_function("() => document.querySelectorAll('.kcard').length >= 6", timeout=60000)
            pg.wait_for_timeout(1500)
            return result()

        # 基准：原来的“选择文件夹”方式
        pg.goto(url + sep + "picker=input&debug")
        pg.wait_for_timeout(1500)
        for i, d in enumerate((dir_a, dir_b)):
            with pg.expect_file_chooser() as fc:
                pg.locator(".pick").nth(i).get_by_role("button", name="选择文件夹…").click()
            fc.value.set_files(d)
            pg.wait_for_timeout(1200)
        base = analyse()

        # 新方式：粘贴路径 → 回车，全程不应弹出选择窗口
        pg.goto(url + sep + "debug&helper=1")
        pg.wait_for_timeout(1500)
        checks["顶栏显示助手已连接"] = pg.locator(".helperchip.on").count() == 1
        choosers = []
        pg.on("filechooser", lambda f: choosers.append(f))
        t0 = time.time()
        for i, d in enumerate((abs_a, abs_b)):
            box = pg.locator(".pick").nth(i).locator("input.input").first
            box.fill(f'"{d}\\"')  # 模拟“复制为路径”带引号和末尾斜杠
            box.press("Enter")
            pg.wait_for_function(f"() => window.__trace.S.dirs.{'AB'[i]}.value?.catalog", timeout=60000)
        scan_sec = time.time() - t0
        checks["粘贴路径回车后直接读取，不弹选择窗口"] = not choosers
        checks["A/B 记下完整路径且来源为助手"] = pg.evaluate("() => [window.__trace.S.dirs.A.value.fullPath, window.__trace.S.dirs.B.value.via]") == [abs_a, "helper"]
        pg.screenshot(path=f"{out}/helper-01-start.png")
        t0 = time.time()
        via = analyse()
        run_sec = time.time() - t0
        checks["分析完成"] = via["status"] == "done"
        checks["结果与选择文件夹方式逐项一致（行数/列数/用户数/结论卡片）"] = via["src"] == base["src"] and via["cards"] == base["cards"]
        pg.get_by_role("button", name="数据质量", exact=True).click()
        pg.wait_for_timeout(800)
        qp = pg.locator("tbody tr").nth(1).locator("td").nth(2).inner_text()
        checks["数据质量页显示完整路径"] = qp.startswith(abs_a + os.sep) and qp.endswith(".csv")
        pg.screenshot(path=f"{out}/helper-02-quality.png")

        # 最近分析：一键恢复走助手，不弹窗口
        pg.goto(url + sep + "debug&helper=1")
        pg.wait_for_timeout(1500)
        pg.locator(".recent .rr").first.get_by_role("button", name="一键恢复").click()
        pg.wait_for_function(WAIT, timeout=300000)
        pg.wait_for_timeout(1500)
        rec = result()
        checks["最近分析一键恢复（助手）结果一致"] = rec["status"] == "done" and rec["src"] == base["src"] and not choosers

        # 旧版习惯：只粘一个总目录（A/B 都在里面），B 点“与 A 同一文件夹”自动配批次
        parent = os.path.dirname(abs_a)
        pg.goto(url + sep + "debug&helper=1")
        pg.wait_for_timeout(1500)
        box = pg.locator(".pick").nth(0).locator("input.input").first
        box.fill(parent)
        box.press("Enter")
        pg.wait_for_function("() => window.__trace.S.dirs.A.value?.catalog", timeout=60000)
        pg.locator(".pick").nth(1).get_by_role("button", name="与 A 同一文件夹").click()
        pg.wait_for_timeout(500)
        pair = pg.evaluate("() => { const s = window.__trace.S.selection.value; return [s.A?.cellName, s.B?.cellName, s.A?.caseName, s.B?.caseName]; }")
        checks["总目录 + “与 A 同一文件夹”自动配成同小区不同 Case"] = pair[0] == pair[1] and pair[0] and pair[2] != pair[3]
        pg.screenshot(path=f"{out}/helper-04-sameroot.png")
        same = analyse()
        checks["总目录方式分析完成"] = same["status"] == "done"

        # 助手未运行：给设置说明，可下载助手；可退回选择窗口方式
        helper.terminate(); helper.wait(10)
        pg.goto(url + sep + "debug&helper=1")
        pg.wait_for_timeout(2500)
        checks["顶栏显示助手未运行"] = pg.locator(".helperchip:not(.on)").count() == 1
        box = pg.locator(".pick").nth(0).locator("input.input").first
        box.fill(abs_a)
        box.press("Enter")
        pg.wait_for_selector(".helpersetup", timeout=10000)
        pg.screenshot(path=f"{out}/helper-03-setup.png")
        with pg.expect_download() as dl:
            pg.locator(".helpersetup a", has_text="下载 trace_helper.py").click()
        path = dl.value.path()
        checks["可下载助手且内容完整"] = dl.value.suggested_filename == "trace_helper.py" and open(path, "rb").read() == open(HELPER, "rb").read()
        # 用户按说明启动助手后点“已启动，重试”，直接读入
        helper = start_helper()
        pg.get_by_role("button", name="已启动，重试").click()
        pg.wait_for_function("() => window.__trace.S.dirs.A.value?.via === 'helper'", timeout=60000)
        checks["启动助手后点重试即读入"] = pg.locator(".helpersetup").count() == 0
        checks["页面无报错"] = not errs
        print(json.dumps({"scan_seconds_AB": round(scan_sec, 2), "analyse_seconds": round(run_sec, 1), "sources": via["src"], "errors": errs[:5]}, ensure_ascii=False, indent=1))
        b.close()
finally:
    helper.terminate()

for k, ok in checks.items():
    print(("PASS " if ok else "FAIL ") + k)
failed = [k for k, ok in checks.items() if not ok]
assert not failed, f"未通过：{failed}"
print(f"PASS helper_check（{len(checks)} 项）")
