/**
 * 假 running 自愈 —— 兜底结算判据的单测（卡：假 running 收口 2026-09-14）。
 *
 * 覆盖两件事：
 *   ① `isStalePendingSettlement` 真值表（会话已结束 + 静默超阈值 ⇒ 兜底结算 interrupted）；
 *   ② 决策顺序复刻 `HostTaskBoardService.reconcileExecutions`：**真 running 卡绝不结算**
 *      （Q3 护栏反向断言）、列表不可读不结算、阈值内不急结算、超阈值才兜底。
 *
 * Run: node --experimental-transform-types _test/fake-running-heal.test.mjs
 */
import { isExecutionAlive, isStalePendingSettlement, normalizeEpochMs, STALE_PENDING_SETTLE_MS, SESSION_START_GRACE_MS } from '../src/host-runner.ts'
import { settleExecution, startExecution, createTask } from '../src/core/tasks.ts'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

const NOW = 1_700_000_000_000
const MIN = 60_000
const index = (running, listed, known = true, lastActivity) => ({
  known,
  running: new Set(running),
  listed: new Set(listed),
  ...(lastActivity === undefined ? {} : { lastActivity }),
})

// -------------------------------------------------------- ① 兜底判据真值表
check('阈值常量 = 10 分钟', STALE_PENDING_SETTLE_MS, 10 * MIN)
check('会话已结束 + 静默 20 分钟 → 兜底结算', isStalePendingSettlement({ sessionEnded: true, startedAt: NOW - 20 * MIN, now: NOW }), true)
check('会话已结束 + 刚刚静默 10 分钟（边界）→ 兜底结算', isStalePendingSettlement({ sessionEnded: true, startedAt: NOW - 10 * MIN, now: NOW }), true)
check('会话已结束 + 只静默 5 分钟 → 不兜底（先给 inspect 机会）', isStalePendingSettlement({ sessionEnded: true, startedAt: NOW - 5 * MIN, now: NOW }), false)
check('★护栏：会话仍在跑（sessionEnded=false）→ 绝不兜底', isStalePendingSettlement({ sessionEnded: false, startedAt: NOW - 20 * MIN, now: NOW }), false)
check('★护栏：会话刚启动 1 分钟 → 绝不兜底（启动期不判死）', isStalePendingSettlement({ sessionEnded: true, startedAt: NOW - 1 * MIN, now: NOW }), false)
check('主包说会话 2 分钟前还有活动 → 不兜底（有新事件就不算静默）', isStalePendingSettlement({ sessionEnded: true, startedAt: NOW - 20 * MIN, lastActivityAt: NOW - 2 * MIN, now: NOW }), false)
check('主包活动戳成为新的静默起点（15 分钟前）→ 兜底', isStalePendingSettlement({ sessionEnded: true, startedAt: NOW - 60 * MIN, lastActivityAt: NOW - 15 * MIN, now: NOW }), true)
check('阈值可注入（单测友好）', isStalePendingSettlement({ sessionEnded: true, startedAt: NOW - 2 * MIN, now: NOW, thresholdMs: MIN }), true)
check('非法 startedAt → 不兜底', isStalePendingSettlement({ sessionEnded: true, startedAt: 0, now: NOW }), false)

// ------------------------------------------------ ② 逐行复刻 reconcile 决策顺序
/**
 * 与 host-service.reconcileExecutions 同序：先过 liveness 三护栏，再 inspect，
 * pending 时按兜底判据决定要不要结算 interrupted。
 * @param {{sessionId:string, startedAt:number}} execution
 * @param {object} liveness
 * @param {'pending'|'succeeded'|'failed'|'interrupted'} inspectOutcome
 */
