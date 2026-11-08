/**
 * Host loader entry for the task-board plugin.
 *
 * The Host owns the v2 ledger, action API, cron scheduler, session runner,
 * execution reconciliation, and optional idle-sleep inhibitor. The browser is
 * a same-origin asynchronous view over that service.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import z from 'schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { TaskBoardHostService } from './host-service.ts'
import { asNewLineSessionApi, type DefaultModelBridge, type ResolveDefaultModel, type ResolveNewLineSessionApi } from './host-runner.ts'
import { readSelectionLike } from './card-effort.ts'
import { makeTaskBoardRoutes } from './host-routes.ts'
import { mountOnce } from './mount-once.ts'
// Re-exported so the ledger's load-time recovery contract (card [账本陈旧串]:
// `scheduler.error` is recalculated per load, never replayed) can be exercised
// against the SHIPPED bundle in _test/, not just against the TypeScript source.
export { HostTaskLedger } from './host-ledger.ts'
// Re-exported for the same reason as the ledger: card [看板瘦身·K1]'s `scope=live`
// regression (J12) has to be asserted against the SHIPPED bundle, and the live
// filter lives in the service, not in the ledger.
//
// Card [看板瘦身·K2] adds `mergeBoardView` (方案 §3 D-10 option (a): `scope=all`
// stays the one place that knows the whole board) and the archive read routes,
// so both can be exercised against the shipped bundle instead of the sources.
export { TaskBoardHostService, mergeBoardView } from './host-service.ts'
// G28·P1b：执行宿主的失败语义与判活常量也一起放出去 —— 验收脚本要能对**产物**断言
// "派活失败抛的是带 sessionId 的 SessionLaunchError"（账本据此 attach + 落 failed）。
export { HostExecutionRunner, SessionLaunchError, SESSION_START_GRACE_MS, STALE_PENDING_SETTLE_MS } from './host-runner.ts'
export { makeTaskBoardRoutes, isTrustedTaskBoardRequest } from './host-routes.ts'
// Card [看板瘦身·K1] tooling surface: the archive store's file-level functions
// plus the shared DSH_HOME resolver, so `archive-cleanup.mjs` can plan and run a
// cleanup WITHOUT constructing a ledger — a dry run must not take the ledger
// lock or rewrite the board.
export {
  applyArchiveCleanup,
  buildArchiveIndex,
  listArchiveBatches,
  planArchiveCleanup,
  readArchiveIndex,
  summarizeArchive,
} from './host-archive-store.ts'
export { resolveDshHome } from './dsh-home.ts'
// G28·P1b（多实例分载）工具面：与上面 ledger / service 同理 —— 让 `_test` 与验收脚本能对
// **发布产物**断言"目标解析 / 权限硬门判据 / owner 反查 / 配置 fail-safe"，
// 而不是只测 TS 源（源测过了、产物没带上这类事故，只有打产物才抓得到）。
export {
  // §4.4.4 confirm → 归档链（2026-10-10 · 卡「冲刺600·补多实例」）：单测直接打这些符号。
  appendArchiveAlert,
  ARCHIVE_RUN_ROUTE,
  archiveSweepOnce,
  checkRemotePermissions,
  decideArchiveOutcome,
  DEFAULT_ARCHIVE_CHAIN,
  defaultMultiInstanceConfig,
  inferInstanceLogCandidates,
  latestLaunchToken,
  loadMultiInstanceConfig,
  markCardSessionConfirmed,
  multiInstancePaths,
  normalizeArchiveChain,
  ownerFromProbes,
  ownerFromRuns,
  pendingArchiveEntries,
  portOfBase,
  protectedSessionIds,
  readCardSessions,
  readLaunchTokens,
  readRemotePermissions,
  recordArchiveAttempt,
  seedPermissionsFromEvents,
  selectTarget,
  upsertCardSession,
  writeCardSessions,
  RemoteHostClient,
} from './multi-instance.ts'
// Cross-line settings wiring (see settings-compat.ts): kept in its own module
// with no runtime imports so the probe can be unit-tested directly.
import { installSettingsCompat } from './settings-compat.ts'
// 宿主适配层（唯一源 + 生成副本，P1 收敛 2026-09-15）：
// 服务名/事件名一律走它（R4）。⚠️ 该 import 在 tsdown 里被 `external` 保留为运行时依赖 ——
// 若被 inline 进 lib/index.js，产物里就重新出现裸字面量、且副本不再可校验。
import { SVC, service } from '../lib/host-adapter.js'

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 200

/** Default environment variable holding the authenticated proxy token. */
export const DEFAULT_PROXY_TOKEN_ENV = 'DSH_TASK_BOARD_PROXY_TOKEN'

