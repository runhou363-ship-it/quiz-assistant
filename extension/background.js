/* 后台服务：
 *  - solve：转发到本地后端 /solve
 *  - open_and_run：打开链接并自动注入+启动；可选扫描"章节/课时"链接逐页处理
 *  - count_chapters：在当前页做 SPA 友好的章节统计（展开 + 滚动 + 轮询 + 文本识别，只读）
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  const done = (p) =>
    p.then((r) => safeSend(sendResponse, r))
      .catch((e) => safeSend(sendResponse, { ok: false, error: (e && e.message) || String(e) }));
  if (msg.type === "solve") { done(handleSolve(msg.payload)); return true; }
  if (msg.type === "decode") { done(handleDecode(msg.payload)); return true; }
  if (msg.type === "fetch_font") { done(handleFetchFont(msg.payload)); return true; }
  if (msg.type === "fetch_text") { done(handleFetchText(msg.payload)); return true; }
  if (msg.type === "open_and_run") { done(handleOpen(msg)); return true; }
  if (msg.type === "count_chapters") { done(handleCount(msg)); return true; }
});

function safeSend(fn, data) {
  try { fn(data); } catch (e) { /* 弹窗可能已关闭 */ }
}

async function handleSolve(payload) {
  const { backend } = await chrome.storage.local.get("backend");
  const url = (backend || "http://127.0.0.1:8787").replace(/\/+$/, "") + "/solve";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("后端返回 " + res.status);
  return await res.json();
}

// 只做字体解码（不调模型、不花钱）：面板抓到题后立刻把假字换成真字
async function handleDecode(payload) {
  const { backend } = await chrome.storage.local.get("backend");
  const url = (backend || "http://127.0.0.1:8787").replace(/\/+$/, "") + "/decode";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("后端返回 " + res.status);
  return await res.json();
}

// 取加密字体文件（在扩展上下文里抓，绕开页面的 CSP 限制）
async function handleFetchFont(payload) {
  const url = (payload && payload.url) || "";
  if (!url) return { ok: false, error: "缺少字体地址" };
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, error: "字体请求失败 " + res.status };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 4000000) return { ok: false, error: "字体过大 " + buf.byteLength };
    const bytes = new Uint8Array(buf);
    // 前 4 字节用来判断是不是真字体（woff2=wOF2, woff=wOFF, otf=OTTO, ttf=00010000/true, ttc=ttcf）
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
}

