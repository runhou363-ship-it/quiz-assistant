/* 自动流程端到端测试（无头 Chrome + CDP，不依赖任何 npm 包）
 *
 * v0.9.27 起自动模式的生命周期：一轮跑完自动关闭、下次必须手动勾选；
 * 点「重新抓取」无条件清空汇总并关闭自动模式；手动勾选会清空上一轮汇总。
 *   A 一轮跑完后自动模式自动关闭，连跨页面的开关意图也清掉
 *   B 刷新后不再自动启动，等待手动开启
 *   C 点「重新抓取」立即清空并关闭，不再自动翻页
 *   D 没勾自动模式时，重新抓取只刷新、不乱跑
 *   E 题目比面板晚 3.5 秒渲染，也能等到并跑完
 *   F 后端断过一次属异常暂停，仍保留自动模式；点重新抓取后停下，手动重勾可续跑
 *   G 手动模式「查找答案」只出结果、不翻页
 *   H 重新抓取无条件清空上一轮汇总（不自动重算本题）
 *   I 「撤销清空」能把清空前的汇总还原
 *   J 未做过的题上点一次「重新抓取」就直接清空（不再需要二次确认）
 *   K 「夸克核对」复制题目并打开夸克搜索，不影响自动流程
 *   L 手动开启自动模式时自动清空上一轮汇总，并重新跑完一轮
 *
 * 运行： node tests/autorun.e2e.mjs
 * 需要本机 Chrome；路径可用环境变量 CHROME_PATH 指定。
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
const MOCK = path.join(HERE, "mock-exam.html");
const PORT = Number(process.env.QA_TEST_PORT || 8877);
const DEBUG_PORT = Number(process.env.QA_TEST_CDP || 9333);
const CHROME = process.env.CHROME_PATH
  || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const server = createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  try {
    if (url === "/mock-exam.html" || url === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(await readFile(MOCK));
      return;
    }
    if (url === "/inject.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(await readFile(path.join(EXT, "inject.js")));
      return;
    }
    res.writeHead(404); res.end("not found");
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const profile = path.join(os.tmpdir(), "qa-e2e-profile-" + Date.now());
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--remote-allow-origins=*", "--window-size=1280,900",
  `http://127.0.0.1:${PORT}/mock-exam.html`,
], { stdio: "ignore" });

async function firstPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.url.includes("mock-exam.html"));
      if (page) return page;
    } catch (e) { /* 等 Chrome 起来 */ }
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
  async eval(expression, awaitPromise = true) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 500));
    return r.result.value;
  }
}

