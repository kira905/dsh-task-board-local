import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { nextRunAtMs } from './core/schedule.ts'
import { HostTaskLedger, type OpenedRun, type OpenExecutionReference } from './host-ledger.ts'
import { HostExecutionRunner, SESSION_START_GRACE_MS, SessionLaunchError, isExecutionAlive, isStalePendingSettlement, type SessionCommandDispatcher } from './host-runner.ts'
import { PowerInhibitor } from './power-inhibitor.ts'
import type { TaskBoardAction, TaskBoardEventPayload, TaskBoardSnapshot } from './protocol.ts'

const SESSION_POLL_MS = 5_000
const SCHEDULE_TICK_MS = 30_000
const RESUME_GAP_MS = SCHEDULE_TICK_MS + 15_000

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
  private readonly now: () => number

  constructor(getApi: () => ApiProxy | null, options: {
    ledger?: HostTaskLedger
    power?: PowerInhibitor
    now?: () => number
    commandDispatcher?: SessionCommandDispatcher
  } = {}) {
    this.ledger = options.ledger ?? new HostTaskLedger()
    this.runner = new HostExecutionRunner(getApi, options.commandDispatcher)
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

  setConfiguration(active: boolean, preventIdleSleep: boolean): void {
    const resumed = !this.active && active
    this.active = active
    this.preventIdleSleep = preventIdleSleep
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

  snapshot(): TaskBoardSnapshot {
    const state = this.ledger.state()
    return {
      schemaVersion: 2,
      revision: state.revision,
      tasks: state.tasks,
      scheduler: state.scheduler,
      power: this.power.snapshot(),
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

  apply(requestId: string, action: TaskBoardAction): TaskBoardSnapshot {
    if (!this.active) throw new Error('task board is disabled')
    const result = this.ledger.applyRequest(requestId, action)
    if (result.run !== undefined) this.scheduleLaunch(result.run)
    return {
      schemaVersion: 2,
      revision: result.state.revision,
      tasks: result.state.tasks,
      scheduler: result.state.scheduler,
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
      const sessionId = await this.runner.launch(opened.task)
      this.ledger.attachSession(opened.task.id, opened.execution.id, sessionId)
    } catch (error) {
      if (error instanceof SessionLaunchError) {
        this.ledger.attachSession(opened.task.id, opened.execution.id, error.sessionId)
      }
      this.ledger.settle(opened.task.id, opened.execution.id, 'failed', error instanceof Error ? error.message : String(error))
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
    const liveness = await this.runner.listSessionLiveness()
    for (const execution of attached) {
      const sessionId = execution.sessionId as string
      const alive = isExecutionAlive(sessionId, liveness)
      if (!alive.determined) continue
      if (alive.alive) continue
      if (alive.reason === 'session-missing' && Date.now() - execution.startedAt < SESSION_START_GRACE_MS) continue
      try {
        const result = await this.runner.inspect(sessionId, execution.startedAt, { sessionEnded: true })
        if (result.outcome !== 'pending') {
          this.ledger.settle(execution.taskId, execution.executionId, result.outcome, 'error' in result ? result.error : undefined)
          continue
        }
        // 假 running 兜底（2026-09-14，卡 f0a9dd5e）：会话已被证明**不在跑**，inspect 却仍然
        // 判不出结果（超大会话/历史读不到/拿不到执行边界）。没有这条兜底，卡就永久停在
        // running：既不能人工移动（move 拒绝 running 卡），也永远堵着 P0 闸门。
        // 静默超过阈值 → 按 interrupted 结算，卡回 todo（可操作列），失败原因写在 execution 上。
        // 护栏不变：能走到这里的前提是 liveness 已判 alive=false（还在跑的会话在上面的
        // `if (alive.alive) continue` 就跳过了），列表读不到时 `alive.determined=false` 也跳过。
        if (isStalePendingSettlement({
          sessionEnded: true,
          startedAt: execution.startedAt,
          lastActivityAt: liveness.lastActivity?.get(sessionId),
          now: this.now(),
        })) {
          this.ledger.settle(
            execution.taskId,
            execution.executionId,
            'interrupted',
            'execution session ended but its outcome stayed unresolvable (stale pending fallback)',
          )
        }
      } catch {
        // A transient inspection failure never settles a running execution.
      }
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
