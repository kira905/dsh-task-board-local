/**
 * Agent-preset roster feed with explicit cross-line transport selection.
 *
 * Why this module exists: the roster used to be one unguarded call —
 * `ctx.get('connection').api.agentPresets.list({})`. That shape only exists on
 * the 0.1.1 line, where `ConnectionHandle` carries `api`. On the 0.1.5 line the
 * handle keeps only `isLoopback / generation / state / rpc / reconnect /
 * registerGenerationSource / start` (verified against
 * `@deepseek-ai/dsh-client-connection/lib/types/client/index.d.ts`), and the
 * same capability arrives as the `remote` service namespace mounted by
 * `@deepseek-ai/dsh-api-remotes`' client assembly
 * (`ctx.remote.$mount(agentPresetsRemote)` → `ctx.remote.agentPresets.list()`).
 * Reading the absent property threw
 * `TypeError: Cannot read properties of undefined (reading 'agentPresets')`,
 * and the caller's `try/catch` turned it into a single console line — the mode
 * picker just stayed empty. Silent under-delivery is the failure mode this
 * module exists to end, so the transport choice is explicit and every empty
 * read reports WHY it is empty.
 *
 * The two lines agree on the payload rows (`id / isDefault / name? /
 * description? / broken?`) but not on the envelope: the 0.1.1 RPC client wraps
 * the result (`{ result: RpcResult }`) while the Typert namespace resolves the
 * result directly (`RemoteResult`). One reader normalizes both, so no caller
 * carries a per-line branch of its own.
 */

/** One preset row the board's mode picker offers. */
export interface PresetOption {
  /** Stable preset id the card stores. */
  readonly id: string
  /** Display name; absent when the preset published none. */
  readonly name?: string | undefined
  /** One sentence on what the preset is for. */
  readonly description?: string | undefined
  /** Why the preset cannot compose a session; absent when it can. */
  readonly broken?: string | undefined
  /** Whether a session naming no preset composes this one. */
  readonly isDefault: boolean
}

/**
 * Old-line roster call: the `agentPresets` namespace on
 * `connection.api` (0.1.1 handle). Takes the request envelope the RPC client
 * expects — the empty object the previous call site passed.
 */
export interface ConnectionApiPresetsFace {
  /** @param request - RPC request parameters (this namespace takes none). */
  list(request: Record<string, never>): Promise<unknown>
}

/**
 * New-line roster call: the `agentPresets` namespace the Typert client
 * assembly mounts on the `remote` service (0.1.2+). Declared argument-less —
 * the generated namespace method carries no business parameter.
 */
export interface RemotePresetsFace {
  /** @returns the roster result envelope. */
  list(): Promise<unknown>
}

/** The `api` half of the 0.1.1 `ConnectionHandle`, read structurally. */
export interface ConnectionWithApiFace {
  /** Absent on the 0.1.5 handle — the case that used to throw. */
  readonly api?: { readonly agentPresets?: ConnectionApiPresetsFace | undefined } | undefined
}

/** The `remote` service face, narrowed to the namespace mount points read here. */
export interface RemoteServiceFace {
  /** Roster namespace; absent when this deployment mounts no preset contribution. */
  readonly agentPresets?: RemotePresetsFace | undefined
}

/** Both transports, already narrowed to the preset namespace. */
export interface PresetRosterTransports {
  /** 0.1.1 line; undefined when the handle exposes no `api`. */
  readonly connectionApi?: ConnectionApiPresetsFace | undefined
  /** 0.1.2+ line; undefined when the namespace is not mounted or not served. */
  readonly remote?: RemotePresetsFace | undefined
}

/** Which transport served — or should have served — a read. */
export type PresetTransport = 'connection-api' | 'remote'

/** Why a read produced no roster. */
export type PresetRosterFailureReason =
  /** Neither transport exists: nothing on this deployment can serve a roster. */
  | 'no-transport'
  /** The call itself rejected (transport or assembly fault). */
  | 'call-threw'
  /** The call resolved to a failure result (`ok: false`). */
  | 'rpc-failed'
  /** A successful result whose payload was not a roster. */
  | 'malformed'

/** Outcome of one roster read. */
export type PresetRosterRead =
  | { readonly ok: true, readonly transport: PresetTransport, readonly presets: readonly PresetOption[] }
  | { readonly ok: false, readonly transport: PresetTransport | 'none', readonly reason: PresetRosterFailureReason, readonly error?: unknown }

/** A read that produced no roster. */
export type PresetRosterFailure = Extract<PresetRosterRead, { ok: false }>

/**
 * Unwrap one transport's payload into a result envelope.
 *
 * Accepting both envelopes is deliberate: the shallow form is what the Typert
 * namespace resolves, the nested form is what the 0.1.1 RPC client returns, and
 * a reader that insisted on one of them would silently report `malformed` on
 * the other line.
 * @param payload - value the transport resolved to.
 * @returns the business result, or the reason it cannot be read.
 */
