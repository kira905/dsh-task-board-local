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
import { makeTaskBoardRoutes } from './host-routes.ts'
import { mountOnce } from './mount-once.ts'
// Re-exported so the ledger's load-time recovery contract (card [账本陈旧串]:
// `scheduler.error` is recalculated per load, never replayed) can be exercised
// against the SHIPPED bundle in _test/, not just against the TypeScript source.
export { HostTaskLedger } from './host-ledger.ts'
// Cross-line settings wiring (see settings-compat.ts): kept in its own module
// with no runtime imports so the probe can be unit-tested directly.
import { installSettingsCompat } from './settings-compat.ts'
// 宿主适配层（唯一源 + 生成副本，P1 收敛 2026-09-15）：
// 服务名/事件名一律走它（R4）。⚠️ 该 import 在 tsdown 里被 `external` 保留为运行时依赖 ——
// 若被 inline 进 lib/index.js，产物里就重新出现裸字面量、且副本不再可校验。
import { SVC, service } from '../lib/host-adapter.js'
import { asNewLineSessionApi, type ResolveNewLineSessionApi } from './host-runner.ts'

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
 * The service is therefore resolved **at call time** via {@link resolveApiProxy}
 * (`ctx.get`, which never throws when the service is missing — reading an
 * undeclared service *property* does throw in cordis). On the 0.1.1 line
 * nothing changes: the service resolves and every call path behaves exactly as
 * before. On a line without it the board still boots — UI, ledger and the cron
 * scheduler stay functional — and only session execution (`run`/`rerun`) is
 * disabled, with an explicit error instead of a silent no-op.
 */
export const inject = [SVC.systemPrompt, SVC.webServer, SVC.agents, SVC.commands]

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

/**
 * Build a **late-binding** accessor for the 0.1.5-line session service
 * (`sessionController`, `@deepseek-ai/dsh-api-session-controller`).
 *
 * The legacy `apiProxy` domain was split into per-domain services on the
 * 0.1.5 line, and the session domain is `sessionController` — the same service
 * the Host's own web client drives. This plugin executes board sessions
 * through it (`create` → `rename` → `prompt`) and reads its session index
 * (`list`) and logs (`inspect` / `page`).
 *
 * Deliberately **not** in `inject`: exactly like `apiProxy`, this service does
 * not exist on the other host line, and a static declaration of an absent
 * service leaves the entry permanently `pending` (= `1 entry did not
 * activate`, i.e. boot failure). Both lines are therefore resolved at call
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
}

export const Config: z<Config> = z.object({
  announceToAgent: z.boolean().default(false),
  enabled: z.boolean().default(true),
  preventIdleSleep: z.boolean().default(false),
  trustedProxyHosts: z.array(z.string()).default([]),
  proxyTokenEnv: z.string().min(1).default(DEFAULT_PROXY_TOKEN_ENV),
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
    commandDispatcher: {
      async execute(sessionId, line, signal) {
        const agent = ctx.agents.get(sessionId)
        if (agent === undefined) throw new Error(`execution session ${sessionId} is not available`)
        return (await ctx.commands.execute(agent, line, [], signal))?.result
      },
    },
    newSessionResolver: resolveSessionController(ctx),
  })
  host.setConfiguration(config?.enabled ?? true, config?.preventIdleSleep ?? false)
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
    const active = current().enabled ?? true
    host.setConfiguration(active, current().preventIdleSleep ?? false)
    if (!active) return
    if ((current().announceToAgent ?? DEFAULT_ANNOUNCE) === false) return
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
