/**
 * fs-atomic.ts —— 原子替换（tmp → rename）的**唯一口**，带 EPERM 类瞬时锁退避重试。
 *
 * 为什么要有这个文件（两次实录，不是猜）：
 *   Windows 上「写 tmp → rename 覆盖目标」这套原子写在目标被**任何进程以不带删除共享的
 *   句柄打开**时会抛 `EPERM`（杀软扫 11.9 MB 账本、搜索索引、同步 / 备份工具、另一个读者）。
 *   原实现是裸 `renameSync`、**没有重试** ⇒ 一次瞬时锁就让整次动作失败，卡被记成 `failed`，
 *   而卡会话其实跑完了（宿主侧写失败 ≠ 执行失败 ⇒ 假失败，要人肉核产物，重跑还会双写）：
 *     · 2026-10-30 17:21:31 卡 `c4a2b048`【家庭保姆·SDK盯梢】
 *     · 2026-11-09 00:45:01 卡 `10078663`【望海·PKG-EXPORT】
 *   两条 `executions[]` 的 error 首行是同一个签名（`ledger-v2.json.tmp-<pid>` → `ledger-v2.json`）。
 *   账本已 11.9 MB / 926 卡，越大被杀软扫得越久 ⇒ 命中概率只会变高。
 *
 * 重试语义（写死，别自由发挥 —— 改这里等于改所有原子写点的行为）：
 *   ① 延迟序列 20 / 40 / 80 / 160 / 320 ms ⇒ 最多 **5 次重试**，总计 ≈620 ms；
 *   ② 只对 `err.code ∈ { EPERM, EACCES, EBUSY }` 重试 —— **其它错误立即抛**
 *      （不许把 ENOSPC / EXDEV / 真 bug 也重试 5 遍掩盖掉；`EXDEV` 的跨盘处置照旧）；
 *   ③ 每次重试打一行 stderr（第几次 / errno / 目标 basename）；
 *   ④ 最终仍失败：**不删 tmp**（留给取证）+ 再打一行 stderr + 抛**原错误**。
 *      调用方用 `isTmpPreserved(error)` 判断「这个 tmp 要留」，别再当普通失败清掉。
 *
 * ⚠️ 同步阻塞：调用点全是同步函数（`HostTaskLedger.commit()` 是 sync、`gateDestructive`
 * 的 action 也是 sync），所以等待只能阻塞 —— 用 `Atomics.wait`（Node 主线程允许），
 * 最坏 620 ms 且**只在这类瞬时锁真命中时**发生，代价远小于一次假失败。
 */

import { renameSync } from 'node:fs'
import { basename } from 'node:path'

/** 退避延迟序列（ms）。长度 = 最大重试次数；总等待 ≈620 ms。 */
export const RENAME_RETRY_DELAYS_MS: readonly number[] = [20, 40, 80, 160, 320]

/** 总退避预算（ms），只用于报告 / 夹具断言。 */
export const RENAME_RETRY_TOTAL_MS: number = RENAME_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)

/** 真·瞬时锁（Windows 共享模式冲突 / POSIX 权限瞬时抖动）——**只有这三个**重试。 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** 失败时已完成重试次数 / 最终 errno（诊断 + 夹具读数用）。 */
export interface RenameRetryFailureInfo {
  attempts: number
  retries: number
  code: string
  from: string
  to: string
}

/** 最近一次最终失败的信息（`renameWithRetry` 抛错时写入；只读诊断，不影响控制流）。 */
let lastFailure: RenameRetryFailureInfo | null = null

/** 读最近一次「重试耗尽仍失败」的读数（没失败过 ⇒ `null`）。 */
export function lastRenameFailure(): RenameRetryFailureInfo | null {
  return lastFailure
}

/** 最终失败、tmp 按约定被保留的错误集合（弱引用，不阻 GC、不泄漏）。 */
const tmpPreservedErrors = new WeakSet<object>()

/**
 * 这个错误是不是「重试耗尽 + tmp 已按约定留下取证」？
 * `true` ⇒ 调用方的失败清理**跳过删 tmp**（否则取证件当场被自己删掉）。
 */
export function isTmpPreserved(error: unknown): boolean {
  return typeof error === 'object' && error !== null && tmpPreservedErrors.has(error)
}

/**
 * 夹具注入点（生产代码**一律不传**）：替换底层 rename / 等待器。
 * 语义（延迟序列、可重试 errno、重试上限、失败后保留 tmp）全部写死在本文件，注入改不了。
 */
export interface RenameWithRetryOptions {
  /** 替换底层 rename（用来注入 EPERM / EACCES / EBUSY / ENOSPC）。 */
  rename?: (from: string, to: string) => void
  /** 替换退避等待（让夹具不必真等 620 ms）。 */
  sleep?: (ms: number) => void
}

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // 极少数环境没有 SharedArrayBuffer / 不允许 wait：退化忙等，语义不变。
    const until = Date.now() + ms
    while (Date.now() < until) { /* spin */ }
  }
}

function errCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code
  return typeof code === 'string' ? code : ''
}

/**
 * `tmp → 目标` 的原子替换；EPERM / EACCES / EBUSY 按固定退避重试，其余错误立即抛。
 *
 * @throws 原错误（可重试错误重试耗尽后原样抛出，且 tmp **保留**）
 */
export function renameWithRetry(from: string, to: string, options: RenameWithRetryOptions = {}): void {
  const rename = options.rename ?? renameSync
  const sleep = options.sleep ?? sleepSync
  const target = basename(to)
  for (let retries = 0; ; retries += 1) {
    try {
      rename(from, to)
      lastFailure = null
      return
    } catch (error) {
      const code = errCode(error)
      // ② 非锁类错误（ENOSPC / EXDEV / ENOENT / EACCES-非锁…）立即抛，一次都不重试。
      if (!RETRYABLE_CODES.has(code)) throw error
      // ④ 重试耗尽 ⇒ 保留 tmp + 一行日志 + 抛原错误。
      if (retries >= RENAME_RETRY_DELAYS_MS.length) {
        const attempts = retries + 1
        lastFailure = { attempts, retries, code, from, to }
        if (typeof error === 'object' && error !== null) tmpPreservedErrors.add(error)
        process.stderr.write(
          `[task-board] rename 重试 ${retries} 次仍失败（${code}）：保留 tmp 取证 ${basename(from)} → ${target}\n`,
        )
        throw error
      }
      const delayMs = RENAME_RETRY_DELAYS_MS[retries] as number
      // ③ 每次重试一行（第几次 / errno / 目标 basename）。
      process.stderr.write(
        `[task-board] rename 第 ${retries + 1} 次重试（${code}，${delayMs}ms 后）：${basename(from)} → ${target}\n`,
      )
      sleep(delayMs)
    }
  }
}
