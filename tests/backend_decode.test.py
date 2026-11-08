# -*- coding: utf-8 -*-
"""后端 /decode 接口联调测试：造一个假加密字体，走 Flask test_client 验证解码链路。

运行： py -3 tests/backend_decode.test.py
"""
import base64
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "server"))
sys.path.insert(0, HERE)

from decode_fake import make_fake_encrypted  # noqa: E402

import app  # noqa: E402
import fontdec  # noqa: E402


def main():
    if not fontdec.available_refs():
        print("SKIP 本机没有参考字体")
        return 0

    src = "以下哪项不是自然辩证法的特点"
    data, mapping = make_fake_encrypted(src)
    obf = "".join(chr(next(k for k, v in mapping.items() if v == ord(c))) for c in src)

    client = app.app.test_client()
    resp = client.post("/decode", json={
        "font_b64": base64.b64encode(data).decode(),
        "texts": [obf, "纯明文不该变"],
    })
    j = resp.get_json()
    print("接口返回:", j.get("ok"), j.get("info"))
    print("解出:", j.get("texts", [""])[0])
    ok1 = j.get("ok") and j["texts"][0] == src
    ok2 = j["texts"][1] == "纯明文不该变"
    print(("PASS" if ok1 else "FAIL"), "加密文本还原")
    print(("PASS" if ok2 else "FAIL"), "明文不受影响")
    return 0 if (ok1 and ok2) else 1


if __name__ == "__main__":
    sys.exit(main())
