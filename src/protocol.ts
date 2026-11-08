import { isValidArchiveBatchId } from './core/archive-id.ts'
import type { TaskUpdatePatch } from './core/use-cases/task-update.ts'
import { isTaskKind, isTaskPermission, isTaskStatus, type NewTaskInput, type TaskRecord, type TaskStatus } from './core/tasks.ts'
import { parseLedger } from './core/store.ts'

export const TASK_BOARD_SCHEMA_VERSION = 2 as const
export const TASK_BOARD_API_PREFIX = '/api/task-board'

export type PowerPhase = 'disabled' | 'idle' | 'acquiring' | 'active' | 'error' | 'unsupported'

export interface TaskBoardPowerSnapshot {
  platform: string
  phase: PowerPhase
  enabled: boolean
  runningSessions: number
  armedSchedules: number
  sessionStateKnown: boolean
  lastError?: string
}

export interface TaskBoardSchedulerSnapshot {
  timeZone: string
  /** Opaque identity of the current Host ledger generation. */
  ledgerId?: string
  lastTickAt?: number
  error?: string
}

export interface TaskBoardSnapshot {
  schemaVersion: typeof TASK_BOARD_SCHEMA_VERSION
  revision: number
  tasks: TaskRecord[]
  scheduler: TaskBoardSchedulerSnapshot
  power: TaskBoardPowerSnapshot
}

/** SSE event frame: revision/scheduler/power only, never the task list. */
export interface TaskBoardEventPayload {
  revision: number
  scheduler: TaskBoardSchedulerSnapshot
  power: TaskBoardPowerSnapshot
}

/**
 * One batched archive row as `GET /archive` reports it (方案 §3 D-4).
 *
 * Carries `ids[]` (the by-card lookup written by K1) on purpose: a reader can
 * then prove its paged walk of `GET /archive/<batchId>` was complete and
 * duplicate-free (方案 §5 J8) without re-reading the batch file.
 */
export interface TaskBoardArchiveBatchSummary {
  batchId: string
  at: number
  count: number
  bytes: number
  path: string
  ids?: string[]
  /** Set once every card of the batch has been restored (files are kept). */
  restoredAt?: number
}

/** `GET /archive` page: batches plus board-wide reconciliation totals. */
export interface TaskBoardArchiveIndexPage {
  schemaVersion: 1
  revision: number
  batches: TaskBoardArchiveBatchSummary[]
  totals: { batches: number; cards: number }
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

/** `GET /archive/<batchId>` page: cards of one batch. */
export interface TaskBoardArchiveCardsPage {
  schemaVersion: 1
  batchId: string
  batch: TaskBoardArchiveBatchSummary
  cards: TaskRecord[]
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

/** Paging arguments accepted by the archive read routes. */
export interface TaskBoardArchivePageQuery {
  /** Page size; the server clamps it to 100 (方案 §5 J8). */
  limit?: number
  offset?: number
}

export type TaskBoardAction =
  | { kind: 'import'; sourceId: string; tasks: TaskRecord[] }
  | { kind: 'create'; id: string; input: NewTaskInput }
  | { kind: 'update'; taskId: string; patch: TaskUpdatePatch }
  | { kind: 'delete'; taskId: string }
  | { kind: 'move'; taskId: string; status: TaskStatus }
  | { kind: 'archive'; taskId: string }
  | { kind: 'restore'; taskId: string }
  | { kind: 'set-schedule'; taskId: string; patch: { enabled?: boolean; cron?: string } }
  // Card [V2.9收口·窗口活]: `requester` (optional) records WHO asked for the
  // run — the caller's dsh session id, written into the new execution record as
  // `requestedBy`. Additive + optional: ledger schema version stays put and an
  // old caller that omits it keeps working unchanged.
  | { kind: 'run'; taskId: string; requester?: string }
  | { kind: 'rerun'; taskId: string; requester?: string }
  // Local fork: the human acceptance gate over a settled execution.
  | { kind: 'confirm'; taskId: string }
  | { kind: 'reject'; taskId: string; note?: string }
  // Local fork: one-commit batch archive for board cleanup. The per-card
  // `archive` action rewrites and fsyncs the whole ledger on every call, so
  // retiring a few hundred finished cards one by one stalls the Host event
  // loop; this variant does the same work in a single commit.
  //
  // Card [看板瘦身·K1]: archiving is a PHYSICAL move. The stamped cards leave
  // the main ledger and land in `task-board/archive/<batchId>/cards.json`
  // (方案 §3 D-2), so a card that was already moved out is a no-op for a
  // second archive request.
  | { kind: 'archive-many'; taskIds: string[] }
  // Card [看板瘦身·K1] (方案 §3 D-5): migrate every card that still carries an
  // in-ledger `archivedAt` marker into one batch, without stopping dsh.
  | { kind: 'archive-compact' }
  // Card [看板瘦身·K1] (方案 §3 D-3): move a whole batch back onto the board.
  // The batch id names a directory, so the wire parser validates its shape.
  | { kind: 'restore-many'; batchId: string }

export interface TaskBoardActionEnvelope {
  requestId: string
  action: TaskBoardAction
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

const FORBIDDEN_IMPORT_FIELDS = new Set(['args', 'command', 'executable', 'powershell', 'shell'])

function hasForbiddenImportField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenImportField)
  const row = record(value)
  if (row === undefined) return false
  return Object.entries(row).some(([key, nested]) => FORBIDDEN_IMPORT_FIELDS.has(key.toLowerCase()) || hasForbiddenImportField(nested))
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value))
}

