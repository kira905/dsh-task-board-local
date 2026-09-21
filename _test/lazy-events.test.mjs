/**
 * Demand-driven Host event channel (SSE).
 *
 * The board's live channel must exist only while the panel is actually on
 * screen: opening the board subscribes, leaving the board (or hiding the
 * page) releases it, and the next open subscribes again plus one catch-up
 * full snapshot. Pure controller test with a fake transport that counts
 * subscribe/release/state calls — no browser involved.
 *
 * Run: node --experimental-transform-types _test/lazy-events.test.mjs
 * (transform, not strip: src/core/controller.ts uses a parameter property)
 */
import { BoardController } from '../src/core/controller.ts'
import { TASK_BOARD_SCHEMA_VERSION } from '../src/protocol.ts'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function snapshotOf(revision) {
  return {
    schemaVersion: TASK_BOARD_SCHEMA_VERSION,
    revision,
    tasks: [],
    scheduler: { timeZone: 'UTC', ledgerId: 'ledger-1' },
    power: { platform: 'win32', phase: 'idle', enabled: true, runningSessions: 0, armedSchedules: 0, sessionStateKnown: true },
  }
}

function fakeHarness({ deferBootstrap = false } = {}) {
  const counters = { subscribe: 0, release: 0, state: 0, bootstrap: 0 }
  const listeners = new Set()
  let releaseBootstrap
  const transport = {
    async bootstrap() {
      counters.bootstrap += 1
      if (deferBootstrap) await new Promise(resolve => { releaseBootstrap = resolve })
      return snapshotOf(1)
    },
    async state() { counters.state += 1; return snapshotOf(1) },
    async action() { return snapshotOf(1) },
    subscribe(listener) {
      counters.subscribe += 1
      listeners.add(listener)
      return () => { counters.release += 1; listeners.delete(listener) }
    },
  }
  const controller = new BoardController({
    store: { load: () => [], save: () => {}, clear: () => {} },
    transport,
    sessions: { list: { getSnapshot: () => ({ current: 'session-1' }), subscribe: () => () => {} }, open: () => {} },
  })
  return {
    controller,
    counters,
    live: () => listeners.size,
    emit: (frame) => { for (const listener of [...listeners]) listener(frame) },
    resumeBootstrap: () => { releaseBootstrap?.() },
  }
}

// --- 1. a page that never opens the board holds no channel -------------------
{
  const h = fakeHarness()
  h.controller.start()
  await tick()
  check('start() without an open board subscribes 0 times', h.counters.subscribe, 0)
  check('start() while closed still reads the initial snapshot', h.counters.bootstrap, 1)
}

// --- 2. opening the board acquires exactly one channel -----------------------
{
  const h = fakeHarness()
  h.controller.start()
  await tick()
  h.controller.openBoard()
  await tick()
  check('openBoard() subscribes once', h.counters.subscribe, 1)
  check('openBoard() pulls one catch-up snapshot', h.counters.state, 1)
  check('openBoard() holds a live listener', h.live(), 1)

  // A further notify/no-op while already open must not stack connections.
  h.controller.setExecutionOptions({ workspaces: [] })
  h.controller.openBoard()
  await tick()
  check('repeated openBoard() does not re-subscribe', h.counters.subscribe, 1)

  h.controller.closeBoard()
  await tick()
  check('closeBoard() releases the channel', h.counters.release, 1)
  check('closeBoard() leaves no live listener', h.live(), 0)
}

// --- 3. reopening re-subscribes and re-pulls --------------------------------
{
  const h = fakeHarness()
  h.controller.start()
  await tick()
  h.controller.openBoard()
  await tick()
  h.controller.closeBoard()
  await tick()
  h.controller.openBoard()
  await tick()
  check('reopen subscribes a second time', h.counters.subscribe, 2)
  check('reopen pulls a fresh snapshot', h.counters.state, 2)
}

// --- 4. page visibility gates the channel while the board stays open --------
{
  const h = fakeHarness()
  h.controller.start()
  await tick()
  h.controller.openBoard()
  await tick()
  h.controller.setDocumentVisible(false)
  await tick()
  check('hiding the page releases the channel', h.counters.release, 1)
  check('hiding the page keeps the board open', h.controller.getSnapshot().boardOpen, true)
  h.controller.setDocumentVisible(true)
  await tick()
  check('showing the page re-subscribes', h.counters.subscribe, 2)
  check('showing the page pulls a catch-up snapshot', h.counters.state, 2)
  h.controller.setDocumentVisible(false)
  h.controller.openBoard()
  await tick()
  check('an open board in a hidden page holds no channel', h.live(), 0)
}

// --- 5. dispose releases whatever is held -----------------------------------
{
  const h = fakeHarness()
  h.controller.start()
  await tick()
  h.controller.openBoard()
  await tick()
  h.controller.dispose()
  check('dispose() releases the channel', h.counters.release, 1)
  check('dispose() leaves no live listener', h.live(), 0)
  h.controller.dispose()
  check('dispose() is idempotent', h.counters.release, 1)
}

// --- 6. the channel waits for the Host bootstrap -----------------------------
{
  const h = fakeHarness({ deferBootstrap: true })
  h.controller.start()
  h.controller.openBoard()
  await tick()
  check('a board opened before bootstrap holds no channel yet', h.counters.subscribe, 0)
  h.resumeBootstrap()
  await tick()
  await tick()
  check('the channel opens once the bootstrap lands', h.counters.subscribe, 1)
  check('the first frame after bootstrap is honoured', h.live(), 1)
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
