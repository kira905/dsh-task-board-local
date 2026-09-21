/**
 * Pure state-machine checks for the local fork (no runtime faces needed).
 * Run: node --experimental-strip-types _test/state-machine.test.mjs
 */
import {
  canMoveManually, confirmedStatus, createTask, isInteractiveTask, isRecurringTask,
  settleExecution, startExecution, taskKind,
} from '../src/core/tasks.ts'
import { canEditDescription, canEditTaskIdentity, hasIdentityPatch } from '../src/core/use-cases/task-update.ts'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

const base = createTask({ title: 't', description: 'd', prompt: 'p' }, 1000, 'id-1')
check('createTask default kind', base.kind, 'once')
check('createTask scheduled kind', createTask({ title: 't', description: 'd', prompt: 'p', schedule: { enabled: true, cron: '0 9 * * *' } }, 1000, 'id-2').kind, 'recurring')

const running = startExecution(base, 2000, 'exec-1')
check('startExecution moves to running', running.task.status, 'running')

const settled = settleExecution(running.task, 'exec-1', 'succeeded', 3000, undefined)
check('succeeded parks in review', settled.status, 'review')
check('succeeded keeps execution record', settled.executions[0].result, 'succeeded')

check('failed goes to failed', settleExecution(running.task, 'exec-1', 'failed', 3000, 'boom').status, 'failed')
check('cancelled returns to todo', settleExecution(running.task, 'exec-1', 'cancelled', 3000, undefined).status, 'todo')

check('confirm once -> done', confirmedStatus(settled), 'done')
check('confirm recurring -> todo', confirmedStatus({ ...settled, kind: 'recurring' }), 'todo')
check('legacy scheduled row infers recurring', taskKind({ ...base, kind: undefined, schedule: { enabled: true, cron: '0 9 * * *', nextRunAt: undefined, lastTriggeredAt: undefined } }), 'recurring')
check('legacy plain row infers once', taskKind(base), 'once')
check('interactive detection', isInteractiveTask({ ...base, kind: 'interactive' }), true)
check('recurring detection', isRecurringTask({ ...base, kind: 'recurring' }), true)

check('manual backlog -> done allowed', canMoveManually('backlog', 'done'), true)
check('manual review -> todo allowed', canMoveManually('review', 'todo'), true)
check('manual running -> todo refused', canMoveManually('running', 'todo'), false)
check('manual todo -> review refused', canMoveManually('todo', 'review'), false)

const executed = { ...base, executions: settled.executions }
check('identity frozen after run', canEditTaskIdentity(executed), false)
check('description editable after run', canEditDescription(executed), true)
check('identity patch detected', hasIdentityPatch({ prompt: 'x' }), true)
check('description-only patch not identity', hasIdentityPatch({ description: 'x' }), false)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
