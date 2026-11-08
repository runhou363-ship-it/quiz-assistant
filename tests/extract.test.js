/* 题干/选项抓取逻辑离线测试：用假 DOM 跑 inject.js 里的 extractQuestion。
 * 运行：node tests/extract.test.js
 */
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "extension", "inject.js"), "utf8");
const START = SRC.indexOf("  const QA_PANEL_SEL");
const END = SRC.indexOf("  // 左侧/顶部题号导航");
if (START < 0 || END < 0) throw new Error("没能定位 extractQuestion 代码块");
const BLOCK = SRC.slice(START, END);

/* ---------------- 迷你 DOM ---------------- */
class El {
  constructor(tag, opts = {}) {
    this.tag = tag.toUpperCase();
    this.text = opts.text || "";
    this.classes = (opts.cls || "").split(/\s+/).filter(Boolean);
    this.attrs = Object.assign({}, opts.attrs);
    this.children = opts.children || [];
    this.children.forEach((c) => (c.parent = this));
  }
  get className() { return this.classes.join(" "); }
  get textContent() { return this.children.length ? this.children.map((c) => c.textContent).join(" ") : this.text; }
  get innerText() { return this.textContent.replace(/\s+/g, " ").trim(); }
  get parentElement() { return this.parent || null; }
  getBoundingClientRect() { return { width: 300, height: 20 }; }
  closest(sel) {
    let n = this;
    while (n) {
      if (matches(n, sel)) return n;
      n = n.parent || null;
    }
    return null;
  }
}

function matches(el, sel) {
  sel = sel.trim();
  if (sel === "*") return true;
  if (sel[0] === "#") return el.attrs.id === sel.slice(1);
  if (sel[0] === ".") return el.classes.indexOf(sel.slice(1)) >= 0;
  let m = sel.match(/^\[([\w-]+)="?([^"\]]*)"?\]$/);
  if (m) return el.attrs[m[1]] === m[2];
  m = sel.match(/^([\w-]*)\[([\w-]+)="?([^"\]]*)"?\]$/);
  if (m) {
    const tagOk = !m[1] || el.tag === m[1].toUpperCase();
    return tagOk && el.attrs[m[2]] === m[3];
  }
  return el.tag === sel.toUpperCase();
}

function makeDoc(root, extra) {
  const all = (n, out) => { n.children.forEach((c) => { out.push(c); all(c, out); }); return out; };
  const nodes = [root].concat(all(root, []));
  const qsa = (sel) => {
    const list = sel.split(",").map((s) => s.trim());
    return nodes.filter((el) => list.some((s) => matches(el, s)));
  };
  const doc = { querySelectorAll: qsa, querySelector: (sel) => qsa(sel)[0] || null };
  (extra || []).forEach((el) => { el.parent = root; nodes.push(el); });
  return doc;
}

const t = (tag, opts) => new El(tag, opts || {});

/* ---------------- 用例 ---------------- */
const cases = [];

// 1) 雨课堂作业：圆圈字母 + 文字（字母后无顿号）
{
  const opt = (letter, txt) => t("div", { cls: "option", children: [
    t("span", { cls: "letter", text: letter }),
    t("span", { cls: "text", text: txt }),
  ]});
  const options = t("div", { cls: "options", children: [
    opt("A", "综合性"), opt("B", "交叉性"), opt("C", "复杂性"), opt("D", "哲理性"),
  ]});
  const root = t("div", { cls: "page", children: [
    t("div", { cls: "subject", text: "以下哪项不是自然辩证法的特点（ ）" }),
    options,
  ]});
  cases.push({
    name: "圆圈字母选项（无 A. 顿号）",
    root,
    expect: (r) =>
      r.options.length === 4 &&
      r.options[0] === "综合性" &&
      r.options[3] === "哲理性" &&
      r.question.indexOf("自然辩证法") >= 0 &&
      r.question.indexOf("综合性") < 0,
  });
}

// 2) 字母带顿号的老结构
{
  const root = t("div", { cls: "page", children: [
    t("div", { cls: "stem", text: "1.单选题（1分）下列哪个是质数？" }),
    t("div", { cls: "list", children: [
      t("div", { text: "A、2" }), t("div", { text: "B、4" }), t("div", { text: "C、6" }),
    ]}),
  ]});
  cases.push({
    name: "A、顿号结构",
    root,
    expect: (r) =>
      r.options.length === 3 &&
      r.options[0] === "2" &&
      r.options[2] === "6" &&
      r.question.indexOf("质数") >= 0 &&
      r.question.indexOf("A、") < 0,
  });
}

