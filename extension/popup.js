const $ = (id) => document.getElementById(id);

const getBackend = async () =>
  ((await chrome.storage.local.get("backend")).backend) || "http://127.0.0.1:8787";

const escapeHtml = (s) =>
  (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let lastCombinedMd = "";
const VER = (() => { try { return (chrome.runtime.getManifest() || {}).version || "?"; } catch (e) { return "?"; } })();

(async () => {
  try { $("verTag").textContent = "v" + VER; } catch (e) {}
  $("backend").value = await getBackend();
  checkBackend();
  refreshVBrush();
})();

async function checkBackend() {
  const base = (await getBackend()).replace(/\/+$/, "");
  const el = $("bstatus");
  el.className = "bstat";
  el.textContent = "正在检测后端…";
  try {
    const r = await fetch(base + "/status", { cache: "no-store" });
    const d = await r.json();
    if (!d || !d.ok) throw new Error("bad status");
    if (d.has_key) {
      el.className = "bstat ok";
      el.textContent = `后端已连接 · ${d.model} · 每题 ${d.samples} 次采样${d.env_loaded ? " · 已读 .env" : ""}`;
    } else {
      el.className = "bstat warn2";
      el.textContent = "后端已连接，但没有 API Key —— 答题会失败。请在 server 目录建 .env 写入 OPENAI_API_KEY=你的key";
    }
  } catch (e) {
    el.className = "bstat bad";
    el.textContent = "后端未连接 —— 先在 server 目录运行 python app.py";
  }
}

$("backend").addEventListener("change", (e) => {
  chrome.storage.local.set({ backend: e.target.value.trim() }, () => checkBackend());
});

/* ---------- ① 自动看视频（左侧目录） ---------- */
const VKEY = "qaVideoBrushState";
const activeTab = async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ① 区自己的可见提示区：启动/失败反馈必须写在这里，② 区底部的 #status 经常被挤出屏幕
let vNotice = "", vNoticeUntil = 0;
function setVNotice(msg, ms) {
  vNotice = msg;
  vNoticeUntil = Date.now() + (ms || 6000);
  const box = $("vbrushStatus");
  if (box) { box.textContent = msg; box.style.display = "block"; }
  const s2 = $("status");
  if (s2) s2.textContent = msg;
}

async function ensureVBrush(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["video-brush.js"] });
}
async function vSend(tabId, msg) {
  try { return await chrome.tabs.sendMessage(tabId, msg); }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

async function refreshVBrush() {
  let s = null;
  try { s = (await chrome.storage.local.get(VKEY))[VKEY]; } catch (e) {}
  const box = $("vbrushStatus");
  if (!box) return;
  if (vNotice && Date.now() < vNoticeUntil) return;   // 别把启动/报错提示刷掉
  vNotice = "";
  if (!s) {
    box.textContent = `尚未开始。停在课程目录页，点上面的「开始」即可。（扩展 v${VER}；点击无反应时先在 chrome://extensions 刷新扩展）`;
  } else {
    const phase = {
      idle: "待机", scan: "正在找下一个视频", open: "正在点开视频",
      watch: "正在看视频", done: "已完成", stopped: "已停止", paused: "已暂停",
    }[s.phase] || s.phase;
    const rateActual = (typeof s.rateActual === "number" && s.rateActual > 0) ? s.rateActual : null;
    const rateTxt = rateActual
      ? (Math.abs(rateActual - (s.speed || 1)) > 0.05
          ? ` · 设定 ${escapeHtml(String(s.speed || 1))}x / 实际 ${rateActual.toFixed(1)}x⚠`
          : ` · 实际 ${rateActual.toFixed(1)}x`)
      : (s.speed && s.speed !== 1 ? ` · ${escapeHtml(String(s.speed))}x` : "");
    box.innerHTML = `<b>${escapeHtml(phase)}</b>　已看 <b>${s.done || 0}</b> 个` +
      (s.total ? ` / ${s.total}` : "") +
      rateTxt +
      (s.current ? `<br>当前：${escapeHtml(s.current)}` : "") +
      (s.watch ? `<br>进度：${escapeHtml(s.watch)}` : "") +
      (s.recheck ? `<br>刷新核对：${(s.recheck.resolved || []).length}/${s.recheck.total} 已显示完成` : "") +
      (s.unconfirmed && s.unconfirmed.length
        ? `<br>⚠ ${s.unconfirmed.length} 个待复核（可能要刷新才显示 ✓）` : "") +
      (s.log && s.log.length ? `<div class="vb-log">${escapeHtml(s.log[0])}</div>` : "");
  }
  box.style.display = "block";
  // 唯一的开始按钮绝不禁用：上一轮状态残留（卡住 / 刷新过）时必须能强制重开
  const startBtn = $("vbrushStart"), stopBtn = $("vbrushStop");
  if (startBtn) { startBtn.disabled = false; startBtn.textContent = s && s.running ? "重新开始" : "从当前页开始刷"; }
  if (stopBtn) stopBtn.disabled = false;
}

async function launchVBrush() {
  setVNotice("正在启动…", 25000);
  const tab = await activeTab();
  if (!tab || !tab.id) {
    setVNotice("未找到当前标签页，请切到课程目录页再点。", 10000);
    return;
  }
  const cfg = {
    speed: Number($("vbrushSpeed").value) || 1,
    skipDone: $("vbrushSkipDone").checked,
    slow: $("vbrushSlow").checked,
    maxWaitMin: Math.max(1, Number($("vbrushWait").value) || 20),
    confirmSec: Math.max(0, Math.min(120, Number($("vbrushConfirm").value) || 0)),
    autoSlowdown: $("vbrushAutoSlow").checked,
    maxVideos: Math.max(1, Number($("vbrushMax").value) || 100),
  };
  try {
    try {
      await ensureVBrush(tab.id);
    } catch (e) {
      throw new Error("无法注入脚本：" + ((e && e.message) || e) +
        "　请确认当前不是 chrome:// 或扩展商店页，并在 chrome://extensions 里刷新过本扩展");
    }
    // 注入后等脚本注册完消息监听；页面刚跳转 / service worker 刚唤醒时偶尔要重试
    let ok = false, lastErr = "";
    for (let i = 0; i < 3; i++) {
      await wait(200 + i * 250);
      try {
        const r = await chrome.tabs.sendMessage(tab.id, { type: "qvb_start", cfg, force: true });
        if (r && r.ok) { ok = true; break; }
        lastErr = (r && r.error) || "脚本没返回 ok";
      } catch (e) { lastErr = (e && e.message) || String(e); }
    }
    if (!ok) {
      throw new Error("页面脚本没响应：" + lastErr +
        "　常见原因：扩展没刷新、页面刚刷新过、或停在了 chrome:// 页面");
    }
    setVNotice("已开始：从当前页往下刷，播完自动跳下一个；作业仍需你手动点。", 5000);
    await refreshVBrush();
  } catch (e) {
    setVNotice("启动失败：" + ((e && e.message) || e), 20000);
  }
}
$("vbrushStart").addEventListener("click", () => launchVBrush());

$("vbrushStop").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab || !tab.id) { setVNotice("未找到当前标签页。", 8000); return; }
  const r = await vSend(tab.id, { type: "qvb_stop" });
  setVNotice(r && r.ok ? "已停止。作业仍需你自己手动完成。" :
    "停止指令没送达：" + ((r && r.error) || "页面脚本不在了，刷新页面后重试"), 8000);
  await refreshVBrush();
});