function validImportedKnownFields(value: Record<string, unknown>): boolean {
  if (value.schedule !== undefined) {
    const schedule = record(value.schedule)
    if (schedule === undefined || typeof schedule.enabled !== 'boolean' || typeof schedule.cron !== 'string') return false
    if (!optionalFiniteNumber(schedule.nextRunAt) || !optionalFiniteNumber(schedule.lastTriggeredAt)) return false
  }
  if (value.executions !== undefined) {
    if (!Array.isArray(value.executions)) return false
    for (const item of value.executions) {
      const execution = record(item)
      if (execution === undefined || typeof execution.id !== 'string' || !optionalString(execution.sessionId)) return false
      if (typeof execution.startedAt !== 'number' || !Number.isFinite(execution.startedAt)) return false
      if (!optionalFiniteNumber(execution.endedAt) || !optionalString(execution.error)) return false
      if (execution.result !== undefined && !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(String(execution.result))) return false
    }
  }
  return true
}

function importedTask(value: unknown): TaskRecord | undefined {
  const input = record(value)
  if (input === undefined || hasForbiddenImportField(input) || !validImportedKnownFields(input)) return undefined
  const task = parseLedger(JSON.stringify([value]))[0]
  if (task === undefined) return undefined
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    prompt: task.prompt,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    executions: task.executions.map(execution => ({
      id: execution.id,
      sessionId: execution.sessionId,
      startedAt: execution.startedAt,
      endedAt: execution.endedAt,
      result: execution.result,
      error: execution.error,
    })),
    ...(task.schedule === undefined ? {} : {
      schedule: {
        enabled: task.schedule.enabled,
        cron: task.schedule.cron,
        nextRunAt: task.schedule.nextRunAt,
        lastTriggeredAt: task.schedule.lastTriggeredAt,
      },
    }),
    ...(task.workspaceId === undefined ? {} : { workspaceId: task.workspaceId }),
    ...(task.mode === undefined ? {} : { mode: task.mode }),
    ...(task.permission === undefined ? {} : { permission: task.permission }),
    ...(task.line === undefined ? {} : { line: task.line }),
    ...(task.seq === undefined ? {} : { seq: task.seq }),
    ...(task.archivedAt === undefined ? {} : { archivedAt: task.archivedAt }),
  }
}

function createInput(value: unknown): value is NewTaskInput {
  const input = record(value)
  if (input === undefined || !exactKeys(input, ['title', 'description', 'prompt', 'workspaceId', 'mode', 'permission', 'kind', 'schedule', 'line', 'seq'])) return false
  if (typeof input.title !== 'string' || typeof input.description !== 'string' || typeof input.prompt !== 'string') return false
  if (!optionalString(input.workspaceId) || !optionalString(input.mode)) return false
  if (!optionalString(input.line) || !optionalString(input.seq)) return false
  if (input.permission !== undefined && !isTaskPermission(input.permission)) return false
  if (input.kind !== undefined && !isTaskKind(input.kind)) return false
  if (input.schedule !== undefined) {
    const schedule = record(input.schedule)
    if (schedule === undefined || !exactKeys(schedule, ['enabled', 'cron'])) return false
    if (typeof schedule.enabled !== 'boolean' || typeof schedule.cron !== 'string') return false
  }
  return true
}

function updatePatch(value: unknown): boolean {
  const patch = record(value)
  if (patch === undefined || !exactKeys(patch, ['title', 'description', 'prompt', 'workspaceId', 'mode', 'permission', 'kind', 'line', 'seq'])) return false
  for (const key of ['title', 'description', 'prompt', 'workspaceId', 'mode', 'line', 'seq'] as const) {
    if (!optionalString(patch[key])) return false
  }
  if (patch.permission !== undefined && !isTaskPermission(patch.permission)) return false
  return patch.kind === undefined || isTaskKind(patch.kind)
}

