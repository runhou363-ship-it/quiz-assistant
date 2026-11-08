/* 视频任务点自动连播（雨课堂「学习空间」/ 学习通一类左侧目录页）
 *
 * 只做一件事：在左侧目录里找到标记为「视频」的条目 → 点开 → 等真实播放器播完
 * → 回目录继续往下滚动找下一个「视频」，直到没有为止。
 *
 * 明确不做：
 *   - 「作业 / 测验 / 考试 / 讨论 / 图文」一律不点（留给用户手动）；
 *   - 不点「提交 / 交卷 / 确定 / 下一题 / 答案」；
 *   - 不替用户答题、不伪造学习时长、不调用任何平台接口；
 *   - 不静默后台运行：有浮窗显示进度，随时可暂停 / 停止，刷新页面后不会自动恢复。
 *
 * 由 popup 通过 chrome.scripting.executeScript 注入顶层文档；
 * 目录里的内容常驻顶层，右侧播放器在同源 iframe 里，用 contentDocument 跨文档读取。
 */
(() => {
  if (window.__qaVideoBrush) return;       // 重复注入时只保留一个实例

  const STATE_KEY = "qaVideoBrushState";
  const norm = (s) => (s || "")
    .replace(/[\u00a0\u3000]/g, " ").replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ").trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => Date.now();
  // 可被「停止」立刻打断的等待，避免点了停止还卡在几秒的间隔里
  const interruptibleSleep = async (ms) => {
    const end = now() + ms;
    while (!stopFlag && now() < end) await sleep(Math.min(200, Math.max(10, end - now())));
  };

  let cfg = {
    speed: 1,               // 默认 1 倍速（真实时长）：雨课堂等平台按真实观看时长计完成度，>1 倍速只计约一半
    skipDone: true,         // 默认跳过目录里已标 ✓ 的：不重复刷已经完成的视频
    resumePaused: true,     // 播放器被暂停时尝试续播
    slow: false,            // 平台加载慢：点开后的等待时间翻倍
    maxWaitMin: 20,         // 单个视频最长等待（分钟），超时就跳过
    maxNoStartSec: 90,      // 一直没能开始播放，多久后跳过（避免干等到超时）
    confirmSec: 12,         // 播完后停留几秒，等平台上报完成 / 目录打 ✓
    autoSlowdown: true,     // 连续几个平台没打勾时自动降到 1x
    maxVideos: 100,         // 单轮最多处理多少个视频（硬上限，保证一定会停）
    minGapMs: 1200,         // 两次点击之间的最小间隔，避免被平台判异常
    maxIdleScroll: 3,       // 找不到视频时最多滚动几轮
  };
  let st = {
    running: false, phase: "idle", done: 0, total: 0, skipped: 0,
    current: "", watch: "", log: [], startedAt: 0, updatedAt: 0, stoppedByUser: false,
    speed: cfg.speed, startKey: "", unconfirmed: [], unconfirmedStreak: 0, rateAdjusted: false,
    recheckResolved: 0, recheck: null,
  };
  let handled = new Set();
  let handledTitles = new Set();   // 二级去重：条目打勾后文本会变，key 可能失效，靠标题兜底
  let clickRetries = {};
  let stopFlag = false;
  let pauseFlag = false;
  let runGeneration = 0;       // 每次启动 +1，旧循环发现代数不符就自行退出，不阻塞强制重启

  /* ---------------- 跨文档 ---------------- */
  // 遍历 iframe 树不算便宜，一轮循环里会被调用好几次，短缓存复用即可
  let docsCache = null, docsAt = 0;
  function allDocs(force) {
    if (!force && docsCache && now() - docsAt < 350) return docsCache;
    const out = [document];
    const seen = new Set([document]);
    const walk = (d, depth) => {
      if (!d || depth > 3) return;
      let frames = [];
      try { frames = Array.prototype.slice.call(d.querySelectorAll("iframe, frame")); } catch (e) { return; }
      frames.forEach((f) => {
        let cd = null;
        try { cd = f.contentDocument; } catch (e) { return; }   // 跨域 iframe 读不到，跳过
        if (!cd || !cd.body || seen.has(cd)) return;
        seen.add(cd); out.push(cd);
        walk(cd, depth + 1);
      });
    };
    walk(document, 1);
    docsCache = out; docsAt = now();
    return out;
  }

  function visible(el, minW, minH) {
    try {
      const r = el.getBoundingClientRect();
      return r.width >= (minW || 4) && r.height >= (minH || 4);
    } catch (e) { return false; }
  }

  /* ---------------- 状态 ---------------- */
  function save() {
    st.updatedAt = now();
    try { chrome.storage.local.set({ [STATE_KEY]: JSON.parse(JSON.stringify(st)) }); } catch (e) {}
    paint();
  }
  function note(msg) {
    st.log.unshift(`${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ${msg}`);
    if (st.log.length > 12) st.log.length = 12;
    save();
  }

  /* ---------------- 浮窗（随时可见、随时可停） ---------------- */
  let floatEl = null, lastPaintHtml = "";
  function paint() {
    if (!floatEl) return;
    const phaseText = {
      idle: "待机", scan: "正在找下一个视频", open: "正在点开视频",
      watch: "正在看视频", done: "已完成", stopped: "已停止", paused: "已暂停",
    }[st.phase] || st.phase;
    const body = floatEl.querySelector(".qvb-body");
    if (body) {
      const html =
        `<b>${escapeHtml(phaseText)}</b>　已看 <b>${st.done}</b> 个` +
        (st.current ? `<br><span class="qvb-cur">${escapeHtml(st.current.slice(0, 46))}</span>` : "") +
        (st.watch ? `<br><span class="qvb-cur">进度 ${escapeHtml(st.watch)}</span>` : "") +
        (st.recheck ? `<br><span class="qvb-log">刷新核对：${(st.recheck.resolved || []).length}/${st.recheck.total} 已显示完成</span>` : "") +
        (st.unconfirmed && st.unconfirmed.length
          ? `<br><span class="qvb-log">⚠ ${st.unconfirmed.length} 个待复核（可能要刷新才显示 ✓）</span>` : "") +
        (st.log.length ? `<br><span class="qvb-log">${escapeHtml(st.log[0].slice(0, 60))}</span>` : "");
      // 内容没变就别碰 DOM，避免每秒重建节点带来的抖动
      if (html !== lastPaintHtml) { body.innerHTML = html; lastPaintHtml = html; }
    }
    const pauseBtn = floatEl.querySelector(".qvb-pause");
    if (pauseBtn) {
      const txt = pauseFlag ? "继续" : "暂停";
      if (pauseBtn.textContent !== txt) pauseBtn.textContent = txt;
    }
  }
  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&" + "amp;")
      .replace(/</g, "&" + "lt;")
      .replace(/>/g, "&" + "gt;")
      .replace(/"/g, "&" + "quot;");
  }
  function buildFloat() {
    if (document.getElementById("qa-video-brush")) return;
    const css = document.createElement("style");
    css.textContent = `
      #qa-video-brush{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483646;
        background:#fff;border:1px solid #d8dee9;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.16);
        font:12px/1.5 system-ui,"Microsoft YaHei",sans-serif;color:#222;padding:8px 10px;min-width:250px;max-width:420px}
      #qa-video-brush .qvb-head{display:flex;align-items:center;gap:8px;font-weight:600;color:#1d4ed8;margin-bottom:4px}
      #qa-video-brush .qvb-head span{flex:1}
      #qa-video-brush button{border:0;border-radius:6px;padding:3px 9px;font-size:11px;cursor:pointer;
        background:#e2e8f0;color:#334155}
      #qa-video-brush button.qvb-stop{background:#fee2e2;color:#b91c1c}
      #qa-video-brush .qvb-body{color:#334155}
      #qa-video-brush .qvb-cur,#qa-video-brush .qvb-log{color:#64748b;font-size:11px}`;
    document.head.appendChild(css);
    floatEl = document.createElement("div");
    floatEl.id = "qa-video-brush";
    floatEl.innerHTML =
      `<div class="qvb-head"><span>自动看视频（不碰作业）</span>` +
      `<button class="qvb-pause">暂停</button><button class="qvb-stop">停止</button></div>` +
      `<div class="qvb-body"></div>`;
    document.body.appendChild(floatEl);
    floatEl.querySelector(".qvb-pause").addEventListener("click", () => {
      pauseFlag = !pauseFlag;
      st.phase = pauseFlag ? "paused" : "scan";
      note(pauseFlag ? "已暂停，点「继续」恢复" : "已继续");
      paint();
    });
    floatEl.querySelector(".qvb-stop").addEventListener("click", () => stop(true));
    paint();
  }
  function removeFloat() { if (floatEl) { floatEl.remove(); floatEl = null; } }

  /* ---------------- 左侧目录识别 ----------------
   * 目录里每个任务点是一个短标签（视频 / 作业 / 图文 / 讨论 …）+ 标题。
   * 以「视频」标签为锚点，向上找它所属的条目行；只收集 type=video 的条目。
   */
  const SKIP_LABEL = /^(作业|测验|考试|讨论|图文|阅读材料|文档|课件|音频|直播|问卷|签到|资料|链接)$/;
  const DONE_RE = /(已完成|已看完|已学完|已观看|100%|100％|finished|completed|watched|learned|done)/i;
  const FORBIDDEN_BTN = /(提交|交卷|确定|确认|下一题|上一题|查看答案|答案解析)/;

  function itemRow(el) {
    let p = el, fallback = null;
    for (let i = 0; i < 7 && p; i++) {
      p = p.parentElement;
      if (!p) break;
      const t = norm(p.textContent || "");
      if (!t || t.length > 140) break;
      // 一个容器里同时出现多种类型标签 → 到顶了，再往上就是整个章节，不能用
      const hits = (t.match(/视频|作业|测验|考试|讨论|图文/g) || []).length;
      if (hits >= 2 && t.length > 24) break;
      const cls = String(p.className || "");
      const rowish = /^(LI|TR|A|BUTTON)$/.test(p.tagName)
        || /(item|node|cell|row|task|resource|leaf|card|list|unit)/i.test(cls);
      if (t.length >= 4 && !fallback) fallback = p;
      if (rowish && t.length >= 4) return p;
    }
    return fallback || el.parentElement || el;
  }

  // 条目「身份」：平台打勾后会在行里加一个 ✓ 图标 / 「已完成」文字 / 进度数字，
  // 直接用整行文本做 key 会变，导致同一条被当成新视频反复点、永远不结束。
  function titleKey(text) {
    return norm(text)
      .replace(DONE_RE, "")
      .replace(/[√✓✔]/g, "")
      .replace(/\d{1,3}:\d{2}(\s*\/\s*\d{1,3}:\d{2})?/g, "")
      .replace(/[\s·、,，.。:：;；\-—_/\\()（）[\]]/g, "")
      .slice(0, 60);
  }
  function pendingName(p) { return typeof p === "string" ? p : (p && p.name) || "视频"; }

  // 更强的身份兜底：把「视频 / 已完成」这类标签去掉后，按字符集合比较。
  // 平台打勾前后常把标签换个位置（「视频 一、绪论」→「一、绪论 已完成 视频」），
  // 单靠 titleKey 的字符串顺序会认成两个条目 → 再点一遍，也就是「回头刷」。
  function titleSig(text) {
    return titleKey(text)
      .replace(/视频|作业|测验|考试|已完成|已看完|已学完|未完成/g, "")
      .split("").sort().join("").slice(0, 80);
  }
  function markSeen(item) {
    if (!item) return;
    handled.add(item.key);
    handledTitles.add(titleKey(item.text));
    handledTitles.add("sig:" + titleSig(item.text));
  }
  function isSeen(item) {
    if (!item) return true;
    return handled.has(item.key) ||
      handledTitles.has(titleKey(item.text)) ||
      handledTitles.has("sig:" + titleSig(item.text));
  }

  function itemKey(el, row, text) {
    let p = el;
    for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
      if (!p.getAttribute) continue;
      // 平台常把节点 id 放在 data-* 上，短值（如 "v1"）也算数
      for (const a of ["data-node-id", "data-nodeid", "data-id", "data-key", "data-node"]) {
        const v = p.getAttribute(a);
        if (v && String(v).trim()) return "id:" + v;
      }
      // 普通 id 只认「条目行级」元素；ul / 大容器的 id 会让所有条目撞成同一个 key
      const rowish = /^(LI|TR|A|BUTTON)$/.test(p.tagName)
        || /(item|node|cell|row|task|resource|leaf|card)/i.test(String(p.className || ""));
      const idv = p.getAttribute("id");
      if (rowish && idv) return "id:" + idv;
    }
    return "t:" + titleKey(text);
  }

  // 完成图标：雨课堂这类目录在条目右侧放一个圆底白勾（iconfont / svg / img），
  // 通常没有文字，所以除了 class 和「已完成」文字，还要认图标本身。
  // 「tick」会命中 ticket、「icon-right」是很多平台的普通右箭头、「success」太宽，
  // 都会把没看完的条目标成完成 → 直接漏刷。这里只留足够明确的完成类名。
  const CHECK_RE = /(check|checked|gou|duigou|dagou|done|finish|complete|wancheng|yiwan|icon-tick)/i;
  function hasCheckIcon(row) {
    if (!row || !row.querySelectorAll) return false;
    let els;
    try { els = row.querySelectorAll("i,span,svg,img,em,b,strong,button,div"); } catch (e) { return false; }
    for (let i = 0; i < Math.min(els.length, 40); i++) {
      const el = els[i];
      const raw = [el.className, el.id,
        el.getAttribute && el.getAttribute("aria-label"),
        el.getAttribute && el.getAttribute("title"),
        el.getAttribute && el.getAttribute("src")].filter(Boolean).join(" ");
      if (CHECK_RE.test(String(raw))) return true;
      const t = norm(el.textContent || "");
      if (/^[√✓✔]{1,2}$/.test(t) || /^(已完成|已看完|已学完)$/.test(t)) return true;
      // iconfont 常把勾放在 ::before 里，只对图标类元素查伪元素，避免逐元素触发重排
      if (/icon/i.test(String(raw))) {
        try {
          const c = String(window.getComputedStyle(el, "::before").content || "");
          if (/[√✓✔]/.test(c) || CHECK_RE.test(c)) return true;
        } catch (e) {}
      }
    }
    return false;
  }

  function isDone(el, row) {
    const scopes = [el, el.parentElement, row].filter(Boolean);
    for (const s of scopes) {
      const cls = String(s.className || "");
      if (/(^|[-_ ])(done|finish|finished|complete|completed|watched|visited|learned|read)([-_ ]|$)/i.test(cls)) return true;
      const t = norm(s.textContent || "");
      if (t.length <= 60 && DONE_RE.test(t)) return true;
    }
    return hasCheckIcon(row || el.parentElement || el);
  }

  // SPA 重渲染后旧的 item.row 会脱离文档，按 key 重新取一次当前条目
  function findItemByKey(key) {
    if (!key) return null;
    const items = collectItems();
    for (let i = 0; i < items.length; i++) if (items[i].key === key) return items[i];
    return null;
  }

  function collectItems() {
    const out = [];
    for (const d of allDocs()) {
      let els;
      try { els = d.querySelectorAll("span,div,a,button,li,p,em,i,b,label,strong,td"); } catch (e) { continue; }
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        // 性能关键：先用 children 数量做零成本过滤，再读文本。
        // innerText 会强制浏览器重排，在几百条目的目录里逐个读就是卡顿主因；改用 textContent。
        if (el.children && el.children.length > 1) continue;
        const t = norm(el.textContent || "");
        if (!t || t.length > 4) continue;
        const type = t === "视频" ? "video" : (SKIP_LABEL.test(t) ? "skip" : "");
        if (!type) continue;
        if (!visible(el, 4, 4)) continue;
        const row = itemRow(el);
        const text = norm(row && row.textContent) || t;
        if (text.length > 150) continue;
        // 一行里出现独立的「作业 / 测验 / 考试」类型标签，说明这是容器或混合任务点，保守跳过
        if (type === "video" && /(^|\s)(作业|测验|考试)(\s|$)/.test(text)) continue;
        out.push({
          type, tagEl: el, row, text, doc: d, order: out.length,
          done: isDone(el, row), key: itemKey(el, row, text),
          top: (() => { try { return el.getBoundingClientRect().top; } catch (e) { return 0; } })(),
        });
      }
    }
    out.sort((a, b) => a.order - b.order);
    return out;
  }

  // 每轮重新扫描目录时，回头看看之前「当前页没看到 ✓」的条目现在有没有打勾。
  // 平台常在切换节点（或刷新页面）之后才把完成状态渲染进目录。
  function recheckPending(items) {
    if (!st.unconfirmed || !st.unconfirmed.length) return 0;
    const list = items || collectItems();
    const still = [];
    let resolved = 0;
    for (const p of st.unconfirmed) {
      const name = pendingName(p), key = (p && p.key) || "", nk = titleKey(name);
      const hit = (key && list.find((x) => x.type === "video" && x.key === key))
        || list.find((x) => x.type === "video" &&
            (titleKey(x.text).indexOf(nk) >= 0 || nk.indexOf(titleKey(x.text)) >= 0));
      if (hit && isDone(hit.tagEl, hit.row)) resolved++;
      else still.push(p);
    }
    if (resolved) {
      st.recheckResolved = (st.recheckResolved || 0) + resolved;
      st.unconfirmed = still;
      st.unconfirmedStreak = 0;
      note(`复核：${resolved} 个视频现在已显示 ✓，已从待复核清单移除`);
      save();
    }
    return resolved;
  }

  // 用户点「刷新页面并核对完成」后：只读核对一次，不启动自动流程、不点任何视频
  function doRecheck(old) {
    const pending = (old && old.unconfirmed) || [];
    const items = collectItems();
    const done = [], left = [];
    for (const p of pending) {
      const name = pendingName(p), key = (p && p.key) || "", nk = titleKey(name);
      const hit = (key && items.find((x) => x.type === "video" && x.key === key))
        || items.find((x) => x.type === "video" &&
            (titleKey(x.text).indexOf(nk) >= 0 || nk.indexOf(titleKey(x.text)) >= 0));
      (hit && isDone(hit.tagEl, hit.row) ? done : left).push(name);
    }
    st.running = false;
    st.phase = "idle";
    st.current = ""; st.watch = "";
    st.unconfirmed = left;
    st.recheck = { total: pending.length, resolved: done, pending: left, at: now() };
    buildFloat();
    note(`刷新核对：${done.length}/${pending.length} 个已显示 ✓（没有继续刷视频）`);
    save();
    return { ok: true, total: pending.length, resolved: done, pending: left };
  }

  // 目录里的「选中态」类名：必须是完整的一段，不能靠子串匹配。
  // 以前用 [class*=active] 会把 inactive / activity 也算进来，很容易把侧边栏
  // 或章节容器当成「当前条目」，于是从第一条开始刷 —— 表现就是「回头刷」。
  const ACTIVE_CLS_RE = /^(is[-_])?(active|current|selected|playing|on)$/;
  function classIsActive(cls) {
    return String(cls || "").toLowerCase().split(/\s+/).some((c) =>
      ACTIVE_CLS_RE.test(c) || /-(active|current|selected|playing)$/.test(c));
  }

  // 定位「当前页正在看的视频」：目录选中态 → URL node_id → 页面标题
  // 找不到就老实返回空，交给 applyStartFromCurrent 用「第一个未完成」兜底。
  // 绝不拿「视口里第一个条目」猜：目录滚在顶部时那永远是第一条 → 一定回头。
  function findCurrentKey(items) {
    const videos = items.filter((x) => x.type === "video");
    if (!videos.length) return "";
    for (const d of allDocs()) {
      let els;
      try { els = d.querySelectorAll("[class*=active],[class*=selected],[class*=current],[aria-selected=true]"); }
      catch (e) { continue; }
      for (let i = 0; i < els.length; i++) {
        const el = els[i];
        const ariaOn = !!(el.getAttribute && el.getAttribute("aria-selected") === "true");
        if (!ariaOn && !classIsActive(el.className)) continue;   // 排除 inactive / activity 等假命中
        const t = norm(el.textContent || "");
        if (!t || t.length > 120) continue;
        // 1) 选中态就在条目行上、或行内的某个标记上
        const inside = videos.find((x) => x.row === el ||
          (x.row && x.row.contains && x.row.contains(el)));
        if (inside) return inside.key;
        // 2) 选中态在容器上：只有恰好包住一个视频条目时才算（章节容器里有多个，不能当当前条目）
        const holders = videos.filter((x) => el.contains && el.contains(x.row));
        if (holders.length === 1) return holders[0].key;
      }
    }
    const m = location.href.match(/[?&](?:node_id|nodeId|id)=([^&#]+)/);
    if (m) {
      const hit = videos.find((x) => {
        let q = x.tagEl;
        for (let i = 0; i < 4 && q; i++, q = q.parentElement) {
          if (q.getAttribute && q.getAttribute("data-node-id") === m[1]) return true;
        }
        return false;
      });
      if (hit) return hit.key;
    }
    const title = norm(document.title || "");
    if (title.length >= 4) {
      const hit = videos.find((x) => {
        const t = norm(x.text).replace(/^视频\s*/, "");
        return t.length >= 4 && (title.indexOf(t) >= 0 || t.indexOf(title) >= 0);
      });
      if (hit) return hit.key;
    }
    return "";
  }

  // 和答题「从当前题开始」一致：前面的全部不回头；当前这条若已完成就从下一条开始
  function applyStartFromCurrent(videos) {
    const key = findCurrentKey(videos);
    if (!key) {
      // 定位不到当前页时，以前直接「从第一个视频开始」—— 如果用户已经刷到中段，
      // 就会一头扎回开头重复刷。改成从「第一个未完成的」开始，已完成的全部占位。
      const firstUndone = videos.findIndex((x) => !x.done);
      if (firstUndone < 0) {
        videos.forEach(markSeen);
        note("目录里的视频都已标为完成，本轮没有需要刷的（可刷新页面核对）");
        return;
      }
      videos.slice(0, firstUndone).forEach(markSeen);
      st.startKey = videos[firstUndone].key;
      note(firstUndone > 0
        ? `没定位到当前页，已跳过前面 ${firstUndone} 个已完成的视频，从下一个未完成开始`
        : "没定位到当前页视频，从目录第一个未完成的视频开始");
      return;
    }
    const idx = videos.findIndex((x) => x.key === key);
    if (idx < 0) return;
    videos.slice(0, idx).forEach(markSeen);   // 打勾会让 key 变，标题也要占位，否则会「回头」点前面的
    st.startKey = key;
    if (isDone(videos[idx].tagEl, videos[idx].row)) {
      markSeen(videos[idx]);
      note(`当前页视频已完成：跳过前面 ${idx} 个 + 本条，从下一个开始`);
    } else {
      note(`从当前页视频开始：跳过前面 ${idx} 个，不回头`);
    }
  }

  function diagnose() {
    return collectItems().slice(0, 120).map((x) => ({
      type: x.type, text: x.text.slice(0, 90), done: x.done, key: x.key,
      clickable: !!clickCandidates(x).length,
    }));
  }

  /* ---------------- 点击目标 ---------------- */
  function clickCandidates(item) {
    const list = [];
    const push = (el) => {
      if (!el || list.indexOf(el) >= 0) return;
      const t = norm(el.textContent || "");
      if (t.length < 40 && FORBIDDEN_BTN.test(t)) return;       // 绝不点提交类按钮
      if (/(^|\s)(作业|测验|考试)(\s|$)/.test(t) && t.length < 30) return;
      list.push(el);
    };
    // 1) 「视频」标签自身若是链接/按钮，优先点它（截图里就是这种蓝色标签）
    try { push(item.tagEl.closest("a[href],button,[role=button]")); } catch (e) {}
    push(item.tagEl);
    // 2) 条目行里的链接/按钮
    try {
      Array.prototype.slice.call(item.row.querySelectorAll("a[href],button,[role=button]"))
        .slice(0, 4).forEach(push);
    } catch (e) {}
    // 3) 行内「标题」子元素：很多 Vue 组件把 @click 绑在标题上，只点外层行不会触发
    //    （事件不向下冒泡），这是「点了没反应」最常见的原因
    try {
      Array.prototype.slice.call(item.row.children).slice(0, 5).forEach((c) => {
        const t = norm(c.textContent || "");
        if (t && t.length >= 4 && t.length <= 80) push(c);
      });
    } catch (e) {}
    // 4) 整行兜底
    push(item.row);
    return list;
  }

  function playerSnapshot() {
    // 只取一个播放器签名 + 简单的类选择器计数；不再全文档扫 [class*=...] 属性选择器
    let sig = "";
    const v = findVideo();
    if (v) {
      sig = `${v.currentSrc || v.src || ""}|${Number(v.duration) || 0}` +
            `|${Math.round(Number(v.currentTime) || 0)}|${v.paused ? 1 : 0}`;
    }
    let marks = 0, selected = "";
    try {
      marks = document.querySelectorAll(".completed,.complete,.finished,.done,.watched,.is-active,.active").length;
      const s = document.querySelector("[class*=active][class*=node], li.active, .is-active");
      if (s) selected = norm(s.textContent || "").slice(0, 40);
    } catch (e) {}
    return location.href + "|" + sig + "|" + marks + "|" + selected;
  }

  async function tryClick(item, gen, onJustClicked) {
    const before = playerSnapshot();
    const targets = clickCandidates(item);
    let sampled = false;
    for (let ti = 0; ti < targets.length; ti++) {
      if (stopFlag || gen !== runGeneration) return false;
      const target = targets[ti];
      // 虚拟滚动 / IntersectionObserver 的目录，视口外的条目点了往往不生效；
      // 同一行的候选位置相同，整行只滚一次，避免反复滚动页面造成抖动
      if (ti === 0) {
        try { target.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (e) {}
        await sleep(60);
      }
      try { target.click(); } catch (e) { continue; }
      // 点击动作刚完成就采样一次完成状态，作为「新出现 ✓」的基线
      if (!sampled) { sampled = true; if (onJustClicked) onJustClicked(); }

      // 播放器常异步加载：第一个候选多给一点时间，后续候选短一些
      const boost = cfg.slow ? 1.8 : 1;
      const end = now() + Math.round((ti === 0 ? 2600 : 1100) * boost);
      while (!stopFlag && gen === runGeneration && now() < end) {
        await sleep(300);
        if (playerSnapshot() !== before) return true;
      }
      if (stopFlag || gen !== runGeneration) return false;

      // 只监听 pointerdown / mousedown 的组件：补发一次完整鼠标序列
      if (ti === 0) {
        try {
          const o = { bubbles: true, cancelable: true, view: window };
          target.dispatchEvent(new MouseEvent("pointerdown", o));
          target.dispatchEvent(new MouseEvent("mousedown", o));
          target.dispatchEvent(new MouseEvent("mouseup", o));
          target.dispatchEvent(new MouseEvent("click", o));
        } catch (e) {}
        const end2 = now() + Math.round(1200 * boost);
        while (!stopFlag && gen === runGeneration && now() < end2) {
          await sleep(300);
          if (playerSnapshot() !== before) return true;
        }
      }
    }
    return false;
  }

  /* ---------------- 播放监测 ---------------- */
  // 页面里常有多个 <video>（缩略图 / 预加载 / 隐藏的音轨），以前「第一个可见的」
  // 可能抓到那个不会播的小窗，浮窗就一直显示 0 / 0 s，看起来像「进度不动」。
  // 现在按「正在播 + 时长已知 + 面积大」打分挑主播放器。
  function findVideo() {
    const cands = [];
    for (const d of allDocs()) {
      let vs;
      try { vs = d.querySelectorAll("video"); } catch (e) { continue; }
      for (let i = 0; i < vs.length; i++) {
        const v = vs[i];
        let r;
        try { r = v.getBoundingClientRect(); } catch (e) { continue; }
        if (r.width < 60 || r.height < 40) continue;
        let score = Math.min(400, (r.width * r.height) / 4000);
        try {
          if (!v.paused && !v.ended) score += 50;     // 正在播的基本就是它
          if (v.readyState >= 2) score += 8;
          if (Number(v.duration) > 0) score += 12;
          if (Number(v.currentTime) > 0.5) score += 20;
          if (v.ended) score -= 10;
        } catch (e) {}
        cands.push({ v, score });
      }
    }
    if (!cands.length) {
      // 兜底：还没布局的 video（刚插入/在 iframe 里），先返回一个，等下一轮再判断
      for (const d of allDocs()) {
        let vs;
        try { vs = d.querySelectorAll("video"); } catch (e) { continue; }
        if (vs.length) return vs[0];
      }
      return null;
    }
    cands.sort((a, b) => b.score - a.score);
    return cands[0].v;
  }

  // 当前播放点前面已缓存多少秒：用来区分「网络缓冲」和「播放器卡死」
  function bufferedAhead(v, cur) {
    try {
      const b = v.buffered;
      for (let i = 0; i < b.length; i++) {
        if (cur >= b.start(i) - 0.5 && cur <= b.end(i) + 0.2) return b.end(i) - cur;
      }
    } catch (e) {}
    return 0;
  }

  function videoState(v) {
    const dur = Number(v.duration) || 0;
    const cur = Number(v.currentTime) || 0;
    return {
      dur, cur,
      rate: Number(v.playbackRate) || 1,
      // 以前写 dur - cur <= 1.5：2x 播放每秒采样时会在真正播完前 1~1.5 秒
      // 就判定结束并立刻切走，平台的 ended 事件/心跳压根没触发 → 不打勾。
      // 现在只认播放器真的 ended，或进度已经贴到尾巴（0.2 秒内）。
      ended: !!v.ended || (dur > 0 && cur >= dur - 0.2),
      paused: !!v.paused,
    };
  }

  /* ---------------- 倍速强制（只在真的选了 >1x 时才启用） ----------------
   * 重要教训（v0.9.25）：以前的实现每秒用 timeupdate 往 playbackRate 里写值，
   * 平台播放器也会在 ratechange 里写回自己的状态 —— 两边对刷，播放器反复重建
   * 解码管线，表现就是「浮窗显示 Nx，但视频进度一动不动」。
   * 所以改成保守模式：
   *   - 1x（默认）时完全不介入：不写 playbackRate、不挂事件、不点倍速菜单；
   *   - >1x 时最多每 400ms 写一次；3 秒内被平台改回 5 次以上就直接认输退回 1x，
   *     宁可慢一点也要让视频正常走完（完成度优先）。
   */
  let rateGuardV = null, rateGuardLast = 0, rateFights = 0, rateFightAt = 0;
  function targetRate() { return (st.rateAdjusted ? 1 : (cfg.speed > 0 ? cfg.speed : 1)); }
  function giveUpRate(v, why) {
    if (st.rateAdjusted) return;
    st.rateAdjusted = true;
    cfg.speed = 1; st.speed = 1; cfg.rateLocked = true;
    try { if (v) v.playbackRate = 1; } catch (e) {}
    note(`${why}，已自动改成 1 倍速（否则进度会卡住，完成度优先）`);
  }
  function reassertRate(v, force) {
    try {
      const t = targetRate();
      if (t <= 1.001) return;                    // 1x：一个字节都不碰播放器
      const nowT = now();
      if (!force && nowT - rateGuardLast < 400) return;
      if (!v || Math.abs(Number(v.playbackRate) - t) <= 0.001) return;   // 已经是目标值，不重复写
      // 平台在跟我们抢：3 秒内被改回 5 次以上就认输，避免把播放器顶到卡死
      if (nowT - rateFightAt > 3000) { rateFightAt = nowT; rateFights = 0; }
      if (++rateFights > 5) { giveUpRate(v, "播放器锁定了倍速"); return; }
      rateGuardLast = nowT;
      v.playbackRate = t;
    } catch (e) {}
  }
  function guardRate(v) {
    if (targetRate() <= 1.001) return;           // 1x 不挂任何倍速钩子
    if (!v || v === rateGuardV) return;
    rateGuardV = v;
    // 只监听 ratechange：timeupdate 每秒几十次，是之前对刷卡死的主因
    try { v.addEventListener("ratechange", () => { if (st.running) reassertRate(v, true); }); } catch (e) {}
    reassertRate(v, true);
  }

  // 在播放器容器里找「倍速 / 速度」控制，打开后点匹配目标倍速的选项。
  // 仅 >1x 时尝试一次；只点短文本的小按钮，绝不点播放器容器（会误触暂停）。
  let speedUiTriedFor = null;
  function trySetPlayerSpeedUI(v) {
    if (targetRate() <= 1.001) return;     // 1x 不点任何菜单
    if (speedUiTriedFor === v) return;     // 同一 video 只尝试一次，避免反复点
    speedUiTriedFor = v;
    try {
      const t = targetRate();
      const tStr = (t % 1 === 0) ? String(t) : t.toFixed(1);   // 2 -> "2", 1.5 -> "1.5"
      const tStrX = tStr + "x";
      // 1) 找到倍速按钮（文本含 倍速/速度/速率，或 class 含 rate/speed，或在 video 附近且有 x 文本）
      const cand = [];
      for (const d of allDocs()) {
        let els;
        try { els = d.querySelectorAll("button,div,span,a,li"); } catch (e) { continue; }
        for (const el of els) {
          if (el.closest && el.closest("#qa-video-brush,#qa-panel")) continue;  // 别点自己的浮窗
          if (v && (el === v || el.contains(v))) continue;                      // 绝不点播放器本体/容器
          if (el.querySelector && el.querySelector("video")) continue;
          const txt = norm(el.textContent || "");
          if (txt.length > 16) continue;          // 只看真正的短标签，长文本说明是大容器
          const low = txt.toLowerCase();
          const cls = String(el.className || "").toLowerCase();
          const rect = (() => { try { return el.getBoundingClientRect(); } catch (e) { return null; } })();
          if (!rect || rect.width < 8 || rect.height < 8) continue;
          // 必须在视频播放器附近（屏幕下半部分或 video 矩形附近），避免误点页面其它控件
          if (v) {
            const vr = (() => { try { return v.getBoundingClientRect(); } catch (e) { return null; } })();
            if (vr) {
              if (rect.bottom < vr.top - 60 || rect.top > vr.bottom + 120 || rect.left > vr.right + 200 || rect.right < vr.left - 200) continue;
              if (rect.width * rect.height > Math.max(40000, vr.width * vr.height * 0.5)) continue;  // 盖住半个视频的容器不点
            }
          }
          if (/倍速|速度|速率|playbackrate|倍速播放/.test(low) || /rate|speed/.test(cls)) { cand.push({ el, score: 0 }); continue; }
          if (/\d+(\.\d+)?x\b/.test(low) && (low.includes("倍") || /rate|speed/.test(cls))) cand.push({ el, score: 1 });
        }
      }
      if (!cand.length) return;
      cand.sort((a, b) => a.score - b.score);
      // 2) 点开倍速菜单（最多试 3 个候选，避免把页面点乱）
      let menu = null;
      for (const c of cand.slice(0, 3)) {
        try { c.el.click(); } catch (e) {}
        // 点开后查找含目标倍速文字的可点项
        for (const d of allDocs()) {
          let opts;
          try { opts = d.querySelectorAll("li,div,span,a,button"); } catch (e) { continue; }
          for (const o of opts) {
            if (o.closest && o.closest("#qa-video-brush,#qa-panel")) continue;
            if (v && (o === v || o.contains(v))) continue;
            const ot = norm(o.textContent || "").toLowerCase().replace(/\s+/g, "");
            if (ot === tStrX || ot === tStr + ".0x" ||
                (ot.replace("x", "") === tStr && /倍速|速度|rate|speed|x/.test(ot))) {
              const orc = (() => { try { return o.getBoundingClientRect(); } catch (e) { return null; } })();
              if (orc && orc.width > 4 && orc.height > 4) { menu = o; break; }
            }
          }
          if (menu) break;
        }
        if (menu) break;
      }
      if (menu) {
        try { menu.click(); note(`已通过播放器自带倍速菜单设为 ${tStrX}`); } catch (e) {}
      }
    } catch (e) {}
  }

  // 点播放器内部的「大播放按钮」遮罩（video.js / 自研播放器常见）。
  // 只点中心落在 video 矩形内的元素，避免误点到「下一集 / 播放列表」；也排除自己的浮窗。
  function clickPlayOverlay(v) {
    let vr;
    try { vr = v.getBoundingClientRect(); } catch (e) { return false; }
    const sels = [
      ".vjs-big-play-button", "[class*=big-play]", "[class*=play-button]",
      "[class*=play-btn]", "[class*=play-icon]", "button[aria-label*=播放]",
      "[title=播放]", "[aria-label=播放]",
    ];
    for (const d of allDocs()) {
      for (const sel of sels) {
        let els;
        try { els = d.querySelectorAll(sel); } catch (e) { continue; }
        for (let i = 0; i < els.length; i++) {
          const el = els[i];
          if (!visible(el, 16, 16)) continue;
          if (el.closest && el.closest("#qa-video-brush")) continue;
          const label = norm(el.textContent || "") + " " +
            ((el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title"))) || "") + " " +
            String(el.className || "");
          if (/暂停|pause|next|下一/i.test(label)) continue;
          let r;
          try { r = el.getBoundingClientRect(); } catch (e) { continue; }
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          if (cx < vr.left || cx > vr.right || cy < vr.top || cy > vr.bottom) continue;
          try { el.click(); return true; } catch (e) {}
        }
      }
    }
    return false;
  }

  // Chrome 会拦截脚本发起的「有声自动播放」，但允许静音自动播放。
  // 所以卡在 0 秒时先静音 + 点播放遮罩 + play()，播起来后再尝试把声音还回来。
  function ensurePlaying(v, p, ctx) {
    // 倍速干预只在 >1x 时做；1x 时绝不写 playbackRate（写了反而可能让播放器卡住）
    if (targetRate() > 1.001) {
      guardRate(v);
      trySetPlayerSpeedUI(v);
      reassertRate(v, false);
    }
    if (!cfg.resumePaused) return;
    if (v.paused) {
      try { v.muted = true; } catch (e) {}
      // 最多点 3 次遮罩，避免某些播放器的按钮是 toggle 被反复点到暂停
      if (ctx.overlayTries < 3) {
        ctx.overlayTries++;
        if (clickPlayOverlay(v)) ctx.overlayClicked = true;
      }
      try { const pr = v.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) {}
      return;
    }
    if (!ctx.unmuteTried && p.cur > 0.5) {
      ctx.unmuteTried = true;
      try { v.muted = false; } catch (e) {}   // 若浏览器因此暂停，下一轮会重新静音续播
    }
  }

  async function waitFinish(item, gen, doneAtClick, doneJustAfterClick) {
    const startAt = now();
    const deadline = startAt + Math.max(1, cfg.maxWaitMin) * 60000;
    // 基线取「点击前 / 点击瞬间」：那两个时刻就已打勾的（老条目 / 点开即完成）
    // 不算本轮看完；只有之后新出现的 ✓ 才触发跳转。
    const doneBaseline = !!doneAtClick || !!doneJustAfterClick;
    const checkedDone = () => {
      if (doneBaseline) return false;
      const live = findItemByKey(item.key) || item;
      // 新节点优先；若平台把状态打在旧节点上（部分重渲染）也兼容
      return isDone(live.tagEl, live.row) || (live !== item && isDone(item.tagEl, item.row));
    };
    const ctx = { overlayTries: 0, overlayClicked: false, unmuteTried: false, endBound: null, endEvent: false };
    let sawVideo = false, lastCur = -1, idle = 0, tick = 0;
    let everProgressed = false, missing = 0, noStart = 0, warned = false, hinted = false;
    let tailHold = 0, stuckFix = 0, pauseSec = 0;

    // 播放器的 ended 事件是「真的播完」最可靠的证据，绑定一次即可
    function trackEndEvent(v) {
      if (!v || ctx.endBound === v) return;
      ctx.endBound = v;
      try { v.addEventListener("ended", () => { ctx.endEvent = true; }, { once: true }); } catch (e) {}
    }

    function markUnconfirmed() {
      const name = st.current || "视频";
      if (!st.unconfirmed) st.unconfirmed = [];
      st.unconfirmed.push({ name, key: item.key || "" });
      if (st.unconfirmed.length > 30) st.unconfirmed.shift();
      st.unconfirmedStreak++;
      note(`「${name}」当前页没看到 ✓（平台可能要刷新才显示）`);
      // 有些平台按「真实墙钟时长」而不是视频进度计时，2x 播放只有一半时长 → 永远不打勾
      if (cfg.autoSlowdown && st.unconfirmedStreak >= 2 && cfg.speed > 1 && !st.rateAdjusted) {
        cfg.speed = 1; st.speed = 1; st.rateAdjusted = true; cfg.rateLocked = true;
        note("连续 2 个没打勾，已自动改成 1 倍速（有的平台按真实观看时长计时）");
      }
    }

    // 播完别立刻点下一个：平台的完成上报常靠定时心跳，视频刚结束就切页，
    // 最后一段进度来不及上报，目录就一直不打 ✓。这里停留几秒等它确认。
    async function confirmComplete() {
      const confirmed = () => { st.unconfirmedStreak = 0; note("平台已打 ✓ 完成标记，跳到下一个视频"); };
      if (doneBaseline) return true;      // 点开时就已经是完成状态，不用再等
      if (checkedDone()) { confirmed(); return true; }
      const sec = Math.max(0, Math.min(120, Number(cfg.confirmSec) || 0));
      if (!sec) { markUnconfirmed(); return true; }
      const end = now() + sec * 1000;
      while (!stopFlag && gen === runGeneration && now() < end) {
        if (pauseFlag) { await sleep(400); continue; }
        if (checkedDone()) { confirmed(); return true; }
        st.watch = `已播完，等待平台确认（${Math.ceil((end - now()) / 1000)}s）`;
        if ((tick++ % 2) === 0) save();
        await sleep(700);
      }
      markUnconfirmed();
      return true;
    }

    while (!stopFlag && gen === runGeneration && now() < deadline) {
      if (pauseFlag) { await sleep(500); continue; }
      // 主判定：平台在目录里打上 ✓ 就视为看完，立刻进入下一个视频
      if (now() - startAt > 1200 && checkedDone()) {
        st.unconfirmedStreak = 0;
        note("检测到 ✓ 完成标记，跳到下一个视频");
        return true;
      }
      const v = findVideo();
      if (v) {
        missing = 0;
        sawVideo = true;
        trackEndEvent(v);
        const p = videoState(v);
        // 播过之后被暂停（平台弹「是否继续观看」/ 切到后台）：遮罩最多点 3 次，
        // 之后如果还停着，隔一段再放开一次重试机会，否则会一直卡住不动。
        if (p.paused && !p.ended && p.cur > 0.5) {
          pauseSec++;
          if (pauseSec === 8 || pauseSec === 25 || pauseSec === 60) {
            ctx.overlayTries = 0;
            note(pauseSec === 8 ? "播放器被暂停了，正在尝试继续播放"
                                : "视频仍停着，请手动点一下播放器中间的播放按钮");
          }
        } else if (!p.paused) pauseSec = 0;
        ensurePlaying(v, p, ctx);
        st.rateActual = p.rate;
        const rateFx = (Math.abs(p.rate - targetRate()) > 0.05)
          ? ` · 实际 ${p.rate.toFixed(1)}x⚠`   // 实际倍速与目标不一致，提示用户在骗人
          : (Math.abs(p.rate - 1) > 0.05 ? ` · ${p.rate.toFixed(1)}x` : "");
        const stuck = !p.paused && p.dur > 0 && idle >= 5;
        st.watch = p.dur > 0
          ? `${Math.round(p.cur)} / ${Math.round(p.dur)} s${rateFx}` +
            (p.paused && !everProgressed ? "（等待播放）" : (stuck ? "（卡住，正在唤醒）" : ""))
          : (p.paused ? "等待播放" : `播放中${rateFx}`);
        // 必须真的播过、且播放器确实结束（或已收到 ended 事件）才算看完；
        // 之后还要停留等平台上报，不能立刻切走。
        if ((p.ended || ctx.endEvent) && everProgressed) {
          if (v.ended || ctx.endEvent || ++tailHold >= 2) return await confirmComplete();
        } else tailHold = 0;
        if (p.cur > lastCur + 0.01) { lastCur = p.cur; idle = 0; stuckFix = 0; }
        else if (!p.paused) idle++;
        else idle = 0;                     // 暂停交给 resumePaused 处理，不算卡死

        // 进度自愈：没暂停、缓冲也够，currentTime 却一直不动 —— 多半是播放器状态机卡了。
        // 先 play() 重试，再轻微 seek 跨过卡点；都不行就提示用户，绝不默默跳过整集。
        if (!p.paused && p.dur > 0 && idle >= 6 && idle % 6 === 0) {
          const ahead = bufferedAhead(v, p.cur);
          if (Number(v.readyState) >= 2 && ahead >= 0.5) {
            stuckFix++;
            try { const pr = v.play(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) {}
            if (stuckFix >= 2) {
              try { v.currentTime = Math.min(Math.max(0, p.dur - 0.3), p.cur + 0.4); } catch (e) {}
            }
            if (stuckFix === 1) note("播放进度卡住了，正在尝试唤醒播放器");
            if (stuckFix === 4) note("多次唤醒无效：可能是平台限速/播放器风控，建议手动点一下播放器，或刷新页面后从这一集继续");
          }
        }
        if (p.cur > 0.5) { everProgressed = true; noStart = 0; }

        if (!everProgressed && p.cur < 0.5) {
          noStart++;
          if (noStart === 5 && !warned) {
            warned = true;
            note("播放器还没开始：浏览器会拦截脚本的有声自动播放，已改为静音并尝试点播放按钮");
          }
          if (noStart === 20 && !hinted) {
            hinted = true;
            note("仍没开始，请手动点一下播放器中间的播放按钮；工具会接着往下跑");
          }
          // 连续一段时间完全没开始就跳过，别干等 20 分钟
          if (noStart >= Math.max(3, cfg.maxNoStartSec)) {
            note("长时间无法开始播放，已跳过该视频（可手动点开看）");
            return false;
          }
        }
      } else if (sawVideo) {
        // SPA 换 video 时元素会短暂消失：消失本身不算看完，必须平台也标记完成
        missing++;
        if (checkedDone()) { st.unconfirmedStreak = 0; return true; }
        if (missing >= 20) { note("播放器消失且未标记完成，已跳过该视频"); return false; }
      } else {
        // 一直读不到播放器（跨域 iframe / 非 <video> 自定义播放器）也不能干等 20 分钟
        noStart++;
        if (noStart === 5 && !warned) {
          warned = true;
          note("还没找到播放器元素（可能在跨域 iframe），正在等待加载");
        }
        if (noStart >= Math.max(3, cfg.maxNoStartSec)) {
          note("一直读不到播放器，已跳过该视频，请手动点开看");
          return false;
        }
      }
      if ((tick++ % 2) === 0) save();   // 每 2 秒落一次状态，减少 storage / DOM 写入
      await sleep(1000);
    }
    return false;
  }

  /* ---------------- 左侧目录滚动 ---------------- */
  // 遍历所有容器 + getComputedStyle 也很重，2 秒内复用上次结果
  let scrollerCache = null, scrollerAt = 0;
  function leftScrollers(force) {
    if (!force && scrollerCache && now() - scrollerAt < 2000) return scrollerCache;
    const out = [];
    const w = window.innerWidth || 1440;
    for (const d of allDocs()) {
      let els;
      try { els = d.querySelectorAll("div,ul,ol,aside,nav,section"); } catch (e) { continue; }
      els.forEach((el) => {
        if (el.clientHeight < 100 || el.scrollHeight <= el.clientHeight + 8) return;
        try {
          const stl = d.defaultView && d.defaultView.getComputedStyle(el);
          if (stl && !/(auto|scroll|overlay)/.test(stl.overflowY)) return;
        } catch (e) {}
        let r;
        try { r = el.getBoundingClientRect(); } catch (e) { return; }
        out.push({ el, score: r.left < w * 0.55 ? 0 : 1, h: el.clientHeight });
      });
    }
    out.sort((a, b) => a.score - b.score || b.h - a.h);
    scrollerCache = out.slice(0, 4).map((x) => x.el);
    scrollerAt = now();
    return scrollerCache;
  }

  async function scrollForMore(round) {
    const list = leftScrollers();
    if (!list.length) return false;
    let moved = false;
    for (const el of list) {
      const before = el.scrollTop;
      el.scrollTop = Math.min(el.scrollHeight, before + Math.max(220, Math.round(el.clientHeight * 0.8)));
      if (el.scrollTop !== before) moved = true;
    }
    if (moved) return true;
    if (round === 0) {   // 到底了，回顶部再找一遍，防止之前漏掉靠上的条目
      for (const el of list) el.scrollTop = 0;
      return true;
    }
    return false;
  }

  /* ---------------- 主循环 ---------------- */
  async function loop(gen) {
    let idleScroll = 0, startApplied = false;
    try {
      while (!stopFlag && st.running && gen === runGeneration) {
        if (pauseFlag) { await sleep(500); continue; }
        // 硬上限：即使目录一直重复渲染 / 懒加载出重复条目，也一定会停下来
        if (st.done + st.skipped >= Math.max(1, Number(cfg.maxVideos) || 100)) {
          st.phase = "done";
          note(`已达到本轮最多处理 ${cfg.maxVideos} 个视频，自动停止。`);
          break;
        }

        const items = collectItems();
        recheckPending(items);          // 切换节点后目录可能刷新，✓ 这时才出现
        const videos = items.filter((x) => x.type === "video");
        if (!startApplied) { startApplied = true; applyStartFromCurrent(videos); }
        st.total = Math.max(st.total, videos.length);
        const next = videos.find((x) =>
          !isSeen(x) && (!x.done || !cfg.skipDone));

        if (next) {
          const freshTitle = !isSeen(next);
          st.current = norm(next.text).replace(/^视频\s*/, "").slice(0, 60) || "视频";
          st.watch = "";
          st.phase = "open"; save();
          const doneAtStart = isDone(next.tagEl, next.row);
          let doneJustAfterClick = false;
          const opened = await tryClick(next, gen, () => {
            const live = findItemByKey(next.key) || next;
            doneJustAfterClick = isDone(live.tagEl, live.row);
          });
          if (!opened) {
            // 没点开就别永久占位：多数是播放器加载慢 / 点错了目标，重试一轮再说
            const n = (clickRetries[next.key] || 0) + 1;
            clickRetries[next.key] = n;
            if (n < 2) {
              note(`第 ${n} 次没点开，稍等重试：${st.current}`);
              st.phase = "scan"; save();
              await interruptibleSleep(600);
              continue;
            }
            handled.add(next.key);
            st.skipped++;
            note(`点了没反应，跳过：${st.current}`);
            st.phase = "scan"; save();
            await interruptibleSleep(cfg.minGapMs);
            continue;
          }
          markSeen(next);      // 确认点开后才占位，避免漏看
          st.phase = "watch"; save();
          const finished = await waitFinish(next, gen, doneAtStart, doneJustAfterClick);
          if (finished) { st.done++; note(`看完：${st.current}`); }
          else note(`等待超时，跳过：${st.current}`);
          if (stopFlag) break;                 // 停止后别把状态又写回「扫描中」
          st.current = ""; st.watch = "";
          st.phase = "scan"; save();
          await interruptibleSleep(cfg.minGapMs);
          if (freshTitle) idleScroll = 0;   // 只有真的出现新条目才重置滚动计数，避免反复滚动
          continue;
        }

        // 没有可点的视频：往左侧目录下面滚，继续找
        if (idleScroll < cfg.maxIdleScroll && await scrollForMore(idleScroll)) {
          idleScroll++;
          st.phase = "scan"; save();
          await sleep(650);
          continue;
        }
        st.phase = "done";
        const pend = st.unconfirmed || [];
        const badge = pend.length
          ? `，其中 ${pend.length} 个当前页还没看到 ✓（${pend.slice(0, 3).map(pendingName).join("、")}${pend.length > 3 ? "…" : ""}；刷新页面后点「刷新并核对完成」可复核）`
          : "，平台均已标记完成";
        note(`没有更多视频了（已看 ${st.done} 个${badge}）。作业请自己手动点。`);
        break;
      }
    } catch (e) {
      if (gen === runGeneration) note("出错：" + ((e && e.message) || e));
    } finally {
      // 只有最新一代循环才写结束状态，避免被强制重启时旧循环把新状态改回「已停止」
      if (gen === runGeneration) {
        st.running = false;
        st.stoppedByUser = stopFlag;
        if (st.phase !== "done") st.phase = stopFlag ? "stopped" : st.phase;
        save();
      }
    }
  }

  function start(newCfg, force) {
    Object.assign(cfg, newCfg || {});
    if (st.running && !force) { note("已经在运行了"); return; }
    runGeneration++;                 // 让上一轮循环下一拍自动退出
    const gen = runGeneration;
    handled = new Set();
    handledTitles = new Set();
    clickRetries = {};
    docsCache = null; scrollerCache = null; lastPaintHtml = "";  // 新一轮重新探测
    stopFlag = false; pauseFlag = false;
    st = {
      running: true, phase: "scan", done: 0, total: 0, skipped: 0,
      current: "", watch: "", log: [], startedAt: now(), updatedAt: 0, stoppedByUser: false,
      speed: cfg.speed, rateActual: 0, startKey: "", unconfirmed: [], unconfirmedStreak: 0, rateAdjusted: false,
      recheckResolved: 0, recheck: null,
    };
    buildFloat();
    save();
    note("开始：只点「视频」，作业/测验一律跳过，随时可暂停或停止");
    if (cfg.speed > 1) {
      note(`⚠ 当前 ${cfg.speed}x：雨课堂/学堂在线等平台按真实观看时长计完成度，${cfg.speed}x 只会计约 ${(100 / cfg.speed).toFixed(0)}%，会显示「未完成」。要刷满完成度请停止后用 1x 重刷。`);
    } else {
      note("1x 模式：不改播放器倍速、不点倍速菜单，进度按真实时长累计，保证完成度");
    }
    loop(gen);
  }

  function stop(byUser) {
    stopFlag = true;
    st.running = false;
    st.phase = "stopped";
    st.stoppedByUser = !!byUser;
    save();
    note("已停止。作业仍需你自己手动完成。");
  }

  /* ---------------- 消息接口 ---------------- */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const t = msg && msg.type;
    if (!t || String(t).indexOf("qvb_") !== 0) return;
    if (t === "qvb_start") { start(msg.cfg, !!msg.force); sendResponse({ ok: true, gen: runGeneration }); }
    else if (t === "qvb_stop") { stop(true); sendResponse({ ok: true }); }
    else if (t === "qvb_pause") { pauseFlag = !pauseFlag; st.phase = pauseFlag ? "paused" : "scan"; save(); sendResponse({ ok: true, paused: pauseFlag }); }
    else if (t === "qvb_status") { sendResponse({ ok: true, state: st, cfg, gen: runGeneration }); }
    else if (t === "qvb_recheck") {
      // 刷新后重新注入的脚本用这个只读核对完成状态；storage.get 是异步的，保持消息通道
      try {
        chrome.storage.local.get(STATE_KEY, (d) => {
          let res;
          try { res = doRecheck(d && d[STATE_KEY]); }
          catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
          try { sendResponse(res); } catch (e) {}
        });
      } catch (e) { sendResponse({ ok: false, error: String(e) }); }
    }
    else if (t === "qvb_scan") { sendResponse({ ok: true, items: diagnose() }); }
    else if (t === "qvb_close") { stop(true); removeFloat(); sendResponse({ ok: true }); }
    return true;
  });

  window.__qaVideoBrush = { start, stop, get state() { return st; } };
  // 页面刷新后不自动恢复：只是把状态写成「已停止」，避免不受控地自己跑起来
  try {
    chrome.storage.local.get(STATE_KEY, (d) => {
      const old = d && d[STATE_KEY];
      if (old && old.running && !st.running) {   // 别覆盖刚被 qvb_start 拉起来的新一轮
        chrome.storage.local.set({ [STATE_KEY]: Object.assign({}, old, {
          running: false, phase: "stopped", updatedAt: now(),
          log: ["页面刷新，上一轮已自动停止（需重新点开始）"].concat(old.log || []).slice(0, 12),
        }) });
      }
    });
  } catch (e) {}
})();