function unwrapResult(payload: unknown): { ok: true, value: unknown } | { ok: false, reason: 'rpc-failed' | 'malformed' } {
  if (payload === null || typeof payload !== 'object') return { ok: false, reason: 'malformed' }
  const outer = payload as { result?: unknown }
  const carrier = 'result' in outer ? outer.result : outer
  if (carrier === null || typeof carrier !== 'object') return { ok: false, reason: 'malformed' }
  const result = carrier as { ok?: unknown, value?: unknown }
  if (result.ok === true) return { ok: true, value: result.value }
  if (result.ok === false) return { ok: false, reason: 'rpc-failed' }
  return { ok: false, reason: 'malformed' }
}

/**
 * Narrow one roster value to picker options.
 *
 * Rows without a usable id are dropped rather than mapped: the picker stores
 * the id it renders, so a row that cannot be addressed would offer a choice the
 * board cannot honour.
 * @param value - decoded business value.
 * @returns the options, or undefined when the value is not a roster at all.
 */
function toPresetOptions(value: unknown): PresetOption[] | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const presets = (value as { presets?: unknown }).presets
  if (!Array.isArray(presets)) return undefined
  const options: PresetOption[] = []
  for (const row of presets) {
    if (row === null || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const id = record.id
    if (typeof id !== 'string' || id === '') continue
    options.push({
      id,
      name: typeof record.name === 'string' ? record.name : undefined,
      description: typeof record.description === 'string' ? record.description : undefined,
      broken: typeof record.broken === 'string' ? record.broken : undefined,
      isDefault: record.isDefault === true,
    })
  }
  return options
}

/**
 * Run one transport's call and normalize its outcome.
 * @param transport - label reported on failure.
 * @param call - transport-bound invocation.
 * @returns the read outcome; never rejects.
 */
async function invoke(transport: PresetTransport, call: () => Promise<unknown>): Promise<PresetRosterRead> {
  let payload: unknown
  try {
    payload = await call()
  } catch (error) {
    return { ok: false, transport, reason: 'call-threw', error }
  }
  const result = unwrapResult(payload)
  if (!result.ok) return { ok: false, transport, reason: result.reason }
  const presets = toPresetOptions(result.value)
  if (presets === undefined) return { ok: false, transport, reason: 'malformed' }
  return { ok: true, transport, presets }
}

/**
 * Read one transport face without letting a Cordis injection check abort the caller.
 *
 * Cordis resolves a service against the calling fiber and THROWS when the name is
 * not injected there ("cannot get property … without inject"). A client plugin's
 * `apply` must never throw for that reason: the web shell reports it as
 * `failed to apply loader entry` and skips the plugin entirely, so one
 * unreachable optional service would take the whole board UI down. Reading a
 * face this way degrades to "this transport is absent", which the reader already
 * reports.
 * @param read - thunk performing the service read.
 * @returns the face, or undefined when the read is refused.
 */
export function readTransportFace<T>(read: () => T | undefined): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

/**
 * Read the agent-preset roster from whichever transport this deployment serves.
 *
 * Order is old line first: `connection.api.agentPresets` exists only on 0.1.1,
 * so preferring it keeps that line's behaviour byte-for-byte, and the 0.1.5
 * handle simply has no `api` to prefer. The `remote` namespace is the fallback,
 * not a parallel path — one read, one transport reported.
 * @param transports - transport faces (undefined entries mean "not present").
 * @returns the roster, or a reason it is unavailable. Never rejects.
 */
export async function readPresetRoster(transports: PresetRosterTransports): Promise<PresetRosterRead> {
  const { connectionApi, remote } = transports
  if (connectionApi !== undefined && typeof connectionApi.list === 'function') {
    return await invoke('connection-api', () => connectionApi.list({}))
  }
  if (remote !== undefined && typeof remote.list === 'function') {
    return await invoke('remote', () => remote.list())
  }
  return { ok: false, transport: 'none', reason: 'no-transport' }
}

/**
 * One operator-facing line for a failed read.
 *
 * Every reason maps to a distinct, non-empty sentence on purpose: this is the
 * console output that replaces the swallowed TypeError, and an unreadable
 * roster must not be indistinguishable from an empty one.
 * @param read - failed read outcome.
 * @returns the message to log (without the plugin prefix).
 */
export function formatPresetRosterFailure(read: PresetRosterFailure): string {
  switch (read.reason) {
    case 'no-transport':
      return 'agent preset roster unavailable: neither connection.api.agentPresets (0.1.1) nor remote.agentPresets (0.1.2+) is present — the mode picker stays empty'
    case 'call-threw':
      return `agent preset roster read threw on the ${read.transport} transport`
    case 'rpc-failed':
      return `agent preset roster read failed on the ${read.transport} transport (host returned a failure result)`
    case 'malformed':
      return `agent preset roster read on the ${read.transport} transport returned no usable preset list`
  }
}

/**
 * Deduplication key for a failure, so a repeated no-transport read does not
 * flood the console while a genuinely new failure still gets reported.
 * @param read - failed read outcome.
 * @returns a stable key per (transport, reason) pair.
 */
export function presetRosterFailureKey(read: PresetRosterFailure): string {
  return `${read.transport}:${read.reason}`
}
