/**
 * Board controller: the single owner of task-ledger state and view state.
 *
 * In production it projects the Host ledger and submits confirmed actions;
 * the legacy store seam remains for v1 migration tests. It also closes the
 * board whenever the user navigates to a session.
 * Framework-free (structural runtime faces) so the whole orchestration is
 * unit-testable with fakes.
 *
 * The per use-case domain transitions (create/update/delete/schedule) live in
 * dedicated modules under core/use-cases and are applied here; the controller
 * owns only the orchestration seam (state, persistence, notify, navigation).
 */
import type { TaskStore } from './store.ts'
import { withStatus, type NewTaskInput, type TaskRecord, type TaskStatus } from './tasks.ts'
import { applyArchiveTask, applyRestoreTask } from './use-cases/task-archive.ts'
import { applyCreateTask } from './use-cases/task-create.ts'
import { applyDeleteTask } from './use-cases/task-delete.ts'
import { applyScheduleNextRun as applyScheduleRollForward, applySetSchedule } from './use-cases/task-schedule.ts'
import { applyUpdateTask, type TaskUpdatePatch } from './use-cases/task-update.ts'
import {
  type TaskBoardAction,
  type TaskBoardArchiveBatchSummary,
  type TaskBoardArchiveCardsPage,
  type TaskBoardArchiveIndexPage,
  type TaskBoardArchivePageQuery,
  type TaskBoardEventPayload,
  type TaskBoardSnapshot,
} from '../protocol.ts'

/** Cards pulled per archive read; mirrors the server's own 100-card page cap. */
const ARCHIVE_PAGE_SIZE = 100

export interface TaskBoardTransport {
  bootstrap(legacy: readonly TaskRecord[]): Promise<TaskBoardSnapshot>
  state(): Promise<TaskBoardSnapshot>
  action(action: TaskBoardAction): Promise<TaskBoardSnapshot>
  /** Batch list of the physical archive (方案 §3 D-4). */
  archiveBatches(page?: TaskBoardArchivePageQuery): Promise<TaskBoardArchiveIndexPage>
  /** One page of one batch's cards (方案 §3 D-4). */
  archiveCards(batchId: string, page?: TaskBoardArchivePageQuery): Promise<TaskBoardArchiveCardsPage>
  subscribe(listener: (event?: TaskBoardEventPayload) => void): () => void
}

/** The sessions face the controller needs for navigation awareness. */
export interface SessionsControllerFace {
  list: {
    getSnapshot(): { current: string | undefined }
    subscribe(fn: () => void): () => void
  }
  /** Select a session as current (navigates the conversation view). */
  open(id: string): void
}

/** Controller dependencies (all swappable in tests). */
export interface ControllerDeps {
  store: TaskStore
  sessions: SessionsControllerFace
  /** Clock; defaults to Date.now. */
  now?: () => number
  /** Id minting; defaults to a random-uuid. */
  uuid?: () => string
  /** Host-authoritative transport; absent keeps the legacy in-memory test path. */
  transport?: TaskBoardTransport
}

/** One workspace option the execution-target pickers offer. */
export interface ExecutionWorkspaceOption {
  workspaceId: string
  /** Display label (workspace title; the wiring falls back to the path). */
  title: string
}

/** One agent-preset option the execution-target pickers offer. */
export interface ExecutionPresetOption {
  id: string
  name?: string
  description?: string
  /** Why this preset cannot compose a session; the pickers disable it. */
  broken?: string
  isDefault: boolean
}

/** The execution-target option sets the UI feeds into the controller. */
export interface ExecutionOptionsSnapshot {
  workspaces: readonly ExecutionWorkspaceOption[]
  presets: readonly ExecutionPresetOption[]
}

/**
 * Archive view state (方案 §8 #5 ①).
 *
 * The archived cards used to be a client-side filter over the same `/state`
 * payload. After the physical archive migration they are not in that payload
 * at all, so the view owns its own collection, fed by `GET /archive` and paged
 * through `GET /archive/<batchId>`.
 */
