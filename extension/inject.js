/* 答题学习助手 —— 页面内注入脚本
 * 两种模式：
 *  手动模式：点“查找答案”看推荐+解析，自己点选项、自己翻页。
 *  自动模式：逐题识别答案并自动点「下一题」翻页（不替你勾选任何选项），
 *            一点「查看汇总」或跑到最后一题就立刻关闭；下一轮须手动勾选，开启时会清空上一轮汇总。
 */
(function () {
  if (window.__qaAssistantInjected) return;
  window.__qaAssistantInjected = true;

  const STYLE = `
    #qa-panel { position: fixed; right: 16px; bottom: 16px; width: 350px; max-height: 80vh;
      overflow: auto; background: #fff; border: 1px solid #d8dee9; border-radius: 12px;
      box-shadow: 0 8px 30px rgba(0,0,0,.18); z-index: 2147483647; font-family: system-ui, "Microsoft YaHei", sans-serif; font-size: 13px; color: #222; }
    #qa-panel header { background: #2563eb; color: #fff; padding: 10px 12px; font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
    #qa-panel header button { background: transparent; border: 0; color: #fff; cursor: pointer; font-size: 16px; line-height: 1; }
    #qa-panel .body { padding: 12px; }
    #qa-panel .row { display: flex; justify-content: space-between; align-items: baseline; }
    #qa-panel .count { font-size: 12px; color: #2563eb; font-weight: 600; }
    #qa-panel label { display: block; font-weight: 600; margin: 8px 0 4px; color: #444; }
    #qa-panel textarea { width: 100%; box-sizing: border-box; min-height: 60px; resize: vertical; padding: 8px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 13px; font-family: inherit; }
    #qa-panel .opt { display: flex; gap: 6px; margin: 6px 0; }
    #qa-panel .opt input[type=text] { flex: 1; padding: 6px 8px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 13px; }
    #qa-panel .opt .del { border: 0; background: #fee2e2; color: #b91c1c; border-radius: 8px; width: 30px; cursor: pointer; }
    #qa-panel .opt-toggle { margin: 10px 0 2px; font-size: 12px; color: #475569; }
    #qa-panel .opt-toggle input[type=number] { width: 50px; }
    #qa-panel .actions { display: flex; gap: 8px; margin-top: 8px; }
    #qa-panel .actions button { flex: 1; padding: 9px; border: 0; border-radius: 8px; font-size: 13px; cursor: pointer; }
    #qa-panel .primary { background: #2563eb; color: #fff; }
    #qa-panel .ghost { background: #e2e8f0; color: #334155; }
    #qa-panel .result { margin-top: 12px; padding: 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; }
    #qa-panel .result h4 { margin: 0 0 6px; color: #2563eb; }
    #qa-panel .result .exp { white-space: pre-wrap; line-height: 1.6; max-height: 240px; overflow: auto; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
    #qa-panel .status { margin-top: 8px; font-size: 12px; color: #64748b; min-height: 16px; }
    #qa-panel .badge { font-size: 11px; background: #e0e7ff; color: #3730a3; padding: 1px 6px; border-radius: 999px; margin-left: 4px; }
    .qa-suggested { outline: 3px solid #2563eb !important; outline-offset: 2px; border-radius: 6px; }
  `;

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return s.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  // 人工核对入口：夸克 AI 搜索页（实测 https://www.quark.cn/s?q=题干 会直接带查询词打开）
  // 只是把题干复制好 + 开一个网页，不调用夸克任何内部接口，也不影响自动流程。
  const QA_CHECK_URL = "https://www.quark.cn/s?q=";

  const QA_PANEL_SEL = "#qa-panel";

  function isOurs(el) {
    try { return !!(el && el.closest && el.closest(QA_PANEL_SEL)); } catch (e) { return false; }
  }

  const normText = (s) => (s || "").replace(/\s+/g, " ").trim();

  function isVisible(el) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) return false;
      // 关键：雨课堂有反自动化「诱饵」——用 position:fixed; left/top:-10000px 把假选项、
      // 假「下一题」藏到屏幕外。只判断宽高会把它们当成可见元素 → 误点/误抓。
      // 这里要求元素必须与所在文档的视口有交集（允许 50px 余量，兼容滚动容器）。
      const doc = el.ownerDocument || document;
      const win = doc.defaultView || window;
      const vw = win.innerWidth || 0, vh = win.innerHeight || 0;
      if (vw && vh) {
        const M = 50;
        const iw = Math.min(r.right, vw + M) - Math.max(r.left, -M);
        const ih = Math.min(r.bottom, vh + M) - Math.max(r.top, -M);
        if (iw <= 1 || ih <= 1) return false;
      }
      const cs = win.getComputedStyle ? win.getComputedStyle(el) : null;
      if (cs && (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0)) return false;
      return true;
    } catch (e) { return false; }
  }

  // 平台埋的反自动化诱饵节点：data-automation-risk-decoys / data-risk-target="decoy" / data-risk-decoy-type
  function isDecoy(el) {
    try {
      if (!el || !el.closest) return false;
      return !!el.closest('[data-automation-risk-decoys],[data-risk-target="decoy"],[data-risk-decoy-type]');
    } catch (e) { return false; }
  }

  // —— 可搜索的根：主文档 + shadow root + 同源 iframe（雨课堂这类 SPA 常见）——
  function collectRoots() {
    const roots = [];
    const seen = new Set();
    const pushRoot = (r) => {
      if (!r || seen.has(r)) return false;
      seen.add(r);
      roots.push(r);
      return true;
    };
    pushRoot(document);
    const queue = [document];
    let guard = 0;
    while (queue.length && guard++ < 30) {
      const root = queue.shift();
      let els = [];
      try { els = Array.from(root.querySelectorAll("*")); } catch (e) { els = []; }
      els.forEach((el) => {
        if (!el) return;
        if (el.shadowRoot && pushRoot(el.shadowRoot)) queue.push(el.shadowRoot);
        if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
          let cd = null;
          try { cd = el.contentDocument; } catch (e) { cd = null; }
          if (cd && pushRoot(cd)) queue.push(cd);
        }
      });
    }
    return roots;
  }

  function qsaIn(root, sel) {
    try { return Array.from(root.querySelectorAll(sel)); } catch (e) { return []; }
  }

  const LETTER_HEAD = /^([A-Ha-h])\s*[.．、,，)）:：]?\s*([\s\S]*)$/;
  const NAV_WORDS = /^(知识点|知识点列表|目录|章节|课程|作业|讨论|公告|搜索|上一题|下一题|提交|展开|收起|返回|首页|登录|更多|排序|完成度.*)$/;

  // 把「A/B/C…」聚成连续分组，同字母保留最短文本，要求从 A 开始、至少 2 项
  function groupConsecutive(arr) {
    if (!arr || !arr.length) return null;
    const byLetter = new Map();
    arr.forEach((it) => {
      const cur = byLetter.get(it.letter);
      if (!cur || (it.text || "").length < (cur.text || "").length) byLetter.set(it.letter, it);
    });
    const letters = [...byLetter.keys()].sort();
    if (letters.length < 2 || letters[0] !== "A") return null;
    for (let i = 0; i < letters.length; i++) {
      if (letters[i] !== String.fromCharCode(65 + i)) return null;
    }
    return letters.map((l) => byLetter.get(l));
  }

  // 选项识别：多策略，兼容各种 DOM 结构
  function findOptionsByLetters(roots) {
    const docs = roots && roots.length ? roots : [document];
    const OPT_SEL = "div, li, p, span, label, td, section, article, a, button";

    // 策略 1：单个节点内含「字母 + 文字」
    const buckets = new Map();
    docs.forEach((root) => {
      qsaIn(root, OPT_SEL).forEach((el) => {
        if (isOurs(el)) return;
        if (el.children && el.children.length > 8) return;
        const t = normText(el.innerText || el.textContent || "");
        if (!t || t.length > 120) return;
        const m = t.match(LETTER_HEAD);
        if (!m || !m[2].trim()) return;
        const p = el.parentElement;
        if (!p) return;
        if (!buckets.has(p)) buckets.set(p, []);
        buckets.get(p).push({ letter: m[1], text: m[2].trim(), el });
      });
    });

    let best = null;
    buckets.forEach((arr) => {
      const g = groupConsecutive(arr);
      if (g && (!best || g.length > best.length)) best = g;
    });
    if (best) return best.map((it) => ({ el: it.el, text: it.text }));

    // 策略 2：字母单独成块（圆圈里只有 A），文字在兄弟节点
    const loneBuckets = new Map();
    docs.forEach((root) => {
      qsaIn(root, "span, div, i, b, em, label, li, td").forEach((el) => {
        if (isOurs(el)) return;
        const t = normText(el.innerText || el.textContent || "");
        if (!/^[A-H]$/.test(t)) return;
        const p = el.parentElement;
        if (!p) return;
        if (!loneBuckets.has(p)) loneBuckets.set(p, []);
        loneBuckets.get(p).push({ letter: t, el });
      });
    });

    let best2 = null;
    loneBuckets.forEach((arr, parent) => {
      const sibs = parent && parent.children ? Array.from(parent.children) : [];
      if (sibs.length < 2) return;
      const items = [];
      arr.forEach((it) => {
        const idx = sibs.indexOf(it.el);
        let txt = "";
        for (let i = idx + 1; i < sibs.length; i++) {
          const st = normText(sibs[i].innerText || sibs[i].textContent || "");
          if (st && !/^[A-H]$/.test(st)) { txt = st; break; }
        }
        if (txt && txt.length <= 120) items.push({ letter: it.letter, text: txt, el: parent });
      });
      const g = groupConsecutive(items);
      if (g && (!best2 || g.length > best2.length)) best2 = g;
    });
    if (best2) return best2.map((it) => ({ el: it.el, text: it.text }));

    // 策略 3：重复的同级块（字母用图标 / CSS ::before 渲染，文本里根本没有字母）
    let best3 = null;
    docs.forEach((root) => {
      qsaIn(root, "div, ul, ol, tbody, section").forEach((box) => {
        if (isOurs(box)) return;
        const kids = box.children ? Array.from(box.children) : [];
        if (kids.length < 3 || kids.length > 10) return;
        const items = [];
        for (let i = 0; i < kids.length; i++) {
          const t = normText(kids[i].innerText || kids[i].textContent || "");
          if (!t || t.length > 60 || /^\d{1,3}$/.test(t)) { items.length = 0; break; }
          items.push({ el: kids[i], text: t });
        }
        if (items.length < 3) return;
        const ctx = normText(box.innerText || "") + " " +
          normText((box.parentElement && box.parentElement.innerText) || "");
        if (!/(单选题|多选题|判断题|选择题|（\s*）|\(\s*\))/.test(ctx)) return;
        if (!best3 || items.length > best3.length) best3 = items;
      });
    });
    if (best3) return best3.map((it) => ({ el: it.el, text: it.text }));

    return [];
  }

  // 清理题干：去掉题型分值前缀、题号、尾部残留字母
  function cleanStem(t) {
    let s = normText(t);
    s = s.replace(/(单选题|多选题|判断题|填空题|简答题|论述题|材料分析题)\s*[（(]\s*\d+(?:\.\d+)?\s*分\s*[）)]/g, " ");
    s = s.replace(/^(单选题|多选题|判断题|填空题|简答题|论述题|材料分析题)\s*/, "");
    s = s.replace(/^\s*\d{1,3}\s*[.、)）]\s*/, "");
    s = s.replace(/(?:\s+[A-H]\s*[.、,，)）:：]?)+\s*$/, " ");
    return normText(s);
  }

  // 题干：从第一个选项往上，用「第一个选项文字」把容器文本切开，前半段就是题干
  function stemFromOption(firstEl, optTexts) {
    const first = (optTexts[0] || "").slice(0, 40);
    let node = firstEl && firstEl.parentElement;
    for (let i = 0; i < 6 && node; i++) {
      const full = normText(node.innerText || "");
      if (full) {
        let cut = first ? full.indexOf(first) : -1;
        if (cut < 0) {
          const mm = full.match(/(?:^|\s)A\s*[.、,，)）:：]/);
          if (mm) cut = mm.index;
        }
        if (cut > 0) {
          const cand = cleanStem(full.slice(0, cut));
          if (cand.length >= 6 && cand.length <= 400) return cand;
        }
      }
      node = node.parentElement;
    }
    return "";
  }

  // 兜底：找「（ ）/？/下列…」这种像题干的短句，并排除导航词
  function stemByHeuristics(roots) {
    const cands = [];
    (roots || [document]).forEach((root) => {
      qsaIn(root, "h1, h2, h3, h4, p, div, span, section, article, [class*=stem], [class*=subject], [class*=question], [class*=title]").forEach((el) => {
        if (isOurs(el) || isDecoy(el)) return;
        if (el.children && el.children.length > 2) return;
        const t = normText(el.innerText || "");
        if (t.length < 8 || t.length > 300) return;
        if (NAV_WORDS.test(t)) return;
        if (looksLikeDirectory(t)) return;
        let score = 0;
        if (/[（(]\s*[）)]/.test(t)) score += 3;
        if (/[？?]\s*$/.test(t)) score += 2;
        if (/(下列|以下|哪项|哪个|哪一项|正确|错误|属于|不属于|特点|原因|意义)/.test(t)) score += 2;
        if (score > 0) cands.push({ t, score, len: t.length });
      });
    });
    cands.sort((a, b) => b.score - a.score || a.len - b.len);
    return cands.length ? cands[0].t : "";
  }

  // 题型识别：先看选项控件（radio=单选 / checkbox=多选），再看页面上的题型文字
  function detectQType(roots) {
    let hasCheck = false, hasRadio = false;
    roots.forEach((root) => {
      qsaIn(root, 'input[type="checkbox"], [role="checkbox"], [class*="checkbox"], [class*="CheckBox"]')
        .forEach((el) => { if (!isOurs(el) && isVisible(el)) hasCheck = true; });
      qsaIn(root, 'input[type="radio"], [role="radio"], [class*="radio"], [class*="Radio"]')
        .forEach((el) => { if (!isOurs(el) && isVisible(el)) hasRadio = true; });
    });
    if (hasCheck !== hasRadio) return hasCheck ? "multi" : "single";
    let text = "";
    roots.forEach((root) => {
      try {
        const node = root.body || root.documentElement || root;
        text += " " + (node.innerText || node.textContent || "");
      } catch (e) { /* 跨域 frame */ }
    });
    text = text.slice(0, 6000);
    if (/多选题|多项选择|不定项|可多选|至少有两个|有两个以上/.test(text)) return "multi";
    if (/单选题|单项选择/.test(text)) return "single";
    return "unknown";
  }

  // 判断题：恰好两个选项，且文字是对/错、正确/错误、√/×、T/F 这类「二选一」形态
  const JUDGE_RE = /^(正确|错误|对的|错的|对|错|是|否|true|false|√|×|✓|✗|t|f|right|wrong|正确与否)$/i;
  function looksJudge(options) {
    if (!options || options.length !== 2) return false;
    return options.every((o) => JUDGE_RE.test(String(o || "").trim()));
  }

  // 课程目录 / 导航文字的特征：同一段里出现多次「视频」「第N节」，或含「完成度 42%」之类。
  // 这类文字绝不能当题干——雨课堂外层页面左侧目录最容易被误抓成题干。
  function looksLikeDirectory(t) {
    const s = normText(t || "");
    if (!s) return false;
    const v = (s.match(/视频/g) || []).length;
    const c = (s.match(/第[一二三四五六七八九十百]+节/g) || []).length;
    if (v >= 2 || c >= 2) return true;
    if (/完成度\s*\d/.test(s) && /(目录|作业|视频)/.test(s)) return true;
    if (/^\s*目录\b/.test(s) && v >= 1) return true;
    return false;
  }

  // 给每个 root 打「像不像题目」的分：真题目有 problem-body / 加密字体 / 选项控件 / 题型文字；
  // 外层目录则扣分。据此只保留最像题目的那一层，避免外层目录和内层题目混抓。
  function rootScore(root) {
    let s = 0;
    try {
      const enc = qsaIn(root, '[class*="encrypted-font"],[class*="problem-body"],[class*="problemBody"],[class*="problem_stem"],[class*="stem"],[class*="subject"],[class*="question-title"],[class*="questionTitle"]');
      let vis = 0;
      enc.forEach((el) => { if (!isOurs(el) && !isDecoy(el) && isVisible(el)) vis++; });
      s += Math.min(vis, 10) * 3;
      let inputs = 0;
      qsaIn(root, 'input[type="radio"], input[type="checkbox"]').forEach((el) => {
        if (!isOurs(el) && !isDecoy(el) && isVisible(el)) inputs++;
      });
      s += Math.min(inputs, 8) * 2;
      const txt = normText((root.body && root.body.innerText) || (root.documentElement && root.documentElement.innerText) || "");
      if (/(单选题|多选题|判断题|单项选择题|多项选择题)/.test(txt)) s += 4;
      const vcount = (txt.match(/视频/g) || []).length;
      const ccount = (txt.match(/第[一二三四五六七八九十百]+节/g) || []).length;
      if (vcount >= 3 || ccount >= 3) s -= 20;
      if (/完成度\s*\d/.test(txt)) s -= 6;
      if (/目录/.test(txt) && vcount >= 2) s -= 8;
    } catch (e) { /* 跨域 frame 读不到就按 0 分 */ }
    return s;
  }

  function pickQuestionRoots(roots) {
    if (!roots || roots.length <= 1) return roots || [document];
    const scored = roots.map((r) => ({ r, s: rootScore(r) })).sort((a, b) => b.s - a.s);
    const best = scored[0];
    if (best.s >= 6) {
      // 只保留最高分层（同分一起保留），把外层目录挡在外面
      return scored.filter((x) => x.s === best.s && x.s >= 6).map((x) => x.r);
    }
    return roots;
  }

  // 优先从明确的题干容器取题干（problem-body / stem / subject / question-title …）。
  // 雨课堂的题干就在 iframe 的 .problem-body 里，直接取比「从选项反向切分」稳得多。
  function stemFromContainers(roots) {
    // 先找最具体的题干容器（雨课堂的 .problem-body），找不到再用较通用的 class。
    // 按「优先级分组」取值，避免某个超大的通用容器把整页文字当成题干。
    const groups = [
      ['[class*="problem-body"]', '[class*="problemBody"]', '[class*="problem_stem"]'],
      ['[class*="question-title"]', '[class*="questionTitle"]', '[class*="question-content"]',
       '[class*="questionContent"]', '[class*="stem"]', '[class*="subject"]'],
    ];
    for (let gi = 0; gi < groups.length; gi++) {
      let best = null;
      (roots || [document]).forEach((root) => {
        groups[gi].forEach((sel) => {
          qsaIn(root, sel).forEach((el) => {
            if (isOurs(el) || isDecoy(el) || !isVisible(el)) return;
            let t = normText(el.innerText || "");
            if (!t) return;
            t = cleanStem(t);
            if (t.length < 6 || t.length > 500) return;
            if (looksLikeDirectory(t)) return;
            if (!best || t.length > best.text.length) best = { el, text: t };
          });
        });
      });
      if (best) return best;
    }
    return null;
  }

  // 抓取题目与选项
  function extractQuestion() {
    // 只保留最像「题目」的那一层 root，避免把外层课程目录当成题干
    const roots = pickQuestionRoots(collectRoots());
    const optionEls = [];
    const seen = new Set();
    const push = (el, text) => {
      if (!el || seen.has(el) || isOurs(el) || isDecoy(el)) return;
      let t = normText(text || el.innerText || "");
      t = t.replace(/^[A-Ha-h]\s*[.．、,，)）:：]?\s+/, ""); // 去掉选项前的字母（如 "A 综合性"）
      // 判断题图标型选项（√/×）或纯图标 label：没文字时，从 input 的 value/aria/title 兜底
      if (!t) {
        const inp = (el.matches && el.matches("input")) ? el
          : (el.querySelector ? el.querySelector("input") : null);
        if (inp) t = inp.getAttribute("value") || inp.getAttribute("aria-label") || inp.getAttribute("title") || "";
        if (!t) t = el.getAttribute("aria-label") || el.getAttribute("title") || "";
      }
      if (!t || t.length > 200) return;
      seen.add(el);
      optionEls.push({ el: el.closest("label") || el, text: t });
    };

    // 1) 单选/复选框（排除插件自己的面板）
    roots.forEach((root) => {
      qsaIn(root, 'input[type="radio"], input[type="checkbox"]').forEach((inp) => {
        if (isOurs(inp) || isDecoy(inp)) return;
        const doc = inp.ownerDocument || document;
        let label = inp.id && doc.querySelector ? doc.querySelector(`label[for="${cssEscape(inp.id)}"]`) : null;
        if (!label) {
          let p = inp.parentElement;
          while (p && p.tagName !== "LABEL") p = p.parentElement;
          label = p;
        }
        // innerText 对纯图标选项会是空：再用 textContent（含视觉隐藏文字）兜底
        const text = label ? (label.innerText || label.textContent || "") : (inp.nextSibling ? inp.nextSibling.textContent : "");
        push(label || inp, text);
      });
    });
    if (optionEls.length < 2) optionEls.length = 0;

    // 2) 字母分组（两套策略）
    if (!optionEls.length) findOptionsByLetters(roots).forEach((o) => push(o.el, o.text));

    // 2.5) 清理：去掉“只有一个字母”的残留（常见于字母标记被单独抓成一项），并去重
    if (optionEls.length > 2) {
      let keep = optionEls.filter((o) => !/^[A-Ha-h]$/.test(o.text.trim()));
      if (keep.length >= 2) { optionEls.length = 0; keep.forEach((o) => optionEls.push(o)); }
      const seenT = new Set();
      keep = optionEls.filter((o) => { const k = o.text.trim(); if (seenT.has(k)) return false; seenT.add(k); return true; });
      if (keep.length >= 2 && keep.length < optionEls.length) { optionEls.length = 0; keep.forEach((o) => optionEls.push(o)); }
    }

    // 3) 题干：优先明确的题干容器（problem-body / stem / subject），再退回「从选项反向切分」
    let qElFound = null;
    let question = "";
    const stem = stemFromContainers(roots);
    if (stem && stem.el) { qElFound = stem.el; question = stem.text; }
    if (!question && optionEls.length) {
      question = stemFromOption(optionEls[0].el, optionEls.map((o) => o.text));
    }

    // 4) 兜底
    if (!question || question.length < 5) question = stemByHeuristics(roots) || question;
    // 抓成课程目录 / 导航文字 → 视为「没识别到」，绝不当题干用
    if (looksLikeDirectory(question)) { question = ""; qElFound = null; }

    return {
      question: question.trim().slice(0, 800),
      options: optionEls.map((o) => o.text),
      _els: optionEls.map((o) => o.el),
      _qEl: qElFound,
      qtype: (() => {
        const qt = detectQType(roots);
        if ((qt === "single" || qt === "unknown") && looksJudge(optionEls.map((o) => o.text))) return "judge";
        return qt;
      })(),
    };
  }

  // 跨主文档 / 同源 iframe / shadow DOM 查询（雨课堂题目和按钮都在 iframe 里）
  function qsaAll(sel) {
    const out = [];
    for (const root of collectRoots()) {
      try { out.push(...root.querySelectorAll(sel)); } catch (e) { /* 忽略读不到的 root */ }
    }
    return out;
  }

  function isDisabledEl(el) {
    try {
      if (el.disabled || el.getAttribute("aria-disabled") === "true") return true;
      const cls = " " + String(el.className || "") + " ";
      if (/ (is-disabled|disabled) /.test(cls)) return true;
      const pcls = " " + String((el.parentElement && el.parentElement.className) || "") + " ";
      if (/ (is-disabled|disabled) /.test(pcls)) return true;
    } catch (e) { /* noop */ }
    return false;
  }

  // 左侧/顶部题号导航：找到当前高亮的题号，返回它的下一个
  function findNextNumberNav() {
    const items = [];
    qsaAll("div, span, li, button, a").forEach((el) => {
      if (isOurs(el) || isDecoy(el)) return;
      if (el.children && el.children.length > 0) return;
      const t = (el.innerText || "").trim();
      if (!/^\d{1,3}$/.test(t)) return;
      if (!isVisible(el)) return;
      items.push({ n: parseInt(t, 10), el });
    });
    if (items.length < 2) return null;

    const byNum = new Map();
    items.forEach((it) => {
      if (!byNum.has(it.n)) byNum.set(it.n, []);
      byNum.get(it.n).push(it.el);
    });
    const nums = [...byNum.keys()].sort((a, b) => a - b);
    if (nums.length < 2) return null;

    let activeNum = null;
    nums.forEach((n) => {
      if (activeNum !== null) return;
      byNum.get(n).some((el) => {
        const cls = String(el.className || "") + " " + String((el.parentElement && el.parentElement.className) || "");
        if (/(active|current|selected|checked|highlight)/i.test(cls)) { activeNum = n; return true; }
        return false;
      });
    });
    if (activeNum === null) return null;

    const idx = nums.indexOf(activeNum);
    const nextNum = nums[idx + 1];
    if (nextNum === undefined) return null;
    const target = byNum.get(nextNum)[0];
    return target.closest("button, li, a, [role=button]") || target.parentElement || target;
  }

  function findNextButton(preferDoc) {
    const list = qsaAll("button, a, [role=button], input[type=submit], [class*=btn], [class*=arrow], [class*=next]")
      .filter((el) => !isOurs(el) && !isDecoy(el) && isVisible(el) && !isDisabledEl(el));
    const textOf = (el) => normText(el.innerText || el.value || el.getAttribute("aria-label") || "");
    const notDiv = (el) => el && el.tagName !== "DIV" && el.tagName !== "SPAN";
    // 题目在 iframe 里时，优先用同一文档的按钮，避免点到外层的「下一个知识点」
    const rank = (el) => (preferDoc && el.ownerDocument === preferDoc ? 0 : 1);
    const byRank = (a, b) => rank(a) - rank(b);

    // 1) 明确的「下一题/下一页」
    const exact = list
      .filter((b) => notDiv(b) && /^(下一题|下一道|下一页|继续|next|next question)$/i.test(textOf(b)))
      .sort(byRank);
    if (exact.length) return exact[0];

    // 2) aria-label / title / class 提示
    let el = list.filter((b) => {
      const s = [b.getAttribute("aria-label"), b.getAttribute("title"), String(b.className || "")].filter(Boolean).join(" ");
      return /(下一题|下一页|next|arrow-right|right-arrow|next-btn|next-question)/i.test(s) && !/prev|left|上一/i.test(s);
    }).sort(byRank)[0];
    if (el) return el;

    // 3) 题号导航（雨课堂作业：左侧 1/2/3…）
    const nav = findNextNumberNav();
    if (nav) return nav;

    // 4) 箭头字符
    el = list.filter((b) => /^[›>＞»→]$/.test(textOf(b))).sort(byRank)[0];
    if (el) return el;

    // 禁用/消失的「下一题」视为结尾，绝不再拿「提交」兜底，避免误交卷
    return null;
  }

  // 当前题目是否已勾选了至少一个选项（用于决定能否安全点「提交」）
  function hasSelection() {
    if (!current || !current._els) return false;
    return current._els.some((el) => {
      const inp = (el.querySelector && el.querySelector("input")) ||
                  (el.matches && el.matches("input") ? el : null);
      if (inp) return !!inp.checked;
      return el.classList.contains("is-checked") || el.getAttribute("aria-checked") === "true";
    });
  }

  // 有些平台（部分作业 / 测验）没有「下一题」，而是选完选项后点「提交」本题即跳到下一页。
  // 这里的「提交」是「提交本题 / 提交答案」，和「交卷 / 提交试卷」那种最终提交不是一回事，
  // 必须严格区分——名单里的危险词永远不碰，防止提前交卷。
  const DANGEROUS_SUBMIT = /(交卷|交卷并|提交试卷|提交全部|提交并交卷|提交并结束|结束.*提交|最终提交|完成所有|全部提交|提交并查看成绩|交卷查看|提交成绩)/;
  function findSubmitButton(preferDoc) {
    const list = qsaAll("button, a, [role=button], input[type=submit], [class*=btn]")
      .filter((el) => !isOurs(el) && isVisible(el) && !isDisabledEl(el));
    const textOf = (el) => normText(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "");
    const rank = (el) => (preferDoc && el.ownerDocument === preferDoc ? 0 : 1);
    const cand = list.filter((b) => {
      const t = textOf(b);
      if (DANGEROUS_SUBMIT.test(t)) return false;       // 最终交卷，永远不碰
      return /提交|递交|保存(本题|答案)?|提交本题|提交答案/.test(t) && !/下一|下一道|next/i.test(t);
    }).sort((a, b) => rank(a) - rank(b));
    return cand[0] || null;
  }

  function buildPanel() {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);

    const panel = document.createElement("div");
    panel.id = "qa-panel";
    panel.innerHTML = `
      <header>答题学习助手 <button id="qa-close" title="关闭">×</button></header>
      <div class="body">
        <div class="row">
          <label style="margin:0">题干（可编辑）</label>
          <span class="count" id="qa-count">已整理 0 题</span>
        </div>
        <textarea id="qa-q"></textarea>
        <label>选项（可编辑 / 删除）</label>
        <div id="qa-opts"></div>
        <div class="opt-toggle">题型 <select id="qa-qtype" style="padding:3px 6px;border:1px solid #cbd5e1;border-radius:6px">
          <option value="auto">自动识别</option><option value="single">单选题</option><option value="multi">多选题</option><option value="judge">判断题</option>
        </select> <span style="color:#94a3b8">识别不准可手动指定</span></div>
        <div class="opt-toggle"><label><input type="checkbox" id="qa-auto"> 自动模式：逐题找答案并自动翻页（不替你勾选选项）</label></div>
        <div class="opt-toggle" style="color:#64748b">自动点「下一题」翻页，你只管勾选选项并点「提交」（若平台需要）；点「查看汇总」或刷完自动导出时立刻关闭自动模式，下一轮请手动勾选。速度/准确率优先、花费最低。</div>
        <div class="actions">
          <button class="ghost" id="qa-re" title="清空上一轮汇总，从当前题重新记">重新抓取</button>
          <button class="primary" id="qa-solve">查找答案</button>
        </div>
        <div class="actions">
          <button class="ghost" id="qa-export" title="生成汇总并立刻关闭自动模式">查看汇总</button>
          <button class="ghost" id="qa-undo" style="display:none">撤销清空</button>
          <button class="ghost" id="qa-diag">诊断结构</button>
        </div>
        <div class="actions">
          <button class="ghost" id="qa-check">夸克核对（复制本题）</button>
        </div>
        <div class="status" id="qa-status"></div>
        <div class="result" id="qa-result" style="display:none"></div>
      </div>`;
    document.body.appendChild(panel);

    const qEl = panel.querySelector("#qa-q");
    const optsEl = panel.querySelector("#qa-opts");
    const statusEl = panel.querySelector("#qa-status");
    const resultEl = panel.querySelector("#qa-result");
    const countEl = panel.querySelector("#qa-count");
    const autoEl = panel.querySelector("#qa-auto");
    const qtypeEl = panel.querySelector("#qa-qtype");
    const stayEl = panel.querySelector("#qa-stay");
    const undoEl = panel.querySelector("#qa-undo");

    // 会话级状态
    const sessionLog = [];
    let currentEntry = null;
    let currentReportMd = "";   // 最近一次生成的汇总，供「复制汇总文本」使用
    let autoMode = false;        // 用户是否希望自动作答（意图，跨页面持久化）
    let autoRunning = false;     // 本面板里的自动流程是否在跑
    let runToken = 0;            // 只允许一条自动流程链，重新启动时旧链立即失效
    let lastSolveFail = "";      // 上一次 runSolve 失败的原因：noopts / noquestion / neterr
    let undoSnapshot = null;     // 清空汇总前的快照，供「撤销清空」还原
    let logEpoch = 0;            // 汇总版本号：清空/撤销时 +1，让作废的请求结果不再写回
    let current = { question: "", options: [], _els: [] };

    // 加密字体：DOM 里是假字。向后端要一次「假字→真字」映射，之后本地复用，
    // 这样面板一抓到题就显示正常中文，不必等点「查找答案」。
    let decodeMap = {};
    let decodePromise = null;
    let decodeInfo = null;
    const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

    function mapText(s) {
      if (!s || !Object.keys(decodeMap).length) return s;
      let out = "";
      for (const ch of s) out += hasOwn(decodeMap, ch) ? decodeMap[ch] : ch;
      return out;
    }

    function unknownRatio(s) {
      let cjk = 0, miss = 0;
      for (const ch of s || "") {
        if (!/[\u3400-\u9fff]/.test(ch)) continue;
        cjk++;
        if (!hasOwn(decodeMap, ch)) miss++;
      }
      return cjk ? miss / cjk : 0;
    }

    // —— 加密文字：只有真的套了加密字体的文本节点才允许还原 ——
    // 雨课堂把加密字放在 <span class="xuetangx-com-encrypted-font"> 里（computed font-family
    // 含 exam-data-decrypt-font），同一句里的其它字是**正常文字**。
    // 之前把整段文字都套映射：正常字只要恰好也是映射表的 key 就被换成别的字
    // → 面板显示“阴束时…”这类乱码，模型拿乱码答题，答案自然是错的。
    const ENC_NAME_RE = /(encrypted|encrypt|decrypt|exam-data|comprest|obfuscat|glyph-map|cipher)/i;

    function isEncElement(el) {
      try {
        if (!el || el.nodeType !== 1) return false;
        const cls = String(el.className || "") + " " + String(el.id || "");
        if (ENC_NAME_RE.test(cls)) return true;
        const doc = el.ownerDocument || document;
        const win = doc.defaultView || window;
        const fam = String((win.getComputedStyle(el) || {}).fontFamily || "");
        return ENC_NAME_RE.test(fam);
      } catch (e) { return false; }
    }

    function encAncestorOf(node) {
      let el = (node && node.nodeType === 3) ? node.parentElement : node;
      for (let i = 0; el && i < 15; i++, el = el.parentElement) {
        if (isEncElement(el)) return el;
      }
      return null;
    }

    function isTextHidden(el) {
      try {
        const doc = el.ownerDocument || document;
        const win = doc.defaultView || window;
        const cs = win.getComputedStyle(el);
        return cs.display === "none" || cs.visibility === "hidden";
      } catch (e) { return false; }
    }

    // 按文本节点切开：加密节点套映射，正常节点原样保留。
    // 返回 raw（DOM 原文）、text（真字）、encNodes / encChars / encMiss（还原质量指标）。
    function decodeElementText(el) {
      const res = { raw: "", text: "", encNodes: 0, encChars: 0, encMiss: 0, segs: [] };
      if (!el) return res;
      const doc = el.ownerDocument || document;
      const win = doc.defaultView || window;
      let walker = null;
      try {
        const NF = win.NodeFilter || { SHOW_TEXT: 4 };
        walker = doc.createTreeWalker(el, NF.SHOW_TEXT, null);
      } catch (e) { return res; }
      const hiddenMemo = new Map();
      const hiddenEl = (e) => {
        if (!e || e === el || !e.parentElement) return false;
        if (hiddenMemo.has(e)) return hiddenMemo.get(e);
        const tag = String(e.tagName || "").toUpperCase();
        const v = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(tag) ||
          isOurs(e) || isTextHidden(e) || hiddenEl(e.parentElement);
        hiddenMemo.set(e, v);
        return v;
      };
      const countable = (ch) => !/[\s，。、；：？！,.;:!?()（）\[\]【】"'“”‘’\-—_/\\|<>《》]/.test(ch);
      let n;
      while ((n = walker.nextNode())) {
        if (hiddenEl(n.parentElement)) continue;
        const t = n.nodeValue || "";
        if (!t) continue;
        res.raw += t;
        if (encAncestorOf(n)) {
          res.encNodes++;
          for (const ch of t) {
            if (!countable(ch)) continue;
            res.encChars++;
            if (!hasOwn(decodeMap, ch)) res.encMiss++;
          }
          res.segs.push(t);
          res.text += mapText(t);
        } else {
          res.text += t;      // 正常文字：绝不套映射
        }
      }
      return res;
    }

    // segs = 只包含「真的套了加密字体的文本节点」。绝不能把整段文字塞进来：
    // 正常字会被当成密文字一起建映射，映射再套回正常字就变成乱码。
    async function ensureDecodeMap(segs) {
      const texts = (segs || []).map((t) => String(t || "")).filter((t) => /[^\s]/.test(t));
      if (!texts.length) return false;
      const need = !Object.keys(decodeMap).length || texts.some((t) => unknownRatio(t) > 0.2);
      if (!need) return true;
      if (decodePromise) return decodePromise;
      decodePromise = (async () => {
        let fontB64 = "";
        try { fontB64 = await getFontB64(); } catch (e) { /* 没取到字体就保持原文 */ }
        if (!fontB64) return false;
        const resp = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: "decode", payload: { font_b64: fontB64, texts } }, (r) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(r);
          });
        });
        if (!resp || !resp.ok || !resp.mapping || !Object.keys(resp.mapping || {}).length) return false;
        Object.assign(decodeMap, resp.mapping);
        decodeInfo = resp.info || null;
        return true;
      })().catch(() => false).finally(() => { decodePromise = null; });
      return decodePromise;
    }

    // 返回 true = 文字已就绪（明文 或 已成功还原），可以作答；false = 还没还原好。
    async function decodeCurrent(allowRetry = true) {
      maybeInvalidateFont();   // 换题换了字体 → 旧映射会把字整体解错，先作废重取
      const optEls = (current._els || []).slice();
      // 1) 先分清：哪些文本节点真的套了加密字体（第一次 walk 只为定位密文，映射可能还没建好）
      const qProbe = current._qEl ? decodeElementText(current._qEl) : null;
      const optProbe = optEls.map((el) => (el ? decodeElementText(el) : null));
      const encNodes = (qProbe ? qProbe.encNodes : 0) +
        optProbe.reduce((a, b) => a + (b ? b.encNodes : 0), 0);
      current.encrypted = encNodes > 0;
      current.decodeFail = "";

      // 题干容器没定位到（走了兜底抽取），但页面上确实有加密文字：
      // 这时无法确认哪几个字是密文，宁可停下也不把密文当正常字发给模型。
      if (!current.encrypted && !current._qEl) {
        let anyEnc = false;
        try {
          anyEnc = qsaAll('[class*="encrypted"],[class*="decrypt"]')
            .some((el) => !isOurs(el) && !isDecoy(el));
        } catch (e) { anyEnc = false; }
        if (anyEnc) {
          current.encrypted = true;
          current.decoded = false;
          current.decodeFail = "页面有加密文字，但没定位到题干容器（无法确认哪些字是密文），先不解题。";
          return false;
        }
      }

      if (!current.encrypted) {
        // 明文题：一个字都不许动（套映射就会变乱码），直接可用
        current.plain = true;
        current.decoded = true;
        return true;
      }
      current.plain = false;

      // 2) 只拿密文节点去建映射
      const segs = [];
      if (qProbe) segs.push(...qProbe.segs);
      optProbe.forEach((o) => { if (o) segs.push(...o.segs); });
      const ok = await ensureDecodeMap(segs);
      if (!ok) {
        current.decoded = false;
        current.decodeFail = "页面加密字体没取到（或解码服务不可用），先把题目暂停，不拿乱码去作答。";
        return false;
      }

      // 3) 映射就绪后用同一套节点切分正式还原（encMiss 这时才有意义）
      const qInfo = decodeElementText(current._qEl);
      const optInfos = optEls.map((el) => (el ? decodeElementText(el) : null));
      const encChars = qInfo.encChars + optInfos.reduce((a, b) => a + (b ? b.encChars : 0), 0);
      const encMiss = qInfo.encMiss + optInfos.reduce((a, b) => a + (b ? b.encMiss : 0), 0);
      const missRatio = encChars ? encMiss / encChars : 1;
      const avg = (decodeInfo && Number(decodeInfo.avg_score)) || 0;
      // 密文字没认全 / 字体整体相似度太低 → 判定「没还原成功」，宁可停下也不作答
      if (!encChars || missRatio > 0.2 || (avg && avg < 0.85)) {
        current.decoded = false;
        current.decodeFail = `页面加密文字没还原出来（${Math.round(missRatio * 100)}% 的密文字没认出来`
          + (avg ? `，字体相似度 ${avg}` : "") + "），已暂停，绝不用乱码答题。"
          + "可刷新页面后点「重新抓取」重试。";
        // 换题换了字体时旧映射会整体解错：作废旧字体/映射再试一次
        if (allowRetry) {
          invalidateFont();
          return decodeCurrent(false);
        }
        return false;
      }

      // 4) 写回面板：题干/选项都用真字
      const qText = cleanStem(normText(qInfo.text)) || current.question;
      const optTexts = optInfos.map((o, i) => {
        let t = normText(o ? o.text : "");
        t = t.replace(/^[A-Ha-h]\s*[.．、,，)）:：]?\s+/, "");   // 去掉选项前的字母（如 "A 综合性"）
        return t || (current.rawOptions[i] || current.options[i] || "");
      });
      const changed = (qText !== current.question) ||
        (optTexts.join("\u0001") !== (current.options || []).join("\u0001"));
      current.question = qText;
      current.options = optTexts;
      current.decoded = true;
      current.edited = false;
      qEl.value = qText;
      renderOptions();
      return true;
    }

    function updateCount() { countEl.textContent = `已整理 ${sessionLog.length} 题`; }

    // —— 清空汇总（点「重新抓取」或手动勾选「自动模式」时）——
    // 之前的记录整份作废（可撤销），汇总从当前这一轮重新开始累加。
    function resetSummary() {
      const n = sessionLog.length;
      if (!n) return 0;
      undoSnapshot = { log: sessionLog.slice(), ts: Date.now() };
      logEpoch++;
      sessionLog.length = 0;
      currentEntry = null;
      currentReportMd = "";
      resultEl.style.display = "none";
      resultEl.innerHTML = "";
      undoEl.style.display = "";
      updateCount();
      saveAutoState();
      return n;
    }

    // 撤销：把清空前的整份汇总放回去；若自动流程正在跑，先停下，避免新题混进旧汇总
    function undoReset() {
      if (!undoSnapshot) return;
      const n = undoSnapshot.log.length;
      const wasRunning = autoRunning;
      if (wasRunning) pauseAuto("", false);
      logEpoch++;
      sessionLog.length = 0;
      undoSnapshot.log.forEach((x) => sessionLog.push(x));
      undoSnapshot = null;
      undoEl.style.display = "none";
      currentEntry = null;
      updateCount();
      saveAutoState();
      statusEl.textContent = `已恢复之前的汇总（共 ${n} 题）`
        + (wasRunning ? "；自动模式已停止，需要时重新勾选。" : "。");
    }

    // —— 自动模式进度持久化：后端断线/页面刷新后能自动续跑 ——
    const QA_STATE_KEY = "qaAutoState";
    const storageGet = (key) => new Promise((resolve) => {
      try { chrome.storage.local.get(key, (d) => resolve(d || {})); } catch (e) { resolve({}); }
    });
    const storageSet = (obj) => new Promise((resolve) => {
      try { chrome.storage.local.set(obj, () => resolve()); } catch (e) { resolve(); }
    });
    const storageRemove = (key) => new Promise((resolve) => {
      try { chrome.storage.local.remove(key, () => resolve()); } catch (e) { resolve(); }
    });

    async function saveAutoState(extra) {
      try {
        await storageSet({ [QA_STATE_KEY]: Object.assign({
          active: autoMode && autoRunning,
          ts: Date.now(),
          sessionLog: sessionLog.slice(),
          lastRaw: current.rawQuestion || current.question || "",
          lastText: current.question || "",
          stay: stayEl ? stayEl.value : 0,
          qtype: qtypeEl.value,
          url: location.href,
        }, extra || {}) });
      } catch (e) { /* storage 不可用时忽略，不影响做题 */ }
    }

    function clearAutoState() { storageRemove(QA_STATE_KEY); }

    // 自动模式「开关意图」单独存一份：新开标签页 / 重新注入面板时，面板是全新实例，
    // 光靠 qaAutoState 恢复不了勾选状态，用户就会觉得“新页面不自动翻页”。
    const QA_INTENT_KEY = "qaAutoEnabled";
    const siteHost = () => { try { return location.hostname || ""; } catch (e) { return ""; } };
    async function setAutoIntent(on) {
      try {
        await storageSet({ [QA_INTENT_KEY]: { on: !!on, host: siteHost(), ts: Date.now() } });
      } catch (e) { /* ignore */ }
    }
    async function getAutoIntent() {
      try {
        const v = (await storageGet(QA_INTENT_KEY))[QA_INTENT_KEY];
        if (!v) return false;
        if (typeof v === "object") return !!(v.on && v.host === siteHost());  // 只在本站点继续
        return !!v;
      } catch (e) { return false; }
    }

    async function restoreAuto() {
      let st, intent;
      try {
        st = (await storageGet(QA_STATE_KEY))[QA_STATE_KEY];
        intent = await getAutoIntent();
      } catch (e) { return; }

      // 只有同一个作业页（pathname 相同）才接上次的进度，换作业不串题
      let samePage = false;
      if (st && st.url) {
        try {
          const a = new URL(st.url).pathname, b = new URL(location.href).pathname;
          samePage = !!(a && b && a === b);
        } catch (e) { samePage = false; }
      }
      if (samePage && st && Array.isArray(st.sessionLog) && st.sessionLog.length) {
        sessionLog.length = 0;
        st.sessionLog.forEach((x) => sessionLog.push(x));
        updateCount();
        if (st.stay && stayEl) stayEl.value = st.stay;
        if (st.qtype) qtypeEl.value = st.qtype;
      }

      // 上次是“在跑”的状态，或者用户本来就开着自动模式（新开页面/新注入），都继续
      const wasRunning = samePage && st && st.active;
      if (!wasRunning && !intent) return;
      if (autoMode && autoRunning) return;   // 链接入口已经启动过，不重复

      autoMode = true; autoRunning = true; autoEl.checked = true;
      const done = alreadyLogged();
      statusEl.textContent = done
        ? `已恢复自动模式：本题已整理，继续翻页（共 ${sessionLog.length} 题）…`
        : `已恢复自动模式（已整理 ${sessionLog.length} 题），继续作答…`;
      startAuto(350);
    }

    function renderOptions() {
      optsEl.innerHTML = "";
      current.options.forEach((text, i) => {
        const row = document.createElement("div");
        row.className = "opt";
        row.innerHTML = `<input type="text" value="${text.replace(/"/g, "&quot;")}" data-i="${i}"><button class="del" data-i="${i}">×</button>`;
        optsEl.appendChild(row);
      });
      optsEl.querySelectorAll("input[type=text]").forEach((inp) => {
        inp.addEventListener("input", (e) => {
          current.options[+e.target.dataset.i] = e.target.value;
          current.edited = true;   // 用户改过，就按明文作答，不再送进字体解码
        });
      });
      optsEl.querySelectorAll(".del").forEach((b) => {
        b.addEventListener("click", (e) => {
          const i = +e.target.dataset.i;
          current.edited = true;
          current.options.splice(i, 1);
          if (current._els[i]) current._els[i].classList.remove("qa-suggested");
          current._els.splice(i, 1);
          renderOptions();
        });
      });
    }

    function clearHighlights() { current._els.forEach((el) => el && el.classList.remove("qa-suggested")); }

    // rawQuestion/rawOptions 始终是页面 DOM 原文（假字），用于送后端解码和判断翻页；
    // question/options 是面板显示的真字。两者分开才不会把真字二次解码。
    async function applyCurrent(ex) {
      clearHighlights();
      current = {
        question: ex.question || "",
        options: (ex.options || []).slice(),
        _els: (ex._els || []).slice(),
        _qEl: ex._qEl || null,          // 题干容器：按文本节点判断哪几个字是加密的
        rawQuestion: ex.question || "",
        rawOptions: (ex.options || []).slice(),
        qtype: ex.qtype || "unknown",
        decoded: false,                 // 文字是否已就绪（明文或还原成功）
        plain: false,                   // 本来就是明文，没有加密节点
        encrypted: false,               // 是否检测到加密字体节点
        decodeFail: "",                 // 没还原出来的原因（绝不带病作答）
        edited: false,
      };
      qEl.value = current.question;
      renderOptions();
      if (!Object.keys(decodeMap).length) statusEl.textContent = "正在还原页面加密文字…";
      await decodeCurrent();
    }

    // resume=true：兼容旧的续跑调用（现在按钮会顺手关掉自动模式，这里自然不会再跑）
    // fromButton=true：用户点了「重新抓取」→ 无条件清空旧汇总，并关闭自动模式等手动开启
    async function load(resume, fromButton) {
      invalidateFont();   // 重新抓取时强制重新发现字体和映射，避免用上一题的旧字体解错字
      await applyCurrent(extractQuestion());

      let note = "";
      if (fromButton) {
        // 点一次就清空：汇总只保留从当前题开始的这一轮（保留「撤销清空」兜底）。
        // 同时彻底关闭自动模式：不让它抓完又自动翻页，也不让它跨页面自己恢复。
        const n = sessionLog.length;
        if (n) resetSummary();
        stopAutoMode();
        note = n
          ? `已清空之前 ${n} 题，汇总从本题重新记；自动模式已关闭，下次请手动勾选（点「撤销清空」可恢复）。`
          : "汇总已是空的；自动模式已关闭，下次请手动勾选。";
      }

      const typeTag = current.qtype === "multi" ? "（多选）"
        : current.qtype === "single" ? "（单选）" : "";
      const weak = [...new Set([
        ...((decodeInfo && decodeInfo.low_conf) || []),
        ...((decodeInfo && decodeInfo.unresolved) || []),
      ])].filter(Boolean);
      const warn = weak.length
        ? ` 注意：${weak.length} 个字还原把握偏低（${weak.map(mapText).join("")}），点「查找答案」会自动校对文字。`
        : "";
      const base = (current.options.length
        ? (current.decoded
            ? (current.plain
                ? `已识别 ${current.options.length} 个选项${typeTag}（本题是明文，未做任何替换）。`
                : `已识别 ${current.options.length} 个选项${typeTag}，加密文字已还原成真字。`)
            : (current.decodeFail
                ? `已识别 ${current.options.length} 个选项${typeTag}，但${current.decodeFail}`
                : `已识别 ${current.options.length} 个选项${typeTag}，可修正后查找。`))
        : "未自动识别到选项，请手动填写。") + warn;
      statusEl.textContent = note ? `${note} ${base}` : base;

      // 加密文字没还原出来时，自动模式必须停在本题：不翻页、不拿乱码作答
      const blocked = !!(current.encrypted && !current.decoded);
      if (resume && autoMode) {
        if (blocked) {
          autoRunning = false;
          statusEl.textContent += " 自动模式已暂停（等文字还原成功再继续）。";
        } else {
          autoRunning = true;
          statusEl.textContent += " 自动模式继续…";
          startAuto(120);
        }
      }

      // 字体可能比题目晚到（新开页面常见）：第一次没解开就等 1.5 秒再试一次
      if (!current.decoded && current.options.length) {
        const wantRaw = current.rawQuestion || "";
        setTimeout(() => {
          if (current.decoded || current.edited) return;
          if ((current.rawQuestion || "") !== wantRaw) return;   // 已经换题了，别覆盖新题
          decodeCurrent().then((ok) => {
            if (!ok || current.edited) return;
            if (!autoRunning) {
              statusEl.textContent = current.plain
                ? `本题是明文，无需还原（${current.options.length} 个选项）。`
                : `已还原页面加密文字（${current.options.length} 个选项）。`;
            }
            // 刚才因为“没还原出来”暂停的自动模式，还原成功后自动接上
            if (autoMode && !autoRunning && current.decoded) {
              autoRunning = true;
              statusEl.textContent = "加密文字已还原，自动模式继续…";
              startAuto(200);
            }
          });
        }, 1500);
      }
    }

    // 记录用户手动点的选项（自动模式下通常不用，但保留以便手动补充）
    function bindOptionClicks() {
      current._els.forEach((el, idx) => {
        if (!el) return;
        el.addEventListener("click", () => {
          if (!currentEntry) return;
          const t = current.options[idx] || "";
          // 多选题会点多个选项，累积记录而不是互相覆盖
          const arr = currentEntry.pickedList || [];
          if (t && arr.indexOf(t) < 0) arr.push(t);
          currentEntry.pickedList = arr;
          currentEntry.picked = arr.join("；");
        });
      });
    }

    // 查一次答案：请求后端、展示、记入日志。返回 resp 或 null。
    // —— 加密字体（雨课堂 exam-data-decrypt-font / xuetangx-com-encrypted-font）——
    // 平台对题干和选项做了「字形重映射」：DOM 里的字是假字，只有用它的字体文件按字形反查才能还原。
    // 字体文件不一定能通过 @font-face 读到（常在跨域 CSS 里），所以要三路并行找。
    let fontB64Cache = "";
    let fontUrlCache = "";
    let fontPromise = null;
    let fontNotes = [];
    let fontHintsCache = null;

    // 换页/换作业可能换一份加密字体，旧映射会把字解错。点「重新抓取」时全部作废重取。
    function invalidateFont() {
      fontB64Cache = ""; fontUrlCache = ""; fontPromise = null;
      fontHintsCache = null; fontNotes = [];
      decodeMap = {}; decodeInfo = null; decodePromise = null;
    }

    // 雨课堂换题常换一份加密字体。用 performance 资源表零成本探测 URL，
    // 只有真的变了才作废旧字体/映射，避免每题都重新下载 675KB 字体拖慢速度。
    function currentFontUrlQuick() {
      try {
        const res = (performance && performance.getEntriesByType)
          ? performance.getEntriesByType("resource") : [];
        for (let i = res.length - 1; i >= 0; i--) {
          const n = String(res[i].name || "");
          if (/exam_font_[^/]*\.ttf/i.test(n)) return n.split("?")[0];
        }
      } catch (e) {}
      return "";
    }

    function maybeInvalidateFont() {
      const u = currentFontUrlQuick();
      if (u && fontUrlCache && u !== String(fontUrlCache).split("?")[0]) invalidateFont();
    }

    const FONT_EXT_RE = /\.(woff2?|ttf|otf)(\?|#|$)/i;

    function rootsWithWindow() {
      const out = [];
      collectRoots().forEach((root) => {
        let win = null;
        try {
          win = root.defaultView
            || (root.ownerDocument && root.ownerDocument.defaultView)
            || null;
        } catch (e) { win = null; }
        out.push({ root, win });
      });
      return out;
    }

    // 从一段 CSS 文本里抽出所有 @font-face（family + url）
    function parseFontFaces(css, baseUrl) {
      const out = [];
      const re = /@font-face\s*\{([^}]*)\}/gi;
      let m;
      while ((m = re.exec(String(css || "")))) {
        const block = m[1] || "";
        const fam = (block.match(/font-family\s*:\s*([^;]+)/i) || [])[1] || "";
        const u = block.match(/url\(\s*["']?([^"')]+)["']?\s*\)/i);
        if (!u) continue;
        let abs = u[1];
        try { abs = new URL(abs, baseUrl || location.href).href; } catch (e) { /* 保留原样 */ }
        out.push({ family: fam.replace(/["']/g, "").trim(), url: abs });
      }
      return out;
    }

    // 三路收集字体线索：可读样式表 / 跨域样式表地址 / 浏览器资源加载记录
    function collectFontHints() {
      if (fontHintsCache) return fontHintsCache;
      const hints = { faces: [], cssHrefs: [], resourceUrls: [], families: [], notes: [] };
      const seenCss = new Set();
      const seenRes = new Set();

      rootsWithWindow().forEach(({ root, win }) => {
        let sheets = [];
        try { sheets = Array.from(root.styleSheets || []); } catch (e) { sheets = []; }
        sheets.forEach((sh) => {
          let rules = null;
          try { rules = sh.cssRules; } catch (e) { rules = null; } // 跨域样式表会抛 SecurityError
          if (!rules) {
            if (sh.href && !seenCss.has(sh.href)) { seenCss.add(sh.href); hints.cssHrefs.push(sh.href); }
            return;
          }
          let cssText = "";
          try {
            cssText = Array.prototype.map.call(rules, (r) => (r && r.cssText) || "").join("\n");
          } catch (e) { return; }
          const base = sh.href || (win && win.location && win.location.href) || location.href;
          parseFontFaces(cssText, base).forEach((f) => hints.faces.push(f));
        });

        // 只能拿到族名，拿不到 src，但能确认「页面确实在用某个加密字体」
        try {
          const fs = (root.fonts || (win && win.document && win.document.fonts));
          if (fs && fs.forEach) fs.forEach((f) => hints.families.push(String(f.family || "").replace(/["']/g, "")));
        } catch (e) { /* ignore */ }

        // 字体一定是浏览器下载过的，资源时序里能拿到真实地址（跨域也能拿到 URL）
        try {
          const perf = win && win.performance;
          if (perf && perf.getEntriesByType) {
            perf.getEntriesByType("resource").forEach((en) => {
              const u = en && en.name;
              if (u && FONT_EXT_RE.test(u) && !seenRes.has(u)) { seenRes.add(u); hints.resourceUrls.push(u); }
            });
          }
        } catch (e) { /* ignore */ }

        qsaIn(root, 'link[as="font"], link[rel~="preload"][href*=".woff"]').forEach((l) => {
          const h = l.getAttribute("href");
          if (!h) return;
          let abs = h;
          try { abs = new URL(h, location.href).href; } catch (e) { /* keep */ }
          if (!seenRes.has(abs)) { seenRes.add(abs); hints.resourceUrls.push(abs); }
        });
      });

      hints.notes.push(`样式表可读 ${hints.faces.length} 条 @font-face / 跨域样式表 ${hints.cssHrefs.length} 个 / 资源里字体 ${hints.resourceUrls.length} 个`);
      fontHintsCache = hints;
      return hints;
    }

    // 给候选字体打分：名字像「加密/考卷字体」的优先，MathJax 之类公式字体直接排除
    function rankFontUrls(hints) {
      const out = [];
      const add = (url, score, why) => {
        if (!url || !/^(https?:|data:|blob:)/i.test(url)) return;
        // 有的字体地址没有扩展名（/api/font/xxx），所以名字里带 font/crypt/exam 也收
        const fontish = FONT_EXT_RE.test(url) || /crypt|encrypt|decrypt|exam|font/i.test(url);
        if (!fontish) return;
        const i = out.findIndex((s) => s.url === url);
        if (i >= 0) { if (score > out[i].score) { out[i].score = score; out[i].why = why; } return; }
        out.push({ url, score, why });
      };
      hints.faces.forEach((f) => {
        const key = (f.family + " " + f.url).toLowerCase();
        let s = 10;
        if (/crypt|exam|encrypt|decrypt|obfusc/.test(key)) s = 100;
        else if (/mathjax|katex|tex-|stix/.test(key)) s = -60;
        add(f.url, s, "font-face:" + (f.family || "?"));
      });
      hints.resourceUrls.forEach((u) => {
        const l = u.toLowerCase();
        let s = 6;
        if (/crypt|encrypt|decrypt|exam/.test(l)) s = 90;
        else if (/mathjax|katex|\/tex\/|stix/.test(l)) s = -60;
        add(u, s, "resource");
      });
      return out.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
    }

    function bgFetchFont(url) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "fetch_font", payload: { url } }, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: "无响应" });
        });
      });
    }

    function bgFetchText(url) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "fetch_text", payload: { url } }, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: "无响应" });
        });
      });
    }

    // blob: 地址只在页面上下文有效，后台取不到，这里本地兜底一次
    function localFetchFont(url) {
      return (async () => {
        try {
          const r = await fetch(url);
          const buf = await r.arrayBuffer();
          if (buf.byteLength > 4000000) return { ok: false, error: "字体过大 " + buf.byteLength };
          const bytes = new Uint8Array(buf);
          let magic = "";
          for (let i = 0; i < Math.min(4, bytes.length); i++) {
            const b = bytes[i];
            magic += b >= 32 && b < 127 ? String.fromCharCode(b) : b.toString(16).padStart(2, "0");
          }
          let bin = "";
          for (let i = 0; i < bytes.length; i += 8192) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
          }
          return { ok: true, b64: btoa(bin), url, size: buf.byteLength, magic };
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) };
        }
      })();
    }

    // 跨域样式表读不到 cssRules，就让后台把 CSS 文本抓回来再解析
    async function facesFromCrossOriginCss(hints) {
      const found = [];
      const limit = hints.cssHrefs.slice(0, 8);
      for (let i = 0; i < limit.length; i++) {
        const css = await bgFetchText(limit[i]);
        if (!css || !css.ok || !css.text) continue;
        parseFontFaces(css.text, limit[i]).forEach((f) => found.push(f));
      }
      if (found.length) hints.faces = hints.faces.concat(found);
      hints.notes.push(`跨域 CSS 解析出 ${found.length} 条 @font-face`);
      return found;
    }

    async function getFontB64() {
      if (fontB64Cache) return fontB64Cache;
      if (fontPromise) return fontPromise;
      const p = (async () => {
        fontNotes = [];
        const hints = collectFontHints();
        fontNotes.push(hints.notes[0] || "");

        let cands = rankFontUrls(hints);
        if (!cands.length && hints.cssHrefs.length) {
          await facesFromCrossOriginCss(hints);
          cands = rankFontUrls(hints);
        }

        fontNotes.push(cands.length
          ? `候选字体 ${cands.length} 个：` + cands.slice(0, 4).map((c) => c.why + "@" + c.score).join(" / ")
          : "没找到候选字体（页面可能还没渲染出加密文字）");

        for (let i = 0; i < cands.length && i < 6; i++) {
          let r = await bgFetchFont(cands[i].url);
          if (!r || !r.ok || !r.b64) {
            const local = await localFetchFont(cands[i].url);  // blob: 等只能页面内取
            if (local && local.ok) r = local;
          }
          if (!r || !r.ok || !r.b64) {
            fontNotes.push(`× ${cands[i].why}：${(r && r.error) || "取不到"}`);
            continue;
          }
          // 只接受真正的字体文件（wOF2 / wOFF / OTTO / 0x00010000 / true / ttcf）
          const magic = r.magic || "";
          if (magic && !/^(wOF2|wOFF|OTTO|true|ttcf|00010000)$/.test(magic)) {
            fontNotes.push(`× ${cands[i].why}：不是字体文件（${magic}）`);
            continue;
          }
          fontB64Cache = r.b64;
          fontUrlCache = r.url || cands[i].url;
          fontNotes.push(`√ 采用 ${cands[i].why}，${Math.round((r.size || 0) / 1024)}KB`);
          return fontB64Cache;
        }
        return "";
      })().catch(() => "");
      fontPromise = p;
      // 取空说明页面还没加载出字体（新开页面很常见）。不能把失败结果永久缓存，
      // 否则这个面板之后再也拿不到字体，所有题都只能看到假字。
      p.then((v) => {
        if (!v && fontPromise === p) { fontPromise = null; fontHintsCache = null; }
      });
      return p;
    }

    async function runSolve() {
      const epoch = logEpoch;   // 本次作答开始时的汇总版本，中途被清空/撤销就不再写回去
      const editedQ = qEl.value.trim();
      const editedOpts = current.options.map((s) => s.trim()).filter(Boolean);
      const edited = !!(current.edited || editedQ !== current.question);

      // 加密题：必须先把密文还原成真字才允许作答。
      // 以前这里会把「看着像中文、其实是套错映射的乱码」直接发给模型，答案必然错——宁可停下。
      if (!edited && current.encrypted && !current.decoded) {
        lastSolveFail = "decode";
        statusEl.textContent = current.decodeFail
          || "页面加密文字还没还原出来，先不解题（绝不拿乱码问模型）。";
        return null;
      }

      // 前端已还原好（或本来就是明文）→ 直接传真字，不再上传 675KB 字体
      const canUseDecoded = !edited && !!current.decoded;
      // 只有「找不到加密节点、又没还原」这种边缘情况才把 DOM 原文 + 字体交给后端兜底
      const useRaw = !canUseDecoded && !current.encrypted &&
        !!(current.rawQuestion && !current.edited && editedQ === current.question);
      const question = useRaw ? current.rawQuestion : editedQ;
      const options = useRaw
        ? (current.rawOptions || []).map((s) => s.trim()).filter(Boolean)
        : editedOpts;
      if (!question || !options.length) {
        // 注意：这里绝对不能关自动模式。新开页面 / 刚点完「重新抓取」时题目常常还没
        // 渲染出来，一抓空就关掉，用户看到的就是“识别完了却不点下一题”。
        lastSolveFail = options.length ? "noquestion" : "noopts";
        statusEl.textContent = !options.length
          ? "还没抓到选项（页面可能仍在加载）。稍等会自动重试，也可点「诊断结构」看页面结构。"
          : "抓到选项但没抓到题干。可在上面手动补一句，或点「诊断结构」让我适配。";
        return null;
      }
      lastSolveFail = "";
      statusEl.textContent = "正在推理（分歧时才联网复核）…";
      resultEl.style.display = "none";
      const t0 = performance.now();
      const fontB64 = useRaw ? await getFontB64() : "";
      const override = qtypeEl.value;
      const effQType = override === "auto" ? (current.qtype || "unknown") : override;
      const payload = { question, options, qtype: effQType, encrypted: !!(current.encrypted || fontB64) };
      if (fontB64) payload.font_b64 = fontB64;
      let resp;
      try {
        resp = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: "solve", payload }, (r) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(r);
          });
        });
      } catch (e) { lastSolveFail = "neterr"; statusEl.textContent = "出错：" + e.message; return null; }
      if (!resp || !resp.ok) {
        const err = (resp && resp.error) || "";
        // 后端明确说“解码失败/仍有加密字”→ 归到 decode，交给自动模式按“不拿乱码答题”处理
        if (/解码|加密|乱码|密文/.test(err)) {
          lastSolveFail = "decode";
          current.decoded = false;
          current.decodeFail = err;
          statusEl.textContent = err;
          return null;
        }
        lastSolveFail = "neterr";
        statusEl.textContent = "失败：" + (err || "未知错误");
        return null;
      }

      // 后端用加密字体还原出的真字：写回面板，后面展示/记录都用真字
      let qText = useRaw ? (current.question || question) : question;
      let optTexts = useRaw ? (current.options || options).slice() : options.slice();
      if (resp.decoded) {
        if (resp.decoded.question) qText = resp.decoded.question;
        if (resp.decoded.options && resp.decoded.options.length === options.length) {
          optTexts = resp.decoded.options.slice();
        }
        if (qText !== qEl.value) qEl.value = qText;
        if (optTexts.join("\u0001") !== current.options.join("\u0001")) {
          current.options = optTexts.slice();
          renderOptions();
        }
      }

      // 模型顺带校对字体还原留下的形近错字：写回面板与汇总报告。
      // rawQuestion/rawOptions 仍是 DOM 密文，翻页判断不受影响。
      if (resp.corrected) {
        const cq = resp.corrected.question || qText;
        const co = (resp.corrected.options && resp.corrected.options.length === optTexts.length)
          ? resp.corrected.options.map((x) => String(x)) : optTexts.slice();
        if (cq !== qEl.value) qEl.value = cq;
        qText = cq;
        current.question = cq;
        if (co.join("\u0001") !== current.options.join("\u0001")) {
          current.options = co.slice();
          renderOptions();
        }
        optTexts = co.slice();
      }

      // 多选答案是集合；answer_index 仍保留为第一个，兼容旧报告格式
      const answerIndices = (resp.answer_indices && resp.answer_indices.length)
        ? resp.answer_indices.slice()
        : (resp.answer_index !== null && resp.answer_index !== undefined ? [resp.answer_index] : []);
      const hasAnswer = answerIndices.length > 0 && resp.confidence !== "none";
      const letters = answerIndices.map((n) => String.fromCharCode(64 + n));
      const recText = letters
        .map((L, k) => `${L}. ${(optTexts[answerIndices[k] - 1] || "").slice(0, 60)}`)
        .join(" ／ ");
      const recFull = letters
        .map((L, k) => `${L}. ${(optTexts[answerIndices[k] - 1] || "").slice(0, 80)}`)
        .join("；");
      const isMulti = resp.question_type === "multi" || answerIndices.length > 1;
      const confMap = { high: "高置信", medium: "中等置信", low: "低置信", none: "未找到" };
      const confLabel = confMap[resp.confidence] || "低置信";

      let html = "";
      if (!hasAnswer) {
        html = `<h4>未找到可靠答案（建议人工确认）</h4>`;
      } else {
        html = `<h4>推荐选项：${escapeHtml(recText)} <span class="badge">${confLabel}</span></h4>`;
      }
      const typeLabel = isMulti ? "多选题" : (resp.question_type === "judge" ? "判断题" : "单选题");
      html += `<div class="exp" style="color:#0369a1">题型：${typeLabel}`
        + (answerIndices.length > 1 ? `，应选 ${answerIndices.length} 项` : "") + `</div>`;
      if (resp.font && resp.font.mapped) {
        const sc = resp.font.avg_score ? `，平均相似度 ${resp.font.avg_score}` : "";
        const warn = resp.font.avg_score && resp.font.avg_score < 0.7 ? "（相似度偏低，可能有误）" : "";
        html += `<div class="exp" style="color:#0f766e">已用页面加密字体还原文字（${resp.font.mapped} 个字${sc}）${warn}</div>`;
      } else if (canUseDecoded && decodeInfo && decodeInfo.mapped) {
        html += `<div class="exp" style="color:#0f766e">已用页面加密字体还原文字（${decodeInfo.mapped} 字，本地映射复用）</div>`;
      }
      if (resp.resolved_by === "verdict") {
        html += `<div class="exp"><b>分歧已复核：</b>多次作答不一致，已重新审题裁决。</div>`;
      }
      if (resp.self_fixed) {
        html += `<div class="exp" style="color:#b45309">已修正 ${resp.self_fixed} 处「解析与选项序号不一致」的作答。</div>`;
      }
      if (resp.analysis_conflict) {
        html += `<div class="exp" style="color:#b45309">模型对个别选项的理由与它给出的答案矛盾，已自动复核一次。</div>`;
      }
      if (resp.corrected) {
        html += `<div class="exp" style="color:#0f766e">已校对字体还原造成的疑似错字，题干/选项与汇总报告均已更正。</div>`;
      }
      if (resp.conflict && resp.disputed && resp.disputed.length) {
        const ds = resp.disputed
          .map((d) => `${String.fromCharCode(64 + d.answer_index)}. ${escapeHtml(d.answer_text || "")}（${d.votes}票）`)
          .join("；");
        html += `<div class="exp"><b>存在分歧：</b>${ds}</div>`;
      }
      html += `<div class="exp">${escapeHtml(resp.explanation || (hasAnswer ? "（无解析）" : "建议人工核对题干与选项。"))}</div>`;
      if (!hasAnswer || resp.conflict || resp.confidence === "low") {
        html += `<div class="exp" style="color:#0f766e">拿不准？点「夸克核对（复制本题）」把题干+选项复制过去，用夸克再查一遍。</div>`;
      }
      // 花费透明化：后端会回传这次调用消耗的 token 与折算金额（缓存命中记 0）
      const u = resp.usage || null;
      const costText = !u ? ""
        : (u.cached || !u.calls
            ? "本题 0 元（同题缓存）"
            : `本题 ¥${Number(u.cost || 0).toFixed(4)}` +
              (u.total_cost ? `，后端启动以来累计 ¥${Number(u.total_cost).toFixed(3)}` : ""));
      if (costText) html += `<div class="exp" style="color:#64748b">${escapeHtml(costText)}</div>`;
      resultEl.style.display = "block";
      resultEl.innerHTML = html;

      const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
      const cacheTag = resp.cached ? "（同题缓存）" : "";
      const costShort = !u ? "" : (u.cached || !u.calls ? "，0 元" : `，¥${Number(u.cost || 0).toFixed(4)}`);
      statusEl.textContent = (hasAnswer
        ? (autoMode ? `已记录（${confLabel}），准备翻页…` : `已给出推荐（${confLabel}），请自行判断并点击选项。`)
        : (autoMode ? "本题未找到可靠答案，跳过并继续…" : "未找到可靠答案，建议人工确认。"))
        + ` 用时 ${elapsed}s${cacheTag}${costShort}`;

      clearHighlights();
      const canHighlight = hasAnswer && !autoMode && !resp.conflict && resp.confidence !== "low";
      if (canHighlight) {
        answerIndices.forEach((n) => {
          const el = current._els[n - 1];
          if (el) el.classList.add("qa-suggested");
        });
      }

      // 作答期间汇总被清空 / 撤销过：这条结果已经不属于当前那份汇总，不再写入
      if (epoch !== logEpoch) return resp;

      currentEntry = {
        question: qText, options: optTexts.slice(),
        raw: current.rawQuestion || "",     // DOM 原文（密文），用于断线后判断“这题是不是做过”
        recommended: hasAnswer ? recFull : "未找到可靠答案",
        question_type: isMulti ? "multi" : "single",
        confidence: resp.confidence || "low",
        conflict: !!resp.conflict,
        disputed: resp.disputed || [],
        explanation: resp.explanation || "",
        cost: (u && Number(u.cost)) || 0,      // 本题折算花费（元）；缓存命中为 0
        answer_indices: answerIndices.slice(), // 存下来，重跑时若页面没保留勾选可补选
        picked: null,
      };
      sessionLog.push(currentEntry);
      // 新汇总超过 1 题才作废快照：自动模式下清空后会立刻重算当前题，
      // 这时「撤销清空」还得留着（否则按钮闪一下就没了）；再往后就真的过期了。
      if (undoSnapshot && sessionLog.length > 1) { undoSnapshot = null; undoEl.style.display = "none"; }
      updateCount();
      saveAutoState();          // 每题落盘，断线/刷新不丢已整理的答案
      bindOptionClicks();
      return resp;
    }

    // —— 自动模式：逐题找答案 → 停留 → 翻页 → 下一题，直到结尾导出汇总 ——
    const MAX_RETRY = 8;    // 后端断线重试次数
    const MAX_EMPTY = 5;    // 题目还没渲染出来时的等待次数

    // 同一时刻只允许一条自动流程链：任何一次“启动”（勾选、重新抓取、断线恢复、链接启动）
    // 都会让旧链的 token 失效，避免两条链各点一次「下一题」造成跳题。
    function startAuto(delay) {
      if (!autoMode) return;
      autoRunning = true;
      const token = ++runToken;
      saveAutoState();
      setTimeout(() => autoStep(token), Math.max(0, delay || 0));
    }

    // 暂停：默认保留“自动模式”意图，用户点「重新抓取」就能从当前题续跑
    function pauseAuto(msg, keepIntent) {
      runToken++;              // 排队中的 autoStep / advance 立刻失效
      autoRunning = false;
      if (msg) statusEl.textContent = msg;
      saveAutoState({ paused: true });
      if (!keepIntent) {
        autoMode = false;
        autoEl.checked = false;
        setAutoIntent(false);
      }
    }

    // 彻底关闭自动模式（点「查看汇总」/ 一轮刷完 / 点「重新抓取」时）：
    // 不仅停本页循环，还要清掉「跨页面自动恢复」的开关意图与续跑进度，
    // 否则刷新页面或打开下一份作业时 restoreAuto()/看门狗会把它又拉起来。
    // 异常暂停（断线、抓不到题、等提交）不走这里，仍保留续跑能力。
    function stopAutoMode() {
      runToken++;
      autoRunning = false;
      autoMode = false;
      autoEl.checked = false;
      setAutoIntent(false);
      clearAutoState();
    }

    // 这道题是否已经整理过：同时比“还原后的文字”和“DOM 原文”，
    // 这样刷新后即使字体还没取到（只拿到密文）也能识别出做过、直接翻页。
    function alreadyLogged() {
      const q = current.question || "";
      const raw = current.rawQuestion || "";
      return sessionLog.some((x) => (q && x.question === q) || (raw && x.raw && x.raw === raw));
    }

    // 自动模式：把推荐答案真正勾选到页面上。雨课堂用 el-radio（label 包隐藏 input），
    // Vue 监听 label 的点击；直接点 input 也能触发 v-model 的 change。点 label 优先，
    // 没生效再补点 input 并派发 input/change 事件，确保平台确实记录选项。
    function autoSelectAnswer(indices) {
      if (!current._els || !indices || !indices.length) return 0;
      let ok = 0;
      indices.forEach((n) => {
        const el = current._els[n - 1];
        if (!el) return;
        const inp = (el.querySelector && el.querySelector("input")) ||
                    (el.matches && el.matches("input") ? el : null);
        try { el.click(); } catch (e) { /* 部分平台 label 不可点，退回点 input */ }
        if (inp && !inp.checked) {
          try { inp.click(); } catch (e) {}
          try { inp.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {}
          try { inp.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) {}
        }
        const checked = inp
          ? inp.checked
          : (el.classList.contains("is-checked") || el.getAttribute("aria-checked") === "true");
        if (checked) ok++;
      });
      return ok;
    }

    // 当前抓到的题目是否「像一道题」：题干够长、不像课程目录、至少 2 个非空选项。
    // 不满足时自动流程绝不翻页——否则就是「没识别出来却点了下一题」，等于跳过题目。
    function isCurrentValid() {
      const q = (current.question || "").trim();
      const raw = (current.rawQuestion || "").trim();
      const stem = q || raw;
      if (!stem || stem.length < 6) return false;
      if (looksLikeDirectory(stem) || (raw && looksLikeDirectory(raw))) return false;
      const opts = (current.options || []).filter((s) => String(s || "").trim().length > 0);
      if (opts.length < 2) return false;
      return true;
    }

    async function autoStep(token, attempt = 0) {
      if (token !== runToken || !autoMode || !autoRunning) return;
      // 刷新/重连后可能停在一道已经整理过的题上，直接翻页，不重复调模型
      if (alreadyLogged()) {
        statusEl.textContent = `本题已整理过（共 ${sessionLog.length} 题），自动跳到下一题…`;
        advance(token);   // 已做过的题直接翻过，避免重复调模型、白花冤枉钱
        return;
      }
      // 题干/选项没抓全，或抓成了课程目录：绝不翻页跳过，先重新抓取并等待渲染。
      // 这是「有的题没识别出来却点了下一题」的根治点。
      if (!isCurrentValid()) {
        if (attempt < MAX_EMPTY) {
          const wait = 800 + attempt * 600;
          statusEl.textContent = `本题还没识别完整（题干/选项为空，或抓到的是课程目录），`
            + `${(wait / 1000).toFixed(1)}s 后重新抓取（${attempt + 1}/${MAX_EMPTY}）…`;
          setTimeout(async () => {
            if (token !== runToken) return;
            try {
              const ex = extractQuestion();
              if (ex.question || ex.options.length >= 2) await applyCurrent(ex);
            } catch (e) { /* 抓取失败就按原样重试 */ }
            autoStep(token, attempt + 1);
          }, wait);
          return;
        }
        pauseAuto("连续多次没识别出本题（题干/选项为空，或抓到的是课程目录），已暂停以免跳过题目。请确认题目已加载完成，再点「重新抓取」。", true);
        return;
      }
      // 记录这一轮开始前的条目：只有本轮真的新增了条目，才允许在过期时撤回，
      // 否则会把上一题的记录误删。
      const prevEntry = currentEntry;
      const resp = await runSolve();
      if (token !== runToken || !autoMode || !autoRunning) {
        // 结果已经过期（用户中途点了「重新抓取」/ 关了自动模式）：把刚记的那条撤掉，
        // 否则汇总里会出现同一题的两条记录。
        if (currentEntry && currentEntry !== prevEntry && sessionLog[sessionLog.length - 1] === currentEntry) {
          sessionLog.pop();
          currentEntry = prevEntry;
          updateCount();
          saveAutoState();
        }
        return;
      }
      if (!resp) {
        // 加密文字没还原出来：先重试解码（换字体后旧映射会整体解错），仍不行就停在本题。
        // 绝不允许“拿乱码问模型”，那比慢更糟：答案必然是错的，还会带错整份汇总。
        if (lastSolveFail === "decode") {
          if (attempt < 2) {
            statusEl.textContent = `页面加密文字还没还原出来，正在重试解码（${attempt + 1}/2）…`;
            setTimeout(async () => {
              if (token !== runToken) return;
              const ok = await decodeCurrent();
              autoStep(token, ok ? 0 : attempt + 1);
            }, 900);
            return;
          }
          pauseAuto((current.decodeFail || "页面加密文字没还原出来") +
            " 已暂停，绝不拿乱码答题。请刷新页面后点「重新抓取」重试；也可点「诊断结构」把结构发我适配。", true);
          return;
        }
        // 抓空（题目还没渲染/选项还没出来）：等一会儿再看，不能停
        if (lastSolveFail === "noopts" || lastSolveFail === "noquestion") {
          if (attempt < MAX_EMPTY) {
            const wait = 700 + attempt * 500;
            statusEl.textContent = `正在等题目加载：还没识别到${lastSolveFail === "noopts" ? "选项" : "题干"}，`
              + `${(wait / 1000).toFixed(1)}s 后重试（${attempt + 1}/${MAX_EMPTY}）…`;
            setTimeout(async () => {
              if (token !== runToken) return;
              // 关键：重试前必须重新抓一次页面。runSolve 读的是 current，
              // 不重新抓的话会一直拿“空题目”请求，等到页面渲染完也发现不了。
              try {
                const ex = extractQuestion();
                if ((ex.options.length >= 2 || ex.question) &&
                    (ex.question !== (current.rawQuestion || "") ||
                     ex.options.join("\u0001") !== (current.rawOptions || []).join("\u0001"))) {
                  await applyCurrent(ex);
                }
              } catch (e) { /* 抓取失败就按原样继续重试 */ }
              autoStep(token, attempt + 1);
            }, wait);
            return;
          }
          pauseAuto("连续几次都没抓到题目，已暂停（自动模式仍开着）。等题目加载出来后点「重新抓取」会自动继续。", true);
          return;
        }
        if (attempt >= MAX_RETRY) {
          pauseAuto(`多次重试仍连不上后端，已暂停并保存 ${sessionLog.length} 题。后端恢复后点「重新抓取」或重新勾选「自动模式」即可续跑。`, true);
          return;
        }
        const wait = Math.min(12000, Math.round(700 * Math.pow(1.6, attempt)));
        statusEl.textContent = `连接中断，${(wait / 1000).toFixed(1)}s 后自动重试（${attempt + 1}/${MAX_RETRY}）… 已保存 ${sessionLog.length} 题`;
        setTimeout(() => autoStep(token, attempt + 1), wait);
        return;
      }
      // 只查找并汇总答案，不替用户勾选选项；勾选由用户自行完成。
      // 找到答案后自动点「下一题」翻到下一题，直到最后一题导出汇总。
      saveAutoState();
      const found = (resp && resp.ok && resp.answer_indices && resp.answer_indices.length);
      const who = found
        ? `已找到本题答案（推荐 ${resp.answer_indices.map((n) => String.fromCharCode(64 + n)).join("")}）`
        : "未找到可靠答案（建议人工核对）";
      statusEl.textContent = `${who}，已加入汇总（共 ${sessionLog.length} 题）。即将自动点「下一题」翻页…`;
      setTimeout(() => advance(token), 350);   // 短暂留白，便于看清高亮推荐项
      return;
    }

    function advance(token, confirmed) {
      if (token !== runToken || !autoMode || !autoRunning) return;
      // 用「题干 + 选项」整体做指纹：有些题题干抓不出来，只看题干会误判成“没翻页”
      const sig = (q) => (q.question || "") + "\u0001" + (q.options || []).join("\u0001");
      const before = sig({ question: current.rawQuestion || current.question, options: current.rawOptions || current.options });
      const preferDoc = (current._els && current._els[0] && current._els[0].ownerDocument) || document;
      const btn = findNextButton(preferDoc);
      if (!btn) {
        if (!confirmed) {   // SPA 可能还没渲染出按钮，等一下再确认，别误判成结尾
          statusEl.textContent = "未找到可用「下一题」，正在确认是否已到最后一题…";
          setTimeout(() => advance(token, true), 400);
          return;
        }
        // 二次确认仍没有「可用下一题」：
        //  - 若页面存在「提交本题」类按钮（非交卷）→ 平台要求先提交本题，交还控制权，由看门狗在你提交后自动继续；
        //  - 否则禁用/缺失的「下一题」就是最后一题 → 结束并导出汇总。
        //  绝不自动替你点提交（你明确要求不替你做）。
        const submitPending = findPendingSubmit(preferDoc);
        if (submitPending) {
          autoRunning = false;
          statusEl.textContent = "本题已识别并加入汇总。请先勾选选项并点「提交」（平台需提交后才有下一题）；提交后工具会自动整理并翻到下一题。";
          return;
        }
        autoRunning = false;
        statusEl.textContent = "已经是最后一题（“下一题”不可用），正在导出汇总…";
        exportReport(true);   // 一轮正常跑完：导出后关闭自动模式，等手动开启下一轮
        return;
      }
      clearHighlights();
      btn.click();
      // SPA 渲染有延迟：先快速轮询，没变化再补点一次「下一题」；仍不行则多半需先提交，交还控制权（不硬暂停死循环）
      let tries = 0, retried = false;
      const waitNext = () => {
        if (token !== runToken || !autoMode || !autoRunning) return;
        const after = extractQuestion();
        const afterSig = sig(after);
        if (afterSig !== before) {
          // 页面已经切换（哪怕新题还没渲染完、抓到的是空）→ 交给 autoStep 重试抓取。
          // 绝不在这里再点一次「下一题」，否则会把还没渲染出来的题直接跳过。
          maybeInvalidateFont();                       // 换题换了字体就作废旧映射
          applyCurrent(after).then(() => {             // 新题也先还原成真字再作答
            if (token === runToken) autoStep(token);
          });
        } else if (tries++ < 7) {
          setTimeout(waitNext, 240);
        } else if (!retried) {
          retried = true;
          const again = findNextButton(preferDoc);
          if (again) again.click();
          setTimeout(waitNext, 500);
        } else {
          autoRunning = false;
          statusEl.textContent = "已点「下一题」但页面未切换，可能需要先提交本题。请提交后工具会自动继续；若确为最后一题可忽略。";
        }
      };
      setTimeout(waitNext, 150);
    }

    // 仅用于判断「平台是否要求先提交本题才有下一题」：存在「提交本题 / 提交答案」类按钮（非交卷）即视为需要提交。
    // 只读取、绝不点击，避免误提交 / 误交卷。
    function findPendingSubmit(preferDoc) {
      const list = qsaAll("button, a, [role=button], input[type=submit], [class*=btn]")
        .filter((el) => !isOurs(el) && !isDecoy(el) && isVisible(el));
      const textOf = (el) => normText(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "");
      return list.filter((b) => {
        const t = textOf(b);
        return /^(提交|提交答案|提交本题|保存)$/.test(t) && !DANGEROUS_SUBMIT.test(t);
      })[0] || null;
    }

    // 页面自己换题（用户手动点「下一题」/ 平台 SPA 跳转 / 同标签换作业）时，面板要跟上：
    // 自动流程在跑时完全交给它自己处理，避免两条链抢题；停下来且换了新题就自动接上。
    function watchQuestionChange() {
      if (typeof MutationObserver !== "function" || !document.body) return;
      let timer = null, lastRun = 0, busy = false;
      const tick = () => {
        timer = null;
        if (busy || autoRunning) return;
        const now = Date.now();
        if (now - lastRun < 2500) return;     // 页面有倒计时之类的频繁变动，别把 CPU 打满
        lastRun = now;
        const ex = extractQuestion();
        const raw = ex.question || "";
        if (!raw || ex.options.length < 2) return;
        if (raw === (current.rawQuestion || current.question || "")) return;
        busy = true;
        applyCurrent(ex).then(() => {
          if (autoRunning) return;
          if (autoMode && !alreadyLogged()) {
            statusEl.textContent = "检测到页面已换题，自动模式继续…";
            startAuto(250);
          } else if (!autoMode) {
            statusEl.textContent = `页面已换题，面板已刷新（${current.options.length} 个选项）。`;
          }
        }).catch(() => {}).then(() => { busy = false; });
      };
      try {
        new MutationObserver((muts) => {
          for (let i = 0; i < muts.length; i++) {
            const t = muts[i].target;
            if (t && t.nodeType === 1 && (t.id === "qa-panel" || (t.closest && t.closest("#qa-panel")))) continue;
            if (timer) return;
            timer = setTimeout(tick, 900);
            return;
          }
        }).observe(document.body, { childList: true, subtree: true, characterData: true });
      } catch (e) { /* 观察不到就算了，不影响手动操作 */ }
    }

    // —— 人工核对：把当前题复制到剪贴板，并打开夸克 AI 搜索 ——
    // 纯本地动作：不做任何自动请求、不写 sessionLog、不碰 runToken，自动模式完全不受影响。
    function buildCheckText() {
      const q = (qEl.value || "").trim();   // 用面板里的文本（用户可能手动改过错字）
      const opts = (current.options || [])
        .map((s, i) => `${String.fromCharCode(65 + i)}. ${String(s == null ? "" : s).trim()}`)
        .filter((s) => s.length > 3)
        .join("\n");
      return [q, opts].filter(Boolean).join("\n\n");
    }

    async function copyToClipboard(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (e) { /* 页面不给剪贴板权限就走降级 */ }
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;top:-1000px;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch (e) { return false; }
    }

    async function checkWithQuark() {
      const text = buildCheckText();
      if (!text) { statusEl.textContent = "还没抓到题干，先点「重新抓取」。"; return; }
      const copied = await copyToClipboard(text);
      // URL 只带精简题干，避免过长；完整题目已复制，可直接粘进夸克的搜索框
      const brief = (qEl.value || "").replace(/\s+/g, " ").trim().slice(0, 80);
      const url = QA_CHECK_URL + encodeURIComponent(brief || "搜题");
      let opened = false;
      try { opened = !!window.open(url, "_blank", "noopener,noreferrer"); } catch (e) { opened = false; }
      statusEl.textContent = copied
        ? (opened
            ? `已复制题干+选项（${text.length} 字）并打开夸克 AI 搜索；可在搜索框粘贴完整题目核对。`
            : `已复制题干+选项（${text.length} 字）。弹窗被拦截，请自己打开 www.quark.cn 粘贴核对。`)
        : `复制失败，请手动选中面板里的题干与选项；夸克${opened ? "已打开" : "未能打开"}。`;
    }

    // 只要生成汇总就视为一轮结束：手动点「查看汇总」、或自动跑到最后一题，都立刻关闭自动模式。
    // 放在函数最开头同步执行，不等后端 /report 返回——否则网络慢时复选框还会一直勾着。
    async function exportReport(endRound) {
      stopAutoMode();
      if (!sessionLog.length) { statusEl.textContent = "还没有整理到任何题目。"; return; }

      const buckets = { high: [], medium: [], low: [], conflict: [], none: [] };
      sessionLog.forEach((e) => {
        if (e.conflict) buckets.conflict.push(e);
        else if (e.confidence === "high") buckets.high.push(e);
        else if (e.confidence === "medium") buckets.medium.push(e);
        else if (e.confidence === "none" || e.recommended === "未找到可靠答案") buckets.none.push(e);
        else buckets.low.push(e);
      });

      const confText = (e) => ({ high: "高", medium: "中", low: "低", none: "无" }[e.confidence] || "低");
      const entry = (e, n) => {
        const opts = e.options.map((o, j) => `${String.fromCharCode(65 + j)}. ${o}`).join("\n");
        const typeTag = e.question_type === "multi" ? "多选" : "单选";
        let s = `#### 第 ${n} 题（${typeTag}）\n**题目**：${e.question}\n\n**选项**：\n${opts}\n\n`;
        s += `**推荐答案**：${e.recommended}（置信度：${confText(e)}）\n`;
        if (e.conflict && e.disputed && e.disputed.length) {
          s += `**分歧 / 未采纳选项**：` + e.disputed.map((d) => `${String.fromCharCode(64 + d.answer_index)}. ${d.answer_text}（${d.votes}票）`).join("；") + "\n";
        }
        s += `**你的选择**：${e.picked || "(未记录，待你自行选择)"}\n**解析**：${e.explanation || "（无）"}\n\n`;
        return s;
      };

      // 正文严格按做题顺序（第 1 题→第 N 题），置信度只写在每题里，不再分栏打乱顺序
      let md = `# 答题汇总（共 ${sessionLog.length} 题，生成于 ${new Date().toLocaleString()}）\n\n`;
      md += `> 由“答题学习助手”自动整理，仅供学习参考。**按题目顺序排列**，请自行思考后作答。\n\n`;
      md += `## 概览\n\n- 高置信 ${buckets.high.length} 题 / 中等置信 ${buckets.medium.length} 题 / 低置信 ${buckets.low.length} 题\n`;
      md += `- 存在分歧 ${buckets.conflict.length} 题 / 未找到 ${buckets.none.length} 题\n`;
      const spent = sessionLog.reduce((a, e) => a + (Number(e.cost) || 0), 0);
      if (spent > 0) md += `- 本次调用模型花费约 ¥${spent.toFixed(4)}（缓存命中的题记 0 元）\n`;
      md += `\n`;
      md += `## 逐题答案（按题目顺序）\n\n`;
      sessionLog.forEach((e, i) => { md += entry(e, i + 1) + "---\n\n"; });

      // 只在窗口里展示，不再触发浏览器下载
      currentReportMd = md;
      resultEl.style.display = "block";
      resultEl.innerHTML =
        `<h4>已生成答案汇总（${sessionLog.length} 题）</h4>` +
        `<div class="actions" style="margin:0 0 8px"><button class="ghost" id="qa-copy-report">复制汇总文本</button></div>` +
        `<div class="exp">${escapeHtml(md)}</div>`;
      resultEl.scrollTop = 0;

      // 后台静默存一份，供 popup 的「合并已保存的报告」使用；不会弹下载
      try {
        const { backend } = await chrome.storage.local.get("backend");
        const url = (backend || "http://127.0.0.1:8787").replace(/\/+$/, "") + "/report";
        await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ markdown: md, questions: sessionLog }) });
        statusEl.textContent = `汇总已在窗口显示（可点「复制汇总文本」）｜高置信${buckets.high.length} / 争议${buckets.conflict.length} / 未找到${buckets.none.length}｜已静默保存供合并使用。`;
      } catch (e) {
        statusEl.textContent = "汇总已在窗口显示（可点「复制汇总文本」）；后端未连接，未保存副本。";
      }
      // 点「查看汇总」当场就关，不拖到下一次「重新抓取」或换页面
      statusEl.textContent += endRound
        ? " 本轮已结束，自动模式已关闭；下一份作业请手动勾选「自动模式」。"
        : " 自动模式已关闭；下一轮请手动勾选「自动模式」。";
    }

    panel.querySelector("#qa-close").addEventListener("click", () => {
      pauseAuto("", false);
      clearAutoState();
      clearHighlights(); panel.remove(); style.remove(); window.__qaAssistantInjected = false;
    });
    // 「重新抓取」：清空上一轮汇总 + 关闭自动模式，只刷新当前题（不自动续跑）
    panel.querySelector("#qa-re").addEventListener("click", () => { load(true, true); });
    undoEl.addEventListener("click", undoReset);
    autoEl.addEventListener("change", (e) => {
      autoMode = e.target.checked;
      setAutoIntent(autoMode);
      if (autoMode) {
        // 每次手动开启都是全新一轮：先清掉上一轮汇总（可撤销），再从当前题开跑
        const n = sessionLog.length;
        if (n) resetSummary();
        statusEl.textContent = n
          ? `自动模式已开启：已清空上一轮 ${n} 题，本轮从头开始记（点「撤销清空」可恢复）…`
          : "自动模式已开启：将逐题找答案并翻页（不替你选任何选项）。";
        startAuto(60);
      } else {
        pauseAuto("自动模式已关闭。", true);   // 意图已在上面写成 false
        autoMode = false;                     // 手动关闭：不要让「重新抓取」又跑起来
      }
    });
    panel.querySelector("#qa-export").addEventListener("click", () => exportReport());
    panel.querySelector("#qa-check").addEventListener("click", checkWithQuark);
    resultEl.addEventListener("click", async (e) => {
      if (!e.target || e.target.id !== "qa-copy-report" || !currentReportMd) return;
      const ok = await copyToClipboard(currentReportMd);
      statusEl.textContent = ok
        ? "汇总已复制到剪贴板，可直接粘贴。"
        : "复制失败，请手动选中窗口里的文本复制。";
    });
    panel.querySelector("#qa-solve").addEventListener("click", () => { runSolve(); });

    // —— 结构诊断：把页面结构交给后端存成文件，助手可直接读取适配 ——
    async function collectDiagnostics() {
      const clip = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n || 300);
      const htmlOf = (el, n) => (el && el.outerHTML ? String(el.outerHTML).replace(/\s+/g, " ").slice(0, n || 1000) : "");
      const roots = collectRoots();
      const meta = {
        roots: roots.length,
        frames: 0,
        shadow: 0,
        refusedFrames: 0,
      };
      const iframeUrls = [];
      document.querySelectorAll("iframe, frame").forEach((f) => {
        meta.frames++;
        iframeUrls.push(f.getAttribute("src") || "(no src)");
        let cd = null;
        try { cd = f.contentDocument; } catch (e) { cd = null; }
        if (!cd) meta.refusedFrames++;
      });
      document.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) meta.shadow++; });

      // —— 加密字体：雨课堂用 xuetangx-com-encrypted-font 把字重映射，DOM 里的字是错的 ——
      const hints = collectFontHints();
      const fontFaces = (hints.faces || []).slice(0, 20);
      const fontCands = rankFontUrls(hints).slice(0, 10).map((c) => ({ url: c.url, score: c.score, why: c.why }));
      const fontFamilies = Array.from(new Set(hints.families || [])).slice(0, 20);

      const encrypted = [];
      roots.forEach((root) => {
        qsaIn(root, "[class*=encrypted], [class*=Encrypted]").forEach((el) => {
          if (isOurs(el)) return;
          let ff = "";
          try { ff = getComputedStyle(el).fontFamily || ""; } catch (e) {}
          encrypted.push({
            tag: el.tagName,
            cls: String(el.className || "").slice(0, 120),
            text: clip(el.innerText || el.textContent || "", 120),
            fontFamily: ff.slice(0, 120),
            parentHtml: htmlOf(el.parentElement, 500),
          });
        });
      });

      const buttons = [];
      const letterHits = [];
      const numberNav = [];
      const typeLabels = [];

      roots.forEach((root) => {
        qsaIn(root, "button, a, [role=button], input[type=submit], [class*=btn], [class*=arrow], [class*=next]").forEach((b) => {
          if (isOurs(b)) return;
          buttons.push({
            tag: b.tagName,
            text: clip(b.innerText || b.value || "", 60),
            cls: String(b.className || "").slice(0, 120),
            aria: b.getAttribute("aria-label") || "",
            title: b.getAttribute("title") || "",
            visible: isVisible(b),
          });
        });

        qsaIn(root, "div, span, li, p, label, td").forEach((el) => {
          if (isOurs(el)) return;
          if (el.children && el.children.length > 6) return;
          const t = clip(el.innerText || "", 160);
          if (!t || t.length > 120) return;
          const lone = /^[A-Ha-h]$/.test(t);
          if (!lone && !/^[A-Ha-h]\s*[.．、,，)）:：]?\s*\S/.test(t)) return;
          letterHits.push({
            tag: el.tagName,
            cls: String(el.className || "").slice(0, 100),
            parentCls: el.parentElement ? String(el.parentElement.className || "").slice(0, 100) : "",
            text: t,
            lone,
            html: htmlOf(el, 500),
            parentHtml: lone ? htmlOf(el.parentElement, 400) : "",
          });
        });

        qsaIn(root, "div, span, li, button, a").forEach((el) => {
          if (isOurs(el)) return;
          if (el.children && el.children.length > 0) return;
          const t = (el.innerText || "").trim();
          if (!/^\d{1,3}$/.test(t)) return;
          numberNav.push({
            n: parseInt(t, 10),
            cls: String(el.className || "").slice(0, 100),
            parentCls: el.parentElement ? String(el.parentElement.className || "").slice(0, 100) : "",
            html: htmlOf(el.parentElement, 300),
          });
        });

        qsaIn(root, "div, span, p, h1, h2, h3, h4").forEach((el) => {
          if (isOurs(el)) return;
          const t = clip(el.innerText || "", 40);
          if (!/^(单项选择|多项选择|单选|多选|判断|填空|简答|论述|材料分析)[题]?$/.test(t)) return;
          typeLabels.push({
            text: t,
            cls: String(el.className || "").slice(0, 100),
            parentHtml: htmlOf(el.parentElement, 2500),
          });
        });
      });

      // 试着把加密字体文件本身取下来（走后台抓，绕开页面 CSP），交给后端解析
      let fontB64 = "";
      let fontErr = "";
      try {
        fontB64 = await getFontB64();
      } catch (e) {
        fontErr = String((e && e.message) || e);
      }
      if (!fontB64) fontErr = fontErr || fontNotes.join("；") || "没找到加密字体";

      return {
        url: location.href,
        title: document.title,
        ts: new Date().toISOString(),
        viewport: { w: innerWidth, h: innerHeight },
        meta,
        iframeUrls,
        fontFaces,
        fontCands,
        fontFamilies,
        fontCss: (hints.cssHrefs || []).slice(0, 10),
        fontRes: (hints.resourceUrls || []).slice(0, 20),
        fontUrl: fontUrlCache,
        fontNotes,
        fontErr,
        fontB64,
        encrypted: encrypted.slice(0, 20),
        extract: {
          // 交给后端自检解码的必须是 DOM 原文（假字），不能是面板显示的真字
          question: clip(current.rawQuestion || current.question, 300),
          options: (current.rawOptions || current.options || []).map((o) => clip(o, 80)),
        },
        // 加密还原状态：排查“为什么这题没解出来 / 为什么显示乱码”时最关键的一组信息
        enc: {
          hasContainer: !!current._qEl,
          encrypted: !!current.encrypted,
          plain: !!current.plain,
          decoded: !!current.decoded,
          fail: current.decodeFail || "",
          shownQuestion: clip(current.question || "", 200),
          info: decodeInfo || null,
        },
        bodyText: clip(document.body.innerText, 3000),
        buttons: buttons.slice(0, 60),
        letterHits: letterHits.slice(0, 60),
        numberNav: numberNav.slice(0, 60),
        typeLabels: typeLabels.slice(0, 10),
      };
    }

    panel.querySelector("#qa-diag").addEventListener("click", async () => {
      statusEl.textContent = "正在收集页面结构…";
      const clipTxt = (s, n) => (s || "").replace(/\s+/g, " ").trim().slice(0, n || 300);
      let data;
      try {
        data = await collectDiagnostics();
      } catch (e) {
        statusEl.textContent = "收集结构失败：" + e.message;
        return;
      }
      try {
        const { backend } = await chrome.storage.local.get("backend");
        const url = (backend || "http://127.0.0.1:8787").replace(/\/+$/, "") + "/debug";
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        const j = await r.json();
        const fontState = data.fontB64
          ? `已取到 ${Math.round(data.fontB64.length * 3 / 4 / 1024)}KB${data.fontUrl ? "（" + escapeHtml(data.fontUrl.slice(-40)) + "）" : ""}`
          : "未取到：" + escapeHtml(data.fontErr || "");
        const selfDec = j.selfDecode
          ? `已自动解码${decodeInfo && decodeInfo.mapped ? `（还原 ${decodeInfo.mapped} 字）` : ""}，结果在文件里`
          : "未自动解码";
        resultEl.style.display = "block";
        resultEl.innerHTML =
          `<h4>结构诊断已保存</h4><div class="exp">文件：${escapeHtml(j.file || "")}\n` +
          `题干（还原后）：${escapeHtml(clipTxt(current.question, 60)) || "（空）"}\n` +
          `原文（加密）：${escapeHtml(clipTxt(data.extract.question, 60)) || "（空）"}\n` +
          `选项：${data.extract.options.length} 个\n` +
          `按钮：${data.buttons.length} 个 / 字母候选：${data.letterHits.length} / 题号：${data.numberNav.length}\n` +
          `加密字体节点：${(data.encrypted || []).length} 个 / 字体文件：${fontState}\n` +
          `候选字体：${(data.fontCands || []).length} 个 / ${selfDec}\n` +
          (data.fontNotes && data.fontNotes.length ? `查找过程：${escapeHtml(data.fontNotes.join("；"))}\n` : "") +
          `\n请对助手说一句：「诊断已保存」</div>`;
        statusEl.textContent = "已保存到后端 debug/ 目录，告诉助手「诊断已保存」即可。";
      } catch (e) {
        statusEl.textContent = "保存失败（后端没连上？）" + e.message;
      }
    });

    // 从链接入口启动：后台注入后发来 autostart，直接开自动模式（不替你选）
    let booted = null;
    chrome.runtime.onMessage.addListener((m) => {
      if (!m || m.type !== "qa_autostart") return;
      autoMode = true;
      autoRunning = true;
      autoEl.checked = true;
      setAutoIntent(true);              // 本轮中途刷新可续跑；一轮跑完会被 stopAutoMode 清掉
      try { if (stayEl) stayEl.value = String(m.stay === undefined ? 0.4 : m.stay); } catch (e) {}
      statusEl.textContent = "自动模式（来自链接启动）：逐题找答案并翻页，不替你选选项。";
      saveAutoState();
      const go = () => { if (autoMode) startAuto(150); };
      // 等首次抓题+字体还原完成再开跑，避免一上来就抓到空题目
      if (booted) booted.then(go); else setTimeout(go, 800);
    });

    booted = load();
    booted.then(restoreAuto, restoreAuto);
    watchQuestionChange();
  }

  function escapeHtml(s) {
    return (s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }

  buildPanel();
})();
