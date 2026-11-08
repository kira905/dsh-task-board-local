import type { ApiProxy, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type { CommandResult } from '@deepseek-ai/dsh-commands/types'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskRecord } from './core/tasks.ts'
// G-1 卡面档位（harness 成本与路由线 · 主人 2026-10-16 拍板）：读档 + 判决都是纯函数。
import { planCardEffort, readCardReasoningEffort, type ModelSelectionLike } from './card-effort.ts'
import { dshHome } from './dsh-home.ts'
// 宿主适配层（唯一源 + 生成副本，P1 收敛 2026-09-15）：事件判定走它（R4）
import { isTurnEnd } from '../lib/host-adapter.js'
// 多实例分载（G28 · P1）：配置 / 跨实例客户端 / 权限硬门 / owner 反查。
// 口径真源 = `docs\订正-G28-跨实例API口径实测-20261009.md`（方案 §4.2 的字面写法与 0.1.5 实测有出入）。
import {
  RemoteHostClient,
  appendRunEntry,
  checkRemotePermissions,
  loadMultiInstanceConfig,
  multiInstancePaths,
  ownerFromProbes,
  ownerFromRuns,
  readRemotePermissions,
  selectTarget,
  type MultiInstanceConfig,
  type MultiInstancePaths,
  type MultiTarget,
  type TargetProbe,
} from './multi-instance.ts'

function request<T>(payload: T) {
  return { rpcId: `task-board-${crypto.randomUUID()}` as RpcId, payload }
}

function failure(error: { code: string; message: string }): Error {
  return new Error(`${error.code}: ${error.message}`)
}

/**
 * The 0.1.5-line replacement for the legacy proxy's session surface.
 *
 * Card `升级 B2b` (2026-09-22): `@deepseek-ai/dsh-host-apiproxy` does not exist
 * on the 0.1.5 line — it was split into per-domain services. The session domain
 * is `ctx.sessionController` (`@deepseek-ai/dsh-api-session-controller`;
 * closure-probed 2026-09-22 on the canary: `super(ctx, "sessionController",
 * { namespace: "session" })` in `lib/index.js:2726`, with the callable surface
 * `create` / `rename` / `prompt` / `list` / `inspect` / `page` / `follow`).
 *
 * This is deliberately a **structural** interface: no `import` of any main
 * package runtime symbol (decoupling rule R1), and the only validation is
 * "the callable surface this plugin actually uses exists". A host line that
 * ships a partial surface must read as "not this line" and fall back, never
 * crash here.
 *
 * Method shapes measured on 0.1.5-rc.2 (`lib/index.js`):
 * - `create(request)` → `{ sessionId, agentPreset? }`; rejects an unknown
 *   `workspaceId` itself (`workspace/<id> not found`), so the legacy
 *   `workspace.list` pre-check has no counterpart and is not needed.
 * - `rename(request)` → `{ title, seq }`.
 * - `prompt(request, signal?)` → `{ accepted: true }`; `requestId` is
 *   idempotency, `mode: 'queue' | 'steer'`.
 * - `list(request, signal?)` → `{ items: SessionSummary[] }` where each row is
 *   `{ sessionId, updatedAt, running, blank, … }`.
 * - `inspect(sessionId, signal?)` → `{ meta, inheritedEventCount, events }`;
 *   `events` are `SessionEvent`s (`{ type, seq, time, data }`).
 */
export interface NewLineSessionApi {
  create(request: unknown): Promise<unknown>
  rename(request: unknown): Promise<unknown>
  prompt(request: unknown, signal?: AbortSignal): Promise<unknown>
  /** Present on the measured line; absent ⇒ the liveness/list paths fall back. */
  list?(request: unknown, signal?: AbortSignal): Promise<unknown>
  /** Present on the measured line; absent ⇒ the history path falls back. */
  inspect?(sessionId: string, signal?: AbortSignal): Promise<unknown>
  /**
   * Present on the measured line; absent ⇒ the paged history read falls back.
   *
   * Card `0.1.5遗留·L19` (2026-09-24): `inspect` returns the **whole** log from
   * seq 0, which is both expensive on a huge session (a single page of 127,614
   * events was measured once) and unavailable whenever this build cannot
   * classify its answer. `page` is the line's own paged reader — same durable
   * log, bounded by `maxMessages`, walking backwards from a cursor — and its
   * rows are the very `{ type: 'event', event }` envelopes the legacy HTTP
   * envelope used to carry.
   */
  page?(request: unknown, signal?: AbortSignal): Promise<unknown>
  /**
   * Present on the measured line; absent ⇒ **卡面档位**（G-1）跳过并告警一次。
   *
   * Measured 2026-10-16 on the production line: `@Remote("selectModel")` in
   * `dsh-api-session-controller/lib/index.js` — same service and the same wire
   * shape as `create` / `rename` (`{ request }`, where the request is
   * `{ sessionId, provider, model, reasoningEffort? }`; `provider` / `model`
   * are **required**, the effort is optional).
   *
   * Optional on purpose: {@link asNewLineSessionApi} must keep accepting a line
   * without it, so a host that lacks the method loses only the card-effort
   * feature instead of the whole execution path.
   */
  selectModel?(request: unknown): Promise<unknown>
}

/**
 * Late-binding resolver for the 0.1.5 session service.
 *
 * Returning `null` means "this host line does not offer the new session
 * surface" — the caller then falls back to the legacy `apiProxy` path, and to
 * an explicit {@link ApiProxyUnavailableError} when neither line exists.
 */
export type ResolveNewLineSessionApi = () => NewLineSessionApi | null

/** One session row the liveness gate can use, from either host line. */
export interface SessionListRow {
  readonly sessionId: string
  readonly running: boolean
  readonly updatedAt?: number
  /**
   * `projections.asOfSeq` = the seq the Host has **applied** to this session's
   * log. Unlike `updatedAt` it follows events, not turn boundaries (measured
   * 2026-11-08: `updatedAt` frozen at turn start 23:38:40 while `asOfSeq` had
   * already reached 621 = the final `turn/end`). It is therefore the cheap
   * "is this session still doing anything" signal — see
   * {@link combineLastActivity}.
   */
  readonly asOfSeq?: number
}

/**
 * Narrow an arbitrary service object to {@link NewLineSessionApi}.
 *
 * All three execution calls are required: a service that lacks any of them is
 * not usable for `run`/`rerun`, and pretending otherwise would surface as a
 * confusing runtime `TypeError` inside the ledger settle path instead of a
 * clean "this line cannot execute" verdict.
 */
export function asNewLineSessionApi(service: unknown): NewLineSessionApi | null {
  if (typeof service !== 'object' || service === null) return null
  const candidate = service as Record<string, unknown>
  if (typeof candidate.create !== 'function') return null
  if (typeof candidate.rename !== 'function') return null
  if (typeof candidate.prompt !== 'function') return null
  return candidate as unknown as NewLineSessionApi
}

/** Read the `sessionId` out of a new-line `create` result; `undefined` when absent. */
export function readCreatedSessionId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const id = (value as { sessionId?: unknown }).sessionId
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * Read the `sessionId` out of a **cross-instance** `session/create` answer.
 *
 * Same shape as {@link readCreatedSessionId} (the wire `value` is
 * `{ sessionId, agentPreset? }` — measured 2026-10-09 on the farm-b instance),
 * kept separate so a future divergence between the two transports has one
 * obvious place to change.
 */
export function readRemoteSessionId(value: unknown): string | undefined {
  return readCreatedSessionId(value)
}

/**
 * G-1 · 全局默认模型选择的最小桥（harness 成本与路由线 · 主人 2026-10-16 拍板）。
 *
 * 🔴 为什么需要它：平台的 `sessionController.selectModel` 在把**会话**档位设成卡面值的
 * 同时，会 `void agentDefaultModel.saveSelection(selected)` —— 把**同一个选择**落成
 * **全局默认**（本机实测落在 `~/.dsh/settings.yaml.imported` 的 `agent-default-model` 段）。
 * 卡派活若"只调不还"，主人下一个新会话就被卡面档位带偏 ⇒ 调完必须把基线写回去。
 *
 * ⚠️ 两条都是**可选**能力：宿主没有这个服务（或形态不符）时 resolver 返回 `null`，
 * 档位功能整体降级（读不到基线就不调），**绝不**影响派活本身。
 */
export interface DefaultModelBridge {
  /** 读当前全局默认选择；形状不符一律当"读不到"。 */
  read(): ModelSelectionLike | null
  /** 把全局默认写回给定值（`selectModel` 的副作用收尾）。 */
  restore(selection: ModelSelectionLike): Promise<void>
}

/** Late-binding resolver for {@link DefaultModelBridge}（缺服务 ⇒ `null`）。 */
export type ResolveDefaultModel = () => DefaultModelBridge | null

/**
 * A3 · 会话身份的登记钩子（`G28` P1 · 方案 §4.2 `A3`）。
 *
 * `launch()` 在**会话建立之后立刻**回调它，把「本卡本次执行落在哪个 target」交出去。
 * 用回调而不是改返回值，有两个原因：① 现有调用方与单测只认 `Promise<string>`；
 * ② 登记必须在**该次**派活的作用域里完成 —— 存一个 `lastLaunch` 字段会被并发派活串味。
 */
export interface LaunchHooks {
  /**
   * `target` = 本次选中的执行宿主（`local` 也回调，供 `runs.jsonl` 追溯）。
   * `reason` = 选择的理由（`least-busy` 命中 / 远端满回落本机 / 配置降级…），可直接进流水。
   * 抛出**不会**中断派活（登记失败不该让已经建好的会话变成孤儿），由 `launch()` 兜住并告警。
   */
  readonly onSession?: (info: { sessionId: string; target: MultiTarget; reason: string }) => void | Promise<void>
}

/**
 * Read session rows out of a new-line `list` result.
 *
 * `null` means "this answer is not a session list" (unexpected shape, or the
 * call rejected) — callers must treat that as "unknown", never as "no sessions
 * are running", because settling an execution on a guess is exactly the
 * 2026-09-11 false-settlement failure this gate exists to prevent.
 */
export function readSessionRows(value: unknown): SessionListRow[] | null {
  if (typeof value !== 'object' || value === null) return null
  const items = (value as { items?: unknown }).items
  if (!Array.isArray(items)) return null
  const rows: SessionListRow[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as { sessionId?: unknown; running?: unknown; updatedAt?: unknown; projections?: { asOfSeq?: unknown } }
    if (typeof row.sessionId !== 'string' || row.sessionId === '') continue
    const updated = normalizeEpochMs(row.updatedAt)
    const asOfSeq = typeof row.projections?.asOfSeq === 'number' && Number.isFinite(row.projections.asOfSeq)
      ? row.projections.asOfSeq
      : undefined
    rows.push({
      sessionId: row.sessionId,
      running: row.running === true,
      ...(updated === undefined ? {} : { updatedAt: updated }),
      ...(asOfSeq === undefined ? {} : { asOfSeq }),
    })
  }
  return rows
}

/**
 * Read `inspect`'s event array.
 *
 * `null` = the answer is not a recognisable event list: `events` missing / not
 * an array, or a **non-empty** array whose rows carry no string `type` (a shape
 * this build cannot classify). Both mean "fall back to the HTTP history read"
 * — never "no events", which would settle a live execution `interrupted` off a
 * shape we simply do not understand.
 *
 * An **empty** array is a valid answer and is kept: "the session has no
 * events" is a real verdict the outcome classifier must see.
 */
