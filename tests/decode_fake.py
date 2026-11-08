# -*- coding: utf-8 -*-
"""造一个"加密字体"用于测试：从宋体抽字形，把码位换成 PUA 值。"""
import io


def make_fake_encrypted(chars, ref="C:/Windows/Fonts/simsun.ttc"):
    """返回 (字体字节, {新码位: 原码位})。"""
    from fontTools.ttLib import TTFont
    from fontTools.subset import Subsetter, Options
    from fontTools.ttLib.tables._c_m_a_p import CmapSubtable

    font = TTFont(ref, fontNumber=0)
    opts = Options()
    opts.name_IDs = ["*"]
    sub = Subsetter(options=opts)
    sub.populate(text="".join(chars))
    sub.subset(font)

    base = font.getBestCmap()
    old_cps = sorted(cp for cp in base if chr(cp) in chars)
    if not old_cps:
        raise RuntimeError("参考字体里没找到这些字")

    new_cmap = {}
    mapping = {}
    for i, cp in enumerate(old_cps):
        new_cp = 0xE000 + i
        new_cmap[new_cp] = base[cp]
        mapping[new_cp] = cp

    tbl = CmapSubtable.newSubtable(4)
    tbl.platformID, tbl.platEncID, tbl.language = 3, 1, 0
    tbl.cmap = new_cmap
    font["cmap"].tables = [tbl]

    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue(), mapping