const page = await firstPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const cdp = new CDP(ws);
await cdp.send("Runtime.enable");
await cdp.send("Page.enable");
await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/mock-exam.html` });
await sleep(900);
for (let i = 0; i < 20; i++) {
  if ((await cdp.eval("location.href")).includes(`127.0.0.1:${PORT}`)) break;
  await sleep(300);
}

const INJECT = `new Promise((res) => {
  const s = document.createElement('script');
  s.src = '/inject.js';
  s.onload = () => res('ok'); s.onerror = () => res('err');
  document.body.appendChild(s);
})`;
const STATE = `(() => ({
  idx: document.body.dataset.idx,
  count: (document.querySelector('#qa-count') || {}).textContent || '',
  status: (document.querySelector('#qa-status') || {}).textContent || '',
  auto: !!(document.querySelector('#qa-auto') || {}).checked,
  panel: !!document.querySelector('#qa-panel')
}))()`;
const INTENT_ON = `localStorage.setItem('__st', JSON.stringify({ qaAutoEnabled: { on: true, host: location.hostname, ts: Date.now() } }))`;

const reload = async (q = "") => {
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/mock-exam.html${q}` });
  await sleep(800);
};

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + (detail || "")}`);
}

// A 新页面按上次勾选跑完一轮 → 自动模式自动关闭（含跨页面意图）
await cdp.eval(`localStorage.clear(); ${INTENT_ON}`);
await reload();
await cdp.eval(INJECT);
await sleep(9000);
let s = await cdp.eval(STATE);
const intentA = await cdp.eval(`(() => { const a = JSON.parse(localStorage.getItem('__st') || '{}'); return !!(a.qaAutoEnabled && a.qaAutoEnabled.on); })()`);
check("A 跑完一轮自动关闭自动模式（含跨页面意图）",
  s.panel && !s.auto && !intentA && s.idx === "2" && /已整理 3 题/.test(s.count),
  JSON.stringify({ ...s, intentA }));

// B 刷新后不该自己又跑起来：这是「等下一次手动开启」的核心
await reload();
await cdp.eval(INJECT);
await sleep(9000);
s = await cdp.eval(STATE);
check("B 刷新后不再自动启动，等待手动开启",
  s.panel && !s.auto && s.idx === "0" && /已整理 0 题/.test(s.count), JSON.stringify(s));

// C 点「重新抓取」：无条件清空 + 关闭自动模式，不再自动翻页
await cdp.eval(`localStorage.clear()`);
await reload();
await cdp.eval(INJECT);
await sleep(1500);
await cdp.eval(`(() => { const el = document.querySelector('#qa-auto'); el.checked = true; el.dispatchEvent(new Event('change')); })()`);
await sleep(150);
await cdp.eval(`document.querySelector('#qa-re').click()`);
const afterFirstRe = await cdp.eval(STATE);
await sleep(250);
await cdp.eval(`document.querySelector('#qa-re').click()`);
await sleep(9000);
s = await cdp.eval(STATE);
check("C 重新抓取点一次就清空并关闭自动模式",
  /已整理 0 题/.test(afterFirstRe.count) && !afterFirstRe.auto
    && s.idx === "0" && !s.auto && /已整理 0 题/.test(s.count),
  JSON.stringify({ afterFirstRe, after: s }));

// D 未开自动时重新抓取只刷新
await cdp.eval(`localStorage.clear()`);
await reload();
await cdp.eval(INJECT);
await sleep(1200);
await cdp.eval(`document.querySelector('#qa-re').click()`);
await sleep(2500);
s = await cdp.eval(STATE);
check("D 未开自动模式时重新抓取只刷新", s.idx === "0" && !s.auto, JSON.stringify(s));

// E 题目晚 3.5 秒渲染
await cdp.eval(`localStorage.clear(); ${INTENT_ON}`);
await reload("?late=1");
await cdp.eval(INJECT);
await sleep(13000);
s = await cdp.eval(STATE);
check("E 题目晚渲染也能自动跑完", s.idx === "2" && /已整理 3 题/.test(s.count), JSON.stringify(s));

// F 后端断过属于「异常暂停」→ 仍保留自动模式；点重新抓取则按要求停下
await cdp.eval(`localStorage.clear(); localStorage.setItem('__fail', '1'); ${INTENT_ON}`);
await reload();
await cdp.eval(INJECT);
await sleep(3200);
const paused = await cdp.eval(STATE);
await cdp.eval(`localStorage.setItem('__fail', '0')`);
await cdp.eval(`document.querySelector('#qa-re').click()`);
await sleep(3000);
s = await cdp.eval(STATE);
check("F 断线暂停仍保留自动模式；点重新抓取后停下",
  /连接中断/.test(paused.status) && paused.auto && !s.auto && /已整理 0 题/.test(s.count),
  JSON.stringify({ paused, after: s }));
// F2 手动重新勾选，从零开始跑完一轮
await cdp.eval(`(() => { const el = document.querySelector('#qa-auto'); el.checked = true; el.dispatchEvent(new Event('change')); })()`);
await sleep(9000);
s = await cdp.eval(STATE);
check("F2 手动重新勾选后从零跑完一轮",
  s.idx === "2" && /已整理 3 题/.test(s.count) && !s.auto, JSON.stringify(s));

// G 手动模式不翻页
await cdp.eval(`localStorage.clear()`);
await reload();
await cdp.eval(INJECT);
await sleep(1400);
await cdp.eval(`document.querySelector('#qa-solve').click()`);
await sleep(1800);
const g = await cdp.eval(`(() => {
  const box = document.querySelector('#qa-result');
  return {
    idx: document.body.dataset.idx,
    auto: !!document.querySelector('#qa-auto').checked,
    count: (document.querySelector('#qa-count') || {}).textContent || '',
    shown: !!box && box.style.display !== 'none' && /推荐选项/.test(box.innerText),
  };
})()`);
check("G 手动模式查找答案不翻页", g.idx === "0" && !g.auto && g.shown && /已整理 1 题/.test(g.count), JSON.stringify(g));

// H 跑完一轮后回到第 2 题，点「重新抓取」→ 无条件清空，不再自动重算本题
await cdp.eval(`localStorage.clear(); ${INTENT_ON}`);
await reload();
await cdp.eval(INJECT);
await sleep(9000);
s = await cdp.eval(STATE);
const beforeH = s;
await cdp.eval(`document.querySelector('#prev').click()`);   // 回到第 2 题（已做过）
await sleep(1600);
await cdp.eval(`document.querySelector('#qa-re').click()`);
await sleep(6000);
s = await cdp.eval(STATE);
check("H 重新抓取无条件清空上一轮汇总",
  beforeH.idx === "2" && /已整理 3 题/.test(beforeH.count)
    && /已整理 0 题/.test(s.count) && !s.auto && s.idx === "1",
  JSON.stringify({ before: beforeH, after: s }));

// I 手动模式下清空后可以「撤销清空」
await cdp.eval(`localStorage.clear()`);
await reload();
await cdp.eval(INJECT);
await sleep(1400);
for (let i = 0; i < 2; i++) {
  await cdp.eval(`document.querySelector('#qa-solve').click()`);
  await sleep(1400);
  if (i === 0) { await cdp.eval(`document.querySelector('#next').click()`); await sleep(1800); }
}
await cdp.eval(`document.querySelector('#prev').click()`);    // 回到第 1 题（已做过）
await sleep(1800);
await cdp.eval(`document.querySelector('#qa-re').click()`);
await sleep(1500);
const cleared = await cdp.eval(`(() => ({
  count: (document.querySelector('#qa-count') || {}).textContent || '',
  undo: (() => { const b = document.querySelector('#qa-undo'); return !!b && b.style.display !== 'none'; })(),
  status: (document.querySelector('#qa-status') || {}).textContent || '',
}))()`);
await cdp.eval(`document.querySelector('#qa-undo').click()`);
await sleep(600);
s = await cdp.eval(STATE);
check("I 撤销清空能还原之前的汇总",
  /已整理 0 题/.test(cleared.count) && cleared.undo && /已清空之前/.test(cleared.status)
    && /已整理 2 题/.test(s.count),
  JSON.stringify({ cleared, after: s }));

// J 当前题还没做过时，点一次「重新抓取」就直接清空（不再需要 8 秒内二次确认）
await cdp.eval(`localStorage.clear()`);
await reload();
await cdp.eval(INJECT);
await sleep(1400);
await cdp.eval(`document.querySelector('#qa-solve').click()`);   // 第 1 题已记录
await sleep(1400);
await cdp.eval(`document.querySelector('#next').click()`);       // 翻到第 2 题（还没做过）
await sleep(1800);
await cdp.eval(`document.querySelector('#qa-re').click()`);
await sleep(1200);
s = await cdp.eval(STATE);
check("J 未做过的题上点一次重新抓取就直接清空",
  /已整理 0 题/.test(s.count) && /已清空之前 1 题/.test(s.status) && !s.auto,
  JSON.stringify(s));

// K 「夸克核对」：复制题干+选项并打开夸克 AI 搜索，且不改动汇总 / 自动流程
await cdp.eval(`localStorage.clear()`);
await reload();
await cdp.eval(INJECT);
await sleep(1400);
await cdp.eval(`window.__opened = []; window.open = (u) => { window.__opened.push(u); return {}; };`);
await cdp.eval(`document.querySelector('#qa-check').click()`);
await sleep(1200);
const k = await cdp.eval(`(() => ({
  opened: window.__opened || [],
  status: (document.querySelector('#qa-status') || {}).textContent || '',
  idx: document.body.dataset.idx,
  count: (document.querySelector('#qa-count') || {}).textContent || '',
  auto: !!(document.querySelector('#qa-auto') || {}).checked,
}))()`);
const kUrl = k.opened[0] ? decodeURIComponent(k.opened[0]) : "";
check("K 夸克核对复制题目并打开搜索，不影响自动流程",
  k.opened.length === 1 && /quark\.cn\/s\?q=/.test(k.opened[0]) && /中国的首都/.test(kUrl)
    && /已复制题干|复制失败/.test(k.status) && k.idx === "0" && /已整理 0 题/.test(k.count) && !k.auto,
  JSON.stringify({ ...k, kUrl }));

// L 手动开启自动模式 = 全新一轮：先清空上一轮汇总（可撤销），再从头跑完
await cdp.eval(`localStorage.clear()`);
await reload();
await cdp.eval(INJECT);
await sleep(1400);
await cdp.eval(`document.querySelector('#qa-solve').click()`);
await sleep(1600);
const beforeL = await cdp.eval(STATE);
const clearedL = await cdp.eval(`(() => {
  const el = document.querySelector('#qa-auto');
  el.checked = true; el.dispatchEvent(new Event('change'));
  const b = document.querySelector('#qa-undo');
  return {
    undo: !!b && b.style.display !== 'none',
    status: (document.querySelector('#qa-status') || {}).textContent || '',
    count: (document.querySelector('#qa-count') || {}).textContent || '',
  };
})()`);
await sleep(9000);
s = await cdp.eval(STATE);
check("L 手动开启自动模式会清空上一轮并重新跑完",
  /已整理 1 题/.test(beforeL.count) && /已整理 0 题/.test(clearedL.count)
    && /已清空上一轮/.test(clearedL.status) && clearedL.undo
    && s.idx === "2" && /已整理 3 题/.test(s.count) && !s.auto,
  JSON.stringify({ beforeL, clearedL, after: s }));

console.log("\n==== 汇总 ====");
results.forEach((r) => console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}`));
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} 通过`);

ws.close();
chrome.kill();
server.close();
process.exit(failed ? 1 : 0);