/**
 * Static loader declarations.
 *
 * ⚠️ `apiProxy` is deliberately **absent** from this list (2026-09-14, card
 * `升级 B2` step ④). `@deepseek-ai/dsh-host-apiproxy` does not exist in the
 * 0.1.5 closure (it was split into per-domain services), and a static
 * declaration of a service the host never provides leaves this entry
 * permanently `pending` — i.e. `dsh: 1 entry did not activate`, which is
 * equivalent to a boot failure (measured on the canary with
 * `make-min-profile.mjs --keep dsh-task-board-local`).
 *
 * Card `升级 B2b` (2026-09-22) extends the same rule to the 0.1.5-line service
 * (`sessionController`, see {@link resolveSessionController}): both session
 * services are resolved at call time, and this list stays the **intersection**
 * of the two lines' service sets — declaring either one statically would break
 * boot on the other line (`apiProxy` is absent on 0.1.5, `sessionController` is
 * absent on 0.1.1).
 *
 * Both services are therefore resolved **at call time** via
 * {@link resolveApiProxy} / {@link resolveSessionController} (`ctx.get`, which
 * never throws when the service is missing — reading an undeclared service
 * *property* does throw in cordis). On the 0.1.1 line nothing changes: the
 * legacy service resolves and every call path behaves exactly as before. On a
 * line with neither, the board still boots — UI, ledger and the cron scheduler
 * stay functional — and only session execution (`run`/`rerun`) is disabled,
 * with an explicit error instead of a silent no-op.
 */
export const inject = [SVC.systemPrompt, SVC.webServer, SVC.agents, SVC.commands]

/**
 * Build a **late-binding** accessor for the 0.1.5-line session service
 * (`ctx.sessionController`, `@deepseek-ai/dsh-api-session-controller`).
 *
 * Card `升级 B2b` (2026-09-22): the legacy `apiProxy` domain was split into
 * per-domain services on the 0.1.5 line, and the session domain is
 * `sessionController` — the same service the Host's own web client drives.
 * This plugin now executes board sessions through it (`create` → `rename` →
 * `prompt`) and reads its session index (`list`) and logs (`inspect`).
 *
 * Deliberately **not** in `inject`: exactly like `apiProxy`, this service does
 * not exist on the other host line, and a static declaration of an absent
 * service leaves the entry permanently `pending` (= `1 entry did not
 * activate`, i.e. boot failure). The two lines are therefore resolved at call
 * time, and only the intersection of their service sets is declared statically.
 *
 * The returned accessor re-resolves on every call: at `apply` time neither
 * line is guaranteed to have registered the service yet, so probing once here
 * would bake a wrong answer into the runner for the whole process lifetime.
 */
export function resolveSessionController(ctx: Context): ResolveNewLineSessionApi {
  return () => {
    try {
      return asNewLineSessionApi(service(ctx as never, SVC.sessionController))
    } catch {
      // cordis throws on undeclared service properties; probing must never break boot.
      return null
    }
  }
}

