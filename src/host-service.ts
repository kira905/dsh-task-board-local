import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import type { TaskRecord } from './core/tasks.ts'
import { nextRunAtMs } from './core/schedule.ts'
import type { ArchiveBatchIndexEntry } from './host-archive-store.ts'
import { HostTaskLedger, type LedgerState, type OpenedRun, type OpenExecutionReference } from './host-ledger.ts'
import { HostExecutionRunner, SESSION_START_GRACE_MS, SessionLaunchError, decideStalePendingFallback, isExecutionAlive, type ResolveDefaultModel, type ResolveNewLineSessionApi, type SessionCommandDispatcher, type SessionLivenessIndex, type WorkspaceFallbackSettings } from './host-runner.ts'
// 多实例分载（G28 · P1）：A3 会话身份登记的两个写口（方案 §4.2 A3 / §4.5）。
import { appendArchiveAlert, appendRunEntry, archiveSweepOnce, loadMultiInstanceConfig, markCardSessionConfirmed, multiInstancePaths, upsertCardSession, RemoteHostClient, type MultiTarget } from './multi-instance.ts'
import { PowerInhibitor } from './power-inhibitor.ts'
import type { TaskBoardAction, TaskBoardEventPayload, TaskBoardSnapshot } from './protocol.ts'

const SESSION_POLL_MS = 5_000
const SCHEDULE_TICK_MS = 30_000
const RESUME_GAP_MS = SCHEDULE_TICK_MS + 15_000

/** One page of the archive read routes (方案 §3 D-4). */
export interface ArchivePage {
  limit: number
  offset: number
}

/**
 * 该卡**最后一次**执行记录上挂着的会话 id（§4.4.4 confirm 钩子用）。
 *
 * 取"末条带 sessionId 的执行"（不是"末条执行"）：一条执行刚结算、下一条才开跑时，
 * 末条可能还没有 sessionId —— 而归档要的正是**已经跑过的那个会话**。
 */
function lastAttachedSessionId(task: TaskRecord): string | undefined {
  for (let i = task.executions.length - 1; i >= 0; i -= 1) {
    const sessionId = task.executions[i]?.sessionId
    if (typeof sessionId === 'string' && sessionId !== '') return sessionId
  }
  return undefined
}

/** One batch's cards, paged. */
export interface ArchiveBatchPage {
  entry: ArchiveBatchIndexEntry
  cards: TaskRecord[]
  total: number
}

/**
 * The single authoritative "every card" view — 方案 §3 D-10 option (a).
 *
 * After the physical-archive migration the main ledger only holds in-flight
 * cards, so any reader that wants the whole board (duplicate checks, snapshot
 * exporters, the daily report) would otherwise have to learn to merge batches
 * itself; one missed reader would silently see fewer cards and could duplicate
 * work. Keeping the merge HERE means `scope=all` stays the one place that
 * knows the answer.
 *
 * The main ledger wins on an id collision (a card exists in exactly one place
 * by design — 方案 §6 表 1 — but a half-restored batch must never shadow the
 * live copy).
 * @param ledgerTasks - Cards held by the main ledger (in-flight, plus any
 *   legacy in-ledger archive marker).
 * @param batchCards - Archived cards, batch by batch, in batch order.
 */
export function mergeBoardView(
  ledgerTasks: readonly TaskRecord[],
  batchCards: readonly (readonly TaskRecord[])[],
): TaskRecord[] {
  const seen = new Set(ledgerTasks.map(task => task.id))
  const merged: TaskRecord[] = [...ledgerTasks]
  for (const cards of batchCards) {
    for (const card of cards) {
      if (seen.has(card.id)) continue
      seen.add(card.id)
      merged.push(card)
    }
  }
  return merged
}

