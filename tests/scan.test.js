/* 章节扫描算法离线测试：用假 DOM 跑 deepScanChapters，验证计数规则。
 * 运行：node tests/scan.test.js
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");
const START = SRC.indexOf("async function deepScanChapters");
const END = SRC.indexOf("async function handleCount");
if (START < 0 || END < 0) throw new Error("没能从 background.js 里定位到 deepScanChapters");
const FN_SRC = SRC.slice(START, END);

const makeScanner = (doc, href) => {
  const factory = new Function(
    "document", "location", "URL", "setTimeout",
    FN_SRC + "\nreturn deepScanChapters;"
  );
  return factory(doc, { href }, URL, setTimeout);
};

/* ---------------- 假 DOM ---------------- */
class El {
  constructor(tag, opts = {}) {
    this.tagName = tag.toUpperCase();
    this._text = opts.text || "";
    this.children = opts.children || [];
    this._attrs = opts.attrs || {};
    this.children.forEach((c) => (c.parentElement = this));
    this.scrollTop = opts.scrollTop || 0;
    this.scrollHeight = opts.scrollHeight || 600;
    this.clientHeight = opts.clientHeight || 300;
    this.clicked = 0;
  }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join(" ");
    return this._text;
  }
  get innerText() {
    return this.textContent.replace(/\s+/g, " ").trim();
  }
  getBoundingClientRect() {
    return { width: 300, height: 20 };
  }
  getAttribute(k) { return this._attrs[k] || null; }
  click() { this.clicked++; }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() {
    const out = [];
    const walk = (n) => n.children.forEach((c) => { out.push(c); walk(c); });
    walk(this);
    return out;
  }
}

const makeDoc = (root, title) => {
  const scrollEl = new El("html", { scrollHeight: 600, clientHeight: 300 });
  return {
    title: title || "长江雨课堂",
    body: root,
    scrollingElement: scrollEl,
    documentElement: scrollEl,
    defaultView: { getComputedStyle: () => ({ overflowY: "auto" }) },
    querySelectorAll(sel) {
      if (sel === "iframe") return [];
      return [root, ...root.querySelectorAll()];
    },
  };
};

const t = (tag, text, kids) => new El(tag, { text, children: kids });

/* ---------------- 用例 ---------------- */
const cases = [];

// 1) 雨课堂式表格：章节行 + 任务类型
cases.push({
  name: "表格型（1.1 / 1.2 / 2.1）",
  root: t("div", "", [
    t("div", "长江雨课堂"),
    t("div", "未完成 已完成"),
    t("table", "", [
      t("tr", "章节 任务点 状态"),
      t("tr", "", [t("td", "1.1 计算机系统概述"), t("td", "视频 30:00 课件 习题")]),
      t("tr", "", [t("td", "1.2 计算机的发展"), t("td", "视频 20:00")]),
      t("tr", "", [t("td", "2.1 操作系统概述"), t("td", "习题 10:00")]),
    ]),
  ]),
  expect: (r) => r.total === 3 && r.topLevel === 2 && r.byLevel[2] === 3,
});

// 2) 章 + 节混排
cases.push({
  name: "章/节混排（第一章 + 1.1）",
  root: t("div", "", [
    t("h3", "第一章 绪论"),
    t("div", "1.1 什么是计算机"),
    t("h3", "第二章 计算机系统"),
    t("div", "2.1 硬件组成"),
  ]),
  expect: (r) => r.total === 4 && r.byLevel[1] === 2 && r.byLevel[2] === 2 && r.topLevel === 2,
});

// 3) 干扰项：时间、算式、年份不应被当成章节
cases.push({
  name: "干扰项过滤（30:00 / 1+1=? / 2024）",
  root: t("div", "", [
    t("div", "30:00"),
    t("div", "1+1=?"),
    t("div", "2024 年 课表"),
    t("div", "3.1 真正的小节"),
  ]),
  expect: (r) => r.total === 1 && r.items[0].title.indexOf("3.1") === 0,
});

// 4) 无编号目录：兜底候选 + 警告
cases.push({
  name: "无编号目录兜底",
  root: t("nav", "", [
    t("li", "绪论"),
    t("li", "基础知识"),
    t("li", "进阶练习"),
  ]),
  expect: (r) => r.total === 3 && r.warnings.length === 1,
});

// 5) 登录页：应给出提示
cases.push({
  name: "登录页提示",
  root: t("div", "", [t("div", "扫码登录"), t("div", "账号密码登录")]),
  title: "长江雨课堂网页版-登录",
  expect: (r) => r.total === 0 && r.warnings.join("").indexOf("登录页") >= 0,
});

/* ---------------- 跑 ---------------- */
(async () => {
  let failed = 0;
  for (const c of cases) {
    const doc = makeDoc(c.root, c.title);
    const scan = makeScanner(doc, "https://changjiang.yuketang.cn/v2/web/studentLog/1");
    const r = await scan({ expand: false, maxMs: 400 });
    let ok = false;
    try { ok = !!c.expect(r); } catch (e) { ok = false; }
    if (!ok) failed++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${c.name}  total=${r.total} top=${r.topLevel} byLevel=${JSON.stringify(r.byLevel)} tasks=${r.taskPoints}` +
      (r.warnings.length ? `  warn="${r.warnings[0].slice(0, 24)}..."` : "")
    );
    if (!ok && r.items.length) console.log("      items:", r.items.map((i) => i.title).join(" | "));
  }
  console.log(failed ? `\n${failed} 个用例失败` : "\n全部用例通过");
  process.exit(failed ? 1 : 0);
})();