/**
 * 全局默认模型服务的服务名（0.2.x 主包 `dsh-agent-default-model`：
 * `super(ownerContext, "agentDefaultModel")`，`lib/index.js`）。
 *
 * ⚠️ 刻意**不登记进 `SVC`**：`lib/host-adapter.js` 是「唯一源 + 生成副本」的共享件
 * （多个插件按同一份下发，改它要同步所有副本），而这里只是一条"缺了就降级"的可选探测，
 * 不属于宿主契约声明面（不进 `inject`、不参与语义调用）。
 */
const AGENT_DEFAULT_MODEL_SERVICE = 'agentDefaultModel'

/**
 * G-1 · 全局默认模型桥（harness 成本与路由线 · 主人 2026-10-16 拍板）。
 *
 * 为什么需要：平台的 `sessionController.selectModel` 在把**会话**档位设成卡面值时，
 * 顺带 `void agentDefaultModel.saveSelection(...)` 把同一个选择落成**全局默认**
 * （本机实测落在 `~/.dsh/settings.yaml.imported` 的 `agent-default-model` 段）。卡派活
 * "只调不还"会把主人下一个新会话带偏 ⇒ 调完必须把基线写回（`restore`）。
 *
 * 绝不进静态 `inject`：服务缺失时 entry 会永久 pending（= boot 崩）。这里用
 * `service()`（内部 `ctx.get`，探不到即 `null`）做存在性判定，探测失败一律当"没有这个
 * 能力" ⇒ 档位功能整体降级，派活不受影响。
 * @param ctx - the plugin context.
 * @returns a late-binding resolver; `null` = 宿主没有这个服务（或形态不符）。
 */
export function resolveDefaultModelBridge(ctx: Context): ResolveDefaultModel {
  return () => {
    try {
      const resolved = service(ctx as never, AGENT_DEFAULT_MODEL_SERVICE) as {
        currentSelection?: () => unknown
        saveSelection?: (selection: unknown) => Promise<unknown>
      } | null
      if (resolved === null) return null
      const current = resolved.currentSelection
      const save = resolved.saveSelection
      if (typeof current !== 'function' || typeof save !== 'function') return null
      const bridge: DefaultModelBridge = {
        read: () => readSelectionLike(current.call(resolved)),
        restore: async (selection) => { await save.call(resolved, { ...selection }) },
      }
      return bridge
    } catch {
      // Never let probing a missing/odd service break boot or a run attempt.
      return null
    }
  }
}

/**
 * Build a **late-binding** accessor for the `apiProxy` service.
 *
 * Resolution is per call on purpose: at `apply` time the service may not be
 * registered yet on either line, so probing once here would bake a wrong
 * answer into the runner for the whole process lifetime.
 */
export function resolveApiProxy(ctx: Context): () => import('@deepseek-ai/dsh-host-apiproxy').ApiProxy | null {
  return () => {
    try {
      const get = (ctx as unknown as { get?: (name: string) => unknown }).get
      if (typeof get !== 'function') return null
      const api = get.call(ctx, SVC.apiProxy)
      return (api ?? null) as import('@deepseek-ai/dsh-host-apiproxy').ApiProxy | null
    } catch {
      // cordis throws on undeclared service properties; never let probing break boot.
      return null
    }
  }
}

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const TASK_BOARD_GUIDANCE = '本机已安装 dsh-task-board-local 插件（DSH Web GUI 的任务看板，本地自建版）：侧边栏「任务看板」入口。能力：六列看板（待规划/待办/进行中/待验收/已完成/已失败）；人工验收闸门——执行会话结算成功只进「待验收」，必须人工点「验收通过」才进已完成（定时卡验收后回待办继续待命），点「打回」回待办并可附备注；卡片分三类 kind：once（一次性）/recurring（定时重复，跑完进待验收、验收后回待办）/interactive（交互式，禁加定时，须人工推进）；Host 权威账本；关闭浏览器后仍由 Host 执行和结算；任务可钉住工作区、agent 预设和权限；支持 Host 本地时区的 5 段 cron，错过的触发点不补跑；可选且默认关闭的空闲系统睡眠保护允许屏幕熄灭，但不承诺拦截合盖、手动睡眠、休眠、关机或唤醒已睡眠机器；已执行卡可补写备注（description），标题与 Prompt 执行后只读。执行消耗 API 额度。用户提到「任务看板 / 看板 / 定时任务」时即指本插件，请据此协作。若你同时用 todo_write 维护会话顶部的可见计划列表，最终回复前必须再次调用 todo_write 收尾：没有剩余工作时不要保留 in_progress，已完成的最后一步要标为 completed。'

