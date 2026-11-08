import type { TaskRecord } from '../core/tasks.ts'
import {
  TASK_BOARD_API_PREFIX,
  type TaskBoardAction,
  type TaskBoardActionEnvelope,
  type TaskBoardArchiveCardsPage,
  type TaskBoardArchiveIndexPage,
  type TaskBoardArchivePageQuery,
  type TaskBoardEventPayload,
  type TaskBoardSnapshot,
} from '../protocol.ts'

const IMPORT_MARKER = 'dsh.taskBoard.v2.hostImported'
const SOURCE_KEY = 'dsh.taskBoard.v2.sourceId'
const IMPORT_REQUEST_KEY = 'dsh.taskBoard.v2.importRequestId'
const REQUEST_TIMEOUT_MS = 15_000

/**
 * Board scope this client reads at (方案 §3 D-10 / K2 §8 #4).
 *
 * The archive view no longer piggybacks on the full `/state` payload: it reads
 * `GET /archive` and pages through the batches, so every regular read here can
 * ask for in-flight cards only. That keeps a mutation response at in-flight
 * size instead of re-sending the whole archive (判据 J14) and keeps the
 * browser's poll cheap. Readers that genuinely need the merged view (butler
 * tools, duplicate checks) simply send no header and still get `all`.
 */
const BOARD_SCOPE_HEADER = 'x-dsh-board-scope'
const LIVE_SCOPE = 'live'

function uuid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `browser-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `task-board request failed: ${response.status}`)
  return body
}

/** `?limit&offset`, omitting values the caller left out. */
function pagingQuery(page: TaskBoardArchivePageQuery): string {
  const params = new URLSearchParams()
  if (page.limit !== undefined) params.set('limit', String(page.limit))
  if (page.offset !== undefined) params.set('offset', String(page.offset))
  const query = params.toString()
  return query === '' ? '' : `?${query}`
}

export interface TaskBoardHostTransport {
  bootstrap(legacy: readonly TaskRecord[]): Promise<TaskBoardSnapshot>
  state(): Promise<TaskBoardSnapshot>
  action(action: TaskBoardAction): Promise<TaskBoardSnapshot>
  /** Batch list of the archive (方案 §3 D-4). */
  archiveBatches(page?: TaskBoardArchivePageQuery): Promise<TaskBoardArchiveIndexPage>
  /** One page of one batch's cards (方案 §3 D-4). */
  archiveCards(batchId: string, page?: TaskBoardArchivePageQuery): Promise<TaskBoardArchiveCardsPage>
  subscribe(listener: (event?: TaskBoardEventPayload) => void): () => void
}

export class HttpTaskBoardHostTransport implements TaskBoardHostTransport {
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage) {}

  async bootstrap(legacy: readonly TaskRecord[]): Promise<TaskBoardSnapshot> {
    const initial = await this.state()
    const ledgerId = initial.scheduler.ledgerId
    if (legacy.length > 0 && ledgerId !== undefined && this.storage?.getItem(IMPORT_MARKER) !== ledgerId) {
      let sourceId = this.storage?.getItem(SOURCE_KEY)
      if (sourceId === null || sourceId === undefined || sourceId === '') {
        sourceId = uuid()
        this.storage?.setItem(SOURCE_KEY, sourceId)
      }
      let requestId = this.storage?.getItem(IMPORT_REQUEST_KEY)
      if (requestId === null || requestId === undefined || requestId === '') {
        requestId = uuid()
        this.storage?.setItem(IMPORT_REQUEST_KEY, requestId)
      }
      const snapshot = await this.post(requestId, { kind: 'import', sourceId, tasks: [...legacy] })
      this.storage?.setItem(IMPORT_MARKER, snapshot.scheduler.ledgerId ?? ledgerId)
      return snapshot
    }
    return initial
  }

  async state(): Promise<TaskBoardSnapshot> {
    return await this.request(`${TASK_BOARD_API_PREFIX}/state`, { cache: 'no-store' })
  }

  async action(action: TaskBoardAction): Promise<TaskBoardSnapshot> {
    return await this.post(uuid(), action)
  }

  async archiveBatches(page: TaskBoardArchivePageQuery = {}): Promise<TaskBoardArchiveIndexPage> {
    return await this.request(`${TASK_BOARD_API_PREFIX}/archive${pagingQuery(page)}`, { cache: 'no-store' })
  }

  async archiveCards(batchId: string, page: TaskBoardArchivePageQuery = {}): Promise<TaskBoardArchiveCardsPage> {
    return await this.request(
      `${TASK_BOARD_API_PREFIX}/archive/${encodeURIComponent(batchId)}${pagingQuery(page)}`,
      { cache: 'no-store' },
    )
  }

  private async post(requestId: string, action: TaskBoardAction): Promise<TaskBoardSnapshot> {
    const envelope: TaskBoardActionEnvelope = { requestId, action }
    return await this.request(`${TASK_BOARD_API_PREFIX}/action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    })
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController()
    const timeout = globalThis.setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
    try {
      return await readJson<T>(await fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), [BOARD_SCOPE_HEADER]: LIVE_SCOPE },
        signal: controller.signal,
      }))
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`task-board Host request timed out after ${REQUEST_TIMEOUT_MS / 1_000}s`)
      throw error
    } finally {
      globalThis.clearTimeout(timeout)
    }
  }

  /**
   * Open the Host event channel (SSE).
   *
   * The demand policy lives with the caller: this transport only opens and
   * closes. The board controller subscribes while the panel is actually on
   * screen and releases the channel otherwise (see BoardController), so a
   * page that is not showing the board holds no SSE connection — one fewer
   * permanently occupied HTTP/1.1 slot per page.
   * @param listener - receives each pushed frame (or undefined on a bad frame).
   * @returns release that closes the EventSource.
   */
  subscribe(listener: (event?: TaskBoardEventPayload) => void): () => void {
    const events = new EventSource(`${TASK_BOARD_API_PREFIX}/events`)
    events.onmessage = (message: MessageEvent<string>): void => {
      try {
        const parsed = JSON.parse(message.data) as TaskBoardEventPayload
        if (parsed === null || typeof parsed !== 'object' || typeof parsed.revision !== 'number') throw new Error('invalid event frame')
        listener(parsed)
      } catch {
        listener()
      }
    }
    return () => { events.close() }
  }
}
