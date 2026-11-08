/**
 * Archive/restore task use case: move a settled (done/failed) task off the
 * main board and back. The task keeps its status, execution history, and
 * transcript references, while archiving disarms any schedule so it cannot
 * create more execution records until the user restores and re-enables it.
 *
 * Card [看板瘦身·K1] turned "archive" into a PHYSICAL move (方案 §3 D-2): the
 * stamped card leaves the main ledger and lands in
 * `task-board/archive/<batchId>/cards.json`. The `*Move` functions below
 * return both halves of that move — the cards that stay and the cards that go —
 * so the Host ledger can persist the new home BEFORE it rewrites the old one.
 * The `applyArchiveTask` / `applyArchiveManyTask` shapes are kept unchanged for
 * the browser controller (it still stamps locally on its optimistic pass).
 */
import type { TaskRecord } from '../tasks.ts'
import { ARCHIVABLE_STATUSES } from '../tasks.ts'

/** Result of an archive transition. */
export interface ArchiveTaskResult {
  /** The next ledger. */
  tasks: readonly TaskRecord[]
  /** Whether the archive was applied (false = unknown task / not archivable). */
  archived: boolean
}

/** Result of a physical archive move: what leaves the board and what stays. */
export interface ArchiveMoveResult {
  /** Cards that stay on the main board. */
  tasks: readonly TaskRecord[]
  /** Cards moved off the board, fully stamped and ready to persist in a batch. */
  moved: readonly TaskRecord[]
  /** Whether anything was archived (false = unknown / already archived / not settled). */
  archived: boolean
}

/** Whether a task may be archived: settled status and no archive marker yet. */
function archivable(task: TaskRecord): boolean {
  return task.archivedAt === undefined && (ARCHIVABLE_STATUSES as readonly string[]).includes(task.status)
}

/**
 * Stamp one card as archived. Archiving disarms its schedule so it cannot
 * create more execution records while it sits in the archive.
 */
function stampArchived(task: TaskRecord, now: number): TaskRecord {
  const schedule = task.schedule === undefined
    ? undefined
    : { ...task.schedule, enabled: false, nextRunAt: undefined }
  return {
    ...task,
    ...(schedule === undefined ? {} : { schedule }),
    archivedAt: now,
    updatedAt: now,
  }
}

/**
 * Archive one task: only settled statuses (done/failed) can be archived;
 * a running or not-yet-settled task stays on the board (its runner still
 * owns its lifecycle). Archiving disarms a schedule; already-archived tasks
 * are a no-op.
 */
export function applyArchiveTask(
  tasks: readonly TaskRecord[],
  id: string,
  now: number,
): ArchiveTaskResult {
  let applied = false
  const next = tasks.map(task => {
    if (task.id !== id || !archivable(task)) return task
    applied = true
    return stampArchived(task, now)
  })
  return { tasks: next, archived: applied }
}

/**
 * Archive many tasks in a single ledger pass (one commit for the whole batch).
 *
 * Why it exists: `applyArchiveTask` is invoked once per card, and every action
 * commits the entire ledger (`writeFileSync` + fsync of the full document). On
 * a 6 MB / 609-card ledger, archiving a few hundred already-finished cards one
 * by one costs hundreds of full rewrites and stalls the Host event loop — the
 * very pressure this batch path removes. Rules stay identical to the single
 * card path: only settled (done/failed) and not-yet-archived cards are touched,
 * everything else is skipped instead of failing the whole batch.
 */
export function applyArchiveManyTask(
  tasks: readonly TaskRecord[],
  ids: readonly string[],
  now: number,
): ArchiveTaskResult {
  const wanted = new Set(ids)
  let applied = false
  const next = tasks.map(task => {
    if (!wanted.has(task.id) || !archivable(task)) return task
    applied = true
    return stampArchived(task, now)
  })
  return { tasks: next, archived: applied }
}

/** Restore one task back onto the main board (clears the archive marker). */
export function applyRestoreTask(tasks: readonly TaskRecord[], id: string, now: number): ArchiveTaskResult {
  let applied = false
  const next = tasks.map(task => {
    if (task.id !== id || task.archivedAt === undefined) return task
    applied = true
    const { archivedAt: _archived, ...rest } = task
    return { ...rest, updatedAt: now }
  })
  return { tasks: next, archived: applied }
}

/**
 * One-card half of a physical archive move (方案 §3 D-2).
 *
 * The stamping rules are the same as {@link applyArchiveTask}, but the moved
 * card is handed back to the caller INSTEAD of being left in `tasks`: the Host
 * ledger writes it to the batch file first and only then commits the main
 * ledger without it. Unknown / already-archived / unsettled cards stay put.
 */
export function applyArchiveMove(tasks: readonly TaskRecord[], id: string, now: number): ArchiveMoveResult {
  const moved: TaskRecord[] = []
  const kept: TaskRecord[] = []
  for (const task of tasks) {
    if (task.id !== id || !archivable(task)) {
      kept.push(task)
      continue
    }
    moved.push(stampArchived(task, now))
  }
  return { tasks: kept, moved, archived: moved.length > 0 }
}

/** Batch half of a physical archive move; see {@link applyArchiveMove}. */
export function applyArchiveManyMove(tasks: readonly TaskRecord[], ids: readonly string[], now: number): ArchiveMoveResult {
  const wanted = new Set(ids)
  const moved: TaskRecord[] = []
  const kept: TaskRecord[] = []
  for (const task of tasks) {
    if (!wanted.has(task.id) || !archivable(task)) {
      kept.push(task)
      continue
    }
    moved.push(stampArchived(task, now))
  }
  return { tasks: kept, moved, archived: moved.length > 0 }
}

/**
 * Put a card that lives in an archive batch back on the main board (方案 §3
 * D-3): `status` / `executions` / `updatedAt` come back verbatim and only the
 * archive marker is cleared. The schedule stays disarmed — archiving switched
 * it off, and re-arming it is the human's decision (方案 §3 D-3 keeps the
 * archived snapshot, and judging J5 compares every field).
 */
export function applyRestoreFromBatch(card: TaskRecord): TaskRecord {
  const { archivedAt: _archived, ...rest } = card
  return rest
}
