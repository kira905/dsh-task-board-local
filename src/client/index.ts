/**
 * Task-board client plugin: wires the framework-free core (controller,
 * execution service, store) to the real client runtime and mounts the two
 * DOM surfaces — the sidebar entry row and the board view in the center
 * column.
 *
 * Failure policy: DOM mounting problems are logged, never thrown — the web
 * shell fails the whole boot when a plugin apply throws, and an external
 * plugin must not take the GUI down.
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Locally declared runtime faces (see client-faces.ts): the package that used to
// export these — @deepseek-ai/dsh-client-runtime — is gone on the 0.1.2+ line.
import type { ClientContext, ConfigFormsFace, SessionsFace, SettingsScope, SettingsScopeSpec, WorkspacesFace } from './client-faces.ts'
// Type-only: pulls the locale plugin's Context merge (ctx.locale) and its
// LocaleNamespaceMap merge table.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings-surface Context merge (ctx.settingsScope).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { BoardController } from '../core/controller.ts'
import { LocalStorageTaskStore } from '../core/store.ts'
import { claimTaskboardApply, releaseTaskboardApply } from './apply-guard.ts'
import { mountBoard } from './board-mount.tsx'
import { mountSidebarEntry } from './sidebar-entry.ts'
import { TaskBoardSettingsCard, TaskBoardSettingsCardController, type TaskBoardSettings } from './TaskBoardSettingsCard.tsx'
import { en, zh, type TaskBoardKey } from './locales.ts'
import { HttpTaskBoardHostTransport } from './host-api.ts'
import { reportDailyHeartbeat } from './telemetry.ts'

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
     * The pre-0.2.0 seat: the child slot the Web UI plugin group declares; this
     * card registers into the group instead of the top-level
     * `settings.plugin.item` list. Spelled here with the same shape so this
     * package can register without depending on the sibling UI package. The
     * slot has no owner on 0.2.0, where `settings.plugins.tab` replaced it.
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

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Optional rc.6 compatibility binder provided by dsh-web-settings;
     * absent when that group plugin is not installed, so callers fall back to
     * the official settings scope.
     */
    webUiSettings?: { bind<S>(spec: SettingsScopeSpec<S>): SettingsScope<S> }
  }
}


/**
 * Required services (fiber inject waiting — the runtime must be up first).
 *
 * `settingsScope` is deliberately absent: it does not exist on 0.2.0, and a
 * statically injected missing service parks the loader entry forever
 * (`pending (waiting for service: settingsScope)`) — the failure that left the
 * browser half of this plugin inert on 2026-10-16. The settings face is reached
 * through a dynamic injection instead, so an absent service degrades to "no
 * settings card" rather than "no GUI".
 */
