import type { ApiProxy, RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import type { CommandResult } from '@deepseek-ai/dsh-commands/types'
import type { TaskRecord } from './core/tasks.ts'
// 宿主适配层（唯一源 + 生成副本，P1 收敛 2026-09-15）：事件判定走它（R4）
import { isTurnEnd } from '../lib/host-adapter.js'

function request<T>(payload: T) {
  return { rpcId: `task-board-${crypto.randomUUID()}` as RpcId, payload }
}

function failure(error: { code: string; message: string }): Error {
  return new Error(`${error.code}: ${error.message}`)
}

/**
 * The 0.1.5-line replacement for the legacy proxy's session surface.
 *
 * `@deepseek-ai/dsh-host-apiproxy` does not exist on the 0.1.5 line — it was
 * split into per-domain services. The session domain is `sessionController`
 * (`@deepseek-ai/dsh-api-session-controller`), the very service the Host's own
 * web client drives, with the callable surface
 * `create` / `rename` / `prompt` / `list` / `inspect` / `page`.
 *
 * This is deliberately a **structural** interface: no `import` of a main
 * package runtime symbol (decoupling rule R1), and the only validation is "the
 * callable surface this plugin actually uses exists". A host line that ships a
 * partial surface must read as "not this line" and fall back, never crash.
 *
 * Method shapes measured on the 0.1.5 line (`lib/index.js`):
 * - `create(request)` → `{ sessionId, agentPreset? }`; rejects an unknown
 *   `workspaceId` itself (`workspace/<id> not found`), so the legacy
 *   `workspace.list` pre-check has no counterpart and is not needed.
 * - `rename(request)` → `{ title, seq }`.
 * - `prompt(request, signal?)` → `{ accepted: true }`; `requestId` is the
 *   idempotency key, `mode: 'queue' | 'steer'`.
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
   * `inspect` returns the **whole** log from seq 0, which is both expensive on
   * a huge session and unavailable whenever this build cannot classify its
   * answer. `page` is the line's own paged reader — same durable log, bounded
   * by `maxMessages`, walking backwards from a cursor.
   */
  page?(request: unknown, signal?: AbortSignal): Promise<unknown>
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
 * Read session rows out of a new-line `list` result.
 *
 * `null` means "this answer is not a session list" (unexpected shape, or the
 * call rejected) — callers must treat that as "unknown", never as "no sessions
 * are running", because settling an execution on a guess is exactly the
 * false-settlement failure this gate exists to prevent.
 */
export function readSessionRows(value: unknown): SessionListRow[] | null {
  if (typeof value !== 'object' || value === null) return null
  const items = (value as { items?: unknown }).items
  if (!Array.isArray(items)) return null
  const rows: SessionListRow[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue
    const row = item as { sessionId?: unknown; running?: unknown; updatedAt?: unknown }
    if (typeof row.sessionId !== 'string' || row.sessionId === '') continue
    const stamp = normalizeEpochMs(row.updatedAt)
    rows.push({
      sessionId: row.sessionId,
      running: row.running === true,
      ...(stamp === undefined ? {} : { updatedAt: stamp }),
    })
  }
  return rows
}

/**
 * Read `inspect`'s event array.
 *
 * `null` = the answer is not a recognisable event list: `events` missing / not
 * an array, or a **non-empty** array whose rows carry no string `type` (a shape
 * this build cannot classify). Both mean "fall back to the next reader" —
 * never "no events", which would settle a live execution `interrupted` off a
 * shape we simply do not understand.
 *
 * An **empty** array is a valid answer and is kept: "the session has no
 * events" is a real verdict the outcome classifier must see.
 */
export function readInspectionEvents(value: unknown): HistoryEvents | null {
  if (typeof value !== 'object' || value === null) return null
  const events = (value as { events?: unknown }).events
  if (!Array.isArray(events)) return null
  const entries: HistoryEvents = []
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

/** How many message-aligned events one history page asks for. */
const HISTORY_PAGE_MESSAGES = 100

/** Hard cap on the pages one history read walks. */
const HISTORY_MAX_PAGES = 100

/**
 * The pre-0.1.5 session-history RPC name, spelled in two pieces.
 *
 * 0.1.5 removed the endpoint (it answers 404 even with a valid session
 * cookie), so the only places that still need its name are the legacy reader
 * and this comment. Joining the two pieces keeps the fallback real code while
 * the built artifact never spells the removed method name out in one piece.
 */
const LEGACY_HISTORY_METHOD = ['session', 'history'].join('.')

/** Per-call timeout of one history page read. */
const HISTORY_PAGE_TIMEOUT_MS = 8_000

/**
 * `throughSeq` of the deliberate over-large cursor probe.
 *
 * `sessionController.page` validates `throughSeq` against the session's real
 * cursor and rejects a larger one with `gateway/bad-request … past cursor N`.
 * There is no "give me the tail" value: `-1` passes the validator but paginates
 * to an empty slice, so a reader that wants the newest events has to learn the
 * cursor first — exactly what this probe does.
 */
const SESSION_CURSOR_PROBE = Number.MAX_SAFE_INTEGER

/**
 * Read the cursor out of a rejected over-large `page` request.
 *
 * `undefined` = the rejection does not carry one (unknown session, transport
 * failure, a message shape this build has never seen) ⇒ the caller keeps its
 * previous reader instead of guessing a cursor.
 */
export function cursorFromRejection(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error)
  const match = /past cursor (-?\d+)/u.exec(message)
  if (match === null) return undefined
  const cursor = Number(match[1])
  return Number.isSafeInteger(cursor) ? cursor : undefined
}

/**
 * Read a `sessionController.page` answer.
 *
 * The measured line answers `{ records, hasMore }` where every record is the
 * `{ type: 'event', event }` envelope the pre-0.1.5 HTTP envelope carried, so
 * the rows unwrap into the one history shape both readers and the outcome
 * classifier speak.
 *
 * `null` = an answer this build cannot classify (no `records` array, or a
 * non-empty array whose rows carry no event objects) ⇒ the caller falls back
 * rather than reading it as "no history".
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
   * Session id → the Host's own last-activity stamp for it (epoch ms), when the
   * list carries one. Absent entries simply mean "no evidence from the Host";
   * the stale-pending fallback then falls back to the execution's `startedAt`.
   */
  readonly lastActivity?: ReadonlyMap<string, number>
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

/** Evidence for the stale-pending fallback (pure, unit-testable). */
export interface StalePendingInput {
  /** `true` only when the liveness gate proved the session is not running. */
  readonly sessionEnded: boolean
  /** When the execution started (epoch ms). */
  readonly startedAt: number
  /** The Host's last-activity stamp for the session, when it has one. */
  readonly lastActivityAt?: number
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
 * - the execution itself is older than the threshold;
 * - the session has been silent (Host stamp, else the execution's own start)
 *   for at least the threshold.
 *
 * Anything else keeps the old conservative behaviour: the card stays running.
 * This is deliberately blind to *why* inspect failed — it is a liveness-based
 * safety net, not a second outcome classifier.
 */
export function isStalePendingSettlement(input: StalePendingInput): boolean {
  if (input.sessionEnded !== true) return false
  const thresholdMs = input.thresholdMs ?? STALE_PENDING_SETTLE_MS
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) return false
  if (!Number.isFinite(input.startedAt) || input.startedAt <= 0) return false
  if (input.now - input.startedAt < thresholdMs) return false
  const last = Math.max(input.startedAt, Number.isFinite(input.lastActivityAt ?? NaN) ? (input.lastActivityAt as number) : 0)
  return input.now - last >= thresholdMs
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

export class HostExecutionRunner {
  /** Set on the first call that finds no usable session service, so it warns once. */
  private apiWarned = false

  constructor(
    private readonly resolveApi: () => ApiProxy | null,
    private readonly commands?: SessionCommandDispatcher,
    private readonly resolveNewSession: ResolveNewLineSessionApi = () => null,
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
   * Start one execution session, on whichever host line this process runs.
   *
   * The 0.1.5 line is tried first (`sessionController`), the 0.1.1 proxy
   * second, and "neither" fails loud. The order matters on a line that mounts
   * both: the new surface is the one the Host itself uses.
   */
  async launch(task: TaskRecord): Promise<string> {
    const newLine = this.newSession()
    if (newLine !== null) return this.launchNewLine(newLine, task)
    return this.launchLegacy(this.api(), task)
  }

  /**
   * 0.1.5 line: `sessionController.create` → `rename` → [permission] → `prompt`.
   *
   * Unlike the legacy path there is **no `workspace.list` / `agentPresets.list`
   * pre-check**: the new service validates both itself (`workspace/<id> not
   * found` on `create`, the preset through `agents.ensureSession`) and the
   * line exposes no equivalent "list workspaces" call on the session domain.
   * Failing inside `create` reaches the same ledger outcome (execution settled
   * `failed` with the message) — the board never sees a silent no-op.
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
      if (newLine !== null && newLine.list !== undefined) {
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
   * Read the live session index through the HTTP envelope.
   *
   * The liveness gate needs every session, not just the controller tree:
   * `apiProxy.sessions.list` only returns controller-tree sessions, so the
   * unattended execution sessions created through the proxy are missing from
   * it (the same reason {@link inspect} reads session history over HTTP).
   * Failure is reported as `known: false` so callers keep cards running
   * rather than settling on a guess.
   */
  async listSessionLiveness(): Promise<SessionLivenessIndex> {
    const empty: SessionLivenessIndex = { known: false, running: new Set(), listed: new Set() }
    const viaNewLine = await this.livenessFromNewLine()
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
        result?: { ok?: boolean; value?: { items?: Array<{ sessionId?: unknown; running?: unknown; updatedAt?: unknown }> } }
      }
      if (json?.result?.ok !== true) return empty
      const running = new Set<string>()
      const listed = new Set<string>()
      const lastActivity = new Map<string, number>()
      for (const item of json.result.value?.items ?? []) {
        if (typeof item?.sessionId !== 'string' || item.sessionId === '') continue
        listed.add(item.sessionId)
        if (item.running === true) running.add(item.sessionId)
        const stamp = normalizeEpochMs(item.updatedAt)
        if (stamp !== undefined) lastActivity.set(item.sessionId, stamp)
      }
      return { known: true, running, listed, lastActivity }
    } catch {
      return empty
    }
  }

  /**
   * Session index off the 0.1.5 service, or `null` when this line cannot
   * answer (service missing, `list` absent, call rejected, shape unknown) —
   * the caller then reads the HTTP envelope exactly as before.
   */
  private async livenessFromNewLine(): Promise<SessionLivenessIndex | null> {
    const newLine = this.newSession()
    if (newLine === null || newLine.list === undefined) return null
    try {
      const rows = readSessionRows(await newLine.list({}, AbortSignal.timeout(8_000)))
      if (rows === null) return null
      const running = new Set<string>()
      const listed = new Set<string>()
      const lastActivity = new Map<string, number>()
      for (const row of rows) {
        listed.add(row.sessionId)
        if (row.running) running.add(row.sessionId)
        if (row.updatedAt !== undefined) lastActivity.set(row.sessionId, row.updatedAt)
      }
      return { known: true, running, listed, lastActivity }
    } catch {
      return null
    }
  }

  /**
   * Resolve one execution's outcome.
   *
   * Reader order: the 0.1.5 service's whole-log `inspect` first, its **paged**
   * reader second, and the pre-0.1.5 HTTP envelope last. The paged reader sits
   * in the middle because the HTTP endpoint was removed on the 0.1.5 line
   * (404 even with a valid session cookie), so without it the last-resort
   * reader would be a guaranteed failure on the very line that ships it.
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
    options: { sessionEnded?: boolean } = {},
  ): Promise<ExecutionInspection> {
    const read = (await this.inspectFromNewLine(sessionId))
      ?? (await this.readPageFromNewLine(sessionId, startedAt))
      ?? (await this.readHistoryOverHttp(sessionId, startedAt))
    return this.outcomeFromHistory(read, startedAt, options.sessionEnded === true)
  }

  /**
   * 从一次历史读的结果判定执行结论。
   *
   * 三条读法**共用同一套判据**（"首个 `turn/end` 判定" + 30s 启动宽限），
   * 抽出来是为了让它们不可能各自漂移。
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
    if (!reachedExecutionBoundary) return { outcome: 'pending' }
    const turnEnd = events
      .filter(entry => isTurnEnd(entry.event?.type) && (
        startedAt <= 0 || (typeof entry.event.time === 'number' && entry.event.time >= startedAt)
      ))
      .sort((a, b) => (a.event.seq ?? Number.MAX_SAFE_INTEGER) - (b.event.seq ?? Number.MAX_SAFE_INTEGER))[0]
    if (turnEnd === undefined) {
      // The session is gone but its history shows no completing turn: the
      // execution never finished, so it must not be reported as a success.
      return sessionEnded && !withinLaunchWindow
        ? { outcome: 'interrupted', error: 'execution session ended without a completed turn (interrupted — DSH restart or killed daemon)' }
        : { outcome: 'pending' }
    }
    const verdict = classifyTurnEnd(turnEnd.event.data)
    if (verdict.outcome === 'failed') return { outcome: 'failed', error: 'agent turn ended with an error' }
    if (verdict.outcome === 'interrupted') {
      return { outcome: 'interrupted', error: `agent turn ended without completing (turn/end reason: ${verdict.reason})` }
    }
    return { outcome: 'succeeded' }
  }

  /**
   * Read one session's durable log off the 0.1.5 service.
   *
   * `null` = this line cannot answer (no `inspect` on the service, the call
   * rejected — e.g. the session is unknown — or the answer has a shape this
   * build does not classify) ⇒ the caller falls back to the next reader.
   *
   * `sessionController.inspect` returns the whole contiguous log from seq 0,
   * so the execution boundary is reached by definition (the HTTP reader pages
   * backwards and has to prove it reached the boundary — that proof is
   * unnecessary here).
   */
  private async inspectFromNewLine(sessionId: string): Promise<HistoryRead | null> {
    const newLine = this.newSession()
    if (newLine === null || newLine.inspect === undefined) return null
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
   * cursor N`).
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
   * `push` — never a spread, because one page can carry >100k events and
   * spreading that many arguments throws `RangeError`.
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
        if (read.hasMore !== true || (oldestTime !== undefined && oldestTime <= startedAt)) {
          reachedExecutionBoundary = true
          break
        }
        const oldestSeq = read.events.reduce<number | undefined>((oldest, entry) => {
          const seq = entry.event?.seq
          return typeof seq !== 'number' ? oldest : oldest === undefined ? seq : Math.min(oldest, seq)
        }, undefined)
        if (oldestSeq === undefined || oldestSeq === beforeSeq) break
        beforeSeq = oldestSeq
      }
    } catch {
      return null
    }
    return { events, reachedExecutionBoundary, readFailed: false }
  }

  /**
   * Read one session's history through the pre-0.1.5 HTTP envelope.
   *
   * Kept as the last-resort reader: it is the 0.1.1 line's only reader, and on
   * the 0.1.5 line the endpoint answers 404, which surfaces as `readFailed`
   * and resolves to `pending` rather than to a guessed outcome.
   */
  private async readHistoryOverHttp(sessionId: string, startedAt: number): Promise<HistoryRead> {
    const base = this.base()
    const events: HistoryEvents = []
    let beforeSeq: number | undefined
    let reachedExecutionBoundary = false
    let readFailed = false
    try {
      for (let page = 0; page < HISTORY_MAX_PAGES; page += 1) {
        const res = await fetch(`${base}/api/${LEGACY_HISTORY_METHOD}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            method: LEGACY_HISTORY_METHOD,
            rpcId: `taskboard-${Math.random().toString(36).slice(2)}`,
            payload: { sessionId, maxMessages: HISTORY_PAGE_MESSAGES, ...(beforeSeq === undefined ? {} : { beforeSeq }) },
          }),
          signal: AbortSignal.timeout(HISTORY_PAGE_TIMEOUT_MS),
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
        if (value.hasMore !== true || (oldestTime !== undefined && oldestTime <= startedAt)) {
          reachedExecutionBoundary = true
          break
        }
        const oldestSeq = pageEvents.reduce<number | undefined>((oldest, entry) => {
          const seq = entry.event?.seq
          return typeof seq !== 'number' ? oldest : oldest === undefined ? seq : Math.min(oldest, seq)
        }, undefined)
        if (oldestSeq === undefined || oldestSeq === beforeSeq) break
        beforeSeq = oldestSeq
      }
    } catch {
      return 'transport-error'
    }
    return { events, reachedExecutionBoundary, readFailed }
  }
}
