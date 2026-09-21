/**
 * Board view: the multi-column kanban that replaces the middle column while
 * active. Cards open the task detail (never execute directly); the header
 * offers a status/line view switch, filter, new-task, and a back-to-chat escape.
 *
 * The same ledger read two ways:
 * - status view (default): the six lifecycle columns;
 * - line view: one column per main line (主线), so a large workstream's node
 *   cards read as one track instead of scattering across six columns.
 */
import { memo, useCallback, useEffect, useState } from 'react'
import { selectedTaskOf, type BoardController } from '../../core/controller.ts'
import { COLUMNS, compareSeq, type TaskRecord, type TaskStatus } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'
import { NewTaskModal } from './NewTaskModal.tsx'
import { STATUS_KEY } from './status-key.ts'
import { TaskCard } from './TaskCard.tsx'
import { TaskDetail } from './TaskDetail.tsx'

/** Case-insensitive title/description/line/seq match. */
function matchesFilter(task: TaskRecord, filter: string): boolean {
  if (filter.trim() === '') return true
  const needle = filter.trim().toLowerCase()
  return task.title.toLowerCase().includes(needle)
    || task.description.toLowerCase().includes(needle)
    || (task.line ?? '').toLowerCase().includes(needle)
    || (task.seq ?? '').toLowerCase().includes(needle)
}

/**
 * Status order inside a line group: work in flight first, settled cards last.
 * Deliberately not the column order — inside one line the question is "what is
 * still moving", not "which lifecycle column is this".
 */
const LINE_STATUS_ORDER: readonly TaskStatus[] = ['running', 'review', 'todo', 'backlog', 'failed', 'done']

/** One line-view column: its cards plus the progress numbers in the header. */
interface LineGroup {
  /** Group label; undefined models the 未归线 bucket. */
  line: string | undefined
  tasks: TaskRecord[]
  done: number
  total: number
  inflight: number
}

/** Bucket cards by main line; order both the groups and the cards inside them. */
function groupByLine(tasks: readonly TaskRecord[]): LineGroup[] {
  const buckets = new Map<string, TaskRecord[]>()
  for (const task of tasks) {
    const key = task.line ?? ''
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, [task])
    else bucket.push(task)
  }
  const groups: LineGroup[] = [...buckets.entries()].map(([key, items]) => {
    const sorted = [...items].sort((a, b) => {
      const byStatus = LINE_STATUS_ORDER.indexOf(a.status) - LINE_STATUS_ORDER.indexOf(b.status)
      return byStatus !== 0 ? byStatus : compareSeq(a.seq, b.seq)
    })
    return {
      line: key === '' ? undefined : key,
      tasks: sorted,
      total: sorted.length,
      done: sorted.filter(task => task.status === 'done').length,
      inflight: sorted.filter(task => task.status !== 'done' && task.status !== 'failed').length,
    }
  })
  // Busiest lines first, 未归线 always last: an unassigned pile must never push
  // a real workstream off the first screen.
  return groups.sort((a, b) => {
    if (a.line === undefined) return 1
    if (b.line === undefined) return -1
    if (b.inflight !== a.inflight) return b.inflight - a.inflight
    return a.line.localeCompare(b.line, 'zh')
  })
}

/**
 * Archived cards per main line. Archived cards are filtered out of the columns,
 * so without this count a line reads as "0/0 · nothing here" even though the
 * work was done and filed away — the header badge is what tells the difference
 * between "never started" and "already cleared out".
 */
