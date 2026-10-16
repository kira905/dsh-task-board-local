/**
 * Client faces this plugin reads, declared locally on purpose.
 *
 * These shapes used to come from `@deepseek-ai/dsh-client-runtime` — the types
 * by `import type`, and `createSnapshotStore` by a real value import. That
 * package stopped at 0.1.1-rc.2: on the 0.1.2+ line its responsibilities moved
 * to `dsh-client-modules` / `dsh-api-session-controller` /
 * `dsh-api-workspace-controller` / `dsh-client-ui-settings`, and the package
 * itself is absent from the main-package closure. Two consequences made the
 * dependency untenable:
 *   - a static value import of a package the host cannot resolve throws while
 *     the browser half loads (the `dsh.client.inject` entry is likewise dead);
 *   - the replacement packages spell the same shapes under different names, so
 *     importing either line's declarations would break the other.
 * Owning the minimal structural faces is therefore the only wiring that works
 * on both lines without a compatibility branch.
 *
 * Field names are the load-bearing part. Every face below is what BOTH the
 * 0.1.1-rc.2 and the 0.1.5 client runtimes expose (verified against both trees'
 * type declarations on 2026-09-11); only the owning package changed.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Client root context — the Cordis context the browser half is applied with. */
export type ClientContext = Context

/** Observable snapshot source (what session objects and snapshot stores share). */
export interface ObservableSnapshot<T> {
  /** @returns the current snapshot, a stable reference until the next change. */
  getSnapshot(): T
  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void
}

/** Writable in-memory snapshot store; the renderer binds it as a React store. */
export interface SnapshotStore<T> extends ObservableSnapshot<T> {
  /** Replace the state wholesale and notify subscribers. */
  set(next: T): void
}

/**
 * Create a snapshot store over an in-memory value.
 *
 * Only the surface this plugin uses is implemented: synchronous notification on
 * `set` (controlled inputs need same-tick echo), a stable `getSnapshot`
 * reference between changes, and no persistence. The upstream helper carried an
 * immer-draft `update()` and an optional localStorage mode; neither is used by
 * this plugin, so neither is modelled here — a store method nobody calls is a
 * silent wrong-behaviour trap, not a feature.
 * @param init - initial state.
 * @returns the store.
 */
export function createSnapshotStore<T>(init: T): SnapshotStore<T> {
  let state = init
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (next) => {
      state = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/** Client-side sync state of one settings namespace. */
export interface SettingsScopeSnapshot<T> {
  /** `loading` until the first accepted section; `unavailable` when not served here. */
  status: 'loading' | 'ready' | 'unavailable'
  /** Last accepted schema-resolved section; undefined before the first acceptance. */
  value: T | undefined
  /** Composition layer `value` was resolved over — what a cleared field reverts to. */
  base: unknown
  /** Raw user layer; a field's presence here is what marks it user-overridden. */
  user: unknown
  /** Whether the Host document accepts writes. */
  writable: boolean
}

/** Domain-owned description of one settings namespace consumed by a browser plugin. */
export interface SettingsScopeSpec<T> {
  /** Settings namespace registered by the owning Host plugin. */
  namespace: string
  /** Narrow one wire section; undefined keeps the last accepted value. */
  decode?: (section: unknown) => T | undefined
}

/** Reactive owner handle over one namespace's durable section. */
export interface SettingsScope<T> extends ObservableSnapshot<SettingsScopeSnapshot<T>> {
  /**
   * Queue one field write. The two generations answer differently (`void` on
   * the pre-0.2.0 scope, `boolean` acceptance on the 0.2.0 form), so the face
   * stays open at `unknown` and the form model only awaits settlement — the
   * bridge scope this plugin binds already reports success its own way.
   * @param field - scalar field inside the namespace section.
   * @param value - JSON-shaped value selected by the user.
   */
  set(field: string, value: unknown): Promise<unknown>
  /**
   * Queue one field clear, so the field re-inherits the composition layer.
   * @param field - scalar field inside the namespace section.
   */
  unset(field: string): Promise<unknown>
}

/**
 * The 0.2.0 client settings service (`ctx.configForms`, provided by
 * `@deepseek-ai/dsh-client-ui-settings`).
 *
 * On that line the service no longer hands out a caller-named scope: a form is
 * keyed by the Host plugin's **profile entry id**, and the values come from the
 * entry's live config rather than a separately registered section. The snapshot
 * and write surface is otherwise the same shape this plugin already consumes,
 * which is why `get()` is modelled as returning {@link SettingsScope}.
 */
export interface ConfigFormsFace {
  /**
   * The shared form values and write queue for one Host plugin entry.
   * @param entryId - unique Host plugin (profile entry) id.
   * @returns the entry's form.
   */
  get<T>(entryId: string): SettingsScope<T>
}

/** One workspace row the board's execution-target picker offers. */
export interface WorkspaceRow {
  workspaceId: string
  title: string
  /** Filesystem path, the label fallback when a workspace carries no title. */
  path: string
}

/** Sessions face the browser half reads for navigation awareness. */
export interface SessionsFace {
  /** Currently selected session. */
  list: ObservableSnapshot<{ current: string | undefined }>
  /**
   * Select a session as current (navigates the conversation view).
   * @param id - session id.
   */
  open(id: string): void
}

/** Workspaces face the browser half reads for the workspace picker. */
export interface WorkspacesFace {
  /** Registered workspaces. */
  list: ObservableSnapshot<{ items: readonly WorkspaceRow[] }>
}
