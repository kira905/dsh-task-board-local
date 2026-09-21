/**
 * 复现测试（可证伪对照）：超大会话把 `inspect()` 打回 pending，卡永久 running。
 *
 * 现场（2026-09-14，一张假 running 卡 / 一个体积异常的会话）：
 *   - `session.history` 第一页一次返回 127,614 条事件；
 *   - `host-runner.ts` 用 `events.push(...pageEvents)` 合并 → 12.7 万个实参
 *     → `RangeError: Maximum call stack size exceeded`；
 *   - 该 RangeError 被同函数 `try/catch` 吞掉 → 返回 `{ outcome: 'pending' }`
 *     → `host-service.reconcileExecutions` 里 `if (result.outcome === 'pending') continue`
 *     → 结算永远不发生，卡卡在 running（假 running）。
 *
 * 本测试用 mock fetch 造同样形状（单页 > 10 万事件 + 一条完成的 turn/end）：
 *   - 修复前：outcome = 'pending'（FAIL）
 *   - 修复后：outcome = 'succeeded'（PASS）
 *
 * Run: node --experimental-strip-types _test/fake-running-repro.test.mjs
 */
import { HostExecutionRunner } from '../src/host-runner.ts'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

const STARTED_AT = 1_000_000
// 与现场同量级：单页 12.7 万条（远超 V8 的实参上限 ~6.5 万）
const HUGE = 127_000

function eventPage(events, hasMore) {
  return {
    json: async () => ({ result: { ok: true, value: { events, hasMore } } }),
  }
}

/** 造一个"单页超大会话"的 history 端点（第 0 页给全部，之后 hasMore=false）。 */
function mockHugeHistory({ turnEndKind = 'completed', turnEndCount = 1 } = {}) {
  const events = []
  for (let i = 0; i < HUGE - turnEndCount; i += 1) {
    events.push({ event: { type: 'assistant/chunk', seq: i, time: STARTED_AT + 1 + i } })
  }
  for (let i = 0; i < turnEndCount; i += 1) {
    events.push({
      event: { type: 'turn/end', seq: HUGE - turnEndCount + i, time: STARTED_AT + 60_000 + i, data: { reason: { kind: turnEndKind } } },
    })
  }
  let calls = 0
  return async () => {
    calls += 1
    return eventPage(calls === 1 ? events : [], false)
  }
}

/** 小会话：单页 < 100 条（对照组，两条路径都必须正常）。 */
function mockSmallHistory(kind = 'completed') {
  let calls = 0
  return async () => {
    calls += 1
    if (calls > 1) return eventPage([], false)
    return eventPage([
      { event: { type: 'turn/start', seq: 0, time: STARTED_AT + 1 } },
      { event: { type: 'assistant/message', seq: 1, time: STARTED_AT + 2 } },
      { event: { type: 'turn/end', seq: 2, time: STARTED_AT + 3, data: { reason: { kind } } } },
    ], false)
  }
}

const runner = new HostExecutionRunner({})
const originalFetch = globalThis.fetch

try {
  globalThis.fetch = mockHugeHistory({ turnEndKind: 'completed' })
  const huge = await runner.inspect('session-huge', STARTED_AT, { sessionEnded: true })
  check('★复现：超大会话（单页 127k 事件）+ 完成的 turn/end → succeeded', huge.outcome, 'succeeded')

  globalThis.fetch = mockHugeHistory({ turnEndKind: 'interrupted' })
  const hugeInterrupted = await runner.inspect('session-huge-2', STARTED_AT, { sessionEnded: true })
  check('超大会话 + 被打断的 turn/end → interrupted（不误判成功）', hugeInterrupted.outcome, 'interrupted')

  globalThis.fetch = mockSmallHistory('completed')
  check('对照：小会话 + completed → succeeded（两条路径都正常）', (await runner.inspect('session-small', STARTED_AT, { sessionEnded: true })).outcome, 'succeeded')

  globalThis.fetch = mockSmallHistory('aborted')
  check('对照：小会话 + aborted → interrupted', (await runner.inspect('session-small-2', STARTED_AT, { sessionEnded: true })).outcome, 'interrupted')

  // 会话已结束但历史里没有任何 turn/end → interrupted（既有语义不许回归）
  globalThis.fetch = async () => eventPage([{ event: { type: 'user/message', seq: 0, time: STARTED_AT + 1 } }], false)
  check('对照：已结束 + 无 turn/end → interrupted（既有兜底不回归）', (await runner.inspect('session-nonend', STARTED_AT, { sessionEnded: true })).outcome, 'interrupted')

  // 抓取失败 → pending（既有保守语义不许回归：调用方不得据此结算）
  globalThis.fetch = async () => { throw new Error('network down') }
  check('对照：历史读取失败 → pending（保守，不结算）', (await runner.inspect('session-broken', STARTED_AT, { sessionEnded: true })).outcome, 'pending')
} finally {
  globalThis.fetch = originalFetch
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exitCode = failures === 0 ? 0 : 1