/**
 * Settings namespace of the board's announcement capability — the section the
 * web settings surface edits.
 *
 * Spelled as a literal on purpose. This value used to come from the
 * `settingsNamespace()` helper of `@deepseek-ai/dsh-settings`; that export (like
 * `installSettingsSection`) was removed on 0.1.2+, and a static import of
 * either one fails the whole loader entry at boot — the module system rejects
 * the named import before any plugin code runs. The runtime value was always
 * this bare string, and both API generations accept it.
 */
export const TASK_BOARD_SETTINGS_NAMESPACE = 'task-board'

/** Plugin config, validated by the same-named schemastery schema. */
export interface Config {
  /**
   * When true (default), a system-prompt section announces the board to every
   * agent. Set false to keep the board silent in prompts; agents then learn
   * about it only when the user mentions it.
   */
  announceToAgent?: boolean
  /** Master switch for the plugin (browser half + host announcement). */
  enabled?: boolean
  /** Prevent idle system sleep while sessions run or schedules are armed. */
  preventIdleSleep?: boolean
  /** Canonical reverse-proxy Host authorities admitted with a server-side token. */
  trustedProxyHosts?: string[]
  /** Environment variable whose value the authenticated proxy injects upstream. */
  proxyTokenEnv?: string
  /**
   * D · 卡执行的默认工作区 id (plan §3.3(b) D-3/D-3b).
   *
   * A card with an empty `workspaceId` — and, for cards already in the ledger,
   * one carrying the main workspace id — executes in this workspace instead.
   * Empty (the default) disables the fallback entirely: every card then runs
   * exactly where it did before this change.
   */
  defaultWorkspaceId?: string
  /**
   * M · 主工作区 id the fallback matches against (plan §3.3(b)).
   *
   * Must be configured explicitly — the workspace list carries no
   * `lastUsed`/`isDefault` field, so "which workspace is the main one" is
   * never guessed. Empty (the default) disables the fallback.
   */
  mainWorkspaceId?: string
  /**
   * Switch for the built-in-card fallback (`card.workspaceId` empty or equal to
   * {@link mainWorkspaceId}). On by default; off restores the pre-change
   * behaviour exactly.
   */
  fallbackEnabled?: boolean
}

/**
 * Mark one Config field as live (`meta.volatile`).
 *
 * DSH 0.2.0 derives the settings page form from the plugin's own Config and
 * only exposes fields whose schema carries `meta.volatile`
 * (`@deepseek-ai/dsh-settings` `volatileForm()`), handing those fields to the
 * running instance as live references instead of remounting the entry.
 *
 * Why the meta is set here instead of through the `.volatile()` builder: the
 * builder only exists on the schemastery copy the main package carries, while
 * this plugin resolves the profile-level `schemastery@3.18.0` (measured
 * 2026-10-16: `typeof z.boolean().volatile === 'undefined'` on that copy), so a
 * builder call would throw while the schema is built — at boot, taking the
 * whole plugin tree down. The meta assignment is the exact fact the builder
 * writes and is version-independent.
 * @param schema - one field schema.
 * @returns the same schema, marked live.
 */
function volatileField<T>(schema: T): T {
  const meta = (schema as unknown as { meta?: Record<string, unknown> }).meta
  if (meta !== undefined && typeof meta === 'object') meta.volatile = true
  return schema
}