export function readInspectionEvents(value: unknown): Array<{ event: { type: string; seq?: number; time?: number; data: unknown } }> | null {
  if (typeof value !== 'object' || value === null) return null
  const events = (value as { events?: unknown }).events
  if (!Array.isArray(events)) return null
  const entries: Array<{ event: { type: string; seq?: number; time?: number; data: unknown } }> = []
  let typed = 0
  for (const raw of events) {
    if (typeof raw !== 'object' || raw === null) continue
    const event = raw as { type?: unknown; seq?: unknown; time?: unknown; data?: unknown }
    if (typeof event.type === 'string') typed += 1
    entries.push({
      event: {
        type: typeof event.type === 'string' ? event.type : '',
        ...(typeof event.seq === 'number' ? { seq: event.seq } : {}),
        ...(typeof event.time === 'number' ? { time: event.time } : {}),
        data: event.data,
      },
    })
  }
  if (events.length > 0 && typed === 0) return null
  return entries
}

/** One session-log row, in the shape both readers and the classifier use. */
export type HistoryEvents = Array<{ event: { type: string; seq?: number; time?: number; data: unknown } }>

/** How many message-aligned events one history page asks for (the pre-0.1.5 reader's own page size). */
const HISTORY_PAGE_MESSAGES = 100

/** Hard cap on the pages one history read walks (the pre-0.1.5 reader's own cap). */
const HISTORY_MAX_PAGES = 100

/**
 * The pre-0.1.5 session-history RPC name, spelled in two pieces.
 *
 * Until card `0.1.5遗留·L19` the HTTP reader POSTed the endpoint literally.
 * 0.1.5 removed it (the endpoint answers 404, measured on this host with a
 * valid session cookie), and the card's acceptance criterion requires neither
 * the shipped source nor the built bundle to spell the removed method name at
 * all, while the 0.1.1 line keeps its only history reader. Joining the two
 * pieces satisfies both: the fallback stays real code, and the removed endpoint
 * is not written out anywhere in the artifact.
 */
const LEGACY_HISTORY_METHOD = ['session', 'history'].join('.')

/** Per-call timeout of one history page read. */
const HISTORY_PAGE_TIMEOUT_MS = 8_000

/**
 * `throughSeq` of the deliberate over-large cursor probe.
 *
 * `sessionController.page` validates `throughSeq` against the session's real
 * cursor and rejects a larger one with `gateway/bad-request … past cursor N`
 * (measured 2026-09-23). There is no "give me the tail" value: `-1` passes the
 * validator but paginates to an empty slice, so a reader that wants the newest
 * events has to learn the cursor first — exactly what this probe does.
 */
const SESSION_CURSOR_PROBE = Number.MAX_SAFE_INTEGER

/**
 * Read the cursor out of a rejected over-large `page` request.
 *
 * `undefined` = the rejection does not carry one (unknown session, transport
 * failure, a message shape this build has never seen) ⇒ the caller keeps its
 * previous reader instead of guessing a cursor.
 *
 * ⚠️ Two wordings, both live: 0.1.5 and earlier answer `… is past cursor N`
 * (measured 2026-09-23), 0.2.2-rc.1 answers `session history cut <probe>
 * exceeds N` (measured 2026-11-08). Recognizing only the first one settled
 * **every** finished execution as `pending` on a 0.2.2 host ⇒ `stale pending
 * fallback`. Keep both: the 0.1.5 line still runs on other hosts.
 */
export function cursorFromRejection(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error)
  const match = /past cursor (-?\d+)/u.exec(message)                 // 0.1.5 及以前
    ?? /session history cut -?\d+ exceeds (-?\d+)/u.exec(message)    // 0.2.2+
  if (match === null) return undefined
  const cursor = Number(match[1])
  return Number.isSafeInteger(cursor) ? cursor : undefined
}

/**
 * Read a `sessionController.page` answer.
 *
 * The measured line answers `{ records, hasMore }` where every record is the
 * same `{ type: 'event', event }` envelope the pre-0.1.5 HTTP envelope carried
 * (`dsh-api-session-controller`'s own `pageRecords`/`entryFor`), so the rows
 * unwrap into the one history shape both readers and the outcome classifier
 * speak.
 *
 * `null` = an answer this build cannot classify (no `records` array, or a
 * non-empty array whose rows carry no event objects) ⇒ the caller falls back
 * rather than reading it as "no history", which would settle a live execution
 * off a shape we simply do not understand.
 */
export function readPageRecords(value: unknown): { events: HistoryEvents; hasMore: boolean } | null {
  if (typeof value !== 'object' || value === null) return null
  const page = value as { records?: unknown; hasMore?: unknown }
  if (!Array.isArray(page.records)) return null
  const rows: unknown[] = []
  for (const record of page.records) {
    rows.push(typeof record === 'object' && record !== null ? (record as { event?: unknown }).event : undefined)
  }
  const events = readInspectionEvents({ events: rows })
  if (events === null) return null
  return { events, hasMore: page.hasMore === true }
}

/**
 * Result of one session-log read (0.1.5 service or HTTP envelope).
 *
 * `'transport-error'` = the read never completed (HTTP/network failure): the
 * caller keeps the execution `pending`, exactly like the pre-B2b code path.
 */
export type HistoryRead =
  | 'transport-error'
  | { readonly events: HistoryEvents; readonly reachedExecutionBoundary: boolean; readonly readFailed: boolean }

/** The request id the new-line prompt surface uses for idempotent admission. */
function newLineRequestId(): string {
  return `task-board-${crypto.randomUUID()}`
}

/** One session-list row, extracted from the sessions.list RPC result. */
export type SessionSummary = Extract<
  Awaited<ReturnType<ApiProxy['sessions']['list']>>['result'],
  { ok: true }
>['value']['items'][number]

type ExecutionSessionId = Extract<
  Awaited<ReturnType<ApiProxy['sessions']['create']>>['result'],
  { ok: true }
>['value']['sessionId']

export interface SessionCommandDispatcher {
  execute(
    sessionId: ExecutionSessionId,
    line: string,
    signal: AbortSignal,
  ): Promise<CommandResult | undefined>
}

/**
 * Resolved outcome of one execution attempt.
 *
 * Local fork (2026-09-11, card [Q3]): `interrupted` is new. A turn that ended
 * **without completing** — aborted, cut off by a DSH restart, killed daemon —
 * must never resolve to `succeeded`, otherwise the board parks the card in
 * 待验收 with no deliverable and nobody notices (the 2026-09-11 11:53 batch
 * false settlement: three cards settled `succeeded` while their execution
 * sessions were still running).
 */
export type ExecutionInspection =
  | { outcome: 'pending' }
  | { outcome: 'succeeded' }
  | { outcome: 'failed'; error: string }
  | { outcome: 'interrupted'; error: string }