function reconcileDecision(execution, liveness, inspectOutcome) {
  const alive = isExecutionAlive(execution.sessionId, liveness)
  if (!alive.determined) return 'keep-running'                                   // 列表不可读 → 不结算
  if (alive.alive) return 'keep-running'                                         // 仍在跑 → 绝不结算
  if (alive.reason === 'session-missing' && NOW - execution.startedAt < SESSION_START_GRACE_MS) return 'keep-running'
  if (inspectOutcome !== 'pending') return `settle-${inspectOutcome}`
  const lastActivityAt = liveness.lastActivity?.get(execution.sessionId)
  return isStalePendingSettlement({ sessionEnded: true, startedAt: execution.startedAt, lastActivityAt, now: NOW })
    ? 'settle-interrupted'
    : 'keep-running'
}

const stuck = { taskId: 'card-fixture01', executionId: 'exec-1', sessionId: 'session-fixture01', startedAt: NOW - 23 * MIN }

// 现场复现：会话已结束（listed 且 idle）+ inspect 判不出结果 → 必须兜底结算，卡不能再挂着
check('★现场：stale 假 running 卡（会话 idle + inspect pending 23 分钟）→ 兜底 interrupted',
  reconcileDecision(stuck, index([], ['session-fixture01'], true, new Map([['session-fixture01', NOW - 23 * MIN]])), 'pending'), 'settle-interrupted')

// 反向断言：真 running 卡绝不能被兜底碰（Q3 护栏）
check('★反向：真 running 卡（会话在跑）→ keep-running',
  reconcileDecision({ ...stuck, sessionId: 'session-live' }, index(['session-live'], ['session-live']), 'pending'), 'keep-running')
check('★反向：真 running 卡即便 inspect 说 succeeded → 也不结算（防假结算）',
  reconcileDecision({ ...stuck, sessionId: 'session-live' }, index(['session-live'], ['session-live']), 'succeeded'), 'keep-running')
// 反向断言：列表不可读 → 不结算（宁可卡着也不猜）
check('★反向：会话列表不可读 → keep-running',
  reconcileDecision(stuck, index([], [], false), 'pending'), 'keep-running')
// 阈值内不急着兜底：inspect 还有机会自己给出正确结果
check('会话刚结束 3 分钟 → 先 keep-running（等 inspect）',
  reconcileDecision({ ...stuck, startedAt: NOW - 3 * MIN }, index([], ['session-fixture01'], true, new Map([['session-fixture01', NOW - 3 * MIN]])), 'pending'), 'keep-running')
// 正常路径不受影响：inspect 给出结果就直接用
check('inspect 给出 succeeded → settle-succeeded（兜底不抢正常路径）',
  reconcileDecision(stuck, index([], ['session-fixture01'], true), 'succeeded'), 'settle-succeeded')
check('inspect 给出 interrupted → settle-interrupted',
  reconcileDecision(stuck, index([], ['session-fixture01'], true), 'interrupted'), 'settle-interrupted')

// ------------------------------------------------- ③ 落点：兜底后卡必须可操作
const card = createTask({ title: '假 running 卡', description: '', prompt: 'p' }, 1000, 'card-fake')
const running = startExecution(card, NOW - 23 * MIN, 'exec-1')
const healed = settleExecution(running.task, 'exec-1', 'interrupted', NOW, 'stale pending fallback')
check('兜底结算后卡回 todo（不是永久 running，也不是待验收）', healed.status, 'todo')
check('兜底结算记录 result/interrupted', healed.executions[0].result, 'interrupted')
check('兜底结算记录原因', healed.executions[0].error, 'stale pending fallback')

// ---------------------------------------------- ④ 主包时间戳单位归一（秒/毫秒都要认）
check('normalizeEpochMs: 毫秒直通', normalizeEpochMs(NOW), NOW)
check('normalizeEpochMs: 秒 → 毫秒', normalizeEpochMs(Math.floor(NOW / 1000)), Math.floor(NOW / 1000) * 1000)
check('normalizeEpochMs: 字符串毫秒', normalizeEpochMs(String(NOW)), NOW)
check('normalizeEpochMs: 非法值 → undefined', normalizeEpochMs('nope'), undefined)
check('normalizeEpochMs: 0/负数 → undefined', normalizeEpochMs(0), undefined)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
