# -*- coding: utf-8 -*-
"""打发布包：只收运行必需的文件，并写一份不含任何密钥的 .env 模板。

用法： python tests/pack_release.py [版本号]
产物： 项目上级目录/答题学习助手_v<版本>.zip
"""
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.dirname(ROOT)

ENV_TEMPLATE = """# ============================================================
# 答题学习助手 —— 本地配置
#
# 【必做】把下面 OPENAI_API_KEY= 后面填成你自己的 API Key
#   等号后不要空格、不要加引号
#   本压缩包不含任何真实密钥，请自行申请
# 改完需重启后端（双击 start-server.bat）
# ============================================================

OPENAI_API_KEY=

# 默认 DeepSeek（OpenAI 兼容接口），可换成任何 OpenAI 兼容服务
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_MODEL=deepseek-chat

# 每题采样次数（1-5）：越多越稳、越慢越贵
QA_SAMPLES=3

# 速度与准确率（说明见 使用说明.md）
QA_SEARCH=off
QA_SEARCH_TIMEOUT=4
QA_VERIFY=1
QA_CACHE=1
"""

# 运行必需的文件（相对项目根目录）
FILES = [
    "使用说明.md",
    "快速上手.txt",
    "README.md",
    "start-server.bat",
    "check-config.bat",
    "extension/manifest.json",
    "extension/popup.html",
    "extension/popup.js",
    "extension/background.js",
    "extension/inject.js",
    "extension/video-brush.js",
    "server/app.py",
    "server/fontdec.py",
    "server/requirements.txt",
    "server/.env.example",
    "server/fonts/NotoSansSC-VF.ttf",
    "server/fonts/README.txt",
]

SECRET_RE = re.compile(r"(sk-[A-Za-z0-9]{16,}|[0-9a-f]{32}\.[A-Za-z0-9]{20,})")


def main():
    version = sys.argv[1] if len(sys.argv) > 1 else "0.9.5"
    out = os.path.join(OUT_DIR, "答题学习助手_v%s.zip" % version)
    if os.path.exists(out):
        os.remove(out)

    missing = [f for f in FILES if not os.path.exists(os.path.join(ROOT, f))]
    if missing:
        raise SystemExit("缺少文件：" + ", ".join(missing))

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for rel in FILES:
            z.write(os.path.join(ROOT, rel), "quiz-assistant/" + rel)
        z.writestr("quiz-assistant/server/.env", ENV_TEMPLATE)

    # 自检：包里不能出现任何形似密钥的字符串
    hits = []
    with zipfile.ZipFile(out) as z:
        for info in z.infolist():
            if info.file_size > 5 * 1024 * 1024:
                continue
            text = z.read(info).decode("utf-8", "ignore")
            for m in SECRET_RE.findall(text):
                hits.append((info.filename, m[:8] + "…"))
    if hits:
        os.remove(out)
        raise SystemExit("发现疑似密钥，已删除产物：%r" % (hits,))

    size = os.path.getsize(out) / 1024 / 1024
    print("OK  %s  %.1f MB  %d 个文件" % (out, size, len(FILES) + 1))
    with zipfile.ZipFile(out) as z:
        for n in z.namelist():
            print("   ", n)


if __name__ == "__main__":
    main()
