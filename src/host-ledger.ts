import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { dshHome } from './dsh-home.ts'
// R-065 删除/搬移三件套（锁6 · 批 E4）：唯一口在本插件内自足实现（插件实体不能静态 import tools/lib）。
import { gateDestructive } from './destructive-gate.ts'
// 2026-11-09 卡「账本写重试」：tmp → rename 统一走带退避重试的唯一口（EPERM/EACCES/EBUSY）。
import { isTmpPreserved, renameWithRetry } from './fs-atomic.ts'
import { isValidCron, nextRunAtMs } from './core/schedule.ts'
import { parseLedger } from './core/store.ts'
import { canMoveManually, confirmedStatus, isInteractiveTask, retainRecentExecutions, settleExecution, startExecution, withStatus, type ExecutionRecord, type TaskRecord } from './core/tasks.ts'
import { applyArchiveManyMove, applyArchiveMove, applyRestoreFromBatch, applyRestoreTask } from './core/use-cases/task-archive.ts'
import { applyCreateTask } from './core/use-cases/task-create.ts'
import { applyDeleteTask } from './core/use-cases/task-delete.ts'
import { applySetSchedule, applyScheduleNextRun } from './core/use-cases/task-schedule.ts'
import { applyUpdateTask, canEditDescription, canEditTaskIdentity, hasIdentityPatch } from './core/use-cases/task-update.ts'
import {
  applyArchiveCleanup as applyCleanupPlan,
  findArchiveBatch,
  findBatchIdForCard,
  makeBatchId,
  planArchiveCleanup as planCleanup,
  readArchiveIndex,
  readBatchCards,
  removeCardsFromBatch,
  summarizeArchive,
  writeArchiveBatch,
  type ArchiveBatchIndexEntry,
  type ArchiveCleanupPlan,
  type ArchiveCleanupResult,
  type ArchiveStageHook,
  type ArchiveStatusSummary,
} from './host-archive-store.ts'
import { appendQueueEvent } from './host-inbox.ts'
import { TASK_BOARD_SCHEMA_VERSION, type TaskBoardAction, type TaskBoardSchedulerSnapshot } from './protocol.ts'

interface PersistedScheduler extends TaskBoardSchedulerSnapshot {
  importedSources?: string[]
}

interface PersistedRequest {
  requestId: string
  fingerprint: string
}

interface LedgerDocument {
  schemaVersion: typeof TASK_BOARD_SCHEMA_VERSION
  revision: number
  tasks: TaskRecord[]
  scheduler: PersistedScheduler
  recentRequests: PersistedRequest[]
}

export interface LedgerState {
  revision: number
  tasks: TaskRecord[]
  scheduler: TaskBoardSchedulerSnapshot
}

export interface OpenedRun {
  task: TaskRecord
  execution: ExecutionRecord
}

/** Minimal value copy used by the Host session monitor. */
export interface OpenExecutionReference {
  readonly taskId: string
  readonly executionId: string
  readonly sessionId: string | undefined
  readonly startedAt: number
}

/** Minimal value copy used by the Host scheduler. */
export interface DueScheduleReference {
  readonly taskId: string
  readonly cron: string
  readonly nextRunAt: number
}

/** Derived runtime data for one session-poll pass. */
export interface LedgerRuntimeView {
  readonly armedSchedules: number
  readonly openExecutions: readonly OpenExecutionReference[]
}

const MAX_REQUEST_CACHE = 256

/** 启动恢复路径写进 `ExecutionRecord` 与事件信箱的同一个原因串（一处定义，别抄两遍）。 */
const INTERRUPTED_START_REASON = 'execution interrupted: host restarted before the execution session was recorded'

/**
 * Extra `scheduler` fields contributed by a load that VALIDATED.
 *
 * `scheduler.error` must describe the load that is happening now, and a load
 * that validated has nothing to report: whatever `parsed.scheduler.error` says
 * belongs to an earlier one. The persisted field used to be copied straight
 * through, so a single historical misjudgement — a ledger that was rejected
 * once and quarantined, e.g. during a cross-line upgrade — was replayed verbatim
 * by `GET /api/task-board/state` for ever, even after a healthy ledger replaced
 * it. A stale string is worse than no string: it hides the real state.
 *
 * Only a fresh quarantine may publish an error, and that message is produced by
 * the catch branch of `load()` (this load, this file, this reason). Errors that
 * are recomputed from current data — invalid cron rules — never pass through
 * here: `repairSchedules()` and the `import` action write them after the load,
 * in the same call stack as the constructor.
 *
 * @returns the fields to spread into the rebuilt scheduler: none, on a clean load.
 */
export function schedulerFieldsFromValidatedLoad(): { error?: string } {
  return {}
}

interface CachedRequest {
  fingerprint: string
}

function timeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local'
}

function cloneTasks(tasks: readonly TaskRecord[]): TaskRecord[] {
  return JSON.parse(JSON.stringify(tasks)) as TaskRecord[]
}

function hasOpenExecution(task: TaskRecord): boolean {
  return task.executions.some(execution => execution.endedAt === undefined)
}

/**
 * Process states that are dead but still occupy the PID table: `Z` (zombie)
 * and `X` (dead, being reaped). `process.kill(pid, 0)` reports such PIDs as
 * alive, so a crash leftover whose child was never reaped would otherwise be
 * mistaken for a live owner and block ledger startup forever.
 */
const DEAD_STATES = new Set(['Z', 'X'])

/**
 * Best-effort single-letter process state ('R','S','D','Z',...) or undefined
 * when no probe is available on this platform. Linux reads /proc/<pid>/stat
 * directly (no subprocess); other POSIX shells out to `ps -o stat=`; Windows
 * has no zombie state, so it returns undefined and the kill(0) probe alone
 * is authoritative there.
 */
