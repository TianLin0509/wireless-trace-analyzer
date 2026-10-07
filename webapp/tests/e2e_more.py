"""扩展端到端：批量 KPI → 深挖；改汇总字段重新合并；列取值筛选；导出；视图保存/应用；缩放带入明细；单方案；内存表清理。"""
import sys, json
from playwright.sync_api import sync_playwright

url, dir_a, dir_b, out = sys.argv[1:5]
log = {}


def pick(pg, i, d):
    with pg.expect_file_chooser() as fc:
        pg.locator(".pick").nth(i).get_by_role("button", name="选择文件夹…").click()
    fc.value.set_files(d)
    pg.wait_for_timeout(1000)


def ready(pg):
    pg.wait_for_function("() => /已就绪|失败/.test(document.querySelector('.prog')?.textContent || '')", timeout=300000)


ZOOM_JS = """() => {
  const el = document.querySelector('.chartcard .plotbox');
  const r = el._fullLayout.xaxis.range;
  el.emit('plotly_relayout', { 'xaxis.range[0]': r[0] + (r[1] - r[0]) * 0.2, 'xaxis.range[1]': r[0] + (r[1] - r[0]) * 0.3 });
}"""

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": 1500, "height": 900}, accept_downloads=True)
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    pg.goto(url + "?picker=input&debug")
    pg.wait_for_timeout(1500)
    pick(pg, 0, dir_a)
    pick(pg, 1, dir_b)
    # 1) 批量 KPI
    pg.get_by_role("button", name="批量 KPI（多小区）").click(); pg.wait_for_timeout(500)
    pg.get_by_role("button", name="开始 KPI 对比").click()
    pg.wait_for_selector("text=深挖", timeout=120000); pg.wait_for_timeout(500)
    pg.screenshot(path=f"{out}/more-01-kpi.png")
    log["kpi_rows"] = pg.locator("tbody tr").count()
    pg.get_by_role("button", name="深挖").first.click(); ready(pg); pg.wait_for_timeout(1500)
    log["dive_users"] = pg.evaluate("() => window.__trace.S.users.value")
    log["dive_cell"] = pg.evaluate("() => window.__trace.S.selection.value.A.cellName")
    log["has_714_keys"] = pg.evaluate("() => window.__trace.S.sides.value.A.columns.includes('714_crnti')")
    # 2) 改汇总字段：去掉 bandCqiCw0，重新合并；用户范围应保留
    pg.get_by_role("button", name="明细", exact=True).click(); pg.wait_for_timeout(800)
    pg.get_by_role("button", name="字段", exact=False).first.click(); pg.wait_for_timeout(300)
    pg.get_by_role("button", name="汇总字段（537 / 714）").click(); pg.wait_for_timeout(300)
    pg.locator("label", has_text="bandCqiCw0").locator("input").first.uncheck()
    pg.get_by_role("button", name="应用并重新合并").click(); pg.wait_for_timeout(600); ready(pg); pg.wait_for_timeout(800)
    log["after_remerge_has_band"] = pg.evaluate("() => window.__trace.S.sides.value.A.columns.includes('bandCqiCw0')")
    log["dive_users_kept"] = pg.evaluate("() => window.__trace.S.users.value.length")
    # 3) 列取值筛选：schType 只看 DL
    pg.locator("th", has_text="schType").first.click(); pg.wait_for_timeout(800)
    pg.locator(".colmenu").get_by_role("button", name="清空", exact=True).click()
    pg.locator(".colmenu label.v", has_text="DL").filter(has_not_text="RETX").locator("input").check()
    pg.get_by_role("button", name="仅看勾选值").click(); pg.wait_for_timeout(1200)
    log["filters"] = pg.evaluate("() => window.__trace.S.view.value.filters")
    log["pager"] = pg.inner_text(".pager").split("\n")[0]
    # 4) 导出
    with pg.expect_download() as dl:
        pg.get_by_role("button", name="导出 CSV").click()
    path = f"{out}/{dl.value.suggested_filename}"
    dl.value.save_as(path)
    log["export"] = {"name": dl.value.suggested_filename, "lines": sum(1 for _ in open(path, encoding="utf-8-sig")) - 1}
    # 5) 保存视图 → 恢复默认（应自动按默认字段重新合并、搜索框同步）→ 应用视图
    pg.get_by_role("button", name="视图：", exact=False).click(); pg.wait_for_timeout(300)
    pg.get_by_role("button", name="另存当前").click()
    pg.locator(".pop input.input").fill("只看DL-测试")
    pg.get_by_role("button", name="确定").click(); pg.wait_for_timeout(500)
    pg.get_by_role("button", name="恢复默认").click(); pg.wait_for_timeout(800); ready(pg); pg.wait_for_timeout(800)
    log["after_default"] = {
        "filters": len(pg.evaluate("() => window.__trace.S.view.value.filters")),
        "has_band": pg.evaluate("() => window.__trace.S.sides.value.A.columns.includes('bandCqiCw0')"),
    }
    pg.get_by_role("button", name="视图：", exact=False).click(); pg.wait_for_timeout(500)
    pg.locator(".pop .row", has_text="只看DL-测试").get_by_role("button", name="应用").click()
    pg.wait_for_timeout(800); ready(pg); pg.wait_for_timeout(1000)
    log["after_apply"] = {
        "filters": len(pg.evaluate("() => window.__trace.S.view.value.filters")),
        "has_band": pg.evaluate("() => window.__trace.S.sides.value.A.columns.includes('bandCqiCw0')"),
        "name": pg.evaluate("() => window.__trace.S.view.value.name"),
    }
    # 6) 缩放序列图 → 带入明细
    pg.evaluate("() => window.__trace.S.updateView({ filters: [] })")
    pg.get_by_role("button", name="图表", exact=True).click()
    pg.wait_for_function("() => document.querySelectorAll('.chartcard .main-svg').length > 0", timeout=60000)
    pg.wait_for_timeout(1500)
    pg.evaluate(ZOOM_JS)
    pg.wait_for_timeout(500)
    pg.get_by_role("button", name="在明细中只看这段 TTI").click(); pg.wait_for_timeout(1500)
    log["zoom_filter"] = pg.evaluate("() => window.__trace.S.view.value.filters.find(f => f.column === 'tti')")
    log["zoom_tab"] = pg.evaluate("() => window.__trace.S.tab.value")
    log["zoom_pager"] = pg.inner_text(".pager").split("\n")[0]
    pg.screenshot(path=f"{out}/more-02-zoom-table.png")
    # 7) 单方案：更换数据，B 选空；用户范围应重置
    pg.get_by_role("button", name="更换数据").click(); pg.wait_for_timeout(500)
    pg.locator(".pick").nth(1).locator("select").last.select_option("")
    pg.get_by_role("button", name="开始分析").click(); ready(pg); pg.wait_for_timeout(1500)
    log["single_status"] = pg.inner_text(".prog")
    log["single_users_reset"] = pg.evaluate("() => window.__trace.S.users.value.length")
    pg.screenshot(path=f"{out}/more-03-single.png")
    log["tables_left"] = pg.evaluate("async () => await window.__trace.db.listTables()")
    log["errors"] = errs[:10]
    print(json.dumps(log, ensure_ascii=False, indent=1))
    b.close()
