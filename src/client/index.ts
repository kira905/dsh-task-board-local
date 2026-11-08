/**
 * Task-board client plugin: wires the framework-free core (controller,
 * execution service, store) to the real client runtime, and claims the two
 * shell seats the board lives in — a `sidebar.panellist` row and the `main`
 * panel it opens (both registered from `registerPanelSlots`).
 *
 * Failure policy: mounting problems are logged, never thrown — the web shell
 * fails the whole boot when a plugin apply throws, and an external plugin must
 * not take the GUI down.
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Locally declared runtime faces (see client-faces.ts): the package that used to
// export these — @deepseek-ai/dsh-client-runtime — is gone on the 0.1.2+ line.
import type { ClientContext, ConfigFormsFace, LayoutFace, SessionsFace, SettingsScope, WorkspacesFace } from './client-faces.ts'
// Runtime value from the same module (the settings form uses it too): the
// settings card's two workspace pickers subscribe to this store.
import { createSnapshotStore } from './client-faces.ts'
// Type-only: pulls the locale plugin's Context merge (ctx.locale) and its
// LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings-surface Context merge (the 0.2.0 settings
// service `ctx.configForms`, declared through this package's types).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { BoardController } from '../core/controller.ts'
import { LocalStorageTaskStore } from '../core/store.ts'
import { claimTaskboardApply, releaseTaskboardApply } from './apply-guard.ts'
import { TaskBoardPanel } from './board-panel.tsx'
import { ENTRY_ORDER, PANEL_ID, SidebarEntryIcon } from './sidebar-entry.tsx'
import { TaskBoardSettingsCard, TaskBoardSettingsCardController, type TaskBoardSettings, type WorkspaceOption } from './TaskBoardSettingsCard.tsx'
import { en, t, zh, type TaskBoardKey } from './locales.ts'
import { HttpTaskBoardHostTransport } from './host-api.ts'
import {
  formatPresetRosterFailure,
  presetRosterFailureKey,
  readPresetRoster,
  readTransportFace,
  type ConnectionWithApiFace,
  type PresetRosterTransports,
  type RemotePresetsFace,
  type RemoteServiceFace,
} from './preset-roster.ts'
import { reportDailyHeartbeat } from './telemetry.ts'
// 【adapter P3 · 2026-09-25】客户端适配层：ctx 服务名 / 事件名的唯一来源（浏览器 bundle 拿不到
// 各包的 lib/host-adapter.js 副本 —— 宿主按 exports["./client"] 单文件 serve）。外部化由
// tsdown.config.ts 的 CLIENT_EXTERNALS + 本包 package.json 的 dsh.client.external 共同保证：
// 打包器保留 require，宿主按 external 排序 boot graph（依赖先 register，同步 require 才命中）。
import { EV, SVC } from 'dsh-host-adapter-client'

/** Locale namespace this plugin owns. */
const NS = 'task-board'

/**
 * Settings namespace the settings card edits — one section, two generations
 * with two different names:
 *  - pre-0.2.0: the plugin registered the section itself, under the display
 *    namespace `task-board`;
 *  - 0.2.0: the Host derives the form from the plugin's own live Config and the
 *    namespace IS the profile entry id — here the id this plugin's bundle patch
 *    inserts (`cordis.patch.yml`: `- id: ui-task-board-local`). The display name
 *    never reaches the wire on that line, which is why the browser half keys the
 *    form by the entry id.
 */
const TASK_BOARD_LEGACY_NS = 'task-board'

/** Profile entry id serving as the 0.2.0 settings namespace (bundle patch insert id). */
const TASK_BOARD_ENTRY_ID = 'ui-task-board-local'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Task-board surface copy. */
    'task-board': TaskBoardKey
  }

  interface SlotMap {
    /**
     * The pre-0.2.0 seat: the child slot the Web UI plugin group declares; the
     * card registers into the group instead of the top-level
     * `settings.plugin.item` list. Spelled here with the same shape so this
     * package can register without depending on the sibling UI package. The
     * slot does not exist on 0.2.0, where `settings.plugins.tab` replaced it.
     */
    'web-ui.plugin.item': { kind: 'list'; scope: 'root'; owner: SettingsPluginItemOwnerProps }
    /**
     * The 0.2.0 seat: one page inside the settings surface's Plugins section.
     * Declared by the feature that owns that section; typed here with the same
     * shape for the same reason as above (the declaring package is not a build
     * dependency of this bundle, and a slot name this bundle cannot see would
     * otherwise be a type error rather than a registration).
     */
    'settings.plugins.tab': { kind: 'list'; scope: 'root'; owner: SettingsPluginsTabOwnerProps }
  }
}

