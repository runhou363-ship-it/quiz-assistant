# -*- coding: utf-8 -*-
"""字体解码离线测试：用宋体造一个"加密字体"，验证能否还原原文。

运行： py -3 tests/decode.test.py
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "server"))
sys.path.insert(0, HERE)

import fontdec  # noqa: E402
from decode_fake import make_fake_encrypted  # noqa: E402


def main():
    if not fontdec.available_refs():
        print("跳过：本机没有可用的参考字体")
        return 0

    src = "综合交叉复杂性哲理性自然辩证法特点"
    data, mapping = make_fake_encrypted(src)

    obf = "".join(chr(next(k for k, v in mapping.items() if v == ord(c))) for c in src)
    print("原文:", src)
    print("混淆:", repr(obf))

    out, m, info = fontdec.decode_texts(data, [obf])
    print("解码:", out[0])
    print("信息:", info)

    ok = out[0] == src
    print("PASS 全字还原" if ok else "FAIL 未完全还原")
    if not ok:
        for a, b in zip(src, out[0]):
            if a != b:
                print("  差异:", a, "->", b)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
