"""从 gen_sample_data.py 的输出中复制 Cell_7，并在方案 A 的 T537 里注入各种格式问题，用于异常处理测试。
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
print("dirty:", a537)
