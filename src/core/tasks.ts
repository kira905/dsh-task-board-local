/**
 * Task board domain model: task lifecycle statuses, the task record shape,
 * and the pure transition functions the controller and tests share.
 * Framework-free (no cordis, no runtime imports) so the state machine is
 * unit-testable in isolation.
 */

/**
 * Task lifecycle status, one per kanban column.
 *
 * `review` is the human acceptance gate (local fork): a successful runner
 * settlement parks the card there instead of declaring it done, and only a
 * human confirm/reject moves it on.
 */
export type TaskStatus = 'backlog' | 'todo' | 'running' | 'review' | 'done' | 'failed'

/**
 * What kind of work a card represents; it drives settlement and scheduling.
 * - `once`: a single deliverable. Success parks in `review`; confirm → done.
 * - `recurring`: a cron-driven job. Success parks in `review`; confirm → todo
 *   so the card stays on the board waiting for its next trigger instead of
 *   ending up in done while cron keeps firing.
 * - `interactive`: work that needs the human in the driver's seat. It refuses
 *   a schedule, so cron never picks it up.
 */
export type TaskKind = 'once' | 'recurring' | 'interactive'

/** All valid task kinds (closed union guard). */
export const ALL_KINDS: readonly TaskKind[] = ['once', 'recurring', 'interactive']

/** Whether an unknown value is a known task kind. */
export function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === 'string' && (ALL_KINDS as readonly string[]).includes(value)
}

/**
 * One real execution attempt: the run's own id, the dsh session that ran it
 * (filled once the session is created), and the settled outcome once the
 * session's turn ended.
 */
export interface ExecutionRecord {
  /** Execution attempt id (uuid). */
  id: string
  /** The dsh session that ran this attempt; absent until creation resolves. */
  sessionId: string | undefined
  /** When the run started (ms epoch). */
  startedAt: number
  /** When the run settled; absent while still running. */
  endedAt: number | undefined
  /**
   * Outcome once settled. `interrupted` (card [Q3], 2026-09-11) marks an
   * attempt whose turn never completed — DSH restarted mid-run, the daemon was
   * killed, or the turn was aborted — so the card must never read as a success.
   */
  result: 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | undefined
  /** Human failure text when the run failed (prompt rejection or agent error). */
  error: string | undefined
}

/**
 * Maximum number of execution records retained per task. Older settled runs
 * are trimmed when a new execution starts so per-action ledger cost stays
 * bounded regardless of how often a task ran before.
 */
export const EXECUTION_HISTORY_LIMIT = 20

/**
 * Trim an execution list to at most {@link EXECUTION_HISTORY_LIMIT} records,
 * most recent last. A running (unsettled) execution is never trimmed: the
 * Host monitor and restart recovery depend on the active record, and a task
 * cannot start a new run while one is still open.
 */
export function retainRecentExecutions(executions: readonly ExecutionRecord[]): ExecutionRecord[] {
  if (executions.length <= EXECUTION_HISTORY_LIMIT) return [...executions]
  const open = executions.filter(execution => execution.endedAt === undefined)
  const settled = executions.filter(execution => execution.endedAt !== undefined)
  const keepSettled = Math.max(EXECUTION_HISTORY_LIMIT - open.length, 0)
  return [...settled.slice(Math.max(settled.length - keepSettled, 0)), ...open]
}

/**
 * A scheduled-run rule attached to a task. The Host scheduler triggers the
 * task when `nextRunAt` is due and persists the rule in the Host ledger.
 */
export interface ScheduleRule {
  /** Whether the schedule is armed. */
  enabled: boolean
  /** 5-field cron expression: `分 时 日 月 周`. */
  cron: string
  /** Next due instant (ms epoch); maintained by the scheduler/controller. */
  nextRunAt: number | undefined
  /** Instant of the latest scheduled trigger (ms epoch). */
  lastTriggeredAt: number | undefined
}