/** Owner share of a plugin card (the section supplies nothing). */
export interface SettingsPluginItemOwnerProps {
  /** Marker field: card owner props are intentionally empty. */
  children?: never
}

/** Owner share of a Plugins tab (the section supplies nothing). */
export interface SettingsPluginsTabOwnerProps {
  /** Marker field: tab owner props are intentionally empty. */
  children?: never
}

/**
 * Required services (fiber inject waiting — the runtime must be up first).
 *
 * `settingsScope` is deliberately absent: it does not exist on 0.2.0, and a
 * statically injected missing service parks the loader entry forever
 * (`pending (waiting for service: settingsScope)`) — the failure that took the
 * whole web UI white on 2026-10-16. The settings face is reached through a
 * dynamic injection instead, so an absent service degrades to "no settings
 * card" rather than "no GUI".
 */
export const inject = [SVC.slots, SVC.sessions, SVC.workspaces, SVC.connection, SVC.locale, SVC.remote]

/**
 * Mount the task board.
 * @param ctx - client root context (services: sessions, workspaces).
 */
export function apply(ctx: ClientContext): void {
  // Anonymous install heartbeat (docs/telemetry.md): one beat per browser per
  // UTC day, package name only, silent failure.
  reportDailyHeartbeat([{ name: '@linxin666/dsh-client-ui-task-board' }])

  // A duplicated client injection (module factory executed twice in one page
  // lifetime) would otherwise mount a second sidebar entry and board view.
  // First application wins; later calls become no-ops (see apply-guard.ts).
  if (!claimTaskboardApply()) return

  // Release the claim when this fiber unloads (the loader supports plugin
  // unloads / hot-reloads), so a rebuilt bundle can claim again in the same
  // page instead of being silently dropped.
  ctx.effect(() => releaseTaskboardApply, 'task-board: apply claim')

  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'task-board: dictionaries')

  // Plugin configuration card: one staged form over the `task-board` settings
  // namespace, contributed to the Web UI plugin group.
  //
  // 卡执行工作区（D-3/D-3b）：设置卡的两个工作区下拉读的就是板子执行目标选择器
  // 用的同一份**运行时**工作区列表（不是账本、也不是卡字段）。它在这里解析服务：
  // mountUi 也可能从 settings-scope 订阅者的 fiber 上被调用，而 Cordis 按**调用方
  // fiber** 解析服务（见下面 mountUi 的长注释），所以工作区面只在本插件的 fiber 上取一次。
  const workspaces = ctx.get(SVC.workspaces) as unknown as WorkspacesFace
  const workspaceOptions = createSnapshotStore<readonly WorkspaceOption[]>([])
  const refreshWorkspaceOptions = (): void => {
    const snapshot = workspaces.list.getSnapshot()
    workspaceOptions.set(snapshot.items.map(item => ({
      workspaceId: item.workspaceId,
      // Dropdown label = "title — path"（无标题时用路径），与方案 §3.3 的下拉要求一致。
      label: item.title !== '' ? `${item.title} — ${item.path}` : item.path,
    })))
  }
  refreshWorkspaceOptions()
  ctx.effect(() => workspaces.list.subscribe(refreshWorkspaceOptions), 'task-board: settings workspace options')
  // Settings wiring lives below mountUi (see the "Settings face" block): these
  // two holders are declared up here so the slot callbacks can close over them.
  let settingsScope: SettingsScope<TaskBoardSettings> | undefined
  let settingsCard: TaskBoardSettingsCardController | undefined

  // The sidebar entry and board view mount once the settings scope settles;
  // while the scope is still loading, the composition default is unknown, so
  // nothing mounts yet. Only an unavailable scope (no settings surface served)
  // falls back to the composition default (enabled).
  let uiDisposer: (() => void) | undefined

  // ─── Panel seats (sidebar row + main panel · B 方案 2026-11-02) ────────────
  //
  // The board is a first-class shell panel now: one `sidebar.panellist` row and
  // one `main` occupant under the same id, exactly like 「插件」(plugins) and
  // 「自动化任务」(schedules). The shell renders the row — spacing, hover, the
  // collapsed rail, the selected highlight — and swaps the centre column for the
  // panel, so no className copying, no MutationObserver, no overlay attribute.
  //
  // Registration happens on THIS plugin's fiber, which is why it runs from the
  // `ctx.effect` at the end of apply and not from inside mountUi: a registration
  // deferred into a service-injection callback resolves an undefined calling
  // context (`Cannot read properties of undefined (reading 'effect')`, measured
  // 2026-10-16 on the settings card).
  let panelController: BoardController | undefined

  // Whether the board UI is on (the settings gate). The seats follow it: a
  // disabled board must not leave a sidebar row that opens nothing.
  const boardEnabled = createSnapshotStore<boolean>(false)

  // Panel navigation face (`ctx.layout`, provided by the shell's ui-layout).
  // A dynamic injection for the same reason as the settings seam: an absent
  // service must degrade to "cannot hand the centre column back", never park
  // the loader entry waiting for it.
  let layout: LayoutFace | undefined
  ctx.inject(['layout'], (scoped: unknown) => {
    const face = (scoped as { layout?: LayoutFace }).layout
    if (face === undefined || typeof face.selectPanel !== 'function') {
      console.warn('[dsh-task-board] layout service unusable; the board panel cannot hand the centre column back')
      return
    }
    layout = face
    return () => {
      layout = undefined
    }
  })

  /** Hand the centre column back to the Conversation (`null` = no global panel). */
  const exitPanel = (): void => {
    const face = layout
    if (face === undefined) return
    try {
      face.selectPanel(null)
    } catch (error) {
      console.warn('[dsh-task-board] leaving the board panel failed:', error)
    }
  }

  /**
   * Claim both panel seats.
   * @returns the disposer that releases them.
   */
  const registerPanelSlots = (): (() => void) => {
    const seats: Array<() => void> = []
    try {
      // `slots.inject`, never a bare `register`: both seats are declared by the
      // shell's own `root` entry, which can mount AFTER this plugin. A bare
      // register at that moment throws `slot "sidebar.panellist" is not
      // declared (a parent entry's children table must declare it)` and the
      // board silently loses its row — measured on a page reload during this
      // very migration (2026-11-02), while the first mount happened to win the
      // race. inject runs its callback now when the declaration is already
      // committed, and from inside the declaring register() call otherwise, so
      // either order ends with both seats claimed — and again after a collapse.
      seats.push(ctx.slots.inject('sidebar.panellist', () => {
        const release = ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: ENTRY_ORDER,
          locale: NS,
          // A thunk: the sidebar re-reads it on every projection, so the row
          // follows the active locale without a re-registration.
          label: () => t('entry.label'),
        }, SidebarEntryIcon)
        console.info('[dsh-task-board] sidebar entry registered (sidebar.panellist)')
        return release
      }))
      seats.push(ctx.slots.inject('main', () => {
        const release = ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
          // Read per render: the controller appears with the settings gate and
          // disappears with it, without re-registering the seat.
          inject: () => ({ controller: panelController, onExit: exitPanel }),
        }, TaskBoardPanel)
        console.info('[dsh-task-board] board panel registered (main)')
        return release
      }))
    } catch (error) {
      // Same policy as the settings card and the old DOM mounts: a slot failure
      // degrades the board, never the GUI. Logged, not swallowed.
      console.warn('[dsh-task-board] panel slot registration failed:', error)
      for (const release of seats.splice(0)) release()
    }
    return () => {
      for (const release of seats.splice(0)) release()
    }
  }

  // Execution-target transports, resolved ONCE on this plugin's own fiber.
  //
  // Why here and not inside mountUi: mountUi also runs from the settings-scope
  // subscriber, i.e. on the store's fiber, and Cordis resolves a service against
  // the CALLING fiber — a service this plugin injects only for itself is refused
  // there with `cannot get property "remote.agentPresets" without inject`, and an
  // `apply` that throws is reported as `failed to apply loader entry`, which
  // removes the board entirely (measured on the 0.1.5 canary, 2026-09-22).
  //
  // Why readTransportFace: the refusal is not cosmetic — it is thrown from the
  // property read itself, so a bare read is a boot hazard on any line where the
  // face is not injected. Degrading to "transport absent" keeps the board alive
  // and leaves the failure visible through the reader's own report.
  //
  // The new line's roster is a DOTTED service name. The official agent-preset
  // surface injects `['slots', 'locale', 'remote', 'remote.agentPresets',
  // 'remote.settings']` and reads `ctx.remote.agentPresets.list()`; a plugin
  // that injects only the bare `remote` is refused at the `.agentPresets` step
  // (the exact canary error). Declaring the dotted name STATICALLY is not an
  // option here: on a line where no preset namespace is mounted (0.1.1 serves
  // `remote` but mounts no agentPresets contribution) a required-but-absent
  // service parks the entry forever — the board would not load at all, which is
  // worse than an empty picker. A dynamic injection runs only where the
  // namespace exists and is simply skipped elsewhere.
  let remotePresets: RemotePresetsFace | undefined
  let onRemotePresetsReady: (() => void) | undefined
  ctx.inject(['remote.agentPresets'], (scoped: unknown) => {
    // Two spellings of the same service are accepted, because the dotted key and
    // the nested access are both live on the 0.1.5 line (measured: both resolve
    // to the namespace carrying copy/deletePreset/list/read/select). Either one
    // resolving is enough; a line that mounts neither stays at `undefined`.
    const namespaces = scoped as unknown as Record<string, RemotePresetsFace | undefined>
    const dotted = readTransportFace(() => namespaces['remote.agentPresets'])
    const nested = readTransportFace(() => (scoped as unknown as { remote?: RemoteServiceFace }).remote?.agentPresets)
    remotePresets = dotted ?? nested
    // The namespace arrives asynchronously, possibly before the board mounted;
    // re-running the read here covers the other order.
    onRemotePresetsReady?.()
    return () => {
      remotePresets = undefined
    }
  })

  const presetTransports: PresetRosterTransports = {
    connectionApi: readTransportFace(() => (ctx.get(SVC.connection) as unknown as ConnectionWithApiFace | undefined)?.api?.agentPresets),
    // A getter, not a snapshot: the namespace may be injected after this object
    // is built, and a stale `undefined` here would report "no transport" for a
    // deployment that does serve one.
    get remote() {
      return remotePresets
    },
  }

  const mountUi = (): void => {
    if (uiDisposer !== undefined) return
    // Host and browser SDK declarations share the Cordis Context name. Read
    // the browser faces explicitly so Host-side declaration merging cannot
    // narrow these two client services during a combined package build.
    // (`workspaces` is resolved once on this plugin's fiber, above.)
    const sessions = ctx.get(SVC.sessions) as unknown as SessionsFace

    // Core wiring: real runtime faces into the framework-free services.
    const store = new LocalStorageTaskStore()
    const controller = new BoardController({
      store,
      transport: new HttpTaskBoardHostTransport(),
      sessions: {
        list: sessions.list,
        open: id => sessions.open(id),
      },
    })
    controller.start()
    // Publish the controller to the two panel seats registered below: this is
    // what makes the sidebar row and the panel live (they read it per render).
    panelController = controller

    const disposers: Array<() => void> = []

    // Page visibility gates the board's live Host channel (SSE): a hidden
    // window/tab holds no EventSource, and the first visible moment
    // re-subscribes and refreshes once (see BoardController.syncRemoteStream).
    const onVisibilityChange = (): void => {
      controller.setDocumentVisible(document.visibilityState === 'visible')
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    controller.setDocumentVisible(document.visibilityState === 'visible')
    disposers.push(() => { document.removeEventListener('visibilitychange', onVisibilityChange) })

    // Execution-target option feeds: the workspace list drives the workspace
    // picker, and the agent-preset roster drives the mode picker. Both are
    // runtime facts (not ledger state), so the wiring pushes them into the
    // controller on change; the preset roster is re-read after reconnects
    // because a reconnect may serve a different deployment.
    const pushWorkspaceOptions = (): void => {
      // Keep the settings card's two workspace pickers on the same list.
      refreshWorkspaceOptions()
      const snapshot = workspaces.list.getSnapshot()
      controller.setExecutionOptions({
        workspaces: snapshot.items.map(item => ({
          workspaceId: item.workspaceId,
          title: item.title !== '' ? item.title : item.path,
        })),
      })
    }
    pushWorkspaceOptions()
    disposers.push(workspaces.list.subscribe(pushWorkspaceOptions))
    // A failed roster read is reported once per (transport, reason): a repeated
    // failure cannot flood the console, but a NEW one always surfaces. An
    // unreadable roster left the mode picker empty with a single swallowed
    // TypeError on the 0.1.5 line — that silence is the defect this report ends.
    let reportedPresetFailure: string | undefined

    const pushPresetOptions = async (): Promise<void> => {
      const read = await readPresetRoster(presetTransports)
      if (!read.ok) {
        const key = presetRosterFailureKey(read)
        if (key !== reportedPresetFailure) {
          reportedPresetFailure = key
          if (read.error === undefined) console.error(`[dsh-task-board] ${formatPresetRosterFailure(read)}`)
          else console.error(`[dsh-task-board] ${formatPresetRosterFailure(read)}`, read.error)
        }
        // A failed roster read leaves the previous options in place; the
        // picker stays usable and the next reconnect retries the read.
        return
      }
      reportedPresetFailure = undefined
      controller.setExecutionOptions({ presets: read.presets })
    }
    void pushPresetOptions()
    disposers.push(ctx.on(EV.CONNECTION_RESET, () => { void pushPresetOptions() }))
    // The roster namespace is injected asynchronously; when it lands after this
    // mount, read once more so the picker fills without waiting for a reconnect.
    onRemotePresetsReady = () => { void pushPresetOptions() }
    disposers.push(() => { onRemotePresetsReady = undefined })
    uiDisposer = () => {
      for (const dispose of disposers.splice(0)) dispose()
      // Unpublish before disposing: a panel still mounted for one frame must
      // read undefined rather than a disposed controller.
      panelController = undefined
      controller.dispose()
      uiDisposer = undefined
    }
  }
  // ─── Settings face (0.2.0 migration · 2026-10-16) ─────────────────────────
  //
  // The boot hazard this ends: `settingsScope` used to be a STATIC inject, and
  // 0.2.0 serves no such service — the loader entry parked at
  // `pending (waiting for service: settingsScope)` forever and the shell refused
  // to boot ("Failed to load plugins"), taking the entire GUI down. The lesson
  // is structural: nothing in this half may REQUIRE a settings service.
  //
  // Both seams are therefore entered through dynamic injections, whose callback
  // runs only once its service exists (an absent one is skipped, not awaited).
  // The first one to arrive wins, so a deployment serving both — or a
  // re-injection — never registers the card twice.
  const syncEnabled = (): void => {
    const scope = settingsScope
    // No settings service at all: keep the composition default (enabled). This
    // generalizes the pre-existing "unavailable scope" policy and is why the
    // board still mounts on a deployment with no settings surface.
    const snapshot = scope?.getSnapshot()
    const enabled = snapshot === undefined
      ? true
      : snapshot.status === 'ready'
        ? snapshot.value?.enabled ?? true
        : snapshot.status === 'unavailable'
    // Keep the two panel seats in step with the gate (claim on enable, release
    // on disable); the subscription itself lives in the apply-time effect below.
    boardEnabled.set(enabled)
    if (enabled) mountUi()
    else uiDisposer?.()
  }

  /**
   * Localized label for the settings seat.
   * @returns the tab text, falling back to English if the locale service cannot bind.
   */
  const settingsLabel = (): string => {
    try {
      const locale = ctx.locale as unknown as { bind(ns: string): (key: string) => unknown }
      return String(locale.bind(NS)('settings.title'))
    } catch {
      return 'Task Board'
    }
  }

  /**
   * Register the card into one settings slot, tolerating a shell that refuses it.
   * @param options - slot registration options for this seat.
   * @returns the disposer the slot expects.
   */
  const registerSettingsCard = (options: unknown): (() => void) => {
    const card = settingsCard
    if (card === undefined) return () => {}
    try {
      // Called as a METHOD on the service, never as a detached function: the
      // slots service registers through `this.ctx.effect(...)`, so an extracted
      // reference loses `this` and throws
      // `Cannot read properties of undefined (reading 'effect')` (measured
      // 2026-10-16 — the cast below is only for the option shape).
      const slots = ctx.slots as unknown as { register(options: unknown, component: unknown): () => void }
      const unregister = slots.register(options, TaskBoardSettingsCard)
      const seat = (options as { name?: string }).name ?? 'unknown'
      console.info(`[dsh-task-board] settings card registered into ${seat}`)
      return () => {
        card.dispose()
        unregister()
      }
    } catch (error) {
      // Same policy as mountUi: a slot/DOM failure degrades the card, never the
      // GUI. It is logged rather than swallowed — a silently dropped card is
      // exactly the kind of failure this migration had to chase by hand.
      console.warn('[dsh-task-board] settings card registration failed:', error)
      return () => {}
    }
  }

  /**
   * Attach the settings card to whichever scope arrived first.
   * @param scope - a settings scope for this plugin's namespace.
   */
  const attachSettingsCard = (scope: SettingsScope<TaskBoardSettings>): void => {
    if (settingsScope !== undefined) return
    settingsScope = scope
    settingsCard = new TaskBoardSettingsCardController(scope, workspaceOptions)
    console.info('[dsh-task-board] settings face attached')
    scope.subscribe(syncEnabled)
    syncEnabled()
  }

  // Slot presence probes, registered at APPLY time on this plugin's own fiber.
  //
  // Why not inside the settings-attach callback: a registration deferred into a
  // service-injection callback runs on a child fiber, and the slot ledger then
  // resolves an undefined calling context — measured on 0.2.0-rc.2 as
  // `settings card registration failed: TypeError: Cannot read properties of
  // undefined (reading 'effect')`. Registering here matches the official
  // registrants (e.g. ui-settings-plugin-inventory) and is independent of
  // whether a settings service ever appears.
  //
  // Two seats, one registration each: `slots.inject` runs its callback only
  // where the slot has an owner, so exactly one of these lands per deployment.
  // The card face is read lazily, so the order of "settings attaches" versus
  // "slot appears" does not matter.
  ctx.slots.inject('settings.plugins.tab', () => registerSettingsCard({
    name: 'settings.plugins.tab',
    id: 'task-board',
    order: 110,
    label: settingsLabel,
    locale: NS,
    inject: () => settingsCard?.inject() ?? {},
  }))
  ctx.slots.inject('web-ui.plugin.item', () => registerSettingsCard({
    name: 'web-ui.plugin.item',
    id: 'task-board',
    order: 110,
    locale: NS,
    inject: () => settingsCard?.inject() ?? {},
  }))

  // 0.2.0: the settings service that actually exists on that line, keyed by the
  // profile entry id (see TASK_BOARD_ENTRY_ID).
  ctx.inject(['configForms'], (scopeCtx: unknown) => {
    const forms = (scopeCtx as { configForms?: ConfigFormsFace }).configForms
    if (forms === undefined || typeof forms.get !== 'function') {
      console.warn('[dsh-task-board] configForms service present but unusable; settings card stays off')
      return
    }
    attachSettingsCard(forms.get<TaskBoardSettings>(TASK_BOARD_ENTRY_ID))
  })

  // pre-0.2.0: the display-namespace scope. Entered only on a line that still
  // serves it; never awaited, never required.
  ctx.inject([SVC.settingsScope], (scopeCtx: unknown) => {
    const binder = (scopeCtx as { settingsScope?: { bind<S>(spec: { namespace: string }): SettingsScope<S> } }).settingsScope
    if (binder === undefined || typeof binder.bind !== 'function') return
    attachSettingsCard(binder.bind<TaskBoardSettings>({ namespace: TASK_BOARD_LEGACY_NS }))
  })

  // Panel seats: claimed here, on this plugin's own fiber (see the note at
  // `registerPanelSlots`), and re-claimed whenever the settings gate flips.
  ctx.effect(() => {
    let release: (() => void) | undefined
    const sync = (): void => {
      const enabled = boardEnabled.getSnapshot()
      if (enabled && release === undefined) {
        release = registerPanelSlots()
        return
      }
      if (!enabled && release !== undefined) {
        release()
        release = undefined
      }
    }
    const unsubscribe = boardEnabled.subscribe(sync)
    sync()
    return () => {
      unsubscribe()
      release?.()
      release = undefined
    }
  }, 'task-board: panel seats (sidebar.panellist + main)')

  // No settings seam (or one still loading): mount from the composition default
  // so the board is never held hostage by the settings surface.
  syncEnabled()
}