// 3) 关键回归：面板里的勾选框不能被当成选项
{
  const panel = t("div", { cls: "panel", attrs: { id: "qa-panel" }, children: [
    t("label", { children: [
      t("input", { attrs: { type: "checkbox" } }),
      t("span", { text: "自动模式：自动找答案并翻页（不替你选）" }),
    ]}),
  ]});
  const root = t("div", { cls: "page", children: [t("div", { cls: "empty", text: "页面暂无内容" }), panel] });
  cases.push({
    name: "不抓插件自己面板里的勾选框",
    root,
    expect: (r) => r.options.length === 0 || r.options.join("").indexOf("自动模式") < 0,
  });
}

// 4) 复刻截图页：左侧边栏有「知识点」标题，选项节点有 4 个子元素（旧的 children>3 限制会漏）
{
  const opt = (letter, txt) => t("div", { cls: "option-item", children: [
    t("span", { cls: "circle", text: letter }),
    t("span", { cls: "gap" }),
    t("div", { cls: "content", children: [t("span", { text: txt })] }),
    t("span", { cls: "mark" }),
  ]});
  const card = t("div", { cls: "card", children: [
    t("div", { cls: "qtype", text: "1.单选题 (1分)" }),
    t("div", { cls: "qstem", text: "以下哪项不是自然辩证法的特点（ ）" }),
    t("div", { cls: "opt-list", children: [
      opt("A", "综合性"), opt("B", "交叉性"), opt("C", "复杂性"), opt("D", "哲理性"),
    ]}),
  ]});
  const sidebar = t("div", { cls: "side", children: [
    t("div", { cls: "side-title", text: "知识点" }),
    t("div", { cls: "side-sub", text: "完成度 0%" }),
  ]});
  const root = t("div", { cls: "page", children: [sidebar, card] });
  cases.push({
    name: "截图页复刻：侧边栏干扰 + 选项4子元素",
    root,
    expect: (r) =>
      r.options.length === 4 &&
      r.options[0] === "综合性" &&
      r.options[3] === "哲理性" &&
      r.question.indexOf("自然辩证法") >= 0 &&
      r.question.indexOf("知识点") < 0 &&
      r.question.indexOf("综合性") < 0,
  });
}

// 5) 字母圈与文字是兄弟节点（字母单独成块）
{
  const row = (letter, txt) => t("div", { cls: "row", children: [
    t("div", { cls: "badge", text: letter }),
    t("div", { cls: "txt", text: txt }),
  ]});
  const root = t("div", { cls: "page", children: [
    t("div", { cls: "stem", text: "下列哪个选项正确（ ）" }),
    t("div", { cls: "rows", children: [row("A", "甲方案"), row("B", "乙方案"), row("C", "丙方案")] }),
  ]});
  cases.push({
    name: "字母单独成块 + 兄弟节点文字",
    root,
    expect: (r) => r.options.length === 3 && r.options.join(",") === "甲方案,乙方案,丙方案",
  });
}

// 6) 字母是图标（文本里没有字母）→ 靠「重复同级块」兜底
{
  const row = (txt) => t("div", { cls: "opt", children: [t("i", { cls: "icon" }), t("span", { text: txt })] });
  const root = t("div", { cls: "page", children: [
    t("div", { cls: "type", text: "单选题" }),
    t("div", { cls: "stem", text: "下列哪项属于唯物辩证法（ ）" }),
    t("div", { cls: "opts", children: [row("联系的观点"), row("静止的观点"), row("孤立的观点"), row("不变的观点")] }),
  ]});
  cases.push({
    name: "字母为图标：重复同级块兜底",
    root,
    expect: (r) => r.options.length === 4 && r.options[0] === "联系的观点" && r.question.indexOf("唯物辩证法") >= 0,
  });
}

/* ---------------- 跑 ---------------- */
const factory = new Function("document", "cssEscape", BLOCK + "\nreturn { extractQuestion };");
let failed = 0;
for (const c of cases) {
  const doc = makeDoc(c.root);
  const api = factory(doc, (s) => s);
  let r;
  try { r = api.extractQuestion(); } catch (e) { r = { question: "", options: [], error: e.message }; }
  const ok = !r.error && c.expect(r);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  console.log(`      题干：「${(r.question || "").slice(0, 40)}」`);
  console.log(`      选项：${JSON.stringify(r.options)}${r.error ? "  err=" + r.error : ""}`);
}
console.log(failed ? `\n${failed} 个用例失败` : "\n全部用例通过");
process.exit(failed ? 1 : 0);
