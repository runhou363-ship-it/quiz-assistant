# -*- coding: utf-8 -*-
"""用真实雨课堂加密字体调匹配算法：对比不同特征/尺寸/多字体投票的准确率。

运行：py -3 tests/font_tune.py
数据：server/debug/exam_font.ttf + 人工标注的 20 个混淆字。
"""
import os
import sys
import json

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "server"))

import numpy as np
from PIL import Image, ImageDraw, ImageFont

FONT = os.path.join(ROOT, "server", "debug", "exam_font.ttf")

# 人工标注：混淆字 -> 真字（来自真实页面的题干与四个选项）
TRUTH = {
    "提": "以", "述": "下", "现": "哪", "山": "项", "价": "不",
    "个": "是", "研": "自", "块": "然", "感": "证", "队": "法",
    "纪": "的", "约": "特", "船": "点", "力": "综", "款": "合",
    "请": "性", "属": "交", "检": "复", "术": "杂", "象": "理",
}

REFS = [
    ("simsun", r"C:\Windows\Fonts\simsun.ttc", 0),
    ("msyh", r"C:\Windows\Fonts\msyh.ttc", 0),
    ("simhei", r"C:\Windows\Fonts\simhei.ttf", None),
    ("simkai", r"C:\Windows\Fonts\simkai.ttf", None),
]


def common_chars():
    chars = []
    for hi in range(0xB0, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                chars.append(bytes([hi, lo]).decode("gb2312"))
            except Exception:
                pass
    return chars


def render(font, ch, size):
    canvas = size * 2
    img = Image.new("L", (canvas, canvas), 0)
    ImageDraw.Draw(img).text((size // 2, size // 3), ch, fill=255, font=font)
    return np.asarray(img, dtype=np.uint8)


def feats(font, ch, size, n):
    """返回 (灰度向量, 二值掩码)。裁剪到墨迹包围盒后归一化，避免字号/位置影响。"""
    a = render(font, ch, size)
    ys, xs = np.nonzero(a > 25)
    if len(ys) == 0:
        return None, None
    sub = a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    img = Image.fromarray(sub).resize((n, n), Image.BILINEAR)
    v = np.asarray(img, dtype=np.float32).ravel()
    mean = v.mean()
    v0 = v - mean
    nv = float(np.linalg.norm(v0))
    g = v0 / nv if nv > 0 else None
    # 二值掩码：先模糊再阈值，容忍 1px 抖动
    blur = np.asarray(Image.fromarray(sub).resize((n * 2, n * 2), Image.BILINEAR).resize((n, n), Image.BILINEAR), dtype=np.float32)
    b = (blur > 96).astype(np.float32).ravel()
    return g, b


def build_ref(path, index, size, n, pool):
    font = ImageFont.truetype(path, size, index=index) if index is not None else ImageFont.truetype(path, size)
    G, B, chars = [], [], []
    for ch in pool:
        g, b = feats(font, ch, size, n)
        if g is None:
            continue
        G.append(g)
        B.append(b)
        chars.append(ch)
    return np.vstack(G), np.vstack(B), chars


def evaluate(size, n, lam, vote, label):
    pool = common_chars()
    enc_font = ImageFont.truetype(FONT, size)
    chars = list(TRUTH)
    QG, QB = [], []
    for ch in chars:
        g, b = feats(enc_font, ch, size, n)
        QG.append(g)
        QB.append(b)
    QG, QB = np.vstack(QG), np.vstack(QB)

    per_font = {}   # name -> (best_char[], best_score[])
    for name, path, index in REFS:
        if not os.path.exists(path):
            continue
        RG, RB, rchars = build_ref(path, index, size, n, pool)
        cos = QG @ RG.T                     # 灰度余弦
        inter = QB @ RB.T
        s_a = QB.sum(axis=1)[:, None] + RB.sum(axis=1)[None, :]
        iou = inter / np.maximum(s_a - inter, 1e-6)
        score = cos + lam * iou
        idx = score.argmax(axis=1)
        per_font[name] = ([rchars[i] for i in idx], score.max(axis=1), score)

    # 单字体：取「哪一票最可信」= 取各字体里最高分的那个结果（旧逻辑）
    names = list(per_font)
    pred_max = []
    for i in range(len(chars)):
        cand = [(per_font[n][1][i], per_font[n][0][i]) for n in names]
        pred_max.append(max(cand)[1])

    # 多字体投票：每个字体投自己 top1，票多者胜，平票用总分
    pred_vote = []
    for i in range(len(chars)):
        tally = {}
        for n in names:
            c = per_font[n][0][i]
            sc = float(per_font[n][2][i].max())
            tally.setdefault(c, [0, 0.0])
            tally[c][0] += 1
            tally[c][1] += sc
        pred_vote.append(max(tally.items(), key=lambda kv: (kv[1][0], kv[1][1]))[0])

    pred = pred_vote if vote else pred_max
    ok = sum(1 for c, p in zip(chars, pred) if p == TRUTH[c])
    bad = [(c, TRUTH[c], p) for c, p in zip(chars, pred) if p != TRUTH[c]]
    print(f"{label:34s} 正确 {ok}/{len(chars)}   平均分 {np.mean([per_font[n][1][i] for i in range(len(chars)) for n in names]):.3f}" + ("" if not bad else f"   错: {bad}"))
    return ok


def main():
    print("字体:", os.path.exists(FONT), os.path.getsize(FONT) // 1024, "KB")
    print("标注字数:", len(TRUTH), "\n")
    best = (0, None)
    for size, n in [(64, 40), (80, 48), (96, 56)]:
        for lam in [0.0, 0.5, 1.0]:
            for vote in [False, True]:
                label = f"size={size} n={n} iou_w={lam} 投票={'开' if vote else '关'}"
                ok = evaluate(size, n, lam, vote, label)
                if ok > best[0]:
                    best = (ok, label)
    print("\n最佳配置:", best[1], f"({best[0]}/{len(TRUTH)})")


if __name__ == "__main__":
    main()