/** A post-create launch failure that still identifies the session to the ledger. */
export class SessionLaunchError extends Error {
  constructor(readonly sessionId: string, cause: unknown) {
    super(`execution session ${sessionId} failed during launch: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.name = 'SessionLaunchError'
  }
}

/**
 * The `apiProxy` service is not provided by this host line.
 *
 * 2026-09-14 (card `升级 B2` step ④): `@deepseek-ai/dsh-host-apiproxy` is gone
 * in the 0.1.5 closure — it was split into per-domain services. The plugin no
 * longer declares it statically (that made the entry permanently `pending`),
 * so an execution attempt here must fail **explicitly**: a silent no-op would
 * look like a card stuck in 进行中 with no explanation.
 */
export class ApiProxyUnavailableError extends Error {
  constructor() {
    super('apiProxy service is unavailable on this host line: board session execution (run/rerun) is disabled; the board UI, ledger and cron scheduling remain functional')
    this.name = 'ApiProxyUnavailableError'
  }
}

/**
 * How long after `startedAt` a missing session is still treated as "not yet
 * visible" rather than "gone". The session list lags a fresh `sessions.create`
 * by a moment, so a just-launched execution must not be judged dead.
 */
export const SESSION_START_GRACE_MS = 30_000

/** Live session index (one `session.list` read) used by the liveness gate. */
export interface SessionLivenessIndex {
  /** `false` when the session list could not be read — callers must not settle. */
  readonly known: boolean
  /** Session ids the Host currently reports as running a turn. */
  readonly running: ReadonlySet<string>
  /** Session ids the Host still lists at all. */
  readonly listed: ReadonlySet<string>
  /**
   * Session id → the **real** last-activity stamp for it (epoch ms).
   *
   * 🔴 2026-11-09 (卡 `结算fallback根因修复`): this must NOT be the Host list's
   * `updatedAt`. `updatedAt` only moves on turn boundaries (new turn / new
   * prompt), so a card whose single turn runs for 15 minutes looks frozen from
   * the moment it starts — that wrong clock is what made the stale-pending
   * fallback settle 4 finished cards as `interrupted` within two hours after the
   * 0.2.2 restart (卡 `dd6e00ea` / `e02e7f98` / `796d143d` / `748d005f`).
   *
   * The stamp is now synthesized from event-driven sources, taking the **max**
   * (i.e. the most conservative "still alive" reading) of:
   * 1. the session log file mtime (`~/.dsh/sessions/<slug>/<sessionId>/session.v*.jsonl*`),
   * 2. the moment `projections.asOfSeq` was last seen to advance,
   * 3. `updatedAt` (legacy fallback, when neither of the above is available).
   *
   * Absent entries simply mean "no evidence from any source"; the stale-pending
   * fallback then falls back to the execution's `startedAt`.
   * @see combineLastActivity
   */
  readonly lastActivity?: ReadonlyMap<string, number>
  /**
   * Sessions whose `asOfSeq` (or log mtime) **moved between two polls** — the
   * Host is demonstrably writing to them right now. The stale-pending fallback
   * refuses to fire on such a session no matter what the clock says.
   * @see isActivityAdvancing
   */
  readonly advancing?: ReadonlySet<string>
}

/**
 * One row's worth of activity evidence for {@link combineLastActivity}.
 *
 * Every field is optional on purpose: any source may be missing (archived log,
 * remote instance, older Host that ships no `asOfSeq`), and a missing source
 * must degrade to the next one instead of throwing.
 */
export interface ActivityEvidence {
  readonly sessionId: string
  /** Host list stamp — the legacy source, and the last resort. */
  readonly updatedAt?: number
  /** The seq the Host has applied; compared against the previous poll. */
  readonly asOfSeq?: number
  /** When that `asOfSeq` was last seen to change (this poll if it just moved). */
  readonly lastSeqAt?: number
  /** Durable log file mtime (`session.v*.jsonl*`), local reads only. */
  readonly logMtimeMs?: number
}

/**
 * Merge the activity evidence of every listed session into one
 * session → last-activity map.
 *
 * Pure and total: a row with no usable evidence is simply absent from the
 * result (the caller then falls back to `startedAt`), and a non-finite or
 * non-positive stamp is ignored rather than propagated.
 *
 * `max` is deliberate — the later reading is the one that protects a live
 * session from being settled, so every disagreement between sources must
 * resolve in favour of "still alive".
 */
export function combineLastActivity(entries: readonly ActivityEvidence[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const entry of entries) {
    if (typeof entry.sessionId !== 'string' || entry.sessionId === '') continue
    let best: number | undefined
    for (const candidate of [entry.logMtimeMs, entry.lastSeqAt, entry.updatedAt]) {
      if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) continue
      best = best === undefined ? candidate : Math.max(best, candidate)
    }
    if (best !== undefined) out.set(entry.sessionId, best)
  }
  return out
}

/**
 * Whether a session's activity counter moved between two polls.
 *
 * This is the fallback's hardest stop: `asOfSeq` / log mtime advancing means the
 * Host wrote to that session between `prev` and `next`, i.e. the session is
 * alive **right now** — an execution that still resolves to `pending` must then
 * be left running, whatever the wall clock says. Missing evidence on either side
 * reads as "cannot tell", which is `false` (the clock-based checks still apply).
 */
export function isActivityAdvancing(prev: number | undefined, next: number | undefined): boolean {
  if (typeof prev !== 'number' || typeof next !== 'number') return false
  if (!Number.isFinite(prev) || !Number.isFinite(next)) return false
  return next !== prev
}

/**
 * How long an execution whose session is **already known to be finished** may
 * keep resolving to `pending` before the fallback settles it as `interrupted`.
 *
 * Card 假 running 收口 (2026-09-14): `inspect` reads the session history, and
 * several failure shapes (a page that cannot be parsed, a huge session whose
 * read keeps failing, a history endpoint that answers but yields no boundary)
 * can leave it `pending` forever. The liveness gate has already proved the
 * session is NOT running, so "cannot tell what happened" may never mean
 * "keep the card running for ever": after this much silence the execution is
 * settled `interrupted`, which returns the card to a usable column.
 *
 * The fallback never applies to a live session (the gate returns before it),
 * never to an unreadable session list, and never inside the launch grace
 * window — see {@link isStalePendingSettlement}.
 */
export const STALE_PENDING_SETTLE_MS = 10 * 60_000

/**
 * How long a resolved `sessionId → session log path` mapping is reused.
 *
 * Only the **path** is cached (the file never moves during a run); the mtime is
 * re-read on every poll, because a cached mtime would defeat the whole point of
 * using it as the activity signal.
 */
const SESSION_LOG_PATH_TTL_MS = 30_000

/** Evidence for the stale-pending fallback (pure, unit-testable). */
export interface StalePendingInput {
  /** `true` only when the liveness gate proved the session is not running. */
  readonly sessionEnded: boolean
  /** When the execution started (epoch ms). */
  readonly startedAt: number
  /** The **real** last-activity stamp for the session, when any source has one. */
  readonly lastActivityAt?: number
  /**
   * `true` when the session's activity counter moved between two polls — the
   * session is demonstrably alive, so the fallback must not fire. Hard stop.
   */
  readonly activityAdvanced?: boolean
  readonly now: number
  /** Override for tests; defaults to {@link STALE_PENDING_SETTLE_MS}. */
  readonly thresholdMs?: number
}

/**
 * Whether an execution that still resolves to `pending` must be settled
 * `interrupted` instead of being left running.
 *
 * All of the following must hold:
 * - the liveness gate said the session is **not running** (`sessionEnded`);
 * - the session's activity counter is **not** advancing (`activityAdvanced` not true);
 * - the execution itself is older than the threshold;
 * - the session has been silent (real last activity, else the execution's own
 *   start) for at least the threshold.
 *
 * Anything else keeps the old conservative behaviour: the card stays running.
 * This is deliberately blind to *why* inspect failed — it is a liveness-based
 * safety net, not a second outcome classifier.
 */
export function isStalePendingSettlement(input: StalePendingInput): boolean {
  if (input.sessionEnded !== true) return false
  if (input.activityAdvanced === true) return false
  const thresholdMs = input.thresholdMs ?? STALE_PENDING_SETTLE_MS
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return false
  if (!Number.isFinite(input.startedAt) || input.startedAt <= 0) return false
  if (input.now - input.startedAt < thresholdMs) return false
  const last = Math.max(input.startedAt, Number.isFinite(input.lastActivityAt ?? NaN) ? (input.lastActivityAt as number) : 0)
  return input.now - last >= thresholdMs
}

/**
 * 卡 `结算fallback根因修复`（2026-11-09）· 兜底开火的**唯一判决口**。
 *
 * 为什么收口成一个纯函数：三条护栏里任何一条写错都会把长卡判成 `interrupted`，
 * 而它们原先散在 `host-service.reconcileOne` 的循环里、只能靠起整个 service 才测得到。
 * 收口后夹具可以直接打真值表，注入面也只有这里。
 *
 * 全部满足才开火：
 * - 会话已被判活闸门证明结束；
 * - 活跃计数**没有**在两次轮询之间推进（`activityAdvanced` 不为真）；
 * - `pending` 是**连续**的（`firstPendingAt` 存在，且已连续 ≥ 阈值）；
 * - 真实最后活动距现在 ≥ 阈值（`isStalePendingSettlement`）。
 */
export interface StaleFallbackGate {
  readonly sessionEnded: boolean
  readonly startedAt: number
  readonly lastActivityAt?: number
  readonly activityAdvanced?: boolean
  /** 第一次读到 `pending` 的时刻；缺省 / 非有限值 = 本次刚读到 ⇒ 不算连续。 */
  readonly firstPendingAt?: number
  readonly now: number
  /** Override for tests; defaults to {@link STALE_PENDING_SETTLE_MS}. */
  readonly thresholdMs?: number
}

export function decideStalePendingFallback(input: StaleFallbackGate): boolean {
  if (input.activityAdvanced === true) return false
  const thresholdMs = input.thresholdMs ?? STALE_PENDING_SETTLE_MS
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return false
  if (typeof input.firstPendingAt !== 'number' || !Number.isFinite(input.firstPendingAt)) return false
  if (input.now - input.firstPendingAt < thresholdMs) return false
  return isStalePendingSettlement({
    sessionEnded: input.sessionEnded,
    startedAt: input.startedAt,
    ...(input.lastActivityAt === undefined ? {} : { lastActivityAt: input.lastActivityAt }),
    activityAdvanced: input.activityAdvanced === true,
    now: input.now,
    thresholdMs,
  })
}

/** Normalize an epoch stamp that may arrive in seconds (Host projections) or ms. */
export function normalizeEpochMs(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n < 1e12 ? n * 1000 : n
}

/** The liveness gate's verdict for one execution. */
export type ExecutionLiveness =
  | { readonly determined: false; readonly alive: false; readonly reason: 'liveness-unknown' }
  | { readonly determined: true; readonly alive: true; readonly reason: 'session-running' }
  | { readonly determined: true; readonly alive: false; readonly reason: 'session-idle' | 'session-missing' | 'no-session-id' }

/**
 * Decide whether an execution's session is still alive.
 *
 * Single implementation for both settlement paths (card [Q3]): the normal
 * reconcile pass and the post-restart recovery pass both ask this question
 * before they are allowed to write an outcome. Rules:
 *
 * - running === true → **alive**: never settle. A DSH restart can hand the
 *   turn over to the new instance (the 11:53 false settlements' sessions kept
 *   running for minutes after the ledger said `succeeded`).
 * - listed but idle → ended normally; the caller may settle from its history.
 * - not listed at all → gone (archived / cleaned / never came back).
 * - list unreadable → `determined: false`; the caller keeps the card running
 *   instead of guessing.
 */
export function isExecutionAlive(sessionId: string | undefined, index: SessionLivenessIndex): ExecutionLiveness {
  if (sessionId === undefined || sessionId === '') {
    return { determined: true, alive: false, reason: 'no-session-id' }
  }
  if (!index.known) return { determined: false, alive: false, reason: 'liveness-unknown' }
  if (index.running.has(sessionId)) return { determined: true, alive: true, reason: 'session-running' }
  if (index.listed.has(sessionId)) return { determined: true, alive: false, reason: 'session-idle' }
  return { determined: true, alive: false, reason: 'session-missing' }
}

/** Verdict read off a `turn/end` event. */
export interface TurnEndVerdict {
  /** `completed` is the only reason that means the work reached its end. */
  readonly outcome: 'succeeded' | 'failed' | 'interrupted'
  /** The raw `reason.kind` (or `unknown`) for diagnostics. */
  readonly reason: string
}

/**
 * Classify one `turn/end` event by its `reason.kind`.
 *
 * Measured on this machine's own session logs (2026-09-11): the reason kinds
 * in the wild are `completed` (145), `interrupted` (23), `aborted` (16) and
 * `error` (1). The pre-[Q3] fork only recognised `error`, so every
 * `interrupted` / `aborted` turn — exactly what a restart produces — was
 * reported as a success. Only `completed` succeeds; `error` fails; everything
 * else (including a future reason kind this build has never seen) is
 * `interrupted`, because "unknown outcome" must never read as "done".
 */
export function classifyTurnEnd(data: unknown): TurnEndVerdict {
  const kind = typeof data === 'object' && data !== null
    ? (data as { reason?: { kind?: unknown } }).reason?.kind
    : undefined
  if (kind === 'completed') return { outcome: 'succeeded', reason: 'completed' }
  if (kind === 'error') return { outcome: 'failed', reason: 'error' }
  return { outcome: 'interrupted', reason: typeof kind === 'string' && kind !== '' ? kind : 'unknown' }
}

// ---------------------------------------------------------------------------
// 卡执行工作区回落（D-3 + D-3b · 方案 `卡会话独立工作区-方案-20260921.md` §3.3）
//
// 事实前提（方案 §3.3(b) 取证）：账本里**全部存量卡**的 `workspaceId` 都是主工作区
// id（**无空值**），且本插件对 workspaceId 没有任何默认回落 ⇒ 不改就永远落主工作区。
// 主人 D-1 拍板：**不动账本数据，改插件行为**，于是：
//
//   apply     = 开关 && (W 为空 || W === M)
//   effective = apply ? (D 在工作区登记表里 ? D : W) : W
//
// W = 卡内 workspaceId，M = 主工作区 id（`mainWorkspaceId`，**只能显式配置**），
// D = 默认执行工作区 id（`defaultWorkspaceId`）。D 未配 / M 未配 / 登记表里查不到 D /
// 登记表读不到 / 开关关 ⇒ **一律用卡内值**并告警（三件套兜底，绝不因回落把卡跑挂）。
//
// ⚠️ 如实记的代价（方案 §3.3 末段）：不动账本 ⇒ **卡面上仍显示主工作区，只有执行会话
// 的落点变了**——「卡字段 ≠ 实际执行工作区」是已知不一致，设置项文案与交付报告都写明。
//
// 插入点（唯一）：本文件 `HostExecutionRunner.launch()`，硬校验/`create` 之前——
// 全插件只有这一处建会话（手动 run / rerun / 定时 recurring 都收敛到这里）。
// ---------------------------------------------------------------------------

/** 卡执行工作区回落的三件套设置。 */
export interface WorkspaceFallbackSettings {
  /** D · 默认执行工作区 id；空字符串 = 未配置（不启用回落）。 */
  readonly defaultWorkspaceId: string
  /** M · 主工作区 id；空字符串 = 未配置（"M 只能显式配置"，绝不隐式猜谁是主工作区）。 */
  readonly mainWorkspaceId: string
  /** 存量卡回落开关（默认开；关 = 行为与改造前完全一致）。 */
  readonly fallbackEnabled: boolean
}

/** 三件套的写死缺省（与设置 schema 的默认值同源语义：开关默认开、D/M 默认空 = 不启用）。 */
export const WORKSPACE_FALLBACK_DEFAULTS: WorkspaceFallbackSettings = {
  defaultWorkspaceId: '',
  mainWorkspaceId: '',
  fallbackEnabled: true,
}

/** 判定理由（告警文案与单测共用；不要把字符串散落在两处）。 */
export type WorkspaceFallbackReason =
  | 'switch-off'
  | 'default-unset'
  | 'main-unset'
  | 'card-explicit-other'
  | 'card-empty'
  | 'card-main'
  | 'default-not-registered'
  | 'registry-unreadable'
  | 'applied'

/** 判据结果：`apply` 只看三件套与卡内值，与登记面无关。 */
export interface WorkspaceFallbackDecision {
  readonly apply: boolean
  readonly reason: WorkspaceFallbackReason
}

/** 把设置通道来的原始值收敛成三件套（`undefined` 走缺省，字符串 trim）。 */
export function normalizeWorkspaceFallback(input?: Partial<WorkspaceFallbackSettings> | undefined): WorkspaceFallbackSettings {
  const text = (value: string | undefined): string => (typeof value === 'string' ? value.trim() : '')
  return {
    defaultWorkspaceId: text(input?.defaultWorkspaceId),
    mainWorkspaceId: text(input?.mainWorkspaceId),
    fallbackEnabled: input?.fallbackEnabled ?? WORKSPACE_FALLBACK_DEFAULTS.fallbackEnabled,
  }
}

/** 卡内值归一化：空串/空白视作"未指定"。 */
function normalizeWorkspaceId(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * 回落判据（方案 §3.3(b) **写死**；唯一实现，单测直接打它）：
 * `apply = 开关 && (W 为空 || W === M)`。
 *
 * M 未配 ⇒ 整个回落不启用（方案原文「`mainWorkspaceId` 默认空 = 不启用回落」），
 * 卡内**显式非主工作区**的值恒优先（方案 §3.3「优先级」）。
 * @param cardWorkspaceId - 卡内 workspaceId（W）。
 * @param settings - 三件套设置（已 normalize）。
 * @returns 是否应用回落，以及理由。
 */
export function decideWorkspaceFallback(
  cardWorkspaceId: string | undefined,
  settings: WorkspaceFallbackSettings,
): WorkspaceFallbackDecision {
  if (!settings.fallbackEnabled) return { apply: false, reason: 'switch-off' }
  if (settings.defaultWorkspaceId === '') return { apply: false, reason: 'default-unset' }
  if (settings.mainWorkspaceId === '') return { apply: false, reason: 'main-unset' }
  const card = normalizeWorkspaceId(cardWorkspaceId)
  if (card === undefined) return { apply: true, reason: 'card-empty' }
  if (card === settings.mainWorkspaceId) return { apply: true, reason: 'card-main' }
  return { apply: false, reason: 'card-explicit-other' }
}

/** {@link resolveEffectiveWorkspaceId} 的结果（结构化，便于单测逐项断言）。 */
export interface EffectiveWorkspaceResolution {
  /** 真正交给 `create` 的工作区 id（`undefined` = 不指派，宿主用运行时默认）。 */
  readonly workspaceId: string | undefined
  /** 判据是否 apply（登记面兜底之前的值）。 */
  readonly applied: boolean
  readonly reason: WorkspaceFallbackReason
}

/**
 * 解析本次执行真正使用的工作区 id：`effective = apply ? (D 命中 ⇒ D) : W`。
 *
 * 登记面兜底（方案 §3.3(b)「D 缺失/未配/开关关 ⇒ 一律用卡内值并告警」）：
 * `lookup(D)` 返回 `null` 表示登记面读不到（按"未知"处理，**保守退回卡内值**），
 * 返回 `false` 表示 D 确实不在登记表里 ⇒ 同样退回卡内值 + 告警。
 * @param input - 卡内值、三件套、登记面查询函数与告警出口。
 * @returns 生效的工作区 id + 是否 apply + 理由。
 */
export function resolveEffectiveWorkspaceId(input: {
  readonly cardWorkspaceId: string | undefined
  readonly settings: WorkspaceFallbackSettings
  readonly lookup: (workspaceId: string) => boolean | null
  /** 告警出口（第二个参数是理由，供调用方按理由去重）。 */
  readonly warn?: (message: string, reason: WorkspaceFallbackReason) => void
}): EffectiveWorkspaceResolution {
  const card = normalizeWorkspaceId(input.cardWorkspaceId)
  const decision = decideWorkspaceFallback(input.cardWorkspaceId, input.settings)
  if (!decision.apply) return { workspaceId: card, applied: false, reason: decision.reason }
  const target = input.settings.defaultWorkspaceId
  let registered: boolean | null
  try {
    registered = input.lookup(target)
  } catch {
    // 登记面自己抛错也必须按"读不到"处理：绝不因回落把卡跑挂。
    registered = null
  }
  if (registered === null) {
    input.warn?.(`workspace fallback skipped: the workspace registry could not be read, so the card's own workspace ${card ?? '(none)'} is used instead of default ${target}`, 'registry-unreadable')
    return { workspaceId: card, applied: true, reason: 'registry-unreadable' }
  }
  if (!registered) {
    input.warn?.(`workspace fallback skipped: default workspace ${target} is not registered on this machine, so the card's own workspace ${card ?? '(none)'} is used instead`, 'default-not-registered')
    return { workspaceId: card, applied: true, reason: 'default-not-registered' }
  }
  return { workspaceId: target, applied: true, reason: 'applied' }
}

/**
 * `workspace.list 含 D ? D : W` 的**本地等价面**：本机工作区登记表
 * `<DSH_HOME>\storages\workspace.json` 里的工作区 id 集合。
 *
 * 为什么用文件而不是 `workspace.list` RPC：0.1.5 线**没有**一次性列表端点
 * （`tools\lib\dsh-host-rpc.mjs` 的 `REMOVED_ENDPOINTS`），而 `workspace.json`
 * 已被 CW-3 卡定为登记面的**权威源**（`global.workspaceIds` + `tables.workspaces`）；
 * 0.1.1 线的 `workspace.list` 硬校验仍然保留在 `launchLegacy` 里（双保险）。
 * @param file - 登记表文件（测试可注入）。
 * @returns id 集合；文件缺失/解析失败/结构不对 ⇒ `null`（= 未知，调用方不得据此回落）。
 */
export function readRegisteredWorkspaceIds(file: string = join(dshHome(), 'storages', 'workspace.json')): Set<string> | null {
  let mtimeMs: number
  let size: number
  try {
    const st = statSync(file)
    mtimeMs = st.mtimeMs
    size = st.size
  } catch {
    registryCache = undefined
    return null
  }
  if (registryCache !== undefined && registryCache.file === file && registryCache.mtimeMs === mtimeMs && registryCache.size === size) {
    return registryCache.ids
  }
  let ids: Set<string> | null = null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { tables?: { workspaces?: unknown } }
    const table = parsed.tables?.workspaces
    if (typeof table === 'object' && table !== null && !Array.isArray(table)) ids = new Set(Object.keys(table))
  } catch {
    ids = null
  }
  registryCache = { file, mtimeMs, size, ids }
  return ids
}

