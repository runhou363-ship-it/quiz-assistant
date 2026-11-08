# -*- coding: utf-8 -*-
"""验证 /debug 的「诊断即解码」：带加密字体提交诊断，后端应自动存字体并解出真字。"""
import os
import sys
import json
import glob
import base64

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "server"))
sys.path.insert(0, HERE)

import app  # noqa: E402
from decode_fake import make_fake_encrypted  # noqa: E402

PLAIN = "以下哪项不是自然辩证法的特点（ ）"
OPTS = ["综合性", "交叉性", "复杂性", "哲理性"]


def main():
    chars = "".join(sorted(set("".join(OPTS) + PLAIN)))
    chars = "".join(c for c in chars if "\u4e00" <= c <= "\u9fff")
    font_bytes, mapping = make_fake_encrypted(chars)

    # 明文 -> 密文（PUA 码位）
    enc = {}
    for new_cp, old_cp in mapping.items():
        enc[chr(old_cp)] = chr(new_cp)

    def enc_text(s):
        return "".join(enc.get(c, c) for c in s)

    payload = {
        "url": "https://example.test/exercise",
        "title": "test",
        "meta": {"roots": 1, "frames": 0},
        "extract": {"question": enc_text(PLAIN), "options": [enc_text(o) for o in OPTS]},
        "encrypted": [{"tag": "SPAN", "cls": "xuetangx-com-encrypted-font", "text": enc_text(OPTS[0])}],
        "font_b64": base64.b64encode(font_bytes).decode(),
        "buttons": [],
        "letterHits": [],
        "numberNav": [],
        "typeLabels": [],
    }

    before = set(glob.glob(os.path.join(app.DEBUG_DIR, "debug-*")))
    client = app.app.test_client()
    resp = client.post("/debug", json=payload)
    data = resp.get_json() or {}
    ok = bool(data.get("ok")) and bool(data.get("selfDecode"))

    created = sorted(set(glob.glob(os.path.join(app.DEBUG_DIR, "debug-*"))) - before)
    dump = None
    for p in created:
        if p.endswith(".json"):
            dump = json.load(open(p, encoding="utf-8"))

    dec = (dump or {}).get("selfDecode") or {}
    decoded = dec.get("decoded") or []
    dq = decoded[0] if decoded else ""
    dopts = decoded[1:1 + len(OPTS)] if len(decoded) > 1 else []
    info = dec.get("info") or {}

    print("响应        :", json.dumps(data, ensure_ascii=False))
    print("新建文件    :", [os.path.basename(p) for p in created])
    print("字体字节    :", (dump or {}).get("font_bytes"))
    print("题干还原    :", dq)
    print("选项还原    :", dopts)
    print("avg_score   :", info.get("avg_score"), "| mapped:", info.get("mapped"), "| used:", info.get("used"))

    checks = [
        ("响应 ok + selfDecode", ok),
        ("字体另存为 .font", any(p.endswith(".font") for p in created)),
        ("json 里不再塞 font_b64", "font_b64" not in (dump or {})),
        ("题干完全还原", dq == PLAIN),
        ("四个选项全部还原", dopts == OPTS),
        ("平均相似度 > 0.8", float(info.get("avg_score") or 0) > 0.8),
    ]
    bad = [n for n, v in checks if not v]
    for n, v in checks:
        print(("PASS  " if v else "FAIL  ") + n)

    # 清理本次产生的诊断文件
    for p in created:
        try:
            os.remove(p)
        except OSError:
            pass
    print("\n清理完成，残留文件:", len(glob.glob(os.path.join(app.DEBUG_DIR, "debug-*"))))
    print("结果:", "全部通过" if not bad else f"失败 {len(bad)} 项")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
