/* 自动流程端到端测试（无头 Chrome + CDP，不依赖任何 npm 包）
 *
 * 覆盖 v0.9.5 修的「新开页面 / 点重新抓取后不自动翻页」：
 *   A 新开的页面按上次勾选自动跑完整份
 *   B 刷新后再注入，仍然自动续跑
 *   C 自动跑的过程中连点「重新抓取」，仍能继续且不重复记题
 *   D 没勾自动模式时，重新抓取只刷新、不乱跑
 *   E 题目比面板晚 3.5 秒渲染，也能等到并跑完
 *   F 后端断过一次（已暂停），恢复后点重新抓取能续跑
 *   G 手动模式「查找答案」只出结果、不翻页
 *   H 跑完后回到已做过的一题，点「重新抓取」→ 汇总从当前题重新开始
 *   I 「撤销清空」能把清空前的汇总还原
 *   J 未做过的题上第一次保留进度，再点一次才清空
 *   K 「夸克核对」复制题目并打开夸克搜索，不影响自动流程
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

// A 新页面：之前勾过自动模式 → 自动跑完
await cdp.eval(`localStorage.clear(); ${INTENT_ON}`);
await reload();
await cdp.eval(INJECT);
await sleep(9000);
let s = await cdp.eval(STATE);
check("A 新页面按上次勾选自动跑完", s.panel && s.auto && s.idx === "2" && /已整理 3 题/.test(s.count), JSON.stringify(s));

// B 刷新后仍自动
await reload();
await cdp.eval(INJECT);
await sleep(9000);
s = await cdp.eval(STATE);
check("B 刷新后仍然自动续跑", s.panel && s.auto && s.idx === "2" && /已整理 3 题/.test(s.count), JSON.stringify(s));

// C 自动过程中连点重新抓取
await cdp.eval(`localStorage.clear()`);
await reload();
await cdp.eval(INJECT);
await sleep(1500);
await cdp.eval(`(() => { const el = document.querySelector('#qa-auto'); el.checked = true; el.dispatchEvent(new Event('change')); })()`);
await sleep(150);
await cdp.eval(`document.querySelector('#qa-re').click()`);
await sleep(250);
await cdp.eval(`document.querySelector('#qa-re').click()`);
await sleep(9000);
s = await cdp.eval(STATE);
check("C 点重新抓取后继续翻页且不重复记题", s.idx === "2" && /已整理 3 题/.test(s.count), JSON.stringify(s));

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

// F 后端断过 → 恢复后点重新抓取
await cdp.eval(`localStorage.clear(); localStorage.setItem('__fail', '1'); ${INTENT_ON}`);
await reload();
await cdp.eval(INJECT);
await sleep(3200);
const paused = await cdp.eval(STATE);
await cdp.eval(`localStorage.setItem('__fail', '0')`);
await cdp.eval(`document.querySelector('#qa-re').click()`);
await sleep(9000);
s = await cdp.eval(STATE);
check("F 后端恢复后重新抓取能续跑",
  /连接中断/.test(paused.status) && paused.auto && s.idx === "2" && /已整理 3 题/.test(s.count),
  JSON.stringify({ paused, after: s }));

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

// H 跑完后回到第 2 题，点「重新抓取」→ 汇总从当前题重新开始（3 题 → 2 题）
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
check("H 重新抓取后汇总从当前题重新开始",
  beforeH.idx === "2" && /已整理 3 题/.test(beforeH.count) && s.idx === "2" && /已整理 2 题/.test(s.count),
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
  /已整理 0 题/.test(cleared.count) && cleared.undo && /已从本题重新开始汇总/.test(cleared.status)
    && /已整理 2 题/.test(s.count),
  JSON.stringify({ cleared, after: s }));

// J 当前题还没做过时，第一次重新抓取保留进度，8 秒内再点一次才清空
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
const kept = await cdp.eval(STATE);
await cdp.eval(`document.querySelector('#qa-re').click()`);      // 8 秒内再点一次 = 确认清空
await sleep(1200);
s = await cdp.eval(STATE);
check("J 未做过的题上重新抓取保留进度，再点一次才清空",
  /已整理 1 题/.test(kept.count) && /本题还没在汇总里/.test(kept.status) && /已整理 0 题/.test(s.count),
  JSON.stringify({ kept, after: s }));

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

console.log("\n==== 汇总 ====");
results.forEach((r) => console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}`));
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} 通过`);

ws.close();
chrome.kill();
server.close();
process.exit(failed ? 1 : 0);
