/**
 * Card `升级 B2` step ④ regression tests: the apiProxy cross-line contract.
 *
 * `@deepseek-ai/dsh-host-apiproxy` does not exist in the 0.1.5 closure, so a
 * static `inject` declaration leaves this plugin's entry permanently `pending`
 * (= boot failure, measured on the canary). The fix must satisfy three things
 * at once, and each one is asserted here:
 *
 *   1. **0.1.1 unchanged** — when the service exists, every call path still
 *      goes through it (identical RPC sequence).
 *   2. **No boot failure** — the service is not declared statically, and
 *      probing it never throws (cordis throws on undeclared service
 *      *properties*; `ctx.get` is the safe accessor).
 *   3. **Fail loud, not silent** — an execution attempt without the service
 *      raises a named error (once, with a warning), instead of hanging a card
 *      in 进行中 with no explanation.
 *
 * Run: node --experimental-transform-types --test _test/api-proxy-compat.test.mjs
 */
import { inject, resolveApiProxy, DEFAULT_PROXY_TOKEN_ENV } from '../src/index.ts'
import { HostExecutionRunner, ApiProxyUnavailableError } from '../src/host-runner.ts'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

// --------------------------------------------------- 1. no static declaration
check('inject has no apiProxy', inject.includes('apiProxy'), false)
check('inject keeps the other services', inject, ['systemPrompt', 'webServer', 'agents', 'commands'])
check('proxy token env default unchanged', DEFAULT_PROXY_TOKEN_ENV, 'DSH_TASK_BOARD_PROXY_TOKEN')

// ------------------------------------------------ 2. probing never throws
const service = { marker: 'api' }
check('probe: ctx without get → null', resolveApiProxy({})() , null)
check('probe: ctx.get throws → null', resolveApiProxy({ get() { throw new Error('cannot get property apiProxy without inject') } })(), null)
check('probe: service missing → null', resolveApiProxy({ get: () => undefined })(), null)
check('probe: service present → the service', resolveApiProxy({ get: (name) => (name === 'apiProxy' ? service : undefined) })(), service)
check('probe: null ctx → null', resolveApiProxy(null)(), null)
// Late binding: the accessor must reflect the service appearing AFTER apply.
{
  let live
  const probe = resolveApiProxy({ get: () => live })
  const before = probe()
  live = service
  check('probe: late binding (before → null)', before, null)
  check('probe: late binding (after → service)', probe(), service)
}

// --------------------------- 3a. missing service: explicit, once, no hang
{
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => { warnings.push(args.join(' ')) }
  try {
    const runner = new HostExecutionRunner(() => null)
    let error
    try {
      await runner.launch({ id: 't1', title: 'T', prompt: 'go', workspaceId: 'ws-1' })
    } catch (caught) {
      error = caught
    }
    check('launch without apiProxy → ApiProxyUnavailableError', error instanceof ApiProxyUnavailableError, true)
    check('launch error name', error?.name, 'ApiProxyUnavailableError')
    check('launch error message is actionable', /apiProxy service is unavailable/.test(error?.message ?? ''), true)
    check('warning emitted once after first failure', warnings.length, 1)
    // A second attempt must not spam the log (the 5 s poll path shares the flag).
    try { await runner.launch({ id: 't2', title: 'T2', prompt: 'go' }) } catch { /* expected */ }
    check('warning not repeated', warnings.length, 1)
    check('listRunning without apiProxy → unknown', await runner.listRunning(), { known: false })
  } finally {
    console.warn = originalWarn
  }
}

// --------------------------- 3b. service present: identical call sequence
{
  const calls = []
  const ok = (value) => ({ result: { ok: true, value } })
  const api = {
    workspace: { list: async () => { calls.push('workspace.list'); return ok({ items: [{ workspaceId: 'ws-1' }] }) } },
    agentPresets: { list: async () => { calls.push('agentPresets.list'); return ok({ presets: [{ id: 'preset-1' }] }) } },
    sessions: {
      create: async () => { calls.push('sessions.create'); return ok({ sessionId: 'session-x' }) },
      rename: async () => { calls.push('sessions.rename'); return ok({}) },
      prompt: async () => { calls.push('sessions.prompt'); return ok({}) },
      list: async () => { calls.push('sessions.list'); return ok({ items: [{ running: true }, { running: false }] }) },
    },
  }
  const runner = new HostExecutionRunner(() => api)
  const sessionId = await runner.launch({ id: 't3', title: 'Card', prompt: 'do it', workspaceId: 'ws-1', mode: 'preset-1' })
  check('launch with apiProxy returns the session id', sessionId, 'session-x')
  check('launch RPC sequence unchanged (0.1.1 path)', calls, [
    'workspace.list', 'agentPresets.list', 'sessions.create', 'sessions.rename', 'sessions.prompt',
  ])
  calls.length = 0
  const running = await runner.listRunning()
  check('listRunning with apiProxy counts running sessions', { known: running.known, count: running.count }, { known: true, count: 1 })
  check('listRunning RPC', calls, ['sessions.list'])
}

// --------------------------- 3c. missing workspace/preset still fails as before
{
  const ok = (value) => ({ result: { ok: true, value } })
  const api = {
    workspace: { list: async () => ok({ items: [] }) },
    agentPresets: { list: async () => ok({ presets: [] }) },
    sessions: { create: async () => ok({ sessionId: 'session-y' }), rename: async () => ok({}), prompt: async () => ok({}) },
  }
  const runner = new HostExecutionRunner(() => api)
  let error
  try { await runner.launch({ id: 't4', title: 'T', prompt: 'go', workspaceId: 'nope' }) } catch (caught) { error = caught }
  check('workspace validation unchanged', error?.message, 'workspace not found: nope')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