export function processState(pid: number): string | undefined {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const end = stat.lastIndexOf(')')
      if (end === -1) return undefined
      return stat.slice(end + 2).split(' ')[0] || undefined
    } catch {
      return undefined // no such process (or unreadable)
    }
  }
  if (process.platform === 'win32') return undefined
  try {
    const probe = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { timeout: PROCESS_PROBE_TIMEOUT_MS })
    if (probe.status !== 0 || probe.stdout.length === 0) return undefined
    const state = probe.stdout.toString('utf8').trim()
    return state.length > 0 ? state[0] : undefined
  } catch {
    return undefined
  }
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  const state = processState(pid)
  if (state !== undefined && DEAD_STATES.has(state)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const PROCESS_PROBE_TIMEOUT_MS = 3000

let ownStartTime: number | undefined
let ownStartTimeResolved = false

/**
 * Exact process start time (Unix epoch ms) on Linux, read straight from
 * /proc (field 22 = start ticks since boot, btime = boot epoch seconds).
 * No subprocess and no rounding, so the recorded `startedAt` from a previous
 * boot compares exactly against the live process identity.
 */
function linuxStartTimeMs(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const end = stat.lastIndexOf(')')
    if (end === -1) return undefined
    const ticks = Number(stat.slice(end + 2).split(' ')[19])
    if (!Number.isFinite(ticks)) return undefined
    const bootMatch = /^btime\s+(\d+)/m.exec(readFileSync('/proc/stat', 'utf8'))
    if (bootMatch === null) return undefined
    const btime = Number(bootMatch[1])
    if (!Number.isFinite(btime)) return undefined
    return btime * 1000 + (ticks * 1000) / 100 // USER_HZ is 100 on Linux
  } catch {
    return undefined
  }
}

/**
 * Best-effort start time (Unix epoch ms) of a live process. Used to prove
 * whether the ledger lock really belongs to the PID recorded in it, so a
 * crash leftover whose PID was reused by an unrelated process (issue #786)
 * is detected as stale instead of blocking startup forever. Returns
 * undefined when the platform probe is unavailable; callers fail closed.
 */
function processStartTimeMs(pid: number): number | undefined {
  if (process.platform === 'linux') return linuxStartTimeMs(pid)
  if (process.platform === 'win32') {
    const probe = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        '[DateTimeOffset]::FromFileTime((Get-Process -Id ' + String(pid) + ' -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToFileTime()).ToUnixTimeMilliseconds()'],
      { timeout: PROCESS_PROBE_TIMEOUT_MS, windowsHide: true },
    )
    if (probe.status !== 0 || probe.stdout.length === 0) return undefined
    const started = Number(probe.stdout.toString('utf8').trim())
    return Number.isFinite(started) ? started : undefined
  }
  // Other POSIX (macOS...): ps lstart with a forced English locale, falling
  // back to the elapsed-seconds column when lstart cannot be parsed.
  const env = { ...process.env, LC_ALL: 'C' }
  const probe = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: PROCESS_PROBE_TIMEOUT_MS, env })
  if (probe.status === 0 && probe.stdout.length > 0) {
    const started = Date.parse(probe.stdout.toString('utf8').trim())
    if (Number.isFinite(started)) return started
  }
  const elapsed = spawnSync('ps', ['-o', 'etimes=', '-p', String(pid)], { timeout: PROCESS_PROBE_TIMEOUT_MS, env })
  if (elapsed.status !== 0 || elapsed.stdout.length === 0) return undefined
  const seconds = Number(elapsed.stdout.toString('utf8').trim())
  if (!Number.isFinite(seconds)) return undefined
  return Date.now() - seconds * 1000
}

function ownProcessStartTimeMs(): number | undefined {
  if (!ownStartTimeResolved) {
    ownStartTimeResolved = true
    ownStartTime = processStartTimeMs(process.pid)
  }
  return ownStartTime
}

/**
 * Bounded tolerance for legacy lock records. Locks written before the
 * ms-precise probe recorded `startedAt` from `ps -o lstart=` at whole-second
 * resolution; probing the SAME live process exactly (via /proc) then differs
 * in the sub-second remainder. Treating that as PID reuse would steal a live
 * owner's lock during a rolling upgrade and start a second ledger writer.
 * Records written by the ms-precise probe carry `probe: 'exact'` and are
 * compared strictly; anything else (older locks, second-granularity probes)
 * falls back to this bounded tolerance.
 */
const LEGACY_START_TOLERANCE_MS = 2000

/** Whether the recorded start time proves the recorded PID is another process. */
function startTimeMismatch(recorded: number, actual: number, exact: boolean): boolean {
  return exact ? recorded !== actual : Math.abs(recorded - actual) > LEGACY_START_TOLERANCE_MS
}

function betterExecution(a: ExecutionRecord, b: ExecutionRecord): ExecutionRecord {
  if (a.endedAt === undefined && b.endedAt !== undefined) return b
  if (b.endedAt === undefined && a.endedAt !== undefined) return a
  return (b.endedAt ?? b.startedAt) >= (a.endedAt ?? a.startedAt) ? b : a
}

function mergeTask(a: TaskRecord, b: TaskRecord): TaskRecord {
  // Existing Host state wins ties so an equally old browser backup cannot
  // roll authoritative fields back during multi-browser v1 migration.
  const newer = b.updatedAt > a.updatedAt ? b : a
  const byId = new Map<string, ExecutionRecord>()
  for (const entry of [...a.executions, ...b.executions]) {
    const previous = byId.get(entry.id)
    byId.set(entry.id, previous === undefined ? entry : betterExecution(previous, entry))
  }
  const executions = [...byId.values()].sort((x, y) => x.startedAt - y.startedAt)
  return { ...newer, executions: retainRecentExecutions(executions) }
}

function parseHostTasks(values: readonly unknown[]): TaskRecord[] {
  const rawById = new Map<string, Record<string, unknown>>()
  for (const value of values) {
    if (typeof value !== 'object' || value === null) continue
    const raw = value as Record<string, unknown>
    if (typeof raw.id === 'string') rawById.set(raw.id, raw)
  }
  return parseLedger(JSON.stringify(values)).map(task => {
    const rawSchedule = rawById.get(task.id)?.schedule
    if (typeof rawSchedule !== 'object' || rawSchedule === null) return task
    const schedule = rawSchedule as Record<string, unknown>
    if (typeof schedule.cron !== 'string' || isValidCron(schedule.cron)) return task
    return {
      ...task,
      schedule: {
        enabled: false,
        cron: schedule.cron,
        nextRunAt: undefined,
        lastTriggeredAt: typeof schedule.lastTriggeredAt === 'number' && Number.isFinite(schedule.lastTriggeredAt)
          ? schedule.lastTriggeredAt
          : undefined,
      },
    }
  })
}

