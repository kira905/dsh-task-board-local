/**
 * Card [Q3] regression tests: the restart false-settlement gate.
 *
 * Covers the four liveness states required by the card (session running /
 * session ended / session missing / no execution at all), the turn/end
 * classification measured on this machine's own logs, and the settlement
 * landing rule (an interrupted run may never land in 待验收).
 *
 * Run: node --experimental-strip-types _test/runner-liveness.test.mjs
 */
import { classifyTurnEnd, isExecutionAlive, SESSION_START_GRACE_MS } from '../src/host-runner.ts'
import { executionLabel, settleExecution, startExecution, createTask } from '../src/core/tasks.ts'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

// ---------------------------------------------------------------- liveness
const index = (running, listed, known = true) => ({ known, running: new Set(running), listed: new Set(listed) })

check('state 0 · no execution/session id → not alive, determined', isExecutionAlive(undefined, index(['session-a'], ['session-a'])), { determined: true, alive: false, reason: 'no-session-id' })
check('state 0 · empty session id → not alive', isExecutionAlive('', index([], [])).reason, 'no-session-id')

// State A: the session is still running → the card must stay running (never settled).
check('state A · session running → alive', isExecutionAlive('session-a', index(['session-a'], ['session-a'])), { determined: true, alive: true, reason: 'session-running' })
check('state A · running wins over listed', isExecutionAlive('session-a', index(['session-a', 'session-b'], ['session-a', 'session-b'])).alive, true)

// State B: the session is listed but idle → really finished; history decides the outcome.
check('state B · session idle → ended normally', isExecutionAlive('session-a', index([], ['session-a'])), { determined: true, alive: false, reason: 'session-idle' })

// State C: the session is gone from the list → the run cannot still be alive.
check('state C · session missing → gone', isExecutionAlive('session-a', index([], [])), { determined: true, alive: false, reason: 'session-missing' })
check('state C · missing ≠ alive', isExecutionAlive('session-a', index([], [])).alive, false)

// State D: the list could not be read → undetermined; callers must keep the card running.
check('state D · list unreadable → undetermined', isExecutionAlive('session-a', index([], [], false)), { determined: false, alive: false, reason: 'liveness-unknown' })
check('state D · undetermined is not alive', isExecutionAlive('session-a', index([], [], false)).alive, false)
check('grace window constant', SESSION_START_GRACE_MS, 30000)

// ------------------------------------------------------------ turn/end kinds
// Measured distribution on this machine (2026-09-11): completed 145,
// interrupted 23, aborted 16, error 1.
check('turn/end completed → succeeded', classifyTurnEnd({ turn: 1, reason: { kind: 'completed' } }), { outcome: 'succeeded', reason: 'completed' })
check('turn/end error → failed', classifyTurnEnd({ turn: 2, reason: { kind: 'error' } }), { outcome: 'failed', reason: 'error' })
check('turn/end interrupted → interrupted', classifyTurnEnd({ turn: 3, reason: { kind: 'interrupted' } }), { outcome: 'interrupted', reason: 'interrupted' })
check('turn/end aborted → interrupted', classifyTurnEnd({ turn: 4, reason: { kind: 'aborted', reason: { kind: 'user' } } }), { outcome: 'interrupted', reason: 'aborted' })
check('turn/end unknown kind → interrupted (never a success)', classifyTurnEnd({ turn: 5, reason: { kind: 'something-new' } }), { outcome: 'interrupted', reason: 'something-new' })
check('turn/end missing reason → interrupted', classifyTurnEnd({ turn: 6 }), { outcome: 'interrupted', reason: 'unknown' })
check('turn/end null data → interrupted', classifyTurnEnd(null), { outcome: 'interrupted', reason: 'unknown' })

// ------------------------------------------------------------- landing rules
const base = createTask({ title: 't', description: 'd', prompt: 'p' }, 1000, 'card-q3')
const running = startExecution(base, 2000, 'exec-1')

check('interrupted → card returns to todo (not review)', settleExecution(running.task, 'exec-1', 'interrupted', 3000, 'cut off').status, 'todo')
check('interrupted → execution result recorded', settleExecution(running.task, 'exec-1', 'interrupted', 3000, 'cut off').executions[0].result, 'interrupted')
check('interrupted → error text recorded', settleExecution(running.task, 'exec-1', 'interrupted', 3000, 'cut off').executions[0].error, 'cut off')
check('interrupted → endedAt stamped', settleExecution(running.task, 'exec-1', 'interrupted', 3000, 'cut off').executions[0].endedAt, 3000)
check('succeeded still parks in review (no regression)', settleExecution(running.task, 'exec-1', 'succeeded', 3000, undefined).status, 'review')
check('failed still goes to failed (no regression)', settleExecution(running.task, 'exec-1', 'failed', 3000, 'boom').status, 'failed')
check('recurring interrupted card also returns to todo', settleExecution({ ...running.task, kind: 'recurring' }, 'exec-1', 'interrupted', 3000, 'x').status, 'todo')
check('label: interrupted', executionLabel({ id: 'e', sessionId: 's', startedAt: 1, endedAt: 2, result: 'interrupted', error: 'x' }), 'interrupted')

// ------------------------------------------------------- end-to-end decision
/**
 * The 2026-09-11 11:53 bug, replayed at the decision level: the ledger said
 * `succeeded` while the execution session kept running. With the gate, that
 * execution is never settled at all.
 */
function decide(execution, liveness) {
  const alive = isExecutionAlive(execution.sessionId, liveness)
  if (!alive.determined) return 'keep-running'
  if (alive.alive) return 'keep-running'
  if (alive.reason === 'session-missing' && Date.now() - execution.startedAt < SESSION_START_GRACE_MS) return 'keep-running'
  return 'may-settle'
}

const restarted = { taskId: 't', executionId: 'e', sessionId: 'session-fixture02', startedAt: Date.now() - 600_000 }
check('regression: restart with session still running → never settled', decide(restarted, index(['session-fixture02'], ['session-fixture02'])), 'keep-running')
check('restart with session gone → may settle (as interrupted)', decide(restarted, index([], [])), 'may-settle')
check('restart with session idle → may settle from history', decide(restarted, index([], ['session-fixture02'])), 'may-settle')
check('fresh launch not yet listed → keep running', decide({ ...restarted, startedAt: Date.now() - 1_000 }, index([], [])), 'keep-running')
check('unreadable list → keep running', decide(restarted, index([], [], false)), 'keep-running')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