/** One task on the board. */
export interface TaskRecord {
  /** Stable task id (uuid). */
  id: string
  /** Short display title. */
  title: string
  /** Longer human description shown in the detail view. */
  description: string
  /** The prompt sent to dsh when this task is executed. */
  prompt: string
  /** Current column. */
  status: TaskStatus
  /** Creation instant (ms epoch). */
  createdAt: number
  /** Last mutation instant (ms epoch). */
  updatedAt: number
  /**
   * Execution history retained on the task, most recent last: the latest
   * {@link EXECUTION_HISTORY_LIMIT} attempts, oldest trimmed on append.
   */
  executions: ExecutionRecord[]
  /** Optional scheduled-run rule (absent on tasks without a schedule). */
  schedule?: ScheduleRule
  /**
   * What kind of work this card is (see {@link TaskKind}). Absent on ledger
   * rows written before the local fork; {@link taskKind} then infers
   * `recurring` for a scheduled card and `once` otherwise.
   */
  kind?: TaskKind
  /**
   * Workspace the execution must run in (a workspace-list id); absent means
   * the recent-workspace fallback at execution time.
   */
  workspaceId?: string
  /**
   * Agent preset the execution session must be composed from (an
   * `agentPreset.list` id); absent means the deployment default.
   */
  mode?: string
  /**
   * Permission preset applied to the execution session through the
   * `/permission <id>` slash command; absent leaves the session default.
   */
  permission?: TaskPermission
  /**
   * Main line (主线) this card belongs to, e.g. `Release pipeline · R3`. Free-form
   * and human-facing: the board groups and filters by this exact string, and a
   * name carrying a ` · ` separator reads as a two-level `line · sub-line`
   * label (filtering by the prefix matches every sub-line). Absent means the
   * card is not assigned to a line yet (未归线).
   */
  line?: string
  /**
   * Node position inside the line, e.g. `H0`, `[4]`, `P8-A`. Free-form; the
   * board sorts a line by the first number it contains so `H2` precedes `H10`.
   * Absent means the card carries no explicit sequence.
   */
  seq?: string
  /**
   * When the task was archived (ms epoch). Archived tasks keep their status
   * and execution history, leave the main board, and cannot run until restored;
   * absent means on-board.
   */
  archivedAt?: number
}

/** Statuses a settled task may be archived from. */
export const ARCHIVABLE_STATUSES: readonly TaskStatus[] = ['done', 'failed']


/** Permission presets a task may pin on its execution session (the `/permission <id>` ids). */
export const TASK_PERMISSIONS = ['read-only', 'workspace-write', 'danger-full-access'] as const

/** One permission preset id. */
export type TaskPermission = typeof TASK_PERMISSIONS[number]

/** Whether an unknown value is a known permission preset id. */
export function isTaskPermission(value: unknown): value is TaskPermission {
  return typeof value === 'string' && (TASK_PERMISSIONS as readonly string[]).includes(value)
}

/** Input for creating a task. */
export interface NewTaskInput {
  title: string
  description: string
  prompt: string
  /** Workspace the execution must run in; empty/absent = the recent workspace. */
  workspaceId?: string
  /** Agent preset the execution session must be composed from; empty/absent = deployment default. */
  mode?: string
  /** Permission preset applied to the execution session; absent = session default. */
  permission?: TaskPermission
  /**
   * Kind of work (see {@link TaskKind}); absent = `once`, or `recurring` when
   * the creation request arms a schedule.
   */
  kind?: TaskKind
  /**
   * Optional scheduled-run rule requested at creation time (the new-task
   * dialog): an enable flag plus a 5-field cron expression. The create use
   * case arms it only when enabled and the expression is valid.
   */
  schedule?: { enabled: boolean; cron: string }
  /** Main line (主线) this card belongs to; empty/absent = 未归线. */
  line?: string
  /** Node position inside the line (e.g. `H0`); empty/absent = none. */
  seq?: string
}

/** The six kanban columns, in display order. */
export const COLUMNS: readonly { status: TaskStatus; label: string }[] = [
  { status: 'backlog', label: '待规划' },
  { status: 'todo', label: '待办' },
  { status: 'running', label: '进行中' },
  { status: 'review', label: '待验收' },
  { status: 'done', label: '已完成' },
  { status: 'failed', label: '已失败' },
]