// 抓跨域样式表文本：@font-face 常写在这种读不到 cssRules 的 CSS 里
async function handleFetchText(payload) {
  const url = (payload && payload.url) || "";
  if (!url || !/^https?:/i.test(url)) return { ok: false, error: "地址无效" };
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return { ok: false, error: "CSS 请求失败 " + res.status };
    const text = await res.text();
    return { ok: true, text: text.slice(0, 1500000), size: text.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitTabComplete(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (t) => {
      if (t && t.status === "complete") { resolve(); return; }
      const listener = (id, info) => {
        if (id === tabId && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

async function injectAndStart(tabId, stay) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["inject.js"] });
  await sleep(400);
  try {
    await chrome.tabs.sendMessage(tabId, { type: "qa_autostart", stay });
  } catch (e) { /* 页面可能已跳转，忽略 */ }
}

/* ============ 章节统计（SPA 友好，只读，不点题） ============
 * 思路：
 *   1) 先点一遍页面上的"展开 / 更多 / 加载更多"（只认短文本按钮，最多 20 个）；
 *   2) 滚动所有可滚动容器，触发懒加载；
 *   3) 多轮轮询收集"像章节"的节点（文本识别 + 编号识别 + 容器去重）；
 *   4) 按编号分层汇总，返回条目清单。
 * 注意：此函数会被序列化后注入页面，不能引用外部变量。
 */
async function deepScanChapters(opts) {
  const cfg = Object.assign({ expand: true, maxMs: 14000, maxItems: 400 }, opts || {});
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) =>
    (s || "").replace(/[\u00a0\u3000]/g, " ").replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim();

  const res = {
    ok: true, title: norm(document.title), url: location.href,
    total: 0, topLevel: 0, byLevel: {}, taskPoints: 0,
    items: [], links: [], warnings: [], notes: [
      "只统计当前页面；若页面有\u201c未完成 / 已完成\u201d等标签，请分别切过去各统计一次。",
      "统计过程只读取文字并滚动页面，不会点击任何题目选项。",
    ],
    expanded: 0, scannedMs: 0,
  };
  const t0 = Date.now();

  // 中文数字 -> 阿拉伯数字，让"第一章"和"1.1"能归到同一个顶层章节
  const CN = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const cnToNum = (s) => {
    if (!s) return "";
    if (/^[0-9]+$/.test(s)) return String(parseInt(s, 10));
    if (s.indexOf("十") >= 0) {
      const parts = s.split("十");
      const tens = parts[0] ? (CN[parts[0]] || 0) : 1;
      const ones = parts[1] ? (CN[parts[1]] || 0) : 0;
      return String(tens * 10 + ones);
    }
    return CN[s] === undefined ? s : String(CN[s]);
  };

  // —— 章节标题识别：返回 {level, numbering} 或 null ——
  const matchChapter = (txt) => {
    let m;
    if ((m = txt.match(/^第\s*([0-9]{1,3})\s*[章单元篇部分]/))) return { level: 1, numbering: cnToNum(m[1]) };
    if ((m = txt.match(/^第\s*([一二三四五六七八九十百零]{1,3})\s*[章单元篇部分]/))) return { level: 1, numbering: cnToNum(m[1]) };
    if ((m = txt.match(/^第\s*([0-9]{1,3})\s*[节讲课课时]/))) return { level: 2, numbering: cnToNum(m[1]) };
    if ((m = txt.match(/^第\s*([一二三四五六七八九十百零]{1,3})\s*[节讲课课时]/))) return { level: 2, numbering: cnToNum(m[1]) };
    if ((m = txt.match(/^第\s*([0-9一二三四五六七八九十]{1,3})\s*周/))) return { level: 1, numbering: cnToNum(m[1]) };
    // 1 / 1.1 / 1.1.1，要求编号后面紧跟分隔符，避免把 1+1=? 、30:00 当成章节
    if ((m = txt.match(/^([0-9]{1,2}(?:\s*[.．]\s*[0-9]{1,2}){0,2})(?=$|[\s、,，.．:：\-—)】\]])/))) {
      const num = m[1].replace(/\s*[.．]\s*/g, ".");
      if (/^[0-9]{4}$/.test(num)) return null;            // 2024 年
      if (/^[0-9]{1,2}[:：]/.test(txt)) return null;      // 30:00 时长
      if (/^[0-9.]+\s*(分钟|秒|小时|min|s|%|个)/.test(txt)) return null;
      const lv = num.split(".").length;
      if (lv >= 1 && lv <= 3) return { level: lv, numbering: num };
    }
    if ((m = txt.match(/^(chapter|unit|section|lesson|module|week)\s*([0-9]{1,3})/i))) return { level: 2, numbering: m[2] };
    return null;
  };

  const TASK_TYPES = ["视频", "课件", "习题", "测验", "作业", "讨论", "阅读", "文档", "音频", "考试", "PPT", "PDF", "链接", "任务点"];
  const countTasks = (txt) => {
    const low = txt.toLowerCase();
    return TASK_TYPES.filter((k) => low.indexOf(k.toLowerCase()) >= 0);
  };

  // 去掉行尾的任务/状态噪音，得到干净的章节标题
  const cleanTitle = (txt) => {
    let s = txt;
    const cut = s.search(/(视频|课件|习题|测验|作业|讨论|阅读|文档|音频|考试|PPT|PDF|任务点)/);
    if (cut > 3) s = s.slice(0, cut);
    s = s.replace(/\s*(已看|未看|已完成|未完成|进行中|待完成|已提交|未提交|观看至|学习时长|时长)[^ ]*/g, " ");
    s = s.replace(/\s*[0-9]{1,3}:[0-9]{2}(\s*\/\s*[0-9]{1,3}:[0-9]{2})?/g, " ");
    return norm(s).slice(0, 100);
  };

  const hrefOf = (el) => {
    let a = null;
    try { a = el.closest ? el.closest("a[href]") : null; } catch (e) {}
    if (!a) { try { a = el.querySelector ? el.querySelector("a[href]") : null; } catch (e) {} }
    if (!a) return "";
    try { return new URL(a.getAttribute("href"), location.href).href; } catch (e) { return ""; }
  };

  try {
    // 0) 收集可访问的文档（含同源 iframe，雨课堂等平台常把正文放 iframe）
    const docs = [document];
    try {
      document.querySelectorAll("iframe").forEach((f) => {
        try { if (f.contentDocument && f.contentDocument.body) docs.push(f.contentDocument); } catch (e) {}
      });
    } catch (e) {}

    // 1) 展开折叠项
    if (cfg.expand) {
      const expRe = /^(展开|展开全部|展开更多|显示更多|查看更多|更多|加载更多|点击展开)$/;
      for (const d of docs) {
        let cands = [];
        try {
          cands = Array.prototype.slice.call(d.querySelectorAll("button, [role=button], span, a, div")).filter((el) => {
            const t = norm(el.innerText || el.textContent);
            if (!t || t.length > 8 || !expRe.test(t)) return false;
            if (el.children && el.children.length > 1) return false;
            // 不点会跳转的链接，避免把页面带走
            let a = null;
            try { a = el.closest ? el.closest("a") : null; } catch (e) {}
            const href = a ? (a.getAttribute("href") || "") : "";
            if (href && href !== "#" && !/^javascript:/i.test(href)) return false;
            const r = el.getBoundingClientRect();
            return r.width > 2 && r.height > 2;
          }).slice(0, 20);
        } catch (e) {}
        for (const el of cands) {
          try { el.click(); res.expanded++; await sleep(90); } catch (e) {}
        }
      }
      if (res.expanded) await sleep(400);
    }

    // 2) 滚动触发懒加载
    const scrollers = (d) => {
      const arr = [d.scrollingElement || d.documentElement];
      try {
        d.querySelectorAll("div, main, section, ul, aside, tbody").forEach((el) => {
          if (el.clientHeight > 120 && el.scrollHeight > el.clientHeight + 80) {
            const st = d.defaultView.getComputedStyle(el);
            if (st && /(auto|scroll|overlay)/.test(st.overflowY)) arr.push(el);
          }
        });
      } catch (e) {}
      return arr.slice(0, 10);
    };
    const scrollUntil = Date.now() + Math.max(1500, Math.round(cfg.maxMs * 0.5));
    let lastH = 0;
    while (Date.now() < scrollUntil) {
      let moved = false;
      for (const d of docs) {
        for (const el of scrollers(d)) {
          const before = el.scrollTop;
          el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + Math.max(240, el.clientHeight * 0.85));
          if (el.scrollTop !== before) moved = true;
          if (el.scrollHeight > lastH) { lastH = el.scrollHeight; moved = true; }
        }
      }
      await sleep(230);
      if (!moved) break;
    }

    // 3) 轮询收集
    const collectOnce = () => {
      const found = [];
      docs.forEach((d) => {
        let els;
        try { els = d.querySelectorAll("li, tr, a, div, section, article, p, span, h1, h2, h3, h4, h5, dd, dt"); } catch (e) { return; }
        els.forEach((el) => {
          let raw;
          try { raw = el.textContent || ""; } catch (e) { return; }
          if (!raw || raw.length > 200) return;              // 先做一次廉价过滤
          if (el.children && el.children.length > 8) return;  // 粗粒度容器直接跳过
          const txt = norm(el.innerText || raw);
          if (!txt || txt.length < 2 || txt.length > 130) return;
          const hit = matchChapter(txt);
          if (!hit) return;

          // 容器判定：内部还有 2 个以上不同的章节命中 => 这是容器，不是单条
          let inner = 0;
          try {
            const kids = el.querySelectorAll("li, tr, a, p, span, div");
            for (let i = 0; i < kids.length; i++) {
              const kt = norm(kids[i].innerText || kids[i].textContent);
              if (kt && kt.length <= 130 && kt !== txt && matchChapter(kt)) {
                inner++;
                if (inner >= 2) break;
              }
            }
          } catch (e) {}
          if (inner >= 2) return;

          const title = cleanTitle(txt);
          if (!title) return;
          const key = (hit.numbering + "|" + title.replace(/[\s\[\]（）()【】]/g, "")).toLowerCase();
          found.push({ key, title, level: hit.level, numbering: hit.numbering, tasks: countTasks(txt), href: hrefOf(el) });
        });
      });
      return found;
    };

    const collected = new Map();
    const deadline = Date.now() + Math.max(1200, cfg.maxMs - (Date.now() - t0));
    let stable = 0;
    while (Date.now() < deadline && stable < 2) {
      let added = 0;
      let found = [];
      try { found = collectOnce(); } catch (e) {}
      found.forEach((it) => {
        const prev = collected.get(it.key);
        if (!prev) { collected.set(it.key, it); added++; }
        else if (it.title.length < prev.title.length) collected.set(it.key, it);
      });
      stable = added === 0 ? stable + 1 : 0;
      if (stable >= 2) break;
      await sleep(450);
    }

    // 4) 兜底：没有编号命中时，从目录类容器里取候选
    if (!collected.size) {
      for (const d of docs) {
        let boxes;
        try {
          boxes = d.querySelectorAll("nav, aside, ul, [class*=catalog], [class*=chapter], [class*=section], [class*=menu], [class*=list], [class*=tree], [class*=nav]");
        } catch (e) { continue; }
        boxes.forEach((box) => {
          const kids = box.children || [];
          if (kids.length < 3) return;
          Array.prototype.forEach.call(kids, (k) => {
            const t = norm(k.innerText || k.textContent);
            if (!t || t.length > 60) return;
            const key = "x|" + t.replace(/[\s\[\]（）()【】]/g, "").toLowerCase();
            if (!collected.has(key)) collected.set(key, { key, title: t, level: 1, numbering: "", tasks: countTasks(t), href: hrefOf(k) });
          });
        });
      }
      if (collected.size) {
        res.warnings.push("未识别到明确的章节编号，下面是从目录类容器里取到的候选条目，数量可能与真实章节数有偏差。");
      }
    }

    const items = Array.from(collected.values()).sort((a, b) => {
      if (a.numbering && b.numbering) return a.numbering.localeCompare(b.numbering, undefined, { numeric: true });
      if (a.numbering) return -1;
      if (b.numbering) return 1;
      return a.title.localeCompare(b.title, "zh");
    });

    res.items = items.slice(0, cfg.maxItems);
    res.total = items.length;
    const byLevel = {};
    items.forEach((it) => { byLevel[it.level] = (byLevel[it.level] || 0) + 1; });
    res.byLevel = byLevel;
    const tops = {};
    items.forEach((it) => {
      const k = it.numbering ? String(it.numbering).split(".")[0] : it.title;
      tops[k] = 1;
    });
    res.topLevel = Object.keys(tops).length;
    res.taskPoints = items.reduce((n, it) => n + it.tasks.length, 0);
    const links = [];
    items.forEach((it) => { if (it.href && links.indexOf(it.href) < 0) links.push(it.href); });
    res.links = links.slice(0, 60);

    if (!items.length) {
      if (/登录|login|sign\s*in/i.test(res.title)) {
        res.warnings.push("当前页面看起来是登录页，请先登录并进入课程/答题页，再点统计。");
      } else {
        res.warnings.push("没识别到章节条目：页面可能还在加载、需要登录，或结构比较特殊。可以等页面完全加载后重试，或多点一次\u201c展开/更多\u201d。");
      }
    }
  } catch (e) {
    res.ok = false;
    res.error = (e && e.message) || String(e);
  }

  res.scannedMs = Date.now() - t0;
  return res;
}

