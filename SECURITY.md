# 安全说明

## 信任边界

这个项目**没有服务器端**，所有组件都在你自己电脑上：

| 组件 | 监听 / 权限 | 说明 |
| --- | --- | --- |
| 本地后端 | `127.0.0.1:8787` | 无鉴权。**不要改成 `0.0.0.0`，不要把端口转发到公网**，否则同一网络内任何人都能让它替你花钱调模型 |
| Chrome 扩展 | `host_permissions: <all_urls>` | 需要在任意课程页注入面板；脚本只读取页面 DOM，不读取其它标签页内容 |
| 模型服务 | 由 `OPENAI_BASE_URL` 决定 | 题目文字会发往你配置的这一家，请自行确认其隐私政策 |

数据流：页面 DOM → 本机 `127.0.0.1:8787` → 你配置的模型服务商。没有中间服务器，没有账号体系，没有遥测。

## 密钥

- 仓库里**只有** `server/.env.example`（占位符），`.env` 与 `.env.bak*` 均被 `.gitignore` 忽略；
- CI 会扫描提交内容，一旦发现 `server/.env` 或形如 `sk-xxxx` 的字符串会直接失败；
- 面板、日志、错误信息都不会打印完整 key（`check-config.bat` 只显示前 6 位与后 4 位）。

### 如果你不小心把 key 提交了

1. **先去服务商后台吊销这个 key 并重新签发**——这一步最重要，历史提交是删不干净的，别人可能已经抓取；
2. 再从历史里清除（需要 [`git-filter-repo`](https://github.com/newren/git-filter-repo)）：

   ```bash
   git filter-repo --path server/.env --invert-paths
   git push --force
   ```

3. 如果是公开仓库，检查 GitHub 的 Secret Scanning 告警是否已消除。

## 报告问题

- **安全漏洞**（例如能通过构造页面让扩展执行任意代码、后端路径穿越）：请用 GitHub 的 **Private vulnerability reporting**（仓库 Security 标签页）提交，不要直接开公开 issue。
- **普通 bug**：走 [issue 模板](.github/ISSUE_TEMPLATE/bug_report.md)。
- 贴日志前请自行检查是否含 API Key、学号、姓名、课程名。

## 不接受的用法

本项目不提供、也不接受以下方向的改动（见 [CONTRIBUTING](CONTRIBUTING.md)）：

- 代替用户选择答案或提交试卷；
- 伪造学习时长、伪造心跳、直接调用平台接口刷进度；
- 把题目转发到除使用者自己配置的模型服务以外的任何地方；
- 引入需要账号体系的中间服务器来收集用户数据。
