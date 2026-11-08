/**
 * 多实例分载（缺口 G28）· 主机侧支撑模块 — 派活（§4.2 A1~A5）+ 回传（§4.3 B1~B4）。
 *
 * 方案：多实例分载（派活 / 回传 / 归档）§4.2 / §4.3 / §4.5。
 * ⚠️ **跨实例 HTTP 调用的口径以订正档为准**（方案 §4.2 的字面写法与 0.1.5 实测有出入）：
 *    跨实例 API 口径实测订正（G28）。
 * 本模块在订正档 6 条之上**再补两条实测**（2026-10-09 · 卡 G28·P1b · 证据
 * `_archive\g28p1b-20261009\evidence\p1b-probe-{page,inspect}.{txt,json}`）：
 *
 *   ⑦ **`session/page` 必须用真 cursor**：`throughSeq: -1` **恒返回空**
 *      （订正档 ④ 说「空壳会话 records:[]」—— 真正的原因是那个 `-1`）。
 *      真 cursor = `thanSeq` 探针（`MAX_SAFE_INTEGER` → `past cursor N`）**或**
 *      `session/list` 的 `projections.asOfSeq`（更优雅，且 list 本来就要调）。
 *      用真 cursor 打 ⇒ **完整拿到含 `turn/end` 的全量事件**（实测 23/23 条）。
 *      ⇒ 结算（B3）与 A5 校验点② 都可以**完全走 HTTP**，不依赖同机文件读。
 *   ⑧ `session/inspect` 跨实例 **404**（0.1.5 上不存在该端点）⇒ 不要用它。
 *
 * 硬约束（方案 §4.2 A5 / §4.3 B4）：
 *   - 权限硬门**只读不写**：`permission` 不是合法入参、被静默忽略 ⇒ 主机只能「读出来 → 比对 → 不符就拒」；
 *     禁止静默降级 / 先把 prompt 派出去再说 / 只 warn。
 *   - 判活 `known` 是**单 index 的全局布尔**：owner 不可读 ⇒ `known:false` 保持 pending；
 *     **禁止**多实例 `known` 做 union / 逻辑或（会把还在跑的卡结算成 interrupted）。
 *   - 配置缺失 / 非法 ⇒ 一律回落「只有本地实例」（fail-safe，零行为变化）。
 */

import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './dsh-home.ts'
// R-065 删除/搬移三件套（锁6 · 批 E4）：唯一口在本插件内自足实现（插件实体不能静态 import tools/lib）。
import { gateDestructive } from './destructive-gate.ts'
// 2026-11-09 卡「账本写重试」：tmp → rename 统一走带退避重试的唯一口（EPERM/EACCES/EBUSY）。
import { isTmpPreserved, renameWithRetry } from './fs-atomic.ts'
// 宿主适配层（唯一源 + 生成副本，补R4 收敛 2026-10-09）：权限种子事件名走它（R4）。
// 与 src/host-runner.ts 同一姿势 —— 副本保持 external 的**运行时** import（见 tsdown.config.ts LIB_EXTERNALS）。
import { EV } from '../lib/host-adapter.js'

// ---------------------------------------------------------------------------
// §4.5 配置与状态文件（均落在主机侧 <DSH_HOME>/multi-instance/）
// ---------------------------------------------------------------------------

/** 一份目标实例登记（方案 §4.5 表第 1 行）。 */
export interface MultiTarget {
  readonly id: string
  readonly name?: string
  /** 该实例的 HTTP base（local 目标**不使用**此值 —— 见 {@link MultiInstanceConfig} 注）。 */
  readonly base: string
  /** 该实例的 DSH_HOME（`http` 目标用它推断启动日志；local 目标恒为运行时 home）。 */
  readonly home?: string
  /** `local` = 本进程内（零行为变化）；`http` = 跨实例 HTTP。 */
  readonly kind: 'local' | 'http'
  readonly maxConcurrent: number
  /** 制备期探针测出的权限档（§4.2 A5 校验点①）；`null` = 未探过 ⇒ 派活硬门拒派。 */
  readonly permissionPreset: string | null
  /** 制备期探针测出的审批策略；`null` = 未探过。 */
  readonly approvalPolicy: string | null
  /**
   * **该实例上**执行卡会话用的工作区 id（可选；缺省 = 不传，用目标实例自己的运行时默认）。
   *
   * ⚠️ **卡内的 `workspaceId` 永不跨实例传**（2026-10-09 · P1b 实测）：工作区 id 是**本机私有**的
   * —— 实测把宿主的工作区 id 传到分身，`session/create` 直接回
   * `workspace/not-found workspace "<宿主 id>" not found`，卡落 `failed`。
   * 而 farm-b 分身**根本没有登记任何工作区**（`<home>\storages\workspace.json` 的
   * `tables.workspaces` 为空）⇒ 该实例唯一能用的路径就是**不传**（宿主运行时默认，
   * 实测会话 `cwd` = `<分身根>\work`）。
   *
   * ⇒ 本字段只在"目标实例确实登记过某个工作区、且希望卡会话落在那里"时才配。
   * 方案 §4.5 的 target 字段表**没有这一项**，属本卡实测新增（已写进交付报告「待拍板」段）。
   */
  readonly workspaceId?: string
  /** 可选：显式指定该实例的启动日志路径（缺省按 {@link inferInstanceLogCandidates} 推断）。 */
  readonly log?: string
}

export interface MultiInstanceConfig {
  version: number
  strategy: 'least-busy' | 'round-robin'
  targets: MultiTarget[]
  /**
   * §4.4.4 confirm → 归档链（**可关回**：`archive.enabled = false` ⇒ 逐字节回到改动前）。
   *
   * 缺省见 {@link DEFAULT_ARCHIVE_CHAIN}；配置缺失 / 非法一律取默认（这条链的方案口径
   * 已定稿，只有**显式** `false` 才算关）。
   */
  archive: ArchiveChainConfig
}

/** 主机侧三个文件的落点。 */
export interface MultiInstancePaths {
  readonly dir: string
  readonly configFile: string
  readonly cardSessionsFile: string
  readonly runsFile: string
}

/** 相对 DSH_HOME 的目录名（写死：方案 §4.5 的唯一权威源）。 */
export const MULTI_INSTANCE_DIR = 'multi-instance'

/**
 * 主机侧多实例目录（**落在本进程的 DSH_HOME 下**）。
 *
 * ⚠️ 这正是测试实例天然隔离的原因：测试 home 里没有 `multi-instance/`
 * ⇒ {@link loadMultiInstanceConfig} 回落 local-only ⇒ 测试实例**一个跨实例请求都不会发**。
 */
export function multiInstancePaths(home: string = dshHome()): MultiInstancePaths {
  const dir = join(home, MULTI_INSTANCE_DIR)
  return {
    dir,
    configFile: join(dir, 'config.json'),
    cardSessionsFile: join(dir, 'card-sessions.json'),
    runsFile: join(dir, 'runs.jsonl'),
  }
}

/**
 * §4.4.4 confirm → 归档链的配置面（**全部可关回**）。
 *
 * 语义（方案 §4.4.4 写死）：
 * - `retryIntervalMs` = 对**同一个 target** 的最小调用间隔（默认 10 分钟）；
 * - `minAgeMs` = `confirm` 之后多久才进"待归档"（默认 1 小时 —— 源码阈值下限是 1h，
 *   刚落 `confirm` 的会话这一轮搬不走，所以正确口径是"验收后进队列、≥1h 后收"）；
 * - `maxAttempts` = 单条目 24h 内最大尝试次数（默认 12；超限 ⇒ 告警 + 停止重试）；
 * - `activeHoldHours` / `hoursCard` = **单轮**覆盖值（一律 `Math.max(1, …)`；
 *   ⚠️ 单轮覆盖**绝不**落持久配置 —— 红线）。
 */
export interface ArchiveChainConfig {
  readonly enabled: boolean
  readonly retryIntervalMs: number
  readonly minAgeMs: number
  readonly maxAttempts: number
  readonly activeHoldHours: number
  readonly hoursCard: number
}

/** 归档链默认值（方案 §4.4.4；`enabled` 默认 **开** —— 本链是方案已定稿的口径）。 */
export const DEFAULT_ARCHIVE_CHAIN: ArchiveChainConfig = {
  enabled: true,
  retryIntervalMs: 10 * 60_000,
  minAgeMs: 60 * 60_000,
  maxAttempts: 12,
  activeHoldHours: 1,
  hoursCard: 1,
}