// 平台常常要刷新页面才把 ✓ 渲染进目录。这个按钮只做「刷新 → 重新注入 → 只读核对」，
// 不启动自动流程、不点任何视频，所以不会让刷课又跑起来。
$("vbrushRecheck").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab || !tab.id) { setVNotice("未找到当前标签页。", 8000); return; }
  setVNotice("正在刷新页面并核对完成状态（不会继续刷视频）…", 30000);
  try { await chrome.tabs.reload(tab.id); }
  catch (e) { setVNotice("刷新失败：" + ((e && e.message) || e), 12000); return; }
  let r = null, lastErr = "页面脚本没响应";
  for (let i = 0; i < 8; i++) {
    await wait(500 + i * 300);
    try {
      await ensureVBrush(tab.id);
      r = await vSend(tab.id, { type: "qvb_recheck" });
      if (r && r.ok) break;
      lastErr = (r && r.error) || "脚本没返回 ok";
    } catch (e) { lastErr = (e && e.message) || String(e); }
  }
  if (r && r.ok) {
    const tail = r.pending && r.pending.length
      ? `；仍没看到 ✓：${r.pending.slice(0, 3).map(escapeHtml).join("、")}${r.pending.length > 3 ? "…" : ""}` : "";
    setVNotice(`核对完成：${(r.resolved || []).length}/${r.total} 个已显示 ✓${tail}（没有继续刷视频）`, 20000);
  } else {
    setVNotice("核对失败：" + lastErr + "；可刷新页面后点「诊断目录」自己看", 20000);
  }
  await refreshVBrush();
});

