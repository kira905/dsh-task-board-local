/**
 * Task card: the board's column item. Clicking opens the task detail — it
 * never executes anything directly (detail holds the Run button).
 *
 * Memoized: the card re-renders only when its own task record changes, so a
 * status/filter update on one card (or scrolling) never re-renders every
 * card on the board. The per-card onClick is built with a stable task reference
 * by the board, so the memo boundary is effective.
 */
import { memo } from 'react'
import type { TaskRecord } from '../../core/tasks.ts'
import { executionLabel, isInteractiveTask, isRecurringTask, taskKind } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import { STATUS_KEY } from './status-key.ts'
import css from '../board.module.css'

/** Compact relative/absolute time label. */
export function formatHostTimestamp(ms: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
      ...(timeZone === undefined ? {} : { timeZone }),
    }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString()
  }
}

export function formatTime(ms: number, timeZone?: string): string {
  const date = new Date(ms)
  const now = Date.now()
  const minutes = Math.floor((now - ms) / 60000)
  if (minutes < 1) return t('time.justNow')
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  if (timeZone !== undefined) return formatHostTimestamp(ms, timeZone)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** One card in a column. */
function TaskCardInner({ task, pending, timeZone, showStatus, onClick }: { task: TaskRecord; pending: boolean; timeZone?: string; showStatus?: boolean; onClick: () => void }) {
  const latest = task.executions[task.executions.length - 1]
  const runs = task.executions.length
  const archived = task.archivedAt !== undefined
  // 主线视图一列里混着所有状态，卡面必须自带状态标识，才能一眼分清
  // 「做完的」和「没开始的」。状态视图的列头已经写了状态，故不显示（showStatus 控制）。
  const statusBadge = showStatus === true ? (
    <span className={css.cardStatus} data-status={archived ? 'archived' : task.status} data-dsh-part="card-status">
      {t(STATUS_KEY[task.status])}
    </span>
  ) : null
  const lineBadge = task.line === undefined ? null : (
    <span className={css.cardLine} title={`${t('detail.line')}: ${task.line}`}>
      {task.seq === undefined ? task.line : `${task.seq} · ${task.line}`}
    </span>
  )
  return (
    <button
      type="button"
      className={css.card}
      data-status={archived ? 'archived' : task.status}
      data-dsh-part="card"
      data-pending={pending || undefined}
      onClick={onClick}
      title={task.description !== '' ? task.description : task.title}
    >
      {statusBadge === null ? lineBadge : (
        <span className={css.cardTop}>
          {statusBadge}
          {lineBadge}
        </span>
      )}
      <span className={css.cardTitle}>{task.title}</span>
      {task.description !== '' && <span className={css.cardExcerpt}>{task.description}</span>}
      <span className={css.cardMeta}>
        {!archived && taskKind(task) !== 'once' && (
          <span className={css.cardKind} data-kind={taskKind(task)}>
            {t(isInteractiveTask(task) ? 'card.kind.interactive' : 'card.kind.recurring')}
          </span>
        )}
        <span className={css.cardTime}>{t('board.updated')} {formatTime(task.updatedAt)}</span>
        {!archived && task.schedule?.enabled === true && (
          <span
            className={css.cardSchedule}
            title={task.schedule.nextRunAt !== undefined
              ? `${t('card.scheduled')} · ${formatHostTimestamp(task.schedule.nextRunAt, timeZone)}`
              : t('card.scheduled')}
          >
            {task.schedule.nextRunAt !== undefined
              ? t('card.recurring.next', { time: formatHostTimestamp(task.schedule.nextRunAt, timeZone) })
              : t('card.scheduled')}
          </span>
        )}
        {!archived && isRecurringTask(task) && task.schedule?.lastTriggeredAt !== undefined && (
          <span className={css.cardTime}>{t('card.recurring.last', { time: formatTime(task.schedule.lastTriggeredAt, timeZone) })}</span>
        )}
        {/* 执行次数只对"真重复"的卡有意义：定时卡（recurring）每次都计数，
            手工重跑多次（runs > 1）也计数；一次性卡跑过 1 次的「1 次执行」
            既没信息量又和已完成的卡混在一起，干脆不显示。 */}
        {latest !== undefined && (isRecurringTask(task) || runs > 1) && (
          <span className={css.cardRun} data-result={archived ? undefined : latest.result}>
            {runs} {t('board.runs')}
          </span>
        )}
        {latest?.sessionId !== undefined && (
          <span className={css.cardSession} title={latest.sessionId}>⌁</span>
        )}
        {!archived && (task.status === 'running' || pending) && <span className={css.cardSpinner} aria-hidden="true" />}
      </span>
      {!archived && pending && <span className={css.cardRunningLabel}>{t('board.pending')}…</span>}
      {!archived && latest !== undefined && executionLabel(latest) === 'running' && (
        <span className={css.cardRunningLabel}>{t('detail.result.running')}…</span>
      )}
    </button>
  )
}

/** Memoized card: re-renders only when the card's own task record changes. */
export const TaskCard = memo(TaskCardInner)
