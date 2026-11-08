# -*- coding: utf-8 -*-
"""加密字体解码（学堂在线 / 雨课堂的 xuetangx-com-encrypted-font）。

问题：页面把题目、选项里的汉字重新编码——DOM 里存的是"错字"，
靠一个动态生成的字体把字形映射回正确的字。所以 innerText 抓出来是乱码。

做法：
  1. 取到字体（woff2/ttf）→ 把每个混淆字形渲染成 96px 位图，裁到墨迹包围盒后缩放到 56×56；
  2. 参考字体（微软雅黑 / 宋体 / 黑体 / 楷体）用同样流程渲染 GB2312 全字表；
  3. **先判定这份加密字体基于哪个参考字体生成**（比较全部待解字符的平均命中分），
     选定后固定用这一个逐字比对（分数 = 灰度余弦 + 二值 IoU）；
  4. 低于阈值的字保留原样，不瞎猜，info 里列出低置信字符与各参考字体的贴合度。

为什么不是「每个字跨字体取最高分」：实测（2026-11 真实雨课堂字体，20 字人工标注）
  msyh 20/20（最低 0.842）／simhei 14/20／simsun 8/20／simkai 3/20。
  逐字跨字体取最高会把别的字体里"看起来更像"的错字选出来（特→恃、是→疙、合→台）。

性能：参考字体的 56×56 位图矩阵按字体缓存到 server/cache/*.npz，
      首次构建约 4 秒/字体，之后加载 <0.3 秒；服务启动时会后台预热。

依赖：fonttools、brotli、numpy、pillow
"""
import io
import os
import json
import hashlib
import tempfile
import threading

SIZE = 96            # 渲染字号（实测 96 明显优于 64/80）
NORM = 56            # 归一化到 NORM x NORM 再比对
MIN_SCORE = 0.75     # 单字命中阈值（分数 = 余弦 + IoU，满值约 2）
LOW_GATE = 0.60      # 多尺寸一致时可放宽到的阈值（救回"想"这类复杂字）
EXTRA_SIZES = (64, 112)  # 除主尺寸外再融合这两个渲染尺寸，避免单一尺寸的 hinting 误判
REF_FIT_GATE = 0.85  # 选定参考字体的最低平均命中分，低于此认为"没有相近字体"，全部保留原字
REF_FIT_STOP = 1.60  # 平均命中分高到这个程度（几乎同字体）就不必再试后面
MAX_TARGETS = 120    # 单次最多解这么多不同字符，防止异常页拖死
CHUNK = 1200         # 分块矩阵大小，控制峰值内存

CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")

# 雨课堂加密字体的 name 表实测为 "Source Han Sans SC VF"（思源黑体简体·可变字体，
# ExtraLight 字重）。以前一直拿微软雅黑比对，拟合只有 ~1.0，形近字（学→字、统→绞、
# 机→村）反复认错。改用同源字体后拟合 ~1.97，错字全部消失。
def _sourcehan_path():
    cands = [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts", "NotoSansSC-VF.ttf"),
        r"C:\Windows\Fonts\NotoSansSC-VF.ttf",
        r"C:\Windows\Fonts\SourceHanSansSC-VF.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/System/Library/Fonts/PingFang.ttc",
    ]
    return next((p for p in cands if os.path.exists(p)), "")


_SOURCEHAN = _sourcehan_path()

# (标签, 路径, ttc 索引)；顺序 = 优先尝试顺序
REF_FONTS = ([("sourcehan", _SOURCEHAN, None)] if _SOURCEHAN else []) + [
    ("msyh", r"C:\Windows\Fonts\msyh.ttc", 0),
    ("simsun", r"C:\Windows\Fonts\simsun.ttc", 0),
    ("simhei", r"C:\Windows\Fonts\simhei.ttf", None),
    ("simkai", r"C:\Windows\Fonts\simkai.ttf", None),
    ("noto", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 0),
    ("uming", "/usr/share/fonts/truetype/arphic/uming.ttc", 0),
]

_lock = threading.Lock()
_map_cache = {}     # font_md5 -> {char: char}
_conf_cache = {}    # font_md5 -> {char: score}
_fit_cache = {}     # font_md5 -> {ref: fit}
_tried = {}         # font_md5 -> set(已尝试解过的字符)
_bmp_cache = {}     # (path, index) -> (bmp uint8 [N, NORM*NORM], chars list)
_tmp_keep = []      # 临时文件路径，进程结束再清