/**
 * Construction options for card [看板瘦身·K1].
 *
 * `archiveStageHook` is a TEST seam: the fixed write order of an archive batch
 * (方案 §3 D-2) has to be interrupted between its steps to prove the crash
 * story (J11), and a crash drill needs a place to die that is not a `catch`
 * block in production code. Production never passes it.
 */
export interface HostTaskLedgerOptions {
  archiveStageHook?: ArchiveStageHook
}

export class HostTaskLedger {
  private document: LedgerDocument
  private readonly listeners = new Set<() => void>()
  private readonly requestCache = new Map<string, CachedRequest>()
  private readonly lockToken = crypto.randomUUID()
  private lockFd: number | undefined
  /** Board directory: the archive store hangs off it (方案 §3 D-1). */
  private readonly boardDir: string
  /** Host name stamped into every batch manifest, so a synced batch says where it came from. */
  private readonly archiveHost: string
  private readonly archiveStageHook: ArchiveStageHook | undefined
  readonly file: string
  readonly lockFile: string
  /** Small sidecar for the 30 s scheduler heartbeat (lastTickAt only). */
  readonly schedulerFile: string

  constructor(
    dir: string = join(dshHome(), 'task-board'),
    private readonly now: () => number = Date.now,
    options: HostTaskLedgerOptions = {},
  ) {
    mkdirSync(dir, { recursive: true })
    this.boardDir = dir
    this.archiveHost = hostname()
    this.archiveStageHook = options.archiveStageHook
    this.file = join(dir, 'ledger-v2.json')
    this.lockFile = join(dir, 'ledger-v2.lock')
    this.schedulerFile = join(dir, 'scheduler-v2.json')
    this.lockFd = this.acquireLock()
    try {
      this.document = this.load(dir)
      for (const request of this.document.recentRequests) {
        this.requestCache.set(request.requestId, { fingerprint: request.fingerprint })
      }
      this.repairSchedules(true)
      this.reconcileInterruptedStarts()
      // Persist a freshly generated ledger identity and any recovery error
      // immediately, even when there are no tasks to trigger a later action.
      this.commit(false)
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  /** Revision + scheduler without any task cloning; feeds the SSE event frame. */
  summary(): { revision: number; scheduler: TaskBoardSchedulerSnapshot } {
    const { importedSources: _imports, ...scheduler } = this.document.scheduler
    return { revision: this.document.revision, scheduler: { ...scheduler } }
  }

  state(): LedgerState {
    const { revision, scheduler } = this.summary()
    return { revision, tasks: cloneTasks(this.document.tasks), scheduler }
  }

  /**
   * Runtime-only projection for the 5 s Host poll. It copies just primitive
   * identifiers and timestamps, never the complete task/execution history or
   * an authoritative mutable object from the ledger.
   */
  runtimeView(): LedgerRuntimeView {
    let armedSchedules = 0
    const openExecutions: OpenExecutionReference[] = []
    for (const task of this.document.tasks) {
      if (task.archivedAt === undefined && task.schedule?.enabled === true) armedSchedules += 1
      for (const execution of task.executions) {
        if (execution.endedAt !== undefined) continue
        openExecutions.push({
          taskId: task.id,
          executionId: execution.id,
          sessionId: execution.sessionId,
          startedAt: execution.startedAt,
        })
      }
    }
    return { armedSchedules, openExecutions }
  }

  /** Count armed, non-archived schedules without cloning task histories. */
  armedScheduleCount(): number {
    let count = 0
    for (const task of this.document.tasks) {
      if (task.archivedAt === undefined && task.schedule?.enabled === true) count += 1
    }
    return count
  }

  /** Return value-only references for schedules due at the supplied Host time. */
  dueSchedules(now: number): DueScheduleReference[] {
    const due: DueScheduleReference[] = []
    for (const task of this.document.tasks) {
      if (task.archivedAt !== undefined) continue
      // Belt and braces with the set-schedule refusal: an interactive card is
      // never handed to the cron runner even if a legacy ledger row carries a
      // stale enabled rule.
      if (isInteractiveTask(task)) continue
      const schedule = task.schedule
      if (schedule === undefined || !schedule.enabled || schedule.nextRunAt === undefined || schedule.nextRunAt > now) continue
      due.push({ taskId: task.id, cron: schedule.cron, nextRunAt: schedule.nextRunAt })
    }
    return due
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    const fd = this.lockFd
    if (fd === undefined) return
    this.lockFd = undefined
    closeSync(fd)
    try {
      const owner = JSON.parse(readFileSync(this.lockFile, 'utf8')) as { token?: unknown }
      if (owner.token === this.lockToken) gateDestructive({ targets: [{ path: this.lockFile, label: 'ledger lock' }], whitelist: [dirname(this.lockFile)], op: '删', reason: '释放账本锁（token 匹配）', action: () => unlinkSync(this.lockFile) })
    } catch {
      // A missing or externally replaced lock must not be removed blindly.
    }
  }

  /**
   * Read-only archive summary (batches / cards / bytes / damaged directories).
   * Card [看板瘦身·K1]: feeds the board panel and the CLI.
   */
  archiveStatus(): ArchiveStatusSummary {
    return summarizeArchive(this.boardDir)
  }

  /**
   * Batch rows of `archive-index.json`, in batch order (方案 §3 D-4).
   *
   * `readArchiveIndex` is the cache-with-rebuild reader built in K1: a missing
   * or stale index is rewritten from the manifests rather than trusted, so a
   * broken cache can never hide a batch from a reader.
   */
  archiveBatches(): ArchiveBatchIndexEntry[] {
    return readArchiveIndex(this.boardDir).batches
  }

  /**
   * Every archived card, batch by batch (方案 §3 D-10 option (a)).
   *
   * Read on demand, never cached: the batches are the archive, and a stale
   * in-memory copy would resurrect a card the user just deleted from a batch.
   */
  archivedCards(): TaskRecord[][] {
    return this.archiveBatches().map(entry => readBatchCards(this.boardDir, entry.batchId))
  }

  /** One batch's index row, or undefined when the batch does not exist. */
  batchEntry(batchId: string): ArchiveBatchIndexEntry | undefined {
    return findArchiveBatch(this.boardDir, batchId)
  }

  /** Cards stored in one batch (empty when the batch file is unreadable). */
  batchCards(batchId: string): TaskRecord[] {
    return readBatchCards(this.boardDir, batchId)
  }

  /**
   * Dry-run plan for the orphan-batch cleanup (方案 §3 D-2).
   *
   * An "orphan" is a batch whose cards are ALL still in the main ledger: the
   * batch files were written but the main-ledger commit never happened, which
   * is the only half-finished state the fixed write order can leave behind.
   * A batch whose cards are gone from the main ledger is healthy and is never
   * planned for removal. Nothing is written here — the default is a dry run.
   */
  planArchiveCleanup(): ArchiveCleanupPlan {
    return planCleanup(this.boardDir, new Set(this.document.tasks.map(task => task.id)))
  }

  /**
   * Execute a cleanup plan. Callers reach this only through an explicit
   * `--apply`; the plan itself is the dry run.
   * @param plan - defaults to a freshly computed {@link planArchiveCleanup}.
   */
  runArchiveCleanup(plan: ArchiveCleanupPlan = this.planArchiveCleanup()): ArchiveCleanupResult {
    return applyCleanupPlan(this.boardDir, plan, this.now())
  }

  /**
   * Physical half of an archive action (方案 §3 D-2).
   *
   * The batch is written FIRST (cards.json -> manifest.json -> index) and the
   * main ledger is only rewritten once every batch file is on disk, so no
   * instant exists in which a card is in neither place. A throw here leaves
   * `this.document.tasks` untouched, and the caller's commit never runs.
   * @returns the batch id that was created.
   */
  private persistArchiveBatch(
    remaining: readonly TaskRecord[],
    moved: readonly TaskRecord[],
    tool: string,
    now: number,
  ): string {
    if (moved.length === 0) throw new Error('no task can be archived')
    const batchId = makeBatchId(tool === 'archive-compact' ? 'compact' : 'archive', now, this.boardDir)
    writeArchiveBatch(this.boardDir, {
      batchId,
      at: now,
      tasks: moved,
      fromRevision: this.document.revision,
      tool,
      host: this.archiveHost,
      ...(this.archiveStageHook === undefined ? {} : { onStage: this.archiveStageHook }),
    })
    this.document.tasks = [...remaining]
    return batchId
  }

  applyRequest(requestId: string, action: TaskBoardAction): { state: LedgerState; run?: OpenedRun } {
    const fingerprint = createHash('sha256').update(JSON.stringify(action)).digest('hex')
    const cached = this.requestCache.get(requestId)
    if (cached !== undefined) {
      if (cached.fingerprint !== fingerprint) throw new Error('request id was reused with a different action')
      return { state: this.state() }
    }

    // Add the fingerprint before apply(): successful actions persist it in the
    // same atomic ledger write as their state transition.
    this.requestCache.set(requestId, { fingerprint })
    while (this.requestCache.size > MAX_REQUEST_CACHE) this.requestCache.delete(this.requestCache.keys().next().value as string)
    this.syncRecentRequests()
    try {
      return this.apply(action)
    } catch (error) {
      this.requestCache.delete(requestId)
      this.syncRecentRequests()
      throw error
    }
  }

  openScheduled(taskId: string, nextRunAt: number | undefined, triggeredAt: number): OpenedRun | undefined {
    const task = this.document.tasks.find(item => item.id === taskId)
    if (task === undefined || task.archivedAt !== undefined) return undefined
    if (isInteractiveTask(task)) return undefined
    if (task.status === 'running' || hasOpenExecution(task)) {
      this.document.tasks = [...applyScheduleNextRun(this.document.tasks, taskId, nextRunAt, task.schedule?.lastTriggeredAt, triggeredAt)]
      this.commit()
      return undefined
    }
    const opened = startExecution(task, triggeredAt, crypto.randomUUID())
    this.document.tasks = this.document.tasks.map(item => item.id === taskId ? opened.task : item)
    this.document.tasks = [...applyScheduleNextRun(this.document.tasks, taskId, nextRunAt, triggeredAt, triggeredAt)]
    this.commit()
    return opened
  }

  skipMissed(now: number): void {
    let changed = false
    this.document.tasks = this.document.tasks.map(task => {
      const schedule = task.schedule
      if (schedule === undefined || !schedule.enabled || schedule.nextRunAt === undefined || schedule.nextRunAt > now) return task
      changed = true
      return { ...task, schedule: { ...schedule, nextRunAt: nextRunAtMs(schedule.cron, now) }, updatedAt: now }
    })
    if (changed) this.commit()
  }

  setScheduler(patch: Partial<TaskBoardSchedulerSnapshot>): void {
    this.document.scheduler = { ...this.document.scheduler, ...patch }
    // The 30 s heartbeat only moves lastTickAt; rewriting the whole ledger
    // for it made idle idle cost O(ledger bytes) every tick. Persist it to a
    // tiny sidecar instead; any other patch still goes through the full
    // atomic commit.
    if (patch.lastTickAt !== undefined && Object.keys(patch).every(key => key === 'lastTickAt')) {
      this.writeSchedulerSidecar()
      return
    }
    this.commit(false)
  }

  attachSession(taskId: string, executionId: string, sessionId: string): void {
    const now = this.now()
    this.document.tasks = this.document.tasks.map(task => task.id !== taskId ? task : {
      ...task,
      updatedAt: now,
      executions: task.executions.map(entry => entry.id === executionId ? { ...entry, sessionId } : entry),
    })
    this.commit()
  }

  settle(taskId: string, executionId: string, outcome: 'succeeded' | 'failed' | 'cancelled' | 'interrupted', error?: string): void {
    const now = this.now()
    // 只有「这条执行记录此刻还是 open」才算一次**真结算**（`settleExecution` 对未知 id /
    // 已结束的记录是 no-op）—— 事件必须跟着真实的状态变化走，别为一次空调用记一行假账。
    const open = this.document.tasks
      .find(task => task.id === taskId)?.executions
      .find(execution => execution.id === executionId)
    const settles = open !== undefined && open.endedAt === undefined
    this.document.tasks = this.document.tasks.map(task => task.id === taskId
      ? settleExecution(task, executionId, outcome, now, error)
      : task)
    this.commit()
    // 事件信箱（Q2 协议 v1）：结算是"这张卡真的走完一次执行"的唯一时刻，
    // 就在这里记一行给队列消费端（`dsh-butler` → `queue-watch.mjs consumeInbox`）。
    // 位置必须在 commit 之后（账本是真源），失败**不影响结算**（只留一行 stderr）。
    if (!settles) return
    const settled = this.document.tasks.find(task => task.id === taskId)
    if (settled !== undefined) {
      this.publishSettleEvent({ taskId: settled.id, status: settled.status, executionId, outcome, error }, now)
    }
  }

  /**
   * 结算事件写出（Q2 协议 v1 生产端）。**永不 throw**：成功返回 null，
   * 失败返回消息由调用方 `console.error` 留痕 —— 卡的状态已提交，事件丢了也不能反向弄坏它。
   *
   * `now` 必须**用调用方那次结算的同一时刻**（不是墙钟）：消费端把 `at` 当"真实结算时刻"
   * 做滞留基线，两者对不上就等于把基线写歪。
   */
  private publishSettleEvent(event: { taskId: string; status: string; executionId: string; outcome: string; error?: string | undefined }, now: number): void {
    const failure = appendQueueEvent(dirname(this.boardDir), {
      taskId: event.taskId,
      kind: 'settled',
      status: event.status,
      executionId: event.executionId,
      outcome: event.outcome,
      error: event.error,
    }, now)
    if (failure !== null) {
      console.error(`[dsh-task-board][inbox] queue-events.jsonl 写入失败（task=${event.taskId} · execution=${event.executionId}）：${failure}`)
    }
  }

  private apply(action: TaskBoardAction): { state: LedgerState; run?: OpenedRun } {
    const now = this.now()
    let run: OpenedRun | undefined
    // Deferred second half of a restore (方案 §3 D-3): the main ledger has to be
    // committed BEFORE the batch copy is dropped, so a crash in between leaves a
    // redundant batch copy (which the cleanup reports) instead of a card that
    // exists nowhere.
    let afterCommit: (() => void) | undefined
    switch (action.kind) {
      case 'import': {
        const sources = new Set(this.document.scheduler.importedSources ?? [])
        if (sources.has(action.sourceId)) return { state: this.state() }
        const invalidScheduleIds = action.tasks
          .filter(task => task.schedule !== undefined && !isValidCron(task.schedule.cron))
          .map(task => task.id)
        const incoming = parseHostTasks(action.tasks)
        const merged = new Map(this.document.tasks.map(task => [task.id, task]))
        for (const task of incoming) merged.set(task.id, merged.has(task.id) ? mergeTask(merged.get(task.id)!, task) : task)
        this.document.tasks = [...merged.values()]
        this.document.scheduler.importedSources = [...sources, action.sourceId]
        this.document.scheduler.error = invalidScheduleIds.length === 0
          ? undefined
          : `invalid cron disabled for task(s): ${invalidScheduleIds.join(', ')}`
        this.repairSchedules(true, false)
        this.reconcileInterruptedStarts(false)
        break
      }
      case 'create': {
        if (this.document.tasks.some(task => task.id === action.id)) throw new Error('task id already exists')
        if (action.input.schedule?.enabled === true && (!isValidCron(action.input.schedule.cron) || nextRunAtMs(action.input.schedule.cron, now) === undefined)) {
          throw new Error('invalid schedule')
        }
        const result = applyCreateTask(this.document.tasks, action.input, now, action.id)
        if (result.task === undefined) throw new Error('invalid task')
        this.document.tasks = [...result.tasks]
        break
      }
      case 'update': {
        const task = this.document.tasks.find(task => task.id === action.taskId)
        if (task === undefined) throw new Error('task not found')
        if (task.archivedAt !== undefined) throw new Error('archived task is read-only')
        // title/prompt are the record of what actually ran: once an execution
        // started they must not change. `description` doubles as the human
        // note field and stays editable on any on-board card (local fork).
        if (hasIdentityPatch(action.patch) && !canEditTaskIdentity(task)) {
          throw new Error('task has already been executed')
        }
        if ('description' in action.patch && !canEditDescription(task)) {
          throw new Error('archived task is read-only')
        }
        if ('title' in action.patch && action.patch.title?.trim() === '') throw new Error('title is required')
        this.document.tasks = [...applyUpdateTask(this.document.tasks, action.taskId, action.patch, now)]
        break
      }
      case 'confirm': {
        const task = this.document.tasks.find(item => item.id === action.taskId)
        if (task === undefined) throw new Error('task not found')
        if (task.archivedAt !== undefined) throw new Error('archived task is read-only')
        if (task.status !== 'review') throw new Error('task is not awaiting acceptance')
        // A recurring job returns to todo so it keeps waiting for its next
        // trigger; everything else is accepted as done.
        const next = confirmedStatus(task)
        this.document.tasks = this.document.tasks.map(item => item.id === action.taskId ? withStatus(item, next, now) : item)
        break
      }
      case 'reject': {
        const task = this.document.tasks.find(item => item.id === action.taskId)
        if (task === undefined) throw new Error('task not found')
        if (task.archivedAt !== undefined) throw new Error('archived task is read-only')
        if (task.status !== 'review') throw new Error('task is not awaiting acceptance')
        const note = action.note?.trim()
        this.document.tasks = this.document.tasks.map(item => {
          if (item.id !== action.taskId) return item
          const moved = withStatus(item, 'todo', now)
          // The rejection note is appended to the description: the card keeps
          // a visible record of why it came back.
          return note === undefined || note === ''
            ? moved
            : { ...moved, description: moved.description === '' ? note : `${moved.description}\n\n[打回 ${new Date(now).toLocaleString('zh-CN')}] ${note}` }
        })
        break
      }
      case 'delete':
        {
          const task = this.document.tasks.find(task => task.id === action.taskId)
          if (task === undefined) {
            // Card [看板瘦身·K2] (the gap K1 §1.2 handed over): after the physical
            // archive migration an archived card is not in the main ledger, so
            // the plain `task not found` below turned the archive page's delete
            // button into a dead end. Delete means the same thing wherever the
            // card lives — remove it from its batch.
            const batchId = findBatchIdForCard(this.boardDir, action.taskId)
            const card = batchId === undefined
              ? undefined
              : readBatchCards(this.boardDir, batchId).find(item => item.id === action.taskId)
            if (batchId === undefined || card === undefined) throw new Error('task not found')
            if (card.status === 'running' || hasOpenExecution(card)) throw new Error('running task cannot be deleted')
            // Dropped only after the (unchanged) main ledger commits, matching
            // the restore ordering: a failure here leaves the card redundant,
            // never lost, and the error still reaches the caller.
            afterCommit = () => { removeCardsFromBatch(this.boardDir, batchId, [card.id], now) }
            break
          }
          if (task.status === 'running' || hasOpenExecution(task)) throw new Error('running task cannot be deleted')
        }
        this.document.tasks = [...applyDeleteTask(this.document.tasks, undefined, action.taskId).tasks]
        break
      case 'move': {
        const task = this.document.tasks.find(item => item.id === action.taskId)
        if (task === undefined) throw new Error('task not found')
        if (task.archivedAt !== undefined) throw new Error('archived task is read-only')
        if (task.status === 'running' || hasOpenExecution(task)) throw new Error('running task cannot be moved')
        if (!canMoveManually(task.status, action.status)) throw new Error('invalid manual status')
        this.document.tasks = this.document.tasks.map(item => item.id === action.taskId ? withStatus(item, action.status, now) : item)
        break
      }
      case 'archive': {
        // Card [看板瘦身·K1]: archiving is a physical move (方案 §3 D-2). The
        // stamping rules are unchanged; the card simply leaves the main ledger
        // for `archive/<batchId>/cards.json`.
        const result = applyArchiveMove(this.document.tasks, action.taskId, now)
        if (!result.archived) throw new Error('task cannot be archived')
        this.persistArchiveBatch(result.tasks, result.moved, 'archive', now)
        break
      }
      case 'archive-many': {
        // Same rules as the single-card path, but one pass and one commit for
        // the whole batch. Cards that are unknown / already archived / not
        // settled are skipped instead of failing the batch; a card that was
        // already moved into a batch is therefore a no-op (方案 §6 表 4).
        const result = applyArchiveManyMove(this.document.tasks, action.taskIds, now)
        if (!result.archived) throw new Error('no task can be archived')
        this.persistArchiveBatch(result.tasks, result.moved, 'archive-many', now)
        break
      }
      case 'archive-compact': {
        // 方案 §3 D-5: one-time migration of every card still carrying the
        // legacy in-ledger `archivedAt` marker into one batch, in board order.
        // An empty batch is REFUSED — that refusal is also the idempotency
        // short-circuit of a second run (方案 §6 表 4).
        const archived = this.document.tasks.filter(task => task.archivedAt !== undefined)
        if (archived.length === 0) throw new Error('no archived task to compact')
        const remaining = this.document.tasks.filter(task => task.archivedAt === undefined)
        this.persistArchiveBatch(remaining, archived, 'archive-compact', now)
        break
      }
      case 'restore': {
        const inLedger = this.document.tasks.find(task => task.id === action.taskId)
        if (inLedger !== undefined && inLedger.archivedAt === undefined) {
          // Idempotency (方案 §6 表 4): the card is already back on the board.
          return { state: this.state() }
        }
        if (inLedger !== undefined) {
          // Legacy in-ledger marker (data written before the physical move):
          // clear it in place, exactly as before this card.
          const result = applyRestoreTask(this.document.tasks, action.taskId, now)
          if (!result.archived) throw new Error('task is not archived')
          this.document.tasks = [...result.tasks]
          break
        }
        // The card lives in a batch: locate it through the index's `ids[]`
        // instead of scanning every batch file (方案 §7 环 C ②).
        const batchId = findBatchIdForCard(this.boardDir, action.taskId)
        const card = batchId === undefined
          ? undefined
          : readBatchCards(this.boardDir, batchId).find(item => item.id === action.taskId)
        if (batchId === undefined || card === undefined) throw new Error('task is not archived')
        this.document.tasks = [...this.document.tasks, applyRestoreFromBatch(card)]
        afterCommit = () => { removeCardsFromBatch(this.boardDir, batchId, [card.id], now) }
        break
      }
      case 'restore-many': {
        // 方案 §3 D-3: move a whole batch back. Cards already on the board are
        // left alone, and a batch with nothing left to restore is a pure no-op
        // so a repeated call cannot bump the revision (方案 §5 J6).
        const batch = findArchiveBatch(this.boardDir, action.batchId)
        if (batch === undefined) throw new Error('archive batch not found')
        const present = new Set(this.document.tasks.map(task => task.id))
        const missing = readBatchCards(this.boardDir, action.batchId).filter(card => !present.has(card.id))
        if (missing.length === 0) return { state: this.state() }
        this.document.tasks = [...this.document.tasks, ...missing.map(card => applyRestoreFromBatch(card))]
        afterCommit = () => {
          removeCardsFromBatch(this.boardDir, action.batchId, missing.map(card => card.id), now)
        }
        break
      }
      case 'set-schedule': {
        const task = this.document.tasks.find(task => task.id === action.taskId)
        if (task?.archivedAt !== undefined) throw new Error('archived task is read-only')
        // An interactive card needs a human in the driver's seat: it refuses a
        // schedule outright so cron can never run it unattended.
        if (task !== undefined && isInteractiveTask(task) && action.patch.enabled !== false) {
          throw new Error('interactive task cannot be scheduled')
        }
        const result = applySetSchedule(this.document.tasks, action.taskId, action.patch, now)
        if (!result.applied) throw new Error('invalid schedule')
        this.document.tasks = [...result.tasks]
        break
      }
      case 'rerun':
      case 'run': {
        const task = this.document.tasks.find(item => item.id === action.taskId)
        if (task?.archivedAt !== undefined) throw new Error('archived task is read-only')
        if (task === undefined || task.status === 'running' || hasOpenExecution(task)) throw new Error('task is already running or missing')
        const base = action.kind === 'rerun' ? withStatus(task, 'todo', now) : task
        run = startExecution(base, now, crypto.randomUUID(), action.requester)
        this.document.tasks = this.document.tasks.map(item => item.id === task.id ? run!.task : item)
        break
      }
    }
    this.commit()
    // Runs only after the main-ledger commit succeeded: a restore drops the
    // batch copy last, so a crash here leaves redundancy, never loss.
    if (afterCommit !== undefined) afterCommit()
    return { state: this.state(), ...(run === undefined ? {} : { run }) }
  }

  private repairSchedules(skipPast: boolean, persist = true): void {
    const now = this.now()
    let changed = false
    this.document.tasks = this.document.tasks.map(task => {
      const schedule = task.schedule
      if (schedule === undefined || !schedule.enabled) return task
      if (!skipPast && schedule.nextRunAt !== undefined) return task
      const next = nextRunAtMs(schedule.cron, now)
      if (next === undefined) {
        changed = true
        this.document.scheduler.error = `invalid cron disabled for task: ${task.id}`
        return { ...task, schedule: { ...schedule, enabled: false, nextRunAt: undefined }, updatedAt: now }
      }
      if (schedule.nextRunAt === next) return task
      changed = true
      return { ...task, schedule: { ...schedule, nextRunAt: next }, updatedAt: now }
    })
    if (changed && persist) this.commit()
  }

  /**
   * Startup half of the restart-recovery path (card [Q3]): an execution that
   * never got as far as recording its session was certainly cut off by the
   * restart, so it settles `interrupted` (never `succeeded`) and the card goes
   * back to `todo` with the reason on the execution.
   *
   * Executions that DO carry a session id are handled by the Host poll
   * (`HostTaskBoardService.reconcileExecutions`), which is asynchronous: the
   * session may still be alive in the new instance, so nothing may be settled
   * before its liveness is read.
   */
  private reconcileInterruptedStarts(persist = true): void {
    const now = this.now()
    const interrupted: { taskId: string; status: string; executionId: string }[] = []
    this.document.tasks = this.document.tasks.map(task => {
      if (task.status !== 'running') return task
      const execution = task.executions.at(-1)
      if (execution === undefined || execution.endedAt !== undefined || execution.sessionId !== undefined) return task
      const next = settleExecution(task, execution.id, 'interrupted', now, INTERRUPTED_START_REASON)
      interrupted.push({ taskId: task.id, status: next.status, executionId: execution.id })
      return next
    })
    if (interrupted.length === 0) return
    if (persist) this.commit()
    // 重启打断同样是一次真实结算 ⇒ 同样记一行（G3「整夜被打断」场景的事件来源）。
    for (const item of interrupted) {
      this.publishSettleEvent({ ...item, outcome: 'interrupted', error: INTERRUPTED_START_REASON }, now)
    }
  }

  private load(dir: string): LedgerDocument {
    const existed = existsSync(this.file)
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<LedgerDocument>
      if (parsed.schemaVersion !== TASK_BOARD_SCHEMA_VERSION || !Array.isArray(parsed.tasks)) throw new Error('unsupported ledger schema')
      const tasks = parseHostTasks(parsed.tasks).map(task => ({ ...task, executions: retainRecentExecutions(task.executions) }))
      const invalidScheduleIds = (parsed.tasks as unknown[]).flatMap(value => {
        if (typeof value !== 'object' || value === null) return []
        const row = value as { id?: unknown; schedule?: unknown }
        if (typeof row.schedule !== 'object' || row.schedule === null) return []
        const cron = (row.schedule as { cron?: unknown }).cron
        return typeof cron !== 'string' || !isValidCron(cron)
          ? [typeof row.id === 'string' ? row.id : 'unknown']
          : []
      })
      const documentLastTickAt = typeof parsed.scheduler?.lastTickAt === 'number' ? parsed.scheduler.lastTickAt : undefined
      const sidecarLastTickAt = this.readSchedulerSidecar()
      // A sidecar write can be newer than the last full commit (crash between
      // the two); lastTickAt only ever moves forward, so take the greater.
      const lastTickAt = sidecarLastTickAt === undefined || (documentLastTickAt !== undefined && documentLastTickAt >= sidecarLastTickAt)
        ? documentLastTickAt
        : sidecarLastTickAt
      return {
        schemaVersion: TASK_BOARD_SCHEMA_VERSION,
        revision: Number.isSafeInteger(parsed.revision) && (parsed.revision as number) >= 0 ? parsed.revision as number : 0,
        tasks,
        scheduler: {
          timeZone: timeZone(),
          ledgerId: typeof parsed.scheduler?.ledgerId === 'string' && parsed.scheduler.ledgerId !== '' ? parsed.scheduler.ledgerId : crypto.randomUUID(),
          ...(lastTickAt === undefined ? {} : { lastTickAt }),
          // Never `parsed.scheduler.error` (see the helper): a validated load
          // clears the stale value instead of replaying it.
          ...schedulerFieldsFromValidatedLoad(),
          ...(invalidScheduleIds.length > 0 ? { error: `invalid cron disabled for task(s): ${invalidScheduleIds.join(', ')}` } : {}),
          ...(Array.isArray(parsed.scheduler?.importedSources) ? { importedSources: parsed.scheduler.importedSources.filter(x => typeof x === 'string') } : {}),
        },
        recentRequests: Array.isArray(parsed.recentRequests)
          ? parsed.recentRequests.flatMap((entry) => {
              if (typeof entry !== 'object' || entry === null) return []
              const request = entry as { requestId?: unknown; fingerprint?: unknown }
              return typeof request.requestId === 'string' && request.requestId !== '' && typeof request.fingerprint === 'string'
                ? [{ requestId: request.requestId, fingerprint: request.fingerprint }]
                : []
            }).slice(-MAX_REQUEST_CACHE)
          : [],
      }
    } catch (error) {
      if (existed) {
        const corruptPath = `${this.file}.corrupt-${this.now()}-${process.pid}-${crypto.randomUUID()}`
        gateDestructive({ targets: [{ path: this.file, label: 'ledger file' }, { path: corruptPath, label: 'corrupt copy' }], whitelist: [dirname(this.file)], op: '搬移', reason: '账本损坏隔离（改名 .corrupt-*）', action: () => renameSync(this.file, corruptPath) })
      }
      mkdirSync(dir, { recursive: true })
      return {
        schemaVersion: TASK_BOARD_SCHEMA_VERSION,
        revision: 0,
        tasks: [],
        scheduler: { timeZone: timeZone(), ledgerId: crypto.randomUUID(), ...(existed ? { error: `corrupt ledger was quarantined: ${error instanceof Error ? error.message : String(error)}` } : {}) },
        recentRequests: [],
      }
    }
  }

  private syncRecentRequests(): void {
    this.document.recentRequests = [...this.requestCache].map(([requestId, request]) => ({
      requestId,
      fingerprint: request.fingerprint,
    }))
  }

  private readSchedulerSidecar(): number | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.schedulerFile, 'utf8')) as { lastTickAt?: unknown }
      return typeof parsed.lastTickAt === 'number' && Number.isFinite(parsed.lastTickAt) ? parsed.lastTickAt : undefined
    } catch {
      return undefined
    }
  }

  /** Atomic write of the scheduler heartbeat sidecar (0600, tmp + rename + fsync). */
  private writeSchedulerSidecar(): void {
    const payload = JSON.stringify({ lastTickAt: this.document.scheduler.lastTickAt })
    mkdirSync(dirname(this.schedulerFile), { recursive: true })
    const tmp = `${this.schedulerFile}.tmp-${process.pid}`
    let fd: number | undefined
    try {
      fd = openSync(tmp, 'w', 0o600)
      writeFileSync(fd, payload, { encoding: 'utf8' })
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      try { chmodSync(tmp, 0o600) } catch { /* Windows ACLs own access */ }
      gateDestructive({ targets: [{ path: tmp, label: 'scheduler tmp' }, { path: this.schedulerFile, label: 'scheduler file' }], whitelist: [dirname(this.schedulerFile)], op: '搬移', reason: '调度器状态原子写', action: () => renameWithRetry(tmp, this.schedulerFile) })
      try {
        const dirFd = openSync(dirname(this.schedulerFile), 'r')
        try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
      } catch {
        // Windows does not permit fsync on a directory handle; rename remains atomic.
      }
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      // 重试耗尽仍失败 ⇒ renameWithRetry 已把 tmp 按约定留下取证（并打了 stderr），这里别再删。
      if (!isTmpPreserved(error)) {
        try { gateDestructive({ targets: [{ path: tmp, label: 'state tmp' }], whitelist: [dirname(tmp)], op: '删', reason: '状态原子写失败回收 tmp', action: () => unlinkSync(tmp) }) } catch { /* best-effort temporary cleanup */ }
      }
      throw error
    }
    this.notify()
  }

  private commit(bumpRevision = true): void {
    if (bumpRevision) this.document.revision += 1
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp-${process.pid}`
    let fd: number | undefined
    try {
      fd = openSync(tmp, 'w', 0o600)
      writeFileSync(fd, JSON.stringify(this.document, null, 2), { encoding: 'utf8' })
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      try { chmodSync(tmp, 0o600) } catch { /* Windows ACLs own access */ }
      gateDestructive({ targets: [{ path: tmp, label: 'ledger tmp' }, { path: this.file, label: 'ledger file' }], whitelist: [dirname(this.file)], op: '搬移', reason: '账本提交（原子替换）', action: () => renameWithRetry(tmp, this.file) })
      try {
        const dirFd = openSync(dirname(this.file), 'r')
        try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
      } catch {
        // Windows does not permit fsync on a directory handle; rename remains atomic.
      }
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      // 重试耗尽仍失败 ⇒ tmp 留着取证（renameWithRetry 已打 stderr），别当普通失败清掉。
      if (!isTmpPreserved(error)) {
        try { gateDestructive({ targets: [{ path: tmp, label: 'state tmp' }], whitelist: [dirname(tmp)], op: '删', reason: '账本写失败回收 tmp', action: () => unlinkSync(tmp) }) } catch { /* best-effort temporary cleanup */ }
      }
      throw error
    }
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }

  private acquireLock(): number {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(this.lockFile, 'wx', 0o600)
        const startedAt = ownProcessStartTimeMs()
        // Linux /proc and Windows PowerShell probes are ms-precise; locks they
        // write are compared strictly. Other POSIX probes (ps) stay
        // second-granularity, so their records are compared with the bounded
        // legacy tolerance.
        const probe = process.platform === 'linux' || process.platform === 'win32' ? 'exact' : 'legacy'
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.lockToken, startedAt, probe }), { encoding: 'utf8' })
        fsyncSync(fd)
        try { chmodSync(this.lockFile, 0o600) } catch { /* Windows ACLs own access */ }
        return fd
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw error
        let pid: number | undefined
        let ownerStartedAt: number | undefined
        let ownerExact = false
        try {
          const owner = JSON.parse(readFileSync(this.lockFile, 'utf8')) as { pid?: unknown; startedAt?: unknown; probe?: unknown }
          if (typeof owner.pid === 'number') pid = owner.pid
          if (typeof owner.startedAt === 'number') ownerStartedAt = owner.startedAt
          ownerExact = owner.probe === 'exact'
        } catch {
          // A power-loss mid-write can leave a truncated lock; the same event
          // killed the writer, so fail closed but explain the recovery.
          throw new Error(`task-board ledger lock is unreadable: ${this.lockFile}; if this is a leftover from an unclean shutdown and no other DSH host is running, remove it manually and retry`)
        }
        if (pid !== undefined && processIsAlive(pid)) {
          const actualStartedAt = pid === process.pid ? ownProcessStartTimeMs() : processStartTimeMs(pid)
          // A reused PID is exposed when the live process identity no longer
          // matches the recorded one: either the recorded start time differs
          // beyond the probe's resolution (strict for ms-precise 'exact'
          // records, a bounded legacy tolerance for old second-granularity
          // records written by ps), or (legacy locks without a start time)
          // the lock file predates the live process and therefore cannot
          // have been written by it. Takeover is safe in both cases — the
          // original owner is gone.
          const staleReuse = actualStartedAt !== undefined && (
            ownerStartedAt !== undefined
              ? startTimeMismatch(ownerStartedAt, actualStartedAt, ownerExact)
              : (() => {
                try { return statSync(this.lockFile).mtimeMs < actualStartedAt } catch { return true }
              })()
          )
          if (!staleReuse) {
            const confirmedOwner = ownerStartedAt !== undefined && actualStartedAt !== undefined && !startTimeMismatch(ownerStartedAt, actualStartedAt, ownerExact)
            const hint = confirmedOwner
              ? ''
              : `; if this PID was reused after a crash and no other DSH host is running, remove ${this.lockFile} manually and retry`
            throw new Error(`task-board ledger is already owned by process ${pid}${hint}`)
          }
        }
        try { gateDestructive({ targets: [{ path: this.lockFile, label: 'ledger lock' }], whitelist: [dirname(this.lockFile)], op: '删', reason: '抢占陈旧账本锁', action: () => unlinkSync(this.lockFile) }) } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
        }
      }
    }
    throw new Error(`task-board ledger lock could not be acquired: ${this.lockFile}`)
  }
}