async function handleCount(msg) {
  let tabId = msg.tabId;
  if (!tabId) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab && tab.id;
  }
  if (!tabId) throw new Error("未找到当前标签页");

  let injected;
  try {
    injected = await chrome.scripting.executeScript({
      target: { tabId },
      func: deepScanChapters,
      args: [{ expand: msg.expand !== false, maxMs: msg.maxMs || 14000 }],
    });
  } catch (e) {
    throw new Error("无法在此页面运行（chrome:// 或扩展商店页不允许注入）：" + ((e && e.message) || e));
  }
  const data = injected && injected[0] && injected[0].result;
  if (!data) throw new Error("扫描没有返回结果");
  if (!data.ok) throw new Error(data.error || "扫描失败");

  try { await chrome.storage.local.set({ lastChapterScan: data }); } catch (e) {}
  return { ok: true, data };
}

// 旧版：仅扫 <a> 链接，作为 deepScanChapters 拿不到链接时的兜底
function scanChapters() {
  const base = location.origin;
  const out = [];
  const seen = new Set();
  const re = /第\s*\d+\s*[章节课]|章节|课时|lesson|chapter|练习|测验|quiz|test|section|单元|模块|topic/i;
  document.querySelectorAll("a[href]").forEach((a) => {
    const href = a.href || "";
    if (!href || href.startsWith("javascript:")) return;
    const text = (a.innerText || "").trim();
    const inNav = !!a.closest("nav, .nav, .sidebar, .menu, .chapter, .lesson, .list, .catalog, aside, [class*=nav], [class*=menu]");
    if (re.test(text) || inNav) {
      try {
        const abs = new URL(href, location.href).href;
        if (abs.startsWith(base) && !seen.has(abs)) { seen.add(abs); out.push(abs); }
      } catch (e) {}
    }
  });
  return out.slice(0, 50);
}

async function handleOpen(msg) {
  const { url, chapters } = msg;
  const tab = await chrome.tabs.create({ url, active: true });
  await waitTabComplete(tab.id);

  let urls = [];
  if (chapters) {
    // 先扫章节链接（SPA 友好版），再启动自动模式，避免面板干扰扫描
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: deepScanChapters,
        args: [{ expand: true, maxMs: 8000 }],
      });
      const d = r && r[0] && r[0].result;
      urls = (d && d.links) || [];
    } catch (e) {}
    if (!urls.length) {
      try {
        const r2 = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scanChapters });
        urls = (r2 && r2[0] && r2[0].result) || [];
      } catch (e) {}
    }
    urls = urls.slice(0, 30);
  }

  await injectAndStart(tab.id, 1);

  let count = 0;
  for (const u of urls) {
    try {
      const t = await chrome.tabs.create({ url: u, active: false });
      await waitTabComplete(t.id);
      await injectAndStart(t.id, 1);
      count++;
    } catch (e) { /* 单个章节失败不影响其他 */ }
  }
  return { ok: true, chapters: count };
}
