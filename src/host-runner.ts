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
  /** Set on the first unavailable-apiProxy call so the warning is emitted once. */
  private apiWarned = false

  constructor(
    private readonly resolveApi: () => ApiProxy | null,
    private readonly commands?: SessionCommandDispatcher,
  ) {}

  /**
   * Resolve the `apiProxy` service for this call.
   *
   * Late binding + fail loud: `apiProxy` exists on the 0.1.1 line (behaviour
   * unchanged), and does not exist on 0.1.5+ where it was split into
   * per-domain services. A missing service must never surface as a silent
   * `undefined` — an execution attempt that cannot run says so explicitly.
   */
  private api(): ApiProxy {
    const api = this.resolveApi()
    if (api === null) {
      if (!this.apiWarned) {
        this.apiWarned = true
        console.warn(`[dsh-task-board] ${new ApiProxyUnavailableError().message}`)
      }
      throw new ApiProxyUnavailableError()
    }
    return api
  }

  /** HTTP base of the running Host (test instances set DSH_WEB_URL). */
  private base(): string {
    return process.env.DSH_WEB_URL || 'http://127.0.0.1:3080'
  }

  async launch(task: TaskRecord): Promise<string> {
    const api = this.api()
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
    const base = this.base()
    const events: Array<{ event: { type: string; seq?: number; time?: number; data: unknown } }> = []
    let beforeSeq: number | undefined
    let reachedExecutionBoundary = false
    let readFailed = false
    try {
      for (let page = 0; page < 100; page += 1) {
        const res = await fetch(`${base}/api/session.history`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            method: 'session.history',
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
      return { outcome: 'pending' }
    }
    const withinLaunchWindow = startedAt > 0 && Date.now() - startedAt < SESSION_START_GRACE_MS
    if (readFailed || events.length === 0) {
      if (withinLaunchWindow) return { outcome: 'pending' }
      return options.sessionEnded === true
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
      return options.sessionEnded === true && !withinLaunchWindow
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
}