/**
 * Statuses a user may move a card to manually. `done` is included so a human
 * can close an `interactive` card (which never runs through the acceptance
 * gate); the execution states `running`/`review` stay owned by the runner and
 * the confirm/reject actions.
 */
export const MANUAL_STATUSES: readonly TaskStatus[] = ['backlog', 'todo', 'done']

/** Statuses the runner may move a card to from 'running'. */
export const RUNNER_SETTLE_STATUSES: readonly TaskStatus[] = ['review', 'failed']

/** All valid statuses (closed union guard). */
export const ALL_STATUSES: readonly TaskStatus[] = [
  'backlog', 'todo', 'running', 'review', 'done', 'failed',
]

/** Brand an unknown string as a status; undefined when it is not one. */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (ALL_STATUSES as readonly string[]).includes(value)
}

/**
 * Whether a manual move target is allowed from the given status. The runner
 * owns `running`; a card parked in `review` may still be dragged (confirm and
 * reject are the primary path, a manual move is the escape hatch).
 */
export function canMoveManually(from: TaskStatus, to: TaskStatus): boolean {
  return from !== 'running' && (MANUAL_STATUSES as readonly TaskStatus[]).includes(to)
}

/** Normalize one optional execution-target string: trim; blank collapses to undefined. */
export function normalizeTargetId(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/** Create a task from user input. */
export function createTask(input: NewTaskInput, now: number, id: string): TaskRecord {
  return {
    id,
    title: input.title.trim(),
    description: input.description.trim(),
    prompt: input.prompt.trim(),
    status: 'todo',
    createdAt: now,
    updatedAt: now,
    executions: [],
    workspaceId: normalizeTargetId(input.workspaceId),
    mode: normalizeTargetId(input.mode),
    permission: isTaskPermission(input.permission) ? input.permission : undefined,
    kind: isTaskKind(input.kind) ? input.kind : input.schedule?.enabled === true ? 'recurring' : 'once',
    line: normalizeTargetId(input.line),
    seq: normalizeTargetId(input.seq),
  }
}

/** Clone a task with an updated status and a fresh updatedAt. */
export function withStatus(task: TaskRecord, status: TaskStatus, now: number): TaskRecord {
  return { ...task, status, updatedAt: now }
}

/**
 * Merge a schedule patch into a task's schedule rule (creating it when
 * absent), with a fresh updatedAt. Keys present in the patch overwrite the
 * current value — including explicit `undefined`, which clears a field (used
 * to disarm `nextRunAt`); absent keys keep their current value.
 */
export function withSchedule(
  task: TaskRecord,
  patch: Partial<ScheduleRule>,
  now: number,
): TaskRecord {
  const current = task.schedule
  const schedule: ScheduleRule = {
    enabled: current?.enabled ?? false,
    cron: current?.cron ?? '',
    nextRunAt: current?.nextRunAt,
    lastTriggeredAt: current?.lastTriggeredAt,
  }
  if ('enabled' in patch) schedule.enabled = patch.enabled ?? false
  if ('cron' in patch) schedule.cron = patch.cron ?? ''
  if ('nextRunAt' in patch) schedule.nextRunAt = patch.nextRunAt
  if ('lastTriggeredAt' in patch) schedule.lastTriggeredAt = patch.lastTriggeredAt
  return { ...task, updatedAt: now, schedule }
}

/**
 * Open a fresh execution on a task: move it to 'running' and append a
 * running execution record. Returns the new task and the new execution.
 */
export function startExecution(
  task: TaskRecord,
  now: number,
  executionId: string,
): { task: TaskRecord; execution: ExecutionRecord } {
  const execution: ExecutionRecord = {
    id: executionId,
    sessionId: undefined,
    startedAt: now,
    endedAt: undefined,
    result: undefined,
    error: undefined,
  }
  return {
    task: {
      ...task,
      status: 'running',
      updatedAt: now,
      executions: retainRecentExecutions([...task.executions, execution]),
    },
    execution,
  }
}

/**
 * Settle a running execution: record the outcome and move the task into the
 * matching column. A successful turn parks the card in `review` — the local
 * fork's human acceptance gate: "the session's turn ended" is not "the work is
 * done", so a human must confirm or reject. No-op (returns the input task)
 * when the execution is not the task's latest or is already settled.
 *
 * `interrupted` (card [Q3]) behaves like `cancelled`: the card returns to
 * `todo` with the interruption recorded on the execution, so a restart can
 * never park unfinished work in 待验收.
 */
export function settleExecution(
  task: TaskRecord,
  executionId: string,
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'interrupted',
  now: number,
  error: string | undefined,
): TaskRecord {
  const index = task.executions.findIndex(execution => execution.id === executionId)
  if (index === -1) return task
  const execution = task.executions[index]
  if (execution.endedAt !== undefined) return task
  const settled: ExecutionRecord = { ...execution, endedAt: now, result: outcome, error }
  const executions = [...task.executions]
  executions[index] = settled
  const status: TaskStatus = outcome === 'succeeded' ? 'review'
    : outcome === 'failed' ? 'failed'
      : task.status === 'running' ? 'todo' : task.status
  return { ...task, status, updatedAt: now, executions }
}

/**
 * The effective kind of a card: an explicit `kind` wins; a ledger row written
 * before the local fork infers `recurring` when it carries a schedule and
 * `once` otherwise.
 */
export function taskKind(task: TaskRecord): TaskKind {
  return isTaskKind(task.kind) ? task.kind : task.schedule !== undefined ? 'recurring' : 'once'
}

/** Whether the card is a cron-driven recurring job. */
export function isRecurringTask(task: TaskRecord): boolean {
  return taskKind(task) === 'recurring'
}

/** Whether the card requires a human in the driver's seat (it refuses a schedule). */
export function isInteractiveTask(task: TaskRecord): boolean {
  return taskKind(task) === 'interactive'
}

/**
 * The column a confirmed card lands in: a recurring job returns to `todo` so
 * it stays on the board for its next trigger; everything else is `done`.
 */
export function confirmedStatus(task: TaskRecord): TaskStatus {
  return isRecurringTask(task) ? 'todo' : 'done'
}

/** A settled-execution summary string for the detail view. */
export function executionLabel(execution: ExecutionRecord): string {
  if (execution.result === 'succeeded') return 'succeeded'
  if (execution.result === 'failed') return 'failed'
  if (execution.result === 'cancelled') return 'cancelled'
  if (execution.result === 'interrupted') return 'interrupted'
  return 'running'
}

/**
 * Distinct main lines (主线) across a ledger, sorted for stable pickers and
 * the line view. Unassigned cards are skipped: they surface as the board's
 * 未归线 bucket instead of becoming a group of their own.
 */
export function collectLines(tasks: readonly TaskRecord[]): string[] {
  const seen = new Set<string>()
  for (const task of tasks) {
    if (task.line !== undefined && task.line !== '') seen.add(task.line)
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh'))
}

/** The first integer embedded in a node label (`H10-x` → 10), or undefined. */
function firstNumber(label: string): number | undefined {
  const match = /\d+/.exec(label)
  return match === null ? undefined : Number.parseInt(match[0], 10)
}

/**
 * Order two node labels inside a line: the first embedded number decides, so
 * `H2` precedes `H10` and `[4]` precedes `[10]`. A label without any number
 * sorts after the numbered ones; ties fall back to a locale comparison.
 */
export function compareSeq(a: string | undefined, b: string | undefined): number {
  const left = a === undefined ? undefined : firstNumber(a)
  const right = b === undefined ? undefined : firstNumber(b)
  if (left !== undefined && right !== undefined && left !== right) return left - right
  if (left !== undefined && right === undefined) return -1
  if (left === undefined && right !== undefined) return 1
  return (a ?? '').localeCompare(b ?? '', 'zh')
}
