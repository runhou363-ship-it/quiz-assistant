"""答题学习助手 —— 本地后端（带验证层）
流程：
  1. 多引擎搜索（DuckDuckGo + Bing 回退）收集线索；
  2. 对同一题并行多采样（默认 3 次，temperature 递增）让模型各自作答；
  3. Python 侧做多数投票，得出置信度（high/medium/low/none）与冲突标记；
  4. 无可靠答案时明确返回 answer_index=null，不硬编。

运行：
  pip install -r requirements.txt
  set OPENAI_API_KEY=你的key        # 必填
  # 可选：set OPENAI_BASE_URL=...   # 兼容第三方 OpenAI 格式服务
  # 可选：set OPENAI_MODEL=gpt-4o-mini
  # 可选：set QA_SAMPLES=3          # 每题采样次数（越多越稳，越慢越贵）
  python app.py
"""
import os
import re
import json
import glob
import time
import hashlib
import threading
import datetime
from concurrent.futures import ThreadPoolExecutor

import requests
from flask import Flask, request, jsonify
from flask_cors import CORS

try:
    import fontdec
except Exception as _e:  # 缺 fonttools 等依赖时后端仍可启动
    fontdec = None
    _FONTDEC_ERR = str(_e)

REPORT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "reports")


def _load_env_file():
    """从同目录的 .env 读取配置（无需额外依赖）。已存在的环境变量优先。"""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(path):
        return 0
    n = 0
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
                    n += 1
    except Exception:
        pass
    return n


_LOADED_ENV = _load_env_file()

app = Flask(__name__)
CORS(app)


N_SAMPLES = max(1, min(5, int(os.environ.get("QA_SAMPLES", "2"))))
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}

# auto = 只有出现分歧/不确定时才联网搜（默认，最快）；on = 每题都搜；off = 完全不搜
SEARCH_MODE = os.environ.get("QA_SEARCH", "auto").strip().lower()
SEARCH_TIMEOUT = max(1, min(10, int(os.environ.get("QA_SEARCH_TIMEOUT", "4"))))
QA_VERIFY = os.environ.get("QA_VERIFY", "1") != "0"      # 争议时追加一次裁决采样
QA_CACHE = os.environ.get("QA_CACHE", "1") != "0"        # 同题答案缓存
# 自适应采样（v0.9.7）：先并行跑 2 次，两次结论一致且不是低置信就不再花第 3 次；
# 不一致才补跑第 3 次。实测能省 1/3 调用，速度也快一点。设 0 可退回「每次固定跑满」。
QA_ADAPTIVE = os.environ.get("QA_ADAPTIVE", "1") != "0"
# 单次输出上限：选项分析限长后 800 足够；输出 token 是价格最贵、也最拖时间的部分
try:
    MAX_OUT_TOKENS = max(300, min(4000, int(os.environ.get("QA_MAX_TOKENS") or 800)))
except (TypeError, ValueError):
    MAX_OUT_TOKENS = 800
# 连接复用：每题要并发发 2~4 个请求，每次重新握手会白丢 100~300ms
_session = requests.Session()
try:
    _adapter = requests.adapters.HTTPAdapter(pool_connections=8, pool_maxsize=8, max_retries=0)
    _session.mount("https://", _adapter)
    _session.mount("http://", _adapter)
except Exception:
    pass

# —— 花费统计：只在本进程内累计，用来回答“这道题花了多少钱” ——
# 单价（元 / 百万 tokens），默认按 DeepSeek V4-Flash 低谷价折算（$0.15 / $0.60，汇率 7.1）。
# 换别家模型时按官网价改 .env 里的 QA_PRICE_IN / QA_PRICE_OUT 即可（免费模型填 0）。
def _fnum(name, default):
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return float(default)


PRICE_IN = _fnum("QA_PRICE_IN", 1.1)
PRICE_OUT = _fnum("QA_PRICE_OUT", 4.3)
_USAGE = {"calls": 0, "prompt": 0, "completion": 0, "cache_hit": 0}
_USAGE_LOCK = threading.Lock()


def _record_usage(usage):
    """把一次模型调用的 token 用量记到进程累计里。"""
    if not isinstance(usage, dict):
        return
    def _n(*keys):
        for k in keys:
            v = usage.get(k)
            if isinstance(v, (int, float)):
                return int(v)
        return 0
    with _USAGE_LOCK:
        _USAGE["calls"] += 1
        _USAGE["prompt"] += _n("prompt_tokens", "input_tokens")
        _USAGE["completion"] += _n("completion_tokens", "output_tokens")
        _USAGE["cache_hit"] += _n("prompt_cache_hit_tokens", "cache_read_input_tokens")


def _usage_snapshot():
    with _USAGE_LOCK:
        return dict(_USAGE)


def _money(tokens_in, tokens_out):
    return (tokens_in * PRICE_IN + tokens_out * PRICE_OUT) / 1_000_000


def _usage_report():
    """进程累计（给 /status 用）。"""
    u = _usage_snapshot()
    return {
        "calls": u["calls"],
        "prompt_tokens": u["prompt"],
        "completion_tokens": u["completion"],
        "cache_hit_tokens": u["cache_hit"],
        "cost": round(_money(u["prompt"], u["completion"]), 4),
        "currency": "CNY",
        "price": {"in": PRICE_IN, "out": PRICE_OUT, "unit": "CNY/1M tokens"},
    }
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cache")
ANSWER_DIR = os.path.join(CACHE_DIR, "answers")

_search_cache = {}       # query -> (timestamp, snippets)
_search_lock = threading.Lock()
_search_degraded = False  # 搜索引擎连续拿不到相关线索时，auto 模式不再反复白等
_search_misses = 0


def clean_html(html):
    t = re.sub(r"<[^>]+>", "", html or "")
    return re.sub(r"\s+", " ", t).strip()


