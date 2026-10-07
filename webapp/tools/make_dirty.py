"""从 gen_sample_data.py 的输出中复制 Cell_7，制造两类异常数据，用于异常处理测试：
  <输出根目录>/方案A、方案B：方案 A 的 T537 注入各种格式问题（坏行、表头空格、小写连接键、BOM/CRLF、N/A、引号内逗号、开头为空的列）
  <输出根目录>/方案B_缺连接键：方案 B 的 T537 去掉 crnti 列，用来验证“一侧读取失败”时页面如实显示部分完成
用法：python tools/make_dirty.py <样例数据根目录> <输出根目录>"""
import os, shutil, sys

src, dst = sys.argv[1:3]
shutil.rmtree(dst, ignore_errors=True)
for side in ("方案A", "方案B"):
    for root, _, files in os.walk(os.path.join(src, side)):
        if "Cell_7" not in root:
            continue
        rel = os.path.relpath(root, src)
        os.makedirs(os.path.join(dst, rel), exist_ok=True)
        for f in files:
            shutil.copy(os.path.join(root, f), os.path.join(dst, rel, f))

# 方案 B 的副本：T537 表头去掉 crnti（合并必需的连接键）
broken_root = os.path.join(dst, "方案B_缺连接键")
shutil.copytree(os.path.join(dst, "方案B"), broken_root)
b537 = [os.path.join(r, f) for r, _, fs in os.walk(broken_root) for f in fs if "T537" in f][0]
blines = open(b537, encoding="utf-8").read().split("\n")
blines[0] = blines[0].replace("crnti", "crnti_removed", 1)
open(b537, "w", encoding="utf-8", newline="").write("\n".join(blines))

a537 = [os.path.join(r, f) for r, _, fs in os.walk(os.path.join(dst, "方案A")) for f in fs if "T537" in f][0]
lines = open(a537, encoding="utf-8").read().split("\n")
hdr = lines[0].split(",")
hdr[10] = " cw0SuMcs "              # 表头带空格
hdr[2] = "hh:mm:ss"                 # 连接键大小写不同
hdr[-1] = "lateCol"                 # 开头一段为空、后面才有数的列
lines[0] = ",".join(hdr)
for i in range(1, 9000):            # lateCol 前 9000 行置空（超过预检采样范围）
    c = lines[i].split(",")
    c[-1] = ""
    lines[i] = ",".join(c)
lines[5] = lines[5] + ",多出来的字段"            # 字段数过多
lines[9] = ",".join(lines[9].split(",")[:5])     # 字段数过少
c = lines[12].split(","); c[10] = "N/A"; lines[12] = ",".join(c)          # 数值列混入文本
c = lines[15].split(","); c[7] = '"DL,特殊"'; lines[15] = ",".join(c)     # 引号内逗号
open(a537, "w", encoding="utf-8-sig", newline="").write("\r\n".join(lines))  # BOM + CRLF
data_lines = sum(1 for ln in lines[1:] if ln.strip())
with open(os.path.join(dst, "expected.txt"), "w", encoding="utf-8") as fh:
    fh.write(str(data_lines))      # 供测试独立核对：A537 的数据行数（含 2 条坏行）
print("dirty:", a537, "data lines:", data_lines)
