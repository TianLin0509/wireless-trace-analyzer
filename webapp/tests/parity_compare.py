"""对比新旧引擎结果。相对误差 > 1e-6 视为不一致。"""
import json, sys, math

old, new = (json.load(open(f, encoding="utf-8")) for f in sys.argv[1:3])
bad, n = [], 0


def cmp(path, a, b):
    global n
    n += 1
    if a is None or b is None:
        if a != b:
            bad.append((path, a, b))
        return
    if not math.isclose(float(a), float(b), rel_tol=1e-6, abs_tol=1e-9):
        bad.append((path, a, b))


cmp("t396.cellA", old["t396"]["cellA"], new["t396"]["cellA"])
cmp("t396.cellB", old["t396"]["cellB"], new["t396"]["cellB"])
for u, v in old["t396"]["users"].items():
    w = new["t396"]["users"].get(u)
    if w is None:
        bad.append((f"t396.user {u}", v, None))
        continue
    for i, k in enumerate(["rateA", "rateB", "shareA", "shareB"]):
        cmp(f"t396.{u}.{k}", v[i], w[i])
for s in old["merge"]:
    for k, v in old["merge"][s].items():
        cmp(f"merge.{s}.{k}", v, new["merge"][s][k])
    for m, st in old["metrics"][s].items():
        for k, v in st.items():
            cmp(f"metric.{s}.{m}.{k}", v, new["metrics"][s][m][k])
    for u, v in old["bler"][s].items():
        cmp(f"bler.{s}.{u}", v, new["bler"][s].get(u))
for u in new["t396"]["users"]:
    if u not in old["t396"]["users"]:
        bad.append((f"t396.extra_user {u}", None, new["t396"]["users"][u]))
if n < 80:
    bad.append(("比对项过少", n, ">=80"))
print(f"对比 {n} 项，不一致 {len(bad)} 项")
for x in bad[:30]:
    print("  ", x)
sys.exit(1 if bad else 0)