def ddg_search(query, k=5):
    try:
        r = requests.post("https://html.duckduckgo.com/html/", data={"q": query},
                          headers=UA, timeout=SEARCH_TIMEOUT)
        snips = re.findall(r'class="result__snippet"[^>]*>(.*?)</a>', r.text, re.S)
        return [clean_html(s) for s in snips[:k] if clean_html(s)]
    except Exception:
        return []


def bing_search(query, k=5):
    try:
        r = requests.get("https://www.bing.com/search", params={"q": query},
                         headers=UA, timeout=SEARCH_TIMEOUT)
        out = []
        for block in re.split(r'class="b_algo"', r.text)[1:k + 1]:
            m = re.search(r"<p[^>]*>(.*?)</p>", block, re.S)
            if m:
                t = clean_html(m.group(1))
                if t:
                    out.append(t)
        return out
    except Exception:
        return []


def _answer_hint(snippets, question, options):
    """从搜索片段里抽「正确答案: C」这类独立信号，用来打破模型一致想错的情况。

    只认和题干明显相关的片段，且答案字母/序号必须在选项范围内。
    """
    kws = _keywords(question)
    for s in snippets or []:
        if not any(k in s for k in ("正确答案", "答案：", "答案:", "答案为", "答案是")):
            continue
        if kws and not any(k in s for k in kws[:12]):
            continue
        # 多选答案常写成「正确答案: ABCD」，要一次收全
        m = re.search(r"(?:正确答案|答案(?:为|是)?)\s*[:：]?\s*([A-Ha-h]{1,8}|[1-9]{1,8})", s)
        if not m:
            continue
        out = []
        for c in m.group(1):
            n = (ord(c.upper()) - 64) if c.isalpha() else int(c)
            if 1 <= n <= len(options) and n not in out:
                out.append(n)
        if out:
            return sorted(out)
    return None


def _keywords(query):
    """中文没有分词，用 2-gram 做粗略的相关性判定。"""
    q = re.sub(r"\s+", "", query or "")
    grams = [q[i:i + 2] for i in range(max(0, len(q) - 1))]
    stop = {"以下", "下列", "哪项", "哪一", "一项", "关于", "属于", "不是", "特点", "什么", "哪个"}
    return [g for g in grams if g not in stop][:40]


def _relevant(text, kws):
    if not kws:
        return True
    return sum(1 for g in kws if g in text) >= 2


def build_query(question, options=None):
    """把题干整理成搜索友好的查询，目标是命中题库/教材页面而不是字典词条。

    实测两个坑：「以下哪项…」会搜到「以下」的释义；「不是自然辩证法的特点」
    以「不」开头，Bing 会返回「不」字的字典页。所以句首疑问词和否定词都要去掉，
    再补上一两个选项关键词——题库页面通常同时包含题干和选项。
    """
    q = question or ""
    q = re.sub(r"[（(][^）)]{0,30}[）)]", " ", q)
    q = re.sub(r"[（）()【】\[\]“”\"'？?。，、；：!！…—～]", " ", q)
    q = re.sub(r"^\s*(以下|下列|下述|下面|关于)\s*", " ", q)
    q = re.sub(r"(哪一项|哪项|哪些|哪一个|该项|此项)", " ", q)
    q = re.sub(r"^\s*(不是|不属于|不包括|错误的是|不正确的是|不属于)\s*", " ", q)
    q = re.sub(r"\s+", " ", q).strip()
    if q and options:
        extra = " ".join(str(o).strip()[:12] for o in options[:2] if str(o).strip())
        q = (q + " " + extra).strip()
    return q or (question or "").strip()[:60]


def web_search(query):
    """双引擎并行 + 短超时 + 相关性过滤 + 结果缓存（30 分钟）。

    旧版串行先等 DDG 8 秒再等 Bing 8 秒，实测一题光搜索就 11.8 秒，
    而且返回的多是「以下」的词条释义，模型一条都用不上。
    """
    global _search_degraded, _search_misses
    if SEARCH_MODE == "off" or not query:
        return []
    if _search_degraded and SEARCH_MODE != "on":
        return []
    with _search_lock:
        hit = _search_cache.get(query)
    if hit and time.time() - hit[0] < 1800:
        return hit[1]

    raw = []
    with ThreadPoolExecutor(max_workers=2) as ex:
        futs = [ex.submit(ddg_search, query, 5), ex.submit(bing_search, query, 5)]
        for f in futs:
            try:
                raw += f.result(timeout=SEARCH_TIMEOUT + 1)
            except Exception:
                pass

    kws = _keywords(query)
    seen, out = set(), []
    for s in raw:
        has_answer = any(k in s for k in ("正确答案", "答案：", "答案:", "答案为", "答案是"))
        # 题库片段（带「正确答案」）只要和题干沾边就放行，别被 2-gram 阈值误杀
        ok = _relevant(s, kws) or (has_answer and any(k in s for k in kws[:12]))
        if not ok:
            continue
        key = s[:80]
        if key not in seen:
            seen.add(key)
            out.append(s)
    res = out[:5]
    with _search_lock:
        _search_cache[query] = (time.time(), res)
        if res:
            _search_misses = 0
        else:
            _search_misses += 1
            if _search_misses >= 2:
                _search_degraded = True
    return res