export class TaskBoardHostService {
  readonly ledger: HostTaskLedger
  readonly runner: HostExecutionRunner
  readonly power: PowerInhibitor
  private readonly listeners = new Set<() => void>()
  private timers: Array<ReturnType<typeof setInterval>> = []
  private lastScheduleTick: number | undefined
  private disposed = false
  private pollInFlight = false
  private tickInFlight = false
  private active = true
  private preventIdleSleep = false
  private lastPowerJson = ''
  /**
   * §4.4.4 confirm → 归档链的三个状态：
   * - `archiveClients` = 跨实例客户端（按 id 缓存；**超时 60 s** —— 归档是全库扫描，8 s 会假超时）；
   * - `lastArchiveCallAt` = 每个 target 上次调用时刻（最小间隔 10 分钟的判据）；
   * - `archiveSweepInFlight` = 单轮在飞闸（confirm 钩子与 tick 可能同时触发）。
   */
  private readonly archiveClients = new Map<string, { client: RemoteHostClient; base: string }>()
  private readonly lastArchiveCallAt = new Map<string, number>()
  private archiveSweepInFlight = false
  /**
   * 卡 `结算fallback根因修复`（2026-11-09）· `executionId → 第一次读到 pending 的时刻`。
   *
   * 为什么要它：`inspect` 的 `pending` 往往是**瞬时**的（卡 `dd6e00ea` 的结算点距日志最后
   * 写入只有 6 秒）。只凭"会话已被证明结束 + 时钟已过阈值"就开火，等于把偶发读不出
   * 放大成必然误杀。改成「**连续** pending ≥ 阈值」后才允许兜底，`inspect` 一旦给出结论
   * 或有别的路径结算，条目立刻删除。
   *
   * ⚠️ 取舍（故意）：DSH 重启后本表清空 ⇒ 重启前遗留的假 running 卡要**多等一个阈值**
   * 才会被回收。这是安全方向的变慢 —— 2026-11-08 那 4 次误杀全部发生在重启后两小时内。
   */
  private readonly pendingSince = new Map<string, number>()
  private readonly now: () => number

  constructor(getApi: () => ApiProxy | null, options: {
    ledger?: HostTaskLedger
    power?: PowerInhibitor
    now?: () => number
    commandDispatcher?: SessionCommandDispatcher
    /**
     * Late-binding resolver for the 0.1.5-line session service
     * (`ctx.sessionController`). The runner prefers it whenever it resolves;
     * `undefined` keeps the legacy `apiProxy`-only behaviour (unit tests and
     * any host line without the new service).
     */
    resolveNewSession?: ResolveNewLineSessionApi
    /**
     * G-1 · 全局默认模型桥（缺省 ⇒ 卡面档位整体降级：读不到基线就不调）。
     * @see ResolveDefaultModel
     */
    resolveDefaultModel?: ResolveDefaultModel
  } = {}) {
    this.ledger = options.ledger ?? new HostTaskLedger()
    this.runner = new HostExecutionRunner(getApi, options.commandDispatcher, options.resolveNewSession, options.resolveDefaultModel)
    this.power = options.power ?? new PowerInhibitor()
    this.now = options.now ?? Date.now
    this.ledger.subscribe(() => {
      this.syncPowerReasons()
      this.emit()
    })
    this.power.subscribe(() => {
      // updateReasons emits on every poll tick even when nothing changed;
      // gate on the actual snapshot so the 5 s heartbeat does not push an
      // empty SSE frame per tab forever.
      const json = JSON.stringify(this.power.snapshot())
      if (json === this.lastPowerJson) return
      this.lastPowerJson = json
      this.emit()
    })
  }

  start(): void {
    if (this.disposed || this.timers.length > 0) return
    this.syncPowerReasons()
    this.timers.push(setInterval(() => { this.schedulePoll() }, SESSION_POLL_MS))
    this.timers.push(setInterval(() => { this.scheduleTick(false) }, SCHEDULE_TICK_MS))
    this.schedulePoll()
    this.scheduleTick(true)
  }

  /**
   * Apply the live plugin configuration.
   *
   * `workspaceFallback` is the 卡执行工作区回落三件套 (D-3 + D-3b, plan
   * §3.3(b)): the settings surface hands it over on every change, and the
   * runner reads it at `launch()` time. Omitting it (older callers, no
   * settings surface) leaves the runner on its own defaults — switch on,
   * D/M unset — which is exactly "no fallback".
   * @param active - master switch of the plugin.
   * @param preventIdleSleep - idle-sleep inhibitor flag.
   * @param workspaceFallback - default/main workspace ids and the fallback switch.
   */
  setConfiguration(active: boolean, preventIdleSleep: boolean, workspaceFallback?: WorkspaceFallbackSettings): void {
    const resumed = !this.active && active
    this.active = active
    this.preventIdleSleep = preventIdleSleep
    this.runner.setWorkspaceFallback(workspaceFallback)
    if (resumed) {
      const current = this.power.snapshot()
      this.power.updateReasons({
        runningSessions: current.runningSessions,
        armedSchedules: this.armedSchedules(),
        sessionStateKnown: false,
      })
    }
    this.power.setEnabled(active && preventIdleSleep)
    if (resumed) {
      this.schedulePoll()
      this.scheduleTick(true)
    }
    this.emit()
  }