export const inject = ['slots', 'sessions', 'workspaces', 'connection', 'locale', 'remote']

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
  // namespace, contributed to the settings surface. The settings face itself is
  // attached at the bottom of apply (see the "Settings face" block); these two
  // holders are declared up here so the slot callbacks can close over them.
  let settingsScope: SettingsScope<TaskBoardSettings> | undefined
  let settingsCard: TaskBoardSettingsCardController | undefined

  /**
   * Register the card into one settings seat, tolerating a shell that refuses it.
   * @param options - slot registration options for this seat.
   * @returns the disposer the slot expects.
   */
  const registerSettingsCard = (options: unknown): (() => void) => {
    const card = settingsCard
    if (card === undefined) return () => {}
    try {
      // Called as a METHOD on the service, never as a detached function: the
      // slots service registers through `this.ctx.effect(...)`, so an extracted
      // reference loses `this` and throws.
      const slots = ctx.slots as unknown as { register(options: unknown, component: unknown): () => void }
      const unregister = slots.register(options, TaskBoardSettingsCard)
      return () => {
        card.dispose()
        unregister()
      }
    } catch (error) {
      // Same policy as mountUi: a slot failure degrades the card, never the GUI.
      // Logged rather than swallowed — a silently dropped card is exactly the
      // kind of failure a settings-face migration has to chase by hand.
      console.warn('[dsh-task-board] settings card registration failed:', error)
      return () => {}
    }
  }

  /**
   * Localized label for the 0.2.0 settings seat.
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

  // Slot presence probes, registered at APPLY time on this plugin's own fiber.
  //
  // Why not inside the settings-attach callback: a registration deferred into a
  // service-injection callback runs on a child fiber, and the slot ledger then
  // resolves an undefined calling context. Registering here is independent of
  // whether a settings service ever appears.
  //
  // Two seats, one registration each: `slots.inject` runs its callback only
  // where the slot has an owner, so exactly one of these lands per deployment
  // (a line serving neither simply registers nothing). The card face is read
  // lazily, so the order of "settings attaches" versus "slot appears" does not
  // matter.
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

  // The sidebar entry and board view mount once the settings scope settles;
  // while the scope is still loading, the composition default is unknown, so
  // nothing mounts yet. Only an unavailable scope (no settings surface served)
  // falls back to the composition default (enabled).
  let uiDisposer: (() => void) | undefined
  const mountUi = (): void => {
    if (uiDisposer !== undefined) return
    // Host and browser SDK declarations share the Cordis Context name. Read
    // the browser faces explicitly so Host-side declaration merging cannot
    // narrow these two client services during a combined package build.
    const sessions = ctx.get('sessions') as unknown as SessionsFace
    const workspaces = ctx.get('workspaces') as unknown as WorkspacesFace
    const connection = ctx.get('connection') as ConnectionHandle

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
    const pushPresetOptions = async (): Promise<void> => {
      try {
        const response = await connection.api.agentPresets.list({})
        if (!response.result.ok) return
        controller.setExecutionOptions({
          presets: response.result.value.presets.map(preset => ({
            id: preset.id,
            name: preset.name,
            description: preset.description,
            broken: preset.broken,
            isDefault: preset.isDefault,
          })),
        })
      } catch (error) {
        // A failed roster read leaves the previous options in place; the
        // picker stays usable and the next reconnect retries the read.
        console.error('[dsh-task-board] agent preset roster read failed', error)
      }
    }
    void pushPresetOptions()
    disposers.push(ctx.on('connection/reset', () => { void pushPresetOptions() }))
    try {
      disposers.push(mountSidebarEntry(controller))
      disposers.push(mountBoard(controller))
    } catch (error) {
      // DOM failures degrade the board, never the GUI.
      console.error('[dsh-task-board] mount failed:', error)
    }

    uiDisposer = () => {
      for (const dispose of disposers.splice(0)) dispose()
      controller.dispose()
      uiDisposer = undefined
    }
  }
  // ─── Settings face (0.2.0 migration · 2026-10-16) ─────────────────────────
  //
  // The boot hazard this ends: `settingsScope` used to be a STATIC inject, and
  // 0.2.0 serves no such service — the loader entry parked at
  // `pending (waiting for service: settingsScope)` forever and the board never
  // mounted. The lesson is structural: nothing in this half may REQUIRE a
  // settings service.
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
    if (enabled) mountUi()
    else uiDisposer?.()
  }

  /**
   * Attach the settings card to whichever scope arrived first.
   * @param scope - a settings scope for this plugin's namespace.
   */
  const attachSettingsCard = (scope: SettingsScope<TaskBoardSettings>): void => {
    if (settingsScope !== undefined) return
    settingsScope = scope
    settingsCard = new TaskBoardSettingsCardController(scope)
    scope.subscribe(syncEnabled)
    syncEnabled()
  }

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

  // pre-0.2.0: the display-namespace scope, with the rc.6 compatibility binder
  // preferred when a settings group plugin serves one. Entered only on a line
  // that still serves the service; never awaited, never required.
  ctx.inject(['settingsScope'], (scopeCtx: unknown) => {
    const legacy = scopeCtx as {
      settingsScope?: { bind<S>(spec: SettingsScopeSpec<S>): SettingsScope<S> }
    }
    const compat = ctx.get('webUiSettings') as { bind<S>(spec: SettingsScopeSpec<S>): SettingsScope<S> } | undefined
    const binder = compat ?? legacy.settingsScope
    if (binder === undefined || typeof binder.bind !== 'function') return
    attachSettingsCard(binder.bind<TaskBoardSettings>({ namespace: TASK_BOARD_LEGACY_NS }))
  })

  // No settings seam (or one still loading): mount from the composition default
  // so the board is never held hostage by the settings surface.
  syncEnabled()
}
