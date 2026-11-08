/* 加密文字解码的端到端测试（无头 Chrome + CDP，不依赖 npm 包）
 *
 * 复现雨课堂的真实结构：题干/选项里**只有部分文字**套了加密字体
 * （<span class="xuetangx-com-encrypted-font">），其它字是正常中文。
 *
 * 覆盖：
 *   E1 混排题干：只还原加密节点，正常字原样保留（不再出现“阴束时”这类乱码）
 *   E2 题干是纯明文、只有选项加密：映射已存在时也绝不把映射套到正常文字上
 *   E3 解码失败：自动模式必须停在本题，绝不拿乱码去调模型（solve 调用数必须为 0）
 *
 * 运行： node tests/decode.e2e.mjs
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
const MOCK = path.join(HERE, "mock-exam-enc.html");
const PAGE = "mock-exam-enc.html";
const PORT = Number(process.env.QA_ENC_PORT || 8879);
const DEBUG_PORT = Number(process.env.QA_ENC_CDP || 9335);
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const ENC_QUESTION_EXPECT = "测量坐位体前屈时,可以单臂推送游标或发性推送游标( )";
const PLAIN_QUESTION = "以下关于运动后补水的说法，正确的是（ ）";

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
    if (url === "/fake-font.ttf") {
      res.writeHead(200, { "Content-Type": "font/ttf" });
      res.end(Buffer.from("fake"));
      return;
    }
    res.writeHead(404); res.end("not found");
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const profile = path.join(os.tmpdir(), "qa-enc-" + Date.now());
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
  solve: window.__solveCalls || 0,
  next: window.__nextClicked || 0,
  chromeOk: !!(window.chrome && window.chrome.runtime && window.chrome.runtime.sendMessage),
  auto: !!(document.querySelector('#qa-auto') || {}).checked
}))()`;

const nav = async (q = "") => {
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/${PAGE}${q}` });
  await sleep(900);
};

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + (detail || "")}`);
}

// —— E1 混排题干：只还原加密节点，正常字不动 ——
await nav();
await cdp.eval("localStorage.clear()");
await cdp.eval(INJECT);
await sleep(1400);
await cdp.eval(`document.querySelector('#qa-re').click()`);
await sleep(1600);
let s = await cdp.eval(SNAP);
check("E1 加密字还原成真字，正常字（坐/屈/臂 等）原样保留",
  s.q === ENC_QUESTION_EXPECT,
  JSON.stringify({ got: s.q, want: ENC_QUESTION_EXPECT, chromeOk: s.chromeOk, status: s.status.slice(0, 200) }));

const cipherRe = /[油容伤波票径提共抗行甲师历展请]/;
check("E1b 面板里不再出现任何密文字（没有把映射套到正常字上）",
  !cipherRe.test(s.q) && !s.opts.some((o) => cipherRe.test(o)),
  JSON.stringify({ q: s.q, opts: s.opts }));

// —— E2 题干纯明文、只有选项加密：正常文字绝不能被映射 ——
await nav("?mixed=1");
await cdp.eval("localStorage.clear()");
await cdp.eval(INJECT);
await sleep(1400);
await cdp.eval(`document.querySelector('#qa-re').click()`);
await sleep(1600);
s = await cdp.eval(SNAP);
check("E2 纯明文题干原样保留（映射已加载也不套用）",
  s.q === PLAIN_QUESTION,
  JSON.stringify({ got: s.q, want: PLAIN_QUESTION }));
check("E2b 加密选项被还原，明文选项不动",
  s.opts.length === 2 && s.opts[0] === "可以少量多次" && s.opts[1] === "一次性大量饮水",
  JSON.stringify({ opts: s.opts }));

// —— E3 解码失败：绝不拿乱码调模型 ——
await nav("?mode=fail");
await cdp.eval("localStorage.clear()");
await cdp.eval(INJECT);
await sleep(1400);
await cdp.eval(`(() => { const el = document.querySelector('#qa-auto'); el.checked = true; el.dispatchEvent(new Event('change')); })()`);
await sleep(12000);
s = await cdp.eval(SNAP);
check("E3 解码失败时一次 solve 都不发（不拿乱码答题）",
  s.solve === 0,
  JSON.stringify({ solve: s.solve, status: s.status.slice(0, 160) }));
check("E3b 解码失败时停在本题：不点下一题、状态明确提示加密文字没还原",
  s.next === 0 && /(加密|还原|解码)/.test(s.status),
  JSON.stringify({ next: s.next, status: s.status.slice(0, 200) }));

const pass = results.filter((r) => r.ok).length;
console.log(`\n==== 汇总 ====\n${pass}/${results.length} 通过`);

try { chrome.kill(); } catch (e) {}
server.close();
process.exit(pass === results.length ? 0 : 1);
