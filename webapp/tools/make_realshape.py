"""把 gen_scenario_data.py 的场景数据改写成“真实文件的样子”，测解析健壮性。

真实 cellDT 与样例的格式差异（来自公司真实文件的列画像，只含统计量）：
逗号分隔 + UTF-8 BOM；537 表头末尾多一个空名列；714 表头有重名列（doubleDciFlg 出现两次）；
大量常量列；十六进制字段（schErrCode 0x0 / 0x110261 等）；714 的 AI 字段用 '-' 表示无值；
schType 重传写作 DLSCH_TYPE_HARQ_DRB；mcsTable=1（256QAM 表）。

用法: python make_realshape.py <场景根目录> <真实列画像.json> <输出根目录> [--drop 0.3]
--drop：按比例随机丢弃 537/714 行，模拟跟踪丢包（真实跟踪常见大比例丢包）
列画像 JSON 由家里从公司回执解析得到（只在本机，不入库）：{"537": {"cols": [...], "consts": {...}}, "714": ..., "396": ...}
"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd



def expand_consts(consts: dict) -> dict:
    out = {}
    for k, v in consts.items():
        if '～' in k or '~' in k:  # filterDeltaSinr[4]～[7]=0
            base = k.split('[')[0]
            lo = int(k.split('[')[1].split(']')[0]); hi = int(k.rsplit('[', 1)[1].split(']')[0])
            for i in range(lo, hi + 1):
                out[f'{base}[{i}]'] = v
        else:
            out[k] = v
    return out


def shape(df: pd.DataFrame, prof: dict, trace: str, rng) -> tuple[list[str], pd.DataFrame]:
    consts = expand_consts(prof['consts'])
    cols = list(dict.fromkeys(prof['cols'] + [c for c in consts if c not in prof['cols']]))
    out = pd.DataFrame(index=df.index)
    for c in cols:
        if c in df.columns:
            out[c] = df[c]
        elif c in consts:
            out[c] = consts[c]
        else:
            out[c] = 0
    if trace == '537':
        ok = out['schErrCode'].astype(str) == '0x0'
        # 少量真实形态的失败码
        bad = ~ok
        out.loc[bad, 'schErrCode'] = rng.choice(['0x110261', '0x110135', '0x110291'], size=int(bad.sum()))
        out['schType'] = np.where(df['tb0ReTransTimes'] > 0, 'DLSCH_TYPE_HARQ_DRB', 'DLSCH_TYPE_DRB')
        out['mcsTable'] = 1
        out['rbgBitmap'] = '0xffffc000'
        out['actualRePerRb'] = 128
        out['ambr'] = 1998000000 + (df['ambr'] - 5000)
        # 两段 tti：前 2% 行用另一套小计数（真实文件里同时出现约 2.6 万与 3100 万量级）
        n = len(out); k = max(1, n // 50)
        out.loc[out.index[:k], 'tti'] = 25754 + np.arange(k) // 4
        header = cols + ['']  # 末尾空名列
        out[''] = ''
    elif trace == '714':
        for c in ['aiBaseMsgMcsBfCw0', 'aiMsgMcsBfCw0', 'aiMsgSinrFromAi', 'rsvAi[0]']:
            if c in out.columns:
                out[c] = np.where(rng.random(len(out)) < 0.49, '-', '0')
        header = cols[:]
        if 'doubleDciFlg' in header:
            i = header.index('doubleDciFlg')
            header.insert(i + 1, 'doubleDciFlg')
            out.insert(i + 1, 'doubleDciFlg__dup', out['doubleDciFlg'])
    else:
        header = cols + ['']
        out[''] = ''
    return header, out


def main():
    src, prof_path, dst = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    drop = float(sys.argv[sys.argv.index('--drop') + 1]) if '--drop' in sys.argv else 0.0
    prof = json.loads(prof_path.read_text(encoding='utf-8'))
    rng = np.random.default_rng(3)
    for f in src.rglob('Dest_T*.csv'):
        trace = f.name.split('_')[1][1:]
        df = pd.read_csv(f, sep='\t')
        if drop and trace in ('537', '714'):
            df = df[rng.random(len(df)) >= drop].reset_index(drop=True)
        header, out = shape(df, prof[trace], trace, rng)
        rel = f.relative_to(src)
        stamp = f.stem.rsplit('_', 1)[1]
        sub = f'{stamp[:4]}-{stamp[4:6]}-{stamp[6:8]}-{stamp[8:10]}_{stamp[10:12]}_{stamp[12:14]}'
        name = {'537': 'Dest_T537_TTI_TRACE_DLSCH_SIMP_TRACE', '714': 'Dest_T714_TTI_TRACE_SUSRPDSCH_MCS_ADJ_INFO', '396': 'Dest_T396_TTI_TRACE_DP_DL_THP'}[trace]
        target = dst / rel.parent / sub / f'{name}_0_{stamp}.csv'  # 真实结构：ParseResult/<时间>/Dest_...
        target.parent.mkdir(parents=True, exist_ok=True)
        with open(target, 'w', encoding='utf-8-sig', newline='') as fh:
            w = csv.writer(fh)
            w.writerow(header)
            w.writerows(out.itertuples(index=False, name=None))
        print(target.name, len(header), 'cols', len(out), 'rows')


if __name__ == '__main__':
    main()
