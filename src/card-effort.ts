/**
 * 卡面档位（G-1）—— harness 成本与路由线 · 主人 2026-10-16 拍板。
 *
 * 背景（方案 §4.2 缺口 + 审核档 I-3）：平台 `SessionCreateRequest` **没有** model /
 * reasoningEffort 字段（只有 `workspaceId` / `cwd` / `sessionId` / `agentPreset`），
 * 所以卡执行会话建出来时只能落在**部署默认档**上。正解是 `create` 之后补调一次
 * `sessionController.selectModel`。
 *
 * 本文件只装**纯函数**：把卡面那行档位读出来、把"要不要调 / 调完怎么收尾"算清楚；
 * 真正的调用留给 `host-runner.ts`（它才有通道与宿主 ctx）。
 *
 * 卡面写法（写在卡的 `description` 里，**整行只有档位值**）：
 *
 *     建议档位：low
 *
 * ⚠️ 「行首 + 整行」锚定是刻意的：卡面正文里出现「建议档位：X」这类**说明文字**不会被
 * 当成指令（`X` 不在四值里 ⇒ 不命中）。
 * @module
 */

/** 档位四值；与 GUI「推理等级」同集（口径见生态内的档位表）。 */
export const CARD_EFFORTS = ['off', 'low', 'high', 'max'] as const

/** One reasoning effort a card may ask for. */
export type CardEffort = (typeof CARD_EFFORTS)[number]

/** 最小模型选择形状（对齐平台 `ModelSelection`：`provider` / `model` 必填，档位可选）。 */
export interface ModelSelectionLike {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/**
 * 卡面档位行的文法：行首「建议档位」或「推理档位」+ 冒号 + **整行只有**四值之一。
 * `m` 让 `^` / `$` 按行匹配；大小写不敏感（`LOW` 也认）；全角与半角冒号都认。
 */
const CARD_EFFORT_LINE = /^[ \t]*(?:建议|推理)[ \t]*档位[ \t]*[:：][ \t]*(off|low|high|max)[ \t]*$/im

/**
 * 从卡面 `description` 里读档位。
 *
 * ⚠️ 刻意**不扫** `prompt`：那是发给模型的长正文，里面出现"档位"字样的概率远高于
 * description（本插件自己的卡就在正文里讨论档位）⇒ 扫它等于给派活埋一颗误触发。
 * @param description - 卡的描述字段（人填的运维字段）。
 * @returns 命中的档位；`undefined` = 本卡没表态（**零行为变化**）。
 */
export function readCardReasoningEffort(description: string): CardEffort | undefined {
  const matched = CARD_EFFORT_LINE.exec(description)
  return matched === null ? undefined : (matched[1].toLowerCase() as CardEffort)
}

/**
 * 把 `unknown` 窄化成 {@link ModelSelectionLike}（宿主服务返回的东西一律当外部输入）。
 * @param value - 待窄化的值。
 * @returns 形状合法时的选择；否则 `null`（调用方按"读不到基线"降级）。
 */
export function readSelectionLike(value: unknown): ModelSelectionLike | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
  if (typeof candidate.provider !== 'string' || candidate.provider === '') return null
  if (typeof candidate.model !== 'string' || candidate.model === '') return null
  const effort = candidate.reasoningEffort
  if (effort !== undefined && typeof effort !== 'string') return null
  return effort === undefined || effort === ''
    ? { provider: candidate.provider, model: candidate.model }
    : { provider: candidate.provider, model: candidate.model, reasoningEffort: effort }
}

/** 一次「按卡面档位调力度」的判决。 */
export type CardEffortPlan =
  | { readonly kind: 'skip'; readonly reason: 'no-effort' | 'no-baseline' | 'same' }
  | {
      readonly kind: 'apply'
      /** 送给 `session/selectModel` 的请求：`provider` / `model` 照抄基线，只换档位。 */
      readonly request: ModelSelectionLike & { readonly sessionId: string; readonly reasoningEffort: string }
      /** 应用后要把**全局默认档**写回的值；`null` = 没通道恢复（无副作用治理能力）。 */
      readonly restore: ModelSelectionLike | null
    }

/**
 * 算一次档位判决（纯函数 —— 夹具直接喂值就能覆盖全部分支）。
 *
 * 判据（**按顺序短路**）：
 * - `no-effort`：卡面没写档位 ⇒ **一次调用都不发**；
 * - `no-baseline`：读不到基线选择 ⇒ 不敢猜 `provider` / `model`（猜错会把会话切到别的模型上）；
 * - `same`：卡面档位 == 基线档位 ⇒ 会话本来就是这个力度，不发（**也零副作用**）；
 * - 其余 ⇒ `apply`，并给出要不要把全局默认档写回去。
 *
 * 🔴 为什么必须带基线：`SessionSelectModelRequest` 的 `provider` / `model` 是**必填**
 * （strict codec），只传档位会被平台拒；"只改档位、不动模型"只能靠**照抄基线**实现。
 * @param input - 卡面文本、会话 id、基线选择、以及"有没有回写通道"。
 * @returns 判决结果。
 */
export function planCardEffort(input: {
  readonly description: string
  readonly sessionId: string
  readonly base: ModelSelectionLike | null
  readonly canRestore: boolean
}): CardEffortPlan {
  const effort = readCardReasoningEffort(input.description)
  if (effort === undefined) return { kind: 'skip', reason: 'no-effort' }
  const base = input.base
  if (base === null) return { kind: 'skip', reason: 'no-baseline' }
  if (base.reasoningEffort === effort) return { kind: 'skip', reason: 'same' }
  return {
    kind: 'apply',
    request: {
      sessionId: input.sessionId,
      provider: base.provider,
      model: base.model,
      reasoningEffort: effort,
    },
    restore: input.canRestore ? base : null,
  }
}
