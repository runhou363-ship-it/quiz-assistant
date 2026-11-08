/* 加密字体发现逻辑离线测试：验证能通过三条路径找到雨课堂的 exam-data-decrypt-font。
 * 背景：真实诊断里字体族名是 exam-data-decrypt-font，旧正则只认 encrypt 所以永远找不到，
 * 而且它写在跨域 CSS 里（读 cssRules 会抛 SecurityError），必须走资源时序或抓 CSS 文本。
 * 运行：node tests/fontfind.test.js
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "extension", "inject.js"), "utf8");
const START = SRC.indexOf("    // —— 加密字体（雨课堂 exam-data-decrypt-font");
const END = SRC.indexOf("    async function runSolve()");
if (START < 0 || END < 0) throw new Error("没能定位字体发现代码块");
const BLOCK = SRC.slice(START, END);

/* ---------------- 构造运行环境 ---------------- */
function makeEnv({ sheets = [], fonts = [], resources = [], links = [], href = "https://changjiang.yuketang.cn/v2/web/x" } = {}) {
  const doc = {
    styleSheets: sheets,
    fonts: { forEach: (cb) => fonts.forEach((f) => cb({ family: f })) },
    defaultView: {
      location: { href },
      performance: { getEntriesByType: (t) => (t === "resource" ? resources.map((n) => ({ name: n })) : []) },
    },
  };
  const collectRoots = () => [doc];
  const qsaIn = (root, sel) => (sel.indexOf("link") >= 0 ? links.map((h) => ({ getAttribute: () => h })) : []);

  return {
    collectRoots,
    qsaIn,
    location: { href },
  };
}

function makeChrome(handlers) {
  return {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        const h = handlers[msg.type];
        const res = h ? h(msg.payload) : { ok: false, error: "no handler " + msg.type };
        setTimeout(() => cb(res), 0);
      },
    },
  };
}

function load(env, chrome) {
  const factory = new Function(
    "collectRoots", "qsaIn", "location", "chrome", "fetch", "btoa",
    `"use strict";\n${BLOCK}\nreturn { collectFontHints, rankFontUrls, getFontB64, parseFontFaces };`
  );
  return factory(
    env.collectRoots,
    env.qsaIn,
    env.location,
    chrome,
    () => Promise.reject(new Error("page fetch blocked")),
    (s) => Buffer.from(s, "binary").toString("base64")
  );
}

const B64 = "d09GMgABAAAAA=="; // 假装是字体内容
const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra });
  console.log((cond ? "PASS  " : "FAIL  ") + name + (cond ? "" : "  << " + JSON.stringify(extra)));
}

/* ---------------- 用例 ---------------- */
async function case1_inlineFontFace() {
  // 同源内联 @font-face：应该直接认出来（旧代码漏在 "encrypt" 这个名字上）
  const sheet = {
    href: null,
    cssRules: [
      { cssText: '@font-face { font-family: "exam-data-decrypt-font"; src: url("/static/font/decrypt.woff2") format("woff2"); }' },
      { cssText: '@font-face { font-family: "MathJax_Main"; src: url("https://cdn/mathjax.woff") format("woff"); }' },
    ],
  };
  const env = makeEnv({ sheets: [sheet] });
  const chrome = makeChrome({
    fetch_font: (p) => ({ ok: true, b64: B64, size: 2048, magic: "wOF2", url: p.url }),
  });
  const api = load(env, chrome);

  const hints = api.collectFontHints();
  const cands = api.rankFontUrls(hints);
  const url = await api.getFontB64();

  check("内联 @font-face 被解析成绝对地址",
    hints.faces.some((f) => f.family === "exam-data-decrypt-font" && f.url === "https://changjiang.yuketang.cn/static/font/decrypt.woff2"),
    hints.faces);
  check("评分：decrypt 字体排第一", cands[0] && cands[0].url.indexOf("decrypt.woff2") >= 0, cands);
  check("评分：MathJax 被排除", !cands.some((c) => /mathjax/i.test(c.url)), cands);
  check("取到字体 base64", url === B64, url);
}

async function case2_crossOriginCss() {
  // 真实情况：样式表跨域，读 cssRules 抛错；@font-face 只在资源时序里露过面
  const crossSheet = { href: "https://fe-static-yuketang.yuketang.cn/fe/css/exam.css" };
  Object.defineProperty(crossSheet, "cssRules", {
    get() { throw new Error("SecurityError: cssRules 不可读"); },
  });
  const env = makeEnv({
    sheets: [crossSheet],
    fonts: ["exam-data-decrypt-font", "MathJax_Main"],
    resources: [
      "https://fe-static-yuketang.yuketang.cn/fe/static/js/mathjax/fonts/MathJax_Main.woff",
      "https://changjiang.yuketang.cn/api/v2/font/exam-data-decrypt.woff2?v=7",
    ],
  });
  const cssText = '@font-face{font-family:exam-data-decrypt-font;src:url("/api/v2/font/exam-data-decrypt.woff2?v=7")}';
  const chrome = makeChrome({
    fetch_text: () => ({ ok: true, text: cssText }),
    fetch_font: (p) => ({ ok: true, b64: B64, size: 4096, magic: "wOF2", url: p.url }),
  });
  const api = load(env, chrome);

  const hints = api.collectFontHints();
  check("跨域样式表被记下 href", hints.cssHrefs.length === 1, hints.cssHrefs);
  check("资源时序里找到字体 URL", hints.resourceUrls.length === 2, hints.resourceUrls);

  const url = await api.getFontB64();
  check("跨域场景也能取到字体", url === B64, url);
}

async function case3_notAFont() {
  // 地址给回来的是 HTML（404 页），魔数不是字体 → 必须跳过而不是拿去做解码
  const sheet = {
    href: null,
    cssRules: [{ cssText: '@font-face { font-family: "exam-data-decrypt-font"; src: url("/oops.woff2"); }' }],
  };
  const env = makeEnv({ sheets: [sheet] });
  const chrome = makeChrome({
    fetch_font: () => ({ ok: true, b64: B64, size: 100, magic: "<!DO", url: "https://x/oops.woff2" }),
  });
  const api = load(env, chrome);
  const url = await api.getFontB64();
  check("非字体文件被拒绝", url === "", url);
}

async function case4_preloadLink() {
  // 字体可能只出现在 <link as=font> 里
  const env = makeEnv({ links: ["/static/f/decrypt-exam.woff2"] });
  const chrome = makeChrome({
    fetch_font: (p) => ({ ok: true, b64: B64, size: 1024, magic: "wOFF", url: p.url }),
  });
  const api = load(env, chrome);
  const hints = api.collectFontHints();
  const url = await api.getFontB64();
  check("link[as=font] 被收集", hints.resourceUrls.some((u) => u.indexOf("decrypt-exam.woff2") >= 0), hints.resourceUrls);
  check("link 路径也能取到字体", url === B64, url);
}

(async () => {
  await case1_inlineFontFace();
  await case2_crossOriginCss();
  await case3_notAFont();
  await case4_preloadLink();

  const bad = results.filter((r) => !r.ok);
  console.log("\n" + (bad.length ? `失败 ${bad.length} 项` : "全部用例通过"));
  process.exit(bad.length ? 1 : 0);
})();