export interface ArchiveViewState {
  /** Batch rows of the current archive index. */
  batches: readonly TaskBoardArchiveBatchSummary[]
  /** Cards pulled so far, in batch order. */
  tasks: readonly TaskRecord[]
  /** Server-reported number of archived cards across all batches. */
  total: number
  /** More cards are waiting to be paged in. */
  hasMore: boolean
  loading: boolean
  error?: string
}

/** Immutable controller snapshot for UI subscriptions. */
export interface ControllerSnapshot {
  tasks: readonly TaskRecord[]
  boardOpen: boolean
  /** True when the board shows the archive view instead of the columns. */
  archiveView: boolean
  /** Archived cards + batch rows; independent of {@link tasks} (方案 §8 #5). */
  archive: ArchiveViewState
  selectedTaskId: string | undefined
  /** Picker option sets (workspace list + agent-preset roster). */
  executionOptions: ExecutionOptionsSnapshot
  pendingTaskIds: readonly string[]
  transportError?: string
  host?: Pick<TaskBoardSnapshot, 'revision' | 'scheduler' | 'power'>
}

/** The selected task (main board first, then the archive view), or undefined. */
export function selectedTaskOf(snapshot: ControllerSnapshot): TaskRecord | undefined {
  if (snapshot.selectedTaskId === undefined) return undefined
  return snapshot.tasks.find(task => task.id === snapshot.selectedTaskId)
    ?? snapshot.archive.tasks.find(task => task.id === snapshot.selectedTaskId)
}