/** 登记表解析缓存（按 mtime + size 失效；只缓存解析结果这一个事实）。 */
let registryCache: { file: string; mtimeMs: number; size: number; ids: Set<string> | null } | undefined

export class HostExecutionRunner {
  /** Set on the first call that finds no usable session service, so it warns once. */
  private apiWarned = false
  /** 卡执行工作区回落设置（由 host-service 从设置通道同步；缺省 = 不启用）。 */
  private workspaceFallback: WorkspaceFallbackSettings = WORKSPACE_FALLBACK_DEFAULTS
  /** 回落退化告警去重（同一理由只告警一次，避免每次 run 刷屏）。 */
  private readonly fallbackWarned = new Set<string>()
  /** 跨实例客户端（按 target.id 缓存；base 变了重建 —— 换实例必须换 cookie）。 */
  private readonly remoteClients = new Map<string, { client: RemoteHostClient; base: string }>()
  /** 跨实例降级告警去重（同一句话只告警一次，避免每 5 秒一刷）。 */
  private readonly remoteWarned = new Set<string>()
  /** G-1 卡面档位告警去重（键 = 整句；档位是锦上添花，不许刷屏）。 */
  private readonly cardEffortWarned = new Set<string>()
  /** 最近一次派活的目标选择理由（诊断可回读；并发派活下只作参考，权威记录在 runs.jsonl）。 */
  private lastTargetReason: string | undefined
  /**
   * 卡 `结算fallback根因修复`（2026-11-09）· `asOfSeq` 采样器：
   * sessionId → { 该会话日志当前 seq, **最后一次看到它变化的时刻** }。
   *
   * 为什么要有它：`updatedAt` 只跟 turn 边界走，一个 turn 跑十几分钟时全程不动
   * ⇒ 拿它当「静默计时」的基准会把真干完的卡判成 `interrupted`。`asOfSeq` 跟**事件**
   * 走（0.2.2 实测：`updatedAt` 停在 23:38:40 时 `asOfSeq` 已到 621 = 末条 `turn/end`），
   * 所以「它最后一次变化的时刻」就是真正的事件最后活动时刻。
   *
   * 键集上限 4,000（≈ 会话总数 5 倍）；超了整体清空 —— 丢采样只是让下一次采样当
   * 「首次观测」处理（保守方向），不会造成误结算。
   */
  private readonly seqSamples = new Map<string, { seq: number; at: number }>()
  /** `sessionId → 该会话日志文件路径`（`null` = 找不到）。只缓存路径，mtime 每次现 stat。 */
  private readonly sessionLogPaths = new Map<string, { path: string | null; at: number }>()

  /**
   * 同步三件套设置（设置页保存后热生效：index.ts 的 sync() → host-service → 这里）。
   * @param settings - 原始设置值（`undefined` 走缺省）。
   */
  setWorkspaceFallback(settings?: Partial<WorkspaceFallbackSettings>): void {
    this.workspaceFallback = normalizeWorkspaceFallback(settings)
  }

  /** 当前生效的三件套（只读，供探针/单测断言）。 */
  workspaceFallbackSettings(): WorkspaceFallbackSettings {
    return this.workspaceFallback
  }

  /** 退化告警（去重键 = 理由 + 目标 id）。 */
  private warnFallbackOnce(reason: string, message: string): void {
    if (this.fallbackWarned.has(reason)) return
    this.fallbackWarned.add(reason)
    console.warn(`[dsh-task-board] ${message}`)
  }

  constructor(
    private readonly resolveApi: () => ApiProxy | null,
    private readonly commands?: SessionCommandDispatcher,
    private readonly resolveNewSession: ResolveNewLineSessionApi = () => null,
    private readonly resolveDefaultModel: ResolveDefaultModel = () => null,
  ) {}

  /**
   * Resolve the 0.1.5-line session service for this call (late binding).
   *
   * `null` means "this host line does not offer a usable new session surface":
   * either the service is missing (0.1.1 line) or its shape is incomplete. The
   * caller then falls back to the legacy proxy, and raises
   * {@link ApiProxyUnavailableError} when neither line exists.
   */
  private newSession(): NewLineSessionApi | null {
    try {
      return asNewLineSessionApi(this.resolveNewSession())
    } catch {
      // A throwing probe must never break boot or a run attempt: treat as absent.
      return null
    }
  }

  /** Raise the shared "no session service on this host line" failure (warns once). */
  private unavailable(): never {
    if (!this.apiWarned) {
      this.apiWarned = true
      console.warn(`[dsh-task-board] ${new ApiProxyUnavailableError().message}`)
    }
    throw new ApiProxyUnavailableError()
  }

  /**
   * Resolve the legacy `apiProxy` service for this call.
   *
   * Late binding + fail loud: `apiProxy` exists on the 0.1.1 line (behaviour
   * unchanged), and does not exist on 0.1.5+ where it was split into
   * per-domain services. A missing service must never surface as a silent
   * `undefined` — an execution attempt that cannot run says so explicitly.
   */
  private api(): ApiProxy {
    const api = this.resolveApi()
    if (api === null) this.unavailable()
    return api
  }

  /** HTTP base of the running Host (test instances set DSH_WEB_URL). */
  private base(): string {
    return process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
  }

