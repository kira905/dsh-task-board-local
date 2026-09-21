/**
 * Settings-API compatibility probe for this plugin.
 *
 * The optional-settings wiring this plugin needs moved between two generations
 * of the Host:
 *   - 0.1.1 and earlier: the module export `installSettingsSection(ctx, ns,
 *     schema, entry, hooks)` of `@deepseek-ai/dsh-settings`;
 *   - 0.1.2 and later: the method `ctx.settings.installSection(owner, ns,
 *     schema, entry, hooks)` on the settings service, and the two exports above
 *     removed outright.
 *
 * Both bodies are the same wiring (verified 2026-09-11 against
 * dsh-settings@0.1.1-rc.2 and @0.1.5-rc.2: the newer method is the older
 * helper minus its own `ctx.inject(['settings'])` wrapper), so one probe covers
 * both lines and no code is duplicated per line.
 *
 * Two properties are load-bearing:
 *
 * 1. **Nothing is imported statically from the package.** On 0.1.2+ a static
 *    named import of a removed export fails the module load itself: the loader
 *    entry never applies, the plugin tree fails, and the Host never reaches
 *    HTTP 200 (measured 2026-09-11 on the canary instance with this very
 *    package). The legacy path is therefore a runtime `import()`.
 * 2. **The probe rides `ctx.inject(['settings'], …)`, never a property read.**
 *    Cordis resolves service properties through a proxy that THROWS
 *    ("cannot get property \"settings\" without inject") when the service was
 *    not injected — a `ctx.settings?.…` probe therefore takes the whole loader
 *    entry down instead of degrading. Injection makes the dependency genuinely
 *    optional: with no settings service composed the callback never runs, the
 *    plugin keeps working from its composition entry, and nothing throws or
 *    logs, because an entry-config-only deployment is a supported composition.
 *
 * This module deliberately imports nothing from any package (its only package
 * dependencies are types), so the regression test can load it directly under
 * Node without a node_modules tree. Its one runtime import is the local host
 * adapter copy (a plain relative file, no package resolution involved) — the
 * service name it injects must live in the single adapter source, not here.
 */

import type { Context } from '@deepseek-ai/cordis'
import type z from 'schemastery'
import type { Config } from './index.ts'
import { SVC } from '../lib/host-adapter.js'

/** Hooks a settings consumer hands over — identical on both API generations. */
export interface SettingsSectionHooks {
  /**
   * Receive the active configuration source: the resolved settings scope while
   * one is attached, the composition entry otherwise.
   * @param current - thunk returning the currently authoritative value.
   */
  setSource(current: () => Config): void
  /** Re-judge anything derived from the source after an attach, a detach, or a change. */
  onChange(): void
}

/**
 * The 0.1.2+ settings seam: `ctx.settings` is a service and the consumer
 * wiring is a method on it. Probed structurally rather than declared by import,
 * because importing the package for its types would reintroduce the very
 * dependency this module exists to avoid.
 */
export interface SettingsSeam {
  installSection?: (owner: Context, ns: string, schema: z<Config>, entry: Config, hooks: SettingsSectionHooks) => void
}

/** The pre-0.1.2 module export of the same wiring, loaded only on that line. */
export type LegacyInstallSettingsSection = (ctx: Context, ns: string, schema: z<Config>, entry: Config, hooks: SettingsSectionHooks) => void

/** The `@deepseek-ai/dsh-settings` surface this module reaches for at runtime. */
interface SettingsModule {
  installSettingsSection?: LegacyInstallSettingsSection
}

/**
 * Install a plugin's optional settings wiring on whichever API generation the
 * running Host provides.
 * @param ctx - the plugin context (owner of the registration).
 * @param ns - settings namespace (a lowercase hyphenated identifier).
 * @param schema - schemastery schema resolving the namespace's value.
 * @param entry - composition entry, used as the base and the fallback value.
 * @param hooks - source sink and change notification.
 */
export function installSettingsCompat(
  ctx: Context,
  ns: string,
  schema: z<Config>,
  entry: Config,
  hooks: SettingsSectionHooks,
): void {
  ctx.inject([SVC.settings], (settingsCtx) => {
    const seam = (settingsCtx as unknown as { settings?: SettingsSeam }).settings
    if (seam !== undefined && typeof seam.installSection === 'function') {
      seam.installSection(ctx, ns, schema, entry, hooks)
      return
    }
    void import('@deepseek-ai/dsh-settings').then((mod) => {
      const legacy = (mod as SettingsModule).installSettingsSection
      if (typeof legacy !== 'function') return
      legacy(ctx, ns, schema, entry, hooks)
    }).catch(() => {
      // No settings seam reachable: the composition entry stays authoritative.
    })
  })
}