function countArchivedByLine(tasks: readonly TaskRecord[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    if (task.archivedAt === undefined) continue
    const key = task.line ?? ''
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/**
 * Memoized per-card adapter: with a stable `onOpen` from the board and an
 * immutable task record (only the changed card gets a new object ref), a card
 * re-renders only when its own task changes — not when a sibling card status,
 * the filter, or the selection moves.
 */
const MemoTaskCard = memo(function MemoTaskCard({ task, pending, timeZone, showStatus, onOpen }: { task: TaskRecord; pending: boolean; timeZone?: string; showStatus?: boolean; onOpen: (id: string) => void }) {
  const onClick = useCallback(() => { onOpen(task.id) }, [task.id, onOpen])
  return <TaskCard task={task} pending={pending} timeZone={timeZone} showStatus={showStatus} onClick={onClick} />
})

/** Board component; subscribes to the controller snapshot. */
export function TaskBoard({ controller }: { controller: BoardController }) {
  const [snapshot, setSnapshot] = useState(controller.getSnapshot())
  useEffect(
    () => controller.subscribe(() => setSnapshot(controller.getSnapshot())),
    [controller],
  )
  const [filter, setFilter] = useState('')
  const [view, setView] = useState<'status' | 'line'>('status')
  const [showNew, setShowNew] = useState(false)
  const selected = selectedTaskOf(snapshot)
  const archiveView = snapshot.archiveView
  // Archived tasks leave the columns; the archive view shows them instead.
  const visible = snapshot.tasks.filter(task =>
    (archiveView ? task.archivedAt !== undefined : task.archivedAt === undefined)
    && matchesFilter(task, filter),
  )
  const lineGroups = groupByLine(visible)
  // Same filter as the columns, opposite archive flag: the badge counts the
  // line's archived cards, which never appear as columns of their own.
  const lineArchiveCounts = countArchivedByLine(
    snapshot.tasks.filter(task => matchesFilter(task, filter)),
  )
  const openTask = useCallback((id: string): void => { controller.openTask(id) }, [controller])

  return (
    <div className={css.board} data-dsh-taskboard-board="" data-dsh-plugin="task-board">
      <header className={css.boardHeader}>
        {/* Shared hook: dsh-web-all offsets center-view back controls beside the collapsed mobile sidebar. */}
        <button
          type="button"
          className={`${css.ghostButton} ${css.backButton}`}
          data-dsh-center-view-back=""
          aria-label={t('board.close')}
          onClick={() => { controller.closeBoard() }}
        >
          <span aria-hidden="true">‹</span>
          <span>{t('board.close')}</span>
        </button>
        <h2 className={css.boardTitle}>{t('board.title')}</h2>
        {snapshot.host !== undefined && (
          <span className={css.detailMeta}>
            {t('board.hostMeta', {
              revision: String(snapshot.host.revision),
              timeZone: snapshot.host.scheduler.timeZone,
            })}
          </span>
        )}
        <input
          className={css.search}
          type="search"
          placeholder={t('board.search')}
          value={filter}
          onChange={event => { setFilter(event.target.value) }}
          aria-label={t('board.search')}
        />
        <button
          type="button"
          className={view === 'status' ? css.primaryButton : css.ghostButton}
          onClick={() => { setView('status') }}
        >
          {t('board.viewStatus')}
        </button>
        <button
          type="button"
          className={view === 'line' ? css.primaryButton : css.ghostButton}
          onClick={() => { setView('line') }}
        >
          {t('board.viewLine')}
        </button>
        <button
          type="button"
          className={archiveView ? css.primaryButton : css.ghostButton}
          onClick={() => { controller.toggleArchiveView() }}
        >
          {archiveView
            ? t('board.backToBoard')
            : t('board.archiveView', { count: String(snapshot.tasks.filter(task => task.archivedAt !== undefined).length) })}
        </button>
        <button
          type="button"
          className={css.primaryButton}
          onClick={() => { setShowNew(true) }}
        >
          + {t('board.new')}
        </button>
      </header>

      {snapshot.transportError !== undefined && (
        <div className={css.formError}>
          {t('board.hostError', { error: snapshot.transportError })}{' '}
          <button type="button" className={css.linkButton} onClick={() => { void controller.retryHostSync() }}>
            {t('board.retryHost')}
          </button>
        </div>
      )}

      {/* Line view: one column per main line gets a wider floor (.columnsLine). */}
      <div className={view === 'line' && !archiveView ? `${css.columns} ${css.columnsLine}` : css.columns}>
        {archiveView ? (
          <section className={css.column} data-status="archived" data-dsh-part="column">
            <header className={css.columnHeader}>
              <h3 className={css.columnTitle}>{t('board.archive')}</h3>
              <span className={css.columnCount}>{visible.length}</span>
            </header>
            <div className={css.cards}>
              {visible.map(task => (
                <MemoTaskCard key={task.id} task={task} pending={snapshot.pendingTaskIds.includes(task.id)} timeZone={snapshot.host?.scheduler.timeZone} showStatus onOpen={openTask} />
              ))}
              {visible.length === 0 && <div className={css.columnEmpty}>{t('archive.empty')}</div>}
            </div>
          </section>
        ) : view === 'line' ? (
          lineGroups.length === 0
            ? (
              <section className={css.column} data-dsh-part="line">
                <div className={css.columnEmpty}>{t('board.lineEmpty')}</div>
              </section>
            )
            : lineGroups.map(group => {
              const archived = lineArchiveCounts.get(group.line ?? '') ?? 0
              return (
                <section
                  key={group.line ?? '__unassigned'}
                  className={css.column}
                  data-dsh-part="line"
                  data-line={group.line ?? ''}
                  title={t('board.lineHeader', {
                    inflight: String(group.inflight),
                    done: String(group.done),
                    total: String(group.total),
                  })}
                >
                  <header className={css.columnHeader}>
                    <h3 className={css.columnTitle}>{group.line ?? t('board.lineUnassigned')}</h3>
                    <span className={css.columnCount}>{group.done}/{group.total}</span>
                    {/* 归档卡不在列里也不进分母：这个角标回答「这条线是不是真清完了」。 */}
                    {archived > 0 && (
                      <span
                        className={`${css.columnCount} ${css.columnCountArchived}`}
                        data-dsh-part="line-archived"
                        title={t('board.lineArchivedHint', { count: String(archived) })}
                      >
                        {t('board.lineArchived', { count: String(archived) })}
                      </span>
                    )}
                  </header>
                  <div className={css.cards}>
                    {group.tasks.map(task => (
                      <MemoTaskCard key={task.id} task={task} pending={snapshot.pendingTaskIds.includes(task.id)} timeZone={snapshot.host?.scheduler.timeZone} showStatus onOpen={openTask} />
                    ))}
                  </div>
                </section>
              )
            })
        ) : (
          COLUMNS.map(column => {
            const tasks = visible.filter(task => task.status === column.status)
            return (
              <section key={column.status} className={css.column} data-status={column.status} data-dsh-part="column">
                <header className={css.columnHeader}>
                  <span className={css.statusDot} data-status={column.status} aria-hidden="true" />
                  <h3 className={css.columnTitle}>{t(STATUS_KEY[column.status])}</h3>
                  <span className={css.columnCount}>{tasks.length}</span>
                </header>
                <div className={css.cards}>
                  {tasks.map(task => (
                    <MemoTaskCard key={task.id} task={task} pending={snapshot.pendingTaskIds.includes(task.id)} timeZone={snapshot.host?.scheduler.timeZone} onOpen={openTask} />
                  ))}
                  {tasks.length === 0 && <div className={css.columnEmpty}>{t('board.empty')}</div>}
                </div>
              </section>
            )
          })
        )}
      </div>

      {selected !== undefined && (
        <TaskDetail controller={controller} task={selected} />
      )}
      {showNew && (
        <NewTaskModal
          controller={controller}
          onClose={() => { setShowNew(false) }}
        />
      )}
    </div>
  )
}