SYS_PROMPT = (
    "你是严谨的答题助手。用你自己的学科知识作答，网络线索只作辅助佐证。"
    "作答前必须逐项分析每个选项：先确认题目要求选的是「符合题意/正确」还是「不符合题意/错误/不是」，"
    "特别注意「不属于、不是、错误的是」这类否定题，然后说明每个选项为什么选或不选。"
    "题型由用户消息里的「题型」字段给出：single=单选题，只能选 1 个；"
    "multi=多选题，必须选出所有符合题意的选项（通常 2 个及以上），漏选和错选都算错；"
    "unknown=未标明，请依据题干（如「哪些」「包括」「以下都」）自行判断。"
    "只有题目信息确实不足、题干疑似乱码、或两个选项同样合理时才返回空数组。"
    "线索无关（词条释义、新闻、广告）直接忽略，不要因此拒答。"
    "题目与选项由页面加密字体还原，个别字可能是形近错字（如「村械唯物主义」实为「机械唯物主义」、"
    "「科字」实为「科学」）。请先按上下文识别这类明显不通顺的词，以纠正后的含义作答，"
    "并把纠正后的文本写进 corrected_question / corrected_options（只列真的改了字的选项，格式是序号到原文的对象；"
    "没有错字时 corrected_question 留空、corrected_options 给 {}，不要整组复述选项）。不要改写题意。"
    "confidence：high=确定，medium=较有把握，low=不确定但倾向它。"
    "必须只输出一个 JSON 对象，字段："
    '{"question_type":"single|multi", '
    '"option_analysis":{"1":"<选/不选 + 理由>", "2":"..."}, '
    '"answer_indices": [<从1开始的整数>, ...], '
    '"answer_texts": ["<每个所选选项的原文>", ...], '
    '"corrected_question":"<纠正后的题干，无错字则空>", '
    '"corrected_options":{"<选项序号>":"<纠正后的原文>"}, '
    '"confidence":"high|medium|low", "evidence_ids":[], '
    '"explanation":"<简短解析，说明依据>"}。'
    "输出要精炼（直接决定响应速度）：option_analysis 每项一句话、不超过 25 字；"
    "explanation 不超过 80 字；不要复述题目和选项。"
    "硬性要求：answer_indices 与 answer_texts 数量相同、一一对应、顺序一致；"
    "explanation 的结论不得与它们冲突；单选时 answer_indices 必须恰好 1 个元素。不要输出多余文字。"
)

# 多次采样不靠高温制造随机性，而是换思考视角——既保留多样性，又减少无意义的分歧
VIEWS = [
    "按常规思路逐项分析作答。",
    "先圈出题干的否定词（不是/不属于/错误），再逐项排除，避免把选非做成选是。",
    "用反证法：分别假设每个选项是答案，检查是否与题干和学科常识矛盾，再下结论。",
    "对照教材中的标准表述判断，注意区分特点与性质、方法、意义。",
    "逐项核对概念定义，排除只沾边但不符合题干限定的选项。",
]

JUDGE_PROMPT = (
    "你是答题复核裁判。下面同一道题有多次独立作答，它们可能互相矛盾。"
    "不要简单数票数：请自己重新审题（尤其注意否定词和题型是单选还是多选），检查每份理由是否成立，"
    "留意常见错误（把选非做成选是、多选题漏选、理由与结论不一致、把特点与性质混淆），"
    "然后给出你判定的最终答案：多选题必须给全所有正确选项。"
    "必须只输出一个 JSON 对象："
    '{"answer_indices": [<整数>, ...], "answer_texts": ["<选项原文>", ...], '
    '"confidence":"high|medium|low", "explanation":"<为什么这个结论更可靠>"}。'
)


TYPE_TEXT = {
    "single": "题型：单选题（single），只能选 1 个选项，answer_indices 必须恰好 1 个元素。",
    "multi": "题型：多选题（multi），必须选出所有符合题意的选项，漏选和错选都算错。",
    "judge": "题型：判断题（判断正误），只有两个选项（如 正确/错误、对/错、√/×），只能选 1 个，answer_indices 必须恰好 1 个元素。",
    "unknown": "题型：未标明（unknown），请先依据题干判断单选/多选，并在 question_type 里写明。",
}

_JUDGE_OPTS = ("正确", "错误", "对", "错", "true", "false", "√", "×", "✓", "✗", "t", "f", "right", "wrong")


def detect_qtype(question, options, hint=""):
    """优先级：前端从 DOM 控件识别出的题型 > 明确文字 > 题干关键词。"""
    h = str(hint or "").strip().lower()
    if h in ("single", "multi", "judge"):
        return h
    text = (question or "") + " " + " ".join(str(o) for o in (options or []))
    # 恰好两个选项且文字是「对/错」形态 → 判断题（仍按单选逻辑只选 1 个）
    if len(options or []) == 2 and all(str(o).strip().lower() in _JUDGE_OPTS for o in options):
        return "judge"
    if re.search(r"判断题|判断正误|正确.*错误|对.*错", text):
        return "judge"
    if re.search(r"多选|多项选择|不定项|至少有两个|有两个以上|可多选|选出所有|下列哪些|以下哪些", text):
        return "multi"
    if re.search(r"单选|单项选择|只有一个正确|哪一项|哪项不是|下列哪项", text):
        return "single"
    return "unknown"


def parse_json(text):
    try:
        return json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            return json.loads(m.group(0))
        raise ValueError("模型未返回可解析的 JSON")


def _local_backend():
    """Ollama / LM Studio 等本地服务不需要真 key。"""
    base = os.environ.get("OPENAI_BASE_URL", "")
    return "localhost" in base or "127.0.0.1" in base