  /**
   * Board snapshot for one reader.
   *
   * `scope: 'live'` drops archived cards. On the production ledger (609 cards,
   * 6 MB) archived cards plus their history are the overwhelming majority of
   * the payload, and every butler tick polls this endpoint — that polling is
   * what stalled the Host event loop long enough for the watchdog to declare
   * the process dead. Readers that need history (archive view, duplicate
   * checks, snapshots) keep the default `'all'`.
   *
   * `scope: 'all'` (the default) is the MERGED board view after the physical
   * archive migration (方案 §3 D-10 option (a)): main ledger + every batch.
   * That keeps "no header = every card" true for every existing reader, at the
   * cost of reading the batch files — which is exactly the trade the plan
   * chose over "make every tool merge for itself".
   */
  snapshot(scope: 'all' | 'live' = 'all'): TaskBoardSnapshot {
    return this.snapshotFrom(this.ledger.state(), scope)
  }

  /** Ledger revision only — cheap enough to answer an `If-None-Match` probe. */
  revision(): number {
    return this.ledger.summary().revision
  }

  /**
   * Archive index for `GET /archive` (方案 §3 D-4).
   * @returns the batch rows plus the board-wide card count used for
   *   reconciliation against the sum of per-batch counts (方案 §5 J4).
   */
  archiveIndex(): { revision: number; batches: ArchiveBatchIndexEntry[]; cardCount: number } {
    const batches = this.ledger.archiveBatches()
    return {
      revision: this.ledger.summary().revision,
      batches,
      cardCount: batches.reduce((sum, entry) => sum + entry.count, 0),
    }
  }

  /**
   * One batch's cards for `GET /archive/<batchId>`, paged (方案 §3 D-4).
   * @returns undefined when no such batch exists (the caller answers 404).
   */
  archiveBatch(batchId: string, page: ArchivePage): ArchiveBatchPage | undefined {
    const entry = this.ledger.batchEntry(batchId)
    if (entry === undefined) return undefined
    const cards = this.ledger.batchCards(batchId) ?? []
    return {
      entry,
      cards: cards.slice(page.offset, page.offset + page.limit),
      total: cards.length,
    }
  }

