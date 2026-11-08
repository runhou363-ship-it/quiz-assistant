/* 视频自动连播端到端测试（无头 Chrome + CDP，零 npm 依赖）
 *
 * 覆盖：
 *   A 诊断目录能区分「视频 / 作业」
 *   B 只点视频，作业一次都不点
 *   C 看完一个自动找下一个，5 个视频按序看完且不重复
 *   D 左侧目录滚动懒加载后能继续找到后面的视频
 *   E 页面浮窗 / 状态 / 结束态正确
 *   F 「停止」能立刻刹住，不再继续点
 *   G 点击事件绑在「标题」而非标签/整行时，也能点开（点了没响应的常见原因）
 *   H 首次点不开会重试，而非被永久跳过
 *   I 600 条目大目录的扫描耗时（防止回退到逐元素 innerText）
 *   J 浏览器拦截有声自动播放时，能静音自启并真正播完
 *   K 「点开即标已完成」但没播，不会被误判成看完
 *   L 运行中强制重启能生效，旧循环不会抢点
 *   N 从当前页（active 条目）开始，前面的不回头
 *   R 当前页视频已完成时，从它的下一个开始
 *   O 播放途中出现 ✓ 立即跳下一个，不等视频播完
 *   Q 默认 1 倍速（真实时长，保证满完成度）
 *   S 距结尾 1.5 秒时不会提前跳走（旧逻辑会让平台收不到 ended）
 *   T 平台晚几秒才打勾，工具会停留确认、不算「未确认」
 *   U 平台一直不打勾：记录待复核清单，并自动降到 1 倍速
 *   V 打勾后条目文本变化也不会重复点、能正常停下来
 *   W 「刷新并核对完成」能认出刷新后才出现的 ✓
 *   X 单轮处理数量上限会明确停止
 *   M popup 单按钮、默认 2x、设置区折叠精简
 *
 * 运行： node tests/videobrush.e2e.mjs
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, "..");
const EXT = path.join(PROJECT, "extension");
const PORT = Number(process.env.QA_TEST_PORT || 8878);
const DEBUG_PORT = Number(process.env.QA_TEST_CDP || 9334);
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const server = createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  try {
    if (url === "/" || url === "/mock-course.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(await readFile(path.join(HERE, "mock-course.html")));
      return;
    }
    if (url === "/popup.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(await readFile(path.join(EXT, "popup.html")));
      return;
    }
    if (url === "/popup.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(await readFile(path.join(EXT, "popup.js")));
      return;
    }
    res.writeHead(404); res.end("not found");
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const profile = path.join(os.tmpdir(), "qa-vb-profile-" + Date.now());
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--remote-allow-origins=*", "--window-size=1280,900",
  `http://127.0.0.1:${PORT}/mock-course.html`,
], { stdio: "ignore" });

async function firstPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const p = list.find((t) => t.type === "page" && t.url.includes("mock-course.html"));
      if (p) return p;
    } catch (e) {}
    await sleep(250);
  }
  throw new Error("Chrome 没起来（检查 CHROME_PATH）");
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 1; this.pending = new Map();
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = this.id++;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 600));
    return r.result.value;
  }
}

const page = await firstPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const cdp = new CDP(ws);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");

const SRC = await readFile(path.join(EXT, "video-brush.js"), "utf8");
const navigate = async (qs = "") => {
  const extra = qs ? "&" + qs : "";
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/mock-course.html?t=${Date.now()}${extra}` });
  await sleep(800);
  await cdp.eval(SRC);          // 注入被测脚本（IIFE，重复注入会自行跳过）
  await sleep(150);
};
const send = (msg) => cdp.eval(
  `new Promise((res) => window.__qvbListener(${JSON.stringify(msg)}, {}, res))`);
const stateOf = () => cdp.eval("window.__st.qaVideoBrushState || null");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + (detail || "")}`);
}

// —— A 诊断：能分清视频 / 作业 ——
await navigate();
const diag = await send({ type: "qvb_scan" });
const diagVideos = (diag.items || []).filter((x) => x.type === "video");
const diagSkips = (diag.items || []).filter((x) => x.type === "skip");
check("A 诊断目录能区分视频与作业",
  diag.ok && diagVideos.length === 2 && diagSkips.length === 1 && diagVideos.every((x) => x.clickable),
  JSON.stringify(diag));

// —— B/C/D/E 跑完整轮 ——
await send({ type: "qvb_start", cfg: { confirmSec: 1, speed: 1, skipDone: true, maxWaitMin: 1, minGapMs: 100, maxIdleScroll: 5 } });
let st = null;
for (let i = 0; i < 100; i++) {
  st = await stateOf();
  if (st && !st.running && (st.phase === "done" || st.phase === "stopped")) break;
  await sleep(400);
}
const clicked = await cdp.eval("window.__clicked");
const homework = await cdp.eval("window.__clickedHomework");
const batches = await cdp.eval("window.__batches");
const hasFloat = await cdp.eval("!!document.getElementById('qa-video-brush')");
if (process.env.QA_DEBUG) {
  console.log("DEBUG afterScan:", JSON.stringify((await send({ type: "qvb_scan" })).items));
  console.log("DEBUG state:", JSON.stringify(st));
  console.log("DEBUG side:", await cdp.eval("(()=>{const s=document.getElementById('side');return {h:s.clientHeight,sh:s.scrollHeight,top:s.scrollTop,ov:getComputedStyle(s).overflowY}})()"));
}

check("B 作业一次都没被点", homework.length === 0, JSON.stringify(homework));
check("C 5 个视频按序看完且不重复", clicked.join(",") === "v1,v2,v3,v4,v5", JSON.stringify(clicked));
check("D 滚动懒加载后能继续找视频", batches > 1, "batches=" + batches);
check("E 进度状态与浮窗正确",
  !!st && st.done === 5 && st.phase === "done" && hasFloat && /没有更多视频/.test((st.log || []).join(" ")),
  JSON.stringify({ phase: st && st.phase, done: st && st.done, log: st && st.log && st.log[0] }));

// —— F 停止能立刻刹住 ——
await navigate();
await send({ type: "qvb_start", cfg: { confirmSec: 1, minGapMs: 3000, maxWaitMin: 1 } });
await sleep(500);
await send({ type: "qvb_stop" });
await sleep(1800);
const st2 = await stateOf();
const clicked2 = await cdp.eval("window.__clicked");
check("F 停止后不再继续点",
  !!st2 && !st2.running && st2.phase === "stopped" && clicked2.length <= 2,
  JSON.stringify({ phase: st2 && st2.phase, running: st2 && st2.running, clicked: clicked2 }));

// —— G 事件只绑在「标题」上（点标签/整行都没反应）也能点开 ——
await navigate("titleClick=1");
await send({ type: "qvb_start", cfg: { confirmSec: 1, minGapMs: 100, maxWaitMin: 1 } });
await sleep(9000);
const gClicked = await cdp.eval("window.__clicked");
const gHw = await cdp.eval("window.__clickedHomework");
await send({ type: "qvb_stop" });
check("G 事件绑在标题上也能点开，且仍不碰作业",
  gClicked.length >= 1 && gHw.length === 0,
  JSON.stringify({ clicked: gClicked, homework: gHw }));

// —— H 前几次点击无效时会重试，而不是永久跳过 ——
await navigate("firstFail=1");
await send({ type: "qvb_start", cfg: { confirmSec: 1, minGapMs: 100, maxWaitMin: 1 } });
await sleep(11000);
const hClicked = await cdp.eval("window.__clicked");
const hState = await stateOf();
await send({ type: "qvb_stop" });
check("H 首次点不开会重试而非永久跳过",
  hClicked.length >= 1 && /重试/.test((hState && hState.log || []).join(" ")),
  JSON.stringify({ clicked: hClicked, log: hState && hState.log && hState.log.slice(0, 3) }));

// —— I 大目录：对比旧扫描路径（逐元素 innerText）与新路径（children 过滤 + textContent）——
await navigate();
const perf = await cdp.eval(`(() => {
  const ul = document.getElementById('items');
  let html = '';
  for (let i = 0; i < 600; i++) {
    html += '<li class="task-item" data-node-id="x' + i + '"><span class="tag">' +
            (i % 2 ? '作业' : '视频') + '</span><span class="title">第 ' + i + ' 节 测试条目内容</span></li>';
  }
  ul.innerHTML = html;
  const els = document.querySelectorAll('span,div,a,button,li,p,em,i,b,label,strong,td');
  let n = 0, t0 = performance.now();
  for (let i = 0; i < els.length; i++) { const s = els[i].innerText; if (s) n++; }
  const oldMs = performance.now() - t0;
  t0 = performance.now();
  for (let i = 0; i < els.length; i++) {
    const e = els[i]; if (e.children.length > 1) continue;
    const s = e.textContent; if (s) n++;
  }
  const newMs = performance.now() - t0;
  let r = null; const t1 = performance.now();
  window.__qvbListener({ type: 'qvb_scan' }, {}, (x) => { r = x; });
  return { nodes: els.length, oldMs: +oldMs.toFixed(1), newMs: +newMs.toFixed(1),
           scanMs: +(performance.now() - t1).toFixed(1), items: r && r.items && r.items.length };
})()`);
console.log("性能:", JSON.stringify(perf));
check("I 600 条目大目录扫描 < 1200ms",
  perf.scanMs < 1200 && perf.items === 120 && perf.newMs < perf.oldMs,
  JSON.stringify(perf));

// —— J 浏览器拦截有声自动播放：应静音自启并真的播完 ——
await navigate("needPlay=1");
await send({ type: "qvb_start", cfg: { confirmSec: 1, minGapMs: 100, maxWaitMin: 1, maxNoStartSec: 8 } });
let jSt = null;
for (let i = 0; i < 70; i++) {
  jSt = await stateOf();
  if (jSt && !jSt.running && (jSt.phase === "done" || jSt.phase === "stopped")) break;
  await sleep(400);
}
const jPlayed = await cdp.eval("window.__clickedDone");
check("J 被自动播放策略拦截时能静音自启并真正播完",
  !!jSt && jSt.done === 5 && jPlayed.length === 5,
  JSON.stringify({ done: jSt && jSt.done, phase: jSt && jSt.phase, played: jPlayed, log: jSt && jSt.log && jSt.log.slice(0, 2) }));

// —— K 点开即标「已完成」但一秒都没播：不能算看完 ——
await navigate("noPlay=1");
await send({ type: "qvb_start", cfg: { confirmSec: 1, minGapMs: 100, maxWaitMin: 1, maxNoStartSec: 3, maxIdleScroll: 1 } });
await sleep(6500);
const kSt = await stateOf();
await send({ type: "qvb_stop" });
check("K 没真正播放的视频不会被误判成看完",
  !!kSt && kSt.done === 0 && /无法开始播放|跳过/.test((kSt.log || []).join(" ")),
  JSON.stringify({ done: kSt && kSt.done, log: kSt && kSt.log && kSt.log.slice(0, 3) }));

// —— L 运行中强制重启（模拟「上一轮卡住，再点一次开始」） ——
await navigate();
const r1 = await send({ type: "qvb_start", cfg: { confirmSec: 1, minGapMs: 100, maxWaitMin: 1 } });
await sleep(600);
const lDuring = await stateOf();
const r2 = await send({ type: "qvb_start", cfg: { confirmSec: 1, minGapMs: 100, maxWaitMin: 1 }, force: true });
await sleep(1500);
const lAfter = await stateOf();
await send({ type: "qvb_stop" });
check("L 运行中强制重启能生效且代数递增",
  !!r1 && !!r2 && r2.gen === r1.gen + 1 && !!lDuring && lDuring.running && !!lAfter && lAfter.running,
  JSON.stringify({ r1, r2, during: lDuring && lDuring.phase, after: lAfter && lAfter.phase }));

// —— N 从当前页（目录里 active 的条目）开始 ——
await navigate("activeAt=2");   // 第 3 个 li = v2 是当前页
await send({ type: "qvb_start", cfg: { confirmSec: 1, minGapMs: 100, maxWaitMin: 1 } });
let nSt = null;
for (let i = 0; i < 70; i++) {
  nSt = await stateOf();
  if (nSt && !nSt.running && (nSt.phase === "done" || nSt.phase === "stopped")) break;
  await sleep(400);
}
const nClicked = await cdp.eval("window.__clicked");
check("N 从当前页开始，前面的视频不回头",
  !!nSt && nClicked.join(",") === "v2,v3,v4,v5" && nSt.done === 4,
  JSON.stringify({ clicked: nClicked, done: nSt && nSt.done, log: nSt && nSt.log && nSt.log.slice(0, 2) }));

// —— R 当前页这条已完成时，从下一条开始 ——
await navigate("activeAt=2&doneAt=2");
await send({ type: "qvb_start", cfg: { confirmSec: 1, minGapMs: 100, maxWaitMin: 1 } });
let rSt = null;
for (let i = 0; i < 70; i++) {
  rSt = await stateOf();
  if (rSt && !rSt.running && (rSt.phase === "done" || rSt.phase === "stopped")) break;
  await sleep(400);
}
const rClicked = await cdp.eval("window.__clicked");
check("R 当前页视频已完成则从下一个开始",
  !!rSt && rClicked.join(",") === "v3,v4,v5" && rSt.done === 3,
  JSON.stringify({ clicked: rClicked, done: rSt && rSt.done, log: rSt && rSt.log && rSt.log.slice(0, 2) }));

// —— AB 章节容器带 active 且里面有好几个视频：不能把第一条当成「当前页」 ——
// 旧实现用 [class*=active] + el.contains(row) 判定，会命中容器里的第一个视频 → 从头回头刷。
await navigate("ulActive=1&activeAt=2");   // 容器 active，同时 v2 才是当前页
await send({ type: "qvb_start", cfg: { confirmSec: 1, minGapMs: 100, maxWaitMin: 1 } });
let abSt = null;
for (let i = 0; i < 90; i++) {
  abSt = await stateOf();
  if (abSt && !abSt.running && (abSt.phase === "done" || abSt.phase === "stopped")) break;
  await sleep(400);
}
const abClicked = await cdp.eval("window.__clicked");
check("AB 章节容器带 active 时不会误判成第一个视频",
  !!abSt && abClicked.join(",") === "v2,v3,v4,v5" && abSt.done === 4,
  JSON.stringify({ clicked: abClicked, done: abSt && abSt.done, log: abSt && abSt.log && abSt.log.slice(0, 3) }));

// —— AC 定位不到当前页时：跳过已完成的，绝不回头重刷 ——
await navigate("doneFirst=3");   // v1/v2/v3 已完成，页面没有 active / URL 参数 / 标题线索
await send({ type: "qvb_start", cfg: { confirmSec: 1, minGapMs: 100, maxWaitMin: 1 } });
let acSt = null;
for (let i = 0; i < 90; i++) {
  acSt = await stateOf();
  if (acSt && !acSt.running && (acSt.phase === "done" || acSt.phase === "stopped")) break;
  await sleep(400);
}
const acClicked = await cdp.eval("window.__clicked");
check("AC 定位不到当前页时跳过已完成的，不回头",
  !!acSt && acClicked.join(",") === "v4,v5" && acSt.done === 2 &&
  /跳过前面 3 个已完成/.test((acSt.log || []).join(" ")),
  JSON.stringify({ clicked: acClicked, done: acSt && acSt.done, log: acSt && acSt.log && acSt.log.slice(0, 3) }));

// —— O 播放途中出现 ✓ 立刻跳下一个（进度其实一直没动） ——
await navigate("earlyCheck=1");
await send({ type: "qvb_start", cfg: { confirmSec: 1, minGapMs: 100, maxWaitMin: 1, maxNoStartSec: 30 } });
let oSt = null;
for (let i = 0; i < 90; i++) {
  oSt = await stateOf();
  if (oSt && !oSt.running && (oSt.phase === "done" || oSt.phase === "stopped")) break;
  await sleep(400);
}
const oClicked = await cdp.eval("window.__clicked");
check("O 检测到 ✓ 完成标记就立刻跳下一个",
  !!oSt && /检测到 ✓ 完成标记/.test((oSt.log || []).join(" ")) && oSt.done === 5 && oClicked.length === 5,
  JSON.stringify({ done: oSt && oSt.done, clicked: oClicked, log: oSt && oSt.log && oSt.log.slice(0, 3) }));

// —— Q 默认 1 倍速（真实时长，保证满完成度；2x 在雨课堂等按真实时长计完成度的平台只计约一半） ——
await navigate();
await send({ type: "qvb_start", cfg: { confirmSec: 1, minGapMs: 100, maxWaitMin: 1 } });
await sleep(1300);
const rateQ = await cdp.eval("(() => { const v = document.querySelector('#mockVideo'); return v ? v.playbackRate : null; })()");
await send({ type: "qvb_stop" });
check("Q 默认以 1 倍速播放（保证完成度）", rateQ === 1, JSON.stringify({ rate: rateQ }));

// —— Y 页面里还有干扰 video（缩略图 / 预加载）时，必须认准真正的主播放器 ——
// 旧实现取「文档里第一个可见 video」，会抓到那个不会播的干扰项，浮窗一直 0 / 0 s。
await navigate("decoyVideo=1");
await send({ type: "qvb_start", cfg: { confirmSec: 1, minGapMs: 100, maxWaitMin: 1 } });
let yOk = false, ySamples = [];
for (let i = 0; i < 8; i++) {
  await sleep(200);
  const s = await stateOf();
  const w = (s && s.watch) || "";
  ySamples.push(w);
  if (/\/ 4 s/.test(w)) yOk = true;
}
const yDecoy = await cdp.eval("(() => { const v = document.querySelector('#decoyVideo'); return v ? { dur: v.duration, paused: v.paused } : null; })()");
await send({ type: "qvb_stop" });
check("Y 有干扰 video 时仍认准主播放器", yOk && !!yDecoy,
  JSON.stringify({ samples: ySamples, decoy: yDecoy }));

// —— Z 播放器「在播」但进度卡住：能自动唤醒（轻微 seek 跨过卡点），不干等到超时 ——
await navigate("stuck=1");
await send({ type: "qvb_start", cfg: { confirmSec: 1, minGapMs: 100, maxWaitMin: 2 } });
let zSt = null;
for (let i = 0; i < 220; i++) {
  zSt = await stateOf();
  if (zSt && !zSt.running && (zSt.phase === "done" || zSt.phase === "stopped")) break;
  await sleep(400);
}
const zSeeks = await cdp.eval("window.__seeks || 0");
check("Z 进度卡住能自动唤醒并继续播完",
  !!zSt && zSt.done === 5 && zSeeks >= 1 && /进度卡住了/.test((zSt.log || []).join(" ")),
  JSON.stringify({ done: zSt && zSt.done, seeks: zSeeks, log: zSt && zSt.log && zSt.log.slice(0, 4) }));

// —— AA 1x 下不碰播放器自带的「倍速」按钮（真实平台点了会暂停/弹菜单） ——
await navigate("speedTrap=1");
await send({ type: "qvb_start", cfg: { confirmSec: 1, minGapMs: 100, maxWaitMin: 1, speed: 1 } });
let aaSt = null;
for (let i = 0; i < 120; i++) {
  aaSt = await stateOf();
  if (aaSt && !aaSt.running && (aaSt.phase === "done" || aaSt.phase === "stopped")) break;
  await sleep(400);
}
const aaClicks = await cdp.eval("window.__speedClicked || 0");
check("AA 1x 不点倍速按钮，视频全程正常播完",
  aaClicks === 0 && !!aaSt && aaSt.done === 5,
  JSON.stringify({ speedClicked: aaClicks, done: aaSt && aaSt.done }));

// —— S 距结尾 1.5 秒处不能提前判定播完（否则平台收不到 ended，永远不打勾） ——
await navigate("nearTail=1");
await send({ type: "qvb_start", cfg: { confirmSec: 1, minGapMs: 100, maxWaitMin: 2 } });
let sSt = null;
for (let i = 0; i < 140; i++) {
  sSt = await stateOf();
  if (sSt && !sSt.running && (sSt.phase === "done" || sSt.phase === "stopped")) break;
  await sleep(400);
}
const sDone = await cdp.eval("window.__clickedDone");
const sClicked = await cdp.eval("window.__clicked");
check("S 距结尾 1.5 秒不会提前跳走", 
  !!sSt && sDone.length === 5 && sClicked.join(",") === "v1,v2,v3,v4,v5" && sSt.done === 5,
  JSON.stringify({ reallyFinished: sDone, clicked: sClicked, done: sSt && sSt.done }));

// —— T 平台播完后过几秒才打勾：停留确认窗口内等到 ✓，不算未确认 ——
await navigate("lateCheck=3");
await send({ type: "qvb_start", cfg: { confirmSec: 6, minGapMs: 100, maxWaitMin: 1, autoSlowdown: false } });
let tSt = null;
for (let i = 0; i < 150; i++) {
  tSt = await stateOf();
  if (tSt && !tSt.running && (tSt.phase === "done" || tSt.phase === "stopped")) break;
  await sleep(400);
}
check("T 平台延迟打勾会在确认窗口内等到", 
  !!tSt && tSt.done === 5 && (tSt.unconfirmed || []).length === 0 &&
  /平台已打 ✓ 完成标记/.test((tSt.log || []).join(" ")),
  JSON.stringify({ done: tSt && tSt.done, unconfirmed: tSt && tSt.unconfirmed, log: tSt && tSt.log && tSt.log.slice(0, 3) }));

// —— U 平台一直不打勾：记录未确认清单、浮窗提示、并自动降到 1x ——
await navigate("noCheck=1");
await send({ type: "qvb_start", cfg: { confirmSec: 1, minGapMs: 100, maxWaitMin: 1, autoSlowdown: true, speed: 2 } });
let uSt = null;
for (let i = 0; i < 120; i++) {
  uSt = await stateOf();
  if (uSt && !uSt.running && (uSt.phase === "done" || uSt.phase === "stopped")) break;
  await sleep(400);
}
const floatTxt = await cdp.eval("(() => { const e = document.querySelector('#qa-video-brush .qvb-body'); return e ? e.textContent : ''; })()");
check("U 平台不打勾会记录待复核并自动降 1x", 
  !!uSt && uSt.done === 5 && (uSt.unconfirmed || []).length === 5 &&
  uSt.rateAdjusted === true && uSt.speed === 1 &&
  /当前页没看到 ✓/.test((uSt.log || []).join(" ")) && /自动改成 1 倍速/.test((uSt.log || []).join(" ")),
  JSON.stringify({ done: uSt && uSt.done, unconfirmed: uSt && uSt.unconfirmed && uSt.unconfirmed.length,
                   adjusted: uSt && uSt.rateAdjusted, speed: uSt && uSt.speed,
                   float: floatTxt.slice(0, 80), log: uSt && uSt.log && uSt.log.slice(0, 4) }));

// —— V 打勾后条目文本变化（没有稳定 id）：不能重复点同一条，且必须停下来 ——
await navigate("noIds=1");
await send({ type: "qvb_start", cfg: { confirmSec: 1, minGapMs: 100, maxWaitMin: 1, autoSlowdown: false, maxVideos: 12 } });
let vSt = null;
for (let i = 0; i < 130; i++) {
  vSt = await stateOf();
  if (vSt && !vSt.running && (vSt.phase === "done" || vSt.phase === "stopped")) break;
  await sleep(400);
}
const vClicked = await cdp.eval("window.__clicked");
check("V 打勾后文本变化也不会重复点、能正常停", 
  !!vSt && vSt.phase === "done" && vSt.running === false && vClicked.length === 5 && vSt.done === 5,
  JSON.stringify({ phase: vSt && vSt.phase, running: vSt && vSt.running,
                   clicked: vClicked, done: vSt && vSt.done, log: vSt && vSt.log && vSt.log.slice(0, 3) }));

// —— W 「刷新并核对完成」：刷新后目录里才出现的 ✓ 能被认出来 ——
await navigate("doneAt=0");   // 第 0 条 v1「一、绪论」显示已完成 + ✓
await cdp.eval(`window.__st["qaVideoBrushState"] = {
  running: false, phase: "done", done: 2,
  unconfirmed: [
    { name: "一、绪论", key: "t:视频一、绪论" },
    { name: "二、历史发展", key: "t:视频二、历史发展" },
  ] }`);
const wRes = await send({ type: "qvb_recheck" });
check("W 刷新后能核对出已显示完成的条目", 
  !!wRes && wRes.ok && wRes.total === 2 && wRes.resolved.indexOf("一、绪论") >= 0 &&
  wRes.pending.indexOf("二、历史发展") >= 0,
  JSON.stringify(wRes));

// —— X 硬上限：到数就明确停止 ——
await navigate();
await send({ type: "qvb_start", cfg: { confirmSec: 1, minGapMs: 100, maxWaitMin: 1, autoSlowdown: false, maxVideos: 2 } });
let xSt = null;
for (let i = 0; i < 80; i++) {
  xSt = await stateOf();
  if (xSt && !xSt.running && (xSt.phase === "done" || xSt.phase === "stopped")) break;
  await sleep(400);
}
const xClicked = await cdp.eval("window.__clicked");
check("X 达到单轮上限会明确停止", 
  !!xSt && xSt.phase === "done" && xSt.running === false && xClicked.length === 2 && xSt.done === 2,
  JSON.stringify({ phase: xSt && xSt.phase, clicked: xClicked, done: xSt && xSt.done }));

// —— M popup：storage 里残留 running=true 时，按钮必须仍可点、点击要有可见反馈 ——
const STUB = `(() => {
  window.__msgLog = [];
  window.__st = { qaVideoBrushState: { running: true, phase: 'watch', done: 2, total: 5,
    current: '一、绪论', watch: '0 / 922 s', log: [] } };
  const store = {
    get(k, cb) {
      const d = {};
      if (typeof k === 'string' && k in window.__st) d[k] = window.__st[k];
      else if (Array.isArray(k)) k.forEach((x) => { if (x in window.__st) d[x] = window.__st[x]; });
      else Object.assign(d, window.__st);
      if (cb) { setTimeout(() => cb(d), 0); return; }
      return Promise.resolve(d);
    },
    set(o, cb) { Object.assign(window.__st, o); if (cb) { setTimeout(() => cb(), 0); return; } return Promise.resolve(); },
  };
  window.chrome = {
    runtime: { getManifest: () => ({ version: '0.9.18' }), onMessage: { addListener() {} } },
    storage: { local: store },
    tabs: {
      query() { return Promise.resolve([{ id: 1 }]); },
      sendMessage(id, msg) { window.__msgLog.push(msg); return Promise.resolve({ ok: true, gen: 1 }); },
    },
    scripting: { executeScript() { return Promise.resolve([{ result: null }]); } },
  };
})();`;
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: STUB });
await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/popup.html?t=${Date.now()}` });
await sleep(1300);
const mBefore = await cdp.eval(`(() => {
  const b = document.querySelector('#vbrushStart');
  return { disabled: !!b && b.disabled, text: b ? b.textContent : '',
           second: !!document.querySelector('#vbrushFromCurrent'),
           moreOpen: !!document.querySelector('#moreSettings') && document.querySelector('#moreSettings').open,
           examOpen: !!document.querySelector('#examTools') && document.querySelector('#examTools').open,
           speed: (document.querySelector('#vbrushSpeed') || {}).value || '',
           ver: (document.querySelector('#verTag') || {}).textContent || '',
           recheckBtn: !!document.querySelector('#vbrushRecheck') };
})()`);
await cdp.eval(`document.querySelector('#vbrushStart').click()`);
await sleep(1500);
const mAfter = await cdp.eval(`(() => ({
  status: (document.querySelector('#vbrushStatus') || {}).textContent || '',
  msgs: (window.__msgLog || []).map((m) => m.type),
  force: (window.__msgLog || []).some((m) => m.type === 'qvb_start' && m.force === true),
  speeds: (window.__msgLog || []).filter((m) => m.type === 'qvb_start').map((m) => m.cfg && m.cfg.speed),
}))()`);
check("M 单按钮 / 默认 1x（保完成度）/ 设置区默认折叠",
  mBefore.disabled === false && /重新/.test(mBefore.text) && mBefore.second === false &&
  mBefore.moreOpen === false && mBefore.examOpen === false && mBefore.speed === "1" &&
  mBefore.recheckBtn === true &&
  /v0\.9\.\d+/.test(mBefore.ver) && /已开始|启动失败|正在/.test(mAfter.status) &&
  mAfter.msgs.indexOf("qvb_start") >= 0 && mAfter.force && mAfter.speeds.every((x) => x === 1),
  JSON.stringify({ before: mBefore, after: mAfter }));

console.log("\n==== 汇总 ====");
results.forEach((r) => console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}`));
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} 通过`);

ws.close();
chrome.kill();
server.close();
process.exit(failed ? 1 : 0);