def call_model(system, user, temperature=0.0, timeout=30, retries=2):
    """带退避重试：免费档（智谱 GLM-4-Flash / 硅基流动）并行采样容易触发 429。

    400/401/403 属于 key 或参数错误，直接失败不重试；429/5xx/超时/JSON 截断才重试。
    """
    api_key = os.environ.get("OPENAI_API_KEY") or ("ollama" if _local_backend() else "")
    base = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    body = {
        "model": model,
        "temperature": temperature,
        "max_tokens": MAX_OUT_TOKENS,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    if os.environ.get("QA_THINKING", "").strip() == "0":
        # 新版 DeepSeek（deepseek-flash 等）默认开「思考模式」，输出 token 会翻几倍、
        # 单选题还慢到 10s+。设 QA_THINKING=0 显式关掉，回到快而省的老行为。
        body["thinking"] = {"type": "disabled"}
    for attempt in range(retries + 1):
        try:
            resp = _session.post(
                f"{base}/chat/completions",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=body,
                timeout=timeout,
            )
            if resp.status_code in (400, 401, 403):
                resp.raise_for_status()
            if resp.status_code == 429 or resp.status_code >= 500:
                raise RuntimeError(f"HTTP {resp.status_code}: {(resp.text or '')[:120]}")
            resp.raise_for_status()
            payload = resp.json()
            _record_usage(payload.get("usage"))   # 先记账再解析：解析失败也算花过钱
            return parse_json(payload["choices"][0]["message"]["content"])
        except requests.exceptions.HTTPError:
            raise
        except Exception:
            if attempt >= retries:
                raise
            time.sleep(0.8 * (2 ** attempt))   # 0.8s → 1.6s


def sample_once(question, options, snippets, temperature, view="", qtype="unknown"):
    opt_block = "\n".join(f"{i+1}. {o}" for i, o in enumerate(options))
    ctx = "\n".join(f"[{i}] {s}" for i, s in enumerate(snippets)) or "（无网络线索）"
    user = (f"{TYPE_TEXT.get(qtype, TYPE_TEXT['unknown'])}\n\n题目：\n{question}\n\n"
            f"选项：\n{opt_block}\n\n网络线索：\n{ctx}")
    sys = SYS_PROMPT + (f"\n本次思考视角：{view}" if view else "")
    return call_model(sys, user, temperature)


def sample_verdict(question, options, details, snippets, external=None, qtype="unknown"):
    """分歧/线索冲突时才调用：把各方理由摆在一起，让模型重新审一次题做裁决。"""
    opt_block = "\n".join(f"{i+1}. {o}" for i, o in enumerate(options))
    lines = []
    for i, d in enumerate(details, 1):
        inds = d.get("indices") or []
        label = "、".join(options[j - 1] for j in inds if 1 <= j <= len(options)) or "未作答"
        lines.append(f"作答{i}：选 {label}；理由：{(d.get('explanation') or '')[:180]}")
    if external:
        elabel = "、".join(options[j - 1] for j in external if 1 <= j <= len(options))
        lines.append(f"网络资料里出现的参考答案：{elabel}"
                     "（需先确认与本题同题，再判断它与你的结论哪个更可靠）")
    ctx = "\n".join(f"[{i}] {s}" for i, s in enumerate(snippets)) or "（无网络线索）"
    user = (f"{TYPE_TEXT.get(qtype, TYPE_TEXT['unknown'])}\n\n题目：\n{question}\n\n"
            f"选项：\n{opt_block}\n\n多次作答：\n" + "\n".join(lines) + f"\n\n网络线索：\n{ctx}")
    return call_model(JUDGE_PROMPT, user, 0.0)


def _index_from_explanation(exp, options):
    """从「故选项4…」「选 D」「答案是哲理性」这类结论里反推选项序号。"""
    if not exp:
        return None
    tail = exp[-90:]
    m = re.search(
        r"(?:故选|应选|答案(?:是|为)?|正确(?:答案|选项)(?:是|为)?|选)\s*(?:项|第)?\s*([A-Ha-h]|[1-9])",
        tail,
    )
    if m:
        c = m.group(1)
        n = (ord(c.upper()) - 64) if c.isalpha() else int(c)
        if 1 <= n <= len(options):
            return n
    for kw in ("故选", "应选", "答案是", "答案为", "正确选项是", "正确选项为"):
        p = tail.rfind(kw)
        if p >= 0:
            seg = tail[p:p + 40]
            for i, o in enumerate(options):
                if o and o in seg:
                    return i + 1
    return None


def _as_indices(value, options):
    """把模型给的序号（单值 / 数组 / 字母）规范成去重排序的 list[int]。"""
    if value is None or value in ("", "null"):
        return []
    if not isinstance(value, (list, tuple, set)):
        value = [value]
    out = []
    for v in value:
        try:
            n = int(v)
        except Exception:
            if isinstance(v, str) and len(v) == 1 and v.isalpha():
                n = ord(v.upper()) - 64
            else:
                continue
        if 1 <= n <= len(options) and n not in out:
            out.append(n)
    return sorted(out)


def _indices_from_texts(texts, options):
    """按选项原文反查序号，支持多选题的多个选项文本。"""
    if not texts:
        return []
    if isinstance(texts, str):
        texts = [texts]
    out = []
    for t in texts:
        t = str(t).strip()
        if not t or t.lower() in ("null", "none", "无"):
            continue
        for i, o in enumerate(options):
            if t == o or (len(t) >= 2 and (t in o or o in t)):
                if i + 1 not in out:
                    out.append(i + 1)
                break
    return sorted(out)


def normalize_result(r, options, qtype="unknown"):
    """返回 (indices:list[int], 是否被修正, 置信度, 解析)。

    兼容新版 answer_indices/answer_texts、旧版 answer_index/answer_text，
    以及只有解析结论的情况；以「选项原文」为准修正自相矛盾的序号。
    """
    raw_indices = r.get("answer_indices")
    if raw_indices is None:
        v = r.get("answer_index")
        raw_indices = [] if v in (None, "", "null") else [v]
    indices = _as_indices(raw_indices, options)

    raw_texts = r.get("answer_texts")
    if raw_texts is None:
        v = r.get("answer_text")
        raw_texts = [] if v in (None, "", "null") else [v]
    text_indices = _indices_from_texts(raw_texts, options)

    fixed = False
    if text_indices and set(text_indices) != set(indices):
        indices = text_indices
        fixed = True
    if not indices:
        one = _index_from_explanation(str(r.get("explanation") or ""), options)
        if one:
            indices = [one]
            fixed = True
    if qtype in ("single", "judge") and len(indices) > 1:
        indices = indices[:1]
        fixed = True
    conf = str(r.get("confidence", "low")).lower()
    return sorted(set(indices)), fixed, conf, str(r.get("explanation") or "")


_REJECT_HEAD = re.compile(
    r"^[\s\"'“”‘’（(【\[]*(?:不选|不应选|排除|错误|不符合|不属|×|✗|否)")
_SELECT_HEAD = re.compile(
    r"^[\s\"'“”‘’（(【\[]*(?:应选|选它|选此|选中|选|正确|符合|√|✓)")


def _analysis_conflict(r, indices, options):
    """模型自己的「逐项分析」和它给的答案打架（例如选了第 2 项，分析却写「不选」）。

    这是免费的准确率信号：不看它的结论，看它的理由。命中就让答案进复核。
    """
    oa = r.get("option_analysis")
    if not isinstance(oa, dict) or not indices:
        return False
    sel = set(indices)
    for k, v in oa.items():
        m = re.search(r"\d+", str(k))
        if not m:
            continue
        n = int(m.group(0))
        if not 1 <= n <= len(options):
            continue
        t = str(v or "")
        if n in sel and _REJECT_HEAD.match(t):
            return True
        if n not in sel and _SELECT_HEAD.match(t):
            return True
    return False


def _parse_details(raw, options, qtype):
    """把每次采样的原始 JSON 规范成统一结构，并顺带统计「理由与答案矛盾」。"""
    details, fixed_count, contra = [], 0, False
    for r in raw:
        inds, fixed, conf, exp = normalize_result(r, options, qtype)
        fixed_count += int(fixed)
        qt = str(r.get("question_type") or "").lower()
        if qtype == "unknown" and qt in ("single", "multi"):
            qtype = qt          # 题型未标明时采信模型自己的判断
        if conf not in ("high", "medium", "low"):
            conf = "low"
        if _analysis_conflict(r, inds, options):
            contra = True
        details.append({
            "index": inds[0] if inds else None,   # 兼容旧字段
            "indices": inds,
            "confidence": conf,
            "evidence_ids": r.get("evidence_ids", []),
            "explanation": exp,
            "option_analysis": r.get("option_analysis", {}),
            "self_fixed": fixed,
        })
    return details, qtype, fixed_count, contra


def _tally(details):
    """按「每个选项获得多少票」统计，而不是给整个答案组合投票；多选漏选能被发现。"""
    votes, sets = {}, []
    for d in details:
        s = set(d["indices"])
        sets.append(s)
        for i in s:
            votes[i] = votes.get(i, 0) + 1
    return votes, sets, len(details)


def solve_question(question, options, qtype_hint=""):
    """单选/多选统一按「答案集合」投票；只有分歧/线索冲突才追加裁决。"""
    t0 = time.time()
    timing = {"search": 0.0, "samples": 0.0, "verdict": 0.0, "retry": 0.0, "total": 0.0}
    qtype = detect_qtype(question, options, qtype_hint)
    snippets = []
    raw, errors = [], []
    temps = [0.0, 0.12, 0.28, 0.42, 0.55]

    def run_batch(idxs):
        """并行跑一批采样；单次失败不影响其它几次。"""
        got = []
        if not idxs:
            return got
        with ThreadPoolExecutor(max_workers=len(idxs)) as pool:
            futs = [pool.submit(sample_once, question, options, snippets, temps[i],
                                VIEWS[i % len(VIEWS)], qtype) for i in idxs]
            for f in futs:
                try:
                    got.append(f.result())
                except Exception as e:
                    errors.append(str(e))
        return got

    # 常规路径完全不联网：多视角采样并行跑完就出结果
    if SEARCH_MODE == "on":              # 显式要求：先拿到线索再作答
        t = time.time()
        snippets = web_search(build_query(question, options))
        timing["search"] = round(time.time() - t, 2)

    t = time.time()
    # 自适应：先并行 2 次；两次结论一致且都不是低置信就不再花第 3 次
    first_n = 2 if (QA_ADAPTIVE and N_SAMPLES > 2) else N_SAMPLES
    raw = run_batch(range(first_n))
    details, qtype, fixed_count, contra = _parse_details(raw, options, qtype)
    if first_n < N_SAMPLES:
        agree = (len(details) >= 2
                 and all(d["indices"] for d in details)
                 and all(set(d["indices"]) == set(details[0]["indices"]) for d in details))
        if not (agree and all(d["confidence"] != "low" for d in details)):
            raw += run_batch(range(first_n, N_SAMPLES))
            details, qtype, fixed_count, contra = _parse_details(raw, options, qtype)
    timing["samples"] = round(time.time() - t, 2)

    external = _answer_hint(snippets, question, options)

    if not raw:
        timing["total"] = round(time.time() - t0, 2)
        return {"ok": False, "error": "模型调用失败：" + (errors[0] if errors else "未知错误"),
                "timing": timing, "question_type": qtype}

    # details 已在上面按批次解析好（见 _parse_details）

    # 字体解码难免留下形近错字；让模型顺带校对，至少 2 次采样一致才采纳，避免乱改题意
    cq_votes, co_votes = {}, [{} for _ in options]
    for r in raw:
        cq = str(r.get("corrected_question") or "").strip()
        if cq and cq != question and len(cq) <= len(question) * 2:
            cq_votes[cq] = cq_votes.get(cq, 0) + 1
        cos = r.get("corrected_options")
        if isinstance(cos, dict):        # 新格式：{"2": "改后的第2项"}
            pairs = []
            for k, t in cos.items():
                m = re.search(r"\d+", str(k))
                if m:
                    pairs.append((int(m.group(0)) - 1, t))
        elif isinstance(cos, list):      # 兼容旧格式：整组回传
            pairs = list(enumerate(cos))
        else:
            pairs = []
        for j, t in pairs:
            t = str(t or "").strip()
            if 0 <= j < len(options) and t and t != options[j]:
                co_votes[j][t] = co_votes[j].get(t, 0) + 1
    corrected_q = max(cq_votes, key=cq_votes.get) if cq_votes and max(cq_votes.values()) >= 2 else ""
    corrected_o = [max(v, key=v.get) if v and max(v.values()) >= 2 else options[j]
                   for j, v in enumerate(co_votes)]
    has_fix = bool(corrected_q) or any(corrected_o[j] != options[j] for j in range(len(options)))

    votes, sets, total = _tally(details)

    # 全部采样都空手而归（题目信息确实不足 / 题干乱码）：补一次「必须作答」的视角，
    # 把「未找到答案」的比例压下去。只在这一次发生时才有额外开销。
    if not votes and QA_ADAPTIVE:
        try:
            t = time.time()
            r2 = sample_once(question, options, snippets, 0.25,
                             "信息不完整或题干有错字时也必须选出最可能的选项，不要返回空数组。", qtype)
            if normalize_result(r2, options, qtype)[0]:
                raw.append(r2)
                details, qtype, fixed_count, contra = _parse_details(raw, options, qtype)
                votes, sets, total = _tally(details)
                timing["retry"] = round(time.time() - t, 2)
        except Exception:
            pass

    if not votes:
        timing["total"] = round(time.time() - t0, 2)
        return {
            "ok": True, "answer_index": None, "answer_text": None,
            "answer_indices": [], "answer_texts": [], "answer_letters": [],
            "question_type": qtype, "is_multi": qtype == "multi",
            "confidence": "none", "conflict": False, "disputed": [],
            "samples": details, "evidence_count": len(snippets), "votes": {},
            "explanation": "未找到可靠答案，建议人工核对题干与选项。",
            "self_fixed": fixed_count, "timing": timing,
        }

    threshold = max(2, total // 2 + 1)   # 3 次采样需 2 票，5 次需 3 票
    final = sorted(i for i, c in votes.items() if c >= threshold)
    weak = False
    if not final:                        # 没有选项过半：取最高票一档，交给裁决
        mx = max(votes.values())
        final = sorted(i for i, c in votes.items() if c == mx)
        weak = True
    if qtype in ("single", "judge") and len(final) > 1:
        final = [max(votes, key=lambda k: (votes[k], -k))]
    final_set = set(final)
    unanimous = all(s == final_set for s in sets)
    conflict = not unanimous
    external_conflict = bool(external and set(external) != final_set)
    # 单选 / 判断题：2 次采样已足够，冲突时按「最高票 / 最高置信」兜底，省掉最贵的第 4 次裁决采样；
    # 仅在多选题（歧义最大）或存在外部检索冲突 / 字体校对自相矛盾时才追加裁决，降低花费与延迟。
    need_verdict = QA_VERIFY and (qtype == "multi" or external_conflict or contra) and (conflict or weak)

    verdict = None
    if need_verdict:
        # auto = 只有分歧/不确定才联网取证；引擎不可用会自动降级，不反复白等
        if SEARCH_MODE == "auto" and not snippets and not _search_degraded:
            t = time.time()
            snippets = web_search(build_query(question, options))
            timing["search"] += round(time.time() - t, 2)
            external = _answer_hint(snippets, question, options)
        t = time.time()
        try:
            vr = sample_verdict(question, options, details, snippets, external, qtype)
            vinds, _f, vconf, vexp = normalize_result(vr, options, qtype)
            verdict = {"indices": vinds, "confidence": vconf, "explanation": vexp}
        except Exception as e:
            verdict = {"indices": [], "error": str(e)[:120]}
        timing["verdict"] = round(time.time() - t, 2)

    resolved_by = "vote"
    if verdict and verdict.get("indices"):
        final = sorted(set(verdict["indices"]))
        if qtype in ("single", "judge") and len(final) > 1:
            final = final[:1]
        resolved_by = "verdict"

    explanation = ""
    for d in details:
        if set(d["indices"]) == set(final) and d["explanation"]:
            explanation = d["explanation"]
            break
    if not explanation:
        for d in details:
            if d["explanation"]:
                explanation = d["explanation"]
                break
    if verdict and verdict.get("explanation"):
        explanation = (explanation + "\n【复核】" + verdict["explanation"]).strip()
    if external and set(external) != set(final):
        elabel = "、".join(options[j - 1] for j in external if 1 <= j <= len(options))
        explanation += f"\n【提示】网络资料里出现参考答案 {elabel}，与上述结论不一致，建议人工核对。"

    if resolved_by == "verdict":
        confidence = "medium" if set(final) == final_set else "low"
        if set(final) == final_set and verdict.get("confidence") == "high":
            confidence = "high"
    elif weak:
        confidence = "low"
    elif unanimous:
        confidence = "high"
    else:
        confidence = "medium"

    disputed = []
    if conflict:
        for idx, c in sorted(votes.items(), key=lambda kv: -kv[1]):
            if idx not in final:
                disputed.append({"answer_index": idx, "answer_text": options[idx - 1], "votes": c})

    timing["total"] = round(time.time() - t0, 2)
    return {
        "ok": True,
        "answer_index": final[0] if final else None,             # 兼容旧客户端
        "answer_text": options[final[0] - 1] if final else None,
        "answer_indices": final,
        "answer_texts": [options[i - 1] for i in final],
        "answer_letters": [chr(64 + i) for i in final if 1 <= i <= 26],
        "question_type": qtype,
        "is_multi": len(final) > 1 or qtype == "multi",
        "confidence": confidence,
        "conflict": conflict,
        "disputed": disputed,
        "samples": details,
        "evidence_count": len(snippets),
        "votes": {str(k): v for k, v in votes.items()},
        "explanation": explanation or "",
        "self_fixed": fixed_count,
        "resolved_by": resolved_by,
        "external_answer": external,
        "corrected": {"question": corrected_q or question, "options": corrected_o} if has_fix else None,
        "verdict": verdict,
        "analysis_conflict": contra,   # 模型「理由」与「答案」自相矛盾，已强制复核
        "timing": timing,
    }


@app.route("/health")
def health():
    return "ok"


@app.route("/status")
def status():
    key = os.environ.get("OPENAI_API_KEY") or ""
    return jsonify({
        "ok": True,
        "has_key": bool(key),
        "local_backend": _local_backend(),
        "key_hint": (key[:6] + "..." + key[-4:]) if len(key) > 12 else "",
        "model": os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
        "base_url": os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
        "samples": N_SAMPLES,
        "adaptive": QA_ADAPTIVE,
        "max_tokens": MAX_OUT_TOKENS,
        "engine": "v0.9.7",
        "search_mode": SEARCH_MODE,
        "search_timeout": SEARCH_TIMEOUT,
        "search_degraded": _search_degraded,
        "verdict": QA_VERIFY,
        "answer_cache": QA_CACHE,
        "usage": _usage_report(),
        "env_loaded": _LOADED_ENV,
        "reports_dir": REPORT_DIR,
        "fontdec": bool(fontdec),
        "font_refs": [n for n, _p, _i in fontdec._resolved_refs()] if fontdec else [],
        "font_size": fontdec.SIZE if fontdec else 0,
        "font_sizes": sorted([fontdec.SIZE] + list(fontdec.EXTRA_SIZES)) if fontdec else [],
        "font_low_gate": fontdec.LOW_GATE if fontdec else 0,
        "font_min_score": fontdec.MIN_SCORE if fontdec else 0,
    })


@app.route("/solve", methods=["POST"])
def solve():
    data = request.get_json(force=True, silent=True) or {}
    question = (data.get("question") or "").strip()
    options = [str(o).strip() for o in (data.get("options") or []) if str(o).strip()]
    raw_question, raw_options = question, list(options)

    # 加密字体（雨课堂 xuetangx-com-encrypted-font）：先用字体把字还原
    font_info = None
    font_warn = ""
    font_b64 = data.get("font_b64") or data.get("fontB64") or ""
    # 前端已经把密文还原成真字时不会再传字体；传了字体就说明这段文字还需要后端解码。
    # encrypted 显式为 false 时绝不套映射——正常中文被套上字形映射只会变成乱码。
    want_decode = bool(font_b64) and data.get("encrypted") is not False
    if want_decode:
        if fontdec is None:
            return jsonify({
                "ok": False,
                "error": f"字体解码模块不可用（{_FONTDEC_ERR}），请用 py -3 启动后端并安装 requirements.txt",
            }), 200
        try:
            decoded, mapping, font_info = fontdec.decode_texts(font_b64, [question] + options)
            question = decoded[0]
            options = decoded[1:]
            mapped = int((font_info or {}).get("mapped") or 0) if isinstance(font_info, dict) else 0
            if not mapped:
                # 一个字都没还原出来 → 说明字体不对/文字没加密，绝不能拿这串字去问模型
                return jsonify({
                    "ok": False,
                    "error": "加密字体没解析出任何文字（字体可能不对）。已拒绝作答，避免拿乱码答题。",
                    "font": font_info,
                }), 200
        except Exception as e:
            font_info = {"error": str(e)[:200]}
            return jsonify({
                "ok": False,
                "error": "字体解码失败，已拒绝作答（不拿乱码答题）：" + str(e)[:160],
                "font": font_info,
            }), 200

    # 兜底：题目里还有私用区/替换符，说明密文没解开 → 直接拒绝，而不是让模型硬猜
    if re.search(r"[\ue000-\uf8ff\ufffd]", question + "".join(options)):
        return jsonify({
            "ok": False,
            "error": "题目仍含未解码的加密字符，已拒绝作答。请刷新页面后点「重新抓取」重试。",
        }), 200

    if not question or not options:
        return jsonify({"ok": False, "error": "缺少 question 或 options"}), 200
    if not os.environ.get("OPENAI_API_KEY") and not _local_backend():
        return jsonify({
            "ok": False,
            "error": "未配置 OPENAI_API_KEY，无法推理。请在 server 目录放一个 .env 填 key；或用本地 Ollama（见 .env.example 零成本方案）。",
        }), 200

    # 同题缓存：重复刷同一份作业不再重复调模型（QA_CACHE=0 可关；nocache=1 可临时绕过）
    ck = hashlib.md5(
        (question + "\n" + "\n".join(options) + "\n" +
         os.environ.get("OPENAI_MODEL", "") + "|" + str(N_SAMPLES) + "|" +
         str(data.get("qtype") or "")).encode("utf-8")
    ).hexdigest()
    cpath = os.path.join(ANSWER_DIR, ck + ".json")
    if QA_CACHE and not data.get("nocache") and os.path.exists(cpath):
        try:
            with open(cpath, encoding="utf-8") as f:
                cached = json.load(f)
            cached["cached"] = True
            # 命中缓存没有调用模型：花费记 0，避免汇总里把旧成本重复累加
            cached["usage"] = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0,
                               "cost": 0.0, "currency": "CNY",
                               "total_cost": _usage_report()["cost"], "cached": True}
            if font_info is not None:
                cached["font"] = font_info
                cached["decoded"] = {"question": question, "options": options}
                cached["raw"] = {"question": raw_question, "options": raw_options}
            return jsonify(cached)
        except Exception:
            pass

    u0 = _usage_snapshot()
    resp = solve_question(question, options, str(data.get("qtype") or ""))
    if isinstance(resp, dict):
        u1 = _usage_snapshot()
        din = max(0, u1["prompt"] - u0["prompt"])
        dout = max(0, u1["completion"] - u0["completion"])
        resp["usage"] = {
            "calls": max(0, u1["calls"] - u0["calls"]),
            "prompt_tokens": din,
            "completion_tokens": dout,
            "cost": round(_money(din, dout), 6),
            "currency": "CNY",
            "total_cost": round(_money(u1["prompt"], u1["completion"]), 4),
        }
    if font_info is not None:
        resp["font"] = font_info
        resp["decoded"] = {"question": question, "options": options}
        resp["raw"] = {"question": raw_question, "options": raw_options}
    if font_warn:
        resp["font_warn"] = font_warn
    if QA_CACHE and resp.get("ok") and resp.get("answer_index") is not None:
        try:
            os.makedirs(ANSWER_DIR, exist_ok=True)
            tmp = cpath + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(resp, f, ensure_ascii=False)
            os.replace(tmp, cpath)
        except Exception:
            pass
    return jsonify(resp)


@app.route("/decode", methods=["POST"])
def decode_route():
    """只做字体解码，便于单独验证。入参：{font_b64|fontB64, texts:[...]}"""
    data = request.get_json(force=True, silent=True) or {}
    font_b64 = data.get("font_b64") or data.get("fontB64") or ""
    texts = [str(t) for t in (data.get("texts") or [])]
    if not font_b64 or not texts:
        return jsonify({"ok": False, "error": "缺少 font_b64 或 texts"}), 200
    try:
        out, mapping, info = fontdec.decode_texts(font_b64, texts)
        return jsonify({"ok": True, "texts": out, "info": info, "mapping": mapping})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)[:300]}), 200