  /** SSE frame payload; deliberately skips the tasks deep-clone of {@link snapshot}. */
  eventPayload(): TaskBoardEventPayload {
    const { revision, scheduler } = this.ledger.summary()
    return { revision, scheduler, power: this.power.snapshot() }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Apply one action and return the reader's next snapshot.
   *
   * Card [看板瘦身·K2]: `scope` is accepted here too (方案 §8 #4), with the same
   * meaning as on `GET /state` — the client sends `x-dsh-board-scope: live` on
   * its mutations, so a card action no longer ships the whole history back
   * (判据 J14). The default stays `'all'`, so every existing caller keeps the
   * byte-for-byte behaviour it had before this card.
   */
  apply(requestId: string, action: TaskBoardAction, scope: 'all' | 'live' = 'all'): TaskBoardSnapshot {
    if (!this.active) throw new Error('task board is disabled')
    const result = this.ledger.applyRequest(requestId, action)
    if (result.run !== undefined) this.scheduleLaunch(result.run)
    // §4.4.4：卡 `confirm`（验收通过）是归档链的**唯一启动时刻** —— 写 `confirmAt` + 立刻提示
    // 归档一次（那一轮的真实作用 = 注入保护名单 + 顺手搬走"已 confirm 且已满 1h"的旧卡会话）。
    // 这里**只挂后置钩子**：账本已经提交，台账写入 / 跨实例调用一律异步且失败不阻断
    // （抛错会把一次成功的验收变成接口 500，代价远大于"归档晚一轮"）。
    if (action.kind === 'confirm' && result.state.tasks.some(task => task.id === action.taskId)) {
      this.onCardConfirmed(action.taskId, result.state)
    }
    return this.snapshotFrom(result.state, scope)
  }

  /**
   * `confirm` 后置钩子（§4.4.4）。
   *
   * 顺序 = **先写 `confirmAt`（幂等），再调归档一次**：
   * - 清单里没有这个 sessionId ⇒ 本机会话（清单只登记 `http` 目标）⇒ **到此为止**；
   * - 写入失败 ⇒ 只留 stderr，**不进归档链**（免得归档轮次基于一条没登记的时间戳空转）；
   * - 归档调用失败 ⇒ `archiveSweepOnce` 自己如实登记，这里只把告警转成 stderr + 告警文件。
   */
  private onCardConfirmed(taskId: string, state: LedgerState): void {
    const task = state.tasks.find(item => item.id === taskId)
    if (task === undefined) return
    const sessionId = lastAttachedSessionId(task)
    if (sessionId === undefined) return
    const paths = multiInstancePaths()
    const at = new Date(this.now()).toISOString()
    void markCardSessionConfirmed(paths.cardSessionsFile, sessionId, at).then(async outcome => {
      if (outcome === 'missing') return
      await this.sweepArchive('host-confirm')
    }).catch(error => {
      console.error(`[dsh-task-board][multi-instance] confirmAt 写入失败（task=${taskId} · session=${sessionId}）：${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * 一轮归档扫描（tick 驱动 + confirm 触发共用）。
   *
   * 短路条件（**零行为**的守门人）：多实例未启用（`targets.length <= 1`）⇒ 直接返回。
   * 关回 = `config.json` 的 `archive.enabled = false`（读盘按 mtime 失效 ⇒ 改完下一个 tick 即生效，
   * **不需要重启**）。
   */
  private async sweepArchive(trigger: string): Promise<void> {
    if (this.disposed || this.archiveSweepInFlight) return
    const loaded = loadMultiInstanceConfig({ localBase: this.runner.localBase() })
    if (loaded.config.targets.length <= 1) return
    if (!(loaded.config.archive ?? { enabled: true }).enabled) return
    this.archiveSweepInFlight = true
    try {
      const result = await archiveSweepOnce({
        paths: multiInstancePaths(),
        config: loaded.config,
        now: () => this.now(),
        clientFor: target => this.archiveClient(target),
        lastCallAt: this.lastArchiveCallAt,
        log: message => console.warn(`[dsh-task-board][multi-instance] ${message}`),
      }, { trigger })
      for (const alert of result.alerts) {
        console.error(`[dsh-task-board][multi-instance] 归档告警：${alert}`)
      }
      if (result.alerts.length > 0) {
        const failure = appendArchiveAlert(multiInstancePaths().dir, { trigger, alerts: result.alerts })
        if (failure !== null) console.error(`[dsh-task-board][multi-instance] 归档告警落盘失败：${failure}`)
      }
    } catch (error) {
      console.error(`[dsh-task-board][multi-instance] 归档扫描失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.archiveSweepInFlight = false
    }
  }

  /** 该 target 的归档客户端（按 id 缓存；60 s 超时 —— 归档是全库扫描）。 */
  private archiveClient(target: MultiTarget): RemoteHostClient {
    const cached = this.archiveClients.get(target.id)
    if (cached !== undefined && cached.base === target.base) return cached.client
    const client = new RemoteHostClient(target, 60_000, message => console.warn(`[dsh-task-board][multi-instance] ${message}`))
    this.archiveClients.set(target.id, { client, base: target.base })
    return client
  }

  /** Shared body of {@link snapshot} / {@link apply}; never re-reads the ledger. */
  private snapshotFrom(state: LedgerState, scope: 'all' | 'live'): TaskBoardSnapshot {
    const tasks = scope === 'live'
      ? state.tasks.filter(task => task.archivedAt === undefined)
      : mergeBoardView(state.tasks, this.ledger.archivedCards())
    return {
      schemaVersion: 2,
      revision: state.revision,
      tasks,
      scheduler: state.scheduler,
      power: this.power.snapshot(),
    }
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.splice(0)) clearInterval(timer)
    this.power.dispose()
    this.ledger.dispose()
    this.listeners.clear()
  }

  private async launch(opened: OpenedRun): Promise<void> {
    try {
      const sessionId = await this.runner.launch(opened.task, {
        // A3 · 会话身份登记：**会话建立后立刻**回调（local 也回调，供 runs.jsonl 追溯）。
        onSession: async ({ sessionId: created, target, reason }) => {
          await this.recordExecutionHost(opened.task.id, opened.execution.id, created, target, reason)
        },
      })
      this.ledger.attachSession(opened.task.id, opened.execution.id, sessionId)
    } catch (error) {
      if (error instanceof SessionLaunchError) {
        this.ledger.attachSession(opened.task.id, opened.execution.id, error.sessionId)
      }
      this.ledger.settle(opened.task.id, opened.execution.id, 'failed', error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * A3 · 会话身份登记（方案 §4.2 `A3` / §4.5）。
   *
   * 两个写口：
   * - `runs.jsonl`（**所有派活都写**，含本机）—— 供 `B2` 反查 owner 的**第一顺位**、以及事后追溯"这卡在哪台跑的"；
   * - `card-sessions.json`（**只写 `http` 目标**）—— 它是**给分身归档插件消费的清单**（§4.4.1 `B-2`），
   *   本机会话由主机自己的归档链按账本认领，塞进去只会造成误读。
   *
   * ⚠️ 登记失败**不阻断派活**（会话已经建了，抛错只会让卡落 failed 而会话照跑 —— 更糟），
   * 但**必须可见**：两条通路各自 `console.error` 到位。
   * ⚠️ 本函数**只在多实例启用时**被调用（`runner.launch` 的单实例分支不触发 `onSession`）⇒
   * "删掉配置 ⇒ 回到纯本机模式"是逐字节成立的。
   */
  private async recordExecutionHost(
    taskId: string,
    executionId: string,
    sessionId: string,
    target: MultiTarget,
    reason: string,
  ): Promise<void> {
    const paths = multiInstancePaths()
    const runFailure = appendRunEntry(paths.runsFile, { sessionId, taskId, executionId, target: target.id, reason })
    if (runFailure !== null) {
      console.error(`[dsh-task-board][multi-instance] runs.jsonl 写入失败（sessionId=${sessionId} · task=${taskId}）：${runFailure}`)
    }
    if (target.kind !== 'http') return
    try {
      await upsertCardSession(paths.cardSessionsFile, { taskId, executionId, sessionId, target: target.id, at: new Date().toISOString() })
    } catch (error) {
      console.error(`[dsh-task-board][multi-instance] card-sessions.json 写入失败（sessionId=${sessionId} · target=${target.id}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async pollSessions(): Promise<void> {
    if (this.disposed) return
    if (!this.active && this.ledger.runtimeView().openExecutions.length === 0) return
    const running = await this.runner.listRunning()
    const previous = this.power.snapshot()
    if (!running.known) {
      this.power.updateReasons({
        runningSessions: previous.runningSessions,
        armedSchedules: this.ledger.armedScheduleCount(),
        sessionStateKnown: false,
      })
      return
    }
    // Read after the RPC so executions attached while it was in flight are
    // included in this pass, matching the former full-state snapshot timing.
    const runtime = this.ledger.runtimeView()
    this.power.updateReasons({
      runningSessions: running.count,
      armedSchedules: runtime.armedSchedules,
      sessionStateKnown: true,
    })
    // No unconditional emit here: real changes already emit through the
    // ledger subscription (settles) and the gated power listener above.
    await this.reconcileExecutions(runtime.openExecutions)
    // §4.4.4：归档链的**重试驱动者 = 这一次 tick**（每 5 s 一次；函数内部按 target 判
    // "距上次调用 ≥10 分钟"，所以稳态下这里只做一次"读清单 + 比时间"的廉价检查）。
    void this.sweepArchive('tick')
  }

  /**
   * Settle every open execution whose session history already shows a
   * terminal turn (the local-fork inspect reads the history directly, so the
   * poll's session list is no longer needed here).
   *
   * Card [Q3] — this is also the post-restart recovery path (the Host starts
   * polling as soon as it boots, so every execution left open by the previous
   * instance comes through here). The liveness gate runs FIRST and is
   * mandatory: a restart can hand the turn over to the new instance, and
   * settling such an execution is a false settlement (2026-09-11 11:53: three
   * cards settled `succeeded` while their sessions kept running). Rules:
   * never settle a running session, never settle on an unreadable list, and
   * never settle a session that has not yet appeared in the list (it may still
   * be starting).
   *
   * 假 running 兜底 (2026-09-14): an execution whose session is proven dead may
   * still resolve `pending` for ever (an unreadable/huge history, no execution
   * boundary). Once it has been silent past {@link STALE_PENDING_SETTLE_MS} it
   * is settled `interrupted` rather than left running — see the inline comment
   * in the loop. The three rules above are untouched: the fallback only runs
   * where the liveness gate already said "determined, not alive".
   */
  private async reconcileExecutions(
    executions: readonly OpenExecutionReference[],
  ): Promise<void> {
    const attached = executions.filter(execution => execution.sessionId !== undefined)
    if (attached.length === 0) return
    // 只对**本卡真正关心的会话**读日志 mtime（列表一次回 750 行，逐行扫目录不可接受）。
    const only = new Set(attached.map(execution => execution.sessionId as string))

    // ── 多实例**未启用** ⇒ 与改造前逐字节等价：一次全局判活 + 逐条结算，不探测、不反查 ──
    if (!this.runner.multiInstanceEnabled()) {
      const liveness = await this.runner.listSessionLiveness(only)
      for (const execution of attached) await this.reconcileOne(execution, liveness, undefined)
      return
    }

    // ── 多实例启用 ⇒ 探测候选一次（同一份读数供选择 / 反查 owner / 判活三处共用） ──
    const probes = await this.runner.probeTargets(only)
    for (const execution of attached) {
      const sessionId = execution.sessionId as string
      // §4.3 B2 · 反查 owner：先 runs.jsonl（派活时登记的 target.id），未命中再依次查候选实例。
      const owner = await this.runner.resolveOwner(sessionId, probes)
      if (owner === undefined) {
        // 无 owner ⇒ 按 B4 的「不可读」处理：**保持 pending，不结算**。
        // ⚠️ 这里**禁止**退化成"随便挑一个实例查"或把多实例读数做 union —— 见 reconcileOne 头注。
        continue
      }
      const probe = probes.find(p => p.target.id === owner.id)
      if (probe === undefined || !probe.known) {
        // owner 不可读（超时 / 不可达）⇒ known:false ⇒ 保持 pending。
        continue
      }
      // §4.3 B4 · 判活是**单语义**：`known` 只由 owner 这一个 index 决定，
      // 绝不把多实例的 known 做 union / 逻辑或（那会把还在跑的卡结算成 interrupted）。
      const liveness: SessionLivenessIndex = {
        known: true,
        running: probe.runningIds,
        listed: probe.listed,
        lastActivity: probe.lastActivity,
        ...(probe.advancing === undefined ? {} : { advancing: probe.advancing }),
      }
      await this.reconcileOne(execution, liveness, owner)
    }
  }

  /**
   * 单条执行会话的结算（判活闸门 → `inspect` → 写账本 → 假 running 兜底）。
   *
   * `liveness` **必须**是该会话 owner 那一个 index（`known:false` 的 index 由调用方挡在外面）。
   * `target` = 该会话的 owner（`undefined` = 单实例模式 / 本机）。
   *
   * 三道护栏原样保留：**已经在跑的会话不结算**（`alive.alive`）、**列表读不到不结算**
   * （`determined === false`）、**启动宽限窗内不判死**（`session-missing` + 30s）。
   */
  private async reconcileOne(
    execution: OpenExecutionReference,
    liveness: SessionLivenessIndex,
    target: MultiTarget | undefined,
  ): Promise<void> {
    const sessionId = execution.sessionId as string
    const alive = isExecutionAlive(sessionId, liveness)
    if (!alive.determined) return
    if (alive.alive) return
    if (alive.reason === 'session-missing' && Date.now() - execution.startedAt < SESSION_START_GRACE_MS) return
    try {
      const result = await this.runner.inspect(sessionId, execution.startedAt, {
        sessionEnded: true,
        ...(target === undefined ? {} : { target }),
      })
      if (result.outcome !== 'pending') {
        this.pendingSince.delete(execution.executionId)
        this.ledger.settle(execution.taskId, execution.executionId, result.outcome, 'error' in result ? result.error : undefined)
        return
      }
      // 假 running 兜底（2026-09-14，卡 f0a9dd5e）：会话已被证明**不在跑**，inspect 却仍然
      // 判不出结果（超大会话/历史读不到/拿不到执行边界）。没有这条兜底，卡就永久停在
      // running：既不能人工移动（move 拒绝 running 卡），也永远堵着 P0 闸门。
      // 静默超过阈值 → 按 interrupted 结算，卡回 todo（可操作列），失败原因写在 execution 上。
      // 护栏不变：能走到这里的前提是 liveness 已判 alive=false（还在跑的会话在上面的
      // `if (alive.alive) return` 就跳过了），列表读不到时 `alive.determined=false` 也跳过。
      //
      // 🔴 卡 `结算fallback根因修复`（2026-11-09）三道新增护栏，缺一条都会误杀长卡：
      //   ① `advancing` —— 两次轮询之间 asOfSeq/mtime 还在动 ⇒ 会话**此刻**活着，一律不结算；
      //   ② `pendingSince` —— pending 必须是**连续**的（瞬时读不出不算数）；
      //   ③ 开火前**再 inspect 一次** —— 第一次读不出很可能是撞上了日志正在追加的窗口。
      const now = this.now()
      if (liveness.advancing?.has(sessionId) === true) return
      const firstPendingAt = this.pendingSince.get(execution.executionId)
      if (firstPendingAt === undefined) this.pendingSince.set(execution.executionId, now)
      if (!decideStalePendingFallback({
        sessionEnded: true,
        startedAt: execution.startedAt,
        ...(liveness.lastActivity?.get(sessionId) === undefined ? {} : { lastActivityAt: liveness.lastActivity.get(sessionId) }),
        activityAdvanced: liveness.advancing?.has(sessionId) === true,
        ...(firstPendingAt === undefined ? {} : { firstPendingAt }),
        now,
      })) return
      const recheck = await this.runner.inspect(sessionId, execution.startedAt, {
        sessionEnded: true,
        ...(target === undefined ? {} : { target }),
      })
      if (recheck.outcome !== 'pending') {
        this.pendingSince.delete(execution.executionId)
        this.ledger.settle(execution.taskId, execution.executionId, recheck.outcome, 'error' in recheck ? recheck.error : undefined)
        return
      }
      this.pendingSince.delete(execution.executionId)
      this.ledger.settle(
        execution.taskId,
        execution.executionId,
        'interrupted',
        'execution session ended but its outcome stayed unresolvable (stale pending fallback)',
      )
    } catch {
      // A transient inspection failure never settles a running execution.
    }
  }

  private async tickSchedule(first: boolean): Promise<void> {
    if (this.disposed || !this.active) return
    const now = this.now()
    const recovered = first || (this.lastScheduleTick !== undefined && now - this.lastScheduleTick > RESUME_GAP_MS)
    this.lastScheduleTick = now
    this.ledger.setScheduler({ lastTickAt: now })
    if (recovered) {
      this.ledger.skipMissed(now)
      return
    }
    for (const schedule of this.ledger.dueSchedules(now)) {
      const next = nextRunAtMs(schedule.cron, schedule.nextRunAt)
      const opened = this.ledger.openScheduled(schedule.taskId, next, now)
      if (opened !== undefined) this.scheduleLaunch(opened)
    }
  }

  private armedSchedules(): number {
    return this.ledger.armedScheduleCount()
  }

  private scheduleLaunch(opened: OpenedRun): void {
    void this.launch(opened).catch(error => {
      console.error('[dsh-task-board] execution launch settlement failed', error)
    })
  }

  private schedulePoll(): void {
    if (this.pollInFlight || this.disposed) return
    this.pollInFlight = true
    void this.pollSessions().catch(error => {
      console.error('[dsh-task-board] session polling failed', error)
    }).finally(() => { this.pollInFlight = false })
  }

  private scheduleTick(first: boolean): void {
    if (this.tickInFlight || this.disposed) return
    this.tickInFlight = true
    void this.tickSchedule(first).catch(error => {
      console.error('[dsh-task-board] scheduler tick failed', error)
    }).finally(() => { this.tickInFlight = false })
  }

  private syncPowerReasons(): void {
    const current = this.power.snapshot()
    this.power.updateReasons({
      runningSessions: current.runningSessions,
      armedSchedules: this.armedSchedules(),
      sessionStateKnown: current.sessionStateKnown,
    })
    this.power.setEnabled(this.active && this.preventIdleSleep)
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
