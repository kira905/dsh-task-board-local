# 变更记录

本仓是上游 `@linxin666/dsh-client-ui-task-board` 0.3.4 的 **detached fork**（归属与改动声明见 [`NOTICE`](./NOTICE)）。
本文件只记**使用者能观察到**的变化（新增 / 修复 / 破坏性变更 / 许可），倒序（最新在最上）。

## [1.1.2] - 2026-10-16

### Changed

- **许可：维持上游原许可 `Apache-2.0` 不动**。本仓是**他人仓的 fork**，按开源支线的许可口径「**fork 自他人的仓维持上游原许可**」，本版**不做任何再授权**：`LICENSE` 仍与上游包内许可文件逐字节相同，`package.json#license` 仍为 `Apache-2.0`，上游署名与改动声明仍由 `NOTICE` 承担。**历史版本的许可状态同样维持不变。**
- 🔴 **宿主兼容性实测结论（如实登记 · 本版未修复）**：在**隔离实例（端口 3090，主包 `0.2.0-rc.2`）**上真装真跑，本版 **加载失败** —— 实例启动日志报
  `ui-task-board-local (dsh-task-board-local): failed to import`。
  根因 = **构建产物缺运行时依赖件**：`lib/index.js` 顶层 `import { SVC, isTurnEnd } from "../lib/host-adapter.js"`，而本仓**没有** `lib/host-adapter.js` 的源文件，也没有生成它的脚本（`lib/` 被 `.gitignore` 排除，`npm run build` 只产出 `index.js` / `invariant.js` / `client.js`）。⇒ **本版在 `0.2.0-rc.2` 下不可用**。
  README 已同步写明「**实测不兼容 + 卡在哪**」；**不以放宽 peer 区间的方式掩盖**（本版也没有新增 `@deepseek-ai/dsh` 的 peer 声明 —— 写一个"通得过"的区间只会掩盖这一点）。
- **脱敏扫描器放行规则扩充（A5 / A6）**：`scan-oss-sanitize.mjs` 的 `ALLOW` 表补两处 —— **A5** 白名单补入已公开仓名（`dsh-session-toolkit` / `dsh-session-title-live` / `dsh-ecosystem-panel` / `dsh-firstaid` / `dsh-diagnostic-tools` / `dsh-task-board-local`）；**A6** 新增「跨平台环境变量**名**」放行（`%VAR%` / `$env:VAR` —— 变量名本身不含本机信息）。
  依据 = 2026-10-16 用**本扫描器本体**扫已发 6 仓时的实测误报：`dsh-session-title-live` 仓自扫 **122 项待复核**、`dsh-firstaid` 仓自扫 **134 项**，逐条看全部是「**本仓自己的公开包名命中旧词表**」+「组件索引表里的公开仓 URL 未被旧 A5 白名单覆盖」。
  **规则只加放行、未关任何模式**（原 5 条模式 P1–P5 与 A1–A4 一字未改）。
- **本轮无插件代码改动**（推送内容为 `package.json` + `README.md` / `README.en.md` + 新增 `CHANGELOG.md` + `.gitignore` + `scan-oss-sanitize.mjs`）。