function randomUuid(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (randomUUID !== undefined) {
    return randomUUID.call(globalThis.crypto!)
  }
  const bytes = globalThis.crypto?.getRandomValues(new Uint8Array(16))
  if (bytes === undefined) {
    // Non-secure fallback (tests, odd environments).
    return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Read the current selection off a session-list snapshot (structural). */
function currentOf(sessions: SessionsControllerFace): string | undefined {
  return sessions.list.getSnapshot().current
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Board controller (see module doc). All mutations bump the snapshot and
 * persist through the store; UI and DOM mounts subscribe and re-render.
 */
export class BoardController {
  private tasks: TaskRecord[] = []
  private boardOpen = false
  private archiveView = false
  /** Archived cards, loaded from the archive routes (never a filter over {@link tasks}). */
  private archiveTasks: TaskRecord[] = []
  private archiveBatches: TaskBoardArchiveBatchSummary[] = []
  private archiveTotal = 0
  private archiveHasMore = false
  private archiveLoading = false
  private archiveError: string | undefined
  /** Read cursor into {@link archiveBatches}: which batch, which offset inside it. */
  private archiveCursor = { batchIndex: 0, offset: 0 }
  private selectedTaskId: string | undefined
  private executionOptions: ExecutionOptionsSnapshot = { workspaces: [], presets: [] }
  private listeners = new Set<() => void>()
  private disposers: Array<() => void> = []
  private readonly now: () => number
  private readonly uuid: () => string
  private readonly pendingTaskIds = new Set<string>()
  private readonly taskQueues = new Map<string, Promise<void>>()
  private transportError: string | undefined
  private hostState: Pick<TaskBoardSnapshot, 'revision' | 'scheduler' | 'power'> | undefined
  /** Release of the live Host event channel; held only while the board is on screen. */
  private remoteStreamRelease: (() => void) | undefined
  /** True once the Host bootstrap succeeded (the channel may then be opened). */
  private remoteStreamReady = false
  /** Page visibility; a hidden tab holds no event channel. */
  private documentVisible = true
  private remoteInitialization: Promise<boolean> | undefined

  /** @param deps - store and the sessions navigation face. */
  constructor(private readonly deps: ControllerDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.uuid = deps.uuid ?? randomUuid
  }

  // --- lifecycle -------------------------------------------------------------

  /** Load the persisted ledger and start the navigation/status subscriptions. */
  start(): void {
    this.tasks = this.deps.store.load()
    if (this.deps.transport !== undefined) void this.initializeRemote()
    // A sibling tab may have edited or deleted the ledger (same origin,
    // storage events). Reload on external change so a task deleted in
    // another tab stops firing here — and is never written back by this
    // tab's stale copy (scheduler roll-forward, execution settlement).
    const unsubscribeExternal = this.deps.transport === undefined ? this.deps.store.subscribeExternal?.(() => {
      this.tasks = this.deps.store.load()
      this.notify()
    }) : undefined
    if (unsubscribeExternal !== undefined) this.disposers.push(unsubscribeExternal)
    this.disposers.push(this.deps.sessions.list.subscribe(() => {
      this.onSessionsChanged()
    }))
    this.notify()
  }

  /** Stop all subscriptions and drop retained state (idempotent). */
  dispose(): void {
    this.remoteStreamRelease?.()
    this.remoteStreamRelease = undefined
    for (const dispose of this.disposers.splice(0)) dispose()
    this.listeners.clear()
  }

  // --- snapshot / subscription ------------------------------------------------

  getSnapshot(): ControllerSnapshot {
    return {
      tasks: this.tasks,
      boardOpen: this.boardOpen,
      archiveView: this.archiveView,
      archive: {
        batches: this.archiveBatches,
        tasks: this.archiveTasks,
        total: this.archiveTotal,
        hasMore: this.archiveHasMore,
        loading: this.archiveLoading,
        ...(this.archiveError === undefined ? {} : { error: this.archiveError }),
      },
      selectedTaskId: this.selectedTaskId,
      executionOptions: this.executionOptions,
      pendingTaskIds: [...this.pendingTaskIds],
      ...(this.transportError === undefined ? {} : { transportError: this.transportError }),
      ...(this.hostState === undefined ? {} : { host: this.hostState }),
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /** Whether production mutations are confirmed by the Host transport. */
  isHostBacked(): boolean {
    return this.deps.transport !== undefined
  }

  /** Retry initial migration/state synchronization after an explicit Host error. */
  async retryHostSync(): Promise<boolean> {
    return await this.initializeRemote()
  }

  // --- view state -------------------------------------------------------------

  openBoard(): void {
    if (this.boardOpen) return
    // Baseline the selection the board opened against: the board stays open
    // until the user navigates (selection changes), never on mere status
    // updates of the already-selected session.
    this.lastCurrent = currentOf(this.deps.sessions)
    this.boardOpen = true
    // The archive badge must be right without opening the archive view: the
    // batch index alone carries the total (cheap), while the cards themselves
    // are only paged in when the archive view is actually shown.
    if (this.deps.transport !== undefined) void this.refreshArchiveIndex()
    this.syncRemoteStream()
    this.notify()
  }

  closeBoard(): void {
    if (!this.boardOpen) return
    this.boardOpen = false
    this.syncRemoteStream()
    this.notify()
  }

  toggleBoard(): void {
    if (this.boardOpen) this.closeBoard()
    else this.openBoard()
  }

  /**
   * Track page visibility for the live channel: a hidden tab (background
   * window, another tab in front) releases it, and the next visible moment
   * re-subscribes and refreshes once. Called by the wiring on
   * `visibilitychange`; the default is visible.
   * @param visible - whether the document is currently visible.
   */
  setDocumentVisible(visible: boolean): void {
    if (this.documentVisible === visible) return
    this.documentVisible = visible
    this.syncRemoteStream()
  }

  /**
   * Switch between the kanban columns and the archive view. Leaving the
   * archive view with an archived task still selected closes the selection —
   * the detail overlay must not linger over a task that is off-board.
   * Opening the view loads it from the archive routes (方案 §8 #5 ④).
   */
  toggleArchiveView(): void {
    this.archiveView = !this.archiveView
    if (!this.archiveView && this.selectedTaskId !== undefined) {
      const selected = this.tasks.find(task => task.id === this.selectedTaskId)
      if (selected === undefined || selected.archivedAt !== undefined) this.selectedTaskId = undefined
    }
    if (this.archiveView) void this.loadArchive(true)
    this.notify()
  }

  // --- archive view -----------------------------------------------------------

  /** Refresh the archive view from the beginning (batch list + first page). */
  async refreshArchive(): Promise<boolean> {
    return await this.loadArchive(true)
  }

  /** Pull the next page of archived cards. */
  async loadMoreArchive(): Promise<boolean> {
    return await this.loadArchive(false)
  }

  /**
   * Re-read just the batch index — enough for the "归档 (N)" badge and for the
   * per-line archived counts of whatever cards are already loaded. Failures are
   * kept in `archive.error` rather than thrown at the caller.
   */
  async refreshArchiveIndex(): Promise<boolean> {
    const transport = this.deps.transport
    if (transport === undefined) return false
    try {
      const index = await transport.archiveBatches()
      this.archiveBatches = index.batches
      this.archiveTotal = index.totals.cards
      this.archiveError = undefined
      this.notify()
      return true
    } catch (error) {
      this.archiveError = messageOf(error)
      this.notify()
      return false
    }
  }

  /**
   * Read the archive through its own routes (方案 §3 D-4 / §8 #5 ④).
   *
   * `reset` re-reads the batch index and starts from the first card; otherwise
   * the next page is appended. Pages are filled across batch boundaries, so the
   * view reads as one continuous list even though the wire is per-batch.
   * Every failure is kept in `archive.error` — the archive view must never
   * look simply empty when it could not be read.
   */
  private async loadArchive(reset: boolean): Promise<boolean> {
    const transport = this.deps.transport
    if (transport === undefined) {
      // Legacy in-memory path (no Host): the store still holds archive markers.
      this.archiveTasks = this.tasks.filter(task => task.archivedAt !== undefined)
      this.archiveBatches = []
      this.archiveTotal = this.archiveTasks.length
      this.archiveHasMore = false
      this.notify()
      return true
    }
    if (this.archiveLoading) return false
    this.archiveLoading = true
    this.archiveError = undefined
    this.notify()
    try {
      if (reset) {
        const index = await transport.archiveBatches()
        this.archiveBatches = index.batches
        this.archiveTotal = index.totals.cards
        this.archiveTasks = []
        this.archiveCursor = { batchIndex: 0, offset: 0 }
      }
      const page = await this.readArchivePage(ARCHIVE_PAGE_SIZE)
      this.archiveTasks = [...this.archiveTasks, ...page.cards]
      this.archiveHasMore = page.hasMore
      if (this.archiveTotal < this.archiveTasks.length) this.archiveTotal = this.archiveTasks.length
      return true
    } catch (error) {
      this.archiveError = messageOf(error)
      return false
    } finally {
      this.archiveLoading = false
      this.notify()
    }
  }

  /**
   * Fill one in-memory page of up to `limit` cards by walking batches from the
   * cursor. A batch boundary is transparent to the reader (方案 §5 J8 walks
   * every batch and expects no duplicates and no gaps).
   */
  private async readArchivePage(limit: number): Promise<{ cards: TaskRecord[]; hasMore: boolean }> {
    const transport = this.deps.transport
    if (transport === undefined) return { cards: [], hasMore: false }
    const cards: TaskRecord[] = []
    let hasMore = false
    while (cards.length < limit && this.archiveCursor.batchIndex < this.archiveBatches.length) {
      const batch = this.archiveBatches[this.archiveCursor.batchIndex]!
      const page = await transport.archiveCards(batch.batchId, {
        limit: limit - cards.length,
        offset: this.archiveCursor.offset,
      })
      cards.push(...page.cards)
      if (page.hasMore) {
        this.archiveCursor = { batchIndex: this.archiveCursor.batchIndex, offset: page.offset + page.cards.length }
        hasMore = true
        break
      }
      this.archiveCursor = { batchIndex: this.archiveCursor.batchIndex + 1, offset: 0 }
      hasMore = this.archiveCursor.batchIndex < this.archiveBatches.length
    }
    return { cards, hasMore }
  }

  /** Drop a card from the archive view after it left its batch (restore/delete). */
  private forgetArchivedCard(id: string): void {
    if (!this.archiveTasks.some(task => task.id === id)) return
    this.archiveTasks = this.archiveTasks.filter(task => task.id !== id)
    if (this.archiveTotal > 0) this.archiveTotal -= 1
    this.notify()
  }

  /**
   * Open the detail overlay for a card. Archived cards live in their own
   * collection (see {@link ArchiveViewState}), so the selection resolves
   * against both the board and the archive view.
   */
  openTask(id: string): void {
    if (this.tasks.some(task => task.id === id) || this.archiveTasks.some(task => task.id === id)) {
      this.selectedTaskId = id
      this.notify()
    }
  }

  closeTask(): void {
    if (this.selectedTaskId === undefined) return
    this.selectedTaskId = undefined
    this.notify()
  }

  // --- task mutations (use-case transitions in core/use-cases) -----------------

  createTask(input: NewTaskInput): TaskRecord | undefined {
    const id = this.uuid()
    const { task, tasks } = applyCreateTask(this.tasks, input, this.now(), id)
    if (task === undefined) return undefined
    this.tasks = [...tasks]
    this.persistAndNotify()
    return task
  }

  /** Create through the Host and expose the task only after confirmation. */
  async createTaskConfirmed(input: NewTaskInput): Promise<TaskRecord | undefined> {
    if (this.deps.transport === undefined) return this.createTask(input)
    const id = this.uuid()
    const preview = applyCreateTask(this.tasks, input, this.now(), id).task
    if (preview === undefined) return undefined
    return await this.commitRemote({ kind: 'create', id, input }, id)
      ? this.tasks.find(task => task.id === id)
      : undefined
  }

  /**
   * Apply an editable-field patch (task content + execution targets).
   * Host-backed: the Host ledger owns the fail-closed checks (the content of
   * an executed task is read-only) and confirms the mutation, so the resolved
   * value reflects whether the Host accepted it; the legacy in-memory path
   * applies and persists synchronously.
   * @returns true when the patch was accepted by the authority.
   */
  async updateTask(id: string, patch: TaskUpdatePatch): Promise<boolean> {
    if (this.deps.transport !== undefined) {
      return await this.commitRemote({ kind: 'update', taskId: id, patch }, id)
    }
    this.tasks = [...applyUpdateTask(this.tasks, id, patch, this.now())]
    this.persistAndNotify()
    return true
  }

  /**
   * Replace (a part of) the picker option sets the UI feeds (workspace list
   * and agent-preset roster come from the runtime, not the ledger).
   */
  setExecutionOptions(patch: Partial<ExecutionOptionsSnapshot>): void {
    this.executionOptions = { ...this.executionOptions, ...patch }
    this.notify()
  }

  moveTask(id: string, status: TaskStatus): void {
    if (this.deps.transport !== undefined) {
      void this.commitRemote({ kind: 'move', taskId: id, status }, id)
      return
    }
    this.tasks = this.tasks.map(task => task.id === id ? withStatus(task, status, this.now()) : task)
    this.persistAndNotify()
  }

  /**
   * Delete a task — live or archived (K1 §1.2 hand-over).
   *
   * Before this card an archived card was in `this.tasks`, so the plain delete
   * action worked; now it lives in a batch, and the Host looks it up there
   * (a live card takes the original path). A refusal (running card, unknown id)
   * surfaces as `transportError`, never as a silent no-op.
   */
  deleteTask(id: string): void {
    if (this.deps.transport !== undefined) {
      void this.commitRemote({ kind: 'delete', taskId: id }, id).then(deleted => {
        if (deleted) this.afterCardLeftArchive(id)
      })
      return
    }
    const { tasks, selectionCleared } = applyDeleteTask(this.tasks, this.selectedTaskId, id)
    this.tasks = [...tasks]
    if (selectionCleared) this.selectedTaskId = undefined
    this.persistAndNotify()
  }

  /**
   * Archive a settled task (done/failed). Running or on-board-unsettled
   * tasks are refused so the runner keeps exclusive ownership of their
   * lifecycle.
   * @returns true when applied.
   */
  archiveTask(id: string): boolean {
    const { tasks, archived } = applyArchiveTask(this.tasks, id, this.now())
    if (!archived) return false
    if (this.deps.transport !== undefined) {
      void this.commitRemote({ kind: 'archive', taskId: id }, id)
      return true
    }
    this.tasks = [...tasks]
    this.persistAndNotify()
    return true
  }

  /**
   * Restore an archived task back onto the board.
   *
   * Card [看板瘦身·K2] · 阻断 `L2-1`: the Host owns where a card lives, and after
   * the physical archive migration an archived card is NOT in `this.tasks`. The
   * former local pre-check (`applyRestoreTask` returns `applied === false` ⇒
   * `return false`) therefore swallowed the click on the archive page: no
   * request, no message, nothing on screen. The action is now sent
   * unconditionally and a Host refusal surfaces through `transportError`
   * (rendered by the board and the detail overlay).
   * @returns true when the Host confirmed the restore.
   */
  async restoreTask(id: string): Promise<boolean> {
    const transport = this.deps.transport
    if (transport === undefined) {
      const { tasks, archived } = applyRestoreTask(this.tasks, id, this.now())
      if (!archived) return false
      this.tasks = [...tasks]
      this.forgetArchivedCard(id)
      if (this.selectedTaskId === id) this.selectedTaskId = undefined
      this.persistAndNotify()
      return true
    }
    const restored = await this.commitRemote({ kind: 'restore', taskId: id }, id)
    if (restored) this.afterCardLeftArchive(id)
    return restored
  }

  /** Shared post-restore/post-delete bookkeeping for the archive view. */
  private afterCardLeftArchive(id: string): void {
    this.forgetArchivedCard(id)
    if (this.selectedTaskId === id) this.selectedTaskId = undefined
    if (this.archiveView) void this.loadArchive(true)
  }

  // --- scheduling ---------------------------------------------------------------

  /**
   * Update a task's schedule rule. A blank or invalid cron expression is
   * rejected (returns false, state untouched). When the rule ends up enabled
   * the next run instant is computed immediately; a disabled rule carries no
   * next-run instant. Delegates the domain transition to the schedule use case.
   * @param id - the task to schedule.
   * @param patch - fields to change (absent fields keep their current value).
   * @returns true when applied, false when rejected (invalid cron / unknown task).
   */
  setSchedule(id: string, patch: { enabled?: boolean; cron?: string }): boolean {
    const { tasks, applied } = applySetSchedule(this.tasks, id, patch, this.now())
    if (!applied) return false
    if (this.deps.transport !== undefined) {
      void this.commitRemote({ kind: 'set-schedule', taskId: id, patch }, id)
      return true
    }
    this.tasks = [...tasks]
    this.persistAndNotify()
    return true
  }

  /**
   * Legacy pure-controller seam retained for migration-focused tests. The
   * production browser never rolls schedules; the Host ledger owns them.
   */
  applyScheduleNextRun(id: string, nextRunAt: number | undefined, lastTriggeredAt: number | undefined): void {
    const next = applyScheduleRollForward(this.tasks, id, nextRunAt, lastTriggeredAt, this.now())
    this.tasks = [...next]
    this.persistAndNotify()
  }

  /**
   * Reload the legacy v1 store without notifying subscribers. Production v2
   * reads Host snapshots instead; this remains only for isolated legacy tests.
   */
  reloadFromStore(): void {
    this.tasks = this.deps.store.load()
  }

  /**
   * Jump to an execution's session transcript. Selecting the session changes
   * `current`, which closes the board (the conversation view takes over).
   * @param sessionId - the execution session to open.
   */
  openSession(sessionId: string): void {
    this.deps.sessions.open(sessionId)
  }

  // --- execution ---------------------------------------------------------------

  /**
   * Request a Host execution for a task: the Host ledger owns the running
   * transition, the execution record, and the settlement. A second call
   * while the task is already running is ignored; without a Host transport
   * the run is refused (returns false).
   */
  async runTask(id: string): Promise<boolean> {
    const task = this.tasks.find(candidate => candidate.id === id)
    if (task === undefined || task.archivedAt !== undefined || task.status === 'running') return false
    if (this.deps.transport === undefined) return false
    return await this.commitRemote({ kind: 'run', taskId: id }, id)
  }

  /** Re-run a settled task through the Host (the Host replans and executes). */
  async rerunTask(id: string): Promise<void> {
    const task = this.tasks.find(candidate => candidate.id === id)
    if (task === undefined || task.archivedAt !== undefined) return
    if (this.deps.transport === undefined) return
    await this.commitRemote({ kind: 'rerun', taskId: id }, id)
  }

  /**
   * Accept a card parked in the human review column (local fork): a one-off
   * card lands in done, a recurring card returns to todo for its next trigger.
   * Host-backed only — the Host owns the transition.
   */
  async confirmTask(id: string): Promise<boolean> {
    const task = this.tasks.find(candidate => candidate.id === id)
    if (task === undefined || task.archivedAt !== undefined || task.status !== 'review') return false
    if (this.deps.transport === undefined) return false
    return await this.commitRemote({ kind: 'confirm', taskId: id }, id)
  }

  /** Send a reviewed card back to todo, optionally appending a rejection note. */
  async rejectTask(id: string, note?: string): Promise<boolean> {
    const task = this.tasks.find(candidate => candidate.id === id)
    if (task === undefined || task.archivedAt !== undefined || task.status !== 'review') return false
    if (this.deps.transport === undefined) return false
    const trimmed = note?.trim()
    return await this.commitRemote(
      { kind: 'reject', taskId: id, ...(trimmed === undefined || trimmed === '' ? {} : { note: trimmed }) },
      id,
    )
  }

  // --- internals ---------------------------------------------------------------

  /**
   * Whether the live Host event channel is needed right now: only while the
   * board is actually on screen (open panel, visible document, Host ready).
   * A closed board or a hidden tab runs without an EventSource, so the page
   * keeps that HTTP/1.1 connection slot free.
   */
  private wantsRemoteStream(): boolean {
    return this.deps.transport !== undefined && this.boardOpen && this.documentVisible && this.remoteStreamReady
  }

  /**
   * Acquire or release the live channel to match {@link wantsRemoteStream}.
   * On acquire the board subscribes first — no frame can slip between the
   * subscribe and the catch-up read — and then pulls one full snapshot,
   * because the channel was closed while the board was away and the ledger
   * may have moved on. On release the EventSource is closed.
   */
  private syncRemoteStream(): void {
    const transport = this.deps.transport
    if (transport === undefined) return
    if (this.wantsRemoteStream()) {
      if (this.remoteStreamRelease !== undefined) return
      this.remoteStreamRelease = transport.subscribe((event) => { this.onRemoteEvent(event) })
      void this.refreshRemote()
      return
    }
    this.releaseRemoteStream()
  }

  /** Close the live channel when held (idempotent). */
  private releaseRemoteStream(): void {
    const release = this.remoteStreamRelease
    if (release === undefined) return
    this.remoteStreamRelease = undefined
    release()
  }

  /** Close the board when the user navigates to another session. */
  private onSessionsChanged(): void {
    if (!this.boardOpen) return
    const current = currentOf(this.deps.sessions)
    if (current !== this.lastCurrent) this.closeBoard()
    this.lastCurrent = current
  }

  private lastCurrent: string | undefined = undefined

  private persistAndNotify(): void {
    if (this.deps.transport === undefined) this.deps.store.save(this.tasks)
    this.notify()
  }

  private async commitRemote(action: TaskBoardAction, taskId?: string): Promise<boolean> {
    const transport = this.deps.transport
    if (transport === undefined) return true
    if (taskId === undefined) return await this.performRemote(action)
    const previous = this.taskQueues.get(taskId) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => await this.performRemote(action))
    const tail = operation.then(() => {}, () => {})
    this.taskQueues.set(taskId, tail)
    this.pendingTaskIds.add(taskId)
    this.notify()
    try {
      return await operation
    } finally {
      if (this.taskQueues.get(taskId) === tail) {
        this.taskQueues.delete(taskId)
        this.pendingTaskIds.delete(taskId)
        this.notify()
      }
    }
  }

  private async performRemote(action: TaskBoardAction): Promise<boolean> {
    const transport = this.deps.transport
    if (transport === undefined) return true
    this.transportError = undefined
    this.notify()
    try {
      const accepted = this.acceptRemote(await transport.action(action))
      return accepted || await this.refreshRemote()
    } catch (error) {
      await this.refreshRemote(messageOf(error))
      return false
    }
  }

  private async initializeRemote(): Promise<boolean> {
    if (this.remoteInitialization !== undefined) return await this.remoteInitialization
    const initialization = this.doInitializeRemote()
    this.remoteInitialization = initialization
    try {
      return await initialization
    } finally {
      if (this.remoteInitialization === initialization) this.remoteInitialization = undefined
    }
  }

  private async doInitializeRemote(): Promise<boolean> {
    const transport = this.deps.transport
    if (transport === undefined) return true
    try {
      this.acceptRemote(await transport.bootstrap(this.tasks))
      // The channel itself is demand-driven from here on: it opens when the
      // board becomes visible and closes when it is not (see syncRemoteStream).
      this.remoteStreamReady = true
      this.syncRemoteStream()
      return true
    } catch (error) {
      this.transportError = messageOf(error)
      this.notify()
      return false
    }
  }

  /**
   * SSE frames carry revision/scheduler/power. When the revision matches the
   * one already applied, apply the frame's scheduler/power in place and skip
   * the full /state fetch; otherwise the 5 s heartbeat would re-clone and
   * re-serialize the whole ledger per tab even while nothing changes.
   */
  private onRemoteEvent(event: TaskBoardEventPayload | undefined): void {
    if (event !== undefined && this.hostState !== undefined && event.revision === this.hostState.revision
      && typeof event.scheduler === 'object' && event.scheduler !== null
      && typeof event.power === 'object' && event.power !== null) {
      this.hostState = { revision: event.revision, scheduler: event.scheduler, power: event.power }
      this.notify()
      return
    }
    void this.refreshRemote()
  }

  private async refreshRemote(preserveError?: string): Promise<boolean> {
    const transport = this.deps.transport
    if (transport === undefined) return true
    try {
      const before = this.hostState?.revision
      this.acceptRemote(await transport.state())
      if (this.archiveView && this.hostState?.revision !== before) void this.loadArchive(true)
      if (preserveError !== undefined) {
        this.transportError = preserveError
        this.notify()
      }
      return true
    } catch (error) {
      this.transportError = preserveError ?? messageOf(error)
      this.notify()
      return false
    }
  }

  private acceptRemote(snapshot: TaskBoardSnapshot): boolean {
    const currentLedgerId = this.hostState?.scheduler.ledgerId
    const nextLedgerId = snapshot.scheduler.ledgerId
    const sameGeneration = currentLedgerId === nextLedgerId
    if (sameGeneration && this.hostState !== undefined && snapshot.revision < this.hostState.revision) return false
    this.tasks = [...snapshot.tasks]
    this.hostState = { revision: snapshot.revision, scheduler: snapshot.scheduler, power: snapshot.power }
    this.transportError = undefined
    if (this.selectedTaskId !== undefined
      && !this.tasks.some(task => task.id === this.selectedTaskId)
      && !this.archiveTasks.some(task => task.id === this.selectedTaskId)) {
      this.selectedTaskId = undefined
    }
    if (!this.archiveView && this.selectedTaskId !== undefined
      && this.tasks.find(task => task.id === this.selectedTaskId)?.archivedAt !== undefined) {
      this.selectedTaskId = undefined
    }
    this.notify()
    return true
  }

  private notify(): void {
    for (const fn of [...this.listeners]) fn()
  }
}