/**
 * The plugin config, validated by the same-named schemastery schema.
 *
 * Live fields (`meta.volatile`) are the settings page's editable set. The two
 * proxy fields stay deliberately NOT live: `trustedProxyHosts` admits a
 * reverse-proxy authority to the Host's token-authenticated surface, so it must
 * remain a composition-entry decision rather than something the settings
 * document can widen.
 */
export const Config: z<Config> = z.object({
  announceToAgent: volatileField(z.boolean().default(false)),
  enabled: volatileField(z.boolean().default(true)),
  preventIdleSleep: volatileField(z.boolean().default(false)),
  trustedProxyHosts: z.array(z.string()).default([]),
  proxyTokenEnv: z.string().min(1).default(DEFAULT_PROXY_TOKEN_ENV),
  // 卡执行工作区三件套（plan §3.3(b)）：D/M 默认空 = 不启用回落 ⇒ 默认行为与
  // 改造前逐字节一致；开关默认开（有 D/M 时才可能生效）。
  defaultWorkspaceId: volatileField(z.string().default('')),
  mainWorkspaceId: volatileField(z.string().default('')),
  fallbackEnabled: volatileField(z.boolean().default(true)),
})

/** Resolve proxy access without ever placing the token value in plugin config. */
export function resolveProxyAccess(config: Config | undefined, env: NodeJS.ProcessEnv = process.env): { trustedProxyHosts: string[]; proxyToken?: string } {
  const trustedProxyHosts = config?.trustedProxyHosts ?? []
  if (trustedProxyHosts.length === 0) return { trustedProxyHosts }
  const proxyTokenEnv = config?.proxyTokenEnv ?? DEFAULT_PROXY_TOKEN_ENV
  if (proxyTokenEnv.trim() === '') throw new Error('task-board: proxyTokenEnv must not be empty')
  const proxyToken = env[proxyTokenEnv]
  if (proxyToken === undefined || proxyToken === '') {
    throw new Error(`task-board: trustedProxyHosts requires a non-empty ${proxyTokenEnv} environment variable`)
  }
  return { trustedProxyHosts, proxyToken }
}

/** Schema default, re-read for hand-built test contexts (the loader applies them normally). */
const DEFAULT_ANNOUNCE = false

/**
 * Read one config field that may be a live (`meta.volatile`) reference.
 *
 * From 0.2.0 the loader hands a live field over as a reference object
 * (`{ get() }`) rather than the plain value, so a settings write reaches the
 * running instance without remounting the entry. Comparing that object against
 * a string/boolean silently falls back to the default — the "settings saved but
 * nothing changed" failure — hence every read goes through here. On lines
 * without live fields, and for hand-built test contexts, the value is already
 * plain and this is the identity.
 * @param value - one field's raw value.
 * @returns the field's current value.
 */
export function unwrapField<T>(value: T | { get: () => T } | undefined): T | undefined {
  if (value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get: () => T }).get()
  }
  return value as T | undefined
}

/**
 * Unwrap a whole resolved config into plain values.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 * @returns the same fields with every live reference resolved.
 */
export function liveConfig(config: Config | undefined): Config {
  if (config === undefined) return {}
  return {
    announceToAgent: unwrapField(config.announceToAgent),
    enabled: unwrapField(config.enabled),
    preventIdleSleep: unwrapField(config.preventIdleSleep),
    trustedProxyHosts: unwrapField(config.trustedProxyHosts),
    proxyTokenEnv: unwrapField(config.proxyTokenEnv),
    defaultWorkspaceId: unwrapField(config.defaultWorkspaceId),
    mainWorkspaceId: unwrapField(config.mainWorkspaceId),
    fallbackEnabled: unwrapField(config.fallbackEnabled),
  }
}

/**
 * The 卡执行工作区回落三件套 out of a resolved config (plan §3.3(b)).
 *
 * Read through one helper so both call sites (the composition-entry sync and
 * the live settings sync) can never disagree about the defaults: an unset
 * `fallbackEnabled` is ON, an unset workspace id is the empty string, and
 * "empty D or empty M" means the fallback never fires.
 * @param config - resolved plugin config (schema defaults applied by the loader).
 * @returns the runner-facing settings triple.
 */