$("vbrushDiag").addEventListener("click", async () => {
  const tab = await activeTab();
  if (!tab || !tab.id) { setVNotice("未找到当前标签页。", 8000); return; }
  try { $("moreSettings").open = true; } catch (e) {}
  const box = $("vbrushDiagBox");
  box.style.display = "block";
  box.innerHTML = "正在扫描目录…";
  try {
    await ensureVBrush(tab.id);
    await wait(200);
    const r = await vSend(tab.id, { type: "qvb_scan" });
    const items = (r && r.items) || [];
    if (!items.length) {
      box.innerHTML = `<div class="muted">${r && r.error ? escapeHtml(r.error) : "没识别到「视频 / 作业」标记"}。请确认停在课程目录页；若页面结构特殊，把「诊断结构」结果发给我适配。</div>`;
      return;
    }
    const vs = items.filter((x) => x.type === "video").length;
    box.innerHTML = `<div class="muted">共 ${items.length} 个类型标记，其中视频 <b>${vs}</b> 个（只会点这些），其余跳过</div>` +
      items.map((it) => `<div class="row">${it.type === "video" ? "▶ 视频" : "· 跳过"}${it.done ? "（已完成）" : ""}　${escapeHtml(it.text)}${it.clickable ? "" : "　[无可点击目标]"}</div>`).join("");
  } catch (e) {
    box.innerHTML = `<div class="warn">诊断失败：${escapeHtml((e && e.message) || e)}</div>`;
  }
});

// 弹窗开着时刷新进度；关掉后由页面顶部的浮窗继续显示
setInterval(refreshVBrush, 1200);

/* ---------- ② 当前页启动辅助（手动模式） ---------- */
$("start").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) { $("status").textContent = "未找到当前标签页"; return; }
  $("status").textContent = "正在注入面板…";
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["inject.js"] });
    $("status").textContent = "已启动，去页面右下角操作吧。";
  } catch (err) {
    $("status").textContent = "注入失败：" + err.message;
  }
});

/* ---------- ② 从链接开始 ---------- */
$("open").addEventListener("click", async () => {
  const url = $("url").value.trim();
  if (!url) { $("status").textContent = "请先粘贴题目网页链接。"; return; }
  const chapters = $("chapters").checked;
  const backend = await getBackend();
  await chrome.storage.local.set({ backend });

  $("status").textContent = "正在打开并自动解答…";
  try {
    const resp = await chrome.runtime.sendMessage({ type: "open_and_run", url, chapters });
    if (!resp || !resp.ok) { $("status").textContent = "启动失败：" + ((resp && resp.error) || "未知"); return; }
    $("status").textContent = chapters
      ? `已打开主页面并扫描章节，正在逐页自动解答（主页面 + ${resp.chapters || 0} 个章节标签）。`
      : "已打开并自动解答，去标签页查看进度。";
  } catch (e) {
    $("status").textContent = "出错：" + e.message;
  }
});

/* ---------- 合并报告 ---------- */
$("combine").addEventListener("click", async () => {
  const base = (await getBackend()).replace(/\/+$/, "");
  $("status").textContent = "正在合并报告…";
  try {
    const r = await fetch(base + "/combine", { method: "POST" });
    const data = await r.json();
    if (!data.ok) { $("status").textContent = "合并失败：" + (data.error || ""); return; }
    // 只在弹窗里显示，不再触发浏览器下载
    lastCombinedMd = data.markdown || "";
    const box = $("reportBox");
    box.textContent = lastCombinedMd;
    box.style.display = "block";
    box.scrollTop = 0;
    $("copyReport").style.display = "block";
    $("status").textContent = `已合并 ${data.count} 份报告，已在窗口显示（可点「复制合并汇总」）。`;
  } catch (e) {
    $("status").textContent = "合并出错：" + e.message;
  }
});

$("copyReport").addEventListener("click", () => {
  if (!lastCombinedMd) return;
  try {
    navigator.clipboard.writeText(lastCombinedMd).then(
      () => { $("status").textContent = "合并汇总已复制到剪贴板。"; },
      () => { $("status").textContent = "复制失败，请手动选中文本复制。"; }
    );
  } catch (e) {
    $("status").textContent = "复制失败，请手动选中文本复制。";
  }
});
