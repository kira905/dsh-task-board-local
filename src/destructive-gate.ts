/**
 * destructive-gate.ts —— R-065「删除 / 搬移三件套」在本插件里的**唯一口**（锁6 · 批 E4 · 2026-10-19）
 *
 * 语义对齐生态内的共享删除闸 `gateDestructive()`：
 *   ① reparse point 拒删 / 拒搬（目标自身或树内 junction/symlink ⇒ 拒，防「跟删」）
 *   ② 白名单拒跑（目标必须落在调用方声明的根之下；不声明 = 拒）
 *   ③ dry-run 是**写动作函数内的第一道门**（本文件每个入口第一条语句）
 *   ④ 作用域必须点明（本文件的动作只触及「文件面」）
 *
 * ⚠️ 为什么是**动态可选依赖**而不是静态 `import`：
 *   本插件实体（`lib/index.js` 与整个包）会被拷进 `~/.dsh/profiles/<profile>/node_modules/`，
 *   `../../lib/production-guard.mjs` 那种相对路径在实体里会失效 ⇒ 静态 import 会**直接让插件 boot 失败**。
 *   所以按生态里同一口径（批 E1 先例）：运行时按多路径尝试加载共享件；
 *   全加载不到 ⇒ 降级为**最小内联自检**（只拦 reparse point），**绝不裸删 / 裸搬**。
 *   共享件本身不随本包分发：公开安装里没有它，探测全部落空后走的就是这条降级路径。
 *
 * 被拒的处置：**抛错**（调用方不得「警告后继续」）。清理类调用点自己 try/catch ⇒ 等价于「跳过删除」。
 */

import { lstatSync } from 'node:fs'

export type DestructiveTarget = string | { path: string; label?: string }

export interface GuardedDestructiveOptions {
  /** 本次要删 / 要搬的目标（搬移时给 src 与 dst 两条）。 */
  targets: DestructiveTarget[]
  /** 允许动的根（**必填**；不声明 = 拒跑）。 */
  whitelist: string[]
  /** 动词（只影响文案）：`删` / `删目录` / `搬移`。 */
  op?: string
  reason?: string | null
  /** ③ dry-run：**第一条语句**就返回，零动作。 */
  dryRun?: boolean
  /** 真动作（只在闸通过后执行）。 */
  action?: () => unknown
}

const PG_DESTRUCTIVE = await (async () => {
  for (const spec of ['../../lib/production-guard.mjs', '../lib/production-guard.mjs']) {
    try { return await import(spec) } catch { /* next */ }
  }
  return null
})()

/**
 * 唯一删 / 搬口。返回 `true` = 已执行；被拒或 dry-run ⇒ `false` / 抛错。
 * @throws 三件套拒绝时抛 Error（点名 code + 第一行理由）
 */
export function gateDestructive({ targets, whitelist, op = '删', reason = null, dryRun = false, action }: GuardedDestructiveOptions): boolean {
  const list = (targets ?? []).map((t) => (typeof t === 'string' ? { path: t, label: reason ?? '' } : t))
  if (dryRun === true) return false
  if (PG_DESTRUCTIVE) {
    const g = PG_DESTRUCTIVE.gateDestructive({
      targets: list, whitelist, op, scope: ['file'], requires: ['file'],
      dryRun: false, allowProduction: true, allowReparse: false, ledgerBypass: false, reason,
    })
    if (!g.ok) throw new Error(`R-065 拒${op}（${g.code ?? 'blocked'}）：${String(g.reason).split('\n')[0]}`)
  } else {
    // 降级：只拦「目标自身是 reparse point / 不在白名单」——宁可少做，绝不多删。
    const isUnder = (p: string, r: string) => {
      const a = String(p).replace(/[\\/]+$/, '').toLowerCase()
      const b = String(r).replace(/[\\/]+$/, '').toLowerCase()
      return a === b || a.startsWith(`${b}\\`) || a.startsWith(`${b}/`)
    }
    for (const t of list) {
      if (!(whitelist ?? []).some((r) => r && isUnder(t.path, r))) throw new Error(`R-065 拒${op}：目标不在白名单根内（${t.path}）`)
      try {
        if (lstatSync(t.path).isSymbolicLink()) throw new Error(`R-065 拒${op}：目标是 reparse point（${t.path}）`)
      } catch (e) {
        if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw e
      }
    }
  }
  if (typeof action === 'function') action()
  return true
}

/** 共享件是否真加载到（报告 / 自检用；`false` ⇒ 走的是降级自检）。 */
export const SHARED_GUARD_LOADED = PG_DESTRUCTIVE !== null
