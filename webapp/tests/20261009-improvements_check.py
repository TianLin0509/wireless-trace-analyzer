"""真实浏览器验证 v1.5 的贡献、范围、分片、异常定位、本地报告及手机布局。
用法：python tests/20261009-improvements_check.py <url> <A目录> <B目录> <产物目录>
合成 CSV；系统目录窗口用 input picker，不能冒充公司真实网盘验证。
"""
import json
import os
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

url, dir_a, dir_b, out = sys.argv[1:5]
Path(out).mkdir(parents=True, exist_ok=True)
checks = {}
errors = []
WAIT = "() => /已就绪|失败|部分完成|已停止/.test(document.querySelector('.prog')?.textContent || '')"


def pick(page, index, folder):
    with page.expect_file_chooser() as chooser:
        page.locator('.pick').nth(index).get_by_role('button', name='选择文件夹…').click()
    chooser.value.set_files(folder)
    page.wait_for_function("i => !!window.__trace.S.dirs[i === 0 ? 'A' : 'B'].value?.catalog", arg=index)


def ready(page):
    page.wait_for_function(WAIT, timeout=120000)
    page.wait_for_function("() => document.querySelectorAll('.kcard').length >= 8", timeout=60000)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(viewport={'width': 1600, 'height': 1000}, accept_downloads=True)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(url + '?picker=input&debug')
    page.wait_for_selector('.modetabs')
    checks['可见版本为 1.7.3'] = page.locator('.ver').inner_text() == 'v1.7.3'
    pick(page, 0, dir_a)
    checks['仅一侧时明确显示仅分析 A'] = page.get_by_role('button', name='仅分析 A').count() == 1
    pick(page, 1, dir_b)
    # 默认同小区 Cell_1 有后续分片；更换实际读取文件，不修改原目录默认配置。
    page.locator('.pick').first.locator('.source-choice summary').click()
    radios = page.locator('input[name="trace-A-537"]')
    checks['读取文件清单显示未使用分片'] = '未使用' in page.locator('.pick').first.locator('.source-choice summary').inner_text() and radios.count() > 1
    radios.last.check()
    chosen = page.evaluate("() => window.__trace.S.selection.value.A.traces['537'].selected.relPath")
    checks['更换分片确实更新选择'] = 'trace_1_' in chosen
    page.get_by_role('button', name='开始分析').click()
    ready(page)
    actual = page.evaluate("() => { const S=window.__trace.S,c=S.t396.value; return {diff:c.diffPct,total:c.rows.reduce((s,r)=>s+r.contributionPt,0),parts:c.rows.every(r=>Math.abs(r.rateContributionPt+r.shareContributionPt-r.contributionPt)<1e-10),source:S.sources.value.A537.relPath}; }")
    checks['全用户贡献加总等于小区变化'] = abs(actual['diff'] - actual['total']) < 1e-10 and actual['parts']
    checks['流水线读取了用户更换的分片'] = actual['source'] == chosen
    checks['标题使用定位建议，不宣称已找到原因'] = '主要来自' not in page.locator('.headline').inner_text()
    page.screenshot(path=f'{out}/20261009-ab-codex.png', full_page=True)

    # 实际通过明细列菜单筛选 MCS，再回结论检查范围提示与 T396。
    before = page.locator('.kcard').first.locator('.big').all_inner_texts()
    page.get_by_role('button', name='明细', exact=True).click()
    page.locator('th', has_text='cw0SuMcs').first.click()
    # 用页面已存在的数值筛选入口。
    page.locator('.colmenu select').select_option('lte')
    page.locator('.colmenu .row input.input').first.fill('10')
    page.get_by_role('button', name='应用').last.click()
    page.get_by_role('button', name='结论', exact=True).click()
    page.wait_for_function("() => document.querySelector('.scope-note')?.innerText.includes('未应用当前列筛选或搜索')")
    page.wait_for_timeout(500)
    checks['筛选后 T396 明确标全批次，数值保留'] = before == page.locator('.kcard').first.locator('.big').all_inner_texts() and '未应用当前列筛选或搜索' in page.locator('.kcard').first.inner_text()
    page.get_by_role('button', name='清除列筛选与搜索').click()
    with page.expect_download() as dl:
        page.get_by_role('button', name='导出报告').click()
    ab_report = f'{out}/20261009-AB分析样例报告-codex.html'
    dl.value.save_as(ab_report)
    text = Path(ab_report).read_text(encoding='utf-8-sig')
    checks['AB 报告有范围、真实文件与贡献拆分'] = all(x in text for x in ['1.7.3', 'T396 全批次', chosen, '占比变化贡献', '跳过坏行'])

    page.get_by_role('button', name='更换数据').click()
    page.locator('.modetabs button', has_text='单小区分析').click()
    page.get_by_role('button', name='开始分析').click()
    ready(page)
    page.wait_for_selector('.user-finding', timeout=60000)
    checks['体检在其他指标之前，按用户合并'] = page.evaluate("() => document.querySelector('.health-section').getBoundingClientRect().top < [...document.querySelectorAll('.sh')].find(e=>e.textContent.includes('其他指标')).getBoundingClientRect().top")
    page.screenshot(path=f'{out}/20261009-single-codex.png', full_page=True)
    target = page.locator('.user-finding').first
    user = target.locator('b').first.inner_text().replace('用户 ', '')
    target.locator('.finding-line button').first.click()
    page.wait_for_selector('.diagnosis-note')
    page.wait_for_timeout(700)
    state = page.evaluate("() => ({users:window.__trace.S.users.value, filters:window.__trace.S.view.value.filters, tab:window.__trace.S.tab.value})")
    checks['异常定位携带用户及候选行条件到明细'] = state['users'] == [user] and state['tab'] == 'tbl' and len(state['filters']) > 0
    checks['候选行说明不是根因结论'] = '候选行' in page.locator('.diagnosis-note').inner_text()
    page.get_by_role('button', name='返回体检范围').click()
    checks['返回体检恢复原筛选与小区范围'] = page.evaluate("() => window.__trace.S.users.value.length===0 && window.__trace.S.view.value.filters.length===0")

    # 真实点用户表三行，叠加显示实际窗口，关闭平滑后与取数一致。
    page.get_by_role('button', name='用户', exact=True).click()
    page.wait_for_selector('.utable tbody tr')
    for i in range(3):
        page.locator('.utable tbody tr').nth(i).click()
    page.get_by_role('button', name='看所选用户图表').click()
    page.wait_for_selector('.js-plotly-plot')
    page.get_by_role('button', name='叠加用户').click()
    page.get_by_label('平滑窗口').select_option('1')
    page.wait_for_function("() => { const e=document.querySelector('.js-plotly-plot'); return e?.data.length===3 && e.data.every(t=>t.name.includes('窗口 1 点')); }")
    checks['叠加图显示每个用户的实际平滑窗口'] = True
    selected = page.evaluate('() => window.__trace.S.users.value')
    page.locator('.chartcard .js-plotly-plot').first.scroll_into_view_if_needed()
    coordinates = page.evaluate("() => {const e=document.querySelector('.js-plotly-plot'),r=e.getBoundingClientRect(),l=e._fullLayout,t=e.data[0],i=Math.min(10,t.x.length-1);return {x:r.x+l.xaxis._offset+l.xaxis.l2p(t.x[i]),y:r.y+l.yaxis._offset+l.yaxis.l2p(t.y[i])};}")
    page.mouse.click(coordinates['x'], coordinates['y'])
    page.wait_for_selector('.modal .tblwrap')
    checks['采样点进入 TTI 上下文且保留多用户选择'] = selected == page.evaluate('() => window.__trace.S.users.value') and 'TTI' in page.locator('.modal header').inner_text()
    page.get_by_role('button', name='关闭', exact=True).click()
    with page.expect_download(timeout=60000) as dl:
        page.get_by_role('button', name='导出报告').click()
    single_report = f'{out}/20261009-单小区分析样例报告-codex.html'
    dl.value.save_as(single_report)
    html = Path(single_report).read_text(encoding='utf-8-sig')
    checks['单小区报告包含内嵌图表及选中用户'] = 'data:image/png;base64,' in html and '逐用户指标' in html and all(u in html for u in selected)
    # 导出的报告在断网浏览器内真实打开，不执行脚本、不加载外部文件。
    offline = browser.new_context(offline=True, viewport={'width': 1200, 'height': 900})
    doc = offline.new_page()
    requested = []
    doc.on('request', lambda r: requested.append(r.url))
    doc.goto(Path(single_report).absolute().as_uri())
    checks['报告断网可打开且图片完整'] = doc.locator('h1').count() == 1 and doc.locator('img').count() > 0 and doc.evaluate('() => [...document.images].every(i=>i.complete && i.naturalWidth>0)')
    checks['报告没有 HTTP 请求'] = not any(x.startswith(('http:', 'https:')) for x in requested)
    doc.screenshot(path=f'{out}/20261009-report-offline-codex.png')
    offline.close()
    page.set_viewport_size({'width': 390, 'height': 844})
    page.get_by_role('button', name='☰').click()
    page.get_by_role('button', name='概览', exact=True).click()
    page.wait_for_function("() => document.querySelectorAll('.kcard:not(.skeleton)').length >= 8 && document.querySelectorAll('.kcard.skeleton').length === 0", timeout=60000)
    page.screenshot(path=f'{out}/20261009-mobile-codex.png', full_page=True)
    checks['手机内容区保持实际宽度，标签正常排列'] = page.evaluate('() => document.querySelector(".main").getBoundingClientRect().width >= innerWidth-20 && document.querySelector(".tabs").getBoundingClientRect().height<100')
    checks['手机页面无横向溢出，报告按钮可见'] = page.evaluate('() => document.documentElement.scrollWidth<=innerWidth+1') and page.get_by_role('button', name='导出报告').is_visible()
    checks['页面无脚本错误'] = not errors
    ctx.close()
    browser.close()

for name, passed in checks.items():
    print(('PASS ' if passed else 'FAIL ') + name)
Path(f'{out}/20261009-improvements-checks-codex.json').write_text(json.dumps({'checks': checks, 'errors': errors}, ensure_ascii=False, indent=2), encoding='utf-8')
failed = [name for name, passed in checks.items() if not passed]
assert not failed, failed
print(f'PASS 改进功能（{len(checks)} 项）')