function schedulePatch(value: unknown): boolean {
  const patch = record(value)
  return patch !== undefined
    && exactKeys(patch, ['enabled', 'cron'])
    && (patch.enabled === undefined || typeof patch.enabled === 'boolean')
    && (patch.cron === undefined || typeof patch.cron === 'string')
}

export function parseActionEnvelope(value: unknown): TaskBoardActionEnvelope | undefined {
  const envelope = record(value)
  if (envelope === undefined || !exactKeys(envelope, ['requestId', 'action'])) return undefined
  if (typeof envelope.requestId !== 'string' || envelope.requestId.trim() === '' || envelope.requestId.length > 256) return undefined
  const action = record(envelope.action)
  if (action === undefined || typeof action.kind !== 'string') return undefined
  const taskId = typeof action.taskId === 'string' && action.taskId !== '' ? action.taskId : undefined
  switch (action.kind) {
    case 'import':
      if (!exactKeys(action, ['kind', 'sourceId', 'tasks'])) return undefined
      if (typeof action.sourceId !== 'string' || action.sourceId === '' || !Array.isArray(action.tasks)) return undefined
      {
        const tasks = action.tasks.map(importedTask)
        return tasks.every((task): task is TaskRecord => task !== undefined)
          ? { requestId: envelope.requestId, action: { kind: 'import', sourceId: action.sourceId, tasks } }
          : undefined
      }
    case 'create':
      if (!exactKeys(action, ['kind', 'id', 'input'])) return undefined
      return typeof action.id === 'string' && action.id !== '' && createInput(action.input)
        ? { requestId: envelope.requestId, action: action as unknown as Extract<TaskBoardAction, { kind: 'create' }> }
        : undefined
    case 'update':
      if (!exactKeys(action, ['kind', 'taskId', 'patch'])) return undefined
      return taskId !== undefined && updatePatch(action.patch)
        ? { requestId: envelope.requestId, action: action as unknown as Extract<TaskBoardAction, { kind: 'update' }> }
        : undefined
    case 'set-schedule':
      if (!exactKeys(action, ['kind', 'taskId', 'patch'])) return undefined
      return taskId !== undefined && schedulePatch(action.patch)
        ? { requestId: envelope.requestId, action: action as unknown as Extract<TaskBoardAction, { kind: 'set-schedule' }> }
        : undefined
    case 'move':
      if (!exactKeys(action, ['kind', 'taskId', 'status'])) return undefined
      return taskId !== undefined && isTaskStatus(action.status)
        ? { requestId: envelope.requestId, action: action as unknown as Extract<TaskBoardAction, { kind: 'move' }> }
        : undefined
    case 'confirm':
      if (!exactKeys(action, ['kind', 'taskId'])) return undefined
      return taskId === undefined ? undefined : { requestId: envelope.requestId, action: { kind: 'confirm', taskId } }
    case 'reject':
      if (!exactKeys(action, ['kind', 'taskId', 'note'])) return undefined
      if (action.note !== undefined && (typeof action.note !== 'string' || action.note.length > 4000)) return undefined
      return taskId === undefined ? undefined : {
        requestId: envelope.requestId,
        action: { kind: 'reject', taskId, ...(action.note === undefined ? {} : { note: action.note }) },
      }
    case 'archive-many': {
      if (!exactKeys(action, ['kind', 'taskIds'])) return undefined
      // 500 keeps the envelope well inside ACTION_LIMIT (64 KiB) even with
      // uuid-length ids; the largest real cleanup batch is a few hundred.
      if (!Array.isArray(action.taskIds) || action.taskIds.length === 0 || action.taskIds.length > 500) return undefined
      if (!action.taskIds.every(id => typeof id === 'string' && id !== '' && id.length <= 256)) return undefined
      return { requestId: envelope.requestId, action: { kind: 'archive-many', taskIds: [...action.taskIds] } }
    }
    case 'archive-compact':
      if (!exactKeys(action, ['kind'])) return undefined
      return { requestId: envelope.requestId, action: { kind: 'archive-compact' } }
    case 'restore-many':
      if (!exactKeys(action, ['kind', 'batchId'])) return undefined
      if (!isValidArchiveBatchId(action.batchId)) return undefined
      return { requestId: envelope.requestId, action: { kind: 'restore-many', batchId: action.batchId } }
    case 'delete':
    case 'archive':
    case 'restore':
    case 'run':
    case 'rerun':
      if (!exactKeys(action, ['kind', 'taskId', 'requester'])) return undefined
      return taskId === undefined ? undefined : { requestId: envelope.requestId, action: action as TaskBoardAction }
    default:
      return undefined
  }
}