  /**
   * 本机 HTTP base（多实例配置的 `localBase`；§4.4.4 归档链读配置时也用这个值）。
   * 与 {@link baseFor} 同源 —— 唯一目的是**别在第二处重写**这个表达式。
   */
  localBase(): string {
    return this.base()
  }

  /**
   * B1 · `baseFor(target)` — 一个执行宿主的 HTTP base。
   *
   * `local` / `undefined` ⇒ **现状值**（`DSH_WEB_URL` 优先，其次 `127.0.0.1:3080`），
   * 与改造前逐字节相同；`http` ⇒ 配置里登记的 `target.base`。
   *
   * ⚠️ `local` 的 base **永远**由运行时决定，绝不取配置文件里的值 —— 生产 home 的
   * `config.json` 里 `local.base` 写的是 `http://127.0.0.1:3080`，测试实例若读到它会打到生产。
   */
  private baseFor(target: MultiTarget | undefined): string {
    if (target === undefined || target.kind === 'local') return this.base()
    return target.base
  }

  /** 读多实例配置（fail-safe：缺失 / 非法 ⇒ local-only + `degraded` 说明）。 */
  private multiInstance(): { config: MultiInstanceConfig; degraded: string | null; paths: MultiInstancePaths } {
    const loaded = loadMultiInstanceConfig({ localBase: this.base() })
    return { config: loaded.config, degraded: loaded.degraded, paths: multiInstancePaths() }
  }

  /**
   * 是否启用了多实例（**只有 >1 个 target 才算**）。
   *
   * 这条短路是"零行为变化"的守门人：配置缺失 / 只配了本机 ⇒ 全程不探测、不发任何跨实例
   * 请求、`launch` 与 `inspect` 走改造前的老路。
   */
  multiInstanceEnabled(): boolean {
    return this.multiInstance().config.targets.length > 1
  }

  /** 当前生效的多实例配置视图（诊断用；不回显 cookie）。 */
  multiInstanceSnapshot(): { targets: MultiTarget[]; degraded: string | null; lastTargetReason: string | undefined } {
    const { config, degraded } = this.multiInstance()
    return { targets: config.targets, degraded, lastTargetReason: this.lastTargetReason }
  }

  /** 该 target 的跨实例客户端（按 id 缓存；降级告警去重）。 */
  private remoteClient(target: MultiTarget): RemoteHostClient {
    const cached = this.remoteClients.get(target.id)
    if (cached !== undefined && cached.base === target.base) return cached.client
    const client = new RemoteHostClient(target, 8_000, (message) => {
      if (this.remoteWarned.has(message)) return
      this.remoteWarned.add(message)
      console.warn(`[dsh-task-board] ${message}`)
    })
    this.remoteClients.set(target.id, { client, base: target.base })
    return client
  }

  /**
   * A1 · 探测一个候选实例的实况（供选择 / 反查 / 判活三处**共用一次读**）。
   *
   * `local` ⇒ 现有读法（0.1.5 进程内 `sessionController.list`，回落 HTTP 信封）；
   * `http` ⇒ 跨实例 `POST /api/session/list`。
   * 不可读 ⇒ `known:false` —— 调用方只能读作"不知道"，**绝不**读作"没有该会话"。
   *
   * @param only - 本次**真正关心**的会话 id。只有它们才会去 stat 本机日志文件
   *   （mtime 源）；不给 ⇒ 不算 mtime（asOfSeq / updatedAt 两源照常）。
   *   为什么必须限定：`session.list` 一次回 750 行，逐行扫目录是不可接受的 IO。
   */
  private async probeTarget(target: MultiTarget, only?: ReadonlySet<string>): Promise<TargetProbe> {
    const index = target.kind === 'local'
      ? await this.listSessionLiveness(only)
      : await this.livenessFromRemote(target)
    return {
      target,
      known: index.known,
      runningIds: index.running,
      listed: index.listed,
      lastActivity: index.lastActivity ?? new Map<string, number>(),
      ...(index.advancing === undefined ? {} : { advancing: index.advancing }),
    }
  }

  /** A1 · 按配置顺序探测全部候选（候选仅 2~3 个，串行以避免并发压同一进程）。 */
  async probeTargets(only?: ReadonlySet<string>): Promise<TargetProbe[]> {
    const { config } = this.multiInstance()
    const out: TargetProbe[] = []
    for (const target of config.targets) out.push(await this.probeTarget(target, only))
    return out
  }

  /**
   * B4 · **只对指定 target** 读一次会话索引。
   *
   * ⚠️ 判决语义写死（方案 §4.3 `B4`）：`known` 是**单 index 的全局布尔**，
   * owner 不可读 ⇒ `known:false` ⇒ 调用方保持 pending。
   * **禁止**把多实例的 known 做 union / 逻辑或 —— 那会把还在跑的卡结算成 `interrupted`。
   *
   * 跨实例不吃「本机日志 mtime」（文件在对端，不为此开 SSH）⇒ 该源留空，由
   * `asOfSeq` 采样与 `updatedAt` 兜住。
   */
  private async livenessFromRemote(target: MultiTarget): Promise<SessionLivenessIndex> {
    const empty: SessionLivenessIndex = { known: false, running: new Set(), listed: new Set() }
    const index = await this.remoteClient(target).listSessions()
    if (index === null) return empty
    const rows: SessionListRow[] = index.rows.map(row => ({
      sessionId: row.sessionId,
      running: row.running,
      ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
      ...(row.asOfSeq === undefined ? {} : { asOfSeq: row.asOfSeq }),
    }))
    return this.livenessFromRows(rows)
  }

  /** 判活读数入口：`target` 缺省 / `local` ⇒ 现状路径；`http` ⇒ 跨实例（B4）。 */
  async livenessFor(target: MultiTarget | undefined): Promise<SessionLivenessIndex> {
    if (target === undefined || target.kind === 'local') return this.listSessionLiveness()
    return this.livenessFromRemote(target)
  }

  /**
   * 卡 `结算fallback根因修复` · 把一行会话摘要变成"真实最后活动时刻"。
   *
   * 三源取 max（越晚越保守），缺哪个就跳过哪个：
   * 1. `logMtimeMs` —— 本机日志文件 mtime（**最硬的绝对时刻**，一次 stat 即得，
   *    不依赖采样历史，所以 DSH 重启后第一次轮询就有效）；
   * 2. `lastSeqAt` —— `asOfSeq` 最后一次变化的时刻（跟事件走，跨实例同样可用）；
   * 3. `updatedAt` —— 旧行为，最后兜底。
   *
   * `advancing` 单独收：本轮相对上一次采样**推进过**的会话 —— 这是 fallback 的硬闸。
   */
  private livenessFromRows(rows: readonly SessionListRow[], only?: ReadonlySet<string>): SessionLivenessIndex {
    const now = Date.now()
    const running = new Set<string>()
    const listed = new Set<string>()
    const advancing = new Set<string>()
    const evidence: ActivityEvidence[] = []
    for (const row of rows) {
      listed.add(row.sessionId)
      if (row.running) running.add(row.sessionId)
      const lastSeqAt = this.noteSeq(row.sessionId, row.asOfSeq, now)
      if (lastSeqAt.advanced) advancing.add(row.sessionId)
      // mtime 只对「本次真正关心」的会话读：列表一次回 750 行，逐行扫目录不可接受。
      const mtime = only?.has(row.sessionId) === true ? this.sessionLogMtime(row.sessionId) : undefined
      evidence.push({
        sessionId: row.sessionId,
        ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
        ...(row.asOfSeq === undefined ? {} : { asOfSeq: row.asOfSeq }),
        ...(lastSeqAt.at === undefined ? {} : { lastSeqAt: lastSeqAt.at }),
        ...(mtime === undefined ? {} : { logMtimeMs: mtime }),
      })
    }
    return { known: true, running, listed, lastActivity: combineLastActivity(evidence), advancing }
  }

  /**
   * 记一次 `asOfSeq` 采样，回答「它最后一次变化的时刻」和「这次是不是刚变」。
   *
   * 🔴 **首次观测不给时刻**（返回 `at: undefined`）：那时没有"上一次"可比，把 `now`
   * 当成活动时刻会让它盖过日志 mtime（`combineLastActivity` 取 max），后果有两个 ——
   * ① 本机日志明明停在 20 分钟前、却因为"我刚看了一眼"而永远不兜底；② 事后再查历史
   * 会话时得到的是"查询那一刻"，读数失真。交给 mtime / `updatedAt` 兜底才是准的；
   * 下一轮采样起，`asOfSeq` 自己就有基线了。
   */
  private noteSeq(sessionId: string, asOfSeq: number | undefined, now: number): { at?: number; advanced: boolean } {
    if (asOfSeq === undefined) return { advanced: false }
    const prev = this.seqSamples.get(sessionId)
    if (prev === undefined) {
      if (this.seqSamples.size >= 4_000) this.seqSamples.clear()
      // `at: 0` = 「有基线但还不知道它什么时候动过」，与「此刻活着」严格区分开。
      this.seqSamples.set(sessionId, { seq: asOfSeq, at: 0 })
      return { advanced: false }
    }
    if (isActivityAdvancing(prev.seq, asOfSeq)) {
      this.seqSamples.set(sessionId, { seq: asOfSeq, at: now })
      return { at: now, advanced: true }
    }
    return { at: prev.at > 0 ? prev.at : undefined, advanced: false }
  }

  /**
   * 一条执行会话的日志文件 mtime（epoch ms），拿不到 ⇒ `undefined`。
   *
   * 布局（现查）：`<home>\sessions\<cwd-slug>\<sessionId>\session.v{3,4}.jsonl{,.zstd}`。
   * slug 是 cwd 的编码，**不反推**——直接遍历顶层 slug 目录找 `<sessionId>` 那一级
   * （本机 12 个目录，毫秒级），找到后缓存路径；mtime 每次现 stat（缓存 mtime 等于没缓存）。
   */
  private sessionLogMtime(sessionId: string): number | undefined {
    const path = this.sessionLogPath(sessionId)
    if (path === null) return undefined
    try {
      const stat = statSync(path)
      return stat.mtimeMs > 0 ? stat.mtimeMs : undefined
    } catch {
      // 文件被归档/搬走 ⇒ 下次重新定位。
      this.sessionLogPaths.delete(sessionId)
      return undefined
    }
  }

  /** 会话日志路径（命中/未命中都缓存 30 s；只缓存路径，mtime 由调用方现读）。 */
  private sessionLogPath(sessionId: string): string | null {
    const now = Date.now()
    const cached = this.sessionLogPaths.get(sessionId)
    if (cached !== undefined && now - cached.at < SESSION_LOG_PATH_TTL_MS) return cached.path
    let found: string | null = null
    try {
      const root = join(dshHome(), 'sessions')
      for (const slug of readdirSync(root, { withFileTypes: true })) {
        if (!slug.isDirectory()) continue
        const dir = join(root, slug.name, sessionId)
        let files: string[]
        try {
          files = readdirSync(dir)
        } catch {
          continue // 该 slug 下没有这个会话
        }
        const log = files.filter(name => name.startsWith('session.v') && name.includes('jsonl')).sort().pop()
        if (log !== undefined) {
          found = join(dir, log)
          break
        }
      }
    } catch {
      found = null // sessions 根不可读（测试环境 / 早期版本）⇒ 当作"本机没有这个源"
    }
    this.sessionLogPaths.set(sessionId, { path: found, at: now })
    return found
  }

