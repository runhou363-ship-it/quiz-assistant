# 架构与实现细节

> 面向想改代码或理解「为什么这么设计」的读者。操作步骤见 [使用说明](使用说明.md)，逐版本踩坑记录见 [DEVLOG](DEVLOG.md)。

## 1. 组件与职责

| 组件 | 文件 | 职责 |
| --- | --- | --- |
| 扩展外壳 | `extension/manifest.json` | MV3 声明；`permissions: activeTab / scripting / storage / tabs` |
| 答题面板 | `extension/inject.js` | 注入页面，抓题、解码触发、调后端、翻页、汇总。**不勾选、不提交** |
| 刷视频 | `extension/video-brush.js` | 目录定位、点开任务点、播放控制、完成确认、去重 |
| 设置弹窗 | `extension/popup.html` / `popup.js` | 后端地址、自动模式开关、刷视频启停与倍速、诊断 |
| 后台 | `extension/background.js` | 转发请求、跨标签页打开链接、章节扫描、注入脚本 |
| 后端 | `server/app.py` | HTTP 接口、采样与裁决、缓存、报告落盘 |
| 字体解码 | `server/fontdec.py` | 字形轮廓渲染 + 位图比对，产出 `密文 → 真字` 映射 |

浏览器侧无构建步骤：原生 ES + DOM，`chrome.storage.local` 存配置，`chrome.runtime.sendMessage` 通信。这样改一行代码刷新扩展就生效，适合长期对抗平台改版。

## 2. 数据流

### 答题

```
页面 DOM
  └─ inject.js  选取题根 → 抽题干/选项 → 判断是否加密字体
        │
        ├─(有加密字体)─→ POST /decode  {font_b64, texts[]}
        │                    └─ fontdec 建模 → {mapping, avg_score, missRatio}
        │                 ←─ 按文本节点套映射，还原真字（失败则拒答）
        │
        └─→ POST /solve {question, options, qtype, encrypted, decoded}
                 ├─ 同题缓存命中 → 直接返回（0 元）
                 ├─ 并行 N 次采样（默认 2）
                 ├─ 一致？ → 收敛，跳过第 3 次
                 ├─ 分歧？ → 追加裁决采样（QA_VERIFY）
                 └─ 返回 {answer_index, explanation, confidence, cost, timing}
        ←─ 面板展示推荐 / 置信度 / 花费 → 记录到轮次汇总
        └─ advance()：只点「下一题」，等新题签名变化后交给下一轮
```

### 刷视频

```
目录页 DOM
  └─ video-brush.js  收集任务点（只认「视频」标记）
        ├─ findCurrentKey()：选中态 → URL node_id → 页面标题
        ├─ 前面的一律 markSeen（不回头），已标 ✓ 的也跳过
        ├─ 点开下一个 → 等 <video> 出现 → ensurePlaying()
        │     ├─ 1x：不写 playbackRate、不挂监听、不点倍速菜单
        │     └─ >1x：节流写值；被平台改回 5 次以上 → 退回 1x
        ├─ waitFinish()：只认 ended / 进度到尾
        │     └─ 无暂停但 currentTime 不走 → play() → 轻微 seek → 提示
        ├─ 停留等待平台心跳 → 扫目录看 ✓
        └─ 去重后继续下一个
```

## 3. 后端接口

| 方法 | 路径 | 入参要点 | 说明 |
| --- | --- | --- | --- |
| GET | `/health` | — | 存活探测 |
| GET | `/status` | — | `has_key`、模型、采样数、`font_refs`（有 `sourcehan` 表示参考字体已加载） |
| POST | `/solve` | `question` `options[]` `qtype` `font_b64` `encrypted` | 主接口，返回答案、解析、置信度、花费 |
| POST | `/decode` | `font_b64` `texts[]` | 只做字体解码，便于单独验证 |
| POST | `/debug` | 页面结构 + 字体样本 | 落盘 `server/debug/debug-*.json`，供适配选择器 |
| POST | `/report` | 单页汇总 | 存 `server/reports/` |
| POST | `/combine` | — | 合并已存报告 |

