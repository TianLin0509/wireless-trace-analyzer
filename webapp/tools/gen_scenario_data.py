"""按通信因果逐时隙生成 T396 / T537 / T714 场景数据，并注入已知故障（附标准答案 JSON）。

和 gen_sample_data.py（随机造数、测引擎口径）不同，这里的字段彼此一致：
SINR → CQI 上报 → MCS 调整链（CQI 估计 → OLLA → 回退 → 速率匹配 → MU 降阶 → 最终）
→ TB 大小 → ACK/NACK/DTX → HARQ 重传 → OLLA 更新 → T396 速率。用来验收诊断功能能否找出注入的故障。

字段含义按本机理解与公司回执（Q-1111-29/30）校准；单位不确定的字段在 FIELD_NOTES 里写明。

用法:
    python gen_scenario_data.py <root> [--slots 40000] [--seed 7]
产物: <root>/场景A/基线/Cell_1/ParseResult/...  <root>/场景B/新版本/Cell_1/ParseResult/...  <root>/20261111-scenario-truth.json
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

# 38.214 表 5.1.3.1-1（64QAM）每 RE 频谱效率，MCS 0..28
SE = [0.2344, 0.3066, 0.3770, 0.4902, 0.6016, 0.7402, 0.8770, 1.0273, 1.1758, 1.3262, 1.3281, 1.4766, 1.6953,
      1.9141, 2.1602, 2.4063, 2.5703, 2.5664, 2.7305, 3.0293, 3.3223, 3.6094, 3.9023, 4.2129, 4.5234, 4.8164,
      5.1152, 5.3320, 5.5547]
SE = np.array(SE)
# 每个 MCS 达到 10% BLER 所需 SINR（dB）：香农加 2 dB 实现损失
REQ = 10 * np.log10(2 ** SE - 1) + 2.0
RE_PER_RB = 132  # 12 子载波 × 11 个可用符号
SLOTS_PER_SEC = 2000  # 30 kHz SCS
RB_TOTAL = 273
MAX_USERS_PER_SLOT = 4
SCALE = 1024000  # 714 的 OLLA / mcsOffset 定点倍数（与分析台 SCALE_714 一致）

ERR_OK, ERR_CCE = '0x0', '0x2'

FIELD_NOTES = {
    'usrschpdschDrbData': '本次 PDSCH 承载的 DRB 数据量（字节）；0 < x < 500 视为截包/小包',
    'waitingData': '调度前用户缓存待发数据量（字节）',
    'tb0TbByteLength': '码字 0 的 TB 大小（字节）',
    'esitimatedRb': '按待发数据估算需要的 RB 数',
    'schErrCode': '0x0 成功；0x2 本场景代表 PDCCH CCE 分配失败（真实码表以公司回执为准）',
    'ack0': '714 ack0：该 TB 的反馈结果 1 ACK / 0 NACK / 2 DTX（714 每行是一次反馈事件）；537 tb0AckState：触发本次调度的上一次反馈',
    'mcsOffset[0]': '714：OLLA 外环累计量（MCS 阶）× 1024000（公司样例注释，Q-1111-30）',
    'compOlla': '714：补偿 OLLA（语义未确认），本场景恒为 0',
    'iblerTarget': '714：初传 BLER 目标 × 102400（10% → 10240，公司样例注释）',
}


def user_profiles(scheme: str):
    """每个用户：几何 SINR 均值、快衰落标准差、业务模型、CQI 偏差、MU 概率。B 侧叠加故障。"""
    base = {
        5001: dict(sinr=18, sd=2.5, traffic='full', cqi_bias=0.0, mu=0.25),
        5002: dict(sinr=22, sd=2.0, traffic='full', cqi_bias=0.0, mu=0.30),
        5003: dict(sinr=15, sd=2.5, traffic='full', cqi_bias=0.0, mu=0.20),
        5004: dict(sinr=25, sd=1.5, traffic='full', cqi_bias=0.0, mu=0.35),
        5005: dict(sinr=10, sd=3.0, traffic='full', cqi_bias=3.0, mu=0.05),   # CQI 虚高
        5006: dict(sinr=14, sd=2.5, traffic='bursty', cqi_bias=0.0, mu=0.10, dtx=0.06),  # PDCCH 漏检
        5007: dict(sinr=12, sd=4.5, traffic='full', cqi_bias=0.0, mu=0.10),   # 快速移动、信道波动大
        5008: dict(sinr=16, sd=2.0, traffic='small', cqi_bias=0.0, mu=0.0),   # 小包业务
    }
    if scheme == 'B':
        base[5003]['burst'] = (0.35, 0.60, 8.0)   # 35%~60% 时段 SINR 掉 8 dB（干扰突发）
        base[5001]['mu'] = 0.65                   # MU 配对激进
        base[5004]['sinr'] += 0.5
    return base


def run(scheme: str, slots: int, seed: int, cce_fail: float):
    rng = np.random.default_rng(seed)
    prof = user_profiles(scheme)
    users = list(prof)
    n_u = len(users)
    olla = np.zeros(n_u)               # MCS 阶（本场景近似 1 阶 ≈ 1 dB）
    avg_thr = np.full(n_u, 1e5)        # PF 平均吞吐
    buf = np.zeros(n_u)                # 待发字节
    cqi_sinr = np.array([prof[u]['sinr'] for u in users], dtype=float)
    pending = {}                       # (user, harq) -> dict(retx, mcs, rb, layers, tbs, due)
    next_harq = np.zeros(n_u, dtype=int)
    rows537, rows714 = [], []
    delivered = np.zeros(n_u)          # 统计周期内交付比特
    active = np.zeros(n_u)             # 统计周期内有数据的时隙数（掐头去尾近似为有数据的时隙）
    rows396 = []
    period = SLOTS_PER_SEC // 2        # 每 0.5 秒出一条 T396
    for t in range(slots):
        frac = t / slots
        # 业务到达
        for i, u in enumerate(users):
            p = prof[u]
            if p['traffic'] == 'full':
                buf[i] = 5e6
            elif p['traffic'] == 'bursty':
                if rng.random() < 0.004:
                    buf[i] += rng.integers(200_000, 1_500_000)
            else:  # 小包：每 20 ms 一个 300 字节包
                if t % 40 == i:
                    buf[i] += 300
        # 当前 SINR
        sinr = np.array([prof[u]['sinr'] + rng.normal(0, prof[u]['sd']) for u in users])
        for i, u in enumerate(users):
            b = prof[u].get('burst')
            if b and b[0] <= frac < b[1]:
                sinr[i] -= b[2]
        # CQI 每 20 个时隙上报一次
        if t % 20 == 0:
            cqi_sinr = sinr + np.array([prof[u]['cqi_bias'] for u in users]) + rng.normal(0, 1.0, n_u)
        tti = 85_000_000 + t
        frm, slot = (t // 20) % 1024, t % 20
        sec = 23 * 3600 + t // SLOTS_PER_SEC
        hhmmss = f'{(sec // 3600) % 24:02d}:{(sec // 60) % 60:02d}:{sec % 60:02d}'
        # 本时隙到期的重传优先
        due = [(k, h) for k, h in pending.items() if h['due'] == t]
        cand = [i for i in range(n_u) if buf[i] > 0]
        retx_users = {k[0] for k, _ in due}
        metric = {i: (SE[np.clip(np.searchsorted(REQ, cqi_sinr[i] + olla[i]) - 1, 0, 28)] / avg_thr[i]) for i in cand if i not in retx_users}
        new_users = sorted(metric, key=lambda i: -metric[i])[: max(0, MAX_USERS_PER_SLOT - len(retx_users))]
        sched = [('retx', k, h) for k, h in due] + [('new', i, None) for i in new_users]
        n_sched = len(sched)
        # CCE 分配失败：B 侧更多用户时更容易失败
        fails = set()
        for j, s in enumerate(sched):
            if rng.random() < cce_fail * (1 + 0.5 * (n_sched - 2)):
                fails.add(j)
        succ = n_sched - len(fails)
        rb_left = RB_TOTAL
        share = RB_TOTAL // max(1, succ)
        pair_mu = rng.random() < 0.3 and succ >= 2
        for j, s in enumerate(sched):
            kind = s[0]
            i = s[1][0] if kind == 'retx' else s[1]
            u = users[i]
            p = prof[u]
            est_mcs = int(np.clip(np.searchsorted(REQ, cqi_sinr[i]) - 1, 0, 28))
            init_adj = int(np.clip(np.searchsorted(REQ, cqi_sinr[i] + olla[i]) - 1, 0, 28))
            power_back = init_adj - (1 if rng.random() < 0.03 else 0)
            rate_mtc = power_back - (1 if slot in (0, 10) else 0)  # CSI-RS 时隙速率匹配
            is_mu = pair_mu and rng.random() < p['mu']
            reduce = rate_mtc - (2 if is_mu else 0)
            final = int(np.clip(reduce, 0, 28))
            layers = 2 if cqi_sinr[i] > 16 and not is_mu else 1
            if kind == 'retx':
                h = s[2]
                final, layers, rb, tbs, retx = h['mcs'], h['layers'], h['rb'], h['tbs'], h['retx'] + 1
                need_rb = rb
                harq = s[1][1]
                data = 0
            else:
                bits_per_rb = RE_PER_RB * SE[final] * layers
                need_rb = min(RB_TOTAL, int(math.ceil(buf[i] * 8 / bits_per_rb))) if buf[i] > 0 else 0  # 真实 esitimatedRb 封顶 273
                rb = min(need_rb, share, rb_left)
                tbs = int(rb * bits_per_rb / 8)
                data = int(min(buf[i], tbs))
                retx = 0
                harq = int(next_harq[i]); next_harq[i] = (next_harq[i] + 1) % 16
            err = ERR_CCE if j in fails else ERR_OK
            if err != ERR_OK:
                rb, tbs, data = 0, 0, 0
            else:
                rb_left -= rb if kind == 'new' else 0
            rows537.append(dict(
                tti=tti, crnti=17000 + (u - 5000) * 13, **{'HH:MM:SS': hhmmss}, frm=frm, slotNo=slot, ambr=u, usrId=u - 4900,
                schErrCode=err, userNum=n_sched, schSuccUserNum=succ, pairNum=2 if is_mu else 0,
                ttiTotalRbNum=RB_TOTAL, esitimatedRb=need_rb, allocRbNum=rb, suOrMuFlag='MU' if is_mu else 'SU',
                schType='DLSCH_TYPE_DRB' if kind == 'new' else 'DLSCH_TYPE_RETRAN', cw0SuMcs=int(np.clip(rate_mtc, 0, 28)), tb0SchMcs=final,
                bandCqiCw0=int(np.clip(round((cqi_sinr[i] + 6) / 2), 0, 15)), schRank=layers - 1, suRank=layers - 1,  # 真实 537 从 0 起编
                waitingData=int(buf[i]), usrschpdschDrbData=data, tb0TbByteLength=tbs, harqProcNo=harq, tb0ReTransTimes=retx,
                estMcs0=est_mcs, cw0Mcs=final, initAdjMcs0=init_adj, powerBackMcs0=int(np.clip(power_back, 0, 28)),
                rateMtcMcs0=int(np.clip(rate_mtc, 0, 28)), reduceMcs0=final, k1min=3, mcsTable=0, tb0AckState=None,
            ))
            if err != ERR_OK:
                continue
            # 译码结果：重传合并增益每次 +3 dB
            gain = 3.0 * retx
            p_err = 1 / (1 + math.exp(1.6 * (sinr[i] + gain - REQ[final] + 0.5)))
            dtx = rng.random() < p.get('dtx', 0.002) * (6 if p.get('dtx') and 0.2 < frac < 0.3 else 1)
            ack = 2 if dtx else (0 if rng.random() < p_err else 1)
            # 714 在反馈时刻（k1 个时隙后）记录；这里按“调度时刻”的 frm/slot 写，便于与现有精确连接口径一致
            olla_before = olla[i]
            # 真实语义（公司实测 Q-1111-32）：537 tb0AckState / 714 ack0 记的是“触发本次调度的上一次反馈”，
            # 初传行为 1，重传行为 0（NACK）或 2（DTX），不是本次传输的译码结果
            cause = 1 if kind == 'new' else s[2]['fb']
            rows537[-1]['tb0AckState'] = cause
            if retx == 0 and ack in (0, 1):
                olla[i] += 0.0556 if ack == 1 else -0.5
                olla[i] = float(np.clip(olla[i], -12, 6))
            # 714 = 反馈事件：在反馈时刻（k1 = 3 个时隙后）记一行，ack0 = 这个 TB 的结果，retansNum0 = 它是第几次重传
            tf = t + 3
            secf = 23 * 3600 + tf // SLOTS_PER_SEC
            rows714.append({
                'crnti': 17000 + (u - 5000) * 13, 'HH:MM:SS': f'{(secf // 3600) % 24:02d}:{(secf // 60) % 60:02d}:{secf % 60:02d}',
                'frm': (tf // 20) % 1024, 'slotNum': tf % 20, 'rptTti': tti + 3, 'ueid': u - 4000,
                'harqNo': harq, 'ack0': ack, 'ack1': 0, 'retansNum0': retx, 'trcItem': 0,
                'isMuFlag': int(is_mu), 'mcsOffset[0]': int(round(olla_before * SCALE)), 'compOlla': 0,
                'iblerTarget': 10240, 'currAdjStep': 56936 if ack == 1 else -512000, 'suRank': layers, 'rankRpt': layers,
                'wbCqi4Bit0Type1': int(np.clip(round((cqi_sinr[i] + 6) / 2), 0, 15)), 'mcsBfCwFlter0': est_mcs, 'mcsCwRankFlter0': init_adj,
                'cqiValidFlag': 1, 'trantype': 0 if retx == 0 else 1,
            })
            if ack == 1:
                if kind == 'new':
                    buf[i] = max(0, buf[i] - data)
                    delivered[i] += data * 8
                else:
                    delivered[i] += s[2]['data'] * 8
                    buf[i] = max(0, buf[i])
                pending.pop((i, harq), None)
            else:
                if retx < 3:
                    pending[(i, harq)] = dict(retx=retx, mcs=final, rb=rb, layers=layers, tbs=tbs, due=t + 8, data=data if kind == 'new' else s[2]['data'], fb=ack)
                    if kind == 'new':
                        buf[i] = max(0, buf[i] - data)
                else:
                    pending.pop((i, harq), None)
            inst = tbs * 8 * SLOTS_PER_SEC
            avg_thr[i] = 0.98 * avg_thr[i] + 0.02 * inst
        for i in range(n_u):
            avg_thr[i] *= 0.999 if i not in [s[1] for s in sched if s[0] == 'new'] else 1
            if buf[i] > 0:
                active[i] += 1
        if (t + 1) % period == 0:
            for i, u in enumerate(users):
                if active[i] > 2:
                    # 掐头去尾近似：去掉最后一个时隙；真实单位 vol = 字节、time = 微秒（0.5 ms / 时隙 = 500 μs），Rate×8 = Mbps
                    rows396.append(dict(tti=tti, dlAmbr=u, susrId=u - 4900, dlThpVolRmvLastSlot=int(delivered[i] / 8), dlThpTimeRmvLastSlot=int((active[i] - 1) * 500)))
            delivered[:] = 0; active[:] = 0
    return pd.DataFrame(rows396), pd.DataFrame(rows537), pd.DataFrame(rows714)


TRUTH = {
    'A': {
        'cell': '单小区场景（基线）',
        'faults': [
            {'user': '5005', 'type': 'cqi_overreport', 'label': 'CQI 虚高：CQI 比实际信道高约 3 dB → OLLA 持续为负，初传 BLER 高于目标'},
            {'user': '5006', 'type': 'pdcch_dtx', 'label': 'PDCCH 漏检：DTX 比例高，20%~30% 时段成串 DTX'},
            {'user': '5007', 'type': 'fast_fading', 'label': '信道波动大（快速移动）：MCS 抖动、BLER 偏高'},
            {'user': '5008', 'type': 'small_packet', 'label': '小包业务：数据受限，截包比例高，速率低但不是空口问题'},
        ],
    },
    'B': {
        'cell': 'A/B 对比：B 为“新版本”',
        'faults': [
            {'user': '5003', 'type': 'interference_burst', 'label': '干扰突发：35%~60% 时段 SINR 掉 8 dB → 成串 NACK、OLLA 下探、MCS 骤降'},
            {'user': '5001', 'type': 'mu_aggressive', 'label': 'MU 配对激进：MU 比例 65%，MU 降阶使 MCS 下降、层数下降'},
            {'user': '*', 'type': 'cce_fail', 'label': '小区 CCE 分配失败率升高：调度失败行增多，调度机会下降'},
        ],
    },
}


def write(root: Path, scheme: str, case: str, stamp: str, slots: int, seed: int, cce_fail: float):
    out = root / f'场景{scheme}' / case / 'Cell_1' / 'ParseResult'
    out.mkdir(parents=True, exist_ok=True)
    f396, f537, f714 = run(scheme, slots, seed, cce_fail)
    base = f'{case}_Cell_1'
    f396.to_csv(out / f'Dest_T396_{base}_trace_0_{stamp}.csv', index=False, sep='\t')
    f537.to_csv(out / f'Dest_T537_{base}_trace_0_{stamp}.csv', index=False, sep='\t')
    f714.to_csv(out / f'Dest_T714_{base}_trace_0_{stamp}.csv', index=False, sep='\t')
    return len(f537), len(f714), len(f396)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('root')
    ap.add_argument('--slots', type=int, default=40000)
    ap.add_argument('--seed', type=int, default=7)
    a = ap.parse_args()
    root = Path(a.root)
    stats = {
        'A': write(root, 'A', '基线', '20261111090000', a.slots, a.seed, 0.01),
        'B': write(root, 'B', '新版本', '20261111100000', a.slots, a.seed + 1, 0.05),
    }
    (root / '20261111-scenario-truth.json').write_text(json.dumps({'truth': TRUTH, 'rows': stats, 'field_notes': FIELD_NOTES}, ensure_ascii=False, indent=2), encoding='utf-8')
    print('written', root, stats)


if __name__ == '__main__':
    main()