# ---------------------------------------------------------------- 基础工具
def _common_chars():
    """GB2312 一二级汉字 + 常用标点/字母数字，作为候选池。"""
    chars = []
    for hi in range(0xB0, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                chars.append(bytes([hi, lo]).decode("gb2312"))
            except Exception:
                pass
    extra = "，。、；：？！“”‘’（）《》【】…—～·0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    return chars + list(extra)


def _to_ttf_bytes(data):
    """woff / woff2 → ttf 字节（PIL 的 FreeType 才能加载）。"""
    from fontTools.ttLib import TTFont
    f = TTFont(io.BytesIO(data))
    if getattr(f, "flavor", None):
        f.flavor = None
        buf = io.BytesIO()
        f.save(buf)
        return buf.getvalue()
    return data


def _imgfont(ttf_bytes, size=SIZE):
    from PIL import ImageFont
    fd, path = tempfile.mkstemp(suffix=".ttf", prefix="qa-font-")
    try:
        os.write(fd, ttf_bytes)
    finally:
        os.close(fd)
    _tmp_keep.append(path)
    return ImageFont.truetype(path, size)


def _bmp(font, ch, size=SIZE):
    """渲染单字 → NORM×NORM 的 uint8 位图（裁到墨迹包围盒，抹掉字号/位置差异）。"""
    import numpy as np
    from PIL import Image, ImageDraw

    canvas = size * 2
    img = Image.new("L", (canvas, canvas), 0)
    ImageDraw.Draw(img).text((size // 2, size // 3), ch, fill=255, font=font)
    a = np.asarray(img, dtype=np.uint8)
    ys, xs = np.nonzero(a > 25)
    if len(ys) == 0:
        return None
    sub = a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    return np.asarray(Image.fromarray(sub).resize((NORM, NORM), Image.BILINEAR), dtype=np.uint8)


def _vectors(bmp):
    """[N, NORM*NORM] uint8 → (灰度单位向量 float32, 二值掩码 float32)。"""
    import numpy as np

    f = bmp.reshape(len(bmp), -1).astype(np.float32)
    f -= f.mean(axis=1, keepdims=True)
    nrm = np.linalg.norm(f, axis=1, keepdims=True)
    nrm[nrm == 0] = 1.0
    gray = f / nrm
    mask = (bmp.reshape(len(bmp), -1) > 96).astype(np.float32)
    return gray, mask


def _cache_path(path, index, size=SIZE):
    key = f"{os.path.basename(path)}|{index}|{size}|{NORM}|v2"
    h = hashlib.md5(key.encode("utf-8")).hexdigest()[:10]
    stem = os.path.splitext(os.path.basename(path))[0].replace(".", "_")
    return os.path.join(CACHE_DIR, f"ref-{stem}-{h}.npz")


def _ref_bmps(path, index, size=SIZE):
    """参考字体的位图矩阵：内存 → 磁盘 npz → 现场构建，三级。返回 (bmp, chars) 或 (None, [])。"""
    import numpy as np
    from PIL import ImageFont

    key = (path, index, size)
    with _lock:
        hit = _bmp_cache.get(key)
    if hit is not None:
        return hit

    cache = _cache_path(path, index, size)
    if os.path.exists(cache):
        try:
            z = np.load(cache, allow_pickle=False)
            bmp, chars = z["bmp"], [str(c) for c in z["chars"]]
            if len(bmp) and len(chars) == len(bmp):
                with _lock:
                    _bmp_cache[key] = (bmp, chars)
                return bmp, chars
        except Exception:
            pass  # 坏缓存就当没有，重建

    if index is not None:
        font = ImageFont.truetype(path, size, index=index)
    else:
        font = ImageFont.truetype(path, size)

    rows, chars = [], []
    for ch in _common_chars():
        try:
            b = _bmp(font, ch, size)
        except Exception:
            b = None
        if b is None:
            continue
        rows.append(b)
        chars.append(ch)
    if not rows:
        return None, []

    bmp = np.stack(rows)
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        np.savez_compressed(cache, bmp=bmp, chars=np.array(chars))
    except Exception:
        pass
    with _lock:
        _bmp_cache[key] = (bmp, chars)
    return bmp, chars


def _score_against(QG, QB, ref_bmp):
    """分块算分：灰度余弦 + 二值 IoU。返回 [T, N] 的 float32。"""
    import numpy as np

    total_n = len(ref_bmp)
    out = np.empty((QG.shape[0], total_n), dtype=np.float32)
    qsum = QB.sum(axis=1)[:, None]
    for i in range(0, total_n, CHUNK):
        part = ref_bmp[i:i + CHUNK]
        RG, RB = _vectors(part)
        cos = QG @ RG.T
        inter = QB @ RB.T
        tot = qsum + RB.sum(axis=1)[None, :]
        out[:, i:i + CHUNK] = cos + inter / np.maximum(tot - inter, 1e-6)
    return out


def _resolved_refs():
    return [(name, path, idx) for name, path, idx in REF_FONTS if os.path.exists(path)]


def available_refs():
    return [p for _n, p, _i in _resolved_refs()]


# ---------------------------------------------------------------- 解码
def _enc_vectors(ttf, targets, size):
    """指定渲染尺寸下，把待解字渲染成 (灰度向量, 二值向量, 实际字符列表)。"""
    import numpy as np
    font = _imgfont(ttf, size)
    rows, keep = [], []
    for ch in targets:
        b = _bmp(font, ch, size)
        if b is not None:
            rows.append(b)
            keep.append(ch)
    if not rows:
        return None, None, []
    G, B = _vectors(np.stack(rows))
    return G, B, keep


def _ref_score(EG, EB, path, index, size):
    bmp, chars = _ref_bmps(path, index, size)
    if bmp is None or not len(chars):
        return None, []
    return _score_against(EG, EB, bmp), chars


def _build_mapping(font_bytes, used_chars):
    """返回 ({混淆字符: 真实字符}, {字符: 命中分}, {参考字体: 贴合度})。

    实测教训（第二份雨课堂字体）：固定 96px 会把「表」认成「麦」；
    而「想」在所有尺寸都是第一名却只有 0.63~0.72 分，被 0.75 阈值丢掉。
    所以先用主尺寸选基准字体，再用多个渲染尺寸做 top1 投票 + 平均分融合，
    多尺寸一致时允许放宽到 LOW_GATE。
    """
    from fontTools.ttLib import TTFont

    ttf = _to_ttf_bytes(font_bytes)
    tt = TTFont(io.BytesIO(ttf))
    try:
        cmap = tt.getBestCmap() or {}
    except Exception:
        cmap = {}

    targets = [c for c in dict.fromkeys(used_chars) if ord(c) in cmap][:MAX_TARGETS]
    if not targets:
        return {}, {}, {}

    EG, EB, keep = _enc_vectors(ttf, targets, SIZE)
    if EG is None:
        return {}, {}, {}

    refs = _resolved_refs()
    if not refs:
        return {}, {}, {}

    fit_by_ref, best = {}, None  # (fit, name, path, index, S, chars)
    for name, path, index in refs:
        try:
            S, chars = _ref_score(EG, EB, path, index, SIZE)
        except Exception:
            continue
        if S is None:
            continue
        fit = float(S.max(axis=1).mean())
        fit_by_ref[name] = round(fit, 3)
        if best is None or fit > best[0]:
            best = (fit, name, path, index, S, chars)
        if fit >= REF_FIT_STOP:  # 几乎是同一个字体，后面的不用试了
            break
        # 不再用「0.95 就早停」：真实字体由 sourcehan 直接命中 1.97 走上面的 STOP，
        # 而合成宋体字体必须继续比到 simsun 才能拿到 2.0，提前停会选错基准字体。

    if best is None:
        return {}, {}, fit_by_ref
    fit, _name, ref_path, ref_index, S0, chars0 = best

    # 每个字符在每个尺寸下的 top5 候选
    per_char = {ch: [] for ch in keep}

    def add_votes(S, chars):
        for i, ch in enumerate(keep):
            order = S[i].argsort()[-5:][::-1]
            per_char[ch].append([(chars[int(j)], float(S[i][j])) for j in order])

    add_votes(S0, chars0)
    for size in EXTRA_SIZES:
        try:
            EG2, EB2, keep2 = _enc_vectors(ttf, targets, size)
            if EG2 is None or keep2 != keep:
                continue
            S2, chars2 = _ref_score(EG2, EB2, ref_path, ref_index, size)
            if S2 is not None:
                add_votes(S2, chars2)
        except Exception:
            continue

    result, conf = {}, {}
    for ch, votes in per_char.items():
        if not votes:
            continue
        tops = [v[0] for v in votes if v]
        counts = {}
        for cand, _s in tops:
            counts[cand] = counts.get(cand, 0) + 1

        def avg_for(cand):
            vals = [sc for v in votes for c, sc in v if c == cand]
            return sum(vals) / len(vals) if vals else 0.0

        cand, vote = max(counts.items(), key=lambda kv: (kv[1], avg_for(kv[0])))
        avg = avg_for(cand)
        conf[ch] = round(avg, 3)
        accepted = (avg >= MIN_SCORE) or (vote >= 2 and avg >= LOW_GATE)
        # 没有足够贴近的参考字体时，宁可保留原字也不硬猜
        result[ch] = cand if (accepted and fit >= REF_FIT_GATE) else ch
    return result, conf, fit_by_ref


def _map_cache_path(h):
    return os.path.join(CACHE_DIR, f"map-{h}.json")


def _load_map_cache(h):
    """映射按字体 md5 落盘：后端重启后不用再花 5 秒重算整份字体。"""
    p = _map_cache_path(h)
    if not os.path.exists(p):
        return None
    try:
        with open(p, encoding="utf-8") as f:
            d = json.load(f)
        m = d.get("mapping") or {}
        if not m:
            return None
        return m, d.get("conf") or {}, d.get("fit") or {}
    except Exception:
        return None


def _save_map_cache(h, mapping, conf, fit):
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        p = _map_cache_path(h)
        tmp = p + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"mapping": mapping, "conf": conf, "fit": fit}, f, ensure_ascii=False)
        os.replace(tmp, p)
    except Exception:
        pass


def decode_texts(font_b64_or_bytes, texts):
    """解码一组文本。返回 (decoded_list, mapping, info)。"""
    import base64

    raw = font_b64_or_bytes
    if isinstance(raw, str):
        raw = base64.b64decode(raw)

    used = set()
    for t in texts:
        used.update(t or "")

    h = hashlib.md5(raw).hexdigest()
    with _lock:
        mapping = _map_cache.get(h)
    if mapping is None:
        cached = _load_map_cache(h)
        if cached is not None:
            mapping, conf, fit_by_ref = cached
        else:
            mapping, conf, fit_by_ref = _build_mapping(raw, used)
            _save_map_cache(h, mapping, conf, fit_by_ref)
        with _lock:
            _map_cache[h] = mapping
            _conf_cache[h] = conf
            _fit_cache[h] = fit_by_ref
    else:
        # 缓存里可能没有新出现的字符，补算
        tried = _tried.setdefault(h, set())
        missing = [c for c in used if c not in mapping and c not in tried]
        if missing:
            more, mc, fit2 = _build_mapping(raw, missing)
            mapping.update(more)
            _conf_cache.setdefault(h, {}).update(mc)
            with _lock:
                _fit_cache.setdefault(h, {}).update(fit2 or {})
            _tried[h].update(more.keys())
            _save_map_cache(h, mapping, _conf_cache.get(h, {}), _fit_cache.get(h, {}))

    out = ["".join(mapping.get(ch, ch) for ch in (t or "")) for t in texts]

    conf = _conf_cache.get(h, {})
    entries = {k: v for k, v in conf.items() if k in mapping}
    changed = {k: v for k, v in entries.items() if mapping.get(k) != k}
    vals = [v for v in changed.values() if v]
    unresolved = [k for k, v in entries.items() if mapping.get(k) == k][:20]
    low = [k for k, v in changed.items() if v < MIN_SCORE][:20]
    fits = _fit_cache.get(h, {})
    ref_used = max(fits, key=fits.get) if fits else ""

    info = {
        "font_hash": h,
        "mapped": len(changed),
        "used": len(used),
        "ref": ref_used,
        "ref_fit": fits.get(ref_used, 0) if ref_used else 0,
        "ref_fits": fits,
        "avg_score": round(sum(vals) / len(vals), 3) if vals else 0,
        "min_score": round(min(vals), 3) if vals else 0,
        "unresolved": unresolved,
        "low_conf": low,
        "refs": [n for n, _p, _i in _resolved_refs()],
    }
    return out, mapping, info


def warm(background=True):
    """后台预热参考字体位图缓存，避免第一次解码现场构建等 8~10 秒。

    除了主尺寸的 4 个参考字体，还要预热多尺寸融合用到的额外尺寸
    （只预热首选基准字体即可，其它字体按需构建）。
    """
    def run():
        refs = _resolved_refs()
        for name, path, index in refs:
            try:
                _ref_bmps(path, index, SIZE)
            except Exception:
                continue
        if refs:
            _name, path, index = refs[0]
            for size in EXTRA_SIZES:
                try:
                    _ref_bmps(path, index, size)
                except Exception:
                    continue

    if background:
        t = threading.Thread(target=run, name="fontdec-warm", daemon=True)
        t.start()
        return t
    run()
    return None


def looks_encrypted(text):
    """粗判：出现大量非常用字 / 明显不通顺时提示可能是混淆字体。"""
    if not text:
        return False
    rare = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff" and ch in "导责色约义率条攻埋首阶授培群宫委何")
    return rare >= 2