所有接口只监听 `127.0.0.1:8787`，没有鉴权，**不要把它暴露到公网**。

## 4. 抓题：三个真实障碍

### 4.1 题目在 iframe 里

雨课堂的练习题在 `/v2/web/iframe-exercise/` 的 iframe 内。早期版本抓的是外层文档，抓到的是课程目录（「视频 ×N、第 N 节 ×N、完成度」），于是把目录当题干送去问模型——这就是「没识别就翻页」的根因。

现在的做法：

- `pickQuestionRoots()` 遍历主文档 + 所有可访问 iframe，按特征打分（有 `.problem-body` +8、有加密字体 +6、有选项控件 +4、标题含「第 N 题」+3）；
- 目录特征（多个「视频」条目、完成度文字）**扣分**；
- 只保留得分最高的那一层，避免把外层容器和 iframe 内容重复计入。

### 4.2 反自动化诱饵

页面里存在 `data-automation-risk-decoys` / `data-risk-target="decoy"` 的节点，用 `position:fixed; left:-10000px` 藏在屏幕外，做成假选项、假「下一题」，专门钓脚本。

- `isVisible()` 改为必须与视口有交集（留 50px 余量）+ display/visibility/opacity 检查；
- `isDecoy()` 直接按标记与负偏移排除；
- 抓选项、找「下一题」、题号导航三处都过滤。

### 4.3 未识别不许翻页

`autoStep()` 在翻页前过一道 `isCurrentValid(q)`：

- 题干为空或太短 → 不翻；
- 题干像课程目录（`looksLikeDirectory`）→ 不翻；
- 选项少于 2 个 → 不翻；
- 重抓最多 5 次，仍失败就暂停自动模式并提示。

翻页后 `waitNext()` 只要**签名变化**就把控制权交回（哪怕新题暂时是空的），不再二次点击，避免连跳两题。

## 5. 加密字体解码

平台把文字塞进 `<span class="xuetangx-com-encrypted-font">`，配一份重映射字体：DOM 里是私用区乱码，屏幕上却是正字。

### 算法

1. `fontTools` 解析加密字体，取每个字形的轮廓点集；
2. 参考字体（思源黑体，同源）在 64 / 96 / 112 px 下渲染成位图；
3. 对每个密文字形做同样的渲染，按位图相似度找最近的候选字，三档尺寸加权；
4. 取平均拟合分最高的映射表（满分约 2.0，同源字体实测 1.93–1.98）。

### 两个必须守住的点

**只对加密节点套映射。** 页面是混排的：加密 span 里是密文，span 外面是正常中文。早期整段替换，把正常字也换成了别的字——「正常题干」直接变乱码。现在按**文本节点**判断（祖先 class 含 encrypted，或 computed `font-family` 含 decrypt/exam-data），加密的才换，正常的原样保留。

**质量闸门 + 拒答。** 解完算两个指标：`missRatio`（没解出的字占比）、`avg_score`（平均拟合分）。任一越界（`>0.2` / `<0.85`）就判定失败：

- 先 `invalidateFont` 强制重取字体再试一次；
- 仍失败 → 置 `decodeFail`，**拒绝调用模型**，面板明确写「解码失败，请手动核对」，自动模式暂停。

宁可不出答案，也不拿乱码去问模型——那是纯粹的浪费和误导。

## 6. 答题推理

| 机制 | 做法 | 目的 |
| --- | --- | --- |
| 多采样 | 默认并行 2 次（`QA_SAMPLES`） | 用一致性换准确率 |
| 自适应 | 2 次一致就停，不一致才补第 3 次（`QA_ADAPTIVE`） | 省 1/3 调用 |
| 裁决 | 分歧 / 多选 / 字体校对矛盾时追加一次「重新审题」（`QA_VERIFY`） | 提升否定题、多选题准确率 |
| 结构化输出 | 只要 `answer_index` + 一句解析，不复述选项 | 输出 token 减半，这是最贵也最慢的部分 |
| 同题缓存 | 题干 + 选项规范化后哈希（`QA_CACHE`） | 重刷同一份作业 0 元 |
| 成本折算 | 按 `QA_PRICE_IN/OUT` 把 token 折算成人民币 | 每题可见花费 |