DEBUG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "debug")


@app.route("/debug", methods=["POST"])
def debug_dump():
    """接收插件采集的页面结构，存成 json 供开发侧适配选择器。

    若带了加密字体（font_b64），顺手把字体存成 .font 文件并做一次自检解码，
    结果写进 selfDecode，这样不用等用户点「查找答案」就能判断解码是否可用。
    """
    import base64

    data = request.get_json(force=True, silent=True) or {}
    os.makedirs(DEBUG_DIR, exist_ok=True)
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    name = f"debug-{ts}.json"

    # 扩展诊断面板发的是 fontB64（驼峰），解题请求发的是 font_b64，两种都收
    b64 = data.get("font_b64") or data.get("fontB64") or ""
    if b64:
        try:
            raw = base64.b64decode(b64)
            fname = f"debug-{ts}.font"
            with open(os.path.join(DEBUG_DIR, fname), "wb") as f:
                f.write(raw)
            data["font_file"] = fname
            data["font_bytes"] = len(raw)

            ext = data.get("extract") or {}
            # 只拿「真正套了加密字体的片段」去建映射并自检。
            # 不能把整段题干/选项一起送进去：正常中文也会被当成密文字建映射，
            # 自检结果就会是“第一节”→“阴束时”这种乱码，反而误导排查。
            segs = [str(e.get("text") or "") for e in (data.get("encrypted") or []) if e.get("text")]
            texts = [t for t in segs if t][:24]

            if fontdec is not None and texts:
                decoded, mapping, info = fontdec.decode_texts(raw, texts)
                data["selfDecode"] = {
                    "decoded_segments": decoded,
                    "info": info,
                    "mapping_sample": {k: mapping[k] for k in list(mapping)[:20]},
                    "note": "只对加密片段做自检；整题显示的文字见 enc.shownQuestion",
                }
            elif fontdec is not None:
                data["selfDecode"] = {
                    "decoded_segments": [],
                    "info": {"mapped": 0},
                    "note": "页面上没抓到加密文字片段，本题大概率是明文，无需解码",
                }
        except Exception as e:  # 诊断本身不能因为解码失败而失败
            data["font_decode_error"] = f"{type(e).__name__}: {e}"
        data.pop("font_b64", None)  # 已单独存文件，不重复塞进 json
        data.pop("fontB64", None)

    with open(os.path.join(DEBUG_DIR, name), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return jsonify({"ok": True, "file": name, "selfDecode": bool(data.get("selfDecode"))})


@app.route("/report", methods=["POST"])
def report():
    data = request.get_json(force=True, silent=True) or {}
    os.makedirs(REPORT_DIR, exist_ok=True)
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    md = data.get("markdown") or ""
    with open(os.path.join(REPORT_DIR, f"report-{ts}.md"), "w", encoding="utf-8") as f:
        f.write(md)
    with open(os.path.join(REPORT_DIR, f"report-{ts}.json"), "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return jsonify({"ok": True, "file": f"report-{ts}.md"})


@app.route("/combine", methods=["POST"])
def combine():
    files = sorted(glob.glob(os.path.join(REPORT_DIR, "report-*.md")))
    if not files:
        return jsonify({"ok": False, "error": "没有可合并的报告，请先运行插件生成。"}), 200
    parts = []
    for f in files:
        with open(f, encoding="utf-8") as fh:
            parts.append(fh.read().strip())
    combined = "\n\n".join(parts)
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    with open(os.path.join(REPORT_DIR, f"combined-{ts}.md"), "w", encoding="utf-8") as fh:
        fh.write(combined)
    questions = []
    for jf in sorted(glob.glob(os.path.join(REPORT_DIR, "report-*.json"))):
        try:
            with open(jf, encoding="utf-8") as fh:
                d = json.load(fh)
            if isinstance(d, dict) and isinstance(d.get("questions"), list):
                questions.extend(d["questions"])
        except Exception:
            pass
    with open(os.path.join(REPORT_DIR, f"combined-{ts}.json"), "w", encoding="utf-8") as fh:
        json.dump({"questions": questions}, fh, ensure_ascii=False, indent=2)
    return jsonify({"ok": True, "file": f"combined-{ts}.md", "count": len(files), "markdown": combined})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8787"))
    # 后台预热参考字体位图缓存（首次约 4 秒/字体，之后从 server/cache 直接读）
    if fontdec is not None:
        try:
            fontdec.warm(background=True)
        except Exception:
            pass
    app.run(host="127.0.0.1", port=port, debug=False)
