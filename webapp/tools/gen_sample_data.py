"""Generate realistic synthetic T396/T537/T714 field-trace folders for local testing.

Layout mirrors the real export:  <root>/<case>/<cell>/ParseResult/Dest_T537_..._trace_0_<14-digit time>.csv

Usage:
    python gen_sample_data.py <root> --rows 60000
    python gen_sample_data.py <root> --rows 500000 --wide 185 --wide714 80 --cells Cell_3 --no-split
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

USERS = [5001, 5002, 5003, 5004, 5005, 5006, 5007, 5008]
# per-user (mcs mean, rank2 prob, data mean); B degrades some users
PROFILE = {
    5001: (17, 0.5, 2600), 5002: (21, 0.6, 3400), 5003: (19, 0.55, 3000), 5004: (23, 0.7, 3800),
    5005: (12, 0.2, 1500), 5006: (15, 0.4, 2200), 5007: (16, 0.45, 2400), 5008: (11, 0.15, 1300),
}
B_SHIFT = {5003: (-2.0, -0.08, -500, 0.05), 5001: (-1.0, -0.03, -300, 0.01), 5004: (0.6, 0.02, 120, -0.005)}
CORE_537 = ["tti", "crnti", "HH:MM:SS", "frm", "slotNo", "ambr", "usrId", "schType", "suOrMuFlag", "jtMode",
            "cw0SuMcs", "tb0SchMcs", "schRank", "usrschpdschDrbData", "allocRbNum", "bandCqiCw0"]


def make_pair(rows: int, scheme: str, seed: int, wide: int, start_sec: int, wide714: int = 23):
    rng = np.random.default_rng(seed)
    per_tti = rng.integers(1, 5, size=rows)  # users scheduled per TTI
    n_tti = 0
    total = 0
    while total < rows:
        total += int(per_tti[n_tti % rows]); n_tti += 1
    tti_index = np.repeat(np.arange(n_tti), per_tti[:n_tti])[:rows]
    weights = np.array([0.17, 0.12, 0.21, 0.09, 0.08, 0.14, 0.11, 0.08])
    # 同一 TTI 内用户不重复（按权重无放回抽样：Gumbel top-k）
    keys = np.log(weights)[None, :] - np.log(-np.log(rng.random((n_tti, len(USERS)))))
    order = np.argsort(-keys, axis=1)
    pos_in_tti = np.arange(rows) - np.repeat(np.cumsum(per_tti[:n_tti]) - per_tti[:n_tti], per_tti[:n_tti])[:rows]
    user = np.array(USERS)[order[tti_index, pos_in_tti]]
    mcs_mu = np.array([PROFILE[u][0] for u in user], dtype=float)
    r2 = np.array([PROFILE[u][1] for u in user])
    data_mu = np.array([PROFILE[u][2] for u in user], dtype=float)
    bler = np.full(rows, 0.08)
    if scheme == "B":
        for u, (dm, dr, dd, db) in B_SHIFT.items():
            mask = user == u
            mcs_mu[mask] += dm; r2[mask] += dr; data_mu[mask] += dd; bler[mask] += db
    mcs = np.clip(np.round(mcs_mu + rng.normal(0, 3.2, rows)), 0, 28).astype(int)
    tti = 100000 + tti_index
    secs = start_sec + tti_index // 2000
    hh, mm, ss = (secs // 3600) % 24, (secs // 60) % 60, secs % 60
    time_str = np.char.add(np.char.add(np.char.zfill(hh.astype(str), 2), ":"),
                           np.char.add(np.char.add(np.char.zfill(mm.astype(str), 2), ":"), np.char.zfill(ss.astype(str), 2)))
    crnti = np.array([f"0x{17000 + (u - 5000) * 13:x}" if i % 7 == 0 else str(17000 + (u - 5000) * 13)
                      for i, u in enumerate(user)])
    small = rng.random(rows) < (0.03 + (bler - 0.08))  # truncated packets
    data = np.where(small, rng.integers(1, 500, rows), np.clip(rng.normal(data_mu, 900), 0, 9000)).astype(int)
    frame_537 = pd.DataFrame({
        "tti": tti, "crnti": crnti, "HH:MM:SS": time_str, "frm": (tti_index // 20) % 1024, "slotNo": tti_index % 20,
        "ambr": user, "usrId": user - 4900, "schType": np.where(rng.random(rows) < 0.93, "DL", "DL_RETX"),
        "suOrMuFlag": np.where(rng.random(rows) < 0.3, "MU", "SU"), "jtMode": rng.integers(0, 2, rows),
        "cw0SuMcs": mcs, "tb0SchMcs": np.clip(mcs + rng.integers(-1, 2, rows), 0, 28),
        "schRank": np.where(rng.random(rows) < r2, 2, 1), "usrschpdschDrbData": data,
        "allocRbNum": np.clip(rng.normal(60, 25, rows), 1, 273).astype(int),
        "bandCqiCw0": np.clip(np.round(mcs / 2 + rng.normal(0, 1, rows)), 0, 15).astype(int),
    })
    extra = max(0, wide - len(CORE_537))
    if extra:
        filler = pd.DataFrame(rng.integers(0, 4096, (rows, extra)), columns=[f"field_{i:03d}" for i in range(extra)])
        frame_537 = pd.concat([frame_537, filler], axis=1)
    # T714: ~96% of 537 rows have a link row (flow control gaps), a few duplicates
    keep = rng.random(rows) < 0.96
    link = frame_537.loc[keep, ["crnti", "HH:MM:SS", "frm", "slotNo"]].rename(columns={"slotNo": "slotNum"}).copy()
    n = len(link)
    link_bler = bler[keep]
    ack = np.where(rng.random(n) < link_bler, 0, 1)
    ack = np.where(rng.random(n) < 0.01, 2, ack)  # DTX
    link["ack0"] = ack
    link["retansNum0"] = rng.integers(0, 4, n)
    link["isMuFlag"] = (frame_537.loc[keep, "suOrMuFlag"].values == "MU").astype(int)
    link["mcsOffset[0]"] = (rng.normal(-1.0 if scheme == "A" else -1.6, 1.2, n) * 1024000).astype(int)
    link["compOlla"] = (rng.normal(-1.0 if scheme == "A" else -2.0, 1.4, n) * 1024000).astype(int)
    link["suRank"] = frame_537.loc[keep, "schRank"].values
    link["rankRpt"] = np.clip(link["suRank"] + rng.integers(-1, 2, n), 1, 4)
    extra714 = max(0, wide714 - 11)
    if extra714:
        filler = pd.DataFrame(rng.integers(0, 1000, (n, extra714)), columns=[f"lnk_{i:02d}" for i in range(extra714)], index=link.index)
        link = pd.concat([link, filler], axis=1)
    dup = link.sample(frac=0.002, random_state=seed)
    link = pd.concat([link, dup]).sort_index(kind="stable")
    # T396: per user throughput samples
    rows_396 = []
    for u in USERS:
        cnt = int((user == u).sum() // 40) + 5
        vol = np.clip(rng.normal(PROFILE[u][2] * 40, 9000, cnt), 100, None)
        if scheme == "B" and u in B_SHIFT:
            vol *= 1 + B_SHIFT[u][0] / 20
        rows_396.append(pd.DataFrame({"dlAmbr": u, "dlThpVolRmvLastSlot": vol.astype(int),
                                      "dlThpTimeRmvLastSlot": rng.integers(8, 14, cnt) * (1 + (user == u).mean() * 10)}))
    frame_396 = pd.concat(rows_396).sample(frac=1, random_state=seed)
    frame_396["cellId"] = 3
    return frame_396, frame_537, link


def write_batch(root: Path, case: str, cell: str, stamp: str, scheme: str, rows: int, wide: int, seed: int, split: bool, wide714: int = 23):
    out = root / case / cell / "ParseResult"
    out.mkdir(parents=True, exist_ok=True)
    start_sec = int(stamp[8:10]) * 3600 + int(stamp[10:12]) * 60 + int(stamp[12:14])
    f396, f537, f714 = make_pair(rows, scheme, seed, wide, start_sec, wide714)
    base = f"{case}_{cell}"
    f396.to_csv(out / f"Dest_T396_{base}_trace_0_{stamp}.csv", index=False)
    if split:
        half = len(f537) // 2
        f537.iloc[:half].to_csv(out / f"Dest_T537_{base}_trace_0_{stamp}.csv", index=False)
        f537.iloc[half:].to_csv(out / f"Dest_T537_{base}_trace_1_{stamp}.csv", index=False)
    else:
        f537.to_csv(out / f"Dest_T537_{base}_trace_0_{stamp}.csv", index=False)
    f714.to_csv(out / f"Dest_T714_{base}_trace_0_{stamp}.csv", index=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("root")
    ap.add_argument("--rows", type=int, default=60000)
    ap.add_argument("--wide", type=int, default=40)
    ap.add_argument("--cells", default="Cell_1,Cell_3,Cell_7")
    ap.add_argument("--wide714", type=int, default=23)
    ap.add_argument("--no-split", action="store_true")
    args = ap.parse_args()
    root = Path(args.root)
    cells = args.cells.split(",")
    for i, cell in enumerate(cells):
        write_batch(root / "方案A", "基线_v3", cell, f"2026100709{30 + i:02d}00", "A", args.rows, args.wide, 11 + i, split=(i == 0 and not args.no_split), wide714=args.wide714)
        write_batch(root / "方案B", "新调度_v4", cell, f"2026100710{30 + i:02d}00", "B", args.rows, args.wide, 101 + i, split=False, wide714=args.wide714)
    print("written to", root)


if __name__ == "__main__":
    main()
