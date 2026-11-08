/**
 * Event outbox — the **producer** half of `~/.dsh/queue-events.jsonl`.
 *
 * The consumer has been live since 2026-09-14 (`dsh-butler` →
 * `lib\queue-watch.mjs` `consumeInbox()`, Q2 protocol v1) while **nothing ever
 * wrote the file**, so the "real settled-at" baseline it feeds the queue guard
 * was always missing and `Test-Path` on the file was False.
 *
 * This module closes that gap at the ONE place a card settles
 * (`HostTaskLedger.settle` + the restart-interrupt path
 * `HostTaskLedger.reconcileInterruptedStarts`). Nothing else writes the file,
 * so "one settlement = one line" holds by construction.
 *
 * Protocol v1 (keep compatible with `consumeInbox`):
 *   `{ at: <epoch ms>, taskId: <card id>, ... }`
 * `at` + `taskId` are the fields the consumer REQUIRES — they are its dedup key
 * (`${taskId}|${at}`) and it silently drops a line missing either. Everything
 * else is informative; this writer adds the fields the 600-gap ledger asks for
 * (`ts` ISO-8601 / `kind` / `cardId` / `status` / `executionId` / `outcome`).
 *
 * Failure policy: writing an event must NEVER affect a settlement. The ledger
 * commit has already happened and the ledger is the source of truth, so every
 * failure is returned as a message for the caller to log — never thrown.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
// R-065 删除/搬移三件套（锁6 · 批 E4）：唯一口在本插件内自足实现（插件实体不能静态 import tools/lib）。
import { gateDestructive } from './destructive-gate.ts'
// 2026-11-09 卡「账本写重试」：tmp → rename 统一走带退避重试的唯一口（EPERM/EACCES/EBUSY）。
import { isTmpPreserved, renameWithRetry } from './fs-atomic.ts'

/** File name inside the DSH home (must match `consumeInbox`'s `INBOX_NAME`). */
export const QUEUE_EVENTS_NAME = 'queue-events.jsonl'

/** Rotate once the file passes this size; the consumer tolerates a truncation (it only resets its offset). */
const MAX_BYTES = 2 * 1024 * 1024
/** Lines kept by a rotation — recent history is what the queue guard reads. */
const KEEP_LINES = 500

export interface QueueEventInput {
  /** Card id — the consumer's `taskId` (required by protocol v1). */
  taskId: string
  /** Event family; every settlement publishes `'settled'`. */
  kind: 'settled'
  /** Card status AFTER the settlement (review / todo / failed / …). */
  status: string
  executionId?: string | undefined
  outcome?: string | undefined
  error?: string | undefined
}

/** `<home>/queue-events.jsonl`. */
export function queueEventsFile(home: string): string {
  return join(home, QUEUE_EVENTS_NAME)
}

/**
 * Append one settlement event. Returns `null` on success, or the failure
 * message (never throws) — callers log it and carry on.
 */
export function appendQueueEvent(home: string, input: QueueEventInput, now: number = Date.now()): string | null {
  try {
    const file = queueEventsFile(home)
    mkdirSync(dirname(file), { recursive: true })
    rotateIfOversized(file)
    const line = JSON.stringify({
      at: now,
      ts: new Date(now).toISOString(),
      taskId: input.taskId,
      cardId: input.taskId,
      kind: input.kind,
      status: input.status,
      ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      ...(input.error === undefined ? {} : { error: input.error }),
    })
    appendFileSync(file, `${line}\n`, 'utf8')
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Keep the outbox bounded without ever losing the tail: past `MAX_BYTES` the
 * last `KEEP_LINES` lines are rewritten atomically (tmp + rename). The
 * consumer reads it by byte offset and treats `size < offset` as "file was
 * truncated" (it restarts from 0 and still dedups by `taskId|at`), so a
 * rotation cannot double-report a settlement.
 */
function rotateIfOversized(file: string): void {
  if (!existsSync(file)) return
  if (statSync(file).size <= MAX_BYTES) return
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim() !== '')
  const keep = lines.slice(-KEEP_LINES)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, keep.length === 0 ? '' : `${keep.join('\n')}\n`, 'utf8')
  try {
    gateDestructive({ targets: [{ path: tmp, label: 'inbox tmp' }, { path: file, label: 'inbox file' }], whitelist: [dirname(file)], op: '搬移', reason: '事件 outbox 轮转（原子替换）', action: () => renameWithRetry(tmp, file) })
  } catch (error) {
    // 重试耗尽仍失败 ⇒ tmp 留着取证（renameWithRetry 已打 stderr），别当普通失败清掉。
    if (!isTmpPreserved(error)) {
      try {
        gateDestructive({ targets: [{ path: tmp, label: 'inbox tmp' }], whitelist: [dirname(tmp)], op: '删', reason: '轮转失败回收 tmp', action: () => unlinkSync(tmp) })
      } catch {
        // The rotation temp file is best-effort cleanup; the original file is intact.
      }
    }
    throw error
  }
}
