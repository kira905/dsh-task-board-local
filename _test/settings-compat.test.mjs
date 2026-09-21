/**
 * Regression tests for the cross-line settings probe (src/settings-compat.ts).
 *
 * Why this exists: the 0.1.2+ branch (`ctx.settings.installSection`) cannot be
 * reached end-to-end on this machine — the Host line that provides it (0.1.5)
 * has no `apiProxy` service, so the plugin entry never applies and the branch
 * never runs. The old-line branch IS covered end-to-end (the 3090 test instance
 * and production both register the `task-board` namespace through it), so these
 * cases pin the parts a live boot cannot: the new-API call shape, and the
 * "no settings seam" degradations that must never throw.
 *
 * Run: node --experimental-transform-types _test/settings-compat.test.mjs
 * (plain `node` works on Node 24+; the flag keeps it working on older lines)
 */

import { installSettingsCompat } from '../src/settings-compat.ts'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

/** A fake Context recording the injected service list and running the callback. */
function fakeCtx(runInjection) {
  const seen = { injects: [] }
  return {
    seen,
    inject(names, callback) {
      seen.injects.push(names)
      runInjection(callback)
    },
  }
}

const NS = 'task-board'
const SCHEMA = { fakeSchema: true }
const ENTRY = { enabled: true }
const HOOKS = { setSource() {}, onChange() {} }

// 1. New line (0.1.2+): the seam method receives (owner, ns, schema, entry, hooks).
{
  const calls = []
  const settings = { installSection: (...args) => { calls.push(args) } }
  const ctx = fakeCtx((cb) => { cb({ settings }) })
  installSettingsCompat(ctx, NS, SCHEMA, ENTRY, HOOKS)
  check('injects exactly the settings service', ctx.seen.injects, [['settings']])
  check('new API called once', calls.length, 1)
  check('new API argument order', calls[0], [ctx, NS, SCHEMA, ENTRY, HOOKS])
  check('new API does not touch ctx as a service bag', calls[0][0] === ctx, true)
}

// 2. Old line, registration possible: settings service present but no seam method.
//    The legacy helper is reached through a runtime import of the package, which
//    cannot resolve in this bare test tree — the point asserted here is that the
//    probe degrades quietly instead of throwing (and never falls back to a
//    property read that Cordis would reject).
{
  const ctx = fakeCtx((cb) => { cb({ settings: { register() {} } }) })
  let threw
  try {
    installSettingsCompat(ctx, NS, SCHEMA, ENTRY, HOOKS)
  } catch (error) {
    threw = error?.message
  }
  check('old-line fallback does not throw when the package is unresolvable', threw, undefined)
}

// 3. No settings service composed: the injection callback never runs.
//    An entry-config-only deployment is supported, so this must not throw.
{
  const ctx = fakeCtx(() => {})
  let threw
  try {
    installSettingsCompat(ctx, NS, SCHEMA, ENTRY, HOOKS)
  } catch (error) {
    threw = error?.message
  }
  check('missing settings service does not throw', threw, undefined)
  check('missing settings service still requests the injection', ctx.seen.injects, [['settings']])
}

// 4. Present but empty service object: same quiet degradation.
{
  const ctx = fakeCtx((cb) => { cb({ settings: {} }) })
  let threw
  try {
    installSettingsCompat(ctx, NS, SCHEMA, ENTRY, HOOKS)
  } catch (error) {
    threw = error?.message
  }
  check('empty settings service does not throw', threw, undefined)
}

// 5. installSection present but not callable (a future line renaming the method).
{
  const ctx = fakeCtx((cb) => { cb({ settings: { installSection: 'not-a-function' } }) })
  let threw
  try {
    installSettingsCompat(ctx, NS, SCHEMA, ENTRY, HOOKS)
  } catch (error) {
    threw = error?.message
  }
  check('non-callable installSection does not throw', threw, undefined)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