题型判定在两端都做：前端 `looksJudge()` 先看「恰好 2 个选项且是 正确/错误、对/错、√/×、T/F」判为判断题；后端 `detect_qtype()` 独立再判一次，判断题与单选题走同一条按索引作答的路径。

## 7. 刷视频

### 目录定位（`findCurrentKey`）

依次尝试：选中态 → URL `node_id` → 页面标题 → 放弃。

- 选中态用**精确分词**匹配（`active` / `is-active` / `current` / `selected` / `playing`），排除 `inactive`、`activity` 这类子串误伤；
- 只有**恰好包含 1 个视频条目**的容器才算当前页（章节容器里有多个视频时忽略）；
- 找不到就**从第一个未完成开始**，并把前面已完成的 `markSeen`——绝不靠「视口第一个」猜，那会永远回到开头。

### 去重三层

| 层 | 依据 | 解决什么 |
| --- | --- | --- |
| 节点 ID | `data-node-id` 或规范化文本 | 常规重复点击 |
| 标题签名 | 去掉「视频 / 已完成 / 进度数字」后的字符集签名 | 打勾后文本变了仍算同一条 |
| 完成标记 | 目录里的 ✓ | 旧版本已刷过的 |

### 播完判定

只认 `video.ended` 或 `currentTime` 到尾，且**必须先真的播过**（`everProgressed`）。之后停留 12 秒等平台心跳，期间看到 ✓ 就提前跳到下一个。旧版「距结尾 ≤1.5 秒算播完」在 2x 下极易误判，导致平台最后一段进度和 `ended` 都没收到。

### 卡住自愈

同时满足「未暂停 + `readyState ≥ 2` + 缓冲足够」但 `currentTime` 长时间不动时：

| 时间 | 动作 |
| --- | --- |
| 6 s | `play()` 重试 |
| 12 s | 轻微 seek（+0.4 s）跨过卡点 |
| 24 s | 提示用户手动接管，**不默默跳过整集** |

## 8. 设计取舍

**为什么不做题库 App 接口对接？** 那类服务没有公开 API，要登录态和风控签名，逆向接入违反用户协议且随时失效；题库还只认题干原文，加密字体偶尔还原出形近字就匹配失败。按 token 计费已经便宜到「一份作业几毛钱」。

**为什么默认 1x 刷视频？** 多数平台按真实墙钟时长计完成度，2x 只记一半，越「快」越刷不完。速度让位于正确性。

**为什么宁可拒答？** 乱码题干问出来的答案不仅错，还会污染缓存和汇总，让用户以为工具「变笨了」。明确失败比沉默出错更有用。

**为什么不用框架？** 内容脚本要注入别人的页面，越少依赖越不容易和页面样式/全局变量打架。

## 9. 测试策略

测试全部基于本地 mock 页面，不依赖真实平台账号，走 headless Chrome + CDP：

| 测试 | 覆盖 |
| --- | --- |
| `autorun.e2e.mjs` | 自动模式：逐题抓取、翻页、汇总、断点续跑、一轮跑完或点汇总即关闭、重新抓取清空、手动开启重置汇总 |
| `videobrush.e2e.mjs` | 刷视频：从当前页开始、不回头、真播完才跳、卡住自愈、1x 不碰播放器 |
| `iframeroot.e2e.mjs` | iframe 题根选择、诱饵选项过滤、不点诱饵「下一题」、未识别不翻页 |
| `decode.e2e.mjs` | 加密字体混排、明文题干 + 加密选项、解码失败时拒答且不翻页 |
| `decode.test.py` / `backend_decode.test.py` | 后端解码与拒答逻辑 |

mock 页面支持用 query string 复现特定故障，例如 `?stuck=1`（播放器卡进度）、`?decoyVideo=1`（干扰 video）、`?speedTrap=1`（一点就暂停的假倍速按钮）。新增 bug 时，先在 mock 里复现，再修。
