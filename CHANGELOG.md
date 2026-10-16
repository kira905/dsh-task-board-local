# 变更记录

本仓是上游 `@linxin666/dsh-client-ui-task-board` 0.3.4 的 **detached fork**（归属与改动声明见 [`NOTICE`](./NOTICE)）。
本文件只记**使用者能观察到**的变化（新增 / 修复 / 破坏性变更 / 许可），倒序（最新在最上）。

## [1.1.4] - 2026-10-16

### Fixed

- **新建任务对话框的「模式（Agent 预设）」下拉在 `0.2.0` 下为空 —— 已修**。该处原先只走旧线的
  `connection.api.agentPresets.list({})`：`0.2.0` 的 `ConnectionHandle` 不再带 `api`，读取抛
  `TypeError: Cannot read properties of undefined (reading 'agentPresets')`，被调用方的 `catch`
  吞成一行控制台日志 ⇒ **下拉静默留空**（建卡 / 看板 / 结算都正常，所以这个断点很容易被漏掉）。
  本版新增 `src/client/preset-roster.ts`：**动态注入** `ctx.inject(['remote.agentPresets'], …)`
  （0.2.0 现行面，官方 agent-preset 界面读的就是 `ctx.remote.agentPresets.list()`），旧线
  `connection.api.agentPresets` 作兜底；两种信封（`{ result }` 与裸结果）与两种服务拼写
  （点号键 / 嵌套访问）都在一个读取器里归一化，调用方不再各自分支。
  **读不到时不再沉默**：失败按 `(transport, reason)` 去重后报出「哪条传输、为什么」（`no-transport` /
  `call-threw` / `rpc-failed` / `malformed`），**"读不到"与"确实没有"不再长得一样**。
- **实测对照（隔离实例 · 端口 3090 · 宿主主包 `0.2.0-rc.2`）**：同一实例、同一动作（看板 → 新建任务），
  `1.1.3` 的「模式」下拉 DOM = `<select><option value="">部署默认</option></select>`（**仅占位**，
  控制台报上述 `TypeError`）；`1.1.4` = 占位 + `standard` / `ptc` / `minimal` / `cordis`
  **四个真实预设**（与宿主 shipped preset 逐名一致，控制台无 `read failed`）。

### Changed

- **如实登记一处残留噪声（不影响功能）**：`apply` 挂载看板时的那次**首帧**读取早于
  `remote.agentPresets` 命名空间的注入落地，因此**仍会在控制台留下一条**
  `agent preset roster unavailable: neither connection.api.agentPresets (0.1.1) nor remote.agentPresets
  (0.1.2+) is present`（同一 `(transport, reason)` 只报一次）；注入回调随后触发重读并**成功填充下拉**。
  保留该行为是有意的：把 `no-transport` 静默掉，就等于回到"读不到 = 看起来正常"的老毛病。
- **宿主兼容性（实测）按本次实测改写**：README 中英双份的「宿主兼容性（实测）」节把
  「Agent 预设下拉为空」从"已知未修"移到"已修"，并补上本条对照读数。
- **本版不改许可、不改 peer、不放宽 peer 区间**：仍是上游 `Apache-2.0`（fork 不再授权），
  `peerDependencies` 仍只有 `react`。
- **本版改动文件**：`src/client/preset-roster.ts`（新增）· `src/client/index.ts`（接入 + 旧读法移除）·
  `package.json`（版本号）· `CHANGELOG.md` / `README.md` / `README.en.md`（文档）。

## [1.1.3] - 2026-10-16

### Fixed

- **补上缺失的运行时依赖件 `lib/host-adapter.js`（+ `lib/host-adapter.d.ts`）**。早先版本装入宿主后启动即报
  `ui-task-board-local (dsh-task-board-local): failed to import`，根因是构建产物顶层
  `import { SVC, isTurnEnd } from "../lib/host-adapter.js"` 指向一个仓里不存在的文件
  （`lib/` 被 `.gitignore` 排除，`npm run build` 也不产出它）。
  本版把这两件补进 `lib/`：由宿主侧共享适配层的生成器按 target 生成，**文件头带 `sourceSha256`**，
  可与该层唯一源逐字节核对来源。

- **浏览器侧设置面迁移到 `0.2.0` 的 `ctx.configForms`**（此前 `0.2.0-rc.2` 下界面起不来的那处断点）。
  原先 `src/client/index.ts` 把 `settingsScope` 写在**静态 `inject`** 里，而该宿主不提供这个服务
  ⇒ entry 永久停在 `pending (waiting for service: settingsScope)`，看板界面整个挂不上。
  本版改为**动态注入**：`ctx.inject(['configForms'], …)` 只在服务存在时执行（表单按 profile 条目 id
  `ui-task-board-local` 取），旧线（0.1.x）仍走 `settingsScope`（含 rc.6 兼容绑定）
  ⇒ **条目不再依赖任何设置服务即可激活**；宿主不提供设置面时降级为「没有设置卡」，而不是「整个界面起不来」。
  设置卡的落点同步迁移：0.2.0 注册 `settings.plugins.tab`，旧线仍注册 `web-ui.plugin.item`
  （两个席位各注册一次，`slots.inject` 只在宿主声明了该插槽时生效）。

### Changed

- **宿主兼容性实测结论更新（如实登记）**：在**隔离实例**（独立数据根 + 端口 3090，宿主主包 `0.2.0-rc.2`）
  真装真跑 + 真实浏览器逐项点开 —— **宿主侧可加载**（启动日志无 `failed to import`；看板 API `HTTP 200`）、
  **浏览器侧可用**（entry 正常激活、看板六列全部挂载）、**设置页可用**（「设置 → 内置插件」出现「任务看板」页签，
  卡片正常渲染）。README 中英双份的「宿主兼容性（实测）」节已按本次实测改写；
  **不以放宽 peer 区间的方式掩盖**（仍未新增 `@deepseek-ai/dsh` 的 peer 声明）。
- **如实登记一处已知未修**：新建任务对话框的「Agent 预设」下拉在 `0.2.0-rc.2` 下为空 —— 本仓读的是旧线连接面的
  `connection.api.agentPresets`，而该线把预设花名册挂在自己的 remote 命名空间下。读取失败已被捕获并记入控制台
  （`[dsh-task-board] agent preset roster read failed`），**建卡 / 看板 / 结算不受影响**（预设留空即按宿主默认）。
  修复需要把花名册读取改成命名空间注入式探测，属后续版本的工作。
- **发布副本与内部唯一源的差异（有意为之）**：`lib/host-adapter.js` 的**正文**做过通用化处理 ——
  内部对「用户 / 助手 / 维护组件」的叫法换成通用词、内部方案档路径与开发机代号已删除（共 **14 处**），
  **文件头的 `sourceSha256` 指纹行保留**，来源仍可逐字节核对。
  ⇒ **这一份副本与内部唯一源不再逐字节一致**，且**不会被同步覆盖**（该生成器的写目标只含作者本机内部树，
  不含这个发布仓）。README 中英双份新增「发布副本 vs 生产树」节说明这一点。
- **许可与上游声明未变**：仍维持上游 `Apache-2.0`（fork 不做再授权），`LICENSE` / `NOTICE` 未动。
- **peer 未动、未放宽**：本仓仍只声明 `react`。

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
