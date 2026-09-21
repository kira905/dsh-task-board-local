/**
 * Card [账本陈旧串] regression tests: `scheduler.error` must describe the
 * CURRENT load, never replay a historical one.
 *
 * The stale string this guards against was baked into the ledger itself:
 * `load()` copied `parsed.scheduler.error` straight through, so a single
 * historical misjudgement ("corrupt ledger was quarantined: unsupported ledger
 * schema") kept being echoed by GET /api/task-board/state while the ledger was
 * demonstrably healthy.
 *
 * Three behaviours are pinned here:
 *   1. a ledger that loads cleanly drops a stale error, and the clean value is
 *      persisted (not just masked in memory);
 *   2. a genuinely unreadable ledger still reports its fresh quarantine error
 *      and still quarantines the file;
 *   3. the load is idempotent — a second open of a healthy ledger yields the
 *      same revision/scheduler identity/error.
 *
 * Real `HostTaskLedger` is driven through a temp directory, so no production
 * path is touched. It is imported from the SHIPPED bundle (`lib/index.js`) —
 * the artifact dsh loads — with `_test/loader.mjs` bridging its external
 * `schemastery` import to the dsh home copy.
 * Run: node --loader ./_test/loader.mjs _test/host-ledger-scheduler-error.test.mjs
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostTaskLedger } from '../lib/index.js'

const STALE = 'corrupt ledger was quarantined: unsupported ledger schema'
const VALID_CRON = '0 9 * * *'
const PAST = Date.parse('2026-01-01T00:00:00Z')
const NOW = () => Date.parse('2026-06-01T00:00:00Z')

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

const scratch = mkdtempSync(join(tmpdir(), 'task-board-ledger-'))
function makeDir(tag) {
  const dir = join(scratch, tag)
  mkdirSync(dir, { recursive: true })
  return dir
}

function fixtureTask(id, description, extra = {}) {
  return {
    id,
    title: id,
    description,
    prompt: 'do nothing',
    status: 'todo',
    kind: 'once',
    createdAt: PAST,
    updatedAt: PAST,
    executions: [],
    ...extra,
  }
}

/** A ledger file that parses and validates, but carries the stale error string. */
function writeHealthy(dir, tasks) {
  writeFileSync(join(dir, 'ledger-v2.json'), JSON.stringify({
    schemaVersion: 2,
    revision: 7,
    tasks,
    scheduler: { timeZone: 'Asia/Shanghai', ledgerId: 'fixture-ledger', lastTickAt: PAST, error: STALE },
    recentRequests: [],
  }, null, 2), 'utf8')
}

function readDocument(dir) {
  return JSON.parse(readFileSync(join(dir, 'ledger-v2.json'), 'utf8'))
}

function quarantined(dir) {
  return readdirSync(dir).filter(name => name.includes('.corrupt-'))
}

try {
  // --- 1. healthy ledger: the stale string is dropped AND persisted ----------
  {
    const dir = makeDir('healthy')
    writeHealthy(dir, [
      fixtureTask('t-plain', 'plain card'),
      fixtureTask('t-cron', 'scheduled card', { kind: 'recurring', schedule: { enabled: true, cron: VALID_CRON, nextRunAt: PAST } }),
    ])
    const ledger = new HostTaskLedger(dir, NOW)
    const snapshot = ledger.summary()
    check('healthy load: stale scheduler.error cleared', snapshot.scheduler.error, undefined)
    check('healthy load: ledger identity preserved', snapshot.scheduler.ledgerId, 'fixture-ledger')
    check('healthy load: tasks parsed', snapshot.revision, 8)
    check('healthy load: quarantined nothing', quarantined(dir), [])
    const persisted = readDocument(dir)
    check('healthy load: cleared error persisted to disk', 'error' in persisted.scheduler, false)
    check('healthy load: disk still has both tasks', persisted.tasks.length, 2)
    ledger.dispose()
  }

  // --- 2. genuinely corrupt ledger: fresh error, quarantine file kept --------
  {
    const dir = makeDir('corrupt')
    writeFileSync(join(dir, 'ledger-v2.json'), '{"schemaVersion":not json', 'utf8')
    const ledger = new HostTaskLedger(dir, NOW)
    const snapshot = ledger.summary()
    check('corrupt load: reports a fresh quarantine error', typeof snapshot.scheduler.error === 'string' && snapshot.scheduler.error.startsWith('corrupt ledger was quarantined:'), true)
    check('corrupt load: quarantined file left on disk', quarantined(dir).length, 1)
    check('corrupt load: no tasks recovered', snapshot.revision, 0)
    ledger.dispose()
  }

  // --- 2b. schema rejection (the exact historical misjudgement) -------------
  {
    const dir = makeDir('schema')
    writeFileSync(join(dir, 'ledger-v2.json'), JSON.stringify({ schemaVersion: 1, revision: 3, tasks: [], scheduler: {} }, null, 2), 'utf8')
    const ledger = new HostTaskLedger(dir, NOW)
    check('schema load: reports unsupported schema', ledger.summary().scheduler.error, 'corrupt ledger was quarantined: unsupported ledger schema')
    check('schema load: quarantined file left on disk', quarantined(dir).length, 1)
    ledger.dispose()
  }

  // --- 3. missing ledger: no error invented ---------------------------------
  {
    const dir = makeDir('missing')
    const ledger = new HostTaskLedger(dir, NOW)
    check('missing ledger: no error reported', ledger.summary().scheduler.error, undefined)
    check('missing ledger: nothing quarantined', quarantined(dir), [])
    ledger.dispose()
  }

  // --- 4. idempotent reopen (no self-inflicted error, no revision creep) -----
  {
    const dir = makeDir('reopen')
    writeHealthy(dir, [fixtureTask('t-cron', 'scheduled card', { kind: 'recurring', schedule: { enabled: true, cron: VALID_CRON, nextRunAt: PAST } })])
    const first = new HostTaskLedger(dir, NOW)
    const firstState = first.summary()
    first.dispose()
    const second = new HostTaskLedger(dir, NOW)
    const secondState = second.summary()
    second.dispose()
    check('reopen: error stays cleared', secondState.scheduler.error, undefined)
    check('reopen: revision unchanged', secondState.revision, firstState.revision)
    check('reopen: ledger identity unchanged', secondState.scheduler.ledgerId, firstState.scheduler.ledgerId)
    check('reopen: no quarantine files', quarantined(dir), [])
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