  /**
   * B2 · 反查一个执行会话的 owner（顺序**写死**，不做并发各查一次）。
   *
   * ① `runs.jsonl` 按 `sessionId` 取派活时登记过的 `target.id` ⇒ 命中即 owner；
   * ② 未命中（老卡 / 流水缺失）⇒ 在**已经探测过的**候选实况里找"列表里有该 sessionId"的那一个；
   * ③ 都没有 ⇒ `undefined` ⇒ 调用方按 `B4` 的"不可读"处理（保持 pending，**不结算**）。
   */
  async resolveOwner(sessionId: string, probes: readonly TargetProbe[]): Promise<MultiTarget | undefined> {
    const { config, paths } = this.multiInstance()
    const fromRuns = ownerFromRuns(paths.runsFile, sessionId)
    if (fromRuns !== undefined) {
      const hit = config.targets.find(t => t.id === fromRuns)
      if (hit !== undefined) return hit
    }
    const scanned = ownerFromProbes(sessionId, probes)
    if (scanned === undefined) return undefined
    return config.targets.find(t => t.id === scanned)
  }

  /** 该 target 在候选里的实况（`undefined` = 本轮没探到它）。 */
  static probeOf(probes: readonly TargetProbe[], targetId: string): TargetProbe | undefined {
    return probes.find(p => p.target.id === targetId)
  }

  /**
   * Start one execution session, on whichever host line this process runs.
   *
   * Card `升级 B2b`: the 0.1.5 line is tried first (`ctx.sessionController`),
   * the 0.1.1 proxy second, and "neither" fails loud. The order matters on a
   * line that mounts both: the new surface is the one the Host itself uses.
   */
  async launch(task: TaskRecord, hooks: LaunchHooks = {}): Promise<string> {
    // 卡执行工作区回落（D-3 + D-3b）在这里解析，且**只在这里**：`launch` 是全插件
    // 唯一的建会话入口（手动 run / rerun / 定时 recurring 都收敛到此），硬校验与
    // `create` 都在下游用解析后的值。DSH 重启恢复只结算、不重建会话，故不会二次改派。
    const resolved = resolveEffectiveWorkspaceId({
      cardWorkspaceId: task.workspaceId,
      settings: this.workspaceFallback,
      lookup: (workspaceId) => {
        const ids = readRegisteredWorkspaceIds()
        return ids === null ? null : ids.has(workspaceId)
      },
      warn: (message, reason) => { this.warnFallbackOnce(reason, message) },
    })
    const effective: TaskRecord = resolved.workspaceId === task.workspaceId
      ? task
      : { ...task, ...(resolved.workspaceId === undefined ? { workspaceId: undefined } : { workspaceId: resolved.workspaceId }) }

    // ── A1/A2 · 执行宿主解析（方案 §4.2） ──
    // **零行为变化守门人**：配置缺失 / 只配了本机 ⇒ 与改造前逐字节相同（连探测都不做）。
    const { config, degraded } = this.multiInstance()
    if (config.targets.length <= 1) {
      this.lastTargetReason = degraded === null ? '本机执行（未配置远端实例）' : `本机执行（多实例配置回落：${degraded}）`
      return this.launchLocal(effective)
    }
    const probes = await this.probeTargets()
    const picked = selectTarget(probes)
    this.lastTargetReason = picked.reason
    if (picked.target.kind === 'local') {
      const sessionId = await this.launchLocal(effective)
      await this.notifyLaunch(hooks, sessionId, picked.target, picked.reason)
      return sessionId
    }
    return this.launchRemote(picked.target, effective, picked.reason, hooks)
  }

  /** 本机派活（改造前的两条路，原样）：0.1.5 服务优先，legacy proxy 兜底。 */
  private async launchLocal(task: TaskRecord): Promise<string> {
    const newLine = this.newSession()
    if (newLine !== null) return this.launchNewLine(newLine, task)
    return this.launchLegacy(this.api(), task)
  }

