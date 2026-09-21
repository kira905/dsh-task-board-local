/**
 * Module-resolution hook for the board's own test suite.
 *
 * The delivered host bundle (`lib/index.js`) is the artifact dsh actually
 * loads, so the regression tests should exercise THAT, not a re-bundled copy.
 * But the bundle keeps its runtime dependencies external:
 *
 *     import z from 'schemastery'   // and a dynamic import of @deepseek-ai/dsh-settings
 *
 * and this project has no `node_modules` of its own — on this machine the only
 * copy of `schemastery` lives inside the dsh web profile, which belongs to the
 * running product, not to the test.
 *
 * This loader bridges exactly that gap: any specifier the test cannot resolve
 * from the project tree is looked up inside the dsh home (production or the
 * DSH_HOME the test was launched with). It never copies or writes anything, and
 * it only fires for the named externals, so the resolution of the rest of the
 * graph is untouched.
 *
 *   node --loader ./_test/loader.mjs _test/<name>.test.mjs
 *
 * `--loader` (not `--import`): the static entry import is resolved before an
 * `--import`-registered hook is installed, so the bridge would miss it. Set
 * `TASK_BOARD_LIB` to point `../lib/index.js` at another copy of the bundle
 * (used to prove the regression test fails against the pre-fix artifact).
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

/** External specifiers resolved from the dsh home instead of the project tree. */
const HOST_EXTERNALS = ['schemastery', '@deepseek-ai/dsh-settings']

/** Optional replacement for the bundle under test. */
const LIB_OVERRIDE = process.env.TASK_BOARD_LIB === undefined ? undefined : resolvePath(process.env.TASK_BOARD_LIB)

function dshHome() {
  return process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
}

/** Roots probed in order for a host external. */
function searchRoots() {
  const home = dshHome()
  return [
    join(home, 'profiles', 'web', 'node_modules'),
    join(home, 'profiles', 'node_modules'),
    join(home, 'node_modules'),
  ]
}

const bridgeCache = new Map()

function bridge(specifier) {
  const cached = bridgeCache.get(specifier)
  if (cached !== undefined) return cached
  for (const root of searchRoots()) {
    const pkg = join(root, ...specifier.split('/'), 'package.json')
    if (!existsSync(pkg)) continue
    try {
      const resolved = createRequire(pkg).resolve(specifier)
      bridgeCache.set(specifier, resolved)
      return resolved
    } catch {
      // Keep probing the remaining roots.
    }
  }
  bridgeCache.set(specifier, undefined)
  return undefined
}

export async function resolve(specifier, context, nextResolve) {
  if (LIB_OVERRIDE !== undefined && /\/lib\/index\.js$/.test(specifier)) {
    return { url: pathToFileURL(LIB_OVERRIDE).href, shortCircuit: true }
  }
  if (HOST_EXTERNALS.includes(specifier)) {
    const bridged = bridge(specifier)
    if (bridged !== undefined) {
      // `format` is left to the load step, which sniffs the resolved file.
      return { url: pathToFileURL(bridged).href, shortCircuit: true }
    }
  }
  return nextResolve(specifier, context)
}

export { HOST_EXTERNALS }
