# 第三方组件声明

本项目自身的代码采用 **MIT** 许可，全文见 [LICENSE](LICENSE)。
下面列出的第三方组件按各自的许可分发，与 MIT 部分相互独立。

---

## Noto Sans SC (Variable)

| 项 | 内容 |
| --- | --- |
| 文件 | `server/fonts/NotoSansSC-VF.ttf` |
| 来源 | Google Noto Sans SC（与 Adobe Source Han Sans SC 同源） |
| 版权 | Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source' |
| 许可 | SIL Open Font License, Version 1.1 |
| 许可全文 | [`server/fonts/OFL.txt`](server/fonts/OFL.txt) |

使用方式：项目只把该字体作为**字形比对参考**，用于还原课程平台用自定义字体加密的题面文字，
未对字体文件本身做任何修改，也未将其嵌入任何对外产物。按 OFL 1.1 的要求，再分发时随附许可全文。

---

## 依赖库

Python 与前端依赖均为常规开源库，未修改、未内联，也不随本仓库分发，由各自包管理器按原许可安装：

- Flask（BSD-3-Clause）
- fontTools（MIT）
- Pillow（HPND）
- numpy（BSD-3-Clause）

完整依赖清单见 [`server/requirements.txt`](server/requirements.txt)。
