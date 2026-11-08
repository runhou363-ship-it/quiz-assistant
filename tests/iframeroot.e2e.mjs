/* 抓取修复的端到端测试（无头 Chrome + CDP，不依赖 npm 包）
 *
 * 复现真实雨课堂结构：外层页面是课程目录 + 屏幕外反自动化诱饵，真题目在 iframe 的 .problem-body 里。
 * 覆盖：
 *   P1 题干取自 iframe 的 problem-body，而不是外层课程目录
 *   P2 选项取自 iframe（判断题 true/false），不被诱饵的假选项 E 污染
 *   P3 自动模式绝不点屏幕外的诱饵「下一题」
 *   P4 题目没识别出来时绝不翻页跳过（不点「下一题」，而是暂停等用户）
 *
 * 运行： node tests/iframeroot.e2e.mjs
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
const MOCK = path.join(HERE, "mock-exam-iframe.html");
const PAGE = "mock-exam-iframe.html";
const PORT = Number(process.env.QA_IFRAME_PORT || 8878);
const DEBUG_PORT = Number(process.env.QA_IFRAME_CDP || 9334);
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const server = createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  try {
    if (url === "/" + PAGE || url === "/") {
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
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const profile = path.join(os.tmpdir(), "qa-iframeroot-" + Date.now());
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--disable-extensions",
  "--remote-allow-origins=*", "--window-size=1280,900",
  `http://127.0.0.1:${PORT}/${PAGE}`,
], { stdio: "ignore" });

async function firstPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.url.includes(PAGE));
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

const INJECT = `new Promise((res) => {
  const s = document.createElement('script');
  s.src = '/inject.js';
  s.onload = () => res('ok'); s.onerror = () => res('err');
  document.body.appendChild(s);
})`;

const SNAP = `(() => ({
  q: (document.querySelector('#qa-q') || {}).value || '',
  opts: Array.from(document.querySelectorAll('#qa-opts input[type=text]')).map((i) => i.value),
  status: (document.querySelector('#qa-status') || {}).textContent || '',
  count: (document.querySelector('#qa-count') || {}).textContent || '',
  decoy: window.__decoyClicked || 0,
  next: window.__nextClicked || 0,
  auto: !!(document.querySelector('#qa-auto') || {}).checked,
  panel: !!document.querySelector('#qa-panel')
}))()`;

const nav = async (q = "") => {
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/${PAGE}${q}` });
  await sleep(1000);
};

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + (detail || "")}`);
}

// —— P1/P2 外层目录 + 诱饵 + iframe 真题目 ——
await nav();
await cdp.eval(INJECT);
await sleep(1300);
await cdp.eval(`document.querySelector('#qa-re').click()`);
await sleep(1600);
let s = await cdp.eval(SNAP);
check("P1 题干取自 iframe 的 problem-body，不是外层课程目录",
  s.panel && /运动健身的本质/.test(s.q) && !/视频/.test(s.q) && !/第[一二三四五六七八九十]+节/.test(s.q),
  JSON.stringify({ q: s.q.slice(0, 120) }));
check("P2 选项取自 iframe 且不被诱饵假选项 E 污染",
  s.opts.length === 2 && s.opts.every((x) => /^(true|false|正确|错误|对|错|√|×)$/i.test(String(x).trim())),
  JSON.stringify({ opts: s.opts }));

// —— P3 自动模式不点屏幕外的诱饵「下一题」 ——
await cdp.eval(`(() => { const el = document.querySelector('#qa-auto'); el.checked = true; el.dispatchEvent(new Event('change')); })()`);
await sleep(3000);
s = await cdp.eval(SNAP);
check("P3 自动跑动时不点屏幕外诱饵「下一题」",
  s.decoy === 0,
  JSON.stringify({ decoy: s.decoy, next: s.next, status: s.status }));

// —— P4 没识别出来时绝不翻页跳过 ——
await cdp.eval("localStorage.clear()");   // 清掉上一轮遗留的会话，避免干扰计数断言
await nav("?broken=1");
await cdp.eval(INJECT);
await sleep(1000);
await cdp.eval(`(() => { const el = document.querySelector('#qa-auto'); el.checked = true; el.dispatchEvent(new Event('change')); })()`);
await sleep(16000);
const b = await cdp.eval(SNAP);
check("P4 题目没识别出来时不点「下一题」（重试后暂停）",
  b.next === 0 && /(没识别|未识别|暂停|重新抓取)/.test(b.status) && !/[1-9]\d*\s*题/.test(b.count),
  JSON.stringify({ next: b.next, status: b.status.slice(0, 160), count: b.count }));

const pass = results.filter((r) => r.ok).length;
console.log(`\n==== 汇总 ====\n${pass}/${results.length} 通过`);

try { chrome.kill(); } catch (e) {}
server.close();
process.exit(pass === results.length ? 0 : 1);
