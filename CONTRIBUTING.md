# 参与开发

欢迎 issue 和 PR。这个项目的特点是**所有结论都要能被本地 mock 页面复现**——平台结构改版是常态，没有测试兜底的改动很容易按下葫芦浮起瓢。

## 开发环境

```bash
git clone https://github.com/<your-name>/quiz-assistant.git
cd quiz-assistant

# 后端
cd server
python -m pip install -r requirements.txt
cp .env.example .env        # 填一个 key；只跑测试可以不填
python app.py               # http://127.0.0.1:8787

# 扩展：chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 extension/
```

改完扩展代码：点 `chrome://extensions` 卡片上的 ↻，再刷新页面。改后端：重启 `python app.py`（`app.py` 没有热重载）。

## 代码地图

| 要改什么 | 去哪 |
| --- | --- |
| 抓题干 / 选项 / 题型 | `extension/inject.js` → `pickQuestionRoots` `stemFromContainers` `looksJudge` |
| 翻页逻辑 | `extension/inject.js` → `autoStep` `advance` `waitNext` `isCurrentValid` |
| 加密字体解码 | `extension/inject.js` → `decodeCurrent` `isEncElement`；`server/fontdec.py` |
| 采样 / 裁决 / 缓存 | `server/app.py` → `solve()` `detect_qtype()` |
| 刷视频目录定位 | `extension/video-brush.js` → `findCurrentKey` `classIsActive` `markSeen` |
| 播放控制 | `extension/video-brush.js` → `ensurePlaying` `guardRate` `waitFinish` |

## 测试

```bash
# Python 侧（需要 Windows 系统字体 simsun.ttc 来造「假加密字体」）
py -3 tests/decode.test.py
py -3 tests/backend_decode.test.py

# 浏览器侧（headless Chrome + CDP，需要本机装了 Chrome）
node tests/autorun.e2e.mjs
node tests/videobrush.e2e.mjs
node tests/iframeroot.e2e.mjs
node tests/decode.e2e.mjs
```

> 仓库的 GitHub Actions 只跑语法检查、版本一致性与密钥扫描——端到端测试依赖真实 Chrome 与 Windows 字体，必须在本地跑。合并前请自己跑绿。

## 提 PR 的要求

1. **先在 mock 页面复现问题**。`tests/mock-exam*.html`、`tests/mock-course.html` 支持用 query string 造故障场景（`?stuck=1` 播放器卡进度、`?decoyVideo=1` 干扰 video、`?speedTrap=1` 一点就暂停的假倍速按钮、`?ulActive=1&activeAt=2` 容器带 active 等）。修 bug 的 PR 请附一个能跑出来的场景。
2. **补一条断言**。测试不是「跑通就行」，要断言具体行为，例如「点了哪几个条目」`abClicked.join(",") === "v2,v3,v4,v5"`，而不是「最后状态是完成」。
3. **别把密钥带进来**。`.env` 已被 `.gitignore` 忽略；提 PR 前跑一次 `git diff --cached | grep -i "sk-"` 自查。真泄露了请在 PR 里说明，并去服务商后台吊销重签。
4. **提交信息**用 `<type>: <一句话>`，type 取 `fix` / `feat` / `perf` / `docs` / `test` / `chore`，例如：
   - `fix: 章节容器带 active 时不再误判为当前视频`
   - `perf: 翻页轮询 12 轮缩短到 7 轮`
5. **不要动无关文件**。只修刷视频的 PR 不应该改 `inject.js`，反之亦然——这是维护者判断改动范围的重要依据。

## 适配新平台

平台结构差异主要集中在三处选择器：

1. 题根：`pickQuestionRoots` 里的加分特征（`.problem-body` 等）；
2. 选项：`collectOptions` 的容器与控件选择器；
3. 下一题：`findNextButton` 的文本与类名规则。

适配时优先用「特征打分」而不是写死路径——平台改版时路径全变，特征通常还在。抓不到结构时点面板「诊断结构」，会导出 `server/debug/debug-*.json`，里面是页面 DOM 快照，脱敏后再贴进 issue。

## 行为边界（不接受违反这些的 PR）

- 不代替用户选择选项、不提交试卷；
- 不伪造学习时长、不伪造心跳、不直接调用平台接口；
- 不把题目发往除「使用者自己配置的模型服务」以外的任何地方；
- 不引入需要账号体系的中间服务器。

---

## 提交前自查清单

- [ ] `node --check extension/*.js` 通过
- [ ] 相关测试全绿，且新增了针对本次改动的断言
- [ ] 没有提交 `.env`、`server/cache/`、`server/debug/`、`server/reports/`、`*.zip`
- [ ] 改动范围只覆盖本次要解决的问题
- [ ] 如果改了默认值，同步更新 `README.md` / `docs/使用说明.md` / `.env.example`
