# -*- coding: utf-8 -*-
"""校准：在最终配置（size=96, n=56, cos+IoU）下看分数分布，定 MIN_SCORE。"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "server"))
sys.path.insert(0, HERE)

import numpy as np
from font_tune import TRUTH, REFS, common_chars, feats, FONT
from PIL import ImageFont

SIZE, N = 96, 56


def main():
    pool = common_chars()
    enc_font = ImageFont.truetype(FONT, SIZE)
    chars = list(TRUTH)
    QG, QB = [], []
    for ch in chars:
        g, b = feats(enc_font, ch, SIZE, N)
        QG.append(g)
        QB.append(b)
    QG, QB = np.vstack(QG), np.vstack(QB)

    for name, path, index in REFS:
        if not os.path.exists(path):
            continue
        t0 = time.time()
        font = ImageFont.truetype(path, SIZE, index=index) if index is not None else ImageFont.truetype(path, SIZE)
        G, B, rchars = [], [], []
        for ch in pool:
            g, b = feats(font, ch, SIZE, N)
            if g is None:
                continue
            G.append(g)
            B.append(b)
            rchars.append(ch)
        RG, RB = np.vstack(G), np.vstack(B)
        t_build = time.time() - t0

        t1 = time.time()
        cos = QG @ RG.T
        inter = QB @ RB.T
        s_a = QB.sum(axis=1)[:, None] + RB.sum(axis=1)[None, :]
        iou = inter / np.maximum(s_a - inter, 1e-6)
        score = cos + iou
        t_query = time.time() - t1

        idx = score.argmax(axis=1)
        top = score.max(axis=1)
        srt = np.sort(score, axis=1)
        gap = srt[:, -1] - srt[:, -2]
        ok = [rchars[i] == TRUTH[c] for c, i in zip(chars, idx)]
        print(f"\n[{name}] 建矩阵 {t_build:.1f}s / 查询 {t_query*1000:.0f}ms / 正确 {sum(ok)}/{len(ok)}")
        print(f"  命中分: min {top.min():.3f} 均值 {top.mean():.3f} max {top.max():.3f}")
        print(f"  与次优差: min {gap.min():.3f} 均值 {gap.mean():.3f}")
        wrong = [(c, TRUTH[c], rchars[i], round(float(top[k]), 3)) for k, (c, i) in enumerate(zip(chars, idx)) if rchars[i] != TRUTH[c]]
        if wrong:
            print("  错:", wrong)


if __name__ == "__main__":
    main()