/**
 * 归一化 `config.json` 的 `archive` 段。
 *
 * fail-safe 方向：**只有显式 `false` 才关**（`enabled !== false` ⇒ 开），数值非法回落默认值、
 * 且各自带下限（防"传 0 变成每轮狂打"）。
 */
export function normalizeArchiveChain(raw: unknown): ArchiveChainConfig {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_ARCHIVE_CHAIN
  const r = raw as Record<string, unknown>
  const num = (value: unknown, fallback: number, min: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback
  return {
    enabled: r.enabled !== false,
    retryIntervalMs: num(r.retryIntervalMs, DEFAULT_ARCHIVE_CHAIN.retryIntervalMs, 60_000),
    minAgeMs: num(r.minAgeMs, DEFAULT_ARCHIVE_CHAIN.minAgeMs, 60_000),
    maxAttempts: num(r.maxAttempts, DEFAULT_ARCHIVE_CHAIN.maxAttempts, 1),
    activeHoldHours: num(r.activeHoldHours, DEFAULT_ARCHIVE_CHAIN.activeHoldHours, 1),
    hoursCard: num(r.hoursCard, DEFAULT_ARCHIVE_CHAIN.hoursCard, 1),
  }
}

/** 兜底配置 = 只有本地实例（方案 §4.5「缺省＝[本地 3080]（零行为变化）」）。 */
export function defaultMultiInstanceConfig(localBase: string, localHome: string): MultiInstanceConfig {
  return {
    version: 1,
    strategy: 'least-busy',
    archive: DEFAULT_ARCHIVE_CHAIN,
    targets: [{
      id: 'local',
      name: '本机',
      base: localBase,
      home: localHome,
      kind: 'local',
      maxConcurrent: 4,
      permissionPreset: null,
      approvalPolicy: null,
    }],
  }
}

/** 读配置的结果：`degraded` 非空 = 用了兜底（调用方**不得**当成"用户配好了"）。 */
export interface MultiInstanceLoad {
  readonly config: MultiInstanceConfig
  readonly degraded: string | null
  readonly path: string
}

/** 归一化一个 target（缺字段走安全缺省；非法 kind 视作 local，宁可少发请求）。 */
function normalizeTarget(raw: unknown, fallbackBase: string, fallbackHome: string): MultiTarget | null {
  if (typeof raw !== 'object' || raw === null) return null
  const t = raw as Record<string, unknown>
  const id = typeof t.id === 'string' && t.id.trim() !== '' ? t.id.trim() : null
  if (id === null) return null
  const kind = t.kind === 'http' ? 'http' : 'local'
  const base = typeof t.base === 'string' && t.base.trim() !== '' ? t.base.trim().replace(/\/+$/u, '') : fallbackBase
  const maxConcurrent = typeof t.maxConcurrent === 'number' && Number.isFinite(t.maxConcurrent) && t.maxConcurrent > 0
    ? Math.floor(t.maxConcurrent)
    : 4
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
  return {
    id,
    ...(str(t.name) === null ? {} : { name: str(t.name) as string }),
    base,
    home: typeof t.home === 'string' && t.home.trim() !== '' ? t.home.trim() : fallbackHome,
    kind,
    maxConcurrent,
    permissionPreset: str(t.permissionPreset),
    approvalPolicy: str(t.approvalPolicy),
    ...(str(t.workspaceId) === null ? {} : { workspaceId: str(t.workspaceId) as string }),
    ...(str(t.log) === null ? {} : { log: str(t.log) as string }),
  }
}

/** 配置解析缓存（按 mtime + size 失效）。 */
let configCache: { file: string; mtimeMs: number; size: number; value: MultiInstanceLoad } | undefined

/**
 * 读 `config.json`（fail-safe：缺失 / 非法 / 无可用 targets ⇒ local-only + `degraded` 说明）。
 *
 * @param localBase - 本地实例的 base（**恒由运行时决定**，绝不取配置文件里的值）。
 * @param opts.paths / opts.home - 测试接缝。
 */
export function loadMultiInstanceConfig(opts: {
  readonly localBase: string
  readonly home?: string
  readonly paths?: MultiInstancePaths
}): MultiInstanceLoad {
  const home = opts.home ?? dshHome()
  const paths = opts.paths ?? multiInstancePaths(home)
  const fallback = (degraded: string): MultiInstanceLoad => ({ config: defaultMultiInstanceConfig(opts.localBase, home), degraded, path: paths.configFile })

  let mtimeMs: number
  let size: number
  try {
    const st = statSync(paths.configFile)
    mtimeMs = st.mtimeMs
    size = st.size
  } catch {
    configCache = undefined
    return fallback('config.json 不存在')
  }
  if (configCache !== undefined && configCache.file === paths.configFile && configCache.mtimeMs === mtimeMs && configCache.size === size) {
    return configCache.value
  }

  let value: MultiInstanceLoad
  try {
    const raw = JSON.parse(readFileSync(paths.configFile, 'utf8')) as Record<string, unknown>
    const list = Array.isArray(raw.targets) ? raw.targets : null
    if (list === null || list.length === 0) {
      value = fallback('config.json 无可用 targets')
    } else {
      const targets: MultiTarget[] = []
      for (const item of list) {
        const t = normalizeTarget(item, opts.localBase, home)
        if (t !== null) targets.push(t)
      }
      if (targets.length === 0) {
        value = fallback('config.json 的 targets 全部无法解析')
      } else {
        // 本地实例永远在候选里（方案 §4.6 末条）：配置里没有 local 就补一个。
        if (!targets.some(t => t.kind === 'local')) {
          targets.unshift({ id: 'local', name: '本机', base: opts.localBase, home, kind: 'local', maxConcurrent: 4, permissionPreset: null, approvalPolicy: null })
        }
        // ⚠️ local 的 base 恒取运行时值：配置文件里的 local.base 可能是**另一台实例**写的
        // （例如生产 home 的配置被测试实例读到）⇒ 用它会打到 3080 生产。
        const normalized = targets.map(t => (t.kind === 'local' ? { ...t, base: opts.localBase, home } : t))
        const strategy = raw.strategy === 'round-robin' ? 'round-robin' : 'least-busy'
        value = { config: { version: 1, strategy, targets: normalized, archive: normalizeArchiveChain(raw.archive) }, degraded: null, path: paths.configFile }
      }
    }
  } catch (error) {
    value = fallback(`config.json 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  configCache = { file: paths.configFile, mtimeMs, size, value }
  return value
}

// ---------------------------------------------------------------------------
// 跨实例 HTTP 客户端（订正档 ①②③⑦ + 本模块 ⑦⑧）
// ---------------------------------------------------------------------------

/** 客户端一次调用的结果（HTTP 层与 gateway 层分开报，便于区分 401 / 404 / 参数错）。 */
export interface RemoteRpcResult {
  readonly http: number
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { code?: string; message?: string }
}

/** gateway 的响应信封形状（`{ type: 'server-response', rpcId, result: { ok, value | error } }`）。 */
interface RemoteEnvelope {
  result?: {
    ok?: unknown
    value?: unknown
    error?: { code?: string; message?: string }
  }
}

/** 一行跨实例会话摘要（`session/list` 的 items[]，只取本卡要的字段）。 */
export interface RemoteSessionRow {
  readonly sessionId: string
  readonly running: boolean
  readonly updatedAt?: number
  /** `projections.asOfSeq` = 该会话日志的 cursor（`session/page` 的 `throughSeq`）。 */
  readonly asOfSeq?: number
  /** `projections.values.permissions.currentValue`（A5 校验点①/② 的主判据）。 */
  readonly permissionPreset?: string
}

/** 解析 base 里的端口（用于推断启动日志名）。 */
export function portOfBase(base: string): number | null {
  try {
    const url = new URL(base)
    if (url.port !== '') return Number(url.port)
    return url.protocol === 'https:' ? 443 : 80
  } catch {
    return null
  }
}

/**
 * 推断分身的启动日志候选路径（**按优先级**）。
 *
 * 真源 = P1a 实测布局：`<分身根>\logs\dsh-inst-<port>.log`，而 `<分身根> = <home>\..`。
 * 兜底再给几个常见落点；顺序固定 ⇒ 可复现。
 */
export function inferInstanceLogCandidates(target: MultiTarget): string[] {
  if (target.log !== undefined && target.log !== '') return [target.log]
  const home = target.home
  if (home === undefined || home === '') return []
  const port = portOfBase(target.base)
  const root = dirname(home)
  const out: string[] = []
  if (port !== null) {
    out.push(join(root, 'logs', `dsh-inst-${port}.log`))
    out.push(join(home, 'logs', `dsh-inst-${port}.log`))
    out.push(join(root, 'logs', `dsh-${port}.log`))
  }
  return out
}

/** 从日志文本里按出现顺序收集 launch token（去重；**新的在后**）。 */
export function readLaunchTokens(logText: string): string[] {
  const re = /token=([A-Za-z0-9_-]{8,})/gu
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(logText)) !== null) if (!out.includes(m[1])) out.push(m[1])
  return out
}

/** 日志里最新的一条 token；`null` = 日志不可读或还没有 token（**落盘有延迟**，见 {@link RemoteHostClient.ensureCookie}）。 */
export function latestLaunchToken(target: MultiTarget): string | null {
  for (const file of inferInstanceLogCandidates(target)) {
    try {
      const tokens = readLaunchTokens(readFileSync(file, 'utf8'))
      if (tokens.length > 0) return tokens[tokens.length - 1]
    } catch { /* 试下一个候选 */ }
  }
  return null
}

/**
 * 一条派活流水（`runs.jsonl` 的一行；方案 §4.5 表第 3 行）。
 *
 * `event` 缺省 = 正常派活；`"refused"` = A5 权限硬门拒派（方案 §4.2 `A5` 要求的"写 alert"，
 * 落一条**可回读**的流水；`reason` 同时进卡的失败原因）。
 */
export interface RunLogEntry {
  readonly sessionId: string
  readonly taskId: string
  readonly executionId: string
  readonly target: string
  readonly event?: 'launched' | 'refused'
  /** 目标选择理由 / 拒派原因（可回读）。 */
  readonly reason?: string
  readonly at?: string
}

/** 追加派活流水。返回 `null` = 写成功，否则返回失败原因（调用方**必须**把它显式报出来）。 */
export function appendRunEntry(file: string, entry: RunLogEntry): string | null {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8')
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * 读 `runs.jsonl`，按 sessionId 反查 owner 的 `target.id`（§4.3 B2 第①步）。
 *
 * `undefined` = 流水里没有该会话（老卡 / 流水缺失）⇒ 调用方继续第③步的候选反查。
 * 语义：**同 sessionId 取最后一条**（追加重跑时以最新为准）。
 */
export function ownerFromRuns(file: string, sessionId: string): string | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  let found: string | undefined
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const row = JSON.parse(trimmed) as { sessionId?: unknown; target?: unknown }
      if (row.sessionId === sessionId && typeof row.target === 'string' && row.target !== '') found = row.target
    } catch { /* 跳过坏行：流水不是权威账本，坏一行不该让反查失效 */ }
  }
  return found
}

/** 卡执行会话清单的一条（`card-sessions.json` 的 `sessions[]`，方案 §4.4.1 格式）。 */
export interface CardSessionEntry {
  taskId?: string | null
  executionId?: string | null
  sessionId: string
  target?: string | null
  at?: string | null
  /** 卡被 `confirm`（验收通过）的时刻 —— §4.4.4 写死的归档链起点，**幂等：已有值不覆盖**。 */
  confirmAt?: string | null
  /** 该会话真被分身归档的时刻（§4.4.3 主判据命中 `archived[]` / 「已存在于归档区」时回写）。 */
  archivedAt?: string | null
  /** 归档尝试计数（同一写口 +1；24h 上限由 `ArchiveChainConfig.maxAttempts` 兜）。 */
  attempts?: number
  /** 最近一次尝试的结论（`<outcome>: <reason>`，只读诊断，排障时不必再翻分身日志）。 */
  lastReason?: string | null
  /** 最近一次尝试的时刻（ISO）。 */
  lastAttemptAt?: string | null
}

/** 清单写口串行化（同一进程内并发派活不许互相覆盖读-改-写）。 */
let cardSessionsQueue: Promise<unknown> = Promise.resolve()

/** 原子写（同盘 tmp → fsync → rename；跨盘 rename 会 EXDEV ⇒ 显式抛错，绝不静默）。 */
export function atomicWriteText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, text)
    try { fsyncSync(fd) } catch { /* 部分文件系统不支持，忽略 */ }
  } finally {
    closeSync(fd)
  }
  try {
    gateDestructive({ targets: [{ path: tmp, label: 'state tmp' }, { path: file, label: 'state file' }], whitelist: [dirname(file)], op: '搬移', reason: '卡会话清单原子写', action: () => renameWithRetry(tmp, file) })
  } catch (error) {
    // 重试耗尽仍失败 ⇒ tmp 留着取证（renameWithRetry 已打 stderr），别当普通失败清掉。
    if (!isTmpPreserved(error)) {
      try { gateDestructive({ targets: [{ path: tmp, label: 'state tmp' }], whitelist: [dirname(tmp)], op: '删', reason: '原子写失败回收 tmp', action: () => rmSync(tmp, { force: true }) }) } catch { /* ignore */ }
    }
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') throw new Error(`跨盘 rename 会丢数据，拒绝执行：${tmp} -> ${file}`)
    throw error
  }
}

/** 读清单（缺失 / 非法 ⇒ 空文档：清单不是权威账本，读不到不该让派活链挂掉）。 */
export function readCardSessions(file: string): { version: number; updatedAt: string | null; sessions: CardSessionEntry[] } {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { updatedAt?: unknown; sessions?: unknown }
    if (!Array.isArray(raw.sessions)) return { version: 1, updatedAt: null, sessions: [] }
    return {
      version: 1,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
      sessions: raw.sessions.filter((s): s is CardSessionEntry => typeof s === 'object' && s !== null && typeof (s as { sessionId?: unknown }).sessionId === 'string'),
    }
  } catch {
    return { version: 1, updatedAt: null, sessions: [] }
  }
}

/** 写清单（**唯一写口 + 原子写**；自动带 `updatedAt`）。 */
export function writeCardSessions(file: string, doc: { sessions: CardSessionEntry[] }): void {
  atomicWriteText(file, `${JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), sessions: doc.sessions }, null, 2)}\n`)
}

/** 新增 / 合并一条清单条目（幂等：同 sessionId 已存在 ⇒ 合并，已有值不被 `undefined` 覆盖）。 */
export function upsertCardSession(file: string, entry: CardSessionEntry): Promise<'inserted' | 'updated'> {
  const run = cardSessionsQueue.then(() => {
    const doc = readCardSessions(file)
    const idx = doc.sessions.findIndex(s => s.sessionId === entry.sessionId)
    const base: CardSessionEntry = { taskId: null, executionId: null, sessionId: entry.sessionId, target: null, at: new Date().toISOString(), confirmAt: null, archivedAt: null, attempts: 0, lastReason: null, lastAttemptAt: null }
    if (idx === -1) {
      doc.sessions.push({ ...base, ...entry })
    } else {
      const merged: Record<string, unknown> = { ...doc.sessions[idx] }
      for (const [k, v] of Object.entries(entry)) if (v !== undefined) merged[k] = v
      doc.sessions[idx] = merged as unknown as CardSessionEntry
    }
    writeCardSessions(file, doc)
    return idx === -1 ? 'inserted' as const : 'updated' as const
  })
  // 链条不断：一次失败不许堵死后续写（但失败本身要冒给调用方）。
  cardSessionsQueue = run.catch(() => undefined)
  return run
}

/** 会话索引（一次 `session/list` 的归一化结果）。 */
export interface RemoteSessionIndex {
  readonly rows: RemoteSessionRow[]
}

/** 跨实例读日志的分页结果（与本地 `readPageRecords` 同形，便于共用分类器）。 */
export interface RemoteHistoryEvents {
  readonly events: Array<{ event: { type: string; seq?: number; time?: number; data: unknown } }>
  readonly reachedExecutionBoundary: boolean
}

/**
 * 跨实例 HTTP 客户端（一个 target 一份；cookie 缓存在实例上）。
 *
 * 认领姿势（订正档 ①）：读启动日志 `?token=` → `GET {base}/?token=<T>`（**不跟随跳转**）
 * → 303 + `set-cookie: dsh-auth-*` → 之后每个 `/api` 请求带该 Cookie。
 * ⚠️ cookie **authority 绑定**（Host 头必须与认领时逐字一致）⇒ 本类只用 `target.base` 拼 URL，
 * 绝不换 `localhost` / `127.0.0.1` 写法。
 * ⚠️ 请求**不带 `Origin`**（方案 §4.2 A2 写死；也**不带** `sec-fetch-site`）。
 */
export class RemoteHostClient {
  private cookie: string | undefined
  private claimReason: string | undefined

  constructor(
    private readonly target: MultiTarget,
    private readonly timeoutMs = 8_000,
    private readonly log: (message: string) => void = () => {},
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
  ) {}

  /** 当前 cookie（诊断用；不回显明文）。 */
  cookieName(): string | undefined {
    return this.cookie?.split('=')[0]
  }

  /** 认领失败的原因（诊断用）。 */
  lastClaimReason(): string | undefined {
    return this.claimReason
  }

  /**
   * 确保有 cookie（首次认领 / `force` 时重认领）。
   *
   * ⚠️ **token 落盘有延迟**（实测 2026-10-09：`dsh web: …?token=…` 这一行要 ~26s 才进日志文件，
   * 期间进程已在监听端口）⇒ 单次读不出来 **不是**失败，必须按 `waitMs` 轮询重读日志。
   * ⚠️ token **每次启动都变** ⇒ cookie 缓存跨重启仍有效（签名密钥在实例 home），
   * 但 `401` 时必须**当次启动重读日志**，不许复用旧 token。
   */
  async ensureCookie(force = false, waitMs = 20_000): Promise<string> {
    if (!force && this.cookie !== undefined) return this.cookie
    const deadline = Date.now() + waitMs
    let lastReason = '未在启动日志里找到 token'
    for (;;) {
      const tokens = this.readTokenCandidates()
      if (tokens.length === 0) {
        lastReason = `未在启动日志里找到 token（候选：${inferInstanceLogCandidates(this.target).join(' | ') || '（无法推断，target.home 缺失）'}）`
      } else {
        for (const token of tokens) {
          const cookie = await this.claim(token)
          if (cookie !== undefined) {
            this.cookie = cookie
            this.claimReason = undefined
            return cookie
          }
        }
        lastReason = `日志里的 ${tokens.length} 个 token 全部认领失败（可能都是上次启动的旧 token）`
      }
      if (Date.now() >= deadline) break
      await this.sleep(2_000)
    }
    this.claimReason = lastReason
    throw new Error(`跨实例认领 cookie 失败（target=${this.target.id} · ${this.target.base}）：${lastReason}`)
  }

  private readTokenCandidates(): string[] {
    for (const file of inferInstanceLogCandidates(this.target)) {
      try {
        const tokens = readLaunchTokens(readFileSync(file, 'utf8'))
        if (tokens.length > 0) return [...tokens].reverse() // 最新在前
      } catch { /* 试下一个候选 */ }
    }
    return []
  }

  private async claim(token: string): Promise<string | undefined> {
    try {
      const res = await fetch(`${this.target.base}/?token=${encodeURIComponent(token)}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
      if (res.status !== 303 || setCookies.length === 0) return undefined
      const cookie = setCookies[0].split(';')[0]
      return cookie === '' ? undefined : cookie
    } catch {
      return undefined
    }
  }

  /**
   * 一次 RPC（端点 = `/api/<ns>/<method>`，斜杠两组；payload = `{args:{…}}`）。
   *
   * `401` ⇒ 自动重认领一次再打（订正档 ① 的「runner 必须自己处理 401 ⇒ 重认领」）。
   */
  async rpc(method: string, args: unknown): Promise<RemoteRpcResult> {
    let cookie: string
    try {
      cookie = await this.ensureCookie()
    } catch (error) {
      return { http: 0, ok: false, error: { code: 'claim-failed', message: error instanceof Error ? error.message : String(error) } }
    }
    let result = await this.post(method, args, cookie)
    if (result.http === 401) {
      this.cookie = undefined
      try {
        cookie = await this.ensureCookie(true)
        result = await this.post(method, args, cookie)
      } catch { /* 保持原 401 结果 */ }
    }
    return result
  }

  private async post(method: string, args: unknown, cookie: string): Promise<RemoteRpcResult> {
    try {
      const res = await fetch(`${this.target.base}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie }, // ⚠️ 不带 Origin（写死口径）
        body: JSON.stringify({
          type: 'client-request',
          rpcId: `task-board-${crypto.randomUUID()}`,
          method,
          payload: { args },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      let json: RemoteEnvelope | null = null
      try { json = JSON.parse(await res.text()) as RemoteEnvelope } catch { /* 非 JSON（404 页面等） */ }
      const r = json?.result
      if (r === undefined) return { http: res.status, ok: false, error: { code: `http-${res.status}`, message: '响应不是 gateway 信封' } }
      if (r.ok !== true) return { http: res.status, ok: false, error: r.error ?? { message: 'gateway 未回 ok' } }
      return { http: res.status, ok: true, value: r.value }
    } catch (error) {
      return { http: 0, ok: false, error: { code: 'transport-error', message: error instanceof Error ? error.message : String(error) } }
    }
  }

  /**
   * **插件自有路由**的 JSON POST（`/api/<ns>/<route>`，**不是** gateway 信封）。
   *
   * §4.4.4 的归档调用走的就是这一类：`POST {base}/api/dsh-archive-sessions/auto/run`
   * —— 它自带路由、回的是插件自己的 JSON（没有 `{result:{ok,value}}` 外壳），
   * 所以不能复用 {@link rpc}。认证姿势与 {@link rpc} 完全一致：带 cookie、
   * 401 时**当次启动重读日志**再认领一次。
   * @returns `ok` = HTTP 2xx **且** 响应体是 JSON（判据不在这里 —— 由 §4.4.3 判据函数逐字段判）。
   */
  async postRoute(path: string, body: unknown): Promise<{ http: number; ok: boolean; value?: unknown; error?: string }> {
    let cookie: string
    try {
      cookie = await this.ensureCookie()
    } catch (error) {
      return { http: 0, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    let result = await this.postRouteOnce(path, body, cookie)
    if (result.http === 401) {
      this.cookie = undefined
      try {
        cookie = await this.ensureCookie(true)
        result = await this.postRouteOnce(path, body, cookie)
      } catch { /* 保持原 401 结果 */ }
    }
    return result
  }

  private async postRouteOnce(path: string, body: unknown, cookie: string): Promise<{ http: number; ok: boolean; value?: unknown; error?: string }> {
    try {
      const res = await fetch(`${this.target.base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie }, // ⚠️ 不带 Origin（与 rpc 同口径）
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      const text = await res.text()
      let json: unknown
      try { json = JSON.parse(text) } catch { json = undefined }
      if (json === undefined) {
        return { http: res.status, ok: false, error: `响应不是 JSON（http=${res.status}）：${text.slice(0, 160)}` }
      }
      if (!res.ok) return { http: res.status, ok: false, value: json, error: `http ${res.status}` }
      return { http: res.status, ok: true, value: json }
    } catch (error) {
      return { http: 0, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 读会话索引（`session/list`）。`null` = 该实例不可读（不可达 / 超时 / 形状不认识）。 */
  async listSessions(): Promise<RemoteSessionIndex | null> {
    const res = await this.rpc('session/list', { _request: {} })
    if (!res.ok) {
      this.log(`[multi-instance] session/list 失败（target=${this.target.id}）：${res.error?.code ?? ''} ${res.error?.message ?? ''}`)
      return null
    }
    const value = res.value as { items?: unknown } | undefined
    const items = value?.items
    if (!Array.isArray(items)) return null
    const rows: RemoteSessionRow[] = []
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue
      const row = item as { sessionId?: unknown; running?: unknown; updatedAt?: unknown; projections?: { asOfSeq?: unknown; values?: { permissions?: { currentValue?: unknown } } } }
      if (typeof row.sessionId !== 'string' || row.sessionId === '') continue
      const updated = typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : undefined
      const asOfSeq = typeof row.projections?.asOfSeq === 'number' && Number.isFinite(row.projections.asOfSeq) ? row.projections.asOfSeq : undefined
      const preset = row.projections?.values?.permissions?.currentValue
      rows.push({
        sessionId: row.sessionId,
        running: row.running === true,
        ...(updated === undefined ? {} : { updatedAt: updated }),
        ...(asOfSeq === undefined ? {} : { asOfSeq }),
        ...(typeof preset === 'string' && preset !== '' ? { permissionPreset: preset } : {}),
      })
    }
    return { rows }
  }

  /** 建会话（`session/create`；wire 参数名 = `request`）。 */
  async createSession(request: Record<string, unknown>): Promise<RemoteRpcResult> {
    return this.rpc('session/create', { request })
  }

  /** 派 prompt（`session/prompt`；wire 参数名 = `request`）。 */
  async promptSession(request: Record<string, unknown>): Promise<RemoteRpcResult> {
    return this.rpc('session/prompt', { request })
  }

  /**
   * 读会话日志（`session/page`；wire 参数名 = `request`）。
   *
   * ⚠️（本模块实测 ⑦）`throughSeq` **必须是该会话的真 cursor**：`-1` 恒返回空。
   * 真 cursor 取法 = `session/list` 的 `projections.asOfSeq`（推荐）
   * 或 `throughSeq: MAX_SAFE_INTEGER` 触发 `past cursor N`。
   */
  async pageEvents(request: Record<string, unknown>): Promise<RemoteRpcResult> {
    return this.rpc('session/page', { request })
  }

  /**
   * 完整读一个会话的日志（结算 / A5 用）。
   *
   * 分页语义与本地 {@link readPageFromNewLine} 一致：同一页大小、同样的边界证明
   * （页里最老的 `time` 到达 `startedAt`，或页报告没有更多）。
   * `null` = 该实例不可读 / 形状不认识 / cursor 拿不到 ⇒ 调用方**必须**按"未知"处理（保持 pending）。
   */
  async readHistory(sessionId: string, startedAt: number, opts: { pageSize?: number; maxPages?: number } = {}): Promise<RemoteHistoryEvents | null> {
    const pageSize = opts.pageSize ?? 100
    const maxPages = opts.maxPages ?? 100
    // cursor 来源①：session/list 的 asOfSeq
    let cursor: number | undefined
    const index = await this.listSessions()
    if (index !== null) cursor = index.rows.find(r => r.sessionId === sessionId)?.asOfSeq
    // cursor 来源②：超大头探针（list 不可读 / 该行没有 asOfSeq 时）
    if (cursor === undefined) cursor = await this.probeCursor(sessionId)
    if (cursor === undefined) return null

    const events: RemoteHistoryEvents['events'] = []
    let beforeSeq: number | undefined
    let reachedExecutionBoundary = false
    for (let round = 0; round < maxPages; round += 1) {
      const res = await this.pageEvents({
        address: { kind: 'session', sessionId },
        throughSeq: cursor,
        maxMessages: pageSize,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      })
      if (!res.ok) return null
      const value = res.value as { records?: unknown; hasMore?: unknown } | undefined
      const records = value?.records
      if (!Array.isArray(records)) return null
      const pageRows: RemoteHistoryEvents['events'] = []
      for (const record of records) {
        if (typeof record !== 'object' || record === null) continue
        const event = (record as { event?: unknown }).event
        if (typeof event !== 'object' || event === null) continue
        const e = event as { type?: unknown; seq?: unknown; time?: unknown; data?: unknown }
        if (typeof e.type !== 'string') continue
        pageRows.push({
          event: {
            type: e.type,
            ...(typeof e.seq === 'number' ? { seq: e.seq } : {}),
            ...(typeof e.time === 'number' ? { time: e.time } : {}),
            data: e.data,
          },
        })
      }
      for (const entry of pageRows) events.push(entry)
      const oldestTime = pageRows.reduce<number | undefined>((oldest, entry) => {
        const time = entry.event.time
        return typeof time !== 'number' ? oldest : oldest === undefined ? time : Math.min(oldest, time)
      }, undefined)
      const oldestSeq = pageRows.reduce<number | undefined>((oldest, entry) => {
        const seq = entry.event.seq
        return typeof seq !== 'number' ? oldest : oldest === undefined ? seq : Math.min(oldest, seq)
      }, undefined)
      // 与 host-runner 的两条本机读法**三判据一致**（2026-11-09 补 `oldestSeq === 0`：
      // `oldestTime <= startedAt` 实测经常够不到，只靠 `hasMore:false` 单腿站）。
      if (value?.hasMore !== true || (oldestTime !== undefined && oldestTime <= startedAt) || oldestSeq === 0) {
        reachedExecutionBoundary = true
        break
      }
      if (oldestSeq === undefined || oldestSeq === beforeSeq) break
      beforeSeq = oldestSeq
    }
    return { events, reachedExecutionBoundary }
  }

  /**
   * 用超大头探针问出真 cursor；`undefined` = 问不出来。
   *
   * 两代文案都认（与 `host-runner.ts#cursorFromRejection` 同一口径）：0.1.5 及以前回
   * `… is past cursor N`，0.2.2+ 回 `session history cut <探针> exceeds N`。只认前者
   * ⇒ 跨机卡的结算在新宿主上恒 `pending`（2026-11-08 实测，见
   * 结算兜底的根因诊断（0.2.2 线）§3.3.1）。
   */
  private async probeCursor(sessionId: string): Promise<number | undefined> {
    const res = await this.pageEvents({ address: { kind: 'session', sessionId }, throughSeq: Number.MAX_SAFE_INTEGER, maxMessages: 1 })
    const message = res.error?.message ?? ''
    const m = /past cursor (-?\d+)/u.exec(message)                 // 0.1.5 及以前
      ?? /session history cut -?\d+ exceeds (-?\d+)/u.exec(message) // 0.2.2+
    if (m === null) return undefined
    const cursor = Number(m[1])
    return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : undefined
  }
}

// ---------------------------------------------------------------------------
// §4.2 A5 · 远程权限硬门（**只读不写**：读出来 → 比对 → 不符就拒）
// ---------------------------------------------------------------------------

/** 目标实例的权限实测读数（`ok:false` ⇒ 读不到，原因在 `reason`）。 */
export interface RemotePermissionReading {
  readonly ok: boolean
  readonly permissionPreset: string | null
  readonly sandboxMode: string | null
  readonly approvalPolicy: string | null
  readonly reason: string | null
}

/** 事件数组里取那三条种子事件（`permission/preset` / `sandbox/mode` / `approval/policy`）。 */
export function seedPermissionsFromEvents(events: ReadonlyArray<{ event: { type: string; data: unknown } }>): {
  permissionPreset: string | undefined
  sandboxMode: string | undefined
  approvalPolicy: string | undefined
} {
  let permissionPreset: string | undefined
  let sandboxMode: string | undefined
  let approvalPolicy: string | undefined
  for (const { event } of events) {
    const data = typeof event.data === 'object' && event.data !== null ? event.data as Record<string, unknown> : {}
    if (permissionPreset === undefined && event.type === EV.PERMISSION_PRESET) {
      const v = data.preset
      if (typeof v === 'string') permissionPreset = v
    }
    if (sandboxMode === undefined && event.type === EV.SANDBOX_MODE) {
      const v = data.mode
      if (typeof v === 'string') sandboxMode = v
    }
    if (approvalPolicy === undefined && event.type === EV.APPROVAL_POLICY) {
      const v = data.policy
      if (typeof v === 'string') approvalPolicy = v
    }
  }
  return { permissionPreset, sandboxMode, approvalPolicy }
}

/**
 * 读一个会话的**实际**权限（A5 校验点② 的取数口）。
 *
 * 两条来源（订正档 ④；本模块实测 ⑦ 把「会话日志首帧」也变成 HTTP 可读）：
 * ① `session/list` → 该会话 `projections.values.permissions.currentValue`（= permission preset）；
 * ② `session/page`（真 cursor）→ 头部三条种子事件（sandbox / approval 的真实取值）。
 * ⚠️ 建会话后**新会话的这两处都有 ~1s 落盘延迟** ⇒ 按 `waitMs` 轮询。
 * ⚠️ 读不到 ⇒ `ok:false` —— 调用方**必须拒派**（禁止静默降级）。
 */
export async function readRemotePermissions(
  client: RemoteHostClient,
  sessionId: string,
  opts: { startedAt?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<RemotePermissionReading> {
  const sleep = opts.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const deadline = Date.now() + (opts.waitMs ?? 12_000)
  let lastReason = '权限读数一直为空'
  for (;;) {
    let preset: string | null = null
    let sandbox: string | null = null
    let approval: string | null = null
    const index = await client.listSessions()
    if (index !== null) preset = index.rows.find(r => r.sessionId === sessionId)?.permissionPreset ?? null
    const history = await client.readHistory(sessionId, opts.startedAt ?? 0, { pageSize: 20, maxPages: 2 })
    if (history !== null) {
      const seed = seedPermissionsFromEvents(history.events)
      sandbox = seed.sandboxMode ?? null
      approval = seed.approvalPolicy ?? null
      if (preset === null) preset = seed.permissionPreset ?? null
    }
    if (preset !== null && sandbox !== null && approval !== null) {
      return { ok: true, permissionPreset: preset, sandboxMode: sandbox, approvalPolicy: approval, reason: null }
    }
    lastReason = `读到的值不全（preset=${preset ?? 'null'} · sandbox=${sandbox ?? 'null'} · approval=${approval ?? 'null'}）`
    if (Date.now() >= deadline) break
    await sleep(1_000)
  }
  return { ok: false, permissionPreset: null, sandboxMode: null, approvalPolicy: null, reason: lastReason }
}

/** 权限硬门的判据输入。 */
export interface PermissionGateInput {
  /** 卡要求的权限档（`undefined` = 卡没指定）。 */
  readonly required: string | undefined
  readonly registeredPreset: string | null
  readonly registeredApproval: string | null
  readonly actual: RemotePermissionReading
}

export type PermissionGateVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * §4.2 A5 校验点② 的判据（**纯函数**，单测直接打它）。规则**写死**：
 * 1. 目标未登记权限基线（`registeredPreset == null`）⇒ 拒（先跑校验点① 探针）；
 * 2. 实际读数不全 ⇒ 拒（**读不出来就是不知道，不知道不许派**）；
 * 3. 实际 preset ≠ 登记 preset ⇒ 拒（"目标实例配置已变"）；
 * 4. 卡显式要了某个档，而实际 ≠ 该档 ⇒ 拒（越权 / 受限，两种坏法都挡）；
 * 5. 实际 approval ≠ 登记 approval ⇒ 拒；
 * 6. 实际 approval === `ask` ⇒ 拒（无人值守卡会永久挂起 —— persona 记的"卡挂 3.5 小时"形态）。
 *
 * 拒绝时的文案直接进卡的失败原因（**可见**，不是日志 warn）。
 */
export function checkRemotePermissions(input: PermissionGateInput): PermissionGateVerdict {
  const { required, registeredPreset, registeredApproval, actual } = input
  if (registeredPreset === null || registeredPreset === '') {
    return { ok: false, reason: `目标实例未登记权限基线（permissionPreset 为空）⇒ 先跑制备期权限探针（方案 §4.2 A5 校验点①）` }
  }
  if (!actual.ok || actual.permissionPreset === null) {
    return { ok: false, reason: `读不到目标实例的实际权限（${actual.reason ?? '未知原因'}）⇒ 不确定就不派（禁止静默降级）` }
  }
  if (actual.permissionPreset !== registeredPreset) {
    return { ok: false, reason: `目标实例权限配置已变：实际 permissionPreset=${actual.permissionPreset} ≠ 登记值 ${registeredPreset}` }
  }
  if (required !== undefined && required !== '' && required !== actual.permissionPreset) {
    return { ok: false, reason: `目标实例权限 ${actual.permissionPreset} ≠ 卡要求 ${required}` }
  }
  if (registeredApproval !== null && registeredApproval !== '' && actual.approvalPolicy !== registeredApproval) {
    return { ok: false, reason: `目标实例审批策略已变：实际 approvalPolicy=${actual.approvalPolicy ?? 'null'} ≠ 登记值 ${registeredApproval}` }
  }
  if (actual.approvalPolicy === 'ask') {
    return { ok: false, reason: `目标实例 approvalPolicy=ask ⇒ 无人值守卡会永久挂起，拒派` }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// §4.6 分配策略（least-busy）
// ---------------------------------------------------------------------------

/**
 * 一个候选实例的实况（`known:false` = 查不到）。
 *
 * ⚠️ 字段刻意与 `host-runner.ts` 的 `SessionLivenessIndex` **同形**（known / running / listed /
 * lastActivity）⇒ 探测一次同时供 A1 选择、B2 反查、B4 判活三处使用，且**不必**把 runner 的
 * 类型反向 import 进来（避免循环依赖）。
 */
export interface TargetProbe {
  readonly target: MultiTarget
  readonly known: boolean
  /** 宿主当前报「正在跑一个回合」的会话 id。 */
  readonly runningIds: ReadonlySet<string>
  /** 宿主还列出来的会话 id（含 idle）。 */
  readonly listed: ReadonlySet<string>
  /**
   * 会话 id → 该会话**真实**的最后活跃时刻（epoch ms）。
   *
   * ⚠️ 2026-11-09（卡 `结算fallback根因修复`）语义已改：不再等于列表的 `updatedAt`
   * （它只跟 turn 边界走），而是 event-driven 三源取 max —— 详见
   * `host-runner.ts#combineLastActivity`。本接口只有字段名不变，消费方一行不用改。
   */
  readonly lastActivity: ReadonlyMap<string, number>
  /** 两次探测之间活跃计数**推进过**的会话 id（fallback 硬闸；缺省 = 无证据）。 */
  readonly advancing?: ReadonlySet<string>
}

/**
 * least-busy 选择（**纯函数**，单测直接打它；查实况的责任在调用方）。
 *
 * 规则（方案 §4.6 写死）：
 * - 满载（`running >= maxConcurrent`）⇒ 跳过该候选；
 * - `known:false`（远端不可用）⇒ 跳过该候选；
 * - 并列 ⇒ 取 `id` 字典序小的（**确定性**，便于复现）；
 * - 全跳过 ⇒ 返回本地候选（**本地永远在候选里**：远端不可用 ⇒ 自动回落本机，卡不会因此跑不起来）。
 * @returns 选中的 target + 选择理由（进 `runs.jsonl` / 卡失败原因，可回读）。
 */
export function selectTarget(probes: readonly TargetProbe[]): { target: MultiTarget; reason: string } {
  const local = probes.find(p => p.target.kind === 'local')
  const usable = probes.filter(p => p.target.kind !== 'local' && p.known && p.runningIds.size < p.target.maxConcurrent)
  if (usable.length === 0) {
    const skipped = probes.filter(p => p.target.kind !== 'local').map(p => `${p.target.id}:${p.known ? `${p.runningIds.size}/${p.target.maxConcurrent} 满载` : '不可读'}`)
    if (local === undefined) {
      const first = probes[0]
      return { target: first.target, reason: skipped.length === 0 ? '无候选实例' : `全部远端不可用（${skipped.join(' · ')}）⇒ 回落本机` }
    }
    return { target: local.target, reason: skipped.length === 0 ? '本机执行（未配置远端实例）' : `本机执行（${skipped.join(' · ')}）` }
  }
  const sorted = [...usable].sort((a, b) => (a.runningIds.size - b.runningIds.size) || (a.target.id < b.target.id ? -1 : a.target.id > b.target.id ? 1 : 0))
  const picked = sorted[0]
  return {
    target: picked.target,
    reason: `least-busy 选中 ${picked.target.id}（${picked.runningIds.size}/${picked.target.maxConcurrent} 在跑）`,
  }
}

/** 探测结果里挑出 owner（§4.3 B2 第③步：列表里有该 sessionId 的那一个）。 */
export function ownerFromProbes(sessionId: string, probes: readonly TargetProbe[]): string | undefined {
  // 确定性：按 target.id 字典序（并列时同样可复现）
  const hits = probes.filter(p => p.known && p.listed.has(sessionId)).map(p => p.target.id).sort()
  return hits[0]
}

// ---------------------------------------------------------------------------
// §4.4.4 confirm → 归档链（台账写入 + 归档调用 + 回读判据）
//
// 三块各司其职，**全部可单测**（纯函数 + 注入 client，不碰真网络）：
//   ① 台账写入（`markCardSessionConfirmed` / `recordArchiveAttempt`）—— `card-sessions.json` 的
//      唯一写口 + 原子写，与派活登记共用同一条串行队列；
//   ② 判据（`decideArchiveOutcome`）—— 方案 §4.4.3 那张表的**逐字段**实现；
//   ③ 一轮扫描（`archiveSweepOnce`）—— 待归档选取 + 最小调用间隔 + 保护完备性硬门 + 调归档 + 回写。
// ---------------------------------------------------------------------------

/** 台账写入结果：`missing` = 清单里没有该 sessionId（本机会话不在清单里，属正常）。 */
export type CardSessionWriteOutcome = 'updated' | 'already' | 'missing'

/**
 * §4.4.4 `confirmAt` 写入（**幂等：已有值不覆盖**）。
 *
 * 时机 = 卡 `confirm` 成功的那一刻（调用方在 `apply(confirm)` 之后立刻调）。
 * 清单里没有该 sessionId ⇒ `missing`（**不新增条目**：本机会话由主机自己的归档链按账本认领，
 * 塞进清单只会造成误读 —— 见 `host-service.recordExecutionHost` 的既定口径）。
 */
export function markCardSessionConfirmed(file: string, sessionId: string, at: string): Promise<CardSessionWriteOutcome> {
  const run = cardSessionsQueue.then(() => {
    const doc = readCardSessions(file)
    const idx = doc.sessions.findIndex(s => s.sessionId === sessionId)
    if (idx === -1) return 'missing' as const
    const existing = doc.sessions[idx].confirmAt
    if (typeof existing === 'string' && existing !== '') return 'already' as const
    doc.sessions[idx] = { ...doc.sessions[idx], confirmAt: at }
    writeCardSessions(file, doc)
    return 'updated' as const
  })
  cardSessionsQueue = run.catch(() => undefined)
  return run
}

/**
 * 一次归档尝试的回写（`attempts` 自增 + 可选 `archivedAt` + 最后原因/时刻）。
 *
 * **同一条串行队列 + 原子写**（与派活登记、`confirmAt` 共用一个写口）。
 * `attempts` 每调一次 +1：调用失败也算一次（否则 24h 上限形同虚设）。
 */
export function recordArchiveAttempt(
  file: string,
  sessionId: string,
  patch: { readonly archivedAt?: string | undefined; readonly reason: string; readonly at: string },
): Promise<CardSessionWriteOutcome> {
  const run = cardSessionsQueue.then(() => {
    const doc = readCardSessions(file)
    const idx = doc.sessions.findIndex(s => s.sessionId === sessionId)
    if (idx === -1) return 'missing' as const
    const current = doc.sessions[idx]
    const attempts = typeof current.attempts === 'number' && Number.isFinite(current.attempts) ? current.attempts : 0
    doc.sessions[idx] = {
      ...current,
      attempts: attempts + 1,
      lastReason: patch.reason,
      lastAttemptAt: patch.at,
      // 只在真被归档时写 archivedAt；已有值不覆盖（幂等：重复轮不许把时间戳改来改去）
      ...(patch.archivedAt === undefined || (typeof current.archivedAt === 'string' && current.archivedAt !== '')
        ? {}
        : { archivedAt: patch.archivedAt }),
    }
    writeCardSessions(file, doc)
    return 'updated' as const
  })
  cardSessionsQueue = run.catch(() => undefined)
  return run
}

/**
 * 待归档扫描（**纯函数**）—— 方案 §4.4.4 写死的条目条件：
 * `confirmAt != null` **且** `archivedAt == null` **且** `now - confirmAt >= minAge` **且** 尝试未超限。
 *
 * `target` 为空 ⇒ 跳过（清单只登记 `http` 目标；本机会话根本不进清单）。
 *
 * ⚠️ `opts.minAgeMs` 是**触发方覆盖**（2026-10-10 实测修）：`confirm` 那一轮的语义是
 * 「**无条件**对该 target 调一次」—— 它要注入保护名单、并**顺手搬走该实例上已满 1h 的旧卡会话**；
 * 若在这里也套 `minAgeMs`，刚落 `confirm` 的卡在"该实例上没有别的够龄条目"时会**一条请求都不发**
 * （实测：端到端跑完 `confirmAt` 写了、`attempts` 仍是 0、分身侧 `lastRunAt` 没动）。
 * ⇒ `confirm` 触发传 `0`，`tick` 重试轮用配置值（这才是"验收后进队列、≥1h 后收"）。
 */
export function pendingArchiveEntries(
  doc: { readonly sessions: readonly CardSessionEntry[] },
  nowMs: number,
  cfg: ArchiveChainConfig,
  opts: { readonly minAgeMs?: number } = {},
): CardSessionEntry[] {
  const minAgeMs = opts.minAgeMs ?? cfg.minAgeMs
  const out: CardSessionEntry[] = []
  for (const entry of doc.sessions) {
    if (typeof entry.target !== 'string' || entry.target === '') continue
    if (typeof entry.confirmAt !== 'string' || entry.confirmAt === '') continue
    if (typeof entry.archivedAt === 'string' && entry.archivedAt !== '') continue
    const attempts = typeof entry.attempts === 'number' && Number.isFinite(entry.attempts) ? entry.attempts : 0
    if (attempts >= cfg.maxAttempts) continue
    const at = Date.parse(entry.confirmAt)
    if (!Number.isFinite(at)) continue
    if (nowMs - at < minAgeMs) continue
    out.push(entry)
  }
  return out
}

/**
 * 保护名单（**纯函数**）= 某 target 上 `confirmAt == null` 的全部 `sessionId`（方案 §4.4.4 判据①）。
 *
 * 这正是"主机认得出、分身认不出"的那部分状态：分身侧 `boundOpenSessions()` 恒空集，
 * 所以主机必须**每轮显式注入**。
 */
export function protectedSessionIds(doc: { readonly sessions: readonly CardSessionEntry[] }, targetId: string): string[] {
  const out: string[] = []
  for (const entry of doc.sessions) {
    if (entry.target !== targetId) continue
    if (typeof entry.confirmAt === 'string' && entry.confirmAt !== '') continue
    out.push(entry.sessionId)
  }
  return out
}

/** 一条清单条目的归档去向（方案 §4.4.3 主判据的判定结果）。 */
export interface ArchiveVerdict {
  /** `archived` 真搬走 · `already` 幂等命中（已在归档区）· `pending` 时间/档位未到（正常）· `alert` 异常（不许静默）。 */
  readonly outcome: 'archived' | 'already' | 'pending' | 'alert'
  readonly reason: string
}

/**
 * §4.4.3 主判据（**纯函数**）：拿 `/auto/run` 的返回体逐字段判**这一个** sessionId 的去向。
 *
 * 顺序写死（先严后宽）：`dryRun` 必须 `false` → `archived[]` → `errors[]` → `skipped[]`
 * → `byClass.*.belowThreshold` 计数 → 兜底 `alert`（本轮没扫到 = B 案最危险的静默面）。
 */
export function decideArchiveOutcome(result: unknown, sessionId: string): ArchiveVerdict {
  if (typeof result !== 'object' || result === null) {
    return { outcome: 'alert', reason: '归档返回体不是对象（无法核对）' }
  }
  const r = result as Record<string, unknown>
  if (r.dryRun === true) {
    return { outcome: 'alert', reason: '归档调用回了 dryRun=true（空跑：忘传 dryRun:false）' }
  }
  const archived = Array.isArray(r.archived) ? r.archived : []
  if (archived.includes(sessionId)) {
    return { outcome: 'archived', reason: `已在 archived[]（批次 ${String(r.batch ?? '?')}）` }
  }
  const errors = Array.isArray(r.errors) ? r.errors : []
  const hitError = errors.find(item => JSON.stringify(item ?? null).includes(sessionId))
  if (hitError !== undefined) {
    return { outcome: 'alert', reason: `errors[] 命中：${JSON.stringify(hitError).slice(0, 200)}` }
  }
  const skipped = Array.isArray(r.skipped) ? r.skipped : []
  const hitSkip = skipped.find(item => typeof item === 'object' && item !== null && (item as { sessionId?: unknown }).sessionId === sessionId)
  if (hitSkip !== undefined) {
    const reason = typeof (hitSkip as { reason?: unknown }).reason === 'string' ? (hitSkip as { reason: string }).reason : '(无 reason)'
    // 「已存在于归档区」= 幂等命中（上一轮搬走但回写失败 / 重试轮再打）：不告警、不重试、不许当异常。
    if (reason.includes('已存在于归档区')) return { outcome: 'already', reason }
    // 「近期活跃（<1h…）」= 时间未到（正常态）：记 pending，由主机重试轮驱动。
    if (reason.includes('近期活跃')) return { outcome: 'pending', reason }
    // 「运行中（宿主注入的 runningIds）」= 已 confirm 的卡**不该**在保护名单里 ⇒ 异常。
    if (reason.includes('运行中')) return { outcome: 'alert', reason: `已 confirm 的卡不该在保护名单里：${reason}` }
    return { outcome: 'alert', reason }
  }
  // `byClass[cls].belowThreshold` 只计数、**不写 skipped**（源码 :1365-1367）⇒ 计数 > 0 时
  // 只能判"档位未到（正常态）"，不许判成"没扫到"（旧口径会把正常态误报成最危险静默面）。
  const byClass = r.byClass
  if (typeof byClass === 'object' && byClass !== null) {
    for (const cls of ['human', 'card', 'subagent'] as const) {
      const row = (byClass as Record<string, unknown>)[cls]
      if (typeof row === 'object' && row !== null
        && typeof (row as { belowThreshold?: unknown }).belowThreshold === 'number'
        && ((row as { belowThreshold: number }).belowThreshold) > 0) {
        return { outcome: 'pending', reason: `${cls} 档未到阈值（belowThreshold>0，正常态）` }
      }
    }
  }
  return { outcome: 'alert', reason: '本轮没扫到该会话（清单没送达 / 会话不在 sessions\\ 下）' }
}

/** 「写 alert」的实体落点（不许静默：一行一条 JSONL，追加式，失败只返回消息）。 */
export function appendArchiveAlert(dir: string, entry: Record<string, unknown>): string | null {
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'archive-alerts.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** 归档调用需要的最小客户端面（单测注入假 client 用；`RemoteHostClient` 已满足）。 */
export interface ArchiveRouteClient {
  postRoute(path: string, body: unknown): Promise<{ http: number; ok: boolean; value?: unknown; error?: string }>
}

/** 归档路由（写死：分身侧插件 `dsh-archive-sessions` 的 `/auto/run`）。 */
export const ARCHIVE_RUN_ROUTE = '/api/dsh-archive-sessions/auto/run'

export interface ArchiveSweepDeps {
  readonly paths: MultiInstancePaths
  readonly config: MultiInstanceConfig
  readonly now: () => number
  readonly clientFor: (target: MultiTarget) => ArchiveRouteClient
  /** 每个 target 的"上次调用时刻"（由调用方持有，跨轮记忆 ⇒ 最小间隔才生效）。 */
  readonly lastCallAt: Map<string, number>
  readonly log: (message: string) => void
}

export interface ArchiveSweepResult {
  readonly called: Array<{ target: string; sessionIds: string[]; http: number; ok: boolean; error?: string }>
  readonly pending: number
  /** 必须被看见的异常（调用方负责 `console.error` / 写 alert 文件）。 */
  readonly alerts: string[]
  readonly skipped: string[]
  /** `true` = 整链关着（`archive.enabled === false`）⇒ 一次请求都没发。 */
  readonly disabled: boolean
}

/**
 * 一轮归档扫描（§4.4.4「重试驱动者 = 主机 runner tick」）。
 *
 * 一轮做的事（顺序写死）：
 * 1. 开关关 ⇒ 立刻返回（**零请求**）；
 * 2. 读清单 → {@link pendingArchiveEntries} 选待归档（**`confirm` 触发不套 ≥1h**，见该函数注）；
 * 3. 按 target 分组，同一 target 距上次调用 < `retryIntervalMs` ⇒ 跳过（避免每分钟跨实例打一次）；
 * 4. 保护完备性硬门（自洽性断言）：`runningIds` = 本 target 上 `confirmAt == null` 的全部 sessionId，
 *    请求体里注入的就是这个集合；算出来再比 ⇒ 不等就**不调**（fail-closed）；
 * 5. 调 `/auto/run`（四键必需 + `trigger` 自由标注）；
 * 6. 按 {@link decideArchiveOutcome} **逐条**回写（`archivedAt` / `attempts` / 最后原因），
 *    `alert` 类同时进 `result.alerts`。
 *
 * ⚠️ 任何一步失败都**不抛**（返回体里如实登记）：归档链是"补课"，不许反过来弄坏看板。
 */
export async function archiveSweepOnce(
  deps: ArchiveSweepDeps,
  opts: { readonly trigger: string; readonly force?: boolean } = { trigger: 'tick' },
): Promise<ArchiveSweepResult> {
  const cfg = deps.config.archive ?? DEFAULT_ARCHIVE_CHAIN
  const result: { called: ArchiveSweepResult['called']; pending: number; alerts: string[]; skipped: string[]; disabled: boolean } = {
    called: [], pending: 0, alerts: [], skipped: [], disabled: false,
  }
  if (!cfg.enabled) {
    result.disabled = true
    return result
  }
  const doc = readCardSessions(deps.paths.cardSessionsFile)
  // `confirm` 触发 = **无条件对该 target 调一次**（注入保护名单 + 顺手搬旧卡会话）；
  // `tick` 重试轮才套 ≥1h 条目条件（方案 §4.4.4 的"验收后进队列、≥1h 后收"）。
  const minAgeMs = opts.trigger === 'host-confirm' ? 0 : cfg.minAgeMs
  const pending = pendingArchiveEntries(doc, deps.now(), cfg, { minAgeMs })
  result.pending = pending.length
  if (pending.length === 0) return result

  const byTarget = new Map<string, CardSessionEntry[]>()
  for (const entry of pending) {
    const id = entry.target as string
    const bucket = byTarget.get(id)
    if (bucket === undefined) byTarget.set(id, [entry])
    else bucket.push(entry)
  }

  for (const [targetId, entries] of byTarget) {
    const target = deps.config.targets.find(t => t.id === targetId && t.kind === 'http')
    if (target === undefined) {
      result.skipped.push(`${targetId}：不在配置里（或不是 http 目标）`)
      continue
    }
    const last = deps.lastCallAt.get(targetId)
    if (opts.force !== true && last !== undefined && deps.now() - last < cfg.retryIntervalMs) {
      result.skipped.push(`${targetId}：距上次调用不足 ${Math.round(cfg.retryIntervalMs / 60_000)} 分钟`)
      continue
    }
    const runningIds = protectedSessionIds(doc, targetId)
    // 硬门（自洽性断言）：请求体里的 runningIds 必须**恰好**是保护集合（不许漏注 / 少注）。
    const body = {
      dryRun: false,
      runningIds,
      activeHoldHours: cfg.activeHoldHours,
      hoursCard: cfg.hoursCard,
      trigger: opts.trigger,
    }
    if (JSON.stringify(body.runningIds) !== JSON.stringify(runningIds)) {
      result.skipped.push(`${targetId}：保护名单不自洽 ⇒ 本轮不调`)
      continue
    }
    deps.lastCallAt.set(targetId, deps.now())
    let res: { http: number; ok: boolean; value?: unknown; error?: string }
    try {
      res = await deps.clientFor(target).postRoute(ARCHIVE_RUN_ROUTE, body)
    } catch (error) {
      res = { http: 0, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    result.called.push({
      target: targetId, sessionIds: entries.map(e => e.sessionId), http: res.http, ok: res.ok,
      ...(res.error === undefined ? {} : { error: res.error }),
    })
    const at = new Date(deps.now()).toISOString()
    for (const entry of entries) {
      if (!res.ok) {
        const reason = `调用失败（http=${res.http}）：${res.error ?? '未知'}`
        await recordArchiveAttempt(deps.paths.cardSessionsFile, entry.sessionId, { reason, at }).catch(() => undefined)
        result.alerts.push(`${entry.sessionId}（${targetId}）：${reason}`)
        continue
      }
      const verdict = decideArchiveOutcome(res.value, entry.sessionId)
      await recordArchiveAttempt(deps.paths.cardSessionsFile, entry.sessionId, {
        reason: `${verdict.outcome}: ${verdict.reason}`,
        at,
        ...(verdict.outcome === 'archived' || verdict.outcome === 'already' ? { archivedAt: at } : {}),
      }).catch(() => undefined)
      if (verdict.outcome === 'alert') result.alerts.push(`${entry.sessionId}（${targetId}）：${verdict.reason}`)
    }
  }
  return result
}
