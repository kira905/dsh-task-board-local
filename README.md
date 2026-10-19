# dsh-task-board-local

> **状态**：已开源 · 最新发布 `v1.1.1`（Gitee + GitHub 双端）
> **仓库**：<https://github.com/kira905/dsh-task-board-local> ｜ <https://gitee.com/kira905/dsh-task-board-local>
> **上游**：`@linxin666/dsh-client-ui-task-board` 0.3.4（Apache-2.0）—— 本仓是**已脱离上游版本线**的 fork，版本号自 1.0.0 起独立
> **许可**：Apache-2.0（见 [`LICENSE`](./LICENSE) 与 [`NOTICE`](./NOTICE)，NOTICE 内含上游署名与改动声明）
> **English**: [README.en.md](./README.en.md)

给 DSH Web GUI 加一块任务看板：**一张卡片 = 一次真实的 DSH 会话**，而且**跑完不由执行方自己宣布完成——要人点一下**。

## 设计依据

本组件是「[ops-handoff-design](https://github.com/kira905/ops-handoff-design)」所述体系的一个实现，设计依据：

- **它为什么存在、边界在哪** → 见《自治式运维管家》§4（对象三型 + 自治光谱）：哪些事可以交给 agent 自己跑、哪些必须留一个人类闸门
- **它与宿主版本的兼容区间** → 见《多机交接与云中继》§4.5「兼容性要求」（四条）：插件声明宿主版本区间、运行时探测而不是静态绑定
- **本组件特有的坑与实测** → 本仓 README「已知限制」一节；上游项目的 issue 区
- **它的判定规则与已知失效形态** → 见《任务卡「假完成」与「被打断会话」的识别》：一张卡「执行记录为空」意味着什么（**三类合法成因**）、判定"卡到底干没干完"的**三条横切证据法**，以及"被打断"该按**尾部事件链**判而不是看最后一条事件

## 这是什么 / 给谁看 / 怎么读

- **给谁看**：想让长跑型 agent 真的"接活—干完—被人验收"的人；尤其是已经被"agent 说它干完了，其实没干"坑过的人。
- **怎么读**：先看「与上游的差异清单」（本仓的增量都在那里），再看「已知限制」（这插件不承诺什么），最后看「安装」。
- **三条最反直觉的点**：
  1. **卡片会花钱**：每张卡执行 = 开一个独立的 DSH 会话，消耗与普通会话相同的 API 额度。看板不是待办清单，是**预算**。
  2. **执行方不能自己结账**：runner 结算成功只把卡送进「待验收」，必须由人 `confirm`（或 `reject` 打回并附原因）。
  3. **浏览器只是视图**：关掉页面不影响 Host 的 cron 触发、会话创建与结算；重开页面会重新拉一份全量快照。

## 与上游的差异清单

本仓 fork 自上游 **0.3.4**，之后**不再跟随上游发布**。差异用脚本比对得出：把本仓 `src/` 与上游 npm 包里随附的 `src/` 逐文件比较（上游把源码一起发布，因此可比对，无需 git 历史）。

**总览**：上游 43 个文件 / 本仓 45 个；完全相同的 **21** 个；改动 **22** 个；本仓新增 **2** 个；删除 **0** 个。

### 新增文件（上游没有）

| 文件 | 加来干什么 |
| --- | --- |
| `src/settings-compat.ts` | 跨宿主版本的设置服务兼容层：新老签名运行时探测，避免宿主升级后插件启动即崩 |
| `src/client/client-faces.ts` | 浏览器半边自持的运行时 face 声明，让客户端 bundle 不再依赖 dsh-* 客户端包 |

### 改动的文件（逐条：加了什么）

| 文件 | 上游 → 本仓（行） | 加了什么 |
| --- | --- | --- |
| `core/tasks.ts` | 290 → 428（+103 −14） | **人工验收闸** `review` 状态；**卡类型** `once`/`recurring`/`interactive`（含对 fork 前旧卡按 schedule 反推）；**主线** `line`/`seq` 字段与排序 |
| `host-runner.ts` | 167 → 459（+274 −50） | 结算加固：新增 `interrupted` 结果；`inspect` 直读会话历史（不再只看 tail）；**假 running 兜底**；大分页不展开实参 |
| `host-service.ts` | 236 → 284（+57 −11） | 结算入口按上述结果重排：成功停「待验收」，被打断/挂死可兜底收敛，不再永久卡 running |
| `host-ledger.ts` | 776 → 852（+64 −10） | 验收动作（confirm/reject）落账；打回原因追加进 description；已执行卡备注可改 |
| `protocol.ts` | 221 → 239（+22 −6） | 验收闸与卡类型相关的协议字段与动作 |
| `index.ts` | 151 → 207（+53 −10） | 宿主侧提示词（插件能力自述）；宿主适配层改为外部运行时依赖 |
| `core/controller.ts` | 566 → 649（+57 −4） | 验收动作、母线视图的状态编排；**事件流改为按需订阅**（看板不可见时不占连接） |
| `core/store.ts` | 230 → 251（+19 −2） | 新字段的本地视图存取 |
| `core/use-cases/task-update.ts` | 81 → 105（+27 −9） | 「已执行卡只允许改备注」的用例规则（标题/Prompt 执行后只读） |
| `client/board/TaskBoard.tsx` | 158 → 296（+120 −8） | **主线视图**（按 `line` 分列，列头显示完成度）与状态视图切换 |
| `client/board/TaskDetail.tsx` | 420 → 551（+90 −4） | 验收按钮组、打回备注、卡类型编辑器、执行历史 |
| `client/board/NewTaskModal.tsx` | 219 → 274（+83 −47） | 建卡表单的卡类型与主线/序号字段 |
| `client/board/EditTaskModal.tsx` | 95 → 103（+14 −8） | 执行后只读标题/Prompt，只放开备注 |
| `client/board/TaskCard.tsx` | 89 → 121（+29 −4） | 卡面显示主线标签、卡类型、验收态 |
| `client/board/status-key.ts` | 12 → 13（+1） | 新增 `review` 列的标题映射 |
| `client/board.module.css` | 1130 → 1292（+57） | 验收闸与主线标签样式 |
| `client/locales.ts` | 282 → 341（+59） | 新增文案（验收/卡类型/主线），中英双份 |
| `client/index.ts` | 213 → 225（+14 −4） | 门控订阅接入 + 本地 face 声明 |
| `client/host-api.ts` | 105 → 111（+12 −5） | `subscribe()` 退化为纯开/关事件流（可见性策略上移） |
| `client/sidebar-entry-core.ts` | 209 → 236（+29 −4） | 侧边栏入口行的渲染对齐宿主「新建会话」按钮（展开态药丸 / 折叠态图标） |
| `client/settings-form.ts` | 454 → 459（+7 −2） | 与上游同步切片的本地差异说明 |
| `client/TaskBoardSettingsCard.tsx` | 180 → 217（+37 −6） | 电源状态行改由可见性门控；使用本地 face 声明 |

> 复跑方法（只读）：拿任意一份上游 `@linxin666/dsh-client-ui-task-board@0.3.4` 的 `src/`，与本仓 `src/` 逐文件比对；总览与逐文件行数即上表口径。上游后续版本**未**并入本仓（2026-09-21 查阅 npm registry，上游 `latest` 为 0.3.24，仍在活跃迭代）。

### 不变的边界

- **不向上游回灌**：本仓是 fork，上游是独立项目；本仓的改动不回推，也不跟随上游版本号。
- **不引入本机耦合**：本仓代码里没有本机路径、主机名、账号、私有组件名（见「开发与自检」的脱敏扫描）。

## 安装

包已发布到 npm（`@kira905/dsh-task-board-local`），两种方式：

**A. 从 npm 装**（推荐）

```bash
dsh plugin --profile web add @kira905/dsh-task-board-local@<version>
```

**B. 从源码构建后本地挂载**（要改源码时）

```bash
git clone https://github.com/kira905/dsh-task-board-local dsh-task-board-local
# 国内网络可改用 Gitee 镜像：
# git clone https://gitee.com/kira905/dsh-task-board-local dsh-task-board-local
cd dsh-task-board-local
npm install
npm run build          # 产出 lib/index.js 与 lib/client.js
```

然后把这个目录放进目标 profile 的 `node_modules`（`$DSH_HOME/profiles/web/node_modules/@kira905/dsh-task-board-local`），并按本仓 `cordis.patch.yml` 的写法在 profile 的 bundle 层里 insert 该插件；重启 `dsh web`（或只重载页面，浏览器半边是每请求读盘的）。

**宿主版本兼容区间**：`dsh >= 0.1.1-rc.1`（与上游声明一致）。本仓的日常运行线是 **0.1.1-rc.2**；对更高版本线（服务拆包、设置服务新签名）代码里做了**运行时探测**，但**未在新线上实测** —— 换线前请先在自己的环境里跑一遍建卡/执行/验收。

## 配置

- 账本落在 `$DSH_HOME/task-board/ledger-v2.json`（Host 权威，浏览器只提交动作）。
- 每条卡可钉住**工作区 / agent 预设 / 权限**；任一钉不住（工作区缺失、预设坏了、权限被拒）→ **在发提示词之前失败**，不会"半跑"。
- cron 是 5 段式，按 **Host 本地时区**；错过的触发点**不补跑**，`nextRunAt` 直接向前滚动。
- 可选且**默认关闭**的空闲系统睡眠保护（`preventIdleSleep`）：只拦空闲系统睡眠，允许屏幕熄灭与锁屏，不承诺拦合盖/手动睡眠/休眠/关机。

## 已知限制

- 卡片执行消耗 API 额度，与普通 agent 会话相同。
- 同一张卡不会并发：上一次还在跑时，到点的触发被跳过并滚到下一个 cron 点。
- Host 停机、系统睡眠期间错过的触发点不补跑。
- DST 按 Host 本地挂钟：春季跳过的分钟不补，秋季重复的分钟不重放。
- 电源保护只保证"不进空闲系统睡眠"，其余电源行为由系统策略决定。
- 结算依赖会话历史可读：历史读不出来时卡片会保持 running 而不猜（宁可卡着，不误判完成）；过长时间的 stale 状态有兜底收敛。

## 隐私与遥测

浏览器半边**继承了上游的匿名安装心跳**：每个 UTC 日最多一次，把**包名**（和已知时的版本）POST 到上游项目自建的服务端点；载荷只带一个 localStorage 里随机生成的 visitor id（服务端加盐哈希后存储，不保存 IP，只对外提供聚合计数）。它**不含会话内容、不含文件路径、不含账号**。

如实说明两点，请自行判断：

1. 本仓是从上游继承该逻辑的，**没有开关**；要完全关闭需要自行去掉 `src/client/index.ts` 里的调用（或以构建期替换掉该模块）。
2. 本仓 fork 后仍未改上报的包名，因此这些心跳在上游的统计里会算作上游包。是否改为本仓自己的标识，属发布前待定项。

## 相关组件

同属 DSH 生态的伴生组件，各自独立仓、独立版本、许可各自独立；它们都回链到同一份文档仓
[`ops-handoff-design`](https://github.com/kira905/ops-handoff-design)
（Gitee 镜像 <https://gitee.com/kira905/ops-handoff-design>）：

| 组件仓 | 做什么 | 与本组件的关系 |
|---|---|---|
| `dsh-task-board-local` | 自维护任务看板（卡片 = 一次真实会话 + 人工验收闸） | **本仓** |
| [`dsh-session-title-live`](https://github.com/kira905/dsh-session-title-live) | 会话标题随对话实时刷新 + 回合边界状态前缀 | **本仓的可读性依赖它**：一张卡跑到哪、有没有收尾，看的是执行会话的标题轴；标题不可信，看板上的进度就只是一句话 |
| [`dsh-ecosystem-panel`](https://github.com/kira905/dsh-ecosystem-panel) | 只读生态健康面板（六类体检一屏看完） | **本仓是它的典型体检对象**（自研 + `cordis.patch.yml` insert 注册）：「插件到底加载上了没有」这类静默故障由它回答 |
| [`dsh-diagnostic-tools`](https://github.com/kira905/dsh-diagnostic-tools) | 依赖闭包 / 解耦体检 + 会话图片附件对账 | 升级宿主前后先跑它；本仓的兼容层（`src/settings-compat.ts`）是同一类风险的运行时防线 |
| [`dsh-butler-archive`](https://github.com/kira905/dsh-butler-archive) | 会话归档管理（列表 / 预览 / 恢复 / 删除 + 可选自动归档） | 本仓派的活会**大量产生会话**；它负责把闲置的搬出 `sessions`，让启动与加载开销不随卡数线性增长 |
| [`dsh-firstaid`](https://github.com/kira905/dsh-firstaid) | 零依赖急救台：起不来 / 假死 / 要撤销改动 / 数据被删四类现场压成一个入口 | 兜底：看板依赖 Host 常驻，**Host 一卡住，看板就只剩一个转圈的页面**——那时先跑它，再决定动不动手 |

> 组件之间**没有代码依赖**，也不共享运行时 —— 之所以互指，是因为它们回答的是同一类人的同一批问题
> （长期在自有机器上跑 agent：装得下、找得到、看得见、查得清）。谁装谁不装，互不影响。

## 宿主兼容性（实测）

| 宿主主包 `0.2.0-rc.2` | 面向 | 状态（2026-10-16 实测） |
|---|---|---|
|  | **宿主侧插件** | 🟢 **可加载** —— 启动日志无 `failed to import`；看板 API `GET /api/task-board/state` 回 `HTTP 200` |
|  | **浏览器侧 UI** | 🟢 **可用** —— entry 正常激活（不再 pending），看板六列全部挂载（待规划 / 待办 / 进行中 / 待验收 / 已完成 / 已失败） |
|  | **设置页** | 🟢 **可用** —— 「设置 → 内置插件」出现「任务看板」页签，卡片正常渲染（文案跟随界面语言） |
|  | **新建任务的「模式（Agent 预设）」下拉** | 🟢 **可用** —— 列出宿主预设（`standard` / `ptc` / `minimal` / `cordis`）；**`1.1.3` 及更早该处为空**（对照见下） |

实测方式：在**隔离实例**（独立数据根 + 端口 3090，宿主主包 `0.2.0-rc.2`）上**真装真跑** ——
`npm run build` 后把产物装进该实例的 profile 并重启实例，再用真实浏览器打开该实例并逐项点开。各版本的现象分别是：

```
# 1.1.2（宿主侧启动日志）
ui-task-board-local (dsh-task-board-local): failed to import

# 1.1.3 之前的候选中间态（浏览器侧 boot 提示条）
web boot: 1 entry did not activate dsh-task-board-local: pending (waiting for service: settingsScope)

# 1.1.3（浏览器侧）：无 boot 警告条；看板六列挂载；设置页出现本插件的页签
# 但「模式」下拉只有占位：<select><option value="">部署默认</option></select>
#   控制台：[dsh-task-board] agent preset roster read failed TypeError: Cannot read properties of
#   undefined (reading 'agentPresets')

# 1.1.4（浏览器侧）：同一动作下「模式」下拉 = 占位 + standard / ptc / minimal / cordis
#   <select><option value="">部署默认</option><option value="standard">standard（默认）</option>…
```

三处断点（**都已修好**）：

1. **宿主侧缺运行时依赖件 —— 已修**。`lib/index.js` 顶层有一行
   `import { SVC, isTurnEnd } from "../lib/host-adapter.js";`，而早先的版本里没有这个文件，
   也没有生成它的步骤（`lib/` 被 `.gitignore` 排除，`npm run build` 只产出 `index.js` / `invariant.js` / `client.js`）。
   本版补上该件与它的类型声明：由宿主侧共享适配层的生成器按 target 生成，**文件头带 `sourceSha256`**，
   可与该层唯一源逐字节核对来源。
2. **浏览器侧按旧线（0.1.x）的设置服务声明加载 —— 已修**。`src/client/index.ts` 的 `inject` 里原先写着
   `settingsScope`，而 `0.2.0-rc.2` 的浏览器侧设置面是 `ctx.configForms`（该主包内 `settingsScope` 字符串零命中）；
   **静态 inject 一个不存在的服务会把 entry 永久挂在 `pending`**，看板界面因此起不来。
   本版把设置面改成**动态注入**：`ctx.inject(['configForms'], …)` 只在服务存在时执行，旧线仍走 `settingsScope`
   ⇒ 条目不再依赖任何设置服务即可激活，宿主不提供设置面时降级为「没有设置卡」而不是「整个界面起不来」。
   设置卡的落点也随代迁移：0.2.0 用 `settings.plugins.tab`，旧线仍注册 `web-ui.plugin.item`（两个席位各注册一次，
   `slots.inject` 只在宿主真的声明了该插槽时生效）。
3. **「模式（Agent 预设）」下拉在 `0.2.0` 下为空 —— 已修**。该处原先只读旧线的
   `connection.api.agentPresets`：`0.2.0` 的连接柄不再带 `api`，读取抛
   `TypeError: Cannot read properties of undefined (reading 'agentPresets')`，被 `catch` 吞成一行日志
   ⇒ **下拉静默留空**（建卡 / 看板 / 结算都正常，所以这处断点特别容易被漏掉）。
   本版改为**动态注入** `ctx.inject(['remote.agentPresets'], …)`（`0.2.0` 现行面，
   官方 agent-preset 界面读的就是 `ctx.remote.agentPresets.list()`），旧线 `connection.api.agentPresets`
   作兜底；两种结果信封与两种服务拼写都在同一个读取器里归一化。**读不到时不再沉默** ——
   失败按 `(transport, reason)` 去重后报出"哪条传输、为什么"。

   **实测对照（同一隔离实例、同一动作）**：`1.1.3` 的「模式」下拉 DOM
   `<select><option value="">部署默认</option></select>`（**仅占位**）；`1.1.4` 为
   `<select>…<option value="standard">…` 等 **4 个真实预设**（与宿主 shipped preset 逐名一致）。

   **一处残留噪声（如实登记、不影响功能）**：看板挂载时的**首帧**读取早于 `remote.agentPresets`
   命名空间注入落地，因此控制台**仍会**留下一条 `agent preset roster unavailable … no-transport`
   （同一原因只报一次）；注入回调随后重读并**成功填充下拉**。保留它是有意的：把 `no-transport`
   静默掉，就等于回到"读不到 = 看起来正常"的老毛病。

⚠️ **本仓不因这个结论放宽 `peerDependencies`** —— 写一个"通得过"的区间只会掩盖上述事实。
本仓当前只声明 `react`，**不新增 `@deepseek-ai/dsh` 的 peer 声明**。

## 发布副本 vs 生产树

本仓是**对外的通用化发布版**：它与作者本机维护的内部版本**存在差异**（已剥离内部依赖与内部命名）。
具体地，`lib/host-adapter.js`（宿主侧共享适配层的补件）由该层的生成器按本包 target 产出，**文件头保留来源指纹**
（`sourceSha256`，指向生成它的唯一源，可与唯一源现跑值逐字节核对），但**正文里的内部称呼与内部件名已被中性化**
（内部对"用户 / 助手 / 维护组件"的叫法换成通用词，内部方案档路径与开发机代号已删除）。
⇒ **这一份副本与内部唯一源不再逐字节一致 —— 这是有意为之，不是缺陷**；来源仍可用头部指纹核对。
生成器产出的其它副本不受影响。

## 许可

**Apache-2.0** —— 见 [`LICENSE`](./LICENSE)（与上游包内许可文件**逐字节相同**）。

本仓是上游 `@linxin666/dsh-client-ui-task-board` 0.3.4 的衍生作品，按 Apache-2.0 §4 保留上游署名与许可副本，并在 [`NOTICE`](./NOTICE) 里给出**改动声明**。上游包内没有 NOTICE 文件、源码文件也没有版权头，因此本仓的 NOTICE 同时承担署名与改动声明两件事。未被重新授权的上游文件继续按 Apache-2.0 分发。

## 开发与自检

```bash
npm run build       # tsdown：lib/index.js（宿主半边）+ lib/client.js（浏览器半边）
npm run typecheck   # tsc --noEmit
```

单测在 `_test/`（Node 原生 test 风格脚本，无需额外框架；`--experimental-transform-types` 读取 TS 源码）：

```bash
node --experimental-strip-types --experimental-transform-types _test/<name>.test.mjs
```

**发布前脱敏扫描**（只读、可复跑；本仓自带）：

```bash
node scan-oss-sanitize.mjs --dir <要发布的目录> --deny-file <本机词表>
```

- 规则表里**不含任何本机路径、主机名、账号或私有组件名**；这类词由外部注入（`--deny-words` / `--deny-file` / `$OSS_DENY_WORDS`）。因为规则表本身可以公开，所以扫描器**可以扫自己**（它会跳过自身文件，理由见脚本头部注释）。
- 判定模型：命中 → 逐条判定 → 「放行（带理由）」或「待复核」。**待复核必须为 0 才可发布**；词表为空时脚本会拒绝给出"通过"结论（退出码 3）。
- 报告默认对命中文本做掩码，可以直接入仓。