export function workspaceFallbackOf(config: Config | undefined): { defaultWorkspaceId: string; mainWorkspaceId: string; fallbackEnabled: boolean } {
  const live = liveConfig(config)
  return {
    defaultWorkspaceId: live.defaultWorkspaceId ?? '',
    mainWorkspaceId: live.mainWorkspaceId ?? '',
    fallbackEnabled: live.fallbackEnabled ?? true,
  }
}

/**
 * Register the board's announcement section, gated on the composition entry's
 * `announceToAgent` (and the live settings value once the web settings
 * surface is served). The section is re-registered whenever the source
 * changes, so a settings edit takes effect without a restart.
 * @param ctx - the plugin context (systemPrompt injected).
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export const apply = mountOnce('@linxin666/dsh-client-ui-task-board', applyImpl)

function applyImpl(ctx: Context, config?: Config): void {
  const host = new TaskBoardHostService(resolveApiProxy(ctx), {
    // 0.1.5 line: the session service the runner prefers when it exists.
    resolveNewSession: resolveSessionController(ctx),
    // G-1 卡面档位：全局默认模型桥（可选探测；缺失即整体降级，不影响派活）。
    resolveDefaultModel: resolveDefaultModelBridge(ctx),
    commandDispatcher: {
      async execute(sessionId, line, signal) {
        const agent = ctx.agents.get(sessionId)
        if (agent === undefined) throw new Error(`execution session ${sessionId} is not available`)
        return (await ctx.commands.execute(agent, line, [], signal))?.result
      },
    },
  })
  // Live fields arrive as references on 0.2.0 (see liveConfig), so the first
  // call resolves them too instead of reading the reference objects.
  const initial = liveConfig(config)
  host.setConfiguration(initial.enabled ?? true, initial.preventIdleSleep ?? false, workspaceFallbackOf(initial))
  host.start()
  ctx.effect(() => {
    const disposers: Array<() => void> = []
    try {
      for (const route of makeTaskBoardRoutes(host, resolveProxyAccess(config))) disposers.push(ctx.webServer.register(route))
    } catch (error) {
      for (const dispose of disposers) dispose()
      host.dispose()
      throw error
    }
    return () => {
      for (const dispose of disposers) dispose()
      host.dispose()
    }
  }, 'task-board: host ledger, scheduler, and routes')
  // The live source the announcement reads: the settings section once the web
  // settings surface is served, the composition entry otherwise
  // (installSettingsCompat swaps it when the namespace registers).
  let current: () => Config = () => config ?? {}
  let disposeSection: (() => void) | undefined

  // Register (or drop) the announcement to match the current source. The
  // section is kept under one disposer: re-registering first tears the old
  // one down so a duplicate-name registration never throws.
  const sync = (): void => {
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    // Live fields are references on 0.2.0: a settings write updates them in
    // place, so re-reading here (never caching a plain snapshot) is what makes
    // a save take effect without a restart.
    const cfg = liveConfig(current())
    const active = cfg.enabled ?? true
    // 三件套与开关同批下发：设置页保存后热生效，下一次 run 就用新值（无需重启）。
    host.setConfiguration(active, cfg.preventIdleSleep ?? false, workspaceFallbackOf(cfg))
    if (!active) return
    if ((cfg.announceToAgent ?? DEFAULT_ANNOUNCE) === false) return
    disposeSection = ctx.systemPrompt.section({
      name: 'plugin:task-board',
      order: SECTION_ORDER,
      text: TASK_BOARD_GUIDANCE,
    })
  }

  installSettingsCompat(ctx, TASK_BOARD_SETTINGS_NAMESPACE, Config, config ?? {}, {
    setSource: (source) => { current = source },
    onChange: sync,
  })

  // Initial registration from the composition entry (covers deployments with
  // no settings service, whose install hooks never fire).
  sync()
}