  /** 调 A3 登记钩子；钩子抛错**只告警**，绝不中断派活（会话已建，抛错只会让它变孤儿）。 */
  private async notifyLaunch(hooks: LaunchHooks, sessionId: string, target: MultiTarget, reason: string): Promise<void> {
    if (hooks.onSession === undefined) return
    try {
      await hooks.onSession({ sessionId, target, reason })
    } catch (error) {
      console.error(`[dsh-task-board][multi-instance] 会话身份登记失败（sessionId=${sessionId} · target=${target.id}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * G-1 · 卡面档位落点（harness 成本与路由线 · 主人 2026-10-16 拍板）。
   *
   * 三步：读卡面档位 → 与基线比对（{@link planCardEffort}）→ 调一次 `session/selectModel`，
   * 随后把**全局默认档**写回基线（治理 `selectModel` 自带的 `saveSelection` 副作用，
   * 见 {@link DefaultModelBridge}）。
   *
   * 🔴 fail-open：本方法**从不抛**。卡会话已经建好了 —— 设档失败是"没省到钱"，而让它把
   * 卡拖成 `failed` 是"停摆"，两者不对等。
   * @param task - 正在派活的卡。
   * @param sessionId - 已建好的执行会话。
   * @param api - 本机 0.1.5 会话服务。
   */
  private async applyCardEffort(task: TaskRecord, sessionId: string, api: NewLineSessionApi): Promise<void> {
    if (readCardReasoningEffort(task.description) === undefined) return
    const selector = api.selectModel
    if (typeof selector !== 'function') {
      this.warnCardEffortOnce(`本机会话服务不提供 selectModel，卡面档位未应用（task=${task.id}）`)
      return
    }
    const bridge = this.defaultModelBridge()
    const plan = planCardEffort({
      description: task.description,
      sessionId,
      base: bridge === null ? null : bridge.read(),
      canRestore: bridge !== null,
    })
    if (plan.kind === 'skip') {
      if (plan.reason === 'no-baseline') {
        this.warnCardEffortOnce(`读不到全局默认模型选择，卡面档位未应用（task=${task.id}）`)
      }
      return
    }
    try {
      await selector.call(api, plan.request)
    } catch (error) {
      this.warnCardEffortOnce(`卡面档位应用失败（fail-open，不拦派活）：task=${task.id} · ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (plan.restore === null || bridge === null) return
    try {
      await bridge.restore(plan.restore)
    } catch (error) {
      this.warnCardEffortOnce(`全局默认档回写失败（默认档可能停在卡面档位）：task=${task.id} · ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * G-1 · 跨实例派活的档位：**本版不做**，只留一行可见告警（不假装支持）。
   *
   * 三个原因：① 对端基线选择要先调 `session/modelCatalog` 才拿得到，那条 Remote 本卡没实测；
   * ② 就算调成功，回写**对端**默认档也没有通道（`selectModel` 的 `saveSelection` 落在对端
   * 进程内）⇒ 会把对端实例的默认档永久带偏；③ 多实例配置为"只有本机"时这条路径根本不会走。
   * ⇒ 宁可明确不支持，也不做一次没验证过的远程写。
   * @param target - 本次选中的远端实例。
   * @param task - 正在派活的卡。
   */
  private noteRemoteCardEffortSkipped(target: MultiTarget, task: TaskRecord): void {
    if (readCardReasoningEffort(task.description) === undefined) return
    this.warnCardEffortOnce(`跨实例派活不应用卡面档位（target=${target.id} · task=${task.id}）：本版只覆盖本机执行`)
  }

  /** 探测全局默认模型桥（缺失 ⇒ `null`：档位功能整体降级）。 */
  private defaultModelBridge(): DefaultModelBridge | null {
    try {
      return this.resolveDefaultModel()
    } catch {
      // A throwing probe must never break a run attempt: treat as "no such capability".
      return null
    }
  }

  /** G-1 告警（去重键 = 整句）。 */
  private warnCardEffortOnce(message: string): void {
    if (this.cardEffortWarned.has(message)) return
    this.cardEffortWarned.add(message)
    console.warn(`[dsh-task-board][card-effort] ${message}`)
  }

  /**
   * A2~A5 · 跨实例派活（remote 分支）。
   *
   * 顺序**写死**：`session/create` → **登记会话身份** → **A5 权限硬门** → `session/prompt`。
   * 登记排在硬门之前是有意的：会话一旦建出来，就必须能被 `B2` 反查到（拒派会让卡落
   * `failed`，但那个会话**确实存在**于目标实例上；不登记就成孤儿会话）。
   *
   * remote 请求头（方案 §4.2 `A2` 写死）：`content-type: application/json` + cookie，
   * **不带 `Origin`、也不带 `sec-fetch-site`** —— 由 {@link RemoteHostClient} 统一保证。
   *
   * 失败一律抛 {@link SessionLaunchError}（带 `sessionId` ⇒ 账本仍能 attach 并落 `failed`），
   * **不得静默**（方案 `A4` + 家规"失败不许静默"）。
   */
  private async launchRemote(target: MultiTarget, task: TaskRecord, reason: string, hooks: LaunchHooks): Promise<string> {
    const client = this.remoteClient(target)
    // ⚠️ **卡内 `workspaceId` 永不跨实例传**（2026-10-09 P1b 实测）：工作区 id 是本机私有的，
    // 传过去只会回 `workspace/not-found` 并让卡落 failed（第一次端到端就是这么红的）。
    // 只有 target 自己登记过 `workspaceId`（该实例上真实存在的工作区）才传。
    const created = await client.createSession({
      ...(target.workspaceId === undefined ? {} : { workspaceId: target.workspaceId }),
      ...(task.mode === undefined ? {} : { agentPreset: task.mode }),
    })
    const sessionId = readRemoteSessionId(created.value)
    if (sessionId === undefined) {
      throw new Error(`remote session create returned no session id (target=${target.id} · http=${created.http} · ${created.error?.code ?? ''} ${created.error?.message ?? ''})`)
    }
    await this.notifyLaunch(hooks, sessionId, target, reason)
    try {
      // ── A5 校验点②（硬门）· 建会话后、派 prompt 前 ──
      const reading = await readRemotePermissions(client, sessionId, { startedAt: Date.now() })
      const verdict = checkRemotePermissions({
        required: task.permission,
        registeredPreset: target.permissionPreset,
        registeredApproval: target.approvalPolicy,
        actual: reading,
      })
      if (!verdict.ok) {
        const message = `目标实例权限硬门拒绝派活：${verdict.reason}（实例 ${target.id}）`
        console.error(`[dsh-task-board][multi-instance] ${message} · sessionId=${sessionId} · task=${task.id} · 实际读数 preset=${reading.permissionPreset ?? 'null'} sandbox=${reading.sandboxMode ?? 'null'} approval=${reading.approvalPolicy ?? 'null'}`)
        this.recordRefusal(target, task, sessionId, message)
        throw new Error(message)
      }
      // G-1：跨实例**本版不做**档位（理由见 noteRemoteCardEffortSkipped）—— 只留一行可见告警。
      this.noteRemoteCardEffortSkipped(target, task)
      const prompt = await client.promptSession({
        requestId: newLineRequestId(),
        sessionId,
        mode: 'queue' as const,
        content: [{ type: 'text' as const, text: task.prompt !== '' ? task.prompt : task.title }],
      })
      if (!prompt.ok) {
        throw new Error(`remote session prompt rejected (target=${target.id} · http=${prompt.http}): ${prompt.error?.code ?? ''} ${prompt.error?.message ?? ''}`)
      }
    } catch (error) {
      throw error instanceof SessionLaunchError ? error : new SessionLaunchError(sessionId, error)
    }
    return sessionId
  }

  /**
   * A5 拒派的留痕（本插件的"写 alert"落点）。
   *
   * 三处可见：① 卡的失败原因（GUI 卡面）；② `console.error`（宿主日志）；
   * ③ `runs.jsonl` 一条 `event:"refused"` 流水（**可回读**，方案 `A5` 要求的"写 alert"）。
   */
  private recordRefusal(target: MultiTarget, task: TaskRecord, sessionId: string, reason: string): void {
    const { paths } = this.multiInstance()
    const failure = appendRunEntry(paths.runsFile, { sessionId, taskId: task.id, executionId: '', target: target.id, event: 'refused', reason })
    if (failure !== null) console.error(`[dsh-task-board][multi-instance] 拒派留痕写入失败：${failure}`)
  }

  /**
   * 0.1.5 line: `sessionController.create` → `rename` → [permission] → `prompt`.
   *
   * Unlike the legacy path there is **no `workspace.list` / `agentPresets.list`
   * pre-check**: the new service validates both itself (`workspace/<id> not
   * found` on `create`, the preset through `agents.ensureSession`) and the
   * 0.1.5 closure exposes no equivalent "list workspaces" call on the session
   * domain. Failing inside `create` reaches the same ledger outcome (execution
   * settled `failed` with the message) — the board never sees a silent no-op.
   */
  private async launchNewLine(api: NewLineSessionApi, task: TaskRecord): Promise<string> {
    const created = await api.create({
      ...(task.workspaceId === undefined ? {} : { workspaceId: task.workspaceId }),
      ...(task.mode === undefined ? {} : { agentPreset: task.mode }),
    })
    const sessionId = readCreatedSessionId(created)
    if (sessionId === undefined) {
      throw new Error('session create returned no session id (0.1.5 sessionController)')
    }
    try {
      await api.rename({ sessionId, title: task.title })
      if (task.permission !== undefined) {
        if (this.commands === undefined) throw new Error('permission command dispatcher is unavailable')
        const command = await this.commands.execute(sessionId, `/permission ${task.permission}`, AbortSignal.timeout(30_000))
        if (command === undefined) throw new Error('permission command was not acknowledged')
        if (command.kind !== 'success') throw new Error(command.text ?? 'permission command failed')
      }
      // G-1：卡面档位必须排在 `prompt` **之前** —— `selectModel` 的语义是「下一次请求
      // 生效」，排在 prompt 之后第一轮就白跑了。fail-open：本方法自己不抛。
      await this.applyCardEffort(task, sessionId, api)
      await api.prompt({
        requestId: newLineRequestId(),
        sessionId,
        mode: 'queue' as const,
        content: [{ type: 'text' as const, text: task.prompt !== '' ? task.prompt : task.title }],
      }, AbortSignal.timeout(30_000))
    } catch (error) {
      throw new SessionLaunchError(sessionId, error)
    }
    return sessionId
  }

  /** 0.1.1 line: the legacy `apiProxy` RPC sequence, unchanged. */
  private async launchLegacy(api: ApiProxy, task: TaskRecord): Promise<string> {
    if (task.workspaceId !== undefined) {
      const workspaces = await api.workspace.list(request({}))
      if (!workspaces.result.ok) throw failure(workspaces.result.error)
      if (!workspaces.result.value.items.some(item => item.workspaceId === task.workspaceId)) {
        throw new Error(`workspace not found: ${task.workspaceId}`)
      }
    }
    if (task.mode !== undefined) {
      const presets = await api.agentPresets.list(request({}))
      if (!presets.result.ok) throw failure(presets.result.error)
      const preset = presets.result.value.presets.find(item => item.id === task.mode)
      if (preset === undefined) throw new Error(`agent preset not found: ${task.mode}`)
      if (preset.broken !== undefined) throw new Error(`agent preset is unavailable: ${preset.broken}`)
    }
    const created = await api.sessions.create(request({
      ...(task.workspaceId === undefined ? {} : { workspaceId: task.workspaceId as never }),
      ...(task.mode === undefined ? {} : { agentPreset: task.mode }),
    }))
    if (!created.result.ok) throw failure(created.result.error)
    const sessionId = created.result.value.sessionId
    try {
      const renamed = await api.sessions.rename(request({ sessionId, title: task.title }))
      if (!renamed.result.ok) throw failure(renamed.result.error)
      if (task.permission !== undefined) {
        if (this.commands === undefined) throw new Error('permission command dispatcher is unavailable')
        const command = await this.commands.execute(sessionId, `/permission ${task.permission}`, AbortSignal.timeout(30_000))
        if (command === undefined) throw new Error('permission command was not acknowledged')
        if (command.kind !== 'success') throw new Error(command.text ?? 'permission command failed')
      }
      const prompt = await api.sessions.prompt(request({
        sessionId,
        mode: 'queue' as const,
        content: [{ type: 'text' as const, text: task.prompt !== '' ? task.prompt : task.title }],
      }))
      if (!prompt.result.ok) throw failure(prompt.result.error)
    } catch (error) {
      throw new SessionLaunchError(sessionId, error)
    }
    return sessionId
  }

  async listRunning(): Promise<{ known: true; count: number; items: SessionSummary[] } | { known: false }> {
    try {
      // 0.1.5 line first: `sessionController.list` is the Host's own session
      // index. A shape this build does not recognise is reported as "unknown"
      // rather than silently read as "nothing is running".
      const newLine = this.newSession()
      if (newLine?.list !== undefined) {
        const rows = readSessionRows(await newLine.list({}, AbortSignal.timeout(8_000)))
        if (rows === null) return { known: false }
        return { known: true, count: rows.filter(row => row.running).length, items: rows as unknown as SessionSummary[] }
      }
      // No apiProxy on this host line ⇒ report "unknown", exactly like an
      // unreadable list. Callers must never settle an execution on a guess,
      // and polling must not spam the console on every 5 s tick.
      const api = this.resolveApi()
      if (api === null) return { known: false }
      const response = await api.sessions.list(request({}))
      return response.result.ok
        ? { known: true, count: response.result.value.items.filter(item => item.running).length, items: response.result.value.items }
        : { known: false }
    } catch {
      return { known: false }
    }
  }

  /**
   * Read the live session index — 0.1.5 service first, HTTP envelope second.
   *
   * The liveness gate needs every session, not just the controller tree:
   * `apiProxy.sessions.list` only returns controller-tree sessions, so the
   * unattended execution sessions created through the proxy are missing from
   * it (the same reason {@link inspect} reads session history over HTTP).
   * `sessionController.list` has no such restriction, and needs no HTTP
   * round-trip (nor the 0.1.5 line's token gate).
   * Failure is reported as `known: false` so callers keep cards running
   * rather than settling on a guess.
   */
  async listSessionLiveness(only?: ReadonlySet<string>): Promise<SessionLivenessIndex> {
    const empty: SessionLivenessIndex = { known: false, running: new Set(), listed: new Set() }
    const viaNewLine = await this.livenessFromNewLine(only)
    if (viaNewLine !== null) return viaNewLine
    try {
      const res = await fetch(`${this.base()}/api/session.list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          method: 'session.list',
          rpcId: `taskboard-${Math.random().toString(36).slice(2)}`,
          payload: {},
        }),
        signal: AbortSignal.timeout(8_000),
      })
      const json = await res.json() as {
        result?: { ok?: boolean; value?: { items?: unknown } }
      }
      if (json?.result?.ok !== true) return empty
      const rows = readSessionRows(json.result.value)
      if (rows === null) return empty
      return this.livenessFromRows(rows, only)
    } catch {
      return empty
    }
  }

  /**
   * Session index off the 0.1.5 service, or `null` when this line cannot
   * answer (service missing, `list` absent, call rejected, shape unknown) —
   * the caller then reads the HTTP envelope exactly as before.
   */
  private async livenessFromNewLine(only?: ReadonlySet<string>): Promise<SessionLivenessIndex | null> {
    const newLine = this.newSession()
    if (newLine?.list === undefined) return null
    try {
      const rows = readSessionRows(await newLine.list({}, AbortSignal.timeout(8_000)))
      if (rows === null) return null
      return this.livenessFromRows(rows, only)
    } catch {
      return null
    }
  }

  /**
   * Resolve one execution's outcome.
   *
   * Local fork (ported from patch-taskboard-011): on DSH 0.1.1 the
   * `apiProxy.sessions.list` RPC only returns controller-tree sessions, so the
   * unattended execution session created through the proxy is never in the
   * list — a list-based lookup always resolved `cancelled: execution session
   * no longer exists` (and the list has a creation delay, so even a working
   * source raced). Read the session's own history through the HTTP envelope
   * instead: a readable history settles on the first `turn/end` after
   * `startedAt`; an unreadable history inside the 30s launch window stays
   * pending; past that window the session is treated as gone.
   *
   * Card `升级 B2b`: on the 0.1.5 line the history is read from
   * `sessionController.inspect` first (`{ meta, events: SessionEvent[] }`) —
   * the same durable log without an HTTP round-trip. The HTTP envelope stays
   * as the fallback (0.1.1 always, and any unexpected shape on 0.1.5).
   *
   * Card `0.1.5遗留·L19` (2026-09-24): between those two readers now sits the
   * line's **paged** reader (`sessionController.page`). The endpoint the HTTP
   * envelope talks to was removed on 0.1.5 — measured on this host, it answers
   * 404 even with a valid session cookie — so
   * that last-resort reader had become a guaranteed failure on the very line
   * that ships it. The order is deliberate: the whole-log `inspect` stays first
   * (its behaviour is what the board has settled cards with since B2b), the
   * paged reader catches what `inspect` cannot answer, and HTTP remains the
   * 0.1.1 line's only reader.
   *
   * Card [Q3]: the caller must have already cleared the liveness gate
   * (`isExecutionAlive` → `alive === false`) and passes `sessionEnded: true`.
   * With that flag an execution that never produced a completing turn resolves
   * `interrupted` instead of hanging as `pending` forever, and a `turn/end`
   * that did not complete resolves `interrupted` instead of `succeeded`.
   */
  async inspect(
    sessionId: string,
    startedAt = 0,
    options: { sessionEnded?: boolean; target?: MultiTarget } = {},
  ): Promise<ExecutionInspection> {
    // §4.3 B3：`http` 目标**只对 owner** 读（调用方已完成 owner 反查与判活），
    // 走跨实例 `session/page`；`local` / 未指定 ⇒ 改造前的三段读法原样。
    const read = options.target !== undefined && options.target.kind === 'http'
      ? await this.readHistoryFromRemote(options.target, sessionId, startedAt)
      : (await this.inspectFromNewLine(sessionId))
        ?? (await this.readPageFromNewLine(sessionId, startedAt))
        ?? (await this.readHistoryOverHttp(sessionId, startedAt))
    return this.outcomeFromHistory(read, startedAt, options.sessionEnded === true)
  }

  /**
   * 从一次历史读的结果判定执行结论。
   *
   * 本机与跨实例**共用同一套判据**（方案 §4.3 `B3`："沿用现有『首个 `turn/end` 判定』
   * 逻辑与 30s 启动宽限"）—— 抽出来是为了让两条传输路径不可能各自漂移。
   * 调用方必须已经清过判活闸门（`isExecutionAlive` → `alive === false`）并传 `sessionEnded: true`。
   */
  private outcomeFromHistory(read: HistoryRead, startedAt: number, sessionEnded: boolean): ExecutionInspection {
    if (read === 'transport-error') return { outcome: 'pending' }
    const { events, reachedExecutionBoundary, readFailed } = read
    const withinLaunchWindow = startedAt > 0 && Date.now() - startedAt < SESSION_START_GRACE_MS
    if (readFailed || events.length === 0) {
      if (withinLaunchWindow) return { outcome: 'pending' }
      return sessionEnded
        ? { outcome: 'interrupted', error: 'execution session ended with no readable history (interrupted before it ran — DSH restart or killed daemon)' }
        : { outcome: 'pending' }
    }
    const turnEnd = events
      .filter(entry => isTurnEnd(entry.event?.type) && (
        startedAt <= 0 || (typeof entry.event.time === 'number' && entry.event.time >= startedAt)
      ))
      .sort((a, b) => (a.event.seq ?? Number.MAX_SAFE_INTEGER) - (b.event.seq ?? Number.MAX_SAFE_INTEGER))[0]
    if (turnEnd === undefined) {
      // 窗口里没有 `turn/end`：**只有证明了边界**（确实翻到了本次执行起点）才能断定
      // "本轮没跑完"；边界没证明就只能是 pending。
      if (!reachedExecutionBoundary) return { outcome: 'pending' }
      // The session is gone but its history shows no completing turn: the
      // execution never finished, so it must not be reported as a success.
      return sessionEnded && !withinLaunchWindow
        ? { outcome: 'interrupted', error: 'execution session ended without a completed turn (interrupted — DSH restart or killed daemon)' }
        : { outcome: 'pending' }
    }
    // 🔴 卡 `结算fallback根因修复`（2026-11-09）：`turn/end` 是**本轮终止事件的硬证据**，
    // 读到它就不必再要求"边界已证明"。以前这条被 `!reachedExecutionBoundary ⇒ pending`
    // 挡在前面，于是"日志翻不全"直接盖过"我已经看见结论了"，长卡只能等 fallback 误杀。
    const verdict = classifyTurnEnd(turnEnd.event.data)
    if (verdict.outcome === 'failed') return { outcome: 'failed', error: 'agent turn ended with an error' }
    if (verdict.outcome === 'interrupted') {
      return { outcome: 'interrupted', error: `agent turn ended without completing (turn/end reason: ${verdict.reason})` }
    }
    return { outcome: 'succeeded' }
  }

  /**
   * B3 · 跨实例读一个执行会话的历史（**只对 owner 调**）。
   *
   * ⚠️ 端点选择是实测结论，不是偏好：0.1.5 上 `session.history` **404**（订正档 ④）、
   * `session.inspect` 也 **404**（本模块实测 ⑧）⇒ 唯一可用读者是 `session/page`，
   * 且**必须带真 cursor**（`throughSeq:-1` 恒返回空 —— 本模块实测 ⑦）。
   * 读不到 ⇒ `'transport-error'` ⇒ 调用方保持 `pending`（**绝不猜结论**）。
   */
  private async readHistoryFromRemote(target: MultiTarget, sessionId: string, startedAt: number): Promise<HistoryRead> {
    const remote = await this.remoteClient(target).readHistory(sessionId, startedAt)
    if (remote === null) return 'transport-error'
    return { events: remote.events, reachedExecutionBoundary: remote.reachedExecutionBoundary, readFailed: false }
  }

  /**
   * Read one session's durable log off the 0.1.5 service.
   *
   * ⚠️ 0.2.2-rc.1 起 `sessionController.inspect` **已不存在**（类原型面上没有这个方法，
   * HTTP `/api/session/inspect` 也 404；2026-11-08 实测）⇒ 本方法在新宿主上恒 `null`，
   * **`session/page` 是唯一活跃读者**。别再追"为什么 inspect 不生效"——真源见
   * 结算兜底的根因诊断（0.2.2 线）§1.2。
   *
   * `null` = this line cannot answer (no `inspect` on the service, the call
   * rejected — e.g. the session is unknown — or the answer has a shape this
   * build does not classify) ⇒ the caller reads the HTTP envelope instead,
   * exactly as it did before this card.
   *
   * `sessionController.inspect` returns the whole contiguous log from seq 0,
   * so the execution boundary is reached by definition (the HTTP reader pages
   * backwards and has to prove it reached the boundary — that proof is
   * unnecessary here).
   */
  private async inspectFromNewLine(sessionId: string): Promise<HistoryRead | null> {
    const newLine = this.newSession()
    if (newLine?.inspect === undefined) return null
    try {
      const events = readInspectionEvents(await newLine.inspect(sessionId, AbortSignal.timeout(8_000)))
      if (events === null) return null
      return { events, reachedExecutionBoundary: true, readFailed: false }
    } catch {
      return null
    }
  }

  /**
   * Learn one session's log cursor for the paged reader.
   *
   * `page` needs a real cursor — `throughSeq` must be ≤ the session's own, and
   * `-1` (which the validator accepts) paginates to an empty slice, so there is
   * no "give me the tail" value. The cursor is therefore learned from the
   * rejection of a deliberately over-large probe (`gateway/bad-request … past
   * cursor N` on 0.1.5, `session history cut … exceeds N` on 0.2.2 — both
   * recognized by {@link cursorFromRejection}).
   *
   * `null` = anything else came back (the probe was accepted, the message
   * carries no cursor, the cursor is negative) ⇒ "this line cannot answer",
   * never a guessed cursor.
   */
  private async pageCursor(newLine: NewLineSessionApi, sessionId: string): Promise<number | null> {
    const page = newLine.page
    if (page === undefined) return null
    try {
      await page.call(newLine, {
        address: { kind: 'session', sessionId },
        throughSeq: SESSION_CURSOR_PROBE,
        maxMessages: 1,
      }, AbortSignal.timeout(HISTORY_PAGE_TIMEOUT_MS))
      return null
    } catch (error) {
      const cursor = cursorFromRejection(error)
      return cursor === undefined || cursor < 0 ? null : cursor
    }
  }

  /**
   * Read one session's durable log through the 0.1.5 line's **paged** reader.
   *
   * `null` = this line cannot answer (no `page` on the service, no cursor, a
   * rejected call, a shape this build does not classify) ⇒ the caller falls
   * back exactly as it did before this card.
   *
   * The pagination mirrors {@link readHistoryOverHttp} step for step: the same
   * page size, the same "walk back until the page reports no more, or its
   * oldest stamp reaches `startedAt`" boundary proof, and the same per-entry
   * `push` — never a spread, because one page can carry >100k events (127,614
   * measured once) and spreading that many arguments throws `RangeError`,
   * which the enclosing catch used to swallow as "no history at all".
   */
  private async readPageFromNewLine(sessionId: string, startedAt: number): Promise<HistoryRead | null> {
    const newLine = this.newSession()
    const page = newLine === null ? undefined : newLine.page
    if (newLine === null || page === undefined) return null
    const cursor = await this.pageCursor(newLine, sessionId)
    if (cursor === null) return null
    const events: HistoryEvents = []
    let beforeSeq: number | undefined
    let reachedExecutionBoundary = false
    try {
      for (let round = 0; round < HISTORY_MAX_PAGES; round += 1) {
        const read = readPageRecords(await page.call(newLine, {
          address: { kind: 'session', sessionId },
          throughSeq: cursor,
          maxMessages: HISTORY_PAGE_MESSAGES,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        }, AbortSignal.timeout(HISTORY_PAGE_TIMEOUT_MS)))
        if (read === null) return null
        for (const entry of read.events) events.push(entry)
        const oldestTime = read.events.reduce<number | undefined>((oldest, entry) => {
          const time = entry.event?.time
          return typeof time !== 'number' ? oldest : oldest === undefined ? time : Math.min(oldest, time)
        }, undefined)
        const oldestSeq = read.events.reduce<number | undefined>((oldest, entry) => {
          const seq = entry.event?.seq
          return typeof seq !== 'number' ? oldest : oldest === undefined ? seq : Math.min(oldest, seq)
        }, undefined)
        // 到达边界的三条判据（2026-11-09 补第三条）：页里最老的 time 到达 startedAt、
        // 页报告没有更多、或最老 seq 已是 0（日志开头）。
        // ⚠️ 实测 `oldestTime <= startedAt` **经常够不到**（卡 `dd6e00ea`：该会话最老事件
        // 23:38:34 比 startedAt 23:38:31 还晚）⇒ 以前全靠 `hasMore === false` 单腿站；
        // `oldestSeq === 0` 是同一件事的更硬证据，不该被漏掉。
        if (read.hasMore !== true || (oldestTime !== undefined && oldestTime <= startedAt) || oldestSeq === 0) {
          reachedExecutionBoundary = true
          break
        }
        if (oldestSeq === undefined || oldestSeq === beforeSeq) break
        beforeSeq = oldestSeq
      }
    } catch {
      return null
    }
    return { events, reachedExecutionBoundary, readFailed: false }
  }

  /**
   * Read one session's durable log through the Host HTTP envelope.
   *
   * Card `0.1.5遗留·L19` (2026-09-24): this is now the **0.1.1 line's only**
   * history reader. On 0.1.5 the endpoint it talks to was removed — measured on
   * this host: 404 even with a valid session cookie — while
   * {@link readPageFromNewLine} serves that line. 0.1.1 never ships the session
   * service at all, so the fallback has to stay for it.
   *
   * Unchanged behaviour (pre-B2b): a transport failure resolves
   * `'transport-error'` so the caller keeps the execution pending exactly as
   * before; an answered-but-refused read sets `readFailed`, which the caller
   * resolves to `pending` inside the launch window and `interrupted` after it.
   */
  private async readHistoryOverHttp(sessionId: string, startedAt: number): Promise<HistoryRead> {
    const base = this.base()
    const events: HistoryEvents = []
    let beforeSeq: number | undefined
    let reachedExecutionBoundary = false
    let readFailed = false
    try {
      for (let page = 0; page < 100; page += 1) {
        const res = await fetch(`${base}/api/${LEGACY_HISTORY_METHOD}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            method: LEGACY_HISTORY_METHOD,
            rpcId: `taskboard-${Math.random().toString(36).slice(2)}`,
            payload: { sessionId, maxMessages: 100, ...(beforeSeq === undefined ? {} : { beforeSeq }) },
          }),
          signal: AbortSignal.timeout(8_000),
        })
        const json = await res.json() as {
          result?: { ok?: boolean; value?: { events?: typeof events; hasMore?: boolean } }
        }
        if (json?.result?.ok !== true) {
          readFailed = true
          break
        }
        const value = json.result.value ?? {}
        const pageEvents = value.events ?? []
        // Never `events.push(...pageEvents)`: a single page of a huge session can
        // carry >100k events (measured once: 127,614 events in one page), and
        // spreading that many arguments throws
        // `RangeError: Maximum call stack size exceeded`. The throw used to be
        // swallowed by this function's catch and surfaced as `pending`, which
        // left the card running for ever.
        for (const entry of pageEvents) events.push(entry)
        const oldestTime = pageEvents.reduce<number | undefined>((oldest, entry) => {
          const time = entry.event?.time
          return typeof time !== 'number' ? oldest : oldest === undefined ? time : Math.min(oldest, time)
        }, undefined)
        const oldestSeq = pageEvents.reduce<number | undefined>((oldest, entry) => {
          const seq = entry.event?.seq
          return typeof seq !== 'number' ? oldest : oldest === undefined ? seq : Math.min(oldest, seq)
        }, undefined)
        // 与 readPageFromNewLine 同款三条判据（含 2026-11-09 补的 `oldestSeq === 0`）：
        // 两条传输路径的边界证明必须逐条一致，否则本机与跨实例会各自漂移。
        if (value.hasMore !== true || (oldestTime !== undefined && oldestTime <= startedAt) || oldestSeq === 0) {
          reachedExecutionBoundary = true
          break
        }
        if (oldestSeq === undefined || oldestSeq === beforeSeq) break
        beforeSeq = oldestSeq
      }
    } catch {
      return 'transport-error'
    }
    return { events, reachedExecutionBoundary, readFailed }
  }
}
